# Mail automation — the execution engine

`src/lib/mailplatform/` · ops console at **/admin/mail/automation** · API under `/api/mail/automation/`

An automation is: something happened → check something → do something → wait → check again → do
something else. It is event-driven and persistent. Nothing about a running automation lives in a
process, so a delay outlives the worker, the deploy and the database restart that happen during it.

## Where this sits

The **builder** already existed: `src/lib/mail-product/automations.ts` owns the graph shape
(`AutomationGraph`), `validateGraph()`, the node catalogue and the CRUD, and `/mail/automations` is
the canvas. What it did not have was an **executor** — nothing in the codebase ever inserted a row
into `mail_automation_runs` or advanced one, so a published automation sat there, correct and inert.

This folder is that executor. It adds no second graph shape, no second validator and no second
writer:

| Concern | Owner |
| --- | --- |
| Graph shape, node catalogue, `validateGraph()`, create/save/delete, Publish gate | `mail-product/automations.ts` |
| Event routing, run state, delays, idempotency, retries, lifecycle, scheduler | `mailplatform/` |

It also does **not** touch the campaign engine (`mail.ts`, `mail-advanced.ts`, `mail-campaigns.ts`).
A campaign is one message to many people; an automation is one person moving through steps over
days, which is why it can carry per-person merge fields and re-check a condition tomorrow.

---

## The files

| File | What it is |
| --- | --- |
| `graph.ts` | The **adapter** onto the canvas's graph: next-node, condition/delay translation, platform checks. Pure. |
| `conditions.ts` | The condition evaluator. Pure, total, never throws. |
| `delay.ts` | Delay arithmetic. Turns "wait 24 hours" into an absolute instant. Pure. |
| `triggers.ts` | The event vocabulary, the canvas-key aliases, the trigger matcher. |
| `errors.ts` | Temporary / permanent / business failure, backoff, the retry decision. Pure. |
| `store.ts` | The persistence **port**: types and one interface. No SQL. |
| `pg-store.ts` | That port against Postgres. Three atomic statements carry every guarantee. |
| `memory-store.ts` | The same port in one process. Tests. |
| `actions.ts` | What each node kind does, and which of those cannot be undone. |
| `adapters/` | Channels. Email is built; SMS, push, WhatsApp and Slack are declared and refuse. |
| `engine.ts` | The state machine: one run, moved forward as far as it will go. |
| `router.ts` | Events in, runs out. The **only** way anything starts. |
| `worker.ts` | The tick (scheduler + due runs) and the run lifecycle controls. |
| `service.ts` | Version snapshots, webhook credentials, readiness, example installer. |
| `examples.ts` | The two recruitment automations, as graphs. |
| `security.ts` | The four doors, the HMAC, the outbound-URL guard. |

`src/lib/workflow.ts` is a **different thing** — HR approvals routed through the org graph.

---

## The guarantees, and how each is actually enforced

### 1. A delay is a row, not a timer

Reaching a delay resolves it **once** into an absolute instant, writes it to
`mail_automation_runs.wait_until` and sets the state `waiting`. Waking up is a query. There is no
`setTimeout` anywhere — on Vercel the process that started a 24-hour wait is long dead before it ends.

`node_id` while waiting points at the step the wait is **for**, so the runs list reads "waiting to
send the reminder".

### 2. An effect happens at most once per (run, node)

`mail_automation_steps` has `PRIMARY KEY (run_id, node_id)`. Before an action runs the engine
**claims** that row in one statement. Whoever gets it performs the effect; anybody else sees
`already_done` and replays the recorded result.

The one genuinely ambiguous state is a worker that died between claiming and finishing. It is
resolved by asking the action whether repeating it is visible outside this platform:

- **reversible** (`add_tag`, `remove_tag`, `update_contact`) — re-claimed after 10 minutes and re-run.
- **irreversible** (`send_email`, `webhook`) — **never** repeated automatically. The step goes to
  `needs_review`, the run is `failed` + dead-lettered, and a person decides on
  /admin/mail/automation. Mail cannot be recalled, so "possibly not sent, and said so" beats
  "possibly sent twice, and said nothing".

