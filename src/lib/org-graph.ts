// src/lib/org-graph.ts — LAYER 1: WHO IS RESPONSIBLE FOR WHOM. The only place that answers it.
//
// =================================================================================================
// THE THREE LAYERS, AND WHY THIS FILE MUST NOT DRIFT INTO THE OTHER TWO
// =================================================================================================
//
//   Layer 1  ORGANIZATION   who is responsible for whom   -> THIS FILE. Per ROW, from the graph.
//   Layer 2  AUTHORIZATION  what a user may do            -> src/lib/auth/permissions.ts. Per USER,
//                                                            dotted lowercase capabilities.
//   Layer 3  WORKFLOW       how work moves                -> elsewhere.
//
// THERE IS NO NEW AUTHORIZATION SYSTEM HERE. This module grants nothing, denies nothing and holds
// no capability. It answers relationship questions and hands the answer back; the caller still has
// to consult Layer 2 for what may be DONE with it. Two engines deciding access is the defect, not
// the feature — if this file ever starts returning "may approve" instead of "is the manager of",
// that is the moment the architecture broke.
//
// ZERO ROLE NAMES. Nothing in this file reads `users.role`, compares to 'department_head',
// 'hr', 'super_admin' or any other value of userRoleEnum, or accepts a role as an argument. The
// string 'department_head' DOES appear below — as a value of `org_relationships.type`, which is a
// RELATIONSHIP TYPE. It is never compared against a user's role, and the two live in different
// tables for exactly that reason. That distinction is the whole of Phase 1's work and it is the
// easiest thing in this codebase to accidentally undo.
//
// WHY A ROLE-NAME FALLBACK IS FORBIDDEN, in one sentence: if the graph is empty and this file
// answered "is a department head" from `users.role = 'department_head'`, every screen would look
// like it worked, and the per-row relationship would have silently become a per-user grant again —
// giving every manager authority over every employee. When there is no data, the honest answer is
// isInitialized() === false, which callers must render as "Organization Graph not yet initialized".
//
// =================================================================================================
// FAIL CLOSED. EVERY FUNCTION. NO EXCEPTIONS.
// =================================================================================================
//
// Every exported resolver is wrapped in try/catch and returns the CLOSED answer on any error:
// false for a predicate, null for a lookup, [] for a list. A missing table, a malformed id, a
// dropped connection — all of them mean "no relationship", never "yes". The real Postgres reason is
// logged via `e?.cause?.message || e?.message`, because `e.message` on a drizzle error is only the
// failed SQL and has cost hours here before.
//
// =================================================================================================
// THE ID-SPACE TRAP — the single most likely way to get a wrong answer out of this file
// =================================================================================================
//
// THE GRAPH IS KEYED ON `hr_employees.id`. Both subject_employee_id and object_employee_id hold an
// EMPLOYEE id. The legacy column this replaces does the opposite: `hr_employees.reporting_manager_id`
// holds a USERS id (db/hr-schema.sql:114-118; hr-wallet.ts approverRole() compares it to the
// signed-in user's id). Mixing the two silently returns nobody, or worse, somebody else.
//
// So the API comes in two clearly separated halves:
//   - employee-id functions:  getManager, isReportingManager, getReportingChain, ...
//   - user-id functions:      userIsReportingManager, userIsDepartmentHead, userDirectReports, ...
//     which resolve users.id -> hr_employees.id ONCE via employeeIdForUser() and then delegate.
// Never pass a session user id to the first half.
//
// DEPARTMENT IDS ARE TEXT AND ARE NEVER CAST TO ::uuid. `departments.id` is varchar(50) (a slug) in
// src/lib/db/schema.ts:80 and UUID in db/hr-schema.sql:31. `org_relationships.scope_id` is TEXT and
// `hr_employees.department_id` is read as `::text` everywhere below. A ::uuid cast throws
// "invalid input syntax for type uuid" the first time a slug arrives.
//
// =================================================================================================
// NOTHING CALLS THIS YET, AND THAT IS THE POINT OF THIS PHASE
// =================================================================================================
//
// This is infrastructure shipped INACTIVE. No page, API route or existing service imports it, so
// deploying it changes no behaviour anywhere. The tables do not even get created until something
// calls a function here. The graph will be EMPTY until the founder runs db/org-graph-backfill.sql —
// which is why isInitialized() is exported alongside every resolver: a consumer must be able to tell
// "there is no data yet" from "there is data and this person has no manager". Those two render
// completely differently and confusing them is how an org chart lies.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureOrgGraphSchema } from './org-graph-schema';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that use it.
// `const` is not hoisted. A const declared below its first use throws on the first line of the
// function that reads it, and on this project that pattern took down apply step 5 and the
// /admin/roles/diagnose Repair button, both of which reported success while failing every time.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[org-graph] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard every id BEFORE it reaches a `::uuid` cast.
 *
 * The alternative — comparing `column::text = $1` — would be cast-safe but would defeat the btree
 * index on every uuid column in the graph, turning each lookup into a sequential scan. Validating
 * in TypeScript keeps the queries index-friendly AND makes a malformed id fail closed here, one
 * line before the database, instead of throwing inside a query.
 */
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * Hard ceiling on how far getReportingChain() will walk.
 *
 * This is not a performance tuning knob, it is a hang guard. A corrupt graph — A reports to B
 * reports to A — would otherwise make the recursion run until the statement timeout, holding a
 * pooled connection while a person's page spins. The recursive query ALSO carries a visited-path
 * array so a cycle stops at the repeat rather than at the cap, and the TypeScript loop that reads
 * the result de-duplicates a third time. Three guards, because a cycle here is a request that never
 * returns, and corrupt org data is exactly what a first backfill produces.
 */
