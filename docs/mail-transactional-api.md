# EduRankAI Mail — Transactional API

The common sending infrastructure for every EduRankAI product: application confirmations, internship
stage notifications, assessment instructions, interview invitations, selection and rejection letters,
password resets, account verification, invoices, system notifications, and university and project
communications.

- Base URL — `https://www.edurankai.in`
- Console — `/admin/mail/api` (keys, organizations, send log), `/admin/mail/webhooks` (endpoints, deliveries, dead letters)
- Public reference — `/developers/mail`
- Payload version — `2026-08-16`

---

## 1. Where this sits

| Layer | Module | What it owns |
|---|---|---|
| SMTP transport | `src/lib/mail-transport.ts` | The connection to our own mail server. No third-party HTTP API. |
| Mailbox / webmail | `src/lib/mail.ts`, `mail-advanced.ts` | Human mailboxes, threads, folders, the composer. |
| Campaigns and automation | `src/lib/mailplatform/*` | Contacts, lists, campaigns, workflows, sending domains. |
| **Transactional developer API** | **`src/lib/mailapi/*`** | **This document: keys, templates, idempotency, messages, events, webhooks.** |

This layer **consumes** the SMTP transport rather than reimplementing it, and shares two things with
the campaign platform on purpose (see `src/lib/mailapi/bridge.ts`):

- **Organizations.** Every transactional organization is linked by slug to its `mp_organizations`
  row, so both consoles mean the same thing by "AquinTutor".
- **Suppression.** A send checks the transactional list *and* `mp_suppression_entries`. A candidate
  who unsubscribed from a campaign is not mailed by a stage-update. The read fails open and logs, so
  a schema fault in the campaign workstream cannot block a password reset.

---

## 2. Authentication

```
Authorization: Bearer erm_live_xxxxxxxx…
```

or `x-api-key: erm_live_…`. A key is **never** accepted from the query string — a secret in a URL
ends up in access logs, proxies and browser history.

### Environments

The environment is part of the key string and part of its record, and both must agree:

| Prefix | Environment |
|---|---|
| `erm_dev_…` | development |
| `erm_stg_…` | staging |
| `erm_live_…` | production |

Every query is scoped by organization **and** environment. A development key cannot read, edit or
send a production template, message or webhook endpoint. Promote a template between environments with
`POST /api/v1/templates/:id/copy`.

### Scopes

`email.send` · `email.read` · `templates.read` · `templates.write` · `events.read` · `domains.read` ·
`domains.write`

A grant may use a namespace wildcard (`email.*`) or `*`. `email.*` does **not** imply
`templates.read` — a prefix wildcard stops at its own namespace.

### Key lifecycle

Create, view metadata, rotate and revoke from `/admin/mail/api`. The secret is shown once, on
creation; only a sha256 is stored, so nothing can show it again. **Rotation keeps the old key alive
for a grace period** (default 60 minutes) so deploying the new value is not a race.

---

## 3. Send

### `POST /api/v1/email/send` — scope `email.send`

```bash
curl -X POST https://www.edurankai.in/api/v1/email/send \
  -H "Authorization: Bearer erm_live_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8f14e45f-ceea-467a-9f0b-1c2d3e4f5a6b" \
  -d '{
    "from": "talent@edurankai.in",
    "to": ["candidate@example.com"],
    "template_id": "internship-stage-update",
    "variables": {
      "candidate_name": "Candidate",
      "stage": 3,
      "role": "AI Engineering Intern",
      "next_stage": "Technical assessment",
      "deadline": "22 August 2026"
    },
    "metadata": { "application_id": "app_01H8…" },
    "tags": ["careers", "stage-3"]
  }'
```

| Field | Type | Notes |
|---|---|---|
| `from` | string | `addr@domain` or `Name <addr@domain>`. May be rewritten — see below. |
| `to`, `cc`, `bcc` | string \| string[] | 50 recipients total across all three. |
| `reply_to` | string | |
| `subject` | string | Required for an inline body; optional override for a template. |
| `text`, `html` | string | An inline body. Mutually exclusive with `template_id`. |
| `template_id` | string | Template id **or** key. |
| `template_version` | integer | Defaults to the published version. |
| `variables` / `template_variables` | object | Two names for one field. Sending both with different values is an error. |
| `attachments` | array | `{ "url": "...", "filename": "..." }` — **links only**, see §4. |
| `metadata` | object | ≤30 keys, ≤8 KB. Returned on every webhook. Filterable. |
| `tags` | string[] | ≤10. |
| `headers` | object | `X-` prefixed, plus `References`, `In-Reply-To`, `Importance`, `X-Priority`, `Auto-Submitted`. |
| `idempotency_key` | string | Or the `Idempotency-Key` header, which wins. |
| `scheduled_at` | ISO 8601 | Future, at most 90 days ahead. |
| `options` | object | `allow_draft`, `track_opens`, `track_clicks`, `include_unsubscribe`, `skip_suppression`. |

