// Tests for AquinTutor's independent identity.
//
// =================================================================================================
// WHAT THESE ARE ACTUALLY GUARDING
// =================================================================================================
//
// The instruction was that AquinTutor shares this Supabase for a while but its accounts, its
// administrators and its access stay independent. Independence is not something you can see on a
// screen — it is the ABSENCE of a path from one product's authority to the other's, and an absence
// is exactly what gets added back by accident during a transition, by somebody being helpful.
//
// So the boundary is asserted here: no EduRankAI role, session or capability appears anywhere in
// this module's inputs, and nothing in it can be persuaded to accept one.
//
// vitest, not the house shim: every call here is async, and the shim's it() does not await its body
// — an async test on it passes while asserting nothing.

import { describe, it, expect } from 'vitest';
import {
  resolveAquinUser, signIn, signOut, createAccount, assignRole, removeRole,
  capabilitiesFor, holds, mayOpenAquinAdmin, isAquinSuperAdmin, hashToken, newToken, ANONYMOUS,
} from './identity';
import { memoryStore } from './store';
import { AQUIN_ROLES, AQUIN_ADMIN_ROLE_KEYS } from './schema';
import { tenantForHost, sessionCookieName, normaliseHost, isAquinPath, loginPathFor } from './tenant';

const PW = 'a-long-enough-password';

async function withAccount(roles: string[] = ['learner']) {
  const store = memoryStore();
  const made = await createAccount(store, { email: 'Teacher@Aquintutor.com', name: 'A Teacher', password: PW, roles });
  return { store, userId: made.userId! };
}

// -------------------------------------------------------------------------------------------------
describe('the host decides the identity domain, never the path', () => {
  it('sends aquintutor.com and its subdomains to their own domain', () => {
    expect(tenantForHost('aquintutor.com')).toBe('aquintutor');
    expect(tenantForHost('www.aquintutor.com')).toBe('aquintutor');
    expect(tenantForHost('admin.aquintutor.com')).toBe('aquintutor');
    expect(tenantForHost('AQUINTUTOR.COM:443')).toBe('aquintutor');
  });

  it('does not match a host that merely ends in the same letters', () => {
    // notaquintutor.com must not become AquinTutor by suffix.
    expect(tenantForHost('notaquintutor.com')).toBe('edurankai');
    expect(tenantForHost('aquintutor.com.evil.test')).toBe('edurankai');
  });

  it('treats an unknown host as EduRankAI, because that mistake is the survivable one', () => {
    // Wrongly EduRankAI shows a login page. Wrongly AquinTutor would hand a new identity domain to
    // whatever host happened to resolve.
    expect(tenantForHost('some-preview.vercel.app')).toBe('edurankai');
    expect(tenantForHost('')).toBe('edurankai');
    expect(tenantForHost(null)).toBe('edurankai');
  });

  it('/aquintutor/* on the EduRankAI host stays an EduRankAI request', () => {
    // The path picks a surface; the host picks the identity. If the path picked the identity, this
    // URL would be an AquinTutor admin reachable with an EduRankAI session.
    expect(tenantForHost('www.edurankai.in')).toBe('edurankai');
    expect(isAquinPath('/aquintutor/admin')).toBe(true);
  });

  it('strips ports, including on IPv6 literals', () => {
    expect(normaliseHost('localhost:4321')).toBe('localhost');
    expect(normaliseHost('[::1]:4321')).toBe('[::1]');
  });

  it('gives the two products different cookie names and different login pages', () => {
    // Different names so a session issued by one cannot be read by the other even while both are
    // served from a single origin, which is the situation during the transition.
    expect(sessionCookieName('aquintutor')).toBe('aquin_session');
    expect(sessionCookieName('aquintutor') === sessionCookieName('edurankai')).toBe(false);
    expect(loginPathFor('aquintutor')).toBe('/aquintutor/login');
    expect(loginPathFor('edurankai')).toBe('/admin/login');
  });
});

