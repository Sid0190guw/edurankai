# DEPLOYMENT

How a deploy actually happens on EduRankAI. Written to be executed by someone who did not build the
system. Every command below is real and runnable against this stack.

Repository: `https://github.com/Sid0190guw/edurankai.git`
Production branch: `main`
Host: Vercel (Hobby tier), serverless functions
Database: Supabase Postgres, transaction pooler on port 6543
Site: `https://edurankai.in`

---

## 1. The mechanic, in one paragraph

There is no deploy script, no CI pipeline, and no release job. Vercel watches `main` on the GitHub
repo. A commit landing on `main` triggers a build on Vercel; the build runs `astro build`, which
emits a server bundle that Vercel turns into serverless functions. Nothing else is involved. A push
to any other branch produces a *preview* deployment, not production.

This working copy is a git **worktree**. Check where you are before you push anything:

```bash
cd /c/Users/user/Projects/edurankai-phase36
git rev-parse --abbrev-ref HEAD          # which branch this worktree is on
git worktree list                        # every checkout sharing this repo
```

The worktree `edurankai-phase36` is on `phase3-6/implementation`. **Nothing on this branch is live.**
Work here ships only when it reaches `main`.

---

## 2. Pre-flight gate (run before every push to main)

Run both. Neither is optional, and neither is run for you by any automation.

```bash
cd /c/Users/user/Projects/edurankai-phase36

# 1. Type gate. This project has a KNOWN, NON-ZERO baseline of pre-existing errors.
npx astro check --minimumSeverity error
#   -> ends with "Result (N files):  - 193 errors"   (baseline 194; anything at or below is the
#      pre-existing debt. A HIGHER number than the baseline is yours — fix it before pushing.)

# 2. Build gate. Must reach BOTH of these lines:
npm run build
#   -> "prerendering static routes"
#   -> "Complete!"
#   A build that stops earlier did not produce a deployable bundle, no matter what else it printed.
```

`npm run build` is `astro build`. The adapter is chosen at build time by an environment variable:

```
astro.config.mjs:  const isVercel = process.env.VERCEL === '1';
                   adapter: isVercel ? vercel() : node({ mode: 'standalone' })
```

Locally you build the **node standalone** adapter; Vercel builds the **serverless** adapter. A build
passing locally is good evidence, not proof, that Vercel's build will pass.

There is no `npm test`. The repository contains 62 `*.test.ts` files, and each one is run by hand:

```bash
npx tsx src/lib/security-audit.test.ts
npx tsx src/lib/observability-health.test.ts
```

Nothing runs them on push. See "Not yet in place".

---

## 3. Deploying

```bash
cd /c/Users/user/Projects/edurankai-phase36

# What is about to ship, and nothing more:
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD

# Ship it (from a branch that is meant to be main; usually via a merge or PR):
git push origin main
```

Then go to section 6. **Do not stop at the push line.** This project has repeatedly confused
"pushed" with "live", and the push output tells you only that bytes left the machine.

---

## 4. Environment variables

### 4.1 The build-time / runtime rule, and why it bites

Two ways this codebase reads configuration, and they behave completely differently:

| How it is read | When the value is resolved | Effect of changing it in the Vercel dashboard |
| --- | --- | --- |
| `process.env.X` | At invocation, on every request | Takes effect on the next cold start. No rebuild needed. |
| `import.meta.env.X` | At **build time** — Vite substitutes a literal into the bundle | **No effect until you redeploy.** The old value is frozen into the shipped code. |

This is not theoretical. After a build, the literal string `import.meta.env` does not appear anywhere
in `dist/` — every occurrence has already been replaced. You can confirm it yourself:

```bash
cd /c/Users/user/Projects/edurankai-phase36
grep -rl "import\.meta\.env" dist/ | wc -l      # -> 0
grep -rl "process\.env\.CRON_SECRET" dist/ | wc -l   # -> 13 (still read at runtime)
```

