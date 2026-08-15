// src/lib/mind/features.ts — how a real moment of learning becomes numbers the network can read.
//
// Two rules shape this file.
//
// 1. THE EVENT LOG STORES SIGNALS, NOT FEATURES. What we record when a learner answers is the raw
//    situation (which item, how hard it is empirically, how long they took, what the text was).
//    The feature vector is derived HERE, at training and at serving time, from the same code. So the
//    feature set can be improved later without throwing away a single recorded event — the history
//    is re-read through the new lens. FEATURE_VERSION marks which lens a checkpoint was trained in.
//
// 2. SEQUENCE STATE IS REPLAYED, NOT STORED PER ROW. Streaks, per-concept mastery, recent accuracy
//    and time-since-last are computed by walking one learner's events in order. That is what makes
//    this genuinely online: the same accumulator that trains on history is the one that serves the
//    next question, so there is no train/serve skew to hunt down later.
//
// The BKT posterior carried in the state is the platform's EXISTING estimator (Block 04). It is
// both a feature for the network and the baseline the network has to beat before it is allowed to
// serve anybody — see evaluate.ts.

import { initMastery, bktUpdate, bktPredictCorrect } from '../runtime/estimators/knowledge';
import type { ConceptMastery } from '../runtime/estimators/types';

export const FEATURE_VERSION = 1;

/** What one learning moment looks like when it happens. Stored verbatim as JSON. */
export interface MindSignals {
  itemKey: string;          // question / task id
  conceptKey: string;       // concept, topic or test slug this belongs to
  itemType?: string;        // mcq_single | mcq_multi | true_false | numeric | short_answer | fill_in_blank
  difficulty?: number;      // 0..1 population miss rate (question_stats.empirical_difficulty)
  marks?: number;
  responseMs?: number;
  hintsUsed?: number;
  blank?: boolean;
  text?: string;            // the item's own words — hashed into the vector, never used as an id
  tier?: string;            // learner stage (Tots … Atelier)
  atMs?: number;            // when it happened
}

export interface ConceptStat { attempts: number; correct: number; mastery: ConceptMastery }

/** Everything derivable from one learner's past, carried forward one event at a time. */
export interface SequenceState {
  totalAttempts: number;
  totalCorrect: number;
  recent: number[];              // last 20 outcomes, newest last
  concepts: Record<string, ConceptStat>;
  correctStreak: number;
  wrongStreak: number;
  lastAtMs: number | null;
  sessionPos: number;
}

const SESSION_GAP_MS = 30 * 60 * 1000;

export function newSequenceState(): SequenceState {
  return { totalAttempts: 0, totalCorrect: 0, recent: [], concepts: {}, correctStreak: 0, wrongStreak: 0, lastAtMs: null, sessionPos: 0 };
}

function conceptStat(state: SequenceState, key: string, nowIso: string): ConceptStat {
  let c = state.concepts[key];
  if (!c) { c = { attempts: 0, correct: 0, mastery: initMastery(nowIso) }; state.concepts[key] = c; }
  return c;
}

/** Fold one observed outcome into the state. Call AFTER featurising that same event. */
export function advanceSequence(state: SequenceState, s: MindSignals, correct: boolean, atMs?: number): void {
  const at = atMs ?? s.atMs ?? Date.now();
  const c = conceptStat(state, s.conceptKey || 'unknown', new Date(at).toISOString());
  c.attempts++;
  if (correct) c.correct++;
  c.mastery = bktUpdate(c.mastery, correct, new Date(at).toISOString());
  state.totalAttempts++;
  if (correct) state.totalCorrect++;
  state.recent.push(correct ? 1 : 0);
  if (state.recent.length > 20) state.recent.shift();
  state.correctStreak = correct ? state.correctStreak + 1 : 0;
  state.wrongStreak = correct ? 0 : state.wrongStreak + 1;
  state.sessionPos = state.lastAtMs != null && at - state.lastAtMs > SESSION_GAP_MS ? 1 : state.sessionPos + 1;
  state.lastAtMs = at;
}

// ---- text encoding: the hashing trick -----------------------------------------------------------
// A vocabulary-free encoder. Words and character 3-grams are hashed into a fixed number of buckets
// with a sign, then L2-normalised. It needs no pretrained weights and no download, it is identical
// on the server and in a browser, and it never has to be "retrained" when new words appear — which
// is the property that matters for a platform that must run on its own.

export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export const TEXT_DIM = 32;

