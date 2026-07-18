// src/lib/credential.ts — Verifiable course Credentials (Prompt 10). A student who passes a
// course's REQUIRED official assessments (Prompt 8) becomes eligible; a registrar (or an automated
// rule) issues a Credential at a stable public URL, independently verifiable with NO login,
// revocable, and tamper-evident via an HMAC signature over the credential fields. This is a
// distinct kernel-course credential — the existing universal_certificates system is left intact.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Stable per-deploy secret. Set CREDENTIAL_SIGNING_SECRET in the environment for production;
// changing it invalidates previously-issued signatures, so keep it stable.
const SECRET = process.env.CREDENTIAL_SIGNING_SECRET || process.env.SESSION_SECRET || 'edurankai-credential-signing-v1';

export interface CredentialFields {
  code: string;
  userId: string;
  courseObjId: string;
  holderName: string;
  courseTitle: string;
  competencies: string[];
  issuedAt: string;
}

/** Canonical, order-stable serialization so the signature is reproducible. Pure. */
export function canonical(f: CredentialFields): string {
  return JSON.stringify([f.code, f.userId, f.courseObjId, f.holderName, f.courseTitle, [...f.competencies], f.issuedAt]);
}
/** HMAC-SHA256 signature over the canonical fields. Pure. */
export function signCredential(f: CredentialFields, secret = SECRET): string {
  return createHmac('sha256', secret).update(canonical(f)).digest('hex');
}
/** Tamper check: recompute and timing-safe compare. Any changed field -> false. Pure. */
export function verifyCredential(f: CredentialFields, signature: string, secret = SECRET): boolean {
  const expected = signCredential(f, secret);
  if (!signature || signature.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')); } catch { return false; }
}

/** A student is eligible only if the course has ≥1 required assessment and ALL are passed. Pure. */
export function meetsEligibility(requiredAssessmentIds: string[], officiallyPassedIds: string[]): boolean {
  if (!requiredAssessmentIds.length) return false;
  const passed = new Set(officiallyPassedIds);
  return requiredAssessmentIds.every((id) => passed.has(id));
}

/** Short, human-legible public verification code (avoids ambiguous chars). */
export function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 12; i++) s += A[Math.floor(Math.random() * A.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureCredentialSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL UNIQUE, user_id UUID NOT NULL,
    course_obj_id UUID NOT NULL, holder_name TEXT NOT NULL, course_title TEXT NOT NULL,
    competencies JSONB NOT NULL DEFAULT '[]'::jsonb, signature TEXT NOT NULL,
    issued_by UUID, issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked BOOLEAN NOT NULL DEFAULT false, revoked_at TIMESTAMPTZ, revoked_reason TEXT)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_cred_user_idx ON edu_credentials (user_id)`));
  booted = true;
}

/** Required assessments for a course = published AssessmentObjects assessing any of its KOs. */
export async function courseRequiredAssessments(courseObjId: string): Promise<string[]> {
  const { contentService } = await import('@/lib/kernel-content');
  const { assessmentsForObject } = await import('@/lib/assessment');
  const svc = contentService();
  const units = await svc.listCourseUnits(courseObjId, false).catch(() => []);
  const ids = new Set<string>();
  for (const u of units) { const a = await assessmentsForObject(u.id, true).catch(() => []); for (const x of a) ids.add(x.id); }
  return [...ids];
}
export async function courseCompetencies(courseObjId: string): Promise<string[]> {
  const { contentService } = await import('@/lib/kernel-content');
  const units = await contentService().listCourseUnits(courseObjId, true).catch(() => []);
  return units.map((u: any) => (u.data as any).title).filter(Boolean).slice(0, 40);
}
export async function isEligible(userId: string, courseObjId: string): Promise<{ eligible: boolean; required: number; passed: number }> {
  const { officialPasses } = await import('@/lib/assessment');
  const required = await courseRequiredAssessments(courseObjId);
  const passed = await officialPasses(userId);
  const passedInCourse = required.filter((id) => passed.includes(id));
  return { eligible: meetsEligibility(required, passed), required: required.length, passed: passedInCourse.length };
}

/** Issue a credential (idempotent per user+course while not revoked). Caller enforces authorization. */
export async function issueCredential(userId: string, courseObjId: string, issuedBy: string | null): Promise<{ ok: boolean; code?: string; error?: string }> {
  await ensureCredentialSchema(); const { db, sql } = await ctx();
  const el = await isEligible(userId, courseObjId);
  if (!el.eligible) return { ok: false, error: `not eligible (passed ${el.passed}/${el.required} required assessments)` };
  const existing = rows(await db.execute(sql`SELECT code FROM edu_credentials WHERE user_id = ${userId} AND course_obj_id = ${courseObjId} AND revoked = false LIMIT 1`))[0];
  if (existing) return { ok: true, code: existing.code };
  const holder = rows(await db.execute(sql`SELECT name FROM users WHERE id = ${userId} LIMIT 1`))[0]?.name || 'Learner';
  const { contentService } = await import('@/lib/kernel-content');
  const course = await contentService().getUnitView(courseObjId).catch(() => null);
  const courseTitle = (course?.unit.data as any)?.title || 'Course';
  const competencies = await courseCompetencies(courseObjId);
  const code = newCode();
  const issuedAt = new Date().toISOString();
  const fields: CredentialFields = { code, userId, courseObjId, holderName: holder, courseTitle, competencies, issuedAt };
  const signature = signCredential(fields);
  await db.execute(sql`INSERT INTO edu_credentials (code, user_id, course_obj_id, holder_name, course_title, competencies, signature, issued_by, issued_at)
    VALUES (${code}, ${userId}, ${courseObjId}, ${holder}, ${courseTitle}, ${JSON.stringify(competencies)}::jsonb, ${signature}, ${issuedBy}, ${issuedAt})`);
  return { ok: true, code };
}

export async function revokeCredential(code: string, by: string | null, reason: string): Promise<void> {
  await ensureCredentialSchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_credentials SET revoked = true, revoked_at = NOW(), revoked_reason = ${reason || 'revoked'} WHERE code = ${code}`);
}
export async function getCredentialByCode(code: string): Promise<any | null> {
  await ensureCredentialSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_credentials WHERE code = ${code} LIMIT 1`))[0] || null;
}
/** Verify a stored row: reconstruct fields + check the signature (tamper-evidence). */
export function verifyRow(row: any): { valid: boolean; revoked: boolean } {
  if (!row) return { valid: false, revoked: false };
  const fields: CredentialFields = {
    code: row.code, userId: row.user_id, courseObjId: row.course_obj_id, holderName: row.holder_name,
    courseTitle: row.course_title, competencies: row.competencies || [], issuedAt: new Date(row.issued_at).toISOString(),
  };
  return { valid: verifyCredential(fields, row.signature), revoked: !!row.revoked };
}
export async function listUserCredentials(userId: string): Promise<any[]> {
  await ensureCredentialSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_credentials WHERE user_id = ${userId} ORDER BY issued_at DESC`));
}
export async function listAllCredentials(limit = 100): Promise<any[]> {
  await ensureCredentialSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT c.*, u.name AS holder FROM edu_credentials c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.issued_at DESC LIMIT ${limit}`));
}
