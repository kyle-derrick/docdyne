// aiconversations.go：AI 会话记录（用户维度，ai_conversations 表，
// migration 053）。全局助手（file_id=NULL）与编辑页/Office 插件
//（file_id=对应文件）的对话会话统一服务端持久化——跨设备一致，替代
// 此前的 localStorage 本机存储（前端首载时自动迁移本机历史）。
//
// messages 为整段 JSON 数组（前端回合结构直存；无跨会话查询需求，不拆
// 消息表）。条数上限：每 (user, file_id, source) 保留最近 30 个会话，
// 写入时裁最旧；单会话 messages ≤64 条、原始 JSON ≤256KB、title ≤120
// 字符，由本层校验。存储方法挂在 UserStore（模式同 aimemory.go）。
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ai_conversations.source 取值。
const (
	AIConvoSourceAssistant = "assistant"
	AIConvoSourceEditor    = "editor"
	AIConvoSourcePlugin    = "plugin"
)

// 上限常量（校验 + 裁剪）。
const (
	AIConvoMaxTitleRunes   = 120
	AIConvoMaxMessages     = 64
	AIConvoMaxMessageBytes = 256 << 10 // 256KB（整段 messages JSON）
	// AIConvoKeepPerScope 每 (user, file_id, source) 保留最近 N 个会话
	//（写入时裁最旧）。v7.2 起服务端存储，配额从 localStorage 时代的 30
	// 提到 300——不设上限会有 DB 无界增长风险，300 覆盖重度使用且元信息
	// 列表载荷极小（约 150B/条）。
	AIConvoKeepPerScope = 300
)

// ErrInvalidAIConversation 表示会话载荷非法（HTTP 400 语义）。
var ErrInvalidAIConversation = errors.New("invalid ai conversation")

// AIConversation 对应 ai_conversations 表一行（正文在事件表，读取时重放）。
type AIConversation struct {
	ID           uuid.UUID    `gorm:"type:uuid;primaryKey" json:"id"`
	UserID       uuid.UUID    `gorm:"type:uuid;not null;index" json:"-"`
	FileID       *uuid.UUID   `gorm:"type:uuid" json:"file_id"`
	Source       string       `gorm:"size:16;not null" json:"source"`
	Title        string       `gorm:"not null" json:"title"`
	MessageCount int          `gorm:"not null" json:"message_count"`
	// Messages 为事件重放产物（GetAIConversation 填充；非数据库列）。
	Messages  json.RawMessage `gorm:"-" json:"messages"`
	CreatedAt time.Time       `gorm:"not null" json:"created_at"`
	UpdatedAt time.Time       `gorm:"not null" json:"updated_at"`
}

// AIConvoEvent 对应 ai_conversation_events 一行（append-only）。
// kind: turn=追加回合（payload 为消息数组，按序拼接）；snapshot=全量快照
//（payload 为完整消息数组，重放时替换此前状态——删除/导入等重排操作经
// 快照表达，日志本身只追加）。会话行维护 title/updated_at/message_count。
type AIConvoEvent struct {
	ID             uuid.UUID       `gorm:"type:uuid;primaryKey" json:"id"`
	ConversationID uuid.UUID       `gorm:"type:uuid;not null;index" json:"conversation_id"`
	Seq            int64           `gorm:"not null" json:"seq"`
	Kind           string          `gorm:"size:16;not null" json:"kind"`
	Payload        json.RawMessage `gorm:"type:jsonb;not null" json:"payload"`
	CreatedAt      time.Time       `gorm:"not null" json:"created_at"`
}

// TableName 显式映射到 ai_conversation_events。
func (AIConvoEvent) TableName() string { return "ai_conversation_events" }

// TableName 显式映射到 ai_conversations。
func (AIConversation) TableName() string { return "ai_conversations" }

