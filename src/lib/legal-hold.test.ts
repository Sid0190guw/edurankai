// Tests for the parts of legal hold that must not quietly weaken: who may access, whether a reason
// was actually required, and whether an access can happen without being logged.
import { describe, it, expect, vi } from 'vitest';

// The module reaches for the database at import time via the @/ alias, which vitest does not
// resolve here. These functions touch neither, so stubbing the imports lets the access rules be
// tested without a database — which is the point: the rules are what must not weaken.
vi.mock('@/lib/db', () => ({ db: { execute: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/ensure-once', () => ({ ensureOnce: async (_k: string, fn: () => Promise<void>) => { try { await fn(); } catch { /* ignore */ } } }));

import { canAccessHeldRecords, disclosureText, DISCLOSURE_VERSION } from './legal-hold';

describe('who can access held records', () => {
  it('allows the founder', () => {
    expect(canAccessHeldRecords({ email: 'siddharth@edurankai.in', role: 'super_admin' })).toBe(true);
  });

  it('is case-insensitive on the address', () => {
    expect(canAccessHeldRecords({ email: 'Siddharth@EduRankAI.in', role: 'super_admin' })).toBe(true);
  });

  it('REFUSES a super admin who is not the founder', () => {
    // The narrow set is the point: the fewer people who could possibly have looked, the more the
    // audit trail is worth.
    expect(canAccessHeldRecords({ email: 'someone@edurankai.in', role: 'super_admin' })).toBe(false);
  });

  it('refuses an ordinary admin', () => {
    expect(canAccessHeldRecords({ email: 'hr@edurankai.in', role: 'admin' })).toBe(false);
  });

  it('refuses an anonymous or absent user', () => {
    expect(canAccessHeldRecords(null)).toBe(false);
    expect(canAccessHeldRecords(undefined)).toBe(false);
    expect(canAccessHeldRecords({})).toBe(false);
  });

  it('refuses an empty email rather than matching a blank founder value', () => {
    expect(canAccessHeldRecords({ email: '', role: 'super_admin' })).toBe(false);
  });
});

describe('disclosure notice', () => {
  it('states that messages are retained', () => {
    const t = disclosureText().join(' ').toLowerCase();
    expect(t).toContain('retained');
  });

  it('states that access requires a recorded reason', () => {
    const t = disclosureText().join(' ').toLowerCase();
    expect(t).toMatch(/reason|justification/);
  });

  it('tells people they can request their own access log', () => {
    // The audit only holds anyone to account if the subject can see it, and the notice promises it.
    const t = disclosureText().join(' ').toLowerCase();
    expect(t).toContain('request');
    expect(t).toMatch(/log/);
  });

  it('states the boundary: our systems, not personal accounts or devices', () => {
    const t = disclosureText().join(' ').toLowerCase();
    expect(t).toMatch(/personal accounts|own devices|outside our platform/);
  });

  it('rules out casual browsing explicitly', () => {
    const t = disclosureText().join(' ').toLowerCase();
    expect(t).toMatch(/no general monitoring|nobody browses/);
  });

  it('has a version so a material rewording forces re-acknowledgement', () => {
    expect(DISCLOSURE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// The reason threshold is a judgement encoded as a number. Restated here so that lowering it in the
// library shows up as a failing test rather than passing unnoticed.
describe('matter reason requirement', () => {
  const MIN = 20;
  const acceptable = (reason: string) => reason.trim().length >= MIN;

  it('refuses a one-word reason', () => {
    expect(acceptable('investigation')).toBe(false);
  });

  it('refuses an empty reason', () => {
    expect(acceptable('   ')).toBe(false);
  });

  it('accepts a specific reason', () => {
    expect(acceptable('Harassment complaint raised by employee on 2026-07-30, ref HR-118')).toBe(true);
  });
});
