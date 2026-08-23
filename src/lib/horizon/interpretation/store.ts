// src/lib/horizon/interpretation/store.ts — RECORDING WHAT WAS SAID ABOUT A PERSON, AND WHO SAW IT.
//
// =================================================================================================
// WHY AN INTERPRETATION IS STORED AT ALL
// =================================================================================================
//
// It would be simpler to compute on every page load and keep nothing. Three obligations make that
// the wrong choice:
//
//   AUDITABILITY. A high-impact indication has to be reviewable after the fact. "What did the system
//   say about this person on the day that conversation happened" is a question with an answer only
//   if the answer was written down, together with the fingerprint of the input that produced it.
//
//   TIME. An employee profile is continuously updated as evidence changes. A single current value
//   cannot show that a dimension moved, and a dimension that moved is far more interesting — and far
//   more in need of a human's eye — than one that sat still.
//
//   THE RIGHT TO SEE AND OBJECT. A person may ask what was recorded about them and disagree with it
//   on the record. That requires a record.
//
// =================================================================================================
// WHAT IS DELIBERATELY NOT STORED
// =================================================================================================
//
// The upstream factor CODES, the upstream NOTES, and any raw foundational value. The trace table
// holds factor IDS, the method identifier and the arithmetic — enough to reproduce and to walk back
// to PATCH 02, which owns those values and is the correct place to ask. Copying them here would put
// a second, unowned copy of sensitive derived data in a table with a different access population.
//
// No table here duplicates a concept another patch owns: consent is a REFERENCE into whatever store
// records it, evidence is a REFERENCE into the module that owns it, and access logging goes to the
// existing `audit_log` through src/lib/audit.ts rather than into a private log nobody else can read.
//
// =================================================================================================
// ACCESS IS LOGGED BEFORE ANYTHING IS RETURNED, AND THE LOG IS THE CONTROL
// =================================================================================================
//
// On the precedent src/lib/legal-hold.ts already sets for sensitive reads: the audit row is written
// with logAuditOrThrow() BEFORE the interpretation is handed back, and a failed write means the
// caller gets a refusal rather than the data. An unlogged look at an inference about a named person
// is exactly the access nobody can answer for afterwards.
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import { logAudit, logAuditOrThrow } from '@/lib/audit';
import {
  interpret,
  projectForViewer,
  ENGINE_VERSION,
  type DimensionInterpretation,
  type InterpretationResult,
  type ViewerCapabilities,
} from './engine';
import {
  fetchFoundationalFactors,
  foundationalProviderName,
  isSubject,
  type FoundationalFactorSet,
  type HorizonSubject,
} from './contract';
import { fetchEvidenceContext } from './evidence';
import { DIMENSIONS, LEVEL_RANK, isDimensionId, type DimensionId, type DimensionLevel } from './dimensions';

const MOD = '[horizon-interpretation]';
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) => console.error(MOD + ' ' + tag, e?.cause?.message || e?.message);

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

// =================================================================================================
// SCHEMA
// =================================================================================================
//
// Sent as ONE simple-protocol message (ensureBatch), on the precedent set across this codebase in
// commit 1a05712: a cold serverless instance pays a full round trip per statement otherwise, and
// this bootstrap sits in front of the first read on the page. There is no ALTER here — only CREATE
// ... IF NOT EXISTS on tables this patch owns outright — so the lock-contention hazard that keeps
// other modules' ALTERs out of their batches does not apply.

