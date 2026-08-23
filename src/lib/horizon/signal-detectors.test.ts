// The four detectors, and the rule that a detector only ever proposes.
//
// Every case here is one person's timeline built by hand and run through the real detector and the
// real admission gate — so a passing test is a statement about what would actually be raised, not
// about what a detector returned before the contract had its say.
import { describe, it, expect } from 'vitest';
import type { HrEvent } from '@/lib/hr-events';
import { employeeSubject } from '@/lib/horizon';
import { DETECTORS, runDetectors, evidenceFromEvent, daysAgo } from './signal-detectors';
import { admit } from './signal-contract';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const EMP = '11111111-1111-1111-1111-111111111111';
const SUBJECT = employeeSubject(EMP as any);

let seq = 0;
function mk(type: string, days: number, assertion = 'factual'): HrEvent {
  seq += 1;
  const at = daysAgo(NOW, days).toISOString();
  return {
    id: '00000000-0000-0000-0000-' + String(100000000000 + seq),
    type,
    label: type,
    subject: { employeeId: EMP, applicationId: null, userId: null },
    actorUserId: null,
    actorKind: 'system',
    sourceModule: 'test',
    recordRef: null,
    payload: {},
    assertion,
    assertionLabel: assertion,
    occurredAt: at,
    recordedAt: at,
    correlationId: null,
  } as HrEvent;
}

function run(events: HrEvent[], keys?: string[]) {
  return runDetectors({ subject: SUBJECT, events, now: NOW }, keys);
}

function only(events: HrEvent[], key: string) {
  return run(events, [key]).candidates;
}

// -------------------------------------------------------------------------------------------------
describe('an event becomes evidence at the strength the log says it has', () => {
  it('reads a verified skill as demonstrated capability evidence', () => {
    const e = evidenceFromEvent(mk('SkillVerified', 5, 'verified'), 0.8, 'test');
    expect(e?.sourceType).toBe('capability_evidence');
    expect(e?.evidenceClass).toBe('demonstrated');
  });

  it('caps a merely stated fact, however good the event type usually is', () => {
    const e = evidenceFromEvent(mk('CourseCompleted', 5, 'explicitly_provided'), 0.8, 'test');
    expect(e?.evidenceClass).toBe('stated');
  });

  it('records a derived row as a computation, so it cannot launder itself into demonstrated evidence', () => {
    const e = evidenceFromEvent(mk('CourseCompleted', 5, 'calculated'), 0.8, 'test');
    expect(e?.sourceType).toBe('system_computation');
    expect(e?.evidenceClass).toBe('inferred');
  });

  it('points at the row it came from, and collects it as an ordinary organisational record', () => {
    const ev = mk('CourseCompleted', 5);
    const e = evidenceFromEvent(ev, 0.8, 'test');
    expect(e?.sourceId).toBe(ev.id);
    expect(e?.rawReference.table).toBe('hr_events');
    // Rule 26: the vocabulary has no member meaning "covertly", and nothing here invents one.
    expect(e?.collectedUnder).toBe('organisational_record');
  });
});

