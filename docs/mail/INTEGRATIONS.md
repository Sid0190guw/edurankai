# EduRankAI Mail — the integration platform

How another system puts a fact into EduRankAI Mail, and what happens to it afterwards.

This is the layer that lets Careers, AquinTutor, Talent, the recruitment desk and the university
systems drive mail without any of them knowing how mail is sent — and lets a system with no
connector of its own be integrated with a shared secret and a mapping, no code.

---

## 1. The shape of it

```
  a product or an external system
            |
            v
   Authentication            API key -> organisation, environment, scopes   (src/lib/mailapi/keys.ts)
            |                for a third-party integration, an HMAC signature as well
            v
   Connector                 authenticate -> validate -> receive -> normalize -> emit
            |                                                       (src/lib/mailint/connector.ts)
            v
   Event router              validate against the catalogue -> DEDUPLICATE -> plan -> act
            |                                                       (src/lib/mailint/router.ts)
            v
   email   campaign   workflow   webhook   analytics
```

Two rules hold the whole thing up.

**A product states a fact, never an instruction.** `application.stage.changed` is a fact. "Send the
assessment invitation" is an instruction, and if products sent instructions then changing the
invitation would mean changing the product. Routes turn facts into instructions, and routes are rows
an operator edits.

**The organisation comes from the key.** No request body names its own tenant, anywhere in this
layer. That is what makes isolation structural instead of careful.

### Where the code lives

| Concern | Module |
| --- | --- |
| Event catalogue, matching, envelope, idempotency key | `src/lib/mailint/events.ts` (pure) |
| External shape -> canonical event | `src/lib/mailint/mapping.ts` (pure) |
| Route matching, redaction, fan-out planning | `src/lib/mailint/routing.ts` (pure) |
| Connector SDK, health states, the pipeline | `src/lib/mailint/connector.ts` (pure) |
| The connectors themselves, available and planned | `src/lib/mailint/connectors.ts` |
| Tenancy, credential lifetime, step retry | `src/lib/mailint/policy.ts` (pure) |
| The router at runtime, actions, scheduled steps | `src/lib/mailint/router.ts` |
| Integrations, mappings, health, the inbound path | `src/lib/mailint/integrations.ts` |
| The credential vault | `src/lib/mailint/credentials.ts` |
| Business events onto the webhook platform | `src/lib/mailint/fanout.ts` |
| One line a product writes | `src/lib/mailint/emit.ts` |
| Tables | `src/lib/mailint/schema.ts` (`mailint_*`) |

**What this layer deliberately does NOT own.** Webhook endpoints, secrets and rotation, signing,
delivery, the retry curve, the dead state, replay and the private-address refusal are all
`src/lib/mailapi/webhooks.ts`, which shipped with the transactional API. API keys, scopes, rate
limiting and the `/v1` route wrapper are `src/lib/mailapi/keys.ts`, `ratelimit.ts` and `route.ts`.
Contacts are `src/lib/mail-contacts.ts`. Nothing here re-implements any of it: a second retry curve
is not resilience, it is two answers to one question, and the one that gets fixed is never the one
that is running.

---

## 2. Publishing an event

```http
POST /api/v1/bus/events
Authorization: Bearer erm_live_...
Content-Type: application/json

{
  "type": "application.stage.changed",
  "source": "careers",
  "occurred_at": "2026-08-16T09:30:00Z",
  "event_id": "your-own-id-if-you-have-one",
  "data": {
    "application_id": "9f2c...",
    "stage": "assessment",
    "previous_stage": "review",
    "email": "candidate@example.com",
    "name": "Ravi K"
  }
}
```

```json
201 Created
{
  "object": "event", "id": "0f7a...", "type": "application.stage.changed",
  "duplicate": false,
  "actions": [
    { "route": "assessment invitation", "action": "email",   "status": "ok", "detail": "Sent to candidate@example.com via smtp." },
    { "route": "(subscriptions)",       "action": "webhook", "status": "ok", "detail": "queued for 2 endpoints" }
  ],
  "skipped": []
}
```

Scope: `events.write`. Every event type, its required fields and its allowed channels are readable
from `GET /api/v1/bus/catalog` — generated from the same constants the validator enforces, so what
the catalogue describes cannot be refused for a shape reason.

Inside this repository, a product writes one line instead:

```ts
import { emitProductEvent } from '@/lib/mailint/emit';

await emitProductEvent('careers', 'application.stage.changed', {
  application_id: id, stage: 'assessment', email: candidate.email,
}, { idempotencyKey: 'idem_stage_' + id + '_assessment' });
```

