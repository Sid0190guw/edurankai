// src/lib/knowledge-sync.ts — Knowledge-Delta Synchronization (AES Vol 1). Sync only the CHANGED
// objects (delta from synchronizationState + version), propagate a change through its DEPENDENT
// chain along relationships (equation/formula -> animation -> assessment -> voice -> translations),
// push local dirty up + pull server changes down, and set synchronizationState=conflict when BOTH
// sides changed (never a silent overwrite). Reconciles the objects Prompt 6 enqueues on reconnect.
import type { RelationshipType } from '@/lib/kernel';
import type { ProgressEntry } from '@/lib/offline/manifest-schema';

// Content-dependency relationship types along which a change PROPAGATES. `part_of` is structural
// grouping (siblings in a course) and is intentionally EXCLUDED so unrelated units aren't synced.
export const PROPAGATION_TYPES: RelationshipType[] = ['prerequisite_of', 'assesses', 'references', 'translation_of', 'variant_of'];

export interface Edge { from: string; to: string; type: string }

/** Dependency-aware delta: from the changed ids, include every RELATED object reachable along
 *  propagation edges (both directions). Disconnected (unaffected) objects are never included. */
export function computeDelta(changedIds: string[], edges: Edge[], propagation: string[] = PROPAGATION_TYPES): string[] {
  const prop = new Set(propagation);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of edges) { if (!prop.has(e.type)) continue; link(e.from, e.to); link(e.to, e.from); }
  const seen = new Set<string>(changedIds);
  const queue = [...changedIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of adj.get(id) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return [...seen].sort();
}

// ---- two-way reconcile (per object) ----
export type SyncState = 'synced' | 'dirty' | 'pending' | 'conflict';
export interface LocalMeta { version: number; baseVersion: number; state: SyncState }   // baseVersion = server version the local edit was based on
export interface ServerMeta { version: number }
export type SyncAction = 'none' | 'push' | 'pull' | 'conflict';

/** Decide push/pull/conflict for one object. Conflict = local dirty AND server advanced past base. */
export function reconcile(local: LocalMeta, server: ServerMeta): { action: SyncAction } {
  const dirty = local.state === 'dirty' || local.state === 'pending';
  if (!dirty) return { action: server.version > local.version ? 'pull' : 'none' };
  if (server.version <= local.baseVersion) return { action: 'push' };   // only the local side changed
  return { action: 'conflict' };                                        // BOTH sides changed
}

export type ConflictPolicy = 'server-wins' | 'local-wins' | 'higher-version' | 'last-writer-wins';
export const CONFLICT_POLICIES: ConflictPolicy[] = ['server-wins', 'local-wins', 'higher-version', 'last-writer-wins'];

/** Deterministic conflict resolution. Returns the winner + the new (bumped) version.
 *  `last-writer-wins` compares `updatedAt` (ISO); if either side lacks a clock it falls back
 *  to higher-version so the decision stays deterministic. */
export function resolveConflictDecision(
  local: LocalMeta & { updatedAt?: string },
  server: ServerMeta & { updatedAt?: string },
  policy: ConflictPolicy = 'server-wins',
): { winner: 'server' | 'local'; newVersion: number } {
  let winner: 'server' | 'local';
  if (policy === 'local-wins') winner = 'local';
  else if (policy === 'higher-version') winner = local.version >= server.version ? 'local' : 'server';
  else if (policy === 'last-writer-wins') {
    if (local.updatedAt && server.updatedAt) winner = Date.parse(local.updatedAt) >= Date.parse(server.updatedAt) ? 'local' : 'server';
    else winner = local.version >= server.version ? 'local' : 'server';   // no clock -> higher-version fallback
  } else winner = 'server';
  return { winner, newVersion: Math.max(local.version, server.version) + 1 };
}

/** Monotonic merge of two progress snapshots — progress never regresses, so there is no loser.
 *  timeSpentSec uses max (not sum) to stay idempotent under offline replay (see spec §5.6). */
