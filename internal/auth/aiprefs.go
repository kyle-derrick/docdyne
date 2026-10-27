// aiprefs.go：用户个人 AI 配置（user_ai_prefs，migration 049，双轨制：
// 个人自备 Provider + 平台 Provider）。
//
// prefs 为整块 JSON（providers/default_models/personas/prefer_personal），
// 结构校验与密钥掩码在本文件完成；存储接口挂在 UserStore（模式同
// openwith.go 的 user_open_with）。api_key 语义同平台 Provider 与 SMTP
// 密码：入库明文供运行时直连使用，但只在 PUT 请求携带（空 = 保持现值，
// 合并在 HTTP 层完成），任何读路径均以掩码视图回显（api_key_configured），
// 绝不返回明文。
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kyle-derrick/docdyne/internal/settings"
)

// 个人 Provider 类型（AIPersonalProvider.Kind 取值）：与平台一致的
// openai_compatible / anthropic 两种真实协议；不支持 mock（个人池无演示
// Provider 语义，避免绕过真实链路校验）。
const (
	AIPersonalKindOpenAICompatible = settings.AIKindOpenAICompatible
	AIPersonalKindAnthropic        = settings.AIKindAnthropic
)

// 个人结构上限（校验边界）。
const (
	AIPersonalMaxProviders   = 8
	AIPersonalMaxModels      = 20
	AIPersonalMaxPersonas    = 20
	AIPersonalMaxPromptRunes = 4000
	// AIPersonalMaxSkills 个人技能/快捷指令模板条数上限（与平台 ai.skills 一致）。
	AIPersonalMaxSkills = 50
	// AIPersonalMaxSkillDescRunes 个人技能 description 长度上限。
	AIPersonalMaxSkillDescRunes = 200
	// AIPersonalMaxMCPServers 个人 MCP 服务条数上限（与平台 ai.mcp 一致）。
	AIPersonalMaxMCPServers = 8
	// AIPersonalMaxMCPHeaders 单个个人 MCP 服务的认证头条数上限。
	AIPersonalMaxMCPHeaders = 8
	// AIPersonalMaxMCPHeaderKeyRunes 认证头键（header 名）长度上限。
	AIPersonalMaxMCPHeaderKeyRunes = 64
	// AIPersonalMaxMCPHeaderValueRunes 认证头值长度上限（与平台
	// auth_header 上限一致）。
	AIPersonalMaxMCPHeaderValueRunes = 1000
	// AIPersonalMaxMCPURLRunes 个人 MCP 服务 url 长度上限（同平台）。
	AIPersonalMaxMCPURLRunes = 500
	// AIPersonalMaxChatSkills 个人对话技能条数上限（低于平台 50：个人池
	// 够用且防滥用）。
	AIPersonalMaxChatSkills = 30
	// AIPersonalMaxRulesRunes 个人 AI 规则长度上限（低于平台 4000）。
	AIPersonalMaxRulesRunes = 2000
)

// ErrInvalidAIPrefs 表示个人 AI 配置非法（HTTP 400 语义；错误消息含具体
// 字段定位，供前端逐项提示）。
var ErrInvalidAIPrefs = errors.New("invalid personal ai settings")

// AIPersonalModel 为个人 Provider 下的一个模型条目（capabilities 与平台
// 同构，含 reasoning）。
type AIPersonalModel struct {
	ID           string                       `json:"id"`
	Label        string                       `json:"label,omitempty"`
	Capabilities settings.AIModelCapabilities `json:"capabilities"`
}

// AIPersonalProvider 为用户自备的 AI 服务提供方条目。APIKey 仅在 PUT
// 请求中携带（空 = 保持现值不覆盖）；读路径永不回显明文（掩码视图仅报
// api_key_configured）。
type AIPersonalProvider struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Kind    string            `json:"kind"`
	BaseURL string            `json:"base_url"`
	APIKey  string            `json:"api_key,omitempty"`
	Models  []AIPersonalModel `json:"models"`
}

// AIPersonalModelRef 为个人场景默认模型引用（default_models 的值；
// provider_id/model_id 须指向个人池）。
type AIPersonalModelRef struct {
	ProviderID string `json:"provider_id"`
	ModelID    string `json:"model_id"`
}

// AIPersonalPersona 为用户自定义 AI 人设（system 提示模板）。
type AIPersonalPersona struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	SystemPrompt string `json:"system_prompt"`
}

// AIPersonalSkill 为用户自定义技能/快捷指令模板：prompt 支持占位符
// {selection}（编辑器选区）/ {file}（当前文件名），由前端在填入输入框时
// 替换（语义同平台 ai.skills）。技能不注入 system 提示——对话入口的
// 「技能」弹层合并展示平台+个人技能，选中即把 prompt 填入输入框。
type AIPersonalSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Prompt      string `json:"prompt"`
}

