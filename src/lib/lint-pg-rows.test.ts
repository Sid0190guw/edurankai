/**
 * The `pg-rows` rule has to be right in BOTH directions, and it has already been wrong in both.
 *
 * `r.rows[0]` on a postgres-js result is one of this project's named outage causes: the driver
 * returns a plain array, `.rows` is undefined, and the read silently yields nothing while the page
 * renders a confident empty state. So the rule has to fire on that.
 *
 * But it also has to stay silent on the shape almost every read in this codebase actually uses:
 *
 *     const res = await safeRows('label', () => db.execute(sql`...`));
 *     res.rows.map(...)
 *
 * `safeRows` returns `{ ok, rows }` with `rows` already normalised through `toRows()`. The rule used
 * to ask only whether `db.execute(` appeared ANYWHERE in the right-hand side, so it called all of
 * those errors — 38 of them across src/, every one correct code. That is worse than having no rule:
 * it made `--all` unrunnable, so the rest of the repository was never checked for the real fault,
 * and it trains a reader to wave the rule through.
 *
 * These fixtures are the two directions written down. Widen the rule back to a substring test and
 * the "stays silent on a safeRows result" cases fail; disable or narrow it past the real fault and
 * the "fires on a driver result" cases fail.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Run the linter over one fixture file and return the rule ids it reported, in order. */
function lint(filename: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'lint-pg-rows-'));
  try {
    const file = join(dir, filename);
    writeFileSync(file, source, 'utf8');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/lint-mail.mjs'), relative(ROOT, file)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return [...out.matchAll(/^\s+(?:error|warn)\s+\S+:(\d+)\s+(\S+)/gm)].map((m) => `${m[2]}:${m[1]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('lint-mail pg-rows', () => {
  it('fires on a driver result read with .rows', () => {
    const found = lint(
      'driver.ts',
      [
        'export async function bad(db: any, sql: any) {',
        '  const r = await db.execute(sql`SELECT 1`);',
        '  return r.rows[0];', // lint-mail-ignore: pg-rows — a fixture OF the fault, asserted on below
        '}',
        '',
      ].join('\n'),
    );
    expect(found).toContain('pg-rows:3');
  });

  it('stays silent on a safeRows result, even though db.execute appears in the same line', () => {
    const found = lint(
      'wrapped.ts',
      [
        "import { safeRows } from '@/lib/page-safety';",
        'export async function good(db: any, sql: any) {',
        "  const res = await safeRows('label', () => db.execute(sql`SELECT 1`));",
        '  return res.rows.map((x: any) => x.id);',
        '}',
        '',
      ].join('\n'),
    );
    expect(found.filter((f) => f.startsWith('pg-rows'))).toEqual([]);
  });

  it('stays silent on a safeRows call whose db.execute is on a later line', () => {
    const found = lint(
      'wrapped-multiline.ts',
      [
        "import { safeRows } from '@/lib/page-safety';",
        'export async function good(db: any, sql: any) {',
        "  const res = await safeRows('label', () =>",
        '    db.execute(sql`SELECT 1`));',
        '  return res.rows.length;',
        '}',
        '',
      ].join('\n'),
    );
    expect(found.filter((f) => f.startsWith('pg-rows'))).toEqual([]);
  });

  it('still fires through withDbRetry, which returns the driver result unchanged', () => {
    const found = lint(
      'retry.ts',
      [
        "import { withDbRetry } from '@/lib/db-timeout';",
        'export async function bad(db: any, sql: any) {',
        "  const r = await withDbRetry(() => db.execute(sql`SELECT 1`), 'label');",
        '  return r.rows[0];', // lint-mail-ignore: pg-rows — a fixture OF the fault, asserted on below
        '}',
        '',
      ].join('\n'),
    );
    expect(found).toContain('pg-rows:4');
  });

  it('does not carry a driver name over to a later, correctly-wrapped assignment', () => {
    const found = lint(
      'rebound.ts',
      [
        "import { safeRows } from '@/lib/page-safety';",
        'export async function mixed(db: any, sql: any) {',
        '  let r: any = await db.execute(sql`SELECT 1`);',
        '  const first = Array.isArray(r) ? r : r?.rows || [];',
        "  r = await safeRows('label', () => db.execute(sql`SELECT 2`));",
        '  return [first, r.rows];', // lint-mail-ignore: pg-rows — fixture text, not a live read
        '}',
        '',
      ].join('\n'),
    );
    expect(found.filter((f) => f.startsWith('pg-rows'))).toEqual([]);
  });
});
