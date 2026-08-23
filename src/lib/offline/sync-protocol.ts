// src/lib/offline/sync-protocol.ts — the contract between the offline client and /api/offline/sync.
//
// THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE.
//
// The previous protocol was `{ ok: true, synced: n }`. The server looped over the batch, wrapped
// each INSERT in `catch (_) {}`, and returned ok:true whatever happened. The client saw ok:true and
// deleted THE WHOLE BATCH from IndexedDB. So:
//
//     10 records sent -> 3 inserts throw -> server answers { ok: true, synced: 7 }
//                     -> client deletes all 10 -> those 3 no longer exist anywhere.
//
// Two further paths lost data the same way and were less obvious:
//   - `records.slice(0, 200)` silently discarded everything past the two-hundredth record, and the
//     client deleted those too.
//   - `ON CONFLICT (client_id) DO NOTHING` treats a row belonging to ANOTHER user as a successful
//     no-op. The sender's record is never stored, and it is acknowledged.
//
// THE INVARIANT, and it is the only thing that really matters here:
//
//     A RECORD MAY BE DELETED LOCALLY ONLY IF THE SERVER STATED THAT SPECIFIC RECORD IS PERSISTED.
//
// Not "the request succeeded". Not "the batch was accepted". That one record, by id. Everything
// below exists to make the server say which, and to make `acknowledgedIds()` the only way a caller
// can work out what may be dropped.
//
// WHY THE UNKNOWN-ERROR DEFAULT IS `retryable`. An error we cannot classify is retried rather than
// abandoned, because the cost of retrying something hopeless is noise, and the cost of abandoning
// something recoverable is somebody's unpaid work log. The client stops the noise by blocking a
// record after MAX_ATTEMPTS — blocked, still stored, still visible. Never deleted.

export type SyncStatus =
  /** Written to the database by this request. */
  | 'synced'
  /** Already present and owned by this user — an idempotent replay. Safe to acknowledge. */
  | 'duplicate'
  /** Transient. The record stays queued and is sent again later. */
  | 'retryable'
  /** Will never succeed as submitted. Stays stored locally, flagged, and is not retried. */
  | 'permanent_failure';

export interface SyncRecordResult {
  /** Position in the submitted array, so a record with no usable id can still be reported. */
  index: number;
  clientId: string | null;
  status: SyncStatus;
  /** Human-readable reason. Always present for anything that is not `synced`. */
  detail: string;
  /** Postgres SQLSTATE where there was one, for diagnosis. */
  code?: string;
}

export interface SyncResponse {
  /** Describes the REQUEST, not the records. A request can be ok with every record failing. */
  ok: boolean;
  /** One entry per submitted record, in order. Never shorter than the input. */
  results: SyncRecordResult[];
  counts: Record<SyncStatus, number>;
  error?: string;
}

/** Records accepted per request. Anything beyond this is answered `retryable`, never dropped. */
export const MAX_BATCH = 200;

/** A single record's serialised payload ceiling. Beyond this it cannot be stored, ever. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Client-side: attempts before a record stops being retried automatically and is flagged instead. */
export const MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Which statuses mean "the server has it"
// ---------------------------------------------------------------------------

/**
 * The whole safety property, in one function.
 *
 * `duplicate` is acknowledgeable because the server only reports it after confirming the existing
 * row belongs to THIS user — see the ownership guard in the route. Without that guard a duplicate
 * would be indistinguishable from another account's record with a colliding id, and acknowledging
 * it would drop the sender's work.
 */
export function isPersisted(status: SyncStatus): boolean {
  return status === 'synced' || status === 'duplicate';
}

/**
 * The ids a client may delete. The ONLY sanctioned way to answer that question.
 *
 * Note what it does not do: it does not look at `ok`, it does not count, and it does not fall back
 * to "everything" when results are missing. An empty result list yields an empty answer, which
 * means a malformed or truncated response deletes nothing.
 */
export function acknowledgedIds(results: readonly SyncRecordResult[] | null | undefined): string[] {
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  for (const r of results) {
    if (r && typeof r.clientId === 'string' && r.clientId && isPersisted(r.status)) out.push(r.clientId);
  }
  return out;
}

export function emptyCounts(): Record<SyncStatus, number> {
  return { synced: 0, duplicate: 0, retryable: 0, permanent_failure: 0 };
}

