// AIChatShell：统一 AI 对话壳组件（阶段二骨架）。
// 目标：AI 助手 / 编辑页 AI / 查看页 AI 共用同一套 UI，仅通过 props
// 区分场景差异（hostType + 能力 slots）。当前为骨架——各宿主逐步迁移。
//
// 架构：
//   AIChatShell
//   ├── ChatHeader   头部按钮组（会话/导入导出/多选/悬浮切换/关闭）
//   ├── ChatThread   消息流（气泡+TraceView+操作行）
//   ├── ChatInput    输入区（工具栏+技能包+开关+发送）
//   └── 场景 slots   assistant（空间/RAG/记忆/人设）、editor（宿主工具）、viewer（摘要）
//
// 迁移策略：先提取共享子组件到 aichat/，再逐宿主替换内部实现为 Shell。
import type { ReactNode } from 'react'

/** 场景类型：决定注入哪些能力与上下文。 */
export type ChatHostType = 'assistant' | 'editor' | 'viewer'

/** 统一 AI 对话 Shell Props（渐进式——宿主迁移过程中逐项从可选变为必填）。 */
export interface AIChatShellProps {
  hostType: ChatHostType
  /** editor/viewer 必填：文件 id（会话分域键 + 上下文注入）。 */
  fileId?: string
  /** editor：宿主编辑工具集（Agent 工具循环用）。 */
  agentTools?: Array<{ name: string; desc: string; destructive?: boolean; label: (a: Record<string, unknown>) => string; exec: (a: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }> }>
  /** editor：宿主规范注入（追加到 Agent system）。 */
  agentSystemExtra?: string
  /** editor：applyKind 标识（影响技能包自动选择）。 */
  applyKind?: string

  // ---- assistant 特有 ----
  /** assistant：RAG 知识库开关。 */
  ragEnabled?: boolean
  /** assistant：人设 slot（Select 组件等）。 */
  personaSlot?: ReactNode
  /** assistant：工作目录 slot。 */
  workdirSlot?: ReactNode
  /** assistant：长期记忆管理 slot。 */
  memorySlot?: ReactNode

  // ---- viewer 特有 ----
  /** viewer：摘要 Tab slot。 */
  summarySlot?: ReactNode
  /** viewer：查看的文件 id（上下文注入——与 fileId 同值时省略）。 */
  contextFileId?: string

  // ---- 通用 slots ----
  /** 额外工具栏按钮（追加到工具栏右侧）。 */
  extraToolbarSlot?: ReactNode
  /** 额外头部按钮（追加到头部 ops 区）。 */
  extraHeaderSlot?: ReactNode
}

/**
 * AIChatShell 骨架——当前仅导出接口与工具函数，宿主尚未迁移。
 * 完整实现见 TODO-agent.md 阶段二至五。
 */
export default function AIChatShell(_props: AIChatShellProps) {
  // 骨架：宿主暂不使用此组件，等阶段一共享子组件就绪后组装。
  return null
}

/** 场景能力矩阵（供各宿主与子组件查询当前场景应启用的功能）。 */
export function hostCapabilities(hostType: ChatHostType) {
  return {
    hasAgentTools: hostType === 'editor',
    hasSessionPersistence: hostType !== 'viewer' || true, // 三处都会话持久化
    hasFloatingMode: hostType !== 'viewer', // 查看页本身是悬浮球
    hasPlanMode: hostType === 'editor', // 仅编辑页（已从 UI 移除，保留逻辑）
    hasCautiousMode: hostType === 'editor', // 仅编辑页有破坏性工具
    hasBatchActions: true,
    hasImportExport: true,
    hasSkillPackages: hostType === 'editor', // 仅编辑页（助手走 df_* 服务端工具）
    hasFileContext: hostType !== 'assistant', // 助手不带文件上下文
    hasSummary: hostType === 'viewer',
    hasRAG: hostType === 'assistant',
    hasMemory: hostType === 'assistant',
    hasPersona: hostType === 'assistant',
  }
}
