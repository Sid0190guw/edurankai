// THE ONE PLACE THAT DECIDES WHETHER THIS PROCESS MAY CHANGE THE DATABASE SCHEMA.
//
// src/lib/ensure-once.ts already carried this decision, and it is documented at length there: on
// 2026-08-23 request-time DDL took the site down, so SCHEMA_BOOTSTRAP defaults to OFF in production
// and every ensureOnce() key becomes a resolved promise. That worked for the ~192 keys that go
// through ensureOnce.
//
// IT DID NOT COVER THE MODULES THAT NEVER GOT ONTO ensureOnce, AND THERE ARE ABOUT FORTY OF THEM.
// They call db.execute() with an ALTER TABLE directly, from an exported ensureXSchema() that a page
// awaits in its frontmatter, with no memo of any kind, so the statements run on EVERY REQUEST rather
// than once per process. Measured by reading the source, not guessed:
//
//   src/lib/study-abroad.ts         37 statements,  5 pages (one of them public)
//   src/lib/aquintutor-authoring.ts 36 statements, 10 pages
//   src/lib/mail.ts                 20 statements, 22 pages
//   src/lib/credential-store.ts      3 statements, 52 pages
//   ... and the rest of the list, every one of them with no memo at all
//
// Two costs, and the second is the one that shows up in the Supabase log:
//
//   LATENCY AND LOCKS. Each statement is its own round trip (~135ms from bom1), and ALTER TABLE takes
//   ACCESS EXCLUSIVE *before* it evaluates IF NOT EXISTS. A pending exclusive lock is granted ahead
//   of shared locks requested after it, so every SELECT on that table queues behind a no-op ALTER.
//
//   POSTGREST SCHEMA-CACHE RELOADS. Supabase installs an event trigger (extensions.pgrst_ddl_watch on
//   ddl_command_end) that runs a schema-reload NOTIFY on the pgrst channel for CREATE/ALTER TABLE,
//   CREATE FUNCTION, CREATE TRIGGER, COMMENT and friends. Statement forms with no IF NOT EXISTS
//   semantics (ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL, CREATE OR REPLACE FUNCTION,
//   CREATE TRIGGER) execute every single time they are sent, so each one fires that NOTIFY every
//   single time. On a schema with 500+ relations PostgREST's introspection query then exceeds its
//   statement_timeout (57014), fails to load the cache, and reconnects with escalating backoff, which
//   is exactly the 274-reload / 121-pool-init pattern in the production log. NOTHING IN THIS
//   REPOSITORY SENDS THAT NOTIFY: a grep for it over the whole tree, dist/ included, returns nothing
//   at all. The event trigger sends it, and DDL is what makes it fire.
//
// So the decision moves to the one chokepoint every one of those modules already shares, the
// execute() on the shared drizzle handle in src/lib/db/index.ts, instead of being re-litigated in
// forty files under incident pressure. When bootstrap is off, a DDL statement is COUNTED AND LOGGED
// AND NOT SENT.
//
// WHY THIS IS SAFE, in the words of the module that established the policy: "every caller already
// tolerates a missing table, which is why ensureOnce swallows in the first place, so the failure mode
// is a feature with no rows rather than a site that will not load." That tolerance is what these
// callers were already relying on for the 192 keys that WERE covered; this extends the same treatment
// to the ones that were missed.
//
// NOTHING CHANGES IN DEVELOPMENT OR IN THE TEST SUITE. The predicate is the same one ensure-once.ts
// has always used: off in production, on everywhere else, and SCHEMA_BOOTSTRAP=on/off overrides both.
// Local dev and vitest create their schema as they go and still do.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * May this process run schema-changing SQL on the request path?
 *
 * Read per call, not once at module scope, so the value is whatever the environment says NOW rather
 * than whatever it said when this instance happened to boot. Kept equivalent to the predicate
 * ensure-once.ts shipped, because changing the policy is not what this incident needs.
 */
