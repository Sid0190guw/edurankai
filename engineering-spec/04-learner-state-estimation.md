# Engineering Block 04 — Learner State Estimation

| Field | Value |
|---|---|
| **Spec source** | Vol 1-7 pp 16–26 — "Educational Intelligence Runtime", "Student Adaptation", "Real-time Translation" |
| **Repo target** | Create `src/lib/runtime/estimators/*.ts` (types, knowledge/BKT, language, device, network, accessibility, learningStyle, cognitiveLoad, index, persistence); create `src/pages/api/runtime/{observe,signals,learner-state}.ts`; extend `src/lib/kernel/repository.ts` with one non-lifecycle `patchLearningMetadata`; persist state in `kernel_objects(type='StudentObject').learning_metadata`. |
| **Status** | partial — persistence substrate (`kernel_objects.learning_metadata`, `KernelRepository`, `PgKernelStore`) already-implemented; the estimator module and endpoints are greenfield. |
| **Depends on** | Block 01 (Kernel Object & Edge Store — `src/lib/kernel`), Block 03 (Concept graph / `prerequisite_of` edges). Feeds the downstream Lesson-Build block. |

## 1. Purpose
Given a student and a stream of interaction signals, compute a compact **learner state**: per-concept mastery (probability the learner knows each concept), plus preferred language, device capability tier, network tier, accessibility needs, content-modality preference, and current cognitive load. Mastery is tracked with **Bayesian Knowledge Tracing (BKT)**, an online recursive filter, so each new observation updates state without replaying history. The state is persisted on the student's kernel object (`learning_metadata`) and read by lesson-build to choose the next concept, render tier (3D/2D/text), translation, accessibility variants, and pacing.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/kernel/schema.ts` — `kernel_objects.learning_metadata jsonb NOT NULL DEFAULT '{}'` is the persistence slot the task mandates. Self-bootstrapped via `KERNEL_DDL`.
- `src/lib/kernel/types.ts` — `StudentObjectData`, `LearningMetadata`, `KernelObject`, `RelationshipType` (incl. `'prerequisite_of'`, `'assesses'`). Student object token is `'StudentObject'`.
- `src/lib/kernel/repository.ts` — `KernelRepository.getObject`, `listByType`, `getObjectGraph`, `addRelationship`. Provides prerequisite edges for next-concept selection.
- `src/lib/kernel/store.ts` — `PgKernelStore` (production) / `InMemoryKernelStore` (tests). `createPgKernel()` in `index.ts`.
- `src/lib/db/index.ts` — `db` (Drizzle/postgres-js). `src/lib/llm/gateway.ts` — optional LLM for language detection if needed.
- `src/pages/api/` — Astro SSR endpoint convention.

**To build:**
- `src/lib/runtime/estimators/` — one estimator per Estimate* step + shared types + BKT math + orchestrator + persistence helpers.
- `src/pages/api/runtime/observe.ts`, `signals.ts`, `learner-state.ts` — ingest observations/signals, return learner state.
- One additive method on `KernelRepository`: `patchLearningMetadata(id, patch)` — merges into `learning_metadata` **without** forcing a lifecycle transition (student state is written at high frequency; `updateObject` would churn `version`/lifecycle every keystroke).

## 3. Data model

State lives in `learning_metadata` under a namespaced `learnerState` key so it coexists with the existing `LearningMetadata` fields (`difficulty`, `languages`, …).

