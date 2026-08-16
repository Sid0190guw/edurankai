// src/lib/mailsec/sending.ts — WHAT MUST BE TRUE BEFORE A MESSAGE LEAVES THE BUILDING.
//
// ═══ THE GAP THIS FILLS ═══
//
// /api/mail/send is the one send path in this product ("one mail system", as src/lib/mail-shared.ts
// puts it). Everything goes through it: the admin composer, the employee mailbox, replies,
// `@group:slug` distribution lists, and scheduled sends when they come due.
//
// It had no volume control of any kind. No per-account rate limit, no cap on recipients per
// message, no daily ceiling, and no suppression check — so an address that hard-bounced, marked us
// as spam, or clicked unsubscribe was still deliverable from here, even though the CAMPAIGN path
// (src/lib/mail-recipients.ts) has enforced exactly those rules all along. Two send paths, one of
// them enforcing the rules. The list an unsubscribe writes to is `mail_suppression`; this module
// makes the other path read it.
//
// The asset is not the mailbox. It is the sending reputation of the domain — the one thing in this
// system that cannot be restored by rotating a secret. One compromised or careless account with an
// unbounded send loop costs months of deliverability for everybody.
//
// ═══ IT FAILS CLOSED, AND THAT IS A DELIBERATE DISAGREEMENT WITH ITS NEIGHBOUR ═══
//
// src/lib/mailapi/ratelimit.ts fails OPEN — if the counters cannot be read it allows the request and
// logs. That is right for what it guards: an API whose limiter is a fairness device, where a
// database hiccup becoming a total sending outage for every customer is the larger incident.
//
// This one fails CLOSED. It guards a different thing. An abuse ceiling that stops counting has
// stopped being an abuse ceiling, and the failure modes are not symmetric: a refused send is a
// message the sender sees refused and can retry in a minute, while an unbounded one is mail that
// cannot be recalled and a domain reputation that takes months to rebuild. The two files disagree
// on purpose, and each says why, so neither gets "fixed" to match the other by accident.
//
// ═══ WHAT IT REUSES RATHER THAN REBUILDS ═══
//
//   counting        mailapi_rate_windows, through mailapi/ratelimit.consume() — its INSERT … ON
//                   CONFLICT … RETURNING is atomic, which a SELECT-then-UPDATE would not be
//   suppression     mail_suppression, the table /api/mail/unsubscribe and the campaign bounce
//                   handler already write to. A second suppression list would mean an address
//                   unsubscribed on one path still receiving on the other, which is the failure the
//                   whole mechanism exists to prevent
//   addresses       src/lib/mailsec/headers.ts
//   body            src/lib/mailsec/html.ts
//
// No new table. Nothing here is a second copy of a decision made somewhere else.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { textIn } from '@/lib/pg-array';
import { consume, type Limit } from '@/lib/mailapi/ratelimit';
import { checkAddressList, checkSubject, checkMessageId, normalizeAddress, type AddressListResult } from './headers';
import { sanitizeEmailHtml, OUTBOUND } from './html';

function rows<T = any>(r: any): T[] { return (Array.isArray(r) ? r : (r?.rows || [])) as T[]; }
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * The ceilings.
 *
 * Set high enough that no ordinary working day touches them and low enough that an automated loop
 * hits one within a minute. They are environment-overridable because the right number is an
 * operational fact about this company's mail volume, not a constant somebody should have to edit
 * code to change — but the DEFAULT is the safe one, so an unset variable never means "no limit".
 */
export const LIMITS = {
  /** Addresses on a single message, across To + Cc + Bcc. A list larger than this is a campaign. */
  recipientsPerMessage: () => envInt('MAIL_MAX_RECIPIENTS_PER_MESSAGE', 200),
  /** Messages one account may send per hour. */
  messagesPerHour: (): Limit => ({ limit: envInt('MAIL_MAX_MESSAGES_PER_HOUR', 120), windowSec: 3600 }),
  /** Addresses one account may reach per hour, summed over every message. The real spam ceiling. */
  recipientsPerHour: (): Limit => ({ limit: envInt('MAIL_MAX_RECIPIENTS_PER_HOUR', 2000), windowSec: 3600 }),
  /** A short window, so a burst is stopped in seconds rather than after an hour's worth of mail. */
  messagesPerMinute: (): Limit => ({ limit: envInt('MAIL_MAX_MESSAGES_PER_MINUTE', 20), windowSec: 60 }),
};

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual' | 'invalid';

