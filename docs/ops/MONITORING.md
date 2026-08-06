# MONITORING

What to watch, what each signal means, and what to do about it.

Read the last section first if you are deciding whether to trust this system. **Nothing here is
automated.** Every signal below is real and measured, but every one of them is currently read by a
human opening a page. There is no monitor, no alert, and no pager.

---

## 1. The one screen

`/admin/ops` — capability `administer` on platform. It answers one question, "what is broken", and
hoists every failing check into a single banner at the top. Everything below the banner is evidence
for it.

Two properties worth knowing before you rely on it:

- **It has no client JavaScript and does not poll.** Refresh is a link. A dashboard on a timer is
  how a leaked interval exhausted the connection pooler and took this site down. Do not leave five
  tabs of it open.
- **A panel with no data explains why it has no data** — "pg_stat_statements is not installed", "no
  run recorded". An empty table that reads as healthy is the exact failure mode the page was built
  to avoid. Read the words, not the blankness.

Machine-readable equivalents: `/api/health` (public, thin) and `/api/health/deep` (operator only,
discloses configuration, not for polling).

---

## 2. The signals

The status word on `/admin/ops` is computed exactly like this: **DOWN** if the database check fails;
**DEGRADED** if any other check fails; **HEALTHY** if none do. The thresholds below are the ones the
page actually uses, not aspirations.

### 2.1 Database reachability — the only critical check

| | |
| --- | --- |
| **Where** | `/api/health` -> `database.ok`; `/admin/ops` banner |
| **Measured by** | `dbPing()` in `src/lib/observability-health.ts` — one `SELECT 1`, no DDL, no transaction |
| **Healthy** | `ok: true`, HTTP 200 |
| **Alarm** | `ok: false` -> **HTTP 503** |
| **Means** | The site is down. Every route 500s, because `src/middleware.ts` queries sessions before any handler runs. |
| **Action** | INCIDENT.md 4.1. Check Supabase before touching code. Do not redeploy — it changes nothing and costs one of 100 daily deploys. |

### 2.2 Database latency

| | |
| --- | --- |
| **Where** | `/api/health` -> `database.latencyMs` |
| **Healthy** | Tens of milliseconds |
| **Warning** | Hundreds — pooler pressure building |
| **Alarm** | **> 1500ms** raises "Database latency high" on the banner |
| **Action** | Check 2.3 immediately. Rising latency is usually the first visible symptom of connection exhaustion, and it precedes 2.1 by minutes. |

### 2.3 Connection-pool pressure — the leak signature

| | |
| --- | --- |
| **Where** | `/admin/ops` pool panel; `/api/health/deep` -> `pool` |
| **Measured by** | `poolSignals()` over `pg_stat_activity`: total, active, idle, **idle in transaction** |
| **Healthy** | `idleInTransaction: 0` |
| **Alarm** | **Any value above zero** raises a banner line reading "this is what exhausted the pooler the day the whole site went down" |
| **Means** | Something opened a transaction and did not close it. On the Supabase transaction pooler (port 6543) connections are precious; a handful of stuck ones takes the whole site out. |
| **Action** | Find what holds a connection. The historical cause was a `watchPosition` inside a `setInterval` leaking watchers. Suspect the most recent deploy first; roll it back (ROLLBACK.md section 1). |

`maxConnections` may be `null` — some poolers do not expose `pg_settings`. That is reported, not
faked.

### 2.4 Error volume and grouping

| | |
| --- | --- |
| **Where** | `/admin/ops` error panel; `/admin/hardening` (last 40 raw rows); `/api/health/deep` -> `errors` |
| **Source** | `edu_error_log`, written by `trackError()` in `src/lib/logger.ts` — **the only error log.** Secret-shaped values are redacted at write time. |
| **Grouping** | Rows collapse on a `fingerprint` computed at write time, so the same fault 400 times is one row with count 400. Done in SQL; the page never fetches 400 rows to count them. |
| **Windows** | `lastHour`, `last24h`, `last7d`, `distinct24h` |
| **Alarm** | **`lastHour > 0`** raises a banner line. That is a deliberately low bar: this project's worst failures were quiet, not loud. |
| **Action** | Read the top group. Its `releases` array names the commit that was serving — a new fingerprint appearing right after a deploy is that deploy. A **rising `distinct24h`** means multiple things broke, which usually means infrastructure, not a bug. |