export const MAX_CHAIN_DEPTH = 12;

/**
 * THE RELATIONSHIP VOCABULARY. These are values of `org_relationships.type`.
 *
 * READ EACH ROW AS THIS SENTENCE — the direction is fixed and never re-derived:
 *
 *     <subject> is the <type> of <object>, within <scope>, from <effective_from> to <effective_to>
 *
 *   reporting_manager   subject manages object. The line that decides whose leave they see.
 *   department_head     subject heads the department in scope_id. object is NULL — a head is head
 *                       of a DEPARTMENT, not of one named person.
 *   team_lead           subject leads the team in scope_id. object NULL, same reasoning.
 *   functional_manager  subject owns object's craft/discipline. A dotted line; coexists with a
 *                       reporting_manager and does not replace it.
 *   project_manager     subject runs the project in scope_id and directs object inside it. Bounded
 *                       by the project, which is why it has both an object and a scope.
 *   mentor              subject mentors object. Support, explicitly not authority.
 *   reviewer            subject reviews object's work for a cycle in scope_id.
 *   executive_sponsor   subject sponsors object or the initiative in scope_id.
 *   temporary_delegate  subject acts in object's place while object is away. Time-boxed by
 *                       effective_from/effective_to, which is the entire mechanism — there is no
 *                       "is delegated" flag to forget to switch off.
 *   approval_owner      subject owns approvals for the domain in scope_id (e.g. 'leave'), for
 *                       object, or organization-wide when object is NULL.
 *
 * NOT ONE OF THESE IS A ROLE NAME OR A CAPABILITY. They are edges. `approval_owner` names who the
 * approval routes TO; whether that person may then act is Layer 2's answer, from permissions.ts.
 */
export const ORG_RELATIONSHIP_TYPES = [
  'reporting_manager',
  'department_head',
  'team_lead',
  'functional_manager',
  'project_manager',
  'mentor',
  'reviewer',
  'executive_sponsor',
  'temporary_delegate',
  'approval_owner',
] as const;

export type OrgRelationshipType = (typeof ORG_RELATIONSHIP_TYPES)[number];

/** What a relationship can be bounded BY. `scope_id` is always TEXT — see the header. */
export const ORG_SCOPE_TYPES = [
  'global',
  'department',
  'team',
  'project',
  'position',
  'approval_domain',
] as const;

export type OrgScopeType = (typeof ORG_SCOPE_TYPES)[number];

/**
 * `active` = a true assertion; it counts on every date inside its effective range, OPEN OR CLOSED.
 * `revoked` = entered in error and retracted; it counts on no date at all.
 *
 * SUPERSEDING SETS `effective_to` AND LEAVES STATUS `active`. There is deliberately no 'superseded'
 * status: every historical query filters `status = 'active'`, so a closed row that also lost its
 * active status would vanish from history — destroying the one thing this table exists to keep.
 */
export type OrgRelationshipStatus = 'active' | 'revoked';

/**
 * The set of edges that mean "this person answers for that person's work".
 *
 * Used by isResponsibleFor(). Note what is ABSENT: `mentor` is support, not authority, and a mentor
 * must not inherit a manager's reach over someone's leave or pay. `approval_owner` is absent for
 * the opposite reason — it is routing, and treating it as general responsibility would widen it.
 */
export const RESPONSIBILITY_TYPES: readonly OrgRelationshipType[] = [
  'reporting_manager',
  'functional_manager',
  'project_manager',
  'team_lead',
  'reviewer',
  'executive_sponsor',
];

/** A person as the graph knows them. `employeeId` is null only on the legacy compatibility path. */
export interface OrgPerson {
  employeeId: string | null;
  userId: string | null;
  fullName: string | null;
  designation: string | null;
  /** hr_employees.department_id, always read as ::text. Never cast to uuid. */
  departmentId: string | null;
}

/** One step up the reporting line. `depth` 1 is the direct manager. */
export interface OrgChainLink extends OrgPerson {
  depth: number;
}

/** A raw edge, for history and audit views. */
export interface OrgEdge {
  id: string;
  type: string;
  subjectEmployeeId: string | null;
  objectEmployeeId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string | null;
  note: string | null;
}

/**
 * Ask the graph as it stood on a given date.
 *
 * This is the reason the edge is a row and not a column. "Who was the manager on the day this was
 * approved" is `{ asOf: approvedAt }`, and it keeps answering correctly after four reorganisations.
 * Omit it for "now".
 */
export interface AsOfOptions {
  asOf?: Date | string | null;
}

/** Where an answer came from. Consumers must be able to SAY this, not just use it. */
export type OrgSource = 'graph' | 'legacy-column' | 'none';

/** An answer that carries its own provenance. Only the compatibility layer returns these. */
export interface OrgAnswer<T> {
  value: T;
  source: OrgSource;
}

// -------------------------------------------------------------------------------------------------
// INTERNAL HELPERS
// -------------------------------------------------------------------------------------------------

/**
 * Resolve the as-of instant, or null if the caller handed us something unparseable.
 *
 * A bad date returns NULL rather than quietly defaulting to now(). Silently answering a DIFFERENT
 * question than the one asked is how an audit screen ends up showing today's manager next to a
 * three-year-old approval and looking entirely convincing.
 */
