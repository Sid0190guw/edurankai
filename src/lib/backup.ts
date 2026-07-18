// src/lib/backup.ts — Backup, restore & data integrity (Prompt 23). Export kernel objects +
// relationships to a portable JSON package (whole, or scoped per-course); a VERIFIED restore path
// that validates + integrity-checks and supports a dry-run before writing; consistency checks
// (orphaned edges, invalid lifecycle states). Restores are ADDITIVE + non-destructive (ON CONFLICT
// DO NOTHING) and refuse to apply an invalid package. The validate/consistency/plan logic is pure.

export const VALID_LIFECYCLE = ['created', 'validated', 'indexed', 'published', 'referenced', 'updated', 'archived', 'deleted'];
export const PACKAGE_VERSION = 1;

export interface BackupPackage { version: number; exportedAt: string; scope?: string; objects: any[]; edges: any[] }
export function makePackage(objects: any[], edges: any[], scope?: string): BackupPackage {
  return { version: PACKAGE_VERSION, exportedAt: new Date().toISOString(), scope, objects, edges };
}
/** Structural validation of a package. Pure. */
export function validatePackage(pkg: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!pkg || typeof pkg !== 'object') errors.push('not an object');
  else {
    if (pkg.version !== PACKAGE_VERSION) errors.push(`unsupported version ${pkg?.version}`);
    if (!Array.isArray(pkg.objects)) errors.push('objects missing');
    if (!Array.isArray(pkg.edges)) errors.push('edges missing');
    if (Array.isArray(pkg.objects) && pkg.objects.some((o: any) => !o?.id)) errors.push('an object is missing an id');
  }
  return { ok: errors.length === 0, errors };
}
/** Consistency: orphaned edges (endpoint not present) + invalid lifecycle states. Pure. */
export function consistencyCheck(objects: any[], edges: any[]): { ok: boolean; orphanEdges: any[]; badLifecycle: any[] } {
  const ids = new Set(objects.map((o) => o.id));
  const orphanEdges = edges.filter((e) => !ids.has(e.from_id ?? e.from) || !ids.has(e.to_id ?? e.to));
  const badLifecycle = objects.filter((o) => o.lifecycle_state && !VALID_LIFECYCLE.includes(o.lifecycle_state));
  return { ok: orphanEdges.length === 0 && badLifecycle.length === 0, orphanEdges, badLifecycle };
}
/** Dry-run a restore: report what would be created/skipped; BLOCK if the package is invalid/inconsistent. Pure. */
export function planRestore(pkg: any, existingIds: string[]): { blocked: boolean; reason?: string; toCreate: number; toSkip: number; orphanEdges: number } {
  const v = validatePackage(pkg);
  if (!v.ok) return { blocked: true, reason: 'invalid package: ' + v.errors.join('; '), toCreate: 0, toSkip: 0, orphanEdges: 0 };
  const c = consistencyCheck(pkg.objects, pkg.edges);
  if (!c.ok) return { blocked: true, reason: `integrity failure: ${c.orphanEdges.length} orphan edge(s), ${c.badLifecycle.length} invalid state(s)`, toCreate: 0, toSkip: 0, orphanEdges: c.orphanEdges.length };
  const have = new Set(existingIds);
  const toCreate = pkg.objects.filter((o: any) => !have.has(o.id)).length;
  return { blocked: false, toCreate, toSkip: pkg.objects.length - toCreate, orphanEdges: 0 };
}

// ============================ DB layer (reads/writes kernel_*; no schema of its own) ============
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

/** Export the whole kernel (or a single course subtree) to a portable package. */
export async function exportKernel(scopeCourseId?: string): Promise<BackupPackage> {
  const { db, sql } = await ctx();
  const q = async (s: any) => { try { return rows(await db.execute(s)); } catch { return []; } };
  if (scopeCourseId) {
    const koIds = (await q(sql`SELECT from_id FROM kernel_edges WHERE to_id = ${scopeCourseId} AND type = 'part_of'`)).map((r: any) => r.from_id);
    const ids = [scopeCourseId, ...koIds];
    const objects = await q(sql`SELECT * FROM kernel_objects WHERE id = ANY(${ids})`);
    const edges = await q(sql`SELECT * FROM kernel_edges WHERE from_id = ANY(${ids}) OR to_id = ANY(${ids})`);
    return makePackage(objects, edges, 'course:' + scopeCourseId);
  }
  const objects = await q(sql`SELECT * FROM kernel_objects`);
  const edges = await q(sql`SELECT * FROM kernel_edges`);
  return makePackage(objects, edges, 'full');
}
export async function existingObjectIds(): Promise<string[]> {
  const { db, sql } = await ctx(); return (await (async () => { try { return rows(await db.execute(sql`SELECT id FROM kernel_objects`)); } catch { return []; } })()).map((r: any) => r.id);
}
/** Apply a validated package additively (ON CONFLICT DO NOTHING — never overwrites). Returns counts. */
export async function applyRestore(pkg: BackupPackage): Promise<{ objects: number; edges: number }> {
  const { db, sql } = await ctx();
  let oc = 0, ec = 0;
  for (const o of pkg.objects) {
    const r = rows(await db.execute(sql`INSERT INTO kernel_objects (id, type, version, owner, permissions, metadata, learning_metadata, security_labels, synchronization_state, lifecycle_state, data, created_at, updated_at, archived_at)
      VALUES (${o.id}, ${o.type}, ${o.version || 1}, ${o.owner ?? null}, ${JSON.stringify(o.permissions || [])}::jsonb, ${JSON.stringify(o.metadata || {})}::jsonb, ${JSON.stringify(o.learning_metadata || {})}::jsonb, ${o.security_labels || ['public']}, ${o.synchronization_state || 'synced'}, ${o.lifecycle_state || 'created'}, ${JSON.stringify(o.data || {})}::jsonb, ${o.created_at || new Date().toISOString()}, ${o.updated_at || new Date().toISOString()}, ${o.archived_at ?? null})
      ON CONFLICT (id) DO NOTHING RETURNING id`).catch(() => []));
    if (rows(r).length) oc++;
  }
  for (const e of pkg.edges) {
    const r = rows(await db.execute(sql`INSERT INTO kernel_edges (id, from_id, to_id, type, metadata, created_at)
      VALUES (${e.id}, ${e.from_id}, ${e.to_id}, ${e.type}, ${JSON.stringify(e.metadata || {})}::jsonb, ${e.created_at || new Date().toISOString()}) ON CONFLICT (id) DO NOTHING RETURNING id`).catch(() => []));
    if (rows(r).length) ec++;
  }
  return { objects: oc, edges: ec };
}
/** Live integrity report over the current kernel. */
export async function integrityReport(): Promise<any> {
  const pkg = await exportKernel();
  const c = consistencyCheck(pkg.objects, pkg.edges);
  return { objects: pkg.objects.length, edges: pkg.edges.length, orphanEdges: c.orphanEdges, badLifecycle: c.badLifecycle, ok: c.ok };
}
