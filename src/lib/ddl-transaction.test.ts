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
    for (const file of walk(SRC)) {
      if (/[\\/]node_modules[\\/]/.test(file)) continue;
      const rel = file.slice(SRC.length).split('\\').join('/');
      if (rel.endsWith('ddl-transaction.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      // Comments discuss the old shape at length; only real calls matter.
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (!/\.simple\(\)/.test(code)) continue;
      if (ALLOWED[rel]) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

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
    for (const file of walk(SRC)) {
      if (/[\\/]node_modules[\\/]/.test(file)) continue;
      const rel = file.slice(SRC.length).split('\\').join('/');
      if (rel.endsWith('ddl-transaction.test.ts')) continue;
      if (ALLOWED_BEGIN[rel]) continue;
      const text = readFileSync(file, 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/`BEGIN;/.test(code) || /'BEGIN;/.test(code) || /"BEGIN;/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
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
