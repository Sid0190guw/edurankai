// src/lib/auth/two-factor.ts — OPT-IN second-step enforcement.
//
// The platform model is unchanged: any ONE of password / passkey / face / TOTP
// signs you in. This module adds a PER-ACCOUNT opt-in on top of that. When an
// account turns it on, the first factor alone no longer issues a session — the
// sign-in stops at a short-lived pending challenge and only a second factor
// releases it.
//
// It deliberately does NOT re-implement TOTP or recovery codes: those already
// live in ./twofactor.ts (RFC 6238 + hashed one-time codes) and are re-exported
// here so callers have a single import.
//
// Three things this module exists to get right:
//   1. The pending state is a random server-side token, NOT a user id in a
//      cookie. A client-settable `pending=<uuid>` cookie is a first-factor
//      bypass; see the report. Tokens are hashed at rest, expire in 5 minutes,
//      and are consumed atomically so a replay cannot mint a second session.
//   2. Attempt limiting lives in Postgres. On serverless there is no memory
//      between invocations, so a per-request sleep or an in-process Map limits
//      nothing.
//   3. Enabling enforcement REQUIRES recovery codes. Two lockout outages have
//      already shipped on this project.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ddlPermitted } from '@/lib/schema-bootstrap';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ensureTwoFactorSchema, isTotpEnabled, verifyLoginCode,
  generateBackupCodes, storeBackupCodes, countUnusedBackupCodes,
} from '@/lib/auth/twofactor';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

// Re-exported so a caller needs one import, not two.
export { isTotpEnabled, verifyLoginCode, generateBackupCodes, countUnusedBackupCodes };

/** How long a half-finished sign-in may sit before it must be restarted. */
export const PENDING_TTL_SECONDS = 300;
/** Attempts allowed against one pending challenge before it is burned. */
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** Face distance below which a live capture counts as the same person. */
export const FACE_MATCH_THRESHOLD = 0.6;

export type SecondFactorMethod = 'totp' | 'face';
export type SignInSurface = 'admin' | 'portal' | 'aquintutor' | 'hei';

// ── schema bootstrap ────────────────────────────────────────────────────────
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
export async function ensureSecondStepSchema(): Promise<void> {
  if (ensured) return;
  await ensureTwoFactorSchema();
  // Per-account opt-in. Absent row = not enforced, which keeps every existing
  // account on the unchanged any-one-method model.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS user_2fa_policy (
    user_id uuid PRIMARY KEY,
    required boolean NOT NULL DEFAULT false,
    enabled_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Half-finished sign-ins. The raw token never touches the database.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS auth_pending_2fa (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL,
    surface text NOT NULL,
    first_factor text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_pending_2fa_expiry_idx ON auth_pending_2fa(expires_at)`);
  // Shared, cross-invocation attempt counters.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS auth_attempt_limit (
    bucket text NOT NULL,
    window_start timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
  )`);
  // Only a run that was PERMITTED to create anything may record that it did.
  if (ddlPermitted()) ensured = true;
}

// ── shared attempt limiter (Postgres, not per-request state) ────────────────
/**
 * Count one attempt against `bucket` in a fixed window and return the running
 * total. Atomic, so two concurrent lambdas cannot both see "1".
 *
 * This is the project's ONLY second-factor limiter. The brief pointed at
 * src/lib/auth/recovery.ts to reuse — that file does not exist on this branch
 * (see report), so this is the single implementation, not a competing second.
 */
export async function countAttempt(bucket: string, windowSeconds = 900): Promise<number> {
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`
    INSERT INTO auth_attempt_limit (bucket, window_start, attempts)
    VALUES (
      ${bucket},
      to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}),
      1
    )
    ON CONFLICT (bucket, window_start)
      DO UPDATE SET attempts = auth_attempt_limit.attempts + 1
    RETURNING attempts
  `));
  return Number(rows[0]?.attempts || 1);
}

/** Read the running total for `bucket` without adding to it. */
export async function peekAttempts(bucket: string, windowSeconds = 900): Promise<number> {
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`
    SELECT attempts FROM auth_attempt_limit
    WHERE bucket = ${bucket}
      AND window_start = to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})
    LIMIT 1
  `));
  return Number(rows[0]?.attempts || 0);
}

/** Clear a bucket after a success, so one bad day does not lock out tomorrow. */
export async function clearAttempts(bucket: string): Promise<void> {
  await ensureSecondStepSchema();
  await db.execute(sql`DELETE FROM auth_attempt_limit WHERE bucket = ${bucket}`).catch(() => {});
}

