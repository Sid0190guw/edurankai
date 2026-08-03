// src/lib/workflow.ts — LAYER 3: HOW WORK MOVES. Routing from Layer 1, authorization from Layer 2.
//
// =================================================================================================
// THE PERMANENT THREE-LAYER RULE, AND THE TWO QUESTIONS THIS FILE ASKS IN ORDER
// =================================================================================================
//
//   Layer 1  ORGANIZATION   who is responsible for whom   -> src/lib/org-graph.ts. Per ROW.
//   Layer 2  AUTHORIZATION  what a user may do            -> src/lib/auth/permissions.ts. Per USER.
//   Layer 3  WORKFLOW       how work moves                -> THIS FILE.
//
// Every approval in here is decided by asking TWO SEPARATE QUESTIONS, in this order, of two
// different systems:
//
//   1. ROUTING — "who approves THIS request, for THIS person, right now?"  Answered by the org
//      graph, per row, from relationships. Never from a role name, never from a capability.
//   2. AUTHORIZATION — "may this signed-in user approve at all?"  Answered by capabilities and by
//      the routing answer from step 1. Never by this file inventing a grant.
//
// ONE ANSWER MUST NEVER SERVE BOTH. If routing decided authorization, being named as an approver
// would BE the permission and the capability system would be decoration. If authorization decided
// routing, holding `leave.approve` would make you the approver of everybody's leave, which is the
// per-user grant that Phase 1 spent its whole budget removing.
//
// THERE IS NO NEW AUTHORIZATION SYSTEM HERE. This module defines no capability, stores no grant and
// contains no permission matrix. mayAct() below asks holdsCapability() — the existing Layer 2
// entry point — and asks the org graph for the relationship. Two engines deciding access is the
// defect, not the feature.
//
// =================================================================================================
// ZERO ROLE NAMES, AND NO FALLBACK WHEN THE GRAPH IS EMPTY
// =================================================================================================
//
// Nothing in this file reads `users.role` to decide who approves anything. The strings
// 'reporting_manager', 'department_head', 'approval_owner' and 'executive_sponsor' appear below as
// values of `org_relationships.type` — RELATIONSHIP TYPES, resolved per row through the org graph's
// own API. They are never compared to a user's role and they never appear in a WHERE clause against
// the users table.
//
// WHEN THE GRAPH CANNOT NAME AN APPROVER, THE WORKFLOW HALTS. It does not auto-approve, it does not
// pick "whoever holds the capability", and it does not fall back to a role. The instance is written
// in state 'halted' with a sentence a person can read, and a human unblocks it by recording the
// missing relationship. Auto-approving because routing failed is the worst outcome available to this
// system: it would silently grant every request nobody could be found for, and it would look exactly
// like the system working.
//
// isInitialized() is checked FIRST and separately, because "the graph has no data at all" and "this
// person has no manager" are different facts that must produce different sentences. A screen that
// shows the second when the first is true tells every employee they report to nobody.
//
// =================================================================================================
// IDEMPOTENT. APPROVING TWICE MUST NOT APPROVE TWICE.
// =================================================================================================
//
// Three guards, because a retried POST on a phone with one bar of signal is the normal case here:
//   1. startWorkflow() is unique on (domain, record_id) IN THE DATABASE, so two clicks on "send for
//      approval" cannot produce two live approvals of one request routed to two different people.
//      The pre-check is a convenience; the index is the guarantee.
//   2. decideStep() writes with `WHERE decision = 'pending'`, so the SECOND identical approval
//      updates zero rows. It is then reported as {ok:true, changed:false} — a no-op, not an error,
//      because telling somebody their approval failed when it already succeeded sends them to look
//      for a problem that does not exist.
//   3. Advancing the instance re-derives the step state FROM THE ROWS every time rather than
//      incrementing a counter, so a double-fire cannot skip a step.
//
// =================================================================================================
// MATCHING THE VOCABULARY THAT ALREADY EXISTS HERE
// =================================================================================================
//
// src/lib/employee-tasks.ts already has an enforced transition graph, and this file deliberately
// speaks the same way rather than inventing a second dialect: an explicit state list, a TRANSITIONS
// map, a canTransition() that returns { ok, reason } (an OBJECT — `if (canTransition(...))` is
// always true), refusals phrased as sentences for a person, and a write whose WHERE clause re-states
// the precondition it was validated against so a concurrent change loses the race instead of
// clobbering.
//
// THE NOTIFIER AND THE AUDIT LOG ARE THE EXISTING ONES. sendPushToUser() (src/lib/push.ts, which
// also writes the in-app row) and logAudit() (src/lib/audit.ts). No second notifier, no second audit
// log, no workflow_events table — see the header of src/lib/workflow-schema.ts for why.
//
// =================================================================================================
// SHIPPED INACTIVE. NOTHING STARTS A WORKFLOW BY ITSELF.
// =================================================================================================
//
// No existing service calls startWorkflow(). src/lib/hr-leave.ts is UNTOUCHED: decideLeave() still
// enforces through approverRole(), and its reporting-manager arm — a per-row relationship, and
// already correct — keeps working exactly as it does today. The only way an instance comes into
// existence is a person pressing a button on /admin/hr/leave/workflow. Until the founder runs
// db/org-graph-backfill.sql the graph is empty, so that button halts with the initialization
// sentence rather than routing anywhere, which is the correct and visible behaviour.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureWorkflowSchema } from '@/lib/workflow-schema';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import { holdsCapability } from '@/lib/auth/capability';
import type { Permission } from '@/lib/auth/permissions';
import {
  isInitialized,
  getManager,
  getDepartmentHead,
  getApprovalOwner,
  getDelegates,
  getReportingChain,
  employeeIdForUser,
  type OrgPerson,
} from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that use it.
// `const` is not hoisted. A const declared below its first use throws on the first line of whatever
// reads it, and on this project that pattern took down apply step 5 and the /admin/roles/diagnose
// Repair button, both of which reported success while failing every time.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[workflow] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * What a person is shown when a write fails. Deliberately NOT the database's own words.
 *
 * `e.cause.message` is the real Postgres reason and it belongs in the log, every time. It does not
 * belong on somebody's approvals screen: 'column "acted_via" of relation "workflow_steps" does not
 * exist' names the schema to whoever asks and tells the reader nothing they can act on.
 */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One message for every not-found/not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That approval is not available.';

/**
 * THE HALT SENTENCE PREFIX. Every reason a workflow stops for lack of an approver starts with this,
 * so the halted queue reads as one category rather than six unrelated errors.
 *
 * The exact wording of the first case is fixed by the phase brief and must not drift: when the graph
 * has no rows at all the instance says "organization graph not yet initialized", never "no manager",
 * because the two are different facts and only one of them is the founder's to fix by running a
 * backfill.
 */
const HALT_PREFIX = 'no approver could be resolved: ';
const HALT_NOT_INITIALIZED = HALT_PREFIX + 'organization graph not yet initialized';
const HALT_NO_EMPLOYEE = HALT_PREFIX + 'this request is not linked to an employee record';

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY. Domains, states, decisions, and the relationship each step was routed through.
// -------------------------------------------------------------------------------------------------

export const WORKFLOW_DOMAINS = [
  'leave',
  'attendance',
  'expenses',
  'procurement',
  'recruitment',
  'travel',
] as const;

export type WorkflowDomain = (typeof WORKFLOW_DOMAINS)[number];

const DOMAIN_SET = new Set<string>(WORKFLOW_DOMAINS);
export function isWorkflowDomain(v: unknown): v is WorkflowDomain {
  return typeof v === 'string' && DOMAIN_SET.has(v);
}

/**
 * THE INSTANCE STATES. An instance is a ROW WITH AN EXPLICIT STATE — that is the whole point of the
 * table, and every one of these means something a person can be told:
 *
 *   draft      created, not yet sent for approval. Nobody has been asked for anything.
 *   pending    live. At least one person owes a decision and the row names them.
 *   approved   every step approved. Terminal.
 *   rejected   somebody refused it. Terminal, and the remaining steps are marked 'skipped' rather
 *              than left pending — an approver must never be shown a decision that no longer matters.
 *   cancelled  withdrawn before it settled. Terminal.
 *   halted     ROUTING COULD NOT NAME AN APPROVER. Not approved, not waiting on anybody, and
 *              carrying the sentence that says why. This state exists so that "we could not work out
 *              who approves this" can never be silently rendered as either of the other two.
 */
export const WORKFLOW_STATES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'halted',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const STATE_LABELS: Record<WorkflowState, string> = {
  draft: 'Draft',
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  halted: 'Halted',
};

/** Nothing further is owed on these. */
export const TERMINAL_STATES: WorkflowState[] = ['approved', 'rejected', 'cancelled'];

/** What one step's decision can be. 'skipped' is written when the instance settled without it. */
export const STEP_DECISIONS = ['pending', 'approved', 'rejected', 'skipped'] as const;
export type StepDecision = (typeof STEP_DECISIONS)[number];

/**
 * How a step's approver was FOUND. These are values of `org_relationships.type`, resolved through
 * the org graph's own API — they are RELATIONSHIPS, not role names and not capabilities. Nothing
 * compares them to users.role and nothing grants anything from them.
 */
export const ROUTE_VIA = [
  'reporting_manager',
  'department_head',
  'approval_owner',
  'executive_sponsor',
] as const;

export type RouteVia = (typeof ROUTE_VIA)[number];

/** How a screen says who it is waiting on. Plain words; no emoji anywhere in this codebase. */
export const VIA_LABELS: Record<RouteVia, string> = {
  reporting_manager: 'Reporting manager',
  department_head: 'Department head',
  approval_owner: 'Approval owner',
  executive_sponsor: 'Executive sponsor',
};

/** How the person who actually decided was entitled to. Written after the check, never read to make one. */
export type ActedVia = 'routed' | 'delegate' | 'capability';

export const ACTED_VIA_LABELS: Record<ActedVia, string> = {
  routed: 'Named approver',
  delegate: 'Standing in',
  capability: 'Standing authority',
};

export type WorkflowStepMode = 'sequential' | 'parallel' | 'executive';

// -------------------------------------------------------------------------------------------------
// THE INSTANCE STATE MACHINE. An invalid transition is REFUSED, not silently ignored.
// -------------------------------------------------------------------------------------------------

/**
 * from -> the states it may move to.
 *
 * Read the absences, they are deliberate:
 *   - NOTHING LEAVES `approved`, `rejected` OR `cancelled`. A settled approval is evidence. Reopening
 *     one would rewrite the record of a decision somebody made, so a changed mind is a NEW request
 *     against a new record, which is also how hr_leave_request already behaves.
 *   - `halted -> pending` IS here, and it is the one that makes halting safe to do. Once the missing
 *     relationship is recorded, resumeWorkflow() re-routes and the request carries on from where it
 *     stopped. Halting is a pause with a stated cause, never a dead end.
 *   - `draft -> halted` and `pending -> halted` are here because routing is re-resolved when an
 *     instance advances: the manager who was going to approve step 2 may have left between step 1
 *     and step 2, and the honest answer at that moment is to stop, not to skip the step.
 *   - THERE IS NO EDGE TO `approved` FROM ANYTHING BUT `pending`. An instance can only be approved by
 *     walking its steps. No path in this file writes 'approved' as a way of getting unstuck.
 */
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  draft: ['pending', 'halted', 'cancelled'],
  pending: ['approved', 'rejected', 'cancelled', 'halted'],
  halted: ['pending', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: [],
};

export interface TransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
  /** Where this state CAN go, so a screen can say what is possible instead of just refusing. */
  allowed: WorkflowState[];
}

/**
 * May this instance move from one state to the other?
 *
 * READ THIS BEFORE CALLING IT: it returns an OBJECT, not a boolean. `if (canTransition(a, b))` is
 * always true and would wave every move through — the same trap employee-tasks.ts documents on its
 * own canTransition, and it is spelled the same way here so that reading one teaches the other.
 */
export function canTransition(from: string, to: string): TransitionCheck {
  const a = WORKFLOW_STATES.indexOf(from as WorkflowState) >= 0 ? (from as WorkflowState) : null;
  const b = WORKFLOW_STATES.indexOf(to as WorkflowState) >= 0 ? (to as WorkflowState) : null;

  if (!a) return { ok: false, reason: 'That request is in a state this workflow does not recognise.', allowed: [] };
  if (!b) return { ok: false, reason: 'That is not a state we track.', allowed: [] };
  if (a === b) return { ok: false, reason: 'It is already ' + STATE_LABELS[b].toLowerCase() + '.', allowed: [] };

  const allowed = TRANSITIONS[a] || [];
  if (allowed.indexOf(b) < 0) {
    return {
      ok: false,
      allowed,
      reason: allowed.length
        ? STATE_LABELS[a] + ' does not move to ' + STATE_LABELS[b] + '. From here it can go to: '
          + allowed.map((s) => STATE_LABELS[s]).join(', ') + '.'
        : STATE_LABELS[a] + ' is final; it does not move to ' + STATE_LABELS[b] + '.',
    };
  }
  return { ok: true, reason: null, allowed };
}

/** The same question as a plain predicate, for the places that only need a yes or no. */
export function isAllowedTransition(from: string, to: string): boolean {
  return canTransition(from, to).ok;
}

// -------------------------------------------------------------------------------------------------
// THE DOMAIN DEFINITIONS — the approval chains, declared as data.
// -------------------------------------------------------------------------------------------------

/**
 * One rung of an approval chain.
 *
 *   step      position in the chain. Rules SHARING a step number are PARALLEL — every one of them
 *             must approve before the instance advances. Rules with distinct step numbers are
 *             SEQUENTIAL and run in ascending order. There is no separate "parallel" flag; the step
 *             number IS the mechanism, so nothing can get out of step with the rows.
 *   via       WHICH RELATIONSHIP to walk. Resolved through src/lib/org-graph.ts and nowhere else.
 *   optional  when this rule resolves nobody, SKIP it instead of halting. Used for rungs that only
 *             exist if the organisation has chosen to staff them — an approval owner for a domain is
 *             a policy choice, a reporting manager is not.
 *   minAmount the rule only applies when the instance's amount is at or above this. Below it the
 *             rung does not exist at all — it is not skipped, it was never part of this chain.
 */
interface RouteRule {
  step: number;
  via: RouteVia;
  optional?: boolean;
  minAmount?: number;
}

interface DomainDefinition {
  key: WorkflowDomain;
  label: string;
  /**
   * THE LAYER 2 STANDING AUTHORITY for this domain, or null when the product has not defined one.
   *
   * Typed `Permission`, so a capability outside the union fails to COMPILE. An invented key silently
   * answers false for every role including super_admin, which is how a whole console became
   * unreachable on this project once already.
   *
   * ONLY `leave` HAS ONE, AND THAT IS DELIBERATE. `leave.approve` already exists in
   * src/lib/auth/permissions.ts and already means exactly "may decide any leave request"; using it
   * here changes nothing about who holds it. The other five domains are null because THIS FILE MUST
   * NOT INVENT POLICY: mapping expenses or procurement onto `payouts.approve` would silently hand
   * every holder of that key standing authority over a kind of request they have never been granted
   * anything about. Null is the narrow, fail-closed reading — for those domains ONLY the person the
   * org graph actually routed to (or their in-force delegate) may act. Adding a capability later is
   * a one-line, reviewable policy decision in permissions.ts; it is not this engine's to make.
   */
  capability: Permission | null;
  route: RouteRule[];
  /**
   * Hours a pending step may sit before escalateStep() will consider it overdue. Escalation is never
   * automatic here — see escalateStep(); this only decides when a step is ELIGIBLE.
   */
  escalateAfterHours: number;
  /** Where a notification about this domain should send somebody. */
  approvalUrl: string;
}

/**
 * THE CHAINS. Each is the shape of an approval, not a claim about who fills it — every rung is
 * resolved per request, per person, from the graph.
 *
 * WHY `executive_sponsor` IS ROUTED THROUGH getApprovalOwner: src/lib/org-graph.ts exposes
 * getManager, getDepartmentHead, getApprovalOwner, getDelegates and getReportingChain, and it has NO
 * executive-sponsor resolver. Reimplementing one here would mean writing a second query against
 * org_relationships from outside the module that owns it — which is precisely the drift the org
 * graph exists to prevent. So executive approval is expressed as an approval-owner edge scoped to
 * the domain string '<domain>.executive', which getApprovalOwner() supports directly (its `domain`
 * argument is a free string held in scope_id, as its own docblock states). The founder records one
 * edge per domain that needs it. This is a stated adaptation, not a hidden one.
 */
const DOMAINS: Record<WorkflowDomain, DomainDefinition> = {
  // Manager first, then whoever owns leave approvals if the organisation has named one.
  leave: {
    key: 'leave',
    label: 'Leave',
    capability: 'leave.approve',
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 48,
    approvalUrl: '/admin/hr/leave/workflow',
  },
  // A single rung on purpose. An attendance correction is a small factual claim about one day; a
  // three-rung chain for it would mean nobody ever corrects anything.
  attendance: {
    key: 'attendance',
    label: 'Attendance correction',
    capability: null,
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 72,
    approvalUrl: '/admin/hr/leave/workflow',
  },
  // Money the company pays back. Manager, then the finance owner, then an executive above a
  // threshold. The threshold rung is NOT optional: if the amount is large enough to need an
  // executive and no executive sponsor is recorded, the correct outcome is a halt.
  expenses: {
    key: 'expenses',
    label: 'Expense claim',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
      { step: 3, via: 'executive_sponsor', minAmount: 100000 },
    ],
    escalateAfterHours: 72,
    approvalUrl: '/admin/hr/leave/workflow',
  },
  // Money the company spends. The only chain with a genuinely PARALLEL rung: the department head and
  // the procurement owner both sit at step 2 and both must approve, because one is answering "does
  // this team need it" and the other "may we buy it this way", and neither answer substitutes.
  procurement: {
    key: 'procurement',
    label: 'Procurement request',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'department_head' },
      { step: 2, via: 'approval_owner', optional: true },
      { step: 3, via: 'executive_sponsor', minAmount: 500000 },
    ],
    escalateAfterHours: 96,
    approvalUrl: '/admin/hr/leave/workflow',
  },
  // Opening a position belongs to the department, so the head is the FIRST rung rather than the
  // requester's own manager — the requester is often the manager.
  recruitment: {
    key: 'recruitment',
    label: 'Recruitment request',
    capability: null,
    route: [
      { step: 1, via: 'department_head' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 96,
    approvalUrl: '/admin/hr/leave/workflow',
  },
  travel: {
    key: 'travel',
    label: 'Travel request',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
      { step: 3, via: 'executive_sponsor', minAmount: 200000 },
    ],
    escalateAfterHours: 48,
    approvalUrl: '/admin/hr/leave/workflow',
  },
};

/** The chain a domain uses, for a screen that wants to explain the process before anything starts. */
export function domainDefinition(domain: WorkflowDomain): DomainDefinition {
  return DOMAINS[domain];
}

export function domainLabel(domain: string): string {
  return isWorkflowDomain(domain) ? DOMAINS[domain].label : String(domain || 'Request');
}

// -------------------------------------------------------------------------------------------------
// TYPES THE CONSUMERS SEE
// -------------------------------------------------------------------------------------------------

/** One resolved rung: a real person the graph named, and the edge that named them. */
export interface ResolvedApprover {
  step: number;
  mode: WorkflowStepMode;
  via: RouteVia;
  employeeId: string;
  userId: string | null;
  fullName: string | null;
  designation: string | null;
}

/**
 * The answer to "who approves this". Carries its own failure, because the two failures are different
 * and must render differently:
 *
 *   initialized === false                  ->  "Organization Graph not yet initialized"
 *   initialized === true, ok === false     ->  haltReason names the missing relationship
 *
 * A screen that shows the second when the first is true is telling the founder to go and fix a
 * relationship on a graph that has no rows at all.
 */
export interface RoutePlan {
  ok: boolean;
  initialized: boolean;
  approvers: ResolvedApprover[];
  /** Present exactly when ok is false. A sentence, rendered verbatim. */
  haltReason: string | null;
}

export interface WorkflowStepRow {
  id: string;
  instanceId: string;
  stepNo: number;
  mode: string;
  via: string | null;
  approverEmployeeId: string | null;
  approverUserId: string | null;
  approverName: string | null;
  decision: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  actedVia: string | null;
  note: string | null;
  dueAt: string | null;
  escalatedFromStepId: string | null;
  createdAt: string | null;
}

export interface WorkflowInstanceRow {
  id: string;
  domain: string;
  recordId: string;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  requestedByUserId: string | null;
  state: string;
  currentStep: number;
  haltReason: string | null;
  summary: string | null;
  amount: number | null;
  currency: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  settledAt: string | null;
}

export interface WorkflowInstanceView extends WorkflowInstanceRow {
  steps: WorkflowStepRow[];
}

export interface WorkflowResult {
  ok: boolean;
  instanceId?: string;
  state?: WorkflowState;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
  error?: string;
  /** Set when the instance halted. The sentence, so the caller can show it without re-reading. */
  haltReason?: string | null;
}

// -------------------------------------------------------------------------------------------------
// INTERNAL HELPERS
// -------------------------------------------------------------------------------------------------

