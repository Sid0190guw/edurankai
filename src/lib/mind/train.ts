// src/lib/mind/train.ts — one learning cycle, start to finish.
//
// This is the loop that makes AquinTutor's intelligence its own: it reads what actually happened on
// the platform, finds structure in it, trains a network on it, scores that network against what the
// platform already does, and only then decides whether anybody should be served by it.
//
//   1. READ        every recorded moment, oldest first.
//   2. UNSUPERVISED cluster the item wording — the groups of questions that fail together, found
//                  without a single label — and propagate concept difficulty across the concepts
//                  that co-occur, so a concept with almost no data still starts from something real.
//   3. REPLAY      walk each learner's history forward, building the sequence features exactly as
//                  they were lived. No leakage: an event is featurised from what was known BEFORE it.
//   4. SUPERVISED  train the network on graded outcomes.
//   5. SEMI-SUPERVISED  let it label the abandoned questions it is confident about and train again,
//                  at reduced weight.
//   6. JUDGE       score candidate, champion and baseline on held-out rows and promote only on
//                  evidence. A refusal is recorded as carefully as a promotion.
//
// It is designed to run inside a normal request: bounded rows, bounded epochs, a wall-clock ceiling,
// and warm starting from the serving checkpoint so each cycle continues the last one rather than
// starting the platform's education over.

import { MLP } from './nn';
import {
  featurize, newSequenceState, advanceSequence, baselinePredict, hashVector,
  FEATURE_DIM, FEATURE_VERSION, CLUSTER_SLOTS, type MindSignals, type SequenceState,
} from './features';
import { kmeans, chooseK, OnlineKMeans } from './cluster';
import { pseudoLabelBinary, propagateLabels, type PropEdge } from './semisup';
import { evaluateBinary, isHoldout, shouldPromote, type Metrics } from './evaluate';
import {
  loadEvents, saveCheckpoint, getChampion, recordRun, type MindTask, type MindEventRow,
} from './store';

export interface CycleOptions {
  task?: MindTask;
  maxExamples?: number;
  epochs?: number;
  holdout?: number;
  semiSupervised?: boolean;
  unsupervised?: boolean;
  warmStart?: boolean;
  seed?: number;
  /** Ceiling for the gradient descent itself; the whole cycle stays comfortably inside a request. */
  trainMaxMs?: number;
}

export interface ClusterSummary { index: number; items: number; attempts: number; failureRate: number; terms: string[]; exemplars: string[] }

export interface CycleResult {
  ok: boolean;
  task: MindTask;
  examples: number;
  trainN: number;
  holdoutN: number;
  pseudo: number;
  clusters: ClusterSummary[];
  conceptPriors: Record<string, { value: number; confidence: number; observed: boolean }>;
  candidate: Metrics;
  champion: Metrics | null;
  baseline: Metrics;
  promoted: boolean;
  decision: string;
  version: number | null;
  ms: number;
  note: string;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'is', 'are', 'to', 'in', 'and', 'for', 'on', 'at', 'by', 'with', 'what', 'which', 'this', 'that', 'it', 'as', 'be', 'from', 'if', 'was', 'were', 'how', 'why', 'when']);

function topTerms(texts: string[], k = 5): string[] {
  const freq = new Map<string, number>();
  for (const t of texts) {
    for (const w of (t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)) {
      if (w.length < 4 || STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w);
}

/** Concepts that turn up in the same learner's stream are treated as neighbours. */
function coOccurrenceEdges(events: MindEventRow[]): PropEdge[] {
  const byUser = new Map<string, string[]>();
  for (const e of events) {
    const c = e.signals?.conceptKey || 'unknown';
    const arr = byUser.get(e.userKey) || [];
    if (arr[arr.length - 1] !== c) arr.push(c);
    byUser.set(e.userKey, arr);
  }
  const seen = new Set<string>();
  const edges: PropEdge[] = [];
  for (const seq of byUser.values()) {
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i];
      if (a === b) continue;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: a, to: b });
    }
  }
  return edges;
}

