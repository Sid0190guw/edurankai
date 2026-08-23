// src/lib/horizon/report/provenance.ts — THE RULES A CLAIM MUST PASS BEFORE IT MAY BE PRINTED.
//
// Every function here is pure. That is deliberate: the guarantees this module makes are the ones the
// whole patch rests on, and a guarantee that can only be checked against a live database is a
// guarantee nobody checks. report.test.ts exercises all of it with no connection.
//
// THREE THINGS HAPPEN HERE.
//
//   1. BUILDERS. One per section, so a claim cannot be constructed without its provenance. There is
//      no path that produces a Claim object with an empty stamp, because the builders are the only
//      thing that produces Claim objects and they take the stamp as an argument.
//
//   2. VALIDATION. validateClaim() returns the reason a claim may not be shown, or null. The engine
//      DROPS a claim that fails and records the drop in document.integrity.rejected — it does not
//      print it unvalidated and it does not fail the whole report. A report missing one metric is
//      useful; a report with one unsourced sentence in it is not trustworthy anywhere.
//
//   3. CEILINGS. confidenceCeiling() implements the brief's rule that demonstrated evidence must
//      outweigh inference. It is arithmetic rather than advice — see EVIDENCE_WEIGHT in types.ts.
//
// AND ONE THING IS REFUSED OUTRIGHT. forbiddenSubjectIn() is the list of things a report about a
// person may never be about, whatever a provider hands over: health, protected attributes, and
// birth-based reckoning. It is checked on the text of every claim, not on the provider that
// produced it, because the provider list will grow and this check should not have to be remembered
// by whoever grows it.
import {
  EVIDENCE_WEIGHT,
  type AiInterpretationClaim,
  type AiPermittedAct,
  type Claim,
  type Confidence,
  type ConfidenceLevel,
  type ConsequentialDecision,
  type DerivedClaim,
  type EngineStamp,
  type EvidenceRef,
  type FactClaim,
  type HumanDecisionClaim,
  type HumanFeedbackClaim,
  type Interpreter,
  type Provenance,
  type RecommendationClaim,
  type SectionKind,
  type SourceRef,
} from './types';
import { ENGINE_ID, ENGINE_VERSION } from './version';

// =================================================================================================
// WHAT A REPORT ABOUT A PERSON MAY NEVER BE ABOUT
// =================================================================================================
//
// Matched case-insensitively against the readable text of a claim — its statement, label, method,
// reasoning and body. A match REFUSES the claim; it does not redact it and it does not warn.
//
// THE LIST IS PRECISE ON PURPOSE, and the precision is load-bearing. An earlier draft of this idea
// would have blocked the bare word "cycle", which appears in `hr_review_cycles` and in the title of
// every performance cycle in the organisation — a guard that breaks the legitimate half of the
// product gets deleted within the week and takes the illegitimate half with it. So: "menstrual",
// not "cycle".
//
// BIRTH-BASED VOCABULARY IS NOT ON THIS LIST, AND THAT IS A DELIBERATE HANDOVER.
//
// src/lib/horizon/contracts.ts already owns that rule and implements it differently: screenTerminology()
// REPLACES the term with NEUTRAL_TERM rather than refusing the claim, and its FORBIDDEN_TERMS list is
// the canonical one for the whole HORIZON system. Two lists would drift, and mine would be the one
// nobody updated. The engine applies theirs as a transform before this validation runs — see
// neutraliseTerminology() in engine.ts — so by the time a claim reaches here the vocabulary is
// already neutral, and what remains for this list is the health and protected-attribute rule, which
// is stricter than neutralising and is CLAUDE.md's rather than the programme brief's.
export const FORBIDDEN_SUBJECTS: readonly string[] = [
  // Health. CLAUDE.md: no individual health data reaches any admin surface, and nothing in this
  // codebase diagnoses anybody.
  'health', 'medical', 'diagnosis', 'diagnose', 'diagnosed', 'illness', 'symptom',
  'menstrual', 'menstruation', 'pregnancy', 'pregnant', 'disability', 'disabled',
  'therapy', 'psychiatric', 'mental illness',
  // Protected attributes that may not influence a decision. ai-boundary refuses these as inputs to
  // its recommendations; this refuses them as SUBJECTS of a report claim, which is the other half.
  'religion', 'religious', 'caste', 'ethnicity', 'sexual orientation', 'marital status',
  'blood group', 'aadhaar', 'pan number',
  // Birth DATES specifically — an age or a birthday is not something a professional report needs,
  // and it is the one birth-related string screenTerminology() does not cover because it is not a
  // method name.
  'date of birth', 'birth date', 'birthdate',
];

