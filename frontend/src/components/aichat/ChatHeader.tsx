// ChatHeader：统一 AI 对话头部（阶段一 S1）。
// 从 AIEditChat 提取——包含：标题+模式切换（v7.6 单按钮，hover 提示）+
// 会话管理+导入导出+批量+悬浮切换+关闭。所有宿主（assistant/editor/viewer）
// 共用同一布局。
// v7.6：可修改/仅对话由独立 Segmented 行收敛为标题后的单个切换按钮
// （hover 显示模式说明，省一行）；悬浮窗文案改为「窗口显示/侧边面板显示」。
import { Button, Popover, Tooltip } from 'antd'
import { Download, ListChecks, MessagesSquare, PictureInPicture2, Plus, Upload, X } from 'lucide-react'
import { useState } from 'react'
import ConvoPicker from './ConvoPicker'
import type { ChatMode } from './AIChatShell'

export interface ChatHeaderProps {
  zh: boolean
  title: string
  /** 模式切换（v7.6 单按钮）：mode + 提示文案由宿主注入；未传 = 无模式概念。 */
  mode?: ChatMode
  onModeChange?: (m: ChatMode) => void
  /** 模式说明（hover Tooltip）。 */
  modeTip?: string
  /** 会话列表（空 = 无历史会话功能）。 */
  sessions: Array<{ id: string; title: string; updatedAt: number }>
  activeSessionId: string
  onSwitchSession: (id: string) => void
  onRenameSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onNewSession: () => void
  onExportSessions: () => void
  onImportSessions: () => void
  /** 批量操作。 */
  batchMode: boolean
  onToggleBatch: () => void
  /** 悬浮/侧栏切换（showFloat=false 时隐藏——无悬浮态的宿主）。 */
  floatMode: boolean
  onToggleFloat: () => void
  showFloat?: boolean
  onClose: () => void
  /** 悬浮态拖动把手（AIChatShell 注入；非悬浮态忽略）。 */
  onPointerDown?: (e: React.PointerEvent) => void
  /** 额外按钮 slot（宿主特有）。 */
  extraSlot?: React.ReactNode
}

export default function ChatHeader({
  zh, title,
  mode, onModeChange, modeTip,
  sessions, activeSessionId,
  onSwitchSession, onRenameSession, onDeleteSession, onNewSession,
  onExportSessions, onImportSessions,
  batchMode, onToggleBatch,
  floatMode, onToggleFloat, showFloat = true, onClose,
  onPointerDown,
  extraSlot,
}: ChatHeaderProps) {
  const [sessOpen, setSessOpen] = useState(false)
  return (
    <div className="ai-edit-chat-head" onPointerDown={onPointerDown}>
      <span className="ai-edit-chat-title">{title}</span>
      {/* 模式切换单按钮（v7.6）：点击在 可修改/仅对话 间切换；hover 显示说明。 */}
      {mode && onModeChange && (
        <Tooltip title={modeTip}>
          <button
            type="button"
            className={`ai-mode-toggle${mode === 'edit' ? ' on' : ''}`}
            aria-pressed={mode === 'edit'}
            aria-label={mode === 'edit' ? (zh ? '当前可修改，点击切换为仅对话' : 'Can edit; click for chat only') : (zh ? '当前仅对话，点击切换为可修改' : 'Chat only; click to enable editing')}
            onClick={() => onModeChange(mode === 'edit' ? 'chat' : 'edit')}
          >
            {mode === 'edit' ? (zh ? '可修改' : 'Can edit') : (zh ? '仅对话' : 'Chat only')}
          </button>
        </Tooltip>
      )}
      <span className="ai-edit-chat-head-ops">
        {extraSlot}
        <Popover
          trigger="click" placement="bottomLeft" arrow={false}
          open={sessOpen} onOpenChange={setSessOpen}
          content={
            <ConvoPicker
              items={sessions} activeId={activeSessionId} zh={zh}
              onSwitch={(id) => { setSessOpen(false); onSwitchSession(id) }}
              onRename={onRenameSession} onDelete={onDeleteSession}
              onNew={() => { setSessOpen(false); onNewSession() }}
            />
          }
        >
          <Tooltip title={zh ? '历史会话' : 'Sessions'}>
            <Button size="small" type="text" icon={<MessagesSquare size={13} strokeWidth={2} />}
              disabled={sessions.length === 0} aria-label={zh ? '历史会话' : 'Sessions'} />
          </Tooltip>
        </Popover>
        <Tooltip title={zh ? '新建会话' : 'New session'}>
          <Button size="small" type="text" icon={<Plus size={14} strokeWidth={2} />}
            onClick={onNewSession} aria-label={zh ? '新建会话' : 'New session'} />
        </Tooltip>
        <Tooltip title={zh ? '导出会话（.json）' : 'Export sessions'}>
          <Button size="small" type="text" icon={<Download size={13} strokeWidth={2} />}
            disabled={sessions.length === 0} onClick={onExportSessions} />
        </Tooltip>
        <Tooltip title={zh ? '导入会话备份' : 'Import sessions'}>
          <Button size="small" type="text" icon={<Upload size={13} strokeWidth={2} />}
            onClick={onImportSessions} />
        </Tooltip>
        <Tooltip title={zh ? '批量操作消息' : 'Batch actions'}>
          <Button size="small" type="text" className={batchMode ? 'batch-on' : ''}
            icon={<ListChecks size={13} strokeWidth={2} />}
            onClick={() => onToggleBatch()} aria-pressed={batchMode} />
        </Tooltip>
        {showFloat && (
          <Tooltip title={floatMode ? (zh ? '侧边面板显示' : 'Side panel') : (zh ? '窗口显示' : 'Floating window')}>
            <Button size="small" type="text" icon={<PictureInPicture2 size={13} strokeWidth={2} />}
              onClick={onToggleFloat} aria-pressed={floatMode} />
          </Tooltip>
        )}
        <Button size="small" type="text" icon={<X size={14} strokeWidth={2} />}
          onClick={onClose} aria-label={zh ? '关闭' : 'Close'} />
      </span>
    </div>
  )
}
