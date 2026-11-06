// THE CRYPTOGRAPHY BEHIND THE EMPLOYEE ID CARD. Pure: no database, no request, no clock it does
// not take as an argument.
//
// =================================================================================================
// WHAT IS SIGNED, AND WHY NOTHING ON THE CARD NEEDS ENCRYPTING
// =================================================================================================
//
// The QR on an ID card carries a CREDENTIAL, not a profile. It holds the card's serial, what kind of
// presentation it is (printed or live), when it was issued, when it stops working, and - for the
// live phone card - when the holder last unlocked it with their face. NO NAME, NO PHOTO, NO EMAIL,
// NO PHONE. Those are read from the employee record at the moment of verification, so a card that is
// photographed, copied or lost leaks nothing about the person, and a name change or a revocation
// takes effect on every copy at once.
//
// Because the payload holds nothing private, it does not need hiding; it needs to be IMPOSSIBLE TO
// FORGE. So every credential is signed with Ed25519 (RFC 8032 EdDSA over Curve25519): 128-bit
// security, deterministic signatures (no per-signature randomness to get wrong), and verification
// that anybody can do offline with the public key published at /api/id-card/keys.
//
// =================================================================================================
// WHERE THE SIGNING KEY COMES FROM
// =================================================================================================
//
// It is DERIVED, not stored. HKDF-SHA256 (RFC 5869) expands the platform's AES-256 data key
// (DATA_ENCRYPTION_KEY_<id>) into a 32-byte Ed25519 seed, with a salt and an info string that belong
// to this purpose alone. HKDF is one-way, so the signing key reveals nothing about the encryption
// key it came from, and the derivation is domain-separated, so no other part of the platform can
// produce the same key by accident.
//
// The consequences are deliberate:
//   - No new secret to provision, back up or lose. The encryption key is already escrowed.
//   - KEY ROTATION IS FREE. A credential names its key id ("id-k2"). Moving ACTIVE_DATA_KEY_ID to k3
//     signs new cards under id-k3 while every card signed under id-k2 still verifies, for as long as
//     DATA_ENCRYPTION_KEY_k2 stays configured - which it must anyway, to read data encrypted under it.
//
// TOKEN FORMAT:   EID1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
// The signature covers the literal prefix as well as the payload, so a token of one kind can never
// be replayed as a token of another (the face-unlock grant below uses a different prefix).
import {
  hkdfSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomBytes,
  type KeyObject,
} from 'node:crypto';

export const TOKEN_PREFIX = 'EID1';
export const GRANT_PREFIX = 'EIDG1';
const HKDF_SALT = 'edurankai/id-card/v1';
const HKDF_INFO = 'ed25519-signing-seed';

/** A live card refreshes every 30 seconds and each code is good for 90: one missed refresh is fine. */
export const LIVE_TTL_SECONDS = 90;
export const LIVE_REFRESH_SECONDS = 30;
/** How long one face unlock keeps the live card running before the holder is asked again. */
export const GRANT_TTL_SECONDS = 10 * 60;
/** Tolerance for a phone whose clock is a little ahead of ours. */
export const CLOCK_SKEW_SECONDS = 60;

