# EduRankAI Mail — threat model

**Written** 2026-08-16 · **Method** source review only · **Scope** the mail system that is live in
this repository today.

## How this was produced, and what it is not

Every statement below comes from reading source. **No database was connected to, no `.env*` file was
opened, and nothing was probed against the running site** — the working rules in `CLAUDE.md` forbid
the first two, and the third is the user's call, not mine. Where a claim could only be settled by
running something, it is marked UNVERIFIED rather than asserted.

A second consequence of the same discipline: this model describes the mail system **as the code says
it behaves**. Reported success and observable result have diverged on this project before. The
controls this model calls for are worth nothing until they are seen working on the real surface.

**A concurrency note that matters for reading this.** While this pass was running, another session
was actively writing `src/lib/mailapi/`, `src/lib/mailops/`, `src/lib/mailplatform/` and
`mail-engine/` — a mail platform with its own orgs, API keys, suppression, rate-window and domain
tables, and its own SMTP listener. Those are not modelled here, because they were still being
written. Where a threat lands squarely in that new work, this document says so and stops, rather
than modelling a moving target.

---

## 1. The system being modelled

### Submission and mailbox (authenticated)

| Surface | Gate |
| --- | --- |
| `POST /api/mail/send` | `denyMailApi()` -> `canUseMailbox()` |
| `POST /api/mail/draft` | `denyMailApi()` |
| `POST /api/mail/action` | `denyMailApi()` |
| `POST /api/mail/open` | session only (`if (!user) return 401`) |
| `/admin/mail`, `/admin/mail/*` | admin console gate + `applicant` redirect |
| `/portal/employee/mail` | employee workspace gate |

### Inbound (external senders)

| Surface | Gate |
| --- | --- |
| `POST /api/mail/inbound` (JSON or raw MIME) | shared secret, header or JSON body |
| IMAP poller (`src/lib/mail-imap.ts`) | stored credentials, pulled on a schedule |

### Automation

| Surface | Gate |
| --- | --- |
| `GET/POST /api/mail/scheduled-send` | `cronAuth()` — constant-time, fails closed |
| `GET/POST /api/mail/imap-poll` | `can(user,'mail.manage')` **or** `CRON_SECRET` |

### Diagnostics (authenticated, credential-bearing)

`POST /api/mail/test`, `POST /api/mail/verify`, `POST /api/mail/imap-test`,
`GET /api/mail/dns-check` — all gated on `can(user,'mail.manage')`.

### Public, unauthenticated

`GET /api/mail/track/<uuid>.gif` (open pixel) and `GET /api/mail/click/<uuid>?u=` (click
redirector). These are the only mail URLs an anonymous caller can reach, and they are reachable by
design: they live in mail that has already left the building.

### Libraries

`src/lib/mail.ts` (engine, schema bootstrap, threading, delivery truth), `mail-transport.ts`
(outbound SMTP), `mail-advanced.ts` (signatures, scheduling, rules, click/open analytics),
`mail-groups.ts` (`@group:slug` distribution lists), `mail-imap.ts` (inbound poll), `mail-links.ts`
(attachments-are-links), `src/lib/auth/mail-access.ts` (who has a mailbox).

---

## 2. Trust boundaries

```
              A                        B                          C
 anonymous ------> track / click   forwarding ----> /api/mail/   session ----> /api/mail/
 internet         (no auth)         MTA             inbound      principal     send | draft |
                                   (shared secret)                             action | open
                       |                 |                            |
                       +-----------------+--------------+-------------+
                                                        |
                                                        v
                                      mail_messages / mail_box / mail_reads / email_logs
                                                        |
                    +-----------------------------------+---------------------+
                    v                                   v                     v
             G: rendering                    E: upstream SMTP/IMAP     F: third parties
             (MailClient, admin)             (credentials in           (Cloudflare DoH,
                                              mail_config)              ipapi.co)
                                                        ^
                                                        | D
                                                 scheduler (CRON_SECRET)
```

**A** is the boundary with no authentication at all. **B** is a bearer secret with no message
binding. **C** is the platform session. **D** is a shared secret. **E** is where our credentials
leave the process. **F** is where our data leaves the company. **G** is where content written by
someone else gets rendered by us.

---

## 3. Assets, in the order they hurt to lose

1. **The sending reputation of `edurankai.in`.** The only asset here that cannot be restored by
   rotating something. One spam run from one compromised mailbox costs months.
2. **SMTP and IMAP credentials.** `mail_config.smtp_pass` / `imap_pass`, held **in cleartext at
   rest** (`src/lib/mail.ts`, `bootstrapSchema()`; the columns are plain `TEXT`).
3. **`MAIL_INBOUND_SECRET` and `CRON_SECRET`.** Either one lets an anonymous caller inject mail into
   staff mailboxes or drain the scheduled queue.
