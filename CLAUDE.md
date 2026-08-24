# EduRankAI — working rules

## Never touch the production database

**Do not connect to any database. Do not read `.env`, `.env.local`, `.env.production`, or any file
matching `.env*`. Do not run scripts that open a database connection** (`.dev-scripts/*`,
`scripts/apply-sql.mjs`, `drizzle-kit`, `psql`, or a `postgres()` client in a scratch file).

This is not a style preference. On 2026-08-02 a subagent asked to survey *source files* connected to
production instead and read staff gender data out of `hr_employees` — while building the women's
wellness system, whose entire premise is that nobody reads private health data without consent. The
survey could have been completed correctly by reading `src/lib/db/schema.ts`, `db/hr-schema.sql`, and
the admin forms that write the column.

`.env.production` sits in this working directory and holds live credentials. It is gitignored, so it
never reaches the repository — but it is readable by anything running locally, which is exactly how
that access happened.

**To learn the schema, read the source:**
- `src/lib/db/schema.ts` — Drizzle table definitions
- `db/hr-schema.sql` — HR tables
- the admin page that writes a column — for the values actually stored in it

**If a task genuinely requires production data, stop and hand the user the command to run
themselves.** That is the established pattern here for migrations and it applies to reads too:
a read of employee PII is not a lesser act than a write.

## Data this codebase must never expose

- **Individual health data.** The wellness system (`src/lib/wellness.ts`) is women-only and gated
  server-side. No admin, and not the founder, may see one person's cycle, symptoms or consult
  messages. Oversight screens are aggregate only and suppress any group below `MIN_GROUP`. If you
  find yourself writing a query that returns a row per user on an admin surface, that is the screen
  that must not exist.
- **Legal-hold records** (`src/lib/legal-hold.ts`) require an open numbered matter and a written
  reason, and `logAccess()` must succeed *before* anything renders.

## Language and product rules

- **No emojis anywhere** — inline monochrome SVG only.
- **Never name a competitor or any real company** in user-facing copy.
- EduRankAI is **the technology platform**; accredited partners award credentials. Never claim to be
  a university or to confer degrees. **Every internship and apprenticeship is unpaid.** The single exception is the flagship
  LLM Engineering Internship (`llm-engineering-intern`). Paid/unpaid is decided by the slug
  allowlist in `src/lib/compensation-text.ts` (`publicCompensation()`), never inferred from the
  stored `roles.salary` text - a free-text row once advertised an unpaid intern role as paid.
- Automated proctoring and detection are **advisory only** — a human decides.

## Traps that have caused production outages here

- **`const` is not hoisted.** Declare every `const` *before* the POST handler that uses it. This
  broke apply step 5 and the `/admin/roles/diagnose` Repair button, which threw on its first line
  every time while the page reported "All checks passed".
- **postgres-js returns plain arrays.** `const rows = Array.isArray(r) ? r : (r?.rows || [])`.
  Never `r.rows[0]`.
- **The real Postgres error is on `e.cause`.** Log `e?.cause?.message || e?.message` — `e.message`
  is just the failed SQL.
- **Never swallow an exception in a login or signing path.** A bare
  `catch { errorMsg = 'Login error' }` hid a total sign-in outage for hours.
- **`.astro` specifics:** no `Record<string,string>` typed maps inside JSX; no arrow characters in
  JSX strings; `define:vars` cannot combine with `is:inline`; a `<script>` inside a JSX conditional
  breaks parsing.
- **Do not edit `src/layouts/`, `public/era/`, or `.env*` without explicit approval.**

## Verifying work

Reported success and observable result are not the same thing, and they have diverged repeatedly on
this project. A green message from a script proves the script ran, not that it did the intended work
against the intended system. Check the actual surface — load the URL, query the live page — before
telling the user something is done.
