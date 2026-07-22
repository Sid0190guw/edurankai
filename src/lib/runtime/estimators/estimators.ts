// src/lib/runtime/estimators/estimators.ts — Block 04: the non-knowledge estimators.
// All pure and deterministic. The server cannot probe the device/network; these consume
// client-reported signals (or safe mid-tier defaults) — see spec §7.
import type {
  DeviceSignals, DeviceEstimate, DeviceTier, RenderTier,
  NetworkSignals, NetworkEstimate, NetworkTier,
  AccessibilitySignals, AccessibilityEstimate,
  LanguageEstimate, LearningStyleEstimate, Modality,
  CognitiveLoadEstimate, LoadBand,
} from './types';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ---- device ----
export function estimateDevice(s: DeviceSignals): DeviceEstimate {
  const cores = s.cores ?? 4, mem = s.deviceMemoryGb ?? 4, webgl = s.webgl ?? true;
  const tier: DeviceTier = (!webgl || mem < 2 || cores < 2) ? 'low'
    : (mem >= 8 && cores >= 8) ? 'high' : 'mid';
  const maxRender: RenderTier = !webgl ? 'text' : tier === 'low' ? '2d' : '3d';
  return { tier, webgl, cores: s.cores, deviceMemoryGb: s.deviceMemoryGb, maxRender };
}

// ---- network ----
export function estimateNetwork(s: NetworkSignals): NetworkEstimate {
  const et = s.effectiveType;
  const tier: NetworkTier = (et === 'slow-2g' || et === '2g' || (s.downlinkMbps ?? 10) < 1) ? 'slow'
    : (et === '3g' || (s.downlinkMbps ?? 10) < 5) ? 'moderate' : 'fast';
  const assetBudgetKb = s.saveData ? 300 : tier === 'slow' ? 500 : tier === 'moderate' ? 2000 : 8000;
  return { tier, downlinkMbps: s.downlinkMbps, rttMs: s.rttMs, saveData: !!s.saveData, assetBudgetKb };
}

// ---- accessibility ----
export function estimateAccessibility(s: AccessibilitySignals): AccessibilityEstimate {
  const reducedMotion = !!s.reducedMotion, highContrast = !!s.highContrast;
  const screenReader = !!s.screenReader, captions = !!s.captions;
  const variants: string[] = [];
  if (screenReader) variants.push('text-only');
  if (highContrast) variants.push('high-contrast');
  if (reducedMotion) variants.push('reduced-motion');
  if (captions) variants.push('captions');
  return { reducedMotion, highContrast, captions, screenReader, variants };
}

// ---- language ----
export function estimateLanguage(acceptLanguage?: string, prefs?: string[]): LanguageEstimate {
  const fromHeader = (acceptLanguage ?? '').split(',').map((t) => t.split(';')[0].trim()).filter(Boolean);
  const ordered = [...(prefs ?? []), ...fromHeader, 'en'];
  const preferred = ordered[0];
  return { preferred, fallbacks: [...new Set(ordered.slice(1))], needsTranslation: !preferred.startsWith('en') };
}

// ---- learning style (minimal, contested — see spec §7; use for soft ordering only) ----
const MODALITIES: Modality[] = ['visual', 'verbal', 'interactive', 'example'];
export function emptyLearningStyle(): LearningStyleEstimate {
  const w = 1 / MODALITIES.length;
  return { weights: { visual: w, verbal: w, interactive: w, example: w }, dominant: 'visual', confidence: 0 };
}
/** Nudge weights toward `modality` when the learner engaged (EMA α=0.3), renormalize. */
export function updateLearningStyle(prior: LearningStyleEstimate, modality: Modality, engaged: boolean): LearningStyleEstimate {
  const alpha = 0.3;
  const target: Record<Modality, number> = { ...prior.weights };
  for (const m of MODALITIES) {
    const goal = m === modality ? (engaged ? 1 : 0) : prior.weights[m];
    target[m] = (1 - alpha) * prior.weights[m] + alpha * goal;
  }
  const sum = MODALITIES.reduce((a, m) => a + target[m], 0) || 1;
  const weights = { visual: target.visual / sum, verbal: target.verbal / sum, interactive: target.interactive / sum, example: target.example / sum };
  const dominant = MODALITIES.reduce((best, m) => (weights[m] > weights[best] ? m : best), MODALITIES[0]);
  const confidence = clamp01(Math.min(1, (prior.confidence ?? 0) + 0.05));   // grows slowly with observations
  return { weights, dominant, confidence };
}

// ---- cognitive load ----
export function estimateLoad(errorRate: number, latencyRatio: number, hintRate: number): CognitiveLoadEstimate {
  const load = clamp01(0.5 * clamp01(errorRate) + 0.3 * clamp01((latencyRatio - 1) / 2) + 0.2 * clamp01(hintRate));
  const band: LoadBand = load < 0.33 ? 'low' : load <= 0.66 ? 'optimal' : 'high';
  const recommendedNewConcepts = band === 'high' ? 1 : band === 'optimal' ? 2 : 3;
  return { load, band, recommendedNewConcepts };
}
