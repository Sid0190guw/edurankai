// src/lib/hr/scheduled.ts — the recurring HR work, and the handler that has to exist before a
// scheduler entry is allowed to point at it.
//
// WHY THIS FILE EXISTS. src/lib/attendance-lapse.ts detects people who have stopped appearing:
// consecutive working days with no record of presence, warnings at day 5 and 7, a lapse at day 9.
// It is complete, it has its own test suite, and NOTHING CALLED IT. There was no route, no job and
// no scheduler entry — the detection ran when a human opened a screen, which is the one moment it is
// least needed, because by then somebody has already noticed.
//
// THE ORDER MATTERS AND IT IS THE POINT. A cron entry pointing at a handler that does not exist is a
// guaranteed nightly failure and is worse than no entry: it fills the ops view with red that nobody
// can act on and trains people to ignore it. So the handler is written and tested here first, and
// the schedule is added afterwards.
//
// IT WARNS. IT DOES NOT PAUSE. attendance-lapse.ts separates assessAll() (writes nothing) from
// pauseProfile() (suspends somebody's access) deliberately, and says so in its own comments: the
// preview exists so a human can see who the rule WOULD pause before anybody lets it fire. A cron
// that quietly suspended people at 3am would destroy that distinction, and the first anyone would
// know is a person unable to sign in with no conversation having happened. The sweep therefore
// raises a flag and notifies; suspending remains a human act on a human screen.

import {
  DEFAULT_LAPSE_DAYS,
  WARN_AT_DAYS,
  assessAll,
  type LapseAssessment,
} from '@/lib/attendance-lapse';

/**
 * NOT A NEW BREACH TYPE, DELIBERATELY.
 *
 * BREACH_TYPES in hr-flags.ts is annotated "exact strings from policy v2.0" — it mirrors a written
 * policy document, and inventing an `attendance_lapse` entry here would be inventing policy from a
 * code file, complete with a severity level and a disciplinary action nobody agreed.
 *
 * `hours_breach` is Level 1, "Counselling session · Written warning", and it is already what
 * warnShortWeek() raises for the neighbouring short-week case. An absence and a short week are the
 * same conversation at different magnitudes. The dedup marker in the description keeps the two
 * distinguishable in a query.
 */
const BREACH_TYPE = 'hours_breach' as const;

export interface LapseNotice {
  employeeId: string;
  days: number;
  /** 'warning' at a WARN_AT_DAYS boundary, 'lapsed' once the threshold is reached. */
  kind: 'warning' | 'lapsed';
  /** Stable per employee and per day-count, so the same notice is never raised twice. */
  dedupKey: string;
  summary: string;
}

/**
 * Which assessments deserve a notice, and what to say. PURE — no database, no clock.
 *
 * The whole judgement of the sweep lives here so it can be tested against fixtures rather than
 * against production data, and so the boundary rule is visible in one place.
 *
 * NOTICES FIRE ONLY ON A BOUNDARY DAY. Somebody at day 6 gets nothing: they were told at day 5 and
 * they will be told again at 7. Warning on every day between would turn a signal into a daily
 * irritation, and an irritation is something people filter.
 *
 * A SKIPPED ASSESSMENT PRODUCES NO NOTICE. `skipped` means the module could not judge this person —
 * no engagement record, no expected days. Warning somebody on the strength of an assessment that
 * explicitly declined to assess them is how an absence rule punishes a data-entry gap.
 */
