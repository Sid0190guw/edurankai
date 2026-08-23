// src/lib/horizon/report/providers/time.ts — ATTENDANCE, LEAVE AND LOGGED HOURS.
//
// WHY THIS RETURNS AGGREGATES AND ALMOST NO ROWS.
//
// A quarter of attendance is ninety rows. Printing ninety rows about one person is not a report, it
// is a surveillance log with a title on it, and the programme rules forbid exactly that. What a
// manager needs to know is how many days were worked, how many were leave, and where the record has
// holes in it. So the facts here are the boundaries of the window and the exceptions; the numbers
// are derived, and each one states its denominator.
//
// hr_clock_events IS NOT READ, AND THAT IS THE POINT WORTH READING TWICE. It holds lat, lon,
// accuracy, ip_address, device_info and face_photo for every punch. All of it is legitimately
// collected for attendance and none of it is evidence about how somebody works. A report that
// printed where an employee was standing when they clocked in would be the hidden-surveillance
// failure the rules name, arrived at honestly, one useful-looking column at a time. The relation is
// therefore absent from the descriptor below, so no future edit here can reach it without also
// declaring it — and the declaration is what a reviewer would see.
//
// THE GAP IS THE FINDING. An employee with twelve attendance rows in a ninety-day window has not
// worked twelve days; the other seventy-eight are unrecorded, and the difference between those two
// readings is somebody's performance conversation. `Days with no record at all` is therefore a
// first-class metric rather than something a reader is left to subtract.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { toRows } from '@/lib/page-safety';
import { CAPABILITIES } from '../registry';
import { derivedClaim, evidenceRef, factClaim, sourceRef } from '../provenance';
import type {
  DerivedClaim, FactClaim, HumanFeedbackClaim, SourceLoad, SourceLoadContext, SourceProvider,
} from '../types';

const PROVIDER_ID = 'hrms.time';
const SYSTEM = 'hrms';
const OWNER = 'Attendance and leave patches (db/hr-schema.sql, src/lib/hr-leave.ts)';

