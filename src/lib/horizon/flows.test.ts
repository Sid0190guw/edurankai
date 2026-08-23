// src/lib/horizon/flows.test.ts — PATCH 19. THE SEAMS, NOT THE MODULES.
//
// =================================================================================================
// WHAT THIS SUITE DELIBERATELY DOES NOT TEST
// =================================================================================================
//
// panelVerdict() has twelve tests of its own in src/lib/talent/evaluations.test.ts. decideAdvance()
// has its own suite. isPiiKey() has its own suite. Re-asserting any of that here would be a second
// copy of somebody else's contract that drifts the moment they change theirs, which is the exact
// failure this patch was written to catch.
//
// What has NO owner is the JOIN: two modules that each pass their own tests and disagree with each
// other about what a word means. Every test below sits between two modules and fails only when they
// stop agreeing.
//
// The one exception is where a divergence ALREADY exists. Those are pinned as characterisation
// tests, named as findings, and carry the sentence that says what to do when somebody fixes them.
// A pinned divergence that quietly widens is the failure mode this whole patch exists to prevent.
import { describe, it, expect } from 'vitest';

import {
  EVIDENCE_LEVELS,
  EVIDENCE_KINDS,
  ASSERTION_BY_EVIDENCE_LEVEL,
  strongestLevel,
  atLeast,
  isEvidenceLevel,
  type EvidenceLevel,
} from '@/lib/evidence-graph';

import {
  ASSERTION_TYPES,
  isAssertionType,
  assertionForSkillSource,
  strongerAssertion,
  weakerAssertion,
  chainAssertion,
  protectedAttributeConcern,
  assertAllowedAboutPerson,
  REFUSED_SUBJECTS,
  type AssertionType,
  type EvidenceCitation,
} from '@/lib/person-assertions';

import {
  ASSERTION_TYPES as TWIN_ASSERTION_TYPES,
  classifyFieldName,
  screenColumns,
} from '@/lib/digital-twin';

import { RECOMMENDATIONS, panelVerdict, isRecommendation } from '@/lib/talent/evaluations';

import { FLOWS, matrixSummary } from '@/lib/horizon/contract';

// -------------------------------------------------------------------------------------------------
// FLOW 8 -> FLOW 2. THE LADDER AND THE VOCABULARY IT HANDS OFF TO.
// -------------------------------------------------------------------------------------------------

describe('flow 8: the evidence ladder is internally consistent', () => {
  it('maps every level, with no level left without an assertion word', () => {
    for (const level of EVIDENCE_LEVELS) {
      expect(Object.prototype.hasOwnProperty.call(ASSERTION_BY_EVIDENCE_LEVEL, level)).toBe(true);
    }
    expect(Object.keys(ASSERTION_BY_EVIDENCE_LEVEL).sort()).toEqual([...EVIDENCE_LEVELS].sort());
  });

  it('ranks levels in the order the ladder is declared in', () => {
    // Two sources of truth live in one file: the EVIDENCE_LEVELS array and the private LEVEL_RANK
    // map that strongestLevel() reads. They are only ever compared by a human today.
    for (let i = 0; i < EVIDENCE_LEVELS.length; i++) {
      for (let j = 0; j < EVIDENCE_LEVELS.length; j++) {
        const a = EVIDENCE_LEVELS[i];
        const b = EVIDENCE_LEVELS[j];
        expect(strongestLevel(a, b)).toBe(i >= j ? a : b);
        expect(atLeast(a, b)).toBe(i >= j);
      }
    }
  });

  it('declares a real level for every evidence kind it will accept', () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(isEvidenceLevel(kind.supports)).toBe(true);
    }
  });

  it('never lets a kind reach `demonstrated` or above without confirmation or a human verdict', () => {
    // THE RULE THE WHOLE GRAPH RESTS ON. Above `inferred` the level must come from a fact this
    // platform owns and re-reads, or from a named human. A kind that supported `demonstrated` with
    // needs:'none' would be a form field promoting itself to proof.
    for (const kind of EVIDENCE_KINDS) {
      if (atLeast(kind.supports, 'demonstrated')) {
        expect(kind.needs === 'owner_confirmation' || kind.needs === 'human_verdict').toBe(true);
      }
    }
  });

  it('names an owning module for every kind that claims a platform fact', () => {
    // The graph never re-queries around the module that owns the fact. A kind with no owner is a
    // kind nothing can confirm.
    for (const kind of EVIDENCE_KINDS) {
      if (kind.needs === 'owner_confirmation') {
        expect(String(kind.ownerModule || '').length > 0).toBe(true);
        expect(kind.ownerModule.startsWith('src/lib/')).toBe(true);
      }
    }
  });
});

