# Patch 10 — Human Hiring Decision Support

The final evidence aggregation for recruitment, and the record of what a human decided.

- **Module:** `src/lib/hiring-decision.ts`
- **Integration boundary:** `src/lib/hiring-decision-horizon.ts`
- **Surface:** `/admin/applications/{id}/decision`
- **Table:** `hiring_decisions` (DDL: `db/hiring-decision-schema.sql`)
- **Tests:** `src/lib/hiring-decision.test.ts` — 42, all pure, no database

---

## The one sentence

The report reads what is already recorded and says what it supports; the decision is four buttons a
named person presses, a reason they must write, and their account on the row.

Nothing here decides. `recordFinalDecision()` takes the decision as an argument, refuses to run
without a real actor id, and refuses to run without a written reason. `decided_by_user_id` is
`NOT NULL`, so an automated decision cannot be expressed in this table even by a caller that wants
to.

---

## What it reads, and through whom

Every input goes through the module that owns it. This patch owns one table and rebuilds nothing.

| Input | Read through | Notes |
|---|---|---|
| Application | this module, column **allowlist** | `SELECT` names every column; there is no `SELECT *` |
| Role requirements + evidence | `capability-coverage.ts` — `requirementsFor`, `subjectFor`, `coverageFor` | per-requirement state with its own evidence chain; that module refuses to total, and so does this one |
| Interviewer feedback | `interview_scorecards` / `interview_rounds`, using `interview-feedback.ts`'s own vocabulary | scoped read; see below |
| Assessment performance | `learning-doors.ts` — `passedAssessmentsFor` + one attempt count | see "the passed-only trap" |
| Assignments / work samples | `submissions.ts` — `portal_submissions`, plus the application's problem statement | reviewed submission = `demonstrated`; unreviewed = `stated` |
| Prior advisory readings | `capability-coverage.ts` — `decisionsFor`; newest `match_evaluations` row **read as stored** | never re-run |
| Funnel history and movement | `application-stages.ts` — `getStageEvents`, `advanceStage` | this module never writes `applications.stage` or `.status` |
| Candidate-facing wording | `person-assertions.ts` + `horizon/interpretation/language-guard.ts` | three independent screens |

### Why the scorecard query lives here

`interview-feedback.ts` owns those tables. Its exported reads are per-**interview**
(`getFeedbackBundle`) or unscoped-then-filtered-in-TypeScript (`listInterviewsForFeedback`, capped at
300 rows across the whole system). Neither answers "every scorecard for this application", and adding
a function to that module would be editing another patch's file. So this is a **read-only** query
using that module's own column names, with its own documented behaviour on a database where the
interview tables were never created: `absent`, said in words — not an empty list dressed up as "no
interviews yet". Private interviewer notes are deliberately not selected.

### The passed-only trap

`passedAssessmentsFor()` returns only passed attempts. On a hiring screen that is a biased input: a
candidate who attempted four assessments and passed one would read identically to one who attempted
one and passed it. So a second narrow read counts submitted attempts, and the panel states both
numbers.

---

## The columns this module will not read

`applications` carries `dob`, `birth_time` and `birth_place`. On a decision surface those are an age
proxy and a national-origin proxy, and a field that appears on a report read while a decision is
being made becomes a decision variable whether or not anyone intended it to.

- `APPLICATION_FIELDS` is the allowlist. `FOUNDATIONAL_FIELDS` is the denylist.
- `assertNoFoundational()` runs **at module load**. If the two lists ever intersect, importing the
  module throws — failing the build and every page that imports it — rather than quietly shipping a
  report with a birth date on it.
- `src/lib/hiring-decision.test.ts` fails at *collection* if that ever happens, with the reason.

There is no flag, no capability and no viewer that turns this off.

---

## The four support states

`strong_hire_consideration` · `hire_consideration` · `further_review_required` ·
`do_not_recommend_at_current_stage`

