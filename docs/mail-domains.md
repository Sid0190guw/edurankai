# EduRankAI Mail — domains, DNS, sending identities and mailboxes

Patch 10 of the mail platform. This document covers what was built, the decisions that are not
obvious from the code, and the things this layer deliberately refuses to do.

Everything here sits on top of the platform contract in `src/lib/mailplatform/types.ts` and the
platform schema in `src/lib/mailplatform/schema.ts`, neither of which this patch modifies.

---

## 1. Where the code is

| Concern | File |
| --- | --- |
| Deployment description (where mail leaves from) | `src/lib/mailplatform/profile.ts` |
| DNS resolver (DoH, two endpoints, checked/unchecked discipline) | `src/lib/mailplatform/domains/dns.ts` |
| SPF parsing, judgement, merge proposal, lookup counting | `src/lib/mailplatform/domains/spf.ts` |
| DMARC parsing, policy inspection, alignment, change guard | `src/lib/mailplatform/domains/dmarc.ts` |
| DKIM key generation, selectors, DNS form, rotation planning | `src/lib/mailplatform/domains/dkim.ts` |
| The record set a customer must publish | `src/lib/mailplatform/domains/records.ts` |
| The verification engine | `src/lib/mailplatform/domains/verify.ts` |
| Alias/forwarding graph and loop detection | `src/lib/mailplatform/domains/aliases.ts` |
| Mailbox naming, states, quotas, auto-reply rules | `src/lib/mailplatform/domains/mailbox-rules.ts` |
| Data access, additive DDL, audit | `src/lib/mailplatform/domains/store.ts` |
| Assembly of a domain's whole picture | `src/lib/mailplatform/domains/service.ts` |
| Route guard | `src/lib/mailplatform/domains/api.ts` |

Surfaces:

- `/admin/mail/domains` — list, add, deployment status
- `/admin/mail/domains/:id` — the six-step wizard **and** the health dashboard, one page
- `/admin/mail/mailboxes` — mailboxes, quotas, forwarding, auto-reply, aliases

APIs (all org-scoped, all permission-checked server-side):

```
GET    /api/mail/domains
POST   /api/mail/domains
GET    /api/mail/domains/:id
PATCH  /api/mail/domains/:id          action: purpose | settings | suspend | resume | activate | deactivate
DELETE /api/mail/domains/:id
POST   /api/mail/domains/:id/verify
GET    /api/mail/domains/:id/dkim
POST   /api/mail/domains/:id/dkim
PATCH  /api/mail/domains/:id/dkim     action: activate | retire
GET/POST/PATCH/DELETE  /api/mail/identities
GET/POST/PATCH/DELETE  /api/mail/mailboxes
GET/POST/PATCH/DELETE  /api/mail/aliases
```

---

## 2. The rule the whole layer is built around

**A lookup that did not happen is not an absent record.**

`src/pages/api/mail/dns-check.ts` learned this the expensive way: its helpers ended in
`catch { return [] }`, and an empty array is exactly what a domain with no SPF record produces — so
a resolver timeout rendered as a statement of fact about the operator's DNS, on a screen whose
documented next step is to *change* that DNS.

The verification engine is stricter still, because it writes a `verified` state into a database and
unlocks sending. So:

- every lookup returns `{ checked, values, error, resolver }`;
- a check whose lookup did not complete is `unknown`, never `fail`;
- `pass` always requires a positive observation, so an outage cannot verify a domain either;
- the reasons travel back in `health.unchecked` and the UI renders them as "could not be checked".

A DNS outage therefore cannot flip a working domain to FAILED and stop its mail, and cannot flip an
unverified domain to VERIFIED.

---

## 3. Three questions, kept apart

Requirement 7 of the brief asks that ownership, receiving and sending stay distinct. They are three
independent booleans on every health run:

| Question | Answered by | Field |
| --- | --- | --- |
| Do you control this domain? | the challenge TXT | `ownershipVerified` |
| May our infrastructure send as it? | SPF authorises us **and** a DKIM key we hold is published | `sendingReady` |
| Should mail for it arrive here? | MX points at us | `receivingReady` |

A domain can be verified and unable to send. It can send and not receive. Collapsing these into one
boolean is how a domain ends up "verified" on screen while its mail bounces.

### The six lifecycle states

