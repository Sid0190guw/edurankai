// POST /api/auth/forgot-password
// Body: { emailOrName: string, dob: string }
//
// WHAT THIS USED TO DO, AND WHY IT COULD NOT STAY.
// It compared the submitted date of birth to the one on file and, on a match, generated a new
// password, wrote it to users.password_hash and RETURNED IT IN THE RESPONSE BODY. Unauthenticated.
// So the entire gate on every account on this platform — super_admin included — was a birthday:
// about 36,500 candidates, tried at whatever rate the attacker liked, because the only "limit" was
// `await new Promise(r => setTimeout(r, 600))` inside a single serverless invocation, which delays
// the caller who is already inside and limits nothing at all across requests. Two different 404
// texts ("no account found" vs "no date of birth on file") also told an attacker whether an address
// existed before they started guessing.
//
// WHAT IT DOES NOW.
//   1. Rate limits, in Postgres, per account AND per IP — the only kind of limit that survives a
//      stateless runtime. Fails CLOSED if the limiter itself cannot be read.
//   2. Never returns a credential. A correct date of birth causes a single-use, hashed, expiring,
//      purpose-bound token to be MAILED to the address already on the account (src/lib/auth/
//      recovery.ts). Knowing a birthday is not proof of identity; also holding the mailbox is the
//      second condition that makes a reset mean something.
//   3. Answers IDENTICALLY whether the account is unknown, has no DOB on file, or the DOB is wrong.
//      One message, one status code, one shape — no enumeration oracle.
//   4. Does not touch users.password_hash at all. Nothing here changes a credential; only
//      /reset-password does, and only against a token it burns first.
//
// The one honest exception to the uniform response is delivery: if the platform has no working mail
// transport the caller is told so plainly, because "check your inbox" for a mail that was never sent
// is the false-success shape this codebase keeps paying for. That branch reveals nothing about
// whether the account existed — it is reached only after a match, and it names an operational fault.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { overRecoveryLimit, clearRecoveryLimit, issueAndMailReset, RECOVERY_TTL_MINUTES, causeOf } from '@/lib/auth/recovery';

export const prerender = false;

// Declared before the handler that uses them — `const` is not hoisted.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

/** The SAME answer for unknown account, no DOB on file, and wrong DOB. */
const UNIFORM = 'If those details match an account, a one-time reset link is on its way to the email address on that account. It expires in ' + RECOVERY_TTL_MINUTES + ' minutes.';

function digitsOnly(s: string): string {
  return (s || '').toString().replace(/[^0-9]/g, '');
}

function toIsoDay(d: any): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  try { return new Date(d).toISOString().split('T')[0]; } catch { return null; }
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const emailOrName = (body?.emailOrName || '').toString().trim().toLowerCase();
  const dob = (body?.dob || '').toString().trim();
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  if (!emailOrName) return json({ ok: false, error: 'Email or name required' }, 400);
  if (!dob) return json({ ok: false, error: 'Date of birth required' }, 400);

  const dobDigits = digitsOnly(dob);
  if (dobDigits.length < 6 || dobDigits.length > 10) {
    return json({ ok: false, error: 'Invalid date of birth format' }, 400);
  }

  // Spend from the allowance BEFORE any lookup, so a sweep is throttled whether or not the account
  // it is guessing at exists.
  const limit = await overRecoveryLimit(emailOrName, ip, 'password-reset');
  if (limit.blocked) {
    return json({
      ok: false,
      error: 'Too many recovery attempts. Wait an hour and try again, or email hr@edurankai.in to recover manually.',
    }, 429);
  }

  try {
    const u = await db.execute(sql`
      SELECT id, email, name, dob FROM users
      WHERE LOWER(email) = ${emailOrName} OR LOWER(name) = ${emailOrName}
      LIMIT 1
    `);
    const uRows = rowsOf(u);
    // Unknown account: the uniform answer, and nothing else happens.
    if (uRows.length === 0) return json({ ok: true, message: UNIFORM });
    const user = uRows[0] as any;

    // The DOB on file. users.dob first (written by identity setup), then the application, then the
    // HR record. Each fallback is guarded because the table may not exist on every environment.
    let foundDob: string | null = toIsoDay(user.dob);

    if (!foundDob) {
      try {
        const a = await db.execute(sql`SELECT dob FROM applications WHERE applicant_user_id = ${user.id} AND dob IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
        foundDob = toIsoDay(rowsOf(a)[0]?.dob);
      } catch (e: any) { console.error('[api/auth/forgot-password] applications lookup', causeOf(e)); }
    }

    if (!foundDob) {
      try {
        const e2 = await db.execute(sql`SELECT date_of_birth FROM hr_employees WHERE user_id = ${user.id} AND date_of_birth IS NOT NULL LIMIT 1`);
        foundDob = toIsoDay(rowsOf(e2)[0]?.date_of_birth);
      } catch (e: any) { console.error('[api/auth/forgot-password] hr_employees lookup', causeOf(e)); }
    }

    // No DOB on file, or it does not match: the SAME answer as an unknown account.
    if (!foundDob || digitsOnly(foundDob) !== dobDigits) {
      return json({ ok: true, message: UNIFORM });
    }

    // Matched. Nothing about the credential changes here — a link goes to the address on file.
    const outcome = await issueAndMailReset(user, { ip, method: 'dob' });

    if (outcome === 'no-address') {
      return json({
        ok: false,
        error: 'That account has no email address on file, so a reset link cannot be delivered. Email hr@edurankai.in to recover it manually.',
      }, 409);
    }
    if (outcome === 'no-transport') {
      // Honest, and it names an operational fault rather than the account.
      return json({
        ok: false,
        error: 'We could not send the reset email just now. Nothing has changed on your account. Try again shortly, or email hr@edurankai.in.',
      }, 503);
    }

    await clearRecoveryLimit(emailOrName, ip, 'password-reset');
    return json({ ok: true, message: UNIFORM });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL. Logged here and NOT
    // returned — an error string from an auth path is free reconnaissance.
    console.error('[api/auth/forgot-password]', causeOf(e));
    return json({ ok: false, error: 'We could not process that request. Try again shortly.' }, 500);
  }
};
