# Mail performance, observability and benchmarking

What is measured, where to read it, how to benchmark it, and what the numbers are allowed to claim.

**Read section 1 first if you are about to quote a throughput figure to anyone.**

Companion documents: [`mail-scaling.md`](./mail-scaling.md) (architecture and the server plan),
[`mail-failure-modes.md`](./mail-failure-modes.md) (what each dependency failure does),
[`ops/MONITORING.md`](./ops/MONITORING.md) (the platform-wide ops view this sits inside).

---

## 1. The claim rule

> **No scale target is achieved until it has been benchmarked, and a benchmark only counts if it
> sustained the PEAK rate, not the daily average.**

This is enforced in code, not by convention. `src/lib/mailplatform/capacity.ts` has no function that
returns a throughput number on its own — every projection carries the `Measurement` it came from, and
a tier's verdict can only be `sustained` if a real run held the required rate.

A measurement is rejected outright unless it clears all three bars:

| Bar | Value | Why |
| --- | --- | --- |
| Sustained for | ≥ 60s | A shorter run measures the queue ABSORBING a burst, not workers draining it. |
| Messages | ≥ 500 | Below that, warm caches and an empty table dominate. |
| Failure rate | < 0.5% | Throughput measured while failing is the rate the system REJECTS work, which is always faster. |

Four verdicts, and only one of them is a claim:

- **`sustained`** — a real run held the peak rate for this tier. This is the only verdict you may
  repeat outside the team.
- **`projected`** — arithmetic says how much more would be needed. Assumes linear scaling, which is
  false; see the bottleneck table in `mail-scaling.md`.
- **`insufficient_evidence`** — a run happened but did not clear the bars above.
- **`unmeasured`** — nothing has been run. **This is the current state of every tier.**

### Peak, not average

Daily targets are divided by 86,400 to get an average and then multiplied by `PEAK_FACTOR` (4×).
Sizing to the average guarantees the queue backs up every day at the same hour and reports a healthy
daily total while doing it.

| Target | Average | **Peak requirement** |
| --- | --- | --- |
| 10,000/day | 0.12/s | **0.46/s** |
| 100,000/day | 1.16/s | **4.63/s** |
| 1,000,000/day | 11.57/s | **46.30/s** |
| 10,000,000/day | 115.74/s | **462.96/s** |
| 100,000,000/day | 1,157.41/s | **4,629.63/s** |

`PEAK_FACTOR = 4` is an **assumption**, not a measurement — this deployment has not run enough volume
to observe its real diurnal curve. Under a pure-campaign workload the true factor is much higher,
because a campaign is a single burst. It is exported from `capacity.ts` so one edit replaces it
everywhere once there is a real curve.

---

## 2. Where to read the numbers

| Surface | What it answers | Gate |
| --- | --- | --- |
| **`/admin/mail/performance`** | Everything in this patch: alerts, queue, latency, capacity ladder, database findings, failure-mode coverage. | `administer` on platform |
| `/api/metrics` | Prometheus text exposition. | `administer`, **or** `METRICS_TOKEN` bearer |
| `/api/health` | Public, thin, 503 on database outage. | none |
| `/api/health/deep` | Platform-wide operator health. | `administer` |
| `/admin/mail/health` | Is mail configured and flowing? | admin |
| `/admin/ops` | Platform-wide incidents, error groups, cron. | `administer` |

`/admin/mail/performance` has **no client JavaScript and does not poll** — refresh is a link. A
dashboard on a timer is how leaked intervals exhausted the connection pooler and took this site down.

### `/api/metrics` and the token

The endpoint accepts an operator session **or** a bearer token in `METRICS_TOKEN`. The token path is
written to fail closed:

- If `METRICS_TOKEN` is unset or shorter than 32 characters, **token auth does not exist**. It is not
  "allow anyone" — an unset secret must never widen access.
- The comparison is length-checked, then constant-time. A `===` on a secret leaks its prefix through
  timing.
- Rejected bearer attempts are logged, because a scraper misconfigured for a week and a probe look
  identical in a 401 count.

