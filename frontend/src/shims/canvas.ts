// 浏览器端 canvas shim：xmind-viewer 的 stringNodes 用于文本测量。
// 完整实现 createCanvas + registerFont（浏览器原生 Canvas API）。
// 同时补充 global polyfill（xmind-viewer 的 CJS 代码检查 global.window）。

// global polyfill：CJS 模块中 typeof(global.window) 在浏览器不炸。
if (typeof (globalThis as Record<string, unknown>).global === 'undefined') {
  (globalThis as Record<string, unknown>).global = globalThis
}

// 完整的 createCanvas：返回浏览器原生 canvas 元素（含 getContext）。
function createCanvas(w: number = 300, h: number = 150): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// Image polyfill：canvas 包的 Image 在浏览器中原生存在。
// registerFont：浏览器用 CSS @font-face，此为 no-op。
export default {
  createCanvas,
  Image: typeof Image !== 'undefined' ? Image : class MockImage {},
  registerFont: (_path: string, _options: Record<string, unknown>) => ({}),
  Canvas: createCanvas(0, 0).constructor,
  ImageData: typeof ImageData !== 'undefined' ? ImageData : class MockImageData {},
}
