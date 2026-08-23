// src/lib/horizon/intake/events.ts — WHAT THIS PATCH PUBLISHES, AND THE DURABLE ROW BEHIND IT.
//
// =================================================================================================
// TWO EVENTS, AND ONLY TWO
// =================================================================================================
//
//   application.submitted        an applicant completed and submitted the form.
//   profile.recompute_requested  something changed that a derived profile should be rebuilt from.
//
// Both names already exist in the platform's vocabulary or extend it additively — see EVENTS in
// src/lib/events.ts. `application.submitted` has been declared there since the bus was written and
// has never had a producer; this patch is the producer.
//
// =================================================================================================
// WHY A DATABASE ROW AND NOT JUST AN EMIT
// =================================================================================================
//
// src/lib/events.ts is in-process and deliberately so. On this platform the serverless function can
// be frozen the instant the response is written, so a module that writes its row and then emits has
// a window in which the change happened and no engine ever hears about it: no recomputation, no
// retry, and nothing anywhere saying a delivery was missed. src/lib/talent/events.ts records the
// same reasoning for the same platform.
//
// So a recomputation REQUEST is a row first and an event second. The row is the contract: an engine
// drains `hzn_recompute_request`, reports back through markRecomputeRequest(), and a request that
// nobody picked up is visible instead of lost. The bus emit on top is the fast path for anything
// already running in this process.
//
// AT MOST ONE PENDING REQUEST PER SUBJECT, enforced by a partial unique index rather than by the
// caller remembering. An applicant who re-walks the form, a retried submission and a double-click
// all collapse onto the same waiting row.
//
// =================================================================================================
// WHAT NEVER TRAVELS IN A PAYLOAD
// =================================================================================================
//
// No date of birth, no time, no place, no coordinates, no zone. An event fans out to every
// subscriber and some of them log what they receive; a payload carrying those values would leak
// exactly what the storage boundary exists to protect. Subscribers entitled to the values call
// readPersonalFoundation() and are audited for it.
import { sql } from 'drizzle-orm';
import { EVENTS, emit } from '@/lib/events';
import { DEFAULT_ORGANISATION_ID, isSubjectRef, type ActorRef, type SubjectRef } from '@/lib/horizon/ids';
import { markProcessingStatus, storedInputHash } from './foundation';
import { ensureHorizonIntakeSchema } from './schema';
import {
  reasonOf,
  rowsOf,
  type ApplicationSubmittedPayload,
  type HorizonEventSink,
  type ProfileRecomputeRequestedPayload,
  type RecomputeReason,
  type RecomputeRequest,
  type RecomputeStatus,
} from './types';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — before anything that reads them.
// -------------------------------------------------------------------------------------------------

/**
 * The two names, in one place.
 *
 * `application.submitted` comes from the platform vocabulary so a typo is a build error rather than
 * an event nobody receives. `profile.recompute_requested` is added to that same object by this patch
 * — additively, changing nothing that already reads it.
 */
export const HORIZON_INTAKE_EVENTS = {
  APPLICATION_SUBMITTED: EVENTS.APPLICATION_SUBMITTED,
  PROFILE_RECOMPUTE_REQUESTED: EVENTS.PROFILE_RECOMPUTE_REQUESTED,
} as const;

const MAX_ERROR_CHARS = 500;

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

// -------------------------------------------------------------------------------------------------
// THE OPTIONAL DURABLE SINK
// -------------------------------------------------------------------------------------------------

let sink: HorizonEventSink | null = null;

/**
 * Register a durable outbox.
 *
 * ids.ts records `hzn_event` as a HORIZON-owned outbox table, and no patch has shipped it yet. Rule
 * 8 of the brief: publish a typed boundary rather than building somebody else's module. When that
 * patch lands it calls this once at startup and every event this module publishes also reaches the
 * outbox — with no change to any producer here.
 */
export function setHorizonEventSink(s: HorizonEventSink | null): void { sink = s; }

/** Whatever sink is registered, for a test or an ops screen that wants to know. */
export function horizonEventSink(): HorizonEventSink | null { return sink; }

/**
 * Publish to the bus and, if one is registered, to the durable sink.
 *
 * NEVER THROWS. emit() already isolates each handler; the sink is wrapped for the same reason. A
 * submission that has committed is a fact, and a failed notification must not turn it into an error
 * shown to an applicant — but it IS logged with the real reason, because `catch (_) {}` is how a
 * fault hid here for months.
 */
