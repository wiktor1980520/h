-- 0005_model_info.sql — 模特个人信息（JSON），一对多照片仍在 photo_keys
ALTER TABLE models ADD COLUMN info TEXT NOT NULL DEFAULT '{}';