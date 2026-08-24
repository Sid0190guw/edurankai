// src/lib/observability.ts — Platform admin & observability (Prompt 22). A consolidated audit
// console over rbac_audit (which many subsystems write to via can()/writeAudit — RBAC, credentials,
// admissions, enrolment, settings, tutor, …), real system health, and feature flags that safely
// disable a subsystem's routes. Strictly superadmin-gated at the call sites. The flag logic is pure.

import { ddlPermitted } from '@/lib/schema-bootstrap';

export interface Flag { key: string; enabled: boolean }
/** Resolve a feature flag; unknown flags default ON so nothing breaks until explicitly disabled. Pure. */
export function isEnabled(flags: Flag[], key: string, defaultOn = true): boolean {
  const f = flags.find((x) => x.key === key);
  return f ? f.enabled : defaultOn;
}
/**
 * The feature kill-switches, and WHAT EACH ONE ACTUALLY TURNS OFF.
 *
 * This used to be a bare list of six strings rendered as six identical checkboxes under the heading
 * "Feature flags (disable a subsystem's routes safely)". Only TWO of the six are asked about
 * anywhere: featureEnabled('ai_tutor') in /api/aquintutor/ask-aquin.ts and
 * featureEnabled('community') in /api/aquintutor/discussion.ts. `gamification`, `offline`,
 * `admissions` and `proctoring` gate NOTHING — unchecking `proctoring` wrote the row, reported
 * "Flag proctoring disabled", and proctoring carried on running exactly as before.
 *
 * A kill-switch that does not kill anything is the most dangerous kind of dead control on this
 * console, because the person flipping it is usually flipping it in a hurry. So each flag now
 * carries the call sites it governs; an empty `enforcedAt` is a flag that enforces nothing, and
 * /admin/observability renders it as inert instead of as a switch.
 *
 * TO MAKE ONE REAL: add `if (!(await featureEnabled('<key>'))) return ...` at the entry point, then
 * list that file here. The two lists must move together.
 */
export interface FeatureFlagDef {
  key: string;
  label: string;
  /** Files that actually ask featureEnabled() for this key. Empty means the switch enforces nothing. */
  enforcedAt: string[];
}

export const FEATURE_CATALOG: FeatureFlagDef[] = [
  { key: 'community',    label: 'Community discussions', enforcedAt: ['src/pages/api/aquintutor/discussion.ts'] },
  { key: 'ai_tutor',     label: 'AI tutor',              enforcedAt: ['src/pages/api/aquintutor/ask-aquin.ts'] },
  { key: 'gamification', label: 'Gamification',          enforcedAt: [] },
  { key: 'offline',      label: 'Offline packages',      enforcedAt: [] },
  { key: 'admissions',   label: 'Admissions',            enforcedAt: [] },
  { key: 'proctoring',   label: 'Proctoring',            enforcedAt: [] },
];

/** True when flipping this switch changes what some route does. */
export function isFeatureEnforced(key: string): boolean {
  return (FEATURE_CATALOG.find((f) => f.key === key)?.enforcedAt.length || 0) > 0;
}

export const KNOWN_FEATURES = FEATURE_CATALOG.map((f) => f.key);

// ============================ DB (self-bootstrapping; audit reads existing rbac_audit) ============
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureFlagSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_feature_flags (key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  // NOT `= true`. A suppressed DDL run must not latch as a completed one.
  //
  // db.execute refuses DDL when schema bootstrap is off (src/lib/schema-bootstrap.ts) and returns
  // the same empty result a real statement would, deliberately, so nothing downstream has to
  // change. The cost of that indistinguishability is exactly here: setting the flag
  // unconditionally recorded "already bootstrapped" for a loop that created nothing. Any earlier
  // request on a warm instance -- a page render, a health probe, even loading /admin/setup before
  // pressing its button -- would latch it, and the operator's allowingDdl() pass would then return
  // at the guard above and report success having done nothing.
  // Recording what actually happened means a suppressed run stays unlatched and the deliberate
  // operator pass re-runs it for real.
  booted = ddlPermitted();
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

/**
 * Consolidated audit across subsystems (rbac_audit), filterable + paginated.
 *
 * `error` IS THE POINT OF THE THIRD FIELD. This used to end `catch { return { rows: [], total: 0 } }`,
 * and /admin/observability renders exactly that as "Consolidated audit · 0 rows" above the words
 * "No audit rows match." So when rbac_audit was unreadable, the one screen whose job is to show
 * every allow/deny decision on the platform reported that there had been none — the same shape as
 * /admin/hardening printing "No errors logged — clean." while its query was throwing. An empty
 * result and an unanswerable question must not render the same, least of all on a security console.
 *
 * Still non-fatal (the page keeps rendering its other panels); the caller is expected to SAY so.
 */
export async function consolidatedAudit(opts: { actor?: string; capability?: string; resource?: string; decision?: string; from?: string; to?: string; limit?: number; offset?: number }): Promise<{ rows: any[]; total: number; error?: string }> {
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
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    const reason = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[observability] consolidated audit read failed -', reason);
    return { rows: [], total: 0, error: reason };
  }
}

/** Real system health: DB reachability, configured integration providers, background-queue depth. */
export async function healthCheck(): Promise<any> {
  const { db, sql } = await ctx();
  // Every arm below reports its own reason. The two queue depths in particular were `catch {}` and
  // therefore rendered as a confident "0" on /admin/observability whenever the count threw — a
  // health panel that shows a healthy number because it could not read is the failure mode this
  // whole module exists to prevent. `queuesRead` says whether those numbers are answers or defaults.
  let dbOk = false;
  try { await db.execute(sql`SELECT 1`); dbOk = true; } catch (e: any) {
    dbOk = false;
    console.error('[observability] health: database unreachable -', e?.cause?.message || e?.message);
  }
  let llm = false;
  try { const { getConfig, isReady } = await import('@/lib/llm/gateway'); llm = isReady(await getConfig()); } catch (e: any) {
    console.error('[observability] health: AI provider config unreadable -', e?.cause?.message || e?.message);
  }
  const credSecret = !!(process.env.CREDENTIAL_SIGNING_SECRET || process.env.SESSION_SECRET);
  let queuesRead = true;
  let syncQueue = 0;
  try { syncQueue = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue WHERE resolved = false`))[0]?.c || 0; } catch (e: any) {
    queuesRead = false;
    console.error('[observability] health: sync-queue depth unreadable -', e?.cause?.message || e?.message);
  }
  let offlinePkgs = 0;
  try { offlinePkgs = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_offline_packages`))[0]?.c || 0; } catch (e: any) {
    queuesRead = false;
    console.error('[observability] health: offline-package count unreadable -', e?.cause?.message || e?.message);
  }
  return { db: dbOk, providers: { llm, credentialSigning: credSecret }, queues: { syncPending: syncQueue, offlinePackages: offlinePkgs, read: queuesRead } };
}
