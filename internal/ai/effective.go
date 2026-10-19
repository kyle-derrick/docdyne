// effective.go：双层配置的合并/生效解析（增量型按 id 用户覆盖平台、
// 覆盖型用户空值回落平台）+ 编译期内置内容（默认人设 / 对话技能包）。
//
// 语义矩阵（与前端「平台/个人覆盖」徽标共用 source 取值）：
//   - 增量型（Providers/快捷指令/MCP/对话技能）：平台全集 + 个人全集按
//     id 合并，个人条目覆盖平台同 id 条目（位置保持首次出现处）；
//   - 覆盖型（历史检索模式/默认人设/温度/OCR/联网搜索默认态）：用户
//     override 非空即覆盖，空 = 跟随平台（ResolveXxx 系列）；
//   - 规则：叠加型——平台规则与用户规则分段拼接，互不覆盖。
package ai

import (
	"strings"

	"github.com/kyle-derrick/docdyne/internal/auth"
	"github.com/kyle-derrick/docdyne/internal/settings"
)

// 生效来源取值（前端徽标）。
const (
	SourceBuiltin  = "builtin"
	SourcePlatform = "platform"
	SourceUser     = "user"
)

// ---------- 对话技能（增量合并） ----------

// EffectiveChatSkill 合并后的对话技能条目（settings.AIChatSkillDef 字段
// 提升 + Source 标注来源）。
type EffectiveChatSkill struct {
	settings.AIChatSkillDef
	// Source 条目来源：builtin（编译期内置，只读）/ platform（平台配置）/
	// user（个人配置，覆盖平台同 id）。
	Source string `json:"source"`
}

// MergeChatSkills 合并三层对话技能：内置 → 平台 → 个人（按 id 后者覆盖
// 前者，条目保持首次出现的位置；平台停用项剔除；个人条目恒启用）。
func MergeChatSkills(builtin, platform []settings.AIChatSkillDef, personal []auth.AIPersonalChatSkill) []EffectiveChatSkill {
	type slot struct {
		entry EffectiveChatSkill
	}
	order := make([]*slot, 0, len(builtin)+len(platform)+len(personal))
	byID := make(map[string]*slot, cap(order))
	add := func(id string, e EffectiveChatSkill) {
		if s, ok := byID[id]; ok {
			s.entry = e // 覆盖值，保持原位置
			return
		}
		s := &slot{entry: e}
		byID[id] = s
		order = append(order, s)
	}
	for _, s := range builtin {
		add(s.ID, EffectiveChatSkill{AIChatSkillDef: s, Source: SourceBuiltin})
	}
	for _, s := range platform {
		if s.Enabled != nil && !*s.Enabled {
			continue // 平台停用项对用户不可见
		}
		add(s.ID, EffectiveChatSkill{AIChatSkillDef: s, Source: SourcePlatform})
	}
	for _, s := range personal {
		enabled := true
		add(s.ID, EffectiveChatSkill{AIChatSkillDef: settings.AIChatSkillDef{
			ID: s.ID, Name: s.Name, Description: s.Description, Icon: s.Icon, Content: s.Content, Enabled: &enabled,
		}, Source: SourceUser})
	}
	out := make([]EffectiveChatSkill, 0, len(order))
	for _, s := range order {
		out = append(out, s.entry)
	}
	return out
}

// ---------- 规则（叠加拼接） ----------

// EffectiveRules 拼接平台规则与用户个人规则（叠加型，非覆盖）：任一为空
// 跳过该段；两者皆空返回空串（不注入）。
func EffectiveRules(platform, user string) string {
	platform, user = strings.TrimSpace(platform), strings.TrimSpace(user)
	switch {
	case platform == "" && user == "":
		return ""
	case user == "":
		return "【平台规则】以下规则对本次对话始终生效：\n" + platform
	case platform == "":
		return "【用户个人规则】用户设定的以下规则对本次对话始终生效：\n" + user
	default:
		return "【平台规则】以下规则对本次对话始终生效：\n" + platform +
			"\n\n【用户个人规则】用户设定的以下规则同样生效：\n" + user
	}
}

// ---------- 覆盖型解析（用户空值回落平台） ----------

// HistorySearchMode 合法取值。
const (
	HistorySearchKeyword = "keyword"
	HistorySearchVector  = "vector"
	HistorySearchOff     = "off"
)

