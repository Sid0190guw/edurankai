# Mail: high availability, disaster recovery, and the honest state of both

Written to be read by somebody deciding whether this arrangement is good enough, and by somebody at
2am who did not build it. It describes what exists **today** — one HP ZBook Fury G8, Vercel and
Supabase — and what each later phase changes. Where something is not in place, it says so in the
same sentence rather than in a footnote.

The machine-readable version of most of this is code, not prose, and the admin surface renders it:

| Thing | Source of truth | Where you look at it |
| --- | --- | --- |
| Failure model | `src/lib/mailops/failure-model.ts` | `/admin/mail/continuity` |
| RPO / RTO | `src/lib/mailops/objectives.ts` | `/admin/mail/continuity` |
| Backup sets, retention, verification | `src/lib/mailops/backup.ts` | `/admin/mail/continuity` |
| Runbooks | `src/lib/mailops/runbooks.ts` | `/admin/mail/continuity` |
| Migration plans and gates | `src/lib/mailops/migration.ts` | `/admin/mail/continuity`, and [MIGRATION-VERIFICATION.md](MIGRATION-VERIFICATION.md) |
| DNS cutover arithmetic | `src/lib/mailops/dns-cutover.ts` | `npx tsx scripts/mailops/dns-cutover.ts plan` |
| Worker drain / blue-green | `src/lib/mailops/drain.ts` | `/admin/mail/continuity` |
| Durable outbound spool | `mail-engine/src/queue/spool.ts` | `npx tsx scripts/mailops/spool-recover.ts --stats-only` |

Keeping those as modules rather than as prose is deliberate: a runbook in a repository is a runbook
nobody opens during an incident, and a failure model in a document cannot be queried by the screen
that is about to print a reassuring sentence.

---

## 1. The one-paragraph summary

Outbound mail is durable and survives a crash, a reboot and a power cut, because acceptance means
"fsynced to the spool" and a crash costs a lease rather than a message. Inbound mail is **not**
highly available in any sense: the MX is a laptop, and while it is off, mail sits in other people's
queues until they give up. Nothing is monitored automatically. No backup has ever been restored, so
every recovery objective on the continuity page is a target rather than a capability. The
architecture is built so none of that requires a redesign to fix — but none of it is fixed today.

---

## 2. Failure model

Full detail, including what must not be claimed during each failure, is in
`src/lib/mailops/failure-model.ts` and rendered on `/admin/mail/continuity`. Summary:

| Failure | What happens | Lost | Phase-1 reality |
| --- | --- | --- | --- |
| Laptop unavailable | Spooled outbound survives; inbound refused, senders queue | nothing | total inbound outage while the lid is shut |
| Laptop reboot | Containers restart, spool survives, worker reclaims leases | in-flight only | expected to be clean; this is the one tested case |
| Internet disconnected | Everything defers with `connection_failure`; nothing bounces | nothing | one uplink, no secondary |
| Outbound SMTP unavailable | Messages stay `queued`; API keeps accepting | nothing | one MTA, no relay fallback unless configured |
| Inbound MX unavailable | Nothing accepted; senders retry 1–3 days on their own schedule | nothing | **largest single availability risk in the system** |
| Database unavailable | Mail host keeps sending; events buffer; inbound answered **4xx** | nothing | free-tier compute exhaustion looks identical |
| Supabase unavailable | As above; nothing local to restart | nothing | one provider, one project, one region |
| Redis unavailable | No effect — **there is no Redis in this system** | nothing | absent by design |
| Worker unavailable | Spool untouched; leases expire and are reclaimed | in-flight only | one worker; restart is the whole recovery |
| Storage unavailable | Bodies fine; attachments fail rather than send incomplete | window | one copy of every attachment, no versioning |
| Vercel unavailable | Sending continues; inbound answered 4xx because filing is an app call | nothing | one hosting provider |
| DNS issue | Either everything defers, or authentication silently breaks | nothing | records maintained by hand, no drift monitoring |
| MTA failure | Process up and wrong; one SMTP code dominates | nothing | certificate renewal is manual |
| Disk failure | Spool, maildirs, DKIM keys and volumes all gone together | **catastrophic** | no RAID, no mirror, keys unencrypted |
| Power failure | Battery is the UPS; hibernates cleanly | in-flight only | battery health is untracked |
| Queue failure | Poison jobs stop at `failed` and wait for a human | nothing | nothing runs the worker on a timer |
| Spool unwritable | **Acceptance fails**, which is correct | nothing | no disk-space alarm |
| Credential / key compromise | Stop signing and sending; rotate | nothing | one unencrypted key copy on one disk |

