// src/lib/credit-week-ledger.ts — the weekly credit RECORD: measured, decided, and kept with its
// evidence.
//
// =================================================================================================
// WHAT THIS FILE IS FOR
// =================================================================================================
//
// src/lib/credit-week.ts holds the rule and touches no database. This file does the three things
// the rule cannot do for itself:
//
//   1. MEASURE a week out of real storage — attendance clock pairs, approved leave, the holiday
//      list, daily reports, and the tasks that fell due in it.
//   2. WRITE the verdict as a durable record, WITH THE EVIDENCE IT RESTED ON, exactly once per
//      person per week.
//   3. ROUTE the weeks that did not qualify to a human, through src/lib/workflow.ts — the only
//      approval engine in this codebase — so a pending credit is never silently granted and never
//      silently refused.
//
// =================================================================================================
// IDEMPOTENCY, WHICH IS THE WHOLE SAFETY PROPERTY
// =================================================================================================
//
// RUNNING THE RECONCILIATION TWICE FOR ONE WEEK MUST NOT GRANT TWO CREDITS. Three things make that
// true, and each is load-bearing on its own:
//
//   - ONE ROW PER (employee_id, week_start), enforced by a unique index. A credit is the ROW, not
//     an event appended to a log, so there is nothing to double.
//   - A DECIDED WEEK IS FROZEN. Once a week is 'earned-automatically', 'approved' or 'refused' it
//     is never re-measured and never rewritten. That is not only about double-counting: a credit
//     granted six months ago must still be able to say WHAT IT WAS GRANTED ON, and a record that
//     recomputes itself every time somebody opens a page cannot. Only 'pending' rows move.
//   - EVERY WRITE REPEATS ITS OWN PRECONDITION. The transition to a credited state carries
//     `WHERE state = 'pending'`, so two requests racing on the same week make one of them touch
//     zero rows rather than both succeeding.
//
// The verdict itself is pure and deterministic (decideCreditWeek), so a second run over unchanged
// data produces the same answer and therefore has nothing to change.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Never r.rows[0]; every read goes through rows().
//   - The real Postgres reason is on e.cause. Logged as e?.cause?.message || e?.message, every time.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. Every writer returns a result that says whether it
//     wrote, and why not when it did not.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard: CREATE TABLE IF NOT EXISTS and
//     ADD COLUMN IF NOT EXISTS. Additive, never a DROP.
//   - departments.id is varchar(50) in schema.ts and UUID in hr-schema.sql. It is compared ::text
//     and never cast ::uuid, which throws on half the values in this product.
//   - Every const is declared before the function that reads it. const is not hoisted.
//
// EduRankAI is the technology platform. A credit recorded here is a record of work done on this
// platform. Accredited partners award credentials; nothing in this file confers a qualification.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { canonicalStatus } from '@/lib/employee-tasks';
import {
  decideCreditWeek, requiredWeeklyHours, weekStartOf, weekEndOf, weekStartsBetween, isoDate,
  isDecided, isCredited, positionFrom, weekLabel,
  type CreditWeekEvidence, type CreditPosition, type WeekDay, type WeekTasks, type RequiredHours,
} from '@/lib/credit-week';
import {
  startWorkflow, getInstance, decideStep, instanceForRecord,
} from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — all declared above every handler that reads them.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a plain array, never a { rows } object. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[credit-week-ledger] ' + tag, e?.cause?.message || e?.message);

const errText = (e: any, fallback: string): string =>
  String(e?.cause?.message || e?.message || fallback).slice(0, 300);

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED = 'Something went wrong recording that. Nothing was changed. Try again in a moment.';

/**
 * THE DOMAIN THE MANUAL DECISION IS ROUTED THROUGH. Declared once so no caller can invent a second.
 * src/lib/workflow.ts owns the chain: reporting manager per row from the Organization Graph, HR by
 * standing authority, and escalateStep() for the link above them.
 */
const CREDIT_DOMAIN = 'credit' as const;

/** Weeks read or reconciled in one call. A cohort console must page rather than widen this. */
const MAX_WEEKS = 104;

/** Pending weeks routed to a human in one reconciliation pass. */
const MAX_ROUTE_PER_PASS = 8;

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

const isUuid = (v: unknown): boolean =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const DAY_MS = 86400000;

