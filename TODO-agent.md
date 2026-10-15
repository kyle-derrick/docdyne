# TODO — v7.15 待完成全部项

> 用户确认后开始动工，全部自行完成，不遗漏。

## A. 上下文管理（RAG + AI 摘要 + 工具式记忆）
- [x] A1. AI 摘要压缩（44fd775：结构化摘要——程序化提取被丢弃消息中的
      工具调用/用户意图，替代「已压缩」占位；见 chat.go compressConvo）
- [x] A2. 结构化轮次日志（v7.15：前端 agentConvoView 压缩时对被丢弃段
      程序化提取「工具名(关键参数)→✓/✗」+用户意图行生成结构化摘要，
      超预算丢最旧并注明；trace 侧工具条目既有 turns.ts 渲染覆盖；
      纯函数抽至 frontend/src/ai/convoView.ts）
- [x] A3. df_search_history 工具（44fd775：会话历史检索——ILIKE 关键词，
      含被压缩的早期内容；平台工具 6 件套，测试同步）
- [x] A4. 后端压缩事件推送前端（44fd775：SSE tool 事件 context_compress
      输出「N 条 → M 条」；v7.15 收尾——turns.ts 标签映射补
      「上下文自动压缩/检索会话历史」，系统事件 server=system 按名直查）
- [x] A5. 分层上下文验证（v7.15：frontend/scripts/verify-convo-view.mjs
      ——110 轮合成会话断言视图有界/分层/不改写原文；肥结果场景压缩后
      <20% 全量 token；`node scripts/verify-convo-view.mjs`）
- [x] A6. 会话历史索引写入（v7.15：migration 057 ai_conversation_msgs
      消息行表 + pg_trgm GIN；AppendAIConvoEvent 同步维护 turn 追加/
      snapshot 重建，检索跨会话全 source 含被压缩早期内容；存量事件
      重放回填；实测 turn/snapshot/删除级联/通配符字面匹配全过）
- [x] A7. 工具式记忆（v7.15：df_read_memory/df_write_memory 平台工具，
      include_memory 开启即注入且独立于文件栈；system 仅注入标题列表
      （20 条 ×48 字符 ≈200tok）+ 工具用法提示；写走 CreateAutoAIMemory
      + 裁剪；ai_memory_auto 自动提取等既有链路不变）
- [x] A8. 管理端配置（v7.15：ai.history_search 键 keyword/off 默认
      keyword——A6 选了 PG 全文路线，vector 值位预留未启用（会话消息
      按轮 embedding 的成本/链路另行评估）；AISettingsPanel 增「对话
      历史检索」卡片；off 时 df_search_history 声明剔除）

## A2. 孤儿数据清理链（用户提出的同步清理需求）
- [x] A2.1. 会话删除 → RAG 向量清理（v7.15：会话向量化整体 defer——
      minimal 部署无 Qdrant、会话 collection 从未建过，无向量可清；
      待 A6 预留的 vector 路线启用时同步补 DeleteVectorsByConversation）
- [x] A2.2. 文件删除 → 关联会话删除（v7.15：migration 058
      ai_conversations.file_id FK → files(id) ON DELETE CASCADE；
      软删（回收站）不触发、恢复后会话可用，彻底删除（HTTP purge /
      管理端 PurgeSpace / janitor sweepTrash 三路）级联清理会话与消息
      索引行——真库实测软删保留/硬删级联双场景通过）
- [x] A2.3. 空间删除 → 文件删除 → 会话删除（v7.15：随 A2.2 覆盖——
      PurgeSpace 同经 gormTrashRepo.DeleteFiles 硬删 files 行触发级联）
- [x] A2.4. 存储清理面板批量删会话 → 同步清理（v7.15：批量删走
      DeleteAIConversation 删会话行，057 的消息索引 FK CASCADE 随之
      清理；RAG 向量见 A2.1 defer 说明）
