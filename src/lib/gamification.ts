// Gamification: learner streaks, XP, badges, leaderboard.
// Self-bootstrapping schema. All helpers idempotent and safe to call from any page/API.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureGamificationSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // Per-learner streak + XP rollup. One row per user.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS learner_streaks (
        user_id UUID PRIMARY KEY,
        current_streak_days INT NOT NULL DEFAULT 0,
        longest_streak_days INT NOT NULL DEFAULT 0,
        last_active_date DATE,
        total_xp INT NOT NULL DEFAULT 0,
        level INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      // Awarded badges. UNIQUE(user_id, badge_key) prevents double-awards.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS learner_badges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        badge_key VARCHAR(80) NOT NULL,
        badge_name VARCHAR(160) NOT NULL,
        badge_description TEXT,
        icon_svg TEXT,
        awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, badge_key)
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_learner_badges_user ON learner_badges(user_id, awarded_at DESC)`);

      // Raw XP event log — append-only audit trail for every XP earn.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS xp_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        source VARCHAR(60) NOT NULL,
        source_id VARCHAR(140),
        xp_amount INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id, created_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

// level = floor(sqrt(xp / 100)) + 1
export function xpToLevel(xp: number): number {
  const x = Math.max(0, Math.floor(xp || 0));
  return Math.floor(Math.sqrt(x / 100)) + 1;
}

// XP threshold to *reach* level L (inverse): (L-1)^2 * 100
export function levelToXp(level: number): number {
  const L = Math.max(1, Math.floor(level || 1));
  return (L - 1) * (L - 1) * 100;
}

export function xpProgressForUser(totalXp: number) {
  const xp = Math.max(0, Math.floor(totalXp || 0));
  const level = xpToLevel(xp);
  const floorXp = levelToXp(level);
  const ceilXp = levelToXp(level + 1);
  const span = Math.max(1, ceilXp - floorXp);
  const earned = Math.max(0, xp - floorXp);
  const pct = Math.min(100, Math.round((earned / span) * 100));
  return { level, totalXp: xp, floorXp, ceilXp, earnedInLevel: earned, neededForLevel: span, toNextLevel: Math.max(0, ceilXp - xp), pct };
}

// Award XP; updates total_xp + level on learner_streaks. Returns new totals.
export async function awardXp(userId: string, source: string, amount: number, sourceId?: string | null) {
  await ensureGamificationSchema();
  if (!userId || !source) return { ok: false, error: 'missing-args' };
  const xp = Math.max(0, Math.floor(amount || 0));
  if (xp === 0) return { ok: true, totalXp: 0, level: 1, leveledUp: false };
  try {
    await db.execute(sql`INSERT INTO xp_events (user_id, source, source_id, xp_amount) VALUES (${userId}, ${source}, ${sourceId || null}, ${xp})`);
    // Ensure the streak row exists
    await db.execute(sql`INSERT INTO learner_streaks (user_id, total_xp, level) VALUES (${userId}, 0, 1) ON CONFLICT (user_id) DO NOTHING`);
    const before = rows(await db.execute(sql`SELECT total_xp, level FROM learner_streaks WHERE user_id = ${userId} LIMIT 1`))[0];
    const prevXp = Number(before?.total_xp || 0);
    const prevLevel = Number(before?.level || 1);
    const newXp = prevXp + xp;
    const newLevel = xpToLevel(newXp);
    await db.execute(sql`UPDATE learner_streaks SET total_xp = ${newXp}, level = ${newLevel}, updated_at = NOW() WHERE user_id = ${userId}`);
    return { ok: true, totalXp: newXp, level: newLevel, leveledUp: newLevel > prevLevel };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Award a badge. Idempotent via UNIQUE(user_id, badge_key) — re-awards are no-ops.
export async function awardBadge(userId: string, key: string, name: string, description: string, iconSvg: string) {
  await ensureGamificationSchema();
  if (!userId || !key || !name) return { ok: false, error: 'missing-args' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO learner_badges (user_id, badge_key, badge_name, badge_description, icon_svg)
      VALUES (${userId}, ${key}, ${name}, ${description || null}, ${iconSvg || null})
      ON CONFLICT (user_id, badge_key) DO NOTHING
      RETURNING id, awarded_at
    `));
    return { ok: true, newlyAwarded: r.length > 0, id: r[0]?.id || null };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Record a daily activity: bumps streak if user was active yesterday, resets if there's a gap.
