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
  // ---------------------------------------------------------------------------------------------
  // THE EMPLOYEE LIFECYCLE. Added, not forked.
  //
  // Every one of these four changes WHO REPORTS TO WHOM or WHAT SOMEONE IS, which is exactly the
  // class of change that must never be a bare UPDATE. They are declared HERE, in the one approval
  // engine, rather than in a second engine inside the HR modules: a lifecycle change routed by its
  // own private chain would be a parallel workflow system, and the two would disagree about who
  // approves a transfer within a month.
  //
  // Adding a member to this array is an ADDITIVE edit — DOMAINS below is
  // `Record<WorkflowDomain, DomainDefinition>`, so TypeScript refuses to compile until each new
  // domain has a real chain. There is no way to add a domain here and forget to route it.
  // ---------------------------------------------------------------------------------------------
  'contract',
  'transfer',
  'promotion',
  'separation',
  // ---------------------------------------------------------------------------------------------
  // PERFORMANCE. One domain, and deliberately only one.
  //
  // `appraisal` is the SIGN-OFF on a completed appraisal review — the moment a rating stops being a
  // draft in a manager's head and becomes something the employee is told and the record carries.
  //
  // THERE IS NO SECOND PROMOTION DOMAIN, and that absence is the design. A promotion recommendation
  // coming out of an appraisal routes through the `promotion` chain declared above — the lifecycle
  // console's chain, unchanged — because "who signs off a promotion" must have exactly one answer in
  // this product. The performance module namespaces its record id so the two cannot collide on
  // (domain, record_id); it does not fork the chain.
  // ---------------------------------------------------------------------------------------------
  'appraisal',
  // ---------------------------------------------------------------------------------------------
  // WORKPLACE SERVICES. Two domains, added with the helpdesk and the document library - and added
  // HERE rather than given an approval path of their own inside those modules.
  //
  // The two questions an asset request and a document sign-off ask are the two questions this file
  // already answers: "who approves this, for this person, right now" (routing, per row, from the
  // Organization Graph) and "may this signed-in user approve at all" (authorization, per user, from
  // capabilities). A second chain living in src/lib/helpdesk.ts would be a parallel workflow engine,
  // and the two would disagree about who signs off a laptop within a month.
  //
  // BOTH CARRY capability: null, DELIBERATELY. Only the person the graph routed to, or their
  // in-force delegate, may decide. helpdesk.manage, assets.manage and documents.manage are about
  // running those desks; none of them confers approval authority over another person's request, and
  // mapping one onto a domain here would hand every holder a standing sign-off nobody granted them.
  // ---------------------------------------------------------------------------------------------
  'helpdesk',
  'documents',
  // ---------------------------------------------------------------------------------------------
  // PAY. Three things payroll does that move money or change what somebody is, and not one of them
  // may be a direct write.
  //
  // `loan` covers BOTH a loan and a salary advance, ONE domain for the two, because they are the
  // same act with different words: the company hands over money now and recovers it from later pay
  // runs. src/lib/loans.ts holds them in ONE table with a `kind` discriminator for the same reason —
  // two tables would mean two recovery engines, and the second one to be written would be the one
  // that forgets to stop deducting when the balance clears.
  //
  // `bonus` is money going the other way, and it is NOT the same domain: a bonus is decided ABOUT
  // somebody rather than asked for BY them, so it starts at a different rung (see below).
  //
  // `confirmation` is the end of a probation — confirm, extend, or terminate. It changes whether a
  // person is permanently employed, which is precisely the class of change that must never be a bare
  // UPDATE on hr_probation.
  // ---------------------------------------------------------------------------------------------
  'loan',
  'bonus',
  'confirmation',
  // ---------------------------------------------------------------------------------------------
  // WORKING TIME. Two domains, added with the overtime and weekly-timesheet surfaces.
  //
  // BOTH ARE HERE RATHER THAN INSIDE src/lib/attendance.ts FOR ONE REASON: they are approvals, and
  // this file is the only approval engine in this codebase. An overtime claim decided by a rule
  // inside the attendance module would be a second engine, and within a month the two would
  // disagree about who signs off an evening's extra hours.
  //
  // WHY OVERTIME MUST BE AN APPROVAL AT ALL. Minutes beyond a shift are ARITHMETIC — a subtraction
  // of two numbers, one of which came from a phone that may have been left in a pocket. Turning
  // that subtraction straight into comp off or into pay would mean a clock somebody forgot to stop
  // becomes a day off or a day's wages. So the minutes are a number on a screen until a person
  // claims them and the reporting manager the Organization Graph names says yes.
  //
  // WHY A TIMESHEET IS AN APPROVAL AND NOT A SAVE. A submitted week is a person's own account of
  // what they did, and it is read by whoever bills or plans against it. Approving it is somebody
  // saying they recognise the week; without that it is a form that goes nowhere.
  // ---------------------------------------------------------------------------------------------
  'overtime',
  'timesheet',
  // ---------------------------------------------------------------------------------------------
  // BENEFITS. One domain, for ELECTING a benefit that has to be chosen — a cover level, an
  // allowance somebody opts into (src/lib/benefits.ts).
  //
  // ADDED HERE RATHER THAN GIVEN A PATH OF ITS OWN INSIDE THE BENEFITS MODULE, for the reason this
  // array's own header states: an election decided by a rule inside src/lib/benefits.ts would be a
  // second approval engine, and within a month the two would disagree about who signs off an
  // employee opting into cover.
  //
  // WHAT IS NOT HERE. Most benefits need no election at all — they apply to whoever the eligibility
  // rules cover, and the catalogue simply says how to claim them. Only a benefit HR marked as
  // needing an election starts one of these. Wrapping every entitlement in an approval would mean
  // nobody ever receives anything they are already owed.
  // ---------------------------------------------------------------------------------------------
  'benefits',
  // ---------------------------------------------------------------------------------------------
  // CREDIT. One domain, for the WEEK A MEASUREMENT DID NOT FULLY SUPPORT.
  //
  // One credit is one completed week. When the hours are there AND the week is complete, the credit
  // is granted automatically by src/lib/credit-week.ts and NOTHING comes here — an automatic grant
  // is not an approval and must never occupy an approver's queue.
  //
  // A workflow is started for the OTHER case, and only that case: the hours fell short, or a day was
  // never checked out of, or the reports or the tasks are not done. Somebody is then being credited
  // for a week the measurement did not fully support, which is exactly the kind of decision that
  // must have a named human and a written reason against it.
  //
  // ROUTED TO THE REPORTING MANAGER, per row, from the Organization Graph — never from users.role.
  // Where the graph names nobody the request HALTS and says which relationship is missing, which is
  // the sentence somebody can act on. `escalateStep()` moves it to the next link ABOVE them, which
  // is how "a more senior authority" reaches it without a second chain.
  //
  // capability: 'employee.manage' — AND THIS IS THE ONE DOMAIN BESIDES `leave` THAT CARRIES ONE.
  // The founder's correction names three people who may decide a shortfall week: the reporting
  // manager, HR, or somebody above them. The first is routing and the third is escalation; the
  // second is a STANDING AUTHORITY, and 'employee.manage' is the key that already means "runs the
  // HR desk" in permissions.ts (it is what gates /admin/hr and /admin/hr/completion/[id]). Mapping
  // it here grants nobody anything new — it lets the desk that owns the completion letter decide the
  // weeks that letter prints, and decideStep() records that they acted via standing authority rather
  // than as the named approver.
  // ---------------------------------------------------------------------------------------------
  'credit',
  // ---------------------------------------------------------------------------------------------
  // THE WEEK AN INTERN PROPOSES FOR THEMSELVES. src/lib/eims-schedule.ts.
  //
  // This is the FORWARD-LOOKING half of the internship record, and it is the opposite of a roster:
  // the intern says which activities they will do, on which days, for how many hours, and the
  // reporting manager agrees to it. Interns are university students, so any day of the week and any
  // distribution is legitimate; what is not legitimate is a week that commits more than the weekly
  // ceiling, which the module refuses before this domain is ever reached.
  //
  // ONE RUNG, THE REPORTING MANAGER, resolved per row from the Organization Graph. A plan for next
  // week that needs three signatures is a plan nobody signs, and the week simply passes.
  //
  // capability: null, DELIBERATELY, and unlike `credit`. Standing authority over somebody's weekly
  // credit exists because HR owns the completion letter that prints it. Nothing in permissions.ts
  // means "may agree what another person will work on next week" — that is the relationship the org
  // graph names, or nobody. Where it names nobody the request HALTS carrying the sentence that says
  // which link is missing, and escalateStep() reaches the person above them without a second chain.
  //
  // A MAKE-UP SCHEDULE IS THE SAME DOMAIN, not a second one: it is the same act (an intern proposing
  // hours, a manager agreeing) for a different reason, and splitting it would mean two chains that
  // eventually disagree about who plans an intern's week.
  // ---------------------------------------------------------------------------------------------
  'schedule',
  // ---------------------------------------------------------------------------------------------
  // A FEE WAIVER ON A PAID COURSE. src/lib/course-waiver.ts.
  //
  // THE SUBJECT OF THIS ONE IS NOT AN EMPLOYEE, AND USUALLY IS NOBODY THIS COMPANY KNOWS. A learner
  // who cannot afford a course fee asks for it to be waived. They have no manager, no department and
  // no hr_employees row, so THERE IS NO EDGE IN THE ORGANIZATION GRAPH THAT COULD ROUTE THIS. Every
  // other domain in this list routes off a relationship because every other domain is about somebody
  // who works here.
  //
  // WHY IT IS STILL IN THIS FILE RATHER THAN DECIDED INSIDE THE WAIVER MODULE. It is an approval:
  // somebody asks, somebody with authority answers, and the answer has to be recorded with who, when
  // and why. This codebase has exactly one engine for that, and a second one living in
  // src/lib/course-waiver.ts would be the parallel approval system every comment above refuses.
  //
  // WHAT ROUTES IT INSTEAD — read `subjectOptional` on DomainDefinition below before changing any of
  // this. The rung is the fee-waiver APPROVAL OWNER, resolved org-wide from the graph; where the
  // organisation has recorded nobody, the step is written against THE DESK rather than against a
  // person: no approver id, decidable only by a holder of the domain's standing capability
  // (`learning.waiver.grant`). That is not an auto-approval and it is not a halt — it is the honest
  // answer to "who decides a request from somebody outside the company", and the alternative is a
  // queue of learners' requests that nothing in this system could ever answer.
  'fee_waiver',
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
/**
 * THE CURRENCY EVERY `minAmount` BELOW IS WRITTEN IN.
 *
 * It was never stated anywhere, and the comparison in resolveRoute() was a bare `amount >= minAmount`
 * against instances that carry their own currency column — so a USD figure was measured against a
 * rupee threshold and came out small. Naming the unit does not convert anything; it makes the
 * mismatch DETECTABLE, which is what resolveRoute() needs in order to refuse to guess.
 *
 * If these thresholds are ever re-expressed in another currency, this constant moves with them and
 * every comparison follows. Declared here, above the route table that uses it — const is not hoisted.
 */
