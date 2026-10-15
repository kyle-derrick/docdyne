-- 059: ai_usage 会话关联与请求类型（G1/G2 可观测性）。
-- conversation_id 由前端 /ai/chat 请求携带（服务端会话持久化 id，可空——
-- 未持久化对话/摘要/OCR 不关联）；聚合查询按「会话属主 = 用量行用户」
-- JOIN ai_conversations，伪造他人会话 id 的行不进聚合（不泄露他人标题）。
-- kind 区分请求类型：chat（普通对话）/ agent（带工具循环）/ summary（摘要）
-- / ocr；缺省 chat（存量行自动归入）。

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'chat';

CREATE INDEX IF NOT EXISTS idx_ai_usage_convo ON ai_usage(conversation_id) WHERE conversation_id IS NOT NULL;
