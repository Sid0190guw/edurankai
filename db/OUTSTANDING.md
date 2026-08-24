# What is not yet applied to production

There are 48 `.sql` files in this folder and no migration runner. This file records which of them
are **outstanding**, what the evidence for that is, and what each one unblocks — so the answer to
"is the database up to date?" is not a guess.

Written 2026-08-24. Every claim below was established **from outside the database**, by asking the
live site and reading what came back, because the working rules in `CLAUDE.md` forbid opening a
connection to production. That constraint is also why none of this is applied automatically: the
established pattern here is that migrations are handed over as a command.

---

## STATUS: nothing is outstanding (confirmed 2026-08-24, late)

All three sections below have since been run. Read live, not assumed:

```
/api/health              status=ok   schemas=51/51   columns=11/11
/api/careers/search      degraded=False   total=1017
/aquintutor/shared-progress/<any token>   "this link isn't active"  (not "could not be checked")
```

Both missing-counts are zero and the two behavioural tells have flipped. **This file is kept rather
than deleted**, because the three sections are the recipe for a database that does not have them —
a rebuild, a staging environment, a restore — and because the warnings under "Do NOT run these
blind" and "Do not mass-apply everything" are about the folder, not about today.

Each section keeps its evidence for how it was found missing. That is the part worth preserving: the
tell came from a `degraded` flag and a 500, and only became a number on `/api/health` after the
objects were added to its watch lists. **If you are checking this file to find out today's state, do
not trust the prose — run the three commands above.**

---

## 1. `db/xscale-schema.sql` — APPLIED

```bash
psql "$DATABASE_URL" -f db/xscale-schema.sql
```

**Evidence.** Confirmed by `/api/health` on 2026-08-24 once `divisions` and five of the `roles`
columns were added to its watch lists: `schemas.missingCount` rose by exactly 1 and
`columns.missingCount` by exactly 5 — every object this file creates that is monitored is absent.

It was first found the harder way, and that is worth keeping: `/api/careers/search` answered
`"degraded": true` to every query, including one with no filters at all. That flag is
`listOpportunities()` reporting that its real statement failed and the narrowed retry answered
instead — and the real statement joins `divisions`, which only this file creates. It now answers
`degraded=False` across all 1,017 postings, which is the same tell read the other way.

**What was broken until it ran.** The public careers search silently ignored its own division,
classification, scale-band and discipline filters: the result was *wider* than what was asked for,
and only the `degraded` flag said so. The Extreme-Scale department could not exist at all — the
`divisions` table lives only in this file and in an `ensure*()` that production suppresses.

**Read the file's own header before running it.** It explains why the indexes are built
`CONCURRENTLY`, and that `CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block** — so
pasting this file into a web SQL console fails on the first index and rolls back every `ALTER` above
it, reporting one error while the migration did nothing. If you have no `psql`, use the two split
files instead (`xscale-schema.paste-1-tables.sql`, then `xscale-schema.paste-2-indexes.sql` in a
quiet window). This is also step 1 of 3: the import and the per-division publish happen afterwards
on `/admin/roles/divisions`.

---

## 2. `db/aquintutor-share-schema.sql` — APPLIED

```bash
psql "$DATABASE_URL" -f db/aquintutor-share-schema.sql
```

**Evidence.** `/aquintutor/shared-progress/<token>` answered HTTP 500 to every token — three tried,
three 500s. `resolveShare()` reads `aq_progress_share` and nothing caught the throw. The page was
changed to degrade honestly instead of erroring, and then said "We could not check this link" —
which was the table reporting its own absence.

It now says **"this link isn't active"**, which is the page answering about the TOKEN rather than
about our schema. Those two sentences exist as separate states for exactly this reason: one is a
claim about the learner's choice, the other is a claim about us, and only one of them was ever true
at a time.

**What was broken until it ran.** Progress sharing: a learner could not mint a read-only link and a
parent or teacher could not open one.

---

## 3. One more registered module table — APPLIED

```bash
psql "$DATABASE_URL" -f db/application-invitations-schema.sql
```

**Evidence, and the reason this section reads oddly.** Mid-afternoon `/api/health` reported:

```
schemas: { ran: 48, expected: 51, missingCount: 3 }
columns: { present: 5, expected: 10, missingCount: 5 }
```

Two of those three tables and all five columns were sections 1 and 2. One was left over, and the
public endpoint gives a count rather than a name on purpose — a stranger does not need the inventory
of internal tables, and the name is on `/api/health/deep` or the `/admin/ops` bootstrap panel, both
behind an operator sign-in. It was inferred to be `application_invitations`, because that entry had
just been added to `BOOTSTRAP_MODULES` and its file was committed but unrun.

**Both counts are now zero**, so whichever it was, it is there.

### The thing to take from this section

The counts got *worse* before they got better — from `48/49` to `48/51`, and columns from `5/5` to
`5/10` — and nothing about the database changed in between. What changed is that `divisions`,
`aq_progress_share` and five `roles` columns were added to the health endpoint's watch lists.

Every one of them was already absent. The endpoint had simply never been asked about them, and a
table nothing asks about reads as health. If a migration ever looks like it made the numbers worse,
check whether something was added to the list before concluding anything about the database.

---

## Do NOT run these blind

Audited statement by statement; these mutate or destroy data and are not part of "bring the schema
up to date":

| File | Why |
|---|---|
| `org-graph-backfill.sql`, `org-graph-backfill-department-heads.sql` | `INSERT` into `org_relationships` — a data migration with intent |
| `talent-os-backfill.sql`, `workflow-backfill-leave.sql` | backfills |
| `backfill-xp-ledger.sql` | `UPDATE user_xp SET level = …` — recomputes people's levels |
| `roles-work-mode.sql` | `UPDATE roles SET location = …` — rewrites posting text |
| `unpaid-internships.sql` | `UPDATE roles SET salary = …` — rewrites stored pay text on every trainee row. Preview-only unless run with `-v apply=1`; read section 2 of its output first |
| `org-graph-rollback.sql`, `workflow-rollback.sql` | destructive by design |

`*-validate.sql` and `incident-2026-08-24-diagnostics.sql` are read-only and are useful **after** a
migration, not instead of one.

### An unresolved choice, not a missing migration

`talent-schema.sql` and `talent-os-schema.sql` are **two parallel recruitment/onboarding stacks**
(`tal_*` and `tos_*`). Applying both creates both. Which one this project keeps has not been decided,
and that decision is not one a migration runbook should make silently.

---

## Do not mass-apply everything

Thirty-odd of these files are pure, idempotent schema and re-running them is a no-op — so a single
"apply all" is tempting. Resist it. Roughly five hundred DDL statements in one go fires Supabase's
`pgrst_ddl_watch` event trigger on each one, and the resulting schema-cache reload storm is the
documented cause of a previous outage on this deployment. Apply what is outstanding, not everything
that exists.

---

## Afterwards, check the surface rather than the script

A green message from a script proves the script ran.

```bash
curl -s https://www.edurankai.in/api/health
```

- `schemas.missingCount` and `columns.missingCount` should both reach `0`
- `/api/careers/search` should stop answering `"degraded": true`
- `/aquintutor/shared-progress/<any token>` should say the link is not active, rather than that it
  could not be checked

`aq_progress_share`, `divisions` and five of the `roles` columns were added to the health endpoint's
watch lists on 2026-08-24 **because** each had to be proved missing the hard way. Expect the reported
counts to get worse before they get better: that is the endpoint becoming honest, not the database
getting worse.
