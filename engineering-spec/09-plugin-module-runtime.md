# Engineering Block 09 — Plugin / Subject-Module Runtime

| Field | Value |
|---|---|
| **Spec source** | Vol 1 pp 26–45 — "Live Educational Compilation", "Knowledge Acquisition Pipeline", "Runtime Bootstrap Engine (AES-001 Ch 1.1) — feature/plugin registry" |
| **Repo target** | create `src/lib/plugins/` (`types.ts`, `registry.ts`, `host.ts`, `schema.ts`, `store.ts`, `index.ts`, `subjects/*.ts`); create `src/pages/api/plugins/*`; extend `src/lib/render-policy.ts` and `src/lib/scene-spec.ts` (pack hooks) |
| **Status** | greenfield (the `src/lib/plugins/` layer is new; it integrates the already-implemented `src/lib/kernel`, `src/lib/rbac`, `src/lib/render-policy`, `src/lib/assessment`, `src/lib/scene-spec`) |
| **Depends on** | Block 10 — Capabilities / RBAC (`src/lib/rbac`); Kernel Object Model (`src/lib/kernel`) |

## 1. Purpose
Define a first-party TypeScript plugin contract so each subject domain (Physics, Chemistry, Medical, Mechanical, Programming) can declare, in one place: the kernel object *subtypes* it owns, the concept-domain tags it is responsible for, its client renderers/scene primitive packs, and its assessment-item generators. Every plugin reaches persistence only through a capability-checked `PluginHost` facade over `KernelRepository` — a plugin never imports `@/lib/db` or another plugin, and every read/write it makes is gated by the Block 10 `can()` check. The registry resolves "which plugin owns this concept / renders this object / generates this quiz" and enable/disables plugins per institution.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/kernel/` — the object store. `KernelRepository.createObject`/`addRelationship`/`buildKnowledgeObject`, `createPgKernel()`, the 12 `OBJECT_TYPES`, `ObjectDataMap`, lifecycle state machine, per-type Zod `DATA_SCHEMAS`. Plugins persist through this; they add no new tables for objects.
- `src/lib/rbac/` — `can(user, cap, res, ctx)`, `requireCapability`, `ForbiddenError`, the `Capability` registry with `registerCapability()`, `evaluate()` pipeline + security-label gating. This is the mediation layer (Block 10).
- `src/lib/render-policy.ts` — `RenderDirective`, `RENDER_MATRIX` keyed by `ObjectRenderType`, `resolveDirective(type, tier, override)`, `hydrate: string[]` (named client enhancements). Plugin renderers extend the `hydrate` list per tier.
- `src/lib/scene-spec.ts` — the WebGL scene spec with `BASE_TYPES` + a `PHYSICS_TYPES` domain pack (`projectile`, `pendulum`, `spring`). This is the existing precedent for a subject "scene pack"; the physics plugin formalizes it.
- `src/lib/assessment.ts` — `Item`, `gradeItem`, `createAssessment(title, kind, assessedObjectId, owner, labels)` (creates an `AssessmentObject` + `assesses` edge), item bank `edu_assessment_items`. Plugin generators produce `Item[]`; persistence reuses this.
- `src/lib/feature-flags.ts` — `FLAG_CATALOG` (static catalog) + DB override table pattern. The plugin registry copies this shape (static manifest catalog + `edu_plugin_registry` DB overrides).

**Build (new):**
- `src/lib/plugins/types.ts` — the `SubjectPlugin` contract.
- `src/lib/plugins/registry.ts` — static catalog, `bootstrapPlugins()` (manifest validation + capability registration + dependency DAG/cycle check), resolvers (`pluginForConcept`, `resolveHydrate`, `resolveAssessmentGenerator`).
- `src/lib/plugins/host.ts` — `createPluginHost(pluginId, user)`: the capability-mediated facade over `KernelRepository`.
- `src/lib/plugins/schema.ts` + `store.ts` — `edu_plugin_registry` self-bootstrapping DDL + per-institution enable/disable.
- `src/lib/plugins/subjects/physics.ts`, `chemistry.ts`, `medical.ts`, `mechanical.ts`, `programming.ts` — five first-party manifests.
- `src/pages/api/plugins/index.ts`, `[id]/toggle.ts`, `[id]/generate-assessment.ts` — admin list/toggle + generator endpoint.

## 3. Data model

No new object tables — plugins specialize the existing `kernel_objects` via a `metadata` discriminator (`plugin`, `subject`, `subtype`) and validate their extended payload with their own Zod schema. Only one small config table is added.

### 3.1 The plugin contract (`src/lib/plugins/types.ts`)

```ts
// src/lib/plugins/types.ts — the SubjectPlugin contract. Pure types, no I/O.
import type { z } from 'zod';
import type { ObjectType } from '@/lib/kernel';
import type { Capability } from '@/lib/rbac';
import type { Item } from '@/lib/assessment';
import type { RenderTier } from '@/lib/edu-runtime';

