# Moving from the laptop to real infrastructure

The architecture does not change. The same containers, the same configuration file, the same code —
what changes is the network the host sits on and the credentials it holds. That is the point of
building it this way: nothing here is laptop-shaped.

---

## What the destination host must have

| Requirement | Why it is non-negotiable |
|---|---|
| A **static public IPv4 address** | MX records point at a host, and the host has to still be there tomorrow. |
| **Port 25 open, both directions** | Inbound is what an MX *is*. Outbound is direct delivery. Most clouds block outbound 25 by default and will open it on request — ask before you build. |
| A **PTR record** you can set, matching `MAIL_HOSTNAME` | Set by whoever owns the IP. Many receivers refuse mail from an IP with no matching reverse DNS. |
| A **clean IP** with no sending history | Check it against the common blocklists before committing. Inheriting a spammer's IP costs weeks. |
| Real disk for the spool | Never a tmpfs. This is accepted mail that has not been delivered yet. |
| 2 GB RAM, 2 cores, 20 GB disk | Comfortable for this stack. Rspamd is the memory-hungry part. |

Providers that generally allow port 25 on request: Hetzner, OVH, Vultr, DigitalOcean, Linode.
Providers that generally do not: AWS EC2 (case-by-case and slow), Google Cloud (never), Azure
(enterprise agreements only). Vercel is serverless and cannot run this at all — which is exactly why
the engine is a separate service and is excluded from the Vercel bundle in `.vercelignore`.

---

## The move

### 1. DNS first, and wait

Publish A, MX, SPF, DKIM and DMARC (`p=none`) as described in [dns.md](dns.md) **before** the host
sends anything. Ask the provider for the PTR record at the same time; it is often the slowest step.

### 2. Bring the stack up

```bash
git clone <repo> /opt/edurankai && cd /opt/edurankai
cp mail-engine/.env.example mail-engine/.env
$EDITOR mail-engine/.env
docker compose -f mail-engine/docker-compose.yml up -d
```

Production `.env` differences from the laptop:

```ini
MAIL_HOSTNAME=mail.edurankai.in         # must match the PTR record exactly
MAIL_DELIVERY_ENABLED=true
MAIL_RELAY_HOST=                        # EMPTY — direct to MX, which is the point of this host
MAIL_APP_BASE_URL=https://www.edurankai.in
MAIL_APP_SHARED_SECRET=<32 random bytes, hex>
MAIL_INBOUND_SECRET=<the value in /admin/mail/settings>
MAIL_SPOOL_DIR=/var/spool/mail-engine
MAIL_ENGINE_HOST=127.0.0.1              # the API stays on loopback; only 25/587/465/993 face the world
NODE_ENV=production
```

Set the same `MAIL_APP_SHARED_SECRET` in the application's Vercel environment, or the events arrive
signed with a key it cannot check and are refused.

### 3. A real certificate

The entrypoints generate a self-signed certificate so the stack starts. In production that means
other mail servers fall back to cleartext — it works, and everything is readable in transit.

```bash
certbot certonly --standalone -d mail.edurankai.in
mkdir -p /opt/edurankai/mail-engine/docker/certs
cp /etc/letsencrypt/live/mail.edurankai.in/fullchain.pem mail-engine/docker/certs/
cp /etc/letsencrypt/live/mail.edurankai.in/privkey.pem   mail-engine/docker/certs/
docker compose -f mail-engine/docker-compose.yml restart postfix dovecot
```

Add the copy-and-restart to the renewal hook. A certificate that expires silently degrades every
connection to cleartext without anything appearing to break, which is the worst kind of failure.

### 4. Keys and mailboxes

```bash
node --import tsx mail-engine/src/cli.ts keygen edurankai.in    # then publish the printed record
docker compose -f mail-engine/docker-compose.yml exec dovecot doveadm pw -s ARGON2ID
cp mail-engine/docker/dovecot/users.example mail-engine/docker/dovecot/users   # add the hash
```

Moving an **existing** key instead of generating a new one: copy `<domain>.private` into
`mail-engine/keys/`, `chmod 600`, and keep the same `MAIL_DKIM_SELECTOR`. The published DNS record
stays valid and no propagation wait is needed.

### 5. Warm up, do not launch

A brand-new IP that sends 5,000 messages on its first day is filtered on principle. Roughly:

| Week | Per day |
|---|---|
| 1 | 50 |
| 2 | 200 |
| 3 | 1,000 |
| 4 | 5,000 |

Send to engaged recipients first — people who open mail teach a provider the domain is wanted, and
that is most of what reputation is. Watch `mail_outbound_bounced_total{class="spam_rejection"}` and
stop climbing if it moves.

### 6. Tighten DMARC

After a week or two of DMARC reports showing SPF and DKIM passing for every legitimate sender:
`p=none` → `p=quarantine` → `p=reject`. Not before. The reports exist precisely so this is not a
guess, and the alternative is the failure already recorded in `MAIL-SETUP.md`, where the domain's own
policy spam-foldered its own mail.

---

## Cutting over from the current setup

Today the application relays through GoDaddy's SMTP as `connect@edurankai.in` and reads that mailbox
back over IMAP (`MAIL-SETUP.md`). That keeps working and does not need to be switched off.

A safe sequence:

1. Stand the new host up and send **only** to internal addresses. Confirm `spf=pass`, `dkim=pass`,
   `dmarc=pass` in the raw source of a message received at a large provider.
2. Point one low-stakes flow at the engine (`MAIL_APP_BASE_URL` → `POST /submit`) while everything
   else still relays through GoDaddy. Compare bounce rates for a week.
3. Move transactional mail (password resets, certificates) once the first flow is boring.
4. Move the MX record last. Receiving is the harder half to roll back, because mail sent during a
   bad cutover is at the wrong server or nowhere.
5. Keep the GoDaddy mailbox as a fallback path for at least a month.

Merge the SPF records rather than replacing one with the other during the overlap — **one SPF record
per domain**, containing every legitimate sender:

```
"v=spf1 mx a:mail.edurankai.in include:secureserver.net -all"
```

---

## Scaling later

- **More outbound volume**: run several engine containers over a shared spool volume. The claim is a
  `link()`, which is atomic — the design already supports multiple workers, and `test/spool.test.ts`
  asserts it under a three-way race.
- **More inbound volume**: Postfix is not the bottleneck; the application's `/api/mail/inbound` is.
  The engine's spool absorbs a slow application by design.
- **A second mail host**: add a second MX at the same preference. Both must have their own PTR, and
  both must be in the SPF record.
- **Somewhere other than Docker**: the engine is a Node process with a filesystem spool and one HTTP
  port. `npm install && node --import tsx src/index.ts` under systemd is a legitimate deployment;
  Postfix, Dovecot and Rspamd are all standard distribution packages and the configuration files in
  `docker/` are ordinary configuration files.

## What is not built

Written down rather than discovered later:

- **MTA-STS and DANE.** Outbound TLS is opportunistic and unauthenticated — see the TLS note in
  `src/smtp/transport.ts`. Authenticating it needs a policy file over HTTPS or TLSA records with
  DNSSEC.
- **ARC.** Forwarded mail that breaks SPF and DKIM alignment cannot be vouched for.
- **Outbound rate limits per tenant.** Limits are per destination domain, not per sender.
- **Inbound greylisting decisions in the engine.** Rspamd does it; the engine does not participate.
- **A UI.** Deliberately: the brief assigns the interface to another patch, and the engine's numbers
  are exposed at `/metrics` and `/stats` for it to consume.
