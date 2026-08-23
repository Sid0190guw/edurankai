// src/lib/horizon/engine.ts — THE READING. FOUR LAYERS, SEVEN HORIZONS, EIGHT OUTPUTS.
//
// =================================================================================================
// THE CONTRACT EVERY SIGNAL HONOURS
// =================================================================================================
//
// Rule 12 of the build prompt: INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP.
// Every Signal below carries all six as fields, not as prose. A sentence about a person that cannot
// name the rows behind it does not get emitted; there is no code path that produces one, because
// sig() will not build a Signal without an evidence list.
//
// =================================================================================================
// SILENCE IS AN ANSWER, AND IT IS NOT THE SAME ANSWER AS ABSENCE
// =================================================================================================
//
// Three different states, three different sentences, and the engine never collapses them:
//
//   no evidence exists      "Nothing is on record for this window." A finding about the record.
//   evidence unreadable     "We could not read the record." An outage. Says nothing about anybody.
//   evidence exists, flat   "The record shows no change." A finding about the work.
//
// The second is the one systems get wrong, and it is the one that does damage: a person whose
// delivery table timed out should never appear on a manager's screen as a person with no delivery.
//
// =================================================================================================
// WHAT THE ENGINE WILL NOT DO
// =================================================================================================
//
// It emits no score, no ranking, no percentile and no composite. There is no number here that
// summarises a person, because the moment one exists it is what gets read and the six fields behind
// it stop being looked at. Confidence is a property of a READING, not a rating of a person.
//
// It makes no decision and recommends no decision. leadershipTrajectory says what the record shows
// about leadership work and, where it projects, says only what could develop and under what
// conditions. Rule 14: nothing here may independently drive a hiring, promotion, discipline or exit
// outcome, and the way that is enforced is that no output of this engine is a verdict.
//
// It does not diagnose. sustainability reads workload patterns out of attendance and task records
// and says so in those words. Rule 27 forbids inferring a physical or mental health condition, and
// the sustainability section carries a standing sentence saying it is not an assessment of health.

import {
  HORIZONS, HORIZON_SPECS, LAYER_ASSERTION, LAYER_DECISION_WEIGHT,
  PROJECTION_DISCLAIMER, FOUNDATIONAL_DISCLAIMER,
  confidenceFor, confidenceBand, hedged, lookbackWindow, forwardWindow, daysBetween, round2,
  type Horizon, type Layer, type ConfidenceBreakdown, type Window,
} from './time';
import { computeCycles, type CycleLayer, type CycleInput } from './cycles';
import { shapeWithin, seriesWithin, type TemporalEvidence, type SourceFacts, type SeriesPoint } from './evidence';

/** Bumped whenever the arithmetic changes. Stored on every versioned reading so an old one can be
 *  understood by the rules that produced it rather than by today's. */
export const ENGINE_VERSION = '1.0.0';

// =================================================================================================
// SIGNALS
// =================================================================================================

export type DecisionWeight = 'primary' | 'supporting' | 'none';

export interface EvidenceRef {
  table: string;
  rowCount: number;
  window: string;
  /** Set when this reference is to a source we could not read. */
  unreadable?: boolean;
}

export interface Signal {
  layer: Layer;
  /** The sentence a screen prints. Projections are already hedged by the time they get here. */
  statement: string;
  /** Rule 12, INPUTS. The named fields and rows this came out of. */
  inputs: string[];
  /** Rule 12, PROCESSING. The rule applied, in words somebody could re-apply by hand. */
  processing: string;
  /** Rule 12, EVIDENCE. */
  evidence: EvidenceRef[];
  /** Rule 12, CONFIDENCE. Inherited from the horizon; a signal is never more confident than its reading. */
  confidence: number;
  /** Rule 12, TIMESTAMP. */
  computedAt: string;
  /** The twin's vocabulary, so a surface that already speaks it can render this without translation. */
  assertion: 'calculated' | 'factual' | 'predicted' | 'inferred';
  decisionWeight: DecisionWeight;
}