/** A concept the runtime recognized (spec: "Concept ID -> Knowledge Graph"). */
export interface ConceptRef {
  conceptId?: string | null;   // a kernel ConceptObject id, when one already exists
  domain: string;              // concept-domain tag, e.g. 'physics.fluids.bernoulli'
  name: string;
}

/** Deterministic item factory for a concept (no LLM here — pure/seedable). */
export type AssessmentGenerator = (
  concept: ConceptRef,
  opts: { count: number; difficulty?: number; seed?: number },
) => Item[];

/** A plugin-owned specialization of one of the 12 kernel object types. The extra fields live
 *  inside the object's `data`; `schema` validates them before the object is created. */
export interface PluginObjectSubtype {
  kernelType: ObjectType;      // which kernel type this specializes (e.g. 'SimulationObject')
  subtype: string;             // discriminator stored at metadata.subtype (e.g. 'circuit')
  schema: z.ZodTypeAny;        // validates the extended `data` payload
}

/** Named primitive types the client WebGL engine (public/aquin-scene-engine.js) must be able to
 *  build for this subject — mirrors scene-spec.ts PHYSICS_TYPES. Declaration only; see §7. */
export interface ScenePack {
  id: string;                  // 'physics' | 'chemistry' | ...
  primitiveTypes: string[];    // e.g. ['projectile','pendulum','spring']
}

/** Extra client enhancements this plugin needs hydrated, layered onto render-policy hydrate lists. */
export interface PluginRenderer {
  objectType: string;                              // 'AnimationObject' | 'SimulationObject' | 'LaboratoryObject' | ...
  hydrate: Partial<Record<RenderTier, string[]>>;  // extra hydrate keys per tier
  scenePack?: string;                              // ScenePack id these renders use
}

export interface AssessmentGeneratorRef {
  conceptDomain: string;       // domain prefix this generator serves, e.g. 'physics'
  generate: AssessmentGenerator;
}

/** The whole plugin declaration. Registered statically (§7: no dynamic/remote code loading). */
export interface SubjectPlugin {
  id: string;                          // 'physics' | 'chemistry' | 'medical' | 'mechanical' | 'programming'
  subject: string;                     // display name
  version: string;                     // semver
  namespace: string;                   // short metadata prefix, e.g. 'phys'
  dependsOn?: string[];                // other plugin ids (shared packs) — DAG-checked, must be acyclic
  conceptDomains: string[];            // domain prefixes this plugin owns (longest-prefix wins)
  objectSubtypes: PluginObjectSubtype[];
  renderers: PluginRenderer[];
  assessmentGenerators: AssessmentGeneratorRef[];
  requiredCapabilities: Capability[];  // MAX capability scope the host will ever grant this plugin
  scenePacks?: ScenePack[];
}
```

### 3.2 Registry config table (`src/lib/plugins/schema.ts`)

```ts
// src/lib/plugins/schema.ts — self-bootstrapping (CREATE TABLE IF NOT EXISTS), the repo's pattern.
import { pgTable, uuid, text, boolean, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const NIL_INSTITUTION = '00000000-0000-0000-0000-000000000000'; // global default row

export const eduPluginRegistry = pgTable('edu_plugin_registry', {
  institutionId: uuid('institution_id').notNull().default(NIL_INSTITUTION),
  pluginId: text('plugin_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: text('version').notNull(),
  config: jsonb('config').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.institutionId, t.pluginId] }) }));

export const PLUGIN_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_plugin_registry (
     institution_id UUID NOT NULL DEFAULT '${NIL_INSTITUTION}',
     plugin_id TEXT NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT true,
     version TEXT NOT NULL,
     config JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (institution_id, plugin_id))`,
];
```

### 3.3 Object metadata discriminator (convention, no schema change)

Every object a plugin creates carries, in `kernel_objects.metadata`:

```ts
interface PluginObjectMetadata {
  plugin: string;    // owning plugin id — the isolation key
  subject: string;   // manifest.subject
  subtype: string;   // manifest.objectSubtypes[].subtype
}
```

