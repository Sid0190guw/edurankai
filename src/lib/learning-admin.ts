// src/lib/learning-admin.ts — LEARNING ADMINISTRATION, AND THE ONE PLACE THE TWO PLAYERS ARE
// RECONCILED.
//
// =================================================================================================
// THIS IS NOT A THIRD LEARNING SYSTEM. IT IS THE JOIN THAT WAS MISSING.
// =================================================================================================
//
// There is ONE catalogue already: training_courses / training_modules / training_lessons, behind
// /admin/hr/training, /admin/courses, /admin/aquintutor/courses, /aquintutor/admin/courses,
// /portal/courses, /aquintutor/courses AND the HR learning path. Nothing here creates a course
// table, an enrolment table or a certificate ledger, and nothing here may.
//
// What was split was everything DOWNSTREAM of that catalogue, in three places:
//
//   (1) PROGRESS. Two players count two different tables into ONE column.
//         portal/courses/[slug].astro      counts training_progress (enrollment_id, lesson_id)
//         api/aquintutor/lesson-complete.ts counts training_lesson_completions (user_id, lesson_id)
//       Both write training_enrollments.progress_pct and neither reads the other first, so finishing
//       four of five lessons in one player and one lesson in the other rewrites 80% to 20%.
//       unifiedProgress() below counts the UNION of BOTH (and of training_lesson_progress, which
//       aquintutor-authoring.ts already unions in isLessonComplete), so the figure stops depending on
//       which door somebody walked through.
//
//   (2) COMPLETION. training_enrollments.completed_at is READ by performance-learning.ts and by
//       /portal/courses — and WRITTEN BY NOTHING in this repository. An employee could reach 100%
//       and render "in progress" forever, and the overdue filter never stopped chasing them.
//       recomputeEnrolment() writes it, from a rule an administrator can see and change.
//
//   (3) CERTIFICATES. course_certificates (hash-chained, src/lib/certificates.ts) and
//       training_certificates (raw) both exist; the employee learning surface reads only the first.
//       This module issues ONLY through certificates.ts — the ledger keeps one writer — and records
//       a withdrawal as a LATER FACT rather than a deletion, because deleting a block would break
//       the chain for every certificate issued after it.
//
// WHAT THIS MODULE ADDS TO THE DATABASE is additive and never destructive: three small tables that
// hold administration decisions (a completion rule, a manual completion or revocation, a certificate
// action) and two nullable columns on training_courses so a course can be ARCHIVED instead of
// DELETED. No DROP, no data migration, no change to any existing column's meaning.
//
// AUTHORIZATION IS NOT DECIDED HERE. Every function takes the actor as data. The pages ask
// src/lib/auth/permissions.ts with can() and resolve department scope from src/lib/org-graph.ts, per
// row. There is no role-name test in this file and there must never be one.
//
// EduRankAI is the technology platform; accredited partners award credentials. A completion recorded
// here is a record of work done on this platform. It is not a qualification and no string in this
// module says it is.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { ensureOnce } from '@/lib/ensure-once';
import { issueCertificate } from '@/lib/certificates';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { assignCourse } from '@/lib/performance-learning';
import { rowsOf, isUuid, clean, logFail, type PerfViewer } from '@/lib/performance-scope';
import { userHeadedDepartmentIds } from '@/lib/org-graph';
import { civilToday } from '@/lib/page-safety';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one of them declared ABOVE the functions that read them. `const` is not
// hoisted, and a const read before its declaration has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

const MOD = 'learning-admin';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';
const REASON_REQUIRED =
  'Write down why. A change to somebody’s record of achievement is not recorded without a reason.';

/** How many people one cohort assignment may reach in a single press. */
export const COHORT_CAP = 500;

/** The capability names, spelled once. An invented key answers false for everybody, silently. */
export const LEARNING_PROGRESS_VIEW = 'learning.progress.view';
export const LEARNING_COMPLETION_OVERRIDE = 'learning.completion.override';
export const LEARNING_CERTIFICATE_MANAGE = 'learning.certificate.manage';
export const LEARNING_RULES_MANAGE = 'learning.rules.manage';