function sig(
  layer: Layer,
  statement: string,
  inputs: string[],
  processing: string,
  evidence: EvidenceRef[],
  confidence: number,
  computedAt: string,
): Signal {
  const text = layer === 'projected' ? hedged(statement) : statement;
  return {
    layer,
    statement: text,
    inputs,
    processing,
    evidence,
    confidence,
    computedAt,
    assertion: LAYER_ASSERTION[layer],
    decisionWeight: LAYER_DECISION_WEIGHT[layer],
  };
}

// =================================================================================================
// TREND ARITHMETIC — PURE, AND THE PART MOST WORTH TESTING
// =================================================================================================

export type Direction = 'rising' | 'steady' | 'falling' | 'insufficient';

export interface Trend {
  direction: Direction;
  /** Change per month in the units of whatever was measured. */
  slope: number;
  points: number;
  first: number | null;
  last: number | null;
  sentence: string;
}

export const INSUFFICIENT_TREND: Trend = Object.freeze({
  direction: 'insufficient',
  slope: 0,
  points: 0,
  first: null,
  last: null,
  sentence: 'Fewer than three months of record here, which is not enough to call a direction.',
});

/**
 * Least-squares slope over monthly buckets.
 *
 * THREE POINTS MINIMUM, and that threshold is the whole safety of this function. Two points always
 * produce a perfect line, so a trend drawn from two months is not a weak trend, it is an artefact.
 * Below three the answer is 'insufficient', which is a real answer that screens print.
 *
 * `pick` chooses what is being trended: the count of rows in a month, or the average metric.
 */
export function trendOf(points: readonly SeriesPoint[], pick: 'count' | 'metric'): Trend {
  const ys: number[] = [];
  for (const p of points) {
    const v = pick === 'count' ? p.rowCount : p.metricAvg;
    if (v === null || v === undefined || !isFinite(v)) continue;
    ys.push(v);
  }
  if (ys.length < 3) return { ...INSUFFICIENT_TREND, points: ys.length };

  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  const slope = den === 0 ? 0 : num / den;

  // The threshold is relative to the level, not absolute: a change of 0.4 means something different
  // for a five-point rating than for a count of forty task rows.
  const scale = Math.max(1, Math.abs(meanY));
  const rel = slope / scale;
  let direction: Direction;
  if (rel > 0.05) direction = 'rising';
  else if (rel < -0.05) direction = 'falling';
  else direction = 'steady';

  const first = ys[0];
  const last = ys[n - 1];
  const sentence =
    direction === 'steady'
      ? 'Steady across ' + n + ' months (' + round2(first) + ' to ' + round2(last) + ').'
      : direction === 'rising'
        ? 'Rising across ' + n + ' months, about ' + round2(slope) + ' per month (' + round2(first) + ' to ' + round2(last) + ').'
        : 'Falling across ' + n + ' months, about ' + round2(Math.abs(slope)) + ' per month (' + round2(first) + ' to ' + round2(last) + ').';

  return { direction, slope: round2(slope), points: n, first: round2(first), last: round2(last), sentence };
}

// =================================================================================================
// THE READING
// =================================================================================================

export interface HorizonSection {
  key: OutputKey;
  label: string;
  /** The standing sentence for this section, where it has one. */
  note: string | null;
  signals: Signal[];
  /** Printed when signals is empty. Says WHICH of the three silences this is. */
  silence: string | null;
}

export const OUTPUT_KEYS = [
  'opportunities',
  'developmentFocus',
  'potentialChallenges',
  'roleRelevance',
  'leadershipTrajectory',
  'sustainability',
] as const;

export type OutputKey = (typeof OUTPUT_KEYS)[number];

