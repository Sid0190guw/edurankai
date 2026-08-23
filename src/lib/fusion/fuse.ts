// src/lib/fusion/fuse.ts — THE FUSION CORE. PURE, TOTAL, AND THE PART WORTH TESTING.
//
// =================================================================================================
// WHAT HAPPENS HERE, IN ORDER, AND NOTHING ELSE HAPPENS HERE
// =================================================================================================
//
//   1. SCREEN     every signal, and refuse — by name, never quietly — anything that names a
//                 protected attribute, a forbidden inference, or a surveillance signal.
//   2. GROUP      the survivors into the five source classes. All five are reported, including the
//                 silent ones, because "nobody said anything" and "we did not look" read identically
//                 on a screen unless one of them is printed.
//   3. ADMIT      or refuse the inferred foundation for this dimension, per DimensionSpec.
//   4. DEFER      — where demonstrated evidence contradicts the foundation, the foundation drops to
//                 zero for this dimension and the contradiction is stated in words.
//   5. COMBINE    what is left, weighted, into one reading — OR refuse to produce one.
//   6. EXPLAIN    inputs, processing, output, evidence, confidence, timestamp. Always all six.
//
// =================================================================================================
// THE REFUSALS, WHICH ARE THE POINT
// =================================================================================================
//
// NO SIGNALS AT ALL                 -> status 'nothing_on_record', reading null.
// ONLY INFERRED SIGNALS             -> status 'foundation_only', reading null. This is the floor
//                                      under the whole engine: an inference on its own never becomes
//                                      a number about a person, whatever weight it was given.
// INFERENCE INADMISSIBLE            -> shown, effectiveWeight 0, and the reason printed beside it.
//                                      A hidden refusal is not a refusal anybody can check.
//
// A REFUSAL IS NOT A ZERO. `reading` is null in all three cases above. Zero is a finding — "this
// person is at the bottom of this dimension" — and absence is not. This project has already learned
// the difference the expensive way, on a screen that rendered a failed query as an empty result.
//
// =================================================================================================
// TIME IS AN ARGUMENT
// =================================================================================================
//
// Every function that needs "now" takes it. Nothing here reads the clock on its own, so the same
// inputs produce the same output in a test as in production — which is what makes the arithmetic
// below something a person can check rather than something they have to trust.
import {
  DEMONSTRATED_CLASSES,
  INFERRED_CLASS,
  SOURCE_CLASSES,
  SOURCE_CLASS_LABELS,
  AGREEMENT_LABELS,
  CONFIDENCE_BAND_LABELS,
  brandReading,
  dimensionSpec,
  isDemonstrated,
  isFusionDimension,
  isInverted,
  isSourceClass,
  type Agreement,
  type ConfidenceBand,
  type ConfidenceDirection,
  type ConfidenceReport,
  type DimensionReading,
  type DimensionSpec,
  type Explanation,
  type FusionDimension,
  type Signal,
  type SourceClass,
  type SourceView,
  type ReadingStatus,
} from './types';
import { completenessPct, type SourceWeights } from './weights';
// ONE VOCABULARY, ONE OWNER. src/lib/provenance.ts holds the protected, forbidden and consequential
// patterns and refuses on them for the whole product. This module does NOT keep a second copy to
// drift against it — it asks the owner. The functions are plain regex tests over a string, so they
// screen a free-text statement exactly as well as they screen a column name.
import { isProtectedField, isForbiddenField, isConsequentialDecision } from '@/lib/provenance';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Every one declared ABOVE the functions that read them — `const` is not hoisted, and a
// const read before its declaration throws on the first line of the function that reads it.
// -------------------------------------------------------------------------------------------------

/** Positions live on -1..+1, so the widest possible gap between two of them is 2. */
const POSITION_MIN = -1;
const POSITION_MAX = 1;

/** Two source classes further apart than this are contradicting each other, not merely differing. */
export const CONTRADICTION_GAP = 1.0;

/** Inside this, a class is saying the same thing as the foundation. */
export const STRONG_AGREEMENT_GAP = 0.25;

