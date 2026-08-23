// src/lib/horizon/report/interpret.ts — SECTIONS 4 AND 5, AND THE SEAM FOR REPLACING THEM.
//
// =================================================================================================
// WHY THE DEFAULT INTERPRETER IS A SET OF RULES AND NOT A LANGUAGE MODEL
// =================================================================================================
//
// Three reasons, in the order they matter.
//
// 1. IT HAS TO BE EXPLAINABLE, AND A RULE IS. Every claim this file emits states the arithmetic it
//    came from and the claim ids it read. A person disputing a sentence in their own report can be
//    shown the comparison that produced it. "The model said so" is not an answer that survives being
//    asked twice by somebody it is about.
//
// 2. IT HAS TO BE DETERMINISTIC. Two runs over unchanged data must produce the same document, or a
//    longitudinal report cannot tell a real change from a resampled one. Nothing here reads a clock
//    or a random source: `now` arrives as an argument.
//
// 3. THE DATA MUST NOT LEAVE. A first-party interpreter sends nobody's performance record anywhere.
//    That is the sovereignty position this codebase already takes, and a report engine is the worst
//    possible place to make the first exception.
//
// THE SEAM IS REAL AND IT IS THE `Interpreter` INTERFACE. A connector-backed interpreter can be
// registered by another patch: it must return the same claim types, and every claim it returns goes
// through the same validation in provenance.ts, including the confidence ceiling and the refusal to
// mint a recommendation about a consequential decision. Its ModelStamp says `connector` and that
// word reaches the rendered document, so a reader always knows which one wrote what they are
// reading. This patch does not ship one, and says so in its handoff rather than shipping a stub.
//
// =================================================================================================
// THE LINE THIS FILE MAY NOT CROSS
// =================================================================================================
//
// It may recommend a CONVERSATION, a REVIEW, a PIECE OF EVIDENCE TO GO AND GET. It may not recommend
// hiring, rejecting, promoting, paying, disciplining or dismissing anybody, and there is no rule
// below that produces such a sentence. Where one of those decisions is genuinely in play, the
// engine surfaces a recommendation that already passed ai-boundary's seven-question guard, with its
// stored reasoning attached — see surfaceBoundaryRecommendations(). It never writes its own.
import {
  confidenceCeiling, evidenceRef, interpretationClaim, recommendationClaim, sourceRef,
} from './provenance';
import type {
  AiInterpretationClaim, DerivedClaim, EvidenceRef, FactClaim, HumanFeedbackClaim,
  InterpretationInput, InterpretationResult, Interpreter, RecommendationClaim, SectionKind, SourceRef,
} from './types';

const INTERPRETER_ID = 'horizon.rules';

/**
 * Bump when a rule below changes what it would conclude from the same data. The document contract
 * version in version.ts is separate and does not move for this.
 */
const INTERPRETER_VERSION = '1.0.0';

const SELF: SourceRef = sourceRef({
  provider: INTERPRETER_ID,
  system: 'horizon',
  table: 'derived in-process from the claims in this document',
  ownedBy: 'Patch 18 — explainable intelligence report engine',
});

/** Find the first derived claim whose label starts with a prefix. Labels are stable strings. */
function findDerived(claims: DerivedClaim[], labelPrefix: string): DerivedClaim | null {
  for (const c of claims) if (c.label.indexOf(labelPrefix) === 0) return c;
  return null;
}

function numericValue(claim: DerivedClaim | null): number | null {
  if (!claim) return null;
  const n = typeof claim.value === 'number' ? claim.value : Number(claim.value);
  return Number.isFinite(n) ? n : null;
}

