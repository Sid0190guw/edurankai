// Tests for the HR scheduled sweep — the door that attendance-lapse.ts never had.
//
// THE DEFECT. src/lib/attendance-lapse.ts detects people who have stopped appearing, has its own
// test suite, and was called by nothing: no route, no job, no schedule. Detection ran only when a
// human opened a screen — the one moment it is least useful, because somebody has already noticed.
//
// What is tested here is the JUDGEMENT, which is the part that is invisible when it is wrong. A
// boundary rule that fires every day instead of on day 5 and 7 produces a daily irritation people
// filter; a rule that warns on a skipped assessment punishes a data-entry gap; a sweep that reports
// zero absences when the assessment failed is the calm zero over a failed read.
import { describe, it, expect } from 'vitest';
import { lapseNoticesFor } from '@/lib/hr/scheduled';
import { DEFAULT_LAPSE_DAYS, WARN_AT_DAYS, type LapseAssessment } from '@/lib/attendance-lapse';

const A = (over: Partial<LapseAssessment>): LapseAssessment => ({
  employeeId: '11111111-1111-4111-8111-111111111111',
  days: 0,
  state: 'clear',
  dates: [],
  skipped: null,
  threshold: DEFAULT_LAPSE_DAYS,
  ...over,
});

describe('who gets a notice', () => {
  it('nobody, when everybody is clear', () => {
    expect(lapseNoticesFor([A({}), A({ days: 2, state: 'clear' })])).toEqual([]);
  });

  it('warns on each boundary day and on no other day', () => {
    // The rule is day 5 and day 7, not "every day from 5 onwards". Firing on 6 and 8 as well would
    // send four notices where the policy describes two.
    for (const d of [1, 2, 3, 4, 6, 8]) {
      expect(lapseNoticesFor([A({ days: d, state: 'warning' })]), `day ${d} should be silent`).toEqual([]);
    }
    for (const d of WARN_AT_DAYS) {
      const n = lapseNoticesFor([A({ days: d, state: 'warning' })]);
      expect(n, `day ${d} should warn`).toHaveLength(1);
      expect(n[0].kind).toBe('warning');
      expect(n[0].days).toBe(d);
    }
  });

  it('reports a lapse at or past the threshold, on every day, not only on a boundary', () => {
    // Unlike a warning, a lapse is a standing state. It stays reported until somebody deals with it;
    // the dedup key keeps it from being raised twice for the same day count.
    for (const d of [DEFAULT_LAPSE_DAYS, DEFAULT_LAPSE_DAYS + 1, DEFAULT_LAPSE_DAYS + 30]) {
      const n = lapseNoticesFor([A({ days: d, state: 'lapsed' })]);
      expect(n, `day ${d}`).toHaveLength(1);
      expect(n[0].kind).toBe('lapsed');
    }
  });

  it('treats days past the threshold as a lapse even if the state says warning', () => {
    // Belt and braces: if the two ever disagree, the more serious reading wins, and it wins without
    // changing anybody's access.
    const n = lapseNoticesFor([A({ days: DEFAULT_LAPSE_DAYS + 2, state: 'warning' })]);
    expect(n[0].kind).toBe('lapsed');
  });

  it('NEVER warns on a skipped assessment', () => {
    // `skipped` means the module could not judge this person — no engagement record, no expected
    // days. Raising a flag on that basis punishes a data-entry gap as if it were absence.
    for (const d of [...WARN_AT_DAYS, DEFAULT_LAPSE_DAYS, DEFAULT_LAPSE_DAYS + 5]) {
      expect(lapseNoticesFor([A({ days: d, state: 'lapsed', skipped: 'no engagement record' })]), `day ${d}`).toEqual([]);
    }
  });

  it('honours a custom threshold', () => {
    expect(lapseNoticesFor([A({ days: 4, state: 'warning' })], 4)[0].kind).toBe('lapsed');
    expect(lapseNoticesFor([A({ days: 3, state: 'warning' })], 4)).toEqual([]);
  });
});

describe('the notice itself', () => {
  it('is deduplicated per employee and per day count', () => {
    const one = lapseNoticesFor([A({ employeeId: 'e1', days: 5, state: 'warning' })])[0];
    const same = lapseNoticesFor([A({ employeeId: 'e1', days: 5, state: 'warning' })])[0];
    const laterDay = lapseNoticesFor([A({ employeeId: 'e1', days: 7, state: 'warning' })])[0];
    const other = lapseNoticesFor([A({ employeeId: 'e2', days: 5, state: 'warning' })])[0];

    expect(one.dedupKey).toBe(same.dedupKey);        // re-running the sweep raises nothing new
    expect(one.dedupKey).not.toBe(laterDay.dedupKey); // day 7 is a new fact and is said again
    expect(one.dedupKey).not.toBe(other.dedupKey);    // and it is per person
  });

  it('says it is a prompt for a conversation, not a finding', () => {
    // The wording is load-bearing. An absence, an unrecorded holiday and a clock-in that did not
    // save are indistinguishable from the data, and a flag that reads like an accusation invites
    // somebody to act on it as one.
    const n = lapseNoticesFor([A({ days: DEFAULT_LAPSE_DAYS, state: 'lapsed' })])[0];
    expect(n.summary).toMatch(/not a finding/i);
    expect(n.summary).toMatch(/conversation/i);
  });

  it('states explicitly that access has not been changed', () => {
    // The sweep raises flags and stops. Suspending a profile stays a human decision, and the notice
    // has to say so or the reader will assume the system already acted.
    const n = lapseNoticesFor([A({ days: DEFAULT_LAPSE_DAYS, state: 'lapsed' })])[0];
    expect(n.summary).toMatch(/has NOT been changed/);
  });

  it('handles a mixed population in one pass', () => {
    const notices = lapseNoticesFor([
      A({ employeeId: 'clear', days: 1, state: 'clear' }),
      A({ employeeId: 'warn5', days: 5, state: 'warning' }),
      A({ employeeId: 'quiet6', days: 6, state: 'warning' }),
      A({ employeeId: 'warn7', days: 7, state: 'warning' }),
      A({ employeeId: 'gone', days: 12, state: 'lapsed' }),
      A({ employeeId: 'unknown', days: 20, state: 'lapsed', skipped: 'no engagement' }),
    ]);
    expect(notices.map((n) => n.employeeId)).toEqual(['warn5', 'warn7', 'gone']);
    expect(notices.filter((n) => n.kind === 'warning')).toHaveLength(2);
    expect(notices.filter((n) => n.kind === 'lapsed')).toHaveLength(1);
  });
});

describe('the schedule is registered', () => {
  it('the sweep has a scheduler entry, and it matches the deployment config', async () => {
    // The handler landed before the route and the route before the schedule. This asserts the last
    // step actually happened — a library function nobody calls is what this whole exercise was about.
    const { CONFIGURED_CRONS } = await import('@/lib/observability-health');
    const entry = CONFIGURED_CRONS.find((c) => c.path === '/api/cron/hr-sweep');
    expect(entry, 'the HR sweep is not in CONFIGURED_CRONS').toBeTruthy();
    expect(entry!.schedule).toMatch(/^\d+ \d+ \* \* \*$/);   // daily; the tier allows nothing finer
  });
});
