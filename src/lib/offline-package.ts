// src/lib/offline-package.ts — Offline Runtime (AES Vol 1). Compiles an Offline Learning Package
// (selected KnowledgeObjects + composition + knowledge-graph subset + progress), PRE-RENDERED at
// a render tier so the client serves lessons with NO network. A budget-aware planner drops the
// lowest-priority units when over budget. On reconnect, changed objects are marked
// synchronizationState=dirty and ENQUEUED for the Prompt-7 sync engine (no merge here).
import { contentService } from '@/lib/kernel-content';
import { mdLite, latexToHtml } from '@/lib/content-render';
import { resolveDirective, rewriteMedia } from '@/lib/render-policy';
import type { RenderTier } from '@/lib/edu-runtime';

export function byteLen(s: string): number { return new TextEncoder().encode(s).length; }

export interface PlanItem { id: string; title: string; bytes: number; priority: number }
export interface PlanResult { included: string[]; dropped: string[]; totalBytes: number }

/** Budget-aware planner: keep highest-priority units within maxBytes; drop the rest. */
export function planPackage(items: PlanItem[], budget: { maxBytes: number; maxUnits?: number }): PlanResult {
  const sorted = [...items].sort((a, b) => (b.priority - a.priority) || (a.bytes - b.bytes));
  const included: string[] = [], dropped: string[] = [];
  let total = 0;
  for (const it of sorted) {
    const fits = total + it.bytes <= budget.maxBytes && (budget.maxUnits == null || included.length < budget.maxUnits);
    if (fits) { included.push(it.id); total += it.bytes; } else dropped.push(it.id);
  }
  return { included, dropped, totalBytes: total };
}

export interface OfflineUnit { id: string; title: string; bodyHtml: string; equations: { html: string; caption?: string }[]; examples: { promptHtml: string; solutionHtml: string }[]; securityLabels: string[]; bytes: number }
export interface OfflineEdge { from: string; to: string; type: string }
export interface OfflineManifest { version: number; tier: RenderTier; units: OfflineUnit[]; edges: OfflineEdge[]; progress: { koId: string; completed: boolean }[]; unitCount: number; totalBytes: number; droppedUnitIds: string[]; createdAt: string }

/** Pre-render one unit's content at a tier so it can be served offline with no renderer on the client. */
export function prerenderUnit(u: { id: string; data: any; securityLabels?: string[] }, tier: RenderTier): OfflineUnit {
  const d = resolveDirective('KnowledgeObject', tier);
  const bodyHtml = d ? rewriteMedia(mdLite(u.data?.body || ''), d) : mdLite(u.data?.body || '');
  const equations = (Array.isArray(u.data?.equations) ? u.data.equations : []).map((e: any) => ({ html: latexToHtml(e.latex), caption: e.caption }));
  const examples = (Array.isArray(u.data?.examples) ? u.data.examples : []).map((e: any) => ({ promptHtml: mdLite(e.prompt), solutionHtml: mdLite(e.solution) }));
  const unit: OfflineUnit = { id: u.id, title: u.data?.title || '(untitled)', bodyHtml, equations, examples, securityLabels: u.securityLabels || ['public'], bytes: 0 };
  unit.bytes = byteLen(JSON.stringify(unit));
  return unit;
}

/** Assemble + budget-plan a manifest from already-fetched units/edges/progress. Pure + tested. */
export function buildManifest(input: { units: { id: string; data: any; securityLabels?: string[] }[]; edges: OfflineEdge[]; progress: { koId: string; completed: boolean }[]; tier: RenderTier; budget: { maxBytes: number; maxUnits?: number } }): OfflineManifest {
  const rendered = input.units.map((u) => prerenderUnit(u, input.tier));
  const items: PlanItem[] = rendered.map((u, i) => ({ id: u.id, title: u.title, bytes: u.bytes, priority: rendered.length - i }));   // earlier = higher priority
  const plan = planPackage(items, input.budget);
  const keep = new Set(plan.included);
  const units = rendered.filter((u) => keep.has(u.id));
  const edges = input.edges.filter((e) => keep.has(e.from) || keep.has(e.to));
  const progress = input.progress.filter((p) => keep.has(p.koId));
  return { version: 1, tier: input.tier, units, edges, progress, unitCount: units.length, totalBytes: plan.totalBytes, droppedUnitIds: plan.dropped, createdAt: new Date().toISOString() };
}

/** Serve a packaged unit OFFLINE from the manifest (no network). Returns the pre-rendered unit. */
export function renderOfflineUnit(manifest: OfflineManifest, unitId: string): OfflineUnit | null {
  return manifest.units.find((u) => u.id === unitId) || null;
}

