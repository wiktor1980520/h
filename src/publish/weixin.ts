// publish/weixin.ts — 视频号开放平台发布
// 依据：微信视频号《上传挑战者视频》《发布作品》接口。字节从 R2 读取上送。
import type { MediaStore } from '../storage/r2';
import type { Platform } from '../types';
import type { PublishRequest, PublishResult, Publisher } from './index';
import { buildMultipart } from './douyin';

interface WeixinEnv {
  WEIXIN_CHANNELS_APPID?: string;
  WEIXIN_CHANNELS_ACCESS_TOKEN?: string;
}

const API = 'https://api.channels.weixin.qq.com';

export class WeixinChannelsPublisher implements Publisher {
  readonly platform: Platform = 'weixin';
  ready: boolean;

  constructor(private env: WeixinEnv, private media: MediaStore) {
    this.ready = !!env.WEIXIN_CHANNELS_ACCESS_TOKEN;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = this.env.WEIXIN_CHANNELS_ACCESS_TOKEN;
    if (!token) return { platform: 'weixin', status: 'failed', error: '缺少 WEIXIN_CHANNELS_ACCESS_TOKEN' };

    const videoBytes = await this.media.bytes(req.videoR2Key);
    // 1) 上传临时视频素材 → media_id
    const uploadResp = await fetch(
      `${API}/channels/ec/vod/upload?access_token=${token}`,
      { method: 'POST', body: buildMultipart([{ name: 'media', filename: 'video.mp4', contentType: 'video/mp4', data: videoBytes }]) },
    );
    const uploadJson = (await uploadResp.json().catch(() => ({}))) as { media_id?: string };
    if (!uploadResp.ok || !uploadJson.media_id) {
      return { platform: 'weixin', status: 'failed', error: `上传失败: ${JSON.stringify(uploadJson)}` };
    }

    // 2) 发布作品
    const createResp = await fetch(`${API}/channels/ec/vod/add?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media_id: uploadJson.media_id,
        title: req.title,
        desc: req.tags?.join(' '),
      }),
    });
    const createJson = (await createResp.json().catch(() => ({}))) as {
      finder_id?: string;
      errmsg?: string;
      errcode?: number;
    };
    if (!createResp.ok || createJson.errcode) {
      return { platform: 'weixin', status: 'failed', error: createJson.errmsg ?? JSON.stringify(createJson) };
    }
    return { platform: 'weixin', status: 'published', externalId: createJson.finder_id };
  }
}