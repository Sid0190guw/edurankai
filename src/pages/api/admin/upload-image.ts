// POST /api/admin/upload-image  (multipart, field "file")
// Admin image upload (event covers, etc.). Image only incl. animated GIF.
// Magic-byte verified, size-capped, blob-stored. Returns { ok, url }.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB (GIFs/animations can be large)
const ALLOWED = [
  { ext: 'png', mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'jpeg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'webp', mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  { ext: 'gif', mime: 'image/gif', magic: [[0x47, 0x49, 0x46, 0x38]] }, // GIF8
];
function magicMatches(b: Uint8Array, magic: number[][]) { return magic.some((sig) => sig.every((x, i) => b[i] === x)); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'Admins only' }, 403);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'No file' }, 400);
  if (file.size === 0) return json({ ok: false, error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 12 MB)' }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  const spec = ALLOWED.find((a) => a.ext === ext);
  if (!spec) return json({ ok: false, error: 'Allowed: PNG, JPG, WEBP, GIF' }, 415);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(buf, spec.magic)) return json({ ok: false, error: 'File content does not match a real image' }, 415);
  try {
    const blob = await put('event-media/' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext), file, { access: 'public', contentType: spec.mime, addRandomSuffix: true });
    return json({ ok: true, url: blob.url });
  } catch (e: any) { return json({ ok: false, error: e?.message || 'upload failed' }, 500); }
};
