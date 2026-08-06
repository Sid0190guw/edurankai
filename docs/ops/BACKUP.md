# BACKUP

What must be backed up, how often, and by whom.

**The founder runs everything in this document.** No agent connects to the database, and no script in
this repository is permitted to. That rule exists because a subagent asked to survey *source files*
connected to production instead and read staff data out of `hr_employees`. A read of employee PII is
not a lesser act than a write. The commands below are written to be handed over and executed by a
person, on a trusted machine.

---

## 1. What actually needs backing up

Four things, in descending order of how badly you are hurt if you lose them.

| # | Asset | If it is lost | Where it lives |
| --- | --- | --- | --- |
| 1 | **`DATA_ENCRYPTION_KEY_<keyId>` values** | **Unrecoverable.** Every column encrypted under that key becomes permanently unreadable. A perfect database backup does not help — the material is env-only, and only lifecycle metadata is in Postgres (`src/lib/crypto/keys.ts:6`). | Vercel environment variables |
| 2 | **The Postgres database** | Everything. The source contains 343 distinct `CREATE TABLE IF NOT EXISTS` statements scattered across application modules and no migration history, so **no file in this repository reconstructs the live schema**. Only a dump does. | Supabase |
| 3 | **The other secrets** | Credentials stop verifying, calendar feeds break, embed keys stop validating, payments and mail stop. Recoverable by re-issuing, at real cost. | Vercel environment variables |
| 4 | **Object storage** | Uploaded media. Recoverable only if the source files still exist somewhere. | Vercel Blob, or S3-compatible if `S3_*` is configured |

The git repository is **not** on this list — GitHub holds it, and every developer machine holds a
clone. It is the one asset already replicated.

### What is explicitly NOT a backup

- **`/admin/backup` is not a database backup.** It exports *kernel objects and relationships* —
  knowledge objects, course subtrees — as JSON, and restores additively. It does not contain users,
  applications, HR records, payments, sessions, audit rows, or the org graph. It is a content export.
  Do not let its name make anyone comfortable.
- **A Supabase project existing is not a backup.** Confirm on the dashboard what the current plan
  actually retains and for how long. Do not assume point-in-time recovery exists; on free tiers it
  generally does not. **Check, and write the answer here** rather than trusting this sentence.

---

## 2. Prerequisites (one-time, on the founder's machine)

`pg_dump` must be present. It is **not** on `PATH` on the current workstation:

```bash
command -v pg_dump    # currently returns nothing
```

Get it one of these ways:

```bash
# Windows: install PostgreSQL client tools (winget), then reopen the shell
winget install PostgreSQL.PostgreSQL.17
#   -> pg_dump lands in C:\Program Files\PostgreSQL\17\bin

# Or, with Docker, no install at all (pin the major version to the server's):
docker run --rm -e PGPASSWORD -v "$PWD:/out" postgres:17 \
  pg_dump "<connection-string>" -f /out/dump.sql
```

**The client major version must be >= the server major version**, or `pg_dump` refuses to run.
Check the server version first:

```sql
SELECT version();
```

### Which connection string to use — this matters

The app connects through the **Supabase transaction pooler on port 6543**. Do **not** point
`pg_dump` at it. Transaction-mode pooling does not hold a session, and `pg_dump` needs one — it sets
session parameters and holds a consistent snapshot. Symptoms of getting this wrong are confusing:
prepared-statement errors, or a dump that completes and is subtly inconsistent.

Use the **direct / session connection** from
`Supabase dashboard -> Project Settings -> Database -> Connection string`, which is port **5432**
(or the session-mode pooler). Never paste it into a file in this repository, and never into a shell
history that is synced anywhere.

```bash
# Set it for the shell session only. Note the leading space — with HISTCONTROL=ignorespace
# this keeps the credential out of shell history.
 export PGURL='postgresql://...:5432/postgres'
```

---

## 3. The org-graph dump — run this BEFORE any rollback stage

ROLLBACK.md section 4 describes three rollback stages for the organization graph. Stage 2 empties it
and stage 3 drops the tables — and those tables hold the **only** record of who reported to whom and
when. `hr_employees.reporting_manager_id` is a single mutable column: change someone's manager and
the previous value is overwritten and gone. The graph is the history.

**Run this, and confirm the file is non-empty, before you change one `confirm := FALSE` to `TRUE`.**

