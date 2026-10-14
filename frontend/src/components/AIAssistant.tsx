// 全局 AI 助手侧边栏（v7.4 S8 起统一 AIChatShell 渲染——与编辑页 AI 对话
// 同一套组件）：
// - 480px 右侧 Drawer 仅作容器（遮罩/固定 pin/Esc 语义不变；无自带头部），
//   内部 = AIChatShell（assistant 宿主，in-drawer 形态）：
//   ChatHeader（标题 + 会话管理 ConvoPicker + 新建 + 导入导出 + 批量 + 关闭；
//   图钉经 extraHeaderSlot）+ belowHeaderSlot 工具行（人设 Select + 工作目录
//   + 长期记忆）+ 模式段（可修改/仅对话）+ ChatThread（统一消息流：思考折叠
//   /markdown 流式/工具链/RAG 来源/网络来源/用量/操作行/批量）+ ChatInput
//   （技能模板 + 联网/文件RAG/思考/MCP/文件工具开关组 + 文件检索 + 引用文件
//   + 模型选择 + 发送/停止）；
// - 多轮对话 SSE 流式渲染；「停止生成」经 AbortController——abort 后保留
//   已生成内容并标记「已停止」（非错误，可继续输入）；
// - 会话存服务端（/ai/conversations，source=assistant，事件溯源）；本文件
//   保留业务逻辑（发送/摘要/记忆/人设/工作目录/批量/保存/导入导出），
//   渲染全部经 Shell props 注入；
// - 「问 AI」（全局搜索框）：openAIAssistant(context?, ask?) 事件打开并
//   以检索增强模式立即提问；
// - 人设三源合并（平台 + 内置 + 自定义）、长期记忆（手动 + 自动提取开关）、
//   df_* 平台文件工具（use_files + work_root 工作目录）、MCP/联网/思考开关
//   ——详见各段注释。
import { useEffect, useRef, useState } from 'react'
import type { Key, ReactNode } from 'react'
import { App as AntdApp, Drawer, Button, Input, Popconfirm, Popover, Select, Switch, Tag, Tooltip, Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { Sparkles, Trash2, FileText, Globe, Check, Paperclip, Brain, Pencil, PencilLine, BookMarked, Wrench, Zap, FolderCog, FolderOpen, Crosshair, FileSearch, Search, Upload } from 'lucide-react'
import {
  AISkillDef,
  AIUsage,
  AIMessage,
  AIPersonalPrefsView,
  aiChat,
  aiCreateConversation,
  aiDeleteConversation,
  aiGetConversation,
  aiListConversations,
  aiSummarizeFileStream,
  aiAppendConversation,
  aiUpdateConversation,
  authFetch,
  createAIMemory,
  currentUserId,
  deleteAIMemory,
  getAIMCPServices,
  getAIPersonalSettings,
  getMe,
  listAIMemory,
  listChatSkillGroups,
  listPlatformSkills,
  putAIPersonalSettings,
  updateAIMemory,
  listFiles,
  listSpaceFiles,
  listSpaces,
  searchFiles,
  uploadFile,
  deleteFile,
  aiGetAttachmentSpace,
  AIMemoryItem,
} from '../api'
import type { ChatSkillGroup, Space } from '../api'
import { useAILocation } from '../aiLocation'
import type { AILocation } from '../aiLocation'
import { Modal } from './FileBrowser'
import AIModelSelect from './AIModelSelect'
import { useAIEnabled, useAIFeatures } from '../aiFeature'
import { t, useLocale } from '../i18n'

// v3.9：发送/停止按钮在 chat-tools-bar 最右端（共享 CHAT_SEND_ICON/
// CHAT_STOP_ICON 同款样式）；Sender 内置按钮保留挂载、CSS 隐藏。

/** 当前上下文文件（查看/编辑页打开 AI 时注入；快捷摘要目标）。 */
interface AIContextFile {
  fileId: string
  fileName: string
}

/** 引用文件（随对话发送 fileIds；用户气泡 📎 chips 展示；定义在 aichat
 *  共享，此处保留导出兼容既有引用）。 */
export type { AIAttachFile } from './aichat'

// ---------- 可选模型列表（GET /api/v1/ai/models 由并行任务添加） ----------
// api.ts 暂无封装（getAIModels 可能由并行任务加入），为解耦在此本地实现：
// authFetch GET /api/v1/ai/models，任何失败（404/网络/解析）一律返回空数组，
// 调用方（助手次级工具行等内嵌对话）据此隐藏模型选择器。

/** 可选模型条目（provider + model + 能力标签）。 */
export interface AIModelOption {
  /** 唯一键 `${providerId}/${model}`（localStorage 持久化值）。 */
  id: string
  providerId: string
  providerName: string
  model: string
  capabilities: string[]
  /** 模型支持推理（宽松读取 capabilities 中的 reasoning/think 标记）。 */
  reasoning?: boolean
  /** Provider 协议（openai_compatible / anthropic / mock；harness 兼容过滤用）。 */
  providerKind?: string
}

/** 选定模型持久化 key（助手与编辑页内嵌对话共用）。 */
export const AI_MODEL_STORAGE_KEY = 'docflow.ai.model'

/** 联网/思考开关持久化 key（AIAssistant / AIEditChat 等对话 UI 共用）。 */
export const AI_WEB_STORAGE_KEY = 'docflow.ai.web'
export const AI_THINK_STORAGE_KEY = 'docflow.ai.think'
/** MCP 工具开关持久化 key（默认关；仅平台存在启用中的 MCP 服务时显示开关）。 */
export const AI_MCP_STORAGE_KEY = 'docflow.ai.mcp'
/** 「我的文件」（RAG 检索本人文档）开关持久化 key（默认开；RAG 未启用时隐藏）。 */
export const AI_DOCS_STORAGE_KEY = 'docflow.ai.docs'
/** 平台文件工具（df_* 直接读写工作目录内文件）开关持久化 key（默认开）。 */
export const AI_FILES_STORAGE_KEY = 'docflow.ai.files'

/** 助手模式持久化 key（'chat' = 仅对话（不修改/不操作文件）；缺省/其他 = 智能）。 */
export const AI_MODE_STORAGE_KEY = 'docflow.ai.mode'

/** 读取助手模式（非法/未存储回退「智能」）。 */
function loadAIMode(): 'smart' | 'chat' {
  try {
    return window.localStorage.getItem(AI_MODE_STORAGE_KEY) === 'chat' ? 'chat' : 'smart'
  } catch {
    return 'smart'
  }
}

/** 同页多个开关实例的状态同步事件（storage 事件仅跨标签页触发）。 */
const AI_FLAGS_EVENT = 'docflow:ai-flags'

/** 读 localStorage 布尔标记（'1'/'0'；未存储或不可用时返回 null）。 */
export function readAIFlag(key: string): boolean | null {
  try {
    const v = window.localStorage.getItem(key)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** 写 localStorage 布尔标记，并广播同页同步事件（多实例保持一致）。 */
export function writeAIFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(AI_FLAGS_EVENT))
}

let aiModelsCache: AIModelOption[] | null = null

/** /ai/models 的 chat 场景默认模型（{provider_id, model_id}；模块缓存）。 */
export interface AIDefaultModel {
  providerId: string
  modelId: string
}

let aiDefaultModelCache: AIDefaultModel | null = null

/** 场景默认模型引用（宽松归一化 {provider_id, model_id}）。 */
function normalizeAIModelRef(entry: unknown): AIDefaultModel | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const providerId = String(e.provider_id ?? e.providerId ?? '').trim()
  const modelId = String(e.model_id ?? e.modelId ?? '').trim()
  return providerId && modelId ? { providerId, modelId } : null
}

/** 读 chat 场景默认模型（getAIModels 成功后缓存；未配置/未拉取返回 null）。 */
export function getDefaultAIModel(): AIDefaultModel | null {
  return aiDefaultModelCache
}

/** 默认模型 Select 值（`${providerId}/${modelId}`；未配置返回 ''）。 */
export function defaultAIModelKey(): string {
  const d = aiDefaultModelCache
  return d ? `${d.providerId}/${d.modelId}` : ''
}

/** 推理能力标记（宽松匹配 reasoning/think/thinking，大小写不敏感）。 */
const REASONING_CAP_RE = /^(reasoning|think|thinking)$/

/**
 * 宽松归一化 capabilities：数组（['chat','reasoning']）或对象
 * （{chat:true, reasoning:true}，后端 /ai/models 实际格式）→ 展示标签
 * 列表 + 是否支持推理。
 */
function normalizeCapabilities(raw: unknown): { labels: string[]; reasoning: boolean } {
  if (Array.isArray(raw)) {
    const labels = raw.map((c) => String(c).trim()).filter(Boolean)
    return { labels: labels.slice(0, 5), reasoning: labels.some((c) => REASONING_CAP_RE.test(c)) }
  }
  if (raw && typeof raw === 'object') {
    const labels: string[] = []
    let reasoning = false
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val !== true || !key) continue
      labels.push(key)
      if (REASONING_CAP_RE.test(key)) reasoning = true
    }
    return { labels: labels.slice(0, 5), reasoning }
  }
  return { labels: [], reasoning: false }
}

/** 宽松归一化后端模型条目（字段名兼容 provider_id/providerId/provider、model/name 等）。 */
function normalizeAIModel(entry: unknown): AIModelOption | null {
  if (typeof entry === 'string') {
    return entry ? { id: `/${entry}`, providerId: '', providerName: '', model: entry, capabilities: [] } : null
  }
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const providerId = String(e.provider_id ?? e.providerId ?? e.provider ?? '')
  const model = String(e.model ?? e.model_name ?? e.name ?? '')
  if (!model) return null
  const providerName = String(e.provider_name ?? e.providerName ?? providerId)
  const caps = normalizeCapabilities(e.capabilities)
  return {
    id: `${providerId}/${model}`, providerId, providerName, model,
    capabilities: caps.labels, reasoning: caps.reasoning,
    providerKind: String(e.provider_kind ?? e.providerKind ?? '') || undefined,
  }
}

/** 拉取可选模型列表（失败返回空数组；成功后按会话缓存；同时缓存
 *  default_models.chat 供选择器默认选中）。
 *  仅保留对话模型：/ai/models 模型条目的 capabilities 为类型+能力并集
 *  对象（kind 互斥单选 chat/embedding/rerank/image + reasoning/vision/
 *  audio/video 能力——单形态，见 internal/settings/settings.go
 *  AIModelCapabilities）。chat = kind==='chat'；kind!==chat 的条目
 *  （embedding/rerank/image 等）在此过滤，对话选择器（助手/编辑页）
 *  不再出现。 */
function modelChatCapable(raw: unknown): boolean | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    return raw.some((c) => String(c).trim().toLowerCase() === 'chat')
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.kind === 'string' && o.kind) return o.kind === 'chat'
    // kind 缺省视为 chat：与后端 NormalizeAIModelKind 的默认类型语义一致
    //（kind 是单形态必填字段，缺省即取默认值 chat），宽松保留条目。
    return null
  }
  return null
}

export async function getAIModels(force = false): Promise<AIModelOption[]> {
  if (!force && aiModelsCache) return aiModelsCache
  try {
    const res = await authFetch('/api/v1/ai/models')
    if (!res.ok) return []
    const data: unknown = await res.json()
    const d = data as { models?: unknown; providers?: unknown; default_models?: Record<string, unknown> } | null
    // chat 场景默认模型（{chat:{provider_id,model_id}}）→ 模块缓存。
    if (!Array.isArray(data)) {
      const chat = (data as { default_models?: Record<string, unknown> }).default_models?.chat
      aiDefaultModelCache = normalizeAIModelRef(chat)
    }
    let raw: unknown[]
    if (Array.isArray(data)) {
      raw = data
    } else if (Array.isArray(d?.models)) {
      raw = d.models
    } else if (Array.isArray(d?.providers)) {
      // 后端实际格式：{providers:[{id,name,kind,models:[{id,label,capabilities}]}], default_models:{...}}
      raw = (d.providers as Array<Record<string, unknown>>).flatMap((p) => {
        if (!Array.isArray(p.models)) return []
        const pid = String(p.provider_id ?? p.id ?? '')
        const pname = String(p.provider_name ?? p.name ?? pid)
        const pkind = String(p.kind ?? '')
        return (p.models as unknown[]).map((m) => {
          const mo = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
          return { provider_id: pid, provider_name: pname, provider_kind: pkind, model: mo.model ?? mo.model_id ?? mo.id ?? mo.name ?? '', capabilities: mo.capabilities }
        })
      })
    } else {
      raw = []
    }
    const list = raw
      .filter((entry) => modelChatCapable(entry && typeof entry === 'object' ? (entry as Record<string, unknown>).capabilities : undefined) !== false)
      .map(normalizeAIModel)
      .filter((x): x is AIModelOption => x !== null)
    aiModelsCache = list
    return list
  } catch {
    return []
  }
}

// ---------- 平台人设（GET /api/v1/ai/models 的 personas，管理员维护） ----------

/** 平台人设条目（id/name/system_prompt，非敏感明文）。 */
export interface AIPlatformPersonaOption {
  id: string
  name: string
  systemPrompt: string
}

/** 人设选中值前缀（平台条目：`plat:<id>`，与内置/自定义 id 空间隔离）。 */
export const AI_PLATFORM_PERSONA_PREFIX = 'plat:'

let aiPlatformPersonasCache: AIPlatformPersonaOption[] | null = null

/** 宽松归一化后端 personas 条目（字段名兼容 id/name/system_prompt）。 */
function normalizeAIPlatformPersona(entry: unknown): AIPlatformPersonaOption | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const id = String(e.id ?? '').trim()
  const name = String(e.name ?? '').trim()
  if (!id || !name) return null
  return { id, name, systemPrompt: String(e.system_prompt ?? e.systemPrompt ?? '') }
}

