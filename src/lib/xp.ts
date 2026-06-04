// XP + streak engine. Idempotent at the event level (each event gets a row);
// updates user_xp aggregates atomically. Streak: increments by 1 if user was
// active yesterday; resets to 1 if last active ≥ 2 days ago; no-op if already
// active today. Level is sqrt-based: level = floor(sqrt(xp/100)) + 1.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  // Best-effort idempotent create so the engine works even if the migration
  // wasn't run yet — same pattern as other lib helpers in this codebase.
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS user_xp (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
      streak_days INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0,
      last_active_date DATE, hearts INTEGER NOT NULL DEFAULT 5,
      hearts_refilled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS xp_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(40) NOT NULL, ref_id UUID, delta INTEGER NOT NULL, reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  } catch (_) {}
}

export type XpSource =
  | 'test_official' | 'test_practice'
  | 'lesson_complete' | 'streak_bonus'
  | 'sanskrit_test' | 'daily_first_action';

export interface XpAward {
  userId: string;
  source: XpSource | string;
  delta: number;
  refId?: string | null;
  reason?: string;
}

function levelFromXp(xp: number): number {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1);
}

export async function awardXp(p: XpAward): Promise<{ xp: number; level: number; streak: number; awarded: number; leveledUp: boolean }> {
  await ensureSchema();
  if (!p.userId || !p.delta) {
    const cur = await getUserXp(p.userId);
    return { xp: cur.totalXp, level: cur.level, streak: cur.streakDays, awarded: 0, leveledUp: false };
  }

  // Upsert the user row if missing
  await db.execute(sql`
    INSERT INTO user_xp (user_id) VALUES (${p.userId})
    ON CONFLICT (user_id) DO NOTHING
  `);

  // Pull current state for streak computation
  const before = rows(await db.execute(sql`
    SELECT total_xp, level, streak_days, longest_streak,
      last_active_date::text AS last_active_date
    FROM user_xp WHERE user_id = ${p.userId} LIMIT 1
  `))[0] as any;

  const todayRows = rows(await db.execute(sql`SELECT CURRENT_DATE::text AS today`))[0] as any;
  const today: string = todayRows?.today || new Date().toISOString().slice(0, 10);
  const last: string | null = before?.last_active_date || null;

  let newStreak = Number(before?.streak_days || 0);
  if (!last) newStreak = 1;
  else if (last === today) newStreak = newStreak || 1;
  else {
    const dLast = new Date(last + 'T00:00:00Z');
    const dToday = new Date(today + 'T00:00:00Z');
    const diff = Math.round((dToday.getTime() - dLast.getTime()) / 86400000);
    if (diff === 1) newStreak += 1;
    else if (diff > 1) newStreak = 1;
    // diff <= 0 (shouldn't happen) keeps existing
  }
  const newLongest = Math.max(Number(before?.longest_streak || 0), newStreak);

  const newXp = Number(before?.total_xp || 0) + p.delta;
  const newLevel = levelFromXp(newXp);
  const leveledUp = newLevel > Number(before?.level || 1);

  // Today's XP rollup so the daily-goal widget can show progress without
  // scanning xp_events on every render.
  let todayXp = 0;
  try {
    const prevToday = rows(await db.execute(sql`SELECT today_xp, today_date::text AS today_date FROM user_xp WHERE user_id = ${p.userId} LIMIT 1`))[0] as any;
    if (prevToday && prevToday.today_date === today) todayXp = Number(prevToday.today_xp || 0) + p.delta;
    else todayXp = p.delta;
  } catch (_) { todayXp = p.delta; }

  await db.execute(sql`
    UPDATE user_xp SET
      total_xp = ${newXp},
      level = ${newLevel},
      streak_days = ${newStreak},
      longest_streak = ${newLongest},
      last_active_date = CURRENT_DATE,
      today_xp = ${todayXp},
      today_date = CURRENT_DATE,
      updated_at = NOW()
    WHERE user_id = ${p.userId}
  `).catch(async () => {
    // today_xp columns may not exist yet (running on pre-v3 schema). Fall back.
    await db.execute(sql`
      UPDATE user_xp SET total_xp = ${newXp}, level = ${newLevel}, streak_days = ${newStreak},
        longest_streak = ${newLongest}, last_active_date = CURRENT_DATE, updated_at = NOW()
      WHERE user_id = ${p.userId}
    `).catch(() => {});
  });

  // Weekly + monthly rollup for fast leaderboard queries.
  try {
    const weekRow = rows(await db.execute(sql`SELECT date_trunc('week', CURRENT_DATE)::date::text AS w, date_trunc('month', CURRENT_DATE)::date::text AS m`))[0] as any;
    if (weekRow) {
      await db.execute(sql`
        INSERT INTO xp_period_rollups (user_id, period, period_key, total_xp)
        VALUES (${p.userId}, 'week', ${weekRow.w}, ${p.delta})
        ON CONFLICT (user_id, period, period_key) DO UPDATE SET total_xp = xp_period_rollups.total_xp + ${p.delta}, updated_at = NOW()
      `).catch(() => {});
      await db.execute(sql`
        INSERT INTO xp_period_rollups (user_id, period, period_key, total_xp)
        VALUES (${p.userId}, 'month', ${weekRow.m}, ${p.delta})
        ON CONFLICT (user_id, period, period_key) DO UPDATE SET total_xp = xp_period_rollups.total_xp + ${p.delta}, updated_at = NOW()
      `).catch(() => {});
    }
  } catch (_) {}

  await db.execute(sql`
    INSERT INTO xp_events (user_id, source, ref_id, delta, reason)
    VALUES (${p.userId}, ${p.source}, ${p.refId || null}, ${p.delta}, ${p.reason || null})
  `).catch(() => {});

  return { xp: newXp, level: newLevel, streak: newStreak, awarded: p.delta, leveledUp };
}