## 4. Interfaces & API contracts

### 4.1 Registry (`src/lib/plugins/registry.ts`)

```ts
export function bootstrapPlugins(): { order: string[]; issues: string[] };  // idempotent; runs once per cold start
export function getPlugin(id: string): SubjectPlugin | undefined;
export function allPlugins(): SubjectPlugin[];
export function pluginForConcept(domain: string): SubjectPlugin | undefined;         // longest-prefix match
export function resolveAssessmentGenerator(conceptDomain: string): AssessmentGenerator | undefined;
export function resolveHydrate(objectType: string, tier: RenderTier, pluginId?: string): string[]; // base ∪ plugin
export function scenePrimitiveTypes(): string[];                                     // union of all enabled packs
```

### 4.2 Host (`src/lib/plugins/host.ts`) — the mediation boundary

```ts
import type { ObjectType, ObjectDataMap, KernelObject } from '@/lib/kernel';
import type { Capability, ResourceRef } from '@/lib/rbac';

export interface HostCreateInput<T extends ObjectType> {
  type: T;
  subtype: string;
  data: ObjectDataMap[T] & Record<string, unknown>;  // base payload + plugin-extended fields
  owner?: string | null;
  securityLabels?: string[];
}

export interface PluginHost {
  readonly pluginId: string;
  createObject<T extends ObjectType>(input: HostCreateInput<T>): Promise<KernelObject>;
  getObject(id: string): Promise<KernelObject | null>;                 // read-gated + cross-plugin isolation
  updateObject(id: string, patch: { data?: Record<string, unknown> }): Promise<KernelObject>;
  linkConcept(objectId: string, conceptId: string): Promise<void>;     // part_of edge to a SHARED ConceptObject
  addReference(fromId: string, toId: string): Promise<void>;           // references edge; both must be plugin-owned
  can(cap: Capability, res?: ResourceRef): Promise<boolean>;
}

/** Build a host bound to one plugin + the acting user. Caps are clamped to the manifest. */
export function createPluginHost(pluginId: string, user: unknown): PluginHost;
```

### 4.3 Store (`src/lib/plugins/store.ts`)

```ts
export function ensurePluginSchema(): Promise<void>;                                  // runs PLUGIN_DDL
export function isPluginEnabled(pluginId: string, institutionId?: string): Promise<boolean>;
export function setPluginEnabled(pluginId: string, enabled: boolean, institutionId?: string): Promise<void>;
export function listPluginState(institutionId?: string): Promise<Array<{ pluginId: string; enabled: boolean; version: string }>>;
```

### 4.4 Astro endpoints

| Method + path | Request | Response | Guard |
|---|---|---|---|
| `GET /api/plugins` | — | `{ plugins: Array<SubjectPlugin meta + enabled> }` | `requireCapability(user, 'configure')` |
| `POST /api/plugins/[id]/toggle` | `{ enabled: boolean, institutionId?: string }` | `{ ok: true, enabled }` | `requireCapability(user, 'configure', { id, type:'plugin' })` |
| `POST /api/plugins/[id]/generate-assessment` | `{ conceptDomain: string; koId: string; count?: number; seed?: number }` | `{ assessmentId: string; itemCount: number }` | via `PluginHost` (`'create'` on `AssessmentObject`) |

## 5. Core logic / algorithms

### 5.1 Bootstrap: manifest validation + capability registration + dependency DAG (spec's "Runtime Bootstrap Engine")

```
bootstrapPlugins():
  if booted: return cached { order, issues }
  issues = []
  seen = {}
  for p in SUBJECT_PLUGINS:
    if p.id in seen: issues.push("duplicate plugin id " + p.id); continue
    seen[p.id] = p
    for cap in p.requiredCapabilities: registerCapability(cap)   // Block 10 registry
    registerCapability("plugin." + p.id)                         // plugin-scoped capability token
  order = topoSort(seen, issues)      // §5.2 — aborts (order=[]) if a cycle is found
  byId = seen; booted = true
  return { order, issues }
```

### 5.2 Dependency topological order + cycle detection (Kahn) — spec: "represent as DAG; abort on cycle"