export const COMPLETION_KINDS = ['lessons_viewed', 'assessment_passed', 'mark_threshold'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

export const COMPLETION_KIND_LABELS: Record<string, string> = {
  lessons_viewed: 'Lessons viewed',
  assessment_passed: 'An assessment passed',
  mark_threshold: 'A mark at or above a threshold',
};

export const COHORT_KINDS = ['department', 'designation', 'employment_type', 'everyone'] as const;
export type CohortKind = (typeof COHORT_KINDS)[number];

export const COHORT_KIND_LABELS: Record<string, string> = {
  department: 'A department',
  designation: 'A role level (designation)',
  employment_type: 'An employment type',
  everyone: 'Everybody with an active employee record',
};

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** A true statement about what happened, for the flash line. Never a claim the write succeeded. */
  info?: string;
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isoDay(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function validDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, additive, inside an ensureOnce guard. Never DROP, never ALTER a column
// that already means something.
//
// Each statement runs in its own try so that one refusal (an ALTER on a table this database user
// cannot own, say) does not abandon the rest — and every refusal is LOGGED with the real Postgres
// reason from e.cause, because a silently skipped CREATE is how a console ends up reporting "no
// records" for a table that was never made.
// -------------------------------------------------------------------------------------------------

export function ensureLearningAdminSchema(): Promise<void> {
  return ensureOnce('learning-admin:schema', async () => {
    const ex = async (tag: string, q: any) => {
      try {
        await db.execute(q);
      } catch (e: any) {
        console.error('[' + MOD + '] ensure ' + tag, e?.cause?.message || e?.message);
      }
    };

    // WHAT COUNTS AS COMPLETE, per course. One row per course; absence means the default
    // (every lesson viewed), so a database with no rows here behaves exactly as it does today.
    await ex('rules', sql`CREATE TABLE IF NOT EXISTS learning_completion_rules (
      course_id UUID PRIMARY KEY,
      kind VARCHAR(24) NOT NULL DEFAULT 'lessons_viewed',
      lessons_pct INT NOT NULL DEFAULT 100,
      test_id UUID,
      mark_pct INT,
      updated_by_user_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    // A MANUAL COMPLETION OR A REVOCATION. Append-only: the newest row for a (user, course) is the
    // standing decision, and the ones before it are why. A system that can only ever add is a system
    // nobody trusts with a mistake; a system that can only ever overwrite is one nobody can audit.
    await ex('overrides', sql`CREATE TABLE IF NOT EXISTS learning_completion_overrides (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      course_id UUID NOT NULL,
      employee_id UUID,
      state VARCHAR(12) NOT NULL,
      reason TEXT NOT NULL,
      actor_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex('overrides idx', sql`CREATE INDEX IF NOT EXISTS learning_override_idx
      ON learning_completion_overrides (user_id, course_id, created_at DESC)`);

    // A CERTIFICATE ACTION. A withdrawal is recorded HERE and the certificate row is left alone:
    // course_certificates is a hash chain, and removing a block would invalidate every certificate
    // issued after it, including certificates belonging to people who did nothing wrong.
    await ex('cert actions', sql`CREATE TABLE IF NOT EXISTS learning_certificate_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cert_number VARCHAR(64) NOT NULL,
      ledger VARCHAR(32) NOT NULL DEFAULT 'course_certificates',
      user_id UUID,
      course_id UUID,
      action VARCHAR(16) NOT NULL,
      reason TEXT NOT NULL,
      actor_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex('cert actions idx', sql`CREATE INDEX IF NOT EXISTS learning_cert_action_idx
      ON learning_certificate_actions (cert_number, created_at DESC)`);

    // ARCHIVE WITHOUT DELETING. All four existing course editors offer a hard DELETE and nothing
    // else, so retiring a course destroys the enrolments and completions that point at it.
    await ex('archived_at', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await ex('archived_by', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS archived_by_user_id UUID`);
  });
}

// -------------------------------------------------------------------------------------------------
// SCOPE. Org-wide from a CAPABILITY, a department from the ORGANIZATION GRAPH, per row.
// -------------------------------------------------------------------------------------------------

export interface LearningScope {
  userId: string;
  /** Holds the org-wide capability the caller asked about. */
  orgWide: boolean;
  /** Departments this person HEADS, from org_relationships. Text, never cast to uuid. */
  departmentIds: string[];
  canSeeAnything: boolean;
  explanation: string;
}

/**
 * Resolve what this administrator may look at.
 *
 * `holds` is passed IN — a can(user, key) wrapper from the page — so this module imports no
 * authorization engine and cannot become a second one. The department answer comes from
 * userHeadedDepartmentIds() and from nowhere else: department head is a RELATIONSHIP, not a role
 * name, and resolving it from users.role would hand every "head" every department in the company.
 */
export async function resolveLearningScope(
  userId: string,
  holds: (key: string) => boolean,
  orgWideKey: string = LEARNING_PROGRESS_VIEW,
): Promise<LearningScope> {
  const uid = String(userId || '');
  let orgWide = false;
  try {
    orgWide = holds(orgWideKey) === true;
  } catch {
    orgWide = false; // a holds() that throws is a broken composition, not a grant. Fail closed.
  }

  let departmentIds: string[] = [];
  if (isUuid(uid)) {
    try {
      departmentIds = await userHeadedDepartmentIds(uid);
    } catch (e: any) {
      logFail(MOD, 'resolveLearningScope', e);
      departmentIds = [];
    }
  }

  const canSeeAnything = orgWide || departmentIds.length > 0;
  const explanation = orgWide
    ? 'You can see learning across the organization.'
    : departmentIds.length > 0
      ? 'You can see the ' + departmentIds.length + (departmentIds.length === 1 ? ' department' : ' departments')
        + ' the Organization Graph records you as heading. That scope is read per row, from the graph.'
      : 'The Organization Graph does not record you as heading a department, and you do not hold the '
        + 'organization-wide learning capability, so this shows nothing rather than guessing.';

  return { userId: uid, orgWide, departmentIds, canSeeAnything, explanation };
}

/** The WHERE fragment that applies a scope to a query with hr_employees aliased `e`. */
function scopeFilter(scope: LearningScope) {
  if (scope.orgWide) return sql``;
  if (scope.departmentIds.length === 0) return sql`AND false`;
  const list = scope.departmentIds.map((d) => sql`${d}`);
  let joined = list[0];
  for (let i = 1; i < list.length; i++) joined = sql`${joined}, ${list[i]}`;
  // ::text on both sides — departments.id is a varchar slug in schema.ts and a uuid in hr-schema.sql.
  return sql`AND e.department_id::text IN (${joined})`;
}

/** Is this one employee inside the scope? Asked per row, before any single-person screen renders. */
export async function scopeCoversEmployee(scope: LearningScope, employeeId: string): Promise<boolean> {
  if (scope.orgWide) return true;
  if (!isUuid(employeeId) || scope.departmentIds.length === 0) return false;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT department_id::text AS department_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    if (!r.length) return false;
    const dept = r[0]?.department_id ? String(r[0].department_id) : '';
    return scope.departmentIds.indexOf(dept) >= 0;
  } catch (e: any) {
    logFail(MOD, 'scopeCoversEmployee', e);
    return false; // fail closed
  }
}

// -------------------------------------------------------------------------------------------------
// WHAT COUNTS AS COMPLETE
// -------------------------------------------------------------------------------------------------

export interface CompletionRule {
  courseId: string;
  kind: CompletionKind;
  /** For 'lessons_viewed': the share of the course's lessons that must be done. */
  lessonsPct: number;
  /** For the two assessment kinds: which test in the existing test engine. */
  testId: string | null;
  /** For 'mark_threshold': the mark, as a percentage. */
  markPct: number | null;
  updatedAt: string | null;
  /** True when no row exists — the course behaves exactly as it does today. */
  isDefault: boolean;
}

function defaultRule(courseId: string): CompletionRule {
  return {
    courseId, kind: 'lessons_viewed', lessonsPct: 100, testId: null, markPct: null,
    updatedAt: null, isDefault: true,
  };
}

function mapRule(r: any): CompletionRule {
  const kind = (COMPLETION_KINDS as readonly string[]).indexOf(String(r?.kind || '')) >= 0
    ? (String(r.kind) as CompletionKind)
    : 'lessons_viewed';
  return {
    courseId: String(r?.course_id || ''),
    kind,
    lessonsPct: Math.min(100, Math.max(1, Number(r?.lessons_pct) || 100)),
    testId: r?.test_id ? String(r.test_id) : null,
    markPct: r?.mark_pct === null || r?.mark_pct === undefined ? null : Number(r.mark_pct),
    updatedAt: iso(r?.updated_at),
    isDefault: false,
  };
}

export async function completionRuleFor(courseId: string): Promise<CompletionRule> {
  if (!isUuid(courseId)) return defaultRule(courseId);
  try {
    await ensureLearningAdminSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT * FROM learning_completion_rules WHERE course_id = ${courseId}::uuid LIMIT 1`));
    return r.length ? mapRule(r[0]) : defaultRule(courseId);
  } catch (e: any) {
    logFail(MOD, 'completionRuleFor', e);
    return defaultRule(courseId);
  }
}

/** Every configured rule, for a catalogue list. Courses with no row are simply absent from the map. */
export async function completionRules(): Promise<Map<string, CompletionRule>> {
  const out = new Map<string, CompletionRule>();
  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`SELECT * FROM learning_completion_rules LIMIT 1000`));
    for (const r of rows) {
      const rule = mapRule(r);
      if (rule.courseId) out.set(rule.courseId, rule);
    }
  } catch (e: any) {
    logFail(MOD, 'completionRules', e);
  }
  return out;
}

export async function setCompletionRule(
  actorUserId: string | null,
  input: {
    courseId: string;
    kind: string;
    lessonsPct?: number | string | null;
    testId?: string | null;
    markPct?: number | string | null;
  },
): Promise<WriteResult> {
  const courseId = String(input?.courseId || '');
  if (!isUuid(courseId)) return { ok: false, error: 'Choose a course.' };
  const kind = (COMPLETION_KINDS as readonly string[]).indexOf(String(input?.kind || '')) >= 0
    ? String(input.kind)
    : 'lessons_viewed';
  const lessonsPct = Math.min(100, Math.max(1, Math.round(Number(input?.lessonsPct) || 100)));
  const testId = isUuid(input?.testId) ? String(input.testId) : null;
  const markRaw = input?.markPct === null || input?.markPct === undefined || input?.markPct === ''
    ? null
    : Math.min(100, Math.max(0, Math.round(Number(input.markPct) || 0)));
  const markPct = kind === 'mark_threshold' ? (markRaw === null ? 50 : markRaw) : markRaw;

  if ((kind === 'assessment_passed' || kind === 'mark_threshold') && !testId) {
    return {
      ok: false,
      error: 'That rule is decided by an assessment, so it needs an assessment chosen. Nothing was changed.',
    };
  }

  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO learning_completion_rules
        (course_id, kind, lessons_pct, test_id, mark_pct, updated_by_user_id, updated_at)
      VALUES (${courseId}::uuid, ${kind}, ${lessonsPct}::int, ${testId}::uuid, ${markPct}::int,
              ${isUuid(actorUserId) ? String(actorUserId) : null}::uuid, NOW())
      ON CONFLICT (course_id) DO UPDATE
        SET kind = EXCLUDED.kind, lessons_pct = EXCLUDED.lessons_pct, test_id = EXCLUDED.test_id,
            mark_pct = EXCLUDED.mark_pct, updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = NOW()
      RETURNING course_id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'learning.rule.set',
      entity: 'learning_completion_rules',
      entityId: courseId,
      diff: { kind, lessonsPct, testId, markPct },
    });
    return {
      ok: true,
      id: courseId,
      info: 'Rule saved. It applies the next time a record is recomputed — it does not silently '
        + 'rewrite completions already recorded.',
    };
  } catch (e: any) {
    logFail(MOD, 'setCompletionRule', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// PROGRESS, COUNTED ONCE
// -------------------------------------------------------------------------------------------------

export interface UnifiedProgress {
  userId: string;
  courseId: string;
  totalLessons: number;
  /** The UNION. A lesson counts once however it was finished. */
  lessonsDone: number;
  /** training_progress, written by the portal player. */
  fromPortalPlayer: number;
  /** training_lesson_completions, written by the AquinTutor player. */
  fromAquinPlayer: number;
  /** True when the two ledgers hold different counts — the seam, made visible. */
  ledgersDisagree: boolean;
  /** The honest percentage, from the union. */
  pct: number;
  /** What training_enrollments currently says, which may be either player's last word. */
  storedPct: number | null;
  storedCompletedAt: string | null;
  enrolmentRows: number;
  /** Best mark on the rule's assessment, when there is one. Null when no attempt exists. */
  bestMarkPct: number | null;
  rule: CompletionRule;
  /** Does the evidence satisfy the rule? */
  meetsRule: boolean;
  /** Why it does or does not, in a sentence a screen prints verbatim. */
  ruleExplanation: string;
  /** The standing manual decision, if any. */
  override: { state: string; reason: string; at: string | null } | null;
  /** meetsRule, then the override on top of it. This is what completed_at should say. */
  isComplete: boolean;
  /** A read that failed is not a learner who did nothing. */
  readFailed: boolean;
}

/** One read that never throws: a missing table is 0 rows, and the caller is told the read failed. */
async function countSafe(tag: string, q: any, onFail: { failed: boolean }): Promise<number> {
  try {
    const r = rowsOf(await db.execute(q));
    return Number(r[0]?.n || 0);
  } catch (e: any) {
    logFail(MOD, tag, e);
    onFail.failed = true;
    return 0;
  }
}

function evaluateRule(
  rule: CompletionRule,
  ev: { totalLessons: number; lessonsDone: number; pct: number; bestMarkPct: number | null },
): { meets: boolean; why: string } {
  if (rule.kind === 'lessons_viewed') {
    if (ev.totalLessons === 0) {
      return { meets: false, why: 'This course has no lessons yet, so nothing can be counted as done.' };
    }
    const meets = ev.pct >= rule.lessonsPct;
    return {
      meets,
      why: ev.lessonsDone + ' of ' + ev.totalLessons + ' lessons done (' + ev.pct + '%). '
        + 'The rule asks for ' + rule.lessonsPct + '%.',
    };
  }
  if (!rule.testId) {
    return { meets: false, why: 'The rule is decided by an assessment, but no assessment is chosen for this course.' };
  }
  if (ev.bestMarkPct === null) {
    return { meets: false, why: 'No submitted attempt at the chosen assessment has been recorded yet.' };
  }
  const need = rule.kind === 'mark_threshold' ? (rule.markPct === null ? 50 : rule.markPct) : 40;
  const meets = ev.bestMarkPct >= need;
  return { meets, why: 'Best submitted attempt: ' + ev.bestMarkPct + '%. The rule asks for ' + need + '%.' };
}

/**
 * ONE PROGRESS FIGURE, from every ledger that holds evidence.
 *
 * The three lesson ledgers are read SEPARATELY as well as together on purpose: training_progress and
 * training_lesson_progress are each created by a different page, so on a given database either can
 * be absent, and a single query would fail entirely and report a learner who has done nothing. The
 * per-table counts are also what makes the disagreement visible instead of merely fixed.
 */
export async function unifiedProgress(userId: string, courseId: string): Promise<UnifiedProgress> {
  const rule = await completionRuleFor(courseId);
  const state = { failed: false };
  if (!isUuid(userId) || !isUuid(courseId)) {
    return {
      userId, courseId, totalLessons: 0, lessonsDone: 0, fromPortalPlayer: 0, fromAquinPlayer: 0,
      ledgersDisagree: false, pct: 0, storedPct: null, storedCompletedAt: null, enrolmentRows: 0,
      bestMarkPct: null, rule, meetsRule: false, ruleExplanation: 'No learner account is linked to this record.',
      override: null, isComplete: false, readFailed: true,
    };
  }

  await ensureLearningAdminSchema();

  const totalLessons = await countSafe('lessons', sql`
    SELECT COUNT(*)::int AS n FROM training_lessons WHERE course_id = ${courseId}::uuid`, state);

  const fromAquin = await countSafe('completions', sql`
    SELECT COUNT(DISTINCT lesson_id)::int AS n FROM training_lesson_completions
     WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid`, state);

  const fromPortal = await countSafe('training_progress', sql`
    SELECT COUNT(DISTINCT p.lesson_id)::int AS n
      FROM training_progress p
      JOIN training_enrollments en ON en.id = p.enrollment_id
     WHERE en.user_id = ${userId}::uuid AND en.course_id = ${courseId}::uuid`, state);

  // The union itself. Counted with a query rather than by adding the two figures above, because a
  // lesson finished in BOTH players must count once.
  let unionDone = Math.max(fromAquin, fromPortal);
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT lesson_id FROM training_lesson_completions
         WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
        UNION
        SELECT p.lesson_id FROM training_progress p
          JOIN training_enrollments en ON en.id = p.enrollment_id
         WHERE en.user_id = ${userId}::uuid AND en.course_id = ${courseId}::uuid
        UNION
        SELECT lp.lesson_id FROM training_lesson_progress lp
          JOIN training_lessons l ON l.id = lp.lesson_id
         WHERE lp.user_id = ${userId}::uuid AND l.course_id = ${courseId}::uuid
           AND lp.completed_at IS NOT NULL
      ) AS every_lesson_done`));
    unionDone = Number(r[0]?.n || 0);
  } catch (e: any) {
    // One of the three tables is absent on this database. The larger of the two we could read is the
    // honest floor, and it is never larger than the truth.
    logFail(MOD, 'unionProgress', e);
  }

  const lessonsDone = totalLessons > 0 ? Math.min(totalLessons, unionDone) : unionDone;
  const pct = totalLessons > 0 ? Math.round((lessonsDone / totalLessons) * 100) : 0;

  let storedPct: number | null = null;
  let storedCompletedAt: string | null = null;
  let enrolmentRows = 0;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT progress_pct, completed_at FROM training_enrollments
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
       ORDER BY completed_at DESC NULLS LAST, progress_pct DESC NULLS LAST`));
    enrolmentRows = r.length;
    if (r.length) {
      storedPct = r[0]?.progress_pct === null || r[0]?.progress_pct === undefined
        ? null
        : Number(r[0].progress_pct);
      storedCompletedAt = iso(r[0]?.completed_at);
    }
  } catch (e: any) {
    logFail(MOD, 'enrolment', e);
    state.failed = true;
  }

  let bestMarkPct: number | null = null;
  if (rule.testId) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT MAX(percentage) AS best FROM test_attempts
         WHERE candidate_id = ${userId}::uuid AND test_id = ${rule.testId}::uuid
           AND status IN ('submitted', 'auto_submitted')`));
      const best = r[0]?.best;
      bestMarkPct = best === null || best === undefined ? null : Number(best);
    } catch (e: any) {
      logFail(MOD, 'bestMark', e);
    }
  }

  let override: UnifiedProgress['override'] = null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT state, reason, created_at FROM learning_completion_overrides
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid
       ORDER BY created_at DESC LIMIT 1`));
    if (r.length) {
      override = { state: String(r[0].state), reason: String(r[0].reason || ''), at: iso(r[0].created_at) };
    }
  } catch (e: any) {
    logFail(MOD, 'override', e);
  }

  const verdict = evaluateRule(rule, { totalLessons, lessonsDone, pct, bestMarkPct });
  const isComplete = override ? override.state === 'complete' : verdict.meets;

  return {
    userId, courseId, totalLessons, lessonsDone,
    fromPortalPlayer: fromPortal, fromAquinPlayer: fromAquin,
    ledgersDisagree: fromPortal !== fromAquin,
    pct, storedPct, storedCompletedAt, enrolmentRows, bestMarkPct, rule,
    meetsRule: verdict.meets, ruleExplanation: verdict.why, override, isComplete,
    readFailed: state.failed,
  };
}

// -------------------------------------------------------------------------------------------------
// THE ONE WRITER OF completed_at
// -------------------------------------------------------------------------------------------------

/**
 * Write the reconciled figure back onto EVERY enrolment row for this person and course.
 *
 * EVERY row, deliberately: training_enrollments carries no unique key on (course_id, user_id), and
 * portal/courses/[slug].astro records that duplicates are possible, with progress landing on
 * whichever row the next SELECT returned. Updating all of them makes the duplicates agree instead of
 * leaving one stale row to be read tomorrow.
 *
 * `createIfMissing` exists for the manual path: an administrator can record that somebody completed
 * a course they never opened in this platform, and the employee learning surface reads completion
 * from training_enrollments, so there must be a row for it to read.
 */
export async function recomputeEnrolment(
  actorUserId: string | null,
  userId: string,
  courseId: string,
  opts: { createIfMissing?: boolean; audit?: boolean } = {},
): Promise<{ ok: boolean; progress?: UnifiedProgress; error?: string }> {
  if (!isUuid(userId) || !isUuid(courseId)) return { ok: false, error: 'That record does not exist.' };
  try {
    const p = await unifiedProgress(userId, courseId);
    if (p.readFailed && p.enrolmentRows === 0 && opts.createIfMissing !== true) {
      return {
        ok: false,
        error: 'We could not read this record just now, so nothing was written. That is a failed read, '
          + 'not an empty record.',
      };
    }

    if (p.enrolmentRows === 0 && opts.createIfMissing === true) {
      // Same shape as the portal player's auto-enrolment: the test and the write in ONE statement,
      // so two presses cannot create two rows.
      await db.execute(sql`
        INSERT INTO training_enrollments (course_id, user_id, progress_pct)
        SELECT ${courseId}::uuid, ${userId}::uuid, ${p.pct}::int
         WHERE NOT EXISTS (
           SELECT 1 FROM training_enrollments
            WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid)`);
    }

    // COALESCE, not NOW(): a completion already on the record keeps the date it happened. Rewriting
    // it on every recompute would move the date somebody's record says they finished.
    const completedSql = p.isComplete ? sql`COALESCE(completed_at, NOW())` : sql`NULL`;
    await db.execute(sql`
      UPDATE training_enrollments
         SET progress_pct = ${p.pct}::int,
             completed_at = ${completedSql}
       WHERE user_id = ${userId}::uuid AND course_id = ${courseId}::uuid`);

    if (opts.audit !== false) {
      await logAudit({
        userId: isUuid(actorUserId) ? String(actorUserId) : null,
        action: 'learning.progress.reconcile',
        entity: 'training_enrollments',
        entityId: courseId,
        diff: {
          learnerUserId: userId,
          storedPct: p.storedPct, unifiedPct: p.pct,
          fromPortalPlayer: p.fromPortalPlayer, fromAquinPlayer: p.fromAquinPlayer,
          complete: p.isComplete,
        },
      });
    }
    return { ok: true, progress: p };
  } catch (e: any) {
    // NEVER swallowed: a write path that fails silently is how a console reports work it did not do.
    logFail(MOD, 'recomputeEnrolment', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Mark a completion by hand. SENSITIVE — this is a statement about a person. Reason required. */
export async function markCompletion(
  actor: { userId: string },
  input: { userId: string; courseId: string; employeeId?: string | null; reason: string },
): Promise<WriteResult> {
  const learner = String(input?.userId || '');
  const courseId = String(input?.courseId || '');
  const reason = clean(input?.reason, 2000);
  if (!isUuid(learner)) {
    return {
      ok: false,
      error: 'This person has no platform account linked to their employee record, so a completion '
        + 'cannot be recorded against them. Link the account first.',
    };
  }
  if (!isUuid(courseId)) return { ok: false, error: 'Choose a course.' };
  if (!reason) return { ok: false, error: REASON_REQUIRED };

  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO learning_completion_overrides
        (user_id, course_id, employee_id, state, reason, actor_user_id)
      VALUES (${learner}::uuid, ${courseId}::uuid,
              ${isUuid(input?.employeeId) ? String(input.employeeId) : null}::uuid,
              'complete', ${reason}, ${isUuid(actor?.userId) ? String(actor.userId) : null}::uuid)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };

    const re = await recomputeEnrolment(actor.userId, learner, courseId, { createIfMissing: true, audit: false });
    if (!re.ok) return { ok: false, error: re.error || WRITE_FAILED };

    await logAudit({
      userId: actor.userId,
      action: 'learning.completion.mark',
      entity: 'learning_completion_overrides',
      entityId: String(rows[0].id),
      diff: { learnerUserId: learner, courseId, reason },
    });
    await notifyUser(learner, {
      title: 'A course completion has been recorded for you',
      body: 'An administrator recorded this course as complete. Reason: ' + reason.slice(0, 300),
      type: 'info',
      actionUrl: '/portal/employee/learning',
      entityType: 'learning_completion',
      entityId: String(rows[0].id),
    });
    return {
      ok: true,
      id: String(rows[0].id),
      info: 'Completion recorded, with your reason on the record and the learner told.',
    };
  } catch (e: any) {
    logFail(MOD, 'markCompletion', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Revoke a completion. SENSITIVE. The row is added, never removed — the history stays readable. */
export async function revokeCompletion(
  actor: { userId: string },
  input: { userId: string; courseId: string; employeeId?: string | null; reason: string },
): Promise<WriteResult> {
  const learner = String(input?.userId || '');
  const courseId = String(input?.courseId || '');
  const reason = clean(input?.reason, 2000);
  if (!isUuid(learner) || !isUuid(courseId)) return { ok: false, error: 'That record does not exist.' };
  if (!reason) return { ok: false, error: REASON_REQUIRED };

  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO learning_completion_overrides
        (user_id, course_id, employee_id, state, reason, actor_user_id)
      VALUES (${learner}::uuid, ${courseId}::uuid,
              ${isUuid(input?.employeeId) ? String(input.employeeId) : null}::uuid,
              'revoked', ${reason}, ${isUuid(actor?.userId) ? String(actor.userId) : null}::uuid)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };

    await db.execute(sql`
      UPDATE training_enrollments SET completed_at = NULL
       WHERE user_id = ${learner}::uuid AND course_id = ${courseId}::uuid`);

    await logAudit({
      userId: actor.userId,
      action: 'learning.completion.revoke',
      entity: 'learning_completion_overrides',
      entityId: String(rows[0].id),
      diff: { learnerUserId: learner, courseId, reason },
    });
    await notifyUser(learner, {
      title: 'A recorded course completion has been withdrawn',
      body: 'Reason: ' + reason.slice(0, 300),
      type: 'system',
      actionUrl: '/portal/employee/learning',
      entityType: 'learning_completion',
      entityId: String(rows[0].id),
    });
    return {
      ok: true,
      id: String(rows[0].id),
      info: 'Completion withdrawn. Any certificate already issued is a separate record and stands '
        + 'until it is withdrawn too.',
    };
  } catch (e: any) {
    logFail(MOD, 'revokeCompletion', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// CERTIFICATES
// -------------------------------------------------------------------------------------------------

export interface CertificateAction {
  id: string;
  certNumber: string;
  action: string;
  reason: string;
  actorUserId: string | null;
  at: string | null;
}

export interface CertificateRecord {
  id: string;
  certNumber: string;
  userId: string;
  courseId: string | null;
  courseTitle: string;
  holderName: string | null;
  grade: string | null;
  issuedAt: string | null;
  /** true when the newest recorded action is a withdrawal. */
  withdrawn: boolean;
  withdrawnReason: string | null;
  withdrawnAt: string | null;
}

/**
 * The standing status of a certificate number.
 *
 * EXPORTED FOR THE PUBLIC VERIFIER. /verify/[cert] and /credentials/[number] do NOT consult this yet
 * — they are not this build's files — so a withdrawal is visible in this console and in the audit log
 * and NOT on the public page. That is said on the screen rather than left for somebody to discover,
 * and wiring it is one call: await certificateStatus(certNumber).
 */
export async function certificateStatus(
  certNumber: string,
): Promise<{ withdrawn: boolean; reason: string | null; at: string | null }> {
  const num = clean(certNumber, 64);
  if (!num) return { withdrawn: false, reason: null, at: null };
  try {
    await ensureLearningAdminSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT action, reason, created_at FROM learning_certificate_actions
       WHERE cert_number = ${num} ORDER BY created_at DESC LIMIT 1`));
    if (!r.length || String(r[0].action) !== 'withdrawn') return { withdrawn: false, reason: null, at: null };
    return { withdrawn: true, reason: String(r[0].reason || ''), at: iso(r[0].created_at) };
  } catch (e: any) {
    logFail(MOD, 'certificateStatus', e);
    return { withdrawn: false, reason: null, at: null };
  }
}

