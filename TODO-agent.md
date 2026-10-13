# TODO — AI 对话统一化重构（AIChatShell）

> 核心诉求：AI 助手、编辑页 AI 对话、查看页 AI 对话使用**同一套组件**，
> 仅通过 props 区分场景差异。本轮为跨会话任务，按阶段推进。

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