/** Inside this, it is saying a weaker version of the same thing. */
export const PARTIAL_AGREEMENT_GAP = 0.6;

/** Below this share of the weighting, a reading is reported as thin however tidy its arithmetic. */
export const THIN_COMPLETENESS = 40;

/** Fewer independent demonstrated classes than this, and a reading is thin whatever its completeness. */
export const MIN_INDEPENDENT_SOURCES = 2;

/** How far confidence must move between snapshots before it is called a move rather than noise. */
export const CONFIDENCE_MOVE = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recency scoring. A judgement from four years ago is a record, not a current reading. */
const RECENT_DAYS = 90;
const STALE_DAYS = 365;
const ANCIENT_DAYS = 730;

const CONFIDENCE_HIGH = 70;
const CONFIDENCE_MODERATE = 45;
const CONFIDENCE_LOW = 20;

/** The most development needs one dimension will list. A list nobody reads is not a list. */
const MAX_DEVELOPMENT_NEEDS = 6;

const ADVISORY_NOTICE_REQUIRED =
  'An inferred signal must carry an advisory notice — the sentence that says what it is not. This '
  + 'one did not, so it was refused rather than shown without it.';

const DECISION_SENTENCE =
  'This is an advisory reading. It decides nothing. Hiring, rejection, promotion, termination, pay '
  + 'and discipline are decided by a named human, in the module that owns that decision.';

// -------------------------------------------------------------------------------------------------
// SMALL PURE HELPERS
// -------------------------------------------------------------------------------------------------

export const clamp = (n: number, lo: number, hi: number): number =>
  (!isFinite(n) ? lo : n < lo ? lo : n > hi ? hi : n);

/** -1..+1 onto 0..100. The ONLY place a position becomes a number a person reads. */
export const positionToReading = (p: number): number =>
  Math.round(((clamp(p, POSITION_MIN, POSITION_MAX) - POSITION_MIN) / (POSITION_MAX - POSITION_MIN)) * 100);

const parseAt = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isFinite(t) ? t : null;
};

const daysBetween = (thenMs: number, nowMs: number): number =>
  Math.max(0, Math.round((nowMs - thenMs) / DAY_MS));

const newestOf = (signals: readonly Signal[]): string | null => {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const s of signals) {
    const t = parseAt(s.observedAt);
    if (t === null) continue;
    if (best === null || t > best) { best = t; bestIso = s.observedAt; }
  }
  return bestIso;
};

const sentenceList = (items: readonly string[]): string => {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
};

// -------------------------------------------------------------------------------------------------
// SCREENING — THE FIRST THING THAT HAPPENS TO ANY SIGNAL
// -------------------------------------------------------------------------------------------------

export interface ScreenResult {
  ok: boolean;
  /** The reason it was refused, naming the rule. Present only when ok is false. */
  because?: string;
}

/**
 * Refuse a signal that has no business existing.
 *
 * SIX REFUSALS, AND EVERY ONE OF THEM IS LOUD:
 *   - a dimension or source class outside the closed unions
 *   - a statement or basis naming a protected attribute (race, religion, caste, health, pregnancy,
 *     disability, marital status, gender, orientation, biometric, genetic — provenance.ts owns the list)
 *   - a statement or basis naming a forbidden inference or a surveillance signal (attrition risk,
 *     culture fit, personality, keystrokes, screenshots, activity scores — same owner)
 *   - a statement that reads as a CONSEQUENTIAL DECISION. This engine carries evidence about a
 *     person; it does not carry somebody's decision to fire them, and a signal that tried to would
 *     be an automated decision entering an advisory record through the back door.
 *   - an inferred signal with no advisory notice
 *   - a position or strength outside its range
 *
 * The caller keeps the refusals and PRINTS them. A refusal nobody sees is indistinguishable from a
 * signal nobody sent.
 */
