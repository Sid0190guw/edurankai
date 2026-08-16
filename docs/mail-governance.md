# EduRankAI Mail — enterprise administration, compliance controls, audit and data governance

Patch 14. This document describes what was built, what each control actually guarantees, and — in the
last section — what it does not do yet.

**This is not a compliance certification and nothing here claims one.** No statement in this codebase
says that a control satisfies a named regulation. What the platform provides is a set of *technical
controls* — retention, consent, access control, auditability, export, deletion — that an organization
configures to match obligations their own counsel identifies. Which number is correct for a given
customer is their decision; the platform's job is to make the dial real, refuse settings that would
break its own guarantees, and record who moved it.

---

## 1. Where everything lives

| Concern | Pure (tested, no database) | Database-backed |
|---|---|---|
| Authorisation | `src/lib/mailgov/policy.ts` | `src/lib/mailgov/guard.ts` |
| Audit | `src/lib/mailgov/audit-chain.ts` | `src/lib/mailgov/audit.ts` |
| Retention | `src/lib/mailgov/retention-policy.ts` | `src/lib/mailgov/retention.ts` |
| Consent | `src/lib/mailgov/consent-policy.ts` | `src/lib/mailgov/consent.ts` |
| Export | `src/lib/mailgov/export-plan.ts` | `src/lib/mailgov/exports.ts` |
| Deletion | `src/lib/mailgov/deletion-plan.ts` | `src/lib/mailgov/deletion.ts` |
| Support access | `src/lib/mailgov/support-policy.ts` | `src/lib/mailgov/support.ts` |
| Security events | `src/lib/mailgov/security-policy.ts` | `src/lib/mailgov/security-events.ts` |
| Admin search | `src/lib/mailgov/search-parse.ts` | `src/lib/mailgov/search.ts` |
| Legal hold | — | `src/lib/mailgov/holds.ts` |
| AI processing register | — | `src/lib/mailgov/ai-records.ts` |
| Schema + health | — | `src/lib/mailgov/schema.ts`, `health.ts` |

The split is deliberate: **every decision** is in the pure column, so it can be tested exhaustively
without a database connection. The database column reads, writes and reports failures.

Console: `src/pages/admin/mail/enterprise/*.astro`. API: `src/pages/api/mail/gov/*.ts`.

Tables are all prefixed `mailapi_` — the same namespace as the rest of the mail platform
(`src/lib/mailapi/schema.ts`), because governance administers that platform rather than being a
separate product. Schema is self-bootstrapping (`ensureGovernanceSchema()`), matching the established
contract in this repository: there is no migration runner, and `.dev-scripts` migrations are run by
hand.

---

## 2. Authorisation

### Roles

| Role | Scope | Summary |
|---|---|---|
| `platform_owner` | platform | Everything, including the four owner-only powers below |
| `platform_admin` | platform | Everything except `org.delete`, `support.content.approve`, `hold.release`, `platform.grant` |
| `org_admin` | one tenant | Full administration of their own organization |
| `support` | platform | Message **metadata** and retries. Can *request* content access, never approve it |
| `auditor` | platform or tenant | Read-only, including audit export. No writes at all |
| `none` | — | No governance access |

The four powers withheld from a platform administrator are each irreversible, or make every other
control reversible. Splitting them off lets the audit trail answer "who could have done this" with a
name rather than a group.

### How somebody becomes an actor

`resolveGovActor()` in `guard.ts`, five arms, narrowest first, each composing an answer that already
exists in this repository:

1. **The founder**, by `FOUNDER_EMAIL` — the same test `src/lib/legal-hold.ts` uses.
2. **An explicit platform grant** (`mailapi_platform_admins`) → `platform_admin` / `support` / `auditor`.
3. **`settings.edit`** in the EduRankAI permission matrix (super admin only today) → `platform_admin`.
   This preserves the state of the world before this patch: the people who already administer mail
   configuration continue to administer the platform.
4. **An active organization membership** → `org_admin` (owner/admin) or `auditor` (analyst).
   `member` and `service` get nothing: a membership row is not an administrative grant.
