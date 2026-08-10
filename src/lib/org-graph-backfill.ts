// src/lib/org-graph-backfill.ts — SEED THE ORGANIZATION GRAPH FROM THE COLUMN IT REPLACES,
// FROM INSIDE THE PRODUCT, IN TWO PHASES, THE FIRST OF WHICH WRITES NOTHING.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT IS NOT
// =================================================================================================
//
// This is db/org-graph-backfill.sql, in TypeScript, through the write API in src/lib/org-graph.ts.
// It is NOT a second definition of what a backfilled edge is. Every rule below was read out of that
// file and is stated here in the same order, with the same guards:
//
//   STEP 1  reporting lines   hr_employees.reporting_manager_id -> a reporting_manager edge
//   STEP 2  primary postings  hr_employees.department_id        -> an open primary assignment
//   STEP 3  leavers           an exit date                      -> close the reporting edge
//
// WHAT IT READS: hr_employees.reporting_manager_id. An existing DATA column, holding a value an
// administrator typed into the Employment tab of /admin/hr/employees/[id]. It is a per-ROW fact —
// "this employee's manager is that person" — which is the same shape as an edge.
//
// WHAT IT NEVER READS: users.role. A role name is a per-USER label. Deriving a relationship from
// one makes every manager a manager of everyone, which is precisely what Phase 1 removed. Reading
// the data column is a migration; reading the role would be the regression. Department heads have
// no data column at all and are therefore NOT backfilled here — they are entered on a screen.
//
// =================================================================================================
// THE HALF THAT IS EASY TO FORGET
// =================================================================================================
//
// A backfill fixes today and nothing else. If the Employment tab still writes only the column, the
// graph drifts from the next hire onward and somebody runs this again in three months. That is what
// reconcile() at the bottom of this file is for: it compares the column against the graph in BOTH
// directions and reports who disagrees, by name. Run once, it says whether the backfill finished.
// Run months later, it says whether the ongoing writer is actually working.
//
// =================================================================================================
// TWO PHASES, ALWAYS
// =================================================================================================
//
//   previewBackfill()  reads, plans, writes NOTHING, and lists every problem BY NAME. Forty-two
//                      employees is a list a founder can read; "three problems" is not.
//   applyBackfill()    creates only what the preview promised, ROW BY ROW, continuing past a
//                      failure, and returns exactly which succeeded and which did not and why.
//
// A PARTIAL RESULT IS THE NORMAL CASE. It is never reported as total success or total failure: the
// outcome carries created, failed and refused separately, and the summary sentence names all three.
//
// IDEMPOTENT. Every creation is guarded by "does an open edge already exist for this person", which
// is the NOT EXISTS clause the SQL carries, evaluated here against the same snapshot. Running it
// twice creates nothing the second time; the second preview simply plans zero rows.
//
// CYCLES ARE REFUSED BEFORE THEY ARE WRITTEN. There is no cycle guard anywhere in the write API —
// openRelationship() will happily record A manages B manages A — and a cycle in the reporting line
// makes every chain walk that touches it run to the statement timeout. So the plan walks the
// proposed graph with a visited path and the same depth cap org-graph.ts uses, and refuses the one
// offending edge WHILE STILL CREATING THE REST. One bad row must not block forty-one good ones.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//  - postgres-js resolves to a PLAIN ARRAY. `r.rows[0]` is always a bug; everything goes through rows().
//  - The real Postgres reason is on `e.cause`. `e.message` is only the SQL that failed.
//  - EVERY const is declared ABOVE the function that reads it. `const` is not hoisted, and on this
//    project a const declared below its use took down two screens that reported success while
//    throwing on their first line every time.
//  - NOTHING IS SWALLOWED IN A WRITE PATH. Every failed row is returned with its reason attached.
//  - ensureOnce() SWALLOWS DDL FAILURES per index, so a successful ensure is not proof the tables or
//    the partial unique indexes exist. The schema is verified against information_schema and
//    pg_indexes, never against the ensure's return value.
//  - The database is imported LAZILY and everything from ./org-graph is imported DYNAMICALLY, so the
//    pure planner below can be unit-tested with no database anywhere near it.

import { sql } from 'drizzle-orm';
import type { OpenRelationshipInput, OrgWriteResult } from './org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — all of them above the first function that reads one.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const logFail = (tag: string, e: any): string => {
  const why = reasonOf(e);
  console.error('[org-graph-backfill] ' + tag + ':', why);
  return why;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * THE STAMP ON EVERY ROW THIS FILE CREATES, byte-for-byte the one db/org-graph-backfill.sql writes.
 *
 * It is load-bearing twice over. db/org-graph-rollback.sql STAGE 1 identifies the rows to remove by
 * this exact string, so a different stamp would make the rollback silently miss them. And the
 * effective_from on a backfilled edge is a REASONABLE RECONSTRUCTION, not a recovered fact — the old
 * column was mutated in place, so the true history is gone — which is a thing a reader has to be
 * able to tell six months from now.
 */
export const BACKFILL_NOTE = 'backfill:reporting_manager_id';

/**
 * The walk cap for cycle detection. This MUST equal MAX_CHAIN_DEPTH in src/lib/org-graph.ts, and
 * src/lib/org-graph-backfill.test.ts asserts that it does rather than trusting this comment.
 *
 * It is not imported from there because that module's import chain reaches src/lib/db, and the whole
 * point of keeping planBackfill() pure and synchronous is that the plan can be exercised with no
 * database in the process at all.
 */
export const CHAIN_DEPTH_CAP = 12;

/** Read as: <subject> is the reporting_manager of <object>. Only one type is ever backfilled. */
const REPORTING_MANAGER = 'reporting_manager';

// -------------------------------------------------------------------------------------------------
// WHAT WE READ — the snapshot the plan is computed from.
// -------------------------------------------------------------------------------------------------

/** One hr_employees row, in the shape the plan needs. `managerUserId` is a USERS id — see below. */
export interface BackfillEmployee {
  employeeId: string;
  userId: string | null;
  fullName: string;
  /**
   * THE ID-SPACE TRAP, and the whole difficulty of this file.
   * hr_employees.reporting_manager_id holds a USERS id (db/hr-schema.sql:114-118).
   * org_relationships.subject_employee_id holds an hr_employees id.
   * Every value has to be mapped users.id -> hr_employees.user_id -> hr_employees.id.
   */
  managerUserId: string | null;
  /** Does a users row with that id still exist? The column has no foreign key, so it can dangle. */
  managerUserExists: boolean;
  joiningDate: string | null;
  createdAt: string | null;
  /**
   * hr_employees.department_id, always read ::text. NEVER cast ::uuid — the same logical value is a
   * varchar(50) slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql.
   */
  departmentId: string | null;
  isActive: boolean;
  lastWorkingDay: string | null;
  exitDate: string | null;
}

/** An open reporting edge already in the graph. subject = the manager, object = the report. */
export interface OpenReportingEdge {
  id: string;
  managerEmployeeId: string;
  employeeId: string;
  effectiveFrom: string | null;
}

export interface OrgSnapshot {
  employees: BackfillEmployee[];
  openReportingEdges: OpenReportingEdge[];
  /** hr_employees ids that already hold an open, primary, active assignment. */
  employeesWithOpenPrimaryAssignment: string[];
  readAt: string;
}

