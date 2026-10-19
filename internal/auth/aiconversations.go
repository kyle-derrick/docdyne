// aiconversations.go：AI 会话记录（用户维度，ai_conversations 表，
// migration 053）。全局助手（file_id=NULL）与编辑页/Office 插件
// （file_id=对应文件）的对话会话统一服务端持久化——跨设备一致，替代
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
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID       uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	FileID       *uuid.UUID `gorm:"type:uuid" json:"file_id"`
	Source       string     `gorm:"size:16;not null" json:"source"`
	Title        string     `gorm:"not null" json:"title"`
	MessageCount int        `gorm:"not null" json:"message_count"`
	// Messages 为事件重放产物（GetAIConversation 填充；非数据库列）。
	Messages  json.RawMessage `gorm:"-" json:"messages"`
	CreatedAt time.Time       `gorm:"not null" json:"created_at"`
	UpdatedAt time.Time       `gorm:"not null" json:"updated_at"`
}

// AIConvoEvent 对应 ai_conversation_events 一行（append-only）。
// kind: turn=追加回合（payload 为消息数组，按序拼接）；snapshot=全量快照
// （payload 为完整消息数组，重放时替换此前状态——删除/导入等重排操作经
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

// AIConvoMsg 对应 ai_conversation_msgs 一行（migration 057，v7.15 A6）：
// 事件写入时同步维护的消息检索索引（dd_search_history 的数据源，覆盖
// assistant/editor/plugin 全部 source 的跨会话与被压缩早期内容）。derived
// data——会话删除经 FK CASCADE 同步清理，重放语义与事件表一致（turn 追加
// 行 / snapshot 重建），索引失败不阻塞会话保存（见 AppendAIConvoEvent）。
type AIConvoMsg struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	ConversationID uuid.UUID `gorm:"type:uuid;not null;index" json:"conversation_id"`
	UserID         uuid.UUID `gorm:"type:uuid;not null;index" json:"-"`
	Seq            int64     `gorm:"not null" json:"seq"`
	Role           string    `gorm:"size:16;not null" json:"role"`
	Content        string    `gorm:"not null" json:"content"`
	CreatedAt      time.Time `gorm:"not null" json:"created_at"`
}

// AIConvoMsgMaxRunes 单行索引内容上限（rune 计）：检索只需命中与片段，
// 超长消息（TOOL_RESULT/代码块）截断入库，控制表体量。
const AIConvoMsgMaxRunes = 8000

// TableName 显式映射到 ai_conversation_msgs。
func (AIConvoMsg) TableName() string { return "ai_conversation_msgs" }

// AIConvoMsgHit 为 SearchAIConversationMsgs 的命中条目（附会话元信息，
// 供工具结果直接展示「哪个会话里的什么消息」）。
type AIConvoMsgHit struct {
	ConversationID uuid.UUID `json:"conversation_id"`
	Title          string    `json:"title"`
	Source         string    `json:"source"`
	Role           string    `json:"role"`
	Fragment       string    `json:"fragment"`
	CreatedAt      time.Time `json:"created_at"`
}

// TableName 显式映射到 ai_conversations。
func (AIConversation) TableName() string { return "ai_conversations" }

// AIConversationMeta 列表条目（不带 messages 正文）。
type AIConversationMeta struct {
	ID           uuid.UUID  `json:"id"`
	FileID       *uuid.UUID `json:"file_id"`
	Source       string     `json:"source"`
	Title        string     `json:"title"`
	MessageCount int        `json:"message_count"`
	UpdatedAt    time.Time  `json:"updated_at"`
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
		ID:           uuid.Must(uuid.NewV7()),
		UserID:       userID,
		FileID:       fileID,
		Source:       source,
		Title:        strings.TrimSpace(title),
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
// （对 snapshot 的完整数组校验；turn 校验本段增量）。
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
	// v7.15 A6：同步维护消息检索索引（turn 追加行 / snapshot 重建，重放
	// 语义与事件表一致）。best-effort——索引是 derived data，失败不阻塞
	// 会话保存（下次 snapshot 全量重建自愈），与 trimAIConversations 同口径。
	_ = s.syncConvoMsgIndex(id, row.UserID, kind, items, count)
	return true, nil
}

