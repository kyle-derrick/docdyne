# DocFlow AI 编辑工具套装

各文档类型的 AI 编辑能力总览（v7 工具套装体系）。所有编辑器的 AI 均为
**工具循环 Agent**：模型每轮输出 `TOOL_CALL {"tool":…,"args":{…}}` 调用一个
工具、按 `TOOL_RESULT` 决定下一步，完成后 `FINAL` 总结；关键写入后可用读
工具校验。**坐标与序号约定全编辑器统一 1 基**（excel `[行,列]`、`[1,1]=A1`；
word 元素序号从 1 起；slide 页码从 1 起）。

## 工具套装一览

| 类型 | 工具数 | 读 | 写/改 | 插入 | 结构/样式 |
|---|---|---|---|---|---|
| Word | 26 | get_doc_info / read_document / search_text / get_selection / read_table | replace_text / replace_all / replace_element / delete_element | insert_content（Markdown 子集）/ insert_table / insert_image / insert_code_block / insert_hyperlink / insert_toc | format_element / set_paragraph_style / table_op / 页面设置（方向/边距/页眉脚/页码） |
| Excel | 19 | get_doc_info / read_range / find_text | write_table★ / write_cells / insert_formula / clear_range | insert_chart / insert_image | format_range / row_op / col_op / set_col_width / merge_cells / freeze_panes / sheet_op / autofit / sort_range / apply_filter / set_conditional_format |
| PPT | 13 | get_doc_info / read_slide | set_text / set_slide_title / slide_notes | add_slide / add_text_box / add_shape / slide_insert_image / add_table | delete_slide / move_slide / set_slide_background / set_slide_layout |
| PDF | — | 查看页 AI（摘要/对话，服务端抽取文本） | —（DS 无 PDF 文档 API，如实边界） | — | — |
| draw.io | 6 | read_diagram / list_cells | update_cells / delete_cells | insert_cells | replace_diagram（整图） |
| 白板 (Excalidraw) | 6 | read_scene | update_elements / move_elements / delete_elements / connect（a→b 直连） | insert_elements（骨架数组，at 锚点） | — |
| 富文本 (.dfdoc) | 12 | read_document / read_selection / search_text | replace_text / write_document / delete_block | insert_content（Markdown）/ insert_table / insert_image / insert_link / **insert_embed** | format_text / set_block_type |
| Monaco 文本 | 6 | read_document / read_selection / search_text | replace_text / write_whole | insert_content | — |

★ `write_table`：整表场景的组合工具——模型给二维数组（含表头行）而非逐格
坐标，执行侧一次写入并自动套表头样式（加粗/底纹/居中/列宽自适应/可选
冻结），从机制上根除「行列逐格偏移」类错误。

## 各类型入口与实现位置

- **Office（word/excel/ppt）**：编辑器内「DocFlow AI」插件面板
  （`frontend/public/oo-plugins/docflow-ai/`，v7）。工具在 OnlyOffice 沙箱内
  经 `Asc.plugin.callCommand` 执行（plugin.js 内 ES5 函数序列化注入）；提示
  词按编辑器类型分节。缓存：plugin.js 改动必须递增 index.html 的 `?v=`。
- **draw.io / 白板 / 富文本 / Monaco**：编辑页右侧 AIEditChat 面板
  （`frontend/src/components/AIEditChat.tsx`，v7.4 起渲染层为 AIChatShell
  editor 模式），工具由宿主页经 `agentTools` 注入、`agentSystemExtra`
  注入类型专属规范，前端本地执行（ProseMirror 命令 / DOMParser XML 操作 /
  excalidraw updateScene），落盘走版本链（应用前保存基线，可撤销）。
- **平台 AI 助手（全局抽屉）**：AIAssistant（v7.4 起渲染层为 AIChatShell
  assistant 模式，Drawer 仅作容器）+ 服务端 df_* 文件工具
  （`internal/ai/platformtools.go`）——可创建 `.drawio`/`.excalidraw`/
  `.mermaid` 等图表白板源文件（跨类型创作），再进各编辑器用对应工具套装
  精修。
- **查看页悬浮 AI 助理**：ViewerAIWidget（v7.4 起消息流/输入区为共享
  ChatThread/ChatInput；文本类文件支持「保存为新版本」，经 actionSlot
  注入）。
