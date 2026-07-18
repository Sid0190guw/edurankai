// src/lib/xp-ledger.ts — Gamification, auditable ledger (Prompt 15). Complements the existing
// generic gamification (learner_streaks/xp_events) with what it lacks: an AUDITABLE, idempotent XP
// ledger for real kernel-learning actions (lesson complete, assessment pass) — re-doing the same
// lesson never double-awards (UNIQUE award_key). Daily streaks, badges (criteria from real stats),
// leaderboards (opt-out honored), weekly leagues (promotion/relegation on real weekly XP). The
// scoring/streak/badge/league logic is pure and unit-tested.

export type XpAction = 'lesson_complete' | 'assessment_pass' | 'assessment_practice' | 'mastery';
export const DEFAULT_XP: Record<XpAction, number> = { lesson_complete: 10, assessment_pass: 25, assessment_practice: 2, mastery: 5 };

/** Deterministic idempotency key — a UNIQUE index on it prevents double-awards. Pure. */
export function awardKey(userId: string, action: string, objectId: string): string { return `${userId}|${action}|${objectId}`; }

function dayDiff(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
/** Streak: same day = unchanged; consecutive day = +1; a gap resets to 1. Pure. */
export function nextStreak(prev: { streak: number; lastDay: string | null }, today: string): { streak: number; lastDay: string } {
  if (!prev.lastDay) return { streak: 1, lastDay: today };
  const d = dayDiff(prev.lastDay, today);
  if (d <= 0) return { streak: prev.streak, lastDay: prev.lastDay };
  if (d === 1) return { streak: prev.streak + 1, lastDay: today };
  return { streak: 1, lastDay: today };
}

export interface GamerStats { lessons: number; mastered: number; streak: number; perfectPass: boolean; xp: number }
export const BADGES: { id: string; label: string; test: (s: GamerStats) => boolean }[] = [
  { id: 'first_steps', label: 'First lesson', test: (s) => s.lessons >= 1 },
  { id: 'ten_lessons', label: '10 lessons', test: (s) => s.lessons >= 10 },
  { id: 'ten_mastered', label: '10 concepts mastered', test: (s) => s.mastered >= 10 },
  { id: 'perfect_pass', label: 'Perfect score', test: (s) => s.perfectPass },
  { id: 'week_streak', label: '7-day streak', test: (s) => s.streak >= 7 },
  { id: 'xp_500', label: '500 XP', test: (s) => s.xp >= 500 },
];
export function evaluateBadges(stats: GamerStats): string[] { return BADGES.filter((b) => b.test(stats)).map((b) => b.id); }

export interface LeaderEntry { userId: string; name: string; xp: number; optOut?: boolean }
export function rankLeaderboard(entries: LeaderEntry[]): LeaderEntry[] { return entries.filter((e) => !e.optOut).sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name)); }
export function leagueResult(rankedWeekly: LeaderEntry[], promote = 3, relegate = 3): { promoted: string[]; relegated: string[] } {
  const r = rankLeaderboard(rankedWeekly);
  const promoted = r.slice(0, promote).map((e) => e.userId);
  const relegated = r.slice(Math.max(promote, r.length - relegate)).map((e) => e.userId);
  return { promoted, relegated };
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureXpSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_xp_ledger (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, action TEXT NOT NULL, object_id TEXT NOT NULL DEFAULT '', xp INT NOT NULL DEFAULT 0, award_key TEXT NOT NULL UNIQUE, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_xp_user_idx ON edu_xp_ledger (user_id, at DESC)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_gamer_state (user_id UUID PRIMARY KEY, streak INT NOT NULL DEFAULT 0, last_day TEXT, opt_out BOOLEAN NOT NULL DEFAULT false)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_xp_config (id INTEGER PRIMARY KEY DEFAULT 1, values JSONB NOT NULL DEFAULT '{}'::jsonb)`));
  booted = true;
}
export async function getXpConfig(): Promise<Record<string, number>> {
  try { await ensureXpSchema(); const { db, sql } = await ctx(); const r = rows(await db.execute(sql`SELECT values FROM edu_xp_config WHERE id = 1 LIMIT 1`))[0]; return { ...DEFAULT_XP, ...(r?.values || {}) }; }
  catch { return { ...DEFAULT_XP }; }
}
export async function setXpConfig(values: Record<string, number>): Promise<void> {
  await ensureXpSchema(); const { db, sql } = await ctx();
  const clean: Record<string, number> = {}; for (const k of Object.keys(DEFAULT_XP)) if (typeof values[k] === 'number' && values[k] >= 0) clean[k] = Math.floor(values[k]);
  await db.execute(sql`INSERT INTO edu_xp_config (id, values) VALUES (1, ${JSON.stringify(clean)}::jsonb) ON CONFLICT (id) DO UPDATE SET values = ${JSON.stringify(clean)}::jsonb`);
}
/** Idempotent award: ON CONFLICT (award_key) DO NOTHING; advances the streak only when new. Returns xp awarded (0 = repeat). */
export async function awardXp(userId: string, action: XpAction, objectId: string): Promise<number> {
  await ensureXpSchema(); const { db, sql } = await ctx();
  const xp = (await getXpConfig())[action] || 0;
  const ins = rows(await db.execute(sql`INSERT INTO edu_xp_ledger (user_id, action, object_id, xp, award_key) VALUES (${userId}, ${action}, ${objectId}, ${xp}, ${awardKey(userId, action, objectId)}) ON CONFLICT (award_key) DO NOTHING RETURNING id`));
  if (!ins.length) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const st = rows(await db.execute(sql`SELECT streak, last_day FROM edu_gamer_state WHERE user_id = ${userId} LIMIT 1`))[0] || { streak: 0, last_day: null };
  const ns = nextStreak({ streak: st.streak || 0, lastDay: st.last_day || null }, today);
  await db.execute(sql`INSERT INTO edu_gamer_state (user_id, streak, last_day) VALUES (${userId}, ${ns.streak}, ${ns.lastDay}) ON CONFLICT (user_id) DO UPDATE SET streak = ${ns.streak}, last_day = ${ns.lastDay}`);
  return xp;
}
export async function totalXp(userId: string): Promise<number> {
  await ensureXpSchema(); const { db, sql } = await ctx(); return Number(rows(await db.execute(sql`SELECT COALESCE(SUM(xp),0)::int AS x FROM edu_xp_ledger WHERE user_id = ${userId}`))[0]?.x || 0);
}
export async function gamerState(userId: string): Promise<{ streak: number; optOut: boolean }> {
  await ensureXpSchema(); const { db, sql } = await ctx(); const r = rows(await db.execute(sql`SELECT streak, opt_out FROM edu_gamer_state WHERE user_id = ${userId} LIMIT 1`))[0];
  return { streak: r?.streak || 0, optOut: !!r?.opt_out };
}
export async function setOptOut(userId: string, optOut: boolean): Promise<void> {
  await ensureXpSchema(); const { db, sql } = await ctx(); await db.execute(sql`INSERT INTO edu_gamer_state (user_id, opt_out) VALUES (${userId}, ${optOut}) ON CONFLICT (user_id) DO UPDATE SET opt_out = ${optOut}`);
}
async function board(where: any, limit: number): Promise<LeaderEntry[]> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT l.user_id, u.name, SUM(l.xp)::int AS xp, COALESCE(g.opt_out,false) AS opt_out
    FROM edu_xp_ledger l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN edu_gamer_state g ON g.user_id = l.user_id ${where}
    GROUP BY l.user_id, u.name, g.opt_out ORDER BY SUM(l.xp) DESC LIMIT 200`));
  return rankLeaderboard(r.map((x: any) => ({ userId: x.user_id, name: x.name || 'learner', xp: x.xp, optOut: x.opt_out }))).slice(0, limit);
}
export async function leaderboard(limit = 25): Promise<LeaderEntry[]> { await ensureXpSchema(); const { sql } = await ctx(); return board(sql``, limit); }
export async function weeklyLeaderboard(limit = 25): Promise<LeaderEntry[]> { await ensureXpSchema(); const { sql } = await ctx(); return board(sql`WHERE l.at > NOW() - interval '7 days'`, limit); }
export async function recentLedger(limit = 50): Promise<any[]> {
  await ensureXpSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT l.*, u.name AS user_name FROM edu_xp_ledger l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.at DESC LIMIT ${limit}`));
}
