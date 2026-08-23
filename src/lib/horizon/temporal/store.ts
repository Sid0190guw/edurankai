// src/lib/horizon/temporal/store.ts — VERSIONED LONG HORIZONS, ON THE SHARED HORIZON TABLES.
//
// =================================================================================================
// THIS MODULE OWNS NO TABLES
// =================================================================================================
//
// It started out owning two — `horizon_readings` and `horizon_reading_evidence` — and they were
// deleted before they ever reached a database, because src/lib/horizon/schema.ts already owns
// `hzn_intelligence_result` and `hzn_evidence` and they are the same two tables with better names.
// A second store for the same concept is precisely the duplication the multi-agent rules forbid, and
// the cost of it is not tidiness: two tables holding "what the system said about this person" means
// an appeal reads one of them and the screen reads the other.
//
// So Patch 07 writes into the shared contract:
//
//   hzn_computation          one row per RUN of this engine. The provenance anchor.
//   hzn_intelligence_result  one row per horizon per run, superseding the previous one.
//   hzn_evidence             one row per source that fed a result, INCLUDING the unreadable ones.
//
// dimension_family is `temporal_pattern`, which the shared contract already defines and which no
// other patch claims. dimension_key is `horizon.<key>`, so the four versioned horizons are four
// dimensions of one family and each supersedes only itself.
//
// =================================================================================================
// SUPERSEDE, NEVER UPDATE
// =================================================================================================
//
// A long-horizon reading is a statement about somebody that may be quoted in a development
// conversation months later. When the engine or the evidence changes, the sentence that was actually
// shown at the time must still be recoverable, so a recompute marks the old row `superseded` and
// inserts a new one pointing back at it through `supersedes`. Nothing is ever edited in place.
//
// SHORT HORIZONS ARE NEVER WRITTEN AT ALL. Recent, This Week and This Month are recomputed on every
// read. storeReading() refuses them rather than storing them, because a stored copy of "this week"
// is wrong within hours while still looking authoritative.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isUuid } from '@/lib/performance-scope';
import { rowsOf, reasonOf, truncateReason } from '../pg';
import { ensureHorizonSchema } from '../schema';
import { VERSIONED_HORIZONS, HORIZON_SPECS, type Horizon, isHorizon } from './time';
import { gatherEvidence } from './evidence';
import { buildAll, ENGINE_VERSION, type HorizonReading, type HorizonSet } from './engine';

const MOD = 'horizon/temporal/store';

/** The identity this engine writes under. Every row it produces carries these three. */
export const ENGINE_ID = 'horizon.temporal';
export const ENGINE_CLASS = 'deterministic';
export const DIMENSION_FAMILY = 'temporal_pattern';

export function dimensionKeyFor(h: Horizon): string {
  return 'horizon.' + h;
}

const logFail = (tag: string, e: any) => console.error('[' + MOD + '] ' + tag + ': ' + reasonOf(e));

/**
 * My four confidence bands mapped onto the shared contract's three.
 *
 * `none` maps to `low` rather than to a fourth band, and the numeric value plus the basis sentence
 * carry the difference. A band of `low` beside a value of 0 and a basis that says there is no
 * evidence is honest; inventing a band the contract does not have would break every consumer.
 */
function bandFor(v: number): 'low' | 'moderate' | 'high' {
  if (v < 0.2) return 'low';
  if (v < 0.5) return 'moderate';
  return 'high';
}

/**
 * The overall direction a reading carries, as a categorical value.
 *
 * A horizon reading is NOT a score and must never be stored as one, so score_kind is `categorical`
 * over a fixed option list, or `not_computed` when nothing could be read. There is no numeric
 * summary of a person anywhere in this write path.
 */
const DIRECTION_OPTIONS = ['evidenced', 'partially_evidenced', 'no_record', 'unreadable'] as const;

function categoryFor(r: HorizonReading): (typeof DIRECTION_OPTIONS)[number] {
  if (r.blind) return 'unreadable';
  const live = r.evidenceSources.filter((s) => !s.unreadable);
  const withRows = live.filter((s) => s.rowCount > 0);
  if (!withRows.length) return 'no_record';
  if (live.length < r.evidenceSources.length || withRows.length < 3) return 'partially_evidenced';
  return 'evidenced';
}

