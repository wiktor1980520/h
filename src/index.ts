// index.ts — Worker 入口：静态资源 + REST API + R2 媒体回源
import type { Env } from './env';
import type { Job, MediaRef } from './types';
import { emptyJob, newJobId } from './types';
import { JobStore } from './store/d1';
import { ConfigStore, CONFIG_KEYS, overlayConfig, getAuthPassword } from './store/config';
import { MediaStore } from './storage/r2';
import { PublisherRegistry } from './publish';
import { DouyinPublisher } from './publish/douyin';
import { WeixinChannelsPublisher } from './publish/weixin';
import { XiaohongshuPublisher } from './publish/xiaohongshu';

export { HuangtoolsPipelineWorkflow } from './workflow/pipeline';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // API / 媒体/webhook 路由优先于静态资源，避免 SPA 兜底吞掉接口请求
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/media/') ||
      url.pathname === '/v1/webhooks/xhs'
    ) {
      if (url.pathname.startsWith('/media/')) {
        const download = url.searchParams.get('download') === '1';
        return serveMedia(env, decodeURIComponent(url.pathname.slice('/media/'.length)), download);
      }
      return routeApi(request, url, env);
    }

    // 静态资源（前端界面）优先
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return new Response('Not Found', { status: 404 });
  },
};

