// src/lib/storage.ts — a swap-ready object-storage interface (Prompt AP1). VOD media (audio/video)
// is stored through this so the backend (Vercel Blob today; S3/GCS/self-host later) swaps without
// touching callers. The ESSENTIAL part of a recording — the ordered animation SPEC timeline — lives
// in the kernel (no blob needed), so replay works even with no object store. Blob media needs
// BLOB_READ_WRITE_TOKEN; without it we fall back to an in-memory dev store and report it honestly
// (we never claim CDN-scale VOD from the dev fallback).
export interface StoredObject { url: string; key: string }
export interface BlobStore {
  kind: string;
  enabled: boolean;
  put(key: string, data: Uint8Array | Blob | ArrayBuffer | string, contentType: string): Promise<StoredObject | null>;
  url(key: string): string | null;
}

export function storageKey(kind: string, id: string, ext: string): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return `${kind}/${safe}-${Date.now()}.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

// ---- in-memory dev/test store (no external dependency) ----
export function memoryStore(): BlobStore {
  const mem = new Map<string, string>();
  return {
    kind: 'memory', enabled: true,
    async put(key, _data, _ct) { mem.set(key, 'mem://' + key); return { url: 'mem://' + key, key }; },
    url(key) { return mem.has(key) ? 'mem://' + key : null; },
  };
}

// ---- Vercel Blob adapter (real object storage; used when the token is configured) ----
function vercelBlobStore(): BlobStore {
  return {
    kind: 'vercel-blob', enabled: !!process.env.BLOB_READ_WRITE_TOKEN,
    async put(key, data, contentType) {
      try {
        const { put } = await import('@vercel/blob');
        const res = await put(key, data as any, { access: 'public', contentType, addRandomSuffix: false });
        return { url: (res as any).url, key };
      } catch { return null; }   // token missing / upload failed -> caller falls back to timeline-only
    },
    url() { return null; },       // Vercel Blob returns absolute urls at put time; no deterministic getter
  };
}

// ---- S3-compatible adapter (SOVEREIGN default: MinIO / Supabase Storage S3 / Cloudflare R2 /
// any S3 API). No vendor SDK — a single SigV4-signed PUT over standard HTTPS via node:crypto, so
// it adds zero dependencies and speaks the open S3 standard. Configure with S3_ENDPOINT,
// S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (+ optional S3_REGION, S3_PUBLIC_BASE_URL).
async function toBytes(data: Uint8Array | Blob | ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof (data as any)?.arrayBuffer === 'function') return new Uint8Array(await (data as Blob).arrayBuffer());
  return new Uint8Array(0);
}
function encodePath(p: string): string { return p.split('/').map(encodeURIComponent).join('/'); }

async function s3SignedPut(cfg: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string },
  key: string, body: Uint8Array, contentType: string): Promise<boolean> {
  const crypto = await import('node:crypto');
  const sha256hex = (b: crypto.BinaryLike) => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k: crypto.BinaryLike, d: string) => crypto.createHmac('sha256', k).update(d).digest();
  const host = new URL(cfg.endpoint).host;
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');       // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const canonicalUri = '/' + cfg.bucket + '/' + encodePath(key);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${datestamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac('AWS4' + cfg.secretKey, datestamp);
  const signature = crypto.createHmac('sha256', hmac(hmac(hmac(kDate, cfg.region), 's3'), 'aws4_request')).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + canonicalUri, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, 'Authorization': authorization },
    body,
  });
  if (!res.ok) { try { console.error('s3 put ' + res.status + ': ' + (await res.text()).slice(0, 200)); } catch {} }
  return res.ok;
}

function s3Store(): BlobStore {
  const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET || '';
  const accessKey = process.env.S3_ACCESS_KEY_ID || '';
  const secretKey = process.env.S3_SECRET_ACCESS_KEY || '';
  const region = process.env.S3_REGION || 'us-east-1';
  const publicBase = (process.env.S3_PUBLIC_BASE_URL || (endpoint + '/' + bucket)).replace(/\/+$/, '');
  const enabled = !!(endpoint && bucket && accessKey && secretKey);
  return {
    kind: 's3', enabled,
    async put(key, data, contentType) {
      if (!enabled) return null;
      try {
        const bytes = await toBytes(data);
        const ok = await s3SignedPut({ endpoint, region, bucket, accessKey, secretKey }, key, bytes, contentType);
        return ok ? { url: publicBase + '/' + encodePath(key), key } : null;
      } catch { return null; }
    },
    url(key) { return publicBase + '/' + encodePath(key); },
  };
}

function s3Configured(): boolean {
  return !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

let _store: BlobStore | null = null;
/** The active store, in sovereignty order: S3-compatible (self-hostable) → Vercel Blob → in-memory
 *  dev fallback. Set the S3_* env vars to point at MinIO / Supabase Storage / R2 with no code change. */
export function getStore(): BlobStore {
  if (_store) return _store;
  _store = s3Configured() ? s3Store()
    : process.env.BLOB_READ_WRITE_TOKEN ? vercelBlobStore()
    : memoryStore();
  return _store;
}
/** Whether real (non-dev) object storage is provisioned — surfaced honestly in the admin VOD view. */
export function storageProvisioned(): boolean { return s3Configured() || !!process.env.BLOB_READ_WRITE_TOKEN; }
/** Human label for the active backend (admin/ops display). */
export function storageBackend(): string { return s3Configured() ? 's3' : (process.env.BLOB_READ_WRITE_TOKEN ? 'vercel-blob' : 'memory'); }
