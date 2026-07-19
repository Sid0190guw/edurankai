# Engineering Block 06 — Offline Package & Knowledge Synchronization

| Field | Value |
|---|---|
| **Spec source** | Vol 1 pp 18–45 — "Live Educational Compilation", "Offline Learning Package", "Knowledge Acquisition Pipeline" (delta-sync/conflict semantics extrapolated from the source's compilation + `synchronization_state` model) |
| **Repo target** | Extend `src/lib/offline-package.ts`, `src/lib/knowledge-sync.ts`, `src/lib/storage.ts`; new `src/lib/offline/manifest-schema.ts` (zod); extend `src/pages/api/aquintutor/offline/*` + `src/pages/api/admin/sync.ts`; extend `public/aquin-offline-sw.js`, `public/offline-package.js`; new `POST /api/aquintutor/offline/delta`, `GET /api/aquintutor/offline/manifest/[id]` |
| **Status** | partial (planner, manifest, delta, conflict, blob adapter, SWs all exist; this block formalizes the manifest schema, moves payloads to blob, extends the planner to the 9 manifest categories, and adds a version-cursor delta protocol) |
| **Depends on** | Block 01 — Kernel object store (`src/lib/kernel/*`: `kernel_objects.version`, `synchronization_state`, `kernel_edges`); Block 05 — Content & rendering (`src/lib/kernel-content.ts`, `src/lib/edu-runtime.ts` `RenderTier`, `src/lib/content-render.ts`, `src/lib/render-policy.ts`) |

## 1. Purpose

Compile a self-contained **offline learning package** for a student (or a device) — a budget-bounded, pre-rendered snapshot of selected courses/units/assessments/labs/animations plus their knowledge-graph slice, notes, dictionary, translations and the student's progress — so lessons run in the browser with **no network**. On reconnect, run a **delta synchronization** keyed on `kernel_objects.version` + `synchronization_state`: pull only objects that changed since the client's cursor, propagate a change (e.g. an updated equation/formula) along its dependent chain (animation → assessment → translation), push the student's offline work up, and resolve two-sided edits with deterministic conflict rules (never a silent overwrite). Package payloads are persisted to `@vercel/blob`; only a manifest header + integrity metadata live in Postgres.

## 2. Repo mapping — exists vs. build

**Already exists (extend, do not duplicate):**

- `src/lib/offline-package.ts` — budget planner `planPackage()`, `buildManifest()`, `prerenderUnit()`, `compileForUser()`, `enqueueDirty()`; tables `edu_offline_packages`, `edu_sync_queue`, `edu_offline_policy` (self-bootstrapped). **Today the manifest is only `KnowledgeObject` units + prereq edges + progress, and it is stored inline as JSONB.**
- `src/lib/knowledge-sync.ts` — `computeDelta()` (BFS along `PROPAGATION_TYPES`), `reconcile()` (push/pull/conflict), `resolveConflictDecision()` (`server-wins` | `local-wins` | `higher-version`), `computeServerDelta()`, `pushDirty()`, `detectConflicts()`, `flagConflict()`, `resolveConflict()`; tables `edu_sync_queue` (+`base_version`), `edu_sync_audit`.
- `src/lib/storage.ts` — `BlobStore` port with `vercelBlobStore()` (real `@vercel/blob`, gated on `BLOB_READ_WRITE_TOKEN`) and `memoryStore()` dev fallback; `getStore()`, `storageKey()`, `storageProvisioned()`.
- `src/lib/kernel/*` — `kernel_objects(version, synchronization_state ∈ {synced,dirty,pending,conflict}, lifecycle_state)`, `kernel_edges(from_id,to_id,type)`; `KernelRepository.updateObject()` already bumps `version` and sets `synchronization_state='dirty'`.
- `src/lib/kernel-content.ts` — `contentService().getUnitView(id)` → `{ unit, prerequisites, courses }`.
- API: `POST /api/aquintutor/offline/compile`, `POST /api/aquintutor/offline/sync-enqueue`, `POST /api/admin/sync` (push/resolve/flag), `POST /api/offline/sync` (`offline_work`).
- Client: `public/aquin-offline-sw.js` (SW scoped to `/aquintutor/offline`), `public/offline-package.js` (IndexedDB stores `units`/`prog`/`meta`), `public/offline-sync.js` (IndexedDB `queue`/`records` → posts `/api/offline/sync`), page `src/pages/aquintutor/offline.astro`, admin `src/pages/admin/sync.astro`.

**To add / extend:**

- **`src/lib/offline/manifest-schema.ts`** — a **zod** schema for the 9-category manifest (Videos, Voice, Assessment, Virtual Lab, Notes, Knowledge Graph, Dictionary, Translation, Student Progress). Currently the manifest is a bare TS interface with no runtime validation.
- **Category-aware planner** in `offline-package.ts`: select across `CourseObject`/`AssessmentObject`/`LaboratoryObject`/`SimulationObject`/`AnimationObject` (not only `KnowledgeObject`), take the **prerequisite closure**, and budget-pack per category.
- **Blob-backed package body**: upload the compiled manifest (and large media refs) via `storage.ts`; store only `blob_url` + `checksum` + `base_version` in `edu_offline_packages` (additive columns).
- **Version-cursor delta protocol**: new `POST /api/aquintutor/offline/delta` that returns objects with `version > cursor.highWatermark` OR `synchronization_state <> 'synced'`, scoped to the package's object set — replacing the current global "all non-synced" scan for the client pull path.
- **`last-writer-wins` conflict policy** (by `updated_at`) + **field-level merge for progress** (monotonic union), added to `resolveConflictDecision()`.
- **SW cache plan** for categorized blob media (extend `aquin-offline-sw.js` with a runtime media cache keyed off the manifest).

## 3. Data model

### 3.1 Manifest — TypeScript interface + zod schema

New file `src/lib/offline/manifest-schema.ts` (mirrors repo zod conventions in `src/lib/kernel/validation.ts`):

```ts
// src/lib/offline/manifest-schema.ts — zod schema for the Offline Learning Package manifest.
import { z } from 'zod';

export const SYNC_STATE = z.enum(['synced', 'dirty', 'pending', 'conflict']);
export const RENDER_TIER = z.enum(['lite', 'standard', 'rich']);

// One packaged object. `version` + `syncState` are the delta-sync keys (kernel_objects).
// Inline payload (notes/edges) has `inline`; heavy media (video/voice/lab) has `blobUrl`.
export const assetRef = z.object({
  id: z.string().uuid(),                      // kernel_objects.id
  type: z.string(),                           // ObjectType or 'edge' / 'progress' / 'term'
  version: z.number().int().nonnegative(),    // kernel_objects.version at pack time
  syncState: SYNC_STATE.default('synced'),
  bytes: z.number().int().nonnegative(),
  checksum: z.string().optional(),            // sha-256 hex of the payload/media
  blobUrl: z.string().url().optional(),       // @vercel/blob url for heavy media
  contentType: z.string().optional(),
  inline: z.unknown().optional(),             // small pre-rendered payloads (notes html, etc.)
});
export type AssetRef = z.infer<typeof assetRef>;

// Knowledge-graph slice: the edges that connect packaged objects (kernel_edges subset).
export const graphEdge = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
  type: z.string(),                           // RelationshipType
});

export const dictionaryTerm = z.object({
  term: z.string(),
  definition: z.string(),
  conceptId: z.string().uuid().optional(),    // -> ConceptObject
  lang: z.string().default('en'),
});

// Maps from `edu_progress` (ensureRuntimeSchema): koId<-ko_id, completed<-completed,
// timeSpentSec<-seconds, updatedAt<-updated_at. `score` has no column today — optional,
// populated from AssessmentObject attempts when present, else omitted.
export const progressEntry = z.object({
  koId: z.string().uuid(),
  completed: z.boolean().default(false),
  score: z.number().optional(),
  timeSpentSec: z.number().int().nonnegative().default(0),  // <- edu_progress.seconds
  updatedAt: z.string(),                      // ISO — the LWW clock for merge
});
export type ProgressEntry = z.infer<typeof progressEntry>;

// The 9 manifest categories, mapped from the spec's compilation outputs (Vol 1 pp 36-37).
export const offlinePackageManifest = z.object({
  schemaVersion: z.literal(1),
  packageId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  tier: RENDER_TIER,
  createdAt: z.string(),                       // ISO
  baseVersion: z.number().int().nonnegative(), // high-watermark: max kernel version at pack time (delta cursor seed)
  budget: z.object({ maxBytes: z.number().int().positive(), maxUnits: z.number().int().positive().optional() }),
  totalBytes: z.number().int().nonnegative(),
  droppedIds: z.array(z.string()),            // objects dropped by the budget planner

  categories: z.object({
    videos:         z.array(assetRef).default([]),   // recorded/animation VOD (blobUrl)
    voice:          z.array(assetRef).default([]),   // TTS / narration audio (blobUrl)
    assessment:     z.array(assetRef).default([]),   // AssessmentObject (inline questions)
    virtualLab:     z.array(assetRef).default([]),   // Laboratory/Simulation (inline three.js scene spec + blob assets)
    notes:          z.array(assetRef).default([]),   // pre-rendered KnowledgeObject body/equations/examples (inline html)
    knowledgeGraph: z.array(graphEdge).default([]),  // kernel_edges subset over packaged objects
    dictionary:     z.array(dictionaryTerm).default([]),
    translation:    z.array(assetRef).default([]),   // translation_of variants per BCP-47 lang
    studentProgress:z.array(progressEntry).default([]),
  }),
});
export type OfflinePackageManifest = z.infer<typeof offlinePackageManifest>;

export function parseManifest(raw: unknown): OfflinePackageManifest {
  return offlinePackageManifest.parse(raw);   // throws ZodError on a malformed package
}
```

### 3.2 Postgres — additive columns (self-bootstrap pattern)

Extend `ensureOfflineSchema()` in `offline-package.ts` (repo already uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, see `knowledge-sync.ts`):

```ts
// blob-backed body + delta cursor seed. The `manifest` JSONB column stays for the header only.
await db.execute(sql.raw(`ALTER TABLE edu_offline_packages ADD COLUMN IF NOT EXISTS blob_url TEXT`));
await db.execute(sql.raw(`ALTER TABLE edu_offline_packages ADD COLUMN IF NOT EXISTS blob_key TEXT`));
await db.execute(sql.raw(`ALTER TABLE edu_offline_packages ADD COLUMN IF NOT EXISTS checksum TEXT`));
await db.execute(sql.raw(`ALTER TABLE edu_offline_packages ADD COLUMN IF NOT EXISTS base_version INTEGER NOT NULL DEFAULT 0`));
await db.execute(sql.raw(`ALTER TABLE edu_offline_packages ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1`));
// per-package object membership, so the delta pull is scoped to what the device actually has.
await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_offline_pkg_objects (
  package_id UUID NOT NULL,
  object_id  UUID NOT NULL,
  packed_version INTEGER NOT NULL,
  PRIMARY KEY (package_id, object_id))`));
