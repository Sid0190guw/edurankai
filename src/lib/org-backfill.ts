// src/lib/org-backfill.ts — IS THE ORGANIZATION DESCRIBED, AND IF NOT, WHO IS MISSING FROM IT.
//
// -------------------------------------------------------------------------------------------------
// WHY THIS MODULE EXISTS
// -------------------------------------------------------------------------------------------------
// org_relationships is the table every approval in this product routes through, and in production it
// is EMPTY. The consequences are visible on about twenty-five screens: leave, transfers, promotions,
// probation, claims, loans, procurement and the org chart all print "Organization Graph not yet
// initialized", and the task board offers "Everyone" and nobody else in its assignee picker.
//
// It is empty for one reason. src/lib/org-graph.ts has a complete, careful write API and almost
// nothing calls it: projects, interns, an approved transfer and an exit. NOTHING opens the ordinary
// reporting line. The one documented way to fill the graph is db/org-graph-backfill.sql, which a
// person runs by hand against production — and no screen offers it, and no screen reports whether it
// ran.
//
// THE DATA IS ALREADY THERE. hr_employees.reporting_manager_id holds real values that an
// administrator typed into the Employment tab of /admin/hr/employees/[id]. That is a per-ROW fact of
// exactly the same shape as an edge, and translating it is a migration, not a guess.
//
// WHAT THIS MODULE WILL NOT DO, EVER: read users.role. A role name is a per-USER label. Deriving a
// relationship from one makes every manager a manager of everyone, and removing that was the whole
// of Phase 1. Every candidate below comes from a data column or from the graph itself.
//
// -------------------------------------------------------------------------------------------------
// THE HALF THAT IS EASY TO FORGET
// -------------------------------------------------------------------------------------------------
// A one-time backfill fixes today and nothing else. If the employee form still writes only the
// column, the graph drifts from the next hire onward and somebody runs the backfill again in three
// months. So this module also measures DRIFT — the graph's answer against the column's answer, user
// id to user id — and the page built on it prints that number every time it is opened. Once the
// employee form writes both (it does, from this pass onward), drift is the regression test that they
// stay in step, and it should read zero.
//
// -------------------------------------------------------------------------------------------------
// A CHECK THAT COULD NOT RUN SAYS SO
// -------------------------------------------------------------------------------------------------
// Every read returns { rows, error }. An empty list because nobody is affected and an empty list
// because a table is missing are OPPOSITE facts, and a page that renders both as a reassuring "None"
// is the swallowed failure this module exists to catch, one layer up.
//
// HOUSE RULES OBSERVED: postgres-js returns PLAIN ARRAYS, never r.rows[0]; the real Postgres reason
// is on e.cause; hr_employees uses full_name; departments.id is compared ::text and never cast to
// ::uuid, because the same logical value is a varchar(50) slug in src/lib/db/schema.ts and a UUID in
// db/hr-schema.sql; no JS array is ever bound to = ANY(...); NO DDL is executed here beyond the
// schema module the graph already owns.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOrgGraphSchema } from '@/lib/org-graph-schema';
import {
  openRelationship, supersedeDepartmentHead, ORG_RELATIONSHIP_TYPES, ORG_SCOPE_TYPES,
} from '@/lib/org-graph';
import { logAudit } from '@/lib/audit';

/** postgres-js hands back a plain array; the drizzle http driver hands back { rows }. Both. */
function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function reasonOf(e: any): string { return String(e?.cause?.message || e?.message || 'unknown error'); }

/** A read that knows whether it could be answered. `error` non-null means it could NOT. */
export interface Check<T> {
  rows: T[];
  error: string | null;
}

async function check<T>(name: string, run: () => Promise<T[]>): Promise<Check<T>> {
  try {
    return { rows: await run(), error: null };
  } catch (e: any) {
    const why = reasonOf(e);
    console.error('[org-backfill] ' + name + ':', why);
    return { rows: [], error: 'This check could not be answered: ' + why };
  }
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: any): string => (v === null || v === undefined ? '' : String(v));

// =================================================================================================
// THE STATE — what a founder must learn in one screen
// =================================================================================================

export interface TypeCount {
  type: string;
  openNow: number;
  closedHistory: number;
  revoked: number;
}

export interface GraphState {
  /** The same question src/lib/org-graph.ts isInitialized() asks: is there ANY active row at all. */
  initialized: boolean;
  /**
   * The narrower question that actually matters and that isInitialized() does not ask. One
   * project_manager edge flips initialized to true globally while not a single reporting line
   * exists — after which twenty-five screens stop saying "not yet initialized" and start saying
   * "no reporting manager on record", which is honest and still wrong. This counts the reporting
   * lines in force right now.
   */
  openReportingEdges: number;
  openDepartmentHeads: number;
  openPrimaryAssignments: number;
  totalRows: number;
  activeRows: number;
  revokedRows: number;
  types: TypeCount[];
  employeesTotal: number;
  employeesActive: number;
  /** Active employees whose reporting_manager_id column carries a value. */
  withManagerColumn: number;
  /** Active employees with NO open reporting edge in the graph. The number that blocks work. */
  activeWithoutEdge: number;
  departmentsTotal: number;
  departmentsWithHead: number;
  error: string | null;
}

