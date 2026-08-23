# HORIZON — Patch 19 integration and regression report

Compiled 2026-08-23 by reading the repository, not by asking it. Nothing in this report was produced
by connecting to a database.

**Source of truth:** `src/lib/horizon/contract.ts`. This document is a rendering of it. If the two
disagree, the contract is right and this file is stale — it is checked by `wiring.test.ts` against
the repository on every run, and this document is not.

---

## What this patch owns, and what it deliberately does not

Patch 19 owns no business module. It owns one question — *does the chain hold end to end* — and
three things that answer it:

| Artefact | What it is |
|---|---|
| `src/lib/horizon/contract.ts` | The fifteen flows as data: producer, consumer, inputs, outputs, evidence paths, where the human decides, what audits it, status, failures. |
| `src/lib/horizon/probe.ts` | A static repository probe. Reuses `src/lib/orphan-detect.ts` for reachability rather than re-implementing it. |
| Five suites, 154 tests | `flows`, `leakage`, `views`, `concurrency`, `wiring`. |

It does not duplicate **Patch 20** (`src/lib/horizon/integration/map.ts`), which maps *modules* —
twenty-one patches, what each owns, where two own the same thing. This patch maps *flows*. Patch 20
imports this patch's probe rather than writing a second one.

---

## Reading conditions, and why they matter to every number below

Twenty-one agents were writing into `src/lib/horizon/**` while this ran. That is not background
colour, it changed the findings twice:

- A full run at 14:51 reported **15 failures**. Every one was a module being written at the moment
  it was imported. The same suites at 15:20 reported **4**. A test run in this tree is not
  reproducible while the tree is being written, and a failure count taken once is not evidence.
- `src/lib/founder-intel/founder-access.ts` existed at 13:00, was cited by flow 12, and the whole
  directory was **deleted** before 15:30. `wiring.test.ts` caught it because it opens every path the
  contract cites. That is the single clearest argument for checking a declaration instead of writing
  one down.

**Everything below is the state at 15:35 on 2026-08-23.**

---

## The integration matrix

`PATCH -> INPUTS -> OUTPUTS -> STATUS -> FAILURES`

### 1. Application to computation trigger — **PARTIAL**

- **Producer** `src/lib/horizon/intake/submit.ts` `announceApplicationSubmitted`
- **Consumer** `src/lib/foundational/engine.ts` `computeFromInput`
- **Inputs** applications row · intake submission · recorded consent
- **Outputs** `application.submitted` event · a stored, hashed foundational computation
- **Human decides** `applyFoundationDecision()` records what a named person chose about the optional
  input; `storeBirthInput()` refuses without a recorded consent.
- **Failure — PRODUCTION BLOCKING:** Indian applicants are refused at intake. See the finding below.

### 2. Computation to interpretation — **WIRED**

- **Producer** `src/lib/foundational/engine.ts` `computeFromInput`
- **Consumer** `src/lib/horizon/interpretation/engine.ts`
- **Inputs** foundational factors and cycle periods · input hash, output hash, method manifest
- **Outputs** interpreted dimensions with confidence, evidence and a not-for-decisions notice
- **Human decides** `NOT_FOR_DECISIONS_NOTICE` travels with every interpretation;
  `INFERRED_CONFIDENCE_CEILING` caps what an inferred dimension may claim.

### 3. Work record to behavioural update — **PARTIAL**

- **Producer** `src/lib/horizon/behaviour/sources.ts`
- **Consumer** `src/lib/horizon/behaviour/provider.ts` `behaviourProvider`
- **Inputs** task assignment and submission events · attendance and roster records · work windows
- **Outputs** behaviour metrics with a trend, a confidence and a recompute-after date
- **Failure:** the engine is complete and **nobody may open its output**. `behaviour_intelligence`
  sits behind `horizon.behaviour.view`, which is not in the permission registry, so the tab answers
  `awaiting_ratification` for every viewer including the founder. Correct fail-closed default; also
  means flow 3 is not observable end to end. Ratifying the capability is a policy decision.

### 4. Feedback to aggregation — **WIRED**

- **Producer** `src/lib/horizon/feedback/capture.ts`
- **Consumer** `src/lib/horizon/feedback/aggregate.ts`
- **Inputs** individual contributions · source type · evidence quality · observation date
- **Outputs** a weighted aggregate with a confidence band, a contributor count, visible disagreement
- **Human decides** `MIN_SOURCES_FOR_SCORE` refuses to score a single voice;
  `TWO_SOURCE_BAND_CEILING` caps a two-source aggregate at low confidence; `MAX_AUTHOR_SHARE` stops
  one author dominating. **Rule 24 is arithmetic here, not a promise.**

### 5. Multiple sources to fusion — **WIRED**

