# Patch 14 — Manager and Team Lead Intelligence

The day-to-day screen a line manager or team lead uses: what the people they manage are working on,
how delivery is going, where the load sits, what they might do about it, and the controls to actually
do it.

**Surfaces**

| URL | What it is |
| --- | --- |
| `/portal/manager` | The team a manager is authorised to see, with the two or three numbers that decide who to open first. |
| `/portal/manager/<employeeId>` | One team member: the ten sections, and every manager control. |

---

## 1. What this patch owns, and what it deliberately does not

It owns **three tables** and **two pages**. Every fact it renders is read from the module that already
owns it.

| Owned | Purpose |
| --- | --- |
| `mti_manager_actions` | Append-only. One row per manager act, with the signal snapshot they were looking at. |
| `mti_development_actions` | Tracked development items with a status that moves. |
| `mti_record_outbox` | The durable boundary to the central employee intelligence record. |

**Not owned, and not duplicated:**

| Concept | Owning module | How this patch reaches it |
| --- | --- | --- |
| Feedback | `src/lib/performance.ts` → `hr_feedback` | `giveFeedback()`. This patch never writes that table. |
| HR support requests | `src/lib/helpdesk.ts` → `helpdesk_tickets` | `createTicket({ category: 'hr' })`, which routes to a desk owner and starts an SLA. |
| Who reports to whom | `src/lib/org-graph.ts` → `org_relationships` | Read only, per row, as of now. |
| May I see this person | `src/lib/performance-scope.ts` | `resolvePerfViewer()`, `canSeePerformanceOf()`. No second implementation exists here. |
| The organisation event spine | `src/lib/hr-events.ts` → `hr_events` | `timelineFor()`. Read only — this patch emits no `hr_events` rows and adds no event type. |
| Tasks, reports, attendance, leave, conduct flags | their own modules | Read only, through the columns listed in §5. |

---

## 2. Files

**Created**

```
src/lib/manager-intelligence/types.ts          contracts + the signal constructor that enforces them
src/lib/manager-intelligence/signals.ts        PURE: facts in, sentences out. No DB, no clock.
src/lib/manager-intelligence/recommend.ts      PURE: signals in, suggestions out.
src/lib/manager-intelligence/schema.ts         the three tables + an information_schema state check
src/lib/manager-intelligence/record-port.ts    the integration boundary to the central record
src/lib/manager-intelligence/read.ts           the scoped reads
src/lib/manager-intelligence/write.ts          the five manager acts
src/lib/manager-intelligence/signals.test.ts   19 tests
src/lib/manager-intelligence/recommend.test.ts 15 tests
src/pages/portal/manager/index.astro           the roster
src/pages/portal/manager/[employeeId].astro    the ten sections
db/manager-intelligence-schema.sql             the DDL, for production
docs/manager-intelligence.md                   this file
```

**Modified:** none. No existing file was edited by this patch.

---

## 3. Deploying the schema

Schema bootstrap is disabled in production on this project (`src/lib/ensure-once.ts` returns early
when `NODE_ENV` is `production`, after the 2026-08-23 cold-deploy DDL storm). So the tables are
created **by hand, once**:

```bash
psql "$DATABASE_URL" -f db/manager-intelligence-schema.sql
# or, without psql:
node scripts/apply-sql.mjs db/manager-intelligence-schema.sql --env-file .env.production
```

Everything in it is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Running it twice
changes nothing. Until it has been run, both pages **read** normally and every write control says so
in words — `schemaState()` reports which tables are missing rather than letting an empty page look
like an empty team.

