# Handoff — HRMS adoption review (Phase 3C)

Written 2026-08-03. Read this first in the fresh session, then read the workflow output.
Do not commit anything based on this file alone: it is a pointer, not evidence.

## Where the evidence is

| What | Where |
|---|---|
| Review workflow output | `wocxhqgxh` task output + `…/subagents/workflows/wf_f6af4d47-747/journal.jsonl` |
| Cloned reference repo | `…/scratchpad/hrms` (shallow clone of `Sid0190guw/edurankai-hrms`) |
| Workspace build output | `wyafdqebp` (Parts 4-5, was still running at handoff) |
| RBAC migration output | `wisdjo8sf` — 137KB, only its opening was read |
| Lost-application trace | `w23cyf9hr` — root cause confirmed, fix specified |

Scratchpad root: `C:\Users\user\AppData\Local\Temp\claude\c--Users-user-Projects-edurankai\a51a4011-d5f8-4ff9-b8f8-3709939fc494\`

Per-agent transcripts are `agent-*.jsonl` in each workflow's `subagents/workflows/<runId>/`.
`journal.jsonl` holds one result line per completed agent — read it before assuming a result is empty.

## Repository state at handoff

- Last clean checkpoint: **`1762515`** ("Capability vocabulary, and the relationship the org graph cannot yet answer"). Unpushed.
- `astro check` = **194 errors** (baseline; 195 before). `npm run build` completes.
- **Uncommitted in the working tree**: the location-gate fix and the resume-export split, from a
  workflow stopped mid-run. Verified by neither build nor review. Check `git status` first.
- `wyafdqebp` may have added more uncommitted files after this was written.

## The one question the review must answer

**Option A** (HRMS schema joins the Supabase database) vs **Option B** (independent service).

This likely turns on a single fact, not on feature comparison: `schema/003_roles_and_rls.sql`
creates Postgres **roles** and RLS, and `008_audit_axis_integrity.sql` claims `audit_log` is owned by
a role nobody can become. **Supabase restricts superuser operations.** If those statements cannot run
there, Option A is constrained regardless of its merits. Produce the statement-by-statement table
(Statement | Purpose | Requires Superuser | Runs on Supabase | Alternative | Migration Impact).

Second decisive fact: **Cerbos is a separate gRPC PDP process.** A long-running sidecar is not a
Vercel primitive. Answer operationally, not conceptually — and note that adopting it alongside the
ratified capability registry would mean two authorization systems, which the three-layer rule forbids.

Trust executable code over documentation. The repo asserts its schema was "executed against real
PostgreSQL 16 and all behavioral guarantees verified" — that claim was **read, not reproduced**.

## Facts established this session (verified in source)

- The reference repo has **zero frontend**: no tsx/jsx/vue/svelte/astro/css. Deps are `fastify`,
  `pg`, `@cerbos/grpc`. It is a backend spine, not a design reference. Any brief asking for its
  UI/UX/dashboard/theme review is asking about something that does not exist.
- **EduRankAI Layer 1 does not exist.** `departments` carries no head column in either
  `src/lib/db/schema.ts` or `db/hr-schema.sql`; `hr_employees.reporting_manager_id` is declared and
  written by **zero lines of application code**. This is why `department.lead` could not be deleted
  in Phase 1 — deleting it with nothing to resolve against would lock out every department head.
- **Lost application record, root cause confirmed:** `llm-engineering-intern` is the only role with
  `requiresPreciseLocation: true`. GPS grants are written with `user_id` set but `application_id`,
  `intent_id` and `email` NULL (the client reads them from `[data-era-apply]`, which carries none).
  `getLocationTrail` matches only those three columns, never `user_id`, so a real grant is invisible;
  the gate fails closed at `step-6.astro:264` and both the direct-submit branch (267) and the pay
  redirect (289) are skipped. A gate refusal writes **no** error row, which is why nothing appeared
  at `/admin/hardening`. Confirm without a database by opening
  `/apply/step-1?role=llm-engineering-intern` — the red "PRECISE LOCATION REQUIRED" panel means the
  gate is live.

## Open, in priority order

1. Architectural recommendation: **Option A / B / Hybrid**, on technical evidence
2. Assemble the 13 Phase 3 deliverables from `wisdjo8sf` (never fully read)
3. Verify and commit the uncommitted location + export work
4. Org Graph — **paused** pending the decision above
5. `department.lead` removal — blocked until the graph has data; the backfill must be run by the user
6. Phase 3 Parts 8-9 (workflow engine, org visualization) — both consume the graph

## Standing constraints

Three layers never merge: Organization (per row, from the graph) / Authorization (per user,
capabilities) / Workflow. Relationships are never capabilities. Dotted lowercase capability names.
Mechanism changes may ship; **policy changes require explicit approval** — report the difference
instead of implementing it. No database connections, no `.env*` reads, no prod DDL — hand over the
command. Runtime, mobile and concurrency claims are **NOT VERIFIED** here: this environment has no
browser and no database.
