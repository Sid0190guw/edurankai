// src/lib/mind/store.ts — where the learning is kept.
//
// Four tables, all additive and self-bootstrapping, all prefixed aq_mind_. Nothing existing is
// touched, and a fresh database and a populated one both come up the same way.
//
//   aq_mind_event   one moment of learning, as raw signals. The corpus.
//   aq_mind_model   a trained checkpoint: weights, clusters, metrics, status. The model IS a row.
//   aq_mind_run     what happened in one training cycle, including the times it refused to promote.
//   aq_mind_label   a human correction. The highest-authority label there is; it outranks the rest.
//
// WHAT IS AND IS NOT STORED — stated precisely, because an earlier draft of this header was wrong.
//
// The MASTERY corpus holds no learner-authored text at all: it is answers to questions from the
// question bank, plus that bank's own item wording, plus timing and outcome.
//
// The INTENT corpus DOES hold learner-authored text — up to 300 characters of what somebody typed
// to the tutor (distill.ts, recordTutorTurn). That is the point of it: a router cannot learn to
// recognise "I am stuck" from an aggregate. It is written only while the LLM gateway's
// capture-training switch is on, the same switch that governs the older ai_training_example corpus.
// It is never shown next to a name, and the labelling queue that does show it shows the text and
// nothing else about the person.
//
// NEVER, in either: wellness or health signals, consult messages, legal-hold records, documents,
// page URLs, or anything from the HR side of the platform.
//
// The admin console reads this store in aggregate; the one screen that shows a learner's words shows
// only the words, because the moment a screen joins those words to a name it becomes the screen
// somebody uses to judge a person.
//
// Weights live in JSONB. A checkpoint here is a few thousand numbers — small enough that the model
// is a row you can copy, diff and roll back, and portable enough to leave with the data if the
// platform ever moves host.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import type { MindSignals } from './features';
import { HashingEncoder, PretrainedEncoder, type TextEncoder } from './encoder';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type MindTask = 'mastery' | 'intent';
export type LabelSource = 'outcome' | 'human' | 'rules' | 'teacher' | 'pseudo';
export type ModelStatus = 'candidate' | 'champion' | 'retired';

export interface MindEventRow {
  id: string;
  userKey: string;
  task: MindTask;
  signals: MindSignals;
  label: number | null;
  labelSource: LabelSource | '';
  confidence: number | null;
  occurredAt: string;
}

export interface CheckpointRow {
  id: string;
  task: MindTask;
  version: number;
  featureVersion: number;
  arch: any;
  weights: any;
  clusters: any;
  metrics: any;
  status: ModelStatus;
  trainedOn: number;
  note: string;
  createdAt: string;
}

let ready: Promise<void> | null = null;

export function ensureMindSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_event (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_key TEXT NOT NULL DEFAULT '',
        task TEXT NOT NULL DEFAULT 'mastery',
        signals JSONB NOT NULL DEFAULT '{}'::jsonb,
        label REAL,
        label_source TEXT NOT NULL DEFAULT '',
        confidence REAL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_mind_event_task_idx ON aq_mind_event (task, occurred_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_mind_event_user_idx ON aq_mind_event (user_key, occurred_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_model (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task TEXT NOT NULL DEFAULT 'mastery',
        version INT NOT NULL DEFAULT 1,
        feature_version INT NOT NULL DEFAULT 1,
        arch JSONB NOT NULL DEFAULT '{}'::jsonb,
        weights JSONB NOT NULL DEFAULT '{}'::jsonb,
        clusters JSONB NOT NULL DEFAULT '{}'::jsonb,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'candidate',
        trained_on INT NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS aq_mind_model_ver_idx ON aq_mind_model (task, version)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_mind_model_status_idx ON aq_mind_model (task, status)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_run (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task TEXT NOT NULL DEFAULT 'mastery',
        modes JSONB NOT NULL DEFAULT '[]'::jsonb,
        examples INT NOT NULL DEFAULT 0,
        pseudo INT NOT NULL DEFAULT 0,
        clusters INT NOT NULL DEFAULT 0,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        promoted BOOLEAN NOT NULL DEFAULT false,
        decision TEXT NOT NULL DEFAULT '',
        version INT,
        ms INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_mind_run_idx ON aq_mind_run (task, created_at DESC)`);

      // Which encoder the platform learns through, and where the pretrained one lives. Kept in the
      // Mind's OWN table rather than added to the LLM gateway's config, so switching the tutor's
      // model and switching the learning encoder stay separate decisions.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_config (
        id TEXT PRIMARY KEY DEFAULT 'default',
        encoder TEXT NOT NULL DEFAULT 'hash',
        embed_model TEXT NOT NULL DEFAULT '',
        embed_base_url TEXT NOT NULL DEFAULT '',
        embed_api_key TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

      // Pretrained embeddings, cached by (model, text). An embedding never changes for the same text
      // and model, so this is the difference between one call per cycle and six thousand.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_embedding (
        key TEXT PRIMARY KEY,
        model TEXT NOT NULL DEFAULT '',
        dim INT NOT NULL DEFAULT 0,
        vec JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

      // A human correction of a machine label. Kept apart from the event so the original is never
      // overwritten — the disagreement itself is evidence, and a corrected label must be traceable
      // to the person who corrected it.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_mind_label (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID NOT NULL,
        label REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        labelled_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_mind_label_evt_idx ON aq_mind_label (event_id)`);
    } catch (e: any) {
      ready = null;   // let a later request retry rather than caching a cold-start failure forever
      console.error('[mind/store] schema bootstrap failed:', e?.cause?.message || e?.message);
      throw e;
    }
  })();
  return ready;
}

