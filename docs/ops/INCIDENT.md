# INCIDENT — the first fifteen minutes

You are here because something is broken and you did not build it. Work top to bottom. Do not skip
to a theory; every signature in section 4 has been mistaken for a different one on this project.

Rule for the whole document: **reported success and observable result are not the same thing.** A
green message from a script proves the script ran. Check the actual surface.

---

## 0. Minute zero — write down the time

Open a note. Record: the time you started, what you were told was broken, and the URL that failed.
You will need all three later and you will not remember them.

Do **not** deploy anything yet. Do not restart anything. Nothing here is time-critical enough to
justify changing two things at once.

---

## 1. Minutes 0-2 — is the whole site down, or one route?

Two commands. They separate the two incident classes that need completely different responses.

```bash
# The homepage. Server-rendered, so a 200 here means Astro booted AND the edge is serving.
curl -s -o /dev/null -w 'home        %{http_code}  %{time_total}s\n' https://edurankai.in/

# The reported URL.
curl -s -o /dev/null -w 'reported    %{http_code}  %{time_total}s\n' https://edurankai.in/<the-failing-path>
```

| Result | Class | Go to |
| --- | --- | --- |
| Both 500 / both time out | **Site-wide.** Almost always the database or a deploy. | Section 2, then 4.1 and 4.2 |
| Home 200, reported 500 | **One route.** A code fault in that handler. | Section 3, then 4.3-4.7 |
| Home 200, reported 404 | The deploy is not live, or the route was renamed. | DEPLOYMENT.md section 6 |
| Home 200, reported 302 to `/admin/login` | Not an outage. A session or capability problem. | Section 4.8 |
| Everything 200 but "nothing happens" | A swallowed exception. This is the nastiest class. | Section 4.5 |

---

## 2. Minutes 2-4 — ask the site what is wrong

`/api/health` is unauthenticated and deliberately thin. It runs two statements, no DDL, no writes,
and it returns **503 when the database is unreachable** — that is the entire point of it, because a
monitor can only see an outage if the status code changes.

```bash
curl -s -w '\nHTTP %{http_code}\n' https://edurankai.in/api/health
```

Expected shape:

```json
{ "status": "ok",
  "database": { "ok": true, "latencyMs": 41 },
  "schemas":  { "ran": 10, "expected": 10, "missing": [] },
  "release":  { "commit": "e27c6a4", "ref": "main", "environment": "production", "known": true },
  "checks":   [ { "name": "database", "ok": true, "critical": true, "detail": "41ms" } ] }
```

How to read it:

| Observation | Meaning | Next |
| --- | --- | --- |
| HTTP 503, `database.ok: false` | Database unreachable. `database.error` carries the real Postgres reason (read off `e.cause`, not `e.message`). | 4.1 |
| HTTP 200, `status: "degraded"` | Serving, something is wrong. Usually `schemas.missing` is non-empty. **Not a page-somebody event.** | 4.4 |
| HTTP 200, `status: "ok"` | The database is fine. The fault is in one route. | Section 3 |
| Connection refused / no response at all | Not the app — DNS, the domain, or Vercel itself. Check `vercel ls` and the Vercel status page. | 4.2 |
| `release.known: false` | `VERCEL_GIT_COMMIT_SHA` is absent. You are probably not talking to a Vercel deployment. | DEPLOYMENT.md 6 |
| `release.commit` is **not** the SHA you expect | The deploy you think is live is not live. | DEPLOYMENT.md 6 |

Latency is a signal on its own. On this stack `database.latencyMs` in the tens of milliseconds is
normal; hundreds means pooler pressure; seconds means you are watching the start of 4.1.

For an uptime monitor, `HEAD /api/health` returns the status code with no body.

---

## 3. Minutes 4-7 — the operator surfaces

Sign in as an admin. `/admin/ops` is the incident board; everything else is a specialist view.