```ts
// src/lib/runtime/estimators/types.ts
import type { LearningMetadata } from '@/lib/kernel';

// ---- Knowledge / BKT ----
export interface ConceptMastery {
  pL: number;            // P(L_t): posterior probability the learner knows the concept, 0..1
  pT: number;            // P(T): transit — prob. of learning between opportunities
  pG: number;            // P(G): guess — prob. correct while NOT knowing
  pS: number;            // P(S): slip  — prob. incorrect while knowing
  attempts: number;
  lastCorrect?: boolean;
  updatedAt: string;     // ISO
}
export type MasteryMap = Record<string, ConceptMastery>; // conceptObjectId -> mastery

// ---- Non-knowledge estimators ----
export type DeviceTier = 'low' | 'mid' | 'high';
export type RenderTier = '3d' | '2d' | 'text';
export interface DeviceEstimate {
  tier: DeviceTier;
  webgl: boolean;
  cores?: number;
  deviceMemoryGb?: number;
  maxRender: RenderTier;   // hand-off to lesson-build renderer selection
}

export type NetworkTier = 'slow' | 'moderate' | 'fast';
export interface NetworkEstimate {
  tier: NetworkTier;
  downlinkMbps?: number;
  rttMs?: number;
  saveData: boolean;
  assetBudgetKb: number;   // per-lesson asset ceiling for lesson-build
}

export interface AccessibilityEstimate {
  reducedMotion: boolean;
  highContrast: boolean;
  captions: boolean;
  screenReader: boolean;
  variants: string[];      // e.g. ['reduced-motion','high-contrast','text-only'] -> KnowledgeObject variant_of edges
}

export interface LanguageEstimate {
  preferred: string;       // BCP-47, e.g. 'hi-IN'
  fallbacks: string[];     // ordered BCP-47 tags
  needsTranslation: boolean;
}

export type Modality = 'visual' | 'verbal' | 'interactive' | 'example';
export interface LearningStyleEstimate {
  weights: Record<Modality, number>;  // sums to ~1
  dominant: Modality;
  confidence: number;      // 0..1 — low until enough observations (see §7 risk)
}

export type LoadBand = 'low' | 'optimal' | 'high';
export interface CognitiveLoadEstimate {
  load: number;            // 0..1 (0 idle, 1 overloaded)
  band: LoadBand;
  recommendedNewConcepts: number;  // pacing hint for lesson-build
}

// ---- Aggregate persisted on StudentObject.learning_metadata.learnerState ----
export interface LearnerState {
  schemaVersion: 1;
  mastery: MasteryMap;
  language: LanguageEstimate;
  device: DeviceEstimate;
  network: NetworkEstimate;
  accessibility: AccessibilityEstimate;
  learningStyle: LearningStyleEstimate;
  cognitiveLoad: CognitiveLoadEstimate;
  updatedAt: string;       // ISO
}

// Typed extension of the kernel's free-form learning_metadata jsonb.
export interface StudentLearningMetadata extends LearningMetadata {
  learnerState?: LearnerState;
}

// ---- Estimator contract ----
export interface Estimator<In, Out> {
  readonly name: string;
  estimate(input: In, prior?: Out): Out;   // pure; prior enables online/recursive update
}

// ---- Raw signal payloads (client-reported; see §7 — server cannot probe the device) ----
export interface DeviceSignals { cores?: number; deviceMemoryGb?: number; webgl?: boolean; userAgent?: string; }
export interface NetworkSignals { effectiveType?: '2g'|'3g'|'4g'|'slow-2g'; downlinkMbps?: number; rttMs?: number; saveData?: boolean; }
export interface AccessibilitySignals { reducedMotion?: boolean; highContrast?: boolean; screenReader?: boolean; captions?: boolean; }
export interface ObservationSignal {
  conceptId: string;
  correct: boolean;
  responseMs?: number;
  hintsUsed?: number;
  modality?: Modality;     // which content modality preceded this attempt
}
```

Zod schemas (validate at the API boundary, repo convention):

```ts
// src/lib/runtime/estimators/schema.ts
import { z } from 'zod';

export const modality = z.enum(['visual', 'verbal', 'interactive', 'example']);

export const observationSignalSchema = z.object({
  conceptId: z.string().min(1),
  correct: z.boolean(),
  responseMs: z.number().nonnegative().optional(),
  hintsUsed: z.number().int().nonnegative().optional(),
  modality: modality.optional(),
});

export const deviceSignalsSchema = z.object({
  cores: z.number().int().positive().optional(),
  deviceMemoryGb: z.number().positive().optional(),
  webgl: z.boolean().optional(),
  userAgent: z.string().max(512).optional(),
});
export const networkSignalsSchema = z.object({
  effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).optional(),
  downlinkMbps: z.number().nonnegative().optional(),
  rttMs: z.number().nonnegative().optional(),
  saveData: z.boolean().optional(),
});
export const accessibilitySignalsSchema = z.object({
  reducedMotion: z.boolean().optional(),
  highContrast: z.boolean().optional(),
  screenReader: z.boolean().optional(),
  captions: z.boolean().optional(),
});

export const signalsBodySchema = z.object({
  studentObjectId: z.string().uuid(),
  device: deviceSignalsSchema.optional(),
  network: networkSignalsSchema.optional(),
  accessibility: accessibilitySignalsSchema.optional(),
  languagePrefs: z.array(z.string()).max(10).optional(),  // BCP-47, client-selected
});

export const observeBodySchema = z.object({
  studentObjectId: z.string().uuid(),
  observation: observationSignalSchema,
});
```