// ── password sign-in: the one path with no ceiling on it at all ─────────────
//
// EVERY OTHER GUESSABLE AUTH PATH ON THIS PROJECT IS COUNTED, AND THE PASSWORD FORM WAS NOT.
// /api/auth/totp-login counts six-digit guesses per identifier and per IP; /portal/login counts face
// descriptors and face lookups; recovery.ts counts date-of-birth and question-set attempts and fails
// closed. The four password forms — /admin/login, /portal/login, /aquintutor/login, /hei/login —
// called verifyPasswordForLogin() and nothing else, so an attacker could post passwords at an
// administrator's address for as long as they liked, from as many invocations as they liked, and the
// only cost was one scrypt per try. Nothing in front of those pages limits anything: middleware
// exempts the sign-in surfaces by name.
//
// THIS COUNTS FAILURES ONLY, AND CLEARS ON SUCCESS. A person typing their own password correctly
// never touches these buckets, so nobody's daily access changes. The ceilings are deliberately high
// enough to sit far above a bad morning of typos and far below an online guessing run.
//
// THE TRADE-OFF, STATED. A per-identifier ceiling means somebody who knows an address can spend it
// deliberately and make that person wait out the window. That is why the identifier ceiling is 20
// rather than 5, why the window is fifteen minutes rather than an hour, and why nothing here writes
// users.is_active or any other durable lock: the block evaporates on its own and the account is never
// altered. Recovery by email stays open throughout, on its own separate allowance.
export const PASSWORD_MAX_PER_IDENTIFIER = 20;
export const PASSWORD_MAX_PER_IP = 60;
export const PASSWORD_WINDOW_SECONDS = 900;

/** The message every surface shows, so four sign-in pages cannot word this four ways. */
export const PASSWORD_THROTTLED_MESSAGE =
  'Too many sign-in attempts for that account. Please wait 15 minutes and try again, or use "Forgot password" to get a one-time link by email.';

const pwIdBucket = (identifier: string) =>
  'pw:id:' + createHash('sha256').update((identifier || '').trim().toLowerCase()).digest('hex').slice(0, 32);
const pwIpBucket = (ip: string) =>
  'pw:ip:' + createHash('sha256').update((ip || 'unknown').trim()).digest('hex').slice(0, 32);

/**
 * Has this identifier / source already spent its allowance of FAILED password attempts?
 *
 * Read-only: it peeks, it does not spend, so simply loading the form costs nothing.
 *
 * IT FAILS OPEN, DELIBERATELY, AND THAT IS THE OPPOSITE OF recovery.ts. The recovery limiter refuses
 * when it cannot read its own counters because recovery is not a daily path and a few minutes of
 * refusal costs a support email. This one guards the door every employee walks through every morning:
 * if auth_attempt_limit becomes unreadable, refusing here would be a total sign-in outage across all
 * four surfaces, which is the exact failure this codebase has already shipped twice. The password and
 * scrypt are still required either way — this counter is depth, not the lock — so the safe direction
 * when the counter is missing is to let the real check decide, loudly logged.
 */
export async function passwordAttemptsBlocked(identifier: string, ip: string): Promise<boolean> {
  try {
    if (await peekAttempts(pwIdBucket(identifier), PASSWORD_WINDOW_SECONDS) > PASSWORD_MAX_PER_IDENTIFIER) return true;
    if (await peekAttempts(pwIpBucket(ip), PASSWORD_WINDOW_SECONDS) > PASSWORD_MAX_PER_IP) return true;
    return false;
  } catch (e: any) {
    console.error('[auth/two-factor] password attempt counter unreadable; letting the password check decide:',
      e?.cause?.message || e?.message);
    return false;
  }
}

/** Spend one failure. Never throws — a limiter that cannot count must not break the sign-in form. */
export async function recordFailedPassword(identifier: string, ip: string): Promise<void> {
  try {
    await countAttempt(pwIdBucket(identifier), PASSWORD_WINDOW_SECONDS);
    await countAttempt(pwIpBucket(ip), PASSWORD_WINDOW_SECONDS);
  } catch (e: any) {
    console.error('[auth/two-factor] could not record a failed password attempt:', e?.cause?.message || e?.message);
  }
}

