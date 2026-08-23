# The employee portal, audited for a workforce of one crore

*Audit and remediation pass, 2026-08-23. Scope: `/portal/employee` (39 routes) and everything under
`src/lib/workforce`, `src/lib/auth/workspace-access.ts` and the `hr_*` reads they reach.*

---

## The one thing to do before this ships

```
psql "$DATABASE_URL" -f db/hr-scale-indexes.sql
```

The application half of every scale fix below is committed. The database half is not, and cannot be:
this project's working rules forbid the assistant from opening a connection to production, and
migrations here have always been handed over as a command. **Without that file the code changes are
correct but roughly half as effective** — the casts that were hiding the indexes are gone, and on
`hr_employees.reporting_manager_id`, the three e-mail columns and the name search there is still no
index for them to find.

Read the header of `db/hr-scale-indexes.sql` before running it. It uses `CREATE INDEX CONCURRENTLY`,
which cannot run inside a transaction block; `psql -f` is fine, a migration runner that wraps files
in `BEGIN/COMMIT` is not.

---

## What the audit found

### Not found: the things the brief expected

Worth stating plainly, because it changes where the effort went.

| Looked for | Found |
| --- | --- |
| Type errors in the portal | **None.** `astro check` reports zero across all 39 routes and the workforce libraries. |
| Stubs, "coming soon", dead buttons | **None.** Every `placeholder=` hit is a real HTML input placeholder. Every page reads real tables and writes real rows. |
| Broken navigation | **None.** All 64 hrefs in the workforce navigation registry resolve to a real route, and every page under `/portal/employee` has at least one inbound link. |
| `r.rows[0]` misuse | **None** in the portal. |
| Swallowed exceptions in a sign-in path | **None** in the portal. |

The portal is not half-built. What it is, is built for a company of a few hundred people, in a way
that stops working somewhere between ten thousand and a hundred thousand — and one identity lookup
that is wrong at any size.

---

## 1. The scale defects

Every item here is a read that a real person triggers on a real page, and every one of them was a
sequential scan of a table that grows with the headcount.

### 1.1 `::text` casts on indexed uuid columns — **the big one**

`WHERE employee_id::text = $1` puts the cast on the **column**. No btree index can answer that, so
Postgres reads the table. The form was written more than a hundred times across `src/lib`, and the
hot ones were all on the workspace home page.

| Where | Table it scanned | Grows with |
| --- | --- | --- |
| `attendanceMonth()` — "days recorded this month" | `hr_attendance` | headcount **×** working days |
| `employeeFilter()` — every personal query in the portal | every `hr_*` table | headcount × time |
| `readDayAndManager()` — the direct-report count | `hr_employees` | headcount |
| `directReportsFor()` | `hr_employees` | headcount |
| `departmentFilter()` — every department-scoped list | `hr_employees` | headcount |

At one crore staff, `hr_attendance` gains roughly 2.5 billion rows a year. That card was reading all
of them, on the most-rendered authenticated screen in the product, on a phone.

**Fixed** by `idEq()` in [`src/lib/workforce/scale.ts`](../src/lib/workforce/scale.ts). The cast was
there for a real reason — `$1::uuid` throws on a malformed id, and `departments.id` may legitimately
be a slug — and that reason is kept: `idEq()` validates the shape in JavaScript and *then* emits the
plain, index-usable comparison, falling back to the old text form only for a value that is genuinely
not a uuid. Same rows, different plan.

### 1.2 `COUNT(*) OVER ()` riding on a `LIMIT 8`

A window function is evaluated **above** the scan and **below** the limit. So

```sql
SELECT id, full_name, COUNT(*) OVER ()::int AS total
  FROM hr_employees WHERE department_id::text = $1 AND is_active
 ORDER BY full_name LIMIT 8
```

finds and counts *every* person in the department in order to print eight names and a total. On a
department of eighty thousand that is eighty thousand rows per render.

**Fixed** in `directReportsFor()` and `departmentRoster()`: fetch `cap + 1` rows (the extra row is
the whole answer to "is there more"), and only when there *is* more, run `countUpTo()` — a count
that stops at a ceiling. Past the ceiling the number is a floor, and `PeopleView.moreAtLeast` says
so, so a screen can print "500+" and mean it instead of an exact total nobody reads.

### 1.3 Twenty-one sequential round trips on the workspace home page

