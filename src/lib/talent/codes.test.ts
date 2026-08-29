// src/lib/talent/codes.test.ts — the code FORMAT, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. codes.ts resolves its database handle lazily inside
// ctx(), so importing normaliseCode() must not require DATABASE_URL. If that ever regresses —
// somebody adds a module-scope `import { db }` — this file fails at COLLECTION rather than on an
// assertion, which is the signal wanted.
//
// WHY THIS FILE EXISTS NOW. The display prefix was added to formatSecret() and taught to
// normaliseCode() after /apply/gateway was found promising candidates a format that issueCode() had
// never minted: the page said "a code beginning ERA-SEL" in three groups of four, while the module
// produced a bare fifteen-character body in three groups of five. Reconciling the two touched the
// only function that decides whether a code is even the shape of a code, which is not a function to
// change on a build passing and nothing else.
import { describe, it, expect } from 'vitest';
import {
  normaliseCode, formatSecret, formatProblem, generateSecret, hashCode, codePrefixOf,
  CODE_ALPHABET, CODE_BODY_LEN, CODE_GROUP_LEN, CODE_DISPLAY_PREFIX,
} from '@/lib/talent/codes';

const BODY = 'ABCDE23456FGHJK'; // 15 characters, every one of them in CODE_ALPHABET.

describe('the alphabet', () => {
  it('is 32 unambiguous symbols', () => {
    expect(CODE_ALPHABET.length).toBe(32);
    expect(new Set(CODE_ALPHABET).size).toBe(32);
  });

  it('excludes only the pairs that are actually confusable in print: I/1 and O/0', () => {
    for (const ch of ['I', 'O', '0', '1']) expect(CODE_ALPHABET.includes(ch)).toBe(false);
  });

  // THE BUG THIS PINS. /apply/gateway told candidates their code could not contain L, and the
  // comment above CODE_ALPHABET said the same. L is in the alphabet, so a candidate holding a
  // perfectly good code was being told they had mistyped it. Removing L instead would have made
  // every already-issued code containing one unredeemable, so the alphabet is canonical.
  it('includes L, which the candidate-facing copy used to deny', () => {
    expect(CODE_ALPHABET.includes('L')).toBe(true);
    expect(normaliseCode('LLLLL-LLLLL-LLLLL')).toBe('LLLLLLLLLLLLLLL');
  });
});

describe('formatSecret', () => {
  it('shows the prefix and three groups of five', () => {
    expect(formatSecret(BODY)).toBe('ERA-SEL-ABCDE-23456-FGHJK');
    expect(formatSecret(BODY).startsWith(CODE_DISPLAY_PREFIX)).toBe(true);
  });

  // A bare "ERA-SEL" in the issue banner would read to an operator as a code that had been minted.
  it('leaves an empty body empty rather than emitting a bare prefix', () => {
    expect(formatSecret('')).toBe('');
  });

  it('round-trips through normaliseCode', () => {
    for (let i = 0; i < 50; i++) {
      const body = generateSecret();
      expect(body.length).toBe(CODE_BODY_LEN);
      expect(normaliseCode(formatSecret(body))).toBe(body);
    }
  });
});

