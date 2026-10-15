# TODO — v7.15 待完成全部项

> 用户确认后开始动工，全部自行完成，不遗漏。

## A. 上下文管理（RAG + AI 摘要 + 工具式记忆）
- [ ] A1. AI 摘要压缩：上下文达 70% 时调 AI 生成被丢弃历史的摘要
      （替代硬截断）；摘要注入为 system 消息，保留关键决策/发现/状态
- [ ] A2. 结构化轮次日志：程序化提取每轮 工具名(关键参数)→结果摘要
      （工具结果是 JSON，提取准确）；随 trace 展示 + 压缩时保留
- [ ] A3. df_search_history 工具：RAG 向量检索（Qdrant，复用已有
      embedding 基础设施）+ ILIKE 关键词兜底（RAG 未配置时）
- [ ] A4. 后端压缩事件推送前端：压缩触发时发 SSE meta 事件，
      前端在过程块中显示「上下文自动压缩：N 条 → M 条」
- [ ] A5. 分层上下文验证：确保不是全量丢给 AI（测试 100+ 轮场景）
- [ ] A6. 会话历史 RAG 索引写入：每轮对话完成后将消息写入
      Qdrant（collection: {prefix}_conversations）或 PG 全文
- [ ] A7. 工具式记忆：df_read_memory（查详情）+ df_write_memory
      （自动记录）替代全量注入；系统提示仅带记忆标题列表(~200tok)
- [ ] A8. 管理端配置：AI 设置加「对话历史检索」开关
      （vector/keyword/off，默认 vector）

## A2. 孤儿数据清理链（用户提出的同步清理需求）
- [ ] A2.1. 会话删除 → RAG 向量清理（DeleteVectorsByConversation）
- [ ] A2.2. 文件删除 → 关联会话删除 → 会话 RAG 清理
- [ ] A2.3. 空间删除 → 文件删除 → 会话删除 → 会话 RAG 清理
- [ ] A2.4. 存储清理面板批量删会话 → RAG 同步清理
- [ ] A2.5. 定时任务：扫描孤儿 RAG 向量（conversation_id 不存在
      于 ai_conversations 表的）并清理
- [ ] A2.6. 搜索索引清理：RemoveConversation（Meilisearch/PG）

## B. 助手会话切换（持续排查）
- [ ] B1. 验证最新代码是否修复（用户确认或提供控制台日志）
- [ ] B2. 如仍失败：全面重构为编辑页 AIEditChat 代码（用户建议的方案）

## C. Word/Office 格式完善
- [ ] C1. Word 默认样式规范：标题层级（一/二/三级对应 16/14/12pt 加粗）、
      正文 11pt、行距 1.15、段前段后 6pt/3pt；写进提示词硬性要求
- [ ] C2. 表格样式规范：表头加粗+底纹+居中、边框完整、列宽自适应、
      单元格内边距统一；写进提示词
- [ ] C3. insert_content 工具增强：支持样式参数（fontSize/fontWeight/
      alignment）；或新增 format_paragraph 工具
- [ ] C4. PPT/Excel 同样补默认格式规范

## D. 选区上下文（所有编辑器类型）
- [ ] D1. 编辑器 getTarget 返回当前选中元素 ID（drawio/白板）
- [ ] D2. 富文本 getTarget 返回选中块类型和内容
- [ ] D3. Word get_selection 已有；确认 Excel/PPT 是否有对应工具
- [ ] D4. AI 系统提示注入当前选区信息（AI 知道用户选了什么）

## E. 工具调用稳定性
- [ ] E1. df_search 在编辑页上下文中误调：编辑页 system 提示更明确
      禁止 df_* 工具（加粗警告）
- [ ] E2. read_scene 中途不可用（工具集丢失）：检查工具集传递链路
      （agentTools ref 是否被 GC 或重置）
- [ ] E3. "empty message content" 错误：deep_search 子代理返回空时
      的处理优化

## F. 体验细节
- [ ] F1. 编辑页空态提示文案去掉「计划模式」（已做，验证）
- [ ] F2. Office AI 面板宽度自适应（当前固定 100%，可能太宽/太窄）
- [ ] F3. 存储清理面板扫描速度优化（异步/分页加载）
- [ ] F4. 版本历史默认保留数从 30 调回合理值（用户确认具体数字）

## 阶段一：提取共享 UI 组件（从 AIEditChat 提取到 aichat/）

