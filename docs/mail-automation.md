# Mail automation — the event-driven workflow engine

`src/lib/mailplatform/` · admin at **/admin/mail/automation** · API under `/api/mail/automation/`

A workflow is: something happened → check something → do something → wait → check again → do
something else. It is event-driven and persistent. Nothing about a running workflow lives in a
process, so a delay outlives the worker, the deploy and the database restart that happen during it.

This does **not** replace the campaign engine (`src/lib/mail.ts`, `src/lib/mail-advanced.ts`). A
campaign is one message to many people; an automation is one person moving through steps over days,
which is why it can carry per-person merge fields and a condition that is re-checked tomorrow.

---

## The shape of it

| File | What it is |
| --- | --- |
| `graph.ts` | Nodes, edges, the validator. Pure. **The contract a visual builder draws against.** |
| `conditions.ts` | The condition evaluator. Pure, total, never throws. |
| `delay.ts` | Delay arithmetic. Turns "wait 24 hours" into an absolute instant. Pure. |
| `triggers.ts` | The event vocabulary and the trigger matcher. |
| `errors.ts` | Temporary / permanent / business failure, backoff, the retry decision. Pure. |
| `store.ts` | The persistence **port**: types and one interface. No SQL. |
| `pg-store.ts` | That port against Postgres. Three atomic statements carry every guarantee. |
| `memory-store.ts` | The same port in one process. Tests and dry runs. |
| `actions.ts` | What a workflow can do, and which of those cannot be undone. |
| `adapters/` | Channels. Email is built; SMS, push, WhatsApp and Slack are declared and refuse. |
| `engine.ts` | The state machine: one run, moved forward as far as it will go. |
| `router.ts` | Events in, runs out. The **only** way anything starts. |
| `worker.ts` | The tick (scheduler + due runs) and the run lifecycle controls. |
| `service.ts` | Save, validate, activate, install an example, webhook credentials. |
| `examples.ts` | The two recruitment workflows, as data. |
| `security.ts` | The four doors, the HMAC, the outbound-URL guard. |

`src/lib/workflow.ts` is a **different thing** — HR approvals routed through the org graph. The two
share a word and nothing else.

---

## The guarantees, and how each one is actually enforced

### 1. A delay is a row, not a timer

Reaching a delay resolves it **once** into an absolute instant, writes it to
`mail_workflow_runs.wait_until` and sets the state `WAITING`. Waking up is a query. There is no
`setTimeout` anywhere in this engine — on Vercel the process that started a 24-hour wait is long
dead before it ends.

`current_node` while waiting points at the step the wait is **for**, so the runs list reads "waiting
to send the stage-3 reminder".

### 2. An effect happens at most once per (run, node)

`mail_workflow_steps` has `PRIMARY KEY (run_id, node_id)`. Before an action runs, the engine
**claims** that row with one statement. Whoever gets it performs the effect; anybody else sees
`already_done` and skips it, replaying the recorded result.

The one genuinely ambiguous state is a worker that died between claiming and finishing. It is
resolved by asking the action whether repeating it is visible outside this platform:

- **reversible** (`add_tag`, `remove_tag`, `add_to_list`, `update_contact`, `create_event`) — the
  step is re-claimed after 10 minutes and simply runs again.
- **irreversible** (`send_email`, `send_template`, `webhook`) — it is **never** repeated
  automatically. The step goes to `needs_review`, the run is `FAILED` + dead-lettered, and a person
  decides on `/admin/mail/automation`. Mail cannot be recalled, so "possibly not sent, and said so"
  beats "possibly sent twice, and said nothing".

### 3. One event starts at most one run

`mail_workflow_events.event_id` is the primary key, so a re-delivered event is discarded at the
door. `mail_workflow_runs` additionally has `UNIQUE (workflow_id, trigger_event_id)`.

**Send your own `event_id`.** It is the idempotency key. A sender that generates a fresh one per
retry has no idempotency, and two "identical" deliveries become two letters to one candidate.

### 4. A run never changes shape mid-flight

Every definition edit bumps the version and writes a snapshot to `mail_workflow_versions`. A run
records the version it started on and follows that snapshot to the end. Without this, deleting a
node re-points every parked run at whatever now occupies that position.

---

## States

`RUNNING` · `WAITING` · `COMPLETED` · `FAILED` · `CANCELLED` · `PAUSED`

