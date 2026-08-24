// GET/POST /api/aquintutor/streak-nudge
// Cron-triggered: finds users whose streak is at risk (active yesterday but
// NOT today and current time is after 19:00 local) and sends a push.
// Authorised by CRON_SECRET like the other crons.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS JOB USED TO REPORT, AND WHY NONE OF IT COULD BE BELIEVED
//
// The entire body sat inside one `try { ... } catch (_) {}` and the function then returned
// `{ ok: true, nudged, skipped }` unconditionally. A candidate query that timed out, a push module
// that failed to import, a mail transport that was never configured and a genuinely quiet night all
// produced the same answer: ok true, nudged 0. Nobody is on a screen at 14:30 UTC to notice, and the
// route recorded no cron run either — it is in vercel.json and in CONFIGURED_CRONS but called
// neither withCronRun nor recordCronRun, so /admin/ops showed `never_run` for it permanently.
//
// The sharpest edge was push_log. It is referenced nowhere else in src/, exists in no db/*.sql, and
// is created only by the hand-run .dev-scripts/migrate-aquintutor-engagement-v3.cjs — so if that
// migration was never applied to the live database, the NOT EXISTS probe below makes the candidate
// query throw EVERY night and the blanket catch turned that into a cheerful ok:true. That read is
// deliberately unguarded now: if it fails, the run is recorded as failed with the Postgres reason
// and the route answers 500, because "there was nobody to nudge" and "we could not look" are not the
// same sentence.
//
// A SEND THAT WAS NOT CONFIRMED IS NOT A SEND. sendExternal() RESOLVES with { ok: false, error }
// when SMTP refuses — it does not throw (src/lib/mail-transport.ts). The old code awaited it and
// counted every attempt as `nudged`, then wrote the push_log row that means "already nudged today",
// so a mail outage silently consumed the day's only chance to reach that learner. Now only a
// confirmed delivery writes that row.
//
// AND IT MUST BE ABLE TO FINISH. 500 candidates, each with a push, possibly a full external SMTP
// send and an INSERT, run one at a time, is past any invocation ceiling — and a killed invocation
// holds its pooler connection and reports nothing at all. The cap is 100 with a deadline, and a run
// that stops short says so instead of implying it reached everyone. Nobody who is not reached loses
// anything: the push_log row is the only anti-repeat key, so an unreached learner is simply picked
// up by the next run.
//
// STILL OPEN, DELIBERATELY NOT PAPERED OVER HERE: sendExternal() carries its own 20s budget
// (src/lib/mail-transport.ts), longer than this whole invocation is allowed to live. The deadline
// below stops us STARTING a send once the budget is spent, but one slow SMTP host part-way through
// can still get the invocation killed — which then shows on /admin/ops as a run stuck at `running`
// and later relabelled `timeout`, rather than as silence. Moving these onto edu_jobs is the real
// fix and is a larger change than this one.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can } from '@/lib/auth/permissions';
import { withDbTimeout } from '@/lib/db-timeout';
import { withCronRun, publicErrorSummary } from '@/lib/observability-health';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

// THE MACHINE ARM, LEFT EXACTLY AS IT IS. A shared secret is not a role and no capability replaces
// it. It already fails CLOSED when CRON_SECRET is unset, unlike src/pages/api/cron/*.
function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = request.headers.get('authorization') || '';
  if (a === `Bearer ${secret}`) return true;
  const x = request.headers.get('x-cron-secret') || '';
  return x === secret;
}

// EVERY const BEFORE THE HANDLER THAT READS IT — `const` is not hoisted, and that has taken pages
// down on this project.
//
// The path must match CONFIGURED_CRONS in src/lib/observability-health.ts character for character,
// or /admin/ops goes on reporting this job as never run while rows accumulate under a path nobody
// watches.
const CRON_ID = '/api/aquintutor/streak-nudge';
/** One statement's bound. postgres-js has no query timeout, so without this an await simply hangs. */
const STEP_MS = 4000;
/** When to stop taking on new candidates, so the run ends by choice rather than being killed. */
const RUN_BUDGET_MS = 8000;
/** Candidates one invocation will look at. Was 500, which could not finish. */
const CANDIDATE_LIMIT = 100;

interface NudgeReport {
  ok: boolean;
  looked: number; nudged: number; skipped: number; failed: number;
  stoppedShort: boolean;
  errors: string[];
}

