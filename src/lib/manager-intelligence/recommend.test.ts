import { describe, it, expect } from 'vitest';
import { NOTHING_DECIDED, noRecommendationsSentence, recommendationsFor } from './recommend';
import { signalsFor } from './signals';
import { buildSignal, decisionWeight, type ManagerSignal, type TeamMemberFacts } from './types';

const NOW = '2026-08-23T09:00:00.000Z';
const EMP = '22222222-2222-4222-8222-222222222222';

function facts(over: Partial<TeamMemberFacts> = {}): TeamMemberFacts {
  const base: TeamMemberFacts = {
    employeeId: EMP,
    fullName: 'Vikram Nair',
    designation: 'Analyst',
    window: { fromIso: '2026-07-27', toIso: '2026-08-23', days: 28 },
    delivery: {
      openTotal: 5, inProgress: 2, blocked: 0, blockedWithStatedReason: 0, underReview: 0,
      overdue: 0, dueWithin7: 0, urgentOpen: 0, highOpen: 0,
      completedInWindow: 6, completedOnTime: 6, completedLate: 0, completedWithDueDate: 6,
      oldestOpenDays: 3,
    },
    submission: {
      expectedDays: 18, filedDays: 17, sameDayFilings: 16, lateFilings: 1,
      longestMissingRun: 1, reviewedByAnyone: 9,
    },
    rework: { sendBacks: 0, tasksSentBack: 0, tasksReachingReview: 8, reportsRevised: 1, reportsFiled: 17 },
    behaviour: {
      attendanceDaysRecorded: 18, presentDays: 18, leaveDays: 0, daysWithNoRecord: 0,
      workPickedUp: 6, blockersRaised: 1, commentsWritten: 9, informalConductNotes: 0,
    },
    capacity: {
      activeAssignments: 5, urgentOpen: 0, highOpen: 0, dueWithin7: 0, overdue: 0,
      approvedLeaveDaysNext14: 0, teamSize: 4, teamMeanAssignments: 5,
    },
    stated: { strengthNotes: 0, improvementNotes: 0, generalNotes: 0, mostRecentAt: null },
    readFailures: [],
  };
  return { ...base, ...over };
}

const recsFor = (f: TeamMemberFacts) => recommendationsFor(signalsFor(f, NOW));
const recKeys = (f: TeamMemberFacts) => recsFor(f).map((r) => r.key);

/** A derived-only signal, to prove the admissibility filter is real. */
const derivedOnly: ManagerSignal = buildSignal({
  key: 'capacity.above_team_load',
  section: 'workload_capacity',
  headline: 'Holding about 2 times the team average.',
  detail: 'A comparison of counts.',
  direction: 'attention',
  evidenceStrength: 'derived',
  inputs: [{ label: 'Team size', value: '4', source: 'employee_tasks' }],
  processing: 'mean comparison',
  output: '2x the team mean',
  evidence: [],
  confidence: 0.5,
  confidenceBasis: 'A mean over four people.',
  observedFrom: '2026-07-27',
  observedTo: '2026-08-23',
  computedAt: NOW,
});

describe('nothing here decides anything', () => {
  it('marks every recommendation as human-decided', () => {
    const overloaded = facts({
      delivery: { ...facts().delivery, overdue: 3, urgentOpen: 2, highOpen: 2, openTotal: 14 },
      capacity: { ...facts().capacity, activeAssignments: 14, urgentOpen: 2, highOpen: 2, overdue: 3, teamMeanAssignments: 4 },
    });
    const recs = recsFor(overloaded);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(r.humanDecides).toBe(true);
  });

  it('carries the standing sentence for a surface to print', () => {
    expect(NOTHING_DECIDED).toContain('decided anything');
  });
});

describe('no recommendation rests on arithmetic alone', () => {
  it('drops a candidate whose only trigger is derived', () => {
    // The derived comparison on its own: no overdue work, no priority stack, so the workload
    // recommendation must not appear.
    expect(recommendationsFor([derivedOnly])).toHaveLength(0);
  });

  it('never returns an action resting on derived evidence', () => {
    const busy = facts({
      delivery: { ...facts().delivery, overdue: 4, urgentOpen: 3, highOpen: 1, openTotal: 15, oldestOpenDays: 44 },
      capacity: { ...facts().capacity, activeAssignments: 15, urgentOpen: 3, highOpen: 1, overdue: 4, teamMeanAssignments: 4 },
      rework: { ...facts().rework, tasksReachingReview: 10, tasksSentBack: 5, sendBacks: 6 },
      submission: { ...facts().submission, filedDays: 6, expectedDays: 18, longestMissingRun: 5 },
    });
    for (const r of recsFor(busy)) {
      expect(decisionWeight(r.restsOn)).toBeGreaterThan(decisionWeight('derived'));
    }
  });

  it('names the signals it was drawn from, always', () => {
    const busy = facts({
      delivery: { ...facts().delivery, overdue: 2, urgentOpen: 1, highOpen: 1 },
      capacity: { ...facts().capacity, urgentOpen: 1, highOpen: 1, overdue: 2 },
    });
    for (const r of recsFor(busy)) expect(r.fromSignals.length).toBeGreaterThan(0);
  });
});