/**
 * Reasons that hold even for a transactional message.
 *
 * A hard bounce means the address does not exist — sending again is not a courtesy to anybody, it is
 * a deliverability penalty. A complaint means somebody pressed "this is spam"; mailing them again is
 * the single fastest way onto a blocklist, and src/lib/mail-contacts.ts already refuses to lift a
 * complaint for exactly that reason. `invalid` is the same fact as a bounce, recorded earlier.
 *
 * `unsubscribed` and `manual` are marketing preferences, and they do NOT block an offer letter, a
 * password reset or a reply to a message the person themselves sent. That distinction is the whole
 * reason this is two lists rather than one flag.
 */
const ALWAYS_BLOCKING: ReadonlySet<string> = new Set(['bounced', 'complained', 'invalid']);

export interface DroppedRecipient {
  email: string;
  reason: string;
  /** The suppression category, when that is why. */
  suppression: SuppressionReason | null;
}

export interface OutboundRequest {
  /** The account the message is attributed to. Every counter is keyed on this. */
  userId: string;
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: unknown;
  bodyHtml: unknown;
  inReplyTo?: unknown;
  /**
   * A message the recipient's own action asked for: a reply, an offer letter, a password reset.
   * Marketing preferences do not block it; bounces and complaints still do.
   *
   * The CALLER must set this deliberately. It defaults to false, so an unconsidered send is treated
   * as marketing and gets the stricter rule.
   */
  transactional?: boolean;
}

export interface OutboundDecision {
  allowed: boolean;
  /** The sentence to show the sender when `allowed` is false. Null when it is true. */
  error: string | null;
  /** Recipients that survived every check, ready to send. */
  to: string[];
  cc: string[];
  bcc: string[];
  /** The subject and body as they should now be used. Sanitised, never the caller's copy. */
  subject: string;
  bodyHtml: string;
  /** Addresses removed, and why. NEVER silently dropped — the sender is told. */
  dropped: DroppedRecipient[];
  /** Things worth saying even on a successful send. */
  warnings: string[];
  /** How much of the hourly allowance is left, for a UI that wants to show it. */
  remaining: { messages: number; recipients: number } | null;
}

const REFUSE = (error: string, extra: Partial<OutboundDecision> = {}): OutboundDecision => ({
  allowed: false, error, to: [], cc: [], bcc: [], subject: '', bodyHtml: '',
  dropped: [], warnings: [], remaining: null, ...extra,
});

/**
 * Which of these addresses are suppressed, and why.
 *
 * Reads the same `mail_suppression` table src/lib/mail-contacts.ts writes. A reason-aware read
 * rather than that module's `suppressedAmong()`, because a set of addresses cannot answer "is this
 * a marketing preference or a hard bounce" — and getting that wrong in either direction is a real
 * cost: block a password reset, or re-mail somebody who reported us for spam.
 *
 * THROWS rather than returning empty on a database error. The caller fails the send. An empty
 * suppression list that came from a failed query looks exactly like an empty suppression list, and
 * "we could not check" must never render as "nobody is suppressed".
 */
export async function suppressionReasons(emails: string[]): Promise<Map<string, SuppressionReason>> {
  const list = [...new Set(emails.map(normalizeAddress).filter(Boolean))];
  const out = new Map<string, SuppressionReason>();
  if (!list.length) return out;

  for (let i = 0; i < list.length; i += 2000) {
    const chunk = list.slice(i, i + 2000);
    const r = await db.execute(sql`SELECT email, reason FROM mail_suppression WHERE email IN ${textIn(chunk)}`);
    for (const row of rows(r)) {
      out.set(String(row.email), String(row.reason || 'manual') as SuppressionReason);
    }
  }
  return out;
}

const SUPPRESSION_WORDING: Record<string, string> = {
  bounced: 'that address hard-bounced, so mail to it does not arrive',
  complained: 'that address reported a previous message as spam',
  invalid: 'that address was recorded as invalid',
  unsubscribed: 'that address unsubscribed',
  manual: 'that address is on the suppression list',
};

