// src/lib/fusion/weights.ts — HOW MUCH EACH KIND OF EVIDENCE COUNTS, AND THE TWO NUMBERS NOBODY MAY MOVE.
//
// =================================================================================================
// THIS FILE IS WHERE "DEMONSTRATED OUTWEIGHS INFERRED" STOPS BEING A SENTENCE
// =================================================================================================
//
// A weighting is a POLICY ABOUT PEOPLE, not a setting. src/lib/match.ts already says this out loud
// about job matching: moving required capabilities from fifty-five to eighty changes how every
// candidate reads against every job, retrospectively, without appearing on anybody’s record. The
// same is true here with the extra edge that these readings are ABOUT a person rather than about a
// comparison — so the same discipline applies, plus two limits that match.ts does not need:
//
//   INFERRED_CEILING = 15         The inferred foundation may never be worth more than 15 of 100.
//   DEMONSTRATED_MULTIPLE = 4     The four demonstrated classes together must be worth at least
//                                 four times whatever the inferred foundation is worth.
//
// Both are enforced in validateSourceWeights(), which REFUSES rather than clamps. A silently
// clamped policy is a policy nobody knows they did not get; a refusal with the number in it is a
// conversation. This is the same reasoning that makes match.ts refuse an unknown dimension by name
// instead of dropping it.
//
// NEITHER LIMIT IS CONFIGURABLE. They are consts in a source file, not rows in a table, because a
// limit that a holder of the weighting capability can raise is not a limit — it is a default. Moving
// either one is a code change, a review and a decision on the record.
//
// =================================================================================================
// WHAT A HOLDER MAY STILL DECIDE
// =================================================================================================
//
// Everything else. Whether manager evidence counts for more than peer evidence, whether assessments
// dominate, whether the foundation counts for nothing at all (0 is always valid) — those are real
// organisational choices and this file does not have an opinion about them. The authority here is
// over HOW MUCH THE RECORDED CLASSES COUNT, never over WHAT MAY BE COUNTED: the class list is a
// closed union in types.ts and a key outside it is refused by name.
//
// PURE. No database, no imports beyond the contract. Every function here is total and tested.
import {
  SOURCE_CLASSES,
  DEMONSTRATED_CLASSES,
  INFERRED_CLASS,
  SOURCE_CLASS_LABELS,
  type SourceClass,
} from './types';

// -------------------------------------------------------------------------------------------------
// THE TWO LIMITS. Declared above everything that reads them — `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** The inferred foundation may never be worth more than this, out of 100. */
export const INFERRED_CEILING = 15;

/** The demonstrated classes together must be worth at least this many times the inferred foundation. */
export const DEMONSTRATED_MULTIPLE = 4;

/** Weights are whole numbers from 0 to 100. Anything else is refused rather than rounded into range. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 100;

export type SourceWeights = Record<SourceClass, number>;

/**
 * THE BUILT-IN WEIGHTING. Nobody owns it, which is why a stored profile says so out loud and why
 * every screen that renders a reading prints whose weighting produced it.
 *
 * The shape of it: what a person DID, judged by a named human who answers for the judgement, is
 * worth most. A structured assessment is worth nearly as much and is more comparable across people.
 * Colleagues matter and are kept separate from managers rather than pooled, because pooling them is
 * how a manager’s single view quietly becomes "the team’s". The foundation sits at ten — under the
 * ceiling, advisory, and never on its own.
 */
export const DEFAULT_SOURCE_WEIGHTS: SourceWeights = Object.freeze({
  observed_evidence: 32,
  manager_evidence: 26,
  assessment_evidence: 20,
  peer_evidence: 12,
  inferred_foundation: 10,
}) as SourceWeights;

export interface WeightProfile {
  key: string;
  label: string;
  /** Null ONLY for the built-in. A stored profile with no owner is refused at the write. */
  ownerUserId: string | null;
  weights: SourceWeights;
  note: string | null;
  updatedAt: string | null;
  isBuiltInDefault: boolean;
  sentence: string;
}

export const BUILT_IN_PROFILE: WeightProfile = Object.freeze({
  key: 'default',
  label: 'Built-in default weighting',
  ownerUserId: null,
  weights: { ...DEFAULT_SOURCE_WEIGHTS },
  note: null,
  updatedAt: null,
  isBuiltInDefault: true,
  sentence:
    'No stored weighting was found, so the built-in default was used. Nobody owns it. Save a '
    + 'profile so the numbers that decide how people are read have a name attached to them.',
}) as WeightProfile;

// -------------------------------------------------------------------------------------------------
// VALIDATION — THE ENFORCEMENT POINT
// -------------------------------------------------------------------------------------------------

export interface WeightValidation {
  ok: boolean;
  weights: SourceWeights;
  /** Keys that are not source classes. REFUSED, never dropped: a silently ignored key is a silent policy. */
  rejected: string[];
  /** The reason, as a sentence with the offending number in it. Present whenever ok is false. */
  error?: string;
}

const NOT_AN_OBJECT = 'No weighting was given.';

export function demonstratedTotal(w: SourceWeights): number {
  return DEMONSTRATED_CLASSES.reduce((s, c) => s + (w[c] || 0), 0);
}

