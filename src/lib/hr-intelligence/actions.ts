// src/lib/hr-intelligence/actions.ts — THE SIX THINGS THE HR DESK CAN ACTUALLY DO FROM THIS SCREEN.
//
// =================================================================================================
// THREE ARE DELEGATED AND THREE ARE OWNED, AND THE SPLIT IS NOT ARBITRARY
// =================================================================================================
//
// DELEGATED — the write belongs to a module that already exists, so this file calls it and does not
// touch its table:
//
//   assign_training   -> performance-learning.assignCourse()      writes hr_learning_assignments
//   schedule_review   -> performance-learning.createTrainingEvent() writes hr_training_events
//   request_feedback  -> the REQUEST is ours; the feedback itself lands in hr_feedback through
//                        performance.giveFeedback(), which this module never bypasses.
//
// OWNED — nothing on this platform records these, so this patch does:
//
//   initiate_development_plan -> hri_development_plans + hri_plan_items
//   record_intervention       -> hri_interventions
//   initiate_mobility_review  -> hri_mobility_reviews
//
// A DELEGATED ACTION ASKS THE OWNER'S PERMISSION, NOT THIS SCREEN'S. Every function below takes the
// resolved HrIntelAccess and refuses when the action was not granted — and for the two learning
// actions the grant is `learning.assign`, the learning module's own key. If this screen granted
// them on the strength of the people desk key, this screen would have quietly widened who may
// assign learning to everybody in the organisation.
//
// =================================================================================================
// EVERY ACT IS AUDITED, AND EVERY ACT NAMES ITS CAUSE
// =================================================================================================
//
// `prompted_by` on an intervention and `reason` on everything else are NOT NULL in the schema and
// required here. An act on a person's record with no stated cause is the thing that makes a
// development record unreadable a year later, when the person disagreeing with it asks why.
//
// Where an act creates something from a signal, the SIGNAL IS SNAPSHOTTED onto the row: its inputs,
// its evidence, its confidence and its timestamp, as they were. Six months later the underlying
// records will have moved, and a plan that cannot say what it was opened on the strength of is a
// plan nobody can defend or disagree with.
//
// =================================================================================================
// NOTHING HERE DECIDES ANYTHING
// =================================================================================================
//
// No function in this file writes hr_employees.designation, an employment status, a rating, a skill
// level, a salary or a flag. Hiring, rejection, promotion, termination, compensation and discipline
// are not reachable from this module, and there is no seam where one could be added: the tables
// that hold them are not imported and are not named in any SQL below.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { logAudit } from '@/lib/audit';
import { emitHrEvent } from '@/lib/hr-events';
import { assignCourse, createTrainingEvent } from '@/lib/performance-learning';
import type { PerfViewer } from '@/lib/performance-scope';
import { ensureHrIntelSchema } from '@/lib/hr-intelligence/schema';
import { LEARNING_ASSIGN } from '@/lib/hr-intelligence/access';
import type { HrIntelAccess } from '@/lib/hr-intelligence/access';
import {
  actionLabel,
  type HrActionKind,
  type HrSignal,
} from '@/lib/hr-intelligence/types';

