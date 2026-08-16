// src/lib/mailplatform/store.ts — THE PERSISTENCE PORT. Types and one interface. No SQL here.
//
// The engine talks to this interface and nothing else. There are two implementations:
//
//   pg-store.ts      Postgres. What production runs.
//   memory-store.ts  A faithful in-process copy, used by the tests.
//
// WHY A PORT RATHER THAN THE ENGINE CALLING db.execute DIRECTLY. The behaviours this engine is
// actually judged on — a worker crashing mid-step, a duplicate event, a database restart, a run
// resumed by a different process — are all about what happens between two writes. Tested against a
// real database they need a real database, which CLAUDE.md forbids this repository's agents from
// touching; tested against this interface they are ordinary deterministic tests that pin the exact
// orderings that matter. The Postgres implementation then has one job: make each method atomic.
//
// WHICH TABLES THIS OWNS, AND WHICH IT ONLY VISITS
//
//   OWNED (created by this engine)      mail_automation_events, mail_automation_steps,
//                                       mail_automation_versions
//   EXTENDED (columns added additively) mail_automations, mail_automation_runs
//   VISITED (owned by mail-product)     mail_contacts, mail_lists, mail_list_members, mail_templates
//
// The audience tables are NOT redefined here. src/lib/mail-product/schema.ts owns them, and
// `CREATE TABLE IF NOT EXISTS` is SILENT when a table already exists with a different shape — a
// second definition would appear to work, do nothing, and leave every query in this file reading
// columns that are not there.
import type { AutomationGraph } from './graph';
import type { FailureKind } from './errors';
import type { IncomingEvent } from './triggers';

/**
 * The six run states from the specification, spelled lower case because that is what
 * `mail_automation_runs.status` already defaults to and what every other queue in this codebase
 * uses. A column whose DEFAULT disagrees with every value written into it is a trap for the next
 * person reading it.
 */
export type RunState = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'paused';
export const RUN_STATES: readonly RunState[] = ['running', 'waiting', 'completed', 'failed', 'cancelled', 'paused'];

/** A run in one of these will never move again on its own. */
export const TERMINAL_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

/** The statuses mail_automations already uses, plus archived. */
export type AutomationStatus = 'draft' | 'active' | 'paused' | 'archived';

/**
 * One row of `mail_automations`, as the engine needs it.
 *
 * `graph` is the canvas's own AutomationGraph — this engine never stores a second shape.
 */
export interface AutomationRecord {
  id: string;
  /** Present so a second workspace cannot read the first's automations. Added additively; this
   *  installation runs one, and the filter exists so that stays true by construction. */
  orgId: string;
  name: string;
  description: string;
  status: AutomationStatus;
  /** Bumped on every graph change. A run records the version it started on and keeps it. */
  version: number;
  graph: AutomationGraph;
  /** Present only when this automation accepts an external webhook. Null closes that door. */
  webhookToken: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunRecord {
  runId: string;
  automationId: string;
  /** The graph version this run started under. See engine.ts on why it is not re-read. */
  graphVersion: number;
  orgId: string;
  contactId: string | null;
  /** The node that will run NEXT. While waiting this is the step the wait is for, which is what an
   *  operator wants to read on the runs list. */
  currentNode: string | null;
  state: RunState;
  waitUntil: Date | null;
  /** Frozen trigger facts plus anything the steps recorded. Never the live contact — see engine.ts. */
  context: Record<string, unknown>;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  /** The last failure reason, or — when errorKind is 'business' — why the run ended early. */
  error: string | null;
  errorKind: FailureKind | null;
  retryCount: number;
  /** Set when a run stopped in a way that needs a person. 'failed' + deadLetter is the dead letter. */
  deadLetter: boolean;
  triggerEventId: string | null;
}

export type StepStatus = 'running' | 'done' | 'failed' | 'needs_review';

export interface StepRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  status: StepStatus;
  claimedAt: Date;
  finishedAt: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  /** What the outside world called the effect — a message id, a webhook request id. The evidence
   *  that an irreversible action actually happened. */
  externalRef: string | null;
}

