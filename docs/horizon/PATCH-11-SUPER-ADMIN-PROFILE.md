# PATCH 11 — Super Admin Employee Profile

The twelve-tab authorised view of one person, with drill-down.
Companion to `docs/horizon/HORIZON_CONTRACTS.md` (Patch 00, the shared contract), which this patch
consumes and does not extend.

**Surfaces:** `/admin/horizon` (picker) and `/admin/horizon/employee/<hr_employees.id>` (the profile).
**Nav:** HR Management → Intelligence records. **Middleware section:** `employees`.

---

## What this patch owns, and what it deliberately does not

| Owns | Does not own |
|---|---|
| `src/lib/horizon/sections.ts` — the twelve-tab table | Any employee table. This patch creates none. |
| `src/lib/horizon/access.ts` — per-tab grants + access logging | `src/lib/horizon/types.ts` (Patch 00's vocabulary) |
| `src/lib/horizon/profile.ts` — the composer | `src/lib/horizon/record.ts` (the MEIR itself) |
| `src/lib/horizon/contracts.ts` — the view-side payload shapes | `src/lib/horizon/visibility.ts` |
| `src/lib/horizon/meir-bridge.ts` — MEIR → tab translation | Any producing patch's engine |
| `src/lib/horizon/adapters.ts` — five tabs from records already in this tree | |
| `src/lib/horizon/registry.ts` — the pre-MEIR provider seam (see *Two registries*) | |

`src/lib/horizon/index.ts` (Patch 00) already reserves `./access` for "the PROFILE-CONSOLE patch".
That is this one.

---

## The twelve tabs

| # | Tab | Capability | Filled by | Sensitive |
|---|---|---|---|---|
| 1 | Overview | `people.view_360` | local adapter (digital twin) | no |
| 2 | Professional Profile | `people.view_360` | local adapter + MEIR `capability` | no |
| 3 | Behaviour Intelligence | **`horizon.behaviour.view`** *(proposed)* | MEIR `collaboration`/`reliability`/`risk` | yes |
| 4 | Performance & Work Records | `performance.manage` | local adapter + MEIR `contribution`/`growth` | no |
| 5 | Personal Intelligence Summary | **`horizon.personal_summary.view`** *(proposed)* | MEIR `temporal_pattern` | yes |
| 6 | Work Sustainability | **`horizon.sustainability.view`** *(proposed)* | MEIR `wellbeing_aggregate` | yes |
| 7 | Time Intelligence | `attendance.roster.manage` | MEIR patch `horizon-temporal` | no |
| 8 | Feedback Intelligence | `performance.manage` | MEIR patch `horizon-feedback` | yes |
| 9 | Evidence & Records | `people.view_360` | local adapter (evidence graph) | no |
| 10 | Signals | *none — roll-up* | every granted tab | no |
| 11 | Decisions & Interventions | `employee.manage` | MEIR patch `horizon-hiring-decision` | yes |
| 12 | Audit Trail | `audit.view` | local adapter (`audit_log`) | no |

### The three capabilities that do not exist yet — and why that ships as-is

`can()` answers `PERMS_BY_ROLE[role].includes(perm)`. There is no wildcard: an invented key answers
**false for every role, super admin included**. Tabs 3, 5 and 6 are behind such keys on purpose.

Those three make a *new kind of statement about a person* — an interpretation, not a
re-presentation of a row somebody already holds the right to read. `people.view_360` cannot carry
them: its ratified description in `src/lib/auth/registry.ts` says there is "no score, rating or
prediction about a person anywhere behind it", and hanging three interpretive tabs off it would make
that published sentence false for everyone granted it on those terms.

Widening who may interpret a colleague is a **policy** change. This patch names the key, prints what
ratifying it would permit, reads nothing, and refers the decision to a human.

**To ratify one** (per key, requires an authorised human):

1. `src/lib/auth/permissions.ts` — add the string to the `Permission` union.
2. Same file — add it to the roles in `PERMS_BY_ROLE` that should hold it.
3. `src/lib/auth/registry.ts` — add an entry with `sensitive: true` and a description. Reuse the
   sentence already written in `PROPOSED_CAPABILITY_MEANING` (`src/lib/horizon/sections.ts`).

Nothing else changes. `src/lib/horizon/horizon.test.ts` asserts the tabs open the moment the key
answers true.

---

## Navigation principle

`SUMMARY → SIGNAL → PATTERN → EVIDENCE → ORIGINAL AUTHORISED RECORD`

`DRILL_RUNGS` in `sections.ts`. Every tab computes `reachableDepth()` from what it actually holds and
prints `depthSentence()`. A summary that stops at `summary` is drawn as *a statement nobody has
backed yet* rather than the same as one that reaches a row — that distinction is the point.

---

## The order the composer runs in, and why

1. **Resolve the person** — `resolvePerson()`, id graph only. No name, no code, no status: the
   authorization question is asked *about* those rows and cannot be asked before we know which they are.
2. **Decide every tab** — `resolveHorizonAccess()`. Pure, synchronous, no database.
3. **Write the access log for every sensitive tab, and check it landed.** A failed write **revokes**
   the grant for that tab. Same rule `src/lib/legal-hold.ts` enforces: where the audit row is the
   control, the control has to have happened.
4. **Read** — one digital twin, one evidence call, one audit query, one `composeRecord()`.
5. **Roll up** — Signals, sorted so demonstrated work sits above anything inferred.

Withheld means **not read**, never read-then-hidden. `composeRecord()` is called with only the
dimension families the viewer was granted, so a provider for a withheld tab is never asked.

---

## Rules 12–27, where each one lives

| Rule | Where |
|---|---|
| 12 INPUTS→…→TIMESTAMP | `MeirFinding` carries dimension, engine, evidence, confidence, `computedAt` |
| 13 five kinds of statement | `DataClass` + `DATA_CLASS_BY_LAYER` (bridge) |
| 14 no automated decision | No writer in this patch creates a decision; `DecisionRecord` requires a named human |
| 17 access-logged | `logProfileOpen`, `logSensitiveSectionAccess`, `logDrill` → `audit_log`, entity `horizon_profile` |
| 18 no leaking computation to unauthorised roles | per-tab capability; withheld tabs are not read |
| 19/21 terminology | `screenTerminology()` at the bridge **and** at the page boundary; substitutions counted and shown |
| 22 demonstrated outranks inferred | `SIGNAL_WEIGHT_CLASSES` order + `compareSignalWeight()`; `non_evidential → birth_based_inference` (floor) |
| 23 signals name their sources | `Signal.evidence: EvidenceRef[]` |
| 24/25 feedback is not org truth | `FeedbackAggregate` carries `disagreement`, `biasNotes`, outlier flags |
| 27 no diagnosis | `SUSTAINABILITY_REFUSALS`, printed above tab 6 whatever it contains |

There is **no** function in `contracts.ts` matching `/score|total|average|composite|aggregate/` — a
test asserts it. Ordering is the only operation this patch offers over signals.

---

## Two registries — read this before you register anything

| | `record.ts` `registerProvider()` | `registry.ts` `registerHorizonProvider()` |
|---|---|---|
| Owner | Patch 00 | Patch 11 |
| Keyed by | `patchId` + `DimensionRef` | `HorizonSectionKey` |
| Returns | `IntelligenceResult[]` / `Signal[]` | a whole `SectionPayload` |
| Use it when | **default — use this** | you want to own an entire tab's panel, bypassing the bridge |

**Producing patches should use `registerProvider()` from `src/lib/horizon/record.ts`.** The bridge
routes your results to the right tab automatically:

- by `patchId`, if it is in `PATCH_TO_SECTION` (`meir-bridge.ts`) — add yours there in one line, or
- by `DimensionRef.family`, via `FAMILY_TO_SECTION`, which covers all eight families.

An unrecognised family lands on **Signals** with its own sentence rather than being dropped. You do
not need this file edited to appear on the screen.

`registerHorizonProvider()` remains for a patch that wants to render a bespoke panel. It refuses a
second claim on a section rather than overwriting the first, and the collision is printed on the page.

---

## Consumers of this patch already in the tree

`src/lib/founder-intel/*` imports `buildSuperAdminProfile`, `SuperAdminProfile`, `SectionView`,
`DrillRung`, `HorizonSectionKey`, `HorizonViewer`, `Signal`, `EvidenceRef`, `DecisionRecord`,
`InterventionRecord`, `sortSignalsByWeight`, `SIGNAL_WEIGHT_LABELS/MEANING`, `DATA_CLASS_MEANING`.
`src/lib/fusion/horizon-bridge.ts` and `src/lib/foundational/neutrality.test.ts` also import from
`contracts.ts`. **Those names are now a published contract — extend additively, do not rename.**

---

## Known limitations

1. **No live-data verification.** No database was connected and no `.env*` was read (project rule).
   Every claim here is source-level. The tabs have not been observed against production rows.
2. **Three tabs are dark until a capability is ratified.** By design; see above.
3. **`Signal.evidenceIds` are not resolved.** Patch 00's `Signal` carries evidence *ids*; resolving
   them is the owning patch's read, not this view's. The reference is shown, the row is not fetched,
   and the sentence says so.
4. **The Audit Trail tab is a 180-day / 100-row window** filed against this person's employee id or
   login id. Actions recorded against a different entity id do not appear. Stated on the tab.
5. **No `href` is invented into another patch's screens.** Where a producing patch supplies a
   `documentUrl` it is linked; otherwise the last rung says it opens nothing.
6. **`src/lib/horizon/report/providers/meir.ts:254`** casts Patch 00's `Signal` to this patch's
   `Signal` directly; `tsc` flags it. Use `toSignal()` from `meir-bridge.ts` instead — that is what
   it is for. Not fixed here: it is that patch's file.
7. **Pre-existing red, not from this patch.** The repo-wide suite has one failing gate
   (`orphan-detect`: `src/lib/founder-intel/founder-profile.ts`, `src/lib/hiring-decision-horizon.ts`)
   and the typecheck ratchet reports 97 new errors — **none in this patch's files**. Both belong to
   other agents' in-flight work.

---

## Handoff contract for the next agent

- **Do not** add a thirteenth tab without adding it to `HORIZON_SECTION_KEYS` *and* `HORIZON_SECTIONS`
  — a test asserts the two agree, and the page, the access resolver and the tests all read that table.
- **Do not** rename anything exported from `contracts.ts`, `access.ts`, `sections.ts` or `profile.ts`:
  `founder-intel`, `fusion` and `foundational` import them today.
- **To put your intelligence on this screen:** implement `MeirProvider`, call `registerProvider()`,
  and either declare a `DimensionRef.family` the bridge already routes, or add one line to
  `PATCH_TO_SECTION`. Nothing else.
- **To make a tab sensitive:** set `sensitive: true` in `HORIZON_SECTIONS`. Access logging before
  render, and grant revocation on a failed log write, are then automatic.
- **Never** return a bare number from a provider. `ScoreOrLevel` has a `not_computed` member and this
  view renders its reason; a zero standing in for an uncomputed value is a lie about a person.

**Tests:** `src/lib/horizon/horizon.test.ts` (49) and `src/lib/horizon/meir-bridge.test.ts` (26).
Both pure — no database, no fixtures on disk.
