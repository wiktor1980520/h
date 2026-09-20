// providers/parser.ts — 电商商品链接解析：抓取页面 → 抽取商品图（og:image / 常见占位）
import type { Env } from '../env';
import { classifyGarment, type Category } from './llm';

export interface ParseResult {
  garmentImageURL: string;
  title?: string;
  price?: string;
  category: Category;
  from: string;
}

const META_PATTERNS: Array<{ attr: string; name: [string, ...string[]] }> = [
  { attr: 'property', name: ['og:image'] },
  { attr: 'name', name: ['og:image', 'twitter:image', 'twitter:image:src', 'itemprop'] },
];

export class GarmentParser {
  constructor(private env: Env) {}

  async parse(rawURL: string): Promise<ParseResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), parseInt(this.env.PARSE_TIMEOUT_MS || '25000', 10));
    let html: string;
    try {
      const resp = await fetch(rawURL, {
        headers: {
          'user-agent': this.env.PARSER_UA ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (!resp.ok) throw new Error(`商品页抓取失败: HTTP ${resp.status}`);
      html = await resp.text();
    } finally {
      clearTimeout(timer);
    }

    const meta = extractMetas(html);
    const title = firstMeta(meta, 'og:title') ?? firstMeta(meta, 'twitter:title') ?? extractTitle(html);
    const price = extractPrice(html);
    let img = firstMeta(meta, 'og:image') ?? firstMeta(meta, 'twitter:image');
    if (!img) {
      // 兜底：取页面首个 <img> 的 src
      const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
      if (m) img = m[1];
    }
    if (!img) throw new Error('未能从链接抽取到商品图');
    img = normalizeSrc(img, rawURL);

    const category = await classifyGarment(this.env, title ?? img);
    return { garmentImageURL: img, title, price, category: category, from: rawURL };
  }
}

function extractMetas(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<meta([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1];
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (!content) continue;
    for (const p of META_PATTERNS) {
      for (const name of p.name) {
        const attrRe = new RegExp(`${p.attr}=["']${name.replace(/[-:[\]()]/g, '\\$&')}["']`, 'i');
        if (attrRe.test(tag) && !map.has(name)) {
          map.set(name, decodeEntities(content));
        }
      }
    }
  }
  return map;
}

function firstMeta(map: Map<string, string>, key: string): string | undefined {
  return map.get(key)?.trim() || undefined;
}

function extractTitle(html: string): string | undefined {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || undefined;
}

function extractPrice(html: string): string | undefined {
  // 粗糙匹配 price 属性；仅作展示用
  const re = /"price"{1,3}\s*:\s*"?(\d+\.?\d*)"?/i;
  const m = re.exec(html);
  return m ? m[1] : undefined;
}

function normalizeSrc(src: string, baseURL: string): string {
  src = decodeEntities(src);
  try {
    return new URL(src, baseURL).href;
  } catch {
    return src;
  }
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return map[e] ?? '';
  });
}