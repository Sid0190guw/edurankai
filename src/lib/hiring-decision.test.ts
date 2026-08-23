// src/lib/hiring-decision.test.ts — the decision-support rules, exercised with no database.
//
// THE IMPORT IS THE FIRST ASSERTION. src/lib/hiring-decision.ts runs assertNoFoundational() at
// module load, so if anybody ever adds `dob`, `birth_time` or `birth_place` to APPLICATION_FIELDS,
// this file fails at COLLECTION — before a single test runs — with the sentence explaining why. That
// is the intended behaviour and it is worth knowing when it happens.
//
// Everything exercised here is pure: no db handle is created, no query is issued, and no
// DATABASE_URL is required.
import { describe, it, expect } from 'vitest';
import {
  APPLICATION_FIELDS,
  FOUNDATIONAL_FIELDS,
  SUPPORT_STATES,
  SUPPORT_STATE_LABELS,
  SUPPORT_STATE_MEANING,
  SUPPORT_RULE_TEXT,
  FINAL_DECISIONS,
  FINAL_DECISION_LABELS,
  DECISION_STAGE_PAIRS,
  SIGNAL_WEIGHT_LABELS,
  isSupportState,
  isFinalDecision,
  stageForDecision,
  supportStateFor,
  agreementAnalysis,
  screenCandidateFeedback,
  confidenceFrom,
  type ScorecardEvidence,
} from '@/lib/hiring-decision';
import { SCORECARD_DIMENSIONS } from '@/lib/interview-feedback';
import { STAGES, CLOSED_STAGES } from '@/lib/application-stages';

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

// `scores` is deliberately Omit-ted from the Partial before being redeclared: ScorecardEvidence
// carries scores as an ARRAY of {key,label,value}, and a helper that accepted both shapes would
// intersect them into a type no literal can satisfy.
type CardOverrides = Omit<Partial<ScorecardEvidence>, 'scores'> & {
  name: string;
  scores?: Record<string, number>;
};

const card = (over: CardOverrides): ScorecardEvidence => ({
  interviewId: '00000000-0000-4000-8000-000000000001',
  interviewerUserId: '00000000-0000-4000-8000-00000000000a',
  interviewerName: over.name,
  roundNumber: 1,
  roundType: 'technical',
  scores: SCORECARD_DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    value: over.scores && d.key in over.scores ? over.scores[d.key] : null,
  })),
  recommendation: over.recommendation ?? 'hire',
  recommendationLabel: 'Hire',
  strengths: null,
  concerns: null,
  submittedAt: '2026-08-01T00:00:00.000Z',
});

const ess = (name: string, status: any) => ({ skillName: name, status });

// -------------------------------------------------------------------------------------------------

describe('the columns this module will not read', () => {
  it('never allowlists a birth-derived column', () => {
    for (const f of FOUNDATIONAL_FIELDS) {
      expect(APPLICATION_FIELDS).not.toContain(f);
    }
  });

  it('names the three foundational columns explicitly, so the denylist cannot quietly shrink', () => {
    expect([...FOUNDATIONAL_FIELDS].sort()).toEqual(['birth_place', 'birth_time', 'dob']);
  });

  it('allowlists only columns that describe the application or the work', () => {
    // A spot check with teeth. The word boundaries are load-bearing: `age$` alone matches `stage`,
    // which is a funnel column and exactly the kind of false positive that gets a guard deleted.
    for (const f of APPLICATION_FIELDS) {
      expect(f).not.toMatch(/birth/i);
      expect(f).not.toMatch(/(^|_)(dob|gender|sex|caste|religion|marital|age|race|ethnicity)(_|$)/i);
    }
  });
});