/** Every certificate this person holds in the hash-chained ledger, with its standing status. */
export async function certificatesForUser(userId: string): Promise<CertificateRecord[]> {
  if (!isUuid(userId)) return [];
  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT c.id, c.cert_number, c.user_id, c.course_id, c.course_title, c.holder_name, c.grade,
             c.issued_at, a.action AS last_action, a.reason AS last_reason, a.created_at AS last_action_at
        FROM course_certificates c
        LEFT JOIN LATERAL (
          SELECT action, reason, created_at FROM learning_certificate_actions x
           WHERE x.cert_number = c.cert_number ORDER BY x.created_at DESC LIMIT 1
        ) a ON true
       WHERE c.user_id = ${userId}::uuid
       ORDER BY c.issued_at DESC
       LIMIT 200`));
    return rows.map((r: any) => {
      const withdrawn = String(r.last_action || '') === 'withdrawn';
      return {
        id: String(r.id),
        certNumber: String(r.cert_number || ''),
        userId: String(r.user_id || ''),
        courseId: r.course_id ? String(r.course_id) : null,
        courseTitle: r.course_title ? String(r.course_title) : 'A course',
        holderName: r.holder_name ? String(r.holder_name) : null,
        grade: r.grade ? String(r.grade) : null,
        issuedAt: iso(r.issued_at),
        withdrawn,
        withdrawnReason: withdrawn ? String(r.last_reason || '') : null,
        withdrawnAt: withdrawn ? iso(r.last_action_at) : null,
      };
    });
  } catch (e: any) {
    logFail(MOD, 'certificatesForUser', e);
    return [];
  }
}

/**
 * Issue a certificate by hand.
 *
 * THROUGH src/lib/certificates.ts, never with an INSERT of our own: that ledger is a hash chain and
 * its whole value is that one function writes it. A completion must be on the record first — this
 * console can record one, with a reason, and that is the honest order of events.
 */
export async function issueCourseCertificate(
  actor: { userId: string },
  input: { userId: string; courseId: string; grade?: string | null; reason: string },
): Promise<WriteResult> {
  const learner = String(input?.userId || '');
  const courseId = String(input?.courseId || '');
  const reason = clean(input?.reason, 2000);
  const grade = clean(input?.grade, 8) || 'Pass';
  if (!isUuid(learner) || !isUuid(courseId)) return { ok: false, error: 'That record does not exist.' };
  if (!reason) return { ok: false, error: REASON_REQUIRED };

  try {
    await ensureLearningAdminSchema();
    const p = await unifiedProgress(learner, courseId);
    if (!p.isComplete) {
      return {
        ok: false,
        error: 'This course is not recorded as complete for this person, so a certificate would say '
          + 'something the record does not. Record the completion first, with a reason. ('
          + p.ruleExplanation + ')',
      };
    }

    const title = rowsOf(await db.execute(sql`
      SELECT title FROM training_courses WHERE id = ${courseId}::uuid LIMIT 1`));
    const courseTitle = title.length && title[0]?.title ? String(title[0].title) : 'An EduRankAI course';

    const cert = await issueCertificate({ userId: learner, courseId, courseTitle, grade });
    if (!cert) return { ok: false, error: 'The certificate ledger refused the entry. Nothing was issued.' };

    await db.execute(sql`
      INSERT INTO learning_certificate_actions
        (cert_number, ledger, user_id, course_id, action, reason, actor_user_id)
      VALUES (${cert.certNumber}, 'course_certificates', ${learner}::uuid, ${courseId}::uuid,
              ${cert.alreadyIssued ? 'reinstated' : 'issued'}, ${reason},
              ${isUuid(actor?.userId) ? String(actor.userId) : null}::uuid)`);

    await logAudit({
      userId: actor.userId,
      action: cert.alreadyIssued ? 'learning.certificate.reinstate' : 'learning.certificate.issue',
      entity: 'course_certificates',
      entityId: cert.certNumber,
      diff: { learnerUserId: learner, courseId, grade, reason, alreadyIssued: cert.alreadyIssued },
    });
    await notifyUser(learner, {
      title: cert.alreadyIssued
        ? 'Your course certificate is standing again'
        : 'A course certificate has been issued to you',
      body: courseTitle + ' — ' + cert.certNumber,
      type: 'info',
      actionUrl: '/portal/employee/learning',
      entityType: 'course_certificate',
      entityId: cert.certNumber,
    });
    return {
      ok: true,
      id: cert.certNumber,
      info: cert.alreadyIssued
        ? 'That person already held a certificate for this course (' + cert.certNumber
          + '), so this is recorded as a reinstatement rather than a second certificate.'
        : 'Certificate ' + cert.certNumber + ' issued and written into the ledger.',
    };
  } catch (e: any) {
    logFail(MOD, 'issueCourseCertificate', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Withdraw a certificate. SENSITIVE, AND VISIBLE RATHER THAN SILENT.
 *
 * The certificate row is NOT deleted and NOT edited. It is a block in a hash chain: removing it would
 * break the prev_hash reference of every certificate issued after it, so a single administrative
 * mistake would make hundreds of other people's certificates fail verification. The withdrawal is a
 * later fact, recorded against the number, and every reader consults it through certificateStatus().
 */
export async function withdrawCertificate(
  actor: { userId: string },
  input: { certNumber: string; reason: string },
): Promise<WriteResult> {
  const num = clean(input?.certNumber, 64);
  const reason = clean(input?.reason, 2000);
  if (!num) return { ok: false, error: 'Which certificate?' };
  if (!reason) return { ok: false, error: REASON_REQUIRED };

  try {
    await ensureLearningAdminSchema();
    const found = rowsOf(await db.execute(sql`
      SELECT user_id, course_id, course_title FROM course_certificates
       WHERE cert_number = ${num} LIMIT 1`));
    if (!found.length) {
      return { ok: false, error: 'No certificate carries that number in the ledger. Nothing was changed.' };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO learning_certificate_actions
        (cert_number, ledger, user_id, course_id, action, reason, actor_user_id)
      VALUES (${num}, 'course_certificates', ${String(found[0].user_id)}::uuid,
              ${found[0].course_id ? String(found[0].course_id) : null}::uuid,
              'withdrawn', ${reason}, ${isUuid(actor?.userId) ? String(actor.userId) : null}::uuid)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };

    await logAudit({
      userId: actor.userId,
      action: 'learning.certificate.withdraw',
      entity: 'course_certificates',
      entityId: num,
      diff: {
        learnerUserId: String(found[0].user_id),
        courseId: found[0].course_id ? String(found[0].course_id) : null,
        reason,
      },
    });
    await notifyUser(String(found[0].user_id), {
      title: 'A certificate issued to you has been withdrawn',
      body: (found[0].course_title ? String(found[0].course_title) + ' — ' : '') + num
        + '. Reason: ' + reason.slice(0, 300),
      type: 'system',
      actionUrl: '/portal/employee/learning',
      entityType: 'course_certificate',
      entityId: num,
    });
    return {
      ok: true,
      id: num,
      info: 'Withdrawal recorded against ' + num + '. The ledger entry is left intact on purpose — '
        + 'deleting a block would break verification for every certificate issued after it.',
    };
  } catch (e: any) {
    logFail(MOD, 'withdrawCertificate', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** The action history for one number, newest first — so a withdrawal is never invisible. */
export async function certificateHistory(certNumber: string): Promise<CertificateAction[]> {
  const num = clean(certNumber, 64);
  if (!num) return [];
  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, cert_number, action, reason, actor_user_id, created_at
        FROM learning_certificate_actions WHERE cert_number = ${num}
       ORDER BY created_at DESC LIMIT 50`));
    return rows.map((r: any) => ({
      id: String(r.id),
      certNumber: String(r.cert_number),
      action: String(r.action),
      reason: String(r.reason || ''),
      actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
      at: iso(r.created_at),
    }));
  } catch (e: any) {
    logFail(MOD, 'certificateHistory', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// THE CATALOGUE — the SAME training_courses every other editor writes. Publish, unpublish, archive.
// -------------------------------------------------------------------------------------------------

export interface AdminCourse {
  id: string;
  title: string;
  slug: string | null;
  category: string | null;
  level: string | null;
  accessType: string | null;
  isPublished: boolean;
  archivedAt: string | null;
  lessonCount: number;
  moduleCount: number;
  enrolments: number;
  completions: number;
  rule: CompletionRule;
}

export const ACCESS_TYPES = [
  { value: 'public', label: 'Anyone signed in' },
  { value: 'both', label: 'Anyone signed in, and the public catalogue' },
  { value: 'employees', label: 'Employees only' },
  { value: 'applicants', label: 'Applicants only' },
] as const;

/**
 * The catalogue as an administrator needs to see it.
 *
 * access_type is carried through because it is a live trap: the HR assignment picker ignores it, so a
 * course set to 'applicants' can be assigned to an employee who is then redirected away from it, and
 * a course set to 'employees' never appears in the AquinTutor catalogue at all. The screen says so
 * rather than leaving somebody to find out.
 */
export async function adminCourses(opts: { includeArchived?: boolean } = {}): Promise<{ ok: boolean; courses: AdminCourse[]; error?: string }> {
  try {
    await ensureLearningAdminSchema();
    const archived = opts.includeArchived === true ? sql`` : sql`WHERE c.archived_at IS NULL`;
    const rows = rowsOf(await db.execute(sql`
      SELECT c.id, c.title, c.slug, c.category, c.level, c.access_type, c.is_published, c.archived_at,
             (SELECT COUNT(*)::int FROM training_lessons l WHERE l.course_id = c.id) AS lesson_count,
             (SELECT COUNT(*)::int FROM training_modules m WHERE m.course_id = c.id) AS module_count,
             (SELECT COUNT(*)::int FROM training_enrollments en WHERE en.course_id = c.id) AS enrolments,
             (SELECT COUNT(*)::int FROM training_enrollments en2
               WHERE en2.course_id = c.id AND en2.completed_at IS NOT NULL) AS completions
        FROM training_courses c
        ${archived}
       ORDER BY c.title ASC
       LIMIT 500`));
    const rules = await completionRules();
    return {
      ok: true,
      courses: rows.map((r: any) => ({
        id: String(r.id),
        title: r.title ? String(r.title) : 'Untitled course',
        slug: r.slug ? String(r.slug) : null,
        category: r.category ? String(r.category) : null,
        level: r.level ? String(r.level) : null,
        accessType: r.access_type ? String(r.access_type) : null,
        isPublished: r.is_published === true,
        archivedAt: iso(r.archived_at),
        lessonCount: Number(r.lesson_count) || 0,
        moduleCount: Number(r.module_count) || 0,
        enrolments: Number(r.enrolments) || 0,
        completions: Number(r.completions) || 0,
        rule: rules.get(String(r.id)) || defaultRule(String(r.id)),
      })),
    };
  } catch (e: any) {
    // An unreadable catalogue must never draw as "there are no courses".
    logFail(MOD, 'adminCourses', e);
    return { ok: false, courses: [], error: e?.cause?.message || e?.message || 'The course list could not be read.' };
  }
}

export async function createCourse(
  actorUserId: string,
  input: { title: string; slug: string; category?: string; level?: string; accessType?: string },
): Promise<WriteResult> {
  const title = clean(input?.title, 200);
  const slug = clean(input?.slug, 120).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!title) return { ok: false, error: 'Give the course a title.' };
  if (!slug) return { ok: false, error: 'Give the course a web address (slug).' };
  const category = clean(input?.category, 60) || 'general';
  const level = clean(input?.level, 40) || 'beginner';
  const access = (ACCESS_TYPES as readonly { value: string }[]).some((a) => a.value === String(input?.accessType))
    ? String(input.accessType)
    : 'employees';

  try {
    await ensureLearningAdminSchema();
    // The test and the write in ONE statement — two submissions cannot both claim the same slug, and
    // slug is what /aquintutor/courses/<slug> and /portal/courses/<slug> resolve.
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO training_courses (title, slug, category, level, access_type, is_published, created_by, created_at, updated_at)
      SELECT ${title}, ${slug}, ${category}, ${level}, ${access}, false, ${actorUserId}::uuid, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM training_courses WHERE slug = ${slug})
      RETURNING id`));
    if (!rows.length) {
      return { ok: false, error: 'Nothing was created: the address /' + slug + ' already belongs to another course.' };
    }
    await logAudit({
      userId: actorUserId,
      action: 'learning.course.create',
      entity: 'training_courses',
      entityId: String(rows[0].id),
      diff: { title, slug, category, level, accessType: access },
    });
    return {
      ok: true,
      id: String(rows[0].id),
      info: 'Course created as a draft. It reaches nobody until it is published.',
    };
  } catch (e: any) {
    logFail(MOD, 'createCourse', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function editCourse(
  actorUserId: string,
  input: { courseId: string; title: string; category?: string; level?: string; accessType?: string },
): Promise<WriteResult> {
  const courseId = String(input?.courseId || '');
  const title = clean(input?.title, 200);
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  if (!title) return { ok: false, error: 'A course needs a title.' };
  const category = clean(input?.category, 60) || 'general';
  const level = clean(input?.level, 40) || 'beginner';
  const access = (ACCESS_TYPES as readonly { value: string }[]).some((a) => a.value === String(input?.accessType))
    ? String(input.accessType)
    : 'employees';

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE training_courses
         SET title = ${title}, category = ${category}, level = ${level}, access_type = ${access},
             updated_at = NOW()
       WHERE id = ${courseId}::uuid
      RETURNING id`));
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that course no longer exists.' };
    await logAudit({
      userId: actorUserId,
      action: 'learning.course.edit',
      entity: 'training_courses',
      entityId: courseId,
      diff: { title, category, level, accessType: access },
    });
    return { ok: true, id: courseId, info: 'Course updated.' };
  } catch (e: any) {
    logFail(MOD, 'editCourse', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Publish or unpublish. The result is READ BACK, so the message says which state it is now in. */
export async function setCoursePublished(
  actorUserId: string,
  courseId: string,
  published: boolean,
): Promise<WriteResult> {
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE training_courses SET is_published = ${published}, updated_at = NOW()
       WHERE id = ${courseId}::uuid
      RETURNING is_published`));
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that course no longer exists.' };
    const now = rows[0].is_published === true;
    await logAudit({
      userId: actorUserId,
      action: now ? 'learning.course.publish' : 'learning.course.unpublish',
      entity: 'training_courses',
      entityId: courseId,
      diff: { isPublished: now },
    });
    return {
      ok: true,
      id: courseId,
      info: now
        ? 'Course published. People already assigned it keep their progress.'
        : 'Course unpublished. Nobody loses progress — it simply stops being offered.',
    };
  } catch (e: any) {
    logFail(MOD, 'setCoursePublished', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * ARCHIVE, WHICH IS NOT DELETE.
 *
 * The four existing course editors offer a hard DELETE and nothing else. A course row is what every
 * enrolment, completion and certificate points at, so deleting one destroys the evidence that people
 * did the work. Archiving sets a date, unpublishes it, and leaves every record standing.
 */
export async function setCourseArchived(
  actorUserId: string,
  courseId: string,
  archived: boolean,
): Promise<WriteResult> {
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  try {
    await ensureLearningAdminSchema();
    const rows = archived
      ? rowsOf(await db.execute(sql`
          UPDATE training_courses
             SET archived_at = NOW(), archived_by_user_id = ${actorUserId}::uuid,
                 is_published = false, updated_at = NOW()
           WHERE id = ${courseId}::uuid
          RETURNING id`))
      : rowsOf(await db.execute(sql`
          UPDATE training_courses
             SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
           WHERE id = ${courseId}::uuid
          RETURNING id`));
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that course no longer exists.' };
    await logAudit({
      userId: actorUserId,
      action: archived ? 'learning.course.archive' : 'learning.course.unarchive',
      entity: 'training_courses',
      entityId: courseId,
      diff: { archived },
    });
    return {
      ok: true,
      id: courseId,
      info: archived
        ? 'Course archived and unpublished. Every enrolment, completion and certificate that points '
          + 'at it is untouched — nothing was deleted.'
        : 'Course taken out of the archive. It is still unpublished until you publish it.',
    };
  } catch (e: any) {
    logFail(MOD, 'setCourseArchived', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// LESSONS. The same training_lessons the players read.
// -------------------------------------------------------------------------------------------------

export interface AdminLesson {
  id: string;
  courseId: string;
  moduleId: string | null;
  title: string;
  sortOrder: number;
  /** Does this lesson have any content in the HR/portal player's column? */
  hasInlineContent: boolean;
  /** Does it have blocks, which only the AquinTutor runner renders? */
  blockCount: number;
}

export async function lessonsForCourse(courseId: string): Promise<{ ok: boolean; lessons: AdminLesson[]; error?: string }> {
  if (!isUuid(courseId)) return { ok: true, lessons: [] };
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT l.id, l.course_id, l.module_id, l.title, l.sort_order,
             (l.content IS NOT NULL AND length(l.content) > 0) AS has_inline,
             (SELECT COUNT(*)::int FROM training_lesson_blocks b WHERE b.lesson_id = l.id) AS block_count
        FROM training_lessons l
       WHERE l.course_id = ${courseId}::uuid
       ORDER BY l.sort_order ASC, l.title ASC
       LIMIT 500`));
    return {
      ok: true,
      lessons: rows.map((r: any) => ({
        id: String(r.id),
        courseId: String(r.course_id),
        moduleId: r.module_id ? String(r.module_id) : null,
        title: r.title ? String(r.title) : 'Untitled lesson',
        sortOrder: Number(r.sort_order) || 0,
        hasInlineContent: r.has_inline === true,
        blockCount: Number(r.block_count) || 0,
      })),
    };
  } catch (e: any) {
    logFail(MOD, 'lessonsForCourse', e);
    return { ok: false, lessons: [], error: e?.cause?.message || e?.message || 'The lesson list could not be read.' };
  }
}

