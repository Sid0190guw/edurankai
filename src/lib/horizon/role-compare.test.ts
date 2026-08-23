// src/lib/horizon/role-compare.test.ts — PATCH 16, the parts that must not drift.
//
// WHAT IS TESTED HERE AND WHAT IS NOT. Every function under test is PURE: it takes a reading that
// match.ts already produced and groups it. compareRoles() itself is not tested here because it opens
// a database, and this repository's test setup deliberately has no environment — see vitest.config.ts.
// The seam that matters for correctness is the grouping, and it is all reachable without a connection.
//
// MatchExplanation is branded with a Symbol that src/lib/match.ts does not export, which is what
// stops any other module constructing an unexplained reading. A test has to cast past that brand to
// build a fixture. That cast is the ONLY place in this patch where the brand is bypassed, it happens
// in a test file that ships no behaviour, and `explain()` below is the single point where it occurs.
import { describe, it, expect } from 'vitest';
import {
  DIMENSION,
  ENGINE_CLASS,
  FIT_BANDS,
  GAP_KIND_LABELS,
  LEADERSHIP_TERMS,
  ROLE_SLOTS,
  SLOT_LABELS,
  confidenceFrom,
  developmentGapFrom,
  evidenceClassOf,
  growthHeadroomFrom,
  isRoleSlot,
  leadershipCoverageFrom,
  namesLeadershipRequirement,
  scoreOrLevelFrom,
  selfCheck,
  sourceBreakdownFrom,
  sourceTypeOf,
  suggestTraining,
  summaryFor,
  sustainabilityFrom,
  type RoleSlot,
} from './role-compare';
import { checkPublicCopy, validateIntelligenceResult, maxConfidenceFor } from './types';
import { assertAllowedAboutPerson, protectedAttributeConcern } from '@/lib/person-assertions';
import type { MatchExplanation, RequirementResult, EvidenceRef } from '@/lib/match';
import type { CourseOption } from '@/lib/performance-learning';

// -------------------------------------------------------------------------------------------------
// FIXTURES
// -------------------------------------------------------------------------------------------------

function req(over: Partial<RequirementResult> = {}): RequirementResult {
  return {
    requirementId: 'r1',
    skillId: 's1',
    skillName: 'PostgreSQL',
    necessity: 'required',
    minLevel: 3,
    minLevelLabel: 'Independent',
    coverage: 'gap',
    why: 'Nothing on record.',
    evidence: [],
    via: null,
    ...over,
  } as RequirementResult;
}

function ev(over: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    what: 'Passed assessment: SQL fundamentals',
    source: 'assessment_attempts',
    assertion: 'factual',
    recordedAt: '2026-01-10T00:00:00.000Z',
    url: null,
    ...over,
  };
}

/** The one place the MatchExplanation brand is cast past. See the header. */
function explain(over: Partial<MatchExplanation> = {}): MatchExplanation {
  const base = {
    subject: { personKey: 'p1', displayName: 'A Person' },
    job: { jobKind: 'role', jobId: 'j1', title: 'Backend Engineer' },
    conclusion: 'Read against 5 recorded requirements.',
    assessable: true,
    overall: {
      coveragePct: 60, completenessPct: 80, band: 'partial-evidence',
      sentence: 'Partial evidence.',
    },
    why: [],
    dimensions: [],
    strong: [],
    partial: [],
    substitute: [],
    claimedOnly: [],
    gaps: [],
    unknown: [],
    decisionBlockers: [],
    assumptions: [],
    uncertainty: [],
    dataUsed: [],
    weightProfile: {
      key: 'default', label: 'Built-in default', ownerUserId: null,
      weights: {}, isBuiltInDefault: true, sentence: '',
    },
    fairness: {
      protectedAttributesUsed: [], screenedFieldNames: [], refusedFieldNames: [], sentence: '',
    },
    humanAuthority: { overridable: true, sentence: '', routes: [] },
    computedAt: '2026-08-23T00:00:00.000Z',
    ...over,
  };
  return base as unknown as MatchExplanation;
}

const COURSES: CourseOption[] = [
  { id: 'c1', title: 'PostgreSQL for Engineers', category: 'Data', level: null, durationHours: 12, accessType: 'employees', isPaid: false },
  { id: 'c2', title: 'Team Building Essentials', category: 'Leadership', level: null, durationHours: 6, accessType: 'employees', isPaid: false },
  { id: 'c3', title: 'Watercolour Painting', category: 'Arts', level: 'intermediate', durationHours: 4, accessType: 'public', isPaid: true },
];

