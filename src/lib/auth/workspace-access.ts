// src/lib/auth/workspace-access.ts — the gate every personal workspace surface runs FIRST.
//
// WHY THIS EXISTS. /admin was built as one console for the super admin, and an automatic role
// promotion handed it to every intern who signed an offer: 'editor' carries admin.access, so they
// could read the applicant pipeline, employee records and candidate names. The promotion is gone and
// interns are blocked from /admin (see intern-guard.ts) — but blocking is only half of it. The other
// half is the interface they should have had all along: one that shows them THEIR OWN work, a team
// lead THEIR OWN department, and nobody anybody else's.
//
// WHAT THIS MODULE GUARANTEES, and the reason it is a module rather than a copied block:
//
//   1. THE SCOPE KEY COMES FROM THE SESSION. `employeeId` and the department key are resolved here
//      from Astro.locals.user and nowhere else, and are handed back as SQL fragments
//      (employeeFilter / departmentFilter) so the narrowing happens IN THE WHERE CLAUSE. Nothing the
//      browser sends — no ?employee=, no ?department=, no hidden form field — may ever decide whose
//      rows come back. Filtering after the query is not scoping; the row has already been read by
//      then. src/pages/admin/users/[id].astro:14-21 is the shape to avoid: it SELECTs the target
//      first and redirects afterwards.
//
//   2. IT FAILS CLOSED, AND IT EXPLAINS. No linked record and no resolvable scope means no data,
//      returned as a denial carrying a heading and a calm sentence a person can act on — not an
//      empty dashboard that reads as "you have done no work" or "your team has 0 members". Every
//      denial says what is missing and who fixes it. On a denial the workspace is ALWAYS null, so a
//      page that forgets to check `ok` renders nothing rather than leaking what it was refused.
//
//   3. IT READS ONLY WHAT A WORKSPACE NEEDS. The employee lookups already in the portal do
//      `SELECT *`, which drags gender, Aadhaar, PAN and bank details into the render context of a
//      page that shows none of them. `gender` is the exact column read in the 2026-08-02 breach.
//      This selects an explicit list instead, so nothing sensitive is ever in scope to leak into a
//      log line, an error dump or a careless template edit.
//
//   4. NOTHING IS CACHED AT MODULE SCOPE. A cache in a long-lived server process is how one person's
//      workspace ends up rendered for another. Resolve once per request and pass the result down.
//
// NEVER FROM A SURFACE BEHIND THIS GATE: any wellness_* table (src/lib/wellness.ts is women-only,
// gated, and aggregate-only by design, with no "read any user's log" helper — that absence is the
// feature), hr_employees.gender, and hr_clock_events for anyone but the signed-in person — it stores
// GPS, IP, device and a selfie per punch. A lead who needs attendance reads hr_attendance
// (status + hours), never the punch log.
import { db } from '@/lib/db';
import { sql, type SQL } from 'drizzle-orm';
import { holdsCapability, leadsDepartment } from '@/lib/auth/capability';
import { resolveIsIntern } from '@/lib/auth/intern-signals';

// postgres-js resolves to a plain array, never a { rows } object. Declared before everything that
// uses it: `const` is not hoisted, and a handler reaching a later declaration has taken pages down
// in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) => console.error(tag, e?.cause?.message || e?.message);

const asText = (v: any): string | null => (v === null || v === undefined ? null : String(v));
const asDate = (v: any): string | null => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.slice(0, 10) || null;
};

/** Satisfied by `Astro.locals.user` — the full drizzle users row, so no second query for the role. */
export interface WorkspaceUser {
  id?: string | null;
  email?: string | null;
  role?: string | null;
  assignedDepartmentId?: string | null;
  /** users.is_active. Read only by holdsCapability() — see the note there about why it is optional. */
  isActive?: boolean | null;
}

/**
 * DOES THIS ACCOUNT HOLD A CAPABILITY? Re-exported, NOT reimplemented.
 *
 * The body used to live here, and a byte-for-byte copy of it lived in src/lib/hr-wallet.ts as
 * holdsHrCapability(). One rule, two implementations, each free to drift on the next edit. There is
 * now exactly one, in src/lib/auth/capability.ts, and both modules import it.
 *
 * The name and signature are kept so every existing caller — inside this file and in
 * src/lib/workforce/composer.ts — is unchanged. Nothing about who holds what has moved.
 */