async function routeApi(request: Request, url: URL, env: Env): Promise<Response> {
  const store = new JobStore(env);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // 登录密码：DB app_config.LOGIN_PASSWORD 优先，env 兜底，默认 123456
  const authPass = await getAuthPassword(env);

  if (p === '/api/auth/status') {
    return json({ enabled: true });
  }

  if (p === '/api/auth/login' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { key?: string } | null;
    return body?.key && body.key === authPass
      ? json({ ok: true, enabled: true })
      : json({ error: '密钥不正确' }, 401);
  }

  // 除 auth/status、auth/login 外的所有 /api/* 都需携带登录密码（Authorization: Bearer）鉴权
  if (!isAuthed(request, authPass)) {
    return json({ error: 'unauthorized: 需要访问密钥' }, 401);
  }

  // 诊断：GET 试穿/视频任务的原始轮询响应，确认结果字段结构（非计费）
  if (p === '/api/diag/task' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { taskId?: string } | null;
    if (!body?.taskId) return json({ error: '需要 taskId' }, 400);
    try {
      const cfg = await overlayConfig(env);
      const base = cfg.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
      const resp = await fetch(`${base.replace(/\/+$/, '')}/api/v1/tasks/${encodeURIComponent(body.taskId)}`, {
        headers: { authorization: `Bearer ${cfg.DASHSCOPE_API_KEY ?? ''}` },
        signal: AbortSignal.timeout(25_000),
      });
      const text = await resp.text();
      return json({ ok: true, http: resp.status, body: text.slice(0, 1200) });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 502);
    }
  }

  // 诊断：用真实配置复现图生视频提交（非轮询），返回原始响应与耗时（会产生计费任务）
  if (p === '/api/diag/video' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { jobId?: string } | null;
    if (!body?.jobId) return json({ error: '需要 jobId' }, 400);
    try {
      const cfg = await overlayConfig(env);
      const job = await store.get(body.jobId);
      if (!job) return json({ error: '任务不存在' }, 404);
      const m = new MediaStore(env, env.R2_PUBLIC_BASE);
      const kind = cfg.VIDEO_MODEL ? 'kling' : 'seedance';
      const model = (kind === 'kling' ? cfg.VIDEO_MODEL : (cfg.VIDEO_MODEL ?? 'seedance-02'));
      const base = cfg.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
      const target = `${base.replace(/\/+$/, '')}/api/v1/services/aigc/image2video/${model}`;
      const tryOnKey = job.tryOn?.output?.value ?? m.key(job.id, 'tryon', 'jpg');
      const image = await m.getPublicURL(tryOnKey);
      const started = Date.now();
      const resp = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.DASHSCOPE_API_KEY ?? ''}`, 'x-dashscope-async': 'enable' },
        body: JSON.stringify({ model, input: { image, prompt: '时装展示', duration: 15, aspect_ratio: '16:9', resolution: '1080p' } }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await resp.text();
      return json({ ok: true, target, model, image, http: resp.status, ms: Date.now() - started, body: text.slice(0, 600) });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 502);
    }
  }

  // 诊断：用真实配置(密钥/模型/端点) + 真实任务图片地址，完整跑一次试穿提交
  if (p === '/api/diag/tryon' && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { jobId?: string } | null;
    if (!body?.jobId) return json({ error: '需要 jobId' }, 400);
    try {
      const cfg = await overlayConfig(env);
      const job = await store.get(body.jobId);
      if (!job) return json({ error: '任务不存在' }, 404);
      const m = new MediaStore(env, env.R2_PUBLIC_BASE);
      const personURL = await m.getPublicURL(job.personImage.value);
      const garmentURL = await m.getPublicURL(job.parsed?.garmentImage?.value ?? job.garment.value);
      const base = cfg.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
      const target = `${base.replace(/\/+$/, '')}/api/v1/services/aigc/image2image/image-synthesis`;
      const started = Date.now();
      const input: Record<string, string> = { person_image_url: personURL };
      input[job.parsed?.category === 'bottom' ? 'bottom_garment_url' : 'top_garment_url'] = garmentURL;
      const resp = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.DASHSCOPE_API_KEY ?? ''}`,
          'x-dashscope-async': 'enable',
        },
        body: JSON.stringify({
          model: cfg.TRYON_MODEL ?? 'aitryon',
          input,
          parameters: { resolution: -1, restore_face: true },
        }),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await resp.text();
      return json({
        ok: true,
        target,
        model: cfg.TRYON_MODEL ?? 'aitryon',
        keyLen: (cfg.DASHSCOPE_API_KEY ?? '').length,
        personURL,
        garmentURL,
        http: resp.status,
        ms: Date.now() - started,
        body: text.slice(0, 600),
      });
    } catch (e) {
      return json({ ok: false, ms: 0, error: String(e) }, 502);
    }
  }

  if (p === '/api/platforms' && request.method === 'GET') {
    return json({ platforms: await listPlatforms(env) });
  }

  if (p === '/api/config') {
    if (request.method === 'GET') return getConfig(new URL(request.url), env);
    if (request.method === 'POST') return saveConfig(request, env);
  }

  if (p === '/api/settings') {
    return json({
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 10, 15],
      publishOn: (env.PUBLISH_ON ?? 'douyin').split(','),
      workersAiEnabled: env.DASHSCOPE_API_KEY ? false : true,
      version: env.RELEASE_VERSION ?? 'dev',
    });
  }

  if (p === '/api/jobs' && request.method === 'POST') {
    return createJob(request, env, store);
  }

  if (p === '/api/upload' && request.method === 'POST') {
    return uploadFile(request, env);
  }

  if (p === '/api/jobs' && request.method === 'GET') {
    const status = url.searchParams.get('status') as Job['status'] | null;
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
    const { items, cursor: next } = await store.list(status ?? undefined, limit, cursor);
    return json({ items, cursor: next ?? null });
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(p);
  if (jobMatch) {
    const id = jobMatch[1];
    if (request.method === 'GET') {
      const job = await store.get(id);
      return job ? json(job) : notFound();
    }
    if (request.method === 'DELETE') {
      await softDeleteJob(id, env, store);
      return json({ ok: true, soft: true });
    }
  }

  if (p === '/api/recycle' && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
    const { items, cursor: next } = await store.listDeleted(limit, cursor);
    return json({ items, cursor: next ?? null });
  }

  const restoreMatch = /^\/api\/jobs\/([^/]+)\/restore$/.exec(p);
  if (restoreMatch && request.method === 'POST') {
    const job = await store.get(restoreMatch[1]);
    if (!job) return notFound();
    await store.restore(restoreMatch[1]);
    return json({ ok: true });
  }

  const purgeMatch = /^\/api\/jobs\/([^/]+)\/purge$/.exec(p);
  if (purgeMatch && request.method === 'POST') {
    await purgeJob(purgeMatch[1], env, store);
    return json({ ok: true });
  }

  const publishMatch = /^\/api\/jobs\/([^/]+)\/publish$/.exec(p);
  if (publishMatch && request.method === 'POST') {
    return publishJob(publishMatch[1], env, store);
  }

  if (p.endsWith('/cancel') && request.method === 'POST') {
    const id = p.split('/').filter(Boolean).at(-2);
    if (id) return cancelJob(id, env, store);
  }

  if (p === '/v1/webhooks/xhs' && request.method === 'POST') {
    return xhsCallback(request, env, store);
  }

  return json({ error: 'not found' }, 404);
}

