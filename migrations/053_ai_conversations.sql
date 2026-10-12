-- 053: AI 会话记录（ai_conversations，服务端持久化）。
-- 全局助手（file_id 为 NULL）与编辑页/Office 插件（file_id 为对应文件）
-- 的对话会话统一落库：跨设备一致、随账号生命周期（删除用户级联清理）。
-- messages 为整段 JSON 数组（前端回合结构直存，不做跨会话查询故不拆表）；
-- source: assistant=全局助手 / editor=编辑页面板 / plugin=OnlyOffice 插件。
-- 条数与大小上限由服务层校验（auth.ValidateAIConversation*）。
CREATE TABLE IF NOT EXISTS ai_conversations (
    id         uuid        NOT NULL,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id    uuid        NULL,
    source     text        NOT NULL DEFAULT 'assistant' CHECK (source IN ('assistant', 'editor', 'plugin')),
    title      text        NOT NULL DEFAULT '',
    messages   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_scope
    ON ai_conversations (user_id, source, file_id, updated_at DESC);
