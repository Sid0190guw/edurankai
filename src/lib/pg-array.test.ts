// Tests for the array-membership fragments — rendered, not described.
//
// =================================================================================================
// WHY THESE RENDER THE SQL INSTEAD OF ASSERTING ON THE HELPERS
// =================================================================================================
//
// This project has now been bitten TWICE by the same class of mistake, and both times the code read
// correctly. PgDialect turns a drizzle template into the exact string and parameter list that would
// go to Postgres, with no database anywhere near it — so these tests check the thing that actually
// gets executed.
//
// FIRST BITE: `= ANY(${jsArray})` renders as `= ANY(($1, $2))`. That is a RECORD literal, not an
// array, and Postgres answers "op ANY/ALL (array) requires array on right side". Forty-nine of these
// were live, every one inside a swallowing catch.
//
// SECOND BITE, while fixing the first: writing `IN (${uuidIn(xs)})` renders as `IN ((SELECT ...))`.
// The helper already carries its own parentheses, so the extra pair turns the subquery into a
// one-element list holding a SCALAR subquery. Postgres then answers "more than one row returned by
// a subquery used as an expression" — but ONLY when the list has two or more entries, so it passes
// every single-item test and fails in production. The correct call is `IN ${uuidIn(xs)}`.
//
// Both failures are invisible in review and obvious in the rendered SQL, which is why this file
// exists.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { describe, it, expect, report } from './test-shim';
import { textIn, uuidIn, textArray } from './pg-array';

const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

describe('the rendered SQL', () => {
  it('produces a subquery with exactly one level of parentheses', () => {
    const q = render(sql`SELECT 1 FROM t WHERE id IN ${uuidIn(['a', 'b'])}`);
    expect(q.sql.includes('IN (SELECT')).toBe(true);
    // The shape that fails only on lists of two or more.
    expect(q.sql.includes('IN ((SELECT')).toBe(false);
  });

  it('sends the whole list as ONE parameter, not one per item', () => {
    // The point of the JSON round trip: a statement whose parameter count does not grow with the
    // list cannot hit the parameter limit and needs no escaping of commas, quotes or braces.
    const q = render(sql`SELECT 1 FROM t WHERE id IN ${uuidIn(['a', 'b', 'c', 'd'])}`);
    expect(q.params.length).toBe(1);
    expect(String(q.params[0])).toBe('["a","b","c","d"]');
  });

  it('never renders the record literal that = ANY produced', () => {
    const bad = render(sql`SELECT 1 FROM t WHERE id = ANY(${['a', 'b']})`);
    // Documenting the failure so nobody has to rediscover what it looked like.
    expect(bad.sql.includes('ANY(($1, $2))')).toBe(true);

    const good = render(sql`SELECT 1 FROM t WHERE id IN ${uuidIn(['a', 'b'])}`);
    expect(good.sql.includes('ANY(')).toBe(false);
  });

  it('casts to uuid for uuid columns and leaves text alone', () => {
    expect(render(sql`SELECT 1 WHERE id IN ${uuidIn(['a'])}`).sql.includes('::uuid')).toBe(true);
    expect(render(sql`SELECT 1 WHERE k IN ${textIn(['a'])}`).sql.includes('::uuid')).toBe(false);
  });

  it('renders an empty list to a subquery that matches nothing, not a syntax error', () => {
    // `IN ()` is a syntax error; the subquery form simply returns no rows, which is the same
    // behaviour the old = ANY(empty) had. Callers keep working unchanged.
    const q = render(sql`SELECT 1 FROM t WHERE id IN ${uuidIn([])}`);
    expect(q.sql.includes('IN (SELECT')).toBe(true);
    expect(String(q.params[0])).toBe('[]');
  });

  it('keeps a value with a comma, quote or brace intact', () => {
    // Hand-built '{a,b}' literals break on exactly these, which is why the JSON form was chosen.
    const nasty = 'a,b"c{d}e\f';
    const q = render(sql`SELECT 1 FROM t WHERE k IN ${textIn([nasty])}`);
    expect(JSON.parse(String(q.params[0]))[0]).toBe(nasty);
  });

  it('textArray still writes a real text[] for column writes', () => {
    const q = render(sql`UPDATE t SET tags = ${textArray(['x', 'y'])}`);
    expect(q.sql.includes('array_agg')).toBe(true);
    expect(render(sql`UPDATE t SET tags = ${textArray([])}`).sql.includes("ARRAY[]::text[]")).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// A scan of the source, because the two mistakes above are invisible unless something looks for them.
// -------------------------------------------------------------------------------------------------
function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.astro' || name === 'dist') continue;
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if ((p.endsWith('.ts') || p.endsWith('.astro')) && !p.endsWith('pg-array.test.ts')) acc.push(p);
  }
  return acc;
}
const FILES = sources('src');
const BODY = FILES.map((f) => ({ f, s: readFileSync(f, 'utf8') }));

/** Strip line comments so the documentation of these bugs does not read as an instance of them. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('no live instance of either mistake remains', () => {
  it('nothing interpolates a JS array into = ANY()', () => {
    const bad = BODY.filter((x) => /=\s*ANY\(\$\{/.test(code(x.s))).map((x) => x.f);
    expect(bad.join(', ')).toBe('');
  });

  it('nothing wraps the membership fragment in a second pair of parentheses', () => {
    const bad = BODY.filter((x) => /IN \(\$\{(uuidIn|textIn)\(/.test(code(x.s))).map((x) => x.f);
    expect(bad.join(', ')).toBe('');
  });

  // ADDED 2026-08-24, AFTER THIS SCAN MISSED THREE LIVE INSTANCES FOR MONTHS.
  //
  // The scans above look for `= ANY(${...})` — a READ. The same mistake on a WRITE has no ANY() in
  // it and so matched nothing: kernel_objects.security_labels (store.ts insertObject/updateObject
  // and backup.ts's restore) and edu_search_index.security_labels (search-index.ts reindex) all bound
  // the JS array straight into the template. Rendered by this repo's own PgDialect that is a ROW
  // constructor, so every one of those statements failed — reindex could never write a row, and a
  // restored backup rejected every object. All three sat behind a catch, which is why nothing showed.
  //
  // The invariant is deliberately coarse: a file that WRITES a text[] column must mention textArray.
  // It cannot prove the right value was wrapped, but it cannot be satisfied by accident either.
  it('every file that writes a text[] column goes through textArray', () => {
    const writesArrayColumn = (src: string) =>
      /INSERT INTO[\s\S]{0,600}?security_labels/.test(src) || /SET[\s\S]{0,300}?security_labels\s*=/.test(src);
    const bad = BODY
      .filter((x) => writesArrayColumn(code(x.s)) && !/textArray\(/.test(code(x.s)))
      .map((x) => x.f);
    expect(bad.join(', ')).toBe('');
  });

  it('every file that calls the helpers imports them', () => {
    const bad = BODY
      .filter((x) => /\b(uuidIn|textIn)\(/.test(code(x.s)) && !/from '@\/lib\/pg-array'/.test(x.s))
      .map((x) => x.f)
      .filter((f) => !f.endsWith('pg-array.ts'));
    expect(bad.join(', ')).toBe('');
  });
});

report();