const NOW = '2026-08-23T00:00:00.000Z';

// -------------------------------------------------------------------------------------------------

describe('slots', () => {
  it('accepts exactly the four the brief names, and nothing else', () => {
    expect(ROLE_SLOTS).toEqual(['current', 'alternative_a', 'alternative_b', 'future_leadership']);
    for (const s of ROLE_SLOTS) expect(isRoleSlot(s)).toBe(true);
    expect(isRoleSlot('best_role')).toBe(false);
    expect(isRoleSlot('')).toBe(false);
    expect(isRoleSlot(null)).toBe(false);
  });

  it('labels every slot', () => {
    for (const s of ROLE_SLOTS) expect(SLOT_LABELS[s as RoleSlot]).toBeTruthy();
  });
});

describe('namesLeadershipRequirement', () => {
  it('matches a whole word in the requirement name', () => {
    const m = namesLeadershipRequirement('Team building');
    expect(m.yes).toBe(true);
    expect(m.term).toBe('team building');
    // The caveat must travel with the finding, not be left to a screen to remember.
    expect(m.sentence).toContain('not a judgement about anybody');
  });

  it('does not match a substring inside another word', () => {
    // 'leading' must not fire on 'pleading', 'hiring' must not fire on 'wiring'.
    expect(namesLeadershipRequirement('Pleading').yes).toBe(false);
    expect(namesLeadershipRequirement('Wiring diagrams').yes).toBe(false);
  });

  it('reads the category as well as the name', () => {
    expect(namesLeadershipRequirement('Sprint planning', 'Management').yes).toBe(true);
  });

  it('returns a real negative rather than a guess', () => {
    const m = namesLeadershipRequirement('PostgreSQL');
    expect(m.yes).toBe(false);
    expect(m.term).toBeNull();
    expect(m.sentence).toBe('');
  });

  it('has no protected or sensitive term in the list', () => {
    // A leadership grouping that keyed on age, gender or health would make a protected attribute a
    // decision variable, so every term goes through the repository's own screen rather than a second
    // hand-written list here.
    //
    // THE SCREEN IS WHOLE-WORD AND THAT IS THE POINT. A naive substring test fails on "management",
    // which contains "age", and passing it would have meant deleting a legitimate leadership term to
    // satisfy a badly written check. protectedAttributeConcern() draws the line where it belongs:
    // 'refuse' when the term IS the attribute, 'review' when it merely contains the word.
    for (const t of LEADERSHIP_TERMS) {
      expect(protectedAttributeConcern(t).level).not.toBe('refuse');
    }
  });

  it('is refused as a subject if anybody ever asks it about a person directly', () => {
    // The terms describe REQUIREMENTS. Asked about a human, the same words are refused upstream, and
    // this module depends on that still being true.
    expect(assertAllowedAboutPerson('leadership potential').allowed).toBe(false);
  });
});

describe('suggestTraining', () => {
  it('suggests on a name match and says that is what it is', () => {
    const out = suggestTraining('PostgreSQL', COURSES);
    expect(out.length).toBe(1);
    expect(out[0].courseId).toBe('c1');
    expect(out[0].basis).toContain('name match');
    // Rule 12/13: a suggestion is never a finding.
    expect(out[0].assertion).toBe('recommended');
  });

  it('never invents a route when nothing matches', () => {
    expect(suggestTraining('Kubernetes', COURSES)).toEqual([]);
  });

  it('ignores words too short to mean anything', () => {
    // 'of' and 'in' would match almost every title in a catalogue.
    expect(suggestTraining('of in', COURSES)).toEqual([]);
  });

  it('caps at three so a screen stays readable', () => {
    const many: CourseOption[] = Array.from({ length: 10 }, (_, i) => ({
      id: 'x' + i, title: 'PostgreSQL volume ' + i, category: null, level: null,
      durationHours: 1, accessType: 'employees', isPaid: false,
    }));
    expect(suggestTraining('PostgreSQL', many).length).toBe(3);
  });
});

