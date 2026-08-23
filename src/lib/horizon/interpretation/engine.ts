// src/lib/horizon/interpretation/engine.ts — FOUNDATIONAL FACTORS IN, PROFESSIONAL DIMENSIONS OUT.
//
// =================================================================================================
// PURE ON PURPOSE
// =================================================================================================
//
// Nothing in this file touches a database, a session or a request. It takes a validated factor set
// and an evidence context and returns an interpretation object. That is what makes the arithmetic
// below independently testable — every threshold, every ceiling and every demotion can be exercised
// with a fixture and no connection, which is the only way a rule about how loud an inference may be
// stays true after the sixth person edits it.
//
// =================================================================================================
// THE SIX-PART ANSWER, ON EVERY DIMENSION
// =================================================================================================
//
//   INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
//
// Not a comment: `explainability` is a field, populated for every dimension emitted, and it is built
// from the same numbers that produced the result rather than written alongside them. An explanation
// assembled separately from the computation is an explanation that can drift from it.
//
// =================================================================================================
// WHAT THE ARITHMETIC IS ALLOWED TO DO
// =================================================================================================
//
// It weighs, it averages, and it LOWERS confidence. There is no path in this file that raises the
// confidence of anything above what upstream supplied, and there is a hard ceiling below which every
// output is held no matter how strong or how numerous the inputs are:
//
//   INFERRED_CONFIDENCE_CEILING — the highest confidence an indication derived from indirect inputs
//   may ever carry. It is set below the top band deliberately: the `high` band exists in the shared
//   vocabulary and THIS LAYER CAN NEVER REACH IT. A dimension here is structurally incapable of
//   presenting itself as strongly as a demonstrated fact, whatever the inputs say.
//
// Four things lower it further, and each is reported in the explanation rather than applied quietly:
// thin coverage, disagreement between the inputs, an upstream that declared itself incomplete, and
// demonstrated work on record covering the same ground.
import {
  DIMENSION_IDS,
  DIMENSIONS,
  LEVEL_LABELS,
  CONFIDENCE_LABELS,
  implicationsFor,
  limitationsFor,
  type ConfidenceBand,
  type DimensionId,
  type DimensionLevel,
} from './dimensions';
import {
  contributionsFor,
  digestFactorSet,
  validateFactorSet,
  type FoundationalFactorSet,
  type HorizonSubject,
} from './contract';
import { guardList, guardText, type GuardGroupId } from './language-guard';
import { resolvePrecedence, type EvidenceContext, type Precedence } from './evidence';

export const ENGINE_VERSION = 'horizon-interpretation/1.0.0';

// =================================================================================================
// POLICY NUMBERS. Named, exported, and changed deliberately.
// =================================================================================================

/** Total mass a dimension needs before it may say anything at all. Below this it is `indeterminate`
 *  — reported as NOT INDICATED, never as low. */
export const MIN_MASS = 0.15;

/** Mass at which a dimension counts as fully covered by its inputs. Above it, coverage stops adding
 *  confidence: forty weak factors must not out-confidence three strong ones. */
export const FULL_COVERAGE_MASS = 1.0;

/** The ceiling described at the top of this file. */
export const INFERRED_CONFIDENCE_CEILING = 0.45;

/** Applied when the upstream itself said its inputs were incomplete. */
export const INCOMPLETE_INPUT_FACTOR = 0.8;

/** Signed score boundaries between levels. */
export const LEVEL_THRESHOLDS = {
  pronounced: 0.6,
  elevated: 0.25,
  limited: -0.25,
} as const;

/** Confidence band boundaries. `high` is unreachable while the ceiling stands, and that is the
 *  point of writing it down here rather than leaving the band vocabulary open-ended. */
export const CONFIDENCE_BAND_THRESHOLDS = {
  moderate: 0.3,
  high: 0.5,
} as const;

export const NOT_FOR_DECISIONS_NOTICE =
  'These are indications, not measurements. No hiring, rejection, promotion, termination or disciplinary decision may be made or supported on them. A named human decides, on demonstrated work, and records the reason.';

// =================================================================================================
// SHAPES
// =================================================================================================