Response `202`:

```json
{
  "id": "4f1c4a2e-0e1b-4a5d-9f3e-2b6c8d0a1e5f",
  "object": "message",
  "status": "sent",
  "environment": "production",
  "to": ["candidate@example.com"],
  "subject": "AI Engineering Intern — stage 3",
  "template": { "key": "internship-stage-update", "version": 4, "state": "published" },
  "metadata": { "application_id": "app_01H8…" },
  "queued_at": "2026-08-16T12:00:00.000Z",
  "sent_at": "2026-08-16T12:00:01.480Z"
}
```

### Things this endpoint tells you rather than hiding

- **`from` may be rewritten.** The mail server rejects or spam-folders a `From` that does not match
  the account it authenticates as, so `sendExternal()` normalises it and moves your address to
  `Reply-To`. When that happens the response carries a `warnings` entry naming the substitution.
- **`warnings`** also reports suppressed recipients that were skipped, a draft template used under
  `allow_draft`, tracking that was requested but is unavailable, and a first attempt that was
  deferred.
- **A missing template variable is a 422, not a blank.** `Dear ,` in a candidate's inbox cannot be
  recalled; a refusal can be fixed.

---

## 4. Attachments are links

EduRankAI Mail does not accept uploaded file content. This is a platform rule, not an API limitation:
documents of any kind travel as a shared link, and the only stored upload anywhere in the product is
a small profile photo.

```json
"attachments": [
  { "filename": "Offer letter.pdf", "url": "https://drive.example/file/d/…/view" }
]
```

An entry carrying `content`, `data` or `path` is refused with `attachment_not_a_link` and an
explanation. Links are rendered as a "Linked documents" block in both the HTML and text parts. Set
the link's sharing to *anyone with the link* or the recipient cannot open it.

---

## 5. Templates

| Method | Path | Scope |
|---|---|---|
| `GET` | `/api/v1/templates` | `templates.read` |
| `POST` | `/api/v1/templates` | `templates.write` |
| `GET` | `/api/v1/templates/:id` | `templates.read` |
| `PATCH` | `/api/v1/templates/:id` | `templates.write` |
| `DELETE` | `/api/v1/templates/:id` | `templates.write` (archives) |
| `POST` | `/api/v1/templates/:id/publish` | `templates.write` |
| `POST` | `/api/v1/templates/:id/preview` | `templates.read` |
| `POST` | `/api/v1/templates/:id/copy` | `templates.write` |

`:id` accepts the uuid or the key.

A template is a **name**; its content is always a **version**. Editing produces a new draft version;
publishing moves the pointer and archives the previously published one, so exactly one version is
published at a time. `mailapi_messages` records the version it rendered from, which is what makes
"what exactly did we send this candidate in March?" answerable.

**Production refuses drafts.** A production key sending against an unpublished version gets `422
template_not_published`, unless the request sets `options.allow_draft`, which is recorded on the
message and in the `email.queued` event.

`DELETE` archives rather than dropping rows: messages point at their template, and an audit that
cannot resolve the template a letter came from is not an audit.

### Template syntax

```
{{ candidate_name }}                     substitute (HTML-escaped in a body, raw in a subject)
{{{ pre_rendered_block }}}               substitute without escaping — you vouch for it
{{ role.title }}                         dotted path
{{#if deadline}} … {{else}} … {{/if}}
{{#unless paid}} … {{/unless}}
{{#each steps}}{{@number}}. {{title}}{{/each}}      also {{this}}, {{@index}}
```

Nothing is compiled to JavaScript. A mail body is attacker-adjacent input and template engines that
compile have a long history of turning a content edit into remote code execution.