export async function runCycle(opts: CycleOptions = {}): Promise<CycleResult> {
  const t0 = Date.now();
  const task: MindTask = opts.task || 'mastery';
  const maxExamples = Math.max(50, Math.min(20000, opts.maxExamples ?? 6000));
  const epochs = Math.max(1, Math.min(400, opts.epochs ?? 60));
  const holdoutFrac = Math.min(0.5, Math.max(0.1, opts.holdout ?? 0.25));
  const semi = opts.semiSupervised !== false;
  const unsup = opts.unsupervised !== false;
  const warm = opts.warmStart !== false;
  const seed = opts.seed ?? 20260815;
  const trainMaxMs = Math.max(1000, Math.min(30000, opts.trainMaxMs ?? 12000));

  const empty: Metrics = { n: 0, logLoss: 0, accuracy: 0, auc: 0.5, brier: 0, ece: 0, positiveRate: 0 };
  const base: CycleResult = {
    ok: false, task, examples: 0, trainN: 0, holdoutN: 0, pseudo: 0, clusters: [], conceptPriors: {},
    candidate: empty, champion: null, baseline: empty, promoted: false, decision: '', version: null, ms: 0, note: '',
  };

  const labelled = await loadEvents({ task, limit: maxExamples, labelled: true });
  if (labelled.length < 40) {
    const note = 'Only ' + labelled.length + ' graded moments recorded. The cycle needs at least 40 before training is meaningful; the platform keeps answering with its existing estimator until then.';
    await recordRun({ task, modes: [], examples: labelled.length, pseudo: 0, clusters: 0, metrics: {}, promoted: false, decision: note, version: null, ms: Date.now() - t0 });
    return { ...base, examples: labelled.length, decision: note, note, ms: Date.now() - t0 };
  }

  // ---- 2. unsupervised: item groups + concept priors ---------------------------------------------
  const itemText = new Map<string, string>();
  const itemStats = new Map<string, { attempts: number; wrong: number }>();
  const conceptStats = new Map<string, { attempts: number; wrong: number }>();
  for (const e of labelled) {
    const key = e.signals?.itemKey || 'unknown';
    if (!itemText.has(key)) itemText.set(key, (e.signals?.text || e.signals?.conceptKey || '').slice(0, 400));
    const s = itemStats.get(key) || { attempts: 0, wrong: 0 };
    s.attempts++; if ((e.label ?? 1) < 0.5) s.wrong++;
    itemStats.set(key, s);
    const ck = e.signals?.conceptKey || 'unknown';
    const cs = conceptStats.get(ck) || { attempts: 0, wrong: 0 };
    cs.attempts++; if ((e.label ?? 1) < 0.5) cs.wrong++;
    conceptStats.set(ck, cs);
  }

  let clusters: OnlineKMeans | null = null;
  let summaries: ClusterSummary[] = [];
  if (unsup && itemText.size >= 8) {
    const keys = [...itemText.keys()];
    const vectors = keys.map((k) => hashVector(itemText.get(k) || k));
    const k = Math.min(CLUSTER_SLOTS, chooseK(vectors, CLUSTER_SLOTS, seed));
    const km = kmeans(vectors, k, { seed });
    clusters = new OnlineKMeans(km.centroids, km.sizes);
    summaries = km.centroids.map((_, ci) => {
      const members = keys.filter((_, i) => km.assignments[i] === ci);
      let attempts = 0, wrong = 0;
      for (const m of members) { const s = itemStats.get(m); if (s) { attempts += s.attempts; wrong += s.wrong; } }
      const texts = members.map((m) => itemText.get(m) || '').filter(Boolean);
      return {
        index: ci, items: members.length, attempts,
        failureRate: attempts ? +(wrong / attempts).toFixed(3) : 0,
        terms: topTerms(texts),
        exemplars: texts.slice(0, 3).map((t) => t.slice(0, 140)),
      };
    }).sort((a, b) => b.failureRate - a.failureRate);
  }

  const seeds: Record<string, number> = {};
  for (const [c, s] of conceptStats) if (s.attempts >= 8) seeds[c] = +(s.wrong / s.attempts).toFixed(4);
  const conceptPriors = Object.keys(seeds).length
    ? propagateLabels([...conceptStats.keys()], coOccurrenceEdges(labelled), seeds)
    : {};

  // ---- 3. replay: features from what was known BEFORE each event ---------------------------------
  const states = new Map<string, SequenceState>();
  const rowsOut: { id: string; x: number[]; y: number; base: number }[] = [];
  for (const e of labelled) {
    const s: MindSignals = { ...(e.signals || {}) } as MindSignals;
    s.atMs = s.atMs || Date.parse(e.occurredAt) || Date.now();
    if (typeof s.difficulty !== 'number') {
      const prior = conceptPriors[s.conceptKey || 'unknown'];
      if (prior && prior.confidence > 0.2) s.difficulty = prior.value;
    }
    let st = states.get(e.userKey);
    if (!st) { st = newSequenceState(); states.set(e.userKey, st); }
    const one = clusters ? clusters.oneHot(hashVector(s.text || s.conceptKey || ''), CLUSTER_SLOTS) : null;
    rowsOut.push({ id: e.id, x: featurize(s, st, one), y: (e.label ?? 0) >= 0.5 ? 1 : 0, base: baselinePredict(s, st) });
    advanceSequence(st, s, (e.label ?? 0) >= 0.5, s.atMs);
  }

  const trainRows = rowsOut.filter((r) => !isHoldout(r.id, holdoutFrac));
  const testRows = rowsOut.filter((r) => isHoldout(r.id, holdoutFrac));
  if (!trainRows.length || !testRows.length) {
    const note = 'Not enough distinct moments to split into training and held-out sets.';
    await recordRun({ task, modes: [], examples: rowsOut.length, pseudo: 0, clusters: summaries.length, metrics: {}, promoted: false, decision: note, version: null, ms: Date.now() - t0 });
    return { ...base, examples: rowsOut.length, clusters: summaries, decision: note, note, ms: Date.now() - t0 };
  }

  // ---- 4. supervised -----------------------------------------------------------------------------
  const champion = await getChampion(task);
  const arch = { sizes: [FEATURE_DIM, 24, 12, 1], output: 'sigmoid' as const, l2: 1e-4, seed };
  let net: MLP;
  let warmStarted = false;
  if (warm && champion && champion.featureVersion === FEATURE_VERSION && champion.weights?.sizes?.[0] === FEATURE_DIM) {
    try { net = MLP.fromJSON(champion.weights); warmStarted = true; } catch { net = new MLP(arch); }
  } else net = new MLP(arch);

  const modes: string[] = ['supervised'];
  net.fit(trainRows.map((r) => ({ x: r.x, y: [r.y] })), { epochs, batchSize: 32, lr: warmStarted ? 0.004 : 0.01, seed, maxMs: trainMaxMs });

  // ---- 5. semi-supervised -----------------------------------------------------------------------
  let pseudoCount = 0;
  if (semi) {
    const unlabelled = await loadEvents({ task, limit: Math.min(4000, maxExamples), labelled: false }).catch(() => []);
    if (unlabelled.length) {
      // Replay these through each learner's state as well, so an abandoned question is featurised in
      // the same situation it was abandoned in.
      const items = unlabelled.map((e) => {
        const s: MindSignals = { ...(e.signals || {}) } as MindSignals;
        s.atMs = s.atMs || Date.parse(e.occurredAt) || Date.now();
        const st = states.get(e.userKey) || newSequenceState();
        const one = clusters ? clusters.oneHot(hashVector(s.text || s.conceptKey || ''), CLUSTER_SLOTS) : null;
        return { id: e.id, x: featurize(s, st, one) };
      });
      const pseudo = pseudoLabelBinary(items, (x) => net.predictOne(x), { threshold: 0.85, max: Math.min(2000, trainRows.length), maxWeight: 0.4 });
      pseudoCount = pseudo.length;
      if (pseudo.length) {
        modes.push('semi-supervised');
        net.fit(
          [...trainRows.map((r) => ({ x: r.x, y: [r.y], w: 1 })), ...pseudo.map((p) => ({ x: p.x, y: p.y, w: p.w }))],
          { epochs: Math.max(8, Math.round(epochs / 3)), batchSize: 32, lr: 0.004, seed: seed + 1, maxMs: Math.round(trainMaxMs / 2) },
        );
      }
    }
  }
  if (unsup && summaries.length) modes.push('unsupervised');

  // ---- 6. judge ----------------------------------------------------------------------------------
  const labels = testRows.map((r) => r.y);
  const candidate = evaluateBinary(testRows.map((r) => net.predictOne(r.x)), labels);
  const baseline = evaluateBinary(testRows.map((r) => r.base), labels);
  let championMetrics: Metrics | null = null;
  if (champion && champion.featureVersion === FEATURE_VERSION && champion.weights?.sizes?.[0] === FEATURE_DIM) {
    try {
      const old = MLP.fromJSON(champion.weights);
      championMetrics = evaluateBinary(testRows.map((r) => old.predictOne(r.x)), labels);
    } catch { championMetrics = null; }
  }

  const decision = shouldPromote({ candidate, champion: championMetrics, baseline });
  const clustersPayload = {
    kmeans: clusters ? clusters.toJSON() : null,
    summaries,
    conceptPriors,
    featureVersion: FEATURE_VERSION,
  };
  const version = await saveCheckpoint({
    task, featureVersion: FEATURE_VERSION, arch: { ...arch, warmStartedFrom: warmStarted ? champion?.version ?? null : null, modes },
    weights: net.toJSON(), clusters: clustersPayload,
    metrics: { candidate, baseline, champion: championMetrics, deltaVsBaseline: decision.deltaVsBaseline, deltaVsChampion: decision.deltaVsChampion },
    status: decision.promote ? 'champion' : 'candidate',
    trainedOn: trainRows.length + pseudoCount,
    note: decision.reason,
  });

  const ms = Date.now() - t0;
  await recordRun({
    task, modes, examples: rowsOut.length, pseudo: pseudoCount, clusters: summaries.length,
    metrics: { candidate, baseline, champion: championMetrics }, promoted: decision.promote,
    decision: decision.reason, version, ms,
  });

  return {
    ok: true, task, examples: rowsOut.length, trainN: trainRows.length, holdoutN: testRows.length,
    pseudo: pseudoCount, clusters: summaries, conceptPriors, candidate, champion: championMetrics, baseline,
    promoted: decision.promote, decision: decision.reason, version, ms,
    note: (warmStarted ? 'Continued from checkpoint v' + champion?.version : 'Trained from scratch') + ' · ' + modes.join(' + '),
  };
}
