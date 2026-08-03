// src/lib/performance.ts — APPRAISAL CYCLES, CONTINUOUS FEEDBACK, 360 FEEDBACK, PROMOTION.
//
// =================================================================================================
// FOUR THINGS, ONE FILE, AND WHAT EACH OF THEM DEFERS TO
// =================================================================================================
//
//   APPRAISAL     self-assessment -> manager review -> calibration -> outcome. The rows are the
//                 EXISTING hr_review_cycles / hr_performance_reviews pair, extended in
//                 performance-schema.ts. The SIGN-OFF is routed through src/lib/workflow.ts, which
//                 is the only approval engine in this product.
//   FEEDBACK      lightweight, any-to-any. Visible to the recipient and to whoever the Organization
//                 Graph says answers for their work.
//   360           the same table, with a cycle attached. Reviewers are resolved from the graph's
//                 `reviewer` edge — org-graph.ts getReviewers / getReviewSubjects — and never from a
//                 stored reviewer list, which would be a second org graph going stale on its own.
//   PROMOTION     a WORKFLOW, never a direct write. It routes through the EXISTING `promotion`
//                 domain declared in workflow.ts by the employee-lifecycle console; this module does
//                 not fork the chain and does not touch hr_employees.designation. A recommendation
//                 is a recommendation.
//
// =================================================================================================
// MANAGER IS A RELATIONSHIP. EVERY TIME.
// =================================================================================================
//
// "Who reviews this person" is getManager(). "Whose reviews do I owe" is getDirectReports(). "May I
// read this row" is isResponsibleFor(). All three come from the Organization Graph through
// performance-scope.ts. There is no role name anywhere in this file, no comparison against
// users.assigned_department_id, and no "same department" test.
//
// WHEN THE GRAPH IS EMPTY, NOTHING HERE PRETENDS. A cycle can still be created and self-assessments
// can still be written — those need no relationship. What CANNOT happen is a sign-off: startWorkflow
// halts with "organization graph not yet initialized", the review keeps its halt reason, and the
// screen prints it. It is never approved and never quietly skipped.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { getManager, getReviewers } from '@/lib/org-graph';
import {
  startWorkflow,
  instanceForRecord,
  getInstance,
  type WorkflowInstanceRow,
} from '@/lib/workflow';
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

const MOD = 'performance';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// VOCABULARY — declared above everything that reads it.
// -------------------------------------------------------------------------------------------------

/**
 * The stages an appraisal cycle moves through, in order.
 *
 * This is NOT the same column as the cycle's `status` (draft | active | closed), which the existing
 * /admin/hr/performance page already writes. Status says whether the cycle is running; stage says
 * what it is running. A cycle that is merely 'active' tells nobody whether self-assessments are
 * still open, which is the question everybody actually has.
 */
export const CYCLE_STAGES = ['self_assessment', 'manager_review', 'calibration', 'complete'] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];

export const CYCLE_STAGE_LABELS: Record<string, string> = {
  self_assessment: 'Self-assessment',
  manager_review: 'Manager review',
  calibration: 'Calibration',
  complete: 'Complete',
};

/** Stage may only move FORWARD. A stage that can go back is a stage nobody trusts. */
const STAGE_ORDER: Record<string, number> = {
  self_assessment: 0,
  manager_review: 1,
  calibration: 2,
  complete: 3,
};

export const REVIEW_OUTCOMES = ['on_track', 'exceeded', 'needs_support', 'promotion_recommended'] as const;
export const REVIEW_OUTCOME_LABELS: Record<string, string> = {
  on_track: 'Meeting expectations',
  exceeded: 'Exceeding expectations',
  needs_support: 'Needs support',
  promotion_recommended: 'Recommended for promotion',
};

export const FEEDBACK_THEMES = ['general', 'strength', 'improvement'] as const;
export const FEEDBACK_THEME_LABELS: Record<string, string> = {
  general: 'General',
  strength: 'Strength',
  improvement: 'Something to work on',
};

/** Ratings are 1..5 everywhere on these screens. Stored NUMERIC(5,2) so a calibration can be 3.5. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * The record-id prefix a promotion recommendation raised from an appraisal uses.
 *
 * workflow_instances is unique on (domain, record_id). The employee-lifecycle console owns the
 * `promotion` domain and keys its instances on its OWN record ids; namespacing here is what makes it
 * impossible for the two to collide on one row while still sharing one chain and one queue.
 */
const PROMOTION_RECORD_PREFIX = 'appraisal-review:';

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface ReviewCycle {
  id: string;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  reviewType: string | null;
  status: string;
  stage: string;
  selfDueOn: string | null;
  managerDueOn: string | null;
  calibrationDueOn: string | null;
  createdAt: string | null;
  /** Counts, for the console. Zero when the read failed — never rendered as "everyone is done". */
  total: number;
  selfDone: number;
  managerDone: number;
  calibrated: number;
}

export interface PerformanceReview {
  id: string;
  cycleId: string;
  cycleTitle: string | null;
  cycleStage: string;
  employeeId: string;
  employeeName: string | null;
  employeeDesignation: string | null;
  status: string;
  selfAssessment: string | null;
  selfRating: number | null;
  selfSubmittedAt: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  managerSubmittedAt: string | null;
  overallRating: number | null;
  goalsScore: number | null;
  skillsScore: number | null;
  attitudeScore: number | null;
  strengths: string | null;
  improvements: string | null;
  goalsNext: string | null;
  reviewerComments: string | null;
  calibratedRating: number | null;
  calibrationNote: string | null;
  calibratedAt: string | null;
  outcome: string | null;
  outcomeNote: string | null;
  sharedWithEmployeeAt: string | null;
  workflowInstanceId: string | null;
  proposedDesignation: string | null;
  promotionJustification: string | null;
  promotionWorkflowId: string | null;
}

