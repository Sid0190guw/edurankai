// Tests for the weekly credit rule. The storage and the routing live in credit-week-ledger.ts and
// are not exercised here — this file is about the DECISION, which is the part that ends up next to
// somebody's name on a document an accredited partner reads.
//
// The two properties every test below is really defending:
//   1. NOTHING IS CREDITED THAT WAS NOT MEASURED.
//   2. NOTHING IS REFUSED BY ARITHMETIC. A week that falls short comes out 'pending', never
//      'refused' — only a person with a reason can refuse one.
import { describe, it, expect } from 'vitest';
import {
  weekStartOf, weekEndOf, weekStartsBetween, weekLabel,
  requiredWeeklyHours, decideCreditWeek, positionFrom, isCredited, isDecided,
  INTERN_WEEKLY_HOURS, HOURS_TOLERANCE,
  type WeekDay, type WeekMeasurementInput,
} from './credit-week';

const INTERN = requiredWeeklyHours({ employmentType: 'Intern', designation: 'AI Intern' });

/** A day that was worked, measured off the clock, with the report filed. */
const worked = (date: string, hours: number, extra: Partial<WeekDay> = {}): WeekDay => ({
  date, clockHours: hours, recordedHours: null, incomplete: false,
  worked: true, holiday: false, approvedLeaveUnits: 0, reportFiled: true, ...extra,
});

const off = (date: string, extra: Partial<WeekDay> = {}): WeekDay => ({
  date, clockHours: null, recordedHours: null, incomplete: false,
  worked: false, holiday: false, approvedLeaveUnits: 0, reportFiled: false, ...extra,
});

/** Six days at 6h40m each is exactly the 40-hour intern week. */
const FULL_WEEK: WeekDay[] = [
  worked('2026-03-02', 6.67), worked('2026-03-03', 6.67), worked('2026-03-04', 6.67),
  worked('2026-03-05', 6.67), worked('2026-03-06', 6.67), worked('2026-03-07', 6.65),
  off('2026-03-08'),
];

const input = (days: WeekDay[], over: Partial<WeekMeasurementInput> = {}): WeekMeasurementInput => ({
  employeeId: '00000000-0000-4000-8000-000000000001',
  weekStart: '2026-03-02',
  weekEnd: '2026-03-08',
  required: INTERN,
  days,
  tasks: { assigned: 0, completed: 0, outstanding: [] },
  weekComplete: true,
  ...over,
});

describe('the week', () => {
  it('runs Monday to Sunday', () => {
    expect(weekStartOf('2026-03-05')).toBe('2026-03-02');   // a Thursday
    expect(weekStartOf('2026-03-08')).toBe('2026-03-02');   // the Sunday closing it
    expect(weekStartOf('2026-03-09')).toBe('2026-03-09');   // the next Monday
    expect(weekEndOf('2026-03-02')).toBe('2026-03-08');
  });

  it('enumerates the weeks an engagement spans', () => {
    const w = weekStartsBetween('2026-03-04', '2026-03-20');
    expect(w).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
  });

  it('labels a week without an arrow character, which breaks .astro JSX strings', () => {
    expect(weekLabel('2026-03-02')).toBe('2026-03-02 to 2026-03-08');
    expect(weekLabel('2026-03-02')).not.toContain('→');
  });

  it('reads nothing out of a date that is not a date', () => {
    expect(weekStartOf('not a date')).toBe('');
    expect(weekStartsBetween('', '2026-03-20')).toEqual([]);
  });
});

describe('what a week requires', () => {
  it('an intern is 40 hours, taken from the published policy and not written here', () => {
    expect(INTERN.applicable).toBe(true);
    expect(INTERN.hours).toBe(40);
    expect(INTERN.hours).toBe(INTERN_WEEKLY_HOURS);
    expect(INTERN.basis).toContain('policy');
  });

  it('a recorded contract beats the policy', () => {
    // A part-time intern at 20 hours is measured against 20, never against 40.
    const r = requiredWeeklyHours({ employmentType: 'Intern', designation: 'Intern', recordedWeeklyHours: 20 });
    expect(r.hours).toBe(20);
    expect(r.basis).toContain('Recorded');
  });

  it('a full-time employee is NOT on the internship model and is not measured by it', () => {
    // Running a salaried engineer through a credit ledger is a category error that shows up on
    // their portal as "your credits".
    const r = requiredWeeklyHours({ employmentType: 'Full-Time', designation: 'Software Engineer' });
    expect(r.applicable).toBe(false);
    expect(r.hours).toBeNull();
  });

  it('seniority wins over a stray engagement type, so a Chief Officer is never given intern hours', () => {
    const r = requiredWeeklyHours({ employmentType: 'Intern', designation: 'Chief Technology Officer' });
    expect(r.applicable).toBe(false);
  });
});