const MOD = 'hr-intelligence/actions';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => logEvent('error', MOD + ':' + tag, { message: reasonOf(e) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): string | null =>
  typeof v === 'string' && DAY_RE.test(v.trim()) ? v.trim() : null;

export interface ActionResult {
  ok: boolean;
  /** The row this act created, when it created one. */
  id: string | null;
  /** What a screen prints on success. Says what happened, never "Saved". */
  message: string | null;
  error: string | null;
}

const fail = (error: string): ActionResult => ({ ok: false, id: null, message: null, error });

/**
 * The one gate every action passes through.
 *
 * It re-asks the resolved decision rather than trusting the caller to have checked, because the
 * caller is a POST handler and a POST handler that forgot is the most common way a gated action
 * becomes an ungated one.
 */
function guard(access: HrIntelAccess, kind: HrActionKind): string | null {
  if (!access?.mayOpen) {
    return 'You cannot open this person\'s record, so you cannot act on it.';
  }
  const decision = access.actions.find((a) => a.kind === kind);
  if (!decision || !decision.granted) {
    return decision?.because || (actionLabel(kind) + ' is not available to you.');
  }
  return null;
}

/** The snapshot written onto a row created from a signal. Trimmed, because a row is not an archive. */
function snapshotOf(signal: HrSignal | null | undefined): Record<string, unknown> {
  if (!signal) return {};
  return {
    signalId: signal.id,
    section: signal.section,
    label: signal.label,
    value: signal.value,
    processing: signal.processing,
    inputs: signal.inputs,
    evidence: signal.evidence.slice(0, 20),
    confidence: signal.confidence,
    strength: signal.strength,
    decisionUse: signal.decisionUse,
    computedAt: signal.computedAt,
    snapshotNote: 'This is the signal AS IT WAS when this record was created. It is never re-read '
      + 'as current truth; the sources behind it have moved on.',
  };
}

async function schemaReady(): Promise<string | null> {
  const state = await ensureHrIntelSchema();
  if (state.ok) return null;
  return 'The HR intelligence tables are not available, so nothing was written: '
    + (state.error || 'unknown reason') + '.';
}

// =================================================================================================
// 1. REQUEST FEEDBACK  (the request is ours; the feedback is the feedback module's)
// =================================================================================================

/**
 * Record that a named person was asked for feedback about this employee, and why.
 *
 * IT SENDS NOTHING AND NOTIFIES NOBODY. There is no notification path from this module, and adding
 * one would be a product decision about mailing people about a colleague's development record, not
 * a detail of this action. What it produces is a row the requester can point at and the person
 * asked can be shown.
 *
 * THE FEEDBACK ITSELF NEVER LANDS HERE. When it arrives it is written to hr_feedback by
 * performance.giveFeedback(), which owns that table; markFeedbackReceived() below joins the two.
 */
export async function requestFeedback(input: {
  access: HrIntelAccess;
  employeeId: string;
  requestedOfUserId: string | null;
  requestedOfName: string;
  theme?: string;
  reason: string;
  actorUserId: string | null;
  actorName?: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'request_feedback');
  if (denied) return fail(denied);

  const employeeId = String(input.employeeId || '');
  if (!isUuid(employeeId)) return fail('Choose who the feedback is about.');

  const name = clean(input.requestedOfName, 200);
  const requestedOf = isUuid(input.requestedOfUserId) ? String(input.requestedOfUserId) : null;
  if (!name && !requestedOf) return fail('Name the person you are asking.');

  const reason = clean(input.reason, 1000);
  if (!reason) {
    return fail('Say why you are asking. A request with no stated reason is one the person asked '
      + 'cannot answer well and the employee cannot be shown fairly.');
  }
  const theme = ['general', 'strength', 'improvement'].indexOf(clean(input.theme, 24)) >= 0
    ? clean(input.theme, 24)
    : 'general';

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hri_feedback_requests
        (employee_id, requested_of_user_id, requested_of_name, requested_by_user_id,
         requested_by_name, theme, reason, status)
      VALUES
        (${employeeId}, ${requestedOf}, ${name || null}, ${input.actorUserId},
         ${clean(input.actorName, 200) || null}, ${theme}, ${reason}, 'open')
      RETURNING id`));
    const id = rows.length ? String((rows[0] as any).id) : null;
    if (!id) return fail('The request was not written: the insert returned no row.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.request_feedback',
      entity: 'hri_feedback_requests',
      entityId: id,
      diff: { employeeId, requestedOf: requestedOf || name, theme },
    });

    return {
      ok: true,
      id,
      message: 'Recorded that you asked ' + (name || 'a named colleague') + ' for feedback. Nobody '
        + 'was notified by this platform — the request is a record, and asking them is still '
        + 'something you do.',
      error: null,
    };
  } catch (e: any) {
    logFail('requestFeedback', e);
    return fail('The request could not be recorded: ' + reasonOf(e));
  }
}

/**
 * Join a request to the feedback note that answered it.
 *
 * The note itself is NOT written here and its id is not validated against hr_feedback by this
 * module: performance.ts owns that table and this is a pointer, recorded honestly as a pointer.
 */
export async function markFeedbackReceived(input: {
  access: HrIntelAccess;
  requestId: string;
  feedbackId: string;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'request_feedback');
  if (denied) return fail(denied);
  if (!isUuid(input.requestId)) return fail('Which request?');
  if (!isUuid(input.feedbackId)) return fail('Which feedback note?');

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE hri_feedback_requests
         SET status = 'received',
             fulfilled_feedback_id = ${input.feedbackId},
             fulfilled_at = NOW()
       WHERE id = ${input.requestId} AND status = 'open'
      RETURNING id`));
    if (!rows.length) {
      return fail('That request is not open, so it was not changed. A request that was already '
        + 'answered or withdrawn keeps the record of what happened to it.');
    }
    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.feedback_received',
      entity: 'hri_feedback_requests',
      entityId: input.requestId,
      diff: { feedbackId: input.feedbackId },
    });
    return { ok: true, id: input.requestId, message: 'The request is marked as answered.', error: null };
  } catch (e: any) {
    logFail('markFeedbackReceived', e);
    return fail('The request could not be updated: ' + reasonOf(e));
  }
}

