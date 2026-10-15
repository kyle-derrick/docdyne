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
	"time"
)

// AIAgentPackageDef 一个技能包定义。
type AIAgentPackageDef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// SystemExtra 追加到 Agent system 提示（≤4000 字符）。
	SystemExtra string `json:"system_extra,omitempty"`
	// Tools 工具名白名单（空=不限制；含 read_* 等宿主工具与
	// deep_search/parallel_scan 元工具名）。
	Tools []string `json:"tools,omitempty"`
	// Kinds 限定适用 applyKind（text/excalidraw-json/drawio-xml/
	// richtext-patch；空=全部）。
	Kinds []string `json:"kinds,omitempty"`
	// Version 版本号（I1）：0 = 未版本化（旧数据），展示按 1 处理；
	// 管理端每次实质修改递增，供使用方感知包演进。
	Version int `json:"version,omitempty"`
	// Changelog 变更日志（I1，新在前不强制）：与 Version 配套的人工记录。
	Changelog []AIPackageChangelogEntry `json:"changelog,omitempty"`
}

// AIPackageChangelogEntry 一条技能包变更记录（I1）。
type AIPackageChangelogEntry struct {
	Version int `json:"version"`
	// Date 变更日期（YYYY-MM-DD，可空）。
	Date string `json:"date,omitempty"`
	Note string `json:"note"`
}

// AIPackageChangelogMaxEntries 变更日志条数上限。
const AIPackageChangelogMaxEntries = 50

// AIPackageChangelogMaxNoteRunes 单条变更说明长度上限。
const AIPackageChangelogMaxNoteRunes = 500

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
		if p.Version < 0 {
			return fmt.Errorf("%w: agent_packages[%d].version 须 ≥0", ErrInvalidValue, i)
		}
		if len(p.Changelog) > AIPackageChangelogMaxEntries {
			return fmt.Errorf("%w: agent_packages[%d].changelog 过多（≤%d 条）", ErrInvalidValue, i, AIPackageChangelogMaxEntries)
		}
		for j, e := range p.Changelog {
			if strings.TrimSpace(e.Note) == "" {
				return fmt.Errorf("%w: agent_packages[%d].changelog[%d].note 不能为空", ErrInvalidValue, i, j)
			}
			if len([]rune(e.Note)) > AIPackageChangelogMaxNoteRunes {
				return fmt.Errorf("%w: agent_packages[%d].changelog[%d].note 过长（≤%d 字符）", ErrInvalidValue, i, j, AIPackageChangelogMaxNoteRunes)
			}
			if e.Date != "" && !isValidChangelogDate(e.Date) {
				return fmt.Errorf("%w: agent_packages[%d].changelog[%d].date 须为 YYYY-MM-DD", ErrInvalidValue, i, j)
			}
		}
	}
	return nil
}

// isValidChangelogDate 校验 YYYY-MM-DD（含真实日历校验）。
func isValidChangelogDate(s string) bool {
	t, err := time.Parse("2006-01-02", s)
	return err == nil && t.Format("2006-01-02") == s
}