```bash
# generate a token and set it in Vercel → Settings → Environment Variables
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
curl -H "Authorization: Bearer $METRICS_TOKEN" https://www.edurankai.in/api/metrics
```

---

## 3. Two kinds of number, and why mixing them breaks alerts

This is the single most important operational fact about the metrics.

| Series | Source | Trustworthy as |
| --- | --- | --- |
| `edurankai_mail_queue_*` | Read from **Postgres** on every scrape | **Cluster-wide.** Alert on these. |
| Everything else (counters, latency histograms) | **In-process registry** | Per-instance, since last cold start. |

On serverless the process is recycled without warning, so a scrape of a counter sees one instance
since *its* cold start. `edurankai_mail_registry_age_seconds` is emitted for exactly this reason: a
young registry explains a low counter. Without it, a scrape after a deploy looks like a traffic
collapse.

Consequently:
- **Never alert on the absolute value of a counter.** `rate()` over a window shorter than an
  instance's lifetime is the only safe read, and a deploy still shows as a dip.
- Every page-worthy rule in `ops/prometheus/mail-alerts.yml` uses a `queue_*` gauge. Latency rules
  are `warning` only, and say so.

### Absent is not zero

`edurankai_mail_queue_oldest_age_seconds` is **deliberately not emitted when the queue is empty**. An
empty queue and a fresh head are different facts, and emitting `0` for the first would make them
identical on every graph. Rules use series presence; `absent()` is used where the absence itself is
the incident.

### `edurankai_mail_telemetry_readable`

`0` means the queue reads failed and every queue number in that scrape is a default. This exists
because a panel that renders a confident `0 pending` from a `COUNT` that threw is worse than a blank
panel — the operator stops looking. The same rule governs every panel on
`/admin/mail/performance`: a read that failed says so in words.

---

## 4. What is measured

Ten operations, declared as data in `src/lib/mailplatform/instrument.ts`. A dashboard panel or an
alert can be generated from the catalogue, so a panel can never reference a series nothing emits.

| Key | Layer | What a rise means |
| --- | --- | --- |
| `api.request` | api | Rising p99 with flat p50 is queueing or a cold start, not slower code. |
| `db.query` | database | Includes connection **checkout** on the transaction pooler, so it rises under pool saturation before any query gets slower. |
| `queue.enqueue` | queue | An INSERT on `edu_jobs`. If it climbs, the queue table is the bottleneck, not the workers. |
| `queue.wait` | queue | Enqueue→claim. The honest definition of queue latency; unbounded when arrival exceeds drain. |
| `message.process` | worker | × concurrency = the drain-rate ceiling. This is what `capacity.ts` turns into a worker count. |
| `smtp.connect` | smtp | If p50 tracks message count instead of staying flat, pooling is not working. |
| `delivery.attempt` | delivery | Minus `smtp.connect` = transfer plus remote acceptance time. |
| `inbound.parse` | inbound | Scales with SIZE, not count. The tail is large attachments, and it is CPU on the request path. |
| `workflow.execute` | workflow | A wait node that blocks rather than re-queueing shows up here and steals a worker slot. |
| `campaign.generate` | campaign | The only cost driven by AUDIENCE size rather than send rate. |

**"Declared, never observed" is shown as its own state**, not as a zero. An operation nobody has
instrumented and an operation that is genuinely fast look identical on every monitoring system;
here they do not.

### Percentiles: two paths, different accuracy

- `quantileExact()` — every sample retained. Used by the benchmark, which runs bounded and exits.
- `histogramQuantile()` — bucket counts only, constant memory. Used live. **The answer is an
  interpolation whose error is bounded by the bucket width it lands in.**

The live path returns the bucket it landed in and a `saturated` flag. Prometheus returns `+Inf` for a
saturated quantile and `NaN` for no data, and Grafana renders both as a blank cell —
indistinguishable from healthy. Here you get `"p99 exceeds 60s (top bucket open)"` or
`"not measured"`, which are very different sentences.

**Units:** recorded in milliseconds, exposed in seconds with a `_seconds` suffix. The conversion
happens once, in `toPrometheus()`. Nothing else should divide by 1000.

---

## 5. Logging