export { holdsCapability, leadsDepartment };

export interface WorkspaceDepartment {
  /** Opaque string. departments.id is varchar(50) (a slug) in src/lib/db/schema.ts:81 and UUID in
   *  db/hr-schema.sql:32, whose own header says the live types win. Compared as text, never ::uuid —
   *  the cast would throw on a slug and take the page down. */
  id: string;
  /** Null when the key points at no departments row. A missing label is not a missing permission. */
  name: string | null;
}

/** Identity and engagement only — no gender, no government IDs, no bank details, no salary. */
export interface Workspace {
  /** hr_employees.id — the ONLY value a personal query may be filtered by. Every hr_* table is keyed
   *  by employee_id, never by user_id. */
  employeeId: string;
  fullName: string;
  employeeCode: string | null;
  designation: string | null;
  employmentType: string | null;
  employmentStatus: string | null;
  onboardingStatus: string | null;
  workMode: string | null;
  joiningDate: string | null;
  probationEndDate: string | null;
  confirmationDate: string | null;
  photoUrl: string | null;
  /** The person's OWN department, off hr_employees. Display only — it never grants scope.
   *  Null for anyone added by hand: the manual add and edit forms never write department_id. */
  department: WorkspaceDepartment | null;
  /** The department a TEAM LEAD may query, from users.assigned_department_id only. See isTeamLead. */
  scopeDepartmentId: string | null;
  isIntern: boolean;
  isTeamLead: boolean;
  isHr: boolean;
  /** False = offboarded or deactivated. Both flags are checked; the admin action writes both. */
  isActive: boolean;
}

export type WorkspaceDenial =
  | 'not-signed-in'
  | 'no-employee-record'
  | 'ambiguous-record'
  | 'inactive'
  | 'not-an-intern'
  | 'not-a-team-lead'
  | 'no-department'
  | 'not-hr'
  | 'lookup-failed';

interface GateOk {
  ok: true;
  scopeDepartmentId: string | null;
  code: null;
  title: null;
  reason: null;
  redirect: null;
}
interface GateDenied {
  ok: false;
  workspace: null;
  scopeDepartmentId: null;
  code: WorkspaceDenial;
  /** A heading a person can read without being told what a foreign key is. */
  title: string;
  /** What is missing and who fixes it. Never a bare "access denied". Render this. */
  reason: string;
  /** Set only when sending them somewhere beats explaining — i.e. they are not signed in. */
  redirect: string | null;
}

/** Result of requireTeamLead / requireHr: authority is the ROLE, so the workspace may be null. */
export type WorkspaceGate = (GateOk & { workspace: Workspace | null }) | GateDenied;
/** Result of requireEmployee / requireIntern: on ok the workspace is guaranteed. */
export type SelfGate = (GateOk & { workspace: Workspace }) | GateDenied;

function deny(code: WorkspaceDenial, title: string, reason: string, redirect: string | null = null): GateDenied {
  return { ok: false, workspace: null, scopeDepartmentId: null, code, title, reason, redirect };
}

/**
 * hr_employees.department_id is written by exactly ONE code path — src/lib/hr/sync.ts:62-77, which
 * copies roles.department_id when an application turns 'hired'. The manual "Add employee" form and
 * the edit form never touch it and have no field for it, so anyone added by hand has it NULL
 * permanently and cannot appear in ANY department-scoped list. Returning nothing for them is the
 * correct fail-closed behaviour, but a lead must be TOLD, or a short list reads as a complete one.
 * Render this under every list built with departmentFilter().
 */
export const DEPARTMENT_COVERAGE_NOTICE =
  'Only people whose department has been recorded appear here. Records created by hand do not have one yet, so this list can be shorter than your team. Ask HR to set the department on anyone missing.';

// Identity and engagement columns only. Adding gender, pan_number, aadhaar_number, bank_* or
// base_salary to this list re-creates the 2026-08-02 exposure — no workspace surface needs them.
const EMPLOYEE_COLUMNS = sql`
  id, employee_code, full_name, designation, department_id,
  employment_type, employment_status, onboarding_status, work_mode,
  joining_date, probation_end_date, confirmation_date, photo_url, is_active`;