export function ensureHorizonInterpretationSchema(): Promise<void> {
  return ensureBatch(
    'horizon_interpretation_v1',
    `
CREATE TABLE IF NOT EXISTS horizon_interpretations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  input_digest TEXT NOT NULL DEFAULT '',
  input_source_module TEXT NOT NULL DEFAULT '',
  input_source_version TEXT NOT NULL DEFAULT '',
  input_computed_at TIMESTAMPTZ,
  input_complete BOOLEAN NOT NULL DEFAULT false,
  consent_ref TEXT,
  factors_considered INTEGER NOT NULL DEFAULT 0,
  unmapped_factor_count INTEGER NOT NULL DEFAULT 0,
  dropped_factor_count INTEGER NOT NULL DEFAULT 0,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  problems JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);
CREATE INDEX IF NOT EXISTS horizon_interp_subject_idx
  ON horizon_interpretations (subject_kind, subject_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS horizon_interp_digest_idx ON horizon_interpretations (input_digest);

CREATE TABLE IF NOT EXISTS horizon_dimension_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id UUID NOT NULL REFERENCES horizon_interpretations(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  level TEXT NOT NULL,
  score NUMERIC(6,3) NOT NULL DEFAULT 0,
  confidence NUMERIC(5,3) NOT NULL DEFAULT 0,
  confidence_band TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  implications JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  precedence TEXT NOT NULL DEFAULT 'evidence_unknown',
  precedence_note TEXT NOT NULL DEFAULT '',
  superseded BOOLEAN NOT NULL DEFAULT false,
  evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  explainability JSONB NOT NULL DEFAULT '{}'::jsonb,
  redactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  contributing_factor_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS horizon_dim_interp_idx ON horizon_dimension_results (interpretation_id);
CREATE INDEX IF NOT EXISTS horizon_dim_name_idx ON horizon_dimension_results (dimension);

CREATE TABLE IF NOT EXISTS horizon_dimension_factors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id UUID NOT NULL REFERENCES horizon_interpretations(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  factor_id TEXT NOT NULL,
  share NUMERIC(6,3) NOT NULL DEFAULT 0,
  direction TEXT NOT NULL DEFAULT 'neutral',
  confidence NUMERIC(5,3) NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  method_version TEXT NOT NULL DEFAULT '',
  mass NUMERIC(7,4) NOT NULL DEFAULT 0,
  polarity NUMERIC(5,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS horizon_factor_interp_idx ON horizon_dimension_factors (interpretation_id);
CREATE INDEX IF NOT EXISTS horizon_factor_id_idx ON horizon_dimension_factors (factor_id);
`,
  );
}

// =================================================================================================
// WRITE
// =================================================================================================

export interface SaveResult {
  ok: boolean;
  interpretationId: string | null;
  error?: string;
}

/**
 * Persist one interpretation, dimensions and trace.
 *
 * A NON-OK RESULT IS STILL STORED. `refused`, `not_configured` and `insufficient_input` are the most
 * important rows in this table: they are the proof that on a given day the system declined to say
 * anything about somebody, which is precisely the record that disappears if only successes are kept.
 */
