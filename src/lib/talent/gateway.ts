// src/lib/talent/gateway.ts — THE APPLICATION GATE.
//
// WHAT THIS IS, IN ONE SENTENCE
// ---------------------------------------------------------------------------------------------
// Nobody reaches an application form or an onboarding form — external candidate or serving employee,
// no exception — without first passing through this gate, and the gate is the only thing that
// decides which of the two doors they go through.
//
// WHY THE GATE EXISTS BEFORE THE REST OF THE BACKEND
// ---------------------------------------------------------------------------------------------
// The direct-onboarding shortcut and the ordinary application flow both end in a person joining the
// organisation. If the shortcut arrives LATER, beside an apply flow that is already open, then for
// the whole intervening period there are two unrelated ways in and nothing that can say which one a
// given joiner used. That is the chaos this file prevents: one entrance, recorded, decided
// server-side before any application exists.
//
// THE TWO DOORS
//   'code'  The person holds an onboarding code. It is redeemed here and they go to onboarding. They
//           do NOT fill in an application: the decision to take them on has already been made, and
//           re-collecting an application invites a second, contradictory record of one hire.
//   'open'  No code. They go to the ordinary application flow. This door is NOT a fallback from a
//           failed code — a code that fails returns to the gate. A candidate must actively declare
//           they have no code, so "my code did not work so I applied instead" cannot silently become
//           a duplicate.
//
// INTERNAL AND EXTERNAL APPLICANTS USE THE SAME GATE. An employee applying for an internal move is
// an applicant. A private entrance for serving staff is exactly how an internal hire ends up with no
// application record, no evaluation trail and no selection decision.
//
// ---------------------------------------------------------------------------------------------
// THIS FILE DECIDES WHICH DOOR. IT DOES NOT DECIDE WHETHER A CODE IS VALID.
// ---------------------------------------------------------------------------------------------
// An earlier pass had a decideGate() here that reimplemented the whole redemption ladder — its own
// outcome union, its own rejection sentence, its own expiry and exhaustion rules — beside the one in
// codes.ts. Two implementations of one security decision is the worst possible shape: they drift,
// and the one that happens to be imported is the one that decides. Redemption now lives ONLY in
// codes.ts (spec section 16), and this module calls it.
import { randomBytes } from 'node:crypto';
import {
  normaliseCode, formatProblem, decideRedeem, findByCode, selectionStateFor,
  recordAttempt, recentAttempts, rateLimitDecision, codePrefixOf,
  CODE_LIMITS, RATE_LIMITED_MESSAGE, UNIFORM_REJECTION,
  type OnboardingCode, type RedeemOutcome, type RedeemDecision,
} from './codes';
// The pass primitives live in a DB-FREE module so src/middleware.ts — which runs on every request on
// this deployment — can verify a pass without pulling postgres-js and the whole Drizzle schema into
// the middleware bundle. Re-exported at the foot so a caller wanting the whole gate has one import.
import {
  GATE_COOKIE, GATE_TTL_MINUTES, GATE_PATH, gateUnavailable, signGatePass, verifyGatePass,
  issuePass, gateCookieHeader, clearGateCookieHeader, requireGatePass, isGatedApplyPath,
  applyGateRedirect, type GatePass, type GateDoor,
} from './gate-pass';

/** What the gate hands back to its API route. */
export interface GateResult {
  ok: boolean;
  /** Safe to show the person at the gate. UNIFORM_REJECTION for every code refusal. */
  message: string;
  /** HTTP status the route should use. */
  status: number;
  /** The truth, for the audit log only. NEVER put this on the wire. */
  outcome: RedeemOutcome | 'malformed' | 'rate_limited' | 'ok';
  /** Present only on success. */
  code?: OnboardingCode;
  /** Seconds, when the limiter refused. */
  retryAfterSeconds?: number;
  /** Spec 16.5: a challenge is demanded before the hard limit, not instead of it. */
  captchaRequired?: boolean;
}