describe('the vocabulary', () => {
  it('offers exactly the four support states the contract declares', () => {
    expect([...SUPPORT_STATES]).toEqual([
      'strong_hire_consideration',
      'hire_consideration',
      'further_review_required',
      'do_not_recommend_at_current_stage',
    ]);
  });

  it('offers exactly the four human decisions the contract declares', () => {
    expect([...FINAL_DECISIONS]).toEqual(['hire', 'reject', 'hold', 'next_stage']);
  });

  it('labels and explains every state and every decision', () => {
    for (const s of SUPPORT_STATES) {
      expect(SUPPORT_STATE_LABELS[s]).toBeTruthy();
      expect(SUPPORT_STATE_MEANING[s].length).toBeGreaterThan(40);
    }
    for (const d of FINAL_DECISIONS) expect(FINAL_DECISION_LABELS[d]).toBeTruthy();
  });

  it('recognises its own members and rejects everything else', () => {
    for (const s of SUPPORT_STATES) expect(isSupportState(s)).toBe(true);
    for (const bad of ['hire', 'STRONG_HIRE_CONSIDERATION', '', null, undefined, 7, {}]) {
      expect(isSupportState(bad)).toBe(false);
    }
    for (const d of FINAL_DECISIONS) expect(isFinalDecision(d)).toBe(true);
    for (const bad of ['selected', 'Hire', '', null, undefined]) expect(isFinalDecision(bad)).toBe(false);
  });

  it('keeps the support states and the human decisions as two disjoint vocabularies', () => {
    // If a value were ever in both, a computed state could be mistaken for a decision.
    for (const s of SUPPORT_STATES) expect(isFinalDecision(s)).toBe(false);
    for (const d of FINAL_DECISIONS) expect(isSupportState(d)).toBe(false);
  });

  it('names a weight label for every weight it emits', () => {
    for (const k of ['demonstrated', 'stated', 'single_observer', 'inferred'] as const) {
      expect(SIGNAL_WEIGHT_LABELS[k]).toBeTruthy();
    }
  });

  it('publishes the rule it applies, so a screen can print it', () => {
    expect(SUPPORT_RULE_TEXT.length).toBeGreaterThanOrEqual(5);
    expect(SUPPORT_RULE_TEXT.join(' ')).toMatch(/Further Review Required/);
  });
});

describe('the stage each decision proposes', () => {
  it('proposes only stages the funnel module actually knows', () => {
    const known = [...STAGES.map((s) => s.key), ...CLOSED_STAGES.map((s) => s.key)];
    for (const [, stage] of DECISION_STAGE_PAIRS) {
      if (stage !== null) expect(known).toContain(stage);
    }
  });

  it('never proposes onboarded for a hire — an offer made is not an offer signed', () => {
    expect(stageForDecision('hire')).toBe('decision');
    expect(stageForDecision('hire')).not.toBe('onboarded');
  });

  it('proposes no movement for hold or next_stage', () => {
    expect(stageForDecision('hold')).toBeNull();
    expect(stageForDecision('next_stage')).toBeNull();
  });

  it('covers every decision exactly once', () => {
    expect(DECISION_STAGE_PAIRS.map((p) => p[0]).sort()).toEqual([...FINAL_DECISIONS].sort());
  });
});

describe('supportStateFor — an outage is never a finding about a person', () => {
  it('returns Further Review Required when any input was unreadable, whatever else is on file', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'evidenced'), ess('SQL', 'evidenced')],
      desirable: [],
      recommendations: ['strong_hire', 'strong_hire', 'hire'],
      awaitingScorecards: 0,
      anyUnreadable: true,
      assessments: { passed: 3, total: 3 },
    });
    // A perfect record plus one failed read must NOT produce Strong Hire Consideration.
    expect(r.state).toBe('further_review_required');
    expect(r.because.join(' ')).toMatch(/could not be read/i);
  });

  it('returns Further Review Required when an essential requirement itself is unreadable', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'unreadable')],
      desirable: [],
      recommendations: ['hire', 'hire'],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 0, total: 0 },
    });
    expect(r.state).toBe('further_review_required');
  });

  it('never returns Do Not Recommend because of an outage', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'nothing'), ess('SQL', 'nothing')],
      desirable: [],
      recommendations: ['no_hire'],
      awaitingScorecards: 0,
      anyUnreadable: true,
      assessments: { passed: 0, total: 0 },
    });
    expect(r.state).toBe('further_review_required');
  });
});

describe('supportStateFor — an empty record supports nothing in either direction', () => {
  it('refuses to conclude when there are no requirements and no feedback', () => {
    const r = supportStateFor({
      essential: [], desirable: [], recommendations: [],
      awaitingScorecards: 0, anyUnreadable: false, assessments: { passed: 0, total: 0 },
    });
    expect(r.state).toBe('further_review_required');
    expect(r.because.join(' ')).toMatch(/nothing on file/i);
    expect(r.whatWouldChangeIt.length).toBeGreaterThan(0);
  });
});

