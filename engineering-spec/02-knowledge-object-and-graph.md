# Engineering Block 02 — Knowledge Object & Knowledge Graph

| Field | Value |
|---|---|
| **Spec source** | Vol 1–2 pp 6–13, 46–56 — "Update Knowledge Graph", "Knowledge Synchronization" (delta), "Plugin Runtime", "Offline Learning Package → Knowledge Graph"; block focus list: KnowledgeObject contents (Concept, Prerequisites, Equations, Examples, Animations, Laboratories, Research, Industry, Assessments, Translations, Accessibility Variants) + the concept Knowledge Graph with prerequisite relationships |
| **Repo target** | Extend `src/lib/kernel/types.ts`, `src/lib/kernel/validation.ts`; **new** `src/lib/knowledge-graph.ts` (pure DAG algorithms + DB loader); extend `src/lib/kernel-content.ts` (`ContentService.addPrerequisite` cycle guard, concept authoring); **new** `src/pages/api/aquintutor/knowledge-graph.ts` and `src/pages/api/aquintutor/knowledge-path.ts`; wire the real graph into `src/pages/aquintutor/knowledge-graph.astro` |
| **Status** | partial — object store, `kernel_objects`/`kernel_edges`, KnowledgeObject payload, edge-based composition, and the authoring service already exist; the **concept-graph query module (topological order, cycle detection, learning path, ready frontier)** is greenfield |
| **Depends on** | Block 01 — Kernel Object Store, Lifecycle & Edges (`src/lib/kernel/*`); RBAC (`src/lib/rbac` `can()`) for authoring capability gates; Block 06 — Knowledge-Delta Sync (`src/lib/knowledge-sync.ts`) reuses the same edges |

---

## 1. Purpose

Store every teaching unit and concept as a typed object in the existing `kernel_objects` table (`KnowledgeObject` / `ConceptObject`), with its Concept / Prerequisites / Animations / Laboratories / Research / Assessments / Translations / Accessibility Variants expressed as typed rows in `kernel_edges`, and its inline scholarly content (Equations, Examples, Industry links, body) in the object's `data` JSONB. On top of those edges, provide a deterministic knowledge-graph query module that treats `prerequisite_of` edges as a directed acyclic graph and computes topological order, cycle detection (rejecting any prerequisite that would close a loop), transitive prerequisite closure, the "ready to learn now" frontier for a given mastered set, and a prerequisite-ordered learning path to any target concept. All graph work is pure and per-request; nothing is resident in memory between requests.

---

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `kernel_objects` / `kernel_edges` tables + self-bootstrap DDL — `src/lib/kernel/schema.ts` (`KERNEL_DDL`, `PgKernelStore.ensure()` in `store.ts`).
- Object types `KnowledgeObject`, `ConceptObject` and relationship types `prerequisite_of`, `part_of`, `assesses`, `references`, `translation_of`, `variant_of` — `src/lib/kernel/types.ts` (`OBJECT_TYPES`, `RELATIONSHIP_TYPES`).
- `KnowledgeObjectData` payload (title, body, equations, examples, industry, conceptId) + `Equation` / `WorkedExample` — `types.ts`; Zod validation — `validation.ts` (`DATA_SCHEMAS.KnowledgeObject`).
- Edge-based composition of a KnowledgeObject — `KernelRepository.buildKnowledgeObject()` in `src/lib/kernel/repository.ts` already wires prerequisites/assessments/references/translations/accessibility/concept as edges.
- Authoring service (create/edit/attach/prereq/publish over the real lifecycle) — `src/lib/kernel-content.ts` (`ContentService`, `contentService()`), exposed by `POST /api/admin/knowledge.ts` with `can()` capability gates.
- Delta sync that already walks `kernel_edges` (BFS) — `src/lib/knowledge-sync.ts` (`computeDelta`, `PROPAGATION_TYPES`).
- Student-facing graph UI (currently a **hardcoded client-side** DAG) — `src/pages/aquintutor/knowledge-graph.astro` + `public/aquin-curriculum.js`.
- DB access convention — `src/lib/db/index.ts` exports `db` with `execute` typed `any` (called as `db.execute(sql\`…\`)`); the `rows(r) => Array.isArray(r) ? r : (r?.rows || [])` normalizer is a **per-file local helper** (defined in `store.ts` / `knowledge-sync.ts`, not exported from `db`) and is re-declared in the new module (§5.5).