function asOfIso(opts?: AsOfOptions | null): string | null {
  const raw = opts?.asOf;
  if (raw === undefined || raw === null || raw === '') return new Date().toISOString();
  const d = raw instanceof Date ? raw : new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * "This edge was in force at <iso>", for a table aliased <alias>.
 *
 * `alias` is a COMPILE-TIME LITERAL at every call site in this file and is never derived from
 * caller input, request data or the database — which is the only reason sql.raw() is acceptable
 * here. The instant itself is a bound parameter, as it must be.
 *
 * The boundary is deliberately half-open: `effective_from <= at` and `effective_to > at`. So closing
 * one edge and opening the next at the SAME instant leaves no gap and no overlap — at that instant
 * exactly one row answers.
 */
function inForce(alias: string, iso: string) {
  const a = sql.raw(alias);
  return sql`${a}.status = 'active'
    AND ${a}.effective_from <= ${iso}::timestamptz
    AND (${a}.effective_to IS NULL OR ${a}.effective_to > ${iso}::timestamptz)`;
}

/** `IN (...)` from a constant list, as bound parameters rather than interpolated text. */
function typeList(types: readonly string[]) {
  return sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );
}

/**
 * The person columns, selected from an `hr_employees` aliased `e`.
 * department_id is cast ::text at the source so no caller can ever receive it as a uuid.
 */
const PERSON_COLS = sql`e.id AS employee_id,
  e.user_id AS user_id,
  e.full_name AS full_name,
  e.designation AS designation,
  e.department_id::text AS department_id`;

function mapPerson(row: any): OrgPerson {
  return {
    employeeId: row?.employee_id ? String(row.employee_id) : null,
    userId: row?.user_id ? String(row.user_id) : null,
    fullName: row?.full_name ? String(row.full_name) : null,
    designation: row?.designation ? String(row.designation) : null,
    departmentId: row?.department_id ? String(row.department_id) : null,
  };
}

function mapEdge(row: any): OrgEdge {
  return {
    id: String(row?.id ?? ''),
    type: String(row?.type ?? ''),
    subjectEmployeeId: row?.subject_employee_id ? String(row.subject_employee_id) : null,
    objectEmployeeId: row?.object_employee_id ? String(row.object_employee_id) : null,
    scopeType: row?.scope_type ? String(row.scope_type) : null,
    scopeId: row?.scope_id ? String(row.scope_id) : null,
    effectiveFrom: row?.effective_from ? new Date(row.effective_from).toISOString() : null,
    effectiveTo: row?.effective_to ? new Date(row.effective_to).toISOString() : null,
    status: String(row?.status ?? ''),
    createdBy: row?.created_by ? String(row.created_by) : null,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    note: row?.note ? String(row.note) : null,
  };
}

// -------------------------------------------------------------------------------------------------
// IS THERE ANY DATA AT ALL?
// -------------------------------------------------------------------------------------------------

/**
 * Does the Organization Graph contain anything?
 *
 * EVERY CONSUMER NEEDS THIS, and needs it separately from every other answer here. Until the founder
 * runs db/org-graph-backfill.sql the graph is EMPTY, and an empty graph makes getManager() return
 * null for everybody — which is indistinguishable, at the call site, from "this person genuinely has
 * no manager". Those two facts must render differently:
 *
 *     isInitialized() === false  ->  "Organization Graph not yet initialized"
 *     isInitialized() === true, getManager() === null  ->  "No reporting manager on record"
 *
 * A screen that shows the second when the first is true is telling every employee they report to
 * nobody. Returns false on any error, which lands on the honest message rather than a blank chart.
 */
export async function isInitialized(): Promise<boolean> {
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(
      sql`SELECT 1 AS ok FROM org_relationships WHERE status = 'active' LIMIT 1`,
    );
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('isInitialized', e);
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// LOOKUPS — employee-id space. Never pass a session user id to these.
// -------------------------------------------------------------------------------------------------

/**
 * Who managed this employee, as of a date? Returns null when nobody did, or on any error.
 *
 * The tie-break: with the one-open-manager partial unique index there is exactly one open row per
 * person, so "now" is unambiguous. A retroactively entered historical row could in principle overlap
 * another closed row (partial unique indexes only constrain OPEN rows — the honest limit of not
 * taking full bitemporality); `ORDER BY effective_from DESC` then prefers the most recently started,
 * and db/org-graph-validate.sql reports the overlap so it gets fixed rather than silently picked.
 */
export async function getManager(
  employeeId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson | null> {
  if (!isUuid(employeeId)) return null;
  const at = asOfIso(opts);
  if (!at) return null;
  try {
    await ensureOrgGraphSchema();
    // subject = the manager, object = the report. See ORG_RELATIONSHIP_TYPES for the sentence.
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS}
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'reporting_manager'
         AND r.object_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}
       ORDER BY r.effective_from DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapPerson(list[0]) : null;
  } catch (e: any) {
    logFail('getManager', e);
    return null;
  }
}

