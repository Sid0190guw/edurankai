// /api/portal/meet/[id]/signal — WebRTC signaling relay + presence for the meeting room, so real
// participants can find each other and exchange SDP/ICE. Serverless-friendly (HTTP polling over
// Postgres, no persistent socket). Self-bootstraps its tables.
//
//   POST { action:'join'|'heartbeat'|'leave'|'signal', peerId, name?, to?, kind?, payload? }
//   GET  ?peerId=X&since=<cursor>  -> { roster:[...live peers...], signals:[...], cursor }
//
// ═══ THE HOLE THIS FILE USED TO BE ═══
//
// Neither handler read `locals`, so neither knew who was calling, and src/middleware.ts isExempt()
// returns true for every path under /api/ — there is no structural gate in front of this URL. So
// anyone who learned or guessed a 10-character room code could POST action=join to appear in the
// roster, GET the full live roster (peer ids and display names) and relay/receive SDP and ICE. That
// is FULL PARTICIPATION IN THE MESH of an internal meeting, not merely metadata. meet_rooms.passcode
// and the waiting-room flag were never consulted. Both siblings under the same prefix —
// portal/meet/[room]/anim.ts and .../breakout.ts — already required a signed-in user and a host
// check, so this was an inconsistency inside one feature, not a considered design.
//
// ═══ THE GATE, AND WHY IT IS SHAPED THIS WAY ═══
//
// Two different surfaces drive this endpoint and they are not the same kind of thing:
//
//   1. /portal/meet/<code> — a real meeting. The page already requires a session, resolves a
//      meet_rooms row for the code (creating one on first open) and passes the SIGNED-IN USER'S ID
//      as the peer id. So for any room id that resolves to a meet_rooms row we now require a signed-
//      in caller and require peerId to BE that user's id. Nobody who can use the room today loses
//      anything: the page admits any signed-in user holding the code, and so does this.
//
//   2. /aquintutor/classroom/live?room=<anything> — a PUBLIC teaching demo with ad-hoc room ids
//      ('aqt-classroom-physics11-fluid') and random peer ids, reachable without signing in. Those
//      ids resolve to no meet_rooms row. Requiring a session for them would break a page that works
//      today, which this sprint does not do, so they keep the old anonymous behaviour.
//
// The consequence that matters: a guessed or leaked MEETING code now lands in branch 1 and is
// refused, because opening the room page is what creates its meet_rooms row. The residual — an
// anonymous relay for ids that name no room — is reported rather than hidden.
//
// Breakout sub-rooms are '<base>__bo<n>' (public/aquin-room-transport.js). The suffix is stripped
// before the lookup so a breakout inherits the membership rule of its parent instead of falling
// through to the anonymous branch.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const prerender = false;

// Declared before every handler that reads them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// presence heartbeat window: a peer is "live" if seen in the last 12s
const LIVE = `INTERVAL '12 seconds'`;

/** '<base>__bo3' -> '<base>'. Mirrors baseOf() in public/aquin-room-transport.js. */
function baseRoomOf(id: string): string {
  return String(id || '').replace(/__bo\d+$/, '');
}

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
  } catch (e: any) {
    console.error('[api/portal/meet/signal] bootstrap', causeOf(e));
  }
}

type Admission =
  | { ok: true; managed: boolean }
  | { ok: false; status: number; error: string };

/**
 * Decide whether this caller may touch this room, and with this peer id.
 *
 * FAILS CLOSED. If the meet_rooms lookup throws we cannot tell a managed room from an ad-hoc one, so
 * we refuse rather than fall through to the anonymous branch — the fall-through would turn a
 * database hiccup into an open relay on every real meeting at once.
 */
