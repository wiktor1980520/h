-- 0003_recycle_bin.sql — 回收站：软删除列
ALTER TABLE jobs ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_deleted_at ON jobs(deleted_at);