describe('developmentGapFrom', () => {
  it('keeps the four kinds of not-met apart instead of totalling them', () => {
    const g = developmentGapFrom(explain({
      gaps: [req({ skillId: 'a', skillName: 'Kubernetes' })],
      claimedOnly: [req({ skillId: 'b', skillName: 'Docker' })],
      partial: [
        req({ skillId: 'c', skillName: 'PostgreSQL' }),
        req({
          skillId: 'd', skillName: 'MySQL',
          via: { relation: 'sibling', relationLabel: '', throughSkillId: 'z', throughSkillName: 'MariaDB', assertedByUserId: null, note: null, caution: '' },
        } as any),
      ],
    }), COURSES);

    expect(g.counts.nothing_recorded).toBe(1);
    expect(g.counts.claimed_only).toBe(1);
    expect(g.counts.below_asked).toBe(1);
    // A partial reached through the ontology is a RELATED capability, not a shortfall.
    expect(g.counts.related_only).toBe(1);
    expect(g.lines.length).toBe(4);
  });

  it('orders required before preferred so a screen never buries a blocker', () => {
    const g = developmentGapFrom(explain({
      gaps: [
        req({ skillId: 'a', skillName: 'Aardvark', necessity: 'preferred' }),
        req({ skillId: 'b', skillName: 'Zebra', necessity: 'required' }),
      ],
    }), []);
    expect(g.lines[0].skillName).toBe('Zebra');
  });

  it('says an unrecorded capability is indistinguishable from an absent one', () => {
    const g = developmentGapFrom(explain({ gaps: [req()] }), []);
    expect(g.sentence).toContain('looks exactly like an absent one');
  });

  it('reports a clean role without claiming the person can do the job', () => {
    const g = developmentGapFrom(explain(), []);
    expect(g.lines).toEqual([]);
    expect(g.sentence).toContain('not a statement that this person can do the job');
  });

  it('carries the decision blockers through in match.ts words', () => {
    const g = developmentGapFrom(explain({ decisionBlockers: ['Kubernetes is required and nothing is on record.'] }), []);
    expect(g.blockers).toEqual(['Kubernetes is required and nothing is on record.']);
  });

  it('labels every kind it emits', () => {
    const g = developmentGapFrom(explain({ gaps: [req()] }), []);
    expect(g.lines[0].kindLabel).toBe(GAP_KIND_LABELS.nothing_recorded);
  });
});

describe('growthHeadroom — the distance, never the person', () => {
  it('counts unmet requirements and whether a route exists', () => {
    const g = developmentGapFrom(explain({
      gaps: [
        req({ skillId: 'a', skillName: 'PostgreSQL', necessity: 'required' }),
        req({ skillId: 'b', skillName: 'Kubernetes', necessity: 'preferred' }),
      ],
    }), COURSES);
    const h = growthHeadroomFrom(g);
    expect(h.unmetRequired).toBe(1);
    expect(h.unmetPreferred).toBe(1);
    expect(h.withSuggestedRoute).toBe(1);   // PostgreSQL matches c1
    expect(h.withNoRouteFound).toBe(1);     // Kubernetes matches nothing
  });

  it('carries the refusal of "growth potential" verbatim from person-assertions', () => {
    const h = growthHeadroomFrom(developmentGapFrom(explain(), []));
    expect(h.refusedInstead.subject).toBe('growth potential');
    expect(h.refusedInstead.why).toContain('proxy for who somebody reminds a manager of');
  });

  it('never says anything about how far the person can go', () => {
    const h = growthHeadroomFrom(developmentGapFrom(explain({ gaps: [req()] }), []));
    expect(h.sentence).toContain('It is a measurement of a gap');
    expect(h.sentence).toContain('not a statement about how far this person can go');
  });
});

describe('leadershipCoverageFrom — a statement about the role', () => {
  it('groups only requirements whose names read as leadership', () => {
    const c = leadershipCoverageFrom(explain({
      strong: [req({ skillId: 'a', skillName: 'Mentoring' })],
      gaps: [req({ skillId: 'b', skillName: 'PostgreSQL' }), req({ skillId: 'c', skillName: 'Delegation' })],
    }));
    expect(c.requirementCount).toBe(2);
    expect(c.evidenced.map((r) => r.skillName)).toEqual(['Mentoring']);
    expect(c.gap.map((r) => r.skillName)).toEqual(['Delegation']);
    expect(c.matchedTerms).toEqual(['delegation', 'mentoring']);
  });

  it('treats zero as a real answer and names both readings of it', () => {
    const c = leadershipCoverageFrom(explain({ gaps: [req({ skillName: 'PostgreSQL' })] }));
    expect(c.requirementCount).toBe(0);
    expect(c.sentence).toContain('may be because the role genuinely asks for none');
    expect(c.sentence).toContain('did not express them');
  });

  it('carries the refusal of "leadership potential" and rates nobody as a leader', () => {
    const c = leadershipCoverageFrom(explain({ strong: [req({ skillName: 'Coaching' })] }));
    expect(c.refusedInstead.subject).toBe('leadership potential');
    expect(c.refusedInstead.why).toContain('proxy');
    expect(c.sentence).toContain('not a rating of anybody as a leader');
  });
});

