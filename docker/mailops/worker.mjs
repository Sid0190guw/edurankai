// docker/mailops/worker.mjs — the mail worker. It drains the job queue continuously.
//
// WHAT PROBLEM THIS SOLVES. The queue (`edu_jobs`, src/lib/job-queue.ts) is drained by
// GET /api/jobs/run, and on Vercel Hobby the only thing calling it is a cron that fires ONCE A DAY.
// A message queued at 09:01 waits until the next day. That is the single largest gap between "the
// mail system works" and "the mail system is usable", and it is an infrastructure problem, not an
// application one — so it is fixed here, by a process on the ZBook that calls the same endpoint on
// a short interval.
//
// IT ADDS NO SECOND QUEUE IMPLEMENTATION, DELIBERATELY. It does not open a database connection, does
// not claim jobs, does not know what a job is. It calls the endpoint the cron calls. Everything
// about claiming, retrying, backoff and idempotency stays in one place — the place that already has
// tests. A worker with its own claim logic would be a second, divergent queue, and the two would
// disagree about what "processing" means on the first crash.
//
// SO IT IS SAFE TO RUN ALONGSIDE THE VERCEL CRON. `processJobs` claims with FOR UPDATE SKIP LOCKED;
// two callers cannot claim the same job. Running this does not require turning the cron off.
//
// THE SECRET IS THE ONLY WAY IN. CRON_SECRET, sent as ?key=. If it is unset this process refuses to
// start rather than polling an endpoint that will 403 forever — a worker that logs a permission
// error every two seconds is noise that trains people to ignore the log.
const APP_URL = (process.env.APP_URL || 'http://app:4321').replace(/\/+$/, '');
const SECRET = (process.env.CRON_SECRET || '').trim();
const INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS || 5000);
const BATCH = Number(process.env.QUEUE_BATCH_SIZE || 25);
const HTTP_PORT = Number(process.env.WORKER_HTTP_PORT || 1082);
const BIND = process.env.WORKER_BIND || (process.env.IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1');

const log = (o) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), svc: 'worker', ...o }) + '\n');

if (!SECRET) {
  log({ level: 'error', event: 'worker.no_secret', detail: 'CRON_SECRET is not set. /api/jobs/run would answer 403 to every call. Refusing to start.' });
  process.exit(1);
}
if (SECRET !== SECRET.trim()) {
  // Whitespace in this value has rejected every Vercel deploy on this project in about 2 seconds.
  // Here it produces a 403 loop instead, which is harder to diagnose. Say it out loud.
  log({ level: 'error', event: 'worker.secret_whitespace', detail: 'CRON_SECRET has surrounding whitespace.' });
  process.exit(1);
}

const state = { ticks: 0, processed: 0, done: 0, failed: 0, retried: 0, consecutiveErrors: 0, lastError: '', lastOkAt: null, backlog: null };

let stopping = false;

async function tick() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const url = `${APP_URL}/api/jobs/run?key=${encodeURIComponent(SECRET)}&limit=${BATCH}`;
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      state.consecutiveErrors++;
      state.lastError = body.error || `HTTP ${res.status}`;
      log({ level: 'error', event: 'worker.tick_failed', status: res.status, error: state.lastError, consecutive: state.consecutiveErrors });
      return;
    }
    state.consecutiveErrors = 0;
    state.lastOkAt = new Date().toISOString();
    state.processed += body.processed || 0;
    state.done += body.done || 0;
    state.failed += body.failed || 0;
    state.retried += body.retried || 0;
    state.backlog = body.health ? (body.health.pending || 0) + (body.health.processing || 0) : null;
    // Only log when something happened. A line every 5 seconds saying "0 jobs" is how a log becomes
    // unreadable and an actual error becomes invisible.
    if (body.processed) log({ level: 'info', event: 'worker.drained', ...body, health: undefined, backlog: state.backlog });
  } catch (e) {
    state.consecutiveErrors++;
    state.lastError = e && e.name === 'AbortError' ? 'app did not respond within 60s' : String(e && e.message);
    log({ level: 'error', event: 'worker.tick_error', error: state.lastError, consecutive: state.consecutiveErrors });
  } finally {
    clearTimeout(timer);
    state.ticks++;
  }
}

async function loop() {
  while (!stopping) {
    await tick();
    // Back off when the app is unreachable rather than hammering a service that is redeploying.
    const delay = state.consecutiveErrors > 0 ? Math.min(60_000, INTERVAL_MS * 2 ** Math.min(5, state.consecutiveErrors)) : INTERVAL_MS;
    await new Promise((r) => setTimeout(r, delay));
  }
}

// Health surface, so status-mail.sh and Prometheus can both see whether the worker is actually
// working — a container that is "running" while every tick 403s is the failure this reports.
const http = await import('node:http');
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...state }));
  }
  if (url.pathname === '/ready') {
    // Ready = at least one successful drain. Before that, this worker has never proved it can reach
    // the app or that its secret is right.
    const ready = state.lastOkAt !== null && state.consecutiveErrors < 3;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ready, lastOkAt: state.lastOkAt, consecutiveErrors: state.consecutiveErrors, lastError: state.lastError }));
  }
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    const lines = [
      `# HELP era_worker_ticks Worker polls since start.\n# TYPE era_worker_ticks counter\nera_worker_ticks ${state.ticks}`,
      `# HELP era_worker_jobs_processed Jobs processed since start.\n# TYPE era_worker_jobs_processed counter\nera_worker_jobs_processed ${state.processed}`,
      `# HELP era_worker_jobs_failed Jobs that exhausted their attempts since start.\n# TYPE era_worker_jobs_failed counter\nera_worker_jobs_failed ${state.failed}`,
      `# HELP era_worker_consecutive_errors Consecutive failed polls. Non-zero means the app is unreachable or the secret is wrong.\n# TYPE era_worker_consecutive_errors gauge\nera_worker_consecutive_errors ${state.consecutiveErrors}`,
    ];
    if (state.backlog !== null) lines.push(`# HELP era_worker_backlog Queue backlog as last reported by the app.\n# TYPE era_worker_backlog gauge\nera_worker_backlog ${state.backlog}`);
    return res.end(lines.join('\n') + '\n');
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
api.listen(HTTP_PORT, BIND, () => log({ level: 'info', event: 'worker.started', app: APP_URL, intervalMs: INTERVAL_MS, batch: BATCH, httpPort: HTTP_PORT }));

const shutdown = () => {
  // Finish the tick in flight rather than killing it: a job claimed and abandoned sits in
  // `processing` until its attempt times out, which is exactly the "partial delivery" state the
  // disaster-recovery drill is written to catch.
  stopping = true;
  log({ level: 'info', event: 'worker.shutdown', note: 'finishing current tick' });
  api.close();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop();
