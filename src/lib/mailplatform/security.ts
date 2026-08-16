// src/lib/mailplatform/security.ts — the four doors, and what each one checks.
//
//   1. THE ADMIN API      an authenticated operator editing workflows. Gated in the route by
//                         denyMailApi() (src/lib/auth/mail-access.ts) — the same gate the composer
//                         and the send endpoint use — and then scoped to their organisation here.
//   2. THE INTERNAL EMIT  platform code announcing something happened. Same admin gate; the source
//                         is recorded as 'internal' so an event's provenance is never guessed.
//   3. THE WEBHOOK        an outside system posting an event. A per-workflow token in the URL, an
//                         HMAC signature over the body, and a timestamp window. All three.
//   4. THE OUTBOUND HOOK  us calling somebody else's URL. Guarded against pointing back inside.
//
// A TOKEN ALONE IS NOT ENOUGH FOR DOOR 3, and this is the "prevent arbitrary webhook abuse" line in
// the specification. A URL token leaks the way URLs leak: a proxy log, a browser history, a
// screenshot in a support ticket. On its own it lets anybody who has ever seen it inject events —
// which in this system means starting real workflows that send real mail to real candidates. So the
// token only says WHICH workflow; the signature says the sender holds the shared secret, and the
// timestamp stops a captured request being replayed for ever.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * This platform runs one organisation. The column and every filter exist anyway, because the day a
 * second one appears is not the day to start adding tenant scoping to queries that already work.
 */
export const DEFAULT_ORG_ID = 'edurankai';

export function newWebhookToken(): string { return randomBytes(24).toString('hex'); }
export function newWebhookSecret(): string { return randomBytes(32).toString('hex'); }

/** Ids the engine writes. Not sequential — a run id appears in URLs and must not be guessable. */
export function newRunId(): string { return 'run_' + randomBytes(12).toString('hex'); }
export function newEventId(prefix = 'evt'): string { return prefix + '_' + randomBytes(12).toString('hex'); }
export function newWorkflowId(): string { return 'wf_' + randomBytes(10).toString('hex'); }

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;      // length is not the secret; timingSafeEqual throws on a mismatch
  return timingSafeEqual(ba, bb);
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}

export type WebhookVerdict = { ok: true } | { ok: false; status: 401 | 400 | 408; error: string };

/** Five minutes. Long enough for a slow sender and a clock a little out; short enough that a
 *  captured request is worthless by the time it turns up anywhere useful. */
export const WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

/** The largest body accepted at the webhook door. An event is a fact, not a file. */
export const MAX_WEBHOOK_BODY = 64 * 1024;

/**
 * Verify an inbound webhook. Fails closed everywhere, including when no secret is configured on the
 * workflow — an unsigned door is not a door, and this endpoint can start sends.
 */
export function verifyWebhook(opts: {
  secret: string | null | undefined;
  body: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  now: Date;
}): WebhookVerdict {
  const secret = String(opts.secret || '').trim();
  if (!secret) return { ok: false, status: 401, error: 'This workflow has no webhook secret, so signed events cannot be verified and none are accepted.' };
  if (opts.body.length > MAX_WEBHOOK_BODY) return { ok: false, status: 400, error: 'The body is larger than 64 KB.' };

  const ts = String(opts.timestamp || '').trim();
  if (!ts) return { ok: false, status: 401, error: 'The X-Automation-Timestamp header is missing.' };
  const tsMs = /^\d+$/.test(ts) ? Number(ts) * (ts.length <= 10 ? 1000 : 1) : Date.parse(ts);
  if (!Number.isFinite(tsMs)) return { ok: false, status: 401, error: 'The X-Automation-Timestamp header is not a time.' };
  if (Math.abs(opts.now.getTime() - tsMs) > WEBHOOK_WINDOW_MS) {
    return { ok: false, status: 408, error: 'That request is more than five minutes old or five minutes ahead. Check the sending system clock.' };
  }

  const sig = String(opts.signature || '').trim().replace(/^sha256=/i, '');
  if (!sig) return { ok: false, status: 401, error: 'The X-Automation-Signature header is missing.' };
  if (!constantTimeEqual(sig, signWebhookBody(secret, ts, opts.body))) {
    return { ok: false, status: 401, error: 'The signature does not match the body.' };
  }
  return { ok: true };
}

/**
 * May this workflow row be shown to, or edited by, a caller acting for `orgId`?
 *
 * Called on every single read and write that takes an id from a request. A workflow id is a string
 * from a browser; without this, the id of a workflow belonging to somebody else is a working URL.
 */
export function ownedBy(record: { orgId: string } | null | undefined, orgId: string): boolean {
  return !!record && record.orgId === orgId;
}

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,   // carrier-grade NAT
];

/**
 * Refuse an outbound webhook URL that points back inside.
 *
 * Without this, anybody who can author a workflow can make the SERVER fetch an address only the
 * server can reach — a cloud metadata endpoint, an internal admin port — and read the response back
 * off the run detail page. That is server-side request forgery, and an automation builder is an
 * unusually convenient place to perform it because the fetch is expected, scheduled and repeated.
 *
 * A hostname that resolves to a private address at request time still gets through this check; DNS
 * is not resolved here. That is stated rather than papered over — the remaining protection is that
 * only authenticated operators holding mail.manage can author a workflow at all, the URL is visible
 * on the workflow page, and every call is recorded on the step.
 */
export function assertSafeOutboundUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try { url = new URL(String(raw || '')); } catch { return { ok: false, error: 'That is not a URL: "' + String(raw).slice(0, 80) + '".' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'A webhook URL must be https. Plain http would send contact data across the network in the clear.' };
  if (url.username || url.password) return { ok: false, error: 'Do not put credentials in the URL; they end up in logs. Use a header.' };
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, error: 'That address is inside this network, so it is refused.' };
  }
  if (host === '[::1]' || host === '::1') return { ok: false, error: 'That address is this machine, so it is refused.' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) {
    return { ok: false, error: 'That is a private address, so it is refused.' };
  }
  return { ok: true, url };
}

/** Trim, cap and normalise anything a browser sends us as an id. */
export function safeId(v: unknown, max = 64): string {
  return String(v ?? '').trim().slice(0, max);
}
