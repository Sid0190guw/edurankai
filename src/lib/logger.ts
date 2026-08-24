// src/lib/logger.ts — structured logging + error tracking (Prompt AP7b). Emits structured JSON logs,
// REDACTS anything that looks like a secret before it's stored/printed, and records errors to a
// durable log (edu_error_log) with a pluggable hook for an external tracker (Sentry/etc) when
// configured. No stack/PII leaks to clients — sanitizeError (http-guard) owns the user-facing message.
import { SECRET_PATTERNS } from '@/lib/security-audit';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Redact secret-shaped values from a metadata object (pure). */
export function redactMeta(meta: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(meta || {})) {
    let v = meta[k];
    if (typeof v === 'string') { for (const p of SECRET_PATTERNS) if (p.re.test(v)) v = '[redacted]'; if (/pass|secret|token|key/i.test(k) && typeof v === 'string' && v.length > 3 && v !== '[redacted]') v = '[redacted]'; }
    out[k] = v;
  }
  return out;
}
/** A structured log line (pure). */
export function formatLog(level: LogLevel, event: string, meta: Record<string, any> = {}): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, event, ...redactMeta(meta) });
}
export function logEvent(level: LogLevel, event: string, meta: Record<string, any> = {}): void {
  const line = formatLog(level, event, meta);
  if (level === 'error' || level === 'warn') console.error(line); else console.log(line);
}

const ERR_DDL = `CREATE TABLE IF NOT EXISTS edu_error_log (id bigserial PRIMARY KEY, event text, message text, context jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`;
// ADDITIVE (observability). Two columns and two indexes, all IF NOT EXISTS, on the SAME table this
// module already owns — not a second logging system.
//   fingerprint — the grouping key, computed at WRITE time (observability-health.errorFingerprint)
//     so /admin/ops can collapse 400 repeats of one fault with a GROUP BY instead of reading 400 rows.
//   release     — which commit was serving when it happened, so a fault can be tied to a deploy.
// The created_at index is what makes the "last 24h" incident board cheap; without it every ops page
// load sequentially scans a table that only ever grows.
const ERR_DDL_EXTRA = [
  `ALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS fingerprint text`,
  // Quoted: RELEASE is a (non-reserved) Postgres keyword. Non-reserved words are legal as column
  // names, but this cannot be tested against a database from here, and quoting costs nothing.
  `ALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS "release" text`,
  `CREATE INDEX IF NOT EXISTS edu_error_log_created_idx ON edu_error_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS edu_error_log_fp_idx ON edu_error_log (fingerprint)`,
];
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// FIVE ROUND TRIPS, NO LOCK TIMEOUT, AND OUTSIDE THE KILL SWITCH -- ON THE ERROR PATH.
//
// This was `let _ready = false` with the five statements issued one at a time on the first log write
// of every serverless instance. Three things were wrong with that, and all three matter most exactly
// when something is already going wrong:
//
//   * It did not go through ensureOnce, so the production SCHEMA_BOOTSTRAP kill switch -- added after
//     request-time DDL took the site down on 2026-08-23 -- never covered the error logger at all.
//   * It did not go through guardedDdl, so the two ALTER TABLEs had no lock_timeout. ALTER TABLE takes
//     ACCESS EXCLUSIVE before it evaluates IF NOT EXISTS, and a pending exclusive lock is granted
//     ahead of every read requested after it. An error logger that can queue readers behind itself is
//     a fault amplifier: the first failure makes the next one more likely.
//   * Five separate statements is five round trips (~135ms each from bom1) before a single error row
//     could be written, paid by whichever unlucky request was the first to fail on that instance.
//
// ensureBatch gives all three: the kill switch, an explicit transaction with lock_timeout 3s, and one
// round trip instead of five. It is the right shape here -- unlike src/lib/request-threads.ts -- because
// every statement targets the SAME table this module owns, so there is no case where one is
// deliberately allowed to fail while the others should stand.
//
// The table's definition now also lives in db/incident-2026-08-24-observability.sql, because a table
// that only a suppressed bootstrap could create is a table an operator has no way to create.
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  const { ensureBatch } = await import('@/lib/ensure-once');
  await ensureBatch('edu_error_log_v2', [ERR_DDL, ...ERR_DDL_EXTRA].join(';\n'));
  return { db, sql };
}

/** Record an error durably (redacted) + emit a structured log + fire the external hook if present. */
export async function trackError(event: string, e: any, context: Record<string, any> = {}): Promise<void> {
  const message = String(e?.cause?.message || e?.message || e || 'error').slice(0, 500);
  const meta = redactMeta(context);
  logEvent('error', event, { message, ...meta });
  try { const hook = (globalThis as any).__errorHook; if (typeof hook === 'function') hook(event, message, meta); } catch { /* hook must never throw the request */ }
  // Fingerprint + release are computed here, at write time, so grouping and release attribution are
  // properties of the row rather than something a reader has to reconstruct from free text later.
  let fingerprint: string | null = null; let release: string | null = null;
  try { const o = await import('@/lib/observability-health'); fingerprint = o.errorFingerprint(event, message); release = o.releaseTag(); } catch { /* pure helpers; a failure here must not lose the row */ }
  try { const { db, sql } = await ctx(); await db.execute(sql`INSERT INTO edu_error_log (event, message, context, fingerprint, "release") VALUES (${event}, ${message}, ${JSON.stringify(meta)}::jsonb, ${fingerprint}, ${release})`); }
  catch {
    // Logging must never break the request — but a swallowed failure here is exactly how an incident
    // becomes invisible, so fall back to the original shape (a database that predates the two
    // columns) and, failing even that, say so on stdout rather than returning quietly.
    try { const { db, sql } = await ctx(); await db.execute(sql`INSERT INTO edu_error_log (event, message, context) VALUES (${event}, ${message}, ${JSON.stringify(meta)}::jsonb)`); }
    catch (e2: any) { console.error(formatLog('error', 'logger.persist_failed', { event, message: e2?.cause?.message || e2?.message })); }
  }
}
export async function recentErrors(limit = 50): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT event, message, context, created_at FROM edu_error_log ORDER BY id DESC LIMIT ${limit}`));
}
