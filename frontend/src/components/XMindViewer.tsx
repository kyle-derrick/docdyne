// XMind 思维导图查看器（SimpleMindMap 渲染引擎）：
// - fflate 解 zip 容器取 content.json，解析 sheet/topic 树
// - 转换为 SimpleMindMap 数据格式，用其 MindMap 组件渲染
//   （纯浏览器 JS 库，支持缩放/拖拽/主题/多布局，无 Node.js 依赖）
// - 悬浮按钮「转为 Markdown」
// - 老版 content.xml 与损坏文件给出明确错误
import { useEffect, useMemo, useRef, useState } from 'react'
import { convertMarkdown, fetchFileArrayBuffer } from '../api'
import { useLocale } from '../i18n'
import FloatingActionBar from './FloatingActionBar'
import { useViewerFloatActions } from './ViewerFloatMenu'
import { FileText } from 'lucide-react'
import { unzipSync, strFromU8 } from 'fflate'
import MindMap from 'simple-mind-map'
import 'simple-mind-map/dist/simpleMindMap.esm.css'

interface XMindViewerProps {
  fileId: string
  title: string
  loadBuffer?: () => Promise<ArrayBuffer>
  convertible?: boolean
}

const MAX_XMIND_BYTES = 10 * 1024 * 1024

interface XTopic {
  title?: string
  notes?: { plain?: { content?: string } | null; content?: string } | null
  children?: { attached?: XTopic[] } | null
}

interface XSheet {
  title?: string
  rootTopic?: XTopic
}

/** SimpleMindMap 节点数据格式。 */
interface SMNode {
  data: { text: string; note?: string }
  children?: SMNode[]
}

/** XMind topic 树 → SimpleMindMap 节点树（递归转换）。 */
function topicToNode(t: XTopic): SMNode | null {
  const text = (t.title ?? '').trim()
  if (!text) return null
  const node: SMNode = { data: { text } }
  const note = ((t.notes?.plain?.content ?? t.notes?.content ?? '')).trim()
  if (note) node.data.note = note
  const children: SMNode[] = []
  for (const c of t.children?.attached ?? []) {
    const cn = topicToNode(c)
    if (cn) children.push(cn)
  }
  if (children.length > 0) node.children = children
  return node
}

/** XMind sheets → SimpleMindMap 根节点（首 sheet 的 rootTopic）。 */
function xmindToSMData(buffer: ArrayBuffer): SMNode {
  const zipData = new Uint8Array(buffer)
  // unzipSync 正确解析 ZIP 容器结构（decompressSync 解 raw deflate 会报
  // invalid length/literal——.xmind 是 ZIP 不是裸 deflate 流）。
  const files = unzipSync(zipData)
  const contentData = files['content.json']
  if (!contentData) throw new Error('旧版 .xmind（content.xml）暂不支持，请下载后使用 XMind 客户端查看')
  const json = strFromU8(contentData)
  const sheets = JSON.parse(json) as XSheet[]
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('无效的 .xmind 文件（无画布数据）')
  const sheetTitle = (sheets[0].title ?? '').trim()
  const root = sheets[0].rootTopic ? topicToNode(sheets[0].rootTopic) : null
  if (!root) throw new Error('无效的 .xmind 文件（无根主题）')
  // 有画布标题时作为根节点的前缀。
  if (sheetTitle && root.data.text !== sheetTitle) {
    return { data: { text: sheetTitle }, children: [root] }
  }
  return root
}