export interface FeedbackNote {
  id: string;
  kind: string;
  subjectEmployeeId: string;
  subjectName: string | null;
  authorUserId: string | null;
  authorName: string;
  cycleId: string | null;
  theme: string;
  body: string;
  visibleToManager: boolean;
  createdAt: string | null;
}

export interface PerfWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Set when a workflow halted. The sentence, verbatim, so a screen shows the cause not a shrug. */
  haltReason?: string | null;
}

// -------------------------------------------------------------------------------------------------
// MAPPERS
// -------------------------------------------------------------------------------------------------

function isoDay(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function mapCycle(r: any): ReviewCycle {
  return {
    id: String(r?.id ?? ''),
    title: r?.title ? String(r.title) : 'Untitled cycle',
    periodStart: isoDay(r?.period_start),
    periodEnd: isoDay(r?.period_end),
    reviewType: r?.review_type ? String(r.review_type) : null,
    status: String(r?.status ?? 'draft'),
    stage: String(r?.stage ?? 'self_assessment'),
    selfDueOn: isoDay(r?.self_due_on),
    managerDueOn: isoDay(r?.manager_due_on),
    calibrationDueOn: isoDay(r?.calibration_due_on),
    createdAt: iso(r?.created_at),
    total: Number(r?.total) || 0,
    selfDone: Number(r?.self_done) || 0,
    managerDone: Number(r?.manager_done) || 0,
    calibrated: Number(r?.calibrated) || 0,
  };
}

function mapReview(r: any): PerformanceReview {
  return {
    id: String(r?.id ?? ''),
    cycleId: String(r?.cycle_id ?? ''),
    cycleTitle: r?.cycle_title ? String(r.cycle_title) : null,
    cycleStage: String(r?.cycle_stage ?? 'self_assessment'),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    employeeDesignation: r?.employee_designation ? String(r.employee_designation) : null,
    status: String(r?.status ?? 'pending'),
    selfAssessment: r?.self_assessment ? String(r.self_assessment) : null,
    selfRating: num(r?.self_rating),
    selfSubmittedAt: iso(r?.self_submitted_at),
    managerEmployeeId: r?.manager_employee_id ? String(r.manager_employee_id) : null,
    managerName: r?.manager_name ? String(r.manager_name) : null,
    managerSubmittedAt: iso(r?.manager_submitted_at),
    overallRating: num(r?.overall_rating),
    goalsScore: num(r?.goals_score),
    skillsScore: num(r?.skills_score),
    attitudeScore: num(r?.attitude_score),
    strengths: r?.strengths ? String(r.strengths) : null,
    improvements: r?.improvements ? String(r.improvements) : null,
    goalsNext: r?.goals_next ? String(r.goals_next) : null,
    reviewerComments: r?.reviewer_comments ? String(r.reviewer_comments) : null,
    calibratedRating: num(r?.calibrated_rating),
    calibrationNote: r?.calibration_note ? String(r.calibration_note) : null,
    calibratedAt: iso(r?.calibrated_at),
    outcome: r?.outcome ? String(r.outcome) : null,
    outcomeNote: r?.outcome_note ? String(r.outcome_note) : null,
    sharedWithEmployeeAt: iso(r?.shared_with_employee_at),
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    proposedDesignation: r?.proposed_designation ? String(r.proposed_designation) : null,
    promotionJustification: r?.promotion_justification ? String(r.promotion_justification) : null,
    promotionWorkflowId: r?.promotion_workflow_id ? String(r.promotion_workflow_id) : null,
  };
}

function mapFeedback(r: any): FeedbackNote {
  return {
    id: String(r?.id ?? ''),
    kind: String(r?.kind ?? 'continuous'),
    subjectEmployeeId: String(r?.subject_employee_id ?? ''),
    subjectName: r?.subject_name ? String(r.subject_name) : null,
    authorUserId: r?.author_user_id ? String(r.author_user_id) : null,
    authorName: r?.author_name ? String(r.author_name) : 'A colleague',
    cycleId: r?.cycle_id ? String(r.cycle_id) : null,
    theme: String(r?.theme ?? 'general'),
    body: r?.body ? String(r.body) : '',
    visibleToManager: r?.visible_to_manager !== false,
    createdAt: iso(r?.created_at),
  };
}

/** The SELECT list every review read shares, so the mapper always gets the same shape. */
const REVIEW_COLS = sql`r.*,
  c.title AS cycle_title,
  COALESCE(c.stage, 'self_assessment') AS cycle_stage,
  e.full_name AS employee_name,
  e.designation AS employee_designation,
  m.full_name AS manager_name`;

const REVIEW_JOINS = sql`
  FROM hr_performance_reviews r
  LEFT JOIN hr_review_cycles c ON c.id = r.cycle_id
  LEFT JOIN hr_employees e ON e.id = r.employee_id
  LEFT JOIN hr_employees m ON m.id = r.manager_employee_id`;

// =================================================================================================
// APPRAISAL CYCLES
// =================================================================================================

/** Every cycle, newest first, with the four counts a console needs. */
export async function listCycles(limit = 40): Promise<ReviewCycle[]> {
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT c.*,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id) AS total,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.self_submitted_at IS NOT NULL) AS self_done,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.manager_submitted_at IS NOT NULL) AS manager_done,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.calibrated_at IS NOT NULL) AS calibrated
        FROM hr_review_cycles c
       ORDER BY c.created_at DESC
       LIMIT ${lim}`));
    return rows.map(mapCycle);
  } catch (e: any) {
    logFail(MOD, 'listCycles', e);
    return [];
  }
}

export async function getCycle(cycleId: string): Promise<ReviewCycle | null> {
  if (!isUuid(cycleId)) return null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT c.*,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id) AS total,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.self_submitted_at IS NOT NULL) AS self_done,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.manager_submitted_at IS NOT NULL) AS manager_done,
             (SELECT COUNT(*)::int FROM hr_performance_reviews r WHERE r.cycle_id = c.id AND r.calibrated_at IS NOT NULL) AS calibrated
        FROM hr_review_cycles c WHERE c.id = ${cycleId}::uuid LIMIT 1`));
    return rows.length ? mapCycle(rows[0]) : null;
  } catch (e: any) {
    logFail(MOD, 'getCycle', e);
    return null;
  }
}