It never throws, it never blocks on delivery, and it decides the environment once — a preview
deployment publishes into `development`, where an email route renders and reports instead of
sending. Already wired at `advanceStage()` in `src/lib/application-stages.ts`, which is why moving a
candidate through the funnel now produces events.

---

## 3. Duplicates (section 9)

Duplicate events must not create duplicate emails. That is kept by the database, not by application
code: `mailint_events` has a unique index on `(org_id, environment, idempotency_key)` and the insert
is written to expect the refusal. A duplicate returns `200` with `"duplicate": true` and **causes
nothing** — no route runs, no webhook is queued, no mail is sent.

The key is derived in this order:

1. `idempotency_key` if you send one — always the best option, because you know what "the same
   thing" means in your system;
2. `event_id` if you send one — your retry carries the same id with a fresh timestamp, and the
   timestamp is deliberately excluded so the retry is recognised;
3. otherwise `(source, type, entity, occurred-at-the-second, payload)`.

The payload is in that last tuple because leaving it out was wrong, and a test caught it: an
application advanced twice inside one second — which a scripted bulk advance does routinely —
produced one key, and the second stage change would have been swallowed. See
`src/lib/mailint/events.test.ts`, "gives a different key to a different stage".

A duplicate is a **success**. Answering `409` would teach a well-behaved sender that its retry was a
mistake; answering `500` would make it retry again.

---

## 4. Receiving events from an external system

Create an integration (console: **Mail -> Integrations**, or `POST /api/v1/integrations`), store a
webhook secret against it, and point the sender at:

```
POST /api/v1/ingest/<integration-slug>
Authorization: Bearer <your API key>
Webhook-Id:        <their unique id for this delivery>
Webhook-Timestamp: <unix seconds>
Webhook-Signature: v1,<base64 HMAC-SHA256 of  id + "." + timestamp + "." + body>
```

The signature scheme is the platform's one scheme, shared with outgoing deliveries, so a partner
implements it once. Tolerance is 300 seconds. During a secret rotation both the current and previous
secret verify, so rotating is not a cutover.

### The status codes are instructions

| Code | Meaning to the sender |
| --- | --- |
| `200` | Published. |
| `202` | Accepted; some or all of it was not mapped. **Not an error — do not retry.** |
| `401` | Signature or key is wrong. Fix it; do not retry. |
| `422` | We understood the request and cannot use this payload. Do not retry. |
| `501` | This connector is planned, not implemented. |
| `503` | Our fault. Retry. |

The `202` matters more than it looks. An external system typically posts its entire event stream at
one URL. Refusing the part we have not mapped would fill *their* dead-letter queue with *our* errors
and make the integration look broken to its owner.

Every inbound call is recorded in `mailint_inbound` with the pipeline trace — which step failed and
why — whether or not it worked. "They say they are sending events" is then answerable with evidence
rather than argument.

---

## 5. Mapping: their shape into ours (section 8)

```
external:  { "event": "candidate.moved",
             "candidate": { "id": "c_9", "stage": 3, "email": "Ravi.K@Example.com" } }
   |  mapping
   v
canonical: application.stage.changed { application_id: "c_9", stage: "assessment", email: "ravi.k@example.com" }
   |  route
   v
the stage-3 workflow sends the assessment invitation
```

A mapping is data, not code: match rules that decide whether it applies, a canonical type (fixed or
looked up from a field), and field rules with paths, transforms and value maps. The transform list is
closed on purpose — an "evaluate this expression" step would make a mapping row a code-execution
surface for anyone who can edit an integration.

Test one against a captured payload without publishing anything:

```http
POST /api/v1/integrations/:id/mappings
{ "action": "test", "payload": { ...the exact body they sent... } }
```

It returns the canonical event it would produce and a field-by-field trace, including the reason for
anything that dropped out. An integration built this way is an integration built without sending
anybody a test email. The console has the same thing behind a button.

Mappings are validated when they are **saved**, so a typo in a path is caught once rather than once
per inbound webhook at three in the morning.

---

## 6. Routes: what a fact causes

A route is `pattern -> channel + config`. Patterns: `application.created` exact, `application.*`
everything about applications however deep, `*.completed` one segment, `*` everything.

| Channel | What it does |
| --- | --- |
| `email` | Renders a template (or inline subject + html) with the payload as merge fields and sends it. In a non-production environment it renders and reports; it does not send. |
| `campaign` | Adds the person to the audience and tags them — through `mail-contacts.ts`, so suppression and consent rules apply. It never starts a broadcast: a misconfigured route must not be able to mail an entire list. |
| `workflow` | An ordered sequence of steps, each with `delayMinutes`. Step 0 runs inline; later steps land in `mailint_scheduled_actions` and run on the dispatcher. |
| `webhook` | Queues for every subscribed endpoint. Endpoints do not need a route — they subscribe directly. |
| `analytics` | Records the metric and its dimensions against the event. |