| URL | What it tells you | Gate |
| --- | --- | --- |
| **`/admin/ops`** | Failing checks hoisted to one banner; grouped errors (400 repeats of one fault collapse to one row with a count); error volume over 1h / 24h / 7d; cron last-run; pool pressure; queue depth; which bootstrap schemas have run; mail reachability. **Start here.** | `administer` on platform |
| `/api/health/deep` | The same data as JSON. Discloses configuration (mail host, pool internals), so it is capability-gated and fails closed — 401 unauthenticated, 403 without `administer`. Not for polling. | `administer` on platform |
| `/admin/hardening` | Security posture, queue health, the last 40 redacted rows of `edu_error_log`. | `administer` on platform |
| `/admin/infra` | Live `pg_database_size`, the 12 largest tables, blob usage. Free tier ceiling is 500 MB. | admin / super_admin |
| `/admin/diagnostics` | Environment-variable presence booleans, table presence, row counts, Razorpay LIVE vs TEST. | any non-applicant |
| `/admin/mail/health` | Whether `CRON_SECRET` is present on this deployment, and whether mail is flowing (`last_inbound_at`). | any non-applicant |
| `/admin/jobs` | Background queue: pending / processing / failed / done, with a retry action. | admin |

`/admin/ops` has **no client JavaScript and does not poll** — refresh is a link. That is deliberate:
a dashboard on a timer is how a leaked interval exhausted the connection pooler and took this site
down. Do not open five copies of it.

