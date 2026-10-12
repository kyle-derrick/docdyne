// ConvoPicker：AI 会话历史选择器（v7.2 服务端会话的统一浮层内容）。
// 全局助手与编辑页面板共用——同款「新建 + 搜索 + 滚动列表 + 存储说明」
// 结构（.aiax-conv-pop 族样式），杜绝两处样式/交互漂移；重命名弹窗由
// 宿主自行挂载（onRename 回调）。列表为全量本地过滤（scope 上限 300 条
// 元信息约 45KB，无需服务端分页/搜索）。
import { useMemo, useState } from 'react'
import { Input } from 'antd'
import { Conversations } from '@ant-design/x'
import { Plus, Search } from 'lucide-react'

/** 会话条目（元信息即可，正文按需另取）。 */
export interface ConvoPickerItem {
  id: string
  title: string
  updatedAt: number
}

/** 相对时间（与 AIAssistant.aiConvoRelTime 同款文案；组件内聚避免跨文件导出依赖）。 */
function relTime(ts: number, zh: boolean): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return zh ? '刚刚' : 'just now'
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return zh ? `${d} 天前` : `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function ConvoPicker({
  items,
  activeId,
  zh,
  onSwitch,
  onRename,
  onDelete,
  onNew,
}: {
  items: ConvoPickerItem[]
  activeId: string
  zh: boolean
  /** 切换会话（宿主负责关闭浮层）。 */
  onSwitch: (id: string) => void
  /** 请求重命名（宿主打开输入弹窗）。 */
  onRename: (id: string) => void
  /** 删除会话（宿主负责确认）。 */
  onDelete: (id: string) => void
  /** 新建会话（宿主负责关闭浮层）。 */
  onNew: () => void
}) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const filtered = useMemo(
    () => (query ? items.filter((s) => (s.title || '').toLowerCase().includes(query)) : items),
    [items, query],
  )
  return (
    <div className="aiax-conv-pop">
      <button type="button" className="aiax-conv-new" onClick={onNew}>
        <Plus size={13} strokeWidth={2} aria-hidden="true" />
        <span>{zh ? '新会话' : 'New conversation'}</span>
      </button>
      {items.length > 0 && (
        <Input
          allowClear
          size="small"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          prefix={<Search size={12} strokeWidth={2} aria-hidden="true" />}
          placeholder={zh ? '搜索会话标题' : 'Search conversations'}
          className="aiax-conv-search"
          aria-label={zh ? '搜索会话' : 'Search conversations'}
        />
      )}
      {filtered.length === 0 ? (
        <div className="ai-attach-state muted">
          {items.length === 0
            ? (zh ? '暂无历史会话' : 'No conversations yet')
            : (zh ? '没有匹配的会话' : 'No matching conversations')}
        </div>
      ) : (
        <Conversations
          className="aiax-conv-list"
          items={filtered.map((s) => ({
            key: s.id,
            label: (
              <span className="aiax-conv-label" title={s.title}>
                <span className="t">{s.title || (zh ? '未命名会话' : 'Untitled')}</span>
                <span className="time muted">{relTime(s.updatedAt, zh)}</span>
              </span>
            ),
          }))}
          activeKey={activeId || undefined}
          onActiveChange={onSwitch}
          menu={(info) => ({
            items: [
              { key: 'rename', label: zh ? '重命名' : 'Rename' },
              { key: 'delete', label: zh ? '删除' : 'Delete', danger: true },
            ],
            onClick: ({ key: op }) => {
              const id = String(info.key)
              if (op === 'rename') onRename(id)
              else if (op === 'delete') onDelete(id)
            },
          })}
        />
      )}
      <div className="ai-attach-state muted">
        {zh
          ? `共 ${items.length} 个会话 · 保存在服务端（最近 300 个，跨设备同步）`
          : `${items.length} conversations · stored on the server (latest 300, synced across devices)`}
      </div>
    </div>
  )
}