4. **Message bodies** — `mail_messages.body_html` / `body_text`. This is where offer letters, HR
   correspondence and applicant conversations live.
5. **Recipient PII.** `mail_reads` stores IP address, country, region, city and user agent per open,
   including for **external** recipients who never agreed to anything.
6. **Distribution lists** (`mail_groups`) — the reach multiplier for any account that gets in.
7. **DKIM private key.** Not in this half of the system yet; `mail-engine/keys/` is gitignored by the
   in-flight work. Modelled here so it is never accidentally committed later.

---

## 4. Actors

| Actor | Holds | Can reach |
| --- | --- | --- |
| Anonymous internet | nothing | track pixel, click redirector |
| Recipient of our mail | a message UUID (it is in the pixel and link URLs) | same, with a valid id |
| Forwarding MTA / email worker | the inbound shared secret | `/api/mail/inbound` |
| Applicant account | a session | **no mailbox** — `canUseMailbox()` refuses |
| Mailbox holder | a session plus an active `hr_employees` row, **or** one of ten built-in internal roles | send, draft, action, open, groups |
| Mail administrator | `mail.manage` (ten built-in roles) | SMTP/IMAP probes, real test sends, DNS checks, settings |
| Scheduler | `CRON_SECRET` | scheduled-send, imap-poll |
| Upstream provider | our credentials | everything we send and receive |

Two of these rows are wider than they look, and both are recorded as decisions for a human in
section 6: `MAILBOX_REFUSES_INTERNS` is `false`, so an internship engagement has a mailbox; and
`mail.manage` is held by all ten non-applicant built-in roles, which is who can point an SMTP probe
at an arbitrary host.

---

## 5. Threats

Status values: **MITIGATED** (a control exists and was read), **PARTIAL** (something stands in the
way but not enough), **OPEN** (nothing stands in the way), **DEFERRED** (belongs to the in-flight
platform work), **N/A** (does not apply to this design).

### 5.1 SMTP abuse — PARTIAL

Submission is authenticated and attributed: `send.ts` derives `fromEmail` from
`getMailboxAddress(user.id)` and never from the request, and `mail-transport.ts` rewrites the From
header to the configured `from_address` with the caller's address demoted to Reply-To. A caller
cannot choose who the mail claims to be from.

What is missing is volume: **no per-account send rate limit, no recipient cap per message, no daily
cap** — and `@group:slug` expands a whole distribution list in one request
(`mail-groups.ts`, `expandGroupTokens`). One account is one send loop away from the whole contact
surface.

### 5.2 Open relay — N/A here, DEFERRED to `mail-engine/`

There is no SMTP listener in this half of the system. Everything enters over HTTP with a session,
and the envelope sender is server-derived. The classic open-relay question — "will you accept mail
from an unauthenticated peer for a domain you do not own?" — has no listener to ask it of.

It becomes the central question the moment `mail-engine/` accepts a TCP connection. The
recipient-authorization and relay-refusal logic belongs with that listener, and the relay tests
belong beside it, not here.

### 5.3 Account takeover — PARTIAL

Mailbox access rides the platform session. Session cookies are `httpOnly`, `sameSite: 'lax'` and
`secure` in production (`src/lib/auth/cookie.ts:32`). Authentication is any-one-of
password / passkey / face / TOTP, which is a deliberate product decision recorded elsewhere.

The gap specific to mail is that there is **no step-up authentication in front of credential-bearing
screens**. A stolen session reaches `/admin/mail/settings`, which displays the inbound secret in
cleartext (`settings.astro:340`) and can regenerate it, and reaches `/api/mail/verify`, which will
test credentials against any host.

### 5.4 API key theft — DEFERRED

Mail has no API keys today. The partner-integration keys in `src/lib/api-keys.ts` are stored as
hashes with a prefix, and the committed fallback signing secret that used to be there has already
been removed. The mail platform's own key system (`src/lib/mailapi/keys.ts`) was being written during
this pass and is not modelled.

### 5.5 Spam campaigns — OPEN

The highest-value gap in the system. Any mailbox holder — including an internship engagement — can
address an arbitrary number of external recipients, or a `@group:` list, with no suppression list,
no unsubscribe mechanism, no complaint feedback loop and no bounce handling. `email_logs` records
per-recipient outcomes, so the raw material for bounce and complaint rates exists; nothing reads it
as a control.

### 5.6 Credential stuffing and brute force — PARTIAL

Platform login throttling is outside mail's scope. Inside it, `/api/mail/verify` and
`/api/mail/imap-test` are **unthrottled credential-probing oracles**: they accept a host, port,
username and password and report, precisely, whether that combination authenticates. See F-02.

