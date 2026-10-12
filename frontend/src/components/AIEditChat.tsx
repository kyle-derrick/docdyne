// 编辑器页「AI 对话」侧栏面板（v7.4：Agent 工具循环为唯一通道）：
// - AIEditChatButton：头部入口（Sparkles，AI 未启用不渲染；下拉快捷指令）；
// - AIEditChat：Monaco/富文本/白板/drawIO 编辑页共用。宿主经 agentTools
//   注入编辑工具集 + agentSystemExtra 注入宿主规范，三种模式：
//   可修改=TOOL_CALL 工具循环（预算 300 轮、上下文压缩、同参连败熔断、
//   达限「继续」）；计划=只读子集探查产出执行计划一键执行；仅对话=纯问答。
// - 过程 TraceView 分阶段折叠（思考段/工具条目 + 用量汇总）；会话服务端
//   持久化（按文件分域，ConvoPicker 统一选择器：搜索/切换/重命名/删除）；
// - 消息操作：复制/删除问答对/保存到文件/重新生成/批量多选/导入导出。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { App as AntdApp, Button, Input } from 'antd'
import { Modal } from './FileBrowser'
import type { MenuProps } from 'antd'
import SplitButton from './SplitButton'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import { Sparkles } from 'lucide-react'
import { aiAppendConversation, getAIModelsRaw, aiChat, aiCreateConversation, aiDeleteConversation, aiGetConversation, aiListConversations, aiUpdateConversation, getFileMeta, uploadFile } from '../api'
import type { AIConvoMeta } from '../api'
import type { AIMessage } from '../api'
import { AIChatToggleBar, AISkillButton, normalizeWebSources, AI_MODEL_STORAGE_KEY, defaultAIModelKey, getAIModels, renderSkillPrompt, useAIChatToggles } from './AIAssistant'
import type { TraceStage, TraceUsage } from './aichat/TraceView'
import { useStickyScroll } from './aichat/useStickyScroll'
import AIChatShell from './aichat/AIChatShell'
import type { ChatMessage } from './aichat/ChatThread'
import type { AIAttachFile } from './aichat'
import type { AIToolCallEntry } from './aichat'
import type { AIModelOption, AIWebSource } from './AIAssistant'
import AIModelSelect from './AIModelSelect'
import { useAIEnabled } from '../aiFeature'
import { t, useLocale } from '../i18n'
/** 选区描述（无选区 = 全文模式；原独立 AIEdit.tsx 移除后迁此）。 */
export interface AIEditTarget {
  text: string
  hasSelection: boolean
}

/** 宿主注册的编辑工具（v5 内置 Agent 模式）：name/描述进 system，
 * exec 在宿主编辑器上执行并返回结构化结果（ok=false 时错误回喂 AI）。 */
export interface AIEditTool {
  name: string
  /** 工具说明（签名与语义，写入 system 提示）。 */
  desc: string
  /** 参数摘要展示（工具链 UI 的 label）。 */
  label: (args: Record<string, unknown>) => string
  /** 破坏性操作（删除/整篇替换等）：谨慎模式开启时执行前弹确认。 */
  destructive?: boolean
  exec: (args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
}

/** 上下文（选区/全文）送入模型的最大长度（超限截取头部并在消息中注明）。 */
const MAX_CONTEXT_CHARS = 6000

/** 随每轮携带的问答历史轮数（每轮独立重建上下文）。 */
const HISTORY_ROUNDS = 2

/** Agent 模式 system 提示词的宿主名（按 applyKind）。 */
function agentHostLabel(kind: AIApplyKind): string {
  return kind === 'excalidraw-json'
    ? 'Excalidraw 白板'
    : kind === 'drawio-xml'
      ? 'draw.io 图表'
      : kind === 'richtext-patch'
        ? '富文本文档'
        : '文本编辑器'
}

/** 面板模式：edit=可修改（自动应用+版本保护）；chat=仅对话（纯输出）；
 * plan=计划（opencode 式：只读工具探查并输出执行计划，一键转入执行）。 */
type ChatMode = 'edit' | 'chat' | 'plan'

/** 只读工具判定（计划模式可用的工具子集：探查类，不改文档）。 */
const READONLY_TOOL_RE = /^(read_|search_|list_|get_|find_)/

/** Agent 会话压缩视图（pi/opencode 式滑动窗口）：超过 60 条时丢弃中段
 *  （保留 system+首问+最近 36 条）并注入压缩说明，尾段内较旧的
 *  TOOL_RESULT 正文截短（结构保留）。只影响发给模型的视图，不改写原始
 *  convo（「继续」恢复仍基于全量）——300 轮预算下防上下文爆窗的关键。 */
function agentConvoView(convo: AIMessage[]): AIMessage[] {
  if (convo.length <= 60) return convo
  const keepTail = 36
  const head = convo.slice(0, 2)
  const tail = convo.slice(-keepTail)
  const dropped = convo.length - head.length - tail.length
  const shrink = (m: AIMessage): AIMessage =>
    m.role === 'user' && m.content.startsWith('TOOL_RESULT ') && m.content.length > 600
      ? { ...m, content: `${m.content.slice(0, 300)}…（已压缩，原 ${m.content.length} 字）` }
      : m
  const note: AIMessage = { role: 'user', content: `（系统注：此前 ${dropped} 条历史消息已压缩省略——如需早期信息请用读工具重新获取）` }
  return [...head, note, ...tail.slice(0, 8).map(shrink), ...tail.slice(8)]
}

/** 应用通道类型（默认 text 行为完全不变）：
 * - text：写作助手（回复=最终文本，选区替换/文末追加）；
 * - excalidraw-json：白板页——AI 只回 excalidraw 元素 JSON 数组（骨架），
 *   宿主经官方 convertToExcalidrawElements 补全为正式元素插入画布；
 * - drawio-xml：drawio 页——AI 基于当前 XML 回完整 drawio XML，宿主整体
 *   替换画布内容。两者均无选区概念，统一走 onApply('replace')；
 * - richtext-patch：富文本页——指令式编辑（Cursor/Notion AI 形态）：AI 回
 *   ```docflow-edit 围栏内的 JSON 编辑指令数组（replace/insert/delete/
 *   replaceAll），宿主执行器（DfdocEditorPage.applyRichTextPatch）在
 *   ProseMirror 文档中按定位原文精确匹配逐条执行；围栏缺失时宿主回落
 *   追加。回复原文经 onApply('replace') 透传，解析在宿主侧。 */
export type AIApplyKind = 'text' | 'excalidraw-json' | 'drawio-xml' | 'richtext-patch'

/** 从 AI 回复中提取 excalidraw 元素 JSON 源码：优先 ```excalidraw-json 围栏；
 * 其次任意围栏代码块内容以 [ 开头；最后裸数组（trim 后 [ 起 ] 止）。
/** drawio-xml 通道 system 指令附加的 XML 生成参考（吸收 jgraph/drawio-mcp
 * 官方指南精编，≤45 行）。技术规范统一英文——模型对英文 XML 约定遵循更稳，
 * 双语 intro 仍按现有 locale 机制（见 send()）。仅增强提示词，不影响
 * extractDrawioXML/应用逻辑。导出供宿主页（DrawioPage Agent 工具循环）
 * 复用作 insert_cells/replace_diagram 载荷格式规范。 */
export const DRAWIO_XML_GUIDE = `drawio XML quick reference:
- Structure: prefer the simplified form <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>...cells...</root></mxGraphModel> (drawio auto-wraps mxfile/diagram; a full <mxfile>...</mxfile> is also accepted).
- Node (shape): <mxCell id="2" value="Label" style="..." vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>.
- Edge (connector): <mxCell id="5" value="Yes" style="..." edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>; define endpoint nodes first, then reference their ids via source/target.
- Common styles: rounded=1;whiteSpace=wrap;html=1; (rounded box) / ellipse;whiteSpace=wrap;html=1; (oval) / rhombus;whiteSpace=wrap;html=1; (decision diamond) / text;html=1; (plain label); edges default to edgeStyle=orthogonalEdgeStyle;rounded=0;. Tune with fillColor / strokeColor / fontSize / fontStyle=1 (bold).
- Layout: pick left-to-right or top-down flow; keep node gaps >=40; main-flow step 160-200, branch step 100 on the cross axis; put branch labels ("Yes"/"No") in the edge value.
- ids: incrementing numeric strings "2","3",...; keep id="0" (root) and id="1" (default parent) fixed; every cell gets parent="1" unless grouping.
- Edge integrity (mandatory): source/target MUST reference ids of cells defined in the SAME model, preferably defined BEFORE the edge; never invent or forward-reference missing ids; an edge with no valid endpoints must be omitted. Every vertex MUST carry an explicit <mxGeometry> with concrete x/y/width/height — never rely on defaults.
- Overlap (mandatory): never let two node boxes intersect; align on a grid (x/y multiples of 20), keep >=40px spacing in both axes.
- Editing an existing diagram: keep the ids of unchanged elements and only modify their style/geometry/value, or add/remove cells; never renumber the whole model.
- The XML must be well-formed; escape < > & " ' inside value attributes.`

/** excalidraw-json 通道 system 指令附加的元素 JSON 生成规范（以本地
 * @excalidraw/excalidraw 0.17.6 的 types/element/types.d.ts 字段定义与
 * types/data/transform.d.ts 的骨架（ExcalidrawElementSkeleton）契约为准
 * 精编：AI 只需输出骨架字段，前端经官方 convertToExcalidrawElements
 * 自动补全 seed/versionNonce/文本量宽/绑定端点等派生字段）。技术规范
 * 统一英文（同 DRAWIO_XML_GUIDE 约定）。导出供宿主页（ExcalidrawPage
 * Agent 工具循环）复用作 insert_elements 载荷格式规范。 */
export const EXCALIDRAW_JSON_GUIDE = `Excalidraw elements JSON quick reference (element skeletons):
- Output ONE \`\`\`excalidraw-json fenced block containing a JSON ARRAY of element objects; no text outside the fence.
- Every element object MUST have "type" and numeric "x"/"y". Give each element a short unique string "id" (e.g. "n1","n2") so arrows can reference nodes; other elements may reference an id via start/end.
- Shape types (all accept optional strokeColor/backgroundColor/fillStyle/roughness/strokeWidth/strokeStyle/opacity/roundness):
  - {"type":"rectangle","id","x","y","width","height","label":{"text":"Centered label","fontSize":20}} — rounded box; label auto-centers inside.
  - {"type":"diamond",...same fields} — decision diamond; use bigger width/height for long labels.
  - {"type":"ellipse",...same fields} — oval/stadium node.
  - {"type":"text","id","x","y","text":"Standalone note","fontSize":20,"strokeColor":"#868e96"} — plain label; do NOT set width/height (auto-measured).
- Connector types:
  - {"type":"arrow","id","x","y","start":{"id":"n1"},"end":{"id":"n2"},"strokeColor":"#1e1e1e","strokeWidth":2,"label":{"text":"Yes"}} — bind endpoints to node ids; x/y and points are computed automatically from bindings, do not hand-calculate them.
  - {"type":"line","id","x","y","points":[[0,0],[120,0]]} — plain polyline with points RELATIVE to x/y, for underlines/separators only.
- Field conventions: colors as hex strings (default strokeColor "#1e1e1e", backgroundColor "transparent"); fillStyle "solid"|"hachure"; roughness 0(architect)/1(default)/2; strokeWidth 2 default; roundness {"type":3} for rounded rectangles; font sizes 16-28.
- Do NOT output seed/version/versionNonce/isDeleted/updated/groupIds/boundElements — they are generated automatically.
- Layout: place the whole diagram inside a 1200x800 region starting at (0,0); pick one flow direction (top-down or left-right) and keep >=40px gaps between elements; process node 160-200 wide and 60-80 tall; align nodes on a grid; add a standalone {"type":"text"} title at the top-left of the group.
- Binding integrity (mandatory): arrow start/end MUST reference ids of elements present in the SAME array, declared BEFORE the arrow; never invent ids; an arrow with no valid bound endpoint must be omitted. Shapes MUST carry explicit width/height — never rely on defaults.
- Overlap (mandatory): no two shape bounding boxes may intersect; align on a 20px grid; if unsure, spread elements generously — the renderer nudges overlaps apart, so precise non-overlap layout is expected from you.
- Accent sparingly: strokeColor+backgroundColor pairs like #1971c2/#a5d8ff (blue), #2f9e44/#d3f9d8 (green), #e8590c/#ffe8cc (orange), #c2255c/#ffdeeb (pink) to group related nodes; keep connectors neutral #1e1e1e or #868e96.
- The output must be strictly valid JSON (double quotes, no trailing commas, no comments).`

export type AIQuickCommand =
  | { kind: 'send'; instruction: string; editMode: boolean }
  | { kind: 'focus' }

/** 编辑会话条目（服务端会话的本地镜像；turns 按需拉取）。 */
interface EditSession {
  id: string
  title: string
  updatedAt: number
  messageCount?: number
  turns: ChatTurn[]
}

/** 服务端 messages → ChatTurn[]（宽松净化：损坏/缺 id 条目补 id）。 */
function sanitizeSessionTurns(raw: Array<Record<string, unknown>>): ChatTurn[] {
  if (!Array.isArray(raw)) return []
  let seq = Date.now()
  return raw
    .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      id: typeof m.id === 'number' ? m.id : ++seq,
      role: m.role as 'user' | 'assistant',
      content: String(m.content ?? ''),
      ...(typeof m.note === 'string' ? { note: m.note } : {}),
      ...(typeof m.error === 'string' ? { error: m.error } : {}),
      ...(Array.isArray(m.files) ? { files: m.files as AIAttachFile[] } : {}),
      ...(typeof m.thinking === 'string' ? { thinking: m.thinking } : {}),
      ...(typeof m.thinkingMS === 'number' ? { thinkingMS: m.thinkingMS } : {}),
      ...(Array.isArray(m.webSources) ? { webSources: m.webSources as AIWebSource[] } : {}),
      ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as AIToolCallEntry[] } : {}),
      ...(Array.isArray(m.trace) ? { trace: m.trace as TraceStage[] } : {}),
      ...(m.agentStream ? { agentStream: true } : {}),
      ...(m.limitPaused ? { limitPaused: true } : {}),
      ...(m.planReady ? { planReady: true } : {}),
      ...(m.usage ? { usage: m.usage as TraceUsage } : {}),
      ...(m.applied ? { applied: m.applied as AppliedRecord } : {}),
      ...(typeof m.applyError === 'string' ? { applyError: m.applyError } : {}),
    }))
}

