# Mail setup — connect@edurankai.in (GoDaddy Professional Email)

Goal: make **connect@edurankai.in** send + receive cleanly through the app's mail
system. The app does NOT host the mailbox — GoDaddy does. The app **sends via
connect@'s SMTP** and **reads it via IMAP poll**.

> Scope note: this is the single-mailbox (org address) setup. Hosting crores of
> user mailboxes is a separate, much larger project (catch-all inbound via
> Cloudflare Email Routing + dedicated outbound sending infra). Do this first.

---

## Order of operations (each unblocks the next)

### 0. Vercel env vars (HARD BLOCKER — do first)
The site currently returns HTTP 500 on every route because the **new Vercel
project has no `DATABASE_URL`**. Until that's fixed, `/admin/mail/settings`
won't even load.
- New Vercel project → Settings → Environment Variables → add `DATABASE_URL`,
  `AUTH_SECRET`, `SESSION_COOKIE_NAME` (from your local `.env`) + the rest from
  the old project → **Redeploy**.

### 1. DMARC — stop the bleeding (GoDaddy DNS, 1 min)
Right now `_dmarc` = `p=quarantine` but there's **no SPF/DKIM**, so your own
policy is spam-foldering every message you send.
- Temporarily edit the `_dmarc` TXT: change `p=quarantine` → `p=none`.
- Restore `p=quarantine` only AFTER SPF + DKIM pass (step 3 verify).

### 2. Re-add email DNS (GoDaddy — use the automatic setup, don't hand-type MX)
Your DNS reset wiped MX/SPF/DKIM. In GoDaddy:
- Open the **Professional Email** product for connect@edurankai.in.
- Use **"Set up / repair my email DNS"** — it restores the correct **MX + SPF +
  DKIM + autodiscover** automatically. This is authoritative; getting MX wrong
  by hand breaks receiving.

Typical GoDaddy Professional Email values (for reference / verification only —
let GoDaddy set them):
- **MX**: `@` → `mailstore1.secureserver.net` (pri 10) and `@` → `smtp.secureserver.net` (pri 0)
- **SPF (TXT @)**: `v=spf1 include:secureserver.net ~all`
- **DKIM**: GoDaddy adds its selector CNAME(s) automatically
- **Autodiscover (CNAME)**: `autodiscover` → `autodiscover.secureserver.net`

### 3. Wire connect@ into the app (`/admin/mail/settings`, after step 0)
**Outgoing (SMTP) — app sends AS connect@:**
- Host: `smtpout.secureserver.net`
- Port: `465` (SSL) — or `587` for STARTTLS
- Username: `connect@edurankai.in`
- Password: the mailbox password
- From name: `EduRankAI`  ·  From address: `connect@edurankai.in`

**Incoming (IMAP poll) — app reads the mailbox:**
- Host: `imap.secureserver.net`
- Port: `993` (SSL)
- Username: `connect@edurankai.in`  ·  Password: the mailbox password
- The `imap-poll` cron pulls new mail into the app inbox UI.

Because the app relays through GoDaddy's SMTP as connect@, GoDaddy handles the
DKIM signing and SPF alignment for you — no separate signing key needed at this
scale.

### 4. Verify (all in-app, then external)
- Mail Settings → **IMAP test** and **send a test** → both green.
- Mail Health (`/api/mail/dns-check`) → **MX / SPF / DKIM / DMARC all pass**.
- Send to a Gmail address → open it → "Show original" → **SPF: pass, DKIM: pass,
  DMARC: pass**.
- Then flip `_dmarc` back to `p=quarantine`.

---

## Notes
- One SPF record only. If you later add another sender (e.g. a VPS), MERGE into
  the single `v=spf1 … ~all` — multiple SPF records = SPF fails.
- Keep `p=quarantine` (or move to `p=reject`) once auth passes — it protects the
  domain from spoofing.