5. Otherwise `none`.

Every arm fails closed. A thrown lookup logs the real Postgres reason (`e.cause`) and falls through
to a narrower role; it never admits anybody.

### The three refusals

`authorizeGov(actor, capability, target)` is the single entry point. It refuses for exactly one of
three reasons, deliberately not collapsed:

- **`capability-missing`** — the role does not carry the ability.
- **`cross-tenant` / `tenant-required`** — the ability exists, the target belongs to another tenant,
  or no tenant was named for something that needs one. Checked on **every call including reads**.
- **`self-target` / `role-escalation` / `peer-or-above`** — would hand the actor, or somebody they
  control, more authority than they hold.

Nobody may grant a role at or above their own rank; nobody may act on a peer or superior; nobody may
change their own role or suspend themselves. Revoking your *own* sessions stays allowed — that is the
correct response to suspecting a compromise.

### Writes are recorded before they happen

`auditedWrite()` writes the audit event **first** and refuses to perform the action if it cannot be
written. If the work then throws, a second event with `result: 'failed'` is appended. This is the only
ordering that cannot produce an action nobody can prove happened.

Denials are recorded too — as an audit event *and* a security event. A refusal that leaves no trace is
indistinguishable from a mistyped URL.

---

## 3. Audit

`mailapi_audit_events` is append-only and hash-chained:

- `content_hash` = SHA-256 over the event's own fields, canonicalised (sorted JSON keys, NUL sentinel
  for null, unit separator between fields so characters cannot be moved across a field boundary).
- `hash` = SHA-256(`prev_hash` ‖ `content_hash`).
- `prev_hash` is **UNIQUE**, so two concurrent appends produce one success and one retry rather than a
  silently forked chain.

**Enforcement.** A database trigger (`mailapi_audit_no_change`) refuses `UPDATE` outright and refuses
`DELETE` unless the transaction has set `mailgov.prune` — which exactly one function does
(`pruneAuditLog()`). If the trigger could not be created (a role without `CREATE FUNCTION`, say), the
platform still runs and `governanceHealth()` **reports that the guarantee is weaker**: enforced by
convention rather than by the database. The difference is visible on screen rather than assumed.

**What this is not.** It is tamper-*evident*, not tamper-*proof*. Somebody who can rewrite the whole
table can recompute a chain. The only defence against that is an **external anchor**: the audit screen
prints a line naming the head sequence and hash, meant to be recorded somewhere this database cannot
reach. If next month's chain does not contain last month's hash, the log was rebuilt. This is the part
everybody skips.

**Verification** covers a *window* — the most recent N events, anchored to the event before them — and
says so. A green tick that quietly means "the last twenty" would be worse than none.

**Pruning** (audit retention) writes a checkpoint first: the range removed, the count, and the hash the
surviving chain links back to. Audit retention is a **platform** policy, not a per-tenant one: the
chain is one chain across every tenant, and removing one tenant's rows from the middle would break
every link that crosses them.

Actions named by the brief are constants in `AUDIT_ACTIONS` (`user.created`, `user.suspended`,
`domain.added`, `mailbox.created`, `campaign.sent`, `campaign.cancelled`, `api_key.created`,
`api_key.revoked`, `security.policy.changed`, and the rest).

---

## 4. Retention

Eight classes: `messages`, `attachments`, `delivery_events`, `campaign_events`, `audit_logs`,
`ai_records`, `security_events`, `consent_records`. The brief names six; `security_events` and
`consent_records` are additions, called out here rather than smuggled in — both are retained personal
or operational data by every definition the other six use.

Each class has a default, a **floor** and a **ceiling**. Settings outside the range are **refused, not
clamped** — a form that accepts 30 days for the audit log and stores 365 has told the operator
something untrue about their own system.

Opinionated floors, and they are opinions about *this system* rather than about law:

- **Audit log: 365 days.** A record somebody can shorten to less than the time it takes anyone to ask
  is decoration.