**Build / extend in this block:**
- Add relationship type `related_to` to `RELATIONSHIP_TYPES` (spec's "related" links between concepts; non-blocking, excluded from the DAG).
- Extend `KnowledgeObjectData` with optional `objectives` and `laboratories`/`animations`/`research` are edges (documented mapping table in §3) — keep inline set minimal.
- **New pure module** `src/lib/knowledge-graph.ts`: `topoSort`, `findCycle`, `wouldCreateCycle`, `prerequisiteClosure`, `readyFrontier`, `learningPath`, plus a resilient DB loader `loadPrerequisiteDag()` (reads the kernel-bootstrapped tables; returns an empty DAG on a cold DB) and `loadNodeLabels()`.
- Add a cycle guard to `ContentService.addPrerequisite` and a concept-authoring pair (`ensureConcept`, `addConceptPrerequisite`).
- **New read APIs** `GET /api/aquintutor/knowledge-graph` and `GET /api/aquintutor/knowledge-path`.
- Replace the hardcoded `NODES`/`EDGES` in `knowledge-graph.astro` with a fetch of the real graph.

---

## 3. Data model

### 3.1 KnowledgeObject content → storage mapping

| Spec content | Storage | Direction / type |
|---|---|---|
| Concept | inline `data.conceptId` + edge | `KnowledgeObject —part_of→ ConceptObject` |
| Prerequisites | edge | `prereq —prerequisite_of→ this` |
| Equations | inline | `data.equations: Equation[]` |
| Examples | inline | `data.examples: WorkedExample[]` |
| Industry | inline | `data.industry: string[]` |
| Animations | edge | `this —references→ AnimationObject` |
| Laboratories | edge | `this —references→ LaboratoryObject` |
| Research | edge | `this —references→ ResearchObject` |
| Assessments | edge | `AssessmentObject —assesses→ this` |
| Translations | edge | `translation —translation_of→ this` |
| Accessibility Variants | edge | `variant —variant_of→ this` |
| Related (non-prereq) | edge | `this —related_to→ ConceptObject/KnowledgeObject` |

### 3.2 Extend `src/lib/kernel/types.ts`

```ts
// add to RELATIONSHIP_TYPES:
export const RELATIONSHIP_TYPES = [
  'prerequisite_of', 'part_of', 'assesses', 'references',
  'translation_of', 'variant_of', 'related_to',   // ← new: soft "see also" link, NOT in the DAG
] as const;

// extend the inline payload (all optional → backwards compatible with existing rows):
export interface KnowledgeObjectData {
  conceptId?: string | null;   // -> ConceptObject (mirrored as a part_of edge)
  title: string;
  body?: string;
  objectives?: string[];       // NEW: learning objectives (inline)
  equations?: Equation[];
  examples?: WorkedExample[];
  industry?: string[];
}
```

### 3.3 Extend `src/lib/kernel/validation.ts`

```ts
KnowledgeObject: z.object({
  conceptId: z.string().nullable().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  objectives: z.array(z.string()).optional(),   // NEW
  equations: z.array(equation).optional(),
  examples: z.array(example).optional(),
  industry: z.array(z.string()).optional(),
}),
```

No new tables and no schema migration: `related_to` is just a `text` value in `kernel_edges.type`; the loader filters by type. Everything is additive.

### 3.4 Graph value types (in `src/lib/knowledge-graph.ts`)

```ts
/** Directed edge: `from` is a prerequisite OF `to` (from must be learned before to). */
export interface DagEdge { from: string; to: string; }
export interface Dag { nodes: string[]; edges: DagEdge[]; }

export interface TopoResult {
  order: string[];          // prerequisites first; empty tail if a cycle blocks completion
  cycle: string[] | null;   // the offending cycle (…-> x -> … -> x) or null if the DAG is valid
}
```

---

## 4. Interfaces & API contracts

### 4.1 Pure graph module — `src/lib/knowledge-graph.ts`

```ts
export function topoSort(dag: Dag): TopoResult;
export function findCycle(dag: Dag): string[] | null;
export function wouldCreateCycle(dag: Dag, from: string, to: string): boolean;
export function prerequisiteClosure(dag: Dag, target: string): string[];   // all transitive prereqs of target
export function readyFrontier(dag: Dag, mastered: Set<string>): string[];   // learnable now, not yet mastered
export function learningPath(dag: Dag, target: string, mastered?: Set<string>): string[];  // prereq-ordered

/** DB loader: read the prerequisite DAG for a node type from kernel_objects/kernel_edges. */
export function loadPrerequisiteDag(opts?: {
  nodeType?: 'ConceptObject' | 'KnowledgeObject';   // default 'ConceptObject'
  edgeType?: 'prerequisite_of';                     // default 'prerequisite_of'
}): Promise<Dag>;

/** Node labels for the UI (id -> title/name), same lifecycle filter as the loader. */
export function loadNodeLabels(nodeType?: string): Promise<Map<string, string>>;
```

### 4.2 Authoring extension — `src/lib/kernel-content.ts`

```ts
// ConceptService additions on ContentService:
async ensureConcept(name: string, description?: string): Promise<KernelObject>;      // idempotent by name
async addConceptPrerequisite(conceptId: string, prerequisiteConceptId: string): Promise<void>; // cycle-guarded

// hardened existing method (adds the guard; signature unchanged):
async addPrerequisite(unitId: string, prerequisiteUnitId: string): Promise<void>;    // throws on self/cycle
```

### 4.3 API endpoints

```
GET /api/aquintutor/knowledge-graph?nodeType=ConceptObject&mastered=<id,id,…>
  → 200 {
      ok: true,
      nodes: { id: string; label: string }[],
      edges: { from: string; to: string }[],
      order: string[],                       // topological (prerequisites first)
      cycle: string[] | null,                // non-null ⇒ graph is inconsistent, order is partial
      ready: string[]                         // frontier for the mastered set (empty if no ?mastered)
    }
  → 401 { ok:false } when unauthenticated

GET /api/aquintutor/knowledge-path?target=<id>&mastered=<id,id,…>&nodeType=ConceptObject
  → 200 { ok:true, path: string[], labels: Record<string,string> }   // prereq-ordered, mastered removed
  → 400 { ok:false, error }   // missing target, or a cycle blocks the path
  → 404 { ok:false, error }   // target not in graph

// authoring (existing route, one new guarded outcome — field names match the live route):
POST /api/admin/knowledge  { action:'addPrerequisite', unitId, prerequisiteUnitId }
  → 409 { ok:false, error:'would create a prerequisite cycle' }   // NEW rejection (self-prereq is already 400)
```

Endpoints follow the repo's `json()` helper + `APIRoute` + `locals.user` pattern (see `src/pages/api/2fa/confirm.ts`). Reads require a signed-in user; writes go through `can(user, cap, { type:'KnowledgeObject' })` exactly as `api/admin/knowledge.ts` already does.

---

## 5. Core logic / algorithms

### 5.1 Topological order — Kahn's algorithm (deterministic)

```ts
export function topoSort(dag: Dag): TopoResult {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const touch = (n: string) => { if (!indeg.has(n)) { indeg.set(n, 0); adj.set(n, []); } };
  for (const n of dag.nodes) touch(n);
  for (const e of dag.edges) {
    touch(e.from); touch(e.to);
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);          // to depends on one more prereq
  }
  // seed queue with prereq-free nodes; keep sorted for a stable, reproducible order
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
  return order.length === indeg.size
    ? { order, cycle: null }
    : { order, cycle: findCycle(dag) };             // fewer emitted ⇒ a cycle exists
}
```

### 5.2 Cycle detection — DFS 3-colouring (returns the actual cycle)

```ts
export function findCycle(dag: Dag): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes) adj.set(n, []);
  for (const e of dag.edges) { if (!adj.has(e.from)) adj.set(e.from, []); if (!adj.has(e.to)) adj.set(e.to, []); adj.get(e.from)!.push(e.to); }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>([...adj.keys()].map((n) => [n, WHITE]));
  const stack: string[] = [];
  let found: string[] | null = null;
  const dfs = (u: string): boolean => {
    color.set(u, GRAY); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) { found = stack.slice(stack.indexOf(v)).concat(v); return true; }  // back-edge
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK); stack.pop(); return false;
  };
  for (const n of [...adj.keys()].sort()) { if (color.get(n) === WHITE && dfs(n)) break; }
  return found;
}
```

### 5.3 Guard before inserting a prerequisite edge

Adding `from —prerequisite_of→ to` closes a cycle **iff** `from` is already reachable from `to`. Cheaper than a full re-sort:

```ts
export function wouldCreateCycle(dag: Dag, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of dag.edges) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from)!.push(e.to); }
  const seen = new Set<string>([to]); const q = [to];
  while (q.length) { const u = q.shift()!; if (u === from) return true; for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  return false;
}
```

`ContentService.addPrerequisite` / `addConceptPrerequisite`:
1. `dag = await loadPrerequisiteDag({ nodeType })`.
2. If `wouldCreateCycle(dag, prerequisiteId, targetId)` → `throw new Error('would create a prerequisite cycle')` (endpoint maps to 409).
3. Else `repo.addRelationship(prerequisiteId, 'prerequisite_of', targetId)`.

### 5.4 Closure, ready frontier, learning path

```ts
export function prerequisiteClosure(dag: Dag, target: string): string[] {
  const radj = new Map<string, string[]>();                 // to -> [prereqs]
  for (const e of dag.edges) { if (!radj.has(e.to)) radj.set(e.to, []); radj.get(e.to)!.push(e.from); }
  const seen = new Set<string>(); const q = [target];
  while (q.length) { const u = q.shift()!; for (const p of radj.get(u) || []) if (!seen.has(p)) { seen.add(p); q.push(p); } }
  return [...seen];
}

export function readyFrontier(dag: Dag, mastered: Set<string>): string[] {
  const preOf = new Map<string, string[]>();
  for (const n of dag.nodes) preOf.set(n, []);
  for (const e of dag.edges) { if (!preOf.has(e.to)) preOf.set(e.to, []); preOf.get(e.to)!.push(e.from); }
  return dag.nodes
    .filter((n) => !mastered.has(n) && (preOf.get(n) || []).every((p) => mastered.has(p)))
    .sort();
}

export function learningPath(dag: Dag, target: string, mastered: Set<string> = new Set()): string[] {
  const need = new Set(prerequisiteClosure(dag, target)); need.add(target);
  const sub: Dag = {
    nodes: dag.nodes.filter((n) => need.has(n)),
    edges: dag.edges.filter((e) => need.has(e.from) && need.has(e.to)),
  };
  const { order, cycle } = topoSort(sub);
  if (cycle) throw new Error('prerequisite cycle: ' + cycle.join(' -> '));
  return order.filter((n) => !mastered.has(n));   // skip what the student already knows
}
```

### 5.5 DB loader (resilient, `db.execute` + `rows()` convention)

The kernel tables are bootstrapped by `PgKernelStore.ensure()` on the first content write, not by this read-only module. So the loader guards its reads exactly like `knowledge-sync.edgesFor`: on a cold DB (no content authored yet, tables absent) it returns an empty DAG instead of throwing.

```ts
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function loadPrerequisiteDag(opts: { nodeType?: string; edgeType?: string } = {}): Promise<Dag> {
  const nodeType = opts.nodeType ?? 'ConceptObject';
  const edgeType = opts.edgeType ?? 'prerequisite_of';
  const { db, sql } = await ctx();
  let nodes: string[] = [];
  try {
    nodes = rows(await db.execute(
      sql`SELECT id FROM kernel_objects WHERE type = ${nodeType} AND lifecycle_state <> 'deleted'`
    )).map((r: any) => r.id);
  } catch { return { nodes: [], edges: [] }; }   // kernel tables not bootstrapped yet
  const idSet = new Set(nodes);
  let edges: DagEdge[] = [];
  try {
    edges = rows(await db.execute(
      sql`SELECT from_id AS "from", to_id AS "to" FROM kernel_edges WHERE type = ${edgeType}`
    )).map((r: any) => ({ from: r.from, to: r.to }))
      .filter((e: DagEdge) => idSet.has(e.from) && idSet.has(e.to));   // drop dangling edges to deleted nodes
  } catch { edges = []; }
  return { nodes, edges };
}

/** Node labels for the UI (id -> label). ConceptObject stores its label in `data.name`,
 *  KnowledgeObject in `data.title`; fall back to the id. Same non-deleted filter as the loader. */
export async function loadNodeLabels(nodeType = 'ConceptObject'): Promise<Map<string, string>> {
  const { db, sql } = await ctx();
  const labels = new Map<string, string>();
  try {
    const r = rows(await db.execute(
      sql`SELECT id, data FROM kernel_objects WHERE type = ${nodeType} AND lifecycle_state <> 'deleted'`
    ));
    for (const row of r) {
      const d = (row.data ?? {}) as { name?: string; title?: string };
      labels.set(row.id, String(d.name ?? d.title ?? row.id));
    }
  } catch { /* cold DB: no labels */ }
  return labels;
}
```

### 5.6 Endpoint flow (`GET /api/aquintutor/knowledge-graph`)

1. Require `locals.user` → else 401.
2. `nodeType = query.nodeType ?? 'ConceptObject'` (validate against allow-list).
3. `dag = await loadPrerequisiteDag({ nodeType })`.
4. `{ order, cycle } = topoSort(dag)`.
5. `mastered = new Set((query.mastered ?? '').split(',').filter(Boolean))`; `ready = mastered.size ? readyFrontier(dag, mastered) : []`.
6. `labels = await loadNodeLabels(nodeType)`; map nodes → `{ id, label }`.
7. Return `{ ok:true, nodes, edges: dag.edges, order, cycle, ready }`.

---

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). Steps 1–5 + the step-4/7 API actions done; `knowledge-graph.test.ts` **23/23**, kernel regression **63/63**, `astro check` **zero errors** in touched files (repo total unchanged at 184). Steps 6 (rewrite the `.astro` client graph) and 7 (author a seed DAG) deferred — both are presentation/data, not engine logic; the endpoints they'd consume are live.