An event may only drive the channels its catalogue entry allows, which is what stops "send an email
on `message.delivered`" — a rule that would mail a candidate every time a server acknowledged a byte.

### Redaction

`candidate.rejected` carries a written reason; `assessment.completed` carries a score. Those reach
the **email** (the message to the person) and the **workflow** (the thing deciding what to say). They
are removed before a webhook endpoint, a campaign or analytics sees them, and the removal is declared
in the payload as `redacted: ["reason"]` so a consumer knows a field was withheld rather than absent.

An endpoint can be granted the full payload — one tick in the console, recorded per endpoint. It is
never a default.

---

## 7. Webhooks out, and the test console

Console: **Mail -> Webhooks**. Register an endpoint, choose events from both vocabularies (business
events and delivery events), send it a real signed test event, and read the exact request and
response. The test uses the production signer, the production delivery table and the production
dispatcher — a console that exercised a different path would prove nothing about the path that
matters.

Verifying a delivery, in five steps:

1. Read `Webhook-Id`, `Webhook-Timestamp` and `Webhook-Signature`.
2. Refuse anything more than 300 seconds from your own clock.
3. Build `id + "." + timestamp + "." + the exact bytes you received`.
4. HMAC-SHA256 with your endpoint secret, base64, prefixed `v1,`.
5. Compare constant-time against each space-separated value in the header. During a rotation there
   will be two; any match is a pass.

Retry, dead-letter and replay are the shipped platform's: attempts back off 5s, 30s, 2m, 10m, 30m,
2h, 6h, capped at 12h; `410 Gone` stops immediately; an endpoint that fails 20 times running is
disabled with the reason recorded. A dead delivery is replayable from the console with its original
payload and event id, so a receiver that de-duplicates on `Webhook-Id` is unharmed by the replay.

---

## 8. Credentials (section 6)

Stored AES-256-GCM encrypted, with the key in the environment and never in the database. Set:

```
MAILINT_VAULT_KEY=<32 random bytes, hex or base64>
MAILINT_VAULT_KEY_PREVIOUS=<the old one, during a master-key rotation>
```

Without it, storing a credential is **refused** with the variable named — rather than storing
something the platform cannot protect, or storing nothing and reporting success. The integrations
console shows the vault's state at the top of the page for the same reason.

No endpoint returns a stored secret. What comes back is the kind, a label, the last four characters,
a truncated fingerprint, the expiry and the state — enough to answer "is the value I gave the partner
the one you hold?" without either side quoting it. Rotation keeps the old value working for an
overlap window (default 24 hours), so the system on the other side deploys when it suits them.

---

## 9. Health (section 12)

Five states, decided by one pure function so the console chip, the API and the stored status cannot
disagree:

| State | Means |
| --- | --- |
| `connected` | Credentials in place, nothing failing. The detail line distinguishes "no event yet" from "last event four minutes ago". |
| `degraded` | Recent failures, or a credential expiring within a week, or a heartbeat integration gone quiet. Still working. |
| `failed` | Five consecutive failures, or a required credential was never stored. |
| `expired` | A required credential has expired or been revoked. Beats `failed`, because it explains the failures and names the fix. |
| `disabled` | Switched off. Beats everything — a switched-off integration is not failing, and paging somebody about it is how alerts get muted. |

`GET /api/v1/integrations/:id/health` returns the state, the reason, the recent history and the last
ten inbound calls.

---

## 10. Import and export (section 7)

| Route | Notes |
| --- | --- |
| `POST /api/v1/contacts/import` | `csv` string or `contacts` array. `dry_run` defaults to **true**: there is no undo on a contact book. Returns the column mapping, invalid rows with line numbers, and in-file duplicates. |
| `GET /api/v1/contacts/export?format=csv\|json` | Same rows, same filter, two shapes. |

Both go through the existing planner and committer, so the API obeys the same rules as the admin
screen: an existing contact keeps every value it has and the import only fills blanks, and **a
suppressed address is imported but never re-subscribed** — counted separately so a caller can see how
many of their rows will not be mailed.

---

## 11. Connectors

Available today — the five products the brief names, plus one that needs no code:

`careers` · `aquintutor` · `talent` · `recruitment` · `university` · `external-webhook`