## 4. Interfaces & API contracts

**Pure estimator functions** (one per Estimate* step):

```ts
// src/lib/runtime/estimators/knowledge.ts
export const DEFAULT_BKT = { pL: 0.20, pT: 0.15, pG: 0.20, pS: 0.10 } as const;
export function initMastery(now: string, params?: Partial<typeof DEFAULT_BKT>): ConceptMastery;
export function bktUpdate(m: ConceptMastery, correct: boolean, now: string): ConceptMastery;
export function bktPredictCorrect(m: ConceptMastery): number;    // P(correct next)
export function isMastered(m: ConceptMastery, threshold?: number): boolean; // default 0.95

// language.ts / device.ts / network.ts / accessibility.ts / learningStyle.ts / cognitiveLoad.ts
export const languageEstimator: Estimator<{ acceptLanguage?: string; prefs?: string[] }, LanguageEstimate>;
export const deviceEstimator: Estimator<DeviceSignals, DeviceEstimate>;
export const networkEstimator: Estimator<NetworkSignals, NetworkEstimate>;
export const accessibilityEstimator: Estimator<AccessibilitySignals, AccessibilityEstimate>;
export const learningStyleEstimator: Estimator<{ modality: Modality; engaged: boolean }, LearningStyleEstimate>;
export const cognitiveLoadEstimator:
  Estimator<{ errorRate: number; latencyRatio: number; hintRate: number }, CognitiveLoadEstimate>;
```

**Persistence helpers** (read/write `StudentObject.learning_metadata.learnerState`):

```ts
// src/lib/runtime/estimators/persistence.ts
import type { KernelRepository } from '@/lib/kernel';
export function emptyLearnerState(now: string): LearnerState;
export async function loadLearnerState(kernel: KernelRepository, studentObjectId: string): Promise<LearnerState>;
export async function saveLearnerState(kernel: KernelRepository, studentObjectId: string, s: LearnerState): Promise<void>;
```

**Orchestrator + lesson-build hand-off:**

```ts
// src/lib/runtime/estimators/index.ts
export async function applyObservation(
  kernel: KernelRepository, studentObjectId: string, o: ObservationSignal,
): Promise<{ mastery: ConceptMastery; predictedCorrect: number; cognitiveLoad: CognitiveLoadEstimate }>;

export async function applySignals(
  kernel: KernelRepository, studentObjectId: string,
  input: { acceptLanguage?: string; device?: DeviceSignals; network?: NetworkSignals;
           accessibility?: AccessibilitySignals; languagePrefs?: string[] },
): Promise<LearnerState>;

// Reads mastery + prerequisite_of edges; returns next concepts for lesson-build.
export async function selectNextConcepts(
  kernel: KernelRepository, studentObjectId: string, courseConceptIds: string[], limit?: number,
): Promise<string[]>;
```

**Astro API endpoints** (`APIRoute` per repo convention):

| Method | Path | Request body | Response |
|---|---|---|---|
| `POST` | `/api/runtime/observe` | `{ studentObjectId, observation: ObservationSignal }` | `{ mastery: ConceptMastery, predictedCorrect: number, cognitiveLoad: CognitiveLoadEstimate }` |
| `POST` | `/api/runtime/signals` | `{ studentObjectId, device?, network?, accessibility?, languagePrefs? }` (server also reads `Accept-Language`) | `{ learnerState: LearnerState }` |
| `GET`  | `/api/runtime/learner-state?studentObjectId=<uuid>` | — | `{ learnerState: LearnerState }` |

All return `400` on Zod failure, `404` if the object is not a `StudentObject`, `401` if the session user is not the object owner (via `src/lib/auth` + `permissions`).

## 5. Core logic / algorithms

### 5.1 Bayesian Knowledge Tracing (per concept, online)
Four parameters per concept: `P(L0)` prior, `P(T)` transit, `P(G)` guess, `P(S)` slip.

