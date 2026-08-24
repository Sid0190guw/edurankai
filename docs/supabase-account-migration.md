# Moving the database to a new Supabase account

**I cannot run any of this.** `CLAUDE.md` forbids me opening a database connection or reading any
`.env*` file, and every step below needs live credentials. These are the commands for you to run.

The application side of this migration is unusually simple: the app talks to plain Postgres through
**one** environment variable, `DATABASE_URL` (`src/lib/db/index.ts:28`). It uses no Supabase SDK, no
Supabase Auth and no Supabase Storage — sign-in is this platform's own `users` table, and uploads go
to Vercel Blob / S3, not to the database. So nothing moves except Postgres itself, and exactly one
value changes afterwards.

---

## Read this first: do NOT rebuild the new database from `db/*.sql`

This is the one way this migration goes quietly wrong.

`src/lib/ensure-once.ts` makes every `ensureOnce()` / `ensureBatch()` bootstrap a **no-op when
`NODE_ENV=production`** (that default landed 2026-08-23 in `effb474b`). The live database was built
partly by those bootstraps back when they did run on the request path — so a large amount of the
schema exists **only** in the old database and in TypeScript, and in no `db/*.sql` file at all.

Today's sweep proved it with specifics: `hr_daily_report_revisions`, `hr_clock_out_checks` and
`training_certificates` are in no `db/*.sql`, and so are sixteen columns — seven on
`hr_clock_events` (`qr_station_id`, `qr_code_raw`, `source`, `face_verified`, `face_verify_method`,
`face_verify_outcome`, `face_verified_at`) that `punch()` writes on every clock-in, and nine on
`hr_daily_reports`. Those are only the ones one afternoon happened to look at. The live database is
around **258 tables**; `db/*.sql` declares a fraction of that.

**So: take a dump of the old database and restore it.** The dump carries everything, whoever created
it. Rebuilding from the repo's SQL would give you a database that looks fine on `/api/health` and
fails on the surfaces nobody tested that week.

---

## 0. The tools, on Windows, without admin

There was no PostgreSQL client on this machine and no Docker, and `winget install` wants elevation.
The client tools ship as a plain zip that needs neither:

```powershell
mkdir C:\Users\user\pgtools
curl.exe -sL -o C:\Users\user\pgtools\pg.zip `
  https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip
Expand-Archive C:\Users\user\pgtools\pg.zip -DestinationPath C:\Users\user\pgtools -Force
$env:PATH = 'C:\Users\user\pgtools\pgsql\bin;' + $env:PATH
psql --version   # psql (PostgreSQL) 17.6
```

Already done on 2026-08-24 — `psql`, `pg_dump` and `pg_restore` 17.6 are at
`C:\Users\user\pgtools\pgsql\bin`. The `$env:PATH` line is per-shell and has to be repeated in each
new terminal. A 17.x client dumps from a 15.x or 17.x server; the rule is client major ≥ server
major, never the reverse.

Two PowerShell notes, because this cost several rounds: `OLD="..."` is bash — PowerShell needs
`$OLD = "..."`; and `grep`, `tee` and `head` do not exist there, so use `Select-String`,
`Tee-Object` and `Select-Object -First`.

## 1. Get both connection strings — the SESSION POOLER, not the direct one

Corrected on 2026-08-24 after this failed in practice. The first version of this section said to use
the direct connection and avoid the pooler. That is the standard Postgres advice and it is wrong for
Supabase now.

**`db.<ref>.supabase.co` has no A record. It is IPv6 only.** Supabase moved direct IPv4 behind a
paid add-on, so on any IPv4-only machine or network every tool resolves nothing and reports it
confusingly:

```
psql: error: could not translate host name "db.<ref>.supabase.co" to address: Name or service not known
```

Measured on this machine: `Resolve-DnsName db.<ref>.supabase.co` returns AAAA
`2406:da12:...` and no A, and a TCP test to that address fails — there is no IPv6 route out. The
pooler host, by contrast, answers on IPv4.

**So use the Session pooler.** Supabase runs two, and the distinction is the one that matters:

| | port | holds a session | usable for `pg_dump` |
|---|---|---|---|
| Transaction pooler | 6543 | no | **no** |
| **Session pooler** | **5432** | **yes** | **yes** |

Only the *transaction* pooler breaks `pg_dump`. The session pooler is a full session and dumps
fine. The original warning conflated the two.

Copy both strings verbatim from **Settings → Database → Connection string → Session pooler** in each
project. Do not hand-build them: the username is `postgres.<PROJECT_REF>`, not `postgres`, and the
host carries a region and a generation prefix (`aws-0-…` on older projects, `aws-1-…` on newer) that
cannot be guessed. Guessing it returns a misleading error that looks like a credentials problem:

```
FATAL: (ENOTFOUND) tenant/user postgres.<ref> not found
```

That message means the pooler in *that region* has never heard of the project — wrong host, not
wrong password.

```
OLD=postgresql://postgres.<old-ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
NEW=postgresql://postgres.<new-ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
```

The app's own `DATABASE_URL` keeps using the **transaction** pooler (`:6543`) — that is correct for
short web requests and does not change.

## 2. Record what the old database has, so you can prove the new one matches

```bash
psql "$OLD" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
psql "$OLD" -Atc "SELECT table_name, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 25;"
```

Keep that output. It is the only thing that will tell you afterwards whether the restore was
complete, and "the site loads" is not the same fact.

## 3. Dump

```bash
pg_dump "$OLD" \
  --format=custom \
  --no-owner --no-privileges \
  --schema=public \
  --file=edurankai-$(date +%Y%m%d-%H%M).dump
