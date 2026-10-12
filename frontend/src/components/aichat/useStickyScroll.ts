// 消息流「贴底跟随」滚动（v3.4）：替代 @ant-design/x Bubble.List 的
// autoScroll（column-reverse 实现——流式输出时用户向上阅读历史会被持续
// 顶回底部）。本 hook 仅在用户已处于底部（距底 < 阈值）时跟随新内容；
// 用户上滚即脱离跟随，回到底部自动恢复。
//
// 用法（包裹式，不依赖 Bubble.List 的 ref 形状）：
//   const auto = useStickyScroll(dep)
//   <div ref={auto.wrapRef} onScroll={auto.onScroll}>
//     <Bubble.List ... />
//   </div>
import { useEffect, useRef } from 'react'

/** 距底判定阈值（px）。 */
const BOTTOM_THRESHOLD = 48

export function useStickyScroll(dep: unknown) {
  const stickRef = useRef(true)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // 滚动容器（Bubble.List 的 scroll-box 或包裹 div 自身）。
  const boxRef = useRef<HTMLElement | null>(null)

  const resolveBox = (): HTMLElement | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    return wrap.querySelector('.ant-bubble-list-scroll-box') ?? wrap
  }

  const onScroll = (e: { target: EventTarget | null }) => {
    const box = e.target as HTMLElement | null
    if (!box) return
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_THRESHOLD
  }

  /** 强制回到跟随态并贴底（force=false 仅在当前仍贴底时滚动）。
   *  注意滚动容器是内部 scroll-box 而非外层 wrap——直接滚 wrap 是空操作
   *  （v3.9 助手「打开不贴底」的根因）。 */
  const scrollToBottom = (force = true) => {
    if (force) stickRef.current = true
    const box = boxRef.current ?? resolveBox()
    boxRef.current = box
    if (box) box.scrollTop = box.scrollHeight
  }

  useEffect(() => {
    const box = boxRef.current ?? resolveBox()
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