describe('supportStateFor — demonstrated evidence outranks opinion', () => {
  it('reaches Strong Hire Consideration only when every essential requirement is EVIDENCED', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'evidenced'), ess('SQL', 'evidenced')],
      desirable: [ess('Figma', 'nothing')],
      recommendations: ['strong_hire', 'hire'],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 2, total: 2 },
    });
    expect(r.state).toBe('strong_hire_consideration');
  });

  it('refuses Strong Hire Consideration when an essential requirement is merely STATED', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'evidenced'), ess('SQL', 'stated')],
      desirable: [],
      recommendations: ['strong_hire', 'strong_hire', 'strong_hire'],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 5, total: 5 },
    });
    // Three strong hires cannot substitute for one missing platform record.
    expect(r.state).not.toBe('strong_hire_consideration');
    expect(r.state).toBe('hire_consideration');
  });

  it('refuses Strong Hire Consideration on a single observer, however positive', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'evidenced')],
      desirable: [],
      recommendations: ['strong_hire'],
      awaitingScorecards: 2,
      anyUnreadable: false,
      assessments: { passed: 1, total: 1 },
    });
    expect(r.state).toBe('hire_consideration');
    expect(r.whatWouldChangeIt.join(' ')).toMatch(/second interviewer/i);
  });

  it('will not reach Hire Consideration on stated evidence alone', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'stated'), ess('SQL', 'stated')],
      desirable: [],
      recommendations: ['hire', 'hire'],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 0, total: 0 },
    });
    expect(r.state).toBe('further_review_required');
    expect(r.because.join(' ')).toMatch(/claim/i);
  });
});

describe('supportStateFor — recommending against, and what it is bounded to', () => {
  it('reports Do Not Recommend at Current Stage when an interviewer recommends against', () => {
    const r = supportStateFor({
      essential: [ess('TypeScript', 'evidenced')],
      desirable: [],
      recommendations: ['hire', 'no_hire'],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 1, total: 1 },
    });
    expect(r.state).toBe('do_not_recommend_at_current_stage');
    // And it must say the panel disagreed rather than presenting it as settled.
    expect(r.because.join(' ')).toMatch(/disagreement|in favour/i);
  });

  it('bounds the negative state to the stage and the role, never to the person', () => {
    expect(SUPPORT_STATE_MEANING.do_not_recommend_at_current_stage).toMatch(/not a statement about the person/i);
    expect(SUPPORT_STATE_LABELS.do_not_recommend_at_current_stage).toMatch(/Current Stage/);
  });

  it('lists an essential gap as a blocker in words rather than folding it into anything', () => {
    const r = supportStateFor({
      essential: [ess('Structural engineering', 'nothing')],
      desirable: [],
      recommendations: [],
      awaitingScorecards: 0,
      anyUnreadable: false,
      assessments: { passed: 0, total: 0 },
    });
    expect(r.blockers.length).toBe(1);
    expect(r.blockers[0]).toMatch(/Structural engineering/);
    // The sentence must protect the candidate from being read as deficient.
    expect(r.blockers[0]).toMatch(/about our records, not about this person/i);
  });
});

