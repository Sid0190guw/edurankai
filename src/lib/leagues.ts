// Weekly leagues — cohorts of ~30 users compete on XP earned that week.
// Top 5 promote; bottom 5 demote; rest hold. Tier 1 = Bronze, tier 5 = Diamond.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const TIERS = [
  { level: 1, name: 'Bronze',   emoji: '🥉', color: '#b45309' },
  { level: 2, name: 'Silver',   emoji: '🥈', color: '#94a3b8' },
  { level: 3, name: 'Gold',     emoji: '🥇', color: '#facc15' },
  { level: 4, name: 'Sapphire', emoji: '💎', color: '#3b82f6' },
  { level: 5, name: 'Diamond',  emoji: '💠', color: '#22d3ee' },
];
export const COHORT_SIZE = 30;
export const PROMOTE_TOP = 5;
export const DEMOTE_BOTTOM = 5;

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS leagues (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tier VARCHAR(20) NOT NULL,
      tier_level INTEGER NOT NULL, week_start DATE NOT NULL, cohort_number INTEGER NOT NULL DEFAULT 1,
      member_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tier, tier_level, week_start, cohort_number))`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS league_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_xp INTEGER NOT NULL DEFAULT 0, final_rank INTEGER,
      placement_result VARCHAR(20), joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(league_id, user_id))`);
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS league_tier INTEGER NOT NULL DEFAULT 1`);
    await db.execute(sql`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS current_league_id UUID`);
  } catch (_) {}
}

export async function ensureUserInLeague(userId: string): Promise<{ leagueId: string; tier: number; cohort: number; rank: number; memberCount: number } | null> {
  await ensureSchema();
  // Get current week start (Monday)
  const wsRow = rows(await db.execute(sql`SELECT date_trunc('week', CURRENT_DATE)::date::text AS w`))[0] as any;
  const weekStart = wsRow.w;

  // Already in a league this week?
  const existing = rows(await db.execute(sql`
    SELECT l.id AS league_id, l.tier_level, l.cohort_number, l.member_count
    FROM league_memberships m JOIN leagues l ON m.league_id = l.id
    WHERE m.user_id = ${userId} AND l.week_start = ${weekStart}
    LIMIT 1
  `))[0] as any;

  if (existing) {
    const rank = await myRank(existing.league_id, userId);
    return { leagueId: existing.league_id, tier: existing.tier_level, cohort: existing.cohort_number, rank, memberCount: existing.member_count };
  }

  // Determine user's tier from user_xp
  const me = rows(await db.execute(sql`SELECT COALESCE(league_tier, 1) AS tier FROM user_xp WHERE user_id = ${userId} LIMIT 1`))[0] as any;
  const tier = Number(me?.tier || 1);
  const tierDef = TIERS.find(t => t.level === tier) || TIERS[0];

  // Find an open cohort at this tier this week, otherwise create a new one
  let cohort = rows(await db.execute(sql`
    SELECT id, cohort_number, member_count FROM leagues
    WHERE week_start = ${weekStart} AND tier_level = ${tier} AND member_count < ${COHORT_SIZE}
    ORDER BY cohort_number ASC LIMIT 1
  `))[0] as any;

  if (!cohort) {
    const maxCohort = rows(await db.execute(sql`SELECT COALESCE(MAX(cohort_number), 0) AS m FROM leagues WHERE week_start = ${weekStart} AND tier_level = ${tier}`))[0] as any;
    const next = Number(maxCohort?.m || 0) + 1;
    const ins = rows(await db.execute(sql`
      INSERT INTO leagues (tier, tier_level, week_start, cohort_number, member_count)
      VALUES (${tierDef.name}, ${tier}, ${weekStart}, ${next}, 0)
      ON CONFLICT (tier, tier_level, week_start, cohort_number) DO UPDATE SET tier = EXCLUDED.tier
      RETURNING id, cohort_number, member_count
    `));
    cohort = ins[0];
  }

  await db.execute(sql`
    INSERT INTO league_memberships (league_id, user_id, week_xp)
    VALUES (${cohort.id}, ${userId}, 0)
    ON CONFLICT (league_id, user_id) DO NOTHING
  `);
  await db.execute(sql`UPDATE leagues SET member_count = (SELECT COUNT(*)::int FROM league_memberships WHERE league_id = ${cohort.id}) WHERE id = ${cohort.id}`);
  await db.execute(sql`UPDATE user_xp SET current_league_id = ${cohort.id} WHERE user_id = ${userId}`).catch(() => {});

  const memberCount = rows(await db.execute(sql`SELECT member_count FROM leagues WHERE id = ${cohort.id}`))[0]?.member_count || 1;
  const rank = await myRank(cohort.id, userId);
  return { leagueId: cohort.id, tier, cohort: cohort.cohort_number, rank, memberCount };
}

async function myRank(leagueId: string, userId: string): Promise<number> {
  const r = rows(await db.execute(sql`
    SELECT (SELECT COUNT(*)::int FROM league_memberships WHERE league_id = ${leagueId} AND week_xp > me.week_xp) + 1 AS rank
    FROM league_memberships me WHERE me.league_id = ${leagueId} AND me.user_id = ${userId}
  `))[0] as any;
  return Number(r?.rank || 0);
}

export async function getLeagueRoster(leagueId: string): Promise<any[]> {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT m.user_id, m.week_xp, COALESCE(u.name, u.email) AS name
    FROM league_memberships m JOIN users u ON m.user_id = u.id
    WHERE m.league_id = ${leagueId}
    ORDER BY m.week_xp DESC, m.joined_at ASC
  `)) as any[];
}

export async function getLeague(leagueId: string): Promise<any | null> {
  await ensureSchema();
  return rows(await db.execute(sql`SELECT * FROM leagues WHERE id = ${leagueId} LIMIT 1`))[0] || null;
}

// Update league_memberships.week_xp from xp_period_rollups (weekly bucket).
// Call this whenever rendering the league page to keep totals fresh without
// running a cron.
export async function refreshLeagueXp(leagueId: string): Promise<void> {
  await ensureSchema();
  await db.execute(sql`
    UPDATE league_memberships m SET week_xp = COALESCE(p.total_xp, 0)
    FROM xp_period_rollups p
    WHERE m.league_id = ${leagueId}
      AND p.user_id = m.user_id
      AND p.period = 'week'
      AND p.period_key = date_trunc('week', CURRENT_DATE)::date
  `).catch(() => {});
}