export function countByStatus(results: readonly SyncRecordResult[]): Record<SyncStatus, number> {
  const counts = emptyCounts();
  for (const r of results) if (r && counts[r.status] !== undefined) counts[r.status]++;
  return counts;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface IncomingRecord {
  clientId?: unknown;
  kind?: unknown;
  data?: unknown;
  createdAt?: unknown;
}

export interface ValidatedRecord {
  clientId: string;
  kind: string;
  payload: string;
  createdAt: Date;
}

export type ValidationOutcome =
  | { ok: true; value: ValidatedRecord }
  | { ok: false; status: 'permanent_failure'; detail: string };

/**
 * Validate one submitted record.
 *
 * Failures here are PERMANENT: a record with no id or an unserialisable payload will not become
 * valid by being sent again. It still is not deleted — the client keeps it, flagged, so somebody
 * can look at it. "Cannot be stored" and "may be thrown away" are different conclusions and this
 * codebase has conflated them before.
 */
export function validateRecord(r: IncomingRecord | null | undefined): ValidationOutcome {
  if (!r || typeof r !== 'object') {
    return { ok: false, status: 'permanent_failure', detail: 'Not an object.' };
  }

  const rawId = (r as any).clientId;
  if (typeof rawId !== 'string' || !rawId.trim()) {
    return { ok: false, status: 'permanent_failure', detail: 'Missing clientId. The server cannot acknowledge a record it cannot name.' };
  }
  const clientId = rawId.trim();
  if (clientId.length > 200) {
    return { ok: false, status: 'permanent_failure', detail: `clientId is ${clientId.length} characters; the limit is 200.` };
  }

  // `kind` is truncated rather than refused: a long label is a cosmetic problem and refusing the
  // record over it would strand real work.
  const kind = String((r as any).kind ?? 'work').slice(0, 80) || 'work';

  let payload: string;
  try {
    payload = JSON.stringify((r as any).data ?? {});
    if (payload === undefined) throw new Error('payload is not serialisable');
  } catch (e: any) {
    return { ok: false, status: 'permanent_failure', detail: `Payload cannot be serialised: ${e?.message || 'unknown'}.` };
  }
  const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(payload, 'utf8') : payload.length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 'permanent_failure', detail: `Payload is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.` };
  }

  // An unparseable timestamp falls back to now rather than failing. The record's content is what
  // matters; losing a worklog because a device clock produced a bad string would be absurd.
  const rawAt = (r as any).createdAt;
  let createdAt = new Date();
  if (rawAt != null) {
    const t = Date.parse(String(rawAt));
    if (Number.isFinite(t)) createdAt = new Date(t);
  }

  return { ok: true, value: { clientId, kind, payload, createdAt } };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * SQLSTATEs that mean "try again" — connection loss, contention, resource exhaustion, cancellation.
 * A pooled serverless deployment against a transaction pooler produces these routinely and none of
 * them says anything about the record.
 */
const RETRYABLE_CODES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',   // connection exceptions
  '40000', '40001', '40002', '40003', '40P01',                     // rollback / serialization / deadlock
  '53000', '53100', '53200', '53300', '53400',                     // insufficient resources
  '55006', '55P03',                                                // object in use / lock not available
  '57014', '57P01', '57P02', '57P03', '57P04',                     // cancelled / shutdown / crash
  '58000', '58030',                                                // system and IO errors
  'XX000', 'XX001', 'XX002',                                       // internal errors, often transient here
  '42P01',                                                         // undefined_table: the DDL bootstrap may fix it
]);

/**
 * SQLSTATEs that will produce the identical failure on every retry. Note what is NOT here: unique
 * violation on our own conflict target, which the route handles as an ownership question rather
 * than an error.
 */
const PERMANENT_CODES = new Set([
  '22001', '22003', '22007', '22008', '22012', '22023', '22P02',   // data exceptions / bad input syntax
  '23502', '23503', '23514',                                       // not null / foreign key / check
  '42703', '42804', '42883', '42601',                              // undefined column / type mismatch / syntax
  '54000', '54001', '54011',                                       // program limit exceeded
]);

/**
 * Classify a persistence failure.
 *
 * DEFAULTS TO RETRYABLE, deliberately. An unclassified error retried is noise; an unclassified
 * error abandoned is lost work. The client bounds the noise with MAX_ATTEMPTS.
 *
 * The real Postgres code is on `e.cause` — `e.message` on a Drizzle error is only the failed SQL,
 * which is why this reads both.
 */
export function classifyPersistError(e: unknown): { status: 'retryable' | 'permanent_failure'; code?: string; detail: string } {
  const err = e as any;
  const code: string | undefined = err?.cause?.code || err?.code;
  const message: string = String(err?.cause?.message || err?.message || 'unknown database error');

  if (code && PERMANENT_CODES.has(code)) {
    return { status: 'permanent_failure', code, detail: `${code}: ${message}` };
  }
  if (code && RETRYABLE_CODES.has(code)) {
    return { status: 'retryable', code, detail: `${code}: ${message}` };
  }

  // No code at all is usually a network or driver-level failure — fetch aborted, socket closed,
  // pool timed out. All transient.
  return { status: 'retryable', code, detail: code ? `${code}: ${message}` : message };
}

// ---------------------------------------------------------------------------
// Client-side retry scheduling (exported here so both halves agree)
// ---------------------------------------------------------------------------

/**
 * Backoff before re-sending a retryable record. Capped at 15 minutes so a device that comes back
 * onto a signal after a long outage does not sit idle, and floored at 5 seconds so a flapping
 * connection is not hammered.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(15 * 60_000, 5_000 * Math.pow(2, Math.min(n, 8)));
}

/** Has this record exhausted automatic retries and become something a human has to look at. */
export function isBlocked(attempts: number, status: SyncStatus): boolean {
  if (status === 'permanent_failure') return true;
  return attempts >= MAX_ATTEMPTS;
}

/** One line for a UI listing a stuck record. */
export function describeResult(r: SyncRecordResult): string {
  switch (r.status) {
    case 'synced': return 'Saved to the server.';
    case 'duplicate': return 'Already on the server.';
    case 'retryable': return `Not saved yet — will try again. ${r.detail}`;
    case 'permanent_failure': return `Cannot be saved. ${r.detail}`;
    default: return r.detail;
  }
}
