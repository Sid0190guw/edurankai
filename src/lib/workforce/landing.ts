// src/lib/workforce/landing.ts — WHERE A SIGNED-IN PERSON BELONGS, asked in one place.
//
// THE OUTAGE THIS EXISTS TO PREVENT. /portal/index.astro used to read
// `if (user.role !== 'applicant') return Astro.redirect('/admin')` — a role value, not a right. The
// admin guard in src/middleware.ts then refused those people and sent them back to /portal, and the
// browser bounced between the two until it gave up with ERR_TOO_MANY_REDIRECTS. Every intern still
// carrying the 'editor' role from the offer-signing defect was caught in it and could not reach the
// portal at all. The fix that shipped was correct and is preserved here exactly: only send somebody to
// /admin if /admin will actually admit them, by asking the SAME function the door asks.
//
// WHY IT CANNOT LOOP — the proof, written out, because "it looked fine" is what took the site down.
//
//   1. /portal -> /admin fires if and only if canOpenAdmin(user).allowed === true.
//      /admin -> /portal fires (middleware.ts:353-369) if and only if canOpenAdmin(user).allowed === false.
//      One function, one user object (Astro.locals.user, set by that same middleware run), so the two
//      conditions are exact complements. At most one of them can be true. There is no input on which
//      both fire, therefore there is no cycle. This is the ONLY safe shape: two guards that each
//      decide with their own rule will eventually disagree, and disagreement between redirects is a
//      loop by definition.
//
//   2. /portal -> /portal/employee is terminal. employee.astro redirects on exactly one condition —
//      no signed-in user, to /portal/login — and never to /portal. Verified by reading it.
//
//   3. /portal -> /portal/employee/onboarding is the one arm that COULD cycle, and it is broken by
//      construction rather than by luck. onboarding.astro:11 bounces to /portal unconditionally when
//      its own employee lookup finds nothing, and its lookup is not the same predicate as
//      requireEmployee's: it does not consider work_email. A record matched only by work_email would
//      be found here and not there, and the two pages would volley forever. Nothing writes work_email
//      today, so the divergence set is empty — but "empty today" is not a guarantee, so the caller
//      passes `hop: true` on the second pass (see the cookie in portal/index.astro) and this function
//      then routes to /portal/employee, which is terminal. The cycle is bounded at one hop for any
//      divergence, present or future, known or not.
//
//   4. /portal -> /aquintutor/admin/{teacher|moderator|partner} is terminal for the people sent there.
//      Those pages redirect to /portal only when role === 'applicant', and this arm is unreachable for
//      an applicant: 'applicant' is not in AQUIN_PANELS and the arm is only taken by a role that is.
//
//   5. Nothing here redirects on an ERROR. A failed composition, a failed admin check or an
//      unrecognised state keeps the person exactly where they are. A guard that redirects when it does
//      not know the answer is a guard that redirects forever.
//
// WHAT THIS IS NOT. It is not a second authorization engine and it holds no policy of its own. Every
// arm below is answered by something that already existed: canOpenAdmin() for the console,
// composeWorkspace() for the employee record and the engagement, and AQUIN_PANELS for the partner
// scopes — the same table src/middleware.ts uses, imported rather than copied, so the landing and the
// door cannot come to disagree about where a teacher belongs.
//
// THE BRIEF'S ROLE LIST DOES NOT MAP TO THIS DATABASE, and pretending otherwise would be the failure
// this file is meant to avoid. userRoleEnum (src/lib/db/schema.ts:10-16) has no 'employee' role — an
// employee is an hr_employees row, an ENGAGEMENT, which is why the test below is hasEmployeeRecord and
// not a role. There is no 'finance' role ('finance' is an admin SECTION key) and no 'executive' role
// at all. HR, finance and executive all resolve to the same destination today because the admin
// console IS their workspace; when a dedicated one exists it becomes another arm here, and only here.
import type { WorkspaceUser } from '@/lib/auth/workspace-access';

/**
 * The AquinTutor scopes and their own panels. THE SINGLE COPY.
 *
 * src/middleware.ts:325-333 bounces any non-applicant WITHOUT admin.access off /admin and into one of
 * these; this module sends the same people there from /portal instead of leaving them on a portal
 * built for applicants, which is what happens today. Both import this map, so "where does a teacher
 * belong" has one answer. A role that is not here is not sent anywhere by this table.
 *
 * The fallback is 'partner' because that is what middleware has always done, and because the roles
 * without admin.access are exactly applicant, partner, teacher and technical_moderator — the first is
 * excluded by every caller, so the fallback is only ever reached by 'partner' itself. Keeping the
 * fallback rather than tightening it means this function answers identically to the line it replaces.
 */
export const AQUIN_PANELS: readonly { role: string; href: string }[] = [
  { role: 'teacher', href: '/aquintutor/admin/teacher' },
  { role: 'technical_moderator', href: '/aquintutor/admin/moderator' },
  { role: 'partner', href: '/aquintutor/admin/partner' },
];

const AQUIN_FALLBACK = '/aquintutor/admin/partner';

/** The panel this role's own console lives at. Never called for an applicant by any caller here. */
export function aquinPanelFor(role: string | null | undefined): string {
  const r = String(role || '').trim().toLowerCase();
  const hit = AQUIN_PANELS.find((p) => p.role === r);
  return hit ? hit.href : AQUIN_FALLBACK;
}

/** Is this a role that belongs in an AquinTutor panel rather than on the applicant portal? */
export function isAquinScope(role: string | null | undefined): boolean {
  const r = String(role || '').trim().toLowerCase();
  return AQUIN_PANELS.some((p) => p.role === r);
}

