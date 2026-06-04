// GET /api/aquintutor/leaderboard?period=week|month|all&limit=20
// Returns top users by XP. Uses xp_period_rollups for week/month; falls back
// to user_xp.total_xp for all-time. Names are first-name + last initial for
// privacy.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

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
  try {
    if (period === 'all') {
      const r = rows(await db.execute(sql`
        SELECT u.id AS user_id, COALESCE(u.name, u.email) AS name, x.total_xp AS xp
        FROM user_xp x JOIN users u ON x.user_id = u.id
        WHERE u.is_active = true
        ORDER BY x.total_xp DESC LIMIT ${limit}
      `));
      r.forEach((row: any, i: number) => out.push({ rank: i + 1, userId: row.user_id, name: shorten(row.name), xp: Number(row.xp || 0), isMe: !!user && row.user_id === user.id }));
    } else {
      const truncCol = period === 'month' ? 'month' : 'week';
      const r = rows(await db.execute(sql`
        SELECT u.id AS user_id, COALESCE(u.name, u.email) AS name, p.total_xp AS xp
        FROM xp_period_rollups p JOIN users u ON p.user_id = u.id
        WHERE p.period = ${truncCol}
          AND p.period_key = date_trunc(${truncCol}, CURRENT_DATE)::date
          AND u.is_active = true
        ORDER BY p.total_xp DESC LIMIT ${limit}
      `));
      r.forEach((row: any, i: number) => out.push({ rank: i + 1, userId: row.user_id, name: shorten(row.name), xp: Number(row.xp || 0), isMe: !!user && row.user_id === user.id }));
    }
  } catch (_) {}

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
    } catch (_) {}
  }

  return json({ ok: true, period, leaderboard: out, myRank });
};

function shorten(n: string): string {
  if (!n) return 'anonymous';
  const parts = String(n).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
}
