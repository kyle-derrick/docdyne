// GanttPage：甘特图编辑页（/gantt/:fileId；dhtmlx-gantt Community，MIT）。
// - .ddgantt = dhtmlx parse JSON（{data:[任务], links:[依赖]}），保存经
//   uploadFileVersion 覆盖为新版本（版本链/历史回退与其他编辑器一致）；
// - mode=view 只读（查看弹窗/分享页复用 GanttViewer 组件，本页为独立页
//   形态）；未保存拦截误关（beforeunload）；
// - AI 深度集成（AIEditChat，applyKind=gantt-json）：agentTools 任务级
//   工具循环（read_plan/add_task/update_task/delete_task/add_link/
//   delete_link/set_plan），AI 按自然语言生成完整计划或增删改任务与依赖，
//   改动即时上图并标记未保存；单轮整体生成通道保留（```gantt-json 围栏
//   → set_plan 应用）。
// - 导出 CSV（本地生成，不经 dhtmlx 云端导出服务——自托管无外联）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, Segmented } from 'antd'
import { History as HistoryIcon, ImageDown, Printer } from 'lucide-react'
import { toPng } from 'html-to-image'
import {
  FileWithVersion,
  fetchFileText,
  getFileMeta,
  uploadFileVersion,
} from '../api'
import VersionHistoryModal from '../components/VersionHistoryModal'
import AIEditChat, { AIEditChatButton, GANTT_JSON_GUIDE } from '../components/AIEditChat'
import type { AIEditTool, AIQuickCommand } from '../components/AIEditChat'
import { setupGantt } from '../components/GanttViewer'
import { loadGantt } from '../components/ganttLoader'
import type { GanttStatic } from '../components/ganttLoader'
import { EditorLoadErrorBoundary } from '../components/EditorLoadError'
import { useAIEnabled } from '../aiFeature'
import { useLocale } from '../i18n'
import { useColorMode } from '../theme'
import { closeEditorWithFallback, safeReturnTo } from '../editorNavigation'