// ---- events -------------------------------------------------------------------------------------

export interface RecordEventInput {
  userKey: string;
  task?: MindTask;
  signals: MindSignals;
  label?: number | null;
  labelSource?: LabelSource;
  confidence?: number | null;
  occurredAt?: Date;
}

/**
 * Record one moment. Called from live request paths, so it is ONE insert and nothing else — no
 * read, no join, no featurisation. Everything derived is derived later, from this row.
 */
export async function recordEvent(i: RecordEventInput): Promise<void> {
  await ensureMindSchema();
  await db.execute(sql`INSERT INTO aq_mind_event (user_key, task, signals, label, label_source, confidence, occurred_at)
    VALUES (${i.userKey || ''}, ${i.task || 'mastery'}, ${JSON.stringify(i.signals).slice(0, 20000)}::jsonb,
            ${i.label ?? null}, ${i.labelSource || ''}, ${i.confidence ?? null}, ${(i.occurredAt || new Date()).toISOString()}::timestamptz)`);
}

/**
 * The other half of the lifecycle: a question that was SHOWN is recorded unlabelled, and this
 * attaches the outcome when it is answered.
 *
 * The update-then-insert matters. Without it the corpus would hold two rows for one question and
 * the unlabelled one would be pseudo-labelled by the model — training on its own guess about a
 * moment it already has the true answer for. With it, the rows that STAY unlabelled are exactly the
 * questions a learner walked away from, which is a real signal and the honest input to
 * semi-supervised learning.
 */
export async function recordOutcome(i: RecordEventInput & { label: number }): Promise<void> {
  await ensureMindSchema();
  const merged = JSON.stringify(i.signals).slice(0, 20000);
  const upd = rows(await db.execute(sql`
    UPDATE aq_mind_event SET signals = ${merged}::jsonb, label = ${i.label}, label_source = ${i.labelSource || 'outcome'},
      confidence = ${i.confidence ?? null}, occurred_at = ${(i.occurredAt || new Date()).toISOString()}::timestamptz
    WHERE id = (
      SELECT id FROM aq_mind_event
      WHERE user_key = ${i.userKey || ''} AND task = ${i.task || 'mastery'} AND label IS NULL
        AND signals->>'itemKey' = ${i.signals.itemKey || ''} AND occurred_at > NOW() - INTERVAL '1 day'
      ORDER BY occurred_at DESC LIMIT 1)
    RETURNING id`));
  if (!upd.length) await recordEvent({ ...i, labelSource: i.labelSource || 'outcome' });
}

/** Many moments in ONE insert — a practice session serves ten questions, not ten round trips. */
export async function recordEventsSafe(list: RecordEventInput[]): Promise<number> {
  const batch = list.slice(0, 100);
  if (!batch.length) return 0;
  try {
    await ensureMindSchema();
    const values = batch.map((i) => sql`(${i.userKey || ''}, ${i.task || 'mastery'}, ${JSON.stringify(i.signals).slice(0, 20000)}::jsonb, ${i.label ?? null}, ${i.labelSource || ''}, ${i.confidence ?? null}, ${(i.occurredAt || new Date()).toISOString()}::timestamptz)`);
    await db.execute(sql`INSERT INTO aq_mind_event (user_key, task, signals, label, label_source, confidence, occurred_at) VALUES ${sql.join(values, sql`, `)}`);
    return batch.length;
  } catch (e: any) {
    console.error('[mind/store] batch event write failed:', e?.cause?.message || e?.message);
    return 0;
  }
}

