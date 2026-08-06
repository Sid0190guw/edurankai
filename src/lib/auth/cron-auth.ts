// src/lib/auth/cron-auth.ts — THE ONE ANSWER TO "did this job endpoint really come from the cron?"
//
// WHY THIS EXISTS. The same rule was written six different ways across the job endpoints, and four of
// those spellings FAILED OPEN when CRON_SECRET was absent or empty:
//
//   src/pages/api/cron/activity-digest.ts   `if (!secret) return true`
//   src/pages/api/payments/reconcile.ts     `if (!secret) return true`
//   src/pages/api/cron/hei-refresh.ts       the whole check nested inside `if (secret) { ... }`
//   src/pages/api/cron/security-scan.ts     `if (secret && auth !== ...)` — short-circuits to false
//
// while two got it right (`if (!secret) return false` in aquintutor/league-settle.ts and
// streak-nudge.ts). Nothing else stands in front of these URLs: src/middleware.ts isExempt() returns
// true for everything under /api/, so the endpoint's own check IS the gate. One missing or
// whitespace-damaged environment variable therefore opened four job endpoints at once — one of which
// sends real mail, and one of which returns the security scan's findings to whoever asked.
//
// THIS HELPER FAILS CLOSED. No secret configured means no caller is authorised, including the cron
// itself. That is the deliberate direction: a job that does not run is visible (the digest is late,
// the reconcile is stale) and costs a redeploy; a job endpoint anyone may call is invisible and
// costs whatever the job can do. src/pages/admin/mail/health.astro already surfaces whether
// CRON_SECRET is present on the deployment, so the misconfiguration is diagnosable without reading
// .env (which nothing in this working copy may do).
//
// It accepts the three shapes the existing endpoints already accepted, so no scheduler entry has to
// change: `Authorization: Bearer <secret>` (what Vercel Cron sends), an `x-cron-secret` header, and
// a `?secret=` / `?key=` query parameter for manual runs.
import { timingSafeEqual } from 'node:crypto';

// Declared before every function that uses it — `const` is not hoisted.
const eq = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length is not secret here (the configured secret's length is fixed), and timingSafeEqual throws
  // on a mismatch, so it is compared first.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

export type CronAuthReason = 'ok' | 'not-configured' | 'bad-secret';

export interface CronAuth {
  /** The only field that may be used to decide. */
  allowed: boolean;
  reason: CronAuthReason;
}

/**
 * Is CRON_SECRET set to a usable value? Trimmed on purpose: a trailing newline pasted into the
 * Vercel dashboard has broken this project's deploys before, and a secret of pure whitespace must
 * count as absent rather than as a secret nobody can send.
 */
export function cronSecretConfigured(): boolean {
  const raw = process.env.CRON_SECRET ?? (import.meta as any)?.env?.CRON_SECRET;
  return !!String(raw || '').trim();
}

/**
 * Authorise a scheduled-job request.
 *
 *   const gate = cronAuth(request, url);
 *   if (!gate.allowed) return json({ ok: false, error: 'unauthorized' }, 401);
 *
 * Never returns allowed:true because no secret was configured.
 */
export function cronAuth(request: Request, url?: URL): CronAuth {
  const raw = process.env.CRON_SECRET ?? (import.meta as any)?.env?.CRON_SECRET;
  const secret = String(raw || '').trim();
  if (!secret) {
    // Logged, because the alternative — a job that quietly stops running — is the failure mode this
    // direction trades for, and it should be findable in the function logs.
    console.error('[cron-auth] CRON_SECRET is not set on this deployment; refusing the job request.');
    return { allowed: false, reason: 'not-configured' };
  }

  const authHeader = String(request.headers.get('authorization') || '').trim();
  if (eq(authHeader, 'Bearer ' + secret) || eq(authHeader, secret)) return { allowed: true, reason: 'ok' };

  const xHeader = String(request.headers.get('x-cron-secret') || '').trim();
  if (eq(xHeader, secret)) return { allowed: true, reason: 'ok' };

  if (url) {
    const q = String(url.searchParams.get('secret') || url.searchParams.get('key') || '').trim();
    if (eq(q, secret)) return { allowed: true, reason: 'ok' };
  }

  return { allowed: false, reason: 'bad-secret' };
}

/** Convenience for the many endpoints whose only question is yes/no. */
export function isCronAuthorized(request: Request, url?: URL): boolean {
  return cronAuth(request, url).allowed;
}
