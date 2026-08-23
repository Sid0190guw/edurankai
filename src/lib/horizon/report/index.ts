// src/lib/horizon/report/index.ts — THE PUBLIC SURFACE OF PATCH 18.
//
// Import from here, not from the files behind it. Everything re-exported below is a contract this
// patch will keep: fields get added, they do not get renamed or removed without a major bump of
// ENGINE_VERSION and a note in docs/horizon/report-engine.md.
//
// FOR ANOTHER PATCH, THERE ARE EXACTLY THREE THINGS YOU MIGHT WANT.
//
//   1. GENERATE A REPORT
//        import { generateReport } from '@/lib/horizon/report';
//        const result = await generateReport({
//          reportId: 'employee_professional_intelligence',
//          subjectId: employeeId,
//          viewer: { id: user.id, role: user.role },
//        }, { locals: Astro.locals });
//      Access is decided inside. There is no way to ask this engine for a document while skipping
//      that check, which is why the viewer is a required argument and not an option.
//
//   2. CONTRIBUTE DATA YOU OWN
//        import { registerSourceProvider, CAPABILITIES } from '@/lib/horizon/report';
//      Implement SourceProvider, declare the relations you read and the capabilities you answer, and
//      register it at module load. Your claims flow into sections 1-3 of every report that asked for
//      your capability. You do not need to touch this patch's code and this patch does not need to
//      know your tables exist.
//
//   3. REPLACE THE INTERPRETER
//        import { type Interpreter } from '@/lib/horizon/report';
//      Implement it, pass it as `options.interpreter`. Your claims go through the same validation as
//      the built-in one: the confidence ceiling applies, and a recommendation about hiring,
//      rejection, termination, promotion, compensation or discipline is refused unless it carries the
//      id of a recommendation already stored through ai-boundary.
//
// WHAT YOU CANNOT DO THROUGH THIS SURFACE, BY DESIGN: record a decision. Decisions belong to
// src/lib/ai-boundary.ts and its recordHumanDecision(), which enforces the override reason in a
// CHECK constraint. This engine reads them and never writes one.

// --- generation ---------------------------------------------------------------------------------
export { generateReport } from './engine';

// --- the catalogue ------------------------------------------------------------------------------
export {
  CAPABILITIES, ORGANISATION_SUBJECT_ID,
  allReportDefinitions, allRequiredCapabilities, isReportId, reportDefinition,
} from './registry';
export type { CapabilityKey } from './registry';

// --- contributing data --------------------------------------------------------------------------
export {
  answeredCapabilities, emptyLoad, planSources, refusedProviders, registerSourceProvider,
  registeredProviders,
} from './sources';

// --- building claims (for providers) --------------------------------------------------------------
export {
  capConfidence, claimId, confidenceCeiling, derivedClaim, engineStamp, estimated, evidenceRef,
  factClaim, feedbackClaim, forbiddenSubjectIn, forbiddenTableIn, humanDecisionClaim,
  interpretationClaim, levelForScore, observed, recommendationClaim, screenClaims, sourceRef,
  validateClaim, FORBIDDEN_SUBJECTS, FORBIDDEN_TABLE_PATTERNS,
} from './provenance';

// --- interpretation -----------------------------------------------------------------------------
export { deterministicInterpreter, INTERPRETER_ID, INTERPRETER_VERSION } from './interpret';

// --- access -------------------------------------------------------------------------------------
export { decideAccess, employeeIdForUser } from './access';
export type { AccessDecision } from './access';

// --- persistence --------------------------------------------------------------------------------
export { ensureRunSchema, getRun, purgeRunsOlderThan, recentRuns, recordRun } from './runs';
export type { RunSchemaState, StoredRun } from './runs';

// --- rendering ----------------------------------------------------------------------------------
export { escapeHtml, renderReportHtml, REPORT_STYLES } from './render';
export type { RenderOptions } from './render';

// --- version ------------------------------------------------------------------------------------
export { ADVISORY_NOTICE, ENGINE_ID, ENGINE_TAG, ENGINE_VERSION } from './version';

// --- the vocabulary -----------------------------------------------------------------------------
export {
  AUDIENCE_LABELS, CONFIDENCE_LABELS, EVIDENCE_WEIGHT, REPORT_IDS,
  SECTION_DESCRIPTIONS, SECTION_KINDS, SECTION_ORDER, SECTION_TITLES,
} from './types';
export type {
  AiInterpretationClaim, Claim, ClaimOfKind, Confidence, ConfidenceLevel, DerivedClaim,
  DocumentCoverage, DocumentIntegrity, EngineStamp, EvidenceRef, FactClaim, GenerateOptions,
  GenerateResult, HumanDecisionClaim, HumanFeedbackClaim, InterpretationInput, InterpretationResult,
  Interpreter, ModelStamp, Provenance, RecommendationClaim, ReportAudience, ReportDefinition,
  ReportDocument, ReportId, ReportSection, ReportSubject, ReportSubjectKind, SectionCoverage,
  SectionKind, SourceDescriptor, SourceLoad, SourceLoadContext, SourceProvider, SourceRef,
  SubjectRef, ViewerContext,
} from './types';
