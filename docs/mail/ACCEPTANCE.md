# ACCEPTANCE

The brief's section 19 lists seventeen things a user must be able to do, on Vercel + Supabase +
ZBook, with no external delivery provider as the primary mail engine.

**This document does not claim they pass.** It is the script for demonstrating them, plus an honest
statement of which are covered by an automated test, which need a person, and which cannot be
demonstrated at all until DNS and a real MTA are in place. The person who runs it fills in the
result column.

---

## 0. Before starting

```bash
node scripts/mail-env-check.mjs --file .env.local   # no errors
./scripts/start-mail.sh --mail --observability
./scripts/status-mail.sh                            # every expected component ok
./scripts/test-mail.sh --all
```

If `./scripts/test-mail.sh --all` exits non-zero, stop. Read TESTING.md section 3 — exit code 2 means
something was **skipped**, which is not a pass and usually means a service is not running.

---

## 1. The seventeen

`auto` = an automated test covers it · `manual` = a person must do it · `blocked` = needs DNS,
reverse DNS and a real MTA first.

| # | Capability | How to demonstrate | Covered |
| --- | --- | --- | --- |
| 1 | Log in | `/admin/login` with the operator account | manual |
| 2 | Access mailbox | `/admin/mail` or `/portal/mail` renders the inbox | manual |
| 3 | Compose | Open the composer, fill To / Subject / body | manual |
| 4 | Send | Send; the message appears at `http://localhost:1080/messages` within seconds | manual + `auto` for the transport hop (`tests/integration/send.mjs`) |
| 5 | Receive | `node tests/helpers/…` or send to the bridge; the message appears in the inbox | `auto` for SMTP→app (`ci-smoke.mjs`); **manual** for app→inbox rendering |
| 6 | Read | Open it; it marks as read | manual |
| 7 | Reply | Reply; check the reply threads onto the original rather than starting a new thread | manual — the threading regression this codebase has already had |
| 8 | Forward | Forward to a second address; check the body and attachments survive | manual |
| 9 | Attach a file | Attach, send, download from the sent copy | manual |
| 10 | Create a contact | `/admin/mail/contacts` | manual |
| 11 | Create a template | `/admin/mail/templates` | manual |
| 12 | Create a campaign | `/admin/mail/campaigns` | manual + `auto` (`tests/integration/campaign.mjs`, needs `TEST_SESSION_COOKIE`) |
| 13 | Schedule a campaign | Schedule for +10 minutes; confirm **nothing sends now** | `auto` (asserts no delivery at schedule time) |
| 14 | See delivery events | `/admin/mail/analytics` shows the send | manual |
| 15 | Configure a domain | `/admin/mail/setup` or `/api/v1/domains`; DNS records shown | manual |
| 16 | Create an API key | `/admin` API keys screen; key shown **once** | manual |
| 17 | Trigger email via API | `curl` with the key against the v1 send endpoint | manual |

### 17, concretely

```bash
curl -X POST https://www.edurankai.in/api/v1/messages/send \
  -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"to":"recipient@example.invalid","subject":"API test","text":"hello"}'
```

Send it **twice with the same Idempotency-Key**. The second must not produce a second message. That
is the property worth demonstrating; a single successful call proves much less.

---

## 2. The no-external-provider claim

The brief requires the system to work "without requiring Gmail, MailerLite, SendGrid, or another
external email delivery provider as the primary mail engine".

**What is true now:**

- Outbound goes through `src/lib/mail-transport.ts` to an SMTP server. In the local stack that is
  the sink; with `--mail` it is Postfix on this host. No HTTP delivery API is involved.
- Inbound arrives at Postfix and is handed to the app by `mail-parser`. No provider webhook.
- DKIM signing is Rspamd's, on our host, with our key.

**What is also true, and is the honest qualifier:** the production configuration today relays
outbound through **GoDaddy's SMTP as `connect@edurankai.in`** (`MAIL-SETUP.md`). That is an external
*relay*, not an external delivery *API* — the application's mail engine is still ours, and switching
to the ZBook's own Postfix is a change to `SMTP_HOST`. But nobody should read "no external provider"
as describing production until that switch is made and section 3 passes.

---

## 3. What must be true before this is real mail

Independent of every checkbox above. Until these hold, mail from this system goes to spam folders or
is rejected, and no amount of application correctness changes that.

- [ ] `MAIL_HOST` has an A record, and **reverse DNS that resolves back to it**. Set by whoever owns
      the IP. Missing PTR = rejected outright by large receivers.
- [ ] **One** SPF record, including this sending IP. Two records means SPF fails entirely.
- [ ] DKIM published, and the published public key **actually matches the private key on the host**.
      `./scripts/test-mail.sh --dns`, and BACKUP.md section 6 for why this is checked separately.
- [ ] DMARC at `p=none` until SPF and DKIM pass externally, then raised.
- [ ] Port 25 reachable inbound. Most consumer ISPs block it; check before blaming the stack.
- [ ] A test message to a Gmail address shows **SPF pass, DKIM pass, DMARC pass** under "Show
      original".
- [ ] Sending volume warmed up over 2–4 weeks. A new IP sending full volume on day one gets blocked.

---

## 4. What a completed run means

A full pass means: **on this stack, on this day, these seventeen operations worked, and the mail
path from application to SMTP and back is exercised by tests that run on every commit.**

It does not mean the system is production-ready for real mail at volume. That needs section 3, an
external uptime monitor (OBSERVABILITY.md section 5), a rehearsed restore (BACKUP.md section 6), and
a first run of the Docker stack, which as of this writing **has never been executed** — see
TESTING.md section 2.
