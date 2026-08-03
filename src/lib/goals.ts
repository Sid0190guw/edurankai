// src/lib/goals.ts — GOALS AND OKRs. Objective, key results, owner, period, progress.
//
// =================================================================================================
// ONE TABLE, TWO SHAPES, AND WHY THERE IS NO SECOND GOALS TABLE
// =================================================================================================
//
// `hr_employee_goals` already existed (src/lib/hr-lifecycle.ts:64) as the KRA / 30-60-90 table. It
// is the same concept — a thing somebody is trying to achieve, with an owner, a target date and an
// outcome — so this module WRITES TO IT rather than adding a second goals table beside it. Two goals
// tables would mean two screens, two numbers, and no way to answer "what are this person's goals".
//
// What an OKR needed and a KRA row could not express is a PERIOD, a PROGRESS figure, a VISIBILITY
// choice and a list of measurable KEY RESULTS. The first three are columns added in
// performance-schema.ts; the fourth is a child table, because a row cannot hold a list.
//
// WHAT THIS MODULE DOES NOT DO, deliberately:
//   - it does not re-declare hr_employee_goals. hr-lifecycle.ts owns that definition.
//   - it does not re-implement closing a goal. hr-lifecycle.ts closeGoal() already does it and is
//     re-exported below so there is one closer, not two.
//   - hr-lifecycle.ts setGoal() stays the KRA writer, untouched. createObjective() below is the OKR
//     writer. Same table, different shape of row, and both are honest about which they are.
//
// =================================================================================================
// PROGRESS IS DERIVED, NOT TYPED, WHENEVER KEY RESULTS EXIST
// =================================================================================================
//
// An objective with key results takes its progress from them — the mean of each result's own
// distance from start to target, clamped to 0..100. An objective with none is a plain goal and its
// progress is whatever its owner set. Storing a number that contradicts the rows under it is how a
// dashboard ends up saying 80% over a list of untouched results, and everybody quietly stops
// believing the dashboard.
//
// =================================================================================================
// WHO SEES WHOSE — RELATIONSHIP FIRST
// =================================================================================================
//
// An employee sets their own. Their MANAGER sees them, and manager is a RELATIONSHIP resolved from
// the Organization Graph (performance-scope.ts, which defers to org-graph.ts isResponsibleFor and
// getDirectReports). Never a role name, never `users.assigned_department_id`, never "same
// department". A `visibility` of 'private' narrows even that: the employee alone.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import {
  canSeePerformanceOf,
  clean,
  isUuid,
  logFail,
  rowsOf,
  uuidList,
  visibleEmployeeIds,
  type PerfViewer,
} from '@/lib/performance-scope';
// ONE CLOSER, NOT TWO. Re-exported rather than reimplemented.
export { closeGoal } from '@/lib/hr-lifecycle';

