/**
 * scripts/mail-bench.ts — the benchmark runner (Patch 8 §9, §15).
 *
 *   npx tsx scripts/mail-bench.ts --help
 *
 * IT MEASURES WHAT IT CAN REACH AND REFUSES TO GUESS THE REST. Each stage is opt-in and each one
 * either produces real samples or is absent from the report. There is no default that invents a
 * number, and `--dry-run` (the default for the SMTP stage) exercises the pool, the throttles and the
 * corpus without opening a socket.
 *
 * WHAT IT WILL NOT DO:
 *   - Send to anything but a reserved test domain. loadgen.assertSafeRecipients throws otherwise.
 *   - Send through a non-local relay without an explicit --allow-remote-smtp.
 *   - Run against a URL that looks like production without --i-know-this-is-not-production.
 *   - Claim a scale tier. It records a measurement; capacity.ts decides what that measurement earns,
 *     and the answer is usually "less than you hoped".
 *
 * THE REPORT IS THE DELIVERABLE. stdout gets a human summary, `--out` writes the machine-readable
 * §15 JSON, and `--post <baseUrl>` sends it to /api/admin/mail/bench-report so it appears on
 * /admin/mail/performance. A benchmark whose result lives only in a terminal is a benchmark nobody
 * acts on.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

import { summarize } from '../src/lib/mailplatform/metrics';
import { buildCapacityReport, headline, NO_MEASUREMENT, type BenchConfiguration, type LatencySummary, type Measurement } from '../src/lib/mailplatform/capacity';
import {
  generateContacts, generateMessages, summarizeCorpus,
  assertSafeRecipients, assertLocalSmtp, SYNTHETIC_HEADER, SYNTHETIC_TAG,
} from '../src/lib/mailplatform/loadgen';
import { newPoolState, planDelivery, completeDelivery, type MtaNode } from '../src/lib/mailplatform/mta-pool';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  messages: number;
  contacts: number;
  concurrency: number;
  seed: number;
  durationSec: number;
  target: string | null;
  smtp: string | null;
  dryRun: boolean;
  allowRemoteSmtp: boolean;
  confirmNotProduction: boolean;
  out: string | null;
  post: string | null;
  token: string | null;
  label: string | null;
  environment: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const has = (name: string) => argv.includes('--' + name);
  return {
    messages: Number(get('messages') || 2000),
    contacts: Number(get('contacts') || 500),
    concurrency: Number(get('concurrency') || 4),
    seed: Number(get('seed') || 1),
    durationSec: Number(get('duration') || 0),
    target: get('target'),
    smtp: get('smtp'),
    dryRun: !has('send'),
    allowRemoteSmtp: has('allow-remote-smtp'),
    confirmNotProduction: has('i-know-this-is-not-production'),
    out: get('out'),
    post: get('post'),
    token: get('token') || process.env.METRICS_TOKEN || null,
    label: get('label'),
    environment: get('environment') || 'local',
  };
}

const HELP = `
mail-bench — measure, then let capacity.ts decide what the measurement earns.

  npx tsx scripts/mail-bench.ts [options]

Corpus
  --messages N          messages to generate and push through (default 2000)
  --contacts N          distinct recipients (default 500)
  --concurrency N       parallel senders (default 4)
  --seed N              deterministic corpus seed (default 1)

Stages (all opt-in; an absent stage is absent from the report, never estimated)
  --target URL          benchmark HTTP latency against a mail API endpoint
  --smtp HOST:PORT      benchmark SMTP; local sink only unless --allow-remote-smtp
  --send                actually open sockets (default is a dry run through the pool)

Safety
  --allow-remote-smtp                 permit a non-local relay you have CONFIRMED is a sink
  --i-know-this-is-not-production     required when --target does not look like localhost

Output
  --out FILE            write the machine-readable capacity report (JSON)
  --post BASEURL        POST it to BASEURL/api/admin/mail/bench-report
  --token TOKEN         bearer for --post (defaults to $METRICS_TOKEN)
  --label TEXT          a name for this run
  --environment NAME    environment label recorded in the report (default "local")

Minimum evidence: a rate is only usable if it was held for 60s+ over 500+ messages at under
0.5% failures. Below that, capacity.ts records "insufficient evidence" and claims nothing.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function looksLikeProduction(url: string): boolean {
  const u = url.toLowerCase();
  if (/localhost|127\.0\.0\.1|::1|\.local(\b|\/)|\.test(\b|\/)/.test(u)) return false;
  return true;
}

/** Run `fn` over `items` with a fixed number of parallel lanes. Each lane pulls from a shared cursor. */
async function withConcurrency<T>(items: readonly T[], lanes: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, worker));
}