/**
 * Everything that must be true before /api/mail/send writes a row.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Cheap, local checks first; the counters last. A message that
 * is going to be refused for a malformed address must not first consume a slot from the sender's
 * hourly allowance — otherwise a buggy client burns a real person's quota on requests that never
 * had a chance of sending.
 */
export async function guardOutboundSend(req: OutboundRequest): Promise<OutboundDecision> {
  const warnings: string[] = [];
  const dropped: DroppedRecipient[] = [];

  // ── 1. Headers ────────────────────────────────────────────────────────────────────────────────
  const subject = checkSubject(req.subject);
  if (!subject.ok) return REFUSE(subject.reason + ' Nothing has been sent.');

  if (req.inReplyTo) {
    const irt = checkMessageId(req.inReplyTo);
    if (!irt.ok) return REFUSE('That reply refers to a message id we cannot use. Nothing has been sent.');
  }

  // ── 2. Addresses ──────────────────────────────────────────────────────────────────────────────
  const cap = LIMITS.recipientsPerMessage();
  const lists: Record<'to' | 'cc' | 'bcc', AddressListResult> = {
    to: checkAddressList(req.to, cap),
    cc: checkAddressList(req.cc, cap),
    bcc: checkAddressList(req.bcc, cap),
  };
  for (const kind of ['to', 'cc', 'bcc'] as const) {
    for (const r of lists[kind].rejected) {
      dropped.push({ email: r.value, reason: r.reason, suppression: null });
    }
  }

  // De-duplicate ACROSS the three fields, keeping the most visible placement. Somebody who is in
  // both To and Bcc gets one copy, and it is the one that shows their name.
  const claimed = new Set<string>();
  const take = (xs: string[]) => xs.filter((e) => (claimed.has(e) ? false : (claimed.add(e), true)));
  let to = take(lists.to.addresses);
  let cc = take(lists.cc.addresses);
  let bcc = take(lists.bcc.addresses);

  const total = to.length + cc.length + bcc.length;
  if (total === 0) {
    return REFUSE(
      dropped.length
        ? 'None of those addresses can be sent to: ' + dropped[0].reason + '. Nothing has been sent.'
        : 'Add at least one recipient.',
      { dropped },
    );
  }
  if (total > cap) {
    return REFUSE(
      'That is ' + total + ' recipients on one message, and the limit is ' + cap
      + '. Nothing has been sent — send it as a campaign, which handles unsubscribes and delivery pacing.',
      { dropped },
    );
  }
  if (lists.to.truncated || lists.cc.truncated || lists.bcc.truncated) {
    return REFUSE('That recipient list is longer than one message may carry. Nothing has been sent.', { dropped });
  }

  // ── 3. Suppression ────────────────────────────────────────────────────────────────────────────
  let suppressed: Map<string, SuppressionReason>;
  try {
    suppressed = await suppressionReasons([...to, ...cc, ...bcc]);
  } catch (e: any) {
    // FAILS CLOSED, LOUDLY. See the header. "We could not read the suppression list" is not
    // "nobody is suppressed", and mailing a complainant is not recoverable.
    console.error('[mailsec/sending] suppression list unreadable, refusing the send:', reasonOf(e));
    return REFUSE('The suppression list could not be read, so nothing has been sent. Try again in a moment.', { dropped });
  }

  if (suppressed.size) {
    const blocks = (email: string): SuppressionReason | null => {
      const reason = suppressed.get(email);
      if (!reason) return null;
      if (ALWAYS_BLOCKING.has(reason)) return reason;
      return req.transactional ? null : reason;
    };
    const keep = (xs: string[]) => xs.filter((e) => {
      const reason = blocks(e);
      if (!reason) return true;
      dropped.push({ email: e, reason: SUPPRESSION_WORDING[reason] || 'that address is suppressed', suppression: reason });
      return false;
    });
    to = keep(to); cc = keep(cc); bcc = keep(bcc);
  }

  const remainingCount = to.length + cc.length + bcc.length;
  if (remainingCount === 0) {
    return REFUSE(
      'Every recipient on this message is on the suppression list, so nothing has been sent: '
      + dropped.map((d) => d.email + ' — ' + d.reason).slice(0, 3).join('; '),
      { dropped },
    );
  }
  if (dropped.some((d) => d.suppression)) {
    warnings.push(
      dropped.filter((d) => d.suppression).length
      + ' recipient(s) were left out because they are on the suppression list. The message went to the rest.',
    );
  }

  // ── 4. Body ───────────────────────────────────────────────────────────────────────────────────
  const body = sanitizeEmailHtml(req.bodyHtml, OUTBOUND);
  if (!body.clean) {
    const kinds = [...new Set(body.removed.map((r) => r.kind))];
    // Said, not silent: a composer that quietly rewrites what somebody wrote is a composer people
    // stop trusting. This is a warning rather than a refusal because the common cause is a paste
    // from a word processor, not an attack.
    warnings.push('Some formatting was removed from the message before sending (' + kinds.join(', ') + ').');
  }

  // ── 5. Counters, last ─────────────────────────────────────────────────────────────────────────
  try {
    const perMinute = await consume('mailbox-msg-min', req.userId, LIMITS.messagesPerMinute());
    if (!perMinute.allowed) {
      return REFUSE('You are sending faster than this mailbox allows. Wait ' + perMinute.resetSec + ' seconds and try again — nothing has been sent.', { dropped });
    }
    const perHour = await consume('mailbox-msg-hour', req.userId, LIMITS.messagesPerHour());
    if (!perHour.allowed) {
      return REFUSE('This mailbox has reached its hourly message limit. Nothing has been sent; it resets in ' + Math.ceil(perHour.resetSec / 60) + ' minutes.', { dropped });
    }

    // Recipients are counted in one statement, not one per address: the ceiling is on ADDRESSES
    // REACHED, and a hundred messages of one recipient and one message of a hundred recipients are
    // the same amount of mail leaving the building.
    const recip = await consumeMany('mailbox-recipients-hour', req.userId, LIMITS.recipientsPerHour(), remainingCount);
    if (!recip.allowed) {
      return REFUSE('This mailbox has reached its hourly limit on how many addresses it can reach. Nothing has been sent; it resets in ' + Math.ceil(recip.resetSec / 60) + ' minutes.', { dropped });
    }

    return {
      allowed: true, error: null,
      to, cc, bcc,
      subject: subject.value,
      bodyHtml: body.html,
      dropped, warnings,
      remaining: { messages: perHour.remaining, recipients: recip.remaining },
    };
  } catch (e: any) {
    console.error('[mailsec/sending] rate counters unavailable, refusing the send:', reasonOf(e));
    return REFUSE('We could not check this mailbox’s sending limits, so nothing has been sent. Try again in a moment.', { dropped });
  }
}

