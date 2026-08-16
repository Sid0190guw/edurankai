# Running it

A runbook: what to look at, what the numbers mean, and what to do when mail is not moving.

---

## First questions, in order

```bash
node --import tsx mail-engine/src/cli.ts check
curl -s http://127.0.0.1:2580/healthz | jq
```

`check` prints the transport in use, whether delivery is enabled at all, the queue depth, the DKIM
status per domain, and a `warnings` list of everything stopping it from working. Nine times out of
ten the answer is in that list — most often `MAIL_DELIVERY_ENABLED is off`, which is the shipped
default and means the queue fills and nothing leaves.

---

## Two inbound shapes

Set by `VIRTUAL_TRANSPORT` in the compose environment.

### `lmtp:inet:dovecot:24` (default) — mail goes into a real mailbox

```
Internet → Postfix → Rspamd → Dovecot (Maildir) → IMAP → engine → application
```

Gives real mailboxes with folders and flags, readable from any mail client, and the engine syncs new
messages to the application over IMAP (`src/inbound/imap-sync.ts`). Choose this when a human needs to
open `connect@` in a mail client, or when mail must survive an application outage in a form somebody
can read directly.

### `engine` — mail goes straight to the application

```
Internet → Postfix → Rspamd → pipe-to-engine.sh → engine → /api/mail/inbound
```

Lower latency and one fewer moving part. Choose this when the application's mailbox UI is the only
place anyone reads mail. There is no IMAP copy: if the application loses a message, the engine's
inbound spool is the only record.

Both paths run the same recipient validation, the same spam thresholds, and the same parser.

---

## What the numbers mean

`GET /metrics` (Prometheus) and `GET /stats` (JSON).

| Metric | Watch for |
|---|---|
| `mail_queue_depth` | Steadily climbing means delivery is failing or switched off. A brief spike is normal. |
| `mail_queue_deferred` | Messages waiting for a retry. A large number against one domain is that domain deferring you. |
| `mail_queue_dead_letters` | **Never auto-cleared.** Anything here needs a human. |
| `mail_events_pending` | Events the application has not accepted. Non-zero and rising = the app is down or the tables do not exist yet. |
| `mail_outbound_bounced_total{class=…}` | A rise in `invalid_mailbox` means a stale list. A rise in `spam_rejection` means a reputation problem, and that is urgent. |
| `mail_outbound_deferred_total{class="rate_limited"}` | You are sending too fast for that provider. Lower `MAIL_PER_DOMAIN_RATE_PER_MINUTE`. |
| `mail_delivery_latency_ms` | A jump usually means DNS, not SMTP. |
| `mail_throttle_waits_total` | The limiter doing its job. Only interesting alongside a rising queue depth. |

Logs are one JSON object per line, and secrets are scrubbed before writing (`src/logger.ts` redacts
`AUTH PLAIN` lines, `password=`, and PEM blocks).

```bash
docker compose -f mail-engine/docker-compose.yml logs engine | jq -c 'select(.kind=="deferred")'
```

---

## Mail is not going out

1. **`cli check`** — is `deliveryEnabled` false? Is there a DKIM key? Any warnings?
2. **Is the queue actually being claimed?** `mail_queue_depth` high with `mail_outbound_delivered_total`
   flat means the worker is not running, or every message is deferred. The logs say which.
3. **What is the far end saying?**
   ```bash
   docker compose -f mail-engine/docker-compose.yml logs engine \
     | jq -c 'select(.msg=="message deferred") | {messageId, reason, retryIn}'
   ```
4. **Is it port 25?** From the mail host:
   ```bash
   nc -vz gmail-smtp-in.l.google.com 25
   ```
   A timeout means outbound 25 is blocked. Set `MAIL_RELAY_HOST`. See [dns.md](dns.md).
5. **Explain a specific reply:**
   ```bash
   node --import tsx mail-engine/src/cli.ts classify 550 "5.1.1 User unknown"
   ```

## Mail is not coming in

1. `dig +short MX edurankai.in` — does it point at this host?
2. From outside: `nc -vz mail.edurankai.in 25`. Refused means the port is not reachable — NAT,
   firewall, or the container is not published.
3. `docker compose logs postfix` — a rejection is logged with its reason. `Relay access denied` means
   the recipient domain is not in `MAIL_DOMAINS`. `User unknown in virtual mailbox table` means the
   address is not in the recipient map (see `entrypoint.sh`).
4. Accepted but not in the application? `curl -s localhost:2580/healthz | jq .inboundPending`. A
   non-zero number means the engine has the mail and the application is not taking it — the logs name
   the status code.

## Dead letters

```bash
node --import tsx mail-engine/src/cli.ts dead
node --import tsx mail-engine/src/cli.ts requeue <messageId>
```

Dead letters are **never deleted automatically**. A message that exhausted 24 hours of retries is
usually undeliverable, but the decision to give up on it is a person's.

## The suppression list

```bash
node --import tsx mail-engine/src/cli.ts suppressions
node --import tsx mail-engine/src/cli.ts unsuppress someone@example.com
```

Permanent entries come only from a permanent verdict (`invalid_mailbox`, `invalid_domain`, a generic
`hard`). Temporary ones expire on their own: mailbox-full after 7 days, spam rejection and policy
after 1 day, rate-limited after an hour. **A deferral never suppresses** — that is what the retry
engine is for, and suppressing on 4xx would turn one bad hour at a large provider into a list of
addresses this platform refuses to mail.

---

## Restarts, crashes and durability

A restart is safe. On boot the worker calls `recoverStale()`, which returns anything a dead worker
left claimed back to the queue. `docker stop` sends SIGTERM, which drains the current pass, closes
the SMTP connections and makes one last attempt to publish held events; anything unsent stays on
disk.

### Durability limits, stated rather than implied

- Queue writes are **write-to-temp-then-rename**, so a torn or half-written message is impossible.
  They are **not fsynced** — Node has no portable durable-directory-rename, and fsync on a directory
  handle fails on Win32. A power cut in the millisecond between write and rename can lose the newest
  message. Run the spool on the Linux container's filesystem, not on an NTFS host mount.
- Claiming uses `link()` and not `rename()`. On Windows, two concurrent renames of the same source
  **both resolve successfully** while only one file appears — measured, not theorised — so a worker
  trusting a resolved rename would believe it owned a message it did not have. `link()` fails with
  `EEXIST` on every platform, which is the property the claim needs.
- SMTP has no exactly-once delivery. If a worker dies after the receiving server accepted a message
  but before the spool was updated, the message is sent again after the lease expires. Every MTA
  makes this trade: a duplicate is recoverable, a lost message is not.

---

## Backups

Back up **`MAIL_SPOOL_DIR`** and **`mail-engine/keys/`**.

The spool holds mail that has been accepted and not yet delivered — losing it loses real
correspondence, and no other copy exists. The keys directory holds the DKIM private keys; losing them
means regenerating and republishing DNS, and every message signed with the old key fails verification
until the new record propagates.

Everything else — containers, configuration, the code — is rebuildable from git.

## Backpressure and volume

`MAIL_PER_DOMAIN_CONCURRENCY` (2) and `MAIL_PER_DOMAIN_RATE_PER_MINUTE` (60) are conservative on
purpose. Raise them only against measured evidence: a rise in `rate_limited` deferrals is the signal
you have gone too far, and it is a reputation event, not merely a delay. A cold IP should start
around 50–100 messages a day and roughly double weekly.