Watch for the **shape**, not just the count. One fingerprint at count 400 is one bug. Forty
fingerprints at count 10 is the database.

### 2.5 Background job queue

| | |
| --- | --- |
| **Where** | `/admin/ops` queue tile; `/admin/jobs`; `/admin/hardening` |
| **Source** | `queueHealth()` over `edu_jobs` — pending / processing / failed / done |
| **Alarm** | **`failed > 0`** raises a banner line |
| **Action** | `/admin/jobs` -> retry, which calls `retryFailed()` and resets attempts. Jobs are idempotent via `dedup_key`, so a retry never double-sends. |
| **Watch also** | `pending` climbing and never draining. See the warning below. |

> **The worker is not scheduled.** `/api/jobs/run` — the process that claims and drains the queue —
> appears in **no** `vercel.json` cron and **no** GitHub Actions workflow. It runs only when an
> admin hits the URL. If `pending` is growing, that is not a bug in the queue; nothing is calling
> the worker. See "Not yet in place".

### 2.6 Scheduled jobs

| | |
| --- | --- |
| **Where** | `/admin/ops` cron table; `/api/health/deep` -> `crons` |
| **Source** | `CONFIGURED_CRONS` in `src/lib/observability-health.ts` (mirrors `vercel.json`, and a test asserts the two match) joined to observed runs in `edu_cron_runs` |
| **Alarm** | **`overdue`** — a run was recorded but is older than 1.5 intervals |

Three states, and confusing them wastes an hour:

| State | Meaning | Action |
| --- | --- | --- |
| `ok` | Ran within the expected window. | None. |
| `overdue` | Recorded a run, then missed one. On a daily cron: it missed a day. | Real signal. Check Vercel's cron log and INCIDENT.md 4.9. |
| `never` | Nothing has **ever** recorded a run. | Usually means the route does not call `recordCronRun()` yet — **not** evidence of failure. |

Two crons are observable today only through side-tables the modules already write:
`mail_config.imap_last_run` and `hei_miner_state.last_run_at`. Everything else reporting `never` is
uninstrumented, which means **a genuinely dead cron currently looks identical to a healthy one.**

### 2.7 Self-bootstrapping schemas

| | |
| --- | --- |
| **Where** | `/api/health` -> `schemas` (counts only); `/api/health/deep` and the `/admin/ops` bootstrap panel (which tables) |
| **Source** | `bootstrapStatus()` — one `information_schema` query covering ten tracked module tables at once |
| **Healthy** | `ran == expected`, `missingCount: 0` |
| **Degraded** | `missingCount > 0` -> `status: "degraded"`, still **HTTP 200**. The public endpoint gives the count; open `/admin/ops` for the names. |
| **Means** | There is no migration runner; DDL runs on first use inside the owning module. A table's absence is that module's deployment status. **Absent is not automatically broken** — a module nothing has exercised has simply not bootstrapped yet. |
| **Action** | Only investigate if the missing table belongs to something that should have run. Cross-reference INCIDENT.md 4.4. |

The ten tracked: `edu_error_log`, `edu_jobs`, `edu_job_log`, `edu_feature_flags`, `edu_cron_runs`,
`edu_releases`, `rbac_audit`, `audit_log`, `edu_sync_queue`, `mail_config`. That is a spot check, not
an inventory of the 343 tables the source can create.

### 2.8 Mail transport

| | |
| --- | --- |
| **Where** | `/admin/ops` mail panel; `/admin/mail/health`; `/api/health/deep` -> `mail` |
| **Measured by** | `mailReachability()` — a bounded 2.5s TCP connect. It **never sends mail and never sends credentials.** |
| **Alarm** | `configured && reachable === false`, or `!configured` ("outbound mail would not leave the building") |
| **Action** | `/admin/mail/settings`. Gmail and Zoho require app passwords. `/admin/mail/health` also shows `last_inbound_at` — inbound mail silently stopping is the more common failure. |

