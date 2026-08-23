// src/lib/talentos/codes.test.ts — the authorization code's format, entropy and normalisation.
//
// These are the tests that matter most in this module, because the authorization code is a BEARER
// CREDENTIAL that a person types from a letter. Two failure modes are being guarded against:
//
//   1. THE CODE QUIETLY GETS WEAKER. Someone shortens a group to make the code prettier, or swaps
//      the alphabet for something with 16 characters in it, and the entropy drops by half with no
//      test failing. AUTH_CODE_ENTROPY_BITS is asserted as a literal number for exactly that reason.
//
//   2. NORMALISATION STOPS BEING TOTAL. A code that verifies when typed one way and fails when
//      typed another is indistinguishable, to the person holding it, from a revoked one. Every
//      transformation a human applies by accident — lower case, O for zero, I for one, missing or
//      extra dashes, a copy-paste with trailing whitespace — must land on the same hash.
//
// No database is touched here. codes.ts resolves the db handle lazily precisely so that this file
// can run with no connection; the organisation-graph work already paid for the lesson that a
// transitive db import makes pure logic untestable.
import { describe, it, expect } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  AUTH_CODE_ENTROPY_BITS,
  AUTH_CODE_GROUPS,
  AUTH_CODE_GROUP_LEN,
  generateAuthCode,
  hashAuthCode,
  looksLikeAuthCode,
  normaliseAuthCode,
  isUniqueViolation,
  PERSON_CODE_PREFIX,
} from './codes';

describe('Crockford alphabet', () => {
  it('has 32 characters', () => {
    expect(CROCKFORD_ALPHABET.length).toBe(32);
  });

  it('excludes the four look-alike letters', () => {
    for (const c of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET.includes(c)).toBe(false);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(CROCKFORD_ALPHABET.split('')).size).toBe(32);
  });
});

