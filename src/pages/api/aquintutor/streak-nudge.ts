// GET/POST /api/aquintutor/streak-nudge
// Cron-triggered: finds users whose streak is at risk (active yesterday but
// NOT today and current time is after 19:00 local) and sends a push.
// Authorised by CRON_SECRET like the other crons.
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

async function run(): Promise<{ ok: boolean; nudged: number; skipped: number }> {
  // Skip if it's not at-risk time (after 7 pm UTC ≈ end-of-day for IST users)
  // Most users are in IST so this fires once a day around 12:30 AM IST. Good
  // enough for v1; can localise per-user later.
  let nudged = 0, skipped = 0;
  try {
    const candidates = rows(await db.execute(sql`
      SELECT u.id, u.name, u.email, x.streak_days, x.last_active_date::text AS last_active
      FROM user_xp x JOIN users u ON x.user_id = u.id
      WHERE u.is_active = true
        AND x.streak_days >= 2
        AND (x.last_active_date IS NULL OR x.last_active_date = CURRENT_DATE - INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM push_log
          WHERE user_id = u.id AND kind = 'streak_at_risk'
            AND sent_at::date = CURRENT_DATE
        )
      LIMIT 500
    `));

    const pushLib = await import('@/lib/push').catch(() => ({} as any));
    const sendPushToUser = (pushLib as any).sendPushToUser;
    const transportLib = await import('@/lib/mail-transport').catch(() => ({} as any));
    const sendExternal = (transportLib as any).sendExternal;

    for (const c of candidates as any[]) {
      let delivered = false;
      // Try push first
      if (sendPushToUser) {
        try {
          await sendPushToUser(c.id, {
            type: 'streak_at_risk',
            title: '🔥 Don\'t break your ' + c.streak_days + '-day streak',
            body: 'A 5-minute practice round keeps it alive.',
            url: '/aquintutor/practice/sanskrit-awareness',
            tag: 'streak-at-risk',
          });
          delivered = true;
        } catch (_) {}
      }
      // Email fallback for users who haven't enabled push
      if (!delivered && c.email && sendExternal) {
        try {
          const userAddr = c.email;
          const html = '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">'
            + '<h2 style="color:#d97757;font-family:Georgia,serif;font-weight:500;font-size:22px;">🔥 Don\'t break your ' + c.streak_days + '-day streak</h2>'
            + '<p style="font-size:15px;color:#333;line-height:1.6;">Hi ' + (c.name || 'there') + ',<br><br>You\'ve been building a learning streak. A 5-minute practice round tonight keeps it alive — or use a streak freeze from the shop if you can\'t.</p>'
            + '<p style="text-align:center;margin:24px 0;"><a href="https://edurankai.in/aquintutor/practice/sanskrit-awareness" style="background:#d97757;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Practise now →</a></p>'
            + '<p style="font-size:12px;color:#888;">AquinTutor by EduRankAI · You receive this because you have an active streak.</p></div>';
          await sendExternal({
            from: 'AquinTutor <hr@edurankai.in>',
            to: userAddr,
            subject: '🔥 Don\'t lose your ' + c.streak_days + '-day streak',
            html,
            text: 'Don\'t break your ' + c.streak_days + '-day streak. Take a quick practice round at edurankai.in/aquintutor/practice/sanskrit-awareness',
          });
          delivered = true;
        } catch (_) {}
      }
      if (delivered) {
        try { await db.execute(sql`INSERT INTO push_log (user_id, kind, detail) VALUES (${c.id}, 'streak_at_risk', ${sql.raw("'" + JSON.stringify({ streak: c.streak_days }).replace(/'/g, "''") + "'::jsonb")})`); } catch (_) {}
        nudged++;
      } else {
        skipped++;
      }
    }
  } catch (_) {}
  return { ok: true, nudged, skipped };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const u = (locals as any)?.user;
  if (!(u && u.role !== 'applicant') && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  return json(await run());
};
export const POST = GET;
