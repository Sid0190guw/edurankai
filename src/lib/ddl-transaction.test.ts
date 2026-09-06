// src/lib/ddl-transaction.test.ts
//
// THE 2026-08-24 /admin/setup FAULT, AND THE THREE THINGS THAT HAVE TO STAY TRUE FOR IT NOT TO COME
// BACK.
//
// What happened: every schema bootstrap in this repository sent its DDL as one simple-protocol
// message whose TEXT contained `BEGIN; ... COMMIT;`. When a statement inside a multi-statement simple
// query fails, PostgreSQL abandons the rest of the message — the COMMIT included — so the connection
// went back into the pool sitting inside an ABORTED TRANSACTION. Everything that drew it afterwards
// was answered `25P02 current transaction is aborted, commands ignored until end of transaction
// block`: three innocent modules and all six checklist counts on /admin/setup, and, off that page,
// "Sign-in is temporarily unavailable" on /admin/login for whoever's request drew the poisoned
// connection out of a five-slot pool.
//
// The mechanism was reproduced and the fix verified against a real PostgreSQL (PGlite over TCP,
// never the production database). What that verification CANNOT do is stop somebody reintroducing
// the shape, which is what the repository scan below is for: it is the only test here that would
// have caught the original defect, because every unit test of every bootstrap passed while it was
// live.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedDdlBody, guardedDdlScript, ensureOnce, recentEnsureFailures, forgetEnsureFailures } from './ensure-once';
import { isAbortedTransaction } from './db-timeout';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|astro|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every source file under src/, read once and stripped of whole-line comments once.
 *
 * MEMOISED BECAUSE THIS TEST TIMED OUT ON A CLEAN CHECKOUT AT 5,754ms AGAINST A 5,000ms BOUND.
 *
 * The two scans below each walked the whole tree, read every file, and rebuilt the comment-stripped
 * copy of each one. The first warmed the filesystem cache and passed; the second paid the walk again
 * and went over. It never failed in a warm working tree, which is why it shipped green — the failure
 * needs a checkout nobody has read yet, and that is exactly what CI and a fresh clone are. The same
 * shape had just been fixed in src/lib/job-handlers.test.ts.
 *
 * The scan is pure: same files, same answer. Doing it once is not a behaviour change, and the
 * comment-stripping — a split, a filter and a join over several thousand files — was the larger half
 * of the cost, not the reading.
 */
let cachedSources: { rel: string; raw: string }[] | null = null;
function sourceFiles(): { rel: string; raw: string }[] {
  if (cachedSources) return cachedSources;
  cachedSources = [];
  for (const file of walk(SRC)) {
    if (/[\\/]node_modules[\\/]/.test(file)) continue;
    const rel = file.slice(SRC.length).split('\\').join('/');
    // This file names every forbidden shape in order to test for it.
    if (rel.endsWith('ddl-transaction.test.ts')) continue;
    cachedSources.push({ rel, raw: readFileSync(file, 'utf8') });
  }
  return cachedSources;
}

/**
 * The comment-stripped copy, built ONLY for a file that could match — which is the whole speed of it.
 *
 * The memoisation above already stopped this file walking the tree twice. What it did not stop was
 * building the stripped copy of all 2,421 files, and THAT is the expensive half: a split, a filter
 * and a join over 42MB. Measured, this one test cost 17,344ms against the suite's 20,000ms bound —
 * 87% of the budget spent by a passing test, which is precisely the shape vitest.config.ts describes
 * as the reason the gate flapped. Under any load it went over, on a different file each run.
 *
 * Stripping only ever REMOVES whole lines, so it can never introduce a token the raw text did not
 * already contain. That makes a `.test()` on the raw text a sound pre-filter: if the raw file has no
 * `.simple()` in it at all, neither does its stripped form, and there is nothing to build. Almost no
 * file contains either token, so almost none is stripped. The answer is identical — a file that does
 * contain the token is still stripped and still judged on the stripped copy, which is what keeps a
 * mention inside a comment from counting as a call.
 */
/**
 * What the two scans below are allowed to cost.
 *
 * The suite-wide bound is 20,000ms (vitest.config.ts) and it is sized for tests of pure functions.
 * These two read the repository. After the pre-filter above, the first — which warms the cache for
 * both — measures 6,253ms warm, down from 17,344ms; the second is then 18ms. 6.2s against a 20s
 * bound is 31% of the budget rather than 87%, but a full-suite run has a dozen workers competing for
 * the same disk, and this test still timed out there while passing alone.
 *
 * So it gets a bound sized to what it IS, exactly as src/lib/job-handlers.test.ts does for the same
 * reason. 30 seconds is not a licence to be slow: warm, this is six seconds, and if it ever
 * approaches this number the scan itself has gone wrong.
 */
const SCAN_TIMEOUT_MS = 30_000;

