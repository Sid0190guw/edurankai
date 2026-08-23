// src/lib/talent/events.ts — THE TRANSACTIONAL OUTBOX. Spec section 29.
//
// WHY AN OUTBOX AND NOT A BUS CALL.
// src/lib/events.ts already gives this codebase an in-process, failure-isolated bus, and it is the
// right thing for "notify these subscribers now". What it cannot do is survive the process. On
// Vercel the function can be frozen the instant the response is written, so a domain module that
// writes its row and then calls emit() has a window in which the row exists and nobody downstream
// ever hears about it — no notification, no provisioning proposal, no integration push, and nothing
// anywhere saying a delivery was missed. That is the failure this table exists to close: the event
// is RECORDED in the database next to the fact that caused it, and delivery is a separate, retried
// pass that marks delivered_at when it succeeds.
//
// THE TRADE-OFF, STATED PLAINLY.
// emitTalentEvent() NEVER throws into its caller. A selection decision that committed is a fact; if
// the outbox INSERT fails, the honest outcome is a recorded, tracked delivery gap — not a rolled-back
// hire. So the failure is logged with the real Postgres reason and pushed to trackError() so it
// lands on the ops incident board, and the function returns. This is also precisely WHY the table
// carries delivered_at, attempts and last_error rather than being a fire-and-forget bus: a lost
// event has to be visible and re-drivable, and none of that is possible if the only record of the
// attempt was a console line.
//
// DELIVERY IS AT-LEAST-ONCE. A row is claimed, handed to the bus, and only then marked delivered. A
// worker that dies between those two points leaves the row undelivered, and a later drain replays
// it. Subscribers MUST therefore be idempotent — the envelope carries `eventId` (the tal_event row
// id) and the bus meta carries it again as `correlationId`, so a subscriber that needs exactly-once
// effects has a stable natural key to deduplicate on.
//
// HOUSE RULES OBSERVED HERE: postgres-js returns PLAIN ARRAYS (rowsOf); the real Postgres reason is
// on e.cause (reasonOf); every const is declared above the function that uses it; no write path
// swallows an exception silently; department_id is never cast ::uuid (this module does not touch it).
//
// THE DATABASE IS RESOLVED LAZILY, on purpose. A module-scope `import { db }` makes every pure
// function below unreachable from a test that needs no connection at all — src/lib/audit.ts carries
// the same note for the same reason. ensureTalent() is imported the same way, because
// src/lib/talent/schema.ts does import the connection at module scope.
import { sql } from 'drizzle-orm';
import { emit } from '@/lib/events';
import { rowsOf, reasonOf } from '@/lib/talent/types';

// ---------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/** Claim attempts before an event stops being retried and becomes an operator problem. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * How long a claim is honoured before another drain may take the row back. Longer than any drain
 * pass should ever run; short enough that a worker killed mid-pass does not strand its events.
 */
export const LEASE_MS = 5 * 60 * 1000;

/** Payload budget. An event payload is identifiers and small facts, never a document. */
export const MAX_PAYLOAD_CHARS = 8000;

/** last_error is diagnosis, not an archive. */
export const MAX_ERROR_CHARS = 500;

/** How deep the payload scrubber walks before it stops describing and starts summarising. */
export const MAX_SCRUB_DEPTH = 4;

export const DRAIN_DEFAULT_LIMIT = 50;

/** Anything a claim writes into last_error starts with this. See claimLease() below. */
export const LEASE_PREFIX = 'lease:';

/** Postgres POSIX pattern for a well-formed lease marker. Must agree with claimLease(). */
const LEASE_SQL_PATTERN = '^lease:[0-9]+:';

const LEASE_JS_PATTERN = /^lease:(\d+):(.*)$/;

// ---------------------------------------------------------------------------------------------
// THE EVENT VOCABULARY — spec 29 "Event catalogue".
//
// A const object rather than loose strings so a typo is a BUILD error instead of an event nobody
// ever receives. This codebase has already paid for the alternative twice: twenty-two notification
// types that were never registered, and the string constants src/lib/events.ts EVENTS exists to
// prevent. Adding an event means adding a line here; passing a string that is not in this object is
// refused by the compiler.
// ---------------------------------------------------------------------------------------------

