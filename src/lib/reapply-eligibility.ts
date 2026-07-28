// src/lib/reapply-eligibility.ts — one place that decides whether a person may apply to a role.
//
// Two rules, enforced together:
//   1. NO ACTIVE DUPLICATE — a person may hold at most one live application per role. (This is the
//      "Prajna Saha applied twice / SUBMITTED + INTERVIEW" bug: there was no such rule, only a
//      racy app-level look-then-insert.)
//   2. 6-MONTH COOLING — after an application to a role ends (withdrawn / rejected — a declined
//      offer sets the linked application to 'rejected', not a separate 'declined' status; that
//      value only exists on offer_letters.status, never on applications.status),
//      the person cannot re-apply to the SAME role for 6 months.
//
// Matching is deliberately broad — by (user id OR email) AND (role id OR role title snapshot) — so
// it also catches guests, and the case where the same job exists as two different role rows.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export const COOLING_DAYS = 180; // 6 months

// An application is "finished" (eligible to start the cooling clock) in these states.
// NOTE: applications.status is a Postgres ENUM that does NOT include 'declined' — a declined offer
// sets the linked application's status to 'rejected' instead (see offer/[token].astro). Never add
// 'declined' here or to any raw-SQL comparison against applications.status; it doesn't exist as a
// value and Postgres will reject it outright ("invalid input value for enum application_status").
const ENDED = ['withdrawn', 'rejected'];

export interface Eligibility {
  allowed: boolean;
  reason?: string;        // human message, safe to show the applicant
  retryAfter?: string;    // ISO date they may re-apply (cooling case)
  existingId?: string;    // the application that blocks them
  kind?: 'active_duplicate' | 'cooling';
}

/** Decide if this person may (re)apply to this role right now. */
export async function checkReapply(opts: {
  userId?: string | null; email?: string | null; roleId?: string | null; roleTitle?: string | null;
}): Promise<Eligibility> {
  const uid = opts.userId || null;
  const email = String(opts.email || '').trim().toLowerCase();
  const roleId = opts.roleId || null;
  const roleTitle = String(opts.roleTitle || '').trim();
  if ((!uid && !email) || (!roleId && !roleTitle)) return { allowed: true };

  let prior: any;
  try {
    prior = rows(await db.execute(sql`
      SELECT id, status, created_at, updated_at
      FROM applications
      WHERE (
              (${uid}::uuid IS NOT NULL AND applicant_user_id = ${uid})
           OR (${email} <> '' AND LOWER(email) = ${email})
            )
        AND (
              (${roleId}::uuid IS NOT NULL AND role_id = ${roleId})
           OR (${roleTitle} <> '' AND role_title_snapshot = ${roleTitle})
            )
      ORDER BY created_at DESC
      LIMIT 1
    `))[0];
  } catch { return { allowed: true }; }   // never block an applicant on a lookup error

  if (!prior) return { allowed: true };

  const status = String(prior.status || '');
  if (!ENDED.includes(status)) {
    return {
      allowed: false, kind: 'active_duplicate', existingId: String(prior.id),
      reason: 'You already have an application for this role. Track it in your portal — you do not need to apply again.',
    };
  }

  const endedAt = prior.updated_at ? new Date(prior.updated_at) : new Date(prior.created_at);
  const retry = new Date(endedAt.getTime() + COOLING_DAYS * 86400000);
  if (Date.now() < retry.getTime()) {
    const when = retry.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      allowed: false, kind: 'cooling', existingId: String(prior.id), retryAfter: retry.toISOString(),
      reason: `A 6-month cooling period applies before re-applying to the same role. You can apply again on ${when}.`,
    };
  }
  return { allowed: true };
}