The brief names PENDING, VERIFYING, VERIFIED, ACTIVE, SUSPENDED, FAILED. `mp_domains.status` has a
CHECK constraint accepting five values, and that table is owned by the platform migration, not by
this patch. ACTIVE is therefore **derived**, not stored:

```
PENDING    status = pending
VERIFYING  status = verifying
VERIFIED   status = verified, sending not enabled
ACTIVE     status = verified AND mp_sending_domains.is_enabled
SUSPENDED  status = disabled
FAILED     status = failed
```

This is not a workaround. The platform schema's own comment says a domain can be verified for
receiving and still barred from sending, which is the correct state for one that has not been warmed
up. `lifecycleState()` in `store.ts` is the single place the mapping happens.

---

## 4. SPF: we merge, we never replace

A domain's SPF record is the authorisation list for **every** system that sends mail as that domain —
payroll, ticketing, CRM, the university's own relay. Telling a customer to "set your SPF to this" is
telling them to silently unauthorise all of it, and the failure is delayed and diffuse: mail keeps
flowing from warm caches for hours, then invoices start landing in spam.

`recommendSpf()` therefore:

1. never removes anything already published;
2. keeps the existing `all` qualifier — tightening `~all` to `-all` is a deliverability decision and
   not ours to make silently;
3. inserts new terms **before** `all`, because terms after it are never evaluated;
4. **refuses to merge automatically when two records are published**, because deciding which
   mechanisms belong to which sender is a judgement about systems we cannot see.

Detected and reported: multiple records (which means the domain has *no* valid SPF, not that the
second is ignored), malformed terms, `+all`, deprecated `ptr`, terms after `all`, and the RFC 7208
ten-lookup limit — counted across the whole include tree, with a `partial` flag when a branch could
not be resolved so the total is reported as a floor rather than a fact.

---

## 5. DMARC: a guard in both directions

`p=reject` tells every receiver in the world to throw away mail that fails alignment. A tool that
helpfully proposes it for a domain whose payroll provider is not yet aligned has just deleted the
payslips, silently, at the receiver, with no bounce the sender ever sees.

So:

- the recommendation for a domain with no policy is always `p=none`, which changes nothing about
  delivery and only turns the reports on;
- **any** change to a published policy requires explicit confirmation — weakening (`reject` to
  `none`) removes protection somebody built up over months, and strengthening (`none` to `reject`)
  starts throwing away real mail from senders that are legitimate but not yet aligned;
- the confirmation is enforced **server-side** in `PATCH /api/mail/domains/:id` (`confirm: true`),
  not only in the UI, because the route is reachable with curl.

Nothing in this codebase publishes DNS. The policy stored in `mp_domain_settings.dmarc_policy` is a
**record of intent**; the customer publishes the record at their own DNS host. The UI says so.

---

## 6. DKIM: private keys

- Generated with `node:crypto`. RSA 2048 by default (2048 minimum, 4096 maximum), Ed25519 offered.
- The `p=` value is the SPKI DER for RSA and the **raw 32-byte key** for Ed25519 (RFC 8463 §3).
  Publishing the SPKI form for Ed25519 produces a record that parses and never verifies. There is a
  test that signs a message and verifies it against the published key, for both algorithms.
- The private half is encrypted with the repository's existing envelope scheme
  (`src/lib/crypto`, AES-256-GCM, key material in `DATA_ENCRYPTION_KEY_<id>`), stored as ciphertext
  in `mp_secrets`, and referenced from `mp_dkim_keys.private_key_ref` as `mp_secret:<uuid>`.
- **If encryption is not configured, generation is refused** rather than falling back to plaintext.
  A DKIM private key readable in a column is a forge-mail capability for anyone who can run one
  `SELECT`.
- **No route returns a private key, and none may be added.** The serialised type has no field one
  could travel in. If a future feature seems to need an export, the answer is a new key at a new
  selector.

### Rotation

A key cannot be replaced atomically: DNS caches the old selector for its TTL, and mail already in
flight was signed with the old key. `planRotation()` never activates and retires in the same step —
publish new, wait for visibility, switch signing, wait a TTL plus a day, then retire. The outgoing
key becomes `rotating`, not `retired`. Retiring destroys the stored ciphertext.

---

## 7. PTR / reverse DNS

Reverse DNS is set by whoever owns the IP address. This application cannot change it and no screen
built on this layer may imply it can.

What we do: show the expected name, show what reverse DNS currently returns, forward-confirm it (the
name PTR gives must resolve back to the same address), and name the party who has to fix it. A
missing PTR is reported as a failure because several large receivers refuse mail from an address
without one.

## 8. TLS

What is honestly observable from this runtime is the *published* posture: an MTA-STS policy
(`_mta-sts`) and a TLS reporting address (`_smtp._tls`). Whether a given connection actually
negotiates STARTTLS needs an SMTP socket, which the serverless functions here cannot open, and the
check says so rather than implying the connection was tested.

---

## 9. Aliases and loops

`support@` forwards to `help@`; somebody later points `help@` back at `support@`; the next message
to either is expanded, re-expanded and delivered until something runs out — disk, queue, or the
patience of the receiving server, which starts refusing our mail and keeps refusing it after the
loop is fixed.

The loop check therefore runs on the **write path**, on the **server**, against the **whole graph**:
aliases and mailbox forwarding together, because a mailbox forwarding into an alias that points back
at it is the identical cycle expressed across two tables.

`expand()` carries a traversal stack rather than only a visited set, so re-entering an address that
is currently being expanded is recorded as a cycle *with the path that closes it*. A visited set
alone would silently swallow the loop and return a plausible answer — which is how a loop survives
review.

Also enforced: an alias may only be created on a domain the organization has verified, and may only
deliver to mailboxes it administers unless external targets are explicitly allowed. An alias quietly
forwarding admissions mail to a personal address at another provider is an exfiltration path that
looks like a typo.

**Multiple destinations.** `mp_aliases` carries one destination and a unique index on the source, so
fan-out cannot be extra rows there. This patch adds `mp_alias_targets`; the parent row keeps its
primary destination for any code reading it directly, and expansion reads the union.

---

## 10. Mailboxes

States: ACTIVE, DISABLED, SUSPENDED, DELETED. The difference that matters, and that admins get
wrong:

- **DISABLED** — the owner cannot sign in; **mail is still accepted and stored**.
- **SUSPENDED** — mail is **rejected at the door** and the sender gets a bounce.
- **DELETED** — soft; the address stays reserved so it cannot be reissued to somebody else and start
  receiving the previous holder's mail.

`mp_mailboxes.status` is added by this patch alongside the existing `is_active`, and every writer
keeps the two in step so code elsewhere reading the boolean is never left with a stale answer.

**Auto-reply** (`shouldAutoReply()`) refuses in this order: `Auto-Submitted` (RFC 3834),
`X-Auto-Response-Suppress`, mailing-list headers, `Precedence: bulk`, null return-path, no-reply and
mailer-daemon senders, the mailbox replying to itself, the mailbox not being a visible recipient
(bcc or catch-all), the date window, internal/external scope, and one reply per sender per interval.
It always returns a reason, including when it sends, so the reason can be logged.

---

## 11. Organization isolation

Every read and every write carries `org_id = ${principal.orgId}` in its predicate. Not a check
before the query — a `WHERE` clause. "Fetch by id, then compare in TypeScript" fails open the first
time somebody forgets the second half.

A wrong-tenant id matches no row, which is the same answer as a nonexistent one, deliberately:
"not found" and "belongs to someone else" must be indistinguishable to a caller who should not know
it exists.

`mailbox.test.ts` contains a **source-level invariant test** that reads `store.ts`, extracts every
SQL template, and asserts each statement touching an `mp_` table carries an `org_id` predicate. It
found three real problems when first written. `SELECT 1 ... LIMIT 1` existence probes are exempt and
deliberately global: mailbox addresses are unique platform-wide, and that is not a tenant's to hide.

The principal comes from `adapters/auth-platform.ts` (session or API key). No route accepts an
organization id from the request body or query string.

---

## 12. Future migration (requirement 17)

No hostname, IP address or SPF include appears anywhere in the record builders. Everything comes
from `MtaProfile`, resolved from the environment:

| Variable | Meaning |
| --- | --- |
| `MAIL_MX_HOSTS` | inbound hosts, `10 mx1.example.net, 20 mx2.example.net` (`MAIL_MX_HOST` also honoured) |
| `MAIL_SPF_INCLUDE` | SPF include for our sending infrastructure |
| `MAIL_SPF_IP4` / `MAIL_SPF_IP6` | sending ranges, when authorising by address |
| `MAIL_SENDING_IPS` | addresses mail leaves from, for the PTR panel |
| `MAIL_PTR_HOSTNAME` | the name reverse DNS should return |
| `MAIL_TRACKING_TARGET` | CNAME target for open/click tracking on a customer domain |
| `MAIL_DMARC_RUA` | default aggregate-report address offered in the recommendation |
| `MAIL_DKIM_SIGNING` | `off` to state honestly that this deployment cannot sign |
| `DATA_ENCRYPTION_KEY_k1` | 32-byte base64; **required** before a DKIM key can be generated |

Moving from the current machine to a dedicated MTA, then a cluster, then multi-region is a
configuration change, and the records the wizard prints change with it. `verify.test.ts` proves this
by generating records for a hypothetical three-host multi-region profile and asserting nothing from
the other profile leaks in.

**An unconfigured deployment claims nothing.** With no MX host set there is no MX row — printing one
for a machine nobody runs would have the customer publish a route to nothing and their inbound mail
would start bouncing. The UI shows the missing variables instead.

---

## 13. Schema changes

All additive; nothing dropped, renamed or retyped, and no CHECK constraint altered. Applied at
runtime by `ensureDomainSchema()` after the platform schema, so it works on a fresh database and on
one another agent's migration has already touched, in either order.

```
ALTER TABLE mp_mailboxes           ADD COLUMN IF NOT EXISTS status
ALTER TABLE mp_sending_identities  ADD COLUMN IF NOT EXISTS purpose
CREATE TABLE mp_secrets            -- envelope ciphertext (DKIM private keys)
CREATE TABLE mp_alias_targets      -- fan-out destinations
CREATE TABLE mp_mailbox_settings   -- forwarding, auto-reply, vacation, signature
CREATE TABLE mp_auto_reply_log     -- one reply per sender per interval
CREATE TABLE mp_domain_health      -- the whole last run, including PTR and TLS
```

`mp_domain_verifications` keeps only the five check types its CHECK constraint accepts. `warn` is
stored there as `pass` (the record *is* published) and `unknown` as `pending` (we did not find out),
which is what those values mean in that table. Nothing is invented to fit the constraint; PTR, TLS
and the roll-up live in `mp_domain_health`.

---

## 14. Tests

`npx vitest run src/lib/mailplatform/domains/` — 141 tests, four files.

Section 16 of the brief, mapped:

| Asked for | Where |
| --- | --- |
| multiple domains | `verify.test.ts` — multi-region profile, per-domain records |
| duplicate domains | `dns-policy.test.ts` — normalisation collapses the four forms a person types; DB-level duplicate is a unique index plus an explicit pre-check in `addDomain()` |
| invalid DNS | `verify.test.ts` — malformed SPF, malformed DMARC, non-DKIM TXT at a selector |
| wrong TXT | `verify.test.ts` — a stale token reported differently from no record |
| wrong DKIM | `verify.test.ts` and `dkim.test.ts` — mismatch vs absent vs revoked |
| multiple SPF | `dns-policy.test.ts` and `verify.test.ts` — reported as *no* valid SPF |
| missing MX | `verify.test.ts` — fails receiving, leaves sending untouched |
| disabled mailbox | `mailbox.test.ts` — reported undeliverable, not silently dropped |
| alias loops | `mailbox.test.ts` — self, two-step, three-step, and one closing through forwarding |
| unauthorized domain access | `mailbox.test.ts` — the permission matrix, plus the `org_id` source invariant |

Not covered by unit tests, and stated rather than implied: the store functions themselves need a
database, so they are exercised through the admin surfaces rather than in CI. The `org_id` invariant
test is the substitute for the isolation half of that.

---

## 15. What this layer refuses to do

- Publish or change DNS. We do not hold registrar credentials and there is no adapter that does;
  `applyRecord()` on the DomainProvider returns `unsupported` honestly.
- Configure PTR.
- Change a published DMARC policy without explicit confirmation.
- Merge two SPF records automatically.
- Return a DKIM private key over any API.
- Print a record for infrastructure this deployment has not been configured with.
- Mark a domain verified, or failed, on a lookup that did not complete.
