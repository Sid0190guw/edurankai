// src/lib/employee-tasks.ts — assigned work: who owes what, to whom, by when.
//
// WHY THIS IS NEW. Nothing in this repo lets one person give work to another. `hr_task_log`,
// `hr_time_logs` and `hr_daily_reports` are all SELF-REPORTS: the person types what they did, at
// clock-out, about a day that has already happened. There is no assigner, no due date, no
// completion event, and `hr_task_log` has zero admin readers, so what someone writes at clock-out
// reaches nobody. A surface that said "tasks assigned to me" on top of those tables would be
// showing something that does not exist. This module is the thing that has to exist first.
//
// THE ACCESS MODEL, and why it is in the WHERE clause rather than in a page:
//
//   1. A PERSON SEES THEIR OWN TASKS. Scoped by employee_id, and the employee_id is resolved from
//      the session by requireEmployee() and from nowhere else. Nothing the browser sends may decide
//      whose rows come back.
//
//   2. A LEAD SEES THEIR OWN DEPARTMENT. Pass `gate.scopeDepartmentId`, which workspace-access.ts
//      populates only for role === 'department_head' and leaves null for everyone else. Both filters
//      fail closed: an empty scope compiles to `false`, so a caller that forgets its gate renders an
//      empty list rather than the whole organisation.
//
//   3. NOBODY WRITES A STATUS THEY DO NOT OWN. An open status field that anyone can POST to is not
//      a task system, it is a shared whiteboard. Every write re-derives the actor's right to make it
//      FROM THE DATABASE, inside the same statement that performs the write — see the note on
//      atomicity above updateTaskStatus.
//
// WHO MAY ASSIGN. Three routes, all re-derived from the target's own row: the person themselves
// (self-assigned work is ordinary and this file should not forbid it), their recorded reporting
// manager, or a department head scoped to that department. Not "any admin" and not a boolean the
// caller passes — the set of people who can put work on someone else's list is exactly the set the
// HR record already says has authority over them. If HR or the founder ever need to assign, that
// belongs behind an explicit capability check in src/lib/auth/registry.ts, not a parameter.
//
// =================================================================================================
// SECOND PASS — the workflow, the collaborators and the board.
// =================================================================================================
//
// A STATUS FIELD THAT ACCEPTS ANYTHING IS A SHARED TEXT BOX, NOT A WORKFLOW. The first version of
// this module stored one of four free strings and let either of two people write any of them at any
// time. That is enough for a personal to-do list and not enough for work that is handed over,
// reviewed and signed off: there is no way to say "this was approved", no way to tell "not started"
// from "cancelled", and nothing refuses a move that makes no sense. TASK_STATUSES + TRANSITIONS
// below replace it with an explicit graph — every edge names the statuses it joins AND the roles
// allowed to walk it, and canTransition() refuses everything else IN WORDS.
//
// TWO VOCABULARIES, ONE COLUMN, AND WHY NOTHING IS REWRITTEN. Rows already in production carry the
// old values 'open' and 'done'. This module does NOT run a bulk UPDATE over a live table on a render
// path to tidy that up: reads normalise instead (see CANON), so a legacy row is understood exactly
// like a canonical one, and it is rewritten in the canonical vocabulary the first time somebody
// moves it. A migration that is not needed is a migration that cannot fail at 9am.
//
// THE OLD SHAPE IS STILL THE OLD SHAPE. src/pages/portal/employee.astro renders a four-value select
// ('open' / 'in_progress' / 'blocked' / 'done') and filters its list on `status !== 'done'`. That
// page is live and is not edited by this change, so `EmployeeTask.status` — the type it reads —
// still speaks the four legacy values, projected from the canonical one (legacyStatusOf). The
// canonical status is carried alongside it as `EmployeeTask.state`. New surfaces use BoardTask,
// whose `status` is canonical and needs no translation. One entity, two views, neither lying.
//
// NEW SCHEMA CANNOT TAKE DOWN OLD SURFACES. employee_task_collaborators and the columns added with
// it are asserted in their OWN try/catch inside ensureTaskTables(), and no query that the existing
// portal calls names any of them. If that DDL fails, the board and the detail view fail closed and
// say so; "my tasks" on somebody's phone keeps working. A column that is declared is not a column
// that exists — that mistake (hr_employees.work_email) cost three outages in one day, and the answer
// is to keep the blast radius of new schema inside the new surfaces.
import { db } from '@/lib/db';
import { sql, type SQL } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { employeeFilter, departmentFilter } from '@/lib/auth/workspace-access';
import { rolesHolding } from '@/lib/auth/capability';
import { logAudit } from '@/lib/audit';

// postgres-js resolves to a plain array, never a { rows } object. Declared before everything that
// uses it: `const` is not hoisted, and a handler reaching a later declaration has taken pages down
// in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the SQL that failed. Never a bare
// catch {} — that is what hid both of today's outages for hours.
const logFail = (tag: string, e: any) => console.error('[employee-tasks] ' + tag, e?.cause?.message || e?.message);

/** One message for every refusal, so probing ids cannot distinguish "no such task" from "not yours". */
const NOT_AVAILABLE = 'That task is not available.';

/**
 * What a person is shown when a write fails. Deliberately NOT the database's own words.
 *
 * `e.cause.message` is the real Postgres reason and it belongs in the log, every time — that is the
 * house rule and nothing here weakens it. It does not belong in a redirect query string on somebody's
 * HR page: 'column "blocked_reason" of relation "employee_tasks" does not exist' names the schema to
 * whoever asks, and tells the person reading it nothing they can act on.
 */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** A value going into a ::uuid cast must look like one, or the cast throws on the render path. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------------------------
// THE STATUS MODEL. Declared at the very top of the file, above every function and every SQL
// fragment that reads it — `const` is not hoisted, and a fragment built from a constant declared
// further down throws at module load with a message that names neither.
// ---------------------------------------------------------------------------------------------

export type TaskStatus =
  | 'draft'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'blocked'
  | 'under_review'
  | 'approved'
  | 'completed'
  | 'cancelled'
  | 'archived';

/** The four values written before this file grew a workflow. Still accepted, still projected. */
export type LegacyTaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';

/** Anything a caller may hand to a write: canonical, or one of the two legacy names. */
export type AnyTaskStatus = TaskStatus | LegacyTaskStatus;

/** Board column order, and the order every list of statuses is rendered in. */
export const TASK_STATUSES: TaskStatus[] = [
  'draft', 'assigned', 'accepted', 'in_progress', 'blocked',
  'under_review', 'approved', 'completed', 'cancelled', 'archived',
];

/** Plain words for a screen. No emoji anywhere in this codebase — SVG only, and never from a lib. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: 'Draft',
  assigned: 'Assigned',
  accepted: 'Accepted',
  in_progress: 'In progress',
  blocked: 'Blocked',
  under_review: 'Under review',
  approved: 'Approved',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

/** Nothing is owed on these, so they are never overdue and never counted as outstanding work. */
export const CLOSED_STATUSES: TaskStatus[] = ['completed', 'cancelled', 'archived'];

/**
 * The old names, mapped once. 'open' meant "given out, not started" — that is `assigned`. 'done'
 * meant "finished" — that is `completed`. Any other string in the column (there should be none) is
 * read as `assigned`, which is the safe direction: it keeps the task visible and outstanding rather
 * than quietly filing it as finished.
 */
const STATUS_ALIASES: Record<string, TaskStatus> = {
  open: 'assigned',
  done: 'completed',
};

const STATUS_SET = new Set<string>(TASK_STATUSES);

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && STATUS_SET.has(v);
}

/** Canonical form of any status string, or null if it is not one we know at all. */
export function canonicalStatus(v: unknown): TaskStatus | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (STATUS_SET.has(s)) return s as TaskStatus;
  return STATUS_ALIASES[s] ?? null;
}

/**
 * The canonical status seen through the four-value window the live portal renders.
 *
 * `under_review` and `approved` project to 'in_progress' because from the assignee's phone they are
 * both "still open, not finished". `cancelled` and `archived` project to 'done' so they drop off a
 * list of outstanding work — they are not achievements, and nothing on that page calls them one.
 */
export function legacyStatusOf(status: TaskStatus): LegacyTaskStatus {
  if (status === 'draft' || status === 'assigned' || status === 'accepted') return 'open';
  if (status === 'blocked') return 'blocked';
  if (status === 'completed' || status === 'cancelled' || status === 'archived') return 'done';
  return 'in_progress';
}

// ---------------------------------------------------------------------------------------------
// WHO MAY WALK WHICH EDGE.
// ---------------------------------------------------------------------------------------------

/** A row in employee_task_collaborators. Each of these means something different below. */
export type TaskCollaboratorRole = 'assignee' | 'co_assignee' | 'reviewer' | 'approver' | 'watcher';

export const TASK_COLLABORATOR_ROLES: TaskCollaboratorRole[] =
  ['assignee', 'co_assignee', 'reviewer', 'approver', 'watcher'];

export const COLLABORATOR_ROLE_LABELS: Record<TaskCollaboratorRole, string> = {
  assignee: 'Assignee',
  co_assignee: 'Working on it',
  reviewer: 'Reviewer',
  approver: 'Approver',
  watcher: 'Watching',
};

/**
 * The roles an ACTOR can hold on a task. Two of them are not collaborator rows at all:
 *   'assigner' — they created the task (employee_tasks.assigned_by_user_id).
 *   'lead'     — they are the department head over the assignee's department. This is the only
 *                team-lead signal that exists in this database (users.role = 'department_head' plus
 *                users.assigned_department_id); see the long note in workspace-access.ts.
 * A person can hold several at once, and every check below tests the whole set, not a "primary" one.
 */
export type TaskActorRole = TaskCollaboratorRole | 'assigner' | 'lead';

export const ACTOR_ROLE_LABELS: Record<TaskActorRole, string> = {
  assignee: 'the assignee',
  co_assignee: 'someone working on it',
  reviewer: 'a reviewer',
  approver: 'an approver',
  watcher: 'a watcher',
  assigner: 'the person who assigned it',
  lead: 'the department lead',
};

// The four rights, named once. WORK moves the task along, MANAGE governs its existence, APPROVE
// signs it off, REVISE sends it back. `watcher` appears in NONE of them, which is the entire
// definition of a watcher: they can read the task and comment on it, and that is all.
const WORK: TaskActorRole[] = ['assignee', 'co_assignee', 'assigner', 'lead'];
const MANAGE: TaskActorRole[] = ['assigner', 'lead'];
const APPROVE: TaskActorRole[] = ['approver', 'lead'];
const REVISE: TaskActorRole[] = ['reviewer', 'approver', 'lead'];
const REOPEN: TaskActorRole[] = ['assignee', 'co_assignee', 'assigner', 'lead', 'approver'];
const BACK_TO_WORK: TaskActorRole[] = ['assignee', 'co_assignee', 'assigner', 'lead', 'reviewer', 'approver'];

/**
 * THE GRAPH. from -> to -> the roles allowed to make that move.
 *
 * The spine is draft -> assigned -> accepted -> in_progress -> (blocked | under_review) ->
 * approved -> completed, with cancelled and archived reachable from almost anywhere. The extra
 * edges are deliberate and each is a real thing a person does:
 *
 *   - assigned/accepted/blocked -> completed. The chain is the expected path, not a maze. Somebody
 *     who did a ten-minute job without first clicking "In progress" may still say it is done, and a
 *     workflow that refuses that trains people to lie to it.
 *   - under_review -> completed is APPROVE only. Once work is under review, closing it is the
 *     reviewer's call, not the author's — that is the whole point of putting it under review.
 *   - under_review -> in_progress is the revision path. A reviewer holds it (that is what "may
 *     request revision" means), and so does the assignee, who is allowed to pull their own work back
 *     before somebody reads it.
 *   - approved -> completed is WORK: the sign-off has happened, closing it is bookkeeping.
 *   - completed -> in_progress reopens. Audited, like every other move.
 *
 * An edge that is absent is absent on purpose. `draft -> completed` is not here because a task
 * nobody was ever given cannot have been finished.
 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, TaskActorRole[]>>> = {
  draft: {
    assigned: MANAGE,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  assigned: {
    accepted: WORK,
    in_progress: WORK,
    blocked: WORK,
    completed: WORK,
    draft: MANAGE,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  accepted: {
    in_progress: WORK,
    blocked: WORK,
    under_review: WORK,
    completed: WORK,
    assigned: WORK,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  in_progress: {
    blocked: WORK,
    under_review: WORK,
    completed: WORK,
    accepted: WORK,
    assigned: WORK,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  blocked: {
    in_progress: WORK,
    accepted: WORK,
    assigned: WORK,
    under_review: WORK,
    completed: WORK,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  under_review: {
    approved: APPROVE,
    completed: APPROVE,
    in_progress: BACK_TO_WORK,
    blocked: WORK,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  approved: {
    completed: WORK,
    in_progress: REVISE,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  completed: {
    in_progress: REOPEN,
    under_review: REOPEN,
    cancelled: MANAGE,
    archived: MANAGE,
  },
  cancelled: {
    assigned: MANAGE,
    archived: MANAGE,
  },
  archived: {
    assigned: MANAGE,
  },
};

/** Statuses that mean nothing unless somebody says why. Enforced in moveTask, before the write. */
const REASON_REQUIRED: TaskStatus[] = ['blocked', 'cancelled'];
const REASON_MIN = 5;

export function statusNeedsReason(status: TaskStatus): boolean {
  return REASON_REQUIRED.indexOf(status) >= 0;
}

