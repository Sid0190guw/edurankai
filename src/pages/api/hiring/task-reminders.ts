// GET/POST /api/hiring/task-reminders
// Applicants sent a task (status = 'task_sent') have a standard 5-day deadline
// from task_sent_at. This sends a push + email reminder at 1 day left and again
// at 6 hours left — once each, per application, ever (deduped via a log table).
// Runs frequently (hourly, via GitHub Actions — see .github/workflows) rather
// than Vercel's daily-only Hobby cron, since a fixed daily run cannot land
// inside a moving 6-hour window for tasks issued at arbitrary times of day.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { sendEmail, brandedEmail } from '@/lib/email';
import { pushApplicant } from '@/lib/push';

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
function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS task_sent_at TIMESTAMPTZ`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS task_reminder_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL,
        kind VARCHAR(10) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(application_id, kind))`);
    } catch (_) { schemaReady = null; }
  })();
  return schemaReady;
}

const DEADLINE_DAYS = 5;
// Window widths are generous relative to the hourly run cadence so a single
// missed/delayed run never causes a skipped reminder.
const WINDOWS: { kind: '24h' | '6h'; loHours: number; hiHours: number; label: string }[] = [
  { kind: '24h', loHours: 20, hiHours: 28, label: '1 day' },
  { kind: '6h', loHours: 4, hiHours: 8, label: '6 hours' },
];

function emailHtml(name: string, roleTitle: string, appId: string, label: string): string {
  return brandedEmail({
    preheader: `Your task is due in ${label}`,
    heading: `Task due in ${label}${name ? ', ' + name : ''}`,
    body: `<p>A quick reminder — the task for <strong>${roleTitle || 'your application'}</strong> is due in <strong>${label}</strong>. Submissions after the deadline are not reviewed, so please wrap up and submit from your application.</p>`,
    ctaText: 'Open my application',
    ctaUrl: 'https://edurankai.in/portal/applications/' + appId,
    footerNote: 'You are receiving this because a task was assigned as part of your EduRankAI application.',
  });
}

const handler: APIRoute = async ({ request }) => {
  if (!cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  await ensureSchema();

  const pending = rows(await db.execute(sql`
    SELECT a.id, a.first_name, a.email, a.role_title_snapshot, a.applicant_user_id, a.task_sent_at
    FROM applications a
    WHERE a.status = 'task_sent'
      AND a.is_archived = false
      AND a.task_sent_at IS NOT NULL
      AND a.task_sent_at > NOW() - (${DEADLINE_DAYS} || ' days')::interval
  `));

  let checked = 0, sent = 0;
  for (const app of pending as any[]) {
    checked++;
    const deadline = new Date(new Date(app.task_sent_at).getTime() + DEADLINE_DAYS * 24 * 60 * 60 * 1000);
    const hoursLeft = (deadline.getTime() - Date.now()) / (1000 * 60 * 60);

    for (const w of WINDOWS) {
      if (hoursLeft < w.loHours || hoursLeft > w.hiHours) continue;
      const already = rows(await db.execute(sql`SELECT 1 FROM task_reminder_log WHERE application_id = ${app.id} AND kind = ${w.kind} LIMIT 1`));
      if (already.length) continue;

      try {
        await db.execute(sql`INSERT INTO task_reminder_log (application_id, kind) VALUES (${app.id}, ${w.kind}) ON CONFLICT DO NOTHING`);
        if (app.email) {
          await sendEmail({
            to: app.email,
            subject: `Reminder: your task is due in ${w.label} - ${app.role_title_snapshot || 'EduRankAI'}`,
            html: emailHtml(app.first_name || '', app.role_title_snapshot || '', app.id, w.label),
          }).catch(() => {});
        }
        if (app.applicant_user_id) {
          await pushApplicant.taskDeadlineReminder(app.applicant_user_id, app.role_title_snapshot || 'your role', app.id, w.kind).catch(() => {});
        }
        sent++;
      } catch (_) { /* best-effort; next run can't retry this exact window but the other window still can */ }
    }
  }

  return json({ ok: true, checked, sent });
};

export const GET = handler;
export const POST = handler;
