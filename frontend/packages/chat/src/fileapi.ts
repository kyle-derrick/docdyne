// 宿主能力注入（K2 依赖倒置）：@docdyne/chat 不反向 import 应用层
// （src/api.ts、FileBrowser、i18n），文件浏览/上传/弹窗外壳一律经本注册表
// 取用；App 在组合根（main.tsx）启动时 registerChatFileApi 一次性注入。
import type { ComponentType, ReactNode } from 'react'

/** 文件引用最小结构（宿主 FileItem 的结构子集；包内仅消费这些字段）。 */
export interface ChatFileRef {
  id: string
  name: string
  type: 'folder' | 'file'
}

/** 空间引用最小结构（宿主 Space 的结构子集）。 */
export interface ChatSpaceRef {
  id: string
  name: string
  is_default?: boolean
}

/** 宿主弹窗外壳（DocDyne 的 FileBrowser.Modal）：「保存为文件」弹窗复用
 *  宿主视觉；未注册时 AIMarkdown 回落 antd Modal。 */
export type ChatModalShell = ComponentType<{ title: string; onClose: () => void; children: ReactNode }>

/** 宿主注入的文件能力集合（结构子集契约，宿主实现天然结构兼容）。 */
export interface ChatFileApi {
  /** 列目录（AIAttachTree 递归 walk：spaceId 场景切换 + limit 拉满防截断）。 */
  listFiles: (parentId: string | null, opts?: { spaceId?: string; limit?: number }) => Promise<ChatFileRef[]>
  /** 空间列表（「保存为文件」默认空间优先选择）。 */
  listSpaces: () => Promise<ChatSpaceRef[]>
  /** 空间内目录列表（懒加载目录树，包内仅过滤 folder）。 */
  listSpaceFiles: (spaceId: string, parentId: string | null) => Promise<{ files: ChatFileRef[] }>
  /** 上传落盘（代码块保存为文件；结果只需 file_id 供「新窗口打开」）。 */
  uploadFile: (file: File, parentId: string | null, onProgress: (phase: string) => void) => Promise<{ file_id?: string | null }>
  /** 弹窗外壳组件（可选；缺省回落 antd Modal）。 */
  ModalShell?: ChatModalShell
}

let current: ChatFileApi | null = null

/** 组合根注入（main.tsx）：晚于首帧注册时组件按需取用，不缓存引用。 */
export function registerChatFileApi(api: ChatFileApi): void {
  current = api
}

/** 取宿主能力；未注册时抛出明确错误（SaveCodeModal/AIAttachTree 的 catch
 *  会转成用户可见提示，独立使用包时缺注入即刻暴露而非静默空转）。 */
export function getChatFileApi(): ChatFileApi {
  if (!current) {
    throw new Error('@docdyne/chat: host file API not registered (call registerChatFileApi in the app composition root)')
  }
  return current
}

/** 渲染期非抛出探测（如弹窗外壳回落：未注入时用包内 antd 裸壳）。 */
export function peekChatFileApi(): ChatFileApi | null {
  return current
}