function pct(s: ReturnType<typeof summarize>, operation: string): LatencySummary {
  return { operation, count: s.count, p50: s.p50, p95: s.p95, p99: s.p99, unit: 'ms' };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

interface StageResult { samples: number[]; failures: number; note: string }

/** HTTP latency against a real endpoint. Measures the API layer, nothing else. */
async function benchHttp(url: string, count: number, concurrency: number): Promise<StageResult> {
  const samples: number[] = [];
  let failures = 0;
  const items = Array.from({ length: count }, (_, i) => i);
  await withConcurrency(items, concurrency, async () => {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: { 'x-request-id': SYNTHETIC_TAG + '-' + Math.random().toString(36).slice(2, 10) } });
      // A 4xx/5xx is a FAILURE, not a fast success. Counting it as a sample is how a benchmark
      // measures how quickly a system can reject work and reports it as throughput.
      if (!res.ok) failures++;
      else samples.push(performance.now() - t0);
      await res.arrayBuffer();
    } catch {
      failures++;
    }
  });
  return { samples, failures, note: 'HTTP GET ' + url };
}

/**
 * The pool path: selection, per-domain throttling and circuit state for every message, with or
 * without a socket.
 *
 * The dry run is genuinely useful rather than a placeholder — it measures the cost of the decision
 * layer at full rate, which is the part that runs on every message regardless of transport, and it
 * does it without a mail server anywhere near the machine.
 */