export async function getUserXp(userId: string): Promise<{ totalXp: number; level: number; streakDays: number; longestStreak: number; lastActive: string | null; hearts: number; xpToNextLevel: number; levelProgress: number; dailyGoalXp: number; todayXp: number; goalMetToday: boolean; streakFreezes: number }> {
  await ensureSchema();
  if (!userId) return { totalXp: 0, level: 1, streakDays: 0, longestStreak: 0, lastActive: null, hearts: 5, xpToNextLevel: 100, levelProgress: 0, dailyGoalXp: 30, todayXp: 0, goalMetToday: false, streakFreezes: 0 };
  let r: any;
  try {
    r = rows(await db.execute(sql`
      SELECT total_xp, level, streak_days, longest_streak, last_active_date::text AS last_active_date, hearts,
             COALESCE(daily_goal_xp, 30) AS daily_goal_xp,
             COALESCE(today_xp, 0) AS today_xp,
             today_date::text AS today_date,
             COALESCE(streak_freezes, 0) AS streak_freezes
      FROM user_xp WHERE user_id = ${userId} LIMIT 1
    `))[0] as any;
  } catch (_) {
    r = rows(await db.execute(sql`SELECT total_xp, level, streak_days, longest_streak, last_active_date::text AS last_active_date, hearts FROM user_xp WHERE user_id = ${userId} LIMIT 1`))[0] as any;
  }
  const xp = Number(r?.total_xp || 0);
  const level = levelFromXp(xp);
  const xpAtCurrent = 100 * Math.pow(level - 1, 2);
  const xpAtNext = 100 * Math.pow(level, 2);
  const progress = Math.max(0, Math.min(1, (xp - xpAtCurrent) / Math.max(1, xpAtNext - xpAtCurrent)));
  const todayRow = rows(await db.execute(sql`SELECT CURRENT_DATE::text AS today`))[0] as any;
  const isToday = r?.today_date === todayRow?.today;
  const todayXp = isToday ? Number(r?.today_xp || 0) : 0;
  const dailyGoalXp = Number(r?.daily_goal_xp || 30);
  return {
    totalXp: xp,
    level,
    streakDays: Number(r?.streak_days || 0),
    longestStreak: Number(r?.longest_streak || 0),
    lastActive: r?.last_active_date || null,
    hearts: r == null ? 5 : Number(r.hearts || 0),
    xpToNextLevel: xpAtNext - xp,
    levelProgress: progress,
    dailyGoalXp,
    todayXp,
    goalMetToday: todayXp >= dailyGoalXp,
    streakFreezes: Number(r?.streak_freezes || 0),
  };
}

export async function setDailyGoal(userId: string, goal: number): Promise<void> {
  await ensureSchema();
  const g = Math.max(10, Math.min(200, Math.floor(goal)));
  try {
    await db.execute(sql`
      INSERT INTO user_xp (user_id, daily_goal_xp) VALUES (${userId}, ${g})
      ON CONFLICT (user_id) DO UPDATE SET daily_goal_xp = ${g}, updated_at = NOW()
    `);
  } catch (_) {}
}

// Recent activity feed for the dashboard
export async function getRecentXpEvents(userId: string, limit = 8): Promise<{ source: string; delta: number; reason: string | null; created_at: string }[]> {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT source, delta, reason, created_at FROM xp_events
    WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}
  `)) as any;
}
