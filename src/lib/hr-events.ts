// src/lib/hr-events.ts — ONE APPEND-ONLY LOG OF WHAT HAPPENED TO A PERSON.
//
// =================================================================================================
// WHY THIS EXISTS AND WHAT IT IS NOT
// =================================================================================================
//
// This codebase already has the modules. What it does not have is a single place that can answer
// "what has happened to this person, in order". Today that answer is assembled by hand from
// application_stage_events, hr_transfers, hr_promotions, hr_leave_request, hr_performance_reviews,
// training_enrollments, hr_employee_skills and hr_separations — seven tables, four id spaces, and no
// screen that joins them.
//
// hr_events is the spine's timeline. TWELVE EVENT TYPES, one row each, appended where the thing
// ALREADY HAPPENS. It reimplements nothing: every emit in this system sits immediately after the
// write that is the real record, in the module that owns it.
//
//   CandidateApplied · InterviewCompleted · OfferAccepted · EmployeeJoined · EmployeePromoted
//   EmployeeTransferred · LeaveApproved · GoalCreated · PerformanceReviewCompleted
//   CourseCompleted · SkillVerified · EmployeeExited
//
// THE LOG IS NOT THE RECORD. hr_leave_request is still where a leave request lives; this says that
// one was approved, when, by whom, and points back at it. If the two ever disagree, the module's own
// table is right and this row is the bug.
//
// =================================================================================================
// THE THREE RULES AN EMIT OBEYS
// =================================================================================================
//
// 1. A FAILED EMIT NEVER ROLLS BACK THE REAL ACTION. Every emit runs AFTER the write it describes
//    and outside its transaction. emitHrEvent() cannot throw — it returns { ok, id, error } — so a
//    caller that forgets to check it still cannot lose a leave approval to a missing log table.
//
// 2. A FAILED EMIT IS NEVER SILENT. It is written to the console with the real Postgres reason
//    (e.cause.message, not e.message which is only the failed SQL), kept in a bounded in-memory list
//    that recentEmitFailures() returns for an ops screen, and best-effort recorded in audit_log. An
//    empty catch is how a total outage hid on this project for hours.
//
// 3. AN EVENT RECORDS WHAT HAPPENED, NEVER WHAT WAS GUESSED. `assertion` may only be one of
//    factual / explicitly_provided / verified / calculated. There is no 'inferred', no 'predicted'
//    and no 'recommended' on this table, because an inference did not happen to anybody. A
//    recommendation belongs on ai_recommendations in src/lib/ai-boundary.ts, where it carries the
//    seven questions and cannot be acted on.
//
// =================================================================================================
// APPEND-ONLY, AND WHAT THAT MEANS HERE
// =================================================================================================
//
// This module exports no update and no delete. A correction is a new event, not an edit — the whole
// value of a timeline is that it did not change after you read it. Where the database permits it, a
// trigger refuses UPDATE and DELETE on hr_events outright; that trigger is created best-effort and
// its presence is REPORTED by ensureHrEventsSchema() rather than assumed, so an operator can see
// whether the guarantee is a database guarantee or only a convention.
//
// =================================================================================================
// SkillVerified IS THE ONE THAT MATTERS MOST
// =================================================================================================
//
// A skill on a CV is a claim. A level somebody typed into a dropdown is a claim. Neither is proof of
// competence, and neither may produce this event. SkillVerified is emitted only through
// emitSkillVerified(), which REQUIRES the human who verified it and the evidence they saw — a
// completion or a passed attempt, already confirmed against the learner's own record by the module
// that owns that fact. Without both, it refuses, and the skill row is still written; it is simply
// not called verified.
//
// =================================================================================================
// WHAT A PAYLOAD MAY NOT CARRY
// =================================================================================================
//
// Payload KEYS are checked against src/lib/ai-boundary.ts PROTECTED_ATTRIBUTE_SEGMENTS and a match
// refuses the emit. A timeline is exactly the kind of convenient, widely-read table where a
// protected attribute becomes a feature by accident.
//
// This is also why LeaveApproved carries no leave TYPE. "sick" on a person's permanent timeline is a
// health fact in an HR table, and hr_leave_request already holds it for the people entitled to read
// it. The event carries the request id; anybody with the authority to know can follow it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { refuseProtectedAttributes } from '@/lib/ai-boundary';

