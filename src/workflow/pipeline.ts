// workflow/pipeline.ts — 多步骤任务 Workflow
// 流程：load job → 解析商品(link) → 取人物图/商品图入 R2 → 虚拟试穿 → 图生视频 →
//      多平台发布 → 收尾。每个可重入步骤都以 step.do 包裹并回写 D1（幂等 upsert）。
import { NonRetryableError } from 'cloudflare:workflows';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Job, PublishTarget } from '../types';
import { pushLog } from '../types';
import { PublisherRegistry } from '../publish';
import { DouyinPublisher } from '../publish/douyin';
import { WeixinChannelsPublisher } from '../publish/weixin';
import { XiaohongshuPublisher } from '../publish/xiaohongshu';
import { MetaPublisher } from '../publish/meta';
import { TikTokPublisher } from '../publish/tiktok';
import { GarmentParser } from '../providers/parser';
import { buildVton } from '../providers/vton';
import { buildVideo } from '../providers/video';
import { MediaStore } from '../storage/r2';
import { JobStore } from '../store/d1';
import { overlayConfig } from '../store/config';

export interface PipelineParams {
  jobId: string;
}

type Step = Parameters<WorkflowEntrypoint<Env, PipelineParams>['run']>[1];
type WfEvent = Parameters<WorkflowEntrypoint<Env, PipelineParams>['run']>[0];

