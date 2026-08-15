// src/lib/mind/distill.ts — using a pretrained model WITHOUT depending on one.
//
// The question this file answers is the sovereignty question: how does a platform benefit from a
// large pretrained model without that model becoming the product?
//
// The answer is distillation, in three tiers of authority:
//
//   RULES    the deterministic router already in this codebase (aquin-brain) labels every tutor turn
//            for free, offline, today. It bootstraps the corpus from nothing.
//   TEACHER  when an administrator switches the LLM gateway on — a self-hosted open-weight model or
//            the Anthropic connector, their choice — it is asked to label a BATCH of stored turns.
//            Not to answer learners: to label. Its judgement becomes training data.
//   HUMAN    a person's correction outranks both, and is stored separately so the disagreement
//            survives (store.ts, aq_mind_label).
//
// The small network here then learns to do the routing itself, and once it does, the platform keeps
// that capability with no gateway, no key, no network call and no per-token cost — on a phone, in a
// classroom with no connectivity, forever. That is the difference between renting intelligence and
// owning it.
//
// HONESTY ABOUT PROMOTION. A network trained on rule-generated labels that is then SCORED against
// those same rules would always look perfect and mean nothing. So the intent model is judged only on
// turns labelled by a teacher model or by a person — an independent judgement — and if there are
// none, it is trained, recorded, and explicitly NOT promoted, with that stated on the console.

import { MLP } from './nn';
import { hashVector } from './features';
import { evaluateMulti, isHoldout, shouldPromote } from './evaluate';
import { aquinReply } from '@/lib/aquin-brain';
import {
  loadEvents, saveCheckpoint, getChampion, recordRun, recordEventSafe, setTeacherLabel, resolveEncoder,
  type MindEventRow,
} from './store';
import { HashingEncoder, encoderMatches, type TextEncoder } from './encoder';

export const INTENT_CLASSES = ['concept_help', 'platform_question', 'logistics', 'encouragement', 'off_topic'] as const;
export type IntentClass = typeof INTENT_CLASSES[number];

export const INTENT_LABELS: Record<IntentClass, string> = {
  concept_help: 'Stuck on a concept',
  platform_question: 'Asking how the platform works',
  logistics: 'Fees, access, dates, certificates',
  encouragement: 'Discouraged, needs support first',
  off_topic: 'Something else',
};

