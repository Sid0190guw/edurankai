// POST /api/admin/hr/document-edit - SAVE AN EDITED HR DOCUMENT, WITH THE NOTE THAT SAYS WHY.
//
// A computed letter (the completion letter on /admin/hr/completion/<id>) can now be edited on the
// screen. This keeps the edit: the edited wording, sanitised, and the editor's note go into the audit
// log against the document, so the next person to open it sees the edited version, who edited it,
// when and why - and can always switch back to the measured original. Nothing is overwritten: every
// save is a new entry, so the history is the list of saves.
//
// Body: { entity: 'hr_completion_letter', entityId: <employee uuid>, note: string, html: string }.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { sanitizeEmailHtml, ORIGIN } from '@/lib/mailsec/html';
import { logAudit } from '@/lib/audit';

export const prerender = false;

// Declared before the handler: `const` is not hoisted.
const ENTITIES = ['hr_completion_letter'];
const MAX_HTML = 100_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'employee.manage', label: 'hr.document.edit' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let b: any;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'That request was not readable.' }, 400); }
  const entity = String(b?.entity || '');
  const entityId = String(b?.entityId || '').slice(0, 64);
  const note = String(b?.note || '').trim().slice(0, 1000);
  const html = String(b?.html || '');
  if (!ENTITIES.includes(entity) || !/^[0-9a-f-]{36}$/i.test(entityId)) return json({ ok: false, error: 'That document is not one this desk edits.' }, 400);
  if (note.length < 5) return json({ ok: false, error: 'Write what you changed and why. It is kept with the letter.' }, 400);
  if (!html.trim() || html.length > MAX_HTML) return json({ ok: false, error: 'The edited letter did not arrive, or is far longer than a letter.' }, 400);

  // Sanitised as markup that will be rendered back inside our own origin.
  const clean = sanitizeEmailHtml(html, ORIGIN);
  const r = await logAudit({
    userId: user?.id ? String(user.id) : null,
    action: 'hr.document.edited',
    entity, entityId,
    diff: { note, html: clean.html, byName: user?.name || user?.email || 'People desk' },
  });
  if (!r.ok) return json({ ok: false, error: 'The edit was NOT saved: ' + (r.error || 'the record could not be written') }, 500);
  return json({ ok: true, message: 'Saved. This edited version opens by default from now on, with your note beside it.' });
};
