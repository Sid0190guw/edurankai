import { db } from '@/lib/db';
import { randomBytes } from 'node:crypto';
import { users, type User } from '@/lib/db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { verifyPassword } from '@/lib/auth/password';

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 30) || 'user';
}

/**
 * Generate a unique internal handle of the form `firstname@edurankai.in`.
 * Falls back to `firstname.lastname@...`, then `firstname.lastnameXXXX@...` on collision.
 */
export async function generateInternalHandle(fullName: string): Promise<string> {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  const first = normalize(parts[0] || 'user');
  const last = normalize(parts[parts.length - 1] || '');

  const candidates = [
    first + '@edurankai.in',
    (last && last !== first) ? (first + '.' + last + '@edurankai.in') : null,
  ].filter((s): s is string => Boolean(s));

  // Try each base candidate
  for (const c of candidates) {
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.internalHandle, c)).limit(1);
    if (exists.length === 0) return c;
  }

  // Both base attempts collided - add random 4-char suffix
  for (let i = 0; i < 5; i++) {
    const suffix = randomBytes(3).toString('hex').substring(0, 4);
    const candidate = last
      ? first + '.' + last + suffix + '@edurankai.in'
      : first + suffix + '@edurankai.in';
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.internalHandle, candidate)).limit(1);
    if (exists.length === 0) return candidate;
  }

  // Final fallback - timestamp-based
  return first + Date.now().toString(36) + '@edurankai.in';
}

// ── sign-in identity ────────────────────────────────────────────────────────
// The offer letter tells every new employee they can sign in with "either your
// personal email OR your internal handle". These two helpers are what make that
// sentence true, identically, on every sign-in surface.

/**
 * Resolve a typed sign-in identifier to an account.
 *
 * Accepts a personal email OR an internal handle, matched case-insensitively
 * and trimmed. A handle is an identifier, not a mailbox, so nothing here
 * requires it to be deliverable or to look like a real address.
 *
 * Comparison is done with lower() on BOTH sides rather than lowercasing only
 * the input, because rows written before the handle column was normalised may
 * carry mixed case.
 *
 * PRECEDENCE IS EXPLICIT, AND IT HAS TO BE. `internal_handle` carries no unique
 * constraint (src/lib/db/schema.ts) and nothing stops one person's handle from
 * being another person's email address, so `OR ... LIMIT 1` alone let Postgres
 * pick either row — the same typed identifier could resolve to a different
 * account on two consecutive requests, purely on plan or physical row order.
 * Nobody signs in as somebody else that way (the password is still checked
 * against whichever row came back), but the owner of the identifier can be
 * intermittently unable to sign in at all, which reads as "my password stopped
 * working" and is close to undiagnosable. An email match therefore wins, and the
 * ordering makes the answer the same every time either way.
 */
export async function findUserByLoginIdentifier(identifier: string): Promise<User | null> {
  const id = (identifier || '').trim().toLowerCase();
  if (!id) return null;
  const found = await db.select().from(users).where(
    or(
      sql`lower(${users.email}) = ${id}`,
      sql`lower(${users.internalHandle}) = ${id}`
    )
  ).orderBy(sql`(lower(${users.email}) = ${id}) DESC, ${users.createdAt} ASC`).limit(1);
  return found[0] || null;
}

// A structurally valid scrypt hash that no password matches. Verifying against
// it costs exactly what verifying a real one costs.
const ABSENT_ACCOUNT_HASH =
  '00000000000000000000000000000000:' + '0'.repeat(128);

/**
 * Verify a password for a possibly-absent account WITHOUT leaking which case
 * happened.
 *
 * The natural spelling — `if (!user || !(await verifyPassword(...)))` — short
 * circuits, so an unknown handle answers in about a millisecond while a known
 * one pays for scrypt. That difference is a readable account-enumeration
 * oracle. Here scrypt always runs, on the real hash or on a decoy, so an
 * unknown handle and a wrong password cost the same and answer the same.
 *
 * Callers must still return ONE generic message for both outcomes.
 */
export async function verifyPasswordForLogin(user: User | null, password: string): Promise<boolean> {
  const stored = (user && user.passwordHash) ? user.passwordHash : ABSENT_ACCOUNT_HASH;
  const matched = await verifyPassword(stored, password || '');
  return !!user && matched;
}