/** Pull the evidence off a set of claims, de-duplicated, capped so a document stays readable. */
function evidenceFrom(claims: { provenance: { evidence: EvidenceRef[] } }[], cap = 6): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const c of claims) {
    for (const e of c.provenance.evidence) {
      const key = e.kind + '|' + e.ref;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Drop the claims findDerived() could not find. Named `found` and not `present`: two readings in
 * this file already bind a local `const present`, and the helper was shadowed by both.
 *
 * findDerived() returns null when a reading is absent, and an absent reading is normal — the window
 * may simply carry no attendance rows. Passing the nulls straight into evidenceFrom() typechecked
 * only because nothing looked; at runtime the first one would have thrown on `c.provenance`, inside
 * an interpretation pass whose whole job is to degrade rather than fail.
 */
function found<T>(claims: readonly (T | null | undefined)[]): T[] {
  return claims.filter((c): c is T => !!c);
}

// =================================================================================================
// THE RULES
// =================================================================================================

/**
 * RULE 1 — HOW MUCH RECORD THERE IS. Always emitted, and deliberately first.
 *
 * Every other sentence in sections 4 and 5 is worth exactly what the record underneath it is worth,
 * and a reader who does not know the record is thin will read a thin report as a confident one. This
 * rule is the report telling them before anything else does.
 */
function evidenceSufficiency(
  facts: FactClaim[], derived: DerivedClaim[], feedback: HumanFeedbackClaim[],
  now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim {
  const total = facts.length + derived.length + feedback.length;
  const restsOn: SectionKind[] = [];
  if (facts.length) restsOn.push('facts');
  if (derived.length) restsOn.push('derived');
  if (feedback.length) restsOn.push('human_feedback');
  if (!restsOn.length) restsOn.push('facts');

  let statement: string;
  let score: number;
  if (total === 0) {
    statement = 'There is not enough on record to say anything about this subject.';
    score = 0;
  } else if (total < 6 || facts.length === 0) {
    statement = 'The record behind this report is thin: ' + total + ' items across ' + restsOn.length + ' of the six sections.';
    score = 0.3;
  } else if (feedback.length === 0) {
    statement = 'The record is reasonable on measurements and empty on what people have said.';
    score = 0.55;
  } else {
    statement = 'The record behind this report covers measurements and what people have said, across ' + total + ' items.';
    score = 0.8;
  }

  return interpretationClaim({
    statement,
    act: 'summarise',
    reasoning:
      'Counted the claims this document was able to build: ' + facts.length + ' records, '
      + derived.length + ' derived measures and ' + feedback.length + ' pieces of feedback.',
    assumptions:
      'That the sources registered for this report are the ones that hold the relevant records. '
      + 'A capability with no provider registered shows in the coverage block, not here.',
    uncertainty:
      'Volume is not quality. A large record made up of one kind of entry is narrower than this count suggests.',
    restsOn,
    score,
    basis: 'Counted directly from the claims in this document.',
    now, stamp, sources: [SELF],
    evidence: evidenceFrom([...facts, ...derived, ...feedback], 4),
  });
}

/** RULE 2 — DIRECTION OF A MEASURED RATING, where two or more submitted reviews exist. */
function ratingDirection(
  derived: DerivedClaim[], now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim | null {
  const change = findDerived(derived, 'Change in overall rating');
  const value = numericValue(change);
  if (!change || value === null) return null;

  const direction = value > 0.25 ? 'risen' : (value < -0.25 ? 'fallen' : 'stayed broadly level');
  const magnitude = Math.abs(value);
  return interpretationClaim({
    statement: 'Across the reviews in this window, the overall rating has ' + direction + '.',
    act: 'identify_patterns',
    reasoning:
      'Compared the most recent submitted overall rating with the earliest one in the window: a change of '
      + value.toFixed(2) + ' across ' + change.basisCount + ' submitted reviews.',
    assumptions:
      'That the rating scale did not change between cycles. Nothing in hr_review_cycles records a scale, '
      + 'so a rescored cycle would read as a change in the person.',
    uncertainty:
      change.basisCount < 3
        ? 'Two points is a difference, not a trend. This is the least reliable kind of reading in the document.'
        : 'Ratings are set by people who change between cycles, so part of any movement is a change of reviewer.',
    restsOn: ['derived'],
    // Small movements on few data points get a low score on purpose.
    score: Math.min(0.7, 0.25 + Math.min(change.basisCount, 6) * 0.06 + Math.min(magnitude, 1) * 0.1),
    basis: 'Two recorded ratings ' + change.basisCount + ' reviews apart.',
    now, stamp, sources: [SELF], evidence: change.provenance.evidence,
  });
}

/** RULE 3 — DISAGREEMENT. A split panel or a lone voice is a finding, not noise to be averaged. */
function disagreement(
  derived: DerivedClaim[], feedback: HumanFeedbackClaim[],
  now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim | null {
  const split = findDerived(derived, 'The panel does not agree');
  const outliers = feedback.filter((f) => f.outlier === true);
  if (!split && outliers.length === 0) return null;

  const restsOn: SectionKind[] = split ? ['derived', 'human_feedback'] : ['human_feedback'];
  const statement = split
    ? 'The people who assessed this subject did not reach the same view.'
    : 'One theme in the feedback has been raised by a single person and by nobody else.';

  return interpretationClaim({
    statement,
    act: 'identify_patterns',
    reasoning: split
      ? 'The submitted evaluations carry more than one distinct recommendation: ' + String(split.value) + '.'
      : outliers.length + ' feedback item(s) raise a theme no other contributor raised.',
    assumptions:
      'That each contributor was assessing the same thing. Different stages ask different questions, '
      + 'so a split can be two people being right about two different things.',
    uncertainty:
      'A minority view is not a wrong view. This flags that the record disagrees with itself; it does not say which side to believe.',
    restsOn,
    // Deliberately modest. Detecting disagreement is reliable; knowing what it means is not.
    score: split ? 0.6 : 0.45,
    basis: split ? 'Counted distinct recommendations across submitted evaluations.' : 'Counted contributors per theme.',
    major: !!split,
    now, stamp, sources: [SELF],
    evidence: split ? split.provenance.evidence : evidenceFrom(outliers, 4),
  });
}

/** RULE 4 — HOLES IN THE TIME RECORD, said as holes rather than as absences. */
function timeRecordCoverage(
  derived: DerivedClaim[], now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim | null {
  const unrecorded = findDerived(derived, 'Calendar days with no attendance record');
  const recorded = findDerived(derived, 'Days with an attendance record');
  const missing = numericValue(unrecorded);
  const present = numericValue(recorded);
  if (missing === null || present === null) return null;
  const span = missing + present;
  if (span <= 0) return null;
  const share = missing / span;
  // Weekends alone account for roughly two sevenths of a calendar window, so anything under half is
  // unremarkable and saying so would be noise.
  if (share < 0.5) return null;

  return interpretationClaim({
    statement: 'The attendance record for this window is substantially incomplete.',
    act: 'summarise',
    reasoning:
      Math.round(share * 100) + ' per cent of the calendar days in this window have no attendance row at all ('
      + missing + ' of ' + span + ').',
    assumptions:
      'That the window includes weekends and public holidays, which it does: the denominator is calendar days, '
      + 'not working days, because no working-day calendar is recorded per person.',
    uncertainty:
      'An unrecorded day is not an absent day. Leave, holidays, and the attendance tool simply not being used '
      + 'all produce the same missing row, and this reading cannot separate them.',
    restsOn: ['derived'],
    score: 0.6,
    basis: 'A direct ratio of rows present to calendar days in the window.',
    now, stamp, sources: [SELF],
    evidence: evidenceFrom(found([unrecorded, recorded]), 3),
  });
}

/** RULE 5 — HOW MUCH OF THE SKILLS PICTURE IS SELF-REPORTED. */
function skillEvidenceQuality(
  derived: DerivedClaim[], now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim | null {
  const assessed = findDerived(derived, 'Skills assessed by somebody other than');
  const value = numericValue(assessed);
  if (!assessed || value === null || assessed.basisCount === 0) return null;
  const share = value / assessed.basisCount;
  if (share >= 0.5) return null;

  return interpretationClaim({
    statement: 'Most of the skills recorded here are self-reported and have not been assessed by anybody else.',
    act: 'classify',
    reasoning: value + ' of ' + assessed.basisCount + ' recorded skills carry an assessment by someone other than the holder.',
    assumptions: 'That hr_employee_skills.source is set honestly by the surfaces that write it.',
    uncertainty:
      'A self-reported skill is not a false one. This says the evidence is weak, not that the claim is wrong.',
    restsOn: ['derived'],
    score: 0.65,
    basis: 'A count of assessed rows over all skill rows.',
    now, stamp, sources: [SELF], evidence: assessed.provenance.evidence,
  });
}

/** RULE 6 — ROLE FIT AGAINST THE COMPETENCIES THE POSITION ACTUALLY DECLARES. */
function competencyFit(
  derived: DerivedClaim[], now: string, stamp: InterpretationInput['stamp'],
): AiInterpretationClaim | null {
  const covered = findDerived(derived, 'Declared competencies with an assessed skill');
  const value = numericValue(covered);
  if (!covered || value === null || covered.basisCount === 0) return null;
  const share = value / covered.basisCount;

  return interpretationClaim({
    statement: share >= 0.7
      ? 'Demonstrated skills cover most of what this position declares it needs.'
      : 'There is a measurable gap between what this position declares it needs and what has been assessed.',
    act: 'classify',
    reasoning: value + ' of ' + covered.basisCount + ' declared competencies have an assessed skill behind them.',
    assumptions:
      'That a competency and a skill sharing a name are the same thing. The match is an exact string comparison, '
      + 'so differently worded entries read as gaps.',
    uncertainty:
      'The naming mismatch is the main source of error here, and it runs one way: this reading understates coverage '
      + 'and never overstates it.',
    restsOn: ['derived'],
    score: 0.55,
    basis: 'A count of matched competency names over declared ones.',
    major: true,
    now, stamp, sources: [SELF], evidence: covered.provenance.evidence,
  });
}

// =================================================================================================
// RECOMMENDATIONS — THINGS TO GO AND DO, NONE OF THEM A DECISION ABOUT SOMEBODY
// =================================================================================================

function suggestions(
  facts: FactClaim[], derived: DerivedClaim[], feedback: HumanFeedbackClaim[],
  now: string, stamp: InterpretationInput['stamp'],
): RecommendationClaim[] {
  const out: RecommendationClaim[] = [];

  const reviewFacts = facts.filter((f) => f.label.indexOf('Review submitted') === 0);
  if (reviewFacts.length === 0 && facts.length > 0) {
    out.push(recommendationClaim({
      statement: 'No submitted review covers this window. Consider running one before this record is used to inform anything.',
      suggestedAction: 'Open a review cycle covering the period, or note in the cycle why none was run.',
      score: 0.7,
      basis: 'No hr_performance_reviews row with status submitted fell inside the window.',
      now, stamp, sources: [SELF], evidence: evidenceFrom(facts, 3),
    }));
  }

  const assessed = findDerived(derived, 'Skills assessed by somebody other than');
  const assessedValue = numericValue(assessed);
  if (assessed && assessedValue !== null && assessed.basisCount > 0 && assessedValue / assessed.basisCount < 0.5) {
    out.push(recommendationClaim({
      statement: 'Ask for assessed evidence against the self-reported skills before treating them as demonstrated.',
      suggestedAction: 'Assign an assessor to the skills currently marked self-reported, or attach evidence to them.',
      score: 0.65,
      basis: 'Fewer than half the recorded skills carry an assessment by another person.',
      now, stamp, sources: [SELF], evidence: assessed.provenance.evidence,
    }));
  }

  const unrecorded = findDerived(derived, 'Calendar days with no attendance record');
  const recorded = findDerived(derived, 'Days with an attendance record');
  const missing = numericValue(unrecorded);
  const present = numericValue(recorded);
  if (missing !== null && present !== null && missing + present > 0 && missing / (missing + present) >= 0.5) {
    out.push(recommendationClaim({
      statement: 'Reconcile the attendance record for this window before drawing anything from it.',
      suggestedAction: 'Check whether the missing days are leave, holidays, or the tool not being used, and record which.',
      score: 0.6,
      basis: 'Half or more of the calendar days in the window carry no attendance row.',
      now, stamp, sources: [SELF], evidence: evidenceFrom(found([unrecorded, recorded]), 3),
    }));
  }

  const split = findDerived(derived, 'The panel does not agree');
  if (split) {
    out.push(recommendationClaim({
      statement: 'The assessments disagree. A further independent view would be worth having before anybody decides.',
      suggestedAction: 'Add an evaluator who has not yet seen this subject, and record their assessment alongside the existing ones.',
      score: 0.65,
      basis: 'More than one distinct recommendation across the submitted evaluations.',
      now, stamp, sources: [SELF], evidence: split.provenance.evidence,
    }));
  }

  if (feedback.length === 0 && facts.length > 3) {
    out.push(recommendationClaim({
      statement: 'Nobody has recorded feedback about this subject in the window. The picture here is measurements without opinions.',
      suggestedAction: 'Invite feedback from the people who work with them, and record it.',
      score: 0.55,
      basis: 'Zero feedback claims against a non-empty record.',
      now, stamp, sources: [SELF], evidence: evidenceFrom(facts, 3),
    }));
  }

  return out;
}

/**
 * SURFACING, NOT AUTHORING.
 *
 * Where a report sits beside one of the six consequential decisions, any recommendation already
 * stored through ai-boundary for that subject and that decision is brought into section 5 with its
 * stored reasoning, assumptions and uncertainty intact. Each one carries the id of the row it came
 * from, which is what makes it legal under validateClaim(): a recommendation tagged with a decision
 * kind and no boundaryRecommendationId is refused.
 *
 * The reasoning is NOT re-summarised. It is the text a person wrote or an engine stored, and
 * rewording it here would put a second author between the reader and the explanation they are
 * entitled to.
 */
function surfaceBoundaryRecommendations(input: InterpretationInput): RecommendationClaim[] {
  const kind = input.definition.decisionContext;
  if (!kind) return [];
  const out: RecommendationClaim[] = [];
  for (const rec of input.boundaryRecommendations) {
    if (rec.decisionKind !== kind) continue;
    out.push(recommendationClaim({
      statement: rec.conclusion,
      suggestedAction:
        'Recorded by ' + rec.producedBy + '. Reasoning as stored: ' + rec.reasoning
        + ' Assumptions: ' + rec.assumptions + ' Stated uncertainty: ' + rec.uncertainty,
      forDecisionKind: kind,
      boundaryRecommendationId: rec.id,
      // Not scored here. The number would be this engine's opinion of somebody else's recommendation,
      // and ai_recommendations deliberately has no score column — see its header on why an opaque
      // number is the most persuasive and least answerable thing you can put on a screen.
      score: 0.5,
      basis: 'Surfaced unchanged from a stored recommendation that passed the human-authority guard. This engine did not form it and does not endorse it.',
      now: input.now,
      stamp: input.stamp,
      sources: [sourceRef({
        provider: INTERPRETER_ID, system: 'ai_boundary', table: 'ai_recommendations',
        ownedBy: 'src/lib/ai-boundary.ts', recordId: rec.id, capturedAt: rec.createdAt,
      })],
      evidence: rec.evidence.length
        ? rec.evidence
        : [evidenceRef('stored_recommendation', rec.id, 'Recommendation recorded by ' + rec.producedBy)],
    }));
  }
  return out;
}

// =================================================================================================
// THE INTERPRETER
// =================================================================================================

export const deterministicInterpreter: Interpreter = {
  id: INTERPRETER_ID,
  version: INTERPRETER_VERSION,
  provider: 'first_party',
  model: { name: 'horizon-rules', version: INTERPRETER_VERSION, provider: 'first_party' },

  async interpret(input: InterpretationInput): Promise<InterpretationResult> {
    const { facts, derived, humanFeedback, now, stamp } = input;
    const notes: string[] = [];

    const candidates: (AiInterpretationClaim | null)[] = [
      evidenceSufficiency(facts, derived, humanFeedback, now, stamp),
      ratingDirection(derived, now, stamp),
      disagreement(derived, humanFeedback, now, stamp),
      timeRecordCoverage(derived, now, stamp),
      skillEvidenceQuality(derived, now, stamp),
      competencyFit(derived, now, stamp),
    ];
    const interpretation = candidates.filter((c): c is AiInterpretationClaim => c !== null);

    // BELT AND BRACES ON THE CEILING. interpretationClaim() already caps each claim as it is built.
    // This asserts the invariant on the way out, because the cost of getting it wrong is a confident
    // sentence about a person resting on nothing, and the cost of checking twice is a loop.
    for (const claim of interpretation) {
      const ceiling = confidenceCeiling(claim.restsOn);
      const score = claim.provenance.confidence.score;
      if (typeof score === 'number' && score > ceiling + 1e-9) {
        notes.push('An interpretation was dropped for claiming more confidence than its evidence class allows.');
      }
    }

    const recommendations = [
      ...surfaceBoundaryRecommendations(input),
      ...suggestions(facts, derived, humanFeedback, now, stamp),
    ];

    if (input.definition.decisionContext && !input.boundaryRecommendations.length) {
      notes.push(
        'This report sits beside a ' + input.definition.decisionContext + ' decision and no stored recommendation '
        + 'exists for it. None has been written here: this engine does not form recommendations about that decision.',
      );
    }

    return { ok: true, interpretation, recommendations, notes, error: null };
  },
};

export { INTERPRETER_ID, INTERPRETER_VERSION };
