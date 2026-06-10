// POST /api/aquintutor/interview/generate-from-doc  (multipart)
// Admin uploads a document in ANY format (PDF, image, or text-based) and the
// LLM generates interview/test questions from it, inserted as seed questions on
// the chosen template. Office formats (docx/pptx/xlsx) can't be text-extracted
// without a parser, so for those the admin pastes the text into the "text" field.
//
// fields: templateId, file (optional), text (optional), count, lang, role
import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { generateInterviewQuestions, isLlmConfigured } from '@/lib/llm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

const MAX_BYTES = 25 * 1024 * 1024;
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'rtf', 'srt', 'vtt', 'log'];
const IMG: { [e: string]: string } = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function toBase64(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  // btoa is available in the Vercel/edge + Node 18 runtime; fall back to Buffer.
  try { return btoa(bin); } catch { return Buffer.from(buf).toString('base64'); }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'Admins only' }, 403);
  if (!isLlmConfigured()) return json({ ok: false, error: 'Automatic question generation is currently unavailable - please add your questions manually.' }, 503);

  let form: FormData;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'Expected form data' }, 400); }
  const templateId = (form.get('templateId') as string || '').trim();
  const count = Math.max(1, Math.min(30, parseInt(form.get('count') as string || '8', 10) || 8));
  const lang = (form.get('lang') as string || 'en-IN').trim();
  const role = (form.get('role') as string || '').trim().slice(0, 200);
  const pastedText = (form.get('text') as string || '').trim();
  if (!templateId) return json({ ok: false, error: 'templateId required' }, 400);

  // resolve the LLM input from the file (any format) or pasted text
  const file = form.get('file');
  let genOpts: any = { count, lang, role };
  let docUrl = '';
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return json({ ok: false, error: 'File too large (max 25 MB)' }, 400);
    const ext = (file.name || '').toLowerCase().split('.').pop() || '';
    const buf = new Uint8Array(await file.arrayBuffer());
    // store the source doc for the record (best-effort)
    try {
      const blob = await put('interview-docs/' + Date.now() + '-' + (file.name || 'doc').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-50), file, { access: 'public', addRandomSuffix: true });
      docUrl = blob.url;
    } catch (_) {}
    if (ext === 'pdf') genOpts.pdfBase64 = toBase64(buf);
    else if (IMG[ext]) { genOpts.imageBase64 = toBase64(buf); genOpts.imageMime = IMG[ext]; }
    else if (TEXT_EXT.includes(ext)) genOpts.sourceText = new TextDecoder('utf-8').decode(buf).slice(0, 80000);
    else if (pastedText) genOpts.sourceText = pastedText;
    else return json({ ok: false, error: 'Cannot auto-read .' + ext + ' (Office formats need a parser). Upload a PDF / image / text file, or paste the text in the box.' }, 415);
  } else if (pastedText) {
    genOpts.sourceText = pastedText;
  } else {
    return json({ ok: false, error: 'Upload a document or paste some text.' }, 400);
  }

  let questions;
  try { questions = await generateInterviewQuestions(genOpts); }
  catch (e: any) { return json({ ok: false, error: 'Generation failed: ' + String(e?.message || e).slice(0, 160) }, 500); }
  if (!questions || questions.length === 0) return json({ ok: false, error: 'The model returned no questions. Try a clearer document or paste the text.' }, 502);

  // insert as seeds after the current max sort_order
  try {
    const base = rows(await db.execute(sql`SELECT COALESCE(MAX(sort_order), 0)::int AS m FROM ai_interview_seeds WHERE template_id = ${templateId}`))[0]?.m || 0;
    let i = 0;
    for (const q of questions) {
      i++;
      await db.execute(sql`
        INSERT INTO ai_interview_seeds (template_id, prompt_text, expected_topics, sort_order, is_active, source_doc_url)
        VALUES (${templateId}, ${q.prompt}, ${q.topics}, ${base + i}, true, ${docUrl || null})
      `).catch(async () => {
        // older schema without source_doc_url
        await db.execute(sql`
          INSERT INTO ai_interview_seeds (template_id, prompt_text, expected_topics, sort_order, is_active)
          VALUES (${templateId}, ${q.prompt}, ${q.topics}, ${base + i}, true)
        `).catch(() => {});
      });
    }
  } catch (e: any) { return json({ ok: false, error: 'Saved generation but DB insert failed: ' + String(e?.message || e).slice(0, 160) }, 500); }

  return json({ ok: true, added: questions.length, docUrl, questions });
};
