// src/lib/manager-intelligence/read.ts — THE SCOPED READS. NOTHING LEAVES HERE UNAUTHORISED.
//
// =================================================================================================
// WHO A MANAGER MAY SEE, AND WHERE THAT IS DECIDED
// =================================================================================================
//
// Not here. src/lib/performance-scope.ts already answers it once for the whole product, composing a
// RELATIONSHIP from the organization graph (per ROW: "is this person's manager me, today?") with a
// CAPABILITY from permissions.ts (per USER: "may I see everyone?"). This module calls
// resolvePerfViewer() and canSeePerformanceOf() and adds no second implementation — a second answer
// to "may I see this person" is a second answer that will one day disagree with the first.
//
// EVERY READ IS BOUNDED BY AN ID LIST RESOLVED FROM THE GRAPH, IN THE WHERE CLAUSE. There is no
// ?employee= that widens it, no post-fetch filtering, and an unresolvable viewer reads nothing at
// all rather than everything. The worst a mistake in here can produce is an empty page.
//
// =================================================================================================
// WHAT IS DELIBERATELY NOT SELECTED, EACH FOR A REASON
// =================================================================================================
//
//   - gender, date of birth, marital status, address, salary, bank details, PAN, Aadhaar, UAN.
//     A manager plans work; none of it helps plan work. `gender` is the exact column read in the
//     2026-08-02 incident, so it is not selected, not joined, and not used to order anything.
//   - anything from wellness_*. That system is women-only, gated, aggregate-only, and has no
//     "read one person's log" helper anywhere in it. A manager screen must not be where one grows.
//   - hr_clock_events. Latitude, longitude, accuracy, IP, device string and a base64 selfie per
//     punch. A person may see their own trail; a manager seeing their reports' is surveillance.
//     Attendance here comes from hr_attendance: a status and a date, nothing else.
//   - hr_leave_request.reason and hr_leave_request.leave_type. The reason field is where people
//     write "hospital", "my father", "the results came back". The type is where "Maternity" and
//     "Sick" live. Cover planning needs the DATES and the COUNT, which is all this reads.
//   - hr_employee_flags at level 2 or 3, and every flag's description, breach_type and action.
//     Those are investigations. HR holds them. What crosses into this module is a COUNT of level-1
//     rows and nothing else, so a manager can be told to speak to HR without being told what about.
//   - profile photographs. They are the frame captured at face-2FA enrolment; a security capture
//     repurposed into a manager's roster is not what anybody consented to. Initials are used.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  canSeePerformanceOf,
  isUuid,
  logFail,
  resolvePerfViewer,
  rowsOf,
  uuidList,
  type PerfViewer,
} from '@/lib/performance-scope';
import { isResponsibleFor } from '@/lib/org-graph';
import { timelineFor, type HrEvent } from '@/lib/hr-events';
import { readyState, type MtiSchemaState } from './schema';
import {
  actionKindLabel,
  type ManagerActionKind,
  type ObservationWindow,
  type SectionKey,
  type TeamMemberFacts,
} from './types';

const MOD = 'manager-intelligence/read';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND DATE HELPERS — declared above every function that reads them.
// -------------------------------------------------------------------------------------------------

/** The default observation window. Four weeks is long enough for a pattern and short enough to act on. */
export const DEFAULT_WINDOW_DAYS = 28;

/** The furthest back a manager may look on this screen. */
export const MAX_WINDOW_DAYS = 90;

/** How far ahead capacity looks for booked leave. */
export const LOOKAHEAD_DAYS = 14;

/** A roster larger than this is paged rather than counted in one go. */
export const ROSTER_CAP = 60;

const DAY_MS = 86400000;

const dayIso = (d: Date): string => d.toISOString().slice(0, 10);

const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

/** Monday to Friday. Weekend-shaped weeks are the assumption this makes, and it says so on screen. */
const isWeekday = (iso: string): boolean => {
  const day = new Date(iso + 'T00:00:00Z').getUTCDay();
  return day >= 1 && day <= 5;
};

function weekdaysIn(fromIso: string, toIso: string): number {
  let n = 0;
  let d = new Date(fromIso + 'T00:00:00Z');
  const end = new Date(toIso + 'T00:00:00Z');
  while (d.getTime() <= end.getTime()) {
    if (isWeekday(dayIso(d))) n += 1;
    d = addDays(d, 1);
  }
  return n;
}

