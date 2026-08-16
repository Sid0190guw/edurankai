// POST /api/mail/automation/hook/[token] — the door an OUTSIDE system posts events through.
//
// THREE THINGS ARE CHECKED, AND A TOKEN ON ITS OWN IS NOT ENOUGH.
//
//   1. The token identifies WHICH workflow. Nothing more. A URL token leaks the way URLs leak — a
//      proxy log, a browser history, a screenshot in a support ticket — and on its own it would let
//      anybody who has ever seen it start real workflows that send real mail to real candidates.
//   2. X-Automation-Signature is an HMAC-SHA256 of "<timestamp>.<body>" under the workflow's secret.
//      That is what proves the sender holds the secret and that the body was not altered on the way.
//   3. X-Automation-Timestamp must be within five minutes, so a captured request cannot be replayed
//      for ever.
//
// It fails CLOSED everywhere, including when the workflow has no secret configured. src/middleware.ts
// exempts everything under /api/, so nothing stands in front of this URL but this file.
//
// The organisation comes from the WORKFLOW ROW, never from the request. A sender does not choose
// which tenant their events land in.
import type { APIRoute } from 'astro';
import { pgStore, webhookSecretFor } from '@/lib/mailplatform/pg-store';
import { emit } from '@/lib/mailplatform/router';
import { isUsableEventType } from '@/lib/mailplatform/triggers';
import { MAX_WEBHOOK_BODY, safeId, verifyWebhook } from '@/lib/mailplatform/security';
import { reasonOf } from '@/lib/mailplatform/errors';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const POST: APIRoute = async ({ request, params }) => {
  const token = safeId(params.token, 64);
  // Read the body as TEXT first and sign that exact text. Parsing to JSON and re-serialising to
  // verify would compare a signature against a different string than the one that was signed —
  // key order and whitespace both change — and every valid request would be refused.
  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_WEBHOOK_BODY) return json({ ok: false, error: 'The body is larger than 64 KB.' }, 413);

  const workflow = token ? await pgStore.getWorkflowByWebhookToken(token) : null;
  // The same 404 for "no such token" and "token disabled": a caller probing tokens learns nothing
  // from the difference, and there is nothing useful to tell a legitimate sender either.
  if (!workflow) return json({ ok: false, error: 'No workflow accepts events at this address.' }, 404);

  const verdict = verifyWebhook({
    secret: await webhookSecretFor(workflow.orgId, workflow.id),
    body: raw,
    signature: request.headers.get('x-automation-signature'),
    timestamp: request.headers.get('x-automation-timestamp'),
    now: new Date(),
  });
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, verdict.status);

  let body: any = {};
  try { body = JSON.parse(raw || '{}'); } catch { return json({ ok: false, error: 'The body is not JSON.' }, 400); }

  // THE EVENT TYPE IS PINNED TO THIS WORKFLOW'S TRIGGER. Without this line, a signed sender could
  // post ANY event type and start every other workflow in the organisation — the signature would
  // prove only that they were allowed to feed this one.
  const type = String(body.type || workflow.triggerEvent || '').trim();
  if (!isUsableEventType(type)) return json({ ok: false, error: '"' + type.slice(0, 80) + '" is not a usable event type.' }, 400);
  if (type !== workflow.triggerEvent) {
    return json({ ok: false, error: 'This address accepts "' + workflow.triggerEvent + '" events only; it was sent "' + type + '".' }, 400);
  }

  if (!body.contact_email && !body.contact_id) {
    return json({ ok: false, error: 'An event needs a contact: send contact_email or contact_id.' }, 400);
  }

  try {
    const r = await emit(pgStore, {
      type,
      orgId: workflow.orgId,
      contactEmail: body.contact_email ? String(body.contact_email) : null,
      contactId: body.contact_id ? safeId(body.contact_id) : null,
      contact: body.contact || undefined,
      payload: (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) ? body.payload : {},
      // event_id is the sender's idempotency key. A sender that generates a fresh one per RETRY has
      // no idempotency at all, so the answer below always names the id that was used.
      eventId: body.event_id ? safeId(body.event_id, 128) : null,
      source: 'webhook',
    });
    return json({
      ok: r.accepted && !r.error,
      event_id: r.eventId,
      duplicate: r.duplicate,
      started_runs: r.startedRuns.length,
      error: r.error,
    }, r.accepted && !r.error ? 202 : 400);
  } catch (e: any) {
    console.error('[api/mail/automation/hook]', reasonOf(e));
    // The reason is logged, not returned: an unauthenticated-by-session caller does not get this
    // platform's internal failure text.
    return json({ ok: false, error: 'The event could not be recorded.' }, 500);
  }
};

export const GET: APIRoute = async () => json({ ok: false, error: 'Post a signed event to this address.' }, 405);
