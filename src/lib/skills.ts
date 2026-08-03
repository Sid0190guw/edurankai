// src/lib/skills.ts — THE SKILL MATRIX. Skill, level, evidence; per employee and per department.
//
// =================================================================================================
// WHO MAY RECORD A LEVEL, AND WHY IT IS NOT ONE ANSWER
// =================================================================================================
//
// Three writers, and each is a different kind of claim:
//
//   SELF      an employee records their own level. `source = 'self'`. Always allowed, and it is
//             what fills the matrix in the first place.
//   MANAGER   somebody the Organization Graph says answers for that person's work records a level.
//             `source = 'manager'`. A RELATIONSHIP, per row, resolved by canSeePerformanceOf() —
//             never a role name and never "same department".
//   ORG       a `skills.manage` holder records a level for anybody. `source = 'manager'` too, since
//             from the employee's point of view it is an assessment somebody else made.
//
// The source is STORED, so the matrix can say whether a level is somebody's own claim or somebody
// else's assessment. A grid that shows both as the same number is a grid that overstates what it
// knows.
//
// =================================================================================================
// THE AGGREGATE IS A COUNT OF PEOPLE, NOT A LIST OF THEM
// =================================================================================================
//
// departmentMatrix() returns one row per (skill, department) with a headcount and an average level.
// It deliberately does NOT return a row per person: a department view exists to answer "where are we
// thin", and turning it into a per-person ranking is a different screen with different consequences
// for the people on it.
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
  SKILLS_MANAGE,
  uuidList,
  type PerfViewer,
} from '@/lib/performance-scope';

const MOD = 'skills';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/**
 * Five levels, with words rather than numbers on the screen. A bare "3" means nothing to the person
 * being rated, and a scale nobody understands is a scale everybody games.
 */
export const SKILL_LEVELS = [
  { level: 1, label: 'Aware', hint: 'Has seen it done and understands what it is for.' },
  { level: 2, label: 'Assisted', hint: 'Can do it with someone alongside.' },
  { level: 3, label: 'Independent', hint: 'Can do it alone, reliably, on ordinary work.' },
  { level: 4, label: 'Coaches', hint: 'Can teach it and unblock other people.' },
  { level: 5, label: 'Sets direction', hint: 'Decides how the organization does it.' },
] as const;

export const SKILL_LEVEL_LABELS: Record<number, string> = {
  1: 'Aware', 2: 'Assisted', 3: 'Independent', 4: 'Coaches', 5: 'Sets direction',
};

export const SKILL_SOURCES = ['self', 'manager', 'course', 'assessment'] as const;
export const SKILL_SOURCE_LABELS: Record<string, string> = {
  self: 'Recorded by the employee',
  manager: 'Assessed by a manager',
  course: 'Evidenced by a course',
  assessment: 'Evidenced by an assessment',
};

export interface Skill {
  id: string;
  name: string;
  category: string;
  description: string | null;
  isActive: boolean;
  /** How many people have recorded this skill at all. */
  holders: number;
}

export interface EmployeeSkill {
  id: string;
  employeeId: string;
  employeeName: string | null;
  skillId: string;
  skillName: string;
  category: string;
  level: number;
  levelLabel: string;
  evidence: string | null;
  evidenceUrl: string | null;
  source: string;
  assessedAt: string | null;
}

export interface DepartmentSkillCell {
  skillId: string;
  skillName: string;
  category: string;
  departmentId: string | null;
  departmentName: string;
  people: number;
  averageLevel: number;
  /** How many are at level 4 or 5 — the "who could teach this" number. */
  strong: number;
}

export interface SkillWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

function mapSkill(r: any): Skill {
  return {
    id: String(r?.id ?? ''),
    name: r?.name ? String(r.name) : '',
    category: r?.category ? String(r.category) : 'general',
    description: r?.description ? String(r.description) : null,
    isActive: r?.is_active !== false,
    holders: Number(r?.holders) || 0,
  };
}

function mapEmployeeSkill(r: any): EmployeeSkill {
  const level = Math.min(Math.max(Number(r?.level) || 1, 1), 5);
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    skillId: String(r?.skill_id ?? ''),
    skillName: r?.skill_name ? String(r.skill_name) : '',
    category: r?.category ? String(r.category) : 'general',
    level,
    levelLabel: SKILL_LEVEL_LABELS[level] || String(level),
    evidence: r?.evidence ? String(r.evidence) : null,
    evidenceUrl: r?.evidence_url ? String(r.evidence_url) : null,
    source: String(r?.source ?? 'self'),
    assessedAt: r?.assessed_at ? new Date(r.assessed_at).toISOString() : null,
  };
}

