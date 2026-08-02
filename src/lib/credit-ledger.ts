// src/lib/credit-ledger.ts — reads real attendance and turns it into credit.
//
// The arithmetic lives in credit-hours.ts and is tested there. This module only does the mapping:
// pull hr_attendance and hr_leave_request for one employee, decide what each day WAS, and hand the
// result to summarise(). Keeping the two apart means the rules can be reasoned about without a
// database, and this file can be read for whether it maps correctly rather than whether it counts
// correctly.
//
// PRIOR NOTICE is derived, never trusted to a flag: leave counts as authorised only when an
// APPROVED request exists whose requested_at is strictly before its start_date. A request filed on
// or after the day it covers is not prior notice, however it was later approved — which is the
// whole point of the rule. hr_attendance's own 'on_leave' status is not sufficient on its own,
// because an admin marking the grid says nothing about whether notice was given.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  summarise, completionFigures, remainingWeeks,
  type AttendanceDay, type DayStatus, type EngagementTerms, type CreditSummary, type ReviewEntry,
} from '@/lib/credit-hours';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

/** Approved leave, with whether it was notified before it started. */
interface LeaveWindow { start: string; end: string; noticeGivenAt: string | null; }

async function approvedLeave(employeeId: string): Promise<LeaveWindow[]> {
  try {
    return rows(await db.execute(sql`
      SELECT start_date, end_date, requested_at
      FROM hr_leave_request
      WHERE employee_id = ${employeeId} AND status = 'approved'
      ORDER BY start_date ASC`)).map((r: any) => {
        const start = iso(r.start_date);
        const requested = iso(r.requested_at);
        return {
          start,
          end: iso(r.end_date),
          // Strictly before: a request filed on the morning of the absence is not prior notice.
          noticeGivenAt: requested && start && requested < start ? requested : null,
        };
      });
  } catch { return []; }
}

const covers = (w: LeaveWindow, date: string) => !!w.start && date >= w.start && date <= (w.end || w.start);

/**
 * Map one stored attendance row to a credit-bearing day.
 *
 * hr_attendance uses: present | wfh | on_leave | absent | holiday.
 *  - wfh is ordinary attendance; where someone sat is not a credit question.
 *  - on_leave splits on whether an approved, notified request covers the date.
 *  - absent with a notified approved request is still authorised — the grid may simply not have
 *    been updated, and punishing an administrative gap would be wrong.
 *  - absent otherwise is unauthorised, which is what makes the notice rule mean anything.
 */
function statusFor(row: any, leave: LeaveWindow[]): { status: DayStatus; noticeGivenAt: string | null } {
  const date = iso(row.date);
  const win = leave.find((w) => covers(w, date));
  const notified = win?.noticeGivenAt || null;
  const raw = String(row.status || 'present');

  if (raw === 'holiday') return { status: 'holiday', noticeGivenAt: null };
  if (raw === 'present' || raw === 'wfh') return { status: 'present', noticeGivenAt: null };
  if (raw === 'on_leave' || raw === 'absent') {
    if (win && notified) return { status: 'authorised-leave', noticeGivenAt: notified };
    // Covered by an approved request but filed too late, or not covered at all.
    if (win) return { status: 'authorised-leave', noticeGivenAt: null };  // flagged as a notice breach
    return { status: 'unauthorised-leave', noticeGivenAt: null };
  }
  return { status: 'present', noticeGivenAt: null };
}

export interface LedgerResult {
  summary: CreditSummary;
  days: AttendanceDay[];
  weeksRemaining: number | null;
}

/**
 * Stored attendance rows -> credit-bearing days. Shared by the single and bulk readers so the
 * notice rule cannot be applied one way on a person's own page and another way on a console.
 */
function toDays(attRows: any[], leave: LeaveWindow[]): AttendanceDay[] {
  return attRows.map((r: any) => {
    const { status, noticeGivenAt } = statusFor(r, leave);
    const h = r.work_hours == null ? undefined : Number(r.work_hours);
    return {
      date: iso(r.date),
      status,
      // Only pass hours for days actually worked; a stored 0 on a leave day would otherwise read
      // as "worked zero hours" rather than "did not work".
      hours: (status === 'present' && Number.isFinite(h) && (h as number) > 0) ? h : undefined,
      noticeGivenAt,
    };
  });
}

/**
 * The credit position for one employee.
 *
 * Terms come from the caller because they are contractual — hours agreed, days per week, the
 * requirement — and guessing them would misstate what someone signed up to.
 */
