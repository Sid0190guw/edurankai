// /api/mail/automation/events — announce an event from inside the platform, and read the log.
//
// This is door 2 of the four in src/lib/mailplatform/security.ts: an authenticated operator or a
// signed-in part of this platform saying "this happened". It is NOT the webhook door — an outside
// system posts to /api/mail/automation/hook/[token] and is authenticated by signature, not session.
//
// SEND YOUR OWN event_id. It is the idempotency key: a retried POST carrying the same id does
// nothing the second time, which is what makes it safe to retry a request whose response you never
// saw. Without one an id is generated, and two POSTs of "the same" event are two events and two
// runs — a duplicate letter to the same candidate.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { pgStore } from '@/lib/mailplatform/pg-store';
import { ORG_ID } from '@/lib/mailplatform/service';
import { emit } from '@/lib/mailplatform/router';
import { isUsableEventType } from '@/lib/mailplatform/triggers';
import { safeId } from '@/lib/mailplatform/security';
import { reasonOf } from '@/lib/mailplatform/errors';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ locals, url }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.events.read' });
  if (denied) return denied;
  try {
    return json({
      ok: true,
      events: await pgStore.listEvents(ORG_ID, {
        type: safeId(url.searchParams.get('type'), 80) || undefined,
        limit: Math.min(200, Number(url.searchParams.get('limit') || 50) || 50),
      }),
    });
  } catch (e: any) {
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.events.write' });
  if (denied) return denied;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const type = String(body.type || '').trim();
  if (!isUsableEventType(type)) {
    return json({ ok: false, error: '"' + type.slice(0, 80) + '" is not a usable event type. Use a dotted lower-case name, e.g. application.stage.changed.' }, 400);
  }
  if (!body.contact_email && !body.contact_id) {
    return json({ ok: false, error: 'An event needs a contact: send contact_email or contact_id.' }, 400);
  }

  try {
    const r = await emit(pgStore, {
      type,
      orgId: ORG_ID,
      contactEmail: body.contact_email ? String(body.contact_email) : null,
      contactId: body.contact_id ? safeId(body.contact_id) : null,
      contact: body.contact || undefined,
      payload: (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) ? body.payload : {},
      eventId: body.event_id ? safeId(body.event_id, 128) : null,
      source: 'api',
    });
    return json({
      ok: r.accepted && !r.error,
      event_id: r.eventId,
      duplicate: r.duplicate,
      started_runs: r.startedRuns,
      // Every candidate workflow and why it did or did not start. This is what makes "my automation
      // did not fire" answerable without reading any code.
      decisions: r.decisions,
      error: r.error,
    }, r.accepted && !r.error ? 200 : 400);
  } catch (e: any) {
    console.error('[api/mail/automation/events]', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};
