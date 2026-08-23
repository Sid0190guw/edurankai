// src/lib/horizon/feedback/aggregate.ts — TURNING A PILE OF OPINIONS INTO A NUMBER THAT ARGUES BACK.
//
// =================================================================================================
// PURE. NO DATABASE, NO CLOCK OF ITS OWN, NO IO.
// =================================================================================================
//
// Everything below is a function of its arguments. `asOf` is passed in rather than read from
// Date.now(), which is what makes recency decay testable and what makes two renders of the same
// screen in the same request agree. read.ts does the IO; this file does the reasoning.
//
// =================================================================================================
// THE ONE REQUIREMENT THAT SHAPED EVERY DECISION HERE
// =================================================================================================
//
// "Do not allow one negative feedback item to determine the profile."
//
// That is not a warning label, it is a structural property, and one mechanism cannot deliver it.
// Four do, and they are independent so that defeating one does not defeat the result:
//
//   1. BELOW TWO INDEPENDENT AUTHORS THERE IS NO SCORE AT ALL. Not a provisional score, not a score
//      with a warning: `score` is null and the band is 'insufficient'. One person's opinion is one
//      person's opinion and this module refuses to launder it into a measurement. (Rule: one
//      person's feedback must never automatically become organisational truth.)
//   2. AUTHOR SATURATION CAP. No single author may hold more than MAX_AUTHOR_SHARE of the weight on
//      a dimension, however many items they write. Ten notes from one manager are still one voice.
//   3. SOURCE-TYPE SATURATION CAP. No single KIND of source may hold more than
//      MAX_SOURCE_TYPE_SHARE. Five peers from one clique cannot outvote the rest of the evidence.
//   4. OUTLIER DAMPING, NOT OUTLIER DELETION. An item far from the median has its weight halved and
//      is FLAGGED. It is never dropped: deleting dissent is how a system launders itself into
//      agreement, and the single most interesting item on a page is often the one everybody else
//      disagrees with.
//
// And with exactly two authors the band is capped at 'low' whatever the arithmetic says, because two
// people agreeing is two people agreeing.
//
// =================================================================================================
// WHY MEDIAN AND MAD, NOT MEAN AND STANDARD DEVIATION, FOR OUTLIERS
// =================================================================================================
//
// A mean is dragged by the outlier it is being used to detect, and a standard deviation is dragged
// further because the deviation is squared. Ratings 4,4,4,4,1 have mean 3.4 and sd 1.2, so the 1 sits
// 2.0 sd out and survives a 2-sigma test; the median is 4 and the MAD is 0, which sees it instantly.
// Detection uses median + MAD. The SCORE is still a weighted mean, because a median throws away the
// difference between 4 and 5 and there is real information in it.
//
// =================================================================================================
// WHAT THIS FILE DOES NOT DO
// =================================================================================================
//
// It does not decide anything. It produces no recommendation, no ranking, no band that maps to an
// employment action, and no threshold anybody may automate against. It does not diagnose: no output
// here describes a person's health, character or disposition — every dimension is a rating of
// OBSERVED WORK, and the flags are readings of the DATA, not of the person.
import {
  FEEDBACK_DIMENSIONS,
  FEEDBACK_DIMENSION_META,
  FEEDBACK_SOURCE_LABELS,
  FEEDBACK_DECISION_NOTICE,
  type ConfidenceBand,
  type Contribution,
  type DimensionAggregate,
  type DisagreementKind,
  type EvidenceQuality,
  type Explanation,
  type FeedbackDimension,
  type FeedbackItem,
  type FeedbackSignal,
  type FeedbackSignalFlag,
  type FeedbackSourceType,
} from './types';

// =================================================================================================
// THE CONSTANTS. Every one of them is a JUDGEMENT, so every one of them is named, exported and
// explained — a magic number inside a weighting formula is a policy nobody voted on.
// =================================================================================================

/** The contract version consuming patches pin against. Bump the minor for additive fields only. */
export const FEEDBACK_CONTRACT_VERSION = '1.0.0';

/**
 * BASE WEIGHT BY SOURCE, on observational proximity to the work — never on rank.
 *
 * SELF IS 0 AND THAT IS DELIBERATE. Self-reflection is required by the brief and is captured in
 * full, but folding it into the aggregate would mean the number partly measures how somebody rates
 * themselves. It is reported BESIDE the aggregate as a gap, which is the useful thing anyway: the
 * distance between how a person sees their work and how the people around them see it is a
 * conversation, and an average of the two is nothing.
 */
export const SOURCE_BASE_WEIGHT: Record<FeedbackSourceType, number> = {
  reporting_manager: 1.0,
  team_lead: 1.0,
  hr: 0.6,
  peer: 0.9,
  self: 0,
};

/**
 * EVIDENCE MULTIPLIER. The largest single lever in the model, and it should be: a rating with
 * nothing written behind it is an assertion, and a rating that names what happened is an
 * observation. Demonstrated evidence must weigh more than an impression.
 */
