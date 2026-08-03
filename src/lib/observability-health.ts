// src/lib/observability-health.ts — health checks, error GROUPING and the ops signals behind
// /api/health, /api/health/deep and /admin/ops.
//
// WHY THIS EXISTS. Two incidents on this project were invisible rather than loud:
//   - a gate refused a request and wrote no error row anywhere, so nothing could be read afterwards;
//   - a hire failed silently for eleven days because the real Postgres reason lived on `e.cause`
//     and was thrown away.
// src/lib/logger.ts already fixed the second (trackError reads e.cause first) and already owns the
// durable table edu_error_log. This module does NOT start a second logging system: it READS what
// logger.ts writes, groups it so 400 repeats of one fault are one row, and adds the surrounding
// signals an operator needs at 2am — database latency, connection-pool pressure, queue depth, cron
// last-run, which self-bootstrapping schemas have actually run, and WHICH COMMIT IS SERVING.
//
// DEPLOYMENT REALITY this is written against (Vercel serverless + Supabase transaction pooler):
//   - no shared in-process cache between invocations, no background timer that survives a response,
//     so nothing here memoises across requests and nothing here schedules anything;
//   - connections are precious. Every function below issues SHORT, individually-awaited statements
//     on the shared pooled client. No BEGIN, no LISTEN, no cursor, no long-lived handle — a health
//     probe that held a connection would be the outage it is meant to detect;
//   - /api/health is meant to be POLLED, so quickHealth() runs exactly two statements and executes
//     NO DDL. The self-bootstrapping CREATE TABLEs stay where they are, in the modules that own them.
//
// The pure half (fingerprinting, status roll-up, cron expectations, the deploy marker) is exported
// separately and tested in observability-health.test.ts with no database.

// ============================================================================================
// PURE — no database, no environment beyond an injectable bag. Tested.
// ============================================================================================

export type Health = 'ok' | 'degraded' | 'down';
export interface Check { name: string; ok: boolean; critical?: boolean; detail?: string }

/**
 * Roll individual checks into one word. A failed CRITICAL check is `down` (the thing is not
 * serving); any other failure is `degraded` (it serves, something is wrong). Pure.
 */
export function overallStatus(checks: Check[]): Health {
  if (checks.some((c) => c.critical && !c.ok)) return 'down';
  if (checks.some((c) => !c.ok)) return 'degraded';
  return 'ok';
}

/**
 * The HTTP code an external monitor sees. Only `down` is 503 — a degraded mail transport must not
 * page somebody at 3am, an unreachable database must. Pure.
 */
export function statusHttpCode(s: Health): number {
  return s === 'down' ? 503 : 200;
}

/**
 * THE GROUPING KEY. The same fault recurring 400 times must be ONE row with a count.
 *
 * Normalises the volatile parts of a message — ids, emails, timestamps, quoted literals, bare
 * numbers — so "duplicate key ... (id)=(41f3…)" and the same failure for a different row collapse
 * together, while two genuinely different faults under one event stay apart. Computed at WRITE time
 * by logger.trackError and stored on the row, so grouping is a plain GROUP BY and never a scan of
 * 400 rows pulled into memory. Pure.
 */
export function errorFingerprint(event: string, message: string): string {
  const norm = String(message == null ? '' : message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\b\d[\d_.]*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const ev = String(event || '').trim() || 'unknown';
  return ev + ' | ' + (norm || '(no message)');
}

/**
 * How often a cron is EXPECTED to run, in hours, from its expression. Deliberately coarse: this
 * deployment is Vercel Hobby, where crons are DAILY ONLY, so the only cases that matter are daily,
 * weekly and monthly. Unparseable falls back to daily rather than throwing. Pure.
 */
export function cronIntervalHours(schedule: string): number {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length < 5) return 24;
  const hour = parts[1];
  const dom = parts[2];
  const dow = parts[4];
  if (dow !== '*' && dow !== '?') return 168;      // weekly
  if (dom !== '*' && dom !== '?') return 24 * 28;  // monthly-ish
  if (hour === '*' || hour.includes('/')) return 1;
  return 24;
}

