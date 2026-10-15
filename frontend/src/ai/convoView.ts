// Agent 会话视图纯函数集（v7.15）：从 AIEditChat.tsx 抽出的无副作用模块
// ——滑动窗口压缩、结构化轮次摘要（A2）、token 估算掺实测（L5）、未知
// 工具近名建议（E2）。独立成文件的原因：scripts/verify-convo-view.mjs
// 直接 import 本模块做 100+ 轮分层上下文验证（A5），不引入 React 运行时。
import type { AIMessage } from '../api'

/** token 估算掺实测（v7.15 L5，opencode 模式）：以最近一轮真实 usage 的
 *  「发送字符数 / prompt_tokens」为比率做 EMA 校准（夹在 [1.5,8]），替代
 *  纯 chars/4——中文/代码/XML 的 token 密度差异大，实测后压缩触发点更准。
 *  模块级共享：跨编辑器会话延续校准。 */
let tokRatio = 4 // chars per token
export function calibrateTokRatio(viewChars: number, promptTokens: number): void {
  if (!viewChars || !promptTokens) return
  const r = viewChars / promptTokens
  if (!Number.isFinite(r) || r <= 0) return
  const clamped = Math.min(8, Math.max(1.5, r))
  tokRatio = Math.min(8, Math.max(1.5, tokRatio * 0.6 + clamped * 0.4))
}
export function estTokens(chars: number): number {
  return Math.ceil(chars / tokRatio)
}

/** 未知工具时的近名建议（E2）：相等/子串/公共前缀启发，取前 3——模型
 *  拼错工具名（如 read_scene→read_scence、update_cells→update_cell）时
 *  能在下一轮自纠，不再靠反复试错烧轮次。 */
export function suggestTools(name: string, candidates: string[]): string {
  if (!name || candidates.length === 0) return ''
  const n = name.toLowerCase()
  const scored = candidates
    .map((c) => {
      const t = c.toLowerCase()
      let score = 0
      if (t === n) score = 100
      else if (t.includes(n) || n.includes(t)) score = 70
      else {
        let common = 0
        while (common < n.length && common < t.length && n[common] === t[common]) common++
        score = common * 2
        let i = 0
        for (const ch of n) {
          if (ch === t[i]) i++
        }
        if (i >= Math.min(t.length, 3)) score += 10
      }
      return { c, score }
    })
    .filter((x) => x.score >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  return scored.length ? `（你是不是想用：${scored.map((x) => x.c).join(' / ')}？）` : ''
}

/** 截断辅助：按 rune 截（中文场景 chars/length 差异可忽略，slice 足够）。 */
function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 从 TOOL_CALL / TOOL_RESULT 行安全解析 JSON（解析失败返回 null，不抛）。 */
function parseAgentLine<T>(content: string, prefix: string): T | null {
  if (!content.startsWith(prefix)) return null
  try {
    return JSON.parse(content.slice(prefix.length)) as T
  } catch {
    return null
  }
}

/** 被压缩轮次的结构化摘要（v7.15 A2）：程序化提取每轮
 *  「工具名(关键参数)→结果 ok/error」与用户意图行——工具结果是 JSON、
 *  提取准确，早期上下文不再只剩一句「已省略」，模型仍知道「此前做过
 *  什么、哪些已成功」。超出 maxChars 时丢弃最旧行（时近原则的镜像），
 *  并注明省略条数。 */
export function droppedDigest(messages: AIMessage[], maxChars = 1600): string {
  type Line = { idx: number; text: string }
  const lines: Line[] = []
  let seq = 0
  const push = (text: string) => {
    lines.push({ idx: seq++, text })
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content.startsWith('TOOL_CALL ')) {
      const call = parseAgentLine<{ tool?: string; args?: Record<string, unknown> }>(m.content, 'TOOL_CALL ')
      if (!call?.tool) continue
      // 首个参数作关键参数：read_scene(1234)、insert_cells(count=4) 这类
      // 一眼可辨的签名；无参数则只留工具名。
      let arg = ''
      const entries = Object.entries(call.args ?? {})
      if (entries.length > 0) {
        const [k, v] = entries[0]
        const val = typeof v === 'string' ? v : JSON.stringify(v)
        arg = `${k}=${trunc(String(val ?? ''), 48)}`
      }
      // 结果看紧随的 TOOL_RESULT（约定成对出现）；缺失按未知处理。
      let outcome = '?'
      const next = messages[i + 1]
      if (next?.role === 'user' && next.content.startsWith('TOOL_RESULT ')) {
        const res = parseAgentLine<{ ok?: boolean; error?: string }>(next.content, 'TOOL_RESULT ')
        if (res) outcome = res.ok ? '✓' : `✗ ${trunc(res.error ?? '失败', 40)}`
        i++ // 结果行已消费
      }
      push(arg ? `${call.tool}(${arg}) → ${outcome}` : `${call.tool}() → ${outcome}`)
    } else if (m.role === 'user' && !m.content.startsWith('TOOL_RESULT ') && m.content.trim()) {
      push(`用户: ${trunc(m.content.trim().replace(/\s+/g, ' '), 72)}`)
    } else if (m.role === 'assistant' && m.content.trim()) {
      push(`AI: ${trunc(m.content.trim().replace(/\s+/g, ' '), 56)}`)
    }
  }
  if (lines.length === 0) return ''
  // 超预算从最旧开始丢，保最近的行；省略量如实注明。
  let kept = lines
  let droppedLines = 0
  while (kept.length > 1 && kept.reduce((n, l) => n + l.text.length + 1, 0) > maxChars) {
    kept = kept.slice(1)
    droppedLines++
  }
  const parts = kept.map((l) => `[${l.idx}] ${l.text}`)
  return `${droppedLines > 0 ? `…（更早 ${droppedLines} 行摘要略）\n` : ''}${parts.join('\n')}`
}

