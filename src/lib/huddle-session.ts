// src/lib/huddle-session.ts — server state for the in-huddle animation board (Prompt H1b): presenter
// grants, a fire/presenter AUDIT trail, per-room class-mode config, and per-participant tier presence
// for the admin inspector. Authoritative role check (room host) reads the existing meet_rooms table;
// everything else is additive self-bootstrapping edu_huddle_* tables (this repo's dominant pattern).
const HUDDLE_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_huddle_presenters (
    room_id text NOT NULL, user_id text NOT NULL, granted_by text, granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS edu_huddle_fires (
    id bigserial PRIMARY KEY, room_id text NOT NULL, actor text, action text NOT NULL DEFAULT 'fire',
    kind text, summary text, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS edu_huddle_fires_room_idx ON edu_huddle_fires (room_id, id)`,
  `CREATE TABLE IF NOT EXISTS edu_huddle_config (
    room_id text PRIMARY KEY, class_mode boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS edu_huddle_presence (
    room_id text NOT NULL, user_id text NOT NULL, tier text NOT NULL DEFAULT 'standard', is_host boolean NOT NULL DEFAULT false,
    last_seen timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (room_id, user_id)
  )`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const ddl of HUDDLE_DDL) await db.execute(sql.raw(ddl)); _ready = true; }
  return { db, sql };
}

/** Authoritative room-host check (the existing meet_rooms table owns this). */
export async function isRoomHost(roomId: string, userId: string): Promise<boolean> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT host_user_id FROM meet_rooms WHERE id = ${roomId}::uuid LIMIT 1`));
    return !!r[0] && String(r[0].host_user_id) === String(userId);
  } catch { return false; }
}
export async function listPresenters(roomId: string): Promise<string[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT user_id FROM edu_huddle_presenters WHERE room_id = ${roomId}`)).map((r: any) => String(r.user_id));
}
/** Can this user drive the board in this room? host OR granted presenter (RBAC + room role). */
export async function canDriveHuddle(roomId: string, userId: string): Promise<boolean> {
  if (await isRoomHost(roomId, userId)) return true;
  return (await listPresenters(roomId)).includes(String(userId));
}
export async function grantPresenter(roomId: string, userId: string, grantedBy: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_huddle_presenters (room_id, user_id, granted_by) VALUES (${roomId}, ${userId}, ${grantedBy}) ON CONFLICT (room_id, user_id) DO NOTHING`);
  await logHuddleEvent(roomId, grantedBy, 'grant-presenter', null, 'granted ' + userId);
}
export async function revokePresenter(roomId: string, userId: string, by: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM edu_huddle_presenters WHERE room_id = ${roomId} AND user_id = ${userId}`);
  await logHuddleEvent(roomId, by, 'revoke-presenter', null, 'revoked ' + userId);
}
export async function logHuddleEvent(roomId: string, actor: string | null, action: string, kind: string | null, summary: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_huddle_fires (room_id, actor, action, kind, summary) VALUES (${roomId}, ${actor}, ${action}, ${kind}, ${summary})`);
}
export async function setClassMode(roomId: string, on: boolean): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_huddle_config (room_id, class_mode, updated_at) VALUES (${roomId}, ${on}, now()) ON CONFLICT (room_id) DO UPDATE SET class_mode = ${on}, updated_at = now()`);
}
export async function reportPresence(roomId: string, userId: string, tier: string, isHost: boolean): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_huddle_presence (room_id, user_id, tier, is_host, last_seen) VALUES (${roomId}, ${userId}, ${tier}, ${isHost}, now()) ON CONFLICT (room_id, user_id) DO UPDATE SET tier = ${tier}, last_seen = now()`);
}
export async function huddleInspector(roomId: string): Promise<{ presenters: string[]; fires: any[]; classMode: boolean; participants: any[] }> {
  const { db, sql } = await ctx();
  const presenters = await listPresenters(roomId);
  const fires = rows(await db.execute(sql`SELECT actor, action, kind, summary, created_at FROM edu_huddle_fires WHERE room_id = ${roomId} ORDER BY id DESC LIMIT 20`));
  const cfg = rows(await db.execute(sql`SELECT class_mode FROM edu_huddle_config WHERE room_id = ${roomId} LIMIT 1`));
  const participants = rows(await db.execute(sql`SELECT user_id, tier, is_host, last_seen FROM edu_huddle_presence WHERE room_id = ${roomId} AND last_seen > now() - interval '2 minutes' ORDER BY last_seen DESC`));
  return { presenters, fires, classMode: !!cfg[0]?.class_mode, participants };
}
/** Recent in-huddle animation fires across all rooms (admin inspector). */
export async function recentHuddleFires(limit = 20): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT room_id, actor, action, kind, summary, created_at FROM edu_huddle_fires ORDER BY id DESC LIMIT ${limit}`));
}
