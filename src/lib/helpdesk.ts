// src/lib/helpdesk.ts — THE EMPLOYEE HELPDESK. Tickets, an enforced state machine, and routing that
// comes from the Organization Graph rather than from a role name.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   THREADS      src/lib/request-threads.ts. `request_messages` is already keyed by
//                (request_type, request_id) and is already the generic thread store, so a ticket
//                conversation is rows in THAT table with request_type = 'helpdesk_ticket'. There is
//                no helpdesk_messages table. The only change made over there was widening two type
//                unions; the reader and the writer are the existing ones.
//   ROUTING      src/lib/org-graph.ts. "Who owns the IT desk" is a RELATIONSHIP - an approval_owner
//                edge scoped to 'helpdesk.it' - resolved per request through getApprovalOwner(), the
//                same resolver src/lib/workflow.ts walks for its approval_owner rungs. No query
//                against org_relationships appears in this file and none may.
//   APPROVAL     src/lib/workflow.ts. An asset request is an approval, so it starts a workflow
//                instance on the 'helpdesk' domain and is decided there, by the person the graph
//                routes it to. This file contains no approval chain of its own.
//   AUTHORIZATION src/lib/auth/permissions.ts through holdsCapability(). One capability,
//                `helpdesk.manage`, and it is asked for - never derived, never spelled as a role.
//   NOTIFICATION sendPushToUser() (src/lib/push.ts), which writes the in-app row AND the browser
//                push. AUDIT: logAudit() (src/lib/audit.ts). No second notifier, no second log.
//
// =================================================================================================
// THE STATE MACHINE. AN INVALID TRANSITION IS REFUSED, NOT IGNORED.
// =================================================================================================
//
// Same vocabulary as src/lib/employee-tasks.ts and src/lib/workflow.ts, deliberately, so that
// reading one teaches the others: an explicit state list, a TRANSITIONS map, a canTransition() that
// returns an OBJECT (`if (canTransition(a, b))` is always true and would wave everything through),
// refusals phrased as sentences a person can act on, and an UPDATE whose WHERE clause re-states the
// precondition it was validated against so a concurrent change loses the race instead of clobbering.
//
// =================================================================================================
// WHEN THE ORGANIZATION GRAPH IS EMPTY, ASSIGNMENT DOES NOT HAPPEN AND SAYS SO.
// =================================================================================================
//
// The graph carries no rows until the founder runs db/org-graph-backfill.sql. Until then no desk
// owner can be resolved, and the honest outcome is a ticket that stays `open` carrying the sentence
// explaining why - NOT a ticket auto-assigned to "whoever holds helpdesk.manage", which would be
// routing decided by authorization and would silently undo the whole migration. The ticket is still
// created, still visible, still repliable: a raised ticket nobody can find is worse than an
// unassigned one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import { holdsCapability } from '@/lib/auth/capability';
import { isInitialized, getApprovalOwner, employeeIdForUser } from '@/lib/org-graph';
import { getThread, postMessage, type RequestMessage } from '@/lib/request-threads';
import { startWorkflow, instanceForRecord, type WorkflowInstanceRow } from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that use it. `const` is not hoisted, and
// a const declared under its first use throws on the first line of whatever reads it; that pattern
// took down apply step 5 and the /admin/roles/diagnose Repair button on this project.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[helpdesk] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Shown when a write fails. Deliberately NOT the database's own words — those go to the log. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found/not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That ticket is not available.';

/** Every reason a desk owner could not be resolved starts with this, so the queue reads as one
 *  category rather than five unrelated errors. Same shape as workflow.ts HALT_PREFIX. */
const ROUTE_PREFIX = 'not assigned: ';
const ROUTE_NOT_INITIALIZED = ROUTE_PREFIX + 'organization graph not yet initialized';

const SUBJECT_MAX = 160;
const BODY_MAX = 5000;

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

