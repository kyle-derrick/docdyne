// 消息流「贴底跟随」滚动（v3.4）：仅在用户已处于底部（距底 < 阈值）时
// 跟随新内容；用户上滚即脱离跟随，回到底部自动恢复。
//
// 滚动容器探测（v7.2 修复）：候选依次为 Bubble.List 内部
// .ant-bubble-list-scroll-box → 包裹 div 自身 → 其父级，取第一个
// overflow-y 可滚动且内容确有溢出的元素——本项目样式显式关闭内部滚动
//（.aic-list-wrap overflow-y:auto 接管、scroll-box overflow:visible），
// 盲选 scroll-box 会滚到不可滚动元素上（空操作，「打开不贴底」根因）。
//
// 用法（包裹式，不依赖 Bubble.List 的 ref 形状）：
//   const auto = useStickyScroll(dep)
//   <div ref={auto.wrapRef} onScroll={auto.onScroll}>
//     <Bubble.List ... />
//   </div>
import { useEffect, useRef } from 'react'

/** 距底判定阈值（px）。 */
const BOTTOM_THRESHOLD = 48

/** 元素当前是否为「实际可滚动」的滚动容器（overflow-y 允许 + 内容溢出）。 */
function isScrollable(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el) return false
  const oy = getComputedStyle(el).overflowY
  return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
}

export function useStickyScroll(dep: unknown) {
  const stickRef = useRef(true)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // 滚动容器（探测结果缓存；元素从 DOM 摘除后重探）。
  const boxRef = useRef<HTMLElement | null>(null)

  const resolveBox = (): HTMLElement | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const inner = wrap.querySelector<HTMLElement>('.ant-bubble-list-scroll-box')
    if (isScrollable(inner)) return inner
    if (isScrollable(wrap)) return wrap
    // 无溢出（空会话/未渲染完）：优先结构上的 scroll-box，否则包裹层。
    return inner ?? wrap
  }

  const onScroll = (e: { target: EventTarget | null }) => {
    const box = e.target as HTMLElement | null
    if (!box) return
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_THRESHOLD
  }

  /** 强制回到跟随态并贴底（force=false 仅在当前仍贴底时滚动）。 */
  const scrollToBottom = (force = true) => {
    if (force) stickRef.current = true
    const box = resolveBox()
    boxRef.current = box
    if (box) box.scrollTop = box.scrollHeight
  }

  useEffect(() => {
    const cached = boxRef.current
    const box = cached && cached.isConnected ? cached : resolveBox()
    boxRef.current = box
    if (box && stickRef.current) box.scrollTop = box.scrollHeight
  }, [dep])

  // 挂载后定位一次容器并贴底（Bubble.List 内部结构渲染完成的下一帧）。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const box = resolveBox()
      boxRef.current = box
      if (box && stickRef.current) box.scrollTop = box.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  return { wrapRef, onScroll, scrollToBottom }
}