/** Give the allowance back the moment the right password arrives. */
export async function clearPasswordAttempts(identifier: string, ip: string): Promise<void> {
  await clearAttempts(pwIdBucket(identifier)).catch(() => {});
  await clearAttempts(pwIpBucket(ip)).catch(() => {});
}

// ── per-account policy ──────────────────────────────────────────────────────
/** True when this account has opted in to a mandatory second step. */
export async function isSecondStepRequired(userId: string): Promise<boolean> {
  if (!userId) return false;
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`SELECT required FROM user_2fa_policy WHERE user_id = ${userId} LIMIT 1`));
  return !!rows[0]?.required;
}

/**
 * Does this account still hold at least one unused recovery code?
 *
 * A recovery code IS a completable second factor — verifyLoginCode() accepts one
 * whether or not an authenticator exists. The sign-in surfaces need this to tell
 * "this account can still finish a challenge" from "this account has nothing left
 * to prove with", because those two answers must produce opposite behaviour: the
 * first must be challenged, and the second must NOT be, or a lost phone becomes a
 * locked-out employee.
 */
export async function hasRecoveryCodesLeft(userId: string): Promise<boolean> {
  if (!userId) return false;
  await ensureSecondStepSchema();
  return (await countUnusedBackupCodes(userId)) > 0;
}

/**
 * Can this account complete a second step at all, by any route it has left?
 *
 * The sign-in pages used to gate the challenge on `availableSecondFactors().length > 0`
 * alone. That silently turned enforcement OFF for an opted-in account whose only
 * enrolled factor had gone away (a face enrolment cleared by an admin, an
 * authenticator removed) — one factor then signed them straight in while their
 * own settings page still said the second step was on, and while ten unused
 * recovery codes sat in the table unusable. Enforcement that quietly stops
 * enforcing is worse than no enforcement, because nobody is told.
 *
 * It still returns false when there is genuinely nothing left, and that is
 * deliberate: with no factor and no codes the only alternative to letting the
 * first factor through is locking the account out of every route it has.
 */
export async function canCompleteSecondStep(userId: string): Promise<boolean> {
  if (!userId) return false;
  const methods = await availableSecondFactors(userId);
  if (methods.length > 0) return true;
  return hasRecoveryCodesLeft(userId);
}

/** Which second factors this account could actually complete right now. */
export async function availableSecondFactors(userId: string): Promise<SecondFactorMethod[]> {
  await ensureSecondStepSchema();
  const out: SecondFactorMethod[] = [];
  if (await isTotpEnabled(userId)) out.push('totp');
  const face = rowsOf(await db.execute(
    sql`SELECT id FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`
  ));
  if (face.length) out.push('face');
  return out;
}

/**
 * Turn enforcement on. Refuses unless a usable second factor exists, and always
 * mints ten fresh single-use recovery codes — returned here and shown ONCE.
 * Turning it on without them is how you strand an employee whose phone died.
 */
export async function enableSecondStep(userId: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  await ensureSecondStepSchema();
  const methods = await availableSecondFactors(userId);
  if (!methods.length) {
    return { ok: false, error: 'Set up an authenticator app or enrol your face first — otherwise turning this on locks you out.' };
  }
  // TURNING ON WHAT IS ALREADY ON IS NOT A NO-OP — IT SILENTLY REPLACES THE RECOVERY CODES.
  //
  // storeBackupCodes() DELETEs every existing code before inserting the new ten, so calling this on
  // an account whose second step is already required destroys whatever the person is still carrying
  // and hands the caller ten fresh working ones. That is precisely what
  // /api/auth/2fa/recovery-codes refuses to do without proof of a factor — its whole comment is "a
  // hijacked session cannot mint itself a fresh set of permanent bypasses" — and this route reached
  // the same place with no code at all, from any signed-in session, at both
  // /api/auth/2fa/enforce {enabled:true} and the `enable` action on /portal/employee/security.
  // The page hides that button once enforcement is on (an inline display:none), which is a hidden
  // control, not a closed door.
  //
  // Refused only while unused codes still exist. With none left there is nothing to destroy and
  // nothing to prove a factor with either, so this stays the escape hatch out of that corner rather
  // than becoming a second way to strand somebody — the failure mode this module was written to
  // avoid twice over.
  if (await isSecondStepRequired(userId) && (await countUnusedBackupCodes(userId)) > 0) {
    return {
      ok: false,
      error: 'The second step is already on for this account. To replace your recovery codes, use "Issue ten new codes" and confirm with a current code — turning it on again would silently invalidate the codes you are still carrying.',
    };
  }
  const codes = generateBackupCodes(10);
  await storeBackupCodes(userId, codes);
  await db.execute(sql`
    INSERT INTO user_2fa_policy (user_id, required, enabled_at, updated_at)
    VALUES (${userId}, true, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET required = true, enabled_at = COALESCE(user_2fa_policy.enabled_at, now()), updated_at = now()
  `);
  return { ok: true, recoveryCodes: codes };
}