export const EVIDENCE_WEIGHT: Record<EvidenceQuality, number> = {
  specific: 1.0,
  general: 0.6,
  none: 0.3,
};

/**
 * RECENCY. Half-life of nine months, floored at RECENCY_FLOOR so old feedback fades but never
 * disappears — a pattern across three years is exactly what a feedback history is for, and a decay
 * that reaches zero deletes it silently.
 */
export const RECENCY_HALF_LIFE_DAYS = 270;
export const RECENCY_FLOOR = 0.25;

/** Below this many DISTINCT authors, a dimension gets no score at all. See mechanism 1 above. */
export const MIN_SOURCES_FOR_SCORE = 2;

/** With exactly this many authors, the band cannot rise above 'low' however good the arithmetic. */
export const TWO_SOURCE_BAND_CEILING: ConfidenceBand = 'low';

/** Mechanism 2. One human, at most this share of a dimension's weight. */
export const MAX_AUTHOR_SHARE = 0.4;

/** Mechanism 3. One KIND of source, at most this share. */
export const MAX_SOURCE_TYPE_SHARE = 0.6;

/**
 * Repeat items from the same author on the same dimension get 1/sqrt(k) for the k-th. Diminishing,
 * because the second observation from somebody who already told you is worth less than the first —
 * but not collapsing, because a manager who has said the same thing in four quarters is evidence of
 * a pattern and 1/k would nearly erase it. The saturation cap is what bounds the total.
 */
export function repetitionFactor(k: number): number {
  return 1 / Math.sqrt(Math.max(1, k));
}

/** Mechanism 4. An outlier keeps this fraction of its weight. It is never zero. */
export const OUTLIER_WEIGHT_FACTOR = 0.5;

/** How many scaled MADs from the median before an item is called an outlier. */
export const OUTLIER_MAD_K = 3.0;
/** 1/Phi^-1(3/4). Turns a MAD into a standard-deviation-comparable scale for a normal sample. */
export const MAD_SCALE = 1.4826;
/** When the MAD is 0 (everybody agreed exactly), this fixed band is used instead. */
export const OUTLIER_FLAT_BAND = 1.5;

/** Disagreement: this much spread between the highest and lowest rating, with at least 3 raters. */
export const DISAGREEMENT_SPREAD = 2.0;
export const DISAGREEMENT_MIN_RATERS = 3;
/** Two source KINDS whose means differ by this much is a structural disagreement, and outranks. */
export const CROSS_SOURCE_GAP = 1.5;

/** Requirement 9: this many unsupported extreme items from one author about one person. */
export const UNSUPPORTED_REPEAT_THRESHOLD = 3;
/** What an author's weight is multiplied by once that pattern is raised. Never zero: still visible. */
export const UNSUPPORTED_AUTHOR_FACTOR = 0.4;
/** An "extreme" rating for the purposes of the above: at or below, or at or above. */
export const EXTREME_LOW = 2;
export const EXTREME_HIGH = 5;

/** How far an author's mean must sit from everyone else's before their tendency is worth naming. */
export const AUTHOR_TENDENCY_GAP = 1.0;
/** ...over at least this many dimensions, so one disagreement is not called a tendency. */
export const AUTHOR_TENDENCY_MIN_DIMENSIONS = 3;

/** Below this many scored dimensions there is no overall figure. */
export const MIN_DIMENSIONS_FOR_OVERALL = 3;

/** Nothing newer than this many days on record, and the evidence is called stale. */
export const STALE_EVIDENCE_DAYS = 365;

/** Ratings live on 1..5, so the largest possible standard deviation is 2.0. Consensus scales by it. */
export const MAX_POSSIBLE_SD = 2.0;

// =================================================================================================
// SMALL PURE HELPERS
// =================================================================================================

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation. Robust: the outlier does not move it. */
function mad(xs: number[]): number {
  if (!xs.length) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

function weightedMean(pairs: { w: number; v: number }[]): number {
  const tw = pairs.reduce((a, p) => a + p.w, 0);
  if (tw <= 0) return 0;
  return pairs.reduce((a, p) => a + p.w * p.v, 0) / tw;
}

function weightedSd(pairs: { w: number; v: number }[]): number {
  const tw = pairs.reduce((a, p) => a + p.w, 0);
  if (tw <= 0) return 0;
  const m = weightedMean(pairs);
  const variance = pairs.reduce((a, p) => a + p.w * (p.v - m) * (p.v - m), 0) / tw;
  return Math.sqrt(Math.max(0, variance));
}

function ageDays(createdAt: string, asOf: Date): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (asOf.getTime() - t) / 86400000);
}

/** Exponential decay to a floor. Exported so a screen can print the factor beside the item. */
export function recencyFactor(createdAt: string, asOf: Date): number {
  const d = ageDays(createdAt, asOf);
  const raw = Math.pow(0.5, d / RECENCY_HALF_LIFE_DAYS);
  return clamp(Math.max(raw, RECENCY_FLOOR), RECENCY_FLOOR, 1);
}