describe('flow 8 to flow 11: the evidence graph and the person spine use one vocabulary', () => {
  it('emits only assertion words the spine recognises', () => {
    // THE SEAM. evidence-graph.ts declares the mapping as Record<EvidenceLevel, string> on purpose,
    // so the compiler does NOT check this. Nothing else does either, until here.
    for (const level of EVIDENCE_LEVELS) {
      const word = ASSERTION_BY_EVIDENCE_LEVEL[level];
      expect(isAssertionType(word)).toBe(true);
    }
  });

  it('agrees with the skill-source mapping about a platform record', () => {
    // hr_employee_skills.source='course' and evidence kind 'course_completion' describe THE SAME
    // ROW reached two ways. person-assertions.ts records that these two once disagreed — one said
    // `verified`, the other `factual` — and that the stronger word was the wrong one. This is that
    // agreement, asserted rather than remembered.
    const courseKind = EVIDENCE_KINDS.find((k) => k.kind === 'course_completion');
    const assessmentKind = EVIDENCE_KINDS.find((k) => k.kind === 'assessment_pass');
    expect(courseKind).toBeTruthy();
    expect(assessmentKind).toBeTruthy();
    expect(ASSERTION_BY_EVIDENCE_LEVEL[courseKind!.supports]).toBe(assertionForSkillSource('course'));
    expect(ASSERTION_BY_EVIDENCE_LEVEL[assessmentKind!.supports]).toBe(assertionForSkillSource('assessment'));
    expect(assertionForSkillSource('course')).toBe('factual');
  });

  it('agrees that a manager stating a level is not a check', () => {
    const managerKind = EVIDENCE_KINDS.find((k) => k.kind === 'manager_statement');
    expect(managerKind).toBeTruthy();
    expect(ASSERTION_BY_EVIDENCE_LEVEL[managerKind!.supports]).toBe(assertionForSkillSource('manager'));
    expect(assertionForSkillSource('manager')).toBe('explicitly_provided');
  });

  it('never upgrades an unrecognised source', () => {
    // An unknown value from a foreign writer must land at the person's word, never above it.
    expect(assertionForSkillSource('imported-from-somewhere')).toBe('explicitly_provided');
    expect(assertionForSkillSource(null)).toBe('explicitly_provided');
    expect(assertionForSkillSource(undefined)).toBe('explicitly_provided');
  });
});

describe('flow 8: a conclusion is never stronger than what it rests on', () => {
  const cite = (assertion: AssertionType): EvidenceCitation =>
    ({ assertion } as unknown as EvidenceCitation);

  it('caps every chain at its ceiling, for every assertion type', () => {
    for (const ceiling of ASSERTION_TYPES) {
      for (const a of ASSERTION_TYPES) {
        const result = chainAssertion([cite(a)], ceiling);
        // The result may never be STRONGER than the ceiling: the stronger of the two is the ceiling.
        expect(strongerAssertion(result, ceiling)).toBe(ceiling);
      }
    }
  });

  it('is limited by its weakest citation, not its strongest', () => {
    for (const strong of ASSERTION_TYPES) {
      for (const weak of ASSERTION_TYPES) {
        // The ceiling is the STRONGEST word in the strength order, so it can never clamp the
        // result and the assertion is about the citations alone. (A weak ceiling clamps everything
        // down to itself, which is the whole point of having one.)
        const result = chainAssertion([cite(strong), cite(weak)], 'factual');
        expect(result).toBe(weakerAssertion(weakerAssertion('factual', strong), weakerAssertion('factual', weak)));
      }
    }
  });

  it('reads an empty chain as inferred, never as anything checked', () => {
    expect(chainAssertion([], 'factual')).toBe('inferred');
  });

  it('holds every assertion type in its strength order', () => {
    // A type missing from the private STRENGTH list gets indexOf === -1, which reads as STRONGER
    // than everything — a silent upgrade of the one word nobody checked. This is how that would be
    // found: for every type except the strongest, the weaker of (type, factual) must be the type.
    for (const t of ASSERTION_TYPES) {
      if (t === 'factual') continue;
      expect(weakerAssertion(t, 'factual')).toBe(t);
      expect(strongerAssertion(t, 'factual')).toBe('factual');
    }
  });
});

// -------------------------------------------------------------------------------------------------
// FLOW 5 / FLOW 6. FUSION, AND THE REFUSALS THAT ARE STRUCTURAL RATHER THAN PROMISED.
// -------------------------------------------------------------------------------------------------