### 2.9 Storage capacity

| | |
| --- | --- |
| **Where** | `/admin/infra` |
| **Source** | `pg_database_size(current_database())`, the 12 largest tables, blob object count and bytes |
| **Ceiling** | **500 MB** on the Supabase free tier |
| **Warning** | 70% — start planning |
| **Alarm** | 90% — act now |
| **Action** | Identify the largest table. `edu_error_log` and `edu_job_log` grow monotonically and nothing prunes them. |

This panel once measured against a **different provider's** quota long after the migration, so an
operator checking headroom was reading a number about a database this project no longer used. It now
reads Supabase. If the provider ever changes again, this panel changes with it or it lies.

### 2.10 Storage backend

`src/lib/storage.ts` -> `storageBackend()` returns `s3`, `vercel-blob`, or **`memory`**.

**`memory` means nothing is being stored.** Uploads report success and vanish on the next serverless
invocation. That is silent data loss, and the only signal is this string. Check it after any change
to `BLOB_READ_WRITE_TOKEN` or the `S3_*` variables.

### 2.11 GitHub Actions

`GitHub -> repo -> Actions`. Two workflows: `imap-poll.yml` (every 10 minutes) and
`task-reminders.yml` (hourly at :07).

> **Read the log, not the checkmark.** Both steps set `continue-on-error: true`, so the job is
> marked **successful even when the poll failed**. A green tick means "the workflow ran", not "mail
> is flowing". Open a recent run and search the log for `::error::` and `::warning::`.
>
> - `::error::Auth rejected` -> `CRON_SECRET` mismatch between Vercel and the repository secret.
> - `::warning::Server returned 5xx` -> transient cold start; the next run retries. Ignore one;
>   investigate a pattern.
> - `::warning::IMAP poll reported a soft failure` -> IMAP credentials. `/admin/mail/setup`.

Cross-check against `/admin/mail/health` -> `last_inbound_at`. If that timestamp is hours old while
the Actions tab is all green, believe the timestamp.

### 2.12 Deploy budget

Vercel Hobby allows **100 deployments per day**. Every push to `main`, every `git revert`, every
"just try it again" is one. `Resource is limited` means the budget is gone: **stop, do not retry,
and tell the founder.** Retrying consumes the same budget. `vercel ls` shows how many have gone
today.

Vercel instant rollback (`vercel rollback` / `vercel promote`) does **not** consume a deploy — which
is exactly why it is the first action in ROLLBACK.md.

### 2.13 Query performance

`slowQueries()` reads `pg_stat_statements`. **Whether that extension exists on this database has not
been observed** — no document in this directory was written with a connection to it, so treat any
claim here about live database state as inference. The code does not guess: it runs the query, and
when the extension is absent the panel says so in words — "Nothing is being measured — this panel is
empty because the data does not exist, not because everything is fast."