/** What actually exists in the database, asked of the catalogue rather than of an ensure. */
export interface SchemaCheck {
  orgRelationships: boolean;
  orgAssignments: boolean;
  hrEmployees: boolean;
  usersTable: boolean;
  /** Two admin pages ALTER this column in at page load, so on a fresh database it can be absent. */
  managerColumn: boolean;
  /** The partial unique index that makes a concurrent double-run collide instead of duplicating. */
  oneOpenManagerIndex: boolean;
  notes: string[];
}

// -------------------------------------------------------------------------------------------------
// WHAT THE PLAN SAYS
// -------------------------------------------------------------------------------------------------

export type BackfillProblemKind =
  | 'manager_user_missing'
  | 'manager_not_an_employee'
  | 'self_managed'
  | 'cycle'
  | 'inactive_manager'
  | 'duplicate_employee_rows'
  | 'chain_too_deep'
  | 'column_disagrees_with_edge'
  | 'exit_before_start';

export interface BackfillProblem {
  kind: BackfillProblemKind;
  employeeId: string;
  /** Always a name, never only an id. The founder has to know WHICH employee, not how many. */
  employeeName: string;
  /** One sentence, naming everybody involved and what it means for this person. */
  detail: string;
  /** true: no edge will be created for this person. false: the edge is created anyway, flagged. */
  blocking: boolean;
}

export interface PlannedEdge {
  employeeId: string;
  employeeName: string;
  managerEmployeeId: string;
  managerName: string;
  /** joining date, else created_at, else now — exactly the COALESCE the SQL uses. */
  effectiveFrom: string;
}

export interface SkippedEdge {
  employeeId: string;
  employeeName: string;
  existingManagerName: string;
  reason: string;
}

export interface PlannedAssignment {
  employeeId: string;
  employeeName: string;
  departmentId: string;
  effectiveFrom: string;
}

export interface PlannedClosure {
  /** null when the edge does not exist yet: it is one this run is about to create. */
  edgeId: string | null;
  employeeId: string;
  employeeName: string;
  endedAt: string;
  fromThisRun: boolean;
}

export interface BackfillPlan {
  employeesTotal: number;
  employeesWithManagerColumn: number;
  edgesToCreate: PlannedEdge[];
  edgesAlreadyPresent: SkippedEdge[];
  assignmentsToCreate: PlannedAssignment[];
  assignmentsAlreadyPresent: number;
  closuresToApply: PlannedClosure[];
  problems: BackfillProblem[];
  /** Employees with a manager in the column for whom NO edge will be created. */
  refusedCount: number;
}

export interface BackfillPreview {
  /** Could the preview be produced at all? False means nothing is known, not that nothing is wrong. */
  ok: boolean;
  error: string | null;
  schema: SchemaCheck;
  plan: BackfillPlan;
  summary: string;
  readAt: string;
}

// -------------------------------------------------------------------------------------------------
// WHAT THE APPLY DID
// -------------------------------------------------------------------------------------------------

export interface CreatedEdge extends PlannedEdge {
  edgeId: string | null;
}

export interface FailedEdge extends PlannedEdge {
  error: string;
}

export interface BackfillVerification {
  ran: boolean;
  error: string | null;
  openReportingEdges: number;
  createdConfirmed: number;
  createdUnconfirmed: string[];
  closuresConfirmed: number;
  closuresUnconfirmed: string[];
}

export interface BackfillOutcome {
  /** Did the run start and reach the end? NOT "did everything succeed" — read `partial` for that. */
  ok: boolean;
  /** Something the preview promised did not happen. The normal case, and it is never hidden. */
  partial: boolean;
  error: string | null;
  createdEdges: CreatedEdge[];
  failedEdges: FailedEdge[];
  skippedEdges: SkippedEdge[];
  refused: BackfillProblem[];
  warnings: BackfillProblem[];
  createdAssignments: PlannedAssignment[];
  failedAssignments: Array<PlannedAssignment & { error: string }>;
  closedEdges: PlannedClosure[];
  failedClosures: Array<PlannedClosure & { error: string }>;
  /** Asked of the database AFTER the writes, because a returned ok is not an observed result. */
  verification: BackfillVerification;
  summary: string;
}

// -------------------------------------------------------------------------------------------------
// WHAT RECONCILE FOUND
// -------------------------------------------------------------------------------------------------

export type DriftKind = 'column_without_edge' | 'edge_without_column' | 'disagree';

export interface DriftRow {
  employeeId: string;
  employeeName: string;
  kind: DriftKind;
  columnManagerUserId: string | null;
  columnManagerName: string | null;
  graphManagerEmployeeId: string | null;
  graphManagerName: string | null;
  detail: string;
}

export interface ReconcileReport {
  ok: boolean;
  error: string | null;
  employeesTotal: number;
  employeesWithColumn: number;
  openReportingEdges: number;
  /** Column and graph name the same person. This is the number that should grow, not `drift`. */
  agree: number;
  drift: DriftRow[];
  /** People the graph cannot describe at all yet, so their absence is not drift. */
  unrepresentable: BackfillProblem[];
  summary: string;
  readAt: string;
}

// -------------------------------------------------------------------------------------------------
// DATE HANDLING — one place, because the whole file compares dates that arrive in three shapes.
// -------------------------------------------------------------------------------------------------

/**
 * Normalise a value from the database to an ISO instant, or null if it cannot be read as a date.
 *
 * DATE columns are selected ::text and arrive as 'YYYY-MM-DD'; timestamptz columns arrive as Date
 * objects. A bare 'YYYY-MM-DD' is anchored at UTC midnight, which is what ::timestamptz does with a
 * date in a UTC session and therefore what the SQL backfill stores.
 *
 * Returns null rather than defaulting, because a silent default writes a DIFFERENT date than the one
 * the record holds, and effective_from is the field the whole as-of history hangs from.
 */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00.000Z' : s;
  const d = new Date(normalised);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** COALESCE(joining_date, created_at, NOW()) — the SQL's rule, stated once. */
function effectiveFromFor(e: BackfillEmployee, nowIso: string): string {
  return toIso(e.joiningDate) || toIso(e.createdAt) || nowIso;
}

/** COALESCE(last_working_day, exit_date) — the SQL's rule for when a reporting line ended. */
function endedAtFor(e: BackfillEmployee): string | null {
  return toIso(e.lastWorkingDay) || toIso(e.exitDate);
}

const millis = (iso: string | null): number => (iso ? new Date(iso).getTime() : NaN);

// -------------------------------------------------------------------------------------------------
// THE PLANNER — PURE, SYNCHRONOUS, AND THE ONLY PLACE THAT DECIDES WHAT WILL BE WRITTEN.
//
// It touches no database. applyBackfill() executes this plan and nothing else, which is what makes
// "create only what the preview promised" true rather than aspirational.
// -------------------------------------------------------------------------------------------------

/**
 * Walk up the proposed reporting line from `startAt`, looking for a loop back to `employeeId`.
 *
 * THREE GUARDS, the same three org-graph.ts carries on the read side, because a cycle here is a
 * request that never returns and corrupt org data is exactly what a first backfill produces:
 *   1. a visited SET, so a loop stops at the repeat rather than running forever;
 *   2. the depth cap, reported SEPARATELY because a chain deeper than the cap is not corrupt — it is
 *      a chain getReportingChain() will TRUNCATE, and a truncated chain looks exactly like a
 *      complete one on screen;
 *   3. a hard iteration bound of the map size, so a bug in the first two still terminates.
 */