await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_offline_pkg_obj_idx ON edu_offline_pkg_objects (package_id)`));
```

### 3.3 Delta-sync wire types

```ts
// src/lib/offline/delta-types.ts
export interface SyncCursor {
  packageId: string;
  highWatermark: number;   // max kernel_objects.version the client has applied
  lastSyncedAt: string;    // ISO
}
export interface DeltaObject {
  id: string; type: string; version: number;
  syncState: 'synced' | 'dirty' | 'pending' | 'conflict';
  updatedAt: string;
  payload?: unknown;       // re-rendered inline payload OR { blobUrl } for heavy media
}
export interface DeltaResponse {
  changed: DeltaObject[];  // objects with version > cursor.highWatermark OR state <> 'synced'
  affected: string[];      // ids pulled in by dependency propagation
  removed: string[];       // objects archived/deleted since the cursor
  newWatermark: number;    // caller stores this as the next cursor.highWatermark
  conflicts: string[];     // ids where both sides changed -> student must reconcile
}
```

## 4. Interfaces & API contracts

### 4.1 Library functions (extend existing modules)

```ts
// src/lib/offline-package.ts (extend)

// Category-aware selection input. Any id list may be empty; the planner resolves closures.
export interface PackageSelection {
  courseIds?: string[];        // CourseObject -> expands to its published part_of units
  unitIds?: string[];          // KnowledgeObject
  assessmentIds?: string[];    // AssessmentObject
  labIds?: string[];           // LaboratoryObject / SimulationObject
  animationIds?: string[];     // AnimationObject
  languages?: string[];        // BCP-47 -> pull translation_of variants
  includeDictionary?: boolean;
}

// Compile -> validate (zod) -> upload body to blob -> persist header. Replaces the JSONB-only path.
export async function compilePackage(
  userId: string | null,
  sel: PackageSelection,
  tier: RenderTier,
  maxBytesOverride?: number,
): Promise<{ manifest: OfflinePackageManifest; blobUrl: string | null; checksum: string }>;

// Prerequisite closure: given seed unit ids, add every prerequisite_of ancestor so the package
// is self-contained offline.
export async function prerequisiteClosure(unitIds: string[]): Promise<string[]>;
```

