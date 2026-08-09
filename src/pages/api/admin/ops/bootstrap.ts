// POST /api/admin/ops/bootstrap — create every self-bootstrapping module table on demand.
//
// This platform has no migration runner: each module creates its own tables the first time somebody
// opens it. That works, but it means /api/health reports "degraded — N module table(s) not yet
// created" until a human happens to visit each surface, and an unvisited module's first real user
// is the one who discovers the table is missing. This endpoint touches them all deliberately.
//
// Every ensure is idempotent (CREATE TABLE IF NOT EXISTS inside an ensureOnce guard) and additive.
// Nothing here drops or alters existing data. Safe to run repeatedly.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';

function j(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// Declared before the handler that reads it — `const` is not hoisted, and that has taken pages down
// on this project. Each entry is one module and the import that triggers its bootstrap.
const MODULES: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: 'auth-registry', run: async () => (await import('@/lib/auth/registry')).ensureRegistrySchema() },
  { name: 'rbac', run: async () => (await import('@/lib/rbac/store')).ensureRbacSchema() },
  { name: 'observability-health', run: async () => (await import('@/lib/observability-health')).ensureObservabilitySchema() },
  { name: 'feature-flags', run: async () => (await import('@/lib/observability')).ensureFlagSchema() },
  { name: 'knowledge-sync', run: async () => (await import('@/lib/knowledge-sync')).ensureSyncSchema() },
  { name: 'mail', run: async () => (await import('@/lib/mail')).ensureMailSchema() },
  // These two have no exported ensure; a harmless READ triggers the same internal bootstrap.
  { name: 'error-log', run: async () => (await import('@/lib/logger')).recentErrors(1) },
  { name: 'job-queue', run: async () => (await import('@/lib/job-queue')).claimBatch(0) },
];

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  // 'settings.edit' is the real key for changing platform configuration. A capability string outside
  // the union answers false for EVERY role including super_admin, so this is checked, not assumed.
  if (!can(user as any, 'settings.edit')) return j({ ok: false, error: 'not permitted' }, 403);

  const results: Array<{ module: string; ok: boolean; error?: string }> = [];
  for (const m of MODULES) {
    try {
      await m.run();
      results.push({ module: m.name, ok: true });
    } catch (e: any) {
      // The real Postgres reason is on e.cause; e.message is only the failed SQL. Never swallowed —
      // one module failing must not hide behind the seven that worked.
      const why = e?.cause?.message || e?.message || 'unknown error';
      console.error('[ops/bootstrap] ' + m.name + ' failed:', why);
      results.push({ module: m.name, ok: false, error: why });
    }
  }

  // VERIFY, do not trust the return. ensureOnce() ends in `p.catch(() => {})`, so a DDL statement
  // that threw still resolves and every ensure above reports success. The first run of this endpoint
  // answered ok:true, ran:8, failed:0 while /api/health went on reporting all ten tables missing.
  // A green result from a call is not evidence the call did anything; the only evidence is the
  // database itself, so ask it.
  const EXPECTED = ['audit_log', 'edu_cron_runs', 'edu_error_log', 'edu_feature_flags', 'edu_job_log',
    'edu_jobs', 'edu_releases', 'edu_sync_queue', 'mail_config', 'rbac_audit'];
  let present: string[] = [];
  let verifyError = '';
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const r: any = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${EXPECTED})`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    present = rows.map((x: any) => String(x.table_name));
  } catch (e: any) {
    verifyError = e?.cause?.message || e?.message || 'unknown error';
  }
  const missing = EXPECTED.filter((t) => !present.includes(t));

  const failed = results.filter((r) => !r.ok);
  return j({
    ok: failed.length === 0 && missing.length === 0 && verifyError === '',
    ran: results.length,
    failed: failed.length,
    results,
    verified: verifyError === '' ? { present: present.length, missing } : null,
    verifyError: verifyError || undefined,
  });
};
