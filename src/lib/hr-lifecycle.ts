// HR Employee Lifecycle — probation, KRA goals, PIP. Implements the gaps
// flagged in the v1.0 HR Employee Lifecycle Manual (June 2026) that cause
// the "can't remove an underperformer" problem when missing:
//   1. Written probation period with explicit confirmation requirement
//   2. KRAs / 30-60-90 plan acknowledged at onboarding
//   3. Documented Performance Improvement Plan with weekly check-ins
//
// All tables are self-bootstrapping; no separate migration required.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  getManager,
  supersedeReportingManager,
  isInitialized as orgGraphInitialized,
} from '@/lib/org-graph';
import { startWorkflow, getInstance, type WorkflowInstanceView } from '@/lib/workflow';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/**
 * THE PROBATION / KRA / PIP TABLES. Inside an ensureOnce guard, and NOT a hand-rolled module-level
 * promise.
 *
 * WHAT THE HAND-ROLLED VERSION DID WRONG, twice over:
 *   1. `let ready` was assigned once and NEVER CLEARED. A single transient failure — a pooler
 *      hiccup, a lock timeout — resolved the promise anyway and cached that resolution for the
 *      lifetime of the process. Every later call returned the poisoned promise without retrying, so
 *      one bad second at cold start disabled probation, KRAs and PIP until the process was recycled.
 *   2. The failure was `catch (_) {}`. Nothing was logged, so the screens that then found no table
 *      reported an empty list and nobody could tell an empty database from a broken one.
 *
 * ensureOnce() (src/lib/ensure-once.ts) memoises the in-flight promise AND drops the cache entry when
 * the callback rejects, which is why the catch below RE-THROWS after logging. It then swallows the
 * rejection for the CALLER, so the existing "tolerate missing schema" behaviour of every caller is
 * unchanged and the signature stays Promise<void> — src/lib/performance-schema.ts awaits this.
 *
 * Same guard, same shape, as ensureMoveSchema() further down this file.
 */
export function ensureLifecycleSchema(): Promise<void> {
  return ensureOnce('hr_lifecycle_core_v1', async () => {
    try {
      // -------- Probation tracking --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_probation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        scheduled_end_date DATE NOT NULL,
        duration_months INT NOT NULL DEFAULT 6,
        notice_days_during_probation INT NOT NULL DEFAULT 30,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
          -- active | confirmed | extended | terminated | resigned
        confirmation_letter_issued_at TIMESTAMPTZ,
        confirmation_letter_url TEXT,
        confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        extension_count INT NOT NULL DEFAULT 0,
        extended_to_date DATE,
        extension_reason TEXT,
        termination_reason TEXT,
        terminated_at TIMESTAMPTZ,
        clauses_acknowledged BOOLEAN NOT NULL DEFAULT false,
        clauses_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_probation_emp_idx ON hr_probation(employee_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_probation_status_idx ON hr_probation(status, scheduled_end_date)`);

      // -------- Probation reviews (30 / 60 / 90 day) --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_probation_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        probation_id UUID NOT NULL REFERENCES hr_probation(id) ON DELETE CASCADE,
        review_day INT NOT NULL,
          -- 30 | 60 | 90 (or custom milestone day)
        scheduled_at DATE NOT NULL,
        conducted_at TIMESTAMPTZ,
        rating VARCHAR(20),
          -- on_track | needs_improvement | at_risk | exceeds
        summary TEXT,
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_prob_reviews_idx ON hr_probation_reviews(probation_id, review_day)`);

      // -------- KRA / 30-60-90 plan --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_employee_goals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL DEFAULT 'kra',
          -- kra | 30_day | 60_day | 90_day | quarterly
        title VARCHAR(300) NOT NULL,
        description TEXT,
        success_metric TEXT,
        target_date DATE,
        weight_pct INT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
          -- open | met | partial | missed | dropped
        outcome_notes TEXT,
        set_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_goals_emp_idx ON hr_employee_goals(employee_id, kind, status)`);

      // -------- Performance Improvement Plan (PIP) --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_pips (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        opened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        opened_at DATE NOT NULL DEFAULT CURRENT_DATE,
        scheduled_end_date DATE NOT NULL,
        duration_weeks INT NOT NULL DEFAULT 2,
          -- Manual recommends 2 weeks with weekly check-ins
        reason TEXT NOT NULL,
          -- specific underperformance documented in writing
        expectations TEXT NOT NULL,
          -- specific measurable improvements required
        consequences TEXT,
          -- what happens if not met
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        outcome VARCHAR(20),
          -- met | not_met | extended | early_resolution
        outcome_notes TEXT,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_pip_emp_idx ON hr_pips(employee_id, opened_at DESC)`);

      // -------- PIP weekly check-ins --------
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_pip_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pip_id UUID NOT NULL REFERENCES hr_pips(id) ON DELETE CASCADE,
        week_number INT NOT NULL,
        check_date DATE NOT NULL,
        progress_summary TEXT NOT NULL,
        progress_rating VARCHAR(20),
          -- on_track | partial | not_met
        manager_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        employee_acknowledged BOOLEAN NOT NULL DEFAULT false,
        employee_acknowledged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_pip_chk_idx ON hr_pip_checkins(pip_id, week_number)`);
    } catch (e: any) {
      // NAMED, NEVER SILENT. The real Postgres reason is on e.cause; e.message is only the failed
      // SQL. Written with console.error rather than logMoveFail() because that helper is a `const`
      // declared further down this file and `const` is not hoisted.
      console.error('[hr-lifecycle] ensureLifecycleSchema:', String(e?.cause?.message || e?.message || 'unknown error'));
      throw e; // ensureOnce drops the failed run, so the next call retries instead of staying broken.
    }
  });
}

// ============================== PROBATION ==============================

export async function openProbation(opts: {
  employeeId: string;
  startDate: string;
  durationMonths?: number;
  noticeDaysDuringProbation?: number;
}) {
  await ensureLifecycleSchema();
  const months = Math.max(1, Math.min(12, opts.durationMonths || 6));
  const start = new Date(opts.startDate);
  const scheduledEnd = new Date(start.getTime());
  scheduledEnd.setMonth(scheduledEnd.getMonth() + months);
  const endStr = scheduledEnd.toISOString().slice(0, 10);
  const r = rows(await db.execute(sql`
    INSERT INTO hr_probation (employee_id, start_date, scheduled_end_date, duration_months, notice_days_during_probation)
    VALUES (${opts.employeeId}, ${opts.startDate}, ${endStr}, ${months}, ${opts.noticeDaysDuringProbation || 30})
    RETURNING id, scheduled_end_date
  `));
  const probationId = r[0]?.id;

  // Auto-schedule 30 / 60 / 90 day reviews (capped at probation end).
  for (const day of [30, 60, 90]) {
    const reviewDate = new Date(start.getTime());
    reviewDate.setDate(reviewDate.getDate() + day);
    if (reviewDate > scheduledEnd) continue;
    await db.execute(sql`
      INSERT INTO hr_probation_reviews (probation_id, review_day, scheduled_at)
      VALUES (${probationId}, ${day}, ${reviewDate.toISOString().slice(0, 10)})
    `);
  }
  return { ok: true, probationId, scheduledEnd: endStr };
}

export async function getActiveProbation(employeeId: string) {
  await ensureLifecycleSchema();
  const r = rows(await db.execute(sql`
    SELECT * FROM hr_probation WHERE employee_id = ${employeeId} AND status IN ('active', 'extended')
    ORDER BY created_at DESC LIMIT 1
  `));
  return r[0] || null;
}

export async function listProbationReviews(probationId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`
    SELECT * FROM hr_probation_reviews WHERE probation_id = ${probationId}
    ORDER BY review_day ASC
  `));
}

export async function recordReview(opts: {
  reviewId: string;
  rating: 'on_track' | 'needs_improvement' | 'at_risk' | 'exceeds';
  summary: string;
  managerUserId?: string;
}) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation_reviews
    SET conducted_at = NOW(), rating = ${opts.rating}, summary = ${opts.summary}, manager_user_id = ${opts.managerUserId || null}
    WHERE id = ${opts.reviewId}
  `);
}

export async function confirmEmployee(opts: { probationId: string; confirmedByUserId: string; letterUrl?: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation SET status = 'confirmed', confirmation_letter_issued_at = NOW(),
      confirmation_letter_url = ${opts.letterUrl || null}, confirmed_by_user_id = ${opts.confirmedByUserId},
      updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
  // THE EMPLOYEE RECORD, AND IT IS NOT OPTIONAL. This used to be wrapped in `catch (_) {}`, which
  // meant confirmation could succeed on hr_probation and fail on hr_employees while the screen said
  // "Employee confirmed. Written confirmation recorded." Two records disagreeing about whether
  // somebody is confirmed, with nothing written down anywhere, is the same fault class as the hire
  // that failed silently for eleven days on this project.
  //
  // The exception now PROPAGATES. Every caller of this function reaches it from a POST handler with
  // a try/catch that renders `e.cause?.message` on screen (/admin/hr/employees/[id] does exactly
  // that), so the person who pressed the button is told the confirmation is half-written instead of
  // being congratulated on a write that did not happen.
  await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS confirmation_date DATE`);
  await db.execute(sql`UPDATE hr_employees SET confirmation_date = CURRENT_DATE WHERE id IN (SELECT employee_id FROM hr_probation WHERE id = ${opts.probationId})`);
}

export async function extendProbation(opts: { probationId: string; months: number; reason: string }) {
  await ensureLifecycleSchema();
  const months = Math.max(1, Math.min(6, opts.months));
  const cur = rows(await db.execute(sql`SELECT scheduled_end_date, extension_count FROM hr_probation WHERE id = ${opts.probationId}`))[0] as any;
  if (!cur) return { ok: false, error: 'not found' };
  const newEnd = new Date(cur.scheduled_end_date);
  newEnd.setMonth(newEnd.getMonth() + months);
  await db.execute(sql`
    UPDATE hr_probation
    SET status = 'extended', extended_to_date = ${newEnd.toISOString().slice(0, 10)},
      extension_count = extension_count + 1, extension_reason = ${opts.reason}, updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
  return { ok: true, newEnd: newEnd.toISOString().slice(0, 10) };
}

export async function terminateOnProbation(opts: { probationId: string; reason: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_probation SET status = 'terminated', termination_reason = ${opts.reason},
      terminated_at = NOW(), updated_at = NOW()
    WHERE id = ${opts.probationId}
  `);
}

// ============================== KRA / GOALS ==============================

export async function setGoal(opts: {
  employeeId: string;
  kind: 'kra' | '30_day' | '60_day' | '90_day' | 'quarterly';
  title: string;
  description?: string;
  successMetric?: string;
  targetDate?: string;
  weightPct?: number;
  setByUserId?: string;
}) {
  await ensureLifecycleSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hr_employee_goals (employee_id, kind, title, description, success_metric, target_date, weight_pct, set_by_user_id)
    VALUES (${opts.employeeId}, ${opts.kind}, ${opts.title}, ${opts.description || null}, ${opts.successMetric || null},
      ${opts.targetDate || null}, ${opts.weightPct || null}, ${opts.setByUserId || null})
    RETURNING id
  `));
  return { ok: true, goalId: r[0]?.id };
}

export async function listGoals(employeeId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`
    SELECT * FROM hr_employee_goals WHERE employee_id = ${employeeId}
    ORDER BY CASE kind WHEN 'kra' THEN 1 WHEN '30_day' THEN 2 WHEN '60_day' THEN 3 WHEN '90_day' THEN 4 ELSE 5 END, created_at DESC
  `));
}

