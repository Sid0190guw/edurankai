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
