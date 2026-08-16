# EduRankAI Mail — Core Platform API

Base: `https://edurankai.in/api/v1/platform`

> **Path note.** The brief specifies `/api/v1/messages/*`, `/api/v1/templates` and so on. Those paths
> were already occupied by a second implementation built in parallel (`src/lib/mailapi/`), with a
> different auth model — API keys carrying environments and scopes, and a `{ object, data }`
> envelope. Two auth models at sibling paths is worse than one namespace, so this patch's surface
> lives under `/api/v1/platform/*`. Which one becomes canonical `/api/v1` is the open decision in
> `DEVELOPMENT-RULES.md §6`.

---

## Authentication

Either works on every endpoint:

```
x-api-key: erk_live_…            # or  Authorization: Bearer erk_live_…
Cookie: <session>                # a signed-in EduRankAI user
```

An API key acts as role `service`: it may send and read, and may do nothing administrative. A leaked
integration key cannot add a sending domain or read the whole contact database.

Act on a specific organization with `x-edurankai-org: <slug-or-uuid>` — honoured only if the caller
actually belongs to it.

## Response shape

```jsonc
{ "ok": true,  "…": "payload" }
{ "ok": false, "error": "A sentence you can act on.", "code": "machine_token" }
```

`error` is written for a person reading a log at 2am; `code` is for a program branching on it.
Authorization refusals say only `"forbidden"` — naming the missing capability tells an unauthorised
caller what to go looking for.

| Status | Means |
| --- | --- |
| 202 | Accepted for delivery |
| 401 | Not authenticated — sign in and retry |
| 403 | Authenticated, not permitted — do **not** retry |
| 404 | Not found, **or** not yours (deliberately indistinguishable) |
| 422 | Understood and refused (suppressed recipient, missing template variable) |
| 502 | Could not reach a mail server — retryable |

## Pagination

`?limit=&cursor=` → `{ "pagination": { "hasMore": true, "nextCursor": "…" } }`.
Keyset, not offset. `limit` is **clamped**, not rejected. The cursor is opaque.

---

## Endpoints

### `POST /messages/send` — the one every product calls

```bash
curl -X POST https://edurankai.in/api/v1/platform/messages/send \
  -H "x-api-key: erk_live_…" -H "Content-Type: application/json" \
  -d '{
    "to": "candidate@example.com",
    "template": "internship-stage-update",
    "variables": { "candidate_name": "Candidate", "stage": 3, "role": "AI Engineering Intern" },
    "metadata": { "application_id": "a-123" }
  }'
```

```jsonc
{ "ok": true, "messageId": "…", "threadId": "…", "rfcMessageId": "<…@edurankai.in>",
  "status": "sent", "accepted": ["candidate@example.com"], "suppressed": [] }
```

| Field | Notes |
| --- | --- |
| `to` / `cc` / `bcc` | string or array. Deduplicated across fields, `to` wins. |
| `template` + `variables` | resolved against the org's published template version |
| `bodyHtml` / `bodyText` | alternative to `template`; one of them is required |
| `from` | must be a **registered sending identity**, or the send is refused |
| `headers` | custom only — `From`, `Message-ID`, `DKIM-Signature` etc. are refused |
| `metadata` | echoed on every delivery event for this message |
| `scheduledAt` | future ISO timestamp → `status: "queued"` |
| `ignoreSuppression` | needs `mail.manage`; **always** refused for a campaign send |

`suppressed` is present on success too: a message that reached four of five intended people is a
success whose shape the caller still needs.

