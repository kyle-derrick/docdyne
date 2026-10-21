// xmind-viewer（XMind 官方开源渲染器）的类型声明（库自身无 .d.ts）。
declare module 'xmind-viewer' {
  export interface XMindSheet { [key: string]: unknown }
  export interface XMindWorkbook { sheets: XMindSheet[] }
  export interface SnowbrushSVGNode { addTo: (el: HTMLElement) => void; node: { style: { backgroundColor: string } } }
  export interface SnowbrushInstance {
    render: () => void
    svg: SnowbrushSVGNode
    bounds: { width: number; height: number; x: number; y: number }
    transform: (x: number, y: number) => void
  }
  export function loadFromXMind(zip: unknown): Promise<XMindWorkbook>
  export const SnowbrushRenderer: new (data: XMindSheet[]) => SnowbrushInstance
}
declare module 'jszip' {
  const JSZip: { loadAsync: (data: ArrayBuffer) => Promise<unknown> }
  export default JSZip
}
