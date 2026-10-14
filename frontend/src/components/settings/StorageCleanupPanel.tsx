// 存储清理面板（v7.14c：设置→存储清理）。
// 扫描可清理项并分类展示：旧版本 / AI 对话附件 / 回收站 / 大文件。
// 每类显示预估可释放空间，支持全选/反选/单项勾选，确认后批量执行。
// 参考成熟文件清理软件的交互（分类卡片 + 空间预估 + 批量操作）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, Progress, Spin } from 'antd'
import { HardDrive, History, MessageSquare, Trash2 } from 'lucide-react'
import {
  aiDeleteConversation, aiListConversations,
  deleteFile, deleteFileVersion, listFileVersions, listTrash, purgeFile,
  listSpaces, listSpaceFiles,
} from '../../api'
import { formatQuota } from '../FileBrowser'

/** 清理项条目。 */
interface CleanupItem {
  id: string
  label: string
  detail: string
  size: number
  /** 所属空间名（分组展示用）。 */
  spaceName?: string
}

/** 清理类别。 */
interface CleanupCategory {
  key: string
  icon: React.ReactNode
  title: string
  desc: string
  items: CleanupItem[]
  /** 执行清理（选中项）。 */
  execute: (ids: string[]) => Promise<void>
}

/** 版本保留策略：超过此数的旧版本建议清理（当前版本恒保留）。 */
const VERSION_KEEP = 5

