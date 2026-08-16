# EduRankAI Mail — infrastructure

Everything needed to run, test, monitor, back up and eventually move the mail system.
Written to be executed by an engineer who did not build it.

## Start here

```bash
cp .env.example .env.local     # every value is explained in that file
node scripts/mail-env-check.mjs --file .env.local
./scripts/start-mail.sh        # app + worker + inbound bridge + sink + health
./scripts/test-mail.sh         # prove it works
```

If you have five minutes and no Docker, this still runs and proves the mail path end to end:

```bash
node tests/ci-smoke.mjs
```

## Which document

| Situation | Open |
| --- | --- |
| Setting up a machine, or deploying. | [DEPLOYMENT.md](DEPLOYMENT.md) |
| A variable is missing, or you do not know what one does. | [`.env.example`](../../.env.example), then [ENVIRONMENT.md](ENVIRONMENT.md) |
| Writing or running tests; deciding whether to trust a green run. | [TESTING.md](TESTING.md) |
| Something is broken and you want to know what is watching. | [OBSERVABILITY.md](OBSERVABILITY.md) |
| It is backup day, or you need to restore. | [BACKUP.md](BACKUP.md) |
| Planning the move off Vercel / Supabase / one MTA. | [MIGRATION.md](MIGRATION.md) |
| Asking "will this hold at N per day". | [SCALING.md](SCALING.md) |
| Wondering how this fits with the other patches' work. | [INTEGRATION.md](INTEGRATION.md) |
| Checking whether the system does what was promised. | [ACCEPTANCE.md](ACCEPTANCE.md) |

The wider platform runbooks — incidents, rollback, the general deployment gate — are in
[`docs/ops/`](../ops/) and are not duplicated here.

## The shape of the system

```
  Browser
     |                                   HTTPS, session cookie
     v
  Vercel  (Astro, src/pages/api/**)      the ONLY thing the browser talks to
     |
     +---> Supabase Postgres             messages, mailboxes, queue (edu_jobs), events
     |
     +---> ZBook mail infrastructure     HMAC-signed, never exposed to the browser
              |
              +-- Postfix   MX, spam, DKIM signing, SPF/DKIM/DMARC verification
              +-- Dovecot   SASL for submission; IMAP for mailboxes held on this host
              +-- Rspamd    scoring and DKIM signing
              +-- mail-parser   SMTP in  -> signed raw MIME -> POST /api/mail/inbound
              +-- mail-worker   drains edu_jobs continuously instead of once a day
              +-- smtp-sink     captures outbound in testing; delivers nothing, ever
              +-- mailops       /health /ready /metrics for the whole stack
```

Four things about this diagram are load-bearing:

1. **The browser never reaches the mail service.** It is authenticated by HMAC over the method,
   path and body, and it can inject into any mailbox and relay to the internet. The app is its only
   client.
2. **The application decides what a message means.** `mail-parser` forwards raw MIME and the
   envelope; it does not parse, thread or route. There is one delivery implementation, in
   `src/lib/mail.ts`, and the route header there records what a second one cost.
3. **The worker adds no second queue.** It calls the same `/api/jobs/run` the Vercel cron calls.
   Claiming uses `FOR UPDATE SKIP LOCKED`, so running it alongside the cron is safe.
4. **The sink has no delivery path.** Not "is configured not to deliver" — there is no code in that
   process that opens an outbound connection. That is what makes a 100,000-message load test safe.

## What is genuinely not in place

Stated here so nobody has to discover it during an incident.

- **Docker has never been run against these files.** They were written and reviewed on a machine
  with no Docker installed. The Node services in them are verified (see TESTING.md section 1); the
  compose stack, Postfix and Dovecot configuration are **unverified** and the first run should be
  treated as a bring-up, not a restart. DEPLOYMENT.md section 2 is the bring-up order.
- **No alert reaches a human.** Prometheus evaluates the rules and shows them firing on its own
  page. There is no Alertmanager and no destination. OBSERVABILITY.md section 5.
- **Backups are not scheduled.** `./scripts/backup.sh` is run by a person. BACKUP.md section 5.
- **CI does not block deployment.** Vercel deploys from its own git integration. The gate is branch
  protection, which is a setting somebody has to turn on. DEPLOYMENT.md section 8.
- **The browser hop of the send path is untested.** There is no headless browser here.
  TESTING.md section 7.