```ts
// src/lib/knowledge-sync.ts (extend)

export type ConflictPolicy =
  | 'server-wins' | 'local-wins' | 'higher-version' | 'last-writer-wins';

// LWW keyed on updatedAt; progress objects use monotonic field merge (see §5.5).
export function resolveConflictDecision(
  local: LocalMeta & { updatedAt?: string },
  server: ServerMeta & { updatedAt?: string },
  policy?: ConflictPolicy,
): { winner: 'server' | 'local'; newVersion: number };

// The scoped, cursor-based pull (replaces the global computeServerDelta for the client path).
export async function computePackageDelta(cursor: SyncCursor): Promise<DeltaResponse>;

// Monotonic merge of two progress snapshots (never regresses completion/score/time).
export function mergeProgress(a: ProgressEntry, b: ProgressEntry): ProgressEntry;
```

### 4.2 Astro API endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/aquintutor/offline/compile` *(extend)* | `{ selection: PackageSelection, tier?, maxBytes? }` | `{ ok, packageId, blobUrl, checksum, manifest }` |
| GET | `/api/aquintutor/offline/manifest/[id]` *(new)* | — | `302` redirect to `blobUrl`, or `{ ok, manifest }` for small packages |
| POST | `/api/aquintutor/offline/delta` *(new)* | `SyncCursor` | `DeltaResponse` |
| POST | `/api/aquintutor/offline/sync-enqueue` *(exists)* | `{ changes: LocalChange[] }` | `{ ok, enqueued }` |
| POST | `/api/admin/sync` *(exists; add policy)* | `{ action:'push'\|'resolve'\|'flag', objectId?, objectIds?, policy? }` | `{ ok, ... }` |
| POST | `/api/offline/sync` *(exists)* | `{ records: [...] }` | `{ ok, synced }` |

