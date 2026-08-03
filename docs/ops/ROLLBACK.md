# ROLLBACK

Undoing a bad deploy on EduRankAI. Read section 0 before touching anything — the most common
rollback mistake on this stack is rolling back the wrong layer.

Companion documents: DEPLOYMENT.md (how a deploy happens), BACKUP.md (take a dump first),
INCIDENT.md (decide whether you even need this).

---

## 0. Three layers, three different actions. They do not undo together.

| Layer | Rolls back with | Actually reversible? |
| --- | --- | --- |
| **Code** | Vercel instant rollback, or `git revert` + push | Yes, in seconds. |
| **Environment variables** | Manual re-entry in the Vercel dashboard | Yes, but **not** by rolling back code. A Vercel rollback restores the old *build*, not the old *variables*. |
| **Database schema** | Nothing automatic. Ever. | **No.** See section 3. This is the one that hurts. |

Ask, out loud, before you start: *did the bad deploy write to the database?* If it created a table,
added a column, added an index, or ran a backfill, rolling back the code leaves all of that in
place. Sometimes that is harmless. Sometimes it is the actual outage.

---

## 1. Fastest safe action: Vercel instant rollback

This re-points production at a previous, already-built deployment. No rebuild, no queue, and it does
**not** consume one of the 100 daily deploys.

```bash
cd /c/Users/user/Projects/edurankai-phase36

vercel whoami                       # confirm you are on the right account
vercel ls                           # deployments newest-first: URL, state, target, age
vercel inspect <bad-deployment-url> # confirm which commit is currently serving

# Option A — roll back to the immediately previous production deployment:
vercel rollback

# Option B — promote a specific known-good deployment:
vercel promote <good-deployment-url>
```

Then verify, using DEPLOYMENT.md section 6. Specifically:

```bash
curl -s https://edurankai.in/api/health | head -c 300     # release.shortCommit should be the OLD sha
# or, if /api/health is not deployed:
curl -s -o /dev/null -w '%{http_code}\n' https://edurankai.in/<route-only-the-bad-deploy-added>
#   -> 404 means the bad code is genuinely gone
```

**What a Vercel rollback does not do:**

- It does not change environment variables. If the incident was a bad variable, roll the variable
  back by hand and then **redeploy** — remember that `import.meta.env` readers are frozen at build
  time (DEPLOYMENT.md 4.1), so a variable change alone changes nothing for them.
- It does not touch the database. See section 3.
- It does not change `main`. The next push to `main` re-deploys the bad code unless you also fix git.
  **Always follow a Vercel rollback with section 2 or a real fix**, or the next unrelated push
  silently re-ships the outage.

---

## 2. Reverting the commit

Vercel rollback buys time. Git is what makes it stick.

```bash
cd /c/Users/user/Projects/edurankai-phase36
git fetch origin

# Identify the bad commit:
git log --oneline -15 origin/main

# Revert it, keeping history honest (never force-push main):
git revert <bad-sha>                      # a single commit
git revert <oldest-bad-sha>^..<newest-bad-sha>   # a contiguous range

git push origin main
```

Constraints that apply here specifically:

- **Never `git push --force` to `main`.** Vercel builds what is on the branch; rewriting the branch
  under a running deployment makes the deployed SHA unresolvable in `vercel inspect`, which removes
  the only reliable way to tell what is live.
- **Every revert push is a deploy.** Against a 100/day Hobby ceiling. If Vercel replies
  `Resource is limited`, stop and tell the founder — retrying burns the same budget.
- **A merge commit needs `-m 1`:** `git revert -m 1 <merge-sha>`.
- Reverting a commit that added a self-bootstrapping `CREATE TABLE` / `ADD COLUMN` **does not remove
  the table or the column.** Go to section 3.

---

## 3. The hard case: self-bootstrapping DDL is forward-only

### 3.1 What this project actually does

There is no migration runner. No `migrations/` directory, no version table, no `drizzle-kit migrate`
in the deploy path. Schema changes ship as DDL embedded in application modules and executed on first
use:

```bash
cd /c/Users/user/Projects/edurankai-phase36
grep -rhoE "CREATE TABLE IF NOT EXISTS [a-z_0-9]+" src/ | sed 's/.*EXISTS //' | sort -u | wc -l
#   -> 343 distinct self-bootstrapped tables
grep -rhoE "ADD COLUMN IF NOT EXISTS [a-z_0-9]+" src/ | wc -l
#   -> 548 add-column statements, across 82 files
```

The execution mechanism is `src/lib/ensure-once.ts`: each module memoises its DDL promise **per
server process**. On Vercel that means per cold start. The practical consequence:

> **The moment the new code serves a single request that touches the module, the schema change is
> permanent.** There is no window in which the deploy is live but the DDL has not run.