## 阶段一：提取共享 UI 组件（从 AIEditChat 提取到 aichat/）
- [x] S1. ChatHeader：头部按钮组（会话管理 ConvoPicker/导入导出/多选/悬浮切换/关闭）
- [x] S2. ChatThread：消息流渲染（气泡+TraceView+操作行+空态提示）
- [x] S3. ChatInput：输入区（工具栏+技能包+开关组+发送/停止+引用文件chips）
- [x] S4. ChatModes：模式段（已并入 AIChatShell）
- [x] S5. ChatSessions：会话管理 hook（后经评审删除——各宿主保留自有会话
      逻辑更贴合业务，未采用的抽象属死代码，S14 已清理）

## 阶段二：AIChatShell 组装
- [x] S6. AIChatShell：壳组件，组合 S1-S3 + 模式段 + 悬浮窗/批量条；
      hostType 区分场景（assistant 自动加 in-drawer 形态类）

## 阶段三：三处宿主迁移
- [x] S7. AIEditChat → AIChatShell（editor 模式，-469 行）
- [x] S8. AIAssistant → AIChatShell（Drawer 仅作容器，in-drawer 形态；
      人设/工作目录/记忆经 belowHeaderSlot，图钉经 extraHeaderSlot，
      联网/RAG/思考/MCP/文件工具经 togglesSlot，文件检索+引用经
      extraToolbarSlot；2678→2449 行）
- [x] S9. ViewerAIWidget → ChatThread + ChatInput（悬浮卡保留自有头部与
      摘要页签；「保存为新版本」经 ChatThread actionSlot 注入；
      按用户决定无会话管理）

## 阶段四：功能对齐
- [x] S10. 助手获得：批量多选 / 保存会话到平台文件 / 会话 JSON 导入导出 /
      用量可见（ChatThread usageAI 行）——随 S8 完成
- [x] S11. 查看页获得：消息操作（复制/删除/重新生成）——随 S9 完成
      （会话管理按用户决定不做；v7.6 起悬浮卡亦有回底按钮）
- [x] S12. 三处统一：谨慎模式（仅 editor 显示按钮 showCautious）/
      模式段（v7.6 收敛为 ChatHeader 标题后单按钮，hover 说明）/
      ChatThread 内容统一 AIMarkdown 渲染（修复 S7 纯文本回退）
- [x] S13. OnlyOffice 插件面板对齐（v7.6 / ?v=16）：模式单按钮、气泡下方
      复制、回复底部用量行、移除流式 TOOL_CALL 原始行、回底按钮、
      工具卡运行中直显入参（完整 React 编译复用受 DS 沙箱 ES5 限制，
      按交互范式手工对齐）

## 阶段五：收尾
- [x] S14. 死代码清理：useChatSessions.ts 删除；AIMessageList 的
      Bubble.List 消息流删除（保留 Thinking/ToolChain/WebSources）；
      AIAssistant 兼容 re-export 删除；styles.css 45+ 死规则块删除
- [x] S15. E2E 测试：17/17 通过（干净库；AI UI 无 E2E 覆盖，经浏览器冒烟）
- [x] S16. docs/ai-editing.md 更新为统一架构描述

## v7.6 增量（用户反馈七项）
- [x] 1. AI 助理历史会话切换防御修复（ref/state 回落 + 激活点击=刷新）；
      浏览器实测切换正常（会话一⇄会话二⇄UI 会话）
- [x] 2. 模式单按钮入头部（hover 说明 = 原 modeTip；编辑页/助手/插件统一）
- [x] 3. 悬浮窗：拖动修复（根因 = S7 后 onHeadPointerDown 未挂载）+
      右下角缩放 + 位置尺寸记忆（Shell 内聚）+ AI 助理窗口化；
      文案「窗口显示/侧边面板显示」；实测拖动/缩放/持久化
- [x] 4. 用户消息复制按钮移到气泡下方（实测 opsTop > bubbleBottom）
- [x] 5. TraceView：运行中自动展开当前阶段（思考贴底跟随/工具直显入参）、
      完成收起、去原始行、头部只留秒数、tokens+整体耗时移到回复底部
- [x] 6. 回到底部悬浮按钮（三宿主 + 插件；实测显隐与点击回底）
- [x] 7. 插件 UI 对齐（见 S13）

## v7.7 增量（用户反馈九项，24ddacb）
- [x] 1. 悬浮窗背景透明：floating 态自带实体外观 + in-drawer 类悬浮不附加
- [x] 2. 会话历史点击无效（助助理+编辑页）：ConvoPicker 弃用
      @ant-design/x Conversations 改自绘列表（确定性点击）；switch 目标
      查找回落 state + 诊断日志。多环境（dev/生产构建/新旧会话）复测切换
      均正常，未能在本地复现用户现象——以组件替换根除疑点；另发现
      PWA 旧 Service Worker 可能短暂供旧 chunk（部署后建议硬刷新一次）
