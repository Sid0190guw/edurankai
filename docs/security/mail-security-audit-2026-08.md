# EduRankAI Mail — security audit, August 2026

**Pass** Patch 7, review stage · **Date** 2026-08-16 · **Method** source review, `npm audit`, and a
repository secret scan. No database connection, no `.env*` read, no live probing — see the opening
section of [mail-threat-model.md](./mail-threat-model.md) for why.

Findings are ordered by severity. Each one names what an attacker does, where the code is, and what
the fix is. **Nothing in this document has been fixed yet** — this pass was held at the review stage
because another session was writing to the same tree.

Severity is judged on this system, not in the abstract: "high" means a reachable path to
credentials, to the admin console, or to the sending reputation of the domain.

---

## Code findings

### F-01 · HIGH · Stored XSS in the admin console through a mail template

**Where** `src/components/MailClient.astro:537`, with `src/pages/admin/mail/templates.astro:30` as
the write side.

**What happens.** The composer passes DB-sourced values into an inline script through Astro's
`define:vars`:

```astro
<script is:inline define:vars={{ basePath, myAddress, templateSubject, templateHtml, ... }}>
```

Astro's `defineScriptVars` (`node_modules/astro/dist/runtime/server/render/util.js:19`) serialises
each value with `JSON.stringify` and then replaces **the exact lowercase string `</script>`** and
nothing else:

```js
JSON.stringify(value)?.replace(/<\/script>/g, "\\x3C/script>")
```

`</SCRIPT>` and `</script >` both terminate a script element per the HTML parser, and neither matches
that pattern. Confirmed by running the same replacement over both inputs: they pass through verbatim.

**The chain.** `/admin/mail/templates` gates on `user.role === 'applicant'` only, so **all ten
non-applicant built-in roles can author a template body**. A template whose `body_html` contains
`</SCRIPT><script>...</script>` breaks out of the inline script when an administrator opens
`/admin/mail?template=<id>`, and runs in the admin console origin with the admin's session.

That is a privilege escalation from "may write marketing copy" to "may act as an administrator",
and it is not limited by a Content-Security-Policy because there isn't one (F-09).

**Fix.** Stop putting DB HTML through `define:vars` on this surface — carry the template body in a
`<script type="application/json">` block with `<` escaped, or fetch it from an endpoint after load.
Add a regression test that asserts an uppercase `</SCRIPT>` in a template body cannot reach the
rendered script.

**Note for a separate sweep, not this patch.** 75 files in `src/` use `define:vars`. This finding is
about the one that carries attacker-writable database content; the pattern is worth a repo-wide look
by whoever owns that area.

---

### F-02 · HIGH · Authenticated SSRF and credential-probing oracle on three diagnostic endpoints

**Where** `src/pages/api/mail/verify.ts:60`, `src/pages/api/mail/imap-test.ts:41`,
`src/pages/api/mail/test.ts:70`.

**What happens.** All three take `host` and `port` **from the request body** and open a TCP
connection to them. Nothing restricts the target to a mail host, to a public address, or to a port
that speaks SMTP or IMAP:

```ts
const res = await verifySmtp({
  host: (body.host || '').toString().trim(),
  port: Number(body.port || 587),
  ...
});
```

Two abuses follow from one primitive:

1. **SSRF and internal port scan.** Any holder of `mail.manage` — which is all ten non-applicant
   built-in roles, including partner, teacher, technical_moderator and any intern-flagged account —
   can aim the server at RFC1918 space, at `localhost`, or at a cloud metadata address, and read the
   outcome from the error strings, which are returned verbatim along with a diagnostic hint.
   `verifySmtp()` distinguishes `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` and TLS-version mismatches,
   which is exactly the discrimination a scanner needs.
2. **Credential probing.** `verifySmtp()` answers, precisely, whether a username and password
   authenticate against a given host. Unthrottled. The endpoint's own comment already flags the
   oracle; the arbitrary-host half is not flagged anywhere.