export async function ledgerFor(employeeId: string, terms: EngagementTerms): Promise<LedgerResult> {
  const empty: LedgerResult = { summary: summarise([], terms), days: [], weeksRemaining: null };
  if (!employeeId) return empty;
  try {
    const leave = await approvedLeave(employeeId);
    const att = rows(await db.execute(sql`
      SELECT date, status, work_hours
      FROM hr_attendance WHERE employee_id = ${employeeId}
      ORDER BY date ASC LIMIT 2000`));

    const days = toDays(att, leave);
    const summary = summarise(days, terms);
    return { summary, days, weeksRemaining: remainingWeeks(summary, terms) };
  } catch {
    return empty;
  }
}

/**
 * The credit position for MANY employees, in two queries.
 *
 * ledgerFor() is per-person by design and right for a person's own page. A console looking at a
 * whole cohort would run two queries per head — and termsFor() adds four ALTER statements on top of
 * each — which is how an overview screen becomes the slowest page in the product. This reads the
 * same two tables once and hands every employee's days to the SAME statusFor()/summarise() pair, so
 * a figure shown to HR is the figure the intern sees on their own page.
 *
 * Terms come from the caller, per employee, for the same reason as ledgerFor(): they are
 * contractual, and one intern's agreed load says nothing about another's.
 *
 * The caller must pass a BOUNDED list — there is no LIMIT here, because a LIMIT across a multi-
 * employee result would silently truncate the last person's history and understate their credit.
 * An employee with no rows comes back with an honest empty summary rather than being absent.
 */
export async function ledgerForMany(
  input: { employeeId: string; terms: EngagementTerms }[],
): Promise<Map<string, LedgerResult>> {
  const out = new Map<string, LedgerResult>();
  const wanted = input.filter((i) => i && i.employeeId);
  for (const i of wanted) {
    out.set(String(i.employeeId), { summary: summarise([], i.terms), days: [], weeksRemaining: null });
  }
  if (!wanted.length) return out;

  const ids = wanted.map((i) => String(i.employeeId));
  if (ids.length > 200) {
    console.warn('[credit-ledger] ledgerForMany called with', ids.length, 'employees — bound the list at the caller');
  }

  try {
    // ::text on both sides so this works whether employee_id is stored as uuid or as text. Never
    // cast the other way: ::uuid throws on anything that is not one and takes the page down.
    const leaveBy = new Map<string, LeaveWindow[]>();
    for (const r of rows(await db.execute(sql`
      SELECT employee_id, start_date, end_date, requested_at
      FROM hr_leave_request
      WHERE employee_id::text = ANY(${ids}) AND status = 'approved'
      ORDER BY start_date ASC`))) {
      const key = String(r.employee_id);
      const start = iso(r.start_date);
      const requested = iso(r.requested_at);
      const list = leaveBy.get(key) || [];
      // Strictly before: a request filed on the morning of the absence is not prior notice.
      list.push({ start, end: iso(r.end_date), noticeGivenAt: requested && start && requested < start ? requested : null });
      leaveBy.set(key, list);
    }

    const attBy = new Map<string, any[]>();
    for (const r of rows(await db.execute(sql`
      SELECT employee_id, date, status, work_hours
      FROM hr_attendance
      WHERE employee_id::text = ANY(${ids})
      ORDER BY employee_id ASC, date ASC`))) {
      const key = String(r.employee_id);
      const list = attBy.get(key) || [];
      list.push(r);
      attBy.set(key, list);
    }

    for (const { employeeId, terms } of wanted) {
      const key = String(employeeId);
      const days = toDays(attBy.get(key) || [], leaveBy.get(key) || []);
      const summary = summarise(days, terms);
      out.set(key, { summary, days, weeksRemaining: remainingWeeks(summary, terms) });
    }
    return out;
  } catch (e: any) {
    // Every employee is already seeded with an empty summary above, so a failure here reads as
    // "nothing recorded" rather than dropping people off the list entirely. The caller is expected
    // to say on screen that the figures could not be read.
    console.error('[credit-ledger] ledgerForMany', e?.cause?.message || e?.message);
    return out;
  }
}

/**
 * Ensure the runtime term columns exist.
 *
 * Extracted from termsFor so a caller that needs the terms of a whole team can pay the four DDL
 * statements ONCE and then read the columns in its own query. Calling termsFor in a loop over a
 * department runs four ALTERs per person, and ALTER TABLE takes a lock on hr_employees even when it
 * is a no-op — sixty of them on one page load is not a page load, it is an outage waiting for a
 * busy afternoon.
 */
