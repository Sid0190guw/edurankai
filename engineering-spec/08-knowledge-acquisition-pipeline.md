# Engineering Block 08 — Knowledge Acquisition Pipeline

| Field | Value |
|---|---|
| **Spec source** | Vol 1–7 pp 44–56 — "Configuration Validation & Runtime Configuration Snapshot" (validate → freeze → structured validation report), "Educational Prediction / Cross-Verification of Educational Evidence", "Runtime Scheduler"; block focus list: Unknown Concept → Identify Subject/Domain → Search Trusted Sources → Filter Sources → Rank Reliability → Cross Verification → Extract Concepts → Build Temporary Knowledge Graph → Generate Explanation/Animation/Simulation → Show Teacher → Teacher Approval → Store as Verified Knowledge |
| **Repo target** | **new** `src/lib/knowledge-acquisition/` (`types.ts`, `source-trust.ts`, `extract.ts`, `pipeline.ts`, `store.ts`, `index.ts`); **extend** `src/lib/kernel/lifecycle.ts` (a discard transition for rejected drafts); reuse `src/lib/kernel-content.ts` (`ContentService`) + `src/lib/llm/gateway.ts` + `src/lib/rbac` `can()`; **new** endpoints `src/pages/api/aquintutor/acquire.ts` and `src/pages/api/admin/knowledge-review.ts`; optional review UI `src/pages/admin/aquintutor/knowledge-review.astro` |
| **Status** | greenfield — the orchestration, source-trust scoring and review workflow are new, but they are built entirely on existing substrate (kernel object store + lifecycle, LLM gateway, RBAC audit); no new object store is introduced |
| **Depends on** | Block 01 — Kernel Object Store, Lifecycle & Edges (`src/lib/kernel/*`); Block 02 — Knowledge Object & Graph (candidate concepts join the `prerequisite_of` DAG; reuse the cycle guard + `related_to`); RBAC (`src/lib/rbac` `can()`, `'execute'` publish gate, audit sink); the LLM gateway (`src/lib/llm/gateway.ts`, `guardrails.ts`); Block 05 — Adaptive Rendering (the generated Animation/Simulation objects render through `SceneGL` / `POST /api/aquintutor/generate-animation`) |

---

## 1. Purpose

When a learner (or teacher) hits a concept the platform has no **published** `KnowledgeObject` for, run a bounded, auditable pipeline that: classifies the subject/domain, collects candidate sources from a **trusted-source allowlist** (via a pluggable search provider or teacher-supplied URLs), scores each source's reliability with a deterministic function, keeps only sources that pass a trust threshold, cross-verifies each extracted claim against ≥ N independent trusted domains, then uses the LLM gateway to extract a structured concept + explanation (+ optional animation prompt / simulation descriptor). The pipeline writes the result as **draft** kernel objects (`ConceptObject` / `KnowledgeObject` / `AnimationObject` / `SimulationObject`) in lifecycle state `created` — invisible to learners — and enqueues the run for human review. A teacher with the `'execute'` capability approves (walking each object `created → validated → indexed → published`) or rejects (discard). Only approved objects become verified, learner-visible knowledge. Every stage is stateless and per-request; run state lives in Postgres.

---

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- Object store + lifecycle + edges — `src/lib/kernel/*`: `KernelRepository` (`createObject`, `buildKnowledgeObject`, `validateObject`, `indexObject`, `publishObject`, `archiveObject`, `addRelationship`, `patchMeta`, `getObjectGraph`), `PgKernelStore`/`createPgKernel`, and the state machine in `lifecycle.ts` (`created→validated→indexed→published→…`).
- Object types already cover the pipeline output — `ConceptObject`, `KnowledgeObject`, `AnimationObject`, `SimulationObject` and relationship types `part_of`, `references`, `prerequisite_of` — `src/lib/kernel/types.ts`; Zod payload validation at the `created→validated` step — `src/lib/kernel/validation.ts`.
- Content authoring service (create/attach/prereq/**publish walk**/archive over the real lifecycle) — `src/lib/kernel-content.ts` (`ContentService.publishUnit` already walks `created→validated→indexed→published`; `contentService()` singleton on `createPgKernel()`).
- LLM gateway — `src/lib/llm/gateway.ts`: `getConfig`, `isReady`, `chat(system, messages, cfg)`, `activeModel`, `logUsage`, `logTrainingExample`, `underRateLimit`; guardrails — `src/lib/llm/guardrails.ts`.
- Existing prompt→animation generator (reuse for the "Generate Animation" stage) — `POST /api/aquintutor/generate-animation` returns a sandbox-safe `frame(ctx,t,w,h)` body with a `BANNED` regex check.
- RBAC — `src/lib/rbac`: `can(user, cap, res, ctx)` (evaluates **and audits**), `requireCapability`, `ForbiddenError`; capability set includes `create`/`write`/`execute`/`manage`/`audit`; the existing `POST /api/admin/knowledge.ts` already uses `can(user,'execute',{type:'KnowledgeObject'})` as the **publish gate** — that same gate is the teacher-approval gate here.
- Self-bootstrap DB convention (`CREATE TABLE IF NOT EXISTS` on first use) — `src/lib/llm/gateway.ts` `ensureLlmSchema()`, `src/lib/kernel/store.ts` `KERNEL_DDL`; DB access via `db.execute(sql\`…\`)` — `src/lib/db/index.ts` exports the `db` handle — with the per-module `rows(r)` normaliser (`Array.isArray(r) ? r : r?.rows ?? []`) copied into each `src/lib/*` module that runs raw SQL.
- Audit table — `audit_log` (`src/lib/db/schema.ts`), plus RBAC `writeAudit`.

