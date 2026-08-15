// src/lib/mind/evaluate.ts — the part that is allowed to say no.
//
// A model that trains is not a model that helps. Everything here exists so that "the network is
// better" is a measured claim about data the network never saw, and so that a checkpoint which
// cannot support that claim never reaches a learner.
//
// Three predictions are scored on the same held-out rows every cycle:
//   baseline   — what the platform already answers with (BKT / population miss rate)
//   champion   — the checkpoint currently serving, if any
//   candidate  — the one just trained
//
// The candidate has to beat BOTH, by a margin, on enough rows, and be calibrated enough to be worth
// showing a person, or it is recorded and shelved. That is the whole promotion rule, and it is the
// reason this system can be switched on without anybody having to take its word for anything.

export interface Metrics {
  n: number;
  logLoss: number;
  accuracy: number;
  auc: number;
  brier: number;
  /** Expected calibration error: when it says 70%, how often is it right? */
  ece: number;
  positiveRate: number;
}

const EPS = 1e-9;
const clamp01 = (x: number) => (x < EPS ? EPS : x > 1 - EPS ? 1 - EPS : x);

export const EMPTY_METRICS: Metrics = { n: 0, logLoss: 0, accuracy: 0, auc: 0.5, brier: 0, ece: 0, positiveRate: 0 };

/** Deterministic train/holdout split by id — the same row lands in the same side on every run. */
export function isHoldout(id: string, fraction = 0.25): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 1000) / 1000 < fraction;
}

/** Rank-based AUC (Mann-Whitney U), ties averaged. 0.5 = no better than a coin. */
export function auc(preds: number[], labels: number[]): number {
  const pos = labels.reduce((s, y) => s + (y >= 0.5 ? 1 : 0), 0);
  const neg = labels.length - pos;
  if (!pos || !neg) return 0.5;
  const idx = preds.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => a.p - b.p);
  const ranks = new Array(idx.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].p === idx[i].p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < idx.length; k++) if (idx[k].y >= 0.5) sumPos += ranks[k];
  return +(((sumPos - (pos * (pos + 1)) / 2) / (pos * neg))).toFixed(4);
}

export function evaluateBinary(preds: number[], labels: number[], bins = 10): Metrics {
  const n = Math.min(preds.length, labels.length);
  if (!n) return { ...EMPTY_METRICS };
  let ll = 0, correct = 0, brier = 0, positives = 0;
  const binSum = new Array(bins).fill(0), binHit = new Array(bins).fill(0), binN = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const p = clamp01(preds[i]);
    const y = labels[i] >= 0.5 ? 1 : 0;
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    correct += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) * (p - y);
    positives += y;
    const b = Math.min(bins - 1, Math.floor(p * bins));
    binSum[b] += p; binHit[b] += y; binN[b]++;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) if (binN[b]) ece += (binN[b] / n) * Math.abs(binSum[b] / binN[b] - binHit[b] / binN[b]);
  return {
    n,
    logLoss: +(ll / n).toFixed(5),
    accuracy: +(correct / n).toFixed(4),
    auc: auc(preds.slice(0, n), labels.slice(0, n)),
    brier: +(brier / n).toFixed(5),
    ece: +ece.toFixed(4),
    positiveRate: +(positives / n).toFixed(4),
  };
}

/** Multi-class: accuracy + cross-entropy over one-hot targets. */
export function evaluateMulti(preds: number[][], labels: number[][]): Metrics {
  const n = Math.min(preds.length, labels.length);
  if (!n) return { ...EMPTY_METRICS };
  let ll = 0, correct = 0;
  for (let i = 0; i < n; i++) {
    let top = 0, gold = 0;
    for (let c = 0; c < preds[i].length; c++) {
      if (preds[i][c] > preds[i][top]) top = c;
      if (labels[i][c] > labels[i][gold]) gold = c;
      ll += -labels[i][c] * Math.log(clamp01(preds[i][c]));
    }
    if (top === gold) correct++;
  }
  return { ...EMPTY_METRICS, n, logLoss: +(ll / n).toFixed(5), accuracy: +(correct / n).toFixed(4), auc: 0.5 };
}

export interface PromotionDecision { promote: boolean; reason: string; deltaVsBaseline: number; deltaVsChampion: number | null }

export interface PromotionInput {
  candidate: Metrics;
  champion: Metrics | null;
  baseline: Metrics;
  /** Held-out rows required before any promotion is considered. */
  minHoldout?: number;
  /** Relative log-loss improvement required over the incumbent. */
  minImprovement?: number;
  /** Calibration ceiling — a model whose stated confidence is wrong is not shown to a learner. */
  maxEce?: number;
}

export function shouldPromote(i: PromotionInput): PromotionDecision {
  const minHoldout = i.minHoldout ?? 60;
  const minImprovement = i.minImprovement ?? 0.02;
  const maxEce = i.maxEce ?? 0.15;
  const dBase = i.baseline.logLoss > 0 ? +(1 - i.candidate.logLoss / i.baseline.logLoss).toFixed(4) : 0;
  const dChamp = i.champion && i.champion.logLoss > 0 ? +(1 - i.candidate.logLoss / i.champion.logLoss).toFixed(4) : null;
  const base = { deltaVsBaseline: dBase, deltaVsChampion: dChamp };

  if (i.candidate.n < minHoldout) {
    return { promote: false, reason: 'Held out only ' + i.candidate.n + ' answers; ' + minHoldout + ' are needed before a model may serve anybody.', ...base };
  }
  if (dBase < minImprovement) {
    return { promote: false, reason: 'No better than the existing estimator (' + (dBase * 100).toFixed(1) + '% vs the ' + (minImprovement * 100).toFixed(0) + '% required). Kept as a candidate; the platform keeps answering the way it already does.', ...base };
  }
  if (dChamp !== null && dChamp < minImprovement / 2) {
    return { promote: false, reason: 'Does not beat the checkpoint already serving (' + (dChamp * 100).toFixed(1) + '%). Kept as a candidate.', ...base };
  }
  if (i.candidate.ece > maxEce) {
    return { promote: false, reason: 'Poorly calibrated (error ' + (i.candidate.ece * 100).toFixed(1) + '%): its stated confidence would mislead. Kept as a candidate.', ...base };
  }
  return {
    promote: true,
    reason: 'Beats the existing estimator by ' + (dBase * 100).toFixed(1) + '%'
      + (dChamp !== null ? ' and the serving checkpoint by ' + (dChamp * 100).toFixed(1) + '%' : '')
      + ' on ' + i.candidate.n + ' held-out answers.',
    ...base,
  };
}