/**
 * The answer to "may this person make this move", and WHY NOT when the answer is no.
 *
 * READ THIS BEFORE CALLING IT: this returns an OBJECT, not a boolean. `if (canTransition(a, b, r))`
 * is always true and would wave every move through. Test `.ok`, or use isAllowedTransition() when a
 * plain predicate is what you want.
 *
 * @param role one role or several — a person is often the assignee AND the assigner, and holding any
 *             one qualifying role is enough.
 */
export interface TransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
  /** The roles that WOULD have been allowed, so a screen can say who to ask. */
  allowedRoles: TaskActorRole[];
}

export function canTransition(
  from: AnyTaskStatus | string,
  to: AnyTaskStatus | string,
  role: TaskActorRole | TaskActorRole[] | null | undefined,
): TransitionCheck {
  const a = canonicalStatus(from);
  const b = canonicalStatus(to);

  if (!a) return { ok: false, reason: 'That task is in a state this workflow does not recognise.', allowedRoles: [] };
  if (!b) return { ok: false, reason: 'That is not a status we track.', allowedRoles: [] };
  if (a === b) {
    return { ok: false, reason: 'It is already ' + STATUS_LABELS[b].toLowerCase() + '.', allowedRoles: [] };
  }

  const held: TaskActorRole[] = Array.isArray(role) ? role.filter(Boolean) : (role ? [role] : []);
  const allowed = TRANSITIONS[a]?.[b];

  if (!allowed || allowed.length === 0) {
    const onward = Object.keys(TRANSITIONS[a] || {}) as TaskStatus[];
    const names = onward.map((s) => STATUS_LABELS[s]).join(', ');
    return {
      ok: false,
      allowedRoles: [],
      reason: names
        ? STATUS_LABELS[a] + ' does not move to ' + STATUS_LABELS[b] + '. From here it can go to: ' + names + '.'
        : STATUS_LABELS[a] + ' is where this task ends; it does not move to ' + STATUS_LABELS[b] + '.',
    };
  }

  if (held.length === 0) {
    return { ok: false, allowedRoles: allowed, reason: 'You are not on this task, so you cannot move it.' };
  }
  if (!held.some((r) => allowed.indexOf(r) >= 0)) {
    const who = allowed.map((r) => ACTOR_ROLE_LABELS[r]).join(' or ');
    return {
      ok: false,
      allowedRoles: allowed,
      reason: 'Moving this to ' + STATUS_LABELS[b] + ' is for ' + who + '. Ask them, or add a comment saying it is ready.',
    };
  }

  return { ok: true, reason: null, allowedRoles: allowed };
}

/** The same question as a plain predicate, for the places that only need a yes or no. */
export function isAllowedTransition(
  from: AnyTaskStatus | string,
  to: AnyTaskStatus | string,
  role: TaskActorRole | TaskActorRole[] | null | undefined,
): boolean {
  return canTransition(from, to, role).ok;
}

/**
 * Every move this person may make from here, in board order.
 *
 * Render the buttons from THIS, not from TASK_STATUSES: a control that exists only to be refused is
 * a control that teaches people the system is broken.
 */
export function allowedTransitionsFor(
  from: AnyTaskStatus | string,
  role: TaskActorRole | TaskActorRole[] | null | undefined,
): TaskStatus[] {
  const a = canonicalStatus(from);
  if (!a) return [];
  return TASK_STATUSES.filter((s) => s !== a && canTransition(a, s, role).ok);
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const PRIORITIES = TASK_PRIORITIES;

// ---------------------------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------------------------

/**
 * THE COMPATIBILITY SHAPE. `status` here is one of the four legacy values because
 * src/pages/portal/employee.astro reads exactly that and is not edited by this change. The canonical
 * status is `state`. New code should read BoardTask instead, whose `status` is canonical.
 */
export interface EmployeeTask {
  id: string;
  employeeId: string;
  employeeName: string | null;
  assignedByUserId: string | null;
  assignedByName: string | null;
  selfAssigned: boolean;
  title: string;
  description: string | null;
  priority: TaskPriority;
  /** Legacy four-value projection of `state`. See legacyStatusOf. */
  status: LegacyTaskStatus;
  /** The real status. */
  state: TaskStatus;
  stateLabel: string;
  dueOn: string | null;
  isOverdue: boolean;
  blockedReason: string | null;
  commentCount: number;
  createdAt: string;
  completedAt: string | null;
}

/** What the board and the detail view render. `status` is canonical here — no translation. */
export interface BoardTask {
  id: string;
  employeeId: string;
  employeeName: string | null;
  assignedByUserId: string | null;
  assignedByName: string | null;
  selfAssigned: boolean;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  statusLabel: string;
  /** For a surface that still speaks the old four values. */
  legacyStatus: LegacyTaskStatus;
  dueOn: string | null;
  isOverdue: boolean;
  blockedReason: string | null;
  cancelReason: string | null;
  commentCount: number;
  collaboratorCount: number;
  createdAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  statusChangedAt: string | null;
  /** Every role the VIEWER holds on this task. Resolved in SQL, never claimed by the caller. */
  viewerRoles: TaskActorRole[];
  /** Exactly the moves this viewer may make. Render controls from this and nothing else. */
  allowedTransitions: TaskStatus[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorUserId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface TaskCollaborator {
  id: string;
  taskId: string;
  userId: string;
  name: string | null;
  role: TaskCollaboratorRole;
  roleLabel: string;
  addedByUserId: string | null;
  addedAt: string | null;
}

export interface TaskCounts {
  open: number;
  inProgress: number;
  blocked: number;
  done: number;
  overdue: number;
  total: number;
}

/** Declared before the readers that return it. `const` is not hoisted. */
const EMPTY_COUNTS: TaskCounts = { open: 0, inProgress: 0, blocked: 0, done: 0, overdue: 0, total: 0 };

export interface MyTasksView {
  ok: boolean;
  tasks: EmployeeTask[];
  counts: TaskCounts;
}

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  count: number;
  tasks: BoardTask[];
}

export interface BoardFilters {
  assigneeEmployeeId: string | null;
  priority: TaskPriority | null;
  overdueOnly: boolean;
  includeArchived: boolean;
}

export interface BoardView {
  /** False means the read did not happen. An empty board with ok:true means there is genuinely
   *  nothing — the same distinction MyTasksView makes, for the same reason. */
  ok: boolean;
  reason: 'ok' | 'no-viewer' | 'lookup-failed';
  columns: BoardColumn[];
  /** The same task objects, flat, for a list rendering or a count. */
  tasks: BoardTask[];
  total: number;
  overdue: number;
  /** The filters ACTUALLY applied. An unusable value is dropped and reported, never applied silently. */
  filters: BoardFilters;
  notice: string | null;
}

/**
 * The assignee's department, for the detail page's properties column.
 *
 * `name` is null when the id points at no departments row, and — separately — when the name could
 * not be read at all. A missing label is not a missing department, so the id is kept either way and
 * the screen can still say "recorded, but we could not name it" rather than "none".
 */
export interface TaskDepartment {
  id: string;
  name: string | null;
}

export interface TaskDetail {
  task: BoardTask;
  comments: TaskComment[];
  collaborators: TaskCollaborator[];
  viewerRoles: TaskActorRole[];
  /** Whether the viewer may write a comment. True for everyone who can see the task, watchers too. */
  viewerMayComment: boolean;
  /**
   * The department the work sits in, off the ASSIGNEE's hr_employees row.
   *
   * Null is the ordinary case, not an error: hr_employees.department_id is written by exactly one
   * code path (src/lib/hr/sync.ts, when an application turns 'hired'), so anyone HR added by hand
   * has none. See DEPARTMENT_COVERAGE_NOTICE in workspace-access.ts. A screen must say "not
   * recorded", never imply the person has no team.
   */
  department: TaskDepartment | null;
}

export interface TaskDetailView {
  ok: boolean;
  reason: 'ok' | 'no-viewer' | 'not-visible' | 'lookup-failed';
  detail: TaskDetail | null;
}

// ---------------------------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------------------------

/**
 * Self-bootstrapped, no migration. Two things here are deliberate rather than belt-and-braces:
 *
 * CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING A TABLE THAT IS MISSING
 * COLUMNS. That is precisely how `hr_employees.work_email` came to be declared in db/hr-schema.sql
 * and absent from the live table, which locked every administrator out of /admin and told every
 * employee "no employee profile found" — twice, today. So every column past the primary key is also
 * asserted with ADD COLUMN IF NOT EXISTS. On a fresh database those are no-ops; on a database
 * carrying an older revision of this table they are the difference between working and a 500.
 *
 * THE hr_employees ALTER RUNS LAST AND IN ITS OWN try/catch, so a failure there cannot stop this
 * module's own tables from being created. `reporting_manager_id` is ALTERed in by only two admin
 * pages, at page load, so on a database where neither has ever been opened the column does not
 * exist — and createTask NAMES it. A `SELECT *` tolerates a missing column; a query that names one
 * throws. If that ALTER somehow fails, createTask throws and refuses rather than mis-authorising,
 * which is the correct direction to fail.
 */
export function ensureTaskSchema(): Promise<void> {
  // ensureOnce() SWALLOWS whatever this callback throws (src/lib/ensure-once.ts:24) so callers keep
  // their tolerate-missing-schema behaviour. That is the right contract for callers and the wrong
  // one for the logs: without the try/catch below, a CREATE TABLE that fails leaves no trace
  // anywhere, and the only symptom is an empty task list. Log the real reason, then RE-THROW — the
  // rethrow is what makes ensureOnce drop the cache entry and retry on the next request instead of
  // remembering a failure for the life of the process.
  //
  // The key is v2 because the second pass adds tables and columns. A running process that already
  // ensured v1 is a process running the old code, so there is no version of this that skips the new
  // DDL and then queries it.
  // v3 because the third pass adds employee_tasks.project_id. A running process that already ensured
  // v2 is a process running the old code, so there is no version of this that skips the new DDL and
  // then queries it.
  return ensureOnce('employee_tasks_v3', async () => {
    try {
      await ensureTaskTables();
    } catch (e: any) {
      logFail('ensureTaskSchema', e);
      throw e;
    }
  });
}

async function ensureTaskTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS employee_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id UUID NOT NULL,
      assigned_by_user_id UUID,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      due_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      blocked_reason TEXT
    )`);
    // No FK to hr_employees: the hr_* tables do not use one (hr_task_log, hr_time_logs), and a task
    // history should outlive a row deletion rather than vanish with it.
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS assigned_by_user_id UUID`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS due_on DATE`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS employee_task_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES employee_tasks(id) ON DELETE CASCADE,
      author_user_id UUID NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // The personal list ("my open work, soonest due") and the overdue sweep both ride this.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_tasks_scope_idx ON employee_tasks (employee_id, status, due_on)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_tasks_assigner_idx ON employee_tasks (assigned_by_user_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_task_comments_task_idx ON employee_task_comments (task_id, created_at)`);

    try {
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS reporting_manager_id UUID`);
    } catch (e: any) {
      logFail('ensureTaskSchema reporting_manager_id', e);
    }

    // -------------------------------------------------------------------------------------------
    // SECOND PASS SCHEMA — deliberately non-fatal, and here is exactly what that buys.
    //
    // Everything above this line is what "my tasks" on somebody's phone depends on. Everything below
    // is what the board, the detail view and every WRITE need. It is wrapped so a failure here cannot
    // blank a page that has worked for months.
    //
    // WHAT STILL WORKS IF THIS BLOCK LOGS: reading. listMyTasks / myTasksView / listTasksForTeam /
    // taskCounts name no column and no table created below (see the note on TASK_COLUMNS), so the
    // portal card keeps rendering somebody's real work.
    // WHAT STOPS: the board, the task detail, and moveTask / updateTaskStatus, which read the
    // collaborator roles and write status_changed_at. They refuse in words and the log line names the
    // real Postgres reason. A person who can see their tasks but cannot tick one off is a bad day;
    // a person whose task list renders empty is told a lie about their own work. This block chooses
    // the first.
    // -------------------------------------------------------------------------------------------
    try {
      await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ`);
      // "Cancelled" with no stated cause is as useless as "blocked" with none: nobody reading the
      // board later can tell whether the work stopped mattering or somebody clicked the wrong thing.
      await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
      // Catalogue-only change, no table rewrite. New rows land in the canonical vocabulary even if
      // something inserts without naming a status; createTask names one regardless.
      await db.execute(sql`ALTER TABLE employee_tasks ALTER COLUMN status SET DEFAULT 'assigned'`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS employee_task_collaborators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES employee_tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        role TEXT NOT NULL DEFAULT 'watcher',
        added_by_user_id UUID,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`ALTER TABLE employee_task_collaborators ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'watcher'`);
      await db.execute(sql`ALTER TABLE employee_task_collaborators ADD COLUMN IF NOT EXISTS added_by_user_id UUID`);
      await db.execute(sql`ALTER TABLE employee_task_collaborators ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_task_collab_task_idx ON employee_task_collaborators (task_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_task_collab_user_idx ON employee_task_collaborators (user_id, role)`);
    } catch (e: any) {
      logFail('ensureTaskSchema collaborators', e);
    }

    // Its own try/catch, one level deeper. A UNIQUE index is the one piece of DDL here that can fail
    // on data rather than on syntax, and addCollaborator does NOT depend on it: the insert is an
    // INSERT ... SELECT ... WHERE NOT EXISTS, which is correct with or without the constraint. This
    // is insurance against a concurrent double-click, not the mechanism.
    try {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS employee_task_collab_uidx
        ON employee_task_collaborators (task_id, user_id, role)`);
    } catch (e: any) {
      logFail('ensureTaskSchema collaborators unique index', e);
    }

    // -------------------------------------------------------------------------------------------
    // THIRD PASS — THE PROJECT REFERENCE, AND WHY IT IS ONE COLUMN HERE RATHER THAN A TABLE THERE.
    //
    // src/lib/projects.ts needs "the tasks on this project". There were exactly two ways to give it
    // one, and only one of them is safe:
    //
    //   A SECOND TASK TABLE, or a project_tasks join table with its own status column, would mean a
    //   second set of transition rules, a second definition of who may assign work, and a second
    //   answer to "may this person see this task" — three things that would start agreeing and end
    //   up disagreeing. On this project two CREATE TABLE IF NOT EXISTS for one table with different
    //   shapes already meant no encrypted message could be sent for four months.
    //
    //   ONE NULLABLE COLUMN ON THIS TABLE, declared HERE, in the module that owns the table. Every
    //   task is still an employee_tasks row; TRANSITIONS, visibleToSql(), moveTask() and the whole
    //   collaborator model apply to a project task exactly as they do to any other, because it IS
    //   any other. A project is a label on the work, not a different kind of work.
    //
    // NO FOREIGN KEY to `projects`. This module must not assume another module's table exists — the
    // same rule procurement.ts states about the asset register — and a task whose project row is
    // deleted should lose its label, not vanish. listProjectTasks() reads it as text and a project
    // that is gone simply matches nothing.
    //
    // NOTHING ABOVE THIS LINE NAMES project_id. myTasksView(), listMyTasks(), listTasksForTeam(),
    // taskCounts(), listBoard(), getTaskView() and moveTask() are byte-for-byte unaffected: their
    // column lists are explicit, so an added column is invisible to them. If this ALTER fails, the
    // project surfaces fail closed and say so; every existing task surface keeps working.
    // -------------------------------------------------------------------------------------------
    try {
      await db.execute(sql`ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS project_id UUID`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS employee_tasks_project_idx
        ON employee_tasks (project_id, status)`);
    } catch (e: any) {
      logFail('ensureTaskSchema project_id', e);
    }
}