/** Everyone reporting directly to this employee, as of a date. Empty on error. */
export async function getDirectReports(
  managerEmployeeId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson[]> {
  if (!isUuid(managerEmployeeId)) return [];
  const at = asOfIso(opts);
  if (!at) return [];
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS}
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.object_employee_id
       WHERE r.type = 'reporting_manager'
         AND r.subject_employee_id = ${managerEmployeeId}::uuid
         AND ${inForce('r', at)}
       ORDER BY e.full_name ASC`);
    return rows(r).map(mapPerson);
  } catch (e: any) {
    logFail('getDirectReports', e);
    return [];
  }
}

/** Is this employee that employee's reporting manager, as of a date? False on error. */
export async function isReportingManager(
  managerEmployeeId: string,
  employeeId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  if (!isUuid(managerEmployeeId) || !isUuid(employeeId)) return false;
  if (managerEmployeeId === employeeId) return false; // nobody manages themselves
  const at = asOfIso(opts);
  if (!at) return false;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT 1 AS ok
        FROM org_relationships r
       WHERE r.type = 'reporting_manager'
         AND r.subject_employee_id = ${managerEmployeeId}::uuid
         AND r.object_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('isReportingManager', e);
    return false;
  }
}

/**
 * Who heads this department, as of a date?
 *
 * `departmentId` is compared as TEXT against org_relationships.scope_id, which is TEXT. It is never
 * cast to uuid — departments.id is a varchar(50) slug in one schema file and a UUID in the other,
 * so a cast would throw on half the values in the product. See the header.
 */
export async function getDepartmentHead(
  departmentId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson | null> {
  const dept = typeof departmentId === 'string' ? departmentId.trim() : '';
  if (!dept) return null;
  const at = asOfIso(opts);
  if (!at) return null;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS}
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'department_head'
         AND r.scope_type = 'department'
         AND r.scope_id = ${dept}
         AND ${inForce('r', at)}
       ORDER BY r.effective_from DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapPerson(list[0]) : null;
  } catch (e: any) {
    logFail('getDepartmentHead', e);
    return null;
  }
}

/**
 * Does this employee head this department, as of a date?
 *
 * THIS IS NOT `users.role === 'department_head'`, and replacing it with that would be the exact
 * regression Phase 1 removed: the role name says "is a head of something", this says "is the
 * recorded head of THIS department". One is a per-user label, the other is a per-row fact.
 */
export async function isDepartmentHead(
  employeeId: string,
  departmentId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  const dept = typeof departmentId === 'string' ? departmentId.trim() : '';
  if (!isUuid(employeeId) || !dept) return false;
  const at = asOfIso(opts);
  if (!at) return false;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT 1 AS ok
        FROM org_relationships r
       WHERE r.type = 'department_head'
         AND r.scope_type = 'department'
         AND r.scope_id = ${dept}
         AND r.subject_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('isDepartmentHead', e);
    return false;
  }
}

/** This employee's mentor, as of a date. Support, not authority — see RESPONSIBILITY_TYPES. */
export async function getMentor(
  employeeId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson | null> {
  if (!isUuid(employeeId)) return null;
  const at = asOfIso(opts);
  if (!at) return null;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS}
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'mentor'
         AND r.object_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}
       ORDER BY r.effective_from DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapPerson(list[0]) : null;
  } catch (e: any) {
    logFail('getMentor', e);
    return null;
  }
}

/**
 * Who owns approvals for a domain — optionally for one named employee?
 *
 * `domain` is a free string held in scope_id ('leave', 'payouts', ...). A row with
 * object_employee_id set covers THAT employee; a row with object NULL covers the organization. The
 * specific row wins, which is what the ORDER BY encodes.
 *
 * THIS DOES NOT SAY THE OWNER MAY APPROVE. It says where the request routes. Whether that person
 * may act on it is a capability question, answered by src/lib/auth/permissions.ts and by nothing
 * here. Keeping those separate is the reason this module exists.
 *
 * KNOWN LIMIT, stated rather than papered over: there is no department-wide approval ownership,
 * because scope_id is already carrying the domain. Department-level routing is expressed as a
 * `department_head` edge plus the workflow layer's own rule.
 */
export async function getApprovalOwner(
  domain: string,
  opts?: AsOfOptions & { employeeId?: string | null },
): Promise<OrgPerson | null> {
  const d = typeof domain === 'string' ? domain.trim() : '';
  if (!d) return null;
  const at = asOfIso(opts);
  if (!at) return null;
  const forEmployee = isUuid(opts?.employeeId) ? String(opts?.employeeId) : null;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS},
             (r.object_employee_id IS NULL) AS is_org_wide
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'approval_owner'
         AND r.scope_type = 'approval_domain'
         AND r.scope_id = ${d}
         AND (
           r.object_employee_id IS NULL
           OR (${forEmployee}::text IS NOT NULL AND r.object_employee_id::text = ${forEmployee}::text)
         )
         AND ${inForce('r', at)}
       ORDER BY is_org_wide ASC, r.effective_from DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapPerson(list[0]) : null;
  } catch (e: any) {
    logFail('getApprovalOwner', e);
    return null;
  }
}

/**
 * Who is currently standing in for this employee?
 *
 * Read the row the same way as every other: `<subject> is the temporary_delegate of <object>`. So
 * the delegates of employee X are the SUBJECTS of rows whose OBJECT is X.
 *
 * A delegation is time-boxed by effective_from/effective_to and by nothing else. There is no "is
 * delegated" boolean that somebody has to remember to switch off when they get back from leave,
 * which is the failure mode this shape exists to remove.
 */
export async function getDelegates(
  employeeId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson[]> {
  if (!isUuid(employeeId)) return [];
  const at = asOfIso(opts);
  if (!at) return [];
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT ${PERSON_COLS}
        FROM org_relationships r
        JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'temporary_delegate'
         AND r.object_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}
       ORDER BY e.full_name ASC`);
    return rows(r).map(mapPerson);
  } catch (e: any) {
    logFail('getDelegates', e);
    return [];
  }
}

/**
 * The reporting line upward from an employee: direct manager first, then theirs, and so on.
 *
 * ONE QUERY, NOT ONE PER LEVEL. A loop of getManager() calls would be an N+1 that gets slower with
 * every layer the company adds, on a page that renders on a phone. This is a single recursive CTE.
 *
 * CYCLE SAFETY, THREE TIMES OVER, because a cycle here is a request that never comes back:
 *   1. The recursive term carries the path walked so far and refuses to re-enter it
 *      (`NOT (r.subject_employee_id = ANY(c.path))`), so A -> B -> A stops at the repeat.
 *   2. `c.depth < ${maxDepth}` caps the walk regardless, so even a path check defeated by data we
 *      did not anticipate terminates.
 *   3. The TypeScript loop below tracks visited ids and stops, so a duplicate that survived both
 *      SQL guards cannot produce an infinite list for the renderer.
 * Belt, braces and a second belt: the first backfill of a hand-maintained column is precisely where
 * corrupt org data comes from.
 */