export type FactorDirection = 'raises' | 'lowers' | 'neutral';

/** What reaches a standard viewer about one contributing input: an opaque id, its share of the
 *  dimension and which way it pointed. No code, no method, no upstream wording. */
export interface ContributingFactor {
  factorId: string;
  /** Share of this dimension's total input mass, 0..1. */
  share: number;
  direction: FactorDirection;
  /** Upstream's confidence in this input. */
  confidence: number;
}

/** The trace-only extension. Gated behind its own capability; see projectForViewer(). */
export interface ContributingFactorTrace extends ContributingFactor {
  method: string;
  methodVersion: string;
  /** Raw mass before normalisation, so a stored trace can be recomputed exactly. */
  mass: number;
  polarity: number;
}

export interface ExplainabilityRecord {
  inputs: string;
  processing: string;
  output: string;
  evidence: string;
  confidence: string;
  timestamp: string;
}

export interface RedactionRecord {
  where: string;
  groups: GuardGroupId[];
  terms: string[];
}

export interface DimensionInterpretation {
  dimension: DimensionId;
  label: string;
  description: string;
  notAbout: string;
  level: DimensionLevel;
  levelLabel: string;
  /** Signed orientation, -1..1. Present for ordering and for change-over-time comparison; it is not
   *  a score of the person and no surface labels it as one. */
  score: number;
  confidence: number;
  confidenceBand: ConfidenceBand;
  confidenceLabel: string;
  contributingFactors: ContributingFactor[];
  contributingFactorCount: number;
  explanation: string;
  implications: string[];
  limitations: string[];
  precedence: Precedence;
  precedenceNote: string;
  supersededByEvidence: boolean;
  evidenceSources: string[];
  /** Always true. A field rather than a doc line so it travels with an exported object. */
  notForDecisions: true;
  computedAt: string;
  explainability: ExplainabilityRecord;
  redactions: RedactionRecord[];
  /** Present only for viewers holding the trace capability. */
  trace?: ContributingFactorTrace[];
}

export type InterpretationState =
  | 'ok'
  | 'not_configured'
  | 'refused'
  | 'unreadable'
  | 'insufficient_input';

export interface InterpretationResult {
  state: InterpretationState;
  reason?: string;
  subject: HorizonSubject | null;
  engineVersion: string;
  /** sha256 prefix of the exact input this came from. The traceability link back to PATCH 02. */
  inputDigest: string;
  inputSourceModule: string;
  inputSourceVersion: string;
  inputComputedAt: string;
  inputComplete: boolean;
  consentRef: string | null;
  dimensions: DimensionInterpretation[];
  factorsConsidered: number;
  unmappedFactorCount: number;
  droppedFactorCount: number;
  redactionCount: number;
  generatedAt: string;
  notice: string;
  /** Problems found while validating the input. Shown, not swallowed. */
  problems: string[];
}

// =================================================================================================
// ARITHMETIC
// =================================================================================================

const round = (n: number, dp = 3): number => {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
};

export function levelFor(score: number, mass: number): DimensionLevel {
  if (!(mass >= MIN_MASS)) return 'indeterminate';
  if (score >= LEVEL_THRESHOLDS.pronounced) return 'pronounced';
  if (score >= LEVEL_THRESHOLDS.elevated) return 'elevated';
  if (score > LEVEL_THRESHOLDS.limited) return 'moderate';
  return 'limited';
}

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_BAND_THRESHOLDS.high) return 'high';
  if (confidence >= CONFIDENCE_BAND_THRESHOLDS.moderate) return 'moderate';
  if (confidence >= 0.15) return 'low';
  return 'very_low';
}

interface Bucket {
  factorId: string;
  mass: number;
  polarity: number;
  confidence: number;
  method: string;
  methodVersion: string;
}

/** How much the inputs disagree with their own average, 0 (unanimous) to 1 (evenly opposed).
 *  Exported because disagreement is a first-class property of an aggregate here, not a footnote:
 *  a dimension built from inputs pointing both ways must not present as confidently as one built
 *  from inputs that agree. */
