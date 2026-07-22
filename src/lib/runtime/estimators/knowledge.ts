// src/lib/runtime/estimators/knowledge.ts — Block 04: Bayesian Knowledge Tracing (BKT).
// An online recursive filter: each observation updates the posterior P(L) without replaying
// history, so only the posterior is persisted (serverless-friendly).
import type { ConceptMastery } from './types';

export interface BktParams { pL: number; pT: number; pG: number; pS: number; }
export const DEFAULT_BKT: BktParams = { pL: 0.20, pT: 0.15, pG: 0.20, pS: 0.10 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function initMastery(now: string, params: Partial<BktParams> = {}): ConceptMastery {
  // identifiability guard: keep guess/slip < 0.5 so G + S < 1 (BKT degenerates otherwise).
  const pG = Math.min(0.49, params.pG ?? DEFAULT_BKT.pG);
  const pS = Math.min(0.49, params.pS ?? DEFAULT_BKT.pS);
  return {
    pL: clamp01(params.pL ?? DEFAULT_BKT.pL),
    pT: clamp01(params.pT ?? DEFAULT_BKT.pT),
    pG, pS, attempts: 0, updatedAt: now,
  };
}

/** Condition on the observation (Bayes) then apply the learning transit. */
export function bktUpdate(m: ConceptMastery, correct: boolean, now: string): ConceptMastery {
  const { pL, pT, pG, pS } = m;
  const num = correct ? pL * (1 - pS) : pL * pS;
  const den = correct ? pL * (1 - pS) + (1 - pL) * pG
                      : pL * pS + (1 - pL) * (1 - pG);
  const posterior = den > 0 ? num / den : pL;            // guard degenerate params
  const pLnext = posterior + (1 - posterior) * pT;       // learning step
  return { ...m, pL: clamp01(pLnext), attempts: m.attempts + 1, lastCorrect: correct, updatedAt: now };
}

/** P(correct on the next attempt). */
export function bktPredictCorrect(m: ConceptMastery): number {
  return clamp01(m.pL * (1 - m.pS) + (1 - m.pL) * m.pG);
}

export function isMastered(m: ConceptMastery, threshold = 0.95): boolean {
  return m.pL >= threshold;
}