export async function saveInterpretation(
  result: InterpretationResult,
  createdBy: string | null,
): Promise<SaveResult> {
  if (!result || !isSubject(result.subject as any)) {
    return { ok: false, interpretationId: null, error: 'No subject to store an interpretation against.' };
  }
  try {
    await ensureHorizonInterpretationSchema();
    const db = await database();
    const subject = result.subject!;
    const inserted = rows(
      await db.execute(sql`
        INSERT INTO horizon_interpretations (
          subject_kind, subject_id, engine_version, state, reason, input_digest,
          input_source_module, input_source_version, input_computed_at, input_complete,
          consent_ref, factors_considered, unmapped_factor_count, dropped_factor_count,
          redaction_count, problems, generated_at, created_by
        ) VALUES (
          ${subject.kind}, ${subject.id}, ${result.engineVersion || ENGINE_VERSION}, ${result.state},
          ${result.reason || null}, ${result.inputDigest || ''},
          ${result.inputSourceModule || ''}, ${result.inputSourceVersion || ''},
          ${result.inputComputedAt ? new Date(result.inputComputedAt) : null}, ${!!result.inputComplete},
          ${result.consentRef || null}, ${result.factorsConsidered || 0},
          ${result.unmappedFactorCount || 0}, ${result.droppedFactorCount || 0},
          ${result.redactionCount || 0}, ${JSON.stringify(result.problems || [])}::jsonb,
          ${new Date(result.generatedAt || Date.now())}, ${createdBy || null}
        ) RETURNING id`),
    );
    const id = inserted[0]?.id;
    if (!id) return { ok: false, interpretationId: null, error: 'The interpretation row was not returned.' };

    // One statement for the dimensions and one for the trace, rather than one per row. A person with
    // twelve dimensions and forty inputs is fifty-two round trips the naive way, on a page that has
    // already paid for the schema bootstrap.
    if (result.dimensions.length) {
      const values = result.dimensions.map(
        (d) => sql`(${id}::uuid, ${d.dimension}, ${d.level}, ${d.score}, ${d.confidence}, ${d.confidenceBand},
          ${d.explanation}, ${JSON.stringify(d.implications)}::jsonb, ${JSON.stringify(d.limitations)}::jsonb,
          ${d.precedence}, ${d.precedenceNote}, ${d.supersededByEvidence},
          ${JSON.stringify(d.evidenceSources)}::jsonb, ${JSON.stringify(d.explainability)}::jsonb,
          ${JSON.stringify(d.redactions)}::jsonb, ${d.contributingFactorCount})`,
      );
      await db.execute(sql`
        INSERT INTO horizon_dimension_results (
          interpretation_id, dimension, level, score, confidence, confidence_band,
          explanation, implications, limitations, precedence, precedence_note, superseded,
          evidence_sources, explainability, redactions, contributing_factor_count
        ) VALUES ${sql.join(values, sql`, `)}`);

      const traceValues: any[] = [];
      for (const d of result.dimensions) {
        for (const t of d.trace || []) {
          traceValues.push(
            sql`(${id}::uuid, ${d.dimension}, ${t.factorId}, ${t.share}, ${t.direction}, ${t.confidence},
              ${t.method}, ${t.methodVersion}, ${t.mass}, ${t.polarity})`,
          );
        }
      }
      if (traceValues.length) {
        await db.execute(sql`
          INSERT INTO horizon_dimension_factors (
            interpretation_id, dimension, factor_id, share, direction, confidence,
            method, method_version, mass, polarity
          ) VALUES ${sql.join(traceValues, sql`, `)}`);
      }
    }

    // Not strict: the interpretation is already durable at this point, and losing the activity row
    // must not roll back a record whose absence is the bigger problem. The READ path is strict.
    await logAudit({
      userId: createdBy,
      action: 'horizon.interpretation.computed',
      entity: 'horizon_interpretation',
      entityId: String(id),
      diff: {
        subjectKind: subject.kind,
        subjectId: subject.id,
        state: result.state,
        engineVersion: result.engineVersion,
        inputDigest: result.inputDigest,
        dimensions: result.dimensions.length,
        redactions: result.redactionCount,
      },
    });
    return { ok: true, interpretationId: String(id) };
  } catch (e: any) {
    logFail('saveInterpretation', e);
    return { ok: false, interpretationId: null, error: e?.cause?.message || e?.message };
  }
}

// =================================================================================================
// ORCHESTRATION
// =================================================================================================

export interface InterpretSubjectOptions {
  /** Who asked. Recorded on the row and in the audit log. */
  actorUserId: string | null;
  /** Persist the result. Off for a dry run from an admin console. */
  persist?: boolean;
  /** Hand the factor set in directly instead of asking the registered provider. Used by tests and by
   *  a caller that has already fetched it; never by a request path. */
  factorSet?: FoundationalFactorSet;
  requireConsent?: boolean;
  now?: string;
}

export interface InterpretSubjectOutcome {
  result: InterpretationResult;
  interpretationId: string | null;
  /** Which upstream answered, for the surface to print. Empty when none is connected. */
  providerName: string;
}

/**
 * The whole path: ask PATCH 02, ask the evidence side, interpret, store.
 *
 * Never throws. Every failure mode is a state on the returned result, because the four ways this can
 * come back empty — no provider, provider refused, provider unreadable, nothing mapped — need four
 * different sentences on the screen and would otherwise all render as "no interpretation available".
 */
