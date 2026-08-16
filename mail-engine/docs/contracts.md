# The contract between the mail engine and the application

The engine owns SMTP, the queue, retries and bounce classification. Patch 1 owns the database. This
document is the seam, written so the receiving side can be built against a specification rather than
against a reading of the engine's source.

Everything crosses as JSON over HTTP. The engine never opens a database connection.

---

## Authentication

Every request in both directions carries two headers:

```
x-mail-engine-timestamp: 1755331200000          # epoch milliseconds
x-mail-engine-signature: 9f2c…                  # hex HMAC-SHA256
```

The signature is:

```
HMAC-SHA256(MAIL_APP_SHARED_SECRET, "<timestamp>" + "." + "<raw request body>")
```

over the **raw body bytes**, before any parsing. Verify with a constant-time compare, and reject a
timestamp more than five minutes from now.

Why not a bearer token: a token in a header is replayable by anything that captures one request. This
covers the timestamp and the body, so a captured request can be neither modified nor replayed. Both
sides already share a secret, so this costs one hash.

The reference implementation of both halves is one function —
`signBody()` / `verifySignature()` in `mail-engine/src/publish/http.ts` — imported by the application
routes so there is only one thing to get right.

---

## Engine → application

### `POST /api/mail/engine/events`

```jsonc
{
  "events": [
    {
      "eventId": "0f9a1c3e-…",         // idempotency key — UPSERT on this
      "occurredAt": "2026-08-16T10:14:02.881Z",
      "kind": "delivered",
      "stage": "smtp",
      "messageId": "8b2d…",            // the engine's id for the message
      "rfcMessageId": "<8b2d…@mail.edurankai.in>",
      "from": "noreply@edurankai.in",  // envelope sender
      "recipient": "learner@example.com",
      "recipientDomain": "example.com",
      "attempt": 1,                    // 1-based; 0 before any delivery attempt
      "smtpCode": 250,
      "enhancedCode": "2.0.0",         // RFC 3463
      "smtpResponse": "250 2.0.0 Ok: queued as 3F2A1",
      "mxHost": "mx.example.com",
      "tls": true,
      "dkimSigned": true,
      "latencyMs": 412,
      "bounceClass": null,
      "reason": null,
      "nextAttemptAt": null            // set only when kind is "deferred"
    }
  ]
}
```

**One event per recipient.** A message to five people produces five of everything.

Every field is always present; fields that do not apply are `null` rather than absent, so a consumer
can be written against `event.smtpCode ?? null` instead of `'smtpCode' in event`.

#### `kind`

| kind | when |
|---|---|
| `accepted` | passed validation, about to be queued |
| `rejected` | refused before ever being queued (bad address, suppressed, oversized, header injection) |
| `queued` | written to the durable spool |
| `attempting` | a delivery attempt is starting |
| `delivered` | 2xx from the receiving server |
| `deferred` | 4xx — will be retried; `nextAttemptAt` says when |
| `bounced` | 5xx — will not be retried |
| `dead_lettered` | retries exhausted; moved out of the active queue and kept |
| `suppressed` | the recipient was added to the suppression list as a result |
| `inbound_received` / `inbound_accepted` / `inbound_rejected` / `inbound_delivered` | the receiving side |

#### `stage`

`validation`, `suppression`, `queue`, `mx_lookup`, `connection`, `tls`, `dkim`, `smtp`, `inbound`.

#### `bounceClass`

A closed set, because the suppression decision is made from it: `hard`, `soft`, `invalid_mailbox`,
`invalid_domain`, `mailbox_full`, `temporary_rejection`, `rate_limited`, `policy_rejection`,
`spam_rejection`, `connection_failure`, `content_rejection`, `unknown`.

#### Responses the engine understands

| Status | Engine behaviour |
|---|---|
| `2xx` | events acknowledged and deleted from the outbox |
| `400` | **permanent** — the batch is moved to `rejected/` and kept, never retried |
| `408`, `429`, `5xx` | held in the durable outbox and retried indefinitely, in order |
| network failure | same as 5xx |

`503` with `{"error":"contract_not_ready"}` is the expected answer while the tables do not exist yet.
Nothing is lost; the first successful flush delivers the entire backlog in order.

**The receiver must be idempotent on `eventId`.** The engine retries a batch whose response it never
saw, so the same event can legitimately arrive twice — without the idempotency key, one network
timeout doubles every delivery count on every report.

### `POST /api/mail/engine/suppressions`

```jsonc
{
  "suppression": {
    "recipient": "gone@example.com",
    "reason": "invalid_mailbox",              // a bounceClass value
    "permanent": true,
    "expiresAt": null,                        // ISO 8601 when permanent is false
    "createdAt": "2026-08-16T10:14:02.881Z",
    "lastEventId": "0f9a1c3e-…",
    "detail": "550 5.1.1 <gone@example.com>: Recipient address rejected"
  }
}
```

