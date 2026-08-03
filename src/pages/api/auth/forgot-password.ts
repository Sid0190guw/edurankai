// POST /api/auth/forgot-password
// Body: { emailOrName: string, dob: string }
//
// Verifies a date of birth against the account (users.dob, else the most recent applications.dob,
// else hr_employees.date_of_birth) and — on a match — EMAILS A SINGLE-USE RESET LINK to the address
// on the account. It does not change the password and it never returns a secret.
//
// WHAT THIS USED TO DO, AND WHY IT CHANGED.
// This endpoint used to generate a password, write it to users.password_hash, set is_active = true
// and return the cleartext password in the JSON body. It is reachable with NO SESSION: src/middleware.ts
// exempts all of /api/ from the session and face gates (isExempt, line 117) and this route reads
// nothing from locals. So the whole cost of taking over any account — including a super_admin, whose
// role was selected here and then never consulted — was one date of birth. The comparison is
// digits-only over an 8-digit YYYYMMDD space, about 18,000 candidates for a 50-year range, and the
// only throttle was `await new Promise(r => setTimeout(r, 600))`, which is per-request with no shared
// state and therefore costs a concurrent script nothing.
//
// Six things changed, and only these:
//   1. PRIVILEGED ACCOUNTS ARE REFUSED, AND A HUMAN IS TOLD. A date of birth is a fair bar for an
//      applicant's own record; it is not a fair bar for the console that opens every employee record
//      and the legal-hold register. Staff recover by an admin-issued reset — already the pattern
//      here. The refusal is silent to the caller and loud to the alert mailbox
//      (alertAdminOfPrivilegedAttempt).
//   2. THE SECRET IS NO LONGER RETURNED. A match mails a single-use, 30-minute link to the address on
//      file, so defeating the date-of-birth check no longer hands anyone the account. If mail cannot
//      be sent this FAILS CLOSED and says so; it never falls back to disclosing a password.
//   3. `is_active = true` IS GONE. Reviving a deliberately offboarded account is a separate,
//      deliberate act, not a side effect of forgetting a password.
//   4. ONE ANSWER FOR EVERY OUTCOME, plus a shared-state attempt counter. The three previously
//      distinguishable 404s ("no account", "no date of birth on file", "wrong date of birth") were an
//      enumeration oracle; they are now one message, one status.
//   5. THE FORM IS CSRF-PROTECTED (verifyRecoveryCsrf — origin plus a double-submit token), so a page
//      the account holder never opened cannot spend their recovery budget or send mail in their name.
//   6. THE MAIL TRANSPORT IS CHECKED BEFORE THE ACCOUNT IS LOOKED UP. That is a privacy control, not
//      only an availability one: checked afterwards, a mail outage would answer "your date of birth
//      matched" and "it did not" with different statuses and hand back the oracle item 4 removes.
//
// Rate limiting, the audit trail and the token live in src/lib/auth/recovery.ts.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  CSRF_REJECTED_MESSAGE,
  GENERIC_RECOVERY_MESSAGE,
  RECOVERY_UNAVAILABLE_MESSAGE,
  alertAdminOfPrivilegedAttempt,
  checkRateLimit,
  clientIpOf,
  isPrivilegedAccount,
  issueResetToken,
  recordAttempt,
  recoveryMailReady,
  sendResetLink,
  verifyRecoveryCsrf,
} from '@/lib/auth/recovery';

// postgres-js resolves to a plain array, never a { rows } object.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

const ROUTE = 'dob_reset' as const;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

function digitsOnly(s: string): string {
  return (s || '').replace(/[^0-9]/g, '');
}

/** The single non-committal answer. Identical for every outcome, so nothing is confirmed or denied. */
function genericAnswer() {
  return json({ ok: true, sent: true, generic: true, message: GENERIC_RECOVERY_MESSAGE });
}

