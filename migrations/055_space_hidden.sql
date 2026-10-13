-- 055：空间隐藏标记（AI 对话附件空间）。
-- hidden=true 的空间为系统管理空间（如每用户一个的「AI 对话附件」），
-- 不出现在用户可见空间列表/切换器（/spaces 与文件页空间下拉）；
-- 管理端空间列表（admin）不受过滤。幂等：重复执行无副作用。
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
