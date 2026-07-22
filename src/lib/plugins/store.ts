// src/lib/plugins/store.ts — Block 09: DB layer for per-institution plugin state (self-bootstrapping).
import { PLUGIN_DDL, NIL_INSTITUTION } from './schema';
import { getPlugin } from './registry';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function ensurePluginSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  for (const ddl of PLUGIN_DDL) await db.execute(sql.raw(ddl));
  booted = true;
}

/** Enabled unless an explicit disabled row exists for (institution, plugin). Fail-open to enabled. */
export async function isPluginEnabled(pluginId: string, institutionId: string = NIL_INSTITUTION): Promise<boolean> {
  try {
    await ensurePluginSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT enabled FROM edu_plugin_registry WHERE plugin_id = ${pluginId} AND institution_id = ${institutionId} LIMIT 1`))[0];
    return r ? !!r.enabled : true;
  } catch { return true; }
}

export async function setPluginEnabled(pluginId: string, enabled: boolean, institutionId: string = NIL_INSTITUTION): Promise<void> {
  await ensurePluginSchema(); const { db, sql } = await ctx();
  const version = getPlugin(pluginId)?.version ?? '0.0.0';
  await db.execute(sql`INSERT INTO edu_plugin_registry (institution_id, plugin_id, enabled, version)
    VALUES (${institutionId}, ${pluginId}, ${enabled}, ${version})
    ON CONFLICT (institution_id, plugin_id) DO UPDATE SET enabled = ${enabled}, updated_at = NOW()`);
}

export async function listPluginState(institutionId: string = NIL_INSTITUTION): Promise<Array<{ pluginId: string; enabled: boolean; version: string }>> {
  const { allPlugins } = await import('./registry');
  const overrides = new Map<string, boolean>();
  try {
    await ensurePluginSchema(); const { db, sql } = await ctx();
    for (const r of rows(await db.execute(sql`SELECT plugin_id, enabled FROM edu_plugin_registry WHERE institution_id = ${institutionId}`))) overrides.set(r.plugin_id, !!r.enabled);
  } catch { /* cold DB -> all default-enabled */ }
  return allPlugins().map((p) => ({ pluginId: p.id, enabled: overrides.has(p.id) ? overrides.get(p.id)! : true, version: p.version }));
}
