// src/lib/horizon/signal-engine.ts — PATCH 08 · HORIZON Signal Engine · THE ONLY FILE THAT WRITES.
//
// =================================================================================================
// WHAT THIS DOES, IN ORDER
// =================================================================================================
//
//   read      one person's window out of hr_events (src/lib/hr-events.ts)
//   detect    run the pure detectors in signal-detectors.ts over it
//   admit     let signal-contract.ts refuse or downgrade each candidate on its evidence
//   decide    let notificationDecision() say insert / update / escalate / reactivate / suppress
//   validate  build the SHARED Signal and put it through the shared validateSignal()
//   write     hzn_signal + hzn_evidence, in one transaction
//   tell      notify the roles responsible for that band, and nobody else
//
// Everything except the last three steps is pure and already tested without a database. This file is
// deliberately the thin end: it moves rows, it does not decide anything.
//
// =================================================================================================
// IT WRITES THE SHARED TABLES. IT DOES NOT FORK THEM.
// =================================================================================================
//
//   hzn_signal    owned by the HORIZON shared contracts (src/lib/horizon/schema.ts). This engine is
//                 the first thing in the codebase to write it. It does not create a second signal
//                 table, and every row it writes has passed the shared validateSignal().
//
//   hzn_evidence  the same, with `signal_id` pointing back. Evidence is written in the SAME
//                 TRANSACTION as the signal that cites it, because a signal naming evidence that was
//                 never written is precisely the unfalsifiable claim this apparatus exists to stop.
//
// TWO TABLES ARE THIS PATCH'S OWN, and neither duplicates a shared concept:
//
//   hzn_signal_state      ENGINE BOOKKEEPING, one row per live finding, keyed by the dedupe key.
//                         Occurrence counts, cooldown windows, the evidence references already seen.
//                         None of it belongs on the contract: the contract describes a signal, this
//                         describes how often we have noticed it and when we last said so.
//
//   hzn_signal_lifecycle  APPEND-ONLY. Every raise, escalation, suppression, acknowledgement, review
//                         verdict and resolution, with who did it and why. The signal row says where
//                         things stand; this says how they got there, and it cannot be edited.
//
// The split matters for rule 24: one person's opinion must never become organisational truth. A
// reviewer's verdict is written HERE as one attributed row among others. It does not overwrite the
// evidence, and a second reviewer disagreeing produces a second row rather than a correction.
// reviewDisagreement() reads them back.
//
// =================================================================================================
// WHAT IT DOES NOT DO
// =================================================================================================
//
// It exports no function that acts on anybody. There is no applySignal(), no autoFlag(), no
// escalateToDisciplinary(). The six consequential decisions live behind src/lib/ai-boundary.ts and
// need a named human with a written reason; this engine's whole relationship with them is that
// admit() holds any signal that admits it could be quoted in one to a stricter evidence floor.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import { uuidIn } from '@/lib/pg-array';
import { notifyAllAdmins, notifyUser } from '@/lib/notify';
import type { HrEvent } from '@/lib/hr-events';
import {
  DEFAULT_ORGANISATION_ID,
  employeeSubject,
  ensureHorizonSchema,
  newHorizonId,
  subjectKey,
  validateSignal,
  type Evidence,
  type SubjectRef,
} from '@/lib/horizon';
import {
  admit,
  ATTENTION_RANK,
  BAND_LABELS,
  BAND_SEVERITY,
  bandOfSeverity,
  evidenceRefOf,
  explain,
  isAttentionBand,
  notificationDecision,
  toSharedSignal,
  type AdmittedSignal,
  type AttentionBand,
  type ExistingSignalState,
  type SignalCandidate,
  type SignalExplanation,
  type SignalInput,
  type ReviewerKind,
} from '@/lib/horizon/signal-contract';
import { runDetectors, type DetectorWindow } from '@/lib/horizon/signal-detectors';
import {
  mergePolicies,
  policyForRole,
  redactForPolicy,
  RELATIONSHIP_SIGNAL_POLICY,
  seesBand,
  type SignalPolicy,
} from '@/lib/horizon/signal-visibility';

