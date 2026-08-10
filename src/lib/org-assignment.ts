// src/lib/org-assignment.ts — THE ONLY PLACE THAT CHANGES WHO REPORTS TO WHOM, AND WHO HEADS WHAT.
//
// =================================================================================================
// WHY THIS FILE EXISTS: THE COLUMN AND THE EDGE MUST NOT BE ABLE TO DISAGREE
// =================================================================================================
//
// Two records answer "who is this person's manager", and they are in different id spaces:
//
//   hr_employees.reporting_manager_id   a USERS id.  One value. Today's answer only.
//   org_relationships (reporting_manager) an EMPLOYEE id, effective-dated, append-only. Every date.
//
// The graph is the truth. The column is the COMPATIBILITY layer that getManagerCompat() falls back
// to while the graph is still empty, and the property that makes the whole phase reversible
// (db/org-graph-rollback.sql deliberately never touches it). So both have to move, together, or the
// product quietly holds two different answers about who approves somebody's leave.
//
// Before this file, they could not move together, because nothing joined them:
//   - /admin/hr/employees/[id].astro wrote ONLY the column, on every save of the Employment tab.
//     That is the ordinary path — an administrator typing a manager into a form — and it was the
//     single biggest source of drift.
//   - src/lib/eims-programme.ts wrote ONLY the graph, for interns. Drift in the other direction.
//   - src/lib/hr-lifecycle.ts and src/lib/hr-separation.ts wrote BOTH, correctly, each with its own
//     copy of the sequence. Two copies of a rule is one copy away from a third that gets it wrong.
//
// A one-time backfill (db/org-graph-backfill.sql) fixes the rows that exist TODAY. It does nothing
// about the next hire. This file is the half that stops the problem recurring; the backfill is only
// how the existing rows catch up.
//
// =================================================================================================
// THE ORDER IS GRAPH FIRST, COLUMN SECOND, AND IT IS NOT ARBITRARY
// =================================================================================================
//
// If the EDGE write fails, NOTHING ELSE HAPPENS. The column is not touched, the caller is told what
// failed in the reason Postgres gave, and the record is left exactly as it was. A column write that
// succeeded alone is the outcome this project has shipped a dozen times under a green message: the
// screen says "saved", the approval graph says nobody, and a leave request routes to no one.
//
// If the COLUMN write then fails, the graph is AHEAD of the column and the caller is told THAT, in
// those words. It is the safe direction — the graph is what every new surface reads, and
// getManagerCompat() only consults the column while the graph is entirely empty — but it is still a
// disagreement, and a disagreement nobody is told about is how the two records drift apart again.
// Nothing is rolled back: the graph is APPEND-ONLY, and deleting the edge to tidy up would destroy
// the one thing the table exists to keep.
//
// NOTHING HERE READS users.role. A role name is a per-USER label; a relationship is a per-ROW fact.
// Treating one as the other makes every manager a manager of everyone, which is precisely what
// Phase 1 removed. Every id below is either an hr_employees id or a users id, and which one is
// stated at every boundary.
// =================================================================================================

// Resolved LAZILY, like every other module here: a top-level db import makes src/lib/db throw the
// moment anything imports this file, which would put the pure helpers below out of reach of a test
// that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('./db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { ensureOnce } from './ensure-once';
import { supersedeReportingManager, supersedeDepartmentHead } from './org-graph';
import { logAudit } from './audit';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that read it. `const` is not hoisted,
// and on this project that exact pattern took down apply step 5 and the /admin/roles/diagnose
// Repair button, both of which reported success while throwing on their first line.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[org-assignment] ' + tag + ':', reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** '' for anything absent, so "not supplied" and "supplied as blank" collapse to one case. */
const trimmed = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

// =================================================================================================
// THE PURE HALF — every refusal, decided with no database in the room
// =================================================================================================
//
// These take facts that have ALREADY been read and return the sentence a human should see, or ''.
// They are pure so the rules can be tested (src/lib/org-assignment.test.ts) without a connection,
// and so that a caller reading the file can see every reason a write is refused in one place.
// =================================================================================================