**Build / extend in this block:**
- **`src/lib/knowledge-acquisition/source-trust.ts` (new)** — the deterministic `scoreSource()` reliability function, `filterSources()`, and `crossVerify()` (the "Rank Reliability" + "Filter" + "Cross Verification" stages). Pure, no I/O, unit-testable.
- **`src/lib/knowledge-acquisition/extract.ts` (new)** — the LLM extraction call + strict Zod schema for its JSON output ("Extract Concepts").
- **`src/lib/knowledge-acquisition/pipeline.ts` (new)** — the stage orchestrator (`classify → search → score/filter → verify → extract → buildDrafts → generate media`), plus `approveRun()` / `rejectRun()`.
- **`src/lib/knowledge-acquisition/store.ts` (new)** — self-bootstrapping `knowledge_source_registry`, `knowledge_acquisition_runs`, `knowledge_acquisition_sources` tables + CRUD.
- **`src/lib/knowledge-acquisition/types.ts` / `index.ts` (new)** — shared types + a `SourceSearchProvider` port (default `NullSourceSearch`; adapters for an external web-search API are out-of-scope wiring, see §7).
- **Extend `src/lib/kernel/lifecycle.ts`** — add a discard path (`created|validated|indexed → archived`) so a **rejected draft** can be archived without ever being published (decision flagged in §7).
- **`POST/GET /api/aquintutor/acquire.ts` (new)** — trigger + poll a run (staged execution to respect function timeout).
- **`GET/POST /api/admin/knowledge-review.ts` (new)** — teacher review queue + approve/reject (RBAC `'execute'`-gated, audited).

---

## 3. Data model

The **candidate knowledge** is stored as ordinary `kernel_objects` (no new object type), so it inherits the lifecycle/edges/validation of Block 01. Only the **pipeline run bookkeeping** and the **trusted-source registry** get their own self-bootstrapping tables.

### 3.1 Provenance stamped onto every candidate object (`metadata.acquisition`)

```ts
// src/lib/knowledge-acquisition/types.ts
export interface AcquisitionProvenance {
  runId: string;
  query: string;                 // the unknown concept / learner question
  subject: string;
  domain: string;                // domain family key used for recency decay (see §5.2)
  model: string;                 // activeModel(cfg) that produced the extraction
  consensusScore: number;        // 0..1 from crossVerify()
  sources: { url: string; domain: string; reliability: number }[];
  extractedAt: string;           // ISO
  pending: boolean;              // true until a teacher approves; audit trail after
}
```

```ts
// Zod guard (metadata is untrusted-ish; keep it bounded)
import { z } from 'zod';
export const ProvenanceSchema = z.object({
  runId: z.string().uuid(),
  query: z.string().min(1).max(2000),
  subject: z.string().max(80),
  domain: z.string().max(80),
  model: z.string().max(120),
  consensusScore: z.number().min(0).max(1),
  sources: z.array(z.object({
    url: z.string().url().max(2000), domain: z.string().max(255), reliability: z.number().min(0).max(1),
  })).max(50),
  extractedAt: z.string(),
  pending: z.boolean(),
});
```

### 3.2 New tables — `src/lib/knowledge-acquisition/store.ts`

Drizzle definitions (add `export * from '@/lib/knowledge-acquisition/schema'` to `src/lib/db/schema.ts` for `db:push`, **or** rely on the self-bootstrap DDL below — same pattern as `kernel` / `ai_llm_config`):