describe('authorization code entropy', () => {
  // If this number ever goes down, someone has made the credential easier to guess. At 60 bits,
  // 200 codes live at once and 10,000 guesses an hour, expected time to the first hit is about 66
  // million years. At 25 bits — one group, as in the originating brief's example — the same attack
  // finishes in under a day, and a hit means one stranger reaching another person's onboarding form.
  it('is 60 bits and has not shrunk', () => {
    expect(AUTH_CODE_ENTROPY_BITS).toBe(60);
    expect(AUTH_CODE_GROUPS * AUTH_CODE_GROUP_LEN * 5).toBe(AUTH_CODE_ENTROPY_BITS);
  });

  it('produces the documented display shape', () => {
    const c = generateAuthCode(2026, 'POM');
    expect(c.display).toMatch(/^ERAI-SEL-ONB-26-POM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(c.displayPrefix).toBe('ERAI-SEL-ONB-26-POM');
    expect(c.last4.length).toBe(4);
  });

  it('draws only from the Crockford alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const secret = generateAuthCode(2026, 'POM').display.split('-').slice(5).join('');
      for (const ch of secret) expect(CROCKFORD_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('does not repeat itself across many mints', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateAuthCode(2026, 'POM').display);
    expect(seen.size).toBe(500);
  });

  it('never returns the plaintext as the stored value', () => {
    const c = generateAuthCode(2026, 'POM');
    expect(c.hash).not.toBe(c.display);
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to mint without an opportunity code', () => {
    expect(() => generateAuthCode(2026, '')).toThrow();
    expect(() => generateAuthCode(2026, '---')).toThrow();
  });

  it('strips separators out of a mis-configured opportunity code', () => {
    // A code containing a dash would make the format ambiguous to read back.
    const c = generateAuthCode(2026, 'P-O-M');
    expect(c.displayPrefix).toBe('ERAI-SEL-ONB-26-POM');
  });
});

describe('normalisation is total', () => {
  const canonical = 'ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD';
  const expected = normaliseAuthCode(canonical);

  const variants: Array<[string, string]> = [
    ['lower case', 'erai-sel-onb-26-pom-7x4k-9m2t-b3vd'],
    ['no separators', 'ERAISELONB26POM7X4K9M2TB3VD'],
    ['spaces instead of dashes', 'ERAI SEL ONB 26 POM 7X4K 9M2T B3VD'],
    ['leading and trailing whitespace', '  ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD\n'],
    ['mixed case with stray dots', 'Erai.Sel.Onb.26.Pom.7x4k.9m2t.b3vd'],
  ];

  for (const [name, input] of variants) {
    it('accepts ' + name, () => {
      expect(normaliseAuthCode(input)).toBe(expected);
      expect(hashAuthCode(input)).toBe(hashAuthCode(canonical));
    });
  }

  it('maps the look-alike characters a person actually types', () => {
    // O for zero, I and l for one, U for V — the Crockford decode rules.
    expect(normaliseAuthCode('O')).toBe('0');
    expect(normaliseAuthCode('I')).toBe('1');
    expect(normaliseAuthCode('l')).toBe('1');
    expect(normaliseAuthCode('u')).toBe('V');
  });

  it('is idempotent', () => {
    const once = normaliseAuthCode(canonical);
    expect(normaliseAuthCode(once)).toBe(once);
  });

  it('handles empty and non-string input without throwing', () => {
    expect(normaliseAuthCode('')).toBe('');
    expect(normaliseAuthCode(undefined as any)).toBe('');
    expect(normaliseAuthCode(null as any)).toBe('');
  });

  it('gives different codes different hashes', () => {
    expect(hashAuthCode('ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD'))
      .not.toBe(hashAuthCode('ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VE'));
  });

  it('binds the opportunity segment into the hash', () => {
    // A code for one opportunity must not hash to the same value as the same secret issued for
    // another. This is the format-level half of "a code for job A does not authorise job B"; the
    // other half is the opportunity check in the validation ladder.
    expect(hashAuthCode('ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD'))
      .not.toBe(hashAuthCode('ERAI-SEL-ONB-26-DEI-7X4K-9M2T-B3VD'));
  });
});

describe('cheap shape check', () => {
  it('accepts a freshly minted code in any typed form', () => {
    const c = generateAuthCode(2026, 'POM');
    expect(looksLikeAuthCode(c.display)).toBe(true);
    expect(looksLikeAuthCode(c.display.toLowerCase())).toBe(true);
    expect(looksLikeAuthCode(c.display.replace(/-/g, ''))).toBe(true);
  });

  it('accepts a long opportunity code', () => {
    expect(looksLikeAuthCode(generateAuthCode(2026, 'RESEARCH').display)).toBe(true);
  });

  it('rejects obvious rubbish before any database lookup', () => {
    expect(looksLikeAuthCode('')).toBe(false);
    expect(looksLikeAuthCode('hello')).toBe(false);
    expect(looksLikeAuthCode('ERA-EMP-0001')).toBe(false);
    expect(looksLikeAuthCode('ERAI-SEL-ONB-26-POM')).toBe(false);          // no secret at all
    expect(looksLikeAuthCode('ERAI-SEL-ONB-26-POM-7X4K-9M2T')).toBe(false); // one group short
  });

  it('rejects a code whose secret is too long to be ours', () => {
    expect(looksLikeAuthCode('ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD-9999999999')).toBe(false);
  });
});

describe('unique violation detection', () => {
  // postgres-js puts the driver error on e.cause; e.message is the failed SQL. Reading e.code alone
  // is how a retry loop silently stops retrying.
  it('reads the code from e.cause', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });

  it('still reads a top-level code', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('does not treat other failures as collisions', () => {
    expect(isUniqueViolation({ cause: { code: '42703' } })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('sequence code prefixes', () => {
  it('keeps the person prefix distinct from the existing employee series', () => {
    // hr_employees uses ERA-EMP-; a person is ERAI-P-. They must not collide, and the regexes that
    // derive MAX from each must not match the other's rows.
    expect(PERSON_CODE_PREFIX).toBe('ERAI-P-');
    expect(/^ERA-EMP-[0-9]+$/.test('ERAI-P-000001')).toBe(false);
    expect(/^ERAI-P-[0-9]+$/.test('ERA-EMP-0001')).toBe(false);
  });
});
