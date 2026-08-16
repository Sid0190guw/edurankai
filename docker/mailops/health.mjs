// docker/mailops/health.mjs — one health surface for the whole ZBook mail stack.
//
// WHY A SEPARATE SERVICE. /api/health lives in the app, which runs on Vercel. Vercel cannot reach
// the ZBook's Postfix, Dovecot, Redis or worker — they are on a private network behind a laptop.
// So the mail stack needs its own aggregator, and this is it: one URL Prometheus scrapes and one
// URL `./scripts/status-mail.sh` reads.
//
// EVERY PROBE IS A REAL CONNECTION. A TCP connect to the SMTP port, a real IMAP greeting read, a
// real Redis PING, a real HTTP call to each sidecar. Nothing here reports on configuration and
// calls it health — a check that reads its own environment variables and answers "ok" is the static
// 200 that stays green through the outage you bought it for.
//
// THREE STATES, NOT TWO. `not-configured` is distinct from `ok`, because this stack is meant to be
// run in pieces: someone testing the queue does not start Postfix, and a green tick for a container
// that is not running would be a lie. Only a component that is BOTH expected and failing makes the
// stack unhealthy; expectation comes from MAILOPS_EXPECT, so the compose profile in use decides
// what "complete" means rather than this file guessing.
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.MAILOPS_PORT || 9100);
const BIND = process.env.MAILOPS_BIND || '0.0.0.0';
const TIMEOUT_MS = Number(process.env.MAILOPS_PROBE_TIMEOUT_MS || 2500);

/** Which components this deployment is expected to have. Comma-separated; set per compose profile. */
const EXPECTED = new Set(
  String(process.env.MAILOPS_EXPECT || 'app,smtp,ingest,worker')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

const log = (o) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), svc: 'mailops', ...o }) + '\n');

const started = Date.now();

/** TCP connect, and optionally read a banner. Returns latency so a slow service is visible before it is a dead one. */
function probeTcp(host, port, { expectBanner = null } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port });
    let banner = '';
    const done = (ok, detail) => {
      try { socket.destroy(); } catch { /* already gone */ }
      resolve({ ok, detail, latencyMs: Date.now() - t0 });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('timeout', () => done(false, `no response within ${TIMEOUT_MS}ms`));
    socket.once('error', (e) => done(false, String(e && e.code ? e.code : e && e.message)));
    socket.once('connect', () => { if (!expectBanner) done(true, 'tcp connect ok'); });
    socket.on('data', (chunk) => {
      banner += chunk.toString('utf8');
      if (!expectBanner) return;
      if (banner.includes('\r\n') || banner.length > 200) {
        const first = banner.split('\r\n')[0];
        done(first.includes(expectBanner), first.includes(expectBanner) ? first.slice(0, 120) : `unexpected greeting: ${first.slice(0, 120)}`);
      }
    });
  });
}

/** Redis PING over the wire. No client library — RESP for one command is three lines. */
function probeRedis(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, detail) => { try { socket.destroy(); } catch { /* already gone */ } resolve({ ok, detail, latencyMs: Date.now() - t0 }); };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('timeout', () => done(false, `no PONG within ${TIMEOUT_MS}ms`));
    socket.once('error', (e) => done(false, String(e && e.code ? e.code : e && e.message)));
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.once('data', (chunk) => {
      const reply = chunk.toString('utf8').trim();
      done(reply === '+PONG', reply === '+PONG' ? 'PONG' : `unexpected reply: ${reply.slice(0, 80)}`);
    });
  });
}