**The operational rule: after changing ANY environment variable on Vercel, redeploy.** Waiting does
not work for the build-time readers, and you cannot tell by looking at the site which kind a given
value is.

These call sites read `import.meta.env` with **no `process.env` fallback**, so they are build-time
only. If the variable was absent from the build environment, the shipped code has `undefined` baked
in and setting it afterwards changes nothing until a rebuild:

| File | Variable |
| --- | --- |
| `src/pages/api/payments/tool-pass/order.ts` | `RAZORPAY_KEY_ID`, `PUBLIC_RAZORPAY_KEY_ID` |
| `src/pages/api/payments/tool-pass/verify.ts` | `RAZORPAY_KEY_SECRET` |
| `src/layouts/BaseLayout.astro` | `PUBLIC_GA_ID` |
| `src/pages/admin/notifications.astro` | `VAPID_PUBLIC_KEY` |
| `src/pages/admin/profile.astro` | `VAPID_PUBLIC_KEY` |
| `src/pages/portal/applications/[id].astro` | `VAPID_PUBLIC_KEY` |

Everything else either uses `process.env` directly or writes `import.meta.env.X || process.env.X`,
which reads the frozen build value first and falls back to the live one.

### 4.2 Every variable the app reads

Read from source, not from any `.env` file. Nothing in this document requires opening `.env*`, and
nothing should.

To regenerate this list after the code changes:

```bash
cd /c/Users/user/Projects/edurankai-phase36
grep -rhoE "(import\.meta\.env|process\.env)\.[A-Z_][A-Z0-9_]*" src/ astro.config.mjs scripts/ \
  | sed -E 's/.*\.//' | sort | uniq -c | sort -rn
```

#### Required — the site does not work without these

| Variable | Read at | Read in | What breaks if missing |
| --- | --- | --- | --- |
| `DATABASE_URL` | runtime | `src/lib/db/index.ts:13` (+71 other sites) | **Total outage.** The module throws `DATABASE_URL is not set` at import. `src/middleware.ts` imports it, so every route — public pages included — returns 500 before any handler runs. |
| `CRON_SECRET` | runtime | 14 sites (`src/pages/api/cron/*`, `api/jobs/run.ts`, `api/aquintutor/*`) | Scheduled jobs stop, **and three cron routes fail OPEN.** See 4.4. |

#### Silently degrading — nothing visibly breaks, which is the danger

These have hardcoded fallback strings **committed to this repository**. Missing them does not throw;
it downgrades the secret to a value anyone with repo access already knows.

| Variable | Fallback chain | Consequence of leaving it unset |
| --- | --- | --- |
| `SESSION_SECRET` | base of four chains below | The four values below all fall through to public literals. |
| `CREDENTIAL_SIGNING_SECRET` | `-> SESSION_SECRET -> 'edurankai-credential-signing-v1'` (`src/lib/credential.ts:10`) | Issued credentials are signed with a public constant. Forgeable. |
| `CALENDAR_TOKEN_SECRET` | `-> SESSION_SECRET -> 'edurankai-calendar-v1'` (`src/lib/calendar.ts:8`) | Anyone can mint a calendar-feed token for any user. |
| `API_EMBED_SECRET` | `-> SESSION_SECRET -> 'edurankai-embed-secret-v1'` (`src/lib/api-keys.ts:32`) | Embed signatures forgeable. |
| `ACTIVITY_ENC_KEY` | `-> SESSION_SECRET -> 'edurankai-activity-dev-key-v1'` (`src/lib/activity-log.ts:47`) | Activity rows encrypted at rest with a public key. **Changing this later makes existing rows undecryptable** — see ROLLBACK.md. |
| `AUTH_SECRET` | `-> SESSION_SECRET -> 'edurankai-default'` (`src/pages/api/auth/verify-by-questions.ts:195,208`) | Recovery-verification tokens signed with a public constant. |
| `OFFER_INTEGRITY_SECRET` | `-> 'dev-fallback-change-in-prod'` (`src/pages/admin/applications/[id]/offer-letter.astro:35`) | Offer-letter integrity codes forgeable. **Build-time-read**, so a redeploy is required after setting it. |

