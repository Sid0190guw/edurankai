// src/lib/horizon/governance/publish.ts — putting HORIZON's permission keys into the catalogue that
// /admin/team/roles reads, so an admin can grant them without a deploy.
//
// WHY THIS IS AN ACTION SOMEBODY TAKES, NOT A BOOTSTRAP THAT RUNS ITSELF.
//
// registerPermission() in src/lib/auth/registry.ts requires an actor and audits every row it writes,
// and that requirement is not an inconvenience to work around — it is the reason the registry can
// answer "who added this permission" after an incident. A bootstrap that wrote catalogue rows on
// process start would have to invent an actor, and the honest name for an invented actor on an audit
// row is a forged one.
//
// So the keys are published by a named human from the governance console. Until they are, HORIZON's
// permissions do not exist in the catalogue, cannot be granted to a custom role, and every gate in
// this layer refuses everyone but a super admin — which is the correct closed state for a layer that
// has not been set up yet, and it is visible on the console rather than silent.
//
// WHAT PUBLISHING DOES NOT DO. It does not grant anything to anybody. It makes the keys available to
// be granted. Nobody's access changes at the moment of publishing.
import { HORIZON_PERMISSIONS, HORIZON_PERMISSION_KEYS } from './matrix';
import { GOVERNANCE_TABLES } from './schema';
import type { GovernanceActor, GovernanceResult } from './types';
import { textIn } from '@/lib/pg-array';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export interface PublishReport {
  published: string[];
  failed: { key: string; error: string }[];
}

/** Publish every HORIZON permission key into permission_catalogue, attributed to the actor. */
export async function publishGovernancePermissions(actor: GovernanceActor): Promise<GovernanceResult<PublishReport>> {
  if (!actor?.id) return { ok: false, error: 'A signed-in person must be recorded as publishing the permissions.' };
  const report: PublishReport = { published: [], failed: [] };
  try {
    const { registerPermission } = await import('@/lib/auth/registry');
    for (const p of HORIZON_PERMISSIONS) {
      const result = await registerPermission(
        { key: p.key, label: p.label, group: p.group, description: p.description, isSensitive: p.sensitive },
        { id: actor.id, email: actor.email ?? null, name: actor.name ?? null } as any,
      );
      if (result.ok) report.published.push(p.key);
      else report.failed.push({ key: p.key, error: result.error });
    }
    return { ok: true, data: report };
  } catch (e: any) {
    return { ok: false, error: reason(e) };
  }
}

export interface InstallStatus {
  present: string[];
  missing: string[];
  /** True when the check itself failed. Reported as unknown, never as "installed". */
  degraded: boolean;
}

/**
 * Which of this layer's four tables actually exist on the database it is talking to.
 *
 * WHY THE CONSOLE ASKS AT ALL. SCHEMA_BOOTSTRAP defaults to off in production, so the ensure in
 * schema.ts is a no-op there and these tables appear only when somebody runs
 * db/horizon-governance-schema.sql by hand. Every read in this layer tolerates a missing table and
 * returns nothing, which is the right failure mode for a page and the wrong one for an operator: an
 * empty decision log and an uninstalled decision log look identical. This tells them apart.
 *
 * It reports on this layer's tables only. The hzn_* tables have their own check —
 * verifyHorizonSchema() in src/lib/horizon/schema.ts — and the console shows both, separately,
 * because they are installed separately and either can be missing without the other.
 */
export async function governanceInstallStatus(): Promise<InstallStatus> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const r = rows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ${textIn(GOVERNANCE_TABLES as string[])}`));
    const present = new Set(r.map((x: any) => String(x.table_name)));
    return {
      present: GOVERNANCE_TABLES.filter((t) => present.has(t)),
      missing: GOVERNANCE_TABLES.filter((t) => !present.has(t)),
      degraded: false,
    };
  } catch {
    return { present: [], missing: GOVERNANCE_TABLES.slice(), degraded: true };
  }
}

export interface PublishStatus {
  total: number;
  publishedCount: number;
  missing: string[];
  /** True when the catalogue could not be read. Shown as unknown rather than as "not published". */
  degraded: boolean;
}

/** Which HORIZON keys are already in the catalogue. Read-only; safe to call from a page. */
export async function governancePublishStatus(): Promise<PublishStatus> {
  const total = HORIZON_PERMISSION_KEYS.length;
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const keys = sql.join(HORIZON_PERMISSION_KEYS.map((k) => sql`${k}`), sql`, `);
    const r = rows(await db.execute(sql`SELECT key FROM permission_catalogue WHERE key IN (${keys})`));
    const present = new Set(r.map((x: any) => String(x.key)));
    return {
      total,
      publishedCount: present.size,
      missing: HORIZON_PERMISSION_KEYS.filter((k) => !present.has(k)),
      degraded: false,
    };
  } catch {
    return { total, publishedCount: 0, missing: HORIZON_PERMISSION_KEYS, degraded: true };
  }
}
