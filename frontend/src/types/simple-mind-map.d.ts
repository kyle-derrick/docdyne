// simple-mind-map 类型声明（库自身无 .d.ts）。
declare module 'simple-mind-map' {
  export interface MindMapData {
    data: { text: string; note?: string; [key: string]: unknown }
    children?: MindMapData[]
  }
  export interface MindMapOptions {
    el: HTMLElement
    data: MindMapData
    readonly?: boolean
    layout?: string
    theme?: string
    [key: string]: unknown
  }
  export default class MindMap {
    constructor(options: MindMapOptions)
    destroy(): void
    render(): void
    setTheme(theme: string): void
    setLayout(layout: string): void
    [key: string]: unknown
  }
}
declare module 'simple-mind-map/dist/simpleMindMap.esm.css'
