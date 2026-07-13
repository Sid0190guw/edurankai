// src/lib/irt.ts — Item Response Theory helpers for adaptive practice selection.
// Pure functions, no browser globals; the server-side twin of public/aquin-irt.js.
// Used by /api/aquintutor/practice/start to turn a learner's real answer history
// into an ability estimate (theta) and choose questions by maximum information.
//
// We only store an *empirical difficulty* per question (0..1 = population miss rate,
// in `question_stats.empirical_difficulty`). That maps to the IRT difficulty scale
// b via the logit: b = ln(p / (1 - p)). A learner's ability theta lives on the same
// scale, so the most *informative* next question is the one whose b is closest to
// theta — which in miss-rate space is an empirical difficulty of logistic(theta).

export interface IrtResponse { correct: boolean; b: number; a?: number }

export function logistic(x: number): number { return 1 / (1 + Math.exp(-x)); }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/** map an empirical difficulty (0..1 miss rate) to the IRT b scale (logit). */
export function empToB(emp: number): number {
  const p = clamp(emp, 0.02, 0.98);
  return Math.log(p / (1 - p));
}
/** inverse: an IRT b back to the 0..1 empirical-difficulty scale. */
export function bToEmp(b: number): number { return logistic(b); }

/** 2PL probability of a correct response at ability theta for item (a,b). */
export function p2pl(theta: number, a: number, b: number): number { return logistic(a * (theta - b)); }

/** Fisher information an item (a,b) gives at ability theta. Peaks when b === theta. */
export function itemInfo(theta: number, a: number, b: number): number {
  const p = p2pl(theta, a, b);
  return a * a * p * (1 - p);
}

/**
 * Maximum-likelihood ability estimate from a learner's responses, via
 * Newton-Raphson. All-correct / all-incorrect have no finite MLE, so we return a
 * sensibly bounded estimate for those.
 */
export function estimateAbility(responses: IrtResponse[], start = 0): { theta: number; se: number | null; bounded?: boolean } {
  if (!responses.length) return { theta: 0, se: null, bounded: true };
  const nc = responses.filter(r => r.correct).length;
  if (nc === 0) return { theta: -3, se: null, bounded: true };
  if (nc === responses.length) return { theta: 3, se: null, bounded: true };

  let theta = start;
  for (let iter = 0; iter < 60; iter++) {
    let d1 = 0, d2 = 0;
    for (const r of responses) {
      const a = r.a ?? 1;
      const p = p2pl(theta, a, r.b);
      d1 += a * ((r.correct ? 1 : 0) - p);
      d2 -= a * a * p * (1 - p);
    }
    if (Math.abs(d2) < 1e-12) break;
    const step = d1 / d2;
    theta = clamp(theta - step, -5, 5);
    if (Math.abs(step) < 1e-6) break;
  }
  const info = responses.reduce((s, r) => s + itemInfo(theta, r.a ?? 1, r.b), 0);
  return { theta: +theta.toFixed(4), se: info > 0 ? +(1 / Math.sqrt(info)).toFixed(4) : null };
}

/**
 * The empirical difficulty (0..1) a learner should be served next: the one that is
 * MAXIMALLY INFORMATIVE at their estimated ability. For the 2PL that is simply the
 * item whose difficulty matches ability (b = theta), i.e. logistic(theta). Clamped
 * to keep it stretching-but-reachable, matching the existing endpoint's bounds.
 */
export function targetDifficultyFromHistory(
  history: Array<{ correct: boolean; emp: number }>,
  opts: { min?: number; max?: number } = {},
): { targetDifficulty: number; theta: number | null; se: number | null } {
  const min = opts.min ?? 0.2, max = opts.max ?? 0.85;
  if (!history.length) return { targetDifficulty: 0.5, theta: null, se: null };
  const responses: IrtResponse[] = history.map(h => ({ correct: h.correct, b: empToB(h.emp) }));
  const { theta, se } = estimateAbility(responses);
  const target = clamp(bToEmp(theta), min, max);
  return { targetDifficulty: +target.toFixed(4), theta, se };
}