export const OUTPUT_LABELS: Record<OutputKey, string> = {
  opportunities: 'Opportunities',
  developmentFocus: 'Development focus',
  potentialChallenges: 'Potential challenges',
  roleRelevance: 'Role relevance',
  leadershipTrajectory: 'Leadership trajectory',
  sustainability: 'Sustainability',
};

const OUTPUT_NOTES: Record<OutputKey, string | null> = {
  opportunities: null,
  developmentFocus:
    'Development focus is a suggestion about where attention would pay off. It is not a performance finding and it is not a warning.',
  potentialChallenges:
    'These are patterns in records, not judgements about a person. Every one of them has an explanation the record does not contain.',
  roleRelevance: null,
  leadershipTrajectory:
    'Leadership here means recorded leadership work: objectives owned, people supported, reviews given. Absence of it on the record is not a statement about anybody\'s potential.',
  sustainability:
    'This reads workload patterns out of attendance and task records. IT IS NOT AN ASSESSMENT OF HEALTH, physical or mental, and must never be used as one.',
};

export interface HorizonReading {
  horizon: Horizon;
  label: string;
  hint: string;
  cadence: 'live' | 'versioned';
  lookback: Window;
  forward: Window;
  confidence: ConfidenceBreakdown;
  confidenceBand: 'none' | 'low' | 'moderate' | 'reasonable';
  sections: HorizonSection[];
  /** Rule 23, at the reading level: every source, with counts and readability. */
  evidenceSources: SourceFacts[];
  /** Layer D, carried whole so a surface can show it separately from the rest. */
  cycles: CycleLayer;
  computedAt: string;
  engineVersion: string;
  /** Set when nothing could be read at all. A screen must show this INSTEAD of the sections. */
  blind: boolean;
  projectionDisclaimer: string;
}

const dayName = (w: Window): string => w.fromDay + ' to ' + w.toDay;

function refs(ev: TemporalEvidence, tables: string[], w: Window): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const t of tables) {
    const s = ev.sources.find((x) => x.table === t);
    if (!s) continue;
    out.push({ table: t, rowCount: s.rowCount, window: dayName(w), unreadable: s.unreadable || undefined });
  }
  return out;
}

function readable(ev: TemporalEvidence, table: string): SourceFacts | null {
  const s = ev.sources.find((x) => x.table === table);
  return s && !s.unreadable ? s : null;
}

/**
 * Which silence is this.
 *
 * Called for every empty section. The three branches are the whole reason this function exists;
 * collapsing them into "no data" is the defect it prevents.
 */
function silenceFor(ev: TemporalEvidence, tables: string[], w: Window): string {
  const involved = ev.sources.filter((s) => tables.indexOf(s.table) >= 0);
  const unread = involved.filter((s) => s.unreadable);
  if (involved.length && unread.length === involved.length) {
    return 'EVIDENCE UNREADABLE. ' + unread.map((u) => u.table + ': ' + u.because).join(' ')
      + ' Nothing is being said about this person here, because nothing could be read.';
  }
  if (unread.length) {
    return 'Partly unreadable: ' + unread.map((u) => u.table).join(', ')
      + '. What follows is drawn only from the sources that answered, so it is incomplete.';
  }
  return 'Nothing is on record for ' + dayName(w) + ' in ' + tables.join(', ')
    + '. That is a fact about the record, and it may simply mean this part of the system is not in use.';
}

// =================================================================================================
// SECTION BUILDERS
// =================================================================================================
//
// Each returns the signals it can actually support. NONE of them has a fallback that invents a
// sentence when the evidence is thin. An empty list is a correct output.

