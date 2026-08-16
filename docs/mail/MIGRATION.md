# MIGRATION

Six moves, each independent. **The application API stays stable through all of them** — that is the
constraint the design is built around, and the reason each section below is short.

Read the last section first if you are deciding when to do any of this.

---

## 0. Why these are all deployment changes, not rewrites

Three properties, all already true:

1. **The adapter switch.** `astro.config.mjs` selects the Vercel adapter when `VERCEL=1` and
   `node({ mode: 'standalone' })` otherwise. Same source, same `npm run build`.
2. **The mail service is behind an HMAC-authenticated HTTP boundary.** The app calls
   `MAIL_SERVICE_URL`; what is behind it — one laptop or twelve MTAs — is not the app's business.
3. **Storage, queue, transport and event bus are already interfaces** in `src/lib/mailplatform/`,
   with Postgres and SMTP adapters behind them.

If a migration below turns out to need application changes, that is a design defect worth fixing
before the migration, not during it.

---

## 1. ZBook → dedicated server

**Why:** a laptop is a single point of failure with a domestic uplink, and most consumer ISPs block
port 25 in both directions.

**Move:** the same compose stack, unchanged. `docker/` is the deliverable.

```bash
# on the new host
git clone … && cd edurankai
scp zbook:~/edurankai/.env.local .env.local          # then edit MAIL_HOST
./scripts/backup.sh                                  # on the ZBook
./scripts/restore.sh mail-….tar.gz --live            # on the new host, stack stopped
./scripts/start-mail.sh --mail --observability
```

**The part that is not a file copy — and it is the part that decides whether mail is delivered:**

- **Reverse DNS.** The new IP needs a PTR resolving to `MAIL_HOST`, and forward and reverse must
  agree. This is set by whoever owns the IP, not in your DNS. Without it, large receivers reject
  outright regardless of SPF and DKIM.
- **SPF.** Add the new IP **before** cutting over, keep both during, remove the old after. One SPF
  record only — two means SPF fails entirely.
- **Reputation does not transfer.** A new sending IP starts unknown. Warm up over 2–4 weeks:
  hundreds a day, then thousands. Sending your normal volume on day one is how a new IP gets
  blocked.
- **MX last.** Change it only once the new host answers on 25 and a test message round-trips.

**Rollback:** point MX back. Keep the ZBook running and able to receive for at least a week — mail
will keep arriving there while DNS propagates through caches that ignore your TTL.

---

## 2. Supabase → self-hosted PostgreSQL

**Move:** `DATABASE_URL`. That is the entire application change.

**The real work is the data, and one property makes it harder than it looks:** there is no migration
runner. The schema is created by ~343 self-bootstrapping `CREATE TABLE IF NOT EXISTS` statements, so
**no file in this repository reconstructs the live schema** — only `pg_dump` does.

```bash
pg_dump --format=custom --no-owner --no-acl "$SUPABASE_DIRECT_URL" > full.dump
pg_restore --no-owner --no-acl --dbname "$NEW_DIRECT_URL" full.dump
```

Then, before cutting over:

- **Extensions.** `gen_random_uuid()` needs `pgcrypto`; `pg_stat_statements` is optional but
  `/admin/ops` reads it. Install them in the new cluster first — `pg_restore` will not.
- **A pooler.** Supabase's `:6543` is PgBouncer in transaction mode and the app depends on that
  shape (`prepare: false`). Self-hosting means running PgBouncer yourself; connecting serverless
  functions directly to Postgres exhausts connections under Vercel concurrency.
- **Row-level security**, if any policies are in use — they come across in the dump but the roles
  they reference may not.

**Cutover:** stop writes, final incremental dump, restore, switch `DATABASE_URL`, redeploy. Expect
minutes of downtime; a zero-downtime version needs logical replication and is a separate project.

**Rollback:** switch `DATABASE_URL` back — but only until the first write lands on the new database.
After that, rolling back loses data. That moment is the point of no return; know when it happens.

---

## 3. Supabase Storage / Vercel Blob → S3-compatible