export async function closeGoal(goalId: string, status: 'met' | 'partial' | 'missed' | 'dropped', notes?: string) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_employee_goals SET status = ${status}, outcome_notes = ${notes || null}, updated_at = NOW()
    WHERE id = ${goalId}
  `);
}

// ============================== PIP ==============================

export async function openPip(opts: {
  employeeId: string;
  managerUserId?: string;
  openedByUserId: string;
  durationWeeks?: number;
  reason: string;
  expectations: string;
  consequences?: string;
}) {
  await ensureLifecycleSchema();
  const weeks = Math.max(1, Math.min(12, opts.durationWeeks || 2));
  const end = new Date(); end.setDate(end.getDate() + weeks * 7);
  const r = rows(await db.execute(sql`
    INSERT INTO hr_pips (employee_id, manager_user_id, opened_by_user_id, duration_weeks, scheduled_end_date,
      reason, expectations, consequences)
    VALUES (${opts.employeeId}, ${opts.managerUserId || null}, ${opts.openedByUserId}, ${weeks},
      ${end.toISOString().slice(0, 10)}, ${opts.reason}, ${opts.expectations}, ${opts.consequences || null})
    RETURNING id, scheduled_end_date
  `));
  return { ok: true, pipId: r[0]?.id, scheduledEnd: r[0]?.scheduled_end_date };
}

export async function listPips(employeeId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_pips WHERE employee_id = ${employeeId} ORDER BY opened_at DESC`));
}

export async function logPipCheckin(opts: {
  pipId: string;
  weekNumber: number;
  progressSummary: string;
  progressRating: 'on_track' | 'partial' | 'not_met';
  managerUserId?: string;
}) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    INSERT INTO hr_pip_checkins (pip_id, week_number, check_date, progress_summary, progress_rating, manager_user_id)
    VALUES (${opts.pipId}, ${opts.weekNumber}, CURRENT_DATE, ${opts.progressSummary}, ${opts.progressRating}, ${opts.managerUserId || null})
  `);
}

export async function listPipCheckins(pipId: string) {
  await ensureLifecycleSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_pip_checkins WHERE pip_id = ${pipId} ORDER BY week_number ASC`));
}

export async function closePip(opts: { pipId: string; outcome: 'met' | 'not_met' | 'extended' | 'early_resolution'; outcomeNotes: string }) {
  await ensureLifecycleSchema();
  await db.execute(sql`
    UPDATE hr_pips SET outcome = ${opts.outcome}, outcome_notes = ${opts.outcomeNotes},
      closed_at = NOW(), updated_at = NOW()
    WHERE id = ${opts.pipId}
  `);
}

// =================================================================================================
// TRANSFERS AND PROMOTIONS — THE CHANGES THAT REWRITE WHO REPORTS TO WHOM, AND WHAT SOMEONE IS
// =================================================================================================
//
// THE RULE THAT GOVERNS EVERYTHING BELOW, in one sentence: a change to a person's reporting line is
// recorded as a NEW EDGE IN THE ORGANIZATION GRAPH with an effective date, never as an UPDATE to
// hr_employees.reporting_manager_id, because the second destroys the answer to "who approved this
// last March" the moment it runs.
//
// WHAT AN APPLIED TRANSFER ACTUALLY DOES, in this order:
//   1. supersedeReportingManager() — ONE statement that closes the open edge with effective_to and
//      opens the new one at the SAME instant. Not two statements: a half-succeeded pair would leave
//      a working person reporting to nobody, and every approval chain would then answer "no one".
//   2. The legacy column is brought INTO STEP, not left behind. hr_employees.reporting_manager_id
//      holds a USERS id (db/hr-schema.sql, and org-graph.ts's compatibility layer reads it that
//      way), so the manager's employee id is resolved to their user id first. Mixing those two id
//      spaces silently writes nobody, and looks exactly like a clean write.
//   3. department_id is written as TEXT and compared as TEXT, NEVER cast ::uuid — departments.id is
//      a varchar(50) slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql, so a cast throws
//      on half the values in this product.
//
// NOTHING HERE DECIDES AN APPROVAL. Every request is routed by src/lib/workflow.ts and applied only
// once that engine says 'approved'. When routing cannot name an approver the request is HALTED with
// the engine's sentence and nothing is applied — a transfer nobody approved must never be
// indistinguishable from one somebody did.

// ------------------------------------------------------------------------------------------------
// CONSTANTS BEFORE THE FUNCTIONS THAT READ THEM. `const` is not hoisted.
// ------------------------------------------------------------------------------------------------

const reasonOf = (e: any): string =>
  String(e?.cause?.message || e?.message || 'unknown database error');

const logMoveFail = (tag: string, e: any) => console.error('[hr-lifecycle] ' + tag, reasonOf(e));

const MOVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isMoveUuid = (v: unknown): v is string => typeof v === 'string' && MOVE_UUID_RE.test(v);

const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

export type MoveState = 'pending' | 'approved' | 'rejected' | 'applied' | 'halted' | 'cancelled';