// ResolveHistorySearchMode 解析生效的历史检索模式：用户覆盖（合法值）
// → 平台值 → 默认 keyword。用户/平台非法值按未设置处理（容错：运行时
// 不因脏数据报错）。
func ResolveHistorySearchMode(platform string, user *string) string {
	if user != nil {
		switch v := strings.TrimSpace(*user); v {
		case HistorySearchKeyword, HistorySearchVector, HistorySearchOff:
			return v
		}
	}
	switch strings.TrimSpace(platform) {
	case HistorySearchKeyword, HistorySearchVector, HistorySearchOff:
		return strings.TrimSpace(platform)
	}
	return HistorySearchKeyword
}

// ResolveDefaultPersona 解析生效的默认人设 id（用户覆盖 → 平台 → 空=不注入）。
func ResolveDefaultPersona(platform *string, user *string) string {
	if user != nil {
		return strings.TrimSpace(*user)
	}
	if platform != nil {
		return strings.TrimSpace(*platform)
	}
	return ""
}

// ---------- 编译期内置内容 ----------

// BuiltinPersonaID 内置默认人设 id（default_persona 合法引用；前端下拉
// 置顶只读）。
const BuiltinPersonaID = "builtin-assistant"

// BuiltinPersona 编译期默认人设：保证生效人设列表非空（平台未配置任何
// 人设时前端仍有默认可选项）。
func BuiltinPersona() settings.AIPersonaDef {
	return settings.AIPersonaDef{
		ID:   BuiltinPersonaID,
		Name: "默认助理",
		SystemPrompt: "你是 DocDyne 平台的 AI 助理。回答使用中文，结构清晰、结论先行；" +
			"涉及用户文件操作时先确认目标再执行；不确定的内容明确说明，不编造事实；" +
			"引用平台文件或网页内容时注明来源。",
	}
}

// BuiltinChatSkills 编译期内置对话技能（builtin- 前缀；与平台/个人技能
// 按 id 增量合并，个人可覆盖）。
func BuiltinChatSkills() []settings.AIChatSkillDef {
	enabled := true
	return []settings.AIChatSkillDef{
		{
			ID: "builtin-translate", Name: "翻译", Icon: "languages", Enabled: &enabled,
			Description: "中英互译，保留结构与术语",
			Content: "你是资深翻译。将用户输入在中文与英文之间互译（输入为英文则译为中文，否则译为英文）。\n" +
				"要求：\n- 保留原文的 Markdown 结构、代码块、表格与列表层级；\n" +
				"- 人名、产品名、品牌名等专有名词保留原文（首次出现可括注）；\n" +
				"- 术语保持一致（同一术语全文统一译法）；\n- 只输出译文，不添加解释。",
		},
		{
			ID: "builtin-polish", Name: "润色", Icon: "wand-sparkles", Enabled: &enabled,
			Description: "提升文字流畅度与书面感",
			Content: "你是文字润色专家。对用户输入做润色：保持原意与篇幅量级，提升流畅度与书面感，修正错别字与标点。\n" +
				"要求：\n- 不改变事实、数据与作者立场；\n- 保留原有段落结构（除非明显混乱）；\n" +
				"- 输出润色后的全文，末尾以「修改说明：」列出最多 3 条主要改动。",
		},
		{
			ID: "builtin-summarize", Name: "总结", Icon: "list-checks", Enabled: &enabled,
			Description: "一句话结论 + 要点 + 行动项",
			Content: "你是总结专家。对用户输入（文本/长文/会议记录等）输出结构化总结：\n" +
				"1. 一句话结论（≤50 字）；\n2. 要点列表（≤7 条，每条一句话，保留关键数字的精确值）；\n" +
				"3. 行动项（若有：谁/做什么/何时）。\n不引入原文之外的信息；原文无行动项则省略该节。",
		},
		{
			ID: "builtin-brainstorm", Name: "头脑风暴", Icon: "lightbulb", Enabled: &enabled,
			Description: "多方向发散 + 两轴打分",
			Content: "你是头脑风暴教练。围绕用户给定的主题产出 8-10 个方向，覆盖不同角度（避免同质化）。\n" +
				"每个方向：一句话描述 + 可行性(1-5) 与价值(1-5) 打分及一句理由。\n" +
				"末尾标注 Top3（按两轴之和），并说明推荐理由。",
		},
	}
}
