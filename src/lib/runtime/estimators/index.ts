// src/lib/runtime/estimators/index.ts — Block 04: learner-state orchestrator + lesson-build
// hand-off. Loads posterior state, applies one observation or a signal batch, persists, and
// selects the next prerequisite-unblocked concepts.
export * from './types';
export * from './knowledge';
export * from './estimators';
export * from './persistence';

import type { KernelRepository } from '@/lib/kernel';
import type {
  ObservationSignal, ConceptMastery, CognitiveLoadEstimate, LearnerState, LoadBand,
  DeviceSignals, NetworkSignals, AccessibilitySignals,
} from './types';
import { initMastery, bktUpdate, bktPredictCorrect, isMastered } from './knowledge';
import { estimateDevice, estimateNetwork, estimateAccessibility, estimateLanguage, estimateLoad, updateLearningStyle } from './estimators';
import { loadLearnerState, saveLearnerState } from './persistence';

const EXPECTED_RESPONSE_MS = 15000;   // heuristic baseline until per-difficulty timing exists (spec §7)

function cognitiveLoadFromValue(load: number): CognitiveLoadEstimate {
  const band: LoadBand = load < 0.33 ? 'low' : load <= 0.66 ? 'optimal' : 'high';
  const recommendedNewConcepts = band === 'high' ? 1 : band === 'optimal' ? 2 : 3;
  return { load, band, recommendedNewConcepts };
}

/** Apply one attempt: BKT update + EMA cognitive-load + learning-style nudge; persist. */
export async function applyObservation(
  kernel: KernelRepository, studentObjectId: string, o: ObservationSignal,
): Promise<{ mastery: ConceptMastery; predictedCorrect: number; cognitiveLoad: CognitiveLoadEstimate }> {
  const state = await loadLearnerState(kernel, studentObjectId);
  const now = new Date().toISOString();

  const prior = state.mastery[o.conceptId] ?? initMastery(now);
  const mastery = bktUpdate(prior, o.correct, now);
  state.mastery[o.conceptId] = mastery;

  // per-attempt cognitive load, EMA-blended into the running value (α=0.3).
  const errorRate = o.correct ? 0 : 1;
  const latencyRatio = (o.responseMs ?? EXPECTED_RESPONSE_MS) / EXPECTED_RESPONSE_MS;
  const hintRate = Math.min(1, (o.hintsUsed ?? 0) / 3);
  const inst = estimateLoad(errorRate, latencyRatio, hintRate);
  const blended = 0.7 * state.cognitiveLoad.load + 0.3 * inst.load;
  const cognitiveLoad = cognitiveLoadFromValue(blended);
  state.cognitiveLoad = cognitiveLoad;

  if (o.modality) state.learningStyle = updateLearningStyle(state.learningStyle, o.modality, o.correct);

  await saveLearnerState(kernel, studentObjectId, state);
  return { mastery, predictedCorrect: bktPredictCorrect(mastery), cognitiveLoad };
}

/** Apply a batch of environment signals (device/network/accessibility/language); persist. */
export async function applySignals(
  kernel: KernelRepository, studentObjectId: string,
  input: { acceptLanguage?: string; device?: DeviceSignals; network?: NetworkSignals; accessibility?: AccessibilitySignals; languagePrefs?: string[] },
): Promise<LearnerState> {
  const state = await loadLearnerState(kernel, studentObjectId);
  if (input.acceptLanguage !== undefined || input.languagePrefs !== undefined) {
    state.language = estimateLanguage(input.acceptLanguage, input.languagePrefs);
  }
  if (input.device) state.device = estimateDevice(input.device);
  if (input.network) state.network = estimateNetwork(input.network);
  if (input.accessibility) state.accessibility = estimateAccessibility(input.accessibility);
  await saveLearnerState(kernel, studentObjectId, state);
  return state;
}

/** Next concepts to teach: unlearned, all direct prerequisites mastered, widest gap first,
 *  capped by the current cognitive-load pacing hint. */
export async function selectNextConcepts(
  kernel: KernelRepository, studentObjectId: string, courseConceptIds: string[], limit = 3,
): Promise<string[]> {
  const state = await loadLearnerState(kernel, studentObjectId);
  const now = new Date().toISOString();
  const mastered = (id: string) => isMastered(state.mastery[id] ?? initMastery(now));

  const eligible: { id: string; gap: number }[] = [];
  for (const c of courseConceptIds) {
    const m = state.mastery[c] ?? initMastery(now);
    if (isMastered(m)) continue;
    const graph = await kernel.getObjectGraph(c);
    const prereqIds = graph.incoming.filter((e) => e.type === 'prerequisite_of').map((e) => e.fromId);
    if (prereqIds.every(mastered)) eligible.push({ id: c, gap: 1 - m.pL });
  }
  eligible.sort((a, b) => b.gap - a.gap);
  const cap = Math.min(limit, state.cognitiveLoad.recommendedNewConcepts);
  return eligible.slice(0, cap).map((e) => e.id);
}
