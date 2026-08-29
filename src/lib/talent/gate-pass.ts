// src/lib/talent/gate-pass.ts — THE GATE PASS, and nothing that touches a database.
//
// WHY THIS IS A SEPARATE MODULE FROM gateway.ts.
// src/middleware.ts is what makes the gate unbypassable, so it has to be able to verify a pass. But
// middleware runs on EVERY request on this deployment, and gateway.ts reaches the tal_* tables,
// which pulls src/lib/db — postgres-js and the whole Drizzle schema — into the middleware bundle.
// The middleware file already carries a comment about exactly this trap for the AquinTutor landing
// table. So the pass primitives live here, import nothing but node:crypto, and gateway.ts re-exports
// them for callers that want one import.
//
// WHAT A PASS IS. A short-lived HMAC-signed statement that this browser reached the apply flow
// through the front door, at this time, on this basis. It is NOT an authorization to be hired and it
// grants nothing on its own: every later step still re-checks its own preconditions server-side.
//
// It is STATELESS on purpose. The gate has to stay up and fast when the talent tables are mid-
// migration, and a gate that needs a database write per visitor is a gate that falls over the first
// time a campaign sends real traffic at it.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GATE_COOKIE = 'era_gate';
/** Long enough to finish a multi-step application, short enough that a shared machine forgets. */
export const GATE_TTL_MINUTES = 45;

export type GateDoor = 'code' | 'open';