export function schemaBootstrapEnabled(): boolean {
  const v = String(process.env.SCHEMA_BOOTSTRAP || '').toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  // Local dev and the test suite create their schema as they go and depend on it.
  return process.env.NODE_ENV !== 'production';
}

// -------------------------------------------------------------------------------------------------
// THE DELIBERATE ESCAPE HATCH
// -------------------------------------------------------------------------------------------------
//
// Some DDL on this project is not a bootstrap sneaking onto a page render. It is an operator, in the
// admin console, pressing a button whose whole purpose is to repair a schema (the Repair action on
// /admin/roles/diagnose, the apply steps). Suppressing those would break a working feature and,
// worse, would let it report success while doing nothing, which is the exact failure this codebase
// has already shipped once: "ok: true, ran: 8, failed: 0" while ten tables were missing.
//
// AsyncLocalStorage, not a module-level flag: one warm instance serves concurrent invocations, and a
// plain boolean set by an admin repair would let an unrelated visitor's page render DDL for the
// duration. The scope here follows the async call chain and nothing else.
const ddlScope = new AsyncLocalStorage<true>();

/** Run fn with request-time DDL permitted, whatever the environment says. For operator actions only. */
export function allowingDdl<T>(fn: () => Promise<T>): Promise<T> {
  return ddlScope.run(true, fn);
}

/** Is DDL permitted right here, right now? */
export function ddlPermitted(): boolean {
  return ddlScope.getStore() === true || schemaBootstrapEnabled();
}

// -------------------------------------------------------------------------------------------------
// WHAT COUNTS AS DDL
// -------------------------------------------------------------------------------------------------
//
// Conservative in the direction that matters: a statement this does not recognise is EXECUTED, never
// silently dropped. Only the leading keyword is tested, and leading whitespace or a comment block is
// skipped first because the sql.raw() strings in this repo start with newlines and indentation.
const DDL_HEAD = /^(?:CREATE|ALTER|DROP|COMMENT\s+ON|TRUNCATE|GRANT|REVOKE|REINDEX|CLUSTER)\b/i;

/** A DO block is only DDL if its body is. DO on its own tells you nothing. */
const DO_WITH_DDL = /^DO\b[\s\S]*\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|TRIGGER|FUNCTION|TYPE|POLICY|SCHEMA|SEQUENCE)\b/i;

/** Strip leading whitespace and SQL comments so the first real keyword can be tested. */
function firstKeyword(text: string): string {
  let s = String(text || '');
  // Bounded: each pass removes at least one character, and the loop stops when nothing matches.
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) break;
  }
  return s;
}

export function isDdlStatement(text: string): boolean {
  const s = firstKeyword(text);
  if (!s) return false;
  if (DO_WITH_DDL.test(s)) return true;
  return DDL_HEAD.test(s);
}

// -------------------------------------------------------------------------------------------------
// OBSERVABILITY, because a guard nobody can see is the next invisible incident
// -------------------------------------------------------------------------------------------------

let suppressed = 0;
const suppressedSamples: string[] = [];

/** Record that one DDL statement was refused. Never throws. */
export function noteSuppressedDdl(text: string): void {
  suppressed += 1;
  const head = firstKeyword(text).replace(/\s+/g, ' ').slice(0, 120);
  // A bounded sample list, not a log of every statement: these run in the hundreds and the point is
  // to be able to name WHICH bootstraps are still trying, not to keep all of them.
  if (suppressedSamples.length < 25 && suppressedSamples.indexOf(head) < 0) {
    suppressedSamples.push(head);
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'schema.ddl_suppressed',
      statement: head,
      note: 'request-time DDL refused (SCHEMA_BOOTSTRAP off). Apply it from db/*.sql as the operator.',
    }));
  }
}

/** For /api/health and /admin/ops. */
export function suppressedDdlState(): { count: number; samples: string[]; bootstrapEnabled: boolean } {
  return { count: suppressed, samples: suppressedSamples.slice(), bootstrapEnabled: schemaBootstrapEnabled() };
}