**Move:** set all five `S3_*` variables.

**The trap this system has already been shaped by:** storage selects S3 only when **every** one is
set. Four out of five silently falls back to Blob. `checkEnv()` reports the group as `partial`,
`/api/health/mail` reports storage `degraded`, and `era_config_partial_groups` alerts on it — three
places, because a silent fallback discovered months later means attachments split across two stores.

```bash
rclone sync vercel-blob: s3:era-mail-attachments --progress
rclone check vercel-blob: s3:era-mail-attachments      # verify before switching
```

Existing rows hold absolute URLs, so old objects keep resolving from the old store after the switch.
**Do not delete the old bucket** until either every URL has been rewritten or you have accepted that
old attachments live there permanently.

---

## 4. One MTA → several

**Why:** throughput, and not losing all outbound when one host is down.

**No application change.** The app talks to `MAIL_SERVICE_URL`; put a load balancer there.

- **Outbound:** MTAs are stateless enough to sit behind a round-robin. Each needs its own IP with
  its own PTR, and **each new IP goes into SPF and warms up separately**.
- **Inbound:** multiple MX records with equal priority. Each MTA runs its own `mail-parser`; both
  post to the same app.
- **The duplicate problem, which is real:** two MTAs can accept the same message (a sender retrying
  against a different MX after a timeout). The delivery-id replay check in
  `src/lib/mailops/webhook.ts` catches the identical-delivery case. Genuinely distinct SMTP
  transactions carrying the same `Message-ID` need deduplication on `rfc_message_id` at the
  application layer — `mail_messages.rfc_message_id` is already indexed for it.
- **DKIM:** the same key on every node, or one selector per node. Same key is simpler; it also means
  a compromise of any node compromises the domain's signing.

---

## 5. One worker → a worker cluster

**Already supported.** `processJobs` claims with `FOR UPDATE SKIP LOCKED`; two workers cannot claim
the same job. Run `docker compose up -d --scale mail-worker=4`.

The ceiling is not the workers. Each tick is an HTTP call to `/api/jobs/run`, so four workers are
four concurrent serverless invocations doing database work — **the pooler saturates before the
workers do**. Watch pool signals on `/admin/ops` before adding a fifth, and see SCALING.md section 3.

---

## 6. Postgres queue → Redis, and Postgres analytics → ClickHouse

**Both are premature today, and the honest answer is a threshold rather than a plan.**

**Redis** buys you a queue that does not compete with application queries for the same connection
pool. Move when `edu_jobs` write or claim rate saturates — the signal is `queue_enqueue_duration_ms`
climbing while the workers are idle. `QUEUE_DRIVER` is reserved for the switch and
`src/lib/mailplatform/adapters/queue-postgres.ts` is the interface a Redis adapter implements. Do
not push the Postgres queue past its limits in a load test and call that broker throughput.

**ClickHouse** is for event analytics — opens, clicks, deliveries — at a volume where aggregate
queries over `mail_events` stop returning quickly. Roughly: tens of millions of rows. Below that,
Postgres with the right indexes is faster to query and far less to operate. The move is dual-write
(Postgres + ClickHouse), verify parity, then read from ClickHouse; keep Postgres as the system of
record for anything transactional.

---

## 7. Do not do any of this yet

Every migration here is a **response to a measured limit**, not a milestone. Each one adds a
component to operate, a failure mode to learn, and a way to lose mail during the cutover.

The order they will actually be needed, if they are needed:

1. **ZBook → dedicated server** — the moment mail matters, because a laptop's uplink is the weakest
   link in the whole system.
2. **Multiple MTAs** — when one host's outbound queue does not drain, or downtime is unacceptable.
3. **Self-hosted Postgres** — when Supabase's cost or limits actually bind, not before.
4. **Everything else** — when a number says so.

The one thing worth doing before any of them is the thing in OBSERVABILITY.md section 5: an external
uptime monitor. Migrating infrastructure nobody is watching moves the outage; it does not prevent
it.
