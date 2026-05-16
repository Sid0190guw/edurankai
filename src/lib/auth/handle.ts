import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

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
    const suffix = Math.random().toString(36).substring(2, 6);
    const candidate = last
      ? first + '.' + last + suffix + '@edurankai.in'
      : first + suffix + '@edurankai.in';
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.internalHandle, candidate)).limit(1);
    if (exists.length === 0) return candidate;
  }

  // Final fallback - timestamp-based
  return first + Date.now().toString(36) + '@edurankai.in';
}