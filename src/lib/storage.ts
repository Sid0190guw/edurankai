// src/lib/storage.ts — a swap-ready object-storage interface (Prompt AP1). VOD media (audio/video)
// is stored through this so the backend (Vercel Blob today; S3/GCS/self-host later) swaps without
// touching callers. The ESSENTIAL part of a recording — the ordered animation SPEC timeline — lives
// in the kernel (no blob needed), so replay works even with no object store. Blob media needs
// BLOB_READ_WRITE_TOKEN; without it we fall back to an in-memory dev store and report it honestly
// (we never claim CDN-scale VOD from the dev fallback).
//
// `BinaryLike` is imported as a TYPE ONLY. node:crypto itself is still loaded lazily, inside the
// two signers, exactly as before — a type-only import is erased and never becomes a require().
import type { BinaryLike } from 'node:crypto';

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
        // The eighth call site, and it needs the same bound as the seven routes: @vercel/blob's put()
        // retries ten times with an unbounded backoff and no request timeout. This adapter is the one
        // VOD media goes through, so an unbounded upload here holds a serverless invocation open for
        // as long as the platform allows and then dies without reporting anything.
        const { putBounded: put } = await import('@/lib/blob-upload');
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
/**
 * The bytes of a request body, typed as fetch() actually accepts them.
 *
 * BodyInit takes an ArrayBuffer-backed view only — a SharedArrayBuffer-backed Uint8Array is not a
 * valid body — so the caller's array is re-viewed rather than asserted. The ArrayBuffer case is a
 * VIEW OVER THE SAME BYTES, not a copy, which matters when the body is a media file.
 */
type BodyBytes = Uint8Array<ArrayBuffer>;

function bodyBytes(u8: Uint8Array): BodyBytes {
  const buf = u8.buffer;
  // A real check, not an assertion: the shared case is the one fetch() cannot take, and copying is
  // the only way to hand it over. Nothing in this project produces one today.
  return buf instanceof ArrayBuffer ? new Uint8Array(buf, u8.byteOffset, u8.byteLength) : new Uint8Array(u8);
}

async function toBytes(data: Uint8Array | Blob | ArrayBuffer | string): Promise<BodyBytes> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return bodyBytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof (data as any)?.arrayBuffer === 'function') return new Uint8Array(await (data as Blob).arrayBuffer());
  return new Uint8Array(0);
}
function encodePath(p: string): string { return p.split('/').map(encodeURIComponent).join('/'); }

async function s3SignedPut(cfg: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string },
  key: string, body: BodyBytes, contentType: string): Promise<boolean> {
  const crypto = await import('node:crypto');
  const sha256hex = (b: BinaryLike) => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k: BinaryLike, d: string) => crypto.createHmac('sha256', k).update(d).digest();
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

// -------------------------------------------------------------------------------------------------
// PRESIGNED UPLOAD — the only way a full-length video can ever reach this platform.
//
// THE PROBLEM THIS SOLVES, PRECISELY. put() above sends the bytes THROUGH the serverless function:
// browser → our function → object storage. That path has a request-body ceiling measured in a few
// megabytes on this host, which is fine for the 320px profile photo (the one upload this platform
// has ever done) and useless for a forty-minute lecture. No amount of chunking inside the function
// changes it, because the ceiling is on the request the function receives.
//
// A PRESIGNED URL MOVES THE BYTES OFF THAT PATH ENTIRELY. We sign a PUT that authorises exactly one
// object key, for a few minutes, and hand the signature to the browser; the browser then uploads
// browser → object storage, direct, and our function never sees a byte of it. The file size ceiling
// becomes the storage service's, which is measured in terabytes.
//
// SAME SIGNING MATH AS s3SignedPut ABOVE, in its query-string form rather than its header form, so
// this still adds no dependency and still speaks the open S3 API — MinIO, Supabase Storage, R2, or
// AWS itself, whichever the deployment points at.
//
// WHAT IS DELIBERATELY NOT SIGNED: the payload (UNSIGNED-PAYLOAD, because we do not have the bytes)
// and the content type (so a browser that adjusts it does not invalidate the signature). Neither is
// a hole worth worrying about: the KEY is chosen by us and the signature authorises that key alone,
// so the worst a leaked url can do in its five-minute life is overwrite the object it was minted
// for. The caller is responsible for deciding who may ask for one.

