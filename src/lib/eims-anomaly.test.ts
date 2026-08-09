// Tests for the advisory layer. Every one of them is really defending the same thing: THE COST OF A
// WRONG ANSWER HERE IS A SENTENCE ABOUT A STUDENT.
//
// The five properties under test:
//   1. THE CONCLUSION IS ONE FIXED SENTENCE. One signal or six, it never gets stronger.
//   2. SILENCE IS THE DEFAULT. An ordinary record produces nothing at all.
//   3. NO SIGNAL FIRES ON AN UNREAD SOURCE. A null project read cannot produce a project finding.
//   4. NOTHING IN THE OUTPUT LABELS A PERSON. No accusatory vocabulary reaches a screen.
//   5. THE THRESHOLDS ARE THE THRESHOLDS. Just under fires nothing; just over fires exactly one thing.
import { describe, it, expect } from './test-shim';
import {
  detectAnomalies, MENTOR_SENTENCE,
  HOURS_FLOOR, HOURS_PER_EVIDENCE, DORMANT_DAYS, BULK_ITEMS, MISSED_DEADLINE_MIN,
  PROJECT_HOURS_FLOOR,
  type AnomalyActivity, type AnomalyEvidence, type AnomalyInput,
} from './eims-anomaly';

/* --------------------------------------------------------------------------------- fixtures */

const activity = (over: Partial<AnomalyActivity> = {}): AnomalyActivity => ({
  id: 'a1',
  title: 'Build the import screen',
  typeKey: 'project_work',
  status: 'in_progress',
  closed: false,
  deadline: '2026-08-05',
  allocatedHours: 4,
  reportedHours: 4,
  verifiedHours: null,
  reportedAt: '2026-08-05T10:00:00Z',
  evidenceRequirement: 'required',
  ...over,
});

const evidence = (over: Partial<AnomalyEvidence> = {}): AnomalyEvidence => ({
  id: 'e1',
  url: 'https://example.invalid/pull/1',
  title: 'Pull request',
  occurredOn: '2026-08-05',
  submittedAt: '2026-08-05T12:00:00Z',
  hoursClaimed: 4,
  activityIds: ['a1'],
  ...over,
});

const input = (over: Partial<AnomalyInput> = {}): AnomalyInput => ({
  fromIso: '2026-07-13',
  toIso: '2026-08-09',
  todayIso: '2026-08-09',
  activities: [],
  evidence: [],
  projectMovements: 1,
  ...over,
});

/* ------------------------------------------------------------------- silence is the default */

describe('an ordinary record says nothing', () => {
  it('produces no signals for work reported, evidenced and on time', () => {
    const signals = detectAnomalies(input({
      activities: [activity(), activity({ id: 'a2', deadline: '2026-08-07' })],
      evidence: [evidence(), evidence({ id: 'e2', url: 'https://example.invalid/pull/2', activityIds: ['a2'] })],
    }));
    expect(signals).toEqual([]);
  });

  it('produces no signals for an empty period', () => {
    expect(detectAnomalies(input())).toEqual([]);
  });
});

/* ------------------------------------------------------- 1. hours against little evidence */

describe('hours reported with little evidence filed', () => {
  it('fires when hours requiring evidence are high and nothing was filed', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: HOURS_FLOOR + 8, deadline: '2026-08-09' })],
      evidence: [],
    }));
    expect(signals.map((s) => s.key)).toContain('hours-without-evidence');
  });

  it('does not fire below the hours floor, however little evidence there is', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: HOURS_FLOOR - 1, deadline: '2026-08-09' })],
      evidence: [],
    }));
    expect(signals.map((s) => s.key)).not.toContain('hours-without-evidence');
  });

  it('does not fire when the activity type does not require evidence', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: 40, evidenceRequirement: 'optional', deadline: '2026-08-09' })],
      evidence: [],
    }));
    expect(signals.map((s) => s.key)).not.toContain('hours-without-evidence');
  });

  it('does not fire when the ratio of hours to evidence is inside the threshold', () => {
    // Two items for hours just under 2 x the per-item threshold.
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: HOURS_PER_EVIDENCE * 2 - 1, deadline: '2026-08-09' })],
      evidence: [evidence(), evidence({ id: 'e2', url: 'https://example.invalid/pull/2' })],
    }));
    expect(signals.map((s) => s.key)).not.toContain('hours-without-evidence');
  });
});