/** Agent 会话压缩视图（pi/opencode 式滑动窗口 + 预算感知降级）：基线窗口
 *  40 条（尾保 20）；估算 token 超预算 80% 时按 opencode SHRINK_STEPS 思路
 *  递减保留窗口（尾保 20→14→10→7 ≈ 70/50/35%，尾段 TOOL_RESULT 截断同步
 *  收紧，v7.15 L3），而非直接失败或一刀切硬截断。被丢弃段以结构化摘要
 *  替代占位句（v7.15 A2）。只影响发给模型的视图，不改写原始 convo
 *  （「继续」恢复仍基于全量）——300 轮预算下防上下文爆窗的关键。
 *  预算取 /ai/status 的 context_budget（v7.15 L5；未知回落 96K）。 */
const CONVO_SHRINK_STEPS: readonly number[] = [20, 14, 10, 7]
const TOOL_RESULT_TRUNC_STEPS: readonly number[] = [300, 220, 160, 110]
export function agentConvoView(convo: AIMessage[], budgetTokens = 0): AIMessage[] {
  // v7.14d Token 优化：窗口 60→40（尾保 36→20），尾段 TOOL_RESULT 截短。
  // 27 万 tok 图表任务的主因：大量 read_scene TOOL_RESULT（全画布 XML
  // ~3000 字）× 45 轮反复重发 ≈ 13.5 万 tok 仅历史上下文。
  if (convo.length <= 40) return convo
  const budget = budgetTokens > 0 ? budgetTokens : 96 * 1024
  const build = (keepTail: number, truncLen: number): AIMessage[] => {
    const head = convo.slice(0, 2)
    const tail = convo.slice(-keepTail)
    const droppedMsgs = convo.slice(head.length, convo.length - keepTail)
    const shrink = (m: AIMessage): AIMessage =>
      m.role === 'user' && m.content.startsWith('TOOL_RESULT ') && m.content.length > truncLen
        ? { ...m, content: `${m.content.slice(0, truncLen)}…（已压缩）` }
        : m
    const digest = droppedDigest(droppedMsgs)
    const note: AIMessage = {
      role: 'user',
      content: digest
        ? `（系统注：此前 ${droppedMsgs.length} 条历史已压缩，结构化摘要如下——细节需要时用读工具重取）\n${digest}`
        : `（系统注：此前 ${droppedMsgs.length} 条历史已压缩省略——需要时用读工具重取）`,
    }
    return [...head, note, ...tail.map(shrink)]
  }
  for (let i = 0; i < CONVO_SHRINK_STEPS.length; i++) {
    const view = build(CONVO_SHRINK_STEPS[i], TOOL_RESULT_TRUNC_STEPS[i])
    const chars = view.reduce((n, m) => n + m.content.length, 0)
    if (estTokens(chars) <= budget * 0.8) return view
  }
  return build(CONVO_SHRINK_STEPS[CONVO_SHRINK_STEPS.length - 1], TOOL_RESULT_TRUNC_STEPS[TOOL_RESULT_TRUNC_STEPS.length - 1])
}
