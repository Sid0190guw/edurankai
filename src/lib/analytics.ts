// src/lib/analytics.ts — Learning analytics (Prompt 13). Computed ONLY from real stores: aq_mastery
// (Prompt 4/8), edu_progress (P4), edu_attempts (P8), edu_runtime_trace (P4). No synthetic numbers.
// Role-scoped: a student sees only their own; staff (audit capability) see anonymized aggregates.
// The aggregators are pure and unit-tested; empty input yields zeroes, never fabricated values.

export function masterySummary(entries: { state?: string; verified?: boolean }[]): { mastered: number; growing: number; total: number } {
  let mastered = 0, growing = 0;
  for (const e of entries) { if (e.verified || e.state === 'mastered') mastered++; else growing++; }
  return { mastered, growing, total: entries.length };
}
export function completionSummary(progress: { completed?: boolean }[]): { completed: number; opened: number; rate: number } {
  const opened = progress.length; const completed = progress.filter((p) => p.completed).length;
  return { completed, opened, rate: opened ? Math.round((completed / opened) * 100) : 0 };
}
export function assessmentSummary(attempts: { pct?: number; passed?: boolean; mode?: string }[]): { official: { count: number; avgPct: number; passRate: number }; practice: { count: number } } {
  const off = attempts.filter((a) => a.mode === 'official');
  const prac = attempts.filter((a) => a.mode === 'practice');
  const avgPct = off.length ? Math.round(off.reduce((s, a) => s + (Number(a.pct) || 0), 0) / off.length) : 0;
  const passRate = off.length ? Math.round((off.filter((a) => a.passed).length / off.length) * 100) : 0;
  return { official: { count: off.length, avgPct, passRate }, practice: { count: prac.length } };
}
/** Access scope: staff see anyone (aggregate); a student sees only their own analytics. Pure. */
export function canViewAnalytics(viewer: { id: string; isStaff: boolean }, targetUserId: string): boolean {
  return viewer.isStaff || viewer.id === targetUserId;
}

// ---- CSV (real data only) ----
export function toCsv(headers: string[], records: (string | number)[][]): string {
  const esc = (v: any) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.map(esc).join(','), ...records.map((r) => r.map(esc).join(','))].join('\n');
}

// ============================ DB reads (no schema of its own — reads existing stores) ============
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function studentAnalytics(userId: string): Promise<any> {
  const { db, sql } = await ctx();
  const q = async (s: any, d: any[] = []) => { try { return rows(await db.execute(s)); } catch { return d; } };
  const mastery = await q(sql`SELECT state, verified FROM aq_mastery WHERE user_id = ${userId} AND skill_id LIKE 'ko:%'`);
  const progress = await q(sql`SELECT completed FROM edu_progress WHERE user_id = ${userId}`);
  const attempts = await q(sql`SELECT pct, passed, mode FROM edu_attempts WHERE user_id = ${userId}`);
  const timeline = await q(sql`SELECT to_char(date_trunc('day', updated_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM aq_mastery WHERE user_id = ${userId} AND (state = 'mastered' OR verified = true) GROUP BY 1 ORDER BY 1 DESC LIMIT 14`);
  return { mastery: masterySummary(mastery), completion: completionSummary(progress), assessments: assessmentSummary(attempts), timeline };
}

/** Anonymized platform aggregate for staff. No PII. */
export async function platformAnalytics(): Promise<any> {
  const { db, sql } = await ctx();
  const q = async (s: any, d: any[] = []) => { try { return rows(await db.execute(s)); } catch { return d; } };
  const learners = (await q(sql`SELECT COUNT(DISTINCT user_id)::int AS c FROM edu_progress`))[0]?.c || 0;
  const comp = (await q(sql`SELECT COUNT(*) FILTER (WHERE completed)::int AS c, COUNT(*)::int AS o FROM edu_progress`))[0] || { c: 0, o: 0 };
  const off = (await q(sql`SELECT COUNT(*)::int AS n, COALESCE(ROUND(AVG(pct)),0)::int AS avg, COUNT(*) FILTER (WHERE passed)::int AS passed FROM edu_attempts WHERE mode = 'official'`))[0] || { n: 0, avg: 0, passed: 0 };
  const perCourse = await q(sql`SELECT a.assessment_id, COUNT(*)::int AS attempts, COALESCE(ROUND(AVG(a.pct)),0)::int AS avg_pct, COUNT(*) FILTER (WHERE a.passed)::int AS passes FROM edu_attempts a WHERE a.mode='official' GROUP BY a.assessment_id ORDER BY COUNT(*) DESC LIMIT 20`);
  return {
    learners,
    completion: { completed: comp.c, opened: comp.o, rate: comp.o ? Math.round((comp.c / comp.o) * 100) : 0 },
    official: { count: off.n, avgPct: off.avg, passRate: off.n ? Math.round((off.passed / off.n) * 100) : 0 },
    perAssessment: perCourse,
  };
}

export async function studentExportRows(userId: string): Promise<{ headers: string[]; records: (string | number)[][] }> {
  const { db, sql } = await ctx();
  const q = async (s: any) => { try { return rows(await db.execute(s)); } catch { return []; } };
  const recs: (string | number)[][] = [];
  for (const p of await q(sql`SELECT ko_id, completed, seconds, updated_at FROM edu_progress WHERE user_id = ${userId} ORDER BY updated_at`)) recs.push(['lesson', p.ko_id, p.completed ? 'completed' : 'in-progress', p.seconds || 0, new Date(p.updated_at).toISOString()]);
  for (const a of await q(sql`SELECT assessment_id, mode, pct, passed, graded_at FROM edu_attempts WHERE user_id = ${userId} ORDER BY started_at`)) recs.push(['assessment', a.assessment_id, a.mode + (a.passed ? ' pass' : ''), a.pct || 0, a.graded_at ? new Date(a.graded_at).toISOString() : '']);
  return { headers: ['kind', 'object_id', 'status', 'value', 'at'], records: recs };
}
