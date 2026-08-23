# HORIZON PATCH 04 — Psycho-Behavioural Intelligence

**Module:** `src/lib/horizon/behaviour/` · **Import from:** `@/lib/horizon/behaviour`
**Patch id:** `horizon-behaviour` · **Engine:** `horizon.behaviour.work-pattern` v1.0.0 (`statistical`)

Evidence-based behavioural analysis over work records the organisation already keeps. It computes
nothing about a person's mind, motivation or health, produces no score, ranks nobody against anybody,
and decides nothing.

---

## 1. What it reads, and what it refuses to read

| Source | What it gives | Owner |
|---|---|---|
| `audit_log` where `entity = 'employee_task'` | the transition trail: assigned, accepted, progressed, blocked, submitted, returned, approved, completed, cancelled, project-linked | `src/lib/employee-tasks.ts` |
| `employee_tasks` | due date, priority, the task id list | `src/lib/employee-tasks.ts` |
| `edu_attempts` | assessment attempt started / submitted **timestamps only** | `src/lib/assessment.ts` |
| `hr_employees` | joining date, last working day, linked login, department | HR schema |

**No new table, no new column, nothing written** except this patch's own access-log rows.

`employee_tasks` carries only the *current* status and `status_changed_at` — the last move, not the
history. The history already exists: `employee-tasks.ts` writes an `audit_log` row for every
transition with `{ employeeId, from, to, roles, reason }` in `diff`. This patch reads that trail. An
event log invented here would be a second, disagreeing account of the same transitions.

**Read by task id, never by `diff`.** `audit_log` is indexed on `(entity, entity_id)`;
`diff->>'employeeId'` is indexed on nothing, so filtering by it would sequentially scan the whole
organisation's audit table to answer a question about one person.

**Never read:** attendance, clock events, location, device, message content, browsing, screenshots,
keystrokes, wellness data, pay — and no assessment *score*, mark or pass result. There is no covert
channel and no configuration flag that adds one.

---

## 2. The six windows

`recent` (rolling 14 days) · `this_week` (Monday start) · `this_month` · `this_quarter` ·
`this_year` · `employment_history`

Boundaries are computed in the working zone (`DEFAULT_TZ_OFFSET_MINUTES = 330`, IST — one offset, no
daylight saving, so it is exact rather than approximate). Every window is clamped to the person's
employment and says so: a "this year" window on somebody who joined in July is three months of data
wearing a twelve-month label, and `clampedToEmployment` plus `statement` make that visible.

> **Limitation.** A deployment in a zone *with* daylight saving must not use the fixed offset as-is —
> it would misplace one hour twice a year. The fix is an IANA-aware boundary function in
> `windows.ts`, not a different number.

---

## 3. The thirteen metrics

Read `METRIC_META[key].definition` — **a surface that renders a number must render the definition
with it.** Each is a sentence about rows, not about a person.

**Reliability:** acceptance latency · first-response latency · on-time completion rate · overdue days
when late · follow-through rate · timing consistency
**Growth:** revision frequency · rework rate · assessment submission rate · assessment pace
**Collaboration:** blocks raised with a stated reason
**Contribution:** self-driven transition share · distinct projects with recorded activity

Four rules every metric obeys:

1. **`null` is not zero.** Below `minSample` the value is `null` and `insufficient` is `true`. A
   person who closed no tasks this week has an *unknown* on-time rate, not a zero one.
2. **Latencies use the median.** One task that sat over a four-week absence moves a mean by weeks and
   describes nothing about how somebody works.
3. **Nothing is weighted by priority.** `complexity` segments; it never multiplies. A dropdown value
   is not a measurement.
4. **Every value carries its rows.** `evidence` is capped at 12 for transport; `evidenceCount` is the
   true total.

---

## 4. Baseline, trend, pattern

**Baseline** is the same *length* as the window, immediately before it — not "the previous calendar
month", because comparing eleven days of August against thirty-one of July makes everybody look
slower in the first third of every month. Where that period is too thin, the comparison falls back to
the person's whole employment history and `Baseline.kind` says so.