/** A label from the pretrained teacher (see distill.ts). Ranks below a human, above a rule. */
export async function setTeacherLabel(eventId: string, label: number, confidence: number): Promise<void> {
  await ensureMindSchema();
  await db.execute(sql`UPDATE aq_mind_event SET label = ${label}, label_source = 'teacher', confidence = ${confidence} WHERE id = ${eventId}::uuid`);
}

/** Fire-and-forget wrapper for live paths: a lost training row must never fail a learner's answer. */
export async function recordEventSafe(i: RecordEventInput): Promise<boolean> {
  try { await recordEvent(i); return true; } catch (e: any) {
    console.error('[mind/store] event write failed:', e?.cause?.message || e?.message);
    return false;
  }
}

function toEvent(r: any): MindEventRow {
  let signals = r.signals;
  if (typeof signals === 'string') { try { signals = JSON.parse(signals); } catch { signals = {}; } }
  return {
    id: r.id, userKey: r.user_key || '', task: (r.task || 'mastery') as MindTask,
    signals: signals || {}, label: r.label == null ? null : Number(r.label),
    labelSource: (r.label_source || '') as LabelSource, confidence: r.confidence == null ? null : Number(r.confidence),
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  };
}

/**
 * The training corpus: the MOST RECENT `limit` moments, handed back oldest-first.
 *
 * Both halves of that matter. Oldest-first because the sequence features are replayed forward
 * exactly as they were lived. Most-recent-N because the obvious `ORDER BY occurred_at ASC LIMIT n`
 * quietly stops the platform learning the moment the corpus outgrows the cap: every later cycle
 * re-reads the same oldest rows and never sees anything that happened since. The inner query takes
 * the newest window, the outer one puts it back in order.
 *
 * A human correction (aq_mind_label) overrides the recorded label here, which is the only place in
 * the system where one label beats another.
 */
export async function loadEvents(opts: { task?: MindTask; limit?: number; labelled?: boolean; days?: number } = {}): Promise<MindEventRow[]> {
  await ensureMindSchema();
  const task = opts.task || 'mastery';
  const limit = Math.max(1, Math.min(20000, opts.limit ?? 6000));
  const days = Math.max(1, Math.min(3650, opts.days ?? 400));
  const labelFilter = opts.labelled === true ? sql` AND e.label IS NOT NULL` : opts.labelled === false ? sql` AND e.label IS NULL` : sql``;
  const r = await db.execute(sql`
    SELECT * FROM (
      SELECT e.id, e.user_key, e.task, e.signals,
             COALESCE(h.label, e.label) AS label,
             CASE WHEN h.label IS NOT NULL THEN 'human' ELSE e.label_source END AS label_source,
             e.confidence, e.occurred_at
      FROM aq_mind_event e
      LEFT JOIN LATERAL (SELECT label FROM aq_mind_label l WHERE l.event_id = e.id ORDER BY created_at DESC LIMIT 1) h ON true
      WHERE e.task = ${task} AND e.occurred_at > NOW() - (${days} || ' days')::interval${labelFilter}
      ORDER BY e.occurred_at DESC
      LIMIT ${limit}
    ) w
    ORDER BY w.occurred_at ASC`);
  return rows(r).map(toEvent);
}

