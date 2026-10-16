// DocDyne 富文本嵌入块节点（自定义 Tiptap node）：
// - atom 块级节点，attrs { kind, fileId, title }，NodeView 渲染实际内容
//   （见 EmbedView.tsx）；
// - .ddoc 为 Tiptap JSON 存储：嵌入块以本节点原生存进文档 JSON，
//   无需 Markdown 序列化约定（v1.7 起 .md 不再走富文本编辑器，
//   旧的 fenced code block 往返补丁已随 tiptap-markdown 一并移除）。
import { Node, mergeAttributes, ReactNodeViewRenderer } from '@tiptap/react'
import EmbedView from './EmbedView'
import { EmbedKind, EmbedRef } from './markdownRoundtrip'

/** Docs 命令类型扩展：editor.commands.insertDocdyneEmbed(ref)。 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docdyneEmbed: {
      /** 在当前选区插入嵌入块（drawio/excalidraw/office/web/file 引用）。 */
      insertDocdyneEmbed: (ref: EmbedRef) => ReturnType
    }
  }
}

export interface DocdyneEmbedAttrs {
  kind: EmbedKind
  fileId: string
  title: string
  /** 显示宽度（百分比 25-100；右下角 resize 把手拖拽调整）。 */
  width: number
  /** 显示高度（px；0 = 按内容/宽度自适应，不出现内部滚动）。 */
  height: number
}

const DEFAULT_ATTRS: DocdyneEmbedAttrs = { kind: 'file', fileId: '', title: '', width: 100, height: 0 }

export const DocdyneEmbed = Node.create({
  name: 'docdyneEmbed',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: {
        default: DEFAULT_ATTRS.kind,
        parseHTML: (element) => element.getAttribute('data-docdyne-embed') || DEFAULT_ATTRS.kind,
        renderHTML: (attributes) => ({ 'data-docdyne-embed': attributes.kind }),
      },
      fileId: {
        default: DEFAULT_ATTRS.fileId,
        parseHTML: (element) => element.getAttribute('data-file-id') || '',
        renderHTML: (attributes) => ({ 'data-file-id': attributes.fileId }),
      },
      title: {
        default: DEFAULT_ATTRS.title,
        parseHTML: (element) => element.getAttribute('data-title') || '',
        renderHTML: (attributes) => ({ 'data-title': attributes.title }),
      },
      width: {
        default: DEFAULT_ATTRS.width,
        parseHTML: (element) => Number(element.getAttribute('data-width')) || DEFAULT_ATTRS.width,
        renderHTML: (attributes) => ({ 'data-width': String(attributes.width) }),
      },
      height: {
        default: DEFAULT_ATTRS.height,
        parseHTML: (element) => Number(element.getAttribute('data-height')) || DEFAULT_ATTRS.height,
        renderHTML: (attributes) => (attributes.height ? { 'data-height': String(attributes.height) } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-docdyne-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-node-view-wrapper': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedView)
  },

  addCommands() {
    return {
      insertDocdyneEmbed:
        (ref: EmbedRef) =>
          ({ commands }) =>
            commands.insertContent({ type: this.name, attrs: { kind: ref.kind, fileId: ref.fileId, title: ref.title } }),
    }
  },
})

export default DocdyneEmbed