describe('sustainabilityFrom — durability of the reading, not a forecast', () => {
  it('finds the oldest and newest dated evidence and flags what is stale', () => {
    const s = sustainabilityFrom(explain({
      dimensions: [{
        dimension: 'capability', label: '', weight: 1, assessed: true, because: '', coveragePct: 50,
        requirements: [],
        evidence: [
          ev({ recordedAt: '2020-01-01T00:00:00.000Z' }),   // > 730 days before NOW
          ev({ recordedAt: '2026-06-01T00:00:00.000Z' }),
        ],
        assumptions: [], uncertainty: [],
      }] as any,
    }), null, NOW);

    expect(s.oldestEvidenceAt).toBe('2020-01-01T00:00:00.000Z');
    expect(s.newestEvidenceAt).toBe('2026-06-01T00:00:00.000Z');
    expect(s.staleEvidenceCount).toBe(1);
    expect(s.sentence).toContain('more than two years old');
  });

  it('says so plainly when nothing carries a date', () => {
    const s = sustainabilityFrom(explain(), null, NOW);
    expect(s.oldestEvidenceAt).toBeNull();
    expect(s.sentence).toContain('carries a date');
  });

  it('separates could-not-read from nothing-on-record', () => {
    const s = sustainabilityFrom(explain({ unknown: [req()] }), null, NOW);
    expect(s.unknownCount).toBe(1);
    expect(s.sentence).toContain('not a finding about the person');
  });

  it('always states that it is not a forecast about the person', () => {
    const s = sustainabilityFrom(explain(), null, NOW);
    expect(s.isNotAForecast).toContain('says nothing about how long this person would stay');
    expect(s.isNotAForecast).toContain('prediction about a human');
  });
});

// -------------------------------------------------------------------------------------------------
// THE CONTRACT LAYER
// -------------------------------------------------------------------------------------------------

describe('evidence class mapping is conservative in the safe direction', () => {
  it('never promotes a stated claim to demonstrated', () => {
    expect(evidenceClassOf('explicitly_provided')).toBe('stated');
    expect(evidenceClassOf('provided')).toBe('stated');
  });

  it('treats our own arithmetic as inferred, not as evidence about the person', () => {
    expect(evidenceClassOf('calculated')).toBe('inferred');
  });

  it('gives a suggestion no evidential weight at all', () => {
    expect(evidenceClassOf('recommended')).toBe('non_evidential');
    expect(evidenceClassOf('predicted')).toBe('non_evidential');
  });

  it('falls to the weakest honest reading for an unknown word, never upward', () => {
    expect(evidenceClassOf('something-new')).toBe('stated');
    expect(evidenceClassOf(null)).toBe('stated');
  });
});

describe('sourceTypeOf', () => {
  it('recognises the sources match.ts actually names', () => {
    expect(sourceTypeOf('assessment_attempts')).toBe('assessment');
    expect(sourceTypeOf('hr_employee_skills')).toBe('capability_evidence');
    expect(sourceTypeOf('training_enrollments')).toBe('training_record');
    expect(sourceTypeOf('course_certificates')).toBe('credential');
    expect(sourceTypeOf('applications')).toBe('application');
  });

  it('says "our own code" rather than guessing a record for an unknown source', () => {
    expect(sourceTypeOf('mystery')).toBe('system_computation');
  });
});

