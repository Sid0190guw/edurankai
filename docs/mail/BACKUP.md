# BACKUP AND RECOVERY

The wider platform's backup policy is [`docs/ops/BACKUP.md`](../ops/BACKUP.md) and it still governs:
**the founder runs everything that touches the database. No automation in this repository connects
to it.** This document covers the mail infrastructure specifically.

---

## 1. What is worth backing up, in order of how badly you are hurt

| # | Asset | If lost | Where |
| --- | --- | --- | --- |
| 1 | **`DATA_ENCRYPTION_KEY_<keyId>`** | Every column encrypted under it becomes permanently unreadable. A perfect database dump does not help. | Vercel env vars |
| 2 | **DKIM private key** | Recoverable by generating a new one — but every message signed with the old key fails until DNS propagates, and anyone holding a copy can sign mail as this domain forever. | `docker/data/mta/config/rspamd/dkim/` |
| 3 | **The Postgres database** | Everything else. No file in this repository reconstructs the live schema; only a dump does. | Supabase |
| 4 | **Mailboxes** | Messages held on this host. | `docker/data/mta/mail/` |
| 5 | **The other secrets** | Credentials stop verifying; mail and payments stop. Recoverable by re-issuing, at real cost. | Vercel env vars |
| 6 | **Mail server config** | Accounts and aliases. Rebuildable by hand, tediously. | `docker/data/mta/config/` |

The git repository is not on this list — GitHub holds it and every clone is a copy.

---

## 2. Running a backup

```bash
./scripts/backup.sh                 # 2, 4, 6 and the compose/service config
./scripts/backup.sh --database      # also 3 — interactive only, see below
```

Each archive is `backups/mail-<ISO8601>.tar.gz`, mode 0600, with a `MANIFEST.txt` recording what is
inside, what is **not**, the host and the commit. The script verifies the archive lists cleanly
before reporting success — that catches the truncated-write and out-of-disk cases, which are the
common ones.

### Why `--database` asks

It prints the exact `pg_dump` command, shows the connection **with the password masked**, and
requires you to type `YES`. In a non-interactive shell it refuses outright.

That is not ceremony. `docs/ops/BACKUP.md` records why the rule exists: a subagent asked to survey
*source files* connected to production instead and read staff data out of `hr_employees`. A read of
employee PII is not a lesser act than a write. This script is written to be handed to a person.

It also warns if `DATABASE_URL` is the transaction pooler (`:6543`) — `pg_dump` wants the **direct**
connection (`:5432`); through the pooler it can fail or produce an inconsistent snapshot. Set
`DATABASE_URL_DIRECT`.

---

## 3. Secrets are NOT in the archive, deliberately

No `.env` file and no Vercel variable is swept into the tarball. Copying live credentials into an
archive on the same disk is not a backup; it is a second copy of the secret with worse permissions
and no rotation story.

Back them up separately and encrypted:

```bash
# On the founder's machine only.
vercel env pull .env.production.backup           # then, immediately:
gpg --symmetric --cipher-algo AES256 .env.production.backup
shred -u .env.production.backup                  # or delete securely on Windows
```

Store the `.gpg` somewhere that is **not** the machine that holds the database backup. Losing both
to one theft or one disk failure is the scenario this separation exists for.

The DKIM private key is in the archive (it lives under `docker/data/mta/config/`). If you keep those
archives anywhere shared, encrypt them the same way — with that key, anyone can sign mail as this
domain.

---

## 4. Restoring

```bash
./scripts/restore.sh backups/mail-….tar.gz                      # inspect: reads, changes nothing
./scripts/restore.sh backups/mail-….tar.gz --to /tmp/drill      # scratch copy
./scripts/restore.sh backups/mail-….tar.gz --live               # overwrite the real stack
```

**`--inspect` is the default.** A restore script whose default action overwrites live mailboxes is a
loaded weapon, and the moment you reach for it is the moment you are least careful.

`--live` requires:

- **the stack stopped.** Restoring into a running Dovecot corrupts mailbox index files, and the
  damage is not visible until the next write — by which point the backup has been overwritten too.
  The script checks and refuses.
- **the word `RESTORE` typed.**

It moves the current contents to `docker/data/.pre-restore-<timestamp>` rather than deleting them,
so a restore from the wrong archive is recoverable. Verify before deleting that directory.

**The database is never restored by the script.** It prints the `pg_restore` command and stops.
`--clean` drops existing objects before recreating them; against the wrong database that is total
data loss with no undo. Restore into a new empty database first and compare.

---

## 5. Retention and scheduling are NOT automated

Nothing schedules a backup. Nothing deletes an old one. Archives accumulate in `backups/` until
somebody removes them.

That is a real gap, stated rather than hidden. To close it on the ZBook:

```bash
# crontab -e   — daily at 03:00, keep 14 days
0 3 * * * cd /path/to/edurankai && ./scripts/backup.sh >> logs/backup.log 2>&1
0 4 * * * find /path/to/edurankai/backups -name 'mail-*.tar.gz' -mtime +14 -delete
```

Deliberately **not** `--database`: an unattended database dump is exactly what the rule in section 2
forbids. The database backup stays manual, or moves to Supabase's own scheduled backups — check the
dashboard for what the current plan actually retains, and write the answer here rather than trusting
this sentence.

---

## 6. The restore drill — 30 minutes, do it now

A backup you have never restored is a hope.

```bash
./scripts/backup.sh
./scripts/restore.sh backups/mail-<newest>.tar.gz --inspect        # manifest sensible?
./scripts/restore.sh backups/mail-<newest>.tar.gz --to /tmp/drill  # extracts cleanly?
ls -la /tmp/drill                                                  # DKIM key present? mailboxes?
```

Then the one that matters: **does the DKIM key in the archive still match the DNS record?**

```bash
cat /tmp/drill/mta/config/rspamd/dkim/<selector>.public.key
dig +short <selector>._domainkey.edurankai.in TXT
```

If they differ, the archive restores a stack whose every signature fails — and the DNS record makes
it look configured. That is the failure this drill exists to find, and it is invisible from the
archive alone.

Do it once now, rather than for the first time during an incident.
