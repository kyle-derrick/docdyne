// 浏览器端 canvas shim：xmind-viewer 的 stringNodes 用于文本测量，
// 浏览器原生有 Canvas API，直接暴露 globalThis.canvas 兼容接口。
const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
const ctx = canvas?.getContext('2d') ?? null

export default {
  createCanvas: (w: number = 300, h: number = 150) => {
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null
    if (c) { c.width = w; c.height = h }
    return c
  },
  // stringNodes 用 ctx.measureText；浏览器 ctx 直接返回
  ...(ctx ? { Canvas: ctx.canvas } : {}),
}