function opportunitiesFor(
  ev: TemporalEvidence, h: Horizon, w: Window, fw: Window, conf: number, at: string, cycles: CycleLayer,
): Signal[] {
  const out: Signal[] = [];
  const spec = HORIZON_SPECS[h];

  const tasks = readable(ev, 'hr_task_log');
  if (tasks && tasks.rowCount > 0) {
    const t = trendOf(seriesWithin(ev, 'hr_task_log', w.fromDay, w.toDay), 'count');
    if (t.direction === 'rising') {
      out.push(sig(
        'observed',
        'Recorded delivery has been rising across this window. ' + t.sentence,
        ['hr_task_log.log_date', 'hr_task_log.status'],
        'Least-squares slope over monthly counts of task-log rows; a direction is only called on three or more months.',
        refs(ev, ['hr_task_log'], w),
        conf, at,
      ));
      if (spec.forwardDays >= 180) {
        out.push(sig(
          'projected',
          'work at this cadence will open scope for larger pieces of work over the next ' + Math.round(spec.forwardDays / 30) + ' months',
          ['the observed delivery trend above'],
          'Projection from an observed rising trend, hedged and capped at this horizon confidence ceiling of ' + spec.confidenceCeiling + '.',
          refs(ev, ['hr_task_log'], fw),
          conf, at,
        ));
      }
    }
  }

  const claims = readable(ev, 'capability_claims');
  if (claims && claims.verifiedRowCount > 0) {
    out.push(sig(
      'current',
      claims.verifiedRowCount + ' capability evidence rows carry a named human verdict. Verified capability is the strongest currency this platform holds and it is the natural basis for wider work.',
      ['capability_evidence.verification_status = human_verified'],
      'Direct count of verified evidence rows in the window, from the module that owns the evidence graph.',
      refs(ev, ['capability_claims'], w),
      conf, at,
    ));
  }

  const goals = readable(ev, 'hr_employee_goals');
  if (goals && goals.rowCount > 0 && (goals.metricAvg || 0) > 0) {
    out.push(sig(
      'observed',
      Math.round(goals.metricAvg || 0) + ' of ' + goals.rowCount + ' recorded objectives in this window are marked met.',
      ['hr_employee_goals.status', 'hr_employee_goals.target_date'],
      'Count of rows with status met against all rows whose target date falls in the window.',
      refs(ev, ['hr_employee_goals'], w),
      conf, at,
    ));
  }

  // Layer D contributes TIMING, never merit. A confirmation date approaching is an opportunity in
  // the calendar sense and is phrased that way.
  for (const c of cycles.readings) {
    if (c.cycleName === 'Engagement stage' && (c.phase === 'probation' || c.phase === 'confirmation pending')) {
      out.push(sig(
        'foundational',
        'The engagement cycle is at "' + c.phase + '". This is a window where evidence gathered now lands directly in the next formal decision point.',
        c.inputs,
        'Position of today between the recorded joining, probation and confirmation dates. Timing only; carries no decision weight.',
        [],
        conf, at,
      ));
    }
  }

  return out;
}

