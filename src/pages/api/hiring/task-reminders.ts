// GET/POST /api/hiring/task-reminders
// Applicants sent a task (status = 'task_sent') have a standard 5-day deadline
// from task_sent_at. This sends a push + email reminder at 1 day left and again
// at 6 hours left — once each, per application, ever (deduped via a log table).
// Runs frequently (hourly, via GitHub Actions — see .github/workflows) rather
// than Vercel's daily-only Hobby cron, since a fixed daily run cannot land
// inside a moving 6-hour window for tasks issued at arbitrary times of day.
//
// -------------------------------------------------------------------------------------------------
// THE MOST FREQUENT SCHEDULED JOB IN THIS DEPLOYMENT, AND IT REPORTED NOTHING TO ANYBODY
// -------------------------------------------------------------------------------------------------
//
// .github/workflows/task-reminders.yml calls this 24 times a day with `continue-on-error: true` and
// an explicit `>= 500 -> ::warning -> exit 0` branch, so the Actions history is green whatever
// happens in here. The handler also wrote no cron row, so /admin/ops did not know the route existed.
// Between those two facts this job could have been failing every hour for weeks with no surface
// anywhere saying so. withCronRun() below is the half of that fix this file owns.
//
// THE OTHER HALF IS NOT IN THIS FILE. cronStatus() in src/lib/observability-health.ts renders the
// CONFIGURED_CRONS list, not whatever rows exist in edu_cron_runs — so until
// '/api/hiring/task-reminders' is added to CONFIGURED_CRONS, the executions written here sit in the
// database and /admin/ops still does not list them. It cannot go into vercel.json instead: Hobby
// crons are daily only, which is why this job lives in GitHub Actions in the first place.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { withDbTimeout } from '@/lib/db-timeout';
import { withCronRun } from '@/lib/observability-health';
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

const CRON_ID = '/api/hiring/task-reminders';

/**
 * The bound on every database wait in this file. postgres-js has no query timeout of its own, so an
 * unbounded await in a cron does not fail — it HANGS, holds its pooler slot for the whole
 * invocation, and the only evidence is a scheduled job that never reported an end.
 *
 * Four seconds because nobody is on a screen and the next run is an hour away: there is nothing to
 * gain by waiting longer than a healthy answer takes (~140ms warm, ~950ms when the instance has to
 * open a connection).
 */
const STEP_MS = 4000;

/**
 * How long this run may keep starting NEW applications. Checked between applications only.
 *
 * A single slow SMTP send is allowed twenty seconds by SMTP_SEND_BUDGET_MS
 * (src/lib/mail-transport.ts), against a serverless ceiling of ten. A run the platform kills
 * mid-list reports nothing at all, so this one stops by choice while it can still write down where
 * it stopped. Stopping costs nothing: the pending list is ordered most-urgent-first and no dedupe
 * row is written for anyone we did not reach, so the next hourly run resumes exactly here — both
 * reminder windows are far wider than the cadence.
 */
