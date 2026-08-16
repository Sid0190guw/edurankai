# ENVIRONMENT

The reference is [`.env.example`](../../.env.example) — every variable, with what it does and what
breaks without it. This document is the rules around it.

---

## 1. Three tiers, and why the distinction is in the file

```
[live]    read by code in src/ today. Removing it changes behaviour now.
[stack]   read by the Docker mail stack, not by the Astro app.
[future]  reserved by the design; nothing reads it yet.
```

Without this, a `.env.example` becomes a wish list: someone sets `QUEUE_DRIVER=redis`, restarts, and
nothing changes, because nothing reads it. Tagging it `[future]` costs one word and prevents an
afternoon.

Every `[live]` tag was verified by grepping `src/` and `scripts/` for `process.env.NAME`.

---

## 2. One validator, three callers

`src/lib/mailops/env.ts` holds the contract as **data**. It is evaluated by:

| Caller | When |
| --- | --- |
| `node scripts/mail-env-check.mjs` | a person, before starting anything |
| `GET /api/health/ready` | a deployment gate or orchestrator, continuously |
| `.github/workflows/ci.yml` | every commit |

A checklist in a README would not be a fourth caller — it would be a document that goes stale. A
rule added to `VAR_SPECS` is enforced in all three places at once.

```bash
node scripts/mail-env-check.mjs                    # this process's environment
node scripts/mail-env-check.mjs --file .env.local  # a file, WITHOUT loading it
node scripts/mail-env-check.mjs --quiet            # exit code only
```

**It never prints a value, and it never `source`s the file.** Parsing rather than sourcing matters:
`source .env` on a value containing `$(...)` executes it, and a validator that can be made to run
arbitrary code by the file it is validating is a worse problem than the one it solves. A unit test
asserts no value can escape the module.

---

## 3. The failure this exists to catch: the partial group

Some variables are all-or-nothing. Set four of the five `S3_*` and storage does not half-work — it
falls back to Vercel Blob, **silently**, and you find out months later when an attachment is in the
wrong bucket.

Groups currently enforced: `s3` (5), `smtp` (4), `dkim` (3), `mail-service` (2).

A partial group is reported in four places: `checkEnv` warnings, `/api/health/ready`,
`/api/health/mail` (storage `degraded`), and the `ConfigurationPartial` alert. Four, because a
silent fallback is expensive and cheap to miss.

**A group that is entirely absent is not a warning.** Not configuring S3 is a choice; configuring
80% of it is a bug.

---

## 4. Shape checks, each of which has cost an outage here

| Check | Why |
| --- | --- |
| `CRON_SECRET` has no surrounding whitespace | Whitespace rejects **every Vercel deploy** in ~2s, with an error that does not name the variable. Reported as an **error**. |
| `DATABASE_URL` uses `:6543`, not `:5432` | The direct Supabase port exhausts connections under Vercel concurrency. Warning. |
| `SMTP_PORT` and `SMTP_SECURE` agree | 587 is STARTTLS, 465 is implicit TLS. Mismatched gives "wrong version number", which reads as a certificate problem. Warning. |
| `SMTP_INSECURE` is not `true` | Accepts any TLS certificate. Fine against a local test MTA, never on a relay carrying real mail. Warning. |
| `METRICS_TOKEN` ≥ 32 characters | Shorter disables token auth entirely and `/api/metrics` answers 403 — looks like a wrong token, not a short one. |

---

## 5. Where secrets live

| | |
| --- | --- |
| **Local development** | `.env.local` — gitignored |
| **Production (app)** | Vercel environment variables |
| **Production (mail stack)** | `.env.local` on the ZBook, mode 0600 |
| **DKIM private key** | a **file**, mounted read-only at mode 0600. Never in a variable, never in git. |
| **Prometheus bearer token** | `docker/prometheus/metrics_token`, written by `start-mail.sh`, gitignored |

`.gitignore` ignores `.env.*` and then re-includes exactly one name:

```gitignore
!.env.example
```

The negation is last because in git the **last matching pattern wins**. Without it, the one file in
that family that must be committed — the contract a new engineer reads before they have any
secrets — is invisible. It was, until this patch; `git check-ignore` confirmed it.

### If a secret is committed

It is compromised, including after the commit is reverted — the object stays in the history and in
every clone and fork. **Rotate it.** Rewriting history is a second step, not the fix.

CI checks this two ways: `scripts/lint-mail.mjs` flags credential-shaped literals in source, and the
`lint` job fails if any `.env` file is tracked.

---

## 6. Generating secrets

```bash
openssl rand -hex 32        # CRON_SECRET, MAIL_WEBHOOK_SECRET, MAIL_SERVICE_KEY, METRICS_TOKEN
openssl rand -hex 32        # SESSION_SECRET — rotating this signs everyone out
```

32 hex characters is 128 bits. `METRICS_TOKEN` needs ≥32 **characters**, which `-hex 32` (64
characters) satisfies comfortably.

**Rotating an HMAC key is a two-step change, not one.** Both sides must accept the old and the new
key for one window, or every message in flight fails verification during the gap. `MAIL_JWT_TTL_SECONDS`
is the length of that window for service tokens.