// AIPersonalMCPServer 为用户自备的外部 MCP 服务器条目（语义同平台
// ai.mcp，仅本人维度）：对话开启 use_mcp 时与平台服务合并加载（个人服务
// 恒视为启用）。AuthHeaders 为多个 HTTP 认证头（如 Authorization /
// X-Api-Key），值语义同 providers 的 api_key：只在 PUT 请求携带（空值 =
// 按 ID+键继承现值，合并在 HTTP 层完成），任何读路径均不回显（掩码视图
// 仅报键名列表与 auth_headers_configured 布尔）。
type AIPersonalMCPServer struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	URL         string            `json:"url"`
	AuthHeaders map[string]string `json:"auth_headers,omitempty"`
	// Description 服务描述（可选，≤200 字符；管理侧展示用，非密钥）。
	Description string `json:"description,omitempty"`
	// TimeoutSec 单服务请求超时（0 = 默认 8s，上限 60；同平台）。
	TimeoutSec int `json:"timeout_sec,omitempty"`
	// DisabledTools 禁用的原始工具名列表（同平台；注入对话时跳过声明）。
	DisabledTools []string `json:"disabled_tools,omitempty"`
}

// AIPersonalChatSkill 为用户自定义对话技能（语义同平台 ai.chat_skills，
// 仅本人维度）：Content 为 Markdown 指令，对话中选用后注入 system 提示。
// 与平台技能按 id 增量合并（个人覆盖平台同 id 条目）。
type AIPersonalChatSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Content     string `json:"content"`
}

// AIPersonalOverrides 为用户对「覆盖型」AI 配置的个人覆盖集（双层配置：
// 字段未设置（nil）= 跟随平台值；设置后覆盖平台值）。全部非密钥，掩码
// 视图原样回显。
type AIPersonalOverrides struct {
	// WebSearch 对话联网搜索的默认开关（仅影响聊天输入框的初始状态）。
	WebSearch *bool `json:"web_search,omitempty"`
	// HistorySearch 对话历史检索模式（keyword/vector/off）。
	HistorySearch *string `json:"history_search,omitempty"`
	// DefaultPersona 默认人设 id（""=不注入；可为 builtin-/平台/个人人设 id，
	// 运行时未命中按未设置处理——平台侧 id 空间在合并后才能确定）。
	DefaultPersona *string `json:"default_persona,omitempty"`
	// Temperature 对话温度覆盖（0..2）。
	Temperature *float64 `json:"temperature,omitempty"`
	// OCR 图片兜底识图模型（指向个人池的 vision 能力 chat 模型；非 vision
	// 模型对话带图时优先用此模型识图，失败回退平台 ai.ocr 配置）。
	OCR *AIPersonalModelRef `json:"ocr,omitempty"`
	// RAG 个人检索增强覆盖（nil = 全部跟随平台；见 AIPersonalRAGOverrides）。
	RAG *AIPersonalRAGOverrides `json:"rag,omitempty"`
	// IncludeDocs 对话「我的文件」检索（RAG）默认开关（nil = 跟随平台）。
	IncludeDocs *bool `json:"include_docs,omitempty"`
}

// AIPersonalRAGOverrides 个人检索增强（RAG）覆盖集（字段 nil = 跟随平台）：
// 覆盖 embedding 后该用户的文档向量入「个人专属 collection」（与平台库
// 及其他用户隔离），检索/会话向量同身份解析；个人条目失效（模型删改）
// 时运行时静默回落平台链（不报错、不中断对话）。切换 embedding 或分块
// 参数后需重建个人索引（POST /api/v1/ai/personal/reindex）。
type AIPersonalRAGOverrides struct {
	// Embedding 个人 embedding 模型（指向个人池 openai_compatible Provider
	// 下具备 embedding 能力的模型；nil = 平台 ai.rag.embedding_*）。
	Embedding *AIPersonalModelRef `json:"embedding,omitempty"`
	// TopK 检索召回条数（1..10；nil = 平台默认）。
	TopK *int `json:"top_k,omitempty"`
	// ChunkSize 切块大小（100..8000 字符；nil = 平台值）。影响个人文档
	// 入库切分，变更后需重建个人索引。
	ChunkSize *int `json:"chunk_size,omitempty"`
	// ChunkOverlap 切块重叠（0..ChunkSize/2；nil = 平台值）。
	ChunkOverlap *int `json:"chunk_overlap,omitempty"`
}

