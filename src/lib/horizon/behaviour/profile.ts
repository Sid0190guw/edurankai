// src/lib/behaviour/profile.ts — PATCH 04: the orchestrator. One person, six windows, one answer.
//
// THE ORDER IS THE POINT:
//
//   authorise (and log, and confirm the log landed)
//     -> read employment bounds
//       -> resolve six windows, clamped to those bounds
//         -> ONE database read covering the widest span
//           -> filter in memory per window
//             -> metrics (arithmetic)
//               -> baselines and sub-periods (arithmetic)
//                 -> trends (interpretation, each carrying its own confidence)
//                   -> limitations, stated rather than implied
//
// ONE READ, NOT FIFTEEN. Every window, every baseline period and every sub-period is a subset of
// [joining date, now]. Reading that span once and filtering in memory turns what would be fifteen
// round trips into one — on a database in ap-south-1 answering functions in iad1, where each round
// trip is about 177ms, the difference between those is the difference between a page and a timeout.
//
// WHAT THIS FILE WILL NOT DO, however convenient it would be:
//
//   IT PRODUCES NO OVERALL SCORE. There is no field for one and no function that returns one. A
//   single number beside a person's name is read as a verdict whatever the caveats around it say,
//   and there is no honest arithmetic from a task board to "how good is this person".
//
//   IT COMPARES NOBODY TO ANYBODY. Every function takes ONE employeeId. A cohort ranking is not a
//   missing feature here, it is the thing this design is shaped to prevent.
//
//   IT ACCEPTS NO OPINION. `ProfileRequest` has no field for a rating, a comment or a manager's
//   view, and it never will: human feedback is PATCH 05's, and a profile that quietly folded an
//   opinion into a computed figure would destroy the one distinction — evidence versus judgement —
//   that makes any of this safe to show a person.
import type {
  AccessDecision,
  BehaviouralObservation,
  BehaviouralProfile,
  BehaviourMetricKey,
  BehaviourPurpose,
  BehaviourTrend,
  BehaviourWindow,
  Confidence,
  ExplanationInputs,
  MetricValue,
  ResolvedWindow,
} from './types';
import { BEHAVIOUR_METRICS, BEHAVIOUR_WINDOWS, DECISION_USE, NOT_PRODUCTIVITY } from './types';
import {
  DEFAULT_TZ_OFFSET_MINUTES,
  MAX_SUBPERIODS,
  iso,
  precedingPeriod,
  resolveWindow,
  subPeriods,
  toMs,
  withinWindow,
} from './windows';
import { computeMetrics } from './metrics';
import { assessTrend, type SubPeriodValue } from './trend';
import { assessConfidence, noConfidence } from './confidence';
import { readObservations, type SourceReadReport } from './sources';
import { authoriseBehaviourRead, type ViewerContext } from './access';

/** How many buckets a window is cut into to tell a blip from a direction. */
export const SUBPERIOD_COUNT = 6;

export interface ProfileRequest {
  /** hr_employees.id. One person. There is no plural form of this function. */
  employeeId: string;
  /** Why the viewer is looking. Enforced against the ground of access, not merely recorded. */
  purpose: BehaviourPurpose;
  viewer: ViewerContext;
  /** Defaults to all six. A caller may narrow it; it may not invent one. */
  windows?: BehaviourWindow[];
  /** Defaults to the whole catalogue. */
  metrics?: BehaviourMetricKey[];
  /** Injected for tests and for a consistent instant across every window. Defaults to now. */
  nowMs?: number;
  tzOffsetMinutes?: number;
}

export type ProfileResult =
  | { ok: true; profile: BehaviouralProfile; access: AccessDecision }
  | { ok: false; profile: null; access: AccessDecision };

const SOURCES_EXPECTED = 3;

function metricMap(
  observations: BehaviouralObservation[],
  window: BehaviourWindow,
  tzOffsetMinutes: number,
): Map<BehaviourMetricKey, MetricValue> {
  const values = computeMetrics({ observations, window, tzOffsetMinutes });
  return new Map(values.map((v) => [v.key, v] as const));
}

function inRange(
  observations: BehaviouralObservation[],
  fromIso: string,
  toIso: string,
): BehaviouralObservation[] {
  return observations.filter((o) => withinWindow(o.occurredAt, fromIso, toIso));
}

/**
 * WHAT THIS PROFILE COULD NOT ESTABLISH, in the words a reader needs.
 *
 * Written from the read reports and the shape of the record rather than from a fixed list, so a
 * limitation that stops applying stops being printed. Every entry names a consequence — "no linked
 * login" means nothing to a manager; "no assessment behaviour could be matched to this person"
 * does.
 */