export function mergeProgress(a: ProgressEntry, b: ProgressEntry): ProgressEntry {
  const maxISO = (x: string, y: string) => (Date.parse(x || '') >= Date.parse(y || '') ? x : y);
  const score = (() => {
    const scores = [a.score, b.score].filter((s): s is number => typeof s === 'number');
    return scores.length ? Math.max(...scores) : undefined;
  })();
  return {
    koId: a.koId,
    completed: !!a.completed || !!b.completed,
    ...(score !== undefined ? { score } : {}),
    timeSpentSec: Math.max(a.timeSpentSec ?? 0, b.timeSpentSec ?? 0),
    updatedAt: maxISO(a.updatedAt, b.updatedAt),
  };
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function ensureSyncSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  // edu_sync_queue exists (Prompt 6); add base_version for conflict detection (additive).
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_sync_queue (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), object_id UUID NOT NULL, state TEXT NOT NULL DEFAULT 'dirty', source TEXT, user_id UUID, resolved BOOLEAN NOT NULL DEFAULT false, enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`ALTER TABLE edu_sync_queue ADD COLUMN IF NOT EXISTS base_version INTEGER`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_sync_audit (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), object_id UUID NOT NULL, action TEXT NOT NULL, from_version INTEGER, to_version INTEGER, resolution TEXT, actor UUID, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_sync_audit_obj_idx ON edu_sync_audit (object_id, at DESC)`));
  booted = true;
}

async function edgesFor(ids: string[]): Promise<Edge[]> {
  if (!ids.length) return [];
  const { db, sql } = await ctx();
  try { return rows(await db.execute(sql`SELECT from_id AS "from", to_id AS "to", type FROM kernel_edges WHERE from_id = ANY(${ids}) OR to_id = ANY(${ids})`)); } catch { return []; }
}

/** The current delta: dirty/pending kernel objects + everything affected along their chain. */
export async function computeServerDelta(): Promise<{ changed: string[]; affected: string[]; objects: any[] }> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  let changed: string[] = [];
  try { changed = rows(await db.execute(sql`SELECT id FROM kernel_objects WHERE synchronization_state <> 'synced'`)).map((r: any) => r.id); } catch { changed = []; }
  // also include anything explicitly enqueued but not yet resolved
  const queued = rows(await db.execute(sql`SELECT DISTINCT object_id FROM edu_sync_queue WHERE resolved = false`)).map((r: any) => r.object_id);
  const seed = [...new Set([...changed, ...queued])];
  const edges = await edgesFor(seed);
  const affected = computeDelta(seed, edges);
  let objects: any[] = [];
  if (affected.length) { try { objects = rows(await db.execute(sql`SELECT id, type, version, synchronization_state FROM kernel_objects WHERE id = ANY(${affected})`)); } catch { objects = []; } }
  return { changed: seed, affected, objects };
}

/** Push local/offline dirty objects up: accept them as server state (synced) + clear the queue. */
export async function pushDirty(objectIds: string[], actor: string | null): Promise<number> {
  if (!objectIds.length) return 0;
  await ensureSyncSchema(); const { db, sql } = await ctx();
  let n = 0;
  for (const id of objectIds) {
    let from: number | null = null;
    try { const r = rows(await db.execute(sql`SELECT version FROM kernel_objects WHERE id = ${id} LIMIT 1`))[0]; from = r ? Number(r.version) : null; await db.execute(sql`UPDATE kernel_objects SET synchronization_state = 'synced' WHERE id = ${id}`); } catch { /* queue-only object */ }
    await db.execute(sql`UPDATE edu_sync_queue SET resolved = true WHERE object_id = ${id} AND resolved = false`);
    await db.execute(sql`INSERT INTO edu_sync_audit (object_id, action, from_version, to_version, actor) VALUES (${id}, 'push', ${from}, ${from}, ${actor})`);
    n++;
  }
  return n;
}

/** Conflicts: queued dirty objects whose server (kernel) version advanced past the queued base. */
export async function detectConflicts(): Promise<{ objectId: string; baseVersion: number | null; serverVersion: number }[]> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  const q = rows(await db.execute(sql`SELECT q.object_id, q.base_version, k.version AS server_version, k.synchronization_state
    FROM edu_sync_queue q JOIN kernel_objects k ON k.id = q.object_id WHERE q.resolved = false`));
  return q.filter((r: any) => r.base_version != null && Number(r.server_version) > Number(r.base_version) || r.synchronization_state === 'conflict')
    .map((r: any) => ({ objectId: r.object_id, baseVersion: r.base_version != null ? Number(r.base_version) : null, serverVersion: Number(r.server_version) }));
}

/** Flag an object as a conflict (both sides changed) — never a silent overwrite. */
export async function flagConflict(objectId: string): Promise<void> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  try { await db.execute(sql`UPDATE kernel_objects SET synchronization_state = 'conflict' WHERE id = ${objectId}`); } catch { /* ignore */ }
  await db.execute(sql`INSERT INTO edu_sync_audit (object_id, action, resolution) VALUES (${objectId}, 'flag-conflict', 'pending')`);
}

/** Resolve a conflict deterministically: bump version, set synced, write audit, clear the queue. */
export async function resolveConflict(objectId: string, policy: ConflictPolicy, actor: string | null): Promise<{ newVersion: number; winner: string }> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  const k = rows(await db.execute(sql`SELECT version FROM kernel_objects WHERE id = ${objectId} LIMIT 1`))[0];
  const q = rows(await db.execute(sql`SELECT base_version FROM edu_sync_queue WHERE object_id = ${objectId} AND resolved = false ORDER BY enqueued_at DESC LIMIT 1`))[0];
  const server: ServerMeta = { version: k ? Number(k.version) : 1 };
  const local: LocalMeta = { version: q?.base_version != null ? Number(q.base_version) : server.version, baseVersion: q?.base_version != null ? Number(q.base_version) : server.version, state: 'conflict' };
  const { winner, newVersion } = resolveConflictDecision(local, server, policy);
  await db.execute(sql`UPDATE kernel_objects SET version = ${newVersion}, synchronization_state = 'synced', updated_at = NOW() WHERE id = ${objectId}`);
  await db.execute(sql`UPDATE edu_sync_queue SET resolved = true WHERE object_id = ${objectId} AND resolved = false`);
  await db.execute(sql`INSERT INTO edu_sync_audit (object_id, action, from_version, to_version, resolution, actor) VALUES (${objectId}, 'resolve', ${server.version}, ${newVersion}, ${winner}, ${actor})`);
  return { newVersion, winner };
}

export async function versionHistory(objectId: string): Promise<any[]> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT action, from_version, to_version, resolution, actor, at FROM edu_sync_audit WHERE object_id = ${objectId} ORDER BY at DESC LIMIT 50`));
}
export async function pendingCount(): Promise<number> {
  await ensureSyncSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue WHERE resolved = false`))[0]?.c || 0;
}

/** Simple sync status for one student (main surface): pending changes + any conflicts. */
export async function userSyncStatus(userId: string): Promise<{ pending: number; conflicts: number }> {
  try {
    await ensureSyncSchema(); const { db, sql } = await ctx();
    const pending = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue WHERE user_id = ${userId} AND resolved = false`))[0]?.c || 0;
    const conflicts = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue q JOIN kernel_objects k ON k.id = q.object_id WHERE q.user_id = ${userId} AND q.resolved = false AND k.synchronization_state = 'conflict'`))[0]?.c || 0;
    return { pending, conflicts };
  } catch { return { pending: 0, conflicts: 0 }; }
}