- [x] A2.5. 定时扫描孤儿（v7.15：结构性消除——ai_conversation_msgs
      FK CASCADE 到会话、ai_conversations.file_id FK CASCADE 到文件、
      user_id FK CASCADE 到用户，孤儿行在约束层不可能存在；
      058 迁移内先清存量孤儿再上约束）
- [x] A2.6. 搜索索引清理：RemoveConversation（v7.15：会话检索索引即
      057 消息行表，随会话 FK CASCADE；Meilisearch 仅索引文件无会话
      条目，无需 RemoveConversation）

## B. 助手会话切换（持续排查）
- [x] B1. 验证最新代码是否修复（v7.15 复盘修复 2026-10-15：代码级审计定位
      三处真实缺陷并修复——① 同步防抖定时器触发时才读 convoIdRef.current，
      切换竞态下旧会话未同步增量写进新会话（跨会话串台）：新增 turnsConvoIdRef
      归属 ref + 切换前 flushPendingDelta 尾包落库 + 拉取窗口清空视图；
      ② 「问 AI」入口只清视图不解除归属，收缩分支把活动会话历史快照覆盖成
      单条提问；③ 编辑页 AIEditChat 同源竞态：fetch 切换不清 turns（abort
      落空回调以新会话 id 落笔→整删新会话）+ await 期间写回 clobber
      syncedLen + create 期间切换被劫持激活指针。三处均有归属守卫）
- [x] B2. 如仍失败：全面重构为编辑页 AIEditChat 代码（不再需要——B1 根因
      修复覆盖失败类别，且两处实现已收敛同一同步纪律：切换=flush+易主+清
      syncedLen，异步写回=归属守卫；重构为单实现属更大风险无增量收益）

## C. Word/Office 格式完善
- [x] C1. Word 默认样式规范（83a6432：TOOL_DOCS 硬性要求——标题层级/
      行距 1.15/段间距；insert 走 Heading 样式而非裸字号）
- [x] C2. 表格样式规范（83a6432：write_table 表头加粗+底纹+居中+自适应）
- [x] C3. 格式工具（83a6432：format_element——bold/italic/underline/
      fontSize/fontColor/highlight 递归段落内 text run；set_paragraph_style
      ——Heading/Quote 样式+对齐；等价 format_paragraph）
- [x] C4. PPT/Excel 默认格式规范（83a6432：Excel 全 1 基+write_table，
      PPT 版式/字号/占位约定）

## D. 选区上下文（所有编辑器类型）
- [x] D1. 编辑器 getTarget 返回当前选中元素 ID（drawio/白板）
      - drawio：官方 embed 协议**无** select 事件（对 vendored 27.0.9 app.min.js
        全量 grep 实证）→ 自建插件链路：frontend/docker/drawio/plugins/
        docflow-selection.js（Draw.loadPlugin + mxEvent.CHANGE → postMessage
        select）+ Dockerfile 给 PreConfig.js 追加 ALLOW_CUSTOM_PLUGINS=true
        + DrawioPage 同源写 .drawio-config 注册插件；跨源/写失败静默降级
      - 白板：handleChange 同步 selectedElementIds → aiGetTarget 选中摘要
      - 两宿主均新增 get_selection 工具（模型可随时查当前选区）
      - 附带（官方 drawio skill 方法论）：drawio 新增 auto_layout 工具
        （embed 协议 action:layout，实测存在；树/流程/力导向等 8 种），
        AI 可粗略坐标+连线后一键排版，替代手算坐标
- [x] D2. 富文本 getTarget 返回选中块类型和内容（DfdocEditorPage 既有实现：
      tiptap 选区 → docToAIText，markdown 结构标记即块类型；D4 后进 system）
- [x] D3. Word get_selection 已有；Excel/PPT 补齐（插件 v21：get_selection
      统一入口按 kind 分支——cell=Api.GetSelection().GetAddress()+值预览，
      slide=GetCurrentSlide 页序号；TOOL_DOCS 同步，toolsForKind 自动下发）