/** Every ISO date from a to b inclusive. Bounded, so a bad range cannot spin. */
function datesBetween(fromIso: string, toIso: string, cap = 800): string[] {
  const a = new Date(fromIso + 'T00:00:00.000Z').getTime();
  const b = new Date(toIso + 'T00:00:00.000Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
  const out: string[] = [];
  for (let t = a; t <= b && out.length < cap; t += DAY_MS) out.push(isoDate(new Date(t)));
  return out;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * The weekly credit record.
 *
 * ONE ROW PER PERSON PER WEEK, and the unique index is what makes a credit un-doublable. The
 * evidence column is JSONB and is written ONCE, with the decision — see the header. A number with
 * no evidence behind it is exactly what /admin/hr/completion/[id] prints today.
 *
 * NO status COLUMN FOR THE APPROVAL, deliberately: whether a pending week is waiting, approved,
 * refused or halted for want of an approver is answered by workflow_instances keyed on
 * (domain = 'credit', record_id = this row's id). `state` here records the OUTCOME once it is
 * settled, together with who settled it and why — that is a decided fact about a credit, not a
 * second approval engine.
 */
export function ensureCreditWeekSchema(): Promise<void> {
  return ensureOnce('credit_weeks_v1', async () => {
    try {
      await createCreditWeekTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run from its cache so the next call
      // retries, and swallows the rejection for callers, which keeps the tolerate-missing-schema
      // behaviour every reader in this file is built on.
      logFail('ensureCreditWeekSchema', e);
      throw e;
    }
  });
}

async function createCreditWeekTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_credit_weeks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    credit_value NUMERIC(4,2) NOT NULL DEFAULT 1,
    hours_measured NUMERIC(6,2) NOT NULL DEFAULT 0,
    hours_required NUMERIC(6,2),
    reports_filed INT NOT NULL DEFAULT 0,
    reports_expected INT NOT NULL DEFAULT 0,
    tasks_completed INT NOT NULL DEFAULT 0,
    tasks_assigned INT NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_by_user_id UUID,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    workflow_instance_id UUID,
    halt_reason TEXT,
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Additive assertions, so a table created by an earlier version of this file completes rather
  // than being dropped and rebuilt. ADD COLUMN IF NOT EXISTS is a no-op where the column is there.
  for (const stmt of [
    "ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb",
    'ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS decision_reason TEXT',
    'ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS decided_by_name TEXT',
    'ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS workflow_instance_id UUID',
    'ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS halt_reason TEXT',
    'ALTER TABLE hr_credit_weeks ADD COLUMN IF NOT EXISTS hours_required NUMERIC(6,2)',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  // THE INDEX THAT MAKES A CREDIT UN-DOUBLABLE. Its own try/catch: a unique index is the one piece
  // of DDL here that can fail on DATA rather than on syntax (a database that already carries two
  // rows for one week), and losing it must not take the table with it. When it is absent the
  // upsert below still reads-then-writes correctly; what is lost is only the protection against a
  // simultaneous double write, which is the documented weaker guarantee rather than an outage.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_credit_weeks_emp_week
      ON hr_credit_weeks (employee_id, week_start)`);
  } catch (e: any) {
    logFail('hr_credit_weeks_emp_week', e);
  }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_credit_weeks_state_idx
    ON hr_credit_weeks (state, week_start DESC)`);
}

// -------------------------------------------------------------------------------------------------
// THE RECORD, AS CALLERS SEE IT
// -------------------------------------------------------------------------------------------------

export interface CreditWeekRow {
  id: string;
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  label: string;
  state: string;
  creditValue: number;
  hoursMeasured: number;
  hoursRequired: number | null;
  reportsFiled: number;
  reportsExpected: number;
  tasksCompleted: number;
  tasksAssigned: number;
  evidence: CreditWeekEvidence | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  workflowInstanceId: string | null;
  /** Set when routing could not name an approver. Rendered verbatim — never hidden. */
  haltReason: string | null;
  measuredAt: string | null;
  credited: boolean;
}

function mapWeek(r: any): CreditWeekRow {
  const ws = iso(r.week_start);
  let evidence: CreditWeekEvidence | null = null;
  const raw = r.evidence;
  if (raw && typeof raw === 'object') evidence = raw as CreditWeekEvidence;
  else if (typeof raw === 'string' && raw.trim()) {
    // Some drivers hand JSONB back as text. A record whose evidence cannot be parsed says so rather
    // than rendering as a credit with nothing behind it.
    try { evidence = JSON.parse(raw); } catch { evidence = null; }
  }
  return {
    id: String(r.id),
    employeeId: String(r.employee_id || ''),
    weekStart: ws,
    weekEnd: iso(r.week_end),
    label: weekLabel(ws),
    state: String(r.state || 'pending'),
    creditValue: Number(r.credit_value ?? 1),
    hoursMeasured: Number(r.hours_measured ?? 0),
    hoursRequired: r.hours_required == null ? null : Number(r.hours_required),
    reportsFiled: Number(r.reports_filed ?? 0),
    reportsExpected: Number(r.reports_expected ?? 0),
    tasksCompleted: Number(r.tasks_completed ?? 0),
    tasksAssigned: Number(r.tasks_assigned ?? 0),
    evidence,
    decidedByUserId: r.decided_by_user_id ? String(r.decided_by_user_id) : null,
    decidedByName: r.decided_by_name ? String(r.decided_by_name) : null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionReason: r.decision_reason ? String(r.decision_reason) : null,
    workflowInstanceId: r.workflow_instance_id ? String(r.workflow_instance_id) : null,
    haltReason: r.halt_reason ? String(r.halt_reason) : null,
    measuredAt: r.measured_at ? new Date(r.measured_at).toISOString() : null,
    credited: isCredited(String(r.state || '')),
  };
}

// -------------------------------------------------------------------------------------------------
// MEASUREMENT — real data only.
// -------------------------------------------------------------------------------------------------

interface EmployeeContext {
  id: string;
  fullName: string;
  designation: string;
  employmentType: string;
  departmentId: string;
  weeklyHours: number | null;
  startIso: string;
  endIso: string;
  required: RequiredHours;
}

/** The person, the dates their engagement covers, and the week they are measured against. */
async function employeeContext(employeeId: string): Promise<EmployeeContext | null> {
  // ensureTermColumns() is credit-ledger's, and weekly_hours is one of the four it adds. Asked for
  // here through a tolerant SELECT instead of a second set of ALTERs: four ALTER TABLE statements
  // per page load take a lock on hr_employees even when they are no-ops.
  let r: any = null;
  try {
    r = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name, e.designation, e.employment_type,
             e.department_id::text AS department_id, e.weekly_hours,
             e.joining_date, e.exit_date, e.last_working_day
        FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
  } catch (e: any) {
    // weekly_hours may not exist on a database where no engagement terms have ever been saved.
    // Retry without it: an unrecorded contract is exactly the case this whole change is about, and
    // it must degrade to "unknown", not to a failed read.
    logFail('employeeContext weekly_hours', e);
    try {
      r = rows(await db.execute(sql`
        SELECT e.id::text AS id, e.full_name, e.designation, e.employment_type,
               e.department_id::text AS department_id, NULL AS weekly_hours,
               e.joining_date, e.exit_date, e.last_working_day
          FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
    } catch (e2: any) {
      logFail('employeeContext', e2);
      throw e2;
    }
  }
  if (!r) return null;

  const weekly = r.weekly_hours == null ? null : Number(r.weekly_hours);
  const required = requiredWeeklyHours({
    employmentType: r.employment_type,
    designation: r.designation,
    recordedWeeklyHours: Number.isFinite(weekly as number) ? weekly : null,
  });

  const today = isoDate(new Date());
  const ended = iso(r.last_working_day) || iso(r.exit_date);
  return {
    id: String(r.id),
    fullName: String(r.full_name || 'This person'),
    designation: String(r.designation || ''),
    employmentType: String(r.employment_type || ''),
    departmentId: r.department_id ? String(r.department_id) : '',
    weeklyHours: Number.isFinite(weekly as number) ? (weekly as number) : null,
    startIso: iso(r.joining_date),
    endIso: ended && ended < today ? ended : today,
    required,
  };
}

interface RawWeekData {
  attendance: Map<string, any>;
  leaveUnits: Map<string, number>;
  holidays: Set<string>;
  reports: Set<string>;
  tasks: { dueOn: string; status: string; title: string }[];
  /** Names the reads that did NOT happen, so a verdict is never built on a silent gap. */
  unread: string[];
}

/**
 * EVERYTHING ONE PERSON'S WEEKS ARE MEASURED FROM, in one pass over a bounded date range.
 *
 * EACH SOURCE HAS ITS OWN try/catch AND ITS OWN ENTRY IN `unread`. A single Promise.all here would
 * mean one failing read produced an empty holiday list, which reads as "no holidays" — and a person
 * would be measured as short by a day they were not required to work. An unread source is NAMED and
 * BLOCKS the automatic path; it never degrades quietly into a harsher measurement.
 */
async function readRange(ctx: EmployeeContext, fromIso: string, toIso: string): Promise<RawWeekData> {
  const out: RawWeekData = {
    attendance: new Map(), leaveUnits: new Map(), holidays: new Set(), reports: new Set(),
    tasks: [], unread: [],
  };

  // ---- attendance, with the clock pair and the breaks -----------------------------------------
  // break_minutes is added at runtime by attendance-schema.ts and may be absent; clock_in and
  // clock_out are in db/hr-schema.sql and always exist. Naming a missing column would throw and
  // take the whole measurement with it.
  try {
    let att: any[] = [];
    try {
      att = rows(await db.execute(sql`
        SELECT a.date, a.status, a.work_hours, a.clock_in, a.clock_out, a.break_minutes
          FROM hr_attendance a
         WHERE a.employee_id = ${ctx.id}::uuid AND a.date BETWEEN ${fromIso}::date AND ${toIso}::date
         ORDER BY a.date ASC`));
    } catch (e: any) {
      logFail('readRange attendance break_minutes', e);
      att = rows(await db.execute(sql`
        SELECT a.date, a.status, a.work_hours, a.clock_in, a.clock_out, 0 AS break_minutes
          FROM hr_attendance a
         WHERE a.employee_id = ${ctx.id}::uuid AND a.date BETWEEN ${fromIso}::date AND ${toIso}::date
         ORDER BY a.date ASC`));
    }
    for (const a of att) out.attendance.set(iso(a.date), a);
  } catch (e: any) {
    logFail('readRange attendance', e);
    out.unread.push('attendance');
  }

  // ---- approved leave --------------------------------------------------------------------------
  // APPROVED LEAVE REDUCES THE REQUIREMENT. Prior notice is NOT the test here, and that difference
  // is deliberate: notice governs whether an absence damages an ATTENDANCE figure (credit-hours.ts),
  // whereas a week's REQUIREMENT drops for leave the organisation granted, however late it was
  // asked for. Charging somebody hours for leave that was approved is how a figure stops being
  // believed.
  try {
    let lv: any[] = [];
    try {
      lv = rows(await db.execute(sql`
        SELECT start_date, end_date, days, day_units
          FROM hr_leave_request
         WHERE employee_id = ${ctx.id}::uuid AND status = 'approved'
           AND end_date >= ${fromIso}::date AND start_date <= ${toIso}::date`));
    } catch (e: any) {
      // day_units is asserted at runtime by ensureLeaveSchema() and may not be there yet.
      logFail('readRange leave day_units', e);
      lv = rows(await db.execute(sql`
        SELECT start_date, end_date, days, NULL AS day_units
          FROM hr_leave_request
         WHERE employee_id = ${ctx.id}::uuid AND status = 'approved'
           AND end_date >= ${fromIso}::date AND start_date <= ${toIso}::date`));
    }
    for (const l of lv) {
      const s = iso(l.start_date);
      const e2 = iso(l.end_date) || s;
      const span = datesBetween(s, e2);
      const units = Number(l.day_units);
      // day_units is what the whole REQUEST costs; per day it is that spread over the span. A half
      // day request is days=1, day_units=0.5, which excuses half a day and not a whole one.
      const perDay = Number.isFinite(units) && units > 0 && span.length > 0
        ? Math.min(1, units / span.length)
        : 1;
      for (const d of span) {
        if (d < fromIso || d > toIso) continue;
        out.leaveUnits.set(d, Math.min(1, (out.leaveUnits.get(d) || 0) + perDay));
      }
    }
  } catch (e: any) {
    logFail('readRange leave', e);
    out.unread.push('approved leave');
  }

  // ---- holidays --------------------------------------------------------------------------------
  // department_id is compared as TEXT and never cast ::uuid: departments.id is a varchar(50) slug in
  // schema.ts and a UUID in hr-schema.sql, and a cast throws on half the values in this product.
  try {
    const hs = rows(await db.execute(sql`
      SELECT holiday_date FROM hr_holidays
       WHERE holiday_date BETWEEN ${fromIso}::date AND ${toIso}::date
         AND (department_id IS NULL OR department_id = ${ctx.departmentId})`));
    for (const h of hs) out.holidays.add(iso(h.holiday_date));
  } catch (e: any) {
    // hr_holidays is created by attendance-schema.ts and may not exist yet. That is a MISSING
    // HOLIDAY LIST, not "there were no holidays", and the difference matters: without it a public
    // holiday reads as a day somebody failed to work.
    logFail('readRange holidays', e);
    out.unread.push('the holiday list');
  }

  // ---- daily reports ---------------------------------------------------------------------------
  try {
    const rp = rows(await db.execute(sql`
      SELECT report_date FROM hr_daily_reports
       WHERE employee_id = ${ctx.id}::uuid AND report_date BETWEEN ${fromIso}::date AND ${toIso}::date`));
    for (const p of rp) out.reports.add(iso(p.report_date));
  } catch (e: any) {
    logFail('readRange reports', e);
    out.unread.push('daily reports');
  }

  // ---- assigned work ---------------------------------------------------------------------------
  // Tasks that FELL DUE inside the range. A task with no due date belongs to no week and is not
  // counted against any of them — inventing a week for it would make somebody's credit depend on
  // when a colleague happened to create a row.
  try {
    const ts = rows(await db.execute(sql`
      SELECT due_on, status, title FROM employee_tasks
       WHERE employee_id = ${ctx.id}::uuid AND due_on BETWEEN ${fromIso}::date AND ${toIso}::date
       LIMIT 500`));
    for (const t of ts) {
      out.tasks.push({ dueOn: iso(t.due_on), status: String(t.status || ''), title: String(t.title || 'Task') });
    }
  } catch (e: any) {
    logFail('readRange tasks', e);
    out.unread.push('assigned tasks');
  }

  return out;
}

/** Hours measured off a real clock pair, net of recorded breaks. Null when there is no pair. */
function clockHours(a: any): number | null {
  const inAt = a?.clock_in ? new Date(a.clock_in).getTime() : NaN;
  const outAt = a?.clock_out ? new Date(a.clock_out).getTime() : NaN;
  if (!Number.isFinite(inAt) || !Number.isFinite(outAt) || outAt <= inAt) return null;
  const brk = Number(a?.break_minutes);
  const net = (outAt - inAt) / 3600000 - (Number.isFinite(brk) && brk > 0 ? brk / 60 : 0);
  return net > 0 ? round2(net) : null;
}

/** Turn one week's raw storage into the pure input decideCreditWeek() takes. */
function buildWeekDays(weekStart: string, weekEnd: string, ctx: EmployeeContext, raw: RawWeekData): WeekDay[] {
  const days: WeekDay[] = [];
  for (const d of datesBetween(weekStart, weekEnd)) {
    // Nothing before somebody joined, and nothing after they left, is a day they owed anything on.
    // Both ends matter: without the upper bound a leaver's final part-week would carry a full
    // week's requirement across days their engagement had already ended on.
    if (ctx.startIso && d < ctx.startIso) continue;
    if (ctx.endIso && d > ctx.endIso) continue;

    const a = raw.attendance.get(d);
    const status = String(a?.status || '');
    const worked = status === 'present' || status === 'wfh';
    const entered = a && a.work_hours != null && Number(a.work_hours) > 0 ? Number(a.work_hours) : null;
    const clocked = a ? clockHours(a) : null;

    days.push({
      date: d,
      clockHours: worked ? clocked : null,
      recordedHours: worked ? entered : null,
      // A DAY CLOCKED INTO AND NEVER CLOCKED OUT OF. Not eight hours, not zero — unknown, named,
      // and it blocks the automatic path. That block is the reason the human override exists.
      incomplete: !!(a && a.clock_in && !a.clock_out && entered === null),
      worked,
      holiday: raw.holidays.has(d) || status === 'holiday',
      approvedLeaveUnits: raw.leaveUnits.get(d) || 0,
      reportFiled: raw.reports.has(d),
    });
  }
  return days;
}

function buildWeekTasks(weekStart: string, weekEnd: string, raw: RawWeekData): WeekTasks {
  const inWeek = raw.tasks.filter((t) => t.dueOn >= weekStart && t.dueOn <= weekEnd);
  let assigned = 0;
  let completed = 0;
  const outstanding: string[] = [];
  for (const t of inWeek) {
    const canon = canonicalStatus(t.status);
    // Cancelled and archived work was withdrawn. Counting it against somebody would mean a task
    // somebody else called off keeps their credit pending forever.
    if (canon === 'cancelled' || canon === 'archived') continue;
    assigned++;
    if (canon === 'completed') completed++;
    else outstanding.push(t.title);
  }
  return { assigned, completed, outstanding };
}

// -------------------------------------------------------------------------------------------------
// RECONCILIATION — measure, write once, auto-approve idempotently.
// -------------------------------------------------------------------------------------------------

export interface ReconcileResult {
  ok: boolean;
  error: string | null;
  /** True only when this engagement is measured in weekly credits at all. */
  applicable: boolean;
  /** Why not, when it is not. A sentence, rendered verbatim. */
  notApplicableReason: string | null;
  weeksExamined: number;
  granted: number;
  pending: number;
  /** Sources that could not be read. A verdict is never built on a silent gap — see readRange. */
  unread: string[];
  weeks: CreditWeekRow[];
}

/**
 * MEASURE EVERY ELAPSED WEEK AND RECORD ITS VERDICT.
 *
 * SAFE TO CALL ON EVERY PAGE LOAD, which is the point: a credit that only appears when somebody
 * remembers to run a job is a credit somebody will be told they do not have. Decided weeks are
 * skipped without a write, so the steady state is a handful of reads.
 *
 * THE CURRENT WEEK IS MEASURED BUT NEVER STORED. A week still running has not fallen short of
 * anything yet, and writing a 'pending' row for it would put a person's live week on an approver's
 * queue every Monday morning.
 */
export async function reconcileCreditWeeks(
  employeeId: string,
  opts: { maxWeeks?: number } = {},
): Promise<ReconcileResult> {
  const base: ReconcileResult = {
    ok: false, error: null, applicable: false, notApplicableReason: null,
    weeksExamined: 0, granted: 0, pending: 0, unread: [], weeks: [],
  };
  if (!isUuid(employeeId)) {
    return { ...base, ok: true, notApplicableReason: 'No employee record is linked to this person.' };
  }

  try {
    await ensureCreditWeekSchema();

    const ctx = await employeeContext(employeeId);
    if (!ctx) {
      return { ...base, ok: true, notApplicableReason: 'That employee record could not be found.' };
    }
    if (!ctx.required.applicable) {
      // A full-time employee is not on the internship model and must not be measured by it. Said in
      // words rather than shown as zero credits, which reads as somebody who earned none.
      return { ...base, ok: true, applicable: false, notApplicableReason: ctx.required.basis };
    }
    if (!ctx.startIso) {
      return {
        ...base, ok: true, applicable: true,
        notApplicableReason: 'No joining date is recorded, so there is no first week to measure from.',
      };
    }

    const limit = Math.min(Math.max(Number(opts.maxWeeks) || MAX_WEEKS, 1), MAX_WEEKS);
    const allWeeks = weekStartsBetween(ctx.startIso, ctx.endIso);
    const currentWeek = weekStartOf(isoDate(new Date()));
    // Elapsed weeks only, most recent first, then back into chronological order for the reader.
    const elapsed = allWeeks.filter((w) => w < currentWeek).slice(-limit);
    if (!elapsed.length) {
      return {
        ...base, ok: true, applicable: true,
        notApplicableReason: 'No week has finished yet. A week is decided once it has run its course.',
        weeks: [],
      };
    }

    const rangeFrom = elapsed[0];
    const rangeTo = weekEndOf(elapsed[elapsed.length - 1]);
    const raw = await readRange(ctx, rangeFrom, rangeTo);

    const existing = new Map<string, any>();
    for (const r of rows(await db.execute(sql`
      SELECT * FROM hr_credit_weeks
       WHERE employee_id = ${ctx.id}::uuid AND week_start BETWEEN ${rangeFrom}::date AND ${rangeTo}::date`))) {
      existing.set(iso(r.week_start), r);
    }

    let granted = 0;
    let pending = 0;

    for (const ws of elapsed) {
      const we = weekEndOf(ws);
      const prior = existing.get(ws);

      // A DECIDED WEEK IS FROZEN. Not re-measured, not rewritten, and its evidence is left exactly
      // as it was when somebody or something decided it. See the header on idempotency.
      if (prior && isDecided(String(prior.state))) {
        if (isCredited(String(prior.state))) granted++;
        continue;
      }

      const verdict = decideCreditWeek({
        employeeId: ctx.id,
        weekStart: ws,
        weekEnd: we,
        required: ctx.required,
        days: buildWeekDays(ws, we, ctx, raw),
        tasks: buildWeekTasks(ws, we, raw),
        weekComplete: true,
      });

      // A SOURCE THAT COULD NOT BE READ CANNOT PRODUCE AN AUTOMATIC CREDIT. An unreadable holiday
      // list or task table is a gap in the evidence, and a credit granted on evidence nobody could
      // read is the failure this record exists to prevent — in either direction.
      const blockedByGap = raw.unread.length > 0;
      const state = verdict.automatic && !blockedByGap ? 'earned-automatically' : 'pending';
      const evidence: CreditWeekEvidence = blockedByGap
        ? {
            ...verdict.evidence,
            findings: verdict.evidence.findings.concat([
              'Could not be read at the time of measurement: ' + raw.unread.join(', ')
              + '. Automatic credit was withheld because the evidence was incomplete.',
            ]),
          }
        : verdict.evidence;

      const e = verdict.evidence;
      const evidenceJson = JSON.stringify(evidence);

      if (!prior) {
        // ON CONFLICT DO NOTHING with NO TARGET, deliberately: naming (employee_id, week_start)
        // would make this statement THROW on a database where that unique index failed to create,
        // and the index has its own try/catch above precisely because it is allowed to fail without
        // taking the table with it. Untargeted covers whatever unique indexes exist and degrades to
        // an ordinary insert where none do.
        await db.execute(sql`
          INSERT INTO hr_credit_weeks
            (employee_id, week_start, week_end, state, credit_value, hours_measured, hours_required,
             reports_filed, reports_expected, tasks_completed, tasks_assigned, evidence, measured_at)
          VALUES
            (${ctx.id}::uuid, ${ws}::date, ${we}::date, ${state}, ${verdict.creditValue},
             ${e.hoursMeasured}, ${e.hoursRequired}, ${e.reportsFiled}, ${e.reportsExpected},
             ${e.tasksCompleted}, ${e.tasksAssigned}, ${evidenceJson}::jsonb, NOW())
          ON CONFLICT DO NOTHING`);
      } else {
        // THE PRECONDITION IS REPEATED IN THE WRITE. Two requests racing on the same pending week
        // make one of them touch zero rows rather than both granting a credit.
        await db.execute(sql`
          UPDATE hr_credit_weeks
             SET state = ${state}, hours_measured = ${e.hoursMeasured}, hours_required = ${e.hoursRequired},
                 reports_filed = ${e.reportsFiled}, reports_expected = ${e.reportsExpected},
                 tasks_completed = ${e.tasksCompleted}, tasks_assigned = ${e.tasksAssigned},
                 evidence = ${evidenceJson}::jsonb, measured_at = NOW(), updated_at = NOW()
           WHERE id = ${String(prior.id)}::uuid AND state = 'pending'`);
      }

      if (state === 'earned-automatically') granted++;
      else pending++;
    }

    const weeks = await listCreditWeeks(ctx.id, { limit });
    return {
      ok: true, error: null, applicable: true, notApplicableReason: null,
      weeksExamined: elapsed.length, granted, pending, unread: raw.unread, weeks,
    };
  } catch (e: any) {
    // NEVER SWALLOWED. A reconciliation that failed must not read on screen as a person who earned
    // nothing — ok:false is what lets a surface say the ledger could not be built.
    logFail('reconcileCreditWeeks', e);
    return { ...base, ok: false, error: errText(e, 'The weekly credit record could not be built.') };
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface CreditWeeksRead {
  ok: boolean;
  error: string | null;
  weeks: CreditWeekRow[];
  position: CreditPosition;
}

/** The stored weeks for one person, newest first. */
export async function listCreditWeeks(
  employeeId: string,
  opts: { limit?: number } = {},
): Promise<CreditWeekRow[]> {
  if (!isUuid(employeeId)) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || MAX_WEEKS, 1), MAX_WEEKS);
  try {
    await ensureCreditWeekSchema();
    return rows(await db.execute(sql`
      SELECT * FROM hr_credit_weeks WHERE employee_id = ${employeeId}::uuid
       ORDER BY week_start DESC LIMIT ${limit}`)).map(mapWeek);
  } catch (e: any) {
    logFail('listCreditWeeks', e);
    return [];
  }
}

/**
 * WHAT THIS PERSON HAS EARNED AND WHAT IS STILL WAITING, with the flag that says whether it was
 * read at all.
 *
 * ok:false is not the same fact as zero credits and must not render the same way. Every field below
 * is a plausible-looking zero when the read failed.
 */
export async function creditWeeksFor(employeeId: string): Promise<CreditWeeksRead> {
  const empty = { earnedAutomatically: 0, approvedByPerson: 0, pending: 0, refused: 0, credits: 0, hoursMeasured: 0 };
  if (!isUuid(employeeId)) return { ok: true, error: null, weeks: [], position: empty };
  try {
    await ensureCreditWeekSchema();
    const weeks = rows(await db.execute(sql`
      SELECT * FROM hr_credit_weeks WHERE employee_id = ${employeeId}::uuid
       ORDER BY week_start DESC LIMIT ${MAX_WEEKS}`)).map(mapWeek);
    return { ok: true, error: null, weeks, position: positionFrom(weeks) };
  } catch (e: any) {
    logFail('creditWeeksFor', e);
    return { ok: false, error: errText(e, 'The weekly credit record could not be read.'), weeks: [], position: empty };
  }
}

/** One stored week, for a decision screen that needs its evidence before anybody acts. */
export async function getCreditWeek(weekId: string): Promise<CreditWeekRow | null> {
  if (!isUuid(weekId)) return null;
  try {
    await ensureCreditWeekSchema();
    const r = rows(await db.execute(sql`SELECT * FROM hr_credit_weeks WHERE id = ${weekId}::uuid LIMIT 1`))[0];
    return r ? mapWeek(r) : null;
  } catch (e: any) {
    logFail('getCreditWeek', e);
    return null;
  }
}

export interface PendingCreditWeek extends CreditWeekRow {
  employeeName: string;
  employeeCode: string;
}

/**
 * EVERY PENDING WEEK IN THE ORGANISATION, for the HR desk.
 *
 * EXPLICITLY NOT AN APPROVER'S QUEUE. workflow.pendingForApprover() answers "what is routed to
 * you", and that is the narrower, per-row question a reporting manager should be asked. This is the
 * full list, labelled as such, for the desk that holds `employee.manage` and owns the completion
 * letter these weeks end up on — the same distinction workflow.listInstances() draws.
 */
export async function pendingCreditWeeks(limit = 100): Promise<PendingCreditWeek[]> {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
  try {
    await ensureCreditWeekSchema();
    return rows(await db.execute(sql`
      SELECT w.*, e.full_name, e.employee_code
        FROM hr_credit_weeks w
        LEFT JOIN hr_employees e ON e.id = w.employee_id
       WHERE w.state = 'pending'
       ORDER BY w.week_start ASC
       LIMIT ${n}`)).map((r: any) => ({
        ...mapWeek(r),
        employeeName: String(r.full_name || 'Unnamed'),
        employeeCode: String(r.employee_code || ''),
      }));
  } catch (e: any) {
    logFail('pendingCreditWeeks', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// THE MANUAL ROUTE — through src/lib/workflow.ts, and through nothing else.
// -------------------------------------------------------------------------------------------------

export interface RouteResult {
  ok: boolean;
  error: string | null;
  routed: number;
  /** Weeks whose routing could not name an approver, with the sentence saying which link is missing. */
  halted: { weekStart: string; reason: string }[];
}

/**
 * PUT PENDING WEEKS IN FRONT OF A PERSON.
 *
 * THE APPROVER IS A RELATIONSHIP, resolved by workflow.resolveRoute() from src/lib/org-graph.ts —
 * the reporting manager, per row, as at now. Never from users.role, and never from a list in this
 * file. HR reaches a week through the standing authority declared on the domain, and a more senior
 * authority through escalateStep(); neither needs a second chain here.
 *
 * WHEN THE GRAPH NAMES NOBODY IT HALTS AND SAYS SO. startWorkflow() still creates the instance, in
 * state 'halted', carrying the sentence — a halted row is visible and resumable, whereas declining
 * to create it would leave a person's credit waiting on nothing that anybody is looking at. The
 * sentence is stored on the week so the screen can print it verbatim.
 *
 * IDEMPOTENT: startWorkflow is idempotent on (domain, record_id), and the record id here is the
 * credit week's own id. Calling this twice routes each week once.
 */
export async function routePendingCreditWeeks(
  employeeId: string,
  actorUserId: string | null,
  limit = MAX_ROUTE_PER_PASS,
): Promise<RouteResult> {
  const out: RouteResult = { ok: false, error: null, routed: 0, halted: [] };
  if (!isUuid(employeeId)) return { ...out, ok: true };
  const n = Math.min(Math.max(Number(limit) || MAX_ROUTE_PER_PASS, 1), 25);

  try {
    await ensureCreditWeekSchema();
    const pend = rows(await db.execute(sql`
      SELECT id, week_start, week_end, workflow_instance_id, hours_measured, hours_required
        FROM hr_credit_weeks
       WHERE employee_id = ${employeeId}::uuid AND state = 'pending' AND workflow_instance_id IS NULL
       ORDER BY week_start ASC LIMIT ${n}`));

    for (const w of pend) {
      const ws = iso(w.week_start);
      const summary = 'Weekly credit for ' + weekLabel(ws) + ': measured '
        + Number(w.hours_measured ?? 0) + ' of '
        + (w.hours_required == null ? 'an unrecorded requirement' : Number(w.hours_required) + ' hour(s)') + '.';

      const res = await startWorkflow({
        domain: CREDIT_DOMAIN,
        recordId: String(w.id),
        subjectEmployeeId: employeeId,
        requestedByUserId: null,
        createdByUserId: isUuid(actorUserId) ? String(actorUserId) : null,
        summary,
      });

      if (!res.ok) {
        // Not swallowed and not retried in a loop: the week keeps workflow_instance_id NULL and the
        // next pass tries again, which is the correct behaviour for a transient failure.
        out.error = res.error || WRITE_FAILED;
        continue;
      }

      await db.execute(sql`
        UPDATE hr_credit_weeks
           SET workflow_instance_id = ${res.instanceId || null}::uuid,
               halt_reason = ${res.haltReason || null}::text,
               updated_at = NOW()
         WHERE id = ${String(w.id)}::uuid AND state = 'pending'`);

      if (res.state === 'halted') out.halted.push({ weekStart: ws, reason: res.haltReason || 'No approver could be named.' });
      else out.routed++;
    }

    return { ...out, ok: true };
  } catch (e: any) {
    logFail('routePendingCreditWeeks', e);
    return { ...out, ok: false, error: errText(e, 'Those weeks could not be sent for a decision.') };
  }
}

export interface DecisionResult {
  ok: boolean;
  error: string | null;
  state?: string;
}

/**
 * A PERSON DECIDES A PENDING WEEK, WITH A REASON.
 *
 * THE REASON IS MANDATORY ON BOTH ANSWERS, which is stricter than the rest of this product (where
 * only a refusal needs one) and deliberately so: approving here means crediting somebody for a week
 * THE MEASUREMENT DID NOT SUPPORT, and a credit granted with no stated cause is indistinguishable
 * six months later from one granted by mistake. That sentence is what the record has instead of the
 * evidence it could not rely on.
 *
 * AUTHORITY IS NOT DECIDED HERE. decideStep() re-derives it through workflow.mayAct(): the routed
 * approver, their in-force delegate, or a holder of the domain's standing authority. A posted week
 * id from somebody with no claim on it is refused there, not by the fact that a page drew no button.
 */
export async function decidePendingCreditWeek(
  weekId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  decision: 'approved' | 'refused',
  reason: string,
): Promise<DecisionResult> {
  if (!isUuid(weekId)) return { ok: false, error: 'That week is not available.' };
  if (decision !== 'approved' && decision !== 'refused') {
    return { ok: false, error: 'That decision could not be read.' };
  }
  const why = String(reason || '').trim().slice(0, 500);
  if (why.length < 3) {
    return {
      ok: false,
      error: 'A reason is required. Somebody is being credited, or refused credit, for a week the '
        + 'measurement did not fully support, and the record has to say why.',
    };
  }

  try {
    await ensureCreditWeekSchema();
    const row = rows(await db.execute(sql`
      SELECT id, state, workflow_instance_id FROM hr_credit_weeks WHERE id = ${weekId}::uuid LIMIT 1`))[0];
    if (!row) return { ok: false, error: 'That week is not available.' };
    if (isDecided(String(row.state))) {
      // Already settled. Reported as a no-op rather than an error: two people opening the same queue
      // is ordinary, and telling the second one it failed makes them decide it again somewhere else.
      return { ok: true, error: null, state: String(row.state) };
    }
    if (!row.workflow_instance_id) {
      return {
        ok: false,
        error: 'This week has not been sent for a decision yet, so there is no approval to act on.',
      };
    }

    const inst = await getInstance(String(row.workflow_instance_id));
    if (!inst) return { ok: false, error: 'The approval for this week could not be read.' };
    if (inst.state === 'halted') {
      return {
        ok: false,
        error: inst.haltReason
          || 'No approver is named for this week in the organization graph, so it cannot be decided yet.',
      };
    }
    const step = inst.steps.find((s) => s.stepNo === inst.currentStep && s.decision === 'pending');
    if (!step) return { ok: false, error: 'There is no step waiting on a decision for this week.' };

    // THE ONE APPROVAL PATH. rejected is workflow's word for the negative answer; refused is this
    // ledger's word for the same fact about a credit. They are mapped here, once.
    const res = await decideStep(step.id, user as any, decision === 'approved' ? 'approved' : 'rejected', why);
    if (!res.ok) return { ok: false, error: res.error || WRITE_FAILED };

    const name = await deciderName(user?.id || null);
    // The precondition is repeated in the write, so a colleague who decided a second earlier makes
    // this touch zero rows rather than overwriting their decision with this one.
    await db.execute(sql`
      UPDATE hr_credit_weeks
         SET state = ${decision}, decision_reason = ${why}, decided_at = NOW(),
             decided_by_user_id = ${isUuid(user?.id) ? String(user!.id) : null}::uuid,
             decided_by_name = ${name}::text, updated_at = NOW()
       WHERE id = ${weekId}::uuid AND state = 'pending'`);

    return { ok: true, error: null, state: decision };
  } catch (e: any) {
    // A WRITE PATH NEVER SWALLOWS. The real Postgres reason goes to the log; the person is told
    // plainly that nothing was recorded.
    logFail('decideCreditWeek', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Who decided, by name, so the record does not only carry an id nobody can read. */
async function deciderName(userId: string | null): Promise<string> {
  if (!isUuid(userId)) return 'Unknown';
  try {
    const r = rows(await db.execute(sql`
      SELECT full_name FROM hr_employees WHERE user_id = ${userId}::uuid LIMIT 1`))[0];
    return r?.full_name ? String(r.full_name) : 'Unknown';
  } catch (e: any) {
    logFail('deciderName', e);
    return 'Unknown';
  }
}

/**
 * REFLECT A DECISION MADE SOMEWHERE ELSE.
 *
 * /portal/approvals is generic: it lists every routed step whatever its domain, and a reporting
 * manager will approve a credit week there without ever opening a credit screen. When they do, the
 * workflow instance settles and this ledger has not been told. This reads the settled instances back
 * and writes the outcome, the decider and their note onto the week.
 *
 * ONLY 'pending' ROWS ARE TOUCHED, so it can be called freely and cannot rewrite a decided week.
 */
export async function syncCreditDecisions(employeeId: string): Promise<{ ok: boolean; updated: number; error: string | null }> {
  if (!isUuid(employeeId)) return { ok: true, updated: 0, error: null };
  try {
    await ensureCreditWeekSchema();
    const pend = rows(await db.execute(sql`
      SELECT id, workflow_instance_id FROM hr_credit_weeks
       WHERE employee_id = ${employeeId}::uuid AND state = 'pending' AND workflow_instance_id IS NOT NULL
       LIMIT 50`));

    let updated = 0;
    for (const w of pend) {
      const inst = await getInstance(String(w.workflow_instance_id));
      if (!inst) continue;
      if (inst.state !== 'approved' && inst.state !== 'rejected') {
        // Still live, or cancelled, or halted. A halted instance keeps its sentence visible on the
        // week so the screen can say which relationship is missing.
        if (inst.state === 'halted' && inst.haltReason) {
          await db.execute(sql`
            UPDATE hr_credit_weeks SET halt_reason = ${inst.haltReason}::text, updated_at = NOW()
             WHERE id = ${String(w.id)}::uuid AND state = 'pending'`);
        }
        continue;
      }

      const decided = inst.steps
        .filter((s) => s.decision === 'approved' || s.decision === 'rejected')
        .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0];

      const state = inst.state === 'approved' ? 'approved' : 'refused';
      const note = decided?.note ? String(decided.note).slice(0, 500) : null;
      await db.execute(sql`
        UPDATE hr_credit_weeks
           SET state = ${state},
               decision_reason = COALESCE(${note}::text, decision_reason),
               decided_at = COALESCE(${decided?.decidedAt || null}::timestamptz, NOW()),
               decided_by_user_id = COALESCE(${decided?.decidedByUserId || null}::uuid, decided_by_user_id),
               decided_by_name = COALESCE(${decided?.approverName || null}::text, decided_by_name),
               updated_at = NOW()
         WHERE id = ${String(w.id)}::uuid AND state = 'pending'`);
      updated++;
    }
    return { ok: true, updated, error: null };
  } catch (e: any) {
    logFail('syncCreditDecisions', e);
    return { ok: false, updated: 0, error: errText(e, 'Settled decisions could not be applied to the credit record.') };
  }
}

/**
 * IS THIS WORKFLOW STEP A CREDIT DECISION?
 *
 * Asked by /portal/approvals so it can require a reason on APPROVE as well as on decline for this
 * one domain. Everywhere else in the product an approval needs no note; here it does, because the
 * approval IS the evidence. Fails closed to false — the generic rule is the safe one to fall back
 * to, and a missed prompt is a worse screen, not a wrong record.
 */
export async function stepIsCreditDecision(stepId: string): Promise<boolean> {
  if (!isUuid(stepId)) return false;
  try {
    const r = rows(await db.execute(sql`
      SELECT i.domain FROM workflow_steps s
        JOIN workflow_instances i ON i.id = s.instance_id
       WHERE s.id = ${stepId}::uuid LIMIT 1`))[0];
    return String(r?.domain || '') === CREDIT_DOMAIN;
  } catch (e: any) {
    logFail('stepIsCreditDecision', e);
    return false;
  }
}

/** The credit week a workflow record id points at, for a queue that wants to show the evidence. */
export async function creditWeekForRecord(recordId: string): Promise<CreditWeekRow | null> {
  return getCreditWeek(recordId);
}

/** Whether an instance already exists for a week — used by screens that offer "send for a decision". */
export async function creditWeekInstance(weekId: string) {
  return instanceForRecord(CREDIT_DOMAIN, String(weekId || ''));
}
