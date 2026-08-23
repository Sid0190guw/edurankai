// POST /api/talent/onboarding — the onboarding form's only endpoint.
//
// AUTHENTICATED BY THE ONBOARDING SESSION COOKIE AND NOTHING ELSE. There is no application id in any
// request body: the session resolves to exactly one application server-side, so there is no id for a
// caller to tamper with and no way to address somebody else's onboarding. That is the IDOR fix, and
// it is structural rather than a check that could be forgotten on a later action.
//
// `/api/*` IS NOT COVERED BY THE /admin MIDDLEWARE GATE IN THIS CODEBASE, so this route carries its
// own authentication in full and assumes nothing upstream of it.
import type { APIRoute } from 'astro';
import {
  resolveSession, saveDraft, addDocument, removeDocument, submitOnboarding,
  prefillFor, identityTypeFromEmployment, ONBOARDING_COOKIE,
} from '@/lib/talent/onboarding';
import { logAudit } from '@/lib/audit';

// Declared before the handler: `const` is not hoisted.
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function j(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function clientIp(clientAddress: string | undefined, request: Request): string | null {
  if (clientAddress) return String(clientAddress);
  const first = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return first || null;
}

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const app = await resolveSession(cookies.get(ONBOARDING_COOKIE)?.value ?? null);
  if (!app) {
    return j({ ok: false, error: 'Your onboarding session has ended. Open the link you were sent again to continue.' }, 401);
  }
  if (app.status !== 'in_progress' && app.status !== 'changes_requested') {
    return j({ ok: false, error: 'This onboarding has already been submitted.' }, 409);
  }

  let body: any = {};
  try { body = await request.json(); } catch { return j({ ok: false, error: 'Malformed request.' }, 400); }

  const action = String(body.action || '');
  const ip = clientIp(clientAddress, request);

  if (action === 'save-draft') {
    const r = await saveDraft(app.id, body.form || {}, Array.isArray(body.sectionsComplete) ? body.sectionsComplete : []);
    if (!r.ok) return j({ ok: false, error: r.error }, 400);
    // A candidate posting organisation-controlled fields is worth recording even though it was
    // stripped. It is either a stale page or somebody probing, and both are worth being able to see.
    if (r.rejected && r.rejected.length) {
      await logAudit({
        userId: null, action: 'talent.onboarding.org_fields_rejected', entity: 'tal_onboarding_application',
        entityId: app.id, diff: { rejected: r.rejected }, ipAddress: ip || undefined,
      });
    }
    return j({ ok: true });
  }

  if (action === 'add-document') {
    const r = await addDocument({
      applicationId: app.id, personId: app.personId,
      docType: String(body.docType || ''), title: String(body.title || ''), driveUrl: String(body.driveUrl || ''),
    });
    if (!r.ok) return j({ ok: false, error: r.error }, 400);
    await logAudit({
      userId: null, action: 'talent.onboarding.document_added', entity: 'tal_document_ref',
      entityId: r.id, diff: { applicationId: app.id, docType: String(body.docType || '') }, ipAddress: ip || undefined,
    });
    return j({ ok: true, id: r.id });
  }

  if (action === 'remove-document') {
    // Scoped to THIS application inside the query, so a guessed uuid removes nothing.
    const r = await removeDocument(String(body.documentId || ''), app.id);
    if (!r.ok) return j({ ok: false, error: r.error }, 400);
    return j({ ok: true });
  }

  if (action === 'submit') {
    // The identity type is derived SERVER-SIDE from the selection, never taken from the request.
    // Accepting it from the body would let a candidate choose the shorter form.
    const prefill = await prefillFor(app);
    const identityType = identityTypeFromEmployment(prefill.org.employmentType);

    const r = await submitOnboarding({
      applicationId: app.id, identityType,
      form: body.form || {}, declarations: body.declarations || {}, ip,
    });
    if (!r.ok) return j({ ok: false, error: r.error, problems: r.problems || [] }, 400);

    // The session is cleared by submitOnboarding server-side; clear the cookie too so the browser
    // stops sending a value that no longer resolves.
    cookies.delete(ONBOARDING_COOKIE, { path: '/' });
    await logAudit({
      userId: null, action: 'talent.onboarding.submitted', entity: 'tal_onboarding_application',
      entityId: app.id, diff: { codeRef: app.onboardingCodeRef, selectionId: app.selectionId }, ipAddress: ip || undefined,
    });
    return j({ ok: true });
  }

  return j({ ok: false, error: 'Unknown action.' }, 400);
};

export const GET: APIRoute = async () => j({ ok: false, error: 'Use POST.' }, 405);
