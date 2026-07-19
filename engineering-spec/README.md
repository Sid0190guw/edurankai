# AquinTutor — Engineering Blocks

**Conversion of the "AquinTutor Engineering Specification (AES)" prose corpus into concrete, buildable engineering blocks for this repo.**

The AES corpus (6 PDFs, **9,681 pages**, `D:/Desktop/prompt2/volume *.pdf`) is a long, "bookish" conceptual document — a philosophical *"educational operating system"* narrative. This folder is the engineering translation: every legitimate subsystem is rewritten as a real engineering block (data models, API contracts, algorithms, execution steps) grounded in the **actual `edurankai` code** — Astro 5 SSR + Drizzle + Postgres on Vercel serverless.

Theoretical phrasing has been stripped. Each block says what to build, where it lands in `src/`, and where the spec's "resident OS kernel" metaphor breaks on serverless.

---

## What was converted vs. what was not

The corpus contains **940 detected chapters**. Only the education/platform core is real product; the rest is runaway AI generation. Full accounting in **[`00-INVENTORY.md`](00-INVENTORY.md)** — nothing is silently dropped.

| | Chapters | Disposition |
|---|--:|---|
| **Core** (education + platform/infra) | 86 | **Converted → the 12 engineering blocks below** |
| Divergent — Constitutional / governance | 578 | Cataloged only; not built (no connection to an education product) |
| Divergent — Space / aerospace | 56 | Cataloged only; not built |
| Divergent — Industrial / manufacturing | 16 | Cataloged only; not built |
| Unclassified (bare `Chapter N` headers) | 204 | Cataloged only |

> As Senior Engineering Architect I deliberately did **not** fabricate production specs for e.g. *"Constitutional Space Habitat Engineering"* — engineering-shaped scaffolding for scope that isn't a real product is worse than an honest boundary.

---

## The 12 engineering blocks

Each is a self-contained, buildable spec. **Status is mostly `partial`** — the repo already implements a surprising amount of the kernel (`src/lib/kernel/*`, `edu-runtime.ts`, `knowledge-sync.ts`, `offline-package.ts`), so most blocks *extend* real code rather than start from zero.

| # | Block | Status | Primary repo target | Depends on |
|---|---|---|---|---|
| [01](01-object-model-and-kernel.md) | Object Model & Kernel Envelope | partial | `src/lib/kernel/{types,lifecycle,schema,validation}.ts` + new `access.ts`,`graph.ts` | — (foundational) |
| [02](02-knowledge-object-and-graph.md) | Knowledge Object & Knowledge Graph | partial | new `src/lib/knowledge-graph.ts`; extend `kernel-content.ts` | 01 |
| [03](03-educational-runtime.md) | Educational Runtime (Lesson Engine) | partial | new `src/lib/runtime/lesson-engine.ts`; `edu-runtime.ts` | 02, 04 |
| [04](04-learner-state-estimation.md) | Learner State Estimation | partial | new `src/lib/runtime/estimators/*` | 01, 03 |
| [05](05-adaptive-rendering.md) | Adaptive Rendering Engine | partial | new `src/lib/render-profile.ts`; three.js scene | 04 |
| [06](06-offline-and-sync.md) | Offline Package & Knowledge Sync | partial | `offline-package.ts`, `knowledge-sync.ts`; `@vercel/blob` | 01 |
| [07](07-live-teaching-runtime.md) | Live Teaching Intelligence Runtime | partial | `board-*.ts`; external ASR/vision/LLM services | 01, 04, 05 |
| [08](08-knowledge-acquisition-pipeline.md) | Knowledge Acquisition Pipeline | greenfield | new `src/lib/knowledge-acquisition/*`; `src/lib/llm` | 01, 02 |
| [09](09-plugin-module-runtime.md) | Plugin / Subject-Module Runtime | greenfield | new `src/lib/plugins/*` | 10, 01 |
| [10](10-permission-and-capability-engine.md) | Kernel Permission & Capability Engine | partial | extend `src/lib/rbac/*`, `src/lib/auth`; `kernel_objects.permissions[]` | 01 |
| [11](11-security-and-crypto-layer.md) | Security, Cryptography & Threat Detection | partial | `@oslojs/crypto`, `auditLog`; new `src/lib/{crypto,security}/*` | 01, auth, rbac |
| [12](12-memory-cache-and-storage.md) | Memory, Cache & Storage Architecture | partial | new `src/lib/vsm/*`; Postgres + blob + CDN | 01 |

