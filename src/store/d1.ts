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

  async list(status?: JobStatus, limit = 50, cursor?: string): Promise<ListResult> {
    let q = 'SELECT payload, created_at FROM jobs';
    const binds: (string | number | boolean)[] = [];
    if (status) {
      q += ' WHERE status = ?';
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

  async delete(id: string): Promise<void> {
    await this.env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  }
}