/** 拉取平台人设列表（失败返回空数组；成功后按会话缓存）。 */
export async function getAIPlatformPersonas(force = false): Promise<AIPlatformPersonaOption[]> {
  if (!force && aiPlatformPersonasCache) return aiPlatformPersonasCache
  try {
    const res = await authFetch('/api/v1/ai/models')
    if (!res.ok) return []
    const data = (await res.json()) as { personas?: unknown } | null
    const raw = Array.isArray(data?.personas) ? (data?.personas as unknown[]) : []
    const list = raw.map(normalizeAIPlatformPersona).filter((x): x is AIPlatformPersonaOption => x !== null)
    aiPlatformPersonasCache = list
    return list
  } catch {
    return []
  }
}

// ---------- 平台技能模板（GET /api/v1/ai/skills；输入框「技能」按钮） ----------

let aiPlatformSkillsCache: AISkillDef[] | null = null

/** 拉取平台技能模板（失败/未配置返回空数组 → 「技能」按钮隐藏；成功后按会话缓存）。 */
export async function getAIPlatformSkills(force = false): Promise<AISkillDef[]> {
  if (!force && aiPlatformSkillsCache) return aiPlatformSkillsCache
  try {
    const list = await listPlatformSkills()
    aiPlatformSkillsCache = list
    return list
  } catch {
    return []
  }
}

/**
 * 技能 prompt 占位符替换（{selection}=编辑器选区、{file}=当前文件名）：
 * 无对应语境时替换为空字符串，再压缩多余空行（连续 ≥2 个空行折为 1 个）。
 */
export function renderSkillPrompt(prompt: string, opts?: { selection?: string; file?: string }): string {
  return prompt
    .replace(/\{selection\}/g, opts?.selection ?? '')
    .replace(/\{file\}/g, opts?.file ?? '')
    .replace(/(?:[ \t]*\n){3,}/g, '\n\n')
    .trim()
}

/**
 * 「技能模板」按钮（输入框工具行；AIAssistant / AIEditChat 共用）：平台
 * 与个人技能均空（GET /ai/skills + GET /ai/personal/skills）时隐藏；点击弹
 * 技能列表（平台组/个人组分组展示，name + description muted），选中经
 * onPick 由调用方填充输入框——全局助手占位符置空、编辑页做
 * {file}/{selection} 真实替换。
 */