/* ----------------------------------------------------------- 2. repeated identical filings */

describe('the same submission more than once', () => {
  it('fires on the same link filed twice', () => {
    const signals = detectAnomalies(input({
      evidence: [
        evidence({ id: 'e1', occurredOn: '2026-08-03' }),
        evidence({ id: 'e2', occurredOn: '2026-08-06' }),
      ],
    }));
    expect(signals.map((s) => s.key)).toContain('repeated-identical-submission');
  });

  it('does not fire on two different links for two different days', () => {
    const signals = detectAnomalies(input({
      evidence: [
        evidence({ id: 'e1', url: 'https://example.invalid/pull/1', title: 'One', occurredOn: '2026-08-03' }),
        evidence({ id: 'e2', url: 'https://example.invalid/pull/2', title: 'Two', occurredOn: '2026-08-06' }),
      ],
    }));
    expect(signals.map((s) => s.key)).not.toContain('repeated-identical-submission');
  });

  it('treats a trailing slash and a scheme as the same link, because they are', () => {
    const signals = detectAnomalies(input({
      evidence: [
        evidence({ id: 'e1', url: 'https://example.invalid/pull/1', occurredOn: '2026-08-03' }),
        evidence({ id: 'e2', url: 'http://Example.invalid/pull/1/', occurredOn: '2026-08-06' }),
      ],
    }));
    expect(signals.map((s) => s.key)).toContain('repeated-identical-submission');
  });
});

/* --------------------------------------------------------------- 3. a quiet period, then a lot */

describe('a quiet period followed by a large single filing', () => {
  const bulkOn = (day: string): AnomalyEvidence[] => {
    const items: AnomalyEvidence[] = [];
    for (let i = 0; i < BULK_ITEMS; i++) {
      items.push(evidence({
        id: day + i,
        url: 'https://example.invalid/' + day + '/' + i,
        title: day + ' item ' + i,
        occurredOn: day,
        submittedAt: day + 'T09:0' + i + ':00Z',
        activityIds: [],
      }));
    }
    return items;
  };

  it('fires on a long gap BETWEEN two recorded days, followed by a bulk', () => {
    const signals = detectAnomalies(input({
      fromIso: '2026-07-01',
      evidence: [
        evidence({ id: 'first', url: 'https://example.invalid/first', title: 'First', occurredOn: '2026-07-20', submittedAt: '2026-07-20T09:00:00Z', activityIds: [] }),
        ...bulkOn('2026-08-07'),
      ],
    }));
    expect(signals.map((s) => s.key)).toContain('dormant-then-bulk');
  });

  // THE REGRESSION THIS SIGNAL WAS BORN WITH. Measuring the first gap from the start of the review
  // window reports a silence the window invented, about somebody who did nothing unusual: an exam
  // fortnight, a late start, or a window that simply opens during a quiet spell. Nothing was
  // recorded before the gap, so there is no gap to observe.
  it('NEVER fires on the first recorded day, however far it is from the start of the window', () => {
    const signals = detectAnomalies(input({
      fromIso: '2026-07-01',
      evidence: bulkOn('2026-08-07'),
    }));
    expect(signals.map((s) => s.key)).not.toContain('dormant-then-bulk');
  });

  it('says it once, not once per gap', () => {
    const items: AnomalyEvidence[] = [];
    for (const day of ['2026-07-25', '2026-08-07']) {
      for (let i = 0; i < BULK_ITEMS; i++) {
        items.push(evidence({
          id: day + i,
          url: 'https://example.invalid/' + day + '/' + i,
          title: day + ' item ' + i,
          occurredOn: day,
          submittedAt: day + 'T09:0' + i + ':00Z',
          activityIds: [],
        }));
      }
    }
    const signals = detectAnomalies(input({ fromIso: '2026-07-01', evidence: items }));
    expect(signals.filter((s) => s.key === 'dormant-then-bulk')).toHaveLength(1);
  });

  it('does not fire when the gap is shorter than the threshold', () => {
    const day = '2026-08-07';
    const earlier = '2026-08-06';
    const items = [evidence({ id: 'e0', url: 'https://example.invalid/x', title: 'x', occurredOn: earlier, submittedAt: earlier + 'T09:00:00Z', activityIds: [] })];
    for (let i = 0; i < BULK_ITEMS; i++) {
      items.push(evidence({
        id: 'e' + i, url: 'https://example.invalid/item/' + i, title: 'Item ' + i,
        occurredOn: day, submittedAt: day + 'T09:0' + i + ':00Z', activityIds: [],
      }));
    }
    const signals = detectAnomalies(input({ fromIso: '2026-08-05', evidence: items }));
    expect(signals.map((s) => s.key)).not.toContain('dormant-then-bulk');
    expect(DORMANT_DAYS).toBeGreaterThan(2);
  });
});

