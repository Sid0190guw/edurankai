// src/lib/performance-scope.ts — WHOSE PERFORMANCE MAY THIS PERSON SEE, answered once.
//
// =================================================================================================
// THE THREE LAYERS, KEPT APART, IN ONE SMALL FILE
// =================================================================================================
//
// Every performance and learning surface asks the same two questions before it reads anything:
//
//   "Who is this, in employee-id space?"        Layer 1's territory — src/lib/org-graph.ts.
//   "May they see somebody else's row?"         BOTH layers, and they answer different halves:
//
//       a RELATIONSHIP  -> the org graph. Per ROW. "Is this person's manager me, today?"
//       a CAPABILITY    -> permissions.ts. Per USER. "May I see everyone, with no relationship?"
//
// This module composes those two answers and hands back a scope. It resolves NOTHING itself: every
// relationship comes from org-graph.ts and every capability comes through the composed context's
// wildcard-aware holds(). There is no query against org_relationships in this file and there must
// never be one.
//
// MANAGER IS A RELATIONSHIP. It is not `users.role`, it is not a title, and it is not a column on
// hr_employees that somebody typed. `reportIds` below comes from getDirectReports(), which reads the
// graph. If the graph is empty, `initialized` is false and the honest render is "the Organization
// Graph has not been set up yet" — NEVER "you manage nobody", which would be true of every person in
// the company and would send a manager hunting for a data problem that does not exist.
//
// FAILS CLOSED. A scope that could not be resolved sees their own rows and nothing else. A manager
// wrongly shown an empty team list asks HR one question; a manager wrongly shown somebody else's
// appraisal is a disclosure that cannot be taken back.
import {
  employeeIdForUser,
  getDirectReports,
  isInitialized,
  isResponsibleFor,
  getReviewSubjects,
  type OrgPerson,
} from '@/lib/org-graph';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — declared ABOVE everything that uses them. `const` is not hoisted, and a const
// read before its declaration throws on the first line of the function that reads it. That pattern
// has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
export const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
export const logFail = (mod: string, tag: string, e: any) =>
  console.error('[' + mod + '] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard every id before it reaches a `::uuid` cast, so a malformed one fails closed here. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Trim and cap a free-text field. Every writer in this module family runs its input through it. */
export const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+$/, '').trim().slice(0, max);

/**
 * THE CAPABILITY that means "performance across the whole organization, with no relationship".
 * Named once so the string is never typed twice — an invented capability key answers false for
 * every role including super_admin, which made a whole console unreachable on this project once.
 */
export const PERF_MANAGE = 'performance.manage';
export const SKILLS_MANAGE = 'skills.manage';
export const LEARNING_ASSIGN = 'learning.assign';

/** How a screen says what it is looking at. */
export type PerfScopeKind = 'org' | 'manager' | 'self' | 'none';

export interface PerfViewer {
  userId: string;
  /** hr_employees.id, or null when this account has no employee record. */
  employeeId: string | null;
  fullName: string | null;
  /** hr_employees.department_id, always read as ::text. Never cast to uuid. */
  departmentId: string | null;
  /** Is there anything in the Organization Graph at all? Distinct from "this person has nobody". */
  initialized: boolean;
  /** Holds `performance.manage` — the whole organization, without a relationship. */
  managesOrg: boolean;
  /** Direct reports, resolved from the graph. Empty when the graph is empty OR nobody reports here. */
  reports: OrgPerson[];
  /** The same people as ids, for an `IN (...)` that is bounded by the list above. */
  reportIds: string[];
  /** Whose work this person REVIEWS — the graph's `reviewer` edge. 360 feedback, and only that. */
  reviewSubjects: OrgPerson[];
  kind: PerfScopeKind;
  /** A sentence a screen prints verbatim. It never guesses and never apologises for an empty graph. */
  explanation: string;
}

/**
 * Resolve the viewer once per request.
 *
 * `holds` is the composed context's WILDCARD-AWARE membership test (composeWorkspace().context.holds
 * on a portal page, or a `can(user, key)` wrapper in the admin console). It is passed IN rather than
 * resolved here so that this module imports no authorization engine and cannot become a second one.
 */
export async function resolvePerfViewer(
  userId: string,
  holds: (key: string) => boolean,
): Promise<PerfViewer> {
  const base: PerfViewer = {
    userId: String(userId || ''),
    employeeId: null,
    fullName: null,
    departmentId: null,
    initialized: false,
    managesOrg: false,
    reports: [],
    reportIds: [],
    reviewSubjects: [],
    kind: 'none',
    explanation: 'We could not work out who you are on the employee record, so this shows nothing.',
  };
  if (!isUuid(base.userId)) return base;

  let managesOrg = false;
  try {
    managesOrg = holds(PERF_MANAGE) === true;
  } catch {
    // A holds() that throws is a broken composition, not a grant. Fail closed.
    managesOrg = false;
  }

  const employeeId = await employeeIdForUser(base.userId);
  const initialized = await isInitialized();

  let fullName: string | null = null;
  let departmentId: string | null = null;
  if (employeeId) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT full_name, department_id::text AS department_id
          FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
      if (r.length) {
        fullName = r[0]?.full_name ? String(r[0].full_name) : null;
        departmentId = r[0]?.department_id ? String(r[0].department_id) : null;
      }
    } catch (e: any) {
      logFail('performance-scope', 'employeeRow', e);
    }
  }

  // RELATIONSHIPS, from the graph and from nowhere else. Both are empty on an empty graph, which is
  // why `initialized` travels beside them: the caller must be able to tell the two apart.
  const reports = employeeId ? await getDirectReports(employeeId) : [];
  const reviewSubjects = employeeId ? await getReviewSubjects(employeeId) : [];

  const kind: PerfScopeKind = managesOrg
    ? 'org'
    : reports.length > 0
      ? 'manager'
      : employeeId
        ? 'self'
        : 'none';

  return {
    ...base,
    employeeId,
    fullName,
    departmentId,
    initialized,
    managesOrg,
    reports,
    reportIds: reports.map((p) => String(p.employeeId || '')).filter(isUuid),
    reviewSubjects,
    kind,
    explanation: explain(kind, initialized, reports.length, !!employeeId),
  };
}