export const TALENT_EVENTS = {
  CANDIDATE_CREATED: 'candidate.created',
  APPLICATION_RECEIVED: 'application.received',
  APPLICATION_IMPORTED: 'application.imported',
  CANDIDATE_SHORTLISTED: 'candidate.shortlisted',
  ASSESSMENT_COMPLETED: 'assessment.completed',
  ASSIGNMENT_SUBMITTED: 'assignment.submitted',
  INTERVIEW_SCHEDULED: 'interview.scheduled',
  INTERVIEW_COMPLETED: 'interview.completed',
  EVALUATION_SUBMITTED: 'evaluation.submitted',
  CANDIDATE_SELECTED: 'candidate.selected',
  CANDIDATE_REJECTED: 'candidate.rejected',
  CANDIDATE_WAITLISTED: 'candidate.waitlisted',
  SELECTION_APPROVED_FOR_ONBOARDING: 'selection.approved_for_onboarding',
  ONBOARDING_CODE_GENERATED: 'onboarding.code.generated',
  ONBOARDING_CODE_DELIVERED: 'onboarding.code.delivered',
  ONBOARDING_CODE_USED: 'onboarding.code.used',
  ONBOARDING_CODE_FAILED_ATTEMPT: 'onboarding.code.failed_attempt',
  ONBOARDING_CODE_REVOKED: 'onboarding.code.revoked',
  ONBOARDING_STARTED: 'onboarding.started',
  ONBOARDING_SUBMITTED: 'onboarding.submitted',
  ONBOARDING_APPROVED: 'onboarding.approved',
  // The brief for this module names onboarding.completed alongside the catalogue's
  // onboarding.approved. They are NOT synonyms and both are kept: `approved` is the reviewer's
  // decision on the form, `completed` is the end of the whole onboarding journey (identity created,
  // access proposed). Collapsing them would make it impossible to answer "approved but not yet
  // provisioned", which is exactly the queue People Ops works from.
  ONBOARDING_COMPLETED: 'onboarding.completed',
  IDENTITY_CREATED: 'identity.created',
  IDENTITY_TRANSFERRED: 'identity.transferred',
  IDENTITY_CONVERTED: 'identity.converted',
  DEPARTMENT_ASSIGNED: 'department.assigned',
  ROLE_ASSIGNED: 'role.assigned',
  ACCESS_PROVISIONED: 'access.provisioned',
  ACCESS_REVOKED: 'access.revoked',
  ACCOUNT_ACTIVATED: 'account.activated',
  ACCOUNT_SUSPENDED: 'account.suspended',
  ACCOUNT_TERMINATED: 'account.terminated',
  DOCUMENT_SUBMITTED: 'document.submitted',
  DOCUMENT_VERIFIED: 'document.verified',
} as const;

export type TalentEventName = (typeof TALENT_EVENTS)[keyof typeof TALENT_EVENTS];

/** Every catalogue name, for an ops screen that lists what this platform can publish. */
export const TALENT_EVENT_NAMES: readonly TalentEventName[] =
  Object.values(TALENT_EVENTS) as TalentEventName[];

/** PURE. Runtime guard for a name that arrived as data — a replay form, a query string, a job payload. */
export function isTalentEventName(v: unknown): v is TalentEventName {
  return typeof v === 'string' && (TALENT_EVENT_NAMES as readonly string[]).includes(v);
}

/**
 * The subject a row is about. Free text in the column (spec 26.6), listed here so five modules do
 * not invent five spellings of "application" and make tal_event_subject_idx useless.
 */
export const TALENT_SUBJECT_KINDS = {
  PERSON: 'person',
  APPLICATION: 'application',
  OPPORTUNITY: 'opportunity',
  EVALUATION: 'evaluation',
  INTERVIEW: 'interview',
  SELECTION: 'selection',
  ONBOARDING_CODE: 'onboarding_code',
  ONBOARDING: 'onboarding',
  IDENTITY: 'identity',
  DOCUMENT: 'document',
  ACCESS: 'access',
} as const;

// ---------------------------------------------------------------------------------------------
// PURE HELPERS. Nothing below reaches a connection until emitTalentEvent().
// ---------------------------------------------------------------------------------------------