export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const emailOrName = (body?.emailOrName || '').toString().trim().toLowerCase();
  const dob = (body?.dob || '').toString().trim();
  const ip = clientIpOf(request, clientAddress);

  // CSRF. A page a victim never opened must not be able to spend their recovery budget or trigger
  // mail in their name. Checked before anything reads the database.
  const csrf = verifyRecoveryCsrf(request, cookies);
  if (!csrf.ok) {
    await recordAttempt({ route: ROUTE, identifier: emailOrName || 'unknown', ip, outcome: 'csrf_rejected', detail: csrf.reason });
    return json({ ok: false, error: CSRF_REJECTED_MESSAGE }, 403);
  }

  // Request-shape errors stay distinguishable: they say nothing about which accounts exist.
  if (!emailOrName) return json({ ok: false, error: 'Email or name required' }, 400);
  if (!dob) return json({ ok: false, error: 'Date of birth required' }, 400);

  const dobDigits = digitsOnly(dob);
  if (dobDigits.length < 6 || dobDigits.length > 10) {
    return json({ ok: false, error: 'Invalid date of birth format' }, 400);
  }

  // Is there anywhere for a link to go? Asked BEFORE the account is looked up, so a mail outage
  // answers everyone the same way instead of failing differently for the caller whose date of birth
  // happened to be right. Nothing is disclosed and nothing is changed.
  const mailReady = await recoveryMailReady();
  if (!mailReady.ready) {
    await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, outcome: 'no_transport', detail: mailReady.detail });
    console.error('[forgot-password] refusing: no mail transport configured -', mailReady.detail);
    return json({ ok: false, error: RECOVERY_UNAVAILABLE_MESSAGE }, 503);
  }

  // Shared-state ceiling, counted in Postgres. The per-identifier cap is the tight one; the per-IP cap
  // is loose so a shared office address does not lock out a floor. See src/lib/auth/recovery.ts.
  const limit = await checkRateLimit(ROUTE, emailOrName, ip);
  if (!limit.allowed) {
    await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, outcome: 'rate_limited', detail: limit.scope });
    return json({
      ok: false,
      error: 'Too many recovery attempts. Wait ' + Math.ceil(limit.retryAfterSeconds / 60) +
        ' minutes and try again, or email hr@edurankai.in to recover manually.',
    }, 429);
  }

  try {
    // Only columns guaranteed by src/lib/db/schema.ts. users.dob is read separately BECAUSE IT IS NOT
    // IN THE SCHEMA FILE: identity-setup.ts writes it, but if the column is absent on a deployment,
    // naming it here would throw and 500 every request — the shape of failure that took /admin down
    // when admin-access.ts named a column production did not have.
    const u = await db.execute(sql`
      SELECT id, email, name, role, is_active, assigned_department_id FROM users
      WHERE LOWER(email) = ${emailOrName} OR LOWER(name) = ${emailOrName}
      LIMIT 1
    `);
    const uRows = rows(u);
    if (uRows.length === 0) {
      await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, outcome: 'no_account' });
      return genericAnswer();
    }
    const user = uRows[0] as any;

    // A deactivated account is not revived by a password reset, and is not told apart from a missing
    // one either. Reactivation is an admin action.
    if (user.is_active === false) {
      await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, userId: user.id, outcome: 'inactive' });
      return genericAnswer();
    }

    // Privileged accounts never self-serve. Same answer as every other refusal, so the endpoint does
    // not become a way to discover which addresses belong to administrators.
    const privileged = await isPrivilegedAccount({
      id: user.id, email: user.email, name: user.name, role: user.role,
      isActive: user.is_active, assignedDepartmentId: user.assigned_department_id,
    });
    if (privileged) {
      await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, userId: user.id, outcome: 'privileged_refused' });
      // The caller is told nothing; a human is told everything. Never throws, and is awaited so the
      // alert is not lost when a serverless invocation is frozen the moment the response is written.
      await alertAdminOfPrivilegedAttempt({
        route: ROUTE, identifier: emailOrName, ip, userId: user.id, accountEmail: user.email,
      });
      return genericAnswer();
    }

    // 1) Prefer users.dob (written by /identity-setup).
    let foundDob: string | null = null;
    try {
      const d0 = await db.execute(sql`SELECT dob FROM users WHERE id = ${user.id} LIMIT 1`);
      const d0Rows = rows(d0);
      const v = d0Rows.length > 0 ? (d0Rows[0] as any).dob : null;
      if (v) foundDob = typeof v === 'string' ? v.substring(0, 10) : new Date(v).toISOString().split('T')[0];
    } catch (e: any) {
      // A missing column is a schema gap, not a caller error: log it and fall through to the other
      // two sources rather than failing the whole flow.
      console.error('[forgot-password] users.dob read', causeOf(e));
    }

    // 2) Fall back to applications.dob
    if (!foundDob) {
      try {
        const a = await db.execute(sql`SELECT dob FROM applications WHERE applicant_user_id = ${user.id} AND dob IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
        const aRows = rows(a);
        if (aRows.length > 0) {
          const d = (aRows[0] as any).dob;
          foundDob = typeof d === 'string' ? d.substring(0, 10) : new Date(d).toISOString().split('T')[0];
        }
      } catch (e: any) { console.error('[forgot-password] applications.dob read', causeOf(e)); }
    }

    // 3) Fall back to hr_employees.date_of_birth (linked by user_id)
    if (!foundDob) {
      try {
        const e2 = await db.execute(sql`SELECT date_of_birth FROM hr_employees WHERE user_id = ${user.id} AND date_of_birth IS NOT NULL LIMIT 1`);
        const eRows = rows(e2);
        if (eRows.length > 0) {
          const d = (eRows[0] as any).date_of_birth;
          foundDob = d ? new Date(d).toISOString().split('T')[0] : null;
        }
      } catch (e: any) { console.error('[forgot-password] hr_employees.date_of_birth read', causeOf(e)); }
    }

    if (!foundDob || digitsOnly(foundDob) !== dobDigits) {
      await recordAttempt({
        route: ROUTE, identifier: emailOrName, ip, userId: user.id,
        outcome: foundDob ? 'dob_mismatch' : 'no_dob_on_file',
      });
      return genericAnswer();
    }

    const to = String(user.email || '').trim();
    if (!to) {
      await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, userId: user.id, outcome: 'no_email_on_account' });
      return genericAnswer();
    }

    // Matched. Issue the token FIRST — if it cannot be stored we must not send a link that can never
    // be revoked or expired, so this deliberately throws into the handler's catch.
    const issued = await issueResetToken(user.id, ROUTE, ip, emailOrName);
    const mail = await sendResetLink(to, String(user.name || ''), issued.token);
    if (!mail.ok) {
      // FAIL CLOSED and say so. The old fallback — return the password in the body — is the disclosure
      // this endpoint exists to stop, and "the mail server is down" is not a reason to reinstate it.
      await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, userId: user.id, outcome: 'mail_failed', detail: mail.error });
      console.error('[forgot-password] reset mail not sent:', mail.error);
      return json({
        ok: false,
        error: 'We verified your details but could not send the reset email right now. Email hr@edurankai.in and we will reset it manually.',
      }, 502);
    }

    await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, userId: user.id, outcome: 'link_sent' });
    return genericAnswer();
  } catch (e: any) {
    // Never swallowed: the real Postgres reason reaches the log, and the caller gets a plain failure
    // rather than a silent success.
    console.error('[forgot-password] failed:', causeOf(e));
    await recordAttempt({ route: ROUTE, identifier: emailOrName, ip, outcome: 'error', detail: causeOf(e) }).catch(() => {});
    return json({ ok: false, error: 'We could not process that request. Try again, or email hr@edurankai.in.' }, 500);
  }
};
