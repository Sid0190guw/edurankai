// Keep a small image when object storage is missing or failing.
//
// WHY THIS EXISTS. Every image upload on the platform went to Vercel Blob and nowhere else. When the
// blob store is not reachable from the deployment (no BLOB_READ_WRITE_TOKEN after the account move,
// a token for a store that no longer exists, an outage), every upload failed with "That file could
// not be uploaded" — and on /aquintutor/interview/<slug>/preflight that is a REQUIRED check, so a
// candidate sitting in a scheduled interview could not start it at all (seen live, 2026-11-08).
//
// WHAT IT DOES. storeImage() tries object storage first when it is configured. If storage is not
// configured, or the upload throws, an image of at most INLINE_MAX_BYTES is returned as a data URL
// for the caller to keep in the column the storage URL would have gone into. Images are resized in
// the browser before upload, so a phone photo of an ID card arrives at a few hundred kilobytes.
//
// WHAT IT DOES NOT DO. Documents (PDFs) are never inlined: platform rule, documents are shared as
// links and are not stored here. A file that is not a real PNG, JPEG or WEBP (checked by its bytes,
// not its name) is refused.

import { putBounded } from '@/lib/blob-upload';

/** Base64 grows a file by a third, so 1.2 MB of image is about 1.6 MB of text in the row. */
export const INLINE_MAX_BYTES = 1_200_000;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** The real type of an image, from its first bytes. Null for anything that is not PNG, JPEG or WEBP. */
export function sniffImage(buf: Uint8Array): ImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

export function isPdf(buf: Uint8Array): boolean {
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

export function toDataUrl(buf: Uint8Array, mime: ImageMime): string {
  return 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64');
}

export function isDataUrl(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('data:');
}

/** Decode a data URL produced by toDataUrl(). Null for anything else. */
export function fromDataUrl(v: string): { mime: ImageMime; bytes: Buffer } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(v || ''));
  if (!m) return null;
  return { mime: m[1] as ImageMime, bytes: Buffer.from(m[2], 'base64') };
}

export interface StoredImage { url: string; inline: boolean }

/**
 * Store an image. Object storage when it is configured and answers; otherwise inline. Throws only
 * when neither is possible, with a sentence the caller can show.
 */
export async function storeImage(key: string, buf: Uint8Array, mime: ImageMime): Promise<StoredImage> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const blob = await putBounded(key, Buffer.from(buf), { access: 'public', contentType: mime, addRandomSuffix: true });
      if (blob?.url) return { url: String(blob.url), inline: false };
    } catch (e: any) {
      // Not a database error: this is the storage provider's own message.
      console.error('[inline-image] object storage refused ' + key + ', keeping the image inline instead:', String(e?.message || e));
    }
  }
  if (buf.length > INLINE_MAX_BYTES) {
    throw new Error('That image is too large to store (' + Math.round(buf.length / 1024) + ' KB). Use a smaller photo or a screenshot of your ID.');
  }
  return { url: toDataUrl(buf, mime), inline: true };
}
