# Rspamd configuration

Rspamd runs inside the `mta` container (`ENABLE_RSPAMD=1`) and does three jobs here:

1. **Spam scoring** on inbound mail.
2. **DKIM signing** on outbound mail — this is why `ENABLE_OPENDKIM=0`. Running both signs every
   message twice, and a double signature is not "extra secure"; some receivers treat the second,
   unexpected signature as a failure.
3. **SPF / DKIM / DMARC verification** on inbound mail, whose results the app can read from the
   `Authentication-Results` header that Rspamd adds.

## Where the files go

Drop overrides in `docker/rspamd/local.d/` and they are mounted into the container's
`/etc/rspamd/local.d/`. Rspamd merges `local.d` over its defaults, so a file here only has to
contain the settings you are changing — copying a whole default file in is how you end up pinned to
a two-year-old default nobody notices.

## The one thing you must not skip

**The controller password.** Rspamd's web UI on 11334 is a *remote configuration interface*: it can
change scores, train the Bayes classifier, and whitelist senders. Left unauthenticated and exposed,
it is a way to make an attacker's mail permanently pass your filter.

`docker/compose.mail.yml` does not publish port 11334 at all — the proxy service that would do it is
commented out. If you uncomment it, set a password first:

```bash
# generate a hash on the host
docker compose exec mta rspamadm pw
# put the output in docker/rspamd/local.d/worker-controller.inc as:
#   password = "$2$....";
```

## DKIM keys

The image generates the keypair on first start with `setup config dkim`. The **private key** lands in
`docker/data/mta/config/rspamd/dkim/` — gitignored, mode 0600, and the single most sensitive file in
this stack. Anyone holding it can sign mail as this domain, and rotating it means republishing DNS
and waiting for propagation while some mail fails.

- Back it up encrypted, separately from the database dump: `docs/mail/BACKUP.md` section 2.
- The **public** half goes into DNS as `<selector>._domainkey.<domain>` TXT. Print it with:
  `docker compose exec mta cat /tmp/docker-mailserver/rspamd/dkim/<selector>.public.key`
- Publishing the DNS record without the private key present, or with a mismatched selector, makes
  **every** signature fail while the DNS record makes the setup look configured. `./scripts/test-mail.sh
  --dns` checks the pair actually matches.
