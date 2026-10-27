// CodeViewer：结构化代码查看器（v2.7，json/xml 查看增强）。
// - Monaco 只读渲染（本地打包实例复用编辑器高亮/折叠/缩进参考线）；
// - 工具条：复制 / 美化（JSON.stringify 2 空格 or XML 缩进规整）/ 压缩
//  （JSON only）——操作在内存态进行，可反复切换原始/美化态；
// - json 自动美化初始展示；xml 默认原始（规整缩进美化可选）；
// - 大文件（>2MB）回落纯 pre（Monaco 大文件性能保护）。
import { memo, useMemo, useState } from 'react'
import { Button, Segmented, Tooltip } from 'antd'
import { Check, Copy } from 'lucide-react'
import { lazy, Suspense } from 'react'

const MonacoEditor = lazy(() => import('./MonacoEditor'))

/** JSON 美化；非法 JSON 返回 null（保持原文，不炸界面）。 */
function prettyJSON(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

/** JSON 压缩；非法返回 null。 */
function minifyJSON(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return null
  }
}

/** XML 简单缩进规整（标签级换行缩进；不可解析时返回 null 保守处理）。
 *  自实现（无 DOMParser 依赖的美化器——DOMParser 逐层重排会丢混合内容
 *  与实体，仅按标签边界缩进足够查看场景）。 */
function prettyXML(text: string): string | null {
  if (!/<[a-zA-Z?]/.test(text)) return null
  const padded = text.replace(/>\s*</g, '><')
  let depth = 0
  const out: string[] = []
  const tokens = padded.split(/(?=<)|(?<=>)/g).filter((t) => t !== '')
  for (const t of tokens) {
    if (/^<\//.test(t)) {
      depth = Math.max(0, depth - 1)
      out.push('  '.repeat(depth) + t)
    } else if (/^</.test(t) && !/\/>$/.test(t) && !/^<[?!]/.test(t)) {
      out.push('  '.repeat(depth) + t)
      depth += 1
    } else if (/^<\//.test(t) === false) {
      out.push('  '.repeat(depth) + t)
    } else {
      out.push('  '.repeat(depth) + t)
    }
  }
  return out.join('\n').replace(/\n\s*\n/g, '\n')
}

export interface CodeViewerProps {
  /** 原始文本。 */
  text: string
  /** 语言（monaco language id：json/xml/javascript/text…）。 */
  language: string
  title?: string
  dark?: boolean
}

function CodeViewerInner({ text, language, title, dark }: CodeViewerProps) {
  const [mode, setMode] = useState<'origin' | 'pretty' | 'min'>('pretty')
  const [copied, setCopied] = useState(false)

  const isJSON = language === 'json'
  const isXML = language === 'xml'
  const pretty = useMemo(() => {
    if (isJSON) return prettyJSON(text)
    if (isXML) return prettyXML(text)
    return null
  }, [text, isJSON, isXML])
  const minified = useMemo(() => (isJSON ? minifyJSON(text) : null), [text, isJSON])

  const display = mode === 'pretty' ? (pretty ?? text) : mode === 'min' ? (minified ?? text) : text
  const invalid = (mode === 'pretty' && pretty === null) || (mode === 'min' && minified === null)
  const tooBig = text.length > 2 * 1024 * 1024

  const copy = async () => {
    await navigator.clipboard.writeText(display)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="code-viewer">
      <div className="code-viewer-toolbar">
        <span className="code-viewer-lang">{isJSON ? 'JSON' : isXML ? 'XML' : language.toUpperCase()}</span>
        {(isJSON || isXML) && !tooBig && (
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: 'pretty', label: isJSON ? '美化' : '规整' },
              { value: 'origin', label: '原始' },
              ...(isJSON ? [{ value: 'min' as const, label: '压缩' }] : []),
            ]}
          />
        )}
        {invalid && <span className="muted" style={{ fontSize: 12 }}>解析失败，展示原文</span>}
        <Tooltip title="复制内容">
          <Button size="small" type="text" onClick={() => void copy()} aria-label="复制">
            {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={2} aria-hidden="true" />}
          </Button>
        </Tooltip>
      </div>
      <div className="code-viewer-body">
        {tooBig ? (
          <pre className="preview-text">{display}</pre>
        ) : (
          <Suspense fallback={<pre className="preview-text">{display}</pre>}>
            <MonacoEditor
              height="100%"
              language={language}
              theme={dark ? 'vs-dark' : 'vs'}
              value={display}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                lineNumbers: 'on',
                folding: true,
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderWhitespace: 'none',
                wordWrap: 'off',
              }}
            />
          </Suspense>
        )}
      </div>
      {title ? <span className="sr-only">{title}</span> : null}
    </div>
  )
}

export default memo(CodeViewerInner)
