// src/lib/behaviour/index.ts — PATCH 04: the public surface. Import from here, not from the parts.
//
// WHY A BARREL ON A PATCH THIS SMALL. The internal files will move — metrics will be split when the
// catalogue grows, sources will gain a table — and PATCH 05 must not have to care. This file is the
// contract; everything behind it is implementation.
//
// =================================================================================================
// WHAT ANOTHER PATCH MAY DO WITH THIS
// =================================================================================================
//
//   READ a profile:            computeBehaviouralProfile({ employeeId, purpose, viewer })
//   READ the catalogue:        METRIC_META, BEHAVIOUR_METRICS, BEHAVIOUR_WINDOWS
//   INSTALL a consent register: setConsentCheck(fn)
//   RECOMPUTE from fixtures:   computeMetrics / assessTrend, both pure
//
// WHAT NO PATCH MAY DO WITH IT, and what is therefore not exported:
//
//   There is no function that returns a score, a rank, a percentile, a cohort comparison or a
//   recommendation, and no way to assemble one from what is exported without writing that
//   arithmetic yourself, in the open, where a reviewer can see it. That is deliberate. If a caller
//   needs "the top five", the answer this patch gives is that it does not produce one — an ordering
//   of people by a behavioural figure is the artefact that turns advisory evidence into a decision
//   nobody admits to making.
//
//   Nothing here writes. This patch owns no table, adds no column and inserts nothing except its own
//   access-log rows.

export type {
  AccessBasis,
  AccessDecision,
  Baseline,
  BehaviouralObservation,
  BehaviouralProfile,
  BehaviourComplexity,
  BehaviourMetricKey,
  BehaviourPurpose,
  BehaviourSignalKind,
  BehaviourSourceTable,
  BehaviourTrend,
  BehaviourWindow,
  Confidence,
  ConfidenceBand,
  EvidenceRef,
  ExplanationInputs,
  MetricMeta,
  MetricValue,
  PatternVerdict,
  ResolvedWindow,
  TrendVerdict,
} from './types';

export {
  BEHAVIOUR_METRICS,
  BEHAVIOUR_PURPOSES,
  BEHAVIOUR_SIGNAL_KINDS,
  BEHAVIOUR_WINDOWS,
  DECISION_USE,
  NOT_PRODUCTIVITY,
  WINDOW_LABELS,
} from './types';

// The one entry point. Authorises, logs, reads, computes, and refuses in words.
export { computeBehaviouralProfile, SUBPERIOD_COUNT } from './profile';
export type { ProfileRequest, ProfileResult } from './profile';

// Access: the capability keys, the registry entries awaiting approval, and the consent seam.
export {
  CAP_BEHAVIOUR_VIEW_ORG,
  CAP_BEHAVIOUR_VIEW_DEPARTMENT,
  REGISTRY_ENTRIES,
  authoriseBehaviourRead,
  setConsentCheck,
} from './access';
export type { BehaviourConsentCheck, ConsentContext, ViewerContext } from './access';

// The catalogue. A surface that renders a number MUST render `definition` with it.
export { METRIC_META, EVIDENCE_CAP, computeMetrics, computeMetric } from './metrics';
export type { MetricInput, TaskTrace } from './metrics';

// Pure interpretation, exported so it can be exercised against fixtures without a database.
export { assessTrend, assessPattern, MIN_RELATIVE_CHANGE } from './trend';
export type { TrendInput, SubPeriodValue } from './trend';
export { assessConfidence, noConfidence, STALE_DAYS } from './confidence';
export type { ConfidenceInput } from './confidence';

// Time. Exported because a caller that renders a window must name the same interval this queried.
export {
  DEFAULT_TZ_OFFSET_MINUTES,
  RECENT_DAYS,
  precedingPeriod,
  resolveAllWindows,
  resolveWindow,
  subPeriods,
} from './windows';
export type { WindowOptions } from './windows';

// The read layer, exported for the classifier alone: PATCH 05 and any future source patch need to
// agree on what an audit row means, and a second copy of that mapping would drift within a month.
export { classify, readObservations, readEmployment } from './sources';
export type { EmploymentFacts, ObservationRead, SourceReadReport } from './sources';

// -------------------------------------------------------------------------------------------------
// THE HORIZON CONTRACT SIDE
// -------------------------------------------------------------------------------------------------
//
// Kept behind its own file and re-exported here rather than merged into the engine: everything above
// this line computes behaviour and knows nothing about HORIZON, which is what lets the engine be
// tested, replaced and read on its own.
//
// NOT ADDED TO `@/lib/horizon`'s own barrel. That file belongs to the shared-contract patch, and
// this patch does not edit another patch's module to announce itself. The record surface imports
// `registerBehaviourProvider` from here, calls it once at start-up, and injects the viewer seam.
export {
  behaviourProvider,
  registerBehaviourProvider,
  setBehaviourViewerResolver,
  toIntelligenceResult,
  DIMENSIONS,
  PATCH_ID,
  ENGINE_ID,
  ENGINE_VERSION,
  RECOMPUTE_AFTER_DAYS,
} from './provider';
export type { BehaviourViewerResolver } from './provider';