/** What was read about the two people involved, before anything is written. */
export interface ReportingLineFacts {
  /** hr_employees.id of the person whose manager is being set. */
  subjectEmployeeId: string;
  /** users.id linked to that employee record, or null when they have no sign-in. */
  subjectUserId: string | null;
  subjectName: string;
  /** True when a manager was asked for; false means "clear the reporting line". */
  askedForAManager: boolean;
  /** hr_employees.id of the manager. Null when the person asked for has no employee record. */
  managerEmployeeId: string | null;
  /** users.id on the manager's employee record. Null when that record has no linked sign-in. */
  managerUserId: string | null;
  managerName: string;
  /** False when the manager's employee record exists but is deactivated. */
  managerIsActive: boolean;
}

/**
 * Every reason a reporting line is refused, in one function.
 *
 * REFUSING IS THE SAFE DIRECTION HERE. Each of these would otherwise write approval authority that
 * some screen cannot resolve, and an approval that routes to nobody is invisible until somebody's
 * leave sits unactioned for a fortnight.
 */
export function reportingLineRefusal(f: ReportingLineFacts): string {
  if (!isUuid(f.subjectEmployeeId)) {
    return 'The employee record to change was not identified, so nothing was changed.';
  }
  if (!f.askedForAManager) return '';

  // The chosen person is a login with no employee record. THE GRAPH IS KEYED ON EMPLOYEE RECORDS,
  // so there is no edge that can be written for them at all. Writing the column alone is exactly
  // the drift this module exists to end.
  if (!f.managerEmployeeId) {
    return 'The person chosen as reporting manager has a sign-in but no record on the employee '
      + 'register, so the reporting line cannot be recorded in the Organization Graph — the graph is '
      + 'keyed on employee records. Nothing was changed. Add their employee record first, or pick '
      + 'somebody else.';
  }

  if (f.managerEmployeeId === f.subjectEmployeeId) {
    return 'Nobody can be their own reporting manager. ' + (f.subjectName || 'This person')
      + ' would approve their own leave and their own withdrawals. Nothing was changed.';
  }

  // The same person reached through a SECOND employee record. One human can hold more than one row
  // here (a closed internship and a current contract), and the ids differ while the login does not.
  if (f.subjectUserId && f.managerUserId && f.subjectUserId === f.managerUserId) {
    return (f.subjectName || 'This person') + ' cannot be their own reporting manager. That employee '
      + 'record belongs to the same sign-in, and approval is checked against the signed-in account. '
      + 'Nothing was changed.';
  }

  // No linked sign-in. hr_employees.reporting_manager_id holds a USERS id, so the compatibility
  // column literally cannot name them — it would be set to NULL while the graph said otherwise, and
  // every screen still reading the column would show this person as having no manager at all.
  if (!f.managerUserId) {
    return (f.managerName || 'That person') + ' has an employee record but no linked sign-in. The '
      + 'reporting line is also mirrored to hr_employees.reporting_manager_id, which holds a sign-in '
      + 'id, so recording them would leave the two disagreeing — and every screen still reading the '
      + 'older field would show no manager. Nothing was changed: link a sign-in to their employee '
      + 'record first, or pick somebody else.';
  }

  // A manager who has left cannot approve anything, and a reporting line into a closed record is a
  // queue nobody is watching. Refused on a NEW assignment; re-saving a line already on file is
  // handled by the caller, which knows whether the value changed.
  if (!f.managerIsActive) {
    return (f.managerName || 'That person') + ' is no longer an active employee, so nothing they are '
      + 'named on can be approved. Nothing was changed — pick somebody who is still here.';
  }

  return '';
}

/** What was read about the department and the person about to head it. */
export interface DepartmentHeadFacts {
  /** departments.id, ALWAYS as text. Never cast to uuid — it is a slug in one schema and a uuid in the other. */
  departmentId: string;
  departmentName: string;
  /** False when the id matched nothing on the department register. */
  departmentKnown: boolean;
  /** True when a head was asked for; false means "this department has no recorded head". */
  askedForAHead: boolean;
  headEmployeeId: string | null;
  /** False when that employee id matched no row. */
  headFound: boolean;
  headIsActive: boolean;
  /** users.id on the head's employee record. */
  headUserId: string | null;
  headName: string;
}

/**
 * Every reason a department head is refused.
 *
 * A HEAD WITH NO SIGN-IN IS AN EDGE THAT GRANTS NOTHING. userIsDepartmentHead() resolves a session
 * user id to an employee id and then asks the graph; with no linked login that resolution can never
 * match, so the department would read as headed on screen while every permission check answered no.
 * That is worse than an unheaded department, which at least says so.
 */
