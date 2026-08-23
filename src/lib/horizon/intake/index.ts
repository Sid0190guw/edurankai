// src/lib/horizon/intake/index.ts — THE PUBLIC SURFACE OF HORIZON PATCH 01.
//
// Import from here, not from the files behind it. What is re-exported below is the contract other
// patches may depend on; anything not listed is an implementation detail that may change.
//
// THE FOUR THINGS ANOTHER PATCH ACTUALLY WANTS:
//
//   1. "May we process this person's personal profile information?"
//        currentConsent(subject) -> ConsentState { granted, stale, noticeVersion, consentRef }
//
//   2. "Give me the values."
//        readPersonalFoundation({ subject, actor, purpose }) — authorised, consent-checked, audited.
//        There is no other way in, and there is not going to be one.
//
//   3. "What is held, without reading it?"
//        getHoldings(subject) -> FoundationHoldings. No decryption, no audit row.
//
//   4. "What work is waiting for me?"
//        pendingRecomputeRequests() / getRecomputeRequest(id) / markRecomputeRequest(id, status)
//
// AND THE ONE THING THIS PATCH ASKS OF THE APPLICATION FLOW:
//
//        applyFoundationDecision()      on the personal-details step
//        announceApplicationSubmitted() once a submission is staged
export {
  // Contract types
  CONSENT_SCOPE_PERSONAL_FOUNDATION,
  HORIZON_FOUNDATION_READ,
  PROCESSING_STATUSES,
  READ_PURPOSES,
  RECOMPUTE_REASONS,
  RECOMPUTE_STATUSES,
  TIME_PRECISIONS,
  TIME_PRECISION_LABELS,
  type ApplicationSubmittedPayload,
  type BirthCoordinates,
  type BirthPlace,
  type ConsentAction,
  type ConsentEvent,
  type ConsentScope,
  type ConsentState,
  type DerivedInstant,
  type FieldIssue,
  type FoundationHoldings,
  type HorizonEventSink,
  type PersonalFoundationInput,
  type PlacePrecision,
  type ProcessingStatus,
  type ProfileRecomputeRequestedPayload,
  type RawFoundationSubmission,
  type ReadActor,
  type ReadDenial,
  type ReadPurpose,
  type ReadResult,
  type RecomputeReason,
  type RecomputeRequest,
  type RecomputeStatus,
  type StoreOutcome,
  type TimePrecision,
  type TimezoneSource,
  type ValidationResult,
} from './types';

export {
  CURRENT_NOTICE,
  CURRENT_NOTICE_VERSION,
  INTAKE_LABELS,
  NOTICE_VERSIONS,
  PROHIBITED_TERMS,
  assertNeutralLanguage,
  findProhibitedTerms,
  isNoticeCurrent,
  noticeByVersion,
  noticeCanonicalText,
  noticeHash,
  noticeIntegrity,
  type PurposeNotice,
} from './notice';

export {
  EARLIEST_BIRTH_DATE,
  canonicalInputJson,
  canonicalise,
  countryNameFor,
  deriveInstant,
  formatOffset,
  isValidTimezone,
  normalisePlace,
  normaliseTimePrecision,
  offsetMinutesAt,
  parseCanonicalInputJson,
  parseCoordinates,
  parseDateOfBirth,
  parseTimeOfBirth,
  resolveCountryCode,
  supportedTimezones,
  validateFoundationSubmission,
  yearsBetween,
  zonedWallTimeToUtc,
} from './birth-input';

export { ensureHorizonIntakeSchema, HORIZON_INTAKE_DDL } from './schema';

export {
  consentHistory,
  currentConsent,
  deriveConsentState,
  grantConsent,
  needsReconsent,
  noticeForState,
  recordConsent,
  withdrawConsent,
} from './consent';

export {
  encryptionAvailable,
  getHoldings,
  markProcessingStatus,
  mayRead,
  purgeFoundation,
  readPersonalFoundation,
  storePersonalFoundation,
  storedInputHash,
} from './foundation';

export {
  HORIZON_INTAKE_EVENTS,
  emitApplicationSubmitted,
  getRecomputeRequest,
  horizonEventSink,
  markRecomputeRequest,
  pendingRecomputeRequests,
  requestRecompute,
  setHorizonEventSink,
  toRecomputeRequest,
} from './events';

export {
  actorForUser,
  announceApplicationSubmitted,
  applyFoundationDecision,
  subjectForUser,
  type AnnounceSubmissionArgs,
  type AnnounceSubmissionResult,
  type FoundationDecisionArgs,
  type FoundationDecisionResult,
} from './submit';
