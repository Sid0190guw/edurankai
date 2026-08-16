#!/usr/bin/env node
// tests/load/loadtest.mjs — the local load-test framework.
//
//   node tests/load/loadtest.mjs --messages 1000
//   node tests/load/loadtest.mjs --messages 100000 --concurrency 32 --target sink
//   node tests/load/loadtest.mjs --messages 10000 --target queue
//
// IT CANNOT SEND MAIL TO THE INTERNET, AND THAT IS ENFORCED, NOT DOCUMENTED.
//
// The brief says not to send test spam to the public internet. A comment saying so is worth
// nothing at 1am, so the guard is structural: `--target` accepts `sink` and `queue` only, the sink
// has no delivery path in its process at all, and the resolver below refuses any host that is not
// loopback or a compose service name. Pointing this at a real MTA requires editing this file, which
// is a decision somebody has to make on purpose.
//
// WHAT IT MEASURES, and what those numbers are worth:
//   throughput, p50/p95/p99 latency, error rate, and the process's own CPU and RSS.
// A number produced here describes THIS LAPTOP running THIS STACK with the sink absorbing
// delivery. It is a floor for the application layer, not a delivery-rate claim — real delivery is
// governed by remote receivers, reputation and per-destination concurrency, none of which are
// present in this measurement. docs/mail/SCALING.md says the same thing at more length, and says
// which numbers in it are measured and which are estimates.
import net from 'node:net';
import os from 'node:os';
import { config } from '../helpers/config.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const TOTAL = Number(opt('messages', 1000));
const CONCURRENCY = Number(opt('concurrency', 16));
const TARGET = opt('target', 'sink');
const REPORT_EVERY = Number(opt('report-every', 1000));

if (!['sink', 'queue'].includes(TARGET)) {
  console.error(`--target must be 'sink' or 'queue'. Refusing '${TARGET}'.`);
  console.error('This tool does not point at a real MTA. See the header of tests/load/loadtest.mjs.');
  process.exit(2);
}

// THE SAFETY GATE. Loopback and compose service names only.
const SAFE_HOSTS = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1|smtp-sink|mail-parser|app|mta)$/;
function assertSafeHost(host, what) {
  if (!SAFE_HOSTS.test(host)) {
    console.error(`Refusing to load-test ${what} at "${host}".`);
    console.error('Only loopback and compose service names are permitted. A load test aimed at a real');
    console.error('mail server is how a sending IP gets blacklisted, and it is never an accident worth');
    console.error('making easy. Edit tests/load/loadtest.mjs if you genuinely mean it.');
    process.exit(2);
  }
}

// --- statistics -------------------------------------------------------------------------------------
// Full retention of latencies rather than a running average: p99 is the number that matters for a
// queue, and you cannot recover a percentile from a mean. At 100k samples this is ~800KB, which is
// cheaper than being wrong about the tail.
const latencies = [];
let sent = 0;
let failed = 0;
const errors = new Map();

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function recordError(message) {
  const key = String(message).slice(0, 120);
  errors.set(key, (errors.get(key) || 0) + 1);
  failed++;
}

// --- one SMTP delivery, connection reused across messages ------------------------------------------
// A new TCP connection per message would measure connection setup, not throughput, and would exhaust
// ephemeral ports somewhere around the 28,000th message on Windows — which looks exactly like the
// system under test falling over.
class Sender {
  constructor(id, host, port) {
    this.id = id;
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = '';
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setEncoding('utf8');
      this.socket.setTimeout(30_000);
      this.socket.on('data', (c) => { this.buffer += c; });
      this.socket.once('error', reject);
      this.socket.once('timeout', () => reject(new Error('socket timeout')));
      this.socket.once('connect', resolve);
    });
    await this.read();           // 220 greeting
    await this.cmd(`EHLO loadtest-${this.id}.invalid`);
  }

  read() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const check = () => {
        const lines = this.buffer.split('\r\n').filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && /^\d{3} /.test(last)) {
          const code = Number(last.slice(0, 3));
          const text = lines.join(' | ');
          this.buffer = '';
          return resolve({ code, text });
        }
        if (Date.now() > deadline) return reject(new Error('SMTP read timeout'));
        setImmediate(check);
      };
      check();
    });
  }

  async cmd(line) {
    this.socket.write(line + '\r\n');
    return this.read();
  }

  async sendOne(n) {
    const t0 = performance.now();
    const r1 = await this.cmd(`MAIL FROM:<load-${this.id}@example.invalid>`);
    if (r1.code !== 250) throw new Error(`MAIL FROM: ${r1.text}`);
    const r2 = await this.cmd(`RCPT TO:<load-${n}@example.invalid>`);
    if (r2.code !== 250) throw new Error(`RCPT TO: ${r2.text}`);
    const r3 = await this.cmd('DATA');
    if (r3.code !== 354) throw new Error(`DATA: ${r3.text}`);
    const body =
      `From: load-${this.id}@example.invalid\r\n` +
      `To: load-${n}@example.invalid\r\n` +
      `Subject: load test message ${n}\r\n` +
      `Message-ID: <load-${n}-${Date.now()}@loadtest.invalid>\r\n` +
      `Date: ${new Date().toUTCString()}\r\n\r\n` +
      `Message ${n} of ${TOTAL}. Body padded to a realistic size.\r\n` +
      'x'.repeat(1800);
    this.socket.write(body + '\r\n.\r\n');
    const r4 = await this.read();
    if (r4.code !== 250) throw new Error(`end of DATA: ${r4.text}`);
    latencies.push(performance.now() - t0);
    sent++;
  }

  close() { try { this.socket?.destroy(); } catch { /* already gone */ } }
}