```bash
cd /c/Users/user/Projects/edurankai-phase36

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/edurankai-backups

pg_dump "$PGURL" \
  --no-owner --no-acl \
  -t public.org_relationships \
  -t public.org_teams \
  -t public.org_positions \
  -t public.org_employee_assignments \
  -f ~/edurankai-backups/org-graph-$STAMP.sql

# VERIFY. A zero-byte or 40-byte file is a failed dump that exited 0.
ls -l  ~/edurankai-backups/org-graph-$STAMP.sql
grep -c "INSERT INTO\|COPY public" ~/edurankai-backups/org-graph-$STAMP.sql
```

`--no-owner --no-acl` matters: Supabase's role names differ from a plain Postgres install, and a dump
carrying ownership statements will fail to restore.

The four table names come from `src/lib/org-graph-schema.ts`. Take the same dump before running
`db/workflow-rollback.sql`, substituting the workflow tables:

```bash
pg_dump "$PGURL" --no-owner --no-acl \
  -t public.workflow_instances -t public.workflow_steps \
  -f ~/edurankai-backups/workflow-$STAMP.sql
```

Also capture the read-only validators, before and after, and keep both outputs alongside the dump:

```
db/org-graph-validate.sql     counts, orphans, cycles, overlaps, drift
db/workflow-validate.sql
```

---

## 4. The full-database dump

The one that matters. Nothing else reconstructs 343 self-bootstrapped tables.

```bash
STAMP=$(date +%Y%m%d-%H%M%S)

# Custom format (-Fc): compressed, and restorable table-by-table with pg_restore.
pg_dump "$PGURL" \
  --no-owner --no-acl \
  -Fc \
  -f ~/edurankai-backups/edurankai-full-$STAMP.dump

# VERIFY — never trust the exit code alone.
ls -lh ~/edurankai-backups/edurankai-full-$STAMP.dump
pg_restore --list ~/edurankai-backups/edurankai-full-$STAMP.dump | wc -l
#   -> should be in the thousands. A handful of lines means the dump is empty.
pg_restore --list ~/edurankai-backups/edurankai-full-$STAMP.dump | grep -c "TABLE DATA"
#   -> should be in the hundreds. Compare against the table count on /admin/infra.
```

Cross-check the number against `/admin/infra`, which reports the live table count and database size
from `pg_database_size` — if the dump lists far fewer tables than that page shows, the dump is wrong.

**Then copy it somewhere that is not the machine that made it.** A backup on one laptop is one
laptop away from being no backup.

### Schema only, for reference

Useful for diffing what the self-bootstrapping DDL has actually built versus what the source
declares. Contains no data, so it is safe to keep in more places:

```bash
pg_dump "$PGURL" --no-owner --no-acl --schema-only \
  -f ~/edurankai-backups/schema-$STAMP.sql
```

---

## 5. Secrets

The single highest-consequence item in this document, and the one with no technical backup path.

```
Vercel -> Project -> Settings -> Environment Variables
```

Record the **names and values** of at minimum:

```
DATA_ENCRYPTION_KEY_<every keyId ever used, including retired ones>
ACTIVE_DATA_KEY_ID
SESSION_SECRET
CREDENTIAL_SIGNING_SECRET
CALENDAR_TOKEN_SECRET
API_EMBED_SECRET
ACTIVITY_ENC_KEY
AUTH_SECRET
OFFER_INTEGRITY_SECRET
CRON_SECRET                (must match the GitHub Actions repository secret)
DATABASE_URL
RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET / RAZORPAYX_ACCOUNT_NUMBER
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
BLOB_READ_WRITE_TOKEN  (or the S3_* set)
CERT_PUBLIC_KEY_PEM / CERT_PRIVATE_KEY_PEM
MAIL_INBOUND_SECRET
```

Store them in a password manager or an encrypted vault. **Never** in this repository, never in a
`.env` file that gets copied around, never in a chat message, never in a ticket.

**Never delete a retired `DATA_ENCRYPTION_KEY_<keyId>` variable.** `ACTIVE_DATA_KEY_ID` only says
which key *new* ciphertext is written under; existing rows still need the old key present to be read
at all. `src/lib/crypto/keys.ts:6` throws on a missing key, so the failure is loud — but no backup
recovers the plaintext.

The full inventory of every variable the application reads, with what breaks when each is missing, is
in DEPLOYMENT.md section 4.2.

---

## 6. Object storage

