-- 0001_init.sql — huangtools 初始表结构
-- 单表 jobs：全部任务状态以 JSON 存 payload，便于按阶段演进时无需反复改列。

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,              -- queued|running|succeeded|failed|canceled
  payload    TEXT NOT NULL,              -- JSON：完整任务数据（见 src/types.ts Job）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at  ON jobs(updated_at);

-- 发布流水（可选，用于审计每次对每个平台的发布结果）
CREATE TABLE IF NOT EXISTS publish_log (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  platform   TEXT NOT NULL,
  status     TEXT NOT NULL,              -- pending|published|failed
  external_id TEXT,
  url        TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_log_job ON publish_log(job_id);