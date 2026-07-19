// src/lib/runtime/estimators/types.ts — Block 04: learner-state estimation types.
// This module is self-contained and namespaced; it does NOT reuse edu-runtime.ts's render
// types (RenderTier there is 'lite'|'standard'|'rich' for the lesson pipeline). Reconciling
// the two render vocabularies is a follow-up (Block 03/05), noted in the spec §7.
import type { LearningMetadata } from '@/lib/kernel';

// ---- Knowledge / BKT ----
export interface ConceptMastery {
  pL: number;            // P(L_t): posterior probability the learner knows the concept, 0..1
  pT: number;            // P(T): transit — prob. of learning between opportunities
  pG: number;            // P(G): guess — prob. correct while NOT knowing
  pS: number;            // P(S): slip  — prob. incorrect while knowing
  attempts: number;
  lastCorrect?: boolean;
  updatedAt: string;     // ISO
}
export type MasteryMap = Record<string, ConceptMastery>; // conceptObjectId -> mastery

// ---- Non-knowledge estimators ----
export type DeviceTier = 'low' | 'mid' | 'high';
export type RenderTier = '3d' | '2d' | 'text';
export interface DeviceEstimate {
  tier: DeviceTier;
  webgl: boolean;
  cores?: number;
  deviceMemoryGb?: number;
  maxRender: RenderTier;
}

export type NetworkTier = 'slow' | 'moderate' | 'fast';
export interface NetworkEstimate {
  tier: NetworkTier;
  downlinkMbps?: number;
  rttMs?: number;
  saveData: boolean;
  assetBudgetKb: number;
}

export interface AccessibilityEstimate {
  reducedMotion: boolean;
  highContrast: boolean;
  captions: boolean;
  screenReader: boolean;
  variants: string[];
}

export interface LanguageEstimate {
  preferred: string;       // BCP-47
  fallbacks: string[];
  needsTranslation: boolean;
}

export type Modality = 'visual' | 'verbal' | 'interactive' | 'example';
export interface LearningStyleEstimate {
  weights: Record<Modality, number>;
  dominant: Modality;
  confidence: number;      // 0..1
}

export type LoadBand = 'low' | 'optimal' | 'high';
export interface CognitiveLoadEstimate {
  load: number;            // 0..1
  band: LoadBand;
  recommendedNewConcepts: number;
}

export interface LearnerState {
  schemaVersion: 1;
  mastery: MasteryMap;
  language: LanguageEstimate;
  device: DeviceEstimate;
  network: NetworkEstimate;
  accessibility: AccessibilityEstimate;
  learningStyle: LearningStyleEstimate;
  cognitiveLoad: CognitiveLoadEstimate;
  updatedAt: string;
}

export interface StudentLearningMetadata extends LearningMetadata {
  learnerState?: LearnerState;
}

export interface Estimator<In, Out> {
  readonly name: string;
  estimate(input: In, prior?: Out): Out;
}

// ---- raw client-reported signals ----
export interface DeviceSignals { cores?: number; deviceMemoryGb?: number; webgl?: boolean; userAgent?: string; }
export interface NetworkSignals { effectiveType?: '2g' | '3g' | '4g' | 'slow-2g'; downlinkMbps?: number; rttMs?: number; saveData?: boolean; }
export interface AccessibilitySignals { reducedMotion?: boolean; highContrast?: boolean; screenReader?: boolean; captions?: boolean; }
export interface ObservationSignal {
  conceptId: string;
  correct: boolean;
  responseMs?: number;
  hintsUsed?: number;
  modality?: Modality;
}
