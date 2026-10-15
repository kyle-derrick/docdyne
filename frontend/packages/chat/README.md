# @docflow/chat

DocFlow AI 对话共享组件族（npm workspace 包，源码分发）。

自 `frontend/src/components/aichat/` 与 `AIMarkdown.tsx` 提取（K2）：全局 AI 助手、
编辑器侧栏（AIEditChat）、查看页悬浮卡（ViewerAIWidget）三个对话场景共用的
消息流、输入区、壳组件与渲染件。

## 形态

- **源码分发**：`exports` 指向 `src/index.ts`，宿主 Vite/tsc（bundler 解析）直接
  消费 TS 源码，无独立构建产物；独立发包前置 = 增补 build 产物与 dts。
- **peerDependencies**：react / react-dom / antd / lucide-react / @ant-design/x /
  react-markdown 系（AIMarkdown 渲染链）/ katex——版本随宿主 `frontend/package.json`。

## 依赖倒置（核心边界）

包**零反向依赖**宿主代码（`src/api.ts`、`src/i18n.ts`、`FileBrowser` 均不可
import）。宿主能力一律经 `registerChatFileApi` 在组合根（`main.tsx`）注入：

| 注入项 | 用途 | 包内消费方 |
|---|---|---|
| `listFiles(parentId, {spaceId, limit})` | 递归遍历空间文件 | AIAttachTree（引用文件选择） |
| `listSpaces()` | 默认空间选择 | AIMarkdown「保存为文件」 |
| `listSpaceFiles(spaceId, parentId)` | 目录懒加载树 | 同上 |
| `uploadFile(file, parentId, onProgress)` | 代码块落盘 | 同上（只用返回的 `file_id`） |
| `ModalShell`（可选） | 宿主弹窗外壳（FileBrowser.Modal） | 同上（缺省回落 antd Modal 裸壳） |

契约类型（`ChatFileApi`/`ChatFileRef`/`ChatSpaceRef`）为宿主实现的结构子集，
宿主函数天然结构兼容（`UploadPhase` 回调差异在组合根以 lambda 适配）。

对话领域类型 `AISource` / `AIUsage` / `AIToolCall` / `AIToolResult` 由本包自治
（`src/types.ts`，SSE 契约形状），宿主 `api.ts` re-export 保持应用侧导入兼容。
`aiFriendlyError` 的错误码判定用 `.code` 字符串鸭子判定（跨模块副本安全，
不依赖宿主 ApiError 类）；回落文案与宿主 i18n `aiAssistantErr` 同文。

## 样式契约

组件样式沿用**宿主全局样式表**（`frontend/src/styles.css` 的 `ai-*` /
`ai-md-*` / `ai-attach-*` 类，约 340 行）：部分规则与宿主选择器复合（如
`.text-editor-body:has(> .ai-edit-chat-panel)`、`.docflow-modal-head-extra
.ai-summary-inline`），非干净可切割，故样式保留应用侧、随包导入链全局生效
（宿主恒导入本包）。antd 侧视觉由宿主 ConfigProvider token 体系参数化。

独立发包前置（记录用，不阻塞当前 workspace 形态）：

1. 将 `ai-*` 纯组件规则切出为包内 `chat.css`（复合选择器留在宿主）；
2. 视觉参数 token 化（CSS 变量 + antd token 桥接）替代全局类名硬依赖；
3. 增补产物构建（tsc + dts）与 peer 版本矩阵验证。

## 消费方

- `frontend/src/components/AIAssistant.tsx`（全局助手）
- `frontend/src/components/AIEditChat.tsx`（编辑器侧栏 Agent 循环）
- `frontend/src/components/ViewerAIWidget.tsx`（查看页悬浮卡）
- `frontend/src/components/AISummary.tsx`（AI 摘要，仅 AIChatThinking）
- `frontend/src/api.ts`（类型 re-export）
