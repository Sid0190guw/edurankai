// GET/POST /api/aquintutor/league-settle
// Weekly cron: finds last week's leagues, ranks members by week_xp, marks
// top 5 promoted, bottom 5 demoted, rest hold. Updates each user's
// user_xp.league_tier. Emails the result + applies auto-streak-freeze for
// any user whose streak is at risk and holds a freeze.
//
// Authorised via CRON_SECRET. Idempotent on processed_at.
//
// -------------------------------------------------------------------------------------------------
// NOBODY IS ON A SCREEN AT 01:00 ON A MONDAY, which is why every failure this file used to have was
// silent. Four of them, in the order they hurt:
//
// 1. RESUMPTION WAS PER LEAGUE, NOT PER MEMBER. The leagues query excluded any league that already
//    had ONE processed row (`id NOT IN (SELECT DISTINCT league_id ... WHERE processed_at IS NOT
//    NULL)`). Each member cost three round trips at ~140ms warm, so at a real cohort count the
//    platform killed the invocation part-way through — and from the next Monday on, every member the
//    dead run had not reached was skipped FOREVER: no rank, no promotion, no demotion, no notice,
//    and a user_xp.league_tier still showing last week's tier while the few who were reached moved
//    up. Nothing else in src/ writes processed_at, final_rank, placement_result or league_tier, so
//    no later run and no screen could repair it. The predicate is now EXISTS(... processed_at IS
//    NULL): a league stays in scope until every one of its members has been settled.
//
// 2. RANK IS THE ARRAY POSITION, so the members query must keep returning the WHOLE cohort on a
//    resumed run. Filtering it to unprocessed rows renumbers the survivors from 1 and re-ranks
//    everyone wrongly — someone who finished 27th would be promoted. Already-settled members are
//    read, counted into `n` and into everyone's rank, and only then skipped.
//
// 3. THE PLACEMENT WRITES WERE `.catch(() => {})` AND `settled++` RAN REGARDLESS. A run could report
//    thirty settled placements having written none — which is exactly what happened while
//    processed_at did not exist yet (see the note in src/lib/leagues.ts). Both writes are now
//    batched per league and only the ids Postgres actually returns are counted.
//
// 4. NOTHING RECORDED THE RUN. The route was in vercel.json and in CONFIGURED_CRONS but called
//    neither withCronRun nor recordCronRun, so /admin/ops said `never_run` for it permanently while
//    the handler always answered `{ok: true}`. There was no way to tell a complete settle from one
//    that died after four members.
//
// THE ORDER OF THE TWO WRITES IS LOAD-BEARING: tier first, placement second. Both values come from a
// deterministic ordering, so re-doing a member is a no-op, and a kill between the two leaves the
// member unprocessed for the next run to redo correctly. The reverse order would mark a member done
// while their tier stayed stale, and nothing would ever revisit them. The notice is sent only AFTER
// the placement commits, so no learner is told they were promoted by a run that recorded nothing;
// the cost is that a kill during the mail phase loses that notice, which is the cheaper failure.
//
// STILL OPEN, DELIBERATELY NOT PAPERED OVER HERE: sendExternal() carries its own 20s budget
// (src/lib/mail-transport.ts), which is longer than this whole invocation is allowed to live. The
// deadline below stops us STARTING a send that cannot finish, but one slow SMTP host can still eat
// the run. Moving these notices onto edu_jobs is the real fix and is a bigger change than this one.
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
// it; converting it would be inventing a rule, not translating one. Note it already fails CLOSED
// when CRON_SECRET is unset (`if (!secret) return false`) — unlike the fail-OPEN spelling in
// src/pages/api/cron/*, which is reported separately and not touched here.
function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = request.headers.get('authorization') || '';
  if (a === `Bearer ${secret}`) return true;
  const x = request.headers.get('x-cron-secret') || '';
  return x === secret;
}

// EVERY const BEFORE THE HANDLER THAT READS IT. `const` is not hoisted, and a const used above its
// declaration has taken pages down on this project.
const TIER_LABEL: Record<number, string> = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Sapphire', 5: 'Diamond' };
const PROMOTE_TOP = 5, DEMOTE_BOTTOM = 5, MAX_TIER = 5;