function summaryFor(r: HorizonReading): string {
  if (r.blind) {
    return 'No evidence source could be read, so the ' + r.label
      + ' horizon says nothing about this person. This is an outage in our records, not a finding.';
  }
  const signals = r.sections.reduce((a, s) => a + s.signals.length, 0);
  return r.label + ': ' + signals + ' observations across ' + r.sections.length
    + ' sections, from ' + r.evidenceSources.filter((s) => !s.unreadable && s.rowCount > 0).length
    + ' evidence sources. ' + r.confidence.sentence;
}

// =================================================================================================
// THE RUN
// =================================================================================================

export interface ComputationRun {
  id: string;
  startedAt: string;
}

/** Open a run. Every result written afterwards cites it, which is what makes a batch reconstructable. */
export async function startRun(employeeId: string, reason: string): Promise<ComputationRun | null> {
  try {
    await ensureHorizonSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hzn_computation (
        engine_id, engine_class, engine_version, subject_kind, subject_id, subject_scheme,
        trigger_reason, input_summary, status
      ) VALUES (
        ${ENGINE_ID}, ${ENGINE_CLASS}, ${ENGINE_VERSION}, 'employee', ${employeeId}, 'hr_employee',
        ${reason}, ${JSON.stringify({ horizons: VERSIONED_HORIZONS })}::jsonb, 'running'
      ) RETURNING id, started_at`));
    if (!rows.length) return null;
    return { id: String(rows[0].id), startedAt: new Date(rows[0].started_at).toISOString() };
  } catch (e: any) {
    logFail('startRun', e);
    return null;
  }
}

export async function finishRun(runId: string, outcome: 'succeeded' | 'refused' | 'failed', detail: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE hzn_computation
         SET status = 'finished', outcome = ${outcome}, detail = ${truncateReason(detail)},
             finished_at = NOW(),
             duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int)
       WHERE id = ${runId}::uuid`);
  } catch (e: any) {
    logFail('finishRun', e);
  }
}

// =================================================================================================
// WRITING A RESULT
// =================================================================================================

export interface StoreResult {
  ok: boolean;
  id?: string;
  supersededId?: string | null;
  error?: string;
}

/**
 * Write one horizon as the new active result, superseding whatever was active for that dimension.
 *
 * ONE STATEMENT. The CTE marks the previous active row superseded and returns its id, and the INSERT
 * takes that id as `supersedes` in the same statement. Two separate statements would have a gap
 * between them, and a concurrent recompute landing in the gap leaves two active rows for one
 * dimension with nothing afterwards able to say which one a screen showed.
 */
