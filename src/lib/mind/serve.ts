// src/lib/mind/serve.ts — the trained model, answering.
//
// Serving rules, in order of importance:
//
//   1. NEVER WORSE THAN BEFORE. If no checkpoint has earned promotion, if the model was trained on a
//      different feature version, if the database is cold — every one of those paths returns the
//      platform's existing estimator instead of an error. A learner never sees this feature fail;
//      at worst they see what they would have seen anyway.
//   2. ALWAYS EXPLAINABLE. Every prediction carries the inputs that actually moved it, in words.
//   3. ADVISORY ONLY. Nothing here grades anybody, gates anybody, or penalises anybody. It chooses
//      what to offer next and says how confident it is. That is the whole permitted authority, and
//      it matches the standing rule about automated judgement on this platform.

import { MLP } from './nn';
import {
  featurize, newSequenceState, advanceSequence, baselinePredict,
  FEATURE_NAMES, FEATURE_VERSION, FEATURE_DIM, CLUSTER_SLOTS, type MindSignals,
} from './features';
import { OnlineKMeans } from './cluster';
import { getChampion, loadLearnerEvents, resolveEncoder, type MindTask, type CheckpointRow } from './store';
import { HashingEncoder, encoderMatches, type TextEncoder } from './encoder';

export interface Explanation { feature: string; effect: number; direction: 'helps' | 'hurts' }

export interface Prediction {
  /** Probability the learner answers this correctly, 0..1. */
  p: number;
  source: 'model' | 'baseline';
  version: number | null;
  /** What the platform's non-neural estimator says — always computed, so the two can be compared. */
  baseline: number;
  explain: Explanation[];
  /** How unlike anything the model has grouped before this item is, 0..1. */
  novelty: number;
}

interface Loaded {
  net: MLP | null;
  clusters: OnlineKMeans | null;
  version: number | null;
  priors: Record<string, { value: number; confidence: number }>;
  /** The encoder in force now — the same one that must have trained the checkpoint. */
  encoder: TextEncoder;
  /** Set when a checkpoint exists but was trained through a DIFFERENT encoder. */
  encoderMismatch: string | null;
}

const netCache = new Map<string, { at: number; loaded: Loaded }>();
const NET_TTL_MS = 60_000;

async function loadServing(task: MindTask): Promise<Loaded> {
  const hit = netCache.get(task);
  if (hit && Date.now() - hit.at < NET_TTL_MS) return hit.loaded;
  let encoder: TextEncoder = new HashingEncoder();
  try { encoder = (await resolveEncoder()).encoder; }
  catch (e: any) { console.error('[mind/serve] encoder resolve failed:', e?.cause?.message || e?.message); }
  const empty: Loaded = { net: null, clusters: null, version: null, priors: {}, encoder, encoderMismatch: null };
  let champion: CheckpointRow | null = null;
  try { champion = await getChampion(task); } catch { champion = null; }
  let loaded = empty;
  // Width guard as well as version guard: a checkpoint whose input layer does not match the current
  // feature vector would throw on the first prediction, and train.ts already refuses it — serving
  // must refuse it in the same terms rather than discovering it per request.
  if (champion && champion.featureVersion === FEATURE_VERSION && champion.weights?.sizes?.[0] === FEATURE_DIM) {
    // THE SKEW GUARD. A model trained on pretrained embeddings must never be fed hashed vectors
    // because an endpoint moved or an administrator switched encoders: the width is identical and
    // the meaning is not, so its predictions would look ordinary and be nonsense. On a mismatch the
    // platform serves its own estimator and records why.
    if (!encoderMatches(champion.arch?.encoderId, encoder)) {
      const mismatch = 'Checkpoint v' + champion.version + ' was trained through '
        + (champion.arch?.encoderId || 'hash-v1') + ' but the encoder in force is ' + encoder.id
        + '. It is not being served; the platform is answering with its own estimator until a cycle runs on the current encoder.';
      console.error('[mind/serve] ' + mismatch);
      const held: Loaded = { ...empty, encoderMismatch: mismatch };
      netCache.set(task, { at: Date.now(), loaded: held });
      return held;
    }
    try {
      loaded = {
        net: MLP.fromJSON(champion.weights),
        clusters: champion.clusters?.kmeans ? OnlineKMeans.fromJSON(champion.clusters.kmeans) : null,
        version: champion.version,
        priors: champion.clusters?.conceptPriors || {},
        encoder,
        encoderMismatch: null,
      };
    } catch (e: any) {
      // A checkpoint that will not load is a checkpoint that must not silently disappear.
      console.error('[mind/serve] checkpoint v' + champion.version + ' failed to load:', e?.message);
      loaded = empty;
    }
  }
  netCache.set(task, { at: Date.now(), loaded });
  return loaded;
}