export function screenSignal(s: Signal): ScreenResult {
  if (!s || typeof s !== 'object') {
    return { ok: false, because: 'The signal was not an object.' };
  }
  if (!isFusionDimension(s.dimension)) {
    return {
      ok: false,
      because: '"' + String(s.dimension) + '" is not one of the ten dimensions this engine reports. '
        + 'It was refused by name rather than dropped.',
    };
  }
  if (!isSourceClass(s.sourceClass)) {
    return {
      ok: false,
      because: '"' + String(s.sourceClass) + '" is not one of the five kinds of evidence this engine '
        + 'listens to. It was refused by name rather than dropped.',
    };
  }

  // THE OWNER'S PATTERNS WERE WRITTEN FOR COLUMN NAMES, AND THESE ARE SENTENCES.
  //
  // provenance.ts spells them snake_case — `flight_?risk`, `culture_?fit`, `activity_?score` — because
  // it screens field names. A provider writes prose, so "flight risk is elevated" walked straight
  // through a pattern that exists precisely to stop it. Rather than keep a second copy of the
  // vocabulary here to drift against the owner's, the TEXT is normalised into the shape the patterns
  // expect and asked twice: once as written, once as a field name would be spelled.
  const raw = String(s.statement || '') + ' ' + String(s.basis || '') + ' ' + String(s.locator || '');
  const asFieldName = raw.toLowerCase().replace(/[\s\-/]+/g, '_');
  const text = raw + ' ' + asFieldName;

  if (isProtectedField(text)) {
    return {
      ok: false,
      because: 'It names a protected or sensitive personal attribute. Nothing in this engine may '
        + 'infer, calculate, predict or recommend one, and no reading may rest on one.',
    };
  }
  if (isForbiddenField(text)) {
    return {
      ok: false,
      because: 'It names either a person-outcome prediction this product does not make, or a '
        + 'monitoring signal it does not collect. Neither may reach a reading about anybody.',
    };
  }
  if (isConsequentialDecision(text)) {
    return {
      ok: false,
      because: 'It reads as a hiring, rejection, termination, promotion, pay or discipline decision. '
        + 'Those are made by a named human in the module that owns them, and they do not enter an '
        + 'advisory profile as evidence.',
    };
  }

  if (!String(s.statement || '').trim()) {
    return { ok: false, because: 'It carried no statement, so there is nothing a person could read about themselves.' };
  }
  if (!String(s.basis || '').trim()) {
    return { ok: false, because: 'It carried no basis, so there is no way to check where it came from.' };
  }

  if (s.sourceClass === INFERRED_CLASS && !String(s.advisoryNotice || '').trim()) {
    return { ok: false, because: ADVISORY_NOTICE_REQUIRED };
  }

  if (!isFinite(s.position) || s.position < POSITION_MIN || s.position > POSITION_MAX) {
    return { ok: false, because: 'Its position was ' + String(s.position) + '. A position runs from -1 to +1.' };
  }
  if (!isFinite(s.strength) || s.strength < 0 || s.strength > 1) {
    return { ok: false, because: 'Its strength was ' + String(s.strength) + '. A strength runs from 0 to 1.' };
  }

  return { ok: true };
}

export interface ScreenedSignals {
  accepted: Signal[];
  refused: { signal: Signal; because: string }[];
}

export function screenAll(signals: readonly Signal[]): ScreenedSignals {
  const accepted: Signal[] = [];
  const refused: { signal: Signal; because: string }[] = [];
  for (const s of signals || []) {
    const r = screenSignal(s);
    if (r.ok) accepted.push(s);
    else refused.push({ signal: s, because: r.because || 'Refused.' });
  }
  return { accepted, refused };
}

// -------------------------------------------------------------------------------------------------
// ONE SOURCE CLASS'S OWN POSITION
// -------------------------------------------------------------------------------------------------

/**
 * A class's position is its signals' positions weighted by their strengths. A full appraisal and a
 * one-line remark are both one signal, and this is what stops them counting the same.
 *
 * ZERO TOTAL STRENGTH IS NOT ZERO POSITION. A class of signals that all carry strength 0 has said
 * nothing measurable, and returns null rather than the midpoint — which would read as "neutral", a
 * finding nobody made.
 */