```
topoSort(plugins, issues):
  indeg = {}; adj = {}
  for id in plugins: indeg[id] = 0; adj[id] = []
  for p in plugins.values():
    for dep in (p.dependsOn ?? []):
      if dep not in plugins: issues.push(p.id + " depends on missing " + dep); continue
      adj[dep].push(p.id); indeg[p.id] += 1
  queue = [id for id in plugins if indeg[id] == 0]
  order = []
  while queue not empty:
    n = queue.shift(); order.push(n)
    for m in adj[n]:
      indeg[m] -= 1; if indeg[m] == 0: queue.push(m)
  if order.length != plugins.size:
    cycle = [id for id in plugins if indeg[id] > 0]
    issues.push("dependency cycle among: " + cycle.join(","))   // refuse: return []
    return []
  return order
```

### 5.3 Concept → plugin resolution (longest-prefix over `conceptDomains`)

```
pluginForConcept(domain):
  best = undefined; bestLen = -1
  for p in byId.values():
    for owned in p.conceptDomains:
      if domain == owned or domain.startsWith(owned + "."):
        if owned.length > bestLen: best = p; bestLen = owned.length
  return best
// 'physics.fluids.bernoulli' -> physics (owns 'physics'); ties broken by most specific prefix.
```

### 5.4 Capability-mediated `createObject` — "every module passes through the kernel"

```
host.createObject(input):                       // host is bound to (pluginId, user)
  manifest = getPlugin(pluginId)
  1. if 'create' not in manifest.requiredCapabilities:
        throw new Error("plugin '" + pluginId + "' lacks 'create' in its manifest")  // config/assertion error, NOT the RBAC denial (that is ForbiddenError(Decision) at step 3)
  2. sub = manifest.objectSubtypes.find(s => s.kernelType==input.type && s.subtype==input.subtype)
     if not sub: throw Error("unknown subtype " + input.type + "/" + input.subtype)
  3. res = { type: input.type, securityLabels: input.securityLabels ?? ['public'] }
     d = await can(user, 'create', res)         // Block 10 decision + audit row
     if not d.allow: throw ForbiddenError(d.reason)
  4. sub.schema.parse(input.data)               // plugin-owned payload validation (throws on bad data)
  5. metadata = { plugin: pluginId, subject: manifest.subject, subtype: input.subtype }
  6. return createPgKernel().createObject({
        type: input.type, data: input.data, owner: input.owner ?? null,
        securityLabels: input.securityLabels, metadata })
```

### 5.5 Capability-mediated read + cross-plugin isolation

```
host.getObject(id):
  o = await createPgKernel().getObject(id)
  if o == null: return null
  res = { id, type: o.type, ownerId: o.owner, securityLabels: o.securityLabels, state: o.lifecycleState }
  d = await can(user, 'read', res)
  if not d.allow: return null                                  // read denied by Block 10
  owner = o.metadata.plugin
  // shared graph (ConceptObjects) is readable by any plugin; another plugin's PRIVATE objects are not.
  if owner && owner != pluginId && o.type != 'ConceptObject':
    return null                                                // isolation: no direct cross-plugin read
  return o
// addReference enforces the write side: both endpoints must have metadata.plugin == pluginId
// (or the target is a ConceptObject) — a plugin can only wire its own objects + the shared concept graph.
```

### 5.6 Renderer resolution (base render-policy ∪ plugin hydrate)

```
resolveHydrate(objectType, tier, pluginId):
  base = resolveDirective(objectType, tier).hydrate          // from src/lib/render-policy.ts
  if not pluginId: return base
  p = getPlugin(pluginId); if not p: return base
  extra = []
  for r in p.renderers:
    if r.objectType == objectType: extra = r.hydrate[tier] ?? []
  return dedupe([...base, ...extra])
// e.g. SimulationObject at 'rich': base ['sim-interactive'] ∪ physics ['phys-fluid-sim'] -> ['sim-interactive','phys-fluid-sim'];
// at 'lite' both base and plugin hydrate are [] -> [] (no client JS on the low tier).
```

### 5.7 Assessment generation (deterministic; persists via `assessment.ts`)

```
POST /api/plugins/[id]/generate-assessment { conceptDomain, koId, count=5, seed }:
  p = pluginForConcept(conceptDomain); if p.id != id: 400
  gen = resolveAssessmentGenerator(conceptDomain); if not gen: 404
  host = createPluginHost(id, user)
  await requireCapability(user, 'create', { type:'AssessmentObject' })   // gate
  items = gen({ domain: conceptDomain, name: koId }, { count, seed })    // pure Item[]
  assessmentId = await createAssessment("Auto: " + conceptDomain, 'quiz', koId, user.id)  // AssessmentObject + assesses edge
  for it, i in items:
    INSERT edu_assessment_items (assessment_id=assessmentId, type=it.type, prompt, options, answer, points, sort=i)
  return { assessmentId, itemCount: items.length }
```

