// providers/video.ts — 图生视频：试穿结果图 → 15s 短视频
// 支持可灵(Kling v3) / 即梦(Seedance) 等 DashScope 托管；Workers AI 视频路径当前未上线，占位。
import type { Env } from '../env';
import { MediaStore } from '../storage/r2';
import type { VideoOptions } from '../types';
import { DashScopeAsyncClient } from './async';
import { sleepMs } from './vton';

export interface ImageToVideoRequest {
  tryOnImageKey: string; // R2 key 的试穿结果图
  options: VideoOptions;
  duration: number; // 秒
  prompt?: string;
}

export interface VideoGenProvider {
  readonly name: string;
  /** 返回产出的视频真实下载 URL（随后由调用方落 R2） */
  generate(req: ImageToVideoRequest): Promise<string>;
}

/** 可灵 / 即梦（DashScope 异步托管） */
export class DashScopeVideo implements VideoGenProvider {
  readonly name: string;
  private client: DashScopeAsyncClient;
  private media: MediaStore;

  constructor(env: Env, media: MediaStore, kind: 'kling' | 'seedance') {
    this.name = kind === 'kling' ? 'kling-v3' : 'seedance';
    const base = env.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
    const model = (kind === 'kling' ? env.VIDEO_MODEL : undefined) ?? (kind === 'kling' ? 'kling-v3' : 'seedance-02');
    // DashScope 图生视频服务路径沿用多模态聚合形貌；实际以目标模型文档为准
    this.client = new DashScopeAsyncClient(this.name, base, env.DASHSCOPE_API_KEY ?? '', model, 'image2video');
    this.media = media;
  }

  async generate(req: ImageToVideoRequest): Promise<string> {
    const image = await this.media.dataURL(req.tryOnImageKey, 'image/png');
    const ratio = req.options.resolution === '1080p' ? '16:9' : '16:9';
    const { taskId } = await this.client.submitTask({
      image,
      prompt: req.prompt ?? '',
      duration: req.duration,
      aspect_ratio: ratio,
      resolution: req.options.resolution,
    });
    let out: string | null = null;
    for (let i = 0; i < 50 && !out; i++) {
      const r = await this.client.pollTask(taskId);
      if (r.status === 'FAILED') throw new Error(`图生视频失败: ${r.error}`);
      if (r.status === 'SUCCEEDED' && r.outputUrl) out = r.outputUrl;
      else await sleepMs(6000);
    }
    if (!out) throw new Error('图生视频超时');
    return out;
  }
}

/** Workers AI 视频生成评估路径：当前占位，抛出清晰提示 */
export class WorkersAiVideo implements VideoGenProvider {
  readonly name = 'workers-ai(video未上线)';
  constructor(private env: Env) {}

  async generate(req: ImageToVideoRequest): Promise<string> {
    // Workers AI 目前以文本/图像/嵌入为主，尚无 stable 图生视频 API。
    throw new Error('Workers AI 尚无图生视频稳定接口，请配置 DASHSCOPE_API_KEY + VIDEO_MODEL 走可灵/即梦。');
  }
}

export function buildVideo(
  env: Env,
  media: MediaStore,
  kind: 'kling' | 'seedance' = 'kling',
): VideoGenProvider {
  if (env.DASHSCOPE_API_KEY) return new DashScopeVideo(env, media, kind);
  return new WorkersAiVideo(env);
}