// ---------------------------------------------------------------------------------------------
// Shared fragments. Every one of them is built from constants declared above, and every one takes
// its ids as bound parameters — nothing in this file interpolates request input into SQL text.
// ---------------------------------------------------------------------------------------------

/**
 * Ids arrive as strings and are compared as text throughout, exactly as employeeFilter() and
 * departmentFilter() do. Two reasons, both load-bearing: a malformed id must return no rows rather
 * than throw "invalid input syntax for type uuid" on the render path, and `department_id` is
 * genuinely a UUID in db/hr-schema.sql and a varchar(50) slug in src/lib/db/schema.ts, so ::uuid
 * would throw on half the estate.
 */
const eq = (column: SQL, value: string | null | undefined): SQL => {
  const v = String(value || '').trim();
  if (!v) return sql`false`;
  return sql`${column}::text = ${v}`;
};

const statusList = (list: TaskStatus[]): SQL => sql.join(list.map((s) => sql`${s}`), sql`, `);

/**
 * THE NORMALISER. Reads the stored status in the canonical vocabulary whatever was written.
 *
 * Built from TASK_STATUSES rather than restated, so adding a status cannot leave this fragment
 * behind — a hand-written list here that drifted from the union would silently file real tasks as
 * 'assigned' and nobody would see it happen.
 */
const CANON: SQL = sql`(CASE
    WHEN t.status IN (${statusList(TASK_STATUSES)}) THEN t.status
    WHEN t.status = 'open' THEN 'assigned'
    WHEN t.status = 'done' THEN 'completed'
    ELSE 'assigned' END)`;

/** Late, and still owed. Closed statuses are never late — there is nothing left to be late for. */
const IS_OVERDUE: SQL = sql`(t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE
    AND ${CANON} NOT IN (${statusList(CLOSED_STATUSES)}))`;

/**
 * The assignee, re-derived from the row rather than taken on trust.
 *
 * An IN over hr_employees rather than a single id because one person can hold more than one
 * hr_employees row — a closed internship plus a current contract. A task sitting on the older row is
 * still theirs to update.
 *
 * (This replaces the first pass's actorOwnsTask(), which was "assignee OR assigner" and was the
 * whole access model when neither collaborators nor leads existed. It is not kept alongside
 * visibleToSql(): two fragments that both mean "may touch this task" is how one of them ends up
 * being the one nobody remembered to update.)
 */
const isAssigneeSql = (viewer: string): SQL =>
  sql`(t.employee_id IN (SELECT ae.id FROM hr_employees ae WHERE ae.user_id::text = ${viewer}))`;

const isAssignerSql = (viewer: string): SQL =>
  sql`(t.assigned_by_user_id IS NOT NULL AND t.assigned_by_user_id::text = ${viewer})`;

/**
 * THE ROLES THAT HOLD 'department.lead', DERIVED FROM THE CAPABILITY MATRIX — never typed out here.
 *
 * This module decides which task rows a viewer may read inside the WHERE clause, deliberately: a row
 * the viewer may not see is never fetched, and filtering after the query is not access control. A
 * capability cannot be evaluated in Postgres, so the fragment below has to name roles — and a
 * hardcoded role name in SQL is exactly the defect this migration removes. rolesHolding() reads
 * PERMS_BY_ROLE, so a grant added to or taken from 'department.lead' in permissions.ts moves this
 * fragment with it instead of leaving it behind.
 *
 * IDENTICAL POPULATION TODAY. 'department.lead' is granted to department_head and to nobody else
 * (not even super_admin — it is a scope, not a rank), so this list is exactly ['department_head'],
 * which is the literal the fragment used to carry.
 *
 * HONEST LIMIT, stated because it is the one thing this does NOT fix: rolesHolding() reads the
 * compiled matrix only, exactly as can() does. A CUSTOM role granted department.lead through the
 * registry is invisible to it — and equally invisible to requireTeamLead() and to the composer, so
 * all three still agree. Resolving custom roles here would ADD holders to the task board, which is a
 * widening and not a mechanism swap.
 *
 * Declared ABOVE isLeadSql because `const` is not hoisted and a reader reaching a later declaration
 * has taken pages down on this project.
 */
const LEAD_ROLE_KEYS: readonly string[] = rolesHolding('department.lead');
const LEAD_ROLE_LIST: SQL = LEAD_ROLE_KEYS.length > 0
  ? sql.join(LEAD_ROLE_KEYS.map((r) => sql`${r}`), sql`, `)
  : sql`NULL`;

/**
 * A department head over the assignee's department.
 *
 * users.role is a Postgres enum, so it is cast to text before lower() — `lower(anyenum)` has no
 * function match and the statement would fail outright. Both department keys are compared as text:
 * departments.id is a varchar(50) slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql, and a
 * ::uuid cast would throw on half the estate. NULL on either side matches nothing, which is the
 * correct answer for a lead whose department was never set.
 *
 * `lu.is_active` IS NOW CHECKED, and it is the one behavioural line in this fragment. can() — which
 * every other lead test resolves through — denies a deactivated account, and this fragment did not,
 * making it the only lead test in the codebase that did not require the viewer to be active. The
 * population is unchanged for every reachable path: validateSessionToken() deletes the session and
 * returns null for a deactivated account (src/lib/auth/session.ts:59-62), so the signed-in viewer
 * whose id reaches this fragment is an active one either way. What changes is that the SQL now says
 * what the capability says, instead of relying on a second module to have said it first.
 *
 * WHAT IS STILL DIVERGENT, AND WAS NOT FIXED HERE — read this before touching the fragment.
 * requireTeamLead() and the composer's leadsDepartment() BOTH additionally refuse an internship
 * engagement; this does not, so an intern holding the department_head role sees, and can move, every
 * task belonging to their department. Closing it would mean re-expressing the four ordered arms of
 * src/lib/auth/intern-signals.ts resolveIsIntern() in SQL — a fourth copy of the very rule that file
 * exists to hold once — or lifting the decision into TypeScript and threading a boolean through
 * every exported function here, which changes signatures in src/pages. Both are real changes to who
 * reads which rows, so under the mechanism-not-policy rule the divergence is REPORTED and the code is
 * left as it is. The fix, when it is approved: resolve the viewer once through resolveWorkspace() and
 * pass `isIntern` down, so this fragment asks the same question the other two ask.
 */
