// src/lib/mailplatform/adapters/attachment-store.ts — AttachmentStore over object storage.
//
// Wraps src/lib/storage.ts, which already implements the sovereign default: a SigV4-signed S3 PUT
// over plain HTTPS with no vendor SDK, falling back to Vercel Blob and then to an in-memory dev
// store. That ordering matters and is not changed here — S3-compatible first means MinIO, Ceph or
// any self-hosted bucket works without a code change.
//
// The rule this file enforces: NO BINARY EVER REACHES POSTGRES. A 20 MB attachment in a bytea
// column is 20 MB in every backup, every replica and every SELECT * a future query runs by
// accident.

import type { AttachmentStore, OperationResult, ProviderInfo, StoredAttachment } from '../interfaces';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** Deterministic, collision-resistant key. `uniq` is passed in so this stays pure and testable. */
export function attachmentKey(orgId: string, messageId: string, filename: string, uniq: string): string {
  const safeOrg = String(orgId || 'org').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  const safeMsg = String(messageId || 'msg').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  // Keep the extension (clients pick an icon and a handler from it), discard everything else about
  // the caller's filename. A remote-supplied name is untrusted input on a path.
  const ext = (/\.([A-Za-z0-9]{1,12})$/.exec(String(filename || '')) || [])[1] || 'bin';
  return `mail/${safeOrg}/${safeMsg}/${uniq}.${ext.toLowerCase()}`;
}

/** Where the full MIME source of an inbound message is parked. */
export function rawMessageKey(orgId: string, messageId: string): string {
  const safeOrg = String(orgId || 'org').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  const safeMsg = String(messageId || 'msg').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  return `mail/${safeOrg}/${safeMsg}/raw.eml`;
}

export function objectAttachmentStore(): AttachmentStore {
  return {
    info(): ProviderInfo {
      // Synchronous by contract, so this reads the environment directly rather than importing
      // src/lib/storage. `require()` is not available in this ESM build and a dynamic import would
      // make info() async — an ops screen calling it on every render must not await a module load.
      // The precedence below mirrors getStore() in src/lib/storage.ts exactly; a test asserts it.
      const s3 = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
      const blob = !!process.env.BLOB_READ_WRITE_TOKEN;
      const kind = s3 ? 's3' : blob ? 'vercel-blob' : 'memory';
      return {
        kind,
        enabled: s3 || blob,
        detail: s3
          ? `Object storage: S3-compatible at ${process.env.S3_ENDPOINT}`
          : blob
            ? 'Object storage: Vercel Blob. S3 is the sovereign default — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to move.'
            : 'No object storage configured. Attachments fall back to an in-memory dev store that does not survive a restart — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
      };
    },

    async put(key, data, contentType): Promise<OperationResult<StoredAttachment>> {
      try {
        const { getStore, storageBackend } = await import('@/lib/storage');
        const store = getStore();
        const res = await store.put(key, data as any, contentType);
        if (!res) {
          return {
            ok: false,
            error: 'Object storage rejected the upload. The message is stored; the attachment is not.',
            code: 'storage_write_failed',
          };
        }
        const sizeBytes =
          data instanceof Uint8Array
            ? data.byteLength
            : typeof data === 'string'
              ? new TextEncoder().encode(data).byteLength
              : data instanceof ArrayBuffer
                ? data.byteLength
                : null;
        return { ok: true, data: { key: res.key, url: res.url, backend: storageBackend(), sizeBytes } };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'storage_error' };
      }
    },

    async presignUpload(key, opts = {}): Promise<OperationResult<{ url: string; fields?: Record<string, string> }>> {
      try {
        const { presignedUpload, directUploadStatus } = await import('@/lib/storage');
        const status = directUploadStatus();
        if (!status.available) {
          // The reason is passed through verbatim. "Direct upload unavailable" alone sends an
          // operator hunting; "S3_SECRET_ACCESS_KEY is not set" is a task they can finish.
          return { ok: false, error: status.reason, code: 'presign_unavailable' };
        }
        const signed = await presignedUpload(key, { expiresInSeconds: opts.expiresInSeconds });
        if (!signed) return { ok: false, error: 'Could not sign an upload URL.', code: 'presign_failed' };
        // `uploadUrl` is where the client PUTs; `publicUrl` is where it is readable afterwards. The
        // caller needs both — returning only the first leaves it with a file it cannot link to.
        return { ok: true, data: { url: signed.uploadUrl, fields: { publicUrl: signed.publicUrl, key: signed.key } } };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'presign_error' };
      }
    },

    url(key: string): string | null {
      // Only the S3 adapter has a deterministic public URL. Vercel Blob returns an absolute URL at
      // put() time and has no getter, so the honest answer there is null rather than a guessed URL
      // that 404s. Callers store the url they were given at put() time; this is a convenience for
      // the S3 case only.
      const base = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      if (!base || !key) return null;
      return base + '/' + key.split('/').map(encodeURIComponent).join('/');
    },
  };
}

/** In-memory store for tests. Reports itself as such; never claims durability. */
export function memoryAttachmentStore(): AttachmentStore {
  const mem = new Map<string, { url: string; size: number }>();
  return {
    info: () => ({ kind: 'memory', enabled: true, detail: 'In-memory test store. Nothing survives a restart.' }),
    async put(key, data, _contentType) {
      const size =
        data instanceof Uint8Array
          ? data.byteLength
          : typeof data === 'string'
            ? new TextEncoder().encode(data).byteLength
            : 0;
      const url = 'mem://' + key;
      mem.set(key, { url, size });
      return { ok: true, data: { key, url, backend: 'memory', sizeBytes: size } };
    },
    async presignUpload() {
      return { ok: false, error: 'memory store cannot presign', code: 'presign_unavailable' };
    },
    url(key) {
      return mem.get(key)?.url ?? null;
    },
  };
}
