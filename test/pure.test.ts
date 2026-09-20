// test/pure.test.ts — 纯逻辑单元测试（不依赖 Cloudflare 运行时）
import { describe, expect, it } from 'vitest';
import { classifyGarment } from '../src/providers/llm';
import { emptyJob } from '../src/types';
import type { Env } from '../src/env';

const fakeEnv = {} as Env;

describe('classifyGarment（关键词路径）', () => {
  it('识别连衣裙为 dress', async () => {
    expect(await classifyGarment(fakeEnv, '夏季新款碎花连衣裙')).toBe('dress');
  });
  it('识别裤子为 bottom', async () => {
    expect(await classifyGarment(fakeEnv, '高腰阔腿裤 女')).toBe('bottom');
  });
  it('默认归为上装 top', async () => {
    expect(await classifyGarment(fakeEnv, '圆领短袖T恤')).toBe('top');
  });
});

describe('emptyJob 默认值', () => {
  it('默认 1080p / 15s / queued / init', () => {
    const job = emptyJob('j1', { garment: { kind: 'url', value: 'https://x/y.jpg', source: 'link' } });
    expect(job.status).toBe('queued');
    expect(job.stage).toBe('init');
    expect(job.options).toMatchObject({ resolution: '1080p', duration: 15, withSound: true });
    expect(job.garment.source).toBe('link');
    expect(job.logs).toEqual([]);
  });
});