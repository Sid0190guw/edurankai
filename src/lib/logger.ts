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
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); if (!_ready) { await db.execute(sql.raw(ERR_DDL)); _ready = true; } return { db, sql }; }

/** Record an error durably (redacted) + emit a structured log + fire the external hook if present. */
export async function trackError(event: string, e: any, context: Record<string, any> = {}): Promise<void> {
  const message = String(e?.cause?.message || e?.message || e || 'error').slice(0, 500);
  const meta = redactMeta(context);
  logEvent('error', event, { message, ...meta });
  try { const hook = (globalThis as any).__errorHook; if (typeof hook === 'function') hook(event, message, meta); } catch { /* hook must never throw the request */ }
  try { const { db, sql } = await ctx(); await db.execute(sql`INSERT INTO edu_error_log (event, message, context) VALUES (${event}, ${message}, ${JSON.stringify(meta)}::jsonb)`); } catch { /* logging must never break the request */ }
}
export async function recentErrors(limit = 50): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT event, message, context, created_at FROM edu_error_log ORDER BY id DESC LIMIT ${limit}`));
}
