# HORIZON PATCH 00 — Shared Architecture and Contracts

The foundation every other HORIZON patch builds on: canonical identifiers, the seven-layer data
separation, the standard `IntelligenceResult` / `Evidence` / `Signal` shapes, the fourteen event
contracts, the API response envelope, the field-visibility model, and the composition mechanism for
the Master Employee Intelligence Record.

It owns the **root files** of `src/lib/horizon/` listed below. Every subdirectory
(`interpretation/`, `temporal/`, `feedback/`, `governance/`, `behaviour/`, `intake/`, `integration/`,
`report/`) and every `signal-*.ts` belongs to another patch and is untouched by this one.

**It computes no score, renders no screen, and collects no feedback.**

Full reference: **[HORIZON_CONTRACTS.md](./HORIZON_CONTRACTS.md)**.

---

## What it guarantees, and where the guarantee lives in code

| Obligation | Mechanism | Test |
|---|---|---|
| No duplicate table for a concept another module owns | `ID_OWNERSHIP.horizonOwns`; `newHorizonId()` **throws** for a referenced kind | `refuses to mint an identifier it does not own` |
| An `employee_id` cannot be passed where an `applicant_id` is meant | branded identifier types; plain `string` still assigns in, so no casts are needed | compile-time; `isSubjectRef` rejects incoherent kind/scheme pairs |
| Fact, inference and decision never blur | seven `DATA_LAYERS` with an explicit `mayCite` table; every built object deep-frozen | `states citation rules explicitly`, `freezes constructed objects` |
| No automated score decides anything | `may_decide` exists on one layer; `HumanDecision.decidedBy` must be `user`/`employee` | `refuses a decision attributed to the system or an engine` |
| Demonstrated evidence outweighs inference | `EVIDENCE_CLASS_WEIGHT` + `maxConfidenceFor()` confidence ceiling | `caps confidence by the strongest evidence class` |
| Traditional computation is never presented as established, never outweighs work, never reaches the subject | `ENGINE_CLASS_SPECS.traditional_computation` (status floor, advisory-only, always-review, interpretation-layer-only) | five dedicated tests |
| The forbidden vocabulary appears in no label | `FORBIDDEN_UI_TERMS` + `checkPublicCopy()` called by every validator | scan across every exported label in the module |
| No hidden surveillance | `COLLECTION_BASES` has no covert member and no free-text escape | `offers no covert one` |
| No per-person health data on any surface | `wellbeing_aggregate` is `prohibited`; no audience may see that class | `keeps individual wellbeing data out of every per-person view` |
| A read that cannot be logged is not served | `requireAccessLog()` + `logBeforeRender` per audience; `access_log_failed` → HTTP 503 | `refuses to render for a logged audience when the access log write failed` |
| A redacted field is never silently dropped | three states — present / `withheld` / `omitted`, the last recorded in the access log | redaction tests |
| A new unclassified field is hidden, not exposed | `redactForAudience()` defaults to `restricted` | `fails closed on a field nobody classified` |
| A signal cannot become a permanent mark | `expires_at TIMESTAMPTZ NOT NULL`, validated to be after `generatedAt` | signal validator + schema-mirror tests |
| An unreadable section never reads as "this person has nothing" | per-provider isolation; failure becomes a section carrying the reason | `keeps a failing provider as an UNREADABLE section` |
| HORIZON never publishes into another module's mailbox | every topic prefixed `horizon.` | `never publishes onto a topic another module already owns` |
| A committed fact is never rolled back by a failed outbox write | `emitHorizonEvent()` returns a tracked gap, never throws | `returns a tracked gap rather than throwing` |
| The hand-run SQL and the bootstrap cannot drift | `db/horizon-schema.sql` generated from the same DDL string | `schema-mirror.test.ts` |

---

## Files

**Created — owned by this patch**

- `src/lib/horizon/ids.ts` — the eleven canonical identifiers, branded; `ID_OWNERSHIP`;
  `SubjectRef`/`ActorRef`; `SubjectResolver` and `OrganisationResolver` boundaries.
- `src/lib/horizon/types.ts` — the seven layers, engine classes, evidence classes, collection bases,
  dimension families, `IntelligenceResult`, `Evidence`, `Signal`, `HumanDecision`, feedback
  aggregation shapes, the language policy, and every validator.
- `src/lib/horizon/events.ts` — the fourteen event contracts, the envelope, the outbox sink
  interface, `postgresEventSink` / `memoryEventSink`, drain, subscribe, `UPSTREAM_BINDINGS`.
