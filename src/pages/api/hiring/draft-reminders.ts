// GET/POST /api/hiring/draft-reminders
// Daily cron: applicants who started an application (application_drafts) but
// never submitted get a polite nudge to finish. At most TWO reminders per
// email, spaced 3+ days apart, and only while the draft is 1-30 days old —
// never a spam stream. Authorised by CRON_SECRET like the other crons.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { sendExternal } from '@/lib/mail-transport';

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

let schemaReady: Promise<void> | null = null;
function ensureLog(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS draft_reminder_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        reminder_no INT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS draft_reminder_email_idx ON draft_reminder_log(email)`);
    } catch (_) { schemaReady = null; }
  })();
  return schemaReady;
}

function esc(s: string): string {
  return String(s || '').replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]));
}

function emailHtml(name: string, step: number, isFinal: boolean): string {
  const resume = 'https://edurankai.in/apply/step-' + (step >= 1 && step <= 6 ? step : 1);
  const lead = isFinal
    ? 'A last gentle note — your application draft is still saved, and it only takes a few minutes to finish.'
    : 'You started an application with us and your progress is saved. Whenever you are ready, you can pick up exactly where you left off.';
  return (
    '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">'
    + '<p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#FF4F00;margin:0 0 18px;">EduRankAI Careers</p>'
    + '<h1 style="font-size:22px;font-weight:600;margin:0 0 14px;">Your application is waiting' + (name ? ', ' + esc(name) : '') + '.</h1>'
    + '<p style="font-size:15px;line-height:1.7;margin:0 0 10px;">' + lead + '</p>'
    + '<p style="font-size:15px;line-height:1.7;margin:0 0 22px;">You are on <strong>step ' + step + ' of 6</strong>. Every application is read personally — there is no automated rejection here.</p>'
    + '<a href="' + resume + '" style="display:inline-block;background:#FF4F00;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">Continue my application</a>'
    + '<p style="font-size:12.5px;color:#8a8a8a;line-height:1.6;margin:26px 0 0;">If you have decided not to apply, no action is needed — this draft simply expires and this is ' + (isFinal ? 'the last reminder you will receive' : 'one of at most two reminders') + '.</p>'
    + '</div>'
  );
}

async function run(): Promise<{ ok: boolean; sent: number; skipped: number }> {
  await ensureLog();
  let sent = 0, skipped = 0;
  try {
    // Drafts idle for 24h+, at most 30 days old, whose email never submitted
    // an application, with fewer than 2 reminders and none in the last 3 days.
    const candidates = rows(await db.execute(sql`
      SELECT d.email, MAX(d.step) AS step, MAX(d.data->>'firstName') AS first_name,
             COALESCE(r.cnt, 0) AS reminders
      FROM application_drafts d
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, MAX(sent_at) AS last_sent
        FROM draft_reminder_log l WHERE LOWER(l.email) = LOWER(d.email)
      ) r ON true
      WHERE d.updated_at < NOW() - INTERVAL '24 hours'
        AND d.updated_at > NOW() - INTERVAL '30 days'
        AND COALESCE(r.cnt, 0) < 2
        AND (r.last_sent IS NULL OR r.last_sent < NOW() - INTERVAL '3 days')
        AND NOT EXISTS (
          SELECT 1 FROM applications a WHERE LOWER(a.email) = LOWER(d.email)
        )
      GROUP BY d.email, r.cnt
      LIMIT 50
    `));

    for (const c of candidates) {
      const nth = Number(c.reminders || 0) + 1;
      const step = Math.max(1, Math.min(6, Number(c.step || 1)));
      const isFinal = nth >= 2;
      const subject = isFinal
        ? 'Last reminder — your EduRankAI application draft is still saved'
        : 'Pick up where you left off — your EduRankAI application';
      try {
        const res = await sendExternal({
          from: 'EduRankAI Careers <connect@edurankai.in>',
          to: c.email,
          subject,
          html: emailHtml(String(c.first_name || ''), step, isFinal),
          text: subject + ' Continue at https://edurankai.in/apply/step-' + step,
        });
        if ((res as any)?.ok === false) { skipped++; continue; }
        await db.execute(sql`INSERT INTO draft_reminder_log (email, reminder_no) VALUES (${c.email}, ${nth})`);
        sent++;
      } catch (_) { skipped++; }
    }
  } catch (_) { /* never throw from a cron */ }
  return { ok: true, sent, skipped };
}

export const GET: APIRoute = async ({ request }) => {
  if (!cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  return json(await run());
};
export const POST = GET;