**Step A — condition on the observation** (Bayes' rule):
- If **correct**: `P(Lₜ | correct) = P(Lₜ₋₁)(1−S) / [ P(Lₜ₋₁)(1−S) + (1−P(Lₜ₋₁))·G ]`
- If **incorrect**: `P(Lₜ | incorrect) = P(Lₜ₋₁)·S / [ P(Lₜ₋₁)·S + (1−P(Lₜ₋₁))(1−G) ]`

**Step B — apply learning** (the concept may be learned this opportunity):
- `P(Lₜ) = P(Lₜ | obs) + (1 − P(Lₜ | obs))·T`

**Prediction** of next-attempt correctness: `P(correct) = P(Lₜ)(1−S) + (1−P(Lₜ))·G`.

```ts
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function bktUpdate(m: ConceptMastery, correct: boolean, now: string): ConceptMastery {
  const { pL, pT, pG, pS } = m;
  const num = correct ? pL * (1 - pS) : pL * pS;
  const den = correct ? pL * (1 - pS) + (1 - pL) * pG
                      : pL * pS       + (1 - pL) * (1 - pG);
  const posterior = den > 0 ? num / den : pL;          // guard: degenerate params
  const pLnext = posterior + (1 - posterior) * pT;     // learning step
  return { ...m, pL: clamp01(pLnext), attempts: m.attempts + 1, lastCorrect: correct, updatedAt: now };
}

export function bktPredictCorrect(m: ConceptMastery): number {
  return clamp01(m.pL * (1 - m.pS) + (1 - m.pL) * m.pG);
}
export function isMastered(m: ConceptMastery, threshold = 0.95): boolean { return m.pL >= threshold; }
```
Recursive ⇒ only the posterior is persisted; no raw history replay (matches serverless + the recursive filter).

### 5.2 Cognitive load (per-attempt window)
Blend three normalized signals into `[0,1]`; band drives pacing.
```ts
// errorRate, hintRate ∈ [0,1]; latencyRatio = observed / expected responseMs (clamped)
export function estimateLoad(errorRate: number, latencyRatio: number, hintRate: number): CognitiveLoadEstimate {
  const load = clamp01(0.5 * errorRate + 0.3 * clamp01((latencyRatio - 1) / 2) + 0.2 * hintRate);
  const band: LoadBand = load < 0.33 ? 'low' : load <= 0.66 ? 'optimal' : 'high';
  const recommendedNewConcepts = band === 'high' ? 1 : band === 'optimal' ? 2 : 3;
  return { load, band, recommendedNewConcepts };
}
```
`errorRate`/`hintRate` are exponential moving averages over the last N attempts (kept in `learnerState` implicitly via the single running load value with EMA α≈0.3). `expected responseMs` baseline is per-difficulty (see §7 — needs calibration; default 15000 ms until data exists).

### 5.3 Device / Network / Accessibility / Language (deterministic mapping)
```ts
export function estimateDevice(s: DeviceSignals): DeviceEstimate {
  const cores = s.cores ?? 4, mem = s.deviceMemoryGb ?? 4, webgl = s.webgl ?? true;
  const tier: DeviceTier = (!webgl || mem < 2 || cores < 2) ? 'low'
                         : (mem >= 8 && cores >= 8)          ? 'high' : 'mid';
  const maxRender: RenderTier = !webgl ? 'text' : tier === 'low' ? '2d' : '3d';
  return { tier, webgl, cores: s.cores, deviceMemoryGb: s.deviceMemoryGb, maxRender };
}

export function estimateNetwork(s: NetworkSignals): NetworkEstimate {
  const et = s.effectiveType;
  const tier: NetworkTier = (et === 'slow-2g' || et === '2g' || (s.downlinkMbps ?? 10) < 1) ? 'slow'
                          : (et === '3g' || (s.downlinkMbps ?? 10) < 5)                     ? 'moderate' : 'fast';
  const assetBudgetKb = s.saveData ? 300 : tier === 'slow' ? 500 : tier === 'moderate' ? 2000 : 8000;
  return { tier, downlinkMbps: s.downlinkMbps, rttMs: s.rttMs, saveData: !!s.saveData, assetBudgetKb };
}

export function estimateLanguage(acceptLanguage?: string, prefs?: string[]): LanguageEstimate {
  // explicit user selection wins; else first Accept-Language tag; else en
  const fromHeader = (acceptLanguage ?? '').split(',').map(t => t.split(';')[0].trim()).filter(Boolean);
  const ordered = [...(prefs ?? []), ...fromHeader, 'en'];
  const preferred = ordered[0];
  return { preferred, fallbacks: [...new Set(ordered.slice(1))], needsTranslation: !preferred.startsWith('en') };
}
```
Accessibility maps toggles → `variants[]` that lesson-build resolves against `variant_of` KnowledgeObject edges (`text-only` when `screenReader`, `high-contrast`, `reduced-motion`, `captions`).

### 5.4 Prerequisite-aware next-concept selection (hand-off to lesson-build)
Prerequisites are `p -[prerequisite_of]-> c` edges, i.e. the **incoming** edges of a concept. The
kernel exposes them via `KernelRepository.getObjectGraph(id)` (`{ object, outgoing, incoming }`);
the store-level `edgesTo` is **not** on the repository, so we read `graph.incoming`.
```ts
// src/lib/runtime/estimators/index.ts
export async function selectNextConcepts(
  kernel: KernelRepository, studentObjectId: string, courseConceptIds: string[], limit = 3,
): Promise<string[]> {
  const state = await loadLearnerState(kernel, studentObjectId);
  const now = new Date().toISOString();
  const mastered = (id: string) => isMastered(state.mastery[id] ?? initMastery(now));

  const eligible: { id: string; gap: number }[] = [];
  for (const c of courseConceptIds) {
    const m = state.mastery[c] ?? initMastery(now);
    if (isMastered(m)) continue;                                  // skip learned concepts
    const graph = await kernel.getObjectGraph(c);                 // repo API, not store.edgesTo
    const prereqIds = graph.incoming
      .filter((e) => e.type === 'prerequisite_of')                // p -[prerequisite_of]-> c
      .map((e) => e.fromId);
    if (prereqIds.every(mastered)) eligible.push({ id: c, gap: 1 - m.pL }); // unblocked & unlearned
  }
  eligible.sort((a, b) => b.gap - a.gap);                          // widest knowledge gap first
  const cap = Math.min(limit, state.cognitiveLoad.recommendedNewConcepts);
  return eligible.slice(0, cap).map((e) => e.id);
}
```
Cycle-safety: prerequisite edges are assumed acyclic (enforced upstream in Block 03); selection only inspects direct prerequisites, so a stray cycle cannot loop this function.

### 5.5 Persistence (no lifecycle churn)
```ts
// src/lib/runtime/estimators/persistence.ts
export async function saveLearnerState(
  kernel: KernelRepository, studentObjectId: string, state: LearnerState,
): Promise<void> {
  const obj = await kernel.getObject(studentObjectId);
  if (!obj || obj.type !== 'StudentObject') throw new Error(`not a StudentObject: ${studentObjectId}`);
  await kernel.patchLearningMetadata(studentObjectId, {
    learnerState: { ...state, updatedAt: new Date().toISOString() },
  });
}
```
The new additive repo method mirrors the kernel's existing `patchMeta` (a non-lifecycle merge):
```ts
// added to src/lib/kernel/repository.ts — no assertTransition, no version++
async patchLearningMetadata(
  id: string, patch: Partial<LearningMetadata> & Record<string, unknown>,
): Promise<KernelObject> {
  const o = await this.load(id);
  if (o.lifecycleState === 'deleted') throw new Error('object is deleted');
  o.learningMetadata = { ...o.learningMetadata, ...patch };   // shallow merge
  o.updatedAt = nowISO();
  await this.store.updateObject(o);
  return o;
}
```
`store.updateObject` rewrites the whole row (read-modify-write), so under concurrent high-frequency writes the last writer wins across all columns. If that loss is unacceptable, add a jsonb-atomic store method instead of a full-row write (see §7): `UPDATE kernel_objects SET learning_metadata = learning_metadata || $patch::jsonb, updated_at = now() WHERE id = $id`.

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). Steps 1–9 done; `estimators.test.ts` **26/26** (pure BKT + estimators + orchestrator over `InMemoryKernelStore`), kernel regression **63/63**, `astro check` **zero errors** in touched files (repo total unchanged at 184). Steps 10 (browser client-shim JS) and 11 (calibration backlog) deferred — client/data-science, not engine. Note: the per-estimator files were consolidated into one `estimators.ts` (device/network/accessibility/language/learningStyle/cognitiveLoad) rather than six files. Fixed a spec typing bug: `Partial<typeof DEFAULT_BKT>` (with `as const`) forces literal types; replaced with a `BktParams` number type.

