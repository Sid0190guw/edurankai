// Tests for the public campus intake helpers.
//
// These are the whole defence on six UNAUTHENTICATED write endpoints, so what is tested is the
// refusal side: does a bad value get rejected, or does it reach a column? Every case below is a
// shape that would otherwise be stored and later read back as if somebody had meant it.

import { describe, it, expect, report } from './test-shim';
import { text, email, when, num, overIntakeLimit, intakeBucket, rowsOf } from './campus-intake';

describe('text()', () => {
  it('treats blank as absent so NOT NULL columns still bite', () => {
    // '' would satisfy a NOT NULL constraint and produce a row nobody can act on.
    expect(text('   ', 50)).toBe(null);
    expect(text('', 50)).toBe(null);
  });

  it('refuses anything that is not a string, including numbers and objects', () => {
    expect(text(42 as any, 50)).toBe(null);
    expect(text({} as any, 50)).toBe(null);
    expect(text(null, 50)).toBe(null);
  });

  it('caps length rather than letting a caller size the column', () => {
    expect((text('x'.repeat(9000), 100) || '').length).toBe(100);
  });

  it('trims, because a trailing space is not part of anybody name', () => {
    expect(text('  Shreedevi  ', 50)).toBe('Shreedevi');
  });
});

describe('email()', () => {
  it('accepts an ordinary address and lowercases it', () => {
    expect(email('  Person@Example.IN ')).toBe('person@example.in');
  });

  it('refuses the shapes that would make a reply impossible', () => {
    for (const bad of ['', 'person', 'person@', '@example.in', 'person@example', 'a b@c.in']) {
      expect(email(bad)).toBe(null);
    }
  });
});

describe('when()', () => {
  it('refuses an unparseable date rather than passing it to Postgres', () => {
    // A booking whose slot is 'sometime next week' is not a booking, and the cast would throw
    // inside a catch and read to the candidate as an outage.
    expect(when('sometime next week')).toBe(null);
    expect(when('')).toBe(null);
  });

  it('normalises a real timestamp', () => {
    expect(String(when('2026-08-20T10:00:00+05:30'))).toContain('2026-08-20');
  });
});

describe('num()', () => {
  it('clamps instead of refusing, because a slider out of range is not a lie', () => {
    expect(num(500, 0.25, 48)).toBe(48);
    expect(num(0, 0.25, 48)).toBe(0.25);
  });

  it('refuses what is not a number at all', () => {
    expect(num('lots', 0, 10)).toBe(null);
    expect(num(undefined, 0, 10)).toBe(null);
  });
});

// tooFast() now counts in the database, so the counting itself cannot be exercised here — this
// suite has no mock layer and this project does not connect to a database from a test. What used to
// be tested was an in-process Map, which is precisely the part that did not work in production, so
// asserting on it was worse than not asserting at all. The two halves that ARE pure are tested
// instead, and the counting is covered by countAttempt() being the single shared implementation.
describe('overIntakeLimit()', () => {
  it('lets an ordinary submission through', () => {
    expect(overIntakeLimit(1)).toBe(false);
    expect(overIntakeLimit(6)).toBe(false);
  });

  it('trips once the window allowance is spent', () => {
    expect(overIntakeLimit(7)).toBe(true);
    expect(overIntakeLimit(120)).toBe(true);
  });
});

describe('intakeBucket()', () => {
  it('does not punish a second person for the first one flooding', () => {
    // Different origins must land in different buckets, or one flooder locks out everybody.
    expect(intakeBucket('c', 'flooder') === intakeBucket('c', 'somebody-else')).toBe(false);
  });

  it('keeps separate forms separate', () => {
    expect(intakeBucket('commons', 'someone') === intakeBucket('forge', 'someone')).toBe(false);
  });

  it('is stable for one origin, or the count would never accumulate', () => {
    expect(intakeBucket('c', 'someone') === intakeBucket('c', 'someone')).toBe(true);
  });

  it('does not carry the raw origin, so the table is not a visitor log', () => {
    expect(intakeBucket('c', 'someone@example.com').includes('someone@example.com')).toBe(false);
  });
});

describe('rowsOf()', () => {
  it('handles the plain array postgres-js actually returns', () => {
    // `r.rows[0]` is the bug this normaliser exists to prevent.
    expect(rowsOf([{ id: 1 }]).length).toBe(1);
    expect(rowsOf({ rows: [{ id: 1 }] }).length).toBe(1);
    expect(rowsOf(null).length).toBe(0);
  });
});

report();