export async function interpretSubject(
  subject: HorizonSubject,
  opts: InterpretSubjectOptions,
): Promise<InterpretSubjectOutcome> {
  const providerName = foundationalProviderName();
  const empty = (state: InterpretationResult['state'], reason: string): InterpretationResult => ({
    state,
    reason,
    subject: isSubject(subject) ? subject : null,
    engineVersion: ENGINE_VERSION,
    inputDigest: '',
    inputSourceModule: '',
    inputSourceVersion: '',
    inputComputedAt: '',
    inputComplete: false,
    consentRef: null,
    dimensions: [],
    factorsConsidered: 0,
    unmappedFactorCount: 0,
    droppedFactorCount: 0,
    redactionCount: 0,
    generatedAt: opts.now || new Date().toISOString(),
    notice:
      'No professional interpretation was produced. Nothing here should be read as a finding about this person.',
    problems: [],
  });

  if (!isSubject(subject)) {
    return { result: empty('refused', 'No person was named.'), interpretationId: null, providerName };
  }

  let set = opts.factorSet;
  if (!set) {
    const upstream = await fetchFoundationalFactors(subject, { actorUserId: opts.actorUserId });
    if (upstream.state !== 'ok' || !upstream.set) {
      const result = empty(
        upstream.state === 'not_configured' ? 'not_configured' : upstream.state === 'refused' ? 'refused' : 'unreadable',
        upstream.reason || 'The foundational input source produced nothing.',
      );
      const saved = opts.persist ? await saveInterpretation(result, opts.actorUserId) : null;
      return { result, interpretationId: saved?.interpretationId || null, providerName };
    }
    set = upstream.set;
  }

  const evidence = await fetchEvidenceContext(subject);
  const result = interpret(set, { evidence, now: opts.now, requireConsent: opts.requireConsent });
  const saved = opts.persist ? await saveInterpretation(result, opts.actorUserId) : null;
  return { result, interpretationId: saved?.interpretationId || null, providerName };
}

// =================================================================================================
// READ
// =================================================================================================

export interface ReadOptions {
  actorUserId: string | null;
  caps: ViewerCapabilities;
  /** Why this person's interpretation is being opened. Required, and stored with the access row —
   *  "why were you looking at that" must have an answer that is not "I was curious". */
  purpose: string;
}

export interface StoredInterpretation {
  id: string;
  result: InterpretationResult;
}

/**
 * The most recent interpretation on record for a subject, projected for this viewer.
 *
 * FAIL CLOSED. If the access cannot be written to the audit log, nothing is returned: a refusal is
 * the correct outcome of a read that could not be recorded.
 */
