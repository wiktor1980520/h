// store/d1.ts — D1 持久化层（任务 CRUD + 发布流水，payload 按 JSON 存储）
import type { Env } from '../env';
import type { Job, JobStatus, Model, ModelInfo, Platform, PublishLogRecord } from '../types';

export interface ListResult {
  items: Job[];
  cursor?: string;
}

export function rowToJob(row: { payload: string }): Job {
  return JSON.parse(row.payload) as Job;
}

function parseInfo(raw: string | null | undefined): ModelInfo {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function rowToModel(r: ModelRow): Model {
  return {
    id: r.id,
    name: r.name,
    photoKeys: JSON.parse(r.photo_keys || '[]') as string[],
    info: parseInfo(r.info),
    createdAt: r.created_at,
  };
}

export class JobStore {
  constructor(private env: Env) {}

  // ---- 发布流水（独立发布/多次发布/计数） ----
  async addPublishLog(r: PublishLogRecord): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO publish_log (id, job_id, platform, status, external_id, url, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(r.id, r.jobId, r.platform, r.status, r.externalId ?? null, r.url ?? null, r.error ?? null, r.createdAt)
      .run();
  }

  async publishLogs(jobId: string): Promise<PublishLogRecord[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT id, job_id, platform, status, external_id, url, error, created_at
       FROM publish_log WHERE job_id = ? ORDER BY rowid DESC`,
    )
      .bind(jobId)
      .all<PublishLogRow>();
    return results.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      platform: r.platform as Platform,
      status: r.status as PublishLogRecord['status'],
      externalId: r.external_id ?? undefined,
      url: r.url ?? undefined,
      error: r.error ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** 每个平台的发布计数（成功/失败/总次数） */
  async publishCounts(jobId: string): Promise<Record<string, { published: number; failed: number; total: number }>> {
    const { results } = await this.env.DB.prepare(
      `SELECT platform, status, COUNT(*) AS n FROM publish_log WHERE job_id = ? GROUP BY platform, status`,
    )
      .bind(jobId)
      .all<{ platform: Platform; status: string; n: number }>();
    const counts: Record<string, { published: number; failed: number; total: number }> = {};
    for (const r of results) {
      counts[r.platform] ??= { published: 0, failed: 0, total: 0 };
      const c = counts[r.platform];
      if (r.status === 'published') c.published += r.n;
      else if (r.status === 'failed') c.failed += r.n;
      c.total += r.n;
    }
    return counts;
  }

  // ---- 模特库 ----
  async createModel(m: Model): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO models (id, name, photo_keys, info, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(m.id, m.name, JSON.stringify(m.photoKeys), JSON.stringify(m.info ?? {}), m.createdAt)
      .run();
  }

  /** 更新模特（信息 / 姓名 / 照片）。只更新传入的字段，其余保留。 */
  async updateModel(id: string, patch: { name?: string; photoKeys?: string[]; info?: Model['info'] }): Promise<Model | null> {
    const cur = await this.getModel(id);
    if (!cur) return null;
    const next: Model = {
      ...cur,
      name: patch.name?.trim() || cur.name,
      photoKeys: patch.photoKeys ?? cur.photoKeys,
      info: patch.info ?? cur.info,
    };
    await this.env.DB.prepare('UPDATE models SET name = ?, photo_keys = ?, info = ? WHERE id = ?')
      .bind(next.name, JSON.stringify(next.photoKeys), JSON.stringify(next.info ?? {}), id)
      .run();
    return next;
  }

  async listModels(): Promise<Model[]> {
    const { results } = await this.env.DB.prepare('SELECT * FROM models WHERE deleted_at IS NULL ORDER BY rowid DESC').all<ModelRow>();
    return results.map(rowToModel);
  }

  async getModel(id: string): Promise<Model | null> {
    const res = await this.env.DB.prepare('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL').bind(id).first<ModelRow>();
    return res ? rowToModel(res) : null;
  }

  async deleteModel(id: string): Promise<void> {
    await this.env.DB.prepare('DELETE FROM models WHERE id = ?').bind(id).run();
  }

  async create(job: Job): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO jobs (id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(job.id, job.status, JSON.stringify(job), job.createdAt, job.updatedAt)
      .run();
  }

  async get(id: string): Promise<Job | null> {
    const row = await this.env.DB.prepare('SELECT payload FROM jobs WHERE id = ?')
      .bind(id)
      .first<{ payload: string }>();
    return row ? rowToJob(row) : null;
  }

  async save(job: Job): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE jobs SET status = ?, payload = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(job.status, JSON.stringify(job), job.updatedAt, job.id)
      .run();
  }

  /** 软删除：写入 deleted_at，保留任务与其媒体文件 */
  async softDelete(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(`UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, id)
      .run();
  }

  /** 从回收站恢复：清空 deleted_at */
  async restore(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(`UPDATE jobs SET deleted_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, id)
      .run();
  }

  /** 彻底删除：物理删除记录及其全部关联内容(发布流水)；媒体文件由调用方另行清理 */
  async permanentDelete(id: string): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM publish_log WHERE job_id = ?').bind(id),
      this.env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id),
    ]);
  }

  async list(status?: JobStatus, limit = 50, cursor?: string): Promise<ListResult> {
    let q = 'SELECT payload, created_at FROM jobs WHERE deleted_at IS NULL';
    const binds: (string | number | boolean)[] = [];
    if (status) {
      q += ' AND status = ?';
      binds.push(status);
    }
    q += ' ORDER BY created_at DESC LIMIT ?';
    binds.push(limit + 1); // 多取一条用于判断是否还有更多

    const { results } = await this.env.DB.prepare(q).bind(...binds).all<{ payload: string; created_at: string }>();
    const hasMore = results.length > limit;
    const rows = hasMore ? results.slice(0, limit) : results;
    return {
      items: rows.map((r) => rowToJob(r)),
      cursor: hasMore ? rows[rows.length - 1].created_at : undefined,
    };
  }

  /** 回收站列表：仅已软删除的任务 */
  async listDeleted(limit = 50, cursor?: string): Promise<ListResult> {
    const q = 'SELECT payload, deleted_at FROM jobs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?';
    const { results } = await this.env.DB.prepare(q).bind(limit + 1).all<{ payload: string; deleted_at: string }>();
    const hasMore = results.length > limit;
    const rows = hasMore ? results.slice(0, limit) : results;
    return {
      items: rows.map((r) => rowToJob(r)),
      cursor: hasMore ? rows[rows.length - 1].deleted_at : undefined,
    };
  }
}

interface PublishLogRow {
  id: string;
  job_id: string;
  platform: string;
  status: string;
  external_id: string | null;
  url: string | null;
  error: string | null;
  created_at: string;
}

interface ModelRow {
  id: string;
  name: string;
  photo_keys: string;
  info: string | null;
  created_at: string;
}