describe('flow 6: the composed person refuses protected and sensitive columns structurally', () => {
  it('refuses a protected column name before it can reach SQL', () => {
    const screen = screenColumns(['full_name', 'gender', 'department_id', 'date_of_birth']);
    expect(screen.allowed).toEqual(['full_name', 'department_id']);
    expect(screen.refused.map((r) => r.column).sort()).toEqual(['date_of_birth', 'gender']);
  });

  it('refuses a sensitive column and a malformed one for different stated reasons', () => {
    const screen = screenColumns(['salary', 'SELECT 1', 'designation']);
    expect(screen.allowed).toEqual(['designation']);
    const reasons = Object.fromEntries(screen.refused.map((r) => [r.column, r.reason]));
    expect(reasons['salary']).toBe('sensitive');
    expect(reasons['select 1']).toBe('malformed');
  });

  it('FINDING: the column screen and the assertion spine disagree about three protected terms', () => {
    // A REAL DIVERGENCE, PINNED SO IT CANNOT WIDEN.
    //
    // person-assertions.protectedAttributeConcern() REFUSES 'handicap', 'fertility' and 'menopause'
    // outright. digital-twin.classifyFieldName() classifies all three as 'ok', so a column literally
    // named `fertility` or `menopause` passes screenColumns() and can be selected into a composed
    // person record. Two of those three are wellness terms, and the wellness system's entire premise
    // is that no administrator — not the founder — reads one person's cycle or symptoms.
    //
    // Nothing writes such a column today, which is why this is a finding and not an incident: the
    // gate is structural precisely so that it holds when somebody later adds one.
    //
    // WHEN THIS IS FIXED, by adding the three segments to PROTECTED_ATTRIBUTE_SEGMENTS in
    // src/lib/digital-twin.ts, this test fails and must be replaced by the agreement assertion below
    // it. Do not delete it without moving the code.
    const divergent = ['handicap', 'fertility', 'menopause'].filter(
      (t) => protectedAttributeConcern(t).level === 'refuse' && classifyFieldName(t) !== 'protected',
    );
    expect(divergent).toEqual(['handicap', 'fertility', 'menopause']);
  });

  it('agrees about every OTHER protected term the spine refuses outright', () => {
    // The agreement that does hold, asserted so that a term cannot fall out of one list quietly.
    const known = ['handicap', 'fertility', 'menopause'];
    const terms = [
      'race', 'ethnicity', 'caste', 'religion', 'faith', 'politics', 'political',
      'sexual orientation', 'sexuality', 'gender identity', 'gender', 'sex',
      'disability', 'disabled', 'impairment', 'pregnancy', 'pregnant', 'maternity',
      'menstrual', 'health', 'medical', 'diagnosis', 'mental health',
      'age', 'date of birth', 'marital status', 'national origin', 'immigration status',
    ];
    for (const term of terms) {
      if (known.includes(term)) continue;
      if (protectedAttributeConcern(term).level !== 'refuse') continue;
      expect({ term, cls: classifyFieldName(term.split(' ').join('_')) })
        .toEqual({ term, cls: 'protected' });
    }
  });

  it('refuses every subject the spine will not hold an assertion about', () => {
    for (const refused of REFUSED_SUBJECTS) {
      const verdict = assertAllowedAboutPerson(refused.key);
      expect(verdict.allowed).toBe(false);
      // The refusal has to be printable, or a screen routes around it. Some entries defer to
      // another entry's reason ("Same as attrition."), which is short and still a sentence.
      expect({ key: refused.key, printable: verdict.why.trim().length > 0 })
        .toEqual({ key: refused.key, printable: true });
    }
  });

  it('refuses the surveillance-shaped subjects by name, not by category', () => {
    for (const subject of ['attrition risk', 'flight risk', 'engagement score', 'productivity index', 'culture fit']) {
      expect(assertAllowedAboutPerson(subject).allowed).toBe(false);
    }
    // And allows what a capability record is actually made of.
    for (const subject of ['TypeScript', 'Structural analysis', 'Clinical documentation']) {
      expect(assertAllowedAboutPerson(subject).allowed).toBe(true);
    }
  });
});