export default function XMindViewer({ fileId, title, loadBuffer, convertible = true }: XMindViewerProps) {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<InstanceType<typeof MindMap> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [converting, setConverting] = useState(false)
  const [convertNotice, setConvertNotice] = useState('')
  const [convertError, setConvertError] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      setError('')
      setLoading(true)
      try {
        const buffer = await (loadBuffer ? loadBuffer() : fetchFileArrayBuffer(fileId))
        if (!alive) return
        if (buffer.byteLength > MAX_XMIND_BYTES) {
          throw new Error(zh
            ? `文件过大（${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB，上限 10 MB），请下载后使用 XMind 客户端查看`
            : `File too large, limit 10 MB. Please download and open in XMind.`)
        }
        const data = xmindToSMData(buffer)
        if (!alive) return
        // SimpleMindMap 渲染到容器。
        const container = containerRef.current
        if (!container) return
        container.innerHTML = ''
        // 销毁旧实例（重新加载时）。
        if (mapRef.current) {
          mapRef.current.destroy()
          mapRef.current = null
        }
        // SimpleMindMap 需要一个 SVG 容器元素。
        const svgContainer = document.createElement('div')
        svgContainer.style.width = '100%'
        svgContainer.style.height = '100%'
        container.appendChild(svgContainer)
        // @ts-ignore — simple-mind-map 无类型声明。
        const mindMap = new MindMap({
          el: svgContainer,
          data,
          readonly: true,
          layout: 'logicalStructure',
          theme: 'default',
          nodeTextEditZIndex: 1000,
          enableAutoEnterTextEditWhenKeydown: false,
        })
        mapRef.current = mindMap
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : '思维导图加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, zh, loadBuffer])

  // 转换结果提示自动消退（5s——「已生成…正在打开编辑…」曾常驻不消失）。
  useEffect(() => {
    if (!convertNotice && !convertError) return
    const timer = window.setTimeout(() => { setConvertNotice(''); setConvertError('') }, 5000)
    return () => window.clearTimeout(timer)
  }, [convertNotice, convertError])

  const handleConvert = async (target?: 'mindmap') => {
    if (converting) return
    setConverting(true)
    setConvertNotice('')
    setConvertError('')
    try {
      const created = await convertMarkdown(fileId, target)
      setConvertNotice(zh ? `已生成「${created.name}」，正在打开编辑…` : `Created "${created.name}", opening editor…`)
      window.open(`/markdown/${created.file_id}`, '_blank', 'noopener')
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : (zh ? '转换失败' : 'Conversion failed'))
    } finally {
      setConverting(false)
    }
  }

  // 统一悬浮菜单宿主（查看页/分享页）：转 md 动作注册进宿主菜单；无宿主
  //（查看弹窗/富文本嵌入）回退自渲染悬浮钮。
  const hosted = useViewerFloatActions('xmind-convert', useMemo(
    () => (convertible ? [{
      key: 'convert-mindmap',
      label: zh ? '转为思维导图' : 'Convert to mind map',
      icon: FileText,
      onClick: () => void handleConvert('mindmap'),
    }, {
      key: 'convert',
      label: converting ? (zh ? '转换中…' : 'Converting…') : (zh ? '转为 Markdown' : 'Convert to Markdown'),
      icon: FileText,
      onClick: () => void handleConvert(),
    }] : null),
    [convertible, converting, zh, handleConvert],
  ))

  return (
    <div className="xmind-viewer" title={title}>
      {convertible && !hosted && (
        <FloatingActionBar
          actions={[{
            key: 'convert-mindmap',
            label: zh ? '转为思维导图' : 'Convert to mind map',
            icon: FileText,
            onClick: () => void handleConvert('mindmap'),
          }, {
            key: 'convert',
            label: converting ? (zh ? '转换中…' : 'Converting…') : (zh ? '转为 Markdown' : 'Convert to Markdown'),
            icon: FileText,
            onClick: () => void handleConvert(),
          }]}
        />
      )}
      {(convertNotice || convertError) && (
        <div className="xmind-floating-note">
          {convertError ? <span className="error-text">{convertError}</span> : <span className="muted">{convertNotice}</span>}
        </div>
      )}
      {/* 宿主常驻渲染（不能按 loading/error 条件卸载）——异步解析完成时
          containerRef 必须已挂载，否则 new MindMap 永远拿不到容器，
          画布空白（加载态/错误态改为覆盖层展示）。 */}
      <div ref={containerRef} className="xmind-viewer-host" style={{ width: '100%', height: '100%', overflow: 'hidden' }} />
      {error && <div className="banner error xmind-error">{error}</div>}
      {loading && !error && <div className="viewer-loading-hint">{zh ? '正在加载思维导图…' : 'Loading mind map…'}</div>}
    </div>
  )
}