export default function GanttPage({ mode: routeMode, fileId: routeFileId }: { mode?: 'edit' | 'view'; fileId?: string }) {
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const aiOn = useAIEnabled()
  const dark = useColorMode() === 'dark'

  const fileId = routeFileId ?? params.fileId ?? ''
  const viewMode = routeMode === 'view' || searchParams.get('mode') === 'view'

  const hostRef = useRef<HTMLDivElement | null>(null)
  const ganttRef = useRef<GanttStatic | null>(null)
  const dirtyRef = useRef(false)
  const closingRef = useRef(false)
  const [file, setFile] = useState<FileWithVersion | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [verHistOpen, setVerHistOpen] = useState(false)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [zoomLevel, setZoomLevel] = useState<'day' | 'week' | 'month' | 'quarter' | 'year'>('month')
  const [aiQuick, setAiQuick] = useState<AIQuickCommand | null>(null)

  const markDirty = useCallback(() => {
    dirtyRef.current = true
  }, [])

  /** 当前计划序列化（{data, links}；serialize 输出即可回 parse 的格式）。 */
  const currentJSON = useCallback(() => {
    const g = ganttRef.current
    return g ? JSON.stringify(g.serialize(), null, 2) : '{"data":[],"links":[]}'
  }, [])

  // ---- 初始化与加载 ----
  useEffect(() => {
    let alive = true
    void loadGantt().then((g) => {
      if (!alive) return
      const host = hostRef.current
      if (!host) return
      ganttRef.current = g
      setupGantt(g, !viewMode)
      // 时间轴缩放（ext.zoom，Community 内置）：日/周/月/季/年 五档。
      g.attachEvent('onGanttReady', () => {
        try {
          const zoom = g.ext.zoom as unknown as { init: (cfg: unknown) => void; setCurrent: (v: string) => void } | undefined
          zoom?.init(ganttZoomLevels(g))
          zoom?.setCurrent(zoomLevel)
        } catch { /* 旧版无 ext.zoom 时静默跳过（默认档位仍可用） */ }
      })
      g.init(host)
      if (!viewMode) {
        const onAnyChange = () => markDirty()
        g.attachEvent('onAfterTaskUpdate', onAnyChange)
        g.attachEvent('onAfterTaskAdd', onAnyChange)
        g.attachEvent('onAfterTaskDelete', onAnyChange)
        g.attachEvent('onAfterLinkUpdate', onAnyChange)
        g.attachEvent('onAfterLinkAdd', onAnyChange)
        g.attachEvent('onAfterLinkDelete', onAnyChange)
      }
      setError('')
      if (!fileId) return
      void Promise.all([getFileMeta(fileId).catch(() => null), fetchFileText(fileId).catch(() => null)])
        .then(([meta, text]) => {
          if (!alive) return
          if (meta) setFile(meta)
          if (text) {
            try {
              g.parse(text)
            } catch {
              g.clearAll()
            }
          }
          dirtyRef.current = false
        })
        .catch(() => {
          if (alive) setError(zh ? '甘特图加载失败' : 'Failed to load gantt')
        })
    }).catch(() => {
      if (alive) setError(zh ? '甘特图组件加载失败' : 'Failed to load gantt component')
    })
    return () => {
      alive = false
      const g = ganttRef.current
      if (g) {
        g.clearAll()
        g.detachAllEvents()
      }
      ganttRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, viewMode, reloadKey])

  // ---- 保存（uploadFileVersion 覆盖为新版本） ----
  const save = async (thenBack: boolean) => {
    if (saving || !fileId) return
    setSaving(true)
    try {
      const blob = new File([currentJSON()], file?.name ?? 'plan.ddgantt', { type: 'application/json' })
      await uploadFileVersion(blob, fileId, () => {})
      dirtyRef.current = false
      const meta = await getFileMeta(fileId).catch(() => null)
      if (meta) setFile(meta)
      if (thenBack) {
        closingRef.current = true
        const returnTo = safeReturnTo(searchParams.get('returnTo'))
        closeEditorWithFallback(navigate, returnTo)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? '保存失败' : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const exitWithConfirm = () => {
    if (dirtyRef.current && !window.confirm(zh ? '有未保存的修改，确定离开？' : 'Leave with unsaved changes?')) return
    closingRef.current = true
    const returnTo = safeReturnTo(searchParams.get('returnTo'))
    closeEditorWithFallback(navigate, returnTo)
  }

  // 未保存兜底提示。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || closingRef.current || viewMode) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [viewMode])

  // ---- 导出 CSV（本地生成） ----
  const exportCSV = () => {
    const g = ganttRef.current
    if (!g) return
    const ser = g.serialize()
    const esc = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = [['任务', '开始', '工期(天)', '进度', '父任务'].join(',')]
    const byId = new Map(ser.data.map((t: { id: string | number; text?: string }) => [String(t.id), String(t.text ?? '')]))
    for (const t of ser.data as Array<{ text?: string; start_date?: string; duration?: number; progress?: number; parent?: string | number }>) {
      rows.push([esc(t.text), esc((t.start_date ?? '').slice(0, 10)), t.duration ?? '', t.progress ? `${Math.round(t.progress * 100)}%` : '', esc(t.parent ? byId.get(String(t.parent)) ?? '' : '')].join(','))
    }
    const blob = new File(['﻿' + rows.join('\n')], (file?.name ?? 'plan').replace(/\.ddgantt$/i, '') + '.csv', { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // ---- 导出 PNG / PDF（纯浏览器本地：html-to-image 渲染 DOM → dataURL；
  //      PDF 经打印窗口由浏览器「另存为 PDF」，不经 dhtmlx 云端导出服务） ----
  const exportImage = async (kind: 'png' | 'pdf') => {
    const g = ganttRef.current
    const host = hostRef.current?.querySelector('.gantt_container') as HTMLElement | null
    if (!g || !host) return
    const save = (file: string, href: string) => {
      const a = document.createElement('a')
      a.href = href
      a.download = file
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    const base = (file?.name ?? 'plan').replace(/\.ddgantt$/i, '')
    try {
      // 只读态导出当前视图：临时切换只读避免拖拽句柄入画。
      const wasReadonly = g.config.readonly
      g.config.readonly = true
      g.render()
      const dataUrl = await toPng(host, { backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff', pixelRatio: 2 })
      g.config.readonly = wasReadonly
      g.render()
      if (kind === 'png') {
        save(`${base}.png`, dataUrl)
        return
      }
      const w = window.open('', '_blank', 'noopener')
      if (!w) return
      w.document.write(`<html><head><title>${base}</title><style>@page{size:landscape;margin:8mm}body{margin:0}img{width:100%}</style></head><body><img src="${dataUrl}" onload="window.print()"></body></html>`)
      w.document.close()
    } catch {
      setError(zh ? '导出失败' : 'Export failed')
    }
  }

  // ---- AI 工具循环（任务级操作，经 gantt 单例即时上图） ----
  const aiAgentTools: AIEditTool[] = useMemo(() => [
    {
      name: 'read_plan',
      desc: '读取当前甘特图全部任务与依赖（id/text/start_date/duration/progress/parent/type + links）。修改前必须先读取。',
      label: () => '读取当前计划',
      exec: async () => ({ ok: true, data: JSON.parse(currentJSON()) }),
    },
    {
      name: 'add_task',
      desc: '添加任务。参数: {text, start_date:"YYYY-MM-DD", duration:天数, parent?:任务id, progress?:0..1, type?:"task"|"project"|"milestone"(里程碑 duration 固定 0)}。',
      label: (a) => `添加任务 ${a.text ?? ''}`,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        if (!a.text) return { ok: false, error: 'text 必填' }
        const t: Record<string, unknown> = { text: String(a.text), start_date: String(a.start_date ?? new Date().toISOString().slice(0, 10)), duration: Number(a.duration ?? 1) }
        if (a.parent !== undefined) t.parent = a.parent
        if (a.progress !== undefined) t.progress = Number(a.progress)
        if (a.type === 'milestone') { t.type = 'milestone'; t.duration = 0 }
        const id = g.addTask(t as never, a.parent !== undefined ? String(a.parent) : 0)
        markDirty()
        return { ok: true, data: { id } }
      },
    },
    {
      name: 'update_task',
      desc: '更新任务字段。参数: {id 必填, text?, start_date?, duration?, progress?, type?}。只传要改的字段。',
      label: (a) => `更新任务 ${a.id}`,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        if (a.id === undefined || !g.isTaskExists(String(a.id))) return { ok: false, error: `任务 ${a.id} 不存在` }
        const cur = g.getTask(String(a.id)) as unknown as Record<string, unknown>
        const patch = { ...cur }
        for (const k of ['text', 'start_date', 'duration', 'progress', 'type'] as const) {
          if (a[k] !== undefined) (patch as Record<string, unknown>)[k] = a[k]
        }
        if (a.type === 'milestone') patch.duration = 0
        g.updateTask(String(a.id), patch as never)
        markDirty()
        return { ok: true, data: { id: a.id } }
      },
    },
    {
      name: 'delete_task',
      desc: '删除任务（连带其子任务与关联依赖）。参数: {id}。破坏性操作。',
      label: (a) => `删除任务 ${a.id}`,
      destructive: true,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        if (a.id === undefined || !g.isTaskExists(String(a.id))) return { ok: false, error: `任务 ${a.id} 不存在` }
        g.deleteTask(String(a.id))
        markDirty()
        return { ok: true, data: { id: a.id } }
      },
    },
    {
      name: 'add_link',
      desc: '添加依赖。参数: {source:任务id, target:任务id, type:"0"=FS(完成→开始)|"1"=SS|"2"=FF|"3"=SF}。默认 "0"。',
      label: (a) => `添加依赖 ${a.source}→${a.target}`,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        if (a.source === undefined || a.target === undefined) return { ok: false, error: 'source/target 必填' }
        const id = g.addLink({ source: String(a.source), target: String(a.target), type: String(a.type ?? '0') } as never)
        markDirty()
        return { ok: true, data: { id } }
      },
    },
    {
      name: 'delete_link',
      desc: '删除依赖。参数: {id:依赖id}（read_plan 的 links 数组取）。破坏性操作。',
      label: (a) => `删除依赖 ${a.id}`,
      destructive: true,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        if (a.id === undefined) return { ok: false, error: 'id 必填' }
        g.deleteLink(String(a.id))
        markDirty()
        return { ok: true, data: { id: a.id } }
      },
    },
    {
      name: 'set_plan',
      desc: '整体替换计划（AI 生成完整计划时用）。参数: {data:[任务数组], links?:[依赖数组]}（dhtmlx 格式，见 get_reference）。破坏性操作。',
      label: () => '整体替换计划',
      destructive: true,
      exec: async (a) => {
        const g = ganttRef.current
        if (!g) return { ok: false, error: '甘特图尚未初始化' }
        const d = a.data
        if (!Array.isArray(d) || d.length === 0) return { ok: false, error: 'data 须为非空任务数组' }
        g.clearAll()
        g.parse({ data: d, links: Array.isArray(a.links) ? a.links : [] })
        markDirty()
        return { ok: true, data: { tasks: d.length } }
      },
    },
    {
      name: 'get_reference',
      desc: '读取 .ddgantt JSON 格式规范与字段约定（首次生成/整体替换前必读）。',
      label: () => '读取格式规范',
      exec: async () => ({ ok: true, data: { guide: GANTT_JSON_GUIDE } }),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const openAiChatWith = (cmd: AIQuickCommand) => {
    setAiChatOpen(true)
    setAiQuick(cmd)
  }

  const versionNo = file?.current_version?.version

  return (
    <div className={`editor-page gantt-editor-page${viewMode ? ' viewer-only' : ''}${dark ? ' gantt-dark' : ''}`}>
      {!viewMode && <div className="editor-head">
        <Button type="text" size="small" onClick={exitWithConfirm}>{zh ? '返回' : 'Back'}</Button>
        <h2 className="editor-title">{file?.name ?? (zh ? '加载中…' : 'Loading…')}</h2>
        {versionNo !== undefined && <span className="badge current">{zh ? `当前版本 v${versionNo}` : `v${versionNo}`}</span>}
        {saving && <span className="badge uploading">{zh ? '保存中…' : 'Saving…'}</span>}
        <span className="editor-head-actions">
          <Button size="small" icon={<HistoryIcon size={14} strokeWidth={2} aria-hidden="true" />} disabled={!file}
            onClick={() => setVerHistOpen(true)}>{zh ? '历史版本' : 'History'}</Button>
          <Segmented
            size="small"
            value={zoomLevel}
            onChange={(v) => {
              const next = v as typeof zoomLevel
              setZoomLevel(next)
              const g = ganttRef.current
              try {
                ;(g?.ext.zoom as unknown as { setCurrent: (x: string) => void } | undefined)?.setCurrent(next)
              } catch { /* 无 ext.zoom 时忽略 */ }
            }}
            options={[
              { value: 'day', label: zh ? '日' : 'D' },
              { value: 'week', label: zh ? '周' : 'W' },
              { value: 'month', label: zh ? '月' : 'M' },
              { value: 'quarter', label: zh ? '季' : 'Q' },
              { value: 'year', label: zh ? '年' : 'Y' },
            ]}
          />
          <Button size="small" disabled={!file} onClick={exportCSV}>{zh ? '导出 CSV' : 'Export CSV'}</Button>
          <Button size="small" icon={<ImageDown size={14} strokeWidth={2} aria-hidden="true" />} disabled={!file} onClick={() => void exportImage('png')}>PNG</Button>
          <Button size="small" icon={<Printer size={14} strokeWidth={2} aria-hidden="true" />} disabled={!file} onClick={() => void exportImage('pdf')}>PDF</Button>
          {aiOn && (
            <AIEditChatButton open={aiChatOpen} onToggle={() => setAiChatOpen((v) => !v)} onQuick={openAiChatWith} kind="gantt-json" disabled={saving || !file} />
          )}
          <Button size="small" disabled={saving || !file} loading={saving} onClick={() => void save(false)}>
            {zh ? '保存' : 'Save'}
          </Button>
          <Button type="primary" size="small" disabled={saving || !file} onClick={() => void save(true)}>
            {zh ? '保存并退出' : 'Save & back'}
          </Button>
        </span>
      </div>}
      {error && <div className="banner error">{error}</div>}
      <div className="gantt-editor-body">
        <EditorLoadErrorBoundary
          renderError={() => (
            <div className="banner error" style={{ margin: 12 }}>
              {zh ? '甘特图组件加载失败，请刷新重试' : 'Gantt component failed to load; refresh to retry.'}
            </div>
          )}
        >
          <div ref={hostRef} className="gantt-editor-host" />
        </EditorLoadErrorBoundary>
      </div>
      {aiOn && !viewMode && (
        <AIEditChat
          open={aiChatOpen}
          onClose={() => setAiChatOpen(false)}
          getTarget={() => ({ text: currentJSON(), hasSelection: false })}
          fileId={fileId}
          quickCommand={aiQuick}
          onQuickConsumed={() => setAiQuick(null)}
          applyKind="gantt-json"
          agentTools={aiAgentTools}
          agentSystemExtra={[
            '甘特图宿主约束：',
            '- 从零生成/重排整份计划：先 get_reference 读格式规范，再一次 set_plan 传入完整 {data, links}（日期用 YYYY-MM-DD，工期 duration 天数；里程碑 type:"milestone" 且 duration:0）。',
            '- 增删改任务/依赖：先 read_plan 拿 id，再 add_task/update_task/delete_task/add_link/delete_link 局部修改——不要整体重画（会丢用户手工调整）。',
            '- 任务分组：父任务 type:"project"，子任务带 parent:<父id>；open:true 默认展开。',
            '- 依赖类型：FS="0"（默认，前置完成→后继开始）/SS="1"/FF="2"/SF="3"。',
            '- 日期排布：按业务合理排期（工作日即可，无需跳过周末）；工期含首尾两天。',
            '- 【自检循环】每批改动后 read_plan 验证：无悬空 parent/链接、里程碑 duration=0、日期区间自洽；发现问题先修复再继续，全部通过才 FINAL 总结。',
          ].join('\n')}
        />
      )}
      {verHistOpen && file && (
        <VersionHistoryModal
          file={file}
          onClose={() => setVerHistOpen(false)}
          onChanged={() => { dirtyRef.current = false; setReloadKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}


/** 时间轴缩放档位（gantt.ext.zoom；Community 内置）：日/周/月/季/年。 */
function ganttZoomLevels(g: GanttStatic) {
  const dts = (fmt: string) => g.date.date_to_str(fmt)
  return {
    levels: [
      { name: 'day', scale_height: 30, min_column_width: 55, scales: [{ unit: 'day', step: 1, format: dts('%m月%d日') }] },
      { name: 'week', scale_height: 30, min_column_width: 70, scales: [{ unit: 'week', step: 1, format: (d: Date) => `${d.getFullYear()}年 第${g.date.date_to_str('%W')(d)}周` }, { unit: 'day', step: 1, format: dts('%D') }] },
      { name: 'month', scale_height: 30, min_column_width: 45, scales: [{ unit: 'month', step: 1, format: dts('%Y年%m月') }, { unit: 'day', step: 1, format: dts('%d') }] },
      { name: 'quarter', scale_height: 30, min_column_width: 80, scales: [{ unit: 'month', step: 3, format: (d: Date) => `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}` }, { unit: 'month', step: 1, format: dts('%m月') }] },
      { name: 'year', scale_height: 30, min_column_width: 55, scales: [{ unit: 'year', step: 1, format: dts('%Y年') }, { unit: 'month', step: 1, format: dts('%m月') }] },
    ],
  }
}