const ROUTE_THRESHOLD_CURRENCY = 'INR';

interface RouteRule {
  step: number;
  via: RouteVia;
  /**
   * When this rule resolves NOBODY, skip the rung instead of halting the request.
   *
   * DECLARED AT LAST. The doc block above this interface documents `optional`, twenty-odd route
   * literals below set it, and resolveRoute() reads `rule.optional` to decide between skipping a rung
   * and halting with "nobody is named" — but the interface never declared it, so the one property that
   * decides whether an unstaffed rung stops a request existed only by convention. Any reader outside
   * this file had to reach it through a structural cast, and a typo in a route literal would have been
   * silently ignored rather than refused at compile time.
   *
   * Additive: it is optional, every existing literal already conforms, and no behaviour changes.
   */
  optional?: boolean;
  /**
   * The rule applies at or above this figure, expressed in ROUTE_THRESHOLD_CURRENCY. An instance in
   * another currency, or one with no amount at all, cannot be compared and KEEPS the rung — see
   * resolveRoute().
   */
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
  /**
   * THE SUBJECT OF THIS DOMAIN IS NOT NECESSARILY AN EMPLOYEE. Default false, and it must stay false
   * for every domain about somebody who works here.
   *
   * Set on exactly one domain today (`fee_waiver`) and only ever legitimate where the requester is
   * outside the organisation altogether — a learner, an applicant, a member of the public. For those
   * people the Organization Graph holds NO row, so there is no reporting manager and no department
   * head to walk to; asking for one produces the halt sentence "this request is not linked to an
   * employee record", which is true and useless, forever.
   *
   * THREE THINGS FOLLOW, AND ALL THREE ARE ENFORCED IN resolveRoute():
   *
   *   1. ONLY `approval_owner` RUNGS ARE LEGAL. reporting_manager, department_head and
   *      executive_sponsor are all resolved relative to a subject employee; declaring one on a
   *      subject-optional domain is a programming error and halts rather than quietly resolving
   *      somebody else's manager.
   *   2. THE DOMAIN MUST DECLARE A `capability`. Without a subject there is no relationship, so the
   *      standing authority is the ONLY authority — a subject-optional domain with capability null
   *      would produce requests literally nobody in the product could decide.
   *   3. WHERE THE APPROVAL OWNER IS UNRECORDED THE STEP IS WRITTEN AGAINST THE DESK: approver ids
   *      NULL, and mayAct() admits only arm 3, the standing capability. It is not approved, it is
   *      not skipped, and it does not appear on any individual's routed queue — it sits pending on
   *      the domain's own console until a holder of that capability decides it.
   */
  subjectOptional?: boolean;
  route: RouteRule[];
  /**
   * Hours a pending step may sit before escalateStep() will consider it overdue. Escalation is never
   * automatic here — see escalateStep(); this only decides when a step is ELIGIBLE.
   */
  escalateAfterHours: number;
  /** Where a notification about this domain should send somebody. */
  approvalUrl: string;
  /**
   * Where the notification about a SETTLED request sends the person who raised it.
   *
   * notifyRequester() sent everybody to '/portal/approvals' — an APPROVER's queue. Somebody told
   * "Expense claim approved" or "Loan or salary advance rejected" tapped it and landed on a list of
   * other people's pending requests, which cannot show the decision they were just told about. Their
   * own request lives on their own page, and this is where that is named.
   *
   * Optional: a domain that does not set one keeps the previous destination, so nothing that has not
   * been checked is moved.
   */
  requesterUrl?: string;
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
    // WHERE THE ROUTED APPROVER CAN ACTUALLY DECIDE IT.
    //
    // This pointed at /admin/hr/leave/workflow, which is gated by the `leave` admin section. The
    // person the graph routes a leave request to is that employee's REPORTING MANAGER — an ordinary
    // employee who almost never holds an admin section — so the one person authorised to decide was
    // sent to a page that redirects them. /portal/approvals now carries every routed request the
    // reader may act on, whatever the domain, and decideStep() re-checks authority at the write.
    approvalUrl: '/portal/approvals',
    requesterUrl: '/portal/employee/leave',
  },
  // A single rung on purpose. An attendance correction is a small factual claim about one day; a
  // three-rung chain for it would mean nobody ever corrects anything.
  attendance: {
    key: 'attendance',
    label: 'Attendance correction',
    capability: null,
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 72,
    approvalUrl: '/portal/employee/attendance/approvals',
    requesterUrl: '/portal/employee/attendance',
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
    // The claim is decided at /portal/employee/expenses — src/lib/expenses.ts put the decision there
    // deliberately, precisely so the routed manager could reach it. The notification pointed at an
    // admin page that lists ONLY leave instances, so it named the one place the claim is not.
    approvalUrl: '/portal/employee/expenses',
    requesterUrl: '/portal/employee/expenses',
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
    // THE ROOM THE DECISION IS ACTUALLY IN.
    //
    // This pointed at /admin/hr/leave/workflow, which is wrong twice over. That page is gated by
    // canAccessSection(user, 'leave', 'edit'), which the ordinary employee the Organization Graph
    // routes a procurement request to almost never holds; and its list is listInstances({ domain:
    // 'leave' }), so even an HR account that followed the link would be shown leave requests and
    // nothing at all about the request they had just been asked to decide. The notification named a
    // room the approver could not enter, displaying somebody else's business.
    //
    // /portal/employee/procurement filters pendingForApprover() to this domain and is where the
    // decision genuinely lives.
    approvalUrl: '/portal/employee/procurement',
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
    // Same correction, and there is no recruitment-specific portal surface, so this goes to the
    // aggregate queue — /portal/approvals renders every routed step through pendingForApprover(),
    // including this one, and is reachable by the ordinary employee a department head is.
    approvalUrl: '/portal/approvals',
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
    approvalUrl: '/portal/employee/expenses',
    requesterUrl: '/portal/employee/expenses',
  },

  // ===============================================================================================
  // THE EMPLOYEE LIFECYCLE CHAINS.
  //
  // `capability: null` ON ALL FOUR, and it is the same narrow reading the five domains above use.
  // There is no existing capability in permissions.ts whose holders mean "may approve a promotion",
  // and mapping these onto `employee.manage` would hand every holder of the people console standing
  // authority to approve a transfer or an exit for anyone in the company — turning a per-ROW
  // relationship back into a per-USER grant, which is the precise defect the three-layer split
  // exists to remove. So ONLY the person the org graph actually routed to, or their in-force
  // delegate, may decide one of these. `employee.manage` still gates OPENING the consoles and
  // RECORDING a request; it does not decide one.
  //
  // WHY THE RUNGS ARE WHAT THEY ARE. A required rung that resolves nobody HALTS, and for these four
  // that is the correct outcome rather than an inconvenience: an exit or a reporting-line change
  // approved by nobody is the auto-approval this engine exists to make impossible.
  // ===============================================================================================

  // Renewing or amending an employment contract. The manager owns the working relationship; whoever
  // the organisation has named as the contract approval owner confirms the terms. The second rung is
  // optional because naming a contracts owner is a policy choice an organisation may not have made;
  // the first is not, because everybody has a manager or the graph is wrong.
  contract: {
    key: 'contract',
    label: 'Contract change',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 72,
    approvalUrl: '/admin/hr/contracts',
  },

  // Moving somebody between departments or under a new manager. BOTH rungs are required and neither
  // is optional: a transfer is the one change that rewrites the reporting edge itself, so the
  // manager releasing the person and the head of the department carrying them must each say yes. If
  // no department head is recorded, halting is the honest answer — the alternative is moving a
  // person into a department nobody has agreed to receive them into.
  transfer: {
    key: 'transfer',
    label: 'Transfer',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'department_head' },
      { step: 3, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 96,
    approvalUrl: '/admin/hr/transfers',
  },

  // Designation and grade. The manager proposes and the department head confirms — the head is
  // REQUIRED here because a promotion changes what somebody is on the record and, in most
  // organisations, what they cost; a manager alone deciding that is how grade inflation happens
  // quietly. The approval owner rung is optional for the usual reason.
  promotion: {
    key: 'promotion',
    label: 'Promotion',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'department_head' },
      { step: 3, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 96,
    approvalUrl: '/admin/hr/promotions',
  },

  // Somebody leaving. The reporting manager is the required rung; the separation approval owner is
  // optional. Approving a separation does NOT end it — it authorises the exit to proceed. The exit
  // itself only completes when clearance is signed off and the org-graph edges are closed, which is
  // a separate, explicit act on the separation console.
  separation: {
    key: 'separation',
    label: 'Separation',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 48,
    approvalUrl: '/admin/hr/separation',
  },

  // ===============================================================================================
  // APPRAISAL SIGN-OFF.
  //
  // WHY THE FIRST RUNG IS THE DEPARTMENT HEAD AND NOT THE REPORTING MANAGER — read this before
  // changing it. The manager is the person who WROTE the review and pressed the button. Routing the
  // sign-off back to them would be a rubber stamp with an audit trail: the engine would record an
  // approval, a screen would show a green state, and no second human would ever have looked at the
  // rating. That is the same class of failure as auto-approval, just slower. `recruitment` above is
  // the existing precedent for exactly this reasoning — its comment says the head is the first rung
  // because "the requester is often the manager".
  //
  // The head is REQUIRED, so a department with no recorded head HALTS with a readable sentence
  // rather than settling. The approval-owner rung is the calibration desk when an organisation has
  // named one (an `approval_owner` edge scoped to the domain 'appraisal'), and it is optional for
  // the same reason every other approval-owner rung is: naming one is a policy choice.
  //
  // `capability: null` — there is no capability in permissions.ts whose holders mean "may sign off
  // any appraisal". `performance.manage` gates RUNNING cycles and calibrating; making it standing
  // authority here would let the HR desk approve its own calibration, which is not a second look.
  // ===============================================================================================
  appraisal: {
    key: 'appraisal',
    label: 'Appraisal sign-off',
    capability: null,
    route: [
      { step: 1, via: 'department_head' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 120,
    approvalUrl: '/portal/approvals',
  },
  // An asset request raised on the helpdesk: somebody is asking the company to buy or issue them
  // equipment. The person who knows whether they need it is their own manager, so that is rung one;
  // rung two is whoever the organisation has named to own helpdesk approvals, and it is OPTIONAL
  // because naming one is a policy choice a small company may not have made. If neither resolves,
  // the request HALTS with the sentence - it is never issued because routing failed.
  //
  // Only the asset-request category starts one of these. An IT password reset is a job, not an
  // approval, and wrapping it in a chain would mean nobody could get their password reset until
  // their manager came back from leave.
  helpdesk: {
    key: 'helpdesk',
    label: 'Asset request',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 48,
    approvalUrl: '/admin/helpdesk',
  },
  // A document being signed off before it is published to the company. Same shape and the same
  // reasoning: the owner's manager first, then the documents approval owner if the organisation has
  // named one. A document CANNOT be published until this settles approved - src/lib/documents.ts
  // re-reads the instance at the write and refuses otherwise, so an unapproved policy cannot reach
  // the library by way of a second button.
  documents: {
    key: 'documents',
    label: 'Document approval',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 72,
    approvalUrl: '/portal/employee/documents',
  },

  // ===============================================================================================
  // PAY. THREE CHAINS, AND `capability: null` ON ALL THREE.
  //
  // `payroll.manage` exists and it is the key that opens the payroll consoles and sets salaries. It
  // is NOT standing authority to approve a loan, a bonus or a confirmation, and mapping it here
  // would hand the payroll desk the power to approve its own disbursement — a per-USER grant
  // silently replacing a per-ROW relationship, which is the exact defect the three-layer split
  // exists to remove. Only the person the graph routed to, or their in-force delegate, may decide.
  // ===============================================================================================

  // A LOAN OR A SALARY ADVANCE. The company hands money over now and recovers it from later pay.
  //
  // The manager is rung one because they are the person who knows the request is real and who will
  // still be managing the person while it is recovered. The approval owner — whoever the
  // organisation has named to own pay approvals — is rung two, and OPTIONAL for the usual reason:
  // naming one is a policy choice a small company may not have made.
  //
  // The executive rung above 200,000 mirrors `travel` exactly and is NOT optional. Above that
  // threshold the rung either resolves an executive sponsor or the request HALTS; it is never
  // skipped. A large sum leaving the company on nobody's authority is the outcome this engine
  // exists to make impossible, and "we could not find an executive" is a reason to stop, not a
  // reason to proceed.
  loan: {
    key: 'loan',
    label: 'Loan or salary advance',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
      { step: 3, via: 'executive_sponsor', minAmount: 200000 },
    ],
    escalateAfterHours: 72,
    // THE APPROVER COULD NOT OPEN THE ONLY SCREEN THAT OFFERED THE BUTTON.
    //
    // /admin/hr/payroll/loans is gated by `payroll.manage`, and `capability: null` above exists
    // precisely so that ONLY the person the graph routed to may decide — an ordinary employee who
    // almost never holds payroll.manage. So the loan sat 'pending' forever while the one authorised
    // person was pointed at a locked door. /portal/approvals now shows them the step and decides it
    // through the same decideStep() the admin console uses.
    approvalUrl: '/portal/approvals',
    requesterUrl: '/portal/employee/loans',
  },

  // A BONUS OR INCENTIVE.
  //
  // THE FIRST RUNG IS THE DEPARTMENT HEAD, NOT THE REPORTING MANAGER, and that is the same reasoning
  // `appraisal` and `recruitment` above already carry: a bonus is almost always PROPOSED by the
  // person's own manager, so routing the approval back to that manager would record an approval that
  // no second human ever looked at. The head is REQUIRED, so a department with no recorded head
  // halts with a readable sentence rather than paying somebody on nobody's say-so.
  //
  // A GROUP BONUS IS N AWARDS, NOT ONE. src/lib/payroll-bonuses.ts raises one award row per person
  // and starts one instance per award, because routing is resolved per ROW from the graph: twelve
  // people across three departments genuinely have three different approvers, and a single instance
  // would have to pick one of them and call it the answer for everybody.
  bonus: {
    key: 'bonus',
    label: 'Bonus or incentive',
    capability: null,
    route: [
      { step: 1, via: 'department_head' },
      { step: 2, via: 'approval_owner', optional: true },
      { step: 3, via: 'executive_sponsor', minAmount: 200000 },
    ],
    escalateAfterHours: 96,
    // Same inversion as `loan` above: the department head the graph routes to is not a payroll.manage
    // holder. The bonus console stays where it is; the DECISION is reachable from the portal queue.
    approvalUrl: '/portal/approvals',
    requesterUrl: '/portal/employee',
  },

  // THE END OF A PROBATION — confirm, extend, or terminate.
  //
  // Same shape as `separation`, and for the same reason: both settle whether somebody is employed
  // here. The reporting manager is required because they are the only person with first-hand
  // evidence of how the probation actually went, and a confirmation nobody vouched for is a
  // confirmation that happened because a date passed. The approval-owner rung is optional.
  //
  // The department head is NOT a rung here, deliberately, unlike `promotion`. A confirmation is the
  // ordinary end of a probation that happens for every single joiner, and making every one of them
  // wait on a department head that most departments have not recorded yet would mean nobody is ever
  // confirmed — which reads on the record as an entire workforce left on probation indefinitely.
  confirmation: {
    key: 'confirmation',
    label: 'Probation outcome',
    capability: null,
    route: [
      { step: 1, via: 'reporting_manager' },
      { step: 2, via: 'approval_owner', optional: true },
    ],
    escalateAfterHours: 72,
    approvalUrl: '/admin/hr/contracts/probation',
  },

  // ===============================================================================================
  // WORKING TIME. ONE RUNG EACH, AND capability: null ON BOTH.
  //
  // ONE RUNG, for the reason `attendance` above already gives: these are small factual claims about
  // days that have already happened, and a three-rung chain for "I stayed two hours late on Tuesday"
  // means nobody ever claims anything and the hours are simply lost.
  //
  // capability: null — there is no key in permissions.ts whose holders mean "may approve anybody's
  // overtime". `attendance.roster.manage` is about DEFINING working time (shifts, rosters, the
  // holiday list); mapping it here would hand every holder standing authority to sign off overtime
  // for the whole company, which is exactly the per-user reach the three-layer split removes. So
  // only the person the Organization Graph routed to, or their in-force delegate, may decide one.
  //
  // WHEN NOBODY CAN BE RESOLVED THE CLAIM HALTS and says which relationship is missing. It is never
  // auto-approved, and hr_overtime_requests has no status column of its own for anything to write a
  // pretend approval into.
  // ===============================================================================================
  overtime: {
    key: 'overtime',
    label: 'Overtime claim',
    capability: null,
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 72,
    approvalUrl: '/portal/employee/attendance/approvals',
  },
  timesheet: {
    key: 'timesheet',
    label: 'Weekly timesheet',
    capability: null,
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 96,
    approvalUrl: '/portal/employee/attendance/approvals',
  },

  // ===============================================================================================
  // ELECTING A BENEFIT.
  //
  // ONE RUNG, AND IT IS DELIBERATELY NOT THE REPORTING MANAGER. Read this before changing it.
  //
  // What somebody elects says things about them that are not their line manager's business: which
  // cover level they need says something about their health, and adding a dependant says something
  // about their family. Routing an election through the manager would make every one of those a
  // disclosure to the person who writes their appraisal, in exchange for a sign-off the manager has
  // no basis to give — they do not know what the policy costs or who it covers. So the rung is the
  // BENEFITS APPROVAL OWNER: an `approval_owner` edge scoped to the domain 'benefits', which is the
  // desk that actually administers the scheme.
  //
  // THE RUNG IS REQUIRED, NOT OPTIONAL, and that is the whole safety property. Where an organisation
  // has named nobody, every election HALTS with "no approval owner is recorded for this kind of
  // request" and waits on the queue until the founder records that one edge. The alternative — an
  // optional rung — would leave the chain empty, and resolveRoute() would then halt anyway rather
  // than settle it approved. Making it required simply says WHICH relationship is missing, which is
  // the sentence somebody can act on.
  //
  // `capability: null`, like every domain but `leave`. There is no key in permissions.ts whose
  // holders mean "may approve anybody's benefit election"; the key that opens the benefits console
  // is about CONFIGURING what the company offers, and mapping it here would let the desk that wrote
  // the policy approve people into it unilaterally.
  // ===============================================================================================
  benefits: {
    key: 'benefits',
    label: 'Benefit election',
    capability: null,
    route: [{ step: 1, via: 'approval_owner' }],
    escalateAfterHours: 96,
    approvalUrl: '/admin/hr/benefits/enrolments',
  },

  // ===============================================================================================
  // A WEEK'S CREDIT THE MEASUREMENT DID NOT FULLY SUPPORT. See the note in WORKFLOW_DOMAINS.
  //
  // ONE RUNG, for the reason `attendance`, `overtime` and `timesheet` above already give: this is a
  // small factual question about a week that has already happened, and a three-rung chain for it
  // means nobody ever decides one and the week is simply lost.
  //
  // approvalUrl is a PORTAL path, deliberately. The person this routes to is the intern's reporting
  // manager, who is very often an ordinary employee with no admin access at all; sending them to
  // /admin would send them to a redirect.
  // ===============================================================================================
  credit: {
    key: 'credit',
    label: 'Weekly credit',
    capability: 'employee.manage',
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 120,
    approvalUrl: '/portal/employee/credits/approvals',
    requesterUrl: '/portal/employee/credits',
  },

  // ===============================================================================================
  // A WEEK AN INTERN HAS PROPOSED FOR THEMSELVES. See the note in WORKFLOW_DOMAINS.
  //
  // ONE RUNG, and a SHORT clock: 48 hours. Unlike a credit week, which is a question about days that
  // have already happened and can wait, this is a plan for days that have not. A schedule approved
  // after the week it covers has started is worth less every hour it sits, so it becomes eligible for
  // escalation quickly — escalateStep() is still a person pressing a button, never automatic.
  //
  // BOTH URLs ARE PORTAL PATHS, deliberately. The approver is the intern's reporting manager, very
  // often an ordinary employee with no admin access at all; sending them to /admin would send them
  // to a redirect. requesterUrl is the intern's own schedule screen, which is the only place the
  // decision they were just told about can actually be read.
  // ===============================================================================================
  schedule: {
    key: 'schedule',
    label: 'Weekly schedule',
    capability: null,
    route: [{ step: 1, via: 'reporting_manager' }],
    escalateAfterHours: 48,
    approvalUrl: '/portal/employee/schedule/approvals',
    requesterUrl: '/portal/employee/schedule',
  },

  // ===============================================================================================
  // A COURSE FEE WAIVER. THE ONLY SUBJECT-OPTIONAL DOMAIN. See WORKFLOW_DOMAINS and `subjectOptional`
  // on DomainDefinition above; both explain why this one cannot be routed off a relationship.
  //
  // ONE RUNG, AND IT IS THE APPROVAL OWNER. An `approval_owner` edge scoped to the domain
  // 'fee_waiver' names the person who reads these requests, exactly as `benefits` does. It is
  // REQUIRED rather than optional, which for a subject-optional domain means: resolve the owner if
  // one is recorded, otherwise write the step against the desk. It never halts, because halting
  // would mean a learner's request sits with a sentence about an organisation chart they are not in.
  //
  // capability: 'learning.waiver.grant' — the domain's standing authority, and the one the phase
  // brief requires. It exists in src/lib/auth/permissions.ts (the union AND PERMS_BY_ROLE) and in
  // registry.ts BUILTIN_PERMISSIONS, where it is marked sensitive. A key outside the union is a
  // permanent 403, and a key that only Layer 2 knows about is a permanent silent refusal.
  //
  // WHAT THIS CAPABILITY STILL CANNOT DO: decide the holder's OWN request. src/lib/course-waiver.ts
  // refuses that before this engine is asked anything, and resolveRoute()'s `seen` set separately
  // prevents an employee-subject request from ever being routed to its own subject.
  //
  // A DECLINE IS A DECISION, NOT A DISAPPEARANCE. `rejected` is terminal here as everywhere, and the
  // waiver module writes the reason onto the request so the person who asked can read it.
  fee_waiver: {
    key: 'fee_waiver',
    label: 'Course fee waiver',
    capability: 'learning.waiver.grant',
    subjectOptional: true,
    route: [{ step: 1, via: 'approval_owner' }],
    escalateAfterHours: 120,
    approvalUrl: '/admin/course-waivers',
    requesterUrl: '/portal/course-waivers',
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
  /**
   * A STEP OWED BY A DESK RATHER THAN BY A NAMED PERSON.
   *
   * Only ever set for a `subjectOptional` domain (today: `fee_waiver`) whose approval owner is not
   * recorded in the Organization Graph. The step is written with NO approver ids, so mayAct() can
   * only admit arm 3 — the domain's standing capability — and pendingForApprover() will never put it
   * on anybody's personal queue, because it is nobody's personally.
   *
   * NULL EVERYWHERE ELSE. A domain about an employee whose rung resolves nobody HALTS, and that must
   * not change: "we could not find this person's manager" has an answer (record the relationship),
   * whereas "this learner has no manager" never will.
   */
  desk?: { step: number; via: RouteVia } | null;
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
 * ROUTING FOR A REQUEST WHOSE SUBJECT IS NOT AN EMPLOYEE — a learner asking for a course fee to be
 * waived. See `subjectOptional` on DomainDefinition for the three rules this enforces.
 *
 * It resolves ONE kind of rung: the domain-scoped approval owner, org-wide, from the Organization
 * Graph. It walks no reporting line, because the person who asked is not on one.
 *
 * IT NEVER HALTS FOR LACK OF AN OWNER, and that is the single difference from resolveRoute(). A halt
 * is the right answer when a relationship is MISSING and could be recorded; there is no relationship
 * to record between this company and a member of the public, so a halt here would be a permanent
 * dead end dressed up as a data problem. Instead the step is owed by the desk that holds the
 * domain's standing capability. Nothing is approved, nothing is skipped, and only a holder of that
 * capability can decide it.
 *
 * It DOES halt if the domain is misdeclared — a non-approval-owner rung, or no capability at all —
 * because both of those are programming errors that would otherwise produce a request nobody in the
 * product could ever decide.
 *
 * Declared ABOVE its only caller. `const` is not hoisted on this project and function order is kept
 * readable for the same reason.
 */
async function resolveDeskRoute(
  domain: WorkflowDomain,
  def: DomainDefinition,
  asOf: Date | null,
): Promise<RoutePlan> {
  if (!def.capability) {
    return {
      ok: false,
      initialized: false,
      approvers: [],
      desk: null,
      haltReason: HALT_PREFIX + 'this kind of request has no desk recorded that may decide it',
    };
  }

  // Whether the graph has any rows at all. It cannot change the outcome here — this route does not
  // depend on the requester being in it — but the field means one specific thing to the screens that
  // read it, and answering it with a guess would be the first lie in a chain of them.
  let initialized = false;
  try { initialized = await isInitialized(); } catch (e: any) { logFail('resolveDeskRoute.isInitialized', e); }

  const approvers: ResolvedApprover[] = [];
  let desk: { step: number; via: RouteVia } | null = null;

  for (const rule of def.route) {
    if (rule.via !== 'approval_owner') {
      return {
        ok: false,
        initialized,
        approvers: [],
        desk: null,
        haltReason: HALT_PREFIX + 'this request was not raised by an employee, so it cannot be sent up a reporting line',
      };
    }

    let owner: OrgPerson | null = null;
    try {
      owner = await getApprovalOwner(domain, asOf ? { asOf } : undefined);
    } catch (e: any) {
      // FAILS TO THE DESK, NOT TO NOBODY. A query that could not run must not silently produce an
      // unrouted request; the desk still owes the decision either way.
      logFail('resolveDeskRoute.getApprovalOwner', e);
      owner = null;
    }

    if (owner?.employeeId) {
      approvers.push({
        step: rule.step,
        mode: 'sequential',
        via: 'approval_owner',
        employeeId: owner.employeeId,
        userId: owner.userId || null,
        fullName: owner.fullName || null,
        designation: owner.designation || null,
      });
    } else if (!desk) {
      desk = { step: rule.step, via: 'approval_owner' };
    }
  }

  if (approvers.length === 0 && !desk) {
    return {
      ok: false,
      initialized,
      approvers: [],
      desk: null,
      haltReason: HALT_PREFIX + 'this kind of request has no rung to route',
    };
  }

  approvers.sort((a, b) => a.step - b.step);
  return { ok: true, initialized, approvers, desk, haltReason: null };
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
  opts: { amount?: number | null; currency?: string | null; asOf?: Date | null } = {},
): Promise<RoutePlan> {
  const def = DOMAINS[domain];
  if (!def) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_PREFIX + 'unknown request type' };
  }
  // A REQUEST FROM SOMEBODY WHO IS NOT IN THIS ORGANISATION AT ALL.
  //
  // Asked BEFORE the employee test below, because for these domains the absence of an employee
  // record is the ordinary case rather than a fault. Everything else in this function is unchanged
  // and unreachable from here: a subject-optional domain that IS given a real employee id falls
  // through to the normal relationship routing, which is what should happen when an employee asks
  // for a course fee to be waived.
  if (def.subjectOptional && !isUuid(subjectEmployeeId)) {
    return resolveDeskRoute(domain, def, opts.asOf ?? null);
  }

  if (!isUuid(subjectEmployeeId)) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_NO_EMPLOYEE };
  }

  // THE CHECK THAT MUST COME FIRST. An empty graph is not "this person has no manager".
  const initialized = await isInitialized();
  if (!initialized) {
    return { ok: false, initialized: false, approvers: [], haltReason: HALT_NOT_INITIALIZED };
  }

  // ===============================================================================================
  // WHICH RUNGS THIS AMOUNT ACTUALLY NEEDS — AND WHAT HAPPENS WHEN THE AMOUNT CANNOT BE COMPARED
  // ===============================================================================================
  //
  // This was `def.route.filter((r) => !r.minAmount || amount >= r.minAmount)` with `amount` defaulted
  // to 0, and it dropped approval rungs in two situations where nobody chose to drop them:
  //
  //   1. NO AMOUNT GIVEN. Every threshold rung silently vanished, so a caller that forgot the field
  //      got a shorter chain than the same request with the figure filled in. A missing figure is not
  //      evidence that a request is small.
  //   2. A DIFFERENT CURRENCY. The thresholds below (100000, 200000, 500000) are RUPEE figures, and
  //      the comparison was against a bare number. A USD 3,000 procurement request — roughly two and
  //      a half lakh — failed `3000 >= 200000`, so the executive-sponsor rung was dropped and a
  //      manager alone approved what a 200,001 rupee request could not have been.
  //
  // There is no exchange rate in this codebase and inventing one here would be a policy decision
  // dressed up as arithmetic. So when the figure cannot be compared, the rung is KEPT. That is the
  // safe direction and the only defensible one: the failure mode of keeping it is one more person
  // being asked to approve, which is visible and correctable; the failure mode of dropping it is
  // money leaving on fewer signatures than the organisation decided it needed, which nobody sees.
  //
  // A rung kept this way can still HALT if no executive sponsor is recorded. That is the documented
  // behaviour of a required rung, and a halt that says so is better than a quiet short chain.
  const amount = typeof opts.amount === 'number' && isFinite(opts.amount) ? opts.amount : null;
  const currency = opts.currency ? String(opts.currency).trim().toUpperCase() : null;
  const comparable = amount !== null && (!currency || currency === ROUTE_THRESHOLD_CURRENCY);
  const asOf = opts.asOf ?? null;
  const applicable = def.route.filter((r) => !r.minAmount || !comparable || (amount as number) >= r.minAmount);

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
 *
 * ...AND THAT IS EXACTLY WHY `onError` EXISTS. Failing closed is right; failing SILENTLY is not.
 * Every caller of this function received [] whether the queue was genuinely empty or the database
 * had refused the read, so `routedApprovals()` in src/lib/workforce/loaders.ts could only ever
 * return ok:true, `routedFailed` on /portal/employee could only ever be false, and the allSettled
 * machinery on /portal/approvals — written specifically so one dead reader could not print the
 * all-clear — could never observe a rejection because this function never rejects. A manager with a
 * fortnight of requests behind a broken read was told "Nothing is waiting on you", which is the one
 * sentence this whole queue exists to stop being wrong.
 *
 * `onError` changes NOTHING about the return value or about who sees what: the list is still [],
 * still fail-closed, and every existing call site is untouched. It only lets a caller that cares
 * find out that the answer it is holding is not an answer. It fires for a partial read too — if the
 * delegation resolution below fails, the routed rows still come back but they are missing everything
 * this person is standing in for, and a caller must be able to say so.
 *
 * The callback is invoked inside this function's own try/catch discipline: it must not throw, and a
 * throw from it is contained rather than turned into a failed read.
 */