export function hashVector(text: string, dim = TEXT_DIM): number[] {
  const v = new Array(dim).fill(0);
  const t = (text || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, ' ').trim();
  if (!t) return v;
  const words = t.split(/\s+/).filter(Boolean).slice(0, 120);
  const add = (token: string, weight: number) => {
    const h = hash32(token);
    const bucket = h % dim;
    const sign = (h >>> 31) & 1 ? -1 : 1;   // signed hashing keeps collisions from all pulling one way
    v[bucket] += sign * weight;
  };
  for (const w of words) add('w:' + w, 1);
  const flat = words.join(' ');
  for (let i = 0; i + 3 <= flat.length && i < 400; i++) add('c:' + flat.slice(i, i + 3), 0.35);
  let norm = 0; for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

// ---- the feature vector -------------------------------------------------------------------------

const ITEM_TYPES = ['mcq_single', 'mcq_multi', 'true_false', 'numeric', 'short_answer', 'fill_in_blank'];
export const CLUSTER_SLOTS = 8;
const DENSE_NAMES = [
  'item difficulty', 'difficulty (logit)', 'mastery of this concept', 'attempts on this concept',
  'attempts overall', 'accuracy, last 5', 'accuracy, last 20', 'accuracy on this concept',
  'time taken', 'hints used', 'left blank', 'marks at stake',
  'run of correct answers', 'run of wrong answers', 'questions into this session', 'time since last attempt',
];

export const FEATURE_NAMES: string[] = [
  ...DENSE_NAMES,
  ...ITEM_TYPES.map((t) => 'question type: ' + t.replace(/_/g, ' ')),
  ...Array.from({ length: TEXT_DIM }, (_, i) => 'wording of the question (' + (i + 1) + ')'),
  ...Array.from({ length: CLUSTER_SLOTS }, (_, i) => 'discovered group ' + (i + 1)),
];

export const FEATURE_DIM = FEATURE_NAMES.length;   // 16 + 6 + 32 + 8 = 62

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Turn one moment into a vector.
 *
 * `clusterOneHot` is where UNSUPERVISED learning feeds the supervised model: the cluster the item's
 * wording falls into (discovered by cluster.ts, with nobody labelling anything) becomes an input the
 * network can use. Pass null before any clusters exist — the slots are simply zero, and the model
 * still trains.
 */
export function featurize(s: MindSignals, state: SequenceState, clusterOneHot?: number[] | null): number[] {
  const diff = clamp(typeof s.difficulty === 'number' && isFinite(s.difficulty) ? s.difficulty : 0.5, 0.02, 0.98);
  const c = state.concepts[s.conceptKey || 'unknown'];
  const pL = c ? c.mastery.pL : 0.2;
  const conceptAttempts = c ? c.attempts : 0;
  const conceptAcc = c && c.attempts ? c.correct / c.attempts : 0.5;
  const r = state.recent;
  const last = (n: number) => { const a = r.slice(Math.max(0, r.length - n)); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5; };
  const gapHours = state.lastAtMs != null && s.atMs ? Math.max(0, (s.atMs - state.lastAtMs) / 3600000) : 0;

  const dense = [
    diff,
    clamp(Math.log(diff / (1 - diff)) / 4, -1, 1),
    pL,
    clamp(Math.log1p(conceptAttempts) / 4, 0, 1),
    clamp(Math.log1p(state.totalAttempts) / 7, 0, 1),
    last(5),
    last(20),
    conceptAcc,
    clamp(Math.log1p((s.responseMs ?? 15000) / 15000) / 2, 0, 1),
    clamp((s.hintsUsed ?? 0) / 3, 0, 1),
    s.blank ? 1 : 0,
    clamp((s.marks ?? 1) / 5, 0, 1),
    clamp(state.correctStreak / 5, 0, 1),
    clamp(state.wrongStreak / 5, 0, 1),
    clamp(state.sessionPos / 20, 0, 1),
    clamp(Math.log1p(gapHours) / 5, 0, 1),
  ];

  const typeVec = ITEM_TYPES.map((t) => (s.itemType === t ? 1 : 0));
  const textVec = hashVector(s.text || s.conceptKey || '', TEXT_DIM);
  const clusterVec = new Array(CLUSTER_SLOTS).fill(0);
  if (clusterOneHot) for (let i = 0; i < Math.min(CLUSTER_SLOTS, clusterOneHot.length); i++) clusterVec[i] = clusterOneHot[i];

  return [...dense, ...typeVec, ...textVec, ...clusterVec];
}

/**
 * The INCUMBENT prediction — what AquinTutor already answers with today, before any network exists.
 *
 * Bayesian Knowledge Tracing once the learner has touched the concept, the item's population miss
 * rate before that. This is not decoration: every candidate network is scored against this number
 * on held-out data, and a network that cannot beat it is never promoted. It is also the fallback
 * that serves when no model has earned promotion, so the platform is never worse than it was.
 */
export function baselinePredict(s: MindSignals, state: SequenceState): number {
  const c = state.concepts[s.conceptKey || 'unknown'];
  if (c && c.attempts > 0) return clamp(bktPredictCorrect(c.mastery), 0.01, 0.99);
  const diff = clamp(typeof s.difficulty === 'number' && isFinite(s.difficulty) ? s.difficulty : 0.5, 0.02, 0.98);
  return clamp(1 - diff, 0.01, 0.99);
}
