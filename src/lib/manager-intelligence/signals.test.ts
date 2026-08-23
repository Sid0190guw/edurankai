import { describe, it, expect } from 'vitest';
import {
  MIN_OBSERVATIONS,
  emptySectionSentence,
  rateConfidence,
  signalsFor,
  signalsInSection,
} from './signals';
import { buildSignal, SignalContractError, type TeamMemberFacts } from './types';

// vitest, not src/lib/test-shim.ts: the shim's it() is synchronous and never awaits, so a test
// written against it can pass while asserting nothing. Everything here is pure and synchronous, but
// it sits beside async writers and one runner for the module is the smaller mistake.

const NOW = '2026-08-23T09:00:00.000Z';
const EMP = '11111111-1111-4111-8111-111111111111';

function facts(over: Partial<TeamMemberFacts> = {}): TeamMemberFacts {
  const base: TeamMemberFacts = {
    employeeId: EMP,
    fullName: 'Asha Rao',
    designation: 'Engineer',
    window: { fromIso: '2026-07-27', toIso: '2026-08-23', days: 28 },
    delivery: {
      openTotal: 6, inProgress: 3, blocked: 0, blockedWithStatedReason: 0, underReview: 1,
      overdue: 0, dueWithin7: 2, urgentOpen: 0, highOpen: 0,
      completedInWindow: 10, completedOnTime: 9, completedLate: 1, completedWithDueDate: 10,
      oldestOpenDays: 4,
    },
    submission: {
      expectedDays: 20, filedDays: 19, sameDayFilings: 17, lateFilings: 2,
      longestMissingRun: 1, reviewedByAnyone: 12,
    },
    rework: { sendBacks: 1, tasksSentBack: 1, tasksReachingReview: 12, reportsRevised: 2, reportsFiled: 19 },
    behaviour: {
      attendanceDaysRecorded: 20, presentDays: 20, leaveDays: 0, daysWithNoRecord: 0,
      workPickedUp: 8, blockersRaised: 2, commentsWritten: 14, informalConductNotes: 0,
    },
    capacity: {
      activeAssignments: 6, urgentOpen: 0, highOpen: 0, dueWithin7: 2, overdue: 0,
      approvedLeaveDaysNext14: 0, teamSize: 4, teamMeanAssignments: 5,
    },
    stated: { strengthNotes: 0, improvementNotes: 0, generalNotes: 0, mostRecentAt: null },
    readFailures: [],
  };
  return { ...base, ...over };
}

const keys = (f: TeamMemberFacts): string[] => signalsFor(f, NOW).map((s) => s.key);

describe('the signal envelope is enforced, not documented', () => {
  it('refuses a source that is not on the admissible list', () => {
    expect(() => buildSignal({
      key: 'x', section: 'team_behaviour', headline: 'h', detail: 'd',
      direction: 'neutral', evidenceStrength: 'derived',
      // A wellness table is exactly the kind of source this list exists to keep out.
      inputs: [{ label: 'l', value: '1', source: 'wellness_cycle_logs' as any }],
      processing: 'p', output: 'o', evidence: [], confidence: 0.5, confidenceBasis: 'b',
      observedFrom: '2026-08-01', observedTo: '2026-08-23', computedAt: NOW,
    })).toThrow(SignalContractError);
  });

  it('refuses a signal that names no inputs', () => {
    expect(() => buildSignal({
      key: 'x', section: 'team_behaviour', headline: 'h', detail: 'd',
      direction: 'neutral', evidenceStrength: 'derived',
      inputs: [], processing: 'p', output: 'o', evidence: [], confidence: 0.5, confidenceBasis: 'b',
      observedFrom: '2026-08-01', observedTo: '2026-08-23', computedAt: NOW,
    })).toThrow(SignalContractError);
  });

  it('refuses a confidence with no stated basis', () => {
    expect(() => buildSignal({
      key: 'x', section: 'team_behaviour', headline: 'h', detail: 'd',
      direction: 'neutral', evidenceStrength: 'derived',
      inputs: [{ label: 'l', value: '1', source: 'employee_tasks' }],
      processing: 'p', output: 'o', evidence: [], confidence: 0.5, confidenceBasis: '',
      observedFrom: '2026-08-01', observedTo: '2026-08-23', computedAt: NOW,
    })).toThrow(SignalContractError);
  });

  it('gives every produced signal a full envelope', () => {
    for (const s of signalsFor(facts(), NOW)) {
      expect(s.inputs.length).toBeGreaterThan(0);
      expect(s.processing.length).toBeGreaterThan(0);
      expect(s.output.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidenceBasis.length).toBeGreaterThan(0);
      expect(s.computedAt).toBe(NOW);
      expect(s.observedFrom).toBe('2026-07-27');
    }
  });

  it('is pure: the same facts produce the same signals', () => {
    const f = facts();
    expect(keys(f)).toEqual(keys(f));
  });
});

