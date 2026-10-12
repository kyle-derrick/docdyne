# TODO — AI 对话统一化重构（AIChatShell）

> 核心诉求：AI 助手、编辑页 AI 对话、查看页 AI 对话使用**同一套组件**，
> 仅通过 props 区分场景差异。本轮为跨会话任务，按阶段推进。

## 阶段一：提取共享 UI 组件（从 AIEditChat 提取到 aichat/）
- [x] S1. ChatHeader：头部按钮组（会话管理 ConvoPicker/导入导出/多选/悬浮切换/关闭）
- [x] S2. ChatThread：消息流渲染（气泡+TraceView+操作行+空态提示）
- [x] S3. ChatInput：输入区（工具栏+技能包+开关组+发送/停止+引用文件chips）
- [x] S4. ChatModes：模式段（可修改/仅对话——计划已去掉）
- [x] S5. ChatSessions：会话管理 hook（CRUD/切换/新建/删除/导入导出——纯 API 调用，无 UI）

## 阶段二：AIChatShell 组装
- [x] S6. AIChatShell：壳组件，组合 S1-S5，接受场景 props：
  ```ts
  interface ChatShellProps {
    hostType: 'assistant' | 'editor' | 'viewer'
    fileId?: string              // editor/viewer 必填（会话分域键）
    agentTools?: AIEditTool[]    // editor：宿主编辑工具
    agentSystemExtra?: string    // editor：宿主规范注入
    applyKind?: AIApplyKind      // editor：标识（影响技能包过滤）
    // assistant 特有 slots：
    ragEnabled?: boolean
    memoryEnabled?: boolean
    personaSlot?: ReactNode
    workdirSlot?: ReactNode
    mcpToggle?: boolean
    // viewer 特有 slots：
    summarySlot?: ReactNode
    contextFileId?: string       // viewer：查看的文件 id（上下文注入）
  }
  ```

## 阶段三：三处宿主迁移
- [ ] S7. AIAssistant.tsx → 使用 AIChatShell（替换现有抽屉内部实现）
- [ ] S8. AIEditChat.tsx → 改为 AIChatShell 的 editor 模式薄包装
- [ ] S9. ViewerAIWidget.tsx → 使用 AIChatShell（替换现有悬浮卡内部实现）

## 阶段四：功能对齐
- [ ] S10. 助手获得：消息操作三件套（已有）/ 悬浮窗模式 / 批量多选 / 用量可见性
- [ ] S11. 查看页获得：会话管理 / 消息操作 / 悬浮窗模式
- [ ] S12. 所有三处：统一技能包选择（自动模式默认）/ 统一谨慎模式 / 统一计划逻辑（仅 editor）
- [ ] S13. OnlyOffice 插件面板（plugin.js）逐步对齐——最终目标：插件也复用同一套 UI 逻辑（受限于 DS 沙箱 ES5，可能需要构建工具编译而非直接复用）

## 阶段五：收尾
- [ ] S14. 死代码清理：删除 AIAssistant/AIEditChat/ViewerAIWidget 中被 Shell 替代的实现
- [ ] S15. E2E 测试更新
- [ ] S16. docs/ai-editing.md 更新为统一架构描述

## 已知问题（需用户配合排查）
- "未知工具"偶发：已在错误信息中附带技能包 id，下次复现时把 TraceView 错误条目内容发我
- px → rem 全局转换：建议单独立项（antd 全量 px 基准，混用会导致不一致）

## 技术决策记录
- 计划模式已从 UI 移除（保留逻辑，AI 在可修改模式中自行先读后改）
- 谨慎模式默认开、可关（localStorage 记忆）
- 会话事件溯源（migration 054）——三处共用
- 技能包默认 auto（按 applyKind 自动选内置包），用户可手动切换


## S7 迁移指南（AIEditChat → Shell，下会话执行）

**保留**（不动）：
- 全部 hooks/state/effects/callbacks（~1500 行业务逻辑）
- rename Modal + saveDialog Modal（面板外弹窗）
- panelRef/onHeadPointerDown/toggleFloatMode（悬浮窗逻辑）

**替换**：
- JSX return 块（~L1500-L2058）→ 单一 <AIChatShell {...shellProps} />
- shellProps 映射现有 state/函数到 Shell 的 ~45 个 props
- 注意：ChatThread 需要 ChatMessage[] 格式（现有 ChatTurn 兼容）
- 注意：ChatInput 的 slots 注入模型选择/开关组/技能按钮

**验证**：替换后 tsc + npm run build + 手动测试（打开编辑页 → 发消息 → 工具循环 → 悬浮窗 → 批量 → 会话切换）

## S8-S9 迁移要点
- S8 AIAssistant：最大差异（Bubble.List → ChatThread、Sender → ChatInput）；人设/工作目录/记忆经 slots 注入
- S9 ViewerAIWidget：最小改动（不加会话管理，仅换消息流+输入区渲染）