All routes gate on `locals.user`; content packaging additionally runs `can(user,'read',{type,securityLabels})` per object (already done in `compile.ts`); admin sync gates `can(user,'manage',{type:'sync'})`.

## 5. Core logic / algorithms

### 5.1 Offline Planner — selection + closure + budget pack

```
compilePackage(userId, sel, tier, maxBytesOverride):
  1. budget.maxBytes = maxBytesOverride>0 ? maxBytesOverride : getPolicy().maxBytes   # default 8 MB
  2. seedUnits = sel.unitIds ∪ (for each courseId: listCourseUnits(courseId, onlyPublished=true))
  3. units = prerequisiteClosure(seedUnits)                    # §5.2 — self-contained offline
  4. for each id in (units ∪ assessmentIds ∪ labIds ∪ animationIds):
        v = getUnitView(id)      # or getObject for non-unit types
        skip if not published  OR  can(read) == deny
        classify into a category (§5.4); prerender payload at `tier`; measure bytes; checksum
  5. items = all classified refs, priority = (earlier-selected → higher) as today
  6. plan = planPackage(items, budget)          # EXISTING greedy: sort by priority desc, bytes asc; fill
  7. keep = plan.included; drop the rest into manifest.droppedIds
  8. knowledgeGraph = kernel_edges where from∈keep AND to∈keep       # graph slice
  9. dictionary = ConceptObject terms referenced by kept units (if sel.includeDictionary)
 10. translation = translation_of variants of kept units for sel.languages
 11. studentProgress = edu_progress rows for kept unit ids (userId)
 12. baseVersion = max(version) over all kept objects            # delta cursor seed
 13. manifest = { schemaVersion:1, ..., categories:{...} }; parseManifest(manifest)  # zod gate
 14. upload (§5.3); persist header + edu_offline_pkg_objects rows
```

