# AquinTutor — Phase 1: Discovery

Per §2 of the reconstruction directive: *do not assume anything exists.* This is the inventory,
before any code was changed. Every number below was measured, and where a first measurement was
wrong it is recorded as wrong rather than quietly replaced.

## Surface

| | count |
|---|---|
| Pages under `src/pages/aquintutor` | **236** |
| API routes under `src/pages/api/aquintutor` | **91** |
| AquinTutor-related libraries | **24** files, 5 directories |
| Virtual laboratory pages | **61** |

Largest families: `labs` (63 routes), `admin` (24), `campus` (11).

## Finding 1 — laboratory discoverability

**Verified, and it is not what the first scan said.**

| | |
|---|---|
| Lab pages on disk | 61 |
| Slugs in `src/data/labs-catalog.ts` (the learner-facing index) | 20 |
| Catalogued slugs with no page (broken links) | **0** |
| Pages not in the catalogue | 41 |

Splitting those 41 by whether anything else reaches them:

- **31** appear in `src/lib/aquintutor-authoring.ts`, so a teacher can embed them in a lesson.
- **9** appear in neither.
- Of those 9, **8 are linked from a parent lab page** — a hub-and-spoke pattern:
  `ai-ml` → `attention`, `cybersecurity` → `ecc-workbench` + `rsa-attacks`,
  `dsp` → `filter-designer`, `vlsi` → `cpu-pipeline`, `quantum-lab` → `quantum-vqe`,
  `control-systems` → `control-lab`, and `xr` from the labs index.

**Genuinely unreachable: 1 page — `/aquintutor/labs/cad-bench`.**

**The real gap is discoverability, not breakage.** A learner browsing `/aquintutor/labs` is offered
20 of 61 laboratories. The other 41 exist, work, and are reachable only by already being inside a
lesson or a parent lab that happens to link them. Nothing 404s; two thirds of the estate is simply
not on the map.

**Gap classification:** `UX` + `INTEGRATION`, not `BROKEN` or `ORPHAN`.

## Finding 2 — dead interactions: effectively none

A scan of every `<button>` in all 236 pages for an `id` that nothing in the same file binds returned
one file, `labs/eee-bench.astro` — and that is a false positive: those buttons bind by
`.wb-tool` class and `data-tool`, not by id.

`/aquintutor/lab` had three genuinely dead buttons (`run circuit`, `snapshot`, `export`). Those were
found and wired earlier in this session, which is why the count is now zero.

## Method note — three wrong answers before the right one

Recorded because §48 requires treating every claim as a hypothesis, and because the failures are
instructive:

1. **"70 of 234 pages are orphans."** Wrong. The detector counted literal occurrences of each route
   string, and `labs/index.astro:222` builds links as `{'/aquintutor/labs/' + l.slug}`. Interpolated
   links are invisible to a substring count.
2. **"41 labs are unreachable."** Wrong. 31 of them are embeddable from the authoring tool.
3. **"9 labs are unreachable."** Wrong. 8 are linked from a parent lab page.

The true figure is 1. A discovery pass that had stopped at step 1 would have reported a crisis that
does not exist, and the remediation — "link 70 orphan pages" — would have been busywork against a
misreading.

## Still to inventory

Phase 1 is not complete. Outstanding, in dependency order:

- [ ] §26 API audit — consumers for all 91 AquinTutor routes; which have no caller
- [ ] §25 data architecture — which tables the 24 libraries own, orphans, missing keys
- [ ] §27 AI architecture — models, prompts, RAG, memory; which capabilities are LLM-wrappers
- [ ] §11 user-journey audit — the student journey end to end, then faculty, then institution
- [ ] §13 learner model — whether it exists and whether anything reads it
- [ ] §17 laboratory framework — 61 labs built as isolated apps; is there a shared harness
- [ ] §18/§19 assessment and examination engines
- [ ] §24 privacy and security across the AquinTutor surface
- [ ] §22 low-bandwidth, §23 accessibility

## Registry status

| Status | Count |
|---|---|
| DISCOVERED | 2 findings recorded |
| SPECIFIED | 0 |
| IMPLEMENTED | 0 |
| E2E_VERIFIED | 0 |

No requirement may move past `DISCOVERED` until it carries the evidence §40 demands.