async function probeHttp(url, { expectStatus = 200 } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    return { ok: res.status === expectStatus, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0, body: parsed };
  } catch (e) {
    return { ok: false, detail: e && e.name === 'AbortError' ? `no response within ${TIMEOUT_MS}ms` : String(e && e.message), latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const TARGETS = [
  { name: 'app', kind: 'http', url: `${(process.env.APP_URL || 'http://app:4321').replace(/\/+$/, '')}/api/health` },
  { name: 'smtp', kind: 'tcp', host: process.env.PROBE_SMTP_HOST || 'mta', port: Number(process.env.PROBE_SMTP_PORT || 25), banner: '220' },
  { name: 'submission', kind: 'tcp', host: process.env.PROBE_SMTP_HOST || 'mta', port: Number(process.env.PROBE_SUBMISSION_PORT || 587), banner: '220' },
  { name: 'imap', kind: 'tcp', host: process.env.PROBE_IMAP_HOST || 'mta', port: Number(process.env.PROBE_IMAP_PORT || 143), banner: 'OK' },
  { name: 'redis', kind: 'redis', host: process.env.PROBE_REDIS_HOST || 'redis', port: Number(process.env.PROBE_REDIS_PORT || 6379) },
  { name: 'ingest', kind: 'http', url: `${process.env.PROBE_INGEST_URL || 'http://mail-parser:1081'}/health` },
  { name: 'worker', kind: 'http', url: `${process.env.PROBE_WORKER_URL || 'http://mail-worker:1082'}/ready` },
  { name: 'sink', kind: 'http', url: `${process.env.PROBE_SINK_URL || 'http://smtp-sink:1080'}/health` },
  { name: 'rspamd', kind: 'http', url: `${process.env.PROBE_RSPAMD_URL || 'http://rspamd:11334'}/ping`, expectStatus: 200 },
];

async function probeAll() {
  const results = await Promise.all(TARGETS.map(async (t) => {
    const expected = EXPECTED.has(t.name);
    let r;
    if (t.kind === 'tcp') r = await probeTcp(t.host, t.port, { expectBanner: t.banner });
    else if (t.kind === 'redis') r = await probeRedis(t.host, t.port);
    else r = await probeHttp(t.url, { expectStatus: t.expectStatus || 200 });

    // An unexpected component that fails is not-configured (it was never started). An unexpected
    // component that ANSWERS is reported ok — it is running, and pretending otherwise would hide a
    // container somebody left up.
    const state = r.ok ? 'ok' : expected ? 'degraded' : 'not-configured';
    return { name: t.name, state, expected, latencyMs: r.latencyMs, detail: r.ok ? r.detail : expected ? r.detail : `not running (${r.detail})`, body: r.body };
  }));
  const degraded = results.filter((r) => r.state === 'degraded');
  return { status: degraded.length ? 'degraded' : 'ok', components: results, degraded: degraded.map((d) => d.name) };
}

function renderMetrics(report) {
  const lines = [
    '# HELP era_mailops_component_up Mail-stack component reachable. 1 ok, 0 degraded. Absent series = not deployed.',
    '# TYPE era_mailops_component_up gauge',
  ];
  for (const c of report.components) {
    // A not-configured component emits NO series at all. Emitting 0 would fire every alert on a
    // stack that is intentionally running only half its profiles.
    if (c.state === 'not-configured') continue;
    lines.push(`era_mailops_component_up{component="${c.name}"} ${c.state === 'ok' ? 1 : 0}`);
  }
  lines.push('# HELP era_mailops_probe_latency_ms Probe round-trip, milliseconds.', '# TYPE era_mailops_probe_latency_ms gauge');
  for (const c of report.components) {
    if (c.state === 'not-configured' || typeof c.latencyMs !== 'number' || !Number.isFinite(c.latencyMs)) continue;
    lines.push(`era_mailops_probe_latency_ms{component="${c.name}"} ${c.latencyMs}`);
  }
  lines.push('# HELP era_mailops_uptime_seconds Seconds since this aggregator started.', '# TYPE era_mailops_uptime_seconds counter', `era_mailops_uptime_seconds ${Math.floor((Date.now() - started) / 1000)}`);
  return lines.join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body, null, 2)); };

  try {
    if (url.pathname === '/health') {
      const report = await probeAll();
      return json(report.status === 'ok' ? 200 : 503, { ...report, at: new Date().toISOString() });
    }
    if (url.pathname === '/ready') {
      const report = await probeAll();
      // Ready = every EXPECTED component answers. This is what a deploy script waits on.
      const ready = report.degraded.length === 0;
      return json(ready ? 200 : 503, { ready, expected: [...EXPECTED], degraded: report.degraded, at: new Date().toISOString() });
    }
    if (url.pathname === '/metrics') {
      const report = await probeAll();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(renderMetrics(report));
    }
    if (url.pathname === '/') {
      return json(200, { service: 'era-mailops', endpoints: ['/health', '/ready', '/metrics'], expecting: [...EXPECTED] });
    }
    return json(404, { error: 'not found' });
  } catch (e) {
    log({ level: 'error', event: 'mailops.request_failed', path: url.pathname, error: String(e && e.message) });
    return json(503, { status: 'down', error: 'probe failed' });
  }
});

server.listen(PORT, BIND, () => log({ level: 'info', event: 'mailops.listening', port: PORT, expecting: [...EXPECTED] }));

const shutdown = () => { log({ level: 'info', event: 'mailops.shutdown' }); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
