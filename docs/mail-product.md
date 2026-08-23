# EduRankAI Mail — the product surface (`/mail/*`)

Patch 3. This document is for the other three agents and for whoever picks this up next: what was
built, where the seams are, and what is deliberately **not** here.

---

## 1. What this is

A complete user-facing mail product at `/mail/*`: a Gmail-shaped mailbox, a MailerLite-shaped
campaign platform, an email builder, an automation canvas, analytics, domains, API keys and
webhooks.

It is a **second UI in front of the existing mail engine**, not a second mail engine.

| Layer | Owner | This patch |
|---|---|---|
| Delivery, threading, folders, search | `src/lib/mail.ts` | untouched except one additive option |
| SMTP transport | `src/lib/mail-transport.ts` | **untouched** — called, never modified |
| Inbound / IMAP poll | `src/pages/api/mail/inbound.ts`, `imap-poll.ts` | **untouched** |
| Signature, labels, rules, scheduling | `src/lib/mail-advanced.ts` | untouched |
| Write endpoints `send` / `draft` / `action` | `src/pages/api/mail/*` | **untouched** — the composer posts to them as-is |
| HTML sanitiser | `src/lib/mailsec/html.ts` | adopted (see §7) |
| Audience, campaigns, templates, automations, domains, keys | `src/lib/mail-product/*` | **new** |

The single change to an existing engine file is an **optional** `before` cursor on
`ListFolderOptions` (`src/lib/mail.ts`). Omitting it is exactly the previous behaviour, and
`MailClient.astro` still passes nothing. It exists because keyset paging is the only way a mailbox
list stays constant-cost as it grows.

---

## 2. Routes

### Pages
```
/mail                          Dashboard
/mail/box/[folder]             Mailbox — inbox|starred|sent|drafts|archive|spam|trash
/mail/contacts                 Audience list (keyset paged)
/mail/contacts/[id]            Contact profile
/mail/contacts/lists           Lists, segments, custom fields
/mail/contacts/import          CSV import (preview then commit)
/mail/campaigns                Campaign list
/mail/campaigns/[id]           Wizard (draft) or report (queued onwards)
/mail/campaigns/[id]/design    Email builder
/mail/templates                Templates
/mail/templates/[id]           Builder + version history
/mail/automations              Automations
/mail/automations/[id]         Visual workflow canvas
/mail/analytics                Delivery, engagement, domain performance
/mail/domains                  SPF / DKIM / DMARC / MX
/mail/mailboxes                Who holds a mailbox (read-only)
/mail/api                      API keys + webhooks
/mail/settings                 Profile, identity, infrastructure, security
/mail/unsubscribe              PUBLIC — no sign-in (see §6)
```

### API — all under `/api/mail/product/` so it cannot collide with the infrastructure routes
```
GET  threads         ?folder&q&label&before&limit    keyset page of the mailbox
GET  contacts        ?q&status&listId&segmentId&tag&cursor&limit
POST contacts        create|update|status|delete|bulk-status|bulk-list|bulk-tag|count
POST contacts-io     preview|import         GET contacts-io → streaming CSV export
GET  audience        lists + segments + custom fields
POST audience        list-* | segment-* | field-*   (segment-count = live count of unsaved rules)
GET  campaigns       ?id | ?status&q
POST campaigns       create|save|schedule|queue|pause|resume|cancel|test|dispatch|duplicate|delete
GET  templates       ?id | ?id&versions | ?kind&q
POST templates       render|create|save|duplicate|active|restore|delete
GET  automations     ?id | list
POST automations     validate|create|save|activate|pause|delete
GET  settings        domains + keys + webhooks
POST settings        domain-*|key-*|hook-*
POST signature       this person's own signature
```

Every route calls `denyMailApi()` **on its first line**, before the body is read and before any
statement runs. Same gate as `send`/`draft`/`action`, so what you can open and what you can do
cannot disagree.

---

## 3. New tables