async function run(): Promise<{ report: NudgeReport; rawError: string }> {
  // Skip if it's not at-risk time (after 7 pm UTC ≈ end-of-day for IST users)
  // Most users are in IST so this fires once a day around 12:30 AM IST. Good
  // enough for v1; can localise per-user later.
  const startedAt = Date.now();
  let nudged = 0, skipped = 0, failed = 0;
  let stoppedShort = false;
  let rawError = '';
  const errors: string[] = [];

  // The unredacted reason goes to the log and to edu_cron_runs (both behind `administer`); the
  // response body gets the scrubbed one, because `jobs.run` is granted to ten roles including
  // partner, teacher and intern-flagged accounts. e.message is only the failed SQL — the reason is
  // on e.cause.
  const note = (where: string, e: any) => {
    const raw = String(e?.cause?.message || e?.message || 'no reason given');
    console.error('[streak-nudge] ' + where + ' —', raw);
    if (!rawError) rawError = where + ': ' + raw;
    if (errors.length < 5) errors.push(where + ': ' + publicErrorSummary(raw));
  };

  // NOT WRAPPED IN A try/catch, deliberately: see the header. A failed read must not be able to
  // report an empty night.
  const candidates = rows(await withDbTimeout(db.execute(sql`
    SELECT u.id, u.name, u.email, x.streak_days, x.last_active_date::text AS last_active
    FROM user_xp x JOIN users u ON x.user_id = u.id
    WHERE u.is_active = true
      AND x.streak_days >= 2
      AND (x.last_active_date IS NULL OR x.last_active_date = CURRENT_DATE - INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM push_log
        WHERE user_id = u.id AND kind = 'streak_at_risk'
          -- A RANGE, NOT sent_at::date = CURRENT_DATE. Casting the COLUMN is the shape this project
          -- has already written down as index-defeating (see idEq() in src/lib/workforce/scale.ts);
          -- push_log_user_kind_idx is (user_id, kind, sent_at DESC), so the equality prefix was
          -- usable but the date predicate was not.
          AND sent_at >= CURRENT_DATE AND sent_at < CURRENT_DATE + 1
      )
    LIMIT ${CANDIDATE_LIMIT}
  `), 'streak-nudge.candidates', STEP_MS));

  // There may be more at-risk learners than the cap. Saying so is the difference between "we nudged
  // everyone" and "we nudged the first hundred".
  if (candidates.length >= CANDIDATE_LIMIT) stoppedShort = true;

  // A module that fails to import used to be indistinguishable from a night with nothing to send:
  // `.catch(() => ({}))` produced an empty object and the loop simply skipped every delivery.
  let sendPushToUser: any = null;
  try {
    const pushLib: any = await import('@/lib/push');
    sendPushToUser = typeof pushLib?.sendPushToUser === 'function' ? pushLib.sendPushToUser : null;
    if (!sendPushToUser) note('push module', new Error('sendPushToUser is not exported'));
  } catch (e: any) {
    note('push module import', e);
  }
  let sendExternal: any = null;
  try {
    const transportLib: any = await import('@/lib/mail-transport');
    sendExternal = typeof transportLib?.sendExternal === 'function' ? transportLib.sendExternal : null;
    if (!sendExternal) note('mail transport', new Error('sendExternal is not exported'));
  } catch (e: any) {
    note('mail transport import', e);
  }

  for (const c of candidates as any[]) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      // No push_log row was written for anyone we did not reach, and that row is the only
      // anti-repeat key — so the remainder is picked up by the next run rather than lost.
      stoppedShort = true;
      break;
    }

    let delivered = false;
    let attempted = false;
    let reason: any = null;

    // Try push first
    if (sendPushToUser) {
      attempted = true;
      try {
        await sendPushToUser(c.id, {
          type: 'streak_at_risk',
          title: 'Don\'t break your ' + c.streak_days + '-day streak',
          body: 'A 5-minute practice round keeps it alive.',
          url: '/aquintutor/practice/sanskrit-awareness',
          tag: 'streak-at-risk',
        });
        delivered = true;
      } catch (e: any) { reason = e; }
    }

    // Email fallback for users who haven't enabled push
    if (!delivered && c.email && sendExternal) {
      attempted = true;
      try {
        const userAddr = c.email;
        const html = '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">'
          + '<h2 style="color:#d97757;font-family:Georgia,serif;font-weight:500;font-size:22px;">Don\'t break your ' + c.streak_days + '-day streak</h2>'
          + '<p style="font-size:15px;color:#333;line-height:1.6;">Hi ' + (c.name || 'there') + ',<br><br>You\'ve been building a learning streak. A 5-minute practice round tonight keeps it alive — or use a streak freeze from the shop if you can\'t.</p>'
          + '<p style="text-align:center;margin:24px 0;"><a href="https://edurankai.in/aquintutor/practice/sanskrit-awareness" style="background:#d97757;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Practise now →</a></p>'
          + '<p style="font-size:12px;color:#888;">AquinTutor by EduRankAI · You receive this because you have an active streak.</p></div>';
        const res = await sendExternal({
          from: 'AquinTutor <hr@edurankai.in>',
          to: userAddr,
          subject: 'Don\'t lose your ' + c.streak_days + '-day streak',
          html,
          text: 'Don\'t break your ' + c.streak_days + '-day streak. Take a quick practice round at edurankai.in/aquintutor/practice/sanskrit-awareness',
        });
        // A resolved promise is not a delivered mail. See the header: anything other than an
        // explicit ok is a nudge that did not go, and must not write the anti-repeat row.
        if (!res || res.ok !== true) reason = new Error((res && res.error) || 'the transport did not confirm the send');
        else delivered = true;
      } catch (e: any) { reason = e; }
    }

    if (delivered) {
      // THE ANTI-REPEAT ROW, WRITTEN ONLY AFTER SOMETHING ACTUALLY WENT OUT, and no longer wrapped
      // in a catch that hid its failure. If this write fails, every remaining nudge in this run
      // would go unrecorded too and the whole cohort would be nudged twice tomorrow — so it
      // propagates, withCronRun records the run as failed with the real reason, and the rest is left
      // for a run that can record what it did.
      //
      // Bound as a parameter and cast, not assembled with sql.raw: the old spelling escaped its own
      // quotes correctly, so this is hygiene rather than a hole, but a hand-rolled escape in a JSON
      // literal is not a thing to leave lying about.
      await withDbTimeout(db.execute(sql`
        INSERT INTO push_log (user_id, kind, detail)
        VALUES (${c.id}, 'streak_at_risk', ${JSON.stringify({ streak: c.streak_days })}::jsonb)
      `), 'streak-nudge.pushLog', STEP_MS);
      nudged++;
    } else if (attempted) {
      // We tried and it did not go. This used to be counted as `skipped`, which reads as "nothing to
      // do" — the opposite of what happened.
      failed++;
      note('nudging one learner', reason || new Error('no delivery route confirmed it'));
    } else {
      // Nothing to try: no push module and no address. Genuinely skipped.
      skipped++;
    }
  }

  const report: NudgeReport = {
    ok: failed === 0 && errors.length === 0,
    looked: candidates.length, nudged, skipped, failed, stoppedShort, errors,
  };
  return { report, rawError };
}