### Suggested build order

```
01 Object Model ─┬─> 10 Permissions ──> 09 Plugins
                 ├─> 02 Knowledge Graph ──> 08 Knowledge Acquisition
                 ├─> 04 Learner State ──> 03 Lesson Engine ──> 05 Adaptive Render ──> 07 Live Teaching
                 ├─> 06 Offline & Sync
                 ├─> 11 Security & Crypto
                 └─> 12 Memory / Cache / Storage
```

Block **01** is the keystone (every other block reads/writes `kernel_objects`). Build it, then **10** (permissions gate everything), then the service blocks in any order.

---

## How the blocks map to the existing repo

The spec's central claim — *"everything inside AquinTutor becomes an object"* — is **already true in code**:

- `src/lib/kernel/` implements the exact envelope the spec describes: `kernel_objects` (id, type, version, owner, permissions, metadata, **learning_metadata**, **security_labels**, **synchronization_state**, **lifecycle_state**, data) + `kernel_edges` (typed relationships), with a lifecycle state machine (`lifecycle.ts`), per-type zod validation (`validation.ts`), and a Postgres/in-memory store split (`store.ts`, `repository.ts`).
- Downstream consumers already exist: `edu-runtime.ts` (the lesson pipeline), `knowledge-sync.ts` (delta sync), `offline-package.ts`, `kernel-content.ts`, `irt.ts` (item-response theory), `job-queue.ts`, `board-*.ts` (live classroom capture).
- Platform substrate exists: `src/lib/rbac` (roles/permissions/assignments), `src/lib/auth` (oslo sessions), `src/lib/llm`, `auditLog`, `@vercel/blob`.

So these blocks are **not a rewrite** — they are the next increment on a codebase that already took the spec's object-kernel idea seriously.

---

## Serverless reality checks (recurring theme)

The AES corpus assumes a **resident operating-system kernel** managing RAM, a persistent scheduler, and in-memory caches. This repo is **stateless Vercel functions + serverless Postgres**. Every block's §7 translates the metaphor:

- *"Kernel schedules learning processes"* → stateless request handlers + Postgres state + cron/background jobs.
- *"Kernel-managed RAM / cache tiers"* → per-request memoization + HTTP/CDN cache + optional external KV; invalidation keyed on `kernel_objects.version`.
- *"Post-quantum cryptography" / "autonomous cyber defense"* → flagged **out-of-scope / aspirational**; blocks stay on `@oslojs/crypto` sessions + RBAC + `auditLog` threat signals.
- Heavy ML (speech/vision/gesture recognition, media generation) → **external services** with defined contracts, not in-repo builds.

---

## How each block was verified

Every block was written by one agent, then **independently reviewed by a second adversarial agent** that re-read the spec source and Grep/Read the repo to check: grounding (no invented features), repo-accuracy (every cited file/table/lib actually exists), concreteness (real Drizzle/zod/TS, not prose), theory-strip, and serverless realism. Fixes were applied in place.

| Result | Blocks |
|---|---|
| `solid` (no material issues) | 04 |
| `minor-fixes-applied` | 01, 02, 03, 05, 06, 07, 08, 09, 10, 11, 12 |
| `major-issues` | none |

**~32 fixes** applied — real defects, e.g.: block 01 a merge-conflict false-positive from reference (not structural) equality; block 02 missing cold-DB guards on graph reads; block 11 seven crypto/threat corrections. A post-hoc sweep confirmed all 84 "extend these" file references exist and all 77 "new" files are correctly labeled to-build (no file mislabeled as already-existing).

---

## Block file format

```
# Engineering Block NN — Name
| Spec source | Vol/pages | Repo target | Status | Depends on |
1. Purpose            — concrete, no philosophy
2. Repo mapping       — what exists vs. what to build
3. Data model         — real Drizzle tables / TS interfaces / zod
4. Interfaces & API   — TS signatures + Astro endpoint routes
5. Core logic         — deterministic algorithms / typed pseudocode
6. Execution plan     — ordered, buildable task checklist
7. Reality checks     — serverless caveats, external deps, out-of-scope
```

---

*Source corpus: `D:/Desktop/prompt2/volume {1-7,8,9,10,11,12}.pdf` (9,681 pp). Converted for the `edurankai` repository.*
