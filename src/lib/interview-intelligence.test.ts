// Tests for Patch 09, the interview intelligence layer.
//
// Every one of them is really defending the same thing: THE COST OF A WRONG ANSWER HERE IS A
// SENTENCE ABOUT SOMEBODY WHO IS BEING CONSIDERED FOR A JOB.
//
// The properties under test:
//   1. NOTHING PRODUCES A VERDICT. No function returns a hire word, a rank or a number about a
//      person, on any input.
//   2. THE SAME FACTS PRODUCE THE SAME BRIEF. Probes and contradictions are deterministic, so two
//      interviewers reading the same record are told the same thing.
//   3. A CONTRADICTION IS TWO ROWS THAT DISAGREE, and an absence is never one of them.
//   4. WHAT WAS OBSERVED OVERRIDES WHAT WAS PREDICTED, and only an observation of the capability
//      itself can do it.
//   5. A DISAGREEMENT BETWEEN TWO INTERVIEWERS IS AN OUTCOME, not something resolved by picking one.
//   6. AN UNREADABLE RECORD IS NEVER PHRASED AS AN ABSENCE.
import { describe, it, expect } from 'vitest';
import {
  probeFor,
  sortProbes,
  findContradictions,
  reconcileRequirement,
  toGraphVerdict,
  requiresConditions,
  isIntelRecommendation,
  isIntelDimension,
  isEvidentialDimension,
  isAlignment,
  INTEL_RECOMMENDATIONS,
  INTEL_DIMENSIONS,
  ALIGNMENTS,
  BRIEF_REFUSES_A_VERDICT,
  type Probe,
  type ContradictionInput,
} from './interview-intelligence';

/* ------------------------------------------------------------------------------------ fixtures */

const req = (over: Partial<{ skillId: string; skillName: string; necessity: any; minLevel: number | null }> = {}) => ({
  skillId: '11111111-1111-4111-8111-111111111111',
  skillName: 'Statistical modelling',
  necessity: 'essential' as any,
  minLevel: null as number | null,
  ...over,
});

const obs = (over: Partial<{ id: string; interviewerName: string; outcome: any; dimension: string; observation: string; recordedAt: string | null }> = {}) => ({
  id: 'o1',
  interviewerName: 'Asha',
  outcome: 'supports' as any,
  dimension: 'technical',
  observation: 'Walked through a model they built and why they rejected the simpler one.',
  recordedAt: '2026-08-23T10:00:00Z',
  ...over,
});

const emptyInput = (): ContradictionInput => ({
  requirements: [],
  coverage: [],
  priorScorecards: [],
  priorObservations: [],
});

/** Words that must never appear in anything this module generates about a person. */
const VERDICT_WORDS = ['hire', 'reject', 'unsuitable', 'unfit', 'best candidate', 'top candidate'];

function assertNoVerdict(text: string) {
  const lower = text.toLowerCase();
  for (const w of VERDICT_WORDS) expect(lower.includes(w)).toBe(false);
}

/* ------------------------------------------------------------------------------- 1. no verdict */

