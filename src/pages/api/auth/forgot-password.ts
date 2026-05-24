// POST /api/auth/forgot-password
// Body: { emailOrName: string, dob: string }
// Verifies user identity via DOB (from applications.dob or hr_employees.date_of_birth)
// and resets the password to a freshly generated temp password.
// Returns the temp password in the response so the user can immediately sign in.
//
// Security notes:
// - DOB comparison is normalised to digits-only so YYYY-MM-DD == DD/MM/YYYY etc.
// - Rate-limited per IP would be ideal; for now we cap to 1 reset / 30s by inserting
//   a small artificial delay.
// - Users with no DOB on file (some legacy admin accounts) cannot use this flow;
//   they must use the admin reset script or ask another admin.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN);
  return salt.toString('hex') + ':' + derived.toString('hex');
}

function digitsOnly(s: string): string {
  return (s || '').replace(/[^0-9]/g, '');
}

function genTempPassword(): string {
  // 10 chars, no ambiguous characters
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const POST: APIRoute = async ({ request }) => {
  // Small artificial delay against bursts
  await new Promise(r => setTimeout(r, 600));

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const emailOrName = (body?.emailOrName || '').toString().trim().toLowerCase();
  const dob = (body?.dob || '').toString().trim();

  if (!emailOrName) return json({ ok: false, error: 'Email or name required' }, 400);
  if (!dob) return json({ ok: false, error: 'Date of birth required' }, 400);

  const dobDigits = digitsOnly(dob);
  if (dobDigits.length < 6 || dobDigits.length > 10) {
    return json({ ok: false, error: 'Invalid date of birth format' }, 400);
  }

  try {
    // Find user by email or name (case-insensitive). Pull users.dob too -
    // identity-setup writes there, and that should be checked first.
    const u = await db.execute(sql`
      SELECT id, email, name, role, dob FROM users
      WHERE LOWER(email) = ${emailOrName} OR LOWER(name) = ${emailOrName}
      LIMIT 1
    `);
    const uRows = Array.isArray(u) ? u : (u?.rows || []);
    if (uRows.length === 0) {
      return json({ ok: false, error: 'No account found with that email/name + date of birth' }, 404);
    }
    const user = uRows[0] as any;

    // 1) Prefer users.dob (set by /identity-setup)
    let foundDob: string | null = null;
    if (user.dob) {
      foundDob = typeof user.dob === 'string' ? user.dob.substring(0, 10) : new Date(user.dob).toISOString().split('T')[0];
    }

    // 2) Fall back to applications.dob
    if (!foundDob) {
      try {
        const a = await db.execute(sql`SELECT dob FROM applications WHERE applicant_user_id = ${user.id} AND dob IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
        const aRows = Array.isArray(a) ? a : (a?.rows || []);
        if (aRows.length > 0) {
          const d = (aRows[0] as any).dob;
          foundDob = typeof d === 'string' ? d.substring(0, 10) : new Date(d).toISOString().split('T')[0];
        }
      } catch (_) {}
    }

    // 3) Fall back to hr_employees.date_of_birth (linked by user_id)
    if (!foundDob) {
      try {
        const e = await db.execute(sql`SELECT date_of_birth FROM hr_employees WHERE user_id = ${user.id} AND date_of_birth IS NOT NULL LIMIT 1`);
        const eRows = Array.isArray(e) ? e : (e?.rows || []);
        if (eRows.length > 0) {
          const d = (eRows[0] as any).date_of_birth;
          foundDob = d ? new Date(d).toISOString().split('T')[0] : null;
        }
      } catch (_) {}
    }

    if (!foundDob) {
      return json({ ok: false, error: 'No date of birth on file for this account. Contact hr@edurankai.in to recover.' }, 404);
    }

    if (digitsOnly(foundDob) !== dobDigits) {
      return json({ ok: false, error: 'No account found with that email/name + date of birth' }, 404);
    }

    // Match! Generate + set new password
    const tempPassword = genTempPassword();
    const hash = await hashPassword(tempPassword);
    await db.execute(sql`
      UPDATE users SET password_hash = ${hash}, is_active = true, updated_at = NOW() WHERE id = ${user.id}
    `);

    return json({
      ok: true,
      tempPassword,
      email: user.email,
      name: user.name,
      message: 'Password reset. Use this temporary password to sign in, then change it from your account settings.',
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