/**
 * PURE. subject_id and actor_user_id are UUID columns, and the identifiers people actually hold in
 * this platform are codes — ERAI-APP-2026-000123, ERAI-EMP-002184. A code passed where a row id was
 * expected would make the INSERT throw, and because emitTalentEvent() must not throw into its caller
 * the event would be silently lost. So the value is checked here and a non-UUID is kept in the
 * payload as `_subjectRef` instead of thrown away.
 */
export function isUuidLike(v: unknown): boolean {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

/** PURE. One line, bounded, and never empty — an empty last_error reads as "no error". */
export function truncateError(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'unknown error';
  return s.length > MAX_ERROR_CHARS ? s.slice(0, MAX_ERROR_CHARS - 3) + '...' : s;
}

/**
 * PURE. The claim marker written into last_error. Format is `lease:<epochMs>:<token>` and it MUST
 * stay in step with LEASE_SQL_PATTERN, which is what the claim statement matches on.
 */
export function claimLease(nowMs: number, token: string): string {
  const at = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : 0;
  const t = String(token || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'anon';
  return LEASE_PREFIX + at + ':' + t;
}

/** PURE. Read a lease back, or null if this is a real error message rather than a claim marker. */
export function readLease(raw: unknown): { atMs: number; token: string } | null {
  const m = LEASE_JS_PATTERN.exec(String(raw ?? ''));
  if (!m) return null;
  return { atMs: Number(m[1]), token: m[2] };
}

/** PURE. Has this event exhausted its retries? */
export function shouldRetryEvent(attempts: number): boolean {
  return Number(attempts) < MAX_DELIVERY_ATTEMPTS;
}

/**
 * Keys whose CONTENT is personal, wherever they appear in a payload. Spec 29 rule 2: a payload
 * carries identifiers, not PII, because it lands in a JSONB column, in logs, and in any future
 * integration — three stores with wider read audiences and longer retention than the record it
 * describes. Matched as substrings of the normalised key.
 *
 * `secret` and `token` are here for a sharper reason than privacy: the onboarding code secret exists
 * in plaintext for exactly one response (spec 16.1), and an event payload is the most plausible
 * place for it to be copied into permanent storage by accident.
 */
const PII_KEY_FRAGMENTS: readonly string[] = [
  'email', 'phone', 'mobile', 'whatsapp', 'address',
  'aadhaar', 'aadhar', 'passport', 'bank', 'ifsc', 'upi',
  'salary', 'compensation', 'password', 'secret', 'token', 'otp',
  'url', 'link', 'resume', 'photo', 'selfie',
  'health', 'medical', 'dateofbirth', 'birthdate',
  'ipaddress', 'useragent',
];

/**
 * Keys that are PII only as a whole word. `pan` cannot be a fragment because it is inside `panel`,
 * and an interview panel size is a legitimate fact; `name` cannot be a fragment because
 * `eventName`, `stageName` and `groupName` are all identifiers.
 */
const PII_EXACT_KEYS: ReadonlySet<string> = new Set([
  'name', 'fullname', 'displayname', 'preferredname', 'firstname', 'lastname', 'middlename',
  'candidatename', 'personname', 'managername',
  'dob', 'pan', 'cv', 'gender', 'age', 'nationality', 'religion', 'caste', 'maritalstatus',
]);

const normKey = (k: string): string => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** PURE. Would this key carry personal data into the outbox? */
export function isPiiKey(key: string): boolean {
  const n = normKey(key);
  if (!n) return false;
  if (PII_EXACT_KEYS.has(n)) return true;
  return PII_KEY_FRAGMENTS.some((f) => n.includes(f));
}

const isScalar = (v: any): boolean =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v);

const safeStringify = (v: any): string => {
  try { return JSON.stringify(v) ?? 'null'; } catch { return '"[unserialisable]"'; }
};

/**
 * PURE. Strip personal data out of a payload and keep it inside its budget.
 *
 * REMOVAL IS RECORDED, NOT SILENT. The stripped paths come back in `removed` and emitTalentEvent()
 * writes them into the stored payload as `_redacted`, so a developer who put a candidate's email in
 * an event payload finds out from the event itself rather than from a privacy review two months
 * later. Silently dropping the key would hide the mistake and leave the subscriber reading
 * undefined with no idea why.
 */
export function scrubEventPayload(input: any): { payload: Record<string, any>; removed: string[] } {
  const removed: string[] = [];

  const walk = (value: any, depth: number, path: string): any => {
    if (isScalar(value)) {
      return typeof value === 'string' && value.length > 1000 ? value.slice(0, 1000) + '...' : value;
    }
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_SCRUB_DEPTH) return '[depth]';
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v, i) => walk(v, depth + 1, path ? path + '.' + i : String(i)));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        const here = path ? path + '.' + k : k;
        if (isPiiKey(k)) { removed.push(here); continue; }
        out[k] = walk(v, depth + 1, here);
      }
      return out;
    }
    // Functions, symbols and undefined are not facts about anything.
    return null;
  };

  // A non-object payload still deserves to be recorded rather than refused: refusing it would lose
  // the event over a call-site style choice.
  const base = (input && typeof input === 'object' && !Array.isArray(input)) ? input : { value: input };

  let payload = walk(base, 0, '') as Record<string, any>;

  let json = safeStringify(payload);
  if (json.length > MAX_PAYLOAD_CHARS) {
    // An oversize payload is almost always a raw ingest body that reached an emit by accident. Keep
    // the scalars — which is where the identifiers live — and say plainly that the rest was dropped.
    const kept: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (isScalar(v)) kept[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
    payload = { ...kept, _oversize: true, _originalChars: json.length };
    json = safeStringify(payload);
    if (json.length > MAX_PAYLOAD_CHARS) payload = { _oversize: true, _originalChars: json.length };
  }

  return { payload, removed };
}

