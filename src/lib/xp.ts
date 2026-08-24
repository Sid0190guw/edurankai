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

    // IDEMPOTENCY, ADOPTED FROM THE LEDGER THIS MODULE REPLACED.
    //
    // src/lib/xp-ledger.ts is gone; it awarded XP for lesson completions and assessment passes into
    // edu_xp_ledger, and the one thing it did better than this module was a UNIQUE award_key, so
    // re-opening the same lesson could never award twice. Collapsing to one ledger without that
    // column would have been a regression dressed as a cleanup: those two paths would have paid out
    // on every re-submit. award_key is nullable and UNIQUE — Postgres does not compare NULLs, so
    // every historic row and every award that is legitimately repeatable (practice answers, daily
    // challenges) is unaffected, and only a caller that PASSES a key gets the once-only guarantee.
    await db.execute(sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS award_key TEXT`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS xp_events_award_key_uidx ON xp_events (award_key)`);

    // THE LEADERBOARD OPT-OUT REGISTER, ALSO ADOPTED RATHER THAN RE-CREATED.
    //
    // edu_gamer_state was the retired ledger's table. Its streak/last_day columns are dead —
    // user_xp.streak_days is the streak now — but opt_out holds a PRIVACY CHOICE that learners have
    // already made on /aquintutor/xp. Re-homing that choice into a new column would mean copying it,
    // and a copy that half-runs publishes by name somebody who asked not to be listed. So the column
    // stays exactly where it is and this module becomes its only reader and writer. CREATE TABLE IF
    // NOT EXISTS is here so the leaderboard's LEFT JOIN cannot throw on a database that never ran the
    // old ledger.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS edu_gamer_state (user_id UUID PRIMARY KEY, streak INT NOT NULL DEFAULT 0, last_day TEXT, opt_out BOOLEAN NOT NULL DEFAULT false)`);

    // The per-action XP amounts an admin sets on /admin/xp-config. Same reasoning: the table holds a
    // decision somebody made, and the screen that makes it is live and linked in the admin nav, so
    // the amounts move to this module instead of quietly ceasing to apply to anything.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS edu_xp_config (id INTEGER PRIMARY KEY DEFAULT 1, values JSONB NOT NULL DEFAULT '{}'::jsonb)`);

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

/**
 * Make the XP tables exist. Exported for modules that query user_xp, xp_period_rollups or the
 * leaderboard opt-out register DIRECTLY rather than through this module — without it, the first
 * such query on a fresh database throws on a missing table and the caller shows an empty board.
 */
export function ensureXpSchema(): Promise<void> {
  return ensureSchema();
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
  /**
   * Pass a key for an award that must happen AT MOST ONCE — completing a particular lesson,
   * passing a particular assessment. A repeat returns awarded:0 and touches nothing. Leave it
   * undefined for awards that are legitimately repeatable (a practice answer, a daily challenge).
   */
  awardKey?: string | null;
}