`planPackage()` is already implemented and unit-tested; reuse it unchanged (greedy knapsack by priority then size). Budget default `DEFAULT_MAX_BYTES = 8 MB` (low-end-device friendly) stays.

### 5.2 Prerequisite closure (keeps the package self-contained)

```
prerequisiteClosure(seed):
  seen = set(seed); queue = list(seed)
  while queue:
     id = queue.pop()
     for edge in kernel_edges where to_id=id AND type='prerequisite_of':   # prereq -> id
         if edge.from_id not in seen: seen.add(edge.from_id); queue.push(edge.from_id)
  return list(seen)
```

### 5.3 Blob upload of the package body (via `storage.ts`)

```
body = JSON.stringify(manifest)                       # or split heavy media out first
checksum = sha256hex(body)                            # @oslojs/crypto (repo dep)
key = storageKey('offline-pkg', packageId, 'json')    # storage.ts helper
store = getStore()                                    # vercel-blob if BLOB_READ_WRITE_TOKEN else memory
res = await store.put(key, body, 'application/json')
if res == null:                                       # token missing / upload failed
   fallback: keep manifest inline in edu_offline_packages.manifest (current behaviour) and set blob_url=NULL
else:
   persist blob_url=res.url, blob_key=key, checksum
```

Heavy media (`videos`, `voice`, lab GLB/GLTF) are uploaded per-object with `storageKey('offline-media', objectId, ext)`; the manifest holds `{ blobUrl, checksum, bytes }` refs, not bytes. The service worker caches those URLs on first fetch (§5.6).

### 5.4 Category classification (kernel type → manifest category)

| Kernel source | Manifest category | Payload form |
|---|---|---|
| Recording VOD / rendered `AnimationObject` video | `videos` | `blobUrl` |
| TTS narration track | `voice` | `blobUrl` |
| `AssessmentObject` | `assessment` | inline questions |
| `LaboratoryObject` / `SimulationObject` | `virtualLab` | inline three.js scene spec (+ blob GLB) |
| `KnowledgeObject` (body/equations/examples) | `notes` | inline pre-rendered HTML (`prerenderUnit`) |
| `kernel_edges` between kept objects | `knowledgeGraph` | inline edge list |
| `ConceptObject` glossary terms | `dictionary` | inline |
| `translation_of` variants | `translation` | inline or `blobUrl` per lang |
| `edu_progress` rows | `studentProgress` | inline |

### 5.5 Delta-sync protocol (keyed on `version` + `synchronization_state`)

**Pull (`computePackageDelta`)** — scoped to the device's package, not a global scan:

```
computePackageDelta(cursor):
  member = SELECT object_id, packed_version FROM edu_offline_pkg_objects WHERE package_id = cursor.packageId
  live   = SELECT id, type, version, synchronization_state, updated_at, lifecycle_state, archived_at
           FROM kernel_objects WHERE id = ANY(member.object_id)
  changedSeed = [ o.id for o in live
                  if o.version > cursor.highWatermark            # server advanced
                     OR o.synchronization_state <> 'synced' ]    # dirty/pending/conflict
  edges   = kernel_edges touching changedSeed
  affected = computeDelta(changedSeed, edges, PROPAGATION_TYPES)  # EXISTING BFS: equation->animation->assessment->translation
  changed  = re-render affected objects at the package tier (inline) or emit { blobUrl }
  removed  = [ o.id for o in live if o.lifecycle_state in ('archived','deleted') ]
  conflicts= [ o.id for o in live if o.synchronization_state = 'conflict' ]
  newWatermark = max(live.version)
  return { changed, affected, removed, newWatermark, conflicts }
```