const LOGISTICS = /\b(fee|fees|refund|invoice|payment|price|login|log in|password|sign in|certificate|deadline|timetable|schedule|exam date|admission|enrol|enroll|register|receipt|scholarship)\b/i;
const ENCOURAGE = /\b(give up|giving up|can'?t do|cannot do|too hard|hate|stressed|anxious|anxiety|panic|tired|failing|failed again|worthless|stupid|no point)\b/i;

/** The incumbent router: deterministic, offline, already shipping. Also the corpus bootstrap. */
export function ruleIntent(text: string): { index: number; klass: IntentClass } {
  const t = (text || '').trim();
  if (!t) return { index: 4, klass: 'off_topic' };
  if (ENCOURAGE.test(t)) return { index: 3, klass: 'encouragement' };
  const reply = aquinReply([{ role: 'user', content: t }]);
  if (reply.source === 'coach') return { index: 0, klass: 'concept_help' };
  if (reply.source === 'kb') return { index: 1, klass: 'platform_question' };
  if (LOGISTICS.test(t)) return { index: 2, klass: 'logistics' };
  return { index: 4, klass: 'off_topic' };
}

export const INTENT_DIM = 35;   // 32 text dimensions + 3 shape features

/**
 * `textVec` is where the PRETRAINED model earns its place on this task.
 *
 * Routing intent is exactly the job a hashing encoder is bad at: "I don't get eigenvalues" and "the
 * matrix stuff makes no sense" share almost no characters and mean the same thing. An embedding
 * model knows that already, and this little network gets to stand on it instead of learning English
 * from a few thousand tutor turns. Pass null and it falls back to hashing, which still works.
 */
export function intentFeatures(text: string, textVec?: number[] | null): number[] {
  const t = (text || '').slice(0, 2000);
  const v = textVec && textVec.length === 32 ? textVec : hashVector(t, 32);
  return [
    ...v,
    Math.min(1, t.length / 300),
    /\?/.test(t) ? 1 : 0,
    /\d/.test(t) ? 1 : 0,
  ];
}

/** Record one tutor turn. Rule-labelled on the way in, so the corpus is never empty. */
export async function recordTutorTurn(userKey: string, text: string): Promise<void> {
  const t = (text || '').trim();
  if (t.length < 3) return;
  const r = ruleIntent(t);
  await recordEventSafe({
    userKey, task: 'intent',
    signals: { itemKey: 'turn', conceptKey: r.klass, text: t.slice(0, 300), atMs: Date.now() },
    label: r.index, labelSource: 'rules', confidence: 0.5,
  });
}

const cache: { at: number; net: MLP | null; version: number | null; encoder: TextEncoder } =
  { at: 0, net: null, version: null, encoder: new HashingEncoder() };

async function servingIntentNet(): Promise<{ net: MLP | null; version: number | null; encoder: TextEncoder }> {
  if (Date.now() - cache.at < 60_000) return { net: cache.net, version: cache.version, encoder: cache.encoder };
  let net: MLP | null = null, version: number | null = null;
  let encoder: TextEncoder = new HashingEncoder();
  try { encoder = (await resolveEncoder()).encoder; } catch { /* the always-available one */ }
  try {
    const champ = await getChampion('intent');
    // Same skew guard as the mastery head: a router trained on embeddings is never fed hashed text.
    if (champ?.weights?.sizes?.[0] === INTENT_DIM && encoderMatches(champ.arch?.encoderId, encoder)) {
      net = MLP.fromJSON(champ.weights);
      version = champ.version;
    } else if (champ && !encoderMatches(champ.arch?.encoderId, encoder)) {
      console.error('[mind/distill] router v' + champ.version + ' was trained through '
        + (champ.arch?.encoderId || 'hash-v1') + ', encoder in force is ' + encoder.id + '; routing with the rules instead.');
    }
  } catch (e: any) { console.error('[mind/distill] intent champion load failed:', e?.cause?.message || e?.message); }
  cache.at = Date.now(); cache.net = net; cache.version = version; cache.encoder = encoder;
  return { net, version, encoder };
}

export interface IntentResult { klass: IntentClass; label: string; p: number; source: 'model' | 'rules'; version: number | null; rules: IntentClass; scores: { klass: IntentClass; p: number }[] }

/** Route one message. Falls back to the deterministic router whenever no model has earned promotion. */
export async function classifyIntent(text: string): Promise<IntentResult> {
  const rules = ruleIntent(text);
  const { net, version, encoder } = await servingIntentNet();
  const bail = () => ({
    klass: rules.klass, label: INTENT_LABELS[rules.klass], p: 1, source: 'rules' as const, version: null,
    rules: rules.klass, scores: INTENT_CLASSES.map((k, i) => ({ klass: k, p: i === rules.index ? 1 : 0 })),
  });
  if (!net) return bail();
  let vec: number[] | null = null;
  try { vec = (await encoder.encode([text]))[0] || null; }
  catch (e: any) { console.error('[mind/distill] encoding failed; routing with the rules:', e?.message); return bail(); }
  const p = net.predict(intentFeatures(text, vec));
  let top = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[top]) top = i;
  return {
    klass: INTENT_CLASSES[top], label: INTENT_LABELS[INTENT_CLASSES[top]], p: +p[top].toFixed(4),
    source: 'model', version, rules: rules.klass,
    scores: INTENT_CLASSES.map((k, i) => ({ klass: k, p: +(p[i] ?? 0).toFixed(4) })),
  };
}

// ---- the teacher pass ---------------------------------------------------------------------------

const TEACHER_SYSTEM = 'You label short messages from students on a learning platform. Reply with ONE word from this list and nothing else: '
  + INTENT_CLASSES.join(', ')
  + '. concept_help = they are stuck on academic content. platform_question = they ask how the platform or a feature works. '
  + 'logistics = fees, access, dates, certificates, admission. encouragement = they are discouraged and need support before content. '
  + 'off_topic = anything else.';

export interface DistillResult { ok: boolean; asked: number; labelled: number; changed: number; provider: string; error?: string }

