// ChatThread：统一 AI 对话消息流（阶段一 S2）。
// 从 AIEditChat 提取——包含：消息列表容器（贴底跟随）+ 用户/助手气泡 +
// TraceView/AIChatThinking + 操作行（复制/删除/保存/重新生成/继续/按计划执行）。
// 所有宿主共用；场景差异通过 props 的回调函数注入。
import { Button, Tooltip } from 'antd'
import { Copy, Paperclip, Play, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AIChatThinking } from './index'
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
  usage?: TraceUsage
}

export interface ChatThreadProps {
  zh: boolean
  messages: ChatMessage[]
  emptyHint: string
  generatingLabel: string
  // 操作回调
  onCopy: (content: string) => void
  onDeleteExchange: (asstId: number) => void
  onSaveConversation: () => void
  onRegenerate: (asstId: number) => void
  onContinue: (asstId: number) => void
  onExecutePlan: (planText: string) => void
  // 状态
  busy: boolean
  batchMode: boolean
  savingFile: boolean
  // 批量勾选
  checkedIds: Set<number>
  onToggleChecked: (id: number) => void
  // ref/onScroll（贴底跟随）
  wrapRef: React.Ref<HTMLDivElement>
  onScroll: (e: { target: EventTarget | null }) => void
}

/** 原始 TOOL_CALL 紧凑行。 */
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

export default function ChatThread({
  zh, messages, emptyHint, generatingLabel,
  onCopy, onDeleteExchange, onSaveConversation, onRegenerate, onContinue, onExecutePlan,
  busy, batchMode, savingFile,
  checkedIds, onToggleChecked,
  wrapRef, onScroll,
}: ChatThreadProps) {
  return (
    <div className="ai-edit-chat-thread" ref={wrapRef} onScroll={onScroll}>
      {messages.length === 0 && (
        <div className="ai-edit-chat-empty muted">{emptyHint}</div>
      )}
      {messages.map((msg) => (
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
              </div>
              {!batchMode && (
                <div className="ai-edit-chat-actions user-ops">
                  <Button size="small" type="text" icon={<Copy size={12} strokeWidth={2} />} onClick={() => onCopy(msg.content)}>
                    {zh ? '复制' : 'Copy'}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ai-avatar" aria-hidden="true">🤖</div>
              <div className="ai-bubble ai-bubble-assistant">
                {msg.trace && msg.trace.length > 0 ? (
                  <TraceView stages={msg.trace} running={!!msg.streaming} zh={zh} usage={msg.usage} />
                ) : (
                  <AIChatThinking text={msg.thinking ?? ''} streaming={msg.streaming} thinkingMS={msg.thinkingMS} zh={zh} />
                )}
                {msg.content ? (
                  msg.agentStream && msg.streaming ? (
                    <AgentRawLine text={msg.content} />
                  ) : (
                    <div className="ai-markdown-body">{msg.content}</div>
                  )
                ) : msg.streaming ? (
                  <span className="ai-thinking">{generatingLabel}</span>
                ) : (
                  <span className="muted">{zh ? '（模型未返回内容）' : '(no content)'}</span>
                )}
                {msg.streaming && msg.content && <span className="ai-caret" aria-hidden="true" />}
                {msg.error && <div className="ai-error-msg">{msg.error}</div>}
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
                {!msg.streaming && msg.content && !batchMode && (
                  <div className="ai-edit-chat-actions">
                    <Button size="small" type="text" icon={<Copy size={13} strokeWidth={2} />} onClick={() => onCopy(msg.content)}>
                      {zh ? '复制' : 'Copy'}
                    </Button>
                    <Tooltip title={zh ? '删除本轮问答' : 'Delete exchange'}>
                      <Button size="small" type="text" icon={<Trash2 size={13} strokeWidth={2} />} onClick={() => onDeleteExchange(msg.id)}>
                        {zh ? '删除' : 'Delete'}
                      </Button>
                    </Tooltip>
                    <Tooltip title={zh ? '保存会话到文件' : 'Save to file'}>
                      <Button size="small" type="text" icon={<Save size={13} strokeWidth={2} />} loading={savingFile} onClick={onSaveConversation}>
                        {zh ? '保存' : 'Save'}
                      </Button>
                    </Tooltip>
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
      ))}
    </div>
  )
}