function limitationsFor(
  reports: SourceReadReport[],
  hasLinkedLogin: boolean,
  observationCount: number,
): string[] {
  const out: string[] = [];

  for (const r of reports) {
    if (!r.readable) {
      out.push(
        `${r.table} could not be read${r.note ? `: ${r.note}` : '.'} An unknown amount of recorded work is missing from everything below, which is not the same as there being none.`,
      );
    } else if (r.note) {
      out.push(r.note);
    }
  }

  if (!hasLinkedLogin) {
    out.push(
      'This employee record carries no linked login, so no action could be attributed to the person themselves and no assessment attempt could be matched to them. Ask HR to link the account before reading anything here as a statement about how they work.',
    );
  }

  if (observationCount === 0) {
    out.push(
      'No recorded work events fell in the periods examined. Nothing here is a statement about this person.',
    );
  }

  out.push(
    'Only assigned tasks and assessment attempts recorded on this platform are read. Work done elsewhere — in a repository, a document, a conversation, a meeting, or any tool this system is not connected to — is invisible here and its absence means nothing.',
  );
  out.push(
    'The only complexity information in the record is the priority the assigner typed. It is used to compare like with like and never to weight a figure, so two tasks of very different difficulty count the same.',
  );
  out.push(
    'No manager or colleague feedback is read, weighted or reflected anywhere in this profile. Recorded human judgement is a separate record with a named author.',
  );
  out.push(
    'Being blocked, being reassigned and having work cancelled are frequently organisational events rather than anything about the assignee. Read every figure below with what was happening around the person.',
  );

  return out;
}

/**
 * COMPUTE ONE PERSON'S BEHAVIOURAL PROFILE.
 *
 * Returns `ok: false` with the AccessDecision whenever the read was refused, and the decision is
 * safe to show — it never says whether the person exists. On the refusal path NO source row is read
 * at all: authorisation happens before the first query, not around the result of one.
 */