`GET /api/v1/templates/:id` returns each version's `variables`, derived from the body rather than
declared, so the list cannot drift from the template. A name used inside `{{#each steps}}` is
reported as `steps[].title`, because you cannot supply `title` at the top level.

---

## 6. Idempotency

Send an `Idempotency-Key` (8–255 printable ASCII, one per logical send — a UUID is ideal).

| Situation | Result |
|---|---|
| Key never seen | Proceeds. |
| Same key, **same** request | Replays the original response byte for byte, with `Idempotent-Replayed: true`. |
| Same key, **different** request | `409 idempotency_key_reused`. |
| Same key, first call still running | `409 idempotency_in_progress` — retry shortly. |

The hash is over the request's *meaning*: object keys are sorted before hashing, so a client whose
JSON serialiser reorders fields is not accused of changing the request. Array order **is** meaning —
two recipients in a different order is a different message.

A request that fails validation **releases** its key, so the corrected retry is not refused as a
conflict. Records expire after 24 hours.

---

## 7. Messages and status

| Method | Path | Scope |
|---|---|---|
| `GET` | `/api/v1/messages` | `email.read` |
| `GET` | `/api/v1/messages/:id` | `email.read` |
| `GET` | `/api/v1/messages/:id/status` | `email.read` (+ `events.read` for events) |
| `DELETE` | `/api/v1/messages/:id` | `email.send` — cancels a scheduled send |
| `GET` | `/api/v1/events` | `events.read` |

Statuses: `queued` · `processing` · `sent` · `delivered` · `deferred` · `bounced` · `failed` ·
`cancelled`.

Status is **derived from events and only ever moves forward**, so a late `sent` callback cannot undo
a `bounced`.

`bcc` is not returned by default — a status URL gets pasted into tickets and chat. Use
`?include_bcc=true`.

### Correlation

```
GET /api/v1/messages?metadata_key=application_id&metadata_value=app_01H8…
```

This is the join from an EduRankAI application to its email, its delivery and the recipient's
events, without any product keeping its own copy of our message ids. Also filterable by `status`,
`tag`, `recipient`, and paginated with `before` + `limit`.

---

## 8. Webhooks

| Method | Path | Scope |
|---|---|---|
| `GET`/`POST` | `/api/v1/webhooks` | `events.read` (+ `email.send` to create) |
| `GET`/`PATCH`/`DELETE` | `/api/v1/webhooks/:id` | as above |
| `POST` | `/api/v1/webhooks/:id/rotate` | `events.read` + `email.send` |
| `POST` | `/api/v1/webhooks/:id/test` | `events.read` |
| `GET`/`POST` | `/api/v1/webhooks/:id/deliveries` | `events.read` (+ `email.send` to replay) |

### Events

`email.queued` · `email.sent` · `email.delivered` · `email.deferred` · `email.bounced` ·
`email.failed` · `email.opened` · `email.clicked` · `email.unsubscribed` · `email.complained`

An endpoint with an **empty** `events` list receives everything, including types added later.

### Payload

```json
{
  "id": "evt_9f0b1c2d3e4f5a6b7c8d9e0f",
  "type": "email.sent",
  "api_version": "2026-08-16",
  "created_at": "2026-08-16T12:00:01.480Z",
  "environment": "production",
  "organization": "careers",
  "data": {
    "message_id": "4f1c4a2e-0e1b-4a5d-9f3e-2b6c8d0a1e5f",
    "status": "sent",
    "subject": "AI Engineering Intern — stage 3",
    "from": "talent@edurankai.in",
    "to": ["candidate@example.com"],
    "recipient": "candidate@example.com",
    "template": { "key": "internship-stage-update", "version": 4 },
    "tags": ["careers", "stage-3"],
    "metadata": { "application_id": "app_01H8…" }
  }
}
```

### Headers

```
Webhook-Id: <delivery uuid>
Webhook-Timestamp: <unix seconds>
Webhook-Signature: v1,<base64 hmac> [v1,<base64 hmac during rotation>]
X-EduRankAI-Event: email.sent
X-EduRankAI-Payload-Version: 2026-08-16
X-EduRankAI-Attempt: 1
```

### Verifying

Signed content is exactly:

```
{Webhook-Id}.{Webhook-Timestamp}.{raw request body}
```

HMAC-SHA256 with your endpoint secret, base64, prefixed `v1,`. During a rotation the header carries
several space-separated signatures; **any** match is valid.