/**
 * What to say about a cron. `never` = nothing has ever recorded a run (which is NOT the same as
 * "it failed" — it may simply not call recordCronRun yet, and the ops view says so). `overdue` =
 * a run was recorded but is older than 1.5 intervals, which on a daily cron means it missed a day.
 * Pure.
 */
export function cronRunState(schedule: string, lastRunAt: string | Date | null | undefined, now: number | Date = Date.now()): 'never' | 'ok' | 'overdue' {
  if (!lastRunAt) return 'never';
  const t = new Date(lastRunAt as any).getTime();
  if (!Number.isFinite(t)) return 'never';
  const graceMs = cronIntervalHours(schedule) * 3600 * 1000 * 1.5;
  return Number(now) - t > graceMs ? 'overdue' : 'ok';
}

/** Compact "3m ago" / "2d ago" for the ops table. Pure. */
export function relativeAge(when: string | Date | null | undefined, now: number | Date = Date.now()): string {
  if (!when) return 'never';
  const t = new Date(when as any).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((Number(now) - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

export interface DeployMarker {
  commit: string | null;
  shortCommit: string | null;
  ref: string | null;
  message: string | null;
  environment: string | null;
  region: string | null;
  deploymentId: string | null;
  known: boolean;
}

/**
 * WHICH COMMIT IS SERVING. Read entirely from the variables Vercel already injects — inventing a
 * new one would mean a release marker that is right until somebody forgets to set it, and it would
 * be wrong precisely on the emergency deploy nobody prepared. Locally none of these exist and the
 * marker honestly reports known:false rather than guessing. Pure over an injectable env bag.
 */
export function deployMarker(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}) as any): DeployMarker {
  const pick = (k: string): string | null => {
    const v = env?.[k];
    const s = (v == null ? '' : String(v)).trim();
    return s ? s : null;
  };
  const commit = pick('VERCEL_GIT_COMMIT_SHA');
  return {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    ref: pick('VERCEL_GIT_COMMIT_REF'),
    message: (pick('VERCEL_GIT_COMMIT_MESSAGE') || '').slice(0, 140) || null,
    environment: pick('VERCEL_ENV'),
    region: pick('VERCEL_REGION'),
    deploymentId: pick('VERCEL_DEPLOYMENT_ID'),
    known: !!commit,
  };
}

/** The release string stamped onto every error row, so a fault can be tied to a deploy. Pure. */
export function releaseTag(env?: Record<string, string | undefined>): string | null {
  const m = deployMarker(env);
  if (!m.known) return null;
  return (m.environment ? m.environment + ':' : '') + (m.shortCommit || '');
}

/**
 * The crons Vercel is configured to call. Mirrors vercel.json — and the test asserts the two match,
 * so adding a cron there without adding it here fails CI instead of quietly leaving a scheduled job
 * unmonitored. Hobby tier: daily only.
 */
export const CONFIGURED_CRONS: { path: string; schedule: string }[] = [
  { path: '/api/mail/imap-poll', schedule: '0 9 * * *' },
  { path: '/api/mail/scheduled-send', schedule: '0 7 * * *' },
  { path: '/api/payments/reconcile', schedule: '20 5 * * *' },
  { path: '/api/aquintutor/streak-nudge', schedule: '30 14 * * *' },
  { path: '/api/aquintutor/league-settle', schedule: '0 1 * * 1' },
  { path: '/api/hiring/draft-reminders', schedule: '45 4 * * *' },
  { path: '/api/cron/hei-refresh', schedule: '0 3 * * *' },
  { path: '/api/cron/activity-digest', schedule: '0 13 * * *' },
];

/**
 * The self-bootstrapping schemas this deployment expects, and the module that owns each CREATE
 * TABLE. There is no migration runner here — DDL runs on first use inside the owning module — so
 * "has this module ever run in production?" is answerable only by looking for its table. Absent is
 * not automatically broken: a module nothing has exercised yet has simply not bootstrapped.
 */
export const BOOTSTRAP_MODULES: { module: string; table: string; owner: string }[] = [
  { module: 'Error log', table: 'edu_error_log', owner: 'src/lib/logger.ts' },
  { module: 'Job queue', table: 'edu_jobs', owner: 'src/lib/job-queue.ts' },
  { module: 'Job delivery log', table: 'edu_job_log', owner: 'src/lib/job-queue.ts' },
  { module: 'Feature flags', table: 'edu_feature_flags', owner: 'src/lib/observability.ts' },
  { module: 'Cron runs', table: 'edu_cron_runs', owner: 'src/lib/observability-health.ts' },
  { module: 'Releases', table: 'edu_releases', owner: 'src/lib/observability-health.ts' },
  { module: 'RBAC audit', table: 'rbac_audit', owner: 'src/lib/rbac/schema.ts' },
  { module: 'Audit log', table: 'audit_log', owner: 'src/lib/db/schema.ts' },
  { module: 'Knowledge sync queue', table: 'edu_sync_queue', owner: 'src/lib/knowledge-sync.ts' },
  { module: 'Mail config', table: 'mail_config', owner: 'src/lib/mail.ts' },
];

// ============================================================================================
// DATABASE — short statements only. Nothing below holds a connection or runs a timer.
// ============================================================================================

// postgres-js resolves execute() to a PLAIN ARRAY. Never r.rows[0].
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// Declared before every handler that uses it: `const` is not hoisted, and that has taken pages down here.
const ctx = async () => {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
};

const OBS_DDL = [
  'CREATE TABLE IF NOT EXISTS edu_cron_runs (path text PRIMARY KEY, last_run_at timestamptz NOT NULL DEFAULT now(), last_status text, last_detail text, runs bigint NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS edu_releases (sha text PRIMARY KEY, ref text, environment text, message text, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now())',
];
let _obsReady = false;

/** Self-bootstrap this module's own two tables. Never called from the pollable /api/health. */
export async function ensureObservabilitySchema(): Promise<void> {
  if (_obsReady) return;
  const { db, sql } = await ctx();
  for (const d of OBS_DDL) await db.execute(sql.raw(d));
  _obsReady = true;
}

/**
 * Record that a scheduled job actually ran. One line for a cron route to adopt:
 *   await recordCronRun('/api/cron/thing', 'ok', 'processed 12');
 * Until a route adopts it, /admin/ops reports that cron as "no run recorded" — which is the honest
 * answer, and visibly different from "ran and failed".
 */
export async function recordCronRun(path: string, status: 'ok' | 'error' = 'ok', detail = ''): Promise<void> {
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_cron_runs (path, last_run_at, last_status, last_detail, runs)
      VALUES (${path}, now(), ${status}, ${String(detail || '').slice(0, 300)}, 1)
      ON CONFLICT (path) DO UPDATE SET last_run_at = now(), last_status = ${status}, last_detail = ${String(detail || '').slice(0, 300)}, runs = edu_cron_runs.runs + 1`);
  } catch (e: any) {
    // Instrumentation must never break the job it is instrumenting — but it must not vanish either.
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.cron_run_record_failed', { path, message: e?.cause?.message || e?.message });
  }
}

/** Note the serving commit so an error row's release tag resolves to something readable later. */
export async function recordRelease(): Promise<void> {
  const m = deployMarker();
  if (!m.known || !m.commit) return;
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_releases (sha, ref, environment, message)
      VALUES (${m.commit}, ${m.ref}, ${m.environment}, ${m.message})
      ON CONFLICT (sha) DO UPDATE SET last_seen_at = now()`);
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.release_record_failed', { message: e?.cause?.message || e?.message });
  }
}

