# Contacts, segmentation and campaigns

The contact/segmentation/campaign layer of EduRankAI Mail — Patch 5. This document covers what was
built, the decisions that are arguable, and the things that are **not** true yet.

---

## 1. Where it sits

This layer does not own its tables. `mail_contacts`, `mail_lists`, `mail_list_members`,
`mail_segments`, `mail_campaigns`, `mail_campaign_recipients` and `mail_campaign_events` are created
by the **core mail schema**, [`src/lib/mail-product/schema.ts`](../src/lib/mail-product/schema.ts).
Everything here calls `ensureMailProductSchema()` first and then runs
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the columns it needs on top.

**Why that matters and is not a style note:** `CREATE TABLE IF NOT EXISTS` is *silent* when the table
already exists with a different shape. A second definition of `mail_contacts` would not error — it
would no-op, and then every query in one of the two modules would fail at runtime, in production, on
a column that was never created. There is exactly one definition of each shared table.

Sending, SMTP, inbound and the webmail client belong to the other streams and were not modified,
with one exception noted in §10.

### Modules

| File | What it is | Pure? |
| --- | --- | --- |
| `src/lib/mail-personalize.ts` | `{{variable \| default:"…"}}` parsing and rendering | yes |
| `src/lib/mail-csv.ts` | CSV parse, column mapping, row validation, export, duplicate detection | yes |
| `src/lib/mail-segments.ts` | The segment tree, its SQL compiler, and an in-memory twin | yes |
| `src/lib/mail-schedule.ts` | Time zones, recurrence, due-ness | yes |
| `src/lib/mail-campaign-state.ts` | State machine, preflight gate, A/B split and winner maths | yes |
| `src/lib/mail-recipients.ts` | The recipient pipeline (pure) + audience loading and the queue | mixed |
| `src/lib/mail-contacts.ts` | Contact/list/segment/suppression persistence | no |
| `src/lib/mail-campaigns.ts` | Campaign lifecycle, sending, analytics | no |

Everything that can be pure is pure, because none of it can be tested against a database: the house
rule on this project is that nothing connects to production, and there is no staging database. 196
unit tests cover the pure half; §11 says plainly what that leaves untested.

### Screens

| URL | Purpose |
| --- | --- |
| `/admin/mail/contacts` | Search, filter, edit, bulk actions, CSV import, export, duplicates, suppression list |
| `/admin/mail/contacts/<id>` | One person: identity, consent, custom fields, lists, campaign and mail history, merge |
| `/admin/mail/lists` | Lists, saved segments, and the segment builder |
| `/admin/mail/campaigns` | Every campaign with its real progress |
| `/admin/mail/campaigns/<id>` | Compose, audience, preview, test, schedule, send, report, A/B |
| `/mail/unsubscribe` | The public opt-out page (no layout, no dependencies — see §7) |

### API

| Route | Method | Notes |
| --- | --- | --- |
| `/api/mail/contacts` | POST | create / update / delete / tag / list / merge / suppress |
| `/api/mail/contacts-import` | POST | `mode: 'plan'` writes nothing; `mode: 'commit'` writes |
| `/api/mail/contacts-export` | GET | CSV of the current filter |
| `/api/mail/segments` | POST | catalog / preview / save / delete / list / get |
| `/api/mail/campaigns` | POST | the whole campaign control surface |
| `/api/mail/campaign-cron` | GET/POST | the worker; `CRON_SECRET`, fails closed |
| `/api/mail/c/open` | GET | open pixel |
| `/api/mail/c/click` | GET | click redirect (id-based, never an open redirect) |
| `/api/mail/unsubscribe` | POST | one-click opt-out (RFC 8058) |

Admin routes are gated by `denyAdminApi(locals, { permission: 'mail.manage' })` on their first line,
before the body is read and before any DDL runs.

---

## 2. Two engines on one table

The core stream also has a campaign engine (`src/lib/mail-product/campaigns.ts`, dispatched per
campaign from `/api/mail/product/campaigns`). Both write to `mail_campaigns`. They are kept apart by
two facts, and **both are load-bearing**:

* `mail_campaigns.engine` — `'core'` by default (so every existing row and anything the core creates
  is untouched), `'p5'` for campaigns created here. Every sweep in `mail-campaigns.ts` is narrowed to
  `engine = 'p5'`.
* Recipient status — the core dispatcher claims rows in status `queued`; this engine writes and
  claims `pending`.

Without the first, `drainDueCampaigns()` would pick up a core campaign, find no `pending` recipients,
and mark it **completed** while its real audience had never been sent to.

Segments are the same story: the core stores `{"match":"all","conditions":[]}` in `rules`, this
engine stores a nested AND/OR/NOT tree in `definition`. Two languages, two columns, and
`listSegments()` here filters `definition IS NOT NULL` so a core-authored segment is never offered to
an engine that cannot read it.