describe('nothing here produces a verdict', () => {
  it('no probe on any coverage state contains a hire or reject word', () => {
    const states = ['evidenced', 'stated', 'related', 'nothing', 'unreadable'] as const;
    const necessities = ['essential', 'important', 'helpful'] as const;
    for (const status of states) {
      for (const necessity of necessities) {
        const p = probeFor(req({ necessity }), { status, level: 3 });
        assertNoVerdict(p.why);
        assertNoVerdict(p.prompt);
      }
    }
  });

  it('the brief prints a refusal where a reader expects an outcome', () => {
    expect(BRIEF_REFUSES_A_VERDICT.length).toBeGreaterThan(80);
    assertNoVerdict(BRIEF_REFUSES_A_VERDICT.replace(/hiring screens/gi, ''));
  });

  it('no probe carries a score, a rank or a percentage', () => {
    const p = probeFor(req(), { status: 'stated', level: null });
    expect(Object.keys(p)).not.toContain('score');
    expect(Object.keys(p)).not.toContain('rank');
    expect(p.why + p.prompt).not.toMatch(/%/);
  });

  it('the five recommendations are the five the process defines, and are not the scorecard four', () => {
    expect(INTEL_RECOMMENDATIONS.map((r) => r.key)).toEqual([
      'strongly_recommend',
      'recommend',
      'recommend_with_conditions',
      'further_assessment_required',
      'do_not_recommend',
    ]);
    // The scorecard's own four must not be accepted here: two parallel scales that quietly accept
    // each other's values is how a "no hire" ends up stored as a recommendation nobody can read.
    for (const scorecardValue of ['strong_hire', 'hire', 'no_hire', 'strong_no_hire']) {
      expect(isIntelRecommendation(scorecardValue)).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------- 2. deterministic */

describe('the same facts produce the same brief', () => {
  it('probeFor is deterministic', () => {
    const a = probeFor(req(), { status: 'stated', level: null });
    const b = probeFor(req(), { status: 'stated', level: null });
    expect(a).toEqual(b);
  });

  it('findContradictions returns the same list in the same order twice', () => {
    const input: ContradictionInput = {
      ...emptyInput(),
      priorScorecards: [
        { roundNumber: 2, interviewerName: 'Bo', recommendation: 'hire' },
        { roundNumber: 1, interviewerName: 'Asha', recommendation: 'no_hire' },
        { roundNumber: 2, interviewerName: 'Cy', recommendation: 'strong_no_hire' },
      ],
    };
    expect(findContradictions(input)).toEqual(findContradictions(input));
  });

  it('sortProbes puts what must be validated first and is stable', () => {
    const probes: Probe[] = [
      probeFor(req({ skillId: 'a', skillName: 'Zeta', necessity: 'helpful' }), { status: 'evidenced', level: 4 }),
      probeFor(req({ skillId: 'b', skillName: 'Alpha', necessity: 'essential' }), { status: 'nothing', level: null }),
      probeFor(req({ skillId: 'c', skillName: 'Beta', necessity: 'important' }), { status: 'stated', level: null }),
    ];
    const sorted = sortProbes(probes);
    expect(sorted[0].priority).toBe('must_validate');
    expect(sorted[0].skillName).toBe('Alpha');
    expect(sorted[2].priority).toBe('confirm_briefly');
    expect(sortProbes(probes)).toEqual(sorted);
  });
});

/* ------------------------------------------------------------------------------- 3. the probes */

describe('probes follow the gap and nothing else', () => {
  it('an essential requirement with nothing on record must be validated', () => {
    const p = probeFor(req({ necessity: 'essential' }), { status: 'nothing', level: null });
    expect(p.priority).toBe('must_validate');
  });

  it('an already evidenced requirement is confirmed briefly, not re-established', () => {
    const p = probeFor(req(), { status: 'evidenced', level: 4 });
    expect(p.priority).toBe('confirm_briefly');
  });

  it('evidenced below the minimum the role records is still a must-validate', () => {
    const p = probeFor(req({ minLevel: 4 }), { status: 'evidenced', level: 2 });
    expect(p.priority).toBe('must_validate');
    expect(p.why).toContain('level 2');
    expect(p.why).toContain('asks for 4');
  });

  it('evidenced at or above the minimum is not treated as a shortfall', () => {
    expect(probeFor(req({ minLevel: 3 }), { status: 'evidenced', level: 3 }).priority).toBe('confirm_briefly');
    expect(probeFor(req({ minLevel: 3 }), { status: 'evidenced', level: 5 }).priority).toBe('confirm_briefly');
  });

  it('a helpful requirement never escalates to must-validate', () => {
    for (const status of ['stated', 'related', 'nothing'] as const) {
      expect(probeFor(req({ necessity: 'helpful' }), { status, level: null }).priority).toBe('confirm_briefly');
    }
  });

  it('a missing coverage row is treated as nothing on record, not as an error', () => {
    const p = probeFor(req(), null);
    expect(p.status).toBe('nothing');
    expect(p.priority).toBe('must_validate');
  });
});

/* ------------------------------------------------------------- 6. unreadable is not an absence */

describe('an unreadable record is never phrased as an absence', () => {
  it('says the record could not be read, and says it is not a gap in the person', () => {
    const p = probeFor(req(), { status: 'unreadable', level: null });
    expect(p.why.toLowerCase()).toContain('could not be read');
    expect(p.why.toLowerCase()).toContain('not a gap in this person');
    expect(p.prompt.toLowerCase()).toContain('do not treat');
  });
});

/* ------------------------------------------------------------------------- 3. contradictions */

describe('a contradiction is two stored rows that disagree', () => {
  it('nothing in, nothing out', () => {
    expect(findContradictions(emptyInput())).toEqual([]);
  });

  it('nothing on record for an essential requirement is NOT a contradiction', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req({ necessity: 'essential' })],
      coverage: [{ skillId: req().skillId, status: 'nothing', level: null }],
    });
    expect(found).toEqual([]);
  });

  it('a stated-but-not-evidenced requirement is NOT a contradiction on its own', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req()],
      coverage: [{ skillId: req().skillId, status: 'stated', level: null }],
    });
    expect(found).toEqual([]);
  });

  it('a recorded level under the role minimum is one, and names both numbers', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req({ minLevel: 4 })],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 2 }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('recorded_level_below_requirement');
    expect(found[0].evidence).toHaveLength(2);
    expect(found[0].whatToDo.length).toBeGreaterThan(20);
  });

  it('a level equal to the minimum is not one', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req({ minLevel: 3 })],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 3 }],
    });
    expect(found).toEqual([]);
  });

  it('no minimum recorded means no shortfall can be claimed', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req({ minLevel: null })],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 1 }],
    });
    expect(found).toEqual([]);
  });

  it('an earlier round that recommended against proceeding is surfaced', () => {
    const found = findContradictions({
      ...emptyInput(),
      priorScorecards: [{ roundNumber: 1, interviewerName: 'Asha', recommendation: 'no_hire' }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('earlier_round_recommended_against');
    expect(found[0].headline).toContain('Asha');
  });

  it('an earlier round that recommended proceeding is not surfaced as a contradiction', () => {
    const found = findContradictions({
      ...emptyInput(),
      priorScorecards: [{ roundNumber: 1, interviewerName: 'Asha', recommendation: 'strong_hire' }],
    });
    expect(found).toEqual([]);
  });

  it('a split panel on one earlier round is surfaced once, naming both sides', () => {
    const found = findContradictions({
      ...emptyInput(),
      priorScorecards: [
        { roundNumber: 1, interviewerName: 'Asha', recommendation: 'hire' },
        { roundNumber: 1, interviewerName: 'Bo', recommendation: 'no_hire' },
      ],
    });
    const splits = found.filter((f) => f.kind === 'panel_split_on_an_earlier_round');
    expect(splits).toHaveLength(1);
    expect(splits[0].evidence.join(' ')).toContain('Asha');
    expect(splits[0].evidence.join(' ')).toContain('Bo');
  });

  it('a unanimous earlier round is not a split', () => {
    const found = findContradictions({
      ...emptyInput(),
      priorScorecards: [
        { roundNumber: 1, interviewerName: 'Asha', recommendation: 'hire' },
        { roundNumber: 1, interviewerName: 'Bo', recommendation: 'strong_hire' },
      ],
    });
    expect(found.filter((f) => f.kind === 'panel_split_on_an_earlier_round')).toEqual([]);
  });

  it('an earlier contradicting observation against a still-evidenced requirement is surfaced', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req()],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 4 }],
      priorObservations: [{
        roundNumber: 1,
        interviewerName: 'Asha',
        skillId: req().skillId,
        skillName: req().skillName,
        outcome: 'contradicts',
        observation: 'Could not describe how the model was validated.',
      }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('earlier_observation_contradicts');
    expect(found[0].evidence[0]).toContain('Asha');
  });

  it('an earlier contradicting observation against something nothing supports is not surfaced', () => {
    // There is no disagreement to report: the record already says nothing supports it.
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req()],
      coverage: [{ skillId: req().skillId, status: 'nothing', level: null }],
      priorObservations: [{
        roundNumber: 1,
        interviewerName: 'Asha',
        skillId: req().skillId,
        skillName: req().skillName,
        outcome: 'contradicts',
        observation: 'Could not describe how the model was validated.',
      }],
    });
    expect(found).toEqual([]);
  });

  it('a supporting earlier observation is never a contradiction', () => {
    const found = findContradictions({
      ...emptyInput(),
      requirements: [req()],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 4 }],
      priorObservations: [{
        roundNumber: 1,
        interviewerName: 'Asha',
        skillId: req().skillId,
        skillName: req().skillName,
        outcome: 'supports',
        observation: 'Described the validation in detail.',
      }],
    });
    expect(found).toEqual([]);
  });

  it('every contradiction carries at least one evidence line', () => {
    const found = findContradictions({
      requirements: [req({ minLevel: 5 })],
      coverage: [{ skillId: req().skillId, status: 'evidenced', level: 1 }],
      priorScorecards: [
        { roundNumber: 1, interviewerName: 'Asha', recommendation: 'no_hire' },
        { roundNumber: 1, interviewerName: 'Bo', recommendation: 'hire' },
      ],
      priorObservations: [],
    });
    expect(found.length).toBeGreaterThan(1);
    for (const f of found) expect(f.evidence.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ 4 & 5. predicted vs actual */

describe('what was observed overrides what was predicted', () => {
  const r = { skillId: req().skillId, skillName: 'Statistical modelling', necessity: 'essential' as any };

  it('no observation means not examined, and the prediction is not overridden', () => {
    const out = reconcileRequirement(r, 'stated', []);
    expect(out.state).toBe('not_examined');
    expect(out.overrides).toBe(false);
    expect(out.sentence).toContain('not the same as being found absent');
  });

  it('a supporting technical observation supersedes "nothing on record"', () => {
    const out = reconcileRequirement(r, 'nothing', [obs()]);
    expect(out.state).toBe('demonstrated_in_interview');
    expect(out.overrides).toBe(true);
    expect(out.sentence).toContain('supersedes');
    expect(out.sentence).toContain('Asha');
  });

  it('a supporting observation that agrees with an evidenced record is not an override', () => {
    const out = reconcileRequirement(r, 'evidenced', [obs()]);
    expect(out.state).toBe('demonstrated_in_interview');
    expect(out.overrides).toBe(false);
    expect(out.sentence).toContain('agrees with it');
  });

  it('a contradicting observation supersedes an evidenced record', () => {
    const out = reconcileRequirement(r, 'evidenced', [obs({ outcome: 'contradicts' })]);
    expect(out.state).toBe('contradicted_in_interview');
    expect(out.overrides).toBe(true);
  });

  it('a communication observation is kept but cannot supersede anything', () => {
    const out = reconcileRequirement(r, 'nothing', [obs({ dimension: 'communication' })]);
    expect(out.state).toBe('not_examined');
    expect(out.overrides).toBe(false);
    // It is still shown. Nothing an interviewer wrote is hidden from the comparison.
    expect(out.observations).toHaveLength(1);
  });

  it('a competency observation can supersede, because it observes the capability itself', () => {
    const out = reconcileRequirement(r, 'stated', [obs({ dimension: 'competency' })]);
    expect(out.state).toBe('demonstrated_in_interview');
    expect(out.overrides).toBe(true);
  });

  it('an inconclusive observation settles nothing', () => {
    const out = reconcileRequirement(r, 'stated', [obs({ outcome: 'inconclusive' })]);
    expect(out.state).toBe('not_examined');
    expect(out.overrides).toBe(false);
  });

  it('two interviewers disagreeing is an outcome, and neither of them wins', () => {
    const out = reconcileRequirement(r, 'evidenced', [
      obs({ id: 'o1', interviewerName: 'Asha', outcome: 'supports' }),
      obs({ id: 'o2', interviewerName: 'Bo', outcome: 'contradicts' }),
    ]);
    expect(out.state).toBe('interviewers_disagree');
    // NOT an override. A disagreement supersedes nothing — it is unresolved — and counting it as an
    // override would let the console report that the interview settled something it did not.
    expect(out.overrides).toBe(false);
    expect(out.sentence).toContain('Asha');
    expect(out.sentence).toContain('Bo');
    expect(out.sentence).toContain('not resolved here');
  });

  it('an unreadable prediction is not something the room can override', () => {
    const out = reconcileRequirement(r, 'unreadable', [obs()]);
    expect(out.state).toBe('demonstrated_in_interview');
    expect(out.overrides).toBe(false);
    expect(out.sentence).toContain('could not be read');
    expect(out.sentence).not.toContain('supersedes');
  });

  it('a contradiction overrides a prediction that leaned on a related capability', () => {
    const out = reconcileRequirement(r, 'related', [obs({ outcome: 'contradicts' })]);
    expect(out.state).toBe('contradicted_in_interview');
    expect(out.overrides).toBe(true);
  });

  it('a contradiction of something nothing supported overrides nothing', () => {
    // The record said nothing and the room said no. They agree; there is no prediction to defeat.
    const out = reconcileRequirement(r, 'nothing', [obs({ outcome: 'contradicts' })]);
    expect(out.state).toBe('contradicted_in_interview');
    expect(out.overrides).toBe(false);
  });

  it('the later observation does not silently win a disagreement', () => {
    const first = reconcileRequirement(r, 'evidenced', [
      obs({ id: 'o1', interviewerName: 'Asha', outcome: 'supports', recordedAt: '2026-08-23T10:00:00Z' }),
      obs({ id: 'o2', interviewerName: 'Bo', outcome: 'contradicts', recordedAt: '2026-08-23T11:00:00Z' }),
    ]);
    const reversed = reconcileRequirement(r, 'evidenced', [
      obs({ id: 'o2', interviewerName: 'Bo', outcome: 'contradicts', recordedAt: '2026-08-23T11:00:00Z' }),
      obs({ id: 'o1', interviewerName: 'Asha', outcome: 'supports', recordedAt: '2026-08-23T10:00:00Z' }),
    ]);
    expect(first.state).toBe(reversed.state);
    expect(first.overrides).toBe(reversed.overrides);
  });

  it('the prediction is always carried beside the outcome, never replaced by it', () => {
    const out = reconcileRequirement(r, 'stated', [obs()]);
    expect(out.predictedStatus).toBe('stated');
    expect(out.predictedLabel.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------------- vocabularies */

describe('the vocabularies are closed sets', () => {
  it('rejects a dimension nobody defined', () => {
    expect(isIntelDimension('vibes')).toBe(false);
    expect(isIntelDimension('technical')).toBe(true);
  });

  it('marks exactly the two dimensions that observe a capability as evidential', () => {
    const evidential = INTEL_DIMENSIONS.filter((d) => d.evidential).map((d) => d.key);
    expect(evidential).toEqual(['competency', 'technical']);
    expect(isEvidentialDimension('strength')).toBe(false);
  });

  it('covers all eight capture dimensions the process defines', () => {
    expect(INTEL_DIMENSIONS.map((d) => d.key)).toEqual([
      'competency', 'technical', 'behavioural', 'communication',
      'role_understanding', 'observation', 'strength', 'concern',
    ]);
  });

  it('rejects an alignment value nobody defined', () => {
    expect(isAlignment('probably')).toBe(false);
    for (const a of ALIGNMENTS) expect(isAlignment(a.key)).toBe(true);
  });

  it('obliges a written condition on exactly the two recommendations that name one', () => {
    expect(requiresConditions('recommend_with_conditions')).toBe(true);
    expect(requiresConditions('further_assessment_required')).toBe(true);
    expect(requiresConditions('recommend')).toBe(false);
    expect(requiresConditions('do_not_recommend')).toBe(false);
    expect(requiresConditions('strongly_recommend')).toBe(false);
  });

  it('maps this module\'s wording onto the capability graph\'s verdicts', () => {
    expect(toGraphVerdict('supports')).toBe('supports');
    expect(toGraphVerdict('contradicts')).toBe('does_not_support');
    expect(toGraphVerdict('inconclusive')).toBe('insufficient');
  });
});
