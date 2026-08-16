// Resolved LAZILY. A top-level db import makes src/lib/db throw DATABASE_URL is not set the moment
// any importer loads, which puts every pure function in this module — and in anything that imports
// it — out of reach of a test that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { auditLog } from '@/lib/db/schema';
import { ensureOnce } from '@/lib/ensure-once';

/**
 * The indexes every reader of audit_log depends on.
 *
 * WHY THIS IS NOT ALREADY GUARANTEED. src/lib/db/schema.ts declares audit_user_idx,
 * audit_entity_idx and audit_created_idx on this table — but this project has NO migration runner
 * (schema changes self-bootstrap as CREATE TABLE / ADD COLUMN IF NOT EXISTS), so a Drizzle index()
 * declaration is on the live database only if drizzle-kit was pointed at it. I cannot connect to the
 * database to check, so this makes the guarantee unconditional instead of assumed.
 *
 * Every statement is IF NOT EXISTS, so on a database that already has them this is a no-op, and the
 * names match the Drizzle declarations exactly so nothing ends up duplicated under two names.
 *
 * audit_action_idx has no Drizzle counterpart and is the one genuinely new index: /admin/audit both
 * filters and builds its facet list on `action`, which had nothing to read but a sequential scan.
 *
 * Called from READERS, not from logAudit(): a write path must not pay for schema work. ensureOnce
 * memoises it to one round-trip per process and swallows failure, so an index that has not appeared
 * yet costs a slow page, never a broken one.
 */
export function ensureAuditIndexes(): Promise<void> {
  return ensureOnce('audit_log:indexes', async () => {
    await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at)`);
    await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log (user_id)`);
    await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity, entity_id)`);
    await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action)`);
  });
}

/**
 * The outcome of an audit write.
 *
 * WHY THIS EXISTS. `logAudit()` returned `void`, so all 454 call sites across this codebase carried
 * on identically whether the row was written or silently lost. Several of those call sites are the
 * only record that a sensitive action happened at all. A caller that cannot tell the difference
 * cannot roll back, cannot warn, and cannot decline to proceed — so "audited" quietly degraded to
 * "attempted to audit" everywhere, with nothing on any surface to say so.
 *
 * `ok: false` is not an exception. The swallow is deliberate and stays: 454 callers depend on a
 * logging hiccup never blocking somebody's work, and turning that into a throw would convert a
 * degraded log into an outage. What changes is that the failure is now RETURNED, TRACKED and
 * VISIBLE instead of dying in a console nobody reads. Callers that must fail closed have
 * `logAuditOrThrow()` below.
 */
export interface AuditResult {
  /** The row reached `audit_log`. */
  ok: boolean;
  /** Why it did not. Taken from `e.cause`, where postgres-js puts the real reason. Absent when ok. */
  error?: string;
}

export async function logAudit(args: {
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<AuditResult> {
  try {
    // Through the SAME lazy resolver ensureAuditIndexes() uses. The lazy-db pass converted the
    // statements above it and left this one referring to a bare `db` that this module no longer
    // imports, so the file did not compile — and every surface that writes an audit entry went down
    // with it. Resolved here rather than by re-adding a module-scope import, because that import is
    // precisely what the lazy resolver exists to avoid.
    const dbi = await database();
    await dbi.insert(auditLog).values({
      userId: args.userId,
      action: args.action,
      entity: args.entity,
      entityId: args.entityId ?? null,
      diff: args.diff ?? null,
      ipAddress: args.ipAddress ?? null
    });
    return { ok: true };
  } catch (err: any) {
    // NOT A BARE console.error ANY MORE, for two reasons this project has already paid for.
    //
    // 1. `console.error('Audit log failed:', err)` surfaced `err.message`, which for postgres-js is
    //    the FAILED SQL, not the reason it failed. The reason is on `e.cause`. An operator reading
    //    that line saw an INSERT statement and no cause — indistinguishable from noise.
    // 2. stdout is not a surface. `/admin/ops` builds its incident board from `edu_error_log`
    //    (observability-health.errorGroups), and a failing audit subsystem was the one class of
    //    fault that never appeared there, so the board could read healthy while the audit trail had
    //    stopped recording. trackError() writes the row, fingerprints it for grouping and tags the
    //    release — the same treatment every other fault in this codebase already gets.
    //
    // `args.diff` is deliberately NOT forwarded. Diffs carry the values being changed — salary, PAN,
    // health-adjacent fields — and the error log is a lower-trust store with different retention and
    // a wider read audience than `audit_log` itself. Action, entity and entity id identify the failed
    // operation precisely enough to investigate without copying the payload into a second table.
    // `userId` is omitted for the same reason: the failure is a property of the operation, not of
    // the person who happened to trigger it.
    const reason = err?.cause?.message || err?.message || String(err);
    try {
      const { trackError } = await import('@/lib/logger');
      await trackError('audit.write_failed', err, {
        action: args.action,
        entity: args.entity,
        entityId: args.entityId ?? null,
      });
    } catch {
      // trackError carries its own fallbacks and is written never to throw. If it does anyway, the
      // audit failure must still leave a trace, and that trace must carry the cause not the statement.
      console.error('[audit] write failed, and the failure could not be tracked: ' + reason);
    }
    return { ok: false, error: reason };
  }
}

/**
 * Audit write for paths where an unrecorded action must not be allowed to stand.
 *
 * Use this where the audit row IS the control — a permission grant, a legal-hold access, a payroll
 * approval, a health-data disclosure. The caller is expected to catch and undo the work it was
 * auditing, exactly as `registry.ts` already does around its own strict sink (`recordStrict`).
 *
 * Do NOT use it for ordinary activity (`content.view` and friends). Making those throw would take a
 * page down over a logging hiccup, which is the failure the swallow in `logAudit` exists to prevent.
 */
export async function logAuditOrThrow(args: Parameters<typeof logAudit>[0]): Promise<void> {
  const result = await logAudit(args);
  if (!result.ok) {
    throw new Error(`Audit write failed for ${args.action} on ${args.entity}: ${result.error || 'unknown reason'}`);
  }
}