async function admit(roomId: string, peerId: string, locals: any): Promise<Admission> {
  const base = baseRoomOf(roomId);
  let managed = false;
  try {
    // Looked up by room_code OR id::text. Compared ::text on both sides: meet_rooms.id is uuid on
    // the canonical shape and TEXT on the legacy one (see src/lib/meet-schema.ts), and ::uuid throws
    // on a value that is not one — which, in a gate, would deny everybody.
    const found = rows(await db.execute(sql`
      SELECT id FROM meet_rooms
      WHERE room_code = ${base} OR id::text = ${base}
      LIMIT 1
    `));
    managed = found.length > 0;
  } catch (e: any) {
    console.error('[api/portal/meet/signal] room lookup', causeOf(e));
    return { ok: false, status: 503, error: 'This room could not be checked just now. Try again in a moment.' };
  }

  if (!managed) return { ok: true, managed: false };

  const user = locals?.user;
  if (!user?.id) return { ok: false, status: 401, error: 'Sign in to join this meeting.' };
  // The peer id IS the user id on the meeting page. Binding it stops a signed-in participant from
  // occupying somebody else's slot in the roster or receiving signals addressed to them.
  if (String(peerId) !== String(user.id)) {
    return { ok: false, status: 403, error: 'That peer id does not belong to your session.' };
  }
  return { ok: true, managed: true };
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const roomId = String((params as any).id || '');
  if (!roomId) return json({ ok: false, error: 'room required' }, 400);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const peerId = String(b.peerId || '').slice(0, 80);
  if (!peerId) return json({ ok: false, error: 'peerId required' }, 400);

  // AUTHORISE BEFORE THE HANDLER RUNS — before any read of the roster and before any write.
  const verdict = await admit(roomId, peerId, locals);
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, verdict.status);

  await ensure();
  try {
    if (b.action === 'join' || b.action === 'heartbeat') {
      // On a managed room the display name comes from the session, not from the body: a name typed
      // into a request is a free way to appear in a colleague's roster as somebody else.
      const claimed = String(b.name || '').slice(0, 120);
      const displayName = verdict.managed
        ? String((locals as any)?.user?.name || (locals as any)?.user?.email || claimed || '').slice(0, 120)
        : claimed;
      await db.execute(sql`INSERT INTO meet_presence (room_id, peer_id, name, last_seen)
        VALUES (${roomId}, ${peerId}, ${displayName}, NOW())
        ON CONFLICT (room_id, peer_id) DO UPDATE SET last_seen = NOW(), name = COALESCE(EXCLUDED.name, meet_presence.name)`);
      if (b.action === 'join') {
        // announce join to the room so existing peers initiate a connection
        await db.execute(sql`INSERT INTO meet_signals (room_id, from_peer, to_peer, kind, payload) VALUES (${roomId}, ${peerId}, NULL, 'join', ${JSON.stringify({ name: displayName })}::jsonb)`);
      }
      const roster = rows(await db.execute(sql`SELECT peer_id, name FROM meet_presence WHERE room_id = ${roomId} AND last_seen > NOW() - ${sql.raw(LIVE)}`));
      return json({ ok: true, roster: roster.map((r: any) => ({ peerId: r.peer_id, name: r.name })) });
    }
    if (b.action === 'leave') {
      await db.execute(sql`DELETE FROM meet_presence WHERE room_id = ${roomId} AND peer_id = ${peerId}`).catch((e: any) => console.error('[api/portal/meet/signal] leave presence', causeOf(e)));
      await db.execute(sql`INSERT INTO meet_signals (room_id, from_peer, to_peer, kind, payload) VALUES (${roomId}, ${peerId}, NULL, 'leave', '{}'::jsonb)`).catch((e: any) => console.error('[api/portal/meet/signal] leave signal', causeOf(e)));
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
    console.error('[api/portal/meet/signal] POST', causeOf(e));
    return json({ ok: false, error: 'server error', degrade: true }, 200);
  }
};

export const GET: APIRoute = async ({ request, params, locals }) => {
  const roomId = String((params as any).id || '');
  const url = new URL(request.url);
  const peerId = String(url.searchParams.get('peerId') || '');
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  if (!roomId || !peerId) return json({ ok: false, error: 'room + peerId required' }, 400);

  // The GET is where the roster and every addressed signal are READ. It carries the same gate as the
  // POST; guarding only the write half would have left the disclosure wide open.
  const verdict = await admit(roomId, peerId, locals);
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, verdict.status);

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
    console.error('[api/portal/meet/signal] GET', causeOf(e));
    return json({ ok: false, error: 'server error', degrade: true }, 200);
  }
};
