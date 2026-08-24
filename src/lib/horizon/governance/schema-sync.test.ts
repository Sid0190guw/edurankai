// src/lib/horizon/governance/schema-sync.test.ts — the bootstrap and the hand-run file must agree.
//
// WHY THIS TEST EXISTS. There are two copies of this layer's DDL and there have to be: the bootstrap
// in schema.ts creates the tables in development and on any environment where SCHEMA_BOOTSTRAP is on,
// and db/horizon-governance-schema.sql is what somebody runs by hand against production, where the
// bootstrap is off by default.
//
// Two copies of anything drift. When these two drift the symptom is the worst kind — the feature
// works locally, the tests pass, and the production database is missing a column that nothing will
// create for it. So the copies are compared byte for byte, and the fix when this fails is to
// regenerate the .sql file from schema.ts rather than to edit either one on its own.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GOVERNANCE_TABLES } from './schema';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/**
 * Read a source file with its line endings normalised.
 *
 * NOT DEFENSIVE PADDING — THIS TEST WAS RED ON EVERY CLEAN CHECKOUT AND GREEN IN THE TREE THAT
 * WROTE IT.
 *
 * `core.autocrlf` is true here and `.gitattributes` declares only binary types, so git rewrites text
 * files to CRLF on the way out. A file that an editor just wrote is still LF; the SAME file after a
 * fresh clone, or in a `git worktree add`, is CRLF. The pattern below anchors on `` ` `` followed by
 * `\n`, which after checkout is `` ` `` followed by `\r\n` — so it matched nothing, the extractor
 * threw, and all seven assertions in this file failed with "could not find the DDL template literal
 * in schema.ts" while `npm test` passed for the person who had just edited it.
 *
 * ddlFromSqlFile() below has always done this. Only the TypeScript side was missing it, which is
 * exactly the kind of asymmetry that survives review: both halves look fine, and only one of them is
 * wrong.
 */
function readNormalised(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function ddlFromSchemaModule(): string {
  const src = readNormalised(resolve(here, 'schema.ts'));
  const match = src.match(/const DDL = `\n([\s\S]*?)\n`;\n/);
  if (!match) throw new Error('could not find the DDL template literal in schema.ts');
  return match[1];
}

/**
 * The line that separates the explanatory header from the generated block.
 *
 * A sentinel rather than "strip the leading comment lines" — the DDL itself opens with comments, and
 * a regex that ate those passed the first time this test ran and would have compared the wrong
 * halves of the file for as long as it stayed green.
 */
const SENTINEL = '-- >>> BEGIN GENERATED DDL <<<\n';

function ddlFromSqlFile(): string {
  const raw = readFileSync(resolve(repoRoot, 'db', 'horizon-governance-schema.sql'), 'utf8').replace(/\r\n/g, '\n');
  const parts = raw.split(SENTINEL);
  if (parts.length !== 2) throw new Error('the generated-DDL sentinel is missing from db/horizon-governance-schema.sql');
  // The trailing semicolon is added by the generator so the file pastes into psql as one block.
  return parts[1].replace(/;\s*$/, '');
}

describe('governance schema', () => {
  it('the hand-run SQL file matches the bootstrap DDL exactly', () => {
    expect(ddlFromSqlFile()).toBe(ddlFromSchemaModule().replace(/\r\n/g, '\n'));
  });

  it('creates every table the module says it owns, and only those', () => {
    const ddl = ddlFromSchemaModule();
    const declared = (ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map((m) => m.split(/\s+/).pop());
    expect(declared.sort()).toEqual([...GOVERNANCE_TABLES].sort());
    for (const table of GOVERNANCE_TABLES) {
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    }
  });

  it('touches no table outside its own namespace', () => {
    // Brief rule 11. Every CREATE/ALTER/DROP in this bootstrap must name an hgov_ table; a statement
    // that reached another patch's table would be caught here rather than in production.
    const ddl = ddlFromSchemaModule();
    const targets = ddl.match(/(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE|DROP TABLE)\s+(?:IF EXISTS\s+)?(\w+)/g) || [];
    for (const t of targets) {
      expect(t.split(/\s+/).pop()).toMatch(/^hgov_/);
    }
  });

  it('has no DROP or DELETE in the bootstrap at all', () => {
    const ddl = ddlFromSchemaModule().toUpperCase();
    expect(ddl).not.toContain('DROP ');
    expect(ddl).not.toContain('DELETE ');
    expect(ddl).not.toContain('TRUNCATE');
  });

  it('reaches into no table another HORIZON patch owns', () => {
    // The correction this whole file exists to keep honest: this layer READS hzn_* and writes none
    // of it. A CREATE or ALTER naming one would mean two owners for one table.
    expect(ddlFromSchemaModule()).not.toMatch(/(?:CREATE TABLE|ALTER TABLE)[^\n]*\bhzn_/);
  });

  it('every index it creates is on one of its own tables', () => {
    const ddl = ddlFromSchemaModule();
    const idx = ddl.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)/g) || [];
    for (const line of idx) expect(line.split(/\s+/).pop()).toMatch(/^hgov_/);
  });

  /**
   * The floor on indexes is DERIVED from the tables, not typed as a number.
   *
   * It used to read `expect(idx.length).toBeGreaterThan(10)`, written when this file declared eleven
   * tables. Seven of those were deleted as duplicates of concepts other patches already own — the
   * right call, documented at the top of schema.ts — and the assertion was left behind pointing at a
   * shape that no longer exists. A magic number cannot tell the difference between "correctly
   * smaller" and "somebody forgot an index", so it is replaced by the question actually worth
   * asking: does every table have an access path, and is a NEW table forced to declare one?
   */
  it('gives every table an access path beyond a full scan', () => {
    // The one table whose only lookup IS its primary key. hgov_retention_policy is read by
    // record_class (the PK) and listed whole — a handful of rows, one per data class.
    const PRIMARY_KEY_ONLY: readonly string[] = ['hgov_retention_policy'];

    const ddl = ddlFromSchemaModule();
    const indexed = new Set(
      (ddl.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)/g) || [])
        .map((line) => line.split(/\s+/).pop() as string),
    );

    for (const table of GOVERNANCE_TABLES) {
      if (PRIMARY_KEY_ONLY.includes(table)) {
        expect(indexed.has(table)).toBe(false);
        continue;
      }
      expect(indexed.has(table)).toBe(true);
    }
    // And nothing indexed that is not owned here, which the previous test also covers from the
    // other direction.
    for (const table of indexed) expect(GOVERNANCE_TABLES).toContain(table);
  });
});