`src/pages/portal/employee.astro` loaded every widget as `let x = …; if (gate) { try { x = await
read() } catch {} }`, one after another. Twenty-one independent questions, each waiting for the
previous answer. `src/lib/db/index.ts` sizes the pool at `max: 1` per instance and its own comment
measures the warm cross-region round trip at **~177 ms** — so this page spent multiple seconds doing
nothing but waiting.

**Fixed**: the blocks are now pushed into a `batch` array and awaited once. postgres-js pipelines on
a single connection, so twenty-one serial waits collapse into roughly one, and the connection is held
for a fraction of the time. Two reads genuinely depend on a first-wave answer (the work-mode prefill
needs the clock position; task activity needs the open tasks) and run in a second, two-member batch.
Everything computed *from* the results moved below the barrier into one clearly-marked section.

Nothing about what is read, or about any gate, changed.

### 1.4 DDL on the request path

`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS …` is a no-op when the column exists — but it
still takes an **ACCESS EXCLUSIVE lock** on the table to decide that, blocking every reader and
writer for the duration. `ensureOnce()` memoizes per process, and on serverless "per process" means
"per cold instance". At scale that is hundreds of exclusive-lock requests a minute against the table
every authenticated page load reads first. The symptom is not an error; it is a portal that
intermittently takes seconds to load for a reason that never appears in the query log.

**Fixed**: the bootstrap now asks `information_schema` / `to_regclass` first — an ordinary read that
takes no lock on `hr_employees` at all — and runs the DDL only when something is genuinely missing.
The self-heal is kept, because a fresh environment that has never had `db/hr-schema.sql` applied must
still come up; a provisioned database simply stops paying for it.

### 1.5 Unindexed substring search over people

`src/lib/search-global.ts` matches names with `col ILIKE '%term%'`. An unanchored pattern cannot use
a btree index at all. **Not changed in code**, deliberately — narrowing it to a prefix match would
quietly take away behaviour people rely on (searching the second half of a double-barrelled surname).
`db/hr-scale-indexes.sql` installs the `pg_trgm` GIN indexes that make it answerable. The new
directory page *detects* whether those exist and says so on screen rather than being mysteriously
slow.

### 1.6 One lookup per request instead of three or four

`lookupWorkspace()` is now memoized per request, keyed on the `Astro.locals.user` **object** — which
`src/middleware.ts` rebuilds from a fresh `SELECT` on every request, so the key is unique per request
by construction and an HR edit is visible on the very next page load. A single render used to reach
it through `composeWorkspace()` and again through every self-service helper on the page.

---

## 2. The correctness defect — and it is the serious one

Nine pages under `/portal/employee` each opened with their own copy of the employee lookup:

```sql
SELECT … FROM hr_employees WHERE user_id = $1 AND is_active LIMIT 1
-- and if that missed --
SELECT … FROM hr_employees
 WHERE (work_email = $2 OR personal_email = $2 OR email = $2) AND is_active LIMIT 1
```

Written independently, in good faith, and wrong three ways.

**It was case-sensitive.** The canonical resolver in `workspace-access.ts` compares `lower()` to
`lower()` and says why in its own comment. A record typed `Priya.S@…` against an account spelled
`priya.s@…` is the same person on the workspace home page and "no employee record" on nine others.

**It picked where it should have refused.** None of the three e-mail columns carries a unique
constraint. `requireEmployee()` takes `LIMIT 2` precisely so it can *detect* two records under one
address and refuse; its comment spells out the consequence — *"quietly hand whoever signs in first
the other person's hours, leave, reviews, documents and credit position"*. The nine copies had no
such check. **`/portal/employee/wallet` was the worst of them**: it read the matched row with
`SELECT *` — `pan_number`, `aadhaar_number`, `bank_account_number`, `bank_ifsc`, `base_salary` — to
use exactly two fields, and would open one person's wallet, bank accounts and withdrawal history to
another. A shared inbox typed into `email` on two records is all it took.

**It was two sequential scans per page load** for anybody whose `user_id` link was never backfilled.

**Fixed** by [`src/lib/workforce/identity.ts`](../src/lib/workforce/identity.ts) —
`resolveEmployeeIdentity()`, a thin wrapper over `requireEmployee()` plus the two or three extra
columns those pages render. All nine pages now go through it. Each of them also renders the *gate's*
sentence for a denial, so "no record is linked", "more than one record uses your address", "your
record is closed" and "the read did not complete" are four different sentences rather than one line
sending three people out of four to ask HR about the wrong thing.

---

## 3. The layout

### What was actually wrong

The portal had **three hand-written page shells**, and which one you got depended on which page you
opened:

| | Family A | Family B | The stragglers |
| --- | --- | --- | --- |
| pages | 14 | 17 | 3 |
| header | `<header class="topbar">` + tabs | `<nav class="top">` back-link | `<div class="top">` |
| palette | `#F8F8F6` / `#1B1813` / `#FDFDFC` | `#f6f4ef` / `#1a1510` / `#fff` | Family B's |
| back control | **none** — a tab was the only way out | yes | yes |
| tab title | consistently `... - EduRankAI` | half with the suffix, half without | none |
| `<h1>` | present | **absent on 14 of 16** | present |

Not one of the 34 used a shared component. Each wrote its own `<!doctype html>`, its own `<head>`,
and a `<style>` block of 22-109 lines — the same handful of ideas, re-typed, and drifted:

- the back link said **"Workspace"** on some pages and **"My HR"** on others — one destination, two
  names, so the product appeared to have two homes;
- `.card h3` was `#6b6255` on most pages and `#9a8f7d` on payslips;
- `.wrap` was 560 / 600 / 620 / 640 / 680 / 720 / 760 / 860 px depending on which page was copied;
- `padding-bottom` was 40, 48, 56 or 96;
- the tab control had **five separate implementations** — `.tab`, `.tabs a`, `.tabs a.on` — with pill
  heights of 36, 38 and 44px and three different selected colours;
- two pages set `data-theme="light"`; thirty-two did not;
- `overflow-x:hidden` was present on some and absent on others, making sideways scroll on a 360px
  phone a per-page accident;
- **no page respected `env(safe-area-inset-top)`**, so every sticky bar sat under the notch.

### What was done — all 34 pages, one shell

[`src/components/workforce/EmployeeShell.astro`](../src/components/workforce/EmployeeShell.astro)
owns the document: doctype, head, viewport, favicon, title, `noindex`, the reset, the body base, the
sticky bar, the tab strip, the column, and the palette. **Every page under `/portal/employee` that
used to write its own document now renders into it** — 14 + 17 + 3, plus the new directory. There is
no `<!doctype html>` left anywhere under that route.

**One header.** Family A's stacked `topbar` is gone; every page carries the same bar — back control,
page name, person. Those 14 pages gain a back control they never had: the only way out of Timesheet
used to be to pick another tab.

**One tab strip.** The five implementations are one `.tab` control in the shell. The strip moved
*inside* the column, so the tabs line up with the cards they switch between instead of hanging off
the viewport edge while the content was inset. `expenses.astro` marked its selected tab with
`class="on"` and nothing else — no `aria-current` at all — so assistive technology could not say
which of the five kinds was current, and neither could anybody who cannot tell the two shades apart.
It now carries `aria-current="page"`, which is also what the shared styling keys off, so the marker
and the appearance can no longer disagree.

**One palette, as tokens.** The `--emp-*` custom properties in the shell are the whole palette.
Family B's paper/ink/rust values won, because that is this product's design language and Family A's
`#F8F8F6` was a near-miss of the same idea. Every page's CSS now names a token instead of a hex —
651 hex literals across the 14 Family A files, and the equivalent in Family B — so the next palette
decision is one edit rather than thirty-four. For Family B the token values are **identical** to the
literals they replaced, so that half is a rename and not a repaint.

**One title rule.** Every tab now reads `<page> · EduRankAI`.

**One `<h1>` per page**, and 14 pages had none at all — a screen-reader user landing on
`/portal/employee/payslips` had no heading to orient by and the heading shortcut found nothing. The
bar already showed the page name; it was marked up as decoration. `knowledge.astro`'s article title
and the three stragglers' in-page headings were demoted to `<h2>` so there is still exactly one.

**One column rule.** `--emp-width` is set per page on `<body>`, so the eight different `.wrap` widths
are one rule with a parameter. Every page passes the width it already had.

**The notch, and `noindex`.** The bar now respects `env(safe-area-inset-top)` and the column respects
the left and right insets. Every one of these routes is somebody's own record, and each page used to
be responsible for remembering `noindex` on its own — about half did.

### What is deliberately still on BaseLayout

