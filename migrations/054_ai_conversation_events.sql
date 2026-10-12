-- 054: AI 会话事件溯源（pi-durable 式）——ai_conversations.messages 整存整取
-- 升级为 append-only 事件日志（ai_conversation_events），会话内容由事件重放生成。
-- kind: turn=追加回合（payload 为消息数组，按序拼接）；snapshot=全量快照
--（payload 为完整消息数组，重放时替换此前状态——支持删除/导入等重排操作，
-- 日志本身保持 append-only）。对话行维护 title/updated_at/message_count 计数。
-- 不做兼容迁移（用户授权）：messages 列直接删除，历史会话以空内容起步。
CREATE TABLE IF NOT EXISTS ai_conversation_events (
    id              uuid        NOT NULL,
    conversation_id uuid        NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    seq             bigint      NOT NULL,
    kind            text        NOT NULL CHECK (kind IN ('turn', 'snapshot')),
    payload         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_convo_events_seq
    ON ai_conversation_events (conversation_id, seq);

ALTER TABLE ai_conversations DROP COLUMN IF EXISTS messages;
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;