/** Does the database answer, and how fast. One statement, no DDL, no transaction. */
export async function dbPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`SELECT 1 AS ok`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.cause?.message || e?.message || 'unreachable').slice(0, 300) };
  }
}

/**
 * Which self-bootstrapping schemas have run — ONE information_schema query for all of them, so a
 * polled health check costs two statements total rather than one per module.
 */
export async function bootstrapStatus(): Promise<{ module: string; table: string; owner: string; present: boolean }[]> {
  const names = BOOTSTRAP_MODULES.map((m) => m.table);
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(${names})`));
    const present = new Set(r.map((x: any) => String(x.table_name)));
    return BOOTSTRAP_MODULES.map((m) => ({ ...m, present: present.has(m.table) }));
  } catch {
    return BOOTSTRAP_MODULES.map((m) => ({ ...m, present: false }));
  }
}

/**
 * The pollable check. TWO statements, no DDL, no writes. 503 when the database is unreachable so an
 * external monitor can actually see an outage instead of a cheerful static 200.
 */
export async function quickHealth(): Promise<{ status: Health; httpCode: number; checks: Check[]; database: { ok: boolean; latencyMs: number; error?: string }; schemas: { ran: number; expected: number; missing: string[] }; release: DeployMarker; at: string }> {
  const ping = await dbPing();
  const boot = ping.ok ? await bootstrapStatus() : BOOTSTRAP_MODULES.map((m) => ({ ...m, present: false }));
  const missing = boot.filter((b) => !b.present).map((b) => b.table);
  const checks: Check[] = [
    { name: 'database', ok: ping.ok, critical: true, detail: ping.ok ? ping.latencyMs + 'ms' : ping.error },
    { name: 'schema-bootstrap', ok: ping.ok && missing.length === 0, detail: missing.length ? missing.length + ' module table(s) not yet created' : 'all expected tables present' },
  ];
  const status = overallStatus(checks);
  return {
    status,
    httpCode: statusHttpCode(status),
    checks,
    database: ping,
    schemas: { ran: boot.filter((b) => b.present).length, expected: boot.length, missing },
    release: deployMarker(),
    at: new Date().toISOString(),
  };
}

/** Connection-pool pressure, from the server's own view. Best-effort: a pooler may refuse this. */
export async function poolSignals(): Promise<{ available: boolean; total: number; active: number; idle: number; idleInTransaction: number; maxConnections: number | null; note?: string }> {
  const empty = { available: false, total: 0, active: 0, idle: 0, idleInTransaction: 0, maxConnections: null as number | null };
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state = 'idle')::int AS idle,
        count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_txn
      FROM pg_stat_activity WHERE datname = current_database()`))[0];
    let maxConnections: number | null = null;
    try { maxConnections = Number(rows(await db.execute(sql`SELECT setting::int AS m FROM pg_settings WHERE name = 'max_connections'`))[0]?.m) || null; } catch { /* not exposed through some poolers */ }
    return {
      available: true,
      total: Number(r?.total || 0), active: Number(r?.active || 0), idle: Number(r?.idle || 0),
      idleInTransaction: Number(r?.idle_in_txn || 0), maxConnections,
      note: 'Server-side view. This site went fully down once when leaked watchers exhausted the pooler, so idle-in-transaction climbing is the signal to act on.',
    };
  } catch (e: any) {
    return { ...empty, note: 'pg_stat_activity not readable through this connection: ' + String(e?.cause?.message || e?.message || '').slice(0, 160) };
  }
}

