import { describe, it, expect } from 'vitest';
import {
  FULL_TIME_WEEKLY_HOURS, weeklyHoursFor, weeklyHoursKnown, loadFraction, expectedDailyHours,
  summarise, remainingWeeks, completionFigures,
  type AttendanceDay, type EngagementTerms,
} from './credit-hours';

// A RECORDED full-time contract. weeklyHours is now STATED, because an engagement that does not
// state one is unknown rather than 40 — see weeklyHoursFor(). Every fixture below that means "a
// real full-time week" has to say so, which is the point of the change.
const FULL: EngagementTerms = { kind: 'full-time', weeklyHours: 40, workingDaysPerWeek: 5, requiredCreditHours: 480 };
/** The same engagement with nobody having recorded the week. Unknown, never 40. */
const UNSTATED: EngagementTerms = { kind: 'full-time', workingDaysPerWeek: 5, requiredCreditHours: 480 };
const HALF: EngagementTerms = { kind: 'part-time', weeklyHours: 20, workingDaysPerWeek: 5, requiredCreditHours: 480 };
const day = (status: AttendanceDay['status'], extra: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({ date: '2026-01-01', status, ...extra });

/**
 * A worked day WITH ITS HOURS RECORDED. Every test below that means "somebody worked a full day"
 * uses this, because a day with no recorded hours is now credited nothing at all — see the
 * 'unmeasured days' block. Passing the hours is not test ceremony; it is the fact being asserted.
 */
const worked = (hours: number, extra: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({ date: '2026-01-01', status: 'present', hours, ...extra });

describe('engagement terms', () => {
  it('a full-time week is 40 hours', () => {
    expect(weeklyHoursFor(FULL)).toBe(FULL_TIME_WEEKLY_HOURS);
    expect(expectedDailyHours(FULL)).toBe(8);
  });

  it('part-time is pro-rata against the same 40', () => {
    expect(loadFraction(HALF)).toBe(0.5);
    expect(expectedDailyHours(HALF)).toBe(4);
  });

  it('FULL-TIME with no stated hours is 0, not 40', () => {
    // THE DEFAULT THAT STARTED THIS. `t.weeklyHours || FULL_TIME_WEEKLY_HOURS` handed a full-time
    // contract to every employee whose weekly hours had never been entered — and engagement_kind
    // itself defaults to 'full-time', so that was most of them. 0 means UNKNOWN.
    expect(weeklyHoursFor(UNSTATED)).toBe(0);
    expect(weeklyHoursKnown(UNSTATED)).toBe(false);
    expect(weeklyHoursKnown(FULL)).toBe(true);
  });

  it('an unknown week produces no expectation rather than a 0% attendance figure', () => {
    const s = summarise([day('present', { hours: 8 })], UNSTATED);
    expect(s.expectationKnown).toBe(false);
    expect(s.expectedHours).toBe(0);
    // The hours are real even when the contract is not on file, so they are NOT capped away.
    expect(s.creditHours).toBe(8);
  });

  it('part-time with no stated hours is 0, not a guess', () => {
    // Inventing a contract would silently misstate what someone agreed to.
    expect(weeklyHoursFor({ kind: 'part-time' })).toBe(0);
  });

  it('part-time cannot exceed a full-time week', () => {
    expect(weeklyHoursFor({ kind: 'part-time', weeklyHours: 60 })).toBe(40);
  });
});

describe('credit accrual', () => {
  it('a full-time week of RECORDED hours is 40 credit-hours', () => {
    const s = summarise(Array(5).fill(null).map(() => worked(8)), FULL);
    expect(s.creditHours).toBe(40);
    expect(s.attendancePct).toBe(100);
    expect(s.measuredDays).toBe(5);
    expect(s.unmeasuredDays).toBe(0);
  });

  it('the same five days part-time earn half the credit', () => {
    const s = summarise(Array(5).fill(null).map(() => worked(4)), HALF);
    expect(s.creditHours).toBe(20);
    expect(s.attendancePct).toBe(100);   // full attendance for THEIR agreed load
  });

  it('credits actual hours when recorded', () => {
    const s = summarise([day('present', { hours: 6 })], FULL);
    expect(s.creditHours).toBe(6);
    expect(s.expectedHours).toBe(8);
    expect(s.attendancePct).toBe(75);
  });

  it('caps a long day at the agreed hours', () => {
    // The letter should reflect the agreed engagement, not an unusually long day.
    const s = summarise([day('present', { hours: 14 })], FULL);
    expect(s.creditHours).toBe(8);
  });

  it('half-days credit the recorded hours and expect half', () => {
    const s = summarise([day('half-day', { hours: 4 })], FULL);
    expect(s.creditHours).toBe(4);
    expect(s.expectedHours).toBe(4);
    expect(s.attendancePct).toBe(100);
  });
});

// -------------------------------------------------------------------------------------------------
// THE CORRECTION. A ticked day is not eight hours.
// -------------------------------------------------------------------------------------------------
describe('days marked present with no hours recorded', () => {
  it('credits NOTHING, rather than the expected daily figure', () => {
    // This is the whole defect: `day('present')` used to be worth 8 credit-hours to a full-time
    // intern, so an HR grid tick became work on a completion letter.
    const s = summarise([day('present')], FULL);
    expect(s.creditHours).toBe(0);
    expect(s.expectedHours).toBe(8);
    expect(s.attendancePct).toBe(0);
  });

  it('names the days, so the gap can be fixed rather than argued about', () => {
    const s = summarise([
      worked(8),
      day('present', { date: '2026-01-02' }),
      day('half-day', { date: '2026-01-03' }),
    ], FULL);
    expect(s.creditHours).toBe(8);
    expect(s.measuredDays).toBe(1);
    expect(s.unmeasuredDays).toBe(2);
    expect(s.unmeasuredDates).toEqual(['2026-01-02', '2026-01-03']);
  });

  it('still counts them as days present, because the person WAS there', () => {
    const s = summarise([day('present')], FULL);
    expect(s.daysPresent).toBe(1);   // attendance is a different fact from measured hours
  });

  it('treats a recorded zero the same as no figure at all', () => {
    // A stored 0 is not evidence that somebody worked zero hours; it is an empty column.
    const s = summarise([day('present', { hours: 0 })], FULL);
    expect(s.creditHours).toBe(0);
    expect(s.unmeasuredDays).toBe(1);
  });
});

describe('leave and the prior-notice rule', () => {
  it('authorised leave costs no credit AND no expectation, so attendance is undamaged', () => {
    const s = summarise([
      worked(8),
      day('authorised-leave', { noticeGivenAt: '2025-12-20' }),
    ], FULL);
    expect(s.creditHours).toBe(8);
    expect(s.expectedHours).toBe(8);      // the leave day is excused, not counted against them
    expect(s.attendancePct).toBe(100);
    expect(s.noticeBreaches).toBe(0);
  });

  it('unauthorised leave keeps the expectation, so it shows honestly', () => {
    const s = summarise([worked(8), day('unauthorised-leave')], FULL);
    expect(s.creditHours).toBe(8);
    expect(s.expectedHours).toBe(16);
    expect(s.attendancePct).toBe(50);
    expect(s.noticeBreaches).toBe(1);
  });

  it('flags leave marked authorised but with no notice recorded', () => {
    // Prior notice is mandatory; marking it authorised after the fact should still be visible.
    const s = summarise([day('authorised-leave')], FULL);
    expect(s.authorisedLeaveDays).toBe(1);
    expect(s.noticeBreaches).toBe(1);
  });

  it('holidays are neither credited nor expected', () => {
    const s = summarise([worked(8), day('holiday')], FULL);
    expect(s.expectedHours).toBe(8);
    expect(s.attendancePct).toBe(100);
  });

  it('not-started days are ignored, so a future engagement is not 0%', () => {
    const s = summarise([day('not-started'), day('not-started')], FULL);
    expect(s.expectedHours).toBe(0);
    expect(s.attendancePct).toBe(0);
    expect(s.daysPresent).toBe(0);
  });
});

describe('completion against the requirement', () => {
  it('reports shortfall against the required credit-hours', () => {
    const s = summarise(Array(10).fill(null).map(() => worked(8)), FULL);   // 80 hrs
    expect(s.completionPct).toBe(round(80 / 480 * 100));
    expect(s.shortfallHours).toBe(400);
  });

  it('part-time simply takes longer for the SAME requirement', () => {
    const s = summarise(Array(10).fill(null).map(() => worked(4)), HALF);   // 40 hrs
    expect(s.shortfallHours).toBe(440);
    expect(remainingWeeks(s, HALF)).toBe(22);   // 440 / 20
    // A full-timer needs half as many weeks for the identical requirement.
    const sf = summarise(Array(10).fill(null).map(() => worked(8)), FULL);
    expect(remainingWeeks(sf, FULL)).toBe(10);  // 400 / 40
  });

  it('returns 0 weeks remaining once the requirement is met', () => {
    const s = summarise(Array(60).fill(null).map(() => worked(8)), FULL);   // 480 hrs
    expect(s.shortfallHours).toBe(0);
    expect(remainingWeeks(s, FULL)).toBe(0);
  });
});

describe('completion letter figures', () => {
  const base = {
    name: 'A. Candidate', role: 'AI Intern',
    startDate: '2026-01-01', endDate: '2026-03-31',
    achievements: ['Shipped the ingest pipeline', '  ', 'Presented at the research seminar'],
  };

  it('averages only the reviews that carry a rating', () => {
    const s = summarise(Array(60).fill(null).map(() => worked(8)), FULL);
    const f = completionFigures({
      ...base, terms: FULL, summary: s,
      reviews: [
        { date: '2026-02-01', reviewer: 'Mentor', rating: 4, note: 'Strong' },
        { date: '2026-03-01', reviewer: 'Lead', rating: 5, note: 'Excellent' },
        { date: '2026-03-15', reviewer: 'Peer', note: 'No rating given' },
      ],
    });
    expect(f.averageRating).toBe(4.5);
    expect(f.reviewCount).toBe(3);      // all reviews counted, only rated ones averaged
  });

  it('drops blank achievements', () => {
    const s = summarise([worked(8)], FULL);
    const f = completionFigures({ ...base, terms: FULL, summary: s, reviews: [] });
    expect(f.achievements).toHaveLength(2);
  });

  it('states eligibility as a fact with a reason, not a bare boolean', () => {
    const short = summarise(Array(10).fill(null).map(() => worked(8)), FULL);
    const f = completionFigures({ ...base, terms: FULL, summary: short, reviews: [] });
    expect(f.eligible).toBe(false);
    expect(f.reason).toContain('400');
    expect(f.reason).toContain('480');
  });

  it('is eligible when no requirement was set', () => {
    const terms: EngagementTerms = { kind: 'full-time', weeklyHours: 40, workingDaysPerWeek: 5 };
    const s = summarise([worked(8)], terms);
    const f = completionFigures({ ...base, terms, summary: s, reviews: [] });
    expect(f.eligible).toBe(true);
    expect(f.reason).toContain('No credit-hour requirement');
  });
});

function round(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }
