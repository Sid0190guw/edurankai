# Engineering Block 03 — Educational Runtime (Lesson Execution Engine)

| Field | Value |
|---|---|
| **Spec source** | Vol 1 pp 17–26 — "Intelligent Teaching Runtime", "Educational Intelligence Runtime" pipeline, Bernoulli's-Principle walkthrough (Concept ID → Knowledge Graph → Compile → Render to student) |
| **Repo target** | **Create:** `src/lib/runtime/lesson-engine.ts` (orchestrator), `src/pages/api/aquintutor/lesson.ts` (POST endpoint), `src/lib/runtime/estimators.ts` (Block 04 home; extract from `edu-runtime.ts`). **Extend:** `src/lib/edu-runtime.ts` (already implements ~90% of the pipeline — becomes the pure core the orchestrator reuses). |
| **Status** | **partial** — the ordered pipeline, estimators, trace, and persistence already exist in `src/lib/edu-runtime.ts`; missing pieces are (a) the `prepare_offline_package` step (left explicitly OPEN in code), (b) a JSON API entrypoint (today only the `.astro` page calls it), (c) estimator extraction into a Block-04 module. |
| **Depends on** | Block 02 (Kernel object store + knowledge graph: `src/lib/kernel/*`, `src/lib/kernel-content.ts`), Block 04 (Context Estimators — currently inline in `edu-runtime.ts`), Block 06 (Offline Runtime: `src/lib/offline-package.ts`), + RBAC permission engine (`src/lib/rbac`) and Mastery store (`src/lib/aquintutor-learn.ts`). |

## 1. Purpose
When a student opens a KnowledgeObject ("Learn Bernoulli's Principle"), this subsystem runs one **ordered, request-scoped pipeline** that authorizes the request, estimates the student's context (knowledge/language/device/network/accessibility/learning-style/cognitive-load), selects the right served variant, compiles a render plan (lite/standard/rich), surfaces unmet prerequisites, records an inspectable trace, and persists progress. It is a **stateless orchestrator over Postgres**: it reads the knowledge graph (Block 02), calls pure estimators (Block 04), and optionally compiles an offline package (Block 06). It does not host live audio/vision or generate media at request time — those are separate subsystems that feed precomputed objects into the kernel.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/edu-runtime.ts` — `STEP_ORDER` (16 ordered steps), pure `runPipeline(input)` → `{ trace, assembled }`, estimators (`estimateDevice`, `estimateNetwork`, `estimateCognitiveLoad`, `numericMastery`, `combinePlan`), `signalsFromHeaders(headers)`, DB helpers (`getSettings`, `saveSettings`, `startLesson`, `completeLesson`, `resumeList`), and self-bootstrapped tables `edu_student_settings`, `edu_progress`, `edu_runtime_trace`.
- `src/lib/kernel-content.ts` — `contentService().getUnitView(id)` returns `{ unit, prerequisites, courses }`; publishing walks `created→validated→indexed→published`.
- `src/lib/kernel/*` — `createPgKernel()` returning a repository whose `getObjectGraph(id)` yields `{ incoming, outgoing }` typed edges (`prerequisite_of`, `translation_of`, `variant_of`, `part_of`, …); object envelope with `securityLabels`, `learningMetadata`, `data`.
- `src/lib/offline-package.ts` — `compileForUser(userId, unitIds, tier, maxBytes?)` → pre-rendered `OfflineManifest`; budget planner `planPackage`.
- `src/lib/aquintutor-learn.ts` — `aq_mastery` store, `getMastery(userId)`, forward-only `setMastery`.
- `src/lib/rbac` — `can(user, 'read', { type, securityLabels })` → `{ allow }`.
- `src/pages/aquintutor/lesson/[id].astro` — already calls `startLesson(user, id, request)` for SSR rendering.
- API conventions: `src/pages/api/aquintutor/*.ts` use `APIRoute`, `locals.user`, and a `json()` helper.

