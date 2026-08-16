// POST /api/mail/engine/events — the application's ear for the mail engine's delivery events.
//
// WHO OWNS WHAT. The mail engine (mail-engine/) owns SMTP, the queue, retries and bounce
// classification. Patch 1 owns the database. This route is the seam between them, and it is
// deliberately thin: it authenticates the caller, then writes into whatever storage exists.
//
// IT DOES NOT CREATE TABLES. The delivery_attempts / delivery_events / bounce_events /
// suppression_entries schema belongs to Patch 1, and a mail patch inventing its own version of those
// tables is how two agents end up with two half-populated schemas that neither trusts. So when they
// are not present yet, this route answers 503 — which the engine's publisher treats as "come back
// later" and holds the events in its durable outbox, in order, indefinitely. Nothing is lost while
// the two halves land, and the first flush after the tables appear delivers the whole backlog.
//
// The event payload is documented in mail-engine/docs/contracts.md. It is stable: adding a field is
// allowed, changing the meaning of one is not.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../../../../mail-engine/src/publish/signature';

export const prerender = false;

// The real Postgres reason is on e.cause; e.message is only the failed SQL. Declared above the
// handler that uses it — `const` is not hoisted, and that has broken this codebase before.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rows = (r: any) => (Array.isArray(r) ? r : r?.rows || []);

/** Requests older than this are refused even with a valid signature, so a capture cannot be replayed. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Does Patch 1's schema exist yet? Checked per request and NOT cached: the answer changes exactly
 * once, when their migration lands, and an engine holding a backlog should start draining it on the
 * next flush rather than after the next deploy of this application.
 */
async function tablesPresent(): Promise<{ events: boolean; suppressions: boolean; error: string | null }> {
  try {
    const found = rows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('delivery_events', 'suppression_entries')
    `)).map((r: any) => String(r.table_name));
    return { events: found.includes('delivery_events'), suppressions: found.includes('suppression_entries'), error: null };
  } catch (e: any) {
    // COULD-NOT-ASK AND NOT-THERE ARE DIFFERENT ANSWERS. A database hiccup that read as "no tables"
    // would answer 503 anyway, which is harmless here — but the log line has to say which it was,
    // because one of them is fixed by waiting and the other by looking at the database.
    return { events: false, suppressions: false, error: reasonOf(e) };
  }
}

export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.MAIL_APP_SHARED_SECRET || '';
  if (!secret) {
    console.error('[api/mail/engine/events] MAIL_APP_SHARED_SECRET is not set; refusing every event');
    return json({ ok: false, error: 'mail engine integration is not configured' }, 503);
  }

  const body = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER) || '';
  const timestamp = request.headers.get(TIMESTAMP_HEADER) || '';
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!signature || !timestamp || !Number.isFinite(age) || age > MAX_CLOCK_SKEW_MS) {
    return json({ ok: false, error: 'missing or stale signature' }, 401);
  }
  if (!verifySignature(secret, timestamp, body, signature)) {
    return json({ ok: false, error: 'bad signature' }, 401);
  }

  let payload: { events?: any[] };
  try {
    payload = JSON.parse(body);
  } catch {
    // 400 is the one status the engine treats as permanent. Reserved for a body that will never
    // parse, which is exactly this case.
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) return json({ ok: true, accepted: 0 });

  const present = await tablesPresent();
  if (!present.events) {
    console.warn(
      '[api/mail/engine/events] holding',
      events.length,
      'events:',
      present.error ? `could not read the schema (${present.error})` : 'delivery_events does not exist yet (Patch 1)',
    );
    return json({ ok: false, error: 'contract_not_ready', accepted: 0, held: events.length }, 503);
  }

  // ON CONFLICT DO NOTHING against the engine's event_id. The publisher retries a batch whose
  // response it never saw, so the same event can legitimately arrive twice; without the idempotency
  // key a network timeout would double every delivery count on every reporting screen.
  let accepted = 0;
  try {
    for (const e of events) {
      await db.execute(sql`
        INSERT INTO delivery_events (
          event_id, occurred_at, kind, stage, message_id, rfc_message_id, from_address,
          recipient, recipient_domain, attempt, smtp_code, enhanced_code, smtp_response,
          mx_host, tls, dkim_signed, latency_ms, bounce_class, reason, next_attempt_at
        ) VALUES (
          ${e.eventId}, ${e.occurredAt}, ${e.kind}, ${e.stage}, ${e.messageId}, ${e.rfcMessageId},
          ${e.from}, ${e.recipient}, ${e.recipientDomain}, ${e.attempt ?? 0}, ${e.smtpCode},
          ${e.enhancedCode}, ${e.smtpResponse}, ${e.mxHost}, ${e.tls}, ${e.dkimSigned},
          ${e.latencyMs}, ${e.bounceClass}, ${e.reason}, ${e.nextAttemptAt}
        )
        ON CONFLICT (event_id) DO NOTHING
      `);
      accepted += 1;
    }
  } catch (e: any) {
    // 500, not 400: a failed INSERT is our problem and the engine should keep the events and retry.
    console.error('[api/mail/engine/events] could not record delivery events:', reasonOf(e));
    return json({ ok: false, error: reasonOf(e), accepted }, 500);
  }

  return json({ ok: true, accepted });
};

export const GET: APIRoute = async () => {
  // A readiness probe for the engine side of the link, so "is the application ready to take events"
  // is answerable without posting one.
  const present = await tablesPresent();
  return json({
    ok: true,
    configured: !!process.env.MAIL_APP_SHARED_SECRET,
    deliveryEventsTable: present.events,
    suppressionEntriesTable: present.suppressions,
    schemaReadError: present.error,
    note: present.events
      ? 'ready'
      : 'delivery_events does not exist yet — events are being held in the engine outbox, in order, and nothing is lost',
  });
};