- [x] 3. AI 助理移除「固定」图钉
- [x] 4. 模式开关 → 智能/对话 双段胶囊（平台+插件）；标题 max-width 40%
- [x] 5. 工具循环叙述拼接：首个 tool 事件起分相（prologue 弱化展示 +
      最终回答独立；服务端 openai/anthropic 循环每轮文本并流是根因）
- [x] 6. 输入框顶部间距：componentSize=small textarea 竖直 padding=0，
      统一补 8/10/2（三宿主一致）
- [x] 7. 白板误调 df_*：系统提示显式声明 + 未知工具反馈 df_* 专项提示
      （400 循环需真实模型复现取响应体）
- [x] 8. 谨慎模式对话内确认卡（[确认执行/跳过]），替代系统 Modal；
      停止/切会话/卸载自动解除
- [x] 9. 白板连线：绑定引用宽限归一（4 种写法）；端点按骨架引用自算 +
      显式补齐双向绑定；新增 connect {fromId,toId,label?} 直连工具；
      insert_elements 支持 at:{x,y} 锚点；重构规范=删旧箭头再 connect

## v7.8 增量（用户反馈七项，e50cc32）
- [x] 1. draw.io MCP 提示移到标题后
- [x] 2. 四编辑页接入版本历史（VersionHistoryModal 复用：回滚/对比/上传
      新版本；回滚后重载内容与编辑器）
- [x] 3+4. 生成质量根因（据生产 ai_conversation_events trace 复盘）：
      富文本 focus()+链式 insertContentAt 时序性整文替换 → 去 focus()；
      read_document 静默截断 + TOOL_RESULT 3000 字上限 → 模型误判丢失、
      盲目重写抹掉内嵌块（用户所见"加了又去掉"的真相）→ 截断标记 +
      上限 15000；子代理 df_* 幻觉加固；图表指南移植
      coleam00/excalidraw-diagram-skill 方法论（视觉模式/形状语义/容器
      纪律/分节构建/自检），内置图表架构师技能包同步强化
- [x] 5. 插件 v7.7（?v=18）：初始化失败自动重试 + 可操作提示；
      "UI 未变"多为已打开 DS 会话持有旧 iframe（重开文档即新）
- [x] 6. 富文本编辑器去类型大标题（直接文件名，单行）
- [x] 7. 富文本宿主规范补强（rewrite 前必读/占位行逐字/插入后勿重写）

## v7.9 增量（对话内上传附件，04e7d34）
- [x] 隐藏附件空间「AI 对话附件」（spaces.hidden，migration 055）：不入
      文件管理/空间切换器；上传复用 /uploads 管线（parent=空间根）
- [x] GET /ai/attachment-space 确保空间（openapi 已同步）
- [x] 生命周期：chip 移除即删文件；会话删除联动清理 files[].upload=true
      （事件回放收集；user 回合 files 随事件持久化）
- [x] 图片两级：vision 模型原生多模态（openai image_url dataURL /
      anthropic base64 source，≤8 张）；非 vision 走 ai.ocr 转文字
- [x] 浏览器全链路实测 + E2E 17/17 + 生产 migration 055 已应用

## v7.10 增量（用户反馈八项，a13c1d2）
- [x] 1. AI 助手「切换无效」根因（生产库副本+重置管理员复现）：两个助手
      会话为空壳（0 事件，历史部署窗口写入失败）→ 点谁都是欢迎页。
      修复：载入时自动清理空壳 + 解锁本机历史迁移
- [x] 2. drawio 头部：MCP/Ctrl+S 两提示紧跟文件名居左，按钮右移
- [x] 3. AgentLoop 诊断日志 → console.debug（生产不刷屏）
- [x] 4. 工具状态红点 → 彩色文字标签（成功/失败/执行中…）
- [x] 5. drawio「确认后元素丢失又回来」根因（trace 实锤）：apply 后
      export 回执未等（读到旧 XML）+ 文件内容压缩 mxfile 不可解析 →
      apply 异步化等回执 + init 规范化导出
- [x] 6. 版本历史：批量删除 + 保留上限 5→30 + 合并语义说明（非 git）
- [x] 7. 用户气泡复制 → 气泡内左下角
- [x] 8. Office 插件 v8（?v=19）SPA 桥接统一：插件壳 iframe → /office-ai
      路由（同一套 AIEditChat/AIChatShell 全量复用），plugin.js 仅留 DS
      运行时 + oa:* postMessage 桥（1785→1102 行）

## v7.12 增量（用户反馈六项，bb71a8c）
- [x] 1. 文件页切目录闪烁：骨架只在无内容时显示；有内容时旧列表半透明
      + 顶部细进度条（消除 table 上方闪现多行骨架）
