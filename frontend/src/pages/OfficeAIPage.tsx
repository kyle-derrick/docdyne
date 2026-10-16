// Office AI 插件页（v8 SPA 桥接）：OnlyOffice「DocDyne AI」插件面板的
// 真身——由插件宿主页（public/oo-plugins/docdyne-ai/index.html）以 iframe
// 加载本路由（/office-ai，同源）。与站内编辑页 AI 对话**同一套组件**
// （AIEditChat → AIChatShell）：会话服务端持久化、技能包、谨慎模式对话内
// 确认、智能/对话模式、模型选择、联网/思考/MCP 开关全部复用。
//
// 桥接协议（window.parent ⇄ 本页，同源 postMessage）：
//   本页 → {t:'oa:ready'}
//   父页 → {t:'oa:tools', kind, tools:[{name,destructive}], guide, docs}
//   本页 → {t:'oa:exec', id, tool, args}   （含 __refresh__ 登录态续期）
//   父页 → {t:'oa:result', id, r:{ok,data|error}}
// 工具在 DS 沙箱内执行（父页 runEditorTool 经 Asc.plugin.callCommand）。
import { useEffect, useRef, useState } from 'react'
import { Button, Result } from 'antd'
import AIEditChat from '../components/AIEditChat'
import type { AIApplyKind, AIEditTool } from '../components/AIEditChat'

/** docs 行 → 工具描述（TOOL_DOCS 文本行 `name {args} → desc` 宽松解析）。 */
function parseToolDescs(docs: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of String(docs || '').split('\n')) {
    const m = /^([a-z_][\w]*)\s*(\{[^}]*\})?\s*(?:→|->|—|—|-)\s*(.+)$/.exec(line.trim())
    if (m) out.set(m[1], (m[2] ? m[2] + ' ' : '') + m[3].trim())
  }
  return out
}

const KIND_TO_APPLY: Record<string, AIApplyKind> = {
  word: 'office-word',
  cell: 'office-excel',
  slide: 'office-ppt',
  pdf: 'office-pdf',
}

export default function OfficeAIPage() {
  const [tools, setTools] = useState<AIEditTool[]>([])
  const [extra, setExtra] = useState('')
  const [kind, setKind] = useState('word')
  const [fileInfo, setFileInfo] = useState<{ id: string; name: string } | null>(null)
  // 登录态：未登录时给可操作提示（面板内登录跳转会替换整帧，体验尚可）。
  const [authed, setAuthed] = useState<boolean | null>(null)
  const pendingRef = useRef(new Map<number, (r: { ok: boolean; data?: unknown; error?: string }) => void>())
  const seqRef = useRef(0)

  useEffect(() => {
    // 文件标识：宿主 EditorPage 写入的同源 localStorage。
    try {
      const raw = window.localStorage.getItem('docdyne.ai.editor.file')
      if (raw) {
        const v = JSON.parse(raw) as { id?: string; name?: string }
        if (v.id) setFileInfo({ id: v.id, name: v.name ?? '' })
      }
    } catch { /* ignore */ }
    void import('../api').then(({ getMe }) => {
      getMe().then(() => setAuthed(true)).catch(() => setAuthed(false))
    })

    const onMessage = (e: MessageEvent) => {
      const d = e.data as Record<string, unknown> | null
      if (!d || typeof d !== 'object') return
      if (d.t === 'oa:tools') {
        const k = String(d.kind ?? 'word')
        const descs = parseToolDescs(String(d.docs ?? ''))
        const list = (Array.isArray(d.tools) ? d.tools : []) as Array<{ name: string; destructive?: boolean }>
        setKind(k)
        setTools(list.map((t) => ({
          name: t.name,
          desc: descs.get(t.name) ?? '见系统提示工具清单',
          destructive: t.destructive === true,
          label: (a: Record<string, unknown>) => `${t.name}${Object.keys(a ?? {}).length ? ' ' + JSON.stringify(a).slice(0, 24) : ''}`,
          exec: (a: Record<string, unknown>) => bridgeExec(t.name, a),
        })))
        setExtra([
          'OnlyOffice 宿主约束：',
          '- 你操作的是当前打开的编辑器文档（word=Word / cell=Excel / slide=PPT），不是平台文件系统。',
          '- 坐标与序号全 1 基：excel 单元格 [行,列]（[1,1]=A1）；word 元素序号从 1 起；slide 页码从 1 起。',
          '- 写入内容用编辑器工具直接修改当前文档；list_files/read_file 仅作参考资料检索。',
          String(d.guide ?? ''),
          '',
          '工具清单：',
          String(d.docs ?? ''),
        ].filter(Boolean).join('\n'))
      } else if (d.t === 'oa:result') {
        const id = Number(d.id)
        const resolve = pendingRef.current.get(id)
        if (resolve) {
          pendingRef.current.delete(id)
          resolve((d.r as { ok: boolean; data?: unknown; error?: string }) ?? { ok: false, error: '无返回' })
        }
      }
    }
    window.addEventListener('message', onMessage)
    // 就绪握手（父页即插件宿主；独立打开本页时无父页，工具为空提示）。
    if (window.parent !== window) window.parent.postMessage({ t: 'oa:ready' }, window.location.origin)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /** 经桥执行 DS 沙箱工具（90s 超时兜底；401 时先 __refresh__ 续期重试一次）。 */
  const bridgeExec = (tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    const call = (t: string, a: Record<string, unknown>) => new Promise<{ ok: boolean; data?: unknown; error?: string }>((resolve) => {
      const id = ++seqRef.current
      pendingRef.current.set(id, resolve)
      window.parent.postMessage({ t: 'oa:exec', id, tool: t, args: a }, window.location.origin)
      window.setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          resolve({ ok: false, error: '执行超时（90s）' })
        }
      }, 90000)
    })
    return call(tool, args).then((r) => {
      if (r.ok || tool === '__refresh__') return r
      // 401/登录态过期：续期后重试一次。
      if (typeof r.error === 'string' && /401|unauthorized|登录/i.test(r.error)) {
        return call('__refresh__', {}).then((rr) => (rr.ok ? call(tool, args) : r))
      }
      return r
    })
  }

  if (authed === false) {
    return (
      <Result
        status="403"
        title="需要登录"
        subTitle="在平台登录后此面板即可使用（点下方按钮前往登录，完成后返回）。"
        extra={<Button type="primary" onClick={() => { window.open('/login?returnTo=/office-ai', '_blank') }}>前往登录</Button>}
      />
    )
  }

  if (tools.length === 0) {
    return (
      <div className="office-ai-root">
        <div className="office-ai-empty muted">
          {window.parent !== window
            ? '正在连接编辑器工具…（若长时间无响应，请重新打开本文档）'
            : '本页为 OnlyOffice「DocDyne AI」插件面板：请在文档编辑器侧栏中打开。'}
        </div>
      </div>
    )
  }

  return (
    <div className="office-ai-root">
      <AIEditChat
        open
        onClose={() => { /* 面板开合由 DS 管理 */ }}
        getTarget={() => ({ hasSelection: false, text: '' })}
        fileId={fileInfo?.id ?? 'office-docked'}
        applyKind={KIND_TO_APPLY[kind] ?? 'office-word'}
        agentTools={tools}
        agentSystemExtra={extra}
      />
    </div>
  )
}
