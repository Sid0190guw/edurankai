# HORIZON — Integration map and readiness

| Field | Value |
|---|---|
| Document | `docs/horizon/INTEGRATION_MAP.md` |
| Owner | Patch 20 — final master integration |
| Machine-readable source | `src/lib/horizon/integration/map.ts`, `concepts.ts` |
| Live report | `/admin/horizon/integration`, or `npm run horizon:check` |
| Method | Source-only. No database connection was opened and no `.env*` file was read. |

---

## Read this first

**This document is not the map.** `src/lib/horizon/integration/map.ts` is the map, and
`src/lib/horizon/integration/assess.ts` computes the status by reading the repository. This page
explains the model and records the findings a machine cannot derive.

The reason is not stylistic. While this map was first being compiled, twenty-one agents were writing
into the same tree: the file count under `src/lib/horizon/` went from 3 to 63 in under an hour,
`src/lib/behaviour/` moved to `src/lib/horizon/behaviour/`, a consent table named in the first draft
was rewritten out of existence by its own author, and the reachable-module count went from 0 to 16.
Any status written into prose here would have been false before the paragraph ended.

So: **run the checker.** It prints what is true now.

```
npm run horizon:check            # the report
npx tsx scripts/horizon-check.mjs --strict   # exit 1 on a blocking finding
npx tsx scripts/horizon-check.mjs --json     # for CI
```

---

## The status vocabulary

A boolean would hide the state this build is actually in, so there are five.

| State | Meaning | What it needs |
|---|---|---|
| **Not started** | No file exists for this patch. | Somebody must write it. |
| **Contract only** | Types, unions and pure functions. Nothing stores anything, nothing runs. | Somebody must implement it. |
| **Implemented, no surface** | Runtime code and tables exist. Nothing under `src/pages` imports it. | Somebody must **wire** it. |
| **Reachable** | A page or API route imports it directly, so a URL runs this code. | Nothing — this is the only state that means a feature exists. |
| **Could not be read** | The source tree was not readable in this environment. | Nothing. It is not the same as absent and is never reported as absent. |

That last row matters in production. A serverless bundle does not ship `src/` as readable files, so
the same code that reports honestly in CI would, on the deployed site, find nothing and conclude that
twenty-one patches do not exist. `/admin/horizon/integration` degrades to **unknown** with the reason
printed instead, on the precedent `src/lib/evidence-graph.ts` set by printing EVIDENCE UNREADABLE
rather than an empty chain it could not read.

---

## The integration map

Every field is in `map.ts`, per patch: **owner path → inputs → outputs → tables → events emitted →
events consumed → dependencies → surface**. The status column is computed, not stored.

Patch 20 owns no business logic, no dimension, no score and no screen belonging to another patch. It
owns the question *is this one system yet*, and the honest answer. If it ever declares a table or a
dimension it has stopped being an integrator and become a twenty-second patch — there is a test
asserting exactly that.

---

## Data ownership: one concept, one canonical source of truth

This is the section with real findings in it.

Twenty-one agents were each correctly told to own their subdirectory and never edit another patch's
contract. Each then hit the same wall: the module they needed did not exist yet. Rule 8 of the brief
says publish a typed boundary rather than build somebody else's module. Several patches did exactly
that. Several declared a table instead — **and a table is not a boundary, it is a second copy of the
truth.**

`concepts.ts` holds the canonical owner for each concept and a classification for every table any
patch declares. A second store is a **defect** when it has no stated replication reason, and a
**design decision** when it does. The two need opposite actions, so they are never listed together.

### The principal defect: consent has more than one ledger

`hgov_consent` + `hgov_consent_events` (Patch 17) is canonical, because it alone carries the
withdrawal event log, the retention policy and the erasure request — the three things that make a
consent record mean anything after the grant. Alongside it the tree currently declares
`hzn_consent_event` (Patch 01), `emp_intel_consent` (Patch 15) and `fpc_consent` (Patch 02).

A withdrawal recorded in one ledger is invisible to the others. For a consent record specifically, a
stale `true` is the exact failure the record exists to prevent, and this is the one duplicate on the
list that can cause a person's data to be processed after they said stop.

### The other live defects

Run the checker for the current list. At the last run it also reported:

- **Access log** — `hzn_access_log`, `hri_access_log` beside canonical `hgov_access_log`. Rule 17
  requires every sensitive read to be logged; three logs mean an access review has three places to
  look and no guarantee it found them all.
- **Intelligence result** — `horizon_interpretations`, `horizon_dimension_results`, `hif_readings`,
  `hif_snapshots` beside canonical `hzn_intelligence_result`, which `schema.ts` declares as THE
  standard output, superseded rather than updated in place.
- **Computation run** — `fpc_computation`, `horizon_dimension_factors` beside `hzn_computation`.
  `hzn_computation` is what makes INPUTS → PROCESSING → OUTPUT → EVIDENCE → CONFIDENCE → TIMESTAMP
  reconstructable months later; two run logs means that chain reconstructs two ways that can
  disagree.
- **Personal foundation** — `fpc_subject_input` beside `hzn_personal_foundation`. The most sensitive
  record in the system, held twice.
- **Human decision** — `hiring_decisions` (Patch 10) beside `hgov_decision_log`. Rule 14 says the
  final employment decision is a named human's row; there must be one place it lives.
- **Event outbox** — `mti_record_outbox` beside `hzn_event`.
- **Recorded human action** — `mti_manager_actions` beside `hri_interventions`.

### What this patch deliberately did NOT do about them

It did not delete or migrate another patch's table. The brief's own duplicate procedure is: determine
the canonical owner → migrate safely → preserve backward compatibility → update consumers →
deprecate the duplicate → **never silently destroy historical data**. Steps two through five are not
something one agent does to four other agents' live modules in a single pass, and rule 6 forbids
overwriting another agent's implementation.

So the canonical owner is **named**, the duplication is **proved from the declarations themselves**,
and the migration is **handed over** with the owing patch numbers listed.

### The drift guard

A table nobody has classified is reported as *unclassified*, not ignored. When a fifty-first table
appears in somebody's `schema.ts`, that is what notices before it becomes a fifth consent ledger.

---

## What the checker proves, and what it cannot

It reads the repository. It opens **no database**, exactly as this project's working rules require —
a subagent asked to survey source files once opened production instead and read staff data out of
`hr_employees`. So it establishes which tables this codebase *intends* to exist, not which ones a
live environment has.

The Definition of Done therefore has three values, not two:

- **Proven** — established by evidence in this run.
- **Not met** — disproven by evidence in this run.
- **Needs a live run** — a static read cannot settle it. Events, end-to-end flows, server-side
  permission enforcement, concurrency and regression all sit here.

An item in the third state is **not a pass** and is never counted as one. The brief's closing
instruction is *do not claim completion unless the complete integrated system actually works*, and
the most likely way to violate it is a checker nobody checked — which is why every test in
`integration.test.ts` feeds fabricated evidence, including evidence that says everything is finished,
and asserts on what the assessor concludes.

---

## Things found and fixed during this pass

- **Five build-breaking syntax errors**, in three patches' files, all the same defect: an unescaped
  apostrophe inside a single-quoted string (`'this person's own year'`). Each author was working in
  their own subtree and could not see that the build was failing in somebody else's.
  `scanUnterminatedStrings()` in `collect.ts` now catches the class, and the checker reports it.
- **A reach over-report in this patch's own first draft.** It used Patch 19's `reachOf()`, which
  tail-matches `/types` by design, and reported 16 of 21 patches as reachable when the true number
  was zero — because 126 unrelated files import something ending in `/types`. Reach is now matched
  exactly. There is a regression test.
- **A table called `written`**, invented by a `CREATE TABLE IF NOT EXISTS` regex that matched the
  prose in a comment. A checker that invents a table is worse than one that misses a real one.

---

## Placement

Five patches placed their module outside `src/lib/horizon/`. It is recorded, not corrected — moving
another agent's directory mid-build is the overwrite the multi-agent rules exist to prevent, and it
costs nothing at runtime. It costs a reader the ability to find the system by listing one directory,
which is a documentation problem with a documentation fix, and this is it.

---

## Still missing

`src/lib/horizon/ids.ts` cites `docs/horizon/HORIZON_CONTRACTS.md` sections 2, 3, 6, 7, 8, 9 and 10.
**That document does not exist.** Every patch that read the citation had to infer the contract from
the code, and that is the most plausible single cause of the divergences above. It belongs to
Patch 00, not to this one.