describe('the workload recommendation from the brief', () => {
  it('fires on a priority stack beside overdue work, in the exact words', () => {
    const f = facts({
      delivery: { ...facts().delivery, overdue: 2, urgentOpen: 1, highOpen: 2, openTotal: 9 },
      capacity: { ...facts().capacity, activeAssignments: 9, urgentOpen: 1, highOpen: 2, overdue: 2 },
    });
    const rec = recsFor(f).find((r) => r.key === 'rec.review_workload');
    expect(rec).toBeTruthy();
    expect(rec!.headline).toBe('Review workload before assigning additional high-priority tasks.');
    expect(rec!.urgency).toBe('now');
  });

  it('does not fire on a high load with no high or urgent work in it', () => {
    const f = facts({
      delivery: { ...facts().delivery, openTotal: 20, overdue: 0, urgentOpen: 0, highOpen: 0 },
      capacity: { ...facts().capacity, activeAssignments: 20, urgentOpen: 0, highOpen: 0, teamMeanAssignments: 4 },
    });
    expect(recKeys(f)).not.toContain('rec.review_workload');
  });

  it('does not fire on a quiet week', () => {
    expect(recKeys(facts())).not.toContain('rec.review_workload');
  });
});

describe('the other suggestions', () => {
  it('asks for cover when booked leave meets a deadline', () => {
    const f = facts({
      delivery: { ...facts().delivery, dueWithin7: 3 },
      capacity: { ...facts().capacity, dueWithin7: 3, approvedLeaveDaysNext14: 4 },
    });
    expect(recKeys(f)).toContain('rec.arrange_cover');
  });

  it('asks about a blocker only when no cause was stated', () => {
    const stated = facts({ delivery: { ...facts().delivery, blocked: 2, blockedWithStatedReason: 2 } });
    const silent = facts({ delivery: { ...facts().delivery, blocked: 2, blockedWithStatedReason: 0 } });
    expect(recKeys(stated)).not.toContain('rec.unblock');
    expect(recKeys(silent)).toContain('rec.unblock');
  });

  it('sends the manager to HR when informal conduct notes exist, and only then', () => {
    const f = facts({ behaviour: { ...facts().behaviour, informalConductNotes: 1 } });
    const rec = recsFor(f).find((r) => r.key === 'rec.check_with_hr');
    expect(rec).toBeTruthy();
    expect(rec!.suggests).toBe('hr_support_requested');
    expect(recKeys(facts())).not.toContain('rec.check_with_hr');
  });

  it('suggests recording a strength while the evidence is fresh', () => {
    expect(recKeys(facts())).toContain('rec.record_strength');
  });
});

describe('the list is stable and honestly empty', () => {
  it('returns the same order for the same signals', () => {
    const f = facts({
      delivery: { ...facts().delivery, overdue: 2, urgentOpen: 1, highOpen: 1, oldestOpenDays: 40 },
      capacity: { ...facts().capacity, urgentOpen: 1, highOpen: 1, overdue: 2 },
    });
    expect(recKeys(f)).toEqual(recKeys(f));
  });

  it('puts the urgent ones first', () => {
    const f = facts({
      delivery: { ...facts().delivery, overdue: 2, urgentOpen: 2, highOpen: 1, oldestOpenDays: 40 },
      capacity: { ...facts().capacity, urgentOpen: 2, highOpen: 1, overdue: 2 },
    });
    const recs = recsFor(f);
    const firstWatch = recs.findIndex((r) => r.urgency === 'watch');
    const lastNow = recs.map((r) => r.urgency).lastIndexOf('now');
    if (firstWatch >= 0 && lastNow >= 0) expect(lastNow).toBeLessThan(firstWatch);
  });

  it('distinguishes nothing recorded from nothing worth suggesting', () => {
    expect(noRecommendationsSentence([])).toContain('nothing recorded');
    expect(noRecommendationsSentence(signalsFor(facts(), NOW))).toContain('none of it needed anything from you');
  });
});
