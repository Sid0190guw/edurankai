// src/lib/enrolment.ts — Enrolment & academic records (Prompt 17). An accepted applicant (Prompt 16)
// enrols (becomes a student with a stage via RBAC) and enrols in courses respecting prerequisites
// (a prereq course counts as met when the student holds its credential — Prompt 10) and capacity.
// The academic record aggregates real enrolments, completions (P4), assessment results (P8), and
// credentials (P10). Registrar-managed. The prereq/capacity checks are pure and unit-tested.

/** Prerequisites are met when every required course is among the student's credentialed courses. Pure. */
export function meetsPrereqs(requiredCourseIds: string[], credentialedCourseIds: string[]): boolean {
  const held = new Set(credentialedCourseIds);
  return requiredCourseIds.every((id) => held.has(id));
}
/** Capacity check: null/0 capacity means uncapped. Pure. */
export function capacityOk(currentCount: number, capacity: number | null): boolean {
  return capacity == null || capacity <= 0 || currentCount < capacity;
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureEnrolmentSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_enrolments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, course_obj_id UUID NOT NULL, status TEXT NOT NULL DEFAULT 'active', enrolled_by UUID, enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, course_obj_id))`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_course_meta (course_obj_id UUID PRIMARY KEY, capacity INT, prereq_course_ids TEXT[] NOT NULL DEFAULT '{}')`));
  booted = true;
}

/** Make a user a student at a stage (via the RBAC roster). Idempotent. */
export async function enrolStudent(userId: string, stage: string, by: string | null): Promise<void> {
  const { ensureRbacSchema } = await import('@/lib/rbac');
  await ensureRbacSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO rbac_user_roles (user_id, role_key, stage, assigned_by) VALUES (${userId}, 'student', ${stage || 'undergraduate'}, ${by})
    ON CONFLICT (user_id, role_key) DO UPDATE SET stage = COALESCE(EXCLUDED.stage, rbac_user_roles.stage)`);
}
async function credentialedCourses(userId: string): Promise<string[]> {
  try { const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT course_obj_id FROM edu_credentials WHERE user_id = ${userId} AND revoked = false`)).map((r: any) => r.course_obj_id); } catch { return []; }
}
export async function courseMeta(courseObjId: string): Promise<{ capacity: number | null; prereqs: string[] }> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT capacity, prereq_course_ids FROM edu_course_meta WHERE course_obj_id = ${courseObjId} LIMIT 1`))[0];
  return { capacity: r?.capacity ?? null, prereqs: r?.prereq_course_ids || [] };
}
export async function setCourseMeta(courseObjId: string, capacity: number | null, prereqs: string[]): Promise<void> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_course_meta (course_obj_id, capacity, prereq_course_ids) VALUES (${courseObjId}, ${capacity}, ${prereqs}) ON CONFLICT (course_obj_id) DO UPDATE SET capacity = ${capacity}, prereq_course_ids = ${prereqs}`);
}
export async function enrolInCourse(userId: string, courseObjId: string, by: string | null): Promise<{ ok: boolean; error?: string }> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  const meta = await courseMeta(courseObjId);
  if (meta.prereqs.length && !meetsPrereqs(meta.prereqs, await credentialedCourses(userId))) return { ok: false, error: 'prerequisites not met' };
  const count = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_enrolments WHERE course_obj_id = ${courseObjId} AND status = 'active'`))[0]?.c || 0);
  if (!capacityOk(count, meta.capacity)) return { ok: false, error: 'course is full' };
  await db.execute(sql`INSERT INTO edu_enrolments (user_id, course_obj_id, enrolled_by) VALUES (${userId}, ${courseObjId}, ${by}) ON CONFLICT (user_id, course_obj_id) DO NOTHING`);
  return { ok: true };
}
export async function myEnrolments(userId: string): Promise<any[]> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT course_obj_id, status, enrolled_at FROM edu_enrolments WHERE user_id = ${userId} ORDER BY enrolled_at DESC`));
}

/** Aggregate academic record: enrolments (with titles), completions, official results, credentials. */
export async function academicRecord(userId: string): Promise<any> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  const q = async (s: any) => { try { return rows(await db.execute(s)); } catch { return []; } };
  const { contentService } = await import('@/lib/kernel-content');
  const svc = contentService();
  const enrolments = await myEnrolments(userId);
  for (const e of enrolments) { const v = await svc.getUnitView(e.course_obj_id).catch(() => null); e.title = v ? (v.unit.data as any).title : '(course)'; }
  const completions = Number((await q(sql`SELECT COUNT(*) FILTER (WHERE completed)::int AS c FROM edu_progress WHERE user_id = ${userId}`))[0]?.c || 0);
  const results = await q(sql`SELECT assessment_id, pct, passed, mode, graded_at FROM edu_attempts WHERE user_id = ${userId} AND mode = 'official' ORDER BY graded_at DESC NULLS LAST LIMIT 50`);
  const credentials = await q(sql`SELECT code, course_title, issued_at, revoked FROM edu_credentials WHERE user_id = ${userId} ORDER BY issued_at DESC`);
  return { enrolments, completions, results, credentials };
}
export async function listStudents(limit = 100): Promise<any[]> {
  await ensureEnrolmentSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT ur.user_id, ur.stage, u.name, u.email, (SELECT COUNT(*)::int FROM edu_enrolments e WHERE e.user_id = ur.user_id) AS courses
    FROM rbac_user_roles ur LEFT JOIN users u ON u.id = ur.user_id WHERE ur.role_key = 'student' ORDER BY u.name LIMIT ${limit}`));
}
