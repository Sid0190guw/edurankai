// src/lib/aquin/identity.ts — AquinTutor's own accounts, sessions and authorization.
//
// =================================================================================================
// EVERY FUNCTION HERE GOES THROUGH ONE STORE INTERFACE, AND THAT IS THE POINT
// =================================================================================================
//
// AquinTutor shares this Supabase for now and will not later. The difference between that being a
// weekend and being a rescue is whether the product talks to a DATABASE or to an INTERFACE.
//
// So nothing above this file ever writes SQL. It calls resolveAquinUser(), signIn(), assignRole().
// The Postgres implementation of those lives in ./store-postgres.ts behind AquinStore, and moving to
// a separate database means writing a second implementation and changing one line in ./store.ts —
// not auditing every page that happens to read a user.
//
// =================================================================================================
// AN AQUINTUTOR SESSION IS NOT AN EDURANKAI SESSION AND NEVER BECOMES ONE
// =================================================================================================
//
// There is no bridge in this file. No "if they are a super admin over there". No fallback to
// Astro.locals.user. A person who administers EduRankAI has no standing here until somebody creates
// them an AquinTutor account and gives them a role, and that is the whole content of the word
// "independent" in the instruction.
//
// The temptation to add a bridge will be strongest during the transition, when the founder has to
// sign in twice. It must be resisted: a bridge added for convenience is indistinguishable, in code
// and in consequence, from the coupling this separation exists to remove.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { AQUIN_ROLES, AQUIN_ADMIN_ROLE_KEYS, AQUIN_ROOT_CAPABILITY } from './schema';
import type { AquinStore, AquinUserRow } from './store';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST — `const` is not hoisted, and a binding under its first reader has taken pages
// down on this project more than once.
// -------------------------------------------------------------------------------------------------

export const SESSION_DAYS = 30;
/** Tokens are 256 bits of randomness; only their hash is stored. */
const TOKEN_BYTES = 32;

export interface AquinPrincipal {
  /** Null when nobody is signed in. Never borrowed from another product. */
  userId: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
  capabilities: Set<string>;
  /** True when a lookup FAILED, as distinct from a caller who is genuinely signed out. */
  degraded: boolean;
  /** Why, when degraded — for the screen, not for a log nobody reads. */
  reason: string | null;
}

export const ANONYMOUS: AquinPrincipal = Object.freeze({
  userId: null, email: null, name: null, roles: ['guest'],
  capabilities: new Set(['read']), degraded: false, reason: null,
}) as AquinPrincipal;