- [x] D4. AIEditChat.sendAgent 注入【用户当前选区】块进 system（截 2000 字；
      此前仅显示「选区 N 字」徽标，模型不可见——参照 OpenCode 的
      selection → system-reminder 注入模式）

## E. 工具调用稳定性
- [x] E1. df_search 编辑页误调（44fd775：【硬性禁止】段落 + deep_search≠
      df_search 澄清 + 未知工具反馈 df_* 专项提示）
- [x] E2. read_scene 中途不可用（工具集丢失）：检查工具集传递链路
      （agentTools ref 是否被 GC 或重置）（v7.15 复核：链路无丢失路径——
      agentToolsRef 为 useRef 且每渲染同步 current（组件存活期内 ref
      恒可达，无 GC/重置代码路径）；runAgentLoop 的 tools 是调用时传入的
      本地快照（执行期间锁定 package，中途切包不影响当轮循环）；未知工具
      反馈含完整可用列表 + 近名建议 + 技能包/宿主工具计数诊断 + console
      级现场记录，模型可即时自纠。原始症状更可能是 E1 的 df_* 误调幻觉）
- [x] E3. "empty message content" 错误：deep_search 子代理返回空时
      的处理优化（92ac92d + v7.15 复核：入口拦截——goal 为空不再发起
      请求；FINAL 空文本不再当成功，按错误回喂重试，两条路径均不再
      产生空 user 消息触发后端 400）

## F. 体验细节
- [x] F1. 编辑页空态提示文案去掉「计划模式」（v7.15 复核：AIEditChat
      emptyHint 为「描述要做的修改——AI 会先读文档再逐步编辑并校验」，
      无「计划模式」字样；剩余出现处均为模式切换提示或代码注释，非空态）
- [x] F2. Office AI 面板宽度自适应（v7.15：office-ai-root 下 ≥640px
      正文/输入列封顶 720px 居中（超宽行长可读性），≤380px 收紧留白；
      面板本体 width:100% 随 DS 拖拽自适应不变）
- [x] F3. 存储清理面板扫描速度优化（v7.15：隔离区面板增量分页——首批
      100 条，满额「加载更多」每轮 +200（服务端 status 索引 + LATERAL
      LIMIT 本就有界，补齐 UI 侧异步分页与加载态））
- [x] F4. 版本历史默认保留数（用户定夺 2026-10-15：全量保留，除非用户
      自己手动删除或清理）：默认 0 = 不限——env MAX_VERSIONS_PER_FILE
      默认 0（校验 ≥0）、settings upload.max_versions_per_file 默认 0
      （min 0）、defaultMaxVersions 0、pruneVersionsLogic keep<=0 直接
      跳过裁剪（语义反转：原 keep<=0 会裁到仅剩 current+时间窗）；
      手动删除能力既有（DELETE /files/:id/versions/:versionId + 回收站/
      清理面板）；测试钉死新语义（maxversions_test 重写 + 新增
      KeepZeroKeepsAll/EffectiveMaxVersionsZeroMeansUnlimited）

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

## G. Agent 可观测性（调试与质量保障）
- [x] G1. Agent 执行日志（v7.15：既有三路结构化日志打通管理端查询——
      ai.chat 审计记每请求（模型/流式/开关）、ai.tool 审计记每次工具
      （工具名/参数摘要/状态/耗时）、ai_usage 每模型调用一行（provider/
      model/tokens/ms + 059 会话/类型维度）；完整输入输出在会话事件
      （本人可见）——管理端审计页可按 action 过滤查询）
- [x] G2. Token 用量追踪（v7.15：migration 059 ai_usage 增 conversation_id
      + kind(chat/agent/summary/ocr)；/ai/chat 请求携带会话 id（前端
      ensureConversation 发送前建会话，首轮即可关联）；GET /admin/ai/usage?
      by=conversation 按会话聚合（JOIN 属主校验防伪造，真库验证通过）；
      管理端用量卡三维度切换：用户/会话/工具）
