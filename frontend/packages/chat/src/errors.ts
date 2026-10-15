import type { ChatLocale } from './types'

/**
 * H1 优雅降级：把 AI 请求失败映射为面向用户的友好文案。
 *
 * 后端错误（HTTP JSON 与 SSE error 事件两条路）都带机器可读 code
 * （aiErrorCode：AI_NOT_CONFIGURED / AI_PROVIDER_NOT_FOUND /
 * AI_MODEL_NOT_ALLOWED / AI_UPSTREAM），原始 message 是英文调试文本
 * （如 "ai upstream request failed"）——直接展示对终端用户不友好。
 * 命中 code 时给中文/英文提示；未命中（网络中断等）保留原始 message；
 * 非错误对象时回落通用失败文案。
 *
 * K2：包不反向依赖宿主 ApiError/i18n——code 判定改为 Error 上的
 * `.code` 字符串鸭子判定（宿主 ApiError 结构即 { message, code? }，语义
 * 等价且跨模块副本安全）；回落文案与宿主 i18n 的 aiAssistantErr 同文。
 */
const codeMessages: Record<string, { zh: string; en: string }> = {
  AI_NOT_CONFIGURED: {
    zh: '尚未配置 AI Provider，请联系管理员在「管理 → AI 设置」中添加。',
    en: 'No AI provider configured yet; ask the administrator to add one in Admin → AI settings.',
  },
  AI_PROVIDER_NOT_FOUND: {
    zh: '所选 AI Provider 不存在或已停用，请更换模型或联系管理员。',
    en: 'The selected AI provider is missing or disabled; pick another model or contact the administrator.',
  },
  AI_MODEL_NOT_ALLOWED: {
    zh: '所选模型当前不可用，请重新选择模型。',
    en: 'The selected model is not available; please choose another one.',
  },
  AI_UPSTREAM: {
    zh: 'AI 服务暂时不可用（上游无响应），请稍后重试；本轮之前的对话内容不受影响。',
    en: 'AI service is temporarily unavailable (upstream failed); please retry later. Earlier messages are kept.',
  },
}

/** aiFriendlyError 返回应展示给用户的错误文案（不改变已有内容的保留）。 */
export function aiFriendlyError(err: unknown, locale: ChatLocale): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code
    if (typeof code === 'string' && code) {
      const hit = codeMessages[code]
      if (hit) return locale === 'zh-CN' ? hit.zh : hit.en
    }
    if (err.message) return err.message
  }
  return locale === 'zh-CN' ? 'AI 请求失败' : 'AI request failed'
}