// AIPersonalPrefs 为用户个人 AI 配置全集（user_ai_prefs.prefs 的 JSON 结构）。
// PreferPersonal=true 时未显式指定模型的对话/摘要请求优先使用个人池的
// 场景默认模型（个人 > 平台；显式指定 model 时个人池始终先于平台池解析）。
type AIPersonalPrefs struct {
	Providers      []AIPersonalProvider          `json:"providers"`
	DefaultModels  map[string]AIPersonalModelRef `json:"default_models,omitempty"`
	Personas       []AIPersonalPersona           `json:"personas,omitempty"`
	Skills         []AIPersonalSkill             `json:"skills,omitempty"`
	MCPServers     []AIPersonalMCPServer         `json:"mcp_servers,omitempty"`
	PreferPersonal bool                          `json:"prefer_personal"`
	// ChatSkills 个人对话技能（与平台 ai.chat_skills 按 id 增量合并，个人
	// 覆盖平台）。存量 JSON 无此字段反序列化为空，无需迁移。
	ChatSkills []AIPersonalChatSkill `json:"chat_skills,omitempty"`
	// Rules 个人 AI 规则（≤2000 字符）：与平台规则**叠加**注入对话 system
	// 提示（非覆盖）。非密钥，掩码视图原样回显。
	Rules string `json:"rules,omitempty"`
	// Overrides 覆盖型个人偏好（nil = 全部跟随平台）；见 AIPersonalOverrides。
	Overrides *AIPersonalOverrides `json:"overrides,omitempty"`
	// MemoryAuto 开启「AI 记忆自动提取」（默认零值 false=关闭）：每轮对话
	// 完成后由服务端后台提取长期偏好写入 ai_memory（kind=auto）。布尔非
	// 密钥，掩码视图原样回显；存量 JSON 无此字段反序列化为 false，无需
	// 迁移（校验无新增——布尔无非法值）。
	MemoryAuto bool `json:"memory_auto,omitempty"`
}

// ---------- 校验 ----------

// validAIPrefsID 校验标识符（provider/model/persona 的 id 与 name 共用）：
// 去空白后 1..max 字符，字符集 [A-Za-z0-9_\-.:/]（支持中文名；'/' 为
// OpenRouter/vLLM 网关风格的模型命名段——如 deepseek/deepseek-v4.1-flash，
// 常见于自建网关，拒绝会导致真实模型无法保存）。
func validAIPrefsID(s string, max int) bool {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > max {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '_' || r == '-' || r == '.' || r == ':' || r == ' ' || r == '/':
		case r >= 0x4e00 && r <= 0x9fff: // CJK（名称）
		default:
			return false
		}
	}
	return true
}

