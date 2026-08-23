// src/lib/manager-intelligence/write.ts — THE FIVE THINGS A MANAGER MAY DO FROM THIS SCREEN.
//
// =================================================================================================
// EVERY WRITE HERE GOES THROUGH THE SAME FOUR STEPS, IN THIS ORDER
// =================================================================================================
//
//   1. AUTHORISE. authorityBasisFor() resolves how this manager holds authority over this person,
//      from the organization graph, at this moment. A null basis is a refusal — never a blank label
//      on a row that was written anyway.
//   2. WRITE THE THING WHERE IT BELONGS. Feedback goes to hr_feedback through performance.ts's
//      giveFeedback(). An HR referral goes to helpdesk_tickets through helpdesk.ts's createTicket(),
//      which routes it to a desk owner and starts an SLA. This module writes NEITHER table itself.
//   3. RECORD THE ACT in mti_manager_actions, with the signal snapshot the manager was looking at
//      and a pointer to the row from step 2. Append-only.
//   4. PUBLISH the envelope to the central employee intelligence record, through the durable outbox
//      in record-port.ts. Queued even with no consumer registered, so nothing is lost.
//
// STEP 2 CAN SUCCEED WHILE STEP 3 FAILS, AND THE CALLER IS TOLD. A result carries `recorded` and
// `published` separately, and the sentence names which half did not happen. The alternative —
// reporting success because the first insert worked — is the exact shape of failure this project has
// already shipped twice, and it is how a manager comes to believe HR was told something HR never was.
//
// NO EXCEPTION IS SWALLOWED. Every catch logs the real Postgres reason off `e.cause` (`e.message` is
// only the failed SQL) and returns a sentence a person can read.
//
// AND NOTHING IN HERE DECIDES ANYTHING. There is no status on anybody's employment record that this
// module can set, no call into promotions, separations, probation or flags, and no automatic
// escalation. A manager writes what they observed and what they intend to do; a human reads it.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { giveFeedback } from '@/lib/performance';
import { createTicket } from '@/lib/helpdesk';
import { canSeePerformanceOf, isUuid, logFail, rowsOf, type PerfViewer } from '@/lib/performance-scope';
import { authorityBasisFor } from './read';
import { publishToRecord } from './record-port';
import { readyState } from './schema';
import {
  isManagerActionKind,
  isSectionKey,
  type ManagerActionKind,
  type ManagerSignal,
  type RecordEnvelope,
  type SectionKey,
} from './types';

const MOD = 'manager-intelligence/write';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — every one declared above the writers that read them.
// -------------------------------------------------------------------------------------------------

const NOTE_MAX = 4000;
const TITLE_MAX = 200;
const MIN_NOTE_CHARS = 10;

export const DEVELOPMENT_STATUSES = ['open', 'in_progress', 'done', 'dropped'] as const;
export type DevelopmentStatus = (typeof DEVELOPMENT_STATUSES)[number];

export function isDevelopmentStatus(v: unknown): v is DevelopmentStatus {
  return typeof v === 'string' && (DEVELOPMENT_STATUSES as readonly string[]).indexOf(v) >= 0;
}

const NOT_AUTHORISED =
  'You do not hold a recorded relationship to this person, so nothing was written. If that is wrong, '
  + 'the reporting line has not been recorded in the Organization Graph.';

const WRITE_FAILED =
  'We could not record that just now, and nothing was saved. This is a failure to write, not a refusal.';

const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+$/, '').trim().slice(0, max);

/**
 * The part of a signal worth keeping forever.
 *
 * The whole envelope, minus nothing — inputs, processing, output, evidence, confidence and the
 * instant. It is STORED rather than recomputed because the numbers move: six months later, "why did
 * my manager record this" has to be answerable against what they were actually looking at, not
 * against what the task board says today.
 */