export function lapseNoticesFor(
  assessments: readonly LapseAssessment[],
  threshold: number = DEFAULT_LAPSE_DAYS,
): LapseNotice[] {
  const out: LapseNotice[] = [];
  for (const a of assessments) {
    if (!a || a.skipped) continue;
    if (a.state === 'clear') continue;

    if (a.state === 'lapsed' || a.days >= threshold) {
      out.push({
        employeeId: a.employeeId,
        days: a.days,
        kind: 'lapsed',
        dedupKey: `lapse:${a.employeeId}:${a.days}`,
        summary:
          `No record of presence for ${a.days} consecutive working days, against a threshold of ${threshold}. `
          + 'This is a prompt for a conversation, not a finding: an unrecorded holiday, a clock-in that did not '
          + 'save and somebody genuinely absent look identical from here. Access has NOT been changed.',
      });
      continue;
    }

    if (WARN_AT_DAYS.includes(a.days)) {
      out.push({
        employeeId: a.employeeId,
        days: a.days,
        kind: 'warning',
        dedupKey: `lapse:${a.employeeId}:${a.days}`,
        summary:
          `No record of presence for ${a.days} consecutive working days. A warning at day ${a.days}; `
          + `the threshold is ${threshold}.`,
      });
    }
  }
  return out;
}

export interface SweepReport {
  ok: boolean;
  assessed: number;
  warned: number;
  lapsed: number;
  raised: number;
  /** Notices skipped because the identical one already exists. Not a failure. */
  alreadyRaised: number;
  failed: number;
  errors: string[];
}

/**
 * The scheduled sweep. Assess everyone, raise a flag for anyone at a boundary, change nothing else.
 *
 * Returns counts shaped for cron telemetry, so /admin/ops can distinguish "swept 200 people, nothing
 * to report" (skipped) from "swept 200, raised 3" (success) from "swept 200, 2 flags would not
 * write" (partial). Those are three different situations and one boolean cannot tell them apart.
 */
export async function runAttendanceLapseSweep(
  threshold: number = DEFAULT_LAPSE_DAYS,
): Promise<SweepReport> {
  const report: SweepReport = { ok: true, assessed: 0, warned: 0, lapsed: 0, raised: 0, alreadyRaised: 0, failed: 0, errors: [] };

  const { rows, error } = await assessAll(threshold);
  if (error) {
    // A FAILED ASSESSMENT IS NOT AN EMPTY ONE. Returning zeros here would tell the ops view that
    // nobody is absent, which is the calm-zero-over-a-failed-read mistake this codebase keeps
    // writing down.
    report.ok = false;
    report.errors.push('Assessment could not run: ' + error);
    return report;
  }
  report.assessed = rows.length;

  const notices = lapseNoticesFor(rows, threshold);
  report.warned = notices.filter((n) => n.kind === 'warning').length;
  report.lapsed = notices.filter((n) => n.kind === 'lapsed').length;
  if (!notices.length) return report;

  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  const { raiseFlag } = await import('@/lib/hr-flags');
  const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

  for (const n of notices) {
    try {
      // Dedup the same way warnShortWeek() does — by looking for the marker in an existing flag —
      // rather than keeping a second bookkeeping table that could disagree with the flags people
      // actually see.
      const marker = '[' + n.dedupKey + ']';
      const already = rowsOf(await db.execute(sql`
        SELECT 1 FROM hr_employee_flags
         WHERE employee_id = ${n.employeeId}::uuid
           AND breach_type = ${BREACH_TYPE}
           AND description LIKE ${'%' + marker + '%'}
         LIMIT 1`));
      if (already.length) { report.alreadyRaised++; continue; }

      const f = await raiseFlag({
        employeeId: n.employeeId,
        breachType: BREACH_TYPE,
        description: n.summary + ' ' + marker,
        actionTaken: n.kind === 'lapsed'
          ? 'Flagged for review. Access is unchanged — suspending a profile is a human decision taken on the attendance screen, never by this sweep.'
          : 'Warning raised. Speak to them before it becomes a pattern.',
        flaggedByName: 'Attendance monitor (scheduled sweep)',
      });
      if (f.ok) report.raised++;
      else {
        report.failed++;
        report.errors.push(`${n.employeeId}: ${f.error || 'flag not raised'}`);
      }
    } catch (e: any) {
      report.failed++;
      report.errors.push(`${n.employeeId}: ${e?.cause?.message || e?.message || 'unknown error'}`);
    }
  }

  report.ok = report.failed === 0;
  return report;
}