export async function pendingForApprover(
  userId: string,
  opts?: { onError?: (e: unknown) => void },
): Promise<PendingApproval[]> {
  const uid = String(userId || '').trim();
  // Declared before every branch that uses it — `const` is not hoisted and a reporting-error helper
  // that throws on its first line would turn an honest degradation into an outage.
  const reportError = (e: unknown): void => {
    try { opts?.onError?.(e); } catch { /* a broken reporter must not break the read */ }
  };
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
        // A PARTIAL ANSWER IS NOT A COMPLETE ONE. The routed rows below will still be returned, but
        // anything addressed to somebody this person is standing in for is now invisible. Reported
        // so the surface can say the list is incomplete instead of presenting it as the whole queue.
        reportError(e);
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
    reportError(e);
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

/**
 * HOW MANY DECISIONS ARE SITTING WITH EACH APPROVER, ACROSS THE WHOLE ORGANIZATION, IN ONE QUERY.
 *
 * WHY IT LIVES HERE RATHER THAN ON A SURFACE. pendingForApprover() answers "what is waiting on THIS
 * person" and costs a round trip each time it is asked; a load view over a roster of forty-two people
 * would ask it forty-two times, and the honest alternative — a fresh SELECT over workflow_steps
 * written on the page that needed it — would be a second idea of what "pending" means, one status
 * rename away from disagreeing with the queue it claims to summarise. So the aggregate is written
 * once, here, from the same three clauses pendingForApprover() uses: decision = 'pending',
 * i.state = 'pending', and s.step_no = i.current_step. A step that is not the current step of a
 * pending instance is not waiting on anybody.
 *
 * IT IS A COUNT, NOT A QUEUE, AND IT AUTHORISES NOTHING. It returns no instance, no subject, no
 * summary and no amount — only how many decisions name each approver. Whether a person may decide
 * any of them is still mayAct()'s answer, asked per step by decideStep(), and nothing here is a
 * substitute for calling it.
 *
 * IT IS NOT SCOPED, AND THAT IS DELIBERATE. There is no viewer argument: the only caller is a
 * founder-gated console assembling a whole-organization load view, and inventing a scope argument
 * here would have meant inventing a second scope resolver beside the ones Layer 2 already owns. Any
 * new caller must establish for itself that its viewer may see the whole organization before asking.
 *
 * TWO KEYS, BECAUSE A STEP CARRIES TWO. Routing writes approver_employee_id when it resolved a person
 * through the graph and approver_user_id when it resolved an account, and either may be null. Both
 * are returned unchanged so a caller joins on whichever it holds, rather than this function guessing
 * which one a roster is keyed by.
 *
 * DELEGATION IS NOT FOLLOWED. pendingForApprover() adds the steps a person is standing in for, which
 * it resolves per step against the graph; that is a per-person question and cannot be answered in a
 * GROUP BY. A delegated step is therefore counted against the person it was ROUTED to, which is who
 * the row names. Say so on any surface that renders this beside a stand-in.
 *
 * LEAVE IS EXCLUDED, BY THE SAME RULE routedApprovals() STATES. A leave request exists twice — as an
 * hr_leave_request row and as a workflow step — so counting the step as well would show one person's
 * Tuesday as two waiting decisions. The excluded domains come back on the view so a caller can print
 * which ones, rather than describing the number from memory.
 *
 * ok:false ON FAILURE, NEVER AN EMPTY LIST. "Nobody is sitting on anything" and "we could not read
 * what anybody is sitting on" are opposite facts.
 */
export interface PendingStepCount {
  /** hr_employees.id the step was routed to, or null when it was routed to an account instead. */
  approverEmployeeId: string | null;
  /** users.id the step was routed to, or null when it was routed to an employee record instead. */
  approverUserId: string | null;
  /** Display only, and null when the employee row could not be named. Never used to decide anything. */
  approverName: string | null;
  pending: number;
  /** Of those, the ones whose due_at has passed. A step with no due_at is never late. */
  overdue: number;
  /** When the oldest of them started waiting. Rendered as "waiting since", never as a deadline. */
  oldestSince: string | null;
}

export interface PendingStepCountsView {
  /** False means the read did not happen — never render "nothing is waiting on anyone" on this. */
  ok: boolean;
  rows: PendingStepCount[];
  /** Domains deliberately left out of the count, by name, so a surface can say which. */
  excludedDomains: string[];
  /** The result hit the ceiling and was cut. Say so rather than shortening quietly. */
  truncated: boolean;
  error?: string;
}

/** Left out of pendingStepCountsByApprover(), for the reason stated above it. */
export const PENDING_COUNT_EXCLUDED_DOMAINS: readonly string[] = ['leave'];

export async function pendingStepCountsByApprover(limit = 500): Promise<PendingStepCountsView> {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const excludedDomains = [...PENDING_COUNT_EXCLUDED_DOMAINS];
  try {
    await ensureWorkflowSchema();
    const r = await db.execute(sql`
      SELECT s.approver_employee_id::text AS approver_employee_id,
             s.approver_user_id::text     AS approver_user_id,
             MAX(ae.full_name)            AS approver_name,
             COUNT(*)::int                AS pending,
             COUNT(*) FILTER (WHERE s.due_at IS NOT NULL AND s.due_at < NOW())::int AS overdue,
             MIN(s.created_at)::text      AS oldest_since
        FROM workflow_steps s
        JOIN workflow_instances i ON i.id = s.instance_id
        LEFT JOIN hr_employees ae ON ae.id = s.approver_employee_id
       WHERE s.decision = 'pending'
         AND i.state = 'pending'
         AND s.step_no = i.current_step
         AND i.domain <> 'leave'
         AND (s.approver_employee_id IS NOT NULL OR s.approver_user_id IS NOT NULL)
       GROUP BY s.approver_employee_id, s.approver_user_id
       ORDER BY COUNT(*) DESC
       LIMIT ${lim + 1}`);
    const list = rows(r);
    const truncated = list.length > lim;
    return {
      ok: true,
      truncated,
      excludedDomains,
      rows: list.slice(0, lim).map((row) => ({
        approverEmployeeId: row.approver_employee_id ? String(row.approver_employee_id) : null,
        approverUserId: row.approver_user_id ? String(row.approver_user_id) : null,
        approverName: row.approver_name ? String(row.approver_name) : null,
        pending: Number(row.pending) || 0,
        overdue: Number(row.overdue) || 0,
        oldestSince: row.oldest_since ? String(row.oldest_since) : null,
      })),
    };
  } catch (e: any) {
    logFail('pendingStepCountsByApprover', e);
    return {
      ok: false,
      rows: [],
      excludedDomains,
      truncated: false,
      error: String(e?.cause?.message || e?.message || 'unknown database error'),
    };
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
  // THE REQUESTER'S OWN PAGE, not the approver queue. See DomainDefinition.requesterUrl.
  const def = isWorkflowDomain(instance.domain) ? DOMAINS[instance.domain] : null;
  try {
    await sendPushToUser(instance.requestedByUserId, {
      type: 'workflow_settled',
      title: label + ' ' + STATE_LABELS[state].toLowerCase(),
      body: instance.summary || 'Your request has been decided.',
      url: def?.requesterUrl || '/portal/approvals',
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

  // THE SUBJECT IS REQUIRED FOR EVERY DOMAIN ABOUT SOMEBODY WHO WORKS HERE, and optional for the one
  // domain whose requester is a member of the public — see `subjectOptional` on DomainDefinition. The
  // test is the domain's own declaration, never the caller's word for it: a leave request arriving
  // with no employee id is still refused exactly as before.
  const subjectRaw = String(input?.subjectEmployeeId || '').trim();
  const subject: string | null = isUuid(subjectRaw) ? subjectRaw : null;
  if (!subject && !DOMAINS[domain].subjectOptional) {
    return { ok: false, error: 'That request is not linked to an employee record.' };
  }

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

    const plan = await resolveRoute(domain, subject || '', { amount, currency });
    const state: WorkflowState = plan.ok ? 'pending' : 'halted';

    // WHICH STEP IS LIVE THE MOMENT THIS IS CREATED. It used to be `plan.approvers[0].step`, which is
    // correct for every routed plan and throws on a desk-only one (no named approvers, one step owed
    // by the desk). Declared here, above the insert that reads it — `const` is not hoisted.
    const firstStep = plan.ok
      ? (plan.approvers.length ? plan.approvers[0].step : (plan.desk?.step || 1))
      : 1;

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
         ${firstStep}, ${plan.haltReason}::text, ${summary}::text,
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

      // THE DESK STEP. One row, no approver ids, and only for a subject-optional domain whose
      // approval owner is unrecorded (see resolveDeskRoute). mayAct() cannot admit anybody through
      // arms 1 or 2 against a step with no approver, so the ONLY way this is decided is the domain's
      // standing capability — which is precisely what "the desk decides it" has to mean if it is not
      // to become "anybody decides it".
      if (plan.desk) {
        await db.execute(sql`
          INSERT INTO workflow_steps
            (instance_id, step_no, mode, via, approver_employee_id, approver_user_id, decision, due_at)
          VALUES
            (${instanceId}::uuid, ${plan.desk.step}, 'sequential', ${plan.desk.via},
             NULL, NULL, 'pending',
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
      desk: plan.desk ? { step: plan.desk.step, via: plan.desk.via, capability: DOMAINS[domain].capability } : null,
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
    // THE GUARD WAS ALREADY RIGHT. ITS ANSWER WAS BEING THROWN AWAY.
    //
    // `AND state = 'pending'` means at most ONE caller can perform this transition — but the result
    // was never read, so every caller that raced here went on to audit, notify and settle anyway. Two
    // approvers deciding within the same second wrote two 'rejected' audit rows naming two different
    // actors and sent the requester the same notification twice. settleDomainRecord() happens to
    // carry its own status guard for the one domain that needs it, which is luck of that domain and
    // not a property of this function: any domain added there later without a guard would have the
    // settlement applied twice. RETURNING makes the write itself say whether THIS call is the one
    // that moved the state, and everything after it now depends on that answer.
    const didReject = rows(await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'rejected', settled_at = NOW(), updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'pending'
      RETURNING id`));
    if (!didReject.length) return 'rejected';
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
    // Same shape, same reason as the rejection branch above: exactly one caller may settle this
    // instance, and only that caller notifies the requester and applies the domain record.
    const didApprove = rows(await db.execute(sql`
      UPDATE workflow_instances
         SET state = 'approved', settled_at = NOW(), updated_at = NOW()
       WHERE id = ${instanceId}::uuid AND state = 'pending'
      RETURNING id`));
    if (!didApprove.length) return 'approved';
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

    // currency travels with the amount. Without it the thresholds in DOMAINS are compared against a
    // figure in an unknown unit, which is how a resumed foreign-currency request could come back with
    // a SHORTER chain than the one it halted on.
    const plan = await resolveRoute(instance.domain, instance.subjectEmployeeId, {
      amount: instance.amount, currency: instance.currency,
    });
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
 * ENTITLEMENT IS ASKED HERE, through mayAct() — the same Layer 2 entry point decideStep() uses.
 *
 * IT DID NOT USE TO BE. This function documented that it had no check and that "any NEW caller must
 * bring its own gate", and two new callers then arrived without one:
 * /portal/employee/schedule/approvals and /portal/employee/credits/approvals both pass a
 * form-supplied step id straight through behind nothing but requireEmployee(). Any signed-in
 * employee could post any step id, in any of the twenty workflow domains, and pull a stranger into
 * an approval circle — sending that person a notification naming somebody else's request.
 *
 * A contract that lives only in a comment is not a control. The check moved inside, so it holds for
 * every caller that exists and every caller that has not been written yet. It is deliberately the
 * SAME three arms as deciding — routed approver, their in-force delegate, or the domain's standing
 * capability — because escalation changes who may decide, which is the same class of power. The
 * admin callers (/admin/hr/leave/workflow, /admin/finance/invoices/[id]) pass through arm 3 exactly
 * as they did before, so their behaviour is unchanged.
 *
 * WHAT STILL LIMITS IT beyond entitlement: it CANNOT DECIDE ANYTHING. It only ADDS an approver the
 * graph already places above the stalled one, leaves the original pending, and refuses to fire twice
 * on one step.
 *
 * NOT ADMITTED, AND THAT IS A POLICY QUESTION RATHER THAN AN OVERSIGHT: the SUBJECT of the request
 * cannot escalate their own stalled approval. Letting them would widen the circle on their own
 * request, and this module's own note on double-escalation says why that is not a free action.
 */
export async function escalateStep(
  stepId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
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

    // ASKED BEFORE ANY OTHER STATE IS REVEALED. Placed immediately after the instance resolves and
    // ahead of the state, subject and already-escalated probes, so the refusal a stranger gets does
    // not differ by the request's condition — an error that changes with state is an oracle for
    // enumerating step ids, which is the shape of the hole this is closing.
    const allowed = await mayAct(user, instance.domain, {
      approverEmployeeId: step.approverEmployeeId,
      approverUserId: step.approverUserId,
    });
    if (!allowed.ok) return { ok: false, error: allowed.reason || NOT_AVAILABLE };

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
  if (!instance.recordId) return;

  // A COURSE FEE WAIVER SETTLES WHEREVER IT WAS DECIDED.
  //
  // Same shape and same reason as the leave arm below: the decision can be taken from the waiver
  // console, or from any surface that calls decideStep()/decideInstance(), and the REQUEST ITSELF has
  // to end up carrying the outcome either way. A settlement that only ran on one of those doors is
  // how a decided request keeps showing as "under review" to the person waiting on it.
  //
  // The waiver module owns the write, including the percentage granted and the reason; this file
  // does not know what a partial waiver is and must not learn.
  if (instance.domain === 'fee_waiver') {
    try {
      const { settleCourseWaiverFromWorkflow } = await import('@/lib/course-waiver');
      const settled = await settleCourseWaiverFromWorkflow(instance.recordId, state, actorId, instance.id);
      if (!settled.settled) return;
      await auditWorkflow(actorId, 'settle.fee_waiver', instance.id, {
        recordId: instance.recordId,
        state,
        grantPct: settled.grantPct ?? null,
        warning: settled.warning || null,
      });
    } catch (e: any) {
      logFail('settleDomainRecord.fee_waiver', e);
    }
    return;
  }

  if (instance.domain !== 'leave') return;
  try {
    // THE SETTLEMENT ITSELF BELONGS TO THE LEAVE MODULE, AND IT IS ONE FUNCTION RATHER THAN TWO.
    //
    // This used to write the status and stamp attendance inline, and it did neither of the two other
    // things a leave decision has to do. A comp-off request rejected HERE never got its credits back —
    // they are spent the moment the request is filed — so days somebody earned from approved overtime
    // were consumed against a request that was refused, with no reversal row and nothing on any screen
    // saying where they went. And nobody was told the outcome at all. The SAME rejection through
    // decideLeave() refunded correctly, so what happened to a person's comp off depended on which of
    // two doors the decision came through.
    //
    // src/lib/hr-leave.ts settleLeaveFromWorkflow() is now the single settlement: same 'pending'
    // guard, so a request already decided the ordinary way is still left exactly as it was left.
    // Imported dynamically so this module keeps no load-time dependency on the HR leave service.
    const { settleLeaveFromWorkflow } = await import('@/lib/hr-leave');
    const settled = await settleLeaveFromWorkflow(instance.recordId, state, actorId, instance.id);
    if (!settled.settled) return; // already decided the ordinary way — leave it alone.

    await auditWorkflow(actorId, 'settle.leave', instance.id, {
      recordId: instance.recordId,
      state,
      warning: settled.warning || null,
    });
  } catch (e: any) {
    logFail('settleDomainRecord', e);
  }
}
