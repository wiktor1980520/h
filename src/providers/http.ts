// providers/http.ts — 轻量 HTTP JSON 客户端
export interface HttpOptions {
  baseUrl?: string;
  apiKey?: string;
  bearerPrefix?: string;
  timeoutMs?: number;
}

export class HttpClient {
  constructor(private opts: HttpOptions) {}

  async postJson<T = any>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request('POST', path, JSON.stringify(body), headers);
  }

  async request<T = any>(method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
      if (this.opts.apiKey) {
        h.authorization = `${this.opts.bearerPrefix ?? 'Bearer'} ${this.opts.apiKey}`;
      }
      const finalUrl = /^https?:\/\//.test(url) ? url : `${this.opts.baseUrl ?? ''}${url}`;
      const resp = await fetch(finalUrl, { method, headers: h, body, signal: ctl.signal });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
      }
      // 有些端点返回 204 或无 body
      const raw = await resp.text();
      return raw ? (JSON.parse(raw) as T) : (undefined as T);
    } finally {
      clearTimeout(timer);
    }
  }
}