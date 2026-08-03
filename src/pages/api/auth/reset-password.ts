// POST /api/auth/reset-password
// Body: { token: string, password: string }
//
// Redeems the single-use link mailed by /api/auth/forgot-password and /api/auth/verify-by-questions
// and sets the new password the person chose. This is the ONLY place in the recovery flows that
// writes users.password_hash.
//
// The split matters. Before this file existed, "you answered the question correctly" and "you now
// hold a working password" were the same HTTP response, so anyone who could guess a date of birth
// received the account. Now proving the claim only causes a link to be mailed TO THE ADDRESS ON THE
// ACCOUNT; possession of that mailbox is what actually resets the password. An attacker who defeats
// the knowledge check and does not hold the mailbox ends up with nothing.
//
// What this route deliberately does NOT do:
//   - it does not set is_active. A deactivated account stays deactivated; reviving an offboarded
//     person is an admin decision, not a side effect of a forgotten password.
//   - it does not sign anybody in. It returns to the normal login page.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { hashPassword } from '@/lib/auth/password';
import { invalidateAllUserSessions } from '@/lib/auth/session';
import {
  CSRF_REJECTED_MESSAGE,
  checkRateLimit,
  clientIpOf,
  consumeResetToken,
  notifyPasswordChanged,
  recordAttempt,
  verifyRecoveryCsrf,
} from '@/lib/auth/recovery';

// postgres-js resolves to a plain array, never a { rows } object.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

const ROUTE = 'token_redeem' as const;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const token = (body?.token || '').toString().trim();
  const password = (body?.password || '').toString();
  const ip = clientIpOf(request, clientAddress);

  // CSRF. This is the request that actually changes a password, so a cross-site page must not be
  // able to drive it — a token pulled out of a victim's inbox preview and posted from elsewhere is
  // exactly the shape this stops.
  const csrf = verifyRecoveryCsrf(request, cookies);
  if (!csrf.ok) {
    await recordAttempt({ route: ROUTE, identifier: ip || 'unknown', ip, outcome: 'csrf_rejected', detail: csrf.reason });
    return json({ ok: false, error: CSRF_REJECTED_MESSAGE }, 403);
  }

  if (!token) return json({ ok: false, error: 'This link is missing its token. Open the link from your email again.' }, 400);
  if (password.length < MIN_PASSWORD) return json({ ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters.' }, 400);
  if (password.length > MAX_PASSWORD) return json({ ok: false, error: 'Password is too long.' }, 400);

  // Counted per IP here rather than per account: the identifier is a 256-bit token, so there is no
  // account name to key on until it has been redeemed. This bounds guessing at the token itself.
  const limit = await checkRateLimit(ROUTE, ip || 'unknown', ip);
  if (!limit.allowed) {
    await recordAttempt({ route: ROUTE, identifier: ip || 'unknown', ip, outcome: 'rate_limited', detail: limit.scope });
    return json({ ok: false, error: 'Too many attempts. Wait ' + Math.ceil(limit.retryAfterSeconds / 60) + ' minutes and try again.' }, 429);
  }

  try {
    // Atomic claim: single-use is enforced by the UPDATE's own WHERE clause, not by a prior read.
    const claim = await consumeResetToken(token, ip);
    if (!claim.ok || !claim.userId) {
      await recordAttempt({ route: ROUTE, identifier: ip || 'unknown', ip, outcome: 'token_' + (claim.reason || 'invalid') });
      const msg = claim.reason === 'expired'
        ? 'That reset link has expired. Request a new one.'
        : claim.reason === 'used'
          ? 'That reset link has already been used. Request a new one.'
          : claim.reason === 'unavailable'
            ? 'Password reset is temporarily unavailable. Email hr@edurankai.in.'
            : 'That reset link is not valid. Request a new one.';
      return json({ ok: false, error: msg }, claim.reason === 'unavailable' ? 503 : 400);
    }

    const uRows = rows(await db.execute(sql`SELECT id, email, name, is_active FROM users WHERE id = ${claim.userId} LIMIT 1`));
    if (uRows.length === 0) {
      await recordAttempt({ route: ROUTE, identifier: ip || 'unknown', ip, userId: claim.userId, outcome: 'user_gone' });
      return json({ ok: false, error: 'That account no longer exists. Email hr@edurankai.in.' }, 400);
    }
    const user = uRows[0] as any;

    const hash = await hashPassword(password);
    // NOTE the columns that are NOT here: is_active is untouched on purpose.
    await db.execute(sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${user.id}`);

    // A password change ends every existing session. If the reset was an attacker's, this closes the
    // session they may already hold; if it was the owner's, signing in again is the expected cost.
    try {
      await invalidateAllUserSessions(String(user.id));
    } catch (e: any) {
      console.error('[reset-password] session revocation failed:', causeOf(e));
    }

    await recordAttempt({ route: ROUTE, identifier: String(user.email || user.id), ip, userId: String(user.id), outcome: 'password_set' });

    // Tell the owner. The password is already changed by this point, so a mail failure is reported in
    // the response rather than reversing the reset — but it is never hidden.
    let notified = true;
    let notifyError: string | undefined;
    if (user.email) {
      const n = await notifyPasswordChanged(String(user.email), String(user.name || ''), ip);
      notified = n.ok;
      notifyError = n.error;
      if (!n.ok) console.error('[reset-password] owner notification not sent:', n.error);
    } else {
      notified = false;
      notifyError = 'no email on account';
    }

    return json({
      ok: true,
      notified,
      notifyError: notified ? undefined : notifyError,
      inactive: user.is_active === false,
      message: user.is_active === false
        ? 'Your password is set, but this account is deactivated and cannot sign in. Contact hr@edurankai.in.'
        : 'Your password is set. Sign in with it now.',
    });
  } catch (e: any) {
    // Never swallowed in a signing path: the real cause is logged and the caller is told it failed.
    console.error('[reset-password] failed:', causeOf(e));
    await recordAttempt({ route: ROUTE, identifier: ip || 'unknown', ip, outcome: 'error', detail: causeOf(e) }).catch(() => {});
    return json({ ok: false, error: 'We could not set your password. Try the link again, or email hr@edurankai.in.' }, 500);
  }
};
