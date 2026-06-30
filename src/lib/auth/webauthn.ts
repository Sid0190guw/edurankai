// WebAuthn passkeys (fingerprint / Face ID / Windows Hello / security key) —
// fully self-built. No @simplewebauthn, no external service. We do our own:
//   - CBOR decode of the attestation object + COSE public key
//   - authenticatorData parsing (rpIdHash / flags / counter / attested cred)
//   - COSE -> JWK and signature verification via node:crypto
//
// Browser side uses the native navigator.credentials API (built in). We accept
// 'none' attestation (the standard choice for passkeys — trust on first use).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { publicOrigin } from '@/lib/public-url';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** Effective origin + RP ID for this request. The authenticator signs over the
 *  page origin, so we trust the Origin header (falling back to the canonical
 *  domain), and derive the RP ID as that origin's hostname. */
export function rpFromRequest(request: Request): { origin: string; rpId: string } {
  let origin = request.headers.get('origin') || '';
  if (!origin || /localhost|127\.|0\.0\.0\.0/i.test(origin)) origin = publicOrigin(request);
  let rpId = 'edurankai.in';
  try { rpId = new URL(origin).hostname; } catch (_) {}
  return { origin, rpId };
}

// ── base64url ──────────────────────────────────────────────────────────────
export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlToBuf(s: string): Buffer {
  let t = (s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}

// ── minimal CBOR decoder (definite-length subset used by WebAuthn) ──────────
function cborDecodeFirst(buf: Buffer): { value: any; len: number } {
  let off = 0;
  function read(): any {
    const first = buf[off++];
    const major = first >> 5;
    const info = first & 0x1f;
    let len = info;
    if (info === 24) len = buf[off++];
    else if (info === 25) { len = buf.readUInt16BE(off); off += 2; }
    else if (info === 26) { len = buf.readUInt32BE(off); off += 4; }
    else if (info === 27) { const hi = buf.readUInt32BE(off); const lo = buf.readUInt32BE(off + 4); off += 8; len = hi * 2 ** 32 + lo; }
    switch (major) {
      case 0: return len;            // unsigned int
      case 1: return -1 - len;       // negative int
      case 2: { const b = buf.subarray(off, off + len); off += len; return b; }   // byte string
      case 3: { const s = buf.toString('utf8', off, off + len); off += len; return s; } // text
      case 4: { const arr: any[] = []; for (let i = 0; i < len; i++) arr.push(read()); return arr; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = read(); m.set(k, read()); } return m; }
      case 7: { if (info === 20) return false; if (info === 21) return true; return null; }
      default: throw new Error('Unsupported CBOR major type ' + major);
    }
  }
  const value = read();
  return { value, len: off };
}

// ── authenticatorData ───────────────────────────────────────────────────────
function parseAuthData(ad: Buffer) {
  const rpIdHash = ad.subarray(0, 32);
  const flags = ad[32];
  const counter = ad.readUInt32BE(33);
  const up = !!(flags & 0x01), uv = !!(flags & 0x04), at = !!(flags & 0x40);
  let credId: Buffer | null = null, cose: Map<any, any> | null = null;
  if (at) {
    let p = 37;
    p += 16; // aaguid
    const credIdLen = ad.readUInt16BE(p); p += 2;
    credId = ad.subarray(p, p + credIdLen); p += credIdLen;
    cose = cborDecodeFirst(ad.subarray(p)).value;
  }
  return { rpIdHash, flags, counter, up, uv, at, credId, cose };
}

// ── COSE -> JWK ─────────────────────────────────────────────────────────────
function coseToJwk(cose: Map<any, any>): { jwk: any; alg: number } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  if (kty === 2) { // EC2
    const crv = cose.get(-1);
    const crvName = crv === 2 ? 'P-384' : crv === 3 ? 'P-521' : 'P-256';
    return { jwk: { kty: 'EC', crv: crvName, x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) }, alg };
  }
  if (kty === 3) { // RSA
    return { jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) }, alg };
  }
  throw new Error('Unsupported key type');
}

function verifySig(jwk: any, alg: number, data: Buffer, sig: Buffer): boolean {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  try {
    if (alg === -7 || alg === -35 || alg === -36) {
      return cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig); // ECDSA, DER-encoded
    }
    if (alg === -257 || alg === -258 || alg === -259) {
      return cryptoVerify('sha256', data, key, sig); // RSA PKCS#1 v1.5
    }
  } catch (_) { return false; }
  return false;
}

// ── schema ──────────────────────────────────────────────────────────────────
let ensured = false;
export async function ensurePasskeySchema(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS user_passkeys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    credential_id text NOT NULL UNIQUE,
    public_key text NOT NULL,
    alg integer NOT NULL,
    counter bigint NOT NULL DEFAULT 0,
    name text,
    transports text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_passkeys_user_idx ON user_passkeys(user_id)`);
  ensured = true;
}

// ── queries ─────────────────────────────────────────────────────────────────
export async function listPasskeys(userId: string): Promise<Array<{ id: string; name: string; created_at: any; last_used_at: any }>> {
  await ensurePasskeySchema();
  return rowsOf(await db.execute(sql`SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE user_id = ${userId} ORDER BY created_at DESC`));
}
export async function countPasskeys(userId: string): Promise<number> {
  await ensurePasskeySchema();
  const r = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = ${userId}`));
  return r[0]?.n || 0;
}
export async function hasPasskeys(userId: string): Promise<boolean> { return (await countPasskeys(userId)) > 0; }
export async function getAllowCredentials(userId: string): Promise<any[]> {
  await ensurePasskeySchema();
  const rows = rowsOf(await db.execute(sql`SELECT credential_id, transports FROM user_passkeys WHERE user_id = ${userId}`));
  return rows.map((r) => ({ id: r.credential_id, type: 'public-key', transports: (r.transports || '').split(',').filter(Boolean) }));
}
export async function deletePasskey(userId: string, id: string): Promise<void> {
  await ensurePasskeySchema();
  await db.execute(sql`DELETE FROM user_passkeys WHERE user_id = ${userId} AND id = ${id}`);
}

