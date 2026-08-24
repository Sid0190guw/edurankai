// src/lib/hiring/invitations.test.ts — the pure half: token discipline, status derivation, parsing.
import { describe, it, expect } from 'vitest';
import {
  generateToken, hashToken, tokenPrefixOf, normaliseEmail, isEmail,
  statusOf, isLive, inviteUrl, ttlDays, parseInvite,
  DEFAULT_TTL_DAYS, MAX_TTL_DAYS,
} from '@/lib/hiring/invitations';

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

  it('builds a link without doubling the slash', () => {
    expect(inviteUrl('https://www.edurankai.in/', 'tok')).toBe('https://www.edurankai.in/apply/invite/tok');
    expect(inviteUrl('https://www.edurankai.in', 'tok')).toBe('https://www.edurankai.in/apply/invite/tok');
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
    const out = parseInvite({ email: 'a@b.co', note: 'x'.repeat(5000) }) as { value: { note: string } };
    expect(out.value.note).toHaveLength(1000);
  });
});