export async function getReportingChain(
  employeeId: string,
  opts?: AsOfOptions & { maxDepth?: number },
): Promise<OrgChainLink[]> {
  if (!isUuid(employeeId)) return [];
  const at = asOfIso(opts);
  if (!at) return [];
  const requested = Number(opts?.maxDepth);
  const maxDepth =
    Number.isFinite(requested) && requested > 0 && requested < MAX_CHAIN_DEPTH
      ? Math.floor(requested)
      : MAX_CHAIN_DEPTH;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT r.subject_employee_id AS manager_id,
               1 AS depth,
               ARRAY[${employeeId}::uuid, r.subject_employee_id] AS path
          FROM org_relationships r
         WHERE r.type = 'reporting_manager'
           AND r.object_employee_id = ${employeeId}::uuid
           AND ${inForce('r', at)}
        UNION ALL
        SELECT r.subject_employee_id,
               c.depth + 1,
               c.path || r.subject_employee_id
          FROM chain c
          JOIN org_relationships r
            ON r.object_employee_id = c.manager_id
         WHERE r.type = 'reporting_manager'
           AND ${inForce('r', at)}
           AND c.depth < ${maxDepth}
           AND NOT (r.subject_employee_id = ANY(c.path))
      )
      SELECT c.depth AS depth, ${PERSON_COLS}
        FROM chain c
        JOIN hr_employees e ON e.id = c.manager_id
       ORDER BY c.depth ASC`);

    const out: OrgChainLink[] = [];
    const seen = new Set<string>([employeeId.toLowerCase()]);
    for (const row of rows(r)) {
      const person = mapPerson(row);
      const key = (person.employeeId || '').toLowerCase();
      if (!key || seen.has(key)) continue; // third cycle guard — see the note above
      seen.add(key);
      out.push({ ...person, depth: Number(row?.depth) || out.length + 1 });
      if (out.length >= maxDepth) break;
    }
    return out;
  } catch (e: any) {
    logFail('getReportingChain', e);
    return [];
  }
}

/**
 * Does this employee answer for that employee's work, as of a date?
 *
 * FOUR WAYS TO BE RESPONSIBLE, all resolved in ONE query so a page can ask this per row without
 * turning into an N+1:
 *
 *   1. A DIRECT EDGE of a responsibility type (RESPONSIBILITY_TYPES). Note the exclusions: `mentor`
 *      is support and confers nothing, `approval_owner` is routing and confers nothing.
 *   2. ANYWHERE UP THE REPORTING LINE. A skip-level manager is responsible; that is what a line is.
 *      Same cycle-safe recursive walk as getReportingChain, same depth cap.
 *   3. HEAD OF THE TARGET'S CURRENT DEPARTMENT. Resolved from the target's own hr_employees row,
 *      compared ::text — never ::uuid, see the header.
 *   4. ONE HOP OF DELEGATION. Standing in for someone responsible makes you responsible while the
 *      delegation is in force. ONE hop only, and deliberately: chained delegation would let A
 *      delegate to B who delegates to C, quietly reaching further than anyone approved.
 *
 * False on any error, and false for actor === target: answering for your own work is not a
 * relationship, and letting it be one would make every self-review self-approving.
 */
export async function isResponsibleFor(
  actorEmployeeId: string,
  targetEmployeeId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  if (!isUuid(actorEmployeeId) || !isUuid(targetEmployeeId)) return false;
  if (actorEmployeeId === targetEmployeeId) return false;
  const at = asOfIso(opts);
  if (!at) return false;
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT r.subject_employee_id AS manager_id,
               1 AS depth,
               ARRAY[${targetEmployeeId}::uuid, r.subject_employee_id] AS path
          FROM org_relationships r
         WHERE r.type = 'reporting_manager'
           AND r.object_employee_id = ${targetEmployeeId}::uuid
           AND ${inForce('r', at)}
        UNION ALL
        SELECT r.subject_employee_id,
               c.depth + 1,
               c.path || r.subject_employee_id
          FROM chain c
          JOIN org_relationships r
            ON r.object_employee_id = c.manager_id
         WHERE r.type = 'reporting_manager'
           AND ${inForce('r', at)}
           AND c.depth < ${MAX_CHAIN_DEPTH}
           AND NOT (r.subject_employee_id = ANY(c.path))
      ),
      target_dept AS (
        SELECT e.department_id::text AS dept
          FROM hr_employees e
         WHERE e.id = ${targetEmployeeId}::uuid
         LIMIT 1
      )
      SELECT 1 AS ok
       WHERE EXISTS (
               SELECT 1 FROM org_relationships r
                WHERE r.subject_employee_id = ${actorEmployeeId}::uuid
                  AND r.object_employee_id = ${targetEmployeeId}::uuid
                  AND r.type IN (${typeList(RESPONSIBILITY_TYPES)})
                  AND ${inForce('r', at)}
             )
          OR EXISTS (
               SELECT 1 FROM chain c
                WHERE c.manager_id = ${actorEmployeeId}::uuid
             )
          OR EXISTS (
               SELECT 1 FROM org_relationships r
                JOIN target_dept td ON TRUE
                WHERE r.type = 'department_head'
                  AND r.scope_type = 'department'
                  AND td.dept IS NOT NULL
                  AND r.scope_id = td.dept
                  AND r.subject_employee_id = ${actorEmployeeId}::uuid
                  AND ${inForce('r', at)}
             )
          OR EXISTS (
               SELECT 1
                 FROM org_relationships d
                 JOIN org_relationships r
                   ON r.subject_employee_id = d.object_employee_id
                WHERE d.type = 'temporary_delegate'
                  AND d.subject_employee_id = ${actorEmployeeId}::uuid
                  AND ${inForce('d', at)}
                  AND r.object_employee_id = ${targetEmployeeId}::uuid
                  AND r.type IN (${typeList(RESPONSIBILITY_TYPES)})
                  AND ${inForce('r', at)}
             )
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('isResponsibleFor', e);
    return false;
  }
}

/**
 * Every edge ever recorded about this employee, newest first — both directions.
 *
 * THE PAYOFF OF APPEND-ONLY. Because superseding closes a row instead of overwriting a column, this
 * returns the full history: who managed them, when it changed, who recorded the change. On the
 * column this replaces the answer would have been "the current value, and nothing else, ever".
 */
export async function getRelationshipHistory(employeeId: string): Promise<OrgEdge[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT r.id, r.type, r.subject_employee_id, r.object_employee_id,
             r.scope_type, r.scope_id, r.effective_from, r.effective_to,
             r.status, r.created_by, r.created_at, r.note
        FROM org_relationships r
       WHERE r.subject_employee_id = ${employeeId}::uuid
          OR r.object_employee_id = ${employeeId}::uuid
       ORDER BY r.effective_from DESC, r.created_at DESC
       LIMIT 500`);
    return rows(r).map(mapEdge);
  } catch (e: any) {
    logFail('getRelationshipHistory', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// USER-ID BRIDGE — for callers holding a SESSION, which is most of them.
//
// Everything above takes hr_employees.id. A signed-in caller has users.id. These functions do the
// translation ONCE and then delegate, so the id-space trap is crossed in exactly one place instead
// of at every call site. Two constant-cost queries, never one per row.
// -------------------------------------------------------------------------------------------------

/**
 * users.id -> hr_employees.id. Null when this account has no employee record, which is a real and
 * ordinary case (the founder account, an admin who is not on the payroll) and must fail closed
 * rather than throw.
 */
export async function employeeIdForUser(userId: string): Promise<string | null> {
  if (!isUuid(userId)) return null;
  try {
    const r = await db.execute(sql`
      SELECT id FROM hr_employees
       WHERE user_id = ${userId}::uuid
       ORDER BY is_active DESC, created_at ASC
       LIMIT 1`);
    const list = rows(r);
    return list.length && list[0]?.id ? String(list[0].id) : null;
  } catch (e: any) {
    logFail('employeeIdForUser', e);
    return null;
  }
}

/** Is the signed-in user the reporting manager of this employee record? False on error. */
export async function userIsReportingManager(
  userId: string,
  employeeId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  const mgr = await employeeIdForUser(userId);
  if (!mgr) return false;
  return isReportingManager(mgr, employeeId, opts);
}

/** Is the signed-in user the recorded head of this department? False on error. */
export async function userIsDepartmentHead(
  userId: string,
  departmentId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  const emp = await employeeIdForUser(userId);
  if (!emp) return false;
  return isDepartmentHead(emp, departmentId, opts);
}

/** Does the signed-in user answer for this employee's work? False on error. */
export async function userIsResponsibleFor(
  userId: string,
  employeeId: string,
  opts?: AsOfOptions,
): Promise<boolean> {
  const actor = await employeeIdForUser(userId);
  if (!actor) return false;
  return isResponsibleFor(actor, employeeId, opts);
}

/** Everyone reporting directly to the signed-in user. Empty on error. */
export async function userDirectReports(
  userId: string,
  opts?: AsOfOptions,
): Promise<OrgPerson[]> {
  const mgr = await employeeIdForUser(userId);
  if (!mgr) return [];
  return getDirectReports(mgr, opts);
}

// =================================================================================================
// COMPATIBILITY LAYER — LEGACY, AND REMOVABLE THE DAY THE BACKFILL RUNS
// =================================================================================================
//
// WHAT THIS READS, AND WHY IT IS NOT THE THING THAT WAS FORBIDDEN.
//
// It reads `hr_employees.reporting_manager_id` — AN EXISTING DATA COLUMN holding an id that an
// administrator typed into the Employment tab of /admin/hr/employees/[id]. It is a recorded fact
// about one row: "this employee's manager is that person".
//
// It does NOT read `users.role`. That distinction is the entire point of Phase 1 and of this phase.
// A role name says "this account is a department_head" — a per-USER label that, used as a
// relationship, would make every manager a manager of everyone. A data column says "THIS employee's
// manager is THAT person" — a per-ROW fact, which is the same shape as a graph edge and can be read
// as one. Reading the column is migration; reading the role would be the regression.
//
// WHEN IT ENGAGES: only when isInitialized() is false — the graph has no rows at all. Once the
// founder runs db/org-graph-backfill.sql this path stops being reachable, and a graph that IS
// populated but has no manager for this person correctly answers "no manager", never falling back.
// If it fell back in that case, deleting a wrong edge would silently restore the stale column value.
//
// HOW TO REMOVE IT: after backfill + db/org-graph-validate.sql shows zero unmapped rows, delete this
// section and point its callers at getManager() / userIsReportingManager(). Nothing else depends on
// it. The `source` field on every answer is what makes that safe to verify from a screen: if any
// surface still says 'legacy-column' after the backfill, it is not finished.
// =================================================================================================

/** The manager, preferring the graph and falling back to the legacy column ONLY on an empty graph. */
export async function getManagerCompat(
  employeeId: string,
  opts?: AsOfOptions,
): Promise<OrgAnswer<OrgPerson | null>> {
  const fromGraph = await getManager(employeeId, opts);
  if (fromGraph) return { value: fromGraph, source: 'graph' };

  // A populated graph that has no manager for this person is an ANSWER, not a gap. Do not fall back.
  if (await isInitialized()) return { value: null, source: 'graph' };

  const legacy = await legacyManager(employeeId);
  return legacy ? { value: legacy, source: 'legacy-column' } : { value: null, source: 'none' };
}

/** "Is this signed-in user the manager?", graph first, legacy column only on an empty graph. */
export async function userIsReportingManagerCompat(
  userId: string,
  employeeId: string,
  opts?: AsOfOptions,
): Promise<OrgAnswer<boolean>> {
  if (await userIsReportingManager(userId, employeeId, opts)) {
    return { value: true, source: 'graph' };
  }
  if (await isInitialized()) return { value: false, source: 'graph' };

  const legacy = await legacyManager(employeeId);
  if (!legacy) return { value: false, source: 'none' };
  // THE COLUMN HOLDS A USERS ID, so this comparison is user id to user id. Comparing it to an
  // employee id would silently answer "no" for everybody and look exactly like a clean permission
  // check. See db/hr-schema.sql:114-118 and hr-wallet.ts approverRole().
  return { value: !!legacy.userId && legacy.userId === userId, source: 'legacy-column' };
}

/**
 * Read the legacy column. Private — no consumer should reach for this directly, because doing so
 * skips the "is the graph populated" question that makes the fallback safe.
 */
async function legacyManager(employeeId: string): Promise<OrgPerson | null> {
  if (!isUuid(employeeId)) return null;
  try {
    // `m` is the manager's OWN employee row and may not exist — a manager can be a user without an
    // hr_employees record. LEFT JOIN, so we still return them with employeeId null rather than
    // dropping the relationship entirely. db/org-graph-validate.sql counts exactly these, because
    // they are the rows the backfill cannot represent.
    const r = await db.execute(sql`
      SELECT m.id            AS employee_id,
             u.id            AS user_id,
             COALESCE(m.full_name, u.name) AS full_name,
             m.designation   AS designation,
             m.department_id::text AS department_id
        FROM hr_employees e
        JOIN users u ON u.id = e.reporting_manager_id
        LEFT JOIN hr_employees m ON m.user_id = u.id
       WHERE e.id = ${employeeId}::uuid
       ORDER BY m.is_active DESC NULLS LAST
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapPerson(list[0]) : null;
  } catch (e: any) {
    // Includes the case where the column itself has never been created on this database: two admin
    // pages ALTER it in at page load, so on a fresh environment it can genuinely be absent. Missing
    // legacy data means no relationship, never an assumed one.
    logFail('legacyManager', e);
    return null;
  }
}

// =================================================================================================
// WRITES — append-only, and not wired to anything yet
// =================================================================================================
//
// No UI calls these. They are here so that the admin surface built in a later phase has one correct
// way to change the graph instead of inventing its own INSERT.
//
// THE ONE RULE: NOTHING IS EVER DELETED OR OVERWRITTEN. Changing a manager CLOSES the old row and
// OPENS a new one. That is what keeps "who was the manager on the day this was approved" answerable
// after the fourth reorganisation, and it is the single reason this table exists instead of a column.
// =================================================================================================

export interface OpenRelationshipInput {
  type: OrgRelationshipType;
  subjectEmployeeId: string;
  objectEmployeeId?: string | null;
  scopeType?: OrgScopeType | null;
  scopeId?: string | null;
  effectiveFrom?: Date | string | null;
  createdByUserId?: string | null;
  note?: string | null;
}

export interface OrgWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Record a new relationship.
 *
 * Refuses rather than guesses: an unknown type, a bad id or a self-edge comes back `{ ok: false }`
 * with a reason a human can read. The partial unique indexes in org-graph-schema.ts are the real
 * backstop — a second open manager for the same person is rejected by the DATABASE, not only by
 * this function, so a second code path cannot get around it.
 */
export async function openRelationship(input: OpenRelationshipInput): Promise<OrgWriteResult> {
  const type = String(input?.type || '');
  if (!(ORG_RELATIONSHIP_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: 'Unknown relationship type: ' + type };
  }
  if (!isUuid(input?.subjectEmployeeId)) {
    return { ok: false, error: 'subjectEmployeeId must be an hr_employees id' };
  }
  const object = isUuid(input?.objectEmployeeId) ? String(input.objectEmployeeId) : null;
  if (object && object === input.subjectEmployeeId) {
    return { ok: false, error: 'A person cannot hold a relationship to themselves' };
  }
  const scopeType = input?.scopeType ? String(input.scopeType) : null;
  if (scopeType && !(ORG_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
    return { ok: false, error: 'Unknown scope type: ' + scopeType };
  }
  // TEXT, never ::uuid — departments.id is a slug in one schema file and a uuid in the other.
  const scopeId = input?.scopeId ? String(input.scopeId).trim() : null;
  const from = asOfIso({ asOf: input?.effectiveFrom ?? null });
  if (!from) return { ok: false, error: 'effectiveFrom is not a valid date' };
  const createdBy = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;
  const note = input?.note ? String(input.note).slice(0, 2000) : null;

  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      INSERT INTO org_relationships
        (type, subject_employee_id, object_employee_id, scope_type, scope_id,
         effective_from, status, created_by, note)
      VALUES
        (${type}::text, ${input.subjectEmployeeId}::uuid, ${object}::uuid,
         ${scopeType}::text, ${scopeId}::text,
         ${from}::timestamptz, 'active', ${createdBy}::uuid, ${note}::text)
      RETURNING id`);
    const list = rows(r);
    return list.length ? { ok: true, id: String(list[0].id) } : { ok: false, error: 'Insert returned no row' };
  } catch (e: any) {
    logFail('openRelationship', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not record the relationship' };
  }
}

/**
 * Close an edge as of an instant. The row stays `active` — see OrgRelationshipStatus.
 * Closing an already-closed edge is a no-op, not an error.
 */
export async function closeRelationship(
  relationshipId: string,
  opts?: AsOfOptions,
): Promise<OrgWriteResult> {
  if (!isUuid(relationshipId)) return { ok: false, error: 'Invalid relationship id' };
  const at = asOfIso(opts);
  if (!at) return { ok: false, error: 'Invalid closing date' };
  try {
    await ensureOrgGraphSchema();
    await db.execute(sql`
      UPDATE org_relationships
         SET effective_to = ${at}::timestamptz
       WHERE id = ${relationshipId}::uuid
         AND effective_to IS NULL
         AND effective_from < ${at}::timestamptz`);
    return { ok: true, id: relationshipId };
  } catch (e: any) {
    logFail('closeRelationship', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not close the relationship' };
  }
}

/**
 * Mark an edge as never having been valid. THIS IS NOT "the relationship ended" — that is
 * closeRelationship(). This is "this row should never have existed", and it removes the edge from
 * every date, including the past. Use it for a typo, never for a reorganisation.
 */
export async function revokeRelationship(
  relationshipId: string,
  reason?: string | null,
): Promise<OrgWriteResult> {
  if (!isUuid(relationshipId)) return { ok: false, error: 'Invalid relationship id' };
  const why = reason ? String(reason).slice(0, 2000) : null;
  try {
    await ensureOrgGraphSchema();
    await db.execute(sql`
      UPDATE org_relationships
         SET status = 'revoked',
             note = COALESCE(note || ' | ', '') || COALESCE(${why}::text, 'revoked')
       WHERE id = ${relationshipId}::uuid
         AND status <> 'revoked'`);
    return { ok: true, id: relationshipId };
  } catch (e: any) {
    logFail('revokeRelationship', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not revoke the relationship' };
  }
}

/**
 * Change who an employee reports to: close the open edge and open the new one AT THE SAME INSTANT.
 *
 * ONE STATEMENT, via a data-modifying CTE, because two statements can half-succeed. If the UPDATE
 * committed and the INSERT then failed, the employee would be left reporting to NOBODY — and the
 * screens that ask "who approves this person's leave" would quietly answer "no one" until somebody
 * noticed. A single statement either does both or does neither.
 *
 * THE BOUNDARY IS EXACT: the old row's effective_to and the new row's effective_from are the same
 * instant, and the in-force test is `effective_from <= at AND effective_to > at`. At that instant
 * the old edge is already out and the new one is already in — no gap where the person has no
 * manager, no overlap where they have two.
 *
 * Passing `newManagerEmployeeId = null` closes the line without opening a new one, which is how a
 * departure is recorded.
 */
export async function supersedeReportingManager(
  employeeId: string,
  newManagerEmployeeId: string | null,
  opts?: AsOfOptions & { createdByUserId?: string | null; note?: string | null },
): Promise<OrgWriteResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'Invalid employee id' };
  const mgr = isUuid(newManagerEmployeeId) ? String(newManagerEmployeeId) : null;
  if (mgr && mgr === employeeId) return { ok: false, error: 'Nobody can be their own manager' };
  const at = asOfIso(opts);
  if (!at) return { ok: false, error: 'Invalid effective date' };
  const createdBy = isUuid(opts?.createdByUserId) ? String(opts?.createdByUserId) : null;
  const note = opts?.note ? String(opts.note).slice(0, 2000) : null;

  try {
    await ensureOrgGraphSchema();

    if (!mgr) {
      await db.execute(sql`
        UPDATE org_relationships
           SET effective_to = ${at}::timestamptz
         WHERE type = 'reporting_manager'
           AND object_employee_id = ${employeeId}::uuid
           AND status = 'active'
           AND effective_to IS NULL
           AND effective_from < ${at}::timestamptz`);
      return { ok: true };
    }

    const r = await db.execute(sql`
      WITH closed AS (
        UPDATE org_relationships
           SET effective_to = ${at}::timestamptz
         WHERE type = 'reporting_manager'
           AND object_employee_id = ${employeeId}::uuid
           AND status = 'active'
           AND effective_to IS NULL
           AND effective_from < ${at}::timestamptz
        RETURNING id
      )
      INSERT INTO org_relationships
        (type, subject_employee_id, object_employee_id, effective_from, status, created_by, note)
      SELECT 'reporting_manager', ${mgr}::uuid, ${employeeId}::uuid,
             ${at}::timestamptz, 'active', ${createdBy}::uuid, ${note}::text
      WHERE NOT EXISTS (
        SELECT 1 FROM org_relationships x
         WHERE x.type = 'reporting_manager'
           AND x.object_employee_id = ${employeeId}::uuid
           AND x.subject_employee_id = ${mgr}::uuid
           AND x.status = 'active'
           AND x.effective_to IS NULL
      )
      RETURNING id`);
    const list = rows(r);
    // No returned row means the edge was already exactly this, so nothing needed to change. That is
    // a success, not a failure — re-running a correction must not be an error.
    return list.length ? { ok: true, id: String(list[0].id) } : { ok: true };
  } catch (e: any) {
    logFail('supersedeReportingManager', e);
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not change the reporting line' };
  }
}
