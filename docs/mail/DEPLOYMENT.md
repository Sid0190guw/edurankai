# DEPLOYMENT

How to bring this up on a clean machine, and how the three modes in the brief map to real commands.

---

## 1. The three modes

| | Application | Database | Mail |
| --- | --- | --- | --- |
| **A — Development** | Docker (`docker/compose.yml`) or `npm run dev` | Supabase (default) or local Postgres | sink; optionally the real MTA |
| **B — Initial deployment** | Vercel | Supabase | ZBook: Postfix + Dovecot + Rspamd + bridge + worker |
| **C — Future** | Vercel or self-hosted (same build) | self-hosted Postgres | MTA cluster |

**The application does not change between them.** `astro.config.mjs` already switches adapter on
`VERCEL`: the Vercel adapter when `VERCEL=1`, `node({ mode: 'standalone' })` otherwise. Same source,
same `npm run build`, no fork and no build flag. That switch is why MODE C is a deployment change
rather than a rewrite, and it existed before this patch — it was not added for it.

---

## 2. Clean machine, first run

Prerequisites: Docker Desktop (or engine + compose v2), Node 22+, git.

```bash
git clone https://github.com/Sid0190guw/edurankai.git
cd edurankai
npm ci

cp .env.example .env.local
```

Fill in `.env.local`. The four that block everything else:

```bash
DATABASE_URL=...            # Supabase transaction pooler, port 6543
SESSION_SECRET=...          # openssl rand -hex 32
CRON_SECRET=...             # openssl rand -hex 32 — NO surrounding whitespace, see section 7
MAIL_WEBHOOK_SECRET=...     # openssl rand -hex 32
```

Then:

```bash
node scripts/mail-env-check.mjs --file .env.local   # names and booleans only, never a value
./scripts/start-mail.sh                             # checks preconditions BEFORE starting anything
./scripts/test-mail.sh                              # a green run here is the acceptance gate
```

`start-mail.sh` polls `http://localhost:9100/ready` and does not report success until the stack
answers. "docker compose up finished" means containers were created, not that anything works.

### Expect the first run to be a bring-up, not a restart

**The compose stack has never been executed.** These files were written on a machine with no Docker
installed — `docker: command not found`. What *is* verified is listed in TESTING.md section 1: the
SMTP server, the sink, the inbound bridge, signature parity, backup and restore round-trip, and the
load generator, all exercised for real. What is **not** verified is the compose files themselves,
the Postfix and Dovecot configuration, and the Prometheus and Grafana wiring.

So bring it up in layers, and stop at the first thing that does not answer:

```bash
./scripts/start-mail.sh                      # 1. app + worker + bridge + sink   (all-Node, verified)
./scripts/status-mail.sh                     # 2. does each component answer?
./scripts/start-mail.sh --observability      # 3. Prometheus + Grafana
./scripts/start-mail.sh --mail               # 4. the real MTA — the big unknown
./scripts/test-mail.sh --all                 # 5. everything
```

---

## 3. Which database, and why the default is Supabase

`LOCAL_DB_MODE=supabase` (the default) points local development at the same Supabase project the
deployed app uses.

That looks wrong and is deliberate. **This project has no migration runner.** The schema is created
by roughly 343 `CREATE TABLE IF NOT EXISTS` statements that self-bootstrap from inside application
modules on first use, and no file in this repository reconstructs the live schema — only a dump
does. A local Postgres therefore holds whatever subset of tables the code paths you happened to
exercise have created, with none of the enum values added by hand over two years and none of the
columns added by a one-off `.dev-scripts` migration.

Use `--localdb` when you are offline, running the destructive parts of the DR drill, or load-testing
writes. Get a faithful local schema by putting a dump in `docker/postgres/initdb/` — it runs once,
on an empty data directory.

---

## 4. Vercel

The deployed app needs, at minimum:

```
DATABASE_URL  SESSION_SECRET  SESSION_COOKIE_NAME  CRON_SECRET
MAIL_DOMAIN  EMAIL_FROM
MAIL_INBOUND_SECRET  and/or  MAIL_WEBHOOK_SECRET
METRICS_TOKEN                 (>= 32 characters, see section 7)
MAIL_ALLOWED_ORIGINS          https://www.edurankai.in,https://edurankai.in
```

SMTP credentials normally come from the `mail_config` row edited at `/admin/mail/settings`, which
**overrides** the environment. If mail is not sending, check that screen before checking Vercel.