/**
 * WATER-FILLING SHARE CAP. Scale down whichever groups exceed `maxShare` until none does.
 *
 * Done as a loop rather than a single division because capping one group shrinks the denominator,
 * which can push a second group over the line that was under it a moment ago. It converges — every
 * pass strictly reduces total weight while the number of groups is finite — and the pass limit is a
 * backstop against a floating-point tie, not a correctness compromise: on exit the invariant is
 * re-checked by the caller's own arithmetic, since the weights it returns are the weights used.
 */
function capGroupShares(
  weights: number[],
  groupOf: (i: number) => string,
  maxShare: number,
): { weights: number[]; capped: string[] } {
  const out = [...weights];
  const capped = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const total = out.reduce((a, w) => a + w, 0);
    if (total <= 0) break;
    const byGroup = new Map<string, number>();
    for (let i = 0; i < out.length; i++) {
      const g = groupOf(i);
      byGroup.set(g, (byGroup.get(g) || 0) + out[i]);
    }
    let worstGroup = '';
    let worstShare = 0;
    for (const [g, w] of byGroup) {
      const share = w / total;
      if (share > worstShare) {
        worstShare = share;
        worstGroup = g;
      }
    }
    // A single group is always 100% of the weight and there is nothing to cap it against. That case
    // is caught upstream by MIN_SOURCES_FOR_SCORE, which refuses to score at all.
    if (byGroup.size < 2 || worstShare <= maxShare + 1e-9) break;
    const groupTotal = byGroup.get(worstGroup) || 0;
    const rest = total - groupTotal;
    // Solve target/(target + rest) = maxShare  ->  target = maxShare*rest/(1-maxShare)
    const target = (maxShare * rest) / (1 - maxShare);
    const scale = groupTotal > 0 ? target / groupTotal : 0;
    for (let i = 0; i < out.length; i++) if (groupOf(i) === worstGroup) out[i] *= scale;
    capped.add(worstGroup);
  }
  return { weights: out, capped: Array.from(capped) };
}

// =================================================================================================
// EVIDENCE QUALITY — computed at CAPTURE, stored, and never recomputed on read.
// =================================================================================================

/**
 * Classify how well an item is evidenced.
 *
 * DELIBERATELY CRUDE, AND CRUDE IN ONE DIRECTION. It rewards the presence of a cited example and of
 * length; it does not attempt to judge whether prose is insightful, because a heuristic that scored
 * writing quality would quietly weight articulate people above observant ones.
 *
 * Exported and pure so the capture form can show the author what their item will count as BEFORE
 * they submit it. Telling somebody "this will count for a third of what it could" while they can
 * still do something about it is the entire point.
 */
export function classifyEvidence(evidence: string, exampleCount: number): EvidenceQuality {
  const text = String(evidence || '').trim();
  if (exampleCount > 0 && text.length >= 20) return 'specific';
  if (!text) return 'none';
  // A date, a number, or a quantity in the prose is the cheapest reliable signal that somebody is
  // describing an event rather than a feeling.
  const hasConcreteMarker = /\d/.test(text);
  if (text.length >= 160 && hasConcreteMarker) return 'specific';
  if (text.length >= 40) return 'general';
  return 'none';
}

// =================================================================================================
// ONE DIMENSION
// =================================================================================================

interface DimInput {
  item: FeedbackItem;
  rating: number;
}

/**
 * Aggregate ONE dimension.
 *
 * `unsupportedAuthors` is computed once across the whole subject (see aggregateFeedback) and passed
 * in, because "this author repeatedly rates this person at the extremes with nothing written" is a
 * statement about their whole body of feedback, not about one dimension of it.
 */
