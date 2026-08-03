// src/lib/auth/admin-access.ts — the ONE authoritative answer to "may this person open an admin surface?"
//
// WHY THIS EXISTS. Accepting an offer letter used to run `UPDATE users SET role = 'editor'`, and the
// editor role carries admin.access — so every intern who signed their offer could open /admin and
// read the applicant pipeline, employee records and every candidate's name. Three fixes shipped: the
// promotion was removed, AdminLayout refuses interns (intern-guard.ts), and /admin/users bulk-demotes
// on load. All three are patches on a model whose default answer was still ALLOW: a page was admin-
// safe because someone remembered to check, and a page written next month starts out unguarded.
//
// This module inverts that. The default answer is NO. A role opens the admin panel only by appearing
// on an ALLOW list DERIVED from the permission matrix (a role that actually holds admin.access), and
// an internship record refuses regardless of role — because the escalation began with a role value
// being wrong in the first place, and a second, independent signal is what stops one bad UPDATE from
// being enough. Read it with src/middleware.ts, which is what makes the answer unavoidable.
//
// IT FAILS CLOSED. If the employee lookup throws, this returns allowed:false. That is deliberate and
// it is the OPPOSITE of intern-guard.ts, which fails open on purpose because its job is narrow
// repair. This function's job is the gate itself, and a gate that opens when the database blinks is
// not a gate. The cost is real and should be understood: a database outage closes the admin console
// for everyone, including the founder. /admin/login is never gated, so nobody is locked out of
// signing in, and access returns the moment the database does.
//
// IT READS ALMOST NOTHING. Three columns off hr_employees, none of them sensitive. No `SELECT *`:
// gender, Aadhaar, PAN, bank and salary columns live on that table and an authorization check has no
// business pulling them into a request context, a log line or an error dump.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can, ROLE_LABELS } from '@/lib/auth/permissions';
import type { User } from '@/lib/db/schema';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the top because
// `const` is not hoisted and a handler reaching a later declaration has taken pages down here before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) => console.error(tag, e?.cause?.message || e?.message);

/**
 * Why the answer was what it was. Machine-readable on purpose: the caller logs it, and a log that
 * says only "denied" cannot tell a misconfigured account apart from a database outage.
 */
export type AdminAccessReason =
  | 'ok'
  | 'not-signed-in'
  | 'account-disabled'
  | 'role-not-admin-capable'
  | 'internship'
  | 'lookup-failed';

export interface AdminAccess {
  /** The only field that may be used to decide. Never infer access from `reason` or `role`. */
  allowed: boolean;
  reason: AdminAccessReason;
  /** The role as recorded on the account, for the log line. Null when nobody is signed in. */
  role: string | null;
  /**
   * The department key to scope later queries by, resolved SERVER-SIDE from the session:
   * users.assigned_department_id when set (the field the admin users console writes alongside the
   * department_head role), otherwise the department on the person's hr_employees row.
   *
   * Null means NO scope resolved, and null must never widen a query. Compare it as text — the key is
   * a varchar(50) slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql, and ::uuid throws on
   * a slug. See departmentFilter() in workspace-access.ts for the fragment that does this correctly.
   */
  department: string | null;
}

/**
 * The ALLOW LIST, derived rather than typed out.
 *
 * Every role the product knows about appears in ROLE_LABELS (typed `Record<User['role'], string>`, so
 * TypeScript refuses to compile a new role that has no label), and each one is asked the same
 * question the rest of the codebase asks: does it hold admin.access? Deriving it means the list
 * cannot drift from the permission matrix — grant admin.access to a new role in permissions.ts and it
 * appears here; take it away and it disappears. A hand-maintained copy would be one edit away from
 * silently disagreeing with the matrix, which is the class of bug that caused the escalation.
 *
 * Today this resolves to: super_admin, hr, recruiter, reviewer, department_head, marketing, editor.
 * `editor` is on it BECAUSE THE MATRIX SAYS SO — the internship check below is what actually keeps a
 * wrongly-promoted intern out, and it is why that check is not optional.
 */
