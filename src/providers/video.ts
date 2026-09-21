// providers/video.ts — 图生视频：试穿结果图 → 15s 短视频
// 支持可灵(Kling v3) / 即梦(Seedance) 等 DashScope 托管；Workers AI 视频路径当前未上线，占位。
import type { Env } from '../env';
import { MediaStore } from '../storage/r2';
import type { VideoOptions } from '../types';
import type { Sleeper } from './vton';
import { sleepMs } from './vton';
import { DashScopeAsyncClient } from './async';

export interface ImageToVideoRequest {
  tryOnImageKey: string; // R2 key 的试穿结果图
  options: VideoOptions;
  duration: number; // 秒
  prompt?: string;
}

export interface VideoSubmitResult {
  /** DashScope 异步任务 id（供后续轮询） */
  taskId: string;
}
export interface VideoPollResult {
  status: string;
  url?: string;
  error?: string;
}

export interface VideoGenProvider {
  readonly name: string;
  /** 提交图生视频，返回异步任务 id（供轮询） */
  submit(req: ImageToVideoRequest): Promise<VideoSubmitResult>;
  /** 查询一次任务状态 */
  poll(taskId: string): Promise<VideoPollResult>;
  /** 提交→轮询→返回视频真实下载 URL（整体便捷，单次调用轮询量受子请求上限约束） */
  generate(req: ImageToVideoRequest): Promise<string>;
}

/** 图生视频过程中的可观测回调（写入任务日志，便于排查） */
export type VideoPollFn = (status: string, attempt: number) => void | Promise<void>;

/** 可灵 / 即梦（DashScope 异步托管） */
export class DashScopeVideo implements VideoGenProvider {
  readonly name: string;
  private client: DashScopeAsyncClient;
  private media: MediaStore;

  constructor(
    env: Env,
    media: MediaStore,
    kind: 'kling' | 'seedance',
    private onPoll?: VideoPollFn,
    private sleeper: Sleeper = sleepMs,
  ) {
    const model = (kind === 'kling' ? env.VIDEO_MODEL : undefined) ?? (kind === 'kling' ? 'kling-v3' : 'seedance-02');
    this.name = model;
    const base = env.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
    // Wan 系列走独立的 video-generation/video-synthesis（地域专属 maas 端点），其余走 image2video/<model>
    const wan = model.toLowerCase().startsWith('wan');
    this.wan = wan;
    const servicePath = wan ? 'video-generation/video-synthesis' : `image2video/${model}`;
    this.client = new DashScopeAsyncClient(this.name, base, env.DASHSCOPE_API_KEY ?? '', model, servicePath);
    this.media = media;
  }
  private wan = false;

  private async buildBody(req: ImageToVideoRequest): Promise<{ input: Record<string, unknown>; parameters: Record<string, unknown> }> {
    // 视频模型要求图片为公网 URL（不接受 base64 dataURL）；用 r2 公共桶地址即可被百炼抓取
    const image = await this.media.getPublicURL(req.tryOnImageKey);
    const resolution = (req.options.resolution ?? '1080p').toUpperCase(); // 枚举为大写 1080P/720P
    const prompt = req.prompt ?? '';
    // Wan3.0 图生视频：首帧图放 input.media[{type:first_frame,url}]，比例用 ratio 参数
    const input = this.wan
      ? { prompt, media: [{ type: 'first_frame', url: image }] }
      : { prompt, img_url: image };
    const parameters = this.wan
      ? { resolution, ratio: 'adaptive', duration: req.duration, prompt_extend: true }
      : { resolution, duration: req.duration, aspect_ratio: '16:9' };
    return { input, parameters };
  }

  async submit(req: ImageToVideoRequest): Promise<VideoSubmitResult> {
    const { input, parameters } = await this.buildBody(req);
    const { taskId } = await this.client.submitTask(input, { parameters });
    this.onPoll?.(`已提交图生视频任务 task_id=${taskId}`, 0);
    return { taskId };
  }

  async poll(taskId: string): Promise<VideoPollResult> {
    const r = await this.client.pollTask(taskId);
    return { status: r.status, url: r.outputUrl ?? undefined, error: r.error };
  }

  async generate(req: ImageToVideoRequest): Promise<string> {
    const { taskId } = await this.submit(req);
    let out: string | null = null;
    for (let i = 0; i < 50 && !out; i++) {
      const r = await this.poll(taskId);
      this.onPoll?.(`task_status=${r.status}${r.url ? ' (已产出)' : ''}`, i + 1);
      if (r.status === 'FAILED') throw new Error(`图生视频失败: ${r.error}`);
      if (r.status === 'SUCCEEDED' && r.url) out = r.url;
      else if (i < 49) await this.sleeper(6000);
    }
    if (!out) throw new Error('图生视频超时');
    return out;
  }
}

/** Workers AI 视频生成评估路径：当前占位，抛出清晰提示 */
export class WorkersAiVideo implements VideoGenProvider {
  readonly name = 'workers-ai(video未上线)';
  constructor(private env: Env) {}

  private unsupported(): never {
    // Workers AI 目前以文本/图像/嵌入为主，尚无 stable 图生视频 API。
    throw new Error('Workers AI 尚无图生视频稳定接口，请配置 DASHSCOPE_API_KEY + VIDEO_MODEL 走可灵/即梦。');
  }

  async submit(): Promise<VideoSubmitResult> {
    return this.unsupported();
  }
  async poll(): Promise<VideoPollResult> {
    return this.unsupported();
  }
  async generate(): Promise<string> {
    return this.unsupported();
  }
}

export function buildVideo(
  env: Env,
  media: MediaStore,
  kind: 'kling' | 'seedance' = 'kling',
  onPoll?: VideoPollFn,
  sleeper?: Sleeper,
): VideoGenProvider {
  if (env.DASHSCOPE_API_KEY) return new DashScopeVideo(env, media, kind, onPoll, sleeper);
  return new WorkersAiVideo(env);
}