/**
 * Add `n` to a window in one statement and decide.
 *
 * mailapi/ratelimit.consume() increments by exactly one, which is right for a request counter and
 * wrong for a recipient counter — calling it in a loop is N round-trips AND lets two concurrent
 * sends interleave past the ceiling. Same table, same atomicity, different step.
 */
async function consumeMany(
  dimension: string,
  id: string,
  limit: Limit,
  n: number,
  nowMs = Date.now(),
): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
  const { ensureMailApiSchema } = await import('@/lib/mailapi/schema');
  await ensureMailApiSchema();
  const windowMs = Math.max(1, Math.floor(limit.windowSec)) * 1000;
  const start = new Date(Math.floor(nowMs / windowMs) * windowMs);
  const bucket = dimension + ':' + String(id || 'none').slice(0, 120) + ':' + limit.windowSec;
  const step = Math.max(1, Math.floor(n));

  const r = await db.execute(sql`
    INSERT INTO mailapi_rate_windows (bucket, window_start, count) VALUES (${bucket}, ${start.toISOString()}, ${step})
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = mailapi_rate_windows.count + ${step}
    RETURNING count`);
  const count = Number(rows(r)[0]?.count || step);
  const resetSec = Math.max(1, Math.ceil((start.getTime() + windowMs - nowMs) / 1000));
  return { allowed: count <= limit.limit, remaining: Math.max(0, limit.limit - count), resetSec };
}
