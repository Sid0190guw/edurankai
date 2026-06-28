// POST /api/portal/profile-photo  (multipart, field "file")
// Lets a signed-in user upload a real image for their profile/CV photo, instead
// of pasting a URL (Google Drive share links are not direct images and render
// as a broken box). Magic-byte verified, size-capped, blob-stored.
import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED = [
  { ext: 'png', mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'jpeg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'webp', mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
];
function magicMatches(b: Uint8Array, magic: number[][]) { return magic.some((sig) => sig.every((x, i) => b[i] === x)); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'No file' }, 400);
  if (file.size === 0) return json({ ok: false, error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'Image too large (max 8 MB)' }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  const spec = ALLOWED.find((a) => a.ext === ext);
  if (!spec) return json({ ok: false, error: 'Allowed: JPG, PNG, WEBP' }, 415);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(buf, spec.magic)) return json({ ok: false, error: 'That file is not a real image' }, 415);
  try {
    const blob = await put('profile-photos/' + user.id + '-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext), file, {
      access: 'public', contentType: spec.mime, addRandomSuffix: true,
    });
    return json({ ok: true, url: blob.url });
  } catch (e: any) { return json({ ok: false, error: e?.message || 'upload failed' }, 500); }
};