const isLeadSql = (viewer: string): SQL => {
  // No role holds the capability: nobody is a lead by this route. Fail closed rather than emitting
  // `IN ()`, which is a syntax error and would take every task query down.
  if (LEAD_ROLE_KEYS.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM users lu, hr_employees le
     WHERE le.id = t.employee_id
       AND lu.id::text = ${viewer}
       AND lu.is_active = true
       AND lower(lu.role::text) IN (${LEAD_ROLE_LIST})
       AND lu.assigned_department_id IS NOT NULL
       AND le.department_id IS NOT NULL
       AND lu.assigned_department_id::text = le.department_id::text)`;
};

const hasCollabRoleSql = (viewer: string, role: TaskCollaboratorRole): SQL => sql`EXISTS (
    SELECT 1 FROM employee_task_collaborators c
     WHERE c.task_id = t.id AND c.user_id::text = ${viewer} AND c.role = ${role})`;

const isCollaboratorSql = (viewer: string): SQL => sql`EXISTS (
    SELECT 1 FROM employee_task_collaborators c
     WHERE c.task_id = t.id AND c.user_id::text = ${viewer})`;

/**
 * MAY THIS PERSON SEE THIS TASK AT ALL. The assignee, the assigner, anyone listed as a collaborator,
 * or the lead of the assignee's department — decided here, in the WHERE clause, so a row the viewer
 * may not see is never read in the first place. Filtering afterwards is not access control; by then
 * the row has already been fetched into a page's memory.
 *
 * An empty viewer compiles to `false`: an unresolvable viewer sees nothing, never everything.
 */
const visibleToSql = (viewerUserId: string | null | undefined): SQL => {
  const v = String(viewerUserId || '').trim();
  if (!v) return sql`false`;
  return sql`(${isAssigneeSql(v)} OR ${isAssignerSql(v)} OR ${isCollaboratorSql(v)} OR ${isLeadSql(v)})`;
};

/**
 * Does the actor hold ANY of these roles on this task? Used inside the UPDATE that moves a task, so
 * the role that authorised the move is re-derived by the database in the same statement that writes.
 * A role revoked a moment ago cannot be spent on a move a moment later.
 */
const actorHasAnyRoleSql = (viewerUserId: string | null | undefined, roles: TaskActorRole[]): SQL => {
  const v = String(viewerUserId || '').trim();
  if (!v || !roles || roles.length === 0) return sql`false`;
  const parts: SQL[] = [];
  for (const role of roles) {
    if (role === 'assigner') parts.push(isAssignerSql(v));
    else if (role === 'lead') parts.push(isLeadSql(v));
    else if (role === 'assignee') parts.push(sql`(${isAssigneeSql(v)} OR ${hasCollabRoleSql(v, 'assignee')})`);
    else parts.push(hasCollabRoleSql(v, role));
  }
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
};

/**
 * A person's display name from their users id.
 *
 * Correlated subquery against hr_employees, NOT a join to `users`. `users` has `name`, not
 * `full_name` (src/lib/db/schema.ts:50), yet four files already query `u.full_name` and at least one
 * is on a render path with no try/catch — an unresolved landmine this module declines to become the
 * fifth instance of. The ORDER BY is not cosmetic: the multiple-rows-per-person case above means
 * this join can match more than once.
 */
const nameOfUser = (column: SQL): SQL => sql`(
  SELECT n.full_name FROM hr_employees n
   WHERE n.user_id = ${column}
   ORDER BY n.is_active DESC, n.created_at DESC
   LIMIT 1
)`;

/**
 * The legacy read list. It names ONLY columns that existed before this pass — status_changed_at,
 * cancel_reason and the collaborators table are absent on purpose. myTasksView() runs on somebody's
 * phone through src/pages/portal/employee.astro, and if the second-pass DDL ever fails this query
 * must still work. A query that names a column it is not certain of is how three outages started.
 */
const TASK_COLUMNS = sql`
  t.id, t.employee_id, t.assigned_by_user_id, t.title, t.description, t.priority,
  t.due_on, t.created_at, t.completed_at, t.blocked_reason,
  ${CANON} AS canonical_status,
  ${IS_OVERDUE} AS is_overdue,
  ${nameOfUser(sql`t.assigned_by_user_id`)} AS assigned_by_name,
  (SELECT COUNT(*)::int FROM employee_task_comments c WHERE c.task_id = t.id) AS comment_count
`;

const asPriority = (v: any): TaskPriority =>
  (PRIORITIES.indexOf(String(v) as TaskPriority) >= 0 ? String(v) : 'normal') as TaskPriority;

const mapTask = (r: any): EmployeeTask => {
  const state = canonicalStatus(r.canonical_status) || 'assigned';
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? null,
    assignedByUserId: r.assigned_by_user_id ?? null,
    assignedByName: r.assigned_by_name ?? null,
    selfAssigned: !!r.self_assigned,
    title: r.title,
    description: r.description ?? null,
    priority: asPriority(r.priority),
    status: legacyStatusOf(state),
    state,
    stateLabel: STATUS_LABELS[state],
    dueOn: r.due_on ? String(r.due_on).slice(0, 10) : null,
    isOverdue: !!r.is_overdue,
    blockedReason: r.blocked_reason ?? null,
    commentCount: Number(r.comment_count) || 0,
    createdAt: String(r.created_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
  };
};

/** The roles a row's boolean flags and role list say the viewer holds. Order is stable for display. */
const rolesFromRow = (r: any): TaskActorRole[] => {
  const out: TaskActorRole[] = [];
  if (r.is_assignee === true) out.push('assignee');
  if (r.is_assigner === true) out.push('assigner');
  if (r.is_lead === true) out.push('lead');
  for (const raw of String(r.collab_roles || '').split(',')) {
    const role = raw.trim();
    if (!role) continue;
    if (TASK_COLLABORATOR_ROLES.indexOf(role as TaskCollaboratorRole) < 0) continue;
    if (out.indexOf(role as TaskActorRole) >= 0) continue;
    out.push(role as TaskActorRole);
  }
  return out;
};

const mapBoardTask = (r: any): BoardTask => {
  const status = canonicalStatus(r.canonical_status) || 'assigned';
  const viewerRoles = rolesFromRow(r);
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    employeeName: r.employee_name ?? null,
    assignedByUserId: r.assigned_by_user_id ?? null,
    assignedByName: r.assigned_by_name ?? null,
    selfAssigned: !!r.self_assigned,
    title: String(r.title || ''),
    description: r.description ?? null,
    priority: asPriority(r.priority),
    status,
    statusLabel: STATUS_LABELS[status],
    legacyStatus: legacyStatusOf(status),
    dueOn: r.due_on ? String(r.due_on).slice(0, 10) : null,
    isOverdue: !!r.is_overdue,
    blockedReason: r.blocked_reason ?? null,
    cancelReason: r.cancel_reason ?? null,
    commentCount: Number(r.comment_count) || 0,
    collaboratorCount: Number(r.collaborator_count) || 0,
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    statusChangedAt: r.status_changed_at ? String(r.status_changed_at) : null,
    viewerRoles,
    allowedTransitions: allowedTransitionsFor(status, viewerRoles),
  };
};

// ---------------------------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------------------------

/**
 * One person's tasks, open work first and soonest due at the top.
 *
 * `employeeId` MUST come from the session — gate.workspace.employeeId — and never from a query
 * string, a route parameter or a hidden field. employeeFilter() compiles an empty value to `false`,
 * so a caller that skipped its gate gets nothing instead of everyone.
 */
async function readMyTasks(employeeId: string, limit: number): Promise<EmployeeTask[]> {
  return rows(await db.execute(sql`
    SELECT ${TASK_COLUMNS},
           (t.assigned_by_user_id IS NOT NULL
            AND t.assigned_by_user_id = (SELECT e.user_id FROM hr_employees e WHERE e.id = t.employee_id))
             AS self_assigned
      FROM employee_tasks t
     WHERE ${employeeFilter({ employeeId }, sql`t.employee_id`)}
     ORDER BY (${CANON} IN (${statusList(CLOSED_STATUSES)})),
              (t.due_on IS NULL), t.due_on ASC,
              CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              t.created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 300)}`)).map(mapTask);
}

export async function listMyTasks(employeeId: string, limit = 100): Promise<EmployeeTask[]> {
  try {
    await ensureTaskSchema();
    return await readMyTasks(employeeId, limit);
  } catch (e: any) {
    logFail('listMyTasks', e);
    return [];
  }
}

/**
 * The same rows, plus WHETHER THE READ ACTUALLY HAPPENED.
 *
 * listMyTasks() returns [] both when a person has no tasks and when the query threw, and a caller
 * cannot tell those apart. On a screen that is the difference between an absence and a claim: "Nothing
 * on your list right now" printed because employee_tasks could not be read is the page telling
 * somebody they owe no work when it does not know. That is the same shape as the green flash over a
 * failed clock-in, and it is worth an extra return field to avoid.
 *
 * ensureTaskSchema() cannot throw — ensureOnce() swallows — so a database with no employee_tasks
 * table surfaces here as ok:false from the SELECT, which is exactly the intended signal.
 */
export async function myTasksView(employeeId: string, limit = 100): Promise<MyTasksView> {
  try {
    await ensureTaskSchema();
    const tasks = await readMyTasks(employeeId, limit);
    const counts = await readTaskCounts(employeeId);
    return { ok: true, tasks, counts };
  } catch (e: any) {
    logFail('myTasksView', e);
    return { ok: false, tasks: [], counts: { ...EMPTY_COUNTS } };
  }
}

/**
 * Every task in one department, for a team lead.
 *
 * Pass `gate.scopeDepartmentId` from requireEmployee(). workspace-access.ts populates it only for
 * role === 'department_head' and leaves it null for everyone else, and departmentFilter() turns a
 * null into `false` — so the entitlement decision stays in the gate that already owns it, and this
 * function cannot be talked into a wider scope by its caller.
 *
 * Only `full_name` and `designation` are read from hr_employees. The portal's existing `SELECT *`
 * lookups drag gender, Aadhaar, PAN and bank details into the render context of pages that show
 * none of them; `gender` is the exact column read in the 2026-08-02 breach.
 */
export async function listTasksForTeam(departmentId: string | null | undefined, limit = 200): Promise<EmployeeTask[]> {
  try {
    await ensureTaskSchema();
    return rows(await db.execute(sql`
      SELECT ${TASK_COLUMNS},
             e.full_name AS employee_name,
             (t.assigned_by_user_id IS NOT NULL AND t.assigned_by_user_id = e.user_id) AS self_assigned
        FROM employee_tasks t
        JOIN hr_employees e ON e.id = t.employee_id
       WHERE ${departmentFilter({ scopeDepartmentId: departmentId ?? null }, sql`e.department_id`)}
         AND e.is_active = true
       ORDER BY (${CANON} IN (${statusList(CLOSED_STATUSES)})),
                (t.due_on IS NULL), t.due_on ASC,
                e.full_name ASC,
                t.created_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 500)}`)).map(mapTask);
  } catch (e: any) {
    logFail('listTasksForTeam', e);
    return [];
  }
}

/**
 * The counts, in the four buckets the portal card renders.
 *
 * `open` is everything given out but not started (draft, assigned, accepted); `inProgress` covers
 * work in flight including review and sign-off; `done` is `completed` ONLY. Cancelled and archived
 * tasks are in `total` and in no bucket — calling a cancelled task "finished" would inflate somebody's
 * completion count with work that never happened.
 */
async function readTaskCounts(employeeId: string): Promise<TaskCounts> {
  const r = rows(await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE ${CANON} IN ('draft', 'assigned', 'accepted'))::int        AS open_count,
           COUNT(*) FILTER (WHERE ${CANON} IN ('in_progress', 'under_review', 'approved'))::int AS in_progress_count,
           COUNT(*) FILTER (WHERE ${CANON} = 'blocked')::int                                 AS blocked_count,
           COUNT(*) FILTER (WHERE ${CANON} = 'completed')::int                               AS done_count,
           COUNT(*) FILTER (WHERE ${IS_OVERDUE})::int                                        AS overdue_count,
           COUNT(*)::int AS total_count
      FROM employee_tasks t
     WHERE ${employeeFilter({ employeeId }, sql`t.employee_id`)}`))[0];
  if (!r) return { ...EMPTY_COUNTS };
  return {
    open: Number(r.open_count) || 0,
    inProgress: Number(r.in_progress_count) || 0,
    blocked: Number(r.blocked_count) || 0,
    done: Number(r.done_count) || 0,
    overdue: Number(r.overdue_count) || 0,
    total: Number(r.total_count) || 0,
  };
}

/** Headline numbers for one person. Same scoping rule as listMyTasks: employeeId from the session. */
export async function taskCounts(employeeId: string): Promise<TaskCounts> {
  try {
    await ensureTaskSchema();
    return await readTaskCounts(employeeId);
  } catch (e: any) {
    logFail('taskCounts', e);
    return { ...EMPTY_COUNTS };
  }
}

/** One person's line on a load view: what they are still carrying, and how much of it is late. */
export interface TaskLoadRow extends TaskCounts {
  employeeId: string;
  /** open + inProgress + blocked. Everything still owed, in one number a column can sort on. */
  active: number;
}

export interface TaskLoadView {
  /** False means the read did not happen. An empty `rows` with ok:true means genuinely no tasks. */
  ok: boolean;
  rows: TaskLoadRow[];
  /** The same objects, keyed by employee id, so a caller joining to a roster does no scanning. */
  byEmployee: Record<string, TaskLoadRow>;
}

/**
 * THE SAME COUNTS AS taskCounts(), FOR A BATCH OF PEOPLE, IN ONE QUERY.
 *
 * WHY IT LIVES HERE. A load view over a whole roster needs one row per person, and the only two ways
 * to get that were N calls to taskCounts() — forty-two round trips for forty-two employees — or a
 * fresh SELECT over employee_tasks written on the surface that needed it. The second is the one that
 * costs: it would be a FIFTH reader of these rows with its own idea of what "open" and "overdue"
 * mean, and the day CANON gains a status the surface would go on filing it somewhere else. So the
 * aggregate is written once, here, beside CANON and IS_OVERDUE, from the SAME two fragments
 * readTaskCounts() uses. There is one definition of a late task in this codebase and this shares it.
 *
 * IT IS NOT SCOPED, AND THAT IS THE CALLER'S JOB. taskCounts() takes an employeeId the session
 * already established; this takes a LIST, so the list is the scope. Every caller must pass ids it has
 * already established the viewer may see — the same contract allocationFor() states in projects.ts —
 * and an empty list returns an empty answer rather than everybody.
 *
 * ok:false ON FAILURE, NEVER AN EMPTY ROSTER. "Nobody has any work" and "we could not read the work"
 * are opposite facts, and a load view that renders the second as the first tells a founder their
 * whole company is idle.
 */
export async function taskLoadFor(employeeIds: string[]): Promise<TaskLoadView> {
  const ids = Array.from(
    new Set((employeeIds || []).map((v) => String(v || '').trim()).filter((v) => UUID_RE.test(v))),
  );
  if (ids.length === 0) return { ok: true, rows: [], byEmployee: {} };

  try {
    await ensureTaskSchema();
    // Individual placeholders, never = ANY($jsArray): postgres-js rejects a JS array on the right of
    // ANY on this driver ("op ANY/ALL (array) requires array on right side").
    const idList = sql.join(ids.map((v) => sql`${v}`), sql`, `);
    const list = rows(await db.execute(sql`
      SELECT t.employee_id::text AS employee_id,
             COUNT(*) FILTER (WHERE ${CANON} IN ('draft', 'assigned', 'accepted'))::int           AS open_count,
             COUNT(*) FILTER (WHERE ${CANON} IN ('in_progress', 'under_review', 'approved'))::int AS in_progress_count,
             COUNT(*) FILTER (WHERE ${CANON} = 'blocked')::int                                    AS blocked_count,
             COUNT(*) FILTER (WHERE ${CANON} = 'completed')::int                                  AS done_count,
             COUNT(*) FILTER (WHERE ${IS_OVERDUE})::int                                           AS overdue_count,
             COUNT(*)::int AS total_count
        FROM employee_tasks t
       WHERE t.employee_id::text IN (${idList})
       GROUP BY t.employee_id`));

    const byEmployee: Record<string, TaskLoadRow> = {};
    // Every id asked for gets a row, including the ones with no tasks at all. A person missing from
    // the GROUP BY has nothing assigned, and that is a fact worth rendering, not a row to drop.
    for (const id of ids) {
      byEmployee[id] = { ...EMPTY_COUNTS, employeeId: id, active: 0 };
    }
    for (const r of list) {
      const id = String(r.employee_id || '').trim();
      if (!byEmployee[id]) continue;
      const open = Number(r.open_count) || 0;
      const inProgress = Number(r.in_progress_count) || 0;
      const blocked = Number(r.blocked_count) || 0;
      byEmployee[id] = {
        employeeId: id,
        open,
        inProgress,
        blocked,
        done: Number(r.done_count) || 0,
        overdue: Number(r.overdue_count) || 0,
        total: Number(r.total_count) || 0,
        active: open + inProgress + blocked,
      };
    }
    return { ok: true, rows: ids.map((id) => byEmployee[id]), byEmployee };
  } catch (e: any) {
    logFail('taskLoadFor', e);
    return { ok: false, rows: [], byEmployee: {} };
  }
}

/**
 * Comments on one task, for anyone who may see the task: the assignee, the assigner, a collaborator
 * of any role, or the department lead. Anyone else gets an empty list.
 *
 * WIDENED IN THE SECOND PASS. It used to be the assignee and the assigner only, which predates
 * collaborators existing at all — a reviewer who could not read the conversation could not review
 * anything. The clause is the same visibleToSql() the detail view uses, so there is one definition of
 * "may see this task" and not two that drift.
 */
export async function listComments(taskId: string, viewerUserId: string): Promise<TaskComment[]> {
  try {
    await ensureTaskSchema();
    return rows(await db.execute(sql`
      SELECT c.id, c.task_id, c.author_user_id, c.body, c.created_at,
             ${nameOfUser(sql`c.author_user_id`)} AS author_name
        FROM employee_task_comments c
        JOIN employee_tasks t ON t.id = c.task_id
       WHERE ${eq(sql`c.task_id`, taskId)} AND ${visibleToSql(viewerUserId)}
       ORDER BY c.created_at ASC
       LIMIT 200`)).map((r: any) => ({
        id: r.id,
        taskId: r.task_id,
        authorUserId: r.author_user_id,
        authorName: r.author_name ?? null,
        body: r.body,
        createdAt: String(r.created_at),
      }));
  } catch (e: any) {
    logFail('listComments', e);
    return [];
  }
}