describe('a credit is earned automatically when both tests pass', () => {
  it('grants the week when the hours are there and the week is complete', () => {
    const v = decideCreditWeek(input(FULL_WEEK));
    expect(v.state).toBe('earned-automatically');
    expect(v.automatic).toBe(true);
    expect(v.blockers).toEqual([]);
    expect(v.creditValue).toBe(1);
  });

  it('stores the evidence it was granted on', () => {
    // A credit granted six months ago must still be able to say what it rested on.
    const v = decideCreditWeek(input(FULL_WEEK));
    expect(v.evidence.hoursMeasured).toBe(40);
    expect(v.evidence.hoursFromClock).toBe(40);
    expect(v.evidence.hoursRequired).toBe(40);
    expect(v.evidence.reportsFiled).toBe(6);
    expect(v.evidence.reportsExpected).toBe(6);
    expect(v.evidence.findings.length).toBeGreaterThan(3);
    expect(v.evidence.hoursBasis).toContain('40');
  });

  it('is deterministic, which is what makes running it twice safe', () => {
    // The storage layer relies on this: a second reconciliation over unchanged data must reach the
    // same verdict and therefore have nothing to change. Two runs must never grant two credits.
    const a = decideCreditWeek(input(FULL_WEEK));
    const b = decideCreditWeek(input(FULL_WEEK));
    expect(a.state).toBe(b.state);
    expect(a.blockers).toEqual(b.blockers);
    expect(a.evidence.hoursMeasured).toBe(b.evidence.hoursMeasured);
  });

  it('accepts a quarter of an hour of clock rounding and no more', () => {
    const nearly = FULL_WEEK.map((d, i) => (i === 5 ? worked(d.date, 6.65 - HOURS_TOLERANCE) : d));
    expect(decideCreditWeek(input(nearly)).state).toBe('earned-automatically');
    const short = FULL_WEEK.map((d, i) => (i === 5 ? worked(d.date, 6.65 - HOURS_TOLERANCE - 0.5) : d));
    expect(decideCreditWeek(input(short)).state).toBe('pending');
  });
});

describe('what blocks the automatic path', () => {
  it('a day clocked in and never clocked out is unknown, not zero and not a full day', () => {
    const days = FULL_WEEK.map((d, i) =>
      (i === 2 ? { ...d, clockHours: null, incomplete: true } : d));
    const v = decideCreditWeek(input(days));
    expect(v.state).toBe('pending');
    expect(v.evidence.incompleteDates).toEqual(['2026-03-04']);
    expect(v.blockers.join(' ')).toContain('never clocked out');
    // The hours are not invented in either direction: only the five complete days counted.
    expect(v.evidence.hoursMeasured).toBeLessThan(40);
  });

  it('short hours leave the week pending, never refused', () => {
    const v = decideCreditWeek(input(FULL_WEEK.map((d) => (d.worked ? worked(d.date, 4) : d))));
    expect(v.state).toBe('pending');
    expect(v.state).not.toBe('refused');
    expect(v.blockers.join(' ')).toContain('of the 40 hour(s)');
  });

  it('an unfiled daily report blocks it', () => {
    const days = FULL_WEEK.map((d, i) => (i === 1 ? { ...d, reportFiled: false } : d));
    const v = decideCreditWeek(input(days));
    expect(v.state).toBe('pending');
    expect(v.evidence.reportsFiled).toBe(5);
    expect(v.blockers.join(' ')).toContain('daily report');
  });

  it('assigned work that is not done blocks it, and the week says which', () => {
    const v = decideCreditWeek(input(FULL_WEEK, {
      tasks: { assigned: 3, completed: 1, outstanding: ['Ingest pipeline', 'Seminar notes'] },
    }));
    expect(v.state).toBe('pending');
    expect(v.blockers.join(' ')).toContain('Ingest pipeline');
  });

  it('a week still running is never decided either way', () => {
    const v = decideCreditWeek(input(FULL_WEEK, { weekComplete: false }));
    expect(v.state).toBe('pending');
    expect(v.blockers.join(' ')).toContain('still in progress');
  });

  it('an unrecorded weekly requirement cannot be tested, so the week waits for a person', () => {
    const unknown = requiredWeeklyHours({ employmentType: 'Internship', designation: 'Intern', recordedWeeklyHours: null });
    // The policy supplies 40 here, so force the genuinely-unknown case explicitly.
    const v = decideCreditWeek(input(FULL_WEEK, {
      required: { ...unknown, hours: null, basis: 'No weekly hours are recorded for this engagement.' },
    }));
    expect(v.state).toBe('pending');
    expect(v.blockers.join(' ')).toContain('not recorded');
  });

  it('a week with nothing recorded at all does not quietly earn a credit', () => {
    const v = decideCreditWeek(input([off('2026-03-02'), off('2026-03-03')]));
    expect(v.state).toBe('pending');
    expect(v.blockers.join(' ')).toContain('No worked day');
  });
});