```bash
# Which backend is actually live? /admin/infra reports blob usage; in code:
#   src/lib/storage.ts -> storageBackend() returns 's3' | 'vercel-blob' | 'memory'
```

If it reports `memory`, **nothing is being stored at all** — uploads succeed and vanish on the next
serverless invocation, because neither `BLOB_READ_WRITE_TOKEN` nor the `S3_*` set is configured.
That is a data-loss bug, not a backup problem.

- **Vercel Blob:** enumerate and copy with `vercel blob ls` / the Blob API. `/admin/infra` shows the
  live object count and total size.
- **S3-compatible:** any S3 client works, since `src/lib/storage.ts` speaks the plain S3 API with no
  vendor SDK. Mirror the bucket on the same cadence as the database.

Note what is *not* at risk: the essential part of a recording — the ordered animation spec timeline —
lives in the kernel tables inside Postgres, not in blob storage. A full database dump already
contains it.

---

## 7. Cadence

Nothing below is automated. Every row is a human action. See "Not yet in place".

| Asset | Frequency | Retain | Trigger |
| --- | --- | --- | --- |
| Full database dump (section 4) | **Weekly**, and **before any schema-affecting deploy** | 8 weekly + 6 monthly | Founder, calendar reminder |
| Org-graph / workflow dump (section 3) | **Before every rollback stage**, without exception | Keep indefinitely — small files | ROLLBACK.md section 4 |
| Secrets inventory (section 5) | On every change, and reviewed **quarterly** | Current + previous | Any env-var change |
| Object storage mirror (section 6) | Weekly, alongside the database | 4 weeks | Founder |
| Schema-only dump (section 4) | Monthly | 12 | Founder |
| Restore drill (section 8) | **Quarterly** | Keep the notes | Founder |

Before any deploy that adds `NOT NULL`, `UNIQUE` or `CHECK` — the ROLLBACK.md 3.3 danger list — take
a fresh full dump first. Those are the changes a code rollback cannot undo.

---

## 8. Restore drill — a backup nobody has restored is a hypothesis

Quarterly, into a **throwaway** Supabase project or a local Postgres. Never into production, and
never with production's `DATABASE_URL` anywhere in the shell.

```bash
# 1. Create an empty target and export its connection string as PGTARGET.

# 2. Restore.
pg_restore --no-owner --no-acl --clean --if-exists \
  -d "$PGTARGET" ~/edurankai-backups/edurankai-full-<stamp>.dump

# 3. Prove it restored something real, not an empty shell.
psql "$PGTARGET" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
psql "$PGTARGET" -c "SELECT count(*) FROM users;"
psql "$PGTARGET" -c "SELECT count(*) FROM org_relationships;"
```

Then, the step that is usually skipped and is the whole point: **point a local dev server at the
restored database and load a page.** `npm run dev` with `DATABASE_URL` set to `$PGTARGET`, then open
`/admin/diagnostics` and confirm table presence and row counts look right.

Write down how long the whole drill took. That number is your actual recovery time, and it is the
only honest input to any recovery-time promise.

---

## Not yet in place

- **No automated backup of any kind.** There is no scheduled dump, no backup job in `vercel.json`,
  no GitHub Actions workflow that touches the database, and no script in this repository that takes
  one. Every dump in this document happens because a human remembered.
  *To fix:* the obstacle is that Vercel Hobby crons are daily-only and a serverless function is the
  wrong place to stream a multi-hundred-megabyte dump. The realistic path is a scheduled GitHub
  Actions workflow — the same free sub-daily scheduler already used by `imap-poll.yml` — running
  `pg_dump` against the session connection and pushing the artifact to object storage, with the
  connection string held as a repository secret. That is a real piece of work, not a config toggle.
- **No off-site copy.** Even manual dumps currently land on one machine.
  *To fix:* any encrypted off-site target. This is the cheapest item on the list and the one that
  turns a laptop failure from a catastrophe into an inconvenience.
- **Supabase's own retention is unconfirmed.** Nobody has written down what the current plan
  actually retains. Until someone opens the dashboard and records it here, assume **zero** provider
  backups and rely entirely on section 4.
- **No restore has ever been performed.** Section 8 has not been executed. The recovery time is
  unknown, and so is whether the dump restores cleanly at all.
- **No backup monitoring.** Nothing checks that a backup was taken, that it was non-empty, or that
  it is recent. A backup process that silently stopped six weeks ago looks exactly like one that is
  working.