1. [x] `src/lib/runtime/estimators/types.ts` — all interfaces from §3.
2. [x] `src/lib/runtime/estimators/schema.ts` — zod boundary schemas.
3. [x] `src/lib/runtime/estimators/knowledge.ts` — `BktParams`, `DEFAULT_BKT`, `initMastery` (with G/S<0.5 identifiability clamp), `bktUpdate`, `bktPredictCorrect`, `isMastered`.
4. [x] `src/lib/runtime/estimators/estimators.ts` — `estimateDevice`/`estimateNetwork`/`estimateAccessibility`/`estimateLanguage`/`estimateLoad` + learning-style EMA (consolidated file).
5. [x] `src/lib/runtime/estimators/persistence.ts` — `emptyLearnerState`, `loadLearnerState`, `saveLearnerState`.
6. [x] `KernelRepository.patchLearningMetadata(id, patch)` (non-lifecycle merge) added.
7. [x] `src/lib/runtime/estimators/index.ts` — `applyObservation`, `applySignals`, `selectNextConcepts`.
8. [x] Tests: BKT monotonicity, mastery threshold, identifiability clamp, prerequisite gating (in-memory kernel), device/network tiering, load banding. 26/26.
9. [x] `src/pages/api/runtime/{observe,signals,learner-state}.ts` — zod-validated, `createPgKernel()`, owner-gated (403 non-owner).
10. [ ] **Deferred** — browser client-shim that probes `navigator.*` / media queries and POSTs `/api/runtime/signals`.
11. [ ] **Deferred/backlog** — BKT parameter-fitting job; raw-observation analytics table.

