// GET/POST /api/aquintutor/league-settle
// Weekly cron: finds last week's leagues, ranks members by week_xp, marks
// top 5 promoted, bottom 5 demoted, rest hold. Updates each user's
// user_xp.league_tier. Emails the result + applies auto-streak-freeze for
// any user whose streak is at risk and holds a freeze.
//
// Authorised via CRON_SECRET. Idempotent on processed_at.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = request.headers.get('authorization') || '';
  if (a === `Bearer ${secret}`) return true;
  const x = request.headers.get('x-cron-secret') || '';
  return x === secret;
}

const TIER_LABEL: Record<number, string> = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Sapphire', 5: 'Diamond' };
const PROMOTE_TOP = 5, DEMOTE_BOTTOM = 5, MAX_TIER = 5;

async function settleLastWeek(): Promise<{ ok: boolean; settled: number; promoted: number; demoted: number; freezes: number }> {
  let settled = 0, promoted = 0, demoted = 0, freezes = 0;

  const lastWeek = rows(await db.execute(sql`
    SELECT (date_trunc('week', CURRENT_DATE) - INTERVAL '7 days')::date::text AS w
  `))[0]?.w;

  const leagues = rows(await db.execute(sql`
    SELECT id, tier_level FROM leagues
    WHERE week_start = ${lastWeek}
      AND id NOT IN (SELECT DISTINCT league_id FROM league_memberships WHERE processed_at IS NOT NULL)
  `));

  for (const L of leagues as any[]) {
    const members = rows(await db.execute(sql`
      SELECT id, user_id, week_xp FROM league_memberships WHERE league_id = ${L.id}
      ORDER BY week_xp DESC, joined_at ASC
    `));
    const n = members.length;
    for (let i = 0; i < n; i++) {
      const m = members[i] as any;
      const rank = i + 1;
      let result = 'hold';
      let newTier = L.tier_level;
      if (rank <= PROMOTE_TOP && L.tier_level < MAX_TIER) { result = 'promoted'; newTier = L.tier_level + 1; promoted++; }
      else if (rank > n - DEMOTE_BOTTOM && L.tier_level > 1 && n >= 20) { result = 'demoted'; newTier = L.tier_level - 1; demoted++; }
      await db.execute(sql`UPDATE league_memberships SET final_rank = ${rank}, placement_result = ${result}, processed_at = NOW() WHERE id = ${m.id}`).catch(() => {});
      await db.execute(sql`UPDATE user_xp SET league_tier = ${newTier} WHERE user_id = ${m.user_id}`).catch(() => {});
      settled++;
      // Notify
      try {
        const u = rows(await db.execute(sql`SELECT email, name FROM users WHERE id = ${m.user_id} LIMIT 1`))[0] as any;
        if (u && u.email && result !== 'hold') {
          const oldTier = TIER_LABEL[L.tier_level] || 'Bronze';
          const newLabel = TIER_LABEL[newTier] || 'Bronze';
          const subj = result === 'promoted' ? '🎉 Promoted to ' + newLabel + ' League!' : 'Demoted to ' + newLabel + ' — get back in the race';
          const html = '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">'
            + '<h2 style="color:#d97757;font-family:Georgia,serif;font-size:22px;">' + (result === 'promoted' ? '🎉' : '🔽') + ' ' + subj + '</h2>'
            + '<p style="font-size:15px;color:#333;line-height:1.6;">Hi ' + (u.name || 'there') + ',<br><br>You finished <b>#' + rank + ' of ' + n + '</b> in your ' + oldTier + ' League cohort with <b>' + m.week_xp + ' XP</b> last week.</p>'
            + (result === 'promoted'
                ? '<p style="font-size:15px;color:#10b981;line-height:1.6;"><b>You\'re now in ' + newLabel + ' League.</b> Your weekly competition just got tougher (and the rewards bigger).</p>'
                : '<p style="font-size:15px;color:#5b5b5b;line-height:1.6;">You\'ve dropped to <b>' + newLabel + ' League</b>. One good practice week and you\'re back up.</p>')
            + '<p style="text-align:center;margin:24px 0;"><a href="https://edurankai.in/aquintutor/league" style="background:#d97757;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">See your new league →</a></p>'
            + '</div>';
          const tlib = await import('@/lib/mail-transport').catch(() => ({} as any));
          const sendExternal = (tlib as any).sendExternal;
          if (sendExternal) {
            await sendExternal({ from: 'AquinTutor <hr@edurankai.in>', to: u.email, subject: subj, html, text: subj });
          }
        }
      } catch (_) {}
    }
  }

  // Auto-apply streak freezes
  try {
    const atRisk = rows(await db.execute(sql`
      SELECT u.id, u.email, u.name, x.streak_days, x.streak_freezes
      FROM user_xp x JOIN users u ON x.user_id = u.id
      WHERE u.is_active = true AND x.streak_days >= 2 AND x.streak_freezes > 0
        AND (x.last_active_date IS NULL OR x.last_active_date < CURRENT_DATE - INTERVAL '1 day')
        AND NOT EXISTS (SELECT 1 FROM streak_freeze_log WHERE user_id = u.id AND saved_date = CURRENT_DATE)
    `));
    for (const r of atRisk as any[]) {
      await db.execute(sql`
        INSERT INTO streak_freeze_log (user_id, saved_date, streak_before) VALUES (${r.id}, CURRENT_DATE, ${r.streak_days})
        ON CONFLICT (user_id, saved_date) DO NOTHING
      `).catch(() => {});
      // Spend one freeze + bump last_active_date so the streak survives
      await db.execute(sql`
        UPDATE user_xp SET streak_freezes = GREATEST(0, streak_freezes - 1), last_active_date = CURRENT_DATE, updated_at = NOW()
        WHERE user_id = ${r.id}
      `).catch(() => {});
      freezes++;
    }
  } catch (_) {}

  return { ok: true, settled, promoted, demoted, freezes };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const isAdmin = user && user.role !== 'applicant';
  if (!isAdmin && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  return json(await settleLastWeek());
};
export const POST = GET;
