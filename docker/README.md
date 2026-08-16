# docker/

The local and ZBook mail stack. Driven by `./scripts/start-mail.sh`; the files here are what it
assembles.

```
compose.yml                base: app, mail-worker, mail-parser, smtp-sink, mailops
compose.db.yml             profile `localdb`: Postgres + Redis            (read its header first)
compose.mail.yml           profile `mail`: the real MTA
compose.observability.yml  profile `observability`: Prometheus + Grafana

app/Dockerfile             the Astro app, node adapter instead of the Vercel one
mailops/Dockerfile         one image, four entrypoints, zero npm dependencies
mailops/*.mjs              health aggregator, inbound bridge, queue worker, test sink
postfix/                   main.cf and master.cf overrides, transport map
dovecot/                   dovecot.conf overrides
rspamd/                    notes on DKIM and the controller password
prometheus/                scrape config and alert rules
grafana/                   provisioning and the dashboard, as files
data/                      ALL RUNTIME STATE. gitignored. never commit it.
```

## The four small services

All plain ESM using only Node built-ins — `net`, `http`, `crypto`, `fs`. Nothing in the mail path,
which is the part that accepts connections from the internet, pulls a transitive dependency tree.
That is a deliberate reduction of what has to be trusted at the most exposed point in the system.

| Service | Entry | Does |
| --- | --- | --- |
| `mailops` | `health.mjs` | Probes every component with a **real** connection; serves `/health`, `/ready`, `/metrics` for the stack. |
| `mail-parser` | `ingest.mjs` | SMTP in from Postfix; signs and POSTs **raw MIME** to `/api/mail/inbound`. Retries; answers 451 when the app cannot take it, so the upstream keeps the message. |
| `mail-worker` | `worker.mjs` | Calls `/api/jobs/run` on a short interval. On Vercel Hobby the cron fires **once a day**; this is why a message queued at 09:01 does not wait until tomorrow. |
| `smtp-sink` | `sink.mjs` | Captures outbound to `.eml` files and an HTTP API. **Has no delivery path in its process.** |

They share `smtp-server.mjs` (a minimal SMTP server) and `sign.mjs` (the sender half of the webhook
HMAC).

## Two things that will bite

**`sign.mjs` is a second implementation of `src/lib/mailops/webhook.ts`.** Split because this
container has no build step and cannot import TypeScript. If you change the wire format on one side,
change the other in the same commit — `src/lib/mailops/signer-parity.test.ts` fails if they diverge,
and it is the only thing between a signing change and "inbound mail stopped arriving" six weeks
later.

**The Postfix transport map is a hashed file.** After editing `postfix/era_transport`:

```bash
docker compose exec mta postmap /etc/postfix/era_transport && docker compose exec mta postfix reload
```

Forgetting `postmap` is the classic failure: the text file says one thing, the `.db` says the
previous thing, and mail keeps routing the old way with no error anywhere.

## Not yet run

**None of this has been executed.** These files were written on a machine with no Docker installed.
The `.mjs` services in `mailops/` are verified in detail (TESTING.md section 1) — the compose files,
the Postfix and Dovecot configuration and the Prometheus/Grafana wiring are not. Bring it up in
layers: `docs/mail/DEPLOYMENT.md` section 2.