export async function eventStats(task: MindTask = 'mastery'): Promise<{ total: number; labelled: number; unlabelled: number; learners: number; bySource: { source: string; n: number }[]; last: string | null }> {
  await ensureMindSchema();
  const a = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(label)::int AS labelled,
           COUNT(DISTINCT user_key)::int AS learners,
           MAX(occurred_at) AS last
    FROM aq_mind_event WHERE task = ${task}`))[0] || {};
  const src = rows(await db.execute(sql`
    SELECT COALESCE(NULLIF(label_source,''),'unlabelled') AS source, COUNT(*)::int AS n
    FROM aq_mind_event WHERE task = ${task} GROUP BY 1 ORDER BY n DESC`));
  const total = Number(a.total || 0), labelled = Number(a.labelled || 0);
  return {
    total, labelled, unlabelled: total - labelled, learners: Number(a.learners || 0),
    bySource: src.map((r: any) => ({ source: r.source, n: Number(r.n) })),
    last: a.last ? (a.last instanceof Date ? a.last.toISOString() : String(a.last)) : null,
  };
}

/** One learner's own history, oldest first — used at serving time to replay their sequence state. */
export async function loadLearnerEvents(userKey: string, task: MindTask = 'mastery', limit = 300): Promise<MindEventRow[]> {
  await ensureMindSchema();
  const r = await db.execute(sql`
    SELECT id, user_key, task, signals, label, label_source, confidence, occurred_at
    FROM (SELECT * FROM aq_mind_event WHERE user_key = ${userKey} AND task = ${task}
          ORDER BY occurred_at DESC LIMIT ${Math.max(1, Math.min(1000, limit))}) t
    ORDER BY occurred_at ASC`);
  return rows(r).map(toEvent);
}

export interface QueueItem { id: string; text: string; label: number | null; labelSource: string; occurredAt: string }

/**
 * Turns waiting for a person to say what they really were.
 *
 * Returns the words and NOTHING else — no user key, no name, no session, no way to reach the person
 * from the row. That is the whole design: correcting a label needs the sentence, and needs nothing
 * about who wrote it, so the screen is built so that the identity is not there to be looked at.
 *
 * Only turns nobody has corrected yet, newest first, because a rule-labelled corpus that nobody ever
 * disagrees with is a corpus that can only ever teach a model the rules it already has.
 */
export async function labellingQueue(limit = 12): Promise<QueueItem[]> {
  await ensureMindSchema();
  const r = await db.execute(sql`
    SELECT e.id, e.signals->>'text' AS text, e.label, e.label_source, e.occurred_at
    FROM aq_mind_event e
    WHERE e.task = 'intent'
      AND COALESCE(e.signals->>'text', '') <> ''
      AND NOT EXISTS (SELECT 1 FROM aq_mind_label l WHERE l.event_id = e.id)
    ORDER BY e.occurred_at DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}`);
  return rows(r).map((x: any) => ({
    id: x.id,
    text: String(x.text || '').slice(0, 300),
    label: x.label == null ? null : Number(x.label),
    labelSource: x.label_source || '',
    occurredAt: x.occurred_at instanceof Date ? x.occurred_at.toISOString() : String(x.occurred_at),
  }));
}

export async function addHumanLabel(eventId: string, label: number, note: string, by: string): Promise<void> {
  await ensureMindSchema();
  await db.execute(sql`INSERT INTO aq_mind_label (event_id, label, note, labelled_by) VALUES (${eventId}::uuid, ${label}, ${note.slice(0, 500)}, ${by.slice(0, 120)})`);
}

// ---- checkpoints --------------------------------------------------------------------------------

function toCheckpoint(r: any): CheckpointRow {
  const parse = (v: any) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } } return v || {}; };
  return {
    id: r.id, task: (r.task || 'mastery') as MindTask, version: Number(r.version || 0),
    featureVersion: Number(r.feature_version || 1), arch: parse(r.arch), weights: parse(r.weights),
    clusters: parse(r.clusters), metrics: parse(r.metrics), status: (r.status || 'candidate') as ModelStatus,
    trainedOn: Number(r.trained_on || 0), note: r.note || '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function saveCheckpoint(i: {
  task: MindTask; featureVersion: number; arch: any; weights: any; clusters: any; metrics: any;
  status: ModelStatus; trainedOn: number; note?: string;
}): Promise<number> {
  await ensureMindSchema();
  const v = rows(await db.execute(sql`SELECT COALESCE(MAX(version),0)::int AS v FROM aq_mind_model WHERE task = ${i.task}`))[0];
  const version = Number(v?.v || 0) + 1;
  await db.execute(sql`INSERT INTO aq_mind_model (task, version, feature_version, arch, weights, clusters, metrics, status, trained_on, note)
    VALUES (${i.task}, ${version}, ${i.featureVersion}, ${JSON.stringify(i.arch)}::jsonb, ${JSON.stringify(i.weights)}::jsonb,
            ${JSON.stringify(i.clusters)}::jsonb, ${JSON.stringify(i.metrics)}::jsonb, ${i.status}, ${i.trainedOn}, ${(i.note || '').slice(0, 1000)})`);
  if (i.status === 'champion') await promoteVersion(i.task, version);
  championCache.delete(i.task);
  return version;
}

/** Exactly one champion per task, always. */
export async function promoteVersion(task: MindTask, version: number): Promise<void> {
  await ensureMindSchema();
  await db.execute(sql`UPDATE aq_mind_model SET status = 'retired' WHERE task = ${task} AND status = 'champion' AND version <> ${version}`);
  await db.execute(sql`UPDATE aq_mind_model SET status = 'champion' WHERE task = ${task} AND version = ${version}`);
  championCache.delete(task);
}

/** Retire whatever is serving and put the previous champion back. Returns the version restored. */
export async function rollback(task: MindTask): Promise<number | null> {
  await ensureMindSchema();
  const cur = rows(await db.execute(sql`SELECT version FROM aq_mind_model WHERE task = ${task} AND status = 'champion' LIMIT 1`))[0];
  const prev = rows(await db.execute(sql`
    SELECT version FROM aq_mind_model
    WHERE task = ${task} AND status = 'retired' AND version < ${Number(cur?.version || 999999)}
    ORDER BY version DESC LIMIT 1`))[0];
  if (!prev) {
    // Nothing to fall back to: retire the current one and let the platform serve its baseline again.
    if (cur) { await db.execute(sql`UPDATE aq_mind_model SET status = 'retired' WHERE task = ${task} AND version = ${cur.version}`); championCache.delete(task); }
    return null;
  }
  await promoteVersion(task, Number(prev.version));
  return Number(prev.version);
}

const CHAMPION_TTL_MS = 60_000;
const championCache = new Map<MindTask, { at: number; row: CheckpointRow | null }>();

/**
 * The checkpoint currently serving, cached briefly in process.
 *
 * Serverless means "in process" is a handful of requests, which is the point: a promotion is picked
 * up within a minute everywhere without a cache to invalidate, and a cold instance simply reads it.
 */
export async function getChampion(task: MindTask = 'mastery'): Promise<CheckpointRow | null> {
  const hit = championCache.get(task);
  if (hit && Date.now() - hit.at < CHAMPION_TTL_MS) return hit.row;
  try {
    await ensureMindSchema();
    const r = rows(await db.execute(sql`SELECT * FROM aq_mind_model WHERE task = ${task} AND status = 'champion' ORDER BY version DESC LIMIT 1`))[0];
    const row = r ? toCheckpoint(r) : null;
    championCache.set(task, { at: Date.now(), row });
    return row;
  } catch (e: any) {
    console.error('[mind/store] champion read failed:', e?.cause?.message || e?.message);
    return null;   // serving falls back to the baseline estimator, which is always available
  }
}

export async function listCheckpoints(task: MindTask = 'mastery', limit = 12): Promise<CheckpointRow[]> {
  await ensureMindSchema();
  const r = await db.execute(sql`SELECT id, task, version, feature_version, arch, '{}'::jsonb AS weights, '{}'::jsonb AS clusters, metrics, status, trained_on, note, created_at
    FROM aq_mind_model WHERE task = ${task} ORDER BY version DESC LIMIT ${limit}`);
  return rows(r).map(toCheckpoint);   // weights deliberately not selected: a list page never needs them
}

export async function recordRun(i: {
  task: MindTask; modes: string[]; examples: number; pseudo: number; clusters: number;
  metrics: any; promoted: boolean; decision: string; version?: number | null; ms: number;
}): Promise<void> {
  await ensureMindSchema();
  await db.execute(sql`INSERT INTO aq_mind_run (task, modes, examples, pseudo, clusters, metrics, promoted, decision, version, ms)
    VALUES (${i.task}, ${JSON.stringify(i.modes)}::jsonb, ${i.examples}, ${i.pseudo}, ${i.clusters},
            ${JSON.stringify(i.metrics)}::jsonb, ${i.promoted}, ${i.decision.slice(0, 800)}, ${i.version ?? null}, ${Math.round(i.ms)})`);
}

// ---- the encoder: which model the platform learns THROUGH -----------------------------------------

export interface MindConfig { encoder: 'hash' | 'pretrained'; embedModel: string; embedBaseUrl: string; embedApiKey: string }
const DEFAULT_CONFIG: MindConfig = { encoder: 'hash', embedModel: '', embedBaseUrl: '', embedApiKey: '' };

export async function getMindConfig(): Promise<MindConfig> {
  try {
    await ensureMindSchema();
    const r = rows(await db.execute(sql`SELECT * FROM aq_mind_config WHERE id = 'default' LIMIT 1`))[0];
    if (!r) return { ...DEFAULT_CONFIG };
    return {
      encoder: r.encoder === 'pretrained' ? 'pretrained' : 'hash',
      embedModel: r.embed_model || '', embedBaseUrl: r.embed_base_url || '', embedApiKey: r.embed_api_key || '',
    };
  } catch (e: any) {
    console.error('[mind/store] config read failed:', e?.cause?.message || e?.message);
    return { ...DEFAULT_CONFIG };   // the always-available encoder, never a hard failure
  }
}

export async function saveMindConfig(c: Partial<MindConfig>): Promise<void> {
  await ensureMindSchema();
  const n = { ...(await getMindConfig()), ...c };
  await db.execute(sql`INSERT INTO aq_mind_config (id, encoder, embed_model, embed_base_url, embed_api_key, updated_at)
    VALUES ('default', ${n.encoder}, ${n.embedModel}, ${n.embedBaseUrl}, ${n.embedApiKey}, NOW())
    ON CONFLICT (id) DO UPDATE SET encoder = ${n.encoder}, embed_model = ${n.embedModel},
      embed_base_url = ${n.embedBaseUrl}, embed_api_key = ${n.embedApiKey}, updated_at = NOW()`);
  encoderCache = null;
}

/** The cache the pretrained encoder writes through. */
export const embeddingCache = {
  async get(keys: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!keys.length) return out;
    await ensureMindSchema();
    // Chunked so a large cycle does not build one enormous statement.
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const r = await db.execute(sql`SELECT key, vec FROM aq_mind_embedding WHERE key IN (${sql.join(chunk.map((k) => sql`${k}`), sql`, `)})`);
      for (const row of rows(r)) {
        let v = (row as any).vec;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
        if (Array.isArray(v)) out.set((row as any).key, v.map(Number));
      }
    }
    return out;
  },
  async put(entries: { key: string; model: string; vec: number[] }[]): Promise<void> {
    if (!entries.length) return;
    await ensureMindSchema();
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const values = chunk.map((e) => sql`(${e.key}, ${e.model}, ${e.vec.length}, ${JSON.stringify(e.vec)}::jsonb)`);
      await db.execute(sql`INSERT INTO aq_mind_embedding (key, model, dim, vec) VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (key) DO NOTHING`);
    }
  },
};

let encoderCache: { at: number; encoder: TextEncoder; note: string } | null = null;

/**
 * The encoder in force right now.
 *
 * Pretrained if an administrator has chosen it AND there is somewhere to call — falling back to the
 * embedding endpoint configured here, or failing that to the LLM gateway's own self-hosted base URL,
 * so a platform that already runs its own model does not have to configure it twice. Otherwise the
 * hashing encoder, which always works.
 */
export async function resolveEncoder(): Promise<{ encoder: TextEncoder; note: string }> {
  if (encoderCache && Date.now() - encoderCache.at < 60_000) return { encoder: encoderCache.encoder, note: encoderCache.note };
  const cfg = await getMindConfig();
  let encoder: TextEncoder = new HashingEncoder();
  let note = 'Hashing encoder: no pretrained model in the loop. Free, offline, meaning-blind.';

  if (cfg.encoder === 'pretrained') {
    let baseUrl = cfg.embedBaseUrl.trim();
    let apiKey = cfg.embedApiKey.trim();
    if (!baseUrl) {
      try {
        const { getConfig } = await import('@/lib/llm/gateway');
        const g = await getConfig();
        if (g.provider === 'own' && g.baseUrl) { baseUrl = g.baseUrl; apiKey = apiKey || g.apiKey; }
      } catch { /* the gateway is optional here, as it is everywhere else */ }
    }
    if (baseUrl && cfg.embedModel.trim()) {
      encoder = new PretrainedEncoder({ baseUrl, model: cfg.embedModel.trim(), apiKey }, embeddingCache);
      note = 'Pretrained embeddings from ' + cfg.embedModel.trim() + ' at ' + baseUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1') + ', projected to ' + encoder.dim + ' dimensions.';
    } else {
      note = 'Pretrained encoding is selected but incomplete (a model name and an endpoint are both required), so the hashing encoder is still in force. Nothing is broken; nothing is pretending either.';
    }
  }
  encoderCache = { at: Date.now(), encoder, note };
  return { encoder, note };
}

export function invalidateEncoderCache(): void { encoderCache = null; }

export async function listRuns(task: MindTask = 'mastery', limit = 15): Promise<any[]> {
  await ensureMindSchema();
  const r = await db.execute(sql`SELECT * FROM aq_mind_run WHERE task = ${task} ORDER BY created_at DESC LIMIT ${limit}`);
  return rows(r).map((x: any) => ({
    ...x,
    modes: typeof x.modes === 'string' ? JSON.parse(x.modes) : x.modes,
    metrics: typeof x.metrics === 'string' ? JSON.parse(x.metrics) : x.metrics,
  }));
}
