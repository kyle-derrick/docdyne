// FloatingActionBar —— 沉浸式查看页的悬浮操作按钮（v1）：
// - 单操作：单个悬浮圆钮（可拖拽，吸附屏幕边缘）
// - 多操作：主钮点击展开扇形/纵向菜单（含图标 + 文字 + tooltip）
// - 空闲半透明、悬停/展开不透明；拖拽后记忆位置（sessionStorage）
// - pointer-events 仅在按钮/菜单上生效，不遮挡内容区交互
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tooltip } from 'antd'
import type { LucideIcon } from 'lucide-react'
import { GripVertical } from 'lucide-react'

export interface FloatingAction {
  key: string
  label: string
  icon: LucideIcon
  onClick: () => void
  danger?: boolean
}

const STORAGE_KEY = 'docdyne.fab.pos'
const EDGE_MARGIN = 16
const BTN_SIZE = 48
// 拖拽/点击判别阈值：按下后位移超过该值（px）视为拖拽，pointerup 后的
// click 被抑制。不能用 dragging state 做守卫——pointerup 的 setState 先于
// click 生效，click 到达时守卫已复位（曾致拖拽转 md 误触发）。
const DRAG_THRESHOLD = 6

/** 从 sessionStorage 恢复位置（或默认右下角）。 */
function loadPos(): { x: number; y: number } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number }
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
    }
  } catch { /* 忽略 */ }
  return { x: window.innerWidth - BTN_SIZE - EDGE_MARGIN, y: window.innerHeight - BTN_SIZE - EDGE_MARGIN - 80 }
}

export default function FloatingActionBar({ actions }: { actions: FloatingAction[] }) {
  const [pos, setPos] = useState(loadPos)
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  // 本次按下的位移是否超过拖拽阈值（click 抑制判据；pointerdown 时复位）。
  const movedRef = useRef(false)
  const downPtRef = useRef<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 窗口 resize 时保持在视口内。
  useEffect(() => {
    const onResize = () => {
      setPos((p) => ({
        x: Math.min(p.x, window.innerWidth - BTN_SIZE - EDGE_MARGIN),
        y: Math.min(p.y, window.innerHeight - BTN_SIZE - EDGE_MARGIN),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // 仅主按钮可发起拖拽（菜单项点击不受影响）。
    if (!(e.target as HTMLElement).closest?.('.fab-btn')) return
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    downPtRef.current = { x: e.clientX, y: e.clientY }
    movedRef.current = false
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [pos])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !dragging) return
    if (downPtRef.current) {
      const ddx = e.clientX - downPtRef.current.x
      const ddy = e.clientY - downPtRef.current.y
      if (ddx * ddx + ddy * ddy > DRAG_THRESHOLD * DRAG_THRESHOLD) movedRef.current = true
    }
    const x = Math.max(EDGE_MARGIN, Math.min(e.clientX - dragRef.current.dx, window.innerWidth - BTN_SIZE - EDGE_MARGIN))
    const y = Math.max(EDGE_MARGIN, Math.min(e.clientY - dragRef.current.dy, window.innerHeight - BTN_SIZE - EDGE_MARGIN))
    setPos({ x, y })
  }, [dragging])

  const onPointerUp = useCallback(() => {
    if (dragging) {
      dragRef.current = null
      downPtRef.current = null
      setDragging(false)
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pos)) } catch { /* 忽略 */ }
      // 拖拽后的 movedRef 不留到下一次交互：macro-task 复位——紧随 pointerup
      // 派发的 click（浏览器在按下/抬起同元素时补发）被抑制，之后的独立
      // 点击正常触发（曾在拖拽后首次真实点击被吞）。
      if (movedRef.current) window.setTimeout(() => { movedRef.current = false }, 0)
    }
  }, [dragging, pos])

  // 拖拽结束后的 click 抑制（消费一次 movedRef；见 DRAG_THRESHOLD 注释）。
  const clickSuppressed = useCallback(() => {
    if (movedRef.current) {
      movedRef.current = false
      return true
    }
    return false
  }, [])

  const single = actions.length === 1 ? actions[0] : null
  const hasMenu = actions.length > 1

  return (
    <div
      ref={rootRef}
      className={`fab-root ${dragging ? 'fab-dragging' : ''} ${expanded ? 'fab-expanded' : ''}`}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* 展开的操作列表（多操作模式） */}
      {hasMenu && expanded && (
        <div className="fab-menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.key}
              className={`fab-menu-item ${a.danger ? 'fab-menu-item-danger' : ''}`}
              onClick={() => { setExpanded(false); a.onClick() }}
              role="menuitem"
            >
              <a.icon size={16} strokeWidth={2} aria-hidden="true" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 主按钮（单操作直接执行；多操作展开菜单） */}
      <Tooltip title={single ? single.label : hasMenu ? (expanded ? '收起' : '操作') : ''} placement="left">
        <button
          className={`fab-btn ${single?.danger ? 'fab-btn-danger' : ''}`}
          onClick={() => {
            if (clickSuppressed()) return // 拖拽结束不触发点击
            if (single) single.onClick()
            else if (hasMenu) setExpanded((v) => !v)
          }}
          aria-label={single?.label ?? '操作菜单'}
          aria-expanded={hasMenu ? expanded : undefined}
        >
          {single ? (
            <single.icon size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <GripVertical size={18} strokeWidth={2} aria-hidden="true" className={`fab-grip ${expanded ? 'fab-grip-active' : ''}`} />
          )}
        </button>
      </Tooltip>
    </div>
  )
}