/**
 * 'none' (there is genuinely no record) and 'failed' (the query did not run) are kept apart on
 * purpose. Both fail closed and show nothing, but they are DIFFERENT SENTENCES to the person
 * reading the screen: telling someone to go and ask HR to link their record, when in truth the
 * database blinked, sends them to a colleague to solve a problem that does not exist.
 */
type WorkspaceLookup =
  | { status: 'ok'; workspace: Workspace }
  | { status: 'none' | 'failed' | 'ambiguous'; workspace: null };

/**
 * The two STRUCTURED intern signals, for one employee. Read separately from the identity lookup
 * above, and on purpose.
 *
 * `classification`, `classification_reviewed_at` and `application_id` are all self-bootstrapped by
 * other modules (src/lib/hr-classification.ts:15-19, src/lib/hr/sync.ts), which on this project is
 * the declared-but-not-existing class that has taken five surfaces down in a week. Folding them into
 * EMPLOYEE_COLUMNS would mean a missing column throws the identity query and every portal page
 * reports "no employee profile found". Here a failure costs the two structured arms and nothing
 * else: resolveIsIntern() falls through to the substring test, which is exactly today's answer.
 *
 * COST, stated rather than hidden: one extra single-row indexed lookup per workspace resolution, on
 * every surface behind this gate. It cannot be made conditional — the structured arms can both add
 * an intern the substring test misses and remove one it wrongly claims, so the answer is never known
 * in advance.
 */
async function internSignals(employeeId: string): Promise<{
  classification: string | null;
  classificationReviewedAt: string | null;
  seniority: string | null;
}> {
  const none = { classification: null, classificationReviewedAt: null, seniority: null };
  if (!employeeId) return none;
  try {
    // roles.level is reachable ONLY through hr_employees.application_id, which the manual "Add
    // employee" form does not write — so seniority is null for anyone HR added by hand, and the rule
    // degrades to the arms below it rather than treating null as a "no".
    const sig = rows(await db.execute(sql`
      SELECT e.classification, e.classification_reviewed_at, ro.level AS seniority
        FROM hr_employees e
        LEFT JOIN applications a ON a.id = e.application_id
        LEFT JOIN roles ro ON ro.id = a.role_id
       WHERE e.id = ${employeeId}
       LIMIT 1`))[0];
    if (!sig) return none;
    return {
      classification: asText(sig.classification),
      classificationReviewedAt: asText(sig.classification_reviewed_at),
      seniority: asText(sig.seniority),
    };
  } catch (e: any) {
    logFail('[workspace-access] intern signals', e);
    return none;
  }
}