// ValidateAIPersonalPrefs 校验个人 AI 配置整体：providers ≤8（id 唯一、
// kind 仅 openai_compatible/anthropic、base_url 绝对 http(s)、models ≤20
// 且 id 唯一）、default_models 键限 chat/summary/edit/embedding 且引用须
// 指向个人池具备对应能力的模型、personas ≤20（system_prompt ≤4000 字符）。
// 非法返回包裹 ErrInvalidAIPrefs 的定位错误。
func ValidateAIPersonalPrefs(p AIPersonalPrefs) error {
	if len(p.Providers) > AIPersonalMaxProviders {
		return fmt.Errorf("%w: providers 最多 %d 个", ErrInvalidAIPrefs, AIPersonalMaxProviders)
	}
	seenProvider := make(map[string]bool, len(p.Providers))
	for i, prov := range p.Providers {
		field := fmt.Sprintf("providers[%d]", i)
		if !validAIPrefsID(prov.ID, 64) {
			return fmt.Errorf("%w: %s.id 须为 1..64 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, field)
		}
		if seenProvider[prov.ID] {
			return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, field, prov.ID)
		}
		seenProvider[prov.ID] = true
		if !validAIPrefsID(prov.Name, 100) {
			return fmt.Errorf("%w: %s.name 须为 1..100 个字符", ErrInvalidAIPrefs, field)
		}
		switch prov.Kind {
		case AIPersonalKindOpenAICompatible, AIPersonalKindAnthropic:
		default:
			return fmt.Errorf("%w: %s.kind 须为 openai_compatible 或 anthropic", ErrInvalidAIPrefs, field)
		}
		if u, err := url.Parse(strings.TrimSpace(prov.BaseURL)); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("%w: %s.base_url 须为绝对 http(s) URL", ErrInvalidAIPrefs, field)
		}
		if len([]rune(prov.APIKey)) > 512 {
			return fmt.Errorf("%w: %s.api_key 过长（≤512 字符）", ErrInvalidAIPrefs, field)
		}
		if len(prov.Models) > AIPersonalMaxModels {
			return fmt.Errorf("%w: %s.models 最多 %d 个", ErrInvalidAIPrefs, field, AIPersonalMaxModels)
		}
		if len(prov.Models) == 0 {
			return fmt.Errorf("%w: %s.models 至少配置 1 个模型", ErrInvalidAIPrefs, field)
		}
		seenModel := make(map[string]bool, len(prov.Models))
		for j, m := range prov.Models {
			mfield := fmt.Sprintf("%s.models[%d]", field, j)
			if !validAIPrefsID(m.ID, 128) {
				return fmt.Errorf("%w: %s.id 须为 1..128 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, mfield)
			}
			if seenModel[m.ID] {
				return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, mfield, m.ID)
			}
			seenModel[m.ID] = true
			if len([]rune(m.Label)) > 100 {
				return fmt.Errorf("%w: %s.label 过长（≤100 字符）", ErrInvalidAIPrefs, mfield)
			}
		}
	}
	// default_models：键白名单 + 引用存在性与能力匹配（对话类 → chat，
	// embedding → embedding；引用的是个人池）。
	for scenario, ref := range p.DefaultModels {
		switch scenario {
		case settings.AIScenarioChat, settings.AIScenarioSummary, settings.AIScenarioEdit, settings.AIScenarioEmbedding:
		default:
			return fmt.Errorf("%w: default_models 含未知场景 %q（仅 chat/summary/edit/embedding）", ErrInvalidAIPrefs, scenario)
		}
		prov, ok := p.PersonalProviderByID(ref.ProviderID)
		if !ok {
			return fmt.Errorf("%w: default_models.%s.provider_id %q 不在个人 Provider 中", ErrInvalidAIPrefs, scenario, ref.ProviderID)
		}
		m, ok := prov.PersonalModelWithID(ref.ModelID)
		if !ok {
			return fmt.Errorf("%w: default_models.%s.model_id %q 不在 Provider %q 中", ErrInvalidAIPrefs, scenario, ref.ModelID, prov.ID)
		}
		if scenario == settings.AIScenarioEmbedding && !m.Capabilities.IsEmbedding() {
			return fmt.Errorf("%w: default_models.%s 模型 %q 缺少 embedding 能力", ErrInvalidAIPrefs, scenario, ref.ModelID)
		}
		if scenario != settings.AIScenarioEmbedding && !m.Capabilities.IsChat() {
			return fmt.Errorf("%w: default_models.%s 模型 %q 缺少 chat 能力", ErrInvalidAIPrefs, scenario, ref.ModelID)
		}
	}
	if len(p.Personas) > AIPersonalMaxPersonas {
		return fmt.Errorf("%w: personas 最多 %d 个", ErrInvalidAIPrefs, AIPersonalMaxPersonas)
	}
	seenPersona := make(map[string]bool, len(p.Personas))
	for i, persona := range p.Personas {
		field := fmt.Sprintf("personas[%d]", i)
		if !validAIPrefsID(persona.ID, 64) {
			return fmt.Errorf("%w: %s.id 须为 1..64 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, field)
		}
		if seenPersona[persona.ID] {
			return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, field, persona.ID)
		}
		seenPersona[persona.ID] = true
		if !validAIPrefsID(persona.Name, 100) {
			return fmt.Errorf("%w: %s.name 须为 1..100 个字符", ErrInvalidAIPrefs, field)
		}
		if len([]rune(persona.SystemPrompt)) > AIPersonalMaxPromptRunes {
			return fmt.Errorf("%w: %s.system_prompt 过长（≤%d 字符）", ErrInvalidAIPrefs, field, AIPersonalMaxPromptRunes)
		}
	}
	// skills：≤50（id 唯一、name/description/prompt 长度边界；prompt 支持
	// {selection}/{file} 占位符，由前端替换，此处不做内容校验）。
	if len(p.Skills) > AIPersonalMaxSkills {
		return fmt.Errorf("%w: skills 最多 %d 个", ErrInvalidAIPrefs, AIPersonalMaxSkills)
	}
	seenSkill := make(map[string]bool, len(p.Skills))
	for i, skill := range p.Skills {
		field := fmt.Sprintf("skills[%d]", i)
		if !validAIPrefsID(skill.ID, 64) {
			return fmt.Errorf("%w: %s.id 须为 1..64 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, field)
		}
		if seenSkill[skill.ID] {
			return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, field, skill.ID)
		}
		seenSkill[skill.ID] = true
		if !validAIPrefsID(skill.Name, 100) {
			return fmt.Errorf("%w: %s.name 须为 1..100 个字符", ErrInvalidAIPrefs, field)
		}
		if len([]rune(skill.Description)) > AIPersonalMaxSkillDescRunes {
			return fmt.Errorf("%w: %s.description 过长（≤%d 字符）", ErrInvalidAIPrefs, field, AIPersonalMaxSkillDescRunes)
		}
		if len([]rune(skill.Prompt)) > AIPersonalMaxPromptRunes {
			return fmt.Errorf("%w: %s.prompt 过长（≤%d 字符）", ErrInvalidAIPrefs, field, AIPersonalMaxPromptRunes)
		}
	}
	// mcp_servers：≤8（id 唯一、url 绝对 http(s) ≤500、auth_headers ≤8 个
	// 且键为合法 header 名、值非空 ≤1000——空值语义为「继承现值」，继承
	// 合并后仍空即校验报错，调用方按定位提示补值）。
	if len(p.MCPServers) > AIPersonalMaxMCPServers {
		return fmt.Errorf("%w: mcp_servers 最多 %d 个", ErrInvalidAIPrefs, AIPersonalMaxMCPServers)
	}
	seenMCP := make(map[string]bool, len(p.MCPServers))
	for i, svc := range p.MCPServers {
		field := fmt.Sprintf("mcp_servers[%d]", i)
		if !validAIPrefsID(svc.ID, 64) {
			return fmt.Errorf("%w: %s.id 须为 1..64 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, field)
		}
		if seenMCP[svc.ID] {
			return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, field, svc.ID)
		}
		seenMCP[svc.ID] = true
		if !validAIPrefsID(svc.Name, 100) {
			return fmt.Errorf("%w: %s.name 须为 1..100 个字符", ErrInvalidAIPrefs, field)
		}
		if len([]rune(svc.URL)) > AIPersonalMaxMCPURLRunes {
			return fmt.Errorf("%w: %s.url 过长（≤%d 字符）", ErrInvalidAIPrefs, field, AIPersonalMaxMCPURLRunes)
		}
		if u, err := url.Parse(strings.TrimSpace(svc.URL)); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("%w: %s.url 须为绝对 http(s) URL", ErrInvalidAIPrefs, field)
		}
		if len(svc.AuthHeaders) > AIPersonalMaxMCPHeaders {
			return fmt.Errorf("%w: %s.auth_headers 最多 %d 个", ErrInvalidAIPrefs, field, AIPersonalMaxMCPHeaders)
		}
		for k, v := range svc.AuthHeaders {
			if err := validAIPersonalMCPHeader(k, v); err != nil {
				return fmt.Errorf("%w: %s.auth_headers.%s %v", ErrInvalidAIPrefs, field, k, err)
			}
		}
		if len([]rune(svc.Description)) > 200 {
			return fmt.Errorf("%w: %s.description 过长（≤200 字符）", ErrInvalidAIPrefs, field)
		}
		if svc.TimeoutSec < 0 || svc.TimeoutSec > 60 {
			return fmt.Errorf("%w: %s.timeout_sec 须为 0 或 1..60 秒", ErrInvalidAIPrefs, field)
		}
		if len(svc.DisabledTools) > 50 {
			return fmt.Errorf("%w: %s.disabled_tools 最多 50 个", ErrInvalidAIPrefs, field)
		}
		seenDisabled := make(map[string]bool, len(svc.DisabledTools))
		for _, t := range svc.DisabledTools {
			tt := strings.TrimSpace(t)
			if tt == "" || len([]rune(tt)) > 128 {
				return fmt.Errorf("%w: %s.disabled_tools 条目须为 1..128 字符", ErrInvalidAIPrefs, field)
			}
			if seenDisabled[tt] {
				return fmt.Errorf("%w: %s.disabled_tools 条目 %q 重复", ErrInvalidAIPrefs, field, tt)
			}
			seenDisabled[tt] = true
		}
	}
	// chat_skills：≤30（id 唯一、name/description/icon/content 长度边界；
	// content 为 Markdown 指令，此处不做内容校验）。
	if len(p.ChatSkills) > AIPersonalMaxChatSkills {
		return fmt.Errorf("%w: chat_skills 最多 %d 个", ErrInvalidAIPrefs, AIPersonalMaxChatSkills)
	}
	seenChatSkill := make(map[string]bool, len(p.ChatSkills))
	for i, skill := range p.ChatSkills {
		field := fmt.Sprintf("chat_skills[%d]", i)
		if !validAIPrefsID(skill.ID, 64) {
			return fmt.Errorf("%w: %s.id 须为 1..64 位字母/数字/_-.: 字符", ErrInvalidAIPrefs, field)
		}
		if seenChatSkill[skill.ID] {
			return fmt.Errorf("%w: %s.id %q 重复", ErrInvalidAIPrefs, field, skill.ID)
		}
		seenChatSkill[skill.ID] = true
		if !validAIPrefsID(skill.Name, 100) {
			return fmt.Errorf("%w: %s.name 须为 1..100 个字符", ErrInvalidAIPrefs, field)
		}
		if len([]rune(skill.Description)) > 200 {
			return fmt.Errorf("%w: %s.description 过长（≤200 字符）", ErrInvalidAIPrefs, field)
		}
		if len([]rune(skill.Icon)) > 40 {
			return fmt.Errorf("%w: %s.icon 过长（≤40 字符）", ErrInvalidAIPrefs, field)
		}
		if strings.TrimSpace(skill.Content) == "" || len([]rune(skill.Content)) > 4000 {
			return fmt.Errorf("%w: %s.content 须为 1..4000 字符", ErrInvalidAIPrefs, field)
		}
	}
	// rules：≤2000 字符（与平台规则叠加注入，非覆盖）。
	if len([]rune(strings.TrimSpace(p.Rules))) > AIPersonalMaxRulesRunes {
		return fmt.Errorf("%w: rules 过长（≤%d 字符）", ErrInvalidAIPrefs, AIPersonalMaxRulesRunes)
	}
	// overrides：覆盖型偏好校验（history 模式白名单、温度范围、OCR 须指向
	// 个人池 vision 能力 chat 模型；default_persona 为自由 id，合并后未命中
	// 按未设置处理，此处仅限长度）。
	if o := p.Overrides; o != nil {
		if o.HistorySearch != nil {
			switch *o.HistorySearch {
			case "keyword", "vector", "off":
			default:
				return fmt.Errorf("%w: overrides.history_search 须为 keyword/vector/off", ErrInvalidAIPrefs)
			}
		}
		if o.Temperature != nil && (*o.Temperature < 0 || *o.Temperature > 2) {
			return fmt.Errorf("%w: overrides.temperature 须为 0..2", ErrInvalidAIPrefs)
		}
		if o.DefaultPersona != nil && len([]rune(*o.DefaultPersona)) > 64 {
			return fmt.Errorf("%w: overrides.default_persona 过长（≤64 字符）", ErrInvalidAIPrefs)
		}
		if o.OCR != nil {
			prov, ok := p.PersonalProviderByID(o.OCR.ProviderID)
			if !ok {
				return fmt.Errorf("%w: overrides.ocr.provider_id %q 不在个人 Provider 中", ErrInvalidAIPrefs, o.OCR.ProviderID)
			}
			m, ok := prov.PersonalModelWithID(o.OCR.ModelID)
			if !ok {
				return fmt.Errorf("%w: overrides.ocr.model_id %q 不在 Provider %q 中", ErrInvalidAIPrefs, o.OCR.ModelID, prov.ID)
			}
			if !m.Capabilities.IsChat() || !m.Capabilities.Vision {
				return fmt.Errorf("%w: overrides.ocr 模型 %q 缺少 chat+vision 能力", ErrInvalidAIPrefs, o.OCR.ModelID)
			}
		}
		if r := o.RAG; r != nil {
			if r.Embedding != nil {
				prov, ok := p.PersonalProviderByID(r.Embedding.ProviderID)
				if !ok {
					return fmt.Errorf("%w: overrides.rag.embedding.provider_id %q 不在个人 Provider 中", ErrInvalidAIPrefs, r.Embedding.ProviderID)
				}
				if prov.Kind != settings.AIKindOpenAICompatible {
					return fmt.Errorf("%w: overrides.rag.embedding 须为 openai_compatible Provider（%s 无 embeddings API）", ErrInvalidAIPrefs, prov.Kind)
				}
				m, ok := prov.PersonalModelWithID(r.Embedding.ModelID)
				if !ok {
					return fmt.Errorf("%w: overrides.rag.embedding.model_id %q 不在 Provider %q 中", ErrInvalidAIPrefs, r.Embedding.ModelID, prov.ID)
				}
				if !m.Capabilities.IsEmbedding() {
					return fmt.Errorf("%w: overrides.rag.embedding 模型 %q 缺少 embedding 能力", ErrInvalidAIPrefs, r.Embedding.ModelID)
				}
			}
			if r.TopK != nil && (*r.TopK < 1 || *r.TopK > 10) {
				return fmt.Errorf("%w: overrides.rag.top_k 须为 1..10", ErrInvalidAIPrefs)
			}
			if r.ChunkSize != nil && (*r.ChunkSize < 100 || *r.ChunkSize > 8000) {
				return fmt.Errorf("%w: overrides.rag.chunk_size 须为 100..8000", ErrInvalidAIPrefs)
			}
			if r.ChunkOverlap != nil && *r.ChunkOverlap < 0 {
				return fmt.Errorf("%w: overrides.rag.chunk_overlap 须 ≥0", ErrInvalidAIPrefs)
			}
			if r.ChunkOverlap != nil && r.ChunkSize != nil && *r.ChunkOverlap > *r.ChunkSize/2 {
				return fmt.Errorf("%w: overrides.rag.chunk_overlap 须 ≤ chunk_size/2", ErrInvalidAIPrefs)
			}
		}
	}
	return nil
}