`src/lib/observability.ts:59` reports whether the credential secret is set at all — that is the one
place in the UI that will tell you.

#### Feature-scoped — the feature stops, the site stays up

| Variable | Read in | What stops working |
| --- | --- | --- |
| `SESSION_COOKIE_NAME` | `src/lib/auth/cookie.ts:28` | Optional. A value with whitespace is `.trim()`ed; a value with illegal characters logs `[auth/cookie] SESSION_COOKIE_NAME is not a valid cookie name` and falls back to `edurankai_session` rather than taking login down. **Changing the value signs every user out** (the cookie has a different name). |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | `src/lib/hr-wallet.ts:314`, `api/payments/*` | All paid flows. `/admin/diagnostics` shows LIVE vs TEST by inspecting the `rzp_live_` / `rzp_test_` prefix. |
| `RAZORPAY_WEBHOOK_SECRET` | payment webhook verification | Webhooks rejected; payments confirm only via the reconcile cron. |
| `RAZORPAYX_ACCOUNT_NUMBER` | `src/lib/hr-wallet.ts:314` | Payouts. `/admin/hr/wallet` shows it as not ready. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | `src/lib/push.ts:14-16` | Web push. Public key is **build-time** on three pages (4.1). |
| `BLOB_READ_WRITE_TOKEN` | `src/lib/storage.ts:33` | Object storage falls back to an **in-memory dev store** — uploads appear to succeed and vanish on the next invocation. `storageBackend()` returns `'memory'`. |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (+ `S3_REGION`, `S3_PUBLIC_BASE_URL`) | `src/lib/storage.ts:87-92` | The self-hostable storage backend. When all four core values are set, S3 is preferred over Vercel Blob with no code change. |
| `ANTHROPIC_API_KEY` | `src/lib/llm.ts:31`, `src/lib/llm/gateway.ts:212` | AI tutor / doubt answering. Optional connector: a DB-configured gateway key takes precedence. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `SMTP_INSECURE` | `src/lib/mail.ts:300` | Outbound mail env fallback. Primary config lives in the `mail_config` table, edited at `/admin/mail/settings`. |
| `RESEND_API_KEY` | `src/lib/mail.ts:301` | Optional third-party mail connector. The house rule is own-SMTP; leaving it unset is the normal state. |
| `EMAIL_FROM`, `MAIL_DOMAIN` | `src/lib/mail.ts:6` | `MAIL_DOMAIN` defaults to `edurankai.in` and is used to compose every user mailbox address. |
| `MAIL_INBOUND_SECRET` | `src/lib/mail.ts` | Inbound mail webhook authentication. |
| `DATA_ENCRYPTION_KEY_<keyId>` | `src/lib/crypto/keys.ts:6` | Encryption at rest. `getKeyMaterial` **throws** if unset or not 32 base64-decoded bytes. |
| `ACTIVE_DATA_KEY_ID` | `src/lib/crypto/keys.ts:16` | Which key new ciphertext is written under. Defaults to `k1`. |
| `CERT_PUBLIC_KEY_PEM` / `CERT_PRIVATE_KEY_PEM` | `src/lib/certificates.ts:62` | Certificate signing. Falls back to DB-held keys. |
| `PROCTORING_PROVIDER` / `PROCTORING_VENDOR_BASE_URL` / `PROCTORING_WEBHOOK_SECRET` | `src/lib/proctoring.ts:10` | External proctoring connector. Detection is advisory-only either way. |
| `FOUNDER_EMAIL` | `src/lib/legal-hold.ts` | Legal-hold access identity. |
| `WALLET_BASE_CURRENCY` | `src/lib/local-currency.ts:77` | Defaults to `CHF`. |
| `PUBLIC_GA_ID` | `src/layouts/BaseLayout.astro:37` | Analytics tag. **Build-time.** |
| `KV_REST_API_URL` | `src/lib/vsm/kv.ts` | Optional KV connector. `@vercel/kv` is marked external in `astro.config.mjs` so the build does not require it to be installed. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_NAME` / `SEED_ADMIN_PASSWORD` | `scripts/seed.ts:11` | Seed script only. Never read by the running site. |

`VERCEL`, `VERCEL_ENV`, `VERCEL_REGION`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`,
`VERCEL_GIT_COMMIT_MESSAGE` and `VERCEL_DEPLOYMENT_ID` are injected by the platform. Do not set them
by hand. `src/lib/observability-health.ts` reads them to report which commit is serving.