### 5.7 Malicious attachments — PARTIAL by architecture

Mail has no upload path and never had one: `mail-links.ts` is explicit that attachments are links,
`mail_attachments` stores a URL, and `send.ts` re-derives every link server-side so a hand-crafted
POST cannot mislabel one. `describeLink()` refuses `data:`, `blob:` and `file:` schemes.

The gap is on the way in. `postal-mime` parses inbound MIME, and `deliverInbound()` takes no
attachment argument — so an attachment that arrives is **silently discarded**. Nothing is stored,
which is safe; but nothing is examined and no record says an attachment was dropped, so a recipient
is shown a message whose contents they cannot see and nobody can explain.

### 5.8 Malicious HTML — OPEN

Two halves, and only one is safe.

*Reading is safe today.* `MailClient.astro:141` renders `body_text`, falling back to `stripTags()` of
the HTML. Inbound HTML is stored verbatim but never rendered as HTML, so there is no stored XSS in
the inbox. This is a property of one line in one component, not a stated control — the first surface
that renders `body_html` inherits the entire problem.

*Sending is not.* A template body, or an HTML-mode composer message, goes to external recipients
under our From and our DKIM with **no sanitisation at all**. Our domain will carry whatever the
sender wrote.

### 5.9 Phishing — PARTIAL

The click redirector was an open redirect on the company domain and is now bound to the message it
claims to belong to: `click/[id].ts` checks the destination against the stored
`body_html`/`body_text` of that message id and falls back to the site root on anything it cannot
prove. That is the right shape, and it is already shipped.

What remains is 5.8: unsanitised outbound HTML means our domain can still deliver someone else's
phishing markup with our authentication on it.

### 5.10 Header injection — PARTIAL, partly UNVERIFIED

`subject`, `inReplyTo` and `messageId` reach `nodemailer.sendMail()` from request bodies with **no
CR/LF filtering anywhere in our code**. Nodemailer encodes header values, so this is probably not
exploitable today — but "probably, because of what a dependency does" is not a control, it is a
dependency. The version in this tree also carries GHSA-p6gq-j5cr-w38f (see F-03), which is a
reminder that a dependency's safety properties are not fixed points.

The address lists are safer by accident: `parseAddressList()` extracts addresses with a regex that
cannot match a newline, so CR/LF cannot survive into an address. That is an accident of the pattern,
not a stated intent, and it should be made explicit.

### 5.11 SMTP injection — PARTIAL

Same family as 5.10 and the same answer. The envelope is assembled by nodemailer from structured
fields rather than by string concatenation, and every address passes through the regex above.

### 5.12 XSS — OPEN

`MailClient.astro:537` passes DB-sourced `templateHtml` and `templateSubject` into an inline script
through Astro's `define:vars`. Astro escapes the exact lowercase string `</script>` and nothing else
— `</SCRIPT>` and `</script >` both terminate a script element in HTML, and both pass through
untouched. Template rows are writable by every non-applicant role. See F-01.

Separately, there is **no Content-Security-Policy on any response** (`vercel.json` sets HSTS,
nosniff, frame and referrer policy, but no CSP), so nothing limits the blast radius of an injection
that does land.

### 5.13 CSRF — MITIGATED for writes, one low-severity edge

`sameSite: 'lax'` plus JSON-only request bodies covers the write endpoints: a cross-site form cannot
produce a JSON POST that carries the cookie. The edge is `GET /api/mail/imap-poll`, which accepts
session authentication on a GET — a top-level navigation from another site would carry the cookie
and trigger a mailbox poll. The attacker chooses nothing but the timing.

### 5.14 SSRF — OPEN

Two distinct instances, both real:

* `/api/mail/verify`, `/api/mail/test` and `/api/mail/imap-test` open a TCP connection to a **host
  and port chosen by the caller** (F-02). Nothing restricts the target to a mail host, to a public
  address, or to a port that speaks SMTP.
* `sendExternal()` maps attachments onto nodemailer's `path` field (`mail-transport.ts:145`) with
  `disableFileAccess` and `disableUrlAccess` **unset**, so an attachment carrying a `path` is a local
  file read and one carrying an `href` is a server-side fetch whose response lands inside a delivered
  message (F-03). No current caller passes one; the interface accepts it.

The two `ipapi.co` calls are outbound to a third party with caller-influenced input, but the input is
an IP address and the risk there is disclosure (5.20), not request forgery.

### 5.15 SQL injection — MITIGATED

Every statement read in this pass is a Drizzle `sql` template with bound parameters. The one
`sql.raw()` in the mail path (`mail.ts:413`, `clearMailField`) interpolates a column name that is
checked against an allowlist `Set` on the line above and returns early on anything else.
`src/lib/pg-array.ts` (`uuidIn` / `textIn`) exists specifically so array binding is not hand-rolled.

