// THE GUARD ON THE HAND-RUN MIGRATION SPLITTER.
//
// scripts/apply-sql.mjs is how every migration in db/ actually reaches the database on this project
// — psql is not installed on the machine the migrations are run from. It sends statements one at a
// time and continues past failures, which is the right behaviour for idempotent files and is also
// what made the bug below survive: a shredded `DO $$ ... $$` block reports as a few failed lines in
// an otherwise green run, and the thing the block was guarding silently did not happen.
//
// The splitter is tested against the REAL files in db/, not fixtures. A fixture proves the function
// handles the case somebody thought of; db/*.sql is what will actually be pasted into it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitStatements } from '../../scripts/sql-split.mjs';

const dbDir = fileURLToPath(new URL('../../db/', import.meta.url));
const sqlFiles = readdirSync(dbDir).filter((f) => f.endsWith('.sql'));
const read = (f: string) => readFileSync(dbDir + f, 'utf8');

describe('dollar-quoted blocks survive as one statement', () => {
  // The regression, stated as the shape it actually took.
  it('keeps a DO block whole instead of splitting it at its inner semicolons', () => {
    const [stmt, ...rest] = splitStatements(`
      DO $$
      BEGIN
        IF to_regclass('public.t') IS NOT NULL THEN
          ALTER TABLE t ADD CONSTRAINT c FOREIGN KEY (a) REFERENCES u(id);
        END IF;
      EXCEPTION WHEN others THEN
        RAISE NOTICE 'not added: %', SQLERRM;
      END $$;
    `);
    expect(rest).toEqual([]);
    expect(stmt.startsWith('DO $$')).toBe(true);
    expect(stmt.endsWith('END $$')).toBe(true);
    // The four fragments the old splitter produced. None of these may ever be a statement again.
    expect(stmt).toContain('END IF;');
    expect(stmt).toContain('EXCEPTION WHEN others THEN');
  });

  it('every dollar-quoted block in db/ stays in exactly one statement', () => {
    const broken: string[] = [];
    for (const f of sqlFiles) {
      const src = read(f);
      if (!src.includes('$$')) continue;
      for (const stmt of splitStatements(src)) {
        // A statement may contain zero `$$` (ordinary SQL) or an even number (whole blocks). An odd
        // count means a block was cut in half, which is precisely the defect.
        const markers = (stmt.match(/\$\$/g) || []).length;
        if (markers % 2 !== 0) broken.push(f + ' -> ' + stmt.slice(0, 60).replace(/\s+/g, ' '));
      }
    }
    expect(broken.join(' | ')).toBe('');
  });

  it('handles a custom dollar tag, and does not close on a different one', () => {
    const out = splitStatements(`DO $fn$ BEGIN PERFORM 1; END $fn$; SELECT 2;`);
    expect(out.length).toBe(2);
    expect(out[0]).toContain('PERFORM 1;');
    expect(out[1]).toBe('SELECT 2');
  });
});

describe('quotes and comments', () => {
  it('a semicolon inside a string does not split', () => {
    const out = splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`);
    expect(out.length).toBe(2);
    expect(out[0]).toContain("'a;b'");
  });

  it('a doubled quote inside a string needs no special case', () => {
    const out = splitStatements(`SELECT 'it''s fine; really'; SELECT 2;`);
    expect(out.length).toBe(2);
    expect(out[0]).toContain("it''s fine; really");
  });

  it('strips line comments but not a double dash inside a string', () => {
    const out = splitStatements(`SELECT 1; -- a comment with ; in it\nSELECT '--not a comment';`);
    expect(out.length).toBe(2);
    expect(out[0]).toBe('SELECT 1');
    expect(out[1]).toContain("'--not a comment'");
  });

  it('does not treat a comment inside a dollar body as a comment terminator', () => {
    const out = splitStatements(`DO $$ BEGIN -- note; here\n PERFORM 1; END $$;`);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('-- note; here');
  });

  it('returns a trailing statement that has no final semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('produces no empty statements from blank lines or stray semicolons', () => {
    expect(splitStatements(';;\n\n-- only a comment\n;')).toEqual([]);
  });
});

describe('every file in db/ still parses into something runnable', () => {
  it('no statement is empty and none is a bare block keyword', () => {
    // `END IF`, `EXCEPTION WHEN ...` and `END $$` on their own were what the old splitter emitted.
    //
    // A bare `BEGIN` or `END` is NOT in that list, and must not be: eight files in db/ wrap
    // themselves in an explicit `BEGIN; ... COMMIT;`, and `END` is Postgres's synonym for COMMIT.
    // Those are real statements. Only the PL/pgSQL keywords that cannot stand alone are flagged.
    const bad: string[] = [];
    for (const f of sqlFiles) {
      for (const stmt of splitStatements(read(f))) {
        const head = stmt.replace(/\s+/g, ' ').trim();
        if (!head) bad.push(f + ' -> empty');
        if (/^(END IF|EXCEPTION WHEN|ELSE|ELSIF)\b/i.test(head)) bad.push(f + ' -> fragment: ' + head);
      }
    }
    expect(bad.join(' | ')).toBe('');
  });
});