export function aggregateDimension(
  dimension: FeedbackDimension,
  items: FeedbackItem[],
  asOf: Date,
  unsupportedAuthors: Set<string> = new Set(),
): DimensionAggregate {
  const meta = FEEDBACK_DIMENSION_META[dimension];
  const computedAt = asOf.toISOString();

  // Only submitted items count. Drafts are not yet said and withdrawn items were unsaid.
  const live = items.filter((i) => i.status === 'submitted');

  const rated: DimInput[] = [];
  let selfRating: number | null = null;
  for (const item of live) {
    const r = item.ratings.find((x) => x.dimension === dimension);
    if (!r) continue; // no row means not observed. It is never a zero and never a 3.
    if (item.sourceType === 'self') {
      // The most recent self-rating wins; older ones stay on the history but do not stack.
      if (selfRating === null) selfRating = r.rating;
      continue;
    }
    rated.push({ item, rating: r.rating });
  }

  // Newest first, so repetitionFactor's k counts the k-th most recent from that author — the oldest
  // repeat is the one damped hardest, which is the right way round.
  rated.sort((a, b) => Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt));

  const authorKeys = new Set(rated.map((r) => r.item.authorKey));
  const sourceTypes = Array.from(new Set(rated.map((r) => r.item.sourceType)));

  const empty = (why: string): DimensionAggregate => ({
    dimension,
    label: meta.label,
    score: null,
    band: 'insufficient',
    confidence: 0,
    sourceCount: authorKeys.size,
    itemCount: rated.length,
    sourceTypes,
    consensusIndex: 0,
    spread: 0,
    disagreement: 'none',
    disagreementNote: null,
    outlierCount: 0,
    contributions: [],
    selfRating,
    selfGap: null,
    selfGapLabel: selfRating === null ? 'no_self_rating' : 'aligned',
    explanation: {
      inputs: [
        rated.length + ' rating' + (rated.length === 1 ? '' : 's') + ' from '
          + authorKeys.size + ' independent source' + (authorKeys.size === 1 ? '' : 's'),
        selfRating === null ? 'no self-reflection on this dimension' : 'a self-reflection rating, held separate',
      ],
      processing: [why],
      output: 'No score. ' + meta.label + ' is left blank rather than estimated.',
      evidence: rated.map((r) => r.item.id),
      confidence: 'insufficient — ' + why,
      computedAt,
    },
  });

  if (rated.length === 0) return empty('Nobody rated this dimension, so there is nothing to average.');
  if (authorKeys.size < MIN_SOURCES_FOR_SCORE) {
    return empty(
      'Only ' + authorKeys.size + ' person has rated this. Below ' + MIN_SOURCES_FOR_SCORE
      + ' independent sources this module produces no score, so that one item cannot become the record.',
    );
  }

  // --- OUTLIERS, on the raw ratings so weighting cannot hide one ---------------------------------
  const raw = rated.map((r) => r.rating);
  const med = median(raw);
  const scaledMad = mad(raw) * MAD_SCALE;
  const band = scaledMad > 0 ? OUTLIER_MAD_K * scaledMad : OUTLIER_FLAT_BAND;
  const isOutlier = rated.map((r) => rated.length >= 4 && Math.abs(r.rating - med) > band);

  // --- WEIGHTS, step by step, each step recorded ------------------------------------------------
  const seenByAuthor = new Map<string, number>();
  const steps: { factor: string; value: number; reason: string }[][] = [];
  let weights = rated.map((r, i) => {
    const item = r.item;
    const s: { factor: string; value: number; reason: string }[] = [];

    const base = SOURCE_BASE_WEIGHT[item.sourceType] ?? 0;
    s.push({
      factor: 'source',
      value: base,
      reason: FEEDBACK_SOURCE_LABELS[item.sourceType] + ' — weighted on how much of the work this '
        + 'kind of source actually sees, not on seniority.',
    });

    const ev = EVIDENCE_WEIGHT[item.evidenceQuality] ?? EVIDENCE_WEIGHT.none;
    s.push({
      factor: 'evidence',
      value: ev,
      reason: item.evidenceQuality === 'specific'
        ? 'Names something that happened.'
        : item.evidenceQuality === 'general'
          ? 'Written, but nothing anybody could go and check.'
          : 'A rating with nothing written behind it, so it counts for least.',
    });

    const rec = recencyFactor(item.createdAt, asOf);
    s.push({
      factor: 'recency',
      value: round2(rec),
      reason: 'Halves every ' + RECENCY_HALF_LIFE_DAYS + ' days, and never falls below '
        + RECENCY_FLOOR + ' so history keeps counting.',
    });

    const k = (seenByAuthor.get(item.authorKey) || 0) + 1;
    seenByAuthor.set(item.authorKey, k);
    const rep = repetitionFactor(k);
    if (k > 1) {
      s.push({
        factor: 'repeat',
        value: round2(rep),
        reason: 'The ' + k + 'th item from this author on this dimension. Repeats count for less; '
          + 'the same person saying it again is not a second person saying it.',
      });
    }

    let unsupported = 1;
    if (unsupportedAuthors.has(item.authorKey)) {
      unsupported = UNSUPPORTED_AUTHOR_FACTOR;
      s.push({
        factor: 'unsupported-pattern',
        value: unsupported,
        reason: 'This author has repeatedly rated this person at the extremes with nothing written '
          + 'behind it. Reduced, kept visible, and raised for a human to look at.',
      });
    }

    let outlier = 1;
    if (isOutlier[i]) {
      outlier = OUTLIER_WEIGHT_FACTOR;
      s.push({
        factor: 'outlier',
        value: outlier,
        reason: 'Sits far from what everybody else said. Halved, never removed — the item everybody '
          + 'disagrees with is often the one worth reading.',
      });
    }

    steps.push(s);
    return base * ev * rec * rep * unsupported * outlier;
  });

  // --- SATURATION CAPS ---------------------------------------------------------------------------
  const authorCap = capGroupShares(weights, (i) => rated[i].item.authorKey, MAX_AUTHOR_SHARE);
  weights = authorCap.weights;
  const typeCap = capGroupShares(weights, (i) => rated[i].item.sourceType, MAX_SOURCE_TYPE_SHARE);
  weights = typeCap.weights;

  for (let i = 0; i < rated.length; i++) {
    if (authorCap.capped.indexOf(rated[i].item.authorKey) >= 0) {
      steps[i].push({
        factor: 'author-cap',
        value: MAX_AUTHOR_SHARE,
        reason: 'This author held more than ' + Math.round(MAX_AUTHOR_SHARE * 100) + '% of the weight '
          + 'on this dimension. Scaled back so no single person can be the record.',
      });
    }
    if (typeCap.capped.indexOf(rated[i].item.sourceType) >= 0) {
      steps[i].push({
        factor: 'source-cap',
        value: MAX_SOURCE_TYPE_SHARE,
        reason: 'This kind of source held more than ' + Math.round(MAX_SOURCE_TYPE_SHARE * 100)
          + '% of the weight. Scaled back so one kind of voice cannot outvote the rest.',
      });
    }
  }

  const pairs = rated.map((r, i) => ({ w: weights[i], v: r.rating }));
  const totalW = weights.reduce((a, w) => a + w, 0);
  if (totalW <= 0) {
    return empty('Every contributing item weighted to zero, so no honest average exists.');
  }

  const score = round2(weightedMean(pairs));
  const sd = weightedSd(pairs);
  const consensusIndex = round2(clamp(1 - sd / MAX_POSSIBLE_SD, 0, 1));
  const spread = round2(Math.max(...raw) - Math.min(...raw));

  // --- DISAGREEMENT -------------------------------------------------------------------------------
  const meanByType = new Map<FeedbackSourceType, { sum: number; n: number }>();
  for (const r of rated) {
    const cur = meanByType.get(r.item.sourceType) || { sum: 0, n: 0 };
    cur.sum += r.rating;
    cur.n += 1;
    meanByType.set(r.item.sourceType, cur);
  }
  let disagreement: DisagreementKind = 'none';
  let disagreementNote: string | null = null;
  if (meanByType.size >= 2) {
    let lowT: FeedbackSourceType | null = null;
    let highT: FeedbackSourceType | null = null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [t, agg] of meanByType) {
      const m = agg.sum / agg.n;
      if (m < lo) { lo = m; lowT = t; }
      if (m > hi) { hi = m; highT = t; }
    }
    if (hi - lo >= CROSS_SOURCE_GAP && lowT && highT) {
      disagreement = 'across_sources';
      disagreementNote = FEEDBACK_SOURCE_LABELS[highT] + ' rates this ' + round2(hi)
        + ' and ' + FEEDBACK_SOURCE_LABELS[lowT].toLowerCase() + ' rates it ' + round2(lo)
        + '. Two kinds of source disagreeing by this much usually means they are watching different '
        + 'things, and that is worth asking about before the number is.';
    }
  }
  if (disagreement === 'none' && rated.length >= DISAGREEMENT_MIN_RATERS && spread >= DISAGREEMENT_SPREAD) {
    disagreement = 'within_source';
    disagreementNote = 'Ratings run from ' + Math.min(...raw) + ' to ' + Math.max(...raw)
      + '. The average sits in the middle of a real disagreement rather than describing a settled view.';
  }

  // --- CONFIDENCE ----------------------------------------------------------------------------------
  const coverage = clamp(Math.min(authorKeys.size / 4, 1) * 0.6 + Math.min(sourceTypes.length / 3, 1) * 0.4, 0, 1);
  const evidenceScore = rated.reduce((a, r) => a + (EVIDENCE_WEIGHT[r.item.evidenceQuality] ?? 0.3), 0) / rated.length;
  const recencyScore = rated.reduce((a, r) => a + recencyFactor(r.item.createdAt, asOf), 0) / rated.length;
  let confidence = round2(clamp(0.30 * coverage + 0.25 * evidenceScore + 0.20 * recencyScore + 0.25 * consensusIndex, 0, 1));

  let confBand: ConfidenceBand = confidence >= 0.75 ? 'high' : confidence >= 0.5 ? 'moderate' : 'low';
  if (authorKeys.size === MIN_SOURCES_FOR_SCORE) confBand = TWO_SOURCE_BAND_CEILING;

  // --- SELF GAP -------------------------------------------------------------------------------------
  const selfGap = selfRating === null ? null : round2(selfRating - score);
  const selfGapLabel: DimensionAggregate['selfGapLabel'] =
    selfGap === null ? 'no_self_rating'
      : selfGap >= 0.5 ? 'rates_self_higher'
        : selfGap <= -0.5 ? 'rates_self_lower'
          : 'aligned';

  const contributions: Contribution[] = rated.map((r, i) => ({
    feedbackId: r.item.id,
    authorKey: r.item.authorKey,
    authorName: r.item.authorName,
    sourceType: r.item.sourceType,
    rating: r.rating,
    evidenceQuality: r.item.evidenceQuality,
    createdAt: r.item.createdAt,
    weight: round2(weights[i] / totalW),
    weightSteps: steps[i],
    isOutlier: isOutlier[i],
  }));

  const explanation: Explanation = {
    inputs: [
      rated.length + ' rating' + (rated.length === 1 ? '' : 's') + ' from ' + authorKeys.size
        + ' independent source' + (authorKeys.size === 1 ? '' : 's')
        + ' across ' + sourceTypes.length + ' kind' + (sourceTypes.length === 1 ? '' : 's') + ' of source',
      'Source kinds: ' + sourceTypes.map((t) => FEEDBACK_SOURCE_LABELS[t]).join(', '),
      selfRating === null
        ? 'No self-reflection on this dimension.'
        : 'A self-reflection rating of ' + selfRating + ', held out of the average and compared to it.',
    ],
    processing: [
      'Each item weighted by source kind x evidence quality x recency, then damped for repeats from '
        + 'the same author.',
      'No single author may exceed ' + Math.round(MAX_AUTHOR_SHARE * 100) + '% of the weight and no '
        + 'single kind of source may exceed ' + Math.round(MAX_SOURCE_TYPE_SHARE * 100) + '%.',
      isOutlier.some(Boolean)
        ? isOutlier.filter(Boolean).length + ' item(s) sat far from the median and were halved in '
          + 'weight and flagged. None was removed.'
        : 'No item sat far enough from the median to be treated as an outlier.',
      'Score is a weighted mean; outlier detection used the median and MAD, which an outlier cannot drag.',
    ],
    output: meta.label + ' scores ' + score + ' out of 5 (' + confBand + ' confidence).',
    evidence: rated.map((r) => r.item.id),
    confidence: 'Coverage ' + round2(coverage) + ', evidence ' + round2(evidenceScore)
      + ', recency ' + round2(recencyScore) + ', consensus ' + consensusIndex + ' -> ' + confidence
      + (authorKeys.size === MIN_SOURCES_FOR_SCORE
        ? '. Held at "' + TWO_SOURCE_BAND_CEILING + '" because two people agreeing is two people agreeing.'
        : ''),
    computedAt,
  };

  return {
    dimension,
    label: meta.label,
    score,
    band: confBand,
    confidence,
    sourceCount: authorKeys.size,
    itemCount: rated.length,
    sourceTypes,
    consensusIndex,
    spread,
    disagreement,
    disagreementNote,
    outlierCount: isOutlier.filter(Boolean).length,
    contributions,
    selfRating,
    selfGap,
    selfGapLabel,
    explanation,
  };
}