/** Turn enforcement off. The caller must have re-proved a factor first. */
export async function disableSecondStep(userId: string): Promise<void> {
  await ensureSecondStepSchema();
  await db.execute(sql`
    INSERT INTO user_2fa_policy (user_id, required, updated_at)
    VALUES (${userId}, false, now())
    ON CONFLICT (user_id) DO UPDATE SET required = false, updated_at = now()
  `);
}

/** Re-issue ten codes, invalidating every previous one. Shown once. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  await ensureSecondStepSchema();
  const codes = generateBackupCodes(10);
  await storeBackupCodes(userId, codes);
  return codes;
}

// ── pending challenge (the half-finished sign-in) ───────────────────────────
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Secure flag for the pending cookie — the SAME rule the session cookie follows
 * (src/lib/auth/cookie.ts sets `secure: import.meta.env.PROD`).
 *
 * Hard-coding `secure: true` looked stricter and was, in practice, a sign-in
 * outage waiting for a non-https origin: a browser that refuses to store a Secure
 * cookie over http drops the challenge token, the surface then sees no pending
 * challenge, and an account with the second step turned on bounces back to the
 * sign-in form for ever with no error anywhere. In production this value is true
 * either way, so nothing is relaxed where it matters.
 */
export const PENDING_COOKIE_SECURE = import.meta.env.PROD;

/** Cookie name carrying the pending token for a surface. Never a user id. */
export function pendingCookieName(surface: SignInSurface): string {
  return 'era_2fa_' + surface;
}

/**
 * First factor passed but no session yet. Returns an opaque token to put in a
 * cookie. The token is the ONLY thing that names the half-finished sign-in, so
 * a forged cookie cannot select a victim's account.
 */
export async function startPendingChallenge(
  userId: string, surface: SignInSurface, firstFactor: string
): Promise<string> {
  await ensureSecondStepSchema();
  const token = randomBytes(32).toString('base64url');
  // Housekeeping: drop this user's older half-finished sign-ins and anything stale.
  await db.execute(sql`DELETE FROM auth_pending_2fa WHERE user_id = ${userId} OR expires_at < now()`).catch(() => {});
  await db.execute(sql`
    INSERT INTO auth_pending_2fa (token_hash, user_id, surface, first_factor, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${surface}, ${firstFactor},
            now() + make_interval(secs => ${PENDING_TTL_SECONDS}))
  `);
  return token;
}

export type PendingChallenge = {
  id: string; userId: string; surface: string; firstFactor: string; attempts: number;
};

/**
 * Look up a pending challenge WITHOUT consuming it — for rendering the prompt.
 * Returns null when unknown, expired, already consumed, or on the wrong surface.
 * A pending challenge is never a session: nothing here sets locals.user, and
 * middleware does not read this cookie.
 */
export async function resolvePendingChallenge(
  token: string, surface: SignInSurface
): Promise<PendingChallenge | null> {
  if (!token) return null;
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`
    SELECT id, user_id, surface, first_factor, attempts
    FROM auth_pending_2fa
    WHERE token_hash = ${hashToken(token)}
      AND surface = ${surface}
      AND consumed_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `));
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), userId: String(r.user_id), surface: String(r.surface),
    firstFactor: String(r.first_factor), attempts: Number(r.attempts || 0),
  };
}