/**
 * REDEEM A CODE AT THE GATE.
 *
 * The whole order of operations lives here so the API route cannot get it wrong, and so it is
 * readable as one sequence:
 *
 *   1. rate limit, BEFORE any lookup, so a brute-force run never touches the code table;
 *   2. format check, from the input alone — no lookup, but still recorded, because a run of
 *      malformed entries from one address is what enumeration looks like before it is tuned;
 *   3. look the code up BY HASH;
 *   4. read the selection behind it, so a code cannot outlive its own decision;
 *   5. decide, in codes.ts;
 *   6. record the attempt on EVERY path, success included.
 *
 * The code is NOT consumed here. Passing the gate is not onboarding — the single use is spent when
 * the onboarding form is actually submitted, atomically. Burning it here would strand anybody who
 * closed the tab between the gate and the form.
 */
export async function redeemAtGate(args: {
  rawCode: string;
  claimedEmail: string;
  againstOpportunityId?: string | null;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
}): Promise<GateResult> {
  const now = args.now || new Date();

  // 1. RATE LIMIT FIRST.
  const attempts = await recentAttempts(args.ip);
  const limit = rateLimitDecision(attempts, now);
  if (limit.limited) {
    return {
      ok: false, status: 429, outcome: 'rate_limited', message: RATE_LIMITED_MESSAGE,
      retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000), captchaRequired: true,
    };
  }

  // 2. FORMAT. Decided from the input alone, so the sentence reveals nothing about our records.
  const body = normaliseCode(args.rawCode);
  if (!body) {
    await recordAttempt({ codeRowId: null, codePrefix: null, outcome: 'malformed', ip: args.ip, userAgent: args.userAgent });
    return {
      ok: false, status: 400, outcome: 'malformed',
      message: formatProblem(args.rawCode) || 'That does not look like an onboarding code.',
      captchaRequired: limit.captchaRequired,
    };
  }

  // 3. LOOKUP BY HASH. A lookup that cannot run is NOT a pass: fail closed, and say nothing about
  //    whether the code exists.
  let code: OnboardingCode | null = null;
  try {
    code = await findByCode(body);
  } catch {
    return {
      ok: false, status: 503, outcome: 'unknown',
      message: 'We could not check that code right now. Please try again shortly.',
    };
  }

  // 4. THE SELECTION BEHIND IT.
  let selectionApproved: boolean | undefined;
  let selectionWithdrawn = false;
  if (code) {
    const state = await selectionStateFor(code.selectionId);
    // An unreadable selection is treated as NOT approved. A code whose decision cannot be confirmed
    // must not open the door on the strength of the code alone.
    selectionApproved = state ? state.approved : false;
    selectionWithdrawn = state ? state.withdrawn : false;
  }

  // 5. DECIDE — in codes.ts, the single implementation.
  const decision: RedeemDecision = decideRedeem(code, {
    now,
    claimedEmail: args.claimedEmail,
    againstOpportunityId: args.againstOpportunityId || null,
    selectionApproved,
    selectionWithdrawn,
  });

  // 6. RECORD, on every path.
  await recordAttempt({
    codeRowId: code ? code.id : null,
    codePrefix: code ? code.codePrefix : codePrefixOf(body),
    outcome: decision.outcome,
    ip: args.ip,
    userAgent: args.userAgent,
  });

  if (!decision.ok || !code) {
    // ONE STATUS FOR EVERY REFUSAL, exactly as there is one message. Returning 404 for "no such
    // code" and 409 for "someone else's code" would rebuild the oracle that UNIFORM_REJECTION
    // exists to remove — the status line is as readable to a script as the body is.
    return { ok: false, status: 401, outcome: decision.outcome, message: UNIFORM_REJECTION, captchaRequired: limit.captchaRequired };
  }

  return { ok: true, status: 200, outcome: 'ok', message: 'Code accepted.', code };
}

/** A per-request nonce for the gate form. Not a CSRF store — the pass cookie is SameSite=Lax. */
export function formNonce(): string {
  return randomBytes(9).toString('hex');
}

// One import for the whole gate. src/middleware.ts is the deliberate exception: it imports from
// './gate-pass' directly, because importing THIS module would drag the database driver into a bundle
// that runs on every request.
export {
  GATE_COOKIE, GATE_TTL_MINUTES, GATE_PATH, gateUnavailable, signGatePass, verifyGatePass,
  issuePass, gateCookieHeader, clearGateCookieHeader, requireGatePass, isGatedApplyPath,
  applyGateRedirect, CODE_LIMITS, UNIFORM_REJECTION, RATE_LIMITED_MESSAGE,
};
export type { GatePass, GateDoor, OnboardingCode, RedeemOutcome };