/* ------------------------------------------------- 4. finished, with evidence still required */

describe('completed with evidence still required', () => {
  it('fires when a completed activity requiring evidence has none attached', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ status: 'completed' })],
      evidence: [],
    }));
    expect(signals.map((s) => s.key)).toContain('completed-without-required-evidence');
  });

  it('does not fire when evidence is attached to that activity', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ status: 'completed' })],
      evidence: [evidence({ activityIds: ['a1'] })],
    }));
    expect(signals.map((s) => s.key)).not.toContain('completed-without-required-evidence');
  });

  it('does not fire on a cancelled activity, because nothing is owed on one', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ status: 'cancelled', closed: true })],
      evidence: [],
    }));
    expect(signals.map((s) => s.key)).not.toContain('completed-without-required-evidence');
  });
});

/* ------------------------------------------------------- 5. project hours, nothing recorded */

describe('project hours with no recorded project movement', () => {
  it('fires when project hours are high and nothing moved', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: PROJECT_HOURS_FLOOR + 5, deadline: '2026-08-08' })],
      evidence: [evidence(), evidence({ id: 'e2', url: 'https://example.invalid/b' })],
      projectMovements: 0,
    }));
    expect(signals.map((s) => s.key)).toContain('workload-without-recorded-project-activity');
  });

  it('NEVER fires when the project source could not be read', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: PROJECT_HOURS_FLOOR + 50, deadline: '2026-08-08' })],
      evidence: [evidence(), evidence({ id: 'e2', url: 'https://example.invalid/b' })],
      projectMovements: null,
    }));
    expect(signals.map((s) => s.key)).not.toContain('workload-without-recorded-project-activity');
  });

  it('names the gap in the record as the likely explanation, not the person', () => {
    const signals = detectAnomalies(input({
      activities: [activity({ reportedHours: PROJECT_HOURS_FLOOR + 5, deadline: '2026-08-08' })],
      evidence: [evidence(), evidence({ id: 'e2', url: 'https://example.invalid/b' })],
      projectMovements: 0,
    }));
    const s = signals.find((x) => x.key === 'workload-without-recorded-project-activity')!;
    expect(s.ordinaryExplanation.toUpperCase()).toContain('GAP IN THE RECORD');
  });
});

/* --------------------------------------------------------------- 6. repeated missed deadlines */

