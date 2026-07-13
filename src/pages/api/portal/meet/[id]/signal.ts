// /api/portal/meet/[id]/signal — WebRTC signaling relay + presence for the meeting
// room, so real participants can find each other and exchange SDP/ICE. Serverless-
// friendly (HTTP polling over Postgres, no persistent socket). Self-bootstraps its
// tables. This is the missing backend that turns the loopback demo into a real
// multi-peer MESH: each browser polls GET for signals addressed to it and posts its
// offers/answers/ICE via POST.
//
//   POST { action:'join'|'heartbeat'|'leave'|'signal', peerId, name?, to?, kind?, payload? }
//   GET  ?peerId=X&since=<cursor>  -> { roster:[...live peers...], signals:[...], cursor }
//
// Signals are addressed (to a peerId) or broadcast (to=null). A cursor (max signal
// id seen) drives incremental polling; old rows are swept by TTL.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let bootstrapped = false;
async function ensure() {
  if (bootstrapped) return;
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS meet_signals (
      id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL, from_peer TEXT NOT NULL,
      to_peer TEXT, kind TEXT NOT NULL, payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_meet_signals_room ON meet_signals (room_id, id)`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS meet_presence (
      room_id TEXT NOT NULL, peer_id TEXT NOT NULL, name TEXT, last_seen TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (room_id, peer_id))`);
    bootstrapped = true;
  } catch (_) { /* best-effort; caller degrades to loopback */ }
}

// presence heartbeat window: a peer is "live" if seen in the last 12s
const LIVE = `INTERVAL '12 seconds'`;

export const POST: APIRoute = async ({ request, params }) => {
  const roomId = String((params as any).id || '');
  if (!roomId) return json({ ok: false, error: 'room required' }, 400);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const peerId = String(b.peerId || '').slice(0, 80);
  if (!peerId) return json({ ok: false, error: 'peerId required' }, 400);
  await ensure();
  try {
    if (b.action === 'join' || b.action === 'heartbeat') {
      await db.execute(sql`INSERT INTO meet_presence (room_id, peer_id, name, last_seen)
        VALUES (${roomId}, ${peerId}, ${String(b.name || '').slice(0, 120)}, NOW())
        ON CONFLICT (room_id, peer_id) DO UPDATE SET last_seen = NOW(), name = COALESCE(EXCLUDED.name, meet_presence.name)`);
      if (b.action === 'join') {
        // announce join to the room so existing peers initiate a connection
        await db.execute(sql`INSERT INTO meet_signals (room_id, from_peer, to_peer, kind, payload) VALUES (${roomId}, ${peerId}, NULL, 'join', ${JSON.stringify({ name: b.name || '' })}::jsonb)`);
      }
      const roster = rows(await db.execute(sql`SELECT peer_id, name FROM meet_presence WHERE room_id = ${roomId} AND last_seen > NOW() - ${sql.raw(LIVE)}`));
      return json({ ok: true, roster: roster.map((r: any) => ({ peerId: r.peer_id, name: r.name })) });
    }
    if (b.action === 'leave') {
      await db.execute(sql`DELETE FROM meet_presence WHERE room_id = ${roomId} AND peer_id = ${peerId}`).catch(() => {});
      await db.execute(sql`INSERT INTO meet_signals (room_id, from_peer, to_peer, kind, payload) VALUES (${roomId}, ${peerId}, NULL, 'leave', '{}'::jsonb)`).catch(() => {});
      return json({ ok: true });
    }
    if (b.action === 'signal') {
      // relay an SDP/ICE message to a specific peer (or broadcast if no `to`)
      const to = b.to ? String(b.to).slice(0, 80) : null;
      const kind = String(b.kind || 'msg').slice(0, 20);
      await db.execute(sql`INSERT INTO meet_signals (room_id, from_peer, to_peer, kind, payload) VALUES (${roomId}, ${peerId}, ${to}, ${kind}, ${JSON.stringify(b.payload || {})}::jsonb)`);
      // opportunistic sweep of old signals (> 60s) to keep the table small
      await db.execute(sql`DELETE FROM meet_signals WHERE room_id = ${roomId} AND created_at < NOW() - INTERVAL '60 seconds'`).catch(() => {});
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error', degrade: true }, 200);
  }
};

export const GET: APIRoute = async ({ request, params }) => {
  const roomId = String((params as any).id || '');
  const url = new URL(request.url);
  const peerId = String(url.searchParams.get('peerId') || '');
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  if (!roomId || !peerId) return json({ ok: false, error: 'room + peerId required' }, 400);
  await ensure();
  try {
    // signals for me (addressed to me OR broadcast), not my own, newer than cursor
    const sig = rows(await db.execute(sql`SELECT id, from_peer, to_peer, kind, payload FROM meet_signals
      WHERE room_id = ${roomId} AND id > ${since} AND from_peer <> ${peerId}
        AND (to_peer = ${peerId} OR to_peer IS NULL)
      ORDER BY id ASC LIMIT 100`));
    const roster = rows(await db.execute(sql`SELECT peer_id, name FROM meet_presence WHERE room_id = ${roomId} AND last_seen > NOW() - ${sql.raw(LIVE)}`));
    const cursor = sig.length ? sig[sig.length - 1].id : since;
    return json({ ok: true, cursor, signals: sig.map((s: any) => ({ id: s.id, from: s.from_peer, to: s.to_peer, kind: s.kind, payload: s.payload })), roster: roster.map((r: any) => ({ peerId: r.peer_id, name: r.name })) });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error', degrade: true }, 200);
  }
};
