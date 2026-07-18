// src/lib/assessment.ts — Assessment engine + authoring (Prompt 8). Assessments are kernel
// AssessmentObjects attached to a KnowledgeObject/Course via the `assesses` edge; items live in
// an item bank (edu_assessment_items). TWO modes: free PRACTICE (unscored, instant feedback, never
// affects eligibility) and OFFICIAL scored attempts (recorded, update aq_mastery, gate credential
// eligibility). Objective items auto-grade; short-answer routes to a reviewer_examiner manual queue.
import { contentService } from '@/lib/kernel-content';
import { createPgKernel } from '@/lib/kernel';

export type ItemType = 'mcq' | 'numeric' | 'true_false' | 'short_answer';
export interface Item { id: string; type: ItemType; prompt: string; options?: string[]; answer: any; points: number }
export interface Response { choice?: number; value?: number | boolean | string; text?: string }
export interface ItemGrade { objective: boolean; correct?: boolean; points: number; needsManual: boolean }

/** Auto-grade one item against a response. Objective types grade deterministically; short-answer
 *  is never auto-graded (routes to the manual queue). Pure. */
export function gradeItem(item: Item, resp: Response = {}): ItemGrade {
  switch (item.type) {
    case 'mcq': { const ok = typeof resp.choice === 'number' && resp.choice === item.answer?.correctIndex; return { objective: true, correct: ok, points: ok ? item.points : 0, needsManual: false }; }
    case 'true_false': { const ok = typeof resp.value === 'boolean' && resp.value === item.answer?.value; return { objective: true, correct: ok, points: ok ? item.points : 0, needsManual: false }; }
    case 'numeric': { const tol = Number(item.answer?.tolerance || 0); const ok = typeof resp.value === 'number' && Math.abs(resp.value - Number(item.answer?.value)) <= tol; return { objective: true, correct: ok, points: ok ? item.points : 0, needsManual: false }; }
    case 'short_answer': return { objective: false, needsManual: true, points: 0 };
    default: return { objective: false, needsManual: true, points: 0 };
  }
}

export interface AttemptGrade { autoScore: number; maxScore: number; manualItemIds: string[]; needsManual: boolean; perItem: Record<string, ItemGrade> }
/** Grade a whole attempt: sum objective points, collect items needing manual grading. Pure. */
export function gradeAttempt(items: Item[], responses: Record<string, Response>): AttemptGrade {
  let autoScore = 0, maxScore = 0; const manualItemIds: string[] = []; const perItem: Record<string, ItemGrade> = {};
  for (const it of items) { maxScore += it.points; const g = gradeItem(it, responses[it.id] || {}); perItem[it.id] = g; if (g.needsManual) manualItemIds.push(it.id); else autoScore += g.points; }
  return { autoScore, maxScore, manualItemIds, needsManual: manualItemIds.length > 0, perItem };
}
export function scorePct(autoScore: number, manualScore: number, maxScore: number): number {
  return maxScore > 0 ? Math.round(((autoScore + manualScore) / maxScore) * 1000) / 10 : 0;
}
export function passed(pct: number, passMark = 60): boolean { return pct >= passMark; }
/** Only an OFFICIAL passing attempt affects credential eligibility; practice never does. Pure. */
export function affectsEligibility(mode: string, isPass: boolean): boolean { return mode === 'official' && isPass === true; }

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureAssessmentSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_assessment_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assessment_id UUID NOT NULL, type TEXT NOT NULL, prompt TEXT NOT NULL, options JSONB NOT NULL DEFAULT '[]'::jsonb, answer JSONB NOT NULL DEFAULT '{}'::jsonb, points INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_assess_items_idx ON edu_assessment_items (assessment_id, sort)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, assessment_id UUID NOT NULL, mode TEXT NOT NULL DEFAULT 'practice', state TEXT NOT NULL DEFAULT 'in_progress', responses JSONB NOT NULL DEFAULT '{}'::jsonb, auto_score INTEGER NOT NULL DEFAULT 0, manual_score INTEGER NOT NULL DEFAULT 0, max_score INTEGER NOT NULL DEFAULT 0, pct REAL NOT NULL DEFAULT 0, passed BOOLEAN NOT NULL DEFAULT false, pass_mark INTEGER NOT NULL DEFAULT 60, grader_id UUID, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), submitted_at TIMESTAMPTZ, graded_at TIMESTAMPTZ)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_attempts_user_idx ON edu_attempts (user_id, assessment_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_attempts_state_idx ON edu_attempts (state)`));
  booted = true;
}

/** Create a kernel AssessmentObject and attach it (assesses) to a KnowledgeObject/Course. */
export async function createAssessment(title: string, kind: string, assessedObjectId: string, owner: string | null, securityLabels: string[] = ['public']): Promise<string> {
  const repo = createPgKernel();
  const a = await repo.createObject({ type: 'AssessmentObject', data: { title, kind }, owner, securityLabels: securityLabels as any });
  await repo.addRelationship(a.id, 'assesses', assessedObjectId);
  return a.id;
}
export async function publishAssessment(id: string): Promise<void> {
  const repo = createPgKernel();
  let o = await repo.getObject(id); if (!o) throw new Error('assessment not found');
  if (o.lifecycleState === 'created') { await repo.validateObject(id); o = await repo.getObject(id); }
  if (o!.lifecycleState === 'validated') { await repo.indexObject(id); o = await repo.getObject(id); }
  if (o!.lifecycleState === 'indexed') { await repo.publishObject(id); }
}
async function assessedKOs(assessmentId: string): Promise<string[]> {
  try { const g = await createPgKernel().getObjectGraph(assessmentId); return g.outgoing.filter((e) => e.type === 'assesses').map((e) => e.toId); } catch { return []; }
}

export async function addItem(assessmentId: string, item: { type: ItemType; prompt: string; options?: string[]; answer: any; points?: number; sort?: number }): Promise<string> {
  await ensureAssessmentSchema(); const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_assessment_items (assessment_id, type, prompt, options, answer, points, sort)
    VALUES (${assessmentId}, ${item.type}, ${item.prompt}, ${JSON.stringify(item.options || [])}::jsonb, ${JSON.stringify(item.answer || {})}::jsonb, ${item.points ?? 1}, ${item.sort ?? 0}) RETURNING id`));
  return r[0].id;
}
export async function deleteItem(id: string): Promise<void> { await ensureAssessmentSchema(); const { db, sql } = await ctx(); await db.execute(sql`DELETE FROM edu_assessment_items WHERE id = ${id}`); }