export async function storeReading(
  employeeId: string,
  horizon: Horizon,
  reading: HorizonReading,
  runId: string,
): Promise<StoreResult> {
  if (!isUuid(employeeId)) return { ok: false, error: 'employee id is not a uuid' };
  if (!isHorizon(horizon)) return { ok: false, error: 'not a horizon: ' + horizon };
  if (HORIZON_SPECS[horizon].cadence !== 'versioned') {
    return {
      ok: false,
      error: horizon + ' is a live horizon and is never stored. A stored copy would go stale silently while still looking current.',
    };
  }

  const spec = HORIZON_SPECS[horizon];
  const conf = reading.confidence;
  const category = categoryFor(reading);
  const scorePayload = reading.blind
    ? { kind: 'not_computed', reason: 'every evidence source was unreadable' }
    : { kind: 'categorical', category, options: DIRECTION_OPTIONS, reading };
  const days = spec.recomputeEveryDays ?? 30;

  try {
    await ensureHorizonSchema();
    const rows = rowsOf(await db.execute(sql`
      WITH prior AS (
        UPDATE hzn_intelligence_result
           SET status = 'superseded'
         WHERE subject_id = ${employeeId} AND subject_kind = 'employee'
           AND dimension_family = ${DIMENSION_FAMILY} AND dimension_key = ${dimensionKeyFor(horizon)}
           AND status = 'active'
        RETURNING id
      )
      INSERT INTO hzn_intelligence_result (
        subject_kind, subject_id, subject_scheme,
        dimension_family, dimension_key, dimension_label,
        score_kind, score_payload,
        confidence_band, confidence_value, confidence_basis,
        status, summary, source_breakdown,
        stale_at, recompute_after_days,
        computation_id, engine_id, engine_class, engine_version,
        human_review_status, layer, decision_use, scientific_status,
        supersedes, unreadable
      )
      SELECT
        'employee', ${employeeId}, 'hr_employee',
        ${DIMENSION_FAMILY}, ${dimensionKeyFor(horizon)}, ${reading.label},
        ${reading.blind ? 'not_computed' : 'categorical'}, ${JSON.stringify(scorePayload)}::jsonb,
        ${bandFor(conf.value)}, ${conf.value}, ${truncateReason(conf.sentence)},
        ${reading.blind ? 'unreadable' : 'active'}, ${truncateReason(summaryFor(reading))},
        ${JSON.stringify(reading.evidenceSources.map((s) => ({
          source: s.table, owner: s.owner, rows: s.unreadable ? 0 : s.rowCount,
          verified: s.unreadable ? 0 : s.verifiedRowCount, unreadable: s.unreadable, note: s.because,
        })))}::jsonb,
        NOW() + (${days}::text || ' days')::interval, ${days},
        ${runId}::uuid, ${ENGINE_ID}, ${ENGINE_CLASS}, ${ENGINE_VERSION},
        'not_required', 'computed', 'supporting_only', 'platform_record',
        (SELECT id FROM prior LIMIT 1),
        ${reading.blind ? 'every evidence source was unreadable at computation time' : null}
      RETURNING id, supersedes`));

    if (!rows.length) return { ok: false, error: 'insert returned no row' };
    const id = String(rows[0].id);

    // The evidence manifest, written even for sources that could not be read. "We could not read
    // this at the time" is part of the record of what the reading was based on, and dropping it
    // would make an incomplete reading indistinguishable from a complete one later.
    const srcs = reading.evidenceSources;
    if (srcs.length) {
      await db.execute(sql`
        INSERT INTO hzn_evidence (
          result_id, source_type, source_id, occurred_at,
          relevance_value, relevance_band, relevance_basis,
          reliability_value, reliability_band, reliability_basis,
          summary, evidence_class, layer, collected_under,
          owner_module, source_table, record_id, unreadable
        ) VALUES ${sql.join(srcs.map((s) => {
          const occurred = s.latestDay ? sql`${s.latestDay}::timestamptz` : sql`NOW()`;
          // Relevance is how much this source bears on a TIME reading; reliability is how much the
          // source can be trusted. They are deliberately different numbers: a task log is highly
          // relevant to delivery cadence and only as reliable as the habit of filling it in.
          const relevance = s.unreadable ? 0 : 0.8;
          const reliability = s.unreadable ? 0 : (s.verifiedRowCount > 0 ? 0.8 : 0.5);
          return sql`(
            ${id}::uuid, 'hr_record', ${s.table}, ${occurred},
            ${relevance}, ${relevance >= 0.7 ? 'high' : 'low'},
            ${'Counted rows dated inside the horizon window.'},
            ${reliability}, ${reliability >= 0.7 ? 'high' : reliability >= 0.4 ? 'moderate' : 'low'},
            ${s.verifiedRowCount > 0
              ? 'Some rows carry a named human verdict.'
              : 'No row in this source carries a named human verdict.'},
            ${truncateReason(s.because)},
            ${s.unreadable ? 'non_evidential' : (s.verifiedRowCount > 0 ? 'attested' : 'observed')},
            'computed', 'organisational_record',
            ${s.owner}, ${s.table}, ${employeeId},
            ${s.unreadable ? truncateReason(s.because) : null}
          )`;
        }), sql`, `)}`);
    }

    return { ok: true, id, supersededId: rows[0].supersedes ? String(rows[0].supersedes) : null };
  } catch (e: any) {
    logFail('storeReading', e);
    return { ok: false, error: reasonOf(e) };
  }
}

// =================================================================================================
// READING BACK
// =================================================================================================

export interface StoredResult {
  id: string;
  employeeId: string;
  horizon: Horizon;
  status: string;
  computedAt: string;
  staleAt: string;
  engineVersion: string;
  confidenceValue: number;
  confidenceBand: string;
  summary: string;
  supersedes: string | null;
  /** null when the row was stored as not_computed. */
  reading: HorizonReading | null;
}