Read the panel, not this page. If it shows rows, the extension is installed and the numbers are
real. If it shows that sentence, there is no query-level performance data at all and an empty panel
is **not** a clean bill of health. To settle it in one command:

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
-- no row -> CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  (Supabase: Database -> Extensions)
```

---

## 3. The routine, since nothing is automated

**Daily, two minutes.** Load `/admin/ops`. If the banner says HEALTHY, you are done. If not, work the
named items top-down — the database line first, because nothing below it is trustworthy while it is
down.

**Weekly, ten minutes.**

1. `/admin/ops?hours=168` — the week's error groups. A fingerprint that appears every day and is
   nobody's job is the next incident.
2. `/admin/infra` — database size trend against 500 MB.
3. GitHub Actions — open one `imap-poll` run and read the log body, not the tick (2.11).
4. `/admin/jobs` — is `pending` draining, or has nothing called the worker all week (2.5)?
5. `/admin/mail/health` — `last_inbound_at` within the last day.

**Monthly.** Re-run the pre-flight gate on `main` (DEPLOYMENT.md section 2) and note whether the
`astro check` error count has drifted above the 194 baseline. Confirm the backup cadence in
BACKUP.md section 7 was actually followed.

---

## 4. Threshold table, for whoever wires up the first real monitor

These are the values the code uses today. They are starting points from reasoning about this stack,
not SLOs measured against observed behaviour — treat the first month of data as calibration.

| Signal | Warn | Page | Source |
| --- | --- | --- | --- |
| `GET /api/health` status code | — | **!= 200** | HTTP |
| `database.latencyMs` | > 500 | > 1500 | `/api/health` |
| `pool.idleInTransaction` | — | **> 0** | `/api/health/deep` |
| `errors.lastHour` | > 0 | > 25, or any sudden step change | `/api/health/deep` |
| `errors.distinct24h` rising sharply | yes | — | `/api/health/deep` |
| `queue.failed` | > 0 | > 20 | `/api/health/deep` |
| `queue.pending` not decreasing over 24h | yes | — | `/api/health/deep` |
| Any cron `state == "overdue"` | yes | 2+ overdue | `/api/health/deep` |
| Database size / 500 MB | 70% | 90% | `/admin/infra` |
| `storageBackend() == "memory"` | — | **immediately** | `src/lib/storage.ts` |
| Deploys used today | 80 | 95 | `vercel ls` |

---

## Not yet in place

The honest list. A runbook describing monitoring nobody configured is worse than none, because it is
believed.

- **No external uptime monitor.** `/api/health` returns 503 on a database outage and `HEAD
  /api/health` returns the status code with no body — it was built to be polled. **Nothing polls
  it.** Every incident is currently detected by a human noticing or a user complaining.
  *To fix:* point any external monitor at `HEAD https://edurankai.in/api/health`, 1-minute interval,
  alert on non-200. This is the single highest-value thing missing, and it is roughly ten minutes of
  configuration.
- **No alerting channel.** No pager, no on-call rotation, no chat webhook, no email on failure.
  Nothing tells anyone that anything broke, ever.
  *To fix:* extend `src/lib/notify.ts` / `src/lib/push.ts` — the existing notifiers. A second
  alerting path is a defect.
- **No error-rate alarm.** `errorRate()` computes the 1h / 24h / 7d windows correctly, but only when
  a human loads `/admin/ops`. A spike at 3am is invisible until someone opens the page in the
  morning.
- **The background job worker is never called.** `/api/jobs/run` is in no cron and no workflow. The
  queue is reliable; nothing drains it on a schedule.
  *To fix:* a `vercel.json` cron entry (daily is allowed) plus the matching `CONFIGURED_CRONS` line,
  or a GitHub Actions schedule for sub-daily draining as `imap-poll.yml` already does.
- **The security scan is never called.** `/api/cron/security-scan` is scheduled nowhere. Its own
  header calls it "the serverless replacement for a resident continuous monitoring daemon" — with no
  schedule, detection latency is infinite. It also currently **fails open** when `CRON_SECRET` is
  unset, returning its findings to any caller (DEPLOYMENT.md 4.4c).
- **Most crons are uninstrumented.** `recordCronRun()` exists; very few routes call it. A dead cron
  and a healthy uninstrumented one both display `never`.
  *To fix:* one line per cron route — `await recordCronRun('/api/cron/x', 'ok', 'processed N')`.
- **No query-level performance data, unless `pg_stat_statements` happens to be installed** — which
  has not been observed from here, only handled (2.13). Check the panel before believing either
  answer.
- **No CI.** Nothing runs `astro check`, `npm run build`, or the 62 `*.test.ts` files on push. The
  claim on `/admin/hardening` that the authz and secret audits are "CI-enforced" describes an
  intention: `src/lib/security-audit.test.ts` exists and passes, but only when a human runs
  `npx tsx src/lib/security-audit.test.ts`.
- **No log retention or pruning.** `edu_error_log` and `edu_job_log` only grow. Against a 500 MB
  ceiling that is a slow leak with no alarm on it.
- **No release record on boot.** `recordRelease()` writes `edu_releases`, but only from
  `/api/health/deep` and `/admin/ops` — both of which require an operator to visit. A deploy nobody
  looked at leaves no trace in the database.
