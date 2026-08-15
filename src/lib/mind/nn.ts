// src/lib/mind/nn.ts — the neural network itself. Written here, owned here, no dependency.
//
// A dense feed-forward network with ReLU hidden layers, a sigmoid (binary) or softmax
// (multi-class) head, cross-entropy loss, Adam, L2 and per-example weights. Everything is
// plain arrays of numbers, so a trained model serialises to JSON and lives in Postgres —
// which is what makes AquinTutor's intelligence PORTABLE: no runtime, no service, no vendor.
//
// Why hand-written rather than a library: the sovereignty rule. A model this size (a few
// thousand parameters) trains in well under a second inside a normal request, so the platform
// can keep learning while it serves instead of waiting for a training cluster it does not own.
//
// Determinism is deliberate. The initialiser and the shuffle both run off a seeded PRNG, so the
// same data and the same seed produce the same model — otherwise "the new checkpoint is better"
// could never be told apart from "we got a luckier random start".

export type OutputKind = 'sigmoid' | 'softmax';

export interface MlpSpec {
  sizes: number[];          // [inputDim, ...hidden, outputDim]
  output: OutputKind;
  seed?: number;
  l2?: number;
}

export interface Example { x: number[]; y: number[]; w?: number }

export interface FitOptions {
  epochs?: number;
  batchSize?: number;
  lr?: number;
  seed?: number;
  /** Wall-clock ceiling. Training runs inside a request here; it must never be the reason a page hangs. */
  maxMs?: number;
  onEpoch?: (epoch: number, loss: number) => void;
}

export interface FitResult { epochs: number; loss: number; history: number[]; stoppedEarly: boolean }