// -------------------------------------------------------------------------------------------------
// HOUSE RULES OF THIS CODEBASE, IN THREE LINES
// -------------------------------------------------------------------------------------------------
/** postgres-js hands back a plain array. `r.rows[0]` is undefined here and has broken this project before. */
function rows(r: any): any[] {
  return Array.isArray(r) ? r : r?.rows || [];
}
/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || e || 'unknown error');
}
function logFail(tag: string, e: any): void {
  console.error('[horizon-signal-engine] ' + tag + ': ' + reasonOf(e));
}
function iso(v: any): string | null {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
function jsonArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// =================================================================================================
// SCHEMA — THIS PATCH'S TWO TABLES ONLY
// =================================================================================================
//
// hzn_signal and hzn_evidence are created by ensureHorizonSchema(), which belongs to the shared
// contracts and is CALLED here, never copied. If those two ever need a column, that is a change to
// the foundation patch and a conversation, not an ALTER smuggled into this file.
//
// ONE BATCH, ONE ROUND TRIP, guarded with a lock timeout by ensureBatch — see the header of
// src/lib/ensure-once.ts for the outage that guard exists because of.

const ENGINE_DDL = `
  CREATE TABLE IF NOT EXISTS hzn_signal_state (
    dedupe_key       VARCHAR(200) PRIMARY KEY,
    signal_id        UUID NOT NULL,
    organisation_id  TEXT NOT NULL DEFAULT 'org_edurankai',
    detector_key     VARCHAR(80) NOT NULL,
    detector_version VARCHAR(32) NOT NULL,
    dimension        VARCHAR(60) NOT NULL,
    subject_key      TEXT NOT NULL,
    subject_id       TEXT NOT NULL,
    band             VARCHAR(10) NOT NULL,
    attention_rank   SMALLINT NOT NULL DEFAULT 1,
    what_changed     TEXT NOT NULL,
    processing       TEXT NOT NULL,
    inputs           JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
    reviewer_kind    VARCHAR(30) NOT NULL DEFAULT 'none',
    touches_decision VARCHAR(20),
    downgraded_from  VARCHAR(10),
    downgrade_reason TEXT,
    period_start     TIMESTAMPTZ,
    period_end       TIMESTAMPTZ,
    occurrence_count INT NOT NULL DEFAULT 1,
    reactivation_count INT NOT NULL DEFAULT 0,
    review_count     INT NOT NULL DEFAULT 0,
    first_raised_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_raised_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_notified_at TIMESTAMPTZ,
    cooldown_until   TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE INDEX IF NOT EXISTS hzn_signal_state_signal_idx ON hzn_signal_state (signal_id);
  CREATE INDEX IF NOT EXISTS hzn_signal_state_subject_idx ON hzn_signal_state (subject_id, last_raised_at DESC);
  CREATE TABLE IF NOT EXISTS hzn_signal_lifecycle (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id      UUID NOT NULL,
    dedupe_key     VARCHAR(200),
    action         VARCHAR(30) NOT NULL,
    reason         TEXT,
    actor_user_id  UUID,
    actor_kind     VARCHAR(10) NOT NULL DEFAULT 'system',
    from_band      VARCHAR(10),
    to_band        VARCHAR(10),
    from_status    VARCHAR(20),
    to_status      VARCHAR(20),
    notified       BOOLEAN NOT NULL DEFAULT FALSE,
    new_evidence   JSONB NOT NULL DEFAULT '[]'::jsonb,
    verdict        VARCHAR(30),
    note           TEXT,
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE INDEX IF NOT EXISTS hzn_signal_lifecycle_signal_idx ON hzn_signal_lifecycle (signal_id, at DESC);
  CREATE INDEX IF NOT EXISTS hzn_signal_lifecycle_at_idx ON hzn_signal_lifecycle (at DESC);
`;

export async function ensureSignalEngineSchema(): Promise<void> {
  await ensureHorizonSchema();
  await ensureBatch('hzn_signal_engine_v1', ENGINE_DDL);
}

export interface EngineSchemaState {
  ok: boolean;
  present: string[];
  missing: string[];
  error: string | null;
  checkedAt: string;
}

const REQUIRED_TABLES = ['hzn_signal', 'hzn_evidence', 'hzn_signal_state', 'hzn_signal_lifecycle'];

/**
 * Whether the four tables are actually there, READ FROM information_schema rather than assumed.
 *
 * ensureOnce() ends in a swallow, so "the ensure resolved" is not evidence that anything was
 * created — ten module tables were reported created on this project and none existed. A screen
 * showing an empty queue has to be able to say which of the two it is looking at.
 */
export async function signalEngineSchemaState(): Promise<EngineSchemaState> {
  const checkedAt = new Date().toISOString();
  try {
    await ensureSignalEngineSchema();
    const r = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('hzn_signal','hzn_evidence','hzn_signal_state','hzn_signal_lifecycle')`);
    const present = rows(r).map((x: any) => String(x.table_name));
    const missing = REQUIRED_TABLES.filter((t) => present.indexOf(t) < 0);
    return { ok: missing.length === 0, present, missing, error: null, checkedAt };
  } catch (e: any) {
    logFail('signalEngineSchemaState', e);
    return { ok: false, present: [], missing: REQUIRED_TABLES, error: reasonOf(e), checkedAt };
  }
}

// =================================================================================================
// THE STORED ROW — hzn_signal JOINED WITH THIS PATCH'S STATE
// =================================================================================================

export interface StoredSignal {
  id: string;
  dedupeKey: string;
  detectorKey: string;
  detectorVersion: string;
  band: AttentionBand;
  bandLabel: string;
  severity: string;
  category: string;
  dimension: string;
  title: string;
  /** hzn_signal.explanation — the "what changed" sentence. */
  explanation: string;
  subjectKind: string;
  subjectId: string;
  subjectScheme: string;
  sourceTypes: string[];
  confidence: { band: string; value: number | null; basis: string; terms: string[] };
  recommendedActions: { key: string; label: string; addressedTo: string }[];
  humanReviewRequired: boolean;
  reviewerKind: ReviewerKind;
  touchesDecision: string | null;
  downgradedFrom: string | null;
  downgradeReason: string | null;
  layer: string;
  decisionUse: string;
  status: string;
  generatedAt: string | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  resolvedById: string | null;
  resolution: string | null;
  resolvedReason: string | null;
  /** Engine bookkeeping. Absent when the state row has gone missing, which is itself worth seeing. */
  inputs: SignalInput[];
  processing: string;
  evidenceRefs: string[];
  periodStart: string | null;
  periodEnd: string | null;
  occurrenceCount: number;
  reactivationCount: number;
  reviewCount: number;
  firstRaisedAt: string | null;
  lastRaisedAt: string | null;
  lastNotifiedAt: string | null;
  cooldownUntil: string | null;
  /** Display only, from the join. Never a decision input. */
  subjectName?: string | null;
}

function mapSignal(r: any): StoredSignal {
  const severity = String(r.severity || 'medium');
  const band = isAttentionBand(r.band) ? (r.band as AttentionBand) : bandOfSeverity(severity as any);
  return {
    id: String(r.id),
    dedupeKey: String(r.dedupe_key || ''),
    detectorKey: String(r.detector_key || ''),
    detectorVersion: String(r.detector_version || ''),
    band,
    bandLabel: BAND_LABELS[band],
    severity,
    category: String(r.category || ''),
    dimension: String(r.dimension || ''),
    title: String(r.title || ''),
    explanation: String(r.explanation || ''),
    subjectKind: String(r.subject_kind || 'employee'),
    subjectId: String(r.subject_id || ''),
    subjectScheme: String(r.subject_scheme || 'hr_employee'),
    sourceTypes: jsonArray(r.source_types).map(String),
    confidence: {
      band: String(r.confidence_band || 'low'),
      value: r.confidence_value === null || r.confidence_value === undefined ? null : Number(r.confidence_value),
      basis: String(r.confidence_basis || ''),
      terms: jsonArray(r.confidence_terms).map(String),
    },
    recommendedActions: jsonArray(r.recommended_actions) as any[],
    humanReviewRequired: r.human_review_required === true,
    reviewerKind: String(r.reviewer_kind || 'none') as ReviewerKind,
    touchesDecision: r.touches_decision ? String(r.touches_decision) : null,
    downgradedFrom: r.downgraded_from ? String(r.downgraded_from) : null,
    downgradeReason: r.downgrade_reason ? String(r.downgrade_reason) : null,
    layer: String(r.layer || 'computed'),
    decisionUse: String(r.decision_use || 'supporting_only'),
    status: String(r.status || 'open'),
    generatedAt: iso(r.generated_at),
    expiresAt: iso(r.expires_at),
    resolvedAt: iso(r.resolved_at),
    resolvedById: r.resolved_by_id ? String(r.resolved_by_id) : null,
    resolution: r.resolution ? String(r.resolution) : null,
    resolvedReason: r.resolved_reason ? String(r.resolved_reason) : null,
    inputs: jsonArray(r.inputs) as SignalInput[],
    processing: String(r.processing || ''),
    evidenceRefs: jsonArray(r.evidence_refs).map(String),
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    occurrenceCount: Number(r.occurrence_count) || 1,
    reactivationCount: Number(r.reactivation_count) || 0,
    reviewCount: Number(r.review_count) || 0,
    firstRaisedAt: iso(r.first_raised_at),
    lastRaisedAt: iso(r.last_raised_at),
    lastNotifiedAt: iso(r.last_notified_at),
    cooldownUntil: iso(r.cooldown_until),
    subjectName: r.full_name ? String(r.full_name) : null,
  };
}

/** The one SELECT every read uses. hzn_signal is the record; the state row is the engine's memory. */
const SIGNAL_SELECT = sql`
  SELECT s.*, st.dedupe_key, st.detector_key, st.detector_version, st.dimension, st.band,
         st.what_changed, st.processing, st.inputs, st.confidence_terms, st.evidence_refs,
         st.reviewer_kind, st.touches_decision, st.downgraded_from, st.downgrade_reason,
         st.period_start, st.period_end, st.occurrence_count, st.reactivation_count, st.review_count,
         st.first_raised_at, st.last_raised_at, st.last_notified_at, st.cooldown_until,
         e.full_name
    FROM hzn_signal s
    LEFT JOIN hzn_signal_state st ON st.signal_id = s.id
    LEFT JOIN hr_employees e ON e.id::text = s.subject_id`;

function existingStateOf(s: StoredSignal): ExistingSignalState {
  return {
    signalId: s.id,
    band: s.band,
    status: s.status,
    evidenceRefs: s.evidenceRefs,
    lastNotifiedAt: s.lastNotifiedAt,
    cooldownUntil: s.cooldownUntil,
    closedAt: s.resolvedAt,
    occurrenceCount: s.occurrenceCount,
  };
}

/**
 * The explainability chain for a row already stored.
 *
 * Rebuilt from the STORED fields, never recomputed from today's detectors. An explanation
 * regenerated from current code explains current code, not the row somebody acted on last month.
 */
export function explainStored(s: StoredSignal, evidence: Evidence[], computedAt = new Date()): SignalExplanation {
  return explain(
    {
      detectorKey: s.detectorKey,
      detectorVersion: s.detectorVersion,
      band: s.band,
      severity: s.severity as any,
      category: s.category as any,
      dimension: s.dimension,
      title: s.title,
      whatChanged: s.explanation,
      subject: { kind: s.subjectKind, id: s.subjectId, idScheme: s.subjectScheme } as any,
      evidence,
      inputs: s.inputs,
      processing: s.processing,
      recommendedActions: s.recommendedActions as any,
      periodStart: s.periodStart || '',
      periodEnd: s.periodEnd || '',
      touchesDecision: (s.touchesDecision as any) || null,
      dedupeKey: s.dedupeKey,
      profile: {
        total: evidence.length,
        weighted: evidence.filter((e) => e.evidenceClass !== 'non_evidential').length,
        distinctSourceTypes: s.sourceTypes as any,
        loadBearingCount: 0,
        strongestClass: null,
        nonEvidentialCount: evidence.filter((e) => e.evidenceClass === 'non_evidential').length,
        nonEvidentialOnly: false,
        newestAt: null,
        oldestAt: null,
      },
      confidence: {
        band: s.confidence.band as any,
        value: s.confidence.value || 0,
        basis: s.confidence.basis,
        terms: s.confidence.terms.length ? s.confidence.terms : [s.confidence.basis],
      },
      humanReviewRequired: s.humanReviewRequired,
      reviewerKind: s.reviewerKind,
      downgradedFrom: (s.downgradedFrom as any) || null,
      downgradeReason: s.downgradeReason,
      sourceTypes: s.sourceTypes as any,
      expiresAt: s.expiresAt || '',
      layer: s.layer as any,
      decisionUse: s.decisionUse as any,
    } as AdmittedSignal,
    computedAt,
  );
}

// =================================================================================================
// THE LIFECYCLE LOG
// =================================================================================================

export interface LifecycleEntry {
  id: string;
  signalId: string;
  action: string;
  reason: string | null;
  actorUserId: string | null;
  actorKind: string;
  fromBand: string | null;
  toBand: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  notified: boolean;
  newEvidence: string[];
  verdict: string | null;
  note: string | null;
  at: string | null;
}

interface LogInput {
  signalId: string;
  dedupeKey?: string | null;
  action: string;
  reason?: string | null;
  actorUserId?: string | null;
  actorKind?: 'human' | 'system';
  fromBand?: string | null;
  toBand?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  notified?: boolean;
  newEvidence?: string[];
  verdict?: string | null;
  note?: string | null;
}

/**
 * Append one lifecycle row. NEVER THROWS, and never silently swallows either.
 *
 * A failed log must not roll back the thing it describes — a signal that was raised is raised — but
 * a log that fails quietly is how an outage hides for hours on this project. So: the write is
 * attempted, a failure is printed with the real Postgres reason, and the caller carries on.
 */
async function logLifecycle(input: LogInput): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO hzn_signal_lifecycle
        (signal_id, dedupe_key, action, reason, actor_user_id, actor_kind, from_band, to_band,
         from_status, to_status, notified, new_evidence, verdict, note)
      VALUES (${input.signalId}::uuid, ${input.dedupeKey || null}, ${input.action}, ${input.reason || null},
              ${input.actorUserId || null}, ${input.actorKind || 'system'}, ${input.fromBand || null},
              ${input.toBand || null}, ${input.fromStatus || null}, ${input.toStatus || null},
              ${input.notified === true}, ${JSON.stringify(input.newEvidence || [])}::jsonb,
              ${input.verdict || null}, ${input.note || null})`);
  } catch (e: any) {
    logFail('logLifecycle(' + input.action + ')', e);
  }
}

