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

## 1. Get both connection strings — the DIRECT one, not the pooler

In each Supabase project: **Settings → Database → Connection string → URI**.

You need the **direct connection on port 5432**, not the transaction pooler on **6543**.
`pg_dump` and `pg_restore` hold session state and use prepared statements; a transaction pooler
gives neither, and the dump will fail partway or, worse, come back short.

```
OLD=postgresql://postgres:<pw>@db.<old-ref>.supabase.co:5432/postgres
NEW=postgresql://postgres:<pw>@db.<new-ref>.supabase.co:5432/postgres
```

The app keeps using the **pooler** URL (`:6543`) in `DATABASE_URL` — that part does not change.

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
