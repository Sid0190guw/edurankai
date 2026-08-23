# Interview Intelligence — Patch 09

The interviewer-facing layer: what somebody is told **before** an interview, what they record
**during** it, and what they sign **at the end**. Plus the comparison between the two, and the rule
that decides which side governs.

Module: `src/lib/interview-intelligence.ts`
Surface: `/admin/interviews/[id]/intelligence`
Tests: `src/lib/interview-intelligence.test.ts` (47, all pure functions, no database)

---

## What this patch does not own

Read this first. This module was written into a tree several agents write to, and most of the
interview surface already existed.

| Thing | Owned by | This patch |
|---|---|---|
| `interview_rounds` | a hand-run migration; `/api/interviews/schedule.ts`, `/admin/interviews` | reads only |
| `interview_scorecards` (four 1-5 ratings, four-value recommendation) | `/admin/interviews/[id]/scorecard.astro` | reads only, on earlier rounds |
| `interview_rounds.final_recommendation` | derived as the panel majority by the scorecard page | **never written** |
| `interview_panel_assignments` | `src/lib/interview-feedback.ts` | not touched |
| `interview_panel_scores` / `manual_interviews` | the manual-interview module, a different id space | not touched |
| `hr_role_requirements`, the coverage view | `src/lib/capability-coverage.ts` | consumed through its exported API |
| `capability_claims`, `capability_evidence`, `EVIDENCE_KINDS` | `src/lib/evidence-graph.ts` | **never written** — see the handoff below |
| identity resolution | `src/lib/person-spine.ts`, via `subjectFor()` | consumed, never re-implemented |

No table was re-declared from memory. `interview_rounds` and `interview_scorecards` have their DDL
in migrations this repository does not carry, and a `CREATE TABLE IF NOT EXISTS` written from memory
would be a second shape for an existing table.

---

## Tables this patch owns

All three are prefixed `interview_intel_` so ownership is legible from the name.

### `interview_intel_snapshots`
The pre-interview picture, **frozen**. One row per lock; history is kept, the latest is used.

A candidate profile is dynamic by design — evidence is added and verified continuously — so "did
what I observed match the system's picture" is unanswerable unless the picture is pinned at a moment.
This is that pin. It stores the requirement list, each requirement's coverage state and recorded
level, and the sentence explaining how the person's records were reached. Nothing else: no name, no
contact detail, no free text from the application, and **none of the three birth columns**.

### `interview_intel_observations`
What was observed in the room. Many rows per interviewer, each optionally naming one requirement.

Columns: `dimension`, `requirement_skill_id`, `outcome`, `observation`, `interviewer_user_id`.

### `interview_intel_assessments`
The completion record. One per `(interview_id, interviewer_user_id)`, upserted.

Columns: `recommendation`, `supporting_evidence`, `written_feedback`, `conditions`, `alignment`,
`alignment_note`, `snapshot_id`.

`interview_id` is deliberately **not** a foreign key to `interview_rounds`: that table may be absent
on a given database, and a `REFERENCES` clause against a missing table fails the whole bootstrap.
The relationship is enforced by the readers.

---

## The two recommendation scales, and why they are two

| | `interview_scorecards.recommendation` | `interview_intel_assessments.recommendation` |
|---|---|---|
| values | `strong_hire`, `hire`, `no_hire`, `strong_no_hire` | `strongly_recommend`, `recommend`, `recommend_with_conditions`, `further_assessment_required`, `do_not_recommend` |
| written by | the scorecard page | this console |
| question | how did the panel rate them | what does this interviewer, having compared the room against the record, recommend happens next |

**Neither is computed from the other, and neither accepts the other's values** — `isIntelRecommendation('no_hire')` is `false`, and there is a test for it. Two of the five
(`recommend_with_conditions`, `further_assessment_required`) have no expressible equivalent on the
four-value scale, which is how a hiring process ends up with a binary nobody chose.

**None of the five is a decision.** `do_not_recommend` rejects nobody. Nothing in this module writes
`applications.status`, `interview_rounds.status`, or `interview_rounds.final_recommendation`.

---

## Predicted versus actual, and what "override" means

`reconcileRequirement()` is pure. Per requirement it holds two things apart:

- **Predicted** — the coverage state at lock time. Records: an application form, a certificate, a
  passed assessment, a manager's statement. None of it is an observation of this person answering a
  question.
- **Actual** — what a named interviewer wrote down in the room.

Where they disagree, **the observation governs**:

| predicted | observed | state | overrides |
|---|---|---|---|
| nothing / stated / related | supports | `demonstrated_in_interview` | **yes** |
| evidenced | supports | `demonstrated_in_interview` | no (they agree) |
| evidenced / stated / related | contradicts | `contradicted_in_interview` | **yes** |
| nothing | contradicts | `contradicted_in_interview` | no (they agree) |
| unreadable | anything | as observed | no |
| anything | both, from two interviewers | `interviewers_disagree` | no |
| anything | nothing recorded | `not_examined` | no |

Two rules worth stating out loud:

- **`unreadable` is not a prediction.** A record that could not be read cannot be disagreed with, so
  nothing supersedes it. Crediting the room with defeating an outage would credit this system with a
  wrong answer it never gave.
- **A disagreement between two interviewers is not an override.** It supersedes nothing, it is
  unresolved, and it is counted separately (`disagreementCount`). Silently preferring the later row,
  or the more senior interviewer, would be this system deciding a disagreement between two humans by
  itself.