### 5.8 Example manifest (`src/lib/plugins/subjects/physics.ts`)

```ts
import { z } from 'zod';
import type { SubjectPlugin, AssessmentGenerator } from '../types';
import type { Item } from '@/lib/assessment';

// deterministic PRNG so generation is reproducible for a given seed
function rng(seed: number) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

const bernoulliQuiz: AssessmentGenerator = (concept, { count, seed = 1 }) => {
  const r = rng(seed); const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const v1 = Math.round(2 + r() * 6), a1 = 4, a2 = 2;            // continuity: A1 v1 = A2 v2
    const v2 = Math.round((a1 * v1) / a2);
    items.push({
      id: `phys-${concept.domain}-${i}`, type: 'numeric', points: 1,
      prompt: `Pipe narrows from area ${a1} to ${a2} cm². Inlet speed ${v1} m/s. Outlet speed (m/s)?`,
      answer: { value: v2, tolerance: 0.5 },
    });
  }
  return items;
};

export const physicsPlugin: SubjectPlugin = {
  id: 'physics', subject: 'Physics', version: '1.0.0', namespace: 'phys',
  conceptDomains: ['physics'],
  objectSubtypes: [
    { kernelType: 'SimulationObject', subtype: 'fluid-flow',
      schema: z.object({ title: z.string().min(1), engine: z.string().optional(), viscosity: z.number().optional() }) },
    { kernelType: 'AnimationObject', subtype: 'bernoulli',
      schema: z.object({ title: z.string().min(1), scene: z.string().optional() }) },
  ],
  renderers: [
    { objectType: 'SimulationObject', hydrate: { rich: ['phys-fluid-sim'] }, scenePack: 'physics' },
    { objectType: 'AnimationObject', hydrate: { standard: ['phys-anim'], rich: ['phys-anim'] }, scenePack: 'physics' },
  ],
  assessmentGenerators: [{ conceptDomain: 'physics', generate: bernoulliQuiz }],
  requiredCapabilities: ['read', 'create', 'write', 'execute'],
  scenePacks: [{ id: 'physics', primitiveTypes: ['projectile', 'pendulum', 'spring'] }],  // mirrors scene-spec.ts PHYSICS_TYPES
};
```

The other four (`chemistry`, `medical`, `mechanical`, `programming`) follow the same shape: `chemistry` scene pack `['atom','bond','beaker']`, `programming` uses no scene pack and a `mcq`/`short_answer` generator, etc.

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20) — the plugin layer, registry, host, three first-party manifests, store, and endpoints landed; `plugins.test.ts` **19/19**, `astro check` **zero errors** in touched files (repo total unchanged at 184). Scope note: shipped **3** subject manifests (physics/chemistry/programming) rather than 5 — `medical`/`mechanical` follow the identical shape and can be added as data. The two client-side items (T7 render-site wiring, T8 scene-spec primitive registration) are deferred — they edit render call-sites / `public/aquin-scene-engine.js`, not this contract.

- [x] **T1** `types.ts` — `SubjectPlugin` contract (+ `rng` PRNG helper). Pure, type-only imports.
- [x] **T2** `schema.ts` + `store.ts` — `edu_plugin_registry` DDL + `ensurePluginSchema`/`isPluginEnabled`/`setPluginEnabled`/`listPluginState`.
- [x] **T3** `subjects/physics.ts` (formalizes the scene-spec physics pack), `chemistry.ts`, `programming.ts`. *(medical/mechanical deferred — same shape.)*
- [x] **T4** `registry.ts` — static catalog + `bootstrapPlugins()` + `topoSortPlugins()` + `pluginForConcept` (longest-prefix) + `resolveHydrate` + `resolveAssessmentGenerator` + `scenePrimitiveTypes`; registers caps via `registerCapability`.
- [x] **T5** `host.ts` — `createPluginHost`: cap-clamp to the manifest, `can()` gate, subtype zod validation, `metadata.plugin` stamping, cross-plugin isolation on read + `addReference`.
- [x] **T6** `index.ts` — public re-exports.
- [ ] **T7 Deferred** — wire `resolveHydrate` into render call-sites.
- [ ] **T8 Deferred** — register scene-pack primitives with `scene-spec.ts` + `aquin-scene-engine.js` builders (client).
- [x] **T9** `GET /api/plugins`, `POST /api/plugins/[id]/toggle`, `POST /api/plugins/[id]/generate-assessment` — `requireCapability`-guarded.
- [x] **T10** Tests: topo cycle→`order=[]` + missing-dep issue, `pluginForConcept` longest-prefix, `resolveHydrate` base∪plugin + lite exclusion, scene-pack union, deterministic generator (same seed→identical), subtype payload validation. 19/19.