// ---------------------------------------------------------------------------------------------
// ENVELOPE — what a subscriber receives.
// ---------------------------------------------------------------------------------------------

export interface TalentEventEnvelope {
  /** tal_event.id as a string. THE IDEMPOTENCY KEY — delivery is at-least-once. */
  eventId: string;
  name: TalentEventName;
  subjectKind: string;
  subjectId: string | null;
  payload: Record<string, any>;
  occurredAt: string;
  actorUserId: string | null;
  /** Which delivery attempt this is. Above 1 means a previous attempt failed or the worker died. */
  attempt: number;
}

export interface TalentEventRow {
  id: string;
  eventName: string;
  subjectKind: string;
  subjectId: string | null;
  payload: Record<string, any>;
  actorUserId: string | null;
  occurredAt: string | null;
  deliveredAt: string | null;
  attempts: number;
  lastError: string | null;
  /** A drain holds a claim on this row right now. Not an error, despite living in last_error. */
  inFlight: boolean;
  /** Retries exhausted. Nothing will pick this up again without an operator. */
  abandoned: boolean;
}

// ---------------------------------------------------------------------------------------------
// DATABASE. Everything below this line touches Postgres.
// ---------------------------------------------------------------------------------------------

/** A drizzle handle or a transaction handle — both answer execute(). */
type SqlRunner = { execute: (query: any) => Promise<any> };

let _db: any = null;
async function database(): Promise<SqlRunner> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db as SqlRunner;
}

/** Memoised in schema.ts, so calling it at the top of every exported function is free. */
async function ensure(): Promise<void> {
  const { ensureTalent } = await import('@/lib/talent/schema');
  await ensureTalent();
}

const isoOf = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const objectOf = (v: any): Record<string, any> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // A payload column that is not JSON is odd but not a reason to fail a read. Falls through to
      // the empty object below, and the raw row is still visible in the database.
    }
  }
  return {};
};

/**
 * Record that something happened. Spec 29 rule 1: events are FACTS IN THE PAST TENSE — call this
 * AFTER the domain write has succeeded, never before.
 *
 * THIS FUNCTION NEVER THROWS. Not for a bad name, not for a dead connection, not for a payload that
 * will not serialise. The business write that preceded it has already committed and must not be
 * unwound because the notification bookkeeping failed; the caller gets no exception to handle and no
 * result to check, which is deliberate — there is nothing useful a caller could do with either. What
 * DOES happen on failure is that the real Postgres reason (e.cause, never e.message, which is just
 * the failed SQL) goes to the console AND to trackError(), so the gap appears on the ops incident
 * board instead of dying in a log nobody reads.
 *
 * `opts.tx` closes the last remaining window. Spec 29 draws the domain row and the tal_event row
 * inside ONE transaction; a caller that has a transaction handle should pass it, and then either
 * both rows exist or neither does. Without it the two writes are separate statements and a process
 * death in between still loses the event — survivable, because the domain row is intact and an
 * operator can replay, but it is not what the spec asks for, so the seam is here rather than absent.
 */
