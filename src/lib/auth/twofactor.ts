// Two-factor authentication — fully self-built, no third-party libraries / no
// external services. All maths runs on our own infra via node:crypto.
//
//   - TOTP  (RFC 6238) authenticator apps — Google Authenticator, Authy, etc.
//   - Backup recovery codes (one-time use, hashed at rest)
//   - WebAuthn passkeys (fingerprint / Face ID / security key) live in
//     ./webauthn.ts and share the same enrolment / challenge surface.
//
// Tables are self-bootstrapping (CREATE TABLE / ALTER ADD COLUMN IF NOT EXISTS)
// so a deploy never needs a manual migration to start working.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

// ── schema bootstrap ───────────────────────────────────────────────────────
let ensured = false;
export async function ensureTwoFactorSchema(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS user_totp (
    user_id uuid PRIMARY KEY,
    secret text NOT NULL,
    confirmed_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS user_backup_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_backup_codes_user_idx ON user_backup_codes(user_id)`);
  ensured = true;
}

// ── base32 (RFC 4648, no padding) ──────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string): Buffer {
  const clean = (s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s) ──────────────────────────────────
export function generateTotpSecret(): string { return base32Encode(randomBytes(20)); }

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) |
              ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

function safeEqStr(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Verify a 6-digit TOTP against a base32 secret, ±`window` 30s steps for clock drift. */
export function verifyTotp(secretB32: string, token: string, window = 1): boolean {
  const code = (token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (safeEqStr(hotp(secret, step + i), code)) return true;
  }
  return false;
}

/** otpauth:// URI — tap it on a phone to add the account, or scan as a QR. */
export function otpauthUri(secretB32: string, account: string, issuer = 'EduRankAI'): string {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Format a secret in groups of 4 for readable manual entry. */
export function formatSecret(secretB32: string): string {
  return (secretB32.match(/.{1,4}/g) || []).join(' ');
}

// ── TOTP enrolment lifecycle ───────────────────────────────────────────────
export async function startTotpEnrollment(userId: string): Promise<string> {
  await ensureTwoFactorSchema();
  const secret = generateTotpSecret();
  await db.execute(sql`INSERT INTO user_totp (user_id, secret, confirmed_at, created_at)
    VALUES (${userId}, ${secret}, NULL, now())
    ON CONFLICT (user_id) DO UPDATE SET secret = ${secret}, confirmed_at = NULL, created_at = now()`);
  return secret;
}

export async function getTotpRecord(userId: string): Promise<{ secret: string; confirmed: boolean } | null> {
  await ensureTwoFactorSchema();
  const rows = rowsOf(await db.execute(sql`SELECT secret, confirmed_at FROM user_totp WHERE user_id = ${userId} LIMIT 1`));
  if (!rows.length) return null;
  return { secret: rows[0].secret, confirmed: !!rows[0].confirmed_at };
}

export async function isTotpEnabled(userId: string): Promise<boolean> {
  const rec = await getTotpRecord(userId);
  return !!(rec && rec.confirmed);
}

/** Confirm enrolment: the user proves they scanned it by entering a live code. */
export async function confirmTotp(userId: string, token: string): Promise<boolean> {
  const rec = await getTotpRecord(userId);
  if (!rec) return false;
  if (!verifyTotp(rec.secret, token)) return false;
  await db.execute(sql`UPDATE user_totp SET confirmed_at = COALESCE(confirmed_at, now()), last_used_at = now() WHERE user_id = ${userId}`);
  return true;
}

export async function disableTotp(userId: string): Promise<void> {
  await ensureTwoFactorSchema();
  await db.execute(sql`DELETE FROM user_totp WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM user_backup_codes WHERE user_id = ${userId}`);
}

// ── backup recovery codes ──────────────────────────────────────────────────
function hashCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
}

export function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const hex = randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(hex.slice(0, 5) + '-' + hex.slice(5));
  }
  return codes;
}

export async function storeBackupCodes(userId: string, codes: string[]): Promise<void> {
  await ensureTwoFactorSchema();
  await db.execute(sql`DELETE FROM user_backup_codes WHERE user_id = ${userId}`);
  for (const c of codes) {
    await db.execute(sql`INSERT INTO user_backup_codes (user_id, code_hash) VALUES (${userId}, ${hashCode(c)})`);
  }
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  await ensureTwoFactorSchema();
  const rows = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM user_backup_codes WHERE user_id = ${userId} AND used_at IS NULL`));
  return rows[0]?.n || 0;
}

/** Consume a backup code (one-time). Returns true if it was valid + unused. */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  await ensureTwoFactorSchema();
  const rows = rowsOf(await db.execute(sql`UPDATE user_backup_codes SET used_at = now()
    WHERE user_id = ${userId} AND code_hash = ${hashCode(code)} AND used_at IS NULL RETURNING id`));
  return rows.length > 0;
}

// ── login-time verification ────────────────────────────────────────────────
/** True if the user has ANY second factor enabled (TOTP today; passkeys add on). */
export async function hasTotpOrBackup(userId: string): Promise<boolean> {
  return isTotpEnabled(userId);
}

/** Accept a live TOTP code OR an unused backup code. Used on the login challenge. */
export async function verifyLoginCode(userId: string, code: string): Promise<boolean> {
  const rec = await getTotpRecord(userId);
  if (rec && rec.confirmed && verifyTotp(rec.secret, code)) {
    await db.execute(sql`UPDATE user_totp SET last_used_at = now() WHERE user_id = ${userId}`).catch(() => {});
    return true;
  }
  return consumeBackupCode(userId, code);
}