// =================================================================================================
// 2. INITIATE A DEVELOPMENT PLAN  (owned)
// =================================================================================================

export interface PlanItemInput {
  kind?: string;
  skillId?: string | null;
  title: string;
  detail?: string | null;
  dueOn?: string | null;
  /** The signal this item came from, snapshotted onto the row as it was. */
  signal?: HrSignal | null;
}

/**
 * Open a development plan.
 *
 * A PLAN WITH NO ITEMS IS REFUSED. "We should develop them" is not a plan, and a row with a title
 * and nothing under it is what an empty intention looks like six months later when somebody asks
 * what was actually done.
 *
 * The plan is VISIBLE TO THE EMPLOYEE by default and there is no parameter here to make it
 * otherwise: a development plan the subject cannot see is a personnel file about them.
 */
export async function initiateDevelopmentPlan(input: {
  access: HrIntelAccess;
  employeeId: string;
  title: string;
  reason: string;
  targetOn?: string | null;
  items: PlanItemInput[];
  actorUserId: string | null;
  actorName?: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'initiate_development_plan');
  if (denied) return fail(denied);

  const employeeId = String(input.employeeId || '');
  if (!isUuid(employeeId)) return fail('Choose whose plan this is.');

  const title = clean(input.title, 300);
  if (!title) return fail('Give the plan a title.');

  const reason = clean(input.reason, 2000);
  if (!reason) {
    return fail('Say why this plan is being opened. The reason is what the employee reads first and '
      + 'what anybody reviewing the plan later has to go on.');
  }

  const items = (input.items || [])
    .map((i) => ({
      kind: clean(i.kind, 30) || 'skill_gap',
      skillId: isUuid(i.skillId) ? String(i.skillId) : null,
      title: clean(i.title, 300),
      detail: clean(i.detail, 2000) || null,
      dueOn: validDay(i.dueOn),
      signalId: i.signal ? clean(i.signal.id, 120) : null,
      snapshot: snapshotOf(i.signal),
    }))
    .filter((i) => !!i.title)
    .slice(0, 40);

  if (!items.length) {
    return fail('A plan needs at least one item. A plan with nothing under it is an intention, and '
      + 'it will read as an empty record to whoever opens it next.');
  }

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const planRows = rowsOf(await db.execute(sql`
      INSERT INTO hri_development_plans
        (employee_id, title, reason, status, opened_by_user_id, opened_by_name, target_on)
      VALUES
        (${employeeId}, ${title}, ${reason}, 'open', ${input.actorUserId},
         ${clean(input.actorName, 200) || null}, ${validDay(input.targetOn)})
      RETURNING id`));
    const planId = planRows.length ? String((planRows[0] as any).id) : null;
    if (!planId) return fail('The plan was not written: the insert returned no row.');

    // The items, in one statement. RETURNING, because "with N items" was printed on this project
    // once for a parent row that had none.
    let written = 0;
    for (let n = 0; n < items.length; n += 1) {
      const i = items[n];
      const r = rowsOf(await db.execute(sql`
        INSERT INTO hri_plan_items
          (plan_id, kind, skill_id, title, detail, signal_id, signal_snapshot, status, due_on, sort_order)
        VALUES
          (${planId}, ${i.kind}, ${i.skillId}, ${i.title}, ${i.detail}, ${i.signalId},
           ${JSON.stringify(i.snapshot)}::jsonb, 'open', ${i.dueOn}, ${n})
        RETURNING id`));
      if (r.length) written += 1;
    }

    if (written === 0) {
      // The plan exists and is empty. Say so rather than reporting a plan that was created.
      return fail('The plan row was created but none of its items were written, so it is empty. '
        + 'Plan id ' + planId + ' — check it before opening another.');
    }

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.development_plan_opened',
      entity: 'hri_development_plans',
      entityId: planId,
      diff: { employeeId, title, items: written },
    });

    return {
      ok: true,
      id: planId,
      message: 'Opened a development plan with ' + written + ' item(s). It is visible to the '
        + 'employee, and each item records the evidence it was created from as it stood today.',
      error: null,
    };
  } catch (e: any) {
    logFail('initiateDevelopmentPlan', e);
    return fail('The plan could not be opened: ' + reasonOf(e));
  }
}