- **Consent records: 365 days**, plus a cross-class check that consent outlives the messages and
  campaigns it authorised. Cross-class conflicts are *reported*, not refused — the combination is the
  organization's judgement.
- **Security events: 90 days**, shorter than most intrusions take to notice.

The sweep (`runSweep`) batches (500 rows/statement, 40 batches max), records **every** run including
the ones that deleted nothing, and skips anything a legal hold covers. **If the hold table cannot be
read, the sweep does nothing for that class** — failing towards keeping data, deliberately.

`dryRun` counts without deleting and is the default button in the console.

---

## 5. Consent

One row per `(organization, environment, address, category)`. The category is **in the key**, which is
the whole design: a marketing unsubscribe and a transactional record are different rows, so no update
path exists by which withdrawing from one can touch the other.

Categories: `transactional`, `marketing`, `product`, `recruitment`, `system`.

| Category | Needs opt-in | Can be switched off |
|---|---|---|
| transactional | no | no |
| marketing | yes | yes |
| product | yes | yes |
| recruitment | yes | yes |
| system | no | no |

`system` is separate from `transactional` because telling somebody they can unsubscribe from a
security notice would be a lie.

**Suppression is not consent** and blocks by reason:

| Reason | Blocks |
|---|---|
| `hard_bounce`, `invalid_address`, `repeated_soft_bounce` | every category — the mailbox does not exist |
| `complaint`, `unsubscribe` | marketing, product, recruitment — receipts and security notices keep flowing |
| `manual` | everything — an operator knows something the system does not |

`mayPlatformSend()` refuses when the lookup itself failed. A consent check that did not run must never
resolve to "go ahead".

Addresses are lowercased and trimmed and **nothing else**. No dot-stripping, no plus-tag removal —
those are one provider's rules, and a system that decides `a.b@x` and `ab@x` are one person eventually
mails somebody who never agreed.

---

## 6. Export

Asynchronous, authenticated, time-limited, audited.

- **Datasets are declared with explicit column lists.** No `SELECT *`. `FORBIDDEN_COLUMNS`
  (`key_hash`, `secret`, `previous_secret`, `smtp_pass`, …) is asserted against the whole catalogue by
  a test, so adding a sensitive column to a projection fails the suite rather than shipping.
- **Content datasets** (message bodies) need an explicit acknowledgement on the request and get a
  12-hour download window instead of 48.
- **The download token** is returned once and stored as a SHA-256, compared in constant time. Lost
  token → request the export again.
- **Every download is audited** with the *downloader's* IP and user agent, not the requester's.
- **Row cap**: 50,000 per dataset, and truncation is stated in the manifest and logged. A cap that is
  never mentioned is a truncation somebody reads as completeness.
- **The manifest ships inside the export**: every dataset, its row count, its columns, and — the part
  that matters — the datasets that produced nothing, with the reason.

**Where files go.** `src/lib/storage.ts` falls back to an in-memory store whose `put()` *discards* the
bytes. An export written there would report `ready` and serve nothing. So: real object storage → the
artifacts go there; no object storage and a small export → stored on the job row; no object storage and
a large export → the job **fails with a reason naming the missing configuration**.

CSV cells beginning `=`, `+`, `-` or `@` are prefixed with a quote: an exported contact name is
otherwise a formula that runs on the machine of whoever opens the file.

---

## 7. Deletion

Three scopes, three levels of ceremony:

| Scope | Approvals (besides the requester) | Grace window |
|---|---|---|
| contact | 0 | none — erasure requests usually have a deadline |
| mailbox | 1 | 24 hours |
| organization | 2 **distinct** people | 72 hours |

Controls, each because the others are insufficient:

1. **A typed confirmation derived from the target** — `erase someone@example.com`, not "type DELETE".
2. **Approvals from different people**, never the requester (`approvalsSatisfied()` counts distinct
   approvers excluding them).
3. **A grace window** during which the job is visible and cancellable.
4. **The gate is re-checked in the instant before the first row goes** — a hold placed during the
   grace window has to stop the job.
