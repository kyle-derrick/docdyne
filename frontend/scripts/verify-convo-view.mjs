// 分层上下文验证（v7.15 A5）：模拟 100+ 轮 Agent 会话，断言
// agentConvoView 发给模型的视图始终有界且分层（head 任务 + 结构化摘要 +
// 尾窗），原始 convo 不被改写。Node ≥22.18 直接跑（type stripping）：
//   node scripts/verify-convo-view.mjs
import { agentConvoView, calibrateTokRatio, estTokens, suggestTools, droppedDigest } from '../src/ai/convoView.ts'

let failed = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}

/** 合成 N 轮会话：system+任务，之后 TOOL_CALL/TOOL_RESULT 成对（结果有
 *  大有小、有失败），穿插用户意图与 FINAL。 */
function synth(rounds) {
  const convo = [
    { role: 'system', content: '你是编辑 Agent。' },
    { role: 'user', content: '把合同文档里的付款条款改成月结 30 天，并生成一张审批流程图。' },
  ]
  for (let i = 0; i < rounds; i++) {
    if (i % 7 === 3) convo.push({ role: 'user', content: `第 ${i} 轮补充要求：字号统一为小四，标题加粗。` })
    convo.push({ role: 'assistant', content: `TOOL_CALL {"tool":"read_scene","args":{"path":"doc/section-${i}"}}` })
    const big = i % 3 === 0
    const ok = i % 11 !== 5
    convo.push({
      role: 'user',
      content: ok
        ? `TOOL_RESULT {"ok":true,"data":${JSON.stringify({ scene: 'x'.repeat(big ? 2800 : 200), section: i })}}`
        : `TOOL_RESULT {"ok":false,"error":"section-${i} 不存在"}`,
    })
    if (i % 10 === 9) convo.push({ role: 'assistant', content: `FINAL 第 ${i} 轮阶段小结：已处理 ${i + 1} 个小节。` })
  }
  return convo
}

const chars = (ms) => ms.reduce((n, m) => n + m.content.length, 0)

console.log('A5 分层上下文验证（agentConvoView + droppedDigest）')

// 1) ≤40 条直通（不压缩）
{
  const small = synth(15)
  const view = agentConvoView(small)
  assert(view === small, '≤40 条原样直通（同引用，零开销）')
}

// 2) 100+ 轮（约 240 条）：默认 96K 预算下有界 + 摘要替代占位句
{
  const convo = synth(110)
  const before = convo.map((m) => m.content.length).join(',')
  const view = agentConvoView(convo, 96 * 1024)
  assert(view.length <= 2 + 1 + 20, `视图条数有界（实际 ${view.length} ≤ 23）`)
  const note = view[2]
  assert(
    note.role === 'user' && note.content.includes('结构化摘要') && note.content.includes('read_scene(path=doc/section-'),
    '被丢弃段以结构化摘要保留（工具名+关键参数可见）',
  )
  assert(note.content.includes('✗'), '失败轮次在摘要中标记 ✗')
  assert(note.content.includes('用户: '), '用户意图行进入摘要')
  assert(view[0] === convo[0] && view[1] === convo[1], 'head（system+任务）原样保留')
  assert(view[view.length - 1] === convo[convo.length - 1], '最后一条原样保留（尾窗）')
  assert(convo.map((m) => m.content.length).join(',') === before, '原始 convo 未被改写')
}

// 3) 预算感知降级：多档预算下视图 token 都压进 80%；极限小预算兜底有界
{
  for (const budget of [64 * 1024, 24 * 1024, 8 * 1024, 3 * 1024]) {
    const convo = synth(110)
    const view = agentConvoView(convo, budget)
    const used = estTokens(chars(view))
    const bounded = view.length <= 23
    assert(bounded && (used <= budget * 0.8 || view.length <= 2 + 1 + 7), `预算 ${budget >> 10}K：视图 ${view.length} 条 / ~${used} tok 压入或触底兜底`)
  }
}

// 4) 27 万 tok 场景锚点：肥结果（read_scene 全量 XML ×45 轮）不再全量重发
{
  const convo = [
    { role: 'system', content: 's' },
    { role: 'user', content: '任务' },
  ]
  for (let i = 0; i < 45; i++) {
    convo.push({ role: 'assistant', content: `TOOL_CALL {"tool":"read_scene","args":{}}` })
    convo.push({ role: 'user', content: `TOOL_RESULT {"ok":true,"data":{"xml":"${'<mxGraphModel>'.repeat(400)}"}}` })
  }
  const full = estTokens(chars(convo))
  const view = agentConvoView(convo, 96 * 1024)
  const used = estTokens(chars(view))
  assert(used < full * 0.2, `肥结果场景压缩后 ~${used} tok < 全量 ~${full} tok 的 20%`)
}

// 5) 摘要预算封顶：超限丢最旧行并注明
{
  const many = []
  for (let i = 0; i < 300; i++) many.push({ role: 'assistant', content: `TOOL_CALL {"tool":"t${i}","args":{"q":"${'x'.repeat(40)}"}}` })
  const d = droppedDigest(many, 800)
  assert(d.length <= 800 + 200, `摘要长度封顶（实际 ${d.length}）`)
  assert(d.startsWith('…（更早 '), '超限时注明省略行数')
}

// 6) token 校准夹取 + 近名建议
{
  const ratio0 = estTokens(10000)
  calibrateTokRatio(10000, 1000) // 比率 10 → 夹到 8
  calibrateTokRatio(10000, 1000)
  calibrateTokRatio(10000, 1000)
  const r = 10000 / estTokens(10000)
  assert(r <= 8.05, `EMA 校准夹在 [1.5,8]（当前比率 ${r.toFixed(2)}）`)
  const s = suggestTools('read_scence', ['read_scene', 'insert_cells', 'format_element', 'search_shapes'])
  assert(s.includes('read_scene'), `近名建议命中（${s || '空'}）`)
}

if (failed) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