```ts
import { pgTable, uuid, text, integer, real, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Trusted-source allowlist / denylist + reliability tier (editorially seeded — see §7).
export const knowledgeSourceRegistry = pgTable('knowledge_source_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: text('domain').notNull(),                 // registrable domain, e.g. 'nist.gov'
  sourceType: text('source_type').notNull().default('unknown'), // SourceType (§5.1)
  tier: integer('tier').notNull().default(3),       // 1..4, 1 = highest trust
  listing: text('listing').notNull().default('allow'), // 'allow' | 'deny'
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ domainUx: uniqueIndex('ksr_domain_ux').on(t.domain) }));

// One row per pipeline run — the state machine of the acquisition itself.
export const knowledgeAcquisitionRuns = pgTable('knowledge_acquisition_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  query: text('query').notNull(),
  requestedBy: uuid('requested_by'),                // users.id (nullable)
  subject: text('subject').notNull().default(''),
  domain: text('domain').notNull().default(''),
  status: text('status').notNull().default('queued'), // RunStatus (§4)
  consensusScore: real('consensus_score').notNull().default(0),
  sourceCount: integer('source_count').notNull().default(0),
  verifiedSourceCount: integer('verified_source_count').notNull().default(0),
  conceptObjectId: uuid('concept_object_id'),
  knowledgeObjectId: uuid('knowledge_object_id'),
  candidateIds: jsonb('candidate_ids').notNull().default([]),   // all produced kernel_object ids
  reviewerId: uuid('reviewer_id'),
  reviewNote: text('review_note').notNull().default(''),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  error: text('error').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('kar_status_idx').on(t.status, t.createdAt),
  reqIdx: index('kar_req_idx').on(t.requestedBy),
}));

// Per-run candidate sources with their computed reliability (audit + teacher inspection).
export const knowledgeAcquisitionSources = pgTable('knowledge_acquisition_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull(),
  url: text('url').notNull(),
  domain: text('domain').notNull(),
  title: text('title').notNull().default(''),
  sourceType: text('source_type').notNull().default('unknown'),
  domainTier: integer('domain_tier'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  reliability: real('reliability').notNull().default(0),
  passedFilter: boolean('passed_filter').notNull().default(false),
  excerpt: text('excerpt').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ runIdx: index('kas_run_idx').on(t.runId) }));
```

Self-bootstrap DDL (mirrors the tables; run in `ensureAcquisitionSchema()` exactly like `ensureLlmSchema()`):

