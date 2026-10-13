// ChatInput：统一 AI 对话输入区（阶段一 S3）。
// 从 AIEditChat 提取——工具栏（技能包/引用/开关/模型/发送）+ textarea。
import { Button, Dropdown, Input, Tooltip } from 'antd'
import { Package, Paperclip, ShieldAlert, Upload } from 'lucide-react'
import { CHAT_SEND_ICON, CHAT_STOP_ICON } from './icons'

export interface SkillPackage {
  id: string
  name: string
  description?: string
  system_extra?: string
  tools?: string[]
  kinds?: string[]
}

export interface ChatInputProps {
  zh: boolean
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  busy: boolean
  placeholder: string
  // 技能包
  packages: SkillPackage[]
  pkgId: string
  onPkgChange: (id: string) => void
  applyKind: string
  // 谨慎模式（showCautious=false 时隐藏按钮——仅编辑宿主有意义）
  cautious: boolean
  onCautiousToggle: () => void
  showCautious?: boolean
  // 引用文件（upload=true 为对话上传附件，chip 虚线标记）
  attachedFiles: Array<{ fileId: string; fileName: string; upload?: boolean }>
  onFileDetach: (fileId: string) => void
  // 模型选择
  modelSlot?: React.ReactNode
  // 开关组 slot（联网/思考/MCP 等——由宿主注入）
  togglesSlot?: React.ReactNode
  // 技能按钮 slot
  skillSlot?: React.ReactNode
  // 额外按钮
  extraSlot?: React.ReactNode
}

export default function ChatInput({
  zh, value, onChange, onSend, onStop, busy, placeholder,
  packages, pkgId, onPkgChange, applyKind,
  cautious, onCautiousToggle, showCautious = true,
  attachedFiles, onFileDetach,
  modelSlot, togglesSlot, skillSlot, extraSlot,
}: ChatInputProps) {
  return (
    <div className="chat-input-wrap">
      {attachedFiles.length > 0 && (
        <div className="ai-attach-chips">
          {attachedFiles.map((f) => (
            <span key={f.fileId} className={`ai-attach-chip${f.upload ? ' upload' : ''}`}
              title={f.upload ? '对话附件（不入文件管理，随会话删除）' : f.fileName}>
              {f.upload
                ? <Upload size={10} strokeWidth={2} aria-hidden="true" />
                : <Paperclip size={10} strokeWidth={2} aria-hidden="true" />}
              <span className="ai-attach-chip-name" title={f.fileName}>{f.fileName}</span>
              <button type="button" onClick={() => onFileDetach(f.fileId)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-input-box">
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <div className="chat-tools-bar">
          {skillSlot}
          {packages.length > 0 && (
            <Dropdown
              trigger={['click']} placement="topLeft"
              menu={{
                selectable: true, selectedKeys: [pkgId],
                items: [
                  { key: 'auto', label: zh ? '自动（按文档类型）' : 'Auto (by doc type)' },
                  { key: 'none', label: zh ? '无' : 'None' },
                  { type: 'divider' as const },
                  ...packages
                    .filter((x) => !x.kinds?.length || x.kinds.includes(applyKind))
                    .map((x) => ({ key: x.id, label: x.name })),
                ],
                onClick: ({ key }) => onPkgChange(key === 'none' ? '' : key),
              }}
            >
              <Button size="small" type="text" className={`ai-pkg-btn${pkgId !== '' ? ' pkg-on' : ''}`}
                icon={<Package size={14} strokeWidth={2} />} aria-label="技能包" />
            </Dropdown>
          )}
          {showCautious && (
            <Tooltip title={cautious ? (zh ? '谨慎模式开' : 'Cautious on') : (zh ? '谨慎模式关' : 'Cautious off')}>
              <Button size="small" type="text" className={`ai-attach-btn${cautious ? ' cautious-on' : ''}`}
                icon={<ShieldAlert size={14} strokeWidth={2} />} onClick={onCautiousToggle} aria-pressed={cautious} />
            </Tooltip>
          )}
          {togglesSlot}
          {extraSlot}
          <div className="chat-tools-right">
            {modelSlot}
            <span className="chat-send-btn-wrap">
              {busy ? (
                <button type="button" className="chat-stop-btn" onClick={onStop} aria-label="停止">{CHAT_STOP_ICON}</button>
              ) : (
                <button type="button" className="chat-send-btn" disabled={!value.trim()} onClick={onSend} aria-label="发送">{CHAT_SEND_ICON}</button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
