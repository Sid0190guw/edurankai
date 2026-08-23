// src/lib/behaviour/trend.ts — PATCH 04: baseline, direction, and blip-versus-direction.
//
// PURE. This is the layer where the system says something that could be WRONG, so every function
// here is written to make being wrong visible rather than unlikely: the baseline is named, the
// threshold that produced the verdict is carried on the result, and both sides of the comparison
// bring their rows.
//
// =================================================================================================
// THE THREE THINGS THAT WOULD MAKE THIS DISHONEST, AND WHAT STOPS EACH
// =================================================================================================
//
//   1. AN UNNAMED BASELINE. "Improving" against nothing in particular cannot be argued with, and
//      everything in this patch has to be arguable by the person it describes. `Baseline` carries
//      its kind, its interval, its `n` and a sentence, and a trend with `kind: 'none'` is always
//      'insufficient_evidence' regardless of how different the two numbers look.
//
//   2. NOISE REPORTED AS MOVEMENT. Two numbers computed from small samples are almost never equal.
//      Without a threshold every metric would show a direction every period, and a screen that
//      always has an arrow on it teaches its readers that the arrows mean nothing.
//      MIN_RELATIVE_CHANGE is that threshold, it is stated on the result, and inside it the answer
//      is 'stable' — a finding, not a shrug.
//
//   3. ONE BAD FORTNIGHT READ AS A DECLINE. This is the one that does real damage to people. Two
//      numbers can only ever say "different"; they cannot say "and it has been different every week
//      since July". The sub-period series is what separates those, and where it cannot, the answer
//      is 'undetermined' rather than the more useful-sounding guess.
import type {
  BehaviourMetricKey,
  BehaviourTrend,
  Baseline,
  EvidenceRef,
  MetricValue,
  PatternVerdict,
  ResolvedWindow,
  TrendVerdict,
} from './types';
import { METRIC_META, EVIDENCE_CAP, round2 } from './metrics';
import { assessConfidence } from './confidence';

/**
 * A movement smaller than this is noise.
 *
 * Fifteen per cent: below that, on the sample sizes a task board produces for one person over a
 * fortnight, the difference between two values is routinely explained by which side of a window
 * boundary a single task fell on. It is deliberately generous — this module would rather miss a real
 * small change than put a false one on somebody's record.
 */
export const MIN_RELATIVE_CHANGE = 0.15;

/** Sub-periods that must carry data before a blip can be told from a direction. */
export const MIN_COVERED_SUBPERIODS = 3;

/** One sub-period's value, with the interval it covered. */
export interface SubPeriodValue {
  fromIso: string;
  toIso: string;
  value: MetricValue;
}

export interface TrendInput {
  key: BehaviourMetricKey;
  resolved: ResolvedWindow;
  /** The metric over the window under review. */
  current: MetricValue;
  /** The metric over the comparison period. Null when there was no period to compute one over. */
  baselineMetric: MetricValue | null;
  baselineKind: Baseline['kind'];
  baselineFromIso: string | null;
  baselineToIso: string | null;
  /** The window cut into buckets, each with its own value. Empty is allowed; it yields 'undetermined'. */
  subPeriods: SubPeriodValue[];
  /** Days since the most recent contributing record, for confidence. */
  staleDays: number | null;
  sourcesRead: number;
  sourcesExpected: number;
  unreadable: boolean;
}

function baselineOf(input: TrendInput): Baseline {
  const m = input.baselineMetric;
  const usable = m !== null && !m.insufficient && m.value !== null;

  if (!usable) {
    const why =
      input.baselineKind === 'none'
        ? 'There is no earlier period on record to compare against.'
        : m === null
          ? 'No comparison period could be built inside this person’s employment.'
          : `The comparison period held ${m.n} record${m.n === 1 ? '' : 's'}, below what this metric needs.`;
    return {
      kind: 'none',
      value: null,
      n: m?.n ?? 0,
      fromIso: input.baselineFromIso,
      toIso: input.baselineToIso,
      toleranceRelative: MIN_RELATIVE_CHANGE,
      statement: why,
    };
  }

  const label =
    input.baselineKind === 'employment_history'
      ? 'everything on record for this person'
      : `the ${input.resolved.days} day${input.resolved.days === 1 ? '' : 's'} immediately before this period`;

  return {
    kind: input.baselineKind,
    value: m.value,
    n: m.n,
    fromIso: input.baselineFromIso,
    toIso: input.baselineToIso,
    toleranceRelative: MIN_RELATIVE_CHANGE,
    statement:
      `Compared against ${label}: ${m.value} over ${m.n} record${m.n === 1 ? '' : 's'}` +
      (input.baselineFromIso ? ` (${input.baselineFromIso} to ${input.baselineToIso}).` : '.') +
      ` A difference within ${Math.round(MIN_RELATIVE_CHANGE * 100)}% of that is treated as unchanged.`,
  };
}