describe('granted leave and holidays reduce the requirement', () => {
  it('a public holiday takes a day off what the week requires', () => {
    const days = [
      off('2026-03-02', { holiday: true }),
      worked('2026-03-03', 6.67), worked('2026-03-04', 6.67), worked('2026-03-05', 6.67),
      worked('2026-03-06', 6.67), worked('2026-03-07', 6.66), off('2026-03-08'),
    ];
    const v = decideCreditWeek(input(days));
    // 40 less one sixth of the week is 33.33, and five days at 6.67 is 33.34.
    expect(v.evidence.hoursRequired).toBeCloseTo(33.33, 1);
    expect(v.state).toBe('earned-automatically');
  });

  it('approved leave is excused rather than counted as a shortfall', () => {
    const days = [
      off('2026-03-02', { approvedLeaveUnits: 1 }),
      off('2026-03-03', { approvedLeaveUnits: 1 }),
      worked('2026-03-04', 6.67), worked('2026-03-05', 6.67),
      worked('2026-03-06', 6.67), worked('2026-03-07', 6.67), off('2026-03-08'),
    ];
    const v = decideCreditWeek(input(days));
    expect(v.evidence.excusedDays).toBe(2);
    expect(v.evidence.hoursRequired).toBeCloseTo(26.67, 1);
    expect(v.state).toBe('earned-automatically');
  });

  it('a half day of approved leave excuses half a day, not a whole one', () => {
    const days = FULL_WEEK.map((d, i) => (i === 0 ? off(d.date, { approvedLeaveUnits: 0.5 }) : d));
    const v = decideCreditWeek(input(days));
    expect(v.evidence.excusedDays).toBe(0.5);
  });

  it('no daily report is expected on a day of granted leave', () => {
    const days = FULL_WEEK.map((d, i) => (i === 0 ? off(d.date, { approvedLeaveUnits: 1 }) : d));
    const v = decideCreditWeek(input(days));
    expect(v.evidence.reportsExpected).toBe(5);
    expect(v.blockers.join(' ')).not.toContain('daily report');
  });

  it('the requirement can fall to zero but never below it', () => {
    const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']
      .map((d) => off(d, { approvedLeaveUnits: 1 }));
    const v = decideCreditWeek(input(days));
    expect(v.evidence.hoursRequired).toBe(0);
    // Still pending: a week nobody worked is not a week that earns a credit by subtraction.
    expect(v.state).toBe('pending');
  });
});

describe('the position a screen shows', () => {
  it('separates what was earned from what is waiting and what was refused', () => {
    const p = positionFrom([
      { state: 'earned-automatically', creditValue: 1, hoursMeasured: 40 },
      { state: 'earned-automatically', creditValue: 1, hoursMeasured: 40 },
      { state: 'approved', creditValue: 1, hoursMeasured: 31 },
      { state: 'pending', creditValue: 1, hoursMeasured: 22 },
      { state: 'refused', creditValue: 1, hoursMeasured: 3 },
    ]);
    expect(p.earnedAutomatically).toBe(2);
    expect(p.approvedByPerson).toBe(1);
    expect(p.credits).toBe(3);          // a refused week is not a credit
    expect(p.pending).toBe(1);
    expect(p.refused).toBe(1);
    expect(p.hoursMeasured).toBe(136);
  });

  it('knows which states are a credit and which are settled', () => {
    expect(isCredited('earned-automatically')).toBe(true);
    expect(isCredited('approved')).toBe(true);
    expect(isCredited('pending')).toBe(false);
    expect(isCredited('refused')).toBe(false);
    // A refused week is SETTLED — frozen, never re-measured — without being a credit.
    expect(isDecided('refused')).toBe(true);
    expect(isDecided('pending')).toBe(false);
  });
});