// Must match CONFIGURED_CRONS in src/lib/observability-health.ts character for character, or
// /admin/ops keeps reporting this job as never run while these rows pile up under a path nobody
// watches.
const CRON_ID = '/api/aquintutor/league-settle';

/** One statement's bound. postgres-js has no query timeout, so without this an await simply hangs. */
const STEP_MS = 4000;
/**
 * When to stop taking on new work. The run then ENDS BY CHOICE and says so, and the leagues it did
 * not reach are still unsettled, so the next run picks them up — which is only true because
 * resumption is now per member. A killed invocation reports nothing at all.
 */
const RUN_BUDGET_MS = 8000;
/** Tuples per batched UPDATE. Cohorts are ~30 (COHORT_SIZE in src/lib/leagues.ts); this is headroom. */
const WRITE_CHUNK = 100;
/** How many at-risk streaks one invocation will try to freeze. Reported when it is reached. */
const FREEZE_LIMIT = 500;

interface Placement {
  id: string; userId: string; rank: number; result: string; tier: number;
  email: string; name: string; weekXp: number; oldTier: number;
}

interface SettleReport {
  ok: boolean;
  leagues: number; leaguesSettled: number;
  settled: number; failed: number;
  promoted: number; demoted: number;
  notices: number; noticesFailed: number; noticesSkipped: number;
  freezes: number;
  stoppedShort: boolean;
  errors: string[];
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function settleLastWeek(): Promise<{ report: SettleReport; rawError: string }> {
  const startedAt = Date.now();
  let leaguesSettled = 0, settled = 0, failed = 0, promoted = 0, demoted = 0;
  let notices = 0, noticesFailed = 0, noticesSkipped = 0, freezes = 0;
  let stoppedShort = false;
  let rawError = '';
  const errors: string[] = [];

  // The unredacted reason goes to the log and to edu_cron_runs (both behind `administer`); the
  // response body gets the scrubbed one, because `jobs.run` is granted to ten roles including
  // partner, teacher and intern-flagged accounts. e.message is only the failed SQL — the reason is
  // on e.cause.
  const note = (where: string, e: any) => {
    const raw = String(e?.cause?.message || e?.message || 'no reason given');
    console.error('[league-settle] ' + where + ' —', raw);
    if (!rawError) rawError = where + ': ' + raw;
    if (errors.length < 5) errors.push(where + ': ' + publicErrorSummary(raw));
  };

  // Loaded on first actual need, so a week with nothing to settle is not reported as a mail failure.
  let mailer: any = null, mailerTried = false;
  const transport = async (): Promise<any> => {
    if (mailerTried) return mailer;
    mailerTried = true;
    try {
      const tlib: any = await import('@/lib/mail-transport');
      mailer = typeof tlib?.sendExternal === 'function' ? tlib.sendExternal : null;
      // A mail module that loads but exports nothing usable used to mean silence: the old code did
      // `if (sendExternal)` and simply skipped every notice without saying so.
      if (!mailer) note('mail transport', new Error('sendExternal is not exported'));
    } catch (e: any) {
      note('mail transport import', e);
    }
    return mailer;
  };

  // THE WEEK START IS A SQL EXPRESSION, NOT A ROUND TRIP. It used to be a whole statement whose only
  // job was to fetch one date string back so the next statement could hand it straight to Postgres
  // again — ~140ms warm, ~950ms whenever the instance had to open a connection, for nothing. It is
  // not new Date() in JS either: week_start is a DATE the database writes and compares. Same removal
  // as src/lib/leagues.ts records.
  //
  // NOT WRAPPED IN A try/catch: if this read fails we do NOT know that there are no leagues to
  // settle, and reporting a clean zero over a failed read is the thing this pass exists to remove.
  // withCronRun records the throw as `failed` with the real reason and the route answers 500.
  const leagues = rows(await withDbTimeout(db.execute(sql`
    SELECT id, tier_level FROM leagues
    WHERE week_start = (date_trunc('week', CURRENT_DATE) - INTERVAL '7 days')::date
      AND EXISTS (SELECT 1 FROM league_memberships m WHERE m.league_id = leagues.id AND m.processed_at IS NULL)
    ORDER BY tier_level ASC, cohort_number ASC
  `), 'league-settle.leagues', STEP_MS));

  for (const L of leagues as any[]) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) { stoppedShort = true; break; }