export function AISkillButton({ zh, onPick }: { zh: boolean; onPick: (skill: AISkillDef) => void }) {
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<ChatSkillGroup[]>([])
  useEffect(() => {
    let alive = true
    void listChatSkillGroups().then((list) => {
      if (alive) setGroups(list)
    })
    return () => {
      alive = false
    }
  }, [])
  if (groups.length === 0) return null
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      open={open}
      onOpenChange={setOpen}
      content={
        <div className="ai-attach-pop">
          <div className="ai-attach-list">
            {groups.map((g) => (
              <div key={g.key}>
                {groups.length > 1 && (
                  <div className="ai-attach-state muted" style={{ padding: '4px 8px 0' }}>
                    {g.key === 'personal' ? (zh ? '个人技能' : 'Personal') : zh ? '平台技能' : 'Platform'}
                  </div>
                )}
                {g.skills.map((s) => (
                  <button key={s.id} type="button" className="ai-attach-item ai-skill-item" onClick={() => { setOpen(false); onPick(s) }}>
                    <Zap size={13} strokeWidth={2} aria-hidden="true" className="ai-skill-icon" />
                    <span className="ai-skill-meta">
                      <span className="name" title={s.name}>{s.name}</span>
                      {s.description && <span className="ai-skill-desc" title={s.description}>{s.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="ai-attach-state muted">{zh ? '点击将模板填入输入框' : 'Click a skill to fill the input'}</div>
        </div>
      }
    >
      <Button
        size="small"
        type="text"
        className="ai-attach-btn"
        aria-label={zh ? '技能模板' : 'Skill templates'}
        title={zh ? '技能模板' : 'Skill templates'}
      >
        <Zap size={14} strokeWidth={2} aria-hidden="true" />
      </Button>
    </Popover>
  )
}

// ---------- 联网/思考/MCP 工具开关（三处对话 UI 共用） ----------

/** 模型是否支持推理（宽松读取 capabilities 中的 reasoning/think 标记）。 */
export function modelSupportsReasoning(model: AIModelOption | null | undefined): boolean {
  return model?.reasoning === true
}

// 平台 MCP 可用性探测（GET /ai/mcp 仅启用项）：结果按会话缓存一次；
// 失败/空数组 → false（对话 MCP 开关隐藏）。管理端改配置后刷新页面重新探测。
let aiMCPProbe: Promise<boolean> | null = null

/** 平台是否存在启用中的 MCP 服务（MCP 开关显隐依据）。 */
export function aiMCPToggleAvailable(): Promise<boolean> {
  if (!aiMCPProbe) {
    aiMCPProbe = getAIMCPServices()
      .then((list) => list.length > 0)
      .catch(() => false)
  }
  return aiMCPProbe
}

/** 联网/思考/MCP/我的文件/文件工具开关状态（useAIChatToggles 返回）。 */
export interface AIChatToggleState {
  web: boolean
  think: boolean
  /** 思考开关是否可用（已配置模型且当前模型支持推理）。 */
  thinkEnabled: boolean
  /** 思考不可用原因：'no-models'=未配置模型；'unsupported'=当前模型不支持推理。 */
  thinkBlocked: 'no-models' | 'unsupported' | null
  /** MCP 工具开关（默认关；平台未配置 MCP 时开关隐藏、发送不带 use_mcp）。 */
  mcp: boolean
  /** 平台是否配置了启用中的 MCP 服务（false = 消费点隐藏 MCP 开关）。 */
  mcpAvailable: boolean
  /** 「我的文件」开关（默认开；发送 include_docs；RAG 未启用时恒 false）。 */
  docs: boolean
  /** RAG 是否可用（useAIFeatures().rag；false = 隐藏开关且不发送）。 */
  docsAvailable: boolean
  /** 平台文件工具开关（默认开；发送 use_files，df_* 直接读写工作目录内文件）。 */
  files: boolean
  setWeb: (v: boolean) => void
  setThink: (v: boolean) => void
  setMcp: (v: boolean) => void
  setDocs: (v: boolean) => void
  setFiles: (v: boolean) => void
}

/**
 * 联网/思考/MCP/我的文件开关共享逻辑（AIAssistant / AIEditChat 复用）：
 * - 联网：默认开（后端未配置搜索时静默忽略），持久化 docflow.ai.web；
 * - 思考：所选模型 capabilities 含 reasoning 时默认开，否则关且禁用
 *   （Tooltip 由调用方按 thinkBlocked 提示）；模型切换/列表加载后重估；
 *   持久化 docflow.ai.think 记忆用户显式选择（模型不支持时强制关）；
 * - MCP 工具：默认关，持久化 docflow.ai.mcp；仅平台存在启用中的 MCP
 *   服务（GET /ai/mcp 模块级缓存探测）时显示开关；
 * - 我的文件：默认开，持久化 docflow.ai.docs；发送 include_docs: true
 *   （后端检索引用本人文档；未支持时静默忽略）；useAIFeatures().rag
 *   为 false 时隐藏开关且不发送；
 * - 文件工具：默认开，持久化 docflow.ai.files；发送 use_files（df_* 平台
 *   文件工具，AI 可直接读写工作目录内文件，覆盖自动留版本）；
 * - 未显式选模型（用后端默认）时按「任一可见模型支持推理」宽估；
 * - /ai/models 为空（未配置模型）时思考开关禁用；
 * - 同页多实例经 docflow:ai-flags 事件保持一致。
 */
export function useAIChatToggles(models: AIModelOption[], modelKey: string, opts?: { ready?: boolean }): AIChatToggleState {
  const [web, setWebState] = useState(() => readAIFlag(AI_WEB_STORAGE_KEY) ?? true)
  const [thinkStored, setThinkStored] = useState<boolean | null>(() => readAIFlag(AI_THINK_STORAGE_KEY))
  const [mcp, setMcpState] = useState(() => readAIFlag(AI_MCP_STORAGE_KEY) ?? false)
  const [mcpAvailable, setMcpAvailable] = useState(false)
  const [docs, setDocsState] = useState(() => readAIFlag(AI_DOCS_STORAGE_KEY) ?? true)
  const [files, setFilesState] = useState(() => readAIFlag(AI_FILES_STORAGE_KEY) ?? true)
  // RAG 能力（aiFeature 并行任务提供 {enabled,web_search,mcp,rag}）。
  const features = useAIFeatures()
  const docsAvailable = features.rag === true
  useEffect(() => {
    void aiMCPToggleAvailable().then(setMcpAvailable)
    const onFlags = () => {
      setWebState(readAIFlag(AI_WEB_STORAGE_KEY) ?? true)
      setThinkStored(readAIFlag(AI_THINK_STORAGE_KEY))
      setMcpState(readAIFlag(AI_MCP_STORAGE_KEY) ?? false)
      setDocsState(readAIFlag(AI_DOCS_STORAGE_KEY) ?? true)
      setFilesState(readAIFlag(AI_FILES_STORAGE_KEY) ?? true)
    }
    window.addEventListener(AI_FLAGS_EVENT, onFlags)
    return () => window.removeEventListener(AI_FLAGS_EVENT, onFlags)
  }, [])
  // 模型能力就绪标志（opts.ready，缺省 true 兼容旧调用）：/ai/models 尚未
  // 返回时（加载中）不禁用思考开关（拿到 capabilities 后再判定），避免
  // 「模型支持思考但开关禁用无法开启」的误判。
  const modelsReady = opts?.ready !== false
  const selected = modelKey ? models.find((m) => m.id === modelKey) ?? null : null
  let thinkBlocked: AIChatToggleState['thinkBlocked'] = null
  if (modelsReady) {
    if (models.length === 0) {
      thinkBlocked = 'no-models'
    } else if (!(selected ? modelSupportsReasoning(selected) : models.some((m) => modelSupportsReasoning(m)))) {
      thinkBlocked = 'unsupported'
    }
  }
  return {
    web,
    think: thinkBlocked === null ? (thinkStored ?? true) : false,
    thinkEnabled: thinkBlocked === null,
    thinkBlocked,
    mcp: mcpAvailable ? mcp : false,
    mcpAvailable,
    docs: docsAvailable ? docs : false,
    docsAvailable,
    files,
    setWeb: (v: boolean) => {
      setWebState(v)
      writeAIFlag(AI_WEB_STORAGE_KEY, v)
    },
    setThink: (v: boolean) => {
      setThinkStored(v)
      writeAIFlag(AI_THINK_STORAGE_KEY, v)
    },
    setMcp: (v: boolean) => {
      setMcpState(v)
      writeAIFlag(AI_MCP_STORAGE_KEY, v)
    },
    setDocs: (v: boolean) => {
      setDocsState(v)
      writeAIFlag(AI_DOCS_STORAGE_KEY, v)
    },
    setFiles: (v: boolean) => {
      setFilesState(v)
      writeAIFlag(AI_FILES_STORAGE_KEY, v)
    },
  }
}

/** 联网开关 Tooltip 文案（强调「外部网络」，与「我的文件（RAG）」区分）。 */
export function aiWebTooltip(zh: boolean): string {
  return zh
    ? '联网搜索：访问外部互联网获取最新信息并附来源（不检索平台内文档；后端未配置搜索时自动忽略）'
    : 'Web search: fetch fresh info from the external internet with citations (does not search your platform docs; ignored when not configured server-side)'
}

/** 思考开关 Tooltip 文案（按禁用原因/启用态）。 */
export function aiThinkTooltip(blocked: 'no-models' | 'unsupported' | null, zh: boolean): string {
  if (blocked === 'no-models') return zh ? '未配置模型，暂不可用' : 'No models configured yet'
  if (blocked === 'unsupported') return zh ? '当前模型不支持推理' : 'The current model does not support reasoning'
  return zh
    ? '深度思考：模型先推理再作答（支持推理的模型默认开启）'
    : 'Deep thinking: reason before answering (on by default for reasoning-capable models)'
}

/** MCP 工具开关 Tooltip 文案。 */
export function aiMCPTooltip(zh: boolean): string {
  return zh
    ? 'MCP 工具：调用平台配置的外部 MCP 服务器工具'
    : 'MCP tools: call external MCP server tools configured by the platform'
}

/** 「我的文件（RAG）」开关 Tooltip 文案（强调「平台内文档检索」，与联网搜索区分）。 */
export function aiDocsTooltip(zh: boolean): string {
  return zh
    ? '我的文件（RAG）：仅检索平台内我的文档作为回答依据并附来源，不访问外部网络'
    : 'My files (RAG): retrieve and cite my in-platform documents only, no external internet access'
}

/** 「文件操作」开关 Tooltip 文案（df_* 平台文件工具）。 */
export function aiFilesTooltip(zh: boolean): string {
  return zh
    ? '文件操作：AI 可直接读写工作目录内的文件（自动留版本）'
    : 'File operations: AI can read and write files in the working directory directly (auto versioned)'
}

/** 联网/思考/MCP/我的文件/文件操作小开关组（对话 UI 共用；compact=短标签，用于窄面板）。
 *  开关排列：联网搜索（外部网络）→ 我的文件（RAG，平台内文档检索）相邻成组，
 *  图标与文案明显区分；思考按模型能力显隐；MCP 按平台配置显隐。 */
export function AIChatToggleBar({
  zh,
  web,
  think,
  thinkBlocked,
  mcp,
  mcpAvailable,
  docs,
  docsAvailable,
  files,
  onWeb,
  onThink,
  onMcp,
  onDocs,
  onFiles,
  /** 仅对话模式下隐藏文件操作开关（模式已含其语义；不传 = 正常可用）。 */
  filesDisabled = false,
}: {
  zh: boolean
  web: boolean
  think: boolean
  thinkBlocked: 'no-models' | 'unsupported' | null
  /** MCP 工具开关当前值（平台无 MCP 时恒 false）。 */
  mcp: boolean
  /** 平台是否存在启用中的 MCP 服务（false = 不渲染 MCP 开关）。 */
  mcpAvailable: boolean
  /** 「我的文件」开关当前值（RAG 不可用时恒 false）。 */
  docs: boolean
  /** RAG 是否可用（false = 不渲染「我的文件」开关）。 */
  docsAvailable: boolean
  /** 平台文件工具开关当前值（可选；未传 = 调用方不支持文件工具，不渲染）。 */
  files?: boolean
  onWeb: (v: boolean) => void
  onThink: (v: boolean) => void
  onMcp: (v: boolean) => void
  onDocs: (v: boolean) => void
  /** 文件工具开关回调（可选；未传 = 不渲染该开关，编辑页等场景保持原状）。 */
  onFiles?: (v: boolean) => void
  /** 仅对话模式：隐藏文件操作开关（发送恒 use_files:false，模式已含语义）。 */
  filesDisabled?: boolean
  compact?: boolean
}) {
  // v3.3 图标化：文字全部移入 tooltip（ChatGPT/豆包式工具按钮），激活态
  // primary 染色；aria-label 保留可访问性。签名不变（三处对话 UI 无感）。
  const iconBtn = (
    label: string,
    Icon: typeof Globe,
    on: boolean,
    toggle: () => void,
    tip: ReactNode,
    opts?: { disabled?: boolean; hidden?: boolean },
  ) =>
    opts?.hidden ? null : (
      <Tooltip title={<>{tip}{on ? <div className="ai-tool-tip-state">{zh ? '当前：开' : 'On'}</div> : null}</>}>
        <button
          type="button"
          className={`ai-tool-icon${on ? ' on' : ''}`}
          aria-pressed={on}
          aria-label={label}
          disabled={opts?.disabled}
          onClick={toggle}
        >
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </Tooltip>
    )
  return (
    <span className="ai-toggle-row">
      {iconBtn(zh ? '联网搜索' : 'Web search', Globe, web, () => onWeb(!web), aiWebTooltip(zh))}
      {/* 我的文件（RAG 引用平台内本人文档）；仅 RAG 可用时显示（默认开）。 */}
      {iconBtn(zh ? '我的文件（RAG）' : 'My files (RAG)', FileSearch, docs, () => onDocs(!docs), aiDocsTooltip(zh), { hidden: !docsAvailable })}
      {/* 思考：常显（v3.9——此前模型未勾选 reasoning 能力时整个按钮消失，
          「创作/编辑页没有思考按钮」的主因）；不可用时禁用并 Tooltip 说明。 */}
      {iconBtn(zh ? '深度思考' : 'Deep thinking', Brain, think, () => onThink(!think), aiThinkTooltip(thinkBlocked, zh), {
        disabled: thinkBlocked !== null,
      })}
      {/* MCP 工具：仅平台存在启用中的 MCP 服务时显示（默认关）。 */}
      {iconBtn(zh ? 'MCP 工具' : 'MCP tools', Wrench, mcp, () => onMcp(!mcp), aiMCPTooltip(zh), { hidden: !mcpAvailable })}
      {/* 文件操作（df_* 平台文件工具）：默认开；onFiles 未传/对话模式不渲染。 */}
      {iconBtn(zh ? '文件操作' : 'File operations', FolderCog, files ?? true, () => onFiles?.(!(files ?? true)), aiFilesTooltip(zh), {
        hidden: !onFiles || filesDisabled,
      })}
    </span>
  )
}

// ---------- 联网搜索来源（SSE meta.sources 宽松读取） ----------

/** 联网搜索来源条目（后端字段名宽松归一化）。 */
// ---------- 网络来源 / 工具调用展示（共享 aichat 实现，此处保留兼容导出） ----------

// 网络来源归一化与渲染、工具调用链迁至 components/aichat（三处对话共用），
// 保留原导出名以兼容 AIEditChat 等既有引用。
import { applyToolResult, normalizeWebSources, toolEntryFrom } from './aichat'
import AIChatShell from './aichat/AIChatShell'
import type { ChatMessage } from './aichat/ChatThread'
import type { AIChatTurnData, AIAttachFile } from './aichat'
import AIAttachTree from './aichat/AIAttachTree'
import { useStickyScroll } from './aichat/useStickyScroll'

// ---------- 工作目录选择（df_* 平台文件工具的相对路径基准） ----------

/** 工作目录持久化 key（{spaceId, folderId, name[, path]}；无记忆 = 默认空间根）。 */
export const AI_WORKDIR_STORAGE_KEY = 'docflow.ai.workdir'

/** 工作目录记忆值（folderId 为解析基准；name 供按钮显示、path 供 Tooltip）。 */
export interface AIWorkDir {
  spaceId: string
  folderId: string
  name: string
  /** 全路径「空间名/目录/…」（选目录时生成，Tooltip 展示）。 */
  path?: string
}

/** 读取记忆的工作目录（宽松解析；非法/缺失返回 null = 默认空间根）。 */
function loadAIWorkDir(): AIWorkDir | null {
  try {
    const raw = window.localStorage.getItem(AI_WORKDIR_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<AIWorkDir>
    const spaceId = String(v.spaceId ?? '')
    const folderId = String(v.folderId ?? '')
    const name = String(v.name ?? '')
    if (!spaceId || !folderId || !name) return null
    return { spaceId, folderId, name, path: v.path ? String(v.path) : undefined }
  } catch {
    return null
  }
}

/** 工作目录树合成根节点 key（= 所选空间根目录，parentId null）。 */
const WORKDIR_TREE_ROOT = '__root__'

/** 在树中按 key 追加子节点（懒加载结果合并；无匹配原样返回）。 */
function attachTreeChildren(nodes: DataNode[], key: Key, children: DataNode[]): DataNode[] {
  return nodes.map((n) => (n.key === key
    ? { ...n, children }
    : n.children
      ? { ...n, children: attachTreeChildren(n.children, key, children) }
      : n))
}

/** 在树中查 key 的 title 路径（根 → 节点；未命中返回 null）。 */
function findTreeTitlePath(nodes: DataNode[], key: Key): string[] | null {
  for (const n of nodes) {
    if (n.key === key) return [String(n.title ?? '')]
    if (n.children) {
      const sub = findTreeTitlePath(n.children, key)
      if (sub) return [String(n.title ?? ''), ...sub]
    }
  }
  return null
}

/**
 * 「工作目录」按钮（输入工具行；FolderOpen）：Popover 内 空间 Select
 * （listSpaces）+ 目录懒树（仅目录节点，逐级展开；参考 AIMarkdown 保存
 * 弹窗的树实现）+「跟随当前位置」/「默认空间根」选项。选中目录即生效并
 * 记忆 localStorage（{spaceId, folderId, name}）；显示优先级：手选（固定）
 * > 跟随文件页当前位置（follow，标「跟随：」）> 默认空间根（发送不传
 * work_root）；点「跟随当前位置」清除手选回到跟随态。
 */
function AIWorkDirButton({ value, follow, onFollow, onChange, zh }: { value: AIWorkDir | null; follow: { path: string } | null; onFollow: () => void; onChange: (v: AIWorkDir | null) => void; zh: boolean }) {
  const [open, setOpen] = useState(false)
  const [, setSpacesLoaded] = useState(false)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [treeData, setTreeData] = useState<DataNode[]>([])
  const [err, setErr] = useState('')
  // 各空间根目录 folderId（listSpaceFiles(spaceId, null) 的 parent_id）。
  const rootIdsRef = useRef<Record<string, string>>({})

  // 首次打开拉空间列表。只依赖 open（value/spaceId/spacesLoaded 不进依赖
  // ——任何依赖变化都触发 cleanup→alive=false→setSpaces 被跳过，这是
  // Select 永远"暂无数据"的根因）。已加载标记用 ref 而非 state。
  const valueRef = useRef(value)
  valueRef.current = value
  const spacesLoadedRef = useRef(false)
  useEffect(() => {
    if (!open || spacesLoadedRef.current) return
    spacesLoadedRef.current = true
    setSpacesLoaded(true)
    listSpaces()
      .then((list) => {
        setSpaces(list)
        const cur = spaceId
        if (cur && list.some((s) => s.id === cur)) return
        const v = valueRef.current
        const remembered = v ? list.find((s) => s.id === v.spaceId) : null
        const def = remembered ?? list.find((s) => s.is_default) ?? list[0]
        setSpaceId(def?.id ?? '')
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : (zh ? '空间列表加载失败' : 'Failed to load spaces'))
      })
  }, [open, zh])

  // 空间就绪/切换：重置树（仅合成根节点，展开时懒加载一级目录）。
  useEffect(() => {
    if (!spaceId) return
    setTreeData([{ key: WORKDIR_TREE_ROOT, title: zh ? '空间根目录' : 'Space root' }])
  }, [spaceId, zh])

  /** 懒加载某节点的子目录（仅目录；根节点顺带记录空间根 folderId）。 */
  const loadChildren = async (key: Key): Promise<void> => {
    if (!spaceId) return
    try {
      const parentId = key === WORKDIR_TREE_ROOT ? null : String(key)
      const { files, parent_id } = await listSpaceFiles(spaceId, parentId)
      if (key === WORKDIR_TREE_ROOT && parent_id) rootIdsRef.current[spaceId] = parent_id
      const children: DataNode[] = files
        .filter((f) => f.type === 'folder')
        .map((f) => ({ key: f.id, title: f.name }))
      setTreeData((prev) => attachTreeChildren(prev, key, children.length > 0 ? children : [{ key: `${String(key)}:empty`, title: zh ? '（空）' : '(empty)', disabled: true, isLeaf: true }]))
    } catch (e) {
      setErr(e instanceof Error ? e.message : (zh ? '目录加载失败' : 'Failed to load folders'))
    }
  }

  /** 应用选中目录（根目录的 folderId 未知时补拉一次列表获取 parent_id）。 */
  const applyFolder = async (key: string, title: string): Promise<void> => {
    const spaceName = spaces.find((s) => s.id === spaceId)?.name ?? ''
    let folderId = key
    let dirTitles: string[] = []
    if (key === WORKDIR_TREE_ROOT) {
      if (!rootIdsRef.current[spaceId]) {
        try {
          const { parent_id } = await listSpaceFiles(spaceId, null)
          if (!parent_id) return
          rootIdsRef.current[spaceId] = parent_id
        } catch (e) {
          setErr(e instanceof Error ? e.message : (zh ? '目录加载失败' : 'Failed to load folders'))
          return
        }
      }
      folderId = rootIdsRef.current[spaceId]
      dirTitles = [title]
    } else {
      dirTitles = findTreeTitlePath(treeData, key)?.slice(1) ?? [title]
    }
    onChange({ spaceId, folderId, name: title, path: [spaceName, ...dirTitles].filter(Boolean).join('/') })
    setOpen(false)
  }

  // 树选中态：记忆值在当前空间时高亮其目录，否则不选（默认空间根行激活）。
  const selectedKeys = value && value.spaceId === spaceId ? [value.folderId] : []

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setErr('')
      }}
      overlayStyle={{ zIndex: 1100 }}
      content={
        <div className="ai-workdir-pop">
          <label className="ai-workdir-row">
            <span className="muted">{zh ? '空间' : 'Space'}</span>
            <Select
              size="small"
              value={spaceId || undefined}
              getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
              placeholder={zh ? '选择空间' : 'Select a space'}
              onChange={setSpaceId}
              options={spaces.map((s) => ({ value: s.id, label: s.name }))}
              style={{ flex: 1 }}
            />
          </label>
          <div className="ai-workdir-row">
            <span className="muted">{zh ? '目录' : 'Folder'}</span>
            <Tree
              className="ai-workdir-tree"
              treeData={treeData}
              defaultExpandedKeys={[WORKDIR_TREE_ROOT]}
              selectedKeys={selectedKeys}
              loadData={(node) => loadChildren(node.key)}
              onSelect={(keys) => {
                const k = keys[0]
                if (k === undefined || k === null) return
                const key = String(k)
                if (key.endsWith(':empty')) return
                const titles = findTreeTitlePath(treeData, key)
                const title = key === WORKDIR_TREE_ROOT
                  ? (zh ? '根目录' : 'Root')
                  : (titles?.[titles.length - 1] ?? key)
                void applyFolder(key, title)
              }}
            />
          </div>
          {/* 跟随当前位置：清除手选，随文件页所在空间/目录（无位置时不可选）。 */}
          <button
            type="button"
            className={`ai-workdir-default${!value && follow ? ' active' : ''}`}
            disabled={!follow}
            title={follow
              ? (zh ? `跟随文件页当前位置：${follow.path}` : `Follow the file page location: ${follow.path}`)
              : (zh ? '暂无文件页位置（打开文件页后可用）' : 'No file page location yet (open the Files page first)')}
            onClick={() => {
              onFollow()
              setOpen(false)
            }}
          >
            <Crosshair size={13} strokeWidth={2} aria-hidden="true" />
            <span>{zh ? '跟随当前位置' : 'Follow current location'}</span>
            {!value && follow && <Check size={13} strokeWidth={2} aria-hidden="true" />}
          </button>
          {/* 默认空间根：不指定工作目录（发送不传 work_root，后端回落默认空间根）；
              有跟随位置时按优先级实际生效跟随态（点选 = 清除手选）。 */}
          <button
            type="button"
            className={`ai-workdir-default${!value && !follow ? ' active' : ''}`}
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          >
            <FolderCog size={13} strokeWidth={2} aria-hidden="true" />
            <span>{zh ? '默认空间根（不指定）' : 'Default space root (none)'}</span>
            {!value && !follow && <Check size={13} strokeWidth={2} aria-hidden="true" />}
          </button>
          <div className="ai-attach-state muted">
            {zh ? 'AI 文件操作以所选目录为基准（相对路径）；未手选时跟随文件页位置' : 'AI file operations resolve relative paths against this folder; otherwise follow the Files page location'}
          </div>
          {err && <div className="ai-md-save-error error-text">{err}</div>}
        </div>
      }
    >
      {/* Tooltip 在 Popover 打开期间强制隐藏：弹层覆盖按钮导致 mouseleave
          不触发，Tooltip 残留显示并遮挡弹层内控件（v3.4 修复「空间/目录
          点不动」的根因）。 */}
      <Tooltip open={open ? false : undefined} title={value
        ? (zh ? `工作目录（点击切换）：${value.path || value.name}` : `Working directory (click to change): ${value.path || value.name}`)
        : follow
          ? (zh ? `跟随文件管理位置（点击固定）：${follow.path}` : `Following the Files location (click to pin): ${follow.path}`)
          : (zh ? '工作目录：默认空间根（点击选择）' : 'Working directory: default space root (click to pick)')}>
        <Button
          size="small"
          type="text"
          className="ai-attach-btn ai-workdir-btn"
          aria-label={zh ? '工作目录（点击切换空间 / 目录）' : 'Working directory (click to change)'}
        >
          <FolderOpen size={14} strokeWidth={2} aria-hidden="true" />
          {value ? (
            <span className="ai-workdir-name">{value.path || value.name}</span>
          ) : follow ? (
            <>
              <span className="ai-workdir-tag">{zh ? '跟随' : 'Follow'}</span>
              <span className="ai-workdir-name ai-workdir-follow">{follow.path}</span>
            </>
          ) : (
            <span className="ai-workdir-name ai-workdir-muted">{zh ? '默认空间根' : 'Space root'}</span>
          )}
        </Button>
      </Tooltip>
    </Popover>
  )
}

// ---------- 助手人设（规则；Cherry Studio 式） ----------
// general 不注入任何 system 提示（保持既有默认行为）；custom 使用 localStorage
// 的自定义 system 提示；其余内置人设按语言取词注入。

/** 内置人设表（zhPrompt/enPrompt 为注入的 system 语义）。 */
const AI_PERSONAS = [
  {
    id: 'general', zhLabel: '通用助理', enLabel: 'General', zhPrompt: '', enPrompt: '',
  },
  {
    id: 'writer', zhLabel: '技术写作', enLabel: 'Tech writing',
    zhPrompt: '你是技术写作助手：输出结构清晰、术语准确、简洁克制，擅长大纲、润色与格式规范（Markdown）。',
    enPrompt: 'You are a technical writing assistant: clear structure, precise terminology, concise, good at outlines, polishing and Markdown formatting.',
  },
  {
    id: 'coder', zhLabel: '代码助手', enLabel: 'Code helper',
    zhPrompt: '你是编程助手：代码块标注语言、关键点给出简短解释，主动指出潜在缺陷与边界情况。',
    enPrompt: 'You are a coding assistant: annotate code blocks with language, explain key points briefly, and point out potential defects and edge cases.',
  },
  {
    id: 'reviewer', zhLabel: '文档审校', enLabel: 'Doc reviewer',
    zhPrompt: '你是文档审校助手：逐条检查逻辑、措辞、一致性与格式问题，并给出具体、可执行的修改建议。',
    enPrompt: 'You are a document review assistant: check logic, wording, consistency and formatting item by item, with concrete actionable suggestions.',
  },
  {
    id: 'custom', zhLabel: '自定义', enLabel: 'Custom', zhPrompt: '', enPrompt: '',
  },
] as const

/** 人设持久化 keys。 */
const AI_PERSONA_KEY = 'docflow.ai.persona'
const AI_PERSONA_CUSTOM_KEY = 'docflow.ai.persona.custom'

/** 读取记住的人设（内置 id 或平台前缀值；缺省/非法值回退通用助理）。 */
function loadPersonaId(): string {
  const v = window.localStorage.getItem(AI_PERSONA_KEY) ?? ''
  if (v.startsWith(AI_PLATFORM_PERSONA_PREFIX) || AI_PERSONAS.some((p) => p.id === v)) return v
  return 'general'
}

/**
 * 打开 AI 助手（可选携带当前文件上下文；ask = 打开后立即以检索增强
 * 模式提问——全局搜索框「问 AI」入口使用）。
 */
export function openAIAssistant(context?: AIContextFile, ask?: string): void {
  window.dispatchEvent(new CustomEvent<{ context?: AIContextFile; ask?: string }>('docflow:ai-open', { detail: { context, ask } }))
}

/** 设置 AI 上下文文件（查看页进入时调用，供快捷摘要使用）。 */
export function setAIContextFile(context: AIContextFile | null): void {
  window.dispatchEvent(new CustomEvent<AIContextFile | null>('docflow:ai-context', { detail: context }))
}

interface ChatTurn extends AIChatTurnData {
  /** assistant 回答来源：重试时据此分发（chat 重发最后一问 / summarize 重跑摘要）。 */
  kind?: 'chat' | 'summarize'
  usage?: AIUsage | null
  /** 工具阶段前的中间叙述（v7.7：服务端工具循环会把每轮叙述并入正文，
   *  客户端在首个 tool 事件时把已有正文转为前置说明并清空，最终回答独立呈现）。 */
  prologue?: string[]
}

// ---------- 多会话（历史会话；服务端 ai_conversations 持久化） ----------
// v7.2 起会话存服务端（/api/v1/ai/conversations，source=assistant，
// 跨设备一致）；localStorage docflow.ai.convos.{uid} 仅作首次迁移源
//（服务端为空且本机有历史时一次性上迁）。

/** 会话内持久化消息（role/content/ts + user 回合的引用文件 chips）。 */
export interface AIConvoMessage {
  role: 'user' | 'assistant'
  content: string
  ts: number
  files?: AIAttachFile[]
}

/** 历史会话条目（≤30 个，超出服务端裁最旧；单会话消息 ≤50 条）。 */
export interface AIConvo {
  id: string
  title: string
  updatedAt: number
  messages: AIConvoMessage[]
}

/** 会话数量 / 单会话消息数上限。 */
const AI_CONVO_MAX = 300
const AI_CONVO_MSG_MAX = 50

/** 旧本机存储 key（仅迁移源）。 */
const aiConvosKey = (uid: string) => `docflow.ai.convos.${uid}`

/** 读取本机历史会话（迁移源；宽松解析，损坏条目跳过，按 updatedAt 降序）。 */
function loadAIConvos(uid: string): AIConvo[] {
  try {
    const raw = window.localStorage.getItem(aiConvosKey(uid))
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: AIConvo[] = []
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue
      const e = it as Record<string, unknown>
      const id = String(e.id ?? '')
      if (!id) continue
      const msgs = Array.isArray(e.messages) ? e.messages : []
      out.push({
        id,
        title: String(e.title ?? ''),
        updatedAt: Number(e.updatedAt) || 0,
        messages: msgs
          .map((m) => {
            if (!m || typeof m !== 'object') return null
            const mm = m as Record<string, unknown>
            const role = mm.role === 'assistant' ? 'assistant' : mm.role === 'user' ? 'user' : null
            const content = String(mm.content ?? '')
            return role && content ? { role, content, ts: Number(mm.ts) || 0 } : null
          })
          .filter((m): m is AIConvoMessage => m !== null),
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  } catch {
    return []
  }
}

/** 会话标题：首条用户消息前 16 字（空会话返回空串）。 */
function aiConvoTitleFrom(turns: ChatTurn[]): string {
  const first = turns.find((x) => x.role === 'user' && x.content.trim())
  return first ? first.content.trim().slice(0, 16) : ''
}

/** 顶栏 AI 助手入口按钮（Sparkles；AI 未启用时不渲染）。 */
export function AIAssistantButton() {
  const locale = useLocale()
  const enabled = useAIEnabled()
  if (!enabled) return null
  return (
    <Tooltip title={t(locale, 'aiAssistant')} mouseEnterDelay={0.5}>
      <Button
        type="text"
        className="bell-btn"
        aria-label={t(locale, 'aiAssistant')}
        onClick={() => openAIAssistant()}
      >
        <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
      </Button>
    </Tooltip>
  )
}

/** AI 助手 Drawer 宿主（挂在 App 根部，监听打开事件；未启用不挂载）。 */
export default function AIAssistant() {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const enabled = useAIEnabled()
  const { message } = AntdApp.useApp()
  const [open, setOpen] = useState(false)
  const [context, setContext] = useState<AIContextFile | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [rag, setRag] = useState(false)
  const [busy, setBusy] = useState(false)
  // ---- 批量多选 / 保存到文件（Shell 统一操作行，S10 对齐编辑页）----
  const [batchMode, setBatchMode] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [savingFile, setSavingFile] = useState(false)
  const [saveDialog, setSaveDialog] = useState<{ open: boolean; fileName: string; parentId: string | null; ids?: number[] } | null>(null)
  /** 会话导入 input 引用。 */
  const importInputRef = useRef<HTMLInputElement | null>(null)
  // ---- 体验增强：模型 / 人设 / 文件引用 ----
  const [models, setModels] = useState<AIModelOption[]>([])
  // /ai/models 是否已返回（含空结果）：思考开关禁用态判定前置条件
  // （未加载完成不禁用，拿到 capabilities 后再决定）。
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelKey, setModelKey] = useState(() => {
    try {
      return window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  // 是否用户显式选过模型（localStorage 有记忆）：false 时命中默认模型
  // 以 placeholder「默认（Provider / 模型）」提示而非高亮选中项。
  const [modelExplicit, setModelExplicit] = useState(() => {
    try {
      return (window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? '') !== ''
    } catch {
      return false
    }
  })
  // 联网/思考开关（共享逻辑，AIEditChat 复用同一 hook 与 key）。
  // ready：/ai/models 已返回后才按 capabilities.reasoning 判定禁用/隐藏，
  // 加载期间思考开关保持可用（默认开），避免「支持思考却禁用」误判。
  const toggles = useAIChatToggles(models, modelKey, { ready: modelsLoaded })
  // ---- 助手模式（智能 | 仅对话）：仅对话 = 不注入 df_* 文件工具
  //      （use_files 显式 false）+ 系统提示声明不读写文件；localStorage 记忆。 ----
  const [aiMode, setAiMode] = useState<'smart' | 'chat'>(loadAIMode)
  const chatOnly = aiMode === 'chat'
  const changeAIMode = (v: string | number) => {
    const next: 'smart' | 'chat' = v === 'chat' ? 'chat' : 'smart'
    setAiMode(next)
    try {
      window.localStorage.setItem(AI_MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }
  // ---- 位置跟随（文件页广播的当前空间/目录）：工作目录显示优先级
  //      手选（固定）> 跟随当前位置 > 默认空间根。 ----
  const aiLoc = useAILocation()
  // 贴底跟随 hook（必须在任何早退 return 之前调用——Hooks 规则；dep 由
  // turns 派生，流式增量驱动，用户上滚则不跟随，见 useStickyScroll）。
  const sticky = useStickyScroll(
    turns.length > 0
      ? `${turns[turns.length - 1].id}:${(turns[turns.length - 1].content ?? '').length}:${(turns[turns.length - 1].thinking ?? '').length}`
      : '',
  )
  const aiLocRef = useRef<AILocation | null>(aiLoc)
  aiLocRef.current = aiLoc
  // 各空间根目录 folderId 惰性解析缓存（listSpaceFiles(spaceId,null).parent_id；
  // 跟随态 folderId=null 时发送前解析空间根）。
  const spaceRootIdsRef = useRef<Record<string, string>>({})
  const resolveSpaceRootFolderId = async (spaceId: string): Promise<string | null> => {
    if (spaceRootIdsRef.current[spaceId]) return spaceRootIdsRef.current[spaceId]
    try {
      const { parent_id } = await listSpaceFiles(spaceId, null)
      if (parent_id) spaceRootIdsRef.current[spaceId] = parent_id
      return parent_id ?? null
    } catch {
      return null
    }
  }
  // 跟随态进入空间根时预热根目录 folderId 缓存。
    // 打开抽屉时贴底（历史记录从最底下开始查看）。经 sticky.scrollToBottom
  // 滚内部 scroll-box（直接滚外层 wrap 是空操作——「打开不贴底」的根因），
  // 350/800ms 双延迟等 Drawer 动画与 Bubble.List 渲染完成。
  useEffect(() => {
    if (!open) return
    const t1 = window.setTimeout(() => sticky.scrollToBottom(), 350)
    const t2 = window.setTimeout(() => sticky.scrollToBottom(), 800)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [open, sticky.scrollToBottom])

useEffect(() => {
    if (aiLoc && !aiLoc.folderId && aiLoc.spaceId) void resolveSpaceRootFolderId(aiLoc.spaceId)
  }, [aiLoc])
  // 工作目录（df_* 文件工具相对路径基准）：localStorage 记忆
  // {spaceId, folderId, name}；未选择 = 跟随文件页位置（有）或默认空间根。
  const [workdir, setWorkdir] = useState<AIWorkDir | null>(loadAIWorkDir)
  const selectWorkDir = (w: AIWorkDir | null) => {
    setWorkdir(w)
    try {
      if (w) window.localStorage.setItem(AI_WORKDIR_STORAGE_KEY, JSON.stringify(w))
      else window.localStorage.removeItem(AI_WORKDIR_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
  // ---- 多会话（历史会话；localStorage docflow.ai.convos.{uid}，uid 就绪后载入）----
  const [aiUid, setAiUid] = useState('')
  const [convos, setConvos] = useState<AIConvo[]>([])
  const [convoId, setConvoId] = useState('')
  // 重命名中条目（Modal 输入新标题）。
  const [convoEditing, setConvoEditing] = useState<{ id: string; draft: string } | null>(null)
  const convosRef = useRef<AIConvo[]>([])
  const convoIdRef = useRef('')
  useEffect(() => {
    void getMe().then((m) => setAiUid(m.id)).catch(() => setAiUid(currentUserId() ?? 'anon'))
  }, [])
  // 悬浮窗模式（v7.6）：助手脱离抽屉为独立可拖动/缩放窗口（与编辑页同款，
  // 拖动/缩放/记忆内聚 AIChatShell）。
  const [floatMode, setFloatMode] = useState(() => {
    try {
      return window.localStorage.getItem('docflow.ai.assistant.floatMode') === '1'
    } catch {
      return false
    }
  })
  const toggleFloatMode = () => {
    setFloatMode((v) => {
      const next = !v
      try {
        window.localStorage.setItem('docflow.ai.assistant.floatMode', next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const [personaId, setPersonaId] = useState(loadPersonaId)
  const [customPrompt, setCustomPrompt] = useState(() => {
    try {
      return window.localStorage.getItem(AI_PERSONA_CUSTOM_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [attached, setAttached] = useState<AIAttachFile[]>([])
  // 引用文件弹层：空搜索 = 最近访问文件；非空 = 防抖全文搜索（仅文件）。
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachQuery, setAttachQuery] = useState('')
  const [attachItems, setAttachItems] = useState<Array<{ id: string; name: string }>>([])
  const [attachLoading, setAttachLoading] = useState(false)
  // ---- 平台人设（三源合并：平台 + 内置 + 自定义）----
  const [platformPersonas, setPlatformPersonas] = useState<AIPlatformPersonaOption[]>([])
  // ---- 长期记忆（手动版；/ai/memory，对话恒携带 include_memory）----
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryItems, setMemoryItems] = useState<AIMemoryItem[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  // 服务不可用（503/网络失败）：按钮禁用 + Tooltip 提示（静默降级）。
  const [memoryUnavailable, setMemoryUnavailable] = useState(false)
  const [memoryInput, setMemoryInput] = useState('')
  const [memorySaving, setMemorySaving] = useState(false)
  // 编辑中条目（id + 草稿；经 Modal 编辑，保存 = PUT /ai/memory/:id 原地更新）。
  const [memoryEditing, setMemoryEditing] = useState<{ id: string; draft: string } | null>(null)
  const [memoryNotice, setMemoryNotice] = useState('')
  // 自动记忆（prefs.memory_auto；面板打开时读取，切换时以刚拉的 prefs 整块 PUT）。
  const [memoryAuto, setMemoryAuto] = useState(false)
  const [memoryAutoSaving, setMemoryAutoSaving] = useState(false)
  const memoryPrefsRef = useRef<AIPersonalPrefsView | null>(null)
  const turnsRef = useRef<ChatTurn[]>([])
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const turnSeq = useRef(0)
  const sendRef = useRef<((question: string, forceRag?: boolean, opts?: { regenerate?: boolean }) => void) | null>(null)

  /** setTurns + turnsRef 即时同步（「问 AI」同步清空后立即 send 需读最新会话）。 */
  const applyTurns = (fn: (prev: ChatTurn[]) => ChatTurn[]) => {
    setTurns((prev) => {
      const next = fn(prev)
      turnsRef.current = next
      return next
    })
  }

  /** 按 id 局部更新一条消息（流式回调共用；id 已被清空时静默跳过）。 */
  const updateTurn = (id: number, patch: (turn: ChatTurn) => Partial<ChatTurn>) => {
    applyTurns((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch(x) } : x)))
  }

  /** busy 状态 + ref 同步（事件回调/防重复发送读 ref，避免闭包旧值）。 */
  const setBusyState = (value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }

  // ---- 多会话：uid 就绪后从服务端载入（空则迁移本机历史）并恢复最近一条 ----
  /** 从服务端载入会话列表并恢复最近一条（导入备份后也复用）。 */
  const loadConvos = async () => {
    try {
      let metas = await aiListConversations({ source: 'assistant' })
      // v7.10：清理空壳会话（message_count=0 且无事件——历史部署窗口期事件
      // 写入失败所致）：既消除「点击谁都是欢迎页（看似切换无效）」，也解除
      // 本机历史迁移阻塞（服务端须为空才迁移 localStorage 旧历史）。
      const shellIds = metas.filter((m) => (m.message_count ?? 0) === 0).map((m) => m.id)
      if (shellIds.length > 0) {
        for (const sid of shellIds) void aiDeleteConversation(sid).catch(() => { /* 静默 */ })
        metas = metas.filter((m) => !shellIds.includes(m.id))
      }
      // 首次迁移：服务端为空且本机有旧 localStorage 历史时一次性上迁
      //（最旧→最新创建，保持 updatedAt 顺序），随后重取列表。
      if (metas.length === 0) {
        const local = loadAIConvos(aiUid)
        if (local.length > 0) {
          for (const c of [...local].reverse()) {
            if (!c.messages.length) continue
            const row = await aiCreateConversation({ source: 'assistant' }, c.title || (zh ? '历史会话' : 'Imported'))
            await aiAppendConversation(row.id, 'snapshot', c.messages.slice(-AI_CONVO_MSG_MAX) as unknown as Array<Record<string, unknown>>)
          }
          try { window.localStorage.removeItem(aiConvosKey(aiUid)) } catch { /* ignore */ }
          metas = await aiListConversations({ source: 'assistant' })
        }
      }
      // 列表无正文：恢复最近一条需拉取 messages。
      const list: AIConvo[] = metas.map((m) => ({
        id: m.id, title: m.title, updatedAt: new Date(m.updated_at).getTime(), messages: [],
      }))
      if (list[0]) {
        try {
          const row = await aiGetConversation(list[0].id)
          list[0] = { ...list[0], messages: (row.messages as unknown as AIConvoMessage[]).filter((m) => m && typeof m.content === 'string') }
        } catch { /* 正文拉取失败按空处理 */ }
      }
      convoSyncedLenRef.current = list[0]?.messages.length ?? 0
      convosRef.current = list
      setConvos(list)
      const top = list[0]
      if (top && top.messages.length > 0) {
        convoIdRef.current = top.id
        setConvoId(top.id)
        applyTurns(() => top.messages.map((m) => ({ id: ++turnSeq.current, role: m.role, content: m.content, ...(Array.isArray(m.files) && m.files.length ? { files: m.files } : {}) })))
      }
    } catch {
      // 服务端不可达：保持空会话（不打断助手使用）。
    }
  }
  useEffect(() => {
    if (aiUid) void loadConvos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiUid])

  // 会话写回（服务端）：turns 变化 400ms 防抖（流式逐 token 期间持续重置，
  // done 后落盘）→ 当前会话 PUT messages（无活跃会话先 POST 创建；标题 =
  // 首条用户消息前 16 字，重命名优先）；失败静默（下一轮重试）。列表 metas
  // 本地同步维护（≤30 个），切换时按需拉取正文。
  // 事件模型：新回合完成（400ms 防抖）→ append turn 增量；syncedLen 追踪
  // 已同步条数（清空/删除走 deleteConvo 整删，无部分删除）。
  const convoSyncedLenRef = useRef(0)
  useEffect(() => {
    if (!aiUid) return
    const timer = window.setTimeout(() => {
      const now = Date.now()
      const msgs: AIConvoMessage[] = turns
        .filter((x) => !x.error && x.content.trim())
        .map((x) => ({
          role: x.role,
          content: x.content,
          ts: now,
          // v7.9：user 回合的引用/上传文件随事件持久化（上传附件随会话删除的
          // 依据：files[].upload=true 的条目在会话删除时联动清理文件）。
          ...(x.role === 'user' && x.files && x.files.length > 0 ? { files: x.files } : {}),
        }))
      const synced = convoSyncedLenRef.current
      const persist = msgs.slice(-AI_CONVO_MSG_MAX)
      if (persist.length < synced) {
        const cid = convoIdRef.current
        if (cid && persist.length > 0) {
          void aiAppendConversation(cid, 'snapshot', persist as unknown as Array<Record<string, unknown>>)
            .then(() => { convoSyncedLenRef.current = persist.length })
            .catch(() => { /* 静默重试 */ })
        } else if (cid && persist.length === 0) {
          void aiDeleteConversation(cid).catch(() => { /* 静默 */ })
          convoSyncedLenRef.current = 0
        }
        return
      }
      if (persist.length === synced) return
      const id = convoIdRef.current
      const prev = convosRef.current.find((c) => c.id === id)
      const title = prev?.title || aiConvoTitleFrom(turns) || (zh ? '新对话' : 'New chat')
      const delta = persist.slice(synced)
      void (async () => {
        try {
          let cid = id
          if (!cid || !prev) {
            const row = await aiCreateConversation({ source: 'assistant' }, title)
            cid = row.id
            convoIdRef.current = cid
            setConvoId(cid)
          }
          await aiAppendConversation(cid, 'turn', delta as unknown as Array<Record<string, unknown>>)
          convoSyncedLenRef.current = persist.length
          const rest = [
            { id: cid, title, updatedAt: now, messages: persist },
            ...convosRef.current.filter((c) => c.id !== cid),
          ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, AI_CONVO_MAX)
          convosRef.current = rest
          setConvos(rest)
        } catch {
          /* 服务端写失败静默（下一轮重试） */
        }
      })()
    }, 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, aiUid])

  /** 删除本轮问答（assistant 与其前置最近 user 一并删）；服务端以快照同步。 */
  const deleteExchange = (asstId: number) => {
    if (busyRef.current) return
    applyTurns((prev) => {
      const idx = prev.findIndex((x) => x.id === asstId)
      if (idx < 0) return prev
      let userId: number | string | null = null
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].role === 'user') { userId = prev[i].id; break }
      }
      return prev.filter((x) => x.id !== asstId && x.id !== userId)
    })
  }

  /** 重新生成：按目标回答来源分发（chat=重发其问题 / summarize=重跑摘要）。 */
  const regenerateAsst = (asstId: number) => {
    if (busyRef.current) return
    const prev = turnsRef.current
    const idx = prev.findIndex((x) => x.id === asstId)
    if (idx < 0) return
    if (prev[idx].kind === 'summarize') {
      if (context) void summarizeCurrent(true)
      return
    }
    let question = ''
    for (let i = idx - 1; i >= 0; i--) {
      if (prev[i].role === 'user') { question = prev[i].content; break }
    }
    if (!question) return
    deleteExchange(asstId)
    void send(question)
  }

  // ---- 批量多选（Shell 操作行，与编辑页同款）----
  const toggleChecked = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const exitBatch = () => {
    setBatchMode(false)
    setChecked(new Set())
  }
  const deleteChecked = () => {
    applyTurns((prev) => prev.filter((x) => !checked.has(x.id as number)))
    setChecked(new Set())
  }

  /** 打开保存弹窗（所选或整段会话 → 平台 .md 文件；目录默认工作目录/根）。 */
  const openSaveDialog = (ids?: number[]) => {
    const sel = ids ?? turns.map((x) => x.id as number)
    const list = turns.filter((x) => sel.includes(x.id as number) && x.content.trim())
    if (!list.length) return
    const title = aiConvoTitleFrom(turns) || (zh ? 'AI 会话' : 'AI conversation')
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stampStr = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
    const safe = title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 30)
    setSaveDialog({
      open: true,
      fileName: `${zh ? 'AI会话' : 'AI-conversation'}-${safe || 'session'}-${stampStr}.md`,
      parentId: workdir?.folderId ?? null,
      ids: sel,
    })
  }

  /** 确认保存（上传 .md 到所选目录）。 */
  const confirmSaveFile = async () => {
    if (!saveDialog || savingFile) return
    const sel = saveDialog.ids ?? turns.map((x) => x.id as number)
    const list = turns.filter((x) => sel.includes(x.id as number) && x.content.trim())
    if (!list.length) return
    setSavingFile(true)
    try {
      const title = aiConvoTitleFrom(turns) || (zh ? 'AI 会话' : 'AI conversation')
      const stamp = new Date()
      const lines: string[] = [
        `# ${zh ? 'AI 会话' : 'AI conversation'}：${title}`,
        '',
        `> ${stamp.toLocaleString()} · DocFlow AI 助手`,
        '',
      ]
      for (const x of list) {
        lines.push(x.role === 'user' ? `## 🧑 ${zh ? '用户' : 'User'}` : `## 🤖 ${zh ? 'AI' : 'AI'}`)
        lines.push('')
        lines.push(x.content.trim())
        lines.push('')
      }
      const name = saveDialog.fileName.trim()
      await uploadFile(new File([lines.join('\n')], name, { type: 'text/markdown' }), saveDialog.parentId, () => {})
      setSaveDialog(null)
      void message.success(zh ? `已保存为 ${name}` : `Saved as ${name}`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : (zh ? '保存失败' : 'Save failed'))
    } finally {
      setSavingFile(false)
    }
  }

  /** 导出本域全部会话为 JSON（逐会话拉正文）。 */
  const exportSessionsFile = async () => {
    if (convos.length === 0) return
    try {
      const rows = []
      for (const s of convosRef.current) {
        try {
          const row = await aiGetConversation(s.id)
          rows.push({ title: s.title, updatedAt: s.updatedAt, messages: row.messages })
        } catch { /* 单会话失败跳过 */ }
      }
      const payload = { version: 1, kind: 'docflow-ai-sessions', source: 'assistant', exported_at: new Date().toISOString(), sessions: rows }
      const stamp = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const name = `AI会话备份-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
      void message.success(zh ? `已导出 ${rows.length} 个会话` : `Exported ${rows.length} sessions`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : (zh ? '导出失败' : 'Export failed'))
    }
  }

  /** 导入会话备份：逐会话创建到服务端（合并语义）并刷新列表。 */
  const importSessionsFile = async (file: File | null) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as { sessions?: Array<{ title?: unknown; messages?: unknown }> }
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : []
      if (!list.length) { void message.warning(zh ? '备份中没有会话' : 'No sessions in the backup'); return }
      let imported = 0
      for (const it of list) {
        const title = typeof it?.title === 'string' ? it.title : (zh ? '导入的会话' : 'Imported')
        const messages = Array.isArray(it?.messages) ? (it.messages as Array<Record<string, unknown>>) : []
        if (!messages.length) continue
        const row = await aiCreateConversation({ source: 'assistant' }, title)
        await aiAppendConversation(row.id, 'snapshot', messages.slice(-AI_CONVO_MSG_MAX))
        imported++
      }
      await loadConvos()
      void message.success(zh ? `已导入 ${imported} 个会话` : `Imported ${imported} sessions`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : (zh ? '导入失败（文件格式不正确？）' : 'Import failed (invalid file?)'))
    }
  }

  /** 切换会话：中断进行中的流式请求并恢复目标会话消息（贴底显示最新）；
   *  正文按需从服务端拉取（列表只带元信息）。
   *  v7.6 防御性修复：目标查找回落 convos state（ref/state 理论同步，任何
   *  漂移都不再静默吞掉点击）；点击已激活会话 = 重新拉取正文（视为刷新，
   *  覆盖「列表激活态与实际内容不一致」的状态修复场景）。 */
  const switchConvo = (id: string) => {
    const target = convosRef.current.find((c) => c.id === id) ?? convos.find((c) => c.id === id)
    if (!target) {
      console.warn('[ai-assistant] 切换目标不在会话列表：', id, '（refs', convosRef.current.length, '/ state', convos.length, '条）')
      return
    }
    if (id === convoIdRef.current) return
    abortRef.current?.abort()
    sticky.scrollToBottom()
    convoIdRef.current = id
    setConvoId(id)
    setInput('')
    setAttached([])
    exitBatch()
    if (target.messages.length > 0) {
      convoSyncedLenRef.current = target.messages.length
      applyTurns(() => target.messages.map((m) => ({ id: ++turnSeq.current, role: m.role, content: m.content, ...(Array.isArray(m.files) && m.files.length ? { files: m.files } : {}) })))
      return
    }
    void aiGetConversation(id)
      .then((row) => {
        if (convoIdRef.current !== id) return
        const msgs = (row.messages as unknown as AIConvoMessage[]).filter((m) => m && typeof m.content === 'string')
        convosRef.current = convosRef.current.map((c) => (c.id === id ? { ...c, messages: msgs } : c))
        convoSyncedLenRef.current = msgs.length
        applyTurns(() => msgs.map((m) => ({ id: ++turnSeq.current, role: m.role, content: m.content, ...(Array.isArray(m.files) && m.files.length ? { files: m.files } : {}) })))
      })
      .catch(() => {
        if (convoIdRef.current === id) void message.error(zh ? '会话内容加载失败' : 'Failed to load conversation')
      })
  }

  /** 重命名会话（Modal 输入；空标题忽略）。 */
  const renameConvo = () => {
    const editing = convoEditing
    if (!editing || !editing.draft.trim()) return
    const list = convosRef.current.map((c) => (c.id === editing.id ? { ...c, title: editing.draft.trim().slice(0, 60) } : c))
    convosRef.current = list
    setConvos(list)
    void aiUpdateConversation(editing.id, { title: editing.draft.trim().slice(0, 60) }).catch(() => { /* 服务端失败静默 */ })
    setConvoEditing(null)
  }

  /** 删除会话（确认后；删除当前会话则切到最近一条，无则回到新会话）。 */
  const deleteConvo = (id: string) => {
    const target = convosRef.current.find((c) => c.id === id)
    if (!target) return
    const label = target.title || (zh ? '未命名会话' : 'Untitled')
    if (!window.confirm(zh ? `删除会话「${label}」？删除后不可恢复。` : `Delete conversation "${label}"? This cannot be undone.`)) return
    const list = convosRef.current.filter((c) => c.id !== id)
    convosRef.current = list
    setConvos(list)
    void aiDeleteConversation(id).catch(() => { /* 服务端失败静默 */ })
    if (convoIdRef.current === id) {
      const top = list[0]
      if (top) switchConvo(top.id)
      else newChat()
    }
  }

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ context?: AIContextFile; ask?: string }>).detail
      if (detail?.context) setContext(detail.context)
      setOpen(true)
      if (detail?.ask) {
        // 「问 AI」（搜索框）：打开即清空会话、以检索增强模式提问。
        setRag(true)
        applyTurns(() => [])
        window.setTimeout(() => { sendRef.current?.(detail.ask as string, true) }, 50)
      }
    }
    const onContext = (e: Event) => {
      const detail = (e as CustomEvent<AIContextFile | null>).detail
      setContext(detail)
    }
    window.addEventListener('docflow:ai-open', onOpen)
    window.addEventListener('docflow:ai-context', onContext)
    return () => {
      window.removeEventListener('docflow:ai-open', onOpen)
      window.removeEventListener('docflow:ai-context', onContext)
    }
  }, [])

  // 模型列表：AI 启用即拉取（不等抽屉打开；模块缓存，失败/未配置返回空
  // → 选择器隐藏）。记忆的选择不在列表中（后端配置变更）回退默认；无记忆时
  // 默认选中 default_models.chat（未配置默认则交后端场景默认，选择器显示占位）。
  useEffect(() => {
    if (!enabled) return
    void getAIModels().then((list) => {
      setModels(list)
      setModelsLoaded(true)
      setModelKey((cur) => {
        if (list.length === 0) return cur
        if (cur && list.some((m) => m.id === cur)) return cur
        const dkey = defaultAIModelKey()
        return dkey && list.some((m) => m.id === dkey) ? dkey : ''
      })
    })
    // 平台人设同源拉取（/ai/models 的 personas）：选中条目被管理员删除时
    // 回退通用助理。
    void getAIPlatformPersonas().then((list) => {
      setPlatformPersonas(list)
      setPersonaId((cur) => {
        if (!cur.startsWith(AI_PLATFORM_PERSONA_PREFIX)) return cur
        const pid = cur.slice(AI_PLATFORM_PERSONA_PREFIX.length)
        return list.some((p) => p.id === pid) ? cur : 'general'
      })
    })
  }, [enabled])

  // ---- 长期记忆（手动版）----
  /** 拉取本人记忆列表；失败标记不可用（按钮禁用 + Tooltip，静默降级）。 */
  const refreshMemory = () => {
    setMemoryLoading(true)
    setMemoryUnavailable(false)
    listAIMemory()
      .then((items) => setMemoryItems(items))
      .catch(() => setMemoryUnavailable(true))
      .finally(() => setMemoryLoading(false))
  }

  useEffect(() => {
    if (!enabled || !open || !memoryOpen) return
    refreshMemory()
    // 自动记忆开关现值：面板打开时读取个人偏好（切换时以该 prefs 整块 PUT）。
    getAIPersonalSettings()
      .then((prefs) => {
        memoryPrefsRef.current = prefs
        setMemoryAuto(Boolean(prefs.memory_auto))
      })
      .catch(() => {
        // 读取失败：开关保持现值，切换时经 memoryNotice 提示。
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, open, memoryOpen])

  /** 新增一条记忆（≤2000 字符；空内容忽略）。 */
  const addMemory = async () => {
    const content = memoryInput.trim()
    if (!content || memorySaving) return
    setMemorySaving(true)
    setMemoryNotice('')
    try {
      await createAIMemory(content)
      setMemoryInput('')
      refreshMemory()
    } catch (err) {
      setMemoryNotice(err instanceof Error ? err.message : zh ? '保存失败' : 'Failed to save')
    } finally {
      setMemorySaving(false)
    }
  }

  /** 删除一条记忆。 */
  const removeMemory = async (id: string) => {
    try {
      await deleteAIMemory(id)
      setMemoryItems((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      setMemoryNotice(err instanceof Error ? err.message : zh ? '删除失败' : 'Failed to delete')
    }
  }

  /** 保存编辑（PUT /ai/memory/:id 原地更新内容；成功后刷新列表）。 */
  const saveMemoryEdit = async () => {
    const editing = memoryEditing
    if (!editing || memorySaving) return
    const content = editing.draft.trim()
    if (!content) return
    setMemorySaving(true)
    setMemoryNotice('')
    try {
      await updateAIMemory(editing.id, content)
      setMemoryEditing(null)
      refreshMemory()
    } catch (err) {
      setMemoryNotice(err instanceof Error ? err.message : zh ? '保存失败' : 'Failed to save')
    } finally {
      setMemorySaving(false)
    }
  }

  /** 清空全部记忆（逐条删除；失败单项提示）。 */
  const clearMemory = async () => {
    if (memoryItems.length === 0 || memorySaving) return
    setMemorySaving(true)
    setMemoryNotice('')
    try {
      await Promise.all(memoryItems.map((m) => deleteAIMemory(m.id)))
      setMemoryItems([])
    } catch {
      refreshMemory()
      setMemoryNotice(zh ? '部分记忆删除失败，已刷新列表' : 'Some memories failed to delete; list refreshed')
    } finally {
      setMemorySaving(false)
    }
  }

  /** 切换「自动记忆」：以面板打开时拉的 prefs 整块 PUT（仅改 memory_auto；
   *  失败经 memoryNotice 提示且开关保持原值）。 */
  const toggleMemoryAuto = async (v: boolean) => {
    if (memoryAutoSaving) return
    const base = memoryPrefsRef.current
    if (!base) {
      setMemoryNotice(zh ? '偏好读取失败，暂时无法切换自动记忆' : 'Failed to load preferences; cannot toggle auto memory')
      return
    }
    setMemoryAutoSaving(true)
    setMemoryNotice('')
    try {
      const saved = await putAIPersonalSettings({
        // 视图 → PUT 载荷（api_key 不回显、留空 = 保持现值）。
        providers: base.providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, models: p.models })),
        default_models: base.default_models,
        personas: base.personas,
        prefer_personal: base.prefer_personal,
        memory_auto: v,
      })
      memoryPrefsRef.current = saved
      setMemoryAuto(Boolean(saved.memory_auto))
    } catch (err) {
      setMemoryNotice(err instanceof Error ? err.message : zh ? '保存失败' : 'Failed to save')
    } finally {
      setMemoryAutoSaving(false)
    }
  }

  // 引用文件弹层数据：打开且无关键词 = 最近访问文件；有关键词 = 350ms 防抖
  // 全文检索（仅文件类型）。
  useEffect(() => {
    if (!attachOpen) return
    let alive = true
    const q = attachQuery.trim()
    if (!q) {
      setAttachLoading(true)
      void listFiles(null, { recent: true, limit: 20 })
        .then((files) => {
          if (alive) setAttachItems(files.filter((f) => f.type === 'file').map((f) => ({ id: f.id, name: f.name })))
        })
        .catch(() => {
          if (alive) setAttachItems([])
        })
        .finally(() => {
          if (alive) setAttachLoading(false)
        })
      return () => {
        alive = false
      }
    }
    const timer = window.setTimeout(() => {
      setAttachLoading(true)
      void searchFiles(q, 20)
        .then((results) => {
          if (alive) setAttachItems(results.filter((r) => r.type === 'file').map((r) => ({ id: r.id, name: r.name })))
        })
        .catch(() => {
          if (alive) setAttachItems([])
        })
        .finally(() => {
          if (alive) setAttachLoading(false)
        })
    }, 350)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [attachOpen, attachQuery])

  /** 发送一轮；forceRag 强制检索增强（「问 AI」入口，忽略开关状态）；
   *  regenerate=true 为重试/重新生成——去掉末尾 assistant 回答后重发最后一问，
   *  不再重复追加 user 消息。 */
  const send = async (question: string, forceRag = false, opts: { regenerate?: boolean } = {}) => {
    const text = question.trim()
    if (!text || busyRef.current) return
    const regenerate = opts.regenerate === true
    // 用户发送/重试 = 意图关注最新输出：强制恢复贴底跟随（即便此前上滚阅读）。
    sticky.scrollToBottom()
    setBusyState(true)
    setInput('')
    const prev = turnsRef.current
    const baseTurns = regenerate && prev.length > 0 && prev[prev.length - 1].role === 'assistant' ? prev.slice(0, -1) : prev
    const history: AIMessage[] = baseTurns
      .filter((x) => !x.error && x.content)
      .map((x) => ({ role: x.role, content: x.content }))
    // 纯对话模式：当前提问须并入 messages（首轮历史为空，否则后端
    // 「messages are required」）；RAG 模式后端以 query 为最终提问、
    // messages 仅作历史，故不并入本轮。
    const useRag = rag || forceRag
    const messagesBody: AIMessage[] = useRag ? history : [...history, { role: 'user', content: text }]
    // 前置 system 语义：助手人设（三源：平台 plat: 前缀查表 system_prompt /
    // 内置 / 自定义）；选定模型经 aiChat 的 providerId + model 显式上送
    //（无记忆时即 default_models.chat 默认条目），不再注入 [model:] 前缀。
    const selectedModel = models.find((m) => m.id === modelKey) ?? null
    let personaPrompt = ''
    if (personaId.startsWith(AI_PLATFORM_PERSONA_PREFIX)) {
      const pid = personaId.slice(AI_PLATFORM_PERSONA_PREFIX.length)
      personaPrompt = platformPersonas.find((p) => p.id === pid)?.systemPrompt.trim() ?? ''
    } else {
      const persona = AI_PERSONAS.find((p) => p.id === personaId)
      personaPrompt = !persona || persona.id === 'general'
        ? ''
        : persona.id === 'custom'
          ? customPrompt.trim()
          : (zh ? persona.zhPrompt : persona.enPrompt)
    }
    const sysPrefix: AIMessage[] = []
    // v7.12：输出语言跟随页面语言（思考/过程说明/最终答复）。
    sysPrefix.push({ role: 'system', content: zh
      ? '语言要求：始终使用中文——思考过程、工具间说明与最终答复全部中文（代码/标识符除外）。'
      : 'Language: always reply in English (thinking, process notes and final answer).' })
    if (personaPrompt) sysPrefix.push({ role: 'system', content: personaPrompt })
    // 仅对话模式：系统提示显式声明不读写文件（与 use_files:false 双保险）。
    if (chatOnly) sysPrefix.push({ role: 'system', content: '当前为仅对话模式：不要尝试读写文件' })
    const messages: AIMessage[] = [...sysPrefix, ...messagesBody]
    // 引用文件：本轮上送后清空（气泡记录文件名供回看）；重试/重新生成时
    // 复用最后一问所引用的文件（重发同样上下文）。
    const sendFiles = regenerate
      ? (turnsRef.current.filter((x) => x.role === 'user').slice(-1)[0]?.files ?? [])
      : attached
    if (!regenerate) setAttached([])
    const userId = ++turnSeq.current
    const assistantId = ++turnSeq.current
    applyTurns((p) => {
      const stripped = regenerate && p.length > 0 && p[p.length - 1].role === 'assistant' ? p.slice(0, -1) : p
      return regenerate
        ? [...stripped, { id: assistantId, role: 'assistant', content: '', streaming: true, kind: 'chat' }]
        : [...p, { id: userId, role: 'user', content: text, files: sendFiles.length > 0 ? sendFiles : undefined }, { id: assistantId, role: 'assistant', content: '', streaming: true, kind: 'chat' }]
    })
    const ac = new AbortController()
    abortRef.current = ac
    // 实际生效工作目录：手选（固定）> 跟随文件页位置（空间根 folderId 惰性
    // 解析并缓存）> 默认空间根（不传 work_root）；仅对话模式不传。
    let workRoot: string | undefined = workdir?.folderId
    if (!workdir && aiLocRef.current) {
      const loc = aiLocRef.current
      workRoot = loc.folderId ?? (await resolveSpaceRootFolderId(loc.spaceId)) ?? undefined
    }
    if (chatOnly) workRoot = undefined
    try {
      await aiChat(
        {
          messages,
          providerId: selectedModel?.providerId || undefined,
          // 显式带上所选模型（含默认命中；未配置默认且未选时留空走后端默认）。
          model: selectedModel ? { providerId: selectedModel.providerId, modelId: selectedModel.model } : undefined,
          ragQuery: useRag ? text : undefined,
          fileIds: sendFiles.length > 0 ? sendFiles.map((f) => f.fileId) : undefined,
          // 联网/思考开关：选中时携带（后端未配置/模型不支持时静默忽略）。
          web_search: toggles.web ? true : undefined,
          think: toggles.think ? true : undefined,
          // MCP 工具开关：开启时允许调用平台配置的外部 MCP 服务器工具。
          use_mcp: toggles.mcp ? true : undefined,
          // 长期记忆：恒开启（后端取最近 20 条拼入首条 system；无记忆静默跳过）。
          include_memory: true,
          // 我的文件（RAG 引用本人文档）：默认开（后端就绪前透传、忽略）。
          include_docs: toggles.docs ? true : undefined,
          // 平台文件工具（df_*）：开关显式透传（关闭时传 false 停止注入）；
          // 仅对话模式恒 false（不注入任何文件工具）。
          use_files: chatOnly ? false : toggles.files,
          // 工作目录（相对路径解析基准）：实际生效目录（见上方 workRoot）。
          work_root: workRoot || undefined,
        },
        {
          onMeta: (meta) => {
            // 联网来源：SSE meta.sources 宽松读取（字段名兼容 title/name、url/link）。
            const ws = normalizeWebSources((meta as { sources?: unknown }).sources)
            if (ws.length > 0) updateTurn(assistantId, () => ({ webSources: ws }))
          },
          onDelta: (chunk) => updateTurn(assistantId, (x) => ({ content: x.content + chunk })),
          // 工具调用时：已积累叙述转入 prologue（与工具按时间序交织展示 v7.12d）。
          onTool: (tool) => {
            updateTurn(assistantId, (x) => ({
              prologue: x.content.trim() ? [...(x.prologue ?? []), x.content.trim()] : x.prologue,
              content: x.content.trim() ? '' : x.content,
              toolCalls: [...(x.toolCalls ?? []), toolEntryFrom(tool)],
            }))
          },
          onSources: (sources) => updateTurn(assistantId, () => ({ sources })),
          // 推理思考增量：聚合到独立折叠区（首个增量记录起始时间）。
          onThinking: (text) => updateTurn(assistantId, (x) => ({
            thinking: (x.thinking ?? '') + text,
            thinkingStartedAt: x.thinkingStartedAt ?? Date.now(),
          })),
          // 工具调用生命周期：执行后合并终态/摘要（执行前见上方 onTool 分相处理）。
          onToolResult: (result) => updateTurn(assistantId, (x) => ({ toolCalls: applyToolResult(x.toolCalls ?? [], result) })),
          onDone: (usage) => updateTurn(assistantId, () => ({ usage })),
        },
        ac.signal,
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 用户点击「停止」：保留已生成内容，标记已停止（非错误，可继续输入）。
        updateTurn(assistantId, () => ({ stopped: true }))
      } else {
        const message = err instanceof Error ? err.message : t(locale, 'aiAssistantErr')
        updateTurn(assistantId, () => ({ error: message }))
      }
    } finally {
      // 思考用时定稿（首个增量到流结束）。
      updateTurn(assistantId, (x) => (x.thinkingStartedAt ? { thinkingMS: Math.max(0, Date.now() - x.thinkingStartedAt) } : {}))
      updateTurn(assistantId, () => ({ streaming: false }))
      setBusyState(false)
      if (abortRef.current === ac) abortRef.current = null
    }
  }
  // 事件监听（注册一次）经 ref 调用最新实现（locale/rag 等闭包不过期）。
  useEffect(() => { sendRef.current = send })

  /** 快捷操作：流式总结当前上下文文件（regenerate=true 重试失败的摘要）。 */
  const summarizeCurrent = async (regenerate = false) => {
    const ctx = context
    if (!ctx || busyRef.current) return
    setBusyState(true)
    const assistantId = ++turnSeq.current
    applyTurns((p) => {
      const stripped = regenerate && p.length > 0 && p[p.length - 1].role === 'assistant' ? p.slice(0, -1) : p
      return [
        ...stripped,
        { id: ++turnSeq.current, role: 'user', content: `${t(locale, 'aiAssistantSummarizeCurrent')}：${ctx.fileName}` },
        { id: assistantId, role: 'assistant', content: '', streaming: true, kind: 'summarize' },
      ]
    })
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await aiSummarizeFileStream(
        ctx.fileId,
        (chunk) => updateTurn(assistantId, (x) => ({ content: x.content + chunk })),
        ac.signal,
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        updateTurn(assistantId, () => ({ stopped: true }))
      } else {
        const message = err instanceof Error ? err.message : t(locale, 'aiAssistantErr')
        updateTurn(assistantId, () => ({ error: message }))
      }
    } finally {
      updateTurn(assistantId, () => ({ streaming: false }))
      setBusyState(false)
      if (abortRef.current === ac) abortRef.current = null
    }
  }

  /** 新对话/清空：中断进行中的流式请求并清空当前会话（旧流回调按 id 落空）。
   *  多会话语义：清空 = 清当前会话消息（空会话自动从历史列表移除）；
   *  「新对话」按钮同此（convoId 置空 → 下一条消息开启新会话）。 */
  const newChat = () => {
    abortRef.current?.abort()
    sticky.scrollToBottom()
    convoSyncedLenRef.current = 0
    convoIdRef.current = ''
    setConvoId('')
    applyTurns(() => [])
    exitBatch()
    setInput('')
    setAttached([])
  }

  // ---- 对话内上传附件（v7.9）：隐藏「AI 对话附件」空间 + 随会话删除 ----
  const attachRootRef = useRef<string | null>(null)
  const [uploadingCount, setUploadingCount] = useState(0)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  /** 上传若干文件为对话附件（隐藏空间；上传后作为 chip 随消息发送）。 */
  const uploadAttachments = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    setUploadingCount((n) => n + list.length)
    try {
      if (!attachRootRef.current) {
        const sp = await aiGetAttachmentSpace()
        attachRootRef.current = sp.root_id
      }
      for (const f of list) {
        try {
          const sess = await uploadFile(f, attachRootRef.current, () => {})
          const fid = sess.file_id
          if (!fid) throw new Error(zh ? '上传未完成' : 'upload incomplete')
          void message.success(zh ? `已上传附件：${f.name}` : 'Attachment uploaded')
          setAttached((prev) => [...prev, { fileId: fid, fileName: f.name, upload: true }])
        } catch (err) {
          void message.error(err instanceof Error ? err.message : (zh ? '附件上传失败' : 'Upload failed'))
        } finally {
          setUploadingCount((n) => Math.max(0, n - 1))
        }
      }
    } catch {
      void message.error(zh ? '附件空间不可用' : 'Attachment space unavailable')
      setUploadingCount(0)
    }
  }
  /** 移除附件 chip：上传的附件同时删除文件（隐藏空间内，无其它引用价值）。 */
  const detachAttach = (fileId: string, upload?: boolean) => {
    setAttached((prev) => prev.filter((x) => x.fileId !== fileId))
    if (upload) void deleteFile(fileId).catch(() => { /* 已删/不可删忽略 */ })
  }

  /** 引用文件弹层：多选切换（重复点击取消引用）。 */
  const toggleAttach = (item: { id: string; name: string }) => {
    setAttached((prev) => (prev.some((f) => f.fileId === item.id)
      ? prev.filter((f) => f.fileId !== item.id)
      : [...prev, { fileId: item.id, fileName: item.name }]))
  }

  // AI 未启用（无可用 Provider / 总开关关闭）：不挂载 Drawer。
  if (!enabled) return null

  // 空态建议卡：有上下文文件时第一个为「总结当前文档」（点击即摘要）。
  const suggestions = context
    ? [
        { label: t(locale, 'aiAssistantSummarizeDoc'), onClick: () => void summarizeCurrent() },
        { label: t(locale, 'aiAssistantSuggestExplain'), onClick: () => void send(t(locale, 'aiAssistantSuggestExplain')) },
        { label: t(locale, 'aiAssistantSuggestPolish'), onClick: () => void send(t(locale, 'aiAssistantSuggestPolish')) },
        { label: t(locale, 'aiAssistantSuggestIdeas'), onClick: () => void send(t(locale, 'aiAssistantSuggestIdeas')) },
      ]
    : [
        { label: t(locale, 'aiAssistantSuggestOutline'), onClick: () => void send(t(locale, 'aiAssistantSuggestOutline')) },
        { label: t(locale, 'aiAssistantSuggestExplain'), onClick: () => void send(t(locale, 'aiAssistantSuggestExplain')) },
        { label: t(locale, 'aiAssistantSuggestPolish'), onClick: () => void send(t(locale, 'aiAssistantSuggestPolish')) },
        { label: t(locale, 'aiAssistantSuggestIdeas'), onClick: () => void send(t(locale, 'aiAssistantSuggestIdeas')) },
      ]

  // ---- 渲染（v7.4 S8：AIChatShell 统一 UI；本组件只注入业务回调）----
  // 模式说明（v7.6：经头部模式单按钮 hover 展示）。
  const modeTip = chatOnly
    ? (zh ? '不注入 df_* 文件工具（use_files=false）且系统提示声明不读写文件；联网/思考/MCP/记忆等能力不受影响。' : 'No df_* file tools are injected; web/thinking/MCP/memory still work.')
    : (zh ? 'AI 可经 df_* 平台文件工具直接读写工作目录内文件（自动留版本）；工作目录在下方工具行切换。' : 'The AI can read/write files in the working directory via df_* tools (auto versioned); change the working directory in the toolbar above.')
  const copyContent = (content: string) => {
    void navigator.clipboard.writeText(content)
    void message.success(zh ? '已复制' : 'Copied')
  }

  // Shell 元素（抽屉内嵌 / 独立悬浮窗两态共用同一渲染；v7.6）。
  const shell = (
        <AIChatShell
          open={open}
          zh={zh} hostType="assistant" title={zh ? 'AI 助手' : 'AI Assistant'}
          onClose={() => setOpen(false)}
          messages={turns as unknown as ChatMessage[]}
          emptyHint={t(locale, 'aiAssistantWelcomeHint')}
          emptySlot={(
            <div className="ai-empty">
              <div className="ai-empty-icon" aria-hidden="true">
                <Sparkles size={26} strokeWidth={2} />
              </div>
              <div className="ai-empty-title">{t(locale, 'aiAssistantWelcome')}</div>
              <div className="ai-empty-hint muted">{t(locale, 'aiAssistantWelcomeHint')}</div>
              <div className="ai-suggestions">
                {suggestions.map((s) => (
                  <button key={s.label} type="button" className="ai-suggestion-card" onClick={s.onClick}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          generatingLabel={t(locale, 'aiAssistantGenerating')}
          inputValue={input} onInputChange={setInput}
          onSend={() => void send(input)} onStop={() => abortRef.current?.abort()} busy={busy}
          inputPlaceholder={t(locale, 'aiAssistantPlaceholder')}
          wrapRef={sticky.wrapRef} onScroll={sticky.onScroll}
          sessions={convos} activeSessionId={convoId}
          onSwitchSession={switchConvo}
          onRenameSession={(id) => { const cur = convos.find((c) => c.id === id); if (cur) setConvoEditing({ id: cur.id, draft: cur.title }) }}
          onDeleteSession={deleteConvo} onNewSession={newChat}
          onExportSessions={() => void exportSessionsFile()}
          onImportSessions={() => importInputRef.current?.click()}
          onCopy={copyContent} onDeleteExchange={deleteExchange}
          onSaveConversation={(ids) => openSaveDialog(ids)}
          onRegenerate={regenerateAsst} onContinue={() => {}} onExecutePlan={() => {}}
          savingFile={savingFile}
          mode={chatOnly ? 'chat' : 'edit'} onModeChange={(m) => changeAIMode(m)}
          modeTip={modeTip} showModeSegment
          floatMode={floatMode} onToggleFloat={toggleFloatMode} showCautious={false}
          batchMode={batchMode} onToggleBatch={() => (batchMode ? exitBatch() : setBatchMode(true))}
          checkedIds={checked} onToggleChecked={toggleChecked} onDeleteChecked={deleteChecked}
          packages={[]} pkgId="" onPkgChange={() => {}} applyKind="assistant"
          cautious={false} onCautiousToggle={() => {}}
          attachedFiles={attached} onFileDetach={(fid) => detachAttach(fid, attached.find((x) => x.fileId === fid)?.upload)}
          modelSlot={models.length > 0 ? (
            <AIModelSelect models={models} modelKey={modelKey} modelExplicit={modelExplicit}
              onSelect={(v) => { setModelKey(v); setModelExplicit(true) }} zh={zh} />
          ) : undefined}
          togglesSlot={(
            <AIChatToggleBar zh={zh} web={toggles.web} think={toggles.think} thinkBlocked={toggles.thinkBlocked}
              mcp={toggles.mcp} mcpAvailable={toggles.mcpAvailable} docs={toggles.docs} docsAvailable={toggles.docsAvailable}
              files={toggles.files} filesDisabled={chatOnly}
              onWeb={toggles.setWeb} onThink={toggles.setThink} onMcp={toggles.setMcp}
              onDocs={toggles.setDocs} onFiles={toggles.setFiles} />
          )}
          skillSlot={<AISkillButton zh={zh} onPick={(s) => setInput(renderSkillPrompt(s.prompt))} />}
          belowHeaderSlot={(
            <div className="aiax-toolbar">
              {/* 助手人设（三源合并：平台 plat: 前缀 → 内置 → 自定义）。 */}
              <Select
                className="aiax-persona"
                size="small"
                value={personaId}
                aria-label={zh ? '助手人设' : 'Assistant persona'}
                onChange={(v) => {
                  setPersonaId(v)
                  try {
                    window.localStorage.setItem(AI_PERSONA_KEY, v)
                  } catch {
                    /* ignore */
                  }
                }}
                options={[
                  ...platformPersonas.map((p) => ({
                    value: `${AI_PLATFORM_PERSONA_PREFIX}${p.id}`,
                    label: (
                      <span className="aiax-persona-option">
                        <span className="aiax-persona-option-name">{p.name}</span>
                        <span className="aiax-persona-platform-tag">{zh ? '平台' : 'Platform'}</span>
                      </span>
                    ),
                  })),
                  ...AI_PERSONAS.map((p) => ({ value: p.id, label: zh ? p.zhLabel : p.enLabel })),
                ]}
              />
              {personaId === 'custom' && (
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  arrow={false}
                  content={
                    <div className="aiax-persona-pop">
                      <div className="muted">{zh ? '自定义 system 提示（保存在本机，随对话作为首条 system 语义发送）' : 'Custom system prompt (stored locally, sent as the leading system message)'}</div>
                      <Input.TextArea
                        rows={4}
                        maxLength={2000}
                        value={customPrompt}
                        onChange={(e) => {
                          setCustomPrompt(e.target.value)
                          try {
                            window.localStorage.setItem(AI_PERSONA_CUSTOM_KEY, e.target.value)
                          } catch {
                            /* ignore */
                          }
                        }}
                        placeholder={zh ? '例如：你是一名严谨的财务分析助手，回答须给出数据来源与假设。' : 'e.g. You are a meticulous financial analyst…'}
                      />
                    </div>
                  }
                >
                  <Button size="small" type="text" className="aiax-head-btn" aria-label={zh ? '编辑自定义人设' : 'Edit custom persona'}>
                    <PencilLine size={13} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Popover>
              )}
              {/* 工作目录（df_* 文件工具基准）：手选（固定）> 跟随文件页当前位置 > 默认空间根。 */}
              <AIWorkDirButton
                value={workdir}
                follow={!workdir && aiLoc ? { path: aiLoc.path } : null}
                onFollow={() => selectWorkDir(null)}
                onChange={selectWorkDir}
                zh={zh}
              />
              <span className="aiax-toolbar-gap" />
              {/* 长期记忆（手动版）：书签弹层管理本人记忆；服务不可用静默禁用。 */}
              <Tooltip title={memoryUnavailable
                ? (zh ? '记忆服务暂不可用' : 'Memory is unavailable')
                : (zh ? '长期记忆：手动维护个人偏好要点，随每轮对话注入' : 'Long-term memory: manually maintained, injected into every chat')}>
                <Popover
                  trigger="click"
                  placement="bottomRight"
                  arrow={false}
                  open={memoryOpen}
                  onOpenChange={(next) => {
                    // 编辑弹窗打开期间忽略外点关闭（Modal 挂载于 body，点击会命中 Popover 外部）。
                    if (!next && memoryEditing) return
                    setMemoryOpen(next)
                    if (!next) { setMemoryEditing(null); setMemoryNotice('') }
                  }}
                  content={
                    <div className="ai-memory-pop">
                      {/* 自动记忆开关（prefs.memory_auto）：AI 自动从对话中提取长期偏好。 */}
                      <div className="ai-memory-auto">
                        <div className="ai-memory-auto-row">
                          <Switch size="small" checked={memoryAuto} loading={memoryAutoSaving} onChange={(v) => void toggleMemoryAuto(v)} />
                          <span>{zh ? '自动记忆' : 'Auto memory'}</span>
                        </div>
                        <span className="muted">{zh ? 'AI 自动从对话中提取长期偏好' : 'AI extracts long-term preferences from chats automatically'}</span>
                      </div>
                      <div className="muted">
                        {zh ? '长期记忆（手动维护，仅本人可见）：对话时取最近 20 条注入，帮助 AI 记住你的偏好与要点。' : 'Long-term memory (manually maintained, private): the latest 20 items are injected into every chat.'}
                      </div>
                      <div className="ai-memory-list">
                        {memoryLoading && <div className="ai-attach-state muted">{zh ? '加载中…' : 'Loading…'}</div>}
                        {!memoryLoading && memoryItems.length === 0 && (
                          <div className="ai-attach-state muted">{zh ? '暂无记忆，添加第一条吧' : 'No memories yet'}</div>
                        )}
                        {memoryItems.map((m) => (
                          <div key={m.id} className="ai-memory-item">
                            {/* 自动记忆（AI 从对话提取）标「自动」；manual 维持现状。 */}
                            {m.kind === 'auto' && <Tag color="blue" className="ai-memory-auto-tag">{zh ? '自动' : 'Auto'}</Tag>}
                            <span className="ai-memory-item-content" title={m.content}>{m.content}</span>
                            <span className="ai-memory-item-actions">
                              <Tooltip title={zh ? '编辑' : 'Edit'}>
                                <Button size="small" type="text" aria-label={zh ? '编辑记忆' : 'Edit memory'} onClick={() => setMemoryEditing({ id: m.id, draft: m.content })}>
                                  <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                                </Button>
                              </Tooltip>
                              <Tooltip title={zh ? '删除' : 'Delete'}>
                                <Button size="small" type="text" aria-label={zh ? '删除记忆' : 'Delete memory'} onClick={() => void removeMemory(m.id)}>
                                  <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                                </Button>
                              </Tooltip>
                            </span>
                          </div>
                        ))}
                      </div>
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 4 }}
                        maxLength={2000}
                        value={memoryInput}
                        onChange={(e) => setMemoryInput(e.target.value)}
                        placeholder={zh ? '新增一条记忆（如：偏好简洁中文回答、术语表…）' : 'Add a memory (e.g. prefer concise answers…)'
                        }
                      />
                      <div className="ai-memory-footer">
                        <Popconfirm
                          title={zh ? '清空全部记忆？' : 'Clear all memories?'}
                          okText={zh ? '清空' : 'Clear'}
                          cancelText={zh ? '取消' : 'Cancel'}
                          disabled={memoryItems.length === 0 || memorySaving}
                          onConfirm={() => void clearMemory()}
                        >
                          <Button size="small" danger disabled={memoryItems.length === 0 || memorySaving}>
                            {zh ? '清空' : 'Clear all'}
                          </Button>
                        </Popconfirm>
                        <Button size="small" type="primary" loading={memorySaving} disabled={!memoryInput.trim()} onClick={() => void addMemory()}>
                          {zh ? '添加' : 'Add'}
                        </Button>
                      </div>
                      {memoryNotice && <div className="ai-memory-notice error-text">{memoryNotice}</div>}
                    </div>
                  }
                >
                  <Button
                    size="small"
                    type="text"
                    className="aiax-head-btn"
                    disabled={memoryUnavailable}
                    aria-label={zh ? '长期记忆' : 'Long-term memory'}
                  >
                    <BookMarked size={14} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </Popover>
              </Tooltip>
            </div>
          )}
          extraToolbarSlot={(
            <>
              {/* 文件检索（会话级检索增强，ragQuery 通道）：开启后整轮回答
                  基于我可见文件的全文检索并附来源链接。与「联网」（外部网络）/
                  「文件RAG」（回答附带引用）语义不同。 */}
              <Tooltip title={<>{t(locale, 'aiAssistantRAGHint')}{rag ? <div className="ai-tool-tip-state">{zh ? '当前：开' : 'On'}</div> : null}</>}>
                <button
                  type="button"
                  className={`ai-tool-icon${rag ? ' on' : ''}`}
                  aria-pressed={rag}
                  aria-label={zh ? '文件检索' : 'File RAG'}
                  onClick={() => setRag(!rag)}
                >
                  <Search size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
              {/* 引用文件（最近访问 / 全文搜索 / 目录树，多选为 chip）。 */}
              <Popover
                trigger="click"
                placement="topLeft"
                arrow={false}
                open={attachOpen}
                onOpenChange={(next) => {
                  setAttachOpen(next)
                  if (next) setAttachQuery('')
                }}
                content={
                  <div className="ai-attach-pop">
                    {/* v7.9：直接上传附件（隐藏「AI 对话附件」空间，不进文件管理，
                        随会话删除）。 */}
                    <div className="ai-attach-upload-row">
                      <button type="button" className="ai-attach-upload" disabled={uploadingCount > 0}
                        onClick={() => uploadInputRef.current?.click()}>
                        <Upload size={13} strokeWidth={2} aria-hidden="true" />
                        <span>{uploadingCount > 0 ? (zh ? `上传中（${uploadingCount}）…` : `Uploading (${uploadingCount})…`) : (zh ? '上传文件为本轮附件' : 'Upload as attachment')}</span>
                      </button>
                      <span className="muted ai-attach-upload-hint">{zh ? '不入文件管理 · 随会话删除' : 'Not in files · removed with chat'}</span>
                    </div>
                    <input ref={uploadInputRef} type="file" multiple style={{ display: 'none' }}
                      onChange={(e) => { const fs = e.target.files; if (fs && fs.length) void uploadAttachments(fs); e.target.value = '' }} />
                    <Input
                      allowClear
                      size="small"
                      value={attachQuery}
                      onChange={(e) => setAttachQuery(e.target.value)}
                      placeholder={zh ? '搜索文件（留空 = 目录树浏览）' : 'Search files (blank = browse tree)'}
                      prefix={<Paperclip size={12} strokeWidth={2} aria-hidden="true" />}
                    />
                    {attachQuery.trim() ? (
                      <div className="ai-attach-list">
                        {attachLoading && <div className="ai-attach-state muted">{zh ? '加载中…' : 'Loading…'}</div>}
                        {!attachLoading && attachItems.length === 0 && (
                          <div className="ai-attach-state muted">{zh ? '没有匹配的文件' : 'No matching files'}</div>
                        )}
                        {attachItems.map((item) => {
                          const selected = attached.some((f) => f.fileId === item.id)
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={`ai-attach-item${selected ? ' selected' : ''}`}
                              onClick={() => toggleAttach(item)}
                            >
                              <FileText size={13} strokeWidth={2} aria-hidden="true" />
                              <span className="name" title={item.name}>{item.name}</span>
                              <Check size={13} strokeWidth={2} aria-hidden="true" className="check" />
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <AIAttachTree
                        zh={zh}
                        spaceId={(workdir?.spaceId ?? aiLoc?.spaceId) || ''}
                        rootFolderId={workdir?.folderId ?? aiLoc?.folderId ?? null}
                        selected={attached}
                        onToggle={(f) => toggleAttach({ id: f.fileId, name: f.fileName })}
                      />
                    )}
                    <div className="ai-attach-state muted">{zh ? '引用文件将作为本条消息的上下文发送' : 'Referenced files are sent as context'}</div>
                  </div>
                }
              >
                <Button
                  size="small"
                  type="text"
                  className="ai-attach-btn"
                  aria-label={zh ? '引用文件' : 'Attach files'}
                  title={zh ? '引用文件' : 'Attach files'}
                >
                  <Paperclip size={14} strokeWidth={2} aria-hidden="true" />
                </Button>
              </Popover>
            </>
          )}
        />
  )

  return (
    <>
      {/* v7.7 两态：悬浮窗（独立可拖动/缩放窗口，无遮罩）/ 抽屉（标准遮罩）。 */}
      {floatMode
        ? (open ? shell : null)
        : (
      <Drawer
        placement="right"
        /* antd 6：width 已弃用，size 接受数字像素（窄屏 100% 全宽经 rootClassName 媒体查询保留）。 */
        size={480}
        open={open}
        onClose={() => setOpen(false)}
        rootClassName="ai-drawer-root"
        /* 头部由 AIChatShell 渲染（Drawer 自带头部隐藏）。 */
        closable={false}
        styles={{ header: { display: 'none' }, body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      >
        {shell}
      </Drawer>
        )}

      <input ref={importInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
        onChange={(e) => { void importSessionsFile(e.target.files?.[0] ?? null); e.target.value = '' }} />

      {saveDialog?.open && (
        <Modal title={zh ? '保存会话到文件' : 'Save conversation to file'} onClose={() => setSaveDialog(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{zh ? '文件名' : 'File name'}</div>
              <Input value={saveDialog.fileName} onChange={(e) => setSaveDialog({ ...saveDialog, fileName: e.target.value })} />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {zh ? '保存目录' : 'Save to'}：{saveDialog.parentId ? (zh ? 'AI 工作目录' : 'AI working directory') : (zh ? '默认空间根' : 'Default space root')}
            </div>
          </div>
          <div className="modal-actions">
            <Button type="primary" disabled={!saveDialog.fileName.trim()} loading={savingFile} onClick={() => void confirmSaveFile()}>{zh ? '保存' : 'Save'}</Button>
            <Button onClick={() => setSaveDialog(null)}>{zh ? '取消' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}

      {/* 重命名会话弹窗（空标题忽略）。 */}
      {convoEditing && (
        <Modal title={zh ? '重命名会话' : 'Rename conversation'} onClose={() => setConvoEditing(null)}>
          <Input
            value={convoEditing.draft}
            maxLength={60}
            onChange={(e) => setConvoEditing((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
            onPressEnter={renameConvo}
            placeholder={zh ? '输入新的会话标题' : 'Enter a new title'}
          />
          <div className="modal-actions">
            <Button type="primary" disabled={!convoEditing.draft.trim()} onClick={renameConvo}>
              {zh ? '确定' : 'OK'}
            </Button>
            <Button onClick={() => setConvoEditing(null)}>{zh ? '取消' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}

      {/* 编辑记忆弹窗（PUT /ai/memory/:id 原地更新；失败走面板 memoryNotice 提示）。 */}
      {memoryEditing && (
        <Modal title={zh ? '编辑记忆' : 'Edit memory'} onClose={() => setMemoryEditing(null)}>
          <Input.TextArea
            rows={4}
            maxLength={2000}
            value={memoryEditing.draft}
            onChange={(e) => setMemoryEditing((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
          />
          <div className="modal-actions">
            <Button type="primary" loading={memorySaving} disabled={!memoryEditing.draft.trim()} onClick={() => void saveMemoryEdit()}>
              {zh ? '确定' : 'OK'}
            </Button>
            <Button onClick={() => setMemoryEditing(null)}>{zh ? '取消' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}
    </>
  )
}