/** The cycle an employee should be looking at: the newest one that is not closed. */
export async function activeCycle(): Promise<ReviewCycle | null> {
  const all = await listCycles(10);
  return all.find((c) => c.status === 'active') || all.find((c) => c.status !== 'closed') || null;
}

export interface CreateCycleInput {
  title: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  reviewType?: string | null;
  selfDueOn?: string | null;
  managerDueOn?: string | null;
  calibrationDueOn?: string | null;
  createdByUserId?: string | null;
}

/**
 * Open a cycle and seed one review row per ACTIVE employee.
 *
 * The seed reproduces exactly what /admin/hr/performance already does, including the
 * ON CONFLICT (cycle_id, employee_id) that the unique constraint in db/hr-schema.sql:409 exists for,
 * so opening a cycle twice produces one set of rows.
 *
 * MANAGER IS CAPTURED PER ROW, FROM THE GRAPH, and it is captured at SEED time rather than resolved
 * at read time. That is deliberate: the person recorded as having reviewed somebody must not change
 * because the company reorganised in March. On an empty graph it is simply NULL, and the screens
 * say "no reporting manager is recorded" rather than inventing one.
 */
export async function createCycle(input: CreateCycleInput): Promise<PerfWriteResult> {
  const title = clean(input?.title, 200);
  if (!title) return { ok: false, error: 'Give the cycle a title.' };
  const start = validDay(input?.periodStart);
  const end = validDay(input?.periodEnd);
  if (!start || !end) return { ok: false, error: 'A cycle needs a start date and an end date.' };
  if (end < start) return { ok: false, error: 'The period ends before it starts.' };
  const type = clean(input?.reviewType, 40) || 'annual';
  const createdBy = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_review_cycles
        (title, period_start, period_end, review_type, status, stage,
         self_due_on, manager_due_on, calibration_due_on, created_by)
      VALUES
        (${title}, ${start}::date, ${end}::date, ${type}, 'draft', 'self_assessment',
         ${validDay(input?.selfDueOn)}::date, ${validDay(input?.managerDueOn)}::date,
         ${validDay(input?.calibrationDueOn)}::date, ${createdBy}::uuid)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    const cycleId = String(rows[0].id);

    await db.execute(sql`
      INSERT INTO hr_performance_reviews (cycle_id, employee_id, status)
      SELECT ${cycleId}::uuid, id, 'pending' FROM hr_employees WHERE is_active = true
      ON CONFLICT (cycle_id, employee_id) DO NOTHING`);

    await captureManagers(cycleId);

    await logAudit({
      userId: createdBy,
      action: 'appraisal.cycle.create',
      entity: 'hr_review_cycles',
      entityId: cycleId,
      diff: { title, start, end, type },
    });
    return { ok: true, id: cycleId };
  } catch (e: any) {
    logFail(MOD, 'createCycle', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Fill in manager_employee_id for every review in a cycle that has none, FROM THE GRAPH.
 *
 * One getManager() call per employee, which is bounded by headcount and only ever runs on rows that
 * are still blank. Exposed so the console can re-run it after the founder backfills the graph: a
 * cycle opened before the backfill has no managers on it, and that is fixable rather than fatal.
 */
export async function captureManagers(cycleId: string): Promise<{ filled: number }> {
  if (!isUuid(cycleId)) return { filled: 0 };
  let filled = 0;
  try {
    await ensurePerformanceSchema();
    const pending = rowsOf(await db.execute(sql`
      SELECT id, employee_id FROM hr_performance_reviews
       WHERE cycle_id = ${cycleId}::uuid AND manager_employee_id IS NULL
       LIMIT 1000`));
    for (const row of pending) {
      const employeeId = String(row?.employee_id || '');
      if (!isUuid(employeeId)) continue;
      const manager = await getManager(employeeId);
      if (!manager?.employeeId) continue; // no manager recorded is an ANSWER, not a reason to guess
      await db.execute(sql`
        UPDATE hr_performance_reviews
           SET manager_employee_id = ${manager.employeeId}::uuid, updated_at = NOW()
         WHERE id = ${String(row.id)}::uuid AND manager_employee_id IS NULL`);
      filled += 1;
    }
  } catch (e: any) {
    logFail(MOD, 'captureManagers', e);
  }
  return { filled };
}

/** Move a cycle's stage forward. Backwards is refused, and the refusal says why. */
export async function advanceStage(
  cycleId: string,
  stage: CycleStage,
  actorUserId?: string | null,
): Promise<PerfWriteResult> {
  if (!isUuid(cycleId)) return { ok: false, error: 'That cycle does not exist.' };
  if ((CYCLE_STAGES as readonly string[]).indexOf(stage) < 0) {
    return { ok: false, error: 'That is not a stage we track.' };
  }
  try {
    await ensurePerformanceSchema();
    const current = await getCycle(cycleId);
    if (!current) return { ok: false, error: 'That cycle does not exist.' };
    if (current.stage === stage) return { ok: true, id: cycleId };
    if ((STAGE_ORDER[stage] ?? 0) < (STAGE_ORDER[current.stage] ?? 0)) {
      return {
        ok: false,
        error: 'A cycle only moves forward. It is already at ' + (CYCLE_STAGE_LABELS[current.stage] || current.stage) + '.',
      };
    }
    // Moving a cycle out of draft is what makes it visible to employees, so the two travel together.
    const nextStatus = stage === 'complete' ? 'closed' : 'active';
    await db.execute(sql`
      UPDATE hr_review_cycles SET stage = ${stage}, status = ${nextStatus} WHERE id = ${cycleId}::uuid`);
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'appraisal.cycle.stage',
      entity: 'hr_review_cycles',
      entityId: cycleId,
      diff: { from: current.stage, to: stage, status: nextStatus },
    });
    return { ok: true, id: cycleId };
  } catch (e: any) {
    logFail(MOD, 'advanceStage', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// =================================================================================================
// REVIEWS
// =================================================================================================

/** One employee's review in one cycle, or null. Authorization is the caller's — see reviewFor(). */
export async function getReview(reviewId: string): Promise<PerformanceReview | null> {
  if (!isUuid(reviewId)) return null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${REVIEW_COLS} ${REVIEW_JOINS} WHERE r.id = ${reviewId}::uuid LIMIT 1`));
    return rows.length ? mapReview(rows[0]) : null;
  } catch (e: any) {
    logFail(MOD, 'getReview', e);
    return null;
  }
}

/** One review, only if this viewer may see it. Null covers "does not exist" and "not yours" alike. */
export async function reviewFor(viewer: PerfViewer, reviewId: string): Promise<PerformanceReview | null> {
  const review = await getReview(reviewId);
  if (!review) return null;
  return (await canSeePerformanceOf(viewer, review.employeeId)) ? review : null;
}

/** The employee's own review in a cycle. */
export async function myReview(cycleId: string, employeeId: string): Promise<PerformanceReview | null> {
  if (!isUuid(cycleId) || !isUuid(employeeId)) return null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${REVIEW_COLS} ${REVIEW_JOINS}
       WHERE r.cycle_id = ${cycleId}::uuid AND r.employee_id = ${employeeId}::uuid LIMIT 1`));
    return rows.length ? mapReview(rows[0]) : null;
  } catch (e: any) {
    logFail(MOD, 'myReview', e);
    return null;
  }
}