async function createJob(request: Request, env: Env, store: JobStore): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<CreateJobBody>;
  const personImages: MediaRef[] =
    Array.isArray(body.personImages) && body.personImages.length
      ? body.personImages
      : body.personImageURL
        ? [{ kind: 'url', value: body.personImageURL }]
        : [];
  const active = personImages[0] ?? { kind: 'url' as const, value: '' };
  if (!active.value || !body.garmentValue) {
    return json({ error: '需至少一张人物图片 与 商品图片/电商链接' }, 400);
  }
  const cfg = await overlayConfig(env);
  const id = newJobId();
  const job = emptyJob(id, {
    personImage: active,
    personImages,
    garment: {
      // image 源的商品图是已上传到 R2 的对象，value 即 R2 key；link 源才是外部 URL
      kind: body.garmentType === 'image' ? 'r2' : 'url',
      value: body.garmentValue,
      source: body.garmentType === 'link' ? 'link' : 'image',
    },
    publish: (body.publish ?? []).map((p) => ({ platform: p, status: 'pending' })),
    options: {
      resolution: (body.resolution ?? cfg.DEFAULT_RESOLUTION) as Job['options']['resolution'],
      duration: body.duration ?? parseInt(cfg.DEFAULT_DURATION || '15', 10),
      withSound: body.withSound ?? true,
      manualPublish: body.manualPublish ?? false,
    },
  });
  await store.create(job);

  // 投递到多步骤 Workflow
  const instance = await env.PIPELINE_WORKFLOW.create({ id: crypto.randomUUID(), params: { jobId: id } });
  job.workflowInstanceId = instance.id;
  await store.save(job);

  return json({ job, workflowInstanceId: instance.id }, 201);
}

/** 软删除：终止运行中的工作流，写入 deleted_at，保留媒体文件，进回收站 */
async function softDeleteJob(id: string, env: Env, store: JobStore): Promise<void> {
  const job = await store.get(id);
  if (job?.workflowInstanceId) {
    const instance = await env.PIPELINE_WORKFLOW.get(job.workflowInstanceId);
    await instance?.terminate().catch(() => {});
  }
  await store.softDelete(id);
}

/** 彻底删除：终止工作流 + 清理 R2 媒体 + 物理删库（回收站里的永久清空） */
async function purgeJob(id: string, env: Env, store: JobStore): Promise<void> {
  const job = await store.get(id);
  if (job?.workflowInstanceId) {
    const instance = await env.PIPELINE_WORKFLOW.get(job.workflowInstanceId);
    await instance?.terminate().catch(() => {});
  }
  await new MediaStore(env, env.R2_PUBLIC_BASE).deleteByPrefix(id).catch(() => {});
  await store.permanentDelete(id);
}

async function cancelJob(id: string, env: Env, store: JobStore): Promise<Response> {
  const job = await store.get(id);
  if (!job) return notFound();
  job.status = 'canceled';
  job.updatedAt = new Date().toISOString();
  await store.save(job);
  if (job.workflowInstanceId) {
    const instance = await env.PIPELINE_WORKFLOW.get(job.workflowInstanceId);
    await instance?.terminate().catch(() => {});
  }
  return json({ ok: true });
}

async function xhsCallback(request: Request, env: Env, store: JobStore): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    jobId?: string;
    ok?: boolean;
    url?: string;
    externalId?: string;
    error?: string;
  };
  if (!body.jobId) return json({ error: 'jobId 必填' }, 400);
  const job = await store.get(body.jobId);
  if (job) {
    const t = job.publish.find((x) => x.platform === 'xiaohongshu');
    if (t) {
      t.status = body.ok ? 'published' : 'failed';
      t.url = body.url;
      t.externalId = body.externalId;
      t.error = body.error;
      t.publishedAt = body.ok ? new Date().toISOString() : t.publishedAt;
      await store.save(job);
    }
  }
  return json({ ok: true });
}

async function serveMedia(env: Env, key: string, download = false): Promise<Response> {
  const obj = await env.MEDIA_BUCKET.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', `public, max-age=${env.VIDEO_TTL_DAYS ? parseInt(env.VIDEO_TTL_DAYS, 10) * 86400 : 2592000}`);
  headers.set('access-control-allow-origin', '*');
  if (download) {
    const filename = key.split('/').pop() ?? 'download';
    headers.set('content-disposition', `attachment; filename="${filename}"`);
  }
  return new Response(obj.body, { headers });
}