// -------------------------------------------------------------------------------------------------
// THE CATALOGUE
// -------------------------------------------------------------------------------------------------

/** Every skill, with how many people hold it. Retired skills are excluded unless asked for. */
export async function listSkills(opts: { includeRetired?: boolean } = {}): Promise<Skill[]> {
  try {
    await ensurePerformanceSchema();
    const activeFilter = opts.includeRetired === true ? sql`` : sql`WHERE s.is_active = true`;
    const rows = rowsOf(await db.execute(sql`
      SELECT s.*,
             (SELECT COUNT(*)::int FROM hr_employee_skills es WHERE es.skill_id = s.id) AS holders
        FROM hr_skills s
        ${activeFilter}
       ORDER BY s.category ASC, s.name ASC
       LIMIT 500`));
    return rows.map(mapSkill);
  } catch (e: any) {
    logFail(MOD, 'listSkills', e);
    return [];
  }
}

/**
 * Add a skill to the catalogue.
 *
 * `skills.manage` territory — the caller checks it, and this re-checks nothing about roles. The
 * unique index is on lower(name), so "TypeScript" and "typescript" collide and the second one is
 * reported as already existing rather than silently creating a second column on every matrix.
 */
export async function createSkill(input: {
  name: string;
  category?: string | null;
  description?: string | null;
  actorUserId?: string | null;
}): Promise<SkillWriteResult> {
  const name = clean(input?.name, 120);
  if (!name) return { ok: false, error: 'Give the skill a name.' };
  const category = clean(input?.category, 60) || 'general';
  const description = clean(input?.description, 1000) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_skills (name, category, description, created_by_user_id)
      VALUES (${name}, ${category}, ${description}::text, ${actor}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!rows.length) {
      // The unique index on lower(name) rejected it. That is not a failure of the write path, it is
      // the answer: the skill is already there.
      const existing = rowsOf(await db.execute(sql`
        SELECT id FROM hr_skills WHERE lower(name) = lower(${name}) LIMIT 1`));
      if (existing.length) {
        return { ok: false, id: String(existing[0].id), error: 'That skill is already in the catalogue.' };
      }
      return { ok: false, error: WRITE_FAILED };
    }
    await logAudit({
      userId: actor,
      action: 'skill.create',
      entity: 'hr_skills',
      entityId: String(rows[0].id),
      diff: { name, category },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'createSkill', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Retire a skill. NOT a delete: the levels people recorded against it stay, because deleting a skill
 * would erase evidence somebody entered about their own work. A retired skill drops out of the
 * pickers and stays on the record.
 */
export async function retireSkill(skillId: string, actorUserId?: string | null): Promise<SkillWriteResult> {
  if (!isUuid(skillId)) return { ok: false, error: 'That skill does not exist.' };
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_skills SET is_active = false WHERE id = ${skillId}::uuid RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That skill does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'skill.retire',
      entity: 'hr_skills',
      entityId: skillId,
      diff: {},
    });
    return { ok: true, id: skillId };
  } catch (e: any) {
    logFail(MOD, 'retireSkill', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// PER EMPLOYEE
// -------------------------------------------------------------------------------------------------

/** One person's recorded skills, strongest first. */
export async function skillsForEmployee(employeeId: string): Promise<EmployeeSkill[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT es.*, s.name AS skill_name, s.category, e.full_name AS employee_name
        FROM hr_employee_skills es
        JOIN hr_skills s ON s.id = es.skill_id
        LEFT JOIN hr_employees e ON e.id = es.employee_id
       WHERE es.employee_id = ${employeeId}::uuid
       ORDER BY es.level DESC, s.name ASC
       LIMIT 200`));
    return rows.map(mapEmployeeSkill);
  } catch (e: any) {
    logFail(MOD, 'skillsForEmployee', e);
    return [];
  }
}

/** Skills across a set of people — a manager looking at their team. */
export async function skillsForEmployees(employeeIds: readonly string[]): Promise<EmployeeSkill[]> {
  const ids = employeeIds.filter(isUuid);
  if (ids.length === 0) return []; // never emit `IN ()`
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT es.*, s.name AS skill_name, s.category, e.full_name AS employee_name
        FROM hr_employee_skills es
        JOIN hr_skills s ON s.id = es.skill_id
        LEFT JOIN hr_employees e ON e.id = es.employee_id
       WHERE es.employee_id IN (${uuidList(ids)})
       ORDER BY e.full_name ASC, es.level DESC
       LIMIT 500`));
    return rows.map(mapEmployeeSkill);
  } catch (e: any) {
    logFail(MOD, 'skillsForEmployees', e);
    return [];
  }
}

