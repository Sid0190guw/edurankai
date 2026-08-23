// src/lib/behaviour/sources.ts — PATCH 04: authorised organisational records in, observations out.
//
// THE ONLY FILE IN THIS PATCH THAT TOUCHES THE DATABASE, and the only one that knows which tables
// exist. Everything downstream works on BehaviouralObservation[] and could be handed rows from a
// fixture, which is how the interpretation layers are testable without a connection.
//
// =================================================================================================
// WHERE THE BEHAVIOUR ALREADY IS, AND WHY NO NEW TABLE IS CREATED
// =================================================================================================
//
// `employee_tasks` carries only the CURRENT status and `status_changed_at` — the last move, not the
// history. On its own it can say a task is complete; it cannot say it was accepted six days after it
// was assigned, bounced back twice, and finished a day early. That history already exists:
// src/lib/employee-tasks.ts writes an `audit_log` row for every transition, with `entity =
// 'employee_task'`, the task id in `entity_id`, and `{ employeeId, from, to, roles, reason }` in
// `diff`. This patch READS that trail. It creates no table, adds no column, and writes nothing to
// any table owned by another patch — an event log invented here would be a second, disagreeing
// account of the same transitions.
//
// THE READ IS BY TASK ID, NOT BY `diff`. `audit_log` is indexed on (entity, entity_id) and on
// created_at; `diff->>'employeeId'` is indexed on nothing, so filtering by it would sequentially
// scan the audit table of the whole organisation to answer a question about one person. Task ids
// come from `employee_tasks` first — one indexed lookup — and the audit read is then an indexed
// range over a known id list. On this codebase a `::text` cast on an indexed column has cost about
// 140 index scans already; the parameter is cast here, never the column.
//
// WHAT IS NOT READ, DELIBERATELY: no attendance, no clock events, no location, no device, no
// message content, no browsing, no screenshots, no keystrokes, no wellness data, no pay. There is no
// covert channel in this patch and no configuration flag that adds one.
import { sql } from 'drizzle-orm';
import type {
  BehaviouralObservation,
  BehaviourComplexity,
  BehaviourSignalKind,
  BehaviourSourceTable,
  EvidenceRef,
} from './types';
import { toMs } from './windows';

// Lazy, exactly as src/lib/audit.ts resolves it: a top-level import of src/lib/db throws
// "DATABASE_URL is not set" the moment anything imports this module, which would put the pure
// functions in the rest of this patch out of reach of a test that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

/** postgres-js resolves to a plain array, never a { rows } object. Declared before every use. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on e.cause; e.message is only the SQL that failed. Never a bare catch. */
const logFail = (tag: string, e: any) =>
  console.error('[behaviour/sources] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Ceiling on tasks pulled for one person in one read.
 *
 * A profile built from a person's two thousand most recent tasks and one built from all of them
 * differ by nothing a human would act on, and the unbounded version is a query that gets slower
 * every year until it times out on somebody's review day. When the cap bites it is REPORTED — see
 * `SourceReadReport.note` — because a silently truncated read that reports a confident number is the
 * failure mode this whole patch is written against.
 */
export const TASK_READ_CAP = 750;

/** Ceiling on audit rows. One task rarely exceeds a dozen transitions; this is a runaway guard. */
export const EVENT_READ_CAP = 8000;

/** Ceiling on assessment attempts. */
export const ATTEMPT_READ_CAP = 500;

/** Evidence statements are trimmed to this. A whole task description does not belong in a citation. */
const STATEMENT_CAP = 240;

export interface SourceReadReport {
  table: BehaviourSourceTable;
  rowsRead: number;
  /** False only when the query FAILED. A source that returned nothing is readable and empty. */
  readable: boolean;
  note?: string;
}

export interface EmploymentFacts {
  employeeId: string;
  /** users.id, when the employee record carries one. Null breaks self-driven attribution — see below. */
  userId: string | null;
  joiningDateMs: number | null;
  exitDateMs: number | null;
  found: boolean;
}

export interface ObservationRead {
  observations: BehaviouralObservation[];
  reports: SourceReadReport[];
  employment: EmploymentFacts;
  /** True when ANY source failed to read. Drives the confidence downgrade. */
  unreadable: boolean;
}

const cut = (s: unknown): string => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > STATEMENT_CAP ? v.slice(0, STATEMENT_CAP - 1) + '…' : v;
};

