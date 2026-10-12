// ChatHeader：统一 AI 对话头部（阶段一 S1）。
// 从 AIEditChat 提取——包含：标题+会话管理+导入导出+批量+悬浮切换+关闭。
// 所有宿主（assistant/editor/viewer）共用同一布局。
import { Button, Popover, Tooltip } from 'antd'
import { Download, ListChecks, MessagesSquare, PictureInPicture2, Plus, Upload, X } from 'lucide-react'
import { useState } from 'react'
import ConvoPicker from './ConvoPicker'

export interface ChatHeaderProps {
  zh: boolean
  title: string
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
  /** 悬浮/侧栏切换（showFloat=false 时隐藏——Drawer 宿主无悬浮态）。 */
  floatMode: boolean
  onToggleFloat: () => void
  showFloat?: boolean
  onClose: () => void
  /** 额外按钮 slot（宿主特有）。 */
  extraSlot?: React.ReactNode
}

export default function ChatHeader({
  zh, title, sessions, activeSessionId,
  onSwitchSession, onRenameSession, onDeleteSession, onNewSession,
  onExportSessions, onImportSessions,
  batchMode, onToggleBatch,
  floatMode, onToggleFloat, showFloat = true, onClose,
  extraSlot,
}: ChatHeaderProps) {
  const [sessOpen, setSessOpen] = useState(false)
  return (
    <div className="ai-edit-chat-head">
      <span className="ai-edit-chat-title">{title}</span>
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
          <Tooltip title={floatMode ? (zh ? '切换为侧边面板' : 'Side panel') : (zh ? '切换为悬浮窗' : 'Floating window')}>
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
