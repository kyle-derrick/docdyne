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
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [pos])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !dragging) return
    const x = Math.max(EDGE_MARGIN, Math.min(e.clientX - dragRef.current.dx, window.innerWidth - BTN_SIZE - EDGE_MARGIN))
    const y = Math.max(EDGE_MARGIN, Math.min(e.clientY - dragRef.current.dy, window.innerHeight - BTN_SIZE - EDGE_MARGIN))
    setPos({ x, y })
  }, [dragging])

  const onPointerUp = useCallback(() => {
    if (dragging) {
      dragRef.current = null
      setDragging(false)
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pos)) } catch { /* 忽略 */ }
    }
  }, [dragging, pos])

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
            if (dragging) return // 拖拽结束不触发点击
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