- **外部 agent**：平台 MCP（`docs/mcp.md`，21 个 df_* 工具）——drawio/
  excalidraw 为文本源文件，直接读写即为编辑。

## 统一 AI 对话架构（v7.4）

三处对话 UI（助手抽屉 / 编辑页面板 / 查看页悬浮卡）共用
`frontend/packages/chat/`（npm workspace 包 `@docflow/chat`，源码分发）组件族，
宿主只保留业务逻辑、渲染全部经 props 注入；文件浏览/上传/弹窗外壳经
`registerChatFileApi` 在组合根（`main.tsx`）注入（K2 依赖倒置，包零反向依赖
宿主；边界与样式契约见 `packages/chat/README.md`）：

| 组件 | 职责 |
|---|---|
| `AIChatShell` | 壳：ChatHeader + 模式段 + ChatThread + 批量条 + ChatInput；hostType 区分场景（assistant 自动 in-drawer 形态） |
| `ChatHeader` | 标题 + 会话管理（ConvoPicker）+ 新建 + 导入导出 + 批量 + 悬浮切换 + 关闭（showFloat/showCautious 可隐藏） |
| `ChatThread` | 统一消息流：思考折叠 / TraceView / markdown 流式 / 工具链 / RAG 与网络来源 / 用量 / 操作行（复制/删除/保存/重新生成）；actionSlot 扩展位（viewer 保存为新版本）；emptySlot 空态 |
| `ChatInput` | 输入框 + 工具栏（技能包 / 谨慎模式 / togglesSlot 开关组 / 模型选择 / 发送停止） |
| `AIMessageList.tsx` | AIChatThinking（思考折叠）/ AIToolChain（工具链）/ AIWebSourcesView（网络来源） |
| `ConvoPicker` / `useStickyScroll` / `icons` | 会话选择器 / 贴底跟随 / 发送停止图标 |

会话持久化：服务端 `/api/v1/ai/conversations` 事件溯源（turn 追加 /
snapshot 快照，migration 054）；助手与编辑页共用，查看页按产品决策不保存
会话（仅本机 localStorage 快照）。


## 跨类型组合

- 富文本 `insert_embed {name}`：在文档中内嵌平台文件（.drawio→图表、
  .excalidraw→白板、Office→文档卡片、其余→文件卡片）；内嵌块在 AI 上下文
  中序列化为 `[DocFlow-Embed …]` 占位行并受保护（整篇重写也逐字保留）。
- 内嵌对象的内部内容编辑：从嵌入块「编辑（新窗口）」进入对应编辑页，使用
  该类型的工具套装。
- 助手侧组合：对话中让 AI 直接 `df_write_file` 生成 `.drawio`/`.excalidraw`
  源文件 → 打开编辑 → 继续用编辑器工具套装精修。

## 提示词分布

| 提示词 | 位置 |
|---|---|
| Office 分类型 Agent（word/cell/slide/pdf 规范 + 工具清单） | `frontend/public/oo-plugins/docflow-ai/plugin.js`（buildSystem / KIND_GUIDES / TOOL_DOCS） |
| Agent 通用协议（TOOL_CALL/FINAL、先读后改）+ 宿主名 | `frontend/src/components/AIEditChat.tsx`（sendAgent） |
| drawio XML 载荷规范 | `AIEditChat.tsx` DRAWIO_XML_GUIDE（drawio 页 agentSystemExtra 复用） |
| excalidraw 骨架载荷规范 | `AIEditChat.tsx` EXCALIDRAW_JSON_GUIDE（白板页 agentSystemExtra 复用） |
| 富文本宿主约束（find 片段/占位行保护） | `DfdocEditorPage.tsx`（agentSystemExtra） |
| 摘要 / RAG 引用 / OCR / 记忆提取 / 文件上下文块 | `internal/ai/*.go`、`internal/http/ai*.go` |

检索片段 / 附件全文 / 网络搜索摘要 / 记忆标题等不可信数据注入 system 上下文时，
一律经 `ai.UntrustedBlock`（`internal/ai/untrusted.go`）包进带固定告示的
⟦⟧ 围栏（内容中围栏字符中和，边界不可伪造——J2 提示注入防护）。
Agent 技能包（`ai.agent_packages`）的 system_extra 在 sendAgent 阶段追加，
执行期间锁定 package（`runAgentLoop` 工具集为调用时快照，中途切包不影响当轮）。