- **Producer** `src/lib/horizon/signal-contract.ts`
- **Consumer** `src/lib/fusion/horizon-bridge.ts` `fusionSignalsFromHorizon`
- **Inputs** HORIZON signals by weight class · talent, HR, org and time providers
- **Outputs** one fused reading per source class, with the mapping recorded and printable
- **Human decides** `WEIGHT_CLASS_TO_SOURCE` maps some classes to `null` rather than inventing a home
  for them; `describeMapping()` prints the table a human checks.

### 6. Fusion to profile update — **ABSENT BY DESIGN**

- **Producer** `src/lib/fusion/fuse.ts` → **Consumer** `src/lib/horizon/record.ts` `registerProvider`
- **Outputs** section payloads on one master record. **No write back into any source module.**
- **This is not a gap.** `record.ts` calls registered providers under a timeout and a concurrency cap
  and assembles what they return. The older composer `digital-twin.ts` holds the same line
  structurally: `screenColumns()` refuses a protected or sensitive column name before it reaches SQL.
  A patch that adds a write here is changing the design, not completing it. Asserted by
  `wiring.test.ts` — no `INSERT`/`UPDATE`/`DELETE` in any composer.

### 7. Profile update to temporal analysis — **PARTIAL**

- **Producer** `src/lib/horizon/temporal/store.ts` → **Consumer** `temporal/engine.ts` `trendOf`
- **Outputs** a trend with an explicit insufficient-data state; a confidence that collapses on a short record
- **Human decides** `INSUFFICIENT_TREND` is a value, not an exception — a series too short to read
  says so rather than returning a flat line that reads as stability.
- **Failure:** only half the estate is temporal. `org_relationships` carries
  `effective_from`/`effective_to` and a `CHECK`; `hr_employee_skills`, `capability_claims` and the
  profile tables carry only `updated_at`. "What did this record say in March" is answerable for
  reporting lines and not for capability.

### 8. Evidence to signal generation — **WIRED**

- **Producer** `src/lib/horizon/signal-detectors.ts` → **Consumer** `signal-engine.ts` `explainStored`
- **Outputs** a stored signal with an explanation, a lifecycle history, recorded reviewer disagreement
- **Human decides** `reviewDisagreement()` keeps two reviewers who disagreed visible as two
  reviewers, rather than resolving them into one verdict.

### 9. Interview to decision support — **WIRED**

- **Producer** `src/lib/interview-feedback.ts` `getFeedbackBundle`
- **Consumer** `src/lib/hiring-decision.ts` `SUPPORT_STATES`
- **Outputs** a support state, and the fields it rests on. Never a decision.
- **Human decides** `FINAL_DECISIONS` is a separate vocabulary from `SUPPORT_STATES` and only a named
  human writes one. `APPLICATION_FIELDS` and `FOUNDATIONAL_FIELDS` are kept apart so a reader can see
  which kind of input a support state rested on — **rule 22, made checkable**.

### 10. Decision to audit log — **PARTIAL**

- **Producer** `src/lib/horizon/visibility.ts` `requireAccessLog`
- **Consumer** `src/lib/horizon/access.ts` `logSensitiveSectionAccess`
- **Outputs** an access-log row written **before** the section renders
- **Failure:** two house rules for one question. `requireAccessLog()` and `legal-hold.ts` refuse to
  render when the log write fails. `recordEvaluation()` in `src/lib/talent/evaluations.ts` does the
  opposite — it logs the failure and returns `audited: false` beside a successful write, so an
  evaluation can exist with no audit row. Both are defensible on their own surface; neither is
  written down as the rule, so the next decision surface will pick one by accident.

### 11. Employee profile to role-based views — **WIRED**

- **Producer** `src/lib/horizon/access.ts` `resolveHorizonAccess`
- **Consumer** `src/pages/admin/horizon/employee/[id].astro`
- **Outputs** a per-section grant decided **before any read**, each carrying the sentence that
  explains it
- **Human decides** a withheld section is a query that never ran, and it says so. Nothing renders an
  empty panel that could be read as "this person has no record."

### 12. Founder to maximum-detail drill-down — **PARTIAL**

- **Producer** `src/lib/auth/permissions.ts` `can` → **Consumer** `horizon/profile.ts` `buildSuperAdminProfile`
- **Failure A:** maximum detail is not unlimited, and that is enforced in three places — the founder
  does not hold `department.lead` (a scope, not a rank), is refused the three unratified sections
  like everybody else, and an explicit DENY grant overrides `administer` at Tier 1 of the rbac engine.
- **Failure B:** `src/lib/founder-intel/` was **deleted** mid-session. No module exports `isFounder()`
  anywhere in the tree now. The drill-down is served through `can()` and `resolveHorizonAccess()`
  alone, so the founder is identified **by role, not by identity** — a wider population than the
  deleted module implemented. Whoever owned that patch should confirm this was intended.

