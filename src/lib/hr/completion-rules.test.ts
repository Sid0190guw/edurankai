// The completion engine's rules: dates, criteria, and what it does next.
import { describe, it, expect } from 'vitest';
import {
  parseDuration, endDateFor, daysUntil, isFixedTerm, evaluateCriteria, nextStep, NOTIFY_LEAD_DAYS_BEFORE,
  type CriteriaInput,
} from './completion-rules';

describe('durations and end dates', () => {
  it('reads the duration an offer letter states', () => {
    expect(parseDuration('6 Months')).toEqual({ months: 6, weeks: 0, days: 0 });
    expect(parseDuration('12 weeks')).toEqual({ months: 0, weeks: 12, days: 0 });
    expect(parseDuration('1 year')).toEqual({ months: 12, weeks: 0, days: 0 });
    expect(parseDuration('90 days')).toEqual({ months: 0, weeks: 0, days: 90 });
    expect(parseDuration('3 mo')).toEqual({ months: 3, weeks: 0, days: 0 });
    expect(parseDuration('Permanent')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });

  it('ends the day before the same date in the last month', () => {
    expect(endDateFor('2026-05-28', { months: 6, weeks: 0, days: 0 })).toBe('2026-11-27');
    expect(endDateFor('2026-01-31', { months: 1, weeks: 0, days: 0 })).toBe('2026-02-27');
    expect(endDateFor('2026-06-01', { months: 0, weeks: 12, days: 0 })).toBe('2026-08-23');
    expect(endDateFor('not a date', { months: 1, weeks: 0, days: 0 })).toBeNull();
  });

  it('counts days to the end, zero on the last day', () => {
    expect(daysUntil('2026-11-27', '2026-11-20')).toBe(7);
    expect(daysUntil('2026-11-27', '2026-11-27')).toBe(0);
    expect(daysUntil('2026-11-27', '2026-11-30')).toBe(-3);
  });

  it('watches internships, apprenticeships, contracts, and anything with a stated duration', () => {
    expect(isFixedTerm('Intern', false)).toBe(true);
    expect(isFixedTerm('Apprenticeship', false)).toBe(true);
    expect(isFixedTerm('Contract', false)).toBe(true);
    expect(isFixedTerm('Full-time', false)).toBe(false);
    expect(isFixedTerm('Full-time', true)).toBe(true);
  });
});

const good: CriteriaInput = {
  figuresMeasured: true, eligible: true, eligibilityReason: 'Completed 480 of 480 required hours.',
  attendanceKnown: true, attendancePct: 92, reviewCount: 3, averageRating: 4.3, unauthorisedLeaveDays: 0,
  creditApplicable: true, pendingCreditWeeks: 0, leadDecision: null, hasEmail: true,
};

describe('criteria', () => {
  it('passes when everything is met, without needing the lead to answer', () => {
    const e = evaluateCriteria(good);
    expect(e.allPassed).toBe(true);
    expect(e.criteria.find((c) => c.key === 'lead')?.state).toBe('info');
  });

  it('holds on each failing criterion and names it', () => {
    const cases: Array<[Partial<CriteriaInput>, string]> = [
      [{ eligible: false, eligibilityReason: '40 hours short.' }, 'requirement'],
      [{ reviewCount: 0, averageRating: null }, 'reviews'],
      [{ averageRating: 2.1 }, 'reviews'],
      [{ attendancePct: 60 }, 'attendance'],
      [{ unauthorisedLeaveDays: 5 }, 'leave'],
      [{ pendingCreditWeeks: 2 }, 'credits'],
      [{ leadDecision: 'held' }, 'lead'],
      [{ figuresMeasured: false }, 'measured'],
    ];
    for (const [patch, key] of cases) {
      const e = evaluateCriteria({ ...good, ...patch });
      expect(e.allPassed).toBe(false);
      expect(e.blocking.map((b) => b.key)).toContain(key);
    }
  });

  it('does not hold for things that were simply not recorded or not applicable', () => {
    expect(evaluateCriteria({ ...good, attendanceKnown: false, attendancePct: 0 }).allPassed).toBe(true);
    expect(evaluateCriteria({ ...good, hasEmail: false }).allPassed).toBe(true);
    expect(evaluateCriteria({ ...good, creditApplicable: false, pendingCreditWeeks: 3 }).allPassed).toBe(true);
  });
});

describe('next step', () => {
  it('asks the lead a week out, once, and evaluates on the end date', () => {
    expect(nextStep({ daysLeft: NOTIFY_LEAD_DAYS_BEFORE + 1, leadNotified: false, outcome: null })).toBe('none');
    expect(nextStep({ daysLeft: NOTIFY_LEAD_DAYS_BEFORE, leadNotified: false, outcome: null })).toBe('notify_lead');
    expect(nextStep({ daysLeft: 3, leadNotified: true, outcome: null })).toBe('none');
    expect(nextStep({ daysLeft: 0, leadNotified: true, outcome: null })).toBe('evaluate');
    expect(nextStep({ daysLeft: -4, leadNotified: false, outcome: null })).toBe('evaluate');
  });

  it('does nothing once decided, or without an end date', () => {
    expect(nextStep({ daysLeft: -1, leadNotified: true, outcome: 'certificate_issued' })).toBe('none');
    expect(nextStep({ daysLeft: -1, leadNotified: true, outcome: 'held' })).toBe('none');
    expect(nextStep({ daysLeft: null, leadNotified: false, outcome: null })).toBe('none');
  });
});
