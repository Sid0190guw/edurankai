// src/lib/mind/semisup.ts — the SEMI-SUPERVISED half: learning from what nobody graded.
//
// Most of what happens on a learning platform carries no label. A learner opens a lesson, types a
// question into the tutor, abandons a page. Supervised learning throws all of it away; there is far
// more of it than there is of the graded kind.
//
// Two honest ways to use it, both here:
//
//   SELF-TRAINING — the model labels the unlabelled examples it is already confident about, and
//   trains on those with a REDUCED weight. The danger is well known: a model that trains on its own
//   guesses can drift into confidently believing itself. Three guards, all enforced below — a high
//   confidence floor, a cap on how much pseudo-labelled data may enter one cycle, and a weight below
//   one so a real graded answer always outvotes a guess. And the promotion gate in evaluate.ts scores
//   the result on HUMAN-labelled held-out data only, so self-training that hurts is never shipped.
//
//   LABEL PROPAGATION — a concept nobody has attempted still sits in the prerequisite graph next to
//   concepts people have. Difficulty spreads along those edges: if everything leading into a concept
//   is hard, the platform can hold a prior about it before the first learner arrives. Confidence
//   decays per hop and is reported, because an inference three hops from evidence must not read the
//   same as a measurement.

export interface Unlabeled { id: string; x: number[] }
export interface PseudoLabeled { id: string; x: number[]; y: number[]; w: number; confidence: number }

export interface PseudoOptions {
  /** Minimum distance from 0.5 (binary) or top-class probability (multi-class) to accept a guess. */
  threshold?: number;
  /** Hard cap on pseudo-labelled examples admitted in one cycle. */
  max?: number;
  /** Weight ceiling for an accepted guess. Always below 1: a graded answer must outweigh a guess. */
  maxWeight?: number;
}

/** Self-training for the binary head. */
export function pseudoLabelBinary(items: Unlabeled[], predict: (x: number[]) => number, opts: PseudoOptions = {}): PseudoLabeled[] {
  const threshold = opts.threshold ?? 0.85;
  const max = opts.max ?? 2000;
  const maxWeight = Math.min(0.9, opts.maxWeight ?? 0.5);
  const out: PseudoLabeled[] = [];
  for (const it of items) {
    const p = predict(it.x);
    const confidence = Math.max(p, 1 - p);
    if (confidence < threshold) continue;
    out.push({ id: it.id, x: it.x, y: [p >= 0.5 ? 1 : 0], w: +(maxWeight * ((confidence - threshold) / (1 - threshold))).toFixed(4), confidence: +confidence.toFixed(4) });
  }
  // Keep the most confident when there are more than the cap allows.
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, max);
}

/** Self-training for the multi-class head. */
export function pseudoLabelMulti(items: Unlabeled[], predict: (x: number[]) => number[], classes: number, opts: PseudoOptions = {}): PseudoLabeled[] {
  const threshold = opts.threshold ?? 0.8;
  const max = opts.max ?? 2000;
  const maxWeight = Math.min(0.9, opts.maxWeight ?? 0.5);
  const out: PseudoLabeled[] = [];
  for (const it of items) {
    const p = predict(it.x);
    let top = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[top]) top = i;
    const confidence = p[top];
    if (confidence < threshold) continue;
    const y = new Array(classes).fill(0); y[top] = 1;
    out.push({ id: it.id, x: it.x, y, w: +(maxWeight * ((confidence - threshold) / (1 - threshold))).toFixed(4), confidence: +confidence.toFixed(4) });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, max);
}

// ---- label propagation over the concept graph ---------------------------------------------------

export interface PropEdge { from: string; to: string }
export interface Propagated { value: number; confidence: number; observed: boolean }

/**
 * Spread observed values across an undirected view of the prerequisite graph.
 *
 * Seeds are clamped (an observation is never overwritten by an inference). Everything else is the
 * damped average of its neighbours, iterated to convergence. Confidence is the share of a node's
 * neighbourhood that traces back to real observation, so a caller can refuse to act on a thin one.
 */
export function propagateLabels(
  nodes: string[], edges: PropEdge[], seeds: Record<string, number>, opts: { iterations?: number; damping?: number } = {},
): Record<string, Propagated> {
  const iterations = opts.iterations ?? 20;
  const damping = opts.damping ?? 0.85;
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  for (const n of nodes) touch(n);
  for (const e of edges) { touch(e.from); touch(e.to); adj.get(e.from)!.push(e.to); adj.get(e.to)!.push(e.from); }

  const all = [...adj.keys()];
  const value = new Map<string, number>();
  const conf = new Map<string, number>();
  const mean = Object.keys(seeds).length ? Object.values(seeds).reduce((a, b) => a + b, 0) / Object.keys(seeds).length : 0.5;
  for (const n of all) {
    const seeded = Object.prototype.hasOwnProperty.call(seeds, n);
    value.set(n, seeded ? seeds[n] : mean);
    conf.set(n, seeded ? 1 : 0);
  }

  for (let it = 0; it < iterations; it++) {
    const nextV = new Map(value), nextC = new Map(conf);
    for (const n of all) {
      if (Object.prototype.hasOwnProperty.call(seeds, n)) continue;   // clamp observations
      const nb = adj.get(n)!;
      if (!nb.length) continue;
      let sv = 0, sc = 0;
      for (const m of nb) { sv += value.get(m)!; sc += conf.get(m)!; }
      nextV.set(n, damping * (sv / nb.length) + (1 - damping) * mean);
      nextC.set(n, damping * (sc / nb.length));
    }
    for (const n of all) { value.set(n, nextV.get(n)!); conf.set(n, nextC.get(n)!); }
  }

  const out: Record<string, Propagated> = {};
  for (const n of all) {
    out[n] = {
      value: +value.get(n)!.toFixed(4),
      confidence: +Math.max(0, Math.min(1, conf.get(n)!)).toFixed(4),
      observed: Object.prototype.hasOwnProperty.call(seeds, n),
    };
  }
  return out;
}