/** Small, fast, seedable PRNG (mulberry32). Deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPS = 1e-9;
function clamp01(x: number): number { return x < EPS ? EPS : x > 1 - EPS ? 1 - EPS : x; }

export class MLP {
  readonly sizes: number[];
  readonly output: OutputKind;
  readonly l2: number;
  readonly seed: number;
  /** W[layer][out][in] */
  W: number[][][] = [];
  B: number[][] = [];
  // Adam moments, parallel to W/B.
  private mW: number[][][] = []; private vW: number[][][] = [];
  private mB: number[][] = []; private vB: number[][] = [];
  private t = 0;

  constructor(spec: MlpSpec) {
    if (!spec.sizes || spec.sizes.length < 2) throw new Error('MLP needs at least an input and an output layer');
    this.sizes = spec.sizes.slice();
    this.output = spec.output;
    this.l2 = spec.l2 ?? 1e-4;
    this.seed = spec.seed ?? 12345;
    const rnd = mulberry32(this.seed);
    for (let l = 1; l < this.sizes.length; l++) {
      const nIn = this.sizes[l - 1], nOut = this.sizes[l];
      // He initialisation for the ReLU layers, Xavier for the output layer.
      const scale = l < this.sizes.length - 1 ? Math.sqrt(2 / nIn) : Math.sqrt(1 / nIn);
      const w: number[][] = [], mw: number[][] = [], vw: number[][] = [];
      for (let o = 0; o < nOut; o++) {
        const row: number[] = [], mrow: number[] = [], vrow: number[] = [];
        for (let i = 0; i < nIn; i++) {
          // Box-Muller for a normal draw; a uniform init trains measurably worse here.
          const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
          const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          row.push(g * scale); mrow.push(0); vrow.push(0);
        }
        w.push(row); mw.push(mrow); vw.push(vrow);
      }
      this.W.push(w); this.mW.push(mw); this.vW.push(vw);
      this.B.push(new Array(nOut).fill(0));
      this.mB.push(new Array(nOut).fill(0));
      this.vB.push(new Array(nOut).fill(0));
    }
  }

  get inputDim(): number { return this.sizes[0]; }
  get outputDim(): number { return this.sizes[this.sizes.length - 1]; }
  get params(): number {
    let n = 0;
    for (let l = 0; l < this.W.length; l++) n += this.W[l].length * this.W[l][0].length + this.B[l].length;
    return n;
  }

  /** Full forward pass. Returns the activation of every layer (a[0] is the input). */
  forwardAll(x: number[]): number[][] {
    if (x.length !== this.inputDim) throw new Error('input dim ' + x.length + ' != ' + this.inputDim);
    const acts: number[][] = [x];
    let a = x;
    for (let l = 0; l < this.W.length; l++) {
      const last = l === this.W.length - 1;
      const z: number[] = new Array(this.W[l].length);
      for (let o = 0; o < this.W[l].length; o++) {
        const row = this.W[l][o];
        let s = this.B[l][o];
        for (let i = 0; i < row.length; i++) s += row[i] * a[i];
        z[o] = s;
      }
      let out: number[];
      if (!last) out = z.map((v) => (v > 0 ? v : 0));
      else if (this.output === 'sigmoid') out = z.map((v) => 1 / (1 + Math.exp(-v)));
      else {
        let mx = -Infinity;
        for (const v of z) if (v > mx) mx = v;
        const ex = z.map((v) => Math.exp(v - mx));
        let sum = 0; for (const v of ex) sum += v;
        out = ex.map((v) => v / (sum || 1));
      }
      acts.push(out);
      a = out;
    }
    return acts;
  }

  predict(x: number[]): number[] { const a = this.forwardAll(x); return a[a.length - 1]; }
  /** Convenience for the binary head. */
  predictOne(x: number[]): number { return this.predict(x)[0]; }

  /** Cross-entropy of one example (weighted). */
  loss(yHat: number[], y: number[], w = 1): number {
    let s = 0;
    if (this.output === 'sigmoid') {
      for (let i = 0; i < y.length; i++) { const p = clamp01(yHat[i]); s += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p)); }
    } else {
      for (let i = 0; i < y.length; i++) s += -y[i] * Math.log(clamp01(yHat[i]));
    }
    return s * w;
  }

  /**
   * One Adam step over a mini-batch. Returns the mean loss BEFORE the step.
   *
   * With cross-entropy behind both heads the output delta is simply (a - y) in each case, which is
   * why sigmoid and softmax share this code path.
   */
  trainBatch(batch: Example[], lr = 0.01): number {
    if (!batch.length) return 0;
    const L = this.W.length;
    const gW: number[][][] = this.W.map((layer) => layer.map((row) => new Array(row.length).fill(0)));
    const gB: number[][] = this.B.map((b) => new Array(b.length).fill(0));
    let total = 0, totalW = 0;

    for (const ex of batch) {
      const w = ex.w ?? 1;
      const acts = this.forwardAll(ex.x);
      const yHat = acts[acts.length - 1];
      total += this.loss(yHat, ex.y, w);
      totalW += w;

      let delta: number[] = yHat.map((p, i) => (p - ex.y[i]) * w);
      for (let l = L - 1; l >= 0; l--) {
        const aPrev = acts[l];
        for (let o = 0; o < this.W[l].length; o++) {
          const d = delta[o];
          if (d === 0) continue;
          const grow = gW[l][o], wrow = this.W[l][o];
          for (let i = 0; i < wrow.length; i++) grow[i] += d * aPrev[i];
          gB[l][o] += d;
        }
        if (l > 0) {
          const prev: number[] = new Array(this.W[l - 1].length).fill(0);
          for (let o = 0; o < this.W[l].length; o++) {
            const d = delta[o];
            if (d === 0) continue;
            const wrow = this.W[l][o];
            for (let i = 0; i < wrow.length; i++) prev[i] += d * wrow[i];
          }
          // ReLU derivative of the layer below (acts[l] IS that layer's activation).
          const aBelow = acts[l];
          for (let i = 0; i < prev.length; i++) if (aBelow[i] <= 0) prev[i] = 0;
          delta = prev;
        }
      }
    }

    const scale = 1 / Math.max(1, totalW);
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    for (let l = 0; l < L; l++) {
      for (let o = 0; o < this.W[l].length; o++) {
        const wrow = this.W[l][o], grow = gW[l][o], mrow = this.mW[l][o], vrow = this.vW[l][o];
        for (let i = 0; i < wrow.length; i++) {
          const g = grow[i] * scale + this.l2 * wrow[i];
          mrow[i] = b1 * mrow[i] + (1 - b1) * g;
          vrow[i] = b2 * vrow[i] + (1 - b2) * g * g;
          wrow[i] -= lr * (mrow[i] / c1) / (Math.sqrt(vrow[i] / c2) + eps);
        }
        const gb = gB[l][o] * scale;
        this.mB[l][o] = b1 * this.mB[l][o] + (1 - b1) * gb;
        this.vB[l][o] = b2 * this.vB[l][o] + (1 - b2) * gb * gb;
        this.B[l][o] -= lr * (this.mB[l][o] / c1) / (Math.sqrt(this.vB[l][o] / c2) + eps);
      }
    }
    return total / Math.max(1, totalW);
  }

  /** Mini-batch training with a deterministic shuffle and a wall-clock ceiling. */
  fit(data: Example[], opts: FitOptions = {}): FitResult {
    const epochs = opts.epochs ?? 40;
    const batchSize = Math.max(1, opts.batchSize ?? 32);
    const lr = opts.lr ?? 0.01;
    const rnd = mulberry32(opts.seed ?? this.seed);
    const maxMs = opts.maxMs ?? 0;
    const started = Date.now();
    const history: number[] = [];
    let stoppedEarly = false, done = 0, last = 0;

    const idx = data.map((_, i) => i);
    for (let e = 0; e < epochs; e++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
      let epochLoss = 0, batches = 0;
      for (let s = 0; s < idx.length; s += batchSize) {
        const batch = idx.slice(s, s + batchSize).map((i) => data[i]);
        epochLoss += this.trainBatch(batch, lr);
        batches++;
      }
      last = batches ? epochLoss / batches : 0;
      history.push(+last.toFixed(6));
      done = e + 1;
      if (opts.onEpoch) opts.onEpoch(done, last);
      if (maxMs && Date.now() - started > maxMs) { stoppedEarly = true; break; }
    }
    return { epochs: done, loss: last, history, stoppedEarly };
  }

  /**
   * Per-input saliency: d(output)/d(x) * x — how much each feature moved THIS prediction.
   *
   * This is the honest form of explanation for a network: it makes no causal claim, it reports
   * which inputs the model actually leaned on. Every learner-facing prediction here carries one,
   * because a number a student cannot interrogate has no business sitting next to their work.
   */
  saliency(x: number[], outputIndex = 0): number[] {
    const acts = this.forwardAll(x);
    const L = this.W.length;
    const outDim = this.W[L - 1].length;
    let delta: number[] = new Array(outDim).fill(0);
    delta[outputIndex] = 1;
    for (let l = L - 1; l >= 0; l--) {
      const prev: number[] = new Array(this.W[l][0].length).fill(0);
      for (let o = 0; o < this.W[l].length; o++) {
        const d = delta[o];
        if (d === 0) continue;
        const wrow = this.W[l][o];
        for (let i = 0; i < wrow.length; i++) prev[i] += d * wrow[i];
      }
      if (l > 0) { const aBelow = acts[l]; for (let i = 0; i < prev.length; i++) if (aBelow[i] <= 0) prev[i] = 0; }
      delta = prev;
    }
    return delta.map((g, i) => g * x[i]);
  }

  toJSON(): any {
    return { v: 1, sizes: this.sizes, output: this.output, l2: this.l2, seed: this.seed, t: this.t, W: this.W, B: this.B };
  }

  static fromJSON(j: any): MLP {
    const net = new MLP({ sizes: j.sizes, output: j.output, l2: j.l2, seed: j.seed });
    net.W = j.W.map((layer: number[][]) => layer.map((row: number[]) => row.slice()));
    net.B = j.B.map((b: number[]) => b.slice());
    (net as any).t = j.t || 0;
    return net;
  }

  /** A deep, independent copy — used to keep a champion intact while a candidate trains. */
  clone(): MLP { return MLP.fromJSON(this.toJSON()); }
}