export function departmentHeadRefusal(f: DepartmentHeadFacts): string {
  if (!trimmed(f.departmentId)) {
    return 'No department was identified, so nothing was changed.';
  }
  if (!f.departmentKnown) {
    return 'That department is not on the department register, so nothing was changed.';
  }
  if (!f.askedForAHead) return '';

  if (!f.headFound) {
    return 'The person chosen has no record on the employee register, so they cannot be recorded as '
      + 'the head of ' + (f.departmentName || 'this department') + '. Nothing was changed.';
  }
  if (!f.headIsActive) {
    return (f.headName || 'That person') + ' is no longer an active employee, so nothing routed to '
      + 'the head of ' + (f.departmentName || 'this department') + ' would reach anybody. Nothing '
      + 'was changed — pick somebody who is still here.';
  }
  if (!f.headUserId) {
    return (f.headName || 'That person') + ' has an employee record but no linked sign-in, so no '
      + 'signed-in session could ever be matched to this headship: the department would read as '
      + 'headed while every permission check answered no. Nothing was changed — link a sign-in to '
      + 'their employee record first.';
  }
  return '';
}

/**
 * The sentence that says how far behind the compatibility column still is.
 *
 * WHY IT IS SAID AT ALL. The moment the first edge is written, org-graph's isInitialized() flips to
 * true for the WHOLE product — it asks only whether any active row exists, of any type — and about
 * twenty-five screens stop saying "Organization Graph not yet initialized" and start saying "no
 * reporting manager on record" for everybody who has not been saved yet. That second message is
 * honest about the graph and wrong about the company. Saying the number out loud, on the screen
 * that just wrote an edge, is how the person doing it finds out before the helpdesk does.
 */
export function coverageSentence(c: { columnOnly: number; withEdge: number }): string {
  const behind = Math.max(0, Number(c?.columnOnly) || 0);
  if (behind <= 0) return '';
  const people = behind === 1 ? '1 other active employee has' : behind + ' other active employees have';
  return people + ' a reporting manager recorded only on the older employee field and no edge in the '
    + 'Organization Graph. Their approvals still resolve through the compatibility layer until the '
    + 'graph backfill is run.';
}

// =================================================================================================
// THE WRITES
// =================================================================================================

export interface SetReportingLineInput {
  /** hr_employees.id of the person whose manager is being set. */
  employeeId: string;
  /**
   * The new manager, in EITHER id space. Give whichever one you hold and this resolves the other:
   *   managerEmployeeId  hr_employees.id — what the graph stores.
   *   managerUserId      users.id — what the legacy column stores, and what an admin <select> posts.
   * BOTH ABSENT MEANS CLEAR THE LINE. That is how a departure is recorded, and it is deliberate that
   * it is the same call rather than a separate function nobody remembers to reach for.
   */
  managerEmployeeId?: string | null;
  managerUserId?: string | null;
  /** The instant the change takes effect. Defaults to now. */
  asOf?: Date | string | null;
  /** users.id of whoever is making the change. Recorded on the edge and in audit_log. */
  actorUserId?: string | null;
  /** Free text stamped on the edge. Say WHICH screen or process wrote it. */
  note?: string | null;
}

export interface SetReportingLineResult {
  ok: boolean;
  /** True when an edge was opened or closed. False on an idempotent no-op. */
  edgeWritten: boolean;
  /**
   * org_relationships.id of the edge just opened, or null when nothing needed to be written because
   * the graph already held exactly this line. NULL IS NOT A FAILURE HERE — callers that record it
   * (hr_transfers.org_relationship_id) must not read an absent id as one.
   */
  edgeId: string | null;
  /** True when the compatibility column was updated. */
  columnWritten: boolean;
  /** The resolved manager, in both spaces, so callers do not resolve them a second time. */
  managerEmployeeId: string | null;
  managerUserId: string | null;
  managerName: string;
  /** Set on every non-ok result, and phrased for a person rather than a log. */
  error?: string;
}

const EMPTY_RESULT = {
  edgeWritten: false,
  edgeId: null as string | null,
  columnWritten: false,
  managerEmployeeId: null as string | null,
  managerUserId: null as string | null,
  managerName: '',
};

