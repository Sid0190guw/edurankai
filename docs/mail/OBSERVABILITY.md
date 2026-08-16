# OBSERVABILITY

What is measured, where to look, and what is watching. The last question has an uncomfortable
answer; it is section 5.

---

## 1. The health surfaces

| URL | Who may read it | Answers |
| --- | --- | --- |
| `/api/health` | anyone | Is the app up and can it reach the database. 503 on a database outage. |
| `/api/health/ready` | anyone | Should traffic be sent here **yet**. 503 if the database is unreachable or a required variable is absent. Counts only, never names. |
| `/api/health/deep` | operator (`administer`) | Everything above plus configuration, pool pressure, cron state, error volume. |
| `/api/health/mail` | operator (`administer`) | The nine mail components, each `ok` / `degraded` / `not-configured`. |
| `/api/metrics` | `METRICS_TOKEN` (≥32 chars) or operator session | Prometheus exposition. |
| `http://localhost:9100/health` | local | The **ZBook stack**: real TCP/HTTP probes of every container. |
| `http://localhost:9100/ready` | local | Every *expected* component answers. What a deploy script waits on. |

### Liveness and readiness are different questions

**Liveness** (`/api/health`) asks "is this process alive and can it reach its database". A
supervisor that kills on liveness restarts things.

**Readiness** (`/api/health/ready`) asks "should traffic come here yet". The distinction matters at
one moment and it is the moment that hurts: a fresh instance that has booted, passes liveness, and
is missing configuration it needs. It will accept mail and lose it.

A partially-configured *optional* group (four of five `S3_*`) is reported and does **not** block
readiness — the system genuinely still serves, on the fallback. Making warnings block is how a
readiness probe gets disabled by the first person paged at 3am.

### Three states, not two

`ok` / `degraded` / `not-configured`. The third is the point. Redis is not part of the shipped
system — the queue is Postgres — so a green "Redis: ok" would be a lie told by a check that never
ran. Only a component that is **both expected and failing** moves the overall status; what is
expected comes from `MAILOPS_EXPECT`, set per compose profile, so the profile in use decides what
"complete" means rather than the code guessing.

---

## 2. Two metric namespaces, and they mean different things

This is the single most important thing to understand before reading a dashboard here.

### `edurankai_mail_*` — from the application

Emitted by `/api/metrics` (`src/lib/mailplatform/metrics.ts`, owned by the mail-platform patch).

- Its **counters are PROCESS-LOCAL**. On Vercel every instance keeps its own registry and is
  recycled without warning, so one scrape reflects one instance since its cold start.
  `edurankai_mail_registry_age_seconds` is what tells you whether a low number means "quiet" or
  "just restarted". **Do not alert on these as if they were cluster totals.**
- Its **`queue_*` gauges are read from Postgres** at scrape time and therefore **are** cluster-wide.
  Alert on these.
- `edurankai_mail_telemetry_readable` is 0 when the app could not read queue telemetry — every
  queue number in that scrape is then a *default*, not a measurement. A quiet queue and an
  unreadable one must never look alike.

### `era_*` — from the ZBook stack

Emitted by the long-lived services in `docker/mailops/`. Ordinary processes that stay up, so their
counters behave normally and `rate()` is meaningful.

| Series | Means |
| --- | --- |
| `era_mailops_component_up{component}` | 1 up, 0 failing. **Absent = not deployed** — never a zero. |
| `era_mailops_probe_latency_ms{component}` | Probe round-trip. Slow before down is the earliest warning here. |
| `era_ingest_received / _forwarded / _refused / _retries` | Inbound bridge. A gap between received and forwarded means messages are held and retried. |
| `era_worker_ticks / _jobs_processed / _jobs_failed / _consecutive_errors / _backlog` | Queue worker. Non-zero consecutive errors = unreachable app or a wrong secret. |
| `era_sink_messages` | Captured test mail. |

Why the app's numbers are queried rather than counted: an in-process counter library on serverless
reports what one cold instance happened to see, which is usually nothing. It looks like a metrics
system and reports noise.

---

## 3. Prometheus and Grafana

```bash
./scripts/start-mail.sh --observability
# Prometheus  http://localhost:9090
# Grafana     http://localhost:3001   admin / GRAFANA_ADMIN_PASSWORD
```

Both bind to **loopback only**. Prometheus has no authentication of its own and its API can read
every series it holds; Grafana ships with a default admin login. Reach them on the ZBook, or over an
SSH tunnel.

Scrape intervals are deliberately uneven: the stack's own services every 15s (they answer from
memory), the **app every 60s** (each scrape is several Postgres queries, and on the transaction
pooler a connection is scarce — a metrics scrape competing with user traffic is a self-inflicted
incident). Watch `edurankai_mail_scrape` cost; if assembly approaches the interval, widen the
interval rather than adding series.

The bearer token lives in `docker/prometheus/metrics_token`, written by `start-mail.sh` from
`.env.local` and gitignored. Prometheus cannot expand environment variables in that field, which is
why it is a file.

Dashboards are **files** (`docker/grafana/dashboards/`), not database rows. `allowUiUpdates: false`,
so editing a panel in the browser shows "cannot save" — deliberate, because a saved-in-UI change
survives until the next restart and then vanishes.

---

## 4. Scraping production from here

`prometheus.yml` has a commented `app-production` job. It works, and it is commented out because
enabling it means a laptop polls production every minute and the token in that file becomes a
production credential. If you enable it: use a **separate** token file, scrape no more often than
every 300s, and remember the laptop is not always on — gaps in the series will be the laptop
sleeping, not an outage.

---

## 5. Nothing is watching

**There is no Alertmanager and no destination.** `docker/prometheus/alerts.yml` has eleven rules,
Prometheus evaluates them, and they appear as firing on its own Alerts page — which somebody has to
be looking at.

This is stated plainly because a rules file is exactly the artefact that makes people believe they
are covered.

To make alerting real, in ascending order of effort:

1. **An external uptime monitor on `/api/health`.** Five minutes of setup, free, and it catches the
   outage class that matters most — the whole site down — without any of this stack running. Do this
   first; it is worth more than everything else in this section.
2. **Alertmanager** in `compose.observability.yml`, with a receiver (email through this very mail
   system is circular; a webhook to a chat channel is not).
3. **Route by severity.** The rules already carry `severity: critical|warning`.

Every rule has a `for:` clause. A rule without one fires on a single bad scrape and gets muted,
after which none of them work.

---

## 6. Logs

Structured JSON on stdout, one object per line, from every service in `docker/mailops/`:

```json
{"at":"2026-08-16T11:42:12.691Z","svc":"ingest","level":"info","event":"ingest.forwarded",
 "id":"1c83b204-…","to":["connect@edurankai.in"],"attempt":1,"bytes":293}
```

```bash
docker compose --project-directory docker -f docker/compose.yml logs -f mail-parser
./scripts/status-mail.sh --logs      # last 20 lines of anything degraded
```

The worker logs only when something happened. A line every five seconds saying "0 jobs" is how a log
becomes unreadable and a real error becomes invisible.

Application-side logging goes through `src/lib/logger.ts`, which redacts secret-shaped values, and
the mail platform adds `scrubMailMeta()` — bodies dropped outright, addresses reduced to their
domain. A message body carries no secret pattern and is the most sensitive thing this subsystem
touches.

No log aggregation is deployed. At one node, `docker compose logs` is genuinely enough; a pipeline
earns its keep at several.