These describe **the record**, not the person. They are a separate TypeScript union from the four
human decisions, and no function maps one onto the other — so there is no path by which a computed
state becomes a decision.

The rule is exported as `SUPPORT_RULE_TEXT` and the screen prints it beside the state, in order:

1. **If any input could not be read → Further Review Required.** An outage is not evidence about a
   candidate. A perfect record plus one failed read does *not* produce Strong Hire Consideration, and
   a failed read never produces Do Not Recommend.
2. **If no requirements are recorded and no feedback is submitted → Further Review Required.** An
   empty record supports nothing in either direction.
3. **If any interviewer recommended against, or an essential requirement has nothing on record and no
   demonstrated evidence offsets it → Do Not Recommend at Current Stage.** Bounded to this stage and
   this role. It is not a statement about the person and it does not close the application.
4. **Strong Hire Consideration requires all of:** every essential requirement `evidenced` by a
   platform record, at least two interviewers submitted, none recommending against. Three strong
   hires cannot substitute for one missing platform record — that ordering is the whole point, and it
   is enforced in one place: `supportStateFor()`.
5. **Hire Consideration requires:** no essential requirement missing, at least one `evidenced` rather
   than stated, at least one interviewer submitted and leaning positive.
6. Everything else is Further Review Required.

Every reading returns `because[]` (the conditions that fired), `whatWouldChangeIt[]` (what is missing)
and `blockers[]` (essential gaps, in words, never folded into anything).

---

## Agreement and contradiction

Feedback is aggregated, never averaged into a verdict.

- **Per dimension:** the spread across interviewers, and the outlier — defined as one scorer two or
  more points from *every* other, which is a different thing from being the lowest.
- **Between kinds of evidence:** a hire recommendation over an essential requirement with nothing on
  record; a no-hire over requirements that are all evidenced; a passed assessment beside a low
  technical score, and the reverse.
- **Single observer** is stated in words wherever it is true and labelled `single_observer`, so
  nothing downstream reads one scorecard as consensus.

Nothing is resolved here. Surfacing a contradiction is the point; resolving it is the decision.

**Source weighting is a label, not a multiplier.** `demonstrated` / `stated` / `single_observer` /
`inferred` appear on screen next to the signal. Nothing multiplies by them silently.

---

## Rejection feedback

`screenCandidateFeedback()` runs three independent screens before anything is stored:

1. **Birth-derived terms** — refused outright, however the sentence is worded.
2. **Refused subjects and protected attributes** (`person-assertions.ts`) — "culture fit" is refused
   by name; it is a protected-attribute proxy generator.
3. **The HORIZON language guard** (`horizon/interpretation/language-guard.ts`) — methodology named in
   standard UI language, deterministic prediction, health or clinical statement, or a sentence that
   reads as the employment decision itself.

A `review`-level protected concern is **not** refused — "accessibility engineering" and "occupational
health and safety" are real role-relevant criteria, and a filter that silently refuses them only
teaches people to word around it. The concern is returned so the writer sees it.

Blank is allowed. A later sentence beats a wrong one.

---

## Authorization

| Act | Capability | Holders |
|---|---|---|
| Read the report | `applications.score` | super_admin, hr, recruiter, reviewer, department_head |
| Record the decision | `selection.decide` | super_admin, recruiter |

**No new capability was minted.** `selection.decide` already exists in `src/lib/auth/registry.ts`,
defined as recording a selection decision "with a written reason and the deciding person's own name
attached permanently", marked SENSITIVE. That is exactly this form. A reviewer or department head
therefore reads the report and cannot record the decision — reading the evidence and exercising the
authority are two acts.

The read gate runs **before** the report is built, because building it reads a named candidate's
evidence out of six modules.

---

## The funnel

This module never writes `applications.stage` or `applications.status`. It calls
`advanceStage()`, which owns the column, the history table, the candidate notification and the event
emission.

Default proposals when the form leaves the stage blank:

| Decision | Proposed stage | Why |
|---|---|---|
| Hire | `decision` | An offer made is not an offer signed. `hire-completion.ts` owns `onboarded`. |
| Reject | `decision_no` | |
| Hold | none | A hold is a decision to wait. Moving the tracker would tell the candidate something that did not happen. |
| Move to Next Stage | none | Only the hiring desk knows which stage is next; it is chosen on the form and validated by `application-stages.ts`. |

**Write order matters.** The decision row lands first, then the stage move is attempted. If the stage
move fails the decision still stands and the caller is told in words — a decision that was made and
not recorded is worse than a funnel that lags behind one.

---

## The record

`hiring_decisions` is append-only by convention and by its only writer. A later decision stamps the
previous row's `superseded_at` and inserts a new one. Nothing updates `decision`, `reasoning`,
`decided_by_user_id` or `decided_at`, and nothing deletes.

Each row freezes what the deciding person was looking at: `support_state`, `support_because`,
`evidence_refs` and a trimmed `report_snapshot`. The report is re-derivable; what a person saw is not.

**Tables checked before this one was written, and why none of them is this:**

- `hr_match_decisions` — a judgement about an advisory coverage view; moves no stage, decides nothing
- `match_evaluations` — a stored capability reading plus agreed/disagreed/set_aside
- `application_stage_events` — the funnel's actor history; records that a stage moved, not why
- `manual_interviews.final_decision` — one interview's outcome, per interview
- `tal_*` / `tos_*` — the two unreconciled recruitment stacks. **This patch builds on neither and
  reads from neither**, and is keyed on `applications.id`, so it survives whichever one wins.

---

## HORIZON integration

`src/lib/hiring-decision-horizon.ts` is the boundary, and it is deliberately late-bound.

`src/lib/horizon/report/registry.ts` declares a report `interview_decision_support` requiring the
capability key `applicant.selection`, gated on `applications.score` + `interviews.author`. **Patch 10
is the producer of that key.** `selectionCapabilityFor()` returns that payload, honouring `asOf` —
"the decision that stood in March" is answerable because the table is append-only.

Why the adapter is a separate file that imports HORIZON nowhere at the top:

- Nothing in the decision path imports it. A hiring desk records a decision today whether or not the
  HORIZON spine compiles. (At authoring time `horizon/schema.ts` had six parse errors and
  `report/providers/` was an empty directory with no registration function.)
- The HORIZON provider types are declared **structurally** rather than imported, so the file
  typechecks on its own.
- `registerWithHorizon()` is a dynamic import inside a try. A HORIZON that is not ready returns
  `{ registered: false, reason }` and nothing else in this patch notices.

Candidate feedback is **not** in the payload. It is written for one person by one desk; a wider
intelligence record should not carry a rejection sentence in front of readers it was never written
for.

---

## Deploying

1. Run `db/hiring-decision-schema.sql` yourself. It is `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` throughout — it creates nothing that exists and rewrites no row.
   The module also self-bootstraps on first use, so running the file is the way to create the table
   deliberately and out of the request path rather than the only way.
2. Open `/admin/applications/{id}/decision`. Until the table exists the page renders the full report
   and says, in the decision panel, that it is read-only and why.

## Known limits

- **No requirements recorded → no evidence-based role fit.** `job_requirements` /
  `hr_role_requirements` are authored by a human against the skill catalogue. A role with none gets a
  report whose fit panel says so; there is no fallback to `roles.skills` keyword strings, because a
  fallback is how a system designed to avoid the keyword trap walks into it.
- **The interview tables are not in this repository's DDL.** `interview_rounds` and
  `interview_scorecards` come from a hand-run migration. On a database without them the behavioural
  panel reports `absent` in words rather than empty.
- **No course-to-skill mapping exists**, so certificates and assessments are shown to a human as a
  platform record and nothing counts them toward a requirement.
- **The tal_/tos_ fork is untouched.** If a future patch reconciles them, this table needs no
  migration — only a new reader, if that stack wants one.