/**
 * Record or update a level.
 *
 * AUTHORIZATION, IN ORDER OF NARROWNESS, and every arm is checked here rather than only on the page:
 *   1. it is your own skill — always;
 *   2. `skills.manage` — anybody in the organization;
 *   3. a RELATIONSHIP from the Organization Graph — your report, resolved by canSeePerformanceOf().
 *
 * There is no fourth arm and no role name. When none of the three fires, the refusal names the
 * missing relationship rather than saying "not allowed", so somebody can act on it.
 */
export async function setEmployeeSkill(
  viewer: PerfViewer,
  input: {
    employeeId: string;
    skillId: string;
    level: number;
    evidence?: string | null;
    evidenceUrl?: string | null;
    /**
     * True when the CALLER holds `skills.manage`.
     *
     * PASSED IN RATHER THAN RESOLVED HERE, and it must not be replaced by `viewer.managesOrg`.
     * PerfViewer.managesOrg carries `performance.manage`, which is a DIFFERENT capability: today the
     * same two roles hold both, so reading the wrong one would work perfectly and go unnoticed until
     * somebody granted one without the other — at which point a skills-desk account would silently
     * lose the org-wide arm, or a performance-desk account would silently gain it. This module reads
     * no authorization engine of its own; the page asks can(user, 'skills.manage') and hands the
     * answer down.
     */
    orgWide?: boolean;
  },
): Promise<SkillWriteResult> {
  const employeeId = String(input?.employeeId || '');
  const skillId = String(input?.skillId || '');
  if (!isUuid(employeeId) || !isUuid(skillId)) return { ok: false, error: 'Choose a person and a skill.' };
  const level = Math.round(Number(input?.level));
  if (!isFinite(level) || level < 1 || level > 5) return { ok: false, error: 'Pick a level from 1 to 5.' };

  const own = viewer.employeeId === employeeId;
  const orgWide = input?.orgWide === true;
  if (!own && !orgWide && !(await canSeePerformanceOf(viewer, employeeId))) {
    return {
      ok: false,
      error: viewer.initialized
        ? 'The Organization Graph does not record you as answering for this person\'s work, so you cannot assess their skills.'
        : 'The Organization Graph has not been set up yet, so no reporting line can be confirmed. '
          + 'Only the employee can record their own level until it is.',
    };
  }

  const source = own ? 'self' : 'manager';
  const evidence = clean(input?.evidence, 2000) || null;
  const evidenceUrl = clean(input?.evidenceUrl, 500) || null;
  if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) {
    return { ok: false, error: 'An evidence link must start with http:// or https://' };
  }

  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_employee_skills
        (employee_id, skill_id, level, evidence, evidence_url, source, assessed_by_user_id, assessed_at)
      VALUES
        (${employeeId}::uuid, ${skillId}::uuid, ${level}::int, ${evidence}::text, ${evidenceUrl}::text,
         ${source}, ${viewer.userId}::uuid, NOW())
      ON CONFLICT (employee_id, skill_id) DO UPDATE
        SET level = EXCLUDED.level,
            evidence = EXCLUDED.evidence,
            evidence_url = EXCLUDED.evidence_url,
            source = EXCLUDED.source,
            assessed_by_user_id = EXCLUDED.assessed_by_user_id,
            assessed_at = NOW()
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: viewer.userId,
      action: own ? 'skill.self.record' : 'skill.assess',
      entity: 'hr_employee_skills',
      entityId: String(rows[0].id),
      diff: { employeeId, skillId, level, source },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'setEmployeeSkill', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Remove a recorded level — the employee's own, or one a manager may assess. */