    let members: any[] = [];
    try {
      // ONE read per league instead of one per member: the old loop asked users for an email address
      // on every single member, a third round trip each, to send at most PROMOTE_TOP + DEMOTE_BOTTOM
      // notices. LEFT JOIN, so a membership whose user row has gone still gets ranked and settled.
      members = rows(await withDbTimeout(db.execute(sql`
        SELECT lm.id, lm.user_id, lm.week_xp, lm.processed_at, u.email, u.name
        FROM league_memberships lm
        LEFT JOIN users u ON u.id = lm.user_id
        WHERE lm.league_id = ${L.id}
        ORDER BY lm.week_xp DESC, lm.joined_at ASC
      `), 'league-settle.members', STEP_MS));
    } catch (e: any) {
      // This league is left entirely unprocessed, so the next run finds it again. Counting it as one
      // failed unit is what keeps the run out of `success`.
      note('members of one league', e);
      failed++;
      continue;
    }

    const n = members.length;
    const pending: Placement[] = [];
    for (let i = 0; i < n; i++) {
      const m = members[i] as any;
      const rank = i + 1;
      // Ranked against the FULL cohort above, then skipped. See point 2 in the header: dropping
      // settled members from the query instead would renumber everyone below them.
      if (m.processed_at) continue;
      let result = 'hold';
      let newTier = Number(L.tier_level);
      if (rank <= PROMOTE_TOP && L.tier_level < MAX_TIER) { result = 'promoted'; newTier = Number(L.tier_level) + 1; }
      else if (rank > n - DEMOTE_BOTTOM && L.tier_level > 1 && n >= 20) { result = 'demoted'; newTier = Number(L.tier_level) - 1; }
      pending.push({
        id: String(m.id), userId: String(m.user_id), rank, result, tier: newTier,
        email: String(m.email || ''), name: String(m.name || ''),
        weekXp: Number(m.week_xp || 0), oldTier: Number(L.tier_level),
      });
    }

    const written: Placement[] = [];
    for (const part of chunk(pending, WRITE_CHUNK)) {
      try {
        // TIER FIRST — see the header. Re-doing a member rewrites the same absolute value, so a kill
        // here costs nothing but a repeat on the next run.
        //
        // VALUES + UPDATE ... FROM, not one statement per member: thirty members were ninety round
        // trips. And a VALUES list rather than `= ANY(${array})`, which this driver renders as a row
        // constructor and Postgres rejects — the reason is written up on idIn() in
        // src/lib/workforce/scale.ts.
        await withDbTimeout(db.execute(sql`
          UPDATE user_xp AS x SET league_tier = v.tier
          FROM (VALUES ${sql.join(part.map((p) => sql`(${p.userId}::uuid, ${p.tier}::int)`), sql`, `)}) AS v(user_id, tier)
          WHERE x.user_id = v.user_id
        `), 'league-settle.tiers', STEP_MS);

        const done = rows(await withDbTimeout(db.execute(sql`
          UPDATE league_memberships AS lm
             SET final_rank = v.rk, placement_result = v.res, processed_at = NOW()
          FROM (VALUES ${sql.join(part.map((p) => sql`(${p.id}::uuid, ${p.rank}::int, ${p.result}::text)`), sql`, `)}) AS v(mid, rk, res)
          WHERE lm.id = v.mid
          RETURNING lm.id
        `), 'league-settle.placements', STEP_MS));

        // ONLY WHAT POSTGRES SAID IT WROTE. `settled` used to be incremented next to two swallowed
        // UPDATEs, which is how a run reported placements it had not made.
        const ids = new Set(done.map((r: any) => String(r.id)));
        for (const p of part) {
          if (!ids.has(p.id)) { failed++; continue; }
          settled++;
          written.push(p);
          if (p.result === 'promoted') promoted++;
          else if (p.result === 'demoted') demoted++;
        }
      } catch (e: any) {
        note('placing ' + part.length + ' member(s)', e);
        failed += part.length;
      }
    }

    if (pending.length === 0 || written.length === pending.length) leaguesSettled++;