### 5.16 Path traversal — N/A today, control shipped ahead of need

No filesystem path is constructed from user input anywhere in the mail path, because there is no file
storage in the mail path. The threat becomes live the moment an attachment store exists, which is why
filename sanitisation is worth writing before the store rather than after it.

### 5.17 Webhook forgery — OPEN

`/api/mail/inbound` is the one place an external party writes into staff mailboxes, and its gate is a
bare shared secret with three weaknesses:

* compared with `!==` (`inbound.ts:72`) — not constant time;
* accepted in the **JSON body** as well as the `x-mail-secret` header, and bodies are logged, cached
  and proxied in more places than headers are;
* no HMAC over the message, no timestamp and no replay window — a captured request replays forever.

`MAIL_WEBHOOK_SECRET` is already reserved in `src/lib/mailops/env.ts` for the HMAC form. The body size
is also unbounded: `request.text()` on the raw-MIME path (`inbound.ts:38`) reads whatever arrives.

### 5.18 Privilege escalation — PARTIAL

`canUseMailbox()` composes three answers that already exist, fails closed on every arm, and
authorises before the handler reads a body. Its width is documented in the file itself and is
deliberately wide.

The escalation path that is *not* deliberate is F-01: "may author a mail template" is held by every
non-applicant role, and the `define:vars` gap turns that into script execution in the admin console
when an administrator opens that template in the composer.

### 5.19 Tenant isolation failure — DEFERRED

There is no tenant model in this half. Isolation is per-user and consistent: every statement in
`action.ts` is narrowed to `user_id = <caller>`, `getThreadMessages()` reads through `mail_box`, and
both draft-deletion statements in `send.ts` name the owner. Multi-tenant isolation arrives with
`mailapi_orgs`, and the isolation tests belong with it.

### 5.20 Data leakage — OPEN

* **Recipient location, disclosed to a third party.** Every open — pixel or in-app — sends the
  reader's IP to `ipapi.co` (`track/[id].gif.ts:31`, `open.ts:20`) and stores the returned city,
  region and country in `mail_reads` with no retention limit. External recipients are neither asked
  nor told. On a platform whose own rules forbid reading private data without consent, this is the
  finding most out of step with its surroundings.
* **The inbound secret is rendered in cleartext** into the HTML of `/admin/mail/settings:340`.
* **SMTP and IMAP passwords are stored unencrypted** in `mail_config`.

### 5.21 Queue abuse — PARTIAL

`claimDueScheduled()` takes ownership in the same statement that selects, so two overlapping runs of
`scheduled-send` can no longer both deliver the same message. That was fixed already and is one of
the better controls in the system.

Still open: `/api/mail/open` accepts an **unbounded** `messageIds` array (`open.ts:62`) and performs
one insert per id, fire-and-forget, for any mailbox holder; and the tracking pixel writes a row per
request with no authentication and no rate limit. Neither checks that the caller is a recipient of
the message, so read receipts can be forged by anyone holding a message UUID.

### 5.22 Retry storms — PARTIAL

`sendExternal()` retries three times with backoff, and only on errors it classifies as transient.
`imap-poll` wraps the poller so a throw cannot crash-loop the scheduler, and caps it at 90 seconds.
`scheduled-send` reclaims rows stuck in `sending` after 15 minutes — correct, but there is **no
attempt ceiling**, so a message that fails to settle is retried indefinitely, and mail cannot be
recalled.

---

## 6. Decisions that belong to a human, not to this patch

1. **Should an internship engagement have a company mailbox?** `MAILBOX_REFUSES_INTERNS = false`
   today, argued in `src/lib/auth/mail-access.ts`. Flipping it is one line and a policy change.
2. **Should all ten built-in roles hold `mail.manage`?** It carries SMTP credential probing, real
   test sends from the company address, and the IMAP pull. Partner, teacher and technical_moderator
   sit inside it.
3. **Should we geolocate recipients at all?** Turning `ipapi.co` off costs a column on an analytics
   screen. Leaving it on ships a stranger's location to a third party on every open.
4. **How long should `mail_reads` keep IP addresses?** There is no retention rule today.
5. **Move `/api/mail/inbound` from a shared secret to an HMAC signature?** The variable is already
   reserved; the cost is a change at the forwarding worker.

---

## 7. What this model deliberately does not cover

* `mail-engine/` — the SMTP listener, its DKIM signing and its relay policy. Being written now.
* `src/lib/mailapi/` — orgs, API keys, idempotency, webhooks, and the tenant boundary they create.
* Platform authentication itself (`src/lib/auth/*` beyond `mail-access.ts`), covered elsewhere.
* Anything requiring a live probe or a database read, for the reasons in the opening section.