describe('normaliseCode', () => {
  it('accepts the displayed form, with or without the prefix', () => {
    expect(normaliseCode('ERA-SEL-ABCDE-23456-FGHJK')).toBe(BODY);
    expect(normaliseCode('ABCDE-23456-FGHJK')).toBe(BODY);
    expect(normaliseCode(BODY)).toBe(BODY);
  });

  // Every code issued before the prefix existed was shared as a bare body. Those must still redeem:
  // the hash is taken over the body alone, so nothing about them changed except how new ones print.
  it('still accepts a code issued before the prefix existed', () => {
    expect(normaliseCode('abcde 23456 fghjk')).toBe(BODY);
  });

  it('forgives case, spacing and whatever dash a mail client substituted', () => {
    expect(normaliseCode('  era-sel abcde\t23456–fghjk ')).toBe(BODY);
  });

  // THE SAFETY ARGUMENT FOR THE PREFIX STRIP. E, R, A, S and L are all in CODE_ALPHABET, so a real
  // body may begin with the letters ERASEL. Stripping only when what remains is exactly
  // CODE_BODY_LEN keeps the two cases apart: this body is 15 characters, so nothing is removed.
  it('does not eat six real characters from a body that begins with ERASEL', () => {
    const tricky = 'ERASEL234567JKM'; // 15 characters, starts with the prefix letters.
    expect(tricky.length).toBe(CODE_BODY_LEN);
    expect(normaliseCode(tricky)).toBe(tricky);
    expect(normaliseCode(formatSecret(tricky))).toBe(tricky);
  });

  it('rejects anything that is not a code shape', () => {
    expect(normaliseCode('')).toBeNull();
    expect(normaliseCode('ABCDE-23456')).toBeNull();
    expect(normaliseCode('ERA-SEL-ABCDE-23456')).toBeNull();
    expect(normaliseCode(BODY + 'X')).toBeNull();
  });

  // The one kindness it must never do. A code containing O or 1 was never issued by us, so rewriting
  // it to 0 or I turns a typo into a DIFFERENT guess against the rate limiter.
  it('never auto-corrects an excluded character', () => {
    expect(normaliseCode('ABCDE-23456-FGHJ0')).toBeNull();
    expect(normaliseCode('ABCDE-23456-FGHJ1')).toBeNull();
    expect(normaliseCode('IBCDE-23456-FGHJK')).toBeNull();
  });
});

describe('formatProblem', () => {
  it('says nothing about a well-formed code, prefixed or not', () => {
    expect(formatProblem(formatSecret(BODY))).toBeNull();
    expect(formatProblem(BODY)).toBeNull();
  });

  // The count is what the candidate acts on, so it must describe the part they can fix rather than
  // including six characters of decoration they were told to type.
  it('counts the body and not the prefix', () => {
    const msg = formatProblem('ERA-SEL-ABCD-EFGH-IJKL') || '';
    expect(msg).toContain('has 12');
    expect(msg).not.toContain('has 18');
  });

  // The code from the screenshot that started this: an invited person typed their ERA-INV code into
  // the only code box on /apply/gateway and was told it "has 21 characters" - true, and useless.
  // The two families are deliberately distinct, so the wrong one gets the right door, not a count.
  it('sends an ERA-INV invitation code to /invite instead of counting its characters', () => {
    const msg = formatProblem('ERA-INV-AMM7R-NFE69-ZMD2C') || '';
    expect(msg).toContain('/invite');
    expect(msg).toContain('invitation code');
    expect(msg).not.toContain('21');
  });

  // The wrong-door branch must not swallow the ordinary length error: only an ERA-INV prefix with a
  // full-length body behind it is an invitation code. Anything else is still just malformed.
  it('still counts characters for a mistyped code that merely starts with those letters', () => {
    expect(formatProblem('ERA-INV-AMM7R-NFE69') || '').toContain('has 10');
  });

  it('names the excluded characters that were actually used, and never names L', () => {
    const msg = formatProblem('ABCDE-23456-FGHI0') || '';
    expect(msg).toContain('"I"');
    expect(msg).toContain('"0"');
    expect(formatProblem('LLLLL-LLLLL-LLLLL')).toBeNull();
  });

  it('asks for a code rather than complaining about length when nothing was entered', () => {
    expect(formatProblem('   ')).toBe('Enter the onboarding code you were sent.');
  });
});

describe('the stored handle', () => {
  // codePrefixOf is what /admin/talent/codes searches on when a candidate reads the first group down
  // the phone. It must be the first group of the BODY — the display prefix is the same on every code
  // and would make the handle useless as a handle.
  it('is the first group of the body, never the display prefix', () => {
    expect(codePrefixOf(BODY)).toBe('ABCDE');
    expect(codePrefixOf(BODY).length).toBe(CODE_GROUP_LEN);
    expect(codePrefixOf(BODY)).not.toContain('ERA');
  });

  it('hashes the body, so the prefix cannot change what an old code hashes to', () => {
    expect(hashCode(normaliseCode(formatSecret(BODY)) || '')).toBe(hashCode(BODY));
    expect(hashCode(BODY)).toHaveLength(64);
  });
});