// TWO THINGS THIS DOES NOT DO, WRITTEN DOWN SO NOBODY DISCOVERS THEM IN PRODUCTION.
//
// PATH STYLE. The address is built as endpoint + '/' + bucket + '/' + key. That is path-style
// addressing, which MinIO, R2, Supabase Storage and AWS-in-path-style all accept. An endpoint that
// only speaks virtual-hosted style (bucket.s3.region.amazonaws.com) needs the bucket out of the path
// and into the host, and this signer does not do that. Point it at a path-style endpoint.
//
// READABILITY. A signed PUT proves the bucket is WRITABLE by us. It says nothing about whether the
// object is READABLE by a learner, and a private bucket fails that way silently — the upload
// succeeds and the lesson shows a black rectangle. The uploader screen therefore reads the object
// back through a media element after uploading and reports what it finds; do not remove that check
// on the assumption that a successful PUT means a working lesson.

export interface PresignedUpload {
  /** PUT the file here, with no headers beyond Content-Type. Expires. */
  uploadUrl: string;
  /** Where the object will be readable afterwards. This is what gets stored on the lesson. */
  publicUrl: string;
  key: string;
  expiresInSeconds: number;
  backend: string;
}

/** RFC 3986 encoding, which is what SigV4 requires and encodeURIComponent nearly gives. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Mint a presigned PUT for one object key.
 *
 * Returns null when S3-compatible storage is not configured — and null must be reported to the user
 * as "no storage is configured", never as a failed upload. The two are different problems with
 * different fixes and telling them apart is the whole reason this returns null rather than throwing.
 */
export async function presignedUpload(key: string, opts: { expiresInSeconds?: number } = {}): Promise<PresignedUpload | null> {
  if (!s3Configured()) return null;

  const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET || '';
  const accessKey = process.env.S3_ACCESS_KEY_ID || '';
  const secretKey = process.env.S3_SECRET_ACCESS_KEY || '';
  const region = process.env.S3_REGION || 'us-east-1';
  const publicBase = (process.env.S3_PUBLIC_BASE_URL || (endpoint + '/' + bucket)).replace(/\/+$/, '');
  const expires = Math.min(3600, Math.max(60, opts.expiresInSeconds || 900));

  const crypto = await import('node:crypto');
  const sha256hex = (b: BinaryLike) => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k: BinaryLike, d: string) => crypto.createHmac('sha256', k).update(d).digest();

  const host = new URL(endpoint).host;
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzdate.slice(0, 8);
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const canonicalUri = '/' + bucket + '/' + encodePath(key);

  // Sorted, as SigV4 demands. The order below is already alphabetical; keep it that way.
  const query =
    'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=' + rfc3986(accessKey + '/' + scope) +
    '&X-Amz-Date=' + amzdate +
    '&X-Amz-Expires=' + expires +
    '&X-Amz-SignedHeaders=host';

  const canonicalRequest = `PUT\n${canonicalUri}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac('AWS4' + secretKey, datestamp);
  const signature = crypto
    .createHmac('sha256', hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request'))
    .update(stringToSign)
    .digest('hex');

  return {
    uploadUrl: endpoint + canonicalUri + '?' + query + '&X-Amz-Signature=' + signature,
    publicUrl: publicBase + '/' + encodePath(key),
    key,
    expiresInSeconds: expires,
    backend: 's3',
  };
}

/**
 * Whether a browser can upload a large file directly, and the honest sentence if not.
 *
 * Vercel Blob is provisioned storage but its client-upload flow needs that vendor's browser SDK,
 * which this project does not install — so "storage exists" and "a big file can be uploaded" are
 * genuinely two different questions and this answers the second one.
 */
export function directUploadStatus(): { available: boolean; backend: string; reason: string } {
  if (s3Configured()) {
    return { available: true, backend: 's3', reason: 'Object storage is configured and the browser can upload straight to it.' };
  }
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      available: false, backend: 'vercel-blob',
      reason: 'The configured object store cannot take a direct browser upload without adding that vendor\'s browser library, which this project does not install. Point S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY at any S3-compatible bucket and large uploads start working with no code change.',
    };
  }
  return {
    available: false, backend: 'memory',
    reason: 'No object storage is configured, so there is nowhere to put an uploaded file. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to any S3-compatible bucket.',
  };
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