/** POST /api/upload — multipart 之外走 base64 JSON，避免手写 multipart 解析。返回 R2 引用 */
async function uploadFile(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    fileName?: string;
    contentType?: string;
    data?: string;
  } | null;
  if (!body || typeof body.data !== 'string' || !body.data) {
    return json({ error: 'data 必填（base64 或 dataURL）' }, 400);
  }
  const contentType = body.contentType || mimeFromName(body.fileName || '') || 'application/octet-stream';
  const raw = body.data.includes(',') ? body.data.slice(body.data.indexOf(',') + 1) : body.data;
  const ext = extFromMime(contentType) || 'bin';
  const key = `uploads/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA_BUCKET.put(key, base64ToBytes(raw), { httpMetadata: { contentType } });
  const ref: MediaRef = { kind: 'r2', value: key };
  return json({ ref, key }, 201);
}

/** POST /api/jobs/:id/publish — 生成完成后手动触发发布（重发 pending/manual/failed 目标） */
async function publishJob(id: string, env: Env, store: JobStore): Promise<Response> {
  const job = await store.get(id);
  if (!job) return notFound();
  if (journalHasVideo(job) !== true) {
    return json({ error: '视频尚未生成完成，请稍后再发布' }, 400);
  }
  const cfg = await overlayConfig(env);
  const media = new MediaStore(env, cfg.R2_PUBLIC_BASE);
  const registry = buildRegistry(cfg, media);
  const out: Array<{ platform: string; status: string; error?: string; url?: string; externalId?: string }> = [];
  for (const t of job.publish) {
    if (t.status === 'published') {
      out.push({ platform: t.platform, status: 'published', url: t.url, externalId: t.externalId });
      continue;
    }
    const pub = registry.get(t.platform);
    if (!pub || !pub.ready) {
      t.status = 'failed';
      t.error = '平台未配置或未就绪';
      out.push({ platform: t.platform, status: 'failed', error: t.error });
      continue;
    }
    const res = await pub.publish({ jobId: job.id, videoR2Key: job.video!.output!.value, title: job.parsed?.title ?? `AI 换装短视频 ${job.id}` });
    if (res.status === 'published') {
      t.status = 'published';
      t.externalId = res.externalId;
      t.url = res.url;
      t.publishedAt = new Date().toISOString();
      t.error = undefined;
    } else {
      t.status = 'failed';
      t.error = res.error;
    }
    out.push({ platform: t.platform, status: t.status, error: t.error, url: t.url, externalId: t.externalId });
  }
  await store.save(job);
  return json({ ok: true, results: out });
}

function journalHasVideo(job: Job): boolean {
  return !!(job.status === 'succeeded' && job.video?.output?.value);
}

function buildRegistry(cfg: Env, media: MediaStore): PublisherRegistry {
  return new PublisherRegistry([
    new DouyinPublisher(cfg, media),
    new WeixinChannelsPublisher(cfg, media),
    new XiaohongshuPublisher(cfg, media),
  ]);
}

async function listPlatforms(env: Env): Promise<Array<{ platform: string; ready: boolean; note?: string }>> {
  const cfg = await overlayConfig(env);
  const out: Array<{ platform: string; ready: boolean; note?: string }> = [];
  out.push({ platform: 'douyin', ready: !!cfg.DOUYIN_ACCESS_TOKEN, note: cfg.DOUYIN_ACCESS_TOKEN ? undefined : '缺少 DOUYIN_ACCESS_TOKEN' });
  out.push({ platform: 'weixin', ready: !!cfg.WEIXIN_CHANNELS_ACCESS_TOKEN, note: cfg.WEIXIN_CHANNELS_ACCESS_TOKEN ? undefined : '缺少 WEIXIN_CHANNELS_ACCESS_TOKEN' });
  out.push({ platform: 'xiaohongshu', ready: !!cfg.XHS_RPA_WEBHOOK, note: cfg.XHS_RPA_WEBHOOK ? undefined : '需 XHS_RPA_WEBHOOK（本地 RPA 桥）' });
  return out;
}

/** GET /api/config — 返回各键是否已配置（值掩码，避免公开泄露第三方 key） */
async function getConfig(url: URL, env: Env): Promise<Response> {
  const cfg = await new ConfigStore(env).all();
  const reveal = url.searchParams.get('reveal') === '1'; // 明文仅对已登录(访问密钥)可见
  return json({
    keys: CONFIG_KEYS.map((k) => ({
      key: k,
      set: cfg[k] !== undefined && cfg[k] !== '',
      masked: cfg[k] ? (reveal ? cfg[k] : '••••••••') : '',
      envFallback: !!(env as Env)[k as keyof Env] || undefined,
    })),
  });
}

/** POST /api/config — body: { values: {键: 值} }；值置空字符串则删除该键。受登录密码(authorization)鉴权 */
async function saveConfig(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { values?: Record<string, string> } | null;
  if (!body || !body.values) return json({ error: 'values 必填，形如 { "DASHSCOPE_API_KEY": "sk-xxx" }' }, 400);
  await new ConfigStore(env).save(body.values);
  return json({ ok: true });
}

interface CreateJobBody {
  personImageURL?: string;
  /** 已上传到 R2 的多张人物图引用（优先于此字段） */
  personImages?: MediaRef[];
  garmentType?: 'image' | 'link';
  garmentValue?: string;
  resolution?: '480p' | '720p' | '1080p';
  duration?: number;
  withSound?: boolean;
  manualPublish?: boolean;
  publish?: Array<Job['publish'][number]['platform']>;
}

function mimeFromName(name: string): string {
  const n = name.toLowerCase().split('.').pop() ?? '';
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4' })[n] ?? '';
}
function extFromMime(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' })[mime] ?? 'bin';
}
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

function notFound(): Response {
  return json({ error: 'not found' }, 404);
}

function isAuthed(request: Request, key: string): boolean {
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${key}`;
}

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export type { Env };