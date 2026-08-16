# Mail scaling architecture

How the mail platform grows from where it is to where the targets are, what binds first at each step,
and which components stay on Supabase along the way.

Companion documents: [`mail-performance.md`](./mail-performance.md) (measurement and benchmarking),
[`mail-failure-modes.md`](./mail-failure-modes.md).

---

## 0. Where this actually is today

Stating this first, because every number below is meaningless without it.

- **The live mail system** is `src/lib/mail.ts` and friends: `mail_messages`, `mail_recipients`,
  `mail_box`, `email_logs`, `mail_reads`, plus scheduling/labels/rules in `mail-advanced.ts`.
  One SMTP transport, or none.
- **`src/lib/mailplatform/types.ts` is a contract with no implementation.** `adapters/` is empty.
  The multi-tenant model it describes (`mp_organizations`, `mp_campaigns`, `mp_contacts`, …) does not
  exist as tables yet.
- **The queue is `edu_jobs`**: Postgres, `FOR UPDATE SKIP LOCKED`, exponential backoff capped at 5
  minutes, unique `dedup_key` for idempotency. Not Redis, not SQS.
- **There is no Redis and no cache tier.**
- **Workers are a Vercel cron hitting `/api/jobs/run`.** On the Hobby plan that cron is **daily**.
- **No scale target has been benchmarked.** Every tier reads `unmeasured`.

Patch 8 added measurement, not capacity. It does not make anything faster; it makes it possible to
find out how fast it is.

---

## 1. What binds first

Adding workers stops helping long before the arithmetic says it should. These are constraints that
are real and present on **this** deployment, not generic cautions. They are also returned by
`bottleneckNotes()` and rendered on `/admin/mail/performance`, so the projection is never read alone.

| Binds at | Component | The limit | Consequence | Remedy |
| --- | --- | --- | --- | --- |
| **10k/day** | Vercel cron | Hobby cron runs **daily** | Queue latency is measured in **hours** no matter how fast a worker is, because nothing invokes it. A plan setting, not a code limit. | Paid plan for minute-level cron, or an external scheduler / long-lived worker. |
| 100k/day | Serverless wall time | A request-scoped worker must finish inside the platform timeout | Batch size is capped by wall time, not throughput — and a long batch is **killed mid-flight**, which is the stalled-processing gap. | Long-lived worker process (stage 2 below). |
| 100k/day | Queue claim contention | `SKIP LOCKED` is correct and still serialises on the same hot rows | Adding workers stops adding throughput at some concurrency. **The knee must be measured; it cannot be derived.** | Benchmark claim rate vs worker count. Past the knee: partition by kind, or move to a broker. |
| 1M/day | Connection pooler | Supabase transaction pooler has a fixed ceiling shared by the whole app | Workers and web requests compete. Saturation appears first as latency on unrelated pages, then as sitewide connection errors — **this project has already had whole-site outages from database exhaustion.** | Separate pool for workers, read replicas for analytics, batch inserts. |
| 1M/day | Event storage in Postgres | ~4M event rows/day at the modelled 4 events/message | Analytics compete with the send path on one instance. | Partition (already done for `mp_events`), then ClickHouse. |
| 10M/day | **Sending IP reputation** | Not a capacity limit. Providers throttle per IP by reputation; a new IP is throttled hardest. | **Adding MTA nodes does not multiply accepted mail.** Sending faster than reputation allows produces deferrals, then blocks that take weeks to undo. | Warm IP pools gradually, separate streams, drive throttles from measured deferral rates. |
| 100M/day | Single-region architecture | ~4,600 msg/s sustained at peak | A different system: multi-region MTA clusters, a real broker, a column store, a deliverability function. **Nothing in this repository is evidence about this tier.** | Stage 4 below. Do not project here from a laptop benchmark. |

---

## 2. Worker scaling

Workers must be **stateless**, and the ones here are: all state lives in `edu_jobs`. Scaling out is
adding processes that call the same claim query.