export async function recordActivity(userId: string) {
  await ensureGamificationSchema();
  if (!userId) return { ok: false, error: 'missing-userId' };
  try {
    await db.execute(sql`INSERT INTO learner_streaks (user_id, current_streak_days, longest_streak_days, last_active_date)
      VALUES (${userId}, 1, 1, CURRENT_DATE)
      ON CONFLICT (user_id) DO NOTHING`);
    const current = rows(await db.execute(sql`SELECT current_streak_days, longest_streak_days, last_active_date FROM learner_streaks WHERE user_id = ${userId} LIMIT 1`))[0];
    if (!current) return { ok: false, error: 'no-row' };
    const last = current.last_active_date ? new Date(current.last_active_date) : null;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const lastStr = last ? new Date(last).toISOString().slice(0, 10) : null;
    if (lastStr === todayStr) {
      // already counted for today — no-op
      return { ok: true, currentStreak: Number(current.current_streak_days || 0), longestStreak: Number(current.longest_streak_days || 0), bumped: false };
    }
    // compute gap in days
    let newStreak = 1;
    if (lastStr) {
      const ms = new Date(todayStr + 'T00:00:00Z').getTime() - new Date(lastStr + 'T00:00:00Z').getTime();
      const days = Math.round(ms / 86400000);
      if (days === 1) newStreak = Number(current.current_streak_days || 0) + 1;
      else newStreak = 1;
    }
    const newLongest = Math.max(newStreak, Number(current.longest_streak_days || 0));
    await db.execute(sql`UPDATE learner_streaks SET current_streak_days = ${newStreak}, longest_streak_days = ${newLongest}, last_active_date = CURRENT_DATE, updated_at = NOW() WHERE user_id = ${userId}`);
    return { ok: true, currentStreak: newStreak, longestStreak: newLongest, bumped: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Leaderboard: top N learners by total_xp. Optionally returns the requesting user's rank too.
export async function getLeaderboard(limit: number = 20) {
  await ensureGamificationSchema();
  const cap = Math.min(200, Math.max(1, Math.floor(limit || 20)));
  try {
    const rs = rows(await db.execute(sql`
      SELECT
        ls.user_id,
        ls.total_xp,
        ls.level,
        ls.current_streak_days,
        ls.longest_streak_days,
        COALESCE(u.full_name, u.email, 'Learner') AS display_name,
        u.email,
        ROW_NUMBER() OVER (ORDER BY ls.total_xp DESC, ls.user_id ASC) AS rank
      FROM learner_streaks ls
      LEFT JOIN users u ON u.id = ls.user_id
      WHERE ls.total_xp > 0
      ORDER BY ls.total_xp DESC, ls.user_id ASC
      LIMIT ${cap}
    `));
    return rs;
  } catch (_) {
    return [];
  }
}

// Get a single learner's stats (streak, xp, level, badge count, leaderboard rank).
export async function getLearnerStats(userId: string) {
  await ensureGamificationSchema();
  if (!userId) return null;
  try {
    // Make sure the row exists so first-time visitors see zeros, not nulls.
    await db.execute(sql`INSERT INTO learner_streaks (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
    const streak = rows(await db.execute(sql`SELECT current_streak_days, longest_streak_days, last_active_date, total_xp, level FROM learner_streaks WHERE user_id = ${userId} LIMIT 1`))[0] || {};
    const totalXp = Number(streak.total_xp || 0);
    const progress = xpProgressForUser(totalXp);
    const badges = rows(await db.execute(sql`
      SELECT id, badge_key, badge_name, badge_description, icon_svg, awarded_at
      FROM learner_badges WHERE user_id = ${userId}
      ORDER BY awarded_at DESC
    `));
    const totalBadges = badges.length;
    const recentBadges = badges.slice(0, 8);
    let rank: number | null = null;
    if (totalXp > 0) {
      const ahead = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM learner_streaks WHERE total_xp > ${totalXp}`))[0];
      rank = Number(ahead?.c || 0) + 1;
    }
    const recentXp = rows(await db.execute(sql`
      SELECT source, source_id, xp_amount, created_at
      FROM xp_events WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 12
    `));
    return {
      userId,
      currentStreak: Number(streak.current_streak_days || 0),
      longestStreak: Number(streak.longest_streak_days || 0),
      lastActiveDate: streak.last_active_date || null,
      totalXp,
      level: progress.level,
      progress,
      totalBadges,
      recentBadges,
      rank,
      recentXp,
    };
  } catch (_) {
    return null;
  }
}