export const ADMIN_CAPABLE_ROLES: ReadonlySet<string> = new Set(
  (Object.keys(ROLE_LABELS) as User['role'][])
    .filter((role) => can({ role, isActive: true } as User, 'admin.access'))
);

/**
 * Matches intern / interns / internship / interning at a word start, and deliberately NOT "Internal
 * Auditor" or "Internal Communications".
 *
 * THIS IS NOW THE ONLY FREE-TEXT INTERNSHIP TEST IN THE CODEBASE, which is what this comment used to
 * ask for. intern-guard.ts and workspace-access.ts each carried a plain `includes('intern')` that
 * also matched "Internal"; both now go through src/lib/auth/intern-signals.ts, which asks the
 * structured signals first and calls isInternshipRecord() below as its last arm. The door, the guard
 * and the workspace gate therefore judge these two columns identically — an "Internal Auditor" is no
 * longer admitted by one and demoted out of their role by another.
 *
 * Keep it here rather than moving it: this is the gate whose false positive is worst. Refusing an
 * internal-audit lead — or the founder — entry to the console that runs the company is a different
 * order of failure from showing somebody the wrong workspace, and the expression belongs beside the
 * check that cannot afford to be wrong.
 */
export const INTERNSHIP_PATTERN = /\bintern(?!al)/i;

/** True when an hr_employees row describes an internship (pure — safe to unit test). */
export function isInternshipRecord(employmentType: unknown, designation: unknown): boolean {
  // employment_type is free text written inconsistently ('Internship' from the HR edit form,
  // 'full_time' from the auto-hire path in src/lib/hr/sync.ts), so the designation is tested too: a
  // role titled "... Intern" is the same person however their engagement was recorded.
  return INTERNSHIP_PATTERN.test(String(employmentType || ''))
    || INTERNSHIP_PATTERN.test(String(designation || ''));
}

/** Satisfied by `Astro.locals.user` — the full drizzle users row, so there is no second user query. */
export interface AdminAccessUser {
  id?: string | null;
  email?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  assignedDepartmentId?: string | null;
}

function deny(reason: AdminAccessReason, role: string | null, department: string | null = null): AdminAccess {
  return { allowed: false, reason, role, department };
}

/**
 * May this user open an admin surface?
 *
 * Call it from src/middleware.ts (which already does, for every /admin path except /admin/login) and
 * from any API route or POST handler that must not be reachable by a URL the sidebar never offered.
 * It is one indexed query; resolve it once per request and pass the result down rather than calling
 * it per section.
 *
 * The order below is the policy, and it is cheapest-first on purpose: a denied role never reaches the
 * database at all.
 *   1. No session            -> denied.
 *   2. Deactivated account   -> denied, before any role is consulted.
 *   3. Role not on the ALLOW list -> denied. This is the deny-by-default step: a role that is new,
 *      misspelled, or written straight into the database by hand matches nothing and is refused.
 *   4. An internship record  -> denied, WHATEVER THE ROLE. Belt and braces for step 3, because the
 *      2026 escalation was precisely a role value being wrong.
 *   5. Lookup failed         -> denied. See the fail-closed note at the top of this file.
 */
