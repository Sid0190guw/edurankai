# HORIZON — Shared Architecture and Contracts

**Owner:** the shared-contracts patch. **Module:** `src/lib/horizon/` (root files only — see §10).
**Import from:** `@/lib/horizon`, never from an individual file.

This is the foundation the other HORIZON patches build on. It defines identifiers, the data
separation, the standard output shapes, the event contracts, the API envelope, the visibility model,
and the composition mechanism for the Master Employee Intelligence Record.

It computes no score, renders no screen, and collects no feedback. Every one of those belongs to
another patch, and this document says which.

---

## 0. The five rules that decide every argument

1. **One record, many views.** A view is a function of the record and the audience, computed in one
   place (`visibility.ts`). A screen renders what it is given.
2. **Seven layers, never blurred.** Raw, computed, observed, human feedback, AI interpretation,
   recommendation, human decision. Only the last one changes anybody's status.
3. **Every output carries its evidence and its confidence, or says it could not be computed.** An
   empty result rendered as a zero is a lie about a person.
4. **Demonstrated evidence outweighs inference.** Enforced as a confidence ceiling, not as a policy.
5. **HORIZON owns almost no data.** Six identifiers, nine tables. Everything else is a reference to
   a row another module already owns.

---

## 1. The Master Employee Intelligence Record (MEIR)

**It is a composition, not a table.**

`hzn_profile` is a header: one row per (organisation, subject), holding an identity anchor and when
the record was last recomputed. It holds nothing about the person.

The content is assembled at read time from **providers**. A provider is registered by the patch that
owns a domain, declares which dimensions it contributes, and returns `IntelligenceResult[]` from its
own tables under its own access rules.

```ts
import { registerProvider, composeRecord } from '@/lib/horizon';

const unregister = registerProvider({
  patchId: 'horizon-capability',
  label: 'Capability',
  dimensions: [{ family: 'capability', key: 'delivery_depth', label: 'Delivery depth' }],
  historicalSupport: true,
  async read(ctx) { /* your tables, your access rules */ return results; },
  async readSignals(ctx) { return signals; },        // optional
});

const record = await composeRecord(subject, { requestId, asOf: null });
```

