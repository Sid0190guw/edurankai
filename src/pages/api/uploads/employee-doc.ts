// POST /api/uploads/employee-doc  (multipart, field "file")
// Secure upload for employee onboarding docs (govt ID, NOC). Allows image or
// PDF only, size-capped, magic-byte verified. Signed-in users only.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = [
  { ext: 'png', mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'jpeg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'webp', mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  { ext: 'pdf', mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
];
function magicMatches(b: Uint8Array, magic: number[][]) { return magic.some((sig) => sig.every((x, i) => b[i] === x)); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.' }, 401);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'No file' }, 400);
  if (file.size === 0) return json({ ok: false, error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 8 MB)' }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  const spec = ALLOWED.find((a) => a.ext === ext);
  if (!spec) return json({ ok: false, error: 'Allowed: PNG, JPG, WEBP or PDF' }, 415);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(buf, spec.magic)) return json({ ok: false, error: 'File content does not match its type (rejected)' }, 415);
  const head = new TextDecoder('latin1').decode(buf.subarray(0, 512)).toLowerCase();
  if (spec.mime !== 'application/pdf' && (head.includes('<script') || head.includes('<html'))) return json({ ok: false, error: 'File rejected for safety' }, 415);
  try {
    const blob = await put('emp-docs/' + user.id + '-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext), file, { access: 'public', contentType: spec.mime, addRandomSuffix: true });
    return json({ ok: true, url: blob.url });
  } catch (e: any) { return json({ ok: false, error: e?.message || 'upload failed' }, 500); }
};
