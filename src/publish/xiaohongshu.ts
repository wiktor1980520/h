// publish/xiaohongshu.ts — 小红书发布：无官方开放 API，采用 Webhook 桥接到本地 RPA 服务。
// 设计：Worker 将视频落 R2 后，回调自部署的 RPA（浏览器自动化）完成「发图文/视频 + 挂车」，
// 通过 XHS_RPA_WEBHOOK 触发；RPA 完成后回调 Worker 的 /v1/webhooks/xhs 记录结果。
import type { MediaStore } from '../storage/r2';
import type { Platform } from '../types';
import type { PublishRequest, PublishResult, Publisher } from './index';

interface XhsEnv {
  XHS_RPA_WEBHOOK?: string;
  WEBHOOK_BASE?: string;
}

export class XiaohongshuPublisher implements Publisher {
  readonly platform: Platform = 'xiaohongshu';
  ready: boolean;

  constructor(private env: XhsEnv, private media: MediaStore) {
    this.ready = !!env.XHS_RPA_WEBHOOK;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const hook = this.env.XHS_RPA_WEBHOOK;
    if (!hook) return { platform: 'xiaohongshu', status: 'failed', error: '未配置 XHS_RPA_WEBHOOK' };

    const videoURL = await this.media.getPublicURL(req.videoR2Key);
    // 触发本地 RPA：传视频地址(可公开下载)+标题；RPA 登录小红书后发布
    const resp = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: req.jobId,
        task: 'publish-xiaohongshu',
        videoUrl: videoURL,
        title: req.title,
      }),
    });
    if (!resp.ok) {
      return { platform: 'xiaohongshu', status: 'failed', error: `RPA 触发失败 HTTP ${resp.status}` };
    }
    // RPA 为异步桥接：返回 acksToken 后，由回调推进发布状态
    return { platform: 'xiaohongshu', status: 'published', externalId: req.jobId };
  }
}

// RPA 完成后的异步回调由 index.ts 的 /v1/webhooks/xhs 处理并更新 job.publish 状态。