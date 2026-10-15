// AIChatShell：统一 AI 对话壳组件（S6 组装完成版）。
// 纯渲染层——宿主（AIEditChat/AIAssistant/ViewerAIWidget）管理状态与业务
// 逻辑，Shell 负责统一 UI（头部/消息流/输入区/悬浮窗/批量操作）。
//
// 架构：Shell = ChatHeader + ChatThread + ChatInput + 悬浮窗/侧栏
// 宿主通过 props 注入全部状态与回调，Shell 不持有业务状态。
// v7.6：悬浮窗逻辑（拖动 + 右下角缩放 + 位置尺寸记忆）内聚到 Shell——
// 宿主只需 floatMode 布尔（编辑页侧栏/助手抽屉均支持窗口化）；
// 模式段收敛为 ChatHeader 标题后的单按钮（hover 提示）。
import { Button } from 'antd'
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ChatHeader from './ChatHeader'
import ChatThread from './ChatThread'
import type { ChatMessage } from './ChatThread'
import ChatInput from './ChatInput'
import type { SkillPackage } from './ChatInput'

export type ChatHostType = 'assistant' | 'editor' | 'viewer'
export type ChatMode = 'edit' | 'chat'

/** 悬浮窗位置尺寸持久化 key（三宿主共用）。 */
const FLOAT_POS_KEY = 'docflow.ai.chat.floatpos'
/** 悬浮窗尺寸上下限。 */
const FLOAT_MIN_W = 360
const FLOAT_MIN_H = 360
const FLOAT_MAX_W = 720
const FLOAT_MAX_H = 900

interface FloatRect { x: number; y: number; w: number; h: number }

function loadFloatRect(): FloatRect | null {
  try {
    const raw = window.localStorage.getItem(FLOAT_POS_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<FloatRect>
    const x = Number(v.x), y = Number(v.y), w = Number(v.w), h = Number(v.h)
    if (![x, y, w, h].every(Number.isFinite)) return null
    return { x, y, w, h }
  } catch {
    return null
  }
}

function persistFloatRect(r: FloatRect): void {
  try {
    window.localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(r))
  } catch { /* ignore */ }
}

/** 视口内夹取。 */
function clampRect(r: FloatRect): FloatRect {
  const maxW = Math.min(FLOAT_MAX_W, window.innerWidth - 16)
  const maxH = Math.min(FLOAT_MAX_H, window.innerHeight - 16)
  const w = Math.min(Math.max(r.w, FLOAT_MIN_W), maxW)
  const h = Math.min(Math.max(r.h, FLOAT_MIN_H), maxH)
  return {
    w, h,
    x: Math.min(Math.max(r.x, 8), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(r.y, 8), Math.max(8, window.innerHeight - h - 8)),
  }
}

