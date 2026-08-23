# EduRankAI Mail — transport engine

SMTP in, SMTP out, and everything in between: a queue that survives a reboot, a retry engine that
does not stampede, bounce classification that decides which addresses to stop mailing, and a
structured event for every stage of every delivery.

This directory is **the mail transport layer only**. It does not touch the application's database,
it does not render any UI, and it holds no schema. It talks to the rest of EduRankAI over HTTP.

---

## What it does

```
  APPLICATION                    ENGINE                            THE INTERNET
                    ┌───────────────────────────────────┐
  POST /submit ───► │ validate → suppression → QUEUE    │
                    │                          ↓        │
                    │              claim ← delivery worker
                    │                          ↓        │
                    │            MX lookup → throttle → DKIM → SMTP ──►  Gmail / Outlook / …
                    │                          ↓        │
                    │        classify: 2xx done · 4xx retry · 5xx bounce
                    │                          ↓        │
  ◄── events ────── │ DeliveryEventPublisher (durable outbox)
                    └───────────────────────────────────┘

                    ┌───────────────────────────────────┐
  ◄── /api/mail/inbound ── spool ← recipient check ← spam ← parse ← Postfix ◄── MX ◄── the world
                    └───────────────────────────────────┘
```

**Outbound**: `POST /submit` → validated → checked against the suppression list → written to a
filesystem spool → claimed by the delivery worker → recipients grouped by destination domain →
per-domain concurrency and rate limits applied → MX resolved → DKIM signed → delivered → each
recipient's verdict classified → events published.

**Inbound**: Postfix receives on port 25, does TLS, asks Rspamd for a verdict, validates the
recipient, and hands the message either to Dovecot (a real mailbox, read back over IMAP) or straight
to the engine, which spools it and forwards it to the application's existing `/api/mail/inbound`.

**Bounces**: both kinds. A `550` during the conversation is classified immediately; a delivery report
that arrives an hour later is parsed (RFC 3464), and so is an abuse complaint (RFC 5965 / ARF).

---

## Start it

### Just the engine (no Docker, nothing sends)

Setup first. None of these block:

```bash
cp mail-engine/.env.example mail-engine/.env
node --import tsx mail-engine/src/cli.ts check        # what is and is not configured
node --import tsx mail-engine/src/cli.ts keygen edurankai.in
npx vitest run mail-engine/
```

Then start the engine. **This one does not return** — it is a daemon and it holds the terminal until
you stop it with Ctrl+C, so do not paste it in the middle of a list of other commands:

```bash
node --import tsx mail-engine/src/index.ts            # API + delivery worker · Ctrl+C to stop
```

From a *second* terminal:

```bash
curl -s http://127.0.0.1:2580/healthz
```

That answers with the queue depth, the DKIM status per domain, and a list of everything that is
stopping it from delivering. To run it detached instead, on Windows PowerShell:

```powershell
Start-Process node -ArgumentList '--import','tsx','mail-engine/src/index.ts' -WindowStyle Hidden
```

### The whole stack

**Needs Docker Desktop, which is not installed on the ZBook** (WSL2 is). `docker compose` will
report `docker: command not found` until it is.

The container configuration in `docker/` has never been executed. It has been through an adversarial
review — five independent reviewers against Postfix, Dovecot, Rspamd/OpenDKIM, the compose wiring and
the documentation, each finding checked by a second reviewer whose brief was to refute it — and the
blockers it found are fixed: a read-only certificate mount that crash-looped Postfix and Dovecot on
first boot, a `smtpd_sender_login_maps` pointing at a map of maildir paths that refused 100% of
authenticated submission, a missing `users` file that Docker turns into a directory and silently
kills all authentication, six environment variables the compose file never passed through, a global
`header_checks` that stripped the `Authentication-Results` header the engine reads, and a DKIM
private key being baked into an image layer for want of a `.dockerignore`.

Reviewed is not run. Expect to find more on the first real `up`.

```bash
cp mail-engine/.env.example mail-engine/.env         # then fill in the secrets
docker compose -f mail-engine/docker-compose.yml up -d
docker compose -f mail-engine/docker-compose.yml logs -f postfix
```

Brings up Postfix, Rspamd, OpenDKIM, Dovecot, Redis and the engine. See
[docs/operations.md](docs/operations.md).

### Send one message through the real pipeline

```bash
node --import tsx mail-engine/src/cli.ts send noreply@edurankai.in you@example.com "Hello"
node --import tsx mail-engine/src/cli.ts flush        # run one delivery pass now
node --import tsx mail-engine/src/cli.ts check        # where did it get to
```

With `MAIL_DELIVERY_ENABLED=false` (the default) that exercises validation, the queue, MX grouping,
throttling and the event stream, and stops before opening a socket to anyone. The message stays
queued and the event says exactly why.

---

## Read this before expecting mail to arrive

Three things about the laptop, and none of them are configuration problems:

1. **Outbound port 25 is blocked** on essentially every domestic connection and by default on AWS,
   GCP, Azure and every other large provider. Direct-to-MX delivery cannot work from there. Set
   `MAIL_RELAY_HOST` to a smarthost, or run the engine on a host with 25 open.
2. **Inbound port 25 needs a public IP and an MX record** pointing at it. A laptop behind NAT cannot
   receive Internet mail, whatever the container says it is listening on.
3. **PTR (reverse DNS) cannot be set from here at all.** It is set by whoever owns the IP address.
   Most large receivers refuse or heavily penalise mail from an IP with no matching PTR.

All three are covered in [docs/dns.md](docs/dns.md), along with the SPF, DKIM and DMARC records the
domain needs.

---

## Layout

| Path | What lives there |
|---|---|
| `src/contracts/` | `MailTransport`, `InboundMailProcessor`, `DeliveryEventPublisher` — the boundary |
| `src/pipeline.ts` | submission: validate → suppression → queue |
| `src/worker.ts` | the delivery worker: claim, deliver, classify, retry or dead-letter |
| `src/queue/message-spool.ts` | the durable queue (see the note at the top about the second spool) |
| `src/queue/retry.ts` | backoff, jitter, exhaustion |
| `src/queue/outbox.ts` | durable, ordered handoff to an application that may be down |
| `src/smtp/transport.ts` | the SMTP client: direct-to-MX or relay, TLS, DKIM, per-recipient verdicts |
| `src/smtp/classify.ts` | reply codes → bounce classes → suppression decisions |
| `src/smtp/mx.ts` | MX resolution, RFC 5321 ordering, null-MX, caching |
| `src/smtp/throttle.ts` | per-domain concurrency and rate limiting |
| `src/mime/parse.ts` | inbound MIME, attachments, threading headers |
| `src/mime/dsn.ts` | delivery reports and abuse complaints |
| `src/inbound/processor.ts` | inbound decisions and the handoff to the application |
| `src/inbound/imap-sync.ts` | reading Dovecot, so the application never speaks IMAP |
| `src/publish/http.ts` | the signed event contract + the local suppression mirror |
| `src/server.ts` `src/cli.ts` | the API, and the operator's hands |
| `docker/` | Postfix, Dovecot, Rspamd, OpenDKIM, and the engine's own image |
| `docs/` | DNS, operations, the event contract, moving to production |

## Tests

```bash
npx vitest run mail-engine/
```

225 tests, no Docker and no network required. `test/smtp-integration.test.ts` runs a real SMTP server
on loopback (`test/helpers/fake-smtp.ts`) and drives real deliveries through it — signed messages,
partial rejections, dropped connections, 421s — because a mail transport tested against a mock is a
mock that has been tested.
