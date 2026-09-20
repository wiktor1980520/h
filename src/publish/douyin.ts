// publish/douyin.ts — 抖音开放平台发布（含“挂车”= 携带商品信息）
// 依据：Douyin Open API《创建视频》《上传视频文件》。视频字节从 R2 读取后 multipart 上送。
import type { MediaStore } from '../storage/r2';
import type { Platform } from '../types';
import type { PublishRequest, PublishResult, Publisher } from './index';

interface DouyinEnv {
  DOUYIN_CLIENT_KEY?: string;
  DOUYIN_CLIENT_SECRET?: string;
  DOUYIN_ACCESS_TOKEN?: string;
}

const API = 'https://open.douyin.com';

export class DouyinPublisher implements Publisher {
  readonly platform: Platform = 'douyin';
  ready: boolean;

  constructor(private env: DouyinEnv, private media: MediaStore) {
    this.ready = !!env.DOUYIN_ACCESS_TOKEN;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = this.env.DOUYIN_ACCESS_TOKEN;
    if (!token) return { platform: 'douyin', status: 'failed', error: '缺少 DOUYIN_ACCESS_TOKEN' };

    const videoBytes = await this.media.bytes(req.videoR2Key);
    const videoPath = `${API}/video/upload/`;
    // 1) multipart 上传视频 → video_id
    const uploadResp = await fetch(videoPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: buildMultipart([
        { name: 'video', filename: 'video.mp4', contentType: 'video/mp4', data: videoBytes },
        { name: 'open_id', value: '' }, // 按需：挂车/发布需 open_id
        { name: 'access_token', value: token },
      ]),
    });
    if (!uploadResp.ok) return this.fail(req, `上传失败 HTTP ${uploadResp.status}`);
    const uploadJson = (await uploadResp.json()) as {
      data?: { video_id?: string; error_code?: number };
    };
    const videoId = uploadJson.data?.video_id;
    if (!videoId) return this.fail(req, `上传未返回 video_id: ${JSON.stringify(uploadJson.data)}`);

    // 2) 创建视频（挂车：附加 item_info 含商品 ecom）
    const body = JSON.stringify({
      video_id: videoId,
      text: req.title,
      // 挂车：若已配置电商商品/星图，可在此注入 ecom_carousel / union_id
      ecom_carousel: {},
    });
    const createResp = await fetch(`${API}/video/create/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    const createJson = (await createResp.json().catch(() => ({}))) as {
      data?: { item_id?: string; error_code?: number };
    };
    if (!createResp.ok || createJson.data?.error_code) {
      return this.fail(req, `创建视频失败: ${JSON.stringify(createJson.data)}`);
    }
    return { platform: 'douyin', status: 'published', externalId: createJson.data?.item_id };
  }

  private fail(
    req: PublishRequest,
    err: string,
  ): PublishResult {
    void req;
    return { platform: 'douyin', status: 'failed', error: err };
  }
}

/** 简易 multipart（未含随机 boundary 需转义，见实现） */
export function buildMultipart(
  fields: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Uint8Array }>,
): Uint8Array<ArrayBuffer> {
  const boundary = '----huangtools' + crypto.randomUUID().replace(/-/g, '');
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of fields) {
    const head = enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${f.name}"` +
        (f.filename ? `; filename="${f.filename}"` : '') +
        `\r\n` +
        (f.contentType ? `Content-Type: ${f.contentType}\r\n` : '') +
        `\r\n`,
    );
    chunks.push(head);
    chunks.push(f.data ?? enc.encode(f.value ?? ''));
    chunks.push(enc.encode(`\r\n`));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}