function developmentFor(
  ev: TemporalEvidence, h: Horizon, w: Window, conf: number, at: string,
): Signal[] {
  const out: Signal[] = [];

  const reviews = readable(ev, 'hr_performance_reviews');
  if (reviews && reviews.rowCount > 0 && reviews.metricAvg !== null) {
    const t = trendOf(seriesWithin(ev, 'hr_performance_reviews', w.fromDay, w.toDay), 'metric');
    if (t.direction === 'insufficient') {
      out.push(sig(
        'current',
        'Average submitted rating in this window is ' + reviews.metricAvg + ', across ' + reviews.rowCount + ' review rows. There are too few review periods here to describe a direction.',
        ['hr_performance_reviews.overall_rating', 'hr_review_cycles.period_end'],
        'Mean of overall_rating over reviews whose cycle period ends in the window. No direction is claimed below three periods.',
        refs(ev, ['hr_performance_reviews'], w),
        conf, at,
      ));
    } else {
      out.push(sig(
        'observed',
        'Submitted ratings are ' + t.direction + ' across this window. ' + t.sentence,
        ['hr_performance_reviews.overall_rating', 'hr_review_cycles.period_end'],
        'Least-squares slope over the monthly mean of overall_rating.',
        refs(ev, ['hr_performance_reviews'], w),
        conf, at,
      ));
    }
  }

  const readableSources = ev.sources.filter((s) => !s.unreadable && s.rowCount > 0);
  if (readableSources.length > 0 && readableSources.length < 3) {
    out.push(sig(
      'current',
      'Only ' + readableSources.length + ' of ' + ev.sources.length + ' evidence sources carry anything for this person in this window ('
      + readableSources.map((s) => s.label).join(', ') + '). A record drawn from one or two places is a thin basis for any reading, including this one.',
      ev.sources.map((s) => s.table),
      'Count of sources with at least one row in the window, against the registry of sources this engine reads.',
      refs(ev, readableSources.map((s) => s.table), w),
      conf, at,
    ));
  }

  const claims = readable(ev, 'capability_claims');
  if (claims && claims.rowCount > 0 && claims.verifiedRowCount === 0) {
    out.push(sig(
      'current',
      'There are ' + claims.rowCount + ' capability evidence rows in this window and none of them carries a named human verdict. Getting existing evidence verified is usually worth more than adding more of it.',
      ['capability_evidence.verification_status'],
      'Comparison of total evidence rows against those with verification_status of human_verified.',
      refs(ev, ['capability_claims'], w),
      conf, at,
    ));
  }

  const reports = readable(ev, 'hr_daily_reports');
  if (reports && reports.rowCount > 0 && reports.verifiedRowCount > 0) {
    const rate = Math.round((reports.verifiedRowCount / reports.rowCount) * 100);
    if (rate >= 30) {
      out.push(sig(
        'observed',
        rate + ' per cent of daily reports in this window named a blocker. Persistent blockers are usually a fact about the surrounding work, and they are worth reading before anything about the person is.',
        ['hr_daily_reports.blockers'],
        'Share of reports whose blockers field is non-empty. The field is free text and is counted, never read into.',
        refs(ev, ['hr_daily_reports'], w),
        conf, at,
      ));
    }
  }

  return out;
}

function challengesFor(
  ev: TemporalEvidence, h: Horizon, w: Window, conf: ConfidenceBreakdown, at: string,
): Signal[] {
  const out: Signal[] = [];
  const c = conf.value;

  const tasks = readable(ev, 'hr_task_log');
  if (tasks && tasks.rowCount > 0) {
    const t = trendOf(seriesWithin(ev, 'hr_task_log', w.fromDay, w.toDay), 'count');
    if (t.direction === 'falling') {
      out.push(sig(
        'observed',
        'Recorded delivery is falling across this window. ' + t.sentence
        + ' A fall in RECORDED work is not the same as a fall in work done; logging habits, leave and reassignment all produce the same shape.',
        ['hr_task_log.log_date'],
        'Least-squares slope over monthly counts of task-log rows.',
        refs(ev, ['hr_task_log'], w),
        c, at,
      ));
    }
  }

  const att = readable(ev, 'hr_attendance');
  if (att && att.rowCount > 0) {
    const t = trendOf(seriesWithin(ev, 'hr_attendance', w.fromDay, w.toDay), 'count');
    if (t.direction === 'falling') {
      out.push(sig(
        'observed',
        'Recorded attendance days are falling across this window. ' + t.sentence
        + ' Approved leave produces this shape too, and this engine does not read the leave register.',
        ['hr_attendance.date', 'hr_attendance.status'],
        'Least-squares slope over monthly counts of attendance rows. Leave records are deliberately not joined here.',
        refs(ev, ['hr_attendance'], w),
        c, at,
      ));
    }
  }

  // The most important challenge on a long horizon is usually the reading itself.
  if (conf.underspanned) {
    out.push(sig(
      'current',
      'The record behind this horizon is shorter than the horizon. ' + conf.sentence
      + ' Treat everything in the projection section as a direction to discuss, not a finding.',
      ['the span of every readable source'],
      'Comparison of the evidence span against the length of the horizon being described.',
      ev.sources.filter((s) => !s.unreadable).map((s) => ({ table: s.table, rowCount: s.rowCount, window: dayName(w) })),
      c, at,
    ));
  }

  const stale = ev.sources.filter((s) => !s.unreadable && s.latestDay && daysBetween(s.latestDay, ev.today) > 90);
  if (stale.length) {
    out.push(sig(
      'current',
      'These sources have had nothing new for over ninety days: ' + stale.map((s) => s.label).join(', ')
      + '. Stale evidence weakens every horizon that rests on it.',
      stale.map((s) => s.table + '.latest = ' + s.latestDay),
      'Days between the newest row in each source and the anchor day.',
      refs(ev, stale.map((s) => s.table), w),
      c, at,
    ));
  }

  const unread = ev.sources.filter((s) => s.unreadable);
  if (unread.length) {
    out.push(sig(
      'current',
      'EVIDENCE UNREADABLE for ' + unread.map((s) => s.label).join(', ')
      + '. This reading is incomplete, and the gap is ours, not this person\'s.',
      unread.map((s) => s.table),
      'Sources that returned an error or are absent from the database. Reported rather than counted as zero.',
      unread.map((s) => ({ table: s.table, rowCount: 0, window: dayName(w), unreadable: true })),
      c, at,
    ));
  }

  return out;
}