const strippedCache = new Map<string, string>();
function withoutComments(rel: string, raw: string): string {
  const hit = strippedCache.get(rel);
  if (hit !== undefined) return hit;
  const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  strippedCache.set(rel, code);
  return code;
}

describe('the guarded DDL body carries no transaction control', () => {
  it('sets both bounds and opens no transaction of its own', () => {
    const body = guardedDdlBody('CREATE TABLE IF NOT EXISTS x (id int)');
    expect(body).toContain("SET LOCAL lock_timeout = '3s'");
    expect(body).toContain("SET LOCAL statement_timeout = '20s'");
    expect(body).toContain('CREATE TABLE IF NOT EXISTS x (id int)');
    // THE ABSENCE IS THE FIX. A BEGIN in the text is a BEGIN the driver does not know about, and a
    // COMMIT in the text is a COMMIT the server will skip on the first error.
    expect(/\bBEGIN\b/i.test(body)).toBe(false);
    expect(/\bCOMMIT\b/i.test(body)).toBe(false);
  });

  it('tolerates a trailing semicolon rather than emitting an empty statement', () => {
    expect(guardedDdlBody('CREATE TABLE a (id int);  \n')).toContain('CREATE TABLE a (id int);');
    expect(guardedDdlBody('CREATE TABLE a (id int)')).toContain('CREATE TABLE a (id int);');
  });

  it('keeps the psql script form, which is a different mechanism and stays honest about it', () => {
    // `psql -v ON_ERROR_STOP=1 -f` executes a file statement by statement and stops on the first
    // error. That is safe, and it is the only reason BEGIN/COMMIT as text still exists here.
    const script = guardedDdlScript('CREATE TABLE a (id int)');
    expect(script.startsWith('BEGIN;')).toBe(true);
    expect(script.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});

describe('nothing sends DDL through the simple protocol on its own any more', () => {
  // THIS IS THE TEST THAT WOULD HAVE CAUGHT IT. Seven files each wrote
  // `sqlClient().unsafe(guardedDdl(ddl)).simple()`, every one of them with a careful comment
  // explaining why the batch was correct — and every one of them left a poisoned connection behind
  // the moment a statement failed. The rule is now structural: one sender, and it is runGuardedDdl.
  const ALLOWED: Record<string, string> = {
    'lib/ensure-once.ts': 'runGuardedDdl — the one sender, inside a driver-owned transaction',
    'lib/db/index.ts': 'healAbortedTransactions — sends ROLLBACK, which is the cure, not the cause',
  };

  it('has exactly one sender, and it opens its transaction through the driver', () => {
    const offenders: string[] = [];
    for (const { rel, raw } of sourceFiles()) {
      if (!/\.simple\(\)/.test(raw)) continue;          // cheap: raw cannot hide what stripping removes
      if (ALLOWED[rel]) continue;
      if (!/\.simple\(\)/.test(withoutComments(rel, raw))) continue;   // only a mention in a comment
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  // WHERE `BEGIN;` AS TEXT IS STILL CORRECT, AND IT IS ONE PLACE ONLY: a .sql FILE FOR A HUMAN.
  //
  // The distinction is the client, not the SQL. `psql -v ON_ERROR_STOP=1 -f` executes a file
  // statement by statement and stops on the first error, so the transaction ends with the session.
  // A multi-statement message sent by a DRIVER does not: the server abandons the rest of the message
  // and the connection goes back to the pool still inside the transaction. Everything allowed below
  // writes a file for somebody to run by hand.
  const ALLOWED_BEGIN: Record<string, string> = {
    'lib/ensure-once.ts': 'guardedDdlScript() — names itself as the psql form',
    'lib/mailplatform/schema.ts': 'builds a .sql file for an operator to run',
    'lib/mailplatform/mailplatform-schema.test.ts': 'asserts on that generated file',
    'lib/horizon/schema-mirror.test.ts': 'asserts a generated .sql mirrors the module',
  };

  it('leaves no BEGIN/COMMIT pair inside a string a DRIVER executes', () => {
    const offenders: string[] = [];
    for (const { rel, raw } of sourceFiles()) {
      if (!/BEGIN;/.test(raw)) continue;               // same pre-filter, same reason
      if (ALLOWED_BEGIN[rel]) continue;
      const code = withoutComments(rel, raw);
      if (/`BEGIN;/.test(code) || /'BEGIN;/.test(code) || /"BEGIN;/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

describe('a batch never indexes a column it has not asserted', () => {
  // THE SECOND HALF OF THE 2026-08-24 FAULT, AND THE HALF THAT ACTUALLY LOST THE TABLES.
  //
  // The aborted transaction explains why twenty things reported an error. THIS explains why one
  // thing failed in the first place: `CREATE TABLE IF NOT EXISTS` over a table that already exists in
  // an older shape is a silent no-op. Postgres does not compare the definition and does not add the
  // missing column. The live hr_performance_reviews had no cycle_id, so the index on cycle_id threw
  // 42703 — and because a batch is one transaction, hr_skills, hr_employee_skills,
  // hr_learning_assignments, hr_training_events and hr_training_signups, which have nothing to do
  // with review cycles, were rolled back with it and had to be created by hand from db/*.sql.
  //
  // The rule: every column a CREATE INDEX names must be asserted with ADD COLUMN IF NOT EXISTS
  // EARLIER in the same batch. A CREATE TABLE above it is not an assertion.
  //
  // SCOPED TO THE FILE WHERE THE DEFECT IS PROVEN. Widening it to every ensureBatch() in the
  // repository is the right end state and is its own pass — it would flag modules nobody has
  // enumerated against the live database, and a gate that lands red teaches people to skip it.
  const GUARDED_FILES = ['performance-schema.ts'];

  for (const name of GUARDED_FILES) {
    it(`${name}: every indexed column is asserted before the index that reads it`, () => {
      const text = readFileSync(join(SRC, 'lib', name), 'utf8');
      const asserted = new Set<string>();
      const offenders: string[] = [];
      // One pass, in order, so "earlier in the batch" is what is actually checked.
      for (const line of text.split('\n')) {
        if (/^\s*\/\//.test(line)) continue;
        const alter = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/i.exec(line);
        if (alter) { asserted.add(`${alter[1].toLowerCase()}.${alter[2].toLowerCase()}`); continue; }
        const idx = /CREATE\s+(?:UNIQUE\s+)?INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)\s*\(([^)]*)\)/i.exec(line);
        if (!idx) continue;
        const table = idx[1].toLowerCase();
        for (const raw of idx[2].split(',')) {
          // `created_at DESC` -> created_at; `lower(name)` -> name.
          const words = raw.match(/[a-z_][a-z0-9_]*/gi) || [];
          const col = (words.filter((w) => !/^(desc|asc|lower|upper|coalesce|nulls|first|last)$/i.test(w))[0] || '').toLowerCase();
          if (!col) continue;
          if (!asserted.has(`${table}.${col}`)) offenders.push(`${table}.${col}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe('25P02 is recognised as a fact about the connection, not about the query', () => {
  it('reads the SQLSTATE off the driver error, wherever the driver put it', () => {
    expect(isAbortedTransaction({ code: '25P02' })).toBe(true);
    // postgres-js hangs the real error on `cause`; `message` is only the failed SQL.
    expect(isAbortedTransaction({ cause: { code: '25P02' } })).toBe(true);
  });

  it('reads the text too, because a wrapper can lose the code', () => {
    expect(isAbortedTransaction({
      message: 'current transaction is aborted, commands ignored until end of transaction block',
    })).toBe(true);
  });

  it('does not claim an ordinary failure is one', () => {
    expect(isAbortedTransaction({ code: '42P01', message: 'relation "x" does not exist' })).toBe(false);
    expect(isAbortedTransaction(null)).toBe(false);
    expect(isAbortedTransaction(new Error('timeout'))).toBe(false);
  });
});

describe('ensureOnce keeps the reason it swallows', () => {
  // The swallow is deliberate and stays: callers tolerate a missing table. The cost was that
  // /admin/setup — the one surface built to repair a schema — could not see any of it, so the module
  // that actually failed was the one module the panel did not name.
  it('records a failure under its key, with the real Postgres reason', async () => {
    forgetEnsureFailures();
    const boom: any = new Error('CREATE TABLE hr_skills (...)');
    boom.cause = { code: '42P01', message: 'relation "hr_employee_goals" does not exist' };
    await ensureOnce('test_key_that_fails', async () => { throw boom; });
    const found = recentEnsureFailures().find((f) => f.key === 'test_key_that_fails');
    expect(found).toBeTruthy();
    expect(found!.message).toBe('relation "hr_employee_goals" does not exist');
    expect(found!.code).toBe('42P01');
    forgetEnsureFailures();
  });

  it('still resolves for the caller — the swallow is the contract', async () => {
    forgetEnsureFailures();
    let threw = false;
    try { await ensureOnce('test_key_swallowed', async () => { throw new Error('nope'); }); }
    catch { threw = true; }
    expect(threw).toBe(false);
    forgetEnsureFailures();
  });

  it('forgets a key that later succeeds, so the panel reports what is wrong NOW', async () => {
    forgetEnsureFailures();
    await ensureOnce('test_key_recovers', async () => { throw new Error('first attempt'); });
    expect(recentEnsureFailures().some((f) => f.key === 'test_key_recovers')).toBe(true);
    // ensureOnce drops a failed run from its cache, so the next call really re-runs.
    await ensureOnce('test_key_recovers', async () => { /* created this time */ });
    expect(recentEnsureFailures().some((f) => f.key === 'test_key_recovers')).toBe(false);
    forgetEnsureFailures();
  });
});
