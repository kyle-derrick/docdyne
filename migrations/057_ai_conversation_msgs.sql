-- 057: 会话消息检索索引（v7.15 A6）。
-- df_search_history 此前只扫最近 10 个 assistant 会话的 messages JSON（ILIKE
-- 全量反序列化），跨会话与被压缩的早期内容检索不到。本迁移落一张消息行表：
-- AppendAIConvoEvent 写入时同步维护（turn 追加行 / snapshot 重建），检索走
-- user_id + created_at 索引与 content 上的 pg_trgm GIN（ILIKE 子串匹配对
-- 中文有效——库内既有结论：tsvector 'simple' 对中文基本无效，见 019_search）。
-- 覆盖 assistant/editor/plugin 全部 source；会话删除经 FK CASCADE 同步清理
--（顺带满足孤儿清理链 A2.1/A2.4/A2.5 的会话索引维度——索引与事件表同为
-- derived data，随主行级联消亡，无独立孤儿态）。
CREATE TABLE IF NOT EXISTS ai_conversation_msgs (
    id              uuid        NOT NULL,
    conversation_id uuid        NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL,
    seq             bigint      NOT NULL,
    role            text        NOT NULL,
    content         text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ai_convo_msgs_scope
    ON ai_conversation_msgs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_convo_msgs_convo
    ON ai_conversation_msgs (conversation_id);

-- trigram 扩展加速 content ILIKE（postgres 官方镜像自带 contrib；重复执行
-- 幂等）。短查询（<3 字符）退化为顺序扫描，量级为单用户消息行，可接受。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_ai_convo_msgs_trgm
    ON ai_conversation_msgs USING gin (content gin_trgm_ops);

-- 存量回填：按事件重放语义（turn 拼接 / snapshot 替换）重建每会话消息行。
-- 幂等护栏：表非空即跳过（新装库本就为空；重跑不重复插入）。
DO $$
DECLARE
    cid uuid;
    final jsonb;
    ev record;
BEGIN
    IF EXISTS (SELECT 1 FROM ai_conversation_msgs LIMIT 1) THEN
        RETURN;
    END IF;
    FOR cid IN SELECT id FROM ai_conversations LOOP
        final := '[]'::jsonb;
        FOR ev IN SELECT kind, payload FROM ai_conversation_events
                  WHERE conversation_id = cid ORDER BY seq LOOP
            IF ev.kind = 'snapshot' THEN
                final := ev.payload;
            ELSE
                final := final || ev.payload;
            END IF;
        END LOOP;
        INSERT INTO ai_conversation_msgs (id, conversation_id, user_id, seq, role, content, created_at)
        SELECT gen_random_uuid(), cid, c.user_id, t.ord - 1,
               m->>'role', left(m->>'content', 8000), c.updated_at
        FROM ai_conversations c
        CROSS JOIN LATERAL jsonb_array_elements(final) WITH ORDINALITY AS t(m, ord)
        WHERE c.id = cid
          AND m->>'role' IS NOT NULL
          AND m->>'content' IS NOT NULL;
    END LOOP;
END $$;
