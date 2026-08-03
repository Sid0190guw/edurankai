// src/lib/observability-health.test.ts — run: npx tsx src/lib/observability-health.test.ts
// Pure half of the health/ops module: error GROUPING (the same fault 400 times must collapse to one
// key), status roll-up and its HTTP code, cron expectations, the deploy marker, and the assertion
// that CONFIGURED_CRONS has not drifted from the deployment config. No database is touched.
import { readFileSync } from 'node:fs';
import {
  errorFingerprint, overallStatus, statusHttpCode, cronIntervalHours, cronRunState,
  relativeAge, deployMarker, releaseTag, CONFIGURED_CRONS, BOOTSTRAP_MODULES,
} from './observability-health';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: any) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c || extra === undefined ? '' : '  <- ' + JSON.stringify(extra))); c ? pass++ : fail++; };

// ---- fingerprint: the 400-into-1 requirement ----
const dupA = 'duplicate key value violates unique constraint "users_email_key" (id)=(41f3a8c2-1c4d-4f6a-9b2e-77c0d9e1a5b3)';
const dupB = 'duplicate key value violates unique constraint "users_email_key" (id)=(9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d)';
ok('same fault with a different id collapses to one key', errorFingerprint('hire.create', dupA) === errorFingerprint('hire.create', dupB));
ok('two genuinely different faults under one event stay apart', errorFingerprint('hire.create', dupA) !== errorFingerprint('hire.create', 'connection terminated unexpectedly'));
ok('the same message under different events stays apart', errorFingerprint('hire.create', dupA) !== errorFingerprint('offer.sign', dupA));
ok('emails are normalised out', errorFingerprint('mail.send', 'no mailbox for a.person@example.com') === errorFingerprint('mail.send', 'no mailbox for other@elsewhere.org'));
ok('timestamps are normalised out', errorFingerprint('cron.run', 'stalled since 2026-08-01T04:15:00Z') === errorFingerprint('cron.run', 'stalled since 2026-07-11T22:01:03Z'));
ok('bare numbers are normalised out', errorFingerprint('pool.exhausted', 'only 3 of 60 connections free') === errorFingerprint('pool.exhausted', 'only 7 of 60 connections free'));
ok('an empty message still produces a stable key', errorFingerprint('gate.refused', '') === errorFingerprint('gate.refused', ''));
ok('a missing event does not throw and is labelled', errorFingerprint('', 'boom').startsWith('unknown |'));
ok('null message is tolerated', errorFingerprint('x', null as any).length > 0);
ok('the key is bounded in length', errorFingerprint('e', 'x'.repeat(4000)).length <= 200);
{
  // The actual grouping property, exercised the way the SQL will: 400 rows, one key.
  const keys = new Set<string>();
  for (let i = 0; i < 400; i++) keys.add(errorFingerprint('hire.create', 'insert failed for employee ' + i + ' at 2026-08-0' + (i % 9 + 1)));
  ok('400 occurrences of one fault produce exactly 1 group', keys.size === 1, [...keys]);
}

// ---- status roll-up ----
ok('all-ok is ok', overallStatus([{ name: 'db', ok: true, critical: true }]) === 'ok');
ok('a failed non-critical check is degraded', overallStatus([{ name: 'db', ok: true, critical: true }, { name: 'mail', ok: false }]) === 'degraded');
ok('a failed critical check is down', overallStatus([{ name: 'db', ok: false, critical: true }, { name: 'mail', ok: true }]) === 'down');
ok('down beats degraded', overallStatus([{ name: 'db', ok: false, critical: true }, { name: 'mail', ok: false }]) === 'down');
ok('no checks is ok', overallStatus([]) === 'ok');
ok('down is 503 so a monitor can see the outage', statusHttpCode('down') === 503);
ok('degraded is 200 (information, not a page-somebody event)', statusHttpCode('degraded') === 200);
ok('ok is 200', statusHttpCode('ok') === 200);

