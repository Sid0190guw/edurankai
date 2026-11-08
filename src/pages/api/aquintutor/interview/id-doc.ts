// POST /api/aquintutor/interview/id-doc  (multipart: sessionId, file)
// Candidate uploads a photo of their government ID at the start of the interview.
// Saved against the session so the reviewer can verify it.
//
// GET /api/aquintutor/interview/id-doc?session=<id>
// Serves the stored ID image to a reviewer (EduRankAI admin or AquinTutor admin) — needed because
// an image kept inline (see src/lib/inline-image.ts) cannot be opened in a new tab as a data URL.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { guardInterviewSession } from '@/lib/aquin/interview-session';
import { apiFail } from '@/lib/api-fail';
import { sniffImage, isPdf, storeImage, isDataUrl, fromDataUrl } from '@/lib/inline-image';
import { putBounded } from '@/lib/blob-upload';
import { canOpenAdmin } from '@/lib/auth/admin-access';
import { mayOpenAquinAdmin } from '@/lib/aquin/identity';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const MAX_BYTES = 12 * 1024 * 1024;

// SESSION OWNERSHIP IS THE TEST — see src/lib/aquin/interview-session.ts. Neither the upload nor the
// UPDATE can be reached without the cookie /start minted for this session.
//
// STORAGE NO LONGER DECIDES WHETHER AN INTERVIEW CAN START. This route used to fail outright when the
// blob store refused the file, and the ID step is required, so the candidate could not begin. An
// image now falls back to being kept inline on the session row (storeImage). A PDF still needs object
// storage, and when that is unavailable the candidate is asked for a photo or screenshot instead —
// which the preflight page already produces for them by resizing in the browser.
export const POST: APIRoute = async ({ request, cookies }) => {
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const sessionId = (form.get('sessionId') as string || '').trim();
  const file = form.get('file');
  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  const gate = guardInterviewSession(cookies, sessionId);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  if (!(file instanceof File) || file.size === 0) return json({ ok: false, error: 'No file' }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 12 MB). Upload a photo or screenshot of your ID.' }, 400);

  const buf = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(buf);
  let url = '';
  if (mime) {
    try {
      const stored = await storeImage('interview-id-docs/' + sessionId + '-' + Date.now() + (mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'), buf, mime);
      url = stored.url;
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || 'That image could not be stored. Use a smaller photo or a screenshot of your ID.') }, 413);
    }
  } else if (isPdf(buf)) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return json({ ok: false, error: 'PDFs cannot be accepted right now. Upload a photo or a screenshot of your ID (JPG or PNG) instead.' }, 415);
    }
    try {
      const blob = await putBounded('interview-id-docs/' + sessionId + '-' + Date.now() + '.pdf', file, { access: 'public', contentType: 'application/pdf', addRandomSuffix: true });
      url = blob.url;
    } catch (e: any) {
      return apiFail('[interview id-doc] pdf upload', e, 'That PDF could not be uploaded. Upload a photo or a screenshot of your ID (JPG or PNG) instead.');
    }
  } else {
    return json({ ok: false, error: 'Upload a photo or screenshot of your ID (JPG, PNG or WEBP).' }, 415);
  }

  // self-heal the column (refused harmlessly in production, where the bootstrap owns DDL), then save
  await db.execute(sql`ALTER TABLE ai_interview_sessions ADD COLUMN IF NOT EXISTS id_doc_url TEXT`).catch(() => {});
  try {
    await db.execute(sql`UPDATE ai_interview_sessions SET id_doc_url = ${url} WHERE id = ${sessionId}`);
  } catch (e: any) { return apiFail('[interview id-doc] link to session', e, 'The file was received but could not be attached to this interview. Try again.'); }
  // The URL itself is not echoed back when it is inline: the page only needs to know it worked.
  return json({ ok: true, url: isDataUrl(url) ? '' : url });
};

export const GET: APIRoute = async ({ url, locals }) => {
  const sessionId = String(url.searchParams.get('session') || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return new Response('Not found', { status: 404 });
  const p = (locals as any).aquin;
  const aquinOk = !!p && mayOpenAquinAdmin(p);
  const eduOk = aquinOk ? true : (await canOpenAdmin((locals as any).user)).allowed;
  if (!aquinOk && !eduOk) return new Response('Not authorised', { status: 403 });
  let stored = '';
  try {
    stored = String(rows(await db.execute(sql`SELECT id_doc_url FROM ai_interview_sessions WHERE id = ${sessionId} LIMIT 1`))[0]?.id_doc_url || '');
  } catch (e: any) {
    console.error('[interview id-doc] read failed for', sessionId, '-', e?.cause?.message || e?.message);
    return new Response('The ID document could not be read just now.', { status: 503 });
  }
  if (!stored) return new Response('No ID document for this session', { status: 404 });
  if (isDataUrl(stored)) {
    const img = fromDataUrl(stored);
    if (!img) return new Response('Unreadable ID document', { status: 422 });
    return new Response(new Uint8Array(img.bytes), { status: 200, headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (/^https:\/\//i.test(stored)) return Response.redirect(stored, 302);
  return new Response('No ID document for this session', { status: 404 });
};
