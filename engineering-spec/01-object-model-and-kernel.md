# Engineering Block 01 — Object Model & Kernel Envelope

| Field | Value |
|---|---|
| **Spec source** | AES Vol 1 (Educational Operating Kernel) pp. 1–12 — "Kernel Objects", "Object Lifecycle", "Knowledge Object", "Plugin Runtime", "Engineering philosophy" |
| **Repo target** | Extend `src/lib/kernel/{types.ts,lifecycle.ts,schema.ts,validation.ts}`; add `src/lib/kernel/{access.ts,graph.ts}`; optional endpoints under `src/pages/api/kernel/` |
| **Status** | partial (envelope + 12 types + lifecycle + edges already implemented; validation/access/graph/rollback extensions are the work) |
| **Depends on** | None — foundational. Downstream blocks (edu-runtime, offline-sync, adaptive-rendering, RBAC bridge) depend on this. |

## 1. Purpose
A single uniform object store: every domain entity (knowledge, student, faculty, course, concept, lab, simulation, animation, assessment, university, placement, research) is one row in `kernel_objects` — a shared envelope plus a type-specific JSON `data` payload. Typed relationships live as rows in `kernel_edges`. Every object moves through one enforced lifecycle state machine (`created → validated → indexed → published → referenced → updated → archived → deleted`), and no object skips a stage. This block owns the type layer, the envelope/edge schema, the lifecycle guard, and the validation/access/graph primitives every other subsystem calls.

## 2. Repo mapping — exists vs. build

**Already implemented (do not duplicate):**
- `src/lib/kernel/types.ts` — the 12 `OBJECT_TYPES`, `LIFECYCLE_STATES`, `SYNC_STATES`, `RELATIONSHIP_TYPES`, `KernelEnvelope`, `KernelObject<D>`, `RelationshipEdge`, per-type payload interfaces, and `ObjectDataMap`.
- `src/lib/kernel/schema.ts` — Drizzle `kernelObjects` + `kernelEdges` tables and `KERNEL_DDL` (self-bootstrap `CREATE TABLE IF NOT EXISTS`).
- `src/lib/kernel/lifecycle.ts` — `TRANSITIONS` map, `canTransition`, `assertTransition`, `LifecycleError`, `OPERATION_TARGET`.
- `src/lib/kernel/validation.ts` — `DATA_SCHEMAS` (per-type zod), `validateObjectData`, `ValidationError`.
- `src/lib/kernel/{store.ts,repository.ts,index.ts}` — `KernelStore` port, `InMemoryKernelStore` + `PgKernelStore` adapters, `KernelRepository` (typed CRUD, lifecycle ops, `buildKnowledgeObject` composition), public API + `createKernel`/`createPgKernel`.
- `src/lib/kernel/kernel.test.ts` — proves create-all-types, full lifecycle, illegal-transition rejection, version bump, validation gate, KnowledgeObject composition round-trip.
- Downstream consumers already exist: `src/lib/edu-runtime.ts`, `src/lib/knowledge-sync.ts`, `src/lib/offline-package.ts`, `src/lib/kernel-content.ts`, `src/pages/api/admin/knowledge.ts`.

**To build (this block):**
1. **Envelope validation** — a zod schema for the whole envelope (not just `data`), used to reject malformed rows read from storage or accepted over the wire. → extend `validation.ts`.
2. **Edge grammar** — the set of legal `(fromType, relationshipType, toType)` triples, enforced when `addRelationship` runs. → extend `types.ts` + `validation.ts`.
3. **Capability check** — `can(actor, object, need)` combining `owner`, `permissions[]`, and `securityLabels[]` (bridging to `src/lib/rbac` role tokens). → new `src/lib/kernel/access.ts`.
4. **Prerequisite DAG** — topological order + cycle detection over `prerequisite_of` edges, so a KnowledgeObject cannot be published into a prerequisite cycle. → new `src/lib/kernel/graph.ts`.
5. **Version history + rollback** — a `kernel_object_versions` snapshot table and `rollbackObject(id, toVersion)`; realises the spec's "Version / Roll back / Merge". → extend `schema.ts`, add repository method.
6. **Optimistic-concurrency / sync primitives** — `expectedVersion` on `updateObject`, `synchronizationState` transition to `conflict` on mismatch (the object-model half of delta-sync; the sync engine itself is a downstream block). → extend `lifecycle.ts` (sync state machine) + repository.