export async function signalHistory(signalId: string, limit = 200): Promise<LifecycleEntry[]> {
  try {
    await ensureSignalEngineSchema();
    const cap = Math.max(1, Math.min(500, Math.round(limit)));
    const r = await db.execute(sql`
      SELECT * FROM hzn_signal_lifecycle WHERE signal_id = ${signalId}::uuid ORDER BY at DESC LIMIT ${cap}`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      signalId: String(x.signal_id),
      action: String(x.action || ''),
      reason: x.reason ? String(x.reason) : null,
      actorUserId: x.actor_user_id ? String(x.actor_user_id) : null,
      actorKind: String(x.actor_kind || 'system'),
      fromBand: x.from_band ? String(x.from_band) : null,
      toBand: x.to_band ? String(x.to_band) : null,
      fromStatus: x.from_status ? String(x.from_status) : null,
      toStatus: x.to_status ? String(x.to_status) : null,
      notified: x.notified === true,
      newEvidence: jsonArray(x.new_evidence).map(String),
      verdict: x.verdict ? String(x.verdict) : null,
      note: x.note ? String(x.note) : null,
      at: iso(x.at),
    }));
  } catch (e: any) {
    logFail('signalHistory', e);
    return [];
  }
}

/**
 * DID THE REVIEWERS DISAGREE?
 *
 * Rule of this system: one person's feedback must never automatically become organisational truth,
 * and aggregation must be able to REPRESENT disagreement rather than average it away. So verdicts
 * are never merged into a single "reviewed" state — they are counted, and a screen showing a
 * reviewed signal shows that two people said different things when two people did.
 */
export function reviewDisagreement(history: readonly LifecycleEntry[]): {
  reviewed: number;
  verdicts: { verdict: string; count: number; reviewers: string[] }[];
  disagreement: boolean;
} {
  const reviews = history.filter((h) => h.action === 'reviewed' && h.verdict);
  const byVerdict = new Map<string, { verdict: string; count: number; reviewers: string[] }>();
  for (const r of reviews) {
    const key = String(r.verdict);
    const entry = byVerdict.get(key) || { verdict: key, count: 0, reviewers: [] };
    entry.count += 1;
    if (r.actorUserId && entry.reviewers.indexOf(r.actorUserId) < 0) entry.reviewers.push(r.actorUserId);
    byVerdict.set(key, entry);
  }
  const verdicts = Array.from(byVerdict.values());
  return { reviewed: reviews.length, verdicts, disagreement: verdicts.length > 1 };
}

// =================================================================================================
// NOTIFICATION
// =================================================================================================