Structured JSON via `mailLog()`, which is the only logger mail code should call. Correlation ids:
`request_id`, `message_id`, `campaign_id`, `workflow_id`, `worker_id`, `tenant_id`, `node_id`.

Two scrubbing passes run, and both are needed:

1. **`scrubMailMeta()` — by field name.** `src/lib/logger.ts` already redacts *secret-shaped* values,
   which is necessary and not sufficient: **a message body contains no secret pattern and is the most
   sensitive thing this subsystem touches.** Prose passes every redaction regex ever written, so
   bodies are dropped by name.
2. **`redactMeta()` — by value shape.** Tokens, keys, anything matching `SECRET_PATTERNS`.

| Field kind | Treatment | Why |
| --- | --- | --- |
| Bodies, attachments, raw MIME | dropped | No regex catches prose. |
| Email addresses | **domain kept, local part dropped** (`@example.com`) | The domain is what deliverability work needs; the local part identifies a person. |
| Subjects | short non-reversible tag (`subj:1a2b3c`) | Threading bugs are unreadable without per-subject identity; the content is not needed. |
| Passwords, keys, tokens | dropped, then redacted | Both passes. |

Logging a full recipient list to debug a bounce puts personal data into a log aggregator with a
different retention policy and a different access list from the database it came from.

**Caller-supplied correlation ids are untrusted input.** `correlationFromHeaders()` length-caps and
character-restricts them: an id containing a newline can forge an entire log line.

---

## 6. Alerting

Implemented twice, from one design: as pure functions in
`src/lib/mailplatform/queue-observability.ts` (rendered on `/admin/mail/performance`, unit-tested) and
as Prometheus rules in `ops/prometheus/mail-alerts.yml`.

| Alert | Fires when | Note |
| --- | --- | --- |
| `queue_unreadable` | any queue read failed | **First**, because every rule below it is meaningless while it fires. |
| `queue_growth` | enqueue > processed and depth > 0 | Growth, not depth. A deep queue that is draining is fine. |
| `worker_failure` | work pending **and** nothing completing | Neither half alone means anything — an idle worker with an empty queue is correct. |
| `stalled_messages` | oldest `processing` row > 15m | The crashed-worker gap. See below. |
| `retry_storm` | retries > 50% of outcomes | A **ratio**: 50 retries against 5,000 successes is noise. |
| `dead_letters` | failed > 25 | Read before requeueing; `retryFailed()` resets all of them at once. |
| `queue_age_*` | oldest pending > 5m / 30m | Depth can be small while the HEAD is hours old. |

Every alert carries an **action**. An alert without one is a notification, and a test enforces it.

Thresholds in `DEFAULT_QUEUE_THRESHOLDS` are **starting points sized for one Vercel cron draining
`edu_jobs`**, not measurements. Re-derive them from a real benchmark.

### The crashed-worker gap — read this one

`claimBatch()` flips a row to `processing` and **nothing flips it back**. If a worker is killed
between the claim and the acknowledgement — a serverless timeout, an OOM, a deploy mid-batch — that
row stays `processing` forever:

- not `pending`, so no worker will claim it;
- not `failed`, so `retryFailed()` does not see it;
- counted under `processing`, which on a healthy system is a small number that looks like work in
  flight.

**A message silently never sent, presenting as a healthy queue.**

`stalled_messages` detects it and **Reclaim stalled** on `/admin/mail/performance` fixes it. It is an
operator action rather than an automatic sweep because the safe timeout depends on how long the
longest legitimate job runs, which the code cannot know — set it too low and a slow-but-working job
gets claimed twice. Reclaim does **not** reset `attempts`, so a job that keeps killing its worker
still walks toward dead-letter instead of cycling forever.

---

## 7. Benchmarking

```bash
npx tsx scripts/mail-bench.ts --help
```

Every stage is opt-in. **An absent stage is absent from the report, never estimated.**

```bash
# the pool decision path at full rate — no mail server needed, no socket opened
npx tsx scripts/mail-bench.ts --messages 5000 --concurrency 8 --smtp localhost:1025

# real SMTP against a local sink (Mailpit/MailHog on :1025)
npx tsx scripts/mail-bench.ts --messages 5000 --concurrency 8 --smtp localhost:1025 --send

# HTTP latency against a staging deploy, and publish the result
npx tsx scripts/mail-bench.ts --target https://staging.example.test/api/health \
    --i-know-this-is-not-production \
    --out bench.json --post https://staging.example.test --label "pre-index-change"
```

