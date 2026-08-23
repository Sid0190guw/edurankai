// src/lib/horizon/events.ts — THE HORIZON EVENT CONTRACTS.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md section 5.
//
// =================================================================================================
// THE COLLISION THIS FILE EXISTS TO AVOID, FOUND BEFORE A LINE WAS WRITTEN
// =================================================================================================
//
// The brief names fourteen events. THREE OF THEM ALREADY EXIST IN THIS REPOSITORY, under exactly
// those names, owned by other people:
//
//   application.submitted   src/lib/events.ts EVENTS.APPLICATION_SUBMITTED, and a live automation
//                           trigger key in src/lib/mail-product/automations.ts and
//                           src/lib/mailplatform/triggers.ts.
//   assessment.completed    src/lib/talent/events.ts TALENT_EVENTS.ASSESSMENT_COMPLETED.
//   interview.completed     src/lib/talent/events.ts TALENT_EVENTS.INTERVIEW_COMPLETED.
//
// Publishing a HORIZON envelope under one of those names would hand a DIFFERENT PAYLOAD SHAPE to
// subscribers that already exist — mail automations among them. That is precisely the backward
// compatibility the multi-agent rules forbid breaking, and it would break silently, because a bus
// subscriber that receives an unexpected shape does not throw, it just does the wrong thing.
//
// SO EVERY HORIZON TOPIC IS NAMESPACED. The canonical event NAME is the brief's — `type` on the
// envelope is literally 'application.submitted' — and the TOPIC it is published on is
// 'horizon.application.submitted'. Nothing existing changes; nothing existing hears us by accident.
//
// AND THE EXISTING EVENTS ARE STILL USEFUL, so UPSTREAM_BINDINGS records which platform event maps
// to which HORIZON event, and `bindUpstreamEvents()` wires them — OPT-IN, called by an integration
// entry point, never as an import side effect. An adapter converts the upstream payload into a
// HORIZON envelope. The producer never learns HORIZON exists.
//
// =================================================================================================
// DELIVERY: AN OUTBOX, BECAUSE THE PROCESS DOES NOT SURVIVE THE RESPONSE
// =================================================================================================
//
// src/lib/events.ts is an in-process bus and it is the right tool for "notify these subscribers
// now". What it cannot do is survive the function being frozen the instant the response is written,
// which on Vercel is most of the time. A domain module that writes its row and then emits has a
// window in which the fact exists and nothing downstream ever hears about it.
//
// So the event is RECORDED next to the fact that caused it (hzn_event) and delivery is a separate,
// retried pass. Delivery is AT-LEAST-ONCE: a row is claimed, handed to the bus, and only then marked
// delivered, so a worker that dies between those points leaves the row to be replayed. SUBSCRIBERS
// MUST BE IDEMPOTENT — `eventId` is the stable dedup key and it travels in both the envelope and the
// bus meta as `correlationId`.
//
// THE SINK IS AN INTERFACE. `postgresEventSink` is the default; `memoryEventSink` is what tests use
// and what a deployment with a real queue would replace. Nothing in HORIZON reaches for the database
// directly to publish.
//
// HOUSE RULES OBSERVED: postgres-js returns plain arrays (rowsOf); the real Postgres reason is on
// e.cause (reasonOf); every const is declared above the function that reads it; no write path
// swallows an exception silently; the database handle is resolved LAZILY so the pure half of this
// file is testable with no connection.