export const TICKET_CATEGORIES = ['it', 'hr', 'finance', 'admin', 'asset_request'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(TICKET_CATEGORIES);
export function isTicketCategory(v: unknown): v is TicketCategory {
  return typeof v === 'string' && CATEGORY_SET.has(v);
}

/**
 * Plain words, from a FUNCTION rather than an exported `Record<string, string>`. A typed map read
 * inside .astro JSX is one of this project's known parse hazards, and every surface here renders in
 * an .astro file.
 */
export function categoryLabel(category: string): string {
  const k = String(category || '');
  if (k === 'it') return 'IT';
  if (k === 'hr') return 'HR';
  if (k === 'finance') return 'Finance';
  if (k === 'admin') return 'Admin';
  if (k === 'asset_request') return 'Asset request';
  return 'Request';
}

export function categoryHint(category: string): string {
  const k = String(category || '');
  if (k === 'it') return 'Laptop, accounts, access, software, connectivity.';
  if (k === 'hr') return 'Employment record, leave balance, policy, something you could not raise with your manager.';
  if (k === 'finance') return 'Reimbursements, payslip queries, invoices, vendor payments.';
  if (k === 'admin') return 'Workspace, facilities, travel and everything office-shaped.';
  if (k === 'asset_request') return 'Ask for equipment or a licence. This one needs an approval before it can be issued.';
  return '';
}

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
const PRIORITY_SET = new Set<string>(TICKET_PRIORITIES);

export function priorityLabel(p: string): string {
  const k = String(p || '');
  if (k === 'low') return 'Low';
  if (k === 'high') return 'High';
  if (k === 'urgent') return 'Urgent';
  return 'Normal';
}

/**
 * THE STATES.
 *
 *   open         raised, nobody owns it yet. Either routing found no desk owner, or it has just
 *                been created and assignment is about to run.
 *   assigned     a named person owns it. NOT "somebody with the capability" — a person, on the row.
 *   in_progress  that person has started. This is the state that makes "nothing is happening"
 *                distinguishable from "nobody has looked at it", which is the complaint every
 *                helpdesk actually receives.
 *   resolved     the desk believes it is done. NOT terminal: the person who raised it decides.
 *   closed       terminal.
 */
export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function statusLabel(s: string): string {
  const k = String(s || '');
  if (k === 'open') return 'Open';
  if (k === 'assigned') return 'Assigned';
  if (k === 'in_progress') return 'In progress';
  if (k === 'resolved') return 'Resolved';
  if (k === 'closed') return 'Closed';
  return 'Unknown';
}

/**
 * from -> the states it may move to. Read the absences, they are deliberate:
 *
 *   - NOTHING LEAVES `closed`. A closed ticket is a record of an exchange that happened; reopening
 *     one would rewrite it. A recurrence is a NEW ticket, which is also how hr_leave_request behaves
 *     when a rejected request is re-submitted.
 *   - `resolved -> in_progress` IS here. "You have not actually fixed it" is the single most common
 *     thing a requester needs to be able to say, and a helpdesk that makes them raise a second
 *     ticket to say it loses the history of the first.
 *   - `assigned -> open` IS here: handing a ticket back to the queue is a real act, and it must not
 *     be spelled by deleting the assignee behind the state's back.
 *   - THERE IS NO EDGE FROM `open` TO `in_progress`. Somebody must own a ticket before they can be
 *     working on it, or "in progress" means nothing to the person waiting.
 */
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['assigned', 'closed'],
  assigned: ['in_progress', 'open', 'resolved', 'closed'],
  in_progress: ['resolved', 'assigned', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

export interface TransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
  /** Where this state CAN go, so a screen can say what is possible instead of only refusing. */
  allowed: TicketStatus[];
}

/**
 * May this ticket move from one state to the other?
 *
 * READ THIS BEFORE CALLING IT: it returns an OBJECT, not a boolean. `if (canTransition(a, b))` is
 * always true and would wave every move through — the same trap employee-tasks.ts and workflow.ts
 * document on their own canTransition, spelled the same way here on purpose.
 */
export function canTransition(from: string, to: string): TransitionCheck {
  const a = (TICKET_STATUSES as readonly string[]).indexOf(String(from)) >= 0 ? (from as TicketStatus) : null;
  const b = (TICKET_STATUSES as readonly string[]).indexOf(String(to)) >= 0 ? (to as TicketStatus) : null;

  if (!a) return { ok: false, reason: 'That ticket is in a state this helpdesk does not recognise.', allowed: [] };
  if (!b) return { ok: false, reason: 'That is not a state we track.', allowed: [] };
  if (a === b) return { ok: false, reason: 'It is already ' + statusLabel(b).toLowerCase() + '.', allowed: [] };

  const allowed = TRANSITIONS[a] || [];
  if (allowed.indexOf(b) < 0) {
    return {
      ok: false,
      allowed,
      reason: allowed.length
        ? statusLabel(a) + ' does not move to ' + statusLabel(b) + '. From here it can go to: '
          + allowed.map((s) => statusLabel(s).toLowerCase()).join(', ') + '.'
        : statusLabel(a) + ' is final; it does not move to ' + statusLabel(b) + '.',
    };
  }
  return { ok: true, reason: null, allowed };
}

/** The same question as a plain predicate, for callers that only need a yes or no. */
export function isAllowedTransition(from: string, to: string): boolean {
  return canTransition(from, to).ok;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, and asserted column by column.
// -------------------------------------------------------------------------------------------------

/**
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS — which
 * is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
 * table, locking every administrator out of /admin for a day. Every column past the primary key is
 * therefore asserted again with ADD COLUMN IF NOT EXISTS.
 *
 * ensureOnce() memoises the in-flight promise per process and DELETES the cache entry if the
 * callback rejects, so a transient failure retries on the next call instead of poisoning the process
 * — which is why the catch below RE-THROWS after logging.
 */
export function ensureHelpdeskSchema(): Promise<void> {
  return ensureOnce('helpdesk_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS helpdesk_tickets (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_no              BIGSERIAL,
        category               TEXT NOT NULL,
        subject                TEXT NOT NULL,
        body                   TEXT NOT NULL DEFAULT '',
        priority               TEXT NOT NULL DEFAULT 'normal',
        status                 TEXT NOT NULL DEFAULT 'open',
        requester_user_id      UUID,
        requester_employee_id  UUID,
        assignee_employee_id   UUID,
        assignee_user_id       UUID,
        assigned_via           TEXT,
        route_note             TEXT,
        asset_kind             TEXT,
        workflow_instance_id   UUID,
        resolution             TEXT,
        assigned_at            TIMESTAMPTZ,
        first_response_at      TIMESTAMPTZ,
        resolved_at            TIMESTAMPTZ,
        closed_at              TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      for (const q of [
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS ticket_no BIGSERIAL`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS requester_user_id UUID`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS requester_employee_id UUID`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS assignee_employee_id UUID`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS assignee_user_id UUID`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS assigned_via TEXT`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS route_note TEXT`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS asset_kind TEXT`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS workflow_instance_id UUID`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS resolution TEXT`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        sql`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      // NO CHECK CONSTRAINT on category, status or priority, and no foreign keys — the same three
      // reasons workflow-schema.ts gives: this project has no migration runner, so a CHECK could
      // never be widened to admit a new category; the vocabulary is enforced in TypeScript above;
      // and a foreign key to hr_employees would take a ticket's history with the employee row.

      // The queue: "what is open, oldest first" and "what is on this desk".
      await db.execute(sql`CREATE INDEX IF NOT EXISTS helpdesk_tickets_status_idx
        ON helpdesk_tickets (status, category, created_at DESC)`);
      // "My tickets" — the employee surface, which is the one that loads on a phone.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS helpdesk_tickets_requester_idx
        ON helpdesk_tickets (requester_employee_id, created_at DESC)`);
      // "What is waiting on me" — the agent surface.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS helpdesk_tickets_assignee_idx
        ON helpdesk_tickets (assignee_employee_id, status, created_at DESC)`);
    } catch (e: any) {
      logFail('ensureHelpdeskSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface Ticket {
  id: string;
  ref: string;
  category: string;
  subject: string;
  body: string;
  priority: string;
  status: string;
  requesterUserId: string | null;
  requesterEmployeeId: string | null;
  requesterName: string | null;
  assigneeEmployeeId: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assignedVia: string | null;
  routeNote: string | null;
  assetKind: string | null;
  workflowInstanceId: string | null;
  resolution: string | null;
  assignedAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TicketResult {
  ok: boolean;
  id?: string;
  ref?: string;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
  error?: string;
  /** Set when routing could not name a desk owner. The sentence, verbatim. */
  routeNote?: string | null;
}

/** The three SLA facts this helpdesk RECORDS. It does not claim a target for any of them. */
export interface TicketSla {
  createdAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Minutes from raised to the desk's first reply. Null until somebody answers. */
  firstResponseMinutes: number | null;
  /** Minutes from raised to resolved. Null until it is resolved. */
  resolutionMinutes: number | null;
}

function ticketRef(no: any): string {
  const n = Number(no);
  return 'HD-' + (isFinite(n) && n > 0 ? String(n).padStart(5, '0') : '00000');
}

function mapTicket(r: any): Ticket {
  return {
    id: String(r?.id ?? ''),
    ref: ticketRef(r?.ticket_no),
    category: String(r?.category ?? ''),
    subject: String(r?.subject ?? ''),
    body: String(r?.body ?? ''),
    priority: String(r?.priority ?? 'normal'),
    status: String(r?.status ?? 'open'),
    requesterUserId: r?.requester_user_id ? String(r.requester_user_id) : null,
    requesterEmployeeId: r?.requester_employee_id ? String(r.requester_employee_id) : null,
    requesterName: r?.requester_name ? String(r.requester_name) : null,
    assigneeEmployeeId: r?.assignee_employee_id ? String(r.assignee_employee_id) : null,
    assigneeUserId: r?.assignee_user_id ? String(r.assignee_user_id) : null,
    assigneeName: r?.assignee_name ? String(r.assignee_name) : null,
    assignedVia: r?.assigned_via ? String(r.assigned_via) : null,
    routeNote: r?.route_note ? String(r.route_note) : null,
    assetKind: r?.asset_kind ? String(r.asset_kind) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    resolution: r?.resolution ? String(r.resolution) : null,
    assignedAt: iso(r?.assigned_at),
    firstResponseAt: iso(r?.first_response_at),
    resolvedAt: iso(r?.resolved_at),
    closedAt: iso(r?.closed_at),
    createdAt: iso(r?.created_at),
    updatedAt: iso(r?.updated_at),
  };
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : null;
}

/**
 * THE SLA FACTS, REPORTED AND NOT JUDGED.
 *
 * There is no target here and none is invented: nothing in this product records what the company has
 * promised for a first response or a fix, and a screen that invented "4 hours" would be presenting a
 * number nobody agreed to as a commitment somebody is failing. When a target is agreed it belongs in
 * a settings row, alongside a surface that sets it — at which point this function gains a second
 * field and every caller keeps working.
 */
export function ticketSla(t: Ticket): TicketSla {
  return {
    createdAt: t.createdAt,
    firstResponseAt: t.firstResponseAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    firstResponseMinutes: minutesBetween(t.createdAt, t.firstResponseAt),
    resolutionMinutes: minutesBetween(t.createdAt, t.resolvedAt),
  };
}

/** "3 h 12 m" / "2 d 4 h" / "18 m". Plain words for a phone-width column. */
export function formatMinutes(mins: number | null): string {
  if (mins === null || !isFinite(mins)) return 'not yet';
  if (mins < 60) return mins + ' m';
  if (mins < 60 * 24) return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' m';
  const d = Math.floor(mins / (60 * 24));
  return d + ' d ' + Math.floor((mins % (60 * 24)) / 60) + ' h';
}

// -------------------------------------------------------------------------------------------------
// ROUTING — LAYER 1'S ANSWER. Which desk owns this, and who is that today?
// -------------------------------------------------------------------------------------------------

export interface DeskRoute {
  ok: boolean;
  initialized: boolean;
  employeeId: string | null;
  userId: string | null;
  fullName: string | null;
  /** The org-graph scope the owner was found under, for a screen that wants to explain the routing. */
  scope: string | null;
  /** Present exactly when ok is false. A sentence, rendered verbatim. */
  routeNote: string | null;
}

/**
 * WHO OWNS THIS DESK, RIGHT NOW.
 *
 * An approval_owner edge scoped to 'helpdesk.<category>', with a fall back to the org-wide
 * 'helpdesk' scope for a company that runs one desk rather than five. This is the SAME mechanism
 * src/lib/workflow.ts uses for its executive rung ('<domain>.executive'): getApprovalOwner()'s
 * `domain` argument is a free string held in scope_id, as its own docblock states, and expressing a
 * per-desk owner that way means no second relationship type and no second query.
 *
 * isInitialized() IS CHECKED FIRST AND SEPARATELY, because "the graph has no rows at all" and "no
 * owner is recorded for the IT desk" are different facts that need different sentences. A screen
 * that shows the second when the first is true sends the founder hunting for a data problem that
 * does not exist.
 *
 * THERE IS NO FALLBACK TO A CAPABILITY HOLDER OR A ROLE. If the graph names nobody, the answer is
 * "nobody", and the ticket stays open saying so.
 */
export async function resolveDeskRoute(category: string, subjectEmployeeId?: string | null): Promise<DeskRoute> {
  const cat = String(category || '').trim();
  if (!isTicketCategory(cat)) {
    return { ok: false, initialized: false, employeeId: null, userId: null, fullName: null, scope: null,
      routeNote: ROUTE_PREFIX + 'that is not a desk we route to' };
  }

  let initialized = false;
  try {
    initialized = await isInitialized();
  } catch (e: any) {
    logFail('resolveDeskRoute.isInitialized', e);
    initialized = false;
  }
  if (!initialized) {
    return { ok: false, initialized: false, employeeId: null, userId: null, fullName: null, scope: null,
      routeNote: ROUTE_NOT_INITIALIZED };
  }

  const forEmployee = isUuid(subjectEmployeeId) ? String(subjectEmployeeId) : null;
  const scoped = 'helpdesk.' + cat;
  let owner = null;
  let scope: string | null = null;
  try {
    owner = await getApprovalOwner(scoped, { employeeId: forEmployee });
    if (owner) scope = scoped;
    if (!owner) {
      owner = await getApprovalOwner('helpdesk', { employeeId: forEmployee });
      if (owner) scope = 'helpdesk';
    }
  } catch (e: any) {
    logFail('resolveDeskRoute.getApprovalOwner', e);
    owner = null;
  }

  if (!owner?.employeeId) {
    return {
      ok: false,
      initialized: true,
      employeeId: null,
      userId: null,
      fullName: null,
      scope: null,
      routeNote: ROUTE_PREFIX + 'no owner is recorded in the organization graph for the '
        + categoryLabel(cat) + ' desk (approval_owner, scope ' + scoped + ')',
    };
  }

  return {
    ok: true,
    initialized: true,
    employeeId: owner.employeeId,
    userId: owner.userId || null,
    fullName: owner.fullName || null,
    scope,
    routeNote: null,
  };
}

// -------------------------------------------------------------------------------------------------
// AUTHORIZATION — LAYER 2'S ANSWER, asked SECOND and never instead.
// -------------------------------------------------------------------------------------------------

export type TicketActedVia = 'requester' | 'assignee' | 'capability';

export interface TicketActorCheck {
  ok: boolean;
  via: TicketActedVia | null;
  /** Null when ok. A sentence for a person. */
  reason: string | null;
}

/**
 * MAY THIS PERSON SEE THIS TICKET?
 *
 * Three ways, in order of narrowness: they raised it, it is assigned to them, or they hold
 * `helpdesk.manage`. Nothing else, and no role name anywhere.
 *
 * FAILS CLOSED. Any error resolving the actor's employee id answers "no": somebody refused once asks
 * why, somebody admitted because a query failed reads a colleague's HR ticket.
 */
export async function mayViewTicket(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  ticket: Ticket,
): Promise<TicketActorCheck> {
  const userId = String(user?.id || '').trim();
  if (!userId) return { ok: false, via: null, reason: 'Sign in to see this.' };

  if (ticket.requesterUserId && ticket.requesterUserId === userId) {
    return { ok: true, via: 'requester', reason: null };
  }
  if (ticket.assigneeUserId && ticket.assigneeUserId === userId) {
    return { ok: true, via: 'assignee', reason: null };
  }

  let actorEmployeeId: string | null = null;
  try {
    actorEmployeeId = await employeeIdForUser(userId);
  } catch (e: any) {
    logFail('mayViewTicket.employeeIdForUser', e);
    actorEmployeeId = null;
  }
  if (actorEmployeeId) {
    if (ticket.requesterEmployeeId === actorEmployeeId) return { ok: true, via: 'requester', reason: null };
    if (ticket.assigneeEmployeeId === actorEmployeeId) return { ok: true, via: 'assignee', reason: null };
  }

  if (holdsCapability(user, 'helpdesk.manage')) return { ok: true, via: 'capability', reason: null };

  return { ok: false, via: null, reason: NOT_AVAILABLE };
}

/**
 * MAY THIS PERSON WORK THIS TICKET — assign it, move it, resolve it?
 *
 * The assignee (a RELATIONSHIP to one ticket, written when it was routed) or a holder of
 * `helpdesk.manage` (STANDING AUTHORITY over every desk). The REQUESTER is deliberately not here:
 * raising a ticket does not entitle you to mark it fixed. What a requester may do is reply, close
 * their own ticket, and send a resolved one back — each handled by its own function below, each
 * with its own check.
 */
export async function mayWorkTicket(
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  ticket: Ticket,
): Promise<TicketActorCheck> {
  const userId = String(user?.id || '').trim();
  if (!userId) return { ok: false, via: null, reason: 'Sign in to do that.' };

  if (ticket.assigneeUserId && ticket.assigneeUserId === userId) {
    return { ok: true, via: 'assignee', reason: null };
  }
  let actorEmployeeId: string | null = null;
  try {
    actorEmployeeId = await employeeIdForUser(userId);
  } catch (e: any) {
    logFail('mayWorkTicket.employeeIdForUser', e);
    actorEmployeeId = null;
  }
  if (actorEmployeeId && ticket.assigneeEmployeeId && ticket.assigneeEmployeeId === actorEmployeeId) {
    return { ok: true, via: 'assignee', reason: null };
  }
  if (holdsCapability(user, 'helpdesk.manage')) return { ok: true, via: 'capability', reason: null };

  return {
    ok: false,
    via: null,
    reason: 'This ticket is on somebody else\'s desk. You are not the person it was assigned to.',
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

const TICKET_SELECT = sql`
  t.*, re.full_name AS requester_name, ae.full_name AS assignee_name
    FROM helpdesk_tickets t
    LEFT JOIN hr_employees re ON re.id = t.requester_employee_id
    LEFT JOIN hr_employees ae ON ae.id = t.assignee_employee_id`;

export async function getTicket(ticketId: string): Promise<Ticket | null> {
  if (!isUuid(ticketId)) return null;
  try {
    await ensureHelpdeskSchema();
    const r = rows(await db.execute(sql`SELECT ${TICKET_SELECT} WHERE t.id = ${ticketId}::uuid LIMIT 1`));
    return r.length ? mapTicket(r[0]) : null;
  } catch (e: any) {
    logFail('getTicket', e);
    return null;
  }
}

export interface ListTicketOptions {
  /** Narrow to one person's OWN tickets. The employee surface always passes this. */
  requesterEmployeeId?: string | null;
  /** Narrow to one desk agent's queue. */
  assigneeEmployeeId?: string | null;
  status?: string | null;
  category?: string | null;
  /** 'open' folds together everything that is not closed — the default queue view. */
  openOnly?: boolean;
  limit?: number;
}

/**
 * Tickets, newest first, with unresolved ones lifted to the top.
 *
 * NO IMPLICIT WIDENING. Passing neither requesterEmployeeId nor assigneeEmployeeId returns the whole
 * queue, so every CALLER that does that must have checked `helpdesk.manage` first — the admin page
 * does, at the door and again at every write. This function does not check, on purpose: a reader
 * that silently narrowed by "whatever the current user may see" would make the admin queue quietly
 * incomplete and nobody would notice which rows were missing.
 */
export async function listTickets(opts: ListTicketOptions = {}): Promise<Ticket[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureHelpdeskSchema();
    const byRequester = isUuid(opts.requesterEmployeeId)
      ? sql`AND t.requester_employee_id = ${String(opts.requesterEmployeeId)}::uuid` : sql``;
    const byAssignee = isUuid(opts.assigneeEmployeeId)
      ? sql`AND t.assignee_employee_id = ${String(opts.assigneeEmployeeId)}::uuid` : sql``;
    const byStatus = opts.status && (TICKET_STATUSES as readonly string[]).indexOf(String(opts.status)) >= 0
      ? sql`AND t.status = ${String(opts.status)}` : sql``;
    const byCategory = isTicketCategory(opts.category) ? sql`AND t.category = ${String(opts.category)}` : sql``;
    const notClosed = opts.openOnly ? sql`AND t.status <> 'closed'` : sql``;

    const r = await db.execute(sql`
      SELECT ${TICKET_SELECT}
       WHERE TRUE ${byRequester} ${byAssignee} ${byStatus} ${byCategory} ${notClosed}
       ORDER BY (t.status = 'closed') ASC, t.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapTicket);
  } catch (e: any) {
    logFail('listTickets', e);
    return [];
  }
}

/** The conversation on a ticket. The EXISTING thread store, read through its own reader. */
export async function ticketThread(ticketId: string): Promise<RequestMessage[]> {
  if (!isUuid(ticketId)) return [];
  try {
    return await getThread('helpdesk_ticket', ticketId);
  } catch (e: any) {
    logFail('ticketThread', e);
    return [];
  }
}

/** The approval instance behind an asset request, or null. Read from the workflow engine, never
 *  mirrored into a column here — two copies of one state is how they start disagreeing. */
export async function ticketApproval(ticketId: string): Promise<WorkflowInstanceRow | null> {
  if (!isUuid(ticketId)) return null;
  try {
    return await instanceForRecord('helpdesk', ticketId);
  } catch (e: any) {
    logFail('ticketApproval', e);
    return null;
  }
}

/** Counts for the queue header. One query, so a phone does not pay for five. */
export async function ticketCounts(): Promise<{ open: number; assigned: number; inProgress: number; resolved: number; closed: number }> {
  const zero = { open: 0, assigned: 0, inProgress: 0, resolved: 0, closed: 0 };
  try {
    await ensureHelpdeskSchema();
    const r = rows(await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM helpdesk_tickets GROUP BY status`));
    const out = { ...zero };
    for (const row of r) {
      const s = String(row?.status || '');
      const n = Number(row?.n) || 0;
      if (s === 'open') out.open = n;
      else if (s === 'assigned') out.assigned = n;
      else if (s === 'in_progress') out.inProgress = n;
      else if (s === 'resolved') out.resolved = n;
      else if (s === 'closed') out.closed = n;
    }
    return out;
  } catch (e: any) {
    logFail('ticketCounts', e);
    return zero;
  }
}

// -------------------------------------------------------------------------------------------------
// NOTIFICATION AND AUDIT — THE EXISTING ONES.
// -------------------------------------------------------------------------------------------------

/** NEVER BLOCKS THE WRITE IT ANNOUNCES. A ticket saved and not announced is somebody refreshing a
 *  page; a ticket refused because a push endpoint was stale is somebody who cannot work. */
async function notify(userId: string | null, title: string, body: string, url: string, tag: string): Promise<void> {
  if (!userId) return;
  try {
    await sendPushToUser(userId, { type: 'helpdesk', title, body: body.slice(0, 160), url, tag });
  } catch (e: any) {
    logFail('notify', e);
  }
}

async function auditTicket(userId: string | null, action: string, ticketId: string, diff: Record<string, unknown>): Promise<void> {
  await logAudit({ userId: userId || null, action: 'helpdesk.' + action, entity: 'helpdesk_ticket', entityId: ticketId, diff });
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface CreateTicketInput {
  category: string;
  subject: string;
  body: string;
  priority?: string;
  /** users.id of whoever raised it. */
  requesterUserId: string;
  /** hr_employees.id of whoever raised it. Null is allowed — see the note in the body. */
  requesterEmployeeId?: string | null;
  /** Only meaningful for an asset request: laptop, monitor, licence and so on. */
  assetKind?: string | null;
}

/**
 * Raise a ticket, then try to route it.
 *
 * THE TICKET IS CREATED EVEN WHEN ROUTING FAILS, and this is the same decision workflow.ts makes
 * about halted instances: a request that could not be routed but IS on the queue with a readable
 * cause gets picked up; one that was refused at the door because the graph is empty is a person who
 * cannot ask for help until the founder runs a backfill.
 *
 * AN ASSET REQUEST ALSO STARTS AN APPROVAL, on the workflow engine's 'helpdesk' domain, routed from
 * the requester's own reporting line. It is NOT auto-approved when routing fails; the instance is
 * written halted with its sentence and the ticket cannot be resolved until it settles approved.
 *
 * NO EXCEPTION IS SWALLOWED. A failure returns { ok: false } with a sentence and logs the real
 * Postgres reason — a create path that reports success on a failed insert is how a person believes
 * they have asked for help and nobody ever sees it.
 */
export async function createTicket(input: CreateTicketInput): Promise<TicketResult> {
  const category = String(input?.category || '').trim();
  if (!isTicketCategory(category)) return { ok: false, error: 'Choose which desk this is for.' };

  const subject = String(input?.subject || '').trim().slice(0, SUBJECT_MAX);
  if (!subject) return { ok: false, error: 'Give it a one-line subject so the desk can triage it.' };

  const body = String(input?.body || '').trim().slice(0, BODY_MAX);
  if (!body) return { ok: false, error: 'Describe what you need. A subject alone is not enough to act on.' };

  const requesterUserId = String(input?.requesterUserId || '').trim();
  if (!isUuid(requesterUserId)) return { ok: false, error: 'Sign in to raise a ticket.' };

  const priorityIn = String(input?.priority || 'normal');
  const priority = PRIORITY_SET.has(priorityIn) ? priorityIn : 'normal';
  const requesterEmployeeId = isUuid(input?.requesterEmployeeId) ? String(input.requesterEmployeeId) : null;
  const assetKind = input?.assetKind ? String(input.assetKind).slice(0, 60) : null;

  try {
    await ensureHelpdeskSchema();

    const ins = rows(await db.execute(sql`
      INSERT INTO helpdesk_tickets
        (category, subject, body, priority, status, requester_user_id, requester_employee_id, asset_kind)
      VALUES
        (${category}, ${subject}, ${body}, ${priority}, 'open',
         ${requesterUserId}::uuid, ${requesterEmployeeId}::uuid, ${assetKind}::text)
      RETURNING id, ticket_no`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };

    const id = String(ins[0].id);
    const ref = ticketRef(ins[0].ticket_no);

    // The opening message is the first row of the thread, so the conversation reads in one place
    // rather than "the description" being a separate thing above it.
    try {
      await postMessage({
        requestType: 'helpdesk_ticket',
        requestId: id,
        applicantUserId: null,
        senderRole: 'employee',
        senderUserId: requesterUserId,
        senderName: 'Requester',
        body,
      });
    } catch (e: any) {
      logFail('createTicket.openingMessage', e);
    }

    // ROUTE IT. Failure is recorded on the row and reported; it is never an error that loses the
    // ticket, and it is never covered up by assigning it to whoever holds the capability.
    const route = await assignFromGraph(id, category, requesterEmployeeId, requesterUserId);

    // AN ASSET REQUEST IS AN APPROVAL. Started on the workflow engine, routed from the org graph.
    let approvalNote: string | null = null;
    if (category === 'asset_request' && requesterEmployeeId) {
      const wf = await startWorkflow({
        domain: 'helpdesk',
        recordId: id,
        subjectEmployeeId: requesterEmployeeId,
        requestedByUserId: requesterUserId,
        summary: subject,
        createdByUserId: requesterUserId,
      });
      if (wf.ok && wf.instanceId) {
        await db.execute(sql`
          UPDATE helpdesk_tickets SET workflow_instance_id = ${wf.instanceId}::uuid, updated_at = NOW()
           WHERE id = ${id}::uuid`);
      }
      approvalNote = wf.haltReason || null;
    } else if (category === 'asset_request' && !requesterEmployeeId) {
      approvalNote = 'no approver could be resolved: this request is not linked to an employee record';
    }

    await auditTicket(requesterUserId, 'create', id, {
      ref, category, priority, routed: route.ok, routeNote: route.routeNote, approvalNote,
    });

    return { ok: true, id, ref, changed: true, routeNote: route.routeNote || approvalNote };
  } catch (e: any) {
    logFail('createTicket', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Route a ticket to its desk owner and move it to `assigned`.
 *
 * Internal, and used by createTicket() and by the "route it again" button on the admin queue. Every
 * state change goes through canTransition() — including this one, so there is exactly one definition
 * of which moves are legal.
 */
async function assignFromGraph(
  ticketId: string,
  category: string,
  subjectEmployeeId: string | null,
  actorUserId: string | null,
): Promise<DeskRoute> {
  const route = await resolveDeskRoute(category, subjectEmployeeId);
  if (!route.ok) {
    try {
      await db.execute(sql`
        UPDATE helpdesk_tickets SET route_note = ${route.routeNote}::text, updated_at = NOW()
         WHERE id = ${ticketId}::uuid`);
    } catch (e: any) {
      logFail('assignFromGraph.note', e);
    }
    return route;
  }

  // THE STATE CHANGE THIS MIGHT CAUSE, asked through the one definition of which moves are legal.
  // It only APPLIES to a ticket that is currently open: re-routing something already assigned or in
  // progress changes WHO owns it and must not shunt it backwards through the state machine, which is
  // why the CASE below leaves any other status exactly as it found it.
  const gate = canTransition('open', 'assigned');
  if (!gate.ok) return route;

  try {
    await db.execute(sql`
      UPDATE helpdesk_tickets
         SET assignee_employee_id = ${route.employeeId}::uuid,
             assignee_user_id = ${route.userId}::uuid,
             assigned_via = ${'org_graph:' + (route.scope || 'helpdesk')}::text,
             assigned_at = NOW(),
             route_note = NULL,
             status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
             updated_at = NOW()
       WHERE id = ${ticketId}::uuid
         AND status <> 'closed'`);
  } catch (e: any) {
    logFail('assignFromGraph.write', e);
    return route;
  }

  await notify(
    route.userId,
    'Helpdesk: a ticket was routed to you',
    'A ' + categoryLabel(category) + ' ticket is on your desk.',
    '/admin/helpdesk?t=' + ticketId,
    'helpdesk-' + ticketId,
  );
  await auditTicket(actorUserId, 'assign.graph', ticketId, {
    assigneeEmployeeId: route.employeeId, scope: route.scope,
  });
  return route;
}

/**
 * Assign or re-assign a ticket.
 *
 * TWO WAYS IN, and they are not the same act:
 *   - no employeeId  -> ROUTE IT FROM THE GRAPH. Anybody who may work the ticket can press this,
 *     because it cannot choose a person: it asks the graph and does what the graph says.
 *   - an employeeId  -> HAND IT TO A NAMED PERSON. This overrides routing, so it requires
 *     `helpdesk.manage`. Being the current assignee does not let you hand your ticket to a colleague
 *     who never agreed to it.
 */
export async function assignTicket(
  ticketId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: { employeeId?: string | null } = {},
): Promise<TicketResult> {
  if (!isUuid(ticketId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  try {
    await ensureHelpdeskSchema();
    const ticket = await getTicket(ticketId);
    if (!ticket) return { ok: false, error: NOT_AVAILABLE };

    const named = isUuid(opts.employeeId) ? String(opts.employeeId) : null;

    if (named) {
      if (!holdsCapability(user, 'helpdesk.manage')) {
        return { ok: false, error: 'Handing a ticket to a named person is a helpdesk-manager action.' };
      }
    } else {
      const allowed = await mayWorkTicket(user, ticket);
      if (!allowed.ok) return { ok: false, error: allowed.reason || NOT_AVAILABLE };
    }

    if (ticket.status === 'closed') return { ok: false, error: 'That ticket is closed.' };

    if (!named) {
      const route = await assignFromGraph(ticketId, ticket.category, ticket.requesterEmployeeId, actorId);
      if (!route.ok) return { ok: false, error: route.routeNote || NOT_AVAILABLE, routeNote: route.routeNote };
      return { ok: true, id: ticketId, changed: true };
    }

    // A named assignee still has to be a real, active employee — an assignment to a deleted record
    // is a ticket nobody owns that LOOKS owned, which is worse than an unassigned one.
    const emp = rows(await db.execute(sql`
      SELECT id, user_id, full_name FROM hr_employees
       WHERE id = ${named}::uuid AND is_active = true LIMIT 1`));
    if (!emp.length) return { ok: false, error: 'That is not an active employee record.' };

    // open -> assigned is a transition; assigned -> assigned (a re-assignment) is not a state change
    // at all, so it is not put through canTransition, which would refuse it as a same-state move.
    if (ticket.status === 'open') {
      const gate = canTransition(ticket.status, 'assigned');
      if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE helpdesk_tickets
         SET assignee_employee_id = ${named}::uuid,
             assignee_user_id = ${emp[0].user_id ? String(emp[0].user_id) : null}::uuid,
             assigned_via = 'named',
             assigned_at = NOW(),
             route_note = NULL,
             status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
             updated_at = NOW()
       WHERE id = ${ticketId}::uuid
         AND status = ${ticket.status}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That ticket changed while this page was open. Reload it and try again.' };
    }

    await notify(
      emp[0].user_id ? String(emp[0].user_id) : null,
      'Helpdesk: a ticket was assigned to you',
      ticket.subject,
      '/admin/helpdesk?t=' + ticketId,
      'helpdesk-' + ticketId,
    );
    await auditTicket(actorId, 'assign.named', ticketId, { assigneeEmployeeId: named });
    return { ok: true, id: ticketId, changed: true };
  } catch (e: any) {
    logFail('assignTicket', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Move a ticket to another state.
 *
 * FOUR THINGS ARE TRUE BEFORE ANYTHING IS WRITTEN:
 *   1. the ticket exists;
 *   2. the transition is legal (canTransition — an invalid one is REFUSED with a sentence naming
 *      where it could go instead, never silently ignored);
 *   3. this actor may make THIS move: working states are the assignee's or a manager's; closing your
 *      own ticket and sending a resolved one back are the requester's;
 *   4. for an asset request being resolved, THE APPROVAL HAS SETTLED APPROVED. An asset issued on a
 *      request nobody approved is the exact outcome the workflow engine exists to prevent, and a
 *      helpdesk that could close around it would be a second door into the same room.
 *
 * The UPDATE repeats the precondition (`status = <the status we validated against>`), so a colleague
 * who moved it a second earlier makes this write touch zero rows and be reported as a concurrent
 * change rather than overwriting them.
 */
export async function transitionTicket(
  ticketId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  to: string,
  note: string = '',
): Promise<TicketResult> {
  if (!isUuid(ticketId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  const text = String(note || '').trim().slice(0, 2000);

  try {
    await ensureHelpdeskSchema();
    const ticket = await getTicket(ticketId);
    if (!ticket) return { ok: false, error: NOT_AVAILABLE };

    const view = await mayViewTicket(user, ticket);
    if (!view.ok) return { ok: false, error: NOT_AVAILABLE };

    const gate = canTransition(ticket.status, to);
    if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };
    const next = to as TicketStatus;

    // WHICH MOVES BELONG TO WHOM.
    const isRequester = view.via === 'requester';
    const requesterMoves = next === 'closed' || (ticket.status === 'resolved' && next === 'in_progress');
    if (!(isRequester && requesterMoves)) {
      const allowed = await mayWorkTicket(user, ticket);
      if (!allowed.ok) return { ok: false, error: allowed.reason || NOT_AVAILABLE };
    }

    // AN ASSET REQUEST CANNOT BE RESOLVED UNTIL ITS APPROVAL SETTLES APPROVED.
    if (next === 'resolved' && ticket.category === 'asset_request') {
      const instance = await ticketApproval(ticketId);
      if (!instance) {
        return { ok: false, error: 'This asset request has no approval attached, so there is nothing authorising it to be issued.' };
      }
      if (instance.state === 'halted') {
        return { ok: false, error: 'The approval for this request is halted: ' + (instance.haltReason || 'no approver could be resolved') + '. Record the missing relationship and resume it before issuing anything.' };
      }
      if (instance.state !== 'approved') {
        return { ok: false, error: 'The approval for this request is ' + String(instance.state) + '. Nothing can be issued until it is approved.' };
      }
    }

    const stamps =
      next === 'resolved' ? sql`, resolved_at = NOW(), resolution = ${text || null}::text`
      : next === 'closed' ? sql`, closed_at = NOW()`
      : next === 'in_progress' ? sql`, resolved_at = NULL`
      : sql``;
    // Handing a ticket back to the queue must take the assignee with it, or the queue shows an
    // unassigned ticket with somebody's name still on it.
    const unassign = next === 'open'
      ? sql`, assignee_employee_id = NULL, assignee_user_id = NULL, assigned_via = NULL, assigned_at = NULL`
      : sql``;

    const wrote = rows(await db.execute(sql`
      UPDATE helpdesk_tickets
         SET status = ${next}, updated_at = NOW() ${stamps} ${unassign}
       WHERE id = ${ticketId}::uuid
         AND status = ${ticket.status}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That ticket changed while this page was open. Reload it and try again.' };
    }

    // Tell the OTHER side. The person who pressed the button already knows.
    if (isRequester) {
      await notify(ticket.assigneeUserId, 'Helpdesk: ' + ticket.ref + ' is now ' + statusLabel(next).toLowerCase(),
        ticket.subject, '/admin/helpdesk?t=' + ticketId, 'helpdesk-' + ticketId);
    } else {
      await notify(ticket.requesterUserId, 'Helpdesk: ' + ticket.ref + ' is now ' + statusLabel(next).toLowerCase(),
        text || ticket.subject, '/portal/employee/support?t=' + ticketId, 'helpdesk-' + ticketId);
    }

    await auditTicket(actorId, 'status.' + next, ticketId, { from: ticket.status, to: next, via: view.via, note: text || null });
    return { ok: true, id: ticketId, changed: true };
  } catch (e: any) {
    logFail('transitionTicket', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Post a reply on a ticket.
 *
 * THE SLA STAMP IS SET HERE, and only for a reply from the DESK: `first_response_at` means "somebody
 * who is not the requester answered", so a requester adding three more details to their own ticket
 * does not mark it as answered. It is written with `first_response_at IS NULL` in the WHERE clause,
 * so the FIRST response stays the first one however many replies follow.
 */
export async function replyToTicket(
  ticketId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null; name?: string | null } | null | undefined,
  body: string,
): Promise<TicketResult> {
  if (!isUuid(ticketId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to reply.' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Write something to send.' };

  try {
    await ensureHelpdeskSchema();
    const ticket = await getTicket(ticketId);
    if (!ticket) return { ok: false, error: NOT_AVAILABLE };
    if (ticket.status === 'closed') return { ok: false, error: 'That ticket is closed. Raise a new one and reference ' + ticket.ref + '.' };

    const view = await mayViewTicket(user, ticket);
    if (!view.ok) return { ok: false, error: NOT_AVAILABLE };

    const fromDesk = view.via !== 'requester';
    const posted = await postMessage({
      requestType: 'helpdesk_ticket',
      requestId: ticketId,
      applicantUserId: null,
      senderRole: fromDesk ? 'agent' : 'employee',
      senderUserId: actorId,
      senderName: String(user?.name || '').slice(0, 200) || (fromDesk ? 'Helpdesk' : 'Requester'),
      body: text.slice(0, BODY_MAX),
    });
    if (!posted.ok) return { ok: false, error: posted.error || WRITE_FAILED };

    if (fromDesk) {
      try {
        await db.execute(sql`
          UPDATE helpdesk_tickets SET first_response_at = NOW(), updated_at = NOW()
           WHERE id = ${ticketId}::uuid AND first_response_at IS NULL`);
      } catch (e: any) {
        logFail('replyToTicket.firstResponse', e);
      }
    }
    try {
      await db.execute(sql`UPDATE helpdesk_tickets SET updated_at = NOW() WHERE id = ${ticketId}::uuid`);
    } catch (e: any) {
      logFail('replyToTicket.touch', e);
    }

    if (fromDesk) {
      await notify(ticket.requesterUserId, 'Helpdesk: reply on ' + ticket.ref, text,
        '/portal/employee/support?t=' + ticketId, 'helpdesk-' + ticketId);
    } else {
      await notify(ticket.assigneeUserId, 'Helpdesk: ' + ticket.ref + ' has a reply', text,
        '/admin/helpdesk?t=' + ticketId, 'helpdesk-' + ticketId);
    }

    await auditTicket(actorId, 'reply', ticketId, { via: view.via, length: text.length });
    return { ok: true, id: ticketId, changed: true };
  } catch (e: any) {
    logFail('replyToTicket', e);
    return { ok: false, error: WRITE_FAILED };
  }
}