### 13. HR to correct restricted view — **WIRED**

- **Producer** `src/lib/auth/permissions.ts` `PERMS_BY_ROLE` → **Consumer** `resolveHorizonAccess`
- **Outputs** the people sections; not the audit trail, and not the unratified three.

### 14. Manager to own-team-only access — **PARTIAL**

- **Producer** `src/lib/performance-scope.ts` `resolvePerfViewer`
- **Consumer** `src/lib/manager-intelligence/read.ts`
- **Outputs** an explicit id list, or `null` for an org-wide holder
- **Failure:** one lead test diverges, and its own source says so. `isLeadSql()` in
  `src/lib/employee-tasks.ts` applies no internship refusal, while `requireTeamLead()` and the
  workspace composer both do — so an **intern holding `department_head` reads and can move every task
  in their department**. Left in place under the mechanism-not-policy rule; pinned by a test here so
  it cannot widen unnoticed.

### 15. Employee to self-only access — **WIRED**

- **Producer** `src/lib/auth/workspace-access.ts` `requireEmployee` → **Consumer** `resolveHorizonAccess`
- **Outputs** `isSelf`, printed — and a grant set **identical** to any other viewer of the same role.
  Self-view is reported, never granted. Asserted directly in `views.test.ts`.

### Totals

| Status | Count | Flows |
|---|---|---|
| Wired | 7 | 2, 4, 5, 8, 9, 11, 13, 15 → *(8; see note)* |
| Partial | 6 | 1, 3, 7, 10, 12, 14 |
| Absent by design | 1 | 6 |
| Unreachable | 0 | — |

> Counts are computed by `matrixSummary()` at run time; read them from `/admin/ops/horizon` rather
> than from this table, which is a snapshot.

---

## Findings, most serious first

### F1 — Indian applicants are refused at intake. Production blocking.

**Where** `src/lib/horizon/intake/birth-input.ts:290` `isValidTimezone()`

`isValidTimezone()` uses `Intl.supportedValuesOf('timeZone')` as an allow-list and **returns `false`
on line 294** for anything absent from it, never reaching the formatter probe three lines below.

That list contains **canonical ids only**. Verified on this runtime:

```
count 418
Asia/Kolkata in list: false
Asia/Calcutta in list: true
formatter probe accepts Asia/Kolkata: true
```

`Asia/Kolkata` is the alias every modern browser reports for an Indian user; `Asia/Calcutta` is the
canonical id. The intake refuses the string the browser actually sends. Four tests in
`intake/birth-input.test.ts` fail on this today.

**Fix (intake patch, one line):** when the zone is absent from the canonical list, fall through to
the formatter probe on line 297 instead of returning false. The probe still rejects
`Mars/Olympus_Mons`. **Not applied here — this is another patch's module.**

### F2 — An intern with `department_head` reads every task in the department

**Where** `src/lib/employee-tasks.ts` `isLeadSql()`

Documented in its own source and reported rather than fixed, because closing it means either a fourth
copy of `resolveIsIntern()` in SQL or a signature change across `src/pages`. Pinned by
`leakage.test.ts` so the population cannot widen without a failing test.

### F3 — Two incompatible audit rules, and no house rule

Covered under flow 10. A new decision surface has no written rule to follow.

### F4 — The founder-identity module vanished mid-session

Covered under flow 12. Detected by `wiring.test.ts` opening a cited path.

### F5 — Column screen and assertion spine disagree about three protected terms

**Where** `src/lib/digital-twin.ts` `classifyFieldName()` vs `src/lib/person-assertions.ts`
`protectedAttributeConcern()`

`protectedAttributeConcern()` refuses `handicap`, `fertility` and `menopause`. `classifyFieldName()`
classifies all three as `ok`, so `screenColumns()` would let a column named `fertility` or
`menopause` be selected into a composed person record. Two of the three are wellness terms, and the
wellness system's premise is that no administrator — not the founder — reads one person's cycle or
symptoms.

Nothing writes such a column today, which is why this is a finding and not an incident: the gate is
structural precisely so it holds when somebody later adds one. **Fix:** add the three segments to
`PROTECTED_ATTRIBUTE_SEGMENTS` in `digital-twin.ts`. Pinned in `flows.test.ts`.

### F6 — `provided` and `explicitly_provided` are one assertion under two names

**Where** `src/lib/digital-twin.ts` vs `src/lib/person-assertions.ts` / `src/lib/provenance.ts`