### Messages
| Method | Path | Capability | Notes |
| --- | --- | --- | --- |
| `GET` | `/messages` | `mail.read` | `?folder=&q=&from=&to=&unread&drafts=&hasAttachments=` |
| `POST` | `/messages` | `mail.send` | stores a **draft** — nothing is delivered |
| `GET` | `/messages/:id` | `mail.read` | `?delivery=false` to skip the per-recipient status |
| `PATCH` | `/messages/:id` | `mail.read` | `folder`, `isRead`, `isStarred`, `addLabels`, `removeLabels`, `snoozedUntil` — **your copy only** |
| `DELETE` | `/messages/:id` | `mail.read` | trash; `?hard=true` removes your copy |
| `POST` | `/messages/:id/reply` | `mail.send` | `{ body, all }` — threads correctly |
| `POST` | `/messages/:id/forward` | `mail.send` | `{ to, note, includeAttachments }` — new thread, Bcc never reproduced |

### Threads, mailboxes
| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/threads` · `/threads?id=` | `mail.read` |
| `GET` | `/mailboxes` | `mail.read` |
| `POST` | `/mailboxes` | `mailbox.manage` (+ `org.manage` for someone else's) |

### Contacts
| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/contacts` | `contacts.read` |
| `POST` | `/contacts` | `contacts.write` |

`POST` takes one contact, or `{ "contacts": [...] }` for up to 10,000. Import reports **per-row**
failures and returns 200 with a `summary` sentence — a 400 on row 4,000 of 5,000, with the first
3,999 already written and no record of which, is the worst outcome for whoever finishes the import.

### Campaigns
| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/campaigns` · `/campaigns?id=` | `campaigns.read` |
| `POST` | `/campaigns` | `campaigns.write` |
| `POST` | `/campaigns?action=start\|pause\|cancel\|expand&id=` | `campaigns.send` |

Starting requires `campaigns.send`, a **separate** capability from `campaigns.write`. Counts come
from the event stream on every read, not from a stored counter that could drift.

### Domains
| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/domains` · `/domains?id=` | `domains.read` |
| `POST` | `/domains` | `domains.manage` |
| `POST` | `/domains?action=verify` · `?action=rotate-dkim` · `?action=identity` | `domains.manage` |

Adding a domain returns the DNS to publish and the **DKIM private key exactly once**. It is never
written to the database — if lost, the fix is a rotation, not a lookup.

`?action=verify` returns **200 even when checks fail**: verification *ran*, and the per-check
`expected`/`observed`/`detail` is the answer. A non-2xx would make "your DNS is not published yet"
look like a broken endpoint.

### Status
`GET /status` → every provider slot's own `info()`, the env var that swaps it, queue health, and an
explicit `unconfigured` list. Requires `mail.read` — the detail strings name hostnames and unset
secrets.

---

## Capabilities

`mail.read` `mail.send` `mail.manage` `mailbox.manage` `contacts.read` `contacts.write`
`campaigns.read` `campaigns.write` `campaigns.send` `templates.read` `templates.write`
`domains.read` `domains.manage` `automation.read` `automation.write` `events.read`
`webhooks.manage` `org.manage`

| Role | Holds |
| --- | --- |
| `owner` | everything |
| `admin` | everything except `org.manage` |
| `member` | send, read, contacts r/w, campaigns/templates **write but not send** |
| `analyst` | every `*.read` |
| `service` (API keys) | `mail.send` `mail.read` `contacts.read` `templates.read` `events.read` |

## Webhooks

Registered endpoints receive:

```
POST <your url>
X-EduRankAI-Signature: t=1700000000,v1=<hex hmac-sha256>
X-EduRankAI-Event: message.sent
X-EduRankAI-Delivery: <uuid>
```

Verify over `` `${t}.${rawBody}` ``, in constant time, and reject a timestamp more than 5 minutes
old. Signing only the body would make a captured request valid forever.

Retries: 1m, 5m, 25m, 2h, 10h, then failed. Endpoints must be **https** and public — private and
link-local hosts are refused at registration, because otherwise a webhook is a server-side request
forgery primitive aimed at cloud metadata services.

Event names are in `src/lib/mailplatform/adapters/event-bus-postgres.ts` (`EVENT_TYPES`).