export async function emitTalentEvent(
  name: TalentEventName,
  subjectKind: string,
  subjectId: string | null,
  payload: any,
  actorUserId?: string | null,
  opts?: { tx?: SqlRunner },
): Promise<void> {
  try {
    if (!isTalentEventName(name)) {
      // Reachable only from JavaScript or a cast. Refused loudly rather than written, because an
      // event name nobody subscribes to is indistinguishable from an event that never fired.
      console.error('[talent-events] refusing unknown event name: ' + String(name));
      return;
    }

    await ensure();
    const runner: SqlRunner = opts?.tx || (await database());

    const { payload: clean, removed } = scrubEventPayload(payload);
    if (removed.length) {
      clean._redacted = removed.slice(0, 50);
      console.warn('[talent-events] ' + name + ': dropped personal fields from payload: ' + removed.join(', '));
    }

    const sid = isUuidLike(subjectId) ? String(subjectId).trim() : null;
    if (subjectId && !sid) clean._subjectRef = String(subjectId).slice(0, 200);

    const actor = isUuidLike(actorUserId) ? String(actorUserId).trim() : null;
    if (actorUserId && !actor) clean._actorRef = String(actorUserId).slice(0, 200);

    const kind = String(subjectKind || '').trim().slice(0, 60) || 'unknown';

    await runner.execute(sql`
      INSERT INTO tal_event (event_name, subject_kind, subject_id, payload, actor_user_id)
      VALUES (${name}, ${kind}, ${sid}, ${safeStringify(clean)}::jsonb, ${actor})`);
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-events] emit ' + String(name) + ' failed: ' + reason);
    try {
      const { trackError } = await import('@/lib/logger');
      await trackError('talent.event.emit_failed', e, { eventName: String(name), subjectKind });
    } catch {
      // trackError carries its own fallbacks and is written never to throw. If it does anyway, the
      // console line above is the trace, and it already carries the cause rather than the statement.
      console.error('[talent-events] emit failure could not be tracked: ' + reason);
    }
  }
}

/**
 * Deliver undelivered events, oldest first, to the in-process bus.
 *
 * CONCURRENCY. Two things run this: a request path that wants its own event delivered promptly, and
 * a scheduled drain. Either may be running on several warm instances at once, so the claim has to be
 * safe against itself.
 *
 *   1. `FOR UPDATE SKIP LOCKED` inside the subquery makes two claim statements pick DISJOINT rows.
 *      Without it they both read the same ids and every event is delivered twice.
 *   2. `SKIP LOCKED` alone is not enough here. db.execute() is auto-commit, so the row lock lives
 *      only for the length of the UPDATE — the moment it commits, a second drainer sees a row that
 *      is still `delivered_at IS NULL` and takes it while the first is mid-emit. So the claim also
 *      writes a LEASE MARKER, and the claim predicate refuses rows whose lease is still fresh.
 *
 * THE LEASE LIVES IN last_error, and that needs saying out loud. tal_event has no claimed_until
 * column, this module does not own the schema, and adding one is not its call — so the marker goes
 * in the one text column that is free while a row is in flight, in a format
 * (`lease:<epochMs>:<token>`) no genuine error can imitate. Every reader in this file understands
 * it: recentEvents() reports such a row as inFlight with lastError null rather than showing an
 * operator a fake error. A stale lease is reclaimable after LEASE_MS, which is the crashed-worker
 * gap edu_jobs has and this table does not.
 *
 * THE PREDICATE IS A `CASE`, NOT AN `OR`. SQL does not promise left-to-right short-circuiting, so
 * `last_error !~ pattern OR split_part(...)::bigint < cutoff` could evaluate the cast against a real
 * error message and fail the whole statement. CASE does fix the evaluation order.
 *
 * ATTEMPTS ARE COUNTED AT CLAIM, not at failure, so an event whose handler kills the process cannot
 * be retried forever. After MAX_DELIVERY_ATTEMPTS the row stops being claimed, stays undelivered,
 * and is audited as abandoned — visible, never quietly discarded.
 */
