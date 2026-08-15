// POST /api/aquintutor/lms/live-egress — the control plane for a live class on an external platform.
//
// NO VIDEO PASSES THROUGH HERE, and it is worth being exact about why: a browser cannot open a raw
// TCP socket, so it cannot speak RTMP, and the platform on the other side accepts no WebRTC ingest.
// The teacher's own encoder pushes straight to the platform. This route schedules the event, hands
// back the address and key that encoder needs, reports whether it is live, and ends it.
//
// THE STREAM KEY IS A SECRET AND IS TREATED LIKE ONE.
//  - It is never written to our database. `ingest` fetches it at the moment the host asks.
//  - It is returned only to somebody with a TEACHING claim on the named course, resolved server-side
//    from the session. Not to a learner, not to a signed-out caller, not on a course they do not
//    teach.
//  - Responses are no-store. A stream key in a shared cache is a stream key somebody else can use
//    to broadcast onto your channel.
import type { APIRoute } from 'astro';
import { teachClaim } from '@/lib/lms/access';
import {
  platformCredentials, liveEgressStatus, ensureIngest, createEvent, bind, state, end,
} from '@/lib/live-egress';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, private' } });
}

/** A refusal from the provider carries a sentence for a person and a kind for the caller. */
function fromProvider(r: any) {
  if (r && r.ok === false) {
    const status = r.kind === 'not_configured' ? 503
      : r.kind === 'auth_expired' ? 401
      : r.kind === 'not_permitted' ? 403
      : r.kind === 'quota' ? 429
      : r.kind === 'bad_input' ? 400
      : 502;
    return json({ ok: false, error: r.reason, kind: r.kind }, status);
  }
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'Sign in required.' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request body.' }, 400); }

  const action = String(body.action || '');
  const courseId = String(body.courseId || '');
  if (!courseId) return json({ ok: false, error: 'A course is required.' }, 400);

  // Every action below is a teaching act on a specific course, including merely READING the state:
  // whether a class is live, and how many people are watching, is not a learner's business to poll.
  const claim = await teachClaim(user, courseId);
  if (!claim.canTeach) return json({ ok: false, error: 'You do not have teaching access to this course.' }, 403);

  const cred = platformCredentials();

  if (action === 'status') {
    return json({ ok: true, ...liveEgressStatus() });
  }

  if (action === 'ingest') {
    const r = await ensureIngest(cred, String(body.streamId || '') || null);
    const refused = fromProvider(r); if (refused) return refused;
    const ing = r as any;
    return json({
      ok: true,
      streamId: ing.streamId,
      serverUrl: ing.serverUrl,
      streamKey: ing.streamKey,
      ingestUrl: ing.ingestUrl,
      receiving: ing.receiving,
      health: ing.health,
      // Said here so the surface does not have to invent it, and so it is said the same way twice.
      warning: 'Anyone holding this key can broadcast onto the channel. Do not put it in a chat, a document, or a screenshot.',
    });
  }

  if (action === 'create') {
    const created = await createEvent(cred, String(body.title || ''), String(body.startIso || ''), String(body.description || ''));
    const refusedCreate = fromProvider(created); if (refusedCreate) return refusedCreate;
    const ev = created as any;

    // Bind immediately. An event with no stream stays in `created` forever and never goes live, and
    // an admin who scheduled a class has no way of knowing that from the outside.
    const ing = await ensureIngest(cred, String(body.streamId || '') || null);
    const refusedIngest = fromProvider(ing);
    if (refusedIngest) {
      // The event exists but is unusable. Say so rather than reporting a clean success.
      return json({ ok: false, error: 'The class was created but no encoder stream could be attached, so it cannot go live. ' + ((ing as any).reason || ''), eventId: ev.eventId, kind: (ing as any).kind }, 502);
    }
    const bound = await bind(cred, ev.eventId, (ing as any).streamId);
    const refusedBind = fromProvider(bound);
    if (refusedBind) return refusedBind;

    return json({
      ok: true,
      eventId: ev.eventId,
      title: ev.title,
      scheduledStartIso: ev.scheduledStartIso,
      lifecycle: (bound as any).lifecycle,
      streamId: (ing as any).streamId,
      privacy: ev.privacy,
      // The one sentence that must travel with an unlisted event, everywhere, forever.
      privacyNote: 'The class address is not public and not searchable, but it is not access control: anyone who has the address can watch. Enrolment is enforced on our own page, not by the streaming service.',
    });
  }

  if (action === 'state') {
    const r = await state(cred, String(body.eventId || ''));
    const refused = fromProvider(r); if (refused) return refused;
    const s = r as any;
    return json({
      ok: true, lifecycle: s.lifecycle, live: s.live,
      // Absent is NOT zero, and neither is an attendance record. The name says what it is.
      concurrentViewers: s.concurrentViewers,
      actualStartIso: s.actualStartIso, actualEndIso: s.actualEndIso,
    });
  }

  if (action === 'end') {
    const r = await end(cred, String(body.eventId || ''));
    const refused = fromProvider(r); if (refused) return refused;
    return json({ ok: true, lifecycle: (r as any).lifecycle });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
