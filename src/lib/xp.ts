// XP + streak engine. Idempotent at the event level (each event gets a row);
// updates user_xp aggregates atomically. Streak: increments by 1 if user was
// active yesterday; resets to 1 if last active ≥ 2 days ago; no-op if already
// active today. Level is sqrt-based: level = floor(sqrt(xp/100)) + 1.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

function ensureSchema(): Promise<void> {
  // Best-effort idempotent create so the engine works even if the migration
  // wasn't run yet — same pattern as other lib helpers in this codebase.
  return ensureOnce('user_xp', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS user_xp (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
      streak_days INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0,
      last_active_date DATE, hearts INTEGER NOT NULL DEFAULT 5,
      hearts_refilled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    // THE FOUR COLUMNS NOTHING CREATED.
    //
    // daily_goal_xp, today_xp, today_date and streak_freezes were read and written in six places
    // across this file, /api/aquintutor/shop.ts and /api/aquintutor/league-settle.ts, and were
    // created by NOTHING in the repository — the only ALTERs on user_xp anywhere are league_tier and
    // current_league_id in src/lib/leagues.ts. Every one of those statements threw on every request
    // into a catch that hid it, which is why the daily-goal widget was permanently 0/30 and a learner
    // could be charged 200 XP for a streak freeze that could not be stored, without limit, because
    // the "inventory full" guard reads a value that was always 0.
    //
    // Created here because this module owns user_xp. ADD COLUMN IF NOT EXISTS is additive: a live
    // table that already carries them under an out-of-repo migration is untouched.
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS daily_goal_xp INTEGER NOT NULL DEFAULT 30`);
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS today_xp INTEGER NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS today_date DATE`);
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS streak_freezes INTEGER NOT NULL DEFAULT 0`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS xp_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(40) NOT NULL, ref_id UUID, delta INTEGER NOT NULL, reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await reconcileXpEventsColumns();

    // xp_period_rollups had NO CREATE TABLE anywhere in the repository, and it is not only written
    // here: src/lib/friends.ts:96 and src/lib/classrooms.ts:92 LEFT JOIN it with NO try around them,
    // so the friends list and the classroom roster threw on every load — a missing table taking out
    // two surfaces that have nothing to do with XP. The UNIQUE matches the ON CONFLICT target used
    // by the two upserts below.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS xp_period_rollups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period VARCHAR(10) NOT NULL,
      period_key DATE NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, period, period_key))`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS xp_rollup_period_idx ON xp_period_rollups (period, period_key, total_xp DESC)`);

    // The XP-spend ledger. /api/aquintutor/shop.ts writes it after deducting XP and it existed
    // nowhere, so a purchase left no record at all that the XP had been spent.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS xp_shop_purchases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item VARCHAR(40) NOT NULL,
      cost_xp INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS xp_shop_user_idx ON xp_shop_purchases (user_id, created_at DESC)`);

    // Consumed by the streak-freeze auto-apply in /api/aquintutor/league-settle.ts, which reads it in
    // a NOT EXISTS subquery and upserts ON CONFLICT (user_id, saved_date). Also absent everywhere,
    // so learners who bought freezes lost their streaks anyway.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS streak_freeze_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      saved_date DATE NOT NULL,
      streak_before INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, saved_date))`);
  });
}

// xp_events is created by TWO modules with DIFFERENT shapes: this one (ref_id/delta/reason) and
// src/lib/gamification.ts (source_id/xp_amount). CREATE TABLE IF NOT EXISTS means whichever module
// touches the database first wins and the other module's every INSERT then throws on a column that
// is not there — the loser's XP log silently stops recording. Neither shape can be dropped without
// losing rows already written under it, so both are reconciled to the union instead: every column
// from both shapes present, and the two amount columns nullable so an INSERT written for either
// shape is accepted. Both writers populate both amount columns, so both readers see a number.
// Keep this function identical to reconcileXpEventsColumns() in src/lib/gamification.ts.
export async function reconcileXpEventsColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS source_id VARCHAR(140)`);
  await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS xp_amount INT`);
  await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS ref_id UUID`);
  await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS delta INTEGER`);
  await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS reason TEXT`);
  await db.execute(sql`ALTER TABLE xp_events ALTER COLUMN xp_amount DROP NOT NULL`);
  await db.execute(sql`ALTER TABLE xp_events ALTER COLUMN delta DROP NOT NULL`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ref_id is a UUID column; a non-UUID reference goes to source_id instead of throwing. */
function asUuid(v: any): string | null {
  const s = String(v ?? '').trim();
  return UUID_RE.test(s) ? s : null;
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
  } catch (e: any) {
    todayXp = p.delta;
    logEvent('error', 'xp.today_read_failed', { userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown' });
  }

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
  `).catch(async (e1: any) => {
    // The today_xp/today_date columns are created by ensureSchema() above, so reaching this fallback
    // now means the ALTER itself failed — worth saying so rather than quietly halving the write.
    logEvent('error', 'xp.award_update_fell_back', {
      userId: p.userId, reason: e1?.cause?.message || e1?.message || 'unknown',
    });
    await db.execute(sql`
      UPDATE user_xp SET total_xp = ${newXp}, level = ${newLevel}, streak_days = ${newStreak},
        longest_streak = ${newLongest}, last_active_date = CURRENT_DATE, updated_at = NOW()
      WHERE user_id = ${p.userId}
    `).catch((e2: any) => {
      // THE LAST RESORT OF THE XP WRITE. `.catch(() => {})` here meant a learner's XP, level and
      // streak were simply not recorded while awardXp() returned the new totals to a caller that
      // reported success — the numbers on screen were computed, never stored.
      logEvent('error', 'xp.award_not_recorded', {
        userId: p.userId, source: p.source, delta: p.delta,
        reason: e2?.cause?.message || e2?.message || 'unknown',
      });
    });
  });

  // Weekly + monthly rollup for fast leaderboard queries.
  try {
    const weekRow = rows(await db.execute(sql`SELECT date_trunc('week', CURRENT_DATE)::date::text AS w, date_trunc('month', CURRENT_DATE)::date::text AS m`))[0] as any;
    if (weekRow) {
      const rollupFailed = (e: any) => logEvent('error', 'xp.rollup_write_failed', {
        userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown',
      });
      await db.execute(sql`
        INSERT INTO xp_period_rollups (user_id, period, period_key, total_xp)
        VALUES (${p.userId}, 'week', ${weekRow.w}, ${p.delta})
        ON CONFLICT (user_id, period, period_key) DO UPDATE SET total_xp = xp_period_rollups.total_xp + ${p.delta}, updated_at = NOW()
      `).catch(rollupFailed);
      await db.execute(sql`
        INSERT INTO xp_period_rollups (user_id, period, period_key, total_xp)
        VALUES (${p.userId}, 'month', ${weekRow.m}, ${p.delta})
        ON CONFLICT (user_id, period, period_key) DO UPDATE SET total_xp = xp_period_rollups.total_xp + ${p.delta}, updated_at = NOW()
      `).catch(rollupFailed);
    }
  } catch (e: any) {
    // The rollups feed the league, classroom and friends leaderboards. Losing them silently is why
    // those boards could be empty with nothing anywhere explaining it.
    logEvent('error', 'xp.rollup_step_failed', { userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown' });
  }

  // Both amount columns are written so a reader on either historic shape sees the award. The
  // failure is LOGGED rather than dropped: this is the append-only XP audit trail, and a silent
  // catch here is how it would stop recording without anything on any screen saying so.
  try {
    await db.execute(sql`
      INSERT INTO xp_events (user_id, source, ref_id, source_id, delta, xp_amount, reason)
      VALUES (${p.userId}, ${p.source}, ${asUuid(p.refId)}, ${p.refId ? String(p.refId).slice(0, 140) : null},
              ${p.delta}, ${p.delta}, ${p.reason || null})
    `);
  } catch (e: any) {
    logEvent('error', 'xp.event_log_write_failed', {
      userId: p.userId, source: p.source, reason: e?.cause?.message || e?.message || 'unknown',
    });
  }

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
  } catch (e: any) {
    // Reaching this fallback means the four columns ensureSchema() adds are still missing, which
    // makes the daily goal and streak-freeze inventory read as 0 for everyone. Silence here is what
    // made that look like a product decision rather than a broken schema.
    logEvent('error', 'xp.user_xp_read_fell_back', { userId, reason: e?.cause?.message || e?.message || 'unknown' });
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

/**
 * Returns false when the goal could not be stored, so the caller can say so instead of showing the
 * learner a setting that was discarded. This used to be `catch (_) {}` on a column nothing created:
 * every save was thrown away and the UI showed the hardcoded 30 forever.
 */
export async function setDailyGoal(userId: string, goal: number): Promise<boolean> {
  await ensureSchema();
  const g = Math.max(10, Math.min(200, Math.floor(goal)));
  try {
    await db.execute(sql`
      INSERT INTO user_xp (user_id, daily_goal_xp) VALUES (${userId}, ${g})
      ON CONFLICT (user_id) DO UPDATE SET daily_goal_xp = ${g}, updated_at = NOW()
    `);
    return true;
  } catch (e: any) {
    logEvent('error', 'xp.daily_goal_not_saved', { userId, goal: g, reason: e?.cause?.message || e?.message || 'unknown' });
    return false;
  }
}

// Recent activity feed for the dashboard
export async function getRecentXpEvents(userId: string, limit = 8): Promise<{ source: string; delta: number; reason: string | null; created_at: string }[]> {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT source, COALESCE(delta, xp_amount) AS delta, reason, created_at FROM xp_events
    WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}
  `)) as any;
}