- [x] 2. 过程显示红点根修：drawio 压缩形态（mxfile>diagram>base64-deflate）
      规范化（fflate inflate）+ 明文嵌套解包——read_diagram/list_cells 不再
      missing mxGraphModel/root；工具状态文字标签（成功/失败/执行中）
- [x] 3. AI 输出语言跟随页面语言（编辑 Agent system + 助手 system 前置约束）
- [x] 4. 过程块展开/收起/阶段体动画（fadeSlide 0.16-0.18s）
- [x] 5. AI 助手过程显示统一：ChatThread synthStages（prologue→note/
      thinking→think/toolCalls→tool）→ 与编辑宿主同一 TraceView；
      平铺工具链与独立思考框移除
- [x] 6. Skill 自检循环：图表架构师/文档审校内置包 + drawio/白板/富文本
      宿主规范（改动后必须重读验证，全部通过才 FINAL）+ 文档格式守门

环境事件：D 盘满（301G/301G）→ WSL 挂载失败（错误码 6）→ WSLService
死锁 → 清理 19GB（npm/JetBrains 索引/.zcode/pnpm）+ 重启电脑恢复。

## v7.14 全量交付状态（5f54fb9）
- [x] E2E 17/17 · Go 全模块 28 包 ok / 0 FAIL · gofmt 清洁 · git 树干净
- [x] 全栈 9 容器 healthy · 生产 bundle 确认含新功能代码

### 已交付（近期全部反馈项）
- ✅ AI API 重试（5xx/网络退避 ≤2 次）
- ✅ Agent 中断恢复（stopped→继续按钮）
- ✅ 助手完整过程 trace（构建→持久化→重载/切换可见）
- ✅ 助手/编辑页/查看页过程显示统一（TraceView 同构）
- ✅ 白板连线边框连接（非正中央）
- ✅ 编辑用户：昵称预填充 + 用户组多选
- ✅ 分享页零嵌套（直接内容+悬浮下载）
- ✅ 空间卡片名截断 + 「默认」badge
- ✅ 存储清理面板（设置→存储清理）
- ✅ 回收站选择行合并入工具栏
- ✅ 文件列表加载动画（行级淡入淡出，零重挂，恒定等高）
- ✅ 工具标签动词化中文
- ✅ AI 叙述按时间序交织
- ✅ OnlyOffice 插件 SPA 桥接（/office-ai 统一）
- ✅ 版本历史批量删除 + 保留 30 版
- ✅ AI 对话上传附件（隐藏空间+随会话删除+原生多模态）
- ✅ 网页目录/zip 标记与打开修复
- ✅ 公开分享无水印 + 默认仅查看
- ✅ Ctrl+点击新标签页打开

### 设计定稿待实施 → 已全部实施（v7.14d）
- ✅ 配额转让：架构确认（空间配额跟空间走，隐藏空间=用户自有）
- ✅ AI 附件配额：隐藏空间已按用户隔离，独立配额，不占他人空间
- ✅ 思考等级 Dropdown UI：Gauge 图标（快速/标准/深度），localStorage
- ✅ 上下文大小：max_tokens 已在管理端 AI 设置面板
- ✅ Token 优化：窗口 60→40 + TOOL_RESULT 截短 300 + 上限 8000
- ✅ 大文件扫描（>100MB·90天）已入清理面板

## 遗留观察项
- 「未知工具」偶发：诊断日志已部署（5a5f978 + AgentLoop 启动日志），
  等真实复现时取控制台输出
- 白板 /ai/chat 400 循环：提示词加固已上；若复现取 400 响应体定位
- E2E 前若共用 e2e 库做过 AI 冒烟，须重置库（ai.enabled=true 会让上传
  触发 mock 摘要集成导致轮询用例失败——环境问题非代码缺陷，已实测确认）

## 已知问题（需用户配合排查）
- "未知工具"偶发：已在 5a5f978 加诊断日志，等复现时看控制台输出
- px → rem 全局转换：建议单独立项（antd 全量 px 基准，混用会不一致）

## 技术决策记录
- 计划模式已从 UI 移除（保留逻辑，AI 在可修改模式中自行先读后改）
- 谨慎模式默认开、可关（localStorage 记忆）；按钮仅 editor 宿主显示
- 会话事件溯源（migration 054）——助手/编辑页共用；查看页按用户决定无会话
- 技能包默认 auto（按 applyKind 自动选内置包），用户可手动切换
- S8 关键接线：onSaveConversation(ids?) 批量保存传所选；emptySlot/
  belowHeaderSlot/showFloat/showCautious 为 Shell 扩展 props