const EMPTY_STATE: GraphState = {
  initialized: false, openReportingEdges: 0, openDepartmentHeads: 0, openPrimaryAssignments: 0,
  totalRows: 0, activeRows: 0, revokedRows: 0, types: [],
  employeesTotal: 0, employeesActive: 0, withManagerColumn: 0, activeWithoutEdge: 0,
  departmentsTotal: 0, departmentsWithHead: 0, error: null,
};

/**
 * One round of counts, reconciling the graph against the register it was seeded from.
 *
 * This is db/org-graph-validate.sql section 1, asked from the app so that nobody has to hold a
 * database credential to learn whether the organization is described.
 */
export async function graphState(): Promise<GraphState> {
  try {
    await ensureOrgGraphSchema();

    const totals = rowsOf(await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM org_relationships) AS total_rows,
        (SELECT COUNT(*) FROM org_relationships WHERE status = 'active') AS active_rows,
        (SELECT COUNT(*) FROM org_relationships WHERE status = 'revoked') AS revoked_rows,
        (SELECT COUNT(*) FROM org_relationships
          WHERE type = 'reporting_manager' AND status = 'active' AND effective_to IS NULL)
          AS open_reporting,
        (SELECT COUNT(*) FROM org_relationships
          WHERE type = 'department_head' AND status = 'active' AND effective_to IS NULL)
          AS open_heads,
        (SELECT COUNT(*) FROM org_employee_assignments
          WHERE is_primary = TRUE AND status = 'active' AND effective_to IS NULL)
          AS open_primary,
        (SELECT COUNT(*) FROM hr_employees) AS employees_total,
        (SELECT COUNT(*) FROM hr_employees WHERE is_active = TRUE) AS employees_active,
        (SELECT COUNT(*) FROM hr_employees
          WHERE is_active = TRUE AND reporting_manager_id IS NOT NULL) AS with_column,
        (SELECT COUNT(*) FROM hr_employees e
          WHERE e.is_active = TRUE AND NOT EXISTS (
            SELECT 1 FROM org_relationships r
             WHERE r.type = 'reporting_manager' AND r.object_employee_id = e.id
               AND r.status = 'active' AND r.effective_to IS NULL)) AS active_without_edge,
        (SELECT COUNT(*) FROM departments) AS departments_total,
        (SELECT COUNT(DISTINCT r.scope_id) FROM org_relationships r
          WHERE r.type = 'department_head' AND r.scope_type = 'department'
            AND r.status = 'active' AND r.effective_to IS NULL
            AND r.scope_id IS NOT NULL) AS departments_with_head`))[0] || {};

    const byType = rowsOf(await db.execute(sql`
      SELECT type,
             COUNT(*) FILTER (WHERE status = 'active' AND effective_to IS NULL) AS open_now,
             COUNT(*) FILTER (WHERE status = 'active' AND effective_to IS NOT NULL) AS closed_history,
             COUNT(*) FILTER (WHERE status = 'revoked') AS revoked
        FROM org_relationships
       GROUP BY type
       ORDER BY type ASC`));

    return {
      initialized: num(totals.active_rows) > 0,
      openReportingEdges: num(totals.open_reporting),
      openDepartmentHeads: num(totals.open_heads),
      openPrimaryAssignments: num(totals.open_primary),
      totalRows: num(totals.total_rows),
      activeRows: num(totals.active_rows),
      revokedRows: num(totals.revoked_rows),
      types: byType.map((t: any) => ({
        type: str(t.type),
        openNow: num(t.open_now),
        closedHistory: num(t.closed_history),
        revoked: num(t.revoked),
      })),
      employeesTotal: num(totals.employees_total),
      employeesActive: num(totals.employees_active),
      withManagerColumn: num(totals.with_column),
      activeWithoutEdge: num(totals.active_without_edge),
      departmentsTotal: num(totals.departments_total),
      departmentsWithHead: num(totals.departments_with_head),
      error: null,
    };
  } catch (e: any) {
    const why = reasonOf(e);
    console.error('[org-backfill] graphState:', why);
    // Fail closed and SAY SO. A zeroed dashboard that does not admit it could not read is how a
    // broken connection reads as an empty organization.
    return { ...EMPTY_STATE, error: 'The graph could not be counted: ' + why };
  }
}

// =================================================================================================
// THE PREVIEW — who would get an edge, who would not, and why
// =================================================================================================

export interface PlannedEdge {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string;
  managerEmployeeId: string;
  managerName: string;
  /** Reconstructed from the joining date where we have one. A reasonable date, not a recovered one. */
  effectiveFrom: string;
  effectiveFromSource: string;
}

export interface SkippedEdge {
  employeeId: string;
  employeeName: string;
  currentManagerName: string;
  columnManagerName: string;
  /** True when the graph and the column name DIFFERENT people. The backfill leaves the graph alone. */
  disagrees: boolean;
}

/**
 * THE ROWS THE BACKFILL WOULD CREATE, computed exactly as db/org-graph-backfill.sql step 1 computes
 * them — same LATERAL, same guards — so the preview cannot promise something the apply will not do.
 *
 * THE ID-SPACE TRANSLATION IS THE WHOLE DIFFICULTY. reporting_manager_id holds a USERS id
 * (db/hr-schema.sql:114-118). The graph holds hr_employees ids. So every value maps
 * users.id -> hr_employees.user_id -> hr_employees.id, and a manager who is a user with no employee
 * record CANNOT be an edge — those people are counted by unmappableManagers() below and named on the
 * page, never silently dropped.
 *
 * CROSS JOIN LATERAL ... LIMIT 1, not a plain join: one user can own more than one hr_employees row
 * (a rehire, a duplicate), and a plain join emits one edge per duplicate and then collides with
 * org_relationships_one_open_manager_uq.
 */
export async function plannedReportingEdges(): Promise<Check<PlannedEdge>> {
  return check<PlannedEdge>('plannedReportingEdges', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id            AS employee_id,
             e.full_name     AS employee_name,
             e.employee_code AS employee_code,
             d.name          AS department_name,
             mgr.id          AS manager_employee_id,
             mgr.full_name   AS manager_name,
             COALESCE(e.joining_date::timestamptz, e.created_at, NOW()) AS effective_from,
             CASE WHEN e.joining_date IS NOT NULL THEN 'joining date'
                  WHEN e.created_at IS NOT NULL THEN 'record created'
                  ELSE 'today' END AS effective_from_source
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        CROSS JOIN LATERAL (
          SELECT m.id, m.full_name
            FROM hr_employees m
           WHERE m.user_id = e.reporting_manager_id
           ORDER BY m.is_active DESC, m.created_at ASC
           LIMIT 1
        ) mgr
       WHERE e.reporting_manager_id IS NOT NULL
         AND mgr.id <> e.id
         AND NOT EXISTS (
           SELECT 1 FROM org_relationships r
            WHERE r.type = 'reporting_manager'
              AND r.object_employee_id = e.id
              AND r.status = 'active'
              AND r.effective_to IS NULL)
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      employeeCode: str(x.employee_code),
      departmentName: str(x.department_name),
      managerEmployeeId: str(x.manager_employee_id),
      managerName: str(x.manager_name),
      effectiveFrom: x.effective_from ? new Date(x.effective_from).toISOString() : '',
      effectiveFromSource: str(x.effective_from_source),
    }));
  });
}

/**
 * The people the backfill would step over because they ALREADY have an open reporting edge. Listing
 * them is not decoration: `disagrees` marks the ones where the graph and the column name different
 * people, and for those the backfill does nothing at all. That is correct — the graph is the record
 * and a migration must not overwrite it — but somebody has to know, because the employee form is
 * what will have to settle it.
 */
export async function alreadyOnTheGraph(): Promise<Check<SkippedEdge>> {
  return check<SkippedEdge>('alreadyOnTheGraph', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id           AS employee_id,
             e.full_name    AS employee_name,
             g.full_name    AS graph_manager_name,
             c.full_name    AS column_manager_name,
             (e.reporting_manager_id IS DISTINCT FROM g.user_id) AS disagrees
        FROM hr_employees e
        JOIN org_relationships r
          ON r.type = 'reporting_manager' AND r.object_employee_id = e.id
         AND r.status = 'active' AND r.effective_to IS NULL
        JOIN hr_employees g ON g.id = r.subject_employee_id
        LEFT JOIN LATERAL (
          SELECT m.full_name FROM hr_employees m
           WHERE m.user_id = e.reporting_manager_id
           ORDER BY m.is_active DESC, m.created_at ASC LIMIT 1
        ) c ON TRUE
       WHERE e.reporting_manager_id IS NOT NULL
       ORDER BY (e.reporting_manager_id IS DISTINCT FROM g.user_id) DESC, e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      currentManagerName: str(x.graph_manager_name),
      columnManagerName: str(x.column_manager_name),
      disagrees: x.disagrees === true,
    }));
  });
}

export interface PlannedPosting {
  employeeId: string;
  employeeName: string;
  departmentId: string;
  departmentName: string;
}

/**
 * db/org-graph-backfill.sql step 2 — one open PRIMARY posting per person, carrying their department.
 *
 * department_id is read ::text and written to a TEXT column. Never ::uuid: departments.id is a
 * varchar(50) slug in one schema file and a UUID in the other, and a cast throws on the first slug.
 */
export async function plannedPostings(): Promise<Check<PlannedPosting>> {
  return check<PlannedPosting>('plannedPostings', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             e.department_id::text AS department_id, d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.department_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM org_employee_assignments a
            WHERE a.employee_id = e.id AND a.is_primary = TRUE
              AND a.status = 'active' AND a.effective_to IS NULL)
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      departmentId: str(x.department_id),
      departmentName: str(x.department_name),
    }));
  });
}

// =================================================================================================
// THE PROBLEMS — the valuable half. Each one names what it BLOCKS and who can end it.
// =================================================================================================

export interface PersonProblem {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  detail: string;
}

/**
 * ACTIVE EMPLOYEES WITH NO REPORTING LINE, in the graph OR in the column.
 *
 * THIS IS NOT A FAULT IN THE GRAPH. It is a fact about the organization, and no migration can invent
 * it: somebody has to open the employee record and say who this person reports to. The graph is
 * telling the truth about a gap that exists in the register. What it blocks is concrete and is
 * printed next to every name on the page.
 */
export async function employeesWithNoManagerAnywhere(): Promise<Check<PersonProblem>> {
  return check<PersonProblem>('employeesWithNoManagerAnywhere', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             e.employee_code AS employee_code,
             COALESCE(e.designation, '') AS designation,
             COALESCE(d.name, '') AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = TRUE
         AND e.reporting_manager_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM org_relationships r
            WHERE r.type = 'reporting_manager' AND r.object_employee_id = e.id
              AND r.status = 'active' AND r.effective_to IS NULL)
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      employeeCode: str(x.employee_code),
      detail: [str(x.designation), str(x.department_name)].filter(Boolean).join(' · ')
        || 'no designation or department recorded',
    }));
  });
}

export interface UnmappableManager {
  employeeId: string;
  employeeName: string;
  managerUserId: string;
  managerAccountName: string;
  managerEmail: string;
  /** 'no-employee-record' or 'no-such-user'. */
  kind: string;
}

/**
 * MANAGERS WHO CANNOT BECOME AN EDGE. Two shapes, both from db/org-graph-validate.sql section 2:
 *
 *   no-employee-record  the manager is a real account with no hr_employees row. The graph is keyed
 *                       on employee ids, so there is nothing to point at. Give them an employee
 *                       record and the backfill picks them up on the next run.
 *   no-such-user        the column points at a users row that does not exist. There is no foreign
 *                       key on that column, so this is possible and it is silent. Somebody has to
 *                       re-pick a manager on the employee record.
 *
 * These people are SKIPPED by the backfill and counted here rather than lost. While they are on this
 * list the compatibility layer in org-graph.ts is still answering for them from the column, which is
 * why the column cannot be retired yet.
 */
export async function unmappableManagers(): Promise<Check<UnmappableManager>> {
  return check<UnmappableManager>('unmappableManagers', async () => {
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             e.reporting_manager_id::text AS manager_user_id,
             COALESCE(u.name, '') AS manager_account_name,
             COALESCE(u.email, '') AS manager_email,
             CASE WHEN u.id IS NULL THEN 'no-such-user' ELSE 'no-employee-record' END AS kind
        FROM hr_employees e
        LEFT JOIN users u ON u.id = e.reporting_manager_id
       WHERE e.reporting_manager_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM hr_employees m WHERE m.user_id = e.reporting_manager_id)
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      managerUserId: str(x.manager_user_id),
      managerAccountName: str(x.manager_account_name),
      managerEmail: str(x.manager_email),
      kind: str(x.kind),
    }));
  });
}

/** Somebody recorded as their own manager. The table CHECK would refuse the edge outright. */
export async function selfManagers(): Promise<Check<PersonProblem>> {
  return check<PersonProblem>('selfManagers', async () => {
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             e.employee_code AS employee_code
        FROM hr_employees e
       WHERE e.reporting_manager_id IS NOT NULL
         AND e.reporting_manager_id = e.user_id
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      employeeCode: str(x.employee_code),
      detail: 'recorded as their own reporting manager',
    }));
  });
}

export interface DepartmentGap {
  departmentId: string;
  departmentName: string;
  headcount: number;
}

/**
 * DEPARTMENTS WITH NOBODY HEADING THEM.
 *
 * There is no data column anywhere to seed this from — `departments` carries no head in either
 * schema file and hr_employees has no is_head flag — so db/org-graph-backfill.sql deliberately does
 * not invent one. The only signal that ever existed in the product was users.role = 'department_head'
 * paired with users.assigned_department_id, and the leadership half of that pair is a ROLE NAME.
 * Reading it here would re-couple the graph to the thing Phase 1 removed. So a head is ENTERED, on
 * this page, by a person.
 */
export async function departmentsWithoutHead(): Promise<Check<DepartmentGap>> {
  return check<DepartmentGap>('departmentsWithoutHead', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT d.id::text AS department_id, d.name AS department_name,
             (SELECT COUNT(*) FROM hr_employees e
               WHERE e.department_id::text = d.id::text AND e.is_active = TRUE) AS headcount
        FROM departments d
       WHERE NOT EXISTS (
         SELECT 1 FROM org_relationships r
          WHERE r.type = 'department_head' AND r.scope_type = 'department'
            AND r.scope_id = d.id::text
            AND r.status = 'active' AND r.effective_to IS NULL)
       ORDER BY d.name ASC`);
    return rowsOf(r).map((x: any) => ({
      departmentId: str(x.department_id),
      departmentName: str(x.department_name),
      headcount: num(x.headcount),
    }));
  });
}