### 3. One event starts at most one run

`mail_automation_events.event_id` is the primary key, so a re-delivered event is discarded at the
door. `mail_automation_runs` additionally has `UNIQUE (automation_id, trigger_event_id)`.

**Send your own `event_id`.** It is the idempotency key. A sender that generates a fresh one per
retry has none, and two "identical" deliveries become two letters to one candidate.

### 4. A run never changes shape mid-flight

Every graph change bumps `mail_automations.version` and writes a snapshot to
`mail_automation_versions`. A run records the version it started on and follows that snapshot to the
end. Without this, deleting a node re-points every parked run at whatever now occupies that position.

The snapshot is taken by `snapshotGraph()` (or `POST /api/mail/automation/catalogue`
`{action:"snapshot"}`) after the builder saves. A graph saved without it gets no snapshot, and the
engine says so on the run (`no snapshot of version N was kept`) rather than pretending.

---

## States

`running` · `waiting` · `completed` · `failed` · `cancelled` · `paused`

Lower case, because `mail_automation_runs.status` already defaults to `'running'` and every other
queue here uses lower case. A column whose DEFAULT disagrees with every value written into it is a
trap for the next reader.

A run carries `automation_id`, `contact_id`, `id` (the run id), `node_id`, `status`, `started_at`,
`updated_at`, `completed_at`, `last_error`, `retry_count` — plus `error_kind`, `dead_letter`,
`wait_until`, `graph_version` and `trigger_event_id`.

**`completed` with `error_kind = 'business'` is not a failure.** "This candidate had unsubscribed" is
the system working; counting it red trains operators to ignore red.

---

## Failure handling

| Kind | Example | What happens |
| --- | --- | --- |
| temporary | `421 4.7.0 try again`, connection reset, 503 | retry with backoff: 1m, 2m, 4m, 8m, 16m, capped at 1h, up to 5 attempts, then dead-letter |
| permanent | `550 5.1.1 no such user`, missing template, unknown step kind | dead-letter immediately — five more identical failures, delayed, help nobody |
| business | not subscribed, suppressed, no deadline on the event, no contact | end the run, record why, **count nothing as an error** |

`retry_count` resets per step, not per run: five retries are five retries of *this* step, not a
budget the whole run exhausts on its third node.

---

## Triggers

The canvas offers its six original keys plus the fifteen the engine added. The six are **aliased**,
never renamed — automations already drawn against them keep working, and both spellings resolve to
one canonical dotted name:

| Canvas key | Canonical event |
| --- | --- |
| `application_stage_changed` | `application.stage.changed` |
| `contact_created` | `contact.created` |
| `tag_added` | `contact.tag.added` |
| `list_joined` | `contact.list.added` |
| `campaign_opened` | `email.opened` |
| `campaign_clicked` | `email.clicked` |

Added: `contact.updated`, `contact.tag.removed`, `campaign.sent`, `email.delivered`,
`email.bounced`, `email.unsubscribed`, `api.event`, `webhook.event`, `schedule.date`,
`application.submitted`, `assessment.assigned`, `assessment.completed`, `interview.scheduled`,
`internship.selected`, `internship.rejected`.

Any well-formed dotted lower-case name routes, declared or not — that is what "custom application
event" means. Free text (`"Stage Changed!!"`) is refused, because the log is queried by type and two
spellings would be two silently different triggers.

---

## Conditions

`equals` · `not_equals` · `contains` · `starts_with` · `ends_with` · `greater_than` · `less_than` ·
`exists` · `does_not_exist`, combined with `{and:[…]}`, `{or:[…]}`, `{not:…}`.

The canvas writes `{field, value}` over five familiar fields; the engine maps each onto a real path:

| Canvas field | Evaluated as |
| --- | --- |
| stage | `stage` — the event's value if it carries one, else the contact's |
| tag | `contact.tags`, by membership |
| status | `contact.status` |
| assessment completed | `contact.fields.assessment_completed` |
| custom field | `contact.fields.<key>` |