function mapStep(r: any): WorkflowStepRow {
  return {
    id: String(r?.id ?? ''),
    instanceId: String(r?.instance_id ?? ''),
    stepNo: Number(r?.step_no) || 1,
    mode: String(r?.mode ?? 'sequential'),
    via: r?.via ? String(r.via) : null,
    approverEmployeeId: r?.approver_employee_id ? String(r.approver_employee_id) : null,
    approverUserId: r?.approver_user_id ? String(r.approver_user_id) : null,
    approverName: r?.approver_name ? String(r.approver_name) : null,
    decision: String(r?.decision ?? 'pending'),
    decidedByUserId: r?.decided_by_user_id ? String(r.decided_by_user_id) : null,
    decidedAt: r?.decided_at ? new Date(r.decided_at).toISOString() : null,
    actedVia: r?.acted_via ? String(r.acted_via) : null,
    note: r?.note ? String(r.note) : null,
    dueAt: r?.due_at ? new Date(r.due_at).toISOString() : null,
    escalatedFromStepId: r?.escalated_from_step_id ? String(r.escalated_from_step_id) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function mapInstance(r: any): WorkflowInstanceRow {
  return {
    id: String(r?.id ?? ''),
    domain: String(r?.domain ?? ''),
    recordId: String(r?.record_id ?? ''),
    subjectEmployeeId: r?.subject_employee_id ? String(r.subject_employee_id) : null,
    subjectName: r?.subject_name ? String(r.subject_name) : null,
    requestedByUserId: r?.requested_by_user_id ? String(r.requested_by_user_id) : null,
    state: String(r?.state ?? 'draft'),
    currentStep: Number(r?.current_step) || 1,
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    summary: r?.summary ? String(r.summary) : null,
    amount: r?.amount === null || r?.amount === undefined ? null : Number(r.amount),
    currency: r?.currency ? String(r.currency) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
    settledAt: r?.settled_at ? new Date(r.settled_at).toISOString() : null,
  };
}

/**
 * The subject's CURRENT department, read straight from hr_employees.
 *
 * This is not a relationship question, so it is not the org graph's to answer — "which department is
 * this person in" is a fact on their own HR row, and org-graph.ts reads the same column the same way
 * for exactly that reason.
 *
 * ::text, NEVER ::uuid. `departments.id` is varchar(50) — a slug — in src/lib/db/schema.ts and UUID
 * in db/hr-schema.sql. A ::uuid cast throws `invalid input syntax for type uuid` the first time a
 * slug arrives, and half this product's department ids are slugs.
 */
async function subjectDepartmentId(employeeId: string): Promise<string | null> {
  if (!isUuid(employeeId)) return null;
  try {
    const r = await db.execute(sql`
      SELECT department_id::text AS dept FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
    const list = rows(r);
    return list.length && list[0]?.dept ? String(list[0].dept) : null;
  } catch (e: any) {
    logFail('subjectDepartmentId', e);
    return null;
  }
}

/** The subject's own name, for sentences a person reads. Never used to decide anything. */
async function employeeName(employeeId: string): Promise<string> {
  if (!isUuid(employeeId)) return 'this person';
  try {
    const r = await db.execute(sql`
      SELECT full_name FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`);
    const list = rows(r);
    return list.length && list[0]?.full_name ? String(list[0].full_name) : 'this person';
  } catch (e: any) {
    logFail('employeeName', e);
    return 'this person';
  }
}

// -------------------------------------------------------------------------------------------------
// ROUTING — LAYER 1'S ANSWER. Who approves this, for this person, right now.
// -------------------------------------------------------------------------------------------------

/**
 * Walk one rung of a chain. Returns the person the graph named, or null.
 *
 * EVERY BRANCH GOES THROUGH src/lib/org-graph.ts. There is no query against org_relationships in
 * this file and there must never be one: two modules resolving the same relationship is how the two
 * start disagreeing about who a person's manager is.
 */
async function resolveRung(
  domain: WorkflowDomain,
  rule: RouteRule,
  subjectEmployeeId: string,
  asOf: Date | null,
): Promise<OrgPerson | null> {
  const opts = asOf ? { asOf } : undefined;
  if (rule.via === 'reporting_manager') {
    return getManager(subjectEmployeeId, opts);
  }
  if (rule.via === 'department_head') {
    const dept = await subjectDepartmentId(subjectEmployeeId);
    if (!dept) return null;
    return getDepartmentHead(dept, opts);
  }
  if (rule.via === 'approval_owner') {
    return getApprovalOwner(domain, { ...(opts || {}), employeeId: subjectEmployeeId });
  }
  // executive_sponsor — an approval-owner edge scoped to '<domain>.executive'. See the note on
  // DOMAINS above for why this is expressed through getApprovalOwner rather than a new resolver.
  return getApprovalOwner(domain + '.executive', { ...(opts || {}), employeeId: subjectEmployeeId });
}

/** The sentence for a rung that resolved nobody. Names the relationship, so it is actionable. */
function missingRungReason(via: RouteVia, subjectName: string): string {
  if (via === 'reporting_manager') {
    return HALT_PREFIX + 'no reporting manager is recorded for ' + subjectName;
  }
  if (via === 'department_head') {
    return HALT_PREFIX + 'no department head is recorded for ' + subjectName + "'s department";
  }
  if (via === 'executive_sponsor') {
    return HALT_PREFIX + 'this request needs executive approval and no executive sponsor is recorded for it';
  }
  return HALT_PREFIX + 'no approval owner is recorded for this kind of request';
}

/**
 * WHO APPROVES THIS REQUEST, RIGHT NOW. The routing question, and only the routing question.
 *
 * This says nothing about whether the people it names MAY approve — that is mayAct(), Layer 2, asked
 * separately at the moment somebody presses the button. Keeping the two apart is the reason this
 * function returns people rather than permission.
 *
 * ORDER OF CHECKS, and it matters:
 *   1. Is there an employee to route FROM? No employee record means no place in the org graph.
 *   2. IS THE GRAPH INITIALIZED AT ALL? Asked before any resolver, so an empty graph produces the
 *      initialization sentence rather than "nobody is her manager" — which would be true of every
 *      person in the company and would send the founder hunting for a data problem that does not
 *      exist. THERE IS NO ROLE-NAME FALLBACK ON THIS BRANCH OR ANY OTHER.
 *   3. Each rung in turn. A required rung that resolves nobody HALTS the whole plan; an optional one
 *      is dropped.
 *
 * DE-DUPLICATION. One person can legitimately satisfy two rungs — a small company's department head
 * is often also somebody's reporting manager. They are kept at their FIRST appearance and dropped
 * from later rungs, because asking one human to approve the same request twice is not two approvals,
 * it is one approval and a confused person. The subject is dropped from every rung for the same
 * class of reason: nobody approves their own request, and a chain that let them would make every
 * manager's own leave self-approving.
 */
export async function resolveRoute(
  domain: WorkflowDomain,
  subjectEmployeeId: string,
  opts: { amount?: number | null; asOf?: Date | null } = {},
): Promise<RoutePlan> {
  const def = DOMAINS[domain];
  if (!def) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_PREFIX + 'unknown request type' };
  }
  if (!isUuid(subjectEmployeeId)) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_NO_EMPLOYEE };
  }

  // THE CHECK THAT MUST COME FIRST. An empty graph is not "this person has no manager".
  const initialized = await isInitialized();
  if (!initialized) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_NOT_INITIALIZED };
  }

  const amount = typeof opts.amount === 'number' && isFinite(opts.amount) ? opts.amount : 0;
  const asOf = opts.asOf ?? null;
  const applicable = def.route.filter((r) => !r.minAmount || amount >= r.minAmount);

  // How many rules share each step number — that is what makes a step parallel, and it is derived
  // from the rules rather than stored, so the two cannot disagree.
  const perStep = new Map<number, number>();
  for (const r of applicable) perStep.set(r.step, (perStep.get(r.step) || 0) + 1);

  const approvers: ResolvedApprover[] = [];
  const seen = new Set<string>([subjectEmployeeId.toLowerCase()]); // never route to the subject
  let subjectName = '';

  for (const rule of applicable) {
    const person = await resolveRung(domain, rule, subjectEmployeeId, asOf);
    const empId = person?.employeeId || null;

    if (!empId) {
      if (rule.optional) continue;
      if (!subjectName) subjectName = await employeeName(subjectEmployeeId);
      return { ok: false, initialized: true, approvers: [], haltReason: missingRungReason(rule.via, subjectName) };
    }

    const key = empId.toLowerCase();
    if (seen.has(key)) continue; // already asked, or it is the subject
    seen.add(key);

    approvers.push({
      step: rule.step,
      mode: rule.via === 'executive_sponsor'
        ? 'executive'
        : ((perStep.get(rule.step) || 1) > 1 ? 'parallel' : 'sequential'),
      via: rule.via,
      employeeId: empId,
      userId: person?.userId || null,
      fullName: person?.fullName || null,
      designation: person?.designation || null,
    });
  }

  if (approvers.length === 0) {
    // Every rung was optional and every one resolved nobody. NOT an approval — a halt. An empty
    // chain that settled as 'approved' would be an auto-approval caused by missing data, which is
    // the single worst outcome this engine can produce.
    if (!subjectName) subjectName = await employeeName(subjectEmployeeId);
    return {
      ok: false,
      initialized: true,
      approvers: [],
      haltReason: HALT_PREFIX + 'no relationship in the organization graph names an approver for ' + subjectName,
    };
  }

  // Ascending step order, so the caller can trust the array order is the chain order.
  approvers.sort((a, b) => a.step - b.step);
  return { ok: true, initialized: true, approvers, haltReason: null };
}

/**
 * The route WITHOUT writing anything — for a screen that wants to show "this would go to..." before
 * a person commits to starting an approval, and for the founder to see what the graph currently
 * supports. Same function, named so its read-only-ness is obvious at the call site.
 */
export const previewRoute = resolveRoute;

// -------------------------------------------------------------------------------------------------
// AUTHORIZATION — LAYER 2'S ANSWER, asked SECOND and never instead.
// -------------------------------------------------------------------------------------------------

export interface ActorCheck {
  ok: boolean;
  via: ActedVia | null;
  /** Null when ok. A sentence for a person. */
  reason: string | null;
}

/**
 * MAY THIS SIGNED-IN USER DECIDE THIS STEP?
 *
 * THREE WAYS, and the order is the order of narrowness:
 *
 *   1. ROUTED. They ARE the approver this step was routed to. This is a RELATIONSHIP to one request,
 *      resolved when the step was created, and it entitles them to this step and to nothing else.
 *      It is the same shape as the arm src/lib/hr-wallet.ts approverRole() already has — an
 *      employee's own reporting manager may decide THAT employee's request without holding any
 *      capability — and that arm is correct and is left exactly as it is.
 *
 *   2. DELEGATE. They hold an IN-FORCE temporary_delegate edge over the routed approver, so they are
 *      standing in while that person is away. ONE HOP, deliberately: chained delegation would let A
 *      delegate to B who delegates to C, quietly reaching further than anybody approved. The edge is
 *      time-boxed by the graph itself — there is no "is delegated" flag anyone has to remember to
 *      switch off when they get back.
 *
 *   3. STANDING CAPABILITY. They hold the domain's approval capability from Layer 2. Only `leave`
 *      defines one (`leave.approve`, which already exists and already means this); for every other
 *      domain this arm cannot fire, so the routed person is the only person. See DomainDefinition.
 *
 * WHAT IS NOT HERE, AND MUST NEVER BE: a role name. Not `users.role === 'hr'`, not 'department_head'
 * as a role, not a substring test. If none of the three arms fires, the answer is no.
 *
 * FAILS CLOSED. Any error resolving the delegate chain answers "no" — an approver who is refused
 * once and asks why is a small annoyance; an approver who is admitted because a query failed is an
 * approval nobody authorised.
 */
export async function mayAct(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  domain: string,
  step: { approverEmployeeId: string | null; approverUserId: string | null },
): Promise<ActorCheck> {
  const userId = String(user?.id || '').trim();
  if (!userId) return { ok: false, via: null, reason: 'Sign in to decide this.' };

  // 1. ROUTED — compare in USER-id space when we have it, and fall back to EMPLOYEE-id space.
  //    Both are stored on the step precisely so this comparison never has to guess which space it is
  //    in. Mixing the two silently answers "no" for everybody and looks exactly like a clean
  //    permission check, which is the id-space trap the org graph's header warns about.
  if (step.approverUserId && step.approverUserId === userId) {
    return { ok: true, via: 'routed', reason: null };
  }

  let actorEmployeeId: string | null = null;
  try {
    actorEmployeeId = await employeeIdForUser(userId);
  } catch (e: any) {
    logFail('mayAct.employeeIdForUser', e);
    actorEmployeeId = null;
  }

  if (actorEmployeeId && step.approverEmployeeId && actorEmployeeId === step.approverEmployeeId) {
    return { ok: true, via: 'routed', reason: null };
  }

  // 2. DELEGATE — one hop, from the graph, in force right now.
  if (actorEmployeeId && step.approverEmployeeId) {
    try {
      const delegates = await getDelegates(step.approverEmployeeId);
      if (delegates.some((d) => d.employeeId && d.employeeId === actorEmployeeId)) {
        return { ok: true, via: 'delegate', reason: null };
      }
    } catch (e: any) {
      logFail('mayAct.getDelegates', e);
    }
  }

  // 3. STANDING CAPABILITY — Layer 2, asked through the existing entry point and no other.
  const def = isWorkflowDomain(domain) ? DOMAINS[domain] : null;
  if (def?.capability && holdsCapability(user, def.capability)) {
    return { ok: true, via: 'capability', reason: null };
  }

  return {
    ok: false,
    via: null,
    reason: 'This approval is waiting on someone else. You are not the approver it was routed to, '
      + 'and you are not standing in for them.',
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

/** The instance for one domain record, or null. Also how startWorkflow stays idempotent. */
export async function instanceForRecord(
  domain: string,
  recordId: string,
): Promise<WorkflowInstanceRow | null> {
  const d = String(domain || '').trim();
  const rec = String(recordId || '').trim();
  if (!d || !rec) return null;
  try {
    await ensureWorkflowSchema();
    const r = await db.execute(sql`
      SELECT i.*, e.full_name AS subject_name
        FROM workflow_instances i
        LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
       WHERE i.domain = ${d} AND i.record_id = ${rec}
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapInstance(list[0]) : null;
  } catch (e: any) {
    logFail('instanceForRecord', e);
    return null;
  }
}

/** One instance with its steps in chain order. Null when there is no such instance. */
export async function getInstance(instanceId: string): Promise<WorkflowInstanceView | null> {
  if (!isUuid(instanceId)) return null;
  try {
    await ensureWorkflowSchema();
    const ir = rows(await db.execute(sql`
      SELECT i.*, e.full_name AS subject_name
        FROM workflow_instances i
        LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
       WHERE i.id = ${instanceId}::uuid
       LIMIT 1`));
    if (!ir.length) return null;
    const sr = rows(await db.execute(sql`
      SELECT s.*, e.full_name AS approver_name
        FROM workflow_steps s
        LEFT JOIN hr_employees e ON e.id = s.approver_employee_id
       WHERE s.instance_id = ${instanceId}::uuid
       ORDER BY s.step_no ASC, s.created_at ASC`));
    return { ...mapInstance(ir[0]), steps: sr.map(mapStep) };
  } catch (e: any) {
    logFail('getInstance', e);
    return null;
  }
}

/** Instances in a domain, newest first. `state` narrows it; omit for everything. */
export async function listInstances(
  opts: { domain?: string; state?: string; limit?: number } = {},
): Promise<WorkflowInstanceRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  try {
    await ensureWorkflowSchema();
    const domainFilter = opts.domain ? sql`AND i.domain = ${String(opts.domain)}` : sql``;
    const stateFilter = opts.state ? sql`AND i.state = ${String(opts.state)}` : sql``;
    const r = await db.execute(sql`
      SELECT i.*, e.full_name AS subject_name
        FROM workflow_instances i
        LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
       WHERE TRUE ${domainFilter} ${stateFilter}
       ORDER BY (i.state = 'pending') DESC, i.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapInstance);
  } catch (e: any) {
    logFail('listInstances', e);
    return [];
  }
}

export interface PendingApproval {
  instance: WorkflowInstanceRow;
  step: WorkflowStepRow;
}

/**
 * WHAT IS WAITING ON THIS PERSON, RIGHT NOW.
 *
 * ROUTED AND DELEGATED ONLY. A holder of `leave.approve` does NOT see every pending workflow step
 * here, and that is deliberate: standing authority means they MAY act on a request that reaches
 * them, not that every request in the company is on their personal list. Widening this to
 * capability holders would recreate, on a queue screen, exactly the per-user reach that per-row
 * routing exists to avoid. The full queue is a separate, explicitly-labelled list — listInstances().
 *
 * Fails closed to an empty list: an approver seeing nothing is a missed notification, an approver
 * seeing everyone else's requests is a data leak.
 */
export async function pendingForApprover(userId: string): Promise<PendingApproval[]> {
  const uid = String(userId || '').trim();
  if (!isUuid(uid)) return [];
  try {
    await ensureWorkflowSchema();

    const empId = await employeeIdForUser(uid);

    // Everyone this person is currently standing in for. Resolved through the graph, one hop, in
    // force right now — the delegation is time-boxed by its own edge and by nothing else.
    let delegatedFor: string[] = [];
    if (empId) {
      try {
        // getDelegates answers "who stands in for X". The question here is the inverse — "who does
        // this person stand in FOR" — and the graph's API has no inverse resolver, so it is derived
        // from the steps themselves: for each pending step, ask whether this actor is one of that
        // approver's delegates. Bounded by the number of pending steps, which is small by
        // definition (a queue nobody can clear is a different problem).
        const candidates = rows(await db.execute(sql`
          SELECT DISTINCT s.approver_employee_id AS emp
            FROM workflow_steps s
            JOIN workflow_instances i ON i.id = s.instance_id
           WHERE s.decision = 'pending'
             AND i.state = 'pending'
             AND s.step_no = i.current_step
             AND s.approver_employee_id IS NOT NULL
           LIMIT 200`));
        for (const c of candidates) {
          const owner = c?.emp ? String(c.emp) : '';
          if (!owner || owner === empId) continue;
          const ds = await getDelegates(owner);
          if (ds.some((d) => d.employeeId === empId)) delegatedFor.push(owner);
        }
      } catch (e: any) {
        logFail('pendingForApprover.delegates', e);
        delegatedFor = [];
      }
    }

    // An empty array must not compile to `IN ()`, which is a syntax error — so an empty list emits
    // NO clause at all rather than an empty one.
    //
    // EVERY ID IS A BOUND PARAMETER. These values came out of the database a moment ago and are
    // uuids, so interpolating them would "work" — and a query built by string concatenation from
    // values that are trusted today is exactly the shape that stops being safe the first time
    // somebody widens the source. sql.join over bound fragments costs nothing and cannot.
    const delegateClause = delegatedFor.length
      ? sql`OR s.approver_employee_id IN (${sql.join(delegatedFor.map((d) => sql`${d}::uuid`), sql`, `)})`
      : sql``;

    const r = await db.execute(sql`
      SELECT i.*, e.full_name AS subject_name,
             s.id AS step_id, s.step_no, s.mode, s.via, s.approver_employee_id, s.approver_user_id,
             s.decision, s.decided_by_user_id, s.decided_at, s.acted_via, s.note, s.due_at,
             s.escalated_from_step_id, s.created_at AS step_created_at,
             ae.full_name AS approver_name
        FROM workflow_steps s
        JOIN workflow_instances i ON i.id = s.instance_id
        LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
        LEFT JOIN hr_employees ae ON ae.id = s.approver_employee_id
       WHERE s.decision = 'pending'
         AND i.state = 'pending'
         AND s.step_no = i.current_step
         AND (
           s.approver_user_id = ${uid}::uuid
           ${empId ? sql`OR s.approver_employee_id = ${empId}::uuid` : sql``}
           ${delegateClause}
         )
       ORDER BY s.due_at ASC NULLS LAST, i.created_at ASC
       LIMIT 100`);

    return rows(r).map((row) => ({
      instance: mapInstance(row),
      step: mapStep({
        id: row.step_id,
        instance_id: row.id,
        step_no: row.step_no,
        mode: row.mode,
        via: row.via,
        approver_employee_id: row.approver_employee_id,
        approver_user_id: row.approver_user_id,
        approver_name: row.approver_name,
        decision: row.decision,
        decided_by_user_id: row.decided_by_user_id,
        decided_at: row.decided_at,
        acted_via: row.acted_via,
        note: row.note,
        due_at: row.due_at,
        escalated_from_step_id: row.escalated_from_step_id,
        created_at: row.step_created_at,
      }),
    }));
  } catch (e: any) {
    logFail('pendingForApprover', e);
    return [];
  }
}

/**
 * Pending steps old enough to escalate. A READ — it escalates nothing.
 *
 * There is deliberately no cron and no automatic sweep in this phase. Escalation changes who a
 * request is waiting on, and a background job doing that on a graph the founder has not yet
 * populated would produce escalations to nobody at 3am. The founder runs the sweep, or a surface
 * offers the button per row; this function is what either would read.
 */
export async function stepsAwaitingEscalation(limit = 50): Promise<PendingApproval[]> {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    await ensureWorkflowSchema();
    const r = await db.execute(sql`
      SELECT i.*, e.full_name AS subject_name,
             s.id AS step_id, s.step_no, s.mode, s.via, s.approver_employee_id, s.approver_user_id,
             s.decision, s.decided_by_user_id, s.decided_at, s.acted_via, s.note, s.due_at,
             s.escalated_from_step_id, s.created_at AS step_created_at,
             ae.full_name AS approver_name
        FROM workflow_steps s
        JOIN workflow_instances i ON i.id = s.instance_id
        LEFT JOIN hr_employees e ON e.id = i.subject_employee_id
        LEFT JOIN hr_employees ae ON ae.id = s.approver_employee_id
       WHERE s.decision = 'pending'
         AND i.state = 'pending'
         AND s.step_no = i.current_step
         AND s.due_at IS NOT NULL
         AND s.due_at < NOW()
         AND NOT EXISTS (
           SELECT 1 FROM workflow_steps x
            WHERE x.escalated_from_step_id = s.id
         )
       ORDER BY s.due_at ASC
       LIMIT ${lim}`);
    return rows(r).map((row) => ({
      instance: mapInstance(row),
      step: mapStep({
        id: row.step_id,
        instance_id: row.id,
        step_no: row.step_no,
        mode: row.mode,
        via: row.via,
        approver_employee_id: row.approver_employee_id,
        approver_user_id: row.approver_user_id,
        approver_name: row.approver_name,
        decision: row.decision,
        decided_by_user_id: row.decided_by_user_id,
        decided_at: row.decided_at,
        acted_via: row.acted_via,
        note: row.note,
        due_at: row.due_at,
        escalated_from_step_id: row.escalated_from_step_id,
        created_at: row.step_created_at,
      }),
    }));
  } catch (e: any) {
    logFail('stepsAwaitingEscalation', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// NOTIFICATION AND AUDIT HOOKS — THE EXISTING ONES. No second notifier, no second audit log.
// -------------------------------------------------------------------------------------------------

/**
 * Tell an approver something is waiting on them.
 *
 * sendPushToUser() (src/lib/push.ts) is the existing notifier: it writes the in-app notifications
 * row AND sends the browser push, and it already de-duplicates identical messages inside two
 * minutes, which is exactly the retried-POST case. Nothing here writes to `notifications` directly.
 *
 * NEVER BLOCKS THE DECISION IT ANNOUNCES. A failed notification is logged and swallowed: an approval
 * that was recorded and not announced is a person who has to look at the page; an approval that was
 * refused because a push endpoint was stale is a person who cannot work.
 */
async function notifyApprover(
  instance: WorkflowInstanceRow,
  approverUserId: string | null,
  subjectName: string | null,
): Promise<void> {
  if (!approverUserId) return;
  const label = domainLabel(instance.domain);
  const def = isWorkflowDomain(instance.domain) ? DOMAINS[instance.domain] : null;
  try {
    await sendPushToUser(approverUserId, {
      type: 'workflow_approval',
      title: label + ' approval needed',
      body: (subjectName || 'A colleague') + ' is waiting on your decision.',
      url: def?.approvalUrl || '/admin',
      tag: 'workflow-' + instance.id,
    });
  } catch (e: any) {
    logFail('notifyApprover', e);
  }
}

/** Tell the person who raised it that it settled. Same notifier, same never-block rule. */
async function notifyRequester(instance: WorkflowInstanceRow, state: WorkflowState): Promise<void> {
  if (!instance.requestedByUserId) return;
  const label = domainLabel(instance.domain);
  try {
    await sendPushToUser(instance.requestedByUserId, {
      type: 'workflow_settled',
      title: label + ' ' + STATE_LABELS[state].toLowerCase(),
      body: instance.summary || 'Your request has been decided.',
      url: '/portal/approvals',
      tag: 'workflow-' + instance.id,
    });
  } catch (e: any) {
    logFail('notifyRequester', e);
  }
}

/**
 * The audit hook. logAudit() (src/lib/audit.ts) is this codebase's audit log and this is the only
 * one written to — there is no workflow_events table, on purpose. logAudit already swallows its own
 * failures, so auditing can never block the decision it records.
 */
async function auditWorkflow(
  userId: string | null,
  action: string,
  instanceId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    userId: userId || null,
    action: 'workflow.' + action,
    entity: 'workflow_instance',
    entityId: instanceId,
    diff,
  });
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface StartWorkflowInput {
  domain: WorkflowDomain;
  /** The id of the row in the domain's own table. TEXT — the domains do not agree on an id type. */
  recordId: string;
  /** hr_employees.id — whose request this is. The graph is keyed on this, never on users.id. */
  subjectEmployeeId: string;
  /** users.id of whoever raised it, for the settled-notification. */
  requestedByUserId?: string | null;
  summary?: string | null;
  amount?: number | null;
  currency?: string | null;
  /** users.id of whoever pressed the button. */
  createdByUserId?: string | null;
}

/**
 * Put a request into approval.
 *
 * IDEMPOTENT ON (domain, record_id), TWICE OVER: this reads first and returns the existing instance
 * with `changed: false`, and the unique index in workflow-schema.ts rejects a concurrent second
 * insert that the read could not have seen. Two clicks on "send for approval" produce one approval.
 *
 * WHEN ROUTING FAILS, THE INSTANCE IS STILL CREATED — in state 'halted', carrying the sentence. It
 * is NOT left uncreated and it is NOT approved. Creating it is what makes the failure visible: a
 * halted row appears on the queue with a readable cause and can be resumed the moment somebody
 * records the missing relationship. Silently declining to create it would leave a request that
 * nobody is looking at and nothing is tracking, which is how things get lost for a fortnight.
 */
export async function startWorkflow(input: StartWorkflowInput): Promise<WorkflowResult> {
  const domain = String(input?.domain || '') as WorkflowDomain;
  if (!isWorkflowDomain(domain)) return { ok: false, error: 'That is not a request type we route.' };

  const recordId = String(input?.recordId || '').trim();
  if (!recordId) return { ok: false, error: 'That request has no id to attach an approval to.' };

  const subject = String(input?.subjectEmployeeId || '').trim();
  if (!isUuid(subject)) return { ok: false, error: 'That request is not linked to an employee record.' };

  const requestedBy = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;
  const createdBy = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;
  const summary = input?.summary ? String(input.summary).slice(0, 500) : null;
  const amount = typeof input?.amount === 'number' && isFinite(input.amount) ? input.amount : null;
  const currency = input?.currency ? String(input.currency).slice(0, 8) : null;

  try {
    await ensureWorkflowSchema();

    const existing = await instanceForRecord(domain, recordId);
    if (existing) {
      return {
        ok: true,
        instanceId: existing.id,
        state: existing.state as WorkflowState,
        changed: false,
        haltReason: existing.haltReason,
      };
    }

    const plan = await resolveRoute(domain, subject, { amount });
    const state: WorkflowState = plan.ok ? 'pending' : 'halted';

    // draft -> pending / draft -> halted. Asked rather than assumed, so this file has exactly one
    // definition of which state changes are legal and every write goes through it.
    const gate = canTransition('draft', state);
    if (!gate.ok) return { ok: false, error: gate.reason || WRITE_FAILED };

    // `ON CONFLICT DO NOTHING` with NO target, deliberately. Naming (domain, record_id) would make
    // this statement THROW on a database where that unique index failed to create — and the index
    // has its own try/catch in workflow-schema.ts precisely because it is allowed to fail without
    // taking the tables with it. The untargeted form covers whatever unique indexes actually exist
    // and degrades to an ordinary insert where none do, which is the documented weaker guarantee
    // rather than a 500 on somebody's screen.
    const ins = rows(await db.execute(sql`
      INSERT INTO workflow_instances
        (domain, record_id, subject_employee_id, requested_by_user_id, state, current_step,
         halt_reason, summary, amount, currency, created_by)
      VALUES
        (${domain}, ${recordId}, ${subject}::uuid, ${requestedBy}::uuid, ${state},
         ${plan.ok ? plan.approvers[0].step : 1}, ${plan.haltReason}::text, ${summary}::text,
         ${amount}::numeric, ${currency}::text, ${createdBy}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));

    if (!ins.length) {
      // The unique index won a race the read above could not see. Read the winner back and report
      // it as already-started rather than as a failure — the caller's intent was satisfied.
      const raced = await instanceForRecord(domain, recordId);
      if (raced) {
        return {
          ok: true,
          instanceId: raced.id,
          state: raced.state as WorkflowState,
          changed: false,
          haltReason: raced.haltReason,
        };
      }
      return { ok: false, error: WRITE_FAILED };
    }

    const instanceId = String(ins[0].id);

    if (plan.ok) {
      const def = DOMAINS[domain];
      const dueHours = def.escalateAfterHours;
      for (const a of plan.approvers) {
        await db.execute(sql`
          INSERT INTO workflow_steps
            (instance_id, step_no, mode, via, approver_employee_id, approver_user_id, decision, due_at)
          VALUES
            (${instanceId}::uuid, ${a.step}, ${a.mode}, ${a.via},
             ${a.employeeId}::uuid, ${a.userId}::uuid, 'pending',
             NOW() + (${dueHours} * INTERVAL '1 hour'))
          ON CONFLICT DO NOTHING`);
      }
    }

    const created = await getInstance(instanceId);

    if (plan.ok && created) {
      // Notify only the people the FIRST step is waiting on. Telling step 3's approver now would
      // train them to ignore the notification by the time it is actually their turn.
      const first = created.currentStep;
      for (const s of created.steps) {
        if (s.stepNo === first && s.decision === 'pending') {
          await notifyApprover(created, s.approverUserId, created.subjectName);
        }
      }
    }

    await auditWorkflow(createdBy, plan.ok ? 'start' : 'halt', instanceId, {
      domain,
      recordId,
      subjectEmployeeId: subject,
      state,
      haltReason: plan.haltReason,
      route: plan.approvers.map((a) => ({ step: a.step, via: a.via, employeeId: a.employeeId })),
    });

    return { ok: true, instanceId, state, changed: true, haltReason: plan.haltReason };
  } catch (e: any) {
    logFail('startWorkflow', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Decide one step.
 *
 * FIVE THINGS ARE TRUE BEFORE ANYTHING IS WRITTEN, and each refusal is a sentence:
 *   1. the instance exists and is still 'pending';
 *   2. this step is at the instance's CURRENT step number — an approver two rungs up cannot approve
 *      before the rung below them has;
 *   3. the step is still undecided (or was already decided the same way by the same person, which is
 *      a no-op and reported as success — see the idempotency note in this file's header);
 *   4. ROUTING already named somebody, and AUTHORIZATION (mayAct) says this actor may act;
 *   5. the resulting instance state change is a legal transition.
 *
 * THE READ AND THE WRITE CANNOT DISAGREE. The UPDATE repeats the precondition it was validated
 * against (`decision = 'pending'`), so a colleague who decided the same step a second earlier makes
 * this write touch zero rows and be reported as a concurrent change, rather than overwriting their
 * decision with this one.
 */
export async function decideStep(
  stepId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  decision: 'approved' | 'rejected',
  note: string = '',
): Promise<WorkflowResult> {
  if (!isUuid(stepId)) return { ok: false, error: NOT_AVAILABLE };
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: 'That is not a decision we record.' };
  }
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to decide this.' };
  const text = String(note || '').trim().slice(0, 2000);

  try {
    await ensureWorkflowSchema();

    const sr = rows(await db.execute(sql`
      SELECT s.* FROM workflow_steps s WHERE s.id = ${stepId}::uuid LIMIT 1`));
    if (!sr.length) return { ok: false, error: NOT_AVAILABLE };
    const step = mapStep(sr[0]);

    const instance = await getInstance(step.instanceId);
    if (!instance) return { ok: false, error: NOT_AVAILABLE };

    // ALREADY DECIDED. Two shapes, and they are not the same thing:
    //   - the same person made the same decision -> a retried POST. Success, changed: false.
    //   - anything else -> refuse, and say what it already is.
    if (step.decision !== 'pending') {
      if (step.decision === decision && step.decidedByUserId === actorId) {
        return { ok: true, instanceId: instance.id, state: instance.state as WorkflowState, changed: false };
      }
      return { ok: false, error: 'That step is already ' + step.decision + '.' };
    }

    if (instance.state !== 'pending') {
      return {
        ok: false,
        error: 'This request is already '
          + (STATE_LABELS[instance.state as WorkflowState] || instance.state).toLowerCase() + '.',
      };
    }

    if (step.stepNo !== instance.currentStep) {
      return { ok: false, error: 'This is waiting on an earlier approval. It will reach you when that one is done.' };
    }

    const allowed = await mayAct(user, instance.domain, {
      approverEmployeeId: step.approverEmployeeId,
      approverUserId: step.approverUserId,
    });
    if (!allowed.ok) return { ok: false, error: allowed.reason || NOT_AVAILABLE };

    const wrote = rows(await db.execute(sql`
      UPDATE workflow_steps
         SET decision = ${decision},
             decided_by_user_id = ${actorId}::uuid,
             decided_at = NOW(),
             acted_via = ${allowed.via}::text,
             note = ${text || null}::text
       WHERE id = ${stepId}::uuid
         AND decision = 'pending'
      RETURNING id`));

    if (!wrote.length) {
      // Zero rows after every check passed means the row changed underneath us. Say that, rather
      // than "not available", which reads as a permission problem and sends somebody to ask for
      // access they already have.
      return { ok: false, error: 'That approval changed while this page was open. Reload it and try again.' };
    }

    await auditWorkflow(actorId, decision === 'approved' ? 'step.approve' : 'step.reject', instance.id, {
      domain: instance.domain,
      recordId: instance.recordId,
      stepId,
      stepNo: step.stepNo,
      via: step.via,
      actedVia: allowed.via,
      note: text || null,
    });

    const settled = await advanceInstance(instance.id, actorId);
    return { ok: true, instanceId: instance.id, state: settled, changed: true };
  } catch (e: any) {
    logFail('decideStep', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Decide whatever step of this instance the signed-in person owes — the shape a screen actually
 * needs, because a person clicking "Approve" on a request does not know or care about step ids.
 *
 * Resolves to exactly one step: their pending step at the instance's current step number. If they
 * owe none, the refusal is the same sentence mayAct() would have given, so probing an instance id
 * cannot distinguish "not yours" from "already decided".
 */
export async function decideInstance(
  instanceId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  decision: 'approved' | 'rejected',
  note: string = '',
): Promise<WorkflowResult> {
  if (!isUuid(instanceId)) return { ok: false, error: NOT_AVAILABLE };
  const instance = await getInstance(instanceId);
  if (!instance) return { ok: false, error: NOT_AVAILABLE };
  if (instance.state !== 'pending') {
    return {
      ok: false,
      error: 'This request is already ' + (STATE_LABELS[instance.state as WorkflowState] || instance.state).toLowerCase() + '.',
    };
  }

  const live = instance.steps.filter((s) => s.stepNo === instance.currentStep && s.decision === 'pending');
  for (const s of live) {
    const allowed = await mayAct(user, instance.domain, {
      approverEmployeeId: s.approverEmployeeId,
      approverUserId: s.approverUserId,
    });
    if (allowed.ok) return decideStep(s.id, user, decision, note);
  }
  return {
    ok: false,
    error: 'This approval is waiting on someone else. You are not the approver it was routed to, '
      + 'and you are not standing in for them.',
  };
}

/**
 * Re-derive the instance state FROM ITS STEP ROWS and settle or advance it.
 *
 * DERIVED, NEVER INCREMENTED. current_step is recomputed from the rows on every call rather than
 * being bumped by whoever happened to approve last, so a double-fire cannot skip a rung and two
 * parallel approvers landing at the same moment cannot advance it twice.
 *
 * PARALLEL MEANS ALL OF THEM. A step is complete when every pending row at that step number is
 * approved — the department head AND the procurement owner, not whichever answered first. One
 * rejection anywhere ends the whole instance, and every remaining step is marked 'skipped' so nobody
 * is shown a decision that no longer matters.
 *
 * Returns the state the instance is now in.
 */
async function advanceInstance(instanceId: string, actorId: string | null): Promise<WorkflowState> {
  const instance = await getInstance(instanceId);
  if (!instance) return 'pending';
  const current = instance.state as WorkflowState;
  if (current !== 'pending') return current;

  const rejected = instance.steps.some((s) => s.decision === 'rejected');

  if (rejected) {
    const gate = canTransition('pending', 'rejected');
    if (!gate.ok) return current;
    await db.execute(sql`
      UPDATE workflow_steps SET decision = 'skipped'
       WHERE instance_id = ${instanceId}::uuid AND decision = 'pending'`);
    await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'rejected', settled_at = NOW(), updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'pending'`);
    await auditWorkflow(actorId, 'rejected', instanceId, {
      domain: instance.domain,
      recordId: instance.recordId,
    });
    await notifyRequester(instance, 'rejected');
    await settleDomainRecord(instance, 'rejected', actorId);
    return 'rejected';
  }

  const stillPending = instance.steps.filter((s) => s.decision === 'pending');

  if (stillPending.length === 0) {
    const gate = canTransition('pending', 'approved');
    if (!gate.ok) return current;
    await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'approved', settled_at = NOW(), updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'pending'`);
    await auditWorkflow(actorId, 'approved', instanceId, {
      domain: instance.domain,
      recordId: instance.recordId,
      steps: instance.steps.map((s) => ({ stepNo: s.stepNo, via: s.via, actedVia: s.actedVia })),
    });
    await notifyRequester(instance, 'approved');
    await settleDomainRecord(instance, 'approved', actorId);
    return 'approved';
  }

  // The lowest step number that still owes a decision IS the current step. Nothing is added; the
  // rows are simply read again.
  const next = Math.min(...stillPending.map((s) => s.stepNo));
  if (next !== instance.currentStep) {
    await db.execute(sql`
      UPDATE workflow_instances
         SET current_step = ${next}, updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'pending'`);
    for (const s of stillPending) {
      if (s.stepNo === next) await notifyApprover(instance, s.approverUserId, instance.subjectName);
    }
    await auditWorkflow(actorId, 'advance', instanceId, {
      domain: instance.domain,
      recordId: instance.recordId,
      toStep: next,
    });
  }
  return 'pending';
}

/**
 * WITHDRAW a request. Only the person who raised it, or somebody with the domain's standing
 * capability, and only before it settles.
 *
 * Not routed through mayAct(): cancelling is not an approval, and the approver a request was routed
 * TO has no business withdrawing somebody else's request.
 */
export async function cancelWorkflow(
  instanceId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  reason: string = '',
): Promise<WorkflowResult> {
  if (!isUuid(instanceId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to withdraw this.' };

  try {
    await ensureWorkflowSchema();
    const instance = await getInstance(instanceId);
    if (!instance) return { ok: false, error: NOT_AVAILABLE };

    const gate = canTransition(instance.state, 'cancelled');
    if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

    const def = isWorkflowDomain(instance.domain) ? DOMAINS[instance.domain] : null;
    const isRequester = !!instance.requestedByUserId && instance.requestedByUserId === actorId;
    const hasStanding = !!def?.capability && holdsCapability(user, def.capability);
    if (!isRequester && !hasStanding) {
      return { ok: false, error: 'Only the person who raised this can withdraw it.' };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'cancelled', settled_at = NOW(), updated_at = NOW(),
             halt_reason = ${String(reason || '').trim().slice(0, 500) || null}::text
       WHERE id = ${instanceId}::uuid AND state = ${instance.state}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request changed while this page was open. Reload it and try again.' };
    }
    await db.execute(sql`
      UPDATE workflow_steps SET decision = 'skipped'
       WHERE instance_id = ${instanceId}::uuid AND decision = 'pending'`);

    await auditWorkflow(actorId, 'cancelled', instanceId, {
      domain: instance.domain,
      recordId: instance.recordId,
      reason: String(reason || '').slice(0, 500) || null,
    });
    return { ok: true, instanceId, state: 'cancelled', changed: true };
  } catch (e: any) {
    logFail('cancelWorkflow', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Re-route a HALTED instance, once the missing relationship has been recorded.
 *
 * THIS IS WHAT MAKES HALTING SAFE. A halt is a pause with a stated cause, not a dead end: record the
 * manager, press resume, and the request carries on. If the graph STILL cannot name anybody, the
 * instance stays halted with the current reason — it is never nudged into 'approved' to get it
 * moving, which is the exact failure mode this whole design refuses.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST PROVIDE ONE. `user` is taken for the audit trail
 * only — unlike cancelWorkflow(), this does not test the requester or the domain capability. What
 * limits it is that it CANNOT DECIDE ANYTHING: it re-routes to whoever the graph names and leaves
 * the instance halted when the graph names nobody, so the worst a caller can do is re-route a
 * request to its correct approver. /admin/hr/leave/workflow gates it behind the `leave` section at
 * edit level. Any NEW caller must bring its own gate; there is none inside this function.
 */
export async function resumeWorkflow(
  instanceId: string,
  user: { id?: string | null } | null | undefined,
): Promise<WorkflowResult> {
  if (!isUuid(instanceId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim() || null;

  try {
    await ensureWorkflowSchema();
    const instance = await getInstance(instanceId);
    if (!instance) return { ok: false, error: NOT_AVAILABLE };
    if (instance.state !== 'halted') {
      return { ok: false, error: 'Only a halted request can be resumed. This one is ' + (STATE_LABELS[instance.state as WorkflowState] || instance.state).toLowerCase() + '.' };
    }
    if (!instance.subjectEmployeeId) {
      return { ok: false, error: HALT_NO_EMPLOYEE };
    }
    if (!isWorkflowDomain(instance.domain)) return { ok: false, error: NOT_AVAILABLE };

    const plan = await resolveRoute(instance.domain, instance.subjectEmployeeId, { amount: instance.amount });
    if (!plan.ok) {
      await db.execute(sql`
        UPDATE workflow_instances SET halt_reason = ${plan.haltReason}::text, updated_at = NOW()
         WHERE id = ${instanceId}::uuid AND state = 'halted'`);
      return { ok: false, error: plan.haltReason || NOT_AVAILABLE, haltReason: plan.haltReason };
    }

    const gate = canTransition('halted', 'pending');
    if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

    const def = DOMAINS[instance.domain];
    for (const a of plan.approvers) {
      await db.execute(sql`
        INSERT INTO workflow_steps
          (instance_id, step_no, mode, via, approver_employee_id, approver_user_id, decision, due_at)
        VALUES
          (${instanceId}::uuid, ${a.step}, ${a.mode}, ${a.via},
           ${a.employeeId}::uuid, ${a.userId}::uuid, 'pending',
           NOW() + (${def.escalateAfterHours} * INTERVAL '1 hour'))
        ON CONFLICT DO NOTHING`);
    }

    const first = Math.min(...plan.approvers.map((a) => a.step));
    await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'pending', current_step = ${first}, halt_reason = NULL, updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'halted'`);

    const resumed = await getInstance(instanceId);
    if (resumed) {
      for (const s of resumed.steps) {
        if (s.stepNo === first && s.decision === 'pending') {
          await notifyApprover(resumed, s.approverUserId, resumed.subjectName);
        }
      }
    }

    await auditWorkflow(actorId, 'resume', instanceId, {
      domain: instance.domain,
      recordId: instance.recordId,
      route: plan.approvers.map((a) => ({ step: a.step, via: a.via, employeeId: a.employeeId })),
    });
    return { ok: true, instanceId, state: 'pending', changed: true };
  } catch (e: any) {
    logFail('resumeWorkflow', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * ESCALATE a step nobody has answered — add the next person UP the reporting line as an ADDITIONAL
 * approver at the same rung.
 *
 * THE ORIGINAL APPROVER IS LEFT PENDING, deliberately. Escalation adds a second person who CAN act,
 * it does not take the decision away from the person whose decision it is; they may well be one day
 * back from leave. Either of them approving completes the rung, because the rung is complete when no
 * pending row remains at that step number and a decided row is not a pending one.
 *
 * WHERE THE ESCALATION TARGET COMES FROM: getReportingChain() on the SUBJECT — the next link above
 * the stalled approver — and, failing that, the subject's department head. Both from the graph.
 * WHEN THE GRAPH NAMES NOBODY ABOVE THEM, THE STEP STAYS EXACTLY AS IT IS and the refusal says so.
 * It is never auto-approved, never handed to a capability holder and never handed to a role.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST PROVIDE ONE. `user` is taken for the audit trail
 * only — unlike cancelWorkflow(), this does not test the requester or the domain capability. What
 * limits it is that it CANNOT DECIDE ANYTHING: it only ADDS an approver the graph already places
 * above the stalled one, leaves the original pending, and refuses to fire twice on one step.
 * /admin/hr/leave/workflow gates it behind the `leave` section at edit level. Any NEW caller must
 * bring its own gate; there is none inside this function.
 */
export async function escalateStep(
  stepId: string,
  user: { id?: string | null } | null | undefined,
): Promise<WorkflowResult> {
  if (!isUuid(stepId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim() || null;

  try {
    await ensureWorkflowSchema();
    const sr = rows(await db.execute(sql`
      SELECT * FROM workflow_steps WHERE id = ${stepId}::uuid LIMIT 1`));
    if (!sr.length) return { ok: false, error: NOT_AVAILABLE };
    const step = mapStep(sr[0]);
    if (step.decision !== 'pending') return { ok: false, error: 'That step is already ' + step.decision + '.' };

    const instance = await getInstance(step.instanceId);
    if (!instance) return { ok: false, error: NOT_AVAILABLE };
    if (instance.state !== 'pending') return { ok: false, error: 'This request is no longer waiting on anybody.' };
    if (!instance.subjectEmployeeId) return { ok: false, error: HALT_NO_EMPLOYEE };

    // Already escalated once. Escalating again would keep widening the circle every time somebody
    // pressed the button, which is how a private leave request ends up on six people's screens.
    const already = rows(await db.execute(sql`
      SELECT 1 AS ok FROM workflow_steps WHERE escalated_from_step_id = ${stepId}::uuid LIMIT 1`));
    if (already.length) return { ok: false, error: 'This has already been escalated once.' };

    if (!(await isInitialized())) {
      return { ok: false, error: HALT_NOT_INITIALIZED };
    }

    // The next link ABOVE the stalled approver, walking the subject's own reporting line.
    const chain = await getReportingChain(instance.subjectEmployeeId);
    let target: OrgPerson | null = null;
    const idx = chain.findIndex((c) => c.employeeId && c.employeeId === step.approverEmployeeId);
    if (idx >= 0 && idx + 1 < chain.length) target = chain[idx + 1];

    if (!target) {
      const dept = await subjectDepartmentId(instance.subjectEmployeeId);
      if (dept) {
        const head = await getDepartmentHead(dept);
        if (head?.employeeId && head.employeeId !== step.approverEmployeeId) target = head;
      }
    }

    // Never escalate to the subject themselves, and never to somebody already on this instance.
    const onInstance = new Set(
      instance.steps.map((s) => (s.approverEmployeeId || '').toLowerCase()).filter(Boolean),
    );
    onInstance.add(instance.subjectEmployeeId.toLowerCase());
    if (target?.employeeId && onInstance.has(target.employeeId.toLowerCase())) target = null;

    if (!target?.employeeId) {
      return {
        ok: false,
        error: 'There is nobody above them in the organization graph to escalate to. '
          + 'Record the missing relationship, or ask them directly.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO workflow_steps
        (instance_id, step_no, mode, via, approver_employee_id, approver_user_id,
         decision, due_at, escalated_from_step_id)
      VALUES
        (${instance.id}::uuid, ${step.stepNo}, 'sequential', 'reporting_manager',
         ${target.employeeId}::uuid, ${target.userId}::uuid, 'pending',
         NULL, ${stepId}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));

    if (!ins.length) {
      return { ok: false, error: 'That person already has this approval waiting on them.' };
    }

    await notifyApprover(instance, target.userId, instance.subjectName);
    await auditWorkflow(actorId, 'escalate', instance.id, {
      domain: instance.domain,
      recordId: instance.recordId,
      fromStepId: stepId,
      fromApproverEmployeeId: step.approverEmployeeId,
      toApproverEmployeeId: target.employeeId,
    });
    return { ok: true, instanceId: instance.id, state: 'pending', changed: true };
  } catch (e: any) {
    logFail('escalateStep', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE DOMAIN SETTLEMENT HOOK — how an approved workflow reaches the domain's own table.
// -------------------------------------------------------------------------------------------------

/**
 * Write the settled decision back to the domain record, for the domains that have somewhere to write
 * it. TODAY THAT IS LEAVE, AND ONLY LEAVE.
 *
 * WHY THIS IS NARROW AND GUARDED. src/lib/hr-leave.ts decideLeave() is untouched and remains the
 * ordinary path: it enforces through approverRole() and its reporting-manager arm still works
 * exactly as it does today. This is a SECOND, deliberately-started path, and it only ever touches a
 * leave row that is still 'pending' — so a request already decided the ordinary way is left exactly
 * as the person who decided it left it, and the two paths cannot overwrite each other.
 *
 * THE AUTHORISATION FOR THIS WRITE ALREADY HAPPENED, twice, before we got here: routing named the
 * approvers from the org graph and mayAct() checked each decider against Layer 2. `decided_by_role`
 * records 'workflow' rather than a role name, because no role decided this — a chain did, and the
 * chain is on the step rows.
 *
 * NEVER THROWS INTO THE CALLER. A settlement that cannot reach the domain table is logged and the
 * workflow still shows the correct decision; the alternative is an approval that appears to have
 * failed after it was already recorded.
 */
async function settleDomainRecord(
  instance: WorkflowInstanceRow,
  state: 'approved' | 'rejected',
  actorId: string | null,
): Promise<void> {
  if (instance.domain !== 'leave') return;
  if (!instance.recordId) return;
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_leave_request
         SET status = ${state},
             decided_by = ${actorId}::uuid,
             decided_by_role = 'workflow',
             decided_at = NOW(),
             decision_note = ${'Decided through the approval workflow (' + instance.id + ')'}
       WHERE id::text = ${instance.recordId}
         AND status = 'pending'
      RETURNING id, employee_id, leave_type, start_date, end_date`));

    if (!wrote.length) return; // already decided the ordinary way — leave it alone.

    if (state === 'approved') {
      // Approving leave has to reach attendance, or the two modules disagree about the same day:
      // payroll counts attendance, so an approved leave day with no attendance row is counted as
      // nothing at all. Same function the ordinary path calls, imported dynamically so this module
      // does not take a load-time dependency on the HR leave service.
      const { markLeaveAttendance } = await import('@/lib/hr-leave');
      await markLeaveAttendance(wrote[0]);
    }

    await auditWorkflow(actorId, 'settle.leave', instance.id, {
      recordId: instance.recordId,
      state,
    });
  } catch (e: any) {
    logFail('settleDomainRecord', e);
  }
}
