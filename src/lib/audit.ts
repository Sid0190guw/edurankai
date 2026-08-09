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

export async function logAudit(args: {
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  ipAddress?: string;
}) {
  try {
    await db.insert(auditLog).values({
      userId: args.userId,
      action: args.action,
      entity: args.entity,
      entityId: args.entityId ?? null,
      diff: args.diff ?? null,
      ipAddress: args.ipAddress ?? null
    });
  } catch (err) {
    console.error('Audit log failed:', err);
  }
}