/**
 * Tell the people responsible for this band, and nobody else.
 *
 * ROUTING IS NOT REIMPLEMENTED HERE. notifyAllAdmins() takes an audience key and
 * src/lib/notify-audience.ts owns which roles that key reaches — one map for the whole platform,
 * with a test that fails the build when a key is broadcast without an entry. This function only
 * chooses the key.
 *
 * THE SUBJECT IS TOLD ABOUT THEIR OWN GOOD NEWS. Opportunity and Growth go to the person as well,
 * because a record of what their work made possible belongs to them. Watch and Attention do not: an
 * automated observation delivered to its subject before a human has read it is an accusation with
 * nobody's name on it. Those reach them through the conversation the recommended action asks for.
 * See the header of signal-visibility.ts.
 */
async function dispatchNotification(
  signal: AdmittedSignal,
  signalId: string,
  action: string,
  subjectUserId: string | null,
): Promise<boolean> {
  const prefix = action === 'escalate' ? 'Escalated · ' : '';
  const common = {
    title: prefix + BAND_LABELS[signal.band] + ': ' + signal.title,
    body: signal.whatChanged,
    type: 'system' as const,
    actionUrl: '/admin/hr/signals/' + signalId,
    entityType: 'horizon_signal',
    entityId: signalId,
  };
  try {
    // FOUR CALLS WITH FOUR LITERAL KEYS, NOT ONE CALL WITH A COMPUTED ONE.
    //
    // This reads as repetition and is not. src/lib/notify-audience.test.ts SCANS THE SOURCE of every
    // notifyAllAdmins call site and fails the build when a broadcast key has no entry in the audience
    // map — which is how eleven live types were found quietly reaching marketing and partners. A
    // computed `audience: audienceKeyFor(band)` is invisible to that scan, so the one place in the
    // codebase that checks who receives what would have had nothing to check. The keys are written
    // out so the routing of an Attention signal is greppable from the map to the call and back.
    if (signal.band === 'red') {
      await notifyAllAdmins({ ...common, audience: 'horizon_signal_attention' });
    } else if (signal.band === 'yellow') {
      await notifyAllAdmins({ ...common, audience: 'horizon_signal_watch' });
    } else if (signal.band === 'blue') {
      await notifyAllAdmins({ ...common, audience: 'horizon_signal_growth' });
    } else {
      await notifyAllAdmins({ ...common, audience: 'horizon_signal_opportunity' });
    }
    if ((signal.band === 'green' || signal.band === 'blue') && subjectUserId) {
      await notifyUser(subjectUserId, {
        title: signal.title,
        body: signal.whatChanged,
        type: 'info',
        actionUrl: '/portal/employee',
        entityType: 'horizon_signal',
        entityId: signalId,
      });
    }
    return true;
  } catch (e: any) {
    logFail('dispatchNotification', e);
    return false;
  }
}

// =================================================================================================
// RAISE
// =================================================================================================

export interface RaiseResult {
  ok: boolean;
  action: 'insert' | 'update' | 'escalate' | 'reactivate' | 'suppress' | 'refused' | 'error';
  id: string | null;
  band: AttentionBand | null;
  notified: boolean;
  reason: string;
  refusals: string[];
  notes: string[];
}

export interface RaiseOptions {
  now?: Date;
  /** users.id when a person triggered this run. Null for a scheduled sweep. */
  actorUserId?: string | null;
  /** The subject's user account, so Opportunity and Growth can reach them. Optional. */
  subjectUserId?: string | null;
  /** Work out what WOULD happen and write nothing. */
  dryRun?: boolean;
}

function refused(reasons: string[]): RaiseResult {
  return { ok: false, action: 'refused', id: null, band: null, notified: false, reason: reasons[0] || 'Refused.', refusals: reasons, notes: [] };
}

async function loadByDedupeKey(key: string): Promise<StoredSignal | null> {
  const r = await db.execute(sql`${SIGNAL_SELECT} WHERE st.dedupe_key = ${key} LIMIT 1`);
  const list = rows(r);
  return list.length ? mapSignal(list[0]) : null;
}

/** One evidence row, written against the signal that cites it. */
function insertEvidence(tx: any, e: Evidence, signalId: string) {
  return tx.execute(sql`
    INSERT INTO hzn_evidence
      (id, organisation_id, signal_id, source_type, source_id, occurred_at,
       relevance_value, relevance_band, relevance_basis,
       reliability_value, reliability_band, reliability_basis,
       summary, evidence_class, layer, collected_under, owner_module, source_table, record_id, locator, document_url)
    VALUES (${e.id}::uuid, ${e.organisationId}, ${signalId}::uuid, ${e.sourceType}, ${e.sourceId},
            ${e.timestamp}::timestamptz,
            ${e.relevance.value}, ${e.relevance.band}, ${e.relevance.basis},
            ${e.reliability.value}, ${e.reliability.band}, ${e.reliability.basis},
            ${e.summary}, ${e.evidenceClass}, ${e.layer}, ${e.collectedUnder},
            ${e.rawReference.ownerModule}, ${e.rawReference.table}, ${e.rawReference.recordId},
            ${(e.rawReference as any).locator || null}, ${(e.rawReference as any).documentUrl || null})
    ON CONFLICT (id) DO NOTHING`);
}

/**
 * Put one candidate through the whole machine.
 *
 * THE ORDER IS THE POINT: admit before dedupe, dedupe before validate, validate before write, write
 * before notify. A refused candidate never reaches the table, a suppressed one never reaches an
 * inbox, and nothing is notified that was not first written — a notification about a row that failed
 * to save is a message pointing at a page that will 404.
 */