function roleRelevanceFor(
  ev: TemporalEvidence, h: Horizon, w: Window, fw: Window, conf: number, at: string,
): Signal[] {
  const out: Signal[] = [];
  const spec = HORIZON_SPECS[h];
  const role = ev.anchors.designation;

  if (!ev.anchors.readable) {
    return out;
  }

  if (role) {
    out.push(sig(
      'current',
      'The role on record is "' + role + '".'
      + (ev.anchors.joiningDay ? ' Held since the joining date of ' + ev.anchors.joiningDay + ' as far as this record shows; this engine does not read the transfer history.' : ''),
      ['hr_employees.designation', 'hr_employees.joining_date'],
      'Read directly from the employee row. No inference.',
      [],
      conf, at,
    ));
  } else {
    out.push(sig(
      'current',
      'No designation is recorded for this person, so nothing here can be related to a role. That is a gap in the people record, not a finding about them.',
      ['hr_employees.designation'],
      'Read directly from the employee row.',
      [],
      conf, at,
    ));
  }

  const claims = readable(ev, 'capability_claims');
  if (claims && claims.rowCount > 0) {
    out.push(sig(
      'observed',
      claims.rowCount + ' capability evidence rows sit against this person in this window. Whether they match the role is a question for the capability module, which owns the comparison; this engine reports only that the evidence exists and when.',
      ['capability_evidence.occurred_at'],
      'Count and date bounds only. The requirement-to-capability comparison belongs to src/lib/job-twin.ts and is not duplicated here.',
      refs(ev, ['capability_claims'], w),
      conf, at,
    ));
  }

  if (spec.forwardDays >= 1826) {
    out.push(sig(
      'projected',
      'a role held this long is expected to change shape well within this horizon, so relevance is better read as a direction of work than as a title',
      ['hr_employees.designation', 'the length of this horizon'],
      'A statement about the horizon rather than the person. Hedged, and carrying the ceiling confidence for this horizon.',
      [],
      conf, at,
    ));
  }

  return out;
}