export interface GatePass {
  /** Which door was taken. */
  door: GateDoor;
  /** Normalised email the gate was passed with. */
  email: string;
  /** Present only on the 'code' door. */
  codeId?: string;
  selectionId?: string;
  opportunityId?: string;
  personId?: string;
  /** The signed-in user, when the applicant was internal. */
  userId?: string;
  /**
   * Present when the pass was earned by an INVITATION to apply (ERA-INV) rather than by declaring
   * "I have no code". Both are the 'open' door and both grant exactly the same thing - an ordinary
   * application - so this is provenance, never permission. It is what lets the flow put the person
   * on the posting they were invited to, and lets the application close the invitation's loop.
   */
  invitationId?: string;
  /** The posting the invitation named, so the role survives the walk to /apply. */
  roleSlug?: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * The signing key.
 *
 * NO FALLBACK, DELIBERATELY. A gate that quietly signs with a default when the secret is missing is
 * a gate anybody can forge a pass for, and it would fail OPEN in precisely the environment where
 * configuration had already gone wrong. Callers get null and must refuse — see gateUnavailable().
 */
function signingKey(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && String(s).length >= 16 ? String(s) : null;
}

export function gateUnavailable(): boolean {
  return signingKey() === null;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signGatePass(pass: GatePass): string | null {
  const key = signingKey();
  if (!key) return null;
  const body = b64url(Buffer.from(JSON.stringify(pass), 'utf8'));
  const mac = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify and decode. Returns null for a forged, tampered, malformed or EXPIRED pass — the caller
 * cannot tell those apart and does not need to: all four mean "go back to the gate".
 *
 * The MAC is compared with timingSafeEqual. A byte-by-byte early return here is a real oracle: an
 * attacker with a chosen body can walk a signature one character at a time.
 */
export function verifyGatePass(token: string | null | undefined, now: Date = new Date()): GatePass | null {
  const key = signingKey();
  if (!key || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = createHmac('sha256', key).update(body).digest();
  let given: Buffer;
  try { given = unb64url(mac); } catch { return null; }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  let parsed: GatePass;
  try { parsed = JSON.parse(unb64url(body).toString('utf8')); } catch { return null; }
  if (!parsed || (parsed.door !== 'code' && parsed.door !== 'open')) return null;
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now.getTime()) return null;
  return parsed;
}

export function issuePass(args: {
  door: GateDoor; email: string; userId?: string | null;
  codeId?: string; selectionId?: string; opportunityId?: string; personId?: string;
  invitationId?: string | null; roleSlug?: string | null;
  now?: Date;
}): { token: string | null; pass: GatePass } {
  const now = args.now || new Date();
  const pass: GatePass = {
    door: args.door,
    email: String(args.email || '').trim().toLowerCase(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + GATE_TTL_MINUTES * 60 * 1000,
  };
  if (args.userId) pass.userId = args.userId;
  // Carried on the OPEN door too, because that is the door an invitation opens. Neither field is
  // read as an authorization anywhere - see the note on GatePass.invitationId.
  if (args.invitationId) pass.invitationId = String(args.invitationId);
  if (args.roleSlug) pass.roleSlug = String(args.roleSlug);
  if (args.door === 'code') {
    pass.codeId = args.codeId;
    pass.selectionId = args.selectionId;
    pass.opportunityId = args.opportunityId;
    pass.personId = args.personId;
  }
  return { token: signGatePass(pass), pass };
}

/** httpOnly so script cannot read it; SameSite=Lax so a cross-site POST cannot spend it. */
export function gateCookieHeader(token: string, secure: boolean): string {
  const bits = [`${GATE_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${GATE_TTL_MINUTES * 60}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
export function clearGateCookieHeader(secure: boolean): string {
  const bits = [`${GATE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/**
 * THE SERVER-SIDE CHECK EVERY APPLICATION WRITE MUST CALL.
 *
 * Middleware redirects a browser without a pass back to the gate, but middleware only sees PAGE
 * requests, and `/api/*` is not behind the admin gate in this codebase. An application can be
 * created by a direct POST, so the endpoint that creates one calls THIS, and a missing pass is a
 * refusal rather than a redirect.
 */
export function requireGatePass(cookieValue: string | null | undefined, now: Date = new Date()):
  { ok: boolean; pass?: GatePass; error?: string } {
  if (gateUnavailable()) {
    return { ok: false, error: 'The application gate is not configured on this environment, so no application can be accepted right now.' };
  }
  const pass = verifyGatePass(cookieValue, now);
  if (!pass) {
    return { ok: false, error: 'Start at the application gate. Your gate pass is missing or has expired.' };
  }
  return { ok: true, pass };
}

// ---------------------------------------------------------------------------------------------
// WHAT THE GATE COVERS
// ---------------------------------------------------------------------------------------------

/** The gate screen itself, and the two destinations a pass sends people to. */
export const GATE_PATH = '/apply/gateway';

/**
 * Paths that require a pass.
 *
 * A PREFIX LIST, MATCHED ON THE NORMALISED PATH. `//apply/step-1` is the same resource to a router
 * and a different string to startsWith(), and "the guard did not recognise the path" is exactly how
 * a deny-by-default gate turns back into allow-by-default. src/middleware.ts normalises once at the
 * top and passes that value in.
 */
const GATED_PREFIXES = ['/apply', '/onboarding'] as const;

/**
 * Paths inside those prefixes that must stay open, matched EXACTLY and never by prefix.
 *
 * The gate screen itself, obviously. `/apply/waiver` and `/apply/pay` are NOT exempt: they are
 * inside the flow and a pass is required to have reached them.
 */
const GATE_EXEMPT_EXACT = new Set<string>([
  GATE_PATH,
  // The confirmation page is reached AFTER an application is submitted, at which point the pass has
  // usually expired or been spent. Refusing it there would bounce somebody who has already finished
  // back to the front door with nothing to do, which reads as data loss.
  '/apply/confirmation',
  // The same argument, and sharper. An onboarding code is SINGLE USE and is spent at submit, so
  // bouncing somebody off the confirmation screen would send them to a gate their code can no longer
  // open — a dead end with no way out but a support call. The page carries no data of its own.
  '/onboarding/submitted',
]);

export function isGatedApplyPath(normalisedPath: string): boolean {
  const p = String(normalisedPath || '');
  if (GATE_EXEMPT_EXACT.has(p)) return false;
  return GATED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

/**
 * The one decision middleware makes about the apply flow.
 *
 * Returns a redirect Response when the request must go back to the gate, or null to carry on. The
 * `next` parameter is deliberately NOT threaded through: after passing the gate a person is sent to
 * the door their pass actually opens, and honouring an arbitrary `next` would let a crafted link
 * push somebody straight to a step the gate did not authorise.
 */
export function applyGateRedirect(normalisedPath: string, cookieValue: string | null | undefined): Response | null {
  if (!isGatedApplyPath(normalisedPath)) return null;

  // A misconfigured gate refuses rather than admits. Sending everyone to the gate screen — which
  // renders its own "not available" state — is the honest failure: nobody gets in, and the reason
  // is on the screen instead of in a log nobody reads.
  if (gateUnavailable()) {
    return new Response(null, { status: 302, headers: { Location: GATE_PATH, 'cache-control': 'no-store' } });
  }

  const pass = verifyGatePass(cookieValue);
  if (!pass) {
    return new Response(null, { status: 302, headers: { Location: GATE_PATH, 'cache-control': 'no-store' } });
  }

  // THE TWO DOORS DO NOT OPEN ONTO EACH OTHER.
  // A pass earned by declaring "no code" must not reach onboarding — that would be direct onboarding
  // with no selection behind it, which is the single worst outcome this whole gate exists to prevent.
  // And a pass earned WITH a code must not wander into the ordinary application flow, because that
  // is how one hire ends up with both a selection and a contradictory application.
  const wantsOnboarding = normalisedPath === '/onboarding' || normalisedPath.startsWith('/onboarding/');
  if (wantsOnboarding && pass.door !== 'code') {
    return new Response(null, { status: 302, headers: { Location: GATE_PATH, 'cache-control': 'no-store' } });
  }
  if (!wantsOnboarding && pass.door !== 'open') {
    return new Response(null, { status: 302, headers: { Location: '/onboarding', 'cache-control': 'no-store' } });
  }

  return null;
}
