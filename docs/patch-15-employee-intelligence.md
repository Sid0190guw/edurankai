# Patch 15 — Employee Personal Intelligence Portal

**Surface:** `/portal/employee/intelligence`
**Modules:** `src/lib/intelligence/*`
**Owns three tables:** `emp_intel_reflection`, `emp_intel_consent`, `emp_intel_correction`
**Reads, does not own:** the digital twin, the evidence graph, the job twin, performance, learning,
EIMS evidence, tasks, goals, `audit_log`.

---

## What this patch is

A **view**, for exactly one reader: the person it is about. It composes the Master Employee
Intelligence Record that already exists in this codebase into ten sections that an employee can read
about themselves, and it adds the three things they can *do* — reflect, decide what their record may
be used for, and say a record is wrong.

It is not a second intelligence record. `src/lib/digital-twin.ts` is the master record and this patch
calls it; `src/lib/evidence-graph.ts` remains the answer to "why does the system believe this".

## The route

| Tab | `?tab=` | What it holds |
|---|---|---|
| Your record | `record` (default) | The ten sections, each statement with its receipt |
| Reflection | `reflection` | The employee's own words. Write, edit, share, delete |
| Privacy | `privacy` | Consent, what is recorded against the record, correction requests, and what the page never shows |

No id in the URL, no id parameter anywhere. `resolveEmployeeIdentity()` resolves the reader to their
own `hr_employees` row and every query is narrowed to it. `loadSelfSources()` additionally refuses to
compose if the viewer's employee id and the subject's do not match — a mismatch is a programming
error, not a permission question, and it returns an empty bundle.

## The ten sections

`strengths` · `role_alignment` · `growth_areas` · `skill_development` · `behavioural_trends` ·
`development_plan` · `achievements` · `time_insights` · `feedback_summary` · `reflection`

Their labels and purposes are in `SELF_SECTIONS` / `SECTION_LABELS` / `SECTION_PURPOSE`
(`src/lib/intelligence/contract.ts`).

## The explainability envelope

Every statement on the screen is an `Insight` and carries all six:

```
INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
```

`renderableInsight()` drops any insight missing one of them, and the composer applies it rather than
trusting each section to remember. An insight with **no** evidence rows is permitted only at
confidence `insufficient`, where the absence is precisely what it is reporting.

**Confidence is ordinal, never a percentage:**
`insufficient` → `partial` → `observed` → `corroborated`, each with a written meaning in
`CONFIDENCE_MEANING`. A number would invite arithmetic the underlying records cannot support.

## Three different empties, never collapsed

| State | Sentence | Where |
|---|---|---|
| Nothing recorded | `NOTHING_YET_SENTENCE` | ordinary early on |
| Suppressed | `SUPPRESSED_FEEDBACK_SENTENCE` | there *is* something, and showing it would identify a colleague |
| Unreadable | `UNREADABLE_SENTENCE` | the query did not come back — never rendered as "you have none" |

Each source carries its own `ok`, so a failure in one does not blank the other nine. The page also
names the failing sources at the top.

## What is deliberately not shown

`NEVER_SHOWN` is printed on the Privacy tab, because a person told what is withheld and why can ask
about it, whereas a screen that quietly omits things teaches nothing.

- Confidential HR notes — never queried.
- Feedback authorship — the bundle handed to the composer carries a **theme and a date and nothing
  else**, so attribution cannot leak even by accident.
- Internal risk or review scoring — no such value is composed, and none exists on this page.
- Anything about another employee.
- Internal computation detail — the *rule* is printed in plain words beside every statement, which is
  the part that can be checked and disputed.

`WITHHELD_KEY_SEGMENTS` / `isWithheldKey()` / `screenPayload()` are a name-level backstop, modelled on
`screenColumns()` in `digital-twin.ts`. The primary control is that this patch never queries those
sources.

## Suppression floors

| Floor | Value | Why |
|---|---|---|
| `MIN_FEEDBACK_NOTES` | 3 | a summary of one or two notes points at whoever wrote them |
| `MIN_TREND_POINTS` | 4 | a line through two dots is noise with a direction |

