// src/lib/hiring/invitations.test.ts — the pure half: token discipline, status derivation, parsing.
import { describe, it, expect } from 'vitest';
import {
  generateToken, hashToken, tokenPrefixOf, normaliseEmail, isEmail,
  statusOf, isLive, inviteUrl, ttlDays, parseInvite,
  generateCode, normaliseCode, formatCode, hashCode, codePrefixOf,
  DEFAULT_TTL_DAYS, MAX_TTL_DAYS, NOTE_MAX,
} from '@/lib/hiring/invitations';
import { isGatedApplyPath } from '@/lib/talent/gate-pass';

describe('token', () => {
  it('is long and unguessable, and never the same twice', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes stably, and the hash does not contain the token', () => {
    const t = 'abcDEF-123_xyz';
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toHaveLength(64);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).not.toBe(hashToken(t + 'x'));
  });

  it('shows a prefix short enough to be useless on its own', () => {
    const t = generateToken();
    expect(tokenPrefixOf(t)).toHaveLength(8);
    expect(t.startsWith(tokenPrefixOf(t))).toBe(true);
  });

  it('builds a link on the configured public origin, without doubling the slash', () => {
    const prev = process.env.PUBLIC_SITE_URL;
    try {
      process.env.PUBLIC_SITE_URL = 'https://www.edurankai.in/';
      expect(inviteUrl('tok')).toBe('https://www.edurankai.in/invite/tok');
      process.env.PUBLIC_SITE_URL = 'https://www.edurankai.in';
      expect(inviteUrl('tok')).toBe('https://www.edurankai.in/invite/tok');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = prev;
    }
  });

  // THIS ONE SHIPPED BROKEN. The route passed `new URL(request.url).origin`, which on a serverless
  // deployment is the address the function was invoked on — production minted
  // https://localhost/invite/<token>. The origin is no longer a parameter, so there is no caller
  // left that can supply a wrong one; this asserts the result is never loopback.
  it('never mints a loopback link', () => {
    const prev = process.env.PUBLIC_SITE_URL;
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PUBLIC_SITE_URL = 'http://localhost:4321';
      expect(inviteUrl('tok')).not.toContain('localhost');
      expect(inviteUrl('tok')).toContain('edurankai.in');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = prev;
      process.env.NODE_ENV = prevEnv;
    }
  });

  // THE REGRESSION THIS PINS ACTUALLY HAPPENED. The landing page first lived at
  // /apply/invite/<token>, and every invitation link 302'd to the application gate without the page
  // ever running: middleware gates the whole /apply prefix and its exemptions are matched EXACTLY,
  // so a path with a token segment can never be exempted there. Asserting against the real gate
  // predicate rather than against the string means moving either one breaks this test.
  it('lands outside the gated apply prefix, or the link never reaches the page', () => {
    const path = new URL(inviteUrl('tok')).pathname;
    expect(isGatedApplyPath(path)).toBe(false);
  });
});

describe('email', () => {
  it('lowercases and trims, because the email is the binding to the application', () => {
    expect(normaliseEmail('  Ananya@Example.ORG ')).toBe('ananya@example.org');
    expect(normaliseEmail(null)).toBe('');
  });

  it('accepts a real address and rejects the near misses', () => {
    expect(isEmail('ananya@example.org')).toBe(true);
    expect(isEmail('ananya@example')).toBe(false);
    expect(isEmail('ananya example.org')).toBe(false);
    expect(isEmail('')).toBe(false);
  });
});

describe('statusOf', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  it('reads pending and opened while the link is still live', () => {
    expect(statusOf({ status: 'pending', expiresAt: future })).toBe('pending');
    expect(statusOf({ status: 'opened', expiresAt: future })).toBe('opened');
  });

  it('derives expiry rather than trusting a stored column', () => {
    expect(statusOf({ status: 'pending', expiresAt: past })).toBe('expired');
    expect(statusOf({ status: 'opened', expiresAt: past })).toBe('expired');
  });

  it('keeps revoked ahead of expired — taken back and ran out are different facts', () => {
    expect(statusOf({ status: 'revoked', expiresAt: past })).toBe('revoked');
    expect(statusOf({ status: 'revoked', expiresAt: future })).toBe('revoked');
  });

  it('treats an applied invitation as spent even past its expiry', () => {
    expect(statusOf({ status: 'applied', expiresAt: past })).toBe('applied');
    expect(statusOf({ status: 'opened', expiresAt: past, appliedAt: past })).toBe('applied');
  });

  it('only pending and opened can still be walked through', () => {
    expect(isLive('pending')).toBe(true);
    expect(isLive('opened')).toBe(true);
    expect(isLive('applied')).toBe(false);
    expect(isLive('revoked')).toBe(false);
    expect(isLive('expired')).toBe(false);
  });
});