```ts
import { verifyWebhookSignature } from '@edurankai/mail';

const raw = await readRawBody(req);            // the exact bytes, not a re-serialised object
const result = verifyWebhookSignature({
  secret: process.env.EDURANKAI_WEBHOOK_SECRET!,
  id: req.headers['webhook-id'] as string,
  timestamp: req.headers['webhook-timestamp'] as string,
  signature: req.headers['webhook-signature'] as string,
  body: raw,
});
if (!result.ok) return res.status(400).end();
```

**Three rules for a receiver:**

1. Verify against the **raw** body. Re-serialising an object changes the bytes and the signature
   will not match.
2. Reject anything outside a 300-second timestamp tolerance (the verifier does this).
3. **Dedupe on `Webhook-Id`.** A signature proves authenticity, not freshness. A retry of a genuine
   delivery reuses its id, so "have I processed this id?" is the complete answer — and it is what
   makes replaying the dead-letter queue safe.

### Retries, disablement and the dead-letter queue

Attempt 1 fires immediately, then 5s, 30s, 2m, 10m, 30m, 2h, 6h, 12h — eight retries spanning more
than half a day. A `2xx` is success; `410 Gone` stops permanently; a redirect is treated as a
misconfiguration and never followed (a signed payload carrying recipient addresses must not reach a
host you did not register).

Twenty consecutive failures disables the endpoint with the reason recorded. Exhausted deliveries move
to `dead` and are listed at `/admin/mail/webhooks` and via `GET /api/v1/webhooks/:id/deliveries`;
replaying keeps the original payload and `Webhook-Id`.

### Rotation

`POST /api/v1/webhooks/:id/rotate` returns a new secret and keeps the old one signing alongside it
for `overlap_minutes` (default 1440, max 20160). Pass `0` for an immediate cut when a secret is known
to be compromised.

### Endpoint verification

A new endpoint is `pending_verification` until it answers a signed POST with a 2xx — either the
verification event sent at registration, or the first real event. `POST /api/v1/webhooks/:id/test`
sends that same signed request, so a green test means real events will be accepted.

---

## 9. Rate limits

Counted across five dimensions — organization, API key, IP, endpoint per key, and sending identity —
because a single per-key limit protects nothing: a leaked key can be replaced by a second key on the
same organization, and a runaway staging script can spend the whole organization's budget.

Every response carries:

```
RateLimit-Limit: 300
RateLimit-Remaining: 297
RateLimit-Reset: 43
```

and, on a `429`, `Retry-After`. Which dimension bound the request is not disclosed.

Defaults per minute: organization 600, key 300, IP 300, endpoint 240, sending identity 200. A key can
carry its own limit. If the counters cannot be read the request is **allowed** and the degradation is
logged — a rate limiter that fails closed turns a slow database into a total sending outage.

---

## 10. Suppression

`GET`/`POST`/`DELETE` `/api/v1/suppressions` — reasons `bounce`, `complaint`, `unsubscribe`,
`manual`.

Enforced at send time, before the transport, per organization and per environment, and checked
against the campaign platform's list as well. Nothing expires on its own.

`options.skip_suppression` can retry an address that **hard bounced** — mailboxes get emptied. It
cannot override an unsubscribe or a complaint. A person who asked us to stop is not a delivery
problem to route around.

Set `options.include_unsubscribe` to add a signed one-click footer and the RFC 8058
`List-Unsubscribe` / `List-Unsubscribe-Post` headers. `GET` on that link renders a confirmation page;
only `POST` unsubscribes, because mail clients and scanners fetch every URL in a message.

---

## 11. Sending domains

`GET`/`POST`/`DELETE` `/api/v1/domains` — scopes `domains.read` / `domains.write`.

Each of SPF, DKIM, DMARC and MX reports whether the check **ran** (`checked`) separately from what it
found (`ok`). A `null` means "could not be checked", never "missing". This distinction matters here
more than anywhere: the documented fix for a missing SPF record is to add one, and a domain that
gains a *second* SPF record is treated by every large provider as a permanent SPF failure — so a
resolver timeout rendered as "no SPF record" could talk an operator into breaking company mail.

Registering a domain records the intent and reports DNS state. It does not reconfigure the transport;
that is `/admin/mail/settings`.

---

## 12. Errors