// validAIPersonalMCPHeader 校验单条认证头（键 = header 名，值 = 凭据）：
// 键 trim 后 1..64 字符且不含冒号/换行（Header.Set 语义），值 trim 后非空
// （空值语义为继承现值，继承合并后仍空在此报错）且 ≤1000 字符。
func validAIPersonalMCPHeader(k, v string) error {
	k = strings.TrimSpace(k)
	if k == "" || len([]rune(k)) > AIPersonalMaxMCPHeaderKeyRunes {
		return fmt.Errorf("键须为 1..%d 个字符", AIPersonalMaxMCPHeaderKeyRunes)
	}
	if strings.ContainsAny(k, ":\r\n") {
		return fmt.Errorf("键 %q 不得包含冒号或换行", k)
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return fmt.Errorf("值不能为空（留空 = 继承现值，仅对已配置的键生效）")
	}
	if len([]rune(v)) > AIPersonalMaxMCPHeaderValueRunes {
		return fmt.Errorf("值过长（≤%d 字符）", AIPersonalMaxMCPHeaderValueRunes)
	}
	return nil
}

// InheritAIPersonalMCPAuthHeaders 按 ID 继承认证头现值：in 中某服务的
// auth_headers 键值为空 = 保持库中现值（PUT 掩码回读视图的天然形态）；
// 库中无该服务的该键则保持空（交由校验报错提示补值）。in 为原地修改。
func InheritAIPersonalMCPAuthHeaders(in, current []AIPersonalMCPServer) {
	if len(in) == 0 || len(current) == 0 {
		return
	}
	existing := make(map[string]map[string]string, len(current))
	for _, svc := range current {
		if len(svc.AuthHeaders) > 0 {
			headers := make(map[string]string, len(svc.AuthHeaders))
			for k, v := range svc.AuthHeaders {
				headers[k] = v
			}
			existing[svc.ID] = headers
		}
	}
	for i := range in {
		headers := existing[in[i].ID]
		if headers == nil || len(in[i].AuthHeaders) == 0 {
			continue
		}
		for k, v := range in[i].AuthHeaders {
			if strings.TrimSpace(v) == "" {
				if old, ok := headers[k]; ok {
					in[i].AuthHeaders[k] = old
				}
			}
		}
	}
}

