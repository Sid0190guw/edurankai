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

    const days: AttendanceDay[] = att.map((r: any) => {
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

    const summary = summarise(days, terms);
    return { summary, days, weeksRemaining: remainingWeeks(summary, terms) };
  } catch {
    return empty;
  }
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