Two properties of this table are load-bearing:

**A dead machine takes its services with it.** `expandDown()` models that once, so a status screen
cannot ask a trick question by listing `zbook: down` next to `mta_in: up`.

**Every mode carries a claim the product must not make.** `suppressedClaims()` returns them and the
continuity page prints them. The important one: while the MX is down the system has no basis for
any receipt claim at all.

### The secondary-MX trap

The obvious response to "the MX is one laptop" is a backup MX. Do not add one that queues into the
same machine. A backup MX which cannot deliver onward converts a sender-side retry — safe, on
somebody else's disk, with somebody else's operations team — into a local queue on hardware that is
already failing. A holding MX is worth adding only when it is on separate infrastructure **and** can
spool independently. Until then the honest answer is Phase 2.

---

## 3. Single-machine mode

The ZBook may run the MTA, IMAP, spam scoring, the delivery worker and the mail processing pipeline.
Service boundaries that make it restartable:

- **The MTA owns SMTP and nothing else.** It does not know what a user is.
- **The engine owns the spool.** Nothing else writes to it. The spool is the interface between
  "accepted" and "delivered", and it is a directory, so a restart cannot lose it.
- **The application owns identity, mailboxes and reporting.** The engine holds no database client
  (see `mail-engine/src/contracts/index.ts`), which is exactly why sending survives a database
  outage.
- **The worker owns nothing.** It claims, delivers and reports. Everything it holds is a lease.

The machine must be restartable, and that reduces to three properties, all of which hold today:
services start unattended, the spool is on disk, and expired leases are reclaimed on start.

**Durability caveat, stated because it is easy to get wrong.** `fsync` on a directory handle is a
POSIX operation. On a Windows host it fails, so the rename that publishes a spool entry is durable
only when the filesystem chooses. `durabilityMode()` reports `full` or `file-only` and the recovery
script prints it. Run the spool inside the Linux container or on WSL2 — not on the NTFS host — and
it is `full`.

---

## 4. Mail queue persistence

Implemented in `mail-engine/src/queue/spool.ts`. The rule:

> A message is accepted when it is on disk and flushed. Not when it is in an array.

- `enqueue()` writes into `tmp/`, fsyncs, renames into `queued/`, fsyncs the directory, and only
  then resolves. If any step fails it **throws**, so the caller keeps ownership and can tell the
  truth to whoever handed the message over.
- State is the directory a file is in; a transition is `rename(2)`. Claiming is the rename into
  `sending/`, so two workers racing both call it, exactly one wins, and there is no window where
  both believe they own the entry.
- A crash leaves an entry in `sending/` holding a lease. `reclaim()` returns it once the lease
  expires. The cost of a crash is a lease interval; the visible consequence is a possible
  **duplicate** delivery, never a lost one. SMTP has no exactly-once and every real MTA makes the
  same trade.
- Debris in `tmp/` from a crash mid-write is swept. Nothing in `tmp/` was ever acknowledged, so
  sweeping it cannot lose a message anybody was told we had.
- Retry policy lives in `mail-engine/src/queue/retry.ts` and the spool asks it. Two implementations
  of a backoff curve is how a queue ends up hammering a server that already throttled it.

Proved by `mail-engine/test/spool-durability.test.ts` (19 tests) against a real filesystem.

---

## 5. Inbound failure

While the inbound endpoint is offline:

- Nothing is accepted. Sending MTAs get a connection failure and hold the message in their own
  queue. RFC 5321 recommends retrying for at least 4–5 days; in practice senders choose, and some
  give up much sooner.
- **Mail is not lost during that window — it is held by the sender.** That is the whole reason a
  short outage is survivable.
- **The system must not claim receipt.** There is no basis for one. The continuity page suppresses
  any such wording via `suppressedClaims()`.

Future architecture, in preference order: an always-online dedicated inbound host (Phase 2), or a
secondary MX **on separate infrastructure that can spool independently**. Not a pseudo-failover that
queues into the same machine.