async function lookupWorkspace(user: WorkspaceUser | null | undefined): Promise<WorkspaceLookup> {
  if (!user?.id) return { status: 'none', workspace: null };

  // A CAPABILITY, NOT A ROLE NAME. This was `role === 'hr' || role === 'super_admin'`, and those two
  // roles are exactly — and only — the ones PERMS_BY_ROLE grants 'employee.manage' to, so the set
  // of people this admits is unchanged. What changes is that the question is now "may you manage
  // employee records?" instead of "are you called HR?", which is the question the enforcement can
  // still answer after somebody adds the twelfth role. src/lib/hr-wallet.ts:151 asked the old
  // question as `role.indexOf('hr') >= 0` and handed approval rights to any role merely CONTAINING
  // those two letters. ('admin' is not a value of the user_role enum, so the branch testing for it
  // in hr-wallet.ts:150 is dead and is not reproduced as a grant.)
  //
  // The key was spelled `employees.manage` until the capability vocabulary was reconciled to the
  // singular canonical form. Same two roles, same answer for every account; only the spelling moved.
  const isHr = holdsCapability(user, 'employee.manage');

  // THE ONLY WORKING TEAM-LEAD SIGNAL IN THIS DATABASE, and the reason it is a DEPARTMENT and not a
  // list of reports. hr_employees.reporting_manager_id is declared at db/hr-schema.sql:55 and read
  // by zero lines of application code, so it is NULL for every row — a screen built on it would show
  // nobody. hr-wallet.ts:153-156 probes `reporting_manager_user_id` / `manager_user_id`, neither of
  // which exists on the table, inside a wrapper that swallows the error, so its 'reporting_manager'
  // branch has never once returned true. Both are unusable and neither is used here.
  // What DOES exist and IS populated is users.assigned_department_id, written by the admin users
  // console (src/pages/admin/users.astro:40 and :216) alongside the 'department_head' role. That
  // pair is the entire mechanism. When a real manager link is populated, it belongs here, next to
  // this comment, and not copied into a page.
  //
  // 'department.lead' is held by department_head and by NOBODY else — not even super_admin, which is
  // deliberate and is written out in permissions.ts above the matrix: the key is a SCOPE (one
  // department) rather than a rank, so granting it to the founder would confine them instead of
  // widening anything. Same single role as `role === 'department_head'` admitted before.
  const isTeamLead = holdsCapability(user, 'department.lead');
  const scopeDepartmentId = isTeamLead ? (String(user.assignedDepartmentId || '').trim() || null) : null;

  const email = String(user.email || '').trim().toLowerCase();
  let row: any = null;

  try {
    // Primary link, on the indexed column.
    row = rows(await db.execute(sql`
      SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees WHERE user_id = ${user.id} LIMIT 1`))[0] || null;

    // Fallback across all three email columns: the user -> employee link is NOT guaranteed. user_id
    // is nullable and only backfilled opportunistically, so a hire created before their account
    // existed is matched only by an address on file. Matching on user_id alone locks them out of
    // their own record. Compared case-insensitively, because an address is the same address however
    // it was typed into the HR form.
    if (!row && email) {
      // LIMIT 2, not 1, and the reason is the check immediately below.
      const matches = rows(await db.execute(sql`
        SELECT ${EMPLOYEE_COLUMNS} FROM hr_employees
         WHERE lower(work_email) = ${email} OR lower(personal_email) = ${email} OR lower(email) = ${email}
         ORDER BY is_active DESC, created_at DESC
         LIMIT 2`));

      // TWO PEOPLE ON FILE UNDER ONE ADDRESS: REFUSE, NEVER PICK.
      //
      // This fallback is the single point in the whole design where the scope key is derived from
      // something softer than an id, so it is the one place a wrong answer is possible at all. An
      // address is not unique here: hr_employees carries THREE email columns, no unique constraint
      // sits on any of them, and both a shared inbox typed into `email` and a manager's address
      // entered on a subordinate's record produce two matches. `ORDER BY ... LIMIT 1` would then
      // quietly hand whoever signs in first the other person's hours, leave, reviews, documents and
      // credit position — and the backfill below would stamp user_id onto that row and make the
      // mistake permanent and invisible.
      //
      // Refusing costs a real employee one message to HR. Guessing costs a different employee their
      // privacy, silently, with no way for either of them to notice.
      if (matches.length > 1) return { status: 'ambiguous', workspace: null };
      row = matches[0] || null;

      // Backfill so the next request takes the indexed path. Best-effort, and guarded on
      // user_id IS NULL so it can never re-point somebody else's record at this account.
      if (row) {
        await db.execute(sql`
          UPDATE hr_employees SET user_id = ${user.id}
           WHERE id = ${row.id} AND user_id IS NULL`)
          .catch((e: any) => logFail('[workspace-access] backfill', e));
      }
    }
  } catch (e: any) {
    logFail('[workspace-access] employee lookup', e);
    return { status: 'failed', workspace: null };
  }

  if (!row) return { status: 'none', workspace: null };

  // The department NAME is a label, not a permission. It is looked up separately and allowed to
  // fail: losing the whole page because a name could not be read would be the wrong failure, and a
  // join would also have to survive the varchar/UUID conflict on departments.id.
  const departmentId = row.department_id === null || row.department_id === undefined
    ? null
    : String(row.department_id).trim() || null;
  let departmentName: string | null = null;
  if (departmentId) {
    try {
      const d = rows(await db.execute(sql`
        SELECT name FROM departments WHERE id::text = ${departmentId} LIMIT 1`))[0];
      departmentName = d?.name ? String(d.name) : null;
    } catch (e: any) {
      logFail('[workspace-access] department', e);
    }
  }

  // WHO IS AN INTERN — asked in order, and no longer asked here at all.
  //
  // This used to be a bare substring test on employment_type and designation, duplicated verbatim in
  // intern-guard.ts. employment_type is free text written inconsistently ('Internship' from the HR
  // edit form, 'full_time' for EVERY hire from the auto-hire path at hr/sync.ts:72), so designation
  // was tested too — and a designation like "Internal Auditor" then matched. Both copies are gone:
  // src/lib/auth/intern-signals.ts holds the one ordered rule, and the guard that BLOCKS interns from
  // /admin now imports the same function as this gate, which GIVES them their own screen. They can no
  // longer disagree about who is an intern, because there is nothing left to disagree with.
  //
  // The substring test is still in there, as the LAST arm — it is the only signal a hand-added record
  // carries. What is new is that two structured values are asked first.
  const employmentType = asText(row.employment_type);
  const designation = asText(row.designation);
  const isIntern = resolveIsIntern({
    ...(await internSignals(String(row.id))),
    employmentType,
    designation,
  });

  // Deactivation writes both flags (src/pages/admin/hr/employees/index.astro:67), so both are
  // checked. Anything other than an explicit 'inactive' counts as working, so a value like
  // 'probation' does not lock a real employee out of their own attendance.
  const status = String(row.employment_status || 'active').trim().toLowerCase();
  const isActive = row.is_active === true && status !== 'inactive';

  return {
    status: 'ok',
    workspace: {
      employeeId: String(row.id),
      fullName: String(row.full_name || ''),
      employeeCode: asText(row.employee_code),
      designation,
      employmentType,
      employmentStatus: asText(row.employment_status),
      onboardingStatus: asText(row.onboarding_status),
      workMode: asText(row.work_mode),
      joiningDate: asDate(row.joining_date),
      probationEndDate: asDate(row.probation_end_date),
      confirmationDate: asDate(row.confirmation_date),
      photoUrl: asText(row.photo_url),
      department: departmentId ? { id: departmentId, name: departmentName } : null,
      scopeDepartmentId,
      isIntern,
      isTeamLead,
      isHr,
      isActive
    }
  };
}

