// 浏览器端 svgdom shim：xmind-viewer 在 Node.js 下用 svgdom 创建 SVG 窗口，
// 浏览器有原生 SVG + @svgdotjs/svg.js，此模块不会被调用（条件分支跳过）。
export function createSVGWindow() { return undefined }
