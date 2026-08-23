// src/lib/fusion/index.ts — THE PUBLIC SURFACE OF THE DYNAMIC HUMAN INTELLIGENCE FUSION ENGINE.
//
//   import { buildProfile, viewFor, decideAccess } from '@/lib/fusion';
//
// EVERY CONSUMER IMPORTS FROM HERE, not from the individual files. That is not a style preference:
// it is what lets this module split a file or move a definition without touching whichever patch is
// reading it that week. A consumer that imports '@/lib/fusion/fuse' has coupled itself to the
// current file layout.
//
// WHAT IS DELIBERATELY NOT EXPORTED:
//   - The reading brand symbol. No module outside this directory can construct a DimensionReading,
//     which is what makes it impossible anywhere in this codebase to produce a number about a person
//     without the explanation that has to travel with it.
//   - Any writer against another patch's tables. This engine reads through owners and writes only
//     to its own four hif_* tables.
//   - Any function that returns an overall score for a person. There is not one, and there is no
//     field one could be stored in.

// THE CONTRACT — dimensions, source classes, the signal shape, the explanation shape.
export {
  FUSION_DIMENSIONS,
  DIMENSION_SPECS,
  DIMENSION_LABELS,
  INVERTED_DIMENSIONS,
  SOURCE_CLASSES,
  SOURCE_CLASS_SPECS,
  SOURCE_CLASS_LABELS,
  DEMONSTRATED_CLASSES,
  INFERRED_CLASS,
  AGREEMENTS,
  AGREEMENT_LABELS,
  CONFIDENCE_BANDS,
  CONFIDENCE_BAND_LABELS,
  CONFIDENCE_DIRECTIONS,
  CONFIDENCE_DIRECTION_LABELS,
  READING_STATUSES,
  READING_STATUS_LABELS,
  NOTE_STANCES,
  NOTE_STANCE_LABELS,
  dimensionSpec,
  sourceClassSpec,
  isFusionDimension,
  isSourceClass,
  isNoteStance,
  isDemonstrated,
  isInverted,
} from './types';

export type {
  FusionDimension,
  SourceClass,
  DimensionSpec,
  SourceClassSpec,
  Signal,
  SourceView,
  Agreement,
  Explanation,
  ConfidenceReport,
  ConfidenceBand,
  ConfidenceDirection,
  DimensionReading,
  ReadingStatus,
  FusionProfile,
  ProfileSubject,
  HumanNote,
  NoteStance,
} from './types';

// THE WEIGHTING, AND THE TWO LIMITS THAT ARE NOT CONFIGURABLE.
export {
  INFERRED_CEILING,
  DEMONSTRATED_MULTIPLE,
  DEFAULT_SOURCE_WEIGHTS,
  BUILT_IN_PROFILE,
  validateSourceWeights,
  weightingSentence,
  demonstratedTotal,
  weightTotal,
  completenessPct,
} from './weights';

export type { SourceWeights, WeightProfile, WeightValidation } from './weights';

// THE PURE CORE. Exported so it can be tested, and so a caller with signals of its own can fuse
// them without a database.
export {
  fuseDimension,
  fuseProfile,
  screenSignal,
  screenAll,
  classPosition,
  agreementOf,
  computeConfidence,
  positionToReading,
  CONTRADICTION_GAP,
  STRONG_AGREEMENT_GAP,
  PARTIAL_AGREEMENT_GAP,
  THIN_COMPLETENESS,
  MIN_INDEPENDENT_SOURCES,
} from './fuse';

export type { FuseInput, PreviousReading, ScreenResult } from './fuse';

// THE SEAM. How patches 03, 04 and 05 reach this engine.
export {
  registerSignalProvider,
  resetSignalProviders,
  signalProviders,
  providerByKey,
  notConnectedProviders,
  gatherSignals,
  checkProviderOutput,
  EXPECTED_PROVIDERS,
  MAX_SIGNALS_PER_PROVIDER,
} from './signals';

export type {
  SignalProvider,
  GatherContext,
  ProviderResult,
  ProviderInput,
  GatherReport,
  ExpectedProvider,
} from './signals';

// THE FIRST-PARTY PROVIDERS this patch reads itself.
export { registerFirstPartyProviders, FIRST_PARTY_PROVIDERS } from './providers';

// THE DATABASE-BACKED ENGINE.
export {
  buildProfile,
  storeSnapshot,
  getWeightProfile,
  saveWeightProfile,
  previousReadings,
  snapshotHistory,
  dimensionTimeline,
  notesFor,
  addNote,
  connectionReport,
  MIN_NOTE_CHARS,
} from './engine';

export type { BuildOptions, SnapshotResult, WeightWriteResult, NoteWriteResult } from './engine';

// SCHEMA.
export { ensureFusionSchema, verifyFusionSchema, FUSION_TABLES } from './schema';
export type { FusionSchemaReport } from './schema';

// ACCESS AND THE ROLE-BASED VIEWS.
export {
  resolveViewer,
  decideAccess,
  logIntelligenceAccess,
  viewFor,
  viewSentence,
  VIEW_KINDS,
  VIEW_LABELS,
  INTELLIGENCE_VIEW_ALL,
  INTELLIGENCE_WEIGHTS,
} from './access';

export type { IntelligenceViewer, AccessDecision, ViewKind, ViewResult } from './access';

// RENDERING.
export {
  FUSION_CSS,
  agreementGlyph,
  directionGlyph,
  statusTone,
  bandTone,
  sourceSentence,
  headline,
  confidenceLine,
  notConnectedSentence,
  foundationNotice,
  sourceLabel,
  GLYPH_ADVISORY,
  GLYPH_ATTRIBUTED,
  GLYPH_LINK,
  GLYPH_NOT_ADMITTED,
} from './render';

export type { Tone } from './render';

// THE HORIZON BRIDGE. Offered, not auto-registered — see the header of horizon-bridge.ts for why.
export {
  fusionSignalsFromHorizon,
  asSectionPayload,
  sourceClassForWeightClass,
  describeMapping,
  WEIGHT_CLASS_TO_SOURCE,
} from './horizon-bridge';

export type { HorizonMapReport } from './horizon-bridge';
