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
import { ddlPermitted } from '@/lib/schema-bootstrap';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

// ── schema bootstrap ───────────────────────────────────────────────────────
// THE MEMO MUST NOT RECORD "DONE" FOR WORK PRODUCTION WAS FORBIDDEN TO DO.
//
// `ensured = true` was set whether or not anything was created. In production db.execute REFUSES
// DDL (src/lib/db/index.ts) and returns the same empty result a real CREATE gives, so the very first
// call on every instance sailed through, created nothing, and latched the flag — which then made the
// one call that IS allowed to create things a no-op. That is why /admin/ops and /admin/setup could
// press "run every bootstrap" on a warm instance and honestly report success over a table that still
// did not exist.
//
// So the flag is set only when the run could actually have created something. While DDL is
// suppressed the statements are re-issued on each call and cost NOTHING — guardedExecute returns a
// resolved empty array without touching the network — and the moment an operator opens the escape
// hatch with allowingDdl(), the next call does the real work.
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
  // Only a run that was PERMITTED to create anything may record that it did.
  if (ddlPermitted()) ensured = true;
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

/**
 * Which 30-second step a code belongs to, or null when it matches none inside the drift window.
 *
 * The step NUMBER is what makes single-use enforcement possible. A boolean says only "this code is
 * valid right now", which stays true for the whole ±window and is therefore still true on a replay.
 */
export function matchTotpStep(secretB32: string, token: string, window = 1): number | null {
  const code = (token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (safeEqStr(hotp(secret, step + i), code)) return step + i;
  }
  return null;
}

/** Verify a 6-digit TOTP against a base32 secret, ±`window` 30s steps for clock drift. */
export function verifyTotp(secretB32: string, token: string, window = 1): boolean {
  return matchTotpStep(secretB32, token, window) !== null;
}

/**
 * SPEND A STEP. Returns false when this step — or a later one — has already been spent, which means
 * the caller is presenting a code that has already signed somebody in.
 *
 * WHY THIS EXISTS. RFC 6238 s.5.2 requires a verifier to refuse a code it has already accepted, and
 * nothing here did. verifyTotp() accepts the current 30-second step plus one either side, so one
 * six-digit code stayed good for about ninety seconds and could be used as often as it was sent. On
 * the second-factor path that is contained, because the pending challenge is burned on first use —
 * but /api/auth/totp-login signs somebody in on an authenticator code ALONE, and there a code read
 * over a shoulder, left in a screen recording, or captured by a phishing page was a complete sign-in
 * for whoever replayed it inside the window.
 *
 * WHY IT REUSES last_used_at RATHER THAN A NEW COLUMN. The high-water mark is written as the START
 * INSTANT OF THE STEP (`to_timestamp(step * 30)`) instead of now(), which makes the column both the
 * "last used" timestamp it always was — accurate to within one 30-second step — and the guard. No
 * schema change, nothing dropped, and no live row is invalidated: a legacy value written by the old
 * `now()` path is simply an earlier instant, so the next genuine code still compares greater. The
 * column is read nowhere else in this codebase.
 *
 * The comparison lives in the WHERE clause on purpose. A read-then-write would let two concurrent
 * replays both observe "not yet spent" and both succeed; exactly one UPDATE can match this one.
 */
async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const marker = step * 30;
  const rows = rowsOf(await db.execute(sql`
    UPDATE user_totp
       SET last_used_at = to_timestamp(${marker})
     WHERE user_id = ${userId}
       AND (last_used_at IS NULL OR last_used_at < to_timestamp(${marker}))
     RETURNING user_id
  `));
  return rows.length > 0;
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
  const step = matchTotpStep(rec.secret, token);
  if (step === null) return false;
  // The confirming code is spent too, so it cannot be turned round and replayed at
  // /api/auth/totp-login (which signs somebody in on a code alone) in the seconds after enrolment.
  await db.execute(sql`
    UPDATE user_totp
       SET confirmed_at = COALESCE(confirmed_at, now()), last_used_at = to_timestamp(${step * 30})
     WHERE user_id = ${userId}
  `);
  return true;
}

export async function disableTotp(userId: string): Promise<void> {
  await ensureTwoFactorSchema();
  await db.execute(sql`DELETE FROM user_totp WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM user_backup_codes WHERE user_id = ${userId}`);
}

/**
 * Drop the authenticator SECRET only, leaving recovery codes intact.
 *
 * For abandoning an enrolment that was never confirmed. disableTotp() above also deletes every
 * recovery code, which is correct when somebody has just PROVED a factor and asked to remove their
 * second factor entirely — and wrong when nothing has been proved at all. /api/2fa/disable called the
 * destructive one on its unproved branch, so any signed-in session could delete the ten single-use
 * codes of an account whose second step is enforced through FACE (isTotpEnabled is false there), with
 * no code, no confirmation, and no way to get them back: storeBackupCodes keeps only hashes. Those
 * codes are the documented way back in when a phone is lost.
 */
export async function deleteTotpSecret(userId: string): Promise<void> {
  await ensureTwoFactorSchema();
  await db.execute(sql`DELETE FROM user_totp WHERE user_id = ${userId}`);
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
  if (rec && rec.confirmed) {
    const step = matchTotpStep(rec.secret, code);
    if (step !== null) {
      // The claim is NOT swallowed with `.catch(() => {})` the way the old last_used_at touch was.
      // That call was cosmetic and a failure cost nothing; this one is the single-use guard, and
      // accepting a code whose spend could not be recorded is accepting an unlimited replay of it.
      let claimed = false;
      try {
        claimed = await claimTotpStep(userId, step);
      } catch (e: any) {
        console.error('[auth/twofactor] could not record the authenticator code as spent; refusing it.',
          e?.cause?.message || e?.message);
        return false;
      }
      // A correctly-formed code that is already spent is a replay, not a backup code — six digits can
      // never match the `xxxxx-xxxxx` shape generateBackupCodes() mints, so there is nothing to fall
      // through to and falling through would only cost a wasted query.
      return claimed;
    }
  }
  return consumeBackupCode(userId, code);
}
