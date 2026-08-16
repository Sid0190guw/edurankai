# CROSS-PATCH INTEGRATION

Four agents built this mail system at the same time. This records what the infrastructure layer
found in the others' work, what it adapted to, and the two things that still need a decision.

**Nothing here was changed in another patch's files.** Where a conflict existed the infrastructure
side moved, and where a defect was found it is reported rather than edited — a concurrent edit to a
file another agent is mid-write on loses somebody's work.

Last reconciled: 2026-08-16.

---

## 1. Ownership, as observed

| Area | Owner | Surface |
| --- | --- | --- |
| Mail engine, adapters, campaigns, automation | mail-platform patch | `src/lib/mailplatform/**` |
| Public API | API patch | `src/pages/api/v1/**`, `src/lib/mailapi/**` |
| Screens and browser-facing routes | frontend patch | `src/components/mail/**`, `src/pages/admin/mail/**`, `src/pages/api/mail/**` |
| **Infrastructure** | **this patch** | `docker/**`, `scripts/*mail*`, `tests/**`, `.github/workflows/ci.yml`, `src/lib/mailops/**`, `src/pages/api/health/{ready,mail}.ts` |

The `mailops` namespace was chosen so nothing collides with `mailplatform`, `mailapi` or `mailgov`.

---

## 2. Conflicts found, and how they were resolved

### 2.1 `/api/metrics` — resolved by deleting ours

**What happened.** This patch wrote `src/pages/api/metrics.ts` and a formatter at
`src/lib/mailops/metrics.ts`. The mail-platform patch then shipped its own `/api/metrics`, backed by
a real registry (`src/lib/mailplatform/metrics.ts` + `instrument.ts`) with a measured-operation
catalogue, histograms and per-label cardinality control.

**Resolution.** Theirs is better and it is theirs. `src/lib/mailops/metrics.ts` was **deleted** and
its unit tests removed; `/api/metrics` is entirely the mail-platform patch's. Two metric systems in
one process would produce two answers to the same question.

**What moved on this side:** `docker/prometheus/alerts.yml` and the Grafana dashboard were rewritten
against their series names (`edurankai_mail_*`) instead of the `era_*` names originally used
app-side. The `era_*` namespace survives only for the ZBook services, which are separate processes
and do not overlap.

**A contract worth knowing, taken from their header:** their counters are **process-local** — on
serverless each instance has its own registry — while their `queue_*` gauges are read from Postgres
and are cluster-wide. Alert rules here use the gauges and treat the counters as ratios only. That
distinction is repeated in OBSERVABILITY.md section 2 because it is easy to get wrong.

### 2.2 `METRICS_TOKEN` must be ≥ 32 characters

Their endpoint treats a shorter or absent token as "this door does not exist" and answers 403 — a
deliberate fail-closed choice, and the right one. It is not obvious from a 403, so:

- `.env.example` states the minimum and the reason;
- `start-mail.sh` warns when the token is absent;
- the `AppMetricsUnscrapable` alert names the token as the usual cause;
- `tests/security/security.mjs` asserts a short token is refused.

No code was changed on either side.

### 2.3 Environment variable names differ from the brief

The Patch-4 brief asked for `SMTP_USERNAME` / `SMTP_PASSWORD`. The shipped code reads
`SMTP_USER` / `SMTP_PASS` (`src/lib/mail.ts`, `getMailConfig`).

**The code wins.** Renaming a variable the app reads is an outage, and adding an alias nothing reads
is worse than the deviation. `.env.example` documents the real names and the deviation inline.

Same reasoning for **JWT**: the brief asked for JWT configuration; sessions here are opaque tokens in
Postgres (`src/lib/auth/session.ts`), not JWTs. Adding one would be a second auth path to keep in
sync. `MAIL_JWT_*` is reserved for **service** tokens only and is marked `[future]`.

### 2.4 Inbound authentication — extended, not replaced

`/api/mail/inbound` authenticates with a bare shared secret in `x-mail-secret`. That proves the
caller once knew the secret; it does not prove the body is unaltered, and anything that saw one
valid request can replay it forever.

`src/lib/mailops/webhook.ts` adds HMAC over `timestamp . body` with a freshness window and
delivery-id replay detection — and **accepts either scheme**, reporting which one authenticated.
The route itself was not modified. An MTA already configured with the shared secret keeps working;
`/api/health/mail` reports when a sender is still on the weaker scheme, so it can be retired on
evidence.

---

## 3. A defect found in another patch's file, not fixed here

**`src/lib/mailplatform/api.ts:24`** — `CORS` exports `Access-Control-Allow-Origin: '*'`, and the
`json()` helper in the same file applies it to every response. Line 94 of that file tells callers
"Send a session cookie, or an API key in the x-api-key header", so at least some routes using this
helper accept **cookie** authentication.

**Severity: low today, and the linter says so.** Without `Access-Control-Allow-Credentials: true`,
browsers refuse to attach cookies to a `*` response, so it is not currently exploitable. It is
flagged as a **warning**, not an error, because overstating it is how a security check loses
credibility.

**Why it is worth fixing anyway:** adding `Allow-Credentials` later — a one-line change that looks
harmless — turns this into a cross-origin read of a signed-in user's session, and nobody adding that
line will think to re-check the origin. The fix is to keep `*` for the API-key surface and use
`src/lib/mailops/cors.ts` (exact-origin echo, `Vary: Origin`, no suffix matching) on any route that
accepts a cookie.

**Left to that patch's owner.** `node scripts/lint-mail.mjs` reports it on every run.

---

## 3a. Duplicated infrastructure — two sets exist, and one must be chosen