A run carries `workflow_id`, `contact_id`, `run_id`, `current_node`, `state`, `started_at`,
`updated_at`, `completed_at`, `error`, `retry_count` — plus `error_kind`, `dead_letter`,
`wait_until` and `trigger_event_id`.

**`COMPLETED` with `error_kind = 'business'` is not a failure.** "This candidate had unsubscribed"
is the system working; counting it red trains operators to ignore red.

---

## Failure handling

| Kind | Example | What happens |
| --- | --- | --- |
| temporary | `421 4.7.0 try again`, connection reset, 503 | retry with backoff: 1m, 2m, 4m, 8m, 16m, capped at 1h, up to 5 attempts, then dead-letter |
| permanent | `550 5.1.1 no such user`, missing template, unknown action | dead-letter immediately — five more identical failures, delayed, help nobody |
| business | unsubscribed, no deadline on the event, no contact | end the run, record why, **count nothing as an error** |

`retry_count` resets per step, not per run: five retries are five retries of *this* step, not a
budget the whole run exhausts on its third node.

---

## Triggers

Contact created / updated / added to list · tag added / removed · campaign sent · email delivered /
opened / clicked / bounced / unsubscribed · API event · webhook event · scheduled date / time.

Recruitment events, first-class through the same router: `application.submitted`,
`application.stage.changed`, `assessment.assigned`, `assessment.completed`, `interview.scheduled`,
`internship.selected`, `internship.rejected`.

Any well-formed dotted lower-case name works, declared or not — that is what "custom application
event" means here. Free text (`"Stage Changed!!"`) is refused, because the log is queried by type
and two spellings would be two silently different triggers.

---

## Conditions

`equals` · `not_equals` · `contains` · `starts_with` · `ends_with` · `greater_than` · `less_than` ·
`exists` · `does_not_exist`, combined with `{and:[…]}`, `{or:[…]}`, `{not:…}`.

Decisions worth knowing:

- **False is the safe answer.** The `true` branch usually sends something; a broken comparison
  therefore sends nothing rather than mailing people on the strength of a typo.
- A **missing field** is `false` for everything except `not_equals`, where it is genuinely `true`.
- **Case-insensitive by default** (`caseSensitive: true` to opt out).
- `greater_than` compares numbers as numbers, then dates as dates, then text — so 9 is not greater
  than 10.
- An **empty AND is true, an empty OR is false**.
- The trace records **every** rule, not only up to the first failure, because the trace is what
  answers "why did this candidate go that way".

---

## Actions

`send_email` · `send_template` · `add_tag` · `remove_tag` · `add_to_list` · `remove_from_list` ·
`update_contact` · `wait` · `webhook` · `create_event` · `end_workflow`.

`send_template` reads `email_templates` — the catalogue `/admin/mail/templates` already writes — and
fills `{{first_name}}` style fields through `src/lib/mail-personalize.ts`. Use
`{{name|default:fallback}}`; a bare `{{name|fallback}}` is not a token and goes out literally.

**Unsubscribe is enforced in the send path, not in the builder.** A person who asked not to be
mailed asked the platform, not one workflow.

### Channels

Email is built. SMS, push, WhatsApp and Slack are declared in `adapters/` and **refuse to send**
with a sentence naming the channel. Wiring one up is implementing `send()` and flipping
`available()`; nothing in the engine, the actions or the builder changes.

---

## Delays

`minutes` · `hours` · `days` · `until` (absolute) · `until_field` (a date from the event, plus or
minus an offset — this is how "wait until the deadline minus 24 hours" is written).

A target already in the past resolves to **now** and fires immediately: a replayed or backfilled
event must finish, not strand a run in `WAITING` for ever. A missing `until_field` value is a
business failure — the engine does not invent a deadline and mail somebody about it.

---

## Security

Four doors, all in `security.ts`:

1. **Admin API** — `denyMailApi()`, the same gate as `/api/mail/send`, then scoped to the
   organisation. Every store method takes `orgId` and every query filters on it.
2. **Internal emit** — same gate; source recorded as `internal`.
3. **Webhook** — a per-workflow token in the URL says *which workflow*, an HMAC-SHA256 signature over
   `"<timestamp>.<body>"` proves the sender holds the secret, and a five-minute window stops replay.
   Fails closed, including when no secret is configured. The event type is **pinned to that
   workflow's trigger**, so a signed sender cannot start every other workflow in the organisation.
   Body capped at 64 KB. The organisation comes from the workflow row, never from the request.
4. **Outbound webhook** — https only, no credentials in the URL, no localhost / `.internal` /
   private ranges. Without it, anyone who can author a workflow could make the server fetch an
   internal address and read the answer off the run page.

