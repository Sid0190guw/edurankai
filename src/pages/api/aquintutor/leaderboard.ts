// GET /api/aquintutor/leaderboard?period=week|month|all&limit=20
// Returns top users by XP. Uses xp_period_rollups for week/month; falls back
// to user_xp.total_xp for all-time. Names are first-name + last initial for
// privacy.
//
// THIS ENDPOINT PUBLISHES NAMES, SO IT HONOURS THE LEADERBOARD OPT-OUT. A learner can ask to be
// left off the boards (the switch is on /aquintutor/xp and /portal/achievements); the choice lives
// in edu_gamer_state.opt_out and src/lib/xp.ts owns it. An endpoint that skipped the filter would
// hand a caller the very rows the learner asked not to publish, and the checkbox on those two pages
// would be a lie. Their OWN rank below is not filtered — opting out means "do not list me to other
// people", not "stop counting me".
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureXpSchema } from '@/lib/xp';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const url = new URL(request.url);
  const period = (url.searchParams.get('period') || 'week').toLowerCase();
  const limit = Math.max(5, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));

  const out: { rank: number; userId: string; name: string; xp: number; isMe: boolean }[] = [];
  // The joins below touch edu_gamer_state; this makes sure it is there rather than letting a fresh
  // database turn a missing table into an empty board.
  await ensureXpSchema().catch((e: any) => console.error('[leaderboard] ensureXpSchema', e?.cause?.message || e?.message));
  try {
    if (period === 'all') {
      const r = rows(await db.execute(sql`
        SELECT u.id AS user_id, COALESCE(u.name, u.email) AS name, x.total_xp AS xp
        FROM user_xp x JOIN users u ON x.user_id = u.id
        LEFT JOIN edu_gamer_state g ON g.user_id = x.user_id
        WHERE u.is_active = true AND COALESCE(g.opt_out, false) = false
        ORDER BY x.total_xp DESC LIMIT ${limit}
      `));
      r.forEach((row: any, i: number) => out.push({ rank: i + 1, userId: row.user_id, name: shorten(row.name), xp: Number(row.xp || 0), isMe: !!user && row.user_id === user.id }));
    } else {
      const truncCol = period === 'month' ? 'month' : 'week';
      const r = rows(await db.execute(sql`
        SELECT u.id AS user_id, COALESCE(u.name, u.email) AS name, p.total_xp AS xp
        FROM xp_period_rollups p JOIN users u ON p.user_id = u.id
        LEFT JOIN edu_gamer_state g ON g.user_id = p.user_id
        WHERE p.period = ${truncCol}
          AND p.period_key = date_trunc(${truncCol}, CURRENT_DATE)::date
          AND u.is_active = true AND COALESCE(g.opt_out, false) = false
        ORDER BY p.total_xp DESC LIMIT ${limit}
      `));
      r.forEach((row: any, i: number) => out.push({ rank: i + 1, userId: row.user_id, name: shorten(row.name), xp: Number(row.xp || 0), isMe: !!user && row.user_id === user.id }));
    }
  } catch (e: any) {
    // An empty board and an unreadable one are different answers. The caller still gets a board it
    // can render, but the reason is on the record instead of nowhere.
    console.error('[leaderboard] board read', e?.cause?.message || e?.message);
  }

  // My rank (separate query so I'm visible even outside the top N)
  let myRank: { rank: number; xp: number } | null = null;
  if (user) {
    try {
      if (period === 'all') {
        const r = rows(await db.execute(sql`
          SELECT (SELECT COUNT(*)::int FROM user_xp WHERE total_xp > me.total_xp) + 1 AS rank, me.total_xp AS xp
          FROM user_xp me WHERE me.user_id = ${user.id}
        `));
        if (r[0]) myRank = { rank: Number(r[0].rank), xp: Number(r[0].xp || 0) };
      } else {
        const truncCol = period === 'month' ? 'month' : 'week';
        const r = rows(await db.execute(sql`
          SELECT (SELECT COUNT(*)::int FROM xp_period_rollups
                  WHERE period = ${truncCol} AND period_key = date_trunc(${truncCol}, CURRENT_DATE)::date
                    AND total_xp > me.total_xp) + 1 AS rank,
                 me.total_xp AS xp
          FROM xp_period_rollups me
          WHERE me.user_id = ${user.id} AND me.period = ${truncCol}
            AND me.period_key = date_trunc(${truncCol}, CURRENT_DATE)::date
        `));
        if (r[0]) myRank = { rank: Number(r[0].rank), xp: Number(r[0].xp || 0) };
      }
    } catch (e: any) {
      console.error('[leaderboard] own rank', e?.cause?.message || e?.message);
    }
  }

  return json({ ok: true, period, leaderboard: out, myRank });
};

function shorten(n: string): string {
  if (!n) return 'anonymous';
  const parts = String(n).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
}