async function publish(name: string, payload: unknown, correlationId: string | null): Promise<void> {
  await emit(name, payload, { correlationId });
  if (sink) {
    try {
      await sink.publish({ name, payload, correlationId });
    } catch (e: any) {
      console.error('[horizon/intake] durable sink rejected ' + name + ':', reasonOf(e));
    }
  }
}

// -------------------------------------------------------------------------------------------------
// application.submitted
// -------------------------------------------------------------------------------------------------

/**
 * Announce a completed submission.
 *
 * Called from the last step of the application flow AFTER the submission has actually been staged —
 * never before, and never from a page render. A subscriber that hears this and then finds nothing in
 * the database has been lied to.
 */
export async function emitApplicationSubmitted(
  payload: ApplicationSubmittedPayload,
  correlationId: string | null = null,
): Promise<void> {
  try {
    await publish(HORIZON_INTAKE_EVENTS.APPLICATION_SUBMITTED, payload, correlationId);
  } catch (e: any) {
    console.error('[horizon/intake] application.submitted publish failed:', reasonOf(e));
  }
}

// -------------------------------------------------------------------------------------------------
// profile.recompute_requested
// -------------------------------------------------------------------------------------------------

export interface RequestRecomputeArgs {
  subject: SubjectRef;
  reason: RecomputeReason;
  /** An applications.id or an application_intents.id. Text; the two live in different tables. */
  applicationRef?: string | null;
  /** Keyed HMAC of the stored input, from storePersonalFoundation(). Null when nothing is stored. */
  inputHash?: string | null;
  correlationId?: string | null;
  actor?: ActorRef | null;
}

export interface RequestRecomputeResult {
  ok: boolean;
  request: RecomputeRequest | null;
  /** False when the row could not be written — the caller then knows the ask was not durable. */
  durable: boolean;
  message: string;
}

/**
 * Ask for a recomputation.
 *
 * A REQUEST, NOT AN INSTRUCTION AND NOT A RESULT. Nothing in this patch computes anything, and a
 * consumer is free to look at the request and decide it is not worth acting on.
 *
 * The row goes in first and the event goes out second, deliberately: if the process dies between
 * them the request is still on the queue, whereas the reverse order would announce work that has no
 * record. The upsert collapses onto an existing pending row, so re-walking the form does not pile up
 * duplicate work.
 */