export async function createLesson(
  actorUserId: string,
  input: { courseId: string; title: string; content?: string | null; sortOrder?: number | string | null },
): Promise<WriteResult> {
  const courseId = String(input?.courseId || '');
  const title = clean(input?.title, 200);
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  if (!title) return { ok: false, error: 'Give the lesson a title.' };
  const content = clean(input?.content, 20000) || null;
  const sortOrder = Math.max(0, Math.round(Number(input?.sortOrder) || 0));

  try {
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO training_lessons (course_id, title, content, sort_order)
      VALUES (${courseId}::uuid, ${title}, ${content}::text, ${sortOrder}::int)
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actorUserId,
      action: 'learning.lesson.create',
      entity: 'training_lessons',
      entityId: String(rows[0].id),
      diff: { courseId, title },
    });
    return {
      ok: true,
      id: String(rows[0].id),
      info: 'Lesson added. Adding a lesson changes the denominator, so everybody’s percentage on '
        + 'this course moves — recompute a record to see its new figure.',
    };
  } catch (e: any) {
    logFail(MOD, 'createLesson', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function editLesson(
  actorUserId: string,
  input: { lessonId: string; title: string; content?: string | null; sortOrder?: number | string | null },
): Promise<WriteResult> {
  const lessonId = String(input?.lessonId || '');
  const title = clean(input?.title, 200);
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  if (!title) return { ok: false, error: 'A lesson needs a title.' };
  const content = clean(input?.content, 20000) || null;
  const sortOrder = Math.max(0, Math.round(Number(input?.sortOrder) || 0));

  try {
    const rows = rowsOf(await db.execute(sql`
      UPDATE training_lessons SET title = ${title}, content = ${content}::text, sort_order = ${sortOrder}::int
       WHERE id = ${lessonId}::uuid
      RETURNING id`));
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that lesson no longer exists.' };
    await logAudit({
      userId: actorUserId,
      action: 'learning.lesson.edit',
      entity: 'training_lessons',
      entityId: lessonId,
      diff: { title, sortOrder },
    });
    return { ok: true, id: lessonId, info: 'Lesson updated.' };
  } catch (e: any) {
    logFail(MOD, 'editLesson', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// COHORTS. HONEST ABOUT SIZE BEFORE THE BUTTON IS PRESSED.
// -------------------------------------------------------------------------------------------------

export interface CohortFilter {
  kind: CohortKind;
  /** The department id (text), the designation, or the employment type. Ignored for 'everyone'. */
  value: string | null;
}

export interface CohortPreview {
  ok: boolean;
  /** From the SAME query that will do the assigning. Not an estimate. */
  total: number;
  /** How many of those have no platform account, and so can never join an enrolment. */
  withoutAccount: number;
  sample: { employeeId: string; name: string; hasAccount: boolean }[];
  label: string;
  error?: string;
}

export function cohortLabel(filter: CohortFilter, departmentNames: Map<string, string>): string {
  if (filter.kind === 'everyone') return 'Everybody with an active employee record';
  const v = String(filter.value || '');
  if (!v) return 'No group chosen';
  if (filter.kind === 'department') return 'Department: ' + (departmentNames.get(v) || v);
  if (filter.kind === 'designation') return 'Role level: ' + v;
  return 'Employment type: ' + v;
}

/** The one query the preview and the write both use. Written once so they cannot drift. */
function cohortWhere(filter: CohortFilter, scope: LearningScope) {
  const v = clean(filter?.value, 120);
  const kindFilter = filter.kind === 'department'
    ? sql`AND e.department_id::text = ${v}`
    : filter.kind === 'designation'
      ? sql`AND e.designation = ${v}`
      : filter.kind === 'employment_type'
        ? sql`AND e.employment_type = ${v}`
        : sql``;
  return sql`WHERE e.is_active = true ${kindFilter} ${scopeFilter(scope)}`;
}

/**
 * HOW MANY PEOPLE WILL THIS REACH? Answered from the query that will do it, before it is done.
 *
 * withoutAccount is not decoration. hr_learning_assignments.user_id is nullable and the learning path
 * joins the enrolment on users.id, so an employee record with no linked account produces an
 * assignment that can never show progress and reads "not started" forever. Saying the number in
 * advance is the difference between an administrator choosing that and discovering it.
 */
export async function previewCohort(
  filter: CohortFilter,
  scope: LearningScope,
  departmentNames: Map<string, string> = new Map(),
): Promise<CohortPreview> {
  const label = cohortLabel(filter, departmentNames);
  if ((COHORT_KINDS as readonly string[]).indexOf(String(filter?.kind)) < 0) {
    return { ok: false, total: 0, withoutAccount: 0, sample: [], label, error: 'Choose a group.' };
  }
  if (filter.kind !== 'everyone' && !clean(filter?.value, 120)) {
    return { ok: false, total: 0, withoutAccount: 0, sample: [], label, error: 'Choose which group.' };
  }
  if (!scope.canSeeAnything) {
    return { ok: false, total: 0, withoutAccount: 0, sample: [], label, error: scope.explanation };
  }
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, (e.user_id IS NOT NULL) AS has_account
        FROM hr_employees e
        ${cohortWhere(filter, scope)}
       ORDER BY e.full_name ASC
       LIMIT ${COHORT_CAP + 1}`));
    const capped = rows.slice(0, COHORT_CAP);
    return {
      ok: true,
      total: capped.length,
      withoutAccount: capped.filter((r: any) => r.has_account !== true).length,
      sample: capped.slice(0, 12).map((r: any) => ({
        employeeId: String(r.id),
        name: r.full_name ? String(r.full_name) : 'Unnamed record',
        hasAccount: r.has_account === true,
      })),
      label,
      error: rows.length > COHORT_CAP
        ? 'More than ' + COHORT_CAP + ' people match. Only the first ' + COHORT_CAP
          + ' would be assigned in one press — narrow the group.'
        : undefined,
    };
  } catch (e: any) {
    logFail(MOD, 'previewCohort', e);
    return {
      ok: false, total: 0, withoutAccount: 0, sample: [], label,
      error: 'We could not count that group just now, so nothing is offered. That is a failed read, not an empty group.',
    };
  }
}

/**
 * Assign to a group.
 *
 * `expectedCount` is the number the administrator was SHOWN. If the group has changed size since the
 * preview — somebody joined, somebody left — the write is refused and the new number is reported.
 * A group assignment that quietly reaches more people than the screen promised is exactly the failure
 * this argument exists to prevent.
 *
 * Every individual write goes through assignCourse() in performance-learning.ts, the module that owns
 * hr_learning_assignments. This does not become a second assignment writer.
 */
export async function assignToCohort(
  viewer: PerfViewer,
  scope: LearningScope,
  input: {
    filter: CohortFilter;
    courseId: string;
    dueOn?: string | null;
    required?: boolean;
    reason?: string | null;
    expectedCount: number;
  },
): Promise<WriteResult & { assigned?: number; failed?: number }> {
  const courseId = String(input?.courseId || '');
  if (!isUuid(courseId)) return { ok: false, error: 'Choose a course.' };
  if (!scope.canSeeAnything) return { ok: false, error: scope.explanation };

  const preview = await previewCohort(input.filter, scope);
  if (!preview.ok) return { ok: false, error: preview.error || 'That group could not be resolved.' };
  if (preview.total === 0) return { ok: false, error: 'Nobody matches that group, so nothing was assigned.' };
  const expected = Math.round(Number(input?.expectedCount) || -1);
  if (expected !== preview.total) {
    return {
      ok: false,
      error: 'This group now has ' + preview.total + ' people, not the ' + expected
        + ' you were shown. Nothing was assigned. Check the number and press again.',
    };
  }

  try {
    const members = rowsOf(await db.execute(sql`
      SELECT e.id FROM hr_employees e ${cohortWhere(input.filter, scope)}
       ORDER BY e.full_name ASC LIMIT ${COHORT_CAP}`));

    let assigned = 0;
    let failed = 0;
    const firstError: string[] = [];
    for (const m of members) {
      const r = await assignCourse(viewer, {
        employeeId: String(m.id),
        courseId,
        dueOn: input?.dueOn ?? null,
        required: input?.required === true,
        reason: input?.reason ?? null,
        orgWide: true, // the page has already checked the capability and the graph scope
      });
      if (r.ok) assigned++;
      else {
        failed++;
        if (firstError.length === 0 && r.error) firstError.push(r.error);
      }
    }

    await logAudit({
      userId: viewer.userId,
      action: 'learning.assign.cohort',
      entity: 'hr_learning_assignments',
      entityId: courseId,
      diff: {
        filterKind: input.filter.kind, filterValue: input.filter.value,
        matched: preview.total, assigned, failed,
        dueOn: input?.dueOn ?? null, required: input?.required === true,
      },
    });

    if (assigned === 0) {
      return {
        ok: false, assigned, failed,
        error: 'Nothing was assigned. First reason: ' + (firstError[0] || 'unknown'),
      };
    }
    return {
      ok: true,
      assigned,
      failed,
      info: 'Assigned to ' + assigned + ' of ' + preview.total + ' people'
        + (failed > 0 ? '. ' + failed + ' were not assigned; first reason: ' + (firstError[0] || 'unknown') : '.')
        + (preview.withoutAccount > 0
          ? ' ' + preview.withoutAccount + ' of them have no platform account, so their progress '
            + 'cannot be tracked until one is linked.'
          : ''),
    };
  } catch (e: any) {
    logFail(MOD, 'assignToCohort', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** The distinct designations and employment types actually recorded, for the group pickers. */
export async function cohortValueOptions(scope: LearningScope): Promise<{ designations: string[]; employmentTypes: string[] }> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT DISTINCT e.designation, e.employment_type
        FROM hr_employees e
       WHERE e.is_active = true ${scopeFilter(scope)}
       LIMIT 500`));
    const designations = new Set<string>();
    const employmentTypes = new Set<string>();
    for (const r of rows) {
      if (r.designation) designations.add(String(r.designation));
      if (r.employment_type) employmentTypes.add(String(r.employment_type));
    }
    return {
      designations: [...designations].sort(),
      employmentTypes: [...employmentTypes].sort(),
    };
  } catch (e: any) {
    logFail(MOD, 'cohortValueOptions', e);
    return { designations: [], employmentTypes: [] };
  }
}

// -------------------------------------------------------------------------------------------------
// DEADLINES
// -------------------------------------------------------------------------------------------------

/**
 * EXTEND A DEADLINE, with a reason, as its own act.
 *
 * Today the only way to move a due date is to run "assign" again: the UNIQUE (employee_id, course_id)
 * constraint turns it into an update, and the audit log records it as another assignment. An
 * extension and an assignment are different decisions and a record that cannot tell them apart cannot
 * answer "who kept moving this deadline".
 *
 * This is the SECOND writer of hr_learning_assignments, and the only one outside
 * performance-learning.ts. It writes one column and records why.
 */
export async function extendDeadline(
  actorUserId: string,
  input: { assignmentId: string; dueOn: string; reason: string },
): Promise<WriteResult> {
  const assignmentId = String(input?.assignmentId || '');
  const dueOn = validDay(input?.dueOn);
  const reason = clean(input?.reason, 1000);
  if (!isUuid(assignmentId)) return { ok: false, error: 'That assignment does not exist.' };
  if (!dueOn) return { ok: false, error: 'Give the new date.' };
  if (!reason) return { ok: false, error: 'Write down why the deadline is moving.' };

  try {
    await ensurePerformanceSchema();
    const before = rowsOf(await db.execute(sql`
      SELECT a.due_on, a.user_id, a.course_id, c.title AS course_title
        FROM hr_learning_assignments a
        LEFT JOIN training_courses c ON c.id = a.course_id
       WHERE a.id = ${assignmentId}::uuid LIMIT 1`));
    if (!before.length) return { ok: false, error: 'That assignment does not exist.' };
    const oldDue = isoDay(before[0].due_on);

    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_learning_assignments SET due_on = ${dueOn}::date
       WHERE id = ${assignmentId}::uuid
      RETURNING id`));
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that assignment no longer exists.' };

    await logAudit({
      userId: actorUserId,
      action: 'learning.deadline.extend',
      entity: 'hr_learning_assignments',
      entityId: assignmentId,
      diff: { from: oldDue, to: dueOn, reason },
    });

    const learner = before[0].user_id ? String(before[0].user_id) : null;
    if (isUuid(learner)) {
      await notifyUser(String(learner), {
        title: 'A learning deadline has moved',
        body: (before[0].course_title ? String(before[0].course_title) + ' — ' : '')
          + 'now due ' + dueOn + '. Reason: ' + reason.slice(0, 300),
        type: 'info',
        actionUrl: '/portal/employee/learning',
        entityType: 'learning_assignment',
        entityId: assignmentId,
      });
    }
    return {
      ok: true,
      id: assignmentId,
      info: 'Deadline moved from ' + (oldDue || 'no date') + ' to ' + dueOn + ', with your reason on the record.',
    };
  } catch (e: any) {
    logFail(MOD, 'extendDeadline', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// PROGRESS SCREENS: the aggregate, and one person from inside it.
// -------------------------------------------------------------------------------------------------

export interface CohortRow {
  key: string;
  label: string;
  people: number;
  assignments: number;
  complete: number;
  inProgress: number;
  notStarted: number;
  overdue: number;
  /** Assignments whose learner has no platform account: permanently unmeasurable. */
  unlinked: number;
}

/**
 * The aggregate, grouped by department, from ONE query.
 *
 * Completion is read from training_enrollments.completed_at — the column this module is the first
 * thing in the repository to write. Before this build every figure in this column would have been
 * zero, whatever people had actually done.
 */
export async function cohortRollup(scope: LearningScope): Promise<{ ok: boolean; rows: CohortRow[]; error?: string }> {
  if (!scope.canSeeAnything) return { ok: true, rows: [] };
  try {
    await ensurePerformanceSchema();
    const today = civilToday();
    const rows = rowsOf(await db.execute(sql`
      SELECT COALESCE(d.name, 'No department recorded') AS label,
             COALESCE(e.department_id::text, '') AS key,
             COUNT(DISTINCT e.id)::int AS people,
             COUNT(a.id)::int AS assignments,
             COUNT(*) FILTER (WHERE en.completed_at IS NOT NULL)::int AS complete,
             COUNT(*) FILTER (WHERE en.completed_at IS NULL AND COALESCE(en.progress_pct, 0) > 0)::int AS in_progress,
             COUNT(*) FILTER (WHERE en.id IS NULL OR (en.completed_at IS NULL AND COALESCE(en.progress_pct, 0) = 0))::int AS not_started,
             COUNT(*) FILTER (WHERE en.completed_at IS NULL AND a.due_on IS NOT NULL AND a.due_on < ${today}::date)::int AS overdue,
             COUNT(*) FILTER (WHERE a.user_id IS NULL)::int AS unlinked
        FROM hr_learning_assignments a
        JOIN hr_employees e ON e.id = a.employee_id
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        LEFT JOIN training_enrollments en ON en.course_id = a.course_id AND en.user_id = a.user_id
       WHERE a.status = 'assigned' ${scopeFilter(scope)}
       GROUP BY 1, 2
       ORDER BY 1 ASC
       LIMIT 200`));
    return {
      ok: true,
      rows: rows.map((r: any) => ({
        key: String(r.key || ''),
        label: String(r.label || 'No department recorded'),
        people: Number(r.people) || 0,
        assignments: Number(r.assignments) || 0,
        complete: Number(r.complete) || 0,
        inProgress: Number(r.in_progress) || 0,
        notStarted: Number(r.not_started) || 0,
        overdue: Number(r.overdue) || 0,
        unlinked: Number(r.unlinked) || 0,
      })),
    };
  } catch (e: any) {
    logFail(MOD, 'cohortRollup', e);
    return { ok: false, rows: [], error: e?.cause?.message || e?.message || 'The aggregate could not be read.' };
  }
}

export interface PersonRow {
  employeeId: string;
  name: string;
  userId: string | null;
  departmentName: string | null;
  assignments: number;
  complete: number;
  overdue: number;
}

/** Everybody in scope with assigned learning, so the aggregate can be opened one person at a time. */
export async function peopleWithLearning(
  scope: LearningScope,
  opts: { departmentId?: string | null; overdueOnly?: boolean; limit?: number } = {},
): Promise<{ ok: boolean; rows: PersonRow[]; error?: string }> {
  if (!scope.canSeeAnything) return { ok: true, rows: [] };
  const lim = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    await ensurePerformanceSchema();
    const today = civilToday();
    const dept = clean(opts.departmentId, 120);
    const deptFilter = dept ? sql`AND e.department_id::text = ${dept}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, e.user_id, d.name AS department_name,
             COUNT(a.id)::int AS assignments,
             COUNT(*) FILTER (WHERE en.completed_at IS NOT NULL)::int AS complete,
             COUNT(*) FILTER (WHERE en.completed_at IS NULL AND a.due_on IS NOT NULL AND a.due_on < ${today}::date)::int AS overdue
        FROM hr_learning_assignments a
        JOIN hr_employees e ON e.id = a.employee_id
        LEFT JOIN departments d ON d.id::text = e.department_id::text
        LEFT JOIN training_enrollments en ON en.course_id = a.course_id AND en.user_id = a.user_id
       WHERE a.status = 'assigned' ${deptFilter} ${scopeFilter(scope)}
       GROUP BY e.id, e.full_name, e.user_id, d.name
       ORDER BY e.full_name ASC
       LIMIT ${lim}`));
    const mapped = rows.map((r: any) => ({
      employeeId: String(r.id),
      name: r.full_name ? String(r.full_name) : 'Unnamed record',
      userId: r.user_id ? String(r.user_id) : null,
      departmentName: r.department_name ? String(r.department_name) : null,
      assignments: Number(r.assignments) || 0,
      complete: Number(r.complete) || 0,
      overdue: Number(r.overdue) || 0,
    }));
    return { ok: true, rows: opts.overdueOnly === true ? mapped.filter((p) => p.overdue > 0) : mapped };
  } catch (e: any) {
    logFail(MOD, 'peopleWithLearning', e);
    return { ok: false, rows: [], error: e?.cause?.message || e?.message || 'The list could not be read.' };
  }
}

export interface PersonAssignment {
  assignmentId: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string | null;
  required: boolean;
  dueOn: string | null;
  reason: string | null;
  status: string;
  overdue: boolean;
  progress: UnifiedProgress;
}

export interface PersonRecord {
  ok: boolean;
  employeeId: string;
  name: string;
  userId: string | null;
  departmentId: string | null;
  departmentName: string | null;
  assignments: PersonAssignment[];
  certificates: CertificateRecord[];
  error?: string;
}

/** One person's whole learning record, with the progress figure reconciled per course. */
export async function personRecord(employeeId: string): Promise<PersonRecord> {
  const blank: PersonRecord = {
    ok: false, employeeId, name: 'Unnamed record', userId: null, departmentId: null,
    departmentName: null, assignments: [], certificates: [],
  };
  if (!isUuid(employeeId)) return { ...blank, error: 'That employee record does not exist.' };
  try {
    await ensurePerformanceSchema();
    const who = rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, e.user_id, e.department_id::text AS department_id, d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.id = ${employeeId}::uuid LIMIT 1`));
    if (!who.length) return { ...blank, error: 'That employee record does not exist.' };
    const userId = who[0].user_id ? String(who[0].user_id) : null;

    const rows = rowsOf(await db.execute(sql`
      SELECT a.id, a.course_id, a.required, a.due_on, a.reason, a.status,
             c.title AS course_title, c.slug AS course_slug
        FROM hr_learning_assignments a
        LEFT JOIN training_courses c ON c.id = a.course_id
       WHERE a.employee_id = ${employeeId}::uuid
       ORDER BY a.required DESC, a.due_on ASC NULLS LAST
       LIMIT 100`));

    const today = civilToday();
    const assignments: PersonAssignment[] = [];
    for (const r of rows) {
      const courseId = String(r.course_id);
      const progress = userId
        ? await unifiedProgress(userId, courseId)
        : await unifiedProgress('', courseId);
      const dueOn = isoDay(r.due_on);
      assignments.push({
        assignmentId: String(r.id),
        courseId,
        courseTitle: r.course_title ? String(r.course_title) : 'A course that is no longer in the catalogue',
        courseSlug: r.course_slug ? String(r.course_slug) : null,
        required: r.required === true,
        dueOn,
        reason: r.reason ? String(r.reason) : null,
        status: String(r.status || 'assigned'),
        overdue: !progress.isComplete && !!dueOn && dueOn < today,
        progress,
      });
    }

    return {
      ok: true,
      employeeId,
      name: who[0].full_name ? String(who[0].full_name) : 'Unnamed record',
      userId,
      departmentId: who[0].department_id ? String(who[0].department_id) : null,
      departmentName: who[0].department_name ? String(who[0].department_name) : null,
      assignments,
      certificates: userId ? await certificatesForUser(userId) : [],
    };
  } catch (e: any) {
    logFail(MOD, 'personRecord', e);
    return { ...blank, error: e?.cause?.message || e?.message || 'That record could not be read.' };
  }
}