/**
 * Which way a movement reads, given what the metric considers better.
 *
 * A 'neutral' metric never returns improving or declining. There is no defensible way for this
 * module to decide that a person taking longer over an assessment is worse — that is exactly the
 * judgement the human is there to make.
 */
function verdictFor(key: BehaviourMetricKey, delta: number): TrendVerdict {
  const better = METRIC_META[key].betterWhen;
  if (better === 'neutral') return 'changed_without_direction';
  if (delta === 0) return 'stable';
  const up = delta > 0;
  if (better === 'higher') return up ? 'improving' : 'declining';
  return up ? 'declining' : 'improving';
}

/**
 * BLIP OR DIRECTION.
 *
 * `deviating` is the set of sub-periods that moved the SAME WAY as the overall movement and by more
 * than the tolerance. Same way matters: a window whose average moved because of one enormous
 * outlier in the opposite direction is not a pattern, and counting any deviation would call it one.
 *
 * The rules, in the order they are applied:
 *
 *   fewer than MIN_COVERED_SUBPERIODS buckets held data      -> undetermined
 *   no bucket deviated                                       -> undetermined (the window average
 *                                                               moved but no part of it did; that is
 *                                                               bucketing, not behaviour)
 *   the most recent bucket deviates, in a run of 2 or more   -> sustained_pattern
 *   the most recent bucket does NOT deviate                  -> temporary_anomaly (it moved and came
 *                                                               back, whatever it did in between)
 *   the most recent bucket deviates, alone                   -> undetermined (this is either the
 *                                                               start of something or a bad week,
 *                                                               and saying which would be a guess)
 */
export function assessPattern(
  subPeriods: SubPeriodValue[],
  baselineValue: number | null,
  overallDelta: number,
): { pattern: PatternVerdict; covered: number; examined: number; note: string } {
  const examined = subPeriods.length;
  const covered = subPeriods.filter((s) => !s.value.insufficient && s.value.value !== null);

  if (baselineValue === null || covered.length < MIN_COVERED_SUBPERIODS) {
    return {
      pattern: 'undetermined',
      covered: covered.length,
      examined,
      note: `Records fell in ${covered.length} of ${examined} sub-periods, too few to tell a one-off from a direction.`,
    };
  }

  const tolerance = Math.abs(baselineValue) * MIN_RELATIVE_CHANGE;
  const sign = Math.sign(overallDelta);
  const flags = covered.map((s) => {
    const d = (s.value.value as number) - baselineValue;
    return Math.sign(d) === sign && Math.abs(d) > tolerance;
  });

  const deviatingCount = flags.filter(Boolean).length;
  if (deviatingCount === 0) {
    return {
      pattern: 'undetermined',
      covered: covered.length,
      examined,
      note: 'The period average moved but no individual sub-period did, which points at how the period was cut rather than at a change in working.',
    };
  }

  let longestRun = 0;
  let run = 0;
  for (const f of flags) {
    run = f ? run + 1 : 0;
    if (run > longestRun) longestRun = run;
  }

  const lastDeviates = flags[flags.length - 1] === true;

  if (lastDeviates && longestRun >= 2) {
    return {
      pattern: 'sustained_pattern',
      covered: covered.length,
      examined,
      note: `Present in ${deviatingCount} of ${covered.length} sub-periods with records, including a run of ${longestRun} ending in the most recent.`,
    };
  }

  if (!lastDeviates) {
    return {
      pattern: 'temporary_anomaly',
      covered: covered.length,
      examined,
      note: `Confined to ${deviatingCount} of ${covered.length} sub-periods, and the most recent is back within the usual range.`,
    };
  }

  return {
    pattern: 'undetermined',
    covered: covered.length,
    examined,
    note: 'Only the most recent sub-period differs. That is either the start of something or an ordinary bad week, and this cannot tell which yet.',
  };
}

/** Plain words for a verdict, used in the sentence a screen prints. */
const VERDICT_WORDS: Record<TrendVerdict, string> = {
  improving: 'moved in the better direction',
  declining: 'moved in the worse direction',
  stable: 'did not change materially',
  changed_without_direction: 'changed, in a direction this system does not judge as better or worse',
  insufficient_evidence: 'could not be assessed',
};