export function walkUp(
  managerOf: Map<string, string>,
  employeeId: string,
  startAt: string,
  cap: number = CHAIN_DEPTH_CAP,
): { cycle: boolean; tooDeep: boolean; path: string[] } {
  const path: string[] = [employeeId];
  const visited = new Set<string>([employeeId]);
  let cur: string | undefined = startAt;
  let steps = 0;
  const bound = managerOf.size + 2;
  while (cur && steps <= bound) {
    path.push(cur);
    if (visited.has(cur)) return { cycle: true, tooDeep: false, path };
    visited.add(cur);
    steps++;
    cur = managerOf.get(cur);
  }
  return { cycle: false, tooDeep: steps > cap, path };
}

/**
 * Turn a snapshot into the exact list of writes, plus every problem found, by name.
 *
 * ORDER OF THE GUARDS, matching db/org-graph-backfill.sql clause for clause:
 *   no column value           -> not a candidate at all (the SQL's WHERE ... IS NOT NULL)
 *   an open edge already      -> SKIP (the SQL's NOT EXISTS). Note this skips even when the edge
 *                                names a DIFFERENT manager than the column; that is drift, not a
 *                                thing to overwrite, and reconcile() reports it by name.
 *   manager user is gone      -> REFUSE (a dangling id; the column has no foreign key)
 *   manager has no employee   -> REFUSE (the graph is keyed on hr_employees ids; it cannot be said)
 *   somebody manages himself  -> REFUSE (the table CHECK would abort the whole statement)
 *   the edge closes a loop    -> REFUSE (this file's own guard; the write API has none)
 * Everything else is created, and an inactive manager or a duplicated employee record is FLAGGED
 * rather than refused, because the SQL creates those edges too and quietly diverging from it here
 * would be the second definition this file exists to avoid.
 */
export function planBackfill(
  snapshot: OrgSnapshot,
  opts?: { now?: Date | string | null; cap?: number },
): BackfillPlan {
  const nowIso = toIso(opts?.now ?? null) || new Date().toISOString();
  const cap = Number(opts?.cap) > 0 ? Number(opts?.cap) : CHAIN_DEPTH_CAP;
  const employees = Array.isArray(snapshot?.employees) ? snapshot.employees : [];
  const openEdges = Array.isArray(snapshot?.openReportingEdges) ? snapshot.openReportingEdges : [];
  const assigned = new Set<string>(snapshot?.employeesWithOpenPrimaryAssignment || []);

  const byId = new Map<string, BackfillEmployee>();
  for (const e of employees) byId.set(e.employeeId, e);
  const nameOf = (id: string | null): string =>
    (id && byId.get(id)?.fullName) ||
    (id ? 'an employee record no longer present (' + id + ')' : 'nobody');

  // users.id -> the hr_employees rows that claim it, ordered is_active DESC then created_at ASC, and
  // ONE is taken — exactly what the SQL's CROSS JOIN LATERAL ... LIMIT 1 does. One user CAN own more
  // than one employee row (rehire, duplicate), and taking all of them would emit one edge per
  // duplicate and collide with the one-open-manager unique index.
  const byUser = new Map<string, BackfillEmployee[]>();
  for (const e of employees) {
    if (!e.userId) continue;
    const list = byUser.get(e.userId) || [];
    list.push(e);
    byUser.set(e.userId, list);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return (millis(toIso(a.createdAt)) || 0) - (millis(toIso(b.createdAt)) || 0);
    });
  }

  const openEdgeByEmployee = new Map<string, OpenReportingEdge>();
  for (const edge of openEdges) {
    if (!openEdgeByEmployee.has(edge.employeeId)) openEdgeByEmployee.set(edge.employeeId, edge);
  }

  // The proposed graph, SEEDED WITH WHAT IS ALREADY OPEN so that a new edge closing a loop THROUGH
  // an existing edge is caught. Keyed report -> manager, which is the direction a chain walks.
  const managerOf = new Map<string, string>();
  for (const edge of openEdges) managerOf.set(edge.employeeId, edge.managerEmployeeId);

  const edgesToCreate: PlannedEdge[] = [];
  const edgesAlreadyPresent: SkippedEdge[] = [];
  const problems: BackfillProblem[] = [];
  const refusedIds = new Set<string>();

  const refuse = (kind: BackfillProblemKind, e: BackfillEmployee, detail: string) => {
    problems.push({ kind, employeeId: e.employeeId, employeeName: e.fullName, detail, blocking: true });
    refusedIds.add(e.employeeId);
  };
  const flag = (kind: BackfillProblemKind, e: BackfillEmployee, detail: string) => {
    problems.push({ kind, employeeId: e.employeeId, employeeName: e.fullName, detail, blocking: false });
  };

  let employeesWithManagerColumn = 0;

  for (const e of employees) {
    if (!e.managerUserId) continue;
    employeesWithManagerColumn++;

    const existing = openEdgeByEmployee.get(e.employeeId);
    if (existing) {
      const currentManager = byId.get(existing.managerEmployeeId) || null;
      edgesAlreadyPresent.push({
        employeeId: e.employeeId,
        employeeName: e.fullName,
        existingManagerName: nameOf(existing.managerEmployeeId),
        reason: 'An open reporting line is already on file, so nothing is written for this person.',
      });
      if (currentManager && currentManager.userId && currentManager.userId !== e.managerUserId) {
        flag(
          'column_disagrees_with_edge',
          e,
          'The graph says ' + currentManager.fullName + ' manages ' + e.fullName +
            ', but the Employment tab now names somebody else. A backfill never overwrites an ' +
            'existing line, so this has to be corrected on the employee record. reconcile() lists it.',
        );
      }
      continue;
    }

    if (!e.managerUserExists) {
      refuse(
        'manager_user_missing',
        e,
        e.fullName + ' has a reporting manager id on file that matches no user account. Nothing can ' +
          'be written for them, and their leave and expenses still have nobody to route to.',
      );
      continue;
    }

    const candidates = byUser.get(e.managerUserId) || [];
    if (!candidates.length) {
      refuse(
        'manager_not_an_employee',
        e,
        e.fullName + "'s manager is a user account with no employee record. The graph is keyed on " +
          'employee records, so this line cannot be represented until that manager is given one.',
      );
      continue;
    }
    if (candidates.length > 1) {
      flag(
        'duplicate_employee_rows',
        e,
        'The user named as ' + e.fullName + "'s manager owns " + candidates.length +
          ' employee records. The active, earliest one (' + candidates[0].fullName +
          ') is used, exactly as the SQL backfill does, and the duplicates should be merged.',
      );
    }

    const mgr = candidates[0];
    if (mgr.employeeId === e.employeeId) {
      refuse(
        'self_managed',
        e,
        e.fullName + ' is recorded as their own reporting manager. That is corrupt data rather than ' +
          'a relationship, the database would reject the row, and no line is created for them.',
      );
      continue;
    }
    if (!mgr.isActive) {
      flag(
        'inactive_manager',
        e,
        e.fullName + ' reports to ' + mgr.fullName + ', whose employee record is inactive. The line ' +
          'is still created, because that is what the record says, but somebody has to be named in ' +
          'their place before the next approval.',
      );
    }

    const walk = walkUp(managerOf, e.employeeId, mgr.employeeId, cap);
    if (walk.cycle) {
      refuse(
        'cycle',
        e,
        'Making ' + mgr.fullName + ' the manager of ' + e.fullName + ' closes a loop: ' +
          walk.path.map((id) => nameOf(id)).join(' reports to ') +
          '. A loop makes every chain walk that touches it run until the query times out, so this ' +
          'one line is refused and the rest are still created.',
      );
      continue;
    }
    if (walk.tooDeep) {
      flag(
        'chain_too_deep',
        e,
        'The reporting line above ' + e.fullName + ' is deeper than the ' + cap +
          ' levels the org chart walks, so the chain shown for them is truncated rather than wrong.',
      );
    }

    managerOf.set(e.employeeId, mgr.employeeId);
    edgesToCreate.push({
      employeeId: e.employeeId,
      employeeName: e.fullName,
      managerEmployeeId: mgr.employeeId,
      managerName: mgr.fullName,
      effectiveFrom: effectiveFromFor(e, nowIso),
    });
  }

  // STEP 2 — the primary department postings. department_id is TEXT here and TEXT in the target
  // column. It is never cast ::uuid: the same logical value is a slug in one schema file and a uuid
  // in the other, and a cast throws on half of them.
  const assignmentsToCreate: PlannedAssignment[] = [];
  let assignmentsAlreadyPresent = 0;
  for (const e of employees) {
    if (!e.departmentId) continue;
    if (assigned.has(e.employeeId)) {
      assignmentsAlreadyPresent++;
      continue;
    }
    assignmentsToCreate.push({
      employeeId: e.employeeId,
      employeeName: e.fullName,
      departmentId: e.departmentId,
      effectiveFrom: effectiveFromFor(e, nowIso),
    });
  }

  // STEP 3 — close the lines of people who have left. THE GUARD MATTERS: the table CHECK requires
  // effective_to > effective_from, and exit dates earlier than joining dates DO occur in hand-entered
  // HR data. A row that fails the comparison keeps its open line and is reported — not silently
  // skipped, and not allowed to abort the run.
  const plannedByEmployee = new Map<string, PlannedEdge>();
  for (const p of edgesToCreate) plannedByEmployee.set(p.employeeId, p);
  const closuresToApply: PlannedClosure[] = [];
  for (const e of employees) {
    if (e.isActive) continue;
    const endedAt = endedAtFor(e);
    if (!endedAt) continue;
    const existing = openEdgeByEmployee.get(e.employeeId);
    const planned = plannedByEmployee.get(e.employeeId);
    if (!existing && !planned) continue;
    const startsAt = existing ? toIso(existing.effectiveFrom) : planned ? planned.effectiveFrom : null;
    if (!startsAt || !(millis(endedAt) > millis(startsAt))) {
      flag(
        'exit_before_start',
        e,
        e.fullName + ' left on ' + endedAt.slice(0, 10) + ', which is not after the date their ' +
          'reporting line began. Their line is left open rather than written with an impossible ' +
          'range, and the joining or exit date on their record needs correcting.',
      );
      continue;
    }
    closuresToApply.push({
      edgeId: existing ? existing.id : null,
      employeeId: e.employeeId,
      employeeName: e.fullName,
      endedAt,
      fromThisRun: !existing,
    });
  }

  return {
    employeesTotal: employees.length,
    employeesWithManagerColumn,
    edgesToCreate,
    edgesAlreadyPresent,
    assignmentsToCreate,
    assignmentsAlreadyPresent,
    closuresToApply,
    problems,
    refusedCount: refusedIds.size,
  };
}

