-- 0004_models.sql — 模特库：可复用的预上传模特与照片
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo_keys TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);