export interface AIChatShellProps {
  // ---- 必填 ----
  zh: boolean
  hostType: ChatHostType
  title: string
  open: boolean
  onClose: () => void
  // 消息流
  messages: ChatMessage[]
  emptyHint: string
  /** 空态自定义内容（assistant：欢迎语 + 建议卡）。 */
  emptySlot?: ReactNode
  generatingLabel: string
  // 输入
  inputValue: string
  onInputChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  busy: boolean
  inputPlaceholder: string
  // 贴底滚动
  wrapRef: React.Ref<HTMLDivElement>
  onScroll: (e: { target: EventTarget | null }) => void
  // ---- 头部 ----
  sessions: Array<{ id: string; title: string; updatedAt: number }>
  activeSessionId: string
  onSwitchSession: (id: string) => void
  onRenameSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onNewSession: () => void
  onExportSessions: () => void
  onImportSessions: () => void
  // ---- 消息操作 ----
  onCopy: (content: string) => void
  onDeleteExchange: (asstId: number) => void
  onSaveConversation: (ids?: number[]) => void
  onRegenerate: (asstId: number) => void
  onContinue: (asstId: number) => void
  onExecutePlan: (planText: string) => void
  /** 谨慎模式对话内确认回调（v7.7；编辑宿主注入）。 */
  onConfirmTool?: (asstId: number, ok: boolean) => void
  savingFile: boolean
  // ---- 模式（标题后单按钮；showModeSegment=false 隐藏——viewer 无模式概念）----
  mode: ChatMode
  onModeChange: (m: ChatMode) => void
  modeTip: string
  showModeSegment: boolean
  // ---- 悬浮窗 ----
  floatMode: boolean
  onToggleFloat: () => void
  /** false 时隐藏悬浮切换（无悬浮态的宿主）。 */
  showFloat?: boolean
  /** false 时隐藏谨慎模式按钮（仅 editor 宿主有意义）。 */
  showCautious?: boolean
  // ---- 批量 ----
  batchMode: boolean
  onToggleBatch: () => void
  checkedIds: Set<number>
  onToggleChecked: (id: number) => void
  onDeleteChecked: () => void
  // ---- 工具栏 ----
  packages: SkillPackage[]
  pkgId: string
  onPkgChange: (id: string) => void
  applyKind: string
  cautious: boolean
  onCautiousToggle: () => void
  attachedFiles: Array<{ fileId: string; fileName: string }>
  onFileDetach: (fileId: string) => void
  modelSlot?: ReactNode
  togglesSlot?: ReactNode
  effortSlot?: ReactNode
  skillSlot?: ReactNode
  // ---- 宿主特有 slot ----
  extraHeaderSlot?: ReactNode
  /** 头部下方独立工具行（assistant：人设/工作目录/记忆）。 */
  belowHeaderSlot?: ReactNode
  extraToolbarSlot?: ReactNode
  extraAboveInputSlot?: ReactNode
}