const PATTERN_WORDS: Record<PatternVerdict, string> = {
  temporary_anomaly: 'It looks like a temporary movement rather than a direction.',
  sustained_pattern: 'It has held across consecutive sub-periods.',
  undetermined: 'Whether this is a one-off or a direction is undetermined.',
};

/**
 * ASSESS ONE METRIC'S MOVEMENT. The single entry point; nothing else in this patch builds a trend.
 */
export function assessTrend(input: TrendInput): BehaviourTrend {
  const meta = METRIC_META[input.key];
  const baseline = baselineOf(input);
  const current = input.current;

  const evidence: EvidenceRef[] = [
    ...current.evidence,
    ...(input.baselineMetric?.evidence || []),
  ].slice(0, EVIDENCE_CAP);
  const evidenceCount = current.evidenceCount + (input.baselineMetric?.evidenceCount || 0);

  // ---- the two ways there is nothing to say -------------------------------------------------
  if (current.insufficient || current.value === null || baseline.kind === 'none' || baseline.value === null) {
    const confidence = assessConfidence({
      sampleSize: current.n,
      sourcesRead: input.sourcesRead,
      sourcesExpected: input.sourcesExpected,
      unreadable: input.unreadable,
      staleDays: input.staleDays,
    });
    const missing =
      current.insufficient || current.value === null
        ? `${meta.label} could not be assessed for this period: ${current.n} record${current.n === 1 ? '' : 's'}, and it needs at least ${meta.minSample}.`
        : `${meta.label} has a value for this period but nothing to compare it against. ${baseline.statement}`;
    return {
      key: input.key,
      window: input.resolved.window,
      verdict: 'insufficient_evidence',
      pattern: 'undetermined',
      current: current.value,
      baseline,
      delta: null,
      relativeChange: null,
      confidence,
      statement: `${missing} This is unknown, not a finding.`,
      evidence,
      evidenceCount,
    };
  }

  // ---- movement -----------------------------------------------------------------------------
  const delta = current.value - baseline.value;
  const relativeChange = baseline.value === 0 ? null : delta / Math.abs(baseline.value);

  // A zero baseline is a real state, not a missing one — nobody was late at all last month. The
  // relative test is undefined there, so any non-zero movement counts, and `relativeChange` stays
  // null so no consumer divides by it.
  const withinTolerance =
    relativeChange === null ? delta === 0 : Math.abs(relativeChange) <= MIN_RELATIVE_CHANGE;

  const verdict: TrendVerdict = withinTolerance ? 'stable' : verdictFor(input.key, delta);

  const patternResult = withinTolerance
    ? {
        pattern: 'undetermined' as PatternVerdict,
        covered: input.subPeriods.filter((s) => !s.value.insufficient).length,
        examined: input.subPeriods.length,
        note: 'No material movement to characterise.',
      }
    : assessPattern(input.subPeriods, baseline.value, delta);

  const confidence = assessConfidence({
    sampleSize: current.n + baseline.n,
    sourcesRead: input.sourcesRead,
    sourcesExpected: input.sourcesExpected,
    unreadable: input.unreadable,
    staleDays: input.staleDays,
    periodsCovered: patternResult.covered,
    periodsExamined: patternResult.examined,
  });

  const pct = relativeChange === null ? null : Math.round(Math.abs(relativeChange) * 100);
  const movement =
    pct === null
      ? `from ${baseline.value} to ${current.value}`
      : `from ${baseline.value} to ${current.value}, a change of ${pct}%`;

  const statement =
    `${meta.label} ${VERDICT_WORDS[verdict]} over ${input.resolved.statement}: ${movement} ` +
    `(${meta.unit}). ${baseline.statement} ` +
    (withinTolerance ? '' : `${PATTERN_WORDS[patternResult.pattern]} ${patternResult.note} `) +
    `Based on ${current.n} record${current.n === 1 ? '' : 's'} in the period and ${baseline.n} before it. ` +
    'This describes recorded events, not the person, and decides nothing.';

  return {
    key: input.key,
    window: input.resolved.window,
    verdict,
    pattern: patternResult.pattern,
    current: current.value,
    baseline,
    delta: round2(delta),
    relativeChange: relativeChange === null ? null : round2(relativeChange),
    confidence,
    statement,
    evidence,
    evidenceCount,
  };
}
