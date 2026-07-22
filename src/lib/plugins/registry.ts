// src/lib/plugins/registry.ts — Block 09: the static plugin catalog + the "Runtime Bootstrap
// Engine" (manifest validation + capability registration + dependency DAG). Pure at load
// (no db import); bootstrapPlugins() memoizes per cold start.
import { registerCapability } from '@/lib/rbac/capabilities';
import { resolveDirective } from '@/lib/render-policy';
import type { RenderTier } from '@/lib/edu-runtime';
import type { SubjectPlugin, AssessmentGenerator } from './types';
import { physicsPlugin } from './subjects/physics';
import { chemistryPlugin } from './subjects/chemistry';
import { programmingPlugin } from './subjects/programming';

export const SUBJECT_PLUGINS: SubjectPlugin[] = [physicsPlugin, chemistryPlugin, programmingPlugin];

let booted = false;
let byId = new Map<string, SubjectPlugin>();
let bootOrder: string[] = [];

/** Kahn topological order over dependsOn. Pure; exported for testing. Returns order=[] on a cycle. */
export function topoSortPlugins(plugins: SubjectPlugin[]): { order: string[]; issues: string[] } {
  const issues: string[] = [];
  const ids = new Map(plugins.map((p) => [p.id, p]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const p of plugins) { indeg.set(p.id, 0); adj.set(p.id, []); }
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      if (!ids.has(dep)) { issues.push(`${p.id} depends on missing ${dep}`); continue; }
      adj.get(dep)!.push(p.id);
      indeg.set(p.id, indeg.get(p.id)! + 1);
    }
  }
  const queue = plugins.filter((p) => indeg.get(p.id) === 0).map((p) => p.id).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of (adj.get(n) ?? []).slice().sort()) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) { queue.push(m); queue.sort(); }
    }
  }
  if (order.length !== plugins.length) {
    issues.push('dependency cycle among: ' + plugins.filter((p) => (indeg.get(p.id) ?? 0) > 0).map((p) => p.id).join(','));
    return { order: [], issues };
  }
  return { order, issues };
}

/** Validate the catalog, register capabilities, order by dependency. Idempotent per cold start. */
export function bootstrapPlugins(catalog: SubjectPlugin[] = SUBJECT_PLUGINS): { order: string[]; issues: string[] } {
  if (booted) return { order: bootOrder, issues: [] };
  const issues: string[] = [];
  const seen = new Map<string, SubjectPlugin>();
  for (const p of catalog) {
    if (seen.has(p.id)) { issues.push(`duplicate plugin id ${p.id}`); continue; }
    seen.set(p.id, p);
    for (const cap of p.requiredCapabilities) registerCapability(cap);
    registerCapability(`plugin.${p.id}`);
  }
  const { order, issues: topoIssues } = topoSortPlugins([...seen.values()]);
  issues.push(...topoIssues);
  byId = seen;
  bootOrder = order;
  booted = true;
  return { order, issues };
}

function ensureBooted() { if (!booted) bootstrapPlugins(); }

export function getPlugin(id: string): SubjectPlugin | undefined { ensureBooted(); return byId.get(id); }
export function allPlugins(): SubjectPlugin[] { ensureBooted(); return [...byId.values()]; }

/** Longest-prefix concept-domain match. 'physics.fluids.bernoulli' -> physics. */
export function pluginForConcept(domain: string): SubjectPlugin | undefined {
  ensureBooted();
  let best: SubjectPlugin | undefined; let bestLen = -1;
  for (const p of byId.values()) {
    for (const owned of p.conceptDomains) {
      if ((domain === owned || domain.startsWith(owned + '.')) && owned.length > bestLen) { best = p; bestLen = owned.length; }
    }
  }
  return best;
}

export function resolveAssessmentGenerator(conceptDomain: string): AssessmentGenerator | undefined {
  const p = pluginForConcept(conceptDomain);
  if (!p) return undefined;
  // most-specific conceptDomain prefix on the owning plugin wins
  let best: AssessmentGenerator | undefined; let bestLen = -1;
  for (const g of p.assessmentGenerators) {
    if ((conceptDomain === g.conceptDomain || conceptDomain.startsWith(g.conceptDomain)) && g.conceptDomain.length > bestLen) { best = g.generate; bestLen = g.conceptDomain.length; }
  }
  return best ?? p.assessmentGenerators[0]?.generate;
}

/** base render-policy hydrate ∪ the plugin's extra hydrate for (objectType, tier). */
export function resolveHydrate(objectType: string, tier: RenderTier, pluginId?: string): string[] {
  const base = resolveDirective(objectType, tier).hydrate;
  if (!pluginId) return base;
  const p = getPlugin(pluginId);
  if (!p) return base;
  const extra: string[] = [];
  for (const r of p.renderers) if (r.objectType === objectType) extra.push(...(r.hydrate[tier] ?? []));
  return [...new Set([...base, ...extra])];
}

/** Union of every enabled plugin's scene-pack primitive names. */
export function scenePrimitiveTypes(): string[] {
  ensureBooted();
  const set = new Set<string>();
  for (const p of byId.values()) for (const pack of p.scenePacks ?? []) for (const t of pack.primitiveTypes) set.add(t);
  return [...set].sort();
}

// test-only: reset the memoized boot state so a test can bootstrap a synthetic catalog.
export function __resetPluginsForTest(): void { booted = false; byId = new Map(); bootOrder = []; }
