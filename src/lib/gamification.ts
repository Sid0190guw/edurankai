// Gamification: learner level, XP, streak and badges — the READ MODEL for /portal/achievements.
//
// WHAT CHANGED AND WHY.
// This module used to run a SECOND, PARALLEL XP LEDGER. It owned learner_streaks (current/longest
// streak, total_xp, level) and wrote it from its own awardXp()/recordActivity(). Neither was ever
// called by anything in production — the only writer of learner_streaks was getLearnerStats()
// itself, which INSERTed a zero row on read. So /portal/achievements showed every learner Level 1,
// 0 XP, a 0-day streak, no badges and no rank, permanently, while src/lib/xp.ts recorded that same
// learner's real XP and streak into user_xp from a dozen live call sites (lesson-complete,
// practice/answer, srs-review, daily-challenge, story-complete, ai-tutor, friends, shop).
//
// There is now ONE ledger. src/lib/xp.ts owns the write side (user_xp + xp_events + rollups); this
// module only reads it and derives badges from it. gamification.awardXp() and
// gamification.recordActivity() are GONE rather than fixed: a second writer of the same concept is
// the defect, not a missing feature. Callers award XP through xp.awardXp().
//
// learner_badges stays here and now has a real writer: syncBadges() evaluates milestone rules
// against the real ledger and INSERTs the ones a learner has actually met. A badge is a durable,
// dated fact (ON CONFLICT DO NOTHING keeps the first award date), not a computed-at-render label.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { ensureOnce } from '@/lib/ensure-once';

import { getUserXp, reconcileXpEventsColumns } from '@/lib/xp';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function reasonOf(e: any): string {
  // The real Postgres reason is on e.cause; e.message is only the failed statement.
  return e?.cause?.message || e?.message || 'unknown';
}

/**
 * THIS USED TO BE `catch (_) {}` AROUND A MEMOIZED PROMISE, which is the worst combination of the
 * two: a DDL failure was swallowed with nothing written anywhere, AND the failed run was cached for
 * the life of the process, so every later caller got the same silent success.
 *
 * Now on ensureOnce(), which drops a failed run from the cache so the next call retries, and the
 * cause is LOGGED before it is re-thrown into that guard.
 */
export function ensureGamificationSchema(): Promise<void> {
  return ensureOnce('gamification', async () => {
    try {
      // Awarded badges. UNIQUE(user_id, badge_key) prevents double-awards and preserves the
      // ORIGINAL award date when syncBadges() re-evaluates on every page load.
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

      // xp_events is created by src/lib/xp.ts (ref_id/delta/reason) and was historically also
      // created here with a different shape (source_id/xp_amount). CREATE TABLE IF NOT EXISTS means
      // only the first module to run wins and the other one's every INSERT then throws on a missing
      // column. Reconcile to the union of both shapes so neither module's XP log can be lost.
      await reconcileXpEventsColumns();
    } catch (e: any) {
      logEvent('error', 'gamification.schema_ensure_failed', { reason: reasonOf(e) });
      throw e;
    }
  });
}

// level = floor(sqrt(xp / 100)) + 1 — identical curve to src/lib/xp.ts levelFromXp().
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

// ---------------------------------------------------------------------------
// Badge catalogue.
//
// Every rule below is a predicate over NUMBERS THAT ARE ACTUALLY RECORDED by src/lib/xp.ts:
// user_xp.total_xp, user_xp.longest_streak, and counts of xp_events rows by source. No rule reads a
// column nothing writes — that is the whole point. Adding a rule that depends on an unwritten
// column would put an unreachable badge back on the grid.
// ---------------------------------------------------------------------------

export type BadgeFacts = {
  totalXp: number;
  level: number;
  longestStreak: number;
  currentStreak: number;
  /** rows in xp_events for this user, by source */
  sourceCounts: Record<string, number>;
  /** total rows in xp_events for this user */
  eventCount: number;
};

export type BadgeRule = {
  key: string;
  name: string;
  description: string;
  icon: string;
  earned: (f: BadgeFacts) => boolean;
};

const SVG_SPARK = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const SVG_FLAME = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
const SVG_BOOK = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';
const SVG_LEVEL = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';
const SVG_TARGET = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';