The first five accept their product's own shape or a pre-canonical envelope
(`{ "type": ..., "data": ... }`), so a product can adopt the vocabulary incrementally rather than in
one change. `external-webhook` accepts any JSON from any system, authenticated by signature and
translated by mapping rows — which is the actual test of whether an integration platform is a
platform.

Planned, registered, and honestly unimplemented: Slack, Microsoft Teams, Google Workspace, CRM, ATS,
university SIS, government portals, ERP. Each carries a sentence naming the real obstacle (a
distribution review, an OAuth verification that takes weeks and a refresh token revoked after seven
idle days, a partner that exports overnight files rather than webhooks, an approval rather than a
technical gap). They refuse every step with `not_implemented` and have no connect button. "Coming
soon" on a screen becomes a commitment somebody plans around.

Writing a new connector means implementing six methods against a context holding three capabilities:
read *my* credentials, publish for *my* organisation, see *my* mappings. It cannot reach a database,
a transport or another integration's secrets, which is what makes the whole set testable without a
connection.

---

## 12. Running it

One cron does both queues:

```
GET /api/cron/mailint-dispatch     Authorization: Bearer $CRON_SECRET
```

Registered in `vercel.json` at 07:45 UTC. It dispatches due webhook deliveries and due delayed
workflow steps. Hobby cron schedules are daily-only on this account, so **for anything more
responsive than once a day, call this endpoint from an external scheduler** — every minute is fine,
it claims with `FOR UPDATE SKIP LOCKED` and two runners cannot take the same row. The event-bus
console has a "Run dispatcher now" button that calls the same endpoint with an administrator's
session.

It answers `ok: false` when either half **failed**, not when either half had nothing to do. A green
result over a broken queue is the failure this project keeps writing down.

---

## 13. Screens

| URL | What it is for |
| --- | --- |
| `/admin/mail/integrations` | Connect a system, store and rotate credentials, read health, see every inbound call, and the planned connectors with their blockers. |
| `/admin/mail/webhooks` | The developer console: register an endpoint, send a real signed test event, read the request and response, retry a failed delivery, rotate the secret. |
| `/admin/mail/event-bus` | The event stream with what each event caused (including the routes that matched and were held back, and why), the routes editor, dead letters and owed work. |

---

## 14. Tests

`npx vitest run src/lib/mailint/` — 112 assertions across four suites, all pure, no database:

- **events** — catalogue integrity, pattern matching including the trailing-star rule, validation
  refusals, and the idempotency key (same fact -> same key; different stage, different application or
  different source -> different key; sender's own id -> timestamp ignored).
- **mapping** — the brief's worked example end to end, path extraction, transforms, match rules, and
  the failure modes: missing required field, unknown value-map entry, optional field dropped rather
  than event lost, unmapped payload skipped rather than refused.
- **routing** — tenant isolation (route and endpoint), environment isolation, redaction per channel
  and per grant, channel refusal, conditions, `stopOnMatch` scoping.
- **connector** — the five health states and their precedence, credential lifetime, signature accept
  and the four refusals (altered body, wrong secret, stale timestamp, missing headers), rotation
  window, a throwing connector becoming a clean failed step, duplicate counted as duplicate, partial
  publish reported with its successes, and every planned connector refusing.

Rate limiting, API-key authentication and webhook delivery/backoff are covered by the transactional
API layer's own suites (`src/lib/mailapi/keys.test.ts`, `webhooks.test.ts`), which is where that code
lives.

---

## 15. What is not built

Stated plainly, because a gap somebody discovers is worse than a gap somebody was told about.

- **The workflow channel is a delayed email sequence, not an automation engine.** No branches, no
  wait-for-another-event, no loops. What it has instead is that every step is a row you can see, with
  the event that caused it, when it will run and why the last attempt failed.
- **Outbound connectors do not exist.** Every available connector is inbound. Delivering an event
  *to* Slack or a CRM is the `consumes` half of the metadata and has no implementation behind it.
- **Contacts are not scoped per organisation.** `mail_contacts` predates organisations and is a
  single deployment-wide book; the import/export API stamps the calling organisation as the source
  but does not partition. Every other resource in this layer — events, integrations, credentials,
  routes, mappings, endpoints — is isolated per organisation and per environment, and that isolation
  is asserted in the tests.
- **Health is computed from stored counters, not by calling out.** A page load must not depend on
  somebody else's server answering. An integration that is up but has never been used reads
  `connected, no event yet`, which is the truth.
- **The analytics channel records; it does not aggregate.** `mailint_events` is the metrics store —
  one append-only row per fact with a wide jsonb payload, the shape a column store ingests without
  remodelling. Dashboards over it are not built.
