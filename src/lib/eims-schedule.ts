// src/lib/eims-schedule.ts — THE INTERN'S OWN WEEK: proposed by them, approved by a person, and
// owed back when leave takes a day out of it.
//
// =================================================================================================
// WHAT THIS FILE IS FOR, AND WHAT IT REFUSES TO BE
// =================================================================================================
//
// The internship system answers "what did the intern do", not "was the intern logged in". A plan for
// a week is therefore a STATEMENT OF INTENDED WORK — which activities, on which days, for how many
// hours — and not a shift, not a roster and not a timetable somebody else imposes. Interns are
// university students: any day of the week, any distribution, whatever fits around their classes.
//
// THREE RULES GOVERN EVERY WRITE IN HERE:
//
//   1. FORTY HOURS IS A CEILING, NEVER A TARGET TO BEAT. The weekly figure (from the employee's own
//      recorded terms, or otherwise from the published engagement policy) is the most a week may
//      COMMIT, Holistic Fitness included. Never 40 plus something. A proposal that would take a week
//      past its ceiling is refused with the arithmetic printed, at the moment it is proposed AND
//      again at the moment it is approved, because the week can fill up in between.
//
//   2. APPROVED LEAVE DOES NOT WAIVE THE HOURS. It takes the day out of the approved schedule and
//      leaves OUTSTANDING hours behind. The intern then proposes a MAKE-UP schedule for them, and
//      that make-up is itself subject to the ceiling of whatever week it lands in. There is no path
//      through this module by which outstanding hours are cleared by exceeding a ceiling.
//
//   3. AN APPROVED SCHEDULE IS HISTORY AND IS NEVER REWRITTEN. A change of plan is a NEW PROPOSAL
//      that supersedes the old one on approval; the old row keeps its own hours, its own approver and
//      its own timestamp. Editing an approved record in place would mean a manager approved one week
//      and an intern was measured against another, with nothing on any screen able to tell them apart.
//
// =================================================================================================
// ONE APPROVAL ENGINE. THERE IS NO SECOND ONE HERE.
// =================================================================================================
//
// Every decision on this table goes through src/lib/workflow.ts on the domain 'schedule': routed per
// row to the reporting manager from src/lib/org-graph.ts, never from users.role and never from a list
// in this file. Authority is re-derived at the write by workflow.mayAct(), so a posted schedule id
// from somebody with no claim on it is refused by the engine rather than by the absence of a button.
// Where the graph names nobody the instance HALTS carrying a readable sentence, which is stored on
// the schedule so the intern is told the truth rather than left reading "waiting" forever.
//
// A manager has three answers, and the third is the one this product was missing: approve, reject, or
// ASK FOR A MODIFICATION. The third is a decline in the engine (there is no fourth workflow decision
// and inventing one would fork the state machine) and a distinct state on the record, because
// "re-plan this and send it again" and "no" are different things to be told on a phone.
//
// =================================================================================================
// THE LEAVE ENGINE IS EXTENDED BY BEING READ, NOT BY BEING COPIED
// =================================================================================================
//
// src/lib/hr-leave.ts stays the only place leave is applied for, decided and charged. This module
// creates no leave table, no second leave status and no second approval path for leave. It READS
// approved requests and intersects them with the approved schedule, which is the only new fact:
// the hours that were planned for a day somebody is now absent from. Work-from-home is excluded by
// leaveType(...).kind, because working from elsewhere is not absence and owes nothing.
//
// Outstanding hours are DERIVED on read rather than stored as a balance. A stored balance is a second
// number that drifts the first time a leave request is cancelled or a schedule is superseded; the
// derivation cannot drift because it has nothing of its own to be wrong about.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Never r.rows[0]; every read goes through rows().
//   - The real Postgres reason is on e.cause; logged as e?.cause?.message || e?.message.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. Every writer returns why it did not write.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard with its own NEW key, additive,
//     CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, never a DROP.
//   - Every const is declared above the function that reads it. const is not hoisted.
//   - Evidence and documents are links, never uploads. Nothing here accepts a file.
//   - No surveillance of any kind: this module stores a PLAN and a DECISION. It does not know, ask or
//     store where anybody was, what was on their screen, or whether a session was open.
//
// EduRankAI is the technology platform. Nothing recorded here awards a credential; accredited
// partners do that.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  isoDate, parseIso, weekStartOf, weekEndOf, weekLabel, requiredWeeklyHours,
} from '@/lib/credit-week';
import { STATUTORY } from '@/lib/engagement-policy';
import { leaveType, ensureLeaveSchema } from '@/lib/hr-leave';
import { startWorkflow, getInstance, decideStep, cancelWorkflow, instanceForRecord } from '@/lib/workflow';
import { textIn } from '@/lib/pg-array';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND PURE HELPERS — every one declared ABOVE the functions that read them.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never a { rows } object. r.rows[0] is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-schedule] ' + tag, e?.cause?.message || e?.message);

const errText = (e: any, fallback: string): string =>
  String(e?.cause?.message || e?.message || fallback).slice(0, 300);

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED =
  'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found/not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That schedule is not available.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const DAY_MS = 86400000;

/**
 * THE DOMAIN. Declared once so no caller can invent a second, and matching the member added to
 * WORKFLOW_DOMAINS in src/lib/workflow.ts.
 */
const SCHEDULE_DOMAIN = 'schedule' as const;

/** Where a person's own schedules live, for anything that needs to send them back. */
export const SCHEDULE_PORTAL_URL = '/portal/employee/schedule';
export const SCHEDULE_APPROVALS_URL = '/portal/employee/schedule/approvals';

/**
 * A REGULAR schedule is the plan for an ordinary week. A MAKE-UP schedule pays back hours that
 * approved leave left outstanding — the same shape, a different reason, and one extra rule (it may
 * never exceed what is actually owed).
 */
export const SCHEDULE_KINDS = ['regular', 'makeup'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
const KIND_SET = new Set<string>(SCHEDULE_KINDS);
export function isScheduleKind(v: unknown): v is ScheduleKind {
  return typeof v === 'string' && KIND_SET.has(v);
}

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  regular: 'Weekly schedule',
  makeup: 'Make-up schedule',
};

/**
 * THE STATES A ROW CAN BE IN, and each one is a different thing to tell somebody:
 *
 *   proposed           sent, waiting on the reporting manager. Nothing is official yet.
 *   approved           THE official schedule for that week. Frozen; a change supersedes it.
 *   changes-requested  the manager wants it re-planned. Not a refusal, and the intern acts next.
 *   rejected           refused, with a reason. Nothing is owed and nothing is official.
 *   withdrawn          the intern took it back before it was decided.
 *   superseded         a later proposal was approved in its place. Kept, never rewritten.
 *
 * "Not yet proposed" is deliberately NOT a state: it is the ABSENCE of a row, and a screen must say
 * so in those words rather than inventing a draft nobody made. "Could not be read" is likewise not a
 * state — it is a failed read, reported by the reader, never rendered as an empty week.
 */
export const SCHEDULE_STATES = [
  'proposed', 'approved', 'changes-requested', 'rejected', 'withdrawn', 'superseded',
] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];
const STATE_SET = new Set<string>(SCHEDULE_STATES);
export function isScheduleState(v: unknown): v is ScheduleState {
  return typeof v === 'string' && STATE_SET.has(v);
}

export const SCHEDULE_STATE_LABELS: Record<ScheduleState, string> = {
  proposed: 'Awaiting approval',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Replaced by a later plan',
};

/** Colours for a state chip, kept here so two screens cannot disagree about what approved looks like. */
export function scheduleStateTone(state: string): { bg: string; fg: string; bd: string } {
  if (state === 'approved') return { bg: '#F1F8F3', fg: '#1F5132', bd: '#CBE3D2' };
  if (state === 'proposed') return { bg: '#FBF7F1', fg: '#6D470D', bd: '#EADECD' };
  if (state === 'changes-requested') return { bg: '#FBF7F1', fg: '#6D470D', bd: '#EADECD' };
  if (state === 'rejected') return { bg: '#FDF3F2', fg: '#8A2C21', bd: '#EFCFCB' };
  return { bg: '#F4F3F1', fg: '#564E43', bd: '#DFDCD8' };
}

export function scheduleStateLabel(state: string): string {
  return isScheduleState(state) ? SCHEDULE_STATE_LABELS[state] : String(state || 'Unknown');
}