/** The matched term, or null. Word-ish matching: substring, but the list carries no short words. */
export function forbiddenSubjectIn(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null;
  const hay = text.toLowerCase();
  for (const term of FORBIDDEN_SUBJECTS) {
    if (hay.indexOf(term) >= 0) return term;
  }
  return null;
}

/**
 * Relations no provider may declare it reads. Checked when a provider registers, and again by a
 * test, because a registration-time check only fires if somebody runs the code path.
 *
 * The wellness system is women-only, gated server-side, and its own module states that an admin
 * screen returning a row per user is the screen that must not exist. A report engine is exactly the
 * shape of thing that would build one by accident.
 */
export const FORBIDDEN_TABLE_PATTERNS: readonly RegExp[] = [
  /wellness/i,
  /consult/i,
  /legal_hold/i,
  /_health/i,
  /^health/i,
];

export function forbiddenTableIn(tables: readonly string[]): string | null {
  for (const t of tables) {
    for (const rx of FORBIDDEN_TABLE_PATTERNS) if (rx.test(t)) return t;
  }
  return null;
}

// =================================================================================================
// STAMPS AND SOURCES
// =================================================================================================

/**
 * The engine stamp every claim carries. Built once per run and shared by reference, so a document
 * cannot contain two claims that disagree about which code produced them.
 */
export function engineStamp(interpreter?: Interpreter | null): EngineStamp {
  return {
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    interpreterId: interpreter ? interpreter.id : null,
    interpreterVersion: interpreter ? interpreter.version : null,
    model: interpreter ? interpreter.model : null,
  };
}

export function sourceRef(input: {
  provider: string;
  system: string;
  table: string;
  ownedBy: string;
  recordId?: string | null;
  capturedAt?: string | null;
}): SourceRef {
  return {
    provider: input.provider,
    system: input.system,
    table: input.table,
    ownedBy: input.ownedBy,
    recordId: input.recordId ?? null,
    capturedAt: input.capturedAt ?? null,
  };
}

export function evidenceRef(kind: string, ref: string, label: string, url?: string | null): EvidenceRef {
  return { kind, ref, label, url: url ?? null };
}

// =================================================================================================
// CONFIDENCE
// =================================================================================================

/** A record, not an estimate. Carries no score, by design — see ConfidenceLevel in types.ts. */
export function observed(basis: string): Confidence {
  return { level: 'observed', score: null, basis };
}

/** Maps a 0-1 score onto the spoken ladder. One function, so two screens cannot draw the line differently. */
export function levelForScore(score: number): ConfidenceLevel {
  if (!Number.isFinite(score) || score <= 0) return 'insufficient';
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'moderate';
  if (score >= 0.2) return 'low';
  return 'insufficient';
}

export function estimated(score: number, basis: string): Confidence {
  const s = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  return { level: levelForScore(s), score: Number(s.toFixed(2)), basis };
}

/**
 * THE RULE THAT DEMONSTRATED EVIDENCE OUTWEIGHS INFERENCE, AS ARITHMETIC.
 *
 * Returns the highest weight among the classes an interpretation actually drew on. An interpretation
 * resting on recorded facts may reach 1.0; one resting only on other interpretations tops out at
 * 0.35 and can therefore never report better than "moderate". Resting on nothing returns 0, which
 * levelForScore reads as `insufficient` — the honest answer for a conclusion with no basis.
 */
export function confidenceCeiling(restsOn: readonly SectionKind[]): number {
  let ceiling = 0;
  for (const k of restsOn) {
    const w = EVIDENCE_WEIGHT[k];
    if (typeof w === 'number' && w > ceiling) ceiling = w;
  }
  return ceiling;
}

/**
 * Lowers a confidence to its ceiling and says so in the basis. Never raises one: a cap that could
 * increase a score would be a scoring function, and this is a limit.
 */
