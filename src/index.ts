// index.ts — Worker 入口：静态资源 + REST API + R2 媒体回源
import type { Env } from './env';
import type { Job, MediaRef } from './types';
import { emptyJob, newJobId } from './types';
import { JobStore } from './store/d1';
import { ConfigStore, CONFIG_KEYS, overlayConfig } from './store/config';
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

  if (p === '/api/platforms' && request.method === 'GET') {
    return json({ platforms: await listPlatforms(env) });
  }

  if (p === '/api/config') {
    if (request.method === 'GET') return getConfig(env);
    if (request.method === 'POST') return saveConfig(request, env);
  }

  if (p === '/api/settings') {
    return json({
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 10, 15],
      publishOn: (env.PUBLISH_ON ?? 'douyin').split(','),
      workersAiEnabled: env.DASHSCOPE_API_KEY ? false : true,
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
      await store.delete(id);
      return json({ ok: true });
    }
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
      kind: 'url',
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
async function getConfig(env: Env): Promise<Response> {
  const cfg = await new ConfigStore(env).all();
  return json({
    keys: CONFIG_KEYS.map((k) => ({
      key: k,
      set: cfg[k] !== undefined && cfg[k] !== '',
      masked: cfg[k] ? '••••••••' : '',
      envFallback: !!(env as Env)[k as keyof Env] || undefined,
    })),
  });
}

/** POST /api/config — body: { values: {键: 值} }；值置空字符串则删除该键。受可选 CONFIG_TOKEN 保护 */
async function saveConfig(request: Request, env: Env): Promise<Response> {
  if (env.CONFIG_TOKEN) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.CONFIG_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }
  }
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

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export type { Env };