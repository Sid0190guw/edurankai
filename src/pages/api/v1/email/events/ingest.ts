// POST /api/v1/email/events/ingest — the internal seam where delivery outcomes arrive.
//
// THIS IS THE HONEST BOUNDARY BETWEEN TWO WORKSTREAMS. The transactional platform owns the event
// model, the status machine and the webhook fan-out. It does NOT own the SMTP conversation, the
// bounce mailbox or the feedback loop — those belong to the mail infrastructure workstream. So
// `delivered`, `bounced`, `deferred` and `complained` cannot be invented here: something has to
// observe them and report them, and this is the endpoint it reports them to.
//
// WHAT THAT MEANS TODAY, PLAINLY. `queued`, `sent`, `failed` and (when a message is deferred by the
// receiving server) `deferred` are produced by our own send path and are real right now. `opened` and
// `clicked` are produced by the tracking endpoints when a send opts into them. `unsubscribed` is
// produced by the one-click handler. `delivered` and `complained` require, respectively, a DSN
// success notification and a provider feedback loop; until the inbound side parses those and calls
// this endpoint, no message will ever reach the `delivered` status. Documenting a `delivered` webhook
// that can never fire would be worse than saying so.
//
// AUTHORISATION IS A SHARED SECRET, NOT AN API KEY. A customer key must never be able to declare its
// own mail delivered.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { recordEventById, getMessage } from '@/lib/mailapi/messages';
import { messageIdFromRfc } from '@/lib/mailapi/send';
import { suppress } from '@/lib/mailapi/suppression';
import { EVENT_TYPES } from '@/lib/mailapi/webhooks';
import { dbReason } from '@/lib/mailapi/schema';
import { ApiError, readJsonBody, statusFor } from '@/lib/mailapi/errors';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

const INGESTABLE = new Set(['email.delivered', 'email.deferred', 'email.bounced', 'email.failed', 'email.complained']);

// TWO CEILINGS, BOTH REFUSALS. Declared here, above the handler that reads them, because a const is
// not hoisted and this project has taken outages from exactly that.
//
// This route used to read its body with request.json(), which has NO ceiling at all: one caller could
// make the process buffer as many megabytes as it cared to send before a single field was looked at.
// The shared secret that opens this endpoint falls back to CRON_SECRET, so "a caller" is a wider set
// than the bounce processor we had in mind when we wrote it. readJsonBody() measures the BYTES
// ACTUALLY READ rather than trusting Content-Length, because a header is a claim and a client that
// lies about it walks straight through any header-only check.
//
// 1 MB is sized off the real payload, not guessed. The largest event this endpoint will accept is
// roughly `error` 500 chars + `diagnostic_code` 300 + a message id + a recipient + a 60-char source +
// the key names, so about 1.1 KB of JSON. A completely full batch of MAX_EVENTS at that worst case
// measures 582,012 bytes — call it 570 KB — so 1 MB fits the largest legitimate batch with about the
// same again to spare, and matches the ceiling the public send route already uses
// (LIMITS.maxBodyBytes). The number is measured rather than estimated; if MAX_EVENTS or the field
// slices below grow, re-measure instead of assuming this still holds.
const MAX_BODY_BYTES = 1024 * 1024;

// A megabyte of TINY events is still an unbounded loop: every element costs a recordEventById round
// trip, and a bounce or a complaint costs a getMessage plus a suppress() per recipient on top of it.
// So the COUNT is bounded independently of the byte size. The batch is refused whole rather than
// truncated at the limit: silently dropping events 501 and beyond would report success to a bounce
// processor while the addresses in the dropped tail stayed un-suppressed and kept being mailed.
const MAX_EVENTS = 500;