1. [x] **Types**: `related_to` added to `RELATIONSHIP_TYPES` (+ a matching `EDGE_GRAMMAR` entry so Block 01 still typechecks); `objectives?: string[]` added to `KnowledgeObjectData` and `DATA_SCHEMAS.KnowledgeObject`.
2. [x] **New module** `src/lib/knowledge-graph.ts`: `topoSort`, `findCycle` (returns the loop), `wouldCreateCycle`, `prerequisiteClosure`, `readyFrontier`, `learningPath`, `loadPrerequisiteDag`, `loadNodeLabels` (resilient on a cold DB).
3. [x] **Unit tests** `src/lib/knowledge-graph.test.ts`: linear, diamond, disconnected, self-loop, 3-node cycle, `wouldCreateCycle` ±, frontier progression, path skips mastered, determinism. 23/23.
4. [x] **Authoring guard**: `ContentService.addPrerequisite` now loads the unit DAG and rejects self/cycle; `ensureConcept` + `addConceptPrerequisite` added; `POST /api/admin/knowledge` returns **409** on cycle and has `ensureConcept`/`addConceptPrerequisite` actions with `can()` gates.
5. [x] **Read APIs**: `GET /api/aquintutor/knowledge-graph` and `GET /api/aquintutor/knowledge-path`.
6. [ ] **Deferred** — rewrite `knowledge-graph.astro` to fetch the real graph (client-render change).
7. [ ] **Deferred** — author a seed concept DAG via the API.
8. [x] **Verify**: pure tests green; cycle attempt path returns 409; `topoSort.cycle` non-null on a forced bad edge (covered by the unit test).

