# EduRankAI Mail — Development Rules

Read with the repository-wide `CLAUDE.md`, which overrides everything here.

---

## 1. Never touch the production database

**No agent on this project opens a database connection.** Not to survey a schema, not to check a
column, not to "just verify". Read `src/lib/db/schema.ts`, `db/hr-schema.sql`,
`db/mail-platform-schema.sql` and the admin page that writes the column.

Migrations are **handed to the operator**:

```bash
psql "$DATABASE_URL" -f db/mail-platform-schema.sql
```

`CLAUDE.md` records why: a subagent asked to survey *source files* connected to production instead
and read staff gender data out of `hr_employees` — while building the women's wellness system, whose
entire premise is that nobody reads private health data without consent.

## 2. Repository traps that have caused outages here

| Trap | Rule |
| --- | --- |
| `const` is not hoisted | Declare every `const` **above** the handler that uses it. This broke the `/admin/roles/diagnose` Repair button, which threw on its first line while the page reported "All checks passed". |
| postgres-js returns plain arrays | `const rows = Array.isArray(r) ? r : (r?.rows || [])`. Never `r.rows[0]`. |
| The real Postgres error is on `e.cause` | Log `e?.cause?.message \|\| e?.message`. `e.message` is only the failed SQL. |
| Never swallow an exception in a login or signing path | A bare `catch { errorMsg = 'Login error' }` hid a total sign-in outage for hours. |
| Never memoise a failure as a success | A `catch (_) {}` under a memoised promise made every later call sail past a resolved cache while every query failed. `ensureMailPlatformSchema()` sets `ready = null` on failure for exactly this reason. |
| No emojis anywhere | Inline monochrome SVG only. |
| Never name a competitor or real company in user-facing copy | Applies to templates, error messages and docs shown in-product. |
| Automated detection is advisory | Spam scores and SPF/DKIM results inform a human; they never auto-penalise. |

## 3. Rules this subsystem adds

1. **Never write SQL against `mail_*` or `mp_*` from a route.** Go through a service or the
   `MessageStore`. Access control belongs in one place.
2. **Never call `sendExternal()` or `nodemailer` directly.** Use `sendMessage()`. A bypass skips the
   suppression check, records no delivery attempt and appears in no report.
3. **Every new table is `mp_`-prefixed and carries `org_id`.** A test enforces both.
4. **Never store a secret you can hash.** DKIM private keys are referenced, webhook secrets are
   hashed, API keys are hashed.
5. **Return a result, do not throw, for an expected failure.** Reserve exceptions for bugs.
6. **An error message is a sentence someone can act on.** "SMTP error" is not; "Port 587 uses
   STARTTLS — untick Use TLS/SSL for port 587" is.
7. **Report what actually happened.** `{ ok: true, removed: false }` when a delete matched no row.
   An admin screen must not print "Done" for an action that changed nothing.
8. **Keyset pagination only.** No `OFFSET`.
9. **Batch in loops.** One statement per 500 rows, not one per row.
10. **Say when something is not configured.** `info().enabled === false` plus a sentence naming the
    missing variable — never a silent fallback that looks like success.

## 4. Testing

```bash
npx vitest run src/lib/mailplatform      # this subsystem
npm test                                  # everything (vitest + the house shim runner)
```

- Pure functions carry the rules, so they can be tested exhaustively without a connection. If a rule
  needs a database to test, it is in the wrong place.
- A test asserts an **invariant**, not a copy of the schema. `mailplatform-schema.test.ts` checks
  prefixes, timestamps, `org_id`, idempotency and the absence of a private-key column — it does not
  re-list every field.
- Every test in this subsystem carries a comment saying **what breaks in production** if it fails.
- Suites that import `vitest` run under Vitest; everything else runs under `npm run test:shim`. The
  split is worked out at config load, not hand-listed.

**Current:** 89 tests across 3 files, all passing. Four real defects were found and fixed by writing
them — see the report.

## 5. Verifying work

From `CLAUDE.md`: *"Reported success and observable result are not the same thing, and they have
diverged repeatedly on this project."*

A green test proves the logic. It does not prove the migration was applied, the env var is set, or
the endpoint answers. Before telling anyone something is done:

1. Apply the migration and confirm `mp_schema_migrations` has the row.
2. `GET /api/v1/platform/status` and read the `unconfigured` list.
3. Send one real message and check it arrived.
4. **Nothing is live until `git push origin main`.** Check `origin/main..main` before investigating a
   "still broken" report.

## 6. RESOLVED: one mailbox, not three

Four agents worked this codebase in the same session, and three message stores appeared. The user
chose to **unify on the live store**. That is now implemented.

| Layer | Role after unification | Store |
| --- | --- | --- |
| Live webmail | unchanged | `mail_messages` / `mail_box` |
| Developer API (`src/lib/mailapi/`) | keeps its keys, scopes, environments, rate limiting, idempotency and error envelope. `mailapi_messages` is retired **as a message store** and kept as the **send-job** record. | send job → `mailapi_messages`, message → `mail_messages` |
| Core platform (this patch) | the shared store and its delivery tables | `mail_messages` (extended) + `mp_*` |

`mailapi_messages` and `mail_messages` were never the same kind of thing. One held a *send job*
(environment, idempotency key, attempts, `next_attempt_at`, backoff); the other holds a *message*
(from, to, subject, bodies, thread). Splitting them along that line is what made unification a
small change rather than a rewrite.

### What was changed

- `src/lib/mailplatform/mailapi-bridge.ts` — **new, owned by this patch.** All mapping lives here.
- `src/lib/mailapi/messages.ts` — two edits: `createMessage()` mirrors into the shared store;
  `getMessageBody()` reads from it, falling back to the local columns for pre-bridge rows.
- `src/lib/mailapi/send.ts` — one helper plus four one-line calls, so every delivery outcome (sent /
  deferred / bounced / failed) lands on `mp_delivery_attempts`, `mp_delivery_status` and
  `mp_delivery_events`.
- `mailapi_messages.platform_message_id` — the link, added additively at schema version 2.

Every exported signature, response shape and field in the developer API is unchanged. Its routes
were not touched.

### The rules the bridge follows

1. **It never throws and never blocks a send.** A unification that could fail a send would be worse
   than the fork it replaced. Mirroring failures are logged at error level; the send proceeds.
2. **It does not call `sendMessage()`.** The developer API resolves its own identity, checks its own
   suppression list and hands the message to the transport itself. Running the platform send pipeline
   there would deliver the message twice.
3. **It reuses the org link the developer API already built** (`mailapi_orgs.mp_org_id`, from
   `src/lib/mailapi/bridge.ts`) rather than resolving a second one. Two independent mappings between
   the same two tables eventually disagree, and then one console shows a tenant the other cannot find.
4. **Environment isolation is preserved.** `getMessageBody()` checks org and environment on the
   developer API's own row *before* reading the shared body, so a test-environment key cannot read a
   live-environment message.

### What is still true

Rows written before the bridge landed have `platform_message_id IS NULL` and are readable through
the developer API only. They are not back-filled: nothing here connects to production. If you want
them mirrored, that is a one-off script for the operator to run.

`bridgeStatus()` in `mailapi-bridge.ts` reports how many send jobs are mirrored and how many are not,
in a sentence.