export async function latestInterpretation(
  subject: HorizonSubject,
  opts: ReadOptions,
): Promise<{ ok: boolean; found: boolean; interpretation: StoredInterpretation | null; error?: string }> {
  if (!isSubject(subject)) return { ok: false, found: false, interpretation: null, error: 'No person was named.' };
  if (!opts.caps?.view) {
    return { ok: false, found: false, interpretation: null, error: 'This account may not view professional interpretations.' };
  }
  if (!String(opts.purpose || '').trim()) {
    return { ok: false, found: false, interpretation: null, error: 'A stated purpose is required to open an interpretation.' };
  }
  try {
    await logAuditOrThrow({
      userId: opts.actorUserId,
      action: opts.caps.trace ? 'horizon.interpretation.trace_viewed' : 'horizon.interpretation.viewed',
      entity: 'horizon_subject',
      entityId: subject.kind + ':' + subject.id,
      diff: { purpose: String(opts.purpose).slice(0, 500), trace: !!opts.caps.trace },
    });
  } catch (e: any) {
    logFail('latestInterpretation.audit', e);
    return {
      ok: false,
      found: false,
      interpretation: null,
      error: 'This access could not be written to the audit log, so nothing was shown.',
    };
  }

  try {
    await ensureHorizonInterpretationSchema();
    const db = await database();
    const head = rows(
      await db.execute(sql`
        SELECT * FROM horizon_interpretations
        WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
        ORDER BY generated_at DESC LIMIT 1`),
    );
    if (!head.length) return { ok: true, found: false, interpretation: null };
    const h = head[0];
    const dims = rows(
      await db.execute(sql`
        SELECT * FROM horizon_dimension_results WHERE interpretation_id = ${h.id}::uuid ORDER BY dimension`),
    );
    const traces = opts.caps.trace
      ? rows(
          await db.execute(sql`
            SELECT * FROM horizon_dimension_factors WHERE interpretation_id = ${h.id}::uuid
            ORDER BY dimension, mass DESC`),
        )
      : [];

    const byDim = new Map<string, any[]>();
    for (const t of traces) {
      if (!byDim.has(t.dimension)) byDim.set(t.dimension, []);
      byDim.get(t.dimension)!.push(t);
    }

    const dimensions: DimensionInterpretation[] = dims
      .filter((d: any) => isDimensionId(d.dimension))
      .map((d: any) => {
        const spec = DIMENSIONS[d.dimension as DimensionId];
        const trace = (byDim.get(d.dimension) || []).map((t: any) => ({
          factorId: String(t.factor_id),
          share: Number(t.share),
          direction: t.direction,
          confidence: Number(t.confidence),
          method: String(t.method || ''),
          methodVersion: String(t.method_version || ''),
          mass: Number(t.mass),
          polarity: Number(t.polarity),
        }));
        return {
          dimension: d.dimension as DimensionId,
          label: spec.label,
          description: spec.description,
          notAbout: spec.notAbout,
          level: d.level as DimensionLevel,
          levelLabel: d.level,
          score: Number(d.score),
          confidence: Number(d.confidence),
          confidenceBand: d.confidence_band,
          confidenceLabel: d.confidence_band,
          contributingFactors: trace.map((t) => ({
            factorId: t.factorId,
            share: t.share,
            direction: t.direction,
            confidence: t.confidence,
          })),
          contributingFactorCount: Number(d.contributing_factor_count || 0),
          explanation: String(d.explanation || ''),
          implications: Array.isArray(d.implications) ? d.implications : [],
          limitations: Array.isArray(d.limitations) ? d.limitations : [],
          precedence: d.precedence,
          precedenceNote: String(d.precedence_note || ''),
          supersededByEvidence: !!d.superseded,
          evidenceSources: Array.isArray(d.evidence_sources) ? d.evidence_sources : [],
          notForDecisions: true,
          computedAt: new Date(h.generated_at).toISOString(),
          explainability: d.explainability || {},
          redactions: Array.isArray(d.redactions) ? d.redactions : [],
          trace,
        } as DimensionInterpretation;
      });

    const result: InterpretationResult = {
      state: h.state,
      reason: h.reason || undefined,
      subject,
      engineVersion: String(h.engine_version || ''),
      inputDigest: String(h.input_digest || ''),
      inputSourceModule: String(h.input_source_module || ''),
      inputSourceVersion: String(h.input_source_version || ''),
      inputComputedAt: h.input_computed_at ? new Date(h.input_computed_at).toISOString() : '',
      inputComplete: !!h.input_complete,
      consentRef: h.consent_ref || null,
      dimensions,
      factorsConsidered: Number(h.factors_considered || 0),
      unmappedFactorCount: Number(h.unmapped_factor_count || 0),
      droppedFactorCount: Number(h.dropped_factor_count || 0),
      redactionCount: Number(h.redaction_count || 0),
      generatedAt: new Date(h.generated_at).toISOString(),
      notice: '',
      problems: Array.isArray(h.problems) ? h.problems : [],
    };
    // The standing notice is re-attached from the engine constant rather than read back from the
    // row, so an old record cannot show a softer disclaimer than the one currently in force.
    const { NOT_FOR_DECISIONS_NOTICE } = await import('./engine');
    result.notice = NOT_FOR_DECISIONS_NOTICE;

    return {
      ok: true,
      found: true,
      interpretation: { id: String(h.id), result: projectForViewer(result, opts.caps) },
    };
  } catch (e: any) {
    logFail('latestInterpretation', e);
    return { ok: false, found: false, interpretation: null, error: 'The stored interpretations could not be read.' };
  }
}

// =================================================================================================
// CHANGE OVER TIME
// =================================================================================================

export interface DimensionMovement {
  dimension: DimensionId;
  label: string;
  from: DimensionLevel;
  to: DimensionLevel;
  direction: 'up' | 'down' | 'unchanged';
  atFrom: string;
  atTo: string;
}

export interface HistoryEntry {
  id: string;
  state: string;
  generatedAt: string;
  inputDigest: string;
  dimensionCount: number;
}

/**
 * The run history for a subject, plus what moved between the two most recent runs.
 *
 * A MOVEMENT IS NOT A TREND. Two points are two points; nothing here fits a line, projects forward
 * or calls a direction. What it does is surface a CHANGE so a human can ask why, which is the only
 * use a dimension's history has in this system.
 */