    // NOTICES LAST, AND ONLY FOR CONFIRMED PLACEMENTS.
    for (const p of written) {
      if (p.result === 'hold' || !p.email) continue;
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        // The placement is recorded, so this learner will never be selected again — the notice is
        // genuinely lost rather than deferred, and the count says so instead of implying it went.
        noticesSkipped++;
        stoppedShort = true;
        continue;
      }
      const send = await transport();
      if (!send) { noticesSkipped++; continue; }
      const oldLabel = TIER_LABEL[p.oldTier] || 'Bronze';
      const newLabel = TIER_LABEL[p.tier] || 'Bronze';
      const subj = p.result === 'promoted' ? 'Promoted to ' + newLabel + ' League!' : 'Demoted to ' + newLabel + ' — get back in the race';
      const html = '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">'
        + '<h2 style="color:#d97757;font-family:Georgia,serif;font-size:22px;">' + subj + '</h2>'
        + '<p style="font-size:15px;color:#333;line-height:1.6;">Hi ' + (p.name || 'there') + ',<br><br>You finished <b>#' + p.rank + ' of ' + n + '</b> in your ' + oldLabel + ' League cohort with <b>' + p.weekXp + ' XP</b> last week.</p>'
        + (p.result === 'promoted'
            ? '<p style="font-size:15px;color:#10b981;line-height:1.6;"><b>You\'re now in ' + newLabel + ' League.</b> Your weekly competition just got tougher (and the rewards bigger).</p>'
            : '<p style="font-size:15px;color:#5b5b5b;line-height:1.6;">You\'ve dropped to <b>' + newLabel + ' League</b>. One good practice week and you\'re back up.</p>')
        + '<p style="text-align:center;margin:24px 0;"><a href="https://edurankai.in/aquintutor/league" style="background:#d97757;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">See your new league →</a></p>'
        + '</div>';
      try {
        // sendExternal RESOLVES with { ok: false, error } when SMTP refuses it — it does not throw.
        // The old code awaited it and treated every attempt as delivered, so a mail server that was
        // down looked exactly like a mail server that worked.
        const res = await send({ from: 'AquinTutor <hr@edurankai.in>', to: p.email, subject: subj, html, text: subj });
        // Confirmed, or not counted. Anything other than an explicit ok is a notice that did not go.
        if (!res || res.ok !== true) { noticesFailed++; note('notice to one learner', new Error((res && res.error) || 'the transport did not confirm the send')); }
        else notices++;
      } catch (e: any) {
        noticesFailed++;
        note('notice to one learner', e);
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // AUTO-APPLY STREAK FREEZES
  //
  // The read is bounded and capped, and a failure here is REPORTED rather than swallowed: the old
  // `catch (_) {}` around this whole block meant a missing streak_freeze_log table and a quiet night
  // produced the same answer, `freezes: 0`.
  // -----------------------------------------------------------------------------------------------
  let atRisk: any[] = [];
  try {
    atRisk = rows(await withDbTimeout(db.execute(sql`
      SELECT u.id, u.email, u.name, x.streak_days, x.streak_freezes
      FROM user_xp x JOIN users u ON x.user_id = u.id
      WHERE u.is_active = true AND x.streak_days >= 2 AND x.streak_freezes > 0
        AND (x.last_active_date IS NULL OR x.last_active_date < CURRENT_DATE - INTERVAL '1 day')
        AND NOT EXISTS (SELECT 1 FROM streak_freeze_log WHERE user_id = u.id AND saved_date = CURRENT_DATE)
      LIMIT ${FREEZE_LIMIT}
    `), 'league-settle.atRisk', STEP_MS));
  } catch (e: any) {
    note('at-risk streaks', e);
    failed++;
  }
  if (atRisk.length >= FREEZE_LIMIT) stoppedShort = true;

  for (const r of atRisk as any[]) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) { stoppedShort = true; break; }
    try {
      // THE LOG ROW IS THE CLAIM, AND RETURNING IS WHAT MAKES IT ONE. ON CONFLICT DO NOTHING with no
      // RETURNING told the old code nothing, so it spent a second freeze on every re-run within the
      // same day — and this route is now deliberately re-runnable.
      const claimed = rows(await withDbTimeout(db.execute(sql`
        INSERT INTO streak_freeze_log (user_id, saved_date, streak_before) VALUES (${r.id}, CURRENT_DATE, ${r.streak_days})
        ON CONFLICT (user_id, saved_date) DO NOTHING
        RETURNING user_id
      `), 'league-settle.freezeClaim', STEP_MS));
      if (!claimed.length) continue;
      // Spend one freeze + bump last_active_date so the streak survives.
      await withDbTimeout(db.execute(sql`
        UPDATE user_xp SET streak_freezes = GREATEST(0, streak_freezes - 1), last_active_date = CURRENT_DATE, updated_at = NOW()
        WHERE user_id = ${r.id}
      `), 'league-settle.freezeSpend', STEP_MS);
      freezes++;
    } catch (e: any) {
      note('freezing one streak', e);
      failed++;
    }
  }

  const report: SettleReport = {
    ok: failed === 0 && noticesFailed === 0 && errors.length === 0,
    leagues: leagues.length, leaguesSettled,
    settled, failed, promoted, demoted,
    notices, noticesFailed, noticesSkipped, freezes,
    stoppedShort, errors,
  };
  return { report, rawError };
}