// =================================================================================================
// REQUIREMENT 9 — REPEATED UNSUPPORTED FEEDBACK
// =================================================================================================

/**
 * Which authors have repeatedly rated this person at an extreme with nothing written behind it.
 *
 * BOTH ENDS COUNT. A colleague who gives nothing but unexplained 5s is doing the same damage to the
 * record as one who gives nothing but unexplained 1s, and a detector that only looked down would
 * quietly license inflation.
 *
 * WHAT THIS IS NOT: a finding about the author. It is a pattern in rows, raised so a human can look.
 * Nothing in this module sanctions anybody, notifies anybody's manager, or writes to the author's
 * own record.
 */
export function detectRepeatedUnsupported(items: FeedbackItem[]): Map<string, string[]> {
  const byAuthor = new Map<string, string[]>();
  for (const item of items) {
    if (item.status !== 'submitted') continue;
    if (item.sourceType === 'self') continue;
    if (item.evidenceQuality !== 'none') continue;
    const extreme = item.ratings.some((r) => r.rating <= EXTREME_LOW || r.rating >= EXTREME_HIGH);
    if (!extreme) continue;
    const list = byAuthor.get(item.authorKey) || [];
    list.push(item.id);
    byAuthor.set(item.authorKey, list);
  }
  const out = new Map<string, string[]>();
  for (const [k, ids] of byAuthor) if (ids.length >= UNSUPPORTED_REPEAT_THRESHOLD) out.set(k, ids);
  return out;
}