// -------------------------------------------------------------------------------------------------
describe('signing in', () => {
  it('issues a session whose token is stored only as a hash', async () => {
    const { store } = await withAccount();
    const r = await signIn(store, 'teacher@aquintutor.com', PW);
    expect(r.ok).toBe(true);
    expect(typeof r.token).toBe('string');
    // A leaked backup must not contain usable sessions.
    const found = await store.sessionByTokenHash(hashToken(r.token!));
    expect(!!found).toBe(true);
    expect(await store.sessionByTokenHash(r.token!)).toBe(null);
  });

  it('matches the address case-insensitively, because people capitalise their own email', async () => {
    const { store } = await withAccount();
    expect((await signIn(store, 'TEACHER@AQUINTUTOR.COM', PW)).ok).toBe(true);
  });

  it('says the same thing for a wrong password and an unknown address', async () => {
    const { store } = await withAccount();
    const wrongPw = await signIn(store, 'teacher@aquintutor.com', 'not-the-password');
    const noSuch = await signIn(store, 'nobody@aquintutor.com', PW);
    expect(wrongPw.ok).toBe(false);
    expect(noSuch.ok).toBe(false);
    // Otherwise the login form answers "does this person have an account here".
    expect(wrongPw.error).toBe(noSuch.error);
  });

  it('reports a lookup failure as a failure, never as a wrong password', async () => {
    // A bare catch on this path once hid a total sign-in outage on this project for hours.
    const store = memoryStore();
    store.userByEmail = async () => { throw new Error('db down'); };
    const r = await signIn(store, 'someone@aquintutor.com', PW);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('Nothing is wrong with your password');
  });

  it('refuses a closed account and says so rather than pretending the password is wrong', async () => {
    const { store, userId } = await withAccount();
    const u = (store as any)._users.get(userId);
    u.isActive = false; u.inactiveReason = 'Closed while your partnership is reviewed.';
    const r = await signIn(store, 'teacher@aquintutor.com', PW);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('partnership is reviewed');
  });

  it('signing out revokes the session, and the token stops resolving', async () => {
    const { store } = await withAccount();
    const r = await signIn(store, 'teacher@aquintutor.com', PW);
    expect((await resolveAquinUser(store, r.token)).userId).toBeTruthy();
    await signOut(store, r.token);
    expect((await resolveAquinUser(store, r.token)).userId).toBe(null);
  });
});