/** A decided row is never re-decided and never rewritten. */
const DECIDED_STATES = new Set<string>(['approved', 'changes-requested', 'rejected', 'superseded', 'withdrawn']);
export function isScheduleDecided(state: string): boolean {
  return DECIDED_STATES.has(String(state || ''));
}

/** The most hours one day of a proposal may carry. The statutory daily ceiling, not a target. */
const MAX_DAY_HOURS = STATUTORY.maxHoursPerDay;

/** No week may ever commit more than the statute allows, whatever an engagement policy says. */
const MAX_WEEK_HOURS = STATUTORY.maxHoursPerWeek;

/** Below this an entry is noise rather than a plan. */
const MIN_ENTRY_HOURS = 0.25;

/** A week has seven days; three activities a day is generous and a typo cannot write a thousand rows. */
const MAX_ENTRIES = 21;

const ACTIVITY_MAX = 160;
const NOTE_MAX = 500;
const REASON_MAX = 500;

/** A decline or a request for changes has to say something. Approving as proposed does not. */
export const MIN_DECISION_REASON = 8;

/**
 * Floating point slack when comparing an hours total against a ceiling. 0.6 + 0.3 is not 0.9 in
 * IEEE754, and refusing a schedule for a hundredth of an hour is a bug that reads as spite.
 */
const HOURS_SLACK = 0.011;

/** Schedules read in one call. A long engagement pages rather than widening this. */
const MAX_SCHEDULES = 80;

/** Approved leave requests read in one outstanding-hours pass. */
const MAX_LEAVE_ROWS = 200;

/** A single leave request may not be walked further than this. A typo must not spin a loop. */
const MAX_LEAVE_SPAN_DAYS = 400;

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

/** Every ISO date from a to b inclusive, bounded. */
function datesBetween(fromIso: string, toIso: string, cap = MAX_LEAVE_SPAN_DAYS): string[] {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (!a || !b || b.getTime() < a.getTime()) return [];
  const out: string[] = [];
  for (let t = a.getTime(); t <= b.getTime() && out.length < cap; t += DAY_MS) {
    out.push(isoDate(new Date(t)));
  }
  return out;
}

/** '6.5 hours', '1 hour', 'not recorded'. No arrow characters anywhere — they break .astro strings. */
export function hoursText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'not recorded';
  const v = round2(Number(n));
  return v === 1 ? '1 hour' : v + ' hours';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — its own NEW ensureOnce key.
//
// A spent key never runs again in a process that has already booted, so anything added to this
// module later must take a NEW key ('eims_schedule_v2') or the column will never appear on an
// environment that has already run this one. That has cost this project a whole feature before.
// -------------------------------------------------------------------------------------------------

export function ensureScheduleSchema(): Promise<void> {
  return ensureOnce('eims_schedule_v1', async () => {
    try {
      await createScheduleTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run so the next call retries, and swallows
      // the rejection for callers, which keeps the tolerate-missing-schema behaviour readers rely on.
      logFail('ensureScheduleSchema', e);
      throw e;
    }
  });
}

