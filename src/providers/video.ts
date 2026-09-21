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

/** 图生视频过程中的可观测回调（写入任务日志，便于排查） */
export type VideoPollFn = (status: string, attempt: number) => void | Promise<void>;

/** 可灵 / 即梦（DashScope 异步托管） */
export class DashScopeVideo implements VideoGenProvider {
  readonly name: string;
  private client: DashScopeAsyncClient;
  private media: MediaStore;

  constructor(env: Env, media: MediaStore, kind: 'kling' | 'seedance', private onPoll?: VideoPollFn) {
    this.name = kind === 'kling' ? 'kling-v3' : 'seedance';
    const base = env.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
    const model = (kind === 'kling' ? env.VIDEO_MODEL : undefined) ?? (kind === 'kling' ? 'kling-v3' : 'seedance-02');
    // DashScope 图生视频走 /image2video/<model>；模型 id 需与配置的 VIDEO_MODEL 一致
    this.client = new DashScopeAsyncClient(this.name, base, env.DASHSCOPE_API_KEY ?? '', model, `image2video/${model}`);
    this.media = media;
  }

  async generate(req: ImageToVideoRequest): Promise<string> {
    // 视频模型要求图片为公网 URL（不接受 base64 dataURL）；用 r2 公共桶地址即可被百炼抓取。
    // 百炼图生视频规范：图片放 input.img_url，prompt 放 input，时长/分辨率放顶层 parameters。
    const image = await this.media.getPublicURL(req.tryOnImageKey);
    const resolution = (req.options.resolution ?? '1080p').toUpperCase(); // 枚举为大写 1080P/720P
    const { taskId } = await this.client.submitTask(
      { img_url: image, prompt: req.prompt ?? '' },
      {
        parameters: {
          duration: req.duration,
          resolution,
          aspect_ratio: '16:9',
        },
      },
    );
    this.onPoll?.(`已提交图生视频任务 task_id=${taskId}`, 0);
    let out: string | null = null;
    for (let i = 0; i < 50 && !out; i++) {
      const r = await this.client.pollTask(taskId);
      this.onPoll?.(`task_status=${r.status}${r.outputUrl ? ' (已产出)' : ''}`, i + 1);
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
  onPoll?: VideoPollFn,
): VideoGenProvider {
  if (env.DASHSCOPE_API_KEY) return new DashScopeVideo(env, media, kind, onPoll);
  return new WorkersAiVideo(env);
}