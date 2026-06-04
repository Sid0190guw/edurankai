// Friend system with invite codes. Friendships are bidirectional (we store
// two rows so queries stay simple). Invite codes are 8-char alphanumeric.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'accepted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id), CHECK (user_id <> friend_id))`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS user_invite_codes (
      code VARCHAR(20) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  } catch (_) {}
}

function newCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip ambiguous chars
  let s = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export async function getOrCreateInviteCode(userId: string): Promise<string> {
  await ensureSchema();
  const existing = rows(await db.execute(sql`SELECT code FROM user_invite_codes WHERE user_id = ${userId} LIMIT 1`))[0] as any;
  if (existing) return existing.code;
  for (let i = 0; i < 8; i++) {
    const c = newCode();
    try {
      await db.execute(sql`INSERT INTO user_invite_codes (code, user_id) VALUES (${c}, ${userId})`);
      return c;
    } catch (_) { /* collision, retry */ }
  }
  throw new Error('Could not generate invite code');
}

export async function acceptInvite(currentUserId: string, code: string): Promise<{ ok: boolean; error?: string; friendId?: string; friendName?: string }> {
  await ensureSchema();
  const c = (code || '').trim().toUpperCase();
  if (!c) return { ok: false, error: 'Code required' };
  const owner = rows(await db.execute(sql`
    SELECT u.id, COALESCE(u.name, u.email) AS name FROM user_invite_codes ic JOIN users u ON ic.user_id = u.id
    WHERE ic.code = ${c} LIMIT 1
  `))[0] as any;
  if (!owner) return { ok: false, error: 'Code not found' };
  if (owner.id === currentUserId) return { ok: false, error: 'That\'s your own invite code 🙂' };

  // Insert both directions; ignore conflicts
  await db.execute(sql`
    INSERT INTO friendships (user_id, friend_id, status) VALUES (${currentUserId}, ${owner.id}, 'accepted')
    ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'
  `);
  await db.execute(sql`
    INSERT INTO friendships (user_id, friend_id, status) VALUES (${owner.id}, ${currentUserId}, 'accepted')
    ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'
  `);
  await db.execute(sql`UPDATE user_invite_codes SET uses = uses + 1 WHERE code = ${c}`).catch(() => {});
  // Award +50 XP to BOTH on first connection
  try {
    const { awardXp } = await import('@/lib/xp');
    await awardXp({ userId: currentUserId, source: 'friend_joined', delta: 50, reason: 'Accepted invite from ' + owner.name });
    await awardXp({ userId: owner.id, source: 'friend_invited', delta: 50, reason: 'Friend joined via your invite' });
  } catch (_) {}
  // Notify both users
  try {
    const cur = rows(await db.execute(sql`SELECT COALESCE(name, email) AS name FROM users WHERE id = ${currentUserId} LIMIT 1`))[0] as any;
    const { pushNotify } = await import('@/lib/push');
    await pushNotify.friendJoined(owner.id, cur?.name || 'A new learner');
    await pushNotify.friendJoined(currentUserId, owner.name);
  } catch (_) {}
  return { ok: true, friendId: owner.id, friendName: owner.name };
}

export async function getFriendList(userId: string) {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT f.friend_id AS user_id,
           COALESCE(u.name, u.email) AS name,
           COALESCE(x.streak_days, 0) AS streak,
           COALESCE(x.total_xp, 0) AS total_xp,
           COALESCE(x.level, 1) AS level,
           COALESCE(p.total_xp, 0) AS week_xp
    FROM friendships f JOIN users u ON f.friend_id = u.id
    LEFT JOIN user_xp x ON x.user_id = u.id
    LEFT JOIN xp_period_rollups p ON p.user_id = u.id
      AND p.period = 'week' AND p.period_key = date_trunc('week', CURRENT_DATE)::date
    WHERE f.user_id = ${userId} AND f.status = 'accepted'
    ORDER BY p.total_xp DESC NULLS LAST, x.total_xp DESC NULLS LAST
  `));
}

export async function removeFriend(userId: string, friendId: string): Promise<void> {
  await ensureSchema();
  await db.execute(sql`DELETE FROM friendships WHERE (user_id = ${userId} AND friend_id = ${friendId}) OR (user_id = ${friendId} AND friend_id = ${userId})`);
}