/** Every review in a cycle. `performance.manage` territory — the caller checks. */
export async function reviewsInCycle(
  cycleId: string,
  opts: { departmentId?: string | null; limit?: number } = {},
): Promise<PerformanceReview[]> {
  if (!isUuid(cycleId)) return [];
  const lim = Math.min(Math.max(Number(opts.limit) || 300, 1), 800);
  try {
    await ensurePerformanceSchema();
    // ::text on BOTH sides. departments.id is a slug in one schema file and a uuid in the other, so
    // a ::uuid cast throws the first time a slug arrives.
    const dept = opts.departmentId ? String(opts.departmentId).trim() : '';
    const deptFilter = dept ? sql`AND e.department_id::text = ${dept}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT ${REVIEW_COLS} ${REVIEW_JOINS}
       WHERE r.cycle_id = ${cycleId}::uuid ${deptFilter}
       ORDER BY e.full_name ASC
       LIMIT ${lim}`));
    return rows.map(mapReview);
  } catch (e: any) {
    logFail(MOD, 'reviewsInCycle', e);
    return [];
  }
}

/**
 * The reviews THIS MANAGER owes, resolved from the Organization Graph.
 *
 * The manager is matched on manager_employee_id — the value captured from the graph when the cycle
 * opened — OR on the viewer's live direct reports, so a review seeded before the backfill still
 * reaches the right person once the graph is populated.
 *
 * Empty on an empty graph, and the caller must say WHY it is empty using viewer.initialized. "You
 * have no reviews to write" and "the org graph has no data" are different sentences.
 */
export async function reviewsIOwe(viewer: PerfViewer, cycleId?: string | null): Promise<PerformanceReview[]> {
  if (!viewer.employeeId) return [];
  const ids = viewer.reportIds.filter(isUuid);
  try {
    await ensurePerformanceSchema();
    const reportsClause = ids.length ? sql`OR r.employee_id IN (${uuidList(ids)})` : sql``;
    const cycleFilter = isUuid(cycleId) ? sql`AND r.cycle_id = ${String(cycleId)}::uuid` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT ${REVIEW_COLS} ${REVIEW_JOINS}
       WHERE (r.manager_employee_id = ${viewer.employeeId}::uuid ${reportsClause})
         AND r.employee_id <> ${viewer.employeeId}::uuid
         AND COALESCE(c.status, 'draft') <> 'draft'
         ${cycleFilter}
       ORDER BY (r.manager_submitted_at IS NULL) DESC, e.full_name ASC
       LIMIT 200`));
    return rows.map(mapReview);
  } catch (e: any) {
    logFail(MOD, 'reviewsIOwe', e);
    return [];
  }
}

/** An employee's own appraisal history, newest cycle first. */
export async function reviewHistory(employeeId: string, limit = 12): Promise<PerformanceReview[]> {
  if (!isUuid(employeeId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${REVIEW_COLS} ${REVIEW_JOINS}
       WHERE r.employee_id = ${employeeId}::uuid
       ORDER BY c.period_end DESC NULLS LAST, r.created_at DESC
       LIMIT ${lim}`));
    return rows.map(mapReview);
  } catch (e: any) {
    logFail(MOD, 'reviewHistory', e);
    return [];
  }
}

/**
 * The employee's own half. Only they can write it, which the caller enforces by passing their own
 * employee id; this function re-checks it against the row so a forged review id cannot reach
 * somebody else's self-assessment.
 */