/** A principal we could not resolve. Holds NOTHING — a failed read must never widen access. */
function degraded(reason: string): AquinPrincipal {
  return { userId: null, email: null, name: null, roles: [], capabilities: new Set(), degraded: true, reason };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Constant-time compare, so a token cannot be recovered a byte at a time. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Union of the capabilities the given roles grant, from the seeded roster. */
export function capabilitiesFor(roleKeys: readonly string[]): Set<string> {
  const caps = new Set<string>();
  for (const key of roleKeys) {
    const role = AQUIN_ROLES.find((r) => r.key === key);
    if (!role) continue;                     // an unknown role grants nothing, silently and safely
    for (const c of role.capabilities) caps.add(c);
  }
  return caps;
}

/** Does this principal hold a capability? `administer` authorises everything. */
export function holds(p: AquinPrincipal, capability: string): boolean {
  if (p.degraded) return false;              // unknown is never yes
  if (p.capabilities.has(AQUIN_ROOT_CAPABILITY)) return true;
  return p.capabilities.has(capability);
}

/** May this principal open the AquinTutor admin at all? */
export function mayOpenAquinAdmin(p: AquinPrincipal): boolean {
  if (p.degraded || !p.userId) return false;
  return p.roles.some((r) => AQUIN_ADMIN_ROLE_KEYS.includes(r));
}

/** Is this principal AquinTutor's own super admin? Never inferred from another product. */
export function isAquinSuperAdmin(p: AquinPrincipal): boolean {
  return !p.degraded && p.roles.includes('super_admin');
}

function principalFrom(user: AquinUserRow, roles: string[]): AquinPrincipal {
  return {
    userId: user.id,
    email: user.email,
    name: user.name || user.email,
    roles,
    capabilities: capabilitiesFor(roles),
    degraded: false,
    reason: null,
  };
}

// -------------------------------------------------------------------------------------------------
// THE OPERATIONS. All of them take the store, so a test needs no database and the eventual move to
// a separate one needs no change here.
// -------------------------------------------------------------------------------------------------

/**
 * Who is this cookie token?
 *
 * NEVER THROWS. A failed read answers `degraded`, which holds nothing — a database hiccup must not
 * become an authorisation, and it must not silently look like being signed out either, or the
 * screen will invite somebody to sign in again into an outage.
 */
export async function resolveAquinUser(store: AquinStore, token: string | null | undefined): Promise<AquinPrincipal> {
  if (!token) return ANONYMOUS;
  try {
    const found = await store.sessionByTokenHash(hashToken(token));
    if (!found) return ANONYMOUS;                      // no such session: genuinely signed out
    if (found.session.revokedAt) return ANONYMOUS;
    if (found.session.expiresAt.getTime() <= Date.now()) return ANONYMOUS;
    if (!found.user.isActive) {
      // Signed in, but the account is closed. Distinct from anonymous so the screen can say which.
      return { ...degraded(found.user.inactiveReason || 'This account is closed.'), email: found.user.email };
    }
    const roles = await store.rolesFor(found.user.id);
    return principalFrom(found.user, roles);
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[aquin/identity] session lookup failed:', why);
    return degraded('Your sign-in could not be checked just now.');
  }
}

export interface SignInResult {
  ok: boolean;
  token?: string;
  expiresAt?: Date;
  principal?: AquinPrincipal;
  /** One sentence for the person, never a code. */
  error?: string;
}

/**
 * Sign in with an email and password.
 *
 * THE SAME SENTENCE FOR A WRONG PASSWORD AND AN UNKNOWN ADDRESS. Distinguishing them turns the
 * login form into a way to ask whether somebody has an account here, which on a platform with named
 * teachers and partners is worth not answering.
 */
export async function signIn(
  store: AquinStore,
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SignInResult> {
  const addr = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  if (!addr || !pw) return { ok: false, error: 'Enter your email address and password.' };

  let user: AquinUserRow | null = null;
  try {
    user = await store.userByEmail(addr);
  } catch (e: any) {
    // NEVER SWALLOWED. A bare catch here hid a total sign-in outage on this project for hours.
    console.error('[aquin/identity] sign-in lookup failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'We could not check your details just now. Nothing is wrong with your password — please try again in a moment.' };
  }

  const SAME = 'That email address and password do not match an AquinTutor account.';
  if (!user || !user.passwordHash) return { ok: false, error: SAME };

  let good = false;
  try {
    good = await verifyPassword(user.passwordHash, pw);
  } catch (e: any) {
    console.error('[aquin/identity] password verification failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'We could not check your details just now. Please try again in a moment.' };
  }
  if (!good) return { ok: false, error: SAME };

  if (!user.isActive) {
    return { ok: false, error: user.inactiveReason || 'This account is closed. Ask an AquinTutor administrator to reopen it.' };
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  try {
    await store.createSession({
      tokenHash: hashToken(token), userId: user.id, expiresAt,
      issuedIp: meta.ip ?? null, userAgent: meta.userAgent ?? null,
    });
  } catch (e: any) {
    console.error('[aquin/identity] session creation failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'Your details were correct, but the session could not be created. Please try again.' };
  }

  const roles = await store.rolesFor(user.id).catch(() => [] as string[]);
  return { ok: true, token, expiresAt, principal: principalFrom(user, roles) };
}

export async function signOut(store: AquinStore, token: string | null | undefined): Promise<void> {
  if (!token) return;
  try { await store.revokeSession(hashToken(token)); }
  catch (e: any) { console.error('[aquin/identity] sign-out failed:', e?.cause?.message || e?.message); }
}

export interface CreateAccountInput {
  email: string;
  name: string;
  password: string;
  roles?: string[];
}

/**
 * Create an AquinTutor account.
 *
 * ROLES ARE NOT TAKEN ON TRUST, AND NO ADMIN-SURFACE ROLE MAY BE SELF-REQUESTED.
 *
 * The first draft of this refused only 'super_admin' — and its own test caught that 'admin',
 * 'teacher', 'partner' and 'moderator' are all admin-surface roles too, so a signup form could have
 * asked for 'admin' and been given it. That is the identical self-grant wearing a smaller name.
 *
 * Administration is granted by an existing super admin through assignRole(), which is the only path
 * that records who granted it. Account creation may set main-surface roles only.
 */
export async function createAccount(store: AquinStore, input: CreateAccountInput): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const password = String(input.password || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'That email address does not look right.' };
  if (!name) return { ok: false, error: 'A name is required.' };
  if (password.length < 10) return { ok: false, error: 'Use at least 10 characters, so the password is worth having.' };

  // Main surface only. Not a denylist of one key — a denylist would need editing every time a role
  // is added, and the one nobody remembered to add would be the one that mattered.
  const mainRoles = new Set(AQUIN_ROLES.filter((r) => r.surface === 'main').map((r) => r.key));
  const roles = (input.roles || ['learner']).filter((r) => mainRoles.has(r));

  try {
    if (await store.userByEmail(email)) return { ok: false, error: 'An AquinTutor account already uses that address.' };
    const userId = await store.createUser({ email, name, passwordHash: await hashPassword(password) });
    for (const r of roles.length ? roles : ['learner']) await store.assignRole(userId, r, null);
    return { ok: true, userId };
  } catch (e: any) {
    console.error('[aquin/identity] account creation failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'That account could not be created just now.' };
  }
}

/**
 * Grant a role.
 *
 * GRANTING ADMINISTRATION IS THE ONE THING ONLY A SUPER ADMIN MAY DO. An administrator who could
 * appoint administrators is a super admin wearing another name, and the distinction between the two
 * roles would last exactly as long as the first person noticed.
 */
export async function assignRole(
  store: AquinStore,
  actor: AquinPrincipal,
  userId: string,
  roleKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const role = AQUIN_ROLES.find((r) => r.key === roleKey);
  if (!role) return { ok: false, error: 'There is no such role.' };
  if (!mayOpenAquinAdmin(actor)) return { ok: false, error: 'You are not an AquinTutor administrator.' };
  if (role.surface === 'admin' && !isAquinSuperAdmin(actor)) {
    return { ok: false, error: 'Only an AquinTutor super admin may grant administrative roles.' };
  }
  try {
    await store.assignRole(userId, roleKey, actor.userId);
    await store.audit({ actorId: actor.userId, action: 'role.assign', subject: userId, detail: { role: roleKey } });
    return { ok: true };
  } catch (e: any) {
    console.error('[aquin/identity] role assignment failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'That role could not be assigned just now.' };
  }
}

export async function removeRole(
  store: AquinStore,
  actor: AquinPrincipal,
  userId: string,
  roleKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isAquinSuperAdmin(actor) && AQUIN_ADMIN_ROLE_KEYS.includes(roleKey)) {
    return { ok: false, error: 'Only an AquinTutor super admin may remove administrative roles.' };
  }
  if (!mayOpenAquinAdmin(actor)) return { ok: false, error: 'You are not an AquinTutor administrator.' };
  // THE LAST SUPER ADMIN MAY NOT BE REMOVED, including by themselves. An AquinTutor with nobody
  // able to grant a role is an AquinTutor that needs a database console to recover, and the person
  // doing it would be one click from that with no warning.
  if (roleKey === 'super_admin') {
    try {
      const n = await store.countRole('super_admin');
      if (n <= 1) return { ok: false, error: 'This is the only super admin. Appoint another before removing this one, or nobody will be able to grant roles.' };
    } catch (e: any) {
      console.error('[aquin/identity] super admin count failed:', e?.cause?.message || e?.message);
      return { ok: false, error: 'We could not confirm how many super admins remain, so nothing was changed.' };
    }
  }
  try {
    await store.removeRole(userId, roleKey);
    await store.audit({ actorId: actor.userId, action: 'role.remove', subject: userId, detail: { role: roleKey } });
    return { ok: true };
  } catch (e: any) {
    console.error('[aquin/identity] role removal failed:', e?.cause?.message || e?.message);
    return { ok: false, error: 'That role could not be removed just now.' };
  }
}