// PersonalProviderByID 按 ID 查找个人 Provider。
func (p AIPersonalPrefs) PersonalProviderByID(id string) (AIPersonalProvider, bool) {
	id = strings.TrimSpace(id)
	for _, prov := range p.Providers {
		if prov.ID == id {
			return prov, true
		}
	}
	return AIPersonalProvider{}, false
}

// PersonalModelWithID 从 Provider 的模型列表中查找模型。
func (p AIPersonalProvider) PersonalModelWithID(id string) (AIPersonalModel, bool) {
	id = strings.TrimSpace(id)
	for _, m := range p.Models {
		if m.ID == id {
			return m, true
		}
	}
	return AIPersonalModel{}, false
}

// ---------- 掩码视图（读路径绝不回显 api_key） ----------

// AIPersonalProviderView 为个人 Provider 的掩码视图：api_key 以
// api_key_configured 布尔回显，其余字段深拷贝。
type AIPersonalProviderView struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Kind             string            `json:"kind"`
	BaseURL          string            `json:"base_url"`
	APIKeyConfigured bool              `json:"api_key_configured"`
	Models           []AIPersonalModel `json:"models"`
}

// AIPersonalMCPServerView 为个人 MCP 服务的掩码视图：认证头值绝不回显，
// 仅报键名列表（AuthHeaders，供前端编辑时展示「已配置，留空保持」）与
// auth_headers_configured 布尔。
type AIPersonalMCPServerView struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	AuthHeaders []string `json:"auth_headers,omitempty"`
	// AuthHeadersConfigured 为 true 表示已配置至少一个认证头。
	AuthHeadersConfigured bool     `json:"auth_headers_configured"`
	Description           string   `json:"description,omitempty"`
	TimeoutSec            int      `json:"timeout_sec,omitempty"`
	DisabledTools         []string `json:"disabled_tools,omitempty"`
}