export async function saveSelfAssessment(
  reviewId: string,
  employeeId: string,
  input: { text: string; rating?: number | null; submit?: boolean; actorUserId?: string | null },
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId) || !isUuid(employeeId)) return { ok: false, error: 'That review does not exist.' };
  const text = clean(input?.text, 8000);
  if (input?.submit && !text) return { ok: false, error: 'Write something before you submit it.' };
  const rating = ratingOrNull(input?.rating);
  const submit = input?.submit === true;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_performance_reviews
         SET self_assessment = ${text || null}::text,
             self_rating = ${rating}::numeric,
             self_submitted_at = CASE WHEN ${submit} THEN COALESCE(self_submitted_at, NOW()) ELSE self_submitted_at END,
             status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
             updated_at = NOW()
       WHERE id = ${reviewId}::uuid
         AND employee_id = ${employeeId}::uuid
         -- A submitted self-assessment is evidence. Editing it after submission would let somebody
         -- rewrite what their manager already read.
         AND self_submitted_at IS NULL
      RETURNING id`));
    if (!rows.length) {
      return { ok: false, error: 'That self-assessment has already been submitted, or it is not yours.' };
    }
    await logAudit({
      userId: isUuid(input?.actorUserId) ? String(input.actorUserId) : null,
      action: submit ? 'appraisal.self.submit' : 'appraisal.self.save',
      entity: 'hr_performance_reviews',
      entityId: reviewId,
      diff: { submitted: submit, rating },
    });
    return { ok: true, id: reviewId };
  } catch (e: any) {
    logFail(MOD, 'saveSelfAssessment', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export interface ManagerReviewInput {
  overallRating?: number | null;
  goalsScore?: number | null;
  skillsScore?: number | null;
  attitudeScore?: number | null;
  strengths?: string | null;
  improvements?: string | null;
  goalsNext?: string | null;
  comments?: string | null;
  submit?: boolean;
  actorUserId?: string | null;
}

/**
 * The manager's half.
 *
 * AUTHORIZATION IS A RELATIONSHIP AND IT IS CHECKED HERE, not only on the page: canSeePerformanceOf
 * defers to the Organization Graph, so the person writing this review is somebody the graph says
 * answers for that employee's work. Nobody reviews themselves — the check is explicit.
 */
export async function saveManagerReview(
  reviewId: string,
  viewer: PerfViewer,
  input: ManagerReviewInput,
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId)) return { ok: false, error: 'That review does not exist.' };
  const review = await getReview(reviewId);
  if (!review) return { ok: false, error: 'That review does not exist.' };
  if (viewer.employeeId && viewer.employeeId === review.employeeId) {
    return { ok: false, error: 'You cannot write your own manager review.' };
  }
  if (!(await canSeePerformanceOf(viewer, review.employeeId))) {
    return {
      ok: false,
      error: viewer.initialized
        ? 'The Organization Graph does not record you as answering for this person\'s work.'
        : 'The Organization Graph has not been set up yet, so no reporting line can be confirmed. '
          + 'A review cannot be written against a relationship that is not on record.',
    };
  }

  const submit = input?.submit === true;
  const overall = ratingOrNull(input?.overallRating);
  if (submit && overall === null) {
    return { ok: false, error: 'Give an overall rating between ' + RATING_MIN + ' and ' + RATING_MAX + ' before submitting.' };
  }

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_performance_reviews
         SET overall_rating = ${overall}::numeric,
             goals_score = ${ratingOrNull(input?.goalsScore)}::numeric,
             skills_score = ${ratingOrNull(input?.skillsScore)}::numeric,
             attitude_score = ${ratingOrNull(input?.attitudeScore)}::numeric,
             strengths = ${clean(input?.strengths, 4000) || null}::text,
             improvements = ${clean(input?.improvements, 4000) || null}::text,
             goals_next = ${clean(input?.goalsNext, 4000) || null}::text,
             reviewer_comments = ${clean(input?.comments, 4000) || null}::text,
             manager_employee_id = COALESCE(manager_employee_id, ${viewer.employeeId}::uuid),
             manager_submitted_at = CASE WHEN ${submit} THEN COALESCE(manager_submitted_at, NOW()) ELSE manager_submitted_at END,
             status = ${submit ? 'submitted' : 'in_progress'},
             submitted_at = CASE WHEN ${submit} THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
             updated_at = NOW()
       WHERE id = ${reviewId}::uuid
         AND manager_submitted_at IS NULL
      RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That review has already been submitted.' };
    await logAudit({
      userId: isUuid(input?.actorUserId) ? String(input.actorUserId) : viewer.userId,
      action: submit ? 'appraisal.manager.submit' : 'appraisal.manager.save',
      entity: 'hr_performance_reviews',
      entityId: reviewId,
      diff: { employeeId: review.employeeId, submitted: submit, overall },
    });
    return { ok: true, id: reviewId };
  } catch (e: any) {
    logFail(MOD, 'saveManagerReview', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * CALIBRATION — a second number beside the manager's, never on top of it.
 *
 * overall_rating is left exactly as the manager wrote it. An employee who disputes an outcome must
 * be able to see both what their manager said and what calibration changed it to; overwriting would
 * destroy the first half and make the record unarguable in the wrong direction.
 */
export async function calibrate(
  reviewId: string,
  input: { rating: number; note?: string | null; actorUserId?: string | null },
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId)) return { ok: false, error: 'That review does not exist.' };
  const rating = ratingOrNull(input?.rating);
  if (rating === null) {
    return { ok: false, error: 'A calibrated rating is a number between ' + RATING_MIN + ' and ' + RATING_MAX + '.' };
  }
  const note = clean(input?.note, 2000) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_performance_reviews
         SET calibrated_rating = ${rating}::numeric,
             calibration_note = ${note}::text,
             calibrated_by_user_id = ${actor}::uuid,
             calibrated_at = NOW(),
             updated_at = NOW()
       WHERE id = ${reviewId}::uuid
         AND manager_submitted_at IS NOT NULL
      RETURNING id, employee_id`));
    if (!rows.length) {
      return { ok: false, error: 'A review can only be calibrated after the manager has submitted it.' };
    }
    await logAudit({
      userId: actor,
      action: 'appraisal.calibrate',
      entity: 'hr_performance_reviews',
      entityId: reviewId,
      diff: { employeeId: String(rows[0].employee_id), calibratedRating: rating, note },
    });
    return { ok: true, id: reviewId };
  } catch (e: any) {
    logFail(MOD, 'calibrate', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** The distribution a calibration screen is for: how many people at each whole rating. */
export async function ratingDistribution(cycleId: string): Promise<{ rating: number; count: number }[]> {
  if (!isUuid(cycleId)) return [];
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT ROUND(COALESCE(calibrated_rating, overall_rating))::int AS rating, COUNT(*)::int AS n
        FROM hr_performance_reviews
       WHERE cycle_id = ${cycleId}::uuid
         AND COALESCE(calibrated_rating, overall_rating) IS NOT NULL
       GROUP BY 1
       ORDER BY 1 ASC`));
    return rows.map((r: any) => ({ rating: Number(r.rating) || 0, count: Number(r.n) || 0 }));
  } catch (e: any) {
    logFail(MOD, 'ratingDistribution', e);
    return [];
  }
}

/** Record the outcome and share the review with the employee. */
export async function recordOutcome(
  reviewId: string,
  input: { outcome: string; note?: string | null; actorUserId?: string | null },
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId)) return { ok: false, error: 'That review does not exist.' };
  const outcome = String(input?.outcome || '');
  if ((REVIEW_OUTCOMES as readonly string[]).indexOf(outcome) < 0) {
    return { ok: false, error: 'That is not an outcome we record.' };
  }
  const note = clean(input?.note, 4000) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_performance_reviews
         SET outcome = ${outcome},
             outcome_note = ${note}::text,
             shared_with_employee_at = COALESCE(shared_with_employee_at, NOW()),
             updated_at = NOW()
       WHERE id = ${reviewId}::uuid
         AND manager_submitted_at IS NOT NULL
      RETURNING id, employee_id`));
    if (!rows.length) {
      return { ok: false, error: 'An outcome can only be recorded after the manager has submitted the review.' };
    }
    const employeeId = String(rows[0].employee_id);
    await notifyEmployee(employeeId, {
      title: 'Your appraisal outcome has been shared',
      body: REVIEW_OUTCOME_LABELS[outcome] || outcome,
      actionUrl: '/portal/employee/performance?view=appraisal',
      entityId: reviewId,
    });
    await logAudit({
      userId: actor,
      action: 'appraisal.outcome',
      entity: 'hr_performance_reviews',
      entityId: reviewId,
      diff: { employeeId, outcome },
    });
    return { ok: true, id: reviewId };
  } catch (e: any) {
    logFail(MOD, 'recordOutcome', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * SEND A COMPLETED REVIEW FOR SIGN-OFF — through the one approval engine.
 *
 * The chain is declared in workflow.ts DOMAINS.appraisal: department head first (the manager wrote
 * the review, so routing back to them would be a rubber stamp), then the appraisal approval owner if
 * the organisation has named one.
 *
 * WHEN ROUTING CANNOT NAME ANYBODY THE WORKFLOW HALTS, and this function reports the halt reason
 * VERBATIM instead of treating it as success. It never approves, and it never falls back to a role
 * name — doing either would silently undo the authorization migration.
 */
export async function submitForSignoff(
  reviewId: string,
  actorUserId: string | null,
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId)) return { ok: false, error: 'That review does not exist.' };
  const review = await getReview(reviewId);
  if (!review) return { ok: false, error: 'That review does not exist.' };
  if (!review.managerSubmittedAt) {
    return { ok: false, error: 'Submit the manager review before sending it for sign-off.' };
  }

  const started = await startWorkflow({
    domain: 'appraisal',
    recordId: reviewId,
    subjectEmployeeId: review.employeeId,
    requestedByUserId: actorUserId,
    createdByUserId: actorUserId,
    summary: 'Appraisal sign-off for ' + (review.employeeName || 'an employee')
      + (review.cycleTitle ? ' — ' + review.cycleTitle : ''),
  });
  if (!started.ok) return { ok: false, error: started.error || WRITE_FAILED };

  try {
    await db.execute(sql`
      UPDATE hr_performance_reviews
         SET workflow_instance_id = ${started.instanceId || null}::uuid, updated_at = NOW()
       WHERE id = ${reviewId}::uuid`);
  } catch (e: any) {
    // NEVER SWALLOWED. The workflow instance genuinely exists at this point, so the honest report is
    // "it was sent, we could not link it here" rather than a bare success or a bare failure.
    logFail(MOD, 'submitForSignoff.link', e);
    return {
      ok: true,
      id: started.instanceId,
      haltReason: started.haltReason || null,
      error: 'The sign-off was started but we could not attach it to this review. Reload before sending it again.',
    };
  }

  await logAudit({
    userId: actorUserId,
    action: 'appraisal.signoff.start',
    entity: 'hr_performance_reviews',
    entityId: reviewId,
    diff: { instanceId: started.instanceId, state: started.state, haltReason: started.haltReason || null },
  });
  return { ok: true, id: started.instanceId, haltReason: started.haltReason || null };
}