function hydrate(r: any): StoredResult | null {
  try {
    const payload = typeof r.score_payload === 'string' ? JSON.parse(r.score_payload) : r.score_payload;
    const key = String(r.dimension_key || '').replace(/^horizon\./, '');
    return {
      id: String(r.id),
      employeeId: String(r.subject_id),
      horizon: key as Horizon,
      status: String(r.status),
      computedAt: r.computed_at ? new Date(r.computed_at).toISOString() : '',
      staleAt: r.stale_at ? new Date(r.stale_at).toISOString() : '',
      engineVersion: String(r.engine_version || ''),
      confidenceValue: Number(r.confidence_value) || 0,
      confidenceBand: String(r.confidence_band || ''),
      summary: String(r.summary || ''),
      supersedes: r.supersedes ? String(r.supersedes) : null,
      reading: (payload && payload.reading) ? (payload.reading as HorizonReading) : null,
    };
  } catch (e: any) {
    logFail('hydrate', e);
    return null;
  }
}

/** Every active temporal result for one person, one round trip. */
export async function activeResults(employeeId: string): Promise<Partial<Record<Horizon, StoredResult>>> {
  const out: Partial<Record<Horizon, StoredResult>> = {};
  if (!isUuid(employeeId)) return out;
  try {
    await ensureHorizonSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, subject_id, dimension_key, status, computed_at, stale_at, engine_version,
             confidence_value, confidence_band, summary, supersedes, score_payload
        FROM hzn_intelligence_result
       WHERE subject_id = ${employeeId} AND subject_kind = 'employee'
         AND dimension_family = ${DIMENSION_FAMILY}
         AND status IN ('active', 'unreadable')
       ORDER BY computed_at DESC`));
    for (const r of rows) {
      const h = hydrate(r);
      if (h && isHorizon(h.horizon) && !out[h.horizon]) out[h.horizon] = h;
    }
    return out;
  } catch (e: any) {
    logFail('activeResults', e);
    return out;
  }
}

/**
 * Every version of one horizon, newest first.
 *
 * This is what makes the versioning worth having: it answers "what did this system say about me in
 * March, and why is it different now" without anybody having to trust a memory of it.
 */
export async function resultHistory(employeeId: string, horizon: Horizon, limit = 12): Promise<StoredResult[]> {
  if (!isUuid(employeeId) || !isHorizon(horizon)) return [];
  const cap = Math.max(1, Math.min(50, limit));
  try {
    await ensureHorizonSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, subject_id, dimension_key, status, computed_at, stale_at, engine_version,
             confidence_value, confidence_band, summary, supersedes, score_payload
        FROM hzn_intelligence_result
       WHERE subject_id = ${employeeId} AND subject_kind = 'employee'
         AND dimension_family = ${DIMENSION_FAMILY} AND dimension_key = ${dimensionKeyFor(horizon)}
       ORDER BY computed_at DESC
       LIMIT ${cap}`));
    return rows.map(hydrate).filter(Boolean) as StoredResult[];
  } catch (e: any) {
    logFail('resultHistory', e);
    return [];
  }
}

// =================================================================================================
// RECOMPUTE
// =================================================================================================

export interface RecomputeResult {
  employeeId: string;
  runId: string | null;
  stored: { horizon: Horizon; id: string }[];
  refused: { horizon: Horizon; because: string }[];
  blind: boolean;
}

/**
 * Recompute and store every versioned horizon for one person, under one run.
 *
 * A BLIND GATHER STORES NOTHING. If every source was unreadable, writing a reading would supersede a
 * real one with an empty one and mark it active — turning a temporary outage into a permanent record
 * that this person has nothing on file. The previous result stays active and the run is recorded as
 * refused, so the refusal itself is auditable.
 */
export async function recomputeFor(employeeId: string, today: string, reason = 'scheduled'): Promise<RecomputeResult> {
  const out: RecomputeResult = { employeeId, runId: null, stored: [], refused: [], blind: false };
  if (!isUuid(employeeId)) {
    out.refused.push({ horizon: 'year', because: 'employee id is not a uuid' });
    return out;
  }

  const run = await startRun(employeeId, reason);
  if (!run) {
    out.refused.push({ horizon: 'year', because: 'could not open a computation run, so nothing was written' });
    return out;
  }
  out.runId = run.id;

  const ev = await gatherEvidence({ employeeId, today, fromDay: '1970-01-01' });
  if (ev.blind) {
    out.blind = true;
    for (const h of VERSIONED_HORIZONS) {
      out.refused.push({
        horizon: h,
        because: 'Every evidence source was unreadable, so nothing was stored and the previous result stays active.',
      });
    }
    await finishRun(run.id, 'refused', 'every evidence source was unreadable');
    return out;
  }

  const set = buildAll(ev, new Date().toISOString());
  for (const h of VERSIONED_HORIZONS) {
    const res = await storeReading(employeeId, h, set.readings[h], run.id);
    if (res.ok && res.id) out.stored.push({ horizon: h, id: res.id });
    else out.refused.push({ horizon: h, because: res.error || 'unknown' });
  }

  await finishRun(
    run.id,
    out.stored.length ? 'succeeded' : 'failed',
    out.stored.length + ' stored, ' + out.refused.length + ' refused',
  );
  return out;
}