// TWO ARMS, AND ONLY THE HUMAN ONE MOVED. `jobs.run` is granted in PERMS_BY_ROLE to exactly the ten
// non-applicant built-in roles that passed `u.role !== 'applicant'`, so the same accounts pass and
// fail. Moved together with league-settle.ts, which shares the key and the shape.
//
// REPORTED AS TOO WIDE, not narrowed here: any internal role — including partner, teacher,
// technical_moderator and every intern-flagged account — can fan a push notification out to every
// learner on demand. That is now a grant to withdraw rather than a file to re-audit.
export const GET: APIRoute = async ({ request, locals }) => {
  const u = (locals as any)?.user;
  // TELEMETRY STARTS AFTER THE AUTH CHECK, never before it, so an unauthorised probe cannot write an
  // execution row and fabricate a healthy history for a job that never ran. Same shape as
  // src/pages/api/cron/hr-sweep.ts.
  if (!can(u, 'jobs.run') && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    return await withCronRun(CRON_ID, async () => {
      const { report, rawError } = await run();
      return {
        outcome: {
          // Stated rather than derived: deriveCronStatus() would call a run that nudged the first
          // hundred and stopped on its own deadline — or one that reached nobody because the push
          // module would not load — a success.
          status: report.failed === 0 && (report.stoppedShort || report.errors.length > 0) ? ('partial' as const) : undefined,
          // What we actually got through, NOT how many candidates we read — a run that stopped on
          // its deadline must not report the ones it never reached as processed.
          processed: report.nudged + report.skipped + report.failed,
          succeeded: report.nudged,
          failed: report.failed,
          detail: report.nudged + ' nudged, ' + report.skipped + ' with nothing to send to, ' + report.failed
            + ' failed, of ' + report.looked + ' candidate(s) read'
            + (report.stoppedShort ? '; stopped short on purpose — the rest resume next run' : ''),
          errorMessage: rawError || undefined,
        },
        // 207 when some of it did not happen, so a caller that only reads the status code still sees
        // the difference between a clean run and a partial one.
        value: json(report, report.ok ? 200 : 207),
      };
    });
  } catch (e: any) {
    // The candidate read and the anti-repeat write are deliberately unguarded inside run(): if
    // either fails we do not know that there was nobody to nudge. withCronRun has already recorded
    // `failed` with the real reason; the body carries the scrubbed one.
    const raw = e?.cause?.message || e?.message || 'no reason given';
    console.error('[streak-nudge] the nudge run could not complete —', raw);
    return json({ ok: false, error: 'The streak nudge could not run: ' + publicErrorSummary(raw) + '. This is a problem on our side; we cannot say whether anyone was nudged.' }, 500);
  }
};
export const POST = GET;