export function dispersionOf(buckets: Bucket[], mean: number, mass: number): number {
  if (!buckets.length || mass <= 0) return 0;
  let acc = 0;
  for (const b of buckets) acc += b.mass * Math.abs(b.polarity - mean);
  // Max possible spread is 2 (a factor at -1 against a mean of +1), so halve to land in 0..1.
  return Math.min(1, acc / mass / 2);
}

function explanationSentence(
  spec: (typeof DIMENSIONS)[DimensionId],
  level: DimensionLevel,
  buckets: Bucket[],
  dispersion: number,
  band: ConfidenceBand,
): string {
  const n = buckets.length;
  if (level === 'indeterminate') {
    return (
      'Too little reached this dimension for anything to be indicated. It is reported as not indicated rather than as low, because an absence of input is not a finding about a person.'
    );
  }
  const up = buckets.filter((b) => b.polarity > 0.05).length;
  const down = buckets.filter((b) => b.polarity < -0.05).length;
  const flat = n - up - down;
  const parts: string[] = [];
  parts.push(
    n + ' input' + (n === 1 ? '' : 's') + ' contributed to ' + spec.label.toLowerCase() + '.',
  );
  const dirs: string[] = [];
  if (up) dirs.push(up + ' point' + (up === 1 ? 's' : '') + ' towards it');
  if (down) dirs.push(down + ' point' + (down === 1 ? 's' : '') + ' away from it');
  if (flat) dirs.push(flat + ' carr' + (flat === 1 ? 'ies' : 'y') + ' no direction');
  if (dirs.length) parts.push(dirs.join(', ') + '.');
  parts.push('Taken together they give a ' + LEVEL_LABELS[level].toLowerCase() + ', held at ' + CONFIDENCE_LABELS[band].toLowerCase() + '.');
  if (dispersion > 0.35) {
    parts.push(
      'The inputs disagree with each other to a noticeable degree, which is why the confidence is lower than the number of inputs alone would suggest.',
    );
  }
  return parts.join(' ');
}

function collectRedaction(into: RedactionRecord[], where: string, hits: { group: GuardGroupId; term: string }[]): void {
  if (!hits.length) return;
  into.push({
    where,
    groups: [...new Set(hits.map((h) => h.group))],
    terms: [...new Set(hits.map((h) => h.term))],
  });
}

// =================================================================================================
// THE ENTRY POINT
// =================================================================================================

export interface InterpretOptions {
  evidence?: EvidenceContext;
  /** Overrides the generation timestamp. Tests only — production always uses now(). */
  now?: string;
  /**
   * Refuse to interpret without a consent reference on the input. ON by default: sensitive personal
   * data is consent-controlled and purpose-limited, and an interpretation computed first and gated
   * afterwards has already been computed. A deployment whose consent is recorded elsewhere turns
   * this off explicitly and takes on the obligation of proving it.
   */
  requireConsent?: boolean;
}

/**
 * Interpret one validated factor set.
 *
 * Every non-ok state returns a RESULT, not a throw: `not_configured`, `refused`, `unreadable` and
 * `insufficient_input` are all real answers a surface must render differently, and collapsing them
 * into an exception is how they end up rendered as an empty interpretation instead.
 */