## 7. Reality checks & risks

**Kernel/OS metaphor → serverless reality**
- Spec's "Educational Intelligence Runtime / Student Adaptation" as a **resident process that continuously understands the live lecture** is a metaphor. Realized here as **stateless request handlers** (`/api/runtime/*`) + **Postgres-persisted state** (`learning_metadata`). BKT is a recursive filter, so no in-memory session or replay is required — each invocation loads posteriors, updates, writes back.
- Spec's **"real-time" per-lecture adaptation** cannot hold a live socket per learner cheaply on Vercel functions. Use client-batched short POSTs (or edge). Live audio/gesture/whiteboard ingestion pipelines are **out of scope for this block**.

**External / client-side dependencies**
- **Device, network, WebGL cannot be probed server-side.** The server only reads `Accept-Language`. `cores`, `deviceMemory`, WebGL support, `navigator.connection`, and `prefers-*` media queries **must be client-reported** via `/api/runtime/signals` (task 10). Without the client shim, estimators fall back to safe mid-tier defaults.
- `navigator.deviceMemory` / Network Information API are **not available in all browsers** (notably Safari) — degrade to defaults, never block lesson-build.

**Data / correctness risks**
- **Concurrent writes race:** parallel serverless invocations doing read-modify-write on `learning_metadata` can clobber each other. Mitigation: jsonb-atomic `||` merge in Postgres (§5.5) or an optimistic `version` check. Decision for a human: acceptable to lose the occasional signal, or enforce strict serialization?
- **BKT parameters (T, G, S) need fitting** from historical response data (EM or brute-force grid search per concept). Cold start uses `DEFAULT_BKT`; a **background calibration job** is out of scope here and needs data-science sign-off. Identifiability caveat: if `G + S ≥ 1` the model degenerates — clamp `G < 0.5`, `S < 0.5`.
- **Cognitive-load baseline** (`expected responseMs`) is guessed (15 s) until per-difficulty timing data exists; the load number is heuristic, not validated.

**Contested / minimal-by-design**
- **Learning styles** (VARK-style) are **scientifically contested**; the spec's "Student Adaptation" is vague on this. Implemented minimally as a **content-modality engagement preference** (which modality precedes engaged/correct attempts), tagged `confidence` (low early). Human decision: use it only for soft ordering, **not** to gate content away from any learner. Flagged as a deliberate minimal version because the source does not specify learning-style mechanics.
- **Type-token mismatch:** the task wrote `type='student'`; the repo's actual object token is **`'StudentObject'`** (`OBJECT_TYPES` in `src/lib/kernel/types.ts`). This block uses `'StudentObject'`.
- **No existing interaction/telemetry table** in the repo. Because BKT is recursive, only posteriors are persisted (in `learning_metadata`); a full raw-observation log is **optional analytics, out of scope** (would follow the repo's self-bootstrapping `CREATE TABLE IF NOT EXISTS` pattern if added).
- **Block dependency numbering** (Block 01 / Block 03) is inferred from module boundaries, not a confirmed spec index — reconcile with the master block list.