**Build / extend:**
- **`src/lib/runtime/lesson-engine.ts`** — the named orchestrator. Thin wrapper that (1) delegates to the existing pure core `runPipeline`, (2) adds the missing `prepare_offline_package` step by calling Block 06, (3) exposes one `runLesson()` / `completeLesson()` / `prepareOffline()` surface for the API. Re-exports the pure core so callers have one import.
- **`src/pages/api/aquintutor/lesson.ts`** — `POST /api/aquintutor/lesson`, action-dispatched (`start` | `complete` | `offline`). Today the pipeline is reachable only via the SSR page; this gives it a JSON contract for the SPA/labs/offline client.
- **`src/lib/runtime/estimators.ts`** — Block 04's home. Move the estimator functions out of `edu-runtime.ts` (re-export from the old path for back-compat) so Block 04 owns them independently.
- **Extend `edu-runtime.ts`** — replace the `load_resources` "offline package deferred" placeholder with a real, opt-in call into the orchestrator's offline step.

## 3. Data model

No new base tables are required — the pipeline reuses the kernel store and the existing `edu_*`/`aq_*` tables. New code adds **typed contracts only** plus a zod request schema.

```ts
// src/lib/runtime/lesson-engine.ts — typed contracts (reuse types from edu-runtime.ts)
import type {
  RenderTier, Accessibility, StudentSettings, DeviceSignals,
  RenderPlan, VariantSet, SessionTrace, Assembled,
} from '@/lib/edu-runtime';
import type { UnitView } from '@/lib/kernel-content';
import type { OfflineManifest } from '@/lib/offline-package';

/** Fully-resolved student context for one lesson request (the "Estimate*" outputs). */
export interface StudentContext {
  authenticated: boolean;
  authorized: boolean;                 // can(read, unit.securityLabels)
  language: string;                    // BCP-47
  settings: StudentSettings;           // language + accessibility + learningStyle
  signals: DeviceSignals;              // from Client Hints / UA
  cognitiveLoad: 'low' | 'moderate' | 'high';
  masteryOf: (koId: string) => number; // 0..1 per prerequisite
}

/** What the orchestrator returns for a lesson start. */
export interface LessonRunResult {
  koId: string;
  outcome: 'served' | 'denied' | 'not-ready';
  servedUnitId: string | null;         // may be a translation/a11y variant
  renderPlan: RenderPlan;              // { tier, reduceMotion, highContrast, fontScale, hydrate }
  language: string;
  notReady: boolean;
  prerequisites: { id: string; title: string; mastery: number; mastered: boolean }[];
  trace: SessionTrace;                 // ordered inspectable step log (persisted)
  offline: { unitCount: number; totalBytes: number; droppedUnitIds: string[] } | null;
}
```

```ts
// zod request schema for POST /api/aquintutor/lesson
import { z } from 'zod';

export const LessonRequest = z.object({
  action: z.enum(['start', 'complete', 'offline']),
  koId: z.string().uuid(),
  // action:'complete'
  seconds: z.number().int().nonnegative().max(86_400).optional(),
  // action:'offline'
  unitIds: z.array(z.string().uuid()).max(200).optional(),
  tier: z.enum(['lite', 'standard', 'rich']).optional(),
  maxBytes: z.number().int().positive().optional(),
});
export type LessonRequest = z.infer<typeof LessonRequest>;
```

Persistence used (all self-bootstrapped, already in the repo):

| Table | Owner module | Role in this pipeline |
|---|---|---|
| `kernel_objects` / `kernel_edges` | Block 02 | KnowledgeObject payload + prerequisite/translation/variant edges |
| `edu_runtime_trace` | `edu-runtime.ts` | one row per lesson start: `steps` (jsonb), `outcome`, `render_tier`, `context` |
| `edu_progress` | `edu-runtime.ts` | `(user_id, ko_id)` opened/completed/seconds — resume + cognitive-load history |
| `edu_student_settings` | `edu-runtime.ts` | `language`, `accessibility` (jsonb), `learning_style` |
| `aq_mastery` | `aquintutor-learn.ts` | knowledge signal, namespaced `skill_id = 'ko:<uuid>'`, forward-only |
| `edu_offline_packages` / `edu_sync_queue` | `offline-package.ts` | compiled manifest record + reconnect dirty queue |

## 4. Interfaces & API contracts

