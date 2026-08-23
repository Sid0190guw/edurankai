// POST /api/mail/automation/hook/[token] — the door an OUTSIDE system posts events through.
//
// THREE THINGS ARE CHECKED, AND A TOKEN ON ITS OWN IS NOT ENOUGH.
//
//   1. The token identifies WHICH automation. Nothing more. A URL token leaks the way URLs leak — a
//      proxy log, a browser history, a screenshot in a support ticket — and on its own it would let
//      anybody who has ever seen it start real automations that mail real candidates.
//   2. X-Automation-Signature is an HMAC-SHA256 of "<timestamp>.<body>" under the automation's secret.
//      That is what proves the sender holds the secret and that the body was not altered on the way.
//   3. X-Automation-Timestamp must be within five minutes, so a captured request cannot be replayed
//      for ever.
//
// It fails CLOSED everywhere, including when the automation has no secret configured. src/middleware.ts
// exempts everything under /api/, so nothing stands in front of this URL but this file.
//
// The organisation comes from the AUTOMATION ROW, never from the request. A sender does not choose
// which tenant their events land in.
import type { APIRoute } from 'astro';
import { pgStore, webhookSecretFor } from '@/lib/mailplatform/pg-store';
import { emit } from '@/lib/mailplatform/router';
import { canonicalEventType, isUsableEventType } from '@/lib/mailplatform/triggers';
import { triggerNode } from '@/lib/mailplatform/graph';
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

  const automation = token ? await pgStore.getAutomationByWebhookToken(token) : null;
  // The same 404 for "no such token" and "token disabled": a caller probing tokens learns nothing
  // from the difference, and there is nothing useful to tell a legitimate sender either.
  if (!automation) return json({ ok: false, error: 'No automation accepts events at this address.' }, 404);

  const verdict = verifyWebhook({
    secret: await webhookSecretFor(automation.orgId, automation.id),
    body: raw,
    signature: request.headers.get('x-automation-signature'),
    timestamp: request.headers.get('x-automation-timestamp'),
    now: new Date(),
  });
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, verdict.status);

  let body: any = {};
  try { body = JSON.parse(raw || '{}'); } catch { return json({ ok: false, error: 'The body is not JSON.' }, 400); }

  // THE EVENT TYPE IS PINNED TO THIS AUTOMATION'S OWN TRIGGER. Without this, a signed sender could
  // post ANY event type and start every other automation in the organisation — the signature would
  // prove only that they were allowed to feed this one.
  const listensFor = canonicalEventType(String((triggerNode(automation.graph)?.config || {}).event || ''));
  const type = canonicalEventType(String(body.type || listensFor || '').trim());
  if (!isUsableEventType(type)) return json({ ok: false, error: '"' + type.slice(0, 80) + '" is not a usable event type.' }, 400);
  if (!listensFor) return json({ ok: false, error: 'That automation has no trigger, so it accepts nothing.' }, 400);
  if (type !== listensFor) {
    return json({ ok: false, error: 'This address accepts "' + listensFor + '" events only; it was sent "' + type + '".' }, 400);
  }

  if (!body.contact_email && !body.contact_id) {
    return json({ ok: false, error: 'An event needs a contact: send contact_email or contact_id.' }, 400);
  }

  try {
    const r = await emit(pgStore, {
      type,
      orgId: automation.orgId,
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