export type LandingReason =
  | 'not-signed-in'
  /** canOpenAdmin said yes. The admin console is the workspace for HR, finance and leadership today. */
  | 'admin-console'
  | 'employee-workspace'
  | 'employee-onboarding'
  /** Two employee records carry this address. The composer refuses to guess; the employee workspace
   *  is the only screen that can explain that in words. */
  | 'ambiguous-record'
  | 'aquintutor-panel'
  /** Stay here and render the applicant portal. */
  | 'applicant-portal'
  /** Something did not answer. Stay here — never redirect on an error. */
  | 'undecided';

export interface Landing {
  /** Null means "do not redirect": render the page the reader already asked for. */
  href: string | null;
  reason: LandingReason;
  /** True when the composition could not be trusted. The caller should not present a partial screen
   *  as a complete one. */
  degraded: boolean;
}

export interface LandingOptions {
  /** Astro.locals. Carries the per-request memo, so the composition costs one lookup for the whole page. */
  locals?: any;
  /**
   * Second pass through /portal after a bounce. Set by the caller from its one-shot cookie. When true
   * the onboarding arm is skipped and the person goes to /portal/employee, which is terminal. See the
   * loop proof at the top of this file, point 3.
   */
  hop?: boolean;
}

/**
 * Where does this person belong?
 *
 * Call it as the first await of /portal's frontmatter, above anything that renders and above any POST
 * handler — `const` is not hoisted, and a handler reaching a later declaration throws on its first
 * line while the page still reports success.
 *
 * COST, stated rather than hidden: one canOpenAdmin() call (one indexed query, and only for a
 * non-applicant) plus one composeWorkspace(), which is the employee lookup, the intern signals, the
 * permission set and a count of direct reports. That is roughly three queries more than the ad-hoc
 * hr_employees lookup it replaces. What it buys is that the landing decision and the workspace itself
 * resolve the same person the same way — the old lookup used a different predicate from
 * requireEmployee's and would happily pick one of two records where the composer refuses to guess.
 */
export async function resolveLanding(
  user: (WorkspaceUser & { role?: string | null }) | null | undefined,
  opts: LandingOptions = {},
): Promise<Landing> {
  if (!user?.id) {
    return { href: '/portal/login', reason: 'not-signed-in', degraded: false };
  }

  const role = String(user.role || '').trim().toLowerCase();

  // ---- 1. The admin console ------------------------------------------------------------------
  //
  // Asked with canOpenAdmin(), which is the function src/middleware.ts:354 asks for every /admin path
  // except the login screen. See the loop proof, point 1.
  //
  // The applicant skip is a COST guard and not a decision: middleware.ts:311 bounces every applicant
  // off /admin unconditionally, before canOpenAdmin is even consulted, so skipping the call cannot
  // land anybody anywhere they would have been admitted. It saves the registry lookup canOpenAdmin
  // pays for a role that is not on the allow list, on the busiest page in the product.
  if (role && role !== 'applicant') {
    try {
      const { canOpenAdmin } = await import('@/lib/auth/admin-access');
      const verdict = await canOpenAdmin(user as any);
      if (verdict.allowed) return { href: '/admin', reason: 'admin-console', degraded: false };
    } catch (e: any) {
      // Never loop on an error. If the check cannot run, they stay here.
      console.error('[workforce/landing] admin check failed', e?.cause?.message || e?.message);
    }
  }

  // ---- 2. The employee workspace ---------------------------------------------------------------
  //
  // composeWorkspace() is the single authority on whether this person has a workspace, and it is
  // imported dynamically so /portal does not pull the composer's module graph on a request that never
  // needs it (a signed-out visitor returns above).
  let composed: import('@/lib/workforce/composer').ComposedWorkspace | null = null;
  try {
    const { composeWorkspace } = await import('@/lib/workforce/composer');
    composed = await composeWorkspace(user as any, { locals: opts.locals, next: '/portal' });
  } catch (e: any) {
    console.error('[workforce/landing] compose failed', e?.cause?.message || e?.message);
    composed = null;
  }

  if (!composed) return { href: null, reason: 'undecided', degraded: true };

  // TWO RECORDS UNDER ONE ADDRESS. The composer refuses to guess between them, and that refusal is the
  // whole point — guessing hands one person another person's hours, leave and payslips. The applicant
  // portal cannot say any of that, and /portal/employee renders the composed denial verbatim, so that
  // is where they go. Terminal: employee.astro redirects only when there is no signed-in user.
  if (composed.reason === 'ambiguous-record') {
    return { href: '/portal/employee', reason: 'ambiguous-record', degraded: composed.degraded };
  }

  // A LOOKUP THAT DID NOT RUN IS NOT AN ANSWER. Stay put and let the page render what it can.
  if (composed.reason === 'lookup-failed') {
    return { href: null, reason: 'undecided', degraded: true };
  }

  if (composed.workspace) {
    const pending = String(composed.workspace.onboardingStatus || '').trim().toLowerCase() === 'pending';
    if (pending && !opts.hop) {
      return { href: '/portal/employee/onboarding', reason: 'employee-onboarding', degraded: composed.degraded };
    }
    return { href: '/portal/employee', reason: 'employee-workspace', degraded: composed.degraded };
  }

  // ---- 3. The AquinTutor scopes ------------------------------------------------------------------
  //
  // Below the employee arm on purpose: a teacher who is also on the payroll gets their own workspace,
  // not a partner console. Only reached by someone with no employee record at all.
  if (isAquinScope(role)) {
    return { href: aquinPanelFor(role), reason: 'aquintutor-panel', degraded: composed.degraded };
  }

  // ---- 4. The applicant portal --------------------------------------------------------------------
  // No redirect. This is the page they are already on.
  return { href: null, reason: 'applicant-portal', degraded: composed.degraded };
}