**This is a seam, not a design.** One campaign engine would be better than two. Merging them is a
decision for whoever owns the roadmap, not something to do silently inside a patch.

---

## 3. The recipient pipeline

`resolveRecipients()` is pure and runs in this order, which is not arbitrary:

```
audience → deduplication → exclusions → suppression → subscription status → address shape → queue
```

* **Deduplication first** so a person on three lists is counted against suppression once, not three
  times. Otherwise the skip counts on the confirmation screen are inflated and an operator cannot
  tell 900 real people from 300 people listed three times.
* **Suppression before the contact's own status**, because suppression is keyed by *address* and
  survives the contact record. A contact deleted and re-imported is caught here and nowhere else.
* Every candidate ends up either accepted or skipped **with a reason**; nobody vanishes. The reasons
  are stored on the recipient row, so "why didn't X get this?" is answerable months later.

The preview and the send call the same function. A preview computed by different code from the send
is a preview that lies.

### Suppression outlives the contact

Deleting a contact does **not** delete their suppression row. Delete-then-reimport is the ordinary
way an unsubscribed person gets mailed again, and this is where it is stopped. A **complaint** can
never be released by an admin: re-mailing somebody who reported mail as spam damages delivery for
everyone else on the domain.

---

## 4. Segmentation

A segment is a tree:

```jsonc
{ "type": "group", "op": "and", "children": [
  { "type": "cond", "field": "organization", "op": "eq", "value": "IIT Guwahati" },
  { "type": "cond", "field": "application_stage", "op": "gte", "value": 3 },
  { "type": "cond", "field": "status", "op": "eq", "value": "subscribed" }
]}
```

Fields: `email`, `name`, `first_name`, `last_name`, `organization`, `phone`, `role_title`, `status`,
`tag`, `list`, `custom:<key>`, `created_at`, `last_activity_at`, `consent_at`, `activity:<kind>`,
`application_stage`, `product_usage`. Operators cover equality, substring, set membership, presence,
date windows and stage ordering. `not` is available on a group and on a single condition.

**Everything is evaluated server-side.** The browser sends a tree; it never sends SQL, never sends a
contact id list, and never decides who matches.

**Injection.** Column names never come from input — a field key is looked up in a hard-coded catalog
and only its fixed expression is emitted. Values are always bound parameters, including a custom
field's *key* (`c.fields ->> $1`). Multi-value operators emit
`IN (SELECT jsonb_array_elements_text($n::jsonb))` rather than `= ANY(array)`, because postgres-js
serialises a JS array as a record literal and Postgres answers *"cannot cast type record to text[]"* —
the fault documented in `src/lib/pg-array.ts`.

**Two implementations, deliberately.** `compileSegment()` produces SQL; `evaluateSegment()` answers
the same question in memory. They share a test suite. Segmentation's classic bug is a preview that
says 412 and a send that reaches 3,000, and keeping the two side by side is what stops them drifting.

### Two decisions worth arguing with

* **Stage ordering excludes closed stages.** `stage >= 3` returns assessment, interview, decision,
  onboarded — never `withdrawn` or `decision_no`. A withdrawn application has no position on the
  funnel, and including it would mail a "you've reached stage 3" note to somebody who withdrew.
  `eq` still matches a closed stage.
* **An empty group matches its operator's identity.** AND of nothing is everyone; OR of nothing is
  nobody. Both are mathematically right and both are catastrophic to discover after a send, so
  `validateSegment()` reports each as a warning and the send gate treats match-everyone as a risk.

---

## 5. Personalisation

```
{{first_name}}                          renders blank if unknown
{{first_name | default:"Applicant"}}    renders "Applicant"
{{custom.university | default:"your university"}}
```

**A variable never renders as itself.** "Hi {{first_name}}," reaching a real inbox is the single most
recognisable failure of a mail system, and it happens when a renderer leaves an unresolved token in
place. Here an unresolved token renders as its default or as nothing.

Merged **values** are HTML-escaped in the HTML renderer. A contact whose organisation is
`Sharma & Co <b>` must not be able to inject markup into mail sent to thousands of other people.

`variablesWithoutFallback()` drives a preflight **warning** (not a blocker): the composer lists every
variable with no declared default, and the per-recipient preview shows which will actually be blank
for the sample contacts.

---

## 6. Campaigns

States and the transitions between them live in `campaignTransition()`; **no function writes a status
it invented**. A campaign that could go from `completed` back to `sending` would one day send twice.

```
draft ──schedule──▶ scheduled ──queue──▶ queued ──start──▶ sending ──complete──▶ completed
  └────────────────────queue────────────────▲                 │
                                            ├──pause──▶ paused ──resume──▶ sending
failed / cancelled ──reopen──▶ draft        └──cancel──▶ cancelled
```