---

## 7. Reality checks & risks

- **"Kernel immediately starts Offline Planner" / "Kernel synchronizes only changed objects" (pp 7–11) is a resident-kernel metaphor.** On Vercel serverless there is no long-running kernel process. The concrete form: the graph is loaded **per request** from Postgres (`loadPrerequisiteDag`), computed statelessly, and returned; the delta ("only changed objects") is already handled by `src/lib/knowledge-sync.ts` (`computeDelta` BFS over `kernel_edges` + the `edu_sync_queue` table). This block only reads those edges; it does not run a background sync loop.
- **"Adaptive Rendering — Kernel asks CPU/GPU/RAM/Battery…" and "Runtime Capability Analyzer benchmarks every capability" (pp 9–10, 46–50) are out of scope here and cannot run on the server.** A serverless function cannot benchmark the learner's device; capability detection is a browser-side (three.js/Alpine) concern that belongs to the rendering block. The knowledge graph is content-only and device-independent. Flag: do **not** try to store a "capability vector" against concepts.
- **"Educational Prediction / Scenario Trees / Prediction Ensembles" (Chapter 26, pp 51–55) is explicitly out of scope for this block.** It is a separate anticipatory-reasoning subsystem, not part of the KnowledgeObject/graph data model. The only overlap this block owns is the deterministic prerequisite ordering that a future planner would consume.
- **Whole-graph-in-memory at "100 million learners" scale (Engineering Decision 001, p 50).** The pure algorithms hold the entire node/edge set in one function invocation — fine for course/subject-scale graphs (hundreds to low-thousands of concepts, which is the realistic ceiling for a single curriculum). If a single graph grows past ~50k nodes, move closure to Postgres (recursive CTE `WITH RECURSIVE` over `kernel_edges`) or a precomputed `concept_closure` materialized table refreshed by a cron job. Decision for a human: cap graph size per subject vs. build the recursive-CTE path now.
- **Naming divergence needs a human decision.** The block brief says `type='knowledge'/'concept'` and edges `'prerequisite'/'related'`; the repo already ships `type='KnowledgeObject'/'ConceptObject'` and `type='prerequisite_of'` (with `related_to` added here). This block **reuses the existing repo strings** to avoid forking the object model — confirm that is acceptable rather than renaming existing enums and edges.
- **Concept-level vs. unit-level DAG.** Today `prerequisite_of` edges are authored between `KnowledgeObject` units (`kernel-content.ts`); the spec focus is a *concept* graph. The module is generic over `nodeType`, so both work, but authors must be consistent per graph. Recommend concept-level prereqs live between `ConceptObject`s and units link to concepts via `part_of`; flag if the product wants a single blended graph.
- **`related_to` is deliberately excluded from the DAG** (it is a soft "see also"): including it in `prerequisite_of` topo/cycle logic would create false cycles. Keep the loader filtered to `prerequisite_of` only.
- **No external services required** for this block — pure Postgres reads/writes through the existing `db` client; no cache, queue, or blob storage needed. Per-request memoization within a single invocation is optional and sufficient.
