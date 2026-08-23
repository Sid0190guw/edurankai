// src/lib/horizon/governance/index.ts — the public API of PATCH 17.
//
//   import { authorizeGovernedRead, recordHumanDecision, auditAnswer } from '@/lib/horizon/governance';
//
// EVERYTHING ANOTHER PATCH NEEDS IS HERE, and nothing it needs is anywhere else in this directory.
// If you find yourself importing './gate' or './ledger' from outside this folder, that is the seam
// telling you this file is missing an export — adding one here is the fix. A deep import couples the
// caller to a file layout, and this patch is contractually allowed to change its own.
//
// WHAT IS NOT RE-EXPORTED HERE, AND WHERE IT LIVES INSTEAD. This layer deliberately does not
// re-export another patch's work through its own barrel — that would make their file layout part of
// this patch's contract, which is the mistake src/lib/horizon/index.ts already calls out about
// ./access:
//
//   field-level redaction, audiences   @/lib/horizon  (visibility.ts: redactForAudience, AUDIENCE_SPECS)
//   consent capture and withdrawal     @/lib/horizon/intake  (grantConsent, withdrawConsent, currentConsent)
//   subjects, actors, organisation ids @/lib/horizon/ids
//   signal weight and neutral wording  @/lib/horizon  (contracts.ts: outranks, screenTerminology)
//
// THE FIVE THINGS THIS LAYER GUARANTEES, and where each one lives:
//
//   1. No audience can be claimed that the permission registry did not grant   matrix.resolveAudience
//   2. No governed read happens without a logged decision                      gate.authorizeGovernedRead
//   3. No high-impact suggestion is acted on without a named human             ledger.recordHumanDecision
//   4. No engine version is used that cannot be looked up                      ledger.registerEngineVersion
//   5. All of the above can be reconstructed for one person on request         ledger.auditAnswer
export type {
  AuditAnswer, AuditAnswerEntry, DecisionKind, EngineVersion, ErasureRequest, ErasureStatus,
  GovernanceActor, GovernanceResult, HumanDecisionRecord, ImpactLevel, LawfulBasis, Purpose,
  RetentionAction, RetentionPolicy,
} from './types';

// The matrix — pure, importable with no database.
export {
  AUDIENCE_PERMISSION, HORIZON_PERMISSIONS, HORIZON_PERMISSION_KEYS, PURPOSES, WILDCARD_KEY,
  governancePermission, holdsGovernancePermission, impactOfPurpose, isPurpose, purposeMeta,
  resolveAudience,
  type AudienceResolution, type GovernancePermissionMeta, type PurposeMeta,
} from './matrix';

// Schema.
export { ensureGovernanceSchema, GOVERNANCE_SCHEMA_KEY, GOVERNANCE_TABLES } from './schema';

// The gate, and the concrete access-log sink that visibility.requireAccessLog was missing.
export {
  MIN_HIGH_IMPACT_PURPOSE, authorizeGovernedRead, governancePermissions, hznAccessLogger,
  type GovernedReadDecision, type GovernedReadRequest,
} from './gate';

// The decision log, the version registry and the audit answer.
export {
  MIN_RATIONALE, agreementRate, auditAnswer, awaitingHumanReview, decisionsFor, listEngineVersions,
  recordHumanDecision, registerEngineVersion, retireEngineVersion, unregisteredVersions,
} from './ledger';

// Retention and erasure.
export {
  RETENTION_TARGETS, applyRetention, approveErasure, ensureRetentionDefaults, erasureBlockers,
  executeErasure, listErasureRequests, listRetentionPolicies, registerErasureParticipant,
  registerRetentionSweeper, registeredErasureParticipants, registeredSweepers, rejectErasure,
  requestErasure, retentionClasses, retentionDue, retentionTarget, setRetentionPolicy, sweepableHere,
  type ErasureParticipant, type RetentionDue, type RetentionSweeper, type RetentionTarget,
  type SweepReport,
} from './retention';

// Publishing the permission keys into the catalogue an admin grants from.
export {
  governanceInstallStatus, governancePublishStatus, publishGovernancePermissions,
  type InstallStatus, type PublishReport, type PublishStatus,
} from './publish';