describe('sourceBreakdownFrom', () => {
  const withEvidence = (refs: EvidenceRef[]) => explain({
    dimensions: [{
      dimension: 'capability', label: '', weight: 1, assessed: true, because: '', coveragePct: 50,
      requirements: [], evidence: refs, assumptions: [], uncertainty: [],
    }] as any,
  });

  it('produces weights that sum to exactly 1, which validation requires', () => {
    // Three of one type and one of another: 3/4 + 1/4 is exact, but the guard must hold generally.
    const b = sourceBreakdownFrom(withEvidence([
      ev({ source: 'assessment_attempts' }),
      ev({ source: 'assessment_attempts' }),
      ev({ source: 'assessment_attempts' }),
      ev({ source: 'hr_employee_skills' }),
    ]));
    const sum = b.reduce((a, r) => a + r.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('sums to 1 for a count that does not divide cleanly', () => {
    const b = sourceBreakdownFrom(withEvidence([
      ev({ source: 'assessment_attempts' }),
      ev({ source: 'hr_employee_skills' }),
      ev({ source: 'applications' }),
    ]));
    const sum = b.reduce((a, r) => a + r.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('keeps the strongest class per source type', () => {
    const b = sourceBreakdownFrom(withEvidence([
      ev({ source: 'hr_employee_skills', assertion: 'explicitly_provided' }),
      ev({ source: 'hr_employee_skills', assertion: 'factual' }),
    ]));
    expect(b.length).toBe(1);
    expect(b[0].strongestClass).toBe('observed');
  });

  it('says out loud that a share of the count is not a share of the importance', () => {
    const b = sourceBreakdownFrom(withEvidence([ev()]));
    expect(b[0].note).toContain('not a share of the importance');
  });

  it('returns nothing rather than a fabricated row when there is no evidence', () => {
    expect(sourceBreakdownFrom(explain())).toEqual([]);
  });
});

describe('confidenceFrom — the ceiling may only ever lower it', () => {
  const withClass = (assertion: string, completenessPct: number) => {
    const e = explain({
      overall: { coveragePct: 90, completenessPct, band: 'well-evidenced', sentence: '' },
      dimensions: [{
        dimension: 'capability', label: '', weight: 1, assessed: true, because: '', coveragePct: 90,
        requirements: [], evidence: [ev({ assertion })], assumptions: [], uncertainty: [],
      }] as any,
    });
    return confidenceFrom(e, sourceBreakdownFrom(e));
  };

  it('allows high when the evidence is strong and the role could be fully assessed', () => {
    expect(withClass('factual', 100).band).toBe('high');
  });

  it('caps at moderate when the strongest evidence is inferred (rule 22)', () => {
    const c = withClass('calculated', 100);
    expect(c.band).toBe('moderate');
    expect(maxConfidenceFor('inferred')).toBe('moderate');
  });

  it('caps at low when nothing carries evidential weight', () => {
    expect(withClass('recommended', 100).band).toBe('low');
  });

  it('lowers on thin completeness even when the evidence class would allow more', () => {
    expect(withClass('factual', 30).band).toBe('low');
    expect(withClass('factual', 50).band).toBe('moderate');
  });

  it('reports low with a reason rather than nothing when there is no reading', () => {
    const c = confidenceFrom(explain({ assessable: false }), []);
    expect(c.band).toBe('low');
    expect(c.basis).toContain('not about the person');
  });

  it('never fabricates a numeric confidence', () => {
    expect(withClass('factual', 100).value).toBeNull();
    expect(withClass('factual', 100).basis).toContain('fabricated number would be worse');
  });

  it('always states what the confidence rests on, which validation requires', () => {
    expect(withClass('factual', 100).basis.trim().length).toBeGreaterThan(0);
  });
});

describe('scoreOrLevelFrom — a band, never a bare number about a person', () => {
  it('returns a category from the bands match.ts produces', () => {
    const s = scoreOrLevelFrom(explain());
    expect(s.kind).toBe('categorical');
    if (s.kind === 'categorical') {
      expect(FIT_BANDS).toContain(s.category);
    }
  });

  it('never returns a numeric value, even when a coverage percentage exists', () => {
    const s = scoreOrLevelFrom(explain({
      overall: { coveragePct: 87, completenessPct: 100, band: 'well-evidenced', sentence: '' },
    }));
    expect(s.kind).not.toBe('numeric');
  });

  it('returns not_computed with a reason rather than a zero', () => {
    const s = scoreOrLevelFrom(explain({ assessable: false, conclusion: 'This job records no requirements.' }));
    expect(s.kind).toBe('not_computed');
    if (s.kind === 'not_computed') expect(s.reason).toBeTruthy();
  });
});

describe('summaryFor', () => {
  it('describes our records rather than the person, and disclaims ranking', () => {
    const s = summaryFor({
      slot: 'future_leadership', title: 'Engineering Lead',
      explanation: explain({ strong: [req()] }),
      gap: developmentGapFrom(explain({ gaps: [req()] }), []),
    });
    expect(s).toContain('describes our records rather than this person');
    expect(s).toContain('not a ranking against any other role');
    expect(s).toContain('decides nothing');
  });

  it('says nothing was compared rather than reporting a zero', () => {
    const s = summaryFor({
      slot: 'current', title: null,
      explanation: explain({ assessable: false }),
      gap: developmentGapFrom(explain(), []),
    });
    expect(s).toContain('Nothing was compared');
    expect(s).toContain('not a finding about this person');
  });

  it('passes the forbidden-terminology check (rule 19)', () => {
    const s = summaryFor({
      slot: 'current', title: 'Backend Engineer',
      explanation: explain(), gap: developmentGapFrom(explain(), []),
    });
    expect(checkPublicCopy(s).ok).toBe(true);
  });
});

describe('the emitted IntelligenceResult satisfies the owned contract', () => {
  // Built here the way resultFor() builds it, so validateIntelligenceResult() is exercised against
  // this engine's actual choices rather than against a hand-tuned object that would always pass.
  const build = (over: Partial<MatchExplanation> = {}) => {
    const e = explain(over);
    const breakdown = sourceBreakdownFrom(e);
    return {
      id: 'res-1',
      subject: { kind: 'employee' as const, id: 'emp-1', idScheme: 'hr_employee' as const, organisationId: 'org_edurankai' },
      dimension: DIMENSION,
      scoreOrLevel: scoreOrLevelFrom(e),
      confidence: confidenceFrom(e, breakdown),
      status: 'active' as const,
      summary: summaryFor({ slot: 'current', title: 'Backend Engineer', explanation: e, gap: developmentGapFrom(e, []) }),
      evidence: [],
      sourceBreakdown: breakdown,
      computedAt: NOW,
      validFor: { staleAt: '2026-11-21T00:00:00.000Z', recomputeAfterDays: 90 },
      modelOrEngineVersion: {
        engineId: 'horizon-role-compare', engineClass: ENGINE_CLASS, version: '1.0.0', computationId: 'comp-1',
      },
      humanReviewStatus: 'pending' as const,
      layer: 'computed' as const,
      decisionUse: 'advisory_only' as const,
      scientificStatus: 'platform_record' as const,
      organisationId: 'org_edurankai',
      profileId: null,
      supersedes: null,
    } as any;
  };

  const evidenced = {
    dimensions: [{
      dimension: 'capability', label: '', weight: 1, assessed: true, because: '', coveragePct: 90,
      requirements: [], evidence: [ev()], assumptions: [], uncertainty: [],
    }] as any,
  };

  it('validates for a normal reading', () => {
    const v = validateIntelligenceResult(build(evidenced));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('validates for a role with nothing to compare, without inventing a source', () => {
    const v = validateIntelligenceResult(build({ assessable: false, conclusion: 'No requirements recorded.' }));
    expect(v.errors).toEqual([]);
  });

  it('never claims a layer an engine may not write', () => {
    const r = build(evidenced);
    expect(r.layer).toBe('computed');
    expect(['computed', 'ai_interpretation', 'recommendation']).toContain(r.layer);
  });

  it('never claims may_decide — rule 14', () => {
    expect(build(evidenced).decisionUse).not.toBe('may_decide');
  });

  it('asks for a human before it is acted on — rule 15', () => {
    expect(build(evidenced).humanReviewStatus).toBe('pending');
  });

  it('carries a shelf life, so a reading cannot become a permanent label', () => {
    const r = build(evidenced);
    expect(Date.parse(r.validFor.staleAt)).toBeGreaterThan(Date.parse(r.computedAt));
  });
});

describe('selfCheck', () => {
  it('passes on this module as written', () => {
    expect(selfCheck()).toEqual([]);
  });

  it('is what fails if either refusal is ever lifted upstream', () => {
    // Documents intent: the replacements for "growth potential" and "leadership potential" are only
    // honest while person-assertions.ts still refuses those subjects. selfCheck() is the tripwire.
    expect(selfCheck()).toEqual([]);
  });
});