// ---- cron expectations ----
ok('a daily schedule is 24h', cronIntervalHours('0 3 * * *') === 24);
ok('a weekly schedule is 168h', cronIntervalHours('0 1 * * 1') === 168);
ok('an hourly schedule is 1h', cronIntervalHours('0 * * * *') === 1);
ok('a garbage schedule falls back to daily rather than throwing', cronIntervalHours('nonsense') === 24);
ok('an empty schedule falls back to daily', cronIntervalHours('') === 24);
{
  const now = Date.parse('2026-08-03T12:00:00Z');
  ok('a daily cron run 2h ago is ok', cronRunState('0 3 * * *', '2026-08-03T10:00:00Z', now) === 'ok');
  ok('a daily cron run 3 days ago is overdue', cronRunState('0 3 * * *', '2026-07-31T12:00:00Z', now) === 'overdue');
  ok('a daily cron run 30h ago is still inside the 1.5x grace', cronRunState('0 3 * * *', '2026-08-02T06:00:00Z', now) === 'ok');
  ok('a weekly cron run 3 days ago is ok', cronRunState('0 1 * * 1', '2026-07-31T12:00:00Z', now) === 'ok');
  ok('never-run is its own state, not overdue', cronRunState('0 3 * * *', null, now) === 'never');
  ok('an unparseable timestamp reads as never, never as ok', cronRunState('0 3 * * *', 'not-a-date', now) === 'never');
}

// ---- relative age ----
{
  const now = Date.parse('2026-08-03T12:00:00Z');
  ok('seconds', relativeAge('2026-08-03T11:59:30Z', now) === '30s ago');
  ok('minutes', relativeAge('2026-08-03T11:30:00Z', now) === '30m ago');
  ok('hours', relativeAge('2026-08-03T06:00:00Z', now) === '6h ago');
  ok('days', relativeAge('2026-07-30T12:00:00Z', now) === '4d ago');
  ok('null is "never", not "0s ago"', relativeAge(null, now) === 'never');
}

// ---- deploy marker (read from the platform's own variables, never invented) ----
{
  const m = deployMarker({ VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_ENV: 'production', VERCEL_REGION: 'bom1' });
  ok('commit is read from the platform variable', m.commit === 'abcdef1234567890');
  ok('short commit is 7 chars', m.shortCommit === 'abcdef1');
  ok('known is true when a commit is present', m.known === true);
  ok('release tag combines environment and commit', releaseTag({ VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890', VERCEL_ENV: 'production' }) === 'production:abcdef1');
  const empty = deployMarker({});
  ok('no platform variables reports known:false rather than guessing', empty.known === false && empty.commit === null);
  ok('release tag is null when the commit is unknown', releaseTag({}) === null);
  ok('whitespace-only values count as absent', deployMarker({ VERCEL_GIT_COMMIT_SHA: '   ' }).known === false);
  ok('a long commit message is truncated', (deployMarker({ VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5', VERCEL_GIT_COMMIT_MESSAGE: 'm'.repeat(500) }).message || '').length <= 140);
}

// ---- the schedules in this module must not drift from the deployment config ----
{
  let configured: { path: string; schedule: string }[] = [];
  try { configured = (JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).crons || []) as any[]; } catch { configured = []; }
  const norm = (a: { path: string; schedule: string }[]) => a.map((c) => c.path + ' @ ' + c.schedule).sort().join('\n');
  ok('vercel.json declares at least one cron (the file was found and parsed)', configured.length > 0, configured.length);
  ok('CONFIGURED_CRONS matches the deployed schedule list exactly', norm(configured) === norm(CONFIGURED_CRONS), { deployed: norm(configured), module: norm(CONFIGURED_CRONS) });
}

// ---- module catalogue sanity ----
ok('every bootstrap module names a distinct table', new Set(BOOTSTRAP_MODULES.map((m) => m.table)).size === BOOTSTRAP_MODULES.length);
ok('the error log itself is monitored', BOOTSTRAP_MODULES.some((m) => m.table === 'edu_error_log'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