describe('ttlDays', () => {
  it('defaults when the input is absent or nonsense', () => {
    expect(ttlDays(undefined)).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays('')).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays('abc')).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays(0)).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays(-5)).toBe(DEFAULT_TTL_DAYS);
  });

  it('caps rather than trusting whatever was posted', () => {
    expect(ttlDays(9999)).toBe(MAX_TTL_DAYS);
    expect(ttlDays(7)).toBe(7);
  });
});

describe('parseInvite', () => {
  it('refuses a missing or malformed address with a sentence a person can act on', () => {
    expect(parseInvite({ email: '' })).toEqual({ error: 'Enter the email address to invite.' });
    expect(parseInvite({ email: 'nope' })).toEqual({ error: 'That email address does not look right.' });
  });

  it('cleans a whole invitation', () => {
    const out = parseInvite({
      email: '  Ananya@Example.ORG ', fullName: '  Ananya Kumar ', roleSlug: ' data-analyst-intern ',
      note: '  We would like you to apply.  ', waiveFee: 'on', days: '14',
    });
    expect(out).toEqual({
      value: {
        email: 'ananya@example.org',
        fullName: 'Ananya Kumar',
        roleSlug: 'data-analyst-intern',
        note: 'We would like you to apply.',
        waiveFee: true,
        days: 14,
      },
    });
  });

  it('leaves the fee alone unless the administrator actually ticked the box', () => {
    const off = parseInvite({ email: 'a@b.co' }) as { value: { waiveFee: boolean } };
    expect(off.value.waiveFee).toBe(false);
    const stringFalse = parseInvite({ email: 'a@b.co', waiveFee: 'false' }) as { value: { waiveFee: boolean } };
    expect(stringFalse.value.waiveFee).toBe(false);
    const checked = parseInvite({ email: 'a@b.co', waiveFee: true }) as { value: { waiveFee: boolean } };
    expect(checked.value.waiveFee).toBe(true);
  });

  it('allows an invitation with no role — the administrator meant the person', () => {
    const out = parseInvite({ email: 'a@b.co' }) as { value: { roleSlug: string } };
    expect(out.value.roleSlug).toBe('');
  });

  it('truncates rather than rejecting an over-long note', () => {
    const out = parseInvite({ email: 'a@b.co', note: 'x'.repeat(20000) }) as { value: { note: string } };
    expect(out.value.note).toHaveLength(NOTE_MAX);
  });
});

describe('the typed code', () => {
  it('uses the project alphabet, so O, 0, I and 1 can never be minted', () => {
    for (let i = 0; i < 40; i++) {
      const body = generateCode();
      expect(body).toHaveLength(15);
      expect(body).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
      expect(body).not.toMatch(/[O0I1]/);
    }
  });

  it('never mints the same code twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(seen.size).toBe(200);
  });

  it('displays as ERA-INV and not as ERA-SEL, which means a different thing entirely', () => {
    const shown = formatCode('ABCDEFGHJKLMNPQ');
    expect(shown).toBe('ERA-INV-ABCDE-FGHJK-LMNPQ');
    expect(shown.startsWith('ERA-SEL')).toBe(false);
  });

  it('reads back whatever form a person actually types', () => {
    const body = 'ABCDEFGHJKLMNPQ';
    for (const typed of [
      'ERA-INV-ABCDE-FGHJK-LMNPQ',
      'era-inv-abcde-fghjk-lmnpq',
      '  ERA INV ABCDE FGHJK LMNPQ  ',
      'ABCDEFGHJKLMNPQ',
      'abcde fghjk lmnpq',
      'ABCDE-FGHJK-LMNPQ',
    ]) {
      expect(normaliseCode(typed)).toBe(body);
    }
  });

  it('refuses anything that is not a complete code', () => {
    expect(normaliseCode('')).toBeNull();
    expect(normaliseCode('ERA-INV-ABCDE')).toBeNull();
    expect(normaliseCode('ABCDEFGHJKLMNPQR')).toBeNull();
    expect(normaliseCode(null)).toBeNull();
  });

  it('hashes to something that is not the code, and not the token hash of the same string', () => {
    const body = 'ABCDEFGHJKLMNPQ';
    expect(hashCode(body)).toHaveLength(64);
    expect(hashCode(body)).not.toContain(body);
    expect(hashCode(body)).toBe(hashCode(body));
    // Domain-separated: the same string used as a token and as a code must not collide, or one
    // lookup could resolve the other's row.
    expect(hashCode(body)).not.toBe(hashToken(body));
  });

  it('shows only the first group as a prefix', () => {
    expect(codePrefixOf('ABCDEFGHJKLMNPQ')).toBe('ABCDE');
  });
});
