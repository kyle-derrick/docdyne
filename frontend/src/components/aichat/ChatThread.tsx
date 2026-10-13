// ChatThread：统一 AI 对话消息流（阶段一 S2）。
// 从 AIEditChat 提取——包含：消息列表容器（贴底跟随）+ 用户/助手气泡 +
// TraceView/AIChatThinking + 操作行（复制/删除/保存/重新生成/继续/按计划执行）。
// 所有宿主共用；场景差异通过 props 的回调函数注入。
// v7.4（S8）：内容恢复 AIMarkdown 渲染（S7 迁移时误回退为纯文本）；补齐
// 助手宿主字段——toolCalls/sources/webSources/stopped/usageAI + emptySlot。
// v7.6：用户操作行移到气泡下方；agent 流式原始行在有 trace 时隐藏（过程
// 由 TraceView 呈现）；用量（tokens+整体耗时）统一显示在回复内容底部；
// 消息流离底时显示「回到底部」悬浮按钮。
import { Button, Tooltip } from 'antd'
import { ArrowDown, Copy, FileText, Paperclip, Play, RotateCcw, Save, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { AIChatThinking, AIWebSourcesView } from './AIMessageList'
import type { AIToolCallEntry, AIWebSource } from './turns'
import AIMarkdown from '../AIMarkdown'
import type { AISource, AIUsage } from '../../api'
import TraceView from './TraceView'
import type { TraceStage, TraceUsage } from './TraceView'

/** 单条消息（统一结构——三处宿主的 ChatTurn 归一化）。 */
export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: string
  note?: string
  files?: Array<{ fileId: string; fileName: string }>
  thinking?: string
  thinkingStartedAt?: number
  thinkingMS?: number
  trace?: TraceStage[]
  agentStream?: boolean
  limitPaused?: boolean
  planReady?: boolean
  /** Agent 循环用量（编辑宿主 runAgentLoop 聚合）。 */
  usage?: TraceUsage
  // ---- 助手宿主字段（编辑宿主不产生；渲染端全部可选） ----
  /** 用户主动停止（保留已生成内容，不视为错误）。 */
  stopped?: boolean
  /** 工具调用链（df_* 平台文件工具 / MCP）。 */
  toolCalls?: AIToolCallEntry[]
  /** RAG 检索来源文件链接。 */
  sources?: AISource[]
  /** 联网搜索来源。 */
  webSources?: AIWebSource[]
  /** 本轮用量（SSE done；非 agent 路径）。 */
  usageAI?: AIUsage
  /** 工具阶段前的中间叙述（助手宿主；渲染为正文前的过程说明行）。 */
  prologue?: string[]
  /** 破坏性工具待确认（v7.7 谨慎模式对话内确认卡；编辑宿主）。 */
  confirmReq?: { label: string }
}

export interface ChatThreadProps {
  zh: boolean
  messages: ChatMessage[]
  emptyHint: string
  /** 空态自定义内容（assistant：欢迎语 + 建议卡；提供时替代 emptyHint 文本）。 */
  emptySlot?: ReactNode
  generatingLabel: string
  // 操作回调
  onCopy: (content: string) => void
  onDeleteExchange: (asstId: number) => void
  /** 未提供时隐藏「保存」按钮（viewer 宿主无会话落盘）。 */
  onSaveConversation?: (ids?: number[]) => void
  onRegenerate: (asstId: number) => void
  onContinue: (asstId: number) => void
  onExecutePlan: (planText: string) => void
  /** 助手消息操作行扩展位（viewer：保存为新版本）。 */
  actionSlot?: (msg: ChatMessage) => ReactNode
  /** 谨慎模式对话内确认回调（v7.7：破坏性工具 [确认执行/跳过]）。 */
  onConfirmTool?: (asstId: number, ok: boolean) => void
  // 状态
  busy: boolean
  batchMode: boolean
  /** 保存中（「保存」按钮 loading；未提供按 false）。 */
  savingFile?: boolean
  // 批量勾选
  checkedIds: Set<number>
  onToggleChecked: (id: number) => void
  // ref/onScroll（贴底跟随）
  wrapRef: React.Ref<HTMLDivElement>
  onScroll: (e: { target: EventTarget | null }) => void
}

/** 用量统一提取（agent TraceUsage 与非 agent AIUsage 两种来源）。 */
function usageOf(msg: ChatMessage): { tokens: number; ms: number } | null {
  if (msg.usage && (msg.usage.promptTokens || msg.usage.completionTokens)) {
    return { tokens: msg.usage.promptTokens + msg.usage.completionTokens, ms: msg.usage.durationMS || 0 }
  }
  if (msg.usageAI && ((msg.usageAI.prompt_tokens || 0) + (msg.usageAI.completion_tokens || 0) > 0)) {
    return { tokens: (msg.usageAI.prompt_tokens || 0) + (msg.usageAI.completion_tokens || 0), ms: msg.usageAI.duration_ms || 0 }
  }
  return null
}