export const BADGE_RULES: BadgeRule[] = [
  { key: 'first_xp',    name: 'First step',       description: 'Earned your first XP.',                       icon: SVG_SPARK,  earned: (f) => f.totalXp > 0 },
  { key: 'xp_500',      name: '500 XP',           description: 'Five hundred XP earned.',                     icon: SVG_SPARK,  earned: (f) => f.totalXp >= 500 },
  { key: 'xp_2000',     name: '2,000 XP',         description: 'Two thousand XP earned.',                     icon: SVG_SPARK,  earned: (f) => f.totalXp >= 2000 },
  { key: 'xp_10000',    name: '10,000 XP',        description: 'Ten thousand XP earned.',                     icon: SVG_SPARK,  earned: (f) => f.totalXp >= 10000 },
  { key: 'level_5',     name: 'Level 5',          description: 'Reached level five.',                         icon: SVG_LEVEL,  earned: (f) => f.level >= 5 },
  { key: 'level_10',    name: 'Level 10',         description: 'Reached level ten.',                          icon: SVG_LEVEL,  earned: (f) => f.level >= 10 },
  { key: 'streak_3',    name: '3-day streak',     description: 'Studied three days in a row.',                icon: SVG_FLAME,  earned: (f) => f.longestStreak >= 3 },
  { key: 'streak_7',    name: '7-day streak',     description: 'A full week without a gap.',                  icon: SVG_FLAME,  earned: (f) => f.longestStreak >= 7 },
  { key: 'streak_30',   name: '30-day streak',    description: 'Thirty consecutive days.',                    icon: SVG_FLAME,  earned: (f) => f.longestStreak >= 30 },
  { key: 'streak_100',  name: '100-day streak',   description: 'One hundred consecutive days.',               icon: SVG_FLAME,  earned: (f) => f.longestStreak >= 100 },
  { key: 'lesson_1',    name: 'First lesson',     description: 'Completed your first lesson.',                icon: SVG_BOOK,   earned: (f) => (f.sourceCounts['lesson_complete'] || 0) >= 1 },
  { key: 'lesson_10',   name: 'Ten lessons',      description: 'Completed ten lessons.',                      icon: SVG_BOOK,   earned: (f) => (f.sourceCounts['lesson_complete'] || 0) >= 10 },
  { key: 'course_1',    name: 'Course finished',  description: 'Completed a full course.',                    icon: SVG_BOOK,   earned: (f) => (f.sourceCounts['course_complete'] || 0) >= 1 },
  { key: 'practice_25', name: 'Practised hard',   description: 'Twenty-five correct practice answers.',       icon: SVG_TARGET, earned: (f) => (f.sourceCounts['practice'] || 0) + (f.sourceCounts['lesson_exercise'] || 0) >= 25 },
  { key: 'srs_50',      name: 'Retention',        description: 'Fifty spaced-repetition reviews recalled.',   icon: SVG_TARGET, earned: (f) => (f.sourceCounts['srs_review'] || 0) >= 50 },
  { key: 'daily_10',    name: 'Ten challenges',   description: 'Ten daily challenges attempted.',             icon: SVG_TARGET, earned: (f) => (f.sourceCounts['daily_challenge'] || 0) >= 10 },
];

/** Pure: which badge keys these facts earn. Testable without a database. */
export function earnedBadgeKeys(facts: BadgeFacts): string[] {
  return BADGE_RULES.filter((r) => {
    try { return r.earned(facts); } catch { return false; }
  }).map((r) => r.key);
}

/**
 * Award a badge. Idempotent via UNIQUE(user_id, badge_key) — a re-award is a no-op and the original
 * awarded_at survives.
 */