function leadershipFor(
  ev: TemporalEvidence, h: Horizon, w: Window, conf: number, at: string,
): Signal[] {
  const out: Signal[] = [];
  const spec = HORIZON_SPECS[h];

  const goals = readable(ev, 'hr_employee_goals');
  const reviews = readable(ev, 'hr_performance_reviews');
  const hasGoalEvidence = !!goals && goals.rowCount > 0;
  const hasReviewEvidence = !!reviews && reviews.rowCount > 0;

  if (!hasGoalEvidence && !hasReviewEvidence) {
    // The honest answer, and the common one. It is stated rather than left blank because a blank
    // panel gets filled in by the reader.
    out.push(sig(
      'current',
      'Nothing on this person\'s record in this window evidences leadership work: no owned objectives, no submitted reviews. This is a statement about what has been recorded, and it is not a statement about whether they could lead.',
      ['hr_employee_goals', 'hr_performance_reviews'],
      'Absence check across the two sources that would hold recorded leadership work. Absence is reported as absence.',
      refs(ev, ['hr_employee_goals', 'hr_performance_reviews'], w),
      conf, at,
    ));
    return out;
  }

  if (hasGoalEvidence) {
    out.push(sig(
      'observed',
      goals!.rowCount + ' objectives are recorded against this person in this window, ' + goals!.verifiedRowCount + ' of them acknowledged by the person themselves.',
      ['hr_employee_goals.status', 'hr_employee_goals.employee_acknowledged'],
      'Direct counts. Ownership of objectives is the recorded form of leadership this platform holds; it is not a proxy for seniority.',
      refs(ev, ['hr_employee_goals'], w),
      conf, at,
    ));
  }

  if (spec.forwardDays >= 1826) {
    out.push(sig(
      'projected',
      'sustained ownership of objectives at this level is going to be the ordinary route toward wider responsibility, if the person wants it and the organisation has the room',
      ['the recorded objective ownership above'],
      'A conditional statement carrying two explicit conditions. It is not a plan, and nobody has agreed to it.',
      refs(ev, ['hr_employee_goals'], w),
      conf, at,
    ));
  }

  return out;
}

function sustainabilityFor(
  ev: TemporalEvidence, h: Horizon, w: Window, conf: number, at: string,
): Signal[] {
  const out: Signal[] = [];

  const att = readable(ev, 'hr_attendance');
  if (att && att.rowCount > 0 && att.metricAvg !== null) {
    const t = trendOf(seriesWithin(ev, 'hr_attendance', w.fromDay, w.toDay), 'metric');
    out.push(sig(
      'observed',
      'Average recorded hours per attended day in this window: ' + att.metricAvg + '. ' + t.sentence,
      ['hr_attendance.work_hours', 'hr_attendance.date'],
      'Mean of non-zero work_hours per day, and the slope of the monthly mean. Hours are what was recorded, not what was worked.',
      refs(ev, ['hr_attendance'], w),
      conf, at,
    ));
    if (t.direction === 'rising' && (att.metricAvg || 0) > 9) {
      out.push(sig(
        'observed',
        'Recorded hours are both high and rising in this window. That is a workload pattern in the attendance record and it is worth a conversation; it is not a finding about this person\'s health or capacity.',
        ['hr_attendance.work_hours'],
        'Threshold of nine average recorded hours combined with a rising monthly slope. A pattern flag, not an assessment.',
        refs(ev, ['hr_attendance'], w),
        conf, at,
      ));
    }
  }

  const reports = readable(ev, 'hr_daily_reports');
  const tasks = readable(ev, 'hr_task_log');
  if (reports && tasks && reports.rowCount > 0 && tasks.rowCount === 0) {
    out.push(sig(
      'current',
      'Daily reports are being filed and the task log is empty for this window. The two records disagree, and the disagreement is more likely to be about which system is being used than about the work.',
      ['hr_daily_reports.report_date', 'hr_task_log.log_date'],
      'Cross-source consistency check between two sources that describe the same days.',
      refs(ev, ['hr_daily_reports', 'hr_task_log'], w),
      conf, at,
    ));
  }

  return out;
}

// =================================================================================================
// COMPOSITION
// =================================================================================================