`ensureMailProductSchema()` in `src/lib/mail-product/schema.ts`, following the idiom already used by
`ensureMailSchema()` and `ensureMailAdvancedSchema()`: idempotent `CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS`, run once per process through `ensureOnce()`. **Nothing drops or rewrites
anything** — `email_templates` holds live rows and is only extended.

```
mail_contacts          mail_lists            mail_list_members     mail_segments
mail_contact_fields    mail_template_versions
mail_campaigns         mail_campaign_recipients   mail_campaign_events
mail_automations       mail_automation_runs
mail_domains           mail_api_keys         mail_webhooks         mail_webhook_deliveries
email_templates  +blocks +kind +version +is_system +created_by +preheader
```

**This has not been run against any database.** Per `CLAUDE.md` I do not connect to one. See §9.

---

## 4. The campaign state machine

Declared once in `schema.ts` as a table, asserted in `schema.test.ts`, and read by the UI badge, the
list filter and the dispatcher — so they cannot disagree.

```
draft ──▶ scheduled ──▶ queued ──▶ sending ──▶ completed
  │           │            │  │       │
  │           └────────────┴──┴───────┴──▶ cancelled
  │                        │       └──▶ paused ──▶ queued
  └────────────────────────┴──────────▶ failed ──▶ queued
```

`queued → failed` is legal deliberately: `dispatchBatch()` refuses **before claiming a single
recipient** when no SMTP transport is configured, and records that as `failed`. If the machine
forbade the move the row would stay `queued` while the response said `failed`.

### Dispatch
`POST campaigns {action:'dispatch'}` sends **one batch (default 25) and returns `remaining`**. The
sending screen loops while `remaining > 0`; a cron can call the same endpoint. Rationale:

* a serverless request is never asked to hold a 50,000-message send open;
* each recipient row is claimed with `UPDATE … RETURNING … FOR UPDATE SKIP LOCKED` **before** its
  message is built, so two concurrent dispatchers cannot both take the same person;
* the unique index on `(campaign_id, lower(email))` makes queueing re-runnable;
* closing the tab pauses rather than loses — reopening resumes from where the rows say it stopped.

`completed` means **every recipient was attempted**, not that every one succeeded. Failures are a
separate count and are never folded in.

---

## 5. The email builder

`src/lib/mail-product/blocks.ts` is the **only** renderer. The builder canvas, the desktop preview,
the mobile preview, the HTML tab and the bytes that are sent all come from `renderDocument()` — the
browser posts the document to `POST templates {action:'render'}` and puts the answer on the canvas.
There is no second renderer in JavaScript to fall out of step with it.

Output is nested `<table>` with inline styles and `[if mso]` conditionals, because desktop Outlook
renders through Word: no flexbox, no grid, no reliable float, and `<style>` stripped in several
configurations.

Twelve blocks: heading, text, image, button, divider, spacer, columns, social, quote, html, footer,
signature. Properties: font stack, size, weight, line height, letter spacing, alignment, colour,
background, four-sided padding, border width/colour/radius.

Two decisions worth knowing:

* **Social links are text labels, not logos.** A brand mark is that company's trademark on our
  message, needs a hosted asset most clients block, and this product's rules forbid naming other
  companies in user-facing copy.
* **A footer with no `{{unsubscribe_url}}` gets one appended.** A bulk message without a working
  opt-out is what gets a sending domain blocked.

---

## 6. Merge variables — where they work, and where they do not

`/admin/mail/templates` carries a comment saying the `{{variables}}` promise was empty, because
"one message row is addressed to many recipients, so a per-person merge is not a wording change — it
is a different send model."

That is still true, and it is respected:

| Path | Per-person? | Behaviour |
|---|---|---|
| Campaigns, automations | **yes** — one row per person in `mail_campaign_recipients` | variables are filled |
| `/api/mail/send` (the composer) | no — one message, many recipients | variables go out **literally** |

The composer says so, in a toast, at the moment somebody inserts one.

**An unfillable token becomes empty text on a real send — never the literal `{{first_name}}`.** That
is the first assertion in `personalize.test.ts`.

---

