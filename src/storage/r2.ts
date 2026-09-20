// storage/r2.ts — R2 对象存储服务（图片/视频存取）
import type { Env } from '../env';
import type { MediaRef } from '../types';

export type ContentType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'video/mp4'
  | 'application/json';

export class MediaStore {
  constructor(private env: Env, private publicBase = '') {}

  key(jobId: string, kind: 'person' | 'garment' | 'tryon' | 'video' | 'cover', ext: string): string {
    return `jobs/${jobId}/${kind}.${ext}`;
  }

  /** 从远程 URL 抓取并存入 R2，返回 { kind:'r2', value:key } */
  async ingestFromURL(
    jobId: string,
    kind: 'person' | 'garment',
    url: string,
    contentType?: string,
  ): Promise<MediaRef> {
    const resp = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!resp.ok) throw new Error(`下载输入资源失败: HTTP ${resp.status}`);

    const buf = await resp.arrayBuffer();
    const ct = contentType ?? resp.headers.get('content-type') ?? 'application/octet-stream';
    const key = this.key(jobId, kind, contentTypeToExt(ct));
    await this.env.MEDIA_BUCKET.put(key, buf, { httpMetadata: { contentType: ct } });
    return { kind: 'r2', value: key };
  }

  /** 从外部推理接口返回的字节写入 R2 */
  async saveBytes(key: string, data: ArrayBuffer | ReadableStream | string, contentType: ContentType): Promise<void> {
    await this.env.MEDIA_BUCKET.put(key, data, { httpMetadata: { contentType } });
  }

  /** 读 R2 对象并编码为 data: URL，供推理 API 自包含传图（避免依赖公网 URL） */
  async dataURL(key: string, mime: string): Promise<string> {
    const obj = await this.env.MEDIA_BUCKET.get(key);
    if (!obj) throw new Error(`R2 对象不存在: ${key}`);
    const buf = await obj.arrayBuffer();
    const b64 = bytesToBase64(new Uint8Array(buf));
    return `data:${mime};base64,${b64}`;
  }

  /** 读取 R2 对象原始字节 */
  async bytes(key: string): Promise<Uint8Array> {
    const obj = await this.env.MEDIA_BUCKET.get(key);
    if (!obj) throw new Error(`R2 对象不存在: ${key}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    return this.env.MEDIA_BUCKET.get(key);
  }

  async getPublicURL(key: string): Promise<string> {
    if (this.publicBase) return `${this.publicBase}/${key}`;
    // 无自定义域名时，回源由 Worker 路由 /media/<key> 代为流式返回
    return `/media/${key}`;
  }

  /** 生成可访问 url（用于回写入 job 供前端预览/下载） */
  async materialize(key: string): Promise<{ key: string; publicURL: string }> {
    return { key, publicURL: await this.getPublicURL(key) };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function contentTypeToExt(ct?: string): string {
  if (!ct) return 'bin';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('mp4')) return 'mp4';
  return 'bin';
}

/** 从第三方媒体（如可灵/即梦返回的 mp4）下载并落 R2 */
export async function downloadToR2(
  bucket: R2Bucket,
  key: string,
  url: string,
  contentType: ContentType,
): Promise<void> {
  const resp = await fetch(url, { cf: { cacheEverything: true } });
  if (!resp.ok) throw new Error(`下载成品失败: HTTP ${resp.status}`);
  await bucket.put(key, resp.body!, { httpMetadata: { contentType } });
}