export class HuangtoolsPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WfEvent, step: Step) {
    const { jobId } = event.payload;
    const store = new JobStore(this.env);
    const media = new MediaStore(this.env, this.env.R2_PUBLIC_BASE);
    try {
      await this.main(event, step, store, media);
      return { jobId, status: 'succeeded' };
    } catch (e) {
      // 任何步骤最终失败：把任务落为 failed，避免任务永远停留在 running 假象
      const job = await store.get(jobId).catch(() => null);
      if (job && job.status !== 'canceled') {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
        pushLog(job, 'error', 'error', `流程失败: ${job.error}`);
        await store.save(job).catch(() => {});
      }
      throw e;
    }
  }

  private async main(event: WfEvent, step: Step, store: JobStore, media: MediaStore): Promise<void> {
    const { jobId } = event.payload;
    // 第三方 key 以数据库配置优先，env 兜底
    const cfg = await overlayConfig(this.env);

    const job = await this.requireJob(store, jobId);
    job.status = 'running';
    job.workflowInstanceId = event.instanceId;
    pushLog(job, 'init', 'info', '工作流启动');
    await store.save(job);

    // 1. 解析商品（link 源 → 商品图 URL）——非 link 直接透传
    const parsed = await step.do('parse garment', async () => {
      const current = await this.requireJob(store, jobId);
      let result = current.parsed;
      if (current.garment.source === 'link') {
        const p = await new GarmentParser(cfg).parse(current.garment.value);
        pushLog(current, 'parse', 'info', `解析到商品图`);
        current.parsed = {
          garmentImage: { kind: 'url', value: p.garmentImageURL },
          title: p.title,
          price: p.price,
          category: p.category,
          from: p.from,
        };
        current.stage = 'parse';
        await store.save(current);
        result = current.parsed;
      }
      return result;
    });

    // 2. 输入落 R2（人物图 + 商品图）——已上传的 R2 对象直接复用 key，url 才抓取
    const inputs = await step.do('ingest inputs to R2', async () => {
      const current = await this.requireJob(store, jobId);
      const personRef =
        current.personImage.kind === 'r2'
          ? current.personImage
          : await media.ingestFromURL(jobId, 'person', current.personImage.value);
      const garmentRef =
        parsed?.garmentImage?.kind === 'r2' || current.garment.kind === 'r2'
          ? (parsed?.garmentImage ?? current.garment)
          : await media.ingestFromURL(jobId, 'garment', parsed?.garmentImage?.value ?? current.garment.value);
      if (!current.parsed) current.parsed = {};
      current.parsed.garmentImage = garmentRef;
      current.personImage = personRef;
      pushLog(current, 'parse', 'info', '输入资源已落 R2');
      await store.save(current);
      return { person: personRef, garment: garmentRef };
    });

    // 3. 虚拟试穿 → 结果图 R2 key
    const tryOnKey = await step.do('virtual try-on', async () => {
      const current = await this.requireJob(store, jobId);
      current.stage = 'tryon';
      await store.save(current);
      const vton = buildVton(cfg, media, async (status, attempt) => {
        pushLog(current, 'tryon', 'info', `轮询 ${attempt}: ${status}`);
        await store.save(current).catch(() => {});
      });
      const bytes = await vton.tryOn({
        personImage: inputs.person,
        garmentImage: inputs.garment,
        category: parsed?.category,
      });
      // aitryon 返回的是 JPEG（但旧实现按 png 存，导致扩展名/类型与内容不符、后续模型解码失败）
      const { ext, ct } = detectImageType(bytes);
      const key = media.key(jobId, 'tryon', ext);
      await media.saveBytes(key, bytes, ct);
      current.tryOn = { output: { kind: 'r2', value: key }, provider: vton.name };
      pushLog(current, 'tryon', 'info', `试穿完成 (${vton.name})`);
      await store.save(current);
      return key;
    });

    // 4. 图生视频：分「提交 / 轮询 / 落库」三个顶层步骤，轮询间隔用 step.sleep（每次唤醒重置子请求配额，
    //    避免单次调用内循环 fetch 超过 Worker 的 50 子请求上限 → 'Too many subrequests'）。
    // 4a. 提交（幂等：已有 taskId 则复用）
    const vid = await step.do('submit video task', async () => {
      const current = await this.requireJob(store, jobId);
      if (current.video?.taskId) return { taskId: current.video.taskId };
      current.stage = 'video';
      await store.save(current);
      const gen = buildVideo(cfg, media, videoKind(cfg.VIDEO_MODEL), async (status, attempt) => {
        pushLog(current, 'video', 'info', `轮询 ${attempt}: ${status}`);
        await store.save(current).catch(() => {});
      });
      const prompt = composePrompt({
        title: current.parsed?.title,
        category: parsed?.category,
        duration: current.options.duration,
      });
      const { taskId } = await gen.submit({
        tryOnImageKey: tryOnKey,
        options: current.options,
        duration: current.options.duration,
        prompt,
      });
      current.video = { ...current.video, taskId, provider: gen.name, prompt };
      await store.save(current);
      return { taskId };
    });

    // 4b. 轮询（每次查询一个独立 step，间隔用 step.sleep，直至成功/失败/超时）
    let videoURL: string | null = null;
    for (let i = 0; i < 60 && !videoURL; i++) {
      const r = await step.do(`poll video task ${i}`, async () => {
        const current = await this.requireJob(store, jobId);
        const gen = buildVideo(cfg, media, videoKind(cfg.VIDEO_MODEL), async (status, attempt) => {
          pushLog(current, 'video', 'info', `轮询 ${attempt}: ${status}`);
          await store.save(current).catch(() => {});
        });
        const res = await gen.poll(vid.taskId);
        pushLog(current, 'video', 'info', `轮询 ${i + 1}: task_status=${res.status}${res.url ? ' (已产出)' : ''}`);
        await store.save(current).catch(() => {});
        return res;
      });
      if (r.status === 'FAILED') throw new Error(`图生视频失败: ${r.error}`);
      if (r.status === 'SUCCEEDED' && r.url) { videoURL = r.url; break; }
      await step.sleep(`wait video ${i}`, '6 seconds');
    }
    if (!videoURL) throw new Error('图生视频超时');

    // 4c. 下载落 R2
    const videoKey = await step.do('persist video', async () => {
      const current = await this.requireJob(store, jobId);
      const key = media.key(jobId, 'video', 'mp4');
      const resp = await fetch(videoURL);
      if (!resp.ok) throw new Error(`下载成品视频失败: HTTP ${resp.status}`);
      await media.saveBytes(key, resp.body!, 'video/mp4');
      current.video = { ...current.video, output: { kind: 'r2', value: key } };
      pushLog(current, 'video', 'info', '视频生成并落库');
      await store.save(current);
      return key;
    });

    // 5. 发布（manualPublish 时生成后不自动发，等用户在页面手动触发）
    await step.do('publish to platforms', async () => {
      const current = await this.requireJob(store, jobId);
      current.stage = 'publish';
      const targets = current.publish.length ? current.publish : defaultTargets(cfg.PUBLISH_ON);
      current.publish = targets;
      await store.save(current);

      if (current.options.manualPublish) {
        for (const t of targets) {
          t.status = 'manual';
          t.error = undefined;
        }
        pushLog(current, 'publish', 'info', '已完成生成，等待手动发布');
        await store.save(current);
        return;
      }

      const registry = this.buildRegistry(media, cfg);
      for (const target of targets) {
        const pub = registry.get(target.platform);
        if (!pub || !pub.ready) {
          target.status = 'failed';
          target.error = '平台未配置或未就绪';
          continue;
        }
        const res = await pub.publish({
          jobId,
          videoR2Key: videoKey,
          title: target.title ?? current.parsed?.title ?? `AI 换装短视频 ${jobId}`,
          desc: target.desc,
          tags: target.tags,
          productId: target.productId,
          accountId: target.accountId,
        });
        await store.addPublishLog({
          id: crypto.randomUUID(),
          jobId,
          platform: target.platform,
          status: res.status,
          externalId: res.externalId,
          url: res.url,
          error: res.error,
          createdAt: new Date().toISOString(),
        });
        if (res.status === 'published') {
          target.status = 'published';
          target.externalId = res.externalId;
          target.url = res.url;
          target.publishedAt = new Date().toISOString();
          pushLog(current, 'publish', 'info', `${target.platform} 已发布`);
        } else {
          target.status = 'failed';
          target.error = res.error;
          pushLog(current, 'publish', 'error', `${target.platform} 发布失败: ${res.error}`);
        }
      }
      await store.save(current);
    });

    // 6. 收尾
    await step.do('finish', async () => {
      const current = await this.requireJob(store, jobId);
      current.status = 'succeeded';
      current.stage = 'done';
      pushLog(current, 'done', 'info', '全部完成');
      await store.save(current);
    });
  }

  private buildRegistry(media: MediaStore, cfg: Env): PublisherRegistry {
    return new PublisherRegistry([
      new DouyinPublisher(cfg, media),
      new WeixinChannelsPublisher(cfg, media),
      new XiaohongshuPublisher(cfg, media),
      new MetaPublisher(cfg, media, 'instagram'),
      new MetaPublisher(cfg, media, 'facebook'),
      new TikTokPublisher(cfg, media),
    ]);
  }

  private async requireJob(store: JobStore, id: string): Promise<Job> {
    const j = await store.get(id);
    if (!j) throw new NonRetryableError(`任务不存在: ${id}`);
    if (j.status === 'canceled') throw new NonRetryableError('任务已取消');
    return j;
  }
}