export interface CycleHop {
  employeeId: string;
  employeeName: string;
}

/**
 * CYCLES IN THE REPORTING LINE. A loop makes every approval chain infinite — a request escalating
 * past somebody arrives back at them and "who approves this" has no answer at any depth.
 *
 * There is NO cycle prevention in the write path: openRelationship() and supersedeReportingManager()
 * will happily create A to B to A. Safety lives on the read side (a visited-path array, the depth cap
 * of twelve, and a de-duplicating Set), which means a cycle does not hang a page — it truncates a
 * chain, and a truncated chain looks exactly like a complete one on screen. So it has to be reported.
 *
 * The `= ANY(w.path)` below is a SQL-side array built inside the recursive CTE, not a JS array bound
 * from the app — that binding is the one this driver refuses.
 */
export async function reportingCycles(): Promise<Check<CycleHop>> {
  return check<CycleHop>('reportingCycles', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT r.object_employee_id AS start_id,
               r.subject_employee_id AS cursor_id,
               1 AS depth,
               ARRAY[r.object_employee_id] AS path
          FROM org_relationships r
         WHERE r.type = 'reporting_manager' AND r.status = 'active' AND r.effective_to IS NULL
           AND r.object_employee_id IS NOT NULL
        UNION ALL
        SELECT w.start_id, r.subject_employee_id, w.depth + 1, w.path || r.object_employee_id
          FROM walk w
          JOIN org_relationships r
            ON r.object_employee_id = w.cursor_id
           AND r.type = 'reporting_manager' AND r.status = 'active' AND r.effective_to IS NULL
         WHERE w.depth < 20
           AND NOT (r.object_employee_id = ANY(w.path))
      )
      SELECT DISTINCT w.start_id AS employee_id, e.full_name AS employee_name
        FROM walk w
        JOIN hr_employees e ON e.id = w.start_id
       WHERE w.cursor_id = w.start_id
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
    }));
  });
}