## 7. Security decisions you may want to challenge

1. **External message bodies are not rendered as HTML in this application.** An inbound message is
   authored by whoever sent it; rendering its markup inside an authenticated console is the classic
   mail-client hole. Internal mail renders through `sanitizeEmailHtmlString(…, ORIGIN)`; anything
   else renders as **text**, with the original available in `<iframe sandbox="">` via `ISOLATED`.
   The trade is real: external marketing mail looks plainer here than in a consumer client.
2. **The allow-list is `src/lib/mailsec/html.ts`**, not a local copy. (That module arrived from
   another agent mid-patch and this surface was rewired onto it — the reading pane, the campaign
   renderer and the composer must not each carry their own idea of what is safe.)
3. **API keys are SHA-256 only.** `key_prefix` is twelve characters so a list can identify a key.
   There is no reveal path and no code that can reconstruct one. Revoked keys are kept, not deleted.
4. **Webhooks must be https** — delivery events carry recipient addresses. Twenty consecutive
   failures switch an endpoint off.
5. **Suppression is one-way.** `upsertContact()` cannot raise a status. Only an explicit, confirmed
   `setContactStatus()` can resubscribe somebody. Re-uploading a spreadsheet is the ordinary way a
   suppression list gets wiped.
6. **`audienceSql()` checks two suppression sources, not one.** `mail_contacts.status` is this
   product's view of a person; `mail_suppression` (owned by `src/lib/mail-contacts.ts`, keyed by
   **email**) is the whole platform's — written by bounce handling, the transactional API and the
   one-click unsubscribe endpoint. An address can sit in it with no contact row, or while a contact
   row still reads `subscribed`. Filtering on status alone would mail somebody who had asked another
   part of this platform to stop.

   That table is **declared in two places**: `mail-contacts.ts` owns it, and
   `ensureMailProductSchema()` mirrors it. The mirror exists because `mail-contacts.ts` already
   imports `ensureMailProductSchema()`, so calling `ensureContactSchema()` from here would leave two
   `ensureOnce()` caches awaiting each other's in-flight promise — a deadlock. `schema.test.ts` reads
   both files and fails if the column lists ever drift.
6. **A campaign with no list and no segment matches nobody, not everybody** (`audienceSql()` ends in
   `FALSE`). A campaign that silently addressed the whole database is not a recoverable mistake.
7. **`/mail/unsubscribe` does not act on GET.** Mail clients and security gateways prefetch every URL
   in a message; a one-click GET opt-out unsubscribes people who never saw the page. GET renders a
   button, POST does the work. It answers identically for a known and an unknown id, so it is not an
   oracle for testing whether an address is in the system.
8. **`/mail/domains` never renders a failed lookup as an absent record.** `/api/mail/dns-check.ts`
   distinguishes the two and this screen keeps a fourth state, `unchecked`. `recordCheck()` refuses
   to downgrade a verified record on the strength of a lookup that did not complete — because the
   documented next step on that screen is "add a DNS record", and a **second** SPF record makes the
   domain fail SPF outright.

---

## 8. Performance

* **Mailbox list is virtualised** (`public/mail/mailbox.js`): a plain data array, ~20 DOM nodes on
  screen whatever the total. Row markup is defined **once**, in `<template id="mbRow">`.
* **Keyset paging everywhere**, never `OFFSET`. `OFFSET 900000` walks and discards 900,000 rows and
  silently skips rows when something is inserted between requests.
* **Totals counted once**, on the first page only, never per scroll.
* **CSV export streams** in 500-row pages inside a `ReadableStream`; the row cap is *declared in the
  file* when hit, because a truncated export that looks complete is the one somebody reconciles
  against.
* **Analytics aggregate in Postgres.** No raw event table reaches the browser.
* **Code splitting without a bundler**: the composer, builder and automation canvas load on demand.
  Reading your inbox downloads none of them.
* **Charts are server-rendered inline SVG** — no chart library, no client JS.

Rough client-JS weight per surface (uncompressed, no framework anywhere):

