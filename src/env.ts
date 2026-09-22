// Env：Cloudflare 绑定的类型集合（与 wrangler.jsonc 对齐）
export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;

  PIPELINE_WORKFLOW: Workflow<{ jobId: string }>;

  // ---- vars ----
  WEBHOOK_BASE: string;
  PARSE_TIMEOUT_MS: string;
  VIDEO_TTL_DAYS: string;
  DEFAULT_RESOLUTION: string;
  DEFAULT_DURATION: string;
  PUBLISH_ON: string;
  /** 发布版本号（部署时由 git 短 hash 自动注入） */
  RELEASE_VERSION?: string;

  // ---- secrets（.dev.vars / wrangler secret put）----
  DASHSCOPE_API_KEY?: string;
  TRYON_MODEL?: string;
  VIDEO_MODEL?: string;
  IMAGE_TO_VIDEO_ENDPOINT?: string;
  KOLORS_OR_SEEDANCE_API_KEY?: string;

  PARSER_UA?: string;
  R2_PUBLIC_BASE?: string;

  DOUYIN_CLIENT_KEY?: string;
  DOUYIN_CLIENT_SECRET?: string;
  DOUYIN_ACCESS_TOKEN?: string;

  WEIXIN_CHANNELS_APPID?: string;
  WEIXIN_CHANNELS_ACCESS_TOKEN?: string;

  XHS_RPA_WEBHOOK?: string;

  // ---- Workers AI 评估路径 ----
  USE_WORKERS_AI_LLM?: string;
  WORKERS_AI_LLM?: string;

  // ---- 数据库配置相关 ----
  /** AES-GCM 加密第三方 key 落库的密钥（建议 Cloudflare Secret 注入）；未设则明文存 */
  DATA_ENCRYPTION_KEY?: string;

  // ---- system guards ----
  /** 登录密码（DB app_config.LOGIN_PASSWORD 优先；env 兜底；均未设时默认 123456） */
  LOGIN_PASSWORD?: string;
  /** 通用登录密钥（建议 Cloudflare Secret 注入）；设置后所有 /api/* 需带 Authorization: Bearer <该密钥> 才能访问 */
  APP_ACCESS_KEY?: string;
}