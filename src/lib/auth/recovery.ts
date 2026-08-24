// src/lib/auth/recovery.ts — THE ONE PLACE A PASSWORD RECOVERY IS AUTHORISED.
//
// WHY THIS FILE EXISTS.
// Two unauthenticated endpoints could reset ANY account's password — including a super_admin — and
// hand the new password straight back in the HTTP response:
//
//   /api/auth/forgot-password        knowledge of a date of birth was the whole gate, and the
//                                    response body carried the new password. ~36,500 candidate
//                                    dates, no rate limit anywhere (a 600 ms sleep inside one
//                                    serverless invocation limits nothing — the next request runs
//                                    in a different container), and two distinguishable 404 texts
//                                    told an attacker whether the account existed at all.
//   /api/auth/verify-by-questions    returned a per-attempt `score`, so each fact could be probed
//                                    on its own (answer one field, leave the rest blank, read the
//                                    score) until the aggregate cleared the threshold. The question
//                                    token was an HMAC that fell back to a hard-coded literal and
//                                    was reusable for ten minutes.
//
// THE RULE THIS MODULE ENFORCES: knowledge alone never returns a credential. A knowledge check can
// only cause a SINGLE-USE, HASHED, EXPIRING, PURPOSE-BOUND token to be MAILED to the address already
// on the account. Proving you know a birthday is not proof you are the person; also holding their
// mailbox is the second condition that makes the reset meaningful.
//
// The raw token never touches the database (only its SHA-256), never appears in a response body,
// never appears in a log line, and is consumed atomically so two concurrent replays cannot both win.
//
// Attempt limiting deliberately REUSES countAttempt()/peekAttempts() from ./two-factor.ts rather
// than adding a second limiter with its own table. One limiter, one place to raise a threshold.
import { db } from '@/lib/db';
import { publicOrigin } from '@/lib/public-origin';
import { sql } from 'drizzle-orm';
import { ddlPermitted } from '@/lib/schema-bootstrap';
import { createHash, randomBytes } from 'node:crypto';
import { countAttempt, peekAttempts, clearAttempts } from '@/lib/auth/two-factor';

// Declared before every function that reads them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down on this project.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
export const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** A recovery link is short-lived: long enough to reach an inbox, short enough to matter. */
export const RECOVERY_TTL_MINUTES = 30;

/**
 * Purpose binding. A token minted by the DOB flow must not be redeemable by anything else, and vice
 * versa; the purpose is stored with the row and compared on consumption.
 */
export type RecoveryPurpose = 'password-reset';

// ── attempt limits ──────────────────────────────────────────────────────────
// Both windows are enforced. The per-account window stops a targeted date-of-birth sweep; the per-IP
// window stops a broad sweep across many accounts from one source. Neither is a lockout of the
// ACCOUNT — a recovery attempt limit must never become a way to lock a colleague out of signing in,
// so these buckets gate recovery only and are cleared on success.
export const RECOVERY_MAX_PER_ACCOUNT = 5;
export const RECOVERY_MAX_PER_IP = 20;
export const RECOVERY_WINDOW_SECONDS = 3600;

const accountBucket = (key: string, purpose: string) => 'recover:acct:' + purpose + ':' + createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32);
const ipBucket = (ip: string, purpose: string) => 'recover:ip:' + purpose + ':' + createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32);

export interface LimitVerdict {
  /** True when the caller has spent their allowance and must be refused. */
  blocked: boolean;
  /** Which window tripped — for the server log only, never for the response body. */
  scope: 'account' | 'ip' | null;
}

/**
 * Count this attempt and say whether the caller has run out of allowance.
 *
 * FAILS CLOSED. If the counter cannot be read or written the answer is "blocked": a recovery flow
 * whose rate limiter is down must refuse, not wave everyone through. Recovery is not a daily path,
 * so refusing for the minutes a database hiccup lasts costs a support email; the other direction
 * costs an account.
 */