/** Only the four values employee_tasks.priority is written with. Anything else is not a complexity. */
function complexityOf(priority: unknown): BehaviourComplexity | null {
  const p = String(priority ?? '').trim().toLowerCase();
  return p === 'low' || p === 'normal' || p === 'high' || p === 'urgent' ? p : null;
}

/**
 * WHICH BEHAVIOURAL EVENT IS THIS AUDIT ROW.
 *
 * Order matters and is not alphabetical:
 *
 *   A RETURN IS READ FIRST. `under_review -> in_progress` is the rework signal, and reading it by
 *   its destination would file it as ordinary progress — which would make revision_frequency
 *   permanently zero and rework invisible, while the screen went on claiming to measure it.
 *
 *   AN UNBLOCK IS READ SECOND, for the same reason: the meaningful event when a task leaves
 *   `blocked` is that it left, not where it went.
 *
 * A row this cannot classify returns null and is DROPPED, not filed under a nearest neighbour. A
 * miscounted event is worse than a missing one: the missing one shows up in `n`.
 */
export function classify(action: string, from: string | null, to: string | null): BehaviourSignalKind | null {
  const a = String(action || '').trim();
  const f = String(from || '').trim().toLowerCase();
  const t = String(to || '').trim().toLowerCase();

  if (a === 'task.assign') return 'task.assigned';
  if (a === 'task.project.set') return 'task.project_linked';
  if (a === 'task.complete') return 'task.completed';
  if (a !== 'task.status') return null;

  if (f === 'under_review' && (t === 'in_progress' || t === 'assigned' || t === 'accepted')) {
    return 'task.returned';
  }
  if (f === 'blocked' && t && t !== 'blocked') return 'task.unblocked';

  switch (t) {
    case 'accepted': return 'task.accepted';
    case 'in_progress': return 'task.progress';
    case 'blocked': return 'task.blocked';
    case 'under_review': return 'task.submitted';
    case 'approved': return 'task.approved';
    case 'completed': return 'task.completed';
    case 'cancelled': return 'task.cancelled';
    default: return null;
  }
}

/** Employment bounds and the linked login. One indexed lookup; everything else depends on it. */
export async function readEmployment(employeeId: string): Promise<EmploymentFacts> {
  const empty: EmploymentFacts = {
    employeeId,
    userId: null,
    joiningDateMs: null,
    exitDateMs: null,
    found: false,
  };
  if (!UUID_RE.test(employeeId)) return empty;
  try {
    const r = rows(
      await (await database()).execute(sql`
        SELECT user_id, joining_date, exit_date, last_working_day
          FROM hr_employees
         WHERE id = ${employeeId}::uuid
         LIMIT 1`),
    );
    if (r.length === 0) return empty;
    const row = r[0];
    // last_working_day is the day they stopped working; exit_date can be a later administrative
    // date. The window must end when the WORK ended, so the earlier of the two wins.
    const lwd = toMs(row.last_working_day);
    const exit = toMs(row.exit_date);
    const end = lwd !== null && exit !== null ? Math.min(lwd, exit) : (lwd ?? exit);
    return {
      employeeId,
      userId: row.user_id ? String(row.user_id) : null,
      joiningDateMs: toMs(row.joining_date),
      exitDateMs: end,
      found: true,
    };
  } catch (e: any) {
    logFail('readEmployment', e);
    return empty;
  }
}

export interface ReadOptions {
  /** Half-open [fromIso, toIso). An empty fromIso reads from the beginning of the record. */
  fromIso: string;
  toIso: string;
}

/**
 * READ EVERY SOURCE and return typed observations.
 *
 * Each source sits in its OWN try/catch. A failure in one is reported as `readable: false` and
 * downgrades confidence; it does not empty the profile, because "we could not read the assessment
 * table" and "this person has taken no assessments" are different sentences and only one of them is
 * true. This is the precedent /admin/tests/attempts already set by printing EVIDENCE UNREADABLE
 * rather than a score it could not compute.
 */