/**
 * The sentence. Written here so every surface says the same thing about the same state, and so the
 * empty-graph case can never be printed as "you manage nobody".
 */
function explain(kind: PerfScopeKind, initialized: boolean, reportCount: number, hasRecord: boolean): string {
  if (kind === 'org') {
    return initialized
      ? 'You can see performance across the organization. Reporting lines come from the Organization Graph.'
      : 'You can see performance across the organization, but the Organization Graph has not been set up yet, '
        + 'so nothing here can say who reports to whom.';
  }
  if (kind === 'manager') {
    return 'You can see your own record, and the '
      + reportCount + (reportCount === 1 ? ' person' : ' people')
      + ' the Organization Graph records as reporting to you.';
  }
  if (kind === 'self') {
    return initialized
      ? 'This is your own record. Nobody is recorded as reporting to you, so there is no team view.'
      : 'This is your own record. The Organization Graph has not been set up yet, so a team view cannot '
        + 'be resolved for anybody — that is not the same as you having no team.';
  }
  return hasRecord
    ? 'We could not read your employee record just now, so this shows nothing rather than guessing.'
    : 'This account has no employee record, so there is no performance record attached to it.';
}

/**
 * MAY THIS VIEWER SEE THIS EMPLOYEE'S PERFORMANCE ROW?
 *
 * Three ways, in order of narrowness, and the order is the point:
 *   1. It is their own row. Always.
 *   2. A RELATIONSHIP: the org graph says they answer for that person's work — a direct manager, a
 *      skip-level manager, the head of their department, a named reviewer, or one hop of delegation.
 *      isResponsibleFor() is the single implementation of that question and this defers to it.
 *   3. A CAPABILITY: `performance.manage`, which means the whole organization with no relationship.
 *
 * WHAT IS NOT HERE: a role name, a department string comparison, or "they are both in the same
 * department". Nothing in this function can be satisfied by what somebody's account is called.
 *
 * False on any error.
 */
export async function canSeePerformanceOf(
  viewer: PerfViewer,
  employeeId: string,
): Promise<boolean> {
  if (!isUuid(employeeId)) return false;
  if (viewer.employeeId && viewer.employeeId === employeeId) return true;
  if (viewer.managesOrg) return true;
  if (!viewer.employeeId) return false;
  // Cheap path first: the reports list is already in memory from resolvePerfViewer().
  if (viewer.reportIds.indexOf(employeeId) >= 0) return true;
  if (viewer.reviewSubjects.some((p) => p.employeeId === employeeId)) return true;
  return isResponsibleFor(viewer.employeeId, employeeId);
}

/**
 * The employee ids a LIST query may include for this viewer.
 *
 * `null` means "no restriction" and is returned ONLY for a `performance.manage` holder. Everyone
 * else gets an explicit list: themselves plus whoever the graph named. An empty array means the
 * query must return nothing — callers must handle that WITHOUT emitting `IN ()`, which is a syntax
 * error, and the readers in this module family all check `.length` first.
 */
export function visibleEmployeeIds(viewer: PerfViewer): string[] | null {
  if (viewer.managesOrg) return null;
  const set = new Set<string>();
  if (viewer.employeeId) set.add(viewer.employeeId);
  for (const id of viewer.reportIds) set.add(id);
  for (const p of viewer.reviewSubjects) if (p.employeeId) set.add(String(p.employeeId));
  return Array.from(set).filter(isUuid);
}

/** A bound-parameter `IN (...)` fragment. Never string concatenation, even for ids from our own DB. */
export function uuidList(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

/**
 * The name and designation of one employee, for a heading. Display only — it decides nothing, and
 * every caller has already passed canSeePerformanceOf() before reaching it.
 */
export async function employeeHeader(
  employeeId: string,
): Promise<{ id: string; fullName: string; designation: string | null; departmentId: string | null } | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT id, full_name, designation, department_id::text AS department_id
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!r.length) return null;
    return {
      id: String(r[0].id),
      fullName: r[0].full_name ? String(r[0].full_name) : 'Unnamed record',
      designation: r[0].designation ? String(r[0].designation) : null,
      departmentId: r[0].department_id ? String(r[0].department_id) : null,
    };
  } catch (e: any) {
    logFail('performance-scope', 'employeeHeader', e);
    return null;
  }
}

/** Departments, for a filter control. TEXT ids throughout — see the header of org-graph.ts. */
export async function departmentOptions(): Promise<{ id: string; name: string }[]> {
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT d.id::text AS id, d.name
        FROM departments d
       ORDER BY d.name ASC
       LIMIT 200`));
    return r.map((row: any) => ({ id: String(row.id), name: String(row.name || row.id) }));
  } catch (e: any) {
    logFail('performance-scope', 'departmentOptions', e);
    return [];
  }
}
