// POST/GET /api/portal/meet/<room>/breakout — breakout facilities (Prompt H2). Host-gated for
// open/move/announce/timer/close (room role via meet_rooms); any participant may read state to find
// their assigned small room + the current announcement/timer. The assignment itself is computed by
// the tested pure transport layer on the client and persisted here. Audited via the huddle event log.
import type { APIRoute } from 'astro';
import { isRoomHost, logHuddleEvent } from '@/lib/huddle-session';
import { openBreakouts, getBreakouts, indexOfUser, moveParticipant, announce, setTimer, closeBreakouts, breakoutInspector } from '@/lib/breakout';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ params, locals }) => {
  const user = (locals as any)?.user; if (!user) return j({ ok: false, error: 'sign in' }, 401);
  const room = String(params.room || '');
  const st = await getBreakouts(room).catch(() => null);
  if (!st) return j({ ok: true, open: false });
  return j({ ok: true, open: st.open, closed: st.closed, endsAt: st.endsAt, announcement: st.announcement, myIndex: indexOfUser(st, String(user.id)), roomCount: st.rooms.length, labels: st.labels });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any)?.user; if (!user) return j({ ok: false, error: 'sign in' }, 401);
  const room = String(params.room || ''); const uid = String(user.id);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const host = await isRoomHost(room, uid);

  try {
    if (b.action === 'state') {   // any participant: where am I + timer/announcement
      const st = await getBreakouts(room);
      return j({ ok: true, open: st.open, closed: st.closed, endsAt: st.endsAt, announcement: st.announcement, myIndex: indexOfUser(st, uid), roomCount: st.rooms.length, labels: st.labels });
    }
    if (!host) return j({ ok: false, error: 'only the host can manage breakouts' }, 403);   // all below are host-only

    if (b.action === 'open') {
      const rooms = Array.isArray(b.rooms) ? b.rooms : [];
      const endsAt = b.seconds ? new Date(Date.now() + Number(b.seconds) * 1000) : null;
      await openBreakouts(room, rooms, b.labels || [], endsAt);
      await logHuddleEvent(room, uid, 'breakout-open', null, rooms.length + ' rooms');
      return j({ ok: true, rooms: rooms.length });
    }
    if (b.action === 'move') { await moveParticipant(room, String(b.target), Number(b.toIndex)); await logHuddleEvent(room, uid, 'breakout-move', null, String(b.target) + '->' + b.toIndex); return j({ ok: true }); }
    if (b.action === 'announce') { await announce(room, String(b.text || '')); await logHuddleEvent(room, uid, 'breakout-announce', null, String(b.text || '').slice(0, 80)); return j({ ok: true }); }
    if (b.action === 'timer') { await setTimer(room, b.seconds ? new Date(Date.now() + Number(b.seconds) * 1000) : null); return j({ ok: true }); }
    if (b.action === 'close') { await closeBreakouts(room); await logHuddleEvent(room, uid, 'breakout-close', null, 'pulled everyone back'); return j({ ok: true }); }
    if (b.action === 'inspect') return j({ ok: true, ...(await breakoutInspector(room)) });
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