export async function readObservations(
  employeeId: string,
  opts: ReadOptions,
): Promise<ObservationRead> {
  const employment = await readEmployment(employeeId);
  const observations: BehaviouralObservation[] = [];
  const reports: SourceReadReport[] = [];

  if (!UUID_RE.test(employeeId)) {
    return {
      observations,
      reports: (['employee_tasks', 'audit_log', 'edu_attempts'] as BehaviourSourceTable[]).map((table) => ({
        table,
        rowsRead: 0,
        readable: false,
        note: 'Not read: the employee reference was not a valid record id.',
      })),
      employment,
      unreadable: true,
    };
  }

  // ---- 1. the person's tasks, for due dates, priority and the id list ------------------------
  type TaskRow = { id: string; dueAt: string | null; complexity: BehaviourComplexity | null };
  const tasks = new Map<string, TaskRow>();
  let tasksReadable = true;
  let taskNote: string | undefined;

  try {
    // Bounded by the WINDOW, not by the task's own creation date: a task created last year and
    // completed this week is this week's behaviour. `updated_at` moves on every transition, so it is
    // the column that says "this task saw activity in the period".
    const r = rows(
      await (await database()).execute(sql`
        SELECT id, due_on, priority
          FROM employee_tasks
         WHERE employee_id = ${employeeId}::uuid
           AND updated_at < ${opts.toIso}::timestamptz
           ${opts.fromIso ? sql`AND updated_at >= ${opts.fromIso}::timestamptz` : sql``}
         ORDER BY updated_at DESC
         LIMIT ${TASK_READ_CAP + 1}`),
    );
    const capped = r.length > TASK_READ_CAP;
    for (const row of r.slice(0, TASK_READ_CAP)) {
      const id = String(row.id);
      tasks.set(id, {
        id,
        dueAt: row.due_on ? String(row.due_on).slice(0, 10) : null,
        complexity: complexityOf(row.priority),
      });
    }
    if (capped) {
      taskNote = `More than ${TASK_READ_CAP} tasks saw activity in this period; the ${TASK_READ_CAP} most recently updated were read. Figures below describe those.`;
    }
    reports.push({ table: 'employee_tasks', rowsRead: tasks.size, readable: true, note: taskNote });
  } catch (e: any) {
    logFail('readTasks', e);
    tasksReadable = false;
    reports.push({
      table: 'employee_tasks',
      rowsRead: 0,
      readable: false,
      note: 'The task table could not be read. Task-based figures below are missing an unknown amount of work.',
    });
  }

  // ---- 2. the transition trail ---------------------------------------------------------------
  let eventCount = 0;
  if (tasksReadable && tasks.size > 0) {
    try {
      const ids = sql.join([...tasks.keys()].map((id) => sql`${id}`), sql`, `);
      const r = rows(
        await (await database()).execute(sql`
          SELECT id, user_id, action, entity_id, diff, created_at
            FROM audit_log
           WHERE entity = 'employee_task'
             AND entity_id IN (${ids})
             AND created_at < ${opts.toIso}::timestamptz
             ${opts.fromIso ? sql`AND created_at >= ${opts.fromIso}::timestamptz` : sql``}
           ORDER BY created_at ASC
           LIMIT ${EVENT_READ_CAP}`),
      );
      eventCount = r.length;

      for (const row of r) {
        const diff = (row.diff && typeof row.diff === 'object' ? row.diff : {}) as Record<string, unknown>;
        const action = String(row.action || '');
        const from = diff.from === undefined || diff.from === null ? null : String(diff.from);
        const to = diff.to === undefined || diff.to === null ? null : String(diff.to);
        const kind = classify(action, from, to);
        if (!kind) continue;

        const taskId = String(row.entity_id || '');
        const task = tasks.get(taskId) || null;
        const actorUserId = row.user_id ? String(row.user_id) : null;
        const occurredAt = new Date(row.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z');

        const reason = cut(diff.reason);
        // The reason is quoted where one was written, and its ABSENCE is simply the absence of the
        // clause. metrics.ts reads that, so a block with no stated reason must not produce the word.
        const detail =
          kind === 'task.project_linked'
            ? `project set to ${cut(diff.projectId)}`
            : from || to
              ? `status ${from || 'unset'} to ${to || 'unset'}`
              : action;

        const evidence: EvidenceRef = {
          sourceTable: 'audit_log',
          sourceId: String(row.id),
          sourceField: action === 'task.status' ? 'diff.to' : 'action',
          occurredAt,
          statement: `${detail}${reason ? `; reason: ${reason}` : ''}`,
          collectedVia: 'authorised_system_record',
          workRef: { table: 'employee_tasks', id: taskId },
        };

        observations.push({
          kind,
          employeeId,
          occurredAt,
          actorUserId,
          // UNKNOWN STAYS UNKNOWN. Without a linked login there is no way to tell the person's own
          // action from somebody else's, and defaulting to false would read as "somebody had to push
          // them" — a claim about a human being assembled from a missing column.
          selfDriven:
            employment.userId === null || actorUserId === null ? null : actorUserId === employment.userId,
          workRef: { table: 'employee_tasks', id: taskId },
          complexity: task?.complexity ?? null,
          dueAt: task?.dueAt ?? null,
          from,
          to: kind === 'task.project_linked' ? cut(diff.projectId) || null : to,
          evidence,
        });
      }

      reports.push({
        table: 'audit_log',
        rowsRead: eventCount,
        readable: true,
        note:
          eventCount >= EVENT_READ_CAP
            ? `The transition read hit its ${EVENT_READ_CAP} row ceiling; the earliest events in this period are not included.`
            : undefined,
      });
    } catch (e: any) {
      logFail('readEvents', e);
      reports.push({
        table: 'audit_log',
        rowsRead: 0,
        readable: false,
        note: 'The transition trail could not be read. Nothing below describes how work moved.',
      });
    }
  } else {
    reports.push({
      table: 'audit_log',
      rowsRead: 0,
      readable: tasksReadable,
      note: tasksReadable
        ? 'No tasks in this period, so there were no transitions to read.'
        : 'Not attempted: the task list it depends on could not be read.',
    });
  }

  // ---- 3. assessment behaviour ---------------------------------------------------------------
  //
  // Attempts are keyed on users.id, so an employee with no linked login has no assessment history
  // here — which is a gap in the JOIN, not an absence of behaviour, and it is reported as one.
  if (employment.userId && UUID_RE.test(employment.userId)) {
    try {
      const r = rows(
        await (await database()).execute(sql`
          SELECT id, assessment_id, started_at, submitted_at
            FROM edu_attempts
           WHERE user_id = ${employment.userId}::uuid
             AND started_at < ${opts.toIso}::timestamptz
             ${opts.fromIso ? sql`AND started_at >= ${opts.fromIso}::timestamptz` : sql``}
           ORDER BY started_at ASC
           LIMIT ${ATTEMPT_READ_CAP}`),
      );

      for (const row of r) {
        const id = String(row.id);
        const startedAt = row.started_at ? new Date(row.started_at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
        if (startedAt) {
          observations.push({
            kind: 'assessment.started',
            employeeId,
            occurredAt: startedAt,
            actorUserId: employment.userId,
            selfDriven: true,
            workRef: { table: 'edu_attempts', id },
            complexity: null,
            dueAt: null,
            evidence: {
              sourceTable: 'edu_attempts',
              sourceId: id,
              sourceField: 'started_at',
              occurredAt: startedAt,
              statement: `attempt started on assessment ${cut(row.assessment_id)}`,
              collectedVia: 'authorised_system_record',
              workRef: { table: 'edu_attempts', id },
            },
          });
        }
        const submittedAt = row.submitted_at
          ? new Date(row.submitted_at).toISOString().replace(/\.\d{3}Z$/, 'Z')
          : null;
        if (submittedAt) {
          observations.push({
            kind: 'assessment.submitted',
            employeeId,
            occurredAt: submittedAt,
            actorUserId: employment.userId,
            selfDriven: true,
            workRef: { table: 'edu_attempts', id },
            complexity: null,
            dueAt: null,
            evidence: {
              sourceTable: 'edu_attempts',
              sourceId: id,
              sourceField: 'submitted_at',
              occurredAt: submittedAt,
              // No score, no pass flag, no mark. The columns exist on this row and are not selected:
              // this patch reads submission BEHAVIOUR, and a result belongs to the assessment record,
              // not to a behavioural profile.
              statement: `attempt submitted on assessment ${cut(row.assessment_id)}`,
              collectedVia: 'authorised_system_record',
              workRef: { table: 'edu_attempts', id },
            },
          });
        }
      }

      reports.push({
        table: 'edu_attempts',
        rowsRead: r.length,
        readable: true,
        note:
          r.length >= ATTEMPT_READ_CAP
            ? `The attempt read hit its ${ATTEMPT_READ_CAP} row ceiling.`
            : undefined,
      });
    } catch (e: any) {
      logFail('readAttempts', e);
      reports.push({
        table: 'edu_attempts',
        rowsRead: 0,
        readable: false,
        note: 'Assessment attempts could not be read.',
      });
    }
  } else {
    reports.push({
      table: 'edu_attempts',
      rowsRead: 0,
      readable: true,
      note: 'This employee record carries no linked login, so no assessment attempt can be matched to it. That is a gap in the record, not an absence of activity.',
    });
  }

  observations.sort((a, b) => (toMs(a.occurredAt) ?? 0) - (toMs(b.occurredAt) ?? 0));

  return {
    observations,
    reports,
    employment,
    unreadable: reports.some((r) => !r.readable),
  };
}