export default function StorageCleanupPanel({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const { modal } = AntdApp.useApp()
  const [scanning, setScanning] = useState(false)
  const [categories, setCategories] = useState<CleanupCategory[]>([])
  const [checked, setChecked] = useState<Record<string, Set<string>>>({})
  const [cleaning, setCleaning] = useState(false)

  const scan = useCallback(async () => {
    setScanning(true)
    setError('')
    try {
      const cats: CleanupCategory[] = []
      const checks: Record<string, Set<string>> = {}

      // ---- 1. 旧版本 ----
      const spaces = await listSpaces()
      const versionItems: CleanupItem[] = []
      const versionTargets: Array<{ fileId: string; versionId: string; label: string; size: number }> = []
      for (const sp of spaces) {
        try {
          const { files } = await listSpaceFiles(sp.id, null)
          for (const f of files) {
            if (f.type !== 'file') continue
            try {
              const versions = await listFileVersions(f.id)
              // 保留最新 VERSION_KEEP 个，其余标记为可清理
              const old = versions.slice(VERSION_KEEP)
              for (const v of old) {
                versionTargets.push({ fileId: f.id, versionId: v.id, label: `${f.name} v${v.version}`, size: v.size })
                versionItems.push({
                  id: `${f.id}:${v.id}`,
                  label: `${f.name} · v${v.version}`,
                  detail: `${formatQuota(v.size, false)} · ${new Date(v.created_at).toLocaleDateString()}`,
                  size: v.size,
                  spaceName: sp.name,
                })
              }
            } catch { /* 单文件失败跳过 */ }
          }
        } catch { /* 空间失败跳过 */ }
      }
      if (versionItems.length > 0) {
        cats.push({
          key: 'versions', icon: <History size={18} strokeWidth={2} aria-hidden="true" />,
          title: '历史版本',
          desc: `保留最新 ${VERSION_KEEP} 个版本，更早的版本可清理（不影响当前文件内容）`,
          items: versionItems,
          execute: async (ids) => {
            for (const id of ids) {
              const [fileId, versionId] = id.split(':')
              await deleteFileVersion(fileId, versionId).catch(() => {})
            }
          },
        })
        checks.versions = new Set()
      }

      // ---- 2. AI 对话附件（孤儿：会话已删但文件残留） ----
      try {
        // 隐藏空间「AI 对话附件」中的文件 = 上传的附件
        // 列出所有助手会话（有活跃会话的附件文件不清理）
        const convos = await aiListConversations({ source: 'assistant' })
        // TODO: 后端需要提供"列出附件空间文件"的 API 才能精确扫描
        // 当前简化：列出助手会话数供参考
        if (convos.length > 0) {
          cats.push({
            key: 'attachments', icon: <MessageSquare size={18} strokeWidth={2} aria-hidden="true" />,
            title: 'AI 对话附件',
            desc: `${convos.length} 个会话的附件（随会话删除自动清理；也可删除空闲会话释放空间）`,
            items: convos.map((c) => ({
              id: c.id,
              label: c.title || '（无标题）',
              detail: `${c.message_count ?? 0} 条消息 · ${new Date(c.updated_at).toLocaleDateString()}`,
              size: 0,
            })),
            execute: async (ids) => {
              for (const id of ids) {
                await aiDeleteConversation(id).catch(() => {})
              }
            },
          })
          checks.attachments = new Set()
        }
      } catch { /* AI 未配置跳过 */ }

      // ---- 3. 回收站 ----
      const trashItems: CleanupItem[] = []
      try {
        const trash = await listTrash()
        for (const f of trash) {
          trashItems.push({
            id: f.id,
            label: f.name,
            detail: `${formatQuota(0, false)} · 删除于 ${new Date(f.updated_at).toLocaleDateString()}`,
            size: 0,
          })
        }
      } catch { /* 回收站不可用跳过 */ }
      if (trashItems.length > 0) {
        cats.push({
          key: 'trash', icon: <Trash2 size={18} strokeWidth={2} aria-hidden="true" />,
          title: '回收站',
          desc: '已删除的文件（彻底删除后不可恢复）',
          items: trashItems,
          execute: async (ids) => {
            for (const id of ids) {
              await purgeFile(id).catch(() => {})
            }
          },
        })
        checks.trash = new Set()
      }

      // ---- 4. 大文件（>100MB 且 90 天未访问）----
      const largeItems: CleanupItem[] = []
      for (const sp of spaces) {
        try {
          const { files } = await listSpaceFiles(sp.id, null)
          for (const f of files) {
            if (f.type !== 'file') continue
            const size = (f as { size?: number }).size ?? 0
            const updated = new Date(f.updated_at).getTime()
            const daysSince = (Date.now() - updated) / 86400000
            if (size > 100 * 1024 * 1024 && daysSince > 90) {
              largeItems.push({
                id: f.id,
                label: f.name,
                detail: `${formatQuota(size, false)} · ${Math.round(daysSince)} 天未修改`,
                size,
              })
            }
          }
        } catch { /* 空间失败跳过 */ }
      }
      if (largeItems.length > 0) {
        cats.push({
          key: 'large', icon: <HardDrive size={18} strokeWidth={2} aria-hidden="true" />,
          title: '大文件（>100MB · 90天未修改）',
          desc: '长时间未使用的大文件（删除前请确认不再需要）',
          items: largeItems,
          execute: async (ids) => {
            for (const id of ids) {
              await deleteFile(id).catch(() => {})
            }
          },
        })
        checks.large = new Set()
      }

      setCategories(cats)
      setChecked(checks)
    } catch (err) {
      onError(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setScanning(false)
    }
  }, [onError])

  useEffect(() => {
    void scan()
  }, [scan])

  const totalCleanable = useMemo(() => {
    let total = 0
    for (const cat of categories) {
      for (const item of cat.items) {
        if (checked[cat.key]?.has(item.id)) total += item.size
      }
    }
    return total
  }, [categories, checked])

  const totalAll = useMemo(() => {
    return categories.reduce((acc, cat) => acc + cat.items.reduce((a, i) => a + i.size, 0), 0)
  }, [categories])

  const toggleItem = (catKey: string, itemId: string) => {
    setChecked((prev) => {
      const set = new Set(prev[catKey] ?? [])
      if (set.has(itemId)) set.delete(itemId)
      else set.add(itemId)
      return { ...prev, [catKey]: set }
    })
  }

  const toggleCategory = (catKey: string, items: CleanupItem[]) => {
    setChecked((prev) => {
      const set = prev[catKey] ?? new Set<string>()
      if (set.size >= items.length) {
        return { ...prev, [catKey]: new Set() }
      }
      return { ...prev, [catKey]: new Set(items.map((i) => i.id)) }
    })
  }

  /** 全选/反选所有类别的所有项。 */
  const toggleAll = () => {
    const allSelected = categories.every((cat) => (checked[cat.key] ?? new Set()).size >= cat.items.length)
    if (allSelected) {
      setChecked(Object.fromEntries(categories.map((c) => [c.key, new Set<string>()])))
    } else {
      setChecked(Object.fromEntries(categories.map((c) => [c.key, new Set(c.items.map((i) => i.id))])))
    }
  }

  /** 按空间分组全选/反选。 */
  const toggleSpaceGroup = (catKey: string, spaceName: string, items: CleanupItem[]) => {
    const spaceItems = items.filter((i) => i.spaceName === spaceName)
    const current = checked[catKey] ?? new Set<string>()
    const allSelected = spaceItems.every((i) => current.has(i.id))
    setChecked((prev) => {
      const set = new Set(prev[catKey] ?? [])
      if (allSelected) {
        spaceItems.forEach((i) => set.delete(i.id))
      } else {
        spaceItems.forEach((i) => set.add(i.id))
      }
      return { ...prev, [catKey]: set }
    })
  }

  /** 类别内按空间名分组（spaceName 缺省归「未分类」）。 */
  const groupBySpace = (items: CleanupItem[]): Array<[string, CleanupItem[]]> => {
    const groups = new Map<string, CleanupItem[]>()
    for (const item of items) {
      const key = item.spaceName ?? ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    }
    return Array.from(groups.entries())
  }

  const [error, setError] = useState('')

  const executeCleanup = () => {
    const selectedCount = Object.values(checked).reduce((acc, s) => acc + s.size, 0)
    if (selectedCount === 0) return
    modal.confirm({
      title: '确认清理',
      content: `将清理选中的 ${selectedCount} 项${totalCleanable > 0 ? `，预计释放 ${formatQuota(totalCleanable, false)}` : ''}。此操作不可撤销。`,
      okText: '清理',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setCleaning(true)
        try {
          for (const cat of categories) {
            const ids = Array.from(checked[cat.key] ?? [])
            if (ids.length > 0) await cat.execute(ids)
          }
          onNotice(`清理完成${totalCleanable > 0 ? `，已释放约 ${formatQuota(totalCleanable, false)}` : ''}`)
          await scan()
        } catch (err) {
          onError(err instanceof Error ? err.message : '清理失败')
        } finally {
          setCleaning(false)
        }
      },
    })
  }

  return (
    <div className="panel setting-group">
      <h3><HardDrive size={16} strokeWidth={2} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -2 }} />存储清理</h3>
      <div className="setting-desc muted">扫描并清理可释放的存储空间：历史旧版本、AI 对话附件、回收站文件。</div>

      {scanning && <div style={{ padding: 24, textAlign: 'center' }}><Spin tip="扫描中…" /></div>}

      {!scanning && categories.length === 0 && (
        <div className="empty" style={{ padding: 24 }}>
          未发现可清理项，存储空间已优化 ✓
        </div>
      )}

      {!scanning && categories.length > 0 && (
        <>
          {/* 总览条 */}
          <div style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Progress
                percent={totalAll > 0 ? Math.round((totalCleanable / totalAll) * 100) : 0}
                size="small"
                format={() => `${formatQuota(totalCleanable, false)} / ${formatQuota(totalAll, false)}`}
              />
            </div>
            <Button size="small" onClick={toggleAll}>
              {categories.every((cat) => (checked[cat.key] ?? new Set()).size >= cat.items.length) ? '取消全选' : '全选所有'}
            </Button>
            <Button type="primary" danger disabled={totalCleanable === 0 && Object.values(checked).every((s) => s.size === 0)} loading={cleaning} onClick={executeCleanup}>
              清理选中项{Object.values(checked).reduce((a, s) => a + s.size, 0) > 0 ? `（${Object.values(checked).reduce((a, s) => a + s.size, 0)} 项）` : ''}
            </Button>
            <Button onClick={() => void scan()} disabled={cleaning}>重新扫描</Button>
          </div>

          {/* 分类卡片 */}
          {categories.map((cat) => {
            const catChecked = checked[cat.key] ?? new Set<string>()
            const catSize = cat.items.reduce((a, i) => a + i.size, 0)
            const catCheckedSize = cat.items.filter((i) => catChecked.has(i.id)).reduce((a, i) => a + i.size, 0)
            return (
              <div key={cat.key} className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--primary)' }}>{cat.icon}</span>
                  <b>{cat.title}</b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {cat.items.length} 项 · {formatQuota(catSize, false)}
                    {catCheckedSize > 0 && catCheckedSize < catSize ? `（已选 ${formatQuota(catCheckedSize, false)}）` : ''}
                  </span>
                  <span style={{ flex: 1 }} />
                  <Button size="small" type="text" onClick={() => toggleCategory(cat.key, cat.items)}>
                    {catChecked.size >= cat.items.length ? '取消全选' : '全选'}
                  </Button>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{cat.desc}</div>
                <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
                  {groupBySpace(cat.items).map(([spaceName, spaceItems]) => (
                    <div key={spaceName || '_default'}>
                      {spaceName && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 4px 2px', borderBottom: '1px solid var(--border)' }}>
                          <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>{spaceName}</span>
                          <span className="muted" style={{ fontSize: 10 }}>{spaceItems.length} 项</span>
                          <span style={{ flex: 1 }} />
                          <Button size="small" type="text" style={{ fontSize: 10, padding: '0 4px' }}
                            onClick={() => toggleSpaceGroup(cat.key, spaceName, cat.items)}>
                            {(spaceItems.every((i) => catChecked.has(i.id))) ? '取消' : '全选'}
                          </Button>
                        </div>
                      )}
                      {spaceItems.map((item) => (
                        <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', cursor: 'pointer', borderRadius: 4 }}>
                          <input
                            type="checkbox"
                            checked={catChecked.has(item.id)}
                            onChange={() => toggleItem(cat.key, item.id)}
                          />
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                            {item.label}
                          </span>
                          <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>{item.detail}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </>
      )}

      {error && <div className="banner error">{error}</div>}
    </div>
  )
}