function snapshotOf(signal: ManagerSignal | null): Record<string, unknown> {
  if (!signal) return {};
  return {
    key: signal.key,
    section: signal.section,
    headline: signal.headline,
    direction: signal.direction,
    evidenceStrength: signal.evidenceStrength,
    inputs: signal.inputs,
    processing: signal.processing,
    output: signal.output,
    evidence: signal.evidence,
    confidence: signal.confidence,
    confidenceBasis: signal.confidenceBasis,
    observedFrom: signal.observedFrom,
    observedTo: signal.observedTo,
    computedAt: signal.computedAt,
  };
}

export interface ActorIdentity {
  userId: string;
  employeeId: string | null;
  fullName: string | null;
}

export function actorFrom(viewer: PerfViewer): ActorIdentity {
  return { userId: viewer.userId, employeeId: viewer.employeeId, fullName: viewer.fullName };
}

export interface WriteResult {
  ok: boolean;
  /** The act reached mti_manager_actions. */
  recorded: boolean;
  /** The envelope reached the outbox for the central employee record. */
  published: boolean;
  /** The row in the owning module, when there is one: an hr_feedback id, a ticket reference. */
  recordRef?: string | null;
  actionId?: string | null;
  /** A sentence for the screen. Empty only when everything worked. */
  note: string;
  error?: string;
}

const okResult = (actionId: string | null, published: boolean, recordRef: string | null, note: string): WriteResult =>
  ({ ok: true, recorded: !!actionId, published, recordRef, actionId, note });

const failResult = (error: string): WriteResult =>
  ({ ok: false, recorded: false, published: false, note: error, error });

// -------------------------------------------------------------------------------------------------
// THE ACT LOG, AND THE PUBLISH THAT FOLLOWS IT
// -------------------------------------------------------------------------------------------------

interface ActInput {
  subjectEmployeeId: string;
  actor: ActorIdentity;
  kind: ManagerActionKind;
  section: SectionKey | null;
  signal: ManagerSignal | null;
  recordRef: string | null;
  note: string | null;
  authorityBasis: string;
}

interface ActOutcome {
  actionId: string | null;
  published: boolean;
  note: string;
}

/**
 * Append one act, then queue it for the central record.
 *
 * Returns rather than throws. Every caller has already written the real thing by the time this runs,
 * and losing somebody's feedback because the log insert failed would be a worse outcome than a log
 * entry that is missing and said to be missing.
 */