const MOD = 'goals';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** Kinds of row this table carries. 'okr' is the one this module writes; the rest are hr-lifecycle's. */
export const GOAL_KINDS = ['okr', 'kra', '30_day', '60_day', '90_day', 'quarterly'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_STATUSES = ['open', 'met', 'partial', 'missed', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STATUS_LABELS: Record<string, string> = {
  open: 'In progress',
  met: 'Met',
  partial: 'Partly met',
  missed: 'Missed',
  dropped: 'Dropped',
};

/**
 * 'private' = the owner alone. 'manager' = the owner and whoever the graph says answers for their
 * work. There is deliberately no 'company' value — an org-wide goal feed would publish everybody's
 * targets by default, which is a product decision nobody has made.
 */
export const GOAL_VISIBILITY = ['private', 'manager'] as const;
export type GoalVisibility = (typeof GOAL_VISIBILITY)[number];

export const KR_STATUSES = ['open', 'done', 'dropped'] as const;

export interface KeyResult {
  id: string;
  goalId: string;
  title: string;
  unit: string | null;
  startValue: number;
  targetValue: number;
  currentValue: number;
  status: string;
  sortOrder: number;
  /** 0..100, derived from the three values. Never stored. */
  progressPct: number;
}

export interface Goal {
  id: string;
  employeeId: string;
  employeeName: string | null;
  kind: string;
  title: string;
  description: string | null;
  successMetric: string | null;
  periodLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  targetDate: string | null;
  weightPct: number | null;
  status: string;
  visibility: string;
  ownerUserId: string | null;
  setByUserId: string | null;
  outcomeNotes: string | null;
  lastProgressAt: string | null;
  /** 0..100. Derived from key results when there are any; the stored figure otherwise. */
  progressPct: number;
  /** True when progressPct came from the key results rather than from the stored column. */
  progressDerived: boolean;
  keyResults: KeyResult[];
  createdAt: string | null;
}

export interface GoalWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// -------------------------------------------------------------------------------------------------
// DERIVATION
// -------------------------------------------------------------------------------------------------

const clamp = (n: number) => (n < 0 ? 0 : n > 100 ? 100 : Math.round(n));

/**
 * One key result's progress: how far current has travelled from start towards target.
 *
 * A target EQUAL to start would divide by zero, so that case is answered by the status instead —
 * "done" is 100, anything else is 0. A DECREASING target (start 40, target 10, a defect count) works
 * without a special case because the denominator carries the sign.
 */
export function keyResultProgress(kr: { startValue: number; targetValue: number; currentValue: number; status?: string }): number {
  const span = Number(kr.targetValue) - Number(kr.startValue);
  if (!isFinite(span) || span === 0) return kr.status === 'done' ? 100 : 0;
  const travelled = Number(kr.currentValue) - Number(kr.startValue);
  return clamp((travelled / span) * 100);
}

/** The objective's progress, as the mean of its key results. */
export function objectiveProgress(krs: readonly KeyResult[]): number {
  const live = krs.filter((k) => k.status !== 'dropped');
  if (live.length === 0) return 0;
  return clamp(live.reduce((sum, k) => sum + k.progressPct, 0) / live.length);
}

// -------------------------------------------------------------------------------------------------
// MAPPERS
// -------------------------------------------------------------------------------------------------

function mapKeyResult(r: any): KeyResult {
  const kr: KeyResult = {
    id: String(r?.id ?? ''),
    goalId: String(r?.goal_id ?? ''),
    title: r?.title ? String(r.title) : '',
    unit: r?.unit ? String(r.unit) : null,
    startValue: Number(r?.start_value) || 0,
    targetValue: Number(r?.target_value) || 0,
    currentValue: Number(r?.current_value) || 0,
    status: String(r?.status ?? 'open'),
    sortOrder: Number(r?.sort_order) || 0,
    progressPct: 0,
  };
  kr.progressPct = keyResultProgress(kr);
  return kr;
}

function mapGoal(r: any, krs: KeyResult[]): Goal {
  const derived = krs.length > 0;
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    kind: String(r?.kind ?? 'okr'),
    title: r?.title ? String(r.title) : '',
    description: r?.description ? String(r.description) : null,
    successMetric: r?.success_metric ? String(r.success_metric) : null,
    periodLabel: r?.period_label ? String(r.period_label) : null,
    periodStart: isoDay(r?.period_start),
    periodEnd: isoDay(r?.period_end),
    targetDate: isoDay(r?.target_date),
    weightPct: r?.weight_pct === null || r?.weight_pct === undefined ? null : Number(r.weight_pct),
    status: String(r?.status ?? 'open'),
    visibility: String(r?.visibility ?? 'manager'),
    ownerUserId: r?.owner_user_id ? String(r.owner_user_id) : null,
    setByUserId: r?.set_by_user_id ? String(r.set_by_user_id) : null,
    outcomeNotes: r?.outcome_notes ? String(r.outcome_notes) : null,
    lastProgressAt: r?.last_progress_at ? new Date(r.last_progress_at).toISOString() : null,
    progressPct: derived ? objectiveProgress(krs) : clamp(Number(r?.progress_pct) || 0),
    progressDerived: derived,
    keyResults: krs,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/**
 * A DATE column comes back from postgres-js as a Date at UTC midnight. Read it in UTC — local
 * getters shift a target date by a day for anybody east or west of the server.
 */
function isoDay(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

/**
 * Every goal for one employee, newest period first, with key results attached.
 *
 * TWO QUERIES, NOT ONE PER GOAL. The key results come back in a single second query keyed on the
 * goal ids we already have — an N+1 here would be one round trip per objective on a phone.
 *
 * `includePrivate` is FALSE by default and the caller must decide: a manager reading their report's
 * goals passes false, the owner reading their own passes true. Defaulting to true would leak a
 * private goal to every manager the first time somebody forgot the argument.
 */
export async function listGoals(
  employeeId: string,
  opts: { includePrivate?: boolean; status?: string; limit?: number } = {},
): Promise<Goal[]> {
  if (!isUuid(employeeId)) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  try {
    await ensurePerformanceSchema();
    const privacy = opts.includePrivate === true ? sql`` : sql`AND COALESCE(g.visibility, 'manager') <> 'private'`;
    const statusFilter = opts.status ? sql`AND g.status = ${String(opts.status)}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT g.*, e.full_name AS employee_name
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE g.employee_id = ${employeeId}::uuid
         ${privacy}
         ${statusFilter}
       ORDER BY (g.status = 'open') DESC,
                COALESCE(g.period_end, g.target_date) DESC NULLS LAST,
                g.created_at DESC
       LIMIT ${limit}`));
    return attachKeyResults(rows);
  } catch (e: any) {
    logFail(MOD, 'listGoals', e);
    return [];
  }
}

/**
 * Goals across a set of employees — the manager and HR views.
 *
 * Private goals are ALWAYS excluded here. This function is only ever called for OTHER people's rows,
 * and 'private' means the owner alone; there is no argument that turns that off.
 */
export async function listGoalsForEmployees(
  employeeIds: readonly string[],
  opts: { status?: string; limit?: number } = {},
): Promise<Goal[]> {
  const ids = employeeIds.filter(isUuid);
  // An empty list must not compile to `IN ()`, which is a syntax error.
  if (ids.length === 0) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 120, 1), 400);
  try {
    await ensurePerformanceSchema();
    const statusFilter = opts.status ? sql`AND g.status = ${String(opts.status)}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT g.*, e.full_name AS employee_name
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE g.employee_id IN (${uuidList(ids)})
         AND COALESCE(g.visibility, 'manager') <> 'private'
         ${statusFilter}
       ORDER BY e.full_name ASC,
                (g.status = 'open') DESC,
                COALESCE(g.period_end, g.target_date) DESC NULLS LAST
       LIMIT ${limit}`));
    return attachKeyResults(rows);
  } catch (e: any) {
    logFail(MOD, 'listGoalsForEmployees', e);
    return [];
  }
}