## 7. Reality checks & risks

- **Resident kernel / in-memory scheduler is a metaphor.** On Vercel serverless there is no long-lived process. The "Runtime Bootstrap Engine" here is `bootstrapPlugins()` that runs **once per cold start**, memoized in a module-level `booted` flag — the DAG/cycle check (§5.2) runs over the static catalog, not a live process tree. There is no kernel-managed RAM, no persistent scheduler.
- **No dynamic / remote / untrusted plugin loading.** Plugins are **first-party TypeScript modules compiled into the bundle** and listed in a static `SUBJECT_PLUGINS` array (same shape as `FLAG_CATALOG`). We do **not** `eval` or fetch plugin code at runtime. Installing third-party/untrusted plugins is **out of scope**; it would require V8 isolates or separate worker sandboxes, which a single Vercel function cannot provide. The spec's per-config **digital-signature / checksum / cryptographic verification** of the plugin registry (Bootstrap Engine, Vol 1 pp 44–45) is therefore **N/A** here — a compiled-in manifest is trusted by construction. `bootstrapPlugins()` instead validates *shape* (manifest fields), *capabilities* (registered via Block 10 `registerCapability`), and the *dependency DAG*; signature verification would only be reintroduced if untrusted plugin packages were ever loaded.
- **"Isolation" is capability + convention, not an OS sandbox.** All plugins share one process, one Postgres, one `kernel_objects` table. Isolation is enforced by: (a) the `PluginHost` clamps every call to `manifest.requiredCapabilities` and routes it through Block 10 `can()`; (b) objects are stamped `metadata.plugin` and cross-plugin private reads/writes are refused (§5.5); (c) plugins receive only the host object and must not import `@/lib/db`, `@/lib/kernel`, or each other. Point (c) should be enforced with an ESLint `no-restricted-imports` rule under `src/lib/plugins/subjects/**` — flag: without the lint rule this is convention only.
- **New top-level kernel object types are out of scope.** `OBJECT_TYPES` and the Zod `DATA_SCHEMAS` in `src/lib/kernel` are compile-time frozen. Plugins therefore specialize the existing 12 types via a `metadata.subtype` discriminator + their own `PluginObjectSubtype.schema`, validated in the host **before** `createObject`. Adding a genuinely new kernel type still requires editing `kernel/types.ts` + `validation.ts`.
- **Scene packs are declarations; the builders are client code.** A plugin's `scenePack.primitiveTypes` are just names. The actual geometry builders live in `public/aquin-scene-engine.js` and in `scene-spec.ts`'s repair logic — they cannot be shipped as plugin data. Adding a chemistry `atom`/`bond` primitive means editing those client files too. Until then, unknown primitives are coerced to `box` by `scene-spec.ts`'s repair path (safe but wrong-looking).
- **"Live Educational Compilation" (voice/gesture → auto-generate everything) is out of scope for this block.** Concept recognition (speech/vision/LLM), animation/simulation synthesis, and translation belong to the LLM / board-vision / scene-spec / i18n blocks. This block provides only the **dispatch contract**: recognized `ConceptRef` → `pluginForConcept` → the plugin's declared renderers + `AssessmentGenerator`. Generators here are deterministic/seedable (no LLM), so they are unit-testable; LLM-backed generation is a later, separate integration.
- **"Knowledge Acquisition Pipeline" (search NASA/ESA, cross-verify, temp knowledge graph) is out of scope.** It requires external HTTP sources + background jobs (`src/lib/job-queue.ts`), not a synchronous request. A plugin may later declare an optional `knowledgeAcquisition` hook, but the crawl/verify/store loop must run as a queued job, not in the endpoint.
- **Multi-tenant enable/disable needs a real institution id — human decision.** `edu_plugin_registry` is keyed `(institution_id, plugin_id)` with a NIL default row. Where the acting institution id comes from (session? `heiInstitutions`? `brandProfiles`?) and whether plugin sets differ per tenant is a product decision. Until decided, everything resolves against the NIL global row.
- **External services required:** none beyond what the repo already uses (Postgres via `@/lib/db`). `@vercel/blob` only if a plugin later stores large generated assets.