`FOR UPDATE SKIP LOCKED` gives safe concurrent claiming — two workers never take the same row. What
it does not give:

| Property | Status |
| --- | --- |
| Horizontal scaling | **Yes** — stateless claim, no coordination. |
| Job acknowledgement | **Yes** — `complete()` / `fail()`. |
| Retry with backoff | **Yes** — exponential, capped at 5 min, then dead-letter. |
| Idempotency | **At enqueue** — unique `dedup_key`. **Not at delivery**: SMTP has no idempotency key, so a retry after an ambiguous failure can duplicate. |
| Graceful shutdown | **No.** A killed worker leaves its rows claimed forever. See below. |

### The reclaim gap

This is the most important reliability finding in Patch 8 and it is described in full in
[`mail-performance.md` §6](./mail-performance.md#the-crashed-worker-gap--read-this-one).

In short: `claimBatch()` sets `status='processing'` and nothing ever sets it back. A killed worker
leaves rows that no worker will claim and no retry sweep will find, counted as work in flight.
`reclaimStalled()` fixes it; the `stalled_messages` alert detects it; it is an **operator action**
because the safe timeout depends on the longest legitimate job.

**Proper graceful shutdown** — trap `SIGTERM`, stop claiming, finish the current batch, exit — becomes
possible at stage 2, when workers are long-lived processes rather than request handlers. It cannot be
implemented meaningfully inside a serverless function that is killed without warning.

### Sizing

`workersForPeak = ceil(peakRate / perWorkerRate)` where `perWorkerRate = measuredRate / concurrency`.
`capacity.ts` computes it and **returns `null` when there is no measurement**. It assumes linearity,
which fails at the claim-contention knee in the table above.

---

## 3. MTA scaling

`src/lib/mailplatform/mta-pool.ts`. **The point is the indirection, not the algorithm.** Application
code hands a message to a pool and never names a node, so adding MTA-02 is a row rather than an edit
to every send path. `singleNodePool()` wraps today's one transport in exactly that shape, so the seam
is load-bearing from day one instead of being a design document.

Built and unit-tested against a simulated multi-node rack:

- **Weighted least-loaded selection.** Load is `inFlight / (maxConcurrent × weight)`, not raw
  in-flight — raw in-flight sends equal traffic to a 2-core VM and a 32-core box, so the small node
  saturates while the big one idles and pool throughput is set by the weakest member.
- **Circuit breaker.** Opens after 5 consecutive node failures, probes after 60s, needs a success
  **streak** to close. Why it exists: *a dead node is the least loaded node on the rack* — it accepts
  and fails instantly, so least-loaded selection would preferentially feed it.
- **Deferrals never trip the breaker.** A 4xx is the *recipient's* server asking us to come back
  later. Counting that as node failure would open every circuit in the pool the first time a large
  provider throttled a campaign, stopping delivery to everyone else at the same time.
- **Per-domain token buckets**, keyed by `(node, domain)` because the IP is per node. Value-typed and
  time-derived rather than timer-based, so the same struct works in memory, in Postgres or in Redis
  later — a per-process bucket throttles nothing once there are two processes.
- **IP pools by stream.** Reputation is per-IP; separating `transactional` from `marketing` means a
  campaign cannot damage the reputation carrying password resets.

Default limits are **conservative policy guesses, not measurements**: 10/s with a burst of 20. The
cost of being too slow is a longer campaign; the cost of being too fast is a block that takes weeks
of reputation work to undo. The only honest source of a real number is this deployment's own deferral
rate.

**Today MTA-01 exists and MTA-02…MTA-N do not.** With one node the correct failure behaviour is to
queue and retry — there is nowhere to fail over to.

---

## 4. Event architecture and analytics scaling

`src/lib/mailplatform/events.ts`. Every major event carries the §5 envelope: `event_id`,
`event_type`, `occurred_at`, `tenant_id`, `message_id`, `contact_id`, `campaign_id`, `workflow_id`,
`source`, `source_id`, `metadata`.

Validation is strict in one specific way: **`message.*` events require a message id**, campaign
events require a campaign id, workflow events require a workflow id. An event about a message that
cannot name the message is unjoinable — it inflates counts and answers nothing. A missing dimension
cannot be backfilled into an append-only store, because the information was never captured.

### Not blocking transactional work

The §6 requirement, and the failure it prevents is specific: an event write on the send path is a
synchronous INSERT holding a pooled connection, so **an analytics table under load slows down sending
mail**.

- `EventBuffer` batches and flushes as **one multi-row INSERT** — one round trip instead of 200.
- The buffer is **hard-capped** with an oldest-first drop policy. An unbounded buffer in front of a
  failing sink turns a metrics outage into an OOM kill of the process that is sending mail.
- A failed flush **puts rows back** (up to the cap), so a pooler blip does not lose events.
- Drops are **counted** (`events_dropped_total`) and alerted on. Mail delivery is unaffected by
  design; this counter is what stops that trade-off being silent.

**Serverless caveat, stated plainly:** the process can freeze the moment a response is returned, so a
buffer flushed on a timer may never flush. Flushing before responding trades latency for durability.
A long-lived worker process removes the trade-off entirely.

### Postgres → ClickHouse

`mp_events` is **monthly range-partitioned from the start**. This is not premature: retention on an
append-only table is either an instant partition `DETACH` or a bulk `DELETE` plus hours of vacuum on
a table that is still being written to — and converting a large unpartitioned table later requires
copying every row. The cost now is one extra DDL statement. A `DEFAULT` partition means an insert can
never fail for a missing month; rows landing there signal that partition maintenance has stopped, and
`/admin/mail/performance` reports that count.

The ClickHouse DDL uses **exactly the same column names in the same order**, so the migration is a
copy rather than a remodelling:

```sql
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, event_type, occurred_at)
```

`ORDER BY` leads with `tenant_id` because every analytics query starts by narrowing to a tenant;
leading with `occurred_at` would make the primary index useless for the filter that actually reduces
the scan.

Export uses **keyset pagination on `(occurred_at, event_id)`**, matching the primary key. Not
`OFFSET`: `OFFSET 4000000` re-reads four million rows to skip them, so an export gets quadratically
slower as it proceeds — the classic way a migration that worked in staging never finishes in
production.

**Move when measured, not when planned.** The trigger is analytics queries competing with the send
path on the same instance — visible as `db.query` p99 rising while `pg_stat_statements` shows
aggregates at the top. Expected around 1M messages/day.

---

## 5. Database

`src/lib/mailplatform/db-perf.ts` **reads** catalogue views and returns findings with evidence
attached. **Nothing here changes a schema** — recommendations print SQL for a human to run, which is
also this project's established rule for production DDL.

Two rules worth stating because most naive detectors get them wrong:

- **A sequential scan is only flagged on a table that is both large and mostly scanned.** A small
  table scanned constantly is the planner being right, and "add an index" there costs writes and buys
  nothing.
- **A `UNIQUE` or `PRIMARY` index is never suggested for dropping**, whatever its scan count. It
  enforces a constraint, not a query. `edu_jobs.dedup_key` is the queue's entire idempotency
  guarantee; dropping it because a stats view called it unused would permit duplicate sends.

Partitioning is recommended **only for append-only tables** (`mp_events`, `email_logs`,
`edu_job_log`, `mail_reads`, `mail_link_clicks`). Partitioning a table updated in place across
partition keys costs row movement and gains nothing.

`pg_stat_statements` is **not installed** on this database. That panel reports its own absence rather
than rendering empty — "nothing is being measured" and "everything is fast" must not look alike.

---

## 6. Server plan

### Stage 0 — now: Vercel + Supabase

| | |
| --- | --- |
| App | Vercel serverless |
| Database | Supabase Postgres, transaction pooler `:6543` |
| Queue | `edu_jobs` in the same Postgres |
| Workers | Vercel cron → `/api/jobs/run` |
| MTA | one SMTP relay |
| Realistic ceiling | **unmeasured.** The daily-cron limit binds before anything technical. |

**Do first:** minute-level cron. Everything else is downstream of the queue actually being drained.

### Stage 1 — single dedicated server (the ZBook, or one box)

Move the **workers** off serverless. Nothing else changes.

| Component | Where | Why |
| --- | --- | --- |
| Web app | **stays on Vercel** | Edge, TLS, deploys. No reason to move. |
| Database | **stays on Supabase** | Backups, PITR, patching. Not worth self-hosting yet. |
| Workers | **dedicated box** | Long-lived process: real graceful shutdown, no wall-time cap, no cold starts, connection reuse. |
| MTA | still one relay | |

This is the highest-leverage step in the whole plan. It removes two of the three constraints that
bind below 1M/day, and it is one process on one machine.

The ZBook is fine for **development and benchmarking**. It is not a production host: a residential
IP will not deliver mail, there is no redundancy, and a laptop that sleeps is a queue that stops.

### Stage 2 — multiple dedicated servers

Workers scale horizontally with no coordination (stateless claim). Add a **second connection pool /
credential for workers** so they cannot starve the web app — this is where the shared-pooler
constraint binds.

| Component | Where |
| --- | --- |
| Web app | Vercel |
| Database | **Supabase, larger instance + read replica.** Analytics reads move to the replica. |
| Queue | still Postgres. Measure the claim-contention knee before assuming a broker is needed. |
| Workers | N boxes |
| Events | still Postgres, partitioned. Evaluate ClickHouse here. |

### Stage 3 — MTA cluster

The first stage where the pool abstraction earns its keep.

- 2+ MTA nodes, separate IP pools for transactional and marketing.
- **Warm new IPs gradually.** This is weeks of calendar time and cannot be compressed.
- Feedback loops: FBL registration, DMARC aggregate reports, per-domain deferral tracking driving
  the token buckets.
- Database: **consider leaving Supabase** if the pooler ceiling binds. Postgres stays; the hosting
  changes.
- Analytics: **ClickHouse**, fed by the NDJSON export.

### Stage 4 — multi-region

10M+/day sustained. MTA nodes per region, a real broker, regional read replicas, and a deliverability
function that is somebody's actual job.

**Nothing in this repository is evidence about this stage.** It is named because §16 asks for it, not
because it is planned.

### What stays on Supabase

| Stage | Supabase holds |
| --- | --- |
| 0 | everything: app data, mail, queue, events |
| 1 | everything; workers connect from outside |
| 2 | everything, plus a read replica for analytics |
| 3 | transactional data. Events move to ClickHouse. Reconsider hosting if the pooler binds. |
| 4 | transactional data only, or a self-hosted cluster if regional latency demands it |

The consistent answer: **Supabase keeps the data that needs transactions and backups.** Analytics
leave first because they are append-only and tolerate eventual consistency; the queue leaves last,
or never, because its correctness depends on the same transactional guarantees.

---

## 7. Optimisation — only after measurement

Ordered by expected value on **this** deployment. Do not start below the line before the item above
it has been measured.

1. **Minute-level cron.** Removes an hours-long queue latency. No code change.
2. **Long-lived workers.** Removes the wall-time cap and cold starts.
3. **Batch inserts** on the send path. `dbStatementsPerMessage` is the multiplier on every pooler
   constraint; the event buffer already does this.
4. **Indexes**, driven by `pg_stat_statements` — which has to be installed first.
5. **Connection pooling for workers**, separate from the web pool.
6. **SMTP connection reuse.** If `smtp.connect` p50 tracks message count, every message is paying for
   a fresh TLS handshake.
7. **Partitioning** `email_logs` and `edu_job_log` when they cross ~10M rows.
8. **Read replicas** for analytics.
9. **ClickHouse.**
10. **A broker**, only after the Postgres queue's claim-contention knee has been measured and found
    to be the binding constraint. The queue is reliable; it is not a broker; and pushing it past its
    limits in a load test and calling that broker throughput would be a measurement of nothing.
