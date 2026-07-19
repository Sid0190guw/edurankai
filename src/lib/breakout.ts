// src/lib/breakout.ts — breakout-room state (Prompt H2). The assignment itself is computed by the
// tested pure layer (public/aquin-room-transport.js) on the client; this persists it + the host
// facilities (announce to all, countdown timer, close). Additive self-bootstrapping table; room-host
// authority reuses meet_rooms via huddle-session. Each breakout is its own SMALL mesh room (base__boN);
// the animation spec-broadcast (H1) works inside each because it's just another room over the transport.
const BREAKOUT_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_breakout_sessions (
    room_id text PRIMARY KEY,
    rooms jsonb NOT NULL DEFAULT '[]',
    labels jsonb NOT NULL DEFAULT '[]',
    ends_at timestamptz,
    announcement text,
    closed boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const ddl of BREAKOUT_DDL) await db.execute(sql.raw(ddl)); _ready = true; }
  return { db, sql };
}
function safeArr(v: any): any[] { if (Array.isArray(v)) return v; try { return JSON.parse(String(v || '[]')); } catch { return []; } }

export interface BreakoutState { open: boolean; rooms: string[][]; labels: string[]; endsAt: string | null; announcement: string | null; closed: boolean }

export async function openBreakouts(roomId: string, roomsIn: string[][], labels: string[], endsAt: Date | null): Promise<void> {
  const { db, sql } = await ctx();
  const rooms = (roomsIn || []).slice(0, 50).map((r) => (Array.isArray(r) ? r.map(String).slice(0, 200) : []));
  await db.execute(sql`INSERT INTO edu_breakout_sessions (room_id, rooms, labels, ends_at, announcement, closed, updated_at)
    VALUES (${roomId}, ${JSON.stringify(rooms)}::jsonb, ${JSON.stringify(labels || [])}::jsonb, ${endsAt}, NULL, false, now())
    ON CONFLICT (room_id) DO UPDATE SET rooms = EXCLUDED.rooms, labels = EXCLUDED.labels, ends_at = EXCLUDED.ends_at, announcement = NULL, closed = false, updated_at = now()`);
}
export async function getBreakouts(roomId: string): Promise<BreakoutState> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT * FROM edu_breakout_sessions WHERE room_id = ${roomId} LIMIT 1`))[0];
  if (!r) return { open: false, rooms: [], labels: [], endsAt: null, announcement: null, closed: false };
  const rms = safeArr(r.rooms);
  return { open: !r.closed && rms.length > 0, rooms: rms, labels: safeArr(r.labels), endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null, announcement: r.announcement || null, closed: !!r.closed };
}
/** Which breakout index is this user assigned to? -1 = main room. */
export function indexOfUser(state: BreakoutState, userId: string): number {
  for (let i = 0; i < state.rooms.length; i++) if (state.rooms[i].map(String).includes(String(userId))) return i;
  return -1;
}
export async function moveParticipant(roomId: string, userId: string, toIndex: number): Promise<void> {
  const { db, sql } = await ctx();
  const st = await getBreakouts(roomId);
  const rooms = st.rooms.map((r) => r.filter((x) => String(x) !== String(userId)));
  if (toIndex >= 0 && toIndex < rooms.length) rooms[toIndex].push(String(userId));
  await db.execute(sql`UPDATE edu_breakout_sessions SET rooms = ${JSON.stringify(rooms)}::jsonb, updated_at = now() WHERE room_id = ${roomId}`);
}
export async function announce(roomId: string, text: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_breakout_sessions SET announcement = ${text.slice(0, 500)}, updated_at = now() WHERE room_id = ${roomId}`);
}
export async function setTimer(roomId: string, endsAt: Date | null): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_breakout_sessions SET ends_at = ${endsAt}, updated_at = now() WHERE room_id = ${roomId}`);
}
export async function closeBreakouts(roomId: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE edu_breakout_sessions SET closed = true, updated_at = now() WHERE room_id = ${roomId}`);
}
export async function breakoutInspector(roomId: string): Promise<{ open: boolean; closed: boolean; endsAt: string | null; announcement: string | null; rooms: { label: string; members: number }[] }> {
  const st = await getBreakouts(roomId);
  return { open: st.open, closed: st.closed, endsAt: st.endsAt, announcement: st.announcement, rooms: st.rooms.map((r, i) => ({ label: st.labels[i] || 'Room ' + (i + 1), members: r.length })) };
}