```ts
// src/lib/runtime/lesson-engine.ts
export async function runLesson(
  user: any, koId: string, request: Request,
  opts?: { offline?: boolean; offlineTier?: RenderTier },
): Promise<{ view: UnitView | null; result: LessonRunResult | null; isStaff: boolean }>;

export async function completeLessonRun(
  userId: string, koId: string, seconds?: number,
): Promise<{ state: 'growing' | 'mastered' }>;

export async function prepareOffline(
  userId: string | null, koId: string, tier?: RenderTier, maxBytes?: number,
): Promise<OfflineManifest>;   // packages the KO + its prerequisite subgraph
```

```ts
// src/pages/api/aquintutor/lesson.ts
// POST /api/aquintutor/lesson
// Auth: locals.user (401 if action !== 'start' and no user)

// Request:  LessonRequest (see §3)
// Response 200 (action:'start'):
//   { ok: true, result: LessonRunResult, isStaff: boolean }
// Response 200 (action:'complete'):
//   { ok: true, state: 'growing' | 'mastered' }
// Response 200 (action:'offline'):
//   { ok: true, manifest: OfflineManifest }
// Errors: 400 bad json / zod fail; 401 sign-in required; 404 unit not found;
//         200 { ok:false, error } for denied/soft failures (matches repo convention)
export const POST: APIRoute;
```

Client-facing shape mirrors the existing `offline/compile.ts` and `learn.ts` endpoints (`json()` helper, `{ ok, ... }` envelope, `locals.user`).

## 5. Core logic / algorithms

### 5.1 The ordered pipeline (exact step order — already in `STEP_ORDER`)
```
check_authentication → load_student_profile
→ estimate_knowledge → estimate_language → estimate_device → estimate_network
→ estimate_accessibility → estimate_learning_style → estimate_cognitive_load
→ build_lesson → compile_lesson → load_resources
→ execute_teaching → monitor_understanding → update_knowledge_graph → save_progress
→ prepare_offline_package        // NEW: appended, opt-in, non-blocking on failure
```
Each step appends `{ step, ok, detail }` to the trace. On `authorized === false`, steps 2..N are recorded as `skipped (unauthorized)` and outcome is `denied` (fail-closed).

### 5.2 Orchestrator control flow (`runLesson`)
```ts
1. view = contentService().getUnitView(koId)            // Block 02
   if !view -> return { view:null, result:null }         // 404 at API layer
2. labels = view.unit.securityLabels ?? ['public']
   authorized = (await can(user, 'read', { type:'KnowledgeObject', securityLabels: labels })).allow
   isStaff    = (await can(user, 'write', { type:'KnowledgeObject' })).allow
3. settings  = user?.id ? getSettings(user.id) : { language:'en', accessibility:{} }
   mastery    = user?.id ? getMastery(user.id) : {}       // aq_mastery, keyed 'ko:<id>'
   signals    = signalsFromHeaders(request.headers)       // Client Hints, zero client JS
   recent     = recentPerf(user?.id)                      // from edu_progress
   variants   = readVariants(await createPgKernel().getObjectGraph(koId)) // translation_of / variant_of edges
4. { trace, assembled } = runPipeline({ authenticated, authorized, unit:view,
        settings, signals, variants,
        masteryOf: id => numericMastery(mastery['ko:'+id]), recent })   // PURE, no I/O
5. persist: INSERT edu_runtime_trace(...); if authorized UPSERT edu_progress(last_position='opened')
6. if opts.offline && outcome !== 'denied':
        manifest = prepareOffline(user?.id, koId, opts.offlineTier ?? assembled.renderPlan.tier)
        trace.step 'prepare_offline_package' = { ok:true, detail: `${manifest.unitCount} units, ${manifest.totalBytes}B` }
   else record 'prepare_offline_package' = { ok:true, detail:'skipped (on-demand)' }
7. return { view, result: toLessonRunResult(trace, assembled, manifest?), isStaff }
```

