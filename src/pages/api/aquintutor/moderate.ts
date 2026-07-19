// POST /api/aquintutor/moderate — live moderation actions (Prompt AP2a). A moderator (delete cap)
// works the queue (remove/allow/dismiss) and can mute/remove a participant in a live room; muting
// broadcasts a control message so clients enforce it immediately, and is also enforced server-side in
// the say endpoint. Every action is audited via can(). Reporting is open to any signed-in participant.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { listQueue, actOnIncident, setRoomModeration, screenMessage, enqueueIncident } from '@/lib/moderation';
import { fireBoardEvent } from '@/lib/board-session';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const uid = String(user.id);

  try {
    // reporting is open to any participant
    if (b.action === 'report') {
      await enqueueIncident(String(b.surface || 'live'), b.roomId ? String(b.roomId) : null, b.targetUser ? String(b.targetUser) : null, screenMessage(String(b.text || '')), { reporter: uid }).catch(() => {});
      return j({ ok: true, reported: true });
    }

    const mod = await can(user, 'delete', { type: 'moderation' });   // moderator capability; audited
    if (!mod.allow) return j({ ok: false, error: 'moderator only' }, 403);

    if (b.action === 'queue') return j({ ok: true, queue: await listQueue(String(b.status || 'pending')) });
    if (b.action === 'act') { await actOnIncident(Number(b.id), b.decision === 'remove' ? 'remove' : b.decision === 'allow' ? 'allow' : 'dismiss', uid); return j({ ok: true }); }
    if (b.action === 'mute' || b.action === 'unmute' || b.action === 'remove') {
      const roomId = String(b.roomId || ''), target = String(b.userId || '');
      if (!roomId || !target) return j({ ok: false, error: 'room + user required' }, 400);
      const patch = b.action === 'mute' ? { muted: true } : b.action === 'unmute' ? { muted: false } : { removed: true, muted: true };
      await setRoomModeration(roomId, target, patch, uid);
      // tell the room live so clients enforce immediately (structured control, not video)
      await fireBoardEvent(roomId, { templateId: 'mod-action', params: { action: b.action, userId: target }, playState: 'static', timelinePos: 0 }, uid).catch(() => {});
      return j({ ok: true });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