Upsert on `recipient`. **A permanent entry must never be downgraded to a temporary one** — "this
address does not exist" outranks a later "we were rate-limited".

The engine keeps its own mirror on local disk and consults *that* on the hot path, so this call
failing delays the application's view and never the engine's behaviour.

### `POST /api/mail/inbound` — unchanged

Inbound mail uses the route the application already has. Raw RFC 5322 bytes, with the envelope in
headers:

```
Content-Type: message/rfc822
x-mail-secret: <MAIL_INBOUND_SECRET>
x-mail-to: admissions@edurankai.in,second@edurankai.in
x-mail-from: sender@example.com
```

The bytes are the original message, unmodified — re-encoding would break the DKIM signature on a
forwarded message.

| Application answers | Engine behaviour |
|---|---|
| `2xx` | delivered, removed from the inbound spool |
| `400` | permanent: moved to `rejected/`, **kept** (a mailbox may exist tomorrow) |
| anything else, including `403` | retried indefinitely — a wrong shared secret is a misconfiguration, and real mail is not destroyed over one |

---

## Application → engine

The engine listens on `MAIL_ENGINE_PORT` (2580), loopback by default, same signature scheme.

### `POST /submit`

```jsonc
{
  "messageId": "",                     // optional; the engine mints a UUID when empty
  "from": "noreply@edurankai.in",      // MUST be at a domain in MAIL_DOMAINS
  "headerFrom": "EduRankAI <noreply@edurankai.in>",
  "to": ["learner@example.com"],
  "cc": [],
  "bcc": [],                           // envelope only — never written as a header
  "replyTo": "admissions@edurankai.in",
  "subject": "Your certificate is ready",
  "text": "…",
  "html": "<p>…</p>",
  "headers": { "X-Campaign": "cert-2026" },
  "inReplyTo": "<parent@mail.edurankai.in>",
  "references": ["<root@mail.edurankai.in>"],
  "attachments": [
    { "filename": "certificate.pdf", "content": "<base64>", "contentType": "application/pdf" }
  ]
}
```

| Status | Meaning |
|---|---|
| `202` | queued. **Not delivered** — that is what the event stream is for |
| `422` | refused, with `issues[]` naming each problem |
| `401` | bad, missing or stale signature |

```jsonc
{
  "ok": true,
  "messageId": "8b2d…",
  "queued": ["learner@example.com"],
  "refused": [{ "recipient": "gone@example.com", "reason": "recipient is on the suppression list" }],
  "issues": []
}
```

Refused for: an address that will not parse, more than `MAIL_MAX_RECIPIENTS`, a subject or header
containing CR/LF (header injection), a caller-supplied `Bcc`/`Received`/`Authentication-Results`
header, a blocked attachment extension, an oversized message, or a `from` outside `MAIL_DOMAINS`.

### Other endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | queue depth, DKIM status per domain, and every reason it cannot deliver |
| `GET /metrics` | none | Prometheus text |
| `GET /stats` | none | the same numbers as JSON |
| `POST /inbound` | signed | raw MIME + `x-mail-to` / `x-mail-from`; answers 200 / 503 (retry) / 550 (refuse) |
| `POST /queue/flush` | signed | run one delivery pass now |
| `GET /queue/dead` | signed | dead-lettered messages |
| `POST /queue/requeue` | signed | `{"messageId":"…"}` — put one back on the queue |
| `GET /suppressions` | signed | the engine's local mirror |
| `DELETE /suppressions/:address` | signed | remove one |

`/healthz`, `/metrics` and `/stats` are unauthenticated on purpose: a probe should not need a secret,
and none of them expose message content.

---

## A note on the storage schema

The engine deliberately does **not** define `delivery_attempts`, `delivery_events`, `bounce_events`
or `suppression_entries`. Those belong to Patch 1. The reference routes in
`src/pages/api/mail/engine/` insert into `delivery_events` and `suppression_entries` with the column
names used above and answer `503` when the tables are absent — replace them freely, as long as the
wire format and the response-code semantics in this document are kept.

The columns the reference implementation writes:

```
delivery_events(event_id PK, occurred_at, kind, stage, message_id, rfc_message_id, from_address,
                recipient, recipient_domain, attempt, smtp_code, enhanced_code, smtp_response,
                mx_host, tls, dkim_signed, latency_ms, bounce_class, reason, next_attempt_at)

suppression_entries(recipient PK, reason, permanent, expires_at, created_at, last_event_id, detail)
```
