// 管理后台「AI 设置」面板（多模型 Provider 体系；原 11 个堆叠 Card 改为
// 顶部 Tabs 分区，根容器挂 ai-settings-surface 供全域定宽样式）：
// - Provider 卡片列表（名称/类型/模型列表/限流/状态/密钥配置）+ 新建/编辑/
//   复制（深拷贝改名）/删除弹窗（类型 Select：OpenAI 兼容 / Anthropic /
//   Mock 预设；每个 Provider 维护 models[{id,label,capabilities}]——类型
//   互斥单选（对话/嵌入/重排/图像，Cherry Studio 语义）+ 能力并集多选
//   （推理/视觉/音频/视频），每行「识别」与粘贴回车添加均经 models.dev
//   目录自动预填，及 Provider 级限流 requests_per_min / daily_quota）；
// - 默认项：场景默认模型（chat/summary/edit/embedding，下拉只列具备对应
//   能力的模型；summary/edit 可回落 chat）/ 温度 / max_tokens / 全局兜底
//   限流（PUT 整体保存）；
// - RAG：embedding/rerank 从已配置 Provider 的对应能力模型中选择，各配置
//   项带说明 tooltip 与文档解析说明文案；
// - 图片 OCR：开关 + 视觉能力模型选择 + 单图大小上限（随 ai 主设置保存）；
// - 平台人设 / 技能模板：独立端点（/admin/settings/ai/personas|skills）整块
//   读替，列表 + Modal 编辑（快捷指令 prompt 支持 {selection}/{file} 占位符）；
// - 用量统计表（ai_usage 按用户聚合，日期过滤）。
import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Checkbox, Dropdown, Input, InputNumber, Radio, Select, Switch, Table, Tabs, Tag, Tooltip } from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
import { Copy, Download, GripVertical, Image, MessageSquare, Network, Pencil, Plus, Sparkles, Trash2, Upload, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  AIMCPAdminView,
  AIMCPInput,
  AIMCPTestResult,
  AIOCRSettings,
  AISearchSettings,
  AIPersonaDef,
  AIAgentPackageDef,
  AIChatSkillDef,
  AIPackageStatsRow,
  AIModelCapabilities,
  AIModelItem,
  AIModelKind,
  AIModelRef,
  AIProviderInput,
  AIProviderView,
  AIRAGSettings,
  AISettingsData,
  AISkillDef,
  AIUsageRow,
  adminGetAIChatSkills,
  adminGetAIRules,
  adminPutAIChatSkills,
  adminPutAIRules,
  exportAIAgentPackages,
  exportAIMCP,
  getAIMCPAdmin,
  getAIAgentPackages,
  getAIPackageStats,
  getAIPersonas,
  getAISettings,
  getAISkills,
  getAIUsage,
  getAIUsageByConversation,
  getAIToolStats,
  importAIAgentPackages,
  importAIMCP,
  type AIConvoUsageRow,
  type AIToolStatsRow,
  lookupAIModel,
  putAIAgentPackages,
  putAIMCPAdmin,
  putAIPersonas,
  putAISettings,
  putAISkills,
  reindexAIHistoryVector,
  reindexAIRAG,
  testAIMCP,
  testAIProvider,
  testAIRAG,
} from '../api'
import { Modal } from './FileBrowser'
import { SettingsSection } from './settings/SettingsSections'
import { refreshAIFeature } from '../aiFeature'
import { t, useLocale } from '../i18n'

/** 类型预设模板（选中即回填 baseURL/默认单模型建议）。Mock 为内部测试
 * 协议，不在管理 UI 暴露（存量 mock Provider 仍可运行，仅不可新建）。 */
const KIND_PRESETS: Record<string, { label: string; baseURL: string; model: string }> = {
  openai_compatible: { label: 'OpenAI 兼容（OpenAI/DeepSeek/Qwen/Ollama/vLLM）', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic（Claude）', baseURL: 'https://www.anthropic.com', model: 'claude-sonnet-4-20250514' },
}

/** 模型类型定义（互斥单选，Cherry Studio 语义：一个模型只属一类）。 */
const MODEL_KIND_OPTIONS: { value: AIModelKind; zh: string; en: string; icon: LucideIcon }[] = [
  { value: 'chat', zh: '对话', en: 'Chat', icon: MessageSquare },
  { value: 'embedding', zh: '嵌入', en: 'Embedding', icon: Network },
  { value: 'rerank', zh: '重排', en: 'Rerank', icon: GripVertical },
  { value: 'image', zh: '图像', en: 'Image', icon: Image },
]

/** 能力项定义（可多选勾选的并集）：推理/视觉/音频/视频。 */
const CAPABILITY_FIELDS: { key: 'reasoning' | 'vision' | 'audio' | 'video'; zh: string; en: string }[] = [
  { key: 'reasoning', zh: '推理', en: 'Reasoning' },
  { key: 'vision', zh: '视觉', en: 'Vision' },
  { key: 'audio', zh: '音频', en: 'Audio' },
  { key: 'video', zh: '视频', en: 'Video' },
]

const emptyCaps = (): AIModelCapabilities => ({ kind: 'chat', reasoning: false, vision: false, audio: false, video: false })

/** caps 归一：kind 为单形态必填字段，缺省（undefined/空串）回退默认类型
 *  chat（与后端 NormalizeAIModelKind 的默认值语义一致）。 */
const normalizeCaps = (raw?: AIModelCapabilities | null): AIModelCapabilities => {
  const c = raw ?? emptyCaps()
  const kind = (c.kind || 'chat') as AIModelKind
  return { kind, reasoning: !!c.reasoning, vision: !!c.vision, audio: !!c.audio, video: !!c.video }
}

/** 类型文本（展示/识别提示共用）。 */
const kindText = (kind: AIModelKind | undefined, zh: boolean): string => {
  const opt = MODEL_KIND_OPTIONS.find((k) => k.value === kind)
  if (!opt) return kind ?? ''
  return zh ? opt.zh : opt.en
}

/** 类型+能力描述（自动识别成功提示，如「对话+推理」）。 */
const capsSummary = (caps: AIModelCapabilities, zh: boolean): string =>
  [kindText(caps.kind, zh), ...CAPABILITY_FIELDS.filter((c) => caps[c.key]).map((c) => (zh ? c.zh : c.en))].join('+')

/** 编辑中的模型行。 */
interface ModelForm {
  id: string
  label: string
  caps: AIModelCapabilities
  /** 上下文窗口（token；0=不限制）。 */
  context_window?: number
  /** 输出上限覆盖（0=用全局）。 */
  max_tokens?: number
}

/** 编辑中的 Provider 表单态。 */
interface ProviderForm {
  id: string
  name: string
  kind: string
  base_url: string
  api_key: string
  models: ModelForm[]
  enabled: boolean
  requestsPerMin: number
  dailyQuota: number
  isNew: boolean
}

const formFromView = (p: AIProviderView): ProviderForm => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  base_url: p.base_url,
  api_key: '',
  models: (p.models ?? []).map((m) => ({ id: m.id, label: m.label ?? '', caps: normalizeCaps(m.capabilities) })),
  enabled: p.enabled,
  requestsPerMin: p.requests_per_min ?? 0,
  dailyQuota: p.daily_quota ?? 0,
  isNew: false,
})

/** 编辑中的平台人设表单态。 */
interface PersonaForm {
  id: string
  name: string
  system_prompt: string
  isNew: boolean
}

/** 编辑中的技能模板表单态。 */
interface SkillForm {
  id: string
  name: string
  description: string
  prompt: string
  enabled: boolean
  isNew: boolean
}

/** 常用官方 MCP 服务模板（Streamable HTTP 端点；新建弹窗一键预填，可改）：
 * 仅收录官方托管、原生 HTTP/SSE 可直连的服务；需要本地部署网关（stdio）的
 * 服务不在其列（后端 MCP 客户端仅支持 HTTP/SSE）。 */
const MCP_OFFICIAL_TEMPLATES = [
  { id: 'context7', name: 'Context7（最新代码文档检索）', url: 'https://mcp.context7.com/mcp' },
  { id: 'deepwiki', name: 'DeepWiki（GitHub 仓库解读）', url: 'https://mcp.deepwiki.com/mcp' },
  { id: 'mcp-get', name: 'MCP-Get（MCP 服务目录搜索）', url: 'https://mcp-get.com/mcp' },
]

/** 编辑中的对话技能表单态（Cherry Studio 式 Skills，Markdown 整段注入）。 */
interface ChatSkillForm {
  id: string
  name: string
  icon: string
  description: string
  content: string
  enabled: boolean
  isNew: boolean
}

/** MCP 认证头草稿行（键必填；值留空 = 保持已配置值，删除行 = 移除该头）。 */
interface MCPHeaderDraft {
  key: string
  value: string
}

/** 编辑中的 MCP 工具服务表单态（auth_header 与认证头值草稿：空 = 保持现值）。 */
interface MCPForm {
  id: string
  name: string
  description: string
  url: string
  auth_header: string
  headersDraft: MCPHeaderDraft[]
  /** 单服务超时秒数（0 = 默认 8s）。 */
  timeoutSec: number
  disabledTools: string[]
  enabled: boolean
  isNew: boolean
}

/** 编辑中的技能包变更日志条目（date 为 YYYY-MM-DD 草稿，可空）。 */
interface PackageChangelogFormEntry {
  version: number
  date: string
  note: string
}

/** 编辑中的 Agent 技能包表单态（I 批次）。 */
interface PackageForm {
  id: string
  name: string
  description: string
  system_extra: string
  tools: string[]
  kinds: string[]
  version: number
  changelog: PackageChangelogFormEntry[]
  isNew: boolean
}

/** 技能包适用文档类型（applyKind 同枚举；空 = 全部）。 */
const PACKAGE_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'text', label: 'text（Markdown/纯文本）' },
  { value: 'excalidraw-json', label: 'excalidraw-json（白板）' },
  { value: 'drawio-xml', label: 'drawio-xml（流程图）' },
  { value: 'richtext-patch', label: 'richtext-patch（富文本）' },
  { value: 'office-word', label: 'office-word' },
  { value: 'office-excel', label: 'office-excel' },
  { value: 'office-ppt', label: 'office-ppt' },
  { value: 'office-pdf', label: 'office-pdf' },
]

/** 技能包工具白名单候选（dd_* 平台工具；空 = 不限制）。 */
const PACKAGE_TOOL_OPTIONS = [
  'dd_list_dir', 'dd_read_file', 'dd_write_file', 'dd_mkdir', 'dd_search',
  'dd_read_memory', 'dd_write_memory', 'dd_search_history',
]

/** 测试连接结果（按 provider id 记录）。 */
type TestState = { running: boolean; ok?: boolean; message: string }

/** MCP 服务测试结果（按服务 id / 编辑弹窗记录；names 前 5 个 Tag 展示；
 *  toolNames 为全量工具名——编辑弹窗「禁用工具」下拉的数据源）。 */
type MCPTestState = { running: boolean; ok?: boolean; message: string; names?: string[]; toolNames?: string[] }

/** MCP 测试结果 → 展示态（ok → 连接成功 · N 个工具 · Xms；失败 → error；
 *  工具名优先取 tool_list 全量预览，旧后端回退 names）。 */
const mcpTestState = (r: AIMCPTestResult, zh: boolean): MCPTestState => {
  if (!r.ok) return { running: false, ok: false, message: r.error || (zh ? '连接失败' : 'Connection failed') }
  const names = r.tool_list?.map((tl) => tl.name) ?? r.names
  return {
    running: false,
    ok: true,
    names,
    toolNames: names,
    message: zh ? `连接成功 · ${r.tools} 个工具 · ${r.latency_ms}ms` : `Connected · ${r.tools} tools · ${r.latency_ms}ms`,
  }
}