### 4.3 Where to change them

```
Vercel dashboard -> Project -> Settings -> Environment Variables
```

Set Production, Preview and Development explicitly. A variable set only for Production will be
missing from preview builds, and a preview that "works differently" is almost always this.

Verify presence without reading any secret value — `/admin/diagnostics` renders a boolean per
variable, and `/admin/mail/health` does the same for `CRON_SECRET`.

### 4.4 The CRON_SECRET trap

Three separate failure modes on one variable. All three have happened.

**(a) Whitespace rejects the whole deploy in about two seconds.** A value pasted with a trailing
space or newline makes Vercel reject the deployment almost immediately — far faster than a real
build failure. If a deploy fails in ~2s, do not read the build log looking for a compile error;
there is no build. Re-enter the variable, removing every space and newline, then redeploy.

**(b) It must match the GitHub repository secret, exactly.** Two scheduled workflows call back into
the site with it:

```
.github/workflows/imap-poll.yml        every 10 minutes    -> GET /api/mail/imap-poll
.github/workflows/task-reminders.yml   hourly at :07       -> GET /api/hiring/task-reminders
```

Both read `secrets.CRON_SECRET` and `secrets.SITE_ORIGIN`, set at
`GitHub -> repo -> Settings -> Secrets and variables -> Actions`. `SITE_ORIGIN` should be
`https://edurankai.in`. A mismatch shows up in the Actions log as:

```
::error::Auth rejected. The CRON_SECRET in this repo doesn't match the CRON_SECRET on Vercel.
```

Fix by generating one value and pasting the identical string into both places, then redeploying
Vercel.

**(c) An empty or unset value opens routes, it does not close them.** Three cron handlers admit
every caller when the secret is absent:

```
src/pages/api/cron/activity-digest.ts   function authed()   if (!secret) return true;
src/pages/api/cron/security-scan.ts     if (secret && ...)  -> short-circuits to "allowed"
src/pages/api/cron/hei-refresh.ts       if (secret) { ... } -> guard skipped entirely
```

Two others fail closed correctly (`api/aquintutor/league-settle.ts`,
`api/aquintutor/streak-nudge.ts`, both `if (!secret) return false`). There is no structural gate in
front of `/api/`, so with `CRON_SECRET` unset those three URLs are public — and
`/api/cron/security-scan` returns its findings to whoever asked. Treat "CRON_SECRET is set in
production" as a security control, not a convenience.

---

## 5. Hobby-tier limits that shape everything

| Limit | Value | What it means here |
| --- | --- | --- |
| Deployments | **100 per day** | If Vercel says `Resource is limited`, **stop**. Do not retry — retries consume the same budget. Wait for the window to reset and tell the founder. Every `git revert` + push is another deploy against this number. |
| Cron frequency | **Daily only** | A sub-daily `schedule` in `vercel.json` fails the deploy. The 8 configured crons are all daily except `/api/aquintutor/league-settle`, which is weekly (`0 1 * * 1`) — less frequent is fine. There is **no count limit**: 8 crons deploy fine. |
| Sub-daily work | Not available on Vercel | Done by GitHub Actions instead (see 4.4b). That is the established escape hatch; do not try to make Vercel do it. |
| Function duration | 10s default | `src/pages/api/cron/hei-refresh.ts` budgets 8s deliberately. Raising `maxDuration` globally in `astro.config.mjs` above the plan ceiling makes **every** deploy fail. `src/pages/admin/roles/index.astro:7` sets `maxDuration = 60` per-route. |