**Verdict:** `improving` · `declining` · `stable` · `changed_without_direction` ·
`insufficient_evidence`.

- Movement inside `MIN_RELATIVE_CHANGE` (15%) is `stable` — a *finding*, not a shrug.
- `changed_without_direction` is for metrics whose `betterWhen` is `neutral`. Assessment pace moving
  from four hours to nine is a real change; calling it a decline would be the system deciding that
  faster is better when nothing in the record says so.
- `stable` and `insufficient_evidence` are never merged. "Nothing changed" is a finding; "we could
  not tell" is an admission.

**Pattern:** `temporary_anomaly` · `sustained_pattern` · `undetermined`. The window is cut into six
buckets; a bucket "deviates" if it moved the *same way* as the overall movement by more than the
tolerance.

| Condition | Pattern |
|---|---|
| fewer than 3 buckets held data | `undetermined` |
| no bucket deviated | `undetermined` (the average moved but no part of it did — that is bucketing) |
| most recent bucket deviates, in a run of 2+ | `sustained_pattern` |
| most recent bucket does **not** deviate | `temporary_anomaly` |
| most recent bucket deviates, alone | `undetermined` (start of something, or a bad week) |

**Confidence** is a band (`none`/`low`/`moderate`/`high`), never a percentage, and it **only ever
falls**: base band from sample size, then downgrades for a source that returned nothing, a source
that could not be *read* (caps at `low`), records older than 60 days, or everything landing in one
sub-period. Reasons are mandatory, including for `high`.

---

## 5. Access

```ts
const r = await computeBehaviouralProfile({
  employeeId,                       // hr_employees.id — one person; there is no plural form
  purpose: 'people_management',     // required, enforced, recorded
  viewer: { user: Astro.locals.user, locals: Astro.locals, ipAddress: clientAddress },
});
```

Grounds are tried weakest-scope first, and the **first** match is the one recorded:

| Ground | How it is established | Purposes it admits |
|---|---|---|
| `self` | viewer's own employee record | `self_review` |
| `reporting_manager` | `isReportingManager()` — **per row, from the org graph** | `people_management`, `performance_cycle`, `workload_review` |
| `department_head` | `behaviour.view_department` **and** `getHeadedDepartmentIds()` contains the subject's department | the above plus `org_oversight` |
| `org_capability` | `behaviour.view_org` | `performance_cycle`, `org_oversight` |

- The reporting line is resolved from `org_relationships`, never from
  `hr_employees.reporting_manager_id`, which this codebase has established is written by zero lines
  of application code.
- Holding a capability is **not** a management relationship — `org_capability` cannot claim
  `people_management`.
- **The access log is written and awaited before any record is read.** `logAuditOrThrow` throws if
  the row does not land, and that throw becomes a refusal. A read that cannot be logged does not
  happen. Refusals are logged too, on the non-throwing writer.
- Every refusal is the same sentence and never reveals whether the employee exists.

### The two capability keys — action required from the Authorization owner

`behaviour.view_org` and `behaviour.view_department` are checked through
`hasPermission(userId, key)`, which takes `key: string` and unions built-in role grants with
`role_permissions`. **This patch did not edit `Permission` in `src/lib/auth/permissions.ts` or
`PERMS_BY_ROLE`** — deciding which roles hold a key is a *policy* change, and the standing rule is
that mechanism ships and policy needs explicit approval.

Today these keys are held by nobody except `super_admin` (through the wildcard) and by any custom
role an admin grants them to. The `BUILTIN_PERMISSIONS` entries to add, when approved, are exported
as data in `access.ts` as `REGISTRY_ENTRIES` — copy them from there rather than retyping.

### Consent

`setConsentCheck(fn)` is the seam. PATCH 04 does not own a consent register and must not build one.
The default is written down rather than assumed: these are organisational work records processed for
the management of work, and a person may always read their own. **An injected check that throws fails
closed** — a consent register that is down is not consent.

---

## 6. HORIZON integration