export function capConfidence(conf: Confidence, ceiling: number): Confidence {
  if (conf.level === 'observed') return conf;
  const score = typeof conf.score === 'number' ? conf.score : 0;
  if (score <= ceiling) return conf;
  const capped = Number(ceiling.toFixed(2));
  return {
    level: levelForScore(capped),
    score: capped,
    basis: conf.basis + ' Capped at ' + capped + ': this conclusion rests on inference rather than on recorded evidence.',
  };
}

// =================================================================================================
// CLAIM IDS
// =================================================================================================
//
// Deterministic, so two runs of the same report over unchanged data produce the same ids and a
// reader comparing last month's document to this one can see what actually moved. A random id would
// make every claim look new every time, which is the opposite of what a longitudinal report is for.

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function claimId(section: SectionKind, seed: string): string {
  return section + ':' + fnv1a(section + '|' + seed);
}

// =================================================================================================
// BUILDERS — THE ONLY WAY A CLAIM COMES INTO EXISTENCE
// =================================================================================================

function provenanceOf(input: {
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  confidence: Confidence;
  now: string;
  stamp: EngineStamp;
}): Provenance {
  return {
    sources: input.sources,
    evidence: input.evidence ?? [],
    confidence: input.confidence,
    generatedAt: input.now,
    engine: input.stamp,
  };
}