### 5.3 Prerequisite readiness (knowledge estimate) — DAG over `prerequisite_of` edges
```ts
prerequisites = view.prerequisites.map(p => {
  const m = masteryOf(p.id);                 // 0..1
  return { id:p.id, title:p.title, mastery:m, mastered: m >= 0.6 };
});
notReady = prerequisites.some(p => !p.mastered);
outcome  = authorized ? (notReady ? 'not-ready' : 'served') : 'denied';
// numericMastery: verified|mastered -> 1.0 ; growing -> 0.4 ; present but unknown state -> 0.2 ; absent -> 0
```
The lesson still renders when `not-ready` (with an unmet-prerequisite notice); it is a signal, not a hard block. Direct prerequisites are read from the graph (one hop). For a full transitive gate, walk `edgesTo(id, 'prerequisite_of')` breadth-first with a visited set (cycle-safe) — deferred; v1 uses direct prerequisites only (see §7).

### 5.4 Render-plan compile (`combinePlan`) — device ∧ network ∧ a11y
```ts
RANK = { lite:0, standard:1, rich:2 }
tier = min(estimateDevice(signals).tier, estimateNetwork(signals).tier)   // weakest link wins
if a11y.reduceMotion && tier === 'rich' -> tier = 'standard'              // no heavy animation
hydrate = tier === 'rich' ? ['interactive'] : []                         // lite/standard = pure SSR HTML
plan = { tier, reduceMotion, highContrast, fontScale: fontScale>0?fontScale:1, hydrate }
```
Device heuristics: `deviceMemory<=1` or old Android or viewport<360 → lite; `deviceMemory>=8` → rich. Network: `Save-Data`/`2g`/`slow-2g`/`downlink<1` → lite; `3g` → standard; `4g` → rich. (Block 04 owns these; they are documented v1 heuristics on real Client-Hint inputs.)

### 5.5 Build-lesson variant selection (`build_lesson`)
```ts
served = koId
if language !== 'en' && variants.translations has lang -> served = that variant id
if a11y.screenReader && variants.accessibility.length   -> served = first a11y variant id
```

### 5.6 Completion → knowledge-graph update (forward-only)
```ts
// completeLessonRun(userId, koId, seconds)
prev  = mastery['ko:'+koId]
state = (prev?.state==='growing' || prev?.state==='mastered' || prev?.verified) ? 'mastered' : 'growing'
UPSERT aq_mastery(user_id, 'ko:'+koId, state)          // never downgrades (RANK guard)
UPSERT edu_progress(completed=true, seconds=GREATEST(old, seconds), completed_at=NOW())
```

### 5.7 Offline package (`prepare_offline_package`) — Block 06 delegation
```ts
// prepareOffline: package the KO + its published, permitted prerequisite subgraph
ids = [koId, ...view.prerequisites.map(p => p.id)]
allowed = ids.filter(id => published(id) && can(user,'read',labels(id)).allow)
manifest = compileForUser(userId, allowed, tier, maxBytes)   // budget planner drops low-priority units
```
Runs **only** when explicitly requested (`action:'offline'` or `opts.offline`), never inline on every lesson start (serverless time/memory — see §7).

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). Orchestrator + JSON API + tests done; `lesson-engine.test.ts` **17/17**, `edu-runtime.test.ts` regression **24/24**, `astro check` **zero errors** in touched files (repo total unchanged at 184). Two deliberate deviations: (a) the estimator-extraction step is **dropped** — Block 04 already owns `src/lib/runtime/estimators/` (a directory); creating `estimators.ts` (a file) there would be an ambiguous module path, and edu-runtime's render-tier estimators are already tested where they live; (b) the `prepare_offline_package` step is appended to the trace **in the orchestrator** rather than by mutating `edu-runtime.ts`'s `STEP_ORDER`, keeping the tested pure pipeline stable. Note: DB-touching tests here need `DATABASE_URL` set (any dummy value — `postgres()` is lazy).

