// src/lib/manager-intelligence/record-port.ts — THE BOUNDARY TO THE CENTRAL EMPLOYEE INTELLIGENCE
// RECORD. A PORT, NOT AN IMPLEMENTATION.
//
// =================================================================================================
// THE DEPENDENCY THIS PATCH HAS, AND WHAT IT DOES ABOUT IT
// =================================================================================================
//
// Patch 14's brief ends with "every action must feed back into the central employee intelligence
// record". That record is another patch's to build, and at the time this was written no module in
// this repository owns one. So this file is the INTEGRATION BOUNDARY, and it was built the way the
// multi-agent rules require a missing dependency to be handled: a typed interface plus a durable
// queue, never a guess at somebody else's table.
//
// THE OUTBOX IS THE CONTRACT, AND IT WORKS WITH NOBODY ON THE OTHER END. publishToRecord() writes
// mti_record_outbox FIRST, in the same request as the act, and only then looks for a sink. So:
//
//   - with no sink registered, every act is queued, `published_at` stays null, and the owning patch
//     drains the queue whenever it arrives. Nothing is lost and nothing is invented.
//   - with a sink registered, the row is marked published the moment the sink accepts it.
//   - with a sink that fails, the row stays pending WITH the reason on it, and the next drain retries.
//
// A DIRECT CALL INTO THE CENTRAL RECORD WOULD HAVE BEEN THE WRONG SHAPE for exactly one reason: an
// act would then be lost whenever that module was absent, mid-deploy, or failing — and the act is a
// manager's statement about a colleague, which is the last thing in this system that may quietly
// evaporate. A queue that nobody has connected to yet is honest. A call that silently no-ops is not.
//
// =================================================================================================
// WHAT CROSSES THE BOUNDARY
// =================================================================================================
//
// RecordEnvelope, and only RecordEnvelope. It names the act, the subject, the actor, the signal it
// answered, and a `recordRef` pointing at the row that holds the words. IT CARRIES NO FREE TEXT
// ABOUT A PERSON — the feedback stays in hr_feedback, the referral stays in helpdesk_tickets, the
// intervention note stays in mti_manager_actions. A second copy of somebody's appraisal note living
// in a table nobody thinks of as holding one is how disclosure happens by accident.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { readyState } from './schema';
import type { RecordEnvelope } from './types';

const MOD = 'manager-intelligence/record-port';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message || e);

// -------------------------------------------------------------------------------------------------
// THE INTERFACE THE OWNING PATCH IMPLEMENTS
// -------------------------------------------------------------------------------------------------

export interface SinkResult {
  ok: boolean;
  /** Why not. Recorded on the outbox row so a drain can be diagnosed without a log search. */
  error?: string;
}

/**
 * What the central employee intelligence record has to provide for this patch to reach it.
 *
 * `accept` MUST BE IDEMPOTENT ON envelope.actionId. The outbox retries, and a manager's single
 * acknowledgement appearing three times on somebody's record because a network call was retried is
 * a defect that looks like a manager who cannot stop pressing buttons.
 */
export interface EmployeeIntelligenceSink {
  /** For the ops line: which module is receiving these. */
  name: string;
  accept(envelope: RecordEnvelope): Promise<SinkResult>;
}

let sink: EmployeeIntelligenceSink | null = null;

/**
 * Register the central record as the consumer of this patch's acts.
 *
 * Called once, at module load, by whichever patch owns the central record — not by this patch, and
 * not by a page. Registering a second sink REPLACES the first and says so in the log: two consumers
 * would each see half the acts depending on load order, which is worse than one.
 */
export function registerEmployeeIntelligenceSink(next: EmployeeIntelligenceSink): void {
  if (sink && sink.name !== next.name) {
    console.warn('[' + MOD + '] sink ' + sink.name + ' replaced by ' + next.name
      + '. Only one consumer may be registered; the previous one will receive nothing further.');
  }
  sink = next;
}

/** Who is currently receiving acts, if anybody. Null is a normal state, not an error. */
export function registeredSink(): EmployeeIntelligenceSink | null {
  return sink;
}

/** Used only by tests, to put the module back to its unregistered state. */
export function clearEmployeeIntelligenceSink(): void {
  sink = null;
}

// -------------------------------------------------------------------------------------------------
// PUBLISHING
// -------------------------------------------------------------------------------------------------

export interface PublishResult {
  /** The envelope reached the outbox. This is the guarantee the caller actually needs. */
  queued: boolean;
  /** A registered sink accepted it in this request. False is normal when no sink exists. */
  delivered: boolean;
  outboxId: string | null;
  /** A sentence a surface may print. Empty when everything worked. */
  note: string;
}

const QUEUE_FAILED =
  'This act was recorded, but it could not be queued for the central employee record. It will not '
  + 'appear there until it is re-published. Nothing else about the act changed.';

/**
 * Queue one act for the central record, then try to deliver it.
 *
 * NEVER THROWS. It is called immediately after a write that already succeeded, and a failure here
 * must not roll back somebody's feedback — the same decision hr-events.ts makes about its own emits.
 * What it does instead is REPORT, so the caller can print the honest sentence rather than a success
 * message covering a queue that took nothing.
 */