// =================================================================================================
// 3. ASSIGN TRAINING  (delegated to the learning module)
// =================================================================================================

/**
 * Assign a course. THE WRITE IS performance-learning.assignCourse()'s, not this module's.
 *
 * `orgWide` is passed as the LEARNING_ASSIGN grant the access decision resolved. That module then
 * applies its own rule — self, a reporting relationship, or org-wide — and refuses in its own words
 * if none holds. Two gates, and this one cannot loosen the other.
 */
export async function assignTraining(input: {
  access: HrIntelAccess;
  viewer: PerfViewer;
  employeeId: string;
  courseId: string;
  dueOn?: string | null;
  required?: boolean;
  /** Why. Carried into the assignment so the employee sees what it was for. */
  reason: string;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'assign_training');
  if (denied) return fail(denied);

  const reason = clean(input.reason, 1000);
  if (!reason) {
    return fail('Say what this course is for. The reason appears on the employee\'s own learning '
      + 'path, and an assignment with no reason reads as busywork.');
  }

  const result = await assignCourse(input.viewer, {
    employeeId: input.employeeId,
    courseId: input.courseId,
    dueOn: input.dueOn ?? null,
    required: input.required === true,
    reason,
    // The learning module's own key, resolved by the access decision. Never the people desk key.
    orgWide: input.access.grantedActions.indexOf('assign_training') >= 0,
  });

  if (!result.ok) return fail(result.error || 'The learning module refused the assignment.');

  await logAudit({
    userId: input.actorUserId,
    action: 'hr_intel.training_assigned',
    entity: 'hr_learning_assignments',
    entityId: (result as any).id || undefined,
    diff: { employeeId: input.employeeId, courseId: input.courseId, via: 'hr-intelligence' },
  });

  return {
    ok: true,
    id: (result as any).id || null,
    message: 'Assigned through the learning module, which owns assignments. The employee sees it on '
      + 'their own learning path with the reason you gave. Assigning is not a completion: what they '
      + 'actually do is recorded separately, by them.',
    error: null,
  };
}

// =================================================================================================
// 4. SCHEDULE A REVIEW  (delegated to the training calendar)
// =================================================================================================

/**
 * Put a review on the calendar.
 *
 * IT DOES NOT OPEN AN APPRAISAL CYCLE. A cycle is an organisation-wide act belonging to whoever
 * holds `performance.manage`, and creating one from a single person's screen would start a process
 * for everybody. This schedules a session — a conversation with a date on it — through the calendar
 * that already exists.
 */
export async function scheduleReview(input: {
  access: HrIntelAccess;
  employeeId: string;
  employeeName?: string | null;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  mode?: string;
  /** Why this review is happening. Written into the session description. */
  reason: string;
  departmentId?: string | null;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'schedule_review');
  if (denied) return fail(denied);

  const reason = clean(input.reason, 1000);
  if (!reason) return fail('Say what the review is for.');

  const who = clean(input.employeeName, 200);
  const result = await createTrainingEvent({
    title: 'Review' + (who ? ' — ' + who : ''),
    description: reason,
    departmentId: input.departmentId ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    location: clean(input.location, 200) || null,
    mode: input.mode || 'online',
    capacity: null,
    actorUserId: input.actorUserId,
  });

  if (!result.ok) return fail(result.error || 'The calendar refused the session.');

  await logAudit({
    userId: input.actorUserId,
    action: 'hr_intel.review_scheduled',
    entity: 'hr_training_events',
    entityId: (result as any).id || undefined,
    diff: { employeeId: input.employeeId, startsAt: input.startsAt },
  });

  return {
    ok: true,
    id: (result as any).id || null,
    message: 'The review is on the calendar. This is a session with a date on it — it does not open '
      + 'an appraisal cycle, which is a separate act by whoever runs appraisals.',
    error: null,
  };
}