| Surface | JS |
|---|---|
| Any page (shell) | `app.js` ~7 KB |
| Mailbox | + `mailbox.js` ~13 KB |
| Composer (on demand) | + `compose.js` ~16 KB |
| Builder (on demand) | + `builder.js` ~21 KB |
| Automation canvas | + `automation.js` ~17 KB |
| Dashboard / analytics | shell only |

---

## 9. What has NOT been verified, and how to verify it

`CLAUDE.md` forbids me connecting to a database or running anything that opens one, so:

* **The schema has never been created.** `ensureMailProductSchema()` runs on the first request to any
  `/mail` page or `/api/mail/product/*` route and is idempotent, but it has not been executed.
* **No page has been loaded against real data.** Everything below is what *was* checked.

Verified:

* `npm run build` — all 120 `/mail` and `/api/mail/product` routes compile and bundle
  (clean run at 18:12; see the note in §10 about the current break).
* `npx vitest run src/lib/mail-product` — **124 tests passing** across 5 files
  (`blocks`, `personalize`, `automations`, `common`, `schema`).
* `node --check` on all 11 client scripts.
* CSS brace balance on all three stylesheets.

To verify against the real system, run these yourself:

```bash
npm run dev
# then, signed in as an account that clears canUseMailbox():
#   http://localhost:4321/mail                    dashboard loads, tiles populate
#   http://localhost:4321/mail/box/inbox          list virtualises, search works, star flips
#   http://localhost:4321/mail/contacts           first page + "Load 50 more"
#   http://localhost:4321/mail/templates          create → builder → save → version history
#   http://localhost:4321/mail/campaigns          create → design → test send → queue
#   http://localhost:4321/mail/domains            "Check now" against a real domain
```

The first request creates the tables. Watch the server log: `ensureOnce` prints the real Postgres
reason (`e.cause.message`) on failure rather than swallowing it.

---

## 10. Known issues and handover

**The repository build is currently broken by `src/lib/mailplatform/`, not by this patch.** That
module is being written by another agent while this was built, and the break moved twice in an hour:

1. `service.ts` imported `validateWorkflow` from `graph.ts`, which did not export it. *(now fixed)*
2. `adapters/transport-smtp.ts:16` — an automated edit inserted

   ```ts
   import { appendLinkAttachments } from '@/lib/mailsec/link-attachments';
   ```

   **into the middle of an existing `import type { … }` block**, so esbuild fails with
   `Expected "as" but found "{"`. The fix is to move that line above or below the `import type`
   block. *(left alone deliberately — the file was being actively written, and editing it mid-write
   would race whatever wrote it)*

Nothing under `src/lib/mail-product`, `src/pages/mail`, `src/pages/api/mail/product` or
`src/components/mail` imports `mailplatform` — verified by grep. This patch built cleanly end to end
(all 120 routes) before that module landed, and `astro check` reports **zero errors across every file
in it** as of the last run.

Left for the backend/infra agents:

* **Automation execution.** The graph, its validator, the canvas and `mail_automation_runs` are here.
  The runner that walks a contact through the graph is not, and would want a queue rather than a
  request. (Another agent appears to be building exactly this in `src/lib/mailplatform/`.)
* **Open and click tracking for campaigns.** The transactional path already has a pixel and a click
  redirector (`/api/mail/track`, `/api/mail/click`). Campaign sends write `sent`/`failed` to
  `mail_campaign_events`; `opened`/`clicked`/`bounced`/`delivered` need the same treatment pointed at
  that table. Until then the analytics screens show those figures as zero — which they are, honestly.
* **Bounce and complaint ingestion.** Nothing currently writes `bounced` or `complained`.
* **Scheduled campaign dispatch.** `scheduled` campaigns need a cron calling
  `POST campaigns {action:'queue'}` then `{action:'dispatch'}`. Hobby crons here are daily-only.
* **Webhook fan-out.** `deliverWebhook()` sends and records one attempt. Nothing yet calls it when a
  real event occurs, and retries are the caller's decision by design.
