// src/lib/foundational/schema.test.ts — the runtime DDL and the operator's SQL file say the same
// thing.
//
// Two copies of a schema is the oldest bug in this repository: db/hr-schema.sql and a runtime
// bootstrap once declared the same table with DIFFERENT SHAPES, whichever ran second was a silent
// no-op, and half the columns never existed. A comment asking two files to stay in step is not a
// mechanism. This is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FOUNDATIONAL_DDL } from './schema';

const mirror = readFileSync(
  fileURLToPath(new URL('../../../db/foundational-schema.sql', import.meta.url)),
  'utf8',
);

/** Statements, stripped of comments and whitespace, so formatting differences do not read as drift. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

describe('the runtime DDL and db/foundational-schema.sql', () => {
  const runtime = statements(FOUNDATIONAL_DDL);
  const file = statements(mirror);

  it('declare exactly the same statements', () => {
    expect([...file].sort()).toEqual([...runtime].sort());
  });

  it('create the five tables this patch owns and no others', () => {
    const tables = runtime
      .filter((s) => s.startsWith('create table'))
      .map((s) => /create table if not exists (\w+)/.exec(s)?.[1]);
    expect(tables.sort()).toEqual([
      'fpc_computation', 'fpc_consent', 'fpc_factor', 'fpc_period', 'fpc_subject_input',
    ]);
  });

  it('are idempotent throughout, so the batch is safe to re-run', () => {
    for (const s of runtime) {
      expect(s).toMatch(/^create (table|unique index|index) if not exists/);
    }
  });

  it('contain no ALTER, which is what makes a single-transaction batch safe here', () => {
    // An ALTER takes its ACCESS EXCLUSIVE lock BEFORE it evaluates IF NOT EXISTS and holds it for
    // the length of the whole batch. That is how a schema bootstrap took this site down.
    expect(FOUNDATIONAL_DDL.toLowerCase()).not.toContain('alter table');
  });

  it('cast no subject id to uuid — this patch does not own an identity space', () => {
    expect(FOUNDATIONAL_DDL.toLowerCase()).not.toContain('subject_id uuid');
    expect(mirror.toLowerCase()).not.toContain('subject_id uuid');
  });
});