export async function canOpenAdmin(user: AdminAccessUser | null | undefined): Promise<AdminAccess> {
  if (!user?.id) return deny('not-signed-in', null);

  const role = String(user.role || '').trim();
  // A deactivated account keeps its role, so this is checked separately and first — can() folds the
  // two together and would report the wrong reason in the log.
  if (user.isActive === false) return deny('account-disabled', role || null);
  // Two ways in, and only two.
  //
  //   1. A BUILT-IN role that holds admin.access in the compiled matrix.
  //   2. A CUSTOM role, created in the admin panel, explicitly granted admin.access in the registry.
  //
  // The second is what makes a new role work without a deploy — the whole point of the registry.
  // Without it, admin.access could be granted, recorded and audited while quietly doing nothing,
  // which is its own kind of lie: the console would say someone had access that they did not.
  //
  // It stays DENY BY DEFAULT. The registry is asked only after the built-in test fails, it resolves
  // to an empty set on any error, and the internship check below still runs afterwards — so a
  // custom grant cannot be used to hand the console to an intern. admin.access is also unreachable
  // through the section matrix (registry.ts filters it out in SQL), so it can only ever be granted
  // deliberately, by name, with an audit row naming who did it.
  if (!role || !ADMIN_CAPABLE_ROLES.has(role)) {
    let viaRegistry = false;
    try {
      const { hasPermission, PERM_ADMIN_ACCESS } = await import('@/lib/auth/registry');
      viaRegistry = await hasPermission(user.id, PERM_ADMIN_ACCESS);
    } catch (e: any) {
      // Fail closed: an unreadable registry denies, exactly as an unreadable HR record does.
      console.error('[admin-access] registry lookup failed', e?.cause?.message || e?.message);
      viaRegistry = false;
    }
    if (!viaRegistry) return deny('role-not-admin-capable', role || null);
  }

  // Session-derived, never request-derived. Used as the fallback scope when the person has no
  // employee record, so a department_head still resolves the department the admin console set.
  const assigned = String(user.assignedDepartmentId || '').trim() || null;
  const email = String(user.email || '').trim().toLowerCase();

  // The user -> employee link is NOT guaranteed: hr_employees.user_id is nullable and only
  // backfilled opportunistically, so a hire whose record predates their account is matched only by an
  // address on file. Matching on user_id alone would let exactly the accounts this guard exists for
  // slip past it. Compared case-insensitively, because an address is the same address however it was
  // typed into the HR form. The email arm is omitted entirely when there is no address, so an empty
  // string can never match a row with an empty column.
  // work_email is DECLARED in db/hr-schema.sql but does NOT EXIST on the production table. Naming it
  // here made this query throw, and because this guard fails closed, the throw denied /admin to
  // EVERY administrator including the founder — who then bounced to /portal and landed on the
  // onboarding page. A guard that cannot read its own input is a guard that locks out the building.
  //
  // Matching on user_id, personal_email and email is what AdminLayout has always used and is what
  // the live schema actually supports. The column is created below if a deployment ever lacks it, so
  // the two schemas converge instead of quietly disagreeing.
  const byEmail = email
    ? sql` OR lower(coalesce(personal_email, '')) = ${email}
           OR lower(coalesce(email, '')) = ${email}`
    : sql``;

  let found: any[];
  try {
    // Three columns plus the two status flags. Nothing sensitive: this table also holds gender,
    // aadhaar_number, pan_number, bank_* and base_salary, and none of them belong in an auth check.
    // LIMIT 5 because a person can have more than one row (a closed internship and a current
    // contract); five is enough to judge and bounds the cost of a check that runs on every request.
    found = rows(await db.execute(sql`
      SELECT employment_type, designation, department_id, is_active, employment_status
        FROM hr_employees
       WHERE (user_id = ${user.id}${byEmail})
       ORDER BY is_active DESC, created_at DESC
       LIMIT 5`));
  } catch (e: any) {
    logFail('[admin-access] employee lookup', e);
    return deny('lookup-failed', role, assigned);
  }

  // Judge on the CURRENT engagement. Deactivation writes both flags (the admin action sets is_active
  // and employment_status together), so both are checked, and anything other than an explicit
  // 'inactive' counts as working so a value like 'probation' is not read as a closed record.
  // An intern later hired full-time therefore passes: their internship row is closed, the live one is
  // not. If nothing is active, the closed rows are judged instead — someone with no current
  // engagement holding an admin role is exactly who should be refused.
  const isLive = (r: any) => r?.is_active === true
    && String(r?.employment_status || 'active').trim().toLowerCase() !== 'inactive';
  const live = found.filter(isLive);
  const considered = live.length > 0 ? live : found;

  // ANY current internship refuses. Someone recorded as both an intern and something else is refused,
  // which is the safe direction: the console shows the whole applicant pipeline and every employee
  // record, and there is no partial version of that to fall back to.
  if (considered.some((r) => isInternshipRecord(r?.employment_type, r?.designation))) {
    return deny('internship', role, assigned);
  }

  const ownDepartment = considered.length > 0 && considered[0].department_id !== null && considered[0].department_id !== undefined
    ? String(considered[0].department_id).trim() || null
    : null;

  return { allowed: true, reason: 'ok', role, department: assigned || ownDepartment };
}