/** Slowest observed statements, IF the instrumentation exists. Absent extension is reported, not faked. */
export async function slowQueries(limit = 8): Promise<{ available: boolean; note: string; rows: { query: string; calls: number; meanMs: number; maxMs: number }[] }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT query, calls::bigint AS calls, mean_exec_time AS mean_ms, max_exec_time AS max_ms
      FROM pg_stat_statements ORDER BY mean_exec_time DESC NULLS LAST LIMIT ${limit}`));
    return {
      available: true,
      note: 'pg_stat_statements — literals are already normalised by the extension.',
      rows: r.map((x: any) => ({ query: String(x.query || '').replace(/\s+/g, ' ').slice(0, 220), calls: Number(x.calls || 0), meanMs: Math.round(Number(x.mean_ms || 0) * 100) / 100, maxMs: Math.round(Number(x.max_ms || 0) * 100) / 100 })),
    };
  } catch {
    return { available: false, note: 'No query instrumentation on this database (pg_stat_statements is not installed). Nothing is being measured — this panel is empty because the data does not exist, not because everything is fast.', rows: [] };
  }
}

/**
 * ERROR GROUPING. One row per distinct fault with a count, first-seen and last-seen — grouped in
 * SQL on the fingerprint stored at write time, so 400 repeats cost one row, not 400 fetched rows.
 * Rows written before the fingerprint column existed fall back to grouping by event.
 */
export async function errorGroups(opts: { hours?: number; limit?: number } = {}): Promise<{ fingerprint: string; event: string; message: string; count: number; firstSeen: string; lastSeen: string; releases: string[] }[]> {
  const hours = Math.min(720, Math.max(1, Number(opts.hours) || 24));
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 40));
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT COALESCE(fingerprint, event, 'unknown') AS fingerprint,
        MAX(event) AS event, MAX(message) AS message, COUNT(*)::int AS count,
        MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT "release"), NULL) AS releases
      FROM edu_error_log
      WHERE created_at > now() - (${hours} * INTERVAL '1 hour')
      GROUP BY 1 ORDER BY MAX(created_at) DESC LIMIT ${limit}`));
    return r.map((x: any) => ({
      fingerprint: String(x.fingerprint), event: String(x.event || ''), message: String(x.message || ''),
      count: Number(x.count || 0), firstSeen: x.first_seen, lastSeen: x.last_seen,
      releases: Array.isArray(x.releases) ? x.releases.filter(Boolean).map(String) : [],
    }));
  } catch {
    // The release/fingerprint columns are added by logger.ts on first trackError; before that has
    // ever run the columns do not exist. Fall back rather than showing an empty incident board.
    try {
      const { db, sql } = await ctx();
      const r = rows(await db.execute(sql`SELECT event AS fingerprint, event, MAX(message) AS message, COUNT(*)::int AS count,
          MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
        FROM edu_error_log WHERE created_at > now() - (${hours} * INTERVAL '1 hour')
        GROUP BY event ORDER BY MAX(created_at) DESC LIMIT ${limit}`));
      return r.map((x: any) => ({ fingerprint: String(x.fingerprint || 'unknown'), event: String(x.event || ''), message: String(x.message || ''), count: Number(x.count || 0), firstSeen: x.first_seen, lastSeen: x.last_seen, releases: [] }));
    } catch { return []; }
  }
}

