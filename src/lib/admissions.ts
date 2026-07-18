// src/lib/admissions.ts — Admissions (Prompt 16). An applicant submits an application + completes a
// structured screening interview (recorded transcript, scored to a rubric); a registrar reviews and
// records a decision (accept/waitlist/reject) with reasons; on accept the applicant becomes
// enrolment-eligible (hand-off to Prompt 17). The AI tutor gateway (Prompt 9) may enrich the
// interview when configured, but scoring is a documented, deterministic v1 heuristic (pure, tested).
// Honest: this is a screening AID, not accreditation.

export const INTERVIEW_QUESTIONS = [
  'Why do you want to join this programme, and what do you hope to achieve?',
  'Describe relevant experience, projects, or study that prepared you for it.',
  'Tell us about a challenge you worked through and what you learned.',
  'What will you contribute to the learning community?',
];
export const RUBRIC = [
  { key: 'motivation', label: 'Motivation & goals' },
  { key: 'experience', label: 'Relevant preparation' },
  { key: 'resilience', label: 'Resilience & learning' },
  { key: 'fit', label: 'Community fit' },
];

/** Deterministic v1 rubric score (0–100) from answer substance: each answer scored on length +
 *  distinct-word coverage, averaged across the four criteria. Documented + extensible (the LLM
 *  gateway can replace this). Pure — never random. */
export function scoreInterview(answers: string[]): { score: number; perCriterion: { key: string; score: number }[] } {
  const per = RUBRIC.map((c, i) => {
    const a = (answers[i] || '').trim();
    const words = new Set(a.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    const lenScore = Math.min(60, Math.floor(a.length / 4));          // up to 60 for a substantive answer
    const varietyScore = Math.min(40, words.size * 3);                // up to 40 for distinct vocabulary
    return { key: c.key, score: a ? Math.min(100, lenScore + varietyScore) : 0 };
  });
  const score = per.length ? Math.round(per.reduce((s, p) => s + p.score, 0) / per.length) : 0;
  return { score, perCriterion: per };
}

export type AppStatus = 'submitted' | 'interviewing' | 'interviewed' | 'accepted' | 'waitlisted' | 'rejected';
export const DECISIONS: AppStatus[] = ['accepted', 'waitlisted', 'rejected'];
export function canDecide(status: string): boolean { return status === 'submitted' || status === 'interviewing' || status === 'interviewed'; }
/** Only an accepted application makes the applicant enrolment-eligible (hand-off to Prompt 17). Pure. */
export function isEnrolmentEligible(status: string): boolean { return status === 'accepted'; }

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureAdmissionsSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_applications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, program TEXT NOT NULL, profile JSONB NOT NULL DEFAULT '{}'::jsonb, status TEXT NOT NULL DEFAULT 'submitted', transcript JSONB NOT NULL DEFAULT '[]'::jsonb, score INT, rubric JSONB NOT NULL DEFAULT '[]'::jsonb, decision_by UUID, decision_reason TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_apps_user_idx ON edu_applications (user_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_apps_status_idx ON edu_applications (status)`));
  booted = true;
}
export async function myApplication(userId: string): Promise<any | null> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_applications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`))[0] || null;
}
export async function submitApplication(userId: string, program: string, profile: any): Promise<string> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_applications (user_id, program, profile, status) VALUES (${userId}, ${program}, ${JSON.stringify(profile || {})}::jsonb, 'submitted') RETURNING id`));
  return r[0].id;
}
export async function saveInterview(appId: string, userId: string, answers: string[]): Promise<{ score: number }> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  const transcript = INTERVIEW_QUESTIONS.map((q, i) => ({ q, a: (answers[i] || '').slice(0, 4000) }));
  const { score, perCriterion } = scoreInterview(answers);
  await db.execute(sql`UPDATE edu_applications SET transcript = ${JSON.stringify(transcript)}::jsonb, score = ${score}, rubric = ${JSON.stringify(perCriterion)}::jsonb, status = 'interviewed' WHERE id = ${appId} AND user_id = ${userId}`);
  return { score };
}
export async function recordDecision(appId: string, decision: AppStatus, reason: string, by: string): Promise<void> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_applications SET status = ${decision}, decision_reason = ${reason || ''}, decision_by = ${by}, decided_at = NOW() WHERE id = ${appId}`);
}
export async function listApplications(status?: string, limit = 100): Promise<any[]> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT a.*, u.name AS applicant, u.email FROM edu_applications a LEFT JOIN users u ON u.id = a.user_id ${status ? sql`WHERE a.status = ${status}` : sql``} ORDER BY a.created_at DESC LIMIT ${limit}`));
}
export async function getApplication(appId: string): Promise<any | null> {
  await ensureAdmissionsSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT a.*, u.name AS applicant, u.email FROM edu_applications a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ${appId} LIMIT 1`))[0] || null;
}