export function weightTotal(w: SourceWeights): number {
  return SOURCE_CLASSES.reduce((s, c) => s + (w[c] || 0), 0);
}

/**
 * Validate a source weighting.
 *
 * FOUR REFUSALS, IN ORDER, EACH WITH ITS NUMBER IN THE SENTENCE:
 *   1. a key outside the closed union         — named, so an attempt to add a sixth class fails loudly
 *   2. a weight outside 0..100                — named
 *   3. everything at zero                     — a weighting that weighs nothing produces nothing
 *   4. the inferred foundation over 15, or the demonstrated classes under 4x it
 */
export function validateSourceWeights(input: unknown): WeightValidation {
  const out: SourceWeights = { ...DEFAULT_SOURCE_WEIGHTS };
  const rejected: string[] = [];

  if (!input || typeof input !== 'object') {
    return { ok: false, weights: out, rejected, error: NOT_AN_OBJECT };
  }

  const known = new Set<string>(SOURCE_CLASSES);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(k)) { rejected.push(k); continue; }
    const n = Number(v);
    if (!isFinite(n) || n < WEIGHT_MIN || n > WEIGHT_MAX) {
      return {
        ok: false, weights: out, rejected,
        error: 'Each weight must be a whole number from ' + WEIGHT_MIN + ' to ' + WEIGHT_MAX
          + '. "' + k + '" was ' + String(v) + '.',
      };
    }
    out[k as SourceClass] = Math.round(n);
  }

  if (rejected.length) {
    return {
      ok: false, weights: out, rejected,
      error: 'This engine listens to exactly ' + SOURCE_CLASSES.length + ' named kinds of evidence. '
        + 'These are not among them and were refused rather than stored: ' + rejected.join(', ') + '. '
        + 'Adding a kind of evidence is a code change and a decision on the record, not a setting.',
    };
  }

  const total = weightTotal(out);
  if (total <= 0) {
    return {
      ok: false, weights: out, rejected,
      error: 'Every weight was zero, so nothing would count at all. At least one kind of evidence must carry weight.',
    };
  }

  const inferred = out[INFERRED_CLASS];
  if (inferred > INFERRED_CEILING) {
    return {
      ok: false, weights: out, rejected,
      error: 'The ' + SOURCE_CLASS_LABELS[INFERRED_CLASS].toLowerCase() + ' was set to ' + inferred
        + '. It may never exceed ' + INFERRED_CEILING + '. Demonstrated, job-related evidence has to '
        + 'outweigh what was inferred before anybody watched this person work, and that limit is in '
        + 'the source rather than in this form, so it cannot be raised from a screen.',
    };
  }

  const demonstrated = demonstratedTotal(out);
  if (inferred > 0 && demonstrated < inferred * DEMONSTRATED_MULTIPLE) {
    return {
      ok: false, weights: out, rejected,
      error: 'Demonstrated evidence totals ' + demonstrated + ' and the inferred foundation is '
        + inferred + '. Together the four demonstrated kinds must be worth at least '
        + DEMONSTRATED_MULTIPLE + ' times the foundation — ' + (inferred * DEMONSTRATED_MULTIPLE)
        + ' or more here. Raise what was observed, assessed or written by a named person, or lower the foundation.',
    };
  }

  return { ok: true, weights: out, rejected };
}

/**
 * The sentence a screen prints under a saved weighting. It states the balance in words as well as
 * numbers, because "32 / 26 / 20 / 12 / 10" is not something a person reads as a policy.
 */
export function weightingSentence(w: SourceWeights): string {
  const demonstrated = demonstratedTotal(w);
  const inferred = w[INFERRED_CLASS];
  const parts = SOURCE_CLASSES
    .map((c) => SOURCE_CLASS_LABELS[c] + ' ' + w[c])
    .join(', ');
  if (inferred === 0) {
    return parts + '. The inferred foundation is set to zero, so it contributes nothing to any '
      + 'reading and appears only as context.';
  }
  const times = Math.floor((demonstrated / inferred) * 10) / 10;
  return parts + '. Demonstrated evidence is worth ' + demonstrated + ' against ' + inferred
    + ' for the inferred foundation — ' + times + ' times as much.';
}

/** Round-trip a stored JSON weighting into a usable one, falling back to the default per key. */
export function normaliseWeights(stored: unknown): SourceWeights {
  const v = validateSourceWeights(stored);
  // An invalid STORED weighting is not a reason to refuse to render a person's profile — it is a
  // reason to fall back to the default and say so, which is what the caller does with `ok`.
  return v.ok ? v.weights : { ...DEFAULT_SOURCE_WEIGHTS };
}

/**
 * How much of the whole weighting a set of present classes accounts for, 0-100.
 *
 * WHY IT IS REPORTED SEPARATELY FROM THE READING. If only the foundation and one colleague spoke,
 * the arithmetic still produces a number, and that number looks exactly like one built from four
 * kinds of evidence. Completeness is what tells them apart, and it is why no reading in this engine
 * is ever shown without it.
 */
export function completenessPct(w: SourceWeights, present: readonly SourceClass[]): number {
  const total = weightTotal(w);
  if (total <= 0) return 0;
  const have = present.reduce((s, c) => s + (w[c] || 0), 0);
  return Math.round((have / total) * 100);
}
