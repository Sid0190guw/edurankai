// The scale primitives, tested where they can actually be got wrong.
//
// =================================================================================================
// WHAT THESE TESTS ARE GUARDING
// =================================================================================================
//
// Not "does idEq() build a string". The failure mode this module exists to prevent is silent: a
// predicate that returns the RIGHT ROWS by the WRONG PLAN. Nothing in a test suite, a code review or
// a staging environment with two hundred employees can see the difference — the page renders, the
// numbers are correct, and the query takes forty minutes on a table with ten million rows in it.
//
// So what is asserted here is the SHAPE of the SQL, because the shape is the plan:
//
//   `employee_id::text = $1`  -> sequential scan, always, whatever indexes exist
//   `employee_id = $1`        -> index seek
//
// and the two are indistinguishable by result. A regression that puts the cast back would pass every
// other test in this repository.
//
// The cursor tests are the other half: a paging cursor arrives from a URL, so it is untrusted input
// that is spliced into a WHERE clause. `decodeCursor` returning null for anything malformed is what
// makes keysetAfter() emit `true` (page one) rather than a broken predicate — and the uuid check in
// it is what stops a hand-typed cursor from reaching Postgres as a value it will refuse to bind.

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  isUuid, idEq, idIn, probeMore, countLabel,
  encodeCursor, decodeCursor, keysetAfter,
  prefixPattern, containsPattern, MIN_SEARCH_CHARS, COUNT_CEILING,
} from './scale';

const dialect = new PgDialect();

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const UUID2 = '9c858901-8a57-4791-81fe-4c455b099bc9';

/**
 * The generated SQL as a plain string, with parameters rendered as $1, $2, ... — which is what the
 * planner sees and therefore the only thing worth asserting on.
 */
function text(fragment: any): string {
  // Drizzle's own dialect renders the fragment exactly as Postgres will receive it — literal SQL as
  // literal SQL, bound values as $1, $2. Reverse-engineering the chunk list by hand is possible and
  // wrong: a Param and a StringChunk are not reliably distinguishable across drizzle versions, and a
  // test that mistakes one for the other asserts on a statement nobody will ever execute.
  return dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim();
}

describe('idEq keeps the cast off the column', () => {
  it('compares a uuid without casting the column, so the index can answer it', () => {
    const out = text(idEq(sql`employee_id`, UUID));
    expect(out).toBe('employee_id = $1');
    // The regression that matters: any reappearance of a cast on the left-hand side.
    expect(out.includes('::text')).toBe(false);
  });

  it('still compares as text for a non-uuid key, because departments.id may be a slug', () => {
    // db/hr-schema.sql declares departments.id UUID; src/lib/db/schema.ts declares varchar(50).
    // A slug must keep working, and `$1::uuid` would throw on it.
    expect(text(idEq(sql`e.department_id`, 'engineering'))).toBe('e.department_id::text = $1');
  });

  it('fails closed on a blank id rather than matching everything', () => {
    // The WHOLE fragment is `false`, not `column = false`: it is spliced into a WHERE clause, and
    // `false` there is a predicate that matches no rows and costs nothing to plan.
    expect(text(idEq(sql`employee_id`, ''))).toBe('false');
    expect(text(idEq(sql`employee_id`, null))).toBe('false');
    expect(text(idEq(sql`employee_id`, undefined))).toBe('false');
  });

  it('trims, because an id read out of a query string can carry whitespace', () => {
    expect(text(idEq(sql`id`, '  ' + UUID + '  '))).toBe('id = $1');
  });
});