`onboarding`, `delegation`, `security` and `mail` render through `BaseLayout` rather than writing
their own document, so they were never part of the problem this fixes. `mail` is a full-screen dark
mail client and says so in its own header. The other three are ordinary site-layout pages. Moving
them onto the portal shell would be a restyle of their content, not a consolidation, and that is not
what this pass was for.

## 4. What was added

### `/portal/employee/directory` — a people directory that pages

"Who is this person and which department are they in" is the most-asked question in a workforce of
size, and the product had no answer shaped like a list. `/portal/search` gives eight hits with no
paging; `/portal/organization` draws a tree.

- **Keyset paging, never `OFFSET`.** `LIMIT 25 OFFSET 22475` reads 22,500 rows to show 25, and page
  900 is exactly where the surnames beginning with S live. The cursor is `(full_name, id)` — the id
  tie-break is required, because at this headcount thousands of people share an exact name and a
  boundary without it repeats or skips somebody on every load.
- **Ceilinged count.** "500+", not an exact total that would cost a full scan of the scope.
- **It adds no scope.** `resolveOrgViewerScope()` — the same function `/portal/organization` and
  `/portal/search` both use — decides who is visible, to the row. A directory is the most tempting
  place in a workforce product to widen a scope by accident, because "a directory should obviously
  show everyone" sounds like a requirement and is a policy decision. It was not taken here.
- **It adds no columns.** Name, job title, employee code, department. No e-mail, no phone, no pay, no
  government id.
- It tells you on screen when the `pg_trgm` indexes are missing, rather than just being slow.

Registered in the workforce navigation registry, so it appears in the workspace drawer for anybody
with an employee record.

### `src/lib/workforce/scale.ts` — the primitives, with tests

`idEq` / `idIn` (index-usable id comparison), `countUpTo` / `countLabel` (bounded counting),
`probeMore` (cap+1 instead of a count), `keysetAfter` / `encodeCursor` / `decodeCursor` (paging),
`prefixPattern` / `containsPattern` (escaped LIKE).

26 tests in `src/lib/workforce/scale.test.ts`, and they assert on the **shape of the generated SQL**,
not on the result — because the failure this module prevents is a query that returns the right rows
by the wrong plan, which no ordinary test can see. A regression that puts `::text` back would pass
every other test in this repository.

---

## 4a. What a second pass over this work then found

The change above was verified again before hand-off, mechanically rather than by re-reading it. Four
things it found, all now fixed — recorded because each is a defect the first pass introduced or left,
and a reviewer should know the review works.

**Six pages resolved through the gate and threw its sentence away.** `benefits`, `loans`, `expenses`,
`payslips`, `support` and `referrals` each printed one hard-coded *"this account is not linked to an
employee record"* for every reason the gate can refuse. That is precisely the defect §2 set out to
remove, still standing on six pages because their resolver returns the denial and nothing
destructured it. `support` was the worst: its branch was a bare `{!employee && …}` with no failed-read
arm at all, so a database that did not answer rendered as a definite claim that this person has no
employee record — and they would go and ask the desk to fix a link that already existed.

**`resolveEmployeeIdentity()` ran a query it did not need.** It fetched `currency` with a second
`SELECT` on every one of the nine pages that use it, including the six that never render an amount —
a round trip per page load for a column the gate had *already selected the row for*. `currency` now
rides on `EMPLOYEE_COLUMNS` in `workspace-access.ts`, so it costs nothing. That is the same mistake
this whole pass exists to remove, at a smaller scale: a read that looks free because it is one
statement, multiplied by every page and every person.

**Two indexes in `db/hr-scale-indexes.sql` stopped one column short of the query.** Rendering the SQL
the new code actually emits — rather than reading the code and assuming — showed the directory pages
by `(full_name, id)` while the index was `(department_id, full_name)`. Without `id` the planner seeks
to the right department and the right name and *then sorts to break ties*, and at this headcount ties
are not hypothetical. The index is now `(department_id, full_name, id)`, and a second one on
`(full_name, id)` was added for the whole-directory ordering an `employee.manage` holder gets, which
the department index cannot serve at all — a composite is only usable from its leading column.

**Nothing else.** Three mechanical checks came back clean and are worth naming because they are the
defects this shape of change is prone to:

| Check | Result |
| --- | --- |
| A class used in markup with no rule left anywhere after the CSS strip | **0** across all 35 pages |
| A batched read that depends on another batched read's result | **0** — 21 wave-1 blocks, 2 wave-2, no crossing |
| A derivation left above the barrier reading a batched result | **0** |
| A `--emp-*` token referenced but not defined | **0** |
| A write, or an unguarded block, inside the batch | **0** |

The first version of the orphan scan reported a confident clean bill that was worthless: its regex
matched the literal `<style>` inside a frontmatter *comment* and swallowed the whole file, so every
JS property access counted as a declared class. It is recorded here because a green check from a
broken checker is the exact failure mode this project's working rules warn about — reported success
and observable result are not the same thing.

---

## 5. Verification

| Gate | Result |
| --- | --- |
| `npx astro check` | **0 errors** |
| `node scripts/typecheck-ratchet.mjs` | passes — no new type errors |
| `node scripts/lint-mail.mjs` | clean |
| `npm run build` | passes |
| SQL rendering (`PgDialect.sqlToQuery`) | every statement the new code builds renders as valid Postgres, with the id predicates index-shaped and the fail-closed paths emitting a literal `false` |
| `npm test` | 2720 passed, 1 failed — `deployment-readiness`, on a `WELLNESS_COUNSELLOR_EMAIL` env check against another session's in-flight edit to `src/lib/deployment-readiness.ts`. Nothing in this work touches wellness or environment variables. |

Structural checks after the migration:

- no file under `/portal/employee` contains `<!doctype html>`, `class="topbar"` or `<div class="top">`
- zero Family A hex literals remain (`#F8F8F6`, `#1B1813`, `#FDFDFC`, `#DFDCD8`, `#564E43`, `#70685C`)
- every `<nav class="tabs">` child carries `class="tab"`
- all 35 routes open and close their `<EmployeeShell>`

**Not verified: the rendered pages.** There is no browser in this environment, so the migration was
checked by build, by typecheck and by reading the diff — not by looking at it. The visual deltas are
specific, and these are the ones to glance at once it is pushed:

- **the 14 tabbed pages** (`/portal/employee/timesheet`, `/attendance`, `/credits`, `/schedule`,
  `/evidence`, `/calendar`, `/internship`) — they now have the dark bar and a back control, the tab
  strip sits inside the column, and the palette is paper rather than the old off-white
- `/portal/employee/expenses` — the claim-kind tabs are a `<nav>` with `aria-current`
- `/portal/employee/payslips`, `/wallet` — the bar reads **Workspace**, not My HR
- `/portal/employee/procurement`, `/profile`, `/projects` — the trailing link on the right of the bar
  still goes where it did
- `/portal/employee/projects/<id>` — back still says **Projects**
- `/portal/employee/contract`, `/reports`, `/reports/team` — one heading, not two
- `/portal/employee/calendar`, `/attendance/corrections`, `/attendance/roster` — their old header
  subtitle is now a standfirst under the tabs
- any of them on a notched phone — the bar should clear the status bar
- `/portal/employee/directory` — the new page

Nothing is live until `git push origin main`.

## 6. Follow-ups, in order

1. **Run `db/hr-scale-indexes.sql`.** Everything in §1 is half-effective without it.
2. **The remaining `::text = $` casts.** About 140 outside the employee portal — `src/lib/hr-leave.ts`,
   `hr-lifecycle.ts`, `hr-wallet.ts`, `attendance.ts`, and the admin HR screens. Each is the same
   defect and each is a one-line `idEq()` substitution. They were left out of this pass because they
   are not on the employee-portal read path and each one deserves its own verification.
3. **The remaining per-page component CSS.** The shell owns the document, the chrome and the
   palette; each page still carries its own `.card`, `.field` and button rules. They all draw from
   the same tokens now, so they look like one design, but the rule text is still duplicated. Merging
   them needs judgement rather than a script: `.row` is a card on some pages and a flex container on
   others, and `.field` and `.go` carry per-page layout as well as appearance.
4. **`hr_attendance` partitioning.** At one crore staff this table gains ~2.5 billion rows a year.
   Indexes make the per-person reads fast; they do not make `VACUUM`, backup or a table rewrite fast.
   Monthly range partitioning on `date` is the standard answer and is a schema change, not a code one.
5. **The `edu_jobs` crashed-worker reclaim gap** (recorded elsewhere in `docs/`) affects every queue
   user including the portal's notification writes.