---

## 6. Backups

Definitions, retention and verification rules are in `src/lib/mailops/backup.ts`. Tooling is in
`scripts/mailops/`, and the founder runs all of it — no process in this repository opens the
production database.

| Set | Cadence | Encryption | Retention (GFS) | State today |
| --- | --- | --- | --- | --- |
| Postgres dump | daily | required | 7d / 4w / 6m / 1y, ≥1 offsite | **not scheduled** |
| Mail config, templates, campaigns | daily | required | as above | inside the full dump only |
| Delivered mail (maildirs) | daily | required | as above | **not backed up at all** |
| DKIM private keys | on change | required | 3 yearly, 2 offsite | **one unencrypted copy, one disk** |
| Secrets and encryption keys | on change | required | 3 yearly, 2 offsite | **no escrow copy known to exist** |
| Attachments / raw MIME | continuous | recommended | 30d | **no versioning, no second copy** |
| Spool `failed/` | manual | recommended | 14d | nothing copies it off the machine |

Retention is grandfather-father-son with an explicit guard: an artefact already kept by the daily
slot does not also consume a weekly slot. Without that check, seven dailies in one week satisfy the
whole policy and you silently keep nothing older than a week.

### Verification

> **A backup that has never been restored is not a backup.**

`verificationState()` returns `never` for a set with no successful restore test regardless of how
many artefacts exist, and the page prints that word. Verification also **expires** — a restore
proved against the schema of that week proves progressively less as the schema changes.

An artefact is refused as evidence if it is unencrypted (for a sensitive set), has no checksum, is
held only on the machine it was taken from, or is zero bytes. The last one is the classic silent
failure: the command exits, a file exists, and nobody looks again until a restore.

Restore testing is `scripts/mailops/db-restore.sh`, which refuses to run against anything that looks
like production, checks the artefact against its recorded checksum, restores into a scratch
instance, and then verifies **content** — table count, `mail_messages` rows, `users` rows. It does
not treat `pg_restore` exiting 0 as the test, because `pg_restore` exits non-zero on benign
`--clean` warnings and exits 0 on a restore that leaves tables empty.

---

## 7. RPO and RTO

Targets are configurable on `/admin/mail/continuity`. What is **not** editable from a screen is the
`basis`, because it is a fact about what has been demonstrated rather than a preference:

- `measured` — a real restore was performed and timed. The only basis that may be described outside
  the team as what the system does.
- `design-intent` — the architecture supports it, nothing contradicts it, it has not been shown.
- `aspiration` — a later phase. Not true today.

| Asset | RPO | RTO | Basis |
| --- | --- | --- | --- |
| Database | 24 h | 4 h | aspiration — no scheduled backup, so the honest RPO is unbounded |
| Outbound spool | 0 | 5 min | design-intent — fsync-before-ack; power-cut test not run |
| Delivered mail | 24 h | 8 h | aspiration — maildirs are not backed up |
| DKIM keys | 0 | 1 h | design-intent — assumes an escrow copy that may not exist |
| Mail config / campaigns | 24 h | 4 h | aspiration |
| Object storage | 0 | 1 h | aspiration — no versioning, no second copy |
| Secrets | 0 | 30 min | design-intent |

A measurement older than 90 days goes stale and the claim reverts to "unproven". Measurements come
from restore tests, and an incident is also a free measurement — record it.

**Do not quote any of these numbers to anyone outside the team until the basis reads `measured`.**

---

## 8. Zero and low-downtime deployment

`src/lib/mailops/drain.ts`. Four steps, in order, each of which fails in a specific way if skipped:

1. **Stop accepting.** Readiness goes false on the first signal. Skipping this strands an entry for
   a full lease interval for no reason.
2. **Finish current work.** Deliveries past DATA run to completion; ones not started are released.
   Skipping this abandons a conversation the far end may already have accepted — the retry then
   sends it twice.
3. **Persist state.** Every completed delivery has its outcome written before exit. An unwritten
   success becomes a duplicate.
4. **Exit.** 0 on a clean drain, non-zero on a hard stop, so the supervisor log distinguishes them.

**Liveness and readiness are different checks.** During a drain the process is healthy (do not kill
it) and not ready (do not send it work). One endpoint answering both means either the load balancer
keeps feeding a draining node, or the supervisor kills a node mid-delivery.