export async function interpretationHistory(
  subject: HorizonSubject,
  opts: ReadOptions & { limit?: number },
): Promise<{ ok: boolean; entries: HistoryEntry[]; movements: DimensionMovement[]; error?: string }> {
  if (!isSubject(subject) || !opts.caps?.view) {
    return { ok: false, entries: [], movements: [], error: 'Not permitted.' };
  }
  try {
    await logAuditOrThrow({
      userId: opts.actorUserId,
      action: 'horizon.interpretation.history_viewed',
      entity: 'horizon_subject',
      entityId: subject.kind + ':' + subject.id,
      diff: { purpose: String(opts.purpose || '').slice(0, 500) },
    });
  } catch (e: any) {
    logFail('interpretationHistory.audit', e);
    return { ok: false, entries: [], movements: [], error: 'This access could not be logged, so nothing was shown.' };
  }

  try {
    await ensureHorizonInterpretationSchema();
    const db = await database();
    const limit = Math.max(2, Math.min(50, opts.limit || 12));
    const heads = rows(
      await db.execute(sql`
        SELECT i.id, i.state, i.generated_at, i.input_digest,
               (SELECT COUNT(*) FROM horizon_dimension_results r WHERE r.interpretation_id = i.id) AS dimension_count
        FROM horizon_interpretations i
        WHERE i.subject_kind = ${subject.kind} AND i.subject_id = ${subject.id}
        ORDER BY i.generated_at DESC
        LIMIT ${limit}`),
    );
    const entries: HistoryEntry[] = heads.map((h: any) => ({
      id: String(h.id),
      state: String(h.state),
      generatedAt: new Date(h.generated_at).toISOString(),
      inputDigest: String(h.input_digest || ''),
      dimensionCount: Number(h.dimension_count || 0),
    }));

    const ok = heads.filter((h: any) => h.state === 'ok');
    if (ok.length < 2) return { ok: true, entries, movements: [] };

    const [newer, older] = ok;
    const levels = rows(
      await db.execute(sql`
        SELECT interpretation_id, dimension, level FROM horizon_dimension_results
        WHERE interpretation_id IN (${newer.id}::uuid, ${older.id}::uuid)`),
    );
    const map = new Map<string, Record<string, string>>();
    for (const r of levels) {
      const key = String(r.interpretation_id);
      if (!map.has(key)) map.set(key, {});
      map.get(key)![r.dimension] = r.level;
    }
    const a = map.get(String(older.id)) || {};
    const b = map.get(String(newer.id)) || {};
    const movements: DimensionMovement[] = [];
    for (const dim of Object.keys(b)) {
      if (!isDimensionId(dim) || !a[dim]) continue;
      const from = a[dim] as DimensionLevel;
      const to = b[dim] as DimensionLevel;
      if (from === to) continue;
      movements.push({
        dimension: dim,
        label: DIMENSIONS[dim].label,
        from,
        to,
        direction: LEVEL_RANK[to] > LEVEL_RANK[from] ? 'up' : 'down',
        atFrom: new Date(older.generated_at).toISOString(),
        atTo: new Date(newer.generated_at).toISOString(),
      });
    }
    return { ok: true, entries, movements };
  } catch (e: any) {
    logFail('interpretationHistory', e);
    return { ok: false, entries: [], movements: [], error: 'The interpretation history could not be read.' };
  }
}

/**
 * A person's own disagreement, recorded against an interpretation.
 *
 * No new table: this is an audit row, which is append-only, timestamped and already readable by the
 * people who would need to see it. One person's objection does not silently rewrite the record — it
 * sits beside it, which is the same rule this system applies to every other single source.
 */
export async function recordObjection(args: {
  interpretationId: string;
  byUserId: string | null;
  dimension?: DimensionId | null;
  statement: string;
}): Promise<{ ok: boolean; error?: string }> {
  const statement = String(args.statement || '').trim();
  if (!args.interpretationId || !statement) {
    return { ok: false, error: 'An objection needs an interpretation and a written statement.' };
  }
  try {
    await logAuditOrThrow({
      userId: args.byUserId,
      action: 'horizon.interpretation.objection',
      entity: 'horizon_interpretation',
      entityId: String(args.interpretationId),
      diff: { dimension: args.dimension || null, statement: statement.slice(0, 2000) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('recordObjection', e);
    return { ok: false, error: 'The objection could not be recorded, so it has not been accepted.' };
  }
}