/** The workflow instance behind a review, for a screen that wants to show where it is. */
export async function signoffState(review: PerformanceReview): Promise<WorkflowInstanceRow | null> {
  if (review.workflowInstanceId && isUuid(review.workflowInstanceId)) {
    return getInstance(review.workflowInstanceId);
  }
  return instanceForRecord('appraisal', review.id);
}

// =================================================================================================
// PROMOTION RECOMMENDATION — A WORKFLOW, NEVER A DIRECT WRITE
// =================================================================================================

/**
 * Recommend somebody for promotion off the back of an appraisal.
 *
 * NOTHING HERE CHANGES WHAT ANYBODY IS. hr_employees.designation is not touched, and it must not be:
 * a recommendation is a request for a decision, and the decision belongs to the `promotion` approval
 * chain that the employee-lifecycle console owns (workflow.ts DOMAINS.promotion — reporting manager,
 * then department head, then the approval owner if one is named). This module reuses that chain
 * rather than declaring a second one, and namespaces its record id so the two can never collide on
 * workflow_instances' (domain, record_id) uniqueness.
 *
 * A HALT IS REPORTED, NOT HIDDEN. If the graph names no approver the instance is created in 'halted'
 * with a readable sentence, the recommendation keeps that sentence, and the screen prints it.
 */