/** Who is on a task, for anyone who may see the task. Same clause, same reason. */
export async function listCollaborators(taskId: string, viewerUserId: string): Promise<TaskCollaborator[]> {
  try {
    await ensureTaskSchema();
    return rows(await db.execute(sql`
      SELECT col.id, col.task_id, col.user_id, col.role, col.added_by_user_id, col.added_at,
             ${nameOfUser(sql`col.user_id`)} AS person_name
        FROM employee_task_collaborators col
        JOIN employee_tasks t ON t.id = col.task_id
       WHERE ${eq(sql`col.task_id`, taskId)} AND ${visibleToSql(viewerUserId)}
       ORDER BY col.added_at ASC
       LIMIT 200`)).map((r: any) => {
        const role = (TASK_COLLABORATOR_ROLES.indexOf(String(r.role) as TaskCollaboratorRole) >= 0
          ? String(r.role) : 'watcher') as TaskCollaboratorRole;
        return {
          id: String(r.id),
          taskId: String(r.task_id),
          userId: String(r.user_id),
          name: r.person_name ?? null,
          role,
          roleLabel: COLLABORATOR_ROLE_LABELS[role],
          addedByUserId: r.added_by_user_id ?? null,
          addedAt: r.added_at ? String(r.added_at) : null,
        };
      });
  } catch (e: any) {
    logFail('listCollaborators', e);
    return [];
  }
}

/**
 * The full board row list for one viewer: the task, and the roles that viewer holds on it, resolved
 * by the database in the same statement. Nothing downstream may claim a role this did not return.
 */
const VIEWER_ROLE_COLUMNS = (viewer: string): SQL => sql`
  ${isAssigneeSql(viewer)} AS is_assignee,
  ${isAssignerSql(viewer)} AS is_assigner,
  ${isLeadSql(viewer)} AS is_lead,
  COALESCE((SELECT string_agg(DISTINCT c.role, ',')
              FROM employee_task_collaborators c
             WHERE c.task_id = t.id AND c.user_id::text = ${viewer}), '') AS collab_roles`;

/** The board/detail column list. Names the second-pass columns, so it is used only by new surfaces. */
const BOARD_TASK_COLUMNS = sql`
  t.id, t.employee_id, t.assigned_by_user_id, t.title, t.description, t.priority,
  t.due_on, t.created_at, t.updated_at, t.completed_at, t.blocked_reason, t.cancel_reason,
  t.status_changed_at,
  ${CANON} AS canonical_status,
  ${IS_OVERDUE} AS is_overdue,
  ${nameOfUser(sql`t.assigned_by_user_id`)} AS assigned_by_name,
  (SELECT COUNT(*)::int FROM employee_task_comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*)::int FROM employee_task_collaborators c WHERE c.task_id = t.id) AS collaborator_count,
  (SELECT e.full_name FROM hr_employees e WHERE e.id = t.employee_id
    ORDER BY e.is_active DESC, e.created_at DESC LIMIT 1) AS employee_name,
  (t.assigned_by_user_id IS NOT NULL
   AND t.assigned_by_user_id = (SELECT e.user_id FROM hr_employees e WHERE e.id = t.employee_id))
    AS self_assigned`;

/**
 * The detail view's columns: the board's, plus the assignee's department KEY.
 *
 * A separate fragment rather than an extra line in BOARD_TASK_COLUMNS, because that one runs once
 * per row for a whole department on /portal/tasks and this is wanted once, on one task. The board
 * does not render a department and must not pay a correlated subquery per card for it.
 *
 * Only the key is read here. The NAME is looked up afterwards, in its own try/catch — the same split
 * workspace-access.ts makes, and for the same reason: a department name is a label, not a
 * permission, and losing the whole task detail because `departments` could not be read would be the
 * wrong failure. `department_id` is a UUID in db/hr-schema.sql and a varchar(50) slug in
 * src/lib/db/schema.ts, so it is carried as text and never cast.
 */
const DETAIL_TASK_COLUMNS = sql`${BOARD_TASK_COLUMNS},
  (SELECT e.department_id FROM hr_employees e WHERE e.id = t.employee_id
    ORDER BY e.is_active DESC, e.created_at DESC LIMIT 1) AS employee_department_id`;

/**
 * ONE task, with its comments and the people on it — or nothing, if this viewer may not see it.
 *
 * The visibility decision is a WHERE clause (visibleToSql), not a filter applied to a row that has
 * already been read. src/pages/admin/users/[id].astro is the shape being avoided: it SELECTs the
 * target first and redirects afterwards, which means the data was in memory before the check ran.
 *
 * Returns `ok:false` with a reason rather than a bare null, because "you may not see this" and "the
 * database did not answer" must not render the same sentence at somebody.
 */
export async function getTaskView(taskId: string, viewerUserId: string): Promise<TaskDetailView> {
  const viewer = String(viewerUserId || '').trim();
  // ok:false, not ok:true with nothing in it. No read happened, so "there is no such task" is not a
  // fact this function is in a position to state.
  if (!viewer || !String(taskId || '').trim()) {
    return { ok: false, reason: 'no-viewer', detail: null };
  }

  try {
    await ensureTaskSchema();

    const row = rows(await db.execute(sql`
      SELECT ${DETAIL_TASK_COLUMNS}, ${VIEWER_ROLE_COLUMNS(viewer)}
        FROM employee_tasks t
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${visibleToSql(viewer)}
       LIMIT 1`))[0];

    if (!row) return { ok: true, reason: 'not-visible', detail: null };

    const task = mapBoardTask(row);
    const [comments, collaborators] = await Promise.all([
      listComments(taskId, viewer),
      listCollaborators(taskId, viewer),
    ]);

    // The label, allowed to fail on its own. See the note on DETAIL_TASK_COLUMNS.
    const deptId = row.employee_department_id === null || row.employee_department_id === undefined
      ? null
      : String(row.employee_department_id).trim() || null;
    let department: TaskDepartment | null = deptId ? { id: deptId, name: null } : null;
    if (department) {
      try {
        const d = rows(await db.execute(sql`
          SELECT name FROM departments WHERE id::text = ${department.id} LIMIT 1`))[0];
        if (d?.name) department.name = String(d.name);
      } catch (e: any) {
        logFail('getTaskView department', e);
      }
    }

    return {
      ok: true,
      reason: 'ok',
      detail: {
        task,
        comments,
        collaborators,
        viewerRoles: task.viewerRoles,
        // Everyone who can see it can say something about it. That IS the watcher's whole right.
        viewerMayComment: task.viewerRoles.length > 0,
        department,
      },
    };
  } catch (e: any) {
    logFail('getTaskView', e);
    return { ok: false, reason: 'lookup-failed', detail: null };
  }
}

/**
 * One task with its comments, or null if the viewer may not see it.
 *
 * Thin wrapper over getTaskView. Note that a database failure also lands as null here, which is why
 * getTaskView exists: a page that must distinguish "no such task" from "we could not read" should
 * call that one and render two different sentences.
 */
export async function getTask(taskId: string, viewerUserId: string): Promise<TaskDetail | null> {
  return (await getTaskView(taskId, viewerUserId)).detail;
}

// ---------------------------------------------------------------------------------------------
// THE ACTIVITY TRAIL. What was done to this task, by whom, in what capacity, and when.
//
// WHY IT IS READ FROM audit_log AND NOT FROM THE TASK ROW. employee_tasks carries the CURRENT
// status and status_changed_at, which answers "where is it now" and nothing else. Who moved it out
// of `under_review` three weeks ago, whether the approver or the lead signed it off, and what reason
// was given when it was blocked are only in the audit records the writes above already emit. That is
// the difference between a status field and a defensible record.
//
// THE VISIBILITY CLAUSE IS THE SAME ONE. The read joins employee_tasks and carries visibleToSql(),
// so history is readable exactly by the people who may read the task — decided in the WHERE clause,
// not filtered afterwards. Calling this without being able to see the task returns nothing.
//
// WHAT IT IS NOT: A COMPLETE LOG, AND NOTHING HERE MAY CLAIM OTHERWISE.
//   1. logAudit() swallows its own failures (src/lib/audit.ts:21) — by design, so a task write is
//      never lost because the audit insert failed. The consequence is that a move CAN have happened
//      with no record of it here.
//   2. addComment() is not audited at all. Comments are their own list; the trail does not repeat
//      them, and a screen must not describe this as "everything that happened".
//   3. Nothing before the audit call existed is in here, and old rows are never backfilled.
// Word the heading accordingly: it records status changes and changes to who is on the task.
// ---------------------------------------------------------------------------------------------

/** One row of the trail, already turned into the words a screen renders. */
export interface TaskActivityEntry {
  actorName: string;
  /** The capacity they acted in AS RECORDED AT THE TIME, not as it stands today. */
  actorRole: string | null;
  /** A verb phrase: 'created this task', 'moved this task'. */
  action: string;
  /** Previous and new value. Raw status keys when kind is 'status' — a badge derives its own word. */
  from: string | null;
  to: string | null;
  kind: 'status' | 'text';
  note: string | null;
  at: string;
}

export interface TaskActivityView {
  /** False means the trail was not read. An empty trail with ok:true means there is genuinely
   *  nothing recorded — never render "nothing has happened" on a failed read. */
  ok: boolean;
  reason: 'ok' | 'no-viewer' | 'lookup-failed';
  entries: TaskActivityEntry[];
}

/**
 * The actor's own roles, as a phrase. Reads ACTOR_ROLE_LABELS so the trail says "the department
 * lead" in the same words canTransition() uses when it refuses somebody.
 *
 * WHICH KEY HOLDS THEM DEPENDS ON THE ACTION, and getting it wrong would put a false capacity next
 * to a person's name. moveTask writes the actor's roles as `roles`; addCollaborator and
 * removeCollaborator write them as `byRoles`, and removeCollaborator's `roles` is something else
 * entirely — the roles that were REMOVED from the target. Each branch below names its own key.
 */
const roleLabelsOf = (v: any): string | null => {
  const list = Array.isArray(v) ? v : (v ? [v] : []);
  const names: string[] = [];
  for (const raw of list) {
    const label = ACTOR_ROLE_LABELS[String(raw) as TaskActorRole];
    if (label && names.indexOf(label) < 0) names.push(label);
  }
  return names.length > 0 ? names.join(' and ') : null;
};

const collabRoleLabel = (v: any): string => {
  const key = String(v || '').trim().toLowerCase() as TaskCollaboratorRole;
  return COLLABORATOR_ROLE_LABELS[key] || String(v || '').trim() || 'a role we no longer use';
};

const mapActivity = (r: any): TaskActivityEntry => {
  // jsonb comes back as an object; a null column and a legacy string both fall back to {}.
  const diff: any = (r.diff && typeof r.diff === 'object' && !Array.isArray(r.diff)) ? r.diff : {};
  const action = String(r.action || '').trim();
  const at = String(r.created_at);
  // A name is not a permission and its absence is not an error — hr_employees may simply carry no
  // row for that account. Never render a bare UUID at somebody.
  const actorName = String(r.actor_name || '').trim() || 'Someone whose name is not on record';
  const targetName = String(r.target_name || '').trim();
  const base = { actorName, at, from: null as string | null, to: null as string | null };

  if (action === 'task.assign') {
    const to = canonicalStatus(diff.status);
    const bits: string[] = [];
    if (diff.priority && String(diff.priority) !== 'normal') bits.push('Priority ' + String(diff.priority) + '.');
    if (diff.dueOn) bits.push('Due ' + String(diff.dueOn).slice(0, 10) + '.');
    return {
      ...base,
      actorRole: ACTOR_ROLE_LABELS.assigner,
      action: 'created this task',
      to,
      kind: 'status',
      note: bits.length > 0 ? bits.join(' ') : null,
    };
  }

  if (action === 'task.status' || action === 'task.complete') {
    return {
      ...base,
      actorRole: roleLabelsOf(diff.roles),
      action: 'moved this task',
      from: canonicalStatus(diff.from),
      to: canonicalStatus(diff.to),
      kind: 'status',
      // moveTask only stores a reason for the statuses that demand one; null everywhere else.
      note: diff.reason ? String(diff.reason) : null,
    };
  }

  if (action === 'task.collaborator.add') {
    return {
      ...base,
      actorRole: roleLabelsOf(diff.byRoles),
      action: targetName ? 'added ' + targetName : 'added someone whose name is not on record',
      to: collabRoleLabel(diff.role),
      kind: 'text',
      note: null,
    };
  }

  if (action === 'task.collaborator.remove') {
    const removed = (Array.isArray(diff.roles) ? diff.roles : []).map(collabRoleLabel).join(', ');
    return {
      ...base,
      actorRole: roleLabelsOf(diff.byRoles),
      action: diff.selfRemoval === true
        ? 'took themselves off this task'
        : 'took ' + (targetName || 'someone whose name is not on record') + ' off this task',
      from: removed || null,
      kind: 'text',
      note: null,
    };
  }

  // An action this function has not been taught. Shown as itself rather than dropped: a trail that
  // silently omits what it does not recognise is worse than one that shows a bare verb, because the
  // reader cannot tell the difference between "nothing happened" and "we hid it".
  return { ...base, actorRole: null, action: action || 'did something we no longer have a name for', kind: 'text', note: null };
};