Content and audience freeze once a campaign leaves `draft`/`failed`. Reopening as a draft discards
the resolved recipient set, because it was resolved against yesterday's contact book.

### Safety

`preflight()` returns **blockers** and **warnings**, and the split is a policy statement:

| Blocks the send | Warns only |
| --- | --- |
| zero recipients; empty subject or body; no from address; no audience; a broken segment; no SMTP transport; **no unsubscribe link on a bulk send**; an unconfirmed large send; a state that cannot be queued | a segment that matches every contact; variables with no default; a near-identical campaign sent in the last 24 h; more addresses removed than remain |

A warning that blocked would train operators to click through; a blocker that only warned would one
day post a blank template to the whole contact book.

Above **500 recipients** the operator must type the exact recipient count back before the send button
enables. Race conditions are handled in three places at once: the campaign status transition repeats
the expected `from` state in its `WHERE`, the campaign claim takes a ten-minute lease, and
`mail_campaign_recipients` has a unique index on `(campaign_id, lower(email))` so a double click, an
overlapping cron and a retry after a timeout all converge on the same rows instead of doubling them.

### Recurrence

A repeating campaign creates its **next run as a new campaign** when it finishes, rather than
resetting itself. Reusing one row would overwrite last week's report every week, and "the newsletter"
would have no history at all.

### A/B testing

Vary the subject, the body, or the CTA; `testPercent` of the audience is split evenly across variants
and the rest is **held back** until a winner is promoted. Assignment is a stable FNV-1a hash of
`campaignId + email`, so re-resolving an audience puts everybody back in the bucket they were in — a
resumed or retried campaign cannot mail one person variant A and then variant B.

`pickWinner()` always names the leader (that is what the dashboard shows) but reports `confident`
separately, from a two-proportion z-test with a 50-per-variant floor. Promoting a leader that sits
inside the margin of error requires an explicit override. Calling a winner off eleven opens is how
A/B testing becomes superstition.

---

## 7. Unsubscribe

`/api/mail/unsubscribe` takes a contact id and that contact's own random `unsub_token`. **No session,
no CSRF token, no confirmation step:**

* No session, because the recipient is almost never a user of this platform and demanding a sign-in
  to stop marketing mail is both a dark pattern and a legal problem.
* No CSRF token, because RFC 8058 one-click means the recipient's *mail provider* POSTs on their
  behalf, with no page load and no cookie. A CSRF check would make the `List-Unsubscribe-Post` header
  we advertise fail silently — and providers judge a sender for advertising a header that does not
  work.
* The worst a forged request can do is unsubscribe somebody who did not ask, which a human can
  reverse. That is enormously less harmful than an opt-out that does not work.

`/mail/unsubscribe` (the browser page) shows a **button** rather than unsubscribing on load: mail
clients and security scanners pre-fetch links, and a GET that opted people out would unsubscribe
people who never clicked. The page is self-contained — no layout, no fonts, no framework — so a
change to the site shell cannot break an opt-out.

Unsubscribing also clears that person from **every other campaign's pending queue** immediately, not
at the end of the current batch.

---

## 8. Tracking

* **Opens** — a 1×1 GIF at `/api/mail/c/open?r=<recipientId>`. It always returns the pixel, whatever
  goes wrong, so a tracking failure never draws a broken image in somebody's mail.
* **Clicks** — `/api/mail/c/click?r=<recipientId>&l=<linkId>`. The destination is looked up **by id**
  from `mail_campaign_links`. Taking the URL from the query string — the obvious design — would turn
  edurankai.in into a redirector anyone could point at a phishing page. There is no signing scheme
  simpler than not accepting the URL.
* The **unsubscribe link is never rewritten**. Routing an opt-out through a click tracker means a
  tracker outage becomes an inability to unsubscribe.

Rates are computed over **distinct recipients**, not raw events — one person opening six times is one
opener, and conflating them produces open rates above 100%. A rate with a zero denominator renders as
`—`, never as `0.0%`.

---

## 9. Reputational streams

Campaign mail and transactional mail are kept apart at this layer by:

* a separate From address (`campaigns@` by default) per campaign,
* an `X-ERA-Stream` header and `Precedence: bulk` on campaign mail,
* `List-Unsubscribe` + `List-Unsubscribe-Post` on campaign mail only — an application update is not
  marketing, and unsubscribing from it would leave somebody uninformed about their own application,
* campaign traffic logged to `mail_campaign_recipients` / `mail_campaign_events` rather than
  `email_logs`, so it does not double every count on `/admin/mail/analytics`,
* suppression that applies to campaigns while leaving transactional mail alone.

