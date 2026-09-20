// providers/llm.ts — 文本/分类推理。演示“外部 LLM”与“Workers AI”双路径切换。
import type { Env } from '../env';

export type Category = 'top' | 'bottom' | 'dress';

/** 依据商品标题粗判类目；USE_WORKERS_AI_LLM=true 时走 Workers AI 评估路径。 */
export async function classifyGarment(env: Env, title: string): Promise<Category> {
  const keywords = title.replace(/\s+/g, ' ');
  if (!env.USE_WORKERS_AI_LLM || env.USE_WORKERS_AI_LLM === 'false') {
    return keywordCategory(keywords);
  }
  // Workers AI 评估路径
  const model = env.WORKERS_AI_LLM ?? '@cf/meta/llama-3.1-8b-instruct';
  const prompt = [
    '你是女装商品分类助手。根据商品标题判断衣物类目，只输出 top/bottom/dress 之一。',
    `标题：${title}`,
    '答案：',
  ].join('\n');
  try {
    const out = await env.AI.run(model as never, { prompt, max_tokens: 8 } as never) as {
      response?: string;
      result?: { response?: string };
    };
    const raw = (out.response ?? out.result?.response ?? '').toLowerCase();
    if (raw.includes('dress') || raw.includes('裙')) return 'dress';
    if (raw.includes('bottom') || raw.includes('裤')) return 'bottom';
    return 'top';
  } catch {
    return keywordCategory(keywords);
  }
}

function keywordCategory(s: string): Category {
  s = s.toLocaleLowerCase();
  if (/(连衣裙|裙子|长裙|吊带裙|dress)/.test(s)) return 'dress';
  if (/(裤|短裤|半身裙|阔腿裤|pants)/.test(s)) return 'bottom';
  return 'top';
}