/**
 * Resolve who this person is and what they may see.
 *
 * Returns null when nobody is signed in, when no employee record can be matched, or when the lookup
 * fails — all three mean "no data", which is the safe answer for a caller that just wants the
 * workspace. Callers that must EXPLAIN the difference to a human use the require* gates below.
 *
 * Call it as the first statement of the frontmatter, above the POST handler, so a write can never
 * run unscoped — and once per request: nothing here is cached, and it is a query.
 */
export async function resolveWorkspace(user: WorkspaceUser | null | undefined): Promise<Workspace | null> {
  return (await lookupWorkspace(user)).workspace;
}

/**
 * The person's own workspace: an active employee record, whatever their role. The base gate for any
 * screen that shows somebody their own attendance, leave, credit hours or payslips.
 *
 * @param next Where to return after login, for the not-signed-in redirect.
 */
export async function requireEmployee(
  user: WorkspaceUser | null | undefined,
  next = '/portal/employee'
): Promise<SelfGate> {
  if (!user?.id) {
    return deny('not-signed-in', 'Please sign in',
      'Your workspace shows your own record, so it needs you signed in.',
      '/portal/login?next=' + encodeURIComponent(next));
  }

  let found: WorkspaceLookup;
  try {
    found = await lookupWorkspace(user);
  } catch (e: any) {
    // lookupWorkspace already fails closed on its own errors; this catches anything it could not.
    logFail('[workspace-access] requireEmployee', e);
    found = { status: 'failed', workspace: null };
  }

  if (found.status === 'failed') {
    return deny('lookup-failed', 'We could not load your record just now',
      'Something went wrong reading your employee record. Nothing you have logged is lost. Try again in a moment, and tell HR if it keeps happening.');
  }
  // Told plainly, because the fix is HR's and the person can name it in one sentence. Showing one
  // of the two records instead would be showing somebody else's work to somebody who is not them.
  if (found.status === 'ambiguous') {
    return deny('ambiguous-record', 'More than one employee record uses your email address',
      'We will not guess which one is yours, because the wrong guess would show you another person\'s record. Ask HR to leave your address on your record only, then reload this page.');
  }
  const ws = found.workspace;
  if (!ws) {
    return deny('no-employee-record', 'No employee record is linked to this account',
      'Your workspace appears once HR links your employee record to this sign-in. Ask HR to link it to the address you signed in with.');
  }
  if (!ws.isActive) {
    return deny('inactive', 'Your employee record is closed',
      'This record is no longer active, so there is nothing to show here. If that is not right, ask HR to check it.');
  }
  return { ok: true, workspace: ws, scopeDepartmentId: ws.scopeDepartmentId, code: null, title: null, reason: null, redirect: null };
}