export function classPosition(signals: readonly Signal[]): { position: number | null; strength: number } {
  let weighted = 0;
  let total = 0;
  for (const s of signals) {
    weighted += s.position * s.strength;
    total += s.strength;
  }
  if (total <= 0) return { position: null, strength: 0 };
  return { position: clamp(weighted / total, POSITION_MIN, POSITION_MAX), strength: total };
}

/** How one class stands against the inferred foundation. */
export function agreementOf(classPos: number | null, foundationPos: number | null): Agreement {
  if (classPos === null) return 'silent';
  if (foundationPos === null) return 'no_foundation_to_compare';
  const gap = Math.abs(classPos - foundationPos);
  if (gap <= STRONG_AGREEMENT_GAP) return 'strongly_confirms';
  if (gap <= PARTIAL_AGREEMENT_GAP) return 'partially_confirms';
  if (gap >= CONTRADICTION_GAP) return 'contradicts';
  return 'does_not_confirm';
}

// -------------------------------------------------------------------------------------------------
// CONFIDENCE
// -------------------------------------------------------------------------------------------------

/**
 * FOUR THINGS MAKE A READING TRUSTWORTHY, AND BREADTH MAKES IT MOST.
 *
 *   breadth   0.50   how many INDEPENDENT demonstrated classes spoke. Four voices that came to the
 *                    same place beat one loud one, and nothing else in this calculation can make up
 *                    for having only one.
 *   volume    0.20   how much evidence there was in total.
 *   recency   0.20   how long ago the newest of it was. A judgement from four years ago is a record
 *                    of what somebody thought then.
 *   coherence 0.10   whether the classes agreed with each other.
 *
 * THE FOUNDATION CONTRIBUTES NOTHING TO CONFIDENCE, at any weight, on any dimension. Being more
 * certain about something because an inference agreed with it is exactly the failure this engine
 * exists to prevent — so the inferred class is not in the numerator and is not in the denominator.
 */
export function computeConfidence(input: {
  sources: readonly SourceView[];
  previousValue: number | null;
  nowMs: number;
}): ConfidenceReport {
  const demonstrated = input.sources.filter((v) => isDemonstrated(v.sourceClass) && v.signalCount > 0);
  const independentSources = demonstrated.filter((v) => v.position !== null).length;

  const newest = demonstrated
    .map((v) => parseAt(v.mostRecentAt))
    .filter((t): t is number => t !== null)
    .sort((a, b) => b - a)[0];
  const recencyDays = newest === undefined ? null : daysBetween(newest, input.nowMs);

  if (!independentSources) {
    return {
      band: 'insufficient',
      value: 0,
      independentSources: 0,
      recencyDays,
      direction: input.previousValue === null ? 'first_reading' : 'decreasing',
      previousValue: input.previousValue,
      sentence:
        'No demonstrated evidence contributed, so there is nothing to be confident about. This is '
        + 'not a low reading about a person; it is an empty record.',
    };
  }

  const breadth = independentSources / DEMONSTRATED_CLASSES.length;

  const totalStrength = demonstrated.reduce((s, v) => s + v.strength, 0);
  const volume = Math.min(1, totalStrength / 4);

  let recency = 0.5;
  if (recencyDays === null) recency = 0.25;
  else if (recencyDays <= RECENT_DAYS) recency = 1;
  else if (recencyDays <= STALE_DAYS) recency = 0.65;
  else if (recencyDays <= ANCIENT_DAYS) recency = 0.3;
  else recency = 0.1;

  const positions = demonstrated.map((v) => v.position).filter((p): p is number => p !== null);
  let coherence = 1;
  if (positions.length > 1) {
    const spread = Math.max(...positions) - Math.min(...positions);
    coherence = clamp(1 - spread / (POSITION_MAX - POSITION_MIN), 0, 1);
  }

  const value = Math.round(100 * (breadth * 0.5 + volume * 0.2 + recency * 0.2 + coherence * 0.1));

  let band: ConfidenceBand = 'insufficient';
  if (value >= CONFIDENCE_HIGH) band = 'high';
  else if (value >= CONFIDENCE_MODERATE) band = 'moderate';
  else if (value >= CONFIDENCE_LOW) band = 'low';

  let direction: ConfidenceDirection = 'first_reading';
  if (input.previousValue !== null) {
    const delta = value - input.previousValue;
    direction = delta > CONFIDENCE_MOVE ? 'increasing' : delta < -CONFIDENCE_MOVE ? 'decreasing' : 'steady';
  }

  const recencyPhrase = recencyDays === null
    ? 'none of it is dated'
    : recencyDays <= RECENT_DAYS
      ? 'the newest is ' + recencyDays + ' days old'
      : 'the newest is ' + recencyDays + ' days old, which is no longer current';

  const sentence =
    CONFIDENCE_BAND_LABELS[band] + '. ' + independentSources + ' of ' + DEMONSTRATED_CLASSES.length
    + ' kinds of demonstrated evidence contributed, and ' + recencyPhrase + '. '
    + (independentSources < MIN_INDEPENDENT_SOURCES
      ? 'One kind of evidence on its own cannot corroborate itself, which is what holds this down.'
      : positions.length > 1 && coherence < 0.6
        ? 'They do not agree closely with each other, which is what holds this down.'
        : 'They broadly agree with each other.');

  return { band, value, independentSources, recencyDays, direction, previousValue: input.previousValue, sentence };
}