`PROPAGATION_TYPES = [prerequisite_of, assesses, references, translation_of, variant_of]` (already defined; `part_of` is deliberately excluded so sibling units in a course are not force-synced).

**Push** — the client posts the objects it edited offline to `sync-enqueue` (already: marks `synchronization_state='dirty'`, inserts `edu_sync_queue` row with `base_version` = the version the offline edit was based on). Then `pushDirty()` accepts them server-side (sets `synced`, writes `edu_sync_audit`).

**Reconcile decision (per object)** — existing `reconcile(local, server)`:

```
dirty = local.state in {dirty, pending}
if not dirty:                 return server.version > local.version ? 'pull' : 'none'
if server.version <= local.baseVersion:  return 'push'      # only local changed
return 'conflict'                                            # BOTH changed -> §5.6
```

### 5.6 Conflict resolution rules (never a silent overwrite)

When both sides changed, the object is set `synchronization_state='conflict'` (`flagConflict`) and surfaced in `/admin/sync` and the student's sync banner. Resolution is deterministic by policy:

| Policy | Winner | Use for |
|---|---|---|
| `server-wins` *(default)* | server | published teaching content (faculty is source of truth) |
| `local-wins` | local | rare; explicit admin override |
| `higher-version` | max(version) | structural objects |
| `last-writer-wins` *(new)* | max(`updated_at`) | student-authored notes/annotations |
| **field-merge** *(progress)* | merged, no loser | `studentProgress` — monotonic |

```
resolveConflictDecision(local, server, policy):
  if policy=='local-wins':        winner='local'
  elif policy=='higher-version':  winner = local.version >= server.version ? 'local' : 'server'
  elif policy=='last-writer-wins':winner = Date(local.updatedAt) >= Date(server.updatedAt) ? 'local' : 'server'
  else:                           winner='server'
  return { winner, newVersion: max(local.version, server.version) + 1 }   # always bump

mergeProgress(a, b):   # progress is monotonic — no conflict, ever
  return {
    koId: a.koId,
    completed:   a.completed || b.completed,
    score:       max(a.score ?? -inf, b.score ?? -inf),
    timeSpentSec:max(a.timeSpentSec, b.timeSpentSec),   # max, not sum, to avoid double-count on replay
    updatedAt:   maxISO(a.updatedAt, b.updatedAt),
  }
```

Every resolution writes an `edu_sync_audit` row (`from_version`, `to_version`, `resolution`, `actor`) — already implemented; the version history is queryable via `versionHistory(objectId)`.

### 5.7 Service-worker cache plan

- **Shell cache** (`aquin-offline-v1`, exists): `/aquintutor/offline` + `/offline-package.js`, cache-first with background refresh. SW scope stays `/aquintutor/offline` so site-wide SWs are untouched.
- **Media runtime cache** (`aquin-offline-media-v1`, new): on `fetch`, if the request URL is a blob media URL present in the active manifest (client posts the URL list to the SW via `postMessage` after IndexedDB load), respond cache-first and populate on miss. Evict entries whose URL is not in the current manifest on `activate`.
- **API guard** (exists): never intercept `/api/*`.
- **Manifest body**: fetched once from `blobUrl` (or `/api/aquintutor/offline/manifest/[id]`), stored in IndexedDB `units`/`prog`/`meta` stores (existing `offline-package.js`). Category media URLs are extracted client-side and handed to the media cache.

## 6. Execution plan

> **Status: PARTIALLY IMPLEMENTED** (2026-07-20) — the pure engine + tests landed; the DB/blob/endpoint/SW/cron extensions are deferred (they extend already-working modules and need Postgres/blob/browser infra to exercise). `offline-sync.test.ts` **22/22**, `astro check` **zero errors** in touched files (repo total unchanged at 184). The `resolveConflictDecision` signature was widened (optional `updatedAt`) — backward compatible with the existing `resolveConflict`/admin-sync callers.

