-- 058: ai_conversations.file_id 外键级联（A2.2/A2.3 孤儿会话清理链）
-- 文件彻底删除（HTTP purge / 管理端 PurgeSpace / janitor sweepTrash 三路
-- 均经 gormTrashRepo.DeleteFiles 硬删 files 行）后，关联会话与
-- ai_conversation_msgs 索引行随 FK CASCADE 一并清理；软删（回收站）不触发，
-- 恢复后会话可用。与 web_packages.file_id 同构。
-- 幂等：先清存量孤儿会话（file_id 指向已不存在的文件），再补约束（存在即跳过）。

DELETE FROM ai_conversations c
WHERE c.file_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = c.file_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_conversations_file_id_fkey'
          AND conrelid = 'ai_conversations'::regclass
    ) THEN
        ALTER TABLE ai_conversations
            ADD CONSTRAINT ai_conversations_file_id_fkey
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE;
    END IF;
END $$;
