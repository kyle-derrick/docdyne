import { cpSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Excalidraw 运行时静态资源本地化：包体默认从 unpkg CDN 拉字体/vendor
//（EXCALIDRAW_ASSET_PATH 缺省），内网/离线部署不可达 → 组件初始化挂起 →
// 白板页白屏（无报错）。构建期拷入产物 /excalidraw-assets/，dev server
// 以中间件同源服务；配合 index.html 前置设置的 EXCALIDRAW_ASSET_PATH。
function copyExcalidrawAssets(): Plugin {
  const src = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/excalidraw-assets', import.meta.url))
  return {
    name: 'copy-excalidraw-assets',
    apply: 'build',
    closeBundle() {
      cpSync(src, fileURLToPath(new URL('./dist/excalidraw-assets', import.meta.url)), { recursive: true })
    },
  }
}

// 开发服务器将 /api 代理到本地 Go 后端，避免跨域；refresh cookie 也保持同源。
//
// ONLYOFFICE 说明：DocEditor 脚本按绝对地址直连 DocumentServer
// （{server_url}/web-apps/apps/api/documents/api.js，见 src/pages/EditorPage.tsx），
// 因此 /onlyoffice 无需 dev proxy。但 DocumentServer 运行在 docker 网络内，
// 浏览器（docker 网络外）须本地可达才能加载脚本：
//   - 开发时后端 ONLYOFFICE_SERVER_URL 应指向 http://localhost:8081
//     （docker-compose.yml 将 onlyoffice 容器 80 映射为宿主机 8081）；
//   - 或直接禁用集成（ONLYOFFICE_ENABLED=false，此时前端不显示「编辑」入口）。
export default defineConfig({
  // @excalidraw/excalidraw 包入口（main.js）以 process.env.IS_PREACT 分发
  // preact/React 构建；Vite 默认剔除 env 变量会导致浏览器报
  // "process is not defined"（官方 FAQ），此处固定为 false 走 React 构建。
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  build: {
    rollupOptions: {
      output: {
        // vendor 拆分（首屏 gzip 目标 <400KB）：react 运行时 / antd 全家
        // （@rc-component、dayjs、@ant-design 等）/ lucide 图标各自独立
        // chunk——库代码变动频率远低于业务代码，独立分包显著提升 SW/HTTP
        // 缓存命中（发版只失效业务 chunk）。仅列举确定被首屏静态引用的包；
        // 按需加载的重组件（monaco/mermaid/excalidraw/tiptap/markmap 等）
        // 不匹配任何规则，保持 rollup 默认按使用方分包（懒加载语义不变）。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (
            /[\\/]node_modules[\\/](@ant-design|@rc-component|antd|rc-[a-z0-9-]+|dayjs|@babel\/runtime|clsx|scroll-into-view-if-needed|compute-scroll-into-view|throttle-debounce|async-validator|staged-components|json2typescript|react-slick|@floating-ui)[\\/]/.test(
              id,
            )
          )
            return 'vendor-antd'
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons'
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    // Excalidraw 字体/vendor 资源本地服务（dev）：与 build 期拷贝产物同路径。
    // vite 的 public/ 目录方案要求资源进仓库（包产物，体积与升级都不合适），
    // 故 dev 用中间件、build 用 closeBundle 拷贝，两侧路径一致。
    {
      name: 'serve-excalidraw-assets-dev',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/excalidraw-assets/', (req, res, next) => {
          const rel = decodeURIComponent(req.url?.split('?')[0] ?? '').replace(/^\/+|\/+$/g, '')
          if (!/^[\w.-]+$/.test(rel)) { next(); return }
          try {
            const data = readFileSync(
              fileURLToPath(new URL(`./node_modules/@excalidraw/excalidraw/dist/excalidraw-assets/${rel}`, import.meta.url)),
            )
            res.setHeader(
              'Content-Type',
              rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
            )
            res.end(data)
          } catch { next() }
        })
      },
    },
    copyExcalidrawAssets(),
    // PWA 基础（v1.1）：可安装（manifest）+ 应用 Shell 预缓存，不做离线数据。
    // - registerType autoUpdate：新 SW 安装即激活（skipWaiting+clientsClaim），
    //   运行中的页面内存里仍是旧 Shell，由前端 onNeedReload 提示「点击刷新」；
    // - navigateFallback 仅兜底应用内 SPA 导航；API/文件内容、ONLYOFFICE/draw.io
    //   iframe 资源与公开分享页（/s）都需要网络，一律排除不落 SW。
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'DocDyne',
        short_name: 'DocDyne',
        description: 'DocDyne 团队云文档',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        // 非SPA路径必须排除在导航兜底外：否则SW会把同源 iframe/直开链接
        // 劫持成预缓存的 SPA index.html——/oo-plugins/（OnlyOffice DocDyne AI
        // 插件面板，曾致插件打开成"文件页"）与 /raw/（受控原始内容直开）。
        navigateFallbackDenylist: [/^\/api\//, /^\/content\//, /^\/onlyoffice\//, /^\/drawio\//, /^\/s\//, /^\/oo-plugins\//, /^\/raw\//],
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // mermaid 生态按需懒加载块（图表类型子块为「名-哈希-哈希」双段命名，
        // 另有 mermaid.core/cytoscape/katex 单段大件）合计 5MB+，仅查看图表
        // 时才需要：不进 SW 预缓存（避免首装全量下载），在线按需拉取。
        // 富文本编辑器（Tiptap + lowlight，~640KB）同例：仅编辑 markdown 时
        // 懒加载（RichTextEditor-*.js 独立 chunk），不进预缓存。
        // Monaco（VSCode）编辑器同例：本地打包产物 3MB+（MonacoEditor-*.js
        // 懒加载 chunk 与按语言 worker：*.worker-*.js），仅文本/源码编辑与
        // 查看时需要，不进预缓存。
        globIgnores: [
          'assets/*-*-*.js',
          'assets/mermaid*.js',
          'assets/cytoscape*.js',
          'assets/katex-*.js',
          'assets/RichTextEditor*.js',
          'assets/MonacoEditor*.js',
          'assets/*.worker-*.js',
          // Excalidraw 运行时资源（字体 + 2.96MB vendor）：按需加载，不进
          // 预缓存（vendor 超过 workbox 2MiB 上限会直接报错；策略同 mermaid）。
          'excalidraw-assets/**',
          // dhtmlx-gantt 按需 chunk（约 1.2MB）：同 mermaid 策略不进预缓存。
          'assets/dhtmlx*.js',
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        // DOCDYNE_DEV_API 可指向完整栈入口（如 http://127.0.0.1 的 caddy），
        // 便于 dev server 复用真实后端联调；缺省本地 Go 后端 :8080。
        // 注意 changeOrigin 必须为 false：后端 CSRF 校验要求 Origin/Referer
        // 的 host 与请求 Host 一致，改写 Host 会导致 /auth/refresh 被 403。
        target: process.env.DOCDYNE_DEV_API ?? 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
})
