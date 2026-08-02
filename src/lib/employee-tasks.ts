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
import { db } from '@/lib/db';
import { sql, type SQL } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { employeeFilter, departmentFilter } from '@/lib/auth/workspace-access';
import { logAudit } from '@/lib/audit';

// postgres-js resolves to a plain array, never a { rows } object. Declared before everything that
// uses it: `const` is not hoisted, and a handler reaching a later declaration has taken pages down
// in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the SQL that failed. Never a bare
// catch {} — that is what hid both of today's outages for hours.
const logFail = (tag: string, e: any) => console.error('[employee-tasks] ' + tag, e?.cause?.message || e?.message);

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

const STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked', 'done'];
const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

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

/** Declared before the readers that return it. `const` is not hoisted. */
const EMPTY_COUNTS: TaskCounts = { open: 0, inProgress: 0, blocked: 0, done: 0, overdue: 0, total: 0 };

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
  status: TaskStatus;
  dueOn: string | null;
  isOverdue: boolean;
  blockedReason: string | null;
  commentCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorUserId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface TaskCounts {
  open: number;
  inProgress: number;
  blocked: number;
  done: number;
  overdue: number;
  total: number;
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
  return ensureOnce('employee_tasks_v1', async () => {
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
}

// ---------------------------------------------------------------------------------------------
// Shared fragments.
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

/**
 * The actor is the assignee or the assigner, re-derived from the row rather than taken on trust.
 *
 * The assignee side is an IN over hr_employees rather than a single id because one person can hold
 * more than one hr_employees row — a closed internship plus a current contract. A task sitting on
 * the older row is still theirs to update.
 */
const actorOwnsTask = (actorUserId: string | null | undefined): SQL => {
  const actor = String(actorUserId || '').trim();
  if (!actor) return sql`false`;
  return sql`(
    t.assigned_by_user_id::text = ${actor}
    OR t.employee_id IN (SELECT e.id FROM hr_employees e WHERE e.user_id::text = ${actor})
  )`;
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

const TASK_COLUMNS = sql`
  t.id, t.employee_id, t.assigned_by_user_id, t.title, t.description, t.priority, t.status,
  t.due_on, t.created_at, t.completed_at, t.blocked_reason,
  (t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE AND t.status <> 'done') AS is_overdue,
  ${nameOfUser(sql`t.assigned_by_user_id`)} AS assigned_by_name,
  (SELECT COUNT(*)::int FROM employee_task_comments c WHERE c.task_id = t.id) AS comment_count
`;

const mapTask = (r: any): EmployeeTask => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name ?? null,
  assignedByUserId: r.assigned_by_user_id ?? null,
  assignedByName: r.assigned_by_name ?? null,
  selfAssigned: !!r.self_assigned,
  title: r.title,
  description: r.description ?? null,
  priority: (PRIORITIES.includes(r.priority) ? r.priority : 'normal') as TaskPriority,
  status: (STATUSES.includes(r.status) ? r.status : 'open') as TaskStatus,
  dueOn: r.due_on ? String(r.due_on).slice(0, 10) : null,
  isOverdue: !!r.is_overdue,
  blockedReason: r.blocked_reason ?? null,
  commentCount: Number(r.comment_count) || 0,
  createdAt: String(r.created_at),
  completedAt: r.completed_at ? String(r.completed_at) : null,
});

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
     ORDER BY (t.status = 'done'),
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
export interface MyTasksView {
  ok: boolean;
  tasks: EmployeeTask[];
  counts: TaskCounts;
}

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
       ORDER BY (t.status = 'done'),
                (t.due_on IS NULL), t.due_on ASC,
                e.full_name ASC,
                t.created_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 500)}`)).map(mapTask);
  } catch (e: any) {
    logFail('listTasksForTeam', e);
    return [];
  }
}

async function readTaskCounts(employeeId: string): Promise<TaskCounts> {
  const r = rows(await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE t.status = 'open')::int        AS open_count,
           COUNT(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress_count,
           COUNT(*) FILTER (WHERE t.status = 'blocked')::int     AS blocked_count,
           COUNT(*) FILTER (WHERE t.status = 'done')::int        AS done_count,
           COUNT(*) FILTER (WHERE t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE AND t.status <> 'done')::int AS overdue_count,
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

/** Comments on one task, for the assignee or the assigner only. Anyone else gets an empty list. */
export async function listComments(taskId: string, viewerUserId: string): Promise<TaskComment[]> {
  try {
    await ensureTaskSchema();
    return rows(await db.execute(sql`
      SELECT c.id, c.task_id, c.author_user_id, c.body, c.created_at,
             ${nameOfUser(sql`c.author_user_id`)} AS author_name
        FROM employee_task_comments c
        JOIN employee_tasks t ON t.id = c.task_id
       WHERE ${eq(sql`c.task_id`, taskId)} AND ${actorOwnsTask(viewerUserId)}
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
  ipAddress?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = (input.title || '').trim();
  const assigner = String(input.assignedByUserId || '').trim();
  const employeeId = String(input.employeeId || '').trim();

  if (title.length < 3) return { ok: false, error: 'Give the task a title.' };
  if (!employeeId || !assigner) return { ok: false, error: NOT_AVAILABLE };

  const priority: TaskPriority = PRIORITIES.includes(input.priority as TaskPriority)
    ? (input.priority as TaskPriority) : 'normal';

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
      INSERT INTO employee_tasks (employee_id, assigned_by_user_id, title, description, priority, due_on)
      SELECT e.id, ${assigner}::uuid, ${title.slice(0, 300)},
             ${(input.description || '').trim().slice(0, 4000) || null},
             ${priority}, ${dueOn}::date
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
      diff: { employeeId: r.employee_id, title: title.slice(0, 300), priority, dueOn },
      ipAddress: input.ipAddress || undefined,
    });

    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('createTask', e);
    // logFail above already recorded e.cause.message. See WRITE_FAILED for why it is not echoed back.
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Move a task's status.
 *
 * The authorisation is the UPDATE's own WHERE clause. Checking first and updating afterwards would
 * leave a window between the two, and — more to the point — it would put the rule in a place a
 * future edit can step around. Here, a statement that is not entitled updates zero rows and returns
 * nothing, and there is no version of this function that writes without the check.
 *
 * `blocked` requires a reason, for the same purpose a legal matter does: "blocked" with no stated
 * cause is a task nobody can unblock. Reaching `done` stamps completed_at; leaving `done` clears it,
 * so a reopened task does not keep claiming a completion date that no longer happened.
 */