export type ClaimOutcome =
  /** This worker owns the step and must execute it. */
  | { outcome: 'claimed'; step: StepRecord }
  /** It already ran to completion. Skip the effect, use the recorded result, move on. */
  | { outcome: 'already_done'; step: StepRecord }
  /** Another worker holds it right now. Leave the run alone; it is not stuck. */
  | { outcome: 'in_flight'; step: StepRecord }
  /** Claimed, never finished, past the stale window, and repeating it is not safe. A person decides. */
  | { outcome: 'needs_review'; step: StepRecord };

export interface EventRecord {
  eventId: string;
  orgId: string;
  type: string;
  contactId: string | null;
  payload: Record<string, unknown>;
  source: IncomingEvent['source'];
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
  /** How many runs this event started. Zero is a normal, common answer. */
  startedRuns: number;
  error: string | null;
}

/**
 * One row of `mail_contacts`, as the engine needs it.
 *
 * `status` is that table's own vocabulary — subscribed / unsubscribed / bounced / complained /
 * pending. There is no boolean here: "may we mail this person" is derived from it in one place
 * (`mayReceive` below) so the answer cannot be spelled two ways in two actions.
 */
export interface ContactRecord {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  phone: string | null;
  roleTitle: string | null;
  status: string;
  /** The `fields` jsonb. Custom values, including application_stage and application_number. */
  fields: Record<string, unknown>;
  /** The `tags` text[] column. */
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** The one place "may we send to this person" is decided. Suppression is checked separately and
 *  additionally, because a suppression outlives the contact row it came from. */
export function mayReceive(c: ContactRecord | null): boolean {
  return !!c && !!c.email && c.status === 'subscribed';
}

/** Application stage and number live in `fields`, because mail_contacts has no column for them. */
export function stageOf(c: ContactRecord | null): string {
  return String(c?.fields?.application_stage ?? c?.fields?.stage ?? '');
}
export function applicationNumberOf(c: ContactRecord | null): string {
  return String(c?.fields?.application_number ?? '');
}

export interface ListRecord { id: string; key: string; name: string }

export interface ListRunsFilter {
  automationId?: string;
  contactId?: string;
  state?: RunState;
  deadLetterOnly?: boolean;
  limit?: number;
}

/**
 * Everything the engine needs from storage. Each method must be atomic in its own right; the engine
 * never wraps two of them in a transaction, because on a serverless runtime it cannot hold one open
 * across an SMTP call.
 */
export interface AutomationStore {
  // ---- automations ----
  getAutomation(orgId: string, id: string): Promise<AutomationRecord | null>;
  /** A webhook token is a credential, so it is looked up on its own and the organisation comes from
   *  the ROW — never from the caller, who would otherwise choose which workspace their events land in. */
  getAutomationByWebhookToken(token: string): Promise<AutomationRecord | null>;
  listAutomations(orgId: string, opts?: { status?: AutomationStatus; limit?: number }): Promise<AutomationRecord[]>;
  /**
   * Every ACTIVE automation. The router then matches the trigger node in code.
   *
   * NOT an indexed lookup on a denormalised trigger column, deliberately: the canvas at
   * /mail/automations writes `graph` through its own saveAutomation() and would not know to keep
   * such a column in step, so it would go stale and the router would silently stop starting runs.
   * Active automations number in the tens; reading them and matching in code is always correct.
   */
  activeAutomations(orgId: string): Promise<AutomationRecord[]>;
  /** Bump the version and keep the graph as it stands. See saveGraphVersion. */
  setVersion(orgId: string, id: string, version: number): Promise<void>;
  /**
   * Keep the graph as it stood at `version`, for ever.
   *
   * A run executes the shape it started on. Without a snapshot, editing a live automation silently
   * re-points every waiting run: delete a node and a run parked at position three resumes into
   * whatever now sits there. A snapshot costs a few kilobytes per EDIT, not per run.
   */
  saveGraphVersion(orgId: string, automationId: string, version: number, graph: AutomationGraph): Promise<void>;
  /** Null when no snapshot was kept — the engine then says so and follows the live graph. */
  getGraphVersion(orgId: string, automationId: string, version: number): Promise<AutomationGraph | null>;