export interface ShapeFault {
  relationshipId: string;
  type: string;
  fault: string;
}

/**
 * VOCABULARY AND SHAPE FAULTS — db/org-graph-validate.sql sections 6 and 7, asked from the app.
 *
 * There are deliberately no CHECK constraints on type, status or scope_type: a CHECK cannot be added
 * with IF NOT EXISTS and this project has no migration runner. The vocabulary is enforced in
 * TypeScript and audited here. The one to worry about is a status of 'superseded' — it would mean
 * somebody closed an edge by changing the status instead of setting effective_to, which erases the
 * row from every historical query and takes the evidence behind past approvals with it.
 *
 * The type and scope lists are built as individual placeholders, never bound as a JS array: this
 * driver refuses ANY(array) with "op ANY/ALL (array) requires array on right side".
 */
export async function shapeFaults(): Promise<Check<ShapeFault>> {
  return check<ShapeFault>('shapeFaults', async () => {
    await ensureOrgGraphSchema();
    const knownTypes = sql.join(ORG_RELATIONSHIP_TYPES.map((t) => sql`${t}`), sql`, `);
    const knownScopes = sql.join(ORG_SCOPE_TYPES.map((s) => sql`${s}`), sql`, `);
    const r = await db.execute(sql`
      SELECT id::text AS id, type,
             CASE
               WHEN type NOT IN (${knownTypes})
                 THEN 'the relationship type is not one this product knows'
               WHEN status NOT IN ('active', 'revoked')
                 THEN 'the status is not active or revoked, so history cannot be read from it'
               WHEN scope_type IS NOT NULL AND scope_type NOT IN (${knownScopes})
                 THEN 'the scope type is not one this product knows'
               WHEN object_employee_id IS NULL AND COALESCE(scope_id, '') = ''
                 THEN 'the row points at nobody and at no scope, so it answers nothing'
               WHEN type = 'department_head'
                    AND (scope_type IS DISTINCT FROM 'department' OR COALESCE(scope_id, '') = '')
                 THEN 'a department head with no department in scope'
               WHEN type = 'approval_owner'
                    AND (scope_type IS DISTINCT FROM 'approval_domain' OR COALESCE(scope_id, '') = '')
                 THEN 'an approval owner with no approval domain in scope'
               WHEN effective_to IS NOT NULL AND effective_to <= effective_from
                 THEN 'the row ends before or when it begins'
               ELSE ''
             END AS fault
        FROM org_relationships
       ORDER BY created_at DESC
       LIMIT 200`);
    return rowsOf(r)
      .filter((x: any) => str(x.fault).length > 0)
      .map((x: any) => ({ relationshipId: str(x.id), type: str(x.type), fault: str(x.fault) }));
  });
}

