// src/lib/foundational/index.ts — THE PUBLIC SURFACE of HORIZON patch 02.
//
// Import from here, not from the files beneath it. What this module exports is the contract other
// patches may depend on; everything else is an implementation detail that may change inside a
// version bump.
//
// THE FOUR ENTRY POINTS the brief specifies:
//
//   computeProfile()            run and store a computation for a subject
//   recomputeProfile()          re-run from the stored input; writes only when the answer changed
//   getComputationByVersion()   read a stored computation, latest or exact
//   getTimePeriodAnalysis()     current, upcoming and long-horizon cycle periods
//
// THE EVENT: intelligence.computation_completed, name available as INTELLIGENCE_EVENTS.
//
// WHAT THIS ENGINE DOES NOT DO, and no wrapper around it may pretend otherwise: it produces no
// interpretation, no professional assessment, no suitability, no ranking and no decision. Its output
// is a set of versioned arithmetic results with their inputs, evidence and uncertainty attached. Any
// meaning attributed to them belongs to a separate interpretation layer, and any decision belongs to
// a named human being.

// ------------------------------------------------------------------------------------------------
// Entry points and the method manifest.
// ------------------------------------------------------------------------------------------------
export {
  computeProfile,
  recomputeProfile,
  getComputationByVersion,
  getTimePeriodAnalysis,
  listComputations,
  storeBirthInput,
  eraseBirthInput,
  computeFromInput,
  describeMethod,
  inputHashOf,
  outputHashOf,
  type ComputeResult,
  type ComputationView,
  type ComputedProfile,
  type StoreInputResult,
} from './engine';

// ------------------------------------------------------------------------------------------------
// The contract: shapes, capabilities, the event name, and the projection helpers that keep the
// technical layer behind its capability.
// ------------------------------------------------------------------------------------------------
export {
  CALCULATION_METHOD_VERSION,
  CONSENT_PURPOSE,
  FOUNDATIONAL_CAPABILITIES,
  INTELLIGENCE_EVENTS,
  FACTOR_CATEGORIES,
  SUBJECT_KINDS,
  COMPUTATION_REASONS,
  TIME_PRECISIONS,
  TIME_PRECISION_MINUTES,
  DECISION_WORDS,
  hasCapabilities,
  maySeeTechnical,
  projectFactor,
  projectPeriod,
  projectComputation,
  decisionWordIn,
  type BirthInput,
  type GeoPoint,
  type NormalizedBirthInput,
  type TimePrecision,
  type FoundationalFactor,
  type FactorCategory,
  type FactorEvidence,
  type TechnicalDetail,
  type CyclePeriod,
  type TimePeriodAnalysis,
  type ComputationRecord,
  type ComputationReason,
  type ComputedPoint,
  type RawComputation,
  type MethodManifest,
  type SubjectRef,
  type ViewerContext,
  type Refusal,
} from './types';

// ------------------------------------------------------------------------------------------------
// Consent: the gate, and the seam another patch replaces it through.
// ------------------------------------------------------------------------------------------------
export {
  checkConsent,
  grantConsent,
  revokeConsent,
  setConsentProvider,
  resetConsentProvider,
  consentProviderName,
  type ConsentGate,
  type ConsentState,
  type ConsentGrantInput,
} from './consent';

// ------------------------------------------------------------------------------------------------
// Schema. Exported so an ops or bootstrap surface can create the tables explicitly rather than
// relying on the first request to do it.
// ------------------------------------------------------------------------------------------------
export { ensureFoundationalSchema, FOUNDATIONAL_DDL } from './schema';

// ------------------------------------------------------------------------------------------------
// Neutral structural codes. Exported because a consuming surface needs to render B01..B09 and
// S01..S12 without reaching into the gated vocabulary — which is not exported here at all, and is
// reachable only through a factor's `technical` block, which projectFactor() strips by default.
// ------------------------------------------------------------------------------------------------
export { POINT_CODES, POINT_LABELS, sectorCode, segmentCode, houseCode, type PointCode } from './vocabulary';

// ------------------------------------------------------------------------------------------------
// The HORIZON bridge. How this engine binds to patch 01 (birth co-ordinates, consent ledger) and to
// the HORIZON event outbox, WITHOUT either patch importing the other's internals.
//
// A deployment that runs this engine on its own needs none of it: the defaults fall back to this
// module's own store and the fallback says so.
// ------------------------------------------------------------------------------------------------
export {
  configureHorizonBridge,
  horizonBridgeConfig,
  horizonConsentGate,
  horizonBirthInputSource,
  emitComputationCompleted,
  toHorizonSubject,
  type BridgeConfig,
  type BirthInputSource,
  type BirthInputResult,
} from './horizon-bridge';
export { setBirthInputSource } from './engine';
export { localConsentGate } from './consent';

// ------------------------------------------------------------------------------------------------
// Pure layers, for a caller that wants the arithmetic without the database.
// ------------------------------------------------------------------------------------------------
export { normalizeBirthInput, InputError, VALID_FROM_YEAR, VALID_TO_YEAR } from './time';
export { computeRaw, POINT_UNCERTAINTY_DEG } from './astronomy';
export { deriveFactors, STRENGTH_WEIGHTS } from './factors';
export {
  analyzePeriods, computePeriods, cycleSeed, cycleFactors,
  level1Periods, level2Periods, level3Periods,
  CYCLE_SEQUENCE, CYCLE_TOTAL_YEARS, CYCLE_YEAR_DAYS, DEFAULT_HORIZON_YEARS,
  type CycleSeed,
} from './periods';