export async function computeBehaviouralProfile(req: ProfileRequest): Promise<ProfileResult> {
  const access = await authoriseBehaviourRead(req.employeeId, req.purpose, req.viewer);
  if (!access.allowed) return { ok: false, profile: null, access };

  const nowMs = req.nowMs ?? Date.now();
  const tz = req.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const wantedWindows = (req.windows?.length ? req.windows : [...BEHAVIOUR_WINDOWS]).filter((w) =>
    BEHAVIOUR_WINDOWS.includes(w),
  );
  const wantedMetrics = (req.metrics?.length ? req.metrics : [...BEHAVIOUR_METRICS]).filter((m) =>
    BEHAVIOUR_METRICS.includes(m),
  );

  const processing: string[] = [
    `Authorised on the ground "${access.basis}" for the stated purpose "${access.purpose}", and the reading was written to the access log before any record was read.`,
  ];

  // ---- employment bounds, then the widest span any window will need -------------------------
  const bounds = await import('./sources').then((m) => m.readEmployment(req.employeeId));
  const widest = resolveWindow('employment_history', nowMs, {
    employedFromMs: bounds.joiningDateMs,
    employedToMs: bounds.exitDateMs,
    tzOffsetMinutes: tz,
  });
  processing.push(
    bounds.joiningDateMs === null
      ? 'No joining date is on the employee record, so the history window covers every record held for this person.'
      : `Employment on record from ${iso(bounds.joiningDateMs)}${bounds.exitDateMs !== null ? ` to ${iso(bounds.exitDateMs)}` : ''}; every window below is clamped inside it.`,
  );

  const read = await readObservations(req.employeeId, {
    fromIso: widest.fromIso,
    toIso: widest.toIso,
  });
  processing.push(
    `Read ${read.observations.length} recorded work events in one pass over ${widest.statement}, then filtered them per period in memory rather than querying six times.`,
  );

  const sourcesRead = read.reports.filter((r) => r.readable && r.rowsRead > 0).length;
  const mostRecentMs = read.observations.length
    ? toMs(read.observations[read.observations.length - 1].occurredAt)
    : null;
  const staleDays = mostRecentMs === null ? null : (nowMs - mostRecentMs) / 86_400_000;

  const windowOpts = {
    employedFromMs: bounds.joiningDateMs,
    employedToMs: bounds.exitDateMs,
    tzOffsetMinutes: tz,
  };

  const resolvedWindows: ResolvedWindow[] = wantedWindows.map((w) => resolveWindow(w, nowMs, windowOpts));

  // The career-long values, computed once. They are both the 'employment_history' output and the
  // fallback baseline for a window whose immediately preceding period is too thin to compare
  // against — which is the ordinary case for anybody in their first months.
  const historyWindow = resolveWindow('employment_history', nowMs, windowOpts);
  const historyValues = metricMap(
    inRange(read.observations, historyWindow.fromIso, historyWindow.toIso),
    'employment_history',
    tz,
  );

  const metrics: MetricValue[] = [];
  const trends: BehaviourTrend[] = [];

  for (const resolved of resolvedWindows) {
    const windowObs = inRange(read.observations, resolved.fromIso, resolved.toIso);
    const current = metricMap(windowObs, resolved.window, tz);
    for (const key of wantedMetrics) {
      const v = current.get(key);
      if (v) metrics.push(v);
    }

    // Employment history is the floor of the record; there is nothing before it to compare against,
    // and inventing a comparison would be comparing a career to itself.
    if (resolved.window === 'employment_history') {
      processing.push(
        'The employment-history period is reported as values only. There is nothing recorded before it to compare it against, so no trend is claimed over it.',
      );
      continue;
    }

    const prior = precedingPeriod(resolved, windowOpts);
    const priorValues = prior
      ? metricMap(inRange(read.observations, prior.fromIso, prior.toIso), resolved.window, tz)
      : null;

    const buckets = subPeriods(resolved, Math.min(SUBPERIOD_COUNT, MAX_SUBPERIODS));
    const bucketValues: { fromIso: string; toIso: string; values: Map<BehaviourMetricKey, MetricValue> }[] =
      buckets.map((b) => ({
        ...b,
        values: metricMap(inRange(read.observations, b.fromIso, b.toIso), resolved.window, tz),
      }));

    for (const key of wantedMetrics) {
      const currentValue = current.get(key);
      if (!currentValue) continue;

      const priorValue = priorValues?.get(key) ?? null;
      const priorUsable = !!priorValue && !priorValue.insufficient && priorValue.value !== null;

      // FALL BACK TO THE CAREER BASELINE, AND SAY SO. A month compared against a career is a
      // different claim from a month compared against the month before it, and the two must never
      // be printed in the same words — `Baseline.kind` and its statement carry the difference.
      const historyValue = historyValues.get(key) ?? null;
      const historyUsable = !!historyValue && !historyValue.insufficient && historyValue.value !== null;

      const useHistory = !priorUsable && historyUsable;

      const subs: SubPeriodValue[] = bucketValues
        .map((b) => {
          const v = b.values.get(key);
          return v ? { fromIso: b.fromIso, toIso: b.toIso, value: v } : null;
        })
        .filter(Boolean) as SubPeriodValue[];

      trends.push(
        assessTrend({
          key,
          resolved,
          current: currentValue,
          baselineMetric: useHistory ? historyValue : priorValue,
          baselineKind: useHistory ? 'employment_history' : prior ? 'preceding_period' : 'none',
          baselineFromIso: useHistory ? historyWindow.fromIso : (prior?.fromIso ?? null),
          baselineToIso: useHistory ? historyWindow.toIso : (prior?.toIso ?? null),
          subPeriods: subs,
          staleDays,
          sourcesRead,
          sourcesExpected: SOURCES_EXPECTED,
          unreadable: read.unreadable,
        }),
      );
    }
  }

  processing.push(
    `Computed ${metrics.length} metric values across ${resolvedWindows.length} periods, each against the ${SUBPERIOD_COUNT}-bucket split of its own period so a one-off can be told apart from a direction.`,
  );
  processing.push(
    'Where the period immediately before a window held too few records to compare against, the comparison falls back to this person’s whole employment history and says so on the result.',
  );
  processing.push(
    'No figure here is combined with any other, weighted, ranked against another person, or turned into a score.',
  );

  const confidence: Confidence = read.observations.length
    ? assessConfidence({
        sampleSize: read.observations.length,
        sourcesRead,
        sourcesExpected: SOURCES_EXPECTED,
        unreadable: read.unreadable,
        staleDays,
      })
    : noConfidence(
        read.unreadable
          ? 'A source could not be read, so it is unknown whether there are records for this person.'
          : 'No recorded work events for this person in the periods examined.',
      );

  const inputs: ExplanationInputs = {
    sources: read.reports.map((r) => ({
      table: r.table,
      rowsRead: r.rowsRead,
      readable: r.readable,
      note: r.note,
    })),
    windows: resolvedWindows,
    employedFromIso: bounds.joiningDateMs === null ? null : iso(bounds.joiningDateMs),
    employedToIso: bounds.exitDateMs === null ? null : iso(bounds.exitDateMs),
    observationCount: read.observations.length,
  };

  const profile: BehaviouralProfile = {
    employeeId: req.employeeId,
    decisionUse: DECISION_USE,
    disclaimer: NOT_PRODUCTIVITY,
    inputs,
    processing,
    metrics,
    trends,
    confidence,
    limitations: limitationsFor(read.reports, read.employment.userId !== null, read.observations.length),
    computedAtIso: new Date(nowMs).toISOString(),
    access,
  };

  return { ok: true, profile, access };
}