/**
 * WHAT KIND OF DESIGNATION CHANGE THIS IS — and why all three share ONE table.
 *
 * A promotion, a demotion and a sideways change of title are the SAME MECHANICAL ACT: an
 * effective-dated change to designation and grade on the employee record, approved by the reporting
 * manager and then the department head. They differ in what they MEAN, not in what they do.
 *
 * So there is one hr_promotions table with a `kind` column and one approval chain, rather than a
 * second table and a second chain for demotions. Two tables would be two apply paths, and the second
 * one written would be the one that forgets to snapshot the previous designation — at which point a
 * demoted person's record would say they had always held the lower title.
 *
 * The WORD still matters and is recorded, because "promotion" on an audit trail where a demotion
 * happened is a lie the record tells about somebody for the rest of their career. Nothing infers the
 * kind from whether a grade string sorts lower; a human states it.
 *
 * NOTE that a demotion does NOT change who somebody reports to, exactly as a promotion does not. A
 * change that also moves the reporting line is a transfer, raised separately, because the two are
 * approved by different chains.
 */
export const DESIGNATION_CHANGE_KINDS = [
  { key: 'promotion', label: 'Promotion', note: 'A move up in designation, grade, or both.' },
  { key: 'demotion', label: 'Demotion', note: 'A move down. Recorded as such, never dressed up as a re-designation.' },
  { key: 'designation_change', label: 'Designation change', note: 'A change of title at the same level.' },
] as const;

export type DesignationChangeKind = (typeof DESIGNATION_CHANGE_KINDS)[number]['key'];

const DESIGNATION_CHANGE_KEYS = new Set<string>(DESIGNATION_CHANGE_KINDS.map((k) => k.key));

export function designationChangeLabel(key: string): string {
  for (const k of DESIGNATION_CHANGE_KINDS) if (k.key === key) return k.label;
  return 'Designation change';
}

export interface MoveResult {
  ok: boolean;
  id?: string;
  error?: string;
  haltReason?: string | null;
  changed?: boolean;
}

/**
 * Tables for the two moves, plus the one column a promotion needs.
 *
 * SEPARATE FROM ensureLifecycleSchema() ABOVE, and inside an ensureOnce guard, deliberately: that
 * function predates this work, swallows its own failures and is called from several existing
 * surfaces. Hanging new tables off it would make a failure in the new DDL silently disable the
 * probation console too.
 */
export function ensureMoveSchema(): Promise<void> {
  return ensureOnce('hr_lifecycle_moves_v1', async () => {
    try {
      // GRADE. hr_employees has designation but no grade, and a promotion that can only change a job
      // title cannot record the thing most organisations actually promote people through. Its own
      // statement: a multi-clause ALTER rolls the whole statement back if any one clause fails.
      await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS grade VARCHAR(40)`);

      // department_id and manager columns hold TEXT and UUID respectively. See the header.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        from_department_id TEXT,
        to_department_id TEXT,
        from_manager_employee_id UUID,
        to_manager_employee_id UUID,
        effective_date DATE NOT NULL,
        reason TEXT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        org_relationship_id UUID,
        applied_at TIMESTAMPTZ,
        applied_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_transfers_state_idx
        ON hr_transfers(state, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_transfers_emp_idx
        ON hr_transfers(employee_id, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_promotions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        from_designation TEXT,
        to_designation TEXT NOT NULL,
        from_grade TEXT,
        to_grade TEXT,
        effective_date DATE NOT NULL,
        reason TEXT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        applied_at TIMESTAMPTZ,
        applied_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_promotions_state_idx
        ON hr_promotions(state, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_promotions_emp_idx
        ON hr_promotions(employee_id, created_at DESC)`);

      // KIND. Its own ADD COLUMN statement, additive and defaulted, so every row written before this
      // existed reads as the promotion it was recorded as — not as an unknown, and not as a blank
      // that a screen would have to guess at. See DESIGNATION_CHANGE_KINDS for why demotions live in
      // this table rather than a second one.
      await db.execute(sql`ALTER TABLE hr_promotions
        ADD COLUMN IF NOT EXISTS kind VARCHAR(30) NOT NULL DEFAULT 'promotion'`);
    } catch (e: any) {
      logMoveFail('ensureMoveSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries. See workflow-schema.ts.
    }
  });
}

// ------------------------------------------------------------------------------------------------
// READS
// ------------------------------------------------------------------------------------------------

export interface TransferRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  fromDepartmentName: string | null;
  toDepartmentName: string | null;
  fromManagerEmployeeId: string | null;
  toManagerEmployeeId: string | null;
  fromManagerName: string | null;
  toManagerName: string | null;
  effectiveDate: string | null;
  reason: string;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  appliedAt: string | null;
  createdAt: string | null;
}

function mapTransfer(r: any): TransferRow {
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    fromDepartmentId: r?.from_department_id ? String(r.from_department_id) : null,
    toDepartmentId: r?.to_department_id ? String(r.to_department_id) : null,
    fromDepartmentName: r?.from_department_name ? String(r.from_department_name) : null,
    toDepartmentName: r?.to_department_name ? String(r.to_department_name) : null,
    fromManagerEmployeeId: r?.from_manager_employee_id ? String(r.from_manager_employee_id) : null,
    toManagerEmployeeId: r?.to_manager_employee_id ? String(r.to_manager_employee_id) : null,
    fromManagerName: r?.from_manager_name ? String(r.from_manager_name) : null,
    toManagerName: r?.to_manager_name ? String(r.to_manager_name) : null,
    effectiveDate: r?.effective_date ? String(r.effective_date).slice(0, 10) : null,
    reason: String(r?.reason ?? ''),
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    appliedAt: r?.applied_at ? new Date(r.applied_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Transfers, newest first. `state` narrows it. Fails closed to an empty list. */
export async function listTransfers(opts: { state?: string; employeeId?: string; limit?: number } = {}): Promise<TransferRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureMoveSchema();
    const stateFilter = opts.state ? sql`AND t.state = ${String(opts.state)}` : sql``;
    const empFilter = isMoveUuid(opts.employeeId) ? sql`AND t.employee_id = ${String(opts.employeeId)}::uuid` : sql``;
    // departments joined ::text on BOTH sides — never ::uuid. See the header.
    const r = await db.execute(sql`
      SELECT t.*,
             e.full_name  AS employee_name,
             fd.name      AS from_department_name,
             td.name      AS to_department_name,
             fm.full_name AS from_manager_name,
             tm.full_name AS to_manager_name
        FROM hr_transfers t
        LEFT JOIN hr_employees e  ON e.id  = t.employee_id
        LEFT JOIN hr_employees fm ON fm.id = t.from_manager_employee_id
        LEFT JOIN hr_employees tm ON tm.id = t.to_manager_employee_id
        LEFT JOIN departments fd  ON fd.id::text = t.from_department_id
        LEFT JOIN departments td  ON td.id::text = t.to_department_id
       WHERE TRUE ${stateFilter} ${empFilter}
       ORDER BY (t.state = 'pending') DESC, t.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapTransfer);
  } catch (e: any) {
    logMoveFail('listTransfers', e);
    return [];
  }
}

export interface PromotionRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  /** promotion | demotion | designation_change. See DESIGNATION_CHANGE_KINDS. */
  kind: string;
  fromDesignation: string | null;
  toDesignation: string;
  fromGrade: string | null;
  toGrade: string | null;
  effectiveDate: string | null;
  reason: string;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  appliedAt: string | null;
  createdAt: string | null;
}

function mapPromotion(r: any): PromotionRow {
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    kind: DESIGNATION_CHANGE_KEYS.has(String(r?.kind)) ? String(r.kind) : 'promotion',
    fromDesignation: r?.from_designation ? String(r.from_designation) : null,
    toDesignation: String(r?.to_designation ?? ''),
    fromGrade: r?.from_grade ? String(r.from_grade) : null,
    toGrade: r?.to_grade ? String(r.to_grade) : null,
    effectiveDate: r?.effective_date ? String(r.effective_date).slice(0, 10) : null,
    reason: String(r?.reason ?? ''),
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    appliedAt: r?.applied_at ? new Date(r.applied_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Promotions, newest first. Fails closed to an empty list. */
export async function listPromotions(opts: { state?: string; employeeId?: string; limit?: number } = {}): Promise<PromotionRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureMoveSchema();
    const stateFilter = opts.state ? sql`AND p.state = ${String(opts.state)}` : sql``;
    const empFilter = isMoveUuid(opts.employeeId) ? sql`AND p.employee_id = ${String(opts.employeeId)}::uuid` : sql``;
    const r = await db.execute(sql`
      SELECT p.*, e.full_name AS employee_name
        FROM hr_promotions p
        LEFT JOIN hr_employees e ON e.id = p.employee_id
       WHERE TRUE ${stateFilter} ${empFilter}
       ORDER BY (p.state = 'pending') DESC, p.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapPromotion);
  } catch (e: any) {
    logMoveFail('listPromotions', e);
    return [];
  }
}