// syncConvoMsgIndex 维护 ai_conversation_msgs（AppendAIConvoEvent 内调用）：
// turn 按 items 增量追加（seq 接续会话内现行 message_count 起算）；snapshot
// 全量重建（先删后插——删除/导入等重排后索引与重放结果保持一致）。只索引
// 带 role/content 字符串的条目（前端消息形态），内容截 AIConvoMsgMaxRunes。
func (s *UserStore) syncConvoMsgIndex(convoID, userID uuid.UUID, kind string, items []json.RawMessage, nextCount int) error {
	if kind == "snapshot" {
		if err := s.db.Where("conversation_id = ?", convoID).Delete(&AIConvoMsg{}).Error; err != nil {
			return err
		}
	}
	if len(items) == 0 {
		return nil
	}
	base := int64(nextCount) - int64(len(items))
	if kind == "snapshot" {
		base = 0
	}
	rows := make([]AIConvoMsg, 0, len(items))
	for i, raw := range items {
		var msg struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		}
		if json.Unmarshal(raw, &msg) != nil || msg.Role == "" || msg.Content == "" {
			continue
		}
		content := []rune(msg.Content)
		if len(content) > AIConvoMsgMaxRunes {
			content = content[:AIConvoMsgMaxRunes]
		}
		rows = append(rows, AIConvoMsg{
			ID: uuid.Must(uuid.NewV7()), ConversationID: convoID, UserID: userID,
			Seq: base + int64(i), Role: msg.Role, Content: string(content),
			CreatedAt: time.Now(),
		})
	}
	if len(rows) == 0 {
		return nil
	}
	return s.db.Create(&rows).Error
}

// ListAIConvoMsgsBatch 分批列举消息行（管理端会话向量重建用，跨用户）：
// 按 (conversation_id, seq) 稳定排序 + offset 分页，返回本批行；不足 limit
// 条即末批。供 POST /admin/settings/ai/history/reindex 全量重嵌入。
func (s *UserStore) ListAIConvoMsgsBatch(offset, limit int) ([]AIConvoMsg, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	var rows []AIConvoMsg
	err := s.db.Order("conversation_id, seq").Offset(offset).Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ConvoTitleMap 批量取会话标题（重建索引的 payload 用；缺行返回空标题）。
func (s *UserStore) ConvoTitleMap(ids []uuid.UUID) (map[uuid.UUID]string, error) {
	out := make(map[uuid.UUID]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ID    uuid.UUID
		Title string
	}
	if err := s.db.Table("ai_conversations").Select("id, title").Where("id IN ?", ids).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r.Title
	}
	return out, nil
}

// SearchAIConversationMsgs 跨会话检索消息行（dd_search_history 数据源，
// v7.15 A6）：本人维度 + ILIKE 子串匹配（content 上的 pg_trgm GIN 加速），
// created_at 倒序取 limit 条，片段以 pattern 首次命中位置为中心截取。
// pattern 中的 %/_ 按字面匹配（转义）；空 pattern 返回空。
func (s *UserStore) SearchAIConversationMsgs(userID uuid.UUID, pattern string, limit int) ([]AIConvoMsgHit, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" || limit <= 0 {
		return []AIConvoMsgHit{}, nil
	}
	if limit > 50 {
		limit = 50
	}
	like := "%" + escapeLikePattern(pattern) + "%"
	var rows []struct {
		ConversationID uuid.UUID
		Title          string
		Source         string
		Role           string
		Content        string
		CreatedAt      time.Time
	}
	err := s.db.Raw(`
		SELECT m.conversation_id, c.title, c.source, m.role, m.content, m.created_at
		FROM ai_conversation_msgs m
		JOIN ai_conversations c ON c.id = m.conversation_id
		WHERE m.user_id = ? AND m.content ILIKE ?
		ORDER BY m.created_at DESC
		LIMIT ?`, userID, like, limit).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]AIConvoMsgHit, 0, len(rows))
	for _, r := range rows {
		out = append(out, AIConvoMsgHit{
			ConversationID: r.ConversationID, Title: r.Title, Source: r.Source,
			Role: r.Role, Fragment: fragmentAround(r.Content, pattern), CreatedAt: r.CreatedAt,
		})
	}
	return out, nil
}

// escapeLikePattern 转义 ILIKE 通配符（%/_/转义符本身按字面匹配）。
func escapeLikePattern(p string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(p)
}

// fragmentAround 截取 pattern 首次命中位置附近的片段（大小写不敏感定位，
// 宽度约 160 字符；未命中返回头部）。
func fragmentAround(content, pattern string) string {
	const width = 160
	lower, lowQ := strings.ToLower(content), strings.ToLower(pattern)
	idx := strings.Index(lower, lowQ)
	if idx < 0 {
		if len(content) > width {
			return content[:width] + "…"
		}
		return content
	}
	start := idx - width/3
	if start < 0 {
		start = 0
	}
	end := idx + len(pattern) + width*2/3
	if end > len(content) {
		end = len(content)
	}
	frag := content[start:end]
	if start > 0 {
		frag = "…" + frag
	}
	if end < len(content) {
		frag += "…"
	}
	return frag
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
