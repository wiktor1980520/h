// providers/async.ts — 通用“异步推理任务”抽象与 DashScope 风格实现
// DashScope：POST submit → { output: { task_id } }；GET /api/v1/tasks/{id} 轮询
// （可灵/即梦/百炼 OutfitAnyone 等托管推理统一走该模式；字段映射以目标模型为准）

export interface AsyncSubmitResult {
  taskId: string;
}

export interface AsyncPollResult {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  outputUrl?: string;
  error?: string;
}

export interface AsyncInferClient {
  readonly name: string;
  submitTask(payload: unknown): Promise<AsyncSubmitResult>;
  pollTask(taskId: string): Promise<AsyncPollResult>;
}

interface DashScopeTask {
  output?: {
    task_id?: string;
    results?: Array<{ url?: string; [k: string]: unknown }>;
    task_status?: string;
    message?: string;
  };
}

export class DashScopeAsyncClient implements AsyncInferClient {
  constructor(
    public readonly name: string,
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private servicePath: string, // 如 /api/v1/services/aigc/image2image/text2image
  ) {}

  async submitTask(
    payload: unknown,
    top?: { parameters?: Record<string, unknown> },
  ): Promise<AsyncSubmitResult> {
    const resp = await fetch(`${trimSlash(this.baseUrl)}/api/v1/services/aigc/${this.servicePath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        'x-dashscope-async': 'enable',
      },
      body: JSON.stringify({ model: this.model, input: payload, ...(top ?? {}) }),
    });
    const json = (await resp.json().catch(() => ({}))) as DashScopeTask;
    const taskId = json.output?.task_id;
    if (!resp.ok || !taskId) {
      throw new Error(`DASHSCOPE 提交失败 HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 400)}`);
    }
    return { taskId };
  }

  async pollTask(taskId: string): Promise<AsyncPollResult> {
    const resp = await fetch(`${trimSlash(this.baseUrl)}/api/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    const text = await resp.text();
    if (!resp.ok) {
      // 非 2xx：立即抛出，避免把错误当 PENDING 无限轮询导致任务假卡住
      throw new Error(`任务查询失败 HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text) as DashScopeTask;
    const st = (json.output?.task_status ?? 'PENDING').toUpperCase();
    const url = json.output?.results?.find((r) => r.url)?.url;
    if (st === 'FAILED') return { status: 'FAILED', error: json.output?.message ?? '任务失败' };
    if (st === 'SUCCEEDED') return { status: 'SUCCEEDED', outputUrl: url };
    return { status: st === 'RUNNING' ? 'RUNNING' : 'PENDING' };
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}