```

`--no-owner --no-privileges` because the new project has different role names and you are not
migrating Supabase's internal roles. `--schema=public` because the app only ever touches `public`;
Supabase's own `auth`, `storage` and `extensions` schemas belong to the project, not to you, and
copying them across accounts causes more problems than it solves.

Check the file is a plausible size before going further. A dump that finished in four seconds did
not work.

## 4. Prepare the new database

```bash
psql "$NEW" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

`pg_trgm` is the only extension this schema needs (`db/hr-scale-indexes.sql:130`). `gen_random_uuid()`
— used by 373 defaults — is built into Postgres 13+ and needs nothing. There is no pgvector column
anywhere despite the word appearing in the tree; those are all `to_tsvector`, which is core.

## 5. Restore

```bash
pg_restore --dbname="$NEW" \
  --no-owner --no-privileges \
  --jobs=4 \
  edurankai-<stamp>.dump 2>&1 | tee restore.log
```

**Expect some errors and read them rather than ignoring them.** Restoring into a Supabase project
normally produces complaints about roles, comments on extensions, and objects it will not let you
own. Those are fine. What is not fine is any line naming a table, an index or a constraint:

```bash
grep -iE "error" restore.log | grep -viE "role|comment|extension|owner|privileg" | head -40
```

If that grep is empty, the restore did the work.

## 6. Verify BEFORE switching anything over

```bash
psql "$NEW" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

It must match step 2. Then spot-check the tables that carry the things you cannot re-derive:

```bash
psql "$NEW" -Atc "SELECT count(*) FROM users;"
psql "$NEW" -Atc "SELECT count(*) FROM hr_employees;"
psql "$NEW" -Atc "SELECT count(*) FROM applications;"
psql "$NEW" -Atc "SELECT count(*) FROM hr_clock_events;"
```

And confirm the columns the bootstrap can no longer create for you actually came across:

```bash
psql "$NEW" -Atc "SELECT count(*) FROM information_schema.columns
  WHERE table_name='hr_clock_events'
    AND column_name IN ('qr_station_id','qr_code_raw','source','face_verified',
                        'face_verify_method','face_verify_outcome','face_verified_at');"
-- expect 7

psql "$NEW" -Atc "SELECT to_regclass('public.hr_daily_report_revisions');"
-- expect hr_daily_report_revisions, not NULL
```

If either comes back short, run `db/attendance-clockout-tables.sql` against the new database — it is
idempotent and exists for exactly this case.

## 7. Switch over

1. Vercel → Project → **Settings → Environment Variables → `DATABASE_URL`**. Replace with the NEW
   project's **pooler** URI (`:6543`, `?pgbouncer=true` if the console gives you one).
2. Redeploy. An environment variable change does not take effect until a new deployment.
3. **Do not delete the old Supabase project yet.**

## 8. Prove it, on the live site

```bash
curl -s https://www.edurankai.in/api/health
```

You want `"status":"ok"`, `"database":{"ok":true,...}`, `"schemas":{"missingCount":0}`, and a
`release.commit` matching what you just deployed.

Then the burst, because a single request passing proves almost nothing here — this is the exact
check that found the connection ceiling on 2026-08-24:

```bash
for i in $(seq 1 12); do
  ( curl -s -o /dev/null -w "$i:%{http_code}:%{time_total}s\n" --max-time 40 \
      "https://www.edurankai.in/api/health?b=$i" ) &
done; wait
```

Twelve `200`s is a healthy pooler. Any `503` is the new project's connection limit, and the lever is
Supabase → Database → Connection pooling, not the pool numbers in `src/lib/db/index.ts` — those were
already lowered to `max:2` / `idle_timeout:15` on 2026-08-24 for this reason.

Sign in to `/admin` and open two or three pages before you call it done.

## 9. Only then

Keep the old project for at least a week, paused rather than deleted. Keep the `.dump` file
somewhere that is not your laptop.

---

## What does not need migrating

- **Sign-ins and passwords** — the `users` table, which the dump carries. No Supabase Auth is used.
- **Uploaded files** — Vercel Blob / S3, addressed by URL. Nothing in Supabase Storage.
- **Anything in the repo** — no code change is needed for this migration beyond the one environment
  variable, which is not in the repo.