export async function requestRecompute(args: RequestRecomputeArgs): Promise<RequestRecomputeResult> {
  const { subject } = args;
  if (!isSubjectRef(subject)) {
    return { ok: false, request: null, durable: false, message: 'Not a valid subject reference.' };
  }

  // A caller that just wrote the record passes the hash it computed; anyone else (a submission step,
  // an operator re-queueing by hand) should not have to know how to derive one, so it is read from
  // the stored row. Reading it decrypts nothing — it is a keyed HMAC in a metadata column.
  const inputHash = args.inputHash !== undefined && args.inputHash !== null
    ? args.inputHash
    : await storedInputHash(subject);

  let request: RecomputeRequest | null = null;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      INSERT INTO hzn_recompute_request (
        organisation_id, subject_kind, subject_id_scheme, subject_id,
        reason, status, input_hash, correlation_id, application_ref, updated_at
      ) VALUES (
        ${subject.organisationId}, ${subject.kind}, ${subject.idScheme}, ${subject.id},
        ${args.reason}, 'pending', ${inputHash}, ${args.correlationId || null},
        ${args.applicationRef || null}, NOW()
      )
      ON CONFLICT (organisation_id, subject_kind, subject_id_scheme, subject_id)
        WHERE status = 'pending'
      DO UPDATE SET
        reason          = EXCLUDED.reason,
        input_hash      = COALESCE(EXCLUDED.input_hash, hzn_recompute_request.input_hash),
        correlation_id  = COALESCE(EXCLUDED.correlation_id, hzn_recompute_request.correlation_id),
        application_ref = COALESCE(EXCLUDED.application_ref, hzn_recompute_request.application_ref),
        requested_at    = NOW(),
        updated_at      = NOW()
      RETURNING *
    `);
    const row = rowsOf(res)[0];
    request = row ? toRecomputeRequest(row) : null;
  } catch (e: any) {
    console.error('[horizon/intake] recompute request write failed:', reasonOf(e));
  }

  if (!request) {
    // NOT SILENT, AND NOT FATAL. The event still goes out so anything already listening in this
    // process reacts, but the caller is told the ask was not made durable so it can surface that
    // rather than reporting a success nobody can verify later.
    await publish(HORIZON_INTAKE_EVENTS.PROFILE_RECOMPUTE_REQUESTED, {
      subject, requestId: '', reason: args.reason, requestedAt: new Date().toISOString(),
      inputHash, applicationRef: args.applicationRef || null,
      correlationId: args.correlationId || null,
    } satisfies ProfileRecomputeRequestedPayload, args.correlationId || null);
    return {
      ok: false, request: null, durable: false,
      message: 'The recomputation could not be queued. It was announced in-process only.',
    };
  }

  // The record's own lifecycle catches up with the queue. Best effort: a status that lags is a
  // cosmetic problem, and failing the request over it would be the wrong trade.
  await markProcessingStatus(subject, 'recompute_requested').catch(() => {});

  const payload: ProfileRecomputeRequestedPayload = {
    subject,
    requestId: request.id,
    reason: request.reason,
    requestedAt: request.requestedAt,
    inputHash: request.inputHash,
    applicationRef: request.applicationRef,
    correlationId: request.correlationId,
  };
  await publish(HORIZON_INTAKE_EVENTS.PROFILE_RECOMPUTE_REQUESTED, payload, request.correlationId);

  return { ok: true, request, durable: true, message: 'Recomputation requested.' };
}

// -------------------------------------------------------------------------------------------------
// THE QUEUE CONTRACT — for whichever patch owns the computation engine
// -------------------------------------------------------------------------------------------------

function iso(v: any): string {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : String(v);
}

/** PURE. Map a row to the exported shape. */
export function toRecomputeRequest(r: any): RecomputeRequest {
  return {
    id: String(r.id),
    subject: {
      kind: r.subject_kind,
      id: String(r.subject_id),
      idScheme: r.subject_id_scheme,
      organisationId: String(r.organisation_id || DEFAULT_ORGANISATION_ID),
    },
    reason: r.reason as RecomputeReason,
    status: r.status as RecomputeStatus,
    requestedAt: iso(r.requested_at),
    updatedAt: iso(r.updated_at),
    inputHash: r.input_hash ?? null,
    correlationId: r.correlation_id ?? null,
    applicationRef: r.application_ref ?? null,
    attempts: Number(r.attempts || 0),
    lastError: r.last_error ?? null,
  };
}

/**
 * The waiting queue, oldest first.
 *
 * READ-ONLY AND UNCLAIMED. This patch deliberately does NOT implement claiming, leasing or draining:
 * that is the computation patch's job and it will want its own concurrency model. What is guaranteed
 * here is that the rows exist, are deduplicated, and can be reported back on.
 */
export async function pendingRecomputeRequests(limit = 100): Promise<RecomputeRequest[]> {
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await db.execute(sql`
      SELECT * FROM hzn_recompute_request
      WHERE status = 'pending'
      ORDER BY requested_at ASC
      LIMIT ${capped}
    `);
    return rowsOf(res).map(toRecomputeRequest);
  } catch (e: any) {
    console.error('[horizon/intake] pending requests read failed:', reasonOf(e));
    return [];
  }
}

/** One request by id, for a consumer that received the event and wants the durable row. */
export async function getRecomputeRequest(id: string): Promise<RecomputeRequest | null> {
  if (!id) return null;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`SELECT * FROM hzn_recompute_request WHERE id = ${id}::uuid LIMIT 1`);
    const row = rowsOf(res)[0];
    return row ? toRecomputeRequest(row) : null;
  } catch (e: any) {
    console.error('[horizon/intake] request read failed:', reasonOf(e));
    return null;
  }
}

/**
 * Report back on a request.
 *
 * THE ONE WRITE THIS PATCH EXPOSES TO ANOTHER PATCH, so an engine never has to reach into
 * hzn_recompute_request with its own SQL. `attempts` increments on every claim and every failure,
 * which is what makes a request that keeps dying visible rather than merely slow.
 */
export async function markRecomputeRequest(
  id: string,
  status: RecomputeStatus,
  note?: string | null,
): Promise<boolean> {
  if (!id) return false;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const bumps = status === 'claimed' || status === 'failed';
    const res = await db.execute(sql`
      UPDATE hzn_recompute_request SET
        status     = ${status},
        attempts   = attempts + ${bumps ? 1 : 0},
        last_error = ${note ? String(note).slice(0, MAX_ERROR_CHARS) : null},
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id
    `);
    return rowsOf(res).length > 0;
  } catch (e: any) {
    console.error('[horizon/intake] request update failed:', reasonOf(e));
    return false;
  }
}