// --- the run ------------------------------------------------------------------------------------------
async function runSmtp() {
  const host = config.sink.smtpHost;
  const port = config.sink.smtpPort;
  assertSafeHost(host, 'the SMTP sink');

  console.log(`\nLoad test: ${TOTAL} messages, concurrency ${CONCURRENCY}, target ${host}:${port} (sink — delivers nothing)\n`);

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let next = 0;

  const workers = Array.from({ length: CONCURRENCY }, async (_, i) => {
    const sender = new Sender(i, host, port);
    try {
      await sender.connect();
    } catch (e) {
      recordError(`connect: ${e.message}`);
      return;
    }
    while (true) {
      const n = next++;
      if (n >= TOTAL) break;
      try {
        await sender.sendOne(n);
      } catch (e) {
        recordError(e.message);
        // Reconnect once: a broken pipe mid-run should not silently retire a worker and halve the
        // measured concurrency, which would look like the server slowing down.
        sender.close();
        try { await sender.connect(); } catch { break; }
      }
      if (sent % REPORT_EVERY === 0 && sent > 0) {
        const elapsed = (performance.now() - t0) / 1000;
        process.stdout.write(`  ${sent}/${TOTAL}  ${(sent / elapsed).toFixed(0)} msg/s  rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB\n`);
      }
    }
    sender.close();
  });

  await Promise.all(workers);
  return { elapsedMs: performance.now() - t0, cpu: process.cpuUsage(cpu0) };
}

async function runQueue() {
  // Queue mode measures enqueue throughput through the app's own API rather than SMTP. It needs the
  // app and a secret; without them it says so rather than reporting a zero.
  const url = new URL(config.baseUrl);
  assertSafeHost(url.hostname, 'the app');
  if (!config.secrets.cron) {
    console.error('queue mode needs CRON_SECRET exported in this shell.');
    process.exit(2);
  }
  console.log(`\nQueue drain test against ${config.baseUrl}, ${TOTAL} drain calls, concurrency ${CONCURRENCY}\n`);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next++ < TOTAL) {
      const s = performance.now();
      try {
        const res = await fetch(`${config.baseUrl}/api/jobs/run?key=${encodeURIComponent(config.secrets.cron)}&limit=25`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json().catch(() => ({}));
        latencies.push(performance.now() - s);
        sent++;
      } catch (e) {
        recordError(e.message);
      }
    }
  });
  await Promise.all(workers);
  return { elapsedMs: performance.now() - t0, cpu: process.cpuUsage(cpu0) };
}

const { elapsedMs, cpu } = TARGET === 'queue' ? await runQueue() : await runSmtp();

// --- report -------------------------------------------------------------------------------------------
const sorted = latencies.slice().sort((a, b) => a - b);
const seconds = elapsedMs / 1000;
const cpuSeconds = (cpu.user + cpu.system) / 1e6;

console.log('\n' + '='.repeat(64));
console.log(`  target            ${TARGET}`);
console.log(`  requested         ${TOTAL}`);
console.log(`  completed         ${sent}`);
console.log(`  failed            ${failed}${failed ? `  (${((failed / TOTAL) * 100).toFixed(2)}%)` : ''}`);
console.log(`  elapsed           ${seconds.toFixed(1)}s`);
console.log(`  throughput        ${(sent / seconds).toFixed(0)} /s`);
console.log('  ' + '-'.repeat(60));
console.log(`  latency p50       ${percentile(sorted, 50).toFixed(1)} ms`);
console.log(`  latency p95       ${percentile(sorted, 95).toFixed(1)} ms`);
console.log(`  latency p99       ${percentile(sorted, 99).toFixed(1)} ms`);
console.log(`  latency max       ${(sorted[sorted.length - 1] || 0).toFixed(1)} ms`);
console.log('  ' + '-'.repeat(60));
console.log(`  generator CPU     ${cpuSeconds.toFixed(1)}s (${((cpuSeconds / seconds) * 100).toFixed(0)}% of one core, ${os.cpus().length} available)`);
console.log(`  generator RSS     ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

if (errors.size) {
  console.log('  ' + '-'.repeat(60));
  console.log('  errors:');
  for (const [msg, count] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${String(count).padStart(6)}  ${msg}`);
}

console.log('='.repeat(64));
console.log(`
  WHAT THIS NUMBER IS. Application-layer throughput on this machine with the sink absorbing
  delivery. The generator and the system under test share one laptop, so the CPU line above is
  competing with the thing it measures — if it approaches 100% of a core, the bottleneck is this
  script and the result is a floor, not a ceiling.

  WHAT IT IS NOT. A delivery rate. Real sending is governed by remote receivers, per-destination
  concurrency limits and reputation; none of that is present here. Do not quote this as capacity.
  docs/mail/SCALING.md marks which figures are measured and which are estimates.
`);

// Non-zero exit above a 1% error rate, so this is usable as a gate rather than only as a report.
process.exit(failed / Math.max(1, TOTAL) > 0.01 ? 1 : 0);