async function recordAct(input: ActInput): Promise<ActOutcome> {
  let actionId: string | null = null;
  try {
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO mti_manager_actions
        (subject_employee_id, actor_user_id, actor_employee_id, kind, section, signal_key,
         signal_snapshot, record_ref, note, authority_basis)
      VALUES
        (${input.subjectEmployeeId}::uuid, ${input.actor.userId}::uuid,
         ${input.actor.employeeId}::uuid, ${input.kind}, ${input.section}, ${input.signal ? input.signal.key : null},
         ${JSON.stringify(snapshotOf(input.signal))}::jsonb, ${input.recordRef}, ${input.note},
         ${input.authorityBasis})
      RETURNING id, created_at`));
    if (ins.length) actionId = String(ins[0].id);
  } catch (e: any) {
    logFail(MOD, 'recordAct', e);
    return {
      actionId: null,
      published: false,
      note: 'The action itself was saved, but it could not be added to this person’s manager record. '
        + 'It will not appear on their timeline until it is re-recorded.',
    };
  }

  if (!actionId) {
    return { actionId: null, published: false, note: 'The action was saved but not logged to the manager record.' };
  }

  const envelope: RecordEnvelope = {
    actionId,
    subjectEmployeeId: input.subjectEmployeeId,
    actorUserId: input.actor.userId,
    actorEmployeeId: input.actor.employeeId,
    kind: input.kind,
    signalKey: input.signal ? input.signal.key : null,
    section: input.section,
    recordRef: input.recordRef,
    authorityBasis: input.authorityBasis,
    occurredAt: new Date().toISOString(),
  };

  const pub = await publishToRecord(envelope);
  return { actionId, published: pub.delivered, note: pub.note };
}

/**
 * The gate every writer opens with.
 *
 * Resolves the authority basis AND checks the schema exists, because a write against a missing table
 * should say "this has not been created yet" rather than surface a Postgres error, and a manager
 * with no relationship should be told that rather than shown a database problem.
 */
async function gate(
  viewer: PerfViewer,
  subjectEmployeeId: string,
): Promise<{ ok: true; basis: string } | { ok: false; error: string }> {
  if (!isUuid(subjectEmployeeId)) return { ok: false, error: 'No such team member.' };
  if (!isUuid(viewer.userId)) return { ok: false, error: 'Sign in to record this.' };
  if (viewer.employeeId && viewer.employeeId === subjectEmployeeId) {
    return { ok: false, error: 'This screen is for the people you manage. Use your own record for yourself.' };
  }
  const state = await readyState();
  if (!state.ok) return { ok: false, error: state.sentence };
  if (!(await canSeePerformanceOf(viewer, subjectEmployeeId))) return { ok: false, error: NOT_AUTHORISED };
  const basis = await authorityBasisFor(viewer, subjectEmployeeId);
  if (!basis) return { ok: false, error: NOT_AUTHORISED };
  return { ok: true, basis };
}

// -------------------------------------------------------------------------------------------------
// 1. STRUCTURED FEEDBACK
// -------------------------------------------------------------------------------------------------

export const FEEDBACK_THEMES_ALLOWED = ['general', 'strength', 'improvement'] as const;

export interface FeedbackInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  body: string;
  /** general | strength | improvement — the vocabulary hr_feedback already uses. */
  theme?: string;
  /** The signal this note answers, when the manager wrote it from one. */
  signal?: ManagerSignal | null;
}

/**
 * Write feedback for a team member.
 *
 * THE WORDS GO TO hr_feedback, THROUGH giveFeedback(). That module owns the table, sends the person
 * their notification, and enforces the rule that matters most here: feedback on this platform is
 * never anonymous. What this module adds is the STRUCTURE — which signal the note answers and which
 * section it came from — recorded beside it rather than inside it.
 *
 * A SECOND FEEDBACK TABLE WAS THE OBVIOUS WRONG MOVE. It would have meant two places a person has to
 * look for what was said about them, and one of them invisible from their own portal.
 */
export async function recordFeedback(input: FeedbackInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);

  const body = clean(input.body, NOTE_MAX);
  if (body.length < MIN_NOTE_CHARS) {
    return failResult('Write the feedback before sending it. A few words is not feedback somebody can act on.');
  }
  const theme = (FEEDBACK_THEMES_ALLOWED as readonly string[]).indexOf(String(input.theme || 'general')) >= 0
    ? String(input.theme || 'general')
    : 'general';

  const written = await giveFeedback({
    subjectEmployeeId: input.subjectEmployeeId,
    authorUserId: input.viewer.userId,
    authorEmployeeId: input.viewer.employeeId,
    authorName: input.viewer.fullName,
    body,
    theme,
  });
  if (!written.ok) return failResult(written.error || WRITE_FAILED);

  const recordRef = 'performance:hr_feedback:' + String(written.id || '');
  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'structured_feedback',
    section: input.signal ? input.signal.section : 'feedback',
    signal: input.signal || null,
    recordRef,
    // THE WORDS ARE NOT COPIED HERE. They are in hr_feedback, where the person can read them.
    note: null,
    authorityBasis: g.basis,
  });

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.feedback',
    entity: 'mti_manager_actions',
    entityId: act.actionId || undefined,
    diff: { subjectEmployeeId: input.subjectEmployeeId, theme, signalKey: input.signal?.key || null, basis: g.basis },
  });

  // THE ONE EVENT PATCH 14 EMITS, on HORIZON's own bus. Imported lazily so that write.ts — and
  // everything that imports it — does not pull src/lib/horizon in at module load. It carries the
  // feedback id and the module that owns the words, never the words. Failure is announced in the
  // bridge's own log and costs the caller nothing: the note is already written.
  try {
    const { emitFeedbackSubmitted } = await import('./horizon-bridge');
    await emitFeedbackSubmitted({
      feedbackId: String(written.id || ''),
      subjectEmployeeId: input.subjectEmployeeId,
      actorUserId: input.viewer.userId,
      actorName: input.viewer.fullName,
      dimensionKey: input.signal ? input.signal.key : 'general',
      relationship: g.basis,
      submittedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[' + MOD + '] feedback event', e?.cause?.message || e?.message || e);
  }

  return okResult(act.actionId, act.published, recordRef, act.note);
}

// -------------------------------------------------------------------------------------------------
// 2. ACKNOWLEDGING A SIGNAL
// -------------------------------------------------------------------------------------------------

export interface AcknowledgeInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  signal: ManagerSignal;
  /** Optional. What the manager makes of it — "already discussed", "dates were mine, not theirs". */
  note?: string;
}

/**
 * "I have seen this, and here is what I make of it."
 *
 * THIS IS THE HUMAN-IN-THE-LOOP STEP, AND IT IS THE POINT OF THE WHOLE PATCH. A signal is arithmetic
 * over work records. An acknowledgement is a named human saying what the arithmetic actually meant,
 * and it is recorded at a HIGHER evidence strength than the signal it answers, because a manager who
 * says "those dates were mine, not theirs" knows something the query cannot.
 *
 * ACKNOWLEDGING DOES NOT DISMISS. The signal keeps rendering; it simply renders as answered, with
 * the answer beside it. A control that made an inconvenient number disappear would be a control for
 * hiding things from the next manager.
 */
export async function acknowledgeSignal(input: AcknowledgeInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);
  if (!input.signal || !input.signal.key) return failResult('Nothing to acknowledge.');

  const note = clean(input.note, NOTE_MAX) || null;
  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'signal_acknowledged',
    section: input.signal.section,
    signal: input.signal,
    recordRef: null,
    note,
    authorityBasis: g.basis,
  });
  if (!act.actionId) return failResult(act.note || WRITE_FAILED);

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.acknowledge',
    entity: 'mti_manager_actions',
    entityId: act.actionId,
    diff: { subjectEmployeeId: input.subjectEmployeeId, signalKey: input.signal.key, basis: g.basis },
  });

  return okResult(act.actionId, act.published, null, act.note);
}

// -------------------------------------------------------------------------------------------------
// 3. RECORDING AN INTERVENTION
// -------------------------------------------------------------------------------------------------

export interface InterventionInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  /** What the manager did. "Reassigned two urgent tasks", "agreed the next three due dates together". */
  note: string;
  signal?: ManagerSignal | null;
  section?: string | null;
}

/**
 * What the manager actually did about it.
 *
 * An intervention is a management ACT, not a finding: rebalancing work, moving a date, arranging
 * cover, sitting down with somebody. It is recorded so that six months later the record shows a
 * manager who noticed and acted, rather than a list of numbers with nothing beside them — which is
 * how a person ends up defending a pattern nobody ever told them about.
 */
export async function recordIntervention(input: InterventionInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);

  const note = clean(input.note, NOTE_MAX);
  if (note.length < MIN_NOTE_CHARS) {
    return failResult('Say what you did, in a sentence. An intervention nobody can read is not a record.');
  }
  const section: SectionKey | null = input.signal
    ? input.signal.section
    : (isSectionKey(input.section) ? input.section : null);

  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'intervention_recorded',
    section,
    signal: input.signal || null,
    recordRef: null,
    note,
    authorityBasis: g.basis,
  });
  if (!act.actionId) return failResult(act.note || WRITE_FAILED);

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.intervention',
    entity: 'mti_manager_actions',
    entityId: act.actionId,
    diff: { subjectEmployeeId: input.subjectEmployeeId, signalKey: input.signal?.key || null, basis: g.basis },
  });

  return okResult(act.actionId, act.published, null, act.note);
}

// -------------------------------------------------------------------------------------------------
// 4. REQUESTING HR SUPPORT
// -------------------------------------------------------------------------------------------------

export interface HrSupportInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  subject: string;
  body: string;
  priority?: string;
  signal?: ManagerSignal | null;
}

/**
 * Ask HR for help with something on this screen.
 *
 * IT RAISES A REAL TICKET, on helpdesk.ts's `hr` desk, which routes it to a named owner and starts
 * an SLA clock. A private note to HR that lives only in this module would be a support request with
 * nobody assigned to it and no way for HR to see their queue.
 *
 * THE SUBJECT'S NAME IS IN THE TICKET AND THAT IS DELIBERATE — HR cannot help with an anonymous
 * concern about an unnamed person. What is NOT in it is the manager's raw signal set: the ticket
 * carries what the manager chose to write, and the act row beside it carries the signal snapshot for
 * the audit trail. A referral that silently forwarded a page of derived numbers about somebody would
 * be a profile crossing a desk without its subject ever knowing.
 */
export async function requestHrSupport(input: HrSupportInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);

  const subject = clean(input.subject, TITLE_MAX);
  const body = clean(input.body, NOTE_MAX);
  if (!subject) return failResult('Give the request a one-line subject so the desk can triage it.');
  if (body.length < MIN_NOTE_CHARS) {
    return failResult('Describe what you need from HR. A subject alone is not enough to act on.');
  }

  const ticket = await createTicket({
    category: 'hr',
    subject,
    body,
    priority: input.priority || 'normal',
    requesterUserId: input.viewer.userId,
    requesterEmployeeId: input.viewer.employeeId,
  });
  if (!ticket.ok) return failResult(ticket.error || WRITE_FAILED);

  const recordRef = 'helpdesk:helpdesk_tickets:' + String(ticket.id || '');
  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'hr_support_requested',
    section: input.signal ? input.signal.section : null,
    signal: input.signal || null,
    recordRef,
    note: subject,
    authorityBasis: g.basis,
  });

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.hr_support',
    entity: 'mti_manager_actions',
    entityId: act.actionId || undefined,
    diff: { subjectEmployeeId: input.subjectEmployeeId, ticketId: ticket.id || null, basis: g.basis },
  });

  const routeNote = ticket.routeNote
    ? ' The desk could not be routed automatically: ' + ticket.routeNote
    : '';
  return okResult(
    act.actionId,
    act.published,
    recordRef,
    (act.note || '') + routeNote,
  );
}

// -------------------------------------------------------------------------------------------------
// 5. TRACKED DEVELOPMENT ACTIONS
// -------------------------------------------------------------------------------------------------

export interface DevelopmentActionInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  title: string;
  detail?: string;
  /** YYYY-MM-DD. Optional — a development action without a date is still a development action. */
  targetDate?: string | null;
  /**
   * Default TRUE, and the default is the position this product takes: a development action about
   * somebody that they cannot see is a file being kept on them. The flag exists for the narrow case
   * of a manager's own preparation note, and the screen says plainly which one they are writing.
   */
  visibleToEmployee?: boolean;
  signal?: ManagerSignal | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Start tracking a development action for a team member. */
export async function createDevelopmentAction(input: DevelopmentActionInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);

  const title = clean(input.title, TITLE_MAX);
  if (title.length < MIN_NOTE_CHARS) {
    return failResult('Name the development action in a sentence somebody could act on.');
  }
  const detail = clean(input.detail, NOTE_MAX) || null;
  const targetDate = input.targetDate && DATE_RE.test(String(input.targetDate)) ? String(input.targetDate) : null;
  const visible = input.visibleToEmployee !== false;

  let id: string | null = null;
  try {
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO mti_development_actions
        (subject_employee_id, created_by_user_id, title, detail, target_date, visible_to_employee)
      VALUES
        (${input.subjectEmployeeId}::uuid, ${input.viewer.userId}::uuid, ${title}, ${detail},
         ${targetDate}::date, ${visible})
      RETURNING id`));
    if (ins.length) id = String(ins[0].id);
  } catch (e: any) {
    logFail(MOD, 'createDevelopmentAction', e);
    return failResult(String(e?.cause?.message || e?.message || WRITE_FAILED).slice(0, 400));
  }
  if (!id) return failResult(WRITE_FAILED);

  const recordRef = 'manager-intelligence:mti_development_actions:' + id;
  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'development_action',
    section: input.signal ? input.signal.section : 'development_areas',
    signal: input.signal || null,
    recordRef,
    note: 'Opened: ' + title,
    authorityBasis: g.basis,
  });

  // Link the tracked item back to the act that opened it, so the trail runs both ways.
  if (act.actionId) {
    try {
      await db.execute(sql`
        UPDATE mti_development_actions SET action_id = ${act.actionId}::uuid WHERE id = ${id}::uuid`);
    } catch (e: any) {
      logFail(MOD, 'link development action', e);
    }
  }

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.development.open',
    entity: 'mti_development_actions',
    entityId: id,
    diff: { subjectEmployeeId: input.subjectEmployeeId, visibleToEmployee: visible, basis: g.basis },
  });

  return okResult(act.actionId, act.published, recordRef, act.note);
}