describe('several deadlines passed with work still open', () => {
  const overdue = (id: string) => activity({
    id, deadline: '2026-08-01', status: 'in_progress', reportedHours: 0, reportedAt: null,
    evidenceRequirement: 'optional',
  });

  it('fires at the threshold', () => {
    const activities = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN; i++) activities.push(overdue('o' + i));
    const signals = detectAnomalies(input({ activities }));
    expect(signals.map((s) => s.key)).toContain('repeated-missed-deadlines');
  });

  it('does not fire one under the threshold', () => {
    const activities = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN - 1; i++) activities.push(overdue('o' + i));
    const signals = detectAnomalies(input({ activities }));
    expect(signals.map((s) => s.key)).not.toContain('repeated-missed-deadlines');
  });

  it('blames the planning, not the intern', () => {
    const activities = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN; i++) activities.push(overdue('o' + i));
    const s = detectAnomalies(input({ activities })).find((x) => x.key === 'repeated-missed-deadlines')!;
    expect(s.ordinaryExplanation).toContain('planning problem rather than a person');
  });
});

/* ------------------------------------------------------------- the conclusion never escalates */

describe('the conclusion is one fixed sentence', () => {
  it('is the same sentence whether one signal fires or several', () => {
    // Deliberately the worst record the fixtures can build: it must still produce ONE sentence.
    const activities: AnomalyActivity[] = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN + 2; i++) {
      activities.push(activity({
        id: 'x' + i, status: 'completed', deadline: '2026-08-01',
        reportedHours: 10, reportedAt: '2026-08-08T10:00:00Z',
      }));
    }
    const many = detectAnomalies(input({
      activities,
      evidence: [
        evidence({ id: 'd1', occurredOn: '2026-08-03', activityIds: [] }),
        evidence({ id: 'd2', occurredOn: '2026-08-08', activityIds: [] }),
      ],
      projectMovements: 0,
    }));
    expect(many.length).toBeGreaterThan(1);
    // There is exactly one sentence in the module and it is a constant, so no amount of signal can
    // change it. This assertion is the guard against somebody adding a "severe" variant later.
    expect(MENTOR_SENTENCE).toBe('Potential discrepancy detected, mentor review required.');
  });

  it('carries no vocabulary that labels a person', () => {
    const activities: AnomalyActivity[] = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN + 2; i++) {
      activities.push(activity({
        id: 'x' + i, status: 'completed', deadline: '2026-08-01',
        reportedHours: 10, reportedAt: '2026-08-08T10:00:00Z',
      }));
    }
    const signals = detectAnomalies(input({
      activities,
      evidence: [evidence({ id: 'd1', occurredOn: '2026-08-03', activityIds: [] })],
      projectMovements: 0,
    }));
    const text = [MENTOR_SENTENCE, ...signals.map((s) => s.label + ' ' + s.observation + ' ' + s.ordinaryExplanation + ' ' + s.lookAt)]
      .join(' ')
      .toLowerCase();
    for (const word of ['fraud', 'fraudulent', 'dishonest', 'cheat', 'lying', 'lied', 'falsified', 'suspicious', 'violation', 'misconduct', 'guilty']) {
      expect(text).not.toContain(word);
    }
  });

  it('gives every signal an ordinary explanation and something to look at', () => {
    const activities: AnomalyActivity[] = [];
    for (let i = 0; i < MISSED_DEADLINE_MIN + 2; i++) {
      activities.push(activity({
        id: 'x' + i, status: 'completed', deadline: '2026-08-01',
        reportedHours: 10, reportedAt: '2026-08-08T10:00:00Z',
      }));
    }
    const signals = detectAnomalies(input({
      activities,
      evidence: [evidence({ id: 'd1', occurredOn: '2026-08-03', activityIds: [] })],
      projectMovements: 0,
    }));
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.ordinaryExplanation.length).toBeGreaterThan(20);
      expect(s.lookAt.length).toBeGreaterThan(10);
      expect(s.observation.length).toBeGreaterThan(20);
    }
  });
});