/**
 * The reporting-manager column has to exist before anything below can NAME it.
 *
 * Two admin pages ALTER it in at page load and db/org-graph-backfill.sql does the same in its guard
 * step, for the honest reason that on a fresh database it is genuinely absent — so a library that
 * writes it from a path those pages did not run would throw "column does not exist". Additive only,
 * IF NOT EXISTS, and behind ensureOnce so it costs one round trip per process rather than one per
 * write. The key matches the one /admin/hr/employees/[id].astro uses, so the two share the memo.
 *
 * ensure-once SWALLOWS FAILURE BY DESIGN, so its return proves nothing. That is fine here and only
 * here: if the column is still missing, the very next statement fails loudly with the real Postgres
 * reason and the write is refused. Nothing downstream trusts this having worked.
 */
async function ensureManagerColumn(): Promise<void> {
  await ensureOnce('hr_employees_reporting_manager_v1', async () => {
    await (await database()).execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS reporting_manager_id UUID`);
  }).catch((e: any) => logFail('reporting_manager_id bootstrap', e));
}

/**
 * SET SOMEBODY'S REPORTING MANAGER, IN BOTH RECORDS, OR IN NEITHER.
 *
 * This is the ONE function every writer calls — the Employment tab, an approved transfer, a
 * reassignment on somebody's exit. It supersedes rather than overwrites: the old edge is CLOSED with
 * an effective_to and a new one is opened at the same instant, so "who was the manager on the day
 * this leave was approved last March" still has an answer after the fourth reorganisation.
 *
 * IT NEVER THROWS. Every failure comes back as { ok: false } with a sentence naming what did not
 * happen and what was left alone. A write path that swallows an exception is how a sign-in outage
 * hid here for hours.
 */
export async function setReportingLine(input: SetReportingLineInput): Promise<SetReportingLineResult> {
  const employeeId = trimmed(input?.employeeId);
  if (!isUuid(employeeId)) {
    return { ok: false, ...EMPTY_RESULT, error: 'The employee record to change was not identified, so nothing was changed.' };
  }

  // WHICH ID SPACE THE CALLER SPOKE IN. A non-empty value that is not a uuid is REFUSED, never
  // quietly read as "no manager": silently clearing a reporting line because a form posted junk
  // removes an approver and reports success.
  const askedEmployee = trimmed(input?.managerEmployeeId);
  const askedUser = trimmed(input?.managerUserId);
  if (askedEmployee && !isUuid(askedEmployee)) {
    return { ok: false, ...EMPTY_RESULT, error: 'The manager was given as an id this page could not read, so nothing was changed.' };
  }
  if (askedUser && !isUuid(askedUser)) {
    return { ok: false, ...EMPTY_RESULT, error: 'The manager was given as a sign-in id this page could not read, so nothing was changed.' };
  }
  const askedForAManager = !!(askedEmployee || askedUser);

  await ensureManagerColumn();

  // -----------------------------------------------------------------------------------------
  // READ BOTH PEOPLE FIRST. A FAILED READ IS NOT A FACT.
  // Every refusal below is decided from these rows, so a read that threw means the checks cannot
  // be trusted — and writing approval authority that could not be checked is the outcome that
  // cannot be withdrawn afterwards.
  // -----------------------------------------------------------------------------------------
  let subject: any = null;
  try {
    const r = await (await database()).execute(sql`
      SELECT id, user_id, full_name, reporting_manager_id
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
    subject = rows(r)[0] || null;
  } catch (e: any) {
    logFail('subject read', e);
    return {
      ok: false, ...EMPTY_RESULT,
      error: 'The employee record could not be read, so the reporting line was not changed and '
        + 'nothing else was saved either: ' + reasonOf(e),
    };
  }
  if (!subject) {
    return { ok: false, ...EMPTY_RESULT, error: 'No employee record matched, so nothing was changed.' };
  }

  let manager: any = null;
  if (askedForAManager) {
    try {
      // ONE ROW, EVEN WHEN THE LOGIN OWNS SEVERAL. A rehire or a duplicate leaves one users id
      // against more than one employee record; the current, active one is the one the graph means.
      // The ORDER BY matches db/org-graph-backfill.sql exactly so the backfill and this writer
      // cannot pick different rows for the same person.
      const r = askedEmployee
        ? await (await database()).execute(sql`
            SELECT id, user_id, full_name, is_active FROM hr_employees
             WHERE id = ${askedEmployee}::uuid LIMIT 1`)
        : await (await database()).execute(sql`
            SELECT id, user_id, full_name, is_active FROM hr_employees
             WHERE user_id = ${askedUser}::uuid
             ORDER BY is_active DESC, created_at ASC LIMIT 1`);
      manager = rows(r)[0] || null;
    } catch (e: any) {
      logFail('manager read', e);
      return {
        ok: false, ...EMPTY_RESULT,
        error: 'The chosen manager could not be looked up, so the reporting line was not changed and '
          + 'nothing else was saved either: ' + reasonOf(e),
      };
    }
  }

  const facts: ReportingLineFacts = {
    subjectEmployeeId: employeeId,
    subjectUserId: subject.user_id ? String(subject.user_id) : null,
    subjectName: String(subject.full_name || 'This employee'),
    askedForAManager,
    managerEmployeeId: manager?.id ? String(manager.id) : null,
    managerUserId: manager?.user_id ? String(manager.user_id) : null,
    managerName: String(manager?.full_name || ''),
    // `is_active` is nullable on this table; only an explicit false means deactivated.
    managerIsActive: manager ? manager.is_active !== false : false,
  };

  const refusal = reportingLineRefusal(facts);
  if (refusal) {
    return {
      ok: false, ...EMPTY_RESULT,
      managerEmployeeId: facts.managerEmployeeId,
      managerUserId: facts.managerUserId,
      managerName: facts.managerName,
      error: refusal,
    };
  }

  // -----------------------------------------------------------------------------------------
  // 1. THE GRAPH. If this fails, NOTHING ELSE HAPPENS.
  // -----------------------------------------------------------------------------------------
  const moved = await supersedeReportingManager(employeeId, facts.managerEmployeeId, {
    asOf: input?.asOf ?? undefined,
    createdByUserId: input?.actorUserId ?? null,
    note: input?.note ? String(input.note).slice(0, 2000) : null,
  });
  if (!moved.ok) {
    return {
      ok: false, ...EMPTY_RESULT,
      managerEmployeeId: facts.managerEmployeeId,
      managerUserId: facts.managerUserId,
      managerName: facts.managerName,
      error: 'The reporting line was NOT changed in the Organization Graph, so the employee record '
        + 'was left exactly as it was and nothing else on this form was saved: '
        + (moved.error || 'unknown reason'),
    };
  }

  // -----------------------------------------------------------------------------------------
  // 2. THE COMPATIBILITY COLUMN, in the id space it actually holds: a USERS id.
  //
  // RETURNING, so "matched nothing" is not read as "done". A stale id from an open tab used to
  // report success on this project while changing no row at all.
  // -----------------------------------------------------------------------------------------
  let columnWritten = false;
  try {
    const r = await (await database()).execute(sql`
      UPDATE hr_employees
         SET reporting_manager_id = ${facts.managerUserId}::uuid,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid
      RETURNING id`);
    columnWritten = rows(r).length > 0;
    if (!columnWritten) {
      return {
        ok: false, edgeWritten: true, edgeId: moved.id || null, columnWritten: false,
        managerEmployeeId: facts.managerEmployeeId,
        managerUserId: facts.managerUserId,
        managerName: facts.managerName,
        error: 'THE TWO RECORDS NOW DISAGREE. The Organization Graph was updated, but no employee row '
          + 'matched when the older reporting-manager field was written, so it still holds the '
          + 'previous value. The graph is the one screens read first; every screen still reading the '
          + 'older field is behind until this record is saved again.',
      };
    }
  } catch (e: any) {
    logFail('column mirror', e);
    return {
      ok: false, edgeWritten: true, edgeId: moved.id || null, columnWritten: false,
      managerEmployeeId: facts.managerEmployeeId,
      managerUserId: facts.managerUserId,
      managerName: facts.managerName,
      error: 'THE TWO RECORDS NOW DISAGREE. The Organization Graph was updated and the older '
        + 'reporting-manager field was not: ' + reasonOf(e) + '. The graph is the one screens read '
        + 'first, so approvals route correctly — but anything still reading the older field is '
        + 'behind until this record is saved again.',
    };
  }

  // AUDITED FROM HERE, not from each caller, so no writer can forget. logAudit() swallows its own
  // failure and logs it: an audit outage must not undo a change that has already committed, and a
  // change that has already committed must not be reported as failed.
  await logAudit({
    userId: input?.actorUserId || null,
    action: facts.managerEmployeeId ? 'org.reporting_line.set' : 'org.reporting_line.cleared',
    entity: 'hr_employee',
    entityId: employeeId,
    diff: {
      managerEmployeeId: facts.managerEmployeeId,
      managerUserId: facts.managerUserId,
      managerName: facts.managerName,
      previousManagerUserId: subject.reporting_manager_id ? String(subject.reporting_manager_id) : null,
      edgeId: moved.id || null,
      note: input?.note || null,
    },
  });

  return {
    ok: true,
    // supersedeReportingManager() returns no id when the edge was ALREADY exactly this, which is a
    // success and not a write. Reporting that honestly lets a caller say "nothing needed changing".
    edgeWritten: !!moved.id,
    edgeId: moved.id || null,
    columnWritten,
    managerEmployeeId: facts.managerEmployeeId,
    managerUserId: facts.managerUserId,
    managerName: facts.managerName,
  };
}

export interface SetDepartmentHeadInput {
  /** departments.id, as TEXT. */
  departmentId: string;
  /** hr_employees.id of the new head. Absent means "this department has no recorded head". */
  headEmployeeId?: string | null;
  asOf?: Date | string | null;
  actorUserId?: string | null;
  note?: string | null;
}

export interface SetDepartmentHeadResult {
  ok: boolean;
  edgeWritten: boolean;
  headEmployeeId: string | null;
  headName: string;
  error?: string;
}

/**
 * SET WHO HEADS A DEPARTMENT.
 *
 * THERE IS NO COLUMN FOR THIS ANYWHERE, and that is not an oversight to work around. `departments`
 * has no head field in either schema file, and hr_employees has no is_head flag. The only signal in
 * the product today is the PAIR users.role = 'department_head' + users.assigned_department_id — and
 * the leadership half of that pair is a ROLE NAME, which must never be read as a relationship. So
 * the edge IS the record: there is nothing to mirror, and nothing can drift.
 *
 * IT SUPERSEDES, IT DOES NOT OVERWRITE. Setting a new head closes the incumbent's edge with an
 * effective_to at the same instant the new one opens, so a decision taken under the previous head
 * stays explicable. The database enforces one open head per department, so a second concurrent
 * writer is rejected by the index rather than by luck.
 */
export async function setDepartmentHead(input: SetDepartmentHeadInput): Promise<SetDepartmentHeadResult> {
  const departmentId = trimmed(input?.departmentId);
  if (!departmentId) {
    return { ok: false, edgeWritten: false, headEmployeeId: null, headName: '', error: 'No department was identified, so nothing was changed.' };
  }
  const askedHead = trimmed(input?.headEmployeeId);
  if (askedHead && !isUuid(askedHead)) {
    return { ok: false, edgeWritten: false, headEmployeeId: null, headName: '', error: 'The person chosen was given as an id this page could not read, so nothing was changed.' };
  }
  const askedForAHead = !!askedHead;

  // THE DEPARTMENT REGISTER, COMPARED AS TEXT ON BOTH SIDES. `departments.id` is a varchar(50) slug
  // in src/lib/db/schema.ts and a UUID in db/hr-schema.sql; casting a slug to ::uuid throws
  // "invalid input syntax for type uuid" the first time one arrives.
  let department: any = null;
  try {
    const r = await (await database()).execute(sql`
      SELECT id::text AS id, name FROM departments WHERE id::text = ${departmentId} LIMIT 1`);
    department = rows(r)[0] || null;
  } catch (e: any) {
    logFail('department read', e);
    return {
      ok: false, edgeWritten: false, headEmployeeId: null, headName: '',
      error: 'The department register could not be read, so this was not checked and nothing was changed: ' + reasonOf(e),
    };
  }

  let head: any = null;
  if (askedForAHead) {
    try {
      const r = await (await database()).execute(sql`
        SELECT id, user_id, full_name, is_active FROM hr_employees WHERE id = ${askedHead}::uuid LIMIT 1`);
      head = rows(r)[0] || null;
    } catch (e: any) {
      logFail('head read', e);
      return {
        ok: false, edgeWritten: false, headEmployeeId: null, headName: '',
        error: 'The person chosen could not be looked up, so nothing was changed: ' + reasonOf(e),
      };
    }
  }

  const facts: DepartmentHeadFacts = {
    departmentId,
    departmentName: String(department?.name || ''),
    departmentKnown: !!department,
    askedForAHead,
    headEmployeeId: head?.id ? String(head.id) : null,
    headFound: !!head,
    headIsActive: head ? head.is_active !== false : false,
    headUserId: head?.user_id ? String(head.user_id) : null,
    headName: String(head?.full_name || ''),
  };

  const refusal = departmentHeadRefusal(facts);
  if (refusal) {
    return { ok: false, edgeWritten: false, headEmployeeId: facts.headEmployeeId, headName: facts.headName, error: refusal };
  }

  const moved = await supersedeDepartmentHead(departmentId, facts.headEmployeeId, {
    asOf: input?.asOf ?? undefined,
    createdByUserId: input?.actorUserId ?? null,
    note: input?.note ? String(input.note).slice(0, 2000) : null,
  });
  if (!moved.ok) {
    return {
      ok: false, edgeWritten: false, headEmployeeId: facts.headEmployeeId, headName: facts.headName,
      error: 'The department head was NOT changed: ' + (moved.error || 'unknown reason'),
    };
  }

  // A HEADSHIP IS A REAL AUTHORITY CHANGE, so it leaves a trail with a name on it.
  await logAudit({
    userId: input?.actorUserId || null,
    action: facts.headEmployeeId ? 'org.department_head.set' : 'org.department_head.cleared',
    entity: 'department',
    entityId: departmentId,
    diff: {
      departmentName: facts.departmentName,
      headEmployeeId: facts.headEmployeeId,
      headName: facts.headName,
      edgeId: moved.id || null,
      note: input?.note || null,
    },
  });

  return { ok: true, edgeWritten: !!moved.id, headEmployeeId: facts.headEmployeeId, headName: facts.headName };
}

// =================================================================================================
// HOW FAR BEHIND THE OLD FIELD STILL IS
// =================================================================================================

export interface ReportingLineCoverage {
  /** The read answered. False means every number below is unknown, not zero. */
  ok: boolean;
  /** Active employees with a manager on the legacy column AND an open edge in the graph. */
  withEdge: number;
  /** Active employees with a manager on the legacy column and NO open edge. The backfill's work. */
  columnOnly: number;
  error?: string;
}

/**
 * COUNT THE DRIFT, so a screen can say it out loud instead of implying everything is fine.
 *
 * This asks a NARROWER question than org-graph's isInitialized(), on purpose. That function returns
 * true as soon as ANY active row of ANY type exists — one project-manager edge is enough — and
 * widening it would change the render on about twenty-five screens at once. This one asks only about
 * reporting lines, and it never returns 0 for a read that failed: `ok: false` and the reason.
 */
export async function reportingLineCoverage(): Promise<ReportingLineCoverage> {
  await ensureManagerColumn();
  try {
    const r = await (await database()).execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE g.open_edge)::int AS with_edge,
        COUNT(*) FILTER (WHERE NOT g.open_edge)::int AS column_only
      FROM (
        SELECT EXISTS (
                 SELECT 1 FROM org_relationships r
                  WHERE r.type = 'reporting_manager'
                    AND r.object_employee_id = e.id
                    AND r.status = 'active'
                    AND r.effective_to IS NULL
               ) AS open_edge
          FROM hr_employees e
         WHERE e.is_active = true
           AND e.reporting_manager_id IS NOT NULL
      ) g`);
    const row = rows(r)[0] || {};
    return { ok: true, withEdge: Number(row.with_edge) || 0, columnOnly: Number(row.column_only) || 0 };
  } catch (e: any) {
    logFail('reportingLineCoverage', e);
    // NOT zero. "Nobody is behind" and "this could not be counted" are opposite facts, and printing
    // the first over the second is how a screen reassures somebody about a graph it never read.
    return { ok: false, withEdge: 0, columnOnly: 0, error: reasonOf(e) };
  }
}
