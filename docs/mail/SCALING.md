# SCALING

Five stages. **Every number is labelled `measured`, `derived` or `estimate`**, and there is exactly
one measured number in this document.

> `measured` — observed on this stack, command recorded.
> `derived` — arithmetic from a measured number, with the arithmetic shown.
> `estimate` — judgement from how these components behave. **Not tested here.** Treat as a starting
> hypothesis to be replaced by a measurement before it is relied on.

The brief says: do not claim infrastructure capacity without testing. This document's honesty is the
labelling.

---

## 0. The one measured number

```
node tests/load/loadtest.mjs --messages 10000 --concurrency 32     # ZBook, sink target
completed 10000   failed 0   elapsed 13.2s   throughput 757/s
p50 40.7ms   p95 56.5ms   p99 78.8ms
generator CPU 13.2s = 100% of one core
```

**757 messages/second, application layer, sink absorbing delivery.** `measured`.

Three things it is not:

- **Not a delivery rate.** The sink accepts and writes to disk. Real delivery involves DNS, a remote
  MX, TLS, per-destination concurrency and reputation — all absent.
- **Not a ceiling.** The generator saturated a core on the same laptop as the system under test. It
  is a **floor** for the application layer.
- **Not measured through the queue or the database.** Nothing here touched Postgres.

Derived, for scale intuition: 757/s sustained is ~65M/day. Nobody should believe that number as
capacity — it is arithmetic on a floor measured against a component that does no work. It appears
only to make the point that **the application layer is not the constraint at any of the stages
below**. Delivery, reputation and the database are.

---

## 1. 10,000 / day  (~0.12/s average, ~2/s peak)

The current design, unchanged.

| | |
| --- | --- |
| App | Vercel, as is |
| Workers | 1 (`mail-worker`) — `estimate`: two orders of magnitude of headroom |
| MTA | 1 (ZBook or a small VPS) |
| Database | Supabase, transaction pooler |
| Queue | Postgres `edu_jobs` |
| Storage | Vercel Blob, or S3 |
| Monitoring | Prometheus + Grafana on the same host |

**What actually binds here is not throughput, it is deliverability.** A new sending IP delivering
10k/day from day one looks exactly like a spam source. Warm up over 2–4 weeks.

**The real risk at this stage**, and it is present today: the Vercel cron drains the queue **once a
day**. A message queued at 09:01 waits until tomorrow. `mail-worker` exists to fix precisely this;
if it is not running, 10k/day is not achievable regardless of any number above.

---

## 2. 100,000 / day  (~1.2/s average, ~20/s peak)

| | |
| --- | --- |
| App | Vercel |
| Workers | 2–4 — `estimate` |
| MTA | 1–2, separate IPs |
| Database | Supabase paid tier; watch pool saturation on `/admin/ops` |
| Queue | Postgres, still |
| Storage | S3-compatible (MIGRATION.md §3) |

**What binds:** per-destination concurrency. `default_destination_concurrency_limit = 5` in
`main.cf.override` is deliberately conservative — a new IP opening 50 parallel connections to one
receiver looks like an attack. At 100k/day with a concentrated recipient domain, this is the setting
to raise, slowly, watching deferral rates.

**Second thing that binds, and it is easy to miss:** each worker tick is an HTTP call to
`/api/jobs/run`, which is a serverless invocation doing database work. Four workers are four
concurrent invocations against the pooler. `estimate`: **the pooler saturates before the workers
do.** Measure `pool_connections_active` before adding a fifth.

---

## 3. 1,000,000 / day  (~12/s average, ~200/s peak)

| | |
| --- | --- |
| App | Vercel, or self-hosted behind a load balancer |
| Workers | 4–8, dedicated hosts — `estimate` |
| MTA | 2–4 nodes, own IPs and PTRs, round-robin (MIGRATION.md §4) |
| Database | dedicated Postgres, read replica for analytics — `estimate` |
| Queue | Postgres or Redis; the signal to move is §6 below |
| Storage | S3, CDN in front for tracked assets |
| Monitoring | Prometheus + Alertmanager, on a host that is not an MTA |

**What binds:** the database, not the mail path. One million deliveries produce several million
event rows a day (queued, sent, delivered, opened, clicked). `estimate`: analytics queries over
`mail_events` become the slowest thing in the system, well before sending does.

Also at this stage, **bounce handling stops being optional**. At 12/s a 2% hard-bounce rate is
20,000 bad addresses a day; sending to them repeatedly is the fastest route to a blocklist. The
suppression list (`src/lib/mailplatform/suppression.ts`) must be enforced on every send.

---

## 4. 10,000,000 / day  (~120/s average, ~2,000/s peak)

`estimate` throughout — this is beyond anything this design has been tested near.

| | |
| --- | --- |
| App | self-hosted, several nodes |
| Workers | 16+, autoscaled on queue depth |
| MTA | 8+ nodes, multiple /24s, per-destination pools |
| Database | primary + replicas; consider partitioning `mail_events` by month |
| Queue | Redis or a real broker; Postgres is past its comfortable range here |
| Analytics | ClickHouse (MIGRATION.md §6) |
| Storage | S3 with lifecycle rules |

At this volume **deliverability is an operational discipline, not a configuration**: feedback loops
with major providers, per-domain reputation monitoring, dedicated IP pools segmented by mail type
(transactional never shares an IP with marketing), and somebody whose job includes watching it.

---

## 5. 100,000,000 / day

`estimate`, and the honest statement is that **this is a different system, not a scaled version of
this one**. It is the volume at which organisations run their own IP allocation, negotiate directly
with mailbox providers, and operate a delivery team.

Nothing in this repository should be read as a claim that it reaches this. The interfaces are
designed so components can be replaced rather than so this number can be hit.

---

## 6. The signals that say "move", per component

Better than the tables above, because these are measurements rather than plans.

| Component | Move when | Watch |
| --- | --- | --- |
| Worker count | backlog grows for 15 minutes while workers are healthy | `edurankai_mail_queue_depth{status="pending"}`, `era_worker_consecutive_errors` |
| Queue → Redis | enqueue latency climbs while workers are idle | `edurankai_mail_queue_enqueue_duration_seconds` |
| Postgres → dedicated | pool saturation during normal traffic, not peaks | `pool_connections_active` on `/admin/ops` |
| MTA count | outbound queue does not drain overnight | `postqueue -p`, deferral rate |
| Analytics → ClickHouse | aggregate queries over `mail_events` exceed a second | `edurankai_mail_db_query_duration_seconds` |
| Storage → S3 | before it binds — it is a correctness and sovereignty move, not a capacity one | — |

**A component that is not the bottleneck should not be scaled.** Adding workers when the pooler is
saturated makes the system slower, not faster, and the graph that says so is the pool one.

---

## 7. How to replace an estimate with a measurement

```bash
./scripts/start-mail.sh --localdb --observability   # never against the shared database
node tests/load/loadtest.mjs --messages 50000 --concurrency 32
node tests/load/loadtest.mjs --messages 10000 --target queue   # through the app and the DB
```

Watch, in Grafana, during the run: queue depth, oldest-job age, worker jobs/min, database latency,
and the pool gauge. Then **edit the tables above** and change the label from `estimate` to
`measured`, with the command and the date. A number without a label is the thing this document
exists to prevent.
