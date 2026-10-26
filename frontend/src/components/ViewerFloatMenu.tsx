// ViewerFloatMenu —— 查看页/分享页的统一悬浮操作菜单：
// 页面级动作（AI 助理 / 下载等）与查看器组件注册的动作（如 xmind 转 md）
// 合并为一个 FloatingActionBar（单动作直钮、多动作展开菜单；可拖拽/位置
// 记忆）。子组件经 useViewerFloatActions 注册；无 Provider 的场景（查看
// 弹窗/富文本嵌入）hook 静默不注册，子组件回退自渲染。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import FloatingActionBar from './FloatingActionBar'
import type { FloatingAction } from './FloatingActionBar'

interface FloatRegistry {
  register: (key: string, actions: FloatingAction[] | null) => void
}

const ViewerFloatCtx = createContext<FloatRegistry | null>(null)

/** 动作数组等价判定（key/label/danger 全等——防子组件每渲染新数组导致的
 * 注册-重渲染循环；onClick 闭包差异不触发重注册，悬浮菜单点击时取最新
 * 渲染的动作对象，行为正确）。 */
function sameActions(a: FloatingAction[] | null | undefined, b: FloatingAction[] | null): boolean {
  if (a == null && (b == null || b.length === 0)) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].label !== b[i].label || !!a[i].danger !== !!b[i].danger) return false
  }
  return true
}

/** 查看页统一悬浮菜单宿主：baseActions 为页面级动作（顺序在前），子查看
 * 器经 useViewerFloatActions 追加。菜单渲染在 Provider 树末尾。 */
export function ViewerFloatMenuProvider({ children, baseActions }: { children: ReactNode; baseActions: FloatingAction[] }) {
  const [extra, setExtra] = useState<Record<string, FloatingAction[]>>({})
  const register = useCallback((key: string, actions: FloatingAction[] | null) => {
    setExtra((prev) => {
      if (sameActions(prev[key], actions)) return prev
      const next = { ...prev }
      if (actions && actions.length > 0) next[key] = actions
      else delete next[key]
      return next
    })
  }, [])
  const value = useMemo(() => ({ register }), [register])
  const all = useMemo(() => {
    const out = [...baseActions]
    for (const k of Object.keys(extra)) out.push(...extra[k])
    return out
  }, [baseActions, extra])
  return (
    <ViewerFloatCtx.Provider value={value}>
      {children}
      <FloatingActionBar actions={all} />
    </ViewerFloatCtx.Provider>
  )
}

/** 查看器子组件注册悬浮动作：返回是否已注册（true = 宿主渲染菜单，子
 * 组件不再自渲染悬浮钮）。无 Provider 场景返回 false。actions 需以
 * useMemo 稳定（内容变化即重注册，等价判定防循环）。 */
export function useViewerFloatActions(key: string, actions: FloatingAction[] | null): boolean {
  const ctx = useContext(ViewerFloatCtx)
  useEffect(() => {
    if (!ctx) return
    ctx.register(key, actions)
    return () => ctx.register(key, null)
  }, [ctx, key, actions])
  return ctx != null
}