/** List items. For a student attempt, pass includeAnswers=false to strip correct answers. */
export async function listItems(assessmentId: string, includeAnswers = false): Promise<any[]> {
  await ensureAssessmentSchema(); const { db, sql } = await ctx();
  const items = rows(await db.execute(sql`SELECT id, type, prompt, options, answer, points, sort FROM edu_assessment_items WHERE assessment_id = ${assessmentId} ORDER BY sort, created_at`));
  return includeAnswers ? items : items.map((i: any) => ({ id: i.id, type: i.type, prompt: i.prompt, options: i.options, points: i.points, sort: i.sort }));
}

export async function startAttempt(userId: string, assessmentId: string, mode: 'practice' | 'official'): Promise<string> {
  await ensureAssessmentSchema(); const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_attempts (user_id, assessment_id, mode, state) VALUES (${userId}, ${assessmentId}, ${mode}, 'in_progress') RETURNING id`));
  return r[0].id;
}

/** Submit responses: auto-grade objective items; official pass updates mastery; short-answer ->
 *  pending manual grade. Practice attempts are recorded but NEVER affect eligibility. */
export async function submitAttempt(attemptId: string, responses: Record<string, Response>): Promise<{ state: string; pct: number; passed: boolean; needsManual: boolean; perItem: Record<string, ItemGrade> }> {
  await ensureAssessmentSchema(); const { db, sql } = await ctx();
  const at = rows(await db.execute(sql`SELECT * FROM edu_attempts WHERE id = ${attemptId} LIMIT 1`))[0];
  if (!at) throw new Error('attempt not found');
  const items = (await listItems(at.assessment_id, true)) as Item[];
  const g = gradeAttempt(items, responses);
  const pct = scorePct(g.autoScore, 0, g.maxScore);
  const isPass = !g.needsManual && passed(pct, at.pass_mark);
  const state = g.needsManual ? 'pending_manual' : 'graded';
  await db.execute(sql`UPDATE edu_attempts SET responses = ${JSON.stringify(responses)}::jsonb, auto_score = ${g.autoScore}, max_score = ${g.maxScore}, pct = ${pct}, passed = ${isPass}, state = ${state}, submitted_at = NOW(), graded_at = ${g.needsManual ? null : new Date().toISOString()} WHERE id = ${attemptId}`);
  if (state === 'graded' && isPass && at.mode === 'official') await advanceMasteryFor(at.assessment_id, at.user_id);
  return { state, pct, passed: isPass, needsManual: g.needsManual, perItem: g.perItem };
}

/** Reviewer grades the manual (short-answer) items -> finalize, recompute pass, update mastery. */
export async function gradeManual(attemptId: string, manualPoints: number, graderId: string): Promise<{ pct: number; passed: boolean }> {
  await ensureAssessmentSchema(); const { db, sql } = await ctx();
  const at = rows(await db.execute(sql`SELECT * FROM edu_attempts WHERE id = ${attemptId} LIMIT 1`))[0];
  if (!at) throw new Error('attempt not found');
  const pct = scorePct(Number(at.auto_score), manualPoints, Number(at.max_score));
  const isPass = passed(pct, at.pass_mark);
  await db.execute(sql`UPDATE edu_attempts SET manual_score = ${manualPoints}, pct = ${pct}, passed = ${isPass}, state = 'graded', grader_id = ${graderId}, graded_at = NOW() WHERE id = ${attemptId}`);
  if (isPass && at.mode === 'official') await advanceMasteryFor(at.assessment_id, at.user_id);
  return { pct, passed: isPass };
}

async function advanceMasteryFor(assessmentId: string, userId: string): Promise<void> {
  const kos = await assessedKOs(assessmentId);
  if (!kos.length) return; const { db, sql } = await ctx();
  for (const ko of kos) await db.execute(sql`INSERT INTO aq_mastery (user_id, skill_id, state, verified) VALUES (${userId}, ${'ko:' + ko}, 'mastered', true) ON CONFLICT (user_id, skill_id) DO UPDATE SET state = 'mastered', verified = true, updated_at = NOW()`);
}

// ---- reads for the surfaces ----
export async function assessmentsForObject(objectId: string, publishedOnly = false): Promise<any[]> {
  try {
    const g = await createPgKernel().getObjectGraph(objectId);
    const ids = g.incoming.filter((e) => e.type === 'assesses').map((e) => e.fromId);
    const svc = contentService(); const out: any[] = [];
    for (const id of ids) { const o = await createPgKernel().getObject(id); if (!o) continue; if (publishedOnly && o.lifecycleState !== 'published') continue; out.push({ id: o.id, title: (o.data as any).title, kind: (o.data as any).kind, state: o.lifecycleState, securityLabels: (o as any).securityLabels || ['public'] }); }
    return out;
  } catch { return []; }
}
export async function listAllAssessments(): Promise<any[]> {
  const list = await createPgKernel().listByType('AssessmentObject').catch(() => []);
  return list.map((o: any) => ({ id: o.id, title: (o.data as any).title, kind: (o.data as any).kind, state: o.lifecycleState }));
}
export async function attemptById(id: string): Promise<any | null> { await ensureAssessmentSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT * FROM edu_attempts WHERE id = ${id} LIMIT 1`))[0] || null; }
export async function manualQueue(limit = 50): Promise<any[]> { await ensureAssessmentSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT a.*, u.name AS user_name FROM edu_attempts a LEFT JOIN users u ON u.id = a.user_id WHERE a.state = 'pending_manual' ORDER BY a.submitted_at LIMIT ${limit}`)); }
export async function listAttempts(limit = 50, offset = 0, assessmentId?: string): Promise<any[]> { await ensureAssessmentSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT a.*, u.name AS user_name FROM edu_attempts a LEFT JOIN users u ON u.id = a.user_id ${assessmentId ? sql`WHERE a.assessment_id = ${assessmentId}` : sql``} ORDER BY a.started_at DESC LIMIT ${limit} OFFSET ${offset}`)); }
/** Official passed attempts drive credential eligibility (Prompt 10). Practice never counts. */
export async function officialPasses(userId: string): Promise<string[]> { await ensureAssessmentSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT DISTINCT assessment_id FROM edu_attempts WHERE user_id = ${userId} AND mode = 'official' AND state = 'graded' AND passed = true`)).map((r: any) => r.assessment_id); }