export async function overRecoveryLimit(identityKey: string, ip: string, purpose: RecoveryPurpose): Promise<LimitVerdict> {
  try {
    const perIp = await countAttempt(ipBucket(ip, purpose), RECOVERY_WINDOW_SECONDS);
    if (perIp > RECOVERY_MAX_PER_IP) return { blocked: true, scope: 'ip' };
    const perAccount = await countAttempt(accountBucket(identityKey, purpose), RECOVERY_WINDOW_SECONDS);
    if (perAccount > RECOVERY_MAX_PER_ACCOUNT) return { blocked: true, scope: 'account' };
    return { blocked: false, scope: null };
  } catch (e: any) {
    console.error('[auth/recovery] limiter unavailable, refusing:', causeOf(e));
    return { blocked: true, scope: null };
  }
}

/** Give the allowance back after a genuine success, so one bad week is not a month of refusals. */
export async function clearRecoveryLimit(identityKey: string, ip: string, purpose: RecoveryPurpose): Promise<void> {
  await clearAttempts(accountBucket(identityKey, purpose)).catch(() => {});
  await clearAttempts(ipBucket(ip, purpose)).catch(() => {});
}

/** Read a bucket without spending from it. Used by surfaces that want to warn before the last try. */
export async function recoveryAttemptsUsed(identityKey: string, purpose: RecoveryPurpose): Promise<number> {
  try { return await peekAttempts(accountBucket(identityKey, purpose), RECOVERY_WINDOW_SECONDS); }
  catch { return RECOVERY_MAX_PER_ACCOUNT; }
}

// ── schema ──────────────────────────────────────────────────────────────────
// THE MEMO MUST NOT RECORD "DONE" FOR WORK PRODUCTION WAS FORBIDDEN TO DO.
//
// `ensured = true` was set whether or not anything was created. In production db.execute REFUSES
// DDL (src/lib/db/index.ts) and returns the same empty result a real CREATE gives, so the very first
// call on every instance sailed through, created nothing, and latched the flag — which then made the
// one call that IS allowed to create things a no-op. That is why /admin/ops and /admin/setup could
// press "run every bootstrap" on a warm instance and honestly report success over a table that still
// did not exist.
//
// So the flag is set only when the run could actually have created something. While DDL is
// suppressed the statements are re-issued on each call and cost NOTHING — guardedExecute returns a
// resolved empty array without touching the network — and the moment an operator opens the escape
// hatch with allowingDdl(), the next call does the real work.
let ensured = false;
export async function ensureRecoverySchema(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS auth_recovery_token (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL,
    purpose text NOT NULL,
    method text,
    created_ip text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_recovery_token_user_idx ON auth_recovery_token(user_id, purpose)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_recovery_token_expiry_idx ON auth_recovery_token(expires_at)`);
  // Only a run that was PERMITTED to create anything may record that it did.
  if (ddlPermitted()) ensured = true;
}

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

/**
 * Mint a recovery token for `userId`. Returns the RAW token — the only copy that will ever exist
 * outside the mail that carries it. Callers must put it in a link and must never put it in a
 * response body, a redirect the browser can read back, or a log line.
 *
 * Any earlier unconsumed token for the same user and purpose is dropped, so a second "email me a
 * link" click invalidates the first link rather than leaving two live doors.
 */
export async function issueRecoveryToken(
  userId: string, purpose: RecoveryPurpose, opts: { ip?: string; method?: string } = {},
): Promise<string> {
  await ensureRecoverySchema();
  const token = randomBytes(32).toString('base64url');
  await db.execute(sql`
    DELETE FROM auth_recovery_token
    WHERE (user_id = ${userId} AND purpose = ${purpose} AND consumed_at IS NULL) OR expires_at < now()
  `).catch(() => {});
  await db.execute(sql`
    INSERT INTO auth_recovery_token (token_hash, user_id, purpose, method, created_ip, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${purpose}, ${opts.method || null}, ${opts.ip || null},
            now() + make_interval(mins => ${RECOVERY_TTL_MINUTES}))
  `);
  return token;
}

export interface RecoveryHolder {
  userId: string;
  email: string | null;
  name: string | null;
  /**
   * users.is_active for the account this token belongs to.
   *
   * A RECOVERY FLOW MUST NOT BE A WAY BACK INTO A REVOKED ACCOUNT. Offboarding
   * (src/pages/admin/hr/employees/[id].astro, action `mark_relieved`) sets users.is_active = false
   * and tells the operator "The account is deactivated, so no sign-in method works." The person it
   * was just taken from still knows their own date of birth and still holds the personal mailbox on
   * users.email, so nothing in /api/auth/forgot-password stops them from being mailed a valid reset
   * link — the deactivation is the only thing standing between them and the account, and the reset
   * surface is where that has to be respected.
   *
   * Reported rather than inferred: `false` only when the row says so, so a column that cannot be
   * read does not turn every reset into a refusal.
   */
  isActive: boolean;
}

/**
 * Look at a token WITHOUT burning it, so the reset page can render a form and tell an expired link
 * apart from a wrong one. Returns null for unknown, expired, already-used, or wrong-purpose.
 */
export async function peekRecoveryToken(raw: string, purpose: RecoveryPurpose): Promise<RecoveryHolder | null> {
  if (!raw) return null;
  await ensureRecoverySchema();
  const rows = rowsOf(await db.execute(sql`
    SELECT t.user_id, u.email, u.name, u.is_active
    FROM auth_recovery_token t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${hashToken(raw)}
      AND t.purpose = ${purpose}
      AND t.consumed_at IS NULL
      AND t.expires_at > now()
    LIMIT 1
  `));
  const r = rows[0];
  if (!r) return null;
  return {
    userId: String(r.user_id),
    email: r.email ? String(r.email) : null,
    name: r.name ? String(r.name) : null,
    isActive: r.is_active !== false,
  };
}

/**
 * Burn the token and return whose it was. Single-use: the UPDATE matches only while consumed_at IS
 * NULL, so two concurrent redemptions cannot both succeed. Call this BEFORE writing the new
 * password, never after.
 */
export async function consumeRecoveryToken(raw: string, purpose: RecoveryPurpose): Promise<RecoveryHolder | null> {
  if (!raw) return null;
  await ensureRecoverySchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE auth_recovery_token SET consumed_at = now()
    WHERE token_hash = ${hashToken(raw)}
      AND purpose = ${purpose}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING user_id
  `));
  const r = rows[0];
  if (!r) return null;
  const who = rowsOf(await db.execute(sql`SELECT id, email, name, is_active FROM users WHERE id = ${String(r.user_id)} LIMIT 1`))[0];
  if (!who) return null;
  return {
    userId: String(who.id),
    email: who.email ? String(who.email) : null,
    name: who.name ? String(who.name) : null,
    isActive: who.is_active !== false,
  };
}