- [x] G3. 工具调用成功率指标（v7.15：GET /admin/ai/tool-stats 聚合
      ai.tool 审计——调用量/成功率/平均与最大耗时/最近使用；统计窗受
      审计保留期约束；SQL 真库验证通过；用量卡「按工具」维度）
- [x] G4. Agent 进度指示（v7.15：TraceView 头部运行中实时「第 N 轮 ·
      累计 tok · 用时」（runAgentLoop 逐轮写回 usage）；不伪造总轮次
      进度条——MAX_ROUNDS=300 是安全上限非预估，诚实展示已进行量）
      （编辑页 trace 头部已有步数，助手也需要）

## H. Agent 健壮性
- [x] H1. 优雅降级：AI Provider 不可用时显示友好提示（非报错）；
      已有请求的可查看已有内容（v7.15 H1：aichat/errors.ts aiFriendlyError
      按 code 映射中英文案——AI_NOT_CONFIGURED/AI_PROVIDER_NOT_FOUND/
      AI_MODEL_NOT_ALLOWED/AI_UPSTREAM，助手/编辑面板/Viewer 三入口接入；
      未命中 code 保留原始 message，历史会话内容不受影响照常查看）
- [x] H2. 备选模型：首选模型失败时自动切换到备选模型（管理端可配置
      fallback 模型列表）（v7.15 H2：ai.fallback_models 键，≤5 条有序
      AIModelRef；Chat 拆 chatOnce + fallback 链——仅普通对话（无工具）
      上游失败且零增量时切换，防工具写重放；成功附 fallback_from 随
      done/JSON 下发，前端 note/trace 提示「已切换备用」；管理端多选
      下拉配置，validateFallbackModels 校验，openapi 同步）
- [x] H3. 速率限制感知：接近配额时提前预警（非到限后报错）（v7.15 H3：
      dynamicRateLimiter.DailyUsed 只读探测，Provider daily_quota 已用
      （含本次）≥80% 时 c.Set 预警，随 meta 事件/JSON quota_warning 下发；
      助手 trace note / 编辑面板 note 展示，明示 UTC 重置时间）
- [x] H4. 工具执行超时：每个工具设独立超时（读工具 30s/写工具 60s），
      超时后标记失败并继续（非阻塞整个循环）（v7.15 H4：execToolWithTimeout
      goroutine+timer+ctx.Done 护栏——读 30s/写 60s、panic 恢复、用户
      取消立即返回；写类超时文案注明「可能已执行，用读工具校验」，
      超时错误文本回喂模型循环继续；MCP 工具本有 8s RequestTimeout 不变）

## I. 技能包生态
- [x] I1. 技能包版本号与变更日志（v7.15 I1：AIAgentPackageDef 增
      version/changelog 字段（≤50 条、note ≤500、date YYYY-MM-DD 真实
      日历校验）；管理端编辑弹窗版本号+变更日志行编辑；编辑页下拉
      label 显示 vN）
- [x] I2. 技能包导出为 YAML/JSON（可分享/导入）（v7.15 I2：管理端
      GET export?format=json|yaml&scope=platform|builtin|all（yaml 经
      JSON roundtrip 保持 snake_case 键名——直接 yaml.Marshal 会漂移成
      小写字段名）+ POST import {format,content,mode=upsert|replace}
      （builtin- 拒收、按 id 合并/整替、≤256KB）；AISettingsPanel 导出
      下拉/导入弹窗；契约 /admin/settings/ai/agent-packages* 四端点）
- [x] I3. 内置技能包定期优化（基于实际使用数据反馈）（v7.15 I3：/ai/chat
      增 agent_package 请求字段→ai.chat 审计 metadata.package；audit
      PackageStats（按包分组：对话量/成败/去重用户/最近使用）+
      GET /admin/ai/package-stats；技能包列表卡片展示使用次数/人数/最近
      使用——管理端据此决定优化哪个内置包）