A chain of workflows triggering one another is bounded at **5** links deep.

### Verifying a webhook, from the sending side

```
timestamp = unix seconds
signature = hex hmac_sha256(secret, timestamp + "." + body)

POST /api/mail/automation/hook/<token>
X-Automation-Timestamp: <timestamp>
X-Automation-Signature: <signature>
Content-Type: application/json

{"type":"assessment.completed","event_id":"<your stable id>",
 "contact_email":"person@example.test","payload":{"score":72}}
```

Answers `202` with `{ok, event_id, duplicate, started_runs}`.

---

## Announcing an event from the rest of the platform

```ts
import { emit, pgStore, ORG_ID } from '@/lib/mailplatform';

await emit(pgStore, {
  type: 'application.stage.changed',
  orgId: ORG_ID,
  contactEmail: applicant.email,
  contact: { firstName: applicant.first_name, applicationNumber: applicant.number },
  payload: { stage: '3', previous_stage: '2' },
  eventId: 'stage:' + applicant.id + ':3',   // stable = safe to retry
});
```

That is the entire integration surface. The contact is created on first sight (which is also how
`contact.created` fires). Nothing outside `src/lib/mailplatform/` should build a run, read the step
ledger, or decide whether a send is a duplicate.

---

## Running it

`/api/mail/automation/tick` is the worker: it emits due scheduled events, claims every run whose
wait has ended, and advances each one. Protected by `CRON_SECRET`, **failing closed** — with no
secret set nothing runs, visibly, rather than the URL standing open as an anonymous send button.

`vercel.json` calls it once a day (Hobby crons are daily-only on this project). **A 24-hour delay
resolved at 09:00 therefore fires on the next daily pass, not at 09:00 sharp.** For minute-level
timing, call the URL from any scheduler with the secret:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://www.edurankai.in/api/mail/automation/tick
```

A tick is bounded and reports `more_due` when it hit its limit. It never implies it drained the
queue.

---

## The tables

`db/mail-automation-schema.sql` — **run it yourself**; CLAUDE.md forbids this repository's agents
from opening a database connection, so these tables have not been created. `ensureAutomationSchema()`
runs the identical statements on first use if you would rather.

```
psql "$DATABASE_URL" -f db/mail-automation-schema.sql
```

`mail_workflows` · `mail_workflow_versions` · `mail_workflow_events` · `mail_workflow_runs` ·
`mail_workflow_steps` · `mail_contacts` · `mail_contact_lists` · `mail_contact_list_members`

---

## The visual builder

The server side of one is finished: stable node ids, an edge model with labelled branches, a
validator that explains every problem against a node id, and `GET /api/mail/automation/workflows`
returning the trigger, operator, action and channel catalogues. **No page hard-codes a workflow
shape** — `/admin/mail/automation/[id]` renders its whole palette from those catalogues, and edits
the same JSON structure a canvas would post, through the same validation.

The drag-and-drop canvas itself is not built. It can be added without the engine changing.

---

## Testing

```
npx vitest run src/lib/mailplatform
```

`pure.test.ts` covers the validator, the evaluator, the delay arithmetic, the classifier and the
HMAC. `engine.test.ts` covers the things that only appear over time and across processes: a delay
that outlives its worker, a **worker restart** (new engine objects over the same store), a
**database restart** (the whole store serialised to JSON and read back), a duplicate event, a crash
between the send and the record of it, retry-to-dead-letter, business-rule endings, cancellation,
pause/resume, chained workflows, and an edit while runs are in flight.

Both run against `MemoryStore`, which enforces the same atomicity rules as the Postgres store — the
behaviours being tested are about **ordering**, and ordering is what it reproduces. It is not a mock.

---

## Known limits, stated

- **A follow-on event can be lost.** If the process dies between recording a step and publishing the
  event that step emitted (`tag added`, `create_event`), the announcement is gone — a workflow
  chained off it will not start. It is logged as an error with the run id, and the events that
  *should* have been emitted are recorded on the step, so the run page shows them.
- **DNS is not resolved** by the outbound-URL guard, so a hostname that resolves to a private address
  at request time gets through. The remaining protection is that only operators holding `mail.manage`
  can author a workflow, and every call is recorded on the step.
- **Cycles between two workflows** are only caught by the depth limit at runtime, not at authoring
  time. Cycles *within* one definition are refused outright.
- **Timing is as coarse as the tick.** See "Running it".
