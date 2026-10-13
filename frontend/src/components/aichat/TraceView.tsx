// TraceView：Agent 过程追踪（v7.11 Cherry Studio 式重构）。
// 外层块：运行中「正在处理…」→ 完成后「已处理 · X分Y秒」，整块可折叠
//（运行中自动展开、完成自动收起）。内部按发生顺序混排：
//   note  = 叙述行（模型散文说明，无折叠）
//   think = 思考段（运行中「正在思考…」/ 完成「已思考（用时）」，可展开）
//   tool  = 工具调用（运行中「正在<label>…」/ 完成「<label>」+ 成功/失败
//           标签，可展开参数/结果；结果中的 URL 可点击）
// 运行中的最后一个阶段自动展开并贴底跟随（流式思考增量可见）。
import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react'

/** 过程阶段条目：note=叙述行，think=思考段，tool=工具调用。 */
export interface TraceStage {
  key: number
  kind: 'think' | 'tool' | 'note'
  /** 思考/叙述文本（think/note）。 */
  text?: string
  /** 思考耗时 ms（think）。 */
  ms?: number
  /** 工具展示名（tool，宿主 label(args)）。 */
  label?: string
  /** 工具入参摘要 JSON（tool）。 */
  input?: string
  /** 工具结果摘要（tool）。 */
  output?: string
  status?: 'running' | 'success' | 'error'
}

/** 用量汇总（runAgentLoop 聚合，SSE done usage 逐轮累计）。 */
export interface TraceUsage {
  rounds: number
  promptTokens: number
  completionTokens: number
  durationMS: number
}

/** 时长格式化：X分Y秒 / Y.Zs。 */
function fmtDur(ms: number): string {
  if (ms <= 0) return ''
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return `${m}分${r}秒`
}

/** 工具结果文本 → 带 URL 链接的片段（http(s) 链接可点击，供搜索结果跳转）。 */
function linkify(text: string): Array<string | { url: string }> {
  const out: Array<string | { url: string }> = []
  const re = /https?:\/\/[^\s"'<>）】]+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ url: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function TraceView({ stages, running, zh }: { stages: TraceStage[]; running: boolean; zh: boolean }) {
  // 整块：运行中展开、完成自动折叠（用户可再点开）。
  const [open, setOpen] = useState(running)
  useEffect(() => { setOpen(running) }, [running])
  // 用户手动展开/收起的阶段（运行态的「当前阶段」自动展开不受此影响）。
  const [openKeys, setOpenKeys] = useState<Set<number>>(new Set())
  const toggle = (key: number) => {
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // 当前阶段（最后一条）运行中自动展开；出现新阶段时旧的自动收起。
  const lastKey = stages.length > 0 ? stages[stages.length - 1].key : null
  const stageOpen = (key: number) => openKeys.has(key) || (running && key === lastKey)
  // 自动展开的思考体贴底跟随（流式增量更新时滚到最底）。
  const liveBodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (running && liveBodyRef.current) liveBodyRef.current.scrollTop = liveBodyRef.current.scrollHeight
  }, [stages, running])
  const totalMS = stages.reduce((acc, s) => acc + (s.ms ?? 0), 0)
  const thinkCount = stages.filter((s) => s.kind === 'think').length
  const toolCount = stages.filter((s) => s.kind === 'tool').length
  return (
    <div className={`ai-trace${running ? ' running' : ''}`}>
      <button type="button" className="ai-trace-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />}
        {running && <Loader2 size={12} strokeWidth={2} aria-hidden="true" className="ai-trace-spin" />}
        <span className="ai-trace-title">
          {running
            ? (zh ? '正在处理…' : 'Processing…')
            : (zh ? `已处理 · ${fmtDur(totalMS) || '<0.1s'}` : `Done · ${fmtDur(totalMS) || '<0.1s'}`)}
        </span>
        <span className="ai-trace-meta">
          {thinkCount + toolCount > 0 ? `${thinkCount + toolCount}${zh ? ' 步' : ' steps'}` : ''}
        </span>
      </button>
      {open && (
        <div className="ai-trace-list">
          {stages.map((st) => {
            const isLive = running && st.key === lastKey
            const stageBodyRef = isLive ? liveBodyRef : undefined
            if (st.kind === 'note') {
              return (
                <div key={st.key} className="ai-trace-note">{st.text}</div>
              )
            }
            return (
              <div key={st.key} className={`ai-trace-stage${isLive ? ' live' : ''}`}>
                <button type="button" className="ai-trace-row" onClick={() => toggle(st.key)} aria-expanded={stageOpen(st.key)}>
                  {stageOpen(st.key)
                    ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
                    : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
                  {st.kind === 'think'
                    ? <Brain size={12} strokeWidth={2} aria-hidden="true" className="ai-trace-icon-think" />
                    : <Wrench size={12} strokeWidth={2} aria-hidden="true" className="ai-trace-icon-tool" />}
                  <span className="ai-trace-label">
                    {st.kind === 'think'
                      ? (running && isLive
                          ? (zh ? '正在思考…' : 'Thinking…')
                          : (zh ? `已思考${st.ms ? `（${fmtDur(st.ms)}）` : ''}` : `Thought${st.ms ? ` (${fmtDur(st.ms)})` : ''}`))
                      : (running && isLive
                          ? (zh ? `正在${st.label || '执行'}…` : `Running ${st.label || 'tool'}…`)
                          : (st.label || 'tool'))}
                  </span>
                  {st.kind === 'tool' && !isLive && st.status && (
                    <span className={`ai-trace-status ${st.status}`}>
                      {st.status === 'error' ? (zh ? '失败' : 'Failed') : (zh ? '成功' : 'OK')}
                    </span>
                  )}
                </button>
                {stageOpen(st.key) && (st.kind === 'think' ? st.text : (st.input || st.output)) && (
                  <div
                    ref={stageBodyRef}
                    className={`ai-trace-body${st.kind === 'tool' ? ' mono' : ''}${isLive && st.kind === 'think' ? ' live-follow' : ''}`}
                  >
                    {st.kind === 'think'
                      ? st.text
                      : linkify(`${st.input ?? ''}${st.output ? `\n→ ${st.output}` : ''}`).map((part, i) =>
                          typeof part === 'string' ? <span key={i}>{part}</span> : (
                            <a key={i} href={part.url} target="_blank" rel="noopener noreferrer">{part.url}</a>
                          ),
                        )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