const MOD = 'hr-events';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** postgres-js hands back a PLAIN ARRAY. `r.rows[0]` has broken this project before. */
function rowsOf(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown reason');
}

function logFail(where: string, e: any): void {
  console.error('[' + MOD + '] ' + where + ': ' + reasonOf(e));
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// =================================================================================================
// THE VOCABULARY
// =================================================================================================

export const HR_EVENT_TYPES = [
  'CandidateApplied',
  'InterviewCompleted',
  'OfferAccepted',
  'EmployeeJoined',
  'EmployeePromoted',
  'EmployeeTransferred',
  'LeaveApproved',
  'GoalCreated',
  'PerformanceReviewCompleted',
  'CourseCompleted',
  'SkillVerified',
  'EmployeeExited',
] as const;
export type HrEventType = (typeof HR_EVENT_TYPES)[number];

export function isHrEventType(v: unknown): v is HrEventType {
  return typeof v === 'string' && (HR_EVENT_TYPES as readonly string[]).indexOf(v) >= 0;
}

/** What a person reads on a timeline. Plain sentences — the type name is for code. */
export const HR_EVENT_LABELS: Record<string, string> = {
  CandidateApplied: 'Applied for a role',
  InterviewCompleted: 'Interview feedback recorded',
  OfferAccepted: 'Accepted an offer',
  EmployeeJoined: 'Joined',
  EmployeePromoted: 'Designation changed through an approved request',
  EmployeeTransferred: 'Moved through an approved transfer',
  LeaveApproved: 'Leave approved',
  GoalCreated: 'Objective recorded',
  PerformanceReviewCompleted: 'Appraisal outcome shared',
  CourseCompleted: 'Completed a course on this platform',
  SkillVerified: 'Skill level evidenced and verified',
  EmployeeExited: 'Left',
};

/**
 * HOW THE THING IN THIS ROW CAME TO BE KNOWN. An event log may carry only these four.
 *
 *   factual              it happened in this system and this system watched it happen
 *   explicitly_provided  a person stated it and we are recording that they stated it
 *   verified             a named human checked it against evidence that is linked
 *   calculated           derived from other rows by a named definition, not measured
 *
 * inferred / predicted / recommended are DELIBERATELY ABSENT. None of them happened to anybody, and
 * the moment one is admissible on a timeline it becomes indistinguishable from the rest of it.
 */
export const HR_EVENT_ASSERTIONS = ['factual', 'explicitly_provided', 'verified', 'calculated'] as const;
export type HrEventAssertion = (typeof HR_EVENT_ASSERTIONS)[number];

export const HR_EVENT_ASSERTION_LABELS: Record<string, string> = {
  factual: 'Happened in this system',
  explicitly_provided: 'Stated by a person',
  verified: 'Checked by a named human against linked evidence',
  calculated: 'Derived from other records',
};

// =================================================================================================
// SHAPES
// =================================================================================================

/**
 * WHO the event is about. A human occupies up to four id spaces here (users.id, applications.id,
 * hr_employees.id, and the learner account which is a users.id) and there is no person root yet, so
 * every id that is KNOWN at emit time should be given. That is what will let a person root be
 * stitched together later without re-reading every module.
 */
export interface HrEventSubject {
  employeeId?: string | null;
  applicationId?: string | null;
  userId?: string | null;
}

export interface EmitHrEventInput {
  type: HrEventType;
  subject: HrEventSubject;
  /** users.id of whoever caused it. Null when nothing human did — a cron, a webhook, an expiry. */
  actorUserId?: string | null;
  /** 'human' when a person pressed something; 'system' for a scheduled or automatic cause. */
  actorKind?: 'human' | 'system';
  /** The module or page that emitted it, so a wrong row can be traced to its writer. */
  sourceModule: string;
  /** The row in the owning module this event describes: a leave id, a review id, a transfer id. */
  recordRef?: string | null;
  payload?: Record<string, unknown>;
  assertion?: HrEventAssertion;
  occurredAt?: Date | string | null;
  correlationId?: string | null;
}

export interface EmitResult {
  ok: boolean;
  id: string | null;
  error: string | null;
}

export interface HrEvent {
  id: string;
  type: string;
  label: string;
  subject: HrEventSubject;
  actorUserId: string | null;
  actorKind: string;
  sourceModule: string;
  recordRef: string | null;
  payload: Record<string, unknown>;
  assertion: string;
  assertionLabel: string;
  occurredAt: string | null;
  recordedAt: string | null;
  correlationId: string | null;
}

// =================================================================================================
// SCHEMA — CREATED, THEN VERIFIED AGAINST information_schema
// =================================================================================================
//
// src/lib/ensure-once.ts ends in p.catch(() => {}): a DDL failure inside it RESOLVES and the caller
// reports success. Ten module tables were reported created on this project and none existed. So this
// module memoises only a state it has VERIFIED by reading information_schema, and a state that is
// not ok is never cached — the next call tries again.

const REQUIRED_COLUMNS = [
  'id', 'event_type', 'subject_employee_id', 'subject_application_id', 'subject_user_id',
  'actor_user_id', 'actor_kind', 'source_module', 'record_ref', 'payload', 'assertion',
  'occurred_at', 'recorded_at', 'correlation_id',
];

export interface HrEventsSchemaState {
  ok: boolean;
  tablePresent: boolean;
  missingColumns: string[];
  /** True only when the database itself refuses UPDATE and DELETE on hr_events. */
  appendOnlyEnforced: boolean;
  appendOnlyNote: string;
  error: string | null;
  checkedAt: string;
}

let verifiedState: HrEventsSchemaState | null = null;
let inflight: Promise<HrEventsSchemaState> | null = null;

async function createEventsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hr_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(60) NOT NULL,
      subject_employee_id UUID,
      subject_application_id UUID,
      subject_user_id UUID,
      actor_user_id UUID,
      actor_kind VARCHAR(10) NOT NULL DEFAULT 'human',
      source_module VARCHAR(160) NOT NULL,
      record_ref VARCHAR(160),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      assertion VARCHAR(24) NOT NULL DEFAULT 'factual',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      correlation_id VARCHAR(120)
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_type_idx ON hr_events (event_type, occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_emp_idx ON hr_events (subject_employee_id, occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_app_idx ON hr_events (subject_application_id, occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_user_idx ON hr_events (subject_user_id, occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_occurred_idx ON hr_events (occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_events_correlation_idx ON hr_events (correlation_id)`);
}

/**
 * Make the database itself refuse UPDATE and DELETE on hr_events.
 *
 * BEST EFFORT ON PURPOSE. A managed database that will not let this role create a trigger must not
 * stop the log from working; the guarantee simply drops from "the database refuses" to "no code in
 * this repository does it", and ensureHrEventsSchema() reports WHICH of the two is true rather than
 * letting an operator assume the stronger one.
 *
 * Idempotent without a DROP: the function is replaced, the trigger is created only when pg_trigger
 * does not already have it.
 */
async function enforceAppendOnly(): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION hr_events_append_only() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'hr_events is append-only: a correction is a new event, not an edit';
    END;
    $fn$ LANGUAGE plpgsql`);
  await db.execute(sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'hr_events' AND t.tgname = 'hr_events_no_update_delete'
      ) THEN
        CREATE TRIGGER hr_events_no_update_delete
          BEFORE UPDATE OR DELETE ON hr_events
          FOR EACH ROW EXECUTE FUNCTION hr_events_append_only();
      END IF;
    END
    $do$`);
}

async function readSchemaState(): Promise<HrEventsSchemaState> {
  const state: HrEventsSchemaState = {
    ok: false,
    tablePresent: false,
    missingColumns: REQUIRED_COLUMNS.slice(),
    appendOnlyEnforced: false,
    appendOnlyNote: '',
    error: null,
    checkedAt: new Date().toISOString(),
  };
  try {
    const cols = rowsOf(await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'hr_events'`));
    const have = new Set(cols.map((c: any) => String(c.column_name)));
    state.tablePresent = have.size > 0;
    state.missingColumns = REQUIRED_COLUMNS.filter((c) => !have.has(c));
    state.ok = state.tablePresent && state.missingColumns.length === 0;
    if (!state.tablePresent) state.error = 'hr_events does not exist.';
    else if (state.missingColumns.length) state.error = 'hr_events is missing ' + state.missingColumns.join(', ') + '.';

    const trig = rowsOf(await db.execute(sql`
      SELECT 1 AS present FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'hr_events' AND t.tgname = 'hr_events_no_update_delete'
       LIMIT 1`));
    state.appendOnlyEnforced = trig.length > 0;
    state.appendOnlyNote = state.appendOnlyEnforced
      ? 'The database refuses UPDATE and DELETE on hr_events.'
      : 'Append-only is a convention here, not a database guarantee: no trigger is installed, so a '
        + 'direct UPDATE or DELETE would succeed. No code in this repository writes one.';
    return state;
  } catch (e: any) {
    logFail('readSchemaState', e);
    state.error = 'The database could not be asked what exists: ' + reasonOf(e);
    state.appendOnlyNote = 'Unknown — the check could not run.';
    return state;
  }
}

/**
 * Create the log, try to make it append-only, then ASK THE DATABASE WHAT IS ACTUALLY THERE.
 *
 * The return value is a report, not a promise that it worked.
 */
export async function ensureHrEventsSchema(): Promise<HrEventsSchemaState> {
  if (verifiedState && verifiedState.ok) return verifiedState;
  if (inflight) return inflight;
  inflight = (async () => {
    let ddlError: string | null = null;
    try {
      await createEventsTable();
    } catch (e: any) {
      logFail('ensureHrEventsSchema:table', e);
      ddlError = reasonOf(e);
    }
    try {
      await enforceAppendOnly();
    } catch (e: any) {
      // Reported, never fatal — see enforceAppendOnly().
      logFail('ensureHrEventsSchema:append-only', e);
    }
    const state = await readSchemaState();
    if (ddlError && !state.ok) state.error = (state.error ? state.error + ' — ' : '') + 'DDL failed: ' + ddlError;
    if (state.ok) verifiedState = state;
    return state;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Re-read the state from scratch. For an ops surface that wants the truth on demand. */
export async function hrEventsSchemaState(): Promise<HrEventsSchemaState> {
  verifiedState = null;
  return ensureHrEventsSchema();
}

// =================================================================================================
// FAILURES ARE KEPT, NOT SWALLOWED
// =================================================================================================

export interface EmitFailure {
  type: string;
  sourceModule: string;
  recordRef: string | null;
  error: string;
  at: string;
}

const failures: EmitFailure[] = [];
const MAX_FAILURES = 200;

function recordFailure(f: EmitFailure): void {
  failures.push(f);
  if (failures.length > MAX_FAILURES) failures.splice(0, failures.length - MAX_FAILURES);
  console.error('[' + MOD + '] EMIT FAILED ' + f.type + ' from ' + f.sourceModule
    + (f.recordRef ? ' (' + f.recordRef + ')' : '') + ': ' + f.error);
}

/**
 * Emit failures this process has seen, newest last.
 *
 * IN MEMORY, so it is emptied by a restart and is per-instance on a serverless platform. It is a
 * fast read for an ops screen, not the record — audit_log below is the durable one.
 */
export function recentEmitFailures(limit = 50): EmitFailure[] {
  const cap = Math.max(1, Math.min(MAX_FAILURES, Math.round(limit)));
  return failures.slice(-cap);
}

async function recordFailureDurably(f: EmitFailure): Promise<void> {
  try {
    await logAudit({
      userId: null,
      action: 'hr_event.emit_failed',
      entity: 'hr_events',
      entityId: f.recordRef || undefined,
      diff: { type: f.type, sourceModule: f.sourceModule, error: f.error },
    });
  } catch (e: any) {
    // logAudit already swallows its own failure; this covers an import-time or transport failure.
    // The console line above has already been written, so nothing is lost silently.
    logFail('recordFailureDurably', e);
  }
}

// =================================================================================================
// THE EMIT
// =================================================================================================

function normaliseSubject(s: HrEventSubject | null | undefined): HrEventSubject {
  return {
    employeeId: isUuid(s?.employeeId) ? String(s?.employeeId) : null,
    applicationId: isUuid(s?.applicationId) ? String(s?.applicationId) : null,
    userId: isUuid(s?.userId) ? String(s?.userId) : null,
  };
}

function toTimestamp(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Append one event.
 *
 * NEVER THROWS. It returns { ok, id, error } so that a caller which does not check it still cannot
 * lose the real action to a logging failure — and a caller which DOES check it gets the real reason
 * to show or to record.
 *
 * Refuses, and says so, when:
 *   - the type is not one of the twelve;
 *   - there is nobody it is about;
 *   - the assertion is not one of the four an event may carry;
 *   - a payload key names a protected or sensitive attribute.
 */
export async function emitHrEvent(input: EmitHrEventInput): Promise<EmitResult> {
  const type = String(input?.type || '');
  const sourceModule = clean(input?.sourceModule, 160) || 'unknown';
  const recordRef = clean(input?.recordRef, 160) || null;

  const refuse = async (error: string): Promise<EmitResult> => {
    const f: EmitFailure = { type: type || 'unknown', sourceModule, recordRef, error, at: new Date().toISOString() };
    recordFailure(f);
    await recordFailureDurably(f);
    return { ok: false, id: null, error };
  };

  if (!isHrEventType(type)) {
    return refuse('That is not one of the twelve events this log records, so nothing was appended.');
  }

  const subject = normaliseSubject(input?.subject);
  if (!subject.employeeId && !subject.applicationId && !subject.userId) {
    return refuse('An event has to be about somebody, and no employee, application or account id was given.');
  }

  const assertion: string = input?.assertion && (HR_EVENT_ASSERTIONS as readonly string[]).indexOf(input.assertion) >= 0
    ? String(input.assertion)
    : 'factual';
  if ((HR_EVENT_ASSERTIONS as readonly string[]).indexOf(assertion) < 0) {
    return refuse('An event may only be factual, explicitly_provided, verified or calculated. '
      + 'An inference or a prediction did not happen to anybody and does not belong on a timeline.');
  }

  const payload = (input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload))
    ? input.payload as Record<string, unknown>
    : {};
  const protectedRefusal = refuseProtectedAttributes(payload, 'This event payload');
  if (protectedRefusal) return refuse(protectedRefusal);

  const actorUserId = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const actorKind = input?.actorKind === 'system' || !actorUserId ? 'system' : 'human';
  const occurredAt = toTimestamp(input?.occurredAt);
  const correlationId = clean(input?.correlationId, 120) || null;

  try {
    const schema = await ensureHrEventsSchema();
    if (!schema.ok) {
      return refuse('The event log is not usable: ' + (schema.error || 'hr_events is not present.')
        + ' The action itself was not affected.');
    }
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_events
        (event_type, subject_employee_id, subject_application_id, subject_user_id,
         actor_user_id, actor_kind, source_module, record_ref, payload, assertion,
         occurred_at, correlation_id)
      VALUES
        (${type}, ${subject.employeeId}::uuid, ${subject.applicationId}::uuid, ${subject.userId}::uuid,
         ${actorUserId}::uuid, ${actorKind}, ${sourceModule}, ${recordRef}::text,
         ${JSON.stringify(payload)}::jsonb, ${assertion},
         COALESCE(${occurredAt}::timestamptz, NOW()), ${correlationId}::text)
      RETURNING id`));
    if (!rows.length) {
      return refuse('The event was not appended and the database returned no reason.');
    }
    return { ok: true, id: String(rows[0].id), error: null };
  } catch (e: any) {
    logFail('emitHrEvent', e);
    return refuse(reasonOf(e));
  }
}

// =================================================================================================
// SkillVerified — THE ONLY EVENT THAT MAY CALL A SKILL VERIFIED
// =================================================================================================

export interface SkillVerifiedInput {
  employeeId: string;
  /** The learner account the evidence was confirmed against, when it is known. */
  learnerUserId?: string | null;
  skillId: string;
  skillName?: string | null;
  level: number;
  levelLabel?: string | null;
  /** users.id of the person who verified it. There is no system value for this field. */
  verifiedByUserId: string;
  /**
   * What they saw. `kind` is the sort of record ('course' or 'assessment' today), `ref` is that
   * record's id, `label` is the sentence written from the confirmed record — never from a form — and
   * `url` is where to go and check it.
   */
  evidence: { kind: string; ref: string; label: string; url?: string | null };
  sourceModule: string;
  correlationId?: string | null;
  occurredAt?: Date | string | null;
}

/**
 * Say that a level was verified, by a named human, against evidence that is linked.
 *
 * REFUSES WITHOUT A HUMAN, AND REFUSES WITHOUT EVIDENCE. Both refusals leave the underlying skill row
 * exactly as its own module wrote it: the level is still recorded, it is simply recorded as the kind
 * of claim it actually is. A keyword is not proof of competence and a dropdown is not verification.
 *
 * The level is NOT derived from the evidence here and this event does not pretend otherwise: it
 * records the level a person recorded and the evidence they attached, as one row, so a later reader
 * can see both and judge. Deriving a level from a 51% pass is a different conversation and it is not
 * this function's to have.
 */
export async function emitSkillVerified(input: SkillVerifiedInput): Promise<EmitResult> {
  const sourceModule = clean(input?.sourceModule, 160) || 'unknown';
  const employeeId = isUuid(input?.employeeId) ? String(input.employeeId) : null;
  const skillId = isUuid(input?.skillId) ? String(input.skillId) : null;
  const verifier = isUuid(input?.verifiedByUserId) ? String(input.verifiedByUserId) : null;
  const kind = clean(input?.evidence?.kind, 60);
  const ref = clean(input?.evidence?.ref, 160);
  const label = clean(input?.evidence?.label, 500);
  const url = clean(input?.evidence?.url, 500);

  const refuse = async (error: string): Promise<EmitResult> => {
    const f: EmitFailure = {
      type: 'SkillVerified', sourceModule, recordRef: skillId, error, at: new Date().toISOString(),
    };
    recordFailure(f);
    await recordFailureDurably(f);
    return { ok: false, id: null, error };
  };

  if (!employeeId || !skillId) {
    return refuse('A verified skill needs both the person and the skill. Nothing was appended.');
  }
  if (!verifier) {
    return refuse('Nothing may be called verified without the human who verified it. Nothing was appended, '
      + 'and the skill level itself is unaffected — it stands as the claim it is.');
  }
  if (!kind || !ref || !label) {
    return refuse('Nothing may be called verified without the evidence it was checked against. '
      + 'Nothing was appended, and the skill level itself is unaffected.');
  }

  const level = Math.round(Number(input?.level));
  return emitHrEvent({
    type: 'SkillVerified',
    subject: { employeeId, userId: input?.learnerUserId ?? null },
    actorUserId: verifier,
    actorKind: 'human',
    sourceModule,
    recordRef: skillId,
    assertion: 'verified',
    occurredAt: input?.occurredAt ?? null,
    correlationId: input?.correlationId ?? null,
    payload: {
      skillId,
      skillName: clean(input?.skillName, 200) || null,
      level: isFinite(level) ? level : null,
      levelLabel: clean(input?.levelLabel, 60) || null,
      verifiedByUserId: verifier,
      evidence: { kind, ref, label, url: url && /^(https?:\/\/|\/)/i.test(url) ? url : null },
    },
  });
}

// =================================================================================================
// READING THE TIMELINE
// =================================================================================================

function mapEvent(r: any): HrEvent {
  let payload: Record<string, unknown> = {};
  const raw = r?.payload;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) payload = raw as Record<string, unknown>;
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) payload = p;
    } catch (_) {
      payload = {};
    }
  }
  const type = String(r?.event_type ?? '');
  const assertion = String(r?.assertion ?? 'factual');
  return {
    id: String(r?.id ?? ''),
    type,
    label: HR_EVENT_LABELS[type] || type,
    subject: {
      employeeId: r?.subject_employee_id ? String(r.subject_employee_id) : null,
      applicationId: r?.subject_application_id ? String(r.subject_application_id) : null,
      userId: r?.subject_user_id ? String(r.subject_user_id) : null,
    },
    actorUserId: r?.actor_user_id ? String(r.actor_user_id) : null,
    actorKind: String(r?.actor_kind ?? 'system'),
    sourceModule: String(r?.source_module ?? ''),
    recordRef: r?.record_ref ? String(r.record_ref) : null,
    payload,
    assertion,
    assertionLabel: HR_EVENT_ASSERTION_LABELS[assertion] || assertion,
    occurredAt: r?.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    recordedAt: r?.recorded_at ? new Date(r.recorded_at).toISOString() : null,
    correlationId: r?.correlation_id ? String(r.correlation_id) : null,
  };
}

/**
 * One person's timeline, newest first, across every id space they occupy.
 *
 * PASS EVERY ID YOU HOLD. Until a person root exists, an employee row and the application it came
 * from are joined by nothing but a nullable back-pointer, so a caller that knows both must say both
 * or the candidate half of the story is invisible from the employee record.
 *
 * AUTHORIZATION IS THE CALLER'S. This module answers "what happened"; who may ask is a question for
 * src/lib/org-graph.ts per row and src/lib/auth/permissions.ts per user, and neither belongs here.
 */
export async function timelineFor(subject: HrEventSubject, limit = 200): Promise<HrEvent[]> {
  const s = normaliseSubject(subject);
  if (!s.employeeId && !s.applicationId && !s.userId) return [];
  try {
    const schema = await ensureHrEventsSchema();
    if (!schema.ok) return [];
    const cap = Math.max(1, Math.min(1000, Math.round(limit)));
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM hr_events
       WHERE (${s.employeeId}::uuid IS NOT NULL AND subject_employee_id = ${s.employeeId}::uuid)
          OR (${s.applicationId}::uuid IS NOT NULL AND subject_application_id = ${s.applicationId}::uuid)
          OR (${s.userId}::uuid IS NOT NULL AND subject_user_id = ${s.userId}::uuid)
       ORDER BY occurred_at DESC, recorded_at DESC
       LIMIT ${cap}`));
    return rows.map(mapEvent);
  } catch (e: any) {
    logFail('timelineFor', e);
    return [];
  }
}

export async function listHrEvents(
  opts: { type?: HrEventType | null; since?: string | null; limit?: number } = {},
): Promise<HrEvent[]> {
  try {
    const schema = await ensureHrEventsSchema();
    if (!schema.ok) return [];
    const type = isHrEventType(opts?.type) ? String(opts.type) : null;
    const since = toTimestamp(opts?.since);
    const cap = Math.max(1, Math.min(1000, Math.round(Number(opts?.limit) || 100)));
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM hr_events
       WHERE (${type}::text IS NULL OR event_type = ${type})
         AND (${since}::timestamptz IS NULL OR occurred_at >= ${since}::timestamptz)
       ORDER BY occurred_at DESC, recorded_at DESC
       LIMIT ${cap}`));
    return rows.map(mapEvent);
  } catch (e: any) {
    logFail('listHrEvents', e);
    return [];
  }
}

/**
 * How many of each type the log holds, with every type listed even at zero.
 *
 * A type sitting at zero is the useful reading: it means either that nothing of that sort has
 * happened since the log existed, or that its emit is not wired. Hiding the zeros would hide the
 * second case, which is the one worth finding.
 */
export async function eventCounts(): Promise<{ type: HrEventType; label: string; count: number }[]> {
  const base = HR_EVENT_TYPES.map((t) => ({ type: t, label: HR_EVENT_LABELS[t] || t, count: 0 }));
  try {
    const schema = await ensureHrEventsSchema();
    if (!schema.ok) return base;
    const rows = rowsOf(await db.execute(sql`
      SELECT event_type, COUNT(*)::int AS n FROM hr_events GROUP BY event_type`));
    const byType = new Map<string, number>();
    for (const r of rows) byType.set(String((r as any).event_type), Number((r as any).n) || 0);
    return base.map((b) => ({ ...b, count: byType.get(b.type) || 0 }));
  } catch (e: any) {
    logFail('eventCounts', e);
    return base;
  }
}
