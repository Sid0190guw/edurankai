import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';
import { db } from '@/lib/db';
import { sessions, users, type Session, type User } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;  // renew if <15 days remain

export function generateSessionToken(): string {
  const bytes = randomBytes(20);
  return encodeBase32LowerCaseNoPadding(bytes);
}

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

export async function createSession(
  token: string,
  userId: string,
  meta: { userAgent?: string; ipAddress?: string } = {}
): Promise<Session> {
  const id = hashToken(token);
  const [row] = await db.insert(sessions).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    userAgent: meta.userAgent ?? null,
    ipAddress: meta.ipAddress ?? null
  }).returning();
  return row;
}

export async function validateSessionToken(token: string): Promise<{ user: User; session: Session } | null> {
  const id = hashToken(token);
  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id));

  if (!row) return null;
  const { user, session } = row;

  if (Date.now() >= session.expiresAt.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  // Sliding renewal
  if (Date.now() >= session.expiresAt.getTime() - RENEW_THRESHOLD_MS) {
    const newExpiry = new Date(Date.now() + SESSION_DURATION_MS);
    await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, id));
    session.expiresAt = newExpiry;
  }

  if (!user.isActive) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  return { user, session };
}

export async function invalidateSession(token: string): Promise<void> {
  const id = hashToken(token);
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function invalidateAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