const RUN_BUDGET_MS = 8000;

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
  // Auth first, and OUTSIDE the telemetry: an unauthorised probe must not be able to write an
  // execution row and fabricate a run history for a job that never ran. src/pages/api/cron/hr-sweep.ts
  // states the same rule in the same place.
  if (!cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  try {
    return await withCronRun(CRON_ID, async () => {
      const startedAt = Date.now();

      // The bootstrap itself is untouched — this bounds only the WAIT for it. A timeout here is not
      // fatal: wherever the ALTER/CREATE has already run once the reads below work anyway, and where
      // it has not they fail loudly a few lines down instead of hanging.
      let schemaNote = '';
      try {
        await withDbTimeout(ensureSchema(), 'task-reminders.ensureSchema', STEP_MS);
      } catch (e: any) {
        schemaNote = 'the schema check did not answer';
        console.error('[task-reminders] schema check did not answer - ' + (e?.cause?.message || e?.message));
      }

      // If this read fails the whole run fails, loudly and on the record. An empty pending list must
      // keep meaning "nobody is inside a reminder window", never "we could not find out".
      // ORDER BY task_sent_at ASC puts the nearest deadline first, which is what makes the run
      // budget below safe: stopping short drops the least urgent applications, not an arbitrary
      // tail that would starve the same rows every hour.
      const pending = rows(await withDbTimeout(db.execute(sql`
        SELECT a.id, a.first_name, a.email, a.role_title_snapshot, a.applicant_user_id, a.task_sent_at
        FROM applications a
        WHERE a.status = 'task_sent'
          AND a.is_archived = false
          AND a.task_sent_at IS NOT NULL
          AND a.task_sent_at > NOW() - (${DEADLINE_DAYS} || ' days')::interval
        ORDER BY a.task_sent_at ASC
      `), 'task-reminders.pending', STEP_MS));

      let checked = 0, sent = 0, failed = 0, unconfirmed = 0;
      let stoppedEarly = false;

      for (const app of pending as any[]) {
        if (Date.now() - startedAt > RUN_BUDGET_MS) { stoppedEarly = true; break; }
        checked++;
        const deadline = new Date(new Date(app.task_sent_at).getTime() + DEADLINE_DAYS * 24 * 60 * 60 * 1000);
        const hoursLeft = (deadline.getTime() - Date.now()) / (1000 * 60 * 60);

        for (const w of WINDOWS) {
          if (hoursLeft < w.loHours || hoursLeft > w.hiHours) continue;

          let already: any[] = [];
          try {
            already = rows(await withDbTimeout(
              db.execute(sql`SELECT 1 FROM task_reminder_log WHERE application_id = ${app.id} AND kind = ${w.kind} LIMIT 1`),
              'task-reminders.dedupe', STEP_MS));
          } catch (e: any) {
            // We do not know whether this reminder already went. Sending anyway risks a second one;
            // skipping quietly would be counted as "nothing to do". So it is a named failure, and
            // the next hourly run asks again inside the same window.
            failed++;
            console.error('[task-reminders] could not check the reminder log for application ' + app.id + ' (' + w.kind + ') - ' + (e?.cause?.message || e?.message));
            continue;
          }
          if (already.length) continue;

          // DELIVER FIRST, RECORD SECOND.
          //
          // This used to INSERT the task_reminder_log row BEFORE sending, and that row is the
          // permanent "never send this again" key: a refused SMTP send or a failed notification was
          // written down as a delivered reminder, counted in `sent`, and no later run could ever
          // retry it. The applicant heard nothing about a deadline that does not move.
          //
          // sendEmail RESOLVES with { ok: false } when there is no transport — it does not throw —
          // so its result is read rather than merely awaited. That distinction is the defect itself:
          // on a deployment with SMTP misconfigured, `await sendEmail(...).catch(() => {})` recorded
          // every reminder as sent while not one of them left the building.
          let mailOk = false;
          let pushOk = false;
          let why = '';
          if (app.email) {
            try {
              const r = await sendEmail({
                to: app.email,
                subject: `Reminder: your task is due in ${w.label} - ${app.role_title_snapshot || 'EduRankAI'}`,
                html: emailHtml(app.first_name || '', app.role_title_snapshot || '', app.id, w.label),
              });
              mailOk = r?.ok === true;
              if (!mailOk) why = r?.error || 'the mail transport refused it';
            } catch (e: any) {
              why = e?.cause?.message || e?.message || 'the mail send threw';
            }
          }
          if (app.applicant_user_id) {
            try {
              // Resolves once the in-app notification row is written — src/lib/push.ts persists that
              // before it ever looks at VAPID — which is the delivery the applicant can actually see
              // in the bell. Browser push beyond that is best-effort inside sendPushToUser.
              await pushApplicant.taskDeadlineReminder(app.applicant_user_id, app.role_title_snapshot || 'your role', app.id, w.kind);
              pushOk = true;
            } catch (e: any) {
              if (!why) why = e?.cause?.message || e?.message || 'the notification could not be written';
            }
          }

          if (!mailOk && !pushOk) {
            // Nothing reached them, so nothing is written down: no log row means the next run tries
            // this same window again (20-28h and 4-8h are both far wider than the hourly cadence).
            failed++;
            console.error('[task-reminders] the ' + w.kind + ' reminder for application ' + app.id + ' was NOT delivered - '
              + (why || 'this application has no email address and no portal account, so there is no way to reach them'));
            continue;
          }

          try {
            await withDbTimeout(
              db.execute(sql`INSERT INTO task_reminder_log (application_id, kind) VALUES (${app.id}, ${w.kind}) ON CONFLICT DO NOTHING`),
              'task-reminders.log', STEP_MS);
          } catch (e: any) {
            // It WAS delivered; only the record of it failed. Counted as sent because it was sent,
            // and named here because the next run will find no log row and send it a second time —
            // a duplicate reminder is the deliberate trade against a silently missed one.
            unconfirmed++;
            console.error('[task-reminders] delivered the ' + w.kind + ' reminder for application ' + app.id
              + ' but could not write its dedupe row, so it may be sent again next hour - ' + (e?.cause?.message || e?.message));
          }
          sent++;
        }
      }

      const remaining = Math.max(0, (pending as any[]).length - checked);
      const detail = [
        sent + ' sent',
        failed ? failed + ' not delivered' : '',
        stoppedEarly ? 'stopped on the time budget with ' + remaining + ' application(s) unexamined' : '',
        unconfirmed ? unconfirmed + ' delivered with no dedupe row (may repeat next hour)' : '',
        schemaNote,
      ].filter(Boolean).join('; ');

      return {
        outcome: {
          // Being killed part-way used to look exactly like a quiet hour. `partial` is the state
          // that says "some of the work, and we know which part we did not do".
          status: stoppedEarly ? ('partial' as const) : undefined,
          processed: checked,
          succeeded: sent,
          failed,
          detail,
        },
        value: json({ ok: failed === 0, checked, sent, failed, unconfirmed, stoppedEarly, remaining, note: detail }),
      };
    });
  } catch (e: any) {
    // withCronRun has already recorded this as a failed run carrying the real reason; the caller
    // gets the same reason and a 5xx. A 200 here would have made the workflow — which inspects only
    // the status code — print "Success." over a run that sent nothing.
    const reason = e?.cause?.message || e?.message || 'the run threw with no message';
    console.error('[task-reminders] run failed - ' + reason);
    return json({ ok: false, error: 'The reminder run failed on our side: ' + reason, checked: 0, sent: 0 }, 500);
  }
};

export const GET = handler;
export const POST = handler;
