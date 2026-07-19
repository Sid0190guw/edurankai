// POST /api/portal/meet/<room>/anim — server authority for the in-huddle animation board (Prompt
// H1b). Enforces the room role (host for grant/revoke/class-mode; host-or-presenter for fire) and
// AUDITS every presenter change + fire. The actual spec render/broadcast is peer-to-peer over the
// mesh; this endpoint is the authoritative role + audit + inspector layer. Roles gate via meet_rooms
// (host) + edu_huddle_presenters (presenters).
import type { APIRoute } from 'astro';
import { isRoomHost, canDriveHuddle, grantPresenter, revokePresenter, setClassMode, reportPresence, logHuddleEvent, huddleInspector } from '@/lib/huddle-session';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const room = String(params.room || '');
  if (!room) return j({ ok: false, error: 'no room' }, 400);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const uid = String(user.id);
  const host = await isRoomHost(room, uid);

  try {
    if (b.action === 'presence') { await reportPresence(room, uid, String(b.tier || 'standard'), host); return j({ ok: true }); }

    if (b.action === 'grant' || b.action === 'revoke') {
      if (!host) return j({ ok: false, error: 'only the host can change presenters' }, 403);   // room role
      const target = String(b.target || ''); if (!target) return j({ ok: false, error: 'no target' }, 400);
      if (b.action === 'grant') await grantPresenter(room, target, uid); else await revokePresenter(room, target, uid);
      return j({ ok: true });
    }

    if (b.action === 'class-mode') {
      if (!host) return j({ ok: false, error: 'only the host can set class mode' }, 403);
      await setClassMode(room, !!b.on); await logHuddleEvent(room, uid, 'class-mode', null, b.on ? 'on' : 'off');
      return j({ ok: true });
    }

    if (b.action === 'fire') {
      if (!(await canDriveHuddle(room, uid))) return j({ ok: false, error: 'only the host or a presenter can fire' }, 403);   // RBAC + room role
      await logHuddleEvent(room, uid, 'fire', String(b.kind || ''), String(b.summary || ''));   // audit
      return j({ ok: true });
    }

    if (b.action === 'inspect') {
      if (!host) return j({ ok: false, error: 'host only' }, 403);
      return j({ ok: true, ...(await huddleInspector(room)) });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