/**
 * An intern, on their own data. Requires the employee record: every hr_* table is keyed by
 * employee_id, so an intern surface without one has nothing to scope to.
 *
 * Scope every query with employeeFilter(gate.workspace).
 */
export async function requireIntern(
  user: WorkspaceUser | null | undefined,
  next = '/portal/employee'
): Promise<SelfGate> {
  const gate = await requireEmployee(user, next);
  if (!gate.ok) return gate;
  if (!gate.workspace.isIntern) {
    return deny('not-an-intern', 'This screen is for interns',
      'Your engagement is not recorded as an internship. Your own workspace is at /portal/employee.');
  }
  return gate;
}

/**
 * A team lead, on their own department — never another department, and never a named list of people
 * they simply know.
 *
 * Deliberately does NOT require an hr_employees record: the authority is entirely
 * users.role + users.assigned_department_id, so demanding an employee row would lock out a lead
 * whose record HR has not created yet WITHOUT narrowing what they can see by a single row. The
 * workspace is returned when it exists, for their own identity on the page, and may be null.
 *
 * Scope with departmentFilter(gate) — the gate carries the key, so it works either way — and render
 * DEPARTMENT_COVERAGE_NOTICE beside the result.
 */
export async function requireTeamLead(
  user: WorkspaceUser | null | undefined,
  next = '/portal/team'
): Promise<WorkspaceGate> {
  if (!user?.id) {
    return deny('not-signed-in', 'Please sign in',
      'This screen shows your department, so it needs you signed in.',
      '/portal/login?next=' + encodeURIComponent(next));
  }

  let ws: Workspace | null = null;
  try {
    ws = await resolveWorkspace(user);
  } catch (e: any) {
    logFail('[workspace-access] requireTeamLead', e);
    return deny('lookup-failed', 'We could not load your department just now',
      'Something went wrong resolving what you lead. Try again in a moment, and tell HR if it keeps happening.');
  }

  // An intern is never a team lead, whatever else the account says. The engagement test is
  // per-PERSON and survives the conversion: 'department.lead' says which department you are confined
  // to, never that you are not an intern.
  //
  // THE RULE IS NO LONGER WRITTEN HERE. It was `ws?.isIntern || !holdsCapability(user,
  // 'department.lead')`, and workforce/composer.ts leadsDepartment carried a second, separately
  // written expression of the same two conditions. Both now call leadsDepartment() in
  // src/lib/auth/capability.ts. `ws` is null for anyone with no employee record, and
  // `isIntern: undefined` is treated there as NOT an internship — which is precisely what
  // `ws?.isIntern` evaluated to here, so the population is identical.
  if (!leadsDepartment(user, ws)) {
    return deny('not-a-team-lead', 'This screen is for team leads',
      'You are not recorded as leading a department. Your own workspace is at /portal/employee.');
  }
  if (ws && !ws.isActive) {
    return deny('inactive', 'Your employee record is closed',
      'This record is no longer active, so department data is closed with it. If that is not right, ask HR to check it.');
  }

  // Fail closed WITH an explanation. An unset department is the common case for a lead HR has not
  // finished setting up, and "0 people" would be a lie about their team.
  const scope = String(user.assignedDepartmentId || '').trim();
  if (!scope) {
    return deny('no-department', 'No department is recorded for you yet',
      'A lead screen shows one department, and yours has not been set. Ask HR to set the department on your account, then reload this page.');
  }

  return { ok: true, workspace: ws, scopeDepartmentId: scope, code: null, title: null, reason: null, redirect: null };
}