export async function drainTalentEvents(limit = DRAIN_DEFAULT_LIMIT): Promise<{ delivered: number; failed: number }> {
  await ensure();
  const db = await database();

  const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || DRAIN_DEFAULT_LIMIT)));
  const now = Date.now();
  const lease = claimLease(now, randomToken());
  const cutoff = String(now - LEASE_MS);

  let claimed: any[] = [];
  try {
    const res = await db.execute(sql`
      UPDATE tal_event
         SET attempts = attempts + 1,
             last_error = ${lease}
       WHERE id IN (
             SELECT id
               FROM tal_event
              WHERE delivered_at IS NULL
                AND attempts < ${MAX_DELIVERY_ATTEMPTS}
                AND CASE
                      WHEN last_error ~ ${LEASE_SQL_PATTERN}
                        THEN (split_part(last_error, ':', 2))::bigint < ${cutoff}::bigint
                      ELSE TRUE
                    END
              ORDER BY id ASC
              LIMIT ${size}
              FOR UPDATE SKIP LOCKED)
      RETURNING id, event_name, subject_kind, subject_id, payload, actor_user_id, occurred_at, attempts`);
    claimed = rowsOf(res);
  } catch (e: any) {
    // A claim that cannot run is an outage of the drain, not of one event. Reported with the real
    // reason and re-thrown to the scheduler, which is the thing that can alert on it.
    console.error('[talent-events] claim failed: ' + reasonOf(e));
    throw e;
  }

  let delivered = 0;
  let failed = 0;

  for (const row of claimed) {
    const id = String(row.id);
    const eventName = String(row.event_name);
    const attempt = Number(row.attempts) || 1;

    try {
      const envelope: TalentEventEnvelope = {
        eventId: id,
        name: eventName as TalentEventName,
        subjectKind: String(row.subject_kind || 'unknown'),
        subjectId: row.subject_id ? String(row.subject_id) : null,
        payload: objectOf(row.payload),
        occurredAt: isoOf(row.occurred_at) || new Date().toISOString(),
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        attempt,
      };

      // emit() never throws and isolates its handlers from each other; what comes back is the list
      // of the ones that failed. A cross-system side effect belongs in a SUBSCRIBER that enqueues
      // onto edu_jobs (src/lib/job-queue.ts) — this module deliberately does not know about the job
      // queue, so adding a durable consumer never touches the outbox.
      const result = await emit(eventName, envelope, {
        actorId: envelope.actorUserId,
        // The same idempotency key the envelope carries, on the meta a subscriber already reads.
        correlationId: 'tal_event:' + id,
      });

      if (result.failed.length) {
        // PARTIAL FAILURE IS A FAILURE. The whole event is retried, so the handlers that DID succeed
        // will run again — which is the at-least-once contract, and why spec 29 rule 3 requires
        // every subscriber to be idempotent. Delivering to the survivors only would need per-handler
        // delivery state, which this table does not have and this module may not add.
        const detail = result.failed.map((f) => f.handler + ': ' + f.error).join(' | ');
        await recordFailure(db, id, eventName, attempt, detail);
        failed++;
        continue;
      }

      // NO SUBSCRIBERS IS DELIVERED, not pending. The outbox guarantees the event was published; it
      // does not wait for somebody to care. Holding it undelivered would fill the table with rows
      // that can never drain and bury the ones that genuinely failed.
      await db.execute(sql`
        UPDATE tal_event
           SET delivered_at = NOW(), last_error = NULL
         WHERE id = ${id} AND delivered_at IS NULL`);
      delivered++;
    } catch (e: any) {
      // One row's failure must not abort the pass — that is the shared-try-block bug src/lib/events.ts
      // was written to end. Logged with the real reason, counted, and the loop continues.
      const reason = reasonOf(e);
      console.error('[talent-events] deliver ' + eventName + ' (' + id + '): ' + reason);
      failed++;
      try {
        await recordFailure(db, id, eventName, attempt, reason);
      } catch (inner: any) {
        console.error('[talent-events] could not record failure for ' + id + ': ' + reasonOf(inner));
      }
    }
  }

  return { delivered, failed };
}

/**
 * Write the real reason back onto the row, replacing this pass's lease so the next drain can claim
 * it. When the retries are spent, the abandonment is AUDITED: an event that will never be delivered
 * is a permanent gap between what happened and what the rest of the system was told, and that is a
 * fact somebody has to be able to find later.
 */