/** Edges whose subject or object is no longer on the register. There is no FK, on purpose. */
export async function orphanEdges(): Promise<Check<ShapeFault>> {
  return check<ShapeFault>('orphanEdges', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT r.id::text AS id, r.type AS type,
             CASE WHEN s.id IS NULL THEN 'the person who holds it is no longer on the register'
                  ELSE 'the person it is about is no longer on the register' END AS fault
        FROM org_relationships r
        LEFT JOIN hr_employees s ON s.id = r.subject_employee_id
        LEFT JOIN hr_employees o ON o.id = r.object_employee_id
       WHERE r.status = 'active' AND r.effective_to IS NULL
         AND (s.id IS NULL OR (r.object_employee_id IS NOT NULL AND o.id IS NULL))
       ORDER BY r.created_at DESC
       LIMIT 100`);
    return rowsOf(r).map((x: any) => ({
      relationshipId: str(x.id), type: str(x.type), fault: str(x.fault),
    }));
  });
}

// =================================================================================================
// DRIFT — the reason this page is worth opening again in three months
// =================================================================================================

export interface DriftRow {
  employeeId: string;
  employeeName: string;
  graphManagerName: string;
  columnManagerName: string;
}

/**
 * WHERE THE GRAPH AND THE COLUMN DISAGREE. db/org-graph-validate.sql section 8.
 *
 * THE COMPARISON IS USER ID TO USER ID and getting it backwards reports every row as drift and looks
 * like a catastrophe: e.reporting_manager_id holds a USERS id, so it is compared against the graph
 * manager's hr_employees.user_id, never against their employee id.
 *
 * Until this pass nothing wrote the graph from the ordinary employee form, so drift only grew. From
 * this pass the Employment tab writes both, and this number becomes the regression test that they
 * stay in step. It should read zero. A number that climbs means something is writing the column
 * alone again.
 */
export async function managerDrift(): Promise<Check<DriftRow>> {
  return check<DriftRow>('managerDrift', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             g.full_name AS graph_manager_name,
             COALESCE(c.full_name, u.name, '') AS column_manager_name
        FROM hr_employees e
        JOIN org_relationships r
          ON r.type = 'reporting_manager' AND r.object_employee_id = e.id
         AND r.status = 'active' AND r.effective_to IS NULL
        JOIN hr_employees g ON g.id = r.subject_employee_id
        LEFT JOIN LATERAL (
          SELECT m.full_name FROM hr_employees m
           WHERE m.user_id = e.reporting_manager_id
           ORDER BY m.is_active DESC, m.created_at ASC LIMIT 1
        ) c ON TRUE
        LEFT JOIN users u ON u.id = e.reporting_manager_id
       WHERE e.reporting_manager_id IS DISTINCT FROM g.user_id
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      graphManagerName: str(x.graph_manager_name),
      columnManagerName: str(x.column_manager_name) || 'nobody',
    }));
  });
}

/** Leavers whose reporting line is still open. Their approvals still route to somebody who has gone. */
export async function leaversStillOnTheGraph(): Promise<Check<PersonProblem>> {
  return check<PersonProblem>('leaversStillOnTheGraph', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             e.employee_code AS employee_code,
             COALESCE(e.last_working_day, e.exit_date)::text AS ended_on
        FROM hr_employees e
       WHERE e.is_active = FALSE
         AND EXISTS (
           SELECT 1 FROM org_relationships r
            WHERE r.object_employee_id = e.id
              AND r.status = 'active' AND r.effective_to IS NULL)
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      employeeCode: str(x.employee_code),
      detail: str(x.ended_on) ? 'left on ' + str(x.ended_on) : 'no last working day recorded',
    }));
  });
}

// =================================================================================================
// THE APPLY
// =================================================================================================

export interface ApplyFailure {
  who: string;
  reason: string;
}

export interface ApplyOutcome {
  attempted: number;
  created: number;
  failures: ApplyFailure[];
  /** Non-null when the candidate list itself could not be read — nothing was attempted. */
  error: string | null;
}

/**
 * SEED THE REPORTING LINES.
 *
 * ROW BY ROW, through openRelationship(), and not as one set-based INSERT. A single INSERT would be
 * faster and would tell the operator nothing useful: one bad row aborts the statement and forty-one
 * good rows are lost with it, and the screen can only say "it failed". Per row, a failure is one
 * person with one reason next to their name, and everybody else is still recorded.
 *
 * THE CANDIDATE LIST IS RECOMPUTED HERE, not carried from the preview through the form. A posted
 * list could name anybody; recomputing means this can only ever write the edges the same query
 * already proved were missing. Nothing about who becomes whose manager comes from the request.
 *
 * IDEMPOTENT. The NOT EXISTS guard is in the candidate query and the database holds
 * org_relationships_one_open_manager_uq underneath it, so pressing the button twice writes nothing
 * the second time — and if a concurrent write got there first, the unique index refuses that one row
 * and its reason is printed rather than swallowed.
 */
export async function applyReportingBackfill(userId: string | null): Promise<ApplyOutcome> {
  const planned = await plannedReportingEdges();
  if (planned.error) return { attempted: 0, created: 0, failures: [], error: planned.error };

  const failures: ApplyFailure[] = [];
  let created = 0;

  for (const p of planned.rows) {
    const res = await openRelationship({
      type: 'reporting_manager',
      subjectEmployeeId: p.managerEmployeeId,
      objectEmployeeId: p.employeeId,
      effectiveFrom: p.effectiveFrom || null,
      createdByUserId: userId,
      // The stamp db/org-graph-rollback.sql stage 1 matches on. Without it the rollback cannot tell
      // a seeded row from one a person entered by hand, and stage 1 stops being reversible.
      note: 'backfill:reporting_manager_id (recorded from /admin/org/graph)',
    });
    if (res.ok) created += 1;
    else {
      failures.push({
        who: p.employeeName + ' reporting to ' + p.managerName,
        reason: res.error || 'no reason was given',
      });
    }
  }

  await logAudit({
    userId: userId || null,
    action: 'org_graph.backfill_reporting',
    entity: 'org_relationships',
    diff: { attempted: planned.rows.length, created, failed: failures.length },
  });

  return { attempted: planned.rows.length, created, failures, error: null };
}

/**
 * SEED THE PRIMARY DEPARTMENT POSTINGS — db/org-graph-backfill.sql step 2.
 *
 * WHY NOT src/lib/org-structure.ts assignEmployee(). That function refuses a posting with neither a
 * team nor a position ("recording neither says nothing"), which is the right rule for a person
 * filling in a form and the wrong one for this: the backfill records exactly the department the
 * employee register already holds and nothing more. So the INSERT is here, in the shape the SQL file
 * uses, rather than bending that function's rule.
 *
 * BE HONEST ABOUT WHAT THIS BUYS. Nothing on the organisation chart draws these yet — the chart's
 * team dimension is keyed on team_id, which a department-only posting does not carry. They exist so
 * the graph and the employee register agree about which department a person sits in, and so the
 * counts in db/org-graph-validate.sql line up whether the seed came from the SQL file or this page.
 *
 * department_id is TEXT on both sides and is never cast to ::uuid.
 */
export async function applyDepartmentPostings(userId: string | null): Promise<ApplyOutcome> {
  const planned = await plannedPostings();
  if (planned.error) return { attempted: 0, created: 0, failures: [], error: planned.error };

  const failures: ApplyFailure[] = [];
  let created = 0;
  const by = userId && userId.length ? userId : null;

  for (const p of planned.rows) {
    try {
      const r = await db.execute(sql`
        INSERT INTO org_employee_assignments
          (employee_id, position_id, team_id, department_id, allocation_pct, is_primary,
           effective_from, status, created_by)
        SELECT e.id, NULL::uuid, NULL::uuid, ${p.departmentId}::text, 100, TRUE,
               COALESCE(e.joining_date::timestamptz, e.created_at, NOW()), 'active', ${by}::uuid
          FROM hr_employees e
         WHERE e.id = ${p.employeeId}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM org_employee_assignments a
              WHERE a.employee_id = e.id AND a.is_primary = TRUE
                AND a.status = 'active' AND a.effective_to IS NULL)
        RETURNING id`);
      if (rowsOf(r).length) created += 1;
      else {
        failures.push({
          who: p.employeeName,
          reason: 'nothing was written — a primary posting already existed by the time this ran, or the employee record has gone',
        });
      }
    } catch (e: any) {
      // NEVER SWALLOWED in a write path. One person's row failing must not stop the other forty.
      const why = reasonOf(e);
      console.error('[org-backfill] applyDepartmentPostings ' + p.employeeId + ':', why);
      failures.push({ who: p.employeeName, reason: why });
    }
  }

  await logAudit({
    userId: by,
    action: 'org_graph.backfill_postings',
    entity: 'org_employee_assignments',
    diff: { attempted: planned.rows.length, created, failed: failures.length },
  });

  return { attempted: planned.rows.length, created, failures, error: null };
}

export interface HeadCandidate {
  employeeId: string;
  employeeName: string;
  designation: string;
  departmentName: string;
}

/**
 * WHO MAY BE NAMED A DEPARTMENT HEAD: active employees with a linked account.
 *
 * The graph is keyed on employee ids, so a head with no hr_employees row cannot be an edge at all.
 * The linked account is required for a different reason: every screen that asks "am I the head of
 * this department" asks it about the SIGNED-IN user, and a head with no login can never match one.
 */
export async function headCandidates(): Promise<Check<HeadCandidate>> {
  return check<HeadCandidate>('headCandidates', async () => {
    const r = await db.execute(sql`
      SELECT e.id AS employee_id, e.full_name AS employee_name,
             COALESCE(e.designation, '') AS designation,
             COALESCE(d.name, '') AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = TRUE AND e.user_id IS NOT NULL
       ORDER BY e.full_name ASC`);
    return rowsOf(r).map((x: any) => ({
      employeeId: str(x.employee_id),
      employeeName: str(x.employee_name),
      designation: str(x.designation),
      departmentName: str(x.department_name),
    }));
  });
}

export interface CurrentHead {
  departmentId: string;
  departmentName: string;
  relationshipId: string;
  headEmployeeId: string;
  headName: string;
  since: string;
}

/** Who heads what, right now. The list the page prints beside the form that changes it. */
export async function currentDepartmentHeads(): Promise<Check<CurrentHead>> {
  return check<CurrentHead>('currentDepartmentHeads', async () => {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT r.id::text AS relationship_id,
             r.scope_id AS department_id,
             COALESCE(d.name, r.scope_id) AS department_name,
             e.id AS head_employee_id, e.full_name AS head_name,
             r.effective_from AS since
        FROM org_relationships r
        LEFT JOIN departments d ON d.id::text = r.scope_id
        LEFT JOIN hr_employees e ON e.id = r.subject_employee_id
       WHERE r.type = 'department_head' AND r.scope_type = 'department'
         AND r.status = 'active' AND r.effective_to IS NULL
       ORDER BY COALESCE(d.name, r.scope_id) ASC`);
    return rowsOf(r).map((x: any) => ({
      departmentId: str(x.department_id),
      departmentName: str(x.department_name),
      relationshipId: str(x.relationship_id),
      headEmployeeId: str(x.head_employee_id),
      headName: str(x.head_name) || 'an employee record that no longer exists',
      since: x.since ? new Date(x.since).toISOString() : '',
    }));
  });
}

