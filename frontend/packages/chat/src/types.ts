// 包内自治的对话领域类型（自 api.ts 迁入，K2）：SSE 契约形状 + 语言标识。
// api.ts 经 `export type { ... } from '@docdyne/chat'` 保持应用侧导入兼容。

/** 界面语言（与宿主 i18n.Locale 同集合；包内自持避免反向依赖）。 */
export type ChatLocale = 'zh-CN' | 'en-US'

/** AI 回答引用的来源文件（RAG-lite / 文件上下文）。 */
export interface AISource {
  file_id: string
  name: string
  url: string
}

/** AI 对话补全用量。 */
export interface AIUsage {
  prompt_tokens: number
  completion_tokens: number
  duration_ms: number
}

/** SSE tool 事件条目：工具执行前下发（label=「服务名 / 工具名」，input=参数摘要）。 */
export interface AIToolCall {
  type: 'tool'
  label: string
  server?: string
  tool?: string
  input?: string
}

/** SSE tool_result 事件条目：工具执行后下发（ok/duration_ms/output|error 摘要）。 */
export interface AIToolResult {
  server?: string
  tool?: string
  ok: boolean
  duration_ms?: number
  output?: string
  error?: string
}