/** Error volume over three windows — the shape of an incident (spiking, or steady background noise). */
export async function errorRate(): Promise<{ lastHour: number; last24h: number; last7d: number; distinct24h: number }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT
        COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 hour')::int AS h1,
        COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS h24,
        COUNT(*)::int AS d7,
        COUNT(DISTINCT COALESCE(fingerprint, event)) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS distinct24
      FROM edu_error_log WHERE created_at > now() - INTERVAL '7 days'`))[0];
    return { lastHour: Number(r?.h1 || 0), last24h: Number(r?.h24 || 0), last7d: Number(r?.d7 || 0), distinct24h: Number(r?.distinct24 || 0) };
  } catch {
    return { lastHour: 0, last24h: 0, last7d: 0, distinct24h: 0 };
  }
}

/** Configured crons joined to observed runs, plus the two last-run timestamps other modules already keep. */
export async function cronStatus(): Promise<{ path: string; schedule: string; lastRunAt: string | null; state: 'never' | 'ok' | 'overdue'; status: string | null; detail: string | null; source: string }[]> {
  const observed = new Map<string, { at: string; status: string | null; detail: string | null; source: string }>();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT path, last_run_at, last_status, last_detail FROM edu_cron_runs`));
    for (const x of r) observed.set(String(x.path), { at: x.last_run_at, status: x.last_status || null, detail: x.last_detail || null, source: 'recordCronRun' });
  } catch { /* table not bootstrapped yet — reported as "no run recorded" below */ }
  // Evidence two modules already write for themselves, so those two crons are observable today
  // without editing routes this workflow does not own.
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT imap_last_run FROM mail_config WHERE id = 1 LIMIT 1`))[0];
    if (r?.imap_last_run && !observed.has('/api/mail/imap-poll')) observed.set('/api/mail/imap-poll', { at: r.imap_last_run, status: null, detail: null, source: 'mail_config.imap_last_run' });
  } catch { /* mail not configured */ }
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT last_run_at FROM hei_miner_state WHERE id = 'default' LIMIT 1`))[0];
    if (r?.last_run_at && !observed.has('/api/cron/hei-refresh')) observed.set('/api/cron/hei-refresh', { at: r.last_run_at, status: null, detail: null, source: 'hei_miner_state.last_run_at' });
  } catch { /* miner never run */ }
  const now = Date.now();
  return CONFIGURED_CRONS.map((c) => {
    const o = observed.get(c.path);
    return {
      path: c.path, schedule: c.schedule,
      lastRunAt: o?.at ? new Date(o.at).toISOString() : null,
      state: cronRunState(c.schedule, o?.at || null, now),
      status: o?.status || null, detail: o?.detail || null,
      source: o?.source || 'not instrumented',
    };
  });
}