/** 读取 v7.1 本机会话记录（迁移源：多会话 key 优先，回退更早的单会话 key）。 */
function readLegacySessions(convsKey: string, convKey: string): EditSession[] {
  const out: EditSession[] = []
  const pushTurns = (title: string, turns: ChatTurn[]) => {
    if (turns.length > 0) out.push({ id: `legacy-${out.length}`, title: title || sessionTitleOf(turns) || '历史会话', updatedAt: Date.now() - out.length * 1000, turns: turns.slice(-40) })
  }
  try {
    const raw = window.localStorage.getItem(convsKey)
    if (raw) {
      const parsed = JSON.parse(raw) as { list?: EditSession[] }
      if (Array.isArray(parsed.list)) {
        for (const s of parsed.list) {
          if (s && Array.isArray(s.turns)) pushTurns(String(s.title ?? ''), sanitizeSessionTurns(s.turns as unknown as Array<Record<string, unknown>>))
        }
      }
    } else {
      const legacy = window.localStorage.getItem(convKey)
      if (legacy) {
        const saved = sanitizeSessionTurns(JSON.parse(legacy) as Array<Record<string, unknown>>)
        pushTurns('', saved)
      }
    }
  } catch {
    /* 损坏忽略 */
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** 会话标题：首条用户消息前 18 字（空白折叠）。 */
function sessionTitleOf(list: ChatTurn[]): string {
  const first = list.find((x) => x.role === 'user' && x.content.trim())
  return first ? first.content.trim().replace(/\s+/g, ' ').slice(0, 18) : ''
}


/** 单条已应用回复的「修改点」记录（撤销回退锚点）。 */
interface AppliedRecord {
  /** 应用前版本（撤销时恢复到该版本）。 */
  versionId: string
  version: number
  /** 应用文本摘要（前 60 字，空白折叠）。 */
  summary: string
  time: string
  revoked?: boolean
}

interface ChatTurn {
  id: number
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: string
  /** 附注：用户消息的上下文范围/长度/截断说明；助手消息的停止说明。 */
  note?: string
  /** 用户回合引用的其它文件（chips 展示，全文经 context.fileIds 注入）。 */
  files?: AIAttachFile[]
  /** 推理思考聚合文本（SSE thinking 增量；折叠区展示，不计入正文）。 */
  thinking?: string
  /** 首个思考增量时间戳（ms；计算用时）。 */
  thinkingStartedAt?: number
  /** 思考耗时（ms；流结束后写入）。 */
  thinkingMS?: number
  /** 联网搜索来源（SSE meta.sources 宽松归一化；底部折叠列表展示）。 */
  webSources?: AIWebSource[]
  /** 外部工具调用（SSE tool/tool_result 生命周期合并；ThoughtChain 展示）。 */
  toolCalls?: AIToolCallEntry[]
  /** 自动应用进行中（保存+落盘）。 */
  applying?: boolean
  /** 自动应用成功的修改点记录（可撤销）。 */
  applied?: AppliedRecord
  /** 自动应用失败原因（文档未被修改）。 */
  applyError?: string
  /** Agent 过程分段（v7.3：思考段与工具调用交织，分阶段折叠展示）。 */
  trace?: TraceStage[]
  /** Agent 轮次标记：流式期间的内容为原始 TOOL_CALL 行，紧凑样式展示。 */
  agentStream?: boolean
  /** Agent 达轮次上限/连续失败熔断而暂停（会话上下文已保留，可「继续」）。 */
  limitPaused?: boolean
  /** 计划模式完成的回合（FINAL 为执行计划，消息下给「按计划执行」按钮）。 */
  planReady?: boolean
  /** Agent 用量汇总（轮次/输入输出 token/总耗时；SSE done usage 逐轮累计）。 */
  usage?: TraceUsage
}


/** 编辑器页头部「AI 对话」按钮（主点击开面板；下拉=并入的 AIEditMenu 快捷
 * 指令，AI 未启用不渲染）。kind 定制下拉指令（默认 text 保持原文案）：
 * excalidraw-json / drawio-xml / chat（仅对话页）分别给出契合场景的
 * 快捷指令。 */
export function AIEditChatButton({
  open,
  onToggle,
  onQuick,
  disabled,
  kind = 'text',
}: {
  open: boolean
  onToggle: () => void
  /** 下拉快捷指令回调（宿主页负责打开面板并透传给 AIEditChat）。 */
  onQuick: (cmd: AIQuickCommand) => void
  disabled?: boolean
  /** 下拉快捷指令形态（默认 text，与既有文本编辑页一致）。 */
  kind?: AIApplyKind | 'chat'
}) {
  const locale = useLocale()
  const aiOn = useAIEnabled()
  if (!aiOn) return null
  const zh = locale === 'zh-CN'
  type QuickItem = { key: string; label: string; instruction?: string; editMode?: boolean } | { key: string; label: string; focus: true }
  const itemsByKind: Record<AIApplyKind | 'chat', Array<QuickItem | 'divider'>> = {
    text: [
      { key: 'summary', label: t(locale, 'aiEditSummary'), instruction: zh ? '请总结当前文档' : 'Summarize the current document', editMode: false },
      { key: 'continue', label: t(locale, 'aiEditContinue'), instruction: zh ? '请顺着当前内容自然续写' : 'Continue writing naturally from the current content', editMode: true },
      { key: 'polish', label: t(locale, 'aiEditPolish'), instruction: zh ? '请润色当前文本，保持原意' : 'Polish the current text while keeping its meaning', editMode: true },
      { key: 'translate-en', label: t(locale, 'aiEditTranslateEn'), instruction: zh ? '把选区翻译成英文' : 'Translate the selection into English', editMode: false },
      'divider',
      { key: 'custom', label: t(locale, 'aiEditCustom'), focus: true },
    ],
    'excalidraw-json': [
      { key: 'flowchart', label: zh ? '生成流程图' : 'Flowchart', instruction: zh ? '画一个流程图（若白板上下文未给出主题，请生成一个通用的审批流程）' : 'Draw a flowchart (fall back to a generic approval flow if the whiteboard context has no topic)', editMode: true },
      { key: 'architecture', label: zh ? '生成架构图' : 'Architecture diagram', instruction: zh ? '画一个系统架构图（若上下文未给出主题，请生成一个前后端+数据库的三层架构示例）' : 'Draw an architecture diagram (fall back to a 3-tier web/database example if no topic in context)', editMode: true },
      { key: 'mindmap', label: zh ? '生成概念图' : 'Concept map', instruction: zh ? '画一个概念/思维导图（若上下文未给出主题，请围绕「产品设计」发散）' : 'Draw a concept/mind map (fall back to a “product design” topic if no topic)', editMode: true },
      'divider',
      { key: 'custom', label: t(locale, 'aiEditCustom'), focus: true },
    ],
    'drawio-xml': [
      { key: 'flowchart', label: zh ? '生成流程图' : 'Flowchart', instruction: zh ? '生成一个流程图（若上下文未给出主题，请生成一个通用的审批流程）' : 'Generate a flowchart (fall back to a generic approval flow if no topic)', editMode: true },
      { key: 'architecture', label: zh ? '生成架构图' : 'Architecture diagram', instruction: zh ? '生成一个系统架构图（若上下文未给出主题，请生成一个前后端+数据库的三层架构示例）' : 'Generate an architecture diagram (fall back to a 3-tier web/database example if no topic)', editMode: true },
      'divider',
      { key: 'custom', label: t(locale, 'aiEditCustom'), focus: true },
    ],
    // 富文本编辑页（v7 Agent 工具循环）：快捷指令为自然语言意图，由 AI 经
    // 工具自主执行（format_text/replace_text 等）；不再引导 docflow-edit 指令。
    'richtext-patch': [
      { key: 'polish', label: t(locale, 'aiEditPolish'), instruction: zh ? '请润色当前文档：逐句改写需要优化的表述，保持原意；嵌入的图表/图片/文件块保持不动' : 'Polish the document: rewrite sentences that need improvement while keeping the meaning; leave embedded diagrams/images/files untouched', editMode: true },
      { key: 'rewrite', label: zh ? '重构全文' : 'Rewrite all', instruction: zh ? '请重构全文结构与措辞（改动覆盖大半时可整篇重写，但嵌入的图表/图片/文件块必须原样保留）' : 'Restructure the whole document (full rewrite allowed, but embedded diagrams/images/files must be preserved)', editMode: true },
      { key: 'fix', label: zh ? '修正错别字' : 'Fix typos', instruction: zh ? '请找出并修正文档中的错别字与标点错误' : 'Find and fix typos and punctuation errors', editMode: true },
      { key: 'summary', label: t(locale, 'aiEditSummary'), instruction: zh ? '请总结当前文档' : 'Summarize the current document', editMode: false },
      'divider',
      { key: 'custom', label: t(locale, 'aiEditCustom'), focus: true },
    ],
    chat: [
      { key: 'summary', label: t(locale, 'aiEditSummary'), instruction: zh ? '请总结当前文档' : 'Summarize the current document', editMode: false },
      { key: 'translate-en', label: t(locale, 'aiEditTranslateEn'), instruction: zh ? '把文档内容翻译成英文' : 'Translate the document into English', editMode: false },
      'divider',
      { key: 'custom', label: t(locale, 'aiEditCustom'), focus: true },
    ],
  }
  const items: MenuProps['items'] = itemsByKind[kind].map((item, i) =>
    item === 'divider' ? { key: `d${i}`, type: 'divider' as const } : { key: item.key, label: item.label },
  )
  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    for (const item of itemsByKind[kind]) {
      if (item === 'divider' || item.key !== key) continue
      if ('focus' in item) onQuick({ kind: 'focus' })
      else onQuick({ kind: 'send', instruction: item.instruction ?? '', editMode: !!item.editMode })
    }
  }
  return (
    <SplitButton
      size="small"
      type={open ? 'primary' : 'default'}
      menu={{ items, onClick: onMenuClick }}
      arrowLabel={zh ? '快捷指令' : 'Quick actions'}
      disabled={disabled}
      onClick={onToggle}
    >
      <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
      <span>{zh ? 'AI 对话' : 'AI chat'}</span>
    </SplitButton>
  )
}

/**
 * AI 对话编辑面板（右侧内嵌；open=false 或 AI 未启用返回 null——组件保持
 * 挂载，收起不清空会话）。宿主页提供选区读取 getTarget（无选区时 text=
 * 全文）、全文 getAllText 与结果落盘通道：onApply（insert=光标/选区末尾
 * 插入；replace=替换选区）、onAppend（无选区时追加文档末尾）；版本保护
 * 需要 ensureSaved（应用前确保已保存并返回应用前版本）、reload（撤销回退
 * 后刷新编辑器内容）与 fileId（restoreVersion 用）。
 */
export default function AIEditChat({
  open,
  onClose,
  getTarget,
  fileId,
  quickCommand,
  onQuickConsumed,
  applyKind = 'text',
  agentTools,
  agentSystemExtra,
}: {
  open: boolean
  onClose: () => void
  /** 当前选区（text 为选中文本；无选区时返回全文与 hasSelection=false）。 */
  getTarget: () => AIEditTarget
  /** 文件 id（服务端会话分域键）。 */
  fileId: string
  /** 应用通道标识（Agent 宿主名与快捷指令形态）。 */
  applyKind?: AIApplyKind
  /** 头部下拉快捷指令（非 null 时自动执行一次）。 */
  quickCommand?: AIQuickCommand | null
  /** 快捷指令执行后回调（宿主页清空 quickCommand）。 */
  onQuickConsumed?: () => void
  /** 宿主注册的编辑工具集（v5 内置 Agent 模式）：提供时面板切换为
   *  TOOL_CALL/FINAL 工具循环——AI 自主读文档/定位/编辑/验证（编辑范围
   *  由 AI 判断），工具经 exec 在宿主编辑器上执行，过程以工具链 UI 展示。
   *  未提供（富文本指令/白板/图表等既有直编通道）保持原单轮模式。 */
  agentTools?: AIEditTool[]
  /** Agent 模式 system 提示词的宿主附加段（白板/图表等工具载荷格式规范、
   *  宿主特定约束），拼在工具清单与输出格式约定之间。 */
  agentSystemExtra?: string
}) {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const aiOn = useAIEnabled()
  const { message, modal } = AntdApp.useApp()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  // ---- 多会话（v7.2：服务端持久化 /ai/conversations，source=editor，
  //      按文件分域；本机 localStorage 仅作首次迁移源）----
  const convoScope = useMemo(() => ({ source: 'editor' as const, fileId }), [fileId])
  const legacyConvsKey = fileId ? `docflow.ai.edit.convs.${fileId}` : ''
  const legacyConvKey = fileId ? `docflow.ai.edit.conv.${fileId}` : ''
  const [sessions, setSessions] = useState<EditSession[]>([])
  const [activeSessId, setActiveSessId] = useState('')
  // 重命名中条目（Modal 输入新标题；与全局助手同款交互）。
  const [sessEditing, setSessEditing] = useState<{ id: string; draft: string } | null>(null)
  // 命令式访问器（保存/切换/删除在事件回调中读最新值，避免闭包陈旧）。
  const sessionsRef = useRef<EditSession[]>([])
  sessionsRef.current = sessions
  const activeSessIdRef = useRef('')
  activeSessIdRef.current = activeSessId
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  /** 恢复会话：置列表元信息并拉取最近一条正文。 */
  const restoreSessions = async (metas: AIConvoMeta[]) => {
    const list: EditSession[] = metas.map((m) => ({
      id: m.id, title: m.title, updatedAt: new Date(m.updated_at).getTime(),
      messageCount: m.message_count, turns: [],
    }))
    sessionsRef.current = list
    setSessions(list)
    syncedLenRef.current = 0
    if (list[0]) {
      activeSessIdRef.current = list[0].id
      setActiveSessId(list[0].id)
      try {
        const row = await aiGetConversation(list[0].id)
        const saved = sanitizeSessionTurns(row.messages)
        list[0] = { ...list[0], turns: saved }
        sessionsRef.current = [...list]
        syncedLenRef.current = saved.length
        setTurns(saved)
      } catch {
        /* 正文拉取失败按空会话处理 */
      }
    }
  }
  useEffect(() => {
    if (!fileId) return
    let alive = true
    void (async () => {
      try {
        let metas = await aiListConversations(convoScope)
        if (metas.length === 0 && legacyConvsKey) {
          // 首次迁移：v7.1 本机多会话（或更早的单会话）一次性上迁后重取。
          const local = readLegacySessions(legacyConvsKey, legacyConvKey)
          if (local.length > 0) {
            for (const s of [...local].reverse()) {
              if (!s.turns.length) continue
              const row = await aiCreateConversation(convoScope, s.title || '历史会话')
              await aiAppendConversation(row.id, 'snapshot', s.turns as unknown as Array<Record<string, unknown>>)
            }
            try {
              window.localStorage.removeItem(legacyConvsKey)
              window.localStorage.removeItem(legacyConvKey)
            } catch { /* ignore */ }
            metas = await aiListConversations(convoScope)
          }
        }
        if (!alive) return
        await restoreSessions(metas)
      } catch {
        // 服务端不可达：保持空白会话（不阻塞编辑对话）。
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])
  // 会话同步（事件模型）：新回合完成 → append turn 增量；删除消息 →
  // snapshot 全量；清空 → 删除服务端会话。syncedLen 记录已同步条数。
  const syncedLenRef = useRef(0)
  useEffect(() => {
    if (!fileId) return
    if (turns.some((x) => x.streaming)) return
    const persist = turns.map((x) => ({ ...x, streaming: undefined }))
    const synced = syncedLenRef.current
    const id = activeSessIdRef.current
    void (async () => {
      try {
        if (persist.length > synced) {
          const prev = sessionsRef.current.find((s) => s.id === id)
          const title = prev?.title || sessionTitleOf(persist) || (zh ? '新会话' : 'New session')
          let cid = id
          if (!cid || !prev) {
            const row = await aiCreateConversation(convoScope, title)
            cid = row.id
            activeSessIdRef.current = cid
            setActiveSessId(cid)
          } else if (!prev.title) {
            void aiUpdateConversation(cid, { title }).catch(() => { /* 静默 */ })
          }
          await aiAppendConversation(cid, 'turn', persist.slice(synced) as unknown as Array<Record<string, unknown>>)
          syncedLenRef.current = persist.length
          const rest = [
            { id: cid, title, updatedAt: Date.now(), messageCount: persist.length, turns },
            ...sessionsRef.current.filter((s) => s.id !== cid),
          ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300)
          sessionsRef.current = rest
          setSessions(rest)
        } else if (persist.length < synced) {
          if (persist.length === 0) {
            if (id) {
              await aiDeleteConversation(id).catch(() => { /* 静默 */ })
              const rest = sessionsRef.current.filter((s) => s.id !== id)
              sessionsRef.current = rest
              setSessions(rest)
            }
            syncedLenRef.current = 0
          } else if (id) {
            await aiAppendConversation(id, 'snapshot', persist.slice(-40) as unknown as Array<Record<string, unknown>>)
            syncedLenRef.current = Math.min(persist.length, 40)
            const rest = sessionsRef.current.map((s) => (s.id === id ? { ...s, updatedAt: Date.now(), messageCount: persist.length } : s))
            sessionsRef.current = rest
            setSessions(rest)
          }
        }
      } catch {
        /* 服务端写失败静默（下次变更重试；syncedLen 不前移） */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, turns])

  /** 切换会话（正文按需拉取；贴底显示最新）。 */
  const switchSession = (id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target || id === activeSessIdRef.current) return
    activeSessIdRef.current = id
    setActiveSessId(id)
    setNotice('')
    sticky.scrollToBottom()
    if (target.turns.length > 0) { syncedLenRef.current = target.turns.length; setTurns(target.turns); return }
    void aiGetConversation(id)
      .then((row) => {
        if (activeSessIdRef.current !== id) return
        const saved = sanitizeSessionTurns(row.messages)
        sessionsRef.current = sessionsRef.current.map((s) => (s.id === id ? { ...s, turns: saved } : s))
        setSessions([...sessionsRef.current])
        syncedLenRef.current = saved.length
        setTurns(saved)
      })
      .catch(() => {
        if (activeSessIdRef.current === id) setNotice(zh ? '会话内容加载失败' : 'Failed to load session')
      })
  }
  /** 新建会话（当前会话保留在服务端历史）。 */
  const newSession = () => {
    activeSessIdRef.current = ''
    setActiveSessId('')
    syncedLenRef.current = 0
    setTurns([])
    setNotice('')
  }
  /** 重命名会话（Modal 输入；空标题忽略；与全局助手同款交互）。 */
  const renameSession = () => {
    const editing = sessEditing
    if (!editing || !editing.draft.trim()) return
    const list = sessionsRef.current.map((s) => (s.id === editing.id ? { ...s, title: editing.draft.trim().slice(0, 60) } : s))
    sessionsRef.current = list
    setSessions(list)
    void aiUpdateConversation(editing.id, { title: editing.draft.trim().slice(0, 60) }).catch(() => { /* 服务端失败静默 */ })
    setSessEditing(null)
  }

  // ---- 谨慎模式（B1）：破坏性工具执行前确认，默认开启（localStorage 记忆）----
  const [cautious, setCautious] = useState(() => {
    try { return window.localStorage.getItem('docflow.ai.agent.cautious') !== '0' } catch { return true }
  })
  const cautiousRef = useRef(cautious)
  cautiousRef.current = cautious
  const toggleCautious = () => {
    setCautious((v) => {
      const next = !v
      cautiousRef.current = next
      try { window.localStorage.setItem('docflow.ai.agent.cautious', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }
  /** 破坏性工具确认（antd confirm，Promise 化；取消=跳过该次调用）。 */
  /** 破坏性工具确认：antd Modal（z-index 默认 1000 > 浮层 950），永不静默跳过。 */
  const confirmDestructive = (label: string) => new Promise<boolean>((resolve) => {
    modal.confirm({
      title: zh ? `确认执行「${label}」？` : `Confirm "${label}"?`,
      content: zh ? '谨慎模式：该操作会删除或整篇替换内容。' : 'Cautious mode: this operation deletes or replaces content.',
      okText: zh ? '执行' : 'Execute',
      okButtonProps: { danger: true },
      cancelText: zh ? '跳过' : 'Skip',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })

  // ---- 消息级操作（v7.3：复制/删除问答对/保存到文件 + 批量多选）----
  const [batchMode, setBatchMode] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [savingFile, setSavingFile] = useState(false)
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
  /** 删除一次问答（一输入一输出）：assistant 侧按钮删除其与前置最近 user；
   *  批量删除按所选 turn id 过滤。 */
  const deleteExchange = (asstId: number) => {
    setTurns((prev) => {
      const idx = prev.findIndex((x) => x.id === asstId)
      if (idx < 0) return prev
      let userId: number | null = null
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].role === 'user') { userId = prev[i].id; break }
      }
      return prev.filter((x) => x.id !== asstId && x.id !== userId)
    })
  }
  /** 重新生成：删除最后一轮问答并按当前模式重发最后一问。 */
  const regenerate = (asstId: number) => {
    if (busy) return
    const idx = turns.findIndex((x) => x.id === asstId)
    if (idx < 0) return
    let question = ''
    for (let i = idx - 1; i >= 0; i--) {
      if (turns[i].role === 'user') { question = turns[i].content; break }
    }
    if (!question) return
    deleteExchange(asstId)
    void send(question)
  }

  const deleteChecked = () => {
    setTurns((prev) => prev.filter((x) => !checked.has(x.id)))
    setChecked(new Set())
  }
  /** 保存弹窗状态：{open, fileName, parentId}（默认同目录+自动文件名）。 */
  const [saveDialog, setSaveDialog] = useState<{ open: boolean; fileName: string; parentId: string | null; ids?: number[] } | null>(null)
  /** 打开保存弹窗（预填默认目录与文件名）。 */
  const openSaveDialog = async (ids?: number[]) => {
    if (!fileId) return
    const sel = ids ?? turns.map((x) => x.id)
    const list = turns.filter((x) => sel.includes(x.id) && x.content.trim())
    if (!list.length) return
    const title = sessionTitleOf(turns) || fileName || (zh ? 'AI 会话' : 'AI conversation')
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stampStr = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
    const safe = title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 30)
    const defaultName = `${zh ? 'AI会话' : 'AI-conversation'}-${safe || 'session'}-${stampStr}.md`
    let parent: string | null = null
    try { parent = (await getFileMeta(fileId)).parent_id ?? null } catch { parent = null }
    setSaveDialog({ open: true, fileName: defaultName, parentId: parent, ids: sel })
  }
  /** 确认保存（弹窗内确认后调用）。 */
  const confirmSaveFile = async () => {
    if (!saveDialog || !fileId || savingFile) return
    const { ids } = saveDialog
    const sel = ids ?? turns.map((x) => x.id)
    const list = turns.filter((x) => sel.includes(x.id) && x.content.trim())
    if (!list.length) return
    setSavingFile(true)
    try {
      const title = sessionTitleOf(turns) || fileName || (zh ? 'AI 会话' : 'AI conversation')
      const stamp = new Date()
      const lines: string[] = [
        `# ${zh ? 'AI 会话' : 'AI conversation'}：${title}`,
        '',
        `> ${stamp.toLocaleString()}${fileName ? ` · ${fileName}` : ''} · DocFlow`,
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

  /** 删除会话（确认后）；删的是当前会话则切到最近一个，无则开新空白。 */
  const deleteSession = (id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target) return
    const label = target.title || (zh ? '未命名会话' : 'Untitled')
    if (!window.confirm(zh ? `删除会话「${label}」？删除后不可恢复。` : `Delete session "${label}"? This cannot be undone.`)) return
    const next = sessionsRef.current.filter((s) => s.id !== id)
    sessionsRef.current = next
    setSessions(next)
    void aiDeleteConversation(id).catch(() => { /* 服务端失败静默 */ })
    if (id === activeSessIdRef.current) {
      if (next[0]) switchSession(next[0].id)
      else newSession()
    }
  }
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setNotice] = useState('')
  /** 面板模式：可修改（默认）/仅对话（ref 供快捷指令立即生效）。 */
  const [mode, setMode] = useState<ChatMode>('edit')
  const modeRef = useRef<ChatMode>('edit')
  // 联网/思考开关：与全局助手共用 localStorage key 与默认逻辑
  //（所选模型从 docflow.ai.model 读取，无记忆时回落 default_models.chat；
  //  模型列表仅用于评估思考能力）。
  const [models, setModels] = useState<AIModelOption[]>([])
  // 技能包（C2）：/ai/models.agent_packages（内置 + 平台定义）。
  const [agentPackages, setAgentPackages] = useState<Array<{ id: string; name: string; description?: string; system_extra?: string; tools?: string[]; kinds?: string[] }>>([])
  const [pkgId, setPkgId] = useState('auto')
  const pkgIdRef = useRef('')
  pkgIdRef.current = pkgId
  const [modelKey, setModelKey] = useState(() => {
    try {
      return window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  // 用户是否显式选过模型（与全局助手同一 localStorage 记忆判定）。
  const [modelExplicit, setModelExplicit] = useState(() => {
    try {
      return (window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? '') !== ''
    } catch {
      return false
    }
  })
  const toggles = useAIChatToggles(models, modelKey)
  // 文件引用（v3.9）：随指令附带其它文件全文（context.fileIds 注入 system
  // 上下文；当前文档本身已是主上下文，引用的是「其它」文件）。
  const [attached, setAttached] = useState<AIAttachFile[]>([])
  const turnIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<TextAreaRef | null>(null)
  // 贴底跟随（v7.1：用户上滚阅读历史时不被流式输出顶回底部；回到底部自动
  // 恢复跟随；发送新消息强制贴底——同全局助手/查看页挂件）。
  const sticky = useStickyScroll(
    turns.length > 0
      ? `${turns[turns.length - 1].id}:${(turns[turns.length - 1].content ?? '').length}:${(turns[turns.length - 1].thinking ?? '').length}`
      : '',
  )
  // 会话历史浮层展开态。
  // 悬浮窗模式（v7.5）：fixed 浮层 + 可拖动头部；偏好 localStorage 记忆。
  const [floatMode, setFloatMode] = useState(() => {
    try { return window.localStorage.getItem('docflow.ai.edit.floatMode') === '1' } catch { return false }
  })
  const panelRef = useRef<HTMLElement | null>(null)
  const toggleFloatMode = () => {
    setFloatMode((v) => {
      const next = !v
      try { window.localStorage.setItem('docflow.ai.edit.floatMode', next ? '1' : '0') } catch { /* ignore */ }
      if (!next && panelRef.current) {
        // 复位拖动位移（回到 fixed 默认右下角）
        panelRef.current.style.left = ''
        panelRef.current.style.top = ''
        panelRef.current.style.right = '24px'
        panelRef.current.style.bottom = '24px'
      }
      return next
    })
  }
  // 拖动头部（悬浮态）：pointer 事件移动 fixed 面板。
  const onHeadPointerDown = (e: ReactPointerEvent) => {
    if (!floatMode || e.button !== 0) return
    // 按钮等交互元素不触发拖动（pointer capture 会吃掉它们的 click）
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, .ant-segmented, .ant-dropdown-trigger, .ant-popover-open')) return
    const el = panelRef.current
    if (!el) return
    const startX = e.clientX
    const startY = e.clientY
    const rect = el.getBoundingClientRect()
    const startL = rect.left
    const startT = rect.top
    el.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, startL + ev.clientX - startX)}px`
      el.style.top = `${Math.max(0, startT + ev.clientY - startY)}px`
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    }
    const onUp = () => {
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }
  // 命令式访问器经 ref 取（宿主每渲染重建函数，避免 effect 反复重挂）。
  const getTargetRef = useRef(getTarget)
  getTargetRef.current = getTarget
  const fileIdRef = useRef(fileId)
  fileIdRef.current = fileId

  // 卸载清理：中止进行中的生成。
  useEffect(() => () => { abortRef.current?.abort() }, [])

  // 模型列表（仅用于评估思考开关可用性与显式携带所选模型；与全局助手共用
  // getAIModels 缓存）；无本地记忆时回落 default_models.chat 默认模型。
  useEffect(() => {
    if (!aiOn) return
    void getAIModels().then((list) => {
      setModels(list)
      getAIModelsRaw().then((raw) => {
        const packs = (raw as { agent_packages?: Array<{ id: string; name: string; description?: string; system_extra?: string; tools?: string[]; kinds?: string[] }> }).agent_packages
        if (Array.isArray(packs)) setAgentPackages(packs.filter((x) => x && x.id))
      }).catch(() => { /* ignore */ })
      setModelKey((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur
        const dkey = defaultAIModelKey()
        return dkey && list.some((m) => m.id === dkey) ? dkey : cur
      })
    })
  }, [aiOn])

  // 当前文件名（技能 {file} 占位符替换用）：宿主仅传 fileId，面板打开时按
  // GET /files/:id 解析一次；失败置空（占位符按空处理，不新增编辑器依赖）。
  const [fileName, setFileName] = useState('')
  useEffect(() => {
    if (!open || !aiOn || !fileId) return
    let alive = true
    getFileMeta(fileId)
      .then((meta) => {
        if (alive) setFileName(meta.name)
      })
      .catch(() => {
        if (alive) setFileName('')
      })
    return () => {
      alive = false
    }
  }, [open, aiOn, fileId])

  // 新回合/流式更新的滚动由 useStickyScroll 承担（贴底才跟随）。

  // 头部下拉快捷指令：send=切模式并自动发送；focus=聚焦输入框。
  useEffect(() => {
    if (!open || !aiOn || !quickCommand) return
    onQuickConsumed?.()
    if (quickCommand.kind === 'focus') {
      inputRef.current?.focus()
      return
    }
    // 快捷指令自带处理模式：续写/润色→可修改（自动应用）；摘要/翻译→仅对话。
    const m: ChatMode = !quickCommand.editMode ? 'chat' : 'edit'
    setMode(m)
    modeRef.current = m
    void send(quickCommand.instruction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickCommand, open, aiOn])

  /** 切换面板模式（可修改/仅对话）。 */
  const changeMode = (m: ChatMode) => {
    setMode(m)
    modeRef.current = m
  }

  // ---- v5 内置 Agent 工具循环（agentTools 提供时启用） ----
  // 协议与 Office 插件一致：AI 每轮输出单行 TOOL_CALL {...}（一次一个工具）
  // 或 FINAL 总结；exec 后结果以 TOOL_RESULT 回喂继续，直至 FINAL/上限。
  // 工具过程复用 turn.toolCalls（AIToolChain：running→success/error）。
  const agentToolsRef = useRef(agentTools)
  agentToolsRef.current = agentTools
  const agentSystemExtraRef = useRef(agentSystemExtra)
  agentSystemExtraRef.current = agentSystemExtra

// 括号深度扫描提取 TOOL_CALL {...}（字符串感知：引号内的 {} 与转义不计
// 深度，支持嵌套/跨行；从最后一个候选向前取首个可解析的——推理模型在
// 工具行外漏思考散文、重复多行时的鲁棒解析，与 Office 插件同实现）。
  function extractCallJson(t: string): { tool: string; args: Record<string, unknown> } | null {
    let k = 0
    const found: string[] = []
    while (found.length < 8) {
      const at = t.indexOf('TOOL_CALL', k)
      if (at < 0) break
      const brace = t.indexOf('{', at)
      if (brace < 0) break
      let depth = 0, inStr = false, escp = false, end = -1
      for (let i2 = brace; i2 < t.length; i2++) {
        const ch = t.charAt(i2)
        if (escp) { escp = false; continue }
        if (ch === '\\') { if (inStr) escp = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { end = i2; break } }
      }
      if (end < 0) break
      found.push(t.slice(brace, end + 1))
      k = end + 1
    }
    for (let j2 = found.length - 1; j2 >= 0; j2--) {
      try {
        const c = JSON.parse(found[j2]) as { tool: string; args?: Record<string, unknown> }
        if (c && typeof c.tool === 'string') return { tool: c.tool, args: c.args ?? {} }
      } catch { /* 候选不完整 → 跳过 */ }
    }
    return null
  }
  const parseAgentReply = (text: string): { type: 'final'; text: string } | { type: 'tool'; call: { tool: string; args: Record<string, unknown> } } => {
    const t = text.trim()
    if (t.startsWith('FINAL')) return { type: 'final', text: t.slice(5).trim() || t }
    const call = extractCallJson(t)
    if (call) return { type: 'tool', call }
    return { type: 'final', text: t }
  }

  const patchLastTurn = (turnId: number, patch: (x: ChatTurn) => Partial<ChatTurn>) => {
    setTurns((prev) => prev.map((x) => (x.id === turnId ? { ...x, ...patch(x) } : x)))
  }

  /** Agent 会话上下文暂停保留（达上限/熔断的回合 → 「继续」恢复）。 */
  const pendingConvosRef = useRef<Map<number, AIMessage[]>>(new Map())
  /** Agent 模式：工具循环 + FINAL；过程以 trace 分段写入助手回合（v7.3）。
   *  v7.4：轮次预算 300（足够大任务），达上限/连续失败熔断时保留会话
   *  上下文并标记 limitPaused——消息下出现「继续」按钮恢复循环，等效
   *  无上限；熔断条件为同一工具+同一参数连续失败 8 次（防死循环烧钱）。 */
  /** Agent system 提示构造（执行/计划共用；plan 时只列只读工具子集并要求
   *  FINAL 输出分步执行计划）。 */
  const buildAgentSystem = (tools: AIEditTool[], plan: boolean): string => {
    const hostLabel = agentHostLabel(applyKind)
    const extra = agentSystemExtraRef.current
    const pkg = resolveAgentPackage()
    const pkgExtra = pkg?.system_extra ? `【技能包：${pkg.name}】\n${pkg.system_extra}` : ''
    const list = plan ? tools.filter((t) => READONLY_TOOL_RE.test(t.name)) : tools
    const L = [
      `你是 DocFlow 内置文档编辑 Agent（宿主：${hostLabel}）。${plan ? '当前为计划模式：只能调用只读工具探查文档现状，不得修改；探查完成后以 FINAL 输出一份可执行的修改计划（分步骤，说明每步将使用的工具与参数要点）。' : '通过调用工具直接操作当前文档，用户只描述意图。'}`,
      '',
      `可用工具（每次回复恰好一行 TOOL_CALL {...} 调用一个，或以 FINAL 开头给出最终答复${plan ? '（计划）' : ''}）：`,
      ...list.map((t) => `- ${t.name}：${t.desc}`),
      ...(extra || pkgExtra ? ['', [extra, pkgExtra].filter(Boolean).join('\n\n')] : []),
      '',
      '输出格式（硬性要求——违反则本轮无效）：每轮回复的完整内容必须恰好是一行 TOOL_CALL {...}（单个工具、合法 JSON、前后不得有任何解释/思考/推理文字），或以 FINAL 开头的最终答复。',
      `禁止输出 "I'll"、"Let me"、"首先"等散文开头。不要解释你要做什么——直接输出 TOOL_CALL 或 FINAL。`,
      '工作方式：先读（read_*/search_*）再改；局部修改用精确工具、不要整篇重写；一次一个工具，根据结果决定下一步；失败读错误换路径（同样的参数重试同一工具通常不会成功）；关键修改后可用读工具校验；完成后 FINAL + 简明中文总结（改了什么、在哪）。',
      'TOOL_CALL 示例：TOOL_CALL {"tool":"read_document","args":{}}',
    ]
    return L.join(String.fromCharCode(10))
  }

  /** 建立新问答回合（用户+助手骨架），返回两回合 id。 */
  const openAgentTurn = (question: string, note?: string): [number, number] => {
    const userTurnId = ++turnIdRef.current
    const asstTurnId = ++turnIdRef.current
    setInput('')
    setNotice('')
    setTurns((prev) => [
      ...prev,
      { id: userTurnId, role: 'user', content: question, ...(note ? { note } : {}) },
      { id: asstTurnId, role: 'assistant', content: '', streaming: true, agentStream: true, trace: [] },
    ])
    return [userTurnId, asstTurnId]
  }

  const sendAgent = async (question: string, attachFiles?: AIAttachFile[]) => {
    const tools = agentToolsRef.current ?? []
    // 用户发送 = 关注最新输出：强制恢复贴底跟随（即便此前上滚阅读）。
    sticky.scrollToBottom()
    const sys = buildAgentSystem(tools, false)
    const tgt = getTargetRef.current()
    const [, asstTurnId] = openAgentTurn(question, tgt.hasSelection ? `选区 ${tgt.text.length} 字` : '全文上下文')
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const convo: AIMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: question }]
    await runAgentLoop(subAgentTools(tools), convo, asstTurnId, controller, {}, attachFiles)
  }

  /** 计划模式：只读工具探查 → FINAL=执行计划（标记 planReady）。 */
  const sendAgentPlan = async (question: string) => {
    const tools = (agentToolsRef.current ?? []).filter((t) => READONLY_TOOL_RE.test(t.name))
    sticky.scrollToBottom()
    const sys = buildAgentSystem(agentToolsRef.current ?? [], true)
    const [userTurnId, asstTurnId] = openAgentTurn(question)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const convo: AIMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: `请探查并给出执行计划：${question}` },
    ]
    await runAgentLoop(tools, convo, asstTurnId, controller, { plan: true })
    void userTurnId
  }

  /** 「按计划执行」：以计划全文为私有上下文转入执行循环（可见提问保持简短）。 */
  const executePlan = async (planText: string) => {
    if (busy) return
    const tools = agentToolsRef.current ?? []
    sticky.scrollToBottom()
    const [userTurnId, asstTurnId] = openAgentTurn('按上述计划执行')
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const convo: AIMessage[] = [
      { role: 'system', content: buildAgentSystem(tools, false) },
      { role: 'user', content: `请严格按以下计划逐步执行（该计划来自刚才的只读探查，可直接依据；执行完毕 FINAL 总结）：
${planText}` },
    ]
    await runAgentLoop(subAgentTools(tools), convo, asstTurnId, controller)
    void userTurnId
  }

  /** 会话导入 input 引用。 */
  const importInputRef = useRef<HTMLInputElement | null>(null)
  /** 导出本文件域全部会话为 JSON（含 messages/trace；逐会话拉正文）。 */
  const exportSessionsFile = async () => {
    if (!fileId || sessions.length === 0) return
    try {
      const rows = []
      for (const s of sessionsRef.current) {
        try {
          const row = await aiGetConversation(s.id)
          rows.push({ title: s.title, updatedAt: s.updatedAt, messages: row.messages })
        } catch { /* 单会话失败跳过 */ }
      }
      const payload = { version: 1, kind: 'docflow-ai-sessions', file_id: fileId, exported_at: new Date().toISOString(), sessions: rows }
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
    if (!fileId || !file) return
    try {
      const parsed = JSON.parse(await file.text()) as { sessions?: Array<{ title?: unknown; messages?: unknown }> }
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : []
      if (!list.length) { void message.warning(zh ? '备份中没有会话' : 'No sessions in the backup'); return }
      let imported = 0
      for (const it of list) {
        const title = typeof it?.title === 'string' ? it.title : (zh ? '导入的会话' : 'Imported')
        const messages = Array.isArray(it?.messages) ? (it.messages as Array<Record<string, unknown>>) : []
        if (!messages.length) continue
        const row = await aiCreateConversation(convoScope, title)
        await aiAppendConversation(row.id, 'snapshot', messages.slice(-40))
        imported++
      }
      const metas = await aiListConversations(convoScope)
      await restoreSessions(metas)
      void message.success(zh ? `已导入 ${imported} 个会话` : `Imported ${imported} sessions`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : (zh ? '导入失败（文件格式不正确？）' : 'Import failed (invalid file?)'))
    }
  }

  /** 「继续」：恢复达上限/熔断暂停的 Agent 回合（沿用原会话上下文，
   *  追加一条系统提示告知模型从中断处继续；再获一轮完整预算）。 */
  const continueAgent = async (asstTurnId: number) => {
    if (busy) return
    const convo = pendingConvosRef.current.get(asstTurnId)
    if (!convo) return
    pendingConvosRef.current.delete(asstTurnId)
    sticky.scrollToBottom()
    patchLastTurn(asstTurnId, () => ({ streaming: true, limitPaused: false, note: undefined, content: '' }))
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    convo.push({ role: 'user', content: '继续（从中断处接着执行，保持同样的输出协议）。' })
    await runAgentLoop(subAgentTools(agentToolsRef.current ?? []), convo, asstTurnId, controller)
  }

  /** 子 agent（C1）：独立只读小循环——检索过程不占主循环上下文，只回
   *  结构化摘要。与主循环同协议（TOOL_CALL/FINAL），预算独立（≤8 轮）、
   *  同参连败 4 次熔断；未出摘要返回错误供主循环换路径。 */
  const runSubAgent = async (
    goal: string,
    tools: AIEditTool[],
    maxRounds = 8,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    const readonlyTools = tools.filter((t) => READONLY_TOOL_RE.test(t.name))
    if (readonlyTools.length === 0) return { ok: false, error: '宿主未注册只读工具，无法派发子任务' }
    const sys = [
      `你是 DocFlow 只读检索子 Agent。目标：${goal}`,
      '用只读工具探查，FINAL 输出结构化摘要（发现清单 + 关键事实 + 相关位置/数值），不修改任何内容。',
      '可用工具：',
      ...readonlyTools.map((t) => `- ${t.name}：${t.desc}`),
      '输出格式（硬性）：每轮恰好一行 TOOL_CALL {...}，或 FINAL 开头的摘要。',
    ].join(String.fromCharCode(10))
    const convo: AIMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: goal }]
    let failStreak = 0
    let lastFailSig = ''
    try {
      for (let round = 1; round <= maxRounds; round++) {
        let acc = ''
        await aiChat({ messages: convo }, {
          onDelta: (c) => { acc += c },
          onMeta: () => {}, onThinking: () => {}, onTool: () => {}, onToolResult: () => {}, onSources: () => {},
        })
        const parsed = parseAgentReply(acc)
        if (parsed.type === 'final') return { ok: true, data: { summary: parsed.text } }
        const def = readonlyTools.find((t) => t.name === parsed.call.tool)
        if (!def) {
          convo.push({ role: 'assistant', content: `TOOL_CALL ${JSON.stringify(parsed.call)}` })
          convo.push({ role: 'user', content: 'TOOL_RESULT {"ok":false,"error":"未知工具"}' })
          continue
        }
        const r = await def.exec(parsed.call.args).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        const sig = r.ok ? '' : `${parsed.call.tool}:${JSON.stringify(parsed.call.args)}`
        if (r.ok) { failStreak = 0; lastFailSig = '' }
        else if (sig === lastFailSig) {
          if (++failStreak >= 4) return { ok: false, error: `子任务连败熔断：${parsed.call.tool}` }
        } else { failStreak = 1; lastFailSig = sig }
        convo.push({ role: 'assistant', content: `TOOL_CALL ${JSON.stringify(parsed.call)}` })
        convo.push({ role: 'user', content: `TOOL_RESULT ${JSON.stringify(r).slice(0, 3000)}` })
      }
      return { ok: false, error: `子任务达预算（${maxRounds} 轮）未出摘要` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 技能包解析：auto = 程序按 applyKind 自动选第一个适用内置包；
   *  ''（无）= 不注入；其余按 id。 */
  const resolveAgentPackage = () => {
    const cur = pkgIdRef.current
    if (cur !== 'auto') return agentPackages.find((x) => x.id === cur)
    return agentPackages.find((x) => x.id.startsWith('builtin-')
      && (!Array.isArray(x.kinds) || x.kinds.length === 0 || x.kinds.includes(applyKind)))
  }
  /** 技能包应用：工具白名单过滤（元工具 deep_search/parallel_scan 恒留）。 */
  const applyPackageTools = (tools: AIEditTool[]): AIEditTool[] => {
    const pkg = resolveAgentPackage()
    if (!pkg || !Array.isArray(pkg.tools) || pkg.tools.length === 0) return tools
    const allow = new Set([...pkg.tools, 'deep_search', 'parallel_scan'])
    return tools.filter((t) => allow.has(t.name))
  }

  /** 元工具：deep_search（单目标深查）与 parallel_scan（≤3 并发）；
   *  subAgentTools 在循环入口调用一次并传引用——循环期间不再重建；
   *  大范围检索派发给独立上下文，主循环只拿摘要。 */
  const subAgentTools = (hostTools: AIEditTool[]): AIEditTool[] => [
    ...applyPackageTools(hostTools),
    {
      name: 'deep_search',
      desc: '{goal} → 派发独立只读子 Agent 深查一个目标（≤8 轮），返回结构化摘要（发现/事实/位置）——大范围检索不占主上下文。',
      label: (a: Record<string, unknown>) => `深查 ${String(a.goal ?? '').slice(0, 16)}`,
      exec: async (a: Record<string, unknown>) => runSubAgent(String(a.goal ?? ''), hostTools),
    },
    {
      name: 'parallel_scan',
      desc: '{tasks:[{goal},…]} → 并发派发 ≤3 个只读子 Agent 各查一个目标，返回逐项摘要（适合多区域/多主题探查）。',
      label: (a: Record<string, unknown>) => `并发探查 ×${Array.isArray(a.tasks) ? Math.min(a.tasks.length, 3) : '?'}`,
      exec: async (a: Record<string, unknown>) => {
        const tasks = (Array.isArray(a.tasks) ? a.tasks : [])
          .map((t) => String((t as { goal?: unknown })?.goal ?? ''))
          .filter(Boolean)
          .slice(0, 3)
        if (!tasks.length) return { ok: false, error: 'tasks 必填：[{goal},…]' }
        const results = await Promise.all(tasks.map((g) => runSubAgent(g, hostTools, 8)))
        return {
          ok: true,
          data: {
            results: tasks.map((g, i) => ({ goal: g, ...(results[i] as { ok: boolean; data?: unknown; error?: string }) })),
          },
        }
      },
    },
  ]

  /** Agent 工具循环主体（send 与「继续」共用）。执行期间锁定 package（防止
   *  mid-loop 用户切包导致工具集突变引发「未知工具」）。 */
  const runAgentLoop = async (
    tools: AIEditTool[],
    convo: AIMessage[],
    asstTurnId: number,
    controller: AbortController,
    opts: { plan?: boolean } = {},
    attachFiles?: AIAttachFile[],
  ) => {
    // 过程分段写入（trace）：think=本轮思考段（首个思考增量开段），tool=一次调用。
    let stageSeq = 0
    const pushStage = (stage: Omit<TraceStage, 'key'>): number => {
      stageSeq++
      const key = Date.now() * 1000 + (stageSeq % 1000)
      patchLastTurn(asstTurnId, (x) => ({ trace: [...(x.trace ?? []), { ...stage, key }] }))
      return key
    }
    const patchStage = (key: number, patch: Partial<TraceStage>) => {
      patchLastTurn(asstTurnId, (x) => ({
        trace: (x.trace ?? []).map((st) => (st.key === key ? { ...st, ...patch } : st)),
      }))
    }
    // 轮次预算：大任务（多元素图/整表/批量改）几百轮也够；真正的防失控靠
    // 连续失败熔断（同工具同参连败 8 次）而非低轮次硬顶；达上限仍可「继续」。
    console.info('[AgentLoop] 启动: 工具集=', tools.map((t) => t.name).join(', '), '| pkgId=', pkgIdRef.current)
    const MAX_ROUNDS = 300
    const FAIL_STREAK_LIMIT = 8
    let failStreak = 0
    let lastFailSig = ''
    let pausedNote = ''
    // 用量聚合（SSE done usage 逐轮累计；结束写入回合供 TraceView 头部展示）。
    const runStart = Date.now()
    let uRounds = 0
    let uPrompt = 0
    let uCompletion = 0
    const usagePatch = () => ({ usage: { rounds: uRounds, promptTokens: uPrompt, completionTokens: uCompletion, durationMS: Date.now() - runStart } as TraceUsage })
    try {
      let finalText = ''
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        let acc = ''
        let roundThink = ''
        let roundThinkStart = 0
        let thinkKey = 0
        // 发送视图经压缩（防长会话爆上下文）；瞬态错误（网络/网关抖动，
        // 非用户中止）自动重试一次，再失败按原语义终止本轮任务。
        const roundChat = () => aiChat(
          { messages: agentConvoView(convo), think: toggles.think ? true : undefined, web_search: toggles.web ? true : undefined, ...(round === 1 && attachFiles && attachFiles.length > 0 ? { fileIds: attachFiles.map((f) => f.fileId) } : {}) },
          {
            onDelta: (chunk) => {
              acc += chunk
              patchLastTurn(asstTurnId, () => ({ content: acc }))
            },
            onThinking: (th) => {
              if (!roundThinkStart) {
                roundThinkStart = Date.now()
                thinkKey = pushStage({ kind: 'think', text: '' })
              }
              roundThink += th
              patchStage(thinkKey, { text: roundThink.slice(-12000) })
            },
            onMeta: () => {},
            onTool: () => {},
            onToolResult: () => {},
            onSources: () => {},
          },
          controller.signal,
        )
        try {
          const r = await roundChat()
          uRounds++
          if (r.usage) { uPrompt += r.usage.prompt_tokens; uCompletion += r.usage.completion_tokens }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err
          await new Promise((r) => setTimeout(r, 800))
          const r = await roundChat()
          uRounds++
          if (r.usage) { uPrompt += r.usage.prompt_tokens; uCompletion += r.usage.completion_tokens }
        }
        if (thinkKey) patchStage(thinkKey, { ms: Math.max(0, Date.now() - roundThinkStart) })
        const parsed = parseAgentReply(acc)
        if (parsed.type === 'final') {
          // 纯散文回复（无 TOOL_CALL / FINAL 标记）→ 纠正后重试（≤2 次）
          if (!acc.trim().startsWith('FINAL') && round < MAX_ROUNDS - 2) {
            convo.push({ role: 'assistant', content: acc.slice(0, 200) })
            convo.push({ role: 'user', content: '你刚才输出了散文而非 TOOL_CALL。请严格按格式输出：恰好一行 TOOL_CALL {"tool":"工具名","args":{...}}，不要任何解释文字。' })
            continue
          }
          finalText = parsed.text
          break
        }
        if (round >= MAX_ROUNDS) {
          pausedNote = `已达轮次预算（${MAX_ROUNDS} 轮），已执行操作保留——可点击「继续」接着执行`
          break
        }
        const tool = parsed.call.tool
        const args = parsed.call.args
        const def = tools.find((t) => t.name === tool)
        const tKey = pushStage({
          kind: 'tool',
          label: def ? def.label(args) : tool,
          input: JSON.stringify(args).slice(0, 600),
          status: 'running',
        })
        let result: { ok: boolean; data?: unknown; error?: string }
        if (!def) {
          // 诊断：完整记录工具集状态（排查 mid-loop 工具丢失问题）
          const allNames = tools.map((t) => t.name).join(', ')
          console.warn('[AgentLoop] 未知工具:', tool, '| 循环工具集:', allNames, '| agentTools:', (agentToolsRef.current ?? []).length, '个', '| pkgId:', pkgIdRef.current, '| round:', round)
          result = { ok: false, error: `未知工具 ${tool}（可用：${allNames}；技能包=${pkgIdRef.current}；宿主工具=${(agentToolsRef.current ?? []).length}个）` }
        } else if (def.destructive && cautiousRef.current) {
          // 谨慎模式：破坏性工具执行前确认；取消=跳过（结果回喂，模型自适应）。
          const ok = await confirmDestructive(def.label(args))
          result = ok
            ? await def.exec(args).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
            : { ok: false, error: '用户在确认弹窗中选择了「跳过」——这不是技术错误，请换一种方式达成目标（如用非破坏性工具），或直接 FINAL 说明原因' }
        } else {
          try {
            result = await def.exec(args)
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }
        patchStage(tKey, {
          status: result.ok ? 'success' : 'error',
          output: (result.ok ? JSON.stringify(result.data ?? { ok: true }) : (result.error ?? '失败')).slice(0, 600),
        })
        // 熔断：同一工具+同一参数连续失败 → 大概率死循环（模型未消化错误）。
        const sig = result.ok ? '' : `${tool}:${JSON.stringify(args)}`
        if (result.ok) {
          failStreak = 0
          lastFailSig = ''
        } else if (sig === lastFailSig) {
          failStreak++
          if (failStreak >= FAIL_STREAK_LIMIT) {
            pausedNote = `连续 ${FAIL_STREAK_LIMIT} 次以相同参数调用 ${tool} 失败，已自动暂停——可「继续」换路径，或调整指令`
            break
          }
        } else {
          failStreak = 1
          lastFailSig = sig
        }
        convo.push({ role: 'assistant', content: `TOOL_CALL ${JSON.stringify({ tool, args })}` })
        convo.push({ role: 'user', content: `TOOL_RESULT ${JSON.stringify(result).slice(0, 3000)}` })
      }
      if (finalText) {
        patchLastTurn(asstTurnId, () => ({
          content: finalText,
          streaming: false,
          agentStream: false,
          limitPaused: false,
          planReady: opts.plan === true ? true : undefined,
          ...usagePatch(),
        }))
      } else {
        // 未出 FINAL（达预算/熔断）：保留会话上下文，消息下给「继续」。
        pendingConvosRef.current.set(asstTurnId, convo)
        patchLastTurn(asstTurnId, () => ({
          content: '（已暂停，操作已保留）',
          streaming: false,
          agentStream: false,
          limitPaused: true,
          note: pausedNote || '已暂停，可点击「继续」接着执行',
          ...usagePatch(),
        }))
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      patchLastTurn(asstTurnId, () => ({
        streaming: false,
        agentStream: false,
        note: aborted ? '已停止（已执行操作保留）' : undefined,
        error: aborted ? undefined : (err instanceof Error ? err.message : t(locale, 'aiAssistantErr')),
        ...usagePatch(),
      }))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  /** Agent 页「仅对话」模式：纯问答（不带编辑工具、不自动应用），上下文为
   *  当前文档全文/摘要（截 MAX_CONTEXT_CHARS）——与「可修改」的工具循环
   *  严格区分，AI 无任何改文档能力。 */
  const sendAgentChat = async (question: string) => {
    // 用户发送 = 关注最新输出：强制恢复贴底跟随。
    sticky.scrollToBottom()
    const tgt = getTargetRef.current()
    const full = tgt.text
    const truncated = full.length > MAX_CONTEXT_CHARS
    const userTurnId = ++turnIdRef.current
    const asstTurnId = ++turnIdRef.current
    setInput('')
    setNotice('')
    setTurns((prev) => [
      ...prev,
      {
        id: userTurnId, role: 'user', content: question,
        note: full.trim() ? `${zh ? '仅对话 · 全文上下文' : 'Chat-only · full context'}${truncated ? (zh ? `（截 ${MAX_CONTEXT_CHARS} 字）` : '') : ''}` : (zh ? '仅对话 · 无文档上下文' : 'Chat-only · no document context'),
      },
      { id: asstTurnId, role: 'assistant', content: '', streaming: true },
    ])
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const history: AIMessage[] = turns
      .filter((x) => !x.error && x.content)
      .slice(-HISTORY_ROUNDS * 2)
      .map((x) => ({ role: x.role, content: x.content }))
    const system = (zh
      ? `你是 DocFlow ${agentHostLabel(applyKind)}助手。当前为仅对话模式：回答用户关于当前文档/图表的问题，不要尝试修改文档。`
      : `You are the DocFlow ${agentHostLabel(applyKind)} assistant in chat-only mode: answer questions about the current document; do not modify it.`)
      + (full.trim() ? `\n\n${zh ? '当前内容' : 'Current content'}：\n<text>\n${truncated ? full.slice(0, MAX_CONTEXT_CHARS) : full}\n</text>` : '')
    const selectedModel = modelKey ? models.find((m) => m.id === modelKey) ?? null : null
    try {
      let acc = ''
      await aiChat(
        {
          messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: question }],
          providerId: selectedModel?.providerId || undefined,
          model: selectedModel ? { providerId: selectedModel.providerId, modelId: selectedModel.model } : undefined,
          web_search: toggles.web ? true : undefined,
          think: toggles.think ? true : undefined,
          use_mcp: toggles.mcp ? true : undefined,
        },
        {
          onMeta: (meta) => {
            const ws = normalizeWebSources((meta as { sources?: unknown }).sources)
            if (ws.length > 0) {
              setTurns((prev) => prev.map((x) => (x.id === asstTurnId ? { ...x, webSources: ws } : x)))
            }
          },
          onDelta: (chunk) => {
            acc += chunk
            patchLastTurn(asstTurnId, () => ({ content: acc }))
          },
          onThinking: (th) => {
            patchLastTurn(asstTurnId, (x) => ({
              thinking: (x.thinking ?? '') + th,
              thinkingStartedAt: x.thinkingStartedAt ?? Date.now(),
            }))
          },
          onTool: () => {},
          onToolResult: () => {},
          onSources: () => {},
        },
        controller.signal,
      )
      patchLastTurn(asstTurnId, (x) => ({
        streaming: false,
        thinkingMS: x.thinkingStartedAt ? Math.max(0, Date.now() - x.thinkingStartedAt) : undefined,
      }))
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      patchLastTurn(asstTurnId, (x) => ({
        streaming: false,
        content: x.content || (aborted ? '（已停止）' : ''),
        error: aborted ? undefined : (err instanceof Error ? err.message : t(locale, 'aiAssistantErr')),
        thinkingMS: x.thinkingStartedAt ? Math.max(0, Date.now() - x.thinkingStartedAt) : undefined,
      }))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  /** 发送：Agent 页按模式分发（可修改=工具循环 / 计划=只读规划 / 仅对话=纯问答）。 */
  const send = async (question: string) => {
    const text = question.trim()
    if (!text || busy) return
    // 用户发送 = 关注最新输出：强制恢复贴底跟随；引用文件随首轮注入上下文。
    sticky.scrollToBottom()
    const files = attached.length > 0 ? [...attached] : undefined
    setAttached([])
    if (agentTools && agentTools.length > 0) {
      const m = modeRef.current
      if (m === 'edit') { await sendAgent(text, files); return }
      if (m === 'plan') { await sendAgentPlan(text); return }
      await sendAgentChat(text)
      return
    }
    // 未注册工具的宿主（当前不存在）兜底纯问答。
    await sendAgentChat(text)
  }

  const copy = (content: string) => {
    void navigator.clipboard.writeText(content)
    void message.success(zh ? '已复制' : 'Copied')
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  if (!aiOn || !open) return null

  // 渲染提示文案（Agent 模式语义）。
  const modeHint = mode === 'edit'
    ? (zh ? '可修改：AI 经工具循环直接编辑文档' : 'Can edit: the AI edits via the tool loop')
    : mode === 'plan'
      ? (zh ? '计划：AI 只读探查并产出执行计划，可一键执行' : 'Plan: read-only exploration, then execute the plan')
      : (zh ? '仅对话' : 'Chat only')
  const modeTip = mode === 'edit'
    ? (zh ? 'AI 通过工具循环自主读文档、执行修改并校验；过程分阶段可折叠，达预算或熔断可「继续」；破坏性操作受谨慎模式确认。' : 'The AI reads, edits and verifies via tools; staged trace, resumable, destructive ops confirmed in cautious mode.')
    : mode === 'plan'
      ? (zh ? 'AI 只能用只读工具探查现状，最终输出分步执行计划；点击「按计划执行」转入执行循环。' : 'The AI explores read-only and outputs a step plan; "Execute plan" runs it.')
      : (zh ? '纯问答，不修改文档。' : 'Questions only; the document is never modified.')
  const placeholder = applyKind === 'excalidraw-json'
    ? (zh ? '描述想要的图，AI 生成白板元素插入画布，Enter 发送' : 'Describe the diagram; Enter to send')
    : applyKind === 'drawio-xml'
      ? (zh ? '描述要生成的图表或修改，Enter 发送' : 'Describe the diagram or change; Enter to send')
      : applyKind === 'richtext-patch'
        ? (zh ? '描述要做的修改，Enter 发送' : 'Describe the change; Enter to send')
        : (zh ? '输入指令，Enter 发送（Shift+Enter 换行）' : 'Type an instruction; Enter to send (Shift+Enter for newline)')
  const emptyHint = zh
    ? '描述要做的修改——AI 会先读文档再逐步编辑并校验；复杂目标可切「计划」模式。'
    : 'Describe the change — the AI reads first, edits step by step, and verifies. Use Plan mode for complex goals.'

  return (
    <>
      <AIChatShell
        open={true}
        zh={zh} hostType="editor" title={zh ? 'AI 对话' : 'AI chat'}
        onClose={onClose}
        messages={turns as unknown as ChatMessage[]}
        emptyHint={emptyHint} generatingLabel={t(locale, 'aiAssistantGenerating')}
        inputValue={input} onInputChange={setInput}
        onSend={() => void send(input)} onStop={stop} busy={busy}
        inputPlaceholder={placeholder}
        wrapRef={sticky.wrapRef} onScroll={sticky.onScroll}
        sessions={sessions} activeSessionId={activeSessId}
        onSwitchSession={switchSession}
        onRenameSession={(id) => { const c = sessions.find((x) => x.id === id); if (c) setSessEditing({ id: c.id, draft: c.title }) }}
        onDeleteSession={deleteSession} onNewSession={newSession}
        onExportSessions={() => void exportSessionsFile()}
        onImportSessions={() => importInputRef.current?.click()}
        onCopy={copy} onDeleteExchange={deleteExchange}
        onSaveConversation={() => void openSaveDialog()}
        onRegenerate={regenerate} onContinue={(id) => void continueAgent(id)}
        onExecutePlan={(plan) => void executePlan(plan)}
        savingFile={savingFile}
        mode={mode === 'plan' ? 'edit' : mode} onModeChange={changeMode} modeHint={modeHint} modeTip={modeTip} showModeSegment
        floatMode={floatMode} onToggleFloat={toggleFloatMode}
        panelRef={panelRef} onHeadPointerDown={onHeadPointerDown}
        batchMode={batchMode} onToggleBatch={() => (batchMode ? exitBatch() : setBatchMode(true))}
        checkedIds={checked} onToggleChecked={toggleChecked} onDeleteChecked={deleteChecked}
        packages={agentPackages} pkgId={pkgId} onPkgChange={setPkgId} applyKind={applyKind}
        cautious={cautious} onCautiousToggle={toggleCautious}
        attachedFiles={attached} onFileDetach={(fid) => setAttached((prev) => prev.filter((x) => x.fileId !== fid))}
        modelSlot={models.length > 0 ? (
          <AIModelSelect models={models} modelKey={modelKey} modelExplicit={modelExplicit}
            onSelect={(v) => { setModelKey(v); setModelExplicit(true) }} zh={zh} />
        ) : undefined}
        togglesSlot={(
          <AIChatToggleBar zh={zh} web={toggles.web} think={toggles.think} thinkBlocked={toggles.thinkBlocked}
            mcp={toggles.mcp} mcpAvailable={toggles.mcpAvailable} docs={toggles.docs} docsAvailable={toggles.docsAvailable}
            onWeb={toggles.setWeb} onThink={toggles.setThink} onMcp={toggles.setMcp} onDocs={toggles.setDocs} />
        )}
        skillSlot={(
          <AISkillButton zh={zh} onPick={(s) => {
            const tgt = getTargetRef.current()
            const sel = tgt.hasSelection ? tgt.text : ''
            if (!sel && s.prompt.includes('{selection}')) void message.warning(zh ? '未选中内容，{selection} 已置空' : 'No selection')
            setInput(renderSkillPrompt(s.prompt, { selection: sel, file: fileName }))
          }} />
        )}
      />
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
              {zh ? '保存目录' : 'Save to'}：{saveDialog.parentId ? (zh ? '当前文件所在目录' : "Current file's folder") : (zh ? '根目录' : 'Root')}
            </div>
          </div>
          <div className="modal-actions">
            <Button type="primary" disabled={!saveDialog.fileName.trim()} loading={savingFile} onClick={() => void confirmSaveFile()}>{zh ? '保存' : 'Save'}</Button>
            <Button onClick={() => setSaveDialog(null)}>{zh ? '取消' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}
      {sessEditing && (
        <Modal title={zh ? '重命名会话' : 'Rename session'} onClose={() => setSessEditing(null)}>
          <Input value={sessEditing.draft} maxLength={60}
            onChange={(e) => setSessEditing((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
            onPressEnter={renameSession} placeholder={zh ? '输入新的会话标题' : 'Enter a new title'} />
          <div className="modal-actions">
            <Button type="primary" disabled={!sessEditing.draft.trim()} onClick={renameSession}>{zh ? '确定' : 'OK'}</Button>
            <Button onClick={() => setSessEditing(null)}>{zh ? '取消' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}
    </>
  )
}