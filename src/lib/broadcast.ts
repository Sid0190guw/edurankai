// src/lib/broadcast.ts — broadcast session registry (Prompt H3). A broadcast is one teacher -> many
// viewers. The animation SPEC + slides fan out over the board channel (session 'bcast-<id>', which
// already scales statelessly via SSE + Last-Event-ID); viewers PULL. Video egress (HLS/CDN) is a
// provisioning follow-up (docs/huddle-sfu-followup.md) — the low-bitrate default (audio+slides+specs)
// is the mass-scale path. Additive self-bootstrapping table; viewer count reuses board participants.
import { sessionInspector } from '@/lib/board-session';

const BCAST_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_broadcasts (
    id text PRIMARY KEY, host text, title text NOT NULL DEFAULT 'Live session',
    low_bitrate boolean NOT NULL DEFAULT true, live boolean NOT NULL DEFAULT false,
    started_at timestamptz, stopped_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS edu_broadcast_votes (
    broadcast_id text NOT NULL, poll_id text NOT NULL, user_id text NOT NULL, option int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (broadcast_id, poll_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS edu_broadcast_hands (
    broadcast_id text NOT NULL, user_id text NOT NULL, name text, raised_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (broadcast_id, user_id)
  )`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const ddl of BCAST_DDL) await db.execute(sql.raw(ddl)); _ready = true; }
  return { db, sql };
}
function newId(): string { try { return (globalThis as any).crypto.randomUUID().slice(0, 8); } catch { return Math.random().toString(36).slice(2, 10); } }

export interface Broadcast { id: string; host: string | null; title: string; lowBitrate: boolean; live: boolean }
function toBroadcast(r: any): Broadcast { return { id: String(r.id), host: r.host ? String(r.host) : null, title: String(r.title || 'Live session'), lowBitrate: !!r.low_bitrate, live: !!r.live }; }

export async function createBroadcast(host: string, title: string, lowBitrate: boolean): Promise<string> {
  const { db, sql } = await ctx();
  const id = newId();
  await db.execute(sql`INSERT INTO edu_broadcasts (id, host, title, low_bitrate, live, started_at) VALUES (${id}, ${host}, ${title.slice(0, 160) || 'Live session'}, ${lowBitrate}, true, now())`);
  return id;
}
export async function stopBroadcast(id: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_broadcasts SET live = false, stopped_at = now() WHERE id = ${id}`);
}
export async function setLowBitrate(id: string, on: boolean): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_broadcasts SET low_bitrate = ${on} WHERE id = ${id}`);
}
export async function getBroadcast(id: string): Promise<Broadcast | null> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT * FROM edu_broadcasts WHERE id = ${id} LIMIT 1`))[0];
  return r ? toBroadcast(r) : null;
}
export async function isHost(id: string, userId: string): Promise<boolean> {
  const b = await getBroadcast(id); return !!b && String(b.host) === String(userId);
}
/** Live viewer count reuses the board fan-out participants for session 'bcast-<id>'. */
export async function viewerCount(id: string): Promise<number> {
  try { const insp = await sessionInspector('bcast-' + id); return insp.online; } catch { return 0; }
}
export async function broadcastState(id: string): Promise<{ live: boolean; title: string; lowBitrate: boolean; viewers: number } | null> {
  const b = await getBroadcast(id); if (!b) return null;
  return { live: b.live, title: b.title, lowBitrate: b.lowBitrate, viewers: await viewerCount(id) };
}
export async function listLive(limit = 30): Promise<Broadcast[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_broadcasts WHERE live = true ORDER BY started_at DESC LIMIT ${limit}`)).map(toBroadcast);
}
export async function recentBroadcasts(limit = 20): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT id, host, title, low_bitrate, live, started_at, stopped_at FROM edu_broadcasts ORDER BY created_at DESC LIMIT ${limit}`));
}

// ---- H3b: poll votes (one per viewer) + raised hands (host pulls into an interactive room) ----
export async function recordVote(broadcastId: string, pollId: string, userId: string, option: number): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_broadcast_votes (broadcast_id, poll_id, user_id, option) VALUES (${broadcastId}, ${pollId}, ${userId}, ${option})
    ON CONFLICT (broadcast_id, poll_id, user_id) DO UPDATE SET option = ${option}, created_at = now()`);
}
export async function pollTally(broadcastId: string, pollId: string): Promise<Record<number, number>> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT option, COUNT(*)::int AS c FROM edu_broadcast_votes WHERE broadcast_id = ${broadcastId} AND poll_id = ${pollId} GROUP BY option`));
  const out: Record<number, number> = {}; for (const row of r) out[Number(row.option)] = Number(row.c); return out;
}
export async function raiseHand(broadcastId: string, userId: string, name: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_broadcast_hands (broadcast_id, user_id, name) VALUES (${broadcastId}, ${userId}, ${name.slice(0, 60)})
    ON CONFLICT (broadcast_id, user_id) DO UPDATE SET raised_at = now()`);
}
export async function listHands(broadcastId: string): Promise<{ userId: string; name: string }[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT user_id, name FROM edu_broadcast_hands WHERE broadcast_id = ${broadcastId} ORDER BY raised_at DESC LIMIT 50`)).map((r: any) => ({ userId: String(r.user_id), name: String(r.name || 'Viewer') }));
}
export async function clearHand(broadcastId: string, userId: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM edu_broadcast_hands WHERE broadcast_id = ${broadcastId} AND user_id = ${userId}`);
}
