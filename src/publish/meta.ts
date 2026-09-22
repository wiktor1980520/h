// publish/meta.ts — Meta Graph API：Instagram Reels / Facebook Reels
// 容器式发布：先创建 media 容器（带公开视频 URL），轮询就绪后 publish。
// 依据：Meta Graph API《Create Reel / Create Reels Container》与 Media Status。
import type { MediaStore } from '../storage/r2';
import type { Platform } from '../types';
import type { PublishRequest, PublishResult, Publisher } from './index';

interface MetaEnv {
  META_ACCESS_TOKEN?: string;
  META_IG_USER_ID?: string;
  META_FB_PAGE_ID?: string;
}

const GRAPH = 'https://graph.facebook.com/v21.0';

export class MetaPublisher implements Publisher {
  readonly platform: Platform;
  ready: boolean;

  constructor(private env: MetaEnv, private media: MediaStore, platform: 'instagram' | 'facebook') {
    this.platform = platform;
    this.ready = !!env.META_ACCESS_TOKEN && !!env[platform === 'instagram' ? 'META_IG_USER_ID' : 'META_FB_PAGE_ID'];
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = this.env.META_ACCESS_TOKEN;
    const accountId = this.env[this.platform === 'instagram' ? 'META_IG_USER_ID' : 'META_FB_PAGE_ID'];
    if (!token || !accountId) {
      return { platform: this.platform, status: 'failed', error: '缺少 META_ACCESS_TOKEN 或账号 ID' };
    }
    const videoUrl = await this.media.getPublicURL(req.videoR2Key);
    const caption = req.desc || req.title;

    // 1) 创建 Reels 容器
    const createResp = await fetch(`${GRAPH}/${accountId}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: token,
      }),
    });
    const createJson = (await createResp.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
    if (!createResp.ok || !createJson.id) {
      return { platform: this.platform, status: 'failed', error: `创建容器失败: ${createJson.error?.message ?? JSON.stringify(createJson)}` };
    }
    const containerId = createJson.id;

    // 2) 轮询容器就绪（最多 ~2 分钟：Meta 拉取并转码视频）
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) {
        return { platform: this.platform, status: 'failed', error: '等待 Meta 转码超时' };
      }
      await sleep(4000);
      const stResp = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`);
      const st = (await stResp.json().catch(() => ({}))) as { status_code?: string; status?: string; error?: { message?: string } };
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status === 'error') {
        return { platform: this.platform, status: 'failed', error: `Meta 处理失败: ${st.error?.message ?? st.status}` };
      }
    }

    // 3) 发布
    const pubResp = await fetch(`${GRAPH}/${accountId}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: containerId, access_token: token }),
    });
    const pubJson = (await pubResp.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!pubResp.ok || !pubJson.id) {
      return { platform: this.platform, status: 'failed', error: `发布失败: ${pubJson.error?.message ?? JSON.stringify(pubJson)}` };
    }
    return { platform: this.platform, status: 'published', externalId: String(pubJson.id), url: `https://instagram.com/reel/${pubJson.id}` };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}