/**
 * HR, on people. Role-only, for the same reason as requireTeamLead: an HR user and the founder may
 * have no hr_employees row of their own, and locking them out of the people screen for that would be
 * a failure with no safety benefit.
 *
 * HR SEES PEOPLE, NEVER HEALTH. Do not join, count or reference any wellness_* table from a surface
 * behind this gate, and do not select hr_employees.gender. src/lib/wellness.ts deliberately ships no
 * "read any user's log" helper and suppresses aggregates below MIN_GROUP; a screen that needs one
 * row per user is the screen that must not exist.
 */
export async function requireHr(
  user: WorkspaceUser | null | undefined,
  next = '/portal/people'
): Promise<WorkspaceGate> {
  if (!user?.id) {
    return deny('not-signed-in', 'Please sign in',
      'This screen shows employee records, so it needs you signed in.',
      '/portal/login?next=' + encodeURIComponent(next));
  }

  // The same capability lookupWorkspace() resolves isHr from, asked once more because this gate must
  // answer before any record is read — and admitting exactly the two roles the role test admitted.
  if (!holdsCapability(user, 'employee.manage')) {
    return deny('not-hr', 'This screen is for the people team',
      'Your account does not hold HR permissions. Your own workspace is at /portal/employee.');
  }

  let ws: Workspace | null = null;
  try {
    ws = await resolveWorkspace(user);
  } catch (e: any) {
    // HR authority is the role; a failed lookup of their OWN record must not close the screen.
    logFail('[workspace-access] requireHr', e);
    ws = null;
  }
  return { ok: true, workspace: ws, scopeDepartmentId: ws?.scopeDepartmentId ?? null, code: null, title: null, reason: null, redirect: null };
}

// ---------------------------------------------------------------------------
// WHERE-CLAUSE SCOPING. Both helpers return a fragment to drop straight into a query:
//
//   const gate = await requireTeamLead(Astro.locals.user);
//   if (!gate.ok && gate.redirect) return Astro.redirect(gate.redirect);
//   // ... otherwise render gate.title + gate.reason and stop.
//   const team = rows(await db.execute(sql`
//     SELECT e.id, e.full_name, e.designation
//       FROM hr_employees e
//      WHERE ${departmentFilter(gate)} AND e.is_active = true
//      ORDER BY e.full_name`));
//
// NEITHER EVER RETURNS `true`. The worst a mistake can produce is an empty result, never a whole
// table. That is why HR's cross-department reads are written explicitly on the HR page behind
// requireHr rather than expressed as a wide-open filter here: "see everyone" should be visible in
// the query, not hidden inside a helper that also means "see one department".
// ---------------------------------------------------------------------------

/** Anything carrying a resolved department scope: a Workspace, or the result of a require* gate. */
export interface HasDepartmentScope { scopeDepartmentId?: string | null }
/** Anything carrying a resolved employee: a Workspace. */
export interface HasEmployee { employeeId?: string | null }

/**
 * Narrow to exactly one department — the one on the SESSION. Returns `false` (no rows) when there is
 * no resolved scope, so a page that skipped its gate, or a lead whose department was never set,
 * shows nothing rather than everything.
 *
 * Both sides are compared as text: the key is a varchar(50) slug in src/lib/db/schema.ts:81 and a
 * UUID in db/hr-schema.sql:32, and ::uuid would throw on a slug.
 *
 * @param column defaults to `e.department_id`; pass a static fragment such as sql`emp.department_id`
 *               for a different alias. Never build this from request input.
 */
export function departmentFilter(scope: HasDepartmentScope | null | undefined, column: SQL = sql`e.department_id`): SQL {
  const id = String(scope?.scopeDepartmentId || '').trim();
  if (!id) return sql`false`;
  return sql`${column}::text = ${id}`;
}

/**
 * Narrow to one person — the signed-in one. Returns `false` when no workspace resolved.
 * Every hr_* table (hr_attendance, hr_time_logs, hr_task_log, hr_daily_reports, hr_leave_request,
 * hr_clock_events) is keyed by employee_id = hr_employees.id, never by users.id.
 */
export function employeeFilter(scope: HasEmployee | null | undefined, column: SQL = sql`employee_id`): SQL {
  const id = String(scope?.employeeId || '').trim();
  if (!id) return sql`false`;
  return sql`${column}::text = ${id}`;
}