import { emit, on } from '@/lib/events';
import { reasonOf, rowsOf, truncateReason } from './pg';
import {
  DEFAULT_ORGANISATION_ID, newHorizonId, isSubjectRef, isActorRef,
  type ActorRef, type AssessmentId, type ComputationId, type EventId, type EvidenceId,
  type FeedbackId, type OrganisationId, type ProfileId, type ResultId, type RoleId,
  type SignalId, type SubjectRef,
} from './ids';
import { isIsoTimestamp } from './types';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them — `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Every HORIZON topic starts with this. The whole point of the file's opening note. */
export const HORIZON_TOPIC_PREFIX = 'horizon.';

/** Envelope schema version. Bumped only for a BREAKING change; additive fields do not bump it. */
export const HORIZON_EVENT_VERSION = 1 as const;

/** Delivery attempts before an event stops being retried and becomes an operator problem. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** How long a claim is honoured before another drain may take the row back. */
export const LEASE_SECONDS = 300;

/** Payload budget. A payload is identifiers and small facts, never a document and never a CV. */
export const MAX_PAYLOAD_CHARS = 8000;

export const DRAIN_DEFAULT_LIMIT = 50;

// -------------------------------------------------------------------------------------------------
// 5. THE EVENT VOCABULARY
//
// A const object rather than loose strings so a typo is a BUILD error instead of an event nobody
// ever receives. This repository has already paid for the alternative twice: twenty-two notification
// types that were never registered, and the string constants src/lib/events.ts EVENTS exists to
// prevent.
// -------------------------------------------------------------------------------------------------

export const HORIZON_EVENTS = {
  APPLICATION_SUBMITTED: 'application.submitted',
  EMPLOYEE_CREATED: 'employee.created',
  TASK_ASSIGNED: 'task.assigned',
  TASK_SUBMITTED: 'task.submitted',
  TASK_UPDATED: 'task.updated',
  FEEDBACK_SUBMITTED: 'feedback.submitted',
  FEEDBACK_UPDATED: 'feedback.updated',
  ASSESSMENT_COMPLETED: 'assessment.completed',
  INTERVIEW_COMPLETED: 'interview.completed',
  PROFILE_RECOMPUTE_REQUESTED: 'profile.recompute_requested',
  INTELLIGENCE_COMPUTATION_COMPLETED: 'intelligence.computation_completed',
  SIGNAL_CREATED: 'signal.created',
  SIGNAL_RESOLVED: 'signal.resolved',
  ACCESS_LOGGED: 'access.logged',
} as const;

export type HorizonEventName = (typeof HORIZON_EVENTS)[keyof typeof HORIZON_EVENTS];

export const HORIZON_EVENT_NAMES: readonly HorizonEventName[] =
  Object.values(HORIZON_EVENTS) as HorizonEventName[];

/** The bus topic for an event name. Never build this by hand. */
export function horizonTopic(name: HorizonEventName): string {
  return HORIZON_TOPIC_PREFIX + name;
}

export function isHorizonEventName(v: unknown): v is HorizonEventName {
  return typeof v === 'string' && (HORIZON_EVENT_NAMES as readonly string[]).includes(v);
}

// -------------------------------------------------------------------------------------------------
// PAYLOADS — ONE TYPE PER EVENT, ALL OF THEM EXPLICIT
//
// Every payload is IDENTIFIERS AND SMALL FACTS. No names, no free text about a person, no scores. A
// subscriber that needs the substance reads it from the owning module under that module's access
// rules; an event that carries the substance is a copy of a person's record travelling through a
// log with none of the controls the original had.
// -------------------------------------------------------------------------------------------------

export interface ApplicationSubmittedPayload {
  applicationId: string;
  roleId?: RoleId | null;
  /** Where the application came in from, for source-quality analysis. Never a tracking identifier. */
  sourceKey?: string | null;
  submittedAt: string;
}

export interface EmployeeCreatedPayload {
  employeeId: string;
  /** The application this hire came from, when there was one. */
  applicationId?: string | null;
  joiningDate?: string | null;
  departmentId?: string | null;
}

export interface TaskAssignedPayload {
  taskId: string;
  assignedToEmployeeId: string;
  assignedByActor: ActorRef;
  dueAt?: string | null;
  /** The task's own priority word, passed through unchanged. HORIZON does not reinterpret it. */
  priority?: string | null;
}

export interface TaskSubmittedPayload {
  taskId: string;
  submittedByEmployeeId: string;
  submittedAt: string;
  /** True when the submission landed after dueAt. Computed by the task module, not by HORIZON. */
  late?: boolean | null;
}

export interface TaskUpdatedPayload {
  taskId: string;
  /** The task module's own status vocabulary (src/lib/employee-tasks.ts owns it). Passed through. */
  fromStatus?: string | null;
  toStatus: string;
  changedByActor: ActorRef;
  changedAt: string;
}

export interface FeedbackSubmittedPayload {
  feedbackId: FeedbackId;
  /** The module that owns the feedback body. An auditor needs this to find the words. */
  ownerModule: string;
  dimensionKey: string;
  relationship: string;
  submittedAt: string;
}

export interface FeedbackUpdatedPayload {
  feedbackId: FeedbackId;
  ownerModule: string;
  updatedAt: string;
  /** True when the change altered the substance rather than a typo. The owning module decides. */
  material: boolean;
}

export interface AssessmentCompletedPayload {
  assessmentId: AssessmentId;
  completedAt: string;
  /** Whether the attempt could be scored at all. A missing score is not a zero. */
  scored: boolean;
}

export interface InterviewCompletedPayload {
  interviewId: string;
  applicationId?: string | null;
  completedAt: string;
  panelSize: number;
}

export interface ProfileRecomputeRequestedPayload {
  profileId?: ProfileId | null;
  /** Why. A recompute with no reason is a recompute nobody can trace to a cause. */
  reason: string;
  /** Limit the recompute to these dimension families. Empty means all of them. */
  dimensionFamilies: readonly string[];
  requestedByActor: ActorRef;
}

export interface IntelligenceComputationCompletedPayload {
  computationId: ComputationId;
  engineId: string;
  engineVersion: string;
  /** 'succeeded' | 'failed' | 'refused'. A refusal is a real outcome, not a failure. */
  outcome: 'succeeded' | 'failed' | 'refused';
  resultIds: readonly ResultId[];
  /** Present when the run failed or refused. The reason, in words. */
  detail?: string | null;
  durationMs?: number | null;
}

export interface SignalCreatedPayload {
  signalId: SignalId;
  category: string;
  severity: string;
  humanReviewRequired: boolean;
  evidenceIds: readonly EvidenceId[];
}

export interface SignalResolvedPayload {
  signalId: SignalId;
  /** 'resolved' | 'dismissed' | 'expired'. Dismissal is a human act and names its human. */
  resolution: 'resolved' | 'dismissed' | 'expired';
  resolvedByActor: ActorRef | null;
  reason?: string | null;
}

/**
 * RULE 17: sensitive personal data must be access-logged.
 *
 * This event is emitted AFTER the log row is written, never instead of it. The distinction matters:
 * src/lib/legal-hold.ts already establishes that logAccess() must SUCCEED before anything renders,
 * and an event on a bus is not a log — it is a notification that a log exists.
 */
export interface AccessLoggedPayload {
  accessLogId: string;
  accessorActor: ActorRef;
  /** What was read, as an audience/visibility pair. Never the values that were read. */
  audience: string;
  visibilityClass: string;
  /** The stated purpose. Purpose limitation is meaningless if the purpose is not recorded. */
  purpose: string;
  succeeded: boolean;
}

/** The payload shape for each event name, so the envelope can be typed end to end. */
export interface HorizonEventPayloads {
  'application.submitted': ApplicationSubmittedPayload;
  'employee.created': EmployeeCreatedPayload;
  'task.assigned': TaskAssignedPayload;
  'task.submitted': TaskSubmittedPayload;
  'task.updated': TaskUpdatedPayload;
  'feedback.submitted': FeedbackSubmittedPayload;
  'feedback.updated': FeedbackUpdatedPayload;
  'assessment.completed': AssessmentCompletedPayload;
  'interview.completed': InterviewCompletedPayload;
  'profile.recompute_requested': ProfileRecomputeRequestedPayload;
  'intelligence.computation_completed': IntelligenceComputationCompletedPayload;
  'signal.created': SignalCreatedPayload;
  'signal.resolved': SignalResolvedPayload;
  'access.logged': AccessLoggedPayload;
}

// -------------------------------------------------------------------------------------------------
// THE ENVELOPE
// -------------------------------------------------------------------------------------------------

/**
 * Every HORIZON event, of every kind, arrives in this shape.
 *
 * `causationId` is the eventId of whatever caused this one, and it is the field that makes a chain
 * reconstructable: a recompute request caused by a feedback submission caused by an interview
 * completing is three rows that can be walked backwards months later. `correlationId` groups
 * everything that came out of one user action.
 */
export interface HorizonEventEnvelope<N extends HorizonEventName = HorizonEventName> {
  eventId: EventId;
  type: N;
  version: typeof HORIZON_EVENT_VERSION;
  /** When the FACT happened, not when the row was written. */
  occurredAt: string;
  organisationId: OrganisationId;
  /** Who it is about. Null for events that are not about a person (a computation that found nobody). */
  subject: SubjectRef | null;
  /** Who caused it. Null only when genuinely unknown, which should be rare and is worth noticing. */
  actor: ActorRef | null;
  correlationId: string | null;
  causationId: EventId | null;
  payload: HorizonEventPayloads[N];
}

export interface EventValidation { ok: boolean; errors: string[] }

/**
 * PURE. Check an envelope before it is stored or delivered.
 *
 * Deliberately does NOT validate payload internals per event type: that would be a second schema to
 * keep in step with the interfaces above, and a stale validator that passes bad payloads is worse
 * than none. What it checks is the ENVELOPE — the part every subscriber reads without knowing the
 * event type — plus the size budget, which is the one payload property that can hurt the database.
 */
export function validateEnvelope(e: unknown): EventValidation {
  const errors: string[] = [];
  if (!e || typeof e !== 'object') return { ok: false, errors: ['envelope is not an object'] };
  const env = e as Partial<HorizonEventEnvelope>;

  if (!env.eventId) errors.push('eventId is required — it is the subscriber deduplication key');
  if (!isHorizonEventName(env.type)) errors.push('type is not a HORIZON event name');
  if (env.version !== HORIZON_EVENT_VERSION) {
    errors.push('version must be ' + HORIZON_EVENT_VERSION + ' (got ' + String(env.version) + ')');
  }
  if (!isIsoTimestamp(env.occurredAt)) errors.push('occurredAt must be an ISO 8601 timestamp');
  if (!env.organisationId) errors.push('organisationId is required');
  if (env.subject !== null && env.subject !== undefined && !isSubjectRef(env.subject)) {
    errors.push('subject must be a valid SubjectRef or explicitly null');
  }
  if (env.actor !== null && env.actor !== undefined && !isActorRef(env.actor)) {
    errors.push('actor must be a valid ActorRef or explicitly null');
  }
  if (env.payload === undefined || env.payload === null || typeof env.payload !== 'object') {
    errors.push('payload must be an object');
  } else {
    let size = 0;
    try { size = JSON.stringify(env.payload).length; } catch {
      errors.push('payload is not JSON-serialisable');
    }
    if (size > MAX_PAYLOAD_CHARS) {
      errors.push('payload is ' + size + ' characters, over the ' + MAX_PAYLOAD_CHARS + ' budget — '
        + 'an event carries identifiers and small facts, never a document');
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface BuildEventInput<N extends HorizonEventName> {
  type: N;
  payload: HorizonEventPayloads[N];
  subject?: SubjectRef | null;
  actor?: ActorRef | null;
  organisationId?: OrganisationId;
  occurredAt?: string;
  correlationId?: string | null;
  causationId?: EventId | null;
}

/**
 * PURE. Build a validated envelope, or say why not.
 *
 * `occurredAt` defaults to now, which is correct for an event emitted at the moment the fact
 * happened and WRONG for a backfill — so a backfill passes the real timestamp, and the default
 * never quietly rewrites history.
 */
export function buildEvent<N extends HorizonEventName>(
  input: BuildEventInput<N>,
): { ok: true; envelope: HorizonEventEnvelope<N> } | { ok: false; errors: string[] } {
  const envelope: HorizonEventEnvelope<N> = {
    eventId: newHorizonId('event'),
    type: input.type,
    version: HORIZON_EVENT_VERSION,
    occurredAt: input.occurredAt || new Date().toISOString(),
    organisationId: input.organisationId || DEFAULT_ORGANISATION_ID,
    subject: input.subject ?? null,
    actor: input.actor ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    payload: input.payload,
  };
  const v = validateEnvelope(envelope);
  return v.ok ? { ok: true, envelope } : { ok: false, errors: v.errors };
}

// -------------------------------------------------------------------------------------------------
// THE SINK — WHERE AN EVENT IS DURABLY RECORDED BEFORE IT IS DELIVERED
// -------------------------------------------------------------------------------------------------

export interface SinkResult {
  ok: boolean;
  /** Why not. Present only when ok is false. Never thrown into the caller. */
  error?: string;
}

export interface ClaimedEvent {
  envelope: HorizonEventEnvelope;
  attempts: number;
}

/**
 * A durable store for events awaiting delivery.
 *
 * SWAP-READY ON PURPOSE. `postgresEventSink` is the default and writes hzn_event. A deployment that
 * grows a real queue implements this interface against it and changes one line at the entry point;
 * nothing in HORIZON reaches for the database to publish, so nothing else has to change.
 */
export interface HorizonEventSink {
  /** Record the event. MUST NOT throw: a committed fact is a fact even if the outbox write failed. */
  record(envelope: HorizonEventEnvelope): Promise<SinkResult>;
  /** Claim up to `limit` undelivered events for delivery. */
  claim(limit: number): Promise<ClaimedEvent[]>;
  /** Mark one delivered. */
  markDelivered(eventId: EventId): Promise<SinkResult>;
  /** Record a failed delivery attempt with its reason. */
  markFailed(eventId: EventId, error: string): Promise<SinkResult>;
}

/**
 * An in-memory sink. What tests use, and what a caller uses when it wants the bus without the table.
 *
 * NOT a fallback for production: it loses everything when the process ends, which is the exact
 * failure the outbox exists to prevent. It is exported so a test never needs a database, not so a
 * deployment can skip one.
 */
export function memoryEventSink(): HorizonEventSink & { all(): HorizonEventEnvelope[] } {
  const rows: { env: HorizonEventEnvelope; delivered: boolean; attempts: number; error?: string }[] = [];
  return {
    all() { return rows.map((r) => r.env); },
    async record(envelope) { rows.push({ env: envelope, delivered: false, attempts: 0 }); return { ok: true }; },
    async claim(limit) {
      const out: ClaimedEvent[] = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (r.delivered || r.attempts >= MAX_DELIVERY_ATTEMPTS) continue;
        r.attempts++;
        out.push({ envelope: r.env, attempts: r.attempts });
      }
      return out;
    },
    async markDelivered(eventId) {
      const r = rows.find((x) => x.env.eventId === eventId);
      if (r) r.delivered = true;
      return { ok: !!r, error: r ? undefined : 'no such event' };
    },
    async markFailed(eventId, error) {
      const r = rows.find((x) => x.env.eventId === eventId);
      if (r) r.error = error;
      return { ok: !!r, error: r ? undefined : 'no such event' };
    },
  };
}

// -------------------------------------------------------------------------------------------------
// THE POSTGRES SINK
//
// The database handle is resolved LAZILY. A module-scope `import { db }` makes every pure function
// above unreachable from a test that needs no connection at all — src/lib/audit.ts carries the same
// note for the same reason.
// -------------------------------------------------------------------------------------------------

async function database(): Promise<any> {
  return (await import('@/lib/db')).db;
}

async function sqlTag(): Promise<any> {
  return (await import('drizzle-orm')).sql;
}

function envelopeFromRow(row: any): HorizonEventEnvelope {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  const subject: SubjectRef | null = row.subject_id
    ? {
      kind: row.subject_kind,
      id: row.subject_id,
      idScheme: row.subject_scheme,
      organisationId: row.organisation_id,
    }
    : null;
  const actor: ActorRef | null = row.actor_id
    ? { kind: row.actor_kind, id: row.actor_id, displayName: row.actor_name ?? null }
    : null;
  return {
    eventId: row.id,
    type: row.type,
    version: HORIZON_EVENT_VERSION,
    occurredAt: new Date(row.occurred_at).toISOString(),
    organisationId: row.organisation_id,
    subject,
    actor,
    correlationId: row.correlation_id ?? null,
    causationId: row.causation_id ?? null,
    payload,
  };
}

export const postgresEventSink: HorizonEventSink = {
  async record(envelope) {
    try {
      const db = await database();
      const sql = await sqlTag();
      await db.execute(sql`
        INSERT INTO hzn_event (
          id, organisation_id, type, version, occurred_at,
          subject_kind, subject_id, subject_scheme,
          actor_kind, actor_id, actor_name,
          correlation_id, causation_id, payload
        ) VALUES (
          ${envelope.eventId}, ${envelope.organisationId}, ${envelope.type}, ${envelope.version},
          ${envelope.occurredAt},
          ${envelope.subject?.kind ?? null}, ${envelope.subject?.id ?? null},
          ${envelope.subject?.idScheme ?? null},
          ${envelope.actor?.kind ?? null}, ${envelope.actor?.id ?? null},
          ${envelope.actor?.displayName ?? null},
          ${envelope.correlationId}, ${envelope.causationId},
          ${JSON.stringify(envelope.payload)}::jsonb
        )
        ON CONFLICT (id) DO NOTHING`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: reasonOf(e) };
    }
  },

  async claim(limit) {
    try {
      const db = await database();
      const sql = await sqlTag();
      // FOR UPDATE SKIP LOCKED, not a lease marker written into an error column. Two drains running
      // at once take disjoint sets, and a drain that dies mid-pass releases its rows when its
      // transaction ends rather than stranding them for the length of a lease.
      const res = await db.execute(sql`
        UPDATE hzn_event SET attempts = attempts + 1, claimed_at = NOW()
        WHERE id IN (
          SELECT id FROM hzn_event
          WHERE delivered_at IS NULL
            AND attempts < ${MAX_DELIVERY_ATTEMPTS}
            AND (claimed_at IS NULL OR claimed_at < NOW() - (${LEASE_SECONDS} * INTERVAL '1 second'))
          ORDER BY created_at
          LIMIT ${Math.max(1, Math.min(500, limit))}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`);
      return rowsOf(res).map((row) => ({ envelope: envelopeFromRow(row), attempts: Number(row.attempts || 1) }));
    } catch (e: any) {
      console.error('[horizon-events] claim: ' + reasonOf(e));
      return [];
    }
  },

  async markDelivered(eventId) {
    try {
      const db = await database();
      const sql = await sqlTag();
      await db.execute(sql`UPDATE hzn_event SET delivered_at = NOW(), last_error = NULL WHERE id = ${eventId}`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: reasonOf(e) };
    }
  },

  async markFailed(eventId, error) {
    try {
      const db = await database();
      const sql = await sqlTag();
      await db.execute(sql`UPDATE hzn_event SET last_error = ${truncateReason(error)} WHERE id = ${eventId}`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: reasonOf(e) };
    }
  },
};

// -------------------------------------------------------------------------------------------------
// PUBLISHING
// -------------------------------------------------------------------------------------------------

/**
 * Where a DELIVERY GAP is reported when the outbox could not store an event.
 *
 * INJECTED RATHER THAN IMPORTED, for two reasons that are both about honesty.
 *
 * The first is that stdout is not a surface. /admin/ops builds its incident board from the error
 * log, and a subsystem whose failures only ever reach console.error is the one class of fault that
 * never appears there — so the default reporter is trackError(), exactly as src/lib/audit.ts does
 * for a failed audit write.
 *
 * The second is that the default reporter WRITES TO THE DATABASE, and a unit test exercising the
 * "the sink is broken" path must not open a connection to do it. A test that quietly reaches a real
 * database is worse than no test: on this project the working directory holds live credentials, and
 * a suite that connects is one edit away from reading production. So the reporter is a parameter,
 * the tests pass a collector, and the production path is unchanged.
 */
export type GapReporter = (reason: string, envelope: HorizonEventEnvelope) => Promise<void>;

/**
 * How long the default reporter may spend before the caller stops waiting for it.
 *
 * WHY A BOUND AT ALL. trackError() writes a row, and the outbox write that just failed is very often
 * a symptom of the database being unreachable — in which case the tracker is about to wait out the
 * full DB_TIMEOUT_MS (8s) for a write that will also fail. Adding eight seconds to a request that has
 * ALREADY lost its event helps nobody, and on a serverless function it can push the response past the
 * gateway. The report is still awaited, so it genuinely happens on a healthy database; it just cannot
 * become the slowest thing in the request.
 */
export const GAP_REPORT_TIMEOUT_MS = 1500;

/** The default. Puts the gap on the same incident board every other fault in this codebase lands on. */
export const trackErrorGapReporter: GapReporter = async (reason, envelope) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const { trackError } = await import('@/lib/logger');
      await trackError('horizon.event.outbox_write_failed', new Error(reason), {
        type: envelope.type, eventId: envelope.eventId,
      });
    })();
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('gap report timed out')), GAP_REPORT_TIMEOUT_MS);
      }),
    ]);
    // The losing promise keeps running; only the waiting stops.
  } catch (e: any) {
    // trackError carries its own fallbacks and is written never to throw. If it does anyway — or if
    // it simply could not answer in time — the gap must still leave a trace rather than disappearing
    // along with the tracker.
    console.error('[horizon-events] the delivery gap could not be tracked: ' + reasonOf(e));
  } finally {
    // A pending timeout keeps a serverless instance's event loop alive after the response is sent.
    if (timer) clearTimeout(timer);
  }
};

/** For tests and for a caller that has its own incident path. Records nothing, reaches nothing. */
export const silentGapReporter: GapReporter = async () => {};

export interface EmitOutcome {
  ok: boolean;
  eventId: EventId | null;
  /** True when the envelope reached the durable sink. False means a tracked, visible delivery gap. */
  recorded: boolean;
  errors: string[];
}

/**
 * Emit a HORIZON event.
 *
 * NEVER THROWS INTO ITS CALLER. THE TRADE-OFF, STATED PLAINLY: a hire that committed is a fact. If
 * the outbox write fails, the honest outcome is a recorded, tracked delivery gap — not a rolled-back
 * hire. So the failure is returned, logged with the real Postgres reason, and pushed to the error
 * board through the same trackError() every other fault here gets; the caller decides what to do
 * with `ok: false`.
 *
 * A REJECTED ENVELOPE IS DIFFERENT FROM A FAILED WRITE, and both are reported. An envelope that
 * fails validation is a programming error in the caller and is never recorded; a valid envelope that
 * could not be stored is an infrastructure problem and is.
 */
export async function emitHorizonEvent<N extends HorizonEventName>(
  input: BuildEventInput<N>,
  sink: HorizonEventSink = postgresEventSink,
  reportGap: GapReporter = trackErrorGapReporter,
): Promise<EmitOutcome> {
  const built = buildEvent(input);
  if (!built.ok) {
    console.error('[horizon-events] refused ' + String(input.type) + ': ' + built.errors.join('; '));
    return { ok: false, eventId: null, recorded: false, errors: built.errors };
  }
  const { envelope } = built;
  const res = await sink.record(envelope);
  if (!res.ok) {
    const reason = res.error || 'unknown reason';
    console.error('[horizon-events] outbox write failed for ' + envelope.type + ': ' + reason);
    await reportGap(reason, envelope);
    return { ok: false, eventId: envelope.eventId, recorded: false, errors: [reason] };
  }
  return { ok: true, eventId: envelope.eventId, recorded: true, errors: [] };
}

export interface DrainReport {
  claimed: number;
  delivered: number;
  failed: { eventId: EventId; error: string }[];
}

/**
 * Deliver claimed events to the in-process bus.
 *
 * A row is marked delivered only AFTER the bus call returns, which is what makes delivery
 * at-least-once rather than at-most-once. `emit()` never throws and isolates each handler, so a
 * broken subscriber cannot stop the drain; what it CAN do is report failed handlers, and those are
 * recorded against the event so an operator can see which subscriber is behind.
 */
export async function drainHorizonEvents(
  limit: number = DRAIN_DEFAULT_LIMIT,
  sink: HorizonEventSink = postgresEventSink,
): Promise<DrainReport> {
  const report: DrainReport = { claimed: 0, delivered: 0, failed: [] };
  const claimed = await sink.claim(limit);
  report.claimed = claimed.length;

  for (const c of claimed) {
    const env = c.envelope;
    try {
      const result = await emit(horizonTopic(env.type), env, {
        actorId: env.actor?.id ?? null,
        // The eventId travels as the correlation id too, so a subscriber that needs exactly-once
        // effects has a stable natural key to deduplicate on without unpacking the envelope.
        correlationId: env.eventId,
      });
      if (result.failed.length) {
        const detail = result.failed.map((f) => f.handler + ': ' + f.error).join(' | ');
        await sink.markFailed(env.eventId, detail);
        report.failed.push({ eventId: env.eventId, error: detail });
      }
      // DELIVERED EVEN WHEN A HANDLER FAILED. The event WAS delivered; a subscriber's own failure is
      // that subscriber's problem and is recorded in last_error and in recentEventFailures().
      // Retrying the whole event would re-run every healthy handler as well, which for handlers that
      // are not perfectly idempotent is a worse outcome than a visible, attributed failure.
      await sink.markDelivered(env.eventId);
      report.delivered++;
    } catch (e: any) {
      const reason = reasonOf(e);
      await sink.markFailed(env.eventId, reason);
      report.failed.push({ eventId: env.eventId, error: reason });
    }
  }
  return report;
}

// -------------------------------------------------------------------------------------------------
// SUBSCRIBING
// -------------------------------------------------------------------------------------------------

export type HorizonHandler<N extends HorizonEventName> =
  (envelope: HorizonEventEnvelope<N>) => void | Promise<void>;

/**
 * Subscribe to a HORIZON event.
 *
 * `name` is REQUIRED and is not decoration: the bus attributes failures by handler name, and
 * "anonymous" is useless at 3am. Returns an unsubscribe function, mainly so tests do not leak
 * handlers between cases.
 *
 * SUBSCRIBERS MUST BE IDEMPOTENT. Delivery is at-least-once; `envelope.eventId` is the dedup key.
 */
export function onHorizonEvent<N extends HorizonEventName>(
  type: N,
  handlerName: string,
  fn: HorizonHandler<N>,
): () => void {
  // `on` is imported statically at the top of this file: src/lib/events.ts is a pure in-process
  // registry that imports nothing heavy, and this package is ESM ("type": "module"), where require()
  // does not exist at all.
  return on(horizonTopic(type), { name: handlerName }, (payload: any) => fn(payload as HorizonEventEnvelope<N>));
}

// -------------------------------------------------------------------------------------------------
// UPSTREAM BINDINGS — HOW EXISTING PLATFORM EVENTS BECOME HORIZON EVENTS
// -------------------------------------------------------------------------------------------------

export interface UpstreamBinding {
  /** The topic an existing module already publishes on. NOT changed by HORIZON. */
  upstreamTopic: string;
  /** The module that owns that topic, so an integrator knows whose contract it is reading. */
  owner: string;
  horizonEvent: HorizonEventName;
  /** Honest note: whether anything actually publishes this today. */
  status: 'published_today' | 'declared_only';
  note: string;
}

/**
 * THE MAP FROM WHAT EXISTS TO WHAT HORIZON NEEDS.
 *
 * `status` is the honest half. Several of these topics are DECLARED in a vocabulary but have no
 * producer in the repository today — src/lib/events.ts EVENTS is a const object whose only callers
 * are its own tests. Recording that here stops the next patch from wiring a subscriber to a topic
 * that will never fire and then spending a day wondering why nothing arrives.
 */
export const UPSTREAM_BINDINGS: readonly UpstreamBinding[] = Object.freeze([
  {
    upstreamTopic: 'application.submitted', owner: 'src/lib/events.ts (EVENTS.APPLICATION_SUBMITTED)',
    horizonEvent: HORIZON_EVENTS.APPLICATION_SUBMITTED, status: 'declared_only',
    note: 'Also a live automation TRIGGER KEY in src/lib/mail-product/automations.ts and '
      + 'src/lib/mailplatform/triggers.ts, which is why HORIZON does not publish under this name.',
  },
  {
    upstreamTopic: 'application.received', owner: 'src/lib/talent/events.ts',
    horizonEvent: HORIZON_EVENTS.APPLICATION_SUBMITTED, status: 'published_today',
    note: 'The talent outbox drains onto the shared bus, so this one really fires.',
  },
  {
    upstreamTopic: 'assessment.completed', owner: 'src/lib/talent/events.ts',
    horizonEvent: HORIZON_EVENTS.ASSESSMENT_COMPLETED, status: 'published_today',
    note: 'Same name as the HORIZON event, different payload. Bind, do not reuse.',
  },
  {
    upstreamTopic: 'interview.completed', owner: 'src/lib/talent/events.ts',
    horizonEvent: HORIZON_EVENTS.INTERVIEW_COMPLETED, status: 'published_today',
    note: 'Same name as the HORIZON event, different payload. Bind, do not reuse.',
  },
  {
    upstreamTopic: 'evaluation.submitted', owner: 'src/lib/talent/events.ts',
    horizonEvent: HORIZON_EVENTS.FEEDBACK_SUBMITTED, status: 'published_today',
    note: 'The talent vocabulary calls interview feedback an evaluation. Same fact, different word.',
  },
  {
    upstreamTopic: 'identity.created', owner: 'src/lib/talent/events.ts',
    horizonEvent: HORIZON_EVENTS.EMPLOYEE_CREATED, status: 'published_today',
    note: 'An employee identity is created at the end of onboarding, not when an offer is signed.',
  },
]);

/**
 * An adapter turns one upstream payload into a HORIZON envelope input, or returns null to skip.
 *
 * NULL IS A REAL ANSWER. `identity.created` fires for interns, fellows and members as well as
 * employees; an adapter that cannot produce an employee subject should decline rather than invent
 * one.
 */
export type UpstreamAdapter = (
  upstreamPayload: any,
  meta: { actorId?: string | null; correlationId?: string | null },
) => Promise<BuildEventInput<HorizonEventName> | null> | BuildEventInput<HorizonEventName> | null;

/**
 * Wire upstream topics into HORIZON. OPT-IN.
 *
 * Called from an integration entry point, never as an import side effect. A module that wires
 * subscribers merely by being imported is how a test suite ends up publishing events, and how a
 * cron job ends up with handlers it never asked for.
 *
 * Returns an unsubscribe function for the whole set, because a test that binds must be able to
 * unbind.
 */
export function bindUpstreamEvents(
  adapters: Partial<Record<string, UpstreamAdapter>>,
  sink: HorizonEventSink = postgresEventSink,
): () => void {
  const offs: (() => void)[] = [];
  for (const binding of UPSTREAM_BINDINGS) {
    const adapter = adapters[binding.upstreamTopic];
    if (!adapter) continue;
    offs.push(on(binding.upstreamTopic, { name: 'horizon:' + binding.horizonEvent }, async (payload, meta) => {
      const input = await adapter(payload, { actorId: meta.actorId, correlationId: meta.correlationId });
      if (!input) return;
      await emitHorizonEvent(input, sink);
    }));
  }
  return () => { for (const off of offs) off(); };
}