`/api/mail/test.ts` is the worst of the three: it takes host, credentials **and a recipient
address**, so it is also an arbitrary-mail-sending primitive.

**Fix.** Rate limit all three per user. Resolve the hostname and refuse loopback, link-local,
RFC1918, RFC4193 and multicast destinations before connecting. Restrict the port to a small
allowlist (25, 465, 587, 993, 143, 2525). Return a shaped verdict rather than the raw connection
error. Audit every probe with the target host, so a scan leaves a trail.

---

### F-03 · HIGH (latent) · Nodemailer attachment `path` is arbitrary file read and full-response SSRF

**Where** `src/lib/mail-transport.ts:145`.

```ts
attachments: (p.attachments || []).map((a) => ({ filename: a.filename, path: a.href || a.path })),
```

**What happens.** Nodemailer's `path` field reads a **local file** and `href` performs a **server-side
fetch**, embedding the result in the delivered message. Neither `disableFileAccess` nor
`disableUrlAccess` is set on any transport in this repository — confirmed, zero occurrences in `src/`.
So an attachment reaching this line with `path: '/etc/passwd'`, with the deployment's own filesystem,
or with an internal URL, produces a message containing that content, delivered to an address the
caller chose.

**Is it live?** Not today. Every current caller passes `attachments: []` or omits the field. The
danger is the shape: `SendExternalParams` advertises `{ filename, path?, href? }` as part of the
public interface of the outbound path, and the mail platform being written alongside this one has an
attachment model with byte content. The first caller that wires attachments through inherits an LFI.