Verify:

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('mti_manager_actions','mti_development_actions','mti_record_outbox');
SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='mti_actions_no_change' AND NOT tgisinternal);
```

---

## 4. The explainability contract

Every derived statement carries the full envelope, and `buildSignal()` **throws** rather than
constructs one that does not:

```
INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
```

`ManagerSignal` is that envelope. The rules the code enforces, not just documents:

1. **`ADMISSIBLE_SOURCES` is a closed list.** A signal whose input names a source outside it throws
   at construction. Birth data, derived traits, health, `wellness_*`, `hr_clock_events`, leave type
   and leave reason, and every protected attribute are absent from the list and cannot be added by a
   caller.
2. **Demonstrated evidence outranks everything else.** `evidenceStrength` is
   `demonstrated` (the person did it, recorded as it happened) > `stated` (a named human wrote it) >
   `derived` (this module counted and divided). `recommendationsFor()` drops any candidate whose
   strongest trigger is only `derived`.
3. **A rate is never printed over fewer than `MIN_OBSERVATIONS` (3) observations.** Below the bar
   the signal says how little there is to read instead of dividing two small numbers.
4. **A failed read is not a zero.** `facts.readFailures` names the areas that could not be read;
   those sections emit nothing and the page prints why.
5. **Nothing decides anything.** `RecommendedAction.humanDecides` is the literal `true` in the type.
   No code path from this patch sets a status on anybody's employment record.

Every derived line renders visibly lighter than a record (`.signal.advisory`) and can be opened to
show exactly what was counted, by what method, with what confidence and over what window.

---

## 5. Exactly what is read, and what is refused

| Read | From | Used for |
| --- | --- | --- |
| status, priority, `due_on`, `completed_at`, `blocked_reason`, `created_at` | `employee_tasks` | Current work, delivery, capacity |
| `report_date`, `created_at`, `revision_count`, `reviewed_at` | `hr_daily_reports` | Submission patterns, report rework |
| `date`, `status` | `hr_attendance` | Which days a report was expected; working pattern |
| `start_date`, `end_date`, `status='approved'` | `hr_leave_request` | Cover planning **only** |
| `action`, `diff->>'from'`, `diff->>'to'`, `diff->>'employeeId'` | `audit_log` | Send-backs, work picked up, blockers raised |
| `theme` counts where `visible_to_manager` | `hr_feedback` | Stated strengths and improvement areas |
| `COUNT(*) WHERE level = 1` | `hr_employee_flags` | One line: "HR holds N informal conduct notes" |

**Refused, each for a reason** (the list is repeated at the top of `read.ts` so it cannot drift):

- gender, date of birth, marital status, address, salary, bank details, PAN/Aadhaar/UAN — `gender` is
  the exact column read in the 2026-08-02 incident and is not selected, joined, or used to order;
- anything from `wellness_*`;
- `hr_clock_events` — latitude, longitude, IP, device string, a selfie per punch;
- `hr_leave_request.reason` and `.leave_type`;
- `hr_employee_flags` at level 2 or 3, and every flag's description, breach type and action;
- profile photographs (the face-2FA enrolment frame). Initials are used.

---

## 6. The five manager acts

All in `write.ts`. Each one: **authorise → write it where it belongs → append the act → publish**.

| Function | Writes the real thing to | Appends |
| --- | --- | --- |
| `recordFeedback()` | `hr_feedback` via `giveFeedback()` | `structured_feedback` |
| `acknowledgeSignal()` | (nothing else — the act is the record) | `signal_acknowledged` |
| `recordIntervention()` | (nothing else) | `intervention_recorded` |
| `requestHrSupport()` | `helpdesk_tickets` via `createTicket()` | `hr_support_requested` |
| `createDevelopmentAction()` / `updateDevelopmentAction()` | `mti_development_actions` | `development_action` |

`WriteResult` carries `recorded` and `published` **separately**, so a caller is told which half did
not happen instead of being shown a success message covering a queue that took nothing.

**Acknowledging does not dismiss.** The signal keeps rendering, now marked answered, with the
manager's reading beside it at a higher evidence weight than the number itself.

**Authority basis** is resolved at the moment of the act and written onto every row and every
envelope: `direct_report` · `review_subject` · `responsible_via_org_graph` ·
`capability:performance.manage`. Months later, "why was this person allowed to write that about me"
has a one-word answer.

---

## 7. HANDOFF — the contract for the central employee intelligence record

This patch does not build the central record. It publishes to it two ways, and **both work with
nobody on the other end**.

### Option A — register a sink (preferred)

```ts
import { registerEmployeeIntelligenceSink } from '@/lib/manager-intelligence/record-port';
import type { RecordEnvelope } from '@/lib/manager-intelligence/types';

registerEmployeeIntelligenceSink({
  name: 'employee-intelligence-record',
  async accept(envelope: RecordEnvelope) {
    // MUST be idempotent on envelope.actionId — the outbox retries.
    await upsertIntoCentralRecord(envelope);
    return { ok: true };
  },
});
```

Call it once at module load from the owning patch. Registering a second sink replaces the first and
logs a warning; two consumers would each see half the acts depending on load order.

### Option B — drain the outbox

```ts
import { pendingEnvelopes, acknowledgeDelivery, outboxHealth }
  from '@/lib/manager-intelligence/record-port';