describe('isUuid refuses anything Postgres would refuse to bind', () => {
  it('accepts the canonical form in either case', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
  });

  it('rejects the uuid-ISH shapes that would throw at bind time', () => {
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c330')).toBe(false);   // one short
    expect(isUuid('3f2504e04f8911d39a0c0305e82c3301')).toBe(false);      // no hyphens
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('idIn drops malformed entries instead of degrading the whole statement', () => {
  it('builds a parameterised IN list over the well-formed ids', () => {
    // NOT `= ANY(...)`. Drizzle expands a JS array into a parameter LIST, so `= ANY(${list})`
    // renders `= ANY(($1, $2))` — a row constructor Postgres rejects. This assertion is the guard
    // against somebody "tidying" it back.
    expect(text(idIn(sql`id`, [UUID, UUID2]))).toBe('id IN ($1, $2)');
  });

  it('keeps the good ids when one entry is rubbish', () => {
    // The alternative — falling back to a text comparison because ONE entry was bad — would turn a
    // bulk read into a scan, which is the exact failure this module exists to prevent.
    expect(text(idIn(sql`id`, [UUID, 'nonsense', '']))).toBe('id IN ($1)');
  });

  it('matches nothing when every entry is unusable', () => {
    expect(text(idIn(sql`id`, ['nonsense']))).toBe('false');
    expect(text(idIn(sql`id`, []))).toBe('false');
  });
});

describe('probeMore answers "is there more" from one extra row, not a count', () => {
  it('reports more when the extra row came back', () => {
    const r = probeMore([1, 2, 3, 4, 5, 6, 7, 8, 9], 8);
    expect(r.items.length).toBe(8);
    expect(r.hasMore).toBe(true);
  });

  it('reports no more when the page was not filled', () => {
    const r = probeMore([1, 2, 3], 8);
    expect(r.items.length).toBe(3);
    expect(r.hasMore).toBe(false);
  });

  it('reports no more on an exactly-full page, because cap+1 is what proves it', () => {
    // The subtle one. Fetching exactly `cap` rows tells you nothing about row cap+1 — which is why
    // the caller must ask for cap+1 and why this returns false here rather than guessing.
    const r = probeMore([1, 2, 3, 4, 5, 6, 7, 8], 8);
    expect(r.hasMore).toBe(false);
  });
});

describe('countLabel never invents a number it did not read', () => {
  it('prints the exact count below the ceiling', () => {
    expect(countLabel({ count: 12, atLeast: false, ok: true })).toBe('12');
  });

  it('marks a ceilinged count as a floor', () => {
    expect(countLabel({ count: COUNT_CEILING, atLeast: true, ok: true })).toBe(COUNT_CEILING + '+');
  });

  it('says nothing at all when the read failed', () => {
    // NOT "0". A zero here is a claim that there is nothing, made by a query that did not run.
    expect(countLabel({ count: 0, atLeast: false, ok: false })).toBe('');
    expect(countLabel(null)).toBe('');
    expect(countLabel(undefined)).toBe('');
  });
});

describe('cursors round-trip and reject everything else', () => {
  it('round-trips a sort value and an id', () => {
    const c = encodeCursor('Sharma, Priya', UUID);
    expect(decodeCursor(c)).toEqual({ sort: 'Sharma, Priya', id: UUID });
  });

  it('survives the characters a real name contains', () => {
    const name = 'D’Souza, Renée "RJ"';
    expect(decodeCursor(encodeCursor(name, UUID))?.sort).toBe(name);
  });

  it('returns null for a cursor whose id is not a uuid', () => {
    // This is the one that matters: the id half is compared against a uuid column, so letting a
    // hand-typed value through would reach Postgres and throw at bind time — a 500 on a page
    // somebody reached by editing the URL.
    expect(decodeCursor(encodeCursor('name', 'not-a-uuid'))).toBe(null);
  });

  it('returns null for junk, empty and oversized input', () => {
    expect(decodeCursor('!!!!')).toBe(null);
    expect(decodeCursor('')).toBe(null);
    expect(decodeCursor(null)).toBe(null);
    expect(decodeCursor('a'.repeat(600))).toBe(null);
  });

  it('returns null for a well-formed base64 payload of the wrong shape', () => {
    const bad = Buffer.from(JSON.stringify({ sort: 'x', id: UUID }), 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBe(null);
  });
});

describe('keysetAfter is a row comparison, and page one has no predicate', () => {
  it('emits the composite comparison the ordering index can answer', () => {
    const out = text(keysetAfter(sql`e.full_name`, sql`e.id`, encodeCursor('Sharma', UUID)));
    expect(out).toBe('(e.full_name, e.id) > ($1, $2::uuid)');
  });

  it('emits true — never a broken predicate — for a missing or malformed cursor', () => {
    expect(text(keysetAfter(sql`e.full_name`, sql`e.id`, null))).toBe('true');
    expect(text(keysetAfter(sql`e.full_name`, sql`e.id`, 'garbage'))).toBe('true');
  });
});

describe('search patterns escape the LIKE metacharacters', () => {
  it('anchors a prefix search', () => {
    expect(prefixPattern('sha')).toBe('sha%');
  });

  it('lets somebody search for a literal percent sign', () => {
    // Without the escape, "100%" matches every row: the % is the wildcard.
    expect(prefixPattern('100%')).toBe('100\\%%');
    expect(containsPattern('100%')).toBe('%100\\%%');
  });

  it('escapes the underscore, which is the single-character wildcard', () => {
    expect(containsPattern('a_b')).toBe('%a\\_b%');
  });

  it('keeps a minimum term length, because a one-character substring selects nothing', () => {
    expect(MIN_SEARCH_CHARS).toBeGreaterThanOrEqual(2);
  });
});