**Deploy budget: 100 per day on the free tier.** If "Resource is limited" appears, stop and tell the
user rather than retrying — retrying spends the rest of the budget.

---

## 5. Connecting Vercel to the ZBook

The mail service is on a laptop behind a domestic connection. Vercel cannot reach an RFC1918
address, so one of:

1. **A tunnel** (Cloudflare Tunnel, Tailscale Funnel). Simplest; no port forwarding, no static IP,
   and TLS is handled for you. This is the recommended MODE B answer.
2. **A public hostname with port forwarding.** Requires a static IP or dynamic DNS, and **reverse
   DNS that matches `MAIL_HOST`** — without it large receivers reject your mail regardless of SPF
   and DKIM.

Either way `MAIL_SERVICE_URL` must be the public URL and `MAIL_SERVICE_KEY` must match on both
sides. Every call is signed over method, path, body hash and expiry
(`src/lib/mailops/service-auth.ts`), so a captured request cannot be replayed or repointed.

**Port 25 is blocked by most consumer ISPs, in both directions.** Check before concluding the stack
is broken. If it is blocked, inbound mail cannot arrive at the ZBook at all and MODE B needs a relay
in front of it.

---

## 6. DNS, before real mail works

Four records. Getting one wrong is the difference between delivery and the spam folder.

| Record | Value | If it is wrong |
| --- | --- | --- |
| **MX** | `10 mail.edurankai.in` | No inbound mail arrives at all. |
| **A + PTR** | `mail.edurankai.in` -> your IP, and the reverse **must** resolve back | Large receivers reject outright. The PTR is set by whoever owns the IP, not in your DNS. |
| **SPF** | `v=spf1 include:... ip4:YOUR.IP ~all` | Mail is marked as spoofed. **One SPF record only** — two means SPF fails entirely. |
| **DKIM** | `<selector>._domainkey` TXT, from the key Rspamd generated | See below. |
| **DMARC** | `_dmarc` TXT, start at `p=none` | At `p=quarantine` with broken SPF/DKIM, your own policy spam-folders your own mail. |

**The DKIM trap, which has already happened here:** publishing the DNS record without a matching
private key makes *every* signature fail, while the presence of the record makes the setup look
configured. Check the pair actually matches:

```bash
./scripts/test-mail.sh --dns
docker compose exec mta cat /tmp/docker-mailserver/rspamd/dkim/<selector>.public.key
```

Order of operations: set `_dmarc` to `p=none` **first**, get SPF and DKIM passing, verify with a real
message to an external address ("Show original" → all three pass), and only then raise DMARC.

---

## 7. Two settings that fail in ways that do not name themselves

- **`CRON_SECRET` with surrounding whitespace rejects every Vercel deploy in about two seconds**,
  with an error that does not mention the variable. `mail-env-check.mjs` treats this as an error and
  `mail-worker` refuses to start rather than 403-looping.
- **`METRICS_TOKEN` shorter than 32 characters disables token auth entirely.** `/api/metrics` treats
  a short or absent token as "this door does not exist" and answers 403 — which looks like a wrong
  token rather than a short one. Prometheus's `app` job then shows as failing on the Targets page.

---

## 8. CI, and what actually gates a deploy

`.github/workflows/ci.yml` runs lint, the type-check ratchet, unit tests, the build, security checks
and the no-database integration smoke, then a single `gate` job that fails if any of them failed —
and treats a **skipped or cancelled** job as not-a-pass.

**It does not block deployment on its own.** Vercel deploys from its own GitHub integration. Two
ways to make the gate real, both requiring a decision:

1. **Branch protection** (recommended): require the `gate` check before merging to `main`. Protects
   the branch rather than the deploy, and costs nothing.
2. **Vercel Ignored Build Step**: point it at `scripts/vercel-ignore-build.sh` and give Vercel a
   `GH_TOKEN`. That script fails *towards deploying* — a missing token or an unreachable GitHub
   builds anyway, because a gate that blocks during a GitHub outage is worse than the problem.

Neither is enabled by this patch.

---

## 9. Updating a running stack

```bash
git pull
./scripts/backup.sh                    # before, not after
./scripts/start-mail.sh --build        # rebuilds the app image
./scripts/status-mail.sh
./scripts/test-mail.sh
```

`docker compose up -d` recreates only what changed. The MTA holds mail in its own queue across a
restart; the ingest bridge answers 451 while the app is down, so the upstream server keeps
retrying — an app redeploy is invisible to a sender rather than a bounce.
