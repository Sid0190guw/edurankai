// src/lib/horizon/interpretation/index.ts — PATCH 03's PUBLIC SURFACE.
//
// This directory is owned by PATCH 03 (the Professional Interpretation Layer). Everything another
// patch needs is re-exported here, and only what is re-exported here is a contract: the internals of
// engine.ts, store.ts and language-guard.ts may change without notice, this file may not.
//
// =================================================================================================
// PATCH 02 IS ALREADY CONNECTED — src/lib/foundational, through foundational-adapter.ts
// =================================================================================================
//
//   connectFoundationalEngine()   idempotent; will not displace a provider already registered.
//
// Called from /api/admin/horizon/interpretation and /admin/horizon/interpretation. The adapter asks
// patch 02 for its NEUTRAL projection only — it never requests the technical capability — so the
// framework vocabulary never enters this process.
//
// IT SHIPS NO MAPPING, DELIBERATELY. Deciding that a given structural code relates to a given
// professional dimension is the interpretive claim itself, and it must be authored by a named human,
// not defaulted by an agent. Until registerFactorMapping() is called, every factor is reported as
// unmapped, the count is printed on the surface, and no dimension is produced. Use
// listFoundationalMappingKeys() to author a mapping from the keys that actually occur.
//
// =================================================================================================
// FOR A DIFFERENT FOUNDATIONAL UPSTREAM — how to connect one
// =================================================================================================
//
//   import { registerFoundationalProvider } from '@/lib/horizon/interpretation';
//
//   registerFoundationalProvider('patch-02', async (subject) => {
//     const factors = await myComputation(subject);         // PATCH 02's own work
//     if (!factors) return { state: 'not_configured', reason: '...' };
//     return {
//       state: 'ok',
//       set: {
//         subject,
//         factors: factors.map((f) => ({
//           id: f.id, code: f.code, weight: f.weight, polarity: f.polarity,
//           confidence: f.confidence, method: f.method, methodVersion: f.version,
//           contributesTo: [{ dimension: 'analytical_orientation', weight: 0.6 }],
//         })),
//         computedAt: new Date().toISOString(),
//         sourceModule: 'patch-02', sourceVersion: '1.0.0',
//         complete: true,
//         consentRef: consentRecordId,        // REQUIRED, or interpretation is refused
//       },
//     };
//   });
//
// A factor may instead leave `contributesTo` off and rely on a table registered once with
// registerFactorMapping('patch-02', { '<factor code>': [{ dimension, weight }] }).
//
// PATCH 03 will never read a factor's `code`, `method` or `note` onto a screen, and will never
// promote an indication above the confidence ceiling. Both are enforced in code and in tests.
//
// =================================================================================================
// FOR A CONSUMING PATCH (profile views, dashboards, reviews) — how to read
// =================================================================================================
//
//   import { interpretSubject, latestInterpretation } from '@/lib/horizon/interpretation';
//
//   const { result } = await interpretSubject({ kind: 'employee', id }, { actorUserId, persist: true });
//   const view = await latestInterpretation({ kind: 'employee', id }, {
//     actorUserId, purpose: 'Development conversation preparation',
//     caps: { view: true, trace: false },
//   });
//
// Every read requires a stated purpose and writes an audit row before it returns anything. A read
// that could not be logged returns a refusal, not the data.
//
// =================================================================================================
// FOR AN EVIDENCE OWNER — how to make demonstrated work take precedence
// =================================================================================================
//
//   import { registerEvidenceProvider } from '@/lib/horizon/interpretation';
//
// Answer with `presence: 'demonstrated'` for a dimension and every indication for it is marked
// superseded, has its confidence halved and its implications withheld. Answer 'unknown' or register
// nothing and the interpretation says on every dimension that it was never checked.

export {
  // Input contract
  registerFoundationalProvider,
  clearFoundationalProvider,
  foundationalProviderName,
  registerFactorMapping,
  clearFactorMapping,
  factorMappingName,
  validateFactorMapping,
  validateFactorSet,
  contributionsFor,
  digestFactorSet,
  fetchFoundationalFactors,
  isSubject,
  isSubjectKind,
  SUBJECT_KINDS,
  ACCEPTED_DIMENSIONS,
} from './contract';
export type {
  UpstreamContext,
  FactorContribution,
  FactorMappingTable,
  FactorSetValidation,
  FoundationalFactor,
  FoundationalFactorSet,
  FoundationalProvider,
  FoundationalProviderResult,
  HorizonSubject,
  MappingValidation,
  ProviderState,
  SubjectKind,
} from './contract';

export {
  DIMENSION_IDS,
  DIMENSION_LEVELS,
  DIMENSION_LIST,
  DIMENSIONS,
  CONFIDENCE_BANDS,
  CONFIDENCE_LABELS,
  LEVEL_LABELS,
  LEVEL_RANK,
  UNIVERSAL_LIMITATIONS,
  dimensionSpec,
  implicationsFor,
  isDimensionId,
  limitationsFor,
} from './dimensions';
export type { ConfidenceBand, DimensionId, DimensionLevel, DimensionSpec } from './dimensions';

export {
  ENGINE_VERSION,
  INFERRED_CONFIDENCE_CEILING,
  MIN_MASS,
  NOT_FOR_DECISIONS_NOTICE,
  bandFor,
  engineSelfCheck,
  interpret,
  levelFor,
  projectForViewer,
} from './engine';
export type {
  ContributingFactor,
  ContributingFactorTrace,
  DimensionInterpretation,
  ExplainabilityRecord,
  InterpretationResult,
  InterpretationState,
  RedactionRecord,
  ViewerCapabilities,
} from './engine';

export {
  SUPERSEDED_CONFIDENCE_FACTOR,
  clearEvidenceProvider,
  evidenceProviderName,
  fetchEvidenceContext,
  registerEvidenceProvider,
  resolvePrecedence,
} from './evidence';
export type { DimensionEvidence, EvidenceContext, EvidencePresence, EvidenceProvider, Precedence } from './evidence';

export {
  assertNeutral,
  guardList,
  guardText,
  guardUpstreamNote,
  languageGuardSelfCheck,
  scanText,
  GUARD_GROUPS,
} from './language-guard';
export type { GuardGroupId, GuardHit, GuardResult } from './language-guard';

export {
  FOUNDATIONAL_ADAPTER_NAME,
  FOUNDATIONAL_SOURCE_MODULE,
  connectFoundationalEngine,
  foundationalMappingKey,
  listFoundationalMappingKeys,
} from './foundational-adapter';
export type { MappingKeyRow } from './foundational-adapter';

export {
  ensureHorizonInterpretationSchema,
  interpretSubject,
  interpretationHistory,
  latestInterpretation,
  recordObjection,
  saveInterpretation,
} from './store';
export type {
  DimensionMovement,
  HistoryEntry,
  InterpretSubjectOptions,
  InterpretSubjectOutcome,
  ReadOptions,
  SaveResult,
  StoredInterpretation,
} from './store';
