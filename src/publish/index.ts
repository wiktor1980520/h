// publish/index.ts — 发布器抽象与注册表
import type { Platform } from '../types';

export interface PublishRequest {
  jobId: string;
  videoR2Key: string;
  coverR2Key?: string;
  title: string;
  desc?: string;
  tags?: string[];
  /** 挂车商品 ID（抖音/视频号带货用） */
  productId?: string;
  /** 账号绑定（如抖音 open_id） */
  accountId?: string;
}

export interface PublishResult {
  platform: Platform;
  status: 'published' | 'failed';
  externalId?: string;
  url?: string;
  error?: string;
}

export interface Publisher {
  readonly platform: Platform;
  readonly ready: boolean;
  publish(req: PublishRequest): Promise<PublishResult>;
}

export class PublisherRegistry {
  private map = new Map<Platform, Publisher>();
  constructor(publishers: Publisher[]) {
    for (const p of publishers) this.map.set(p.platform, p);
  }
  register(p: Publisher) { this.map.set(p.platform, p); }
  get(platform: Platform): Publisher | undefined { return this.map.get(platform); }
  list(): Array<{ platform: Platform; ready: boolean }> {
    return [...this.map.values()].map((p) => ({ platform: p.platform, ready: p.ready }));
  }
}