export function interpret(set: FoundationalFactorSet, opts: InterpretOptions = {}): InterpretationResult {
  const generatedAt = opts.now || new Date().toISOString();
  const evidence: EvidenceContext = opts.evidence || { state: 'not_configured', items: [] };
  const requireConsent = opts.requireConsent !== false;

  const base: InterpretationResult = {
    state: 'refused',
    subject: (set && set.subject) || null,
    engineVersion: ENGINE_VERSION,
    inputDigest: '',
    inputSourceModule: (set && set.sourceModule) || '',
    inputSourceVersion: (set && set.sourceVersion) || '',
    inputComputedAt: (set && set.computedAt) || '',
    inputComplete: !!(set && set.complete),
    consentRef: (set && set.consentRef) || null,
    dimensions: [],
    factorsConsidered: 0,
    unmappedFactorCount: 0,
    droppedFactorCount: 0,
    redactionCount: 0,
    generatedAt,
    notice: NOT_FOR_DECISIONS_NOTICE,
    problems: [],
  };

  const validation = validateFactorSet(set);
  base.problems = validation.problems;
  base.droppedFactorCount = validation.dropped;

  if (!validation.factors.length) {
    return {
      ...base,
      state: 'insufficient_input',
      reason: 'No usable foundational input was supplied, so nothing was interpreted.',
    };
  }
  if (requireConsent && !set.consentRef) {
    // Refused BEFORE any arithmetic runs. Not computed-then-hidden: the numbers are never produced.
    return {
      ...base,
      state: 'refused',
      reason:
        'No consent record is attached to this input. Interpretation is not performed without one, so nothing has been computed or stored.',
    };
  }

  base.inputDigest = digestFactorSet({ ...set, factors: validation.factors });
  base.factorsConsidered = validation.factors.length;

  // Bucket every factor into the dimensions it declares. A factor reaching none is unmapped.
  const byDimension = new Map<DimensionId, Bucket[]>();
  for (const id of DIMENSION_IDS) byDimension.set(id, []);
  let unmapped = 0;
  for (const f of validation.factors) {
    const contribs = contributionsFor(f);
    if (!contribs.length) {
      unmapped++;
      continue;
    }
    for (const c of contribs) {
      byDimension.get(c.dimension)!.push({
        factorId: f.id,
        mass: f.weight * c.weight,
        // A CONTRIBUTION'S OWN DIRECTION WINS. An upstream that publishes magnitudes with no sign —
        // which is the correct thing for a computation layer to publish — leaves direction to the
        // mapping, and the mapping is where a named human recorded the claim. Falling back to the
        // factor's polarity keeps every upstream that does carry a sign working unchanged.
        polarity: c.polarity === undefined ? f.polarity : c.polarity,
        confidence: f.confidence,
        method: f.method,
        methodVersion: f.methodVersion,
      });
    }
  }
  base.unmappedFactorCount = unmapped;
  if (unmapped) {
    base.problems = [
      ...base.problems,
      unmapped +
        ' input(s) declared no professional dimension and contributed to nothing. This interpretation covers less than the input it was given.',
    ];
  }

  const redactions: RedactionRecord[] = [];
  const dimensions: DimensionInterpretation[] = [];

  for (const id of DIMENSION_IDS) {
    const buckets = byDimension.get(id)!;
    const spec = DIMENSIONS[id];
    const mass = buckets.reduce((a, b) => a + b.mass, 0);
    const score = mass > 0 ? buckets.reduce((a, b) => a + b.mass * b.polarity, 0) / mass : 0;
    const level = levelFor(score, mass);

    // A dimension nothing reached is omitted entirely rather than emitted as "not indicated" with
    // zero inputs. Twelve empty rows on a screen read as twelve findings; nothing is not a finding.
    if (!buckets.length) continue;

    const dispersion = dispersionOf(buckets, score, mass);
    const coverage = Math.min(1, mass / FULL_COVERAGE_MASS);
    const upstreamConfidence = mass > 0 ? buckets.reduce((a, b) => a + b.mass * b.confidence, 0) / mass : 0;

    // ORDER MATTERS, AND IT WAS WRONG THE FIRST TIME. The ceiling is applied BEFORE the demotions,
    // not after: with the demotions folded in first, a dimension built from inputs pointing both
    // ways clamped to exactly the same number as a unanimous one, and the disagreement vanished from
    // the output that was supposed to report it. Cap first, then let every demotion bite below the
    // cap — so agreement, completeness and evidence precedence always move the number.
    const agreementFactor = 1 - dispersion;
    const beforeCeiling = upstreamConfidence * coverage;
    const prec = resolvePrecedence(id, evidence);
    let confidence = Math.min(beforeCeiling, INFERRED_CONFIDENCE_CEILING);
    confidence *= agreementFactor;
    if (!set.complete) confidence *= INCOMPLETE_INPUT_FACTOR;
    confidence = round(Math.max(0, Math.min(1, confidence * prec.confidenceFactor)), 2);
    const band = bandFor(confidence);

    const contributing: ContributingFactor[] = buckets
      .slice()
      .sort((a, b) => b.mass - a.mass)
      .map((b) => ({
        factorId: b.factorId,
        share: round(mass > 0 ? b.mass / mass : 0),
        direction: (b.polarity > 0.05 ? 'raises' : b.polarity < -0.05 ? 'lowers' : 'neutral') as FactorDirection,
        confidence: round(b.confidence, 2),
      }));

    const trace: ContributingFactorTrace[] = buckets
      .slice()
      .sort((a, b) => b.mass - a.mass)
      .map((b) => ({
        factorId: b.factorId,
        share: round(mass > 0 ? b.mass / mass : 0),
        direction: (b.polarity > 0.05 ? 'raises' : b.polarity < -0.05 ? 'lowers' : 'neutral') as FactorDirection,
        confidence: round(b.confidence, 2),
        method: b.method,
        methodVersion: b.methodVersion,
        mass: round(b.mass),
        polarity: round(b.polarity),
      }));

    // ---------------------------------------------------------------------------------------------
    // EVERY STRING BELOW GOES THROUGH THE GUARD, INCLUDING THE ONES THIS FILE WROTE.
    //
    // The catalogue text is reviewed and tested, and it still passes through here. Defence in depth
    // is the point: a future edit to dimensions.ts that slips a forbidden word past review is caught
    // at emit time by the same mechanism that catches an upstream note, and is recorded rather than
    // rendered.
    // ---------------------------------------------------------------------------------------------
    const rawExplanation = explanationSentence(spec, level, buckets, dispersion, band);
    const guardedExplanation = guardText(rawExplanation);
    collectRedaction(redactions, id + '.explanation', guardedExplanation.hits);

    const rawImplications = level === 'indeterminate' || prec.superseded ? [] : implicationsFor(id, level);
    const guardedImplications = guardList(rawImplications);
    collectRedaction(redactions, id + '.implications', guardedImplications.hits);

    const guardedLimitations = guardList(limitationsFor(id));
    collectRedaction(redactions, id + '.limitations', guardedLimitations.hits);

    const guardedDescription = guardText(spec.description);
    collectRedaction(redactions, id + '.description', guardedDescription.hits);
    const guardedNotAbout = guardText(spec.notAbout);
    collectRedaction(redactions, id + '.notAbout', guardedNotAbout.hits);
    const guardedPrecedence = guardText(prec.sentence);
    collectRedaction(redactions, id + '.precedence', guardedPrecedence.hits);

    const explainability: ExplainabilityRecord = {
      inputs:
        buckets.length +
        ' foundational input(s) from ' +
        (set.sourceModule || 'an unnamed source') +
        ' ' +
        (set.sourceVersion ? 'version ' + set.sourceVersion + ' ' : '') +
        'computed at ' +
        (set.computedAt || 'an unrecorded time') +
        '; input fingerprint ' +
        base.inputDigest +
        (set.complete ? '.' : '. The source reported its own inputs as incomplete.'),
      processing:
        'Each input was weighted by the share it declares for this dimension, combined into a single signed orientation of ' +
        round(score, 2) +
        ' over a total input mass of ' +
        round(mass, 2) +
        ', and banded against fixed thresholds. No input was reweighted, added or inferred by this layer.',
      output:
        spec.label + ': ' + LEVEL_LABELS[level] + (level === 'indeterminate' ? '.' : ' (' + round(score, 2) + ').'),
      evidence: guardedPrecedence.text,
      confidence:
        'Upstream confidence averaged ' +
        round(upstreamConfidence, 2) +
        ', scaled by coverage ' +
        round(coverage, 2) +
        ', giving ' +
        round(beforeCeiling, 2) +
        '. Held at the ceiling of ' +
        INFERRED_CONFIDENCE_CEILING +
        ' that applies to every indication from this layer, then reduced for agreement between inputs (factor ' +
        round(agreementFactor, 2) +
        ')' +
        (set.complete ? '' : ', reduced for incomplete source input (factor ' + INCOMPLETE_INPUT_FACTOR + ')') +
        (prec.confidenceFactor < 1 ? ', reduced on evidence precedence (factor ' + prec.confidenceFactor + ')' : '') +
        ', for a final confidence of ' +
        confidence +
        '.',
      timestamp: generatedAt,
    };

    dimensions.push({
      dimension: id,
      label: spec.label,
      description: guardedDescription.text,
      notAbout: guardedNotAbout.text,
      level,
      levelLabel: LEVEL_LABELS[level],
      score: round(score, 2),
      confidence,
      confidenceBand: band,
      confidenceLabel: CONFIDENCE_LABELS[band],
      contributingFactors: contributing,
      contributingFactorCount: contributing.length,
      explanation: guardedExplanation.text,
      implications: guardedImplications.items,
      limitations: guardedLimitations.items,
      precedence: prec.precedence,
      precedenceNote: guardedPrecedence.text,
      supersededByEvidence: prec.superseded,
      evidenceSources: prec.sources,
      notForDecisions: true,
      computedAt: generatedAt,
      explainability,
      redactions: redactions.filter((r) => r.where.startsWith(id + '.')),
      trace,
    });
  }

  if (!dimensions.length) {
    return {
      ...base,
      state: 'insufficient_input',
      reason:
        'None of the supplied inputs declared a professional dimension, so there was nothing to interpret. This is a configuration gap in the input source, not a finding about this person.',
    };
  }

  return {
    ...base,
    state: 'ok',
    dimensions,
    redactionCount: redactions.length,
  };
}

