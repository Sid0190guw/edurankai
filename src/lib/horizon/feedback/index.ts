// src/lib/horizon/feedback/index.ts — PATCH 05's public surface, in one import.
//
// A CONSUMER IMPORTS FROM HERE, NOT FROM THE FILES BEHIND IT. That is what makes the internals
// movable: read.ts could be rewritten tomorrow and nothing outside this directory would notice.
//
// WHAT IS DELIBERATELY NOT RE-EXPORTED: nothing from read.ts except the types, because a consumer
// that can call readStructuredItems() can read hr_channel items without going through the view
// resolution in contract.ts — which is the whole of the confidentiality model. The surfaces inside
// this patch import read.ts directly; everybody else uses getFeedbackSignal().
export {
  FEEDBACK_SOURCE_TYPES,
  FEEDBACK_SOURCE_LABELS,
  FEEDBACK_SOURCE_WEIGHT_REASONS,
  FEEDBACK_DIMENSIONS,
  FEEDBACK_DIMENSION_META,
  FEEDBACK_CONTEXTS,
  FEEDBACK_CONTEXT_LABELS,
  PRESSURE_RELEVANT_CONTEXTS,
  FEEDBACK_CONFIDENTIALITY,
  FEEDBACK_CONFIDENTIALITY_LABELS,
  EVIDENCE_QUALITIES,
  EVIDENCE_QUALITY_LABELS,
  FEEDBACK_ITEM_STATUSES,
  CONFIDENCE_BAND_LABELS,
  FEEDBACK_DECISION_NOTICE,
  isFeedbackDimension,
  isFeedbackSourceType,
  type FeedbackSourceType,
  type FeedbackDimension,
  type FeedbackContext,
  type FeedbackConfidentiality,
  type FeedbackItemStatus,
  type EvidenceQuality,
  type DimensionRating,
  type FeedbackExample,
  type FeedbackItem,
  type Explanation,
  type ConfidenceBand,
  type Contribution,
  type DisagreementKind,
  type DimensionAggregate,
  type FeedbackSignalFlag,
  type FeedbackSignal,
} from './types';

export {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PURPOSES,
  FEEDBACK_PURPOSE_LABELS,
  getFeedbackSignal,
  getFeedbackSignals,
  onFeedbackRecorded,
  emitFeedbackRecorded,
  type FeedbackPurpose,
  type FeedbackSignalEnvelope,
  type FeedbackRecordedEvent,
} from './contract';

export {
  FEEDBACK_VIEW_LABELS,
  VIEW_RIGHTS,
  viewNotice,
  resolveFeedbackView,
  type FeedbackView,
  type ViewRights,
} from './visibility';

export { ensureHorizonFeedbackSchema } from './schema';