// -------------------------------------------------------------------------------------------------
// THE FUSION ITSELF
// -------------------------------------------------------------------------------------------------

export interface PreviousReading {
  reading: number | null;
  confidenceValue: number | null;
  computedAt: string | null;
}

export interface FuseInput {
  dimension: FusionDimension;
  /** Every signal offered for this dimension. Screened here; the caller does not pre-filter. */
  signals: readonly Signal[];
  weights: SourceWeights;
  /** The same dimension at the previous snapshot, where there is one. */
  previous?: PreviousReading | null;
  /** Time is an argument. Nothing in this file reads the clock. */
  now: Date;
}

/**
 * Fuse one dimension.
 *
 * TOTAL. There is no input for which this throws and no input for which it returns a number it
 * cannot justify. Empty in, empty out, with the reason attached.
 */
export function fuseDimension(input: FuseInput): DimensionReading {
  const spec: DimensionSpec = dimensionSpec(input.dimension);
  const nowMs = input.now.getTime();
  const computedAt = input.now.toISOString();
  const inverted = isInverted(input.dimension);
  const previous = input.previous || null;

  // 1. SCREEN.
  const forThis = (input.signals || []).filter((s) => s && s.dimension === input.dimension);
  const { accepted, refused } = screenAll(forThis);

  // 2. GROUP — all five classes, always, silent ones included.
  const byClass = new Map<SourceClass, Signal[]>();
  for (const c of SOURCE_CLASSES) byClass.set(c, []);
  for (const s of accepted) byClass.get(s.sourceClass)!.push(s);

  const foundationSignals = byClass.get(INFERRED_CLASS)!;
  const foundation = classPosition(foundationSignals);

  // 3 + 4. ADMIT, then DEFER. Both are decided before any arithmetic runs, so the reason a class
  // did not count is a property of the reading rather than a side effect of it.
  const demonstratedViews: { c: SourceClass; pos: number | null; strength: number }[] =
    DEMONSTRATED_CLASSES.map((c) => {
      const { position, strength } = classPosition(byClass.get(c)!);
      return { c, pos: position, strength };
    });

  const speaking = demonstratedViews.filter((v) => v.pos !== null);

  // The demonstrated consensus: the weighted centre of what the record actually shows. It is what
  // the foundation is measured against, and it is never shown as a reading on its own.
  let consensus: number | null = null;
  if (speaking.length) {
    let num = 0;
    let den = 0;
    for (const v of speaking) {
      const w = input.weights[v.c] || 0;
      num += (v.pos as number) * w;
      den += w;
    }
    consensus = den > 0 ? num / den : null;
  }

  const inferenceRefusedHere = !spec.inferenceAdmissible;
  const deferenceTriggered =
    !inferenceRefusedHere
    && foundation.position !== null
    && consensus !== null
    && Math.abs(consensus - foundation.position) >= CONTRADICTION_GAP;

  const sources: SourceView[] = SOURCE_CLASSES.map((c) => {
    const signals = byClass.get(c)!;
    const { position, strength } = classPosition(signals);
    const weight = input.weights[c] || 0;

    let effectiveWeight = position === null ? 0 : weight;
    let withheldBecause: string | null = null;

    if (c === INFERRED_CLASS && position !== null) {
      if (inferenceRefusedHere) {
        effectiveWeight = 0;
        withheldBecause =
          'Not admitted on this dimension at any weight. ' + spec.label + ' asks what this person '
          + 'has actually done, and a computation made before anybody watched them work cannot '
          + 'answer that. It is shown here so the refusal is visible rather than silent.';
      } else if (deferenceTriggered) {
        effectiveWeight = 0;
        withheldBecause =
          'Demonstrated evidence contradicts it, so it was set aside for this dimension rather than '
          + 'averaged with what the record shows. Evidence of what somebody did displaces an '
          + 'inference about what they might do.';
      }
    }

    return {
      sourceClass: c,
      label: SOURCE_CLASS_LABELS[c],
      signalCount: signals.length,
      position,
      strength,
      weight,
      effectiveWeight,
      withheldBecause,
      agreement: c === INFERRED_CLASS
        ? (position === null ? 'silent' : 'no_foundation_to_compare')
        : agreementOf(position, foundation.position),
      mostRecentAt: newestOf(signals),
      signals,
    };
  });

  // 5. COMBINE — or refuse to.
  const contributing = sources.filter((v) => v.position !== null && v.effectiveWeight > 0);
  const anyDemonstrated = sources.some((v) => isDemonstrated(v.sourceClass) && v.position !== null);

  let status: ReadingStatus;
  let reading: number | null = null;

  if (!accepted.length) {
    status = 'nothing_on_record';
  } else if (!anyDemonstrated) {
    // THE FLOOR. Whatever weight the foundation carries, on its own it produces no number.
    status = 'foundation_only';
  } else {
    let num = 0;
    let den = 0;
    for (const v of contributing) {
      num += (v.position as number) * v.effectiveWeight;
      den += v.effectiveWeight;
    }
    reading = den > 0 ? positionToReading(num / den) : null;
    if (reading === null) {
      status = 'nothing_on_record';
    } else {
      const present = contributing.map((v) => v.sourceClass);
      const complete = completenessPct(input.weights, present);
      const independent = sources.filter((v) => isDemonstrated(v.sourceClass) && v.position !== null).length;
      status = (complete < THIN_COMPLETENESS || independent < MIN_INDEPENDENT_SOURCES)
        ? 'thin_evidence'
        : 'evidenced';
    }
  }

  const confidence = computeConfidence({
    sources,
    previousValue: previous?.confidenceValue ?? null,
    nowMs,
  });

  // 6. EXPLAIN.
  const agreement: string[] = [];
  const contradiction: string[] = [];

  if (foundation.position !== null && !inferenceRefusedHere) {
    const foundationSentence = foundationSignals[0]?.statement || 'The inferred foundation has a position on this dimension.';
    agreement.push('Foundation: ' + foundationSentence);
    for (const v of sources) {
      if (v.sourceClass === INFERRED_CLASS || v.position === null) continue;
      const line = v.label + ': ' + AGREEMENT_LABELS[v.agreement] + '.';
      if (v.agreement === 'contradicts') contradiction.push(line);
      else agreement.push(line);
    }
  } else if (foundation.position !== null && inferenceRefusedHere) {
    agreement.push(
      'An inferred foundation was offered and was not admitted on this dimension. Nothing below rests on it.',
    );
  }

  // Disagreement BETWEEN demonstrated classes, which is a different and more important thing than
  // disagreement with the foundation: it means two records of the same person's work do not match.
  for (let i = 0; i < speaking.length; i++) {
    for (let j = i + 1; j < speaking.length; j++) {
      const a = speaking[i];
      const b = speaking[j];
      const gap = Math.abs((a.pos as number) - (b.pos as number));
      if (gap >= CONTRADICTION_GAP) {
        contradiction.push(
          SOURCE_CLASS_LABELS[a.c] + ' and ' + SOURCE_CLASS_LABELS[b.c] + ' do not agree about this. '
          + 'Both are on record; neither has been set aside. That disagreement is a question to ask, not a finding.',
        );
      }
    }
  }
  if (speaking.length > 1 && !contradiction.length) {
    agreement.push(
      sentenceList(speaking.map((v) => SOURCE_CLASS_LABELS[v.c])) + ' broadly agree with each other.',
    );
  }

  if (deferenceTriggered) {
    contradiction.push(
      'The inferred foundation points one way and the demonstrated record points the other. The '
      + 'record was followed and the foundation was set aside for this dimension.',
    );
  }

  const developmentNeeds = collectDevelopmentNeeds(accepted, inverted);

  const inputs = SOURCE_CLASSES
    .map((c) => {
      const v = sources.find((x) => x.sourceClass === c)!;
      const modules = Array.from(new Set(v.signals.map((s) => s.ownerModule))).join(', ');
      return {
        source: v.label,
        ownerModule: modules || 'not connected',
        rows: v.signalCount,
        sentence: v.signalCount
          ? v.signalCount + ' signal' + (v.signalCount === 1 ? '' : 's') + ' from ' + (modules || 'an unnamed module') + '.'
          : 'Nothing was offered by this kind of evidence. That is an absence in the record, not a finding about the person.',
      };
    });

  const processing: string[] = [];
  processing.push(
    'Every signal was screened first. ' + refused.length + ' were refused'
    + (refused.length ? ': ' + refused.map((r) => r.because).join(' ') : '.'),
  );
  processing.push(
    'Each kind of evidence was reduced to one position by weighting its signals by how substantial each one is.',
  );
  if (inferenceRefusedHere) {
    processing.push('The inferred foundation is not admitted on this dimension and contributed nothing.');
  } else if (deferenceTriggered) {
    processing.push('The inferred foundation was set aside because the demonstrated record contradicts it.');
  } else if (foundation.position !== null) {
    processing.push(
      'The inferred foundation was admitted at weight ' + (input.weights[INFERRED_CLASS] || 0)
      + ' of 100 and was compared against what the record shows.',
    );
  }
  if (status === 'foundation_only') {
    processing.push(
      'Nothing demonstrated was on record, so no reading was produced. An inference on its own does '
      + 'not become a number about a person.',
    );
  } else if (reading !== null) {
    processing.push(
      'What was left was combined by weight into one reading, and the share of the weighting that '
      + 'could be looked at at all is reported beside it.',
    );
  }

  const evidence = accepted.map((s) => ({
    what: s.statement,
    ownerModule: s.ownerModule,
    url: s.evidenceUrl,
    locator: s.locator,
    at: s.observedAt,
  }));

  const sentence = readingSentence({ spec, status, reading, confidence, inverted });

  const explanation: Explanation = {
    inputs,
    processing,
    output: sentence,
    evidence,
    confidence,
    computedAt,
  };

  const change = changeSentence({ reading, previous, inverted });

  return brandReading({
    dimension: input.dimension,
    label: spec.label,
    question: spec.question,
    inverted,
    status,
    reading,
    sentence,
    sources,
    agreement,
    contradiction,
    explanation,
    change,
    developmentNeeds,
    decisionUse: 'advisory_only',
  });
}