export async function raiseSignal(candidate: SignalCandidate, opts: RaiseOptions = {}): Promise<RaiseResult> {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const verdict = admit(candidate, now);
  if (!verdict.ok) return refused(verdict.refusals);
  const signal = verdict.signal;

  try {
    await ensureSignalEngineSchema();
    const existing = await loadByDedupeKey(signal.dedupeKey);
    const decision = notificationDecision(existing ? existingStateOf(existing) : null, signal, now);

    if (opts.dryRun) {
      return {
        ok: true,
        action: decision.action,
        id: existing?.id || null,
        band: signal.band,
        notified: false,
        reason: decision.reason + ' (dry run — nothing was written.)',
        refusals: [],
        notes: verdict.notes,
      };
    }

    if (decision.action === 'suppress' && existing) {
      await logLifecycle({
        signalId: existing.id,
        dedupeKey: signal.dedupeKey,
        action: 'suppressed',
        reason: decision.reason,
        actorUserId: opts.actorUserId || null,
      });
      return {
        ok: true,
        action: 'suppress',
        id: existing.id,
        band: existing.band,
        notified: false,
        reason: decision.reason,
        refusals: [],
        notes: verdict.notes,
      };
    }

    const signalId = existing?.id || newHorizonId('signal');
    const shared = toSharedSignal(signal, {
      id: signalId,
      evidenceIds: signal.evidence.map((e) => String(e.id)),
      organisationId: signal.subject.organisationId || DEFAULT_ORGANISATION_ID,
    });

    // THE SHARED VALIDATOR HAS THE LAST WORD, and it runs BEFORE the write rather than as a comment
    // about it. Twelve of its rules are ones this engine could not enforce on its own — that a signal
    // must expire, that it may never claim `may_decide`, that a high-severity one must require human
    // review, that its copy passes the terminology check.
    const check = validateSignal(shared);
    if (!check.ok) {
      logFail('validateSignal(' + signal.detectorKey + ')', new Error(check.errors.join('; ')));
      return refused(check.errors);
    }

    const knownRefs = existing ? existing.evidenceRefs.slice() : [];
    const freshEvidence = signal.evidence.filter((e) => knownRefs.indexOf(evidenceRefOf(e)) < 0);
    const allRefs = Array.from(new Set(knownRefs.concat(signal.evidence.map(evidenceRefOf))));
    const nowIso = now.toISOString();
    const reopening = decision.action === 'reactivate';

    // ONE TRANSACTION. A signal that cites evidence which was never written is the unfalsifiable
    // claim this whole apparatus exists to prevent, so the two land together or neither does.
    await db.transaction(async (tx: any) => {
      if (!existing) {
        await tx.execute(sql`
          INSERT INTO hzn_signal
            (id, organisation_id, subject_kind, subject_id, subject_scheme, category, severity, title,
             explanation, source_types, confidence_band, confidence_value, confidence_basis,
             recommended_actions, human_review_required, layer, decision_use, status, generated_at, expires_at)
          VALUES (${signalId}::uuid, ${shared.organisationId}, ${shared.subject.kind}, ${shared.subject.id},
                  ${shared.subject.idScheme}, ${shared.category}, ${shared.severity}, ${shared.title},
                  ${shared.explanation}, ${JSON.stringify(shared.sourceTypes)}::jsonb, ${shared.confidence.band},
                  ${shared.confidence.value ?? null}, ${shared.confidence.basis},
                  ${JSON.stringify(shared.recommendedActions)}::jsonb, ${shared.humanReviewRequired},
                  ${shared.layer}, ${shared.decisionUse}, 'open', ${shared.generatedAt}::timestamptz,
                  ${shared.expiresAt}::timestamptz)
          ON CONFLICT (id) DO NOTHING`);
      } else {
        await tx.execute(sql`
          UPDATE hzn_signal SET
            severity = ${shared.severity},
            title = ${shared.title},
            explanation = ${shared.explanation},
            source_types = ${JSON.stringify(shared.sourceTypes)}::jsonb,
            confidence_band = ${shared.confidence.band},
            confidence_value = ${shared.confidence.value ?? null},
            confidence_basis = ${shared.confidence.basis},
            recommended_actions = ${JSON.stringify(shared.recommendedActions)}::jsonb,
            human_review_required = ${shared.humanReviewRequired},
            decision_use = ${shared.decisionUse},
            expires_at = ${shared.expiresAt}::timestamptz,
            status = CASE WHEN ${reopening} THEN 'open' ELSE status END,
            resolved_at = CASE WHEN ${reopening} THEN NULL ELSE resolved_at END,
            resolution = CASE WHEN ${reopening} THEN NULL ELSE resolution END
          WHERE id = ${signalId}::uuid`);
      }

      for (const e of freshEvidence) await insertEvidence(tx, e, signalId);

      await tx.execute(sql`
        INSERT INTO hzn_signal_state
          (dedupe_key, signal_id, organisation_id, detector_key, detector_version, dimension, subject_key,
           subject_id, band, attention_rank, what_changed, processing, inputs, confidence_terms, evidence_refs,
           reviewer_kind, touches_decision, downgraded_from, downgrade_reason, period_start, period_end,
           first_raised_at, last_raised_at, last_notified_at, cooldown_until)
        VALUES (${signal.dedupeKey}, ${signalId}::uuid, ${shared.organisationId}, ${signal.detectorKey},
                ${signal.detectorVersion}, ${signal.dimension}, ${subjectKey(signal.subject)}, ${signal.subject.id},
                ${signal.band}, ${ATTENTION_RANK[signal.band]}, ${signal.whatChanged}, ${signal.processing},
                ${JSON.stringify(signal.inputs)}::jsonb, ${JSON.stringify(signal.confidence.terms)}::jsonb,
                ${JSON.stringify(allRefs)}::jsonb, ${signal.reviewerKind}, ${signal.touchesDecision || null},
                ${signal.downgradedFrom || null}, ${signal.downgradeReason || null},
                ${signal.periodStart}::timestamptz, ${signal.periodEnd}::timestamptz,
                ${nowIso}::timestamptz, ${nowIso}::timestamptz,
                ${decision.notify ? nowIso : null}::timestamptz, ${decision.cooldownUntil}::timestamptz)
        ON CONFLICT (dedupe_key) DO UPDATE SET
          detector_version = EXCLUDED.detector_version,
          band = EXCLUDED.band,
          attention_rank = EXCLUDED.attention_rank,
          what_changed = EXCLUDED.what_changed,
          processing = EXCLUDED.processing,
          inputs = EXCLUDED.inputs,
          confidence_terms = EXCLUDED.confidence_terms,
          evidence_refs = EXCLUDED.evidence_refs,
          reviewer_kind = EXCLUDED.reviewer_kind,
          downgraded_from = EXCLUDED.downgraded_from,
          downgrade_reason = EXCLUDED.downgrade_reason,
          period_start = EXCLUDED.period_start,
          period_end = EXCLUDED.period_end,
          occurrence_count = hzn_signal_state.occurrence_count + 1,
          reactivation_count = hzn_signal_state.reactivation_count + ${reopening ? 1 : 0},
          last_raised_at = EXCLUDED.last_raised_at,
          last_notified_at = COALESCE(EXCLUDED.last_notified_at, hzn_signal_state.last_notified_at),
          cooldown_until = EXCLUDED.cooldown_until,
          updated_at = NOW()`);
    });

    const notified = decision.notify
      ? await dispatchNotification(signal, signalId, decision.action, opts.subjectUserId || null)
      : false;

    await logLifecycle({
      signalId,
      dedupeKey: signal.dedupeKey,
      action:
        decision.action === 'escalate' ? 'escalated' : reopening ? 'reactivated' : existing ? 'seen_again' : 'raised',
      reason: decision.reason,
      actorUserId: opts.actorUserId || null,
      fromBand: existing?.band || null,
      toBand: signal.band,
      fromStatus: existing?.status || null,
      toStatus: reopening ? 'open' : existing?.status || 'open',
      notified,
      newEvidence: decision.newEvidenceRefs,
      note: signal.downgradeReason || null,
    });

    return {
      ok: true,
      action: decision.action,
      id: signalId,
      band: signal.band,
      notified,
      reason: decision.reason,
      refusals: [],
      notes: verdict.notes,
    };
  } catch (e: any) {
    logFail('raiseSignal(' + candidate.detectorKey + ')', e);
    return { ok: false, action: 'error', id: null, band: null, notified: false, reason: reasonOf(e), refusals: [], notes: [] };
  }
}

// =================================================================================================
// READ
// =================================================================================================
//
// READS CARRY THEIR OUTCOME. A helper that catches, logs and returns [] renders "nothing to review"
// on the screen where being wrong means a signal is never actioned — day one and an outage read
// identically. Every read here returns ok/reason so the caller can say which one it is looking at.

export type SignalsRead = { ok: true; rows: StoredSignal[] } | { ok: false; reason: string };

export interface ListOptions {
  status?: string | 'active' | null;
  band?: AttentionBand | null;
  detectorKey?: string | null;
  subjectId?: string | null;
  limit?: number;
}

