# scripts/mailops — backup, restore, migration and recovery tooling

**The founder runs everything here.** No agent and no process in this repository opens the
production database; that rule is in `CLAUDE.md` and it exists because a subagent asked to survey
*source files* connected to production and read staff PII instead. These scripts are written to be
handed over and executed by a person on a trusted machine.

Nothing here is invoked by the application. The only link back is that several scripts **report**
what they did to `/api/mailops/report`, so `/admin/mail/continuity` can show whether a backup was
taken, whether a restore was ever proved, and what the mail host last said about itself. Reporting
is optional and authenticated with `CRON_SECRET`.

## What each one is for

| Script | Purpose | Touches production? |
| --- | --- | --- |
| `spool-recover.ts` | Inspect the outbound spool; reclaim leases abandoned by a crashed worker; sweep debris from an interrupted write. | Mail host filesystem only. Never sends. |
| `health-check.ts`* → `health-check.sh` | TCP-connect checks on MX, submission, IMAP, outbound port 25 and spool free space; reports each component. | Read-only. |
| `db-backup.sh` | Encrypted, checksummed `pg_dump`. Refuses to write plaintext, refuses the pooler. | Reads the database. |
| `db-restore.sh` | Restore into a **scratch** instance and verify content. Refuses anything that looks like production. | Writes to scratch only. |
| `mail-data-backup.sh` | The things that are not in Postgres: DKIM keys, maildirs, MTA config, dead-lettered spool. | Reads the mail host. |
| `db-migrate.sh` | Supabase → self-hosted Postgres, in stoppable stages. | Reads source, writes target. |
| `mailbox-migrate.sh` | Maildir bulk/delta copy, and the inventory that proves it. | Reads source, writes target. |
| `storage-migrate.sh` | Object storage → S3-compatible, key-preserving, no deletes. | Reads source, writes target. |
| `migration-report.ts` | Compare two inventories; decide whether cutover is allowed. | Nothing. Reads two JSON files. |
| `dns-verify.ts` | MX/SPF/DKIM/DMARC from several resolvers. | Read-only DNS. |
| `dns-cutover.ts` | Plan an MX cutover and gate it. **Never writes DNS.** | Nothing. |
| `generate-runbooks-doc.ts` | Regenerate `docs/mail/RUNBOOKS.md` from the runbook module. | Nothing. |

\* the health check is `health-check.sh` — bash, so it runs on a minimal mail host with no Node.

## The `.ts` scripts run under tsx

```bash
npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only
```

They are TypeScript rather than plain `.mjs` because they **import the real modules** — the spool,
the migration comparison, the cutover arithmetic. A recovery tool with its own copy of the queue
logic is a second, divergent queue, and the two disagree about what "sending" means on exactly the
day you need them not to.

The `.sh` scripts are bash because they run on the mail host, where `pg_dump`, `tar` and `curl` are
the only things that can be relied on.

## Two properties every script here has

**It refuses rather than guesses.** `db-backup.sh` will not write an unencrypted dump.
`db-restore.sh` will not restore over anything matching `DATABASE_URL`. `dns-cutover.ts` will not
change a record at all. Each refusal is there because the destructive command and the correct one
differ by one string.

**It distinguishes "did not happen" from "could not tell".** `dns-verify.ts` reports a timed-out
lookup as *not determined*, never as *not published* — those send you to two different places, and
only one of them is where the problem is. `db-restore.sh` treats a zero-row restore as a failure
even when `pg_restore` exits 0.

The written-up versions are [docs/mail/HA-DR.md](../../docs/mail/HA-DR.md) and
[docs/mail/MIGRATION-VERIFICATION.md](../../docs/mail/MIGRATION-VERIFICATION.md).

## Typical week

```bash
# Nightly, on the founder's machine
export DATABASE_URL_DIRECT='postgres://...:5432/postgres'      # leading space keeps it out of history
./scripts/mailops/db-backup.sh --out /backups --recipient age1... \
    --offsite --report-to https://www.edurankai.in

# Nightly, on the mail host
./scripts/mailops/mail-data-backup.sh --out /backups --recipient age1... \
    --maildir /var/mail --keys /etc/opendkim/keys --config /etc/postfix --spool "$MAIL_SPOOL_DIR"

# Monthly — the one that turns a copy into a backup
docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw --name era-restore-test postgres:17
./scripts/mailops/db-restore.sh --artefact /backups/db-<stamp>.dump.enc \
    --target 'postgres://postgres:pw@localhost:5433/postgres' --report-to https://www.edurankai.in
docker rm -f era-restore-test

# Continuously, on the mail host
watch -n 60 ./scripts/mailops/health-check.sh --report-to https://www.edurankai.in
```

Until the monthly line has run at least once, `/admin/mail/continuity` shows every backup set as
**never** verified — and it is right to.

## Reporting

Set `CRON_SECRET` (the same machine secret the cron endpoints use) and pass `--report-to
<base-url>`. Without both, the scripts still do their work and say plainly that nothing was filed.
The endpoint fails closed: with `CRON_SECRET` unset on the server, it accepts nothing.

One rule enforced on the server side rather than here: a restore test reported as passed **with no
checks attached** is recorded as FAILED. A restore that verified nothing proves nothing, and letting
an empty script run paint a green tick is the exact failure this tooling exists to prevent.
