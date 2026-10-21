// 浏览器端 jsdom shim：xmind-viewer 在 Node.js 下用 jsdom 解析 XML，
// 浏览器有原生 DOMParser，此模块不会被调用（条件分支跳过）。
export class JSDOM {
  constructor(_html: string) { throw new Error('jsdom shim: browser does not need JSDOM') }
}
