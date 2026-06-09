// POST /api/aquintutor/interview/id-doc  (multipart: sessionId, file)
// Candidate uploads a photo of their government ID at the start of the interview.
// Stored to blob and saved against the session so the reviewer can verify it.
import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED: { [e: string]: string } = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const sessionId = (form.get('sessionId') as string || '').trim();
  const file = form.get('file');
  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  if (!(file instanceof File) || file.size === 0) return json({ ok: false, error: 'No file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 12 MB)' }, 400);
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  const mime = ALLOWED[ext];
  if (!mime) return json({ ok: false, error: 'Upload a photo (PNG/JPG/WEBP) or PDF of your ID' }, 415);

  let url = '';
  try {
    const blob = await put('interview-id-docs/' + sessionId + '-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext), file, { access: 'public', contentType: mime, addRandomSuffix: true });
    url = blob.url;
  } catch (e: any) { return json({ ok: false, error: 'Upload failed: ' + String(e?.message || e).slice(0, 140) }, 500); }

  // self-heal the column, then save it on the session
  await db.execute(sql`ALTER TABLE ai_interview_sessions ADD COLUMN IF NOT EXISTS id_doc_url TEXT`).catch(() => {});
  try {
    await db.execute(sql`UPDATE ai_interview_sessions SET id_doc_url = ${url} WHERE id = ${sessionId}`);
  } catch (e: any) { return json({ ok: false, error: 'Saved file but could not link it: ' + String(e?.message || e).slice(0, 140) }, 500); }
  return json({ ok: true, url });
};