// maskedAIPersonalMCPView 生成单条掩码视图（键名按字典序，回显稳定）。
func maskedAIPersonalMCPView(svc AIPersonalMCPServer) AIPersonalMCPServerView {
	view := AIPersonalMCPServerView{ID: svc.ID, Name: svc.Name, URL: svc.URL, AuthHeadersConfigured: len(svc.AuthHeaders) > 0, Description: svc.Description, TimeoutSec: svc.TimeoutSec, DisabledTools: svc.DisabledTools}
	if len(svc.AuthHeaders) > 0 {
		keys := make([]string, 0, len(svc.AuthHeaders))
		for k := range svc.AuthHeaders {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		view.AuthHeaders = keys
	}
	return view
}

// AIPersonalPrefsView 为 GET /ai/personal-settings 的响应载荷（掩码视图）。
type AIPersonalPrefsView struct {
	Providers      []AIPersonalProviderView      `json:"providers"`
	DefaultModels  map[string]AIPersonalModelRef `json:"default_models,omitempty"`
	Personas       []AIPersonalPersona           `json:"personas,omitempty"`
	Skills         []AIPersonalSkill             `json:"skills,omitempty"`
	MCPServers     []AIPersonalMCPServerView     `json:"mcp_servers,omitempty"`
	PreferPersonal bool                          `json:"prefer_personal"`
	// ChatSkills / Rules / Overrides 均非密钥，原样回显。
	ChatSkills []AIPersonalChatSkill `json:"chat_skills,omitempty"`
	Rules      string                `json:"rules,omitempty"`
	Overrides  *AIPersonalOverrides  `json:"overrides,omitempty"`
	// MemoryAuto 原样回显（非密钥，不受掩码逻辑触碰）。
	MemoryAuto bool `json:"memory_auto,omitempty"`
}

// Masked 返回深拷贝掩码视图：Provider 的 api_key 字段剔除，仅保留
// api_key_configured 布尔；其余字段（models/default_models/personas）逐层
// 拷贝，调用方可安全序列化。
func (p AIPersonalPrefs) Masked() AIPersonalPrefsView {
	out := AIPersonalPrefsView{PreferPersonal: p.PreferPersonal, MemoryAuto: p.MemoryAuto}
	out.Providers = make([]AIPersonalProviderView, 0, len(p.Providers))
	for _, prov := range p.Providers {
		view := AIPersonalProviderView{
			ID: prov.ID, Name: prov.Name, Kind: prov.Kind, BaseURL: prov.BaseURL,
			APIKeyConfigured: prov.APIKey != "",
		}
		view.Models = make([]AIPersonalModel, len(prov.Models))
		copy(view.Models, prov.Models)
		out.Providers = append(out.Providers, view)
	}
	if p.DefaultModels != nil {
		out.DefaultModels = make(map[string]AIPersonalModelRef, len(p.DefaultModels))
		for k, v := range p.DefaultModels {
			out.DefaultModels[k] = v
		}
	}
	out.Personas = append(out.Personas, p.Personas...)
	out.Skills = append(out.Skills, p.Skills...)
	out.ChatSkills = append(out.ChatSkills, p.ChatSkills...)
	out.Rules = p.Rules
	if p.Overrides != nil {
		o := *p.Overrides
		out.Overrides = &o
	}
	out.MCPServers = make([]AIPersonalMCPServerView, 0, len(p.MCPServers))
	for _, svc := range p.MCPServers {
		out.MCPServers = append(out.MCPServers, maskedAIPersonalMCPView(svc))
	}
	return out
}

// ---------- 存储（UserStore，模式同 user_open_with） ----------

// GetAIPrefs 读取用户的个人 AI 配置原始 JSON；无记录返回 (nil, nil)（由
// 调用方归一为空配置）。解析失败（库中 JSON 损坏）返回错误。
func (s *UserStore) GetAIPrefs(userID uuid.UUID) (json.RawMessage, error) {
	// 注意不能 Scan 到 []byte：GORM 的 Scan 会把目标当切片、尝试把列值
	// 装进单个元素（uint8）——「converting []uint8 to uint8: invalid
	// syntax」，行存在也恒报错（GET 个人配置曾因此恒空，保存后刷新即丢
	// 显示）。jsonb 经 ::text + *string 取回。
	var raw *string
	if err := s.db.Raw("SELECT prefs::text FROM user_ai_prefs WHERE user_id = ?", userID).Scan(&raw).Error; err != nil {
		return nil, err
	}
	if raw == nil || *raw == "" {
		return nil, nil
	}
	if !json.Valid([]byte(*raw)) {
		return nil, fmt.Errorf("user_ai_prefs: invalid json for user %s", userID)
	}
	return json.RawMessage(*raw), nil
}

// SetAIPrefs 整块写入（UPSERT，更新 updated_at）；prefs 须先经
// ValidateAIPersonalPrefs 校验并完成 api_key 留空继承合并（HTTP 层）。
func (s *UserStore) SetAIPrefs(userID uuid.UUID, prefs json.RawMessage) error {
	now := time.Now().UTC()
	return s.db.Exec(`
		INSERT INTO user_ai_prefs (user_id, prefs, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT (user_id)
		DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at`,
		userID, []byte(prefs), now).Error
}