// TWO ARMS, AND ONLY THE HUMAN ONE MOVED.
//
// The human arm was `user.role !== 'applicant'` behind a variable named `isAdmin` — a name that
// described a population the test did not enforce, since every internal role passed it including
// partner, teacher, technical_moderator and every intern-flagged account. `jobs.run` is granted in
// PERMS_BY_ROLE to exactly those ten non-applicant built-in roles and to applicant not at all, so
// the same accounts pass and fail: this is a rename of the question, not a change to the answer.
//
// THAT POPULATION IS TOO WIDE and is reported rather than silently narrowed here. One call settles
// the whole XP league — promotions, demotions and reward writes across every learner. Removing a
// role from it is a policy decision that is now a one-line grant change instead of an edit here.
//
// The CRON_SECRET arm is untouched: see cronAuthorized() above.
export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  // TELEMETRY STARTS AFTER THE AUTH CHECK, never before it, so an unauthorised probe cannot write an
  // execution row and fabricate a healthy history for a job that never ran. Same shape as
  // src/pages/api/cron/hr-sweep.ts.
  if (!can(user, 'jobs.run') && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    return await withCronRun(CRON_ID, async () => {
      const { report, rawError } = await settleLastWeek();
      // Something did not go right, but nothing counted as a failed unit of work — a run that ended
      // on its own deadline, or one whose notices could not be sent. Without this it would derive to
      // `success`, which is the calm green this pass exists to remove.
      const partial = report.stoppedShort || report.errors.length > 0;
      return {
        outcome: {
          // `partial` is stated rather than derived, because deriveCronStatus() would call a run that
          // settled half the leagues and stopped on its own deadline a success.
          status: partial && report.failed === 0 ? ('partial' as const) : undefined,
          processed: report.settled + report.freezes + report.failed,
          succeeded: report.settled + report.freezes,
          failed: report.failed,
          detail: report.leaguesSettled + '/' + report.leagues + ' leagues, ' + report.promoted + ' promoted, '
            + report.demoted + ' demoted, ' + report.notices + ' notices, ' + report.freezes + ' freezes'
            + (report.noticesFailed ? ', ' + report.noticesFailed + ' notices failed' : '')
            // Those learners ARE settled; only the email is lost, and it will not be retried.
            + (report.noticesSkipped ? ', ' + report.noticesSkipped + ' settled learners were not told' : '')
            + (report.stoppedShort ? '; stopped short on purpose — unsettled leagues resume next run' : ''),
          errorMessage: rawError || undefined,
        },
        // 207 when something did not happen, so a caller that only reads the status code still sees
        // the difference between a clean settle and a partial one.
        value: json(report, report.ok ? 200 : 207),
      };
    });
  } catch (e: any) {
    // The read that decides WHICH leagues to settle is deliberately unguarded above: if it fails we
    // do not know that there was nothing to do. withCronRun has already recorded `failed` with the
    // real reason by the time we get here; the body carries the scrubbed one.
    const raw = e?.cause?.message || e?.message || 'no reason given';
    console.error('[league-settle] the settle could not run —', raw);
    return json({ ok: false, error: 'The weekly league settle could not run: ' + publicErrorSummary(raw) + '. This is a problem on our side; nothing was settled.' }, 500);
  }
};
export const POST = GET;