**Why not one big table.** It would duplicate data that already has an owner (a third place holding
a person's skill level, after `hr_employee_skills` and the evidence graph); it would put eight
patches in one merge conflict; and it would destroy the layer separation, because once "hours worked"
and "the system thinks this person is disengaged" are two columns of one row, nothing in the storage
tells them apart.

**Failure isolation is the point.** Each provider runs isolated with a `PROVIDER_TIMEOUT_MS` bound.
A failure becomes a **section marked unreadable with the reason attached** — never an absent section,
because an absent section reads as "this person has nothing here", which is a statement about a human
being made by a failed query. `composeRecord()` never throws.

**Time-based intelligence.** `ctx.asOf` composes the record as it stood at a moment. A provider that
cannot answer historically declares `historicalSupport: false`, and its section comes back flagged
`asOfUnsupported` rather than quietly returning today's answer with an old date on it.

**Planning without reading.** `planRecord(subject)` reports which dimensions any provider offers and
which families nothing serves. A dimension nobody serves is a gap in the system, surfaced as such,
rather than a heading with nothing under it.

---

## 2. Canonical identifiers

Eleven identifiers. **HORIZON issues six.** The rest already exist and are stored as references.

| id | HORIZON owns | Owning table | Note |
|---|---|---|---|
| `employee_id` | no | `hr_employees.id` | **not** `user_id`, **not** `users.id` |
| `applicant_id` | no | `tal_person.id` \| `applications.id` | a person, not an application — see below |
| `organisation_id` | no | *(no table exists)* | TEXT, defaults to `DEFAULT_ORGANISATION_ID` |
| `profile_id` | **yes** | `hzn_profile` | the MEIR header |
| `role_id` | no | `roles.id` \| `org_positions.id` | `roles` conflates ad and position |
| `feedback_id` | no | interview scorecards / `hr_performance_reviews` | HORIZON stores no feedback body |
| `evidence_id` | **yes** | `hzn_evidence` | not a fork of `capability_evidence` |
| `signal_id` | **yes** | `hzn_signal` | |
| `assessment_id` | no | assessment tables | referenced from evidence and events only |
| `report_id` | **yes** | `hzn_report` | header only; rendering belongs elsewhere |
| `computation_id` | **yes** | `hzn_computation` | one row per engine run |

Plus two the brief's list implies: `event_id` (`hzn_event`) and `result_id`
(`hzn_intelligence_result`).

`ID_OWNERSHIP` in `ids.ts` is the machine-readable version. **Read it before creating a table.** If
`horizonOwns` is false, the row you want already exists and you want a reference, not a copy.

**Identifiers are branded types.** `EmployeeId` will not compile into a slot that wants
`ApplicantId`. A plain `string` still assigns into a branded type, so reading an id out of a query
result needs no casts — the brand only blocks the direction the mistakes actually run.

`newHorizonId(kind)` **throws** for a kind HORIZON does not own. Minting an `employee` id would
create a second employee identity out of thin air.

### Subjects

Everything points at a `SubjectRef`:

```ts
{ kind: 'employee' | 'applicant', id, idScheme, organisationId }
```

`idScheme` is not decoration. An applicant may be anchored on `tal_person.id` where the talent stack
runs and on `applications.id` where it does not. A reader that guesses joins the wrong table and gets
an empty result that looks like an innocent person with no history. Incoherent pairs (an employee
anchored on `application`) are refused by `isSubjectRef()`.

Resolving a signed-in user to a subject requires the org graph and the talent tables, both owned
elsewhere. `SubjectResolver` is the declared boundary; the identity patch implements it.

---

## 3. The canonical data separation

```
RAW → COMPUTED → OBSERVED → HUMAN FEEDBACK → AI INTERPRETATION → RECOMMENDATION → HUMAN DECISION
```

| Layer | Decision use | Consequential | Named human |
|---|---|---|---|
| `raw` | supporting_only | no | no |
| `computed` | supporting_only | no | no |
| `observed` | supporting_only | no | no |
| `human_feedback` | supporting_only | no | **yes** |
| `ai_interpretation` | advisory_only | no | no |
| `recommendation` | advisory_only | no | no |
| `human_decision` | **may_decide** | **yes** | **yes** |

The order is the brief's. The **rule** is not an index comparison — `computed` legitimately draws on
`observed` even though `observed` comes after it in the list — so `DATA_LAYER_SPECS[l].mayCite`
states it per layer and validation enforces the statement.

Two properties are structural:

- **No layer may be rewritten as an earlier one.** There is no `promote()`, no `setLayer()`, and
  every constructed object is deep-frozen. `result.layer = 'raw'` throws.
- **Only `human_decision` is consequential.** `ENGINE_WRITABLE_LAYERS` is
  `['computed', 'ai_interpretation', 'recommendation']`, and `validateIntelligenceResult()` refuses
  anything else.

Relationship to `src/lib/provenance.ts`: that module owns the seven-word vocabulary for *how a value
came to be known* (factual, explicitly_provided, inferred, calculated, verified, predicted,
recommended). These seven layers are *what kind of statement it is*. They are complementary and
neither redeclares the other.

---

## 4. Shared types

`import type { … } from '@/lib/horizon'`. The full list is in `types.ts`; the load-bearing ones:

`DataLayer` · `DecisionUse` · `EngineClass` · `ScientificStatus` · `EngineVersion` ·
`EvidenceClass` · `CollectionBasis` · `EvidenceSourceType` · `Graded` · `RawReference` · `Evidence` ·
`DimensionFamily` · `DimensionRef` · `Confidence` · `ScoreOrLevel` · `ResultStatus` ·
`HumanReviewStatus` · `ValidityWindow` · `SourceContribution` · `IntelligenceResult` ·
`SignalCategory` · `SignalSeverity` · `SignalStatus` · `RecommendedAction` · `Signal` ·
`DecisionKind` · `HumanDecision` · `FeedbackContribution` · `FeedbackAggregate` · `FeedbackAggregator`

**Extend additively.** A second definition of `Confidence` somewhere else is how two screens end up
disagreeing about what "high" means for the same person.

### Engine classes and what their output may claim

| class | max scientific status | max decision use | always human review | interpretation-layer only |
|---|---|---|---|---|
| `deterministic` | platform_record | supporting_only | no | no |
| `statistical` | established_method | supporting_only | no | no |
| `model_inference` | exploratory | advisory_only | no | no |
| `traditional_computation` | **not_scientifically_established** | advisory_only | **yes** | **yes** |
| `human_curated` | platform_record | supporting_only | no | no |

The `traditional_computation` row is rules 20–22 expressed as data. A result from that class that
claims established standing, or supporting weight, or skips human review, **fails validation**. It is
`restricted` from every operational audience by `effectiveVisibility()`, and because its evidence is
`non_evidential` its confidence cannot exceed `low`.

### Language policy (rule 19)

`FORBIDDEN_UI_TERMS` + `checkPublicCopy(text)`. The validators call it on every summary, title,
explanation and action label, and `contracts.test.ts` scans every exported label in the module. The
neutral name for that dimension family is **`temporal_pattern` — "Temporal profile"**.

---

## 5. Event contracts

**Canonical names are the brief's. Topics are namespaced.**

```
envelope.type  = 'application.submitted'
bus topic      = 'horizon.application.submitted'
```

**Why.** Three of the fourteen names already exist in this repository with different payload shapes:
`application.submitted` (`src/lib/events.ts`, plus a live automation trigger key in
`mail-product/automations.ts` and `mailplatform/triggers.ts`), `assessment.completed` and
`interview.completed` (`src/lib/talent/events.ts`). Publishing a HORIZON envelope under one of those
names would hand a different shape to subscribers that already exist, silently.

The fourteen: `application.submitted` · `employee.created` · `task.assigned` · `task.submitted` ·
`task.updated` · `feedback.submitted` · `feedback.updated` · `assessment.completed` ·
`interview.completed` · `profile.recompute_requested` ·
`intelligence.computation_completed` · `signal.created` · `signal.resolved` · `access.logged`

### The envelope

```ts
{ eventId, type, version, occurredAt, organisationId, subject, actor,
  correlationId, causationId, payload }
```

`causationId` is the eventId of whatever caused this one — a recompute caused by a feedback
submission caused by an interview completing is three rows walkable backwards months later.
`correlationId` groups everything from one user action.

**Payloads are identifiers and small facts.** No names, no free text about a person, no scores. A
subscriber that needs the substance reads it from the owning module under that module's access rules.
`MAX_PAYLOAD_CHARS` is 8000 and is enforced.

### Delivery

Transactional outbox (`hzn_event`), because on this platform the function can be frozen the instant
the response is written. **At-least-once: subscribers must be idempotent**, and `eventId` is the dedup
key (it also travels as the bus `correlationId`).

```ts
await emitHorizonEvent({ type, payload, subject, actor });   // records; never throws
await drainHorizonEvents();                                  // claims → bus → marks delivered
onHorizonEvent(HORIZON_EVENTS.SIGNAL_CREATED, 'my-patch:handler', async (env) => { … });
```

`emitHorizonEvent` returns `{ ok, eventId, recorded, errors }`. A failed outbox write is a **tracked,
visible delivery gap**, not a rolled-back hire. The sink is an interface (`HorizonEventSink`);
`postgresEventSink` is the default, `memoryEventSink()` is for tests.

An event is marked delivered even when one subscriber threw — the failure is attributed in
`last_error` and in `recentEventFailures()`. Re-running the whole event would re-run every healthy
handler too.

### Binding existing platform events

`UPSTREAM_BINDINGS` maps existing topics to HORIZON events and records honestly whether anything
publishes them today (`published_today` vs `declared_only`). `bindUpstreamEvents(adapters)` wires
them — **opt-in, from an integration entry point, never as an import side effect**. An adapter may
return `null` to decline (`identity.created` fires for interns and fellows too).

---

## 6. API response contract

```ts
type ApiResponse<T> =
  | { ok: true;  data: T;      meta: ResponseMeta }
  | { ok: false; error: ApiError; meta: ResponseMeta }
```

`ok: false` is a typed outcome, not an exception that leaked. `ok: true` with an empty array means the
empty array **is** the answer — the distinction a route that returns `[]` on a thrown query destroys.

`ResponseMeta` carries `requestId`, `generatedAt`, `contractVersion`, `organisationId`, `audience`,
`subject`, `withheld[]`, `accessLogged`, `degraded[]`.

**`accessLogged` defaults to `false`.** A caller that forgot to log has not logged, and the response
says so rather than claiming a control that did not run.

**Three states, not two.** A field can be present, **withheld** (the reader may know it exists;
reported in `meta.withheld`), or **omitted** (its existence is itself restricted; absent and not
announced — but recorded in the access log, because invisible to the reader is not invisible to the
auditor).

`httpStatusFor(code)`: `access_log_failed` → **503**, not 500. The read was refused because the system
could not record that it happened; the request is valid and a retry is right.

`apiErrFromException(e, meta)` returns `{ response, logReason }` — the real Postgres reason (on
`e.cause`) goes to your log, never to the client.

Pagination is cursor-based with one row of overfetch (`pageFrom`). There is deliberately **no total
count**: `COUNT(*) OVER ()` beside a LIMIT is already a recorded index-defeating pattern here.

---

## 7. The standard intelligence output

```ts
IntelligenceResult {
  id, subject, dimension, scoreOrLevel, confidence, status, summary,
  evidence[], sourceBreakdown[], computedAt, validFor, modelOrEngineVersion,
  humanReviewStatus,
  layer, decisionUse, scientificStatus, organisationId, profileId?, supersedes?, unreadable?
}
```

Rule 12 — INPUTS → PROCESSING → OUTPUT → EVIDENCE → CONFIDENCE → TIMESTAMP — has a home for each
arrow: `sourceBreakdown` + the `hzn_computation` row, `modelOrEngineVersion`, `scoreOrLevel` +
`summary`, `evidence`, `confidence`, `computedAt`.

`ScoreOrLevel` is a discriminated union and **`not_computed` is a first-class member** with a required
reason. Results are **superseded, never updated in place** — "what did this say in March" is exactly
the question an appeal asks. `validFor.staleAt` is required: a result with no shelf life becomes a
permanent label.

`validateIntelligenceResult()` refuses:

- `decisionUse: 'may_decide'` (rule 14)
- a non-engine-writable or consequential `layer`
- a missing `computationId`
- an empty `sourceBreakdown` on a computed result, or weights that do not sum to 1 (rule 23)
- a confidence band above the ceiling for its strongest evidence class (rule 22 —
  `inferred` → `moderate`, `non_evidential` → `low`)
- an engine class claiming more standing than `ENGINE_CLASS_SPECS` allows (rules 20/21)
- copy containing forbidden vocabulary (rule 19)

Use `buildIntelligenceResult()` to get a validated, deep-frozen object or a list of errors.

---

## 8. Evidence

```ts
Evidence {
  id, sourceType, sourceId, timestamp, relevance, reliability, summary, rawReference,
  evidenceClass, layer, collectedUnder, organisationId, unreadable?
}
```

`relevance` and `reliability` are separate and often opposite; both are `Graded { value, band, basis }`
and the basis is required — an ungrounded grade is a guess.

`rawReference { ownerModule, table, recordId, locator?, documentUrl? }` must be present: a chain that
ends nowhere is decoration. `documentUrl` is a **link** — this project never stores an uploaded
document.

`collectedUnder` has **no member meaning "covertly"** (rule 26): `organisational_record`,
`authorised_integration`, `consented_disclosure`, `voluntary_submission`. That is the whole guarantee.

**Relationship to `src/lib/evidence-graph.ts`:** that module answers *why does the system believe this
person has this **skill***, in `capability_evidence`. `hzn_evidence` answers *what did this
intelligence output rest on*, and one of the things it may rest on is a `capability_evidence` row,
cited by reference (`sourceType: 'capability_evidence'`). **No copy is made.**
`EVIDENCE_CLASS_FROM_GRAPH_LEVEL` is the single point where the two vocabularies meet.

---

## 9. Signals

```ts
Signal {
  id, subject, category, severity, title, explanation, evidenceIds[], sourceTypes[],
  confidence, generatedAt, expiresAt, status, recommendedActions[], humanReviewRequired,
  layer, decisionUse, organisationId, computationId?
}
```

`validateSignal()` refuses:

- a missing or non-future `expiresAt` — **a signal that never expires is a permanent mark on a person**
- an empty `evidenceIds` or `sourceTypes` (rule 23)
- an empty `explanation` — an unexplained signal is an accusation
- `severity: 'high'` without `humanReviewRequired` (rule 15)
- a decision layer, or `decisionUse: 'may_decide'`

`RecommendedAction` has no executor and no handler. It is a sentence addressed to a named audience. A
one-click action is a human decision and belongs in `HumanDecision`.

### Feedback aggregation (rules 24–25)

HORIZON stores `FeedbackContribution` rows in `hzn_feedback_contribution` — the normalised value, the
contributor, the relationship, the raw value and its scale. **It stores no feedback body**; the words
stay in the module that collected them.

`contributor_id` is always recorded. **Anonymity is a rendering decision, not a storage one** — bias
detection over contributions with no contributor is impossible, and a system that cannot tell whether
one person filed nine of the eleven ratings has no business aggregating them.

`FeedbackAggregate` carries `outlierFeedbackIds`, `disagreement`, `byRelationship` and `caveats`.
`MIN_CONTRIBUTORS_FOR_AGGREGATE = 5`, matching `MIN_GROUP` in `src/lib/wellness.ts`. HORIZON defines
the shape; the **feedback patch computes it**.

---

## 10. Visibility, access, and integration boundaries

### Audiences and visibility classes

Classes: `open` → `internal` → `restricted` → `sensitive` → `prohibited`.

| audience | may see | purpose required | log before render | relationship-scoped |
|---|---|---|---|---|
| `self` | open, internal | no | no | no |
| `reporting_manager` | open, internal | no | **yes** | **yes** |
| `department_head` | open, internal | no | **yes** | **yes** |
| `reviewer_panel` | open | **yes** | **yes** | **yes** |
| `hr_operations` | open, internal | **yes** | **yes** | no |
| `hr_leadership` | open, internal, sensitive | **yes** | **yes** | no |
| `auditor` | open, internal, restricted | **yes** | **yes** | no |
| `system` | open, internal, restricted | no | no | no |

**No audience may see `prohibited`** — including the founder, including an auditor.
`wellbeing_aggregate` is `prohibited`: per-person health data reaches no admin surface, ever. That
matches the project rule in `CLAUDE.md` and the aggregate-only design of `src/lib/wellness.ts`.

A person sees their own **evidence** (rule 12/23 are worth nothing if the evidence is classified out
of the subject's view) but not `sourceBreakdown` or `modelOrEngineVersion` — the weights are exactly
what a person would optimise against, and exactly what an auditor must see.

`redactForAudience()` computes the view. **Unlisted fields fail closed at `restricted`.**
`effectiveVisibility()` applies the strictest of the field rule, the family rule and the engine-class
rule.

### Authorisation and the access log

`authoriseAccess(ctx)` decides whether the read may proceed — **not** which fields are visible.
`relationshipConfirmed` fails closed on `undefined`; `undefined` meaning "allow" is how an
authorisation check becomes decoration.

**HORIZON resolves no relationships.** Whether this manager manages this employee is a per-row
question for `src/lib/org-graph.ts` (Layer 1 of the permanent three-layer architecture). Pass the
answer in.

`requireAccessLog(logger, entry)` returns `{ mayRender, logged, error }`. For an audience marked
`logBeforeRender`, **a failed log refuses the response** — the same rule `src/lib/legal-hold.ts`
already enforces. For `self`, a logging hiccup does not block a person from their own record.

### Tables (all `hzn_*`)

`hzn_profile` · `hzn_computation` · `hzn_intelligence_result` · `hzn_evidence` · `hzn_signal` ·
`hzn_feedback_contribution` · `hzn_report` · `hzn_event` · `hzn_access_log`

`ensureHorizonSchema()` creates them in **one batched message**; `db/horizon-schema.sql` is the
readable mirror an operator runs by hand, generated from the same DDL string and checked against it by
`schema-mirror.test.ts`.

No foreign keys across a module boundary. No `::uuid` cast anywhere (`departments.id` is
`varchar(50)` while `db/hr-schema.sql` declares `department_id UUID` — they cannot both be right). No
`ALTER TABLE` in the batch: ALTER takes its lock before evaluating `IF NOT EXISTS` and holds it to
commit, which on a deploy is how a bootstrap becomes an empty connection pool. **A new column goes in
its own `ensureOnce`, outside the batch.**

`hzn_access_log` is separate from `audit_log` deliberately: different retention, different read
audience, and a rule `audit_log` does not carry — for most audiences the row must land *before*
anything renders.

### What this patch does NOT own

| Concern | Owner |
|---|---|
| Per-tab grants on the profile console | `src/lib/horizon/access.ts` (profile-console patch) |
| Foundational computation | `src/lib/horizon/temporal/`, `src/lib/horizon/intake/` |
| Professional interpretation | `src/lib/horizon/interpretation/` (patch 03) |
| Signal detection and weighting | `signal-*.ts`, `src/lib/horizon/behaviour/` |
| Feedback capture and aggregation arithmetic | `src/lib/horizon/feedback/` |
| Governance, consent, retention | `src/lib/horizon/governance/` |
| Reporting and report rendering | `src/lib/horizon/report/` |
| Role comparison | `role-compare.ts` |
| Employee/applicant/role/feedback/assessment rows | HR, talent, recruitment modules |
| Relationship resolution | `src/lib/org-graph.ts` |
| Skill claims and their evidence chain | `src/lib/evidence-graph.ts` |

### How to extend the contract without breaking anyone

- **Additive only.** Add a member to a union, a field to an interface, a row to a spec table. Never
  change the meaning of an existing one.
- **Never edit `ids.ts`, `types.ts`, `events.ts`, `api.ts`, `visibility.ts`, `record.ts` or
  `schema.ts` to remove or repurpose an export.** Other patches compile against them.
- **A new event** goes in `HORIZON_EVENTS` with a payload interface and an entry in
  `HorizonEventPayloads`. The envelope `version` does not bump for an addition.
- **A new table** is a new `ensureOnce`, not a line in the existing batch, and it goes in
  `HORIZON_TABLES` and the SQL mirror in the same commit.
- **A new dimension family** needs an entry in `DIMENSION_FAMILIES`, `DIMENSION_FAMILY_LABELS` and
  `FAMILY_VISIBILITY` — the last one is what stops it defaulting to visible.
- **A new field on `IntelligenceResult` or `Signal`** needs a class in `RESULT_FIELD_VISIBILITY` /
  `SIGNAL_FIELD_VISIBILITY`. `contracts.test.ts` fails if you forget; without a class it is hidden
  from everyone but an auditor, which is the right direction to fail in.

---

## 11. Where each rule is enforced

| Rule | Mechanism | Test |
|---|---|---|
| 11 — no duplicate tables | `ID_OWNERSHIP.horizonOwns`; `newHorizonId()` throws for referenced kinds | "refuses to mint an identifier it does not own" |
| 12 — explainable output | required `computationId`, `sourceBreakdown`, `evidence`, `confidence`, `computedAt` | result validator tests |
| 13 — layers kept apart | `DATA_LAYERS` + `mayCite` + deep freeze | "states citation rules explicitly" |
| 14 — no automated decision | `may_decide` on one layer only; `HumanDecision.decidedBy` must be a human | "refuses a decision attributed to the system" |
| 15 — human review | `alwaysHumanReview` per engine class; high-severity signals | traditional-computation + signal tests |
| 16 — RBAC | `AUDIENCE_SPECS`, `authoriseAccess()`, fail-closed relationships | access tests |
| 17 — purpose-limited, logged | `requiresPurpose`, `requireAccessLog()`, `hzn_access_log` | purpose + failed-log tests |
| 18 — no internal detail leakage | `restricted` classes, `omit` redaction, fail-closed default | redaction tests |
| 19 — terminology | `FORBIDDEN_UI_TERMS` + `checkPublicCopy()` in every validator | label scan across the module |
| 20/21 — traditional layer separated, never presented as fact | `ENGINE_CLASS_SPECS.traditional_computation` | five dedicated tests |
| 22 — demonstrated outweighs inferred | `EVIDENCE_CLASS_WEIGHT` + `maxConfidenceFor()` ceiling | confidence-ceiling tests |
| 23 — every signal names its sources | required `evidenceIds` + `sourceTypes`; weights sum to 1 | signal + breakdown tests |
| 24/25 — disagreement is data | `FeedbackContribution.relationship`, `FeedbackAggregate.disagreement/outliers` | shape only; arithmetic is the feedback patch |
| 26 — no hidden surveillance | `COLLECTION_BASES` has no covert member | "offers no covert one" |
| 27 — no diagnosis | `wellbeing_aggregate` is `prohibited` per person | "keeps individual wellbeing data out of every per-person view" |
| 28 — dynamic record | composition at read time; no stored copy to fall stale | record tests |

---

## 12. Test suites

| File | Tests | Covers |
|---|---|---|
| `contracts.test.ts` | 67 | identifiers, layers, results, evidence, signals, decisions, visibility, API, language |
| `events.test.ts` | 20 | vocabulary, topic collisions, envelope, outbox delivery, upstream bindings |
| `record.test.ts` | 13 | provider registry, composition, failure isolation, timeouts, planning |
| `schema-mirror.test.ts` | 7 | `schema.ts` and `db/horizon-schema.sql` agree; no FK / `::uuid` / `ALTER` |

All pure. None opens a database connection — deliberately, because this working directory holds live
credentials and a suite that connects is one edit away from reading production.

```
npx vitest run src/lib/horizon/contracts.test.ts src/lib/horizon/events.test.ts \
               src/lib/horizon/record.test.ts src/lib/horizon/schema-mirror.test.ts
```