**Only `competency` and `technical` observations can supersede a prediction.** The other six
dimensions are recorded, shown beside the requirement and do not move it: observing that somebody
explains themselves well is not observing that they hold the capability.

**An override changes this screen and nothing else.** It does not write `capability_claims`.

---

## Suggested probes

Derived from **one fact** — this requirement is at this coverage state — by a fixed rule per state.
The same record always produces the same probe. No language model is involved, and there is a
determinism test.

| state | essential | important | helpful |
|---|---|---|---|
| nothing / stated / related | must validate | worth probing | confirm briefly |
| evidenced, below `min_level` | must validate | worth probing | confirm briefly |
| evidenced, at or above | confirm briefly | confirm briefly | confirm briefly |
| unreadable | must validate | worth probing | worth probing |

Each probe carries `why` (the gap) and `prompt` (what to ask). The `unreadable` probe says in as many
words that the record could not be read and that this is **not a gap in the person**.

---

## Contradictions

`findContradictions()` is pure, and each of the four kinds is a **comparison of two stored rows**.

1. `recorded_level_below_requirement` — a recorded level and a required minimum, and the first is smaller.
2. `earlier_round_recommended_against` — an earlier round of this application holds a scorecard that recommended against proceeding.
3. `panel_split_on_an_earlier_round` — two scorecards on one earlier round point opposite ways.
4. `earlier_observation_contradicts` — an interviewer already recorded a contradicting observation against a requirement the record still presents as held.

**"Nothing on record" is never a contradiction.** It is a gap in our records, it appears under areas
requiring validation, and there is a test asserting it produces no contradiction.

**The obvious fifth kind is absent on purpose.** "Claims one framework, failed an assessment in the
language underneath it" requires deciding two free-text titles name the same subject. That is keyword
matching wearing the word "contradiction". Platform assessment records are shown verbatim instead,
attached to nothing, for a human to read.

---

## Explainability

Every derived structure carries a `Provenance`:
`inputs -> processing -> output -> evidence -> confidence -> timestamp`.

`confidence` is **a sentence, not a number**, everywhere. A number beside a statement about a person
reads as a measurement; nothing here is measured. Every derived line is a comparison of stored rows,
and the honest confidence statement says exactly that.

---

## Access

Gated by the `interviews` section, which `src/middleware.ts` already maps for every path beneath
`/admin/interviews`. **No new capability is invented.** View opens the console; the four write
actions require `edit`, on the same reasoning the scorecard page documents.

A candidate never sees any of it. No function is called from an applicant-facing surface.

**No birth field is ever read.** `applications` carries `dob`, `birth_time` and `birth_place`. No
query in the module selects any of them, no type has a place to put them, and the brief cannot render
them. What a candidate demonstrates outranks what anything infers about them, so the inferring layer
is not on this screen at all.

---

## Handoff: what the capability-graph owner needs to do

An interview produces the strongest evidence this system collects: a named human watching another
human do the thing, and writing down what they saw. It belongs in the capability graph. **This patch
does not write it there**, because `EVIDENCE_KINDS` in `src/lib/evidence-graph.ts` is that module's
owned vocabulary and has no interview-shaped kind. Inventing a kind string from outside would attach
evidence that module cannot classify, cap or explain.

So this patch exposes the rows, shaped and ready:

```ts
exportableEvidence(interviewId): Promise<{ present, items: ExportableEvidence[], note }>
```

To consume it, add one kind to `EVIDENCE_KINDS` — suggested shape:

```ts
{ kind: 'interview_observation',
  label: 'Observed in an interview',
  supports: 'demonstrated',   // NOT professionally_demonstrated: an interview is an account of
                              // work, not the work, and the named human vouches for what they
                              // heard rather than for the work itself
  needs: 'human_verdict' }    // which the observation already is: attributed, written, dated
```

then per row call `attachEvidence()` with `kind: 'interview_observation'`, `ownerModule:
'interview-intelligence'`, `sourceTable: 'interview_intel_observations'`, `sourceId` the observation
id, `locator` the round, and `recordVerification()` with the `verdict` and `reason` as given.

`toGraphVerdict()` is the single declared mapping between this module's wording
(`supports | contradicts | inconclusive`) and the graph's (`supports | does_not_support |
insufficient`).

**Nothing is exported for an `inconclusive` outcome or a non-evidential dimension.** An impression of
somebody's communication is a real record and is not evidence that they hold a capability; sending it
as evidence would put it on a ladder it does not belong on.

---

## Known limitations

- **The coverage view has no other surface.** `src/lib/capability-coverage.ts` was, before this
  patch, called by no page. This console is the first thing to render it, so its behaviour against
  real data has not been observed anywhere else.
- **Requirements must be mapped to the skill catalogue for the predicted side to exist.** On a job
  where nobody has done that, the console says so in those words, the interview still runs, and
  everything observed is still recorded — but there is nothing to compare it against.
- **`interview_rounds` and `interview_scorecards` may be absent** on a given database. Every reader
  reports `present: false` rather than an empty list.
- **Nothing has been run against a database.** The 47 tests cover the pure functions — probes,
  contradictions, reconciliation, vocabularies. The SQL paths are typed and reviewed, not executed.
- **`exportableEvidence()` has no consumer** until the capability graph adds the kind above.