// =================================================================================================
// RBAC PROJECTION
// =================================================================================================

export interface ViewerCapabilities {
  /** May see the neutral dimensions at all. */
  view: boolean;
  /** May see the explainability record and the input trace back to PATCH 02. */
  trace: boolean;
}

/**
 * What a particular viewer is allowed to receive.
 *
 * The trace and the explainability record are the internal computation detail, and a role without
 * the trace capability does not get them ABSENT-ON-THE-SCREEN, it gets them absent from the object.
 * A field hidden by a template is a field one JSON endpoint away from being visible.
 *
 * Called on the way OUT of the engine and never on the way in, so nothing is filtered before it is
 * recorded: the stored interpretation is always the complete one, and the audit trail is complete
 * even when a given viewer's copy is not.
 */
export function projectForViewer(result: InterpretationResult, caps: ViewerCapabilities): InterpretationResult {
  if (!caps.view) {
    return {
      ...result,
      state: 'refused',
      reason: 'This account does not hold the capability required to view professional interpretations.',
      dimensions: [],
      problems: [],
    };
  }
  if (caps.trace) return result;
  return {
    ...result,
    dimensions: result.dimensions.map((d) => {
      const copy: DimensionInterpretation = { ...d };
      delete copy.trace;
      // The COUNT stays. A viewer who cannot see WHICH inputs produced a dimension can still see how
      // many there were, which is the difference between an unexplained number and an opaque one —
      // and they can ask, which is the point of having recorded it.
      copy.contributingFactors = [];
      copy.explainability = {
        inputs: d.contributingFactorCount + ' input(s) were considered.',
        processing: 'Combined and banded by a fixed, written-down rule. The detail of that rule is restricted.',
        output: d.label + ': ' + d.levelLabel + '.',
        evidence: d.precedenceNote,
        confidence: d.confidenceLabel + '.',
        timestamp: d.computedAt,
      };
      return copy;
    }),
  };
}

/** Self-check in this repository's existing style: an empty list is a pass. */
export function engineSelfCheck(): string[] {
  const problems: string[] = [];
  if (INFERRED_CONFIDENCE_CEILING >= CONFIDENCE_BAND_THRESHOLDS.high) {
    problems.push('The confidence ceiling allows the high band, which this layer must never reach.');
  }
  if (bandFor(INFERRED_CONFIDENCE_CEILING) === 'high') {
    problems.push('bandFor() returns the high band at the ceiling.');
  }
  if (levelFor(1, 0) !== 'indeterminate') {
    problems.push('A dimension with no input mass does not report as indeterminate.');
  }
  return problems;
}
