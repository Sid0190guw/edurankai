# TESTING

What is proved, how, and — the part that matters most — **what is not**.

---

## 1. What has actually been verified

Executed and observed, not asserted. Everything in this table was run.

| Guarantee | How | Where |
| --- | --- | --- |
| The hand-written SMTP server speaks real SMTP to a real client | nodemailer sent through it; 250 returned | `docker/mailops/smtp-server.mjs` |
| Long headers are unfolded correctly | a 130-character Subject folded by the client came back whole | sink capture API |
| Dot-stuffing is undone, not doubled or eaten | a body with `.`- and `..`-led lines round-tripped byte-exact | `tests/ci-smoke.mjs` |
| The bridge forwards raw MIME with the envelope intact | `content-type: message/rfc822`, `x-mail-to`/`x-mail-from` preserved | `tests/ci-smoke.mjs` |
| The container's signature verifies with the app's verifier | `docker/mailops/sign.mjs` output checked by `src/lib/mailops/webhook.ts` | `signer-parity.test.ts`, `ci-smoke.mjs` |
| A refused message is **not** acknowledged as delivered | app stubbed to 400; SMTP answered **451**, not 250 | `tests/ci-smoke.mjs` |
| Signature, CORS, service-auth and env rules behave | 42 unit tests | `src/lib/mailops/mailops.test.ts` |
| Backup and restore round-trip | archive written, verified, inspected, restored to a scratch tree | `scripts/backup.sh`, `scripts/restore.sh` |
| The load generator works and reports honestly | 10,000 messages, 0 failures, 757/s, p99 79ms | `tests/load/loadtest.mjs` |
| The linter finds real faults and not false ones | 315 files, 0 errors after tuning; self-test confirms it still catches the real pattern | `scripts/lint-mail.mjs` |

```bash
npx vitest run src/lib/mailops/   # 42 unit tests, ~0.5s
node tests/ci-smoke.mjs           # 13 end-to-end checks, no Docker, no database, ~3s
```

## 2. What has NOT been verified

**Docker was not installed on the machine these files were written on.** So:

- the compose files have never been parsed by `docker compose`;
- no image has ever been built;
- the Postfix, Dovecot and Rspamd configuration has never been loaded by those programs;
- Prometheus has never scraped, and Grafana has never rendered the dashboard.

They are written carefully and against the documented formats, and the app image relies on a switch
(`astro.config.mjs`) that already worked before this patch. But nobody should read "the Docker setup
is delivered" as "the Docker setup ran". Bring it up in the layered order in DEPLOYMENT.md section 2.

---

## 3. Running the live-stack suites

```bash
./scripts/test-mail.sh              # unit + integration
./scripts/test-mail.sh --quick      # unit only, ~2s, no stack
./scripts/test-mail.sh --all        # + security + DNS + load
node tests/run.mjs --only security
```

**Exit codes are the contract:** `0` passed · `1` failed · `2` something was **skipped**.

Code 2 exists because **a skipped suite is not a passing suite**. An integration suite that cannot
reach the system it tests will otherwise report success for months while every case silently
no-ops. `--allow-skip` when you are deliberately testing one half.

### Getting a session cookie for the operator-only cases

Six campaign and automation cases need to authenticate as an operator. Rather than putting a
password in this repository:

1. Sign in to `/admin` in a browser.
2. DevTools → Application → Cookies → copy the session cookie as `name=value`.
3. `export TEST_SESSION_COOKIE='era_session=...'`

The cookie expires. When those cases start skipping with "TEST_SESSION_COOKIE is not set", that is
usually what happened.

---

## 4. Load testing, and why it cannot reach the internet

```bash
node tests/load/loadtest.mjs --messages 1000
node tests/load/loadtest.mjs --messages 100000 --concurrency 32
```

The brief's rule — do not send test spam to the public internet — is enforced structurally, not by
discipline:

- `--target` accepts `sink` and `queue` only;
- the resolver refuses any host that is not loopback or a compose service name;
- **the sink has no delivery path in its process at all.** It cannot forward a message; there is no
  code in it that opens an outbound connection.

Every fixture addresses `example.invalid`, a TLD that can never be registered.

### A measured result, and what it is worth

10,000 messages, concurrency 32, on the ZBook:

```
completed 10000   failed 0   elapsed 13.2s   throughput 757/s
p50 40.7ms   p95 56.5ms   p99 78.8ms
generator CPU 13.2s (100% of one core)
```

**The generator saturated a core.** It and the system under test share one laptop, so 757/s is a
**floor for the application layer**, not a ceiling and not a delivery rate. Real sending is governed
by remote receivers, per-destination concurrency and reputation, none of which are present here.
SCALING.md marks which of its figures are measured and which are estimates.

---

## 5. Security suite

```bash
node tests/run.mjs --only security
```

Covers: open relay, unauthenticated submission, unauthorized API access, the metrics token, SQL
injection, reflected XSS, path traversal, forged webhooks (four shapes), secret exposure in errors,
security headers, and CORS on a credentialed endpoint.

Two things to know before trusting a green run:

- **The open-relay case SKIPS without the `mail` profile**, and says so in capitals. It is the single
  most important check in the file and it does not run unless Postfix is up.
- **A green run means these specific attacks were refused.** It is a regression suite for known
  failure classes, not a penetration test. Reporting it as one would be the most dangerous thing in
  this repository.

---

## 6. Disaster-recovery drills

Not automated — each needs a deliberate destructive act. Run them against `--localdb`.

| Drill | Do | Expect |
| --- | --- | --- |
| App restart | `docker compose restart app` | Bridge answers 451; upstream retries; **no message lost**. |
| Worker restart | `docker compose restart mail-worker` | Claimed jobs return to pending after their attempt window; SIGTERM finishes the tick in flight rather than abandoning a claim. |
| Postfix restart | `docker compose restart mta` | Queued mail survives; `postqueue -p` non-empty then drains. |
| Redis restart | `docker compose restart redis` | Nothing breaks — the shipped queue is Postgres. This drill exists to prove the dependency is genuinely absent. |
| DB connection loss | block the pooler port | `/api/health` → 503; `/api/health/ready` → 503; queue holds. |
| Network loss | disconnect the ZBook | MTA queues; the worker backs off exponentially rather than hammering. |
| Duplicate message | replay the same inbound twice | Second is refused by delivery-id replay detection (`verifyInbound`, `seen`). |
| Duplicate event | POST the same webhook twice | Same signature and delivery id → refused. |
| Partial delivery | kill the worker mid-batch | Jobs return to pending; **idempotent handlers mean no double send**. |

The rule every drill checks: **no silent data loss**. A message either arrives, or somebody is told
it did not.

---

## 7. Guarantees nothing currently proves

Listed rather than left to be assumed. Each is a real gap.

1. **The browser hop.** There is no headless browser here. "Web UI → API" in the SEND path, and every
   screen Patch 3 owns, are untested end to end. The API hops beneath them are covered.
2. **Automation delays.** Proving a delay is honoured needs a controllable clock or a wait as long
   as the delay; a test that waits 24 hours gets deleted by the first person it inconveniences. The
   delay logic is unit-tested by the patch that owns it; the end-to-end guarantee is not.
3. **Real delivery to a real receiver.** No message has been delivered to Gmail or anywhere else.
   Whether mail from this system lands in an inbox depends on DNS, PTR and reputation, and cannot be
   tested locally at all.
4. **IMAP retrieval.** `/api/health/mail` checks that IMAP is *configured*; it does not log in,
   because a health check that authenticates burns a connection and some providers rate-limit
   repeated logins. The live test is the button on `/admin/mail/settings`.
5. **Postfix's own hop.** Every inbound test enters at the bridge. `stranger → Postfix → bridge` is
   only exercised when the `mail` profile is running, and it has never been run.
6. **Anything at production scale.** The largest verified run is 10,000 messages into a sink on one
   laptop.

---

## 8. The repository's own test suite

`npm test` (Vitest plus the house shim runner) runs in CI as `continue-on-error: true`. This
workflow is the first thing that has ever run it, so its baseline state was unknown when the job was
written, and making an unknown baseline a hard gate would have made CI red on day one — after which
nobody reads it.

**Turn it into a hard gate as soon as it is observed green.** Remove the `continue-on-error` line in
`.github/workflows/ci.yml`. The type-check ratchet next to it is the model: it enforces "no new
errors" from day one against a recorded baseline of 24 pre-existing ones.