## J. 安全加固
- [x] J1. 工具沙箱：限制文件访问路径（仅工作目录内）；写操作大小限制
      （v7.15 J1 复核钉死：结构性沙箱已成立——walk 仅自工作目录下潜
      （FindChildByName 精确名匹配，无向上遍历）、NormalizeName 尾点规则
      天然拒绝 `.`/`..` 段、写内容 ≤2MB（既有）；新增
      TestPlatformToolSandboxPaths 钉死六类逃逸路径 + 前导斜杠相对化语义，
      防回归）
- [x] J2. 提示注入防护：用户输入中的 markdown/XML 标记转义后再注入
      系统提示（防止用户输入覆盖 AI 指令）（v7.15 J2：internal/ai/
      UntrustedBlock 不可信数据围栏——⟦⟧ 数学白方括号边界 + 固定告示
      「数据而非指令」+ 内容中围栏字符中和（边界不可伪造）；五处注入点
      全覆盖：web 搜索块/RAG 参考资料/我的文件片段/附件全文/记忆标题）
- [x] J3. 审计增强：AI 执行的每个写操作记录审计日志（谁/何时/改了什么/结果）
      （v7.15 J3：ai.tool 审计 metadata 增强——失败附 error 原文，
      df_write_file 附 file_id/created（新建 vs 覆盖），df_write_memory
      附 memory_id；谁=user_id、何时=created_at 既有）

## K. 库封装与复用（所有功能完成并稳定后）
> 2026-10-15 K 批次审计结论（K2 已落地；K1/K3/K5-K10 暂缓——前置为域模型
> 分层重构）：逐包 grep 非测试依赖图，Go 侧候选（K1 agent / K3 tools /
> K5 upload / K6 mcp / K7 search / K8 webpkg / K9 office / K10 versioning）
> **无一干净**——全部依赖 `internal/files` 域模型（FileItem/Store/路径解析
> 与 ACL 联动），机械搬目录到 pkg/ 只会造出反向 import internal/ 的伪独立
> module。前置路径：先把 files 域模型（实体+存储接口）下沉为 internal/
> core（或 domain）层、业务模块依赖倒置到接口，此后逐包提取才是真独立
> module——属多会话架构工程，非本批次可收口；审计依赖图已存档于本节各条
> 附注，供后续开工直接使用。
- [ ] K1. Go Agent 库（pkg/agent）：工具循环+上下文压缩+子代理+
      熔断器+重试 → 独立 Go module（docflow.ai/agent）
      【暂缓：internal/ai 的 agent 循环依赖 internal/files（写工具落盘）
      与 internal/acl；前置=域模型分层（见批次审计结论）】
- [x] K2. React Chat UI 库（@docflow/chat）：npm workspace 真提取
      （2026-10-15）——`frontend/packages/chat/`（源码分发：exports →
      src/index.ts，Vite/tsc bundler 解析直消 TS 源；peerDeps=react/antd/
      lucide/@ant-design/x/react-markdown 系/katex 随宿主版本）。依赖
      倒置：AIAttachTree/AIMarkdown 的 listFiles/listSpaces/listSpaceFiles/
      uploadFile/FileBrowser.Modal 经 registerChatFileApi 注册表注入
      （组合根 main.tsx，UploadPhase 回调差异 lambda 适配）；errors.ts 去
      ApiError instanceof/i18n 依赖（.code 鸭子判定+同文回落文案）；
      AISource/AIUsage/AIToolCall/AIToolResult 迁包内 types.ts、api.ts
      re-export 保持兼容。应用侧 5 文件导入改 '@docflow/chat'，tsc+build
      全绿。CSS 暂留宿主 styles.css（~340 行 ai-* 规则含复合选择器非干净
      可切割，随包导入链全局生效）；独立 CSS 主题变量=发布前置，连同
      token 化与产物构建记于 packages/chat/README.md「样式契约」
- [ ] K3. 平台工具 SDK（@docflow/tools）：df_* 工具定义/执行框架 →
      允许第三方注册自定义工具（插件化）
      【暂缓：df_* 工具执行体直接调 internal/files Store；前置同上】
