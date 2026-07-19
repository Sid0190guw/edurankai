// src/lib/knowledge-graph.ts — Block 02: the concept/unit prerequisite graph.
// Pure, deterministic algorithms over a directed graph where `from -> to` means
// "from is a prerequisite OF to" (from must be learned first). Plus resilient per-request
// DB loaders that read the kernel-bootstrapped kernel_objects/kernel_edges tables. Nothing
// is resident between requests; every call reloads and recomputes.

/** Directed edge: `from` is a prerequisite OF `to`. */
export interface DagEdge { from: string; to: string; }
export interface Dag { nodes: string[]; edges: DagEdge[]; }

export interface TopoResult {
  order: string[];          // prerequisites first; short if a cycle blocks completion
  cycle: string[] | null;   // the offending cycle (x -> … -> x) or null when acyclic
}

// ---- pure algorithms ----

/** Topological order (Kahn). Deterministic: ties broken by lexicographic id. */
export function topoSort(dag: Dag): TopoResult {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!indeg.has(n)) { indeg.set(n, 0); adj.set(n, []); } };
  for (const n of dag.nodes) touch(n);
  for (const e of dag.edges) {
    touch(e.from); touch(e.to);
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const queue = [...indeg.keys()].filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of (adj.get(n) || []).slice().sort()) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) { queue.push(m); queue.sort(); }
    }
  }
  return order.length === indeg.size ? { order, cycle: null } : { order, cycle: findCycle(dag) };
}

/** DFS 3-colouring; returns the actual cycle (x -> … -> x) or null. */
export function findCycle(dag: Dag): string[] | null {
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!adj.has(n)) adj.set(n, []); };
  for (const n of dag.nodes) touch(n);
  for (const e of dag.edges) { touch(e.from); touch(e.to); adj.get(e.from)!.push(e.to); }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>([...adj.keys()].map((n) => [n, WHITE]));
  const stack: string[] = [];
  let found: string[] | null = null;
  const dfs = (u: string): boolean => {
    color.set(u, GRAY); stack.push(u);
    for (const v of (adj.get(u) || []).slice().sort()) {
      if (color.get(v) === GRAY) { found = stack.slice(stack.indexOf(v)).concat(v); return true; }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK); stack.pop(); return false;
  };
  for (const n of [...adj.keys()].sort()) { if (color.get(n) === WHITE && dfs(n)) break; }
  return found;
}

/** Would adding `from -> to` close a cycle? True iff `from` is already reachable from `to`. */
export function wouldCreateCycle(dag: Dag, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of dag.edges) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from)!.push(e.to); }
  const seen = new Set<string>([to]); const q = [to];
  while (q.length) { const u = q.shift()!; if (u === from) return true; for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  return false;
}

/** All transitive prerequisites of `target` (not including target). */
export function prerequisiteClosure(dag: Dag, target: string): string[] {
  const radj = new Map<string, string[]>();               // to -> [prereqs]
  for (const e of dag.edges) { if (!radj.has(e.to)) radj.set(e.to, []); radj.get(e.to)!.push(e.from); }
  const seen = new Set<string>(); const q = [target];
  while (q.length) { const u = q.shift()!; for (const p of radj.get(u) || []) if (!seen.has(p)) { seen.add(p); q.push(p); } }
  return [...seen].sort();
}

/** Nodes learnable right now: not yet mastered, and every prerequisite already mastered. */
export function readyFrontier(dag: Dag, mastered: Set<string>): string[] {
  const preOf = new Map<string, string[]>();
  for (const n of dag.nodes) preOf.set(n, []);
  for (const e of dag.edges) { if (!preOf.has(e.to)) preOf.set(e.to, []); preOf.get(e.to)!.push(e.from); }
  return dag.nodes
    .filter((n) => !mastered.has(n) && (preOf.get(n) || []).every((p) => mastered.has(p)))
    .sort();
}

/** Prerequisite-ordered path to `target`, skipping already-mastered nodes. Throws on a cycle. */
export function learningPath(dag: Dag, target: string, mastered: Set<string> = new Set()): string[] {
  const need = new Set(prerequisiteClosure(dag, target)); need.add(target);
  const sub: Dag = {
    nodes: dag.nodes.filter((n) => need.has(n)),
    edges: dag.edges.filter((e) => need.has(e.from) && need.has(e.to)),
  };
  const { order, cycle } = topoSort(sub);
  if (cycle) throw new Error('prerequisite cycle: ' + cycle.join(' -> '));
  return order.filter((n) => !mastered.has(n));
}

// ---- resilient DB loaders (read the kernel-bootstrapped tables; empty DAG on a cold DB) ----
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function loadPrerequisiteDag(opts: { nodeType?: string; edgeType?: string } = {}): Promise<Dag> {
  const nodeType = opts.nodeType ?? 'ConceptObject';
  const edgeType = opts.edgeType ?? 'prerequisite_of';
  const { db, sql } = await ctx();
  let nodes: string[] = [];
  try {
    nodes = rows(await db.execute(sql`SELECT id FROM kernel_objects WHERE type = ${nodeType} AND lifecycle_state <> 'deleted'`)).map((r: any) => r.id);
  } catch { return { nodes: [], edges: [] }; }   // kernel tables not bootstrapped yet
  const idSet = new Set(nodes);
  let edges: DagEdge[] = [];
  try {
    edges = rows(await db.execute(sql`SELECT from_id AS "from", to_id AS "to" FROM kernel_edges WHERE type = ${edgeType}`))
      .map((r: any) => ({ from: r.from, to: r.to }))
      .filter((e: DagEdge) => idSet.has(e.from) && idSet.has(e.to));   // drop edges to deleted nodes
  } catch { edges = []; }
  return { nodes, edges };
}

/** id -> label. ConceptObject stores its label in data.name, KnowledgeObject in data.title. */
export async function loadNodeLabels(nodeType = 'ConceptObject'): Promise<Map<string, string>> {
  const { db, sql } = await ctx();
  const labels = new Map<string, string>();
  try {
    const r = rows(await db.execute(sql`SELECT id, data FROM kernel_objects WHERE type = ${nodeType} AND lifecycle_state <> 'deleted'`));
    for (const row of r) {
      const d = (row.data ?? {}) as { name?: string; title?: string };
      labels.set(row.id, String(d.name ?? d.title ?? row.id));
    }
  } catch { /* cold DB: no labels */ }
  return labels;
}