/** Fuse all ten. The list is the closed union, in its declared order, always complete. */
export function fuseProfile(input: {
  signals: readonly Signal[];
  weights: SourceWeights;
  previous?: Partial<Record<FusionDimension, PreviousReading>> | null;
  now: Date;
}): DimensionReading[] {
  const prev = input.previous || {};
  return (['role_alignment', 'current_capability', 'growth_potential', 'learning_capacity',
    'leadership_readiness', 'behavioural_consistency', 'collaboration', 'work_sustainability',
    'development_requirements', 'professional_trajectory'] as FusionDimension[])
    .map((d) => fuseDimension({
      dimension: d,
      signals: input.signals,
      weights: input.weights,
      previous: prev[d] || null,
      now: input.now,
    }));
}

// -------------------------------------------------------------------------------------------------
// SENTENCES — because a number without one is what people act on
// -------------------------------------------------------------------------------------------------

function collectDevelopmentNeeds(accepted: readonly Signal[], inverted: boolean): string[] {
  // On a normal dimension a NEGATIVE signal names something to work on. On the inverted one
  // (development requirements) a POSITIVE signal does, because there high means more is needed.
  const wanted = accepted.filter((s) => (inverted ? s.position > 0.2 : s.position < -0.2));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of wanted.sort((a, b) => (inverted ? b.position - a.position : a.position - b.position))) {
    const t = s.statement.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_DEVELOPMENT_NEEDS) break;
  }
  return out;
}