**What this does not do:** put the two streams on different IPs or subdomains at the MTA. That is a
mail-server change and belongs to the infrastructure stream. The headers above are the control plane;
they do not by themselves isolate reputation.

---

## 10. The one change to another stream's file

`SendExternalParams` in `src/lib/mail-transport.ts` gained an optional `headers` field, passed
through to nodemailer. Bulk mail needs `List-Unsubscribe`, `List-Unsubscribe-Post` and
`Precedence: bulk`; there was no way to set them. Callers that pass no headers produce byte-identical
mail to before.

---

## 11. Testing, and what is not tested

196 unit tests across six suites (`npx vitest run src/lib/mail-*.test.ts`):

| Suite | Covers |
| --- | --- |
| `mail-csv.test.ts` | RFC4180 parsing (quotes, embedded newlines, CRLF, BOM), ragged rows, delimiter detection, column mapping, email validation, in-file deduplication and merge, most-restrictive-status-wins, CSV-injection neutralisation, round-trip, a 20,000-row file |
| `mail-segments.test.ts` | Every operator in memory, AND/OR/NOT nesting, empty-group identity, stage arithmetic, the compiler's parameterisation, custom-key and list-id rejection, LIKE escaping, no `= ANY(array)`, depth limits, the worked example from the brief |
| `mail-recipients.test.ts` | The pipeline order, dedup-before-suppression, exclusion precedence, every skip reason, transactional widening, purity, a 56,000-candidate audience |
| `mail-campaign-state.test.ts` | Every transition and every refusal, the preflight blocker/warning split, the confirmation threshold, A/B validation, split stability across re-resolution, hold-back sizing, winner confidence |
| `mail-schedule.test.ts` | IST and DST zones, the spring-forward gap, round-tripping, daily/weekly/monthly recurrence, month-end clamping, `until`/`count`, lateness |
| `mail-personalize.test.ts` | Token grammar, defaults, blank-not-token, HTML escaping of values, custom fields, the recruitment worked example |

**Not covered by automated tests, and this is a real gap:** everything that touches the database.
`commitImport`, `mergeContacts`, `queueCampaign`, `sendCampaignBatch`, the claim/lease race guards and
the tracking endpoints have no test, because this project forbids connecting to the production
database and has no test database. The pure cores of those paths *are* tested — the resolver, the
state machine, the preflight — but the SQL is verified by reading it, not by running it. A disposable
Postgres (a container, or a Neon branch) would close this; that is a piece of infrastructure work,
not something this patch could invent.

**No load test was run against public recipients**, per the brief. `send-batch` and the test-send path
refuse any address that is not an `@edurankai.in` mailbox or the signed-in operator's own.

---

## 12. Operational facts, stated rather than glossed

* **The cron runs once a day.** Vercel's Hobby plan allows daily crons only, so
  `/api/mail/campaign-cron` fires at 07:30 UTC. A campaign scheduled for 14:00 goes out at the next
  daily run unless somebody presses **Send the next batch now** on the campaign screen, which calls
  the same code. Moving to a paid plan and a `*/5 * * * *` schedule is a one-line change in
  `vercel.json`. Until then, scheduled sends are late by up to a day.
* **`CRON_SECRET` must be set**, with no whitespace. The worker fails closed: with no secret,
  campaigns stop going out *visibly* (they stay `scheduled`) rather than the URL standing open to
  anyone who can drive the company's bulk mailer.
* **"Delivered" means accepted by the receiving server**, not confirmed in a mailbox. Our own SMTP
  returns an acceptance; there is no delivery webhook. The dashboard says so where the number is read.
* **Opens are an indicator, not a headcount.** They fire when a client loads remote images; many
  clients block that and a few pre-load it.
* **The audience resolver caps at 100,000 contacts** per campaign and reports when it truncates. A
  truncated audience that looks complete is how a campaign quietly reaches two thirds of its list.
* **CSV import caps at 2 MB** (roughly 25,000 contacts) per request and says so rather than failing
  silently.

---

## 13. Recruitment use case

The brief's example works end to end:

1. `/admin/mail/lists` — build a segment: `Organisation is IIT Guwahati` **AND**
   `Application stage is at or after stage Assessment` **AND** `Subscription status is subscribed`.
   Preview shows the live count and a sample.
2. `/admin/mail/campaigns` — create *Stage 3 progression*, write the body with
   `{{first_name | default:"Applicant"}}`, `{{role}}`, `{{stage}}`, `{{application_id}}` and
   `{{unsubscribe_url}}`.
3. Pick the segment as the audience, **Check who this reaches**, read the skip breakdown, send a test
   to your own mailbox, then confirm and send.

The stage and application number come from a `LEFT JOIN LATERAL` onto `applications` by address —
the applicant's most recent application. Stage names are read from
`src/lib/application-stages.ts`, so the six-step funnel has one definition.