describe('a rate is never printed over too few observations', () => {
  it('withholds the on-time rate below the minimum and says so', () => {
    const f = facts({
      delivery: { ...facts().delivery, completedWithDueDate: MIN_OBSERVATIONS - 1, completedOnTime: 0 },
    });
    expect(keys(f)).toContain('current_work.on_time_insufficient');
    expect(keys(f)).not.toContain('current_work.on_time_rate');
  });

  it('reports the rate once the minimum is reached', () => {
    const f = facts({
      delivery: { ...facts().delivery, completedWithDueDate: MIN_OBSERVATIONS, completedOnTime: 3 },
    });
    expect(keys(f)).toContain('current_work.on_time_rate');
  });

  it('withholds every submission rate when too few working days are recorded', () => {
    const f = facts({ submission: { ...facts().submission, expectedDays: 2, filedDays: 1 } });
    const section = signalsInSection(signalsFor(f, NOW), 'submission_patterns');
    expect(section.map((s) => s.key)).toEqual(['submission.insufficient']);
  });

  it('claims less confidence the fewer observations there are', () => {
    expect(rateConfidence(25)).toBeGreaterThan(rateConfidence(10));
    expect(rateConfidence(10)).toBeGreaterThan(rateConfidence(5));
    expect(rateConfidence(1)).toBeLessThan(rateConfidence(MIN_OBSERVATIONS));
  });
});

describe('a failed read is never presented as a zero', () => {
  it('emits nothing for an area that could not be read', () => {
    const f = facts({ readFailures: ['submission'] });
    expect(signalsInSection(signalsFor(f, NOW), 'submission_patterns')).toHaveLength(0);
    // and the rest of the page is unaffected
    expect(keys(f)).toContain('current_work.open_load');
  });

  it('says the read failed rather than that nothing happened', () => {
    const f = facts({ readFailures: ['submission'] });
    expect(emptySectionSentence('submission_patterns', f)).toContain('could not be read');
    expect(emptySectionSentence('submission_patterns', facts())).not.toContain('could not be read');
  });

  it('suppresses a strength that depends on an area that failed', () => {
    const f = facts({ readFailures: ['delivery', 'submission', 'rework', 'stated'] });
    expect(signalsInSection(signalsFor(f, NOW), 'strengths')).toHaveLength(0);
  });
});

describe('what a manager is allowed to be told about conduct', () => {
  it('reports a count and names count_only as the source', () => {
    const f = facts({ behaviour: { ...facts().behaviour, informalConductNotes: 2 } });
    const s = signalsFor(f, NOW).find((x) => x.key === 'behaviour.conduct_notes');
    expect(s).toBeTruthy();
    expect(s!.inputs[0].source).toBe('hr_employee_flags:count_only');
    expect(s!.output).toBe('2 on record');
    // The detail must send them to HR rather than invite them to act on the count.
    expect(s!.detail).toContain('HR');
  });

  it('says nothing at all when there are none', () => {
    expect(keys(facts())).not.toContain('behaviour.conduct_notes');
  });
});

describe('strengths and development areas are held to the same bar', () => {
  it('names a strength when delivery is strong over enough dated work', () => {
    expect(keys(facts())).toContain('strength.on_time_delivery');
  });

  it('raises a development area only over the same minimum', () => {
    const thin = facts({
      delivery: { ...facts().delivery, completedWithDueDate: 2, completedOnTime: 0 },
    });
    expect(keys(thin)).not.toContain('development.dated_delivery');

    const thick = facts({
      delivery: { ...facts().delivery, completedWithDueDate: 10, completedOnTime: 2 },
    });
    expect(keys(thick)).toContain('development.dated_delivery');
  });

  it('marks a colleague-written note as stated, not demonstrated', () => {
    const f = facts({ stated: { ...facts().stated, strengthNotes: 2 } });
    const s = signalsFor(f, NOW).find((x) => x.key === 'strength.stated_by_colleagues');
    expect(s!.evidenceStrength).toBe('stated');
  });

  it('marks the team-load comparison as derived, not demonstrated', () => {
    const f = facts({
      capacity: { ...facts().capacity, activeAssignments: 12, teamMeanAssignments: 4, teamSize: 5 },
    });
    const s = signalsFor(f, NOW).find((x) => x.key === 'capacity.above_team_load');
    expect(s!.evidenceStrength).toBe('derived');
  });
});

describe('blocked work distinguishes a stated cause from none', () => {
  it('asks for attention only when a cause is missing', () => {
    const withCause = facts({
      delivery: { ...facts().delivery, blocked: 2, blockedWithStatedReason: 2 },
    });
    const noCause = facts({
      delivery: { ...facts().delivery, blocked: 2, blockedWithStatedReason: 0 },
    });
    expect(signalsFor(withCause, NOW).find((s) => s.key === 'current_work.blocked')!.direction).toBe('neutral');
    expect(signalsFor(noCause, NOW).find((s) => s.key === 'current_work.blocked')!.direction).toBe('attention');
  });
});