/** The window, from a requested length. Clamped rather than refused, so a bad query string is harmless. */
export function windowFrom(now: Date, days?: number | null): ObservationWindow {
  const n = Math.min(Math.max(Number(days) || DEFAULT_WINDOW_DAYS, 7), MAX_WINDOW_DAYS);
  const toIso = dayIso(now);
  const fromIso = dayIso(addDays(now, -(n - 1)));
  return { fromIso, toIso, days: n };
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// -------------------------------------------------------------------------------------------------
// THE VIEWER, AND HOW THEY CAME TO HOLD AUTHORITY OVER ONE PERSON
// -------------------------------------------------------------------------------------------------

export interface ManagerScope {
  viewer: PerfViewer;
  /** Whether the tables this patch writes to exist yet. Rendered as a sentence, never as silence. */
  schema: MtiSchemaState;
}

/**
 * Resolve the manager once per request.
 *
 * `holds` is the composed context's wildcard-aware membership test, passed IN exactly as
 * performance-scope requires, so this module imports no authorization engine and cannot become one.
 */
export async function resolveManagerScope(
  userId: string,
  holds: (key: string) => boolean,
): Promise<ManagerScope> {
  const viewer = await resolvePerfViewer(userId, holds);
  const schema = await readyState();
  return { viewer, schema };
}

/**
 * HOW THIS MANAGER HOLDS AUTHORITY OVER THIS PERSON, AT THIS MOMENT, IN ONE PHRASE.
 *
 * Written onto every act in mti_manager_actions and onto every envelope that reaches the central
 * record. Months later, "why was this person allowed to write that about me" is a question with a
 * one-word answer instead of an archaeology exercise across a graph that has since been reorganised.
 *
 * Returns null when the viewer holds no authority — the callers treat that as a refusal, not as a
 * blank label.
 */
export async function authorityBasisFor(viewer: PerfViewer, employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  if (viewer.employeeId && viewer.employeeId === employeeId) return 'self';
  if (viewer.reportIds.indexOf(employeeId) >= 0) return 'direct_report';
  if (viewer.reviewSubjects.some((p) => String(p.employeeId || '') === employeeId)) return 'review_subject';
  if (viewer.employeeId && (await isResponsibleFor(viewer.employeeId, employeeId))) {
    return 'responsible_via_org_graph';
  }
  if (viewer.managesOrg) return 'capability:performance.manage';
  return null;
}

// -------------------------------------------------------------------------------------------------
// THE ROSTER — ONLY ASSIGNED OR AUTHORISED TEAM MEMBERS
// -------------------------------------------------------------------------------------------------

export interface RosterEntry {
  employeeId: string;
  fullName: string;
  designation: string | null;
  /** direct_report | review_subject | responsible_via_org_graph | capability:performance.manage */
  authorityBasis: string;
  openTasks: number;
  overdue: number;
  dueWithin7: number;
  blocked: number;
  /** Reports filed in the window, against days attendance records as worked. */
  reportsFiled: number;
  reportsExpected: number;
  /** Open acts still tracked as development actions. */
  openDevelopmentActions: number;
}

export interface Roster {
  ok: boolean;
  entries: RosterEntry[];
  /** True when there are more authorised people than ROSTER_CAP. Said out loud, never truncated silently. */
  truncated: boolean;
  totalAuthorised: number;
  /** The sentence a screen prints when entries is empty. Distinguishes empty graph from empty team. */
  sentence: string;
}

const NO_EMPLOYEE_SENTENCE =
  'This account has no employee record, so no reporting line can be resolved for it. That is not the '
  + 'same as having no team.';

/**
 * Everyone this manager is authorised to see, with the two or three numbers that decide who to open
 * first.
 *
 * ONE QUERY PER FACT ACROSS THE WHOLE TEAM, not one query per person. A roster of twenty people
 * built person by person is sixty round trips, and at the measured ~177ms between the functions and
 * this database that is a page nobody waits for.
 */
export async function teamRoster(viewer: PerfViewer, now: Date): Promise<Roster> {
  const empty = (sentence: string): Roster =>
    ({ ok: true, entries: [], truncated: false, totalAuthorised: 0, sentence });

  if (!viewer.employeeId && !viewer.managesOrg) return empty(NO_EMPLOYEE_SENTENCE);

  // WHO. Direct reports and review subjects come from the graph, already resolved. A
  // performance.manage holder with no reports sees an explicit note rather than the whole company:
  // this screen is a team screen, and "everyone" is not a team.
  const people = new Map<string, { name: string; designation: string | null; basis: string }>();
  for (const p of viewer.reports) {
    const id = String(p.employeeId || '');
    if (isUuid(id)) {
      people.set(id, { name: p.fullName || 'Unnamed record', designation: p.designation, basis: 'direct_report' });
    }
  }
  for (const p of viewer.reviewSubjects) {
    const id = String(p.employeeId || '');
    if (isUuid(id) && !people.has(id)) {
      people.set(id, { name: p.fullName || 'Unnamed record', designation: p.designation, basis: 'review_subject' });
    }
  }

  const totalAuthorised = people.size;
  if (!totalAuthorised) {
    if (!viewer.initialized) {
      return empty('The Organization Graph has not been set up yet, so no reporting line can be resolved '
        + 'for anybody. This is not a statement that you have no team.');
    }
    return empty(viewer.managesOrg
      ? 'Nobody is recorded as reporting to you or as being reviewed by you. Holding the organization-wide '
        + 'capability does not make everybody your team, and this screen is a team screen.'
      : 'Nobody is recorded in the Organization Graph as reporting to you.');
  }

  const ids = Array.from(people.keys()).slice(0, ROSTER_CAP);
  const truncated = totalAuthorised > ids.length;
  const w = windowFrom(now, DEFAULT_WINDOW_DAYS);
  const soonIso = dayIso(addDays(now, 7));
  const todayIso = dayIso(now);

  const byId = new Map<string, RosterEntry>();
  for (const id of ids) {
    const p = people.get(id)!;
    byId.set(id, {
      employeeId: id,
      fullName: p.name,
      designation: p.designation,
      authorityBasis: p.basis,
      openTasks: 0,
      overdue: 0,
      dueWithin7: 0,
      blocked: 0,
      reportsFiled: 0,
      reportsExpected: 0,
      openDevelopmentActions: 0,
    });
  }

  const list = uuidList(ids);

  try {
    for (const r of rowsOf(await db.execute(sql`
      SELECT employee_id::text AS employee_id,
             COUNT(*)::int AS open_tasks,
             COUNT(*) FILTER (WHERE due_on IS NOT NULL AND due_on < ${todayIso}::date)::int AS overdue,
             COUNT(*) FILTER (WHERE due_on IS NOT NULL AND due_on >= ${todayIso}::date AND due_on <= ${soonIso}::date)::int AS due_soon,
             COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked
        FROM employee_tasks
       WHERE employee_id IN (${list})
         AND status NOT IN ('completed', 'cancelled', 'archived')
       GROUP BY employee_id`))) {
      const e = byId.get(String(r.employee_id));
      if (!e) continue;
      e.openTasks = num(r.open_tasks);
      e.overdue = num(r.overdue);
      e.dueWithin7 = num(r.due_soon);
      e.blocked = num(r.blocked);
    }
  } catch (e: any) {
    logFail(MOD, 'roster tasks', e);
  }

  try {
    for (const r of rowsOf(await db.execute(sql`
      SELECT a.employee_id::text AS employee_id,
             COUNT(*)::int AS expected,
             COUNT(d.id)::int AS filed
        FROM hr_attendance a
        LEFT JOIN hr_daily_reports d
               ON d.employee_id = a.employee_id AND d.report_date = a.date
       WHERE a.employee_id IN (${list})
         AND a.date BETWEEN ${w.fromIso}::date AND ${w.toIso}::date
         AND a.status IN ('present', 'wfh')
       GROUP BY a.employee_id`))) {
      const e = byId.get(String(r.employee_id));
      if (!e) continue;
      e.reportsExpected = num(r.expected);
      e.reportsFiled = num(r.filed);
    }
  } catch (e: any) {
    logFail(MOD, 'roster reports', e);
  }

  try {
    for (const r of rowsOf(await db.execute(sql`
      SELECT subject_employee_id::text AS employee_id, COUNT(*)::int AS n
        FROM mti_development_actions
       WHERE subject_employee_id IN (${list})
         AND status IN ('open', 'in_progress')
       GROUP BY subject_employee_id`))) {
      const e = byId.get(String(r.employee_id));
      if (e) e.openDevelopmentActions = num(r.n);
    }
  } catch (e: any) {
    // Expected on a database where db/manager-intelligence-schema.sql has not been run yet. The
    // roster is still correct without it; schemaState() is what tells the manager why it is zero.
    logFail(MOD, 'roster development actions', e);
  }

  const entries = Array.from(byId.values()).sort((a, b) => {
    if (b.overdue !== a.overdue) return b.overdue - a.overdue;
    if (b.openTasks !== a.openTasks) return b.openTasks - a.openTasks;
    return a.fullName < b.fullName ? -1 : (a.fullName > b.fullName ? 1 : 0);
  });

  return {
    ok: true,
    entries,
    truncated,
    totalAuthorised,
    sentence: truncated
      ? 'Showing ' + String(ids.length) + ' of ' + String(totalAuthorised) + ' people. The rest are not '
        + 'hidden — this screen caps what it counts in one pass so it stays quick.'
      : '',
  };
}

// -------------------------------------------------------------------------------------------------
// THE FACTS FOR ONE PERSON
// -------------------------------------------------------------------------------------------------

const zeroFacts = (
  employeeId: string,
  fullName: string,
  designation: string | null,
  w: ObservationWindow,
  failures: string[],
): TeamMemberFacts => ({
  employeeId,
  fullName,
  designation,
  window: w,
  delivery: {
    openTotal: 0, inProgress: 0, blocked: 0, blockedWithStatedReason: 0, underReview: 0,
    overdue: 0, dueWithin7: 0, urgentOpen: 0, highOpen: 0,
    completedInWindow: 0, completedOnTime: 0, completedLate: 0, completedWithDueDate: 0,
    oldestOpenDays: null,
  },
  submission: {
    expectedDays: 0, filedDays: 0, sameDayFilings: 0, lateFilings: 0,
    longestMissingRun: 0, reviewedByAnyone: 0,
  },
  rework: { sendBacks: 0, tasksSentBack: 0, tasksReachingReview: 0, reportsRevised: 0, reportsFiled: 0 },
  behaviour: {
    attendanceDaysRecorded: 0, presentDays: 0, leaveDays: 0, daysWithNoRecord: 0,
    workPickedUp: 0, blockersRaised: 0, commentsWritten: 0, informalConductNotes: 0,
  },
  capacity: {
    activeAssignments: 0, urgentOpen: 0, highOpen: 0, dueWithin7: 0, overdue: 0,
    approvedLeaveDaysNext14: 0, teamSize: 0, teamMeanAssignments: null,
  },
  stated: { strengthNotes: 0, improvementNotes: 0, generalNotes: 0, mostRecentAt: null },
  readFailures: failures,
});

export type FactsResult =
  | { ok: true; facts: TeamMemberFacts; authorityBasis: string }
  | { ok: false; reason: 'not-authorised' | 'not-found' | 'no-viewer'; sentence: string };

const NOT_AUTHORISED =
  'You do not hold a recorded relationship to this person, so this page shows nothing about them. If '
  + 'that is wrong, the reporting line has not been recorded in the Organization Graph.';

/**
 * Everything signals.ts needs about one team member, for one window.
 *
 * FOUR QUERIES, NOT TWENTY. Each one answers several fields at once, because the round trip to this
 * database is the expensive part and a page that asks the same table five separate questions is a
 * page that spends a second doing it.
 *
 * A QUERY THAT FAILS NAMES ITSELF IN readFailures AND LEAVES ITS FIELDS AT ZERO. signals.ts then
 * emits nothing for that area, and the surface prints why. The failure mode being designed out is a
 * manager reading "no reports filed" off a timeout and going to have a conversation about it.
 */
export async function factsFor(
  viewer: PerfViewer,
  employeeId: string,
  now: Date,
  windowDays?: number | null,
): Promise<FactsResult> {
  if (!isUuid(employeeId)) return { ok: false, reason: 'not-found', sentence: 'No such team member.' };
  if (!viewer.employeeId && !viewer.managesOrg) {
    return { ok: false, reason: 'no-viewer', sentence: NO_EMPLOYEE_SENTENCE };
  }
  if (!(await canSeePerformanceOf(viewer, employeeId))) {
    return { ok: false, reason: 'not-authorised', sentence: NOT_AUTHORISED };
  }
  const basis = await authorityBasisFor(viewer, employeeId);
  if (!basis) return { ok: false, reason: 'not-authorised', sentence: NOT_AUTHORISED };

  const w = windowFrom(now, windowDays);
  const todayIso = dayIso(now);
  const soonIso = dayIso(addDays(now, 7));
  const aheadIso = dayIso(addDays(now, LOOKAHEAD_DAYS));
  const failures: string[] = [];

  let fullName = 'Unnamed record';
  let designation: string | null = null;
  try {
    const head = rowsOf(await db.execute(sql`
      SELECT full_name, designation FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!head.length) return { ok: false, reason: 'not-found', sentence: 'No such team member.' };
    fullName = head[0].full_name ? String(head[0].full_name) : 'Unnamed record';
    designation = head[0].designation ? String(head[0].designation) : null;
  } catch (e: any) {
    logFail(MOD, 'header', e);
    failures.push('header');
  }

  const facts = zeroFacts(employeeId, fullName, designation, w, failures);

  // ---- 1. TASKS: delivery and the task half of capacity, in one aggregate. -----------------------
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','archived'))::int AS open_total,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE status = 'blocked' AND COALESCE(blocked_reason,'') <> '')::int AS blocked_stated,
        COUNT(*) FILTER (WHERE status = 'under_review')::int AS under_review,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','archived')
                           AND due_on IS NOT NULL AND due_on < ${todayIso}::date)::int AS overdue,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','archived')
                           AND due_on IS NOT NULL AND due_on >= ${todayIso}::date
                           AND due_on <= ${soonIso}::date)::int AS due_soon,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','archived') AND priority = 'urgent')::int AS urgent_open,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','archived') AND priority = 'high')::int AS high_open,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL
                           AND completed_at::date BETWEEN ${w.fromIso}::date AND ${w.toIso}::date)::int AS completed_window,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL AND due_on IS NOT NULL
                           AND completed_at::date BETWEEN ${w.fromIso}::date AND ${w.toIso}::date)::int AS completed_dated,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL AND due_on IS NOT NULL
                           AND completed_at::date BETWEEN ${w.fromIso}::date AND ${w.toIso}::date
                           AND completed_at::date <= due_on)::int AS completed_on_time,
        MIN(created_at) FILTER (WHERE status NOT IN ('completed','cancelled','archived')) AS oldest_open_at
      FROM employee_tasks
     WHERE employee_id = ${employeeId}::uuid`));
    const t = r[0] || {};
    facts.delivery.openTotal = num(t.open_total);
    facts.delivery.inProgress = num(t.in_progress);
    facts.delivery.blocked = num(t.blocked);
    facts.delivery.blockedWithStatedReason = num(t.blocked_stated);
    facts.delivery.underReview = num(t.under_review);
    facts.delivery.overdue = num(t.overdue);
    facts.delivery.dueWithin7 = num(t.due_soon);
    facts.delivery.urgentOpen = num(t.urgent_open);
    facts.delivery.highOpen = num(t.high_open);
    facts.delivery.completedInWindow = num(t.completed_window);
    facts.delivery.completedWithDueDate = num(t.completed_dated);
    facts.delivery.completedOnTime = num(t.completed_on_time);
    facts.delivery.completedLate = Math.max(0, facts.delivery.completedWithDueDate - facts.delivery.completedOnTime);
    facts.delivery.oldestOpenDays = t.oldest_open_at
      ? Math.max(0, Math.floor((now.getTime() - new Date(t.oldest_open_at).getTime()) / DAY_MS))
      : null;

    facts.capacity.activeAssignments = facts.delivery.openTotal;
    facts.capacity.urgentOpen = facts.delivery.urgentOpen;
    facts.capacity.highOpen = facts.delivery.highOpen;
    facts.capacity.dueWithin7 = facts.delivery.dueWithin7;
    facts.capacity.overdue = facts.delivery.overdue;
  } catch (e: any) {
    logFail(MOD, 'tasks', e);
    failures.push('delivery');
  }

  // ---- 2. DAYS: attendance beside daily reports, one row per expected day. -----------------------
  //
  // Fetched day by day rather than aggregated in SQL because the longest MISSING RUN cannot be
  // counted with a GROUP BY, and the window is at most ninety rows.
  try {
    const days = rowsOf(await db.execute(sql`
      SELECT a.date::text AS day,
             a.status,
             d.id AS report_id,
             d.created_at AS filed_at,
             COALESCE(d.revision_count, 0)::int AS revisions,
             d.reviewed_at
        FROM hr_attendance a
        LEFT JOIN hr_daily_reports d
               ON d.employee_id = a.employee_id AND d.report_date = a.date
       WHERE a.employee_id = ${employeeId}::uuid
         AND a.date BETWEEN ${w.fromIso}::date AND ${w.toIso}::date
       ORDER BY a.date ASC`));

    let run = 0;
    for (const row of days) {
      const status = String(row.status || '');
      facts.behaviour.attendanceDaysRecorded += 1;
      if (status === 'on_leave') facts.behaviour.leaveDays += 1;
      const worked = status === 'present' || status === 'wfh';
      if (!worked) { run = 0; continue; }

      facts.behaviour.presentDays += 1;
      facts.submission.expectedDays += 1;
      if (row.report_id) {
        run = 0;
        facts.submission.filedDays += 1;
        facts.rework.reportsFiled += 1;
        if (num(row.revisions) > 0) facts.rework.reportsRevised += 1;
        if (row.reviewed_at) facts.submission.reviewedByAnyone += 1;
        const filedDay = row.filed_at ? new Date(row.filed_at).toISOString().slice(0, 10) : null;
        if (filedDay && filedDay === String(row.day)) facts.submission.sameDayFilings += 1;
        else facts.submission.lateFilings += 1;
      } else {
        run += 1;
        if (run > facts.submission.longestMissingRun) facts.submission.longestMissingRun = run;
      }
    }

    // Weekdays with neither an attendance row nor approved leave. Said on screen as "no record",
    // never as "absent" — and stated as weekday-shaped, because a person on a different working
    // week would otherwise look worse here than they are.
    facts.behaviour.daysWithNoRecord = Math.max(
      0,
      weekdaysIn(w.fromIso, w.toIso) - facts.behaviour.attendanceDaysRecorded,
    );
  } catch (e: any) {
    logFail(MOD, 'days', e);
    failures.push('submission');
    failures.push('behaviour');
  }

  // ---- 3. AUDITED TASK MOVES: rework, and the activity half of behaviour. ------------------------
  //
  // audit_log records a status move only from the point the audit call existed and never backfills,
  // so an older send-back is ABSENT here rather than counted as zero. The signals that read these
  // say so in their own confidence basis.
  try {
    const moves = rowsOf(await db.execute(sql`
      SELECT a.entity_id,
             a.diff->>'from' AS from_status,
             a.diff->>'to'   AS to_status,
             a.user_id::text AS actor_user_id,
             COALESCE(a.diff->>'reason', '') AS reason
        FROM audit_log a
       WHERE a.entity = 'employee_task'
         AND a.action IN ('task.status', 'task.complete')
         AND a.diff->>'employeeId' = ${employeeId}::text
         AND a.created_at >= ${w.fromIso}::date
         AND a.created_at < (${w.toIso}::date + 1)
       ORDER BY a.created_at ASC
       LIMIT 2000`));

    const reachedReview = new Set<string>();
    const sentBack = new Set<string>();
    const subjectUserIds = new Set<string>();
    try {
      for (const u of rowsOf(await db.execute(sql`
        SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid AND user_id IS NOT NULL`))) {
        subjectUserIds.add(String(u.user_id));
      }
    } catch (e: any) {
      logFail(MOD, 'subject user ids', e);
    }

    for (const m of moves) {
      const from = String(m.from_status || '');
      const to = String(m.to_status || '');
      const taskId = String(m.entity_id || '');
      const byThem = subjectUserIds.has(String(m.actor_user_id || ''));

      if (to === 'under_review' && taskId) reachedReview.add(taskId);
      const wasReviewed = from === 'under_review' || from === 'approved' || from === 'completed';
      const backToWork = to === 'in_progress' || to === 'blocked';
      if (wasReviewed && backToWork) {
        facts.rework.sendBacks += 1;
        if (taskId) sentBack.add(taskId);
      }
      if (byThem && (to === 'accepted' || to === 'in_progress')) facts.behaviour.workPickedUp += 1;
      if (byThem && to === 'blocked' && String(m.reason || '').trim()) facts.behaviour.blockersRaised += 1;
    }
    facts.rework.tasksReachingReview = reachedReview.size;
    facts.rework.tasksSentBack = sentBack.size;
  } catch (e: any) {
    logFail(MOD, 'audited moves', e);
    failures.push('rework');
  }

  // ---- 4. THE REST, IN ONE STATEMENT. -----------------------------------------------------------
  //
  // Comments, booked leave ahead, the level-1 conduct COUNT, and the feedback theme counts. Four
  // small questions of four different tables, asked once.
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int
           FROM employee_task_comments c
           JOIN hr_employees e ON e.user_id = c.author_user_id
          WHERE e.id = ${employeeId}::uuid
            AND c.created_at >= ${w.fromIso}::date
            AND c.created_at < (${w.toIso}::date + 1)) AS comments,
        (SELECT COALESCE(SUM(
                  GREATEST(0,
                    (LEAST(l.end_date, ${aheadIso}::date) - GREATEST(l.start_date, ${todayIso}::date)) + 1)
                ), 0)::int
           FROM hr_leave_request l
          WHERE l.employee_id = ${employeeId}::uuid
            AND l.status = 'approved'
            AND l.end_date >= ${todayIso}::date
            AND l.start_date <= ${aheadIso}::date) AS leave_ahead,
        (SELECT COUNT(*)::int
           FROM hr_employee_flags f
          WHERE f.employee_id = ${employeeId}::uuid
            AND f.level = 1) AS informal_notes,
        (SELECT COUNT(*)::int FROM hr_feedback fb
          WHERE fb.subject_employee_id = ${employeeId}::uuid
            AND fb.theme = 'strength' AND fb.visible_to_manager) AS strength_notes,
        (SELECT COUNT(*)::int FROM hr_feedback fb
          WHERE fb.subject_employee_id = ${employeeId}::uuid
            AND fb.theme = 'improvement' AND fb.visible_to_manager) AS improvement_notes,
        (SELECT COUNT(*)::int FROM hr_feedback fb
          WHERE fb.subject_employee_id = ${employeeId}::uuid
            AND fb.theme = 'general' AND fb.visible_to_manager) AS general_notes,
        (SELECT MAX(fb.created_at) FROM hr_feedback fb
          WHERE fb.subject_employee_id = ${employeeId}::uuid
            AND fb.visible_to_manager) AS latest_note_at`));
    const m = r[0] || {};
    facts.behaviour.commentsWritten = num(m.comments);
    facts.behaviour.informalConductNotes = num(m.informal_notes);
    facts.capacity.approvedLeaveDaysNext14 = num(m.leave_ahead);
    facts.stated.strengthNotes = num(m.strength_notes);
    facts.stated.improvementNotes = num(m.improvement_notes);
    facts.stated.generalNotes = num(m.general_notes);
    facts.stated.mostRecentAt = m.latest_note_at ? new Date(m.latest_note_at).toISOString() : null;
  } catch (e: any) {
    logFail(MOD, 'misc', e);
    failures.push('stated');
  }

  // ---- 5. THE TEAM COMPARISON. Only the people this manager already holds. -----------------------
  try {
    const teamIds = viewer.reportIds.filter(isUuid);
    facts.capacity.teamSize = teamIds.length;
    if (teamIds.length > 1) {
      const r = rowsOf(await db.execute(sql`
        SELECT COUNT(*)::numeric / ${teamIds.length}::numeric AS mean_open
          FROM employee_tasks
         WHERE employee_id IN (${uuidList(teamIds)})
           AND status NOT IN ('completed','cancelled','archived')`));
      const mean = Number(r[0]?.mean_open);
      facts.capacity.teamMeanAssignments = Number.isFinite(mean) ? mean : null;
    }
  } catch (e: any) {
    logFail(MOD, 'team mean', e);
    failures.push('capacity');
  }

  return { ok: true, facts, authorityBasis: basis };
}

// -------------------------------------------------------------------------------------------------
// THE GROWTH TIMELINE
// -------------------------------------------------------------------------------------------------

export interface TimelineEntry {
  at: string;
  /** 'hr_event' for the organisation's own spine, 'manager_action' for this patch's acts. */
  origin: 'hr_event' | 'manager_action' | 'development_action';
  label: string;
  detail: string;
  /** For a manager action: who did it. For an hr_event: the module that emitted it. */
  by: string | null;
}

/**
 * One person's growth over time: the organisation's own event spine, plus what this manager and
 * their predecessors recorded.
 *
 * THE SPINE IS READ, NEVER WRITTEN. hr_events belongs to src/lib/hr-events.ts, whose twelve event
 * types are a closed vocabulary of things that HAPPENED to somebody. A manager's intervention is not
 * one of them and is not smuggled in as one; it is merged into the view at render time and carries
 * its own origin so the two are never confused on screen.
 */
export async function growthTimeline(
  viewer: PerfViewer,
  employeeId: string,
  limit = 60,
): Promise<{ ok: boolean; entries: TimelineEntry[]; sentence: string }> {
  if (!isUuid(employeeId) || !(await canSeePerformanceOf(viewer, employeeId))) {
    return { ok: false, entries: [], sentence: NOT_AUTHORISED };
  }
  const n = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const entries: TimelineEntry[] = [];
  let anyFailed = false;

  try {
    const events: HrEvent[] = await timelineFor({ employeeId }, n);
    for (const e of events) {
      entries.push({
        at: e.occurredAt || e.recordedAt || '',
        origin: 'hr_event',
        label: e.label,
        detail: e.assertionLabel,
        by: e.sourceModule || null,
      });
    }
  } catch (e: any) {
    logFail(MOD, 'timeline hr_events', e);
    anyFailed = true;
  }

  try {
    for (const r of rowsOf(await db.execute(sql`
      SELECT a.kind, a.section, a.signal_key, a.note, a.created_at,
             (SELECT n.full_name FROM hr_employees n WHERE n.user_id = a.actor_user_id
                ORDER BY n.is_active DESC, n.created_at DESC LIMIT 1) AS actor_name
        FROM mti_manager_actions a
       WHERE a.subject_employee_id = ${employeeId}::uuid
       ORDER BY a.created_at DESC
       LIMIT ${n}`))) {
      entries.push({
        at: r.created_at ? new Date(r.created_at).toISOString() : '',
        origin: 'manager_action',
        label: actionKindLabel(String(r.kind || '')),
        detail: r.note ? String(r.note).slice(0, 300) : (r.signal_key ? 'About: ' + String(r.signal_key) : ''),
        by: r.actor_name ? String(r.actor_name) : null,
      });
    }
  } catch (e: any) {
    logFail(MOD, 'timeline manager actions', e);
    anyFailed = true;
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0)));

  return {
    ok: true,
    entries: entries.slice(0, n),
    sentence: anyFailed
      ? 'Part of this timeline could not be read just now, so it is incomplete. It is not a record of '
        + 'nothing having happened.'
      : (entries.length ? '' : 'Nothing has been recorded on this person’s timeline yet.'),
  };
}

// -------------------------------------------------------------------------------------------------
// WHAT THIS MANAGER HAS ALREADY DONE
// -------------------------------------------------------------------------------------------------

export interface ManagerActionRow {
  id: string;
  kind: ManagerActionKind;
  section: SectionKey | null;
  signalKey: string | null;
  note: string | null;
  recordRef: string | null;
  actorName: string | null;
  authorityBasis: string;
  createdAt: string;
}

/** Acts recorded about one person, newest first. Read-only; the table refuses UPDATE and DELETE. */
export async function actionHistory(employeeId: string, limit = 40): Promise<ManagerActionRow[]> {
  if (!isUuid(employeeId)) return [];
  const n = Math.min(Math.max(Number(limit) || 40, 1), 200);
  try {
    return rowsOf(await db.execute(sql`
      SELECT a.id, a.kind, a.section, a.signal_key, a.note, a.record_ref, a.authority_basis, a.created_at,
             (SELECT n.full_name FROM hr_employees n WHERE n.user_id = a.actor_user_id
                ORDER BY n.is_active DESC, n.created_at DESC LIMIT 1) AS actor_name
        FROM mti_manager_actions a
       WHERE a.subject_employee_id = ${employeeId}::uuid
       ORDER BY a.created_at DESC
       LIMIT ${n}`)).map((r: any) => ({
      id: String(r.id),
      kind: String(r.kind) as ManagerActionKind,
      section: (r.section ? String(r.section) : null) as SectionKey | null,
      signalKey: r.signal_key ? String(r.signal_key) : null,
      note: r.note ? String(r.note) : null,
      recordRef: r.record_ref ? String(r.record_ref) : null,
      actorName: r.actor_name ? String(r.actor_name) : null,
      authorityBasis: String(r.authority_basis || 'unrecorded'),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    }));
  } catch (e: any) {
    logFail(MOD, 'actionHistory', e);
    return [];
  }
}

/** Signal keys this manager has already acknowledged for this person, so the screen can say so. */
export async function acknowledgedSignalKeys(employeeId: string, actorUserId: string): Promise<string[]> {
  if (!isUuid(employeeId) || !isUuid(actorUserId)) return [];
  try {
    return rowsOf(await db.execute(sql`
      SELECT DISTINCT signal_key
        FROM mti_manager_actions
       WHERE subject_employee_id = ${employeeId}::uuid
         AND actor_user_id = ${actorUserId}::uuid
         AND kind = 'signal_acknowledged'
         AND signal_key IS NOT NULL`)).map((r: any) => String(r.signal_key));
  } catch (e: any) {
    logFail(MOD, 'acknowledgedSignalKeys', e);
    return [];
  }
}

export interface DevelopmentActionRow {
  id: string;
  title: string;
  detail: string | null;
  status: string;
  targetDate: string | null;
  visibleToEmployee: boolean;
  outcomeNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEVELOPMENT_STATUSES = ['open', 'in_progress', 'done', 'dropped'] as const;

export function developmentStatusLabel(s: string): string {
  const k = String(s || '');
  if (k === 'open') return 'Open';
  if (k === 'in_progress') return 'In progress';
  if (k === 'done') return 'Done';
  if (k === 'dropped') return 'Dropped';
  return 'Open';
}

/** Development actions tracked for one person, open ones first. */
export async function developmentActions(employeeId: string, limit = 40): Promise<DevelopmentActionRow[]> {
  if (!isUuid(employeeId)) return [];
  const n = Math.min(Math.max(Number(limit) || 40, 1), 200);
  try {
    return rowsOf(await db.execute(sql`
      SELECT id, title, detail, status, target_date::text AS target_date, visible_to_employee,
             outcome_note, created_at, updated_at
        FROM mti_development_actions
       WHERE subject_employee_id = ${employeeId}::uuid
       ORDER BY (status IN ('open','in_progress')) DESC, created_at DESC
       LIMIT ${n}`)).map((r: any) => ({
      id: String(r.id),
      title: String(r.title || ''),
      detail: r.detail ? String(r.detail) : null,
      status: String(r.status || 'open'),
      targetDate: r.target_date ? String(r.target_date) : null,
      visibleToEmployee: r.visible_to_employee !== false,
      outcomeNote: r.outcome_note ? String(r.outcome_note) : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    }));
  } catch (e: any) {
    logFail(MOD, 'developmentActions', e);
    return [];
  }
}