/** Every goal in the organization. `performance.manage` only — the caller checks, this does not. */
export async function listAllGoals(opts: { status?: string; limit?: number } = {}): Promise<Goal[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    await ensurePerformanceSchema();
    const statusFilter = opts.status ? sql`AND g.status = ${String(opts.status)}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT g.*, e.full_name AS employee_name
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE COALESCE(g.visibility, 'manager') <> 'private'
         ${statusFilter}
       ORDER BY (g.status = 'open') DESC, g.created_at DESC
       LIMIT ${limit}`));
    return attachKeyResults(rows);
  } catch (e: any) {
    logFail(MOD, 'listAllGoals', e);
    return [];
  }
}

/** One goal with its key results, or null. Visibility is the CALLER's to check — see getGoalFor. */
export async function getGoal(goalId: string): Promise<Goal | null> {
  if (!isUuid(goalId)) return null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT g.*, e.full_name AS employee_name
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE g.id = ${goalId}::uuid LIMIT 1`));
    if (!rows.length) return null;
    const withKrs = await attachKeyResults(rows);
    return withKrs[0] || null;
  } catch (e: any) {
    logFail(MOD, 'getGoal', e);
    return null;
  }
}

/**
 * One goal, ONLY if this viewer may see it. Null is returned for "does not exist" and for "not
 * yours" alike, so probing a goal id cannot tell the two apart.
 */
export async function getGoalFor(viewer: PerfViewer, goalId: string): Promise<Goal | null> {
  const goal = await getGoal(goalId);
  if (!goal) return null;
  const own = viewer.employeeId && viewer.employeeId === goal.employeeId;
  if (!own && goal.visibility === 'private') return null;
  if (own) return goal;
  return (await canSeePerformanceOf(viewer, goal.employeeId)) ? goal : null;
}

/** The key-result fetch, done once for a whole page of goals. */
async function attachKeyResults(goalRows: any[]): Promise<Goal[]> {
  const ids = goalRows.map((r) => String(r?.id || '')).filter(isUuid);
  const byGoal = new Map<string, KeyResult[]>();
  if (ids.length > 0) {
    try {
      const krRows = rowsOf(await db.execute(sql`
        SELECT * FROM hr_goal_key_results
         WHERE goal_id IN (${uuidList(ids)})
         ORDER BY sort_order ASC, created_at ASC`));
      for (const row of krRows) {
        const kr = mapKeyResult(row);
        const list = byGoal.get(kr.goalId) || [];
        list.push(kr);
        byGoal.set(kr.goalId, list);
      }
    } catch (e: any) {
      // A failed key-result read must not swallow the objectives. The goals still render; their
      // progress falls back to the stored column, which mapGoal signals via progressDerived: false.
      logFail(MOD, 'attachKeyResults', e);
    }
  }
  return goalRows.map((r) => mapGoal(r, byGoal.get(String(r?.id || '')) || []));
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface CreateObjectiveInput {
  employeeId: string;
  /** users.id of whoever the objective belongs to. */
  ownerUserId?: string | null;
  /** users.id of whoever pressed the button. Equal to ownerUserId when somebody sets their own. */
  setByUserId?: string | null;
  title: string;
  description?: string | null;
  successMetric?: string | null;
  periodLabel?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  weightPct?: number | null;
  visibility?: GoalVisibility;
  kind?: GoalKind;
}

/**
 * Record an objective.
 *
 * NEVER SWALLOWS. A failed write returns `{ ok: false, error }` with the real reason, because a
 * silent catch in a write path hid a total sign-in outage on this project for hours.
 */
export async function createObjective(input: CreateObjectiveInput): Promise<GoalWriteResult> {
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That goal is not linked to an employee record.' };
  const title = clean(input?.title, 300);
  if (!title) return { ok: false, error: 'Give the objective a title.' };

  const kind = (GOAL_KINDS as readonly string[]).indexOf(String(input?.kind || 'okr')) >= 0
    ? String(input?.kind || 'okr')
    : 'okr';
  const visibility = (GOAL_VISIBILITY as readonly string[]).indexOf(String(input?.visibility || 'manager')) >= 0
    ? String(input?.visibility || 'manager')
    : 'manager';
  const description = clean(input?.description, 4000) || null;
  const metric = clean(input?.successMetric, 500) || null;
  const periodLabel = clean(input?.periodLabel, 40) || null;
  const periodStart = validDay(input?.periodStart);
  const periodEnd = validDay(input?.periodEnd);
  if (periodStart && periodEnd && periodEnd < periodStart) {
    return { ok: false, error: 'The period ends before it starts.' };
  }
  const weight = numberOrNull(input?.weightPct, 0, 100);
  const owner = isUuid(input?.ownerUserId) ? String(input.ownerUserId) : null;
  const setBy = isUuid(input?.setByUserId) ? String(input.setByUserId) : null;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_employee_goals
        (employee_id, kind, title, description, success_metric, target_date, weight_pct,
         status, set_by_user_id, owner_user_id, visibility, period_label, period_start, period_end,
         progress_pct)
      VALUES
        (${employeeId}::uuid, ${kind}, ${title}, ${description}::text, ${metric}::text,
         ${periodEnd}::date, ${weight}::int, 'open', ${setBy}::uuid, ${owner}::uuid,
         ${visibility}, ${periodLabel}::text, ${periodStart}::date, ${periodEnd}::date, 0)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    const id = String(rows[0].id);
    await logAudit({
      userId: setBy,
      action: 'goal.create',
      entity: 'hr_employee_goals',
      entityId: id,
      diff: { employeeId, kind, title, periodLabel, visibility },
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail(MOD, 'createObjective', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export interface KeyResultInput {
  goalId: string;
  title: string;
  unit?: string | null;
  startValue?: number | null;
  targetValue?: number | null;
  currentValue?: number | null;
  actorUserId?: string | null;
}

/** Add a measurable result under an objective. */
export async function addKeyResult(input: KeyResultInput): Promise<GoalWriteResult> {
  const goalId = String(input?.goalId || '');
  if (!isUuid(goalId)) return { ok: false, error: 'That key result is not attached to an objective.' };
  const title = clean(input?.title, 300);
  if (!title) return { ok: false, error: 'Give the key result a title.' };
  const start = Number(input?.startValue ?? 0);
  const target = Number(input?.targetValue ?? 100);
  const current = Number(input?.currentValue ?? start);
  if (!isFinite(start) || !isFinite(target) || !isFinite(current)) {
    return { ok: false, error: 'Start, target and current must be numbers.' };
  }
  const unit = clean(input?.unit, 24) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;

  try {
    await ensurePerformanceSchema();
    const ordering = rowsOf(await db.execute(sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM hr_goal_key_results WHERE goal_id = ${goalId}::uuid`));
    const next = Number(ordering[0]?.next) || 0;
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_goal_key_results
        (goal_id, title, unit, start_value, target_value, current_value, status, sort_order)
      VALUES
        (${goalId}::uuid, ${title}, ${unit}::text, ${start}::numeric, ${target}::numeric,
         ${current}::numeric, 'open', ${next}::int)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await touchGoal(goalId);
    await logAudit({
      userId: actor,
      action: 'goal.keyresult.add',
      entity: 'hr_goal_key_results',
      entityId: String(rows[0].id),
      diff: { goalId, title, start, target },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'addKeyResult', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Move a key result's current value, and optionally close it.
 *
 * The objective's own progress is NOT written here, because it is derived on read whenever key
 * results exist. Writing a number that the rows under it could contradict is the thing this design
 * avoids; `last_progress_at` is touched so a screen can say when somebody last moved anything.
 */
export async function updateKeyResult(
  keyResultId: string,
  input: { currentValue?: number | null; status?: string | null; actorUserId?: string | null },
): Promise<GoalWriteResult> {
  if (!isUuid(keyResultId)) return { ok: false, error: 'That key result does not exist.' };
  const hasValue = input?.currentValue !== null && input?.currentValue !== undefined && isFinite(Number(input.currentValue));
  const status = input?.status && (KR_STATUSES as readonly string[]).indexOf(String(input.status)) >= 0
    ? String(input.status)
    : null;
  if (!hasValue && !status) return { ok: false, error: 'There is nothing to change.' };
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_goal_key_results
         SET current_value = COALESCE(${hasValue ? Number(input.currentValue) : null}::numeric, current_value),
             status = COALESCE(${status}::text, status),
             updated_at = NOW()
       WHERE id = ${keyResultId}::uuid
      RETURNING id, goal_id`));
    if (!rows.length) return { ok: false, error: 'That key result does not exist.' };
    const goalId = String(rows[0].goal_id);
    await touchGoal(goalId);
    await logAudit({
      userId: actor,
      action: 'goal.keyresult.update',
      entity: 'hr_goal_key_results',
      entityId: keyResultId,
      diff: { goalId, currentValue: hasValue ? Number(input.currentValue) : null, status },
    });
    return { ok: true, id: keyResultId };
  } catch (e: any) {
    logFail(MOD, 'updateKeyResult', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Set the progress of an objective that has NO key results.
 *
 * Refuses when key results exist, and says so. Silently accepting the number and then showing the
 * derived one instead would look exactly like a save that did not work.
 */
export async function setGoalProgress(
  goalId: string,
  pct: number,
  actorUserId?: string | null,
): Promise<GoalWriteResult> {
  if (!isUuid(goalId)) return { ok: false, error: 'That goal does not exist.' };
  const value = Number(pct);
  if (!isFinite(value) || value < 0 || value > 100) {
    return { ok: false, error: 'Progress is a number between 0 and 100.' };
  }
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensurePerformanceSchema();
    const krs = rowsOf(await db.execute(sql`
      SELECT 1 AS ok FROM hr_goal_key_results WHERE goal_id = ${goalId}::uuid LIMIT 1`));
    if (krs.length > 0) {
      return {
        ok: false,
        error: 'This objective takes its progress from its key results. Update a key result instead.',
      };
    }
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_employee_goals
         SET progress_pct = ${Math.round(value)}::int,
             last_progress_at = NOW(),
             updated_at = NOW()
       WHERE id = ${goalId}::uuid
      RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That goal does not exist.' };
    await logAudit({
      userId: actor,
      action: 'goal.progress',
      entity: 'hr_employee_goals',
      entityId: goalId,
      diff: { progressPct: Math.round(value) },
    });
    return { ok: true, id: goalId };
  } catch (e: any) {
    logFail(MOD, 'setGoalProgress', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Remove a key result. The objective's derived progress recomputes on the next read. */
export async function removeKeyResult(
  keyResultId: string,
  actorUserId?: string | null,
): Promise<GoalWriteResult> {
  if (!isUuid(keyResultId)) return { ok: false, error: 'That key result does not exist.' };
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM hr_goal_key_results WHERE id = ${keyResultId}::uuid RETURNING goal_id`));
    if (!rows.length) return { ok: false, error: 'That key result does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'goal.keyresult.remove',
      entity: 'hr_goal_key_results',
      entityId: keyResultId,
      diff: { goalId: String(rows[0].goal_id) },
    });
    return { ok: true, id: keyResultId };
  } catch (e: any) {
    logFail(MOD, 'removeKeyResult', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Bump last_progress_at without touching the derived figure. Failure here is not fatal to a write. */
async function touchGoal(goalId: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE hr_employee_goals SET last_progress_at = NOW(), updated_at = NOW()
       WHERE id = ${goalId}::uuid`);
  } catch (e: any) {
    logFail(MOD, 'touchGoal', e);
  }
}

// -------------------------------------------------------------------------------------------------
// SMALL HELPERS
// -------------------------------------------------------------------------------------------------

function validDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

function numberOrNull(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(Math.min(Math.max(n, min), max));
}

/**
 * The goals a viewer may see, in one call — their own (including private ones) plus everyone the
 * Organization Graph puts in reach. This is the reader a screen should use; the three list functions
 * above are the primitives it is built from.
 */
export async function goalsInScope(viewer: PerfViewer): Promise<{ mine: Goal[]; team: Goal[] }> {
  const mine = viewer.employeeId ? await listGoals(viewer.employeeId, { includePrivate: true }) : [];
  const ids = visibleEmployeeIds(viewer);
  let team: Goal[] = [];
  if (ids === null) {
    team = (await listAllGoals()).filter((g) => g.employeeId !== viewer.employeeId);
  } else {
    const others = ids.filter((id) => id !== viewer.employeeId);
    team = others.length ? await listGoalsForEmployees(others) : [];
  }
  return { mine, team };
}
