// POST /api/aquintutor/broadcast/say — viewer interactions at scale (Prompt H3b). Any signed-in
// viewer (read) may chat / react / raise a hand / vote — CHEAP pub/sub over the board fan-out, never
// video. Rate-limited. Votes + hands persist (tally + host pull-into-interactive); everything else is
// broadcast to all viewers (incl. the host) via the same SSE channel. Publishing a poll/slide/spec
// stays host-only through the board write path — this endpoint only carries viewer-side messages.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { underRateLimit } from '@/lib/llm/gateway';
import { fireBoardEvent } from '@/lib/board-session';
import { recordVote, raiseHand } from '@/lib/broadcast';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const ALLOWED = new Set(['chat', 'reaction', 'hand', 'vote', 'poll']);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'read', { type: 'AnimationObject' });   // viewers hold read
  if (!gate.allow) return j({ ok: false, error: 'forbidden' }, 403);
  if (!(await underRateLimit(String(user.id), 30, 60).catch(() => true))) return j({ ok: false, error: 'slow down' }, 429);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const id = String(b.id || ''); const msg = b.msg || {};
  if (!id || !ALLOWED.has(String(msg.kind))) return j({ ok: false, error: 'bad message' }, 400);
  const uid = String(user.id);

  try {
    // 'poll' is only meaningful from the host; a viewer sending it is harmless (still just a broadcast)
    if (msg.kind === 'vote') await recordVote(id, String(msg.pollId || ''), uid, Number(msg.option) || 0).catch(() => {});
    if (msg.kind === 'hand') await raiseHand(id, uid, String(msg.from || 'Viewer')).catch(() => {});
    // fan the message out to everyone on the broadcast (spec channel; structured, not video)
    const seq = await fireBoardEvent('bcast-' + id, { templateId: 'bcast-msg', params: msg, playState: 'static', timelinePos: 0 }, uid).catch(() => 0);
    return j({ ok: true, seq });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
