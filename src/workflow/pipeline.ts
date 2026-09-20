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

    // 2. 输入落 R2（人物图 + 商品图）
    const inputs = await step.do('ingest inputs to R2', async () => {
      const current = await this.requireJob(store, jobId);
      const personRef = await media.ingestFromURL(jobId, 'person', current.personImage.value);
      const garmentSrc = parsed?.garmentImage?.value ?? current.garment.value;
      const garmentRef = await media.ingestFromURL(jobId, 'garment', garmentSrc);
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
      const vton = buildVton(cfg, media);
      const bytes = await vton.tryOn({
        personImage: inputs.person,
        garmentImage: inputs.garment,
        category: parsed?.category,
      });
      const key = media.key(jobId, 'tryon', 'png');
      await media.saveBytes(key, bytes, 'image/png');
      current.tryOn = { output: { kind: 'r2', value: key }, provider: vton.name };
      pushLog(current, 'tryon', 'info', `试穿完成 (${vton.name})`);
      await store.save(current);
      return key;
    });

    // 4. 图生视频（工具统一内部完成 提交→轮询→产出下载URL；如需逐轮推进请拆分提交/轮询两步）
    const videoKey = await step.do('image-to-video', async () => {
      const current = await this.requireJob(store, jobId);
      current.stage = 'video';
      await store.save(current);
      const gen = buildVideo(cfg, media, videoKind(cfg.VIDEO_MODEL));
      const prompt = composePrompt({
        title: current.parsed?.title,
        category: parsed?.category,
        duration: current.options.duration,
      });
      const downloadURL = await gen.generate({
        tryOnImageKey: tryOnKey,
        options: current.options,
        duration: current.options.duration,
        prompt,
      });
      const key = media.key(jobId, 'video', 'mp4');
      const resp = await fetch(downloadURL);
      if (!resp.ok) throw new Error(`下载成品视频失败: HTTP ${resp.status}`);
      await media.saveBytes(key, resp.body!, 'video/mp4');
      current.video = { output: { kind: 'r2', value: key }, provider: gen.name, prompt };
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
        const res = await pub.publish({ jobId, videoR2Key: videoKey, title: current.parsed?.title ?? `AI 换装短视频 ${jobId}` });
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

    return { jobId, status: 'succeeded' };
  }

  private buildRegistry(media: MediaStore, cfg: Env): PublisherRegistry {
    return new PublisherRegistry([
      new DouyinPublisher(cfg, media),
      new WeixinChannelsPublisher(cfg, media),
      new XiaohongshuPublisher(cfg, media),
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