export async function publishToRecord(envelope: RecordEnvelope): Promise<PublishResult> {
  let outboxId: string | null = null;
  try {
    const state = await readyState();
    if (!state.ok) {
      return { queued: false, delivered: false, outboxId: null, note: state.sentence };
    }
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO mti_record_outbox (action_id, envelope)
      VALUES (${envelope.actionId}::uuid, ${JSON.stringify(envelope)}::jsonb)
      RETURNING id`));
    outboxId = ins.length ? String(ins[0].id) : null;
  } catch (e: any) {
    logFail('queue', e);
    return { queued: false, delivered: false, outboxId: null, note: QUEUE_FAILED };
  }

  if (!outboxId) return { queued: false, delivered: false, outboxId: null, note: QUEUE_FAILED };
  if (!sink) {
    // NOT AN ERROR, AND NOT A SILENCE EITHER. The row is durable and the sentence says where it is.
    return {
      queued: true,
      delivered: false,
      outboxId,
      note: '',
    };
  }

  try {
    const res = await sink.accept(envelope);
    await markOutbox(outboxId, res.ok, res.ok ? null : (res.error || 'The central record refused it without a reason.'));
    return {
      queued: true,
      delivered: res.ok,
      outboxId,
      note: res.ok ? '' : 'This act is recorded and queued. The central employee record did not take it '
        + 'just now, so it will be delivered on the next drain.',
    };
  } catch (e: any) {
    logFail('sink.accept', e);
    await markOutbox(outboxId, false, String(e?.cause?.message || e?.message || 'sink threw').slice(0, 400));
    return {
      queued: true,
      delivered: false,
      outboxId,
      note: 'This act is recorded and queued. The central employee record could not be reached just now.',
    };
  }
}

async function markOutbox(outboxId: string, ok: boolean, error: string | null): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE mti_record_outbox
         SET attempts = attempts + 1,
             published_at = ${ok ? sql`NOW()` : sql`published_at`},
             publish_error = ${error}
       WHERE id = ${outboxId}::uuid`);
  } catch (e: any) {
    logFail('markOutbox', e);
  }
}

// -------------------------------------------------------------------------------------------------
// DRAINING — THE HALF THE CONSUMING PATCH CALLS
// -------------------------------------------------------------------------------------------------

export interface OutboxRow {
  id: string;
  actionId: string;
  envelope: RecordEnvelope;
  attempts: number;
  publishError: string | null;
  createdAt: string | null;
}

/**
 * Everything queued and not yet accepted, oldest first.
 *
 * The consuming patch reads these, writes them into the central record, and calls
 * acknowledgeDelivery() for each id it took. Oldest first so a backlog drains in the order the acts
 * happened, which is the order they have to appear on somebody's record.
 */
export async function pendingEnvelopes(limit = 200): Promise<OutboxRow[]> {
  try {
    const state = await readyState();
    if (!state.ok) return [];
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return rowsOf(await db.execute(sql`
      SELECT id, action_id, envelope, attempts, publish_error, created_at
        FROM mti_record_outbox
       WHERE published_at IS NULL
       ORDER BY created_at ASC
       LIMIT ${n}`)).map((r: any) => ({
      id: String(r.id),
      actionId: String(r.action_id),
      envelope: (r.envelope || {}) as RecordEnvelope,
      attempts: Number(r.attempts) || 0,
      publishError: r.publish_error ? String(r.publish_error) : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail('pendingEnvelopes', e);
    return [];
  }
}

/** Mark one queued envelope as taken by the central record. Idempotent. */
export async function acknowledgeDelivery(outboxId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.execute(sql`
      UPDATE mti_record_outbox
         SET published_at = COALESCE(published_at, NOW()),
             publish_error = NULL,
             attempts = attempts + 1
       WHERE id = ${outboxId}::uuid`);
    return { ok: true };
  } catch (e: any) {
    logFail('acknowledgeDelivery', e);
    return { ok: false, error: String(e?.cause?.message || e?.message || 'db error').slice(0, 400) };
  }
}

export interface OutboxHealth {
  ok: boolean;
  pending: number;
  oldestPendingAt: string | null;
  withError: number;
  sinkName: string | null;
  /** A sentence for an ops screen. Never "healthy" when the check itself could not run. */
  sentence: string;
}

/**
 * Is anything stuck?
 *
 * A queue nobody drains looks exactly like a queue that is working, right up until somebody asks why
 * six weeks of manager actions are missing from a record. This is the number that answers that
 * before it is asked.
 */
export async function outboxHealth(): Promise<OutboxHealth> {
  const sinkName = sink ? sink.name : null;
  try {
    const state = await readyState();
    if (!state.ok) {
      return { ok: false, pending: 0, oldestPendingAt: null, withError: 0, sinkName, sentence: state.sentence };
    }
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS pending,
             MIN(created_at) AS oldest,
             COUNT(*) FILTER (WHERE publish_error IS NOT NULL)::int AS with_error
        FROM mti_record_outbox
       WHERE published_at IS NULL`));
    const pending = Number(r[0]?.pending) || 0;
    const oldest = r[0]?.oldest ? new Date(r[0].oldest).toISOString() : null;
    const withError = Number(r[0]?.with_error) || 0;
    return {
      ok: true,
      pending,
      oldestPendingAt: oldest,
      withError,
      sinkName,
      sentence: pending === 0
        ? 'Nothing is waiting to reach the central employee record.'
        : (sinkName
          ? String(pending) + ' acts are waiting for ' + sinkName + ' to take them.'
          : String(pending) + ' acts are queued. No consumer is registered for the central employee '
            + 'record yet, so nothing has been delivered — they are held, not lost.'),
    };
  } catch (e: any) {
    logFail('outboxHealth', e);
    return {
      ok: false,
      pending: 0,
      oldestPendingAt: null,
      withError: 0,
      sinkName,
      sentence: 'The outbox could not be read just now, so this cannot say whether anything is waiting.',
    };
  }
}