/**
 * The trail for one task, oldest first.
 *
 * Chronological rather than newest-first on purpose: this is read months later to reconstruct what
 * happened in order, and a history that runs backwards has to be read backwards.
 *
 * Both name lookups compare as TEXT and cast nothing. `diff->>'userId'` is whatever was written into
 * a jsonb blob; `(...)::uuid` on it would throw on the render path the first time anything put a
 * non-uuid there, and a page that cannot render is a worse outcome than a name that resolves to null.
 */
export async function listTaskActivity(
  taskId: string,
  viewerUserId: string,
  limit = 200,
): Promise<TaskActivityView> {
  const viewer = String(viewerUserId || '').trim();
  if (!viewer || !String(taskId || '').trim()) return { ok: false, reason: 'no-viewer', entries: [] };

  try {
    await ensureTaskSchema();

    const list = rows(await db.execute(sql`
      SELECT a.action, a.diff, a.created_at,
             ${nameOfUser(sql`a.user_id`)} AS actor_name,
             (SELECT n.full_name FROM hr_employees n
               WHERE n.user_id::text = a.diff->>'userId'
               ORDER BY n.is_active DESC, n.created_at DESC
               LIMIT 1) AS target_name
        FROM audit_log a
        JOIN employee_tasks t ON t.id::text = a.entity_id
       WHERE a.entity = 'employee_task'
         AND ${eq(sql`a.entity_id`, taskId)}
         AND ${visibleToSql(viewer)}
       ORDER BY a.created_at ASC
       LIMIT ${Math.min(Math.max(limit, 1), 500)}`)).map(mapActivity);

    return { ok: true, reason: 'ok', entries: list };
  } catch (e: any) {
    logFail('listTaskActivity', e);
    // ok:false, never an empty trail presented as fact. "Nothing has been done to this task" is a
    // claim about a record, and a failed read is not in a position to make it.
    return { ok: false, reason: 'lookup-failed', entries: [] };
  }
}

/**
 * EVERYTHING THIS VIEWER MAY SEE, GROUPED FOR THE BOARD, IN ONE QUERY.
 *
 * One query, not one per column. Ten SELECTs — one per status — would be ten round trips that can
 * disagree with each other: a task moved between the third and the seventh appears twice or not at
 * all, and the board shows a state that never existed. One statement, grouped in memory afterwards,
 * cannot do that.
 *
 * The scope is the same four routes as getTask, decided in the WHERE clause. An unresolvable viewer
 * gets an empty board, never everyone's.
 */
export async function listBoard(
  viewerUserId: string,
  opts: {
    assigneeEmployeeId?: string | null;
    priority?: string | null;
    overdueOnly?: boolean;
    includeArchived?: boolean;
    limit?: number;
  } = {},
): Promise<BoardView> {
  const viewer = String(viewerUserId || '').trim();

  const wantedPriority = String(opts.priority || '').trim().toLowerCase();
  const priority: TaskPriority | null =
    PRIORITIES.indexOf(wantedPriority as TaskPriority) >= 0 ? (wantedPriority as TaskPriority) : null;
  // An unusable filter is DROPPED and SAID OUT LOUD. Applying nothing while the chip still reads
  // "Urgent" would show a full board under a label claiming it is filtered.
  const notice = wantedPriority && !priority
    ? 'That priority is not one we track, so the board is not filtered by priority.'
    : null;

  const assignee = String(opts.assigneeEmployeeId || '').trim() || null;
  const overdueOnly = opts.overdueOnly === true;
  const includeArchived = opts.includeArchived === true;

  const filters: BoardFilters = {
    assigneeEmployeeId: assignee,
    priority,
    overdueOnly,
    includeArchived,
  };

  const columnsFor = (list: BoardTask[]): BoardColumn[] => {
    const shown = TASK_STATUSES.filter((s) => includeArchived || s !== 'archived');
    return shown.map((status) => {
      const tasks = list.filter((t) => t.status === status);
      return { status, label: STATUS_LABELS[status], count: tasks.length, tasks };
    });
  };

  // An unresolvable viewer sees nothing — and the board is told the read did not happen, so it
  // renders "we could not load this" rather than an empty board that reads as "no work exists".
  if (!viewer) {
    return { ok: false, reason: 'no-viewer', columns: columnsFor([]), tasks: [], total: 0, overdue: 0, filters, notice };
  }

  try {
    await ensureTaskSchema();

    const assigneeClause = assignee ? sql`AND ${eq(sql`t.employee_id`, assignee)}` : sql``;
    const priorityClause = priority ? sql`AND t.priority = ${priority}` : sql``;
    const overdueClause = overdueOnly ? sql`AND ${IS_OVERDUE}` : sql``;
    const archivedClause = includeArchived ? sql`` : sql`AND ${CANON} <> 'archived'`;
    const limit = Math.min(Math.max(Number(opts.limit) || 400, 1), 1000);

    const list = rows(await db.execute(sql`
      SELECT ${BOARD_TASK_COLUMNS}, ${VIEWER_ROLE_COLUMNS(viewer)}
        FROM employee_tasks t
       WHERE ${visibleToSql(viewer)}
         ${assigneeClause}
         ${priorityClause}
         ${overdueClause}
         ${archivedClause}
       ORDER BY (t.due_on IS NULL), t.due_on ASC,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                t.created_at DESC
       LIMIT ${limit}`)).map(mapBoardTask);

    return {
      ok: true,
      reason: 'ok',
      columns: columnsFor(list),
      tasks: list,
      total: list.length,
      overdue: list.filter((t) => t.isOverdue).length,
      filters,
      notice,
    };
  } catch (e: any) {
    logFail('listBoard', e);
    // Fail closed AND say so. An empty board rendered as fact would tell a lead their department has
    // no work in flight.
    return { ok: false, reason: 'lookup-failed', columns: columnsFor([]), tasks: [], total: 0, overdue: 0, filters, notice };
  }
}

// ---------------------------------------------------------------------------------------------
// Writes. Every one of them re-derives the actor's authority inside the statement that writes.
// ---------------------------------------------------------------------------------------------

/**
 * Put a task on someone's list.
 *
 * The INSERT is written as INSERT ... SELECT so that the right to assign is evaluated by the
 * database, in the same statement, against the target's own row. There is no read-then-write gap
 * for a concurrent change to slip through, and no code path where a caller's claim about who they
 * are is believed. If the SELECT matches nothing the INSERT writes nothing and the refusal is the
 * same sentence whether the employee does not exist, is inactive, or simply is not theirs to assign.
 *
 * `scopeDepartmentId` is the department-head route and must come from gate.scopeDepartmentId; when
 * it is absent the clause is not in the statement at all.
 */
export async function createTask(input: {
  employeeId: string;
  assignedByUserId: string;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  dueOn?: string | null;
  scopeDepartmentId?: string | null;
  /** 'draft' keeps it off the assignee's list until it is deliberately assigned. Defaults to assigned. */
  status?: 'draft' | 'assigned';
  ipAddress?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = (input.title || '').trim();
  const assigner = String(input.assignedByUserId || '').trim();
  const employeeId = String(input.employeeId || '').trim();

  if (title.length < 3) return { ok: false, error: 'Give the task a title.' };
  if (!employeeId || !assigner) return { ok: false, error: NOT_AVAILABLE };
  // The value goes into a ::uuid cast below, where a malformed string throws rather than refuses.
  if (!UUID_RE.test(assigner)) return { ok: false, error: NOT_AVAILABLE };

  const priority: TaskPriority = PRIORITIES.indexOf(input.priority as TaskPriority) >= 0
    ? (input.priority as TaskPriority) : 'normal';

  const status: TaskStatus = input.status === 'draft' ? 'draft' : 'assigned';

  // A malformed date reaching a DATE column throws. Validate the shape here and refuse in words.
  const dueRaw = String(input.dueOn || '').trim();
  if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
    return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };
  }
  const dueOn = dueRaw || null;

  const scope = String(input.scopeDepartmentId || '').trim();
  const leadClause = scope ? sql`OR e.department_id::text = ${scope}` : sql``;

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO employee_tasks (employee_id, assigned_by_user_id, title, description, priority, status, due_on)
      SELECT e.id, ${assigner}::uuid, ${title.slice(0, 300)},
             ${(input.description || '').trim().slice(0, 4000) || null},
             ${priority}, ${status}, ${dueOn}::date
        FROM hr_employees e
       WHERE e.id::text = ${employeeId}
         AND e.is_active = true
         AND (
           e.user_id::text = ${assigner}
           OR e.reporting_manager_id::text = ${assigner}
           ${leadClause}
         )
      RETURNING id, employee_id`))[0];

    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId: assigner,
      action: 'task.assign',
      entity: 'employee_task',
      entityId: String(r.id),
      diff: { employeeId: r.employee_id, title: title.slice(0, 300), priority, dueOn, status },
      ipAddress: input.ipAddress || undefined,
    });

    // SEED THE TWO OBVIOUS COLLABORATORS, and never at the cost of the task itself.
    //
    // The person who handed the work out is its approver by default — otherwise every task would
    // reach `under_review` with nobody entitled to sign it off, and only a department lead could
    // unstick it. Best-effort on purpose: base visibility (assignee, assigner, lead) does NOT come
    // from these rows, so a task with no collaborator rows is still readable and workable by exactly
    // the people it was before. A failure here is logged and the task still exists.
    await seedCollaborators(String(r.id), String(r.employee_id), assigner);

    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('createTask', e);
    // logFail above already recorded e.cause.message. See WRITE_FAILED for why it is not echoed back.
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Assignee -> 'assignee', assigner -> 'approver'. Never throws; the caller has already committed the
 * task and must not fail after the fact because a convenience row could not be written.
 */
async function seedCollaborators(taskId: string, employeeId: string, assignerUserId: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO employee_task_collaborators (task_id, user_id, role, added_by_user_id)
      SELECT ${taskId}::uuid, e.user_id, 'assignee', ${assignerUserId}::uuid
        FROM hr_employees e
       WHERE e.id::text = ${employeeId}
         AND e.user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM employee_task_collaborators c
                          WHERE c.task_id = ${taskId}::uuid AND c.user_id = e.user_id AND c.role = 'assignee')`);

    await db.execute(sql`
      INSERT INTO employee_task_collaborators (task_id, user_id, role, added_by_user_id)
      SELECT ${taskId}::uuid, ${assignerUserId}::uuid, 'approver', ${assignerUserId}::uuid
       WHERE NOT EXISTS (SELECT 1 FROM employee_task_collaborators c
                          WHERE c.task_id = ${taskId}::uuid AND c.user_id = ${assignerUserId}::uuid
                            AND c.role = 'approver')`);
  } catch (e: any) {
    logFail('createTask seedCollaborators', e);
  }
}

/** The status and the viewer's roles, read once, for a write that is about to be validated. */
interface TaskAccessSnapshot {
  id: string;
  employeeId: string;
  title: string;
  status: TaskStatus;
  roles: TaskActorRole[];
}

async function readTaskAccess(taskId: string, viewerUserId: string): Promise<TaskAccessSnapshot | null> {
  const viewer = String(viewerUserId || '').trim();
  if (!viewer) return null;

  const r = rows(await db.execute(sql`
    SELECT t.id, t.employee_id, t.title, ${CANON} AS canonical_status, ${VIEWER_ROLE_COLUMNS(viewer)}
      FROM employee_tasks t
     WHERE ${eq(sql`t.id`, taskId)}
       AND ${visibleToSql(viewer)}
     LIMIT 1`))[0];

  if (!r) return null;
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    title: String(r.title || ''),
    status: canonicalStatus(r.canonical_status) || 'assigned',
    roles: rolesFromRow(r),
  };
}

/**
 * MOVE A TASK. The one write both the drag island and the no-JS form call.
 *
 * Three things have to be true and all three are checked before anything is written: the transition
 * exists in the graph, this actor holds a role allowed to walk it, and any status that demands a
 * reason has one. A refusal comes back as a sentence — an invalid move is REFUSED, never quietly
 * written and never silently ignored, because a status field that accepts anything is a shared text
 * box and not a workflow.
 *
 * THE READ AND THE WRITE CANNOT DISAGREE. The UPDATE carries three guards of its own: the id, the
 * status it was validated against (`${CANON} = from`, so a concurrent move makes this one write zero
 * rows rather than overwrite it), and actorHasAnyRoleSql() for exactly the roles this edge allows. A
 * role removed between the read and the write cannot be spent, and a task somebody else moved in the
 * meantime is reported as moved rather than clobbered.
 */