- [x] K4. 技能包格式规范：JSON Schema + 版本化 + 可分享格式（v7.15：
      版本化=version/changelog（I1）、可分享格式=JSON/YAML 导入导出（I2，
      键名 snake_case 契约经 roundtrip 钉死）；JSON Schema 落地
      docs/schema/agent-packages.schema.json——draft 2020-12，envelope/
      裸数组双形态、约束与 ValidateAIAgentPackages 逐条对应、builtin-
      前缀拒收与 applyKind 枚举在 schema 层可校验，正反样例验证通过）
- [ ] K5. Go Upload 库（pkg/upload）：断点续传+分片+病毒扫描+
      多存储(local/S3/MinIO) → 独立库（docflow.ai/upload，
      4123 行，接口已抽象良好）【暂缓：上传落盘路径依赖 internal/files
      建文件行/配额扣减；前置同上】
- [ ] K6. Go MCP 框架（pkg/mcp）：MCP Server 构建框架——工具注册/
      资源暴露/PAT 鉴权/作用域 → docflow.ai/mcp（2293 行，
      通用 MCP 服务端构建）【暂缓：df_* 工具处理器依赖 internal/files
      与 internal/acl；前置同上】
- [ ] K7. Go Search 抽象（pkg/search）：多后端搜索——Meilisearch/
      PostgreSQL tsvector/Qdrant 向量 → 统一接口
      docflow.ai/search（1537 行）【暂缓：索引管道读 internal/files
      模型触发增量；前置同上】
- [ ] K8. Go WebPKG 库（pkg/webpkg）：静态网站 zip 上传+解包+
      HMAC 鉴权访问 → docflow.ai/webpkg（1939 行，独特功能）
      【暂缓：解包产物以 internal/files 文件行落库；前置同上】
- [ ] K9. Go OnlyOffice 集成库（pkg/office）：OO 配置生成/回调处理/
      JWT/版本管理 → docflow.ai/office（2580 行）【暂缓：回调落
      internal/files 版本链；前置同上】
- [ ] K10. Go 文件版本库（pkg/versioning）：版本链+自动保留策略+
      回滚 → docflow.ai/versioning（从 files/ 提取）【暂缓：版本链
      与 files 域模型同表同事务；F4 已定全量保留默认（keep<=0 跳过
      裁剪），独立化收益待域模型分层后再评估】

## L. 参考项目复盘产出（2026-10-15，经 20170 代理拉源码实证：drawio-mcp
## 官方 / excalidraw-diagram-skill / opencode / pi-mono / cherry-studio）
- [x] L1. drawio search_shapes 工具（DRAWIO_SHAPE_LIBRARY 18 条中英双语
      关键词→精确 style 串+建议尺寸+用途；随附修饰键表；双向子串匹配）
- [x] L2. 指南按需读取（drawio/白板 get_reference 工具——完整规范从
      agentSystemExtra 移除（原 45/50 行每轮重发），system 只留【必读】
      一句；未读先插入时结果附 note 轻推一次）
- [x] L3. 压缩溢出降级重试（agentConvoView 预算感知：估算超预算 80% 时
      尾保 20→14→10→7（≈70/50/35%）递减 + TOOL_RESULT 截断同步收紧）
- [x] L4. 超大工具结果暂存+引用（>8000 字符全量存 ref（FIFO 12 条），
      回喂只带 6000 preview + _full_ref；read_tool_output {ref,offset,limit}
      元工具分段取回——内存 Map 而非落盘文件，浏览器端更简）
- [x] L5. token 估算掺实测（/ai/status 新增 context_budget 下发（后端
      EffectiveContextBudget：模型 context_window>256K 默认）；前端
      tokRatio 按每轮真实 usage 字符/token 比 EMA 校准，夹 [1.5,8]）
- 已采纳（随 D1-D4 落地）：auto_layout 工具（官方 skill 布局优先方法论）；
  选区→system 注入（opencode selection system-reminder 模式）；
  get_selection 三编辑器统一（官方 search/reference 工具面思路）

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
