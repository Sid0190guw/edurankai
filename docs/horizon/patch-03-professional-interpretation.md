# HORIZON PATCH 03 — Professional Interpretation Layer

The translation layer between foundational computation (PATCH 02) and professional HR intelligence.
It takes structured foundational factors and emits **twelve neutral professional dimensions**, each
with a level, a confidence, its contributing factors, a neutral explanation, professional
implications, limitations and a timestamp.

It owns `src/lib/horizon/interpretation/` outright. Nothing outside that directory is this patch's
domain, and the only shared files it touches are two additive capability declarations.

---

## What it guarantees, and where the guarantee lives in code

| Obligation | Mechanism | Test |
|---|---|---|
| The underlying methodology is never named in interface language | `language-guard.ts`, methodology group, **not** negation-exempt — a denial still puts the word on the screen | catalogue scan + `guardText('… not based on a birth chart')` is refused |
| No deterministic predictions | prediction group in the guard; every catalogue phrase is conditional | assertion/denial pair tests |
| No health diagnoses | health group in the guard; `recovery_activation_pattern` carries an extra "this is not about health" limitation | catalogue scan |
| No employment decisions | decision group in the guard; `notForDecisions: true` on every dimension; `NOT_FOR_DECISIONS_NOTICE` on every result | catalogue scan + flag assertions |
| Demonstrated evidence outranks inference | `evidence.ts` precedence; a covered dimension is marked superseded, confidence halved, implications withheld | precedence tests |
| An inference can never look like a fact | `INFERRED_CONFIDENCE_CEILING = 0.45`; the `high` band is structurally unreachable | 25 unanimous max-confidence inputs still land below the ceiling |
| Explainability | `explainability` field per dimension: INPUTS → PROCESSING → OUTPUT → EVIDENCE → CONFIDENCE → TIMESTAMP | all six parts asserted non-empty |
| Traceability to PATCH 02 | `inputDigest` (sha256 prefix over the exact inputs) on every interpretation; `horizon_dimension_factors` holds factor ids, method and arithmetic | digest stability / change tests |
| Internal computation is capability-gated | `projectForViewer()` removes trace and explainability **from the object** | JSON of a non-trace projection contains no factor code, method or note |
| Access is accountable | every read writes an audit row with a stated purpose **before** returning; a failed write returns a refusal | — (DB path) |

---

## Files

**Created — owned by this patch**

- `src/lib/horizon/interpretation/contract.ts` — the PATCH 02 boundary: shapes, validation, provider
  slot, factor→dimension resolution, input digest. Computes no foundational factor.
- `src/lib/horizon/interpretation/dimensions.ts` — the twelve dimensions, closed list; levels,
  confidence bands, implications by level, per-dimension and universal limitations.
- `src/lib/horizon/interpretation/language-guard.ts` — four denylist groups, sentence-scoped
  negation awareness, whole-string substitution, self-check.
- `src/lib/horizon/interpretation/evidence.ts` — evidence-precedence interface and arithmetic.
- `src/lib/horizon/interpretation/engine.ts` — pure interpretation, viewer projection, self-check.
- `src/lib/horizon/interpretation/store.ts` — schema, persistence, audited reads, history, objections.
- `src/lib/horizon/interpretation/index.ts` — the public contract surface.
- `src/lib/horizon/interpretation/interpretation.test.ts` — 38 tests.
- `src/pages/api/admin/horizon/interpretation.ts` — GET (read/history), POST (compute/object).
- `src/pages/admin/horizon/interpretation.astro` — thin read surface.
- `docs/horizon/patch-03-professional-interpretation.md` — this file.

**Modified — additive only, backward compatible**

- `src/lib/auth/permissions.ts` — three keys appended to the `Permission` union and granted in
  `PERMS_BY_ROLE` (`super_admin`: all three; `hr`: view + compute). No existing grant changed.
- `src/lib/auth/registry.ts` — three `BUILTIN_PERMISSIONS` descriptions appended. No entry edited.

---

## Database

Three new tables, all owned by this patch, all self-bootstrapping through `ensureBatch`
(`horizon_interpretation_v1`), no `ALTER` and therefore no lock-contention hazard:

- `horizon_interpretations` — one row per run: subject, engine version, **state** (including
  refusals), input digest, source module/version, consent reference, counts, problems, timestamps.
- `horizon_dimension_results` — one row per dimension per run.
- `horizon_dimension_factors` — the trace: factor id, share, direction, method, mass, polarity.

No consent table (consent is a *reference* into whatever store owns it), no evidence table (the
evidence graph owns that), no access-log table (`audit_log` via `src/lib/audit.ts`).

Audit actions emitted: `horizon.interpretation.computed`, `.viewed`, `.trace_viewed`,
`.history_viewed`, `.objection`.

---

## Capabilities

| Key | Holders | What it admits |
|---|---|---|
| `horizon.interpretation.view` | super_admin, hr | the neutral dimensions |
| `horizon.interpretation.compute` | super_admin, hr | causing an interpretation to be produced |
| `horizon.interpretation.trace` | super_admin | the internal computation and the input trace |

All three are `sensitive: true`, so a custom-role grant fails unless the audit row naming the granter
can be written.

---

## Integration — for PATCH 02