export interface DevelopmentUpdateInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  developmentActionId: string;
  status: string;
  outcomeNote?: string;
}

/**
 * Move a development action along.
 *
 * THE ITEM'S STATUS CHANGES; THE TRAIL DOES NOT. Every move appends a fresh mti_manager_actions row,
 * so "this was closed as done three days after it was opened, with no note" stays visible even
 * though the item itself now reads Done.
 *
 * CLOSING ONE DECIDES NOTHING. There is no outcome here that feeds a rating, a probation state or a
 * promotion. A development action is a thing a manager and a person agreed to try.
 */
export async function updateDevelopmentAction(input: DevelopmentUpdateInput): Promise<WriteResult> {
  const g = await gate(input.viewer, input.subjectEmployeeId);
  if (!g.ok) return failResult(g.error);
  if (!isUuid(input.developmentActionId)) return failResult('No such development action.');
  if (!isDevelopmentStatus(input.status)) return failResult('That is not a status this can be moved to.');

  const outcome = clean(input.outcomeNote, NOTE_MAX) || null;
  const closing = input.status === 'done' || input.status === 'dropped';
  if (input.status === 'dropped' && !outcome) {
    return failResult('Say why it is being dropped. A dropped action with no reason tells the next '
      + 'manager nothing, and tells the person even less.');
  }

  let title = '';
  try {
    // Scoped by SUBJECT as well as by id, so an id from another team cannot be moved by guessing it.
    const upd = rowsOf(await db.execute(sql`
      UPDATE mti_development_actions
         SET status = ${input.status},
             outcome_note = COALESCE(${outcome}, outcome_note),
             closed_at = ${closing ? sql`NOW()` : sql`NULL`},
             updated_at = NOW()
       WHERE id = ${input.developmentActionId}::uuid
         AND subject_employee_id = ${input.subjectEmployeeId}::uuid
      RETURNING title`));
    if (!upd.length) return failResult('That development action is not on this person’s record.');
    title = String(upd[0].title || '');
  } catch (e: any) {
    logFail(MOD, 'updateDevelopmentAction', e);
    return failResult(String(e?.cause?.message || e?.message || WRITE_FAILED).slice(0, 400));
  }

  const act = await recordAct({
    subjectEmployeeId: input.subjectEmployeeId,
    actor: actorFrom(input.viewer),
    kind: 'development_action',
    section: 'development_areas',
    signal: null,
    recordRef: 'manager-intelligence:mti_development_actions:' + input.developmentActionId,
    note: 'Moved to ' + input.status + ': ' + title + (outcome ? ' — ' + outcome : ''),
    authorityBasis: g.basis,
  });

  await logAudit({
    userId: input.viewer.userId,
    action: 'manager_intelligence.development.move',
    entity: 'mti_development_actions',
    entityId: input.developmentActionId,
    diff: { subjectEmployeeId: input.subjectEmployeeId, status: input.status, basis: g.basis },
  });

  return okResult(act.actionId, act.published, null, act.note);
}

/** Kinds a form may post. Guards the dispatch in the page against an invented value. */
export function isPostableKind(v: unknown): v is ManagerActionKind {
  return isManagerActionKind(v);
}
