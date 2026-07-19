// src/lib/vsm/kv.ts — Block 12: swap-ready KV interface (mirrors storage.ts BlobStore).
// memoryKv() is a per-instance Map fallback (dev / no external KV). vercelKv() lazily binds to
// @vercel/kv when KV_REST_API_URL is set; without it, VSM degrades to request-memo + edge/CDN.
export interface KvStore {
  kind: string;
  enabled: boolean;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** In-process Map KV. `enabled` is true so tests exercise the KV path; it is NOT shared across
 *  serverless invocations, so in production it behaves like a tiny per-instance cache. */
export function memoryKv(): KvStore {
  const m = new Map<string, { v: unknown; exp: number }>();
  const now = () => Date.now();
  return {
    kind: 'memory', enabled: true,
    async get<T>(key: string) { const e = m.get(key); if (!e) return null; if (e.exp && e.exp < now()) { m.delete(key); return null; } return e.v as T; },
    async set(key, value, ttlSeconds) { m.set(key, { v: value, exp: ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0 }); },
    async del(key) { m.delete(key); },
  };
}

/** Optional shared KV. Enabled only when KV_REST_API_URL is present; else a disabled stub. */
export function vercelKv(): KvStore {
  const enabled = !!process.env.KV_REST_API_URL;
  if (!enabled) return { kind: 'disabled', enabled: false, async get() { return null; }, async set() {}, async del() {} };
  return {
    kind: 'vercel-kv', enabled: true,
    async get<T>(key: string) { const { kv } = await import('@vercel/kv' as any); return (await kv.get(key)) as T | null; },
    async set(key, value, ttlSeconds) { const { kv } = await import('@vercel/kv' as any); await kv.set(key, value, ttlSeconds > 0 ? { ex: ttlSeconds } : undefined); },
    async del(key) { const { kv } = await import('@vercel/kv' as any); await kv.del(key); },
  };
}

/** Select the KV tier: shared KV when provisioned, else a disabled stub (edge/CDN + memo only). */
export function getKv(): KvStore { return vercelKv(); }