`provider.ts` maps `BehaviourTrend` → `IntelligenceResult` and registers a `MeirProvider`.

- Dimensions land in `reliability`, `growth`, `collaboration`, `contribution`. **Nothing maps to
  `risk` or `wellbeing_aggregate`** — this engine reads task timestamps and has no basis for calling
  anybody a risk.
- Evidence class is `observed`, never `demonstrated`. A timestamp saying a task changed column is an
  observation about how work flowed; claiming the stronger class would let punctuality outrank a
  demonstrated skill in the confidence arithmetic, which is the inversion rule 22 exists to prevent.
- `layer: 'computed'` · `decisionUse: 'advisory_only'` · `scientificStatus: 'platform_record'` ·
  `humanReviewStatus: 'pending'` · `historicalSupport: false` (the engine does not reconstruct what
  the record said on a past date, and declines rather than return today's figures under an old one).
- Every result is passed through `buildIntelligenceResult()` before it leaves. One that fails the
  shared contract is **dropped and logged**, never emitted.

### The one thing the record surface must wire

`ProviderContext` carries a subject and a request id — **no viewer**. `composeRecord()` does not
authorise. PATCH 04 will not read a person's work history on the strength of that, so the provider
**fails closed**: with no viewer it contributes a `not_computed` section saying exactly that.

```ts
import { registerBehaviourProvider, setBehaviourViewerResolver } from '@/lib/horizon/behaviour';

await registerBehaviourProvider();                    // once, at start-up
setBehaviourViewerResolver(async (ctx) => {
  const viewer = viewerForRequest(ctx.requestId);      // already authenticated by the surface
  return viewer ? { viewer, purpose: 'performance_cycle' } : null;
});
```

Until that is wired, the record simply says this section was not opened. That is the intended
default, not a bug.

---

## 7. HTTP

```
GET /api/hr/behaviour/:employeeId?purpose=<purpose>[&window=<w>,<w>][&metric=<k>,<k>]
```

`purpose` is required and has no default — a field that always says the same thing tells a later
auditor nothing. `401` unauthenticated · `400` bad purpose · `403` refused (same sentence for every
ground) · `500` with nothing partial shown. `Cache-Control: no-store, private`.

Returns the full explainability envelope: `inputs` (every source, rows read, readable, notes),
`processing` (the named steps in order), `metrics`, `trends`, `confidence`, `limitations`,
`computedAtIso`, `access`.

---

## 8. Known limitations — stated, not implied

These are returned on every profile in `limitations[]`, not buried here.

- Only tasks and assessment attempts **recorded on this platform** are read. Work done in a
  repository, a document, a conversation, a meeting or any unconnected tool is invisible, and its
  absence means nothing.
- The only complexity information is the priority the assigner typed. Two tasks of very different
  difficulty count the same.
- An employee with no linked login has **no** self-driven attribution and **no** assessment history —
  a gap in the join, not an absence of behaviour, and it is reported as one.
- Blocks, reassignments and cancellations are frequently organisational events, not facts about the
  assignee.
- Read caps: 750 tasks, 8000 transitions, 500 attempts. When a cap bites it is reported in
  `inputs.sources[].note`, never silently truncated.
- `historicalSupport: false` — no `asOf` reconstruction.
- **Not verified against a live database.** Every test in `behaviour.test.ts` (50, all passing) runs
  without a connection, by design. The SQL shapes were written against
  `src/lib/employee-tasks.ts`, `db/hr-schema.sql` and `src/lib/assessment.ts` **read as source**; no
  query in this patch has been executed against real data.

## 9. Not in this patch

Manager and colleague feedback (**PATCH 05**) is not read, weighted or reflected anywhere. There is
no field for an opinion on `ProfileRequest` and there never will be — a profile that folded a
judgement into a computed figure would destroy the evidence-versus-judgement distinction that makes
any of this safe to show a person.

There is no function returning a score, a rank, a percentile, a cohort comparison or a
recommendation. That is deliberate. An ordering of people by a behavioural figure is the artefact
that turns advisory evidence into a decision nobody admits to making.