/** Replay one learner's recorded history into the state the next prediction is made from. */
async function stateFor(userKey: string, task: MindTask = 'mastery') {
  const state = newSequenceState();
  if (!userKey) return state;
  try {
    const events = await loadLearnerEvents(userKey, task, 300);
    for (const e of events) {
      if (e.label == null) continue;
      const s = { ...(e.signals || {}) } as MindSignals;
      const at = s.atMs || Date.parse(e.occurredAt) || Date.now();
      advanceSequence(state, s, e.label >= 0.5, at);
    }
  } catch (e: any) {
    console.error('[mind/serve] learner history read failed:', e?.cause?.message || e?.message);
  }
  return state;
}

function explain(net: MLP, x: number[], top = 4): Explanation[] {
  const s = net.saliency(x);
  return s
    .map((effect, i) => ({ feature: FEATURE_NAMES[i] || 'feature ' + i, effect: +effect.toFixed(4), direction: (effect >= 0 ? 'helps' : 'hurts') as 'helps' | 'hurts' }))
    .filter((e) => Math.abs(e.effect) > 1e-4)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, top);
}

/**
 * One prediction against an already-loaded model, an already-replayed learner state, and an
 * already-encoded piece of text. `textVec` is null when encoding was not possible — and then the
 * model is deliberately NOT used, because guessing at its inputs is worse than not answering.
 */
function predictWith(loaded: Loaded, state: ReturnType<typeof newSequenceState>, signals: MindSignals, textVec: number[] | null): Prediction {
  const { net, clusters, version, priors } = loaded;
  const s: MindSignals = { ...signals, atMs: signals.atMs || Date.now() };
  if (typeof s.difficulty !== 'number') {
    const prior = priors[s.conceptKey || 'unknown'];
    if (prior && prior.confidence > 0.2) s.difficulty = prior.value;   // a concept nobody has measured still starts from something
  }
  const baseline = baselinePredict(s, state);
  const tv = textVec;
  const novelty = clusters && tv ? +clusters.novelty(tv).toFixed(3) : 1;
  if (!net || !tv) return { p: +baseline.toFixed(4), source: 'baseline', version: null, baseline: +baseline.toFixed(4), explain: [], novelty };

  const x = featurize(s, state, clusters ? clusters.oneHot(tv, CLUSTER_SLOTS) : null, tv);
  let p: number;
  try { p = net.predictOne(x); } catch { return { p: +baseline.toFixed(4), source: 'baseline', version, baseline: +baseline.toFixed(4), explain: [], novelty }; }
  return { p: +p.toFixed(4), source: 'model', version, baseline: +baseline.toFixed(4), explain: explain(net, x), novelty };
}

/** Encode a batch with the encoder in force. Null on failure — never a silent substitute. */
async function encodeOrNull(loaded: Loaded, texts: string[]): Promise<(number[] | null)[]> {
  if (!texts.length) return [];
  try {
    const vs = await loaded.encoder.encode(texts);
    return texts.map((_, i) => (Array.isArray(vs[i]) && vs[i].length ? vs[i] : null));
  } catch (e: any) {
    console.error('[mind/serve] encoding failed (' + loaded.encoder.id + '); answering with the platform estimator:', e?.message);
    return texts.map(() => null);
  }
}