Blue/green promotion requires N consecutive readiness probes, refuses to promote while the current
version is below the minimum healthy count, and rolls back when the new build will not start.
Rolling drains go least-busy-first so the longest deliveries get the most time.

---

## 9. Failover architecture (Phase 3+)

```
                    Load Balancer
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
        Mail Node 1               Mail Node 2
             │                         │
             └────────────┬────────────┘
                          ▼
                    Shared spool
                          │
                       Workers
```

The interfaces for this exist now:

- **Claiming is already safe for N workers.** Atomic rename, not a flag. Nothing is redesigned when
  a second worker starts.
- **Leases already identify their owner**, so `reclaim()` can tell an abandoned claim from a live
  one — provided each node gets a distinct worker id.
- **The transport, store, queue, storage, auth and DNS interfaces** in
  `src/lib/mailplatform/interfaces.ts` mean a node, a bucket or a broker is an adapter swap.

Two things genuinely change and are worth knowing before, not during:

1. **The shared spool needs working atomic rename.** NFS with the wrong options does not give you
   that, and the symptom is duplicate mail to real people.
2. **Per-domain rate limiting must move to shared state.** Three nodes each respecting 60/min send
   180/min to a recipient who allowed 60, and that gets the whole domain throttled.

---

## 10. Infrastructure phases

**Phase 1 — today.** ZBook + Vercel + Supabase. Inbound is a single point of failure; outbound is
durable; nothing is monitored; nothing has been restored.

**Phase 2 — dedicated mail server.** The MTA, IMAP and worker move to an always-on host with its own
transit, mirrored volumes, automated certificate renewal, keys in a secret store, and a scheduled
health check that reports in. This removes the largest availability risk and most of the
catastrophic-loss exposure. **It is the single highest-value change available.**

**Phase 3 — dedicated application, database and MTA cluster.** Self-hosted Postgres with a replica,
several mail nodes behind a load balancer, rolling deploys.

**Phase 4 — distributed EduRankAI infrastructure.** The application becomes portable off Vercel.

**Phase 5 — multi-region.**

Do not force later infrastructure into the current machine. A load balancer in front of one laptop
is not high availability; a second container on the same disk does not survive that disk.

---

## 11. Testing — what has and has not been done

| Test | Status |
| --- | --- |
| Queue recovery: crash mid-delivery, lease expiry, reclaim | **passing** — `mail-engine/test/spool-durability.test.ts` |
| Spool durability: enqueue survives, dedup across states, checksum refusal | **passing** — same suite |
| Retry, dead-lettering, partial delivery, tmp sweep, retention | **passing** — same suite |
| Failure model, objectives, backup retention/verification, migration gates, DNS arithmetic, drain | **passing** — `src/lib/mailops/continuity.test.ts` (58 tests) |
| Reboot test (real machine, real containers) | **not run** |
| Service failure test (kill the MTA, watch deferrals) | **not run** |
| Database restore into a scratch instance | **not run** — this is why every RPO is a target |
| Mail restore (maildir onto a scratch Dovecot) | **not run** — and there is no artefact to restore |
| Migration dry run | **not run** |
| DNS cutover simulation | **planner exercised**; no live rehearsal |
| Rollback simulation | **not run** |

The unit tests prove the logic that is invisible when it is wrong — retention that silently keeps
nothing, a gate that passes on missing data, a drain that exits mid-DATA. They do not substitute for
a physical act. **The first one to do is the database restore**, because it converts the largest
block of aspiration in section 7 into measurement, and because it is the one that tells you whether
the dumps you are about to start taking are worth anything.

---

## 12. Not yet in place

Read this before assuming any protection above exists.

- **Nothing polls the mail host.** Every failure in section 2 is detected by a person noticing.
  `scripts/mailops/health-check.sh` exists and is not scheduled.
- **No scheduled database backup.** The real RPO is "since somebody last remembered".
- **The maildir tree is not backed up at all.**
- **DKIM private keys: one copy, unencrypted, on one disk.**
- **No object-storage versioning and no second bucket.** Exactly one copy of every attachment.
- **No restore has ever been performed.**
- **The inbound MX is one laptop.**
- **No alerting channel.** Even once a check runs, there is nowhere for it to shout.
