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

**CORRECTED. Both of this finding's original headline numbers were wrong, and the corrections run in
opposite directions: the estate is in better shape than reported, and it contained one real problem
that the reachability question was never going to surface.**

What the first version of this section said:

> Genuinely unreachable: 1 page — `/aquintutor/labs/cad-bench`.
> A learner browsing `/aquintutor/labs` is offered 20 of 61 laboratories.

Both are false, and for the same root cause: the detector read `src/data/labs-catalog.ts`, whose own
header describes it as the **licensable** catalogue for the partner-facing page. The learner-facing
`labs/index.astro` carries its own arrays and does not import that file. Two different lists were
being treated as one. `cad-bench` is on the learner index at line 24 with `live: true` and always was.

Measured against the right file:

| | count |
|---|---|
| Lab pages on disk | **60** |
| Slugs listed on the learner index | **50** |
| Slugs in the licensing catalogue (a different list, for a different page) | 20 |
| Catalogued slugs with no page (broken links) | **0** |
| **Genuinely unreachable** | **0** |

The ten not on the index are reachable by design rather than by accident:

- **8 are hub-linked from a parent laboratory** — `ai-ml` → `attention`, `cybersecurity` →
  `ecc-workbench` + `rsa-attacks`, `dsp` → `filter-designer`, `vlsi` → `cpu-pipeline`,
  `quantum-lab` → `quantum-vqe`, `control-systems` → `control-lab`, and `xr`, linked from the index
  itself by href rather than by slug — which is exactly why a slug-only scan missed it.
- **`animator`** is embedded from the lesson player, the authoring tool and the home data.
- **`train`** is not a laboratory at all. See below.

**Gap classification: none.** The discoverability crisis this section originally reported does not
exist. `src/lib/aquin-surface.test.ts` now pins the distinction between the two lists, because the
failure mode worth guarding is somebody later pointing the learner index at the licensing catalogue
and silently cutting the estate to a third.

## Finding 1a — `/aquintutor/labs/train` accepted writes from anybody  ·  P1, FIXED

Found while verifying the reachability numbers above, and unrelated to them. Recorded separately
because it is the more serious item and would be lost inside a discoverability finding.

`labs/train` is a 695-line **LLM fine-tuning console** — base model, dataset URL, custom weights URL,
hyperparameters — sitting in the public `/aquintutor/labs/` namespace where every neighbouring page is
a learner-facing laboratory. Nothing links to it. It answered **HTTP 200 to an anonymous request on
the live site**.

Line 6 read `const user = Astro.locals.user` and never consulted it again. The POST handler inserted
into `training_jobs` with `user_id = ${user?.id || null}`; the null branch is the tell, since it says
an anonymous writer was expected to work — and it did.

**Severity, stated accurately rather than dramatically.** Grep found no worker and no cron consuming
`training_jobs`. Nothing ever fetched the `dataset_url` or the custom weights URL, so there was no
server-side fetch to abuse and no code execution: **not SSRF, not RCE.** What a stranger could
actually do was insert unbounded rows carrying chosen job names and URLs into a production table —
and those rows render on the AquinTutor admin dashboard, so text an administrator reads was writable
by anybody. That is a P1, not a P0.

**Fixed**: signed-out visitors are redirected to sign in, and the page now admits the same roles as
its only consumer, `/aquintutor/admin/index.astro`, so the two cannot drift apart. A regression test
asserts both the specific gate and the general rule.

**The general rule is the durable part.** `aquin-surface.test.ts` now requires every page under
`/aquintutor` that accepts a POST and writes to the database to *decide* who may — reading
`locals.user` does not count. Running it immediately surfaced five more ungated writers: hall
bookings, placement requests, study-abroad enquiries, EIR applications and partnership applications.
Those were traced individually and are **public application forms** — requiring an account before
somebody may apply to a partnership programme would defeat the purpose — so they are exempted by an
**explicit written list**, not by an inferred pattern. A rule like "the table name ends in `_requests`
so it is probably fine" would have quietly exempted `training_jobs` too.

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