/**
 * Ask the configured model to label stored turns. Explicitly triggered by an administrator, never
 * automatic — it sends stored learner messages to whichever provider is configured, and that is a
 * decision a person makes knowingly, not a background job.
 */
export async function distillBatch(limit = 40): Promise<DistillResult> {
  const { effectiveConfig, isReady, chatStream, activeModel } = await import('@/lib/llm/gateway');
  const cfg = await effectiveConfig();
  if (!isReady(cfg)) {
    return { ok: false, asked: 0, labelled: 0, changed: 0, provider: 'none', error: 'No model is configured. Set a self-hosted endpoint or a connector key in the LLM panel first — the platform keeps routing with its own rules until then.' };
  }
  const events = (await loadEvents({ task: 'intent', limit: 500, labelled: true }))
    .filter((e) => e.labelSource === 'rules')
    .slice(-Math.max(1, Math.min(100, limit)));
  let labelled = 0, changed = 0;
  for (const e of events) {
    const text = (e.signals?.text || '').trim();
    if (!text) continue;
    let out = '';
    const r = await chatStream(TEACHER_SYSTEM, [{ role: 'user', content: text.slice(0, 1000) }], { ...cfg, maxTokens: 8 }, (t) => { out += t; }).catch(() => null);
    if (!r || !r.ok) continue;
    const word = (out || r.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const idx = (INTENT_CLASSES as readonly string[]).indexOf(word);
    if (idx < 0) continue;
    await setTeacherLabel(e.id, idx, 0.9).catch(() => {});
    labelled++;
    if (e.label !== idx) changed++;
  }
  return { ok: true, asked: events.length, labelled, changed, provider: cfg.provider + ':' + activeModel(cfg) };
}

// ---- training the student -----------------------------------------------------------------------

export interface IntentCycleResult {
  ok: boolean; examples: number; judged: number; accuracy: number; rulesAccuracy: number;
  promoted: boolean; decision: string; version: number | null; ms: number;
}

/**
 * Train the intent head, and judge it ONLY on independently-labelled turns.
 *
 * Everything is training data; only teacher- and human-labelled turns are evidence. That asymmetry
 * is the whole point — it is what stops a model that has memorised a regular expression from being
 * promoted as though it had learned something.
 */
export async function runIntentCycle(opts: { epochs?: number; seed?: number; maxMs?: number } = {}): Promise<IntentCycleResult> {
  const t0 = Date.now();
  const epochs = Math.max(1, Math.min(400, opts.epochs ?? 120));
  const seed = opts.seed ?? 4242;
  const events: MindEventRow[] = await loadEvents({ task: 'intent', limit: 8000, labelled: true });
  const usable = events.filter((e) => (e.signals?.text || '').length > 2 && e.label != null);
  if (usable.length < 40) {
    const decision = 'Only ' + usable.length + ' tutor turns recorded. The router keeps answering from its rules until there are at least 40.';
    await recordRun({ task: 'intent', modes: [], examples: usable.length, pseudo: 0, clusters: 0, metrics: {}, promoted: false, decision, version: null, ms: Date.now() - t0 });
    return { ok: false, examples: usable.length, judged: 0, accuracy: 0, rulesAccuracy: 0, promoted: false, decision, version: null, ms: Date.now() - t0 };
  }

  // ONE encode pass for the whole cycle, exactly as the mastery cycle does it.
  let encoder: TextEncoder = new HashingEncoder();
  let encoderNote = '';
  try { const r = await resolveEncoder(); encoder = r.encoder; encoderNote = r.note; } catch { /* hashing */ }
  const texts = usable.map((e) => e.signals.text || '');
  const vecMap = new Map<string, number[]>();
  try {
    const distinct = [...new Set(texts)];
    const vs = await encoder.encode(distinct);
    distinct.forEach((t, i) => { if (vs[i]?.length) vecMap.set(t, vs[i]); });
  } catch (e: any) {
    console.error('[mind/distill] encoding failed, this cycle uses hashing:', e?.message);
    encoder = new HashingEncoder();
    encoderNote = 'The pretrained encoder could not be reached; this router was trained through the hashing encoder.';
    vecMap.clear();
  }
  const vecOf = (t: string) => vecMap.get(t) || null;

  const oneHot = (i: number) => INTENT_CLASSES.map((_, k) => (k === i ? 1 : 0));
  const independent = (e: MindEventRow) => e.labelSource === 'teacher' || e.labelSource === 'human';
  const judged = usable.filter((e) => independent(e) && isHoldout(e.id, 0.35));
  const judgedIds = new Set(judged.map((e) => e.id));
  const train = usable.filter((e) => !judgedIds.has(e.id));

  const net = new MLP({ sizes: [INTENT_DIM, 16, INTENT_CLASSES.length], output: 'softmax', seed, l2: 1e-4 });
  net.fit(train.map((e) => ({ x: intentFeatures(e.signals.text || '', vecOf(e.signals.text || '')), y: oneHot(Math.round(e.label as number)) })),
    { epochs, batchSize: 16, lr: 0.02, seed, maxMs: Math.max(1000, Math.min(15000, opts.maxMs ?? 8000)) });

  if (judged.length < 60) {
    const decision = 'Trained on ' + train.length + ' turns, but only ' + judged.length
      + ' of them carry an independent label (a teacher model or a person). A model scored against the rules that taught it proves nothing, so this checkpoint is kept as a candidate and the platform keeps routing with its rules. Run a distillation batch, or correct some turns by hand, to give it something real to be judged on.';
    const version = await saveCheckpoint({
      task: 'intent', featureVersion: 1,
      arch: { sizes: [INTENT_DIM, 16, INTENT_CLASSES.length], output: 'softmax', classes: INTENT_CLASSES, encoderId: encoder.id, encoderNote },
      weights: net.toJSON(), clusters: {}, metrics: { judged: judged.length }, status: 'candidate', trainedOn: train.length, note: decision,
    });
    await recordRun({ task: 'intent', modes: ['supervised'], examples: train.length, pseudo: 0, clusters: 0, metrics: { judged: judged.length }, promoted: false, decision, version, ms: Date.now() - t0 });
    return { ok: true, examples: train.length, judged: judged.length, accuracy: 0, rulesAccuracy: 0, promoted: false, decision, version, ms: Date.now() - t0 };
  }

  const golds = judged.map((e) => oneHot(Math.round(e.label as number)));
  const modelPreds = judged.map((e) => net.predict(intentFeatures(e.signals.text || '', vecOf(e.signals.text || ''))));
  // The rules, smoothed into a distribution so a confident miss is finite rather than infinite.
  const rulePreds = judged.map((e) => {
    const r = ruleIntent(e.signals.text || '');
    return INTENT_CLASSES.map((_, i) => (i === r.index ? 0.8 : 0.2 / (INTENT_CLASSES.length - 1)));
  });
  const mModel = evaluateMulti(modelPreds, golds);
  const mRules = evaluateMulti(rulePreds, golds);
  const decisionObj = shouldPromote({ candidate: { ...mModel, ece: 0 }, champion: null, baseline: mRules, minHoldout: 60 });

  const version = await saveCheckpoint({
    task: 'intent', featureVersion: 1,
    arch: { sizes: [INTENT_DIM, 16, INTENT_CLASSES.length], output: 'softmax', classes: INTENT_CLASSES, encoderId: encoder.id, encoderNote },
    weights: net.toJSON(), clusters: {}, metrics: { model: mModel, rules: mRules },
    status: decisionObj.promote ? 'champion' : 'candidate', trainedOn: train.length, note: decisionObj.reason,
  });
  cache.at = 0;   // a promotion must be visible on the next request, not in a minute
  await recordRun({
    task: 'intent', modes: ['supervised', 'distilled'], examples: train.length, pseudo: 0, clusters: 0,
    metrics: { model: mModel, rules: mRules }, promoted: decisionObj.promote, decision: decisionObj.reason, version, ms: Date.now() - t0,
  });
  return {
    ok: true, examples: train.length, judged: judged.length, accuracy: mModel.accuracy, rulesAccuracy: mRules.accuracy,
    promoted: decisionObj.promote, decision: decisionObj.reason, version, ms: Date.now() - t0,
  };
}
