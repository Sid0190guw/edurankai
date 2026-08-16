// src/lib/mail-product/common.test.ts — the shared helpers, including the three house rules this
// project has paid for in outages.
import { describe, it, expect } from 'vitest';
import {
  rowsOf, reasonOf, isUuid, isEmail, normaliseEmail, slugify, clampInt,
  encodeCursor, decodeCursor, initials, avatarColour, esc, htmlToText, timeAgo, num, pct,
} from './common';

describe('rowsOf — postgres-js returns a PLAIN ARRAY, not { rows }', () => {
  it('passes a plain array through', () => {
    expect(rowsOf([{ a: 1 }, { a: 2 }]).length).toBe(2);
  });

  it('unwraps the { rows } shape for any driver that uses it', () => {
    expect(rowsOf({ rows: [{ a: 1 }] }).length).toBe(1);
  });

  it('never throws on null, undefined or something unexpected', () => {
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf(42)).toEqual([]);
    expect(rowsOf({})).toEqual([]);
  });
});

describe('reasonOf — the real Postgres reason is on e.cause', () => {
  it('prefers e.cause.message, because e.message is only the failed SQL', () => {
    const e = { message: 'SELECT * FROM nope', cause: { message: 'relation "nope" does not exist' } };
    expect(reasonOf(e)).toBe('relation "nope" does not exist');
  });

  it('falls back to e.message when there is no cause', () => {
    expect(reasonOf({ message: 'boom' })).toBe('boom');
  });

  it('never returns undefined', () => {
    expect(reasonOf(null)).toBe('unknown error');
    expect(reasonOf({})).toBe('unknown error');
  });
});

describe('isUuid — an id bound blind into a uuid column raises 22P02', () => {
  it('accepts a real uuid in either case', () => {
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('123')).toBe(false);
    expect(isUuid('3f2504e0-4f89-11d3-9a0c')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("' OR 1=1--")).toBe(false);
  });
});

describe('isEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isEmail('a@b.com')).toBe(true);
    expect(isEmail('anita.rao+tag@sub.example.co.in')).toBe(true);
    expect(isEmail('  A@B.COM  ')).toBe(true);
  });

  it('refuses the shapes a CSV import produces', () => {
    expect(isEmail('')).toBe(false);
    expect(isEmail('not an email')).toBe(false);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('@b.com')).toBe(false);
    expect(isEmail('a@@b.com')).toBe(false);
    expect(isEmail('a'.repeat(250) + '@b.com')).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('lower-cases and trims, which is what the unique index depends on', () => {
    expect(normaliseEmail('  Anita.Rao@Example.COM ')).toBe('anita.rao@example.com');
    expect(normaliseEmail(null)).toBe('');
  });
});

describe('slugify', () => {
  it('produces a stable key', () => {
    expect(slugify('Stage 3 Invitation')).toBe('stage-3-invitation');
    expect(slugify('  --Hello--World--  ')).toBe('hello-world');
    expect(slugify('')).toBe('');
  });

  it('caps runaway input', () => {
    expect(slugify('a'.repeat(200)).length).toBe(64);
  });
});

describe('clampInt', () => {
  it('clamps and falls back rather than passing NaN into a LIMIT', () => {
    expect(clampInt('50', 1, 200, 20)).toBe(50);
    expect(clampInt('9999', 1, 200, 20)).toBe(200);
    expect(clampInt('-5', 1, 200, 20)).toBe(1);
    expect(clampInt('abc', 1, 200, 20)).toBe(20);
    expect(clampInt(null, 1, 200, 20)).toBe(20);
  });
});

describe('cursor — keyset paging, because OFFSET over millions is a full scan per page', () => {
  it('round-trips', () => {
    const c = { ts: '2026-08-16T09:00:00.000Z', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for junk rather than throwing — a bad cursor gives page one, not an error', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(42)).toBeNull();
    expect(decodeCursor(Buffer.from('nonsense', 'utf8').toString('base64url'))).toBeNull();
  });

  it('refuses a cursor whose id is not a uuid, so it cannot reach a uuid column', () => {
    const forged = Buffer.from("2026-08-16T09:00:00.000Z|' OR 1=1--", 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('refuses a cursor whose timestamp is not a date', () => {
    const forged = Buffer.from('not-a-date|3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });
});

describe('initials', () => {
  it('uses two words when there are two', () => {
    expect(initials('Anita Rao')).toBe('AR');
    expect(initials('anita.rao@example.com')).toBe('AR');
    expect(initials(null, 'siddharth@edurankai.in')).toBe('SI');
  });

  it('never returns an empty string', () => {
    expect(initials(null, null)).toBe('?');
    expect(initials('', '')).toBe('?');
  });
});

describe('avatarColour', () => {
  it('is deterministic — the same person is the same colour on every screen', () => {
    expect(avatarColour('anita@example.com')).toBe(avatarColour('anita@example.com'));
  });

  it('returns a token from the ramp', () => {
    expect(avatarColour('x')).toMatch(/^var\(--em-c\d\)$/);
  });
});

describe('esc', () => {
  it('escapes every character that could break out of an attribute or a tag', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('"q"')).toBe('&quot;q&quot;');
    expect(esc("'q'")).toBe('&#39;q&#39;');
    expect(esc(null)).toBe('');
  });
});

describe('htmlToText', () => {
  it('turns block tags into newlines so the fallback is readable', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<style>.a{}</style><script>x()</script><p>keep</p>')).toBe('keep');
  });

  it('decodes the entities it produced', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  it('reads as a person would say it', () => {
    expect(timeAgo('2026-08-16T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-08-16T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-08-16T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-08-14T12:00:00Z', now)).toBe('2d ago');
  });

  it('returns empty for nothing, rather than "Invalid Date"', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo('nonsense')).toBe('');
  });
});

describe('pct — "0 of 0" is not "0%"', () => {
  it('returns a dash when the denominator is zero, because there is nothing to divide by', () => {
    expect(pct(0, 0)).toBe('—');
    expect(pct(5, 0)).toBe('—');
  });

  it('computes an ordinary rate', () => {
    expect(pct(25, 100)).toBe('25.0%');
    expect(pct(1, 3, 2)).toBe('33.33%');
  });
});

describe('num', () => {
  it('groups digits so a dashboard figure is readable', () => {
    expect(num(1234567)).toMatch(/[, ]/);
    expect(num(0)).toBe('0');
    expect(num('nonsense')).toBe('0');
  });
});