export async function listSignals(opts: ListOptions = {}): Promise<SignalsRead> {
  try {
    await ensureSignalEngineSchema();
    const cap = Math.max(1, Math.min(500, Math.round(Number(opts.limit) || 100)));
    const activeOnly = opts.status === 'active';
    const status = !activeOnly && opts.status ? String(opts.status) : null;
    const band = isAttentionBand(opts.band) ? String(opts.band) : null;
    const detector = opts.detectorKey ? String(opts.detectorKey) : null;
    const subjectId = opts.subjectId ? String(opts.subjectId) : null;
    const r = await db.execute(sql`
      ${SIGNAL_SELECT}
       WHERE (${status}::text IS NULL OR s.status = ${status})
         AND (${activeOnly} = false OR s.status IN ('open','acknowledged','in_progress'))
         AND (${band}::text IS NULL OR st.band = ${band})
         AND (${detector}::text IS NULL OR st.detector_key = ${detector})
         AND (${subjectId}::text IS NULL OR s.subject_id = ${subjectId})
       ORDER BY st.attention_rank DESC NULLS LAST, s.generated_at DESC
       LIMIT ${cap}`);
    return { ok: true, rows: rows(r).map(mapSignal) };
  } catch (e: any) {
    logFail('listSignals', e);
    return { ok: false, reason: reasonOf(e) };
  }
}

export async function getSignal(id: string): Promise<StoredSignal | null> {
  try {
    await ensureSignalEngineSchema();
    const r = await db.execute(sql`${SIGNAL_SELECT} WHERE s.id = ${id}::uuid LIMIT 1`);
    const list = rows(r);
    return list.length ? mapSignal(list[0]) : null;
  } catch (e: any) {
    logFail('getSignal', e);
    return null;
  }
}

/** The evidence rows a stored signal actually rests on, read back from hzn_evidence. */
export async function evidenceForSignal(signalId: string): Promise<Evidence[]> {
  try {
    const r = await db.execute(sql`
      SELECT * FROM hzn_evidence WHERE signal_id = ${signalId}::uuid ORDER BY occurred_at DESC LIMIT 200`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      sourceType: String(x.source_type),
      sourceId: String(x.source_id),
      timestamp: iso(x.occurred_at) || '',
      relevance: { value: Number(x.relevance_value), band: String(x.relevance_band), basis: String(x.relevance_basis) },
      reliability: {
        value: Number(x.reliability_value),
        band: String(x.reliability_band),
        basis: String(x.reliability_basis),
      },
      summary: String(x.summary),
      rawReference: {
        ownerModule: String(x.owner_module),
        table: String(x.source_table),
        recordId: String(x.record_id),
        locator: x.locator ? String(x.locator) : undefined,
        documentUrl: x.document_url ? String(x.document_url) : undefined,
      },
      evidenceClass: String(x.evidence_class),
      layer: String(x.layer),
      collectedUnder: String(x.collected_under),
      organisationId: String(x.organisation_id),
    })) as Evidence[];
  } catch (e: any) {
    logFail('evidenceForSignal', e);
    return [];
  }
}

export interface SignalCounts {
  ok: boolean;
  reason: string | null;
  byBand: { band: AttentionBand; label: string; open: number; total: number }[];
  awaitingReview: number;
}

/**
 * The board summary, with every band listed even at zero.
 *
 * A zero is the useful reading — either nothing of that sort has happened, or the detector for it is
 * not wired. Hiding zeros hides the second case, which is the one worth finding.
 */
