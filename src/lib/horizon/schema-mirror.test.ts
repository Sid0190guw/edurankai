// src/lib/horizon/schema-mirror.test.ts — the bootstrap and the hand-run SQL file say the same thing.
//
// WHY THIS TEST EXISTS. db/horizon-schema.sql claims to be the readable mirror of what
// ensureHorizonSchema() sends. A mirror that has drifted is worse than no mirror: an operator runs
// it against production believing they have applied the schema the code expects, and the difference
// only shows up as a missing column on a request path weeks later. This project already carries the
// scar — two `CREATE TABLE IF NOT EXISTS` statements for one table with different shapes, where
// whichever ran second was a silent no-op and half the columns simply never existed.
//
// So the claim is checked rather than asserted. The .sql file is generated from the same DDL string
// the bootstrap sends; this test re-extracts both and compares them statement for statement.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HORIZON_TABLES } from './schema';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Both sides are read with their line endings normalised, and that is load-bearing.
 *
 * THIS TEST WAS RED ON EVERY CLEAN CHECKOUT AND GREEN IN THE TREE THAT WROTE IT. `core.autocrlf` is
 * true here and `.gitattributes` declares only binary types, so text files come out of a clone — or
 * out of `git worktree add` — as CRLF, while a file an editor has just written is still LF.
 * bootstrapDdl() anchors on `` ` `` followed by `\n`, which is `` ` `` followed by `\r\n` after
 * checkout: it matched nothing, threw, and took all four assertions with it.
 *
 * It matters for the comparison as well as the extraction. This file compares the bootstrap's DDL
 * against the .sql file statement for statement, so if one side kept `\r` and the other did not,
 * every comparison would fail on invisible characters — the worst possible diff to read.
 */
const read = (p: string) => readFileSync(ROOT + p, 'utf8').replace(/\r\n/g, '\n');
const schemaTs = read('src/lib/horizon/schema.ts');
const schemaSql = read('db/horizon-schema.sql');

/**
 * The STATEMENTS in the .sql file, without its prose.
 *
 * The header and footer of that file discuss `REFERENCES`, `::uuid` and `ALTER TABLE` at length —
 * explaining why none of them appear — so a naive scan of the whole file finds the very words it is
 * checking for. Only the transaction body is SQL.
 */
function sqlStatements(): string {
  const begin = schemaSql.indexOf('BEGIN;');
  const commit = schemaSql.indexOf('COMMIT;', begin);
  if (begin < 0 || commit < 0) throw new Error('db/horizon-schema.sql has no BEGIN/COMMIT block');
  return schemaSql.slice(begin, commit);
}

/** Every `CREATE TABLE IF NOT EXISTS <name>` in a body of text, in order. */
function tablesIn(text: string): string[] {
  return [...text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

/** Every index name, in order. */
function indexesIn(text: string): string[] {
  return [...text.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

/** The DDL the bootstrap actually sends, pulled out of the template literal. */
function bootstrapDdl(): string {
  const m = schemaTs.match(/return ensureBatch\(KEY, `\n([\s\S]*?)\n {2}`\);/);
  if (!m) throw new Error('could not find the DDL block in schema.ts — has ensureHorizonSchema been rewritten?');
  return m[1];
}

describe('the SQL mirror matches the bootstrap', () => {
  it('creates the same tables, in the same order', () => {
    const fromCode = tablesIn(bootstrapDdl());
    // The .sql header mentions the phrase in prose, so read only from the first real statement on.
    const fromFile = tablesIn(sqlStatements());
    expect(fromFile).toEqual(fromCode);
  });

  it('creates the same indexes, in the same order', () => {
    expect(indexesIn(sqlStatements())).toEqual(indexesIn(bootstrapDdl()));
  });

  it('covers exactly the tables HORIZON_TABLES declares', () => {
    // HORIZON_TABLES is what verifyHorizonSchema() checks for and what an ops screen lists. A table
    // created but not declared would never be reported missing; a table declared but not created
    // would report missing forever.
    expect(tablesIn(bootstrapDdl()).sort()).toEqual([...HORIZON_TABLES].sort());
  });

  it('adds no foreign key across a module boundary', () => {
    // Rule 2 of schema.ts: no constraint pointing at a table another patch owns or whose id type is
    // contested. A REFERENCES that fails to create takes the whole batch down with it.
    expect(bootstrapDdl()).not.toMatch(/REFERENCES/i);
    expect(sqlStatements()).not.toMatch(/REFERENCES/i);
  });

  it('casts nothing to uuid', () => {
    // `departments.id` is varchar(50) while db/hr-schema.sql declares department_id as UUID. A ::uuid
    // cast against one is a guaranteed production 500.
    expect(bootstrapDdl()).not.toMatch(/::uuid/i);
  });

  it('alters nothing, so no statement can hold an exclusive lock through the batch', () => {
    // ALTER takes ACCESS EXCLUSIVE before it evaluates IF NOT EXISTS, and holds it until commit. On
    // a deploy every instance runs this at once; that is how a bootstrap became an outage here on
    // 2026-08-23. A new column belongs in its own ensure, outside this batch.
    expect(bootstrapDdl()).not.toMatch(/ALTER TABLE/i);
  });

  it('gives every signal an expiry the database itself enforces', () => {
    // A signal that never expires is a permanent mark on a person. NOT NULL is what makes that
    // impossible rather than merely discouraged.
    expect(bootstrapDdl()).toMatch(/expires_at\s+TIMESTAMPTZ NOT NULL/);
  });
});