async function authorized(request: Request, url: URL, locals: any): Promise<boolean> {
  const secret = process.env.MAILAPI_INGEST_SECRET || process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth === 'Bearer ' + secret) return true;
    if (url.searchParams.get('key') === secret) return true;
  }
  const user = locals?.user;
  if (!user) return false;
  try { return (await can(user, 'administer', { type: 'platform' })).allow; } catch { return false; }
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!(await authorized(request, url, locals))) return json({ ok: false, error: 'unauthorized' }, 403);

  let body: any;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch (err: any) {
    // readJsonBody speaks the developer-API error envelope; this internal seam has always answered
    // { ok, error } and the mail infrastructure workstream parses that shape, so the message and the
    // status are translated here rather than changing the contract on the producer side.
    if (err instanceof ApiError) return json({ ok: false, error: err.message }, statusFor(err.code));
    // Anything else means we COULD NOT READ the body, which is a different answer from "the body was
    // bad" — answering 400 would send somebody hunting for a malformed payload that was never the
    // problem. The real reason (which lives on e.cause) is logged, and the caller is told plainly.
    console.error('[mailapi] event ingest could not read the request body:', dbReason(err));
    return json({ ok: false, error: 'request body could not be read' }, 500);
  }

  // readJsonBody returns {} for a blank body where request.json() used to throw. An empty POST is a
  // caller mistake, not a batch, and must not fall through as one anonymous event with no type.
  if (!body || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
    return json({ ok: false, error: 'no events' }, 400);
  }

  const events: any[] = Array.isArray(body) ? body : (Array.isArray(body?.events) ? body.events : [body]);
  if (events.length === 0) return json({ ok: false, error: 'no events' }, 400);
  if (events.length > MAX_EVENTS) {
    return json({ ok: false, error: 'at most ' + MAX_EVENTS + ' events per call; this batch carries ' + events.length + '. Nothing was recorded — split it and send the whole batch again.' }, 413);
  }

  const results: any[] = [];
  for (const e of events) {
    const type = String(e?.type || '');
    if (!INGESTABLE.has(type)) {
      results.push({ ok: false, type, error: 'not an ingestable event type. Accepted: ' + Array.from(INGESTABLE).join(', ') + ' (the full catalogue is ' + EVENT_TYPES.join(', ') + ').' });
      continue;
    }
    // Either our message id or the RFC Message-Id we stamped on the outgoing mail, which is what a
    // bounce report actually carries.
    const id = String(e?.message_id || '').trim() || messageIdFromRfc(String(e?.rfc_message_id || '')) || '';
    if (!id) { results.push({ ok: false, type, error: 'no message_id or recognisable rfc_message_id' }); continue; }

    try {
      const recorded = await recordEventById(id, type, {
        recipient: e?.recipient ? String(e.recipient).toLowerCase() : null,
        data: {
          error: e?.error ? String(e.error).slice(0, 500) : undefined,
          bounce_type: e?.bounce_type ? String(e.bounce_type) : undefined,
          diagnostic_code: e?.diagnostic_code ? String(e.diagnostic_code).slice(0, 300) : undefined,
          reported_by: e?.source ? String(e.source).slice(0, 60) : 'ingest',
        },
      });
      // A hard bounce or a complaint suppresses the address. This is where a feedback loop actually
      // takes effect: without it, "we honour complaints" would be a claim with no mechanism.
      if (recorded.recorded && (type === 'email.bounced' || type === 'email.complained')) {
        const hard = type === 'email.complained' || String(e?.bounce_type || 'hard').toLowerCase() !== 'soft';
        if (hard) {
          const message = await getMessage(id);
          const targets = e?.recipient ? [String(e.recipient).toLowerCase()] : (message?.to || []);
          for (const t of targets) {
            if (message) {
              await suppress({
                orgId: message.orgId, environment: message.environment, email: t,
                reason: type === 'email.complained' ? 'complaint' : 'bounce',
                source: e?.source ? String(e.source).slice(0, 60) : 'ingest',
                detail: e?.error ? String(e.error) : null,
              });
            }
          }
        }
      }
      results.push({ ok: recorded.recorded, type, message_id: id, reason: recorded.reason });
    } catch (err: any) {
      console.error('[mailapi] event ingest failed:', dbReason(err));
      results.push({ ok: false, type, message_id: id, error: dbReason(err) });
    }
  }

  const accepted = results.filter((r) => r.ok).length;
  return json({ ok: accepted > 0, accepted, rejected: results.length - accepted, results }, accepted > 0 ? 200 : 422);
};

export const GET: APIRoute = async () => json({
  ok: true,
  object: 'ingest_contract',
  accepts: Array.from(INGESTABLE),
  auth: 'Authorization: Bearer $MAILAPI_INGEST_SECRET (falls back to $CRON_SECRET), or an admin session.',
  body: {
    events: [{
      type: 'email.bounced',
      message_id: 'uuid, or rfc_message_id: "<uuid@edurankai.in>"',
      recipient: 'who bounced (optional; defaults to every To recipient)',
      bounce_type: 'hard | soft',
      error: 'the SMTP text',
      diagnostic_code: 'the DSN diagnostic, if present',
      source: 'which component observed it',
    }],
  },
  // Published so a producer sizes its batches from the contract instead of discovering the ceiling
  // as a 413 in production.
  limits: {
    max_events_per_call: MAX_EVENTS,
    max_body_bytes: MAX_BODY_BYTES,
    on_exceeded: 'the whole batch is refused (413) and nothing is recorded; it is never truncated, so split it and resend.',
  },
  note: 'email.delivered and email.complained have no producer yet: they need DSN success parsing and a provider feedback loop on the inbound side. Until that exists no message reaches the delivered status.',
});