export async function signalCounts(): Promise<SignalCounts> {
  const base = (['red', 'yellow', 'blue', 'green'] as AttentionBand[]).map((b) => ({
    band: b,
    label: BAND_LABELS[b],
    open: 0,
    total: 0,
  }));
  try {
    await ensureSignalEngineSchema();
    const r = await db.execute(sql`
      SELECT st.band,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE s.status IN ('open','acknowledged','in_progress'))::int AS open
        FROM hzn_signal s JOIN hzn_signal_state st ON st.signal_id = s.id
       GROUP BY st.band`);
    const map = new Map<string, { open: number; total: number }>();
    for (const row of rows(r)) map.set(String(row.band), { open: Number(row.open) || 0, total: Number(row.total) || 0 });
    const awaiting = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hzn_signal
       WHERE human_review_required = true AND status IN ('open','acknowledged','in_progress')`);
    return {
      ok: true,
      reason: null,
      byBand: base.map((b) => ({ ...b, ...(map.get(b.band) || {}) })),
      awaitingReview: Number(rows(awaiting)[0]?.n) || 0,
    };
  } catch (e: any) {
    logFail('signalCounts', e);
    return { ok: false, reason: reasonOf(e), byBand: base, awaitingReview: 0 };
  }
}

// =================================================================================================
// VISIBILITY
// =================================================================================================

export interface Viewer {
  id: string;
  role: string;
}

export interface ViewerAccess {
  policy: SignalPolicy;
  /** Employee ids this viewer may see through a relationship rather than through their role. */
  reportEmployeeIds: string[];
  employeeId: string | null;
  /** True when the answer is narrower than it should be because a lookup failed. Say so on screen. */
  degraded: boolean;
}

/**
 * WHAT THIS PERSON MAY SEE, resolved once per request.
 *
 * A ROLE ANSWERS THE BAND, THE ORGANISATION GRAPH ANSWERS THE PEOPLE. Both are asked; the strongest
 * answer wins for depth and the union wins for band. A viewer who is both HR and somebody's manager
 * is HR here, which is why mergePolicies() exists.
 *
 * IT FAILS CLOSED AND SAYS SO. A failed graph read narrows the answer and sets `degraded`, so a
 * screen can print "this list may be incomplete" instead of quietly showing somebody less than they
 * should see and letting them believe it is everything.
 */
export async function resolveViewerAccess(viewer: Viewer | null): Promise<ViewerAccess> {
  const out: ViewerAccess = {
    policy: policyForRole(viewer?.role),
    reportEmployeeIds: [],
    employeeId: null,
    degraded: false,
  };
  if (!viewer?.id) return out;
  try {
    const { readEmployeeIdForUser, getDirectReports } = await import('@/lib/org-graph');
    const me = await readEmployeeIdForUser(viewer.id);
    if (!me.ok) out.degraded = true;
    out.employeeId = me.employeeId;
    if (me.employeeId) {
      const reports = await getDirectReports(me.employeeId);
      const ids = (reports || []).map((p) => (p.employeeId ? String(p.employeeId) : '')).filter(Boolean);
      out.reportEmployeeIds = ids;
      if (ids.length) out.policy = mergePolicies([out.policy, RELATIONSHIP_SIGNAL_POLICY.reporting_manager]);
    }
  } catch (e: any) {
    logFail('resolveViewerAccess', e);
    out.degraded = true;
  }
  return out;
}

/**
 * The signals this viewer may see, already filtered and already redacted.
 *
 * REDACTION HAPPENS HERE, NOT ON THE SCREEN. A page that receives the full row and remembers to hide
 * the confidence arithmetic is one forgetful edit away from showing it; a page that never receives it
 * cannot.
 */
export async function visibleSignalsFor(
  viewer: Viewer | null,
  opts: ListOptions = {},
): Promise<{ ok: boolean; reason: string | null; access: ViewerAccess; rows: any[] }> {
  const access = await resolveViewerAccess(viewer);
  if (access.policy.scope === 'none') return { ok: true, reason: null, access, rows: [] };
  const read = await listSignals(opts);
  if (!read.ok) return { ok: false, reason: read.reason, access, rows: [] };

  const scoped = read.rows.filter((s) => {
    if (!seesBand(access.policy, s.band)) return false;
    if (access.policy.scope === 'all') return true;
    if (access.policy.scope === 'self') return !!access.employeeId && s.subjectId === access.employeeId;
    // 'reports' and 'department': a department read contract does not exist yet, so a department head
    // sees their own reports rather than a department this patch cannot scope to. Narrower, never wider.
    return access.reportEmployeeIds.indexOf(s.subjectId) >= 0;
  });

  return { ok: true, reason: null, access, rows: scoped.map((s) => redactForPolicy(s as any, access.policy)) };
}

// =================================================================================================
// THE HUMAN HALF
// =================================================================================================

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export const REVIEW_VERDICTS = ['confirmed', 'not_confirmed', 'needs_more_evidence', 'not_actionable'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  confirmed: 'I looked, and it holds',
  not_confirmed: 'I looked, and it does not hold',
  needs_more_evidence: 'Not enough to say either way',
  not_actionable: 'Real, but nothing to do here',
};

function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === 'string' && (REVIEW_VERDICTS as readonly string[]).indexOf(v) >= 0;
}

/** May this viewer act on this signal at all? Asked again at the point of the write, never assumed. */
async function mayAct(viewer: Viewer | null, signal: StoredSignal): Promise<boolean> {
  if (!viewer?.id) return false;
  const access = await resolveViewerAccess(viewer);
  if (!access.policy.mayResolve) return false;
  if (!seesBand(access.policy, signal.band)) return false;
  if (access.policy.scope === 'all') return true;
  return access.reportEmployeeIds.indexOf(signal.subjectId) >= 0;
}

async function transition(
  id: string,
  viewer: Viewer | null,
  to: string,
  action: string,
  note: string,
  verdict: ReviewVerdict | null,
): Promise<ActionResult> {
  const signal = await getSignal(id);
  if (!signal) return { ok: false, error: 'That signal does not exist.' };
  if (!(await mayAct(viewer, signal))) return { ok: false, error: 'You are not permitted to act on this signal.' };

  const closing = to === 'resolved' || to === 'dismissed';
  const nowIso = new Date().toISOString();
  try {
    await db.execute(sql`
      UPDATE hzn_signal SET
        status = ${to},
        resolution = CASE WHEN ${closing} THEN ${to} ELSE resolution END,
        resolved_by_kind = CASE WHEN ${closing} THEN 'user' ELSE resolved_by_kind END,
        resolved_by_id = CASE WHEN ${closing} THEN ${viewer!.id} ELSE resolved_by_id END,
        resolved_reason = CASE WHEN ${closing} THEN ${note || null} ELSE resolved_reason END,
        resolved_at = CASE WHEN ${closing} THEN ${nowIso}::timestamptz ELSE resolved_at END
      WHERE id = ${id}::uuid`);
    if (verdict !== null) {
      await db.execute(sql`
        UPDATE hzn_signal_state SET review_count = review_count + 1, updated_at = NOW()
         WHERE signal_id = ${id}::uuid`);
    }
  } catch (e: any) {
    logFail('transition(' + action + ')', e);
    return { ok: false, error: reasonOf(e) };
  }

  await logLifecycle({
    signalId: id,
    dedupeKey: signal.dedupeKey,
    action,
    reason: note || null,
    actorUserId: viewer!.id,
    actorKind: 'human',
    fromStatus: signal.status,
    toStatus: to,
    fromBand: signal.band,
    toBand: signal.band,
    verdict,
    note: note || null,
  });
  return { ok: true };
}

export function acknowledgeSignal(id: string, viewer: Viewer | null): Promise<ActionResult> {
  return transition(id, viewer, 'acknowledged', 'acknowledged', '', null);
}

export function startSignalReview(id: string, viewer: Viewer | null): Promise<ActionResult> {
  return transition(id, viewer, 'in_progress', 'review_started', '', null);
}

/**
 * A NAMED PERSON SAYS WHAT THEY FOUND.
 *
 * The verdict does not change the evidence, does not delete the detector's output and does not close
 * the signal. It is one attributed row on an append-only log; a second reviewer who disagrees writes
 * a second row, and reviewDisagreement() reads both back. That is rule 24 in one function: one
 * person's judgement is recorded as one person's judgement.
 *
 * A reason is REQUIRED, and refused rather than defaulted. A verdict with no reasoning is a rating.
 */
export async function recordSignalReview(
  id: string,
  viewer: Viewer | null,
  verdict: string,
  note: string,
): Promise<ActionResult> {
  if (!isReviewVerdict(verdict)) return { ok: false, error: 'Choose one of the four review outcomes.' };
  const written = String(note || '').trim();
  if (written.length < 12) {
    return { ok: false, error: 'Say what you found, in a sentence. A verdict with no reasoning is a rating.' };
  }
  return transition(id, viewer, 'in_progress', 'reviewed', written, verdict);
}

export async function resolveSignal(id: string, viewer: Viewer | null, note: string): Promise<ActionResult> {
  const written = String(note || '').trim();
  if (written.length < 12) return { ok: false, error: 'A resolution needs a reason somebody can read later.' };
  return transition(id, viewer, 'resolved', 'resolved', written, null);
}

export async function dismissSignal(id: string, viewer: Viewer | null, note: string): Promise<ActionResult> {
  const written = String(note || '').trim();
  if (written.length < 12) return { ok: false, error: 'A dismissal needs a reason somebody can read later.' };
  return transition(id, viewer, 'dismissed', 'dismissed', written, null);
}

/**
 * EXPIRE WHAT HAS RUN OUT.
 *
 * The shared schema requires `expires_at` and indexes it, and says why: a signal that never expires
 * is a permanent mark on a person. Requiring the column and never sweeping it would have made that
 * guarantee decorative. This is the sweep, and it is deliberately blunt — status becomes 'expired',
 * nothing is deleted, and the lifecycle log records that time rather than a person closed it.
 */
export async function expireDueSignals(limit = 500): Promise<{ ok: boolean; expired: number; error: string | null }> {
  try {
    await ensureSignalEngineSchema();
    const cap = Math.max(1, Math.min(2000, Math.round(limit)));
    const r = await db.execute(sql`
      UPDATE hzn_signal SET status = 'expired', resolution = 'expired', resolved_at = NOW()
       WHERE id IN (
         SELECT id FROM hzn_signal
          WHERE resolved_at IS NULL AND expires_at < NOW() AND status IN ('open','acknowledged','in_progress')
          ORDER BY expires_at ASC LIMIT ${cap})
      RETURNING id`);
    const ids = rows(r).map((x: any) => String(x.id));
    for (const id of ids) {
      await logLifecycle({
        signalId: id,
        action: 'expired',
        reason: 'Its expiry passed with nobody acting on it. A signal that never expires becomes a permanent mark.',
        actorKind: 'system',
        toStatus: 'expired',
      });
    }
    return { ok: true, expired: ids.length, error: null };
  } catch (e: any) {
    logFail('expireDueSignals', e);
    return { ok: false, expired: 0, error: reasonOf(e) };
  }
}

// =================================================================================================
// THE SWEEP
// =================================================================================================

export interface SweepOptions {
  now?: Date;
  limit?: number;
  detectors?: string[];
  dryRun?: boolean;
  actorUserId?: string | null;
  windowDays?: number;
}

export interface SweepResult {
  ok: boolean;
  error: string | null;
  dryRun: boolean;
  employeesConsidered: number;
  employeesRead: number;
  eventsRead: number;
  /** True when the event read hit its cap, so the oldest events for some people were not seen. */
  truncated: boolean;
  candidates: number;
  refused: number;
  expired: number;
  byAction: Record<string, number>;
  detectorErrors: { detector: string; error: string }[];
  refusalReasons: string[];
  startedAt: string;
  finishedAt: string;
}

const EVENT_READ_CAP = 20000;

function eventFromRow(r: any): HrEvent {
  return {
    id: String(r.id),
    type: String(r.event_type),
    label: String(r.event_type),
    subject: {
      employeeId: r.subject_employee_id ? String(r.subject_employee_id) : null,
      applicationId: r.subject_application_id ? String(r.subject_application_id) : null,
      userId: r.subject_user_id ? String(r.subject_user_id) : null,
    },
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
    actorKind: String(r.actor_kind || 'system'),
    sourceModule: String(r.source_module || ''),
    recordRef: r.record_ref ? String(r.record_ref) : null,
    payload: typeof r.payload === 'object' && r.payload ? r.payload : {},
    assertion: String(r.assertion || 'factual'),
    assertionLabel: String(r.assertion || 'factual'),
    occurredAt: iso(r.occurred_at),
    recordedAt: iso(r.recorded_at),
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
  } as HrEvent;
}

/**
 * Run every detector across every active employee.
 *
 * TWO QUERIES, NOT TWO PER PERSON. The naive shape is a loop calling timelineFor() once per employee
 * — at 300 people that is 300 sequential round trips to a database in another region, measured on
 * this platform at ~177ms each, which would put the sweep past the function timeout on its own.
 * Instead: one read of the active roster, one read of the event window, grouped in memory.
 *
 * IT REPORTS WHAT IT DID NOT DO. If the event read hits its cap, `truncated` says so; if a detector
 * throws, it is named in `detectorErrors` and the rest still run; if a candidate is refused, the
 * reason is counted. A sweep that silently covers less than it claims is worse than one that fails.
 */
export async function runSignalSweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const startedAt = now.toISOString();
  const dryRun = opts.dryRun === true;
  const windowDays = Math.max(30, Math.min(365, Math.round(Number(opts.windowDays) || 180)));
  const limit = Math.max(1, Math.min(5000, Math.round(Number(opts.limit) || 500)));
  const byAction: Record<string, number> = {};
  const refusalReasons: string[] = [];
  const detectorErrors: { detector: string; error: string }[] = [];

  const result: SweepResult = {
    ok: false,
    error: null,
    dryRun,
    employeesConsidered: 0,
    employeesRead: 0,
    eventsRead: 0,
    truncated: false,
    candidates: 0,
    refused: 0,
    expired: 0,
    byAction,
    detectorErrors,
    refusalReasons,
    startedAt,
    finishedAt: startedAt,
  };

  try {
    await ensureSignalEngineSchema();

    const roster = rows(
      await db.execute(sql`
        SELECT id, user_id FROM hr_employees
         WHERE is_active = true AND COALESCE(employment_status, 'active') = 'active'
         ORDER BY created_at ASC
         LIMIT ${limit}`),
    );
    result.employeesConsidered = roster.length;
    if (!roster.length) {
      result.ok = true;
      result.finishedAt = new Date().toISOString();
      return result;
    }

    const employeeIds = roster.map((r: any) => String(r.id));
    const userByEmployee = new Map<string, string | null>();
    for (const r of roster) userByEmployee.set(String(r.id), r.user_id ? String(r.user_id) : null);

    const since = new Date(now.getTime() - windowDays * 86400000).toISOString();
    const eventRows = rows(
      await db.execute(sql`
        SELECT * FROM hr_events
         WHERE subject_employee_id IN ${uuidIn(employeeIds)}
           AND occurred_at >= ${since}::timestamptz
         ORDER BY subject_employee_id, occurred_at DESC
         LIMIT ${EVENT_READ_CAP}`),
    );
    result.eventsRead = eventRows.length;
    result.truncated = eventRows.length >= EVENT_READ_CAP;

    const byEmployee = new Map<string, HrEvent[]>();
    for (const r of eventRows) {
      const key = String(r.subject_employee_id);
      const list = byEmployee.get(key) || [];
      list.push(eventFromRow(r));
      byEmployee.set(key, list);
    }
    result.employeesRead = byEmployee.size;

    for (const employeeId of employeeIds) {
      const events = byEmployee.get(employeeId);
      if (!events || !events.length) continue;
      const window: DetectorWindow = { subject: employeeSubject(employeeId as any), events, now };
      const run = runDetectors(window, opts.detectors && opts.detectors.length ? opts.detectors : undefined);
      for (const err of run.errors) detectorErrors.push(err);
      result.candidates += run.candidates.length;

      for (const candidate of run.candidates) {
        const raised = await raiseSignal(candidate, {
          now,
          dryRun,
          actorUserId: opts.actorUserId || null,
          subjectUserId: userByEmployee.get(employeeId) || null,
        });
        byAction[raised.action] = (byAction[raised.action] || 0) + 1;
        if (raised.action === 'refused') {
          result.refused += 1;
          for (const r of raised.refusals) if (refusalReasons.indexOf(r) < 0) refusalReasons.push(r);
        }
      }
    }

    if (!dryRun) {
      const expiry = await expireDueSignals();
      result.expired = expiry.expired;
    }

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    return result;
  } catch (e: any) {
    logFail('runSignalSweep', e);
    result.error = reasonOf(e);
    result.finishedAt = new Date().toISOString();
    return result;
  }
}

/**
 * The same sweep for ONE person, which is what a screen calls when somebody presses "check now".
 *
 * It reads the timeline through hr-events.ts rather than duplicating the query, because that module
 * owns the four id spaces a person occupies and this one must not learn them.
 */
export async function runSignalsForEmployee(
  employeeId: string,
  opts: SweepOptions = {},
): Promise<{ ok: boolean; error: string | null; results: RaiseResult[] }> {
  const now = opts.now instanceof Date ? opts.now : new Date();
  try {
    const { timelineFor } = await import('@/lib/hr-events');
    const events = await timelineFor({ employeeId }, 500);
    const userRow = rows(await db.execute(sql`SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    const subjectUserId = userRow.length && userRow[0].user_id ? String(userRow[0].user_id) : null;
    const run = runDetectors({ subject: employeeSubject(employeeId as any), events, now }, opts.detectors);
    const results: RaiseResult[] = [];
    for (const c of run.candidates) {
      results.push(
        await raiseSignal(c, { now, dryRun: opts.dryRun === true, actorUserId: opts.actorUserId || null, subjectUserId }),
      );
    }
    return { ok: true, error: null, results };
  } catch (e: any) {
    logFail('runSignalsForEmployee', e);
    return { ok: false, error: reasonOf(e), results: [] };
  }
}

/** Re-exported so a surface needs one import for the band vocabulary. */
export { BAND_LABELS, BAND_SEVERITY, ATTENTION_RANK };
export type { AttentionBand, SubjectRef };