// -------------------------------------------------------------------------------------------------
describe('resolving a caller', () => {
  it('no cookie is anonymous, not degraded', async () => {
    const store = memoryStore();
    expect((await resolveAquinUser(store, null)).degraded).toBe(false);
    expect((await resolveAquinUser(store, null)).userId).toBe(null);
  });

  it('an expired session resolves to nobody', async () => {
    const { store, userId } = await withAccount();
    const token = newToken();
    await store.createSession({ tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() - 1000) });
    expect((await resolveAquinUser(store, token)).userId).toBe(null);
  });

  it('a FAILED lookup holds nothing and says it is degraded', async () => {
    // The dangerous direction: a database hiccup must never become an authorisation, and must not
    // look like being signed out either, or the screen invites a sign-in into an outage.
    const store = memoryStore();
    store.sessionByTokenHash = async () => { throw new Error('db down'); };
    const p = await resolveAquinUser(store, 'anything');
    expect(p.degraded).toBe(true);
    expect(p.capabilities.size).toBe(0);
    expect(holds(p, 'read')).toBe(false);
    expect(mayOpenAquinAdmin(p)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
describe('the admin boundary', () => {
  it('an anonymous visitor cannot open the admin', () => {
    expect(mayOpenAquinAdmin(ANONYMOUS)).toBe(false);
    expect(isAquinSuperAdmin(ANONYMOUS)).toBe(false);
  });

  it('a learner cannot open the admin however many main-surface roles they hold', async () => {
    const { store } = await withAccount(['learner', 'guest']);
    const r = await signIn(store, 'teacher@aquintutor.com', PW);
    expect(mayOpenAquinAdmin(r.principal!)).toBe(false);
  });

  it('every admin-surface role opens it, and no main-surface role does', () => {
    for (const role of AQUIN_ROLES) {
      const p = { ...ANONYMOUS, userId: 'x', roles: [role.key], capabilities: capabilitiesFor([role.key]) };
      expect(mayOpenAquinAdmin(p as any)).toBe(role.surface === 'admin');
    }
  });

  it('administer authorises everything, and only super_admin holds it', () => {
    const sup = { ...ANONYMOUS, userId: 'x', roles: ['super_admin'], capabilities: capabilitiesFor(['super_admin']) } as any;
    expect(holds(sup, 'anything-at-all')).toBe(true);
    for (const r of AQUIN_ROLES) {
      if (r.key === 'super_admin') continue;
      expect(capabilitiesFor([r.key]).has('administer')).toBe(false);
    }
  });

  it('an unknown role grants nothing rather than throwing', () => {
    expect(capabilitiesFor(['not-a-role']).size).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe('granting administration', () => {
  it('an administrator cannot appoint another administrator', async () => {
    // Otherwise `admin` is `super_admin` under a different name, and the distinction lasts until
    // the first person notices.
    //
    // The role is granted through the store rather than through createAccount, because createAccount
    // now refuses every admin-surface role — which is what the test below asserts, and is why this
    // setup cannot use it. That refusal was found by that test, not by reading this file.
    const { store, userId } = await withAccount();
    await store.assignRole(userId, 'admin', null);
    const r = await signIn(store, 'teacher@aquintutor.com', PW);
    const out = await assignRole(store, r.principal!, userId, 'admin');
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('super admin');
  });

  it('a super admin can, and it is written to the audit', async () => {
    const store = memoryStore();
    const sup = await createAccount(store, { email: 'root@aquintutor.com', name: 'Root', password: PW });
    await store.assignRole(sup.userId!, 'super_admin', null);
    const s = await signIn(store, 'root@aquintutor.com', PW);
    const other = await createAccount(store, { email: 'new@aquintutor.com', name: 'New', password: PW });
    const out = await assignRole(store, s.principal!, other.userId!, 'admin');
    expect(out.ok).toBe(true);
    expect((store as any)._audit.some((a: any) => a.action === 'role.assign')).toBe(true);
  });

  it('account creation can never request super_admin for itself', async () => {
    // A signup form that could ask for super_admin is a signup form that grants it.
    const store = memoryStore();
    const made = await createAccount(store, { email: 'x@aquintutor.com', name: 'X', password: PW, roles: ['super_admin', 'admin'] });
    const roles = await store.rolesFor(made.userId!);
    expect(roles.includes('super_admin')).toBe(false);
    expect(roles.includes('admin')).toBe(false);   // admin is admin-surface too and is not self-granted
  });

  it('the last super admin cannot be removed, including by themselves', async () => {
    // An AquinTutor with nobody able to grant a role needs a database console to recover, and the
    // person doing it would be one click away with no warning.
    const store = memoryStore();
    const sup = await createAccount(store, { email: 'root@aquintutor.com', name: 'Root', password: PW });
    await store.assignRole(sup.userId!, 'super_admin', null);
    const s = await signIn(store, 'root@aquintutor.com', PW);
    const out = await removeRole(store, s.principal!, sup.userId!, 'super_admin');
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('only super admin');
  });

  it('but the second-to-last can', async () => {
    const store = memoryStore();
    const a = await createAccount(store, { email: 'a@aquintutor.com', name: 'A', password: PW });
    const b = await createAccount(store, { email: 'b@aquintutor.com', name: 'B', password: PW });
    await store.assignRole(a.userId!, 'super_admin', null);
    await store.assignRole(b.userId!, 'super_admin', null);
    const s = await signIn(store, 'a@aquintutor.com', PW);
    expect((await removeRole(store, s.principal!, b.userId!, 'super_admin')).ok).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
describe('nothing here can be reached from the other product', () => {
  it('no AquinTutor role key collides with an EduRankAI one by accident of naming', async () => {
    // Both rosters contain 'moderator' and 'partner'. That is fine and expected — they are
    // different tables — but it is asserted so that nobody later "deduplicates" them into one.
    const keys = AQUIN_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(AQUIN_ADMIN_ROLE_KEYS.includes('learner')).toBe(false);
    expect(AQUIN_ADMIN_ROLE_KEYS.includes('guest')).toBe(false);
  });

  it('the module exposes no way to hand it an EduRankAI principal', async () => {
    // resolveAquinUser takes a TOKEN, not a user object. There is deliberately no overload that
    // accepts Astro.locals.user, because that is what a bridge would look like on the day somebody
    // adds one to save signing in twice.
    const store = memoryStore();
    const p = await resolveAquinUser(store, 'a-token-that-does-not-exist');
    expect(p.userId).toBe(null);
    expect(p.roles.includes('super_admin')).toBe(false);
  });
});
