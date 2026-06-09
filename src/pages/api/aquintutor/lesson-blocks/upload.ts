// POST /api/aquintutor/lesson-blocks/upload  (multipart, field "file")
// Lesson media upload for the block editor: images, PDFs, and common docs.
// Magic-byte verified where possible, size-capped, blob-stored. Returns { ok, url, name, mime }.

import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED: { ext: string; mime: string; magic?: number[][] }[] = [
  { ext: 'png', mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'jpeg', mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  { ext: 'webp', mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  { ext: 'gif', mime: 'image/gif', magic: [[0x47, 0x49, 0x46, 0x38]] },
  { ext: 'svg', mime: 'image/svg+xml' },
  { ext: 'pdf', mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] }, // %PDF
  { ext: 'csv', mime: 'text/csv' },
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'md', mime: 'text/markdown' },
  { ext: 'json', mime: 'application/json' },
  { ext: 'zip', mime: 'application/zip', magic: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]] },
  { ext: 'ipynb', mime: 'application/json' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
];
function magicMatches(b: Uint8Array, magic?: number[][]) { return !magic || magic.some((sig) => sig.every((x, i) => b[i] === x)); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'Authors only' }, 403);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const file = form.get('file');
  if (!(file instanceof File)) return json({ ok: false, error: 'No file' }, 400);
  if (file.size === 0) return json({ ok: false, error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 25 MB)' }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  const spec = ALLOWED.find((a) => a.ext === ext);
  if (!spec) return json({ ok: false, error: 'Unsupported file type: .' + ext }, 415);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicMatches(buf, spec.magic)) return json({ ok: false, error: 'File content does not match its extension' }, 415);
  const isImage = spec.mime.startsWith('image/');
  try {
    const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-60);
    const blob = await put('lesson-media/' + Date.now() + '-' + safeName, file, { access: 'public', contentType: spec.mime, addRandomSuffix: true });
    return json({ ok: true, url: blob.url, name: file.name, mime: spec.mime, isImage });
  } catch (e: any) { return json({ ok: false, error: e?.message || 'upload failed' }, 500); }
};