export function readingSentence(input: {
  spec: DimensionSpec;
  status: ReadingStatus;
  reading: number | null;
  confidence: ConfidenceReport;
  inverted: boolean;
}): string {
  const { spec, status, reading, confidence, inverted } = input;

  if (status === 'nothing_on_record') {
    return 'Nothing on record speaks to ' + spec.label.toLowerCase() + '. That is an empty record, '
      + 'not a low reading — ' + spec.movedBy.charAt(0).toLowerCase() + spec.movedBy.slice(1);
  }
  if (status === 'foundation_only') {
    return 'The only thing on record here is an inferred foundation, so no reading was produced. '
      + 'An inference on its own is a starting hypothesis, and this engine does not turn one into a '
      + 'number about a person. ' + spec.movedBy;
  }
  if (status === 'unreadable') {
    return 'This dimension could not be read. That is a failure to look, not a finding about the person.';
  }
  if (reading === null) {
    return 'No reading could be produced for ' + spec.label.toLowerCase() + '.';
  }

  const direction = inverted
    ? (reading >= 60 ? 'a substantial development need' : reading >= 40 ? 'a moderate development need' : 'little outstanding')
    : (reading >= 60 ? 'well supported' : reading >= 40 ? 'partly supported' : 'thinly supported');

  const thin = status === 'thin_evidence'
    ? ' The evidence behind it is thin, so treat it as a prompt to look rather than a conclusion.'
    : '';

  return spec.label + ' reads ' + reading + ' of 100 — ' + direction + ' by what is on record. '
    + 'Confidence is ' + CONFIDENCE_BAND_LABELS[confidence.band].toLowerCase() + ' and '
    + confidence.direction.replace('_', ' ') + '.' + thin + ' ' + DECISION_SENTENCE;
}

export function changeSentence(input: {
  reading: number | null;
  previous: PreviousReading | null;
  inverted: boolean;
}): DimensionReading['change'] {
  const prev = input.previous;
  if (!prev || prev.reading === null || input.reading === null) {
    return {
      previousReading: prev?.reading ?? null,
      delta: null,
      since: prev?.computedAt ?? null,
      sentence: prev
        ? 'There is no comparable earlier reading for this dimension, so no movement can be shown.'
        : 'This is the first reading on record for this dimension. A trajectory needs more than one point.',
    };
  }
  const delta = input.reading - prev.reading;
  if (delta === 0) {
    return {
      previousReading: prev.reading, delta: 0, since: prev.computedAt,
      sentence: 'Unchanged since the previous reading.',
    };
  }
  const up = delta > 0;
  const meaning = input.inverted
    ? (up ? 'more is outstanding than before' : 'less is outstanding than before')
    : (up ? 'better supported than before' : 'less well supported than before');
  return {
    previousReading: prev.reading,
    delta,
    since: prev.computedAt,
    sentence: (up ? 'Up ' : 'Down ') + Math.abs(delta) + ' since the previous reading — ' + meaning + '. '
      + 'The record moved; that is not the same as the person having changed.',
  };
}