```ts
export const ACQUISITION_DDL = [
  `CREATE TABLE IF NOT EXISTS knowledge_source_registry (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), domain TEXT NOT NULL,
     source_type TEXT NOT NULL DEFAULT 'unknown', tier INT NOT NULL DEFAULT 3,
     listing TEXT NOT NULL DEFAULT 'allow', notes TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ksr_domain_ux ON knowledge_source_registry (domain)`,
  `CREATE TABLE IF NOT EXISTS knowledge_acquisition_runs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), query TEXT NOT NULL, requested_by UUID,
     subject TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'queued', consensus_score REAL NOT NULL DEFAULT 0,
     source_count INT NOT NULL DEFAULT 0, verified_source_count INT NOT NULL DEFAULT 0,
     concept_object_id UUID, knowledge_object_id UUID, candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
     reviewer_id UUID, review_note TEXT NOT NULL DEFAULT '', reviewed_at TIMESTAMPTZ,
     error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS kar_status_idx ON knowledge_acquisition_runs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS knowledge_acquisition_sources (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL, url TEXT NOT NULL,
     domain TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL DEFAULT 'unknown',
     domain_tier INT, published_at TIMESTAMPTZ, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     reliability REAL NOT NULL DEFAULT 0, passed_filter BOOLEAN NOT NULL DEFAULT false,
     excerpt TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS kas_run_idx ON knowledge_acquisition_sources (run_id)`,
];
```

### 3.3 Extraction output schema (LLM JSON — strictly validated) — `extract.ts`

```ts
import { z } from 'zod';
export const ExtractionSchema = z.object({
  subject: z.string().min(1).max(80),
  domain: z.string().min(1).max(80),                 // maps to a HALF_LIFE_YEARS family (§5.2)
  concept: z.object({ name: z.string().min(1).max(120), description: z.string().max(1000) }),
  explanation: z.object({
    body: z.string().min(1).max(8000),
    equations: z.array(z.object({ latex: z.string().min(1).max(400), caption: z.string().max(200).optional() })).max(20).optional(),
    examples: z.array(z.object({ prompt: z.string().min(1).max(800), solution: z.string().min(1).max(2000) })).max(10).optional(),
  }),
  prerequisites: z.array(z.string().min(1).max(120)).max(12).optional(),
  // each claim must cite the numbered sources it was drawn from (indexes into the filtered set)
  claims: z.array(z.object({
    text: z.string().min(1).max(600),
    supportIdx: z.array(z.number().int().nonnegative()).min(1).max(12),
  })).min(1).max(30),
  animationPrompt: z.string().max(300).optional(),
  simulationSpec: z.object({ title: z.string().max(120), engine: z.string().max(40).optional(), summary: z.string().max(600).optional() }).optional(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
```

---

## 4. Interfaces & API contracts

```ts
// src/lib/knowledge-acquisition/types.ts
export type SourceType =
  | 'peer_reviewed' | 'standards_body' | 'textbook' | 'gov' | 'edu'
  | 'reference_encyclopedia' | 'org' | 'news' | 'blog' | 'forum' | 'unknown';

export interface SourceRecord {
  url: string; domain: string; title?: string;
  sourceType: SourceType; domainTier?: 1 | 2 | 3 | 4;
  publishedAt?: string | null; fetchedAt: string;
  hasAuthor: boolean; citationCount?: number; https: boolean;
  excerpt: string;                       // bounded text passed to the extractor
}
export interface ScoredSource extends SourceRecord { reliability: number; }

export type RunStatus =
  | 'queued' | 'classifying' | 'searching' | 'verifying'
  | 'extracting' | 'drafted' | 'pending_review'
  | 'approved' | 'rejected' | 'failed';

// The "Search Trusted Sources" port. Default impl returns [] (no built-in crawler — §7).
export interface SourceSearchProvider {
  search(query: string, subject: string, domain: string, limit: number): Promise<SourceRecord[]>;
}
```

```ts
// src/lib/knowledge-acquisition/source-trust.ts  (pure)
export function scoreSource(s: SourceRecord, domainFamily?: string, now?: Date): number;
export function filterSources(scored: ScoredSource[], policy: FilterPolicy): ScoredSource[];
export interface Claim { text: string; supportIdx: number[]; }
export interface VerificationResult {
  claims: (Claim & { independentDomains: number; supportTrust: number; corroborated: boolean })[];
  consensusScore: number; corroboratedCount: number; passed: boolean;
}
export function crossVerify(claims: Claim[], sources: ScoredSource[],
  minIndependentDomains?: number, minClaimTrust?: number): VerificationResult;
```

```ts
// src/lib/knowledge-acquisition/pipeline.ts  (stateful: DB + LLM + kernel)
export interface AcquisitionDeps {
  repo: KernelRepository;               // createPgKernel()
  search: SourceSearchProvider;         // NullSourceSearch by default
}
export async function startRun(query: string, requestedBy: string | null): Promise<{ runId: string }>;
export async function stepRun(runId: string, deps: AcquisitionDeps): Promise<{ status: RunStatus }>; // advances ONE stage
export async function runToCompletion(runId: string, deps: AcquisitionDeps, budgetMs?: number): Promise<RunStatus>;
export async function approveRun(runId: string, reviewerId: string, note?: string): Promise<void>; // publishes candidates
export async function rejectRun(runId: string, reviewerId: string, note?: string): Promise<void>;  // archives candidates
export async function addManualSources(runId: string, urls: string[]): Promise<number>; // teacher-supplied fallback
```

**Endpoints** (Astro `APIRoute`, same `j()`/`locals.user` convention as `api/admin/knowledge.ts`):

| Method + path | Auth / capability | Request | Response |
|---|---|---|---|
| `POST /api/aquintutor/acquire` | signed-in + `can('create',{type:'KnowledgeObject'})` + `underRateLimit(userId)` | `{ query: string, sources?: string[] }` | `{ ok, runId, status }` — starts a run; optional teacher-supplied `sources` seed the search |
| `GET /api/aquintutor/acquire?runId=…&step=1` | signed-in (owner or `create`) | — | `{ ok, status, consensusScore, sourceCount, candidateIds }`; `step=1` advances one stage then returns (client polls) |
| `GET /api/admin/knowledge-review?status=pending_review` | `can('read',{type:'KnowledgeObject'})` | — | `{ ok, runs: RunSummary[] }` (with sources + candidate previews) |
| `POST /api/admin/knowledge-review` | `can('execute',{type:'KnowledgeObject'})` (**teacher-approval gate**) | `{ runId, action:'approve'\|'reject', note? }` | `{ ok, status }` — approve → publish walk; reject → archive |

Every review action is audited automatically because `can()` writes an audit row; approve/reject additionally stamp `reviewerId`/`reviewedAt`/`reviewNote` on the run.

---

## 5. Core logic / algorithms

### 5.1 Source-trust scoring (deterministic — the "Rank Reliability" stage)

```ts
const TYPE_WEIGHT: Record<SourceType, number> = {
  peer_reviewed: 1.00, standards_body: 0.95, textbook: 0.92, gov: 0.88, edu: 0.82,
  reference_encyclopedia: 0.72, org: 0.60, news: 0.45, blog: 0.25, forum: 0.15, unknown: 0.10,
};
const TIER_WEIGHT: Record<number, number> = { 1: 1.0, 2: 0.8, 3: 0.55, 4: 0.3 };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreSource(s: SourceRecord, domainFamily = 'default', now = new Date()): number {
  const type = TYPE_WEIGHT[s.sourceType] ?? TYPE_WEIGHT.unknown;
  const tier = s.domainTier ? (TIER_WEIGHT[s.domainTier] ?? 0.3) : 0.5;      // unknown tier = neutral
  const recency = recencyScore(s.publishedAt, domainFamily, now);
  const authority =
    (s.hasAuthor ? 0.5 : 0) +
    (s.citationCount && s.citationCount > 0 ? Math.min(0.5, s.citationCount / 40) : 0);
  const httpsPenalty = s.https ? 1 : 0.6;                                    // plain HTTP is discounted
  const base = 0.45 * type + 0.30 * tier + 0.15 * recency + 0.10 * authority;
  return clamp01(base * httpsPenalty);
}
```

### 5.2 Recency decay (subject-aware half-life)

```ts
const HALF_LIFE_YEARS: Record<string, number> = {
  mathematics: 40, physics: 25, chemistry: 20, biology: 12,
  'computer-science': 6, medicine: 5, technology: 4, 'current-affairs': 1, default: 12,
};
function recencyScore(publishedAt: string | null | undefined, family: string, now: Date): number {
  if (!publishedAt) return 0.5;                        // unknown date = neutral, not penalised
  const t = Date.parse(publishedAt); if (Number.isNaN(t)) return 0.5;
  const ageYears = Math.max(0, (now.getTime() - t) / (365.25 * 864e5));
  const hl = HALF_LIFE_YEARS[family] ?? HALF_LIFE_YEARS.default;
  return clamp01(Math.pow(0.5, ageYears / hl));        // 1.0 fresh → 0.5 at one half-life → …
}
```

### 5.3 Filter (the "Filter Sources" stage)

```ts
export interface FilterPolicy {
  minReliability: number;      // default 0.55
  requireAllowlist: boolean;   // default true — only registry listing='allow' domains survive
  allowDomains: Set<string>;   // from knowledge_source_registry where listing='allow'
  denyDomains: Set<string>;    // listing='deny' (always wins)
  maxSources: number;          // default 8
}
export function filterSources(scored: ScoredSource[], p: FilterPolicy): ScoredSource[] {
  return scored
    .filter((s) => !p.denyDomains.has(s.domain))
    .filter((s) => !p.requireAllowlist || p.allowDomains.has(s.domain))
    .filter((s) => s.reliability >= p.minReliability)
    .sort((a, b) => b.reliability - a.reliability)
    .slice(0, p.maxSources);
}
```

### 5.4 Cross-verification (the "Cross Verification" stage)

A claim is **corroborated** only when supported by ≥ `minIndependentDomains` *distinct registrable domains*, at least one of which clears `minClaimTrust`. The run's `consensusScore` is the fraction of extracted claims that are corroborated; a run passes only if it clears 0.5.

```ts
export function crossVerify(claims: Claim[], sources: ScoredSource[],
  minIndependentDomains = 2, minClaimTrust = 0.55): VerificationResult {
  const verified = claims.map((c) => {
    const supp = c.supportIdx.map((i) => sources[i]).filter(Boolean);   // guard against bad indexes
    const domains = new Set(supp.map((s) => s.domain));
    const supportTrust = supp.reduce((a, s) => a + s.reliability, 0);
    const corroborated = domains.size >= minIndependentDomains && supp.some((s) => s.reliability >= minClaimTrust);
    return { ...c, independentDomains: domains.size, supportTrust, corroborated };
  });
  const corr = verified.filter((v) => v.corroborated);
  const consensusScore = verified.length ? corr.length / verified.length : 0;
  return { claims: verified, consensusScore, corroboratedCount: corr.length,
           passed: corr.length > 0 && consensusScore >= 0.5 };
}
```

### 5.5 Stage orchestrator (`stepRun` — one stage per call, serverless-safe)

The run is a DB-backed state machine; each `stepRun` advances exactly one stage and persists status, so a long pipeline survives Vercel's function timeout by being driven across several polling requests (or a Cron worker). No stage holds resident state.

```
stepRun(runId):
  load run
  switch run.status:
   'queued'      → classify(): LLM → { subject, domain };  save; status='classifying'→'searching'
   'searching'   → raw = search.search(query, subject, domain, 20)          // provider OR manual sources
                   if raw.length == 0: status='failed', error='no candidate sources'; STOP
                   scored = raw.map(r => ({...r, reliability: scoreSource(r, domainFamily(domain))}))
                   kept   = filterSources(scored, policyFromRegistry())
                   persist all scored rows (passed_filter flag) to knowledge_acquisition_sources
                   if kept.length < 2: status='failed', error='insufficient trusted sources'; STOP
                   status='verifying'
   'verifying'   → status='extracting'      // verification runs jointly with extraction (needs claims)
   'extracting'  → ex = extractConcept(query, kept)          // §5.6 (LLM, Zod-validated)
                   ver = crossVerify(ex.claims, kept)
                   if !ver.passed: status='failed', error='claims not corroborated'; STOP
                   ids = buildDrafts(repo, run, ex, kept, ver.consensusScore)   // §5.7
                   generateMedia(repo, ids, ex)              // best-effort; never fails the run
                   save consensusScore, candidateIds, concept/knowledge ids; status='drafted'→'pending_review'
   'pending_review'|'approved'|'rejected'|'failed' → no-op (terminal for stepRun)
```

`domainFamily(domain)` lower-cases + maps the extractor's free-text domain onto a `HALF_LIFE_YEARS` key (`'default'` when unmatched). `policyFromRegistry()` loads allow/deny domain sets + tiers from `knowledge_source_registry` in one query.

### 5.6 Concept extraction (`extractConcept` — the "Extract Concepts" stage)

```ts
const EXTRACT_SYSTEM = `You extract a single teaching concept STRICTLY from the numbered sources provided.
HARD RULES:
- Use ONLY facts present in the sources. Never add outside knowledge. If the sources are insufficient, say so with fewer/empty claims.
- Every claim MUST cite the source numbers it came from via "supportIdx" (0-based indexes into the sources list). Never invent a citation.
- Output ONE JSON object matching the schema. No markdown, no prose outside JSON.`;

export async function extractConcept(query: string, sources: ScoredSource[]): Promise<Extraction> {
  const cfg = await getConfig();
  if (!isReady(cfg)) throw new Error('LLM not configured');
  const numbered = sources.map((s, i) => `[${i}] (${s.domain}, reliability ${s.reliability.toFixed(2)}) ${s.title ?? ''}\n${s.excerpt}`).join('\n\n');
  const user = `Concept requested: ${query}\n\nSOURCES:\n${numbered}\n\nReturn the JSON now.`;
  const res = await chat(EXTRACT_SYSTEM, [{ role: 'user', content: user }],
    { ...cfg, maxTokens: Math.max(cfg.maxTokens, 2000) });
  await logUsage(null, 'knowledge-acquisition', cfg, user.length, res.text.length, 0, res.ok ? 'ok' : 'error');
  if (!res.ok) throw new Error(res.error || 'extraction failed');
  const parsed = ExtractionSchema.safeParse(JSON.parse(stripFences(res.text)));  // stripFences reuses generate-animation's clean()
  if (!parsed.success) throw new Error('extraction JSON invalid: ' + parsed.error.issues.map(i => i.path.join('.')).join(','));
  return parsed.data;
}
```

### 5.7 Build the temporary knowledge graph (drafts in `created`)

Reuses `KernelRepository` exactly as Block 02's authoring does — the only difference is these objects are left in `created` (never auto-published) and stamped with `metadata.acquisition`.

```ts
import { loadPrerequisiteDag, wouldCreateCycle } from '@/lib/knowledge-graph'; // Block 02

async function buildDrafts(repo, run, ex, sources, consensusScore): Promise<string[]> {
  const provenance: AcquisitionProvenance = {
    runId: run.id, query: run.query, subject: ex.subject, domain: ex.domain,
    model: activeModel(await getConfig()), consensusScore,
    sources: sources.map(s => ({ url: s.url, domain: s.domain, reliability: s.reliability })),
    extractedAt: new Date().toISOString(), pending: true,
  };
  const ids: string[] = [];
  const concept = await repo.createObject({
    type: 'ConceptObject', data: { name: ex.concept.name, description: ex.concept.description },
    metadata: { acquisition: provenance },
  });
  ids.push(concept.id);
  const ko = await repo.buildKnowledgeObject({                 // wires part_of edge to the concept
    data: { title: ex.concept.name, body: ex.explanation.body,
            equations: ex.explanation.equations, examples: ex.explanation.examples, conceptId: concept.id },
    conceptId: concept.id,
  });
  await repo.patchMeta(ko.id, { acquisition: provenance });    // metadata patch, no lifecycle move
  ids.push(ko.id);
  // prerequisites: match an existing published ConceptObject by name, else create a draft concept,
  // then link prereq -[prerequisite_of]-> ko WITH Block 02's wouldCreateCycle() guard (skip on cycle).
  // Block 02 signature is wouldCreateCycle(dag, from, to): boolean (sync) — load the DAG first.
  const dag = await loadPrerequisiteDag({ edgeType: 'prerequisite_of' });
  for (const name of ex.prerequisites ?? []) {
    const pid = await resolveOrDraftConcept(repo, name, provenance);
    if (pid && !wouldCreateCycle(dag, pid, ko.id)) {          // adding pid -[prerequisite_of]-> ko
      await repo.addRelationship(pid, 'prerequisite_of', ko.id);
      dag.nodes.push(pid, ko.id); dag.edges.push({ from: pid, to: ko.id }); // keep guard consistent across the loop
    }
    if (pid && !ids.includes(pid)) ids.push(pid);
  }
  if (ex.animationPrompt) {
    const a = await repo.createObject({ type: 'AnimationObject', data: { title: ex.concept.name, scene: ex.animationPrompt }, metadata: { acquisition: provenance } });
    await repo.addRelationship(ko.id, 'references', a.id); ids.push(a.id);
  }
  if (ex.simulationSpec) {
    const sObj = await repo.createObject({ type: 'SimulationObject', data: { title: ex.simulationSpec.title, engine: ex.simulationSpec.engine }, metadata: { acquisition: provenance } });
    await repo.addRelationship(ko.id, 'references', sObj.id); ids.push(sObj.id);
  }
  await updateRun(run.id, { conceptObjectId: concept.id, knowledgeObjectId: ko.id, candidateIds: ids });
  return ids;
}
```

Draft visibility is enforced **for free** by the lifecycle: learner-facing queries already filter to `lifecycleState === 'published'` (e.g. `ContentService.listCourseUnits(courseObjId, true)`), so nothing in `created` reaches a learner.

### 5.8 Approval (publish walk) and rejection (discard)

```ts
export async function approveRun(runId, reviewerId, note = '') {
  const run = await getRun(runId);
  if (run.status !== 'pending_review') throw new Error(`run not reviewable (status=${run.status})`);
  const repo = createPgKernel();
  for (const id of run.candidateIds) {                 // created → validated → indexed → published
    const o = await repo.getObject(id); if (!o) continue;
    if (o.lifecycleState === 'created')   await repo.validateObject(id);   // re-runs Zod payload validation
    if ((await repo.getObject(id))!.lifecycleState === 'validated') await repo.indexObject(id);
    if ((await repo.getObject(id))!.lifecycleState === 'indexed')   await repo.publishObject(id);
    await repo.patchMeta(id, { acquisition: { ...(o.metadata as any).acquisition, pending: false, approvedBy: reviewerId } });
  }
  await updateRun(runId, { status: 'approved', reviewerId, reviewNote: note, reviewedAt: new Date().toISOString() });
}

export async function rejectRun(runId, reviewerId, note = '') {
  const run = await getRun(runId);
  const repo = createPgKernel();
  for (const id of run.candidateIds) await repo.archiveObject(id).catch(() => {}); // needs the discard transition (§7)
  await updateRun(runId, { status: 'rejected', reviewerId, reviewNote: note, reviewedAt: new Date().toISOString() });
}
```

### 5.9 Lifecycle extension for the discard path (`src/lib/kernel/lifecycle.ts`)

The current state machine has **no** way to retire a never-published draft (`created`/`validated`/`indexed` have no edge to `archived`). Add the discard edges — this preserves the invariant "a draft can never *skip* to `published`" while making rejection expressible:

```ts
export const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  created:    ['validated', 'archived'],   // + discard
  validated:  ['indexed',   'archived'],   // + discard
  indexed:    ['published', 'archived'],   // + discard
  published:  ['referenced', 'updated', 'archived'],
  referenced: ['updated', 'archived'],
  updated:    ['indexed', 'published', 'archived'],
  archived:   ['deleted'],
  deleted:    [],
};
```

---

## 6. Execution plan

> **Status: PARTIALLY IMPLEMENTED** (2026-07-20) — the pure trust/verify/extraction core + the lifecycle discard edge landed with tests; the DB run-store, LLM-driven pipeline orchestrator, and endpoints are deferred (they need Postgres + a configured LLM + an external search provider to exercise). `knowledge-acquisition.test.ts` **19/19**, kernel regression **65/65** (+2 discard), `astro check` **zero errors** in touched files (repo total unchanged at 184).

1. [x] **`source-trust.ts`** — `scoreSource`, `recencyScore`, `domainFamily`, `scoreSources`, `filterSources`, `defaultFilterPolicy`, `crossVerify`. Tests: fresh peer-reviewed→~1.0, old plain-HTTP blog→<0.55, deny-wins, 2-distinct-domains corroborates / 1-domain does not, out-of-range supportIdx safe.
2. [ ] **Deferred** — `store.ts` (`ACQUISITION_DDL` + run/source CRUD + `policyFromRegistry`/`seedRegistry`). DB.
3. [x] **Lifecycle discard** — `created|validated|indexed → archived` added to `TRANSITIONS`; kernel test asserts `created→archived` legal and `created→published` still throws. *(Shared Block 01 change — flagged in §7.)*
4. [x] **`extract.ts`** — `ExtractionSchema` (strict zod) + `extractConcept()` (lazy-imported gateway `chat()`, `stripFences`, zod parse, `logUsage`) + `EXTRACT_SYSTEM`.
5. [x] **`types.ts` + `index.ts`** — shared types, `SourceSearchProvider` port + `NullSourceSearch`, `AcquisitionProvenance` + `ProvenanceSchema`. *(`ManualSourceSearch` fetch-adapter deferred.)*
6. [ ] **Deferred** — `pipeline.ts` (`startRun`/`stepRun`/`runToCompletion`/`buildDrafts`/`approveRun`/`rejectRun`). DB + LLM + kernel.
7. [ ] **Deferred** — `POST/GET /api/aquintutor/acquire.ts`.
8. [ ] **Deferred** — `GET/POST /api/admin/knowledge-review.ts`.
9. [ ] **Deferred** — review UI, 10. registry admin, 11. Cron worker.

---

## 7. Reality checks & risks

- **No resident pipeline / scheduler.** The spec's "Runtime Scheduler deciding what runs next" (pp 55–56) and any in-memory acquisition loop do not exist on Vercel. Replaced by a **DB-backed run state machine** advanced one stage per request (`stepRun`) via client polling or a Cron worker. There is no long-lived process and nothing is cached between requests.
- **No built-in web search / crawler.** "Search Trusted Sources" has no in-repo implementation. `SourceSearchProvider` is a **port**; the default `NullSourceSearch` returns nothing, so an unseeded install degrades honestly (`status='failed', error='no candidate sources'`). Wiring a real automated search needs an **external service** (e.g. an academic/web-search API) configured with a key — **out-of-scope wiring, decision needed** on vendor + budget. The `ManualSourceSearch` fallback (teacher pastes trusted URLs) needs no external service and is the recommended first cut. Note: the environment lists an **Exa** connector that is *unauthenticated* here — it cannot be relied on server-side.
- **Function-timeout vs. multi-LLM pipeline.** A full run = classify + search + extract (+ optional animation) = several model round-trips + N fetches, likely exceeding a single Vercel function budget. Mitigated by staged execution (`stepRun`) + `runToCompletion(budgetMs)` that stops before the limit; a Cron worker is the robust option. **Decision:** polling vs. Cron vs. an external queue.
- **"Cross Verification / Educational Truth" is not a truth oracle.** It is reduced to a **deterministic corroboration threshold** — ≥ N independent trusted domains agree — plus a mandatory human gate. It cannot detect coordinated misinformation across multiple allowlisted domains; the teacher approval step is the real backstop, not the algorithm.
- **LLM fabrication / hallucinated citations.** The extractor is instructed to cite only provided sources and `supportIdx` is validated against the actual source array, but a model can still mis-attribute. Mitigations: strict Zod schema, `crossVerify` drops uncited/under-cited claims, drafts never publish without `can('execute')` approval, and `logUsage`/`audit_log` retain the trail. Residual risk requires human review — by design.
- **Discard transition changes shared behaviour.** §5.9 edits the global `TRANSITIONS` map (`created|validated|indexed → archived`), which affects **all** object types, not just acquisition drafts. It is contained and correct (discard ≠ publish), but it is a change to Block 01's state machine and should get sign-off. Alternative if rejected: leave rejected drafts in `created` and mark the run `rejected` (they stay invisible but accumulate as dead rows).
- **Digital signatures / post-quantum crypto on sources (spec pp 44–45).** Config-object signing/"cryptographic verification" is **out of scope**. Source integrity here = HTTPS + registry allowlist + optionally a stored SHA-256 content hash of the fetched excerpt (deferred). No PKI, no PQC.
- **Capability-vector benchmarking & prediction ensembles (spec slice pp 46–54).** The "measure hundreds of hardware attributes" and "predictive Educational World States" material is **not this block** — device capability belongs to Block 05; prediction is a separate concern. Acquisition uses fixed thresholds (`minReliability`, `minIndependentDomains`), not predictive scoring.
- **Simulation generation is a descriptor stub.** `SimulationObject` gets a title/engine/summary only; auto-generating a *safe, correct* interactive three.js physics simulation from an LLM is not attempted (correctness + sandbox risk). The animation reuses the existing sandboxed `frame(ctx,t,w,h)` generator with its `BANNED` check. Real simulation rendering is Block 05's surface.
- **Editorial seed of the trusted-source registry is a human decision.** Which domains are `allow`/`deny` and their tiers (1–4) are policy, not code. Ship a small conservative seed (recognised standards bodies, `.gov`/`.edu`, major reference encyclopedias) and let editors curate — **needs a human owner.**
- **Cost / abuse.** Learner-triggered acquisition runs cost LLM calls + fetches. Trigger is gated to `create` capability + `underRateLimit(userId)`; a learner-facing "request this concept" that only records the gap (no LLM until a teacher runs it) is the cheaper default if `create` is too broad — **decision on who may trigger.**