export async function recommendPromotion(
  reviewId: string,
  viewer: PerfViewer,
  input: { proposedDesignation: string; justification: string },
): Promise<PerfWriteResult> {
  if (!isUuid(reviewId)) return { ok: false, error: 'That review does not exist.' };
  const proposed = clean(input?.proposedDesignation, 200);
  const why = clean(input?.justification, 4000);
  if (!proposed) return { ok: false, error: 'Name the designation you are recommending.' };
  if (!why) return { ok: false, error: 'A promotion recommendation needs a written justification.' };

  const review = await getReview(reviewId);
  if (!review) return { ok: false, error: 'That review does not exist.' };
  if (viewer.employeeId && viewer.employeeId === review.employeeId) {
    return { ok: false, error: 'You cannot recommend yourself for promotion.' };
  }
  if (!(await canSeePerformanceOf(viewer, review.employeeId))) {
    return {
      ok: false,
      error: viewer.initialized
        ? 'The Organization Graph does not record you as answering for this person\'s work.'
        : 'The Organization Graph has not been set up yet, so no reporting line can be confirmed.',
    };
  }
  if (review.promotionWorkflowId) {
    return { ok: false, error: 'A promotion recommendation has already been raised for this review.' };
  }

  const started = await startWorkflow({
    domain: 'promotion',
    recordId: PROMOTION_RECORD_PREFIX + reviewId,
    subjectEmployeeId: review.employeeId,
    requestedByUserId: viewer.userId,
    createdByUserId: viewer.userId,
    summary: 'Promotion recommended for ' + (review.employeeName || 'an employee') + ': ' + proposed,
  });
  if (!started.ok) return { ok: false, error: started.error || WRITE_FAILED };

  try {
    await db.execute(sql`
      UPDATE hr_performance_reviews
         SET proposed_designation = ${proposed},
             promotion_justification = ${why},
             promotion_workflow_id = ${started.instanceId || null}::uuid,
             outcome = COALESCE(outcome, 'promotion_recommended'),
             updated_at = NOW()
       WHERE id = ${reviewId}::uuid`);
  } catch (e: any) {
    logFail(MOD, 'recommendPromotion.link', e);
    return {
      ok: true,
      id: started.instanceId,
      haltReason: started.haltReason || null,
      error: 'The recommendation was sent for approval but we could not attach it to this review.',
    };
  }

  await logAudit({
    userId: viewer.userId,
    action: 'appraisal.promotion.recommend',
    entity: 'hr_performance_reviews',
    entityId: reviewId,
    diff: {
      employeeId: review.employeeId,
      proposedDesignation: proposed,
      instanceId: started.instanceId,
      state: started.state,
      haltReason: started.haltReason || null,
    },
  });
  return { ok: true, id: started.instanceId, haltReason: started.haltReason || null };
}

/** Where a promotion recommendation has got to. */
export async function promotionState(review: PerformanceReview): Promise<WorkflowInstanceRow | null> {
  if (review.promotionWorkflowId && isUuid(review.promotionWorkflowId)) {
    return getInstance(review.promotionWorkflowId);
  }
  if (!review.id) return null;
  return instanceForRecord('promotion', PROMOTION_RECORD_PREFIX + review.id);
}

// =================================================================================================
// CONTINUOUS AND 360 FEEDBACK
// =================================================================================================

export interface GiveFeedbackInput {
  subjectEmployeeId: string;
  authorUserId: string;
  authorEmployeeId?: string | null;
  authorName?: string | null;
  body: string;
  theme?: string;
  /** Set for 360 feedback. The cycle it belongs to; null for an everyday note. */
  cycleId?: string | null;
}

/**
 * Leave feedback for a colleague.
 *
 * ANY-TO-ANY WITHIN THE ORGANIZATION, which is the whole point of continuous feedback — needing a
 * relationship to say "that went well" would kill it. So the only gate is that both people are
 * employees, and that nobody writes feedback about themselves.
 *
 * IT IS NEVER ANONYMOUS. The author is recorded and shown. Anonymous feedback about a named
 * individual, readable by their manager, is a tool for something other than feedback, and this
 * product does not build it.
 */