The configured crons, mirrored in `src/lib/observability-health.ts` as `CONFIGURED_CRONS`:

| Path | Schedule (UTC) |
| --- | --- |
| `/api/mail/imap-poll` | `0 9 * * *` |
| `/api/mail/scheduled-send` | `0 7 * * *` |
| `/api/payments/reconcile` | `20 5 * * *` |
| `/api/aquintutor/streak-nudge` | `30 14 * * *` |
| `/api/aquintutor/league-settle` | `0 1 * * 1` |
| `/api/hiring/draft-reminders` | `45 4 * * *` |
| `/api/cron/hei-refresh` | `0 3 * * *` |
| `/api/cron/activity-digest` | `0 13 * * *` |

If you add a cron to `vercel.json`, add it to `CONFIGURED_CRONS` too — a test asserts the two match,
so that a scheduled job cannot exist unmonitored.

**Two routes that look scheduled and are not:** `/api/jobs/run` (the background job worker) and
`/api/cron/security-scan` appear in no cron list and in no workflow. See MONITORING.md.

---

## 6. Verifying that a deploy actually shipped

`git push` proves bytes reached GitHub. It proves nothing about Vercel, and this project has been
burned by the difference more than once. Work down this list; stop at the first step that gives you
a commit SHA matching what you pushed.

**Step 1 — is the commit on the production branch at all?**

```bash
cd /c/Users/user/Projects/edurankai-phase36
git fetch origin
git rev-parse HEAD                       # what you built and tested
git rev-parse origin/main                # what Vercel will build
git log --oneline origin/main..HEAD      # empty output = nothing unpushed
```

If `git log origin/main..HEAD` prints anything, your change is **not** live and no further checking
is needed. This alone explains most "still broken" reports on this project.

**Step 2 — did Vercel build it, and is that build serving production?**

```bash
vercel whoami                            # confirms the CLI is pointed at the right account
vercel ls                                # deployments, newest first, with state and age
vercel inspect <deployment-url>          # target, state, commit SHA, build time
```

Read `vercel inspect` output for `● Ready` and for the git SHA. A deployment in `Building`,
`Queued`, `Error` or `Canceled` is not serving anything. A `Ready` deployment whose target is
`Preview` is not production either.

**Step 3 — ask the running site which commit it is.**

`src/lib/observability-health.ts` exposes `deployMarker()`, built from `VERCEL_GIT_COMMIT_SHA`, and
reports `known: false` rather than guessing when the variable is absent. The intended surface is:

```bash
curl -s https://edurankai.in/api/health | head -c 400
#   -> {"status":"ok", ... "release":{"shortCommit":"e27c6a4","ref":"main","environment":"production", ...}}
```

`release.shortCommit` must equal the first 7 characters of the SHA from step 1.

`/api/health` is unauthenticated by design and deliberately thin — reachability, latency, module
names and the serving commit. It runs exactly two SQL statements, no DDL and no writes, so it is safe
to poll. It returns **503** when the database is unreachable, which is the only way an external
monitor can see an outage. `HEAD /api/health` returns the status code with no body.

`/api/health/deep` reports the same plus configuration-disclosing signals (mail host, pool
internals, queue, cron history). It is gated on `administer` on the platform and fails closed: 401
unauthenticated, 403 without the capability. It is **not** the endpoint to poll.

> **Confirm the route exists on the deployment you are testing.** These routes are recent
> (`src/pages/api/health.ts`, `src/pages/api/health/deep.ts`, `src/pages/admin/ops/index.astro`) and
> a deployment built from an older commit will not have them:
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' https://edurankai.in/api/health
> ```
> A 404 means the route has not shipped to that deployment; use step 4 instead.

**Step 4 — the check that works with no health route at all.**

```bash
# Is the origin serving, and which Vercel edge/deployment answered?
curl -sI https://edurankai.in/ | grep -Ei "^(HTTP|x-vercel-id|age|server)"

