// @docflow/chat（K2 自 frontend/src/components/aichat 提取）：
// AI 对话共享组件族——对话场景（全局 AI 助手 / 编辑器侧栏 / 查看页悬浮卡）
// 统一消息流（ChatThread）、输入区（ChatInput）、壳组件（AIChatShell）、
// Markdown/代码块渲染（AIMarkdown）、引用文件选择（AIAttachTree）与
// 思考/工具链/网络来源展示组件。
//
// 边界约定：包零反向依赖宿主（api.ts / i18n / FileBrowser）——文件能力与
// 弹窗外壳经 registerChatFileApi 注入（fileapi.ts）；样式沿用宿主全局
// ai-* 类（见 README「样式契约」）。源码分发（exports 指向 src/index.ts），
// Vite/tsc bundler 解析直接消费 TS 源。
export {
  type AIToolStatus, type AIToolCallEntry, type AIChatTurnData, type AIAttachFile, type AIWebSource,
  toolEntryFrom, applyToolResult, dfToolLabel, isWriteTool, normalizeWebSources, thinkingTitle,
} from './turns'
export {
  AIChatThinking, AIToolChain, AIWebSourcesView,
} from './AIMessageList'
export { CHAT_SEND_ICON, CHAT_STOP_ICON } from './icons'
export { default as AIMarkdown } from './AIMarkdown'
export { default as AIAttachTree } from './AIAttachTree'
export { default as AIChatShell } from './AIChatShell'
export type { ChatMode } from './AIChatShell'
export { default as ChatHeader } from './ChatHeader'
export { default as ChatInput } from './ChatInput'
export type { SkillPackage } from './ChatInput'
export { default as ChatThread } from './ChatThread'
export type { ChatMessage } from './ChatThread'
export { default as ConvoPicker } from './ConvoPicker'
export { default as TraceView } from './TraceView'
export type { TraceStage, TraceUsage } from './TraceView'
export { useStickyScroll } from './useStickyScroll'
export { aiFriendlyError } from './errors'
export { registerChatFileApi, getChatFileApi, peekChatFileApi } from './fileapi'
export type { ChatFileApi, ChatFileRef, ChatSpaceRef, ChatModalShell } from './fileapi'
export type { AISource, AIUsage, AIToolCall, AIToolResult, ChatLocale } from './types'
