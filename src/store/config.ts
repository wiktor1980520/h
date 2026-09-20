// store/config.ts — 第三方 key 的数据库配置（覆盖 worker 环境变量注入）
// 值以 AES-GCM 加密落库（DATA_ENCRYPTION_KEY）；未配置密钥时回退明文，便于本地开发。
import type { Env } from '../env';

/** 允许存进 DB 的第三方配置键（与 env.ts 中可选字段同名，便于叠加） */
export const CONFIG_KEYS = [
  'DASHSCOPE_API_KEY',
  'TRYON_MODEL',
  'VIDEO_MODEL',
  'IMAGE_TO_VIDEO_ENDPOINT',
  'KOLORS_OR_SEEDANCE_API_KEY',
  'DOUYIN_CLIENT_KEY',
  'DOUYIN_CLIENT_SECRET',
  'DOUYIN_ACCESS_TOKEN',
  'WEIXIN_CHANNELS_APPID',
  'WEIXIN_CHANNELS_ACCESS_TOKEN',
  'XHS_RPA_WEBHOOK',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export class ConfigStore {
  constructor(private env: Env) {}

  /** 返回全部已配置键的明文（DB 中密文经解密；缺密钥时读明文） */
  async all(): Promise<Record<string, string>> {
    const { results } = await this.env.DB.prepare('SELECT key, value FROM app_config').all<{ key: string; value: string }>();
    const secret = this.env.DATA_ENCRYPTION_KEY;
    const out: Record<string, string> = {};
    for (const r of results) {
      out[r.key] = secret ? (await decryptText(secret, r.value)) ?? r.value : r.value;
    }
    return out;
  }

  /** 写入/更新配置。value 为空 → 删除该键（便于清除）。 */
  async save(entries: Record<string, string>): Promise<void> {
    const secret = this.env.DATA_ENCRYPTION_KEY;
    const ts = new Date().toISOString();
    for (const [k, v] of Object.entries(entries)) {
      if (!CONFIG_KEYS.includes(k as ConfigKey)) continue;
      const stored = v === '' ? null : secret ? await encryptText(secret, v) : v;
      if (stored === null) {
        await this.env.DB.prepare('DELETE FROM app_config WHERE key = ?').bind(k).run();
      } else {
        await this.env.DB.prepare(
          `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
          .bind(k, stored, ts)
          .run();
      }
    }
  }
}

/** 叠加 DB 配置到 env：只覆盖已配置项，未配置的保持 env 值 */
export async function overlayConfig<T extends Env>(env: T): Promise<T> {
  const cfg = await new ConfigStore(env).all();
  return { ...env, ...cfg };
}

async function encryptText(secret: string, plain: string): Promise<string> {
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  const ivB64 = bytesToBase64(iv);
  const ctB64 = bytesToBase64(new Uint8Array(ct));
  return `${ivB64}.${ctB64}`;
}

async function decryptText(secret: string, payload: string): Promise<string | null> {
  try {
    const dot = payload.indexOf('.');
    if (dot < 0) return null;
    const iv = base64ToBytes(payload.slice(0, dot));
    const data = base64ToBytes(payload.slice(dot + 1));
    const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}