// AIConversationMeta 列表条目（不带 messages 正文）。
type AIConversationMeta struct {
	ID           uuid.UUID `json:"id"`
	FileID       *uuid.UUID `json:"file_id"`
	Source       string    `json:"source"`
	Title        string    `json:"title"`
	MessageCount int       `json:"message_count"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// ValidateAIConvoSource 校验 source 取值。
func ValidateAIConvoSource(source string) error {
	switch source {
	case AIConvoSourceAssistant, AIConvoSourceEditor, AIConvoSourcePlugin:
		return nil
	default:
		return fmt.Errorf("%w: source 须为 assistant|editor|plugin", ErrInvalidAIConversation)
	}
}

// ValidateAIConvoTitle 校验标题（可空；≤120 字符）。
func ValidateAIConvoTitle(title string) error {
	if len([]rune(title)) > AIConvoMaxTitleRunes {
		return fmt.Errorf("%w: title 过长（≤%d 字符）", ErrInvalidAIConversation, AIConvoMaxTitleRunes)
	}
	return nil
}

// ValidateAIConvoMessages 校验 messages：合法 JSON 数组、≤64 条、整段
// ≤256KB。数组元素结构由前端定义（回合对象），服务端不逐条解释。
func ValidateAIConvoMessages(raw json.RawMessage) error {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return fmt.Errorf("%w: messages 须为 JSON 数组", ErrInvalidAIConversation)
	}
	if len(arr) > AIConvoMaxMessages {
		return fmt.Errorf("%w: messages 过多（≤%d 条）", ErrInvalidAIConversation, AIConvoMaxMessages)
	}
	if len(raw) > AIConvoMaxMessageBytes {
		return fmt.Errorf("%w: messages 过大（≤%dKB）", ErrInvalidAIConversation, AIConvoMaxMessageBytes>>10)
	}
	return nil
}

// trimAIConversations 裁剪 scope 内最旧的会话（保留最近 keep 个）。
func (s *UserStore) trimAIConversations(userID uuid.UUID, fileID *uuid.UUID, source string, keep int) error {
	scope := s.db.Where("user_id = ? AND source = ?", userID, source)
	if fileID != nil {
		scope = scope.Where("file_id = ?", *fileID)
	} else {
		scope = scope.Where("file_id IS NULL")
	}
	var stale []uuid.UUID
	if err := scope.Order("updated_at DESC").Offset(keep).
		Pluck("id", &stale).Error; err != nil {
		return err
	}
	if len(stale) == 0 {
		return nil
	}
	return s.db.Where("id IN ?", stale).Delete(&AIConversation{}).Error
}

// ListAIConversations 返回 scope 内最近会话（updated_at 倒序；limit 截断
// 0..AIConvoKeepPerScope，缺省 30）。列表不带 messages 正文。
func (s *UserStore) ListAIConversations(userID uuid.UUID, fileID *uuid.UUID, source string, limit int) ([]AIConversationMeta, error) {
	if err := ValidateAIConvoSource(source); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > AIConvoKeepPerScope {
		limit = AIConvoKeepPerScope
	}
	scope := s.db.Where("user_id = ? AND source = ?", userID, source)
	if fileID != nil {
		scope = scope.Where("file_id = ?", *fileID)
	} else {
		scope = scope.Where("file_id IS NULL")
	}
	var rows []AIConversation
	if err := scope.Order("updated_at DESC").Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]AIConversationMeta, 0, len(rows))
	for _, r := range rows {
		out = append(out, AIConversationMeta{
			ID: r.ID, FileID: r.FileID, Source: r.Source,
			Title: r.Title, MessageCount: r.MessageCount, UpdatedAt: r.UpdatedAt,
		})
	}
	return out, nil
}

// CreateAIConversation 新建空会话（title 可空）并裁剪超限旧会话。
func (s *UserStore) CreateAIConversation(userID uuid.UUID, fileID *uuid.UUID, source, title string) (AIConversation, error) {
	if err := ValidateAIConvoSource(source); err != nil {
		return AIConversation{}, err
	}
	if err := ValidateAIConvoTitle(title); err != nil {
		return AIConversation{}, err
	}
	row := AIConversation{
		ID:       uuid.Must(uuid.NewV7()),
		UserID:   userID,
		FileID:   fileID,
		Source:   source,
		Title:    strings.TrimSpace(title),
		MessageCount: 0,
	}
	if err := s.db.Create(&row).Error; err != nil {
		return AIConversation{}, err
	}
	if err := s.trimAIConversations(userID, fileID, source, AIConvoKeepPerScope); err != nil {
		// 裁剪失败不影响创建结果（下次写入重试）。
		_ = err
	}
	return row, nil
}

// GetAIConversation 取单个会话并重放事件生成 Messages（本人维度）。
func (s *UserStore) GetAIConversation(userID, id uuid.UUID) (AIConversation, bool, error) {
	var row AIConversation
	err := s.db.Where("id = ? AND user_id = ?", id, userID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return AIConversation{}, false, nil
	}
	if err != nil {
		return AIConversation{}, false, err
	}
	msgs, err := s.replayAIConvo(id)
	if err != nil {
		return AIConversation{}, false, err
	}
	row.Messages = msgs
	return row, true, nil
}

// replayAIConvo 按 seq 重放事件：turn 追加 payload 数组、snapshot 替换。
func (s *UserStore) replayAIConvo(id uuid.UUID) (json.RawMessage, error) {
	var events []AIConvoEvent
	if err := s.db.Where("conversation_id = ?", id).Order("seq ASC").Find(&events).Error; err != nil {
		return nil, err
	}
	acc := []json.RawMessage{}
	for _, ev := range events {
		var items []json.RawMessage
		if json.Unmarshal(ev.Payload, &items) != nil {
			continue
		}
		if ev.Kind == "snapshot" {
			acc = items
		} else {
			acc = append(acc, items...)
		}
	}
	out, err := json.Marshal(acc)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// AppendAIConvoEvent 追加事件（turn=追加 payload 消息 / snapshot=全量替换）
// 并维护会话行 message_count 与 updated_at。校验沿用 ValidateAIConvoMessages
//（对 snapshot 的完整数组校验；turn 校验本段增量）。
func (s *UserStore) AppendAIConvoEvent(userID, id uuid.UUID, kind string, payload json.RawMessage) (bool, error) {
	if kind != "turn" && kind != "snapshot" {
		return false, fmt.Errorf("%w: kind 须为 turn|snapshot", ErrInvalidAIConversation)
	}
	if err := ValidateAIConvoMessages(payload); err != nil {
		return false, err
	}
	var row AIConversation
	if err := s.db.Where("id = ? AND user_id = ?", id, userID).First(&row).Error; err != nil {
		return false, err
	}
	var items []json.RawMessage
	if err := json.Unmarshal(payload, &items); err != nil {
		return false, fmt.Errorf("%w: payload 须为 JSON 数组", ErrInvalidAIConversation)
	}
	var maxSeq int64
	if err := s.db.Model(&AIConvoEvent{}).Where("conversation_id = ?", id).
		Select("COALESCE(MAX(seq), 0)").Scan(&maxSeq).Error; err != nil {
		return false, err
	}
	ev := AIConvoEvent{
		ID: uuid.Must(uuid.NewV7()), ConversationID: id, Seq: maxSeq + 1,
		Kind: kind, Payload: payload,
	}
	if err := s.db.Create(&ev).Error; err != nil {
		return false, err
	}
	count := row.MessageCount
	if kind == "snapshot" {
		count = len(items)
	} else {
		count += len(items)
	}
	if err := s.db.Model(&AIConversation{}).Where("id = ?", id).Updates(map[string]any{
		"message_count": count, "updated_at": time.Now(),
	}).Error; err != nil {
		return false, err
	}
	return true, nil
}

// UpdateAIConversation 更新标题（本人维度；内容写走 AppendAIConvoEvent，
// messages 参数保留签名兼容但已停用）。
func (s *UserStore) UpdateAIConversation(userID, id uuid.UUID, title *string, _ json.RawMessage) (bool, error) {
	patch := map[string]any{"updated_at": time.Now()}
	if title != nil {
		if err := ValidateAIConvoTitle(*title); err != nil {
			return false, err
		}
		patch["title"] = strings.TrimSpace(*title)
	}
	res := s.db.Model(&AIConversation{}).
		Where("id = ? AND user_id = ?", id, userID).Updates(patch)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// DeleteAIConversation 删除会话（本人维度；返回是否删除）。
func (s *UserStore) DeleteAIConversation(userID, id uuid.UUID) (bool, error) {
	res := s.db.Where("id = ? AND user_id = ?", id, userID).Delete(&AIConversation{})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}
