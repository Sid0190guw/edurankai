// The authenticator: does it produce the codes every authenticator app produces, and does a sign-in
// tell a spent code from a wrong one?
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The database is replaced by a tiny in-memory user_totp, so the real SQL paths run.
const state: { secret: string | null; confirmed: boolean; lastUsed: number | null } = { secret: null, confirmed: false, lastUsed: null };
function textOf(q: any): string {
  return (q?.queryChunks || []).map((c: any) => (c && Array.isArray(c.value) ? c.value.join('') : '?')).join('');
}
function paramsOf(q: any): any[] {
  return (q?.queryChunks || []).filter((c: any) => !(c && Array.isArray(c.value)));
}
vi.mock('@/lib/schema-bootstrap', () => ({ ddlPermitted: () => true }));
vi.mock('@/lib/db', () => ({
  db: {
    execute: async (q: any) => {
      const t = textOf(q);
      if (/CREATE (TABLE|INDEX)/i.test(t)) return [];
      if (/SELECT secret, confirmed_at FROM user_totp/.test(t)) {
        return state.secret ? [{ secret: state.secret, confirmed_at: state.confirmed ? new Date() : null }] : [];
      }
      if (/UPDATE user_totp\s+SET last_used_at = to_timestamp/.test(t)) {
        const marker = Number(paramsOf(q)[0]);
        if (state.lastUsed === null || state.lastUsed < marker) { state.lastUsed = marker; return [{ user_id: 'u' }]; }
        return [];
      }
      if (/UPDATE user_backup_codes/.test(t)) return [];
      throw new Error('unexpected query: ' + t);
    },
  },
}));

import { matchTotpStep, verifyTotp, otpauthUri, generateTotpSecret, checkLoginCode } from './twofactor';

// RFC 6238 Appendix B, SHA-1: the shared secret is ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS: Array<[number, string]> = [
  [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
  [1234567890, '005924'], [2000000000, '279037'],
];

afterEach(() => { vi.useRealTimers(); });

describe('TOTP maths', () => {
  it('matches the RFC 6238 reference codes, so it agrees with every authenticator app', () => {
    for (const [t, code] of VECTORS) {
      vi.useFakeTimers(); vi.setSystemTime(t * 1000);
      expect(matchTotpStep(RFC_SECRET, code, 0)).toBe(Math.floor(t / 30));
      expect(verifyTotp(RFC_SECRET, code)).toBe(true);
      vi.useRealTimers();
    }
  });

  it('tolerates one step of clock drift either way, and no more', () => {
    vi.useFakeTimers(); vi.setSystemTime((59 + 30) * 1000);
    expect(verifyTotp(RFC_SECRET, '287082')).toBe(true);
    vi.setSystemTime((59 + 61) * 1000);
    expect(verifyTotp(RFC_SECRET, '287082')).toBe(false);
  });

  it('accepts spaces in a typed code and refuses anything that is not six digits', () => {
    vi.useFakeTimers(); vi.setSystemTime(59 * 1000);
    expect(verifyTotp(RFC_SECRET, '287 082')).toBe(true);
    expect(verifyTotp(RFC_SECRET, '28708')).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBe(false);
  });

  it('builds the otpauth URI authenticator apps scan', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    const uri = otpauthUri(s, 'siddharth@edurankai.in');
    expect(uri).toBe('otpauth://totp/EduRankAI:siddharth%40edurankai.in?secret=' + s + '&issuer=EduRankAI&algorithm=SHA1&digits=6&period=30');
  });
});

describe('checkLoginCode', () => {
  beforeEach(() => {
    state.secret = RFC_SECRET; state.confirmed = true; state.lastUsed = null;
    vi.useFakeTimers(); vi.setSystemTime(1111111111 * 1000);
  });

  it('accepts a live code once and calls the second use "spent", not "wrong"', async () => {
    expect(await checkLoginCode('u', '050471')).toBe('ok');
    expect(await checkLoginCode('u', '050471')).toBe('spent');
  });

  it('accepts the next code after one was spent - the sign-in that used to fail', async () => {
    expect(await checkLoginCode('u', '050471')).toBe('ok');
    vi.setSystemTime((1111111111 + 30) * 1000);
    // Compute the next step's code from the RFC secret with the module itself.
    let next = '';
    for (let i = 0; i < 1_000_000 && !next; i++) {
      const c = String(i).padStart(6, '0');
      if (matchTotpStep(RFC_SECRET, c, 0) === Math.floor((1111111111 + 30) / 30)) next = c;
    }
    expect(next).not.toBe('');
    expect(await checkLoginCode('u', next)).toBe('ok');
  });

  it('calls a code wrong when it is wrong, and refuses an unconfirmed authenticator', async () => {
    expect(await checkLoginCode('u', '000000')).toBe('wrong');
    state.confirmed = false;
    expect(await checkLoginCode('u', '050471')).toBe('wrong');
  });
});