export default function AIChatShell(p: AIChatShellProps) {
  // Hooks 必须在早退之前（open 翻转时 hook 数量恒定——助手抽屉随开合切换）。
  // ---- 悬浮窗（v7.6 Shell 内聚：拖动 + 右下角缩放 + 记忆）----
  const [floatRect, setFloatRect] = useState<FloatRect | null>(() => loadFloatRect())
  const panelRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; base: FloatRect } | null>(null)
  /** 头部按下：悬浮态拖动（按钮等交互元素不触发）。 */
  const handleHeadPointerDown = (e: React.PointerEvent) => {
    if (!p.floatMode || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, .ant-segmented, .ant-select, .ant-popover-open, .ai-mode-toggle')) return
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const base = floatRect ?? { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    startWindowDrag(e, 'move', base)
  }
  /** 右下角缩放手柄按下。 */
  const handleResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const base = floatRect ?? { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    startWindowDrag(e, 'resize', base)
  }
  const startWindowDrag = (e: React.PointerEvent, mode: 'move' | 'resize', base: FloatRect) => {
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, base }
    const el = panelRef.current
    if (el) {
      try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.sx
      const dy = ev.clientY - d.sy
      const next = d.mode === 'move'
        ? clampRect({ ...d.base, x: d.base.x + dx, y: d.base.y + dy })
        : clampRect({ ...d.base, w: d.base.w + dx, h: d.base.h + dy })
      setFloatRect(next)
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (d) setFloatRect((cur) => { if (cur) persistFloatRect(cur); return cur })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  if (!p.open) return null
  const panel = (
    <aside
      ref={panelRef}
      className={`ai-edit-chat-panel${p.floatMode ? ' floating' : ''}${p.hostType === 'assistant' && !p.floatMode ? ' in-drawer' : ''}`}
      style={p.floatMode && floatRect
        ? { left: floatRect.x, top: floatRect.y, right: 'auto', bottom: 'auto', width: floatRect.w, height: floatRect.h }
        : undefined}
      aria-label={p.zh ? 'AI 对话' : 'AI chat'}
    >
      <ChatHeader
        zh={p.zh} title={p.title}
        mode={p.showModeSegment ? p.mode : undefined}
        onModeChange={p.showModeSegment ? p.onModeChange : undefined}
        modeTip={p.modeTip}
        sessions={p.sessions} activeSessionId={p.activeSessionId}
        onSwitchSession={p.onSwitchSession} onRenameSession={p.onRenameSession}
        onDeleteSession={p.onDeleteSession} onNewSession={p.onNewSession}
        onExportSessions={p.onExportSessions} onImportSessions={p.onImportSessions}
        batchMode={p.batchMode} onToggleBatch={p.onToggleBatch}
        floatMode={p.floatMode} onToggleFloat={p.onToggleFloat} showFloat={p.showFloat !== false}
        onClose={p.onClose}
        onPointerDown={handleHeadPointerDown}
        extraSlot={p.extraHeaderSlot}
      />
      {p.belowHeaderSlot}
      <ChatThread
        zh={p.zh} messages={p.messages} emptyHint={p.emptyHint} emptySlot={p.emptySlot}
        generatingLabel={p.generatingLabel}
        onCopy={p.onCopy} onDeleteExchange={p.onDeleteExchange}
        onSaveConversation={p.onSaveConversation} onRegenerate={p.onRegenerate}
        onContinue={p.onContinue} onExecutePlan={p.onExecutePlan}
        onConfirmTool={p.onConfirmTool}
        busy={p.busy} batchMode={p.batchMode} savingFile={p.savingFile}
        checkedIds={p.checkedIds} onToggleChecked={p.onToggleChecked}
        wrapRef={p.wrapRef} onScroll={p.onScroll}
      />
      {p.batchMode && p.checkedIds.size > 0 && (
        <div className="ai-batch-bar">
          <span className="muted">{p.zh ? `已选 ${p.checkedIds.size} 项` : `${p.checkedIds.size} selected`}</span>
          <span className="spacer" />
          <Button size="small" disabled={p.savingFile} loading={p.savingFile} onClick={() => p.onSaveConversation(Array.from(p.checkedIds))}>
            {p.zh ? '保存所选到文件' : 'Save selection'}
          </Button>
          <Button size="small" danger onClick={p.onDeleteChecked}>
            {p.zh ? '删除所选' : 'Delete'}
          </Button>
          <Button size="small" type="text" onClick={p.onToggleBatch}>{p.zh ? '退出' : 'Exit'}</Button>
        </div>
      )}
      {p.extraAboveInputSlot}
      <ChatInput
        zh={p.zh} value={p.inputValue} onChange={p.onInputChange}
        onSend={p.onSend} onStop={p.onStop} busy={p.busy} placeholder={p.inputPlaceholder}
        packages={p.packages} pkgId={p.pkgId} onPkgChange={p.onPkgChange} applyKind={p.applyKind}
        cautious={p.cautious} onCautiousToggle={p.onCautiousToggle} showCautious={p.showCautious !== false}
        attachedFiles={p.attachedFiles} onFileDetach={p.onFileDetach}
        modelSlot={p.modelSlot} togglesSlot={p.togglesSlot} effortSlot={p.effortSlot} skillSlot={p.skillSlot}
        extraSlot={p.extraToolbarSlot}
      />
      {/* 悬浮态右下角缩放手柄。 */}
      {p.floatMode && (
        <span className="ai-float-resize" onPointerDown={handleResizePointerDown} role="presentation" />
      )}
    </aside>
  )
  return p.floatMode ? createPortal(panel, document.body) : panel
}

/** 场景能力矩阵。 */
export function hostCapabilities(hostType: ChatHostType) {
  return {
    hasAgentTools: hostType === 'editor',
    hasFloatingMode: true,
    hasCautiousMode: hostType === 'editor',
    hasBatchActions: true,
    hasImportExport: true,
    hasSkillPackages: hostType === 'editor',
    hasFileContext: hostType !== 'assistant',
    hasSummary: hostType === 'viewer',
    hasRAG: hostType === 'assistant',
    hasMemory: hostType === 'assistant',
    hasPersona: hostType === 'assistant',
    hasModeSegment: hostType !== 'viewer',
    hasSessionManagement: hostType !== 'viewer',
  }
}