export async function predictSuccess(userKey: string, signals: MindSignals, task: MindTask = 'mastery'): Promise<Prediction> {
  const [loaded, state] = await Promise.all([loadServing(task), stateFor(userKey, task)]);
  const [vec] = await encodeOrNull(loaded, [signals.text || signals.conceptKey || '']);
  return predictWith(loaded, state, signals, vec);
}

export interface Ranked { signals: MindSignals; prediction: Prediction; score: number; reason: string }

/**
 * Order candidate items by how much the learner would GAIN from them, not by how likely they are to
 * get them right.
 *
 * The target is the productive band — hard enough to be worth doing, not so hard it teaches
 * helplessness. This platform's stated pedagogy is verified learning and productive failure, so the
 * ranking has to reflect it: an item predicted at 95% is revision, an item predicted at 20% is a wall.
 */
export async function rankByLearningValue(userKey: string, candidates: MindSignals[], target = 0.72, task: MindTask = 'mastery'): Promise<Ranked[]> {
  // Model and history are loaded ONCE for the whole batch. Ranking forty candidates used to mean
  // forty identical reads of the same learner's history — the kind of loop that has cost this
  // project a compute quota before.
  const [loaded, state] = await Promise.all([loadServing(task), stateFor(userKey, task)]);
  const list = candidates.slice(0, 40);
  const vecs = await encodeOrNull(loaded, list.map((c) => c.text || c.conceptKey || ''));
  const out: Ranked[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const prediction = predictWith(loaded, state, c, vecs[i]);
    const distance = Math.abs(prediction.p - target);
    const score = +(1 - distance).toFixed(4);
    const reason = prediction.p > target + 0.15
      ? 'Comfortable — you would very likely get this right already.'
      : prediction.p < target - 0.2
        ? 'A stretch — worth doing with support, not on its own.'
        : 'In the band where you learn most: hard enough to be worth it, close enough to reach.';
    out.push({ signals: c, prediction, score, reason });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface ConceptView { concept: string; attempts: number; correct: number; mastery: number; predicted: number; source: 'model' | 'baseline' }
export interface LearnerSnapshot {
  attempts: number;
  correct: number;
  concepts: ConceptView[];
  modelVersion: number | null;
  source: 'model' | 'baseline';
  explain: Explanation[];
}

/** Everything a learner-facing page needs, in one pass over their own recorded history. */
export async function learnerSnapshot(userKey: string, task: MindTask = 'mastery'): Promise<LearnerSnapshot> {
  const [loaded, state] = await Promise.all([loadServing(task), stateFor(userKey, task)]);
  const conceptVecs = await encodeOrNull(loaded, Object.keys(state.concepts));
  const concepts: ConceptView[] = [];
  let explainTop: Explanation[] = [];
  let ci = -1;
  for (const [concept, stat] of Object.entries(state.concepts)) {
    ci++;
    const signals: MindSignals = {
      itemKey: 'next', conceptKey: concept, itemType: 'mcq_single', marks: 1, text: concept, atMs: Date.now(),
    };
    const prediction = predictWith(loaded, state, signals, conceptVecs[ci]);   // same path the platform serves from
    if (!explainTop.length && prediction.explain.length) explainTop = prediction.explain;
    concepts.push({
      concept, attempts: stat.attempts, correct: stat.correct,
      mastery: +stat.mastery.pL.toFixed(4), predicted: prediction.p, source: prediction.source,
    });
  }
  concepts.sort((a, b) => a.predicted - b.predicted);
  // Reported from what was ACTUALLY produced, not from what was loaded. A model that loaded but
  // could not be used — text that would not encode, a row that threw — must not be reported to a
  // learner as the thing that answered them.
  const served = concepts.some((c) => c.source === 'model');
  return {
    attempts: state.totalAttempts, correct: state.totalCorrect, concepts,
    modelVersion: served ? loaded.version : null, source: served ? 'model' : 'baseline', explain: explainTop,
  };
}

/** Drop the in-process model cache — called right after a promotion so the change is visible now. */
export function invalidateServingCache(): void { netCache.clear(); }