describe('flow 5 to flow 11: the twin and the spine use two different words for one idea', () => {
  it('FINDING: `provided` and `explicitly_provided` are the same assertion under two names', () => {
    // ANOTHER REAL DIVERGENCE, PINNED.
    //
    // src/lib/person-assertions.ts carries a compile-time drift guard against src/lib/provenance.ts,
    // so those two can never disagree. src/lib/digital-twin.ts declares its OWN seven-word list and
    // is outside that guard: it says `provided` where the other two say `explicitly_provided`.
    //
    // The consequence is concrete rather than cosmetic. ASSERTION_BY_EVIDENCE_LEVEL emits
    // `explicitly_provided`, and digital-twin.ASSERTION_LABELS has no entry for that word — so an
    // evidence level routed into a twin panel renders with no label at all, for the two levels
    // (`claimed`, `explicit`) that describe everything nobody has checked.
    //
    // WHEN THIS IS FIXED, this test fails and the agreement assertion below it becomes the whole
    // test. Fixing it means changing a vocabulary two modules already render, so it is reported
    // rather than done here: this patch does not edit another patch's domain.
    expect((TWIN_ASSERTION_TYPES as readonly string[]).includes('provided')).toBe(true);
    expect((TWIN_ASSERTION_TYPES as readonly string[]).includes('explicitly_provided')).toBe(false);
    expect((ASSERTION_TYPES as readonly string[]).includes('explicitly_provided')).toBe(true);

    const emitted = new Set(Object.values(ASSERTION_BY_EVIDENCE_LEVEL));
    const unlabelledInTwin = [...emitted].filter((w) => !(TWIN_ASSERTION_TYPES as readonly string[]).includes(w));
    expect(unlabelledInTwin).toEqual(['explicitly_provided']);
  });

  it('agrees about the six words that are not in dispute', () => {
    const shared = ['factual', 'verified', 'calculated', 'inferred', 'predicted', 'recommended'];
    for (const word of shared) {
      expect((ASSERTION_TYPES as readonly string[]).includes(word)).toBe(true);
      expect((TWIN_ASSERTION_TYPES as readonly string[]).includes(word)).toBe(true);
    }
    expect(ASSERTION_TYPES.length).toBe(TWIN_ASSERTION_TYPES.length);
  });
});

// -------------------------------------------------------------------------------------------------
// FLOW 4. FEEDBACK, AGGREGATION, AND THE DISAGREEMENT THAT MUST SURVIVE IT.
// -------------------------------------------------------------------------------------------------

describe('flow 4: the recommendation catalogue and the aggregator agree', () => {
  it('counts every recommendation the catalogue offers', () => {
    // The panel UI renders RECOMMENDATIONS; panelVerdict() counts what isRecommendation() accepts.
    // A key offered on a form and ignored by the aggregator is an opinion that silently vanishes.
    for (const option of RECOMMENDATIONS) {
      expect(isRecommendation(option.key)).toBe(true);
      const { counts } = panelVerdict([option.key]);
      expect((counts as Record<string, number>)[option.key]).toBe(1);
    }
  });

  it('keeps disagreement visible instead of collapsing it into the verdict', () => {
    // RULE 25. One person's feedback must never become organisational truth, and a reader has to be
    // able to see the split that produced the word.
    const { verdict, counts } = panelVerdict(['advance', 'advance', 'advance', 'decline']);
    expect(verdict).toBe('advance');
    expect(counts).toEqual({ advance: 3, hold: 0, decline: 1 });
  });

  it('never invents agreement out of an empty or unreadable panel', () => {
    expect(panelVerdict([]).verdict).toBe('hold');
    expect(panelVerdict([null, null]).verdict).toBe('hold');
    expect(panelVerdict([null, null]).counts).toEqual({ advance: 0, hold: 0, decline: 0 });
  });
});

// -------------------------------------------------------------------------------------------------
// THE CONTRACT ITSELF. A REPORT THAT CONTRADICTS ITSELF IS WORSE THAN NO REPORT.
// -------------------------------------------------------------------------------------------------

describe('the integration contract is well formed', () => {
  it('declares all fifteen flows exactly once, in order', () => {
    expect(FLOWS.length).toBe(15);
    expect(FLOWS.map((f) => f.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(new Set(FLOWS.map((f) => f.key)).size).toBe(15);
  });

  it('never marks a flow wired while naming a failure, or partial while naming none', () => {
    for (const flow of FLOWS) {
      if (flow.status === 'wired') expect({ id: flow.id, failures: flow.failures.length }).toEqual({ id: flow.id, failures: 0 });
      else expect({ id: flow.id, hasFailure: flow.failures.length > 0 }).toEqual({ id: flow.id, hasFailure: true });
    }
  });

  it('says where the human decides on every flow that produces a judgement', () => {
    // RULE 14. No computed output decides anything. A flow with no human named is a flow nobody has
    // checked, and the empty string is not an answer.
    for (const flow of FLOWS) {
      expect({ id: flow.id, hasHuman: String(flow.humanDecision || '').trim().length > 0 })
        .toEqual({ id: flow.id, hasHuman: true });
    }
  });

  it('summarises to the same counts the flows declare', () => {
    const s = matrixSummary();
    expect(s.total).toBe(15);
    expect(s.wired + s.partial + s.unreachable + s.byDesignAbsent).toBe(15);
    expect(s.failures.length).toBe(FLOWS.reduce((n, f) => n + f.failures.length, 0));
  });
});