/**
 * Record (or replace) the head of a department, through the graph's own writer.
 *
 * The department id is checked against the register before it is written: a scope_id matching no
 * department scopes the edge to nothing, and db/org-graph-validate.sql section 7 flags exactly that.
 * The employee is checked the same way the employee form checks its own list — a posted id could
 * otherwise name anybody at all, and naming a department head is not a cosmetic act.
 */
export async function recordDepartmentHead(input: {
  departmentId: string;
  employeeId: string;
  userId: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const deptId = String(input?.departmentId || '').trim();
  const empId = String(input?.employeeId || '').trim();
  if (!deptId) return { ok: false, error: 'Choose a department. Nothing was saved.' };
  if (!empId) return { ok: false, error: 'Choose the person who heads it. Nothing was saved.' };

  try {
    const known = rowsOf(await db.execute(sql`
      SELECT 1 AS ok FROM departments WHERE id::text = ${deptId}::text LIMIT 1`));
    if (!known.length) {
      return { ok: false, error: 'That department is not on the register, so an edge scoped to it would answer for nothing. Nothing was saved.' };
    }
    const person = rowsOf(await db.execute(sql`
      SELECT full_name FROM hr_employees
       WHERE id = ${empId}::uuid AND is_active = TRUE AND user_id IS NOT NULL LIMIT 1`));
    if (!person.length) {
      return { ok: false, error: 'That person is not an active employee with a linked sign-in, so no screen could ever recognise them as the head. Nothing was saved.' };
    }
  } catch (e: any) {
    // NOT SWALLOWED. Refusing is the safe direction: writing a relationship whose subject could not
    // be checked is the outcome that cannot be withdrawn.
    const why = reasonOf(e);
    console.error('[org-backfill] recordDepartmentHead check:', why);
    return { ok: false, error: 'The department and the person could not be checked just now, so nothing was saved: ' + why };
  }

  const res = await supersedeDepartmentHead(deptId, empId, {
    createdByUserId: input.userId,
    note: 'entered on /admin/org/graph',
  });
  if (!res.ok) return { ok: false, error: res.error || 'The department head was not recorded.' };

  await logAudit({
    userId: input.userId || null,
    action: 'org_graph.set_department_head',
    entity: 'org_relationships',
    entityId: res.id,
    diff: { departmentId: deptId, employeeId: empId },
  });
  return { ok: true };
}

/**
 * End a department head's line without naming a replacement.
 *
 * CLOSES, never revokes. Revoking says the row should never have existed and removes it from every
 * date including the past, which would rewrite who was accountable for approvals already given.
 */
export async function clearDepartmentHead(
  departmentId: string, userId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const deptId = String(departmentId || '').trim();
  if (!deptId) return { ok: false, error: 'No department was named. Nothing was changed.' };
  const res = await supersedeDepartmentHead(deptId, null, { createdByUserId: userId });
  if (!res.ok) return { ok: false, error: res.error || 'The head was not stood down.' };
  await logAudit({
    userId: userId || null,
    action: 'org_graph.clear_department_head',
    entity: 'org_relationships',
    diff: { departmentId: deptId },
  });
  return { ok: true };
}

// =================================================================================================
// PURE HELPERS — the sentences the page prints. Pure so they can be tested with no database.
// =================================================================================================

/** How a relationship type reads in a sentence, without turning it into a role name. */
export function relationshipLabel(type: string): string {
  const map: Record<string, string> = {
    reporting_manager: 'Reporting manager',
    department_head: 'Department head',
    team_lead: 'Team lead',
    functional_manager: 'Functional manager',
    project_manager: 'Project manager',
    mentor: 'Mentor',
    reviewer: 'Reviewer',
    executive_sponsor: 'Executive sponsor',
    temporary_delegate: 'Temporary delegate',
    approval_owner: 'Approval owner',
  };
  return map[String(type)] || String(type || 'unknown');
}

/**
 * WHAT A MISSING REPORTING LINE BLOCKS, in plain words and named per person.
 *
 * "No reporting manager" is a shrug. These are the things that actually stop, and every one of them
 * is a real halt in this product rather than a warning: workflow.ts refuses to route a request it
 * cannot name an approver for, and the task board offers no assignee it cannot scope.
 */
export function blockedByNoManager(name: string): string[] {
  const who = String(name || '').trim() || 'This person';
  return [
    who + ' cannot be offered as an assignee on the task board, so nobody can give them work.',
    who + ' has nobody to approve a leave request; one raised now is recorded and halted.',
    who + ' has nobody to approve a timesheet, an overtime claim or an attendance correction.',
    who + ' has nobody to approve an expense claim, a salary advance or a loan.',
    'A probation confirmation, a transfer or a promotion for ' + who + ' cannot be routed to anybody.',
    'No relationship-owned onboarding step for ' + who + ' can find an owner.',
  ];
}

/** What a department with no head blocks. Fewer things, and worth being exact about which. */
export function blockedByNoDepartmentHead(name: string): string[] {
  const dept = String(name || '').trim() || 'This department';
  return [
    'Learning progress for ' + dept + ' cannot be seen by anybody: that screen resolves its audience from a department_head edge.',
    'A department-scoped announcement cannot resolve who it is addressed to.',
    'Anything escalating past a reporting manager inside ' + dept + ' has no next step.',
  ];
}

/**
 * The sentence the apply button carries. It STATES THE COUNT IT IS ABOUT TO CREATE, because a button
 * that says "Apply" on a page that writes to production tells the person pressing it nothing.
 */
export function applyButtonLabel(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return 'Nothing to record';
  if (n === 1) return 'Record 1 reporting line';
  return 'Record ' + n + ' reporting lines';
}

/**
 * The honest one-line verdict on an apply, partial failures included.
 *
 * PARTIAL SUCCESS HAS ITS OWN SENTENCE and it is the one that matters: "12 of 42 recorded" tells the
 * operator that thirty people are still unrouted, which "applied" would not. The names and reasons
 * are printed underneath it; this is only the headline.
 */
export function outcomeSentence(o: ApplyOutcome, noun = 'reporting line'): string {
  const plural = (n: number) => n + ' ' + noun + (n === 1 ? '' : 's');
  if (o.error) return 'Nothing was attempted: ' + o.error;
  if (o.attempted === 0) return 'There was nothing left to record. Nothing was written.';
  if (o.failures.length === 0) {
    return plural(o.created) + ' recorded. Every one of them was written; none was skipped.';
  }
  return o.created + ' of ' + o.attempted + ' recorded. ' + o.failures.length
    + ' did not go in, and each one says why below. The rest are on the graph and are in force now.';
}