`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` has no counterpart in this system. Nothing anywhere drops
a column. `IF NOT EXISTS` means "make sure it is there", never "put it back the way it was".

### 3.2 Say it plainly

**Rolling back CODE does not roll back SCHEMA.** After a Vercel rollback the previous build is
serving against a database that has moved on. The old code does not know the new column exists.

### 3.3 When that is harmless, and when it is the outage

Harmless in the common case: a new **nullable** column with no constraint. The old code never
mentions it, `INSERT` omits it, it stays NULL, nothing notices. Most of the 548 add-columns in this
repo are exactly this.

Dangerous, in rough order of how fast it takes the site down:

| What the forward deploy added | Why the rolled-back code breaks |
| --- | --- |
| A column that is `NOT NULL` **without** a default | Old code's `INSERT` omits it. **Every write to that table fails.** |
| A `UNIQUE` index or constraint | Old code that tolerated duplicates starts throwing `duplicate key value violates unique constraint`. |
| A `CHECK` constraint | Old code writes a value the new rule rejects. |
| A changed column `DEFAULT` | Rows written by old code silently get the new default. Not an error — a data-correctness bug you find weeks later. |
| A renamed column (add-new + backfill) | Old code reads the **old** column, which is now stale. Reads succeed and are wrong. Worse than an error. |
| A new enum value written by forward code | Old code's exhaustive `switch` / mapper hits a value it has no case for. |
| A new table the old code does not create | Harmless. It simply sits unused. |

### 3.4 Find out which case you are in, before you roll back

```bash
cd /c/Users/user/Projects/edurankai-phase36

# Every schema statement introduced between the known-good commit and the bad one:
git diff <good-sha>..<bad-sha> -- src/ \
  | grep -nE "^\+.*(ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX|ALTER TABLE|NOT NULL|DEFAULT |CHECK \(|DROP )"

# And any raw SQL files that shipped alongside:
git diff --stat <good-sha>..<bad-sha> -- db/
```

Read the output against the table in 3.3. If every added line is a plain nullable `ADD COLUMN`, roll
the code back and move on. If any line is `NOT NULL`, `UNIQUE`, or `CHECK`, **the code rollback is
not sufficient** and you need section 3.5.

### 3.5 If the schema genuinely has to be undone

1. **Take a dump first.** BACKUP.md section 3. A dropped column is not recoverable from anything
   else, and there is no automated backup in this repository.
2. **Write the SQL, do not run it.** The rule on this project — established for migrations and
   applying equally to reads — is that database statements are handed to the founder to execute.
   No agent, no script in `.dev-scripts/`, no scratch `postgres()` client.
3. Hand over something like this, spelled out, with the table and column named explicitly:

   ```sql
   -- Roll back <bad-sha>. Run AFTER the pg_dump in BACKUP.md section 3 has completed
   -- and you have verified the dump file is non-empty.
   BEGIN;
   ALTER TABLE <table> DROP COLUMN IF EXISTS <column>;
   COMMIT;
   ```

4. Prefer **neutralising over dropping** whenever the deadline allows. Dropping a column destroys
   data; making it nullable does not:

   ```sql
   ALTER TABLE <table> ALTER COLUMN <column> DROP NOT NULL;
   DROP INDEX IF EXISTS <the_new_unique_index>;
   ```

   This unblocks the old code immediately and leaves the option of rolling forward again.

### 3.6 Prefer rolling forward

For anything schema-shaped, a small fix-forward commit is usually faster, safer and cheaper than
untangling a rollback: it costs one deploy, it destroys no data, and it leaves the schema and the
code in agreement. Roll back when the deploy is *serving wrong content or failing outright*; roll
forward when the deploy *made the database disagree with the code*.

---

## 4. Org-graph and workflow rollbacks (pre-written, staged, founder-run)

Two subsystems ship their own rollback SQL. Both are deliberately awkward to execute.

```
db/org-graph-rollback.sql      3 stages
db/workflow-rollback.sql
db/org-graph-validate.sql      read-only: counts, orphans, cycles, overlaps, drift
db/workflow-validate.sql       read-only
```

Every stage of `db/org-graph-rollback.sql` is wrapped in a `DO $$ ... $$` block guarded by
`confirm boolean := FALSE;`. **Copy-pasting the whole file executes nothing.** To run one stage you
edit that single line to `TRUE` and execute that block alone. The guard exists because a rollback
file gets opened during an incident, by somebody in a hurry, and the natural thing to do with a
`.sql` file in a hurry is run all of it.

| Stage | Effect | Reversible |
| --- | --- | --- |
| 1 | Deletes only rows the backfill inserted, identified by their `note` stamp. Hand-entered edges survive. | Yes — re-run `db/org-graph-backfill.sql`. |
| 2 | Empties the graph. Tables and indexes stay. | **No.** Hand-entered relationships are gone without a restore. |
| 3 | Drops `org_relationships`, `org_teams`, `org_positions`, `org_employee_assignments`. | **No.** Drops the only record of who reported to whom, and when. |

