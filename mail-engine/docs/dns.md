# DNS, and what a laptop cannot do

Mail delivery is mostly a DNS problem. A perfectly configured mail server with the wrong DNS delivers
nothing to Gmail; a modest one with the right DNS delivers everything. This is the complete list of
records, what each one is for, and — the part usually left out — which of them **cannot be set from
here at all**.

---

## The honest limits first

| Requirement | On the ZBook | Why |
|---|---|---|
| Receive mail from the Internet | **No** | Needs a public IP with an MX record pointing at it. A laptop behind NAT has neither. |
| Send direct to MX (port 25 out) | **Almost certainly no** | Domestic ISPs block outbound 25 to stop spam. So do AWS, GCP, Azure and Vercel by default. |
| PTR / reverse DNS | **No, and this cannot be worked around** | PTR is published by whoever owns the IP block — your ISP or hosting provider. Nothing you configure locally can create one. |
| SPF, DKIM, DMARC records | **Yes** | These are records on *your domain*, which you control. |
| Sign mail with DKIM | **Yes** | The key is local; only the public half is in DNS. |
| Send through a relay | **Yes** | This is how the laptop sends anything, and it is what `MAIL_RELAY_HOST` is for. |

**Do not pretend otherwise.** A local stack that appears to accept a message on port 25 has accepted
it from *itself*. That is a useful test of the pipeline and it is not evidence that the Internet can
reach you.

---

## The records

Assume the mail host is `mail.edurankai.in` at `203.0.113.10`, and the sending domain is
`edurankai.in`. Print the current set with:

```bash
node --import tsx mail-engine/src/cli.ts dns edurankai.in
```

### 1. A — where the mail host is

```
mail.edurankai.in.      A       203.0.113.10
```

`MAIL_HOSTNAME` must match this name, because it is what the engine says in EHLO and what a
receiving server compares against the PTR record.

### 2. MX — where mail for the domain goes

```
edurankai.in.           MX      10 mail.edurankai.in.
```

The trailing dot matters. An MX record must point at a **hostname, never an IP** — a receiving server
that finds an IP there treats the record as broken.

A second MX at a higher preference number is a backup, and only add one if it is a real mail server
that will queue and forward. A backup MX pointing at something that does not accept mail is worse
than none: senders will try it, fail, and some will stop rather than falling back.

### 3. SPF — which servers may send as this domain

```
edurankai.in.           TXT     "v=spf1 mx a:mail.edurankai.in -all"
```

- `mx` authorises whatever the MX records point at.
- `a:mail.edurankai.in` authorises that host explicitly.
- `-all` is a hard fail: nothing else may send as this domain. Start with `~all` (soft fail) while
  you find every legitimate sender, then tighten.

**There must be exactly one SPF record.** Two `v=spf1` TXT records on the same name is a permanent
error and SPF fails entirely — this is the single most common way a domain breaks its own mail. When
adding a sender, merge it into the existing record:

```
"v=spf1 mx a:mail.edurankai.in include:some-provider.example -all"
```

Also mind the **ten-lookup limit**: every `include:`, `a:`, `mx` and `redirect=` costs one DNS
lookup, and exceeding ten makes SPF fail permanently.

### 4. DKIM — the signature

```
era1._domainkey.edurankai.in.   TXT   "v=DKIM1; k=rsa; p=MIIBIjANBgkqh…"
```

Generate the key and get the exact record with:

```bash
node --import tsx mail-engine/src/cli.ts keygen edurankai.in
```

**Publish the record before you start signing.** A receiver that finds a signature but no key treats
it as a *failure*, which is worse than an unsigned message. Verify propagation first:

```bash
dig +short TXT era1._domainkey.edurankai.in
```

A 2048-bit key does not fit in a single 255-character DNS string. Every competent DNS provider splits
it automatically; if yours does not, `keygen` also prints the quoted split form.

### 5. DMARC — what to do when SPF and DKIM disagree

```
_dmarc.edurankai.in.    TXT     "v=DMARC1; p=none; rua=mailto:dmarc@edurankai.in; adkim=s; aspf=s"
```

Start at `p=none`. It changes nothing about delivery and asks receivers to send you reports, which
tell you which of your senders are failing authentication *before* you start rejecting them.

> **This has already bitten this project.** `MAIL-SETUP.md` records a period where `_dmarc` was set
> to `p=quarantine` while the domain had **no SPF and no DKIM at all** — so the domain's own policy
> was instructing every receiver to spam-folder its own mail. Publish SPF and DKIM, confirm both pass
> on a real message, and only then tighten the policy.

Progression: `p=none` → (verify with reports for a week or two) → `p=quarantine` → `p=reject`.

`adkim=s` / `aspf=s` require strict alignment — the domain in the DKIM signature and the SPF check
must match the From domain exactly, not merely share an organisational parent.

### 6. PTR — reverse DNS

```
10.113.0.203.in-addr.arpa.   PTR   mail.edurankai.in.
```

**You cannot set this.** It is published by whoever owns the IP address: the hosting provider, or the
ISP. Most providers expose it in their control panel; domestic ISPs do not offer it at all.

It matters because a large share of receiving servers check that the connecting IP has a PTR record,
and that the name in the PTR resolves back to the same IP (forward-confirmed reverse DNS). Mail from
an IP with no PTR is refused outright by some receivers and heavily penalised by most.

### 7. MTA-STS and TLS-RPT — optional, and honestly labelled

Not implemented by this engine. Outbound TLS is **opportunistic**: encrypted when the far end offers
it, and unauthenticated, because a large share of MX hosts present certificates that do not match
their MX name and a sender that rejects them delivers nothing. Authenticated TLS between mail servers
needs MTA-STS (a policy file over HTTPS) or DANE (TLSA records plus DNSSEC). Both are real follow-up
work; neither is here, and this is written down rather than glossed over.

---

## Verifying it actually works

In order, because each step is meaningless if the one before it failed:

```bash
# 1. Do the records exist and say what you think?
dig +short MX edurankai.in
dig +short TXT edurankai.in
dig +short TXT era1._domainkey.edurankai.in
dig +short TXT _dmarc.edurankai.in

# 2. Does the sending IP have a matching PTR?
dig +short -x 203.0.113.10          # should print mail.edurankai.in.

# 3. Can the engine see its own key?
node --import tsx mail-engine/src/cli.ts check
```

Then send a real message to an address at a large provider, open it, and look at the raw source
("Show original" in Gmail). You want all three of:

```
spf=pass       header.from=edurankai.in
dkim=pass      header.i=@edurankai.in
dmarc=pass     header.from=edurankai.in
```

`dkim=pass` on its own is not enough — it must be **aligned**, meaning the `d=` domain in the
signature matches the From domain. A message signed by a relay's domain passes DKIM and fails DMARC.

---

## When you move off the laptop

See [production-migration.md](production-migration.md). The short version: a small VPS with a clean
IP, port 25 open in both directions, a PTR record you control, a real Let's Encrypt certificate, and
a warm-up period of a few weeks where sending volume climbs gradually. A brand-new IP that starts
sending thousands of messages on day one gets filtered as a matter of policy, no matter how perfect
the DNS is.