# Then confirm the CHANGE, not the deploy: request a URL that only the new code can answer.
curl -s -o /dev/null -w '%{http_code}\n' https://edurankai.in/<new-route-you-just-added>
```

A 404 on a route you just added means the deploy is not live. A 200 means it is. This is the only
step that survives every other surface being unavailable.

**Step 5 — read the logs before forming a theory.**

```bash
vercel inspect <deployment-url> --logs    # build + runtime logs for that specific deployment
vercel logs <deployment-url>              # runtime log stream
```

Project history: reading `vercel inspect --logs` BEFORE diagnosing has repeatedly turned a
multi-hour guess into a two-minute fix. Do it first, not after.

---

## 7. Post-deploy smoke check

Two minutes, signed in as an admin:

| Surface | Confirms |
| --- | --- |
| `https://edurankai.in/` | The site renders at all; the database is reachable from the edge. |
| `/api/health` | `status: "ok"` and `release.commit` equal to the SHA you pushed. The single fastest confirmation. |
| `/admin/ops` | The incident board. A HEALTHY banner means the database answers, no job failed, no schedule is overdue, and nothing has been logged in the last hour. |
| `/admin/login` then `/admin` | Sessions issue and validate. If login throws, suspect `SESSION_COOKIE_NAME`. |
| `/admin/diagnostics` | Env booleans, table presence, row counts, Razorpay LIVE vs TEST. |
| `/admin/hardening` | Queue health and the last 40 redacted errors from `edu_error_log`. |
| `/admin/infra` | Database size against the 500 MB Supabase free-tier ceiling, largest tables, blob usage. |
| `/admin/mail/health` | Whether `CRON_SECRET` is present on the deployment, and whether mail is flowing. |
| GitHub -> Actions tab | The next `imap-poll` run is green **and its log has no `::error::`** (see MONITORING.md — these workflows are `continue-on-error: true`). |

---

## Not yet in place

Stated plainly so nobody assumes protection that does not exist.

- **No CI.** The only GitHub Actions workflows are the two cron pingers. Nothing runs
  `astro check`, `npm run build`, or any of the 62 `*.test.ts` files on push or on pull request.
  The type and build gates in section 2 are enforced by a human remembering to run them.
  *To fix:* one workflow on `pull_request` and `push: main` running `npx astro check
  --minimumSeverity error` and `npm run build`, failing the job on a check count above the baseline.
- **No staging environment.** Vercel preview deployments exist per-branch, but they point at the
  **same** `DATABASE_URL` unless one is set per-environment. Assume a preview writes to production
  data until you have verified otherwise.
  *To fix:* a separate Supabase project and a Preview-scoped `DATABASE_URL`.
- **No deploy notification.** Nothing announces a deploy, a failed build, or a rollback to anyone.
  *To fix:* a Vercel deploy webhook into the existing notifier (`src/lib/notify.ts` /
  `src/lib/push.ts`) — extend those, do not add a second alerting path.
- **No release log on boot.** `recordRelease()` writes the serving commit to `edu_releases`, but it
  is called only from `/admin/ops` and `/api/health/deep` — both of which require an operator to
  visit. A deploy nobody looks at leaves no trace in the database, so "which commits have ever
  served production" is reliably answerable only from `vercel ls`.
  *To fix:* deliberately not called from `/api/health`, because that endpoint is polled and a write
  per poll is a cost the monitor should not impose. A once-per-cold-start call elsewhere would close
  the gap.
- **The fail-open cron guards in 4.4(c) are unresolved.** They are documented, not fixed, because
  fixing them blind either closes a real hole or silently breaks a daily job depending on whether
  `CRON_SECRET` is actually set in production. That is a one-word change once a human confirms the
  deployed environment.
