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

let _store: BlobStore | null = null;
/** The active store: real Blob when configured, else the in-memory dev fallback. */
export function getStore(): BlobStore {
  if (_store) return _store;
  _store = process.env.BLOB_READ_WRITE_TOKEN ? vercelBlobStore() : memoryStore();
  return _store;
}
/** Whether real (non-dev) object storage is provisioned — surfaced honestly in the admin VOD view. */
export function storageProvisioned(): boolean { return !!process.env.BLOB_READ_WRITE_TOKEN; }