function videoKind(model: string | undefined): 'kling' | 'seedance' {
  return model?.startsWith('seedance') ? 'seedance' : 'kling';
}

/** 组装可读、可视化的生成提示词（结构化描述，供前端展示） */
function composePrompt(opts: { title?: string; category?: string; duration: number }): string {
  const cat = opts.category ?? 'dress';
  const catText =
    cat === 'top' ? '上装' : cat === 'bottom' ? '下装' : '连衣裙';
  return `【女装电商展示】模特身着${catText}${opts.title ? `（商品：${opts.title}）` : ''}，自然行走转身展示穿着效果，背景简洁干净，光线均匀，${opts.duration}秒运镜流畅，突出服装版型与细节，画面质感真实。`;
}

function defaultTargets(pubOn: string | undefined): PublishTarget[] {
  return (pubOn ?? 'douyin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ platform: p as PublishTarget['platform'], status: 'pending' }));
}

/** 依据字节魔数识别图片真实格式（避免扩展名/类型与内容不符导致下游模型解码失败） */
function detectImageType(bytes: ArrayBuffer): { ext: string; ct: 'image/png' | 'image/jpeg' | 'image/webp' } {
  const b = new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', ct: 'image/jpeg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50) return { ext: 'png', ct: 'image/png' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49) return { ext: 'webp', ct: 'image/webp' };
  return { ext: 'png', ct: 'image/png' };
}