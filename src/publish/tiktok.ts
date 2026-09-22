// publish/tiktok.ts — TikTok Content Posting API（拉流方式，视频须为公网 URL）
// 依据：TikTok Content Posting API《POST /v2/post/publish/video/init/》《POST /v2/post/publish/status/》。
import type { MediaStore } from '../storage/r2';
import type { Platform } from '../types';
import type { PublishRequest, PublishResult, Publisher } from './index';

interface TikTokEnv {
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_OPEN_ID?: string;
}

const API = 'https://open.tiktokapis.com/v2/post/publish/video';

export class TikTokPublisher implements Publisher {
  readonly platform: Platform = 'tiktok';
  ready: boolean;

  constructor(private env: TikTokEnv, private media: MediaStore) {
    this.ready = !!env.TIKTOK_ACCESS_TOKEN;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = this.env.TIKTOK_ACCESS_TOKEN;
    if (!token) return { platform: 'tiktok', status: 'failed', error: '缺少 TIKTOK_ACCESS_TOKEN' };
    const videoUrl = await this.media.getPublicURL(req.videoR2Key);
    const title = req.desc || req.title;

    // 1) 初始化投稿（PULL_FROM_URL，TikTok 服务端拉取公开视频）
    const initResp = await fetch(`${API}/init/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        post_info: { title, privacy_level: 'SELF_ONLY' }, // 先私密，避免误公开；确认后可改 PUBLIC
        source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
      }),
    });
    const initJson = (await initResp.json().catch(() => ({}))) as {
      data?: { publish_id?: string };
      error?: { code?: string; message?: string };
    };
    if (!initResp.ok || !initJson.data?.publish_id) {
      return { platform: 'tiktok', status: 'failed', error: `初始化投稿失败: ${initJson.error?.message ?? JSON.stringify(initJson)}` };
    }
    const publishId = initJson.data.publish_id;

    // 2) 轮询投稿状态至完成
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (Date.now() > deadline) {
        return { platform: 'tiktok', status: 'failed', error: '等待 TikTok 处理超时' };
      }
      await sleep(5000);
      const stResp = await fetch(`${API}/status/?publish_id=${publishId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const st = (await stResp.json().catch(() => ({}))) as {
        data?: { status?: string; post_id?: string };
        error?: { code?: string; message?: string };
      };
      const status = st.data?.status;
      if (status === 'PUBLISH_COMPLETE') {
        const postId = st.data?.post_id;
        return { platform: 'tiktok', status: 'published', externalId: postId, url: `https://www.tiktok.com/@user/video/${postId ?? ''}` };
      }
      if (status === 'FAILED') {
        return { platform: 'tiktok', status: 'failed', error: st.error?.message ?? 'TikTok 反馈失败' };
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}