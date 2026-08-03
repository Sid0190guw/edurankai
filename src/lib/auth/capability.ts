// src/lib/auth/capability.ts — THE ONE PLACE THAT ANSWERS "does this account hold a capability?".
//
// WHY THIS FILE EXISTS. Two byte-for-byte identical copies of this function were live:
// holdsCapability() in src/lib/auth/workspace-access.ts and holdsHrCapability() in
// src/lib/hr-wallet.ts. The second carried a comment saying the duplication was deliberate, "so the
// HR money path has no dependency on the workspace module", and ending "if they are ever
// consolidated, consolidate them deliberately and together." This is that consolidation.
//
// The stated reason for the split was a dependency concern, not a policy one, and it is answered by
// where the shared copy lives rather than by keeping two: this module imports src/lib/auth/permissions
// and NOTHING else, so the HR money path still does not reach the workspace module. What it no longer
// does is carry its own copy of the adaptation rules — two copies of one rule is the drift this
// migration exists to remove, and both copies were already one edit away from disagreeing about what
// `isActive` means.
//
// NOTHING HERE CHANGES WHO MAY DO WHAT. The function body is the same expression both copies had.
import { can, PERMS_BY_ROLE, type Permission } from '@/lib/auth/permissions';
import type { User } from '@/lib/db/schema';

/** Satisfied by `Astro.locals.user`, and by any narrower object carrying a role. */
export interface CapabilityUser {
  role?: string | null;
  /** users.is_active. Read as "not explicitly false" — see the note on holdsCapability(). */
  isActive?: boolean | null;
}

/**
 * DOES THIS ACCOUNT HOLD A CAPABILITY? The only way any module may ask about standing authority.
 *
 * `can()` is the pure, database-free test over PERMS_BY_ROLE, and it is deliberately the one used
 * here rather than the registry's resolvePermissions(): the registry adds the super_admin WILDCARD
 * and every custom-role grant, so asking IT for 'department.lead' would answer true for the founder
 * and for any admin-created role that had been handed the key — widening gates that today admit
 * exactly one role each. This migration changes the mechanism and must not touch the policy.
 *
 * `key` is typed `Permission`, so a permission string outside the union fails to COMPILE. An invented
 * key silently answers false for every role including super_admin, which is how a whole console
 * became unreachable on this project once already.
 *
 * TWO ADAPTATIONS, both preserving exactly what the role comparisons this replaced did:
 *   - the role is trimmed and lowercased, because every test replaced by a capability was written
 *     against `String(user.role || '').trim().toLowerCase()`;
 *   - `isActive` is read as "not explicitly false". can() denies an inactive account, and the tests
 *     this replaced looked at the role alone. The difference is unreachable through every path that
 *     exists — validateSessionToken() deletes the session and returns null for a deactivated account
 *     (src/lib/auth/session.ts:59-62), so a signed-in user is an active one — but a caller handing
 *     over a narrower object than Astro.locals.user must keep the access it had, not lose it to a
 *     field it never carried.
 */
export function holdsCapability(user: CapabilityUser | null | undefined, key: Permission): boolean {
  if (!user) return false;
  return can(
    { role: String(user.role || '').trim().toLowerCase(), isActive: user.isActive !== false } as unknown as User,
    key,
  );
}

/**
 * WHICH BUILT-IN ROLES HOLD THIS CAPABILITY, derived from PERMS_BY_ROLE rather than typed out.
 *
 * For the ONE case where the decision genuinely cannot leave SQL: src/lib/employee-tasks.ts decides
 * which task rows a viewer may read inside the WHERE clause, on purpose, so a row the viewer may not
 * see is never fetched. A capability cannot be evaluated in Postgres, so the fragment has to name
 * roles — and naming them by hand is exactly the hardcoded role check this migration removes. This
 * derives the list from the matrix instead, so a grant added or removed in permissions.ts moves the
 * SQL with it.
 *
 * HONEST LIMIT, and it is why this is not offered as a general-purpose helper: it reads the compiled
 * matrix ONLY. A CUSTOM role granted the same key through the registry is invisible to it, exactly as
 * it is invisible to can(). That matches the population every converted call site has today; it is
 * not a claim that the two systems agree in general.
 *
 * Returned lowercase, because every SQL comparison in this codebase lowercases users.role before
 * matching it (`lower(lu.role::text)`), and the enum values are lowercase already.
 */
