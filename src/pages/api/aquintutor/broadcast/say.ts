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
import { screenMessage, enqueueIncident, roomModerationState, isSafetyEvent } from '@/lib/moderation';
import { resolvePrincipal } from '@/lib/rbac';
import { accessSummary } from '@/lib/rbac/access';
import { notifyGuardians } from '@/lib/edu-notify';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const ALLOWED = new Set(['chat', 'reaction', 'hand', 'vote', 'poll', 'report']);

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

  const session = 'bcast-' + id;
  try {
    // AP2: a report routes a message into the moderator queue (no broadcast)
    if (msg.kind === 'report') { await enqueueIncident('broadcast', session, String(msg.targetUser || ''), screenMessage(String(msg.text || '')), { reporter: uid }).catch(() => {}); return j({ ok: true, reported: true }); }

    // AP2: muted/removed participants can't send chat/reactions
    if (msg.kind === 'chat' || msg.kind === 'reaction') {
      const modState = await roomModerationState(session, uid).catch(() => ({ muted: false, removed: false }));
      if (modState.removed) return j({ ok: false, error: 'you have been removed from this session' }, 403);
      if (modState.muted) return j({ ok: false, error: 'you are muted' }, 403);
    }
    // AP2b: stage-aware screening. A minor author -> strict mode (blocks mild + unmoderated contact);
    // a safety event escalates to the linked guardian; a minor's incident is data-minimized.
    if (msg.kind === 'chat') {
      let isMinor = false; try { isMinor = accessSummary(await resolvePrincipal(user)).isMinor; } catch {}
      const res = screenMessage(String(msg.body || ''), { strict: isMinor });
      if (isSafetyEvent(res, isMinor)) await notifyGuardians(uid, { title: 'Safety alert', body: 'A flagged message in a live session was blocked and logged for review.', link: '/aquintutor/access' }).catch(() => {});
      if (!res.allowed) { await enqueueIncident('broadcast', session, uid, res, { status: 'blocked', minimize: isMinor }).catch(() => {}); return j({ ok: false, error: 'message blocked by moderation', severity: res.severity }); }
      if (res.flagged) await enqueueIncident('broadcast', session, uid, res, { minimize: isMinor }).catch(() => {});
    }

    if (msg.kind === 'vote') await recordVote(id, String(msg.pollId || ''), uid, Number(msg.option) || 0).catch(() => {});
    if (msg.kind === 'hand') await raiseHand(id, uid, String(msg.from || 'Viewer')).catch(() => {});
    // fan the message out to everyone on the broadcast (spec channel; structured, not video)
    const seq = await fireBoardEvent(session, { templateId: 'bcast-msg', params: msg, playState: 'static', timelinePos: 0 }, uid).catch(() => 0);
    return j({ ok: true, seq });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