A panel with no data on `/admin/ops` says *why* it has no data ("pg_stat_statements is not
installed", "no run recorded"). An empty panel that reads as healthy is the failure mode that page
was built to avoid — trust the words, not the blankness.

---

## 4. The known signatures

### 4.1 Every route 500, session queries failing -> the database is unreachable or out of compute

**What you see.** `/api/health` returns 503. Every page, public ones included, returns 500. Logs are
full of failures from `validateSessionToken`, because `src/middleware.ts` runs on every request and
queries `sessions` joined to `users` before any handler executes.

**Why it is total.** `src/lib/db/index.ts:15` throws `DATABASE_URL is not set` at module import, and
the middleware imports it. There is no route that does not go through this.

**Three distinct causes, in the order they have actually happened here:**

1. **Connection-pool exhaustion.** The site went fully down once when a `watchPosition` inside a
   `setInterval` leaked watchers and drained the Supabase transaction pooler. The signature is
   `poolSignals()` on `/admin/ops` showing **idle-in-transaction climbing**. Connections on the
   transaction pooler (port 6543) are precious; anything that holds one is a bug.
2. **Provider compute quota exhausted.** Historically on the previous provider, every route 500 plus
   failing session queries with no code change meant free-tier compute was used up — not an attack,
   not a bug. Check the Supabase dashboard for the project's status before you look at code.
3. **`DATABASE_URL` wrong or missing on the deployment.** Check `/admin/diagnostics` if you can
   reach it at all; otherwise the Vercel environment-variable screen.

**First action:** confirm which one before changing anything. Open the Supabase dashboard. If the
project is paused, over quota, or restarting, no amount of redeploying helps and a redeploy costs
you one of 100 daily deploys.

### 4.2 A deploy that fails in about two seconds -> a malformed environment variable

**What you see.** The Vercel deployment goes to `Error` almost immediately — much faster than a real
compile failure, which takes tens of seconds on this project (a clean server build is roughly 30s).
There is little or no build log because there was no build.

**Cause.** Whitespace in an environment variable, classically a trailing space or newline in
`CRON_SECRET`.

**Fix.** Vercel -> Project -> Settings -> Environment Variables. Re-enter the value with no leading
or trailing whitespace and no newline. Set Production, Preview and Development. Redeploy. Then
confirm the value still matches the GitHub repository secret of the same name
(`Settings -> Secrets and variables -> Actions`) — `.github/workflows/imap-poll.yml` and
`task-reminders.yml` both authenticate with it, and a mismatch shows in the Actions log as
`::error::Auth rejected.`

**Do not** interpret a 2-second failure as a code problem and start reverting commits. See
DEPLOYMENT.md 4.4.

### 4.3 A page reports success while nothing changes -> a swallowed exception

**What you see.** A form posts, the UI says "Saved", and the database is unchanged. Or a diagnostic
page reports "All checks passed" while the thing it checks is broken. No error anywhere.

**Cause.** A bare `catch` that discards the error. This has cost this project real time: a bare
`catch { errorMsg = 'Login error' }` hid a total sign-in outage for hours, and a hire failed silently
for **eleven days** because the real Postgres reason lives on `e.cause` and was thrown away.

**Find it:**

```bash
cd /c/Users/user/Projects/edurankai-phase36

# Bare catches that discard the error entirely:
grep -rnE "catch\s*\{[^}]*\}" src/pages/<the-area> --include=*.ts --include=*.astro | head -40
grep -rn "catch (_)" src/pages/<the-area> --include=*.ts --include=*.astro | head -40

# Promise-level swallows — the same defect with different syntax:
grep -rn "\.catch(() => {})" src/ --include=*.ts --include=*.astro | head -40
grep -rn "\.catch(() =>" src/pages/<the-area> | head -40
```

**Confirm before fixing:** log `e?.cause?.message || e?.message`. `e.message` alone is just the
failed SQL and tells you nothing. Never swallow an exception in a login, signing, or write path.

**A close relative:** a handler whose very first line throws `ReferenceError: Cannot access '<x>'
before initialization`. `const` is not hoisted. This broke apply step 5 and the `/admin/roles/diagnose`
Repair button, which threw on its first line every single time while the page cheerfully reported
"All checks passed". Every `const` must be declared **before** the handler that uses it.

### 4.4 "column ... does not exist" / "relation ... does not exist" -> declared but never created

**What you see.** One route 500s. The log names a column or a table. Everything else works.

**Cause.** There is no migration runner. DDL self-bootstraps inside the module that owns it, on first
use (`src/lib/ensure-once.ts`, memoised per server process). A module nothing has exercised yet has
simply never created its table — and a column that exists only in someone's mental model never
existed at all.

Real instances from `docs/KNOWN_GAPS.md`:

```
[admin-access] employee lookup column "work_email" does not exist   -> locked every admin out of /admin
relation "hr_task_log" does not exist                               -> only CREATEd inside the clock-out handler
u.full_name (users has `name`)                                      -> /portal/messages 500 for every user with a thread
```

**Triage.** `/admin/ops` shows `bootstrapStatus()` — which of the ten tracked module tables exist. If
the named table is one of them and shows absent, the owning module has never run in production;
absent is **not** automatically broken.

**Verify against writers, never against `db/hr-schema.sql`.** The authorities are
`src/lib/db/schema.ts` and the code that actually INSERTs the column.

```bash
grep -rn "<column_name>" src/lib/db/schema.ts src/lib/ src/pages/ | grep -iE "insert|update|add column" | head
```

### 4.5 `undefined` where a row should be -> `r.rows[0]`

postgres-js resolves `execute()` to a **plain array**, never a `{ rows }` object. `r.rows[0]` is
always `undefined` here, and the symptom is a page rendering zeros or blanks rather than throwing.

```bash
grep -rn "\.rows\[0\]" src/ --include=*.ts --include=*.astro | head -20
```

Correct form, used consistently elsewhere in the codebase:

```ts
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
```

### 4.6 A log line that is just SQL -> you are reading the wrong property

If an error message is a chunk of SQL and explains nothing, the real Postgres reason is on
`e.cause`. Always log `e?.cause?.message || e?.message`. `/api/health`, `/api/health/deep` and
`src/lib/logger.ts` all already do this; older code may not.

### 4.7 GitHub Actions shows red every ten minutes -> CRON_SECRET mismatch

`.github/workflows/imap-poll.yml` runs every 10 minutes and `task-reminders.yml` hourly at :07. A
401/403 from the site produces:

```
::error::Auth rejected. The CRON_SECRET in this repo doesn't match the CRON_SECRET on Vercel.
```

Generate one value, paste the identical string into the Vercel environment variable **and** the
GitHub Actions repository secret, then redeploy Vercel.

**Read the log, not the checkmark.** Both workflows use `continue-on-error: true`, so the job is
marked successful even when it emitted `::warning::` — a green tick does not mean mail is flowing.

### 4.8 Redirected to /admin/login while signed in -> session or capability, not an outage

- `src/middleware.ts` normalises repeated slashes and redirects **every** `/admin/*` path except
  exactly `/admin/login` when there is no valid session.
- If login itself throws, suspect the session cookie. `src/lib/auth/cookie.ts:18` trims
  `SESSION_COOKIE_NAME` and falls back to `edurankai_session` on an invalid value rather than
  throwing — but **changing** that variable signs everyone out at once, because the browser holds a
  cookie under the old name.
- Rotating `SESSION_SECRET` does **not** sign anyone out: session ids are `sha256(token)` with no
  secret involved.
- If one person is redirected and others are not, it is a capability decision, not an incident.
  `/admin/ops` and `/admin/hardening` both require `administer` on platform.

### 4.9 A scheduled job has not run

Check `/admin/ops` cron panel first. It distinguishes three states, and they mean different things:

| State | Meaning |
| --- | --- |
| `never` | Nothing has ever recorded a run. Usually the route does not call `recordCronRun()` yet — **not** evidence of failure. |
| `overdue` | A run was recorded but is older than 1.5 intervals. On a daily cron, it missed a day. |
| `ok` | Ran within the expected window. |

Then check the obvious causes: is the path actually in `vercel.json` `crons`? Is the schedule
sub-daily (Hobby is **daily only**, and a sub-daily entry fails the deploy)? Two routes look
scheduled and are not — `/api/jobs/run` and `/api/cron/security-scan` appear in no cron list and no
workflow. See MONITORING.md.

---

## 5. Minutes 7-12 — read the logs before forming a theory

```bash
cd /c/Users/user/Projects/edurankai-phase36

vercel whoami
vercel ls                                  # deployments newest-first: state, target, age
vercel inspect <production-url>            # which commit is serving, and its state
vercel inspect <production-url> --logs     # build AND runtime logs for that deployment
vercel logs <production-url>               # runtime log stream
```

On this project, reading `vercel inspect --logs` **before** diagnosing has repeatedly turned a
multi-hour guess into a two-minute fix. Everything the app logs is structured JSON from
`src/lib/logger.ts` — searchable by the `event` field:

```
{"ts":"...","level":"error","event":"health.check_failed","message":"..."}
```

Secret-shaped values are redacted at write time by `redactMeta`, so the logs are safe to paste into
an incident note.

---

## 6. Minutes 12-15 — decide, and do exactly one thing

| Finding | Action |
| --- | --- |
| Database unreachable / over quota | Nothing in the repo fixes this. Founder + Supabase dashboard. **Do not redeploy** — it changes nothing and costs a deploy. |
| Pool exhausted by a leak | Identify the leaking timer/watcher. Roll back the deploy that introduced it (ROLLBACK.md section 1). |
| Bad deploy, code fault | Vercel instant rollback (ROLLBACK.md section 1), then `git revert` (section 2). Check whether it left DDL behind — ROLLBACK.md section 3. |
| Bad environment variable | Fix the value, redeploy. Remember `import.meta.env` readers are frozen at build time. |
| One route, one bug | Fix forward. One commit, one deploy, verified per DEPLOYMENT.md section 6. |
| Cannot tell yet | Keep gathering. Do **not** deploy speculatively — each attempt costs a deploy from 100/day and changes the thing you are measuring. |

**Change one thing at a time.** With no alerting and no automated rollback, two simultaneous changes
mean you cannot attribute the recovery, and you learn nothing.

---

## 7. Before you close it

Record, in the incident note you started in section 0:

1. Start time, detection time, resolution time.
2. The failing URL and its HTTP status.
3. What `/api/health` said, verbatim — including `release.commit`.
4. Root cause, and which signature in section 4 it matched (or that it matched none — add it).
5. Whether any DDL ran that a rollback did not undo.
6. Whether any environment variable was changed.

Then check `/admin/ops` once more, twenty minutes later. An incident that stops producing new rows
in the grouped error panel is resolved; one that does not is still running and you have stopped
looking.

---

## Not yet in place

- **No external uptime monitor.** `/api/health` and `HEAD /api/health` exist and return 503 on a
  database outage, but **nothing polls them**. Every incident on this system is currently detected
  by a human noticing, or by a user reporting it.
  *To fix:* point any external monitor at `HEAD https://edurankai.in/api/health` on a 1-minute
  interval, alerting on non-200. The endpoint was built for exactly this and costs two SQL
  statements per poll.
- **No alerting channel.** No pager, no on-call rotation, no chat webhook. Nothing tells anyone that
  something broke.
  *To fix:* extend `src/lib/notify.ts` / `src/lib/push.ts` — the existing notifiers. A second
  alerting path is a defect, not a feature.
- **No error-rate alarm.** `errorRate()` computes 1h / 24h / 7d volumes, but only when a human loads
  `/admin/ops`. A spike at 3am is invisible until someone opens the page.
- **No query instrumentation.** `pg_stat_statements` is not installed, so the slow-query panel is
  empty because the data does not exist, not because everything is fast. It says so.
- **No status page.** There is no way to tell users the site is down, and no record afterwards of
  when it was.
- **Most crons are not instrumented.** `recordCronRun()` exists and is adopted by very few routes;
  two crons are observable only through side-tables (`mail_config.imap_last_run`,
  `hei_miner_state.last_run_at`). A cron reporting `never` is usually uninstrumented, not dead —
  which means a genuinely dead cron looks identical to a healthy one.