describe('agreementAnalysis — disagreement is surfaced, never resolved', () => {
  it('reports a dimension spread instead of averaging it', () => {
    const a = agreementAnalysis({
      scorecards: [
        card({ name: 'Asha', scores: { technical_score: 5 } }),
        card({ name: 'Ben', scores: { technical_score: 2 } }),
      ],
      essential: [],
      assessments: { passed: 0, total: 0 },
    });
    const tech = a.dimensionSpreads.find((d) => d.key === 'technical_score');
    expect(tech?.spread).toBe(3);
    expect(a.contradictions.join(' ')).toMatch(/ranges from 2 to 5/);
    expect(a.contradictions.join(' ')).toMatch(/not a number to average/i);
  });

  it('names an outlier only when one scorer is two or more points from EVERY other', () => {
    const a = agreementAnalysis({
      scorecards: [
        card({ name: 'Asha', scores: { technical_score: 5 } }),
        card({ name: 'Ben', scores: { technical_score: 5 } }),
        card({ name: 'Chen', scores: { technical_score: 1 } }),
      ],
      essential: [],
      assessments: { passed: 0, total: 0 },
    });
    const tech = a.dimensionSpreads.find((d) => d.key === 'technical_score');
    expect(tech?.outlier?.interviewerName).toBe('Chen');
  });

  it('does not call the lowest scorer an outlier when the panel is merely spread out', () => {
    const a = agreementAnalysis({
      scorecards: [
        card({ name: 'Asha', scores: { technical_score: 5 } }),
        card({ name: 'Ben', scores: { technical_score: 4 } }),
        card({ name: 'Chen', scores: { technical_score: 3 } }),
      ],
      essential: [],
      assessments: { passed: 0, total: 0 },
    });
    const tech = a.dimensionSpreads.find((d) => d.key === 'technical_score');
    expect(tech?.outlier).toBeNull();
  });

  it('says in words when there is only one observer', () => {
    const a = agreementAnalysis({
      scorecards: [card({ name: 'Asha', scores: { technical_score: 5 } })],
      essential: [],
      assessments: { passed: 0, total: 0 },
    });
    expect(a.singleObserver).toBe(true);
    expect(a.sentence).toMatch(/one person's view/i);
  });

  it('contradicts a hire recommendation that sits over an essential requirement with nothing on record', () => {
    const a = agreementAnalysis({
      scorecards: [card({ name: 'Asha', recommendation: 'hire' })],
      essential: [ess('SQL', 'nothing')],
      assessments: { passed: 0, total: 0 },
    });
    expect(a.contradictions.join(' ')).toMatch(/nothing on record/i);
  });

  it('contradicts a no-hire recommendation that sits over fully evidenced requirements', () => {
    const a = agreementAnalysis({
      scorecards: [card({ name: 'Asha', recommendation: 'no_hire' })],
      essential: [ess('SQL', 'evidenced')],
      assessments: { passed: 0, total: 0 },
    });
    expect(a.contradictions.join(' ')).toMatch(/saw something the record does not hold/i);
  });

  it('reports a split panel as a split rather than as a majority', () => {
    const a = agreementAnalysis({
      scorecards: [
        card({ name: 'Asha', recommendation: 'hire' }),
        card({ name: 'Ben', recommendation: 'hire' }),
        card({ name: 'Chen', recommendation: 'no_hire' }),
      ],
      essential: [],
      assessments: { passed: 0, total: 0 },
    });
    expect(a.contradictions.join(' ')).toMatch(/panel is split/i);
    expect(a.contradictions.join(' ')).toMatch(/until somebody decides/i);
  });

  it('says nothing at all when there is no feedback, rather than manufacturing agreement', () => {
    const a = agreementAnalysis({ scorecards: [], essential: [], assessments: { passed: 0, total: 0 } });
    expect(a.agreements).toEqual([]);
    expect(a.contradictions).toEqual([]);
    expect(a.sentence).toMatch(/no interviewer has submitted/i);
  });
});

describe('screenCandidateFeedback — what a candidate may be told', () => {
  it('allows ordinary role-relevant feedback', () => {
    const r = screenCandidateFeedback(
      'The take-home did not handle concurrent writes, which this role does every day. '
      + 'We would look again after some production experience with transactional systems.',
    );
    expect(r.allowed).toBe(true);
    expect(r.caution).toBeNull();
  });

  it('refuses a birth-derived reason however it is worded', () => {
    for (const bad of [
      'Your birth chart suggests a poor fit for this team.',
      'The date of birth on file places you outside the band we hire into.',
      'Nakshatra compatibility with the team lead was the deciding factor.',
    ]) {
      const r = screenCandidateFeedback(bad);
      expect(r.allowed).toBe(false);
      expect(r.why).toMatch(/demonstrated, role-relevant|protected|sensitive/i);
    }
  });

  it('refuses a refused subject, including the one that sounds most reasonable', () => {
    const r = screenCandidateFeedback('Not a culture fit for this team.');
    expect(r.allowed).toBe(false);
    expect(r.why).toMatch(/protected-attribute proxy|culture fit/i);
  });

  it('refuses a bare protected attribute', () => {
    const r = screenCandidateFeedback('disability');
    expect(r.allowed).toBe(false);
  });

  it('allows a legitimate phrase that merely contains a protected word, and flags it for a human', () => {
    const r = screenCandidateFeedback(
      'We were looking for deeper accessibility engineering experience than the portfolio showed.',
    );
    expect(r.allowed).toBe(true);
  });

  it('treats blank feedback as allowed — a later sentence beats a wrong one', () => {
    expect(screenCandidateFeedback('').allowed).toBe(true);
    expect(screenCandidateFeedback('   ').allowed).toBe(true);
  });
});

describe('confidence is about our records, never about the person', () => {
  it('counts inputs that could be read, and says so', () => {
    const c = confidenceFrom([
      { name: 'a', read: 'ok' }, { name: 'b', read: 'ok' },
      { name: 'c', read: 'ok' }, { name: 'd', read: 'empty' },
    ]);
    expect(c.inputsRead).toBe(3);
    expect(c.inputsTotal).toBe(4);
    expect(c.level).toBe('high');
    expect(c.sentence).toMatch(/not a rating of this person/i);
  });

  it('is low when almost nothing could be read', () => {
    const c = confidenceFrom([
      { name: 'a', read: 'unreadable' }, { name: 'b', read: 'absent' },
      { name: 'c', read: 'empty' }, { name: 'd', read: 'ok' },
    ]);
    expect(c.level).toBe('low');
  });

  it('is low rather than high when there are no inputs at all', () => {
    expect(confidenceFrom([]).level).toBe('low');
  });
});
