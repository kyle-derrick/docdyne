// TraceView：Agent 过程追踪（v7.3 分阶段折叠展示，opencode/Cherry Studio 式）。
// 思考段与工具调用按发生顺序交织为独立条目：每项可展开/折叠；整个过程块
// 在运行中自动展开、完成后自动折叠（点击头部可再展开）。
import { useEffect, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Wrench } from 'lucide-react'

/** 过程阶段条目：think=一轮思考段（带耗时），tool=一次工具调用。 */
export interface TraceStage {
  key: number
  kind: 'think' | 'tool'
  /** 思考文本（think）。 */
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

export default function TraceView({ stages, running, zh }: { stages: TraceStage[]; running: boolean; zh: boolean }) {
  // 整块：运行中展开、完成自动折叠（用户可再点开）。
  const [open, setOpen] = useState(running)
  useEffect(() => { setOpen(running) }, [running])
  const [openKeys, setOpenKeys] = useState<Set<number>>(new Set())
  const toggle = (key: number) => {
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const thinkCount = stages.filter((s) => s.kind === 'think').length
  const toolCount = stages.filter((s) => s.kind === 'tool').length
  const totalMS = stages.reduce((acc, s) => acc + (s.ms ?? 0), 0)
  return (
    <div className={`ai-trace${running ? ' running' : ''}`}>
      <button type="button" className="ai-trace-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />}
        <span className="ai-trace-title">{zh ? '思考与操作过程' : 'Process'}</span>
        <span className="ai-trace-meta">
          {zh
            ? `${thinkCount} 段思考 · ${toolCount} 次操作${totalMS ? ` · ${(totalMS / 1000).toFixed(1)}s` : ''}`
            : `${thinkCount} thoughts · ${toolCount} tools${totalMS ? ` · ${(totalMS / 1000).toFixed(1)}s` : ''}`}
        </span>
        {running && <span className="ai-trace-spin" aria-hidden="true" />}
      </button>
      {open && (
        <div className="ai-trace-list">
          {stages.map((st) => (
            <div key={st.key} className="ai-trace-stage">
              <button type="button" className="ai-trace-row" onClick={() => toggle(st.key)} aria-expanded={openKeys.has(st.key)}>
                {openKeys.has(st.key)
                  ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
                  : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
                {st.kind === 'think'
                  ? <Brain size={12} strokeWidth={2} aria-hidden="true" className="ai-trace-icon-think" />
                  : <Wrench size={12} strokeWidth={2} aria-hidden="true" className="ai-trace-icon-tool" />}
                <span className="ai-trace-label">
                  {st.kind === 'think'
                    ? (zh ? `已思考${st.ms ? `（${(st.ms / 1000).toFixed(1)}s）` : ''}` : `Thought${st.ms ? ` (${(st.ms / 1000).toFixed(1)}s)` : ''}`)
                    : (st.label || 'tool')}
                </span>
                {st.kind === 'tool' && st.status && <span className={`ai-trace-dot ${st.status}`} aria-hidden="true" />}
              </button>
              {openKeys.has(st.key) && (st.kind === 'think' ? st.text : (st.input || st.output)) && (
                <div className={`ai-trace-body${st.kind === 'tool' ? ' mono' : ''}`}>
                  {st.kind === 'think'
                    ? st.text
                    : `${st.input ?? ''}${st.output ? `\n→ ${st.output}` : ''}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