export async function moveTask(
  taskId: string,
  actorUserId: string,
  toStatus: AnyTaskStatus | string,
  opts: { reason?: string | null; ipAddress?: string | null } = {},
): Promise<{ ok: boolean; status?: TaskStatus; changed?: boolean; error?: string }> {
  const actor = String(actorUserId || '').trim();
  const to = canonicalStatus(toStatus);

  if (!to) return { ok: false, error: 'That is not a status we track.' };
  if (!actor || !String(taskId || '').trim()) return { ok: false, error: NOT_AVAILABLE };

  const reason = String(opts.reason || '').trim();

  try {
    await ensureTaskSchema();

    const snap = await readTaskAccess(taskId, actor);
    if (!snap) return { ok: false, error: NOT_AVAILABLE };

    // Dropping a card back in the column it came from is not an error and must not be reported as
    // one. Nothing is written and nothing is audited, because nothing happened.
    if (snap.status === to) return { ok: true, status: to, changed: false };

    const check = canTransition(snap.status, to, snap.roles);
    if (!check.ok) return { ok: false, error: check.reason || NOT_AVAILABLE };

    if (statusNeedsReason(to) && reason.length < REASON_MIN) {
      return {
        ok: false,
        error: to === 'blocked'
          ? 'Say what is blocking it, so someone can unblock it.'
          : 'Say why it is being cancelled, so the record explains itself later.',
      };
    }

    const allowedRoles = TRANSITIONS[snap.status]?.[to] || [];
    if (allowedRoles.length === 0) return { ok: false, error: NOT_AVAILABLE };

    // Reaching `completed` stamps completed_at; leaving it clears it, so a reopened task does not
    // keep claiming a completion date that no longer happened. The two reason columns work the same
    // way: a task that is no longer blocked must not still show why it once was.
    const completedAt = to === 'completed' ? sql`NOW()` : sql`NULL`;
    const blockedReason = to === 'blocked' ? sql`${reason.slice(0, 2000)}` : sql`NULL`;
    const cancelReason = to === 'cancelled' ? sql`${reason.slice(0, 2000)}` : sql`NULL`;

    const r = rows(await db.execute(sql`
      UPDATE employee_tasks AS t
         SET status = ${to},
             blocked_reason = ${blockedReason},
             cancel_reason = ${cancelReason},
             completed_at = ${completedAt},
             status_changed_at = NOW(),
             updated_at = NOW()
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${CANON} = ${snap.status}
         AND ${actorHasAnyRoleSql(actor, allowedRoles)}
      RETURNING t.id, t.employee_id, t.title`))[0];

    if (!r?.id) {
      // Zero rows after the checks passed means the row changed underneath us — a colleague moved
      // the same card. Say that, rather than "not available", which would read as a permission
      // problem and send somebody to ask for access they already have.
      return { ok: false, error: 'That task changed while this page was open. Reload it and try again.' };
    }

    await logAudit({
      userId: actor,
      action: to === 'completed' ? 'task.complete' : 'task.status',
      entity: 'employee_task',
      entityId: String(r.id),
      diff: {
        employeeId: r.employee_id,
        title: r.title,
        from: snap.status,
        to,
        roles: snap.roles,
        reason: statusNeedsReason(to) ? reason.slice(0, 2000) : null,
      },
      ipAddress: opts.ipAddress || undefined,
    });

    return { ok: true, status: to, changed: true };
  } catch (e: any) {
    logFail('moveTask', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Move a task's status — the original signature, still exactly what src/pages/portal/employee.astro
 * posts to.
 *
 * It speaks the four legacy values ('open', 'in_progress', 'blocked', 'done'), which
 * canonicalStatus() maps onto the real ones before moveTask validates the transition. Behaviour that
 * page relies on is unchanged: the assignee and the assigner can still start, block and finish work
 * from their phone, and `blocked` still demands a stated cause. What is new is that a move the
 * workflow does not allow now comes back as a sentence explaining who may make it, instead of being
 * written because nobody was checking.
 */
export async function updateTaskStatus(
  taskId: string,
  actorUserId: string,
  status: AnyTaskStatus,
  opts: { blockedReason?: string | null; ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const res = await moveTask(taskId, actorUserId, status, {
    reason: opts.blockedReason || '',
    ipAddress: opts.ipAddress || null,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Comment on a task. Anyone who may SEE the task may comment on it, watchers included — that is the
 * whole of a watcher's rights, and a person who can read the work but not say "this is blocked on
 * me" is a person the board silences for no reason.
 *
 * Enforced the same way as every other write here: INSERT ... SELECT, so the entitlement is part of
 * the statement rather than a check standing in front of it.
 */
export async function addComment(
  taskId: string,
  authorUserId: string,
  body: string,
  opts: { ipAddress?: string | null } = {},
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const text = (body || '').trim();
  if (text.length < 1) return { ok: false, error: 'Write something first.' };

  const author = String(authorUserId || '').trim();
  if (!author) return { ok: false, error: NOT_AVAILABLE };
  if (!UUID_RE.test(author)) return { ok: false, error: NOT_AVAILABLE };

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO employee_task_comments (task_id, author_user_id, body)
      SELECT t.id, ${author}::uuid, ${text.slice(0, 4000)}
        FROM employee_tasks t
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${visibleToSql(author)}
      RETURNING id`))[0];

    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addComment', e);
    // logFail above already recorded e.cause.message. See WRITE_FAILED for why it is not echoed back.
    return { ok: false, error: WRITE_FAILED };
  }
}

// ---------------------------------------------------------------------------------------------
// Collaborators.
//
// WHO MAY ADD WHOM, and why it is not simply "anyone on the task". Roles are not labels here: an
// approver is the only person who can sign work off. If the assignee could add themselves as an
// approver, every review gate in this file would be one form POST away from meaningless — the person
// doing the work would approve the work. So:
//
//   - the assigner or the department lead may add ANY role, including reviewer and approver;
//   - the assignee or a co-assignee may pull in help — 'watcher' and 'co_assignee' only;
//   - a reviewer, an approver or a watcher may add nobody.
//
// Removal is narrower still: the assigner, the lead, or a person taking themselves off. Both are
// audited, because a change to who may approve work is a change to who holds authority.
// ---------------------------------------------------------------------------------------------

const CAN_ADD_ANY_ROLE: TaskActorRole[] = ['assigner', 'lead'];
const CAN_ADD_HELPERS: TaskActorRole[] = ['assignee', 'co_assignee', 'assigner', 'lead'];
const HELPER_ROLES: TaskCollaboratorRole[] = ['watcher', 'co_assignee'];

const holdsAny = (held: TaskActorRole[], allowed: TaskActorRole[]): boolean =>
  held.some((r) => allowed.indexOf(r) >= 0);

/**
 * WHICH COLLABORATOR ROLES THIS ACTOR MAY HAND OUT — the question a screen has to answer before it
 * draws a dropdown, answered from the SAME constants addCollaborator() enforces with.
 *
 * Read allowedTransitionsFor() for the precedent: a control that exists only to be refused teaches
 * people the system is broken, so a page builds its options from what the engine will accept. The
 * alternative — a page listing the roles it believes an assignee may add — is a second copy of the
 * rights model, and the second copy is the one nobody remembers to update. There is no version of
 * this that can drift from the write, because there is nothing here to keep in step.
 *
 * An empty array means "draw no control": a reviewer, an approver and a watcher may add nobody.
 * This is presentation only. addCollaborator() re-derives the same authority inside the INSERT.
 */
export function collaboratorRolesAddableBy(held: TaskActorRole[] | null | undefined): TaskCollaboratorRole[] {
  const roles = Array.isArray(held) ? held : [];
  if (holdsAny(roles, CAN_ADD_ANY_ROLE)) return TASK_COLLABORATOR_ROLES.slice();
  if (holdsAny(roles, CAN_ADD_HELPERS)) return HELPER_ROLES.slice();
  return [];
}

/**
 * May this actor take OTHER people off the task? Anyone on it may always take themselves off, which
 * is why that case is not a parameter here — see removeCollaborator's `isSelf` branch.
 */
export function mayRemoveOtherCollaborators(held: TaskActorRole[] | null | undefined): boolean {
  return holdsAny(Array.isArray(held) ? held : [], CAN_ADD_ANY_ROLE);
}

export async function addCollaborator(
  taskId: string,
  actorUserId: string,
  targetUserId: string,
  role: TaskCollaboratorRole | string,
  opts: { ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const actor = String(actorUserId || '').trim();
  const target = String(targetUserId || '').trim();
  const wanted = String(role || '').trim().toLowerCase() as TaskCollaboratorRole;

  if (!actor || !target || !String(taskId || '').trim()) return { ok: false, error: NOT_AVAILABLE };
  if (TASK_COLLABORATOR_ROLES.indexOf(wanted) < 0) {
    return { ok: false, error: 'Pick one of: ' + TASK_COLLABORATOR_ROLES.join(', ') + '.' };
  }
  // Both go into ::uuid casts below. A malformed id must refuse in words, not throw on the render
  // path with "invalid input syntax for type uuid".
  if (!UUID_RE.test(actor) || !UUID_RE.test(target)) return { ok: false, error: NOT_AVAILABLE };

  try {
    await ensureTaskSchema();

    const snap = await readTaskAccess(taskId, actor);
    if (!snap) return { ok: false, error: NOT_AVAILABLE };

    const isHelperRole = HELPER_ROLES.indexOf(wanted) >= 0;
    const mayAdd = holdsAny(snap.roles, CAN_ADD_ANY_ROLE)
      || (isHelperRole && holdsAny(snap.roles, CAN_ADD_HELPERS));

    if (!mayAdd) {
      return {
        ok: false,
        error: isHelperRole
          ? 'Only the people working on this task, the person who assigned it or the department lead can add someone to it.'
          : 'Only the person who assigned this task or the department lead can name a reviewer or an approver. That is what stops work being signed off by whoever did it.',
      };
    }

    // The authority is re-derived by the database in the same statement that writes, against exactly
    // the roles the check above allowed. WHERE NOT EXISTS rather than ON CONFLICT: the unique index
    // is created in its own try/catch and correctness must not depend on it having succeeded.
    const authority = actorHasAnyRoleSql(actor, isHelperRole ? CAN_ADD_HELPERS : CAN_ADD_ANY_ROLE);

    const r = rows(await db.execute(sql`
      INSERT INTO employee_task_collaborators (task_id, user_id, role, added_by_user_id)
      SELECT t.id, ${target}::uuid, ${wanted}, ${actor}::uuid
        FROM employee_tasks t
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${authority}
         AND NOT EXISTS (SELECT 1 FROM employee_task_collaborators c
                          WHERE c.task_id = t.id AND c.user_id::text = ${target} AND c.role = ${wanted})
      RETURNING id`))[0];

    if (!r?.id) {
      // Zero rows is either "already on the task with that role" or "not allowed". They are
      // different facts and only one of them is a problem, so ask rather than guess.
      const already = rows(await db.execute(sql`
        SELECT 1 FROM employee_task_collaborators
         WHERE task_id::text = ${String(taskId).trim()} AND user_id::text = ${target} AND role = ${wanted}
         LIMIT 1`));
      if (already.length > 0) return { ok: true };
      return { ok: false, error: NOT_AVAILABLE };
    }

    await logAudit({
      userId: actor,
      action: 'task.collaborator.add',
      entity: 'employee_task',
      entityId: snap.id,
      diff: { taskTitle: snap.title, employeeId: snap.employeeId, userId: target, role: wanted, byRoles: snap.roles },
      ipAddress: opts.ipAddress || undefined,
    });

    return { ok: true };
  } catch (e: any) {
    logFail('addCollaborator', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Take somebody off a task.
 *
 * @param role omit to remove every role that person holds on the task. Passing one removes only that
 *             row, so a reviewer who is also a watcher can stop reviewing without losing sight of it.
 */
export async function removeCollaborator(
  taskId: string,
  actorUserId: string,
  targetUserId: string,
  role?: TaskCollaboratorRole | string | null,
  opts: { ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const actor = String(actorUserId || '').trim();
  const target = String(targetUserId || '').trim();

  if (!actor || !target || !String(taskId || '').trim()) return { ok: false, error: NOT_AVAILABLE };

  const wanted = String(role || '').trim().toLowerCase();
  if (wanted && TASK_COLLABORATOR_ROLES.indexOf(wanted as TaskCollaboratorRole) < 0) {
    return { ok: false, error: 'Pick one of: ' + TASK_COLLABORATOR_ROLES.join(', ') + '.' };
  }

  try {
    await ensureTaskSchema();

    const snap = await readTaskAccess(taskId, actor);
    if (!snap) return { ok: false, error: NOT_AVAILABLE };

    const isSelf = actor === target;
    if (!isSelf && !holdsAny(snap.roles, CAN_ADD_ANY_ROLE)) {
      return {
        ok: false,
        error: 'Only the person who assigned this task or the department lead can take someone off it. You can always take yourself off.',
      };
    }

    // Self-removal needs no role at all beyond being on the task, which readTaskAccess already
    // established; otherwise the assigner/lead check is re-derived by the database here.
    const authority = isSelf ? sql`true` : actorHasAnyRoleSql(actor, CAN_ADD_ANY_ROLE);
    const roleClause = wanted ? sql`AND col.role = ${wanted}` : sql``;

    const removed = rows(await db.execute(sql`
      DELETE FROM employee_task_collaborators AS col
       USING employee_tasks AS t
       WHERE t.id = col.task_id
         AND ${eq(sql`col.task_id`, taskId)}
         AND col.user_id::text = ${target}
         ${roleClause}
         AND ${authority}
      RETURNING col.id, col.role`));

    if (removed.length === 0) return { ok: true };   // nothing to remove; nothing happened, nothing to log

    await logAudit({
      userId: actor,
      action: 'task.collaborator.remove',
      entity: 'employee_task',
      entityId: snap.id,
      diff: {
        taskTitle: snap.title,
        employeeId: snap.employeeId,
        userId: target,
        roles: removed.map((x: any) => String(x.role)),
        selfRemoval: isSelf,
        byRoles: snap.roles,
      },
      ipAddress: opts.ipAddress || undefined,
    });

    return { ok: true };
  } catch (e: any) {
    logFail('removeCollaborator', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// =================================================================================================
// PROJECT TASKS — ADDITIVE. Nothing above this line changes behaviour because of anything below it.
// =================================================================================================
//
// A PROJECT TASK IS AN ORDINARY TASK WITH A LABEL ON IT. It is the same row in the same table, moved
// by the same moveTask() through the same TRANSITIONS graph, read through the same visibleToSql(),
// and commented on and staffed through the same collaborator model. The only thing project_id adds
// is the answer to "which project is this for". Everything a project surface does to a task — accept
// it, block it, review it, complete it — it does by calling the functions already above.
//
// WHAT IS DIFFERENT, AND IT IS EXACTLY ONE THING: WHO MAY PUT WORK ON SOMEBODY'S LIST.
//
// createTask() admits three assigners, re-derived from the target's own row: the person themselves,
// their recorded reporting manager, and a department head scoped to that department. A PROJECT
// MANAGER is none of those, and running a project without being able to hand out its work is not
// running it. So createProjectTask() adds a FOURTH arm — and the shape of that arm is the point:
//
//   IT IS A RELATIONSHIP, RESOLVED PER ROW, FROM THE ORGANIZATION GRAPH. `project_manager` is a
//   value of org_relationships.type, scoped to ONE project. It is never users.role, never a
//   capability, and never a boolean the caller passes — a caller-supplied "I am the PM" flag would
//   be the caller's claim about itself, which is precisely what the INSERT ... SELECT shape in this
//   file exists to refuse. The edge is checked BY THE DATABASE, IN THE SAME STATEMENT AS THE WRITE,
//   against the effective-dated row, so an edge closed a moment ago cannot be spent a moment later.
//
//   IT REACHES NO FURTHER THAN THE PROJECT. The clause requires scope_id = this project id, so
//   running project A confers nothing at all on project B and nothing outside projects. That is the
//   difference between a per-row relationship and a per-user grant, and it is the difference this
//   whole architecture exists to keep.
//
// The one SQL fragment below is the only place in this module that reads org_relationships, and it
// reads exactly the edge src/lib/org-graph.ts documents (isProjectManager / getManagedProjectIds
// answer the same question in TypeScript, for surfaces that need it before a write).

/**
 * "This user runs that project", as an in-force graph edge, for use inside a write.
 *
 * Effective dating is checked here the same way org-graph.ts checks it: status active,
 * effective_from at or before now, effective_to null or in the future. scope_id is TEXT and the
 * project id is compared as text — org_relationships.scope_id holds department slugs too, and a
 * ::uuid cast would throw the first time one arrives.
 */
const runsProjectSql = (viewerUserId: string, projectId: string): SQL => {
  const v = String(viewerUserId || '').trim();
  const p = String(projectId || '').trim();
  if (!v || !p) return sql`false`;
  return sql`EXISTS (
    SELECT 1
      FROM org_relationships r
      JOIN hr_employees pe ON pe.id = r.subject_employee_id
     WHERE r.type = 'project_manager'
       AND r.scope_type = 'project'
       AND r.scope_id = ${p}
       AND r.status = 'active'
       AND r.effective_from <= NOW()
       AND (r.effective_to IS NULL OR r.effective_to > NOW())
       AND pe.user_id::text = ${v})`;
};

/** A project task, as a board task plus the project it belongs to. */
export interface ProjectBoardTask extends BoardTask {
  projectId: string | null;
}

const mapProjectTask = (r: any): ProjectBoardTask => ({
  ...mapBoardTask(r),
  projectId: r.project_id ? String(r.project_id) : null,
});

/**
 * THE TASKS ON ONE PROJECT THAT THIS VIEWER MAY SEE.
 *
 * Scoped by visibleToSql() exactly as the board is: being on a project does NOT hand somebody every
 * task on it. They see the ones they are the assignee, the assigner, a collaborator or the
 * department lead of — the same four routes, unwidened. A project manager sees the rest because the
 * project surface asks with `includeAll` only after resolving that relationship from the graph, and
 * that decision is made by src/lib/projects.ts, never claimed here.
 *
 * @param includeAll pass ONLY after org-graph has confirmed the viewer runs this project, or after a
 *                   projects.view capability check. It widens the read to every task on the project.
 */
export async function listProjectTasks(
  viewerUserId: string,
  projectId: string,
  opts: { includeAll?: boolean; includeArchived?: boolean; limit?: number } = {},
): Promise<{ ok: boolean; reason: 'ok' | 'no-viewer' | 'lookup-failed'; tasks: ProjectBoardTask[] }> {
  const viewer = String(viewerUserId || '').trim();
  const project = String(projectId || '').trim();
  if (!viewer || !project) return { ok: false, reason: 'no-viewer', tasks: [] };

  try {
    await ensureTaskSchema();
    const scopeClause = opts.includeAll === true ? sql`true` : visibleToSql(viewer);
    const archivedClause = opts.includeArchived === true ? sql`` : sql`AND ${CANON} <> 'archived'`;
    const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000);

    const list = rows(await db.execute(sql`
      SELECT ${BOARD_TASK_COLUMNS}, t.project_id, ${VIEWER_ROLE_COLUMNS(viewer)}
        FROM employee_tasks t
       WHERE t.project_id::text = ${project}
         AND ${scopeClause}
         ${archivedClause}
       ORDER BY (${CANON} IN (${statusList(CLOSED_STATUSES)})),
                (t.due_on IS NULL), t.due_on ASC,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                t.created_at DESC
       LIMIT ${limit}`)).map(mapProjectTask);

    return { ok: true, reason: 'ok', tasks: list };
  } catch (e: any) {
    logFail('listProjectTasks', e);
    // ok:false, never an empty list presented as fact. "This project has no work on it" is a claim.
    return { ok: false, reason: 'lookup-failed', tasks: [] };
  }
}

/** Progress on one project's work, in the same buckets the rest of this module counts in. */
export interface ProjectTaskProgress {
  ok: boolean;
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  completed: number;
  overdue: number;
  /** Completed as a percentage of everything not cancelled or archived. Null when there is nothing. */
  percentComplete: number | null;
}

/**
 * Counts for a project's whole task set, WITHOUT a per-row visibility filter — deliberately.
 *
 * This is an aggregate: it returns seven integers and no titles, no names and no descriptions. A
 * member seeing "14 tasks, 9 done" for a project they are on discloses nothing about who is doing
 * what, and a progress bar built only from the tasks one person can see would report a different
 * completion figure to every member of the same project. Rows are never returned from here; the
 * function that lists tasks is listProjectTasks(), which IS filtered.
 */
export async function projectTaskProgress(projectId: string): Promise<ProjectTaskProgress> {
  const empty: ProjectTaskProgress = {
    ok: false, total: 0, open: 0, inProgress: 0, blocked: 0, completed: 0, overdue: 0, percentComplete: null,
  };
  const project = String(projectId || '').trim();
  if (!project) return empty;

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS total_count,
             COUNT(*) FILTER (WHERE ${CANON} IN ('draft', 'assigned', 'accepted'))::int           AS open_count,
             COUNT(*) FILTER (WHERE ${CANON} IN ('in_progress', 'under_review', 'approved'))::int AS in_progress_count,
             COUNT(*) FILTER (WHERE ${CANON} = 'blocked')::int                                    AS blocked_count,
             COUNT(*) FILTER (WHERE ${CANON} = 'completed')::int                                  AS done_count,
             COUNT(*) FILTER (WHERE ${IS_OVERDUE})::int                                           AS overdue_count,
             COUNT(*) FILTER (WHERE ${CANON} NOT IN ('cancelled', 'archived'))::int               AS counted
        FROM employee_tasks t
       WHERE t.project_id::text = ${project}`))[0];

    if (!r) return empty;
    const counted = Number(r.counted) || 0;
    const done = Number(r.done_count) || 0;
    return {
      ok: true,
      total: Number(r.total_count) || 0,
      open: Number(r.open_count) || 0,
      inProgress: Number(r.in_progress_count) || 0,
      blocked: Number(r.blocked_count) || 0,
      completed: done,
      overdue: Number(r.overdue_count) || 0,
      // Cancelled and archived work is excluded from BOTH sides. Counting a cancelled task as
      // outstanding would make a finished project look unfinished forever; counting it as done would
      // let a project be completed by cancelling everything on it.
      percentComplete: counted > 0 ? Math.round((done / counted) * 100) : null,
    };
  } catch (e: any) {
    logFail('projectTaskProgress', e);
    return empty;
  }
}

/**
 * PUT WORK ON SOMEBODY'S LIST, FOR A PROJECT.
 *
 * Identical to createTask() in every respect except the fourth assigner arm and the project_id it
 * writes. It is a separate function rather than an optional argument on createTask() so that the
 * widened arm can only ever be reached by a caller that named a project: there is no value of any
 * parameter to createTask() that turns the project-manager route on.
 *
 * The INSERT is still an INSERT ... SELECT. The right to assign is evaluated by the database, in the
 * same statement, against the target's own row and the graph's own edge. Nothing the caller says
 * about itself is believed, here or anywhere else in this file.
 */
export async function createProjectTask(input: {
  projectId: string;
  employeeId: string;
  assignedByUserId: string;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  dueOn?: string | null;
  scopeDepartmentId?: string | null;
  status?: 'draft' | 'assigned';
  ipAddress?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = (input.title || '').trim();
  const assigner = String(input.assignedByUserId || '').trim();
  const employeeId = String(input.employeeId || '').trim();
  const projectId = String(input.projectId || '').trim();

  if (title.length < 3) return { ok: false, error: 'Give the task a title.' };
  if (!employeeId || !assigner || !projectId) return { ok: false, error: NOT_AVAILABLE };
  if (!UUID_RE.test(assigner)) return { ok: false, error: NOT_AVAILABLE };
  if (!UUID_RE.test(projectId)) return { ok: false, error: NOT_AVAILABLE };

  const priority: TaskPriority = PRIORITIES.indexOf(input.priority as TaskPriority) >= 0
    ? (input.priority as TaskPriority) : 'normal';
  const status: TaskStatus = input.status === 'draft' ? 'draft' : 'assigned';

  const dueRaw = String(input.dueOn || '').trim();
  if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
    return { ok: false, error: 'Give the due date as YYYY-MM-DD, or leave it empty.' };
  }
  const dueOn = dueRaw || null;

  const scope = String(input.scopeDepartmentId || '').trim();
  const leadClause = scope ? sql`OR e.department_id::text = ${scope}` : sql``;

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO employee_tasks
        (employee_id, assigned_by_user_id, title, description, priority, status, due_on, project_id)
      SELECT e.id, ${assigner}::uuid, ${title.slice(0, 300)},
             ${(input.description || '').trim().slice(0, 4000) || null},
             ${priority}, ${status}, ${dueOn}::date, ${projectId}::uuid
        FROM hr_employees e
       WHERE e.id::text = ${employeeId}
         AND e.is_active = true
         AND (
           e.user_id::text = ${assigner}
           OR e.reporting_manager_id::text = ${assigner}
           ${leadClause}
           OR ${runsProjectSql(assigner, projectId)}
         )
      RETURNING id, employee_id`))[0];

    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId: assigner,
      action: 'task.assign',
      entity: 'employee_task',
      entityId: String(r.id),
      diff: { employeeId: r.employee_id, projectId, title: title.slice(0, 300), priority, dueOn, status },
      ipAddress: input.ipAddress || undefined,
    });

    await seedCollaborators(String(r.id), String(r.employee_id), assigner);

    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('createProjectTask', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Move an EXISTING task onto a project, or off one (pass null).
 *
 * The authority is the same as any other change to the shape of a task — the assigner or the
 * department lead (MANAGE) — or the project manager of the project it is being moved ONTO, checked
 * in the same statement, against the graph. Somebody who runs project A cannot pull a task off
 * project B, because the arm they qualify under only ever names the destination.
 */
export async function setTaskProject(
  taskId: string,
  actorUserId: string,
  projectId: string | null,
  opts: { ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const actor = String(actorUserId || '').trim();
  const id = String(taskId || '').trim();
  const project = projectId === null ? null : (String(projectId || '').trim() || null);

  if (!actor || !id) return { ok: false, error: NOT_AVAILABLE };
  if (project && !UUID_RE.test(project)) return { ok: false, error: NOT_AVAILABLE };

  try {
    await ensureTaskSchema();

    const snap = await readTaskAccess(id, actor);
    if (!snap) return { ok: false, error: NOT_AVAILABLE };

    const manageSql = actorHasAnyRoleSql(actor, MANAGE);
    const authority = project
      ? sql`(${manageSql} OR ${runsProjectSql(actor, project)})`
      : manageSql;

    const updated = rows(await db.execute(sql`
      UPDATE employee_tasks AS t
         SET project_id = ${project}::uuid,
             updated_at = NOW()
       WHERE ${eq(sql`t.id`, id)}
         AND ${authority}
      RETURNING t.id`));

    if (updated.length === 0) {
      return {
        ok: false,
        error: project
          ? 'Moving a task onto a project is for the person who assigned it, the department lead, or whoever runs that project.'
          : 'Taking a task off a project is for the person who assigned it or the department lead.',
      };
    }

    await logAudit({
      userId: actor,
      action: 'task.project.set',
      entity: 'employee_task',
      entityId: snap.id,
      diff: { taskTitle: snap.title, employeeId: snap.employeeId, projectId: project, byRoles: snap.roles },
      ipAddress: opts.ipAddress || undefined,
    });

    return { ok: true };
  } catch (e: any) {
    logFail('setTaskProject', e);
    return { ok: false, error: WRITE_FAILED };
  }
}
