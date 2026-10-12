// AIChatShell：统一 AI 对话壳组件（S6 组装完成版）。
// 纯渲染层——宿主（AIEditChat/AIAssistant/ViewerAIWidget）管理状态与业务
// 逻辑，Shell 负责统一 UI（头部/消息流/输入区/悬浮窗/批量操作）。
//
// 架构：Shell = ChatHeader + ChatThread + ChatInput + 模式段 + 悬浮窗/侧栏
// 宿主通过 props 注入全部状态与回调，Shell 不持有业务状态。
import { Button, Segmented, Tooltip } from 'antd'
import { HelpCircle } from 'lucide-react'
import { useState, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import ChatHeader from './ChatHeader'
import ChatThread from './ChatThread'
import type { ChatMessage } from './ChatThread'
import ChatInput from './ChatInput'
import type { SkillPackage } from './ChatInput'

export type ChatHostType = 'assistant' | 'editor' | 'viewer'
export type ChatMode = 'edit' | 'chat'

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
  wrapRef: Ref<HTMLDivElement>
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
  savingFile: boolean
  // ---- 模式 ----
  mode: ChatMode
  onModeChange: (m: ChatMode) => void
  modeHint: string
  modeTip: string
  showModeSegment: boolean
  // ---- 悬浮窗 ----
  floatMode: boolean
  onToggleFloat: () => void
  /** false 时隐藏悬浮切换（assistant 宿主本身即 Drawer 浮层）。 */
  showFloat?: boolean
  /** false 时隐藏谨慎模式按钮（仅 editor 宿主有意义）。 */
  showCautious?: boolean
  panelRef: Ref<HTMLElement>
  onHeadPointerDown?: (e: React.PointerEvent) => void
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
  skillSlot?: ReactNode
  // ---- 宿主特有 slot ----
  extraHeaderSlot?: ReactNode
  /** 头部下方独立工具行（assistant：人设/工作目录/记忆）。 */
  belowHeaderSlot?: ReactNode
  extraToolbarSlot?: ReactNode
  extraAboveInputSlot?: ReactNode
}

export default function AIChatShell(p: AIChatShellProps) {
  if (!p.open) return null
  const [modeTipOpen, setModeTipOpen] = useState(false)
  const panel = (
    <aside
      ref={p.panelRef}
      className={`ai-edit-chat-panel${p.floatMode ? ' floating' : ''}${p.hostType === 'assistant' ? ' in-drawer' : ''}`}
      aria-label={p.zh ? 'AI 对话' : 'AI chat'}
    >
      <ChatHeader
        zh={p.zh} title={p.title}
        sessions={p.sessions} activeSessionId={p.activeSessionId}
        onSwitchSession={p.onSwitchSession} onRenameSession={p.onRenameSession}
        onDeleteSession={p.onDeleteSession} onNewSession={p.onNewSession}
        onExportSessions={p.onExportSessions} onImportSessions={p.onImportSessions}
        batchMode={p.batchMode} onToggleBatch={p.onToggleBatch}
        floatMode={p.floatMode} onToggleFloat={p.onToggleFloat} showFloat={p.showFloat !== false}
        onClose={p.onClose}
        extraSlot={p.extraHeaderSlot}
      />
      {p.belowHeaderSlot}
      {p.showModeSegment && (
        <div className="ai-edit-chat-mode">
          <Segmented size="small" value={p.mode} onChange={(v) => p.onModeChange(v as ChatMode)}
            options={[
              { label: p.zh ? '可修改' : 'Can edit', value: 'edit' },
              { label: p.zh ? '仅对话' : 'Chat only', value: 'chat' },
            ]}
          />
          <Tooltip title={p.modeTip} open={modeTipOpen} onOpenChange={setModeTipOpen} placement="topRight">
            <span className="ai-edit-chat-mode-hint" role="button" tabIndex={0} aria-label={p.modeHint}>
              <HelpCircle size={14} />
            </span>
          </Tooltip>
        </div>
      )}
      <ChatThread
        zh={p.zh} messages={p.messages} emptyHint={p.emptyHint} emptySlot={p.emptySlot}
        generatingLabel={p.generatingLabel}
        onCopy={p.onCopy} onDeleteExchange={p.onDeleteExchange}
        onSaveConversation={p.onSaveConversation} onRegenerate={p.onRegenerate}
        onContinue={p.onContinue} onExecutePlan={p.onExecutePlan}
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
        modelSlot={p.modelSlot} togglesSlot={p.togglesSlot} skillSlot={p.skillSlot}
        extraSlot={p.extraToolbarSlot}
      />
    </aside>
  )
  return p.floatMode ? createPortal(panel, document.body) : panel
}

/** 场景能力矩阵。 */
export function hostCapabilities(hostType: ChatHostType) {
  return {
    hasAgentTools: hostType === 'editor',
    hasFloatingMode: hostType !== 'viewer',
    hasCautiousMode: hostType === 'editor',
    hasBatchActions: true,
    hasImportExport: true,
    hasSkillPackages: hostType === 'editor',
    hasFileContext: hostType !== 'assistant',
    hasSummary: hostType === 'viewer',
    hasRAG: hostType === 'assistant',
    hasMemory: hostType === 'assistant',
    hasPersona: hostType === 'assistant',
    hasModeSegment: hostType === 'editor',
    hasSessionManagement: hostType !== 'viewer',
  }
}