**Before any stage, and unconditionally before stage 2 or 3: run the org-graph `pg_dump` in
BACKUP.md section 3.** Verify the dump file is non-empty before you proceed.

What makes all three stages considerable at all: nothing in the application imports
`src/lib/org-graph.ts` yet, every resolver in it fails closed (a missing table is caught and answered
as "no relationship", never as "yes"), and `hr_employees.reporting_manager_id` is never touched by
any of it. The old system was never switched off — that is the property that makes the phase
reversible.

Run `db/org-graph-validate.sql` (read-only) **before and after** any stage, and keep both outputs.

---

## 5. Secrets: what must never be rolled back casually

Rotating or reverting one of these is not a config change. It is a data-availability event.

| Variable | What happens if you change or lose it |
| --- | --- |
| `DATA_ENCRYPTION_KEY_<keyId>` | **Ciphertext encrypted under that key becomes permanently unreadable.** `src/lib/crypto/keys.ts:6` throws on a missing or wrong-length key; only lifecycle metadata is in Postgres, the material is env-only. Losing it is unrecoverable by any backup of the database. |
| `ACTIVE_DATA_KEY_ID` | Changes which key new ciphertext is written under. Old rows still need the **old** key present. Never remove a retired key's variable. |
| `ACTIVITY_ENC_KEY` (or `SESSION_SECRET`, which it falls back to) | The AES key is `sha256(ACTIVITY_ENC_KEY ?? SESSION_SECRET ?? literal)` (`src/lib/activity-log.ts:47`). Changing **either** silently makes previously written `activity_events` rows undecryptable. |
| `CREDENTIAL_SIGNING_SECRET` | Previously issued credentials stop verifying. |
| `CALENDAR_TOKEN_SECRET` | Every subscribed calendar feed URL breaks at once. |
| `API_EMBED_SECRET` | Every issued embed key stops validating. |
| `SESSION_COOKIE_NAME` | **Signs every user out immediately** — the browser's cookie has the old name. |

Two precise non-facts, so nobody over-reacts:

- **Rotating `SESSION_SECRET` does not sign anyone out.** Session IDs are `sha256(token)`
  (`src/lib/auth/session.ts`), with no secret involved. It *does* change the four derived values
  above, which is the real reason to be careful with it.
- **A trailing space in `SESSION_COOKIE_NAME` is survivable.** `src/lib/auth/cookie.ts:18` trims it,
  and an otherwise-invalid name logs and falls back to `edurankai_session` rather than throwing at
  login. `CRON_SECRET` has no such protection — see DEPLOYMENT.md 4.4.

---

## 6. Verify the rollback, with the same rigour as a deploy

A rollback is a deploy. Reported success and observable result are not the same thing.

```bash
# 1. What is serving?
vercel ls
vercel inspect <production-url>

# 2. Which commit does the app say it is?
curl -s https://edurankai.in/api/health | head -c 300

# 3. Does the bad behaviour actually stop? Reproduce the exact failing request.
curl -s -o /dev/null -w '%{http_code}\n' https://edurankai.in/<the-url-that-was-failing>

# 4. Did errors stop arriving, or just stop being looked at?
#    Sign in and open /admin/hardening -> "Recent errors". Watch for two minutes.
#    New rows with the same message = the rollback did not take.

# 5. If anything is still wrong, read the logs before theorising:
vercel inspect <production-url> --logs
```

Write down, in the incident notes: the bad SHA, the SHA you rolled back to, whether any DDL was left
behind, and whether any environment variable was changed. The next person needs all four.

---

## Not yet in place

- **No schema-version record.** Nothing tracks which DDL has run against production. The nearest
  thing is `BOOTSTRAP_MODULES` in `src/lib/observability-health.ts`, which checks
  `information_schema` for ten known tables — a spot check, not an inventory of 343.
  *To fix:* a `schema_applied` table written by `ensureOnce`, keyed by the module's ensure key.
- **No automated pre-rollback backup.** Section 3.5 step 1 depends on a human running `pg_dump`.
  `pg_dump` is not even on `PATH` on the current workstation (BACKUP.md section 2).
  *To fix:* a scheduled dump to off-site storage; then this step becomes "confirm last night's dump
  exists" instead of "take one now, under pressure".
- **No drop-column tooling or convention.** Nothing in the codebase has ever removed a column, so
  there is no reviewed pattern for doing it safely. Treat every such request as bespoke, hand it to
  the founder, and dump first.
- **No rehearsal.** No rollback of this system has been practised end to end. The first execution of
  section 3.5 will be the first time anyone has done it.