/** Deterministic once-only key. Same user + same action + same object = same key. Pure. */
export function xpAwardKey(userId: string, source: string, objectId: string): string {
  return String(userId) + '|' + String(source) + '|' + String(objectId);
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

  // ONCE-ONLY AWARDS ARE CLAIMED BEFORE ANYTHING IS PAID.
  // The event row is the claim: if the INSERT conflicts on award_key this award already
  // happened, and we return the learner's CURRENT totals with awarded:0 rather than adding the
  // XP a second time. Writing the event first is what makes that true — the old order (totals
  // first, log afterwards) can pay twice and log once.
  let eventInserted = false;
  if (p.awardKey) {
    try {
      const claim = rows(await db.execute(sql`
        INSERT INTO xp_events (user_id, source, ref_id, source_id, delta, xp_amount, reason, award_key)
        VALUES (${p.userId}, ${p.source}, ${asUuid(p.refId)}, ${p.refId ? String(p.refId).slice(0, 140) : null},
                ${p.delta}, ${p.delta}, ${p.reason || null}, ${p.awardKey})
        ON CONFLICT DO NOTHING RETURNING id
      `));
      if (claim.length === 0) {
        const cur = await getUserXp(p.userId);
        return { xp: cur.totalXp, level: cur.level, streak: cur.streakDays, awarded: 0, leveledUp: false };
      }
      eventInserted = true;
    } catch (e: any) {
      // The claim could not be made — the unique index is missing, or the column is. That is a
      // real fault and it is LOGGED, not swallowed. We still award: silently refusing a learner
      // the XP they just earned is the worse of the two failures, and the log names the risk.
      logEvent('error', 'xp.award_key_claim_failed', {
        userId: p.userId, source: p.source, awardKey: p.awardKey,
        reason: e?.cause?.message || e?.message || 'unknown',
      });
    }
  }

  // Upsert the user row if missing
  await db.execute(sql`
    INSERT INTO user_xp (user_id) VALUES (${p.userId})
    ON CONFLICT (user_id) DO NOTHING
  `);

  // ONE READ FOR ALL THREE THINGS THIS FUNCTION NEEDS BEFORE IT CAN WRITE.
  //
  // It was three statements: the streak columns, then a bare SELECT CURRENT_DATE, then today_xp and
  // today_date OFF THE SAME ROW it had already fetched. On this deployment a round trip is ~140ms
  // warm and ~950ms whenever it has to open a connection, so awarding a learner ten points for
  // finishing a lesson cost three of them before the UPDATE. awardXp runs on every test submit,
  // every lesson completion and every practice answer.
  //
  // The date cannot become new Date() in JS: it is compared against DATE columns the database writes
  // with CURRENT_DATE, on a session with no timezone set, so only the database's own answer agrees
  // with what is stored. It can, however, ride along on a row we were already fetching.
  //
  // THE NARROW FALLBACK IS KEPT, and it is why this is a try rather than one statement:
  // today_xp / today_date are added by ensureSchema(), which can fail, and the old code isolated
  // that in its own try so a missing column cost only the daily-goal rollup. Merging without this
  // would have turned a missing column into a failure of the whole award.
  let before: any;
  try {
    before = rows(await db.execute(sql`
      SELECT total_xp, level, streak_days, longest_streak,
        last_active_date::text AS last_active_date,
        today_xp, today_date::text AS today_date,
        CURRENT_DATE::text AS today
      FROM user_xp WHERE user_id = ${p.userId} LIMIT 1
    `))[0] as any;
  } catch (e: any) {
    logEvent('error', 'xp.award_read_fell_back', {
      userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown',
    });
    before = rows(await db.execute(sql`
      SELECT total_xp, level, streak_days, longest_streak,
        last_active_date::text AS last_active_date,
        CURRENT_DATE::text AS today
      FROM user_xp WHERE user_id = ${p.userId} LIMIT 1
    `))[0] as any;
  }
  // `today` is only ever consulted on a branch that already requires a row to exist (a non-null
  // last_active_date, or a today_date to compare against), so losing it with the row is harmless.
  // The literal keeps the type honest for the arithmetic below.
  const today: string = before?.today || new Date().toISOString().slice(0, 10);
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
  // Read above, not here. This was a THIRD statement selecting two more columns from the row the
  // first statement had already fetched.
  const todayXp = (before && before.today_date === today)
    ? Number(before.today_xp || 0) + p.delta
    : p.delta;

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
    // THE PERIOD KEYS ARE COMPUTED WHERE THE ROWS ARE WRITTEN, so this costs no read at all.
    //
    // It was a statement whose entire purpose was to fetch two strings back across the network and
    // send them straight out again as parameters on the very next statements. date_trunc is a
    // Postgres function; asking Postgres for its answer and then handing the answer back to Postgres
    // is a round trip bought for nothing. It also removes the `if (weekRow)` guard, which silently
    // skipped BOTH rollups whenever that read failed — the league and classroom boards going quiet
    // with nothing on any screen to explain it.
    //
    // ONE STATEMENT FOR BOTH PERIODS. They differ only in the literal 'week'/'month' and the trunc
    // unit, so a two-row VALUES with the same ON CONFLICT writes them together.
    const rollupFailed = (e: any) => logEvent('error', 'xp.rollup_write_failed', {
      userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown',
    });
    await db.execute(sql`
      INSERT INTO xp_period_rollups (user_id, period, period_key, total_xp)
      VALUES
        (${p.userId}, 'week',  date_trunc('week',  CURRENT_DATE)::date::text, ${p.delta}),
        (${p.userId}, 'month', date_trunc('month', CURRENT_DATE)::date::text, ${p.delta})
      ON CONFLICT (user_id, period, period_key)
        DO UPDATE SET total_xp = xp_period_rollups.total_xp + ${p.delta}, updated_at = NOW()
    `).catch(rollupFailed);
  } catch (e: any) {
    // The rollups feed the league, classroom and friends leaderboards. Losing them silently is why
    // those boards could be empty with nothing anywhere explaining it.
    logEvent('error', 'xp.rollup_step_failed', { userId: p.userId, reason: e?.cause?.message || e?.message || 'unknown' });
  }

  // Both amount columns are written so a reader on either historic shape sees the award. The
  // failure is LOGGED rather than dropped: this is the append-only XP audit trail, and a silent
  // catch here is how it would stop recording without anything on any screen saying so.
  if (!eventInserted) {
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
             COALESCE(streak_freezes, 0) AS streak_freezes,
             -- THE DATE RIDES ALONG. It used to be a statement of its own, below, purely to compare
             -- against today_date on this very row -- a whole WAN round trip (~140ms on this
             -- deployment, and ~950ms whenever it had to open the connection) to ask Postgres what
             -- day it is. It cannot be new Date() in JS: the comparison is against a DATE column the
             -- database writes with CURRENT_DATE, and the session has no timezone set, so only the
             -- database's own answer is the same answer.
             CURRENT_DATE::text AS today
      FROM user_xp WHERE user_id = ${userId} LIMIT 1
    `))[0] as any;
  } catch (e: any) {
    // Reaching this fallback means the four columns ensureSchema() adds are still missing, which
    // makes the daily goal and streak-freeze inventory read as 0 for everyone. Silence here is what
    // made that look like a product decision rather than a broken schema.
    logEvent('error', 'xp.user_xp_read_fell_back', { userId, reason: e?.cause?.message || e?.message || 'unknown' });
    r = rows(await db.execute(sql`SELECT total_xp, level, streak_days, longest_streak, last_active_date::text AS last_active_date, hearts, CURRENT_DATE::text AS today FROM user_xp WHERE user_id = ${userId} LIMIT 1`))[0] as any;
  }
  const xp = Number(r?.total_xp || 0);
  const level = levelFromXp(xp);
  const xpAtCurrent = 100 * Math.pow(level - 1, 2);
  const xpAtNext = 100 * Math.pow(level, 2);
  const progress = Math.max(0, Math.min(1, (xp - xpAtCurrent) / Math.max(1, xpAtNext - xpAtCurrent)));
  // No row means no XP has ever been recorded for this person, so nothing can have been recorded
  // TODAY either -- which is why losing the date with the row costs nothing. The old separate read
  // returned a date in that case and then compared it against undefined for the same answer.
  const isToday = !!r && !!r.today && r.today_date === r.today;
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

// =================================================================================================
// THE LEADERBOARD OPT-OUT.
//
// A learner can ask not to appear on any leaderboard. The choice lives in edu_gamer_state.opt_out
// (see ensureSchema above for why it was adopted rather than copied), and this module is its only
// reader and writer. EVERY board in this codebase must consult isOptedOutOfLeaderboard() or the
// same predicate in SQL — a board that forgets it publishes, by name, somebody who asked not to be
// listed, which is not a cosmetic bug.
// =================================================================================================

export async function isOptedOutOfLeaderboard(userId: string): Promise<boolean> {
  await ensureSchema();
  if (!userId) return false;
  try {
    const r = rows(await db.execute(sql`SELECT opt_out FROM edu_gamer_state WHERE user_id = ${userId} LIMIT 1`))[0] as any;
    return !!r?.opt_out;
  } catch (e: any) {
    // Fail CLOSED on a privacy read: if we cannot tell whether they opted out, treat them as opted
    // out. The cost of being wrong that way is a missing row; the other way it is a published name.
    logEvent('error', 'xp.optout_read_failed', { userId, reason: e?.cause?.message || e?.message || 'unknown' });
    return true;
  }
}

/** Returns false when the choice could not be stored, so the caller can say so instead of nodding. */
export async function setLeaderboardOptOut(userId: string, optOut: boolean): Promise<boolean> {
  await ensureSchema();
  if (!userId) return false;
  try {
    await db.execute(sql`
      INSERT INTO edu_gamer_state (user_id, opt_out) VALUES (${userId}, ${!!optOut})
      ON CONFLICT (user_id) DO UPDATE SET opt_out = ${!!optOut}
    `);
    return true;
  } catch (e: any) {
    logEvent('error', 'xp.optout_not_saved', { userId, optOut: !!optOut, reason: e?.cause?.message || e?.message || 'unknown' });
    return false;
  }
}

// =================================================================================================
// PER-ACTION XP AMOUNTS.
//
// /admin/xp-config (admin nav: Gamification) lets somebody holding configure on gamification set
// what each kernel learning action is worth. Those amounts used to drive the ledger that has now
// been retired, so they drive THIS one instead — otherwise the screen becomes a set of inputs that
// change nothing, which is the exact failure this pass exists to end.
//
// HONEST LIMIT, and it is printed on the screen too: only the actions listed here are configurable.
// The other XP sources in this codebase (practice answers, SRS reviews, daily challenges, story
// completions, tutor sessions) pass their own delta at the call site and are NOT governed by this.
// =================================================================================================

export const XP_ACTION_DEFAULTS: Readonly<Record<string, number>> = {
  lesson_complete: 10,
  assessment_pass: 25,
  assessment_practice: 2,
  mastery: 5,
};

export async function getXpConfig(): Promise<Record<string, number>> {
  await ensureSchema();
  try {
    const r = rows(await db.execute(sql`SELECT values FROM edu_xp_config WHERE id = 1 LIMIT 1`))[0] as any;
    const stored = (r && typeof r.values === 'object' && r.values) ? r.values : {};
    return { ...XP_ACTION_DEFAULTS, ...stored };
  } catch (e: any) {
    logEvent('error', 'xp.config_read_failed', { reason: e?.cause?.message || e?.message || 'unknown' });
    return { ...XP_ACTION_DEFAULTS };
  }
}

/** Returns false when the values could not be stored — the admin screen must not report 'Saved'. */
export async function setXpConfig(values: Record<string, number>): Promise<boolean> {
  await ensureSchema();
  const clean: Record<string, number> = {};
  for (const k of Object.keys(XP_ACTION_DEFAULTS)) {
    const v = Number((values || {})[k]);
    if (Number.isFinite(v) && v >= 0) clean[k] = Math.floor(v);
  }
  try {
    await db.execute(sql`
      INSERT INTO edu_xp_config (id, values) VALUES (1, ${JSON.stringify(clean)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET values = ${JSON.stringify(clean)}::jsonb
    `);
    return true;
  } catch (e: any) {
    logEvent('error', 'xp.config_not_saved', { reason: e?.cause?.message || e?.message || 'unknown' });
    return false;
  }
}

/** What one configurable action is worth right now. Falls back to the built-in default. */
export async function xpAmountFor(action: string): Promise<number> {
  const cfg = await getXpConfig();
  const v = Number(cfg[action]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : Number(XP_ACTION_DEFAULTS[action] || 0);
}

// =================================================================================================
// ADMIN READS over the one ledger. Both return a discriminated result: an empty list that actually
// means 'the query failed' is the lie this area of the codebase has told before.
// =================================================================================================

export type LedgerEntry = { at: any; userId: string; userName: string; source: string; delta: number; reason: string | null };
export type LedgerResult = { ok: true; rows: LedgerEntry[] } | { ok: false; reason: string };

/**
 * The audit trail: every XP event, newest first, whoever earned it. Not a leaderboard — an opt-out
 * hides a learner from a public ranking, it does not erase them from an audit log that only
 * somebody holding audit on gamification can open.
 */
export async function recentXpEvents(limit = 50): Promise<LedgerResult> {
  await ensureSchema();
  const cap = Math.min(500, Math.max(1, Math.floor(limit || 50)));
  try {
    const rs = rows(await db.execute(sql`
      SELECT e.created_at, e.user_id::text AS user_id, e.source,
             COALESCE(e.delta, e.xp_amount) AS delta, e.reason,
             COALESCE(u.name, u.email, 'Learner') AS user_name
      FROM xp_events e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT ${cap}
    `));
    return { ok: true, rows: rs.map((r: any) => ({
      at: r.created_at,
      userId: String(r.user_id || ''),
      userName: String(r.user_name || 'Learner'),
      source: String(r.source || ''),
      delta: Number(r.delta || 0),
      reason: r.reason || null,
    })) };
  } catch (e: any) {
    logEvent('error', 'xp.ledger_read_failed', { reason: e?.cause?.message || e?.message || 'unknown' });
    return { ok: false, reason: e?.cause?.message || e?.message || 'unknown' };
  }
}

export type WeeklyEntry = { userId: string; name: string; xp: number };
export type WeeklyResult = { ok: true; rows: WeeklyEntry[] } | { ok: false; reason: string };

/**
 * This week's XP from xp_period_rollups — the table awardXp() maintains. Opted-out learners are
 * excluded, because this one IS a ranking.
 */
export async function weeklyXpLeaderboard(limit = 10): Promise<WeeklyResult> {
  await ensureSchema();
  const cap = Math.min(200, Math.max(1, Math.floor(limit || 10)));
  try {
    const rs = rows(await db.execute(sql`
      SELECT r.user_id::text AS user_id, COALESCE(u.name, u.email, 'Learner') AS name, r.total_xp
      FROM xp_period_rollups r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN edu_gamer_state g ON g.user_id = r.user_id
      WHERE r.period = 'week' AND r.period_key = date_trunc('week', CURRENT_DATE)::date
        AND COALESCE(g.opt_out, false) = false AND r.total_xp > 0
      ORDER BY r.total_xp DESC, r.user_id ASC LIMIT ${cap}
    `));
    return { ok: true, rows: rs.map((r: any) => ({ userId: String(r.user_id), name: String(r.name || 'Learner'), xp: Number(r.total_xp || 0) })) };
  } catch (e: any) {
    logEvent('error', 'xp.weekly_board_read_failed', { reason: e?.cause?.message || e?.message || 'unknown' });
    return { ok: false, reason: e?.cause?.message || e?.message || 'unknown' };
  }
}