- [ ] ~~Create `src/lib/runtime/estimators.ts`~~ — **dropped** (namespace owned by Block 04's `estimators/` dir; edu-runtime estimators stay put, still tested).
- [x] **`src/lib/runtime/lesson-engine.ts`**: `runLesson`, `completeLessonRun`, `prepareOffline` over `startLesson`/`completeLesson`/`compileForUser`; re-exports the pure core; pure `toLessonRunResult` + `offlineTraceStep` mappers; `LessonRequest` zod schema.
- [x] **Offline step** appended to the trace (orchestrator), opt-in and non-blocking on failure.
- [x] **`src/pages/api/aquintutor/lesson.ts`**: `LessonRequest`-validated `start`/`complete`/`offline`; `start` allows guests, `complete`/`offline` require sign-in.
- [ ] **Deferred** — point the SSR `lesson/[id].astro` at `runLesson` (it already calls `startLesson`, the shared core; a cosmetic consolidation).
- [x] **Tests**: denied fail-closed; not-ready on unmastered prereq; render-tier weakest-link + reduce-motion demotion; variant selection; offline-step formatting; forward-only completion. 17/17.
- [ ] **Deferred** — client wiring + trace-inspector offline row (UI).

## 7. Reality checks & risks

**Kernel-metaphor → serverless translations**
- *"Educational Operating Kernel" as a resident, RAM-managing kernel that "schedules learning processes."* → Already correctly built as a **stateless Postgres object store** (`PgKernelStore`, self-bootstrapping DDL). There is no resident process, no in-process scheduler, no kernel-managed RAM. Each lesson request is a Vercel function invocation. Keep it that way.
- *"Load Resources" implying a kernel cache / preloaded RAM working set.* → No resident cache on serverless. Use per-request memoization + CDN/edge caching for published KO reads; if a shared cache is needed later, add an external store (e.g. Vercel KV / Redis). Do **not** assume warm in-memory state between requests.
- *"Prepare Offline Package" as part of the synchronous start pipeline.* → Made **opt-in and separate** (`action:'offline'`). Compiling+pre-rendering a subgraph is time/memory-heavy and would blow the function's latency budget on every lesson open. For large course-wide packages, move to a background job (`src/lib/job-queue.ts`) and return a poll/deferred manifest.

**Out of scope for THIS block (belongs to sibling subsystems, not the request-scoped lesson start)**
- *Live "Execute Teaching / Monitor Understanding" as a continuous real-time loop over teacher audio, camera, digital pen, whiteboard, speech/gesture/equation/diagram recognition (Vol 1 pp 23–25).* → This block's `execute_teaching`/`monitor_understanding` steps only mark "served" and "awaiting completion/resume signal." The realtime classroom capture pipeline is a distinct subsystem (repo already has `board-speech.ts`, `board-session.ts`, plus a `board-vision.test.ts` scaffold for the not-yet-built vision module); it feeds recognized concepts into the kernel graph, which this runtime then reads.
- *Real-time generation of high-quality slides / 2D animation / 3D simulation at the moment of teaching, grounded by live web search.* → Not feasible inside a serverless request (latency, cost, non-determinism). These must be **precomputed** into `AnimationObject`/`SimulationObject`/`LaboratoryObject` kernel objects (Block 05 rendering + `job-queue.ts` + `@vercel/blob`), then referenced by edges; the runtime only selects and serves them by tier.
- *"All Indian languages, real-time translation" per request.* → Model per-request MT is out of scope; translations are **precomputed `translation_of` variant objects** selected in `build_lesson`. Missing-language fallback = base unit (already implemented).
- *Web-search "authenticate with bona fide sources while teaching."* → Source-grounding is an **authoring/research-time** concern (`aquintutor-research.ts`, authoring flow), not a lesson-execution step. The runtime serves already-published, source-checked content.

**External services required**
- Postgres (Neon/postgres-js) — the only hard dependency for state.
- `@vercel/blob` — for offline manifest assets / prerendered media (Block 05/06).
- (Optional, future) external cache for hot published KOs; background queue for large offline compiles.

**v1 heuristics / decisions needing a human**
- `estimate_learning_style` and `estimate_cognitive_load` are **heuristic stubs** (learning style = stored preference or `balanced`; cognitive load from recent completion count/avg seconds). Real modeling (BKT/IRT — note `src/lib/irt.ts` exists) is out of scope here; decide whether Block 04 upgrades these.
- Prerequisite gating uses **direct prerequisites only**; transitive/topological readiness across the DAG is specced in §5.3 but deferred. Decide the mastery threshold (currently `0.6`) and whether `not-ready` should ever hard-block (currently it never does).
- No post-quantum crypto / "autonomous cyber defense" appears in this slice; session auth stays on the existing `@oslojs/crypto` sessions + RBAC. If the broader spec asserts those, treat them as out-of-scope for the lesson runtime.