export async function updateTaskStatus(
  taskId: string,
  actorUserId: string,
  status: TaskStatus,
  opts: { blockedReason?: string | null; ipAddress?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!STATUSES.includes(status)) return { ok: false, error: 'That is not a valid status.' };

  const reason = (opts.blockedReason || '').trim();
  if (status === 'blocked' && reason.length < 5) {
    return { ok: false, error: 'Say what is blocking it, so someone can unblock it.' };
  }

  const completedAt = status === 'done' ? sql`NOW()` : sql`NULL`;
  const blockedReason = status === 'blocked' ? sql`${reason.slice(0, 2000)}` : sql`NULL`;

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      UPDATE employee_tasks AS t
         SET status = ${status},
             blocked_reason = ${blockedReason},
             completed_at = ${completedAt},
             updated_at = NOW()
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${actorOwnsTask(actorUserId)}
      RETURNING t.id, t.employee_id, t.title`))[0];

    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };

    await logAudit({
      userId: String(actorUserId || '') || null,
      action: status === 'done' ? 'task.complete' : 'task.status',
      entity: 'employee_task',
      entityId: String(r.id),
      diff: { employeeId: r.employee_id, title: r.title, status, blockedReason: status === 'blocked' ? reason.slice(0, 2000) : null },
      ipAddress: opts.ipAddress || undefined,
    });

    return { ok: true };
  } catch (e: any) {
    logFail('updateTaskStatus', e);
    // logFail above already recorded e.cause.message. See WRITE_FAILED for why it is not echoed back.
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Comment on a task. Same two people as updateTaskStatus, enforced the same way: INSERT ... SELECT,
 * so the entitlement is part of the write rather than a check in front of it.
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

  try {
    await ensureTaskSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO employee_task_comments (task_id, author_user_id, body)
      SELECT t.id, ${author}::uuid, ${text.slice(0, 4000)}
        FROM employee_tasks t
       WHERE ${eq(sql`t.id`, taskId)}
         AND ${actorOwnsTask(author)}
      RETURNING id`))[0];

    if (!r?.id) return { ok: false, error: NOT_AVAILABLE };
    return { ok: true, id: String(r.id) };
  } catch (e: any) {
    logFail('addComment', e);
    // logFail above already recorded e.cause.message. See WRITE_FAILED for why it is not echoed back.
    return { ok: false, error: WRITE_FAILED };
  }
}