/**
 * Requirement 25, the bias half: does one author sit consistently away from everybody else?
 *
 * Computed as the mean, over dimensions this author rated, of (their rating - the median of the
 * OTHER authors' ratings on that dimension). Their own rating is excluded from the comparison
 * median, or an author would partly be compared against themselves.
 *
 * ADVISORY, AND ABOUT THE DATA. "This person rates this colleague a point below everyone else" is a
 * fact about rows. Whether it is bias, higher standards, or the only honest account in the set is a
 * judgement, and this module does not make it.
 */
export function detectAuthorTendency(
  items: FeedbackItem[],
): { authorKey: string; authorName: string; meanDeviation: number; dimensions: number }[] {
  const live = items.filter((i) => i.status === 'submitted' && i.sourceType !== 'self');
  const byDim = new Map<string, { authorKey: string; rating: number }[]>();
  for (const item of live) {
    for (const r of item.ratings) {
      const list = byDim.get(r.dimension) || [];
      list.push({ authorKey: item.authorKey, rating: r.rating });
      byDim.set(r.dimension, list);
    }
  }
  const acc = new Map<string, { name: string; devs: number[] }>();
  for (const item of live) {
    const entry = acc.get(item.authorKey) || { name: item.authorName, devs: [] };
    for (const r of item.ratings) {
      const all = byDim.get(r.dimension) || [];
      const others = all.filter((x) => x.authorKey !== item.authorKey).map((x) => x.rating);
      if (others.length < 2) continue; // one other opinion is not "everybody else"
      entry.devs.push(r.rating - median(others));
    }
    acc.set(item.authorKey, entry);
  }
  const out: { authorKey: string; authorName: string; meanDeviation: number; dimensions: number }[] = [];
  for (const [key, e] of acc) {
    if (e.devs.length < AUTHOR_TENDENCY_MIN_DIMENSIONS) continue;
    const m = e.devs.reduce((a, d) => a + d, 0) / e.devs.length;
    if (Math.abs(m) < AUTHOR_TENDENCY_GAP) continue;
    out.push({ authorKey: key, authorName: e.name, meanDeviation: round2(m), dimensions: e.devs.length });
  }
  return out.sort((a, b) => Math.abs(b.meanDeviation) - Math.abs(a.meanDeviation));
}

