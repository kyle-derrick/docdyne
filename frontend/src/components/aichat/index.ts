// AI 对话共享组件族：对话场景（全局 AI 助手 / 编辑器侧栏 / 查看页悬浮卡）
// 统一消息流（ChatThread）、输入区（ChatInput）、壳组件（AIChatShell）与
// 思考/工具链/网络来源展示组件。
export {
  type AIToolStatus, type AIToolCallEntry, type AIChatTurnData, type AIAttachFile, type AIWebSource,
  toolEntryFrom, applyToolResult, dfToolLabel, isWriteTool, normalizeWebSources, thinkingTitle,
} from './turns'
export {
  AIChatThinking, AIToolChain, AIWebSourcesView,
} from './AIMessageList'
export { CHAT_SEND_ICON, CHAT_STOP_ICON } from './icons'
