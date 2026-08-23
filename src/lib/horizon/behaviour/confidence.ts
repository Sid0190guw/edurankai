// src/lib/behaviour/confidence.ts — PATCH 04: how much weight this conclusion can carry, and why.
//
// PURE. Bands, not percentages, and the reasons are mandatory.
//
// =================================================================================================
// WHY A BAND AND NOT A NUMBER
// =================================================================================================
//
// "Confidence 0.73" invites arithmetic that the inputs cannot support: it gets multiplied by a
// metric, averaged across people, and thresholded at 0.7 by somebody who was not in the room when it
// was defined. Four bands cannot be multiplied by anything, and a reader has to look at the reasons
// to use them at all — which is the point, because the reasons are where the real information is.
//
// EVERY BAND CARRIES REASONS, INCLUDING 'high'. A high band with nothing written beside it is an
// assertion; a high band that says "47 recorded events across three sources, most recent 2 days ago"
// is a claim somebody can check and disagree with.
//
// CONFIDENCE ONLY EVER FALLS. The base band comes from sample size, and every other condition is a
// downgrade. There is no path in this file that raises a band, because "we read three sources
// instead of two" is not a reason to be more sure about eleven rows.
import type { Confidence, ConfidenceBand } from './types';

/** Ordered weakest to strongest. Downgrades walk this array leftwards. */
const BANDS: ConfidenceBand[] = ['none', 'low', 'moderate', 'high'];

/** Sample thresholds. Written here rather than inline so they are arguable in one place. */
export const SAMPLE_LOW = 1;
export const SAMPLE_MODERATE = 5;
export const SAMPLE_HIGH = 15;

/**
 * Records older than this make a conclusion about "how somebody works" a historical statement.
 *
 * Sixty days: two months with nothing recorded is long enough that the working arrangement itself
 * may have changed — a new manager, a different project, a leave period — and the profile would be
 * describing a job the person is no longer doing.
 */
export const STALE_DAYS = 60;

function step(band: ConfidenceBand, down: number): ConfidenceBand {
  const i = BANDS.indexOf(band);
  return BANDS[Math.max(0, i - down)];
}

export interface ConfidenceInput {
  /** Source events the conclusion rests on. */
  sampleSize: number;
  /** How many of the expected source tables returned rows. */
  sourcesRead: number;
  sourcesExpected: number;
  /** A source that could not be read at all. Not the same as one that returned nothing. */
  unreadable: boolean;
  /** Days since the most recent contributing record. Null when there are none. */
  staleDays: number | null;
  /**
   * Sub-periods that carried data, out of the number examined. Optional: metrics have no
   * sub-periods, trends do. A movement seen in one bucket out of six is thin however many rows
   * produced it.
   */
  periodsCovered?: number;
  periodsExamined?: number;
}

/**
 * ASSESS. Base band from sample size, then downgrades, then the reasons that produced both.
 *
 * `unreadable` is the strongest single condition here and it caps rather than steps: if a source
 * failed to read, the profile is missing an unknown quantity of somebody's work, and no sample size
 * from the sources that DID read can compensate for a gap of unknown size.
 */
export function assessConfidence(input: ConfidenceInput): Confidence {
  const reasons: string[] = [];
  const n = Math.max(0, Math.floor(input.sampleSize));

  let band: ConfidenceBand;
  if (n < SAMPLE_LOW) {
    band = 'none';
    reasons.push('No recorded events in this period. Nothing here is a statement about the person.');
  } else if (n < SAMPLE_MODERATE) {
    band = 'low';
    reasons.push(`${n} recorded event${n === 1 ? '' : 's'} — few enough that one unusual task moves the result.`);
  } else if (n < SAMPLE_HIGH) {
    band = 'moderate';
    reasons.push(`${n} recorded events — enough to describe a period, not enough to describe a person.`);
  } else {
    band = 'high';
    reasons.push(`${n} recorded events.`);
  }

  if (input.sourcesExpected > 0) {
    if (input.sourcesRead === 0) {
      band = 'none';
      reasons.push('No source returned any rows.');
    } else if (input.sourcesRead < input.sourcesExpected) {
      band = step(band, 1);
      reasons.push(
        `${input.sourcesRead} of ${input.sourcesExpected} sources returned rows, so part of this person’s recorded work is not represented.`,
      );
    } else {
      reasons.push(`All ${input.sourcesExpected} sources returned rows.`);
    }
  }

  if (input.unreadable) {
    band = step(band, 2);
    if (band === 'high' || band === 'moderate') band = 'low';
    reasons.push(
      'A source could not be read. An unknown amount of recorded work is missing from this, which is not the same as there being none.',
    );
  }

  if (input.staleDays !== null && input.staleDays > STALE_DAYS) {
    band = step(band, 1);
    reasons.push(
      `The most recent contributing record is ${Math.round(input.staleDays)} days old, so this describes a past period rather than current working.`,
    );
  } else if (input.staleDays !== null && n > 0) {
    reasons.push(`Most recent contributing record: ${Math.round(input.staleDays)} day${Math.round(input.staleDays) === 1 ? '' : 's'} ago.`);
  }

  if (typeof input.periodsCovered === 'number' && typeof input.periodsExamined === 'number') {
    if (input.periodsExamined > 0 && input.periodsCovered <= 1) {
      band = step(band, 1);
      reasons.push(
        `Records fell in ${input.periodsCovered} of the ${input.periodsExamined} sub-periods examined, so a one-off cannot be told apart from a direction.`,
      );
    } else if (input.periodsExamined > 0) {
      reasons.push(`Records present in ${input.periodsCovered} of ${input.periodsExamined} sub-periods.`);
    }
  }

  return {
    band,
    reasons,
    sampleSize: n,
    sourcesRead: input.sourcesRead,
    sourcesExpected: input.sourcesExpected,
    unreadable: input.unreadable,
  };
}

/** The confidence of a profile that could not be computed at all. Used so callers never fabricate one. */
export function noConfidence(reason: string): Confidence {
  return {
    band: 'none',
    reasons: [reason],
    sampleSize: 0,
    sourcesRead: 0,
    sourcesExpected: 0,
    unreadable: false,
  };
}