/** The sentence a screen prints above the tables. It never says "done" and never says "failed". */
export function describePlan(plan: BackfillPlan): string {
  const parts: string[] = [];
  parts.push(
    String(plan.employeesWithManagerColumn) + ' of ' + plan.employeesTotal +
      ' employees have a reporting manager recorded on their employee record.',
  );
  parts.push(
    String(plan.edgesToCreate.length) + ' reporting lines would be created, ' +
      plan.edgesAlreadyPresent.length + ' are already in the graph and would be left alone, and ' +
      plan.refusedCount + ' cannot be written and are listed by name below.',
  );
  if (plan.assignmentsToCreate.length) {
    parts.push(
      String(plan.assignmentsToCreate.length) + ' primary department postings would be opened.',
    );
  }
  if (plan.closuresToApply.length) {
    parts.push(
      String(plan.closuresToApply.length) + ' reporting lines belong to people who have left and ' +
        'would be closed on their last working day.',
    );
  }
  return parts.join(' ');
}

// -------------------------------------------------------------------------------------------------
// THE DATABASE — every read in this file, and nothing else reads.
// -------------------------------------------------------------------------------------------------

// Resolved LAZILY, like org-graph.ts: an eager import makes merely IMPORTING this module fail
// without DATABASE_URL, and the planner above is pure arithmetic that must stay testable.
let cachedDb: any = null;
async function database(): Promise<any> {
  if (!cachedDb) cachedDb = (await import('./db')).db;
  return cachedDb;
}

const EMPTY_PLAN: BackfillPlan = {
  employeesTotal: 0,
  employeesWithManagerColumn: 0,
  edgesToCreate: [],
  edgesAlreadyPresent: [],
  assignmentsToCreate: [],
  assignmentsAlreadyPresent: 0,
  closuresToApply: [],
  problems: [],
  refusedCount: 0,
};

const EMPTY_SCHEMA: SchemaCheck = {
  orgRelationships: false,
  orgAssignments: false,
  hrEmployees: false,
  usersTable: false,
  managerColumn: false,
  oneOpenManagerIndex: false,
  notes: [],
};

/**
 * Ask the CATALOGUE what exists.
 *
 * NOT the ensure. ensureOrgGraphSchema() runs inside ensureOnce(), which swallows the rejection for
 * its caller, and each CREATE INDEX inside it has its own try/catch that logs and continues — so a
 * successful return proves a function ran, not that a table or a partial unique index is there.
 * information_schema and pg_indexes are the only honest answer.
 */