/** Mail transport reachability: a bounded TCP connect. Never sends mail, never sends credentials. */
export async function mailReachability(): Promise<{ configured: boolean; mode: string; host: string | null; port: number | null; reachable: boolean | null; detail: string; source: string }> {
  let cfg: any = null;
  try { const { getMailConfig } = await import('@/lib/mail'); cfg = await getMailConfig(); } catch (e: any) {
    return { configured: false, mode: 'unknown', host: null, port: null, reachable: null, detail: 'Mail config unreadable: ' + String(e?.cause?.message || e?.message || '').slice(0, 160), source: 'none' };
  }
  const host = (cfg?.smtpHost || '').trim() || null;
  const port = Number(cfg?.smtpPort || 0) || null;
  if (!host) return { configured: false, mode: 'none', host: null, port: null, reachable: null, detail: 'No SMTP transport configured — outbound mail would not leave the building.', source: cfg?.source || 'none' };
  try {
    const net = await import('node:net');
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port: port || 587 });
      const done = (v: boolean) => { try { socket.destroy(); } catch { /* already gone */ } resolve(v); };
      socket.setTimeout(2500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    return { configured: true, mode: 'smtp', host, port: port || 587, reachable, detail: reachable ? 'TCP connect succeeded (no auth attempted)' : 'TCP connect failed or timed out after 2.5s', source: cfg?.source || 'db' };
  } catch (e: any) {
    return { configured: true, mode: 'smtp', host, port, reachable: null, detail: 'Could not test: ' + String(e?.message || '').slice(0, 160), source: cfg?.source || 'db' };
  }
}

/** Everything the shallow check has, plus the operator-only signals. Discloses configuration — gate it. */
export async function deepHealth(): Promise<any> {
  const quick = await quickHealth();
  const [queue, pool, crons, mail, errors] = await Promise.all([
    import('@/lib/job-queue').then((m) => m.queueHealth()).catch(() => ({ pending: 0, processing: 0, failed: 0, done: 0 })),
    poolSignals(),
    cronStatus(),
    mailReachability(),
    errorRate(),
  ]);
  const overdue = crons.filter((c) => c.state === 'overdue');
  const checks: Check[] = [
    ...quick.checks,
    { name: 'mail-transport', ok: mail.configured && mail.reachable !== false, detail: mail.detail },
    { name: 'job-queue', ok: (queue as any).failed === 0, detail: (queue as any).failed + ' failed job(s)' },
    { name: 'cron', ok: overdue.length === 0, detail: overdue.length ? overdue.map((c) => c.path).join(', ') + ' overdue' : 'no overdue schedules' },
  ];
  const status = overallStatus(checks);
  return {
    status, httpCode: statusHttpCode(status), checks,
    database: quick.database, schemas: quick.schemas, release: quick.release,
    queue, pool, crons, mail, errors,
    at: new Date().toISOString(),
  };
}