export async function removeEmployeeSkill(
  viewer: PerfViewer,
  employeeSkillId: string,
  /** True when the caller holds `skills.manage` — see the note on setEmployeeSkill's `orgWide`. */
  orgWide = false,
): Promise<SkillWriteResult> {
  if (!isUuid(employeeSkillId)) return { ok: false, error: 'That entry does not exist.' };
  try {
    await ensurePerformanceSchema();
    const found = rowsOf(await db.execute(sql`
      SELECT employee_id FROM hr_employee_skills WHERE id = ${employeeSkillId}::uuid LIMIT 1`));
    if (!found.length) return { ok: false, error: 'That entry does not exist.' };
    const employeeId = String(found[0].employee_id);
    const own = viewer.employeeId === employeeId;
    if (!own && !orgWide && !(await canSeePerformanceOf(viewer, employeeId))) {
      return { ok: false, error: 'That is not yours to remove.' };
    }
    await db.execute(sql`DELETE FROM hr_employee_skills WHERE id = ${employeeSkillId}::uuid`);
    await logAudit({
      userId: viewer.userId,
      action: 'skill.remove',
      entity: 'hr_employee_skills',
      entityId: employeeSkillId,
      diff: { employeeId },
    });
    return { ok: true, id: employeeSkillId };
  } catch (e: any) {
    logFail(MOD, 'removeEmployeeSkill', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE AGGREGATE
// -------------------------------------------------------------------------------------------------

/**
 * The department skill matrix: one cell per (skill, department).
 *
 * DEPARTMENT IDS ARE COMPARED ::text ON BOTH SIDES. `departments.id` is varchar(50) — a slug — in
 * src/lib/db/schema.ts and UUID in db/hr-schema.sql, so a ::uuid cast throws the first time a slug
 * arrives, and half this product's department ids are slugs.
 *
 * PEOPLE WITH NO DEPARTMENT ARE NOT DROPPED. hr_employees.department_id has exactly one writer, so a
 * record HR created by hand often has none; those rows are grouped under a named "No department
 * recorded" cell rather than vanishing, because a silently short matrix reads as complete.
 */
export async function departmentMatrix(
  opts: { departmentId?: string | null } = {},
): Promise<DepartmentSkillCell[]> {
  try {
    await ensurePerformanceSchema();
    const dept = opts.departmentId ? String(opts.departmentId).trim() : '';
    const deptFilter = dept ? sql`AND e.department_id::text = ${dept}` : sql``;
    const rows = rowsOf(await db.execute(sql`
      SELECT s.id AS skill_id,
             s.name AS skill_name,
             s.category AS category,
             e.department_id::text AS department_id,
             COALESCE(d.name, 'No department recorded') AS department_name,
             COUNT(*)::int AS people,
             ROUND(AVG(es.level)::numeric, 1) AS average_level,
             COUNT(*) FILTER (WHERE es.level >= 4)::int AS strong
        FROM hr_employee_skills es
        JOIN hr_skills s ON s.id = es.skill_id
        JOIN hr_employees e ON e.id = es.employee_id AND e.is_active = true
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE s.is_active = true ${deptFilter}
       GROUP BY s.id, s.name, s.category, e.department_id::text, d.name
       ORDER BY department_name ASC, people DESC, s.name ASC
       LIMIT 500`));
    return rows.map((r: any) => ({
      skillId: String(r.skill_id),
      skillName: String(r.skill_name || ''),
      category: String(r.category || 'general'),
      departmentId: r.department_id ? String(r.department_id) : null,
      departmentName: String(r.department_name || 'No department recorded'),
      people: Number(r.people) || 0,
      averageLevel: Number(r.average_level) || 0,
      strong: Number(r.strong) || 0,
    }));
  } catch (e: any) {
    logFail(MOD, 'departmentMatrix', e);
    return [];
  }
}

/**
 * SKILL GAPS: catalogued skills that nobody, or almost nobody, holds at level 3 or above.
 *
 * Read it as a prompt for a conversation, not as a verdict. It counts what people have RECORDED,
 * and an unrecorded skill looks identical to an absent one — which is why the copy on the screen
 * says so rather than presenting this as a measurement of the organization.
 */
export async function skillGaps(threshold = 1): Promise<{ skillId: string; skillName: string; category: string; capable: number }[]> {
  const min = Math.max(0, Math.round(Number(threshold) || 0));
  try {
    await ensurePerformanceSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT s.id AS skill_id, s.name AS skill_name, s.category,
             COUNT(es.id) FILTER (WHERE es.level >= 3)::int AS capable
        FROM hr_skills s
        LEFT JOIN hr_employee_skills es ON es.skill_id = s.id
        LEFT JOIN hr_employees e ON e.id = es.employee_id AND e.is_active = true
       WHERE s.is_active = true
       GROUP BY s.id, s.name, s.category
      HAVING COUNT(es.id) FILTER (WHERE es.level >= 3) <= ${min}
       ORDER BY capable ASC, s.name ASC
       LIMIT 100`));
    return rows.map((r: any) => ({
      skillId: String(r.skill_id),
      skillName: String(r.skill_name || ''),
      category: String(r.category || 'general'),
      capable: Number(r.capable) || 0,
    }));
  } catch (e: any) {
    logFail(MOD, 'skillGaps', e);
    return [];
  }
}

/** Re-exported so a page can name the capability without importing two modules for one string. */
export { SKILLS_MANAGE };