export function factClaim(input: {
  label: string;
  value: string;
  statement?: string;
  occurredAt?: string | null;
  major?: boolean;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  confidence?: Confidence;
  now: string;
  stamp: EngineStamp;
}): FactClaim {
  const statement = input.statement || (input.label + ': ' + input.value);
  return {
    kind: 'facts',
    id: claimId('facts', input.label + '|' + input.value),
    statement,
    label: input.label,
    value: input.value,
    occurredAt: input.occurredAt ?? null,
    major: input.major === true,
    // A fact defaults to `observed` and not to a score. If a provider wants to say a record is
    // uncertain, it must say why in a basis of its own rather than quietly attaching a number.
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: input.confidence || observed('Read from the record named in the source.'),
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

export function derivedClaim(input: {
  label: string;
  value: number | string;
  method: string;
  basisCount: number;
  unit?: string | null;
  window?: { from: string; to: string } | null;
  statement?: string;
  major?: boolean;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  confidence?: Confidence;
  now: string;
  stamp: EngineStamp;
}): DerivedClaim {
  const shown = typeof input.value === 'number' ? String(input.value) : input.value;
  const statement = input.statement || (input.label + ': ' + shown + (input.unit ? ' ' + input.unit : ''));
  // A DERIVED METRIC'S CONFIDENCE IS ABOUT ITS DENOMINATOR, NOT ITS SUBJECT. Averaging two records
  // and averaging two hundred produce numbers that look identical on a screen and mean different
  // things, and the reader cannot tell which they are looking at. So the default confidence is a
  // function of basisCount, and it is stated rather than assumed.
  const n = Math.max(0, Math.round(input.basisCount));
  const auto = n === 0
    ? estimated(0, 'No records fell inside the window, so there is nothing to compute from.')
    : estimated(Math.min(0.95, 0.4 + Math.min(n, 12) * 0.05), 'Computed from ' + n + ' record' + (n === 1 ? '' : 's') + '.');
  return {
    kind: 'derived',
    id: claimId('derived', input.label + '|' + input.method),
    statement,
    label: input.label,
    value: input.value,
    unit: input.unit ?? null,
    method: input.method,
    window: input.window ?? null,
    basisCount: n,
    major: input.major === true,
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: input.confidence || auto,
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

export function feedbackClaim(input: {
  author: { id: string | null; name: string; relation: string };
  theme: string;
  body: string;
  recordedAt: string | null;
  weight: number;
  dissent?: boolean;
  outlier?: boolean;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  now: string;
  stamp: EngineStamp;
}): HumanFeedbackClaim {
  return {
    kind: 'human_feedback',
    id: claimId('human_feedback', (input.author.id || input.author.name) + '|' + input.theme + '|' + input.body.slice(0, 64)),
    // The statement names the person and their relation to the subject, because "somebody said this"
    // and "your manager said this" are different pieces of information and only one of them is fair
    // to read without the other.
    statement: input.author.name + ' (' + input.author.relation + ') on ' + input.theme,
    author: input.author,
    theme: input.theme,
    body: input.body,
    recordedAt: input.recordedAt,
    weight: Math.max(0, Math.min(1, input.weight)),
    dissent: input.dissent === true,
    outlier: input.outlier === true,
    // A recorded opinion IS an observed record. What is uncertain is whether it is right, and that
    // is not something a confidence score can answer — which is why disagreement is preserved as
    // `dissent` rather than folded into a number.
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: observed('This is what the named person wrote, quoted rather than summarised.'),
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

export function interpretationClaim(input: {
  statement: string;
  act: AiPermittedAct;
  reasoning: string;
  assumptions: string;
  uncertainty: string;
  restsOn: SectionKind[];
  score: number;
  basis: string;
  major?: boolean;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  now: string;
  stamp: EngineStamp;
}): AiInterpretationClaim {
  const ceiling = confidenceCeiling(input.restsOn);
  return {
    kind: 'ai_interpretation',
    id: claimId('ai_interpretation', input.statement),
    statement: input.statement,
    act: input.act,
    reasoning: input.reasoning,
    assumptions: input.assumptions,
    uncertainty: input.uncertainty,
    restsOn: input.restsOn,
    major: input.major === true,
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: capConfidence(estimated(input.score, input.basis), ceiling),
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

export function recommendationClaim(input: {
  statement: string;
  suggestedAction: string;
  forDecisionKind?: ConsequentialDecision | null;
  boundaryRecommendationId?: string | null;
  score: number;
  basis: string;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  now: string;
  stamp: EngineStamp;
}): RecommendationClaim {
  return {
    kind: 'recommendation',
    id: claimId('recommendation', input.statement),
    statement: input.statement,
    suggestedAction: input.suggestedAction,
    forDecisionKind: input.forDecisionKind ?? null,
    boundaryRecommendationId: input.boundaryRecommendationId ?? null,
    // Literals, not parameters. There is no argument that sets these to anything else.
    overridable: true,
    requiresHumanDecision: true,
    major: true,
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: estimated(input.score, input.basis),
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

export function humanDecisionClaim(input: {
  decidedByUserId: string;
  decidedByName: string;
  decidedAt: string | null;
  decision: string;
  decisionKind: string;
  followedRecommendation: boolean | null;
  overrideReason: string | null;
  recommendationId: string | null;
  sources: SourceRef[];
  evidence?: EvidenceRef[];
  now: string;
  stamp: EngineStamp;
}): HumanDecisionClaim {
  return {
    kind: 'human_decision',
    id: claimId('human_decision', input.decidedByUserId + '|' + (input.decidedAt || '') + '|' + input.decision.slice(0, 64)),
    statement: input.decidedByName + ' decided: ' + input.decision,
    decidedByUserId: input.decidedByUserId,
    decidedByName: input.decidedByName,
    decidedAt: input.decidedAt,
    decision: input.decision,
    decisionKind: input.decisionKind,
    followedRecommendation: input.followedRecommendation,
    overrideReason: input.overrideReason,
    recommendationId: input.recommendationId,
    major: true,
    provenance: provenanceOf({
      sources: input.sources,
      evidence: input.evidence,
      confidence: observed('A decision recorded against a named person, read back unchanged.'),
      now: input.now,
      stamp: input.stamp,
    }),
  };
}

// =================================================================================================
// VALIDATION
// =================================================================================================

/** Readable text of a claim, for the forbidden-subject check. Structured fields, never the ids. */
function readableTextOf(claim: Claim): string[] {
  const out: string[] = [claim.statement];
  switch (claim.kind) {
    case 'facts': out.push(claim.label, claim.value); break;
    case 'derived': out.push(claim.label, claim.method, claim.unit || ''); break;
    case 'human_feedback': out.push(claim.theme, claim.body); break;
    case 'ai_interpretation': out.push(claim.reasoning, claim.assumptions, claim.uncertainty); break;
    case 'recommendation': out.push(claim.suggestedAction); break;
    case 'human_decision': out.push(claim.decision, claim.overrideReason || ''); break;
  }
  return out;
}

/**
 * The reason this claim may not be printed, or null.
 *
 * Ordered cheapest-first, and the order also puts the SAFETY refusals ahead of the completeness
 * ones: a claim about somebody's health is refused for being about somebody's health, not for
 * having a thin source list, and the message a reviewer reads should say the former.
 */
export function validateClaim(claim: Claim): string | null {
  if (!claim || typeof claim !== 'object') return 'Not a claim.';
  if (!claim.statement || !claim.statement.trim()) return 'A claim with no statement cannot be read.';

  for (const text of readableTextOf(claim)) {
    const hit = forbiddenSubjectIn(text);
    if (hit) return 'Refused: a report about a person may not be about "' + hit + '".';
  }

  const p = claim.provenance;
  if (!p) return 'No provenance.';
  if (!Array.isArray(p.sources) || p.sources.length === 0) return 'No source: nothing says where this came from.';
  for (const s of p.sources) {
    if (!s || !s.table || !s.system || !s.provider) return 'A source must name its provider, system and relation.';
  }
  if (!p.confidence || !p.confidence.level) return 'No confidence.';
  if (!p.confidence.basis || !p.confidence.basis.trim()) return 'Confidence with no stated basis is a number nobody can argue with.';
  if (p.confidence.level !== 'observed' && typeof p.confidence.score !== 'number') {
    return 'An estimated confidence must carry a score.';
  }
  if (!p.generatedAt) return 'No generated timestamp.';
  if (!p.engine || !p.engine.engineId || !p.engine.engineVersion) return 'No engine version.';

  // MAJOR CONCLUSIONS NEED A ROW BEHIND THEM. This is the brief's requirement, and it is checked
  // here rather than trusted to the builders, because a builder is a convenience and this is a rule.
  if (claim.major && (!Array.isArray(p.evidence) || p.evidence.length === 0)) {
    return 'A major conclusion must point at least one piece of evidence at a real record.';
  }
  if (Array.isArray(p.evidence)) {
    for (const e of p.evidence) {
      if (!e || !e.kind || !e.ref || !e.label) return 'Evidence must name its kind, its record and a label.';
    }
  }

  // SECTION-SPECIFIC RULES.
  if (claim.kind === 'derived') {
    if (!claim.method || !claim.method.trim()) return 'A derived metric must state how it was computed.';
    if (typeof claim.basisCount !== 'number' || claim.basisCount < 0) return 'A derived metric must state how many records it counted.';
  }
  if (claim.kind === 'ai_interpretation') {
    if (!claim.reasoning.trim()) return 'An interpretation with no reasoning is an assertion.';
    if (!claim.uncertainty.trim()) return 'An interpretation must say what it is unsure of.';
    if (!Array.isArray(claim.restsOn) || claim.restsOn.length === 0) return 'An interpretation must say what it rests on.';
    const ceiling = confidenceCeiling(claim.restsOn);
    const score = typeof p.confidence.score === 'number' ? p.confidence.score : 0;
    if (score > ceiling + 1e-9) {
      return 'This interpretation claims more confidence than the evidence class it rests on permits.';
    }
  }
  if (claim.kind === 'recommendation') {
    if (claim.overridable !== true || claim.requiresHumanDecision !== true) {
      return 'A recommendation that is not overridable and does not require a human is a decision.';
    }
    // THE HARD ONE. This engine never mints its own recommendation about one of the six
    // consequential decisions. If a recommendation is tagged with a decision kind it must be an
    // ai_recommendations row that already passed ai-boundary's seven-question guard — the guard that
    // refuses a partial explanation and refuses a protected attribute as an input. A recommendation
    // about somebody's employment that skipped it does not get printed by this engine.
    if (claim.forDecisionKind && !claim.boundaryRecommendationId) {
      return 'A recommendation touching a consequential decision must come from a stored, fully explained recommendation.';
    }
  }
  if (claim.kind === 'human_decision') {
    if (!claim.decidedByUserId) return 'A decision with no named decider is not a human decision.';
    if (claim.followedRecommendation === false && !(claim.overrideReason || '').trim()) {
      return 'A decision that departed from the recommendation must record why.';
    }
  }
  return null;
}

/** Partition a batch into what may be printed and what may not, keeping the reasons. */
export function screenClaims<T extends Claim>(claims: T[]): {
  kept: T[];
  rejected: { section: SectionKind; statement: string; reason: string }[];
} {
  const kept: T[] = [];
  const rejected: { section: SectionKind; statement: string; reason: string }[] = [];
  for (const c of claims) {
    const reason = validateClaim(c);
    if (reason) rejected.push({ section: c.kind, statement: c.statement || '(no statement)', reason });
    else kept.push(c);
  }
  return { kept, rejected };
}
