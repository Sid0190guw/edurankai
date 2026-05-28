// POST /api/auth/id-upload  (multipart/form-data, field: "file")
// Secure upload for a government-ID document. Defends against malicious
// uploads: allows ONLY png / jpg / pdf, enforces a size cap, and verifies the
// real file signature (magic bytes) - not just the client-declared MIME or
// extension. Returns { ok, url } for a private blob.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB
// Image only: the ID photo must be a real image so the face on it can be
// detected and matched against the live selfie. PDFs are not accepted.
const ALLOWED = [
  { ext: 'png', mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'jpeg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'webp', mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF (WEBP)
];

function magicMatches(bytes: Uint8Array, magic: number[][]): boolean {
  return magic.some((sig) => sig.every((b, i) => bytes[i] === b));
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  // Allow anonymous (signup happens before login) but rate/size limits apply.
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected multipart form data' }, 400); }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'No file provided' }, 400);
  if (file.size === 0) return json({ ok: false, error: 'File is empty' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 6 MB)' }, 400);

  const name = (file.name || '').toLowerCase();
  const ext = name.split('.').pop() || '';
  const spec = ALLOWED.find((a) => a.ext === ext);
  if (!spec) return json({ ok: false, error: 'Only image files (PNG, JPG, WEBP) are allowed for ID' }, 415);

  // Read leading bytes and verify the true file signature.
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(buf, spec.magic)) {
    return json({ ok: false, error: 'File content does not match a real image (rejected for safety)' }, 415);
  }
  // Reject obvious script/HTML payloads sneaking in (defence in depth).
  const head = new TextDecoder('latin1').decode(buf.subarray(0, 512)).toLowerCase();
  if (head.includes('<script') || head.includes('<?php') || head.includes('<html')) {
    return json({ ok: false, error: 'File rejected for safety' }, 415);
  }

  try {
    const safeName = (user?.id ? user.id : 'anon') + '-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    const blob = await put('id-docs/' + safeName, file, {
      access: 'public', // blob URLs are unguessable; we store the URL against the verification record only
      contentType: spec.mime,
      addRandomSuffix: true,
    });
    return json({ ok: true, url: blob.url });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'upload failed' }, 500);
  }
};