Two additions the canvas does not draw yet, accepted by both validators so nothing breaks:
`config.operator` (any of the nine) and `config.condition` (a whole AND/OR/NOT tree).

Decisions worth knowing:

- **False is the safe answer.** The `yes` branch usually sends something; a broken comparison
  therefore sends nothing rather than mailing people on the strength of a typo.
- A **missing field** is `false` for everything except `not_equals`, where it is genuinely `true` —
  that is what makes "assessment_completed is not true" match the candidate who never started.
- **Case-insensitive by default** (`caseSensitive: true` to opt out).
- `greater_than` compares numbers as numbers, then dates as dates, then text — so 9 is not greater
  than 10.
- An **empty AND is true, an empty OR is false**.
- The trace records **every** rule, not only up to the first failure, because the trace is what
  answers "why did this candidate go that way".

---

## Steps

`send_email` · `add_tag` · `remove_tag` · `update_contact` · `webhook`, plus the structural
`trigger` · `condition` · `delay` · `end`. These are the canvas's own kinds; the engine adds none,
because a kind the canvas cannot place is a step nobody can author.

`send_email` reads `email_templates` — the catalogue `/admin/mail/templates` and the campaign builder
already write — and fills `{{first_name}}` style fields per contact through `mail-personalize.ts`.
Use `{{name|default:fallback}}`; a bare `{{name|fallback}}` is not a token and goes out literally.

**Suppression and subscription status are enforced in the send path, not in the builder.** A person
who asked not to be mailed asked the platform, not one automation. `mail_suppression` is read through
`mailsec/sending.ts`, the one suppression reader the whole platform uses, and it **fails closed**.

**Not yet drawable:** "add to list" and "remove from list" are in the specification and the store
implements both against `mail_lists` / `mail_list_members`. They are not registered as node kinds
because the canvas cannot place a kind its own catalogue does not know — adding them is one entry in
`NODE_CATALOGUE` plus one handler. Stated rather than half-built.

### Channels

Email is built. SMS, push, WhatsApp and Slack are declared in `adapters/` and **refuse to send** with
a sentence naming the channel. Wiring one up is implementing `send()` and flipping `available()`;
nothing in the engine, the actions or the builder changes.

---

## Delays

`minutes` (what the canvas draws) · `until` (an absolute date) · `untilField` (a date carried by the
event, plus or minus an offset — this is how "wait until the deadline minus 24 hours" is written).
`mail-product/automations.ts` accepts all three, so Publish does not refuse the latter two.

A target already in the past resolves to **now** and fires immediately: a replayed or backfilled
event must finish, not strand a run in `waiting` for ever. A missing `untilField` value is a business
failure — the engine does not invent a deadline and mail somebody about it.

---

## Security

Four doors, all in `security.ts`:

1. **Admin API** — `denyMailApi()`, the same gate as `/api/mail/send`, then scoped to the
   organisation. Every automation and run query filters on `org_id`.
2. **Internal emit** — same gate; source recorded as `internal`.
3. **Webhook** — a per-automation token in the URL says *which automation*, an HMAC-SHA256 signature
   over `"<timestamp>.<body>"` proves the sender holds the secret, and a five-minute window stops
   replay. Fails closed, including when no secret is configured. The event type is **pinned to that
   automation's own trigger**, so a signed sender cannot start every other automation. Body capped at
   64 KB. The organisation comes from the automation row, never from the request.
4. **Outbound webhook** — https only, no credentials in the URL, no localhost / `.internal` / private
   ranges. Without it, anyone who can author an automation could make the server fetch an internal
   address and read the answer off the run page.

A chain of automations triggering one another is bounded at **5** links deep.

