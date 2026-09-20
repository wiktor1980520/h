-- 0002_app_config.sql — 第三方 key 配置（写到数据库，替换 worker 环境变量注入）
-- value 为 AES-GCM 密文（DATA_ENCRYPTION_KEY 加密；未配置时存明文）。
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);