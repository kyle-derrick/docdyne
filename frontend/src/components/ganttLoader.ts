// ganttLoader.ts：dhtmlx-gantt 按需加载器（约 1.2MB——静态 import 会把主
// chunk 顶破 PWA workbox 2MiB 预缓存上限，与 excalidraw/mermaid 同策略：
// 动态 import 拆独立 chunk，查看器/编辑页挂载时加载；gantt 为模块级单例，
// 模块缓存天然幂等）。CSS 体量小（~40KB），静态引入主样式。
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css'

export type GanttStatic = typeof import('dhtmlx-gantt')['gantt']

let loader: Promise<GanttStatic> | null = null

/** 加载 dhtmlx-gantt 单例（幂等，多次调用共享同一 Promise）。 */
export function loadGantt(): Promise<GanttStatic> {
  if (!loader) {
    loader = import('dhtmlx-gantt').then((m) => m.gantt)
  }
  return loader
}
