// XMind 思维导图查看器（v2：官方开源 Snowbrush 渲染引擎）：
// - 使用 xmind-viewer（XMind Ltd 官方 MIT 开源库）解析 .xmind 并渲染 SVG
//   ——还原颜色/边框/关系线/标记等视觉元素，接近桌面版效果
// - jszip 解 zip 容器 → loadFromXMind 解析 → SnowbrushRenderer 渲染
// - 老版 content.xml（XMind 8 及以前）与损坏内容给出明确错误提示
// - 顶部悬浮按钮：「转为 Markdown」（保留）+「适应宽度」
// - >10MB 大文件提示下载后查看
import { useEffect, useRef, useState } from 'react'
import { convertMarkdown, fetchFileArrayBuffer } from '../api'
import { useLocale } from '../i18n'
import FloatingActionBar from './FloatingActionBar'
import { FileText } from 'lucide-react'
import { loadFromXMind, SnowbrushRenderer } from 'xmind-viewer'
import JSZip from 'jszip'

interface XMindViewerProps {
  fileId: string
  title: string
  loadBuffer?: () => Promise<ArrayBuffer>
  convertible?: boolean
}

const MAX_XMIND_BYTES = 10 * 1024 * 1024

export default function XMindViewer({ fileId, title, loadBuffer, convertible = true }: XMindViewerProps) {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const containerRef = useRef<HTMLDivElement>(null)
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
            : `File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, limit 10 MB). Please download and open it in XMind.`)
        }
        const zip = await JSZip.loadAsync(buffer)
        const result = await loadFromXMind(zip)
        if (!alive || !result.sheets || result.sheets.length === 0) {
          throw new Error(zh ? '无效的 .xmind 文件（无画布数据）' : 'Invalid .xmind file (no sheets)')
        }
        // 渲染 SVG 到容器。
        const container = containerRef.current
        if (!container) return
        container.innerHTML = ''
        const renderer = new SnowbrushRenderer(result.sheets)
        renderer.render()
        const rendererContainer = document.createElement('div')
        rendererContainer.style.position = 'relative'
        rendererContainer.style.overflow = 'auto'
        rendererContainer.style.width = '100%'
        rendererContainer.style.height = '100%'
        const b = renderer.bounds
        const w = Math.max(container.clientWidth, b.width)
        const h = Math.max(container.clientHeight, b.height)
        rendererContainer.style.minWidth = `${w * 2}px`
        rendererContainer.style.minHeight = `${h * 2}px`
        renderer.svg.addTo(rendererContainer)
        rendererContainer.style.backgroundColor = renderer.svg.node.style.backgroundColor
        container.appendChild(rendererContainer)
        renderer.transform(w + b.x, h + b.y)
        rendererContainer.scrollLeft = w - container.clientWidth / 2
        rendererContainer.scrollTop = h - container.clientHeight / 2
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : (zh ? '思维导图加载失败' : 'Failed to load mind map'))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, zh, loadBuffer])

  const handleConvert = async () => {
    if (converting) return
    setConverting(true)
    setConvertNotice('')
    setConvertError('')
    try {
      const created = await convertMarkdown(fileId)
      setConvertNotice(zh ? `已生成「${created.name}」，正在打开编辑…` : `Created "${created.name}", opening editor…`)
      window.open(`/markdown/${created.file_id}`, '_blank', 'noopener')
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : (zh ? '转换失败' : 'Conversion failed'))
    } finally {
      setConverting(false)
    }
  }

  return (
    <div className="xmind-viewer" title={title}>
      {convertible && (
        <FloatingActionBar
          actions={[{
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
      {error ? (
        <div className="banner error xmind-error">{error}</div>
      ) : loading ? (
        <div className="viewer-loading-hint">{zh ? '正在加载思维导图…' : 'Loading mind map…'}</div>
      ) : (
        <div ref={containerRef} className="xmind-viewer-host" style={{ width: '100%', height: '100%', overflow: 'auto' }} />
      )}
    </div>
  )
}
