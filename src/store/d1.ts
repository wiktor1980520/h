// store/d1.ts — D1 持久化层（任务 CRUD，payload 按 JSON 存储）
import type { Env } from '../env';
import type { Job, JobStatus } from '../types';

export interface ListResult {
  items: Job[];
  cursor?: string;
}

export function rowToJob(row: { payload: string }): Job {
  return JSON.parse(row.payload) as Job;
}

export class JobStore {
  constructor(private env: Env) {}

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