**The dependency angle.** The installed nodemailer also carries GHSA-p6gq-j5cr-w38f — *message-level
`raw` option bypasses `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and full
response SSRF*, CVSS 7.1, fixed in 9.0.5. So the two obvious hardenings (setting the flags, and not
mapping `path`) are both needed: the flags alone are bypassable on this version.

**Fix.** Set `disableFileAccess: true` and `disableUrlAccess: true` on every transport. Stop mapping
`path`/`href` — attachments here are links and belong in the body, which is what `mail-links.ts`
already says. Narrow the `SendExternalParams.attachments` type so a path cannot be expressed. Upgrade
nodemailer (major version bump; see the dependency section).

---

### F-04 · HIGH · No sending controls of any kind

**Where** absent from `src/pages/api/mail/send.ts` and `scheduled-send.ts`.

**What happens.** A mailbox holder can send to an unbounded number of external recipients, as often
as they like. There is no per-account rate limit, no recipient cap per message, no daily cap, no
suppression list, no unsubscribe, no bounce handling and no complaint handling. `@group:slug` expands
an entire distribution list in one request.

`email_logs` already records one row per recipient with a status, so the raw material for bounce and
complaint rates is being written — nothing reads it as a control.

**Why it is rated high.** The asset at risk is the domain's sending reputation, which is the one
asset in section 3 of the threat model that cannot be restored by rotating a secret.

**Fix.** This is the bulk of Patch 7: a rate limiter that fails closed, recipient caps, a global
suppression list enforced before every send, bounce and complaint classification off `email_logs`,
and per-identity throttle/pause/lock controls.

---

### F-05 · MEDIUM · Inbound webhook secret is comparable, replayable and body-borne

**Where** `src/pages/api/mail/inbound.ts:38`, `:72`.

```ts
if (!secret || (provided || body.secret) !== secret) return json({ ok: false, error: 'forbidden' }, 403);
```

Three separate weaknesses in one line and its neighbourhood:

* `!==` is not constant time. Remotely exploiting a string-compare timing side channel over HTTP is
  hard, and the same repository already uses a constant-time compare in `src/lib/auth/cron-auth.ts`,
  so the inconsistency is the finding as much as the timing is.
* The secret is accepted **in the JSON body** as well as in the header. Request bodies are logged,
  cached and proxied in more places than headers are.
* There is no HMAC over the message, no timestamp and no replay window. A captured request replays
  forever, injecting the same message into the same mailbox on demand.

The raw-MIME path also reads an **unbounded** body: `const raw = await request.text()` with no size
check, then hands it to `postal-mime`.

**Fix.** Constant-time compare, header only, a body size cap, and an HMAC-signed form using the
already-reserved `MAIL_WEBHOOK_SECRET` with a timestamp and a replay window — keeping the shared
secret working during migration so the forwarding worker does not break.

---

### F-06 · MEDIUM · Unauthenticated and unbounded write amplification on the tracking endpoints

**Where** `src/pages/api/mail/track/[id].gif.ts`, `src/pages/api/mail/open.ts:62`.

**What happens.**

* The tracking pixel is unauthenticated by necessity and writes a `mail_reads` row **plus an
  outbound HTTP request to a third party** per hit, with no rate limit. Anyone holding a message
  UUID — every recipient of that message holds one, it is in the URL — can replay it to forge read
  receipts and to generate load and cost.
* `/api/mail/open` accepts a `messageIds` array with **no length limit** and loops one insert per id,
  fire-and-forget. It checks only that the message was not sent by the caller
  (`from_user_id <> userId`), never that the caller is a recipient — so any mailbox holder can insert
  read receipts against any message id they can obtain.

**Consequence.** Read-receipt data is not trustworthy, and two endpoints convert one request into
unbounded database and third-party work.

**Fix.** Cap the array, rate limit both endpoints per IP and per user, and require that the caller
have a `mail_box` row for the message before recording an internal open.

---

### F-07 · MEDIUM · Recipient IP and location sent to a third party and kept indefinitely

**Where** `src/pages/api/mail/track/[id].gif.ts:31`, `src/pages/api/mail/open.ts:20`.

Every open sends the reader's IP address to `ipapi.co` and stores the returned country, region and
city in `mail_reads` alongside the IP and user agent. External recipients are neither asked nor told,
and there is no retention limit on the table.

This sits badly beside this codebase's own rules, which forbid reading private data without consent
and require aggregate-only oversight screens for anything sensitive. It is also a third-party
dependency in a request path on a platform whose sovereignty directive says core capabilities should
be first-party.

**Fix.** Make geolocation opt-in behind a setting that defaults to off, and add a retention job that
drops IP addresses from `mail_reads` after a stated window. Whether to geolocate recipients at all is
a policy call and is listed in section 6 of the threat model.

---

### F-08 · MEDIUM · Outbound HTML is never sanitised

**Where** `src/pages/api/mail/send.ts` (body assembly), `scheduled-send.ts`.

Template bodies and HTML-mode composer messages are stored verbatim and sent verbatim, under our From
address and our DKIM signature. Nothing strips scripts, event handlers, `javascript:` URLs, frames or
remote-loading SVG.

Modern mail clients strip most of this on render, which is why this is medium rather than high — but
the platform should not be relying on the recipient's client to decide what our domain is willing to
put its name on. The same sanitiser is also the prerequisite for ever rendering `body_html` in the
reading pane, which is currently avoided only by rendering text (threat model 5.8).

**Fix.** An allowlist sanitiser applied before storage, so the stored body and the sent body agree —
which also keeps the click-redirector's allowlist check (`click/[id].ts`) honest, since it matches
destinations against the stored body.

---

### F-09 · MEDIUM · No Content-Security-Policy on any response

**Where** `vercel.json`.

The edge sets `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` and a `Permissions-Policy`, and the admin and portal
trees are `noindex` with `no-store`. There is **no `Content-Security-Policy`**, so nothing bounds an
injection that gets through — including F-01.

**Fix.** A CSP is a whole-site change and this patch must not modify unrelated functionality, so the
proposal is scoped: start with a `Content-Security-Policy-Report-Only` header on the mail surfaces to
learn what the pages actually load, then enforce. `is:inline` scripts are used heavily in this
codebase, so any enforcing policy needs nonces or hashes and cannot be switched on blind.

---

### F-10 · LOW · The inbound secret is rendered in cleartext into the settings page

**Where** `src/pages/admin/mail/settings.astro:340`.

```astro
<input class="rolefield-input" readonly value={raw.inbound_secret || '(not generated yet)'} ... />
```

The operator does need to copy this value into the forwarding worker, so it has to be reachable. But
it is currently in the HTML of every load of that page — in the browser cache, in any screen share,
and in any screenshot of the settings screen. The SMTP password on the same page is handled correctly
(`settings.astro:133` selects only a `has_pass` boolean and never the value), which shows the pattern
already exists in the file.

**Fix.** Mask by default with an explicit reveal action that fetches the value and writes an audit
entry.

---

### F-11 · LOW · `innerHTML` with a URL-derived filename in the composer

**Where** `src/components/MailClient.astro:572`.

```js
d.innerHTML='<span>'+a.filename+'</span>';
```

`a.filename` comes from the client-side mirror of `describeLink()` — a sender-supplied name or a name
derived from the pasted URL. It is the sender's own input rendered into the sender's own page, so
this is self-XSS, which is why it is low. It is still an unescaped `innerHTML` two lines away from
code that correctly uses `createElement` and `textContent`.

**Fix.** `textContent`, matching the sibling lines.

---

### F-12 · LOW · `imap-poll` accepts session auth on GET, and compares its cron secret non-constant-time

**Where** `src/pages/api/mail/imap-poll.ts:41`.

`GET` with session authentication means a top-level navigation from another site carries the cookie
under `sameSite: 'lax'` and triggers a mailbox poll. The attacker controls nothing but the timing, so
the impact is a forced poll.

Separately, `cronAuthorized()` compares with `===` while the repository's `src/lib/auth/cron-auth.ts`
helper — used by `scheduled-send` — trims, compares in constant time and fails closed. Two cron
endpoints in the same directory answering the same question two different ways is how they drift.

**Fix.** Route this endpoint through `cronAuth()`, and require POST for the session-authenticated arm.

---

### F-13 · INFO · Committed fallback values for signing secrets, outside mail

Found by the secret scan and reported rather than fixed, because Patch 7 must not modify unrelated
functionality:

| File | Fallback |
| --- | --- |
| `src/lib/credential.ts:10` | `CREDENTIAL_SIGNING_SECRET \|\| SESSION_SECRET \|\| 'edurankai-credential-signing-v1'` |
| `src/lib/calendar.ts:8` | `CALENDAR_TOKEN_SECRET \|\| SESSION_SECRET \|\| 'edurankai-calendar-v1'` |
| `src/lib/activity-log.ts:47` | `ACTIVITY_ENC_KEY \|\| SESSION_SECRET \|\| 'edurankai-activity-dev-key-v1'` |
| `src/pages/admin/applications/[id]/offer-letter.astro:63` | `OFFER_INTEGRITY_SECRET \|\| 'dev-fallback-change-in-prod'` |
| `scripts/seed.ts:12` | `SEED_ADMIN_PASSWORD \|\| 'ChangeMe2026!'` |

This is the same class of defect `src/lib/api-keys.ts` documents having already removed from the
lab-embed signing path: *a secret written into the repository is not a secret*. The first is the most
serious of the five — with neither variable set, anyone who can read the repository can mint a
signature over a credential. Each is a two-line change (fail closed instead of falling back) and
belongs to whoever owns that surface. The seed script's fallback is defensible; the other four are
not.

---

## Dependency audit

`npm audit --omit=dev` on 2026-08-16: **21 vulnerabilities — 1 critical, 18 high, 1 moderate, 1 low.**

Directly in the mail path:

| Package | Severity | Advisory | Fix |
| --- | --- | --- | --- |
| `nodemailer` | high | GHSA-p6gq-j5cr-w38f — message-level `raw` bypasses `disableFileAccess`/`disableUrlAccess`; arbitrary file read and full-response SSRF (CVSS 7.1) | 9.0.5, **major bump** |
| `mailparser` | high | via `linkify-it` and `nodemailer` | patch available |
| `linkify-it` | high | GHSA-v245-v573-v5vm — quadratic-complexity DoS via the `mailto:` validator on attacker text (CVSS 7.5) | patch available |
| `imapflow` | high | via `nodemailer` | patch available |
| `undici` | high | seven advisories including HTTP header injection via `Set-Cookie` percent-decoding and CRLF injection via a blob-like body `type` | patch available |

`linkify-it` deserves a note beyond its row: it is reached from `mailparser`, which parses **inbound
mail from strangers**, and the advisory is a quadratic-complexity denial of service triggered by
attacker-controlled text. That is the single most directly reachable dependency vulnerability in this
system.

Outside the mail path but worth stating: `tar` (critical), `astro`, `@astrojs/vercel`,
`@astrojs/node`, `vite`, `esbuild`, `path-to-regexp`, `sharp`, `svgo`, `js-yaml`, `nanoid`,
`devalue`, `brace-expansion`, `ip-address`, `postcss`.

**Recommendation.** Take the non-major fixes (`npm audit fix`) as one commit, verified with a build.
Handle `nodemailer` 8 -> 9 separately: it is the transport for every message this platform sends,
including password resets, and it needs its own verification pass against a real SMTP host. Do not
run `npm audit fix --force`, which would pull `astro` 5 -> 7.

---

## Secret scan

Scanned every tracked file except `node_modules/`, `dist/` and `downloads/` for private-key headers,
AWS access-key ids, provider key prefixes, Slack tokens, `service_role`, and JWT-shaped strings.

**Result: clean.** One match, and it is a false positive — the substring `sk-` inside the slug
`risk-analytics-intern-fintech` in `src/data/intern-catalog-phase3.ts:1410`.

No `.env*` file was opened; that is forbidden by the working rules and was not necessary. Note that
`.env.example` and a `.gitignore` negation admitting it were created by the concurrent session during
this pass, and `mail-engine/keys/` is gitignored there — which is the right handling for a DKIM
private key and is recorded here so it stays that way.

**Not covered by this scan, and worth a human's attention:** secrets that live in the **database**
rather than in files. `mail_config.smtp_pass`, `imap_pass`, `resend_api_key` and `inbound_secret` are
stored as plain `TEXT`. Anything with a read on that table — including a backup, an export, or a
mistaken support query — has the mail credentials. Encrypting them at rest requires a key management
decision and a migration, and is a proposal rather than a fix in this patch.

---

## What Patch 7 will do about each finding

| Finding | Planned |
| --- | --- |
| F-01 XSS via `define:vars` | Fix and regression-test |
| F-02 SSRF / credential oracle | Destination allowlist, port allowlist, rate limit, audit |
| F-03 nodemailer file and URL access | Set both flags, narrow the type, drop `path` mapping |
| F-04 no sending controls | Rate limiter, recipient caps, suppression, abuse detection, throttle/pause/lock |
| F-05 inbound webhook | Constant-time, header-only, size cap, HMAC path |
| F-06 tracking amplification | Caps, rate limits, recipient check |
| F-07 recipient geolocation | Opt-in setting, retention job — policy question raised |
| F-08 outbound HTML | Allowlist sanitiser before storage |
| F-09 no CSP | Report-only on mail surfaces first; enforcement proposed, not switched on blind |
| F-10 inbound secret in HTML | Mask with an audited reveal |
| F-11 `innerHTML` | `textContent` |
| F-12 imap-poll auth | Route through `cronAuth()`, POST for the session arm |
| F-13 committed fallbacks | Reported only — outside mail, belongs to those owners |
| Dependencies | Recommendation only — the upgrade is the user's call to schedule |
| DB-stored credentials | Proposal only — needs a key management decision |