  // ---- events ----
  /** Idempotent on eventId. `stored:false` means this exact event was already accepted — the second
   *  delivery must do nothing at all, not "probably nothing". */
  recordEvent(e: IncomingEvent): Promise<{ stored: boolean; record: EventRecord }>;
  markEventProcessed(eventId: string, startedRuns: number, error?: string | null): Promise<void>;
  listEvents(orgId: string, opts?: { type?: string; limit?: number }): Promise<EventRecord[]>;

  // ---- runs ----
  /** Idempotent on (automationId, triggerEventId): one event starts at most one run per automation,
   *  whatever the delivery count. `created:false` is the duplicate being refused. */
  createRun(r: RunRecord): Promise<{ created: boolean; run: RunRecord }>;
  getRun(orgId: string, runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord | null>;
  listRuns(orgId: string, f?: ListRunsFilter): Promise<RunRecord[]>;
  /**
   * Atomically take ownership of runs that are due: waiting with wait_until past, and running rows
   * abandoned by a worker that died. Selecting and then updating in two statements lets two
   * overlapping ticks pick up the same run and execute the same node twice.
   */
  claimDueRuns(now: Date, limit: number, staleMs: number): Promise<RunRecord[]>;
  countRuns(orgId: string): Promise<Record<RunState, number>>;

  // ---- steps: the idempotency ledger ----
  claimStep(runId: string, nodeId: string, opts: { reclaimStale: boolean; staleMs: number; now: Date }): Promise<ClaimOutcome>;
  finishStep(runId: string, nodeId: string, status: StepStatus, patch: { result?: Record<string, unknown> | null; error?: string | null; externalRef?: string | null }): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;
  /**
   * Make a stopped step claimable again. The ONLY caller is an operator retrying a dead-lettered run
   * — the engine never does this to itself, because a step parked in needs_review is parked precisely
   * because the engine could not tell whether repeating it would send a second message. A step
   * already 'done' is left alone: retrying a run must not repeat a step that finished.
   */
  resetStep(runId: string, nodeId: string): Promise<boolean>;

  // ---- audience (mail-product's tables; read and written, never created here) ----
  getContact(contactId: string): Promise<ContactRecord | null>;
  findContactByEmail(email: string): Promise<ContactRecord | null>;
  upsertContact(c: { email: string; firstName?: string | null; lastName?: string | null; organization?: string | null; phone?: string | null; roleTitle?: string | null; fields?: Record<string, unknown> }): Promise<ContactRecord>;
  updateContactFields(contactId: string, fields: Record<string, unknown>): Promise<ContactRecord | null>;
  /** Returns whether anything changed, so an action reports "already had that tag" honestly and no
   *  tag.added event is emitted for a tag that was already there. */
  addTag(contactId: string, tag: string): Promise<boolean>;
  removeTag(contactId: string, tag: string): Promise<boolean>;
  addToList(contactId: string, listKey: string): Promise<boolean>;
  removeFromList(contactId: string, listKey: string): Promise<boolean>;
  getList(listKey: string): Promise<ListRecord | null>;
  /** The audience a scheduled trigger fires for. Capped at the call site, never open. */
  listContacts(opts: { listKey?: string; tag?: string; limit: number }): Promise<ContactRecord[]>;
  /** Address-level suppression (mail_suppression), which outlives the contact row. */
  isSuppressed(email: string): Promise<boolean>;
  setStatus(contactId: string, status: string): Promise<boolean>;
  /** The subject and bodies of a template from mail_templates, or null. */
  getTemplate(templateId: string): Promise<{ id: string; name: string; subject: string; html: string; text: string } | null>;
}

/** Normalises a tag once, in one place: trimmed, lower case, never empty. Two spellings of one tag
 *  is two tags, and a trigger listening for "shortlisted" never fires on "Shortlisted ". */
export function normalizeTag(tag: string): string {
  return String(tag || '').trim().toLowerCase().slice(0, 60);
}
export function normalizeKey(key: string): string {
  return String(key || '').trim().toLowerCase().slice(0, 64);
}
export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase().slice(0, 255);
}