```ts
import { registerFoundationalProvider } from '@/lib/horizon/interpretation';

registerFoundationalProvider('patch-02', async (subject) => {
  const factors = await myFoundationalComputation(subject);
  if (!factors) return { state: 'not_configured', reason: 'no input for this person' };
  return {
    state: 'ok',
    set: {
      subject,
      factors: factors.map((f) => ({
        id: f.id,                       // opaque; the ONLY field stored in the trace
        code: f.code,                   // never rendered
        weight: f.strength,             // 0..1
        polarity: f.direction,          // -1..1
        confidence: f.confidence,       // 0..1 — never raised by PATCH 03, only lowered
        method: f.method,
        methodVersion: f.methodVersion,
        contributesTo: [{ dimension: 'analytical_orientation', weight: 0.6 }],
      })),
      computedAt: new Date().toISOString(),
      sourceModule: 'patch-02',
      sourceVersion: '1.0.0',
      complete: true,
      consentRef: consentRecordId,      // REQUIRED — no reference, no interpretation
    },
  };
});
```

**PATCH 02 owns factor semantics.** A factor reaches a dimension only by declaring `contributesTo`,
or through a table registered once with `registerFactorMapping('patch-02', { … })`. A factor matching
neither contributes to nothing, is counted as unmapped, and the count is reported on every output.
PATCH 03 will not guess.

**Where to register.** Call it once at module load from PATCH 02's own entry point. The slot is
module-scope singleton state; a second registration replaces the first.

## Integration — for a consuming patch

```ts
const { result } = await interpretSubject({ kind: 'employee', id }, { actorUserId, persist: true });

const view = await latestInterpretation({ kind: 'employee', id }, {
  actorUserId,
  purpose: 'Development conversation preparation',   // required, audited
  caps: { view: can(user, 'horizon.interpretation.view'), trace: can(user, 'horizon.interpretation.trace') },
});
```

## Integration — for an evidence owner

```ts
registerEvidenceProvider('evidence-graph', async (subject) => ({
  state: 'ok',
  items: [{ dimension: 'communication_orientation', presence: 'demonstrated', sources: ['3 verified records'] }],
}));
```

`presence: 'demonstrated'` supersedes the indication for that dimension. Registering nothing means
every dimension says, in words, that it was never checked — which is not the same as saying nothing
was found.

---

## Tests

`npx vitest run src/lib/horizon/interpretation/interpretation.test.ts` — 38 tests, all passing.
Every test is pure; none needs a database.

The catalogue-neutrality test found three real leaks in the first draft of `dimensions.ts`
("certainty", "predictable", "unavoidable") and they were reworded rather than exempted.

---

## Known limitations

1. **No PATCH 02 in the tree.** Nothing is connected, so on a live database every subject reports
   `not_configured` until a provider is registered. That is the designed behaviour, not a gap to
   paper over.
2. **No evidence adapter is registered.** `evidence.ts` defines the interface and the precedence
   arithmetic; the adapter that answers it from `src/lib/evidence-graph.ts` is a small, separate
   piece of work and is deliberately not written here — mapping capability claims onto professional
   dimensions is a semantic decision that needs a named owner.
3. **The DB paths are unexercised.** `store.ts` has not been run against Postgres; per this project's
   rules no database was contacted. The DDL follows the house `ensureBatch` pattern and the reads
   normalise postgres-js arrays, but "written correctly" is not "observed working".
4. **No subject-facing view.** A person can have an objection recorded through the API, but there is
   no self-service screen showing them their own record. That belongs to a portal patch.
5. **Guard over-redaction is possible.** The methodology group is wide on purpose. It runs only on
   generated narrative and upstream notes, never on names or identity fields — but a legitimate
   sentence containing, say, a project called "Mercury" would be substituted. Every substitution is
   recorded in `redactions` and counted on the result, so it is visible rather than silent.
6. **Movement is two points, not a trend.** `interpretationHistory()` reports what changed between
   the two most recent successful runs. Nothing fits a line or projects forward.

---

## Handoff contract for the next agent

**Do not change, in this directory:**

- the twelve dimension ids in `DIMENSION_IDS` — the closed list is the guarantee;
- the four guard groups or the negation rule — especially the methodology group's lack of exemption;
- `INFERRED_CONFIDENCE_CEILING`, `SUPERSEDED_CONFIDENCE_FACTOR` or `MIN_MASS` without recording the
  policy decision — they are policy numbers, not tuning constants;
- the order of the confidence arithmetic (cap first, demotions after) — folding demotions in before
  the cap silently erased disagreement from the output, which is the defect the comment records;
- the shape of `FoundationalFactorSet` — extend it additively.

**Extend it here:**

- add a dimension → `dimensions.ts` catalogue **and** the neutrality test will hold you to it;
- add a guard term → `language-guard.ts` group arrays, and add a must-catch sample to
  `languageGuardSelfCheck()`;
- a richer profile surface → call `latestInterpretation()`, do not re-render from the tables.

**What another patch must provide:**

- PATCH 02: `registerFoundationalProvider` + a consent reference on every set.
- Evidence owner: `registerEvidenceProvider`.
- Consent owner: a stable reference string; this patch stores it and never interprets it.