export async function checkSchema(): Promise<SchemaCheck> {
  const out: SchemaCheck = { ...EMPTY_SCHEMA, notes: [] };
  try {
    const db = await database();
    // An IN list of individual placeholders. `= ANY($jsArray)` fails against this driver with
    // "op ANY/ALL (array) requires array on right side".
    const tables = rows(await db.execute(sql`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (${'org_relationships'}, ${'org_employee_assignments'},
                            ${'hr_employees'}, ${'users'})`));
    const names = new Set(tables.map((r: any) => String(r.table_name)));
    out.orgRelationships = names.has('org_relationships');
    out.orgAssignments = names.has('org_employee_assignments');
    out.hrEmployees = names.has('hr_employees');
    out.usersTable = names.has('users');

    if (out.hrEmployees) {
      const cols = rows(await db.execute(sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ${'hr_employees'}
           AND column_name = ${'reporting_manager_id'}`));
      out.managerColumn = cols.length > 0;
    }
    if (out.orgRelationships) {
      const idx = rows(await db.execute(sql`
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = ${'org_relationships'}
           AND indexname = ${'org_relationships_one_open_manager_uq'}`));
      out.oneOpenManagerIndex = idx.length > 0;
    }

    if (!out.orgRelationships) {
      out.notes.push(
        'org_relationships does not exist. Nothing can be written until the graph tables are ' +
          'created; applying the backfill creates them first.',
      );
    }
    if (!out.hrEmployees) {
      out.notes.push('hr_employees does not exist. This is not the EduRankAI database.');
    } else if (!out.managerColumn) {
      out.notes.push(
        'hr_employees.reporting_manager_id has never been created on this database, so there are no ' +
          'reporting managers on file to migrate. Nothing would be written.',
      );
    }
    if (out.orgRelationships && !out.oneOpenManagerIndex) {
      out.notes.push(
        'The one-open-manager unique index is missing. This backfill still refuses to create a ' +
          'second open line for anybody, but the database is no longer enforcing it underneath, so ' +
          'two people applying at once could both write one.',
      );
    }
    return out;
  } catch (e: any) {
    out.notes.push('The database catalogue could not be read: ' + logFail('checkSchema', e));
    return out;
  }
}

/**
 * Read everything the plan needs, in three queries. READ ONLY — this function writes nothing and is
 * safe to run against production in the middle of the day.
 */
export async function readSnapshot(
  schema?: SchemaCheck,
): Promise<{ snapshot: OrgSnapshot; error: string | null }> {
  const readAt = new Date().toISOString();
  const empty: OrgSnapshot = {
    employees: [],
    openReportingEdges: [],
    employeesWithOpenPrimaryAssignment: [],
    readAt,
  };
  const s = schema || (await checkSchema());
  if (!s.hrEmployees) {
    return {
      snapshot: empty,
      error: 'hr_employees does not exist. This is not the EduRankAI database.',
    };
  }

  try {
    const db = await database();

    // The manager column is NAMED in this query, so a database where it has never been created would
    // throw. Selecting NULL in its place keeps the read honest — no managers on file, rather than an
    // error that reads as though the whole thing is broken.
    const managerCol = s.managerColumn ? sql`e.reporting_manager_id::text` : sql`NULL::text`;
    const managerJoin =
      s.managerColumn && s.usersTable
        ? sql`LEFT JOIN users u ON u.id = e.reporting_manager_id`
        : sql`LEFT JOIN users u ON FALSE`;

    const er = rows(await db.execute(sql`
      SELECT e.id::text               AS employee_id,
             e.user_id::text          AS user_id,
             e.full_name              AS full_name,
             ${managerCol}            AS manager_user_id,
             (u.id IS NOT NULL)       AS manager_user_exists,
             e.joining_date::text     AS joining_date,
             e.created_at             AS created_at,
             e.department_id::text    AS department_id,
             COALESCE(e.is_active, TRUE) AS is_active,
             e.last_working_day::text AS last_working_day,
             e.exit_date::text        AS exit_date
        FROM hr_employees e
        ${managerJoin}
       ORDER BY e.full_name ASC, e.created_at ASC`));

    const employees: BackfillEmployee[] = er
      .map((r: any) => ({
        employeeId: String(r.employee_id || ''),
        userId: r.user_id ? String(r.user_id) : null,
        fullName: String(r.full_name || '').trim() || 'An employee with no name on record',
        managerUserId: r.manager_user_id ? String(r.manager_user_id) : null,
        managerUserExists: r.manager_user_exists === true || r.manager_user_exists === 't',
        joiningDate: r.joining_date ? String(r.joining_date) : null,
        createdAt: toIso(r.created_at),
        departmentId: r.department_id ? String(r.department_id) : null,
        isActive: !(r.is_active === false || r.is_active === 'f'),
        lastWorkingDay: r.last_working_day ? String(r.last_working_day) : null,
        exitDate: r.exit_date ? String(r.exit_date) : null,
      }))
      .filter((e: BackfillEmployee) => isUuid(e.employeeId));

    let openReportingEdges: OpenReportingEdge[] = [];
    let employeesWithOpenPrimaryAssignment: string[] = [];

    if (s.orgRelationships) {
      const rr = rows(await db.execute(sql`
        SELECT id::text                  AS id,
               subject_employee_id::text AS manager_employee_id,
               object_employee_id::text  AS employee_id,
               effective_from            AS effective_from
          FROM org_relationships
         WHERE type = ${REPORTING_MANAGER}
           AND status = 'active'
           AND effective_to IS NULL`));
      openReportingEdges = rr
        .map((r: any) => ({
          id: String(r.id || ''),
          managerEmployeeId: String(r.manager_employee_id || ''),
          employeeId: String(r.employee_id || ''),
          effectiveFrom: toIso(r.effective_from),
        }))
        .filter((x: OpenReportingEdge) => isUuid(x.id) && isUuid(x.employeeId));
    }

    if (s.orgAssignments) {
      const ar = rows(await db.execute(sql`
        SELECT employee_id::text AS employee_id
          FROM org_employee_assignments
         WHERE is_primary = TRUE
           AND status = 'active'
           AND effective_to IS NULL`));
      employeesWithOpenPrimaryAssignment = ar.map((r: any) => String(r.employee_id || ''));
    }

    return {
      snapshot: { employees, openReportingEdges, employeesWithOpenPrimaryAssignment, readAt },
      error: null,
    };
  } catch (e: any) {
    return {
      snapshot: empty,
      error: 'The employee records could not be read: ' + logFail('readSnapshot', e),
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE SEAMS — so both phases can be exercised without a database, and so every write goes through
// the one write API rather than through a second INSERT invented here.
// -------------------------------------------------------------------------------------------------

export interface BackfillDeps {
  readSchema?: () => Promise<SchemaCheck>;
  readSnapshot?: (schema: SchemaCheck) => Promise<{ snapshot: OrgSnapshot; error: string | null }>;
  openEdge?: (input: OpenRelationshipInput) => Promise<OrgWriteResult>;
  closeEdge?: (edgeId: string, endedAt: string) => Promise<OrgWriteResult>;
  openAssignment?: (a: PlannedAssignment, createdByUserId: string | null) => Promise<OrgWriteResult>;
  ensureSchema?: () => Promise<void>;
  now?: () => Date;
}

async function defaultOpenEdge(input: OpenRelationshipInput): Promise<OrgWriteResult> {
  const { openRelationship } = await import('./org-graph');
  return openRelationship(input);
}

async function defaultCloseEdge(edgeId: string, endedAt: string): Promise<OrgWriteResult> {
  const { closeRelationship } = await import('./org-graph');
  return closeRelationship(edgeId, { asOf: endedAt });
}

async function defaultEnsureSchema(): Promise<void> {
  const { ensureOrgGraphSchema } = await import('./org-graph-schema');
  await ensureOrgGraphSchema();
}

/**
 * STEP 2's writer.
 *
 * There is no write API for a posting that names only a department: org-structure.ts
 * assignEmployee() refuses one without a team or a position, and rightly — on that screen a posting
 * with neither says nothing. The backfill's posting is a different thing. It is the answer to "which
 * department was she in when this was approved", reconstructed from the employee record, and it is
 * written with the same NOT EXISTS guard the SQL uses so that a second run inserts nothing.
 */
async function defaultOpenAssignment(
  a: PlannedAssignment,
  createdByUserId: string | null,
): Promise<OrgWriteResult> {
  const by = isUuid(createdByUserId) ? createdByUserId : null;
  try {
    const db = await database();
    const r = rows(await db.execute(sql`
      INSERT INTO org_employee_assignments
        (employee_id, position_id, team_id, department_id, allocation_pct, is_primary,
         effective_from, effective_to, status, created_by)
      SELECT ${a.employeeId}::uuid, NULL::uuid, NULL::uuid, ${a.departmentId}::text, 100, TRUE,
             ${a.effectiveFrom}::timestamptz, NULL::timestamptz, 'active', ${by}::uuid
       WHERE NOT EXISTS (
         SELECT 1
           FROM org_employee_assignments x
          WHERE x.employee_id = ${a.employeeId}::uuid
            AND x.is_primary = TRUE
            AND x.status = 'active'
            AND x.effective_to IS NULL)
      RETURNING id::text AS id`));
    // Zero rows means somebody opened one between the preview and now. That is the idempotency guard
    // doing its job, not a failure.
    return r.length ? { ok: true, id: String(r[0].id) } : { ok: true };
  } catch (e: any) {
    return { ok: false, error: logFail('openAssignment', e) };
  }
}

// -------------------------------------------------------------------------------------------------
// PHASE ONE — PREVIEW. WRITES NOTHING.
// -------------------------------------------------------------------------------------------------

/**
 * What would happen, and everything wrong with the data, by name.
 *
 * It deliberately does NOT call ensureOrgGraphSchema(): a preview that created tables would be a
 * write, and the whole promise of this phase is that it is not one. If the tables are absent it says
 * so, and apply creates them.
 */
export async function previewBackfill(deps?: BackfillDeps): Promise<BackfillPreview> {
  const readSchemaFn = deps?.readSchema || checkSchema;
  const readSnapshotFn = deps?.readSnapshot || readSnapshot;
  const now = deps?.now ? deps.now() : new Date();

  const schema = await readSchemaFn();
  const read = await readSnapshotFn(schema);
  if (read.error) {
    return {
      ok: false,
      error: read.error,
      schema,
      plan: EMPTY_PLAN,
      summary:
        'Nothing could be read, so nothing is known about what a backfill would do. ' + read.error,
      readAt: read.snapshot?.readAt || new Date().toISOString(),
    };
  }

  const plan = planBackfill(read.snapshot, { now });
  return {
    ok: true,
    error: null,
    schema,
    plan,
    summary: describePlan(plan),
    readAt: read.snapshot.readAt,
  };
}

// -------------------------------------------------------------------------------------------------
// PHASE TWO — APPLY. ROW BY ROW, CONTINUING PAST FAILURES.
// -------------------------------------------------------------------------------------------------

export interface ApplyOptions {
  /** Stamped on every row as created_by, so the graph records who ran the migration. */
  createdByUserId?: string | null;
  /**
   * STEP 3. Separated in the SQL so it can be skipped, and separated here for the same reason:
   * everything else is a faithful translation of existing data, and this one makes a judgement about
   * what an exit date means.
   */
  closeLeavers?: boolean;
  /** STEP 2. Off makes this a reporting-lines-only run. */
  includeAssignments?: boolean;
}

function emptyOutcome(error: string | null, summary: string): BackfillOutcome {
  return {
    ok: false,
    partial: false,
    error,
    createdEdges: [],
    failedEdges: [],
    skippedEdges: [],
    refused: [],
    warnings: [],
    createdAssignments: [],
    failedAssignments: [],
    closedEdges: [],
    failedClosures: [],
    verification: {
      ran: false,
      error: null,
      openReportingEdges: 0,
      createdConfirmed: 0,
      createdUnconfirmed: [],
      closuresConfirmed: 0,
      closuresUnconfirmed: [],
    },
    summary,
  };
}

/**
 * Create exactly what the preview promised.
 *
 * ROW BY ROW AND NOT IN ONE TRANSACTION. One person's bad record must not roll back forty-one good
 * ones, and each edge is independently meaningful — unlike supersedeReportingManager(), where the
 * close and the open are two halves of ONE fact and are therefore one statement.
 *
 * NOTHING IS SWALLOWED. Every failure is caught, the reason is kept, and the row comes back in
 * failedEdges with both names on it. A write path that quietly logs and moves on is how an outage
 * stays invisible for hours on this project.
 *
 * THE RESULT IS VERIFIED AGAINST THE DATABASE, not against the return values. closeRelationship()
 * returns ok for a close that matched no row, and ensure-once swallows DDL failures underneath all
 * of it. A green return proves a function ran, not that a row exists.
 */
export async function applyBackfill(opts?: ApplyOptions & BackfillDeps): Promise<BackfillOutcome> {
  const createdBy = isUuid(opts?.createdByUserId) ? String(opts?.createdByUserId) : null;
  const closeLeavers = opts?.closeLeavers !== false;
  const includeAssignments = opts?.includeAssignments !== false;
  const openEdgeFn = opts?.openEdge || defaultOpenEdge;
  const closeEdgeFn = opts?.closeEdge || defaultCloseEdge;
  const openAssignmentFn = opts?.openAssignment || defaultOpenAssignment;
  const ensureFn = opts?.ensureSchema || defaultEnsureSchema;
  const readSchemaFn = opts?.readSchema || checkSchema;
  const readSnapshotFn = opts?.readSnapshot || readSnapshot;

  // Create the tables if they are absent — and then ask the CATALOGUE, because the ensure swallows
  // per-index failures and its return value is not evidence of anything.
  try {
    await ensureFn();
  } catch (e: any) {
    logFail('applyBackfill/ensure', e);
  }

  const preview = await previewBackfill({
    readSchema: readSchemaFn,
    readSnapshot: readSnapshotFn,
    now: opts?.now,
  });
  if (!preview.ok) {
    return emptyOutcome(
      preview.error,
      'Nothing was written, because the records could not be read. ' + (preview.error || ''),
    );
  }
  if (!preview.schema.orgRelationships) {
    return emptyOutcome(
      'org_relationships still does not exist after the schema ensure ran.',
      'Nothing was written: the organization graph tables are not there, and the ensure that should ' +
        'have created them reported nothing. Check the database, not this screen.',
    );
  }

  const plan = preview.plan;
  const out = emptyOutcome(null, '');
  out.ok = true;
  out.skippedEdges = plan.edgesAlreadyPresent;
  out.refused = plan.problems.filter((p) => p.blocking);
  out.warnings = plan.problems.filter((p) => !p.blocking);

  // STEP 1 — the reporting lines, through the write API. Note the note: db/org-graph-rollback.sql
  // finds these rows by that exact string.
  for (const p of plan.edgesToCreate) {
    try {
      const r = await openEdgeFn({
        type: 'reporting_manager',
        subjectEmployeeId: p.managerEmployeeId,
        objectEmployeeId: p.employeeId,
        scopeType: null,
        scopeId: null,
        effectiveFrom: p.effectiveFrom,
        createdByUserId: createdBy,
        note: BACKFILL_NOTE,
      });
      if (r?.ok) out.createdEdges.push({ ...p, edgeId: r.id ? String(r.id) : null });
      else out.failedEdges.push({ ...p, error: String(r?.error || 'The write returned no reason.') });
    } catch (e: any) {
      out.failedEdges.push({ ...p, error: logFail('applyBackfill/openEdge', e) });
    }
  }

  // STEP 2 — the primary department postings.
  if (includeAssignments && preview.schema.orgAssignments) {
    for (const a of plan.assignmentsToCreate) {
      try {
        const r = await openAssignmentFn(a, createdBy);
        if (r?.ok) out.createdAssignments.push(a);
        else {
          out.failedAssignments.push({
            ...a,
            error: String(r?.error || 'The write returned no reason.'),
          });
        }
      } catch (e: any) {
        out.failedAssignments.push({ ...a, error: logFail('applyBackfill/openAssignment', e) });
      }
    }
  }

  // STEP 3 — close the lines of people who have left. A line created a moment ago is closed by the
  // id that creation returned; there is no second lookup, and therefore no chance of closing
  // somebody else's row.
  if (closeLeavers) {
    const createdEdgeIdFor = new Map<string, string | null>();
    for (const c of out.createdEdges) createdEdgeIdFor.set(c.employeeId, c.edgeId);
    for (const c of plan.closuresToApply) {
      let edgeId = c.edgeId;
      if (!edgeId && c.fromThisRun) edgeId = createdEdgeIdFor.get(c.employeeId) || null;
      if (!edgeId) {
        out.failedClosures.push({
          ...c,
          error:
            'Their reporting line was not created in this run, so there was no line to close. Their ' +
            'record still shows an exit date and an open line.',
        });
        continue;
      }
      try {
        const r = await closeEdgeFn(edgeId, c.endedAt);
        if (r?.ok) out.closedEdges.push({ ...c, edgeId });
        else {
          out.failedClosures.push({
            ...c,
            edgeId,
            error: String(r?.error || 'The close returned no reason.'),
          });
        }
      } catch (e: any) {
        out.failedClosures.push({ ...c, edgeId, error: logFail('applyBackfill/closeEdge', e) });
      }
    }
  }

  // VERIFY. Re-read the graph and check that what was reported as written is actually there. This is
  // the difference between "the function returned ok" and "the row exists", and those two have
  // diverged on this project often enough to be a rule.
  try {
    const after = await readSnapshotFn(preview.schema);
    if (after.error) {
      out.verification.ran = false;
      out.verification.error = after.error;
    } else {
      const openByEmployee = new Map<string, OpenReportingEdge>();
      for (const edge of after.snapshot.openReportingEdges) {
        if (!openByEmployee.has(edge.employeeId)) openByEmployee.set(edge.employeeId, edge);
      }
      out.verification.ran = true;
      out.verification.openReportingEdges = after.snapshot.openReportingEdges.length;
      // A line created and then closed for a leaver is correctly absent from the OPEN set, so it is
      // counted as confirmed by the closure check below rather than reported as missing.
      const closedEmployees = new Set(out.closedEdges.map((c) => c.employeeId));
      for (const c of out.createdEdges) {
        const found = openByEmployee.get(c.employeeId);
        if (found && found.managerEmployeeId === c.managerEmployeeId) out.verification.createdConfirmed++;
        else if (closedEmployees.has(c.employeeId)) out.verification.createdConfirmed++;
        else out.verification.createdUnconfirmed.push(c.employeeName);
      }
      for (const c of out.closedEdges) {
        if (openByEmployee.has(c.employeeId)) out.verification.closuresUnconfirmed.push(c.employeeName);
        else out.verification.closuresConfirmed++;
      }
    }
  } catch (e: any) {
    out.verification.ran = false;
    out.verification.error = logFail('applyBackfill/verify', e);
  }

  out.partial =
    out.failedEdges.length > 0 ||
    out.failedAssignments.length > 0 ||
    out.failedClosures.length > 0 ||
    out.refused.length > 0 ||
    out.verification.createdUnconfirmed.length > 0 ||
    out.verification.closuresUnconfirmed.length > 0;
  out.summary = describeOutcome(out);
  return out;
}

/**
 * The sentence the screen prints. It says the number created AND the number that did not happen, in
 * the same breath, because a partial result reported as either extreme is the failure mode this
 * whole file exists to avoid.
 */
export function describeOutcome(out: BackfillOutcome): string {
  if (!out.ok) return out.summary || 'Nothing was written.';
  const attempted = out.createdEdges.length + out.failedEdges.length;
  const parts: string[] = [];
  parts.push('Created ' + out.createdEdges.length + ' of ' + attempted + ' reporting lines.');
  if (out.failedEdges.length) {
    parts.push(out.failedEdges.length + ' failed and are listed with the reason the database gave.');
  }
  if (out.refused.length) {
    parts.push(
      out.refused.length + ' were refused before anything was written — a loop, a manager who is ' +
        'not an employee, or somebody recorded as their own manager — and are named below.',
    );
  }
  if (out.skippedEdges.length) {
    parts.push(out.skippedEdges.length + ' already had a line in the graph and were left untouched.');
  }
  if (out.createdAssignments.length || out.failedAssignments.length) {
    parts.push(
      'Opened ' + out.createdAssignments.length + ' of ' +
        (out.createdAssignments.length + out.failedAssignments.length) +
        ' primary department postings.',
    );
  }
  if (out.closedEdges.length || out.failedClosures.length) {
    parts.push(
      'Closed ' + out.closedEdges.length + ' of ' +
        (out.closedEdges.length + out.failedClosures.length) +
        ' lines for people who have left.',
    );
  }
  if (!out.verification.ran) {
    parts.push(
      'The result could NOT be verified against the database' +
        (out.verification.error ? ' (' + out.verification.error + ')' : '') +
        ', so treat these counts as what was attempted, not as what is on file.',
    );
  } else if (out.verification.createdUnconfirmed.length || out.verification.closuresUnconfirmed.length) {
    const names = out.verification.createdUnconfirmed
      .concat(out.verification.closuresUnconfirmed)
      .slice(0, 20)
      .join(', ');
    parts.push(
      'Re-reading the graph did not find the line for: ' + names +
        '. Those writes reported success and are not there.',
    );
  } else {
    parts.push(
      'Re-reading the graph confirms every line reported above, and there are now ' +
        out.verification.openReportingEdges + ' open reporting lines.',
    );
  }
  return parts.join(' ');
}

// -------------------------------------------------------------------------------------------------
// RECONCILE — THE FUNCTION THAT TELLS YOU MONTHS LATER WHETHER THE ONGOING WRITER IS WORKING.
// -------------------------------------------------------------------------------------------------

/**
 * Compare the legacy column against the graph, in BOTH directions.
 *
 * THE COMPARISON IS USER ID TO USER ID. hr_employees.reporting_manager_id holds a users id; the
 * graph holds employee ids; so the graph manager's OWN user_id is what the column is compared
 * against. Getting that backwards reports every row as drift and looks like a catastrophe.
 *
 * THE THREE ANSWERS:
 *   column_without_edge  somebody set a manager on the Employment tab and nothing wrote the graph.
 *                        Straight after the backfill this should be empty; if it grows, the ongoing
 *                        writer is not running.
 *   edge_without_column  the graph was written and the column mirror was not. That is the other
 *                        drift direction, and it matters because db/org-graph-rollback.sql is only
 *                        safe while the old column is still true — the compatibility layer falls
 *                        back to it whenever the graph is empty.
 *   disagree             both are set and they name different people. Whichever screen you happen to
 *                        be looking at is telling you one of two different truths.
 *
 * Pure and separately testable, so the rule can be exercised with no database anywhere near it.
 */
export function diffColumnAgainstGraph(snapshot: OrgSnapshot): {
  drift: DriftRow[];
  agree: number;
  unrepresentable: BackfillProblem[];
  employeesWithColumn: number;
} {
  const employees = Array.isArray(snapshot?.employees) ? snapshot.employees : [];
  const openEdges = Array.isArray(snapshot?.openReportingEdges) ? snapshot.openReportingEdges : [];
  const byId = new Map<string, BackfillEmployee>();
  for (const e of employees) byId.set(e.employeeId, e);
  const byUser = new Map<string, BackfillEmployee>();
  for (const e of employees) {
    if (!e.userId) continue;
    const held = byUser.get(e.userId);
    if (!held || (!held.isActive && e.isActive)) byUser.set(e.userId, e);
  }
  const openEdgeByEmployee = new Map<string, OpenReportingEdge>();
  for (const edge of openEdges) {
    if (!openEdgeByEmployee.has(edge.employeeId)) openEdgeByEmployee.set(edge.employeeId, edge);
  }

  const drift: DriftRow[] = [];
  const unrepresentable: BackfillProblem[] = [];
  let agree = 0;
  let employeesWithColumn = 0;

  for (const e of employees) {
    const edge = openEdgeByEmployee.get(e.employeeId) || null;
    const graphManager = edge ? byId.get(edge.managerEmployeeId) || null : null;
    const columnManager = e.managerUserId ? byUser.get(e.managerUserId) || null : null;
    if (e.managerUserId) employeesWithColumn++;

    if (e.managerUserId && !columnManager) {
      unrepresentable.push({
        kind: e.managerUserExists ? 'manager_not_an_employee' : 'manager_user_missing',
        employeeId: e.employeeId,
        employeeName: e.fullName,
        detail: e.managerUserExists
          ? e.fullName + "'s manager is a user account with no employee record, so the graph cannot " +
            'hold that line at all. This is not drift; it is a person the graph cannot yet describe.'
          : e.fullName + ' has a reporting manager id that matches no user account. The column has ' +
            'no foreign key, so a deleted user leaves the id behind.',
        blocking: true,
      });
    }

    if (!e.managerUserId && !edge) continue;

    if (e.managerUserId && !edge) {
      drift.push({
        employeeId: e.employeeId,
        employeeName: e.fullName,
        kind: 'column_without_edge',
        columnManagerUserId: e.managerUserId,
        columnManagerName: columnManager ? columnManager.fullName : null,
        graphManagerEmployeeId: null,
        graphManagerName: null,
        detail:
          e.fullName + "'s employee record names a reporting manager and the graph has no line for " +
          'them, so every screen that asks the graph shows them reporting to nobody.',
      });
      continue;
    }

    if (!e.managerUserId && edge) {
      drift.push({
        employeeId: e.employeeId,
        employeeName: e.fullName,
        kind: 'edge_without_column',
        columnManagerUserId: null,
        columnManagerName: null,
        graphManagerEmployeeId: edge.managerEmployeeId,
        graphManagerName: graphManager ? graphManager.fullName : null,
        detail:
          'The graph says ' + (graphManager ? graphManager.fullName : 'somebody') + ' manages ' +
          e.fullName + ', and their employee record names nobody. Anything still reading the old ' +
          'column — including the rollback path — does not know about that line.',
      });
      continue;
    }

    const graphManagerUserId = graphManager ? graphManager.userId : null;
    if (e.managerUserId && graphManagerUserId && graphManagerUserId === e.managerUserId) {
      agree++;
      continue;
    }
    drift.push({
      employeeId: e.employeeId,
      employeeName: e.fullName,
      kind: 'disagree',
      columnManagerUserId: e.managerUserId,
      columnManagerName: columnManager ? columnManager.fullName : null,
      graphManagerEmployeeId: edge ? edge.managerEmployeeId : null,
      graphManagerName: graphManager ? graphManager.fullName : null,
      detail:
        'The graph says ' + (graphManager ? graphManager.fullName : 'somebody no longer on file') +
        ' manages ' + e.fullName + '; the employee record says ' +
        (columnManager ? columnManager.fullName : 'somebody else') +
        '. Two screens are showing two different managers for the same person.',
    });
  }

  return { drift, agree, unrepresentable, employeesWithColumn };
}

/** The database-facing half of the same question. READ ONLY. */
export async function reconcile(deps?: BackfillDeps): Promise<ReconcileReport> {
  const readSchemaFn = deps?.readSchema || checkSchema;
  const readSnapshotFn = deps?.readSnapshot || readSnapshot;
  const schema = await readSchemaFn();
  const read = await readSnapshotFn(schema);
  if (read.error) {
    return {
      ok: false,
      error: read.error,
      employeesTotal: 0,
      employeesWithColumn: 0,
      openReportingEdges: 0,
      agree: 0,
      drift: [],
      unrepresentable: [],
      summary: 'The comparison could not be made, so nothing is known about drift. ' + read.error,
      readAt: read.snapshot?.readAt || new Date().toISOString(),
    };
  }

  const d = diffColumnAgainstGraph(read.snapshot);
  const byKind = (k: DriftKind) => d.drift.filter((x) => x.kind === k).length;
  const parts: string[] = [];
  parts.push(
    d.agree + ' of ' + read.snapshot.employees.length +
      ' employees have the same manager in the graph and on their employee record.',
  );
  if (byKind('column_without_edge')) {
    parts.push(
      byKind('column_without_edge') + ' have a manager on the record and no line in the graph. ' +
        'Straight after a backfill this should be nought; if it is growing, nothing is writing the ' +
        'graph when a manager is set.',
    );
  }
  if (byKind('edge_without_column')) {
    parts.push(
      byKind('edge_without_column') + ' have a line in the graph and no manager on the record. The ' +
        'graph is ahead of the column, and the rollback path reads the column.',
    );
  }
  if (byKind('disagree')) {
    parts.push(byKind('disagree') + ' name two different managers and are listed by name.');
  }
  if (d.unrepresentable.length) {
    parts.push(
      d.unrepresentable.length + ' name a manager the graph cannot hold at all, which is not drift ' +
        'but does mean those people still have nobody to route work to.',
    );
  }
  if (!d.drift.length && !d.unrepresentable.length) {
    parts.push('Nothing has drifted: the graph and the employee records agree everywhere.');
  }

  return {
    ok: true,
    error: null,
    employeesTotal: read.snapshot.employees.length,
    employeesWithColumn: d.employeesWithColumn,
    openReportingEdges: read.snapshot.openReportingEdges.length,
    agree: d.agree,
    drift: d.drift,
    unrepresentable: d.unrepresentable,
    summary: parts.join(' '),
    readAt: read.snapshot.readAt,
  };
}