// ------------------------------------------------------------------------------------------------
// WRITES — REQUESTS. No bare catch below this line.
// ------------------------------------------------------------------------------------------------

export interface TransferInput {
  employeeId: string;
  toDepartmentId?: string | null;
  toManagerEmployeeId?: string | null;
  effectiveDate: string;
  reason: string;
  requestedByUserId?: string | null;
}

/**
 * Ask for somebody to move department, manager, or both. WRITES A REQUEST. MOVES NOBODY.
 *
 * The "from" side is SNAPSHOTTED at request time — the department off the employee row and the
 * manager out of the ORGANIZATION GRAPH, not off the legacy column. So the request shows the
 * approver the move as it stood when it was raised, and the record still reads correctly after a
 * later reorganisation.
 */
export async function requestTransfer(input: TransferInput): Promise<MoveResult> {
  const employeeId = String(input?.employeeId || '').trim();
  if (!isMoveUuid(employeeId)) return { ok: false, error: 'Choose the person being transferred.' };

  const toDept = input?.toDepartmentId ? String(input.toDepartmentId).trim() : '';
  const toMgr = isMoveUuid(input?.toManagerEmployeeId) ? String(input.toManagerEmployeeId) : '';
  if (!toDept && !toMgr) {
    return { ok: false, error: 'A transfer has to change something — pick a new department, a new manager, or both.' };
  }
  if (toMgr && toMgr === employeeId) {
    return { ok: false, error: 'Nobody can be their own reporting manager.' };
  }

  const effective = String(input?.effectiveDate || '').trim();
  if (!isIsoDate(effective)) return { ok: false, error: 'A transfer needs the date it takes effect.' };

  const reason = String(input?.reason || '').trim();
  if (reason.length < 5) {
    return { ok: false, error: 'Write the reason for this transfer — an approver reads it before deciding.' };
  }

  const requestedBy = isMoveUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureMoveSchema();

    const empRows = rows(await db.execute(sql`
      SELECT id, full_name, department_id::text AS department_id, is_active
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!empRows.length) return { ok: false, error: 'That employee record could not be found.' };
    const emp = empRows[0] as any;
    if (emp.is_active === false) {
      return { ok: false, error: 'That employee record is closed. A person who has left cannot be transferred.' };
    }

    // The department must be on the register. A department id that matches nothing puts the person
    // in no list at all while the record reads as assigned — the same refusal /admin/hr/employees
    // already makes on the same field.
    if (toDept) {
      const known = rows(await db.execute(sql`
        SELECT 1 AS ok FROM departments WHERE id::text = ${toDept} LIMIT 1`));
      if (!known.length) {
        return { ok: false, error: 'That department is not on the department register. Nothing was saved.' };
      }
    }

    if (toMgr) {
      const mgrRows = rows(await db.execute(sql`
        SELECT is_active FROM hr_employees WHERE id = ${toMgr}::uuid LIMIT 1`));
      if (!mgrRows.length) return { ok: false, error: 'That manager has no employee record.' };
      if ((mgrRows[0] as any).is_active === false) {
        return { ok: false, error: 'That manager\'s record is closed. Pick somebody who is still here.' };
      }
    }

    const openAlready = rows(await db.execute(sql`
      SELECT id FROM hr_transfers
       WHERE employee_id = ${employeeId}::uuid AND state IN ('pending', 'halted', 'approved') LIMIT 1`));
    if (openAlready.length) {
      return { ok: false, error: 'A transfer for this person is already in progress. Settle that one first.' };
    }

    // FROM THE GRAPH, not from the column. Null when the graph has no manager for them — which is a
    // real answer and is rendered as such, never as "no manager exists anywhere".
    const currentManager = await getManager(employeeId);

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_transfers
        (employee_id, from_department_id, to_department_id, from_manager_employee_id,
         to_manager_employee_id, effective_date, reason, state, requested_by_user_id)
      VALUES
        (${employeeId}::uuid, ${emp.department_id ? String(emp.department_id) : null}::text,
         ${toDept || null}::text, ${currentManager?.employeeId || null}::uuid,
         ${toMgr || null}::uuid, ${effective}::date, ${reason}, 'pending', ${requestedBy}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: 'The transfer request was not saved. Nothing was changed.' };
    const transferId = String(ins[0].id);

    const wf = await startWorkflow({
      domain: 'transfer',
      recordId: transferId,
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary: 'Transfer for ' + (emp.full_name || 'an employee') + ', effective ' + effective,
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_transfers SET state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
         WHERE id = ${transferId}::uuid`);
      return { ok: false, id: transferId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_transfers
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${transferId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'transfer.requested',
      entity: 'hr_transfer',
      entityId: transferId,
      diff: {
        employeeId,
        fromDepartmentId: emp.department_id || null, toDepartmentId: toDept || null,
        fromManagerEmployeeId: currentManager?.employeeId || null, toManagerEmployeeId: toMgr || null,
        effectiveDate: effective, workflowInstanceId: wf.instanceId || null,
        state: halted ? 'halted' : 'pending', haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: transferId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logMoveFail('requestTransfer', e);
    return { ok: false, error: 'The transfer request was not saved: ' + reasonOf(e) };
  }
}

export interface PromotionInput {
  employeeId: string;
  toDesignation: string;
  toGrade?: string | null;
  effectiveDate: string;
  reason: string;
  requestedByUserId?: string | null;
  /**
   * promotion | demotion | designation_change. Defaults to 'promotion' so every existing caller
   * keeps working unchanged — this parameter was added, not substituted.
   */
  kind?: string | null;
}

/**
 * Ask for a designation and/or grade change — up, down, or sideways. WRITES A REQUEST. CHANGES
 * NOBODY'S TITLE.
 *
 * ONE FUNCTION FOR ALL THREE, deliberately: a separate requestDemotion() would be a second place the
 * previous designation could fail to be snapshotted, and it is the demotion case where losing that
 * snapshot does real harm to a person's record. The three differ only in the WORD recorded against
 * them, and a human states that word — nothing here infers a demotion from whether a grade string
 * happens to sort lower, because grade strings in this product are free text.
 */
export async function requestPromotion(input: PromotionInput): Promise<MoveResult> {
  const employeeId = String(input?.employeeId || '').trim();
  if (!isMoveUuid(employeeId)) return { ok: false, error: 'Choose the person this is for.' };

  const kind = DESIGNATION_CHANGE_KEYS.has(String(input?.kind || 'promotion'))
    ? String(input?.kind || 'promotion')
    : '';
  if (!kind) {
    return { ok: false, error: 'Say whether this is a promotion, a demotion or a change of title at the same level. The record carries that word for the rest of somebody\'s career.' };
  }
  const kindWord = designationChangeLabel(kind).toLowerCase();

  const toDesignation = String(input?.toDesignation || '').trim().slice(0, 200);
  if (!toDesignation) return { ok: false, error: 'A ' + kindWord + ' needs the new designation.' };

  const toGrade = input?.toGrade ? String(input.toGrade).trim().slice(0, 40) : null;

  const effective = String(input?.effectiveDate || '').trim();
  if (!isIsoDate(effective)) return { ok: false, error: 'A ' + kindWord + ' needs the date it takes effect.' };

  const reason = String(input?.reason || '').trim();
  if (reason.length < 5) {
    return { ok: false, error: 'Write the reason for this ' + kindWord + ' — an approver reads it before deciding.' };
  }
  // A DEMOTION NEEDS MORE THAN FIVE WORDS. It is the change most likely to be contested afterwards,
  // and the reason on the row is the whole of what the record will be able to say about why.
  if (kind === 'demotion' && reason.length < 20) {
    return {
      ok: false,
      error: 'Write the reason for this demotion in full. It is the only account the record will carry of why somebody was moved down, and one line is not enough.',
    };
  }

  const requestedBy = isMoveUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureMoveSchema();

    const empRows = rows(await db.execute(sql`
      SELECT id, full_name, designation, grade, is_active
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!empRows.length) return { ok: false, error: 'That employee record could not be found.' };
    const emp = empRows[0] as any;
    if (emp.is_active === false) {
      return { ok: false, error: 'That employee record is closed. A person who has left cannot have their designation changed.' };
    }

    const sameTitle = String(emp.designation || '').trim() === toDesignation;
    const sameGrade = String(emp.grade || '').trim() === String(toGrade || '').trim();
    if (sameTitle && sameGrade) {
      return { ok: false, error: 'That is the designation and grade this person already holds.' };
    }

    // ONE OPEN CHANGE AT A TIME, ACROSS ALL THREE KINDS. A pending promotion and a pending demotion
    // over one person would both apply and the last writer would win silently.
    const openAlready = rows(await db.execute(sql`
      SELECT id, kind FROM hr_promotions
       WHERE employee_id = ${employeeId}::uuid AND state IN ('pending', 'halted', 'approved') LIMIT 1`));
    if (openAlready.length) {
      return {
        ok: false,
        error: 'A ' + designationChangeLabel(String((openAlready[0] as any).kind || 'promotion')).toLowerCase()
          + ' for this person is already in progress. Settle that one first.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_promotions
        (employee_id, kind, from_designation, to_designation, from_grade, to_grade,
         effective_date, reason, state, requested_by_user_id)
      VALUES
        (${employeeId}::uuid, ${kind}, ${emp.designation || null}::text, ${toDesignation},
         ${emp.grade || null}::text, ${toGrade}::text, ${effective}::date, ${reason},
         'pending', ${requestedBy}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: 'The request was not saved. Nothing was changed.' };
    const promotionId = String(ins[0].id);

    // THE SAME 'promotion' DOMAIN FOR ALL THREE. The chain that decides a change of designation and
    // grade is the same chain whichever direction the change goes in, and forking it would create a
    // second answer to "who signs off what somebody is called".
    const wf = await startWorkflow({
      domain: 'promotion',
      recordId: promotionId,
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary: designationChangeLabel(kind) + ' for ' + (emp.full_name || 'an employee')
        + ' to ' + toDesignation,
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_promotions SET state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
         WHERE id = ${promotionId}::uuid`);
      return { ok: false, id: promotionId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_promotions
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${promotionId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: kind + '.requested',
      entity: 'hr_promotion',
      entityId: promotionId,
      diff: {
        employeeId, kind, fromDesignation: emp.designation || null, toDesignation,
        fromGrade: emp.grade || null, toGrade, effectiveDate: effective,
        workflowInstanceId: wf.instanceId || null, state: halted ? 'halted' : 'pending',
        haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: promotionId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logMoveFail('requestPromotion', e);
    return { ok: false, error: 'The request was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw a transfer or promotion that has not been decided. */
export async function cancelMove(
  kind: 'transfer' | 'promotion',
  id: string,
  actorUserId: string | null,
): Promise<MoveResult> {
  if (!isMoveUuid(id)) return { ok: false, error: 'That request could not be identified.' };
  try {
    await ensureMoveSchema();
    const wrote = kind === 'transfer'
      ? rows(await db.execute(sql`
          UPDATE hr_transfers SET state = 'cancelled', updated_at = NOW()
           WHERE id = ${id}::uuid AND state IN ('pending', 'halted') RETURNING id`))
      : rows(await db.execute(sql`
          UPDATE hr_promotions SET state = 'cancelled', updated_at = NOW()
           WHERE id = ${id}::uuid AND state IN ('pending', 'halted') RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request has already been settled, so it cannot be withdrawn.' };
    }
    await logAudit({
      userId: isMoveUuid(actorUserId) ? String(actorUserId) : null,
      action: kind + '.cancelled',
      entity: kind === 'transfer' ? 'hr_transfer' : 'hr_promotion',
      entityId: id,
      diff: {},
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logMoveFail('cancelMove', e);
    return { ok: false, error: 'The request was not withdrawn: ' + reasonOf(e) };
  }
}

// ------------------------------------------------------------------------------------------------
// APPLYING — where the organization graph is actually written
// ------------------------------------------------------------------------------------------------

/**
 * Mirror the workflow engine's decisions onto open transfer and promotion requests, and APPLY the
 * approved ones.
 *
 * A reconcile rather than a callback, for the reason spelled out in src/lib/contracts.ts: a
 * completion callback would make the approval engine import the HR modules, which is a dependency in
 * the wrong direction and a second place a reporting edge could be written from.
 *
 * IT APPROVES NOTHING. It reads a decision the engine already made.
 */
export async function syncMoves(actorUserId?: string | null): Promise<{
  applied: number;
  settled: number;
  errors: string[];
}> {
  const out = { applied: 0, settled: 0, errors: [] as string[] };
  const actor = isMoveUuid(actorUserId) ? String(actorUserId) : null;

  try {
    await ensureMoveSchema();

    const openTransfers = rows(await db.execute(sql`
      SELECT * FROM hr_transfers
       WHERE state IN ('pending', 'halted', 'approved') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of openTransfers) {
      const t = mapTransfer(raw);
      const instance = await readInstance(t.workflowInstanceId, out.errors);
      if (!instance) continue;

      if (instance.state === 'approved' && t.state !== 'applied') {
        const r = await applyApprovedTransfer(t, actor);
        if (r.ok) out.applied += 1; else out.errors.push(r.error || 'A transfer could not be applied.');
        continue;
      }
      if (instance.state === 'rejected' || instance.state === 'cancelled') {
        await settleMoveRow('transfer', t.id, instance.state === 'rejected' ? 'rejected' : 'cancelled', out.errors);
        out.settled += 1;
        continue;
      }
      if (instance.state === 'halted' && t.state !== 'halted') {
        await markMoveHalted('transfer', t.id, instance.haltReason, out.errors);
      }
    }

    const openPromotions = rows(await db.execute(sql`
      SELECT * FROM hr_promotions
       WHERE state IN ('pending', 'halted', 'approved') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of openPromotions) {
      const p = mapPromotion(raw);
      const instance = await readInstance(p.workflowInstanceId, out.errors);
      if (!instance) continue;

      if (instance.state === 'approved' && p.state !== 'applied') {
        const r = await applyApprovedPromotion(p, actor);
        if (r.ok) out.applied += 1; else out.errors.push(r.error || 'A promotion could not be applied.');
        continue;
      }
      if (instance.state === 'rejected' || instance.state === 'cancelled') {
        await settleMoveRow('promotion', p.id, instance.state === 'rejected' ? 'rejected' : 'cancelled', out.errors);
        out.settled += 1;
        continue;
      }
      if (instance.state === 'halted' && p.state !== 'halted') {
        await markMoveHalted('promotion', p.id, instance.haltReason, out.errors);
      }
    }
  } catch (e: any) {
    logMoveFail('syncMoves', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

async function readInstance(instanceId: string | null, errors: string[]): Promise<WorkflowInstanceView | null> {
  if (!instanceId) return null;
  try {
    return await getInstance(instanceId);
  } catch (e: any) {
    logMoveFail('readInstance', e);
    errors.push('An approval could not be read: ' + reasonOf(e));
    return null;
  }
}

async function settleMoveRow(kind: 'transfer' | 'promotion', id: string, state: MoveState, errors: string[]) {
  try {
    if (kind === 'transfer') {
      await db.execute(sql`
        UPDATE hr_transfers SET state = ${state}, updated_at = NOW()
         WHERE id = ${id}::uuid AND state IN ('pending', 'halted', 'approved')`);
    } else {
      await db.execute(sql`
        UPDATE hr_promotions SET state = ${state}, updated_at = NOW()
         WHERE id = ${id}::uuid AND state IN ('pending', 'halted', 'approved')`);
    }
  } catch (e: any) {
    logMoveFail('settleMoveRow', e);
    errors.push('A decision could not be written down: ' + reasonOf(e));
  }
}

async function markMoveHalted(kind: 'transfer' | 'promotion', id: string, why: string | null, errors: string[]) {
  try {
    if (kind === 'transfer') {
      await db.execute(sql`
        UPDATE hr_transfers SET state = 'halted', halt_reason = ${why}::text, updated_at = NOW()
         WHERE id = ${id}::uuid`);
    } else {
      await db.execute(sql`
        UPDATE hr_promotions SET state = 'halted', halt_reason = ${why}::text, updated_at = NOW()
         WHERE id = ${id}::uuid`);
    }
  } catch (e: any) {
    logMoveFail('markMoveHalted', e);
    errors.push('A halt could not be recorded: ' + reasonOf(e));
  }
}

/**
 * THE ORG GRAPH WRITE. Close the old reporting edge, open the new one, at the transfer's effective
 * date — and bring the legacy column into step behind it.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *   1. The GRAPH first. It is the record of who reported to whom and it is the one that must be
 *      right; if it fails, nothing else is written and the request stays approved-but-not-applied,
 *      visible on the console with the reason.
 *   2. The legacy column and department second, as the COMPATIBILITY layer. A failure here is
 *      reported, not swallowed — every screen still reading the column would otherwise disagree with
 *      the graph and nobody would know which was right.
 *
 * NO IN-PLACE MANAGER UPDATE ANYWHERE. hr_employees.reporting_manager_id is written only to mirror
 * the edge the graph already holds, and the graph keeps the closed edge with its effective_to so
 * "who approved this last March" survives.
 */
async function applyApprovedTransfer(t: TransferRow, actorUserId: string | null): Promise<MoveResult> {
  try {
    // A transfer that changes the manager needs a graph to write into. Saying so is the honest
    // answer; writing the column alone would look like it worked and lose the history.
    if (t.toManagerEmployeeId && !(await orgGraphInitialized())) {
      return {
        ok: false,
        error:
          'The reporting line for ' + (t.employeeName || 'this person')
          + ' was not changed: the Organization Graph is not yet initialized, so there is no history to supersede. '
          + 'Run the graph backfill first — nothing was written.',
      };
    }

    let relationshipId: string | null = null;

    if (t.toManagerEmployeeId) {
      const moved = await supersedeReportingManager(t.employeeId, t.toManagerEmployeeId, {
        asOf: t.effectiveDate || undefined,
        createdByUserId: actorUserId,
        note: 'Transfer ' + t.id + ': ' + t.reason,
      });
      if (!moved.ok) {
        return {
          ok: false,
          error: 'The reporting line was not changed, so nothing was applied: ' + (moved.error || 'unknown reason'),
        };
      }
      relationshipId = moved.id || null;
    }

    // THE COMPATIBILITY LAYER. reporting_manager_id holds a USERS id — resolved from the new
    // manager's employee row, never assumed to be the employee id.
    if (t.toManagerEmployeeId) {
      await db.execute(sql`
        UPDATE hr_employees
           SET reporting_manager_id = (
                 SELECT m.user_id FROM hr_employees m WHERE m.id = ${t.toManagerEmployeeId}::uuid
               ),
               updated_at = NOW()
         WHERE id = ${t.employeeId}::uuid`);
    }

    // department_id as TEXT. Never ::uuid — see the header.
    if (t.toDepartmentId) {
      await db.execute(sql`
        UPDATE hr_employees SET department_id = ${t.toDepartmentId}, updated_at = NOW()
         WHERE id = ${t.employeeId}::uuid`);
    }

    await db.execute(sql`
      UPDATE hr_transfers
         SET state = 'applied', applied_at = NOW(), applied_by_user_id = ${actorUserId}::uuid,
             org_relationship_id = ${relationshipId}::uuid, updated_at = NOW()
       WHERE id = ${t.id}::uuid`);

    await logAudit({
      userId: actorUserId,
      action: 'transfer.applied',
      entity: 'hr_transfer',
      entityId: t.id,
      diff: {
        employeeId: t.employeeId, effectiveDate: t.effectiveDate,
        fromDepartmentId: t.fromDepartmentId, toDepartmentId: t.toDepartmentId,
        fromManagerEmployeeId: t.fromManagerEmployeeId, toManagerEmployeeId: t.toManagerEmployeeId,
        orgRelationshipId: relationshipId, workflowInstanceId: t.workflowInstanceId,
        legacyColumnSynced: !!t.toManagerEmployeeId,
      },
    });

    return { ok: true, id: t.id, changed: true };
  } catch (e: any) {
    logMoveFail('applyApprovedTransfer', e);
    return { ok: false, error: 'The transfer could not be applied: ' + reasonOf(e) };
  }
}

/**
 * Apply an approved promotion: designation and grade on the employee record, with the previous
 * values preserved on the promotion row so the history is not lost to the update.
 *
 * A promotion does NOT touch the reporting edge. Being promoted is not being moved, and conflating
 * the two would silently rewrite a reporting line nobody asked to change. A promotion that also
 * changes who somebody reports to is a promotion AND a transfer, raised as two requests, because
 * they are approved by different chains.
 */
async function applyApprovedPromotion(p: PromotionRow, actorUserId: string | null): Promise<MoveResult> {
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE hr_employees
         SET designation = ${p.toDesignation},
             grade = COALESCE(${p.toGrade}::varchar(40), grade),
             updated_at = NOW()
       WHERE id = ${p.employeeId}::uuid
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That employee record no longer exists, so the promotion was not applied.' };
    }

    await db.execute(sql`
      UPDATE hr_promotions
         SET state = 'applied', applied_at = NOW(), applied_by_user_id = ${actorUserId}::uuid, updated_at = NOW()
       WHERE id = ${p.id}::uuid`);

    await logAudit({
      userId: actorUserId,
      // The WORD is preserved onto the applied entry too. An audit trail that records every
      // designation change as "promotion.applied" is a record that lies about what happened to
      // somebody, and it is the demotion case where that matters.
      action: (p.kind || 'promotion') + '.applied',
      entity: 'hr_promotion',
      entityId: p.id,
      diff: {
        employeeId: p.employeeId, kind: p.kind, effectiveDate: p.effectiveDate,
        from: { designation: p.fromDesignation, grade: p.fromGrade },
        to: { designation: p.toDesignation, grade: p.toGrade },
        workflowInstanceId: p.workflowInstanceId,
      },
    });

    return { ok: true, id: p.id, changed: true };
  } catch (e: any) {
    logMoveFail('applyApprovedPromotion', e);
    return { ok: false, error: 'The promotion could not be applied: ' + reasonOf(e) };
  }
}

// =================================================================================================
// PROBATION OUTCOMES — CONFIRM, EXTEND, TERMINATE, WITH AN APPROVAL BEHIND EACH
// =================================================================================================
//
// WHAT WAS MISSING, AND WHY IT MATTERED. hr_probation and its 30/60/90 reviews have existed here
// since the lifecycle manual work, and confirmEmployee(), extendProbation() and
// terminateOnProbation() have existed alongside them — as DIRECT WRITES. Anybody who could reach the
// employee console could confirm a person, extend their probation, or end their employment during
// it, and the only record of the decision was the row it changed.
//
// Confirming somebody is the moment they stop being provisional; terminating on probation is the
// moment they lose their job with the shortest notice this product ever records. Neither of those is
// a field edit. Both are now REQUESTS, routed by src/lib/workflow.ts on the 'confirmation' domain,
// and applied only once that engine says 'approved'.
//
// THE THREE EXISTING FUNCTIONS ARE NOT REPLACED AND NOT DEPRECATED — they are what APPLY calls once
// the decision exists. That is deliberate: rewriting the apply logic here would be a second writer
// of hr_probation and of hr_employees.confirmation_date, and the second writer is the one that
// forgets to bring the employee record into step. This layer decides WHETHER; those functions do
// WHAT, exactly as they already did.
//
// NOTHING AUTO-CONFIRMS ON A DATE. A probation whose end date has passed with no decision stays
// visibly open, and the console lists it as overdue. An automatic confirmation is a confirmation
// nobody made, and an automatic termination does not bear thinking about.

/** The three ways a probation can end. A human states which; nothing is inferred from a rating. */
export const PROBATION_OUTCOMES = [
  { key: 'confirm', label: 'Confirm', note: 'The person is confirmed in post. Probation ends.' },
  { key: 'extend', label: 'Extend', note: 'Probation runs on for a further period, with a stated reason.' },
  { key: 'terminate', label: 'End employment', note: 'Employment ends during probation. The reason is on the record.' },
] as const;

export type ProbationOutcome = (typeof PROBATION_OUTCOMES)[number]['key'];

const PROBATION_OUTCOME_KEYS = new Set<string>(PROBATION_OUTCOMES.map((o) => o.key));

export function probationOutcomeLabel(key: string): string {
  for (const o of PROBATION_OUTCOMES) if (o.key === key) return o.label;
  return String(key || 'Decision');
}

const MAX_PROBATION_EXTENSION_MONTHS = 6;

/**
 * The decision table. Its OWN ensureOnce guard, separate from ensureLifecycleSchema() above, for the
 * same reason ensureMoveSchema() has one: that function predates this work and is awaited by several
 * existing surfaces, so a failure in new DDL hung off it would silently disable the probation and
 * PIP consoles too.
 */
export function ensureProbationDecisionSchema(): Promise<void> {
  return ensureOnce('hr_probation_decisions_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_probation_decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        probation_id UUID NOT NULL REFERENCES hr_probation(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL,
        outcome VARCHAR(20) NOT NULL,
        extend_months INT,
        effective_date DATE NOT NULL,
        reason TEXT NOT NULL,
        letter_url TEXT,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        applied_at TIMESTAMPTZ,
        applied_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_prob_decisions_state_idx
        ON hr_probation_decisions(state, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_prob_decisions_prob_idx
        ON hr_probation_decisions(probation_id, created_at DESC)`);
    } catch (e: any) {
      logMoveFail('ensureProbationDecisionSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries.
    }
  });
}

export interface ProbationRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  startDate: string | null;
  scheduledEndDate: string | null;
  extendedToDate: string | null;
  /** The date the probation actually runs to — the extension where there is one. */
  endsOn: string | null;
  durationMonths: number;
  status: string;
  extensionCount: number;
  /** Negative when the end date has already passed with no decision recorded. */
  daysRemaining: number | null;
  overdue: boolean;
  /** True when a decision on this probation is already routed and waiting. */
  decisionInProgress: boolean;
}

/**
 * Probations that are still running, with the date each one is due and whether it is overdue.
 *
 * OVERDUE IS COMPUTED, NEVER ACTED ON. The list says a probation ended three weeks ago and nobody
 * decided anything; it does not decide anything itself. See the header.
 */
export async function listOpenProbations(limit = 200): Promise<ProbationRow[]> {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 400);
  try {
    await ensureLifecycleSchema();
    await ensureProbationDecisionSchema();
    const r = await db.execute(sql`
      SELECT p.*, e.full_name AS employee_name, e.employee_code AS employee_code,
             EXISTS (
               SELECT 1 FROM hr_probation_decisions d
                WHERE d.probation_id = p.id AND d.state IN ('pending', 'halted', 'approved')
             ) AS decision_in_progress
        FROM hr_probation p
        LEFT JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.status IN ('active', 'extended')
       ORDER BY COALESCE(p.extended_to_date, p.scheduled_end_date) ASC
       LIMIT ${lim}`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return rows(r).map((x: any) => {
      const endsOn = x.extended_to_date
        ? String(x.extended_to_date).slice(0, 10)
        : (x.scheduled_end_date ? String(x.scheduled_end_date).slice(0, 10) : null);
      let daysRemaining: number | null = null;
      if (endsOn) {
        const end = new Date(endsOn + 'T00:00:00');
        if (!isNaN(end.getTime())) {
          daysRemaining = Math.round((end.getTime() - today.getTime()) / 86400000);
        }
      }
      return {
        id: String(x.id),
        employeeId: String(x.employee_id),
        employeeName: x.employee_name ? String(x.employee_name) : null,
        employeeCode: x.employee_code ? String(x.employee_code) : null,
        startDate: x.start_date ? String(x.start_date).slice(0, 10) : null,
        scheduledEndDate: x.scheduled_end_date ? String(x.scheduled_end_date).slice(0, 10) : null,
        extendedToDate: x.extended_to_date ? String(x.extended_to_date).slice(0, 10) : null,
        endsOn,
        durationMonths: Number(x.duration_months) || 0,
        status: String(x.status || 'active'),
        extensionCount: Number(x.extension_count) || 0,
        daysRemaining,
        overdue: daysRemaining !== null && daysRemaining < 0,
        decisionInProgress: x.decision_in_progress === true,
      };
    });
  } catch (e: any) {
    logMoveFail('listOpenProbations', e);
    return [];
  }
}

export interface ProbationDecisionRow {
  id: string;
  probationId: string;
  employeeId: string;
  employeeName: string | null;
  outcome: string;
  extendMonths: number | null;
  effectiveDate: string | null;
  reason: string;
  letterUrl: string | null;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  appliedAt: string | null;
  createdAt: string | null;
}

function mapProbationDecision(r: any): ProbationDecisionRow {
  return {
    id: String(r?.id ?? ''),
    probationId: String(r?.probation_id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    outcome: String(r?.outcome ?? ''),
    extendMonths: r?.extend_months === null || r?.extend_months === undefined ? null : Number(r.extend_months),
    effectiveDate: r?.effective_date ? String(r.effective_date).slice(0, 10) : null,
    reason: String(r?.reason ?? ''),
    letterUrl: r?.letter_url ? String(r.letter_url) : null,
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    appliedAt: r?.applied_at ? new Date(r.applied_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Probation decisions, open ones first. Fails closed to an empty list. */
export async function listProbationDecisions(
  opts: { state?: string; employeeId?: string; limit?: number } = {},
): Promise<ProbationDecisionRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 400);
  try {
    await ensureProbationDecisionSchema();
    const stateFilter = opts.state ? sql`AND d.state = ${String(opts.state)}` : sql``;
    const empFilter = isMoveUuid(opts.employeeId)
      ? sql`AND d.employee_id = ${String(opts.employeeId)}::uuid`
      : sql``;
    const r = await db.execute(sql`
      SELECT d.*, e.full_name AS employee_name
        FROM hr_probation_decisions d
        LEFT JOIN hr_employees e ON e.id = d.employee_id
       WHERE TRUE ${stateFilter} ${empFilter}
       ORDER BY (d.state IN ('pending', 'halted')) DESC, d.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapProbationDecision);
  } catch (e: any) {
    logMoveFail('listProbationDecisions', e);
    return [];
  }
}

export interface ProbationDecisionInput {
  probationId: string;
  outcome: string;
  extendMonths?: number | null;
  effectiveDate: string;
  reason: string;
  /** Google Drive link to the confirmation or termination letter. A LINK — nothing is uploaded here. */
  letterUrl?: string | null;
  requestedByUserId?: string | null;
}

/**
 * Ask for a probation to be confirmed, extended, or ended. WRITES A REQUEST. CONFIRMS NOBODY.
 *
 * The letter is a LINK, never an upload, by the standing rule in this codebase: documents of any
 * kind are links, and the only stored upload anywhere here is a small profile photo.
 */
export async function requestProbationDecision(input: ProbationDecisionInput): Promise<MoveResult> {
  const probationId = String(input?.probationId || '').trim();
  if (!isMoveUuid(probationId)) return { ok: false, error: 'That probation could not be identified.' };

  const outcome = PROBATION_OUTCOME_KEYS.has(String(input?.outcome)) ? String(input.outcome) : '';
  if (!outcome) {
    return { ok: false, error: 'Say what is being decided — confirm, extend, or end employment.' };
  }

  const effective = String(input?.effectiveDate || '').trim();
  if (!isIsoDate(effective)) return { ok: false, error: 'A probation decision needs the date it takes effect.' };

  const reason = String(input?.reason || '').trim();
  if (reason.length < 5) {
    return { ok: false, error: 'Write the reason — an approver reads it before deciding.' };
  }
  // ENDING SOMEBODY'S EMPLOYMENT NEEDS MORE THAN A LINE, for the same reason a demotion does: the
  // reason on this row is the whole of what the record will be able to say about why it happened.
  if (outcome === 'terminate' && reason.length < 20) {
    return {
      ok: false,
      error: 'Write the reason for ending this employment in full. One line is not enough for the only account the record will carry.',
    };
  }

  let extendMonths: number | null = null;
  if (outcome === 'extend') {
    extendMonths = Math.round(Number(input?.extendMonths) || 0);
    if (extendMonths < 1 || extendMonths > MAX_PROBATION_EXTENSION_MONTHS) {
      return {
        ok: false,
        error: 'An extension has to be between 1 and ' + MAX_PROBATION_EXTENSION_MONTHS + ' months.',
      };
    }
  }

  const rawLetter = String(input?.letterUrl || '').trim();
  if (rawLetter && !/^https:\/\/[^\s]+$/i.test(rawLetter)) {
    return { ok: false, error: 'The letter has to be an https link that opens for the person receiving it. Nothing is uploaded here.' };
  }
  const letterUrl = rawLetter ? rawLetter.slice(0, 1000) : null;

  const requestedBy = isMoveUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureLifecycleSchema();
    await ensureProbationDecisionSchema();

    const probRows = rows(await db.execute(sql`
      SELECT p.id, p.employee_id, p.status, e.full_name, e.is_active
        FROM hr_probation p
        LEFT JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.id = ${probationId}::uuid LIMIT 1`));
    if (!probRows.length) return { ok: false, error: 'That probation could not be found.' };
    const prob = probRows[0] as any;
    const status = String(prob.status || '');
    if (status !== 'active' && status !== 'extended') {
      return { ok: false, error: 'That probation is already ' + status + ', so there is nothing left to decide.' };
    }
    if (prob.is_active === false) {
      return { ok: false, error: 'That employee record is closed.' };
    }

    const openAlready = rows(await db.execute(sql`
      SELECT id FROM hr_probation_decisions
       WHERE probation_id = ${probationId}::uuid AND state IN ('pending', 'halted', 'approved') LIMIT 1`));
    if (openAlready.length) {
      return { ok: false, error: 'A decision on this probation is already in progress. Settle that one first.' };
    }

    const employeeId = String(prob.employee_id);
    const ins = rows(await db.execute(sql`
      INSERT INTO hr_probation_decisions
        (probation_id, employee_id, outcome, extend_months, effective_date, reason, letter_url,
         state, requested_by_user_id)
      VALUES
        (${probationId}::uuid, ${employeeId}::uuid, ${outcome}, ${extendMonths}, ${effective}::date,
         ${reason}, ${letterUrl}, 'pending', ${requestedBy}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: 'The decision was not saved. Nothing was changed.' };
    const decisionId = String(ins[0].id);

    const wf = await startWorkflow({
      domain: 'confirmation',
      recordId: decisionId,
      subjectEmployeeId: employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary: probationOutcomeLabel(outcome) + ' — probation of '
        + (prob.full_name || 'an employee') + ', effective ' + effective,
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_probation_decisions SET state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
         WHERE id = ${decisionId}::uuid`);
      return { ok: false, id: decisionId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_probation_decisions
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${decisionId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'probation.' + outcome + '.requested',
      entity: 'hr_probation_decision',
      entityId: decisionId,
      diff: {
        probationId, employeeId, outcome, extendMonths, effectiveDate: effective,
        workflowInstanceId: wf.instanceId || null, state: halted ? 'halted' : 'pending',
        haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: decisionId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logMoveFail('requestProbationDecision', e);
    return { ok: false, error: 'The decision was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw a probation decision that has not been decided. */
export async function cancelProbationDecision(
  id: string,
  actorUserId: string | null,
): Promise<MoveResult> {
  if (!isMoveUuid(id)) return { ok: false, error: 'That decision could not be identified.' };
  try {
    await ensureProbationDecisionSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_probation_decisions SET state = 'cancelled', updated_at = NOW()
       WHERE id = ${id}::uuid AND state IN ('pending', 'halted') RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That decision has already been settled, so it cannot be withdrawn.' };
    }
    await logAudit({
      userId: isMoveUuid(actorUserId) ? String(actorUserId) : null,
      action: 'probation.decision.cancelled', entity: 'hr_probation_decision', entityId: id, diff: {},
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logMoveFail('cancelProbationDecision', e);
    return { ok: false, error: 'The decision was not withdrawn: ' + reasonOf(e) };
  }
}

/**
 * Mirror the engine's decisions onto open probation decisions, and APPLY the approved ones.
 *
 * A reconcile rather than a callback, exactly as syncMoves() above is and for the same reason: a
 * completion callback would make the approval engine import the HR modules, which is a dependency in
 * the wrong direction and a second place a confirmation could be written from.
 *
 * IT APPROVES NOTHING. It reads a decision the engine already made, and then calls the three
 * existing apply functions — confirmEmployee(), extendProbation(), terminateOnProbation() — rather
 * than reimplementing what they do.
 */
export async function syncProbationDecisions(actorUserId?: string | null): Promise<{
  applied: number;
  settled: number;
  errors: string[];
}> {
  const out = { applied: 0, settled: 0, errors: [] as string[] };
  const actor = isMoveUuid(actorUserId) ? String(actorUserId) : null;

  try {
    await ensureLifecycleSchema();
    await ensureProbationDecisionSchema();

    const open = rows(await db.execute(sql`
      SELECT * FROM hr_probation_decisions
       WHERE state IN ('pending', 'halted', 'approved') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of open) {
      const d = mapProbationDecision(raw);
      const instance = await readInstance(d.workflowInstanceId, out.errors);
      if (!instance) continue;

      if (instance.state === 'approved' && d.state !== 'applied') {
        const r = await applyProbationDecision(d, actor);
        if (r.ok) out.applied += 1;
        else out.errors.push(r.error || 'A probation decision could not be applied.');
        continue;
      }
      if (instance.state === 'rejected' || instance.state === 'cancelled') {
        try {
          await db.execute(sql`
            UPDATE hr_probation_decisions
               SET state = ${instance.state === 'rejected' ? 'rejected' : 'cancelled'}, updated_at = NOW()
             WHERE id = ${d.id}::uuid AND state IN ('pending', 'halted', 'approved')`);
          out.settled += 1;
        } catch (e: any) {
          logMoveFail('syncProbationDecisions.settle', e);
          out.errors.push('A decision could not be written down: ' + reasonOf(e));
        }
        continue;
      }
      if (instance.state === 'halted' && d.state !== 'halted') {
        try {
          await db.execute(sql`
            UPDATE hr_probation_decisions SET state = 'halted', halt_reason = ${instance.haltReason}::text,
                   updated_at = NOW()
             WHERE id = ${d.id}::uuid`);
        } catch (e: any) {
          logMoveFail('syncProbationDecisions.halt', e);
          out.errors.push('A halt could not be recorded: ' + reasonOf(e));
        }
      }
    }
  } catch (e: any) {
    logMoveFail('syncProbationDecisions', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

/**
 * APPLY ONE APPROVED PROBATION DECISION, through the functions that already own the write.
 *
 * ORDER MATTERS. The probation record is written FIRST, by the existing function; the decision row
 * is marked applied only after that returns. If confirmEmployee() throws — and it deliberately
 * propagates, because it also has to bring hr_employees.confirmation_date into step — the decision
 * stays approved-but-not-applied, visible on the console with the reason. A decision marked applied
 * over a write that failed is two records disagreeing about whether somebody is confirmed, which is
 * the fault class this whole layer exists to remove.
 */
async function applyProbationDecision(
  d: ProbationDecisionRow,
  actorUserId: string | null,
): Promise<MoveResult> {
  try {
    if (d.outcome === 'confirm') {
      // confirmEmployee() needs a user id for the record. The requester is the honest answer when
      // the reconcile is running without an actor — it is who asked for it, and the approval trail
      // on the workflow instance carries who agreed.
      const by = actorUserId || d.employeeId;
      await confirmEmployee({
        probationId: d.probationId,
        confirmedByUserId: by,
        letterUrl: d.letterUrl || undefined,
      });
    } else if (d.outcome === 'extend') {
      const r = await extendProbation({
        probationId: d.probationId,
        months: Number(d.extendMonths) || 1,
        reason: d.reason,
      });
      if (!r.ok) {
        return { ok: false, error: 'The probation was not extended: ' + (r.error || 'it could not be found') };
      }
    } else if (d.outcome === 'terminate') {
      await terminateOnProbation({ probationId: d.probationId, reason: d.reason });
    } else {
      return { ok: false, error: 'That decision has an outcome this console does not recognise, so nothing was applied.' };
    }

    await db.execute(sql`
      UPDATE hr_probation_decisions
         SET state = 'applied', applied_at = NOW(), applied_by_user_id = ${actorUserId}::uuid,
             updated_at = NOW()
       WHERE id = ${d.id}::uuid`);

    await logAudit({
      userId: actorUserId,
      action: 'probation.' + d.outcome + '.applied',
      entity: 'hr_probation_decision',
      entityId: d.id,
      diff: {
        probationId: d.probationId, employeeId: d.employeeId, outcome: d.outcome,
        extendMonths: d.extendMonths, effectiveDate: d.effectiveDate,
        workflowInstanceId: d.workflowInstanceId,
      },
    });
    return { ok: true, id: d.id, changed: true };
  } catch (e: any) {
    logMoveFail('applyProbationDecision', e);
    return { ok: false, error: 'The probation decision could not be applied: ' + reasonOf(e) };
  }
}