// =================================================================================================
// 5. RECORD AN INTERVENTION  (owned)
// =================================================================================================

/**
 * The kinds of support step this records. A CLOSED LIST, and every value on it is something
 * somebody DID FOR a person rather than TO them.
 *
 * There is deliberately no 'warning', no 'final_warning' and no 'performance_improvement_plan' with
 * a consequence attached: a disciplinary step is hr-flags.ts, which has an appeal path this table
 * does not and must not grow.
 */
export const INTERVENTION_KINDS = [
  'conversation',
  'coaching',
  'mentor_assigned',
  'workload_adjusted',
  'training_referral',
  'role_clarification',
  'accommodation_made',
  'peer_support',
  'check_in_scheduled',
] as const;

export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export function isInterventionKind(v: unknown): v is InterventionKind {
  return typeof v === 'string' && (INTERVENTION_KINDS as readonly string[]).indexOf(v) >= 0;
}

export function interventionKindLabel(kind: string): string {
  const k = String(kind || '');
  if (k === 'conversation') return 'A conversation';
  if (k === 'coaching') return 'Coaching';
  if (k === 'mentor_assigned') return 'A mentor was assigned';
  if (k === 'workload_adjusted') return 'Workload was adjusted';
  if (k === 'training_referral') return 'Referred to training';
  if (k === 'role_clarification') return 'The role was clarified';
  if (k === 'accommodation_made') return 'An accommodation was made';
  if (k === 'peer_support') return 'Peer support arranged';
  if (k === 'check_in_scheduled') return 'A check-in was scheduled';
  return 'A support step';
}

export async function recordIntervention(input: {
  access: HrIntelAccess;
  employeeId: string;
  kind: string;
  summary: string;
  /** What prompted it. Required, and not defaulted. */
  promptedBy: string;
  occurredOn: string;
  planId?: string | null;
  signal?: HrSignal | null;
  actorUserId: string | null;
  actorName?: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'record_intervention');
  if (denied) return fail(denied);

  const employeeId = String(input.employeeId || '');
  if (!isUuid(employeeId)) return fail('Choose who this is about.');

  if (!isInterventionKind(input.kind)) {
    return fail('Choose what kind of support step this was. The list is deliberately short and '
      + 'holds no disciplinary step: those are recorded in the flags module, which has an appeal '
      + 'path this record does not.');
  }

  const summary = clean(input.summary, 4000);
  if (!summary) return fail('Say what you did.');

  const prompted = clean(input.promptedBy, 2000);
  if (!prompted) {
    return fail('Say what prompted this. A support step nobody can trace to a cause is an act on '
      + 'somebody\'s record with no stated reason, and this table is read while decisions are being '
      + 'made about them.');
  }

  const occurredOn = validDay(input.occurredOn);
  if (!occurredOn) return fail('Give the date it happened, as YYYY-MM-DD.');

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hri_interventions
        (employee_id, kind, summary, prompted_by, signal_id, signal_snapshot, plan_id,
         recorded_by_user_id, recorded_by_name, occurred_on)
      VALUES
        (${employeeId}, ${input.kind}, ${summary}, ${prompted},
         ${input.signal ? clean(input.signal.id, 120) : null},
         ${JSON.stringify(snapshotOf(input.signal))}::jsonb,
         ${isUuid(input.planId) ? String(input.planId) : null},
         ${input.actorUserId}, ${clean(input.actorName, 200) || null}, ${occurredOn})
      RETURNING id`));
    const id = rows.length ? String((rows[0] as any).id) : null;
    if (!id) return fail('The intervention was not written: the insert returned no row.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.intervention_recorded',
      entity: 'hri_interventions',
      entityId: id,
      diff: { employeeId, kind: input.kind, occurredOn },
    });

    return {
      ok: true,
      id,
      message: 'Recorded. The outcome is a separate, later write — come back and say what followed, '
        + 'because an intervention with no outcome is shown as exactly that rather than assumed to '
        + 'have worked.',
      error: null,
    };
  } catch (e: any) {
    logFail('recordIntervention', e);
    return fail('The intervention could not be recorded: ' + reasonOf(e));
  }
}

/** What followed. A separate write, on purpose — see the schema note above the table. */
export async function recordInterventionOutcome(input: {
  access: HrIntelAccess;
  interventionId: string;
  outcome: string;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'record_intervention');
  if (denied) return fail(denied);
  if (!isUuid(input.interventionId)) return fail('Which intervention?');

  const outcome = clean(input.outcome, 4000);
  if (!outcome) return fail('Say what followed.');

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE hri_interventions
         SET outcome_note = ${outcome},
             outcome_recorded_at = NOW(),
             outcome_recorded_by_user_id = ${input.actorUserId}
       WHERE id = ${input.interventionId}
      RETURNING id, employee_id`));
    if (!rows.length) return fail('No intervention with that id was found, so nothing was written.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.intervention_outcome',
      entity: 'hri_interventions',
      entityId: input.interventionId,
      diff: { employeeId: String((rows[0] as any).employee_id) },
    });

    return { ok: true, id: input.interventionId, message: 'The outcome is on the record.', error: null };
  } catch (e: any) {
    logFail('recordInterventionOutcome', e);
    return fail('The outcome could not be recorded: ' + reasonOf(e));
  }
}