## The language rule, enforced

`DETERMINISTIC_PATTERNS` in the contract lists the ways a sentence stops describing records and
becomes a verdict on a person; `languageProblems()` finds them. The test suite runs it over every
string the composer can emit under both an empty record and a full one, and over the fixed copy. A
sentence that fails does not ship. One test asserts every pattern is reachable, so the lint cannot
rot into a decoration.

No birth-based or traditional-computation vocabulary appears anywhere in this patch, on any surface —
it is absent rather than softened, and there is no input to this view that could carry such a signal.

## Consent

`INTELLIGENCE_PURPOSES` is a closed list of four. Append-only in `emp_intel_consent`: a withdrawal is
a new row, so the table can answer "was this person opted in on the day their record was used".

| Purpose | Default when undecided | Who sees anything |
|---|---|---|
| `development_suggestions` | **on** | only the employee; nothing leaves their screen |
| `reflection_visible_to_manager` | off | the reporting manager, per entry the employee marks |
| `internal_opportunity_matching` | off | the people running that internal opening |
| `aggregate_reporting` | off | nobody — group figures only |

Undecided is never treated as consent for anything that reaches another person. A **failed** consent
read is not a grant either: the defaults it falls back to are the same false values.

Withdrawing `reflection_visible_to_manager` calls `unshareAllReflections()`, so previously shared
entries actually become private again. A withdrawal that withdraws nothing is not a withdrawal.

There is deliberately **no** consent checkbox for using a person's record to decide something about
them. Consent is not the control that would make that acceptable.

## Correction requests

The employee files one against the exact section and statement they read. It goes to a **person**:

- Nothing in this module edits the disputed record, and no write to another module's table exists
  here. Whoever answers `corrected` makes the change in the owning module; this only records that
  they did.
- No automatic transition: nothing ages out, nothing is auto-declined, no derived signal closes one.
- `decideCorrection()` requires a named decider, a decision, and a **written reason** — all three.
- The employee can withdraw their own while it is `open` or `acknowledged`.

## Reflections

Private by default on every row. Nothing in this codebase reads `body` as a signal, scores it or
aggregates it; `reflectionSummary()` exists so the composer receives a **count and a date** with
nowhere to put the words. `period_word` is a label for the person's own scanning and is equally inert.
Deleting is a real `DELETE`.

Sharing needs two things to be true — the consent purpose is on **and** the employee marked that one
entry — and the consent check is server-side on every call, not inferred from a control not being
rendered. Turning sharing *off* is always allowed regardless of consent state.

## Human-in-the-loop

Nothing on this surface makes or contributes to a hiring, promotion, termination or disciplinary
decision. There is no score, rank, percentile, comparison with a colleague, or prediction anywhere in
the composer, and `DETERMINISTIC_PATTERNS` refuses the sentences that would introduce one.

## Files

| Path | Role |
|---|---|
| `src/lib/intelligence/contract.ts` | Sections, the envelope, the exposure boundary, the language lint. **Owned contract — extend additively.** |
| `src/lib/intelligence/schema.ts` | The three owned tables, one `ensureBatch` round trip |
| `src/lib/intelligence/consent.ts` | Purposes, consent state, data usage, correction requests |
| `src/lib/intelligence/reflection.ts` | Prompts, entries, sharing |
| `src/lib/intelligence/self-view.ts` | **Pure.** The ten composers and `composeSelfIntelligence()` |
| `src/lib/intelligence/sources.ts` | The only I/O. Reads the owning modules and narrows the bundle |
| `src/lib/intelligence/self-view.test.ts` | 36 tests, no database |
| `src/pages/portal/employee/intelligence.astro` | The surface |
| `db/employee-intelligence.sql` | Run this in production — see below |

## Deployment

`SCHEMA_BOOTSTRAP` defaults to **off** in production (`src/lib/ensure-once.ts`), so the application
will not create these tables for you:

```
psql "$DATABASE_URL" -f db/employee-intelligence.sql
psql "$DATABASE_URL" -c "\dt emp_intel_*"
```

Until that runs, the page still **loads** — every read tolerates a missing table and the sections
report they could not be read — but nothing can be saved.

## Known limitations

1. **Role alignment uses the hiring path.** `hr_employees` has no `role_id`; the only recorded link is
   `hr_employees.application_id -> applications.role_id -> roles`. That names the role the person was
   *hired into*, which may not be the role they hold now. Matching the free-text `designation` against
   role titles was rejected — that is the keyword-as-proof failure `job-twin.ts` exists to avoid. With
   no application link the section says the record is not connected to a role.
2. **`hr_feedback` has no anonymity column.** Rather than add one to another patch's table, this view
   summarises by theme and never attributes. Individual notes stay on `/portal/employee/performance`,
   which is that patch's decision.
3. **Data usage covers `audit_log` rows keyed to `hr_employee` + this employee's id.** Entries recorded
   against a review, a payslip or a learning assignment are keyed by *that* object's id and cannot be
   joined back to a person from this table. The coverage sentence says so on the page rather than
   letting a short list imply nothing happened.
4. **No HR-side queue screen.** `openCorrections()` and `decideCorrection()` are exported and ready;
   the admin surface belongs to whichever patch owns the HR console.
5. **Runtime unverified.** `astro check` and the unit suite pass and the production build compiles.
   Nothing here has been loaded in a browser from this environment, and no database was contacted.

## Handoff contract

Stable exports other patches may depend on:

```ts
// src/lib/intelligence/contract.ts   — types and policy. Extend additively; do not edit in place.
SELF_SECTIONS, SelfSection, SECTION_LABELS, SECTION_PURPOSE
Insight, SelfSectionView, EvidenceRef, Confidence, renderableInsight
NEVER_SHOWN, WITHHELD_KEY_SEGMENTS, isWithheldKey, screenKeys, screenPayload
MIN_FEEDBACK_NOTES, DETERMINISTIC_PATTERNS, languageProblems

// src/lib/intelligence/self-view.ts  — pure composition
SelfSources, SelfIntelligence, composeSelfIntelligence, monthlyBuckets, MIN_TREND_POINTS

// src/lib/intelligence/sources.ts    — I/O
loadSelfSources(input), buildSelfIntelligence(input), roleLinkFor(employeeId)

// src/lib/intelligence/consent.ts
INTELLIGENCE_PURPOSES, consentState, hasConsent, recordConsentDecision
dataUsage, usageLabel
listCorrections, requestCorrection, withdrawCorrection
openCorrections, decideCorrection            // <- the HR-side seam

// src/lib/intelligence/reflection.ts
REFLECTION_PROMPTS, PERIOD_WORDS
myReflections, reflectionSummary, writeReflection, editReflection, deleteReflection
setReflectionShared, unshareAllReflections
```

**Audit actions written** (all on `entity: 'hr_employee'`, `entityId: <employeeId>`):
`intelligence.consent.granted`, `intelligence.consent.withdrawn`,
`intelligence.correction.requested`, `intelligence.correction.withdrawn`,
`intelligence.correction.decided`,
`intelligence.reflection.written`, `intelligence.reflection.shared`.
Reflection bodies and correction text are **never** placed in an audit `diff`.

**If you build the HR-side correction queue:** call `openCorrections()` for the rows, resolve employee
names through the module that owns `hr_employees` (this one deliberately joins no names), gate the
screen on your own capability, and answer with `decideCorrection()` — which will refuse without a
named decider and a written reason. Make the actual record change in the module that owns the record;
this queue is not a back door into HR tables.

**If you add a section:** add the key to `SELF_SECTIONS`, a label and a purpose, a composer in
`self-view.ts`, and the fields it needs to `SelfSources` — then extend `loadSelfSources()` to narrow
them. Run `languageProblems()` over every string you emit; the test suite will do it anyway.