/** The audit trail of manual decisions about one person, so a revocation is never invisible. */
export async function overrideHistory(userId: string, limit = 50): Promise<{ courseId: string; state: string; reason: string; at: string | null }[]> {
  if (!isUuid(userId)) return [];
  try {
    await ensureLearningAdminSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT course_id, state, reason, created_at FROM learning_completion_overrides
       WHERE user_id = ${userId}::uuid ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`));
    return rows.map((r: any) => ({
      courseId: String(r.course_id),
      state: String(r.state),
      reason: String(r.reason || ''),
      at: iso(r.created_at),
    }));
  } catch (e: any) {
    logFail(MOD, 'overrideHistory', e);
    return [];
  }
}

/** The assessments an administrator can pin a completion rule to. */
export async function testOptions(limit = 200): Promise<{ id: string; title: string }[]> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, title FROM tests ORDER BY title ASC LIMIT ${Math.min(Math.max(limit, 1), 500)}`));
    return rows.map((r: any) => ({ id: String(r.id), title: r.title ? String(r.title) : 'Untitled assessment' }));
  } catch (e: any) {
    logFail(MOD, 'testOptions', e);
    return [];
  }
}

/** The people an administrator may assign to, already narrowed by the scope. */
export async function employeesInScope(
  scope: LearningScope,
  limit = 500,
): Promise<{ ok: boolean; rows: { id: string; name: string; hasAccount: boolean }[]; error?: string }> {
  if (!scope.canSeeAnything) return { ok: true, rows: [] };
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, (e.user_id IS NOT NULL) AS has_account
        FROM hr_employees e
       WHERE e.is_active = true ${scopeFilter(scope)}
       ORDER BY e.full_name ASC
       LIMIT ${Math.min(Math.max(limit, 1), 1000)}`));
    return {
      ok: true,
      rows: rows.map((r: any) => ({
        id: String(r.id),
        name: r.full_name ? String(r.full_name) : 'Unnamed record',
        hasAccount: r.has_account === true,
      })),
    };
  } catch (e: any) {
    // An unreadable list must say so rather than draw as an organization with nobody in it.
    logFail(MOD, 'employeesInScope', e);
    return { ok: false, rows: [], error: e?.cause?.message || e?.message || 'The employee list could not be read.' };
  }
}

export interface ScopedAssignment {
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  userId: string | null;
  courseId: string;
  courseTitle: string;
  required: boolean;
  dueOn: string | null;
  storedPct: number | null;
  completedAt: string | null;
  overdue: boolean;
}

/**
 * Assigned learning inside a scope, for the console list.
 *
 * The percentage shown here is the STORED one, straight from training_enrollments — the figure the
 * two players fight over. The reconciled figure costs a query per row and lives on the person page,
 * where it can be recomputed. A screen that quietly showed a different number from the one in the
 * database would hide the very disagreement this build exists to surface.
 */
export async function assignmentsInScope(
  scope: LearningScope,
  opts: { overdueOnly?: boolean; limit?: number } = {},
): Promise<{ ok: boolean; rows: ScopedAssignment[]; error?: string }> {
  if (!scope.canSeeAnything) return { ok: true, rows: [] };
  const lim = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    await ensurePerformanceSchema();
    const today = civilToday();
    const overdue = opts.overdueOnly === true
      ? sql`AND a.due_on IS NOT NULL AND a.due_on < ${today}::date AND en.completed_at IS NULL`
      : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT a.id, a.employee_id, a.user_id, a.course_id, a.required, a.due_on,
             e.full_name, c.title AS course_title,
             en.progress_pct, en.completed_at
        FROM hr_learning_assignments a
        JOIN hr_employees e ON e.id = a.employee_id
        LEFT JOIN training_courses c ON c.id = a.course_id
        LEFT JOIN training_enrollments en ON en.course_id = a.course_id AND en.user_id = a.user_id
       WHERE a.status = 'assigned' ${overdue} ${scopeFilter(scope)}
       ORDER BY a.due_on ASC NULLS LAST, e.full_name ASC
       LIMIT ${lim}`));
    return {
      ok: true,
      rows: rows.map((r: any) => {
        const dueOn = isoDay(r.due_on);
        const completedAt = iso(r.completed_at);
        return {
          assignmentId: String(r.id),
          employeeId: String(r.employee_id),
          employeeName: r.full_name ? String(r.full_name) : 'Unnamed record',
          userId: r.user_id ? String(r.user_id) : null,
          courseId: String(r.course_id),
          courseTitle: r.course_title ? String(r.course_title) : 'A course no longer in the catalogue',
          required: r.required === true,
          dueOn,
          storedPct: r.progress_pct === null || r.progress_pct === undefined ? null : Number(r.progress_pct),
          completedAt,
          overdue: !completedAt && !!dueOn && dueOn < today,
        };
      }),
    };
  } catch (e: any) {
    logFail(MOD, 'assignmentsInScope', e);
    return { ok: false, rows: [], error: e?.cause?.message || e?.message || 'The assignment list could not be read.' };
  }
}

/** Which employee an assignment belongs to, so a scope can be checked before it is changed. */
export async function assignmentOwner(assignmentId: string): Promise<string | null> {
  if (!isUuid(assignmentId)) return null;
  try {
    await ensurePerformanceSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT employee_id FROM hr_learning_assignments WHERE id = ${assignmentId}::uuid LIMIT 1`));
    return r.length ? String(r[0].employee_id) : null;
  } catch (e: any) {
    logFail(MOD, 'assignmentOwner', e);
    return null; // fail closed: the caller refuses the action
  }
}

/** Department id to name, for the group labels. Read as ::text — the id is a slug in one schema. */
export async function departmentNameMap(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT d.id::text AS id, d.name FROM departments d ORDER BY d.name ASC LIMIT 300`));
    for (const r of rows) out.set(String(r.id), String(r.name || r.id));
  } catch (e: any) {
    logFail(MOD, 'departmentNameMap', e);
  }
  return out;
}