export async function giveFeedback(input: GiveFeedbackInput): Promise<PerfWriteResult> {
  const subject = String(input?.subjectEmployeeId || '');
  if (!isUuid(subject)) return { ok: false, error: 'Choose who the feedback is for.' };
  const author = String(input?.authorUserId || '');
  if (!isUuid(author)) return { ok: false, error: 'Sign in to leave feedback.' };
  if (input?.authorEmployeeId && String(input.authorEmployeeId) === subject) {
    return { ok: false, error: 'Feedback is for somebody else. Use your self-assessment for your own.' };
  }
  const body = clean(input?.body, 4000);
  if (!body) return { ok: false, error: 'Write the feedback before sending it.' };
  const theme = (FEEDBACK_THEMES as readonly string[]).indexOf(String(input?.theme || 'general')) >= 0
    ? String(input?.theme || 'general')
    : 'general';
  const cycleId = isUuid(input?.cycleId) ? String(input.cycleId) : null;
  const kind = cycleId ? '360' : 'continuous';
  const authorEmployeeId = isUuid(input?.authorEmployeeId) ? String(input.authorEmployeeId) : null;
  const authorName = clean(input?.authorName, 200) || null;

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_feedback
        (kind, subject_employee_id, author_user_id, author_employee_id, author_name, cycle_id, theme, body)
      VALUES
        (${kind}, ${subject}::uuid, ${author}::uuid, ${authorEmployeeId}::uuid, ${authorName}::text,
         ${cycleId}::uuid, ${theme}, ${body})
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await notifyEmployee(subject, {
      title: kind === '360' ? 'New review feedback for you' : 'New feedback for you',
      body: (authorName ? authorName + ' left you a note.' : 'A colleague left you a note.'),
      actionUrl: '/portal/employee/performance?view=feedback',
      entityId: String(rows[0].id),
    });
    await logAudit({
      userId: author,
      action: kind === '360' ? 'feedback.360.give' : 'feedback.give',
      entity: 'hr_feedback',
      entityId: String(rows[0].id),
      diff: { subjectEmployeeId: subject, theme, cycleId },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'giveFeedback', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Feedback about one person.
 *
 * `asManager` is FALSE by default and the caller must opt in, because the recipient sees everything
 * and a manager sees only what was left visible to them. Defaulting the wrong way would show a
 * manager a note somebody marked private the first time an argument was forgotten.
 */
export async function feedbackFor(
  employeeId: string,
  opts: { asManager?: boolean; cycleId?: string | null; kind?: string; limit?: number } = {},
): Promise<FeedbackNote[]> {
  if (!isUuid(employeeId)) return [];
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  try {
    await ensurePerformanceSchema();
    const managerFilter = opts.asManager === true ? sql`AND f.visible_to_manager = true` : sql``;
    const cycleFilter = isUuid(opts.cycleId) ? sql`AND f.cycle_id = ${String(opts.cycleId)}::uuid` : sql``;
    const kindFilter = opts.kind ? sql`AND f.kind = ${String(opts.kind)}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT f.*, e.full_name AS subject_name
        FROM hr_feedback f
        LEFT JOIN hr_employees e ON e.id = f.subject_employee_id
       WHERE f.subject_employee_id = ${employeeId}::uuid
         ${managerFilter} ${cycleFilter} ${kindFilter}
       ORDER BY f.created_at DESC
       LIMIT ${lim}`));
    return rows.map(mapFeedback);
  } catch (e: any) {
    logFail(MOD, 'feedbackFor', e);
    return [];
  }
}

/** What this person has written about others, so they can see their own trail. */
export async function feedbackIGave(userId: string, limit = 30): Promise<FeedbackNote[]> {
  if (!isUuid(userId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT f.*, e.full_name AS subject_name
        FROM hr_feedback f
        LEFT JOIN hr_employees e ON e.id = f.subject_employee_id
       WHERE f.author_user_id = ${userId}::uuid
       ORDER BY f.created_at DESC
       LIMIT ${lim}`));
    return rows.map(mapFeedback);
  } catch (e: any) {
    logFail(MOD, 'feedbackIGave', e);
    return [];
  }
}

/**
 * WHO REVIEWS THIS PERSON — the 360 panel, resolved from the Organization Graph's `reviewer` edge
 * and from nowhere else. Empty on an empty graph, which the caller reports as "no reviewers are
 * recorded" only when viewer.initialized is true.
 */
export async function reviewPanelFor(employeeId: string, cycleId?: string | null) {
  if (!isUuid(employeeId)) return [];
  return getReviewers(employeeId, { scopeId: isUuid(cycleId) ? String(cycleId) : null });
}

/**
 * Colleagues this person may pick when leaving everyday feedback.
 *
 * DELIBERATELY NOT THE WHOLE COMPANY. It is the people already in reach through the graph — their
 * manager, their reports, whoever they review — plus, for a `performance.manage` holder, everybody.
 * A free-text search over every active employee is a different feature with a different privacy
 * question, and inventing it here would put the whole staff directory behind a feedback box.
 */
export async function feedbackRecipients(viewer: PerfViewer): Promise<{ id: string; name: string; designation: string | null }[]> {
  try {
    await ensurePerformanceSchema();
    const ids = visibleEmployeeIds(viewer);
    let rows: any[] = [];
    if (ids === null) {
      rows = rowsOf(await db.execute(sql`
        SELECT id, full_name, designation FROM hr_employees
         WHERE is_active = true ORDER BY full_name ASC LIMIT 500`));
    } else {
      const others = ids.filter((id) => id !== viewer.employeeId);
      // The reporting chain upward: somebody must be able to give their own manager feedback, and a
      // direct-reports list alone points only downward.
      const managerIds: string[] = [];
      if (viewer.employeeId) {
        const mgr = await getManager(viewer.employeeId);
        if (mgr?.employeeId) managerIds.push(String(mgr.employeeId));
      }
      const all = Array.from(new Set([...others, ...managerIds])).filter(isUuid);
      if (all.length === 0) return [];
      rows = rowsOf(await db.execute(sql`
        SELECT id, full_name, designation FROM hr_employees
         WHERE id IN (${uuidList(all)}) AND is_active = true
         ORDER BY full_name ASC LIMIT 200`));
    }
    return rows.map((r: any) => ({
      id: String(r.id),
      name: r.full_name ? String(r.full_name) : 'Unnamed record',
      designation: r.designation ? String(r.designation) : null,
    }));
  } catch (e: any) {
    logFail(MOD, 'feedbackRecipients', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// SMALL HELPERS
// -------------------------------------------------------------------------------------------------

function ratingOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  if (n < RATING_MIN || n > RATING_MAX) return null;
  return Math.round(n * 100) / 100;
}

function validDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

/**
 * Tell an employee something, through the ONE notification system.
 *
 * hr_employees.user_id is resolved here rather than passed in, because a notification keyed on the
 * wrong id space silently reaches nobody — the id-space trap the org graph's header warns about.
 * A missing user_id is an ordinary case (a record HR created before the account existed) and is
 * skipped rather than treated as an error.
 */
async function notifyEmployee(
  employeeId: string,
  opts: { title: string; body?: string; actionUrl?: string; entityId?: string },
): Promise<void> {
  if (!isUuid(employeeId)) return;
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    const userId = rows.length && rows[0]?.user_id ? String(rows[0].user_id) : '';
    if (!isUuid(userId)) return;
    await notifyUser(userId, {
      title: opts.title,
      body: opts.body,
      type: 'info',
      actionUrl: opts.actionUrl,
      entityType: 'performance',
      entityId: opts.entityId,
    });
  } catch (e: any) {
    logFail(MOD, 'notifyEmployee', e);
  }
}