export async function ensureTermColumns(): Promise<void> {
  for (const [col, type] of [
    ['engagement_kind', "TEXT NOT NULL DEFAULT 'full-time'"],
    ['weekly_hours', 'NUMERIC(5,2)'],
    ['working_days_per_week', 'INT'],
    ['required_credit_hours', 'INT'],
  ] as [string, string][]) {
    await db.execute(sql.raw(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS ${col} ${type}`)).catch(() => {});
  }
}

/**
 * One hr_employees row, read as the engagement terms it records.
 *
 * Exported so a caller that has already SELECTed the four columns for many people at once maps them
 * EXACTLY the way the completion letter does. A second reading of the same contract that disagreed
 * with the first would be worse than not offering one.
 */
export function termsFromRow(r: any): EngagementTerms {
  const kind = r?.engagement_kind === 'part-time' ? 'part-time' : 'full-time';
  return {
    kind,
    // Left undefined rather than defaulted for part-time: weeklyHoursFor() resolves an unstated
    // part-time load to 0 on purpose, so a missing contract shows as missing instead of being
    // quietly invented.
    weeklyHours: r?.weekly_hours == null ? (kind === 'full-time' ? 40 : undefined) : Number(r.weekly_hours),
    workingDaysPerWeek: r?.working_days_per_week == null ? 5 : Number(r.working_days_per_week),
    requiredCreditHours: r?.required_credit_hours == null ? undefined : Number(r.required_credit_hours),
  };
}

/**
 * The engagement terms agreed with one employee.
 *
 * Stored per-employee rather than inferred from their role, because two interns on the same role
 * can be on different loads, and the completion letter must state what THIS person agreed to.
 * Columns are added at runtime, matching the pattern used elsewhere in this codebase.
 */
export async function termsFor(employeeId: string): Promise<EngagementTerms> {
  // A sane default only for the shape; the real numbers come from the row when set.
  const fallback: EngagementTerms = { kind: 'full-time', workingDaysPerWeek: 5 };
  if (!employeeId) return fallback;
  try {
    await ensureTermColumns();
    const r = rows(await db.execute(sql`
      SELECT engagement_kind, weekly_hours, working_days_per_week, required_credit_hours
      FROM hr_employees WHERE id = ${employeeId} LIMIT 1`))[0];
    if (!r) return fallback;
    return termsFromRow(r);
  } catch { return fallback; }
}

export async function setTermsFor(employeeId: string, t: EngagementTerms): Promise<void> {
  await termsFor(employeeId);   // ensures the columns exist
  await db.execute(sql`
    UPDATE hr_employees SET
      engagement_kind = ${t.kind},
      weekly_hours = ${t.weeklyHours ?? null},
      working_days_per_week = ${t.workingDaysPerWeek ?? 5},
      required_credit_hours = ${t.requiredCreditHours ?? null}
    WHERE id = ${employeeId}`);
}

/** Reviews recorded against an employee, newest first, for the offboarding report. */
export async function reviewsFor(employeeId: string): Promise<ReviewEntry[]> {
  if (!employeeId) return [];
  try {
    // Self-bootstrapping so the feature works before any migration is run by hand.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id UUID NOT NULL,
      reviewer_name TEXT,
      reviewer_id UUID,
      rating INT,
      note TEXT NOT NULL DEFAULT '',
      period TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
    await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_reviews_emp_idx ON hr_reviews (employee_id, created_at DESC)`).catch(() => {});

    return rows(await db.execute(sql`
      SELECT created_at, reviewer_name, rating, note FROM hr_reviews
      WHERE employee_id = ${employeeId} ORDER BY created_at DESC LIMIT 200`))
      .map((r: any) => ({
        date: iso(r.created_at),
        reviewer: r.reviewer_name || 'Reviewer',
        rating: r.rating == null ? null : Number(r.rating),
        note: r.note || '',
      }));
  } catch { return []; }
}

/** Everything the completion letter and offboarding report state, in one call. */
export async function completionFor(input: {
  employeeId: string; name: string; role: string;
  startDate: string; endDate: string; terms: EngagementTerms; achievements?: string[];
}) {
  const [{ summary }, reviews] = await Promise.all([
    ledgerFor(input.employeeId, input.terms),
    reviewsFor(input.employeeId),
  ]);
  return {
    summary,
    reviews,
    figures: completionFigures({
      name: input.name, role: input.role,
      startDate: input.startDate, endDate: input.endDate,
      terms: input.terms, summary, reviews,
      achievements: input.achievements || [],
    }),
  };
}