**Contacts are not org-scoped.** `mail_contacts` is mail-product's table and has no tenant column;
this platform runs one mail workspace. The automation and run tables do carry `org_id` so a second
workspace cannot read the first's automations.

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
  contact: { firstName: applicant.first_name },
  payload: { stage: '3', previous_stage: '2' },
  eventId: 'stage:' + applicant.id + ':3',   // stable = safe to retry
});
```

That is the entire integration surface. The contact is created on first sight (which is also how
`contact.created` fires). Nothing outside `src/lib/mailplatform/` should build a run, read the step
ledger, or decide whether a send is a duplicate.

---

## Running it

`/api/mail/automation/tick` is the worker: it emits due scheduled events, claims every run whose wait
has ended, and advances each one. Protected by `CRON_SECRET`, **failing closed** — with no secret set
nothing runs, visibly, rather than the URL standing open as an anonymous send button.

`vercel.json` calls it once a day (Hobby crons are daily-only on this project). **A 24-hour delay
resolved at 09:00 therefore fires on the next daily pass, not at 09:00 sharp.** For minute-level
timing, call the URL from any scheduler with the secret:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://www.edurankai.in/api/mail/automation/tick
```

A tick is bounded and reports `more_due` when it hit its limit. It never implies it drained the queue.

---

## The tables

`db/mail-automation-schema.sql` — **run it yourself**; CLAUDE.md forbids this repository's agents from
opening a database connection. `ensureAutomationSchema()` runs the identical statements on first use
if you would rather. **Run `db/mail-platform-schema.sql` first.**

```
psql "$DATABASE_URL" -f db/mail-automation-schema.sql
```

Owned by this engine: `mail_automation_events` · `mail_automation_steps` ·
`mail_automation_versions`.

Extended additively: `mail_automations` (+`org_id`, `version`, `webhook_token`, `webhook_secret`),
`mail_automation_runs` (+`org_id`, `graph_version`, `error_kind`, `retry_count`, `dead_letter`,
`completed_at`, `trigger_event_id`).

Visited, never redefined: `mail_contacts` · `mail_lists` · `mail_list_members` · `email_templates` ·
`mail_suppression`.

---

## The visual builder

`/mail/automations` is the canvas and stays the canvas. `GET /api/mail/automation/catalogue` adds
what only the runtime knows: every event type it can route, every operator it can evaluate, every
step it can perform, which channels actually work on this deployment, and — with `?id=` — one
automation's graph resolved with **both** validations plus its runs. No page hard-codes a shape.

`POST` there does the four things only the engine owns: install an example, snapshot a version,
check readiness, and turn the inbound webhook on or off. Creating, saving and publishing remain
`/api/mail/product/automations`.

---

## Testing

```
npx vitest run src/lib/mailplatform
```

`pure.test.ts` covers the graph adapter, the evaluator, the delay arithmetic, the classifier, the
canvas-key aliases and the HMAC — and asserts both shipped examples pass the **canvas's own**
validator, so they are graphs an operator could publish.

`engine.test.ts` covers what only appears over time and across processes: a delay that outlives its
worker, a **worker restart** (new engine objects over the same store), a **database restart** (the
whole store serialised to JSON and read back), a duplicate event, a crash between the send and the
record of it, retry-to-dead-letter, business-rule endings, suppression, a missing template,
cancellation, pause/resume, chained automations, and an edit while runs are in flight.

Both run against `MemoryStore`, which enforces the same atomicity rules as the Postgres store — the
behaviours being tested are about **ordering**, and ordering is what it reproduces. It is not a mock.

---

## Known limits, stated

- **A follow-on event can be lost.** If the process dies between recording a step and publishing the
  event that step emitted (`tag added`), the announcement is gone — an automation chained off it will
  not start. It is logged as an error with the run id, and the events that *should* have been emitted
  are recorded on the step.
- **A graph saved without a snapshot** (any writer that does not call `snapshotGraph`) leaves runs
  following the live graph. The engine says so on the run rather than guessing.
- **DNS is not resolved** by the outbound-URL guard, so a hostname that resolves to a private address
  at request time gets through. The remaining protection is that only operators holding `mail.manage`
  can author an automation, and every call is recorded on the step.
- **Cycles between two automations** are only caught by the depth limit at runtime. Cycles *within*
  one graph are refused by `validateGraph()` when they contain no delay.
- **Timing is as coarse as the tick.** See "Running it".
- **Scheduled triggers fan out 500 contacts per tick.** The rest follow on the next tick; the event
  ids are deterministic, so nobody is mailed twice and nobody is skipped.