function src(table: string, recordId?: string | null, capturedAt?: string | null) {
  return sourceRef({ provider: PROVIDER_ID, system: SYSTEM, table, ownedBy: OWNER, recordId, capturedAt });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Calendar days in the window, inclusive. Used as the denominator every metric here needs. */
function windowDays(window: { from: string; to: string } | null): number {
  if (!window) return 0;
  const a = Date.parse(window.from);
  const b = Date.parse(window.to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
}

export const timeProvider: SourceProvider = {
  descriptor: {
    id: PROVIDER_ID,
    label: 'Attendance, leave and logged hours',
    system: SYSTEM,
    // hr_clock_events is deliberately absent. See the header.
    tables: ['hr_attendance', 'hr_leave_request', 'hr_time_logs'],
    ownedBy: OWNER,
    capabilities: [CAPABILITIES.TIME_ATTENDANCE, CAPABILITIES.TIME_LEAVE, CAPABILITIES.TIME_LOGS],
    sensitivity: 'standard',
  },

  async load(ctx: SourceLoadContext): Promise<SourceLoad> {
    const facts: FactClaim[] = [];
    const derived: DerivedClaim[] = [];
    const humanFeedback: HumanFeedbackClaim[] = [];
    const notes: string[] = [];

    if (ctx.subject.kind !== 'employee' && ctx.subject.kind !== 'manager') {
      return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes: ['Not an employment subject.'], error: null };
    }

    const employeeId = ctx.subject.id;
    const now = ctx.now;
    const stamp = ctx.stamp;
    const want = new Set(ctx.capabilities);
    const from = ctx.window ? ctx.window.from : null;
    const to = ctx.window ? ctx.window.to : null;
    const span = windowDays(ctx.window);

    if (!ctx.window) {
      notes.push('This report declares no window, so time measures cover everything on record and cannot state a coverage rate.');
    }

    // ---------------------------------------------------------------------------------------
    // ATTENDANCE
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.TIME_ATTENDANCE)) {
      // ONE ROUND TRIP, NOT SIX. The function region and the database region differ on this
      // deployment; a round trip costs well over a hundred milliseconds and the count of them is the
      // lever, not the size of any one result. Six FILTERed aggregates in a single SELECT cost the
      // database nothing extra over one.
      const rows = toRows(await db.execute(sql`
        SELECT COUNT(*)::int                                                    AS recorded_days,
               COUNT(*) FILTER (WHERE status = 'present')::int                  AS present_days,
               COUNT(*) FILTER (WHERE status = 'wfh')::int                      AS wfh_days,
               COUNT(*) FILTER (WHERE status = 'on_leave')::int                 AS leave_days,
               COUNT(*) FILTER (WHERE status = 'absent')::int                   AS absent_days,
               COALESCE(SUM(work_hours), 0)::float                              AS work_hours,
               COALESCE(SUM(overtime_hours), 0)::float                          AS overtime_hours,
               MIN(date)::text                                                  AS first_day,
               MAX(date)::text                                                  AS last_day
          FROM hr_attendance
         WHERE employee_id = ${employeeId}::uuid
           AND (${from}::date IS NULL OR date >= ${from}::date)
           AND (${to}::date IS NULL OR date <= ${to}::date)`));
      const r: any = rows[0] || {};
      const recorded = num(r.recorded_days);
      const ev = [evidenceRef('attendance_window', employeeId + ':' + String(from || 'all') + ':' + String(to || 'all'),
        'Attendance rows for this person across the window')];

      if (recorded === 0) {
        notes.push('No attendance is recorded for this person in the window. That is an absence of records, not an absence of work.');
      } else {
        facts.push(factClaim({
          label: 'Attendance recorded between',
          value: String(r.first_day) + ' and ' + String(r.last_day),
          now, stamp, sources: [src('hr_attendance')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Days with an attendance record', value: recorded, unit: span ? 'of ' + span + ' calendar days' : null,
          basisCount: recorded, window: ctx.window, major: true,
          method: 'Count of hr_attendance rows in the window. Calendar days, so weekends and holidays are included in the denominator.',
          now, stamp, sources: [src('hr_attendance')], evidence: ev,
        }));
        if (span > 0) {
          // THE HOLE IN THE RECORD, STATED AS ITS OWN NUMBER. See the header.
          derived.push(derivedClaim({
            label: 'Calendar days with no attendance record at all', value: Math.max(0, span - recorded),
            unit: 'days', basisCount: span, window: ctx.window,
            method: 'Calendar days in the window minus days with an hr_attendance row. Unrecorded days are not absences: weekends, holidays and days the system was not used all land here.',
            now, stamp, sources: [src('hr_attendance')], evidence: ev,
          }));
        }
        derived.push(derivedClaim({
          label: 'Days marked present or working from home', value: num(r.present_days) + num(r.wfh_days),
          unit: 'of ' + recorded + ' recorded days', basisCount: recorded, window: ctx.window,
          method: 'Count of hr_attendance rows with status present or wfh, over rows in the window.',
          now, stamp, sources: [src('hr_attendance')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Days marked absent', value: num(r.absent_days), unit: 'of ' + recorded + ' recorded days',
          basisCount: recorded, window: ctx.window,
          method: 'Count of hr_attendance rows with status absent. An absent marking is somebody a record was written about, not a conclusion about them.',
          now, stamp, sources: [src('hr_attendance')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Hours recorded against attendance', value: Number(num(r.work_hours).toFixed(1)), unit: 'hours',
          basisCount: recorded, window: ctx.window,
          method: 'Sum of hr_attendance.work_hours across the window.',
          now, stamp, sources: [src('hr_attendance')], evidence: ev,
        }));
        if (num(r.overtime_hours) > 0) {
          derived.push(derivedClaim({
            label: 'Overtime hours recorded', value: Number(num(r.overtime_hours).toFixed(1)), unit: 'hours',
            basisCount: recorded, window: ctx.window,
            method: 'Sum of hr_attendance.overtime_hours across the window.',
            now, stamp, sources: [src('hr_attendance')], evidence: ev,
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // LEAVE
    // ---------------------------------------------------------------------------------------
    //
    // THE REASON COLUMN IS NOT READ. hr_leave_request.reason is free text an employee wrote to their
    // manager, and it is where "hospital appointment" and worse live. It is not job-related evidence
    // and it is not this document's business. The TYPE is read, and even that is only the coarse
    // casual/sick/earned/unpaid vocabulary the leave module already shows on its own screens.
    if (want.has(CAPABILITIES.TIME_LEAVE)) {
      const rows = toRows(await db.execute(sql`
        SELECT COUNT(*)::int                                              AS requests,
               COUNT(*) FILTER (WHERE status = 'approved')::int           AS approved,
               COUNT(*) FILTER (WHERE status = 'pending')::int            AS pending,
               COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0)::int AS approved_days
          FROM hr_leave_request
         WHERE employee_id = ${employeeId}::uuid
           AND (${from}::date IS NULL OR start_date >= ${from}::date)
           AND (${to}::date IS NULL OR start_date <= ${to}::date)`));
      const r: any = rows[0] || {};
      const requests = num(r.requests);
      const ev = [evidenceRef('leave_window', employeeId + ':' + String(from || 'all'), 'Leave requests across the window')];
      if (requests === 0) {
        notes.push('No leave was requested in the window.');
      } else {
        derived.push(derivedClaim({
          label: 'Approved leave taken', value: num(r.approved_days), unit: 'days',
          basisCount: num(r.approved), window: ctx.window,
          method: 'Sum of hr_leave_request.days across approved requests starting inside the window. Approved leave is time the organisation agreed to.',
          now, stamp, sources: [src('hr_leave_request')], evidence: ev,
        }));
        if (num(r.pending) > 0) {
          facts.push(factClaim({
            label: 'Leave requests still awaiting a decision', value: String(num(r.pending)),
            now, stamp, sources: [src('hr_leave_request')], evidence: ev,
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // LOGGED HOURS
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.TIME_LOGS)) {
      const rows = toRows(await db.execute(sql`
        SELECT COUNT(*)::int                          AS entries,
               COUNT(DISTINCT log_date)::int          AS days_logged,
               COALESCE(SUM(hours), 0)::float         AS hours
          FROM hr_time_logs
         WHERE employee_id = ${employeeId}::uuid
           AND (${from}::date IS NULL OR log_date >= ${from}::date)
           AND (${to}::date IS NULL OR log_date <= ${to}::date)`));
      const r: any = rows[0] || {};
      const entries = num(r.entries);
      if (entries === 0) {
        notes.push('No time was logged in the window. Logging is not mandatory here, so this says nothing about hours worked.');
      } else {
        const ev = [evidenceRef('time_log_window', employeeId + ':' + String(from || 'all'), 'Time log entries across the window')];
        derived.push(derivedClaim({
          label: 'Hours logged against tasks', value: Number(num(r.hours).toFixed(1)), unit: 'hours',
          basisCount: entries, window: ctx.window,
          method: 'Sum of hr_time_logs.hours in the window. Self-logged: this is what the person recorded, not what a system observed.',
          now, stamp, sources: [src('hr_time_logs')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Days on which time was logged', value: num(r.days_logged), unit: 'days',
          basisCount: entries, window: ctx.window,
          method: 'Count of distinct hr_time_logs.log_date values in the window.',
          now, stamp, sources: [src('hr_time_logs')], evidence: ev,
        }));
      }
    }

    return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes, error: null };
  },
};
