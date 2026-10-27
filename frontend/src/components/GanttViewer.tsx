// GanttViewer：甘特图只读查看器（dhtmlx-gantt Community，MIT；经 ganttLoader
// 按需加载独立 chunk）。
// - 消费 .ddgantt 文件内容（dhtmlx parse JSON：{data:[任务], links:[依赖]}，
//   任务字段 id/text/start_date/duration|end_date/progress/parent/open/type）；
// - 只读配置：禁编辑/拖拽/连线，保留网格列、缩放、tooltip、进度条与依赖线；
// - 单实例约束：dhtmlx gantt 为模块级单例，同一页面仅挂一个（编辑页/查看
//   弹窗/分享页均单图表场景）；卸载清空避免跨文档残留。
import { useEffect, useRef, useState } from 'react'
import { loadGantt } from './ganttLoader'
import type { GanttStatic } from './ganttLoader'
import { ganttZhCN } from './ganttLocale'

export interface GanttViewerProps {
  /** .ddgantt 文件内容（JSON 文本）。 */
  content: string
  /** 容器高度（默认铺满宿主；分享弹窗等定高场景显式传值）。 */
  height?: number | string
  title?: string
}

/** 应用中文语言与基础配置并初始化（编辑页复用：editable=true 开放编辑）。 */
export function setupGantt(gantt: GanttStatic, editable: boolean): void {
  gantt.i18n.setLocale({ lang: 'cn', ...ganttZhCN } as never)
  gantt.config.date_format = '%Y-%m-%d'
  gantt.config.xml_date = '%Y-%m-%d %H:%i'
  gantt.config.readonly = !editable
  gantt.config.drag_progress = editable
  gantt.config.drag_links = editable
  gantt.config.drag_resize = editable
  gantt.config.drag_move = editable
  gantt.config.details_on_dblclick = editable
  gantt.config.open_tree_initially = true
  gantt.config.fit_tasks = true
  gantt.config.auto_types = true
  gantt.config.show_progress = true
  gantt.config.columns = [
    { name: 'text', label: '任务名称', tree: true, width: '*' },
    { name: 'start_date', label: '开始', align: 'center', width: 90 },
    { name: 'duration', label: '工期', align: 'center', width: 60 },
  ]
}

export default function GanttViewer({ content, height, title }: GanttViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const disposed = { v: true } // 卸载标记（闭包捕获）
    let alive = true
    void loadGantt().then((gantt) => {
      if (!alive) return
      const host = hostRef.current
      if (!host) return
      setupGantt(gantt, false)
      gantt.init(host)
      try {
        gantt.parse(content)
      } catch {
        gantt.clearAll()
      }
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => {
      alive = false
      void loadGantt().then((gantt) => {
        if (!disposed.v) return
        gantt.clearAll()
      }).catch(() => { /* 忽略 */ })
    }
  }, [content])

  if (failed) {
    return <div className="banner error" style={{ margin: 12 }}>甘特图组件加载失败</div>
  }
  return (
    <div
      ref={hostRef}
      className="gantt-viewer-host"
      title={title}
      style={height !== undefined ? { height } : undefined}
    />
  )
}