```json
{
  "error": {
    "type": "template_variable_missing",
    "message": "Template `internship-stage-update` needs variables that were not supplied: deadline.",
    "param": "variables",
    "doc_url": "https://www.edurankai.in/developers/mail",
    "request_id": "req_m9x1k2p4"
  },
  "missing_variables": ["deadline"]
}
```

| Code | Status |
|---|---|
| `invalid_request`, `invalid_json` | 400 |
| `missing_api_key`, `invalid_api_key`, `expired_api_key`, `revoked_api_key` | 401 |
| `insufficient_scope`, `environment_mismatch`, `organization_inactive` | 403 |
| `not_found`, `template_not_found`, `message_not_found`, `webhook_not_found` | 404 |
| `idempotency_key_reused`, `idempotency_in_progress` | 409 |
| `payload_too_large` | 413 |
| `template_not_published`, `template_variable_missing`, `all_recipients_suppressed`, `attachment_not_a_link` | 422 |
| `rate_limit_exceeded` | 429 |
| `internal_error` | 500 |
| `no_transport` | 503 |

`request_id` appears in the body and in the `X-Request-Id` header, and is the line to quote when
asking about a specific failed call. SQL, stack traces and connection strings never reach a caller.

---

## 13. Delivery-event ingest (internal)

`POST /api/v1/email/events/ingest`, authorised by `MAILAPI_INGEST_SECRET` (falling back to
`CRON_SECRET`) or an admin session — **never** an API key, because a customer must not be able to
declare their own mail delivered.

This is the seam between workstreams. The transactional platform owns the event model, the status
machine and the webhook fan-out; it does not own the SMTP conversation or the bounce mailbox.

**Stated plainly:** `queued`, `sent`, `failed` and `deferred` come from our own send path and are
real today. `opened`, `clicked` and `unsubscribed` come from the tracking endpoints when a send opts
into them. **`delivered` and `complained` have no producer yet** — they need DSN success parsing and
a provider feedback loop on the inbound side. Until the SMTP workstream posts them here, no message
reaches the `delivered` status. Documenting a webhook that can never fire would be worse than saying
so.

---

## 14. Scheduling and the worker

`POST /api/v1/email/dispatch` (`?key=$CRON_SECRET`, or an admin session) drains due scheduled sends,
deferred retries, messages a dying process left claimed, pending webhook deliveries, and expired
idempotency and rate-limit rows.

An ordinary send **does not depend on it** — the message reaches SMTP inside the request and the
response carries the real outcome. Vercel's Hobby plan allows a cron only once per day, which is
enough for housekeeping and useless for a deferred retry, so **point an external scheduler at this
endpoint every minute or two.** Until you do, `scheduled_at` and retries will be late. That is a
deployment fact, not a design preference.

---

## 15. Environment variables

| Variable | Effect if unset |
|---|---|
| `MAILAPI_TRACK_SECRET` (or `SESSION_SECRET`) | Open/click tracking and unsubscribe links are **off**. Nothing unsigned is emitted, and the send response says so. |
| `CRON_SECRET` | The dispatcher is admin-only. |
| `MAILAPI_INGEST_SECRET` | Falls back to `CRON_SECRET`. |
| `MAILAPI_BASE_URL` | Falls back to `PUBLIC_SITE_URL`, then `SITE.url`. |
| `MAILAPI_DEFAULT_FROM` | Falls back to the configured mail-server `from_address`. |
| `MAILAPI_LIMIT_ORG` / `_KEY` / `_IP` / `_ENDPOINT` / `_IDENTITY` | Defaults in §9. |
| `MAILAPI_ALLOW_INSECURE_WEBHOOKS` | `https` is required for webhook endpoints. |

---

## 16. Tests

`npx vitest run src/lib/mailapi` — 112 assertions covering scopes and wildcards, key format and
environment separation, rate-limit window arithmetic and boundaries, error-code mapping, oversized
and misdeclared payloads, template rendering and every block form, missing-variable reporting,
template syntax errors, recipient validation and header injection, the link-only attachment rule,
header allowlisting, schedule bounds, idempotency's four outcomes and stable hashing, webhook signing
and verification including rotation and replay windows, backoff and dead-letter classification,
private-address rejection for endpoint URLs, the status machine's forward-only transitions, SMTP
retry classification, `bcc` and body redaction, and tracking link signing and rewriting.

Run the whole suite with `npm test`.
