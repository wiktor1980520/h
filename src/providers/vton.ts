// providers/vton.ts — 虚拟试穿（VTON）：人物图 × 商品图 → 试穿结果图
// 支持两路：DashScope/百炼托管模型（默认）、Workers AI 评估路径（占位，标注当前限制）。
import type { Env } from '../env';
import { MediaStore } from '../storage/r2';
import type { MediaRef } from '../types';
import { DashScopeAsyncClient } from './async';

export interface TryOnRequest {
  personImage: MediaRef; // r2 key
  garmentImage: MediaRef; // r2 key
  category?: 'top' | 'bottom' | 'dress';
  prompt?: string;
}

export interface VtonProvider {
  readonly name: string;
  /** 返回试穿结果图字节 */
  tryOn(req: TryOnRequest): Promise<ArrayBuffer>;
}

/** 外部托管试穿：百炼 OutfitAnyone / IDM 托管，DashScope 异步任务 */
export class DashScopeVton implements VtonProvider {
  readonly name = 'dashscope-aitryon';
  private client: DashScopeAsyncClient;
  private media: MediaStore;

  constructor(env: Env, media: MediaStore) {
    const base = env.IMAGE_TO_VIDEO_ENDPOINT ?? 'https://dashscope.aliyuncs.com';
    const model = env.TRYON_MODEL ?? 'aitryon';
    this.client = new DashScopeAsyncClient('dashscope-vton', base, env.DASHSCOPE_API_KEY ?? '', model, 'image2image/image-synthesis');
    this.media = media;
  }

  async tryOn(req: TryOnRequest): Promise<ArrayBuffer> {
    if (!req.personImage || req.personImage.kind !== 'r2' || !req.garmentImage || req.garmentImage.kind !== 'r2') {
      throw new Error('试穿需要 R2 中的人物图与商品图');
    }
    // aitryon 要求图片为公网 HTTP/HTTPS 地址，经 worker /media/ 绝对地址传入
    const personURL = await this.media.getPublicURL(req.personImage.value);
    const garmentURL = await this.media.getPublicURL(req.garmentImage.value);
    const input: Record<string, string> = { person_image_url: personURL };
    if (req.category === 'bottom') input.bottom_garment_url = garmentURL;
    else input.top_garment_url = garmentURL; // 上装 / 连衣裙(通装) 走 top_garment_url
    const { taskId } = await this.client.submitTask({
      ...input,
      parameters: { resolution: -1, restore_face: true },
    });
    const url = await pollUntilDone(this.client, taskId, 60);
    return downloadBytes(url);
  }
}

/** Workers AI 评估路径：当前目录尚无专用试穿模型，占位并抛清晰错误，便于接入自托管模型 */
export class WorkersAiVton implements VtonProvider {
  readonly name = 'workers-ai(vton未上线)';
  constructor(private env: Env, private media: MediaStore) {}

  async tryOn(req: TryOnRequest): Promise<ArrayBuffer> {
    // 用例：Future 若 Workers AI 上线 image-to-image 换装模型，可在此调用 env.AI.run(model, {…images})
    throw new Error(
      'Workers AI 当前未提供虚拟试穿模型，请在配置中改用外部托管（DASHSCOPE_API_KEY + TRYON_MODEL）。',
    );
  }
}

export function buildVton(env: Env, media: MediaStore): VtonProvider {
  // 倾向外部托管；Workers AI 路径通过切换实现体现（当前会抛提示）。
  if (env.DASHSCOPE_API_KEY) return new DashScopeVton(env, media);
  return new WorkersAiVton(env, media);
}

async function pollUntilDone(
  client: DashScopeAsyncClient,
  taskId: string,
  maxAttempts: number,
): Promise<string> {
  let out: string | null = null;
  for (let i = 0; i < maxAttempts && !out; i++) {
    const r = await client.pollTask(taskId);
    if (r.status === 'FAILED') throw new Error(`试穿失败: ${r.error}`);
    if (r.status === 'SUCCEEDED' && r.outputUrl) out = r.outputUrl;
    else await sleepMs(4000);
  }
  if (!out) throw new Error('试穿超时');
  return out;
}

async function downloadBytes(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载试穿结果失败: HTTP ${resp.status}`);
  return resp.arrayBuffer();
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}