// changed-object -> sync-queue entry (what reconnect enqueues for Prompt 7). Pure.
export interface LocalChange { objectId: string; kind: 'progress' | 'content'; at: string }
export function dirtyOnReconnect(changes: LocalChange[]): { objectId: string; state: 'dirty' | 'pending' }[] {
  const seen = new Set<string>(); const out: { objectId: string; state: 'dirty' | 'pending' }[] = [];
  for (const c of changes) { if (seen.has(c.objectId)) continue; seen.add(c.objectId); out.push({ objectId: c.objectId, state: 'dirty' }); }
  return out;
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;   // 8 MB default offline budget (low-end friendly)

export async function ensureOfflineSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_offline_packages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, tier TEXT NOT NULL DEFAULT 'lite', unit_count INTEGER NOT NULL DEFAULT 0, bytes BIGINT NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, manifest JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_offline_pkg_user_idx ON edu_offline_packages (user_id, created_at DESC)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_sync_queue (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), object_id UUID NOT NULL, state TEXT NOT NULL DEFAULT 'dirty', source TEXT, user_id UUID, resolved BOOLEAN NOT NULL DEFAULT false, enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_sync_queue_open_idx ON edu_sync_queue (resolved, enqueued_at)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_offline_policy (id INTEGER PRIMARY KEY DEFAULT 1, max_bytes BIGINT NOT NULL DEFAULT ${DEFAULT_MAX_BYTES}, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}

export async function getPolicy(): Promise<{ maxBytes: number }> {
  try { await ensureOfflineSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT max_bytes FROM edu_offline_policy WHERE id = 1 LIMIT 1`))[0];
    return { maxBytes: r ? Number(r.max_bytes) : DEFAULT_MAX_BYTES };
  } catch { return { maxBytes: DEFAULT_MAX_BYTES }; }
}
export async function setPolicy(maxBytes: number): Promise<void> {
  await ensureOfflineSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_offline_policy (id, max_bytes) VALUES (1, ${maxBytes}) ON CONFLICT (id) DO UPDATE SET max_bytes = ${maxBytes}, updated_at = NOW()`);
}

/** Compile + persist an offline package for a user from selected kernel unit ids. */
export async function compileForUser(userId: string | null, unitIds: string[], tier: RenderTier = 'lite', maxBytesOverride?: number): Promise<OfflineManifest> {
  const svc = contentService();
  const policy = await getPolicy();
  const budget = { maxBytes: maxBytesOverride && maxBytesOverride > 0 ? maxBytesOverride : policy.maxBytes };
  const units: { id: string; data: any; securityLabels?: string[] }[] = [];
  const edges: OfflineEdge[] = [];
  for (const id of unitIds) {
    const v = await svc.getUnitView(id).catch(() => null);
    if (!v || v.unit.lifecycleState !== 'published') continue;
    units.push({ id: v.unit.id, data: v.unit.data, securityLabels: (v.unit as any).securityLabels });
    for (const p of v.prerequisites) edges.push({ from: p.id, to: v.unit.id, type: 'prerequisite_of' });
  }
  let progress: { koId: string; completed: boolean }[] = [];
  if (userId) { try { await import('@/lib/edu-runtime').then((m) => m.ensureRuntimeSchema()); const { db, sql } = await ctx();
    progress = rows(await db.execute(sql`SELECT ko_id AS "koId", completed FROM edu_progress WHERE user_id = ${userId} AND ko_id = ANY(${unitIds})`)).map((r: any) => ({ koId: r.koId, completed: !!r.completed }));
  } catch { /* progress optional */ } }

  const manifest = buildManifest({ units, edges, progress, tier, budget });
  try { await ensureOfflineSchema(); const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_offline_packages (user_id, tier, unit_count, bytes, dropped, manifest) VALUES (${userId}, ${tier}, ${manifest.unitCount}, ${manifest.totalBytes}, ${manifest.droppedUnitIds.length}, ${JSON.stringify(manifest)}::jsonb)`);
  } catch { /* record is best-effort */ }
  return manifest;
}

/** Reconnect: mark changed objects dirty + enqueue them for the sync engine (Prompt 7). */
export async function enqueueDirty(objectIds: string[], userId: string | null, source = 'offline'): Promise<number> {
  if (!objectIds.length) return 0;
  await ensureOfflineSchema(); const { db, sql } = await ctx();
  let n = 0;
  for (const id of objectIds) {
    await db.execute(sql`INSERT INTO edu_sync_queue (object_id, state, source, user_id) VALUES (${id}, 'dirty', ${source}, ${userId})`);
    try { await db.execute(sql`UPDATE kernel_objects SET synchronization_state = 'dirty' WHERE id = ${id}`); } catch { /* not a kernel object -> queue entry still recorded */ }
    n++;
  }
  return n;
}

export async function listPackages(limit = 50): Promise<any[]> {
  await ensureOfflineSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT p.id, p.user_id, p.tier, p.unit_count, p.bytes, p.dropped, p.created_at, u.name AS user_name FROM edu_offline_packages p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT ${limit}`));
}
export async function queueDepth(): Promise<number> {
  await ensureOfflineSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM edu_sync_queue WHERE resolved = false`))[0]?.c || 0;
}
