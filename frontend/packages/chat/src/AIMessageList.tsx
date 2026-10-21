// AI 对话共享展示组件（思考折叠区 / 工具调用链 / 网络来源）。
// v7.4（S14）：Bubble.List 消息流（AIMessageList/AIAssistantMessageBody/
// AIUserMessageBody）已被 ChatThread 统一替代并删除——本文件仅保留三处
// 宿主（ChatThread/ViewerAIWidget 摘要页等）仍在使用的展示组件：
// - AIChatThinking：思考过程折叠区（流式展开跟随、完成自动收起 + 用时）；
// - AIToolChain：工具调用链（ThoughtChain：running 旋转 → success/error
//   终态，可展开参数/结果摘要；dd_write_file 附「已保存（自动留版本）」）；
// - AIWebSourcesView：网络来源折叠列表（编号 + 标题超链接）。
import { useEffect, useMemo, useState } from 'react'
import { ThoughtChain } from '@ant-design/x'
import { Brain, Globe, Wrench } from 'lucide-react'
import {
  ddToolLabel, isWriteTool, thinkingTitle,
} from './turns'
import type { AIToolCallEntry, AIWebSource } from './turns'

/** 思考过程折叠区（Think 封装）：流式期间展开跟随、完成后自动收起并
 *  展示用时；用户手动展开/收起后不再被流式状态覆盖。 */
export function AIChatThinking({ text, streaming, thinkingMS, zh }: {
  text: string
  streaming?: boolean
  thinkingMS?: number
  zh: boolean
}) {
  const [expanded, setExpanded] = useState<boolean>(!!streaming)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    // 流式结束自动收起（仅用户未手动操作过时）。
    if (!streaming && !touched) setExpanded(false)
  }, [streaming, touched])
  if (!text) return null
  return (
    <div className="aic-thinking">
      <Brain size={14} strokeWidth={2} className="aic-thinking-bg" aria-hidden="true" />
      <div className="aic-thinking-body" aria-hidden="false">
        <details open={expanded} onToggle={(e) => { setTouched(true); setExpanded((e.target as HTMLDetailsElement).open) }}>
          <summary className="aic-thinking-summary">
            <span className={`aic-thinking-title${streaming ? ' streaming' : ''}`}>
              {thinkingTitle({ streaming, thinkingMS }, zh)}
            </span>
            {streaming && <span className="aic-thinking-dots" aria-hidden="true"><i /><i /><i /></span>}
          </summary>
          <div className="aic-thinking-text">{text}</div>
        </details>
      </div>
    </div>
  )
}

/** 工具参数/结果摘要展示（<pre> 定宽；无内容返回 null）。 */
function ToolDetail({ entry, zh }: { entry: AIToolCallEntry; zh: boolean }) {
  const parts: Array<{ label: string; text: string }> = []
  if (entry.input) parts.push({ label: zh ? '参数' : 'Input', text: entry.input })
  if (entry.output) parts.push({ label: zh ? '结果' : 'Output', text: entry.output })
  if (entry.errorText) parts.push({ label: zh ? '错误' : 'Error', text: entry.errorText })
  if (parts.length === 0) return null
  return (
    <div className="aic-tool-detail">
      {parts.map((p) => (
        <div key={p.label} className="aic-tool-detail-row">
          <span className="k">{p.label}</span>
          <pre className="v">{p.text}</pre>
        </div>
      ))}
    </div>
  )
}

/** 工具调用链（ThoughtChain 封装）：running 旋转 → success/error 终态；
 *  有参数/结果摘要的条目可展开。dd_write_file 附「已保存（自动留版本）」。
 *  顶部带步骤进度（Step X/N），条目带序号。 */
export function AIToolChain({ toolCalls, zh }: { toolCalls: AIToolCallEntry[] | undefined; zh: boolean }) {
  const items = useMemo(() => (toolCalls ?? []).map((tc, i) => {
    const hasDetail = !!(tc.input || tc.output || tc.errorText)
    const dur = tc.durationMS !== undefined && tc.durationMS > 0
      ? (tc.durationMS >= 1000 ? `${(tc.durationMS / 1000).toFixed(1)}s` : `${tc.durationMS}ms`)
      : ''
    const title = (
      <span className="aic-tool-title">
        <span className="aic-tool-step">{i + 1}</span>
        {ddToolLabel(tc, zh)}
        {isWriteTool(tc) && <span className="aic-tool-saved">{zh ? ' · 已保存（自动留版本）' : ' · saved (auto versioned)'}</span>}
        {dur && <span className="aic-tool-dur"> · {dur}</span>}
      </span>
    )
    return {
      key: String(i),
      icon: <Wrench size={14} strokeWidth={2} aria-hidden="true" />,
      title,
      status: tc.status === 'running' ? ('loading' as const) : tc.status === 'error' ? ('error' as const) : ('success' as const),
      collapsible: hasDetail,
      content: hasDetail ? <ToolDetail entry={tc} zh={zh} /> : undefined,
    }
  }), [toolCalls, zh])
  if (items.length === 0) return null

  // 步骤进度统计。
  const done = (toolCalls ?? []).filter((tc) => tc.status === 'success' || tc.status === 'error').length
  const total = (toolCalls ?? []).length
  const running = (toolCalls ?? []).some((tc) => tc.status === 'running')
  const progressLabel = running
    ? (zh ? `执行中 ${done}/${total}` : `Running ${done}/${total}`)
    : (zh ? `已完成 ${total} 步` : `${total} steps done`)

  return (
    <div className="aic-toolchain">
      <div className="aic-toolchain-progress">
        <span className="aic-toolchain-progress-label">{progressLabel}</span>
        <span className="aic-toolchain-progress-bar">
          <span className="aic-toolchain-progress-fill" style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
        </span>
      </div>
      <ThoughtChain items={items} />
    </div>
  )
}

/** 网络来源折叠列表（编号 + 标题超链接；联网开关生效时展示）。 */
export function AIWebSourcesView({ sources, zh }: { sources: AIWebSource[]; zh: boolean }) {
  const [open, setOpen] = useState(false)
  if (sources.length === 0) return null
  return (
    <details className="aic-websources" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><Globe size={12} strokeWidth={2} aria-hidden="true" />{zh ? `网络来源（${sources.length}）` : `Web sources (${sources.length})`}</summary>
      <div className="aic-websources-list">
        {sources.map((s, i) => {
          const inner = (
            <>
              <span className="idx" aria-hidden="true">{i + 1}</span>
              <span className="name">{s.title}</span>
            </>
          )
          return s.url ? (
            <a key={`${i}:${s.url}`} className="aic-websource-link" href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
              {inner}
            </a>
          ) : (
            <span key={`${i}:${s.title}`} className="aic-websource-link" title={s.title}>{inner}</span>
          )
        })}
      </div>
    </details>
  )
}
