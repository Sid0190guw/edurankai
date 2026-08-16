/**
 * scripts/mail-loadtest.ts — queue load test (Patch 8 §9).
 *
 *   npx tsx scripts/mail-loadtest.ts --help
 *
 * Enqueues N synthetic messages into `edu_jobs` and measures how the queue behaves: enqueue
 * throughput, depth, drain rate and the age of the head. §9 asks for 1K / 10K / 100K / 1M.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT WRITES TO A DATABASE. RUN IT YOURSELF, AND NEVER AGAINST PRODUCTION.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It is deliberately unpleasant to point at the wrong place. Three independent guards, all of which
 * must pass, and none of which have a default that lets you through:
 *
 *   1. LOADTEST_DATABASE_URL must be set. It does NOT read DATABASE_URL, so a shell that happens to
 *      have production credentials loaded — which is the normal state of a developer's terminal on
 *      this project — cannot be used by accident. This is the guard that matters most.
 *   2. --i-know-this-is-not-production must be passed explicitly.
 *   3. The URL is checked against a host deny-list (supabase.co, neon.tech, and anything containing
 *      "prod"). A match aborts even with the flag.
 *
 * Every row it writes is tagged with the loadgen marker, and `--cleanup` removes exactly those rows
 * by tag rather than by a time window — a time window deletes whatever else happened to be running.
 *
 * WHAT IT DOES NOT MEASURE. It does not drain the queue itself. Drain is the WORKER's job and the
 * worker is a deployed route (/api/jobs/run) or a cron; a script that both fills and empties the
 * queue in one process measures that process, not the system. Fill with this, watch the drain on
 * /admin/mail/performance, and read the rates there.
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';

import { generateContacts, generateMessages, summarizeCorpus, SYNTHETIC_TAG, SYNTHETIC_DOMAIN, assertSafeRecipients } from '../src/lib/mailplatform/loadgen';
import { summarize } from '../src/lib/mailplatform/metrics';
import { formatAge } from '../src/lib/mailplatform/queue-observability';

const HELP = `
mail-loadtest — fill the queue with synthetic work and watch it drain.

  LOADTEST_DATABASE_URL=postgres://… npx tsx scripts/mail-loadtest.ts \\
      --messages 10000 --i-know-this-is-not-production

  --messages N       messages to enqueue (§9 asks for 1000 / 10000 / 100000 / 1000000)
  --contacts N       distinct recipients (default = messages/10, min 10)
  --batch N          rows per INSERT (default 500)
  --seed N           corpus seed (default 1)
  --status           print queue depth/age and exit; enqueues nothing
  --cleanup          delete every row this tool created, matched by tag
  --i-know-this-is-not-production   required for anything that writes

Reads LOADTEST_DATABASE_URL only — never DATABASE_URL. That is on purpose: your shell probably
has production credentials in it right now.
`;

const DENY = [/supabase\.co/i, /neon\.tech/i, /prod/i, /production/i];

function guard(args: { confirm: boolean; write: boolean }): string {
  const url = String(process.env.LOADTEST_DATABASE_URL || '').trim();
  if (!url) {
    console.error('REFUSING: LOADTEST_DATABASE_URL is not set.');
    console.error('This script does NOT fall back to DATABASE_URL — a shell with production credentials');
    console.error('loaded must not be able to run a load test by accident. Point it at a throwaway database.');
    process.exit(2);
  }
  if (args.write && !args.confirm) {
    console.error('REFUSING: pass --i-know-this-is-not-production to write to ' + url.replace(/:[^:@]*@/, ':***@'));
    process.exit(2);
  }
  const hit = DENY.find((re) => re.test(url));
  if (hit) {
    console.error('REFUSING: LOADTEST_DATABASE_URL matches ' + hit + ', which looks like a managed or production host.');
    console.error('Load tests belong on a throwaway database. If this really is disposable, rename the host or use a local Postgres.');
    process.exit(2);
  }
  return url;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const num = (n: string, d: number) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
  const has = (n: string) => argv.includes('--' + n);

  const statusOnly = has('status');
  const cleanup = has('cleanup');
  const messages = num('messages', 1000);
  const contactCount = num('contacts', Math.max(10, Math.floor(messages / 10)));
  const batch = Math.max(1, num('batch', 500));
  const seed = num('seed', 1);

  const url = guard({ confirm: has('i-know-this-is-not-production'), write: !statusOnly });
  const sql = postgres(url, { max: 4, prepare: false });

  try {
    if (statusOnly) {
      const [d] = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'done')::int AS done,
          EXTRACT(EPOCH FROM (now() - MIN(run_after) FILTER (WHERE status = 'pending'))) AS oldest_s
        FROM edu_jobs`;
      console.log('queue: pending=' + d.pending + ' processing=' + d.processing + ' failed=' + d.failed + ' done=' + d.done);
      console.log('oldest pending: ' + (d.oldest_s === null ? 'empty' : formatAge(Number(d.oldest_s) * 1000)));
      return;
    }

    if (cleanup) {
      const jobs = await sql`DELETE FROM edu_jobs WHERE dedup_key LIKE ${SYNTHETIC_TAG + '%'} RETURNING id`;
      const logs = await sql`DELETE FROM edu_job_log WHERE detail LIKE ${'%' + SYNTHETIC_TAG + '%'} RETURNING id`;
      const mail = await sql`DELETE FROM email_logs WHERE to_email LIKE ${'%@' + SYNTHETIC_DOMAIN} RETURNING id`.catch(() => []);
      console.log('cleaned up: ' + jobs.length + ' jobs, ' + logs.length + ' job-log rows, ' + mail.length + ' email_logs rows (matched by tag, not by time window)');
      return;
    }

    console.log('generating ' + messages.toLocaleString() + ' messages for ' + contactCount.toLocaleString() + ' recipients (seed ' + seed + ')…');
    const contacts = generateContacts(contactCount, { seed });
    const corpus = generateMessages(messages, contacts, { seed });
    assertSafeRecipients(corpus.map((m) => m.to));
    const summary = summarizeCorpus({ contacts, messages: corpus, seed });
    console.log('  mean ' + summary.meanBytes.toLocaleString() + ' bytes/message, total ' + (summary.totalBytes / 1024 / 1024).toFixed(1) + ' MiB');

    // The queue table is created lazily by src/lib/job-queue.ts. Creating it here keeps the load test
    // runnable against an empty throwaway database without booting the whole application.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS edu_jobs (
      id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', dedup_key text UNIQUE,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
      run_after timestamptz NOT NULL DEFAULT now(), last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS edu_jobs_claim_idx ON edu_jobs (status, run_after)`);

    console.log('enqueueing in batches of ' + batch + '…');
    const batchLatencies: number[] = [];
    const started = performance.now();
    let inserted = 0;

    for (let i = 0; i < corpus.length; i += batch) {
      const slice = corpus.slice(i, i + batch);
      // The PAYLOAD IS A REFERENCE, NOT THE BODY. Putting a 600KB body in a jsonb column would make
      // this a test of Postgres TOAST compression rather than of the queue, and it would leave the
      // table enormous after a 1M-message run.
      const rows = slice.map((m) => ({
        kind: 'mail.send',
        payload: JSON.stringify({ to: m.to, from: m.from, subject: m.subject, sizeBytes: m.sizeBytes, externalId: m.externalId, synthetic: true }),
        dedup_key: m.externalId,
      }));
      const t0 = performance.now();
      await sql`INSERT INTO edu_jobs ${sql(rows, 'kind', 'payload', 'dedup_key')} ON CONFLICT (dedup_key) DO NOTHING`;
      batchLatencies.push(performance.now() - t0);
      inserted += slice.length;
      if (inserted % (batch * 20) === 0) process.stdout.write('  ' + inserted.toLocaleString() + '/' + corpus.length.toLocaleString() + '\r');
    }

    const elapsedSec = (performance.now() - started) / 1000;
    const s = summarize(batchLatencies);
    console.log('\n');
    console.log('enqueued ' + inserted.toLocaleString() + ' in ' + elapsedSec.toFixed(1) + 's = ' + (inserted / elapsedSec).toFixed(0) + ' rows/s');
    console.log('batch INSERT latency (' + batch + ' rows): p50 ' + Math.round(s.p50 ?? 0) + 'ms · p95 ' + Math.round(s.p95 ?? 0) + 'ms · p99 ' + Math.round(s.p99 ?? 0) + 'ms');

    const [d] = await sql`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM edu_jobs`;
    console.log('queue depth now: ' + Number(d.pending).toLocaleString() + ' pending');
    console.log('');
    console.log('ENQUEUE RATE IS NOT THROUGHPUT. This measured how fast rows go IN. Drain is the worker\'s');
    console.log('job — trigger /api/jobs/run (or wait for the cron) and read the drain rate on');
    console.log('/admin/mail/performance. A script that fills and empties in one process measures the');
    console.log('script, not the system.');
    console.log('Re-run with --status to watch depth, or --cleanup to remove every row this created.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e?.cause?.message || e?.message || e); process.exit(1); });