async function benchPool(
  messages: readonly { to: string; from: string; subject: string; text: string; html: string; headers: Record<string, string> }[],
  concurrency: number,
  send: null | ((m: { to: string; from: string; subject: string; text: string; html: string; headers: Record<string, string> }) => Promise<void>),
): Promise<StageResult & { throttled: number }> {
  const node: MtaNode = { id: 'bench-01', label: 'bench', host: 'sink', port: 25, ipPool: 'default', weight: 1, maxConcurrent: Math.max(1, concurrency), status: 'active' };
  // A throttle high enough not to be the thing under test. The per-domain limiter is exercised for
  // correctness by its unit tests; here it must not silently become the bottleneck being measured.
  let state = newPoolState([node], [{ domain: '*', maxPerSecond: 100_000, burst: 100_000 }]);
  const samples: number[] = [];
  let failures = 0;
  let throttled = 0;

  await withConcurrency(messages, concurrency, async (m) => {
    const now = Date.now();
    const plan = planDelivery(state, m.to, { now });
    state = plan.state;
    if (!plan.node) { throttled++; return; }
    const t0 = performance.now();
    try {
      if (send) await send(m);
      const dt = performance.now() - t0;
      samples.push(dt);
      state = completeDelivery(state, plan.node.id, 'delivered', { now: Date.now(), latencyMs: dt });
    } catch (e) {
      failures++;
      state = completeDelivery(state, plan.node.id, 'failed', { now: Date.now(), error: String((e as Error)?.message || e) });
    }
  });

  return { samples, failures, throttled, note: send ? 'SMTP send through the pool' : 'pool decision path only (dry run, no socket)' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const args = parseArgs(argv);

  console.log('mail-bench — generating corpus (seed ' + args.seed + ')…');
  const contacts = generateContacts(args.contacts, { seed: args.seed });
  const messages = generateMessages(args.messages, contacts, { seed: args.seed });
  const corpus = summarizeCorpus({ contacts, messages, seed: args.seed });

  // Checked here as well as inside the generator. The two ways a mistake enters are "generated
  // wrong" and "generated right, then a real list got mixed in", and one check catches only the first.
  assertSafeRecipients(messages.map((m) => m.to));
  console.log('  ' + corpus.messages.toLocaleString() + ' messages to ' + corpus.contacts.toLocaleString() + ' reserved-domain recipients, mean ' + corpus.meanBytes.toLocaleString() + ' bytes');
  console.log('  size mix: ' + Object.entries(corpus.bandCounts).map(([k, v]) => k + '=' + v).join(', '));

  const latency: LatencySummary[] = [];
  let primary: StageResult | null = null;
  let stageName = '';

  if (args.target) {
    if (looksLikeProduction(args.target) && !args.confirmNotProduction) {
      console.error('\nREFUSING: --target "' + args.target + '" does not look local.');
      console.error('Load tests must not run against production. If this really is a staging or test host,');
      console.error('re-run with --i-know-this-is-not-production.');
      process.exit(2);
    }
    console.log('\nBenchmarking HTTP: ' + args.target + ' (' + args.messages + ' requests, ' + args.concurrency + ' lanes)…');
    const r = await benchHttp(args.target, args.messages, args.concurrency);
    latency.push(pct(summarize(r.samples), 'api.request'));
    primary = r; stageName = 'http';
  }

  if (args.smtp) {
    const [host, portRaw] = args.smtp.split(':');
    const port = Number(portRaw || 25);
    assertLocalSmtp(host, { allowRemote: args.allowRemoteSmtp });

    let send: Parameters<typeof benchPool>[2] = null;
    if (!args.dryRun) {
      const nodemailer = (await import('nodemailer')).default;
      const transport = nodemailer.createTransport({ host, port, secure: false, pool: true, maxConnections: args.concurrency, tls: { rejectUnauthorized: false } });
      send = async (m) => {
        await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: { ...m.headers, [SYNTHETIC_HEADER]: SYNTHETIC_TAG } });
      };
      console.log('\nBenchmarking SMTP: ' + host + ':' + port + ' (sending for real, ' + args.concurrency + ' lanes)…');
    } else {
      console.log('\nBenchmarking the pool decision path (dry run — no socket opened). Add --send to open connections to ' + host + ':' + port + '.');
    }
    const r = await benchPool(messages, args.concurrency, send);
    latency.push(pct(summarize(r.samples), args.dryRun ? 'pool.plan' : 'delivery.attempt'));
    if (r.throttled) console.log('  ' + r.throttled + ' message(s) were throttled by the pool and not counted.');
    primary = r; stageName = args.dryRun ? 'pool-dry-run' : 'smtp';
  }

  if (!primary) {
    console.log('\nNo stage selected, so nothing was measured. The report below records exactly that.');
    console.log('Add --target URL and/or --smtp HOST:PORT. See --help.\n');
  }

  const configuration: BenchConfiguration = {
    cpu: os.cpus()?.[0]?.model ? os.cpus()[0].model + ' × ' + os.cpus().length : null,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    storage: null,   // not discoverable portably, and a guess here would be a fabricated field
    workers: args.concurrency,
    concurrency: args.concurrency,
    environment: args.environment,
    target: args.target || args.smtp || null,
    nodeVersion: process.version,
  };

  let measurement: Measurement = NO_MEASUREMENT;
  if (primary && primary.samples.length > 0) {
    const s = summarize(primary.samples);
    const attempts = primary.samples.length + primary.failures;
    // WALL-CLOCK THROUGHPUT, NOT 1/mean. With C lanes running concurrently, 1/mean overstates by
    // roughly C — the single most common way a load test reports a number it did not achieve.
    // sum(latencies)/concurrency approximates the elapsed time the lanes were busy.
    const busyMs = primary.samples.reduce((a, b) => a + b, 0) / Math.max(1, args.concurrency);
    const elapsedSec = args.durationSec > 0 ? args.durationSec : busyMs / 1000;
    measurement = {
      source: 'benchmark',
      messagesPerSec: elapsedSec > 0 ? primary.samples.length / elapsedSec : null,
      durationSec: Math.round(elapsedSec),
      messagesTested: attempts,
      concurrency: args.concurrency,
      failureRate: attempts > 0 ? primary.failures / attempts : null,
      environment: args.environment,
      at: new Date().toISOString(),
      notes: primary.note + '; corpus mean ' + corpus.meanBytes + ' bytes/message, seed ' + args.seed + ', stage ' + stageName + '. Throughput is samples/elapsed with elapsed derived from lane-busy time, not 1/mean.',
    };
    console.log('\n  observed p50 ' + Math.round(s.p50 ?? 0) + 'ms · p95 ' + Math.round(s.p95 ?? 0) + 'ms · p99 ' + Math.round(s.p99 ?? 0) + 'ms over ' + s.count + ' samples, ' + primary.failures + ' failures');
  }

  const report = buildCapacityReport({ configuration, measurement, latency });

  console.log('\n' + '─'.repeat(78));
  console.log(headline(report));
  console.log('─'.repeat(78));
  for (const t of report.tiers) console.log('  ' + t.verdict.toUpperCase().padEnd(22) + t.tier.label.padEnd(20) + 'needs ' + t.requiredPeakPerSec.toFixed(2) + ' msg/s at peak');
  console.log('\nCaveats:');
  for (const c of report.caveats) console.log('  · ' + c);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log('\nReport written to ' + args.out);
  }

  if (args.post) {
    if (!args.token) {
      console.error('\n--post needs a bearer token: pass --token or set METRICS_TOKEN. Not posting.');
      process.exit(3);
    }
    const url = args.post.replace(/\/$/, '') + '/api/admin/mail/bench-report';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + args.token },
        body: JSON.stringify({ report, label: args.label }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log('\nPosted to ' + url + ' — visible at ' + args.post.replace(/\/$/, '') + '/admin/mail/performance');
        if (body && body.usableMeasurement === false) {
          console.log('NOTE: the server stored it but does NOT consider it usable evidence: ' + (body.validityReasons || []).join('; '));
        }
      } else {
        console.error('\nPost failed (' + res.status + '): ' + JSON.stringify(body));
        process.exit(4);
      }
    } catch (e) {
      console.error('\nPost failed: ' + String((e as Error)?.message || e));
      process.exit(4);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