for (const row of await pendingEnvelopes(200)) {   // oldest first
  await writeIntoCentralRecord(row.envelope);
  await acknowledgeDelivery(row.id);
}
```

`outboxHealth()` returns `{ pending, oldestPendingAt, withError, sinkName, sentence }` for an ops
screen. A queue nobody drains looks exactly like a queue that is working, right up until six weeks of
manager actions are missing from somebody's record.

### The envelope

```ts
interface RecordEnvelope {
  actionId: string;              // mti_manager_actions.id — the idempotency key
  subjectEmployeeId: string;     // hr_employees.id
  actorUserId: string;
  actorEmployeeId: string | null;
  kind: 'structured_feedback' | 'signal_acknowledged' | 'intervention_recorded'
      | 'hr_support_requested' | 'development_action';
  signalKey: string | null;      // e.g. 'current_work.overdue'
  section: SectionKey | null;
  recordRef: string | null;      // 'module:table:id' — where the WORDS live
  authorityBasis: string;
  occurredAt: string;            // ISO
}
```

**It carries no free text about a person, deliberately.** The feedback stays in `hr_feedback`, the
referral in `helpdesk_tickets`, the intervention note in `mti_manager_actions` — the envelope points
at the row. A second copy of somebody's appraisal note in a table nobody thinks of as holding one is
how disclosure happens by accident. Consumers that need the words must read them from the module
named in `recordRef`, under that module's own access rules.

### Reading the acts directly

If the central record prefers to read rather than be pushed to, `mti_manager_actions` is append-only
(`mti_actions_no_change` refuses UPDATE and DELETE), keyed on `subject_employee_id, created_at DESC`,
and carries `signal_snapshot` — the full envelope the manager was looking at when they acted, stored
rather than recomputed because the numbers move.

---

## 8. Dependencies on other patches

| Needs | Status | What happens without it |
| --- | --- | --- |
| Central employee intelligence record | **not present** | Acts queue in `mti_record_outbox`, `published_at` stays null. Nothing is lost. |
| Organization Graph populated (`db/org-graph-backfill.sql`) | may be empty | The roster says "the graph has not been set up yet" — a different sentence from "nobody reports to you". |
| `db/manager-intelligence-schema.sql` run in production | **operator action** | Pages read; write controls say the tables are missing. |

This patch **provides** to others: `signalsFor()` / `recommendationsFor()` (pure, DB-free, callable
from any surface), the `EmployeeIntelligenceSink` port, and the act log itself.

---

## 9. Tests

`npx vitest run src/lib/manager-intelligence` — 34 tests, all pure, no database.

They assert the rules rather than the wording: an inadmissible source throws; rates are withheld below
the minimum; a failed read emits nothing rather than zero; the conduct line is a count whose source is
`hr_employee_flags:count_only`; strengths and development areas are held to the same bar; no
recommendation rests on `derived` evidence alone; every recommendation is `humanDecides: true`; the
list order is stable.

**Verified:** `tsc --noEmit` clean across the patch; both `.astro` pages compile through
`@astrojs/compiler` with zero diagnostics; 34/34 tests pass.

**Not verified:** a full `astro build` — the working tree currently contains another agent's
in-flight `src/pages/founder/intelligence/[id].astro`, which fails the build for reasons unrelated to
this patch. Nothing here has been exercised against a live database; the schema file has not been run.

---

## 10. Known limitations

1. **`audit_log` is the only rework source.** `employee_tasks` keeps no transition history of its own,
   so send-backs are counted from audited status moves. `logAudit()` swallows its own failures and
   nothing is backfilled, so a move made before auditing existed is *absent*, not zero. The signals
   that read it say so in their confidence basis.
2. **Weekdays are assumed.** "Days with no record" counts Monday to Friday. Somebody on a different
   working week looks worse there than they are; the signal's own detail states the assumption.
3. **Assignment counts are a poor proxy for load.** Two tasks may be an afternoon and one may be a
   fortnight. No hours are read — `eims-workload` is intern-programme-shaped and `hr_timesheets` was
   not wired in. Stated on screen.
4. **The team mean is over direct reports only,** not the whole department, and on a small team one
   colleague's quiet fortnight moves it a long way. It is marked `derived` and can never carry a
   recommendation on its own.
5. **A capability holder with no reports sees an empty roster,** on purpose: `performance.manage` does
   not make the whole company somebody's team, and this is a team screen.
6. **`ROSTER_CAP` is 60.** Beyond that the page says how many it is showing rather than truncating
   silently.
7. **No API route.** Both surfaces are server-rendered forms; there is no JSON endpoint for this data.
   If another patch needs one, build it on `signalsFor()` and `factsFor()` rather than re-querying.
