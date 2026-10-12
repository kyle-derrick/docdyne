// agentskills.go：编辑器 Agent 技能包（C2，pi packages 式）。
//
// 技能包 = 名称 + system 附加段 + 可选工具白名单 + 适用 applyKind 过滤。
// 平台级包存 settings ai.agent_packages（管理端 PUT /admin/settings/ai 的
// agent_packages 字段维护，校验同 personas 风格）；前端经 /ai/models 的
// agent_packages 读取（与内置包合并），编辑页 AI 面板下拉选择——选中后
// system 追加段注入 Agent 提示、工具集按白名单过滤。
package settings

import (
	"fmt"
	"strings"
)

// AIAgentPackageDef 一个技能包定义。
type AIAgentPackageDef struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	// SystemExtra 追加到 Agent system 提示（≤4000 字符）。
	SystemExtra string `json:"system_extra,omitempty"`
	// Tools 工具名白名单（空=不限制；含 read_* 等宿主工具与
	// deep_search/parallel_scan 元工具名）。
	Tools []string `json:"tools,omitempty"`
	// Kinds 限定适用 applyKind（text/excalidraw-json/drawio-xml/
	// richtext-patch；空=全部）。
	Kinds []string `json:"kinds,omitempty"`
}

// ValidateAIAgentPackages 校验技能包列表：≤50 条、id 1..64 唯一、
// name 1..64、SystemExtra ≤4000、Tools/Kinds 条目去空白非空。
func ValidateAIAgentPackages(list []AIAgentPackageDef) error {
	if len(list) > AIPlatformMaxEntries {
		return fmt.Errorf("%w: ai.agent_packages 最多 %d 条", ErrInvalidValue, AIPlatformMaxEntries)
	}
	seen := make(map[string]bool, len(list))
	for i, p := range list {
		id := strings.TrimSpace(p.ID)
		if id == "" || len([]rune(id)) > AIPlatformMaxIDRunes {
			return fmt.Errorf("%w: agent_packages[%d].id 须为 1..%d 个字符", ErrInvalidValue, i, AIPlatformMaxIDRunes)
		}
		if seen[id] {
			return fmt.Errorf("%w: agent_packages[%d].id %q 重复", ErrInvalidValue, i, id)
		}
		seen[id] = true
		if name := strings.TrimSpace(p.Name); name == "" || len([]rune(name)) > AIPlatformMaxNameRunes {
			return fmt.Errorf("%w: agent_packages[%d].name 须为 1..%d 个字符", ErrInvalidValue, i, AIPlatformMaxNameRunes)
		}
		if len([]rune(p.SystemExtra)) > AIPlatformMaxPromptRunes {
			return fmt.Errorf("%w: agent_packages[%d].system_extra 过长（≤%d 字符）", ErrInvalidValue, i, AIPlatformMaxPromptRunes)
		}
	}
	return nil
}