async function createScheduleTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    kind TEXT NOT NULL DEFAULT 'regular',
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    state TEXT NOT NULL DEFAULT 'proposed',
    version INT NOT NULL DEFAULT 1,
    total_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
    ceiling_hours NUMERIC(6,2),
    ceiling_basis TEXT,
    note TEXT,
    supersedes_id UUID,
    superseded_by_id UUID,
    proposed_by_user_id UUID,
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    workflow_instance_id UUID,
    halt_reason TEXT,
    decided_by_user_id UUID,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    ceiling_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_schedule_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL,
    day_date DATE NOT NULL,
    activity TEXT NOT NULL,
    hours NUMERIC(5,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Additive assertions, so a table created by an earlier version of this file completes rather than
  // being dropped and rebuilt. ADD COLUMN IF NOT EXISTS is a no-op where the column is there.
  for (const stmt of [
    "ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS ceiling_basis TEXT",
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS supersedes_id UUID',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS superseded_by_id UUID',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS workflow_instance_id UUID',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS halt_reason TEXT',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS decision_reason TEXT',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS decided_by_name TEXT',
    'ALTER TABLE eims_schedules ADD COLUMN IF NOT EXISTS ceiling_note TEXT',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_schedules_emp_week
    ON eims_schedules (employee_id, week_start DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_schedule_days_sched
    ON eims_schedule_days (schedule_id, day_date)`);

  // ONE OFFICIAL WEEKLY PLAN, AND ONE LIVE PROPOSAL AT A TIME.
  //
  // Both are PARTIAL unique indexes and both are scoped to kind 'regular'. A make-up schedule is
  // deliberately outside them: outstanding hours can be paid back in several instalments landing in
  // the same week, and forcing them into one row would mean the second make-up silently replaced the
  // first. The ceiling check is what keeps several make-ups honest, not a unique index.
  //
  // Each carries its own try/catch: a unique index is the one piece of DDL here that can fail on DATA
  // rather than on syntax, and losing it must not take the tables with it. Where it is absent the
  // writers still read-then-write correctly; what is lost is only protection against a simultaneous
  // double write, which is a documented weaker guarantee rather than an outage.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_schedules_one_official
      ON eims_schedules (employee_id, week_start)
      WHERE kind = 'regular' AND state = 'approved' AND superseded_by_id IS NULL`);
  } catch (e: any) {
    logFail('eims_schedules_one_official', e);
  }
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_schedules_one_live
      ON eims_schedules (employee_id, week_start)
      WHERE kind = 'regular' AND state = 'proposed'`);
  } catch (e: any) {
    logFail('eims_schedules_one_live', e);
  }
}

// -------------------------------------------------------------------------------------------------
// THE RECORD, AS CALLERS SEE IT
// -------------------------------------------------------------------------------------------------

export interface ScheduleDay {
  id: string;
  date: string;
  activity: string;
  hours: number;
}

export interface ScheduleRow {
  id: string;
  employeeId: string;
  kind: string;
  kindLabel: string;
  weekStart: string;
  weekEnd: string;
  label: string;
  state: string;
  stateLabel: string;
  version: number;
  totalHours: number;
  ceilingHours: number | null;
  ceilingBasis: string | null;
  note: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  proposedAt: string | null;
  workflowInstanceId: string | null;
  /** Set when routing could not name an approver. Rendered verbatim, never hidden. */
  haltReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  /** Set only when an approval taken elsewhere left the week over its ceiling. */
  ceilingNote: string | null;
  days: ScheduleDay[];
  /** True when this row IS the official plan for its week right now. */
  official: boolean;
}

function mapSchedule(r: any, days: ScheduleDay[]): ScheduleRow {
  const ws = iso(r.week_start);
  const state = String(r.state || 'proposed');
  const kind = String(r.kind || 'regular');
  return {
    id: String(r.id),
    employeeId: String(r.employee_id || ''),
    kind,
    kindLabel: isScheduleKind(kind) ? SCHEDULE_KIND_LABELS[kind] : 'Schedule',
    weekStart: ws,
    weekEnd: iso(r.week_end),
    label: weekLabel(ws),
    state,
    stateLabel: scheduleStateLabel(state),
    version: Number(r.version ?? 1) || 1,
    totalHours: Number(r.total_hours ?? 0),
    ceilingHours: r.ceiling_hours == null ? null : Number(r.ceiling_hours),
    ceilingBasis: r.ceiling_basis ? String(r.ceiling_basis) : null,
    note: r.note ? String(r.note) : null,
    supersedesId: r.supersedes_id ? String(r.supersedes_id) : null,
    supersededById: r.superseded_by_id ? String(r.superseded_by_id) : null,
    proposedAt: r.proposed_at ? new Date(r.proposed_at).toISOString() : null,
    workflowInstanceId: r.workflow_instance_id ? String(r.workflow_instance_id) : null,
    haltReason: r.halt_reason ? String(r.halt_reason) : null,
    decidedByName: r.decided_by_name ? String(r.decided_by_name) : null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionReason: r.decision_reason ? String(r.decision_reason) : null,
    ceilingNote: r.ceiling_note ? String(r.ceiling_note) : null,
    days,
    official: state === 'approved' && !r.superseded_by_id,
  };
}

async function daysFor(scheduleIds: string[]): Promise<Map<string, ScheduleDay[]>> {
  const out = new Map<string, ScheduleDay[]>();
  if (!scheduleIds.length) return out;
  const list = scheduleIds.filter(isUuid);
  if (!list.length) return out;
  const dr = rows(await db.execute(sql`
    SELECT id::text AS id, schedule_id::text AS schedule_id, day_date, activity, hours
      FROM eims_schedule_days
     WHERE schedule_id::text IN ${textIn(list)}
     ORDER BY day_date ASC, activity ASC`));
  for (const d of dr) {
    const key = String(d.schedule_id);
    const arr = out.get(key) || [];
    arr.push({
      id: String(d.id),
      date: iso(d.day_date),
      activity: String(d.activity || ''),
      hours: Number(d.hours ?? 0),
    });
    out.set(key, arr);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE CEILING — read from the same place the credit week reads its requirement, so the two cannot
// drift into disagreeing about what a person's week is.
// -------------------------------------------------------------------------------------------------

export interface CeilingRead {
  ok: boolean;
  /** Null when the read failed. A sentence for a person. */
  error: string | null;
  /** False when this engagement is not measured in hours at all. */
  applicable: boolean;
  /** The most a week may commit, or null when the terms have never been recorded. NEVER a default. */
  hours: number | null;
  /** Where the figure came from, verbatim, so a screen can show its own arithmetic. */
  basis: string;
  fullName: string;
}

/**
 * WHAT THIS PERSON'S WEEK MAY COMMIT.
 *
 * Three answers, and they are three different sentences on a screen:
 *   applicable false  this engagement is not measured in hours; there is nothing to schedule against.
 *   hours null        nobody has recorded the terms. NOT forty. An unrecorded contract silently
 *                     meaning forty hours is exactly the defect this product already paid for once.
 *   hours n           the ceiling, capped by the statutory weekly maximum whatever a policy says.
 */
export async function ceilingFor(employeeId: string): Promise<CeilingRead> {
  const miss: CeilingRead = {
    ok: false, error: null, applicable: false, hours: null,
    basis: '', fullName: 'This person',
  };
  if (!isUuid(employeeId)) {
    return { ...miss, error: 'That employee record could not be read.' };
  }

  let r: any = null;
  try {
    r = rows(await db.execute(sql`
      SELECT e.full_name, e.designation, e.employment_type, e.weekly_hours
        FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
  } catch (e: any) {
    // weekly_hours only exists once engagement terms have been saved on this database. An unrecorded
    // contract must degrade to "unknown", never to a failed read.
    logFail('ceilingFor weekly_hours', e);
    try {
      r = rows(await db.execute(sql`
        SELECT e.full_name, e.designation, e.employment_type, NULL AS weekly_hours
          FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
    } catch (e2: any) {
      logFail('ceilingFor', e2);
      return { ...miss, error: errText(e2, 'Your engagement terms could not be read just now.') };
    }
  }

  if (!r) return { ...miss, ok: true, basis: 'No employee record was found for this person.' };

  const weekly = r.weekly_hours == null ? null : Number(r.weekly_hours);
  const req = requiredWeeklyHours({
    employmentType: r.employment_type,
    designation: r.designation,
    recordedWeeklyHours: Number.isFinite(weekly as number) ? weekly : null,
  });

  const capped = req.hours == null ? null : Math.min(req.hours, MAX_WEEK_HOURS);
  const basis = req.hours != null && capped !== req.hours
    ? req.basis + ' Capped at the statutory weekly maximum of ' + MAX_WEEK_HOURS + ' hours.'
    : req.basis;

  return {
    ok: true,
    error: null,
    applicable: req.applicable,
    hours: capped,
    basis,
    fullName: String(r.full_name || 'This person'),
  };
}

// -------------------------------------------------------------------------------------------------
// WHAT A WEEK HAS ALREADY COMMITTED
// -------------------------------------------------------------------------------------------------

export interface CapacityRead {
  ok: boolean;
  error: string | null;
  applicable: boolean;
  weekStart: string;
  weekEnd: string;
  label: string;
  ceilingHours: number | null;
  ceilingBasis: string;
  /** Hours already APPROVED into this week, regular plus make-up. */
  committedHours: number;
  /** Hours proposed into this week and not yet decided. Shown, never counted as committed. */
  awaitingHours: number;
  /** Ceiling minus committed, or null when the ceiling is unknown. */
  remainingHours: number | null;
}

const EMPTY_CAPACITY: CapacityRead = {
  ok: false, error: null, applicable: false, weekStart: '', weekEnd: '', label: '',
  ceilingHours: null, ceilingBasis: '', committedHours: 0, awaitingHours: 0, remainingHours: null,
};

/**
 * HOW MUCH ROOM IS LEFT IN A WEEK.
 *
 * `replacingOfficialRegular` is what makes a CHANGE of plan possible at all: a new weekly proposal
 * supersedes the official one for that week, so the hours it is replacing must not be counted against
 * it — otherwise proposing 38 hours in place of 38 hours would read as 76 and be refused.
 */
export async function capacityForWeek(
  employeeId: string,
  weekStartIso: string,
  opts: { replacingOfficialRegular?: boolean; excludeScheduleId?: string | null } = {},
): Promise<CapacityRead> {
  const ws = weekStartOf(String(weekStartIso || ''));
  if (!isUuid(employeeId) || !ws) {
    return { ...EMPTY_CAPACITY, error: 'That week could not be read.' };
  }
  const we = weekEndOf(ws);

  const ceiling = await ceilingFor(employeeId);
  if (!ceiling.ok) {
    return { ...EMPTY_CAPACITY, weekStart: ws, weekEnd: we, label: weekLabel(ws), error: ceiling.error };
  }

  try {
    await ensureScheduleSchema();
    const exclude = isUuid(opts.excludeScheduleId) ? String(opts.excludeScheduleId) : null;
    const list = rows(await db.execute(sql`
      SELECT id::text AS id, kind, state, total_hours, superseded_by_id
        FROM eims_schedules
       WHERE employee_id = ${employeeId}::uuid
         AND week_start = ${ws}::date
         AND state IN ('approved', 'proposed')`));

    let committed = 0;
    let awaiting = 0;
    for (const s of list) {
      if (exclude && String(s.id) === exclude) continue;
      const hours = Number(s.total_hours ?? 0) || 0;
      const state = String(s.state || '');
      if (state === 'approved' && !s.superseded_by_id) {
        // The plan being replaced is not extra work; it is the same work re-planned.
        if (opts.replacingOfficialRegular && String(s.kind || '') === 'regular') continue;
        committed += hours;
      } else if (state === 'proposed') {
        awaiting += hours;
      }
    }

    committed = round2(committed);
    awaiting = round2(awaiting);
    return {
      ok: true,
      error: null,
      applicable: ceiling.applicable,
      weekStart: ws,
      weekEnd: we,
      label: weekLabel(ws),
      ceilingHours: ceiling.hours,
      ceilingBasis: ceiling.basis,
      committedHours: committed,
      awaitingHours: awaiting,
      remainingHours: ceiling.hours == null ? null : round2(Math.max(0, ceiling.hours - committed)),
    };
  } catch (e: any) {
    logFail('capacityForWeek', e);
    return {
      ...EMPTY_CAPACITY,
      weekStart: ws, weekEnd: we, label: weekLabel(ws),
      error: errText(e, 'The hours already planned for that week could not be read.'),
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE PROPOSAL — validated as pure data first, so a screen and the writer refuse the same things.
// -------------------------------------------------------------------------------------------------

export interface ScheduleEntryInput {
  date: string;
  activity: string;
  hours: number | string;
}

export interface ValidatedEntries {
  ok: boolean;
  /** A sentence for a person. Null when ok. */
  error: string | null;
  entries: { date: string; activity: string; hours: number }[];
  totalHours: number;
  /** Days used, in order, for a summary line. */
  dates: string[];
}

/**
 * PURE. No database, no clock, no user — the same input always gives the same answer, which is what
 * makes it safe for a page to call before posting and for the writer to call again at the write.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE:
 *   - a day outside the week being planned. Otherwise a form typo silently plans somebody else's week.
 *   - an empty activity. The whole premise is what the intern DID, so an hour with no named activity
 *     is exactly the attendance-shaped number this system exists to stop recording.
 *   - a day past the statutory daily maximum. A week under its ceiling can still be an unlawful day.
 *   - a week past the statutory weekly maximum, before any engagement ceiling is even consulted.
 */
export function validateEntries(weekStartIso: string, raw: ScheduleEntryInput[]): ValidatedEntries {
  const fail = (error: string): ValidatedEntries => ({ ok: false, error, entries: [], totalHours: 0, dates: [] });

  const ws = weekStartOf(String(weekStartIso || ''));
  if (!ws) return fail('That week could not be read. Pick the week you are planning and try again.');
  const we = weekEndOf(ws);

  const list = Array.isArray(raw) ? raw : [];
  const entries: { date: string; activity: string; hours: number }[] = [];
  const perDay = new Map<string, number>();

  for (const item of list) {
    const date = String(item?.date || '').slice(0, 10);
    const activity = String(item?.activity || '').trim().slice(0, ACTIVITY_MAX);
    const hoursRaw = Number(item?.hours);

    // A blank row is how a seven-day form says "nothing on this day". It is skipped, not refused.
    if (!date && !activity && (!Number.isFinite(hoursRaw) || hoursRaw === 0)) continue;
    if (!Number.isFinite(hoursRaw) || hoursRaw === 0) {
      if (!activity) continue;
      return fail('Every activity needs hours against it. ' + (date ? date + ': ' : '')
        + '"' + activity + '" has none.');
    }
    if (!parseIso(date)) return fail('One of the days could not be read as a date.');
    if (date < ws || date > we) {
      return fail('The day ' + date + ' is outside the week you are planning ('
        + weekLabel(ws) + '). Plan that day in its own week.');
    }
    if (!activity) {
      return fail('Say what you will be doing on ' + date + '. Hours with no activity against them '
        + 'are the kind of number this system does not record.');
    }
    const hours = round2(hoursRaw);
    if (hours < MIN_ENTRY_HOURS) {
      return fail('The shortest activity that can be planned is ' + MIN_ENTRY_HOURS
        + ' of an hour. ' + date + ' has ' + hours + '.');
    }
    if (hours > MAX_DAY_HOURS) {
      return fail('No single activity may be longer than the statutory ' + MAX_DAY_HOURS
        + ' hours a day. ' + date + ' has ' + hours + '.');
    }
    entries.push({ date, activity, hours });
    perDay.set(date, round2((perDay.get(date) || 0) + hours));
    if (entries.length > MAX_ENTRIES) {
      return fail('That is more than ' + MAX_ENTRIES + ' activities in one week. Group them, or plan '
        + 'the rest in another week.');
    }
  }

  if (!entries.length) {
    return fail('Add at least one activity with hours against it. An empty week is not a plan, and '
      + 'nothing is sent to your manager until there is something in it.');
  }

  for (const [date, sum] of perDay) {
    if (sum > MAX_DAY_HOURS + HOURS_SLACK) {
      return fail(date + ' adds up to ' + hoursText(sum) + ', which is past the statutory maximum of '
        + MAX_DAY_HOURS + ' hours in one day. Move some of it to another day.');
    }
  }

  const totalHours = round2(entries.reduce((a, b) => a + b.hours, 0));
  if (totalHours > MAX_WEEK_HOURS + HOURS_SLACK) {
    return fail('That week adds up to ' + hoursText(totalHours) + ', which is past the statutory '
      + 'maximum of ' + MAX_WEEK_HOURS + ' hours a week.');
  }

  const dates = Array.from(perDay.keys()).sort();
  return { ok: true, error: null, entries, totalHours, dates };
}

export interface ProposeInput {
  employeeId: string;
  /** users.id of whoever is proposing. The intern themselves, in every surface built here. */
  userId?: string | null;
  weekStart: string;
  kind?: ScheduleKind;
  entries: ScheduleEntryInput[];
  note?: string | null;
}

export interface ProposeResult {
  ok: boolean;
  error: string | null;
  scheduleId?: string;
  state?: ScheduleState;
  /** The engine's sentence when routing could not name an approver. Shown verbatim. */
  haltReason?: string | null;
  /** True, and non-fatal: the proposal is stored and routed but something beside it needs saying. */
  warning?: string | null;
}

/**
 * AN INTERN PROPOSES A WEEK.
 *
 * The order of the checks is the design: everything that can refuse WITHOUT writing runs first, so a
 * refused proposal leaves no row, no workflow instance and nothing on anybody's queue.
 *
 *   1. the entries are a readable plan at all (pure, above);
 *   2. this engagement is measured in hours, and its ceiling is KNOWN — an unrecorded contract is
 *      refused with the sentence that names who fixes it, never quietly treated as forty;
 *   3. the week can still take these hours, counting what is already approved into it;
 *   4. a make-up may not exceed what is actually outstanding, because paying back more than is owed
 *      is hour inflation wearing a different hat.
 *
 * Only then is the row written, and only then is it routed. A CHANGE OF PLAN IS A NEW PROPOSAL: the
 * approved row it will replace is recorded in supersedes_id and is not touched until this one is
 * approved.
 */
export async function proposeSchedule(input: ProposeInput): Promise<ProposeResult> {
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That employee record could not be read.' };

  const userId = isUuid(input?.userId) ? String(input.userId) : null;
  const kind: ScheduleKind = isScheduleKind(input?.kind) ? input.kind : 'regular';
  const note = input?.note ? String(input.note).trim().slice(0, NOTE_MAX) : null;

  const ws = weekStartOf(String(input?.weekStart || ''));
  if (!ws) return { ok: false, error: 'That week could not be read.' };
  const we = weekEndOf(ws);

  const valid = validateEntries(ws, input?.entries || []);
  if (!valid.ok) return { ok: false, error: valid.error };

  const ceiling = await ceilingFor(employeeId);
  if (!ceiling.ok) {
    return { ok: false, error: ceiling.error || 'Your engagement terms could not be read just now. '
      + 'Nothing was saved, and nothing you have already planned is lost.' };
  }
  if (!ceiling.applicable) {
    return { ok: false, error: 'Weekly schedules are proposed on engagements where hours are the '
      + 'certified deliverable. ' + ceiling.basis };
  }
  if (ceiling.hours == null) {
    // NOT FORTY. An unset contract silently meaning forty hours is a defect this product has already
    // paid for once, and it is refused here in the words of whoever can fix it.
    return { ok: false, error: 'No weekly hours are recorded on your engagement, so there is no '
      + 'ceiling to check this plan against and it cannot be sent for approval. Ask HR to record your '
      + 'weekly hours on your employee record, then propose the week again. Nothing you enter here is '
      + 'lost by that.' };
  }

  const capacity = await capacityForWeek(employeeId, ws, { replacingOfficialRegular: kind === 'regular' });
  if (!capacity.ok) {
    return { ok: false, error: capacity.error || 'The hours already planned for that week could not '
      + 'be read, so this cannot be checked against the ceiling. Nothing was saved.' };
  }
  const wouldTotal = round2(capacity.committedHours + valid.totalHours);
  if (wouldTotal > ceiling.hours + HOURS_SLACK) {
    return {
      ok: false,
      error: 'That would take the week of ' + weekLabel(ws) + ' to ' + hoursText(wouldTotal)
        + ', past the ' + hoursText(ceiling.hours) + ' ceiling. '
        + (capacity.committedHours > 0
          ? hoursText(capacity.committedHours) + ' are already approved into that week, so there '
            + (capacity.remainingHours === 1 ? 'is ' : 'are ') + hoursText(capacity.remainingHours) + ' left.'
          : 'The ceiling covers everything recognised, well-being included. It is not forty plus anything.'),
    };
  }

  // A MAKE-UP MAY NOT EXCEED WHAT IS OWED. Otherwise outstanding hours become a licence to plan extra
  // recognised work, which is the hour inflation the whole ceiling exists to prevent.
  let outstandingWarning: string | null = null;
  if (kind === 'makeup') {
    const owed = await outstandingHours(employeeId);
    if (!owed.ok) {
      return { ok: false, error: owed.error || 'What you are owed could not be worked out just now, '
        + 'so a make-up cannot be checked against it. Nothing was saved.' };
    }
    if (owed.remainingHours <= 0) {
      return { ok: false, error: 'Nothing is outstanding at the moment, so there is nothing for a '
        + 'make-up schedule to pay back. An ordinary weekly schedule is what you want here.' };
    }
    if (valid.totalHours > owed.remainingHours + HOURS_SLACK) {
      return { ok: false, error: 'You are proposing ' + hoursText(valid.totalHours)
        + ' of make-up against ' + hoursText(owed.remainingHours) + ' outstanding. A make-up pays back '
        + 'what leave left owed; it does not add hours beyond it.' };
    }
    if (owed.awaitingHours > 0) {
      outstandingWarning = hoursText(owed.awaitingHours) + ' of make-up are already waiting for a '
        + 'decision. Until those are decided, both proposals count against the same outstanding hours.';
    }
  }

  try {
    await ensureScheduleSchema();

    // The row this one would replace, recorded now so the record can say what it changed. Reading it
    // does not touch it: it stays official until this proposal is actually approved.
    let supersedesId: string | null = null;
    let version = 1;
    if (kind === 'regular') {
      const prev = rows(await db.execute(sql`
        SELECT id::text AS id, version FROM eims_schedules
         WHERE employee_id = ${employeeId}::uuid AND week_start = ${ws}::date
           AND kind = 'regular' AND state = 'approved' AND superseded_by_id IS NULL
         LIMIT 1`))[0];
      if (prev) {
        supersedesId = String(prev.id);
        version = (Number(prev.version) || 1) + 1;
      }

      const live = rows(await db.execute(sql`
        SELECT id::text AS id FROM eims_schedules
         WHERE employee_id = ${employeeId}::uuid AND week_start = ${ws}::date
           AND kind = 'regular' AND state = 'proposed' LIMIT 1`))[0];
      if (live) {
        return { ok: false, error: 'A plan for ' + weekLabel(ws) + ' is already waiting for a decision. '
          + 'Withdraw that one first if this replaces it, or wait for your manager to answer it.' };
      }
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO eims_schedules
        (employee_id, kind, week_start, week_end, state, version, total_hours, ceiling_hours,
         ceiling_basis, note, supersedes_id, proposed_by_user_id)
      VALUES
        (${employeeId}::uuid, ${kind}, ${ws}::date, ${we}::date, 'proposed', ${version},
         ${valid.totalHours}::numeric, ${ceiling.hours}::numeric, ${ceiling.basis}::text,
         ${note}::text, ${supersedesId}::uuid, ${userId}::uuid)
      RETURNING id::text AS id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const scheduleId = String(ins[0].id);

    for (const e of valid.entries) {
      await db.execute(sql`
        INSERT INTO eims_schedule_days (schedule_id, day_date, activity, hours)
        VALUES (${scheduleId}::uuid, ${e.date}::date, ${e.activity}::text, ${e.hours}::numeric)`);
    }

    // THE ONE APPROVAL ENGINE. Routed per row to the reporting manager from the Organization Graph.
    const summary = (kind === 'makeup' ? 'Make-up schedule for ' : 'Weekly schedule for ')
      + weekLabel(ws) + ': ' + hoursText(valid.totalHours) + ' across ' + valid.dates.length
      + ' day(s), against a ' + hoursText(ceiling.hours) + ' ceiling.';

    const res = await startWorkflow({
      domain: SCHEDULE_DOMAIN,
      recordId: scheduleId,
      subjectEmployeeId: employeeId,
      requestedByUserId: userId,
      createdByUserId: userId,
      summary,
    });

    if (!res.ok) {
      // The row exists and the person can see it; it simply has not reached anybody yet. Said plainly
      // rather than swallowed, and re-sending is one button on the schedule screen.
      await db.execute(sql`
        UPDATE eims_schedules
           SET halt_reason = ${'This plan is saved but has not reached an approver yet.'}::text,
               updated_at = NOW()
         WHERE id = ${scheduleId}::uuid AND state = 'proposed'`);
      return {
        ok: true, error: null, scheduleId, state: 'proposed',
        warning: (res.error || 'This plan could not be sent for approval just now.')
          + ' It is saved and nothing is lost. Send it again from your schedule screen.',
      };
    }

    await db.execute(sql`
      UPDATE eims_schedules
         SET workflow_instance_id = ${res.instanceId || null}::uuid,
             halt_reason = ${res.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${scheduleId}::uuid AND state = 'proposed'`);

    await logAudit({
      userId,
      action: 'eims.schedule.propose',
      entity: 'eims_schedules',
      entityId: scheduleId,
      diff: {
        employeeId, kind, weekStart: ws, totalHours: valid.totalHours,
        ceilingHours: ceiling.hours, supersedesId, state: res.state || 'pending',
      },
    });

    return {
      ok: true,
      error: null,
      scheduleId,
      state: 'proposed',
      haltReason: res.haltReason || null,
      warning: outstandingWarning,
    };
  } catch (e: any) {
    // A WRITE PATH NEVER SWALLOWS. The real Postgres reason goes to the log; the person is told
    // plainly that nothing was recorded.
    logFail('proposeSchedule', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface SchedulesRead {
  ok: boolean;
  error: string | null;
  schedules: ScheduleRow[];
}

export async function listSchedules(employeeId: string, limit = MAX_SCHEDULES): Promise<SchedulesRead> {
  if (!isUuid(employeeId)) return { ok: false, error: NOT_AVAILABLE, schedules: [] };
  const n = Math.min(Math.max(Number(limit) || MAX_SCHEDULES, 1), MAX_SCHEDULES);
  try {
    await ensureScheduleSchema();
    const list = rows(await db.execute(sql`
      SELECT * FROM eims_schedules
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY week_start DESC, created_at DESC
       LIMIT ${n}`));
    const days = await daysFor(list.map((r: any) => String(r.id)));
    return {
      ok: true,
      error: null,
      schedules: list.map((r: any) => mapSchedule(r, days.get(String(r.id)) || [])),
    };
  } catch (e: any) {
    logFail('listSchedules', e);
    return {
      ok: false,
      error: errText(e, 'Your schedules could not be read just now. Nothing you have proposed is lost.'),
      schedules: [],
    };
  }
}

export async function getSchedule(scheduleId: string): Promise<ScheduleRow | null> {
  if (!isUuid(scheduleId)) return null;
  try {
    await ensureScheduleSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM eims_schedules WHERE id = ${scheduleId}::uuid LIMIT 1`))[0];
    if (!r) return null;
    const days = await daysFor([String(r.id)]);
    return mapSchedule(r, days.get(String(r.id)) || []);
  } catch (e: any) {
    logFail('getSchedule', e);
    return null;
  }
}

/** The schedule a workflow record id points at, for a queue that must not ask anybody to decide blind. */
export async function scheduleForRecord(recordId: string): Promise<ScheduleRow | null> {
  return getSchedule(String(recordId || ''));
}

/** Whether an instance already exists for a schedule — for a screen offering "send it again". */
export async function scheduleInstance(scheduleId: string) {
  return instanceForRecord(SCHEDULE_DOMAIN, String(scheduleId || ''));
}

export interface WeekPlanRead {
  ok: boolean;
  error: string | null;
  weekStart: string;
  label: string;
  /** The approved weekly plan for this week, or null when there is none. */
  official: ScheduleRow | null;
  /** Approved make-ups landing in this week. */
  makeups: ScheduleRow[];
  /** Anything proposed for this week and not yet decided. */
  awaiting: ScheduleRow[];
}

/**
 * THE OFFICIAL PLAN FOR ONE WEEK, and everything else attached to it.
 *
 * A null `official` with an empty `awaiting` means NOT YET PROPOSED — a real, nameable state, and one
 * a screen must say in those words rather than drawing an empty table that looks like a zero-hour week.
 */
export async function weekPlan(employeeId: string, weekStartIso: string): Promise<WeekPlanRead> {
  const ws = weekStartOf(String(weekStartIso || ''));
  const empty: WeekPlanRead = {
    ok: false, error: null, weekStart: ws, label: ws ? weekLabel(ws) : '',
    official: null, makeups: [], awaiting: [],
  };
  if (!isUuid(employeeId) || !ws) return { ...empty, error: 'That week could not be read.' };

  try {
    await ensureScheduleSchema();
    const list = rows(await db.execute(sql`
      SELECT * FROM eims_schedules
       WHERE employee_id = ${employeeId}::uuid AND week_start = ${ws}::date
         AND state IN ('approved', 'proposed')
       ORDER BY created_at ASC`));
    const days = await daysFor(list.map((r: any) => String(r.id)));
    const mapped = list.map((r: any) => mapSchedule(r, days.get(String(r.id)) || []));
    return {
      ok: true,
      error: null,
      weekStart: ws,
      label: weekLabel(ws),
      official: mapped.find((s) => s.official && s.kind === 'regular') || null,
      makeups: mapped.filter((s) => s.official && s.kind === 'makeup'),
      awaiting: mapped.filter((s) => s.state === 'proposed'),
    };
  } catch (e: any) {
    logFail('weekPlan', e);
    return { ...empty, error: errText(e, 'That week could not be read just now.') };
  }
}

// -------------------------------------------------------------------------------------------------
// OUTSTANDING HOURS — what approved leave took out of an approved plan.
// -------------------------------------------------------------------------------------------------

export interface OutstandingItem {
  date: string;
  weekStart: string;
  leaveRequestId: string;
  leaveType: string;
  /** 1 for a whole day, 0.5 for a half day; hourly leave carries its hours instead. */
  fraction: number;
  scheduledHours: number;
  outstandingHours: number;
  activities: string[];
}

export interface OutstandingRead {
  ok: boolean;
  error: string | null;
  /** Everything approved leave has taken out of an approved plan, ever. */
  grossHours: number;
  /** Hours already covered by APPROVED make-up schedules. */
  madeUpHours: number;
  /** Make-up hours proposed and not yet decided. Never netted off — a proposal is not a payment. */
  awaitingHours: number;
  /** grossHours minus madeUpHours, floored at zero. What a make-up may still be proposed for. */
  remainingHours: number;
  items: OutstandingItem[];
  /**
   * Approved leave on days with NO approved plan. Nothing is owed FROM THIS MODULE for them, because
   * nothing was ever allocated to those days — and saying so is more honest than inventing a figure.
   */
  unscheduledLeaveDates: string[];
}

const EMPTY_OUTSTANDING: OutstandingRead = {
  ok: false, error: null, grossHours: 0, madeUpHours: 0, awaitingHours: 0, remainingHours: 0,
  items: [], unscheduledLeaveDates: [],
};

/**
 * APPROVED LEAVE DOES NOT WAIVE THE HOURS.
 *
 * This is the rule the rest of the product had backwards: src/lib/credit-week.ts REDUCES a week's
 * requirement by approved leave, so a week entirely on leave could earn a credit having recorded no
 * work at all. Under the internship specification the same week owes its hours back.
 *
 * WHAT IS COUNTED, AND WHAT IS DELIBERATELY NOT:
 *   - only APPROVED leave, and only leave that is ABSENCE. Work from home is a work mode, not an
 *     absence; the person is working, and charging them make-up hours for it would be a fabrication.
 *   - only days that had an APPROVED plan. Hours are owed against what was actually allocated, so a
 *     day nobody had planned owes nothing here and is listed separately instead of guessed at.
 *   - a HALF day owes half the day's planned hours; hourly leave owes the hours taken, capped at what
 *     was planned. Somebody who worked the rest of the day does not owe the rest of the day.
 *
 * DERIVED, NEVER STORED. A stored balance is a second number, and it goes wrong the first time a
 * leave request is cancelled or a plan is superseded. This recomputes from the two records that
 * already exist and therefore has nothing of its own to be wrong about.
 */
export async function outstandingHours(employeeId: string): Promise<OutstandingRead> {
  if (!isUuid(employeeId)) return { ...EMPTY_OUTSTANDING, error: NOT_AVAILABLE };

  try {
    await ensureScheduleSchema();

    // 1. Every day that an approved plan allocated hours to, and what it allocated them to.
    const planned = rows(await db.execute(sql`
      SELECT d.day_date, d.activity, d.hours, s.week_start
        FROM eims_schedule_days d
        JOIN eims_schedules s ON s.id = d.schedule_id
       WHERE s.employee_id = ${employeeId}::uuid
         AND s.state = 'approved' AND s.superseded_by_id IS NULL`));

    const byDate = new Map<string, { hours: number; weekStart: string; activities: string[] }>();
    for (const p of planned) {
      const date = iso(p.day_date);
      if (!date) continue;
      const cur = byDate.get(date) || { hours: 0, weekStart: iso(p.week_start), activities: [] };
      cur.hours = round2(cur.hours + (Number(p.hours) || 0));
      if (p.activity) cur.activities.push(String(p.activity));
      byDate.set(date, cur);
    }

    // 2. Approved leave. Read from the leave engine's own table; nothing here writes to it.
    //
    // ITS OWN SCHEMA IS ASSERTED FIRST, and by the leave engine rather than by this file. `unit`,
    // `hours` and `day_part` are columns hr-leave.ts adds at runtime under its own key, so an intern
    // who opens this screen before anything has touched the leave module would otherwise hit a
    // SELECT for columns that are not there yet and be told, honestly but wrongly, that their
    // outstanding hours could not be worked out. Awaited here, not copied: this module creates no
    // leave table and asserts no leave column of its own.
    let leave: any[] = [];
    try {
      await ensureLeaveSchema();
      leave = rows(await db.execute(sql`
        SELECT id::text AS id, leave_type, start_date, end_date, unit, hours, day_part
          FROM hr_leave_request
         WHERE employee_id = ${employeeId}::uuid AND status = 'approved'
         ORDER BY start_date DESC
         LIMIT ${MAX_LEAVE_ROWS}`));
    } catch (e: any) {
      // A silent zero here would tell an intern they owe nothing when they may owe a week.
      logFail('outstandingHours leave', e);
      return {
        ...EMPTY_OUTSTANDING,
        error: 'Your approved leave could not be read, so outstanding hours cannot be worked out '
          + 'right now. This is not a statement that you owe nothing.',
      };
    }

    const items: OutstandingItem[] = [];
    const unscheduled: string[] = [];

    for (const l of leave) {
      const meta = leaveType(String(l.leave_type || ''));
      // WORK FROM HOME IS NOT ABSENCE. The person worked; nothing is owed.
      if (meta && meta.kind === 'work_mode') continue;

      const unit = String(l.unit || 'full');
      const leaveHours = l.hours == null ? null : Number(l.hours);
      const dates = datesBetween(iso(l.start_date), iso(l.end_date));

      for (const date of dates) {
        const plan = byDate.get(date);
        if (!plan || plan.hours <= 0) {
          if (unscheduled.indexOf(date) < 0) unscheduled.push(date);
          continue;
        }
        let owed = plan.hours;
        let fraction = 1;
        if (unit === 'half') {
          fraction = 0.5;
          owed = round2(plan.hours * 0.5);
        } else if (unit === 'hours' && leaveHours && leaveHours > 0) {
          owed = round2(Math.min(leaveHours, plan.hours));
          fraction = plan.hours > 0 ? round2(owed / plan.hours) : 1;
        }
        if (owed <= 0) continue;
        items.push({
          date,
          weekStart: plan.weekStart || weekStartOf(date),
          leaveRequestId: String(l.id),
          leaveType: String(l.leave_type || ''),
          fraction,
          scheduledHours: plan.hours,
          outstandingHours: owed,
          activities: plan.activities.slice(0, 4),
        });
      }
    }

    const grossHours = round2(items.reduce((a, b) => a + b.outstandingHours, 0));

    // 3. What has already been paid back, and what is only proposed. A proposal is not a payment.
    const mk = rows(await db.execute(sql`
      SELECT state, superseded_by_id, total_hours FROM eims_schedules
       WHERE employee_id = ${employeeId}::uuid AND kind = 'makeup'
         AND state IN ('approved', 'proposed')`));
    let madeUp = 0;
    let awaiting = 0;
    for (const m of mk) {
      const h = Number(m.total_hours ?? 0) || 0;
      if (String(m.state) === 'approved' && !m.superseded_by_id) madeUp += h;
      else if (String(m.state) === 'proposed') awaiting += h;
    }
    madeUp = round2(madeUp);
    awaiting = round2(awaiting);

    return {
      ok: true,
      error: null,
      grossHours,
      madeUpHours: madeUp,
      awaitingHours: awaiting,
      remainingHours: round2(Math.max(0, grossHours - madeUp)),
      items: items.sort((a, b) => (a.date < b.date ? 1 : -1)),
      unscheduledLeaveDates: unscheduled.sort().reverse().slice(0, 30),
    };
  } catch (e: any) {
    logFail('outstandingHours', e);
    return {
      ...EMPTY_OUTSTANDING,
      error: errText(e, 'Outstanding hours could not be worked out just now. This is not a statement '
        + 'that you owe nothing.'),
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE DECISION
// -------------------------------------------------------------------------------------------------

export const SCHEDULE_DECISIONS = ['approved', 'rejected', 'changes-requested'] as const;
export type ScheduleDecision = (typeof SCHEDULE_DECISIONS)[number];
const DECISION_SET = new Set<string>(SCHEDULE_DECISIONS);
export function isScheduleDecision(v: unknown): v is ScheduleDecision {
  return typeof v === 'string' && DECISION_SET.has(v);
}

export interface DecisionResult {
  ok: boolean;
  error: string | null;
  state?: string;
  warning?: string | null;
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
 * MARK THE PREVIOUS OFFICIAL PLAN AS REPLACED, THEN MAKE THIS ONE OFFICIAL. In that order.
 *
 * The order is not stylistic. A partial unique index guarantees one official weekly plan per week, so
 * approving the new row before retiring the old one would collide with the guarantee and fail. The
 * old row keeps every one of its own figures; it gains only a pointer to what replaced it, because an
 * approved schedule is history and history is not rewritten.
 */
async function makeOfficial(row: any, scheduleId: string): Promise<void> {
  if (String(row.kind || '') === 'regular') {
    await db.execute(sql`
      UPDATE eims_schedules
         SET state = 'superseded', superseded_by_id = ${scheduleId}::uuid, updated_at = NOW()
       WHERE employee_id = ${String(row.employee_id)}::uuid
         AND week_start = ${iso(row.week_start)}::date
         AND kind = 'regular' AND state = 'approved' AND superseded_by_id IS NULL
         AND id <> ${scheduleId}::uuid`);
  }
}

/**
 * A PERSON DECIDES A PROPOSED SCHEDULE.
 *
 * AUTHORITY IS NOT DECIDED HERE. decideStep() re-derives it through workflow.mayAct(): the routed
 * approver, their in-force delegate, or a holder of the domain's standing authority. A posted
 * schedule id from somebody with no claim on it is refused there, not by the fact that a page drew
 * no button.
 *
 * THE CEILING IS CHECKED AGAIN, HERE, AT THE MOMENT OF APPROVAL. Between proposing and approving, a
 * make-up can have been approved into the same week, or the person's recorded weekly hours can have
 * changed. Approving on the strength of a check made three days ago is how an intern ends up with a
 * 46-hour approved week, and this is the single place that cannot be bypassed by a screen.
 *
 * "Changes requested" is a DECLINE in the engine and a distinct state on the record. There is no
 * fourth workflow decision and inventing one would fork the state machine that every other domain
 * shares; but "re-plan this and send it back" is not "no", and an intern reading it on a phone has to
 * be able to tell which they were told.
 */
export async function decideSchedule(
  scheduleId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  decision: ScheduleDecision,
  reason: string,
): Promise<DecisionResult> {
  if (!isUuid(scheduleId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isScheduleDecision(decision)) return { ok: false, error: 'That decision could not be read.' };

  const why = String(reason || '').trim().slice(0, REASON_MAX);
  if (decision !== 'approved' && why.length < MIN_DECISION_REASON) {
    return {
      ok: false,
      error: decision === 'rejected'
        ? 'Write a reason. Somebody planned this week around their classes, and a refusal with no '
          + 'reason cannot be acted on.'
        : 'Say what needs to change. "Changes requested" with nothing to change is a refusal wearing '
          + 'a politer word.',
    };
  }

  try {
    await ensureScheduleSchema();
    const row = rows(await db.execute(sql`
      SELECT * FROM eims_schedules WHERE id = ${scheduleId}::uuid LIMIT 1`))[0];
    if (!row) return { ok: false, error: NOT_AVAILABLE };

    if (isScheduleDecided(String(row.state))) {
      // Already settled. A no-op rather than an error: two people opening one queue is ordinary, and
      // telling the second that it failed makes them go and decide it somewhere else.
      return { ok: true, error: null, state: String(row.state) };
    }
    if (!row.workflow_instance_id) {
      return { ok: false, error: 'This plan has not reached an approver yet, so there is no approval '
        + 'to act on. The person who proposed it can send it again from their schedule screen.' };
    }

    const inst = await getInstance(String(row.workflow_instance_id));
    if (!inst) return { ok: false, error: 'The approval for this plan could not be read.' };
    if (inst.state === 'halted') {
      return {
        ok: false,
        error: inst.haltReason
          || 'No approver is named for this plan in the organization graph, so it cannot be decided yet.',
      };
    }
    const step = inst.steps.find((s) => s.stepNo === inst.currentStep && s.decision === 'pending');
    if (!step) return { ok: false, error: 'There is no step waiting on a decision for this plan.' };

    // THE CEILING, RE-CHECKED AGAINST THE WEEK AS IT IS NOW.
    if (decision === 'approved') {
      const kind = String(row.kind || 'regular');
      const ws = iso(row.week_start);
      const hours = Number(row.total_hours ?? 0) || 0;
      const cap = await capacityForWeek(String(row.employee_id), ws, {
        replacingOfficialRegular: kind === 'regular',
        excludeScheduleId: scheduleId,
      });
      if (!cap.ok) {
        return { ok: false, error: cap.error || 'The hours already approved into that week could not '
          + 'be read, so this cannot be approved safely. Nothing was changed.' };
      }
      if (cap.ceilingHours == null) {
        return { ok: false, error: 'No weekly hours are recorded for this person, so there is no '
          + 'ceiling to approve this against. Ask HR to record their weekly hours first. Nothing was '
          + 'changed.' };
      }
      if (round2(cap.committedHours + hours) > cap.ceilingHours + HOURS_SLACK) {
        return {
          ok: false,
          error: 'Approving this would take ' + weekLabel(ws) + ' to '
            + hoursText(round2(cap.committedHours + hours)) + ', past the '
            + hoursText(cap.ceilingHours) + ' ceiling. ' + hoursText(cap.committedHours)
            + ' are already approved into that week. Ask for a smaller plan instead; outstanding hours '
            + 'are never cleared by going over the ceiling.',
        };
      }
      if (kind === 'makeup') {
        const owed = await outstandingHours(String(row.employee_id));
        if (!owed.ok) {
          return { ok: false, error: owed.error || 'What this person is owed could not be worked out, '
            + 'so a make-up cannot be approved against it. Nothing was changed.' };
        }
        if (hours > owed.remainingHours + HOURS_SLACK) {
          return {
            ok: false,
            error: 'This make-up is ' + hoursText(hours) + ' against ' + hoursText(owed.remainingHours)
              + ' still outstanding. A make-up pays back what leave left owed; approving more than '
              + 'that would add recognised hours nobody is owed.',
          };
        }
      }
    }

    // THE ONE APPROVAL PATH. 'changes-requested' is a decline in the engine, and its own state here.
    const res = await decideStep(
      step.id,
      user as any,
      decision === 'approved' ? 'approved' : 'rejected',
      why || 'Approved as proposed.',
    );
    if (!res.ok) return { ok: false, error: res.error || WRITE_FAILED };

    const name = await deciderName(user?.id || null);

    if (decision === 'approved') await makeOfficial(row, scheduleId);

    // The precondition is repeated in the write, so a colleague who decided a second earlier makes
    // this touch zero rows rather than overwriting their decision with this one.
    const wrote = rows(await db.execute(sql`
      UPDATE eims_schedules
         SET state = ${decision},
             decision_reason = ${why || null}::text,
             decided_at = NOW(),
             decided_by_user_id = ${isUuid(user?.id) ? String(user!.id) : null}::uuid,
             decided_by_name = ${name}::text,
             halt_reason = NULL,
             updated_at = NOW()
       WHERE id = ${scheduleId}::uuid AND state = 'proposed'
      RETURNING id::text AS id`));

    if (!wrote.length) {
      return {
        ok: true,
        error: null,
        state: decision,
        warning: 'The decision is recorded on the approval, but this plan had already been settled '
          + 'here by somebody else. Reload the page to see the version that stands.',
      };
    }

    await logAudit({
      userId: isUuid(user?.id) ? String(user!.id) : null,
      action: 'eims.schedule.' + decision,
      entity: 'eims_schedules',
      entityId: scheduleId,
      diff: {
        employeeId: String(row.employee_id || ''),
        kind: String(row.kind || ''),
        weekStart: iso(row.week_start),
        totalHours: Number(row.total_hours ?? 0),
        reason: why || null,
      },
    });

    return { ok: true, error: null, state: decision };
  } catch (e: any) {
    logFail('decideSchedule', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * THE INTERN TAKES A PROPOSAL BACK before anybody has decided it.
 *
 * Only their own, only while it is still proposed, and the workflow instance is cancelled with it so
 * the manager's queue does not keep asking for a decision on something nobody is waiting for.
 */
export async function withdrawSchedule(
  scheduleId: string,
  employeeId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
): Promise<DecisionResult> {
  if (!isUuid(scheduleId) || !isUuid(employeeId)) return { ok: false, error: NOT_AVAILABLE };

  try {
    await ensureScheduleSchema();
    const row = rows(await db.execute(sql`
      SELECT id::text AS id, state, workflow_instance_id::text AS workflow_instance_id
        FROM eims_schedules
       WHERE id = ${scheduleId}::uuid AND employee_id = ${employeeId}::uuid LIMIT 1`))[0];
    if (!row) return { ok: false, error: NOT_AVAILABLE };
    if (String(row.state) !== 'proposed') {
      return { ok: true, error: null, state: String(row.state) };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE eims_schedules SET state = 'withdrawn', updated_at = NOW()
       WHERE id = ${scheduleId}::uuid AND state = 'proposed'
      RETURNING id::text AS id`));
    if (!wrote.length) {
      return { ok: false, error: 'That plan was decided while this page was open, so it can no longer '
        + 'be withdrawn. Reload to see the decision that stands.' };
    }

    let warning: string | null = null;
    if (row.workflow_instance_id) {
      const res = await cancelWorkflow(String(row.workflow_instance_id), user as any,
        'Withdrawn by the person who proposed it');
      if (!res.ok) {
        // Not swallowed: the plan is withdrawn either way, but the approver may still see it.
        warning = 'The plan is withdrawn, but the approval could not be closed: '
          + (res.error || 'unknown reason') + ' Your manager may still see it on their queue.';
      }
    }

    await logAudit({
      userId: isUuid(user?.id) ? String(user!.id) : null,
      action: 'eims.schedule.withdraw',
      entity: 'eims_schedules',
      entityId: scheduleId,
      diff: { employeeId },
    });

    return { ok: true, error: null, state: 'withdrawn', warning };
  } catch (e: any) {
    logFail('withdrawSchedule', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * REFLECT A DECISION MADE SOMEWHERE ELSE.
 *
 * /portal/approvals is generic: it lists every routed step whatever its domain, so a reporting manager
 * will approve a schedule there without ever opening a schedule screen. When they do, the workflow
 * instance settles and this table has not been told. This reads the settled instances back and writes
 * the outcome, the decider and their note onto the plan.
 *
 * ONLY 'proposed' ROWS ARE TOUCHED, so it can be called freely on every page load and cannot rewrite a
 * decided plan.
 *
 * WHERE AN APPROVAL TAKEN ELSEWHERE LEAVES THE WEEK OVER ITS CEILING, the approval STANDS — a person
 * made it and this module does not get to overrule them — and the week is stamped with a sentence
 * saying so. The recognised total is capped by the ceiling wherever hours are recognised; what this
 * note prevents is the plan looking as though 46 hours were quietly agreed to.
 */
export async function syncScheduleDecisions(
  employeeId: string,
): Promise<{ ok: boolean; updated: number; error: string | null }> {
  if (!isUuid(employeeId)) return { ok: true, updated: 0, error: null };
  try {
    await ensureScheduleSchema();
    const pend = rows(await db.execute(sql`
      SELECT * FROM eims_schedules
       WHERE employee_id = ${employeeId}::uuid AND state = 'proposed'
         AND workflow_instance_id IS NOT NULL
       LIMIT 40`));

    let updated = 0;
    for (const s of pend) {
      const inst = await getInstance(String(s.workflow_instance_id));
      if (!inst) continue;

      if (inst.state === 'halted') {
        // The sentence is kept on the plan so the person waiting can read WHICH relationship is
        // missing, rather than seeing "waiting" against nobody for a fortnight.
        await db.execute(sql`
          UPDATE eims_schedules SET halt_reason = ${inst.haltReason || null}::text, updated_at = NOW()
           WHERE id = ${String(s.id)}::uuid AND state = 'proposed'`);
        continue;
      }
      if (inst.state === 'cancelled') {
        await db.execute(sql`
          UPDATE eims_schedules SET state = 'withdrawn', updated_at = NOW()
           WHERE id = ${String(s.id)}::uuid AND state = 'proposed'`);
        updated++;
        continue;
      }
      if (inst.state !== 'approved' && inst.state !== 'rejected') continue;

      const decided = inst.steps
        .filter((st) => st.decision === 'approved' || st.decision === 'rejected')
        .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0];
      const note = decided?.note ? String(decided.note).slice(0, REASON_MAX) : null;
      const state = inst.state === 'approved' ? 'approved' : 'rejected';

      let ceilingNote: string | null = null;
      if (state === 'approved') {
        const cap = await capacityForWeek(String(s.employee_id), iso(s.week_start), {
          replacingOfficialRegular: String(s.kind || '') === 'regular',
          excludeScheduleId: String(s.id),
        });
        const total = round2(cap.committedHours + (Number(s.total_hours ?? 0) || 0));
        if (cap.ok && cap.ceilingHours != null && total > cap.ceilingHours + HOURS_SLACK) {
          ceilingNote = 'This was approved from the general approvals queue and takes '
            + weekLabel(iso(s.week_start)) + ' to ' + hoursText(total) + ', past the '
            + hoursText(cap.ceilingHours) + ' ceiling. The approval stands because a person made it, '
            + 'but hours recognised for the week remain capped at the ceiling.';
        }
        await makeOfficial(s, String(s.id));
      }

      await db.execute(sql`
        UPDATE eims_schedules
           SET state = ${state},
               decision_reason = COALESCE(${note}::text, decision_reason),
               decided_at = COALESCE(${decided?.decidedAt || null}::timestamptz, NOW()),
               decided_by_user_id = COALESCE(${decided?.decidedByUserId || null}::uuid, decided_by_user_id),
               decided_by_name = COALESCE(${decided?.approverName || null}::text, decided_by_name),
               ceiling_note = ${ceilingNote}::text,
               halt_reason = NULL,
               updated_at = NOW()
         WHERE id = ${String(s.id)}::uuid AND state = 'proposed'`);
      updated++;
    }

    return { ok: true, updated, error: null };
  } catch (e: any) {
    logFail('syncScheduleDecisions', e);
    return {
      ok: false,
      updated: 0,
      error: errText(e, 'Decisions taken elsewhere could not be applied to your schedules.'),
    };
  }
}

/**
 * SEND A SAVED PLAN FOR APPROVAL AGAIN.
 *
 * Only for a proposal that never reached anybody — startWorkflow is idempotent on (domain, record_id),
 * so calling this on a plan that IS routed returns the instance it already has rather than routing it
 * twice to two different people.
 */
export async function resendForApproval(
  scheduleId: string,
  employeeId: string,
  userId: string | null,
): Promise<ProposeResult> {
  if (!isUuid(scheduleId) || !isUuid(employeeId)) return { ok: false, error: NOT_AVAILABLE };
  try {
    await ensureScheduleSchema();
    const row = rows(await db.execute(sql`
      SELECT id::text AS id, kind, week_start, total_hours, ceiling_hours, state
        FROM eims_schedules
       WHERE id = ${scheduleId}::uuid AND employee_id = ${employeeId}::uuid LIMIT 1`))[0];
    if (!row) return { ok: false, error: NOT_AVAILABLE };
    if (String(row.state) !== 'proposed') {
      return { ok: false, error: 'Only a plan still waiting to be sent can be sent again.' };
    }

    const ws = iso(row.week_start);
    const res = await startWorkflow({
      domain: SCHEDULE_DOMAIN,
      recordId: scheduleId,
      subjectEmployeeId: employeeId,
      requestedByUserId: isUuid(userId) ? String(userId) : null,
      createdByUserId: isUuid(userId) ? String(userId) : null,
      summary: (String(row.kind) === 'makeup' ? 'Make-up schedule for ' : 'Weekly schedule for ')
        + weekLabel(ws) + ': ' + hoursText(Number(row.total_hours ?? 0)) + '.',
    });
    if (!res.ok) return { ok: false, error: res.error || WRITE_FAILED };

    await db.execute(sql`
      UPDATE eims_schedules
         SET workflow_instance_id = ${res.instanceId || null}::uuid,
             halt_reason = ${res.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${scheduleId}::uuid AND state = 'proposed'`);

    return { ok: true, error: null, scheduleId, state: 'proposed', haltReason: res.haltReason || null };
  } catch (e: any) {
    logFail('resendForApproval', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * THE WEEKS A SCREEN OFFERS TO PLAN: this week and the next few. Pure, so a page and a test agree.
 *
 * The past is deliberately not offered. A plan is a forward-looking statement of intent, and a
 * schedule proposed for a week that has already happened is a claim about work already done, which is
 * what the activity record and its evidence are for.
 */
export function plannableWeeks(todayIso: string, count = 4): string[] {
  const start = weekStartOf(String(todayIso || ''));
  if (!start) return [];
  const n = Math.min(Math.max(Number(count) || 4, 1), 12);
  const base = parseIso(start);
  if (!base) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(isoDate(new Date(base.getTime() + i * 7 * DAY_MS)));
  return out;
}