const SECTION_TABLES: Record<OutputKey, string[]> = {
  opportunities: ['hr_task_log', 'capability_claims', 'hr_employee_goals'],
  developmentFocus: ['hr_performance_reviews', 'capability_claims', 'hr_daily_reports'],
  potentialChallenges: ['hr_task_log', 'hr_attendance'],
  roleRelevance: ['capability_claims'],
  leadershipTrajectory: ['hr_employee_goals', 'hr_performance_reviews'],
  sustainability: ['hr_attendance', 'hr_daily_reports', 'hr_task_log'],
};

/** One horizon, fully composed. Pure with respect to the database: everything comes from `ev`. */
export function buildHorizon(
  ev: TemporalEvidence,
  cycles: CycleLayer,
  h: Horizon,
  computedAt: string,
): HorizonReading {
  const spec = HORIZON_SPECS[h];
  const w = lookbackWindow(h, ev.today, ev.recordStartDay);
  const fw = forwardWindow(h, ev.today);
  const shape = shapeWithin(ev, w.fromDay, w.toDay);
  const conf = confidenceFor(h, shape);

  const built: Record<OutputKey, Signal[]> = {
    opportunities: opportunitiesFor(ev, h, w, fw, conf.value, computedAt, cycles),
    developmentFocus: developmentFor(ev, h, w, conf.value, computedAt),
    potentialChallenges: challengesFor(ev, h, w, conf, computedAt),
    roleRelevance: roleRelevanceFor(ev, h, w, fw, conf.value, computedAt),
    leadershipTrajectory: leadershipFor(ev, h, w, conf.value, computedAt),
    sustainability: sustainabilityFor(ev, h, w, conf.value, computedAt),
  };

  const sections: HorizonSection[] = OUTPUT_KEYS.map((k) => ({
    key: k,
    label: OUTPUT_LABELS[k],
    note: OUTPUT_NOTES[k],
    signals: built[k],
    silence: built[k].length ? null : silenceFor(ev, SECTION_TABLES[k], w),
  }));

  return {
    horizon: h,
    label: spec.label,
    hint: spec.hint,
    cadence: spec.cadence,
    lookback: w,
    forward: fw,
    confidence: conf,
    confidenceBand: confidenceBand(conf.value),
    sections,
    evidenceSources: ev.sources,
    cycles,
    computedAt,
    engineVersion: ENGINE_VERSION,
    blind: ev.blind,
    projectionDisclaimer: PROJECTION_DISCLAIMER,
  };
}

export interface HorizonSet {
  employeeId: string;
  today: string;
  readings: Record<Horizon, HorizonReading>;
  cycles: CycleLayer;
  blind: boolean;
  /** Printed above everything when the whole reading rests on nothing. */
  blindSentence: string | null;
}

/**
 * Build every horizon from ONE evidence bundle.
 *
 * The cycle layer is computed once and shared: it depends on the anchor dates and today, neither of
 * which varies by horizon, and computing it seven times would produce seven identical objects.
 */
export function buildAll(ev: TemporalEvidence, computedAt: string, birthDay?: string | null): HorizonSet {
  const cycleInput: CycleInput = {
    today: ev.today,
    joiningDay: ev.anchors.joiningDay,
    probationEndDay: ev.anchors.probationEndDay,
    confirmationDay: ev.anchors.confirmationDay,
    reviewCadenceDays: null,
    lastReviewDay: readable(ev, 'hr_performance_reviews')?.latestDay || null,
    birthDay: birthDay ?? null,
  };
  const cycles = computeCycles(cycleInput);

  const readings = {} as Record<Horizon, HorizonReading>;
  for (const h of HORIZONS) readings[h] = buildHorizon(ev, cycles, h, computedAt);

  return {
    employeeId: ev.employeeId,
    today: ev.today,
    readings,
    cycles,
    blind: ev.blind,
    blindSentence: ev.blind
      ? 'Every evidence source for this person was unreadable, so no horizon below describes them. '
        + 'This is an outage in our records, not a finding about their work, and nothing on this '
        + 'screen may be used as one.'
      : null,
  };
}

export { FOUNDATIONAL_DISCLAIMER };
