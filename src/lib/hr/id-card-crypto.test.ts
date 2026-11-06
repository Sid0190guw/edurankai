// The ID card credential: forging, altering, replaying and reusing it must all fail.
import { describe, it, expect } from 'vitest';
import { randomBytes, createPublicKey, verify as edVerify } from 'node:crypto';
import {
  deriveSigningKey, dataKeyIdOf, publicJwk, signCard, verifyCard, signGrant, verifyGrant,
  newSerial, isSerial, TOKEN_PREFIX, CLOCK_SKEW_SECONDS,
} from './id-card-crypto';

const dk = Buffer.alloc(32, 7);
const key = deriveSigningKey('k2', dk);
const keyFor = (kid: string) => (kid === key.kid ? key : null);
const NOW = 1_800_000_000;
const printed = { serial: 'ERA-ID-7KQ2-M9XD', presentation: 'printed' as const, issuedAt: NOW - 100, expiresAt: NOW + 86400, faceAt: 0 };

describe('key derivation', () => {
  it('is deterministic, purpose-bound, and names the data key it came from', () => {
    const again = deriveSigningKey('k2', Buffer.alloc(32, 7));
    expect(publicJwk(again).x).toBe(publicJwk(key).x);
    expect(key.kid).toBe('id-k2');
    expect(dataKeyIdOf('id-k2')).toBe('k2');
    expect(dataKeyIdOf('k2')).toBeNull();
    expect(dataKeyIdOf('id-../../etc')).toBeNull();
    const other = deriveSigningKey('k2', Buffer.alloc(32, 8));
    expect(publicJwk(other).x).not.toBe(publicJwk(key).x);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => deriveSigningKey('k1', Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('publishes a standard Ed25519 JWK that verifies a card with nothing but node:crypto', () => {
    const jwk = publicJwk(key);
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid: 'id-k2' });
    const token = signCard(key, printed);
    const [p, body, sig] = token.split('.');
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    expect(edVerify(null, Buffer.from(p + '.' + body), pub, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});

describe('card tokens', () => {
  it('round-trips a printed card and carries no personal data', () => {
    const token = signCard(key, printed);
    expect(token.startsWith(TOKEN_PREFIX + '.')).toBe(true);
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['c', 'e', 'i', 'k', 't', 'v']);
    const v = verifyCard(token, keyFor, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims).toMatchObject({ serial: printed.serial, presentation: 'printed' });
  });

  it('is short enough for a scannable QR', () => {
    const live = signCard(key, { ...printed, presentation: 'live', faceAt: NOW });
    expect(live.length).toBeLessThan(260);
  });

  it('rejects a changed payload, a changed signature and a foreign key', () => {
    const token = signCard(key, printed);
    const [p, body, sig] = token.split('.');
    const forgedBody = Buffer.from(Buffer.from(body, 'base64url').toString().replace('7KQ2', 'AAAA')).toString('base64url');
    expect(verifyCard([p, forgedBody, sig].join('.'), keyFor, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(verifyCard([p, body, flipped].join('.'), keyFor, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const stranger = deriveSigningKey('k2', randomBytes(32));
    expect(verifyCard(signCard(stranger, printed), keyFor, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token naming a key it cannot derive, and garbage of every shape', () => {
    const k9 = deriveSigningKey('k9', dk);
    expect(verifyCard(signCard(k9, printed), keyFor, NOW)).toMatchObject({ ok: false, reason: 'unknown_key' });
    for (const junk of ['', 'abc', 'EID1..', 'EID1.x.y', 'EID2.a.b', 'EID1.' + 'A'.repeat(700) + '.x']) {
      expect(verifyCard(junk, keyFor, NOW).ok).toBe(false);
    }
  });

  it('expires, and the expiry is only trusted after the signature', () => {
    const old = signCard(key, { ...printed, expiresAt: NOW - 1 });
    expect(verifyCard(old, keyFor, NOW)).toMatchObject({ ok: false, reason: 'expired' });
    const future = signCard(key, { ...printed, issuedAt: NOW + CLOCK_SKEW_SECONDS + 10 });
    expect(verifyCard(future, keyFor, NOW)).toMatchObject({ ok: false, reason: 'not_yet_valid' });
  });

  it('cannot turn a printed code into a live one', () => {
    const token = signCard(key, printed);
    const [p, body, sig] = token.split('.');
    const asLive = Buffer.from(Buffer.from(body, 'base64url').toString().replace('"t":"p"', '"t":"l"')).toString('base64url');
    expect(verifyCard([p, asLive, sig].join('.'), keyFor, NOW).ok).toBe(false);
  });

  it('gives two live codes minted in the same second different values', () => {
    const live = { ...printed, presentation: 'live' as const, faceAt: NOW };
    expect(signCard(key, live)).not.toBe(signCard(key, live));
  });
});

describe('face-unlock grants', () => {
  const g = { employeeId: 'e1', serial: printed.serial, faceAt: NOW, expiresAt: NOW + 600 };

  it('round-trips and expires', () => {
    expect(verifyGrant(signGrant(key, g), keyFor, NOW)).toMatchObject({ employeeId: 'e1', faceAt: NOW });
    expect(verifyGrant(signGrant(key, g), keyFor, NOW + 601)).toBeNull();
  });

  it('is not interchangeable with a card token in either direction', () => {
    const grant = signGrant(key, g);
    expect(verifyCard(grant, keyFor, NOW).ok).toBe(false);
    expect(verifyGrant(signCard(key, printed), keyFor, NOW)).toBeNull();
    const [, body, sig] = grant.split('.');
    expect(verifyCard('EID1.' + body + '.' + sig, keyFor, NOW).ok).toBe(false);
  });
});

describe('serials', () => {
  it('are well-formed, unambiguous and distinct', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = newSerial();
      expect(isSerial(s)).toBe(true);
      expect(s.slice('ERA-ID-'.length)).not.toMatch(/[ILOU]/);
      seen.add(s);
    }
    expect(seen.size).toBe(500);
    expect(isSerial('ERA-ID-ILOU-0000')).toBe(false);
  });
});