// The fixed ASN.1 header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SigningKey {
  /** "id-" + the data key id it was derived from, e.g. "id-k2". Travels in every token. */
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Derive the Ed25519 card-signing key from a 32-byte data key. Same input, same key, every time. */
export function deriveSigningKey(dataKeyId: string, dataKey: Buffer): SigningKey {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
    throw new Error('The data key for ID cards must be exactly 32 bytes.');
  }
  const seed = Buffer.from(hkdfSync('sha256', dataKey, HKDF_SALT, HKDF_INFO, 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return { kid: 'id-' + dataKeyId, privateKey, publicKey: createPublicKey(privateKey) };
}

/** The data key id a card key id was derived from. "id-k2" -> "k2"; anything else -> null. */
export function dataKeyIdOf(kid: string): string | null {
  const m = /^id-([A-Za-z0-9._-]{1,64})$/.exec(String(kid || ''));
  return m ? m[1] : null;
}

/** A public key as a JWK (RFC 8037 OKP), for anybody who wants to verify a card offline. */
export function publicJwk(key: SigningKey): Record<string, string> {
  const jwk = key.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: key.kid, use: 'sig', alg: 'EdDSA' };
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

// -------------------------------------------------------------------------------------------------
// CARD CREDENTIALS
// -------------------------------------------------------------------------------------------------

export type Presentation = 'printed' | 'live';

export interface CardClaims {
  /** The card serial, e.g. ERA-ID-7KQ2-M9XD. */
  serial: string;
  presentation: Presentation;
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
  /** Live only: when the holder last matched their face on the device, or 0 when they did not. */
  faceAt: number;
}

interface WirePayload {
  v: 1;
  k: string;
  c: string;
  t: 'p' | 'l';
  i: number;
  e: number;
  f?: number;
  n?: string;
}

export function signCard(key: SigningKey, claims: CardClaims): string {
  const payload: WirePayload = {
    v: 1,
    k: key.kid,
    c: claims.serial,
    t: claims.presentation === 'live' ? 'l' : 'p',
    i: Math.floor(claims.issuedAt),
    e: Math.floor(claims.expiresAt),
  };
  if (claims.presentation === 'live') {
    payload.f = Math.floor(claims.faceAt || 0);
    // A nonce, so two live codes minted in the same second are still two different codes.
    payload.n = b64u(randomBytes(6));
  }
  const body = TOKEN_PREFIX + '.' + b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = edSign(null, Buffer.from(body, 'utf8'), key.privateKey);
  return body + '.' + b64u(sig);
}

export type VerifyFailure =
  | 'malformed'        // not shaped like a card token at all
  | 'unknown_key'      // names a key this deployment cannot derive
  | 'bad_signature'    // forged or altered
  | 'expired'          // past its expiry
  | 'not_yet_valid';   // issued in the future beyond the skew allowance

export type VerifyResult =
  | { ok: true; claims: CardClaims; kid: string }
  | { ok: false; reason: VerifyFailure; claims?: CardClaims };

/**
 * Check a token's signature and its clock. Says nothing about whether the CARD is still active -
 * that is a registry question, asked by the caller after this passes.
 *
 * `keyFor` resolves a key id to a key, or null. Injected so this stays pure and testable.
 */
export function verifyCard(
  token: string,
  keyFor: (kid: string) => SigningKey | null,
  nowSeconds: number,
): VerifyResult {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' };
  if (parts[1].length > 600 || parts[2].length > 120) return { ok: false, reason: 'malformed' };

  let p: WirePayload;
  try {
    p = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!p || p.v !== 1 || typeof p.k !== 'string' || typeof p.c !== 'string'
    || (p.t !== 'p' && p.t !== 'l') || !Number.isFinite(p.i) || !Number.isFinite(p.e)) {
    return { ok: false, reason: 'malformed' };
  }

  const key = keyFor(p.k);
  if (!key) return { ok: false, reason: 'unknown_key' };

  let good = false;
  try {
    good = edVerify(null, Buffer.from(parts[0] + '.' + parts[1], 'utf8'), key.publicKey, fromB64u(parts[2]));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad_signature' };

  const claims: CardClaims = {
    serial: p.c,
    presentation: p.t === 'l' ? 'live' : 'printed',
    issuedAt: p.i,
    expiresAt: p.e,
    faceAt: Number(p.f) || 0,
  };
  // CHECKED ONLY AFTER THE SIGNATURE. An expiry read off an unverified payload is a number somebody
  // typed, and reporting "expired" for a forgery would tell a forger which field to change.
  if (p.i > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet_valid', claims };
  if (p.e < nowSeconds) return { ok: false, reason: 'expired', claims };
  return { ok: true, claims, kid: p.k };
}

// -------------------------------------------------------------------------------------------------
// FACE-UNLOCK GRANT
// -------------------------------------------------------------------------------------------------
//
// After the holder matches their face on their own phone, the server hands back a short grant so the
// live code can keep refreshing for ten minutes without the camera running the whole time. It is
// bound to the employee and to the card, signed under its own prefix, and useless to anybody else:
// the live endpoint also requires the holder's own signed-in session.

export interface GrantClaims {
  employeeId: string;
  serial: string;
  faceAt: number;
  expiresAt: number;
}

export function signGrant(key: SigningKey, g: GrantClaims): string {
  const body = GRANT_PREFIX + '.' + b64u(Buffer.from(JSON.stringify({
    k: key.kid, emp: g.employeeId, c: g.serial, f: Math.floor(g.faceAt), e: Math.floor(g.expiresAt),
  }), 'utf8'));
  return body + '.' + b64u(edSign(null, Buffer.from(body, 'utf8'), key.privateKey));
}

export function verifyGrant(
  grant: string,
  keyFor: (kid: string) => SigningKey | null,
  nowSeconds: number,
): GrantClaims | null {
  const parts = String(grant || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== GRANT_PREFIX || parts[1].length > 600) return null;
  let p: any;
  try { p = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch { return null; }
  if (!p || typeof p.k !== 'string' || typeof p.emp !== 'string' || typeof p.c !== 'string') return null;
  const key = keyFor(p.k);
  if (!key) return null;
  let good = false;
  try {
    good = edVerify(null, Buffer.from(parts[0] + '.' + parts[1], 'utf8'), key.publicKey, fromB64u(parts[2]));
  } catch { good = false; }
  if (!good) return null;
  if (!Number.isFinite(p.e) || p.e < nowSeconds) return null;
  return { employeeId: p.emp, serial: p.c, faceAt: Number(p.f) || 0, expiresAt: p.e };
}

// -------------------------------------------------------------------------------------------------
// SERIALS
// -------------------------------------------------------------------------------------------------

// Crockford base32 without I, L, O, U: nothing on a printed card can be misread as another letter.
const SERIAL_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ERA-ID-XXXX-XXXX: 40 bits of randomness, readable aloud over a phone. */
export function newSerial(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += SERIAL_ALPHABET[bytes[i] % 32];
  return 'ERA-ID-' + s.slice(0, 4) + '-' + s.slice(4);
}

export function isSerial(v: unknown): boolean {
  return /^ERA-ID-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(String(v || ''));
}