5. An organization must be **suspended first**. Suspension is reversible; deletion is not.

**Never deleted:**

- **The audit log.** An erasure system that erases the evidence of erasure can only assert compliance.
- **Suppression entries**, by default. An address on that list asked never to be mailed again;
  deleting the row is the platform forgetting a refusal. An operator may override, and the plan then
  says out loud that mail to that address becomes possible again.
- **EduRankAI's own internal mailbox records** on a tenant erasure — those are our correspondence, not
  the tenant's data. Erasing somebody from the internal store is the platform-only `mailbox` scope.

A contact erasure **removes the address from recipient lists** rather than deleting shared messages,
and deletes only messages left addressed to nobody. A message to three people is not one person's to
delete.

`mailapi_deletion_jobs` and `mailapi_legal_holds` deliberately carry **no foreign key** to
`mailapi_orgs`: a cascade would delete the deletion job in the middle of its own execution, and would
take a hold away with the data it was preserving.

---

## 8. Legal hold

`mailapi_legal_holds`, scoped to an organization, an address, a mailbox, a message, a campaign or a
domain. Requires a matter reference (free text — most matters are the customer's, not ours) and a
written reason of at least 20 characters, the same discipline `src/lib/legal-hold.ts` applies.

**A hold stops deletion. It does not grant access.** Reading held content needs a support content
grant — a different capability, a different person, time-limited and audited. Collapsing the two would
mean anybody who can type a matter reference can read a customer's mail.

Placing is a platform act; **releasing is the owner's alone**. Placing over-preserves, which is
recoverable; releasing makes records deletable, which is not.

---

## 9. Security events

Seven families, closed vocabulary: failed logins, API abuse, SMTP abuse, suspicious campaigns,
credential anomalies, permission changes, domain changes. Free-text event names produce three spellings
of the same thing in three modules and a filter that silently misses two thirds of the traffic.

**Everything is advisory.** No score, threshold or anomaly in this module suspends an account, blocks a
campaign or penalises anybody. Every assessment returns a `Finding` with `advisoryOnly: true` and a
recommendation, and the return type has no field with which a caller could act. This is the same rule
that governs proctoring in this repository and for the same reason: a false positive from an automated
judgement lands on a real person, and there is no appeal against a system that has already acted.

Recording never throws and never blocks — the opposite choice from the audit log, deliberately. An
audit event is part of an action and must be able to refuse it; a security event is an observation
about an action already decided.

Triage requires a note of at least 10 characters for `resolved` and `false_positive`. A cleared event
with no note cannot be told from an ignored one six weeks later.

---

## 10. Support tools

**Tier 1 — metadata, no approval.** Status, timestamps, attempts, SMTP error, template key, recipient
domain, address with the local part masked. The subject is withheld and the body is never selected: the
query names its columns and `body_html` is not among them, rather than fetching the row and stripping
it afterwards.

**Tier 2 — content, by authorisation.** Requested with a written reason (30 characters minimum),
approved by a *different* person holding `support.content.approve` (platform owner only), scoped to one
record, ~4 hours, 25 reads maximum. Every read increments the counter **conditionally** (so a race
cannot spend a use that is not there), writes an audit event *before* the body is selected, and raises a
`support.content_accessed` security event.

**Retry** is allowed for failed, deferred or queued messages with attempts remaining. Never for a
suppressed message — retrying one would mail an address on the suppression list, the most damaging
thing a support tool could do by accident.

---

## 11. Admin search

Classified rather than "search everything": a search that always looks everywhere eventually returns a
row from a table nobody remembered was in the list. The classification is explained back to the user on
the results page.

`<abc@domain>` is an RFC message id; `abc@domain` is an address. Same characters, two brackets apart,
and looking one up in the other's table returns nothing while looking perfectly healthy.

**Subjects and bodies are never searched.** A subject-line search would let anybody with the console
reconstruct what customers write about by guessing words, with no authorisation and nothing on the
security screen.

The tenant scope comes from the resolved actor, never from the request. A store that fails is **named**
in the response — hiding it produces a confident "not found" for a record that is right there.

---

## 12. Operations

**Worker.** `POST|GET /api/mail/gov/worker`, authorised by `cronAuth()` (fails closed with no
`CRON_SECRET`). Registered in `vercel.json` at `20 2 * * *` — Hobby crons are daily-only. Each pass
does a bounded amount of work (3 exports, 2 deletions, 5 organizations' sweeps) and reports what is
left; a worker that drains the whole queue in one request is a worker that times out halfway through a
deletion.

**Environment**: `CRON_SECRET` (worker), `FOUNDER_EMAIL` (owner arm), `S3_*` or
`BLOB_READ_WRITE_TOKEN` (export artifacts). All read through existing modules; nothing in this patch
reads `.env` directly.

**Health**: `GET /api/mail/gov/health` and the overview screen. Every field is *observed*:
`to_regclass` for tables, `pg_trigger` for the immutability trigger, a real chain walk, the actual
storage backend, real queue counts. HTTP 503 when any check fails, 200 for warnings.

---

## 13. Tests

`npx vitest run src/lib/mailgov` — 111 tests, no database required.

- `policy.test.ts` — capability matrix, tenant isolation (asserted across *every* capability, not a
  sample), privilege escalation, self-targeting, role ranks, two-person control, membership mapping.
- `audit-chain.test.ts` — canonicalisation, hash sensitivity per field, field-boundary forgery, and
  four attacks: edit a field, edit a field *and* recompute its hash, remove an event, fork the chain.
- `governance.test.ts` — retention floors/ceilings/cutoffs/conflicts, the consent matrix (including
  both directions of the transactional/marketing rule), deletion plans and gates, export column
  safety and CSV injection, support masking and grant lifecycle, advisory-only security findings,
  search classification.

---

## 14. What this does not do yet

Stated plainly, because a governance document that only lists what works is the same failure mode as a
health screen that only reports intentions.

1. **Contacts and campaigns have no tables on this platform.** They are declared in the export
   catalogue and checked with `to_regclass` at run time, so the export says "no `mailapi_campaigns`
   table on this deployment" rather than producing an empty file that reads as "this organization ran
   no campaigns". When those tables land, the datasets light up with no change here. `orgUsage()`
   reports `campaigns: null` for the same reason — *not available* is not *zero*.

2. **A support or auditor grant does not by itself open the console UI.** `src/middleware.ts` puts
   `canOpenAdmin()` in front of every `/admin` path, so somebody appointed support also needs an
   admin-capable EduRankAI role to load the screens in a browser; the governance **API** is exempt from
   middleware and works with the grant alone. This patch did not widen that door — changing it is a
   policy decision. The appointments card says so at the point of use.

3. **`recordAiProcessing()` has no callers yet**, because the mail platform's AI features are not
   built. The table exists, the writer works, retention sweeps it and the console reads it. The
   retention screen says "no AI processing has been recorded on this deployment" rather than implying a
   running feature found nothing.

4. **Security events are recorded from the governance layer only** — refused governance calls, role
   changes, credential rotations, content access, session revocations. `recordSecurityEvent()` is
   exported for the SMTP edge, the API key check and the campaign sender to call; until they do, those
   families will be empty on the screen, which is honestly a gap rather than a quiet platform.

5. **Retention does not delete stored attachment objects** from object storage — it clears the rows
   pointing at them. Most attachments on this platform are links the composer pasted (attachment
   policy is links, not uploads), so most rows point at somewhere we do not own. Deleting objects we
   *do* own belongs in the storage layer with its own failure handling. `clearAttachments()` says this
   in its note field, on screen.

6. **Audit pruning is platform-wide, not per tenant.** The chain is one chain; pruning one tenant's
   rows out of the middle would break every link crossing them. A per-tenant audit retention setting
   would therefore be a promise the chain cannot keep, so it is not offered.

7. **Export artifacts are not encrypted at rest beyond what the storage backend provides.** S3-side
   encryption is a bucket setting; the platform does not add a second layer, and does not claim to.