export function rolesHolding(key: Permission): string[] {
  return (Object.keys(PERMS_BY_ROLE) as User['role'][])
    .filter((role) => (PERMS_BY_ROLE[role] || []).includes(key))
    .map((role) => String(role).trim().toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// THE APPROVAL AUTHORITY, in one expression instead of four.
// ---------------------------------------------------------------------------------------------

/**
 * The standing authority approverRole() is asked about. Named as a type so a caller cannot pass
 * `'leave.edit'` or a hand-typed string that nothing grants: inventing a permission string outside
 * the Permission union is what made an entire console unreachable for every role on this project.
 *
 * Two members, because approving time off and approving money are two different powers held by the
 * same people today. Asking with the wrong one would be silently correct right now and silently
 * wrong the day either grant moves — so each caller names its own.
 */
export type ApprovalCapability = Extract<Permission, 'leave.approve' | 'payouts.approve'>;

/** Both approval powers, in a fixed order, so "either" has one definition rather than four. */
export const APPROVAL_CAPABILITIES: readonly ApprovalCapability[] = ['leave.approve', 'payouts.approve'];

/**
 * MAY THIS PERSON DECIDE EVERY REQUEST OF THIS KIND, regardless of who raised it?
 *
 * One rule that had FOUR implementations before this commit, listed here so the collapse is checkable:
 *   - src/lib/workforce/composer.ts seesEveryRequest      (decides whether the approvals CARD shows)
 *   - src/lib/hr-leave.ts pendingLeaveForApprover         (which leave requests are LISTED)
 *   - src/lib/hr-wallet.ts pendingWithdrawalsForApprover  (which withdrawals are LISTED)
 *   - src/lib/hr-wallet.ts approverRole                   (what may be DONE — the enforcement)
 * All four already asked capabilities and therefore agreed; four expressions of one rule is still
 * four chances to stop agreeing, and composer.ts said so in its own comment. There is now one.
 *
 * Omit `capability` to ask "either power" — the composer's question, because one flag gates two
 * widgets. Name one to ask about that power alone, which is what each list and the enforcement do.
 *
 * THIS IS NOT THE WHOLE OF WHO MAY APPROVE, and must never be treated as if it were. An employee's
 * own reporting manager may decide THAT employee's request without holding either key. That is a
 * RELATIONSHIP to one person, resolved per ROW against hr_employees.reporting_manager_id in
 * approverRole(), and no capability may stand in for it: granting a key to "cover managers" would
 * hand every manager authority over every employee — the widest policy change available in this area.
 */
export function decidesEveryRequest(
  user: CapabilityUser | null | undefined,
  capability?: ApprovalCapability,
): boolean {
  const keys = capability ? [capability] : APPROVAL_CAPABILITIES;
  return keys.some((key) => holdsCapability(user, key));
}

// ---------------------------------------------------------------------------------------------
// THE TEAM-LEAD RULE, in one expression instead of three.
// ---------------------------------------------------------------------------------------------

/**
 * DOES THIS PERSON LEAD A DEPARTMENT? Capability plus one per-PERSON condition.
 *
 * Three copies existed and they already disagreed. The two in TypeScript —
 * workspace-access.requireTeamLead() and workforce/composer.leadsDepartment() — both asked
 * 'department.lead' AND refused an internship engagement, in two separately written expressions;
 * they now both call this. The third, employee-tasks.isLeadSql(), lives in a WHERE clause, compares
 * the role name directly and applies NO internship refusal at all. That third one is a live
 * divergence which this function cannot fix, and it is reported rather than papered over — see the
 * comment on isLeadSql() in src/lib/employee-tasks.ts.
 *
 * WHY THE INTERNSHIP CONDITION IS A PARAMETER AND NOT A LOOKUP. It is a fact about an hr_employees
 * ROW, resolved by src/lib/auth/intern-signals.ts from data the caller has already read. Reading it
 * again here would be a third query per request and a fourth place that could answer differently.
 * `undefined`/`null` mean "not resolved", and are treated as NOT an internship — which is exactly
 * what both callers did before: a person with no employee record at all (a founder, an HR account)
 * has always passed the engagement test, and must keep passing it.
 *
 * 'department.lead' is a SCOPE, not a rank: it says which single department you are confined to, and
 * super_admin deliberately does not hold it. See the block above PERMS_BY_ROLE in permissions.ts.
 */
export function leadsDepartment(
  user: CapabilityUser | null | undefined,
  engagement: { isIntern?: boolean | null } | null | undefined,
): boolean {
  if (engagement?.isIntern === true) return false;
  return holdsCapability(user, 'department.lead');
}
