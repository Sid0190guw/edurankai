// src/lib/security/signals.ts — Block 11: scan orchestration + persistence. Reads the audit
// tables every can()/login already writes, runs the pure detectors, dedupes against open
// signals, and inserts survivors. The serverless replacement for a resident SIEM daemon.
import { SECURITY_DDL, type SecuritySignal } from './schema';
import {
  detectLoginBursts, detectPrivilegeEscalation, detectSessionFanout, detectImpossibleTravel,
  type AuditRow, type RbacAuditRow, type SessionRow, type DetectedSignal,
} from './detectors';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function ensureSecuritySchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  for (const ddl of SECURITY_DDL) await db.execute(sql.raw(ddl));
  booted = true;
}

export async function runSecurityScan(windowMinutes = 60): Promise<{ inserted: number; byKind: Record<string, number> }> {
  await ensureSecuritySchema();
  const { db, sql } = await ctx();
  const now = new Date();
  const start = new Date(now.getTime() - windowMinutes * 60_000);

  // `created_at >= start` on audit_log is the hot predicate of this entire scan. Without an index it
  // is a sequential scan of the fastest-growing table in the database, run on a schedule. The ensure
  // is idempotent (CREATE INDEX IF NOT EXISTS) and memoised to one round-trip per process.
  //
  // The three window reads below are deliberately NOT capped with a LIMIT. Every detector in
  // detectors.ts is a counter over the rows it is handed, so truncating the window would silently
  // lower a burst count and could suppress a real signal — a security regression dressed up as a
  // performance win. What bounds the work is the window itself, which the caller sets, and the index
  // is what makes reading that window cheap. Recorded here so this reads as a decision, not an
  // oversight, to whoever audits it next.
  try { const { ensureAuditIndexes } = await import('@/lib/audit'); await ensureAuditIndexes(); } catch { /* index work must never stop a scan */ }

  let audit: AuditRow[] = [], rbac: RbacAuditRow[] = [], sessions: SessionRow[] = [];
  try { audit = rows(await db.execute(sql`SELECT user_id AS "userId", action, entity, ip_address AS "ipAddress", created_at AS "createdAt" FROM audit_log WHERE created_at >= ${start}`)).map((r: any) => ({ ...r, createdAt: new Date(r.createdAt) })); } catch { /* table may not exist yet */ }
  try { rbac = rows(await db.execute(sql`SELECT user_id AS "userId", capability, allow, reason, at FROM rbac_audit WHERE at >= ${start}`)).map((r: any) => ({ ...r, at: new Date(r.at) })); } catch { /* */ }
  try { sessions = rows(await db.execute(sql`SELECT user_id AS "userId", ip_address AS "ipAddress", created_at AS "createdAt" FROM sessions WHERE created_at >= ${start}`)).map((r: any) => ({ ...r, createdAt: new Date(r.createdAt) })); } catch { /* */ }

  const detected: DetectedSignal[] = [
    ...detectLoginBursts(audit, now),
    ...detectPrivilegeEscalation(rbac, now),
    ...detectSessionFanout(sessions, now),
    ...detectImpossibleTravel(sessions, now),
  ];

  // de-dupe against OPEN signals with the same (kind, subject) inside the scan window.
  let openKeys = new Set<string>();
  try {
    const existing = rows(await db.execute(sql`SELECT kind, subject_user_id AS "subjectUserId", subject_ip AS "subjectIp" FROM security_signals WHERE status = 'open' AND window_end >= ${start}`));
    openKeys = new Set(existing.map((r: any) => `${r.kind}|${r.subjectUserId ?? ''}|${r.subjectIp ?? ''}`));
  } catch { /* */ }

  const byKind: Record<string, number> = {};
  let inserted = 0;
  for (const s of detected) {
    const key = `${s.kind}|${s.subjectUserId ?? ''}|${s.subjectIp ?? ''}`;
    if (openKeys.has(key)) continue;
    openKeys.add(key);
    await db.execute(sql`INSERT INTO security_signals (kind, severity, subject_user_id, subject_ip, score, evidence, window_start, window_end)
      VALUES (${s.kind}, ${s.severity}, ${s.subjectUserId}, ${s.subjectIp}, ${s.score}, ${JSON.stringify(s.evidence)}::jsonb, ${s.windowStart.toISOString()}, ${s.windowEnd.toISOString()})`);
    inserted++;
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  }
  return { inserted, byKind };
}

export async function listSignals(opts: { status?: string; limit?: number } = {}): Promise<SecuritySignal[]> {
  await ensureSecuritySchema(); const { db, sql } = await ctx();
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const q = opts.status
    ? sql`SELECT * FROM security_signals WHERE status = ${opts.status} ORDER BY created_at DESC LIMIT ${limit}`
    : sql`SELECT * FROM security_signals ORDER BY created_at DESC LIMIT ${limit}`;
  return rows(await db.execute(q)) as SecuritySignal[];
}

export async function setSignalStatus(id: string, status: 'ack' | 'dismissed'): Promise<void> {
  await ensureSecuritySchema(); const { db, sql } = await ctx();
  await db.execute(sql`UPDATE security_signals SET status = ${status} WHERE id = ${id}`);
}