async function recordFailure(db: SqlRunner, id: string, eventName: string, attempt: number, detail: string): Promise<void> {
  const message = truncateError(detail);
  await db.execute(sql`UPDATE tal_event SET last_error = ${message} WHERE id = ${id}`);

  if (shouldRetryEvent(attempt)) return;

  console.error('[talent-events] abandoning ' + eventName + ' (' + id + ') after ' + attempt + ' attempts: ' + message);
  // logAudit, NOT logAuditOrThrow. The audit row records the gap, it is not the control that permits
  // it — and throwing here would abort a drain that still has good events queued behind this one.
  // The failure of the audit write is itself surfaced rather than ignored.
  const { logAudit } = await import('@/lib/audit');
  const audit = await logAudit({
    userId: null,
    action: 'talent.event.delivery_abandoned',
    entity: 'tal_event',
    entityId: id,
    diff: { eventName, attempts: attempt, error: message },
  });
  if (!audit.ok) {
    console.error('[talent-events] abandonment of ' + id + ' could not be audited: ' + (audit.error || 'unknown reason'));
  }
}

/** A short claim token. It only has to distinguish concurrent drains, so uniqueness beats entropy. */
function randomToken(): string {
  try {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return String(c.randomUUID()).replace(/-/g, '').slice(0, 12);
  } catch {
    // Web Crypto absent (an older runtime, or a sandboxed worker). The time-based token below is a
    // weaker but adequate discriminator, and losing it entirely would mean no lease at all.
  }
  return (Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36)).slice(0, 12);
}

/**
 * The outbox, newest first, for an ops screen.
 *
 * A row a drain is holding is reported as inFlight with lastError NULL. Showing the raw lease marker
 * in an error column would tell an operator a delivery failed when it is simply in progress.
 */
export async function recentEvents(limit = 50): Promise<TalentEventRow[]> {
  await ensure();
  const db = await database();
  const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));

  try {
    const res = await db.execute(sql`
      SELECT id, event_name, subject_kind, subject_id, payload, actor_user_id,
             occurred_at, delivered_at, attempts, last_error
        FROM tal_event
       ORDER BY id DESC
       LIMIT ${size}`);
    return rowsOf(res).map((r: any) => {
      const lease = readLease(r.last_error);
      const attempts = Number(r.attempts) || 0;
      return {
        id: String(r.id),
        eventName: String(r.event_name),
        subjectKind: String(r.subject_kind || ''),
        subjectId: r.subject_id ? String(r.subject_id) : null,
        payload: objectOf(r.payload),
        actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
        occurredAt: isoOf(r.occurred_at),
        deliveredAt: isoOf(r.delivered_at),
        attempts,
        lastError: lease ? null : (r.last_error ? String(r.last_error) : null),
        inFlight: !!lease && !r.delivered_at && (Date.now() - lease.atMs) < LEASE_MS,
        abandoned: !r.delivered_at && !shouldRetryEvent(attempts),
      };
    });
  } catch (e: any) {
    // A READ path whose only caller is a console. An empty list with the reason on the console beats
    // a 500 on the ops page somebody opened because something was already wrong.
    console.error('[talent-events] recentEvents: ' + reasonOf(e));
    return [];
  }
}

/**
 * How many events are waiting, and how many have given up. The badge an ops dashboard needs:
 * `abandoned > 0` means the platform and its subscribers disagree about what has happened.
 */
export async function undeliveredEventCount(): Promise<{ pending: number; abandoned: number }> {
  await ensure();
  const db = await database();
  try {
    const res = await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE attempts <  ${MAX_DELIVERY_ATTEMPTS}) AS pending,
             COUNT(*) FILTER (WHERE attempts >= ${MAX_DELIVERY_ATTEMPTS}) AS abandoned
        FROM tal_event
       WHERE delivered_at IS NULL`);
    const row = rowsOf(res)[0] || {};
    return { pending: Number(row.pending) || 0, abandoned: Number(row.abandoned) || 0 };
  } catch (e: any) {
    console.error('[talent-events] undeliveredEventCount: ' + reasonOf(e));
    return { pending: 0, abandoned: 0 };
  }
}
