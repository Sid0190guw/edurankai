// POST /api/aquintutor/broadcast — broadcast lifecycle (Prompt H3). Faculty start/stop a broadcast +
// toggle low-bitrate; anyone signed-in reads state (viewer count etc.). The actual spec/slide fan-out
// is the board fire API on session 'bcast-<id>' (reused, scales statelessly); this endpoint owns the
// session registry + authority. Audited via the board's own audit on each fire.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { createBroadcast, stopBroadcast, setLowBitrate, isHost, broadcastState } from '@/lib/broadcast';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const uid = String(user.id);

  try {
    if (b.action === 'state') { const st = await broadcastState(String(b.id || '')); return st ? j({ ok: true, ...st }) : j({ ok: false, error: 'no such broadcast' }); }

    if (b.action === 'create') {
      const gate = await can(user, 'write', { type: 'AnimationObject' });   // faculty start broadcasts
      if (!gate.allow) return j({ ok: false, error: 'only faculty can go live' }, 403);
      const id = await createBroadcast(uid, String(b.title || 'Live session'), b.lowBitrate !== false);
      return j({ ok: true, id });
    }

    // host-only lifecycle
    const id = String(b.id || ''); if (!id) return j({ ok: false, error: 'no id' }, 400);
    if (!(await isHost(id, uid))) return j({ ok: false, error: 'only the host can control this broadcast' }, 403);
    if (b.action === 'stop') { await stopBroadcast(id); return j({ ok: true }); }
    if (b.action === 'low-bitrate') { await setLowBitrate(id, !!b.on); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