## 3. Data model

All new definitions are additive to the existing files and match repo conventions (`pgTable`, `uuid`, `jsonb`, `text[]`, zod, `KERNEL_DDL` self-bootstrap).

### 3.1 Envelope zod schema — extend `src/lib/kernel/validation.ts`
```ts
import { z } from 'zod';
import { OBJECT_TYPES, LIFECYCLE_STATES, SYNC_STATES } from './types';

export const PERMISSION_SCHEMA = z.object({
  subject: z.string().min(1),                      // object id OR a role token (see access.ts)
  roles: z.array(z.enum(['read', 'write', 'publish'])),
});

export const LEARNING_METADATA_SCHEMA = z.object({
  difficulty: z.number().min(0).max(1).optional(),
  estimatedMinutes: z.number().nonnegative().optional(),
  languages: z.array(z.string()).optional(),       // BCP-47
  accessibilityVariants: z.array(z.string()).optional(),
}).strict();

/** Validates the whole envelope shape (used on ingest / on read from an untrusted store). */
export const ENVELOPE_SCHEMA = z.object({
  id: z.string().uuid(),
  type: z.enum(OBJECT_TYPES),
  version: z.number().int().positive(),
  owner: z.string().uuid().nullable(),
  permissions: z.array(PERMISSION_SCHEMA),
  metadata: z.record(z.unknown()),
  learningMetadata: LEARNING_METADATA_SCHEMA,
  securityLabels: z.array(z.string()),
  synchronizationState: z.enum(SYNC_STATES),
  lifecycleState: z.enum(LIFECYCLE_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

export function validateEnvelope(env: unknown): void {
  const res = ENVELOPE_SCHEMA.safeParse(env);
  if (!res.success) {
    throw new ValidationError(
      (env as { type?: string })?.type as any ?? ('KnowledgeObject' as any),
      res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
}
```

### 3.2 Edge grammar — extend `src/lib/kernel/types.ts`
```ts
// Legal (fromType) -[relationship]-> (toType) triples. Anything not listed is rejected.
// Mirrors buildKnowledgeObject() wiring in repository.ts.
export const EDGE_GRAMMAR: Record<RelationshipType, ReadonlyArray<readonly [ObjectType, ObjectType]>> = {
  prerequisite_of: [
    ['ConceptObject', 'KnowledgeObject'],
    ['KnowledgeObject', 'KnowledgeObject'],
    ['ConceptObject', 'ConceptObject'],
    ['CourseObject', 'CourseObject'],
  ],
  part_of: [
    ['KnowledgeObject', 'ConceptObject'],
    ['ConceptObject', 'CourseObject'],
    ['KnowledgeObject', 'CourseObject'],
  ],
  assesses: [
    ['AssessmentObject', 'KnowledgeObject'],
    ['AssessmentObject', 'ConceptObject'],
    ['AssessmentObject', 'CourseObject'],
  ],
  references: [
    ['KnowledgeObject', 'AnimationObject'],
    ['KnowledgeObject', 'LaboratoryObject'],
    ['KnowledgeObject', 'SimulationObject'],
    ['KnowledgeObject', 'ResearchObject'],
  ],
  translation_of: [
    ['KnowledgeObject', 'KnowledgeObject'],
    ['AssessmentObject', 'AssessmentObject'],
  ],
  variant_of: [
    ['KnowledgeObject', 'KnowledgeObject'],
    ['AnimationObject', 'AnimationObject'],
  ],
} as const;

export function isEdgeLegal(fromType: ObjectType, rel: RelationshipType, toType: ObjectType): boolean {
  return EDGE_GRAMMAR[rel].some(([f, t]) => f === fromType && t === toType);
}
```