/** Build the absolute link a recovery mail carries. */
export function recoveryLink(origin: string, token: string): string {
  return origin.replace(/\/+$/, '') + '/reset-password?token=' + encodeURIComponent(token);
}

export type DeliveryOutcome = 'sent' | 'no-transport' | 'no-address';

/** Minimal escaping for the one name and the one link this mail interpolates. */
const escapeHtml = (v: string): string => String(v || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Mail the link. Returns what actually happened rather than a boolean dressed as success — a
 * recovery flow that reports "check your inbox" when no SMTP transport exists is the false-success
 * shape this codebase keeps paying for.
 *
 * THE MAIL HAD NO SENDER AND NO HTML PART, AND THAT IS WHY IT DID NOT ARRIVE.
 *
 * It called sendExternal({ to, subject, text }). SendExternalParams (src/lib/mail-transport.ts)
 * requires `from` and `html`, and the dynamic import was typed `any`, so nothing caught it. With
 * `from` undefined the whole From-normalisation block inside sendExternal is skipped — its regex
 * matches an empty string, callerAddr comes out '', and the branch that rewrites the address to the
 * configured from_address cannot fire — so nodemailer is handed `from: undefined`. It composes a
 * message with NO From header and issues `MAIL FROM:<>`, a null return path, on an AUTHENTICATED
 * submission connection. Providers enforce that the sender matches the account they authenticated
 * (which is the documented reason that normalisation exists at all), so the send is refused,
 * sendExternal answers ok:false, and this function reports 'no-transport'.
 *
 * That is the ONLY delivery path out of the entire recovery system: /api/auth/forgot-password,
 * /api/auth/verify-by-questions and /api/auth/identity-setup all end in issueAndMailReset. Each of
 * them is honest about the outcome — "We could not send the reset email just now", with a 503 —
 * so this reads as a mail-server fault rather than a bug, and nobody who forgot their password has
 * been able to get a link. src/lib/edu-notify.ts was repaired for the same omission.
 *
 * sendEmail() (src/lib/email.ts) resolves the sender the way every other transactional mail on this
 * platform resolves it: from_address out of Mail Settings, falling back to EMAIL_FROM. Imported
 * dynamically, as before, so a build with no transport configured still loads this file.
 */
export async function sendRecoveryMail(
  to: string | null, name: string | null, link: string,
): Promise<DeliveryOutcome> {
  if (!to || !to.includes('@')) return 'no-address';
  const greeting = name ? 'Hello ' + name + ',' : 'Hello,';
  const text = [
    greeting,
    '',
    'Someone asked to reset the password on your EduRankAI account.',
    'If that was you, open this link within ' + RECOVERY_TTL_MINUTES + ' minutes and choose a new password:',
    '',
    link,
    '',
    'The link can be used once and then stops working.',
    'If this was not you, no action is needed — your password has not changed. Tell hr@edurankai.in so we can look at it.',
  ].join('\n');
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111;">'
    + '<p>' + escapeHtml(greeting) + '</p>'
    + '<p>Someone asked to reset the password on your EduRankAI account.</p>'
    + '<p>If that was you, open this link within ' + RECOVERY_TTL_MINUTES + ' minutes and choose a new password:</p>'
    + '<p><a href="' + escapeHtml(link) + '">' + escapeHtml(link) + '</a></p>'
    + '<p>The link can be used once and then stops working.</p>'
    + '<p>If this was not you, no action is needed &mdash; your password has not changed. Tell hr@edurankai.in so we can look at it.</p>'
    + '</div>';
  try {
    const mod: any = await import('@/lib/email');
    const res = await mod.sendEmail({
      to,
      subject: 'Reset your EduRankAI password',
      html,
      text,
    });
    if (res?.ok) return 'sent';
    console.error('[auth/recovery] reset mail not delivered:', String(res?.error || 'unknown'));
    return 'no-transport';
  } catch (e: any) {
    // NEVER swallowed. A recovery mail that silently fails is an account nobody can get back into.
    console.error('[auth/recovery] reset mail threw:', causeOf(e));
    return 'no-transport';
  }
}

/**
 * The whole tail of every recovery flow: mint, mail, report honestly.
 *
 * `method` is recorded on the token row so an audit can say which check produced it (dob /
 * question_set), which the identity_verifications audit alone cannot express.
 */
export async function issueAndMailReset(
  user: { id: string; email?: string | null; name?: string | null },
  opts: { ip?: string; method?: string } = {},
): Promise<DeliveryOutcome> {
  const token = await issueRecoveryToken(user.id, 'password-reset', opts);
  // THE ORIGIN USED TO BE A PARAMETER, and all three callers passed
  // `new URL(request.url).origin` — the address the serverless FUNCTION was invoked on, not the one
  // the person typed. In production that is `https://localhost`, so every reset mail from every
  // recovery method carried a link nobody could open, with a valid token inside it and nothing in
  // any log to say so, because nothing failed. Resolved here now: no caller can get it wrong, and
  // src/lib/public-origin.ts explains why reading the Host header is not the repair either.
  return await sendRecoveryMail(user.email || null, user.name || null, recoveryLink(publicOrigin(), token));
}

/**
 * The caller's IP, as far as a proxy will admit to one.
 *
 * Added during the phase3-6 merge. Two recovery implementations were written in parallel on
 * separate branches -- one on main, one on the feature branch -- each complete, each with its own
 * function names. The feature branch's module won because /api/auth/identity-setup.ts depends on
 * its rate limiter, and that file carries the fix for a live account-takeover (the face-vs-ID
 * verdict used to be read out of the request body). But main's /api/auth/reset-password.ts imports
 * this helper, and the feature branch never had a reset-password route to need it.
 *
 * So it is defined here rather than deleting a reset page that works. x-forwarded-for is a list;
 * the client is the first entry. None of these headers is trustworthy -- a caller can send any of
 * them -- which is why the value is used for rate-limit bucketing and audit context and never as
 * an authorisation input.
 */
export function clientIpOf(request: Request): string {
  const h = request.headers;
  const fwd = h.get('x-forwarded-for') || '';
  const first = fwd.split(',')[0]?.trim();
  return (first || h.get('x-real-ip') || h.get('cf-connecting-ip') || '').slice(0, 64);
}