// =================================================================================================
// THE WHOLE SIGNAL
// =================================================================================================

/**
 * Aggregate every dimension for one person, and attach the readings.
 *
 * PURE. `asOf` is the clock. Pass the same instant for every subject in a batch, or two people's
 * recency weights are computed against two different "now"s.
 */
export function aggregateFeedback(
  subjectEmployeeId: string,
  items: FeedbackItem[],
  asOf: Date = new Date(),
): FeedbackSignal {
  const computedAt = asOf.toISOString();
  const live = items.filter((i) => i.status === 'submitted');
  const nonSelf = live.filter((i) => i.sourceType !== 'self');

  const unsupported = detectRepeatedUnsupported(live);
  const dimensions = FEEDBACK_DIMENSIONS.map((d) =>
    aggregateDimension(d, items, asOf, new Set(unsupported.keys())),
  ).filter((d) => d.itemCount > 0 || d.selfRating !== null);

  const scored = dimensions.filter((d) => d.score !== null);
  const authorKeys = new Set(nonSelf.map((i) => i.authorKey));

  const sourceTypeCounts: Record<string, number> = {};
  for (const i of live) sourceTypeCounts[i.sourceType] = (sourceTypeCounts[i.sourceType] || 0) + 1;

  // OVERALL. Weighted by each dimension's own confidence, so a well-covered dimension pulls harder
  // than one that scraped past the two-source floor. Null unless enough dimensions could be scored:
  // an "overall" built from two dimensions is a number about two dimensions wearing a bigger name.
  let overall: number | null = null;
  let overallBand: ConfidenceBand = 'insufficient';
  if (scored.length >= MIN_DIMENSIONS_FOR_OVERALL && authorKeys.size >= MIN_SOURCES_FOR_SCORE) {
    const pairs = scored.map((d) => ({ w: Math.max(d.confidence, 0.05), v: d.score as number }));
    overall = round2(weightedMean(pairs));
    const meanConf = scored.reduce((a, d) => a + d.confidence, 0) / scored.length;
    overallBand = meanConf >= 0.75 ? 'high' : meanConf >= 0.5 ? 'moderate' : 'low';
    if (authorKeys.size === MIN_SOURCES_FOR_SCORE) overallBand = TWO_SOURCE_BAND_CEILING;
  }

  // --- FLAGS: category (c). Readings OF the data. -------------------------------------------------
  const flags: FeedbackSignalFlag[] = [];

  if (authorKeys.size < MIN_SOURCES_FOR_SCORE) {
    flags.push({
      kind: 'single_source',
      severity: 'attention',
      summary: authorKeys.size === 0
        ? 'Nobody other than this person has left structured feedback, so there is nothing to aggregate.'
        : 'Only one person has left structured feedback. No score is produced from a single source, '
          + 'and none should be inferred from the items by hand either.',
      evidenceRefs: nonSelf.map((i) => i.id),
    });
  }

  const typeCount = Object.keys(sourceTypeCounts).filter((k) => k !== 'self').length;
  if (authorKeys.size >= MIN_SOURCES_FOR_SCORE && typeCount === 1) {
    const only = Object.keys(sourceTypeCounts).filter((k) => k !== 'self')[0];
    flags.push({
      kind: 'source_type_imbalance',
      severity: 'attention',
      summary: 'Every item comes from one kind of source ('
        + (FEEDBACK_SOURCE_LABELS[only as FeedbackSourceType] || only)
        + '). The picture has one angle in it, whatever the numbers say.',
      evidenceRefs: nonSelf.map((i) => i.id),
    });
  }

  for (const [authorKey, ids] of unsupported) {
    const name = live.find((i) => i.authorKey === authorKey)?.authorName || 'An author';
    flags.push({
      kind: 'repeated_unsupported',
      severity: 'attention',
      summary: name + ' has left ' + ids.length + ' items rating this person at the top or bottom of '
        + 'the scale with nothing written behind them. Their weight is reduced and the items are kept. '
        + 'This is a pattern in the records, not a finding about the author.',
      evidenceRefs: ids,
      aboutAuthorKey: authorKey,
      aboutAuthorName: name,
    });
  }

  for (const t of detectAuthorTendency(live)) {
    flags.push({
      kind: 'author_tendency',
      severity: 'note',
      summary: t.authorName + ' rates this person on average ' + Math.abs(t.meanDeviation)
        + ' point' + (Math.abs(t.meanDeviation) === 1 ? '' : 's') + (t.meanDeviation > 0 ? ' above' : ' below')
        + ' everybody else, across ' + t.dimensions + ' ratings. That may be a different standard, a '
        + 'different view of the work, or the only accurate account in the set — it is a difference, '
        + 'not a verdict.',
      evidenceRefs: live.filter((i) => i.authorKey === t.authorKey).map((i) => i.id),
      aboutAuthorKey: t.authorKey,
      aboutAuthorName: t.authorName,
    });
  }

  const disagreeing = dimensions.filter((d) => d.disagreement !== 'none');
  if (disagreeing.length) {
    flags.push({
      kind: 'disagreement',
      severity: 'attention',
      summary: 'Sources disagree on ' + disagreeing.map((d) => d.label.toLowerCase()).join(', ')
        + '. Read the items before the averages.',
      evidenceRefs: disagreeing.flatMap((d) => d.contributions.map((c) => c.feedbackId)),
    });
  }

  const newest = nonSelf.reduce((a, i) => Math.max(a, Date.parse(i.createdAt) || 0), 0);
  if (nonSelf.length > 0 && newest > 0 && (asOf.getTime() - newest) / 86400000 > STALE_EVIDENCE_DAYS) {
    flags.push({
      kind: 'stale_evidence',
      severity: 'attention',
      summary: 'Nothing has been added for over a year. Every figure here describes a period that '
        + 'has ended, and the weighting has already faded it.',
      evidenceRefs: nonSelf.map((i) => i.id),
    });
  }

  const thin = nonSelf.filter((i) => i.evidenceQuality === 'none');
  if (nonSelf.length > 0 && thin.length / nonSelf.length > 0.5) {
    flags.push({
      kind: 'evidence_thin',
      severity: 'note',
      summary: thin.length + ' of ' + nonSelf.length + ' items have nothing written behind the rating. '
        + 'They still count, at the lowest weight, and the confidence figure already reflects it.',
      evidenceRefs: thin.map((i) => i.id),
    });
  }

  const periods = live.map((i) => i.periodStart).filter(Boolean) as string[];
  const periodEnds = live.map((i) => i.periodEnd).filter(Boolean) as string[];

  const explanation: Explanation = {
    inputs: [
      live.length + ' submitted item' + (live.length === 1 ? '' : 's') + ' about this person',
      authorKeys.size + ' independent source' + (authorKeys.size === 1 ? '' : 's') + ', excluding self-reflection',
      Object.entries(sourceTypeCounts)
        .map(([t, n]) => n + ' x ' + (FEEDBACK_SOURCE_LABELS[t as FeedbackSourceType] || t)).join(', ')
        || 'no items',
      items.length - live.length > 0
        ? (items.length - live.length) + ' draft or withdrawn item(s) excluded from every figure'
        : 'no drafts or withdrawn items',
    ],
    processing: [
      'Each dimension aggregated on its own. A dimension with fewer than ' + MIN_SOURCES_FOR_SCORE
        + ' independent sources gets no score rather than a provisional one.',
      'Self-reflection is never averaged into the score; it is compared to it.',
      overall === null
        ? 'No overall figure: it needs at least ' + MIN_DIMENSIONS_FOR_OVERALL + ' scored dimensions.'
        : 'Overall is the mean of the scored dimensions, weighted by each one\'s own confidence.',
      'Outliers were damped, not deleted. Disagreement is reported rather than averaged away.',
    ],
    output: overall === null
      ? 'No overall figure. ' + scored.length + ' of ' + dimensions.length + ' dimensions could be scored.'
      : 'Overall ' + overall + ' out of 5 across ' + scored.length + ' scored dimensions ('
        + overallBand + ' confidence).',
    evidence: live.map((i) => i.id),
    confidence: overallBand + '. ' + (flags.filter((f) => f.severity === 'attention').length
      ? flags.filter((f) => f.severity === 'attention').length + ' thing(s) need a human eye before this is used.'
      : 'Nothing about the shape of the evidence needs flagging.'),
    computedAt,
  };

  return {
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    subjectEmployeeId,
    overall,
    overallBand,
    dimensions,
    flags,
    itemCount: live.length,
    sourceCount: authorKeys.size,
    sourceTypeCounts,
    periodCoveredFrom: periods.length ? periods.sort()[0] : null,
    periodCoveredTo: periodEnds.length ? periodEnds.sort()[periodEnds.length - 1] : null,
    explanation,
    advisoryOnly: true,
    decisionNotice: FEEDBACK_DECISION_NOTICE,
    computedAt,
  };
}
