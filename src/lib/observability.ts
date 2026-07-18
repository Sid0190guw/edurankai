// src/lib/observability.ts — Platform admin & observability (Prompt 22). A consolidated audit
// console over rbac_audit (which many subsystems write to via can()/writeAudit — RBAC, credentials,
// admissions, enrolment, settings, tutor, …), real system health, and feature flags that safely
// disable a subsystem's routes. Strictly superadmin-gated at the call sites. The flag logic is pure.

export interface Flag { key: string; enabled: boolean }
/** Resolve a feature flag; unknown flags default ON so nothing breaks until explicitly disabled. Pure. */
export function isEnabled(flags: Flag[], key: string, defaultOn = true): boolean {
  const f = flags.find((x) => x.key === key);
  return f ? f.enabled : defaultOn;
}
export const KNOWN_FEATURES = ['community', 'ai_tutor', 'gamification', 'offline', 'admissions', 'proctoring'] as const;

// ============================ DB (self-bootstrapping; audit reads existing rbac_audit) ============
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureFlagSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_feature_flags (key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}
export async function getFlags(): Promise<Flag[]> {
  try { await ensureFlagSchema(); const { db, sql } = await ctx(); return rows(await db.execute(sql`SELECT key, enabled FROM edu_feature_flags`)); } catch { return []; }
}
export async function setFlag(key: string, enabled: boolean): Promise<void> {
  await ensureFlagSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_feature_flags (key, enabled) VALUES (${key}, ${enabled}) ON CONFLICT (key) DO UPDATE SET enabled = ${enabled}, updated_at = NOW()`);
}
/** Quick check a route/page uses to gate a subsystem. Defaults ON if unset/unreachable. */
export async function featureEnabled(key: string, defaultOn = true): Promise<boolean> {
  try { return isEnabled(await getFlags(), key, defaultOn); } catch { return defaultOn; }
}

/** Consolidated audit across subsystems (rbac_audit), filterable + paginated. */
export async function consolidatedAudit(opts: { actor?: string; capability?: string; resource?: string; decision?: string; from?: string; to?: string; limit?: number; offset?: number }): Promise<{ rows: any[]; total: number }> {
  const { db, sql } = await ctx();
  const conds: any[] = [];
  if (opts.actor) conds.push(sql`u.name ILIKE ${'%' + opts.actor + '%'}`);
  if (opts.capability) conds.push(sql`a.capability ILIKE ${'%' + opts.capability + '%'}`);
  if (opts.resource) conds.push(sql`a.resource ILIKE ${'%' + opts.resource + '%'}`);
  if (opts.decision === 'allow') conds.push(sql`a.allow = true`);
  if (opts.decision === 'deny') conds.push(sql`a.allow = false`);
  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) conds.push(sql`a.at >= ${opts.from}::date`);
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) conds.push(sql`a.at < (${opts.to}::date + interval '1 day')`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  try {
    const total = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM rbac_audit a LEFT JOIN users u ON u.id = a.user_id ${where}`))[0]?.c || 0;
    const r = rows(await db.execute(sql`SELECT a.*, u.name AS user_name FROM rbac_audit a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.at DESC LIMIT ${opts.limit || 50} OFFSET ${opts.offset || 0}`));
    return { rows: r, total };
  } catch { return { rows: [], total: 0 }; }
}

/** Real system health: DB reachability, configured integration providers, background-queue depth. */
export async function healthCheck(): Promise<any> {
  const { db, sql } = await ctx();
  let dbOk = false; try { await db.execute(sql`SELECT 1`); dbOk = true; } catch { dbOk = false; }
  let llm = false; try { const { getConfig, isReady } = await import('@/lib/llm/gateway'); llm = isReady(await getConfig()); } catch {}
  const credSecret = !!(process.env.CREDENTIAL_SIGNING_SECRET || process.env.SESSION_SECRET);
  let syncQueue = 0; try { syncQueue = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue WHERE resolved = false`))[0]?.c || 0; } catch {}
  let offlinePkgs = 0; try { offlinePkgs = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_offline_packages`))[0]?.c || 0; } catch {}
  return { db: dbOk, providers: { llm, credentialSigning: credSecret }, queues: { syncPending: syncQueue, offlinePackages: offlinePkgs } };
}