// =================================================================================================
// 6. INITIATE A ROLE MOBILITY REVIEW  (owned)
// =================================================================================================

/**
 * Open a review of one person against one open role.
 *
 * IT MOVES NOBODY. There is no transfer here, no application, no notification and no status on
 * anybody's employment record. A transfer is hr-lifecycle.ts, through the approval chain it already
 * has, started by a named human who read this.
 *
 * The coverage as it stood is snapshotted onto the row for the same reason a plan item snapshots
 * its signal: the skill matrix and the role advert will both have changed by the time anybody
 * reads the conclusion.
 */
export async function initiateMobilityReview(input: {
  access: HrIntelAccess;
  employeeId: string;
  roleId: string;
  reason: string;
  coverage?: Record<string, unknown> | null;
  actorUserId: string | null;
  actorName?: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'initiate_mobility_review');
  if (denied) return fail(denied);

  const employeeId = String(input.employeeId || '');
  if (!isUuid(employeeId)) return fail('Choose who the review is about.');
  if (!isUuid(input.roleId)) return fail('Choose the role.');

  const reason = clean(input.reason, 2000);
  if (!reason) return fail('Say why this review is being opened.');

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    // The title is snapshotted because a role advert is edited and closed, and a review that can
    // only say "role 3f2a..." is a review nobody can read.
    const roleRows = rowsOf(await db.execute(sql`
      SELECT id, title FROM roles WHERE id = ${input.roleId} LIMIT 1`));
    if (!roleRows.length) return fail('No role with that id exists, so no review was opened.');
    const roleTitle = String((roleRows[0] as any).title || 'Untitled role');

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hri_mobility_reviews
        (employee_id, role_id, role_title_snapshot, reason, coverage_snapshot, status,
         opened_by_user_id, opened_by_name)
      VALUES
        (${employeeId}, ${input.roleId}, ${roleTitle}, ${reason},
         ${JSON.stringify(input.coverage || {})}::jsonb, 'open',
         ${input.actorUserId}, ${clean(input.actorName, 200) || null})
      RETURNING id`));
    const id = rows.length ? String((rows[0] as any).id) : null;
    if (!id) return fail('The review was not opened: the insert returned no row.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.mobility_review_opened',
      entity: 'hri_mobility_reviews',
      entityId: id,
      diff: { employeeId, roleId: input.roleId, roleTitle },
    });

    return {
      ok: true,
      id,
      message: 'Opened a mobility review against "' + roleTitle + '". Nobody has been moved, '
        + 'nobody has been notified, and the review reaches no conclusion by itself — you write '
        + 'that, and a transfer remains a separate act through the approval chain that owns it.',
      error: null,
    };
  } catch (e: any) {
    logFail('initiateMobilityReview', e);
    return fail('The review could not be opened: ' + reasonOf(e));
  }
}

/** A named human's written conclusion. Free text, because a verdict enum would become a score. */
export async function concludeMobilityReview(input: {
  access: HrIntelAccess;
  reviewId: string;
  conclusion: string;
  actorUserId: string | null;
  actorName?: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'initiate_mobility_review');
  if (denied) return fail(denied);
  if (!isUuid(input.reviewId)) return fail('Which review?');

  const conclusion = clean(input.conclusion, 4000);
  if (!conclusion) return fail('Write the conclusion.');

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE hri_mobility_reviews
         SET status = 'concluded',
             conclusion = ${conclusion},
             concluded_by_user_id = ${input.actorUserId},
             concluded_by_name = ${clean(input.actorName, 200) || null},
             concluded_at = NOW()
       WHERE id = ${input.reviewId} AND status = 'open'
      RETURNING id, employee_id, role_title_snapshot`));
    if (!rows.length) {
      return fail('That review is not open, so it was not changed. A concluded review keeps what '
        + 'was written the first time.');
    }

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.mobility_review_concluded',
      entity: 'hri_mobility_reviews',
      entityId: input.reviewId,
      diff: { employeeId: String((rows[0] as any).employee_id) },
    });

    // The organisational timeline records that a named human reached a conclusion. It records the
    // ACT, not the content: hr_events is readable by more surfaces than this one.
    await emitHrEvent({
      type: 'GoalCreated',
      subject: { employeeId: String((rows[0] as any).employee_id) },
      actorUserId: input.actorUserId,
      actorKind: 'human',
      sourceModule: 'hr-intelligence/actions',
      recordRef: input.reviewId,
      payload: { what: 'mobility_review_concluded', role: String((rows[0] as any).role_title_snapshot || '') },
      assertion: 'explicitly_provided',
    });

    return { ok: true, id: input.reviewId, message: 'The conclusion is on the record.', error: null };
  } catch (e: any) {
    logFail('concludeMobilityReview', e);
    return fail('The conclusion could not be recorded: ' + reasonOf(e));
  }
}

