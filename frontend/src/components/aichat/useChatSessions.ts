// useChatSessions：统一 AI 会话管理 Hook（阶段一 S5）。
// 封装：服务端会话 CRUD + 事件追加 + 切换/新建/删除 + 导入导出。
// 三处宿主（assistant/editor/viewer）共用，通过 source + fileId 区分域。
import { useCallback, useRef, useState } from 'react'
import {
  aiAppendConversation, aiCreateConversation, aiDeleteConversation,
  aiGetConversation, aiListConversations, aiUpdateConversation,
} from '../../api'
import type { AIConvoSource } from '../../api'

export interface ManagedSession {
  id: string
  title: string
  updatedAt: number
  messageCount?: number
  turns: Array<Record<string, unknown>>
}

export function useChatSessions(scope: { source: AIConvoSource; fileId?: string | null }) {
  const [sessions, setSessions] = useState<ManagedSession[]>([])
  const [activeId, setActiveId] = useState('')
  const sessionsRef = useRef<ManagedSession[]>([])
  sessionsRef.current = sessions
  const activeIdRef = useRef('')
  activeIdRef.current = activeId
  const syncedLenRef = useRef(0)
  const [loading, setLoading] = useState(false)

  /** 恢复列表 + 最近一条正文。 */
  const restore = useCallback(async () => {
    setLoading(true)
    try {
      const metas = await aiListConversations(scope)
      const list: ManagedSession[] = metas.map((m) => ({
        id: m.id, title: m.title,
        updatedAt: new Date(m.updated_at).getTime(),
        messageCount: m.message_count, turns: [],
      }))
      sessionsRef.current = list
      setSessions(list)
      if (list[0]) {
        activeIdRef.current = list[0].id
        setActiveId(list[0].id)
        try {
          const row = await aiGetConversation(list[0].id)
          const msgs = (row.messages ?? []) as Array<Record<string, unknown>>
          list[0] = { ...list[0], turns: msgs }
          sessionsRef.current = [...list]
          syncedLenRef.current = msgs.length
          return msgs
        } catch { /* 正文拉取失败按空处理 */ }
      }
      syncedLenRef.current = 0
      return []
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [scope])

  /** 同步 turns 变更（事件模型：增量 turn / snapshot / 删除）。 */
  const sync = useCallback(async (turns: Array<Record<string, unknown>>) => {
    const persist = turns.filter((t) => (t as { content?: unknown }).content)
    const synced = syncedLenRef.current
    const id = activeIdRef.current
    try {
      if (persist.length > synced) {
        const prev = sessionsRef.current.find((s) => s.id === id)
        let cid = id
        if (!cid || !prev) {
          const row = await aiCreateConversation(scope, String(persist[0]?.content ?? '').slice(0, 18) || '新会话')
          cid = row.id
          activeIdRef.current = cid
          setActiveId(cid)
        }
        await aiAppendConversation(cid, 'turn', persist.slice(synced))
        syncedLenRef.current = persist.length
      } else if (persist.length < synced) {
        if (persist.length === 0 && id) {
          await aiDeleteConversation(id).catch(() => {})
          sessionsRef.current = sessionsRef.current.filter((s) => s.id !== id)
          setSessions([...sessionsRef.current])
          syncedLenRef.current = 0
        } else if (id && persist.length > 0) {
          await aiAppendConversation(id, 'snapshot', persist.slice(-40))
          syncedLenRef.current = Math.min(persist.length, 40)
        }
      }
    } catch { /* 静默重试 */ }
  }, [scope])

  /** 切换会话。 */
  const switchTo = useCallback(async (id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target || id === activeIdRef.current) return null
    activeIdRef.current = id
    setActiveId(id)
    if (target.turns.length > 0) {
      syncedLenRef.current = target.turns.length
      return target.turns
    }
    try {
      const row = await aiGetConversation(id)
      const msgs = (row.messages ?? []) as Array<Record<string, unknown>>
      target.turns = msgs
      syncedLenRef.current = msgs.length
      return msgs
    } catch { return [] }
  }, [])

  /** 新建空白会话。 */
  const newSession = useCallback(() => {
    activeIdRef.current = ''
    setActiveId('')
    syncedLenRef.current = 0
    return []
  }, [])

  /** 删除会话。 */
  const remove = useCallback(async (id: string) => {
    await aiDeleteConversation(id).catch(() => {})
    const next = sessionsRef.current.filter((s) => s.id !== id)
    sessionsRef.current = next
    setSessions(next)
    if (id === activeIdRef.current) {
      if (next[0]) return switchTo(next[0].id)
      return newSession()
    }
    return null
  }, [switchTo, newSession])

  /** 重命名。 */
  const rename = useCallback(async (id: string, title: string) => {
    sessionsRef.current = sessionsRef.current.map((s) => (s.id === id ? { ...s, title } : s))
    setSessions([...sessionsRef.current])
    await aiUpdateConversation(id, { title }).catch(() => {})
  }, [])

  return { sessions, activeId, loading, restore, sync, switchTo, newSession, remove, rename, sessionsRef, activeIdRef, syncedLenRef }
}