// -------------------------------------------------------------------------------------------------
describe('growth alignment', () => {
  it('says nothing about an empty timeline', () => {
    expect(only([], 'growth_alignment').length).toBe(0);
  });

  it('says nothing when there is learning but no recorded direction', () => {
    expect(only([mk('CourseCompleted', 10), mk('SkillVerified', 20, 'verified')], 'growth_alignment').length).toBe(0);
  });

  it('raises an Opportunity when learning and objectives moved together', () => {
    const events = [mk('CourseCompleted', 10), mk('SkillVerified', 20, 'verified'), mk('GoalCreated', 40)];
    const [c] = only(events, 'growth_alignment');
    expect(c.title).toBe('Strong Growth Alignment Detected');
    expect(c.band).toBe('green');
    expect(c.category).toBe('growth_opportunity');
    expect(c.dimension).toBe('direction');
    const r = admit(c, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.band).toBe('green');
  });

  it('ignores what happened outside its window', () => {
    const events = [mk('CourseCompleted', 200), mk('SkillVerified', 210, 'verified'), mk('GoalCreated', 220)];
    expect(only(events, 'growth_alignment').length).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe('leadership development', () => {
  const qualifying = [
    mk('SkillVerified', 20, 'verified'),
    mk('SkillVerified', 60, 'verified'),
    mk('PerformanceReviewCompleted', 30),
  ];

  it('raises Growth when capability was evidenced and responsibility did not move', () => {
    const [c] = only(qualifying, 'leadership_development');
    expect(c.title).toBe('Leadership Development Opportunity');
    expect(c.band).toBe('blue');
    // It admits it could be quoted in a promotion discussion, which buys it the stricter floor.
    expect(c.touchesDecision).toBe('promotion');
  });

  it('is admitted, because verified skills are demonstrated records', () => {
    const r = admit(only(qualifying, 'leadership_development')[0], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.humanReviewRequired).toBe(true);
      expect(r.signal.reviewerKind).toBe('hr');
    }
  });

  it('says nothing once responsibility has actually changed', () => {
    expect(only(qualifying.concat([mk('EmployeePromoted', 15)]), 'leadership_development').length).toBe(0);
  });

  it('does not count a skill somebody merely stated', () => {
    const stated = [
      mk('SkillVerified', 20, 'explicitly_provided'),
      mk('SkillVerified', 60, 'explicitly_provided'),
      mk('PerformanceReviewCompleted', 30, 'explicitly_provided'),
    ];
    // The detector still sees the shape; the CONTRACT is what refuses it, because nothing in it is
    // demonstrated and it is marked as touching a promotion.
    const r = admit(only(stated, 'leadership_development')[0], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('no demonstrated or observed evidence');
  });
});

// -------------------------------------------------------------------------------------------------
describe('submission consistency', () => {
  it('will not speak from a baseline too thin to support it', () => {
    expect(only([mk('CourseCompleted', 50), mk('CourseCompleted', 70)], 'submission_consistency').length).toBe(0);
  });

  it('raises a Watch when the recent rate falls below half the baseline', () => {
    const events = [40, 45, 55, 65, 75, 85].map((d) => mk('CourseCompleted', d));
    const [c] = only(events, 'submission_consistency');
    expect(c.title).toBe('Submission Consistency Change Detected');
    expect(c.band).toBe('yellow');
    expect(c.category).toBe('reliability');
    expect(c.whatChanged).toContain('%');
    // It recommends asking, never a consequence.
    expect(c.recommendedActions[0].key).toBe('ask_what_changed');
    expect(admit(c, NOW).ok).toBe(true);
  });

  it('says nothing when the rate held', () => {
    const events = [5, 10, 15, 40, 50, 70].map((d) => mk('CourseCompleted', d));
    expect(only(events, 'submission_consistency').length).toBe(0);
  });

  it('names what it counted, so "delivery fell" means something', () => {
    const events = [40, 45, 55, 65].map((d) => mk('CourseCompleted', d));
    expect(only(events, 'submission_consistency')[0].inputs[0].description).toContain('completed courses');
  });
});

// -------------------------------------------------------------------------------------------------
describe('workload sustainability', () => {
  function delivery(count: number, spreadDays: number): HrEvent[] {
    const out: HrEvent[] = [];
    for (let i = 0; i < count; i += 1) out.push(mk('CourseCompleted', Math.round((i * spreadDays) / count) + 1));
    return out;
  }

  it('says nothing at an ordinary rate', () => {
    expect(only(delivery(6, 90), 'workload_sustainability').length).toBe(0);
  });

  it('says nothing when leave was actually taken', () => {
    expect(only(delivery(30, 90).concat([mk('LeaveApproved', 20)]), 'workload_sustainability').length).toBe(0);
  });

  it('raises a Watch on a sustained rate with no leave on record', () => {
    const [c] = only(delivery(24, 90), 'workload_sustainability');
    expect(c.title).toBe('Workload Sustainability Watch');
    expect(c.band).toBe('yellow');
    expect(c.category).toBe('workload');
  });

  it('asks for Attention when the pattern has held for six months, and gets it on real records', () => {
    const [c] = only(delivery(48, 180), 'workload_sustainability');
    expect(c.band).toBe('red');
    const r = admit(c, NOW);
    expect(r.ok).toBe(true);
    // Training records plus the derived rate are two distinct source types, one of them demonstrated.
    if (r.ok) {
      expect(r.signal.band).toBe('red');
      expect(r.signal.severity).toBe('high');
    }
  });

  it('never says anything about anybody’s health', () => {
    const [c] = only(delivery(48, 180), 'workload_sustainability');
    const text = [c.title, c.whatChanged, c.processing].concat(c.recommendedActions.map((a) => a.label)).join(' ').toLowerCase();
    for (const word of ['burnout', 'burn out', 'stress', 'exhaust', 'unwell', 'mental', 'depress', 'anxiet']) {
      expect(text.includes(word)).toBe(false);
    }
    expect(text).toContain('record');
  });
});

// -------------------------------------------------------------------------------------------------
describe('the registry', () => {
  it('gives every detector a key, a version and a stated rule', () => {
    for (const d of DETECTORS) {
      expect(d.key.length).toBeGreaterThan(2);
      expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });

  it('has no two detectors sharing a key', () => {
    const keys = DETECTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('addresses every recommended action to a person rather than to a handler', () => {
    const events = [
      mk('CourseCompleted', 10),
      mk('SkillVerified', 20, 'verified'),
      mk('SkillVerified', 60, 'verified'),
      mk('GoalCreated', 40),
      mk('PerformanceReviewCompleted', 30),
    ];
    const { candidates, errors } = run(events);
    expect(errors.length).toBe(0);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.recommendedActions.length).toBeGreaterThan(0);
      for (const a of c.recommendedActions) {
        expect(['subject', 'reporting_manager', 'department_head', 'hr_operations', 'hr_leadership']).toContain(
          a.addressedTo,
        );
      }
      const r = admit(c, NOW);
      if (!r.ok) expect(r.refusals.length).toBeGreaterThan(0);
      else expect(r.signal.dedupeKey.length).toBeGreaterThan(0);
    }
  });
});