- [x] **1. Manifest schema.** `src/lib/offline/manifest-schema.ts` (9-category zod + `parseManifest`/`safeParseManifest`) + `src/lib/offline/delta-types.ts`. Test asserts malformed packages are rejected.
- [ ] **2. Deferred** — `ensureOfflineSchema()` additive columns + `edu_offline_pkg_objects` (DB migration).
- [ ] **3. Deferred** — category-aware `compilePackage` + `prerequisiteClosure` (DB read of course/edges).
- [ ] **4. Deferred** — blob body upload via `storage.ts` + sha256 (needs `BLOB_READ_WRITE_TOKEN`).
- [ ] **5. Deferred** — `computePackageDelta` + `/offline/delta` + `/offline/manifest/[id]` endpoints (DB).
- [x] **6. Conflict extensions.** `last-writer-wins` added to `ConflictPolicy` + `CONFLICT_POLICIES` + `resolveConflictDecision` (with higher-version fallback when clocks are absent); `mergeProgress()` monotonic merge added. *(Wiring the new policy into `/admin/sync.astro` buttons is deferred — UI.)*
- [ ] **7. Deferred** — client `offline-package.js` cursor + reconnect flow (browser).
- [ ] **8. Deferred** — SW media runtime cache (browser).
- [ ] **9. Deferred** — `/api/cron/sync-sweep` background reconciliation.
- [x] **10. Tests.** Pure tests: manifest accept/reject + defaults, all 4 conflict policies incl. LWW + fallback, `mergeProgress` monotonicity/idempotence, `computeDelta` propagation (+ `part_of` exclusion), `reconcile` decisions. 22/22.

## 7. Reality checks & risks

- **No resident kernel / scheduler (metaphor).** The spec's "Runtime Bootstrap Engine" as *the only executable entry point* with resident RAM, an in-memory dependency DAG, and a persistent scheduler (Vol 1 pp 43–45) does not exist on Vercel serverless. Serverless equivalent (already how the repo works): stateless request handlers + Postgres state + `@vercel/blob` + client IndexedDB/SW + **Vercel Cron** for background sweeps. Delta sync is pull-on-reconnect + cron reconciliation, **not** a live kernel loop.
- **"Within about a second" live compilation is out of scope for this block.** The source's real-time Educational Intelligence Runtime (speech/equation/gesture recognition → animation/simulation compile) is a separate authoring pipeline; Block 06 only *packages already-authored, published objects* and syncs deltas. ASR/MT/TTS for the real-time path are out of scope here.
- **Translation & Dictionary depend on external datasets/services.** "All Indian languages, real-time translation" requires an external MT provider and per-language TTS; this block packages whatever `translation_of` variants already exist as kernel objects. Producing new translations is out of scope and needs a human decision on provider (cost/coverage).
- **Blob provisioning is required for real packages.** Without `BLOB_READ_WRITE_TOKEN`, `storage.ts` falls back to an in-memory dev store — packages then persist inline as JSONB, which is fine for small `notes`-only packages but not for `videos`/`voice`/lab GLB. Production offline video needs the token set. **Human decision:** offline media budget default (8 MB is text-friendly; video packages need a much larger, per-institution policy in `edu_offline_policy`).
- **CSP / same-origin blob media in the SW.** The offline viewer must be able to fetch `@vercel/blob` URLs (cross-origin) and cache them; confirm the viewer page's CSP allows the blob host, and that the SW media cache respects `Cache-Control`. Large caches can hit browser storage quotas — needs eviction (handled by manifest-diff on `activate`).
- **Global vs. per-device delta.** The current `computeServerDelta()` returns *all* non-synced kernel objects — correct for the admin console, wrong for a student device pull (would leak/oversync). This block scopes the pull via `edu_offline_pkg_objects` + a per-package `highWatermark`. Keep both paths.
- **`timeSpentSec` merge uses `max`, not `sum`,** to stay idempotent under offline replay (a queue can re-deliver). If true additive time-on-task is required, switch to per-session records — flagged for product.
- **Out of scope / mark n/a:** "post-quantum cryptography" and "autonomous cyber defense" from the broader spec do not apply to this block; integrity here is `sha256` checksums + session auth + RBAC gating (`can(read)` per object at pack time, `can(manage,'sync')` for resolution). Digitally-signed configuration snapshots (Vol 1 p 44) are not implemented — checksum-only.