- `src/lib/horizon/api.ts` — `ApiResponse`, `ResponseMeta`, error codes and HTTP mapping,
  withheld/omitted vocabulary, cursor pagination.
- `src/lib/horizon/visibility.ts` — visibility classes, audiences, field classification,
  `redactForAudience()`, `authoriseAccess()`, `AccessLogger` / `requireAccessLog()`.
- `src/lib/horizon/record.ts` — the MEIR: `ProfileHeader`, `MeirProvider`, the provider registry,
  `composeRecord()`, `planRecord()`.
- `src/lib/horizon/schema.ts` — the nine `hzn_*` tables in one batched bootstrap;
  `verifyHorizonSchema()`.
- `src/lib/horizon/pg.ts` — `rowsOf` / `reasonOf` / `truncateReason`.
- `src/lib/horizon/index.ts` — the barrel every other patch imports from.
- `src/lib/horizon/contracts.test.ts` — 67 tests.
- `src/lib/horizon/events.test.ts` — 20 tests.
- `src/lib/horizon/record.test.ts` — 13 tests.
- `src/lib/horizon/schema-mirror.test.ts` — 7 tests.
- `db/horizon-schema.sql` — the readable mirror, generated from `schema.ts`.
- `docs/horizon/HORIZON_CONTRACTS.md` — the reference.

**Not touched**

Nothing outside the list above. No existing module was modified: not `src/lib/events.ts`, not
`src/lib/talent/*`, not `src/lib/db/schema.ts`, not `db/hr-schema.sql`, and not
`src/lib/horizon/access.ts` (see the note below).

---

## One collision, recorded rather than buried

`src/lib/horizon/access.ts` was written concurrently by the profile-console patch while this patch
was writing a module of the same name. The two are different concerns — theirs decides **which
section of a screen a viewer may open**, mine decides **which fields of the standard output survive
the query** — so this patch's module was renamed to `visibility.ts` and their file was left exactly
as it stands. The barrel deliberately does **not** re-export `./access`: it is theirs, and screens
import it directly.

If you are reading this because you are about to write a file in `src/lib/horizon/`: **run `ls` on
the directory first.** Several agents are building here at once and files appear mid-session.

---

## Integration instructions for the next patch

1. `import { … } from '@/lib/horizon'` — never from an individual file.
2. Call `ensureHorizonSchema()` at your service entry point if you touch an `hzn_*` table.
3. To contribute to a person's record, `registerProvider({ patchId, dimensions, read })`. Read your
   own tables. Return validated `IntelligenceResult[]`.
4. To publish, `emitHorizonEvent({ type, payload, subject, actor })`. To consume,
   `onHorizonEvent(type, 'your-patch:handler', fn)` — and **be idempotent**, keyed on `eventId`.
5. To serve a record, in this order: `authoriseAccess()` → `requireAccessLog()` → read →
   `redactForAudience()` → `apiOk(data, meta)` with `accessLogged: true`.
6. Never mint an identifier for a kind `ID_OWNERSHIP` says HORIZON does not own.
7. Extend the contract additively; see HORIZON_CONTRACTS.md §10.

---

## Known limitations

- **`SubjectResolver` and `OrganisationResolver` are declared, not implemented.** Resolving a
  signed-in user to an employee subject needs the org graph and the talent tables, both owned
  elsewhere. Until the identity patch supplies an implementation, callers pass a `SubjectRef` in.
- **No organisation registry exists in this repository.** Every `hzn_*` row carries
  `organisation_id TEXT` defaulting to `org_edurankai`, ready for the day one lands.
- **`applicant_id` is genuinely ambiguous** where the talent stack is not deployed;
  `SubjectRef.idScheme` records which anchor was used rather than resolving the ambiguity.
- **`redactForAudience()` is shallow.** Nested objects are classified whole. A half-implemented deep
  redaction that looks thorough would be more dangerous than a shallow one that says so.
- **`FeedbackAggregator` is a shape, not an implementation.** The arithmetic — outliers, bias
  detection, source weighting — belongs to the feedback patch.
- **The schema has not been applied to any database by this patch.** Nothing here connects to
  production; hand `db/horizon-schema.sql` to the operator.
- **The postgres event sink has no test coverage**, by choice: exercising it would require a
  connection. Its contract is covered through `memoryEventSink()`.