### 3.3 Version-history table — extend `src/lib/kernel/schema.ts`
```ts
// add `uniqueIndex` to the existing drizzle-orm/pg-core import in schema.ts.
export const kernelObjectVersions = pgTable('kernel_object_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  objectId: uuid('object_id').notNull(),
  version: integer('version').notNull(),
  snapshot: jsonb('snapshot').notNull(),           // full KernelObject at that version
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // one snapshot per (object, version); kept in sync with the UNIQUE INDEX in KERNEL_DDL below.
  objVerIdx: uniqueIndex('kernel_object_versions_obj_ver_idx').on(t.objectId, t.version),
}));
```
Append to `KERNEL_DDL` (self-bootstrap path):
```ts
`CREATE TABLE IF NOT EXISTS kernel_object_versions (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   object_id UUID NOT NULL,
   version INTEGER NOT NULL,
   snapshot JSONB NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE UNIQUE INDEX IF NOT EXISTS kernel_object_versions_obj_ver_idx
   ON kernel_object_versions (object_id, version)`,
```

### 3.4 Actor + sync types — extend `src/lib/kernel/types.ts`
```ts
/** The identity a capability check runs against. roleTokens bridge to src/lib/rbac. */
export interface KernelActor {
  id: string | null;               // a Student/Faculty/University object id (or user id)
  roleTokens?: string[];           // e.g. ['role:faculty', 'role:admin', 'university:<uuid>']
  enrolledObjectIds?: string[];    // objects this actor is enrolled in (for 'enrolled-only')
}

// Sync-state machine (distinct from the lifecycle machine). A stale optimistic write can flag a
// conflict from any live state, so 'conflict' is reachable from synced/dirty/pending (see §5.4).
export const SYNC_TRANSITIONS: Record<SynchronizationState, SynchronizationState[]> = {
  synced:   ['dirty', 'conflict'],
  dirty:    ['pending', 'synced', 'conflict'],
  pending:  ['synced', 'conflict', 'dirty'],
  conflict: ['dirty', 'synced'],
};
```

## 4. Interfaces & API contracts

### 4.1 New/extended repository methods — `src/lib/kernel/repository.ts`
```ts
// Optimistic concurrency: reject a stale write, flag a conflict instead of clobbering.
updateObject(id: string, patch?: UpdatePatch, expectedVersion?: number): Promise<KernelObject>;

// Version history + rollback (spec "Version / Roll back").
listVersions(id: string): Promise<Array<{ version: number; createdAt: string }>>;
rollbackObject(id: string, toVersion: number): Promise<KernelObject>; // restores data/meta, version++

// Field-level merge of two payloads that diverged offline (spec "Merge").
mergeObject(id: string, incoming: Partial<KernelObject>, base: number): Promise<{
  merged: KernelObject; conflicts: string[];   // dot-paths that both sides changed
}>;
```

### 4.2 Capability check — `src/lib/kernel/access.ts`
```ts
import type { KernelActor, KernelEnvelope, PermissionRole } from './types';

/** True iff `actor` may perform `need` on `object`. Pure, no I/O. */
export function can(actor: KernelActor, object: KernelEnvelope, need: PermissionRole): boolean;

/** Filter a list to only objects the actor may `read`. */
export function readable<T extends KernelEnvelope>(actor: KernelActor, objs: T[]): T[];
```

### 4.3 Graph primitives — `src/lib/kernel/graph.ts`
```ts
import type { RelationshipEdge } from './types';

export interface DagResult { order: string[]; cycle: string[] | null; }

/** Kahn topological sort over a chosen edge type (default 'prerequisite_of'). */
export function topoOrder(nodeIds: string[], edges: RelationshipEdge[], relType?: string): DagResult;

/** True iff adding from->to (relType) would introduce a cycle. */
export function wouldCycle(fromId: string, toId: string, edges: RelationshipEdge[], relType?: string): boolean;
```

### 4.4 Optional HTTP surface — `src/pages/api/kernel/`
Astro SSR endpoints (thin wrappers over `KernelRepository`, session-auth via `src/lib/auth`, capability-gated via `access.can`):

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/kernel/objects` | `CreateInput<T>` | `201 KernelObject` |
| `GET` | `/api/kernel/objects/:id` | — | `200 KernelObject` \| `403` \| `404` |
| `PATCH` | `/api/kernel/objects/:id` | `{ patch: UpdatePatch, expectedVersion: number }` | `200 KernelObject` \| `409 {conflict:true}` |
| `POST` | `/api/kernel/objects/:id/transition` | `{ to: LifecycleState }` | `200 KernelObject` \| `422 LifecycleError` |
| `POST` | `/api/kernel/objects/:id/rollback` | `{ toVersion: number }` | `200 KernelObject` |
| `GET` | `/api/kernel/objects/:id/graph` | — | `200 ObjectGraph` |
| `POST` | `/api/kernel/edges` | `{ fromId, type, toId, metadata? }` | `201 RelationshipEdge` \| `422` (illegal grammar/cycle) |

## 5. Core logic / algorithms

### 5.1 Capability check `can(actor, object, need)` (`access.ts`)
```ts
import type { KernelActor, KernelEnvelope, PermissionRole } from './types';

/** True iff `actor` may perform `need` on `object`. Pure, no I/O. */
export function can(actor: KernelActor, object: KernelEnvelope, need: PermissionRole): boolean {
  if (object.lifecycleState === 'deleted') return false;
  if (actor.id != null && actor.id === object.owner) return true;   // owner has all roles

  const tokens = new Set(actor.roleTokens ?? []);
  const granted = new Set<PermissionRole>();                        // union of roles from matching permissions
  for (const perm of object.permissions) {
    if (perm.subject === actor.id || tokens.has(perm.subject)) {
      for (const r of perm.roles) granted.add(r);
    }
  }
  const hasExplicit = granted.has(need);

  if (need === 'read') {                                            // security-label gate applies only to reads
    const labels = object.securityLabels;
    if (labels.includes('public')) return true;
    if (labels.includes('enrolled-only')) {
      return (actor.enrolledObjectIds ?? []).includes(object.id) || hasExplicit;
    }
    if (labels.includes('exam-secure')) return hasExplicit;        // never public
    return hasExplicit;
  }
  return hasExplicit;                                               // write / publish always need an explicit grant
}

/** Filter a list to only objects the actor may `read`. */
export function readable<T extends KernelEnvelope>(actor: KernelActor, objs: T[]): T[] {
  return objs.filter((o) => can(actor, o, 'read'));
}
```

### 5.2 Prerequisite DAG — Kahn topological sort + cycle detection (`graph.ts`)
```ts
import type { RelationshipEdge, RelationshipType } from './types';

export interface DagResult { order: string[]; cycle: string[] | null; }

/** Kahn topological sort over one edge type (default 'prerequisite_of'). */
export function topoOrder(nodeIds: string[], edges: RelationshipEdge[], relType = 'prerequisite_of'): DagResult {
  const nodes = new Set(nodeIds);
  const adj = new Map<string, string[]>();               // fromId -> [toId]
  const indeg = new Map<string, number>();
  for (const n of nodeIds) { adj.set(n, []); indeg.set(n, 0); }

  for (const e of edges) {
    if (e.type !== relType || !nodes.has(e.fromId) || !nodes.has(e.toId)) continue;
    adj.get(e.fromId)!.push(e.toId);
    indeg.set(e.toId, (indeg.get(e.toId) ?? 0) + 1);
  }

  const queue = nodeIds.filter((n) => (indeg.get(n) ?? 0) === 0);   // no unmet prerequisites
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (order.length === nodeIds.length) return { order, cycle: null };
  const cycle = nodeIds.filter((n) => (indeg.get(n) ?? 0) > 0);     // residual = the cycle
  return { order, cycle };
}

/** True iff adding from->to (relType) would introduce a cycle. */
export function wouldCycle(fromId: string, toId: string, edges: RelationshipEdge[], relType = 'prerequisite_of'): boolean {
  const candidate: RelationshipEdge = { id: '', fromId, toId, type: relType as RelationshipType, createdAt: '' };
  const nodeIds = [...new Set([fromId, toId, ...edges.flatMap((e) => [e.fromId, e.toId])])];
  return topoOrder(nodeIds, [...edges, candidate], relType).cycle !== null;
}
```
`wouldCycle` is called by `addRelationship` before persisting a `prerequisite_of` edge (§5.3), and by `validateObject` for a KnowledgeObject before it advances past `validated` (T4).

### 5.3 `addRelationship` guard (extend `repository.ts`)
```ts
async addRelationship(fromId: string, type: RelationshipType, toId: string,
                      metadata?: Record<string, unknown>): Promise<RelationshipEdge> {
  const from = await this.load(fromId);
  const to = await this.load(toId);                              // both must exist (already enforced)
  if (!isEdgeLegal(from.type, type, to.type)) {                  // NEW (§3.2)
    throw new EdgeGrammarError(from.type, type, to.type);
  }
  if (type === 'prerequisite_of') {                             // NEW (§5.2)
    const existing = await this.store.edgesOfType('prerequisite_of');
    if (wouldCycle(fromId, toId, existing)) throw new CycleError(fromId, toId);
  }
  const edge: RelationshipEdge = { id: uuid(), fromId, toId, type, metadata: metadata ?? {}, createdAt: nowISO() };
  await this.store.insertEdge(edge);
  return edge;
}
```
`edgesOfType(type)` is a new `KernelStore` read (see T3/T5); `EdgeGrammarError` and `CycleError` are new error classes alongside `LifecycleError`/`ValidationError`.

### 5.4 Optimistic update + version snapshot (extend `updateObject`)
```ts
async updateObject(id: string, patch: UpdatePatch = {}, expectedVersion?: number): Promise<KernelObject> {
  const o = await this.load(id);
  if (expectedVersion != null && o.version !== expectedVersion) {
    o.synchronizationState = 'conflict';                        // SYNC_TRANSITIONS: synced|dirty|pending -> conflict
    await this.store.updateObject(o);
    throw new StaleWriteError(o.version, expectedVersion);
  }
  const snapshot = structuredClone(o);                          // BEFORE mutation
  assertTransition(o.lifecycleState, 'updated');
  o.version += 1;
  o.synchronizationState = 'dirty';
  if (patch.data) o.data = { ...(o.data as Record<string, unknown>), ...patch.data };
  if (patch.metadata) o.metadata = { ...o.metadata, ...patch.metadata };
  if (patch.learningMetadata) o.learningMetadata = { ...o.learningMetadata, ...patch.learningMetadata };
  if (patch.securityLabels) o.securityLabels = patch.securityLabels;
  if (patch.permissions) o.permissions = patch.permissions;
  o.lifecycleState = 'updated';
  o.updatedAt = nowISO();
  await this.store.insertVersion(snapshot);                     // -> kernel_object_versions
  await this.store.updateObject(o);
  return o;
}
```

### 5.5 Rollback
```ts
async rollbackObject(id: string, toVersion: number): Promise<KernelObject> {
  const o = await this.load(id);
  const snap = await this.store.getVersion(id, toVersion);       // from kernel_object_versions
  if (!snap) throw new Error(`no such version ${toVersion} for ${id}`);
  await this.store.insertVersion(structuredClone(o));            // rollback is itself a new version
  o.data = snap.data;
  o.metadata = snap.metadata;
  o.learningMetadata = snap.learningMetadata;
  o.version += 1;                                                // monotonic; never rewinds
  o.synchronizationState = 'dirty';
  o.updatedAt = nowISO();
  await this.store.updateObject(o);
  return o;
}
```

### 5.6 Three-way field merge (`mergeObject`, offline reconciliation)
```ts
type Dict = Record<string, unknown>;

async mergeObject(id: string, incoming: Partial<KernelObject>, base: number): Promise<{
  merged: KernelObject; conflicts: string[];
}> {
  const current = await this.load(id);
  const baseSnap = await this.store.getVersion(id, base);        // common ancestor
  if (!baseSnap) throw new Error(`no base version ${base} for ${id}`);
  const baseData = (baseSnap.data ?? {}) as Dict;
  const localData = (current.data ?? {}) as Dict;
  const remoteData = (incoming.data ?? {}) as Dict;
  const merged = structuredClone(current);
  const conflicts: string[] = [];

  const paths = new Set([...changedPaths(baseData, localData), ...changedPaths(baseData, remoteData)]);
  for (const path of paths) {
    // structural comparison (matches changedPaths); reference `!==` would mis-flag array/object leaves.
    const localChanged = !eq(valueAt(localData, path), valueAt(baseData, path));
    const remoteChanged = !eq(valueAt(remoteData, path), valueAt(baseData, path));
    if (remoteChanged && !localChanged) setAt(merged.data as Dict, path, valueAt(remoteData, path));
    else if (localChanged && remoteChanged) conflicts.push(path);   // last-writer or human resolves
    // localChanged && !remoteChanged -> keep local (already in `merged`)
  }
  merged.synchronizationState = conflicts.length ? 'conflict' : 'synced';
  return { merged, conflicts };
}

// dot-path helpers over flat/nested plain objects (module-private in repository.ts).
function changedPaths(a: Dict, b: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = prefix ? `${prefix}.${k}` : k;
    const av = a[k], bv = b[k];
    if (isPlainObject(av) && isPlainObject(bv)) out.push(...changedPaths(av, bv, p));
    else if (JSON.stringify(av) !== JSON.stringify(bv)) out.push(p);
  }
  return out;
}
function valueAt(obj: Dict, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}
function setAt(obj: Dict, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Dict = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Dict;
  }
  cur[keys[keys.length - 1]] = value;
}
function isPlainObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function eq(a: unknown, b: unknown): boolean {   // structural equality for leaf values
  return JSON.stringify(a) === JSON.stringify(b);
}
```
Full offline delta-sync (which objects, batching, transport) is a **downstream block** — see §7. This block provides only the version/base/merge primitives.

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). T1–T8 + T10 done; 63/63 tests pass (`node_modules/.bin/tsx src/lib/kernel/kernel.test.ts`); `astro check` reports zero errors in the touched files. T9 intentionally deferred (kernel stays server-internal). One deviation from the spec draft: `EDGE_GRAMMAR.references` gained `['CourseObject','AnimationObject']` so the existing `vod.ts` Course→recording link is not rejected.

- [x] **T1 — Envelope validation.** Added `PERMISSION_SCHEMA`, `LEARNING_METADATA_SCHEMA`, `ENVELOPE_SCHEMA`, `validateEnvelope` to `validation.ts`; exported from `index.ts`. Tested: valid envelope passes, `version:0` and unknown `type` fail.
- [x] **T2 — Edge grammar.** Added `EDGE_GRAMMAR` + `isEdgeLegal` to `types.ts`; wired the guard + `EdgeGrammarError` into `repository.addRelationship`. Tested: illegal triple throws; all real consumer triples (buildKnowledgeObject, kernel-content, vod, animation, scene-spec, assessment) are legal.
- [x] **T3 — Graph module.** Added `src/lib/kernel/graph.ts` (`topoOrder`, `wouldCycle`, `DagResult`, `CycleError`) + `edgesOfType` on both store adapters; wired `wouldCycle` into `addRelationship`. Tested: linear chain sorts; a→b→c→a detected; residual = cycle nodes.
- [x] **T4 — Cycle gate at validate.** `validateObject` runs a `prerequisite_of` cycle check for KnowledgeObjects before `created → validated`. Tested via a store-forced cycle.
- [x] **T5 — Version history.** Added `kernelObjectVersions` table + DDL to `schema.ts`; extended `KernelStore` with `insertVersion` / `getVersion` / `listVersions` in both adapters (Pg uses `ON CONFLICT DO NOTHING` for idempotency).
- [x] **T6 — Optimistic update + snapshot.** `updateObject(id, patch, expectedVersion?)` snapshots pre-mutation and rejects a stale write with `StaleWriteError`, flagging `synchronizationState='conflict'`. Tested both paths.
- [x] **T7 — Rollback + merge.** Added `rollbackObject` (restores payload, version moves forward) and `mergeObject` (three-way, dot-path conflicts). Tested.
- [x] **T8 — Capability check.** Added `src/lib/kernel/access.ts` (`can`, `readable`); exported from `index.ts`. Table-tested owner / role-token / public / enrolled-only / exam-secure / deleted.
- [ ] **T9 — HTTP surface (optional).** Deferred — the kernel is still server-internal; no `src/pages/api/kernel/*` wrappers added yet.
- [x] **T10 — Extend `kernel.test.ts`.** Folded T1–T8 assertions into the self-contained test; **63 passed, 0 failed**.

## 7. Reality checks & risks

**Serverless reality (the spec's "kernel" metaphor).** The AES describes a resident "Educational Operating Kernel" that "schedules learning processes", holds cognitive state in RAM, and manages CPU/GPU/RAM/battery. On this stack (Astro SSR → Vercel serverless functions + serverless Postgres) there is **no resident process and no shared memory between requests**. The realistic mapping, already followed by the repo:
- "Kernel" = the stateless `KernelRepository` instantiated per request (`createPgKernel()`); state lives entirely in Postgres (`kernel_objects` / `kernel_edges`).
- "Everything passes through the kernel" = every domain write goes through `KernelRepository`, not that a daemon mediates IPC.
- "Scheduling learning processes" = ordinary request handlers + background jobs (cron endpoints already exist under `src/pages/api/cron`), **not** an in-process scheduler.
- Any per-request caching is memoization within one function invocation or an external cache/CDN; do **not** assume a warm in-memory object cache survives between requests.

**Explicitly out of scope for this block (downstream blocks):**
- **Offline delta-sync engine** (transport, batching, "which objects", 15-minute-Wi-Fi planner). This block ships only the object-model primitives: `version`, `synchronizationState`, `kernel_object_versions`, `expectedVersion`, and `mergeObject`. The engine already has a starting point in `src/lib/knowledge-sync.ts` / `src/lib/offline-package.ts`.
- **Adaptive rendering** (CPU/GPU/RAM/battery → 2D vs XR pipeline). Belongs to the three.js/render-policy block (`src/pages/admin/render-policy.astro`); the object model only carries `learningMetadata.accessibilityVariants` and `variant_of` edges.
- **Educational Runtime workflow** (Check-Auth → Estimate-Knowledge → … → Save-Progress). Belongs to `src/lib/edu-runtime.ts`; this block just supplies the objects it reads/writes.
- **Plugin runtime** ("every module inherits the kernel"). Realistic equivalent = internal modules importing `@/lib/kernel`; a true third-party plugin sandbox is not in scope and needs a human decision.

**Not present in the spec source — flagged, not implemented:** post-quantum crypto, autonomous cyber-defense, and a kernel-managed RAM/scheduler do **not** appear in this slice; if they surface later, treat as out-of-scope for the object model (session security already uses `@oslojs/crypto` in `src/lib/auth`).

**Decisions needing a human:**
1. **RBAC bridge.** `access.can` reads `permissions[].subject` as either an object id or a **role token**. The exact token format that maps to `src/lib/rbac` (`roles` / `rolePermissions` / `userRoleAssignments`) must be pinned (e.g. `role:<slug>`, `university:<uuid>`) before T8.
2. **`referenced` semantics.** The lifecycle has a distinct `referenced` state set only by an explicit `markReferenced` call, yet incoming edges are created independently. Decide whether `referenced` should be **derived** from a live reference count (auto-set on first incoming edge, and is `published`+referenced really two states or one). Current behaviour is kept as-is; changing it touches `lifecycle.ts` `TRANSITIONS`.
3. **Hard vs soft delete.** `deleted` is a soft state (row remains). Confirm no compliance/GDPR requirement forces physical deletion; if it does, add a purge job (out of this block).
4. **Merge conflict policy.** §5.6 surfaces conflicting dot-paths but does not auto-resolve. Decide last-writer-wins vs. human-review-queue for `exam-secure` / graded objects.
5. **`z.enum(OBJECT_TYPES)` on readonly tuples** — resolved, no action: zod accepts `Readonly<[string, ...string[]]>` in `z.enum` since v3.23, and the repo pins `zod@^3.24.1` (`package.json`), so `z.enum(OBJECT_TYPES)` / `LIFECYCLE_STATES` / `SYNC_STATES` compile against the `as const` arrays with no cast.