/** 原始 TOOL_CALL 紧凑行（无 trace 的兜底展示；有 trace 时由 TraceView 呈现）。 */
function AgentRawLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`ai-agent-raw${open ? ' open' : ''}`}
      role="button" tabIndex={0} aria-expanded={open}
      title={open ? undefined : text}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setOpen((v) => !v) } }}
    >{text}</div>
  )
}

/** 由宿主字段合成过程阶段（v7.12：助手/查看器无显式 trace 时统一走
 * TraceView——prologue→note、thinking→think、toolCalls→tool）。 */
function synthStages(msg: ChatMessage): TraceStage[] | undefined {
  if (msg.trace && msg.trace.length > 0) return msg.trace
  const out: TraceStage[] = []
  let key = 1
  for (const p of msg.prologue ?? []) {
    if (p.trim()) out.push({ key: key++, kind: 'note', text: p.trim() })
  }
  if (msg.thinking) out.push({ key: key++, kind: 'think', text: msg.thinking, ms: msg.thinkingMS })
  for (const tc of msg.toolCalls ?? []) {
    out.push({ key: key++, kind: 'tool', label: tc.label, input: tc.input, output: tc.output ?? tc.errorText, status: tc.status })
  }
  return out.length > 0 ? out : undefined
}

export default function ChatThread({
  zh, messages, emptyHint, emptySlot, generatingLabel,
  onCopy, onDeleteExchange, onSaveConversation, onRegenerate, onContinue, onExecutePlan,
  actionSlot, onConfirmTool,
  busy, batchMode, savingFile,
  checkedIds, onToggleChecked,
  wrapRef, onScroll,
}: ChatThreadProps) {
  // 「回到底部」悬浮按钮：滚动离底 >40px 时显示（v7.6）。
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const scrollEl = wrapRef as React.RefObject<HTMLDivElement | null>
  const probeBottom = () => {
    const el = scrollEl.current
    if (!el) return
    setAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 40)
  }
  const handleScroll = (e: { target: EventTarget | null }) => {
    onScroll(e)
    probeBottom()
  }
  // 消息/流式变化后复测（新内容把容器推高时按钮应出现/消失）。
  useEffect(probeBottom)
  const jumpToBottom = () => {
    const el = scrollEl.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAwayFromBottom(false)
  }
  return (
    <div className="ai-edit-chat-thread" ref={wrapRef} onScroll={handleScroll}>
      {messages.length === 0 && (emptySlot ?? <div className="ai-edit-chat-empty muted">{emptyHint}</div>)}
      {messages.map((msg) => {
        const usage = usageOf(msg)
        return (
        <div key={msg.id} className={`ai-turn ai-turn-${msg.role}`}>
          {batchMode && (
            <input
              type="checkbox"
              className="ai-turn-check"
              checked={checkedIds.has(msg.id)}
              onChange={() => onToggleChecked(msg.id)}
            />
          )}
          {msg.role === 'user' ? (
            <>
              <div className="ai-bubble ai-bubble-user">
                {msg.content}
                {msg.files && msg.files.length > 0 && (
                  <span className="ai-turn-files">
                    {msg.files.map((f) => (
                      <span key={f.fileId} className="ai-turn-file-chip" title={f.fileName}>
                        <Paperclip size={10} strokeWidth={2} aria-hidden="true" />
                        <span>{f.fileName}</span>
                      </span>
                    ))}
                  </span>
                )}
                {msg.note && <div className="ai-edit-chat-note">{msg.note}</div>}
                {/* v7.10：复制移入气泡内左下角（原在气泡外右下）。 */}
                {!batchMode && (
                  <div className="user-ops-in">
                    <button type="button" onClick={() => onCopy(msg.content)} aria-label={zh ? '复制' : 'Copy'}>
                      <Copy size={11} strokeWidth={2} aria-hidden="true" />
                      {zh ? '复制' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="ai-avatar" aria-hidden="true">🤖</div>
              <div className="ai-bubble ai-bubble-assistant">
                {(() => {
                  const stages = synthStages(msg)
                  if (stages) return <TraceView stages={stages} running={!!msg.streaming} zh={zh} />
                  return <AIChatThinking text={msg.thinking ?? ''} streaming={msg.streaming} thinkingMS={msg.thinkingMS} zh={zh} />
                })()}
                {/* 破坏性工具对话内确认卡（v7.7 谨慎模式；参考 Cherry Studio）。 */}
                {msg.confirmReq && (
                  <div className="ai-confirm-card" role="alertdialog" aria-label={zh ? '操作确认' : 'Action confirmation'}>
                    <div className="ai-confirm-title">
                      <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
                      {zh ? '即将执行操作，请确认' : 'Action needs confirmation'}
                    </div>
                    <div className="ai-confirm-label">{msg.confirmReq.label}</div>
                    <div className="ai-confirm-ops">
                      <Button size="small" type="primary" danger onClick={() => onConfirmTool?.(msg.id, true)}>
                        {zh ? '确认执行' : 'Confirm'}
                      </Button>
                      <Button size="small" onClick={() => onConfirmTool?.(msg.id, false)}>
                        {zh ? '跳过' : 'Skip'}
                      </Button>
                    </div>
                  </div>
                )}
                {msg.content ? (
                  msg.agentStream && msg.streaming && !synthStages(msg) ? (
                    <AgentRawLine text={msg.content} />
                  ) : msg.agentStream ? null : (
                    <AIMarkdown text={msg.content} zh={zh} streaming={msg.streaming} />
                  )
                ) : msg.streaming ? (
                  <span className="ai-thinking">{generatingLabel}</span>
                ) : msg.stopped ? (
                  <span className="ai-thinking muted">{zh ? '（已停止）' : '(stopped)'}</span>
                ) : (
                  <span className="muted">{zh ? '（模型未返回内容）' : '(no content)'}</span>
                )}
                {msg.streaming && msg.content && !(msg.trace && msg.trace.length > 0) && <span className="ai-caret" aria-hidden="true" />}
                {msg.stopped && msg.content && <span className="ai-stopped-tag">{zh ? '已停止' : 'stopped'}</span>}
                {msg.error && <div className="ai-error-msg">{msg.error}</div>}
                {/* RAG 检索来源文件链接。 */}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="ai-sources">
                    <span className="ai-sources-label muted">{zh ? '来源' : 'Sources'}：</span>
                    {msg.sources.map((s) => (
                      <a key={s.file_id} className="ai-source-link" href={s.url} target="_blank" rel="noopener noreferrer" title={s.name}>
                        <FileText size={12} strokeWidth={2} aria-hidden="true" />
                        {s.name}
                      </a>
                    ))}
                  </div>
                )}
                {/* 联网搜索来源（折叠列表）。 */}
                {msg.webSources && <AIWebSourcesView sources={msg.webSources} zh={zh} />}
                {/* 用量（tokens + 整体耗时；回复内容底部）。 */}
                {usage && !msg.streaming && (
                  <div className="ai-usage-line muted">
                    {usage.tokens} tok{usage.ms > 0 ? ` · ${(usage.ms / 1000).toFixed(1)}s` : ''}
                  </div>
                )}
                {msg.note && <div className="ai-edit-chat-note muted">{msg.note}</div>}
                {msg.planReady && !msg.streaming && !batchMode && (
                  <div className="ai-edit-chat-actions">
                    <Button size="small" type="primary" ghost icon={<Play size={12} strokeWidth={2} />} disabled={busy} onClick={() => onExecutePlan(msg.content)}>
                      {zh ? '按计划执行' : 'Execute plan'}
                    </Button>
                  </div>
                )}
                {msg.limitPaused && !msg.streaming && (
                  <div className="ai-edit-chat-actions">
                    <Button size="small" type="primary" ghost icon={<Play size={12} strokeWidth={2} />} onClick={() => onContinue(msg.id)}>
                      {zh ? '继续' : 'Continue'}
                    </Button>
                  </div>
                )}
                {!msg.streaming && (msg.content || msg.stopped) && !batchMode && (
                  <div className="ai-edit-chat-actions">
                    {msg.content && (
                      <Button size="small" type="text" icon={<Copy size={13} strokeWidth={2} />} onClick={() => onCopy(msg.content)}>
                        {zh ? '复制' : 'Copy'}
                      </Button>
                    )}
                    <Tooltip title={zh ? '删除本轮问答' : 'Delete exchange'}>
                      <Button size="small" type="text" icon={<Trash2 size={13} strokeWidth={2} />} onClick={() => onDeleteExchange(msg.id)}>
                        {zh ? '删除' : 'Delete'}
                      </Button>
                    </Tooltip>
                    {onSaveConversation && (
                      <Tooltip title={zh ? '保存会话到文件' : 'Save to file'}>
                        <Button size="small" type="text" icon={<Save size={13} strokeWidth={2} />} loading={savingFile} onClick={() => onSaveConversation()}>
                          {zh ? '保存' : 'Save'}
                        </Button>
                      </Tooltip>
                    )}
                    {actionSlot?.(msg)}
                    {msg.id === messages[messages.length - 1]?.id && (
                      <Tooltip title={zh ? '删除并重新生成' : 'Delete & regenerate'}>
                        <Button size="small" type="text" icon={<RotateCcw size={13} strokeWidth={2} />} disabled={busy} onClick={() => onRegenerate(msg.id)}>
                          {zh ? '重新生成' : 'Retry'}
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        )
      })}
      {/* 回到底部悬浮按钮（离底时出现）。 */}
      {messages.length > 0 && awayFromBottom && (
        <button type="button" className="ai-jump-bottom" aria-label={zh ? '回到底部' : 'Scroll to bottom'}
          title={zh ? '回到底部（跟随最新输出）' : 'Scroll to bottom'} onClick={jumpToBottom}>
          <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
