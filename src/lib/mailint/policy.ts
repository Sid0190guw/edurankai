// src/lib/mailint/policy.ts — TENANCY, CREDENTIAL LIFETIME AND STEP RETRY. Pure; no database.
//
// SHORT ON PURPOSE. Three things this integration layer needs that the transactional API layer does
// not already provide are here; everything it DOES provide is imported rather than re-decided:
//
//   webhook backoff, response classification, private-IP checks, rate limiting, API-key auth
//        -> src/lib/mailapi/webhooks.ts and src/lib/mailapi/ratelimit.ts, already shipped and tested
//
// A second implementation of a retry curve is not resilience, it is two answers to the same
// question — and the one that gets fixed is never the one that is running.

import { webhookBackoffMs } from '@/lib/mailapi/webhooks';

// ---------------------------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------------------------

/**
 * The one place that answers "may this principal touch this row?".
 *
 * Written as a function rather than repeated as `if (row.org_id !== principal.orgId)` because the
 * repeated form is the one that gets forgotten on the ninth endpoint. Every mailint read that loads
 * a row BY ID calls it.
 *
 * NOT FOUND, NOT FORBIDDEN, is the correct answer to a cross-tenant reference: telling a caller
 * "that integration exists but is not yours" confirms another organisation's resource to somebody
 * who guessed an id.
 */
export function sameTenant(rowOrgId: string | null | undefined, principalOrgId: string | null | undefined): boolean {
  if (!rowOrgId || !principalOrgId) return false;
  return String(rowOrgId) === String(principalOrgId);
}

/** Environment isolation. A development key must not see, change or trigger a production resource. */
export function sameEnvironment(rowEnv: string | null | undefined, principalEnv: string | null | undefined): boolean {
  if (!rowEnv || !principalEnv) return false;
  return String(rowEnv) === String(principalEnv);
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export type CredentialState = 'active' | 'expiring' | 'expired' | 'revoked';

/** Days before expiry at which a credential starts warning rather than silently working. */
export const CREDENTIAL_WARN_DAYS = 7;

/**
 * The state of a stored credential.
 *
 * `expiring` exists because the alternative is discovering that an OAuth token expired by watching
 * an integration go dark. This platform has already written that trap down once, in
 * docs/live-streaming: a refresh token unused for seven days can be revoked by the issuer with no
 * notice, and nothing tells you until the next call fails.
 */
export function credentialState(
  cred: { expiresAt?: string | Date | null; revokedAt?: string | Date | null },
  now: number = Date.now(),
): CredentialState {
  if (cred.revokedAt) return 'revoked';
  if (!cred.expiresAt) return 'active';
  const t = cred.expiresAt instanceof Date ? cred.expiresAt.getTime() : Date.parse(String(cred.expiresAt));
  if (!Number.isFinite(t)) return 'active';
  if (t <= now) return 'expired';
  if (t - now <= CREDENTIAL_WARN_DAYS * 24 * 3600 * 1000) return 'expiring';
  return 'active';
}

// ---------------------------------------------------------------------------------------------
// Scheduled step retry
// ---------------------------------------------------------------------------------------------

export type StepOutcome = 'sent' | 'retry' | 'dead_letter';

/**
 * What to do with a delayed workflow step that did not send.
 *
 * The curve is the WEBHOOK curve, deliberately — imported, not re-tuned. A delayed step and a
 * webhook delivery are both "somebody else's system is not answering right now", and two different
 * schedules in one product means two different sets of expectations to hold in your head at 2am.
 */
export function stepOutcome(attempts: number, maxAttempts: number): { outcome: StepOutcome; retryInMs: number } {
  if (attempts >= maxAttempts) return { outcome: 'dead_letter', retryInMs: 0 };
  return { outcome: 'retry', retryInMs: webhookBackoffMs(attempts) };
}

export { webhookBackoffMs };