A second patch (the ops/continuity one, "Patch 8") built overlapping infrastructure concurrently.
Both sets work; keeping both means two things to maintain that will disagree within a month.
**Neither was deleted, because that is the owner's call, not an agent's.**

| Concern | This patch | The other | Suggested keep |
| --- | --- | --- | --- |
| Alert rules | `docker/prometheus/alerts.yml` | `ops/prometheus/mail-alerts.yml` | **Theirs** — richer, generated from a catalogue. Fold in this one's `era_*` stack rules, which theirs has no equivalent of. |
| Grafana dashboard | `docker/grafana/dashboards/mail-stack.json` | `ops/grafana/mail-overview.json` | **Both**, as two dashboards in one folder: theirs is the application view, this one is the ZBook stack view. They plot different namespaces. |
| Backup | `scripts/backup.sh` (mail data + config, interactive DB) | `scripts/mailops/db-backup.sh`, `mail-data-backup.sh` | **Theirs** for the database; **this one** for the mail-stack archive with its manifest and verify step. Or merge. |
| Health check | `scripts/status-mail.sh` + `docker/mailops/health.mjs` | `scripts/mailops/health-check.sh` | **This one** — it probes running containers with real connections. |
| Load test | `tests/load/loadtest.mjs` | `scripts/mail-loadtest.ts`, `scripts/mail-bench.ts` | **Both** — this one drives real SMTP into the sink; theirs benchmarks the application layer. |
| Migration docs | `docs/mail/MIGRATION.md`, `SCALING.md` | `docs/mail/MIGRATION-VERIFICATION.md`, `HA-DR.md`, `docs/mail-scaling.md` | Complementary; cross-link rather than merge. |

`src/lib/mailops/` is **shared**: this patch owns `env.ts`, `webhook.ts`, `cors.ts`,
`service-auth.ts`; the other owns `objectives.ts`, `backup.ts`, `dns-cutover.ts`, `drain.ts`,
`continuity-store.ts`, `failure-model.ts`, `migration.ts`, `runbooks.ts`. No filenames collide and
all 100 tests in that directory pass together.

### One file was overwritten, and it is not recoverable

**`docs/mail/MIGRATION.md` existed before this patch wrote it, and the write replaced it.** The file
was untracked, so there is no git object to recover — the previous content is gone. The current
content covers the six migrations the brief asked for and is consistent with the other patch's
`MIGRATION-VERIFICATION.md`, which was written afterwards and cross-references it. If the previous
version said something this one does not, its author should restore those sections; nothing else in
either patch was touched.

The lesson for concurrent work, recorded because it will happen again: **`docs/mail/` and
`src/lib/mailops/` are shared namespaces.** Check for an existing file before writing one.

---

## 4. Contracts this patch depends on

If any of these change, the infrastructure breaks. They are listed so a change is a decision rather
than a discovery.

| Contract | Depended on by | Breaks if changed |
| --- | --- | --- |
| `GET|POST /api/jobs/run?key=<CRON_SECRET>` returning `{ok, processed, done, failed, health}` | `docker/mailops/worker.mjs` | The queue stops draining; `era_worker_consecutive_errors` rises and the alert fires. |
| `POST /api/mail/inbound` accepting **raw MIME** with `x-mail-to` / `x-mail-from` headers | `docker/mailops/ingest.mjs` | All inbound mail is refused; the bridge answers 451 so nothing is lost, but nothing is delivered. |
| `GET /api/health` returning 503 when the database is unreachable | app healthcheck, `mailops` probe, uptime monitoring | Containers report healthy through an outage. |
| `queueHealth()` shape `{pending, processing, failed, done}` | `/api/health/mail` | Queue panel goes blank. |
| `edurankai_mail_queue_depth{status}` and `edurankai_mail_telemetry_readable` | alert rules, dashboard | Alerts stop firing silently — the worst failure mode for an alert. |
| `can(user, 'administer', {type:'platform'})` | `/api/health/mail` | Operator endpoints fail closed (deny). Safe direction. |
| `email_logs(status, created_at)` | `/api/health/mail` outbound component | That component reports `degraded` with the read error. |

The infrastructure never writes to `mail_messages`, `mail_box`, `edu_jobs` or any platform table. It
reads health and calls endpoints. That is deliberate: it means a schema change in another patch can
degrade a health panel but cannot corrupt data.

---

## 5. What another patch should do if it needs something here

- **A new environment variable:** add it to `.env.example` with its tier tag, and to `VAR_SPECS` in
  `src/lib/mailops/env.ts` if it has a rule worth enforcing (required, or part of an all-or-nothing
  group). Both are then checked by CI, `/api/health/ready` and `mail-env-check.mjs` at once.
- **A new health component:** add a probe to `docker/mailops/health.mjs` and its name to
  `MAILOPS_EXPECT` in the relevant compose profile. A component not in `MAILOPS_EXPECT` reports
  `not-configured` rather than failing, which is correct for something not deployed everywhere.
- **A new metric:** use the mail-platform registry (`src/lib/mailplatform/instrument.ts`), not a new
  one. Add a panel to `docker/grafana/dashboards/mail-stack.json` in the same commit — a metric
  nobody plots is a metric nobody reads.
- **A new signed webhook direction:** `src/lib/mailops/webhook.ts` for inbound,
  `src/lib/mailops/service-auth.ts` for app→service. Do not write a third HMAC scheme.

**If you change the wire format in `src/lib/mailops/webhook.ts`, change `docker/mailops/sign.mjs` in
the same commit.** They are two implementations of one format, split because the container has no
build step. `src/lib/mailops/signer-parity.test.ts` fails if they diverge — which is the only thing
standing between a signing change and "inbound mail stopped arriving", six weeks later, with a 401
that names no cause.