/** MCP 测试结果展示：names 前 5 个 Tag，超出折叠为 +N（Tooltip 给全量）。 */
function MCPTestResult({ state, zh }: { state: MCPTestState; zh: boolean }) {
  if (state.running) return <div className="ai-test-result">{state.message}</div>
  if (!state.ok) return <div className="ai-test-result error-text">{state.message}</div>
  const names = state.names ?? []
  return (
    <div className="ai-test-result ok-text">
      <div>{state.message}</div>
      {names.length > 0 && (
        <div className="ai-mcp-test-tools">
          {names.slice(0, 5).map((n) => (
            <Tag key={n} style={{ marginTop: 4 }}>{n}</Tag>
          ))}
          {names.length > 5 && (
            <Tooltip title={names.join(zh ? '、' : ', ')}>
              <Tag style={{ marginTop: 4 }}>+{names.length - 5}</Tag>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

/** 场景默认模型下拉的场景定义。 */
const SCENARIOS: { key: string; zh: string; en: string; cap: 'chat' | 'embedding'; hint: string }[] = [
  { key: 'chat', zh: '对话默认', en: 'Chat default', cap: 'chat', hint: '通用对话与「问 AI」使用的默认模型（provider+model）。' },
  { key: 'summary', zh: '摘要默认', en: 'Summary default', cap: 'chat', hint: '文件 AI 摘要使用的默认模型；无合适模型时回落「对话默认」。' },
  { key: 'edit', zh: '编辑器默认', en: 'Editor default', cap: 'chat', hint: '编辑器 AI（润色/续写等）使用的默认模型；无合适模型时回落「对话默认」。' },
  { key: 'embedding', zh: '向量默认', en: 'Embedding default', cap: 'embedding', hint: '对话场景下的默认向量模型（RAG 索引侧请在「检索增强」面板选择）。' },
]

export default function AISettingsPanel({
  onError,
  onNotice,
  readOnly = false,
}: {
  onError: (message: string) => void
  onNotice: (message: string) => void
  readOnly?: boolean
}) {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const { modal } = AntdApp.useApp()
  // 分区 Tabs 激活键（providers 默认；切卡不卸载草稿态之外的受控内容）。
  const [activeTab, setActiveTab] = useState('providers')
  const [data, setData] = useState<AISettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<ProviderForm | null>(null)
  // 模型自动识别（按行 loading，idx 键）与「粘贴回车添加」输入草稿。
  const [modelDetecting, setModelDetecting] = useState<Record<number, boolean>>({})
  const [newModelInput, setNewModelInput] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [ragTest, setRagTest] = useState<TestState | null>(null)
  // 默认项（独立受控，保存时与 providers 一并 PUT）。
  const [defaultProvider, setDefaultProvider] = useState('')
  const [defaultModels, setDefaultModels] = useState<Record<string, AIModelRef>>({})
  // 默认人设（''=不注入；builtin- 前缀或平台 personas id；PUT 始终显式携带，
  // 空串 = 清除——后端对缺省字段按「保持现值」处理）。
  const [defaultPersona, setDefaultPersona] = useState('')
  // 备选模型链（H2：首选上游失败且零增量时依序切换；≤5 条）。
  const [fallbackModels, setFallbackModels] = useState<AIModelRef[]>([])
  const [temperature, setTemperature] = useState(0.3)
  const [maxTokens, setMaxTokens] = useState(2048)
  const [perUserPerMin, setPerUserPerMin] = useState(20)
  // 总开关（ai.enabled 生效值；保存时显式写入）。
  const [aiEnabled, setAIEnabled] = useState(false)
  const [rag, setRag] = useState<AIRAGSettings>({ mode: 'keyword', vector_enabled: false, qdrant_url: 'http://qdrant:6333', collection_prefix: 'docdyne_', embedding_provider: 'mock', embedding_model: 'text-embedding-3-small', rerank_provider: '', rerank_model: '', top_k: 8, chunk_size: 1000, chunk_overlap: 100 })
  // 图片 OCR（随 ai 主设置一并 PUT；旧后端无 ocr 块时保持缺省值）。
  const [ocr, setOcr] = useState<AIOCRSettings>({ enabled: false, provider_id: '', model_id: '', max_image_bytes: 8 * 1024 * 1024 })
  // 联网搜索（随 ai 主设置一并 PUT；旧后端无 search 块时保持缺省值；
  // tavily_api_key 只写不读——GET 只回 configured 标志，输入留空 = 保持）。
  const [search, setSearch] = useState<AISearchSettings>({ provider: '', searxng_url: '', max_results: 5, proxy_url: '' })
  const [tavilyConfigured, setTavilyConfigured] = useState(false)
  // 对话历史检索（v7.15 A8，随 ai 主设置一并 PUT）：'keyword' | 'vector'
  // （RAG 语义召回，需 Qdrant + 真实 embedding，不可用自动降级）| 'off'；
  // 原值透传存储，旧后端缺省 = keyword。
  const [historySearch, setHistorySearch] = useState('keyword')
  // 平台人设 / 技能模板（各自独立 PUT 整块保存，不入 putAISettings）。
  const [personas, setPersonas] = useState<AIPersonaDef[]>([])
  const [personaEditing, setPersonaEditing] = useState<PersonaForm | null>(null)
  const [skills, setSkills] = useState<AISkillDef[]>([])
  const [skillEditing, setSkillEditing] = useState<SkillForm | null>(null)
  // 平台规则（独立端点 /admin/settings/ai/rules；与用户个人规则叠加注入）。
  const [rules, setRules] = useState('')
  const [rulesSaving, setRulesSaving] = useState(false)
  // 对话技能（Cherry Studio 式 Skills；独立端点整块读替，≤50 条）。
  const [chatSkills, setChatSkills] = useState<AIChatSkillDef[]>([])
  const [chatSkillEditing, setChatSkillEditing] = useState<ChatSkillForm | null>(null)
  // Agent 技能包（I 批次）：列表 + 编辑弹窗 + 使用统计（ai.chat 审计按包聚合）+ 导入弹窗。
  const [agentPackages, setAgentPackages] = useState<AIAgentPackageDef[]>([])
  const [pkgEditing, setPkgEditing] = useState<PackageForm | null>(null)
  const [pkgStats, setPkgStats] = useState<Record<string, AIPackageStatsRow>>({})
  const [pkgImport, setPkgImport] = useState<{ format: 'json' | 'yaml'; content: string; mode: 'upsert' | 'replace' } | null>(null)
  const [pkgImporting, setPkgImporting] = useState(false)
  const [pkgExporting, setPkgExporting] = useState(false)
  // MCP 工具服务（独立端点 /admin/settings/ai/mcp 整块读替，≤8 条）。
  const [mcpServices, setMcpServices] = useState<AIMCPAdminView[]>([])
  const [mcpEditing, setMcpEditing] = useState<MCPForm | null>(null)
  const [mcpSaving, setMcpSaving] = useState(false)
  // MCP 连通性测试：行级（按已保存 url，不带密钥）与编辑弹窗（表单草稿）。
  const [mcpTests, setMcpTests] = useState<Record<string, MCPTestState>>({})
  const [mcpModalTest, setMcpModalTest] = useState<MCPTestState | null>(null)
  // MCP mcpServers JSON 导入（粘贴内容草稿）与导出中状态。
  const [mcpImport, setMcpImport] = useState<{ content: string } | null>(null)
  const [mcpImporting, setMcpImporting] = useState(false)
  const [mcpExporting, setMcpExporting] = useState(false)
  // 编辑弹窗关闭后清理草稿测试结果（下次打开重新开始）。
  useEffect(() => {
    if (!mcpEditing) setMcpModalTest(null)
  }, [mcpEditing])
  // RAG 重建向量索引（POST /admin/settings/ai/reindex）与
  // 会话历史向量重建（POST /admin/settings/ai/history/reindex，vector 档）。
  const [reindexing, setReindexing] = useState(false)
  const [historyReindexing, setHistoryReindexing] = useState(false)
  // 用量统计（G2/G3：user=按用户+Provider+模型 / conversation=按会话 /
  //  tool=ai.tool 审计按工具名聚合）。
  const [usageBy, setUsageBy] = useState<'user' | 'conversation' | 'tool'>('user')
  const [usageRows, setUsageRows] = useState<AIUsageRow[] | null>(null)
  const [convoUsageRows, setConvoUsageRows] = useState<AIConvoUsageRow[] | null>(null)
  const [toolStatsRows, setToolStatsRows] = useState<AIToolStatsRow[] | null>(null)
  const [usageTotal, setUsageTotal] = useState<{ calls: number; tokens: number }>({ calls: 0, tokens: 0 })
  const [usageFrom, setUsageFrom] = useState('')
  const [usageTo, setUsageTo] = useState('')
  const [usageLoading, setUsageLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const d = await getAISettings()
      setData(d)
      setAIEnabled(d.enabled)
      if (d.rag) setRag({ rerank_provider: '', rerank_model: '', ...d.rag })
      if (d.ocr) setOcr({ ...d.ocr, max_image_bytes: d.ocr.max_image_bytes || 8 * 1024 * 1024 })
      if (d.search) {
        setSearch({ provider: d.search.provider ?? '', searxng_url: d.search.searxng_url ?? '', max_results: d.search.max_results > 0 ? d.search.max_results : 5, tavily_api_key: '', proxy_url: d.search.proxy_url ?? '' })
        setTavilyConfigured(d.search.tavily_api_key_configured === true)
      }
      setHistorySearch(d.history_search ?? 'keyword')
      setDefaultProvider(d.default_provider || (d.providers.find((p) => p.enabled)?.id ?? ''))
      setDefaultModels(d.default_models ?? {})
      setDefaultPersona(d.default_persona ?? '')
      setFallbackModels(d.fallback_models ?? [])
      setTemperature(d.temperature)
      setMaxTokens(d.max_tokens)
      setPerUserPerMin(d.per_user_per_min)
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadUsage = async (by = usageBy) => {
    setUsageLoading(true)
    try {
      if (by === 'conversation') {
        const r = await getAIUsageByConversation(usageFrom || undefined, usageTo || undefined)
        setConvoUsageRows(r.rows ?? [])
        setUsageTotal(r.total ?? { calls: 0, tokens: 0 })
      } else if (by === 'tool') {
        const r = await getAIToolStats(usageFrom || undefined, usageTo || undefined)
        setToolStatsRows(r.rows ?? [])
        let calls = 0
        let ok = 0
        for (const row of r.rows ?? []) {
          calls += row.calls
          ok += row.ok
        }
        setUsageTotal({ calls, tokens: ok })
      } else {
        const r = await getAIUsage(usageFrom || undefined, usageTo || undefined)
        setUsageRows(r.rows ?? [])
        setUsageTotal(r.total ?? { calls: 0, tokens: 0 })
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'loadFailed'))
    } finally {
      setUsageLoading(false)
    }
  }

  useEffect(() => {
    void loadUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 平台人设 / 技能模板 / Agent 技能包 / MCP 工具服务：独立端点整块读替
  //（初始拉取；失败提示。技能包使用统计失败静默——不阻塞列表展示）。
  useEffect(() => {
    getAIPersonas()
      .then(setPersonas)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    getAISkills()
      .then(setSkills)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    adminGetAIChatSkills()
      .then(setChatSkills)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    adminGetAIRules()
      .then(setRules)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    getAIAgentPackages()
      .then(setAgentPackages)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    getAIPackageStats()
      .then((r) => {
        const map: Record<string, AIPackageStatsRow> = {}
        for (const row of r.rows ?? []) map[row.package] = row
        setPkgStats(map)
      })
      .catch(() => { /* 统计不可用不影响管理 */ })
    getAIMCPAdmin()
      .then(setMcpServices)
      .catch((err) => onError(err instanceof Error ? err.message : t(locale, 'loadFailed')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 可编辑 Provider（env 合成的只读展示，不入表单）。 */
  const editableProviders = (): AIProviderInput[] =>
    (data?.providers ?? [])
      .filter((p) => !p.is_env)
      .map((p) => ({
        id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model,
        models: (p.models ?? []).map((m) => ({ id: m.id, label: m.label, capabilities: m.capabilities })),
        enabled: p.enabled, requests_per_min: p.requests_per_min, daily_quota: p.daily_quota,
      }))

  /** 保存（enabledOn 缺省 = 当前开关态；保存成功后刷新全站 AI 入口显隐）。 */
  const save = async (providers?: AIProviderInput[], enabledOn?: boolean, defaultsOverride?: Record<string, AIModelRef>, fallbackOverride?: AIModelRef[]) => {
    if (saving) return
    setSaving(true)
    try {
      // default_persona 始终显式携带（空串 = 清除默认人设；后端对缺省字段
      // 按「保持现值」处理）。载荷以变量承载：多余字段不参与字面量校验，
      // 与 putAISettings 入参类型结构兼容。
      const payload = {
        enabled: enabledOn ?? aiEnabled,
        providers: providers ?? editableProviders(),
        default_provider: defaultProvider,
        default_models: defaultsOverride ?? defaultModels,
        fallback_models: fallbackOverride ?? fallbackModels,
        temperature,
        max_tokens: maxTokens,
        per_user_per_min: perUserPerMin,
        rag,
        ocr,
        search,
        history_search: historySearch,
        default_persona: defaultPersona,
      }
      const merged = await putAISettings(payload)
      setData(merged)
      setHistorySearch(merged.history_search ?? 'keyword')
      setAIEnabled(merged.enabled)
      setDefaultProvider(merged.default_provider)
      setDefaultPersona(merged.default_persona ?? '')
      if (merged.default_models) setDefaultModels(merged.default_models)
      setFallbackModels(merged.fallback_models ?? [])
      if (merged.ocr) setOcr({ ...merged.ocr, max_image_bytes: merged.ocr.max_image_bytes || 8 * 1024 * 1024 })
      if (merged.search) {
        setSearch((prev) => ({ provider: merged.search!.provider ?? '', searxng_url: merged.search!.searxng_url ?? '', max_results: merged.search!.max_results > 0 ? merged.search!.max_results : 5, tavily_api_key: merged.search!.tavily_api_key_configured ? prev.tavily_api_key : '', proxy_url: merged.search!.proxy_url ?? '' }))
        setTavilyConfigured(merged.search.tavily_api_key_configured === true)
      }
      refreshAIFeature()
      onNotice(zh ? 'AI 设置已保存' : 'AI settings saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  /** 清理场景默认中指向指定 Provider 的引用（删除 Provider 时联动）。 */
  const dropDefaultRefs = (providers: AIProviderInput[], removedID: string): Record<string, AIModelRef> => {
    const knownModels = new Set(providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}::${m.id}`)))
    const out: Record<string, AIModelRef> = {}
    for (const [scenario, ref] of Object.entries(defaultModels)) {
      if (ref.provider_id === removedID) continue
      if (!knownModels.has(`${ref.provider_id}::${ref.model_id}`)) continue
      out[scenario] = ref
    }
    return out
  }

  const removeProvider = (id: string) => {
    const next = editableProviders().filter((p) => p.id !== id)
    const nextDefault = defaultProvider === id ? (next.find((p) => p.enabled)?.id ?? '') : defaultProvider
    setDefaultProvider(nextDefault)
    const defaults = dropDefaultRefs(next, id)
    setDefaultModels(defaults)
    // 备选链同步清理指向被删 Provider / 已移除模型的条目。
    const knownModels = new Set(next.flatMap((p) => (p.models ?? []).map((m) => `${p.id}::${m.id}`)))
    const fallbacks = fallbackModels.filter((r) => r.provider_id !== id && knownModels.has(`${r.provider_id}::${r.model_id}`))
    setFallbackModels(fallbacks)
    void save(next, undefined, defaults, fallbacks)
  }

  /** 复制 Provider：深拷贝改名（api_key 不回显，需在新副本重新填写）。 */
  const copyProvider = (p: AIProviderInput) => {
    const id = `p${Date.now().toString(36)}`
    const clone: AIProviderInput = {
      ...JSON.parse(JSON.stringify(p)) as AIProviderInput,
      id,
      name: `${p.name}${zh ? '（副本）' : ' (copy)'}`,
      api_key: undefined,
    }
    void save([...editableProviders(), clone])
    onNotice(zh ? `已复制为「${clone.name}」；API Key 不随复制，请编辑副本重新填写` : `Copied as "${clone.name}"; re-enter the API key on the copy`)
  }

  /** 自动识别单行模型（models.dev 目录）：命中自动填类型+能力并提示
   *  「已识别：对话+推理」；未收录/网络失败提示手动选择（静默降级）。 */
  const detectModel = async (idx: number, modelID: string) => {
    const id = modelID.trim()
    if (!id) {
      onError(zh ? '请先填写模型 ID' : 'Enter the model ID first')
      return
    }
    setModelDetecting((prev) => ({ ...prev, [idx]: true }))
    try {
      const r = await lookupAIModel(id, editing?.kind)
      if (r.found && r.kind) {
        const caps: AIModelCapabilities = { kind: r.kind, reasoning: !!r.reasoning, vision: !!r.vision, audio: !!r.audio, video: !!r.video }
        setEditing((prev) => (prev ? { ...prev, models: prev.models.map((m, i) => (i === idx ? { ...m, caps } : m)) } : prev))
        onNotice(zh ? `已识别：${capsSummary(caps, true)}${r.display_name ? `（${r.display_name}）` : ''}` : `Recognized: ${capsSummary(caps, false)}${r.display_name ? ` (${r.display_name})` : ''}`)
      } else {
        onNotice(zh ? `「${id}」未收录，请手动选择类型与能力` : `"${id}" not in the catalog; pick type & capabilities manually`)
      }
    } catch {
      onNotice(zh ? `「${id}」未收录，请手动选择类型与能力` : `"${id}" not recognized; pick type & capabilities manually`)
    } finally {
      setModelDetecting((prev) => ({ ...prev, [idx]: false }))
    }
  }

  /** 粘贴模型 ID 回车添加：加入列表后立即自动识别一次。 */
  const addModelWithDetect = async () => {
    if (!editing) return
    const id = newModelInput.trim()
    if (!id) return
    if (editing.models.some((m) => m.id.trim() === id)) {
      onError(zh ? `模型 ${id} 已存在` : `Model ${id} already exists`)
      return
    }
    const idx = editing.models.length
    setEditing({ ...editing, models: [...editing.models, { id, label: '', caps: emptyCaps() }] })
    setNewModelInput('')
    await detectModel(idx, id)
  }

  const applyEdit = async () => {
    if (!editing) return
    if (!editing.id.trim() || !editing.name.trim()) {
      onError(zh ? 'ID 与名称必填' : 'ID and name are required')
      return
    }
    if (editing.kind !== 'mock' && !editing.base_url.trim()) {
      onError(zh ? '非 Mock 类型须填写 Base URL' : 'Base URL is required for non-mock providers')
      return
    }
    const models: AIModelItem[] = editing.models
      .filter((m) => m.id.trim())
      .map((m) => ({ id: m.id.trim(), label: m.label.trim() || undefined, capabilities: { ...m.caps } }))
    if (editing.kind !== 'mock' && models.length === 0) {
      onError(zh ? '至少添加一个模型（含 ID 与能力勾选）' : 'At least one model is required')
      return
    }
    const next = editableProviders().filter((p) => p.id !== editing.id)
    const primary = models.find((m) => (m.capabilities.kind ?? 'chat') === 'chat')?.id ?? models[0]?.id ?? ''
    const entry: AIProviderInput = {
      id: editing.id.trim(),
      name: editing.name.trim(),
      kind: editing.kind,
      base_url: editing.base_url.trim(),
      model: primary,
      models,
      enabled: editing.enabled,
      requests_per_min: editing.requestsPerMin,
      daily_quota: editing.dailyQuota,
    }
    // api_key 仅在用户填写时携带（留空 = 服务端保持现值，只写不读）。
    if (editing.api_key.trim()) entry.api_key = editing.api_key.trim()
    next.push(entry)
    if (editing.isNew && !defaultProvider) setDefaultProvider(editing.id.trim())
    setEditing(null)
    await save(next)
  }

  // ---- 平台人设（独立 PUT /admin/settings/ai/personas 整块读替）----

  /** 保存人设编辑（整块 PUT；新建时前端校验 id 唯一）。 */
  const applyPersonaEdit = async () => {
    if (!personaEditing) return
    const id = personaEditing.id.trim()
    if (!id || !personaEditing.name.trim()) {
      onError(zh ? 'ID 与名称必填' : 'ID and name are required')
      return
    }
    if (personaEditing.isNew && personas.some((p) => p.id === id)) {
      onError(zh ? 'ID 已存在，请换一个' : 'ID already exists; pick another')
      return
    }
    const entry: AIPersonaDef = { id, name: personaEditing.name.trim(), system_prompt: personaEditing.system_prompt }
    try {
      const saved = await putAIPersonas([...personas.filter((p) => p.id !== id), entry])
      setPersonas(saved)
      setPersonaEditing(null)
      onNotice(zh ? '平台人设已保存' : 'Platform personas saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 删除人设（过滤后整块 PUT）。 */
  const removePersona = async (id: string) => {
    try {
      setPersonas(await putAIPersonas(personas.filter((p) => p.id !== id)))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  // ---- 平台规则（独立 PUT /admin/settings/ai/rules；与个人规则叠加注入）----

  /** 保存平台规则（显式空串 = 清空）。 */
  const saveRules = async () => {
    if (rulesSaving) return
    setRulesSaving(true)
    try {
      setRules(await adminPutAIRules(rules))
      onNotice(zh ? '平台规则已保存' : 'Platform rules saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    } finally {
      setRulesSaving(false)
    }
  }

  // ---- 技能模板（独立 PUT /admin/settings/ai/skills 整块读替）----

  /** 保存技能编辑（整块 PUT；新建时前端校验 id 唯一）。 */
  const applySkillEdit = async () => {
    if (!skillEditing) return
    const id = skillEditing.id.trim()
    if (!id || !skillEditing.name.trim() || !skillEditing.prompt.trim()) {
      onError(zh ? 'ID、名称与 Prompt 必填' : 'ID, name and prompt are required')
      return
    }
    if (skillEditing.isNew && skills.some((s) => s.id === id)) {
      onError(zh ? 'ID 已存在，请换一个' : 'ID already exists; pick another')
      return
    }
    const entry: AISkillDef = {
      id,
      name: skillEditing.name.trim(),
      description: skillEditing.description.trim() || undefined,
      prompt: skillEditing.prompt,
      enabled: skillEditing.enabled,
    }
    try {
      const saved = await putAISkills([...skills.filter((s) => s.id !== id), entry])
      setSkills(saved)
      setSkillEditing(null)
      onNotice(zh ? '技能模板已保存' : 'Skill templates saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 删除技能（过滤后整块 PUT）。 */
  const removeSkill = async (id: string) => {
    try {
      setSkills(await putAISkills(skills.filter((s) => s.id !== id)))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 技能启用开关（整块 PUT 原地替换该条）。 */
  const toggleSkill = async (id: string, enabled: boolean) => {
    try {
      setSkills(await putAISkills(skills.map((s) => (s.id === id ? { ...s, enabled } : s))))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  // ---- 对话技能（Cherry Studio 式 Skills；独立 PUT /admin/settings/ai/chat-skills 整块读替）----

  /** 保存对话技能编辑（整块 PUT；新建时前端校验 id 唯一）。 */
  const applyChatSkillEdit = async () => {
    if (!chatSkillEditing) return
    const id = chatSkillEditing.id.trim()
    if (!id || !chatSkillEditing.name.trim() || !chatSkillEditing.content.trim()) {
      onError(zh ? 'ID、名称与内容必填' : 'ID, name and content are required')
      return
    }
    if (chatSkillEditing.isNew && chatSkills.some((s) => s.id === id)) {
      onError(zh ? 'ID 已存在，请换一个' : 'ID already exists; pick another')
      return
    }
    const entry: AIChatSkillDef = {
      id,
      name: chatSkillEditing.name.trim(),
      description: chatSkillEditing.description.trim() || undefined,
      icon: chatSkillEditing.icon.trim() || undefined,
      content: chatSkillEditing.content,
      enabled: chatSkillEditing.enabled,
    }
    try {
      const saved = await adminPutAIChatSkills([...chatSkills.filter((s) => s.id !== id), entry])
      setChatSkills(saved)
      setChatSkillEditing(null)
      onNotice(zh ? '对话技能已保存' : 'Chat skills saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 删除对话技能（过滤后整块 PUT）。 */
  const removeChatSkill = async (id: string) => {
    try {
      setChatSkills(await adminPutAIChatSkills(chatSkills.filter((s) => s.id !== id)))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 对话技能启用开关（整块 PUT 原地替换该条）。 */
  const toggleChatSkill = async (id: string, enabled: boolean) => {
    try {
      setChatSkills(await adminPutAIChatSkills(chatSkills.map((s) => (s.id === id ? { ...s, enabled } : s))))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  // ---- Agent 技能包（I 批次：独立 PUT /admin/settings/ai/agent-packages 整块读替）----

  /** 保存技能包编辑（整块 PUT；新建时前端校验 id 唯一、拒收 builtin- 前缀）。 */
  const applyPackageEdit = async () => {
    if (!pkgEditing) return
    const id = pkgEditing.id.trim()
    if (!id || !pkgEditing.name.trim()) {
      onError(zh ? 'ID 与名称必填' : 'ID and name are required')
      return
    }
    if (id.startsWith('builtin-')) {
      onError(zh ? 'builtin- 前缀保留给编译期内置包，平台包不可使用' : 'The builtin- prefix is reserved for compiled-in packages')
      return
    }
    if (pkgEditing.isNew && agentPackages.some((p) => p.id === id)) {
      onError(zh ? 'ID 已存在，请换一个' : 'ID already exists; pick another')
      return
    }
    if (pkgEditing.version < 0) {
      onError(zh ? '版本号须 ≥0' : 'Version must be ≥ 0')
      return
    }
    const changelog = pkgEditing.changelog
      .filter((e) => e.note.trim())
      .map((e) => {
        const entry: { version: number; date?: string; note: string } = { version: e.version, note: e.note.trim() }
        if (e.date.trim()) entry.date = e.date.trim()
        return entry
      })
    const entry: AIAgentPackageDef = {
      id,
      name: pkgEditing.name.trim(),
      description: pkgEditing.description.trim() || undefined,
      system_extra: pkgEditing.system_extra,
      tools: pkgEditing.tools.length > 0 ? pkgEditing.tools : undefined,
      kinds: pkgEditing.kinds.length > 0 ? pkgEditing.kinds : undefined,
      version: pkgEditing.version || undefined,
      changelog: changelog.length > 0 ? changelog : undefined,
    }
    try {
      const saved = await putAIAgentPackages([...agentPackages.filter((p) => p.id !== id), entry])
      setAgentPackages(saved)
      setPkgEditing(null)
      onNotice(zh ? 'Agent 技能包已保存' : 'Agent packages saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 删除技能包（过滤后整块 PUT）。 */
  const removePackage = async (id: string) => {
    try {
      setAgentPackages(await putAIAgentPackages(agentPackages.filter((p) => p.id !== id)))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 导出技能包（触发浏览器下载 docdyne-agent-packages.{json|yaml}）。 */
  const exportPackages = async (format: 'json' | 'yaml', scope: 'platform' | 'builtin' | 'all') => {
    if (pkgExporting) return
    setPkgExporting(true)
    try {
      const text = await exportAIAgentPackages(format, scope)
      const blob = new Blob([text], { type: format === 'yaml' ? 'text/yaml' : 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `docdyne-agent-packages.${format}`
      a.click()
      URL.revokeObjectURL(url)
      onNotice(zh ? '已导出技能包文件' : 'Agent packages exported')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'loadFailed'))
    } finally {
      setPkgExporting(false)
    }
  }

  /** 导入技能包（upsert 按 id 合并 / replace 整块替换；结果含拒收明细）。 */
  const applyPackageImport = async () => {
    if (!pkgImport || pkgImporting) return
    if (!pkgImport.content.trim()) {
      onError(zh ? '请粘贴导出的 JSON/YAML 内容' : 'Paste the exported JSON/YAML content')
      return
    }
    setPkgImporting(true)
    try {
      const res = await importAIAgentPackages(pkgImport.format, pkgImport.content, pkgImport.mode)
      setAgentPackages(res.packages ?? [])
      setPkgImport(null)
      const skipped = res.skipped?.length ?? 0
      onNotice(zh
        ? `导入完成：新增 ${res.imported}、更新 ${res.updated}${skipped > 0 ? `、跳过 ${skipped} 条（内置包不可覆盖）` : ''}`
        : `Imported: ${res.imported} new, ${res.updated} updated${skipped > 0 ? `, ${skipped} skipped (builtin packages are read-only)` : ''}`)
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    } finally {
      setPkgImporting(false)
    }
  }

  // ---- MCP 工具服务（独立 PUT /admin/settings/ai/mcp 整块读替，≤8 条）----

  /** 现有列表（排除编辑中 id）→ PUT 载荷（auth_header 缺省 = 保持现值；
   *  已配置认证头按「键 + 空值」透传 = 继承现值，描述/超时/禁用工具回传）。 */
  const mcpPayload = (excludeID: string): AIMCPInput[] =>
    mcpServices
      .filter((s) => s.id !== excludeID)
      .map((s) => {
        const e: AIMCPInput = { id: s.id, name: s.name, description: s.description, url: s.url, enabled: s.enabled }
        const keys = s.auth_headers ?? []
        if (keys.length > 0) e.headers = Object.fromEntries(keys.map((k) => [k, '']))
        if (s.timeout_sec) e.timeout_sec = s.timeout_sec
        if (s.disabled_tools && s.disabled_tools.length > 0) e.disabled_tools = s.disabled_tools
        return e
      })

  /** 保存 MCP 服务编辑（整块 PUT；新建时前端校验 id 唯一）。 */
  const applyMCPEdit = async () => {
    if (!mcpEditing || mcpSaving) return
    const id = mcpEditing.id.trim()
    if (!id || !mcpEditing.name.trim() || !mcpEditing.url.trim()) {
      onError(zh ? 'ID、名称与 URL 必填' : 'ID, name and URL are required')
      return
    }
    if (mcpEditing.isNew && mcpServices.some((s) => s.id === id)) {
      onError(zh ? 'ID 已存在，请换一个' : 'ID already exists; pick another')
      return
    }
    const entry: AIMCPInput = {
      id,
      name: mcpEditing.name.trim(),
      description: mcpEditing.description.trim() || undefined,
      url: mcpEditing.url.trim(),
      enabled: mcpEditing.enabled,
    }
    // auth_header 仅在填写时携带（留空 = 服务端保持现值，只写不读）。
    if (mcpEditing.auth_header.trim()) entry.auth_header = mcpEditing.auth_header.trim()
    // 认证头：键非空的行生效，值可为空串（= 继承该键已配置值）。
    const headers: Record<string, string> = {}
    for (const h of mcpEditing.headersDraft) {
      const k = h.key.trim()
      if (k) headers[k] = h.value.trim()
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    if (mcpEditing.timeoutSec > 0) entry.timeout_sec = mcpEditing.timeoutSec
    if (mcpEditing.disabledTools.length > 0) entry.disabled_tools = [...mcpEditing.disabledTools]
    const next = [...mcpPayload(id), entry]
    if (next.length > 8) {
      onError(zh ? `最多 8 个 MCP 服务（当前 ${next.length} 条）` : 'At most 8 MCP services')
      return
    }
    setMcpSaving(true)
    try {
      setMcpServices(await putAIMCPAdmin(next))
      setMcpEditing(null)
      onNotice(zh ? 'MCP 工具服务已保存' : 'MCP tool services saved')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    } finally {
      setMcpSaving(false)
    }
  }

  /** 删除 MCP 服务（过滤后整块 PUT）。 */
  const removeMCP = async (id: string) => {
    try {
      setMcpServices(await putAIMCPAdmin(mcpPayload(id)))
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    }
  }

  /** 行级测试：以已保存的 url 测试（不带 auth_header——密钥不回显）。 */
  const runMCPTest = async (s: AIMCPAdminView) => {
    setMcpTests((prev) => ({ ...prev, [s.id]: { running: true, message: t(locale, 'adminAITesting') } }))
    try {
      const r = await testAIMCP(s.url)
      setMcpTests((prev) => ({ ...prev, [s.id]: mcpTestState(r, zh) }))
    } catch (err) {
      setMcpTests((prev) => ({ ...prev, [s.id]: { running: false, ok: false, message: err instanceof Error ? err.message : t(locale, 'adminAITestFailed') } }))
    }
  }

  /** 编辑弹窗内测试：以表单当前草稿 url/auth_header/认证头/超时测试（未保存
   *  修改可直接验证；认证头仅携带已填值的行——空值行测试时跳过）。 */
  const runMCPModalTest = async () => {
    if (!mcpEditing) return
    const url = mcpEditing.url.trim()
    if (!url) {
      onError(zh ? '请先填写 URL' : 'URL is required')
      return
    }
    setMcpModalTest({ running: true, message: t(locale, 'adminAITesting') })
    try {
      const draftHeaders: Record<string, string> = {}
      for (const h of mcpEditing.headersDraft) {
        const k = h.key.trim()
        if (k && h.value.trim()) draftHeaders[k] = h.value.trim()
      }
      const r = await testAIMCP(
        url,
        mcpEditing.auth_header.trim() || undefined,
        Object.keys(draftHeaders).length > 0 ? draftHeaders : undefined,
        mcpEditing.timeoutSec > 0 ? mcpEditing.timeoutSec : undefined,
      )
      setMcpModalTest(mcpTestState(r, zh))
    } catch (err) {
      setMcpModalTest({ running: false, ok: false, message: err instanceof Error ? err.message : t(locale, 'adminAITestFailed') })
    }
  }

  /** 导出 MCP 服务为 mcpServers JSON 文件（docdyne-mcp-servers.json；密钥不导出）。 */
  const exportMCP = async () => {
    if (mcpExporting) return
    setMcpExporting(true)
    try {
      const text = await exportAIMCP()
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'docdyne-mcp-servers.json'
      a.click()
      URL.revokeObjectURL(url)
      onNotice(zh ? '已导出 MCP 服务文件' : 'MCP services exported')
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'loadFailed'))
    } finally {
      setMcpExporting(false)
    }
  }

  /** 导入 mcpServers JSON（粘贴内容；stdio 条目后端跳过并说明原因）。 */
  const applyMCPImport = async () => {
    if (!mcpImport || mcpImporting) return
    if (!mcpImport.content.trim()) {
      onError(zh ? '请粘贴 {"mcpServers":{…}} JSON 内容' : 'Paste the {"mcpServers":{…}} JSON content')
      return
    }
    setMcpImporting(true)
    try {
      const res = await importAIMCP(mcpImport.content)
      setMcpServices(res.services ?? [])
      setMcpImport(null)
      const skipped = res.skipped ?? []
      const skippedNote = skipped.length > 0
        ? (zh
          ? `；跳过 ${skipped.length} 条（${skipped.map((x) => `${x.name}：${x.reason}`).join('、')}）`
          : `; ${skipped.length} skipped (${skipped.map((x) => `${x.name}: ${x.reason}`).join(', ')})`)
        : ''
      onNotice(zh ? `导入 ${res.imported} 新增 / ${res.updated} 更新${skippedNote}` : `Imported ${res.imported} new / ${res.updated} updated${skippedNote}`)
    } catch (err) {
      onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
    } finally {
      setMcpImporting(false)
    }
  }

  /** 重建向量索引：确认后 POST /admin/settings/ai/reindex（全文件重投索引任务）。 */
  const confirmReindex = () => {
    modal.confirm({
      title: zh ? '重建向量索引' : 'Rebuild vector index',
      content: zh
        ? '切换 Embedding 模型后需重建向量索引；将把全部文件重新入队构建索引，文件较多时耗时较长，可在后台进行。'
        : 'After switching the embedding model the vector index must be rebuilt: all files will be re-queued for indexing. This may take a while with many files and can run in the background.',
      okText: zh ? '重建' : 'Rebuild',
      cancelText: t(locale, 'cancel'),
      onOk: async () => {
        setReindexing(true)
        try {
          const r = await reindexAIRAG()
          onNotice(zh ? `已入队 ${r.queued} 个文件` : `${r.queued} files queued`)
        } catch (err) {
          onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
        } finally {
          setReindexing(false)
        }
      },
    })
  }

  /** 重建会话向量索引（vector 档：全量会话消息重新向量化；未就绪时后端 400）。 */
  const confirmHistoryReindex = () => {
    modal.confirm({
      title: zh ? '重建会话向量索引' : 'Rebuild conversation vector index',
      content: zh
        ? '将全部会话消息重新向量化（vector 模式需配置 Qdrant 与真实 embedding 模型）；会话较多时耗时较长，可在后台进行。'
        : 'All conversation messages will be re-vectorized (vector mode requires Qdrant and a real embedding model); this may take a while with many conversations and can run in the background.',
      okText: zh ? '重建' : 'Rebuild',
      cancelText: t(locale, 'cancel'),
      onOk: async () => {
        setHistoryReindexing(true)
        try {
          const r = await reindexAIHistoryVector()
          onNotice(zh ? `重建了 ${r.conversations} 个会话 / ${r.messages} 条消息` : `Rebuilt ${r.conversations} conversations / ${r.messages} messages`)
        } catch (err) {
          onError(err instanceof Error ? err.message : t(locale, 'saveFailed'))
        } finally {
          setHistoryReindexing(false)
        }
      },
    })
  }

  const runTest = async (id: string) => {
    setTests((prev) => ({ ...prev, [id]: { running: true, message: t(locale, 'adminAITesting') } }))
    try {
      const r = await testAIProvider(id)
      setTests((prev) => ({
        ...prev,
        [id]: r.ok
          ? { running: false, ok: true, message: t(locale, 'adminAITestOk').replace('{ms}', String(r.latency_ms ?? 0)) }
          : { running: false, ok: false, message: `${t(locale, 'adminAITestFailed')}：${r.error ?? ''}` },
      }))
    } catch (err) {
      setTests((prev) => ({ ...prev, [id]: { running: false, ok: false, message: err instanceof Error ? err.message : t(locale, 'adminAITestFailed') } }))
    }
  }

  const kindLabel = (kind: string): string => KIND_PRESETS[kind]?.label.split('（')[0] ?? kind

  /** 场景/能力模型下拉选项：类型按 kind 互斥筛选（对话/向量/重排场景）；
   *  vision（图片 OCR）为能力勾选——kind=chat 且勾选视觉能力的模型。 */
  const capabilityOptions = (cap: 'chat' | 'embedding' | 'rerank' | 'vision') => {
    const out: { value: string; label: string }[] = []
    for (const p of data?.providers ?? []) {
      if (!p.enabled) continue
      for (const m of p.models ?? []) {
        const nc = normalizeCaps(m.capabilities)
        if (cap === 'vision' ? nc.vision : nc.kind === cap) out.push({ value: `${p.id}::${m.id}`, label: `${p.name} / ${m.label || m.id}` })
      }
    }
    return out
  }

  const scenarioValue = (scenario: string): string | undefined => {
    const ref = defaultModels[scenario]
    return ref ? `${ref.provider_id}::${ref.model_id}` : undefined
  }

  if (loading) return <div className="hint">{t(locale, 'loading')}</div>

  const envProvider = (data?.providers ?? []).find((p) => p.is_env)

  // RAG embedding/rerank 下拉当前值（旧值 openai_compatible 或 Provider ID）。
  // Mock Provider 为内置演示，不出现在 embedding/rerank 可选项（用户反馈）。
  const mockProviderIds = new Set((data?.providers ?? []).filter((p) => p.kind === 'mock').map((p) => p.id))
  const dropMock = (opts: { value: string; label: string }[]) => opts.filter((o) => !mockProviderIds.has(o.value.split('::')[0]))
  const embeddingValue = rag.embedding_provider === 'mock' ? '' : rag.embedding_provider && rag.embedding_model ? `${rag.embedding_provider}::${rag.embedding_model}` : ''
  const embeddingOptions = dropMock(capabilityOptions('embedding'))
  if (rag.embedding_provider === 'mock' || (!rag.embedding_provider && !embeddingOptions.length)) {
    // 未配置（含旧 mock 默认）：给「未配置」占位而非把 Mock 列为可选项。
    embeddingOptions.unshift({ value: '', label: zh ? '未配置（请先在 Provider 中勾选向量能力模型）' : 'Not configured' })
  } else if (embeddingValue && !embeddingOptions.some((o) => o.value === embeddingValue)) {
    // 旧配置值（如 openai_compatible）：保留展示，不丢数据。
    embeddingOptions.push({ value: embeddingValue, label: `${rag.embedding_provider} / ${rag.embedding_model}（旧配置）` })
  }
  const rerankValue = rag.rerank_provider && rag.rerank_model ? `${rag.rerank_provider}::${rag.rerank_model}` : ''
  const rerankOptions = dropMock(capabilityOptions('rerank'))

  return (
    <div className="ai-admin-panel ai-settings-surface">
      {readOnly && <div className="hint" style={{ marginBottom: 12 }}>当前账号无管理员权限。以下为 AI 服务状态与可用模型；全局 Provider、RAG 与限流配置仅管理员可编辑。</div>}
      <Tabs
        className="ai-admin-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[{
          key: 'providers',
          label: zh ? '提供商' : 'Providers',
          children: (
            <div className="ai-tab-section">
              <SettingsSection
                title={t(locale, 'adminAIProviders')}
                desc={t(locale, 'adminAIMockHint')}
                extra={!readOnly && (
                  <Button size="small" type="primary" onClick={() => setEditing({
                    id: `p${Date.now().toString(36)}`, name: '', kind: 'openai_compatible',
                    base_url: KIND_PRESETS.openai_compatible.baseURL, api_key: '',
                    models: [{ id: KIND_PRESETS.openai_compatible.model, label: '', caps: emptyCaps() }],
                    enabled: true, requestsPerMin: 0, dailyQuota: 0, isNew: true,
                  })}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{t(locale, 'adminAINew')}</span>
                  </Button>
                )}
              >
        <div className="ai-provider-list">
          {envProvider && (
            <div className="ai-provider-card" key="env">
              <div className="ai-provider-main">
                <div className="ai-provider-name">{envProvider.name} <Tag>{t(locale, 'adminAIEnvProvider')}</Tag>{envProvider.id === data?.default_provider && <Tag color="blue">{t(locale, 'adminAIDefault')}</Tag>}</div>
                <div className="muted">{envProvider.base_url} · {(envProvider.models ?? []).map((m) => m.id).join('、') || envProvider.model} · {envProvider.api_key_configured ? t(locale, 'adminAIKeyConfigured') : t(locale, 'adminAIKeyNotConfigured')}</div>
              </div>
            </div>
          )}
          {(data?.providers ?? []).filter((p) => !p.is_env).length === 0 && !envProvider && (
            <div className="empty">{zh ? '尚无 Provider，点击右上角新建。' : 'No providers yet; create one.'}</div>
          )}
          {(data?.providers ?? []).filter((p) => !p.is_env).map((p: AIProviderView) => (
            <div className="ai-provider-card" key={p.id}>
              <div className="ai-provider-main">
                <div className="ai-provider-name">
                  {p.name}
                  {p.id === data?.default_provider && <Tag color="blue">{t(locale, 'adminAIDefault')}</Tag>}
                  <Tag color={p.enabled ? 'green' : 'default'}>{p.enabled ? t(locale, 'adminAIEnabled') : (zh ? '停用' : 'Disabled')}</Tag>
                  <Tag>{kindLabel(p.kind)}</Tag>
                  {(p.requests_per_min > 0 || p.daily_quota > 0) && <Tag color="orange">{zh ? '限流' : 'Limited'}{p.requests_per_min > 0 ? ` ${p.requests_per_min}/min` : ''}{p.daily_quota > 0 ? `${zh ? ' 日' : '/day '}${p.daily_quota}` : ''}</Tag>}
                </div>
                <div className="muted">
                  {p.id} · {p.base_url || '—'} · {t(locale, 'adminAIAPIKey')}：{p.api_key_configured ? t(locale, 'adminAIKeyConfigured') : t(locale, 'adminAIKeyNotConfigured')}
                </div>
                <div className="muted">
                  {(p.models ?? []).map((m) => {
                    const nc = normalizeCaps(m.capabilities)
                    return (
                      <Tag key={m.id} style={{ marginTop: 4 }} color={nc.kind === 'chat' ? undefined : 'geekblue'}>
                        {m.label || m.id}
                        {` ${kindText(nc.kind, zh)}`}
                        {CAPABILITY_FIELDS.filter((c) => nc[c.key]).map((c) => `+${zh ? c.zh : c.en}`).join('')}
                      </Tag>
                    )
                  })}
                </div>
                {tests[p.id] && <div className={`ai-test-result ${tests[p.id].ok ? 'ok-text' : 'error-text'}`}>{tests[p.id].message}</div>}
              </div>
              <div className="ai-provider-actions">
                <Tooltip title={t(locale, 'adminAITest')}>
                  <Button size="small" loading={tests[p.id]?.running} onClick={() => void runTest(p.id)}>
                    <Zap size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Tooltip>
                {!readOnly && <Tooltip title={zh ? '复制 Provider（深拷贝改名，API Key 需重填）' : 'Duplicate provider (API key not copied)'}>
                  <Button size="small" onClick={() => copyProvider(editableProviders().find((x) => x.id === p.id) ?? { id: p.id, name: p.name, kind: p.kind, enabled: p.enabled })}>
                    <Copy size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Tooltip>}
                {!readOnly && <Tooltip title={t(locale, 'adminAIEdit')}>
                  <Button size="small" onClick={() => setEditing(formFromView(p))}>
                    <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Tooltip>}
                {!readOnly && <Tooltip title={t(locale, 'adminAIDelete')}>
                  <Button size="small" danger onClick={() => removeProvider(p.id)}>
                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Tooltip>}
              </div>
            </div>
          ))}
        </div>
              </SettingsSection>
            </div>
          )}, {
          key: 'defaults',
          label: zh ? '默认项与限流' : 'Defaults & limits',
          children: (
            <div className="ai-tab-section">
        {/* 总开关（ai.enabled）：关闭 = 全站隐藏 AI 入口 + 网关 404。 */}
        <div className="ai-master-toggle">
          <label className="ai-rag-toggle">
            <Switch checked={aiEnabled} disabled={readOnly} onChange={(v) => { setAIEnabled(v); void save(undefined, v) }} />
            <span>{zh ? '启用 AI' : 'Enable AI'}</span>
          </label>
          <span className="hint">{zh ? '关闭后全站隐藏 AI 入口，网关端点返回 404（Provider 配置保留）' : 'When off, all AI entries are hidden and gateway endpoints return 404 (providers are kept)'}</span>
        </div>
        <div className="ai-defaults-form">
          <label className="field">
            <span>{t(locale, 'adminAIDefault')}</span>
            <Select
              value={defaultProvider || undefined}
              placeholder={zh ? '选择默认 Provider' : 'Select default provider'}
              disabled={readOnly}
              onChange={(v) => setDefaultProvider(v)}
              options={(data?.providers ?? []).filter((p) => p.enabled).map((p) => ({ value: p.id, label: `${p.name}（${p.id}）` }))}
            />
          </label>
          <label className="field">
            <span>
              {zh ? '默认人设' : 'Default persona'}
              <Tooltip title={zh ? '平台级默认注入的对话人设；「不注入」= 不追加任何 system 人设（用户仍可在对话入口手动切换）。' : 'The platform persona injected into chats by default; "None" appends nothing (users can still pick one manually).'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Select
              value={defaultPersona}
              disabled={readOnly}
              onChange={(v) => setDefaultPersona(v)}
              options={[
                { value: '', label: zh ? '不注入' : 'None' },
                { value: 'builtin-assistant', label: zh ? '内置 · 默认助理' : 'Built-in assistant' },
                ...personas.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </label>
          {SCENARIOS.map((s) => (
            <label className="field" key={s.key}>
              <span>
                {zh ? s.zh : s.en}
                <Tooltip title={s.hint + (s.key !== 'chat' && s.cap === 'chat' ? (zh ? '未选择时回落「对话默认」。' : ' Falls back to the chat default when unset.') : '')}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <Select
                value={scenarioValue(s.key)}
                placeholder={zh ? '未设置（按回落规则）' : 'Not set (fallback applies)'}
                allowClear
                disabled={readOnly}
                onChange={(v) => {
                  const next = { ...defaultModels }
                  if (!v) delete next[s.key]
                  else {
                    const [provider_id, ...rest] = String(v).split('::')
                    next[s.key] = { provider_id, model_id: rest.join('::') }
                  }
                  setDefaultModels(next)
                }}
                options={capabilityOptions(s.cap)}
              />
            </label>
          ))}
          <label className="field">
            <span>
              {zh ? '备选模型链（失败自动切换）' : 'Fallback models (auto switch)'}
              <Tooltip title={zh ? '普通对话首选模型上游失败（且尚未输出任何内容）时，按此顺序自动切换重试；带工具的 Agent 循环不回退（避免重复执行写操作）。最多 5 个。' : 'For plain chats, when the primary model fails upstream before any output, retry through this ordered list. Tool loops never fall back (writes must not repeat). Max 5 entries.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Select
              mode="multiple"
              value={fallbackModels.map((r) => `${r.provider_id}::${r.model_id}`)}
              placeholder={zh ? '未设置（失败即提示）' : 'Not set (fail with a notice)'}
              disabled={readOnly}
              maxCount={5}
              maxTagCount="responsive"
              onChange={(vals: string[]) => {
                setFallbackModels(vals.map((v) => {
                  const [provider_id, ...rest] = v.split('::')
                  return { provider_id, model_id: rest.join('::') }
                }))
              }}
              options={capabilityOptions('chat')}
            />
          </label>
          <label className="field">
            <span>{t(locale, 'adminAITemperature')}（0-2）</span>
            <InputNumber min={0} max={2} step={0.1} value={temperature} disabled={readOnly} onChange={(v) => setTemperature(Number(v ?? 0.3))} />
          </label>
          <label className="field">
            <span>{t(locale, 'adminAIMaxTokens')}</span>
            <InputNumber min={1} max={128000} step={256} value={maxTokens} disabled={readOnly} onChange={(v) => setMaxTokens(Number(v ?? 2048))} />
          </label>
          <label className="field">
            <span>
              {zh ? '全局兜底限流（次/分钟/用户）' : 'Global fallback rate limit (req/min/user)'}
              <Tooltip title={zh ? 'Provider 未单独配置 requests_per_min 时使用的每用户每分钟兜底上限；0 = 默认 20。' : 'Per-user per-minute fallback for providers without their own requests_per_min; 0 = default 20.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber min={0} max={10000} value={perUserPerMin} disabled={readOnly} onChange={(v) => setPerUserPerMin(Number(v ?? 20))} />
          </label>
        </div>
        <div className="modal-actions">
          {!readOnly && <Button type="primary" loading={saving} onClick={() => void save()}>{t(locale, 'adminAISave')}</Button>}
        </div>
            </div>
          )}, {
          key: 'rag',
          label: zh ? '检索增强（RAG）' : 'Retrieval (RAG)',
          children: (
            <div className="ai-tab-section">
        {!aiEnabled && <p className="hint">{zh ? 'AI 已关闭；RAG 配置将保留，启用 AI 后生效。' : 'AI is off; RAG settings are retained until AI is enabled.'}</p>}
        <p className="hint">
          {zh
            ? '文档解析说明：平台内置文本抽取——md/txt/代码/ddrt 等文本类直接读取入索引；docx/pdf 经服务端解析后入索引；图片经「图片 OCR」开启后可提取文字入索引。'
            : 'Parsing: md/txt/code/ddrt are read directly into the index; docx/pdf are parsed server-side before indexing; images can be OCR-ed into the index once "Image OCR" is enabled.'}
        </p>
        <div className="ai-defaults-form">
          <label className="field"><span>{zh ? '模式' : 'Mode'}</span><Select value={rag.mode} disabled={readOnly} options={[{ value: 'keyword', label: zh ? '关键词检索' : 'Keyword' }, { value: 'hybrid', label: zh ? '混合检索（关键词+向量）' : 'Hybrid (keyword+vector)' }]} onChange={(mode) => setRag({ ...rag, mode })} /></label>
          <label className="field">
            <span>
              {zh ? '启用向量' : 'Enable vectors'}
              <Tooltip title={zh ? '开启后使用混合检索（关键词 + 向量）。向量维度无需配置：按所选 embedding 模型返回的维度自动建库（auto）。' : 'Hybrid retrieval (keyword + vector). Vector dimensions are auto-detected from the embedding model output.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Switch checked={rag.vector_enabled} disabled={readOnly} onChange={(vector_enabled) => setRag({ ...rag, vector_enabled })} />
          </label>
          <label className="field">
            <span>
              Qdrant URL
              <Tooltip title={zh ? '向量库服务地址。docker compose --profile ai-vector 启动，默认 http://qdrant:6333（容器网络内）。（修改该地址需重启后端生效）' : 'Vector store address. Started via docker compose --profile ai-vector; defaults to http://qdrant:6333 inside the compose network. (Changing it requires a backend restart to take effect.)'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Input value={rag.qdrant_url} disabled={readOnly} onChange={(e) => setRag({ ...rag, qdrant_url: e.target.value })} />
          </label>
          <label className="field">
            <span>
              {zh ? 'Embedding 模型' : 'Embedding model'}
              <Tooltip title={zh ? '从已配置 Provider 中选择具备「向量」能力的模型（不再是硬编码 OpenAI 兼容）；Mock 为内置 8 维演示实现。' : 'Pick an embedding-capable model from configured providers; Mock is the built-in 8-dim demo.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Select
              value={embeddingValue}
              disabled={readOnly}
              onChange={(v) => {
                const [provider_id, ...rest] = v.split('::')
                setRag({ ...rag, embedding_provider: provider_id, embedding_model: rest.join('::') })
              }}
              options={embeddingOptions}
            />
          </label>
          <label className="field">
            <span>
              {zh ? '重排序模型' : 'Rerank model'}
              <Tooltip title={zh ? '从已配置 Provider 中选择具备「重排序」能力的模型，用于混合检索结果重排；不选则不重排。' : 'Pick a rerank-capable model from configured providers to rerank hybrid results; none = no rerank.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Select
              value={rerankValue || undefined}
              allowClear
              placeholder={zh ? '不重排' : 'No rerank'}
              disabled={readOnly}
              onChange={(v) => {
                if (!v) { setRag({ ...rag, rerank_provider: '', rerank_model: '' }); return }
                const [provider_id, ...rest] = v.split('::')
                setRag({ ...rag, rerank_provider: provider_id, rerank_model: rest.join('::') })
              }}
              options={rerankOptions}
            />
          </label>
          <label className="field">
            <span>
              Top K
              <Tooltip title={zh ? '每次提问召回的向量结果条数上限。' : 'Max vector hits recalled per query.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber min={1} max={10} value={rag.top_k} disabled={readOnly} onChange={(v) => setRag({ ...rag, top_k: Number(v ?? 8) })} />
          </label>
          <label className="field">
            <span>
              Chunk size
              <Tooltip title={zh ? '切块长度：文档按该字符数切分后逐块生成向量；越大单块信息越多、检索粒度越粗。' : 'Chunk length in characters for vectorization; larger chunks carry more context but coarser recall.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber min={100} max={10000} value={rag.chunk_size} disabled={readOnly} onChange={(v) => setRag({ ...rag, chunk_size: Number(v ?? 1000) })} />
          </label>
          <label className="field">
            <span>
              Overlap
              <Tooltip title={zh ? '相邻切块的重叠字符数，缓解关键信息被切断；须小于 chunk size。' : 'Character overlap between adjacent chunks; must be smaller than chunk size.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber min={0} max={5000} value={rag.chunk_overlap} disabled={readOnly} onChange={(v) => setRag({ ...rag, chunk_overlap: Number(v ?? 100) })} />
          </label>
        </div>
        <p className="hint">{zh ? '仅 hybrid + 向量开启时连接 Qdrant；检索始终限制在关键词权限结果内。保存后生效（向量连接测试按已保存配置执行）。' : 'Qdrant is used only for enabled hybrid mode; hits are restricted to keyword-authorized files. Save to apply.'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!readOnly && <Button type="primary" loading={saving} onClick={() => void save()}>{t(locale, 'adminAISave')}</Button>}
          {/* 重建向量索引：切换 Embedding 模型后重建新向量库（全部文件重投索引任务）。 */}
          {!readOnly && (
            <Button loading={reindexing} onClick={confirmReindex}>
              {zh ? '重建向量索引' : 'Rebuild vector index'}
            </Button>
          )}
          <Button disabled={readOnly} loading={ragTest?.running} onClick={async () => {
            setRagTest({ running: true, message: zh ? '测试中…' : 'Testing…' })
            try { const r = await testAIRAG(); setRagTest({ running: false, ok: r.ok, message: r.ok ? (r.message ?? 'OK') : (r.error ?? 'Failed') }) }
            catch (err) { setRagTest({ running: false, ok: false, message: err instanceof Error ? err.message : 'Failed' }) }
          }}>{zh ? '测试向量连接（已保存配置）' : 'Test vector connection (saved settings)'}</Button>
        </div>
        {ragTest && <div className={ragTest.ok ? 'ok-text' : 'error-text'}>{ragTest.message}</div>}
            </div>
          )}, {
          key: 'ocr',
          label: zh ? '图片 OCR' : 'Image OCR',
          children: (
            <div className="ai-tab-section">
        {/* 图片 OCR：仅当对话模型不支持图片时，用视觉模型把图片转文字兜底；
            另用于图片文件建索引（提取文字入全文/向量索引）。 */}
        {!aiEnabled && <p className="hint">{zh ? 'AI 已关闭；OCR 配置将保留，启用 AI 后生效。' : 'AI is off; OCR settings are retained until AI is enabled.'}</p>}
        <p className="hint">
          {zh
            ? '图片输入的处理规则：对话模型勾选「视觉」能力时，图片直接发给模型（不走 OCR）；仅当模型不支持图片时，才用下方配置的视觉模型把图片转文字兜底（另用于图片文件建索引）。'
            : 'How image inputs are handled: when the chat model has the "vision" capability checked, images go straight to the model (no OCR); only when the model cannot take images does the vision model configured below convert them to text as a fallback (also used to index image files).'}
        </p>
        <div className="ai-defaults-form">
          <label className="field">
            <span>{zh ? '启用' : 'Enable'}</span>
            <Switch checked={ocr.enabled} disabled={readOnly} onChange={(enabled) => setOcr({ ...ocr, enabled })} />
          </label>
          <label className="field">
            <span>
              {zh ? 'OCR 模型' : 'OCR model'}
              <Tooltip title={zh ? '从已配置 Provider 中选择具备「视觉图片」能力的模型。' : 'Pick a vision-capable model from configured providers.'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <Select
              value={ocr.provider_id && ocr.model_id ? `${ocr.provider_id}::${ocr.model_id}` : undefined}
              allowClear
              placeholder={zh ? '未配置' : 'Not configured'}
              disabled={readOnly}
              onChange={(v) => {
                if (!v) { setOcr({ ...ocr, provider_id: '', model_id: '' }); return }
                const [provider_id, ...rest] = String(v).split('::')
                setOcr({ ...ocr, provider_id, model_id: rest.join('::') })
              }}
              options={capabilityOptions('vision')}
            />
          </label>
          <label className="field">
            <span>
              {zh ? '单图大小上限' : 'Max image size'}
              <Tooltip title={zh ? '超过该大小的图片不做 OCR 提取（1-32 MB）。' : 'Images larger than this are not OCR-ed (1-32 MB).'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber
              min={1}
              max={32}
              step={1}
              addonAfter="MB"
              value={Math.round(ocr.max_image_bytes / 1024 / 1024)}
              disabled={readOnly}
              onChange={(v) => setOcr({ ...ocr, max_image_bytes: Math.max(1, Number(v ?? 8)) * 1024 * 1024 })}
            />
          </label>
        </div>
        <div className="modal-actions">
          {!readOnly && <Button type="primary" loading={saving} onClick={() => void save()}>{t(locale, 'adminAISave')}</Button>}
        </div>
            </div>
          )}, {
          key: 'search',
          label: zh ? '联网搜索' : 'Web search',
          children: (
            <div className="ai-tab-section">
        {/* 联网搜索：对话 web_search 增强（SearXNG / Tavily / DuckDuckGo / Bing；随 ai 主设置保存）。 */}
        {!aiEnabled && <p className="hint">{zh ? 'AI 已关闭；联网搜索配置将保留，启用 AI 后生效。' : 'AI is off; web search settings are retained until AI is enabled.'}</p>}
        <p className="hint">
          {zh
            ? '配置后用户对话中的「联网」开关生效：回答前先检索网络并把结果注入上下文，来源经消息的「网络来源」折叠区回显；未配置时该开关静默忽略。'
            : 'Once configured, the chat "Web" toggle takes effect: searches run before answering and sources are shown in the message web-sources section; without a provider the toggle is silently ignored.'}
        </p>
        <p className="hint">{zh ? '模型可在搜索结果中选定链接后，用内置 dd_fetch_url 工具抓取网页全文。' : 'The model can pick links from the search results and fetch the full page content via the built-in dd_fetch_url tool.'}</p>
        <div className="ai-defaults-form">
          <label className="field">
            <span>{zh ? '搜索引擎' : 'Search provider'}</span>
            <Select
              value={search.provider || ''}
              disabled={readOnly}
              onChange={(provider) => setSearch({ ...search, provider })}
              options={[
                { value: '', label: zh ? '未启用（web_search 静默忽略）' : 'Disabled (web_search ignored)' },
                { value: 'searxng', label: zh ? 'SearXNG（自建元搜索）' : 'SearXNG (self-hosted metasearch)' },
                { value: 'tavily', label: 'Tavily API' },
                { value: 'duckduckgo', label: zh ? 'DuckDuckGo（内置免 Key；国内通常需代理）' : 'DuckDuckGo (built-in, free)' },
                { value: 'bing', label: zh ? 'Bing（内置免 Key，国内可直连；非官方接口可能失效）' : 'Bing (built-in, free; unofficial)' },
              ]}
            />
          </label>
          {search.provider === 'searxng' && (
            <label className="field">
              <span>{zh ? 'SearXNG 地址' : 'SearXNG URL'}</span>
              <Input
                value={search.searxng_url}
                disabled={readOnly}
                placeholder="http://searxng:8080"
                onChange={(e) => setSearch({ ...search, searxng_url: e.target.value })}
              />
            </label>
          )}
          {search.provider === 'tavily' && (
            <label className="field">
              <span>
                {zh ? 'Tavily API Key' : 'Tavily API key'}
                {tavilyConfigured && <Tag color="green" style={{ marginLeft: 6 }}>{zh ? '已配置' : 'configured'}</Tag>}
              </span>
              <Input.Password
                value={search.tavily_api_key ?? ''}
                disabled={readOnly}
                placeholder={tavilyConfigured ? (zh ? '已配置（留空 = 保持现值）' : 'Configured (empty = keep)') : 'tvly-…'}
                onChange={(e) => setSearch({ ...search, tavily_api_key: e.target.value })}
              />
            </label>
          )}
          <label className="field">
            <span>{zh ? '出站代理（可选）' : 'Outbound proxy (optional)'}</span>
            <Input
              value={search.proxy_url ?? ''}
              disabled={readOnly}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => setSearch({ ...search, proxy_url: e.target.value })}
            />
            <span className="hint">{zh ? '联网搜索/网页抓取出站代理；留空直连。DuckDuckGo 国内直连通常不可达，需配置代理（也支持环境变量 AI_OUTBOUND_PROXY 兜底）。' : 'Outbound proxy for web search and page fetching; empty = direct connection. DuckDuckGo is usually unreachable from mainland China without a proxy (the AI_OUTBOUND_PROXY env var acts as a fallback).'}</span>
          </label>
          <label className="field">
            <span>
              {zh ? '结果条数上限' : 'Max results'}
              <Tooltip title={zh ? '单次检索注入上下文的最大结果数（1-20）。' : 'Max results injected per search (1-20).'}>
                <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
              </Tooltip>
            </span>
            <InputNumber
              min={1}
              max={20}
              precision={0}
              value={search.max_results}
              disabled={readOnly || !search.provider}
              onChange={(v) => setSearch({ ...search, max_results: Number(v ?? 5) })}
            />
          </label>
        </div>
        <div className="modal-actions">
          {!readOnly && <Button type="primary" loading={saving} onClick={() => void save()}>{t(locale, 'adminAISave')}</Button>}
        </div>
            </div>
          )}, {
          key: 'history',
          label: zh ? '对话历史检索' : 'History search',
          children: (
            <div className="ai-tab-section">
        {/* 对话历史检索（v7.15 A8）：dd_search_history 工具（keyword/vector/off），随 ai 主设置保存。 */}
        {!aiEnabled && <p className="hint">{zh ? 'AI 已关闭；该配置将保留，启用 AI 后生效。' : 'AI is off; this setting is retained until AI is enabled.'}</p>}
        <p className="hint">
          {zh
            ? '控制 AI 对话中的 dd_search_history 工具：开启后模型可跨会话检索历史消息（含被上下文压缩掉的早期内容）；关闭则不注入该工具。检索为关键词子串匹配（中文有效），索引随会话写入自动维护。'
            : 'Controls the dd_search_history tool in AI chats: when on, the model can search conversation history across sessions (including early content compressed out of context); off removes the tool. Keyword substring matching (Chinese-friendly), indexed as conversations are saved.'}
        </p>
        <p className="hint">{zh ? 'vector 模式将会话消息向量化（需配置 Qdrant 与真实 embedding，mock 无效）；不可用时自动降级关键字检索。' : 'Vector mode vectorizes conversation messages (requires Qdrant and a real embedding model; mock does not work) and automatically falls back to keyword search when unavailable.'}</p>
        <div className="ai-defaults-form">
          <label className="field">
            <span>{zh ? '检索模式' : 'Search mode'}</span>
            <Select
              value={historySearch}
              disabled={readOnly}
              onChange={(v) => setHistorySearch(v)}
              options={[
                { value: 'keyword', label: zh ? '关键字检索' : 'Keyword search' },
                { value: 'vector', label: zh ? '向量检索（RAG 语义召回）' : 'Vector (RAG semantic recall)' },
                { value: 'off', label: zh ? '关闭（不注入工具）' : 'Off (tool not injected)' },
              ]}
            />
          </label>
        </div>
        <div className="modal-actions">
          {!readOnly && <Button type="primary" loading={saving} onClick={() => void save()}>{t(locale, 'adminAISave')}</Button>}
          {/* 重建会话向量索引：vector 档全量会话消息重新向量化（未就绪时后端 400）。 */}
          {!readOnly && (
            <Button loading={historyReindexing} onClick={confirmHistoryReindex}>
              {zh ? '重建会话向量索引' : 'Rebuild history vectors'}
            </Button>
          )}
        </div>
            </div>
          )}, {
          key: 'personas',
          label: zh ? '人设与规则' : 'Personas & rules',
          children: (
            <div className="ai-tab-section">
              {/* 平台人设：全员共用的 system 提示模板（独立端点整块读替，不入 putAISettings）。 */}
              <SettingsSection
                title={zh ? '平台人设（系统提示词模板）' : 'Platform personas (system prompt templates)'}
                desc={zh
                  ? '平台统一维护的 system 提示模板，全员在对话入口的人设下拉中选用（个人自备人设在 设置→AI 个人配置）。'
                  : 'Platform-wide system prompt templates; everyone picks them from the persona dropdown at the chat entry (personal personas live in Settings → AI personal config).'}
                extra={!readOnly && (
                  <Button size="small" type="primary" onClick={() => setPersonaEditing({ id: '', name: '', system_prompt: '', isNew: true })}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{t(locale, 'adminAINew')}</span>
                  </Button>
                )}
              >
        <div className="ai-provider-list">
          {personas.length === 0 && <div className="empty">{zh ? '尚无人设，点击右上角新建。' : 'No personas yet; create one.'}</div>}
          {personas.map((p) => (
            <div className="ai-provider-card" key={p.id}>
              <div className="ai-provider-main">
                <div className="ai-provider-name">{p.name}<Tag>{p.id}</Tag></div>
                <div className="muted" title={p.system_prompt}>{p.system_prompt.length > 120 ? `${p.system_prompt.slice(0, 120)}…` : p.system_prompt}</div>
              </div>
              {!readOnly && (
                <div className="ai-provider-actions">
                  <Tooltip title={t(locale, 'adminAIEdit')}>
                    <Button size="small" onClick={() => setPersonaEditing({ id: p.id, name: p.name, system_prompt: p.system_prompt, isNew: false })}>
                      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIDelete')}>
                    <Button size="small" danger onClick={() => void removePersona(p.id)}>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
              </SettingsSection>
              {/* 平台规则：与用户个人规则叠加注入所有对话（独立端点，非覆盖）。 */}
              <SettingsSection
                title={zh ? '平台规则（追加注入所有对话）' : 'Platform rules (appended to every chat)'}
                desc={zh ? '与用户个人规则叠加注入 system 提示（非覆盖）。' : 'Injected into the system prompt on top of personal rules (additive, not overriding).'}
              >
                <Input.TextArea
                  rows={4}
                  maxLength={4000}
                  showCount
                  value={rules}
                  disabled={readOnly}
                  placeholder={zh ? '例：回复保持简洁；代码给完整可运行示例…' : 'e.g. Keep replies concise; give complete runnable code samples…'}
                  onChange={(e) => setRules(e.target.value)}
                />
                {!readOnly && (
                  <div className="modal-actions" style={{ marginTop: 8 }}>
                    <Button type="primary" loading={rulesSaving} onClick={() => void saveRules()}>{zh ? '保存规则' : 'Save rules'}</Button>
                  </div>
                )}
              </SettingsSection>
            </div>
          )}, {
          key: 'quickskills',
          label: zh ? '快捷指令' : 'Quick commands',
          children: (
            <div className="ai-tab-section">
              {/* 技能模板：快捷指令/提示词库（独立端点整块读替）。 */}
              <SettingsSection
                title={zh ? '快捷指令（提示词库）' : 'Quick commands (prompt library)'}
                desc={<>
                  {zh
                    ? '快捷指令模板（Skill），填充对话输入框或编辑器 AI 菜单；prompt 支持占位符 {selection}（编辑器选区）与 {file}（当前文件名）。'
                    : 'Quick command templates (Skills) that fill the chat input or the editor AI menu; prompt supports placeholders {selection} (editor selection) and {file} (current file name).'}
                  <br />
                  {zh
                    ? '选中后把 prompt 填入对话输入框（支持 {selection}/{file} 占位符）。与「对话技能」相区别：技能是整段注入 system 的行为规范。'
                    : 'Selecting one fills its prompt into the chat input (supports {selection}/{file} placeholders). Unlike "chat skills", a skill injects a whole behavior spec into the system prompt.'}
                </>}
                extra={!readOnly && (
                  <Button size="small" type="primary" onClick={() => setSkillEditing({ id: '', name: '', description: '', prompt: '', enabled: true, isNew: true })}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{t(locale, 'adminAINew')}</span>
                  </Button>
                )}
              >
        <div className="ai-provider-list">
          {skills.length === 0 && <div className="empty">{zh ? '尚无技能模板，点击右上角新建。' : 'No skills yet; create one.'}</div>}
          {skills.map((s) => (
            <div className="ai-provider-card" key={s.id}>
              <div className="ai-provider-main">
                <div className="ai-provider-name">
                  {s.name}
                  {s.enabled === false && <Tag>{zh ? '已停用' : 'Disabled'}</Tag>}
                </div>
                {s.description && <div className="muted">{s.description}</div>}
                <div className="muted" title={s.prompt}>{s.prompt.length > 120 ? `${s.prompt.slice(0, 120)}…` : s.prompt}</div>
              </div>
              {!readOnly && (
                <div className="ai-provider-actions">
                  <Tooltip title={s.enabled === false ? (zh ? '启用' : 'Enable') : (zh ? '停用' : 'Disable')}>
                    <Switch size="small" checked={s.enabled !== false} onChange={(v) => void toggleSkill(s.id, v)} />
                  </Tooltip>
                  <Tooltip title={zh ? '复制 Prompt' : 'Copy prompt'}>
                    <Button size="small" onClick={() => { void navigator.clipboard?.writeText(s.prompt); onNotice(zh ? '已复制' : 'Copied') }}>
                      <Copy size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIEdit')}>
                    <Button size="small" onClick={() => setSkillEditing({ id: s.id, name: s.name, description: s.description ?? '', prompt: s.prompt, enabled: s.enabled !== false, isNew: false })}>
                      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIDelete')}>
                    <Button size="small" danger onClick={() => void removeSkill(s.id)}>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
              </SettingsSection>
            </div>
          )}, {
          key: 'chatskills',
          label: zh ? '对话技能' : 'Chat skills',
          children: (
            <div className="ai-tab-section">
              {/* 对话技能（Cherry Studio 式 Skills；独立端点整块读替，≤50 条）。 */}
              <SettingsSection
                title={zh ? '对话技能（Skills）' : 'Chat skills (Skills)'}
                desc={zh
                  ? 'Cherry Studio 式 Skills：用户在对话中选用后，Markdown 内容整段注入该轮 system 提示；平台+个人按 id 增量合并（个人覆盖平台）。内置技能（翻译/润色/总结/头脑风暴）编译期固化，只读。'
                  : 'Cherry Studio-style skills: once picked in a chat, the Markdown content is injected whole into that turn system prompt; platform and personal skills merge by id (personal overrides platform). Built-in skills (translate/polish/summarize/brainstorm) are compiled in and read-only.'}
                extra={!readOnly && (
                  <Button size="small" type="primary" disabled={chatSkills.length >= 50} onClick={() => setChatSkillEditing({ id: '', name: '', icon: '', description: '', content: '', enabled: true, isNew: true })}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{t(locale, 'adminAINew')}</span>
                  </Button>
                )}
              >
        <div className="ai-provider-list">
          {chatSkills.length === 0 && <div className="empty">{zh ? '尚无对话技能，点击右上角新建。' : 'No chat skills yet; create one.'}</div>}
          {chatSkills.map((s) => (
            <div className="ai-provider-card" key={s.id}>
              <div className="ai-provider-main">
                <div className="ai-provider-name">
                  {s.name}
                  <Tag>{s.id}</Tag>
                  {s.icon && <Tag>{s.icon}</Tag>}
                  {s.enabled === false && <Tag>{zh ? '已停用' : 'Disabled'}</Tag>}
                </div>
                {s.description && <div className="muted">{s.description}</div>}
                <div className="muted" title={s.content}>{s.content.length > 120 ? `${s.content.slice(0, 120)}…` : s.content}</div>
              </div>
              {!readOnly && (
                <div className="ai-provider-actions">
                  <Tooltip title={s.enabled === false ? (zh ? '启用' : 'Enable') : (zh ? '停用' : 'Disable')}>
                    <Switch size="small" checked={s.enabled !== false} onChange={(v) => void toggleChatSkill(s.id, v)} />
                  </Tooltip>
                  <Tooltip title={zh ? '复制内容' : 'Copy content'}>
                    <Button size="small" onClick={() => { void navigator.clipboard?.writeText(s.content); onNotice(zh ? '已复制' : 'Copied') }}>
                      <Copy size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIEdit')}>
                    <Button size="small" onClick={() => setChatSkillEditing({ id: s.id, name: s.name, icon: s.icon ?? '', description: s.description ?? '', content: s.content, enabled: s.enabled !== false, isNew: false })}>
                      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIDelete')}>
                    <Button size="small" danger onClick={() => void removeChatSkill(s.id)}>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
              </SettingsSection>
            </div>
          )}, {
          key: 'agentpackages',
          label: zh ? '编辑器 Agent 包' : 'Editor agent packages',
          children: (
            <div className="ai-tab-section">
              {/* Agent 技能包：编辑页 Agent 循环的包级增强（I 批次：版本/变更日志 + 导入导出 + 使用统计）。 */}
              <SettingsSection
                title={zh ? '编辑器 Agent 包' : 'Editor agent packages'}
                desc={<>
                  {zh
                    ? '为 Monaco/白板/富文本等编辑器的 AI Agent 提供系统规范与工具白名单；编辑页 AI 面板下拉选用。内置包（Excel 报表专家/图表架构师/文档审校）编译期固化只读，此处管理平台自定义包。'
                    : 'System specs and tool allowlists for AI agents in the Monaco/whiteboard/rich-text editors; picked from the editor AI panel dropdown. Built-in packages (Excel report expert / chart architect / document reviewer) are compiled in and read-only; manage custom platform packages here.'}
                  <br />
                  {zh
                    ? '编辑页 AI 面板「技能包」下拉的数据源（内置包编译期固化，不在此列）。包 = system 附加段 + 工具白名单 + 适用文档类型；选中后注入 Agent 提示。使用次数来自 ai.chat 审计（携带包的对话），受审计保留期约束。'
                    : 'Source of the "package" dropdown in the editor AI panel (builtin packages are compiled in and not listed). A package = system add-on + tool allowlist + applicable doc kinds; it is injected into the agent prompt once selected. Usage counts come from ai.chat audit rows (chats carrying a package) within the audit retention window.'}
                </>}
                extra={!readOnly && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'platform-json', label: zh ? '平台包 · JSON' : 'Platform · JSON' },
                { key: 'platform-yaml', label: zh ? '平台包 · YAML' : 'Platform · YAML' },
                { type: 'divider' as const },
                { key: 'builtin-json', label: zh ? '内置包 · JSON' : 'Builtin · JSON' },
                { key: 'all-json', label: zh ? '全部（平台 + 内置）· JSON' : 'All (platform + builtin) · JSON' },
              ],
              onClick: ({ key }) => {
                const [scope, format] = key.split('-')
                void exportPackages(format as 'json' | 'yaml', scope as 'platform' | 'builtin' | 'all')
              },
            }}
          >
            <Button size="small" loading={pkgExporting}>
              <Download size={13} strokeWidth={2} aria-hidden="true" />
              <span>{zh ? '导出' : 'Export'}</span>
            </Button>
          </Dropdown>
          <Button size="small" onClick={() => setPkgImport({ format: 'json', content: '', mode: 'upsert' })}>
            <Upload size={13} strokeWidth={2} aria-hidden="true" />
            <span>{zh ? '导入' : 'Import'}</span>
          </Button>
          <Button size="small" type="primary" disabled={agentPackages.length >= 50} onClick={() => setPkgEditing({ id: '', name: '', description: '', system_extra: '', tools: [], kinds: [], version: 1, changelog: [], isNew: true })}>
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
            <span>{t(locale, 'adminAINew')}</span>
          </Button>
                </span>
                )}
              >
        <div className="ai-provider-list">
          {agentPackages.length === 0 && <div className="empty">{zh ? '尚无平台技能包，点击右上角新建或导入。' : 'No platform packages yet; create or import one.'}</div>}
          {agentPackages.map((p) => {
            const stat = pkgStats[p.id]
            return (
              <div className="ai-provider-card" key={p.id}>
                <div className="ai-provider-main">
                  <div className="ai-provider-name">
                    {p.name}
                    {p.version && p.version > 0 && <Tag color="blue">v{p.version}</Tag>}
                    {p.kinds && p.kinds.length > 0
                      ? <Tag>{zh ? `限 ${p.kinds.length} 类文档` : `${p.kinds.length} kinds`}</Tag>
                      : <Tag>{zh ? '全部文档' : 'All docs'}</Tag>}
                    {p.tools && p.tools.length > 0 && <Tag color="geekblue">{p.tools.length} {zh ? '工具' : 'tools'}</Tag>}
                  </div>
                  {p.description && <div className="muted">{p.description}</div>}
                  <div className="muted" title={p.system_extra ?? ''}>
                    {(p.system_extra ?? '').length > 120 ? `${(p.system_extra ?? '').slice(0, 120)}…` : (p.system_extra || (zh ? '（无 system 附加段）' : '(no system add-on)'))}
                  </div>
                  <div className="muted">
                    {stat
                      ? (zh ? `已用 ${stat.calls} 次 · ${stat.users} 人 · 最近 ${stat.last_used_at.slice(0, 10)}` : `${stat.calls} calls · ${stat.users} users · last ${stat.last_used_at.slice(0, 10)}`)
                      : (zh ? '暂无使用记录' : 'No usage yet')}
                  </div>
                </div>
                {!readOnly && (
                  <div className="ai-provider-actions">
                    <Tooltip title={zh ? '编辑' : 'Edit'}>
                      <Button size="small" onClick={() => setPkgEditing({
                        id: p.id, name: p.name, description: p.description ?? '', system_extra: p.system_extra ?? '',
                        tools: p.tools ? [...p.tools] : [], kinds: p.kinds ? [...p.kinds] : [],
                        version: p.version ?? 0,
                        changelog: (p.changelog ?? []).map((e) => ({ version: e.version, date: e.date ?? '', note: e.note })),
                        isNew: false,
                      })}>
                        <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                    <Tooltip title={t(locale, 'adminAIDelete')}>
                      <Button size="small" danger onClick={() => void removePackage(p.id)}>
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                )}
              </div>
            )
          })}
        </div>
              </SettingsSection>
            </div>
          )}, {
          key: 'mcp',
          label: zh ? 'MCP 服务' : 'MCP services',
          children: (
            <div className="ai-tab-section">
              {/* MCP 工具服务：外部 MCP 服务器（Streamable HTTP）；对话开启「MCP 工具」后可被调用。 */}
              <SettingsSection
                title={zh ? 'MCP 服务' : 'MCP services'}
                desc={zh
                  ? 'AI 对话开启「MCP 工具」后，模型可调用此处配置的外部 MCP 服务器工具（Streamable HTTP 端点，如 http://host/mcp）；密钥仅保存不回显。'
                  : 'Once "MCP tools" is enabled in AI chat, the model can call external MCP server tools configured here (Streamable HTTP endpoints, e.g. http://host/mcp); secrets are stored but never echoed back.'}
                extra={!readOnly && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button size="small" loading={mcpExporting} onClick={() => void exportMCP()}>
                      <Download size={13} strokeWidth={2} aria-hidden="true" />
                      <span>{zh ? '导出' : 'Export'}</span>
                    </Button>
                    <Button size="small" onClick={() => setMcpImport({ content: '' })}>
                      <Upload size={13} strokeWidth={2} aria-hidden="true" />
                      <span>{zh ? '导入' : 'Import'}</span>
                    </Button>
                    <Button size="small" type="primary" disabled={mcpServices.length >= 8} onClick={() => setMcpEditing({ id: '', name: '', description: '', url: '', auth_header: '', headersDraft: [], timeoutSec: 0, disabledTools: [], enabled: true, isNew: true })}>
                      <Plus size={13} strokeWidth={2} aria-hidden="true" />
                      <span>{t(locale, 'adminAINew')}</span>
                    </Button>
                  </span>
                )}
              >
        <div className="ai-provider-list">
          {mcpServices.length === 0 && <div className="empty">{zh ? '尚无 MCP 服务，点击右上角新建。' : 'No MCP services yet; create one.'}</div>}
          {mcpServices.map((s) => (
            <div className="ai-provider-card" key={s.id}>
              <div className="ai-provider-main">
                <div className="ai-provider-name">
                  {s.name}
                  <Tag color={s.enabled ? 'green' : 'default'}>{s.enabled ? t(locale, 'adminAIEnabled') : (zh ? '停用' : 'Disabled')}</Tag>
                  {s.auth_header_configured && <Tag color="blue">{zh ? '密钥已配置' : 'Secret configured'}</Tag>}
                  {(s.auth_headers ?? []).map((k) => (
                    <Tag key={k}>{k}</Tag>
                  ))}
                  {!!s.disabled_tools?.length && (
                    <Tag color="orange">{zh ? `禁用 ${s.disabled_tools.length} 工具` : `${s.disabled_tools.length} tools disabled`}</Tag>
                  )}
                </div>
                {s.description && <div className="muted">{s.description}</div>}
                <div className="muted" title={s.url}>{s.id} · {s.url}</div>
                {mcpTests[s.id] && <MCPTestResult state={mcpTests[s.id]} zh={zh} />}
              </div>
              {!readOnly && (
                <div className="ai-provider-actions">
                  <Tooltip title={t(locale, 'adminAITest')}>
                    <Button size="small" loading={mcpTests[s.id]?.running} onClick={() => void runMCPTest(s)}>
                      <Zap size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIEdit')}>
                    <Button size="small" onClick={() => setMcpEditing({ id: s.id, name: s.name, description: s.description ?? '', url: s.url, auth_header: '', headersDraft: (s.auth_headers ?? []).map((k) => ({ key: k, value: '' })), timeoutSec: s.timeout_sec ?? 0, disabledTools: [...(s.disabled_tools ?? [])], enabled: s.enabled, isNew: false })}>
                      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip title={t(locale, 'adminAIDelete')}>
                    <Button size="small" danger onClick={() => void removeMCP(s.id)}>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {zh ? `最多 8 个服务（当前 ${mcpServices.length}/8）；仅启用项对登录用户可见。` : `Up to 8 services (${mcpServices.length}/8); only enabled ones are visible to users.`}
        </p>
              </SettingsSection>
            </div>
          )}, {
          key: 'usage',
          label: t(locale, 'adminAIUsage'),
          children: (
            <div className="ai-tab-section">
        {/* 用量统计（G2/G3：用户 / 会话 / 工具三维度）。 */}
        <div className="ai-usage-filters" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Select
            size="small"
            style={{ width: zh ? 110 : 120 }}
            value={usageBy}
            onChange={(v) => {
              setUsageBy(v)
              void loadUsage(v)
            }}
            options={[
              { value: 'user', label: zh ? '按用户' : 'By user' },
              { value: 'conversation', label: zh ? '按会话' : 'By conversation' },
              { value: 'tool', label: zh ? '按工具' : 'By tool' },
            ]}
          />
          <input type="date" aria-label={t(locale, 'adminAIFrom')} value={usageFrom} onChange={(e) => setUsageFrom(e.target.value)} />
          <span className="muted">→</span>
          <input type="date" aria-label={t(locale, 'adminAITo')} value={usageTo} onChange={(e) => setUsageTo(e.target.value)} />
          <Button size="small" loading={usageLoading} onClick={() => void loadUsage()}>{t(locale, 'refresh')}</Button>
        </div>
        {usageBy === 'conversation' ? (
          <Table
            size="small"
            rowKey="conversation_id"
            dataSource={convoUsageRows ?? []}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: t(locale, 'adminAIUsageEmpty') }}
            columns={[
              { title: zh ? '会话' : 'Conversation', dataIndex: 'title', render: (v: string, r: AIConvoUsageRow) => `${v || (zh ? '（无标题）' : '(untitled)')} · ${r.source}` },
              { title: t(locale, 'adminAIUsageUser'), dataIndex: 'username', render: (v: string, r: AIConvoUsageRow) => v || r.user_id.slice(0, 8) },
              { title: t(locale, 'adminAIUsageCalls'), dataIndex: 'calls' },
              { title: t(locale, 'adminAIUsageTokens'), dataIndex: 'total_tokens' },
              { title: zh ? '最近活跃' : 'Last active', dataIndex: 'last_active_at', render: (v: string) => new Date(v).toLocaleString() },
            ]}
          />
        ) : usageBy === 'tool' ? (
          <Table
            size="small"
            rowKey="tool"
            dataSource={toolStatsRows ?? []}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: t(locale, 'adminAIUsageEmpty') }}
            columns={[
              { title: zh ? '工具' : 'Tool', dataIndex: 'tool' },
              { title: t(locale, 'adminAIUsageCalls'), dataIndex: 'calls' },
              { title: zh ? '成功率' : 'Success', render: (_: unknown, r: AIToolStatsRow) => r.calls > 0 ? `${Math.round((r.ok * 100) / r.calls)}%（${r.ok}/${r.calls}）` : '—' },
              { title: t(locale, 'adminAIUsageAvgMs'), dataIndex: 'avg_duration_ms', render: (v: number) => `${Math.round(v)} ms` },
              { title: zh ? '最慢' : 'Max', dataIndex: 'max_duration_ms', render: (v: number) => `${Math.round(v)} ms` },
              { title: zh ? '最近使用' : 'Last used', dataIndex: 'last_used_at', render: (v: string) => new Date(v).toLocaleString() },
            ]}
          />
        ) : (
          <Table
            size="small"
            rowKey={(r) => `${r.user_id}-${r.provider_id}-${r.model}`}
            dataSource={usageRows ?? []}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: t(locale, 'adminAIUsageEmpty') }}
            columns={[
              { title: t(locale, 'adminAIUsageUser'), dataIndex: 'username', render: (v: string, r: AIUsageRow) => v || r.user_id.slice(0, 8) },
              { title: t(locale, 'adminAIProvider'), dataIndex: 'provider_id' },
              { title: t(locale, 'adminAIModel'), dataIndex: 'model' },
              { title: t(locale, 'adminAIUsageCalls'), dataIndex: 'calls' },
              { title: t(locale, 'adminAIUsageTokens'), dataIndex: 'total_tokens' },
              { title: t(locale, 'adminAIUsageAvgMs'), dataIndex: 'avg_duration_ms', render: (v: number) => `${Math.round(v)} ms` },
            ]}
          />
        )}
        <div className="muted" style={{ marginTop: 6 }}>
          {usageBy === 'tool'
            ? (zh ? `合计 ${usageTotal.calls} 次 · 成功 ${usageTotal.tokens} 次（统计窗受审计保留期约束）` : `${usageTotal.calls} calls · ${usageTotal.tokens} ok (bounded by audit retention)`)
            : (zh ? '合计' : 'Total') + `：${usageTotal.calls} ` + (zh ? '次' : 'calls') + ` · ${usageTotal.tokens} tokens`}
        </div>
            </div>
          )},
        ]} />

      {/* 新建/编辑 Provider 弹窗（多模型 + Provider 级限流）。 */}
      {editing && (
        <Modal title={editing.isNew ? t(locale, 'adminAINew') : `${t(locale, 'adminAIEdit')}：${editing.name}`} onClose={() => setEditing(null)}>
          <div className="ai-provider-form">
            <label className="field">
              <span>ID{zh ? '（唯一标识，保存后不可改）' : ' (unique key)'}</span>
              <Input value={editing.id} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称' : 'Name'}</span>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{t(locale, 'adminAIKind')}</span>
              <Select
                value={editing.kind}
                onChange={(kind) => {
                  const preset = KIND_PRESETS[kind]
                  setEditing({
                    ...editing, kind, base_url: preset?.baseURL ?? '',
                    models: preset ? [{ id: preset.model, label: '', caps: emptyCaps() }] : editing.models,
                  })
                }}
                options={Object.entries(KIND_PRESETS).map(([value, p]) => ({ value, label: p.label }))}
              />
            </label>
            {editing.kind !== 'mock' && (
              <>
                <label className="field">
                  <span>{t(locale, 'adminAIBaseURL')}</span>
                  <Input value={editing.base_url} placeholder="https://api.openai.com/v1" onChange={(e) => setEditing({ ...editing, base_url: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t(locale, 'adminAIAPIKey')}</span>
                  <Input.Password
                    value={editing.api_key}
                    placeholder={editing.isNew ? 'sk-…' : t(locale, 'adminAIAPIKeyHint')}
                    onChange={(e) => setEditing({ ...editing, api_key: e.target.value })}
                  />
                </label>
              </>
            )}
            <div className="field">
              <span>
                {zh ? '模型列表（类型互斥单选 + 能力多选；✨ 自动识别按 models.dev 目录预填）' : 'Models (exclusive type radio + capability checkboxes; auto-detect via models.dev)'}
                <Tooltip title={zh ? '类型四选一（对话/嵌入/重排/图像，一个模型只属一类）；能力可多选（推理/视觉/音频/视频）。「识别」按模型 ID 查询 models.dev 开源目录自动预填；未收录时手动选择。' : 'Exclusive model type (chat/embedding/rerank/image); capabilities are a union (reasoning/vision/audio/video). Detect queries the models.dev catalog to prefill; pick manually when not listed.'}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <div className="ai-model-rows">
                {editing.models.map((m, idx) => (
                  <div className="ai-model-row" key={idx} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <Input style={{ width: 200 }} placeholder={zh ? '模型 ID（如 gpt-4o-mini）' : 'Model ID'} value={m.id}
                      onPressEnter={() => void detectModel(idx, m.id)}
                      onChange={(e) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, id: e.target.value } : x)) })} />
                    <Input style={{ width: 140 }} placeholder={zh ? '显示名（可选）' : 'Label (optional)'} value={m.label}
                      onChange={(e) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)) })} />
                    <Tooltip title={zh ? '自动识别类型与能力（models.dev）' : 'Auto-detect type & capabilities (models.dev)'}>
                      <Button size="small" loading={!!modelDetecting[idx]} onClick={() => void detectModel(idx, m.id)}>
                        <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                        <span>{zh ? '识别' : 'Detect'}</span>
                      </Button>
                    </Tooltip>
                    <Radio.Group
                      size="small"
                      optionType="button"
                      value={m.caps.kind}
                      onChange={(e) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, caps: { ...x.caps, kind: e.target.value as AIModelKind } } : x)) })}
                      options={MODEL_KIND_OPTIONS.map((k) => {
                        const KindIcon = k.icon
                        return { value: k.value, label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><KindIcon size={12} strokeWidth={2} aria-hidden="true" />{zh ? k.zh : k.en}</span>) }
                      })}
                    />
                    {CAPABILITY_FIELDS.map((c) => (
                      <Checkbox key={c.key} checked={m.caps[c.key]}
                        onChange={(e) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, caps: { ...x.caps, [c.key]: e.target.checked } } : x)) })}>
                        {zh ? c.zh : c.en}
                      </Checkbox>
                    ))}
                    <Tooltip title={zh ? '上下文窗口（token，0=不限制）' : 'Context window (tokens, 0=unlimited)'}>
                      <InputNumber size="small" style={{ width: 110 }} min={0} step={1000}
                        placeholder={zh ? '上下文窗口' : 'Ctx window'}
                        value={m.context_window || undefined}
                        onChange={(v) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, context_window: v ?? 0 } : x)) })} />
                    </Tooltip>
                    <Tooltip title={zh ? '输出上限覆盖（0=用全局）' : 'Max tokens override (0=global)'}>
                      <InputNumber size="small" style={{ width: 100 }} min={0} step={256}
                        placeholder={zh ? '输出上限' : 'Max out'}
                        value={m.max_tokens || undefined}
                        onChange={(v) => setEditing({ ...editing, models: editing.models.map((x, i) => (i === idx ? { ...x, max_tokens: v ?? 0 } : x)) })} />
                    </Tooltip>
                    <Button size="small" danger onClick={() => setEditing({ ...editing, models: editing.models.filter((_, i) => i !== idx) })}>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Input
                    style={{ width: 280 }}
                    placeholder={zh ? '粘贴模型 ID，回车添加并自动识别' : 'Paste a model ID and press Enter'}
                    value={newModelInput}
                    allowClear
                    onChange={(e) => setNewModelInput(e.target.value)}
                    onPressEnter={() => void addModelWithDetect()}
                  />
                  <Button size="small" onClick={() => void addModelWithDetect()}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{zh ? '添加模型' : 'Add model'}</span>
                  </Button>
                </div>
              </div>
            </div>
            <label className="field">
              <span>
                {zh ? '每用户限流（次/分钟）' : 'Rate limit (req/min/user)'}
                <Tooltip title={zh ? 'Provider 级每用户每分钟请求上限；0 = 使用全局兜底限流。' : 'Per-user per-minute limit for this provider; 0 = global fallback.'}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <InputNumber min={0} max={10000} value={editing.requestsPerMin} onChange={(v) => setEditing({ ...editing, requestsPerMin: Number(v ?? 0) })} />
            </label>
            <label className="field">
              <span>
                {zh ? '每日限额（次/用户）' : 'Daily quota (per user)'}
                <Tooltip title={zh ? 'Provider 级每用户每日请求上限（UTC 日）；0 = 不限。' : 'Per-user daily request cap (UTC day); 0 = unlimited.'}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <InputNumber min={0} max={1000000} value={editing.dailyQuota} onChange={(v) => setEditing({ ...editing, dailyQuota: Number(v ?? 0) })} />
            </label>
            <label className="check-item">
              <Switch checked={editing.enabled} onChange={(v) => setEditing({ ...editing, enabled: v })} />
              <span>{t(locale, 'adminAIEnabled')}</span>
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" onClick={() => void applyEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button onClick={() => setEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑平台人设弹窗（风格同 Provider 编辑弹窗）。 */}
      {personaEditing && (
        <Modal
          title={personaEditing.isNew
            ? (zh ? '新建平台人设' : 'New platform persona')
            : `${zh ? '编辑平台人设' : 'Edit platform persona'}：${personaEditing.name}`}
          onClose={() => setPersonaEditing(null)}
        >
          <div className="ai-provider-form">
            <label className="field">
              <span>ID{zh ? '（唯一标识，≤64，保存后不可改）' : ' (unique key, ≤64)'}</span>
              <Input value={personaEditing.id} maxLength={64} disabled={!personaEditing.isNew} onChange={(e) => setPersonaEditing({ ...personaEditing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称（≤64）' : 'Name (≤64)'}</span>
              <Input value={personaEditing.name} maxLength={64} onChange={(e) => setPersonaEditing({ ...personaEditing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? 'System 提示词（≤4000）' : 'System prompt (≤4000)'}</span>
              <Input.TextArea rows={6} maxLength={4000} value={personaEditing.system_prompt} onChange={(e) => setPersonaEditing({ ...personaEditing, system_prompt: e.target.value })} />
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" onClick={() => void applyPersonaEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button onClick={() => setPersonaEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑技能模板弹窗。 */}
      {skillEditing && (
        <Modal
          title={skillEditing.isNew
            ? (zh ? '新建技能模板' : 'New skill')
            : `${zh ? '编辑技能模板' : 'Edit skill'}：${skillEditing.name}`}
          onClose={() => setSkillEditing(null)}
        >
          <div className="ai-provider-form">
            <label className="field">
              <span>ID{zh ? '（唯一标识，≤64，保存后不可改）' : ' (unique key, ≤64)'}</span>
              <Input value={skillEditing.id} maxLength={64} disabled={!skillEditing.isNew} onChange={(e) => setSkillEditing({ ...skillEditing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称（≤64）' : 'Name (≤64)'}</span>
              <Input value={skillEditing.name} maxLength={64} onChange={(e) => setSkillEditing({ ...skillEditing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '描述（可选，≤200）' : 'Description (optional, ≤200)'}</span>
              <Input value={skillEditing.description} maxLength={200} onChange={(e) => setSkillEditing({ ...skillEditing, description: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? 'Prompt（≤4000；占位符 {selection}=编辑器选区、{file}=当前文件名）' : 'Prompt (≤4000; placeholders {selection} / {file})'}</span>
              <Input.TextArea rows={6} maxLength={4000} value={skillEditing.prompt} onChange={(e) => setSkillEditing({ ...skillEditing, prompt: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '启用（停用后用户侧不可见）' : 'Enabled (hidden from users when off)'}</span>
              <Switch checked={skillEditing.enabled} onChange={(v) => setSkillEditing({ ...skillEditing, enabled: v })} />
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" onClick={() => void applySkillEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button onClick={() => setSkillEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑对话技能弹窗（Cherry Studio 式 Skills：Markdown 整段注入该轮 system）。 */}
      {chatSkillEditing && (
        <Modal
          title={chatSkillEditing.isNew
            ? (zh ? '新建对话技能' : 'New chat skill')
            : `${zh ? '编辑对话技能' : 'Edit chat skill'}：${chatSkillEditing.name}`}
          onClose={() => setChatSkillEditing(null)}
        >
          <div className="ai-provider-form">
            <label className="field">
              <span>ID{zh ? '（唯一标识，≤64，保存后不可改）' : ' (unique key, ≤64)'}</span>
              <Input value={chatSkillEditing.id} maxLength={64} disabled={!chatSkillEditing.isNew} onChange={(e) => setChatSkillEditing({ ...chatSkillEditing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称（≤64）' : 'Name (≤64)'}</span>
              <Input value={chatSkillEditing.name} maxLength={64} onChange={(e) => setChatSkillEditing({ ...chatSkillEditing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '图标（可选，lucide 图标名）' : 'Icon (optional, lucide name)'}</span>
              <Input value={chatSkillEditing.icon} maxLength={64} placeholder={zh ? 'lucide 图标名，如 languages' : 'lucide icon name, e.g. languages'} onChange={(e) => setChatSkillEditing({ ...chatSkillEditing, icon: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '描述（可选，≤200）' : 'Description (optional, ≤200)'}</span>
              <Input value={chatSkillEditing.description} maxLength={200} onChange={(e) => setChatSkillEditing({ ...chatSkillEditing, description: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '启用（停用后用户侧不可见）' : 'Enabled (hidden from users when off)'}</span>
              <Switch checked={chatSkillEditing.enabled} onChange={(v) => setChatSkillEditing({ ...chatSkillEditing, enabled: v })} />
            </label>
            <label className="field">
              <span>{zh ? '内容（Markdown 指令，≤4000；选用后整段注入该轮 system 提示）' : 'Content (Markdown instructions, ≤4000; injected whole into that turn system prompt)'}</span>
              <Input.TextArea rows={8} maxLength={4000} value={chatSkillEditing.content} placeholder={zh ? 'Markdown 指令…' : 'Markdown instructions…'} onChange={(e) => setChatSkillEditing({ ...chatSkillEditing, content: e.target.value })} />
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" onClick={() => void applyChatSkillEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button onClick={() => setChatSkillEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑 Agent 技能包弹窗（I 批次：版本 + 变更日志）。 */}
      {pkgEditing && (
        <Modal
          title={pkgEditing.isNew
            ? (zh ? '新建 Agent 技能包' : 'New agent package')
            : `${zh ? '编辑 Agent 技能包' : 'Edit agent package'}：${pkgEditing.name}`}
          onClose={() => setPkgEditing(null)}
        >
          <div className="ai-provider-form">
            <label className="field">
              <span>ID{zh ? '（唯一标识，≤64，保存后不可改；builtin- 前缀保留给内置包）' : ' (unique key, ≤64; builtin- prefix reserved)'}</span>
              <Input value={pkgEditing.id} maxLength={64} disabled={!pkgEditing.isNew} onChange={(e) => setPkgEditing({ ...pkgEditing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称（≤64）' : 'Name (≤64)'}</span>
              <Input value={pkgEditing.name} maxLength={64} onChange={(e) => setPkgEditing({ ...pkgEditing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '描述（可选，≤200）' : 'Description (optional, ≤200)'}</span>
              <Input value={pkgEditing.description} maxLength={200} onChange={(e) => setPkgEditing({ ...pkgEditing, description: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? 'System 附加段（≤4000；追加到 Agent 系统提示之后）' : 'System add-on (≤4000; appended to the agent system prompt)'}</span>
              <Input.TextArea rows={6} maxLength={4000} value={pkgEditing.system_extra} onChange={(e) => setPkgEditing({ ...pkgEditing, system_extra: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '工具白名单（空 = 不限制；dd_* 平台工具）' : 'Tool allowlist (empty = unrestricted; dd_* platform tools)'}</span>
              <Select
                mode="tags" size="small" allowClear
                value={pkgEditing.tools}
                options={PACKAGE_TOOL_OPTIONS.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setPkgEditing({ ...pkgEditing, tools: v })}
              />
            </label>
            <label className="field">
              <span>{zh ? '适用文档类型（空 = 全部）' : 'Applicable doc kinds (empty = all)'}</span>
              <Select
                mode="multiple" size="small" allowClear
                value={pkgEditing.kinds}
                options={PACKAGE_KIND_OPTIONS}
                onChange={(v) => setPkgEditing({ ...pkgEditing, kinds: v })}
              />
            </label>
            <label className="field">
              <span>{zh ? '版本号（≥0；实质修改时递增，用户侧下拉显示 vN）' : 'Version (≥0; bump on meaningful changes, shown as vN)'}</span>
              <InputNumber min={0} value={pkgEditing.version} onChange={(v) => setPkgEditing({ ...pkgEditing, version: v ?? 0 })} />
            </label>
            <div className="field">
              <span>{zh ? `变更日志（≤50 条；说明每版改了什么）` : 'Changelog (≤50 entries; what changed per version)'}</span>
              {pkgEditing.changelog.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <InputNumber
                    size="small" min={0} style={{ width: 76 }}
                    value={e.version}
                    onChange={(v) => setPkgEditing({ ...pkgEditing, changelog: pkgEditing.changelog.map((x, j) => (j === i ? { ...x, version: v ?? 0 } : x)) })}
                  />
                  <Input
                    size="small" placeholder="YYYY-MM-DD" style={{ width: 128 }}
                    value={e.date}
                    onChange={(ev) => setPkgEditing({ ...pkgEditing, changelog: pkgEditing.changelog.map((x, j) => (j === i ? { ...x, date: ev.target.value } : x)) })}
                  />
                  <Input
                    size="small" placeholder={zh ? '变更说明（≤500）' : 'What changed (≤500)'}
                    value={e.note}
                    maxLength={500}
                    onChange={(ev) => setPkgEditing({ ...pkgEditing, changelog: pkgEditing.changelog.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)) })}
                  />
                  <Button size="small" type="text" danger onClick={() => setPkgEditing({ ...pkgEditing, changelog: pkgEditing.changelog.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button size="small" disabled={pkgEditing.changelog.length >= 50} onClick={() => setPkgEditing({
                ...pkgEditing,
                changelog: [{ version: pkgEditing.version || 1, date: new Date().toISOString().slice(0, 10), note: '' }, ...pkgEditing.changelog],
              })}>
                <Plus size={13} strokeWidth={2} aria-hidden="true" />
                <span>{zh ? '添加变更记录' : 'Add entry'}</span>
              </Button>
            </div>
          </div>
          <div className="modal-actions">
            <Button type="primary" onClick={() => void applyPackageEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button onClick={() => setPkgEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 技能包导入弹窗（粘贴导出的 JSON/YAML；upsert 合并 / replace 整替）。 */}
      {pkgImport && (
        <Modal title={zh ? '导入 Agent 技能包' : 'Import agent packages'} onClose={() => setPkgImport(null)}>
          <div className="ai-provider-form">
            <label className="field">
              <span>{zh ? '格式（与导出文件一致）' : 'Format (match the exported file)'}</span>
              <Radio.Group
                value={pkgImport.format}
                onChange={(e) => setPkgImport({ ...pkgImport, format: e.target.value as 'json' | 'yaml' })}
              >
                <Radio value="json">JSON</Radio>
                <Radio value="yaml">YAML</Radio>
              </Radio.Group>
            </label>
            <label className="field">
              <span>{zh ? '导入模式' : 'Import mode'}</span>
              <Radio.Group
                value={pkgImport.mode}
                onChange={(e) => setPkgImport({ ...pkgImport, mode: e.target.value as 'upsert' | 'replace' })}
              >
                <Radio value="upsert">{zh ? '合并（按 id 覆盖同 id 平台包）' : 'Upsert (merge by id)'}</Radio>
                <Radio value="replace">{zh ? '整块替换（清空现有平台包）' : 'Replace all'}</Radio>
              </Radio.Group>
            </label>
            <label className="field">
              <span>{zh ? '内容（粘贴导出文件全文；≤256KB；builtin- 前缀包自动拒收）' : 'Content (paste the full exported file; ≤256KB; builtin- packages are rejected)'}</span>
              <Input.TextArea
                rows={10}
                value={pkgImport.content}
                onChange={(e) => setPkgImport({ ...pkgImport, content: e.target.value })}
                placeholder={pkgImport.format === 'json' ? '{"packages":[…]}' : 'packages:\n  - id: …'}
              />
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" loading={pkgImporting} onClick={() => void applyPackageImport()}>
              {zh ? '导入' : 'Import'}
            </Button>
            <Button onClick={() => setPkgImport(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* MCP mcpServers JSON 导入弹窗（粘贴内容；stdio 条目后端跳过并说明原因）。 */}
      {mcpImport && (
        <Modal title={zh ? '导入 MCP 服务' : 'Import MCP services'} onClose={() => setMcpImport(null)}>
          <div className="ai-provider-form">
            <label className="field">
              <span>{zh ? '内容（粘贴 mcpServers JSON；stdio 条目自动跳过）' : 'Content (paste the mcpServers JSON; stdio entries are skipped)'}</span>
              <Input.TextArea
                rows={10}
                value={mcpImport.content}
                onChange={(e) => setMcpImport({ ...mcpImport, content: e.target.value })}
                placeholder={zh ? '粘贴 {"mcpServers":{"名称":{"url":"https://…","headers":{…}}}}' : 'Paste {"mcpServers":{"name":{"url":"https://…","headers":{…}}}}'}
              />
            </label>
          </div>
          <div className="modal-actions">
            <Button type="primary" loading={mcpImporting} onClick={() => void applyMCPImport()}>{zh ? '导入' : 'Import'}</Button>
            <Button onClick={() => setMcpImport(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑 MCP 工具服务弹窗（Streamable HTTP 端点 + 密钥只写不读）。 */}
      {mcpEditing && (
        <Modal
          title={mcpEditing.isNew
            ? (zh ? '新建 MCP 服务' : 'New MCP service')
            : `${zh ? '编辑 MCP 服务' : 'Edit MCP service'}：${mcpEditing.name}`}
          onClose={() => setMcpEditing(null)}
        >
          <div className="ai-provider-form">
            {mcpEditing.isNew && (
              <label className="field">
                <span>{zh ? '官方模板（选中即预填，可再修改）' : 'Official templates (prefill, editable)'}</span>
                <Select
                  size="small"
                  value={undefined}
                  placeholder={zh ? '选择常用官方 MCP 服务…' : 'Pick a common official MCP server…'}
                  onChange={(v) => {
                    const tpl = MCP_OFFICIAL_TEMPLATES.find((x) => x.id === v)
                    if (tpl) setMcpEditing({ ...mcpEditing, id: tpl.id, name: tpl.name, url: tpl.url })
                  }}
                  options={MCP_OFFICIAL_TEMPLATES.map((x) => ({ value: x.id, label: `${x.name} · ${x.url}` }))}
                />
              </label>
            )}
            <label className="field">
              <span>ID{zh ? '（唯一标识，≤64，保存后不可改）' : ' (unique key, ≤64)'}</span>
              <Input value={mcpEditing.id} maxLength={64} disabled={!mcpEditing.isNew} onChange={(e) => setMcpEditing({ ...mcpEditing, id: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '名称（≤64）' : 'Name (≤64)'}</span>
              <Input value={mcpEditing.name} maxLength={64} onChange={(e) => setMcpEditing({ ...mcpEditing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '描述（可选，≤200）' : 'Description (optional, ≤200)'}</span>
              <Input value={mcpEditing.description} maxLength={200} onChange={(e) => setMcpEditing({ ...mcpEditing, description: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? 'URL（Streamable HTTP 端点）' : 'URL (Streamable HTTP endpoint)'}</span>
              <Input value={mcpEditing.url} maxLength={512} placeholder="http://host/mcp" onChange={(e) => setMcpEditing({ ...mcpEditing, url: e.target.value })} />
            </label>
            <label className="field">
              <span>{zh ? '密钥（Authorization 头，可空）' : 'Secret (Authorization header, optional)'}</span>
              <Input.Password
                value={mcpEditing.auth_header}
                placeholder={zh ? '留空保持不变' : 'Leave blank to keep the current value'}
                autoComplete="new-password"
                onChange={(e) => setMcpEditing({ ...mcpEditing, auth_header: e.target.value })}
              />
            </label>
            {/* 多认证头：键必填、值留空 = 保持已配置值；删除行 = 移除该头。 */}
            <div className="field">
              <span>{zh ? '认证头（附加自定义 Header）' : 'Auth headers (custom headers)'}</span>
              {mcpEditing.headersDraft.map((h, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <Input
                    style={{ width: 180 }}
                    placeholder="X-Api-Key"
                    value={h.key}
                    onChange={(e) => setMcpEditing({ ...mcpEditing, headersDraft: mcpEditing.headersDraft.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                  />
                  <Input.Password
                    placeholder={zh ? '留空 = 保持已配置值' : 'Empty = keep the configured value'}
                    autoComplete="new-password"
                    value={h.value}
                    onChange={(e) => setMcpEditing({ ...mcpEditing, headersDraft: mcpEditing.headersDraft.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                  <Button size="small" type="text" danger onClick={() => setMcpEditing({ ...mcpEditing, headersDraft: mcpEditing.headersDraft.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <div>
                <Button size="small" disabled={mcpEditing.headersDraft.length >= 8} onClick={() => setMcpEditing({ ...mcpEditing, headersDraft: [...mcpEditing.headersDraft, { key: '', value: '' }] })}>
                  <Plus size={13} strokeWidth={2} aria-hidden="true" />
                  <span>{zh ? '添加认证头' : 'Add header'}</span>
                </Button>
              </div>
            </div>
            <label className="field">
              <span>
                {zh ? '超时（秒）' : 'Timeout (seconds)'}
                <Tooltip title={zh ? '单服务请求超时；0 = 默认 8 秒，上限 60。' : 'Per-service request timeout; 0 = default 8s, max 60.'}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <InputNumber min={0} max={60} value={mcpEditing.timeoutSec || undefined} placeholder={zh ? '默认 8' : 'Default 8'} onChange={(v) => setMcpEditing({ ...mcpEditing, timeoutSec: Number(v ?? 0) })} />
            </label>
            <label className="field">
              <span>
                {zh ? '禁用工具' : 'Disabled tools'}
                <Tooltip title={zh ? '注入对话时跳过已勾选工具的声明。' : 'Checked tools are not declared when injected into chats.'}>
                  <QuestionCircleOutlined style={{ marginLeft: 4, color: '#888' }} />
                </Tooltip>
              </span>
              <Select
                mode="multiple"
                size="small"
                allowClear
                value={mcpEditing.disabledTools}
                options={(mcpModalTest?.toolNames ?? []).map((n) => ({ value: n, label: n }))}
                onChange={(v) => setMcpEditing({ ...mcpEditing, disabledTools: v })}
              />
              <span className="hint">{zh ? '先「测试连接」拉取工具列表后勾选要禁用的工具。' : 'Run "Test connection" first to list tools, then pick the ones to disable.'}</span>
            </label>
            <label className="check-item">
              <Switch checked={mcpEditing.enabled} onChange={(v) => setMcpEditing({ ...mcpEditing, enabled: v })} />
              <span>{t(locale, 'adminAIEnabled')}</span>
            </label>
            {/* 草稿测试结果（测试按表单当前 url/密钥/认证头/超时，未保存修改可直接验证）。 */}
            {mcpModalTest && <MCPTestResult state={mcpModalTest} zh={zh} />}
          </div>
          <div className="modal-actions">
            <Button type="primary" loading={mcpSaving} onClick={() => void applyMCPEdit()}>{t(locale, 'adminAISave')}</Button>
            <Button loading={mcpModalTest?.running ?? false} onClick={() => void runMCPModalTest()}>
              <Zap size={13} strokeWidth={2} aria-hidden="true" />
              <span>{zh ? '测试连接' : 'Test connection'}</span>
            </Button>
            <Button onClick={() => setMcpEditing(null)}>{t(locale, 'cancel')}</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