The runner will not:
- send to anything but a reserved test domain (`assertSafeRecipients` throws);
- send through a non-local relay without `--allow-remote-smtp`;
- target a non-local URL without `--i-know-this-is-not-production`;
- claim a scale tier — it records a measurement, and `capacity.ts` decides what it earned.

**Throughput is wall-clock, not `1/mean`.** With C concurrent lanes, `1/mean` overstates by roughly
C — the most common way a load test reports a number it did not achieve.

**The corpus has a size distribution**, not a constant: ~55% transactional (1–6KB), 28% newsletter
(6–40KB), 15% rich (40–150KB), 2% large (150–600KB). A corpus of identical 2KB messages measures a
system nobody operates; the tail is what saturates parsing CPU, storage and transfer time. The
realised distribution is reported next to the throughput, because "1,200 msg/s" is not reproducible
without the payload it was achieved with. Filler is varied words, not a repeated character — a
repeated character compresses to nothing and makes every storage and transfer measurement wrong by an
order of magnitude.

`--post` sends the report to `/api/admin/mail/bench-report`, which **recomputes every derived field
server-side from the measurement and stores what it computed** — the posted `throughput`, `tiers`,
`resources`, `validity` and `caveats` are discarded outright. Nothing a poster can put in those
fields reaches the capacity screen.

The measurement itself is still the poster's word, and that is deliberate: it is the *input*, the
server cannot verify that a run happened, and `validate()` governs what it earns. What is guaranteed
is that **every number displayed agrees with the measurement stored beside it.**

> This route originally re-derived only the tier *verdicts* and compared them. An adversarial review
> found the hole, and it is worth recording because the shape recurs: comparing a subset means
> everything outside the subset is trusted, and the fields outside the subset were the ones actually
> printed. Posting an honest 100 msg/s measurement with its honest verdicts but a `throughput` of
> 5000 produced the headline *"Demonstrated up to 1 million/day at 5000.00 msg/s sustained"* — an
> earned tier claim beside a 50× fabricated rate, with every verdict checking out. Recomputing
> instead of comparing removes the class of bug, not just the instance.

### Queue load test

```bash
LOADTEST_DATABASE_URL=postgres://localhost/scratch npx tsx scripts/mail-loadtest.ts \
    --messages 10000 --i-know-this-is-not-production
```

Three independent guards, none with a permissive default:
1. `LOADTEST_DATABASE_URL` must be set — it **does not fall back to `DATABASE_URL`**, because a
   developer's shell on this project usually has production credentials loaded.
2. `--i-know-this-is-not-production` must be passed.
3. The URL is checked against a deny-list (`supabase.co`, `neon.tech`, anything containing `prod`).

It fills the queue and stops. **It does not drain it** — drain is the worker's job, and a script that
fills and empties in one process measures the script, not the system. Trigger `/api/jobs/run` and
read the drain rate on `/admin/mail/performance`. `--cleanup` removes exactly the rows it created,
matched by tag rather than by a time window.

---

## 8. Current status

| | |
| --- | --- |
| Scale tiers demonstrated | **none** |
| Benchmarks posted | none |
| Failure modes fully implemented | 8 of 13 (62%) — the other 5 name their gaps |
| Measured operations instrumented at call sites | **0 of 10** — the catalogue and the readers exist; the timers are not yet placed in `mail.ts`, `mail-transport.ts` and `job-queue.ts` |

The last row is the honest limit of this patch. The measurement infrastructure is built and tested;
wiring `timed()` into the send path is a change to core mail functionality, which this patch was
explicitly told not to rewrite. Until those call sites are instrumented, the latency table on
`/admin/mail/performance` will read **"declared, never observed"** for every operation — which is the
accurate thing for it to say.

The queue, database, event-store and MTA panels **do** read live data today, because they read from
Postgres rather than from instrumented call sites.