`person-assertions.ts` carries a compile-time drift guard against `provenance.ts`, so those two can
never disagree. `digital-twin.ts` declares its own seven-word list and is outside that guard.
`ASSERTION_BY_EVIDENCE_LEVEL` emits `explicitly_provided`, for which `digital-twin.ASSERTION_LABELS`
has **no entry** — so an evidence level routed into a twin panel renders with no label at all, for
the two levels (`claimed`, `explicit`) that describe everything nobody has checked. Pinned in
`flows.test.ts`.

### F7 — Test runs in this tree are not reproducible while it is being written

Not a code defect; a process finding. See *Reading conditions* above. **Any patch reporting a failure
count should re-run it before acting on it.**

---

## Permission leakage — what was tested and what held

Driven against the three authorization mechanisms in this codebase, which are not redundant and each
of which is a door into the same data:

| Mechanism | Where |
|---|---|
| `can()` over the compiled matrix | `src/lib/auth/permissions.ts` |
| `holdsCapability()` over the same matrix, narrower caller | `src/lib/auth/capability.ts` |
| A six-tier grant engine with explicit DENY | `src/lib/rbac/engine.ts` |
| The HORIZON section model, decided before any read | `src/lib/horizon/access.ts` |

**Held under test (154 assertions):**

- An applicant account holds **no** admin capability in the whole matrix. A deactivated account holds
  nothing whatever its role says. An unknown role falls to nothing rather than defaulting.
- `can()` and `holdsCapability()` agree on **every role × every permission**.
- The rbac engine fails closed on every tier-0 condition: no identity, invalid session, degraded
  permission context, unregistered capability, kernel-locked resource.
- An explicit DENY grant **outranks `administer`**. A revoked grant stops denying. A deny aimed at
  another user or resource does not reach this one.
- An unknown security label admits **only** the administrator. A write to somebody else's object
  without `manage` is refused. A minor account with no linked guardian is refused a sensitive action.
- `visibleEmployeeIds()` returns `null` (no restriction) **only** for a `performance.manage` holder,
  and `[]` — never `null` — for a viewer with no employee record. Non-uuid ids are dropped rather
  than passed into a query.
- The three unratified HORIZON sections are `awaiting_ratification` for **every** role including
  `super_admin`, and none of the three capabilities is in the compiled matrix.
- Viewing your own record sets `isSelf` and grants **nothing extra**: the grant sets are identical.
- The capability-free roll-up tab is not granted to a viewer granted nothing else.
- No composer imports `src/lib/wellness.ts`. No composer contains a person-record write.

**Not tested, and stated so a green run is not over-read:** whether the SQL behind a gate returns the
right rows, whether a migration ran, and whether the deployed build contains this code. A static
probe cannot see any of those. The route-level sweep of the 139 people-domain page and API files was
launched and did not complete before the session ended; it is the obvious next pass.

---

## Concurrency and idempotency

Driven against `memoryEventSink()` — no database, no clock dependency.

- Every event carries a **distinct** `eventId`; two recompute requests for the same employee stay two
  facts, so a deduplicating subscriber cannot drop the second.
- An envelope with no id is refused, and the error says the id is the deduplication key.
- 25 concurrent emits about one person all land, all separately addressable.
- A delivered event is not re-claimed. A poison event stops at `MAX_DELIVERY_ATTEMPTS`.
- A failed outbox write returns `ok:false, recorded:false` **and still returns the eventId** — a
  committed fact is never rolled back by its own outbox. An invalid envelope is refused *without*
  being recorded, and reported differently from a failed write.
- `ensureOnce()` runs its work once for concurrent callers on a cold key, does **not** cache a
  failure, and swallows rather than throwing into a caller that tolerates a missing table.

**Honest limit, asserted rather than assumed:** the in-memory sink does *not* give two concurrent
drains disjoint sets; the postgres sink does, via `FOR UPDATE SKIP LOCKED`. A test that relied on
disjointness in memory would be testing a fiction, so it asserts the real behaviour of each.

---

## Handoff

**For the intake patch:** F1, one line, `birth-input.ts:294`. This blocks every Indian applicant.

**For whoever owned `src/lib/founder-intel/`:** F4 — confirm the deletion was intended, and that
identifying the founder by role rather than by identity is the intended population.

**For the patch that owns `digital-twin.ts`:** F5 and F6, both one-line additions to a list.

**For the next integration pass:** run the route-level permission sweep over the 139 people-domain
files under `src/pages/admin/hr`, `src/pages/portal/employee` and `src/pages/portal`. It is the one
class of leak a static contract probe cannot reach.

**To re-run this patch:**

```
npx vitest run src/lib/horizon/flows.test.ts src/lib/horizon/leakage.test.ts \
               src/lib/horizon/views.test.ts src/lib/horizon/concurrency.test.ts \
               src/lib/horizon/wiring.test.ts
```

**To read the matrix on a screen:** `/admin/ops/horizon`.