/** Resolve the owner of a credential — used for passwordless ("tap fingerprint")
 *  login where the browser, not us, decides which passkey is presented. */
export async function findPasskeyUser(credentialId: string): Promise<{ userId: string } | null> {
  await ensurePasskeySchema();
  const rows = rowsOf(await db.execute(sql`SELECT user_id FROM user_passkeys WHERE credential_id = ${credentialId} LIMIT 1`));
  return rows.length ? { userId: rows[0].user_id } : null;
}

// ── challenge ────────────────────────────────────────────────────────────────
export function newChallenge(): string { return b64url(randomBytes(32)); }

// ── registration ─────────────────────────────────────────────────────────────
export async function registrationOptions(opts: { userId: string; email: string; name: string; rpId: string; challenge: string }) {
  const existing = await getAllowCredentials(opts.userId);
  return {
    challenge: opts.challenge,
    rp: { id: opts.rpId, name: 'EduRankAI' },
    user: { id: b64url(Buffer.from(opts.userId)), name: opts.email || opts.userId, displayName: opts.name || opts.email || 'account' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    excludeCredentials: existing,
    attestation: 'none',
    timeout: 60000,
  };
}

export async function verifyRegistration(userId: string, body: any, exp: { challenge: string; origin: string; rpId: string }) {
  await ensurePasskeySchema();
  const clientData = JSON.parse(b64urlToBuf(body.response.clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.create') throw new Error('Unexpected type');
  if (clientData.challenge !== exp.challenge) throw new Error('Challenge mismatch');
  if (clientData.origin !== exp.origin) throw new Error('Origin mismatch');

  const attObj = cborDecodeFirst(b64urlToBuf(body.response.attestationObject)).value as Map<any, any>;
  const parsed = parseAuthData(attObj.get('authData') as Buffer);
  if (!parsed.up) throw new Error('User presence required');
  if (!parsed.rpIdHash.equals(createHash('sha256').update(exp.rpId).digest())) throw new Error('RP ID mismatch');
  if (!parsed.credId || !parsed.cose) throw new Error('No credential in attestation');

  const { jwk, alg } = coseToJwk(parsed.cose);
  const credIdB64 = b64url(parsed.credId);
  await db.execute(sql`INSERT INTO user_passkeys (user_id, credential_id, public_key, alg, counter, name, transports)
    VALUES (${userId}, ${credIdB64}, ${JSON.stringify(jwk)}, ${alg}, ${parsed.counter}, ${(body.name || 'Passkey').toString().slice(0, 60)}, ${(body.transports || []).join(',')})
    ON CONFLICT (credential_id) DO NOTHING`);
  return { credentialId: credIdB64 };
}

// ── authentication ────────────────────────────────────────────────────────────
export async function authenticationOptions(userId: string, rpId: string, challenge: string) {
  return {
    challenge,
    rpId,
    allowCredentials: await getAllowCredentials(userId),
    userVerification: 'preferred',
    timeout: 60000,
  };
}

export async function verifyAuthentication(userId: string, body: any, exp: { challenge: string; origin: string; rpId: string }): Promise<boolean> {
  await ensurePasskeySchema();
  const credIdB64 = body.id;
  const rows = rowsOf(await db.execute(sql`SELECT public_key, alg, counter FROM user_passkeys WHERE user_id = ${userId} AND credential_id = ${credIdB64} LIMIT 1`));
  if (!rows.length) throw new Error('Unknown credential');
  const jwk = typeof rows[0].public_key === 'string' ? JSON.parse(rows[0].public_key) : rows[0].public_key;
  const alg = Number(rows[0].alg);
  const storedCounter = Number(rows[0].counter) || 0;

  const clientDataBuf = b64urlToBuf(body.response.clientDataJSON);
  const clientData = JSON.parse(clientDataBuf.toString('utf8'));
  if (clientData.type !== 'webauthn.get') throw new Error('Unexpected type');
  if (clientData.challenge !== exp.challenge) throw new Error('Challenge mismatch');
  if (clientData.origin !== exp.origin) throw new Error('Origin mismatch');

  const authData = b64urlToBuf(body.response.authenticatorData);
  const parsed = parseAuthData(authData);
  if (!parsed.up) throw new Error('User presence required');
  if (!parsed.rpIdHash.equals(createHash('sha256').update(exp.rpId).digest())) throw new Error('RP ID mismatch');

  const signedData = Buffer.concat([authData, createHash('sha256').update(clientDataBuf).digest()]);
  if (!verifySig(jwk, alg, signedData, b64urlToBuf(body.response.signature))) throw new Error('Bad signature');

  // Clone detection: a non-zero counter that fails to advance is a red flag.
  if (parsed.counter > 0 && parsed.counter <= storedCounter) throw new Error('Counter regressed');
  await db.execute(sql`UPDATE user_passkeys SET counter = ${parsed.counter}, last_used_at = now() WHERE user_id = ${userId} AND credential_id = ${credIdB64}`);
  return true;
}
