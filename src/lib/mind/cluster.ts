// src/lib/mind/cluster.ts — the UNSUPERVISED half: structure nobody labelled.
//
// Nothing here is told what a topic is. It is handed the vectors of items learners actually got
// wrong and finds the groups that exist in them — the clusters of questions that fail together.
// Those groups are two useful things at once:
//
//   * a teaching signal — "these eleven questions are one misconception, and nobody wrote that down";
//   * an INPUT to the supervised network (features.ts, cluster slots), so a model that has never
//     seen a particular question still knows which family it belongs to.
//
// Cosine geometry throughout, because the text encoder emits unit vectors. Two implementations,
// deliberately: Lloyd's algorithm for the periodic full pass, and an online version that moves a
// centroid one observation at a time so clusters keep drifting with the platform between passes.

import { mulberry32 } from './nn';

export interface KmeansResult { centroids: number[][]; assignments: number[]; inertia: number; sizes: number[] }

function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a: number[]): number { return Math.sqrt(dot(a, a)) || 1; }
export function normalize(a: number[]): number[] { const n = norm(a); return a.map((x) => x / n); }
/** 1 - cosine similarity, on vectors that may not be unit length. */
export function cosineDistance(a: number[], b: number[]): number { return 1 - dot(a, b) / (norm(a) * norm(b)); }

/** k-means++ seeding — deterministic given the seed, and far better than random starts. */
function seedCentroids(vectors: number[][], k: number, rnd: () => number): number[][] {
  const centroids: number[][] = [vectors[Math.floor(rnd() * vectors.length)].slice()];
  while (centroids.length < k) {
    const d2 = vectors.map((v) => {
      let best = Infinity;
      for (const c of centroids) { const d = cosineDistance(v, c); if (d < best) best = d; }
      return best * best;
    });
    let total = 0; for (const d of d2) total += d;
    if (total <= 0) { centroids.push(vectors[Math.floor(rnd() * vectors.length)].slice()); continue; }
    let r = rnd() * total, i = 0;
    while (i < d2.length - 1 && (r -= d2[i]) > 0) i++;
    centroids.push(vectors[i].slice());
  }
  return centroids;
}

export function kmeans(vectors: number[][], k: number, opts: { iters?: number; seed?: number } = {}): KmeansResult {
  const iters = opts.iters ?? 25;
  const rnd = mulberry32(opts.seed ?? 7);
  const kk = Math.max(1, Math.min(k, vectors.length));
  if (!vectors.length) return { centroids: [], assignments: [], inertia: 0, sizes: [] };

  let centroids = seedCentroids(vectors, kk, rnd);
  let assignments = new Array(vectors.length).fill(0);

  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) { const d = cosineDistance(vectors[i], centroids[c]); if (d < bestD) { bestD = d; best = c; } }
      if (assignments[i] !== best) { assignments[i] = best; moved = true; }
    }
    const sums = centroids.map(() => new Array(vectors[0].length).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const a = assignments[i]; counts[a]++;
      const s = sums[a], v = vectors[i];
      for (let d = 0; d < v.length; d++) s[d] += v[d];
    }
    centroids = sums.map((s, c) => (counts[c] ? normalize(s.map((x) => x / counts[c])) : centroids[c]));
    if (!moved && it > 0) break;
  }

  let inertia = 0;
  const sizes = new Array(centroids.length).fill(0);
  for (let i = 0; i < vectors.length; i++) { inertia += cosineDistance(vectors[i], centroids[assignments[i]]); sizes[assignments[i]]++; }
  return { centroids, assignments, inertia: +inertia.toFixed(6), sizes };
}

export class OnlineKMeans {
  centroids: number[][];
  counts: number[];
  constructor(centroids: number[][], counts?: number[]) {
    this.centroids = centroids.map((c) => c.slice());
    this.counts = counts && counts.length === centroids.length ? counts.slice() : new Array(centroids.length).fill(0);
  }

  get k(): number { return this.centroids.length; }

  nearest(v: number[]): { index: number; distance: number } {
    let index = -1, distance = Infinity;
    for (let c = 0; c < this.centroids.length; c++) { const d = cosineDistance(v, this.centroids[c]); if (d < distance) { distance = d; index = c; } }
    return { index, distance };
  }

  /** One streaming update: assign, then pull that centroid a little towards the point. */
  learn(v: number[]): number {
    if (!this.centroids.length) return -1;
    const { index } = this.nearest(v);
    this.counts[index]++;
    const lr = Math.max(0.02, 1 / this.counts[index]);   // decaying rate, floored so clusters keep drifting
    const c = this.centroids[index];
    for (let d = 0; d < c.length; d++) c[d] += lr * (v[d] - c[d]);
    this.centroids[index] = normalize(c);
    return index;
  }

  /** Cluster membership as network input. Zeros when there are no clusters yet. */
  oneHot(v: number[], slots: number): number[] {
    const out = new Array(slots).fill(0);
    if (!this.centroids.length) return out;
    const { index } = this.nearest(v);
    if (index >= 0 && index < slots) out[index] = 1;
    return out;
  }

  /**
   * How unlike anything already known this is, 0..1. High novelty on a stream of learner questions
   * is the platform noticing a subject it has no shape for yet — worth an administrator's attention,
   * which is why it is surfaced rather than kept internal.
   */
  novelty(v: number[]): number {
    if (!this.centroids.length) return 1;
    const { distance } = this.nearest(v);
    return Math.max(0, Math.min(1, distance));
  }

  toJSON(): any { return { v: 1, centroids: this.centroids, counts: this.counts }; }
  static fromJSON(j: any): OnlineKMeans { return new OnlineKMeans(j?.centroids || [], j?.counts || []); }
}

/** Pick k by the elbow of the inertia curve, bounded — so nobody has to guess a number by hand. */
export function chooseK(vectors: number[][], maxK = 8, seed = 7): number {
  if (vectors.length < 8) return Math.max(1, Math.min(2, vectors.length));
  const upper = Math.max(2, Math.min(maxK, Math.floor(Math.sqrt(vectors.length))));
  let bestK = 2, bestScore = -Infinity, prev = kmeans(vectors, 1, { seed }).inertia;
  for (let k = 2; k <= upper; k++) {
    const r = kmeans(vectors, k, { seed });
    const gain = (prev - r.inertia) / Math.max(1e-9, prev);   // relative drop for one more cluster
    const score = gain - 0.03 * k;                            // penalise complexity, mildly
    if (score > bestScore) { bestScore = score; bestK = k; }
    prev = r.inertia;
  }
  return bestK;
}