/** Count a failed second-factor try against the challenge itself. */
export async function recordChallengeAttempt(token: string): Promise<number> {
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE auth_pending_2fa SET attempts = attempts + 1
    WHERE token_hash = ${hashToken(token)} AND consumed_at IS NULL
    RETURNING attempts
  `));
  return Number(rows[0]?.attempts || 0);
}

/**
 * Atomically burn the challenge. Single-use: the UPDATE only matches while
 * consumed_at IS NULL, so two concurrent replays cannot both win and mint two
 * sessions. Call this immediately BEFORE creating the session.
 */
export async function consumePendingChallenge(
  token: string, surface: SignInSurface
): Promise<PendingChallenge | null> {
  if (!token) return null;
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(sql`
    UPDATE auth_pending_2fa SET consumed_at = now()
    WHERE token_hash = ${hashToken(token)}
      AND surface = ${surface}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING id, user_id, surface, first_factor, attempts
  `));
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), userId: String(r.user_id), surface: String(r.surface),
    firstFactor: String(r.first_factor), attempts: Number(r.attempts || 0),
  };
}

/** Abandon a challenge (cancel button, or too many wrong tries). */
export async function dropPendingChallenge(token: string): Promise<void> {
  if (!token) return;
  await ensureSecondStepSchema();
  await db.execute(sql`DELETE FROM auth_pending_2fa WHERE token_hash = ${hashToken(token)}`).catch(() => {});
}

// ── face as a second factor (authoritative, server-side) ────────────────────
function euclid(a: number[], b: number[]): number {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] || 0) - (b[i] || 0); s += d * d; }
  return Math.sqrt(s);
}

/** Accept the several shapes a 128-float descriptor arrives in. */
export function normalizeDescriptor(d: any): number[] | null {
  if (d == null) return null;
  if (typeof d === 'string') { try { return normalizeDescriptor(JSON.parse(d)); } catch { return null; } }
  if (Array.isArray(d)) return d.map(Number);
  if (typeof d === 'object') return Object.keys(d).sort((a, b) => Number(a) - Number(b)).map((k) => Number(d[k]));
  return null;
}

/**
 * Compare a freshly captured descriptor against the enrolled one HERE. The
 * browser's own verdict is never an input — same rule the enrolment endpoint
 * follows. Returns the distance so the caller can audit it.
 */
export async function verifyFaceSecondFactor(
  userId: string, liveRaw: unknown
): Promise<{ matched: boolean; distance: number }> {
  await ensureSecondStepSchema();
  const rows = rowsOf(await db.execute(
    sql`SELECT face_descriptor FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`
  ));
  const stored = normalizeDescriptor(rows[0]?.face_descriptor);
  const live = normalizeDescriptor(liveRaw);
  if (!stored || !live || stored.length !== 128 || live.length !== 128) {
    return { matched: false, distance: 99 };
  }
  const distance = euclid(stored, live);
  return { matched: distance < FACE_MATCH_THRESHOLD, distance };
}

// ── the one call a sign-in surface makes ────────────────────────────────────
export type SecondFactorResult =
  | { ok: true; userId: string }
  | { ok: false; error: string; locked?: boolean };

/**
 * Verify a second factor for a pending challenge and, on success, burn it.
 *
 * On success the caller may create the session — and MUST NOT create one on any
 * other path. Rate limiting is shared-state, keyed on the challenge and on the
 * account, so retrying from a new lambda / new IP does not reset the count.
 */
export async function verifySecondFactor(
  token: string, surface: SignInSurface, method: SecondFactorMethod, payload: string
): Promise<SecondFactorResult> {
  const pending = await resolvePendingChallenge(token, surface);
  if (!pending) {
    return { ok: false, error: 'That sign-in step expired. Please sign in again.' };
  }

  // THE SECOND STEP MAY NOT BE THE FACTOR THAT WAS ALREADY USED, AND THIS IS WHERE THAT IS DECIDED.
  //
  // A face descriptor is not single-use and carries no freshness: verifyFaceSecondFactor() compares
  // whatever arrives against the stored template, and nothing else. So on a face-first sign-in
  // (src/pages/portal/login.astro, action `face_verified`, which starts a challenge with
  // firstFactor='face') the EXACT SAME `live_descriptor` string that satisfied the first factor
  // satisfied the second one too. The whole mandatory second step was one re-POST of a value the
  // caller already held.
  //
  // The rule itself was not new. portal/login.astro renders the challenge with
  // `offerFace = methods.indexOf('face') >= 0 && pending.firstFactor !== 'face'`, and gateApiSignIn()
  // below says it in a comment. Both of those decide what the page OFFERS. A form posts what it
  // likes: `method=face` plus a descriptor reached this function whatever the page had drawn, which
  // is a hidden control rather than a closed door - the same shape /api/2fa/start was repaired for.
  //
  // Nobody loses a way in. A face-first challenge is only ever started for an account that has an
  // authenticator (portal/login refuses to start one otherwise, in as many words), and recovery
  // codes remain available on every account with enforcement turned on. The three password-first
  // surfaces are untouched: face is a different factor from a password and stays offered there.
  if (method === 'face' && pending.firstFactor === 'face') {
    return {
      ok: false,
      error: 'You are already signed in this far with your face, so the second step has to be something else. Enter a code from your authenticator app, or one of your recovery codes.',
    };
  }

  const accountBucket = '2fa:user:' + pending.userId;
  const total = await countAttempt(accountBucket, 900);
  if (total > 10) {
    await dropPendingChallenge(token);
    return { ok: false, error: 'Too many attempts. Wait 15 minutes, then sign in again.', locked: true };
  }
  if (pending.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await dropPendingChallenge(token);
    return { ok: false, error: 'Too many attempts. Please sign in again.', locked: true };
  }

  let passed = false;
  if (method === 'face') {
    const r = await verifyFaceSecondFactor(pending.userId, payload);
    passed = r.matched;
  } else {
    // Covers a live authenticator code AND a one-time recovery code.
    passed = await verifyLoginCode(pending.userId, (payload || '').trim());
  }

  if (!passed) {
    await recordChallengeAttempt(token);
    return { ok: false, error: 'That did not match. Try again, or use a recovery code.' };
  }

  // Burn it before the session exists, so a replay of the same token loses.
  const burned = await consumePendingChallenge(token, surface);
  if (!burned) {
    return { ok: false, error: 'That sign-in step was already used. Please sign in again.' };
  }
  await clearAttempts(accountBucket);
  return { ok: true, userId: burned.userId };
}

// ── enforcement for JSON sign-in endpoints ─────────────────────────────────
/** Where a surface collects its second step. */
export function loginPathFor(surface: SignInSurface): string {
  if (surface === 'admin') return '/admin/login';
  if (surface === 'aquintutor') return '/aquintutor/login';
  if (surface === 'hei') return '/hei/login';
  return '/portal/login';
}

/**
 * Gate a JSON sign-in endpoint (passkey, TOTP-only) the same way the page
 * surfaces are gated.
 *
 * Without this, an account that opted in to a second step could still be signed
 * in with one factor by POSTing to an API route — the enforcement would only
 * exist on the surfaces someone happened to test. Returns `gated: true` when
 * the caller must NOT create a session and should redirect the browser to the
 * challenge instead.
 */
export async function gateApiSignIn(
  userId: string, surface: SignInSurface, firstFactor: string, cookies: any
): Promise<{ gated: boolean; redirect: string }> {
  const required = await isSecondStepRequired(userId);
  if (!required) return { gated: false, redirect: '' };
  const methods = await availableSecondFactors(userId);
  // WHAT IS AND IS NOT ENFORCED ABOUT "a DIFFERENT factor", stated instead of implied.
  //
  // This block used to claim "the second factor must be something OTHER than the one just used" and
  // then drop the list it had just computed on the floor (`void methods`). Half of that claim is now
  // real and lives in verifySecondFactor() above, where a form post cannot route around it: a face
  // first factor can no longer be answered with a face.
  //
  // The other half is NOT enforced, deliberately, and the reason belongs on the record. An
  // authenticator-code first factor (/api/auth/totp-login) can still be answered with another
  // authenticator code, because the challenge screens accept a live code and a one-time recovery code
  // through the same input and cannot tell a caller which they must use. Refusing the live code would
  // force a recovery code on every such sign-in for an account whose only enrolled factor is an
  // authenticator, spending a finite resource that exists for lost devices - a worse failure than the
  // one it closes. It is not a replay: claimTotpStep() (src/lib/auth/twofactor.ts) spends the 30-second
  // step, so the second code must be a LATER one read from the device again. Changing it is a policy
  // decision about what an account must hold, not a mechanism fix.
  //
  // `methods` is read here rather than discarded, so the log says which factors the account could
  // actually complete when a challenge was raised.
  if (methods.length === 0) {
    console.warn('[auth/two-factor] second step required with no enrolled factor left; recovery codes only', { userId, surface, firstFactor });
  }
  const token = await startPendingChallenge(userId, surface, firstFactor);
  cookies.set(pendingCookieName(surface), token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: PENDING_COOKIE_SECURE, maxAge: PENDING_TTL_SECONDS,
  });
  return { gated: true, redirect: loginPathFor(surface) };
}

/** Constant-time string compare that tolerates unequal lengths. */
export function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
