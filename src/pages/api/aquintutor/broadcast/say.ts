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
import { logEvent } from '@/lib/logger';

// THREE THINGS IN THIS FILE OPENED WHEN A LOOKUP THREW, AND ONE OF THEM WAS THE MUTE.
//
// 1. `roomModerationState(session, uid).catch(() => ({ muted: false, removed: false }))`. That is a
//    moderation decision resolved by a catch: any error reading the room's moderation rows — the
//    table absent, the pooler dropping the connection — answered "not muted, not removed" and the
//    person a moderator had just REMOVED for harassment was speaking in the room again. The lookup
//    failing tells us nothing about their state, so the message is now refused with a 503 that says
//    to try again. A viewer briefly unable to type is a smaller harm than a removed participant
//    being let back in, and it is the direction every other gate on this project fails.
//
// 2. `let isMinor = false; try { ... } catch {}`. A failed principal resolution downgraded strict
//    screening — the mode that blocks mild abuse and unmoderated contact for a child — to the adult
//    ruleset. Unknown is now screened STRICTLY. The guardian escalation still fires only on a
//    CONFIRMED minor, because alerting the guardians of somebody we could not identify is not a
//    safer error, it is a different one.
//
// 3. Every incident write and the guardian alert sat behind `.catch(() => {})`, so a blocked message
//    could leave no record in the moderator queue and a safety escalation could reach nobody, with
//    the endpoint answering ok. They stay non-fatal — a lost incident row must not un-block a
//    message that was correctly blocked — but the reason is written down now, and a REPORT that
//    fails to file says so instead of answering `reported: true`.
//
// Deliberately NOT changed: `underRateLimit(...).catch(() => true)`. A rate limiter that fails
// closed locks every viewer out of a live session on one bad read, and it guards cost, not safety.
// Reported rather than flipped.
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const ALLOWED = new Set(['chat', 'reaction', 'hand', 'vote', 'poll', 'report']);
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

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
    if (msg.kind === 'report') {
      try {
        await enqueueIncident('broadcast', session, String(msg.targetUser || ''), screenMessage(String(msg.text || '')), { reporter: uid });
      } catch (e: any) {
        logEvent('error', 'broadcast.say.report-failed', { userId: uid, session, message: reasonOf(e) });
        return j({ ok: false, error: 'That report could not be filed. It has NOT been recorded — please try again.' }, 500);
      }
      return j({ ok: true, reported: true });
    }

    // AP2: muted/removed participants can't send chat/reactions
    if (msg.kind === 'chat' || msg.kind === 'reaction') {
      let modState: { muted: boolean; removed: boolean };
      try {
        modState = await roomModerationState(session, uid);
      } catch (e: any) {
        // Refused, not admitted. See the note at the top of this file.
        logEvent('error', 'broadcast.say.modstate-failed', { userId: uid, session, message: reasonOf(e) });
        return j({ ok: false, error: 'Your session status could not be checked just now. Please try again in a moment.' }, 503);
      }
      if (modState.removed) return j({ ok: false, error: 'you have been removed from this session' }, 403);
      if (modState.muted) return j({ ok: false, error: 'you are muted' }, 403);
    }
    // AP2b: stage-aware screening. A minor author -> strict mode (blocks mild + unmoderated contact);
    // a safety event escalates to the linked guardian; a minor's incident is data-minimized.
    if (msg.kind === 'chat') {
      let isMinor = false;
      let ageKnown = true;
      try {
        isMinor = accessSummary(await resolvePrincipal(user)).isMinor;
      } catch (e: any) {
        ageKnown = false;
        logEvent('error', 'broadcast.say.principal-failed', { userId: uid, session, message: reasonOf(e) });
      }
      // Unknown is screened as strictly as a child. The guardian escalation below stays on a
      // CONFIRMED minor: we cannot alert the guardians of somebody we could not identify.
      const res = screenMessage(String(msg.body || ''), { strict: isMinor || !ageKnown });
      if (ageKnown && isSafetyEvent(res, isMinor)) {
        try {
          await notifyGuardians(uid, { title: 'Safety alert', body: 'A flagged message in a live session was blocked and logged for review.', link: '/aquintutor/access' });
        } catch (e: any) {
          logEvent('error', 'broadcast.say.guardian-alert-failed', { userId: uid, session, message: reasonOf(e) });
        }
      }
      if (!res.allowed) {
        try {
          await enqueueIncident('broadcast', session, uid, res, { status: 'blocked', minimize: isMinor });
        } catch (e: any) {
          logEvent('error', 'broadcast.say.incident-failed', { userId: uid, session, state: 'blocked', message: reasonOf(e) });
        }
        return j({ ok: false, error: 'message blocked by moderation', severity: res.severity });
      }
      if (res.flagged) {
        try {
          await enqueueIncident('broadcast', session, uid, res, { minimize: isMinor });
        } catch (e: any) {
          logEvent('error', 'broadcast.say.incident-failed', { userId: uid, session, state: 'flagged', message: reasonOf(e) });
        }
      }
    }

    if (msg.kind === 'vote') await recordVote(id, String(msg.pollId || ''), uid, Number(msg.option) || 0).catch(() => {});
    if (msg.kind === 'hand') await raiseHand(id, uid, String(msg.from || 'Viewer')).catch(() => {});
    // fan the message out to everyone on the broadcast (spec channel; structured, not video)
    const seq = await fireBoardEvent(session, { templateId: 'bcast-msg', params: msg, playState: 'static', timelinePos: 0 }, uid).catch(() => 0);
    return j({ ok: true, seq });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