export async function awardBadge(userId: string, key: string, name: string, description: string, iconSvg: string) {
  await ensureGamificationSchema();
  if (!userId || !key || !name) return { ok: false as const, error: 'missing-args' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO learner_badges (user_id, badge_key, badge_name, badge_description, icon_svg)
      VALUES (${userId}, ${key}, ${name}, ${description || null}, ${iconSvg || null})
      ON CONFLICT (user_id, badge_key) DO NOTHING
      RETURNING id, awarded_at
    `));
    return { ok: true as const, newlyAwarded: r.length > 0, id: r[0]?.id || null };
  } catch (e: any) {
    logEvent('error', 'gamification.badge_award_failed', { userId, key, reason: reasonOf(e) });
    return { ok: false as const, error: reasonOf(e) };
  }
}

/**
 * Evaluate every rule against the real ledger and persist the ones newly met.
 * Returns the keys awarded on THIS call so a caller can congratulate; a failure is logged and
 * reported, never silently turned into "no new badges".
 */
export async function syncBadges(userId: string, facts: BadgeFacts): Promise<{ ok: true; newlyAwarded: string[] } | { ok: false; reason: string }> {
  await ensureGamificationSchema();
  if (!userId) return { ok: false, reason: 'missing-userId' };
  const keys = earnedBadgeKeys(facts);
  if (keys.length === 0) return { ok: true, newlyAwarded: [] };
  const newly: string[] = [];
  try {
    for (const key of keys) {
      const rule = BADGE_RULES.find((r) => r.key === key);
      if (!rule) continue;
      const r = rows(await db.execute(sql`
        INSERT INTO learner_badges (user_id, badge_key, badge_name, badge_description, icon_svg)
        VALUES (${userId}, ${rule.key}, ${rule.name}, ${rule.description}, ${rule.icon})
        ON CONFLICT (user_id, badge_key) DO NOTHING
        RETURNING id
      `));
      if (r.length > 0) newly.push(rule.key);
    }
    return { ok: true, newlyAwarded: newly };
  } catch (e: any) {
    logEvent('error', 'gamification.badge_sync_failed', { userId, reason: reasonOf(e) });
    return { ok: false, reason: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Reads. Both return a discriminated result: an empty list that means "the query failed" is the
// lie this module used to tell (getLeaderboard: `catch { return [] }`, getLearnerStats:
// `catch { return null }` rendered as a page full of zeros).
// ---------------------------------------------------------------------------

export type LeaderboardRow = {
  user_id: string;
  total_xp: number;
  level: number;
  current_streak_days: number;
  longest_streak_days: number;
  display_name: string;
  email: string | null;
  rank: number;
};

export type LeaderboardResult =
  | { ok: true; rows: LeaderboardRow[] }
  | { ok: false; reason: string };

/** Top N learners by total XP, read from user_xp — the table src/lib/xp.ts actually writes. */
export async function getLeaderboard(limit: number = 20): Promise<LeaderboardResult> {
  await ensureGamificationSchema();
  const cap = Math.min(200, Math.max(1, Math.floor(limit || 20)));
  try {
    // getUserXp('') is a no-op read but still runs xp.ts's ensureSchema() so user_xp and its
    // late-added columns exist before the join below touches them.
    await getUserXp('');
    const rs = rows(await db.execute(sql`
      SELECT
        ux.user_id::text AS user_id,
        ux.total_xp,
        ux.level,
        COALESCE(ux.streak_days, 0) AS current_streak_days,
        COALESCE(ux.longest_streak, 0) AS longest_streak_days,
        COALESCE(u.name, u.email, 'Learner') AS display_name,
        u.email,
        ROW_NUMBER() OVER (ORDER BY ux.total_xp DESC, ux.user_id ASC) AS rank
      FROM user_xp ux
      LEFT JOIN users u ON u.id = ux.user_id
      WHERE ux.total_xp > 0
      ORDER BY ux.total_xp DESC, ux.user_id ASC
      LIMIT ${cap}
    `));
    return {
      ok: true,
      rows: rs.map((r: any) => ({
        user_id: String(r.user_id),
        total_xp: Number(r.total_xp || 0),
        level: Number(r.level || 1),
        current_streak_days: Number(r.current_streak_days || 0),
        longest_streak_days: Number(r.longest_streak_days || 0),
        display_name: String(r.display_name || 'Learner'),
        email: r.email || null,
        rank: Number(r.rank || 0),
      })),
    };
  } catch (e: any) {
    logEvent('error', 'gamification.leaderboard_read_failed', { reason: reasonOf(e) });
    return { ok: false, reason: reasonOf(e) };
  }
}

export type LearnerStats = {
  userId: string;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string | null;
  totalXp: number;
  level: number;
  progress: ReturnType<typeof xpProgressForUser>;
  totalBadges: number;
  recentBadges: any[];
  /** null means "not ranked yet" (no XP), which is different from "rank unknown". */
  rank: number | null;
  recentXp: { source: string; source_id: string | null; xp_amount: number; created_at: any }[];
  newBadges: string[];
  /** Set when the badge grid could not be read/written; the page says so instead of showing none. */
  badgeError: string | null;
};

export type LearnerStatsResult =
  | { ok: true; stats: LearnerStats }
  | { ok: false; reason: string };

/**
 * One learner's real numbers. Every field comes from user_xp / xp_events / learner_badges.
 * A read failure returns { ok:false, reason } — the caller must render "your progress could not be
 * loaded", never a page of zeros that reads as "you have done nothing".
 */
export async function getLearnerStats(userId: string): Promise<LearnerStatsResult> {
  await ensureGamificationSchema();
  if (!userId) return { ok: false, reason: 'missing-userId' };
  try {
    // The live ledger. getUserXp() owns user_xp's schema-ensure and its own fallbacks.
    const xp = await getUserXp(userId);
    const totalXp = Number(xp.totalXp || 0);
    const progress = xpProgressForUser(totalXp);

    // Rank: how many learners are strictly ahead. Only meaningful once you have XP.
    let rank: number | null = null;
    if (totalXp > 0) {
      const ahead = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM user_xp WHERE total_xp > ${totalXp}`))[0];
      rank = Number(ahead?.c || 0) + 1;
    }

    // Recent earnings. COALESCE covers both historic shapes of xp_events (see reconcile above).
    const recentXp = rows(await db.execute(sql`
      SELECT source,
             COALESCE(source_id, ref_id::text) AS source_id,
             COALESCE(xp_amount, delta) AS xp_amount,
             created_at
      FROM xp_events WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 12
    `)).map((e: any) => ({
      source: String(e.source || ''),
      source_id: e.source_id || null,
      xp_amount: Number(e.xp_amount || 0),
      created_at: e.created_at,
    }));

    // Per-source counts drive the lesson/practice/streak badges.
    const counts = rows(await db.execute(sql`
      SELECT source, COUNT(*)::int AS c FROM xp_events
      WHERE user_id = ${userId} AND COALESCE(xp_amount, delta) > 0
      GROUP BY source
    `));
    const sourceCounts: Record<string, number> = {};
    let eventCount = 0;
    for (const c of counts) {
      const n = Number(c.c || 0);
      sourceCounts[String(c.source || '')] = n;
      eventCount += n;
    }

    const facts: BadgeFacts = {
      totalXp,
      level: progress.level,
      longestStreak: Number(xp.longestStreak || 0),
      currentStreak: Number(xp.streakDays || 0),
      sourceCounts,
      eventCount,
    };

    const synced = await syncBadges(userId, facts);
    let badgeError: string | null = synced.ok ? null : synced.reason;
    let badges: any[] = [];
    try {
      badges = rows(await db.execute(sql`
        SELECT id, badge_key, badge_name, badge_description, icon_svg, awarded_at
        FROM learner_badges WHERE user_id = ${userId}
        ORDER BY awarded_at DESC, badge_key ASC
      `));
    } catch (e: any) {
      logEvent('error', 'gamification.badge_read_failed', { userId, reason: reasonOf(e) });
      badgeError = reasonOf(e);
    }

    return {
      ok: true,
      stats: {
        userId,
        currentStreak: facts.currentStreak,
        longestStreak: facts.longestStreak,
        lastActiveDate: xp.lastActive || null,
        totalXp,
        level: progress.level,
        progress,
        totalBadges: badges.length,
        recentBadges: badges.slice(0, 12),
        rank,
        recentXp,
        newBadges: synced.ok ? synced.newlyAwarded : [],
        badgeError,
      },
    };
  } catch (e: any) {
    logEvent('error', 'gamification.learner_stats_failed', { userId, reason: reasonOf(e) });
    return { ok: false, reason: reasonOf(e) };
  }
}