export interface StaleTarget {
  employeeId: string;
  horizon: Horizon;
  staleAt: string | null;
  neverComputed: boolean;
}

/**
 * Which people need a recompute: nothing stored yet, or stored and past `stale_at`.
 *
 * Ordered worst-first so a sweep that cannot finish still makes progress on the oldest rather than
 * restarting from the same place every run. Employees with NO result at all sort first, because
 * "never computed" is staler than anything.
 */
export async function staleTargets(limit = 100): Promise<StaleTarget[]> {
  const cap = Math.max(1, Math.min(500, limit));
  try {
    await ensureHorizonSchema();
    const keys = VERSIONED_HORIZONS.map((h) => sql`(${dimensionKeyFor(h)})`);
    const rows = rowsOf(await db.execute(sql`
      WITH wanted(dimension_key) AS (VALUES ${sql.join(keys, sql`, `)}),
      targets AS (
        SELECT e.id::text AS employee_id, w.dimension_key
          FROM hr_employees e
         CROSS JOIN wanted w
         WHERE e.is_active = true AND e.employment_status = 'active'
      )
      SELECT t.employee_id, t.dimension_key, r.stale_at,
             (r.id IS NULL) AS never_computed
        FROM targets t
        LEFT JOIN hzn_intelligence_result r
          ON r.subject_id = t.employee_id
         AND r.subject_kind = 'employee'
         AND r.dimension_family = ${DIMENSION_FAMILY}
         AND r.dimension_key = t.dimension_key
         AND r.status = 'active'
       WHERE r.id IS NULL OR r.stale_at < NOW()
       ORDER BY (r.id IS NULL) DESC, r.stale_at ASC NULLS FIRST
       LIMIT ${cap}`));
    return rows.map((r: any) => ({
      employeeId: String(r.employee_id),
      horizon: String(r.dimension_key || '').replace(/^horizon\./, '') as Horizon,
      staleAt: r.stale_at ? new Date(r.stale_at).toISOString() : null,
      neverComputed: r.never_computed === true,
    }));
  } catch (e: any) {
    logFail('staleTargets', e);
    return [];
  }
}

export interface SweepResult {
  considered: number;
  people: number;
  stored: number;
  refused: number;
  blind: number;
  truncated: boolean;
  sentence: string;
}

/**
 * The periodic recompute.
 *
 * Deduplicates to PEOPLE rather than person-horizon pairs: recomputeFor() rebuilds all four versioned
 * horizons from one evidence gather, so processing a person once covers all of them and processing
 * them per-horizon would gather the same evidence four times over a cross-region round trip.
 *
 * `maxPeople` bounds the run, because a sweep that tries to do everybody in one invocation is a
 * sweep that times out and does nobody.
 */
export async function sweepRecompute(today: string, maxPeople = 25): Promise<SweepResult> {
  const cap = Math.max(1, Math.min(200, maxPeople));
  const targets = await staleTargets(cap * 4);
  const people: string[] = [];
  for (const t of targets) {
    if (people.indexOf(t.employeeId) < 0) people.push(t.employeeId);
    if (people.length >= cap) break;
  }

  let stored = 0;
  let refused = 0;
  let blind = 0;
  for (const id of people) {
    const r = await recomputeFor(id, today, 'sweep');
    stored += r.stored.length;
    refused += r.refused.length;
    if (r.blind) blind += 1;
  }

  const truncated = targets.length >= cap * 4;
  return {
    considered: targets.length,
    people: people.length,
    stored,
    refused,
    blind,
    truncated,
    sentence:
      'Recomputed ' + stored + ' readings for ' + people.length + ' people.'
      + (refused ? ' ' + refused + ' were refused and the previous versions stay active.' : '')
      + (blind ? ' ' + blind + ' people had no readable evidence at all and were left untouched.' : '')
      + (truncated ? ' More are waiting; this run was capped.' : ''),
  };
}