// =================================================================================================
// PLAN MAINTENANCE
// =================================================================================================

export async function setPlanItemStatus(input: {
  access: HrIntelAccess;
  itemId: string;
  status: string;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'initiate_development_plan');
  if (denied) return fail(denied);
  if (!isUuid(input.itemId)) return fail('Which item?');

  const status = clean(input.status, 20);
  if (['open', 'in_progress', 'done', 'dropped'].indexOf(status) < 0) {
    return fail('An item is open, in progress, done or dropped.');
  }

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE hri_plan_items
         SET status = ${status},
             completed_at = CASE WHEN ${status} = 'done' THEN NOW() ELSE NULL END
       WHERE id = ${input.itemId}
      RETURNING id, plan_id`));
    if (!rows.length) return fail('No item with that id was found.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.plan_item_status',
      entity: 'hri_plan_items',
      entityId: input.itemId,
      diff: { status },
    });
    return { ok: true, id: input.itemId, message: 'The item is marked ' + status + '.', error: null };
  } catch (e: any) {
    logFail('setPlanItemStatus', e);
    return fail('The item could not be updated: ' + reasonOf(e));
  }
}

export async function closePlan(input: {
  access: HrIntelAccess;
  planId: string;
  status: string;
  note: string;
  actorUserId: string | null;
}): Promise<ActionResult> {
  const denied = guard(input.access, 'initiate_development_plan');
  if (denied) return fail(denied);
  if (!isUuid(input.planId)) return fail('Which plan?');

  const status = clean(input.status, 20);
  if (status !== 'completed' && status !== 'closed') {
    return fail('A plan is completed or closed. "Closed" is the honest word when it stopped without '
      + 'being finished, and it is worth using.');
  }

  const note = clean(input.note, 4000);
  if (!note) {
    return fail('Write what happened. A plan that ends with no note is one nobody can learn from.');
  }

  const blocked = await schemaReady();
  if (blocked) return fail(blocked);

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE hri_development_plans
         SET status = ${status}, closed_at = NOW(),
             closed_by_user_id = ${input.actorUserId}, closed_note = ${note}
       WHERE id = ${input.planId} AND status IN ('open', 'active')
      RETURNING id, employee_id`));
    if (!rows.length) return fail('That plan is not open, so it was not changed.');

    await logAudit({
      userId: input.actorUserId,
      action: 'hr_intel.plan_closed',
      entity: 'hri_development_plans',
      entityId: input.planId,
      diff: { status },
    });
    return { ok: true, id: input.planId, message: 'The plan is marked ' + status + '.', error: null };
  } catch (e: any) {
    logFail('closePlan', e);
    return fail('The plan could not be closed: ' + reasonOf(e));
  }
}

export { LEARNING_ASSIGN };
