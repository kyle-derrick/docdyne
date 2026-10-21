// XMind 思维导图查看器（v2.1：Snowbrush 优先 + markmap 降级）：
// - 首选 xmind-viewer（XMind 官方开源 Snowbrush SVG 渲染，还原视觉）
// - Snowbrush 渲染失败/空白时自动降级 markmap（大纲渲染，保底可用）
// - 顶部悬浮按钮：「转为 Markdown」
import { useEffect, useRef, useState } from 'react'
import { convertMarkdown, fetchFileArrayBuffer } from '../api'
import { useLocale } from '../i18n'
import FloatingActionBar from './FloatingActionBar'
import MarkmapDiagram from './MarkmapDiagram'
import { FileText } from 'lucide-react'
// @ts-ignore — xmind-viewer 无类型声明（CJS，Vite alias shim 处理 Node 依赖）
import { loadFromXMind, SnowbrushRenderer } from 'xmind-viewer'
// @ts-ignore
import JSZip from 'jszip'
import { decompressSync, strFromU8 } from 'fflate'

interface XMindViewerProps {
  fileId: string
  title: string
  loadBuffer?: () => Promise<ArrayBuffer>
  convertible?: boolean
}

const MAX_XMIND_BYTES = 10 * 1024 * 1024

/** 降级路径：解析 content.json → Markdown 大纲 → markmap 渲染。 */
function xmindToMarkdown(buffer: ArrayBuffer): string {
  const zipData = new Uint8Array(buffer)
  const files = decompressSync(zipData)
  const contentData: Uint8Array | undefined = files['content.json']
  if (!contentData) throw new Error('旧版 .xmind（content.xml）暂不支持，请下载后使用 XMind 客户端查看')
  const json = strFromU8(contentData)
  const sheets = JSON.parse(json) as Array<{ title?: string; rootTopic?: { title?: string; notes?: { plain?: { content?: string } | null; content?: string } | null; children?: { attached?: unknown[] } | null } }>
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('无效的 .xmind 文件（无画布数据）')
  const lines: string[] = []
  const writeTopic = (t: NonNullable<typeof sheets[0]['rootTopic']>, level: number) => {
    const title = (t.title ?? '').trim()
    if (title) lines.push(`${'  '.repeat(level)}- ${title}`)
    const notes = (t.notes?.plain?.content ?? t.notes?.content ?? '').trim()
    if (notes) lines.push(`${'  '.repeat(level + 1)}> ${notes.replace(/\n/g, ' ')}`)
    for (const c of (t.children?.attached ?? []) as typeof t[]) writeTopic(c, level + 1)
  }
  for (const s of sheets) {
    if (s.title) lines.push(`# ${s.title}`)
    if (s.rootTopic) writeTopic(s.rootTopic, 0)
  }
  return lines.join('\n')
}

export default function XMindViewer({ fileId, title, loadBuffer, convertible = true }: XMindViewerProps) {
  const locale = useLocale()
  const zh = locale === 'zh-CN'
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [converting, setConverting] = useState(false)
  const [convertNotice, setConvertNotice] = useState('')
  const [convertError, setConvertError] = useState('')
  // 降级模式：Snowbrush 失败/空白时切换 markmap 渲染
  const [fallbackMd, setFallbackMd] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      setError('')
      setLoading(true)
      setFallbackMd('')
      try {
        const buffer = await (loadBuffer ? loadBuffer() : fetchFileArrayBuffer(fileId))
        if (!alive) return
        if (buffer.byteLength > MAX_XMIND_BYTES) {
          throw new Error(zh
            ? `文件过大（${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB，上限 10 MB），请下载后使用 XMind 客户端查看`
            : `File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, limit 10 MB). Please download and open in XMind.`)
        }

        // 方案 A：Snowbrush SVG 渲染（官方引擎，还原视觉）。
        try {
          const zip = await JSZip.loadAsync(buffer)
          const result = await loadFromXMind(zip)
          if (!alive || !result?.sheets?.length) throw new Error('no sheets')
          const container = containerRef.current
          if (!container) return
          container.innerHTML = ''
          const renderer = new SnowbrushRenderer(result.sheets)
          renderer.render()
          const b = renderer.bounds
          // 空白检测：SVG 无内容或尺寸为零 → 降级。
          if (!renderer.svg || b.width < 10 || b.height < 10) throw new Error('blank render')
          const rc = document.createElement('div')
          rc.style.position = 'relative'
          rc.style.overflow = 'auto'
          rc.style.width = '100%'
          rc.style.height = '100%'
          const w = Math.max(container.clientWidth, b.width)
          const h = Math.max(container.clientHeight, b.height)
          rc.style.minWidth = `${w * 2}px`
          rc.style.minHeight = `${h * 2}px`
          renderer.svg.addTo(rc)
          rc.style.backgroundColor = renderer.svg.node?.style?.backgroundColor ?? ''
          container.appendChild(rc)
          renderer.transform(w + b.x, h + b.y)
          rc.scrollLeft = w - container.clientWidth / 2
          rc.scrollTop = h - container.clientHeight / 2
        } catch {
          // 方案 B：降级 markmap（大纲渲染，保底）。
          const md = xmindToMarkdown(buffer)
          if (alive) setFallbackMd(md)
        }
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
      ) : fallbackMd ? (
        <div className="xmind-viewer-host"><MarkmapDiagram source={fallbackMd} /></div>
      ) : (
        <div ref={containerRef} className="xmind-viewer-host" style={{ width: '100%', height: '100%', overflow: 'auto' }} />
      )}
    </div>
  )
}
