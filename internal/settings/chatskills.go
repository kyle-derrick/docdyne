// chatskills.go：平台对话技能（ai.chat_skills）与平台 AI 规则（ai.rules）。
//
// 对话技能 = Cherry Studio 式 Skills：名称 + 描述 + 图标 + Markdown 指令
// 内容。区别于 ai.skills 快捷指令（prompt 填入输入框）：技能在对话中选用
// 后整段注入 system 提示，约束该轮对话的行为。平台级技能存 settings
// ai.chat_skills（管理端 /admin/settings/ai/chat-skills 整块读替，校验同
// personas 风格）；用户个人技能存 user_ai_prefs.prefs.chat_skills，HTTP 层
// 按 id 增量合并（个人覆盖平台）；编译期内置技能（builtin- 前缀）在
// HTTP 层并入、只读。
//
// ai.rules 平台规则为纯文本键（≤4000 字符）：追加注入所有对话的 system
// 提示（平台规则 + 用户个人规则叠加，非覆盖），管理端 /admin/settings/ai/
// rules 读写、非密钥明文回显。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/audit"
)

// AIChatSkillDef 一个对话技能条目（ai.chat_skills JSON 数组元素）。
type AIChatSkillDef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Icon 图标名（lucide 图标名；空/无效由前端兜底默认图标）。
	Icon string `json:"icon,omitempty"`
	// Content 技能指令内容（Markdown，选中后整段注入 system 提示）。
	Content string `json:"content"`
	// Enabled 控制技能对登录用户是否可见（false = 停用；管理端始终可见
	// 可编辑）。缺省视为启用，兼容旧数据。
	Enabled *bool `json:"enabled,omitempty"`
}

// chatSkillEnabled 判定技能是否启用（nil 视为启用，兼容旧数据）。
func chatSkillEnabled(s AIChatSkillDef) bool {
	return s.Enabled == nil || *s.Enabled
}

// ValidateAIChatSkills 校验对话技能列表：≤50 条、id 1..64 且唯一、
// name 1..64、description ≤200、icon ≤40、content 1..4000 字符。
func ValidateAIChatSkills(list []AIChatSkillDef) error {
	if len(list) > AIPlatformMaxEntries {
		return fmt.Errorf("%w: ai.chat_skills 最多 %d 条", ErrInvalidValue, AIPlatformMaxEntries)
	}
	seen := make(map[string]bool, len(list))
	for i, s := range list {
		if id := strings.TrimSpace(s.ID); id == "" || len([]rune(id)) > AIPlatformMaxIDRunes {
			return fmt.Errorf("%w: chat_skills[%d].id 须为 1..%d 个字符", ErrInvalidValue, i, AIPlatformMaxIDRunes)
		} else if seen[id] {
			return fmt.Errorf("%w: chat_skills[%d].id %q 重复", ErrInvalidValue, i, id)
		} else {
			seen[id] = true
		}
		if name := strings.TrimSpace(s.Name); name == "" || len([]rune(name)) > AIPlatformMaxNameRunes {
			return fmt.Errorf("%w: chat_skills[%d].name 须为 1..%d 个字符", ErrInvalidValue, i, AIPlatformMaxNameRunes)
		}
		if len([]rune(s.Description)) > AIChatSkillMaxDescRunes {
			return fmt.Errorf("%w: chat_skills[%d].description 过长（≤%d 字符）", ErrInvalidValue, i, AIChatSkillMaxDescRunes)
		}
		if len([]rune(s.Icon)) > AIChatSkillMaxIconRunes {
			return fmt.Errorf("%w: chat_skills[%d].icon 过长（≤%d 字符）", ErrInvalidValue, i, AIChatSkillMaxIconRunes)
		}
		if strings.TrimSpace(s.Content) == "" || len([]rune(s.Content)) > AIChatSkillMaxContentRunes {
			return fmt.Errorf("%w: chat_skills[%d].content 须为 1..%d 个字符", ErrInvalidValue, i, AIChatSkillMaxContentRunes)
		}
	}
	return nil
}

// AIChatSkills 读取平台对话技能（热读取；未入库或 JSON 损坏返回空数组）。
func (s *Store) AIChatSkills() ([]AIChatSkillDef, error) {
	list, err := readAIList[AIChatSkillDef](s, KeyAIChatSkills)
	if err != nil {
		return nil, err
	}
	return list, nil
}

// SetAIChatSkills 校验并整块写入平台对话技能（trim 规整 id/name/
// description/icon），成功后写 settings.update 审计；返回归一化后的列表。
func (s *Store) SetAIChatSkills(in []AIChatSkillDef, actor uuid.UUID) ([]AIChatSkillDef, error) {
	normalized := make([]AIChatSkillDef, 0, len(in))
	for _, sk := range in {
		item := AIChatSkillDef{
			ID:          strings.TrimSpace(sk.ID),
			Name:        strings.TrimSpace(sk.Name),
			Description: strings.TrimSpace(sk.Description),
			Icon:        strings.TrimSpace(sk.Icon),
			Content:     sk.Content,
			Enabled:     sk.Enabled,
		}
		if item.Enabled == nil {
			enabled := true
			item.Enabled = &enabled
		}
		normalized = append(normalized, item)
	}
	if err := ValidateAIChatSkills(normalized); err != nil {
		return nil, err
	}
	if err := s.writeAIListRow(KeyAIChatSkills, normalized, actor); err != nil {
		return nil, err
	}
	return normalized, nil
}

// AIRules 读取平台 AI 规则（热读取；未入库或 JSON 损坏返回空串——
// 容错默认，规则缺失不阻塞对话链路）。
func (s *Store) AIRules() (string, error) {
	row, err := s.repo.GetRow(KeyAIRules)
	if err != nil {
		if errors.Is(err, ErrNotSet) {
			return "", nil
		}
		return "", err
	}
	var v string
	if err := json.Unmarshal([]byte(row.ValueJSON), &v); err != nil {
		return "", nil // 损坏回退空（热读取容错，同 readAIList 语义）
	}
	return v, nil
}

// SetAIRules 写入平台 AI 规则（trim 规整、≤4000 字符；显式空串 = 清空），
// 成功后写 settings.update 审计（规则非密钥，明文入审计，同 personas）。
func (s *Store) SetAIRules(text string, actor uuid.UUID) (string, error) {
	text = strings.TrimSpace(text)
	if len([]rune(text)) > AIRulesMaxRunes {
		return "", fmt.Errorf("%w: ai.rules 过长（≤%d 字符）", ErrInvalidValue, AIRulesMaxRunes)
	}
	raw, err := json.Marshal(text)
	if err != nil {
		return "", err
	}
	if err := s.repo.UpsertRow(Setting{Key: KeyAIRules, ValueJSON: string(raw), ValueType: TypeString, Description: "AI runtime override", UpdatedBy: &actor, UpdatedAt: s.now().UTC()}); err != nil {
		return "", err
	}
	metadata, _ := json.Marshal(map[string]any{"key": KeyAIRules, "value": text})
	_ = s.audit.Record(audit.Entry{UserID: &actor, Action: audit.ActionSettingsUpdate, ResourceType: audit.ResourceSettings, ResourceID: KeyAIRules, Status: audit.StatusSuccess, Metadata: string(metadata)})
	return text, nil
}
