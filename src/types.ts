// types.ts — 领域模型（任务的完整生命周期状态）

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type Stage =
  | 'init'
  | 'parse'      // 从电商链接抽取商品图
  | 'tryon'      // 虚拟试穿：人物图 × 商品图 → 试穿结果图
  | 'video'      // 图生视频：试穿结果图 → 短视频
  | 'publish'    // 多平台发布
  | 'done'
  | 'error';     // 流程级失败

export type Platform = 'douyin' | 'xiaohongshu' | 'weixin' | 'instagram' | 'facebook' | 'tiktok';

export type Resolution = '480p' | '720p' | '1080p';

export interface VideoOptions {
  resolution: Resolution;
  duration: number; // 秒
  withSound: boolean;
  /** true=生成完成后不自动发布，由用户在页面手动触发发布 */
  manualPublish?: boolean;
}

export interface MediaRef {
  kind: 'url' | 'r2';
  value: string; // url 原文 或 r2 key
}

/** 商品来源：image=直接给图 URL；link=给定电商链接待解析 */
export interface GarmentSource extends MediaRef {
  source?: 'image' | 'link';
}

export interface PublishTarget {
  platform: Platform;
  status: 'pending' | 'manual' | 'published' | 'failed';
  externalId?: string;
  url?: string;
  error?: string;
  publishedAt?: string;
  // 发布内容自定义（可按平台分别配置）
  title?: string;
  desc?: string;
  tags?: string[];
  /** 挂车商品 ID（抖音/视频号带货用） */
  productId?: string;
  /** 平台账号绑定（如抖音 open_id），留空用全局 access_token 默认发布 */
  accountId?: string;
}

/** 独立发布流水：任务完成后每次发布动作一行，支持同平台多次发布与计数 */
export interface PublishLogRecord {
  id: string;
  jobId: string;
  platform: Platform;
  status: 'published' | 'failed';
  externalId?: string;
  url?: string;
  error?: string;
  createdAt: string;
}

/** 模特库：复用预上传的模特照片，创建任务时可选用 */
export interface Model {
  id: string;
  name: string;
  photoKeys: string[]; // R2 对象 key
  createdAt: string;
}

export interface ParsedGarment {
  garmentImage?: MediaRef;
  title?: string;
  price?: string;
  category?: 'top' | 'bottom' | 'dress';
  from?: string;
}

export interface TryOnResult {
  output?: MediaRef;
  provider?: string;
}

export interface VideoResult {
  output?: MediaRef;
  provider?: string;
  coverImage?: MediaRef;
  /** DashScope 图生视频任务 id（幂等提交/续轮询用） */
  taskId?: string;
  /** 生成使用的提示词（用于前端可视化展示） */
  prompt?: string;
}

export interface LogEntry {
  ts: string;
  stage: Stage;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  stage: Stage;
  // 输入
  personImage: MediaRef; // 生效的试穿人物图（personImages 中的第一个或直给 url）
  personImages?: MediaRef[]; // 允许上传/提供多张人物图
  garment: GarmentSource; // image 直给 | link 需解析
  // 各阶段产物
  parsed?: ParsedGarment;
  tryOn?: TryOnResult;
  video?: VideoResult;
  publish: PublishTarget[];
  options: VideoOptions;
  // 元信息
  workflowInstanceId?: string;
  error?: string;
  logs: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

export function newJobId(): string {
  return crypto.randomUUID();
}

export function emptyJob(id: string, init: Partial<Job>): Job {
  return {
    id,
    status: 'queued',
    stage: 'init',
    personImage: { kind: 'url', value: '' },
    garment: { kind: 'url', value: '' },
    publish: [],
    options: { resolution: '1080p', duration: 15, withSound: true },
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...init,
  };
}

export function pushLog(job: Job, stage: Stage, level: LogEntry['level'], msg: string) {
  job.logs.push({ ts: new Date().toISOString(), stage, level, msg });
  if (job.logs.length > 200) job.logs = job.logs.slice(-200);
  job.updatedAt = new Date().toISOString();
}