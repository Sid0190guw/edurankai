// GET /api/aquintutor/board/stream?session=SID — live student feed (Prompt A1b). Any signed-in
// learner (read AnimationObject) may join. On connect we resolve the learner's render tier with the
// REAL Prompt-5 engine (device + network + reduce-motion) and record them as a participant, then
// stream fired specs (never frames). Short-lived by design: the loop closes at ~45s and the browser's
// EventSource reconnects automatically, resuming from Last-Event-ID (serverless-correct, no infinite fn).
//
// TWO THINGS THIS LOOP USED TO GET WRONG.
//
// 1. IT WROTE AS OFTEN AS IT READ. Every 1.5s tick ran `eventsSince` AND `touchParticipant`, so one
//    45s stream was 60 statements per student and a class of thirty was roughly 2700 a minute — half
//    of them for a roster dot. participantView calls a student offline after 30s without a
//    heartbeat, so touching every 15s keeps every present student green at half the traffic.
//
// 2. A STALLED READ LOOKED EXACTLY LIKE A QUIET TEACHER. `eventsSince(...).catch(() => [])` turned
//    "the database did not answer" into "no new animations", and the `: hb` heartbeat kept the
//    EventSource green while the board sat frozen on the last spec the teacher fired. A student
//    watching a lesson had no way to tell that the screen had stopped being current. Now the
//    heartbeat is only sent after a read that actually answered, a `stalled` event states the
//    failure on the wire, and a run of failed reads ends the stream so the browser's own reconnect
//    shows the student a reconnect instead of a lie.
//
// THE TICK IS NOT SLOWED AND THE STREAM IS NOT SHORTENED. 1.5s is teacher-fire-to-student-render
// latency on the flagship live teaching surface, and every reconnect re-pays the RBAC check and the
// join — more reconnects mean more fresh instances paying the ~810ms connection handshake this whole
// audit is about. Ending early is a response to a stall, never a routine.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { signalsFromHeaders, type DeviceSignals } from '@/lib/edu-runtime';
import { resolveBroadcastTier, joinSession, touchParticipant, eventsSince, currentEvent, type BoardEvent } from '@/lib/board-session';
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

export const prerender = false;

const TICK_MS = 1500;          // teacher-fire to student-render latency. Deliberately unchanged.
const STREAM_MS = 45000;       // one invocation's lifetime; the browser reconnects after it.
const READ_MS = 3000;          // a poll bounds its wait and never retries — the next tick IS the retry.
const TOUCH_EVERY_MS = 15000;  // participantView (board-session.ts) calls a student offline at 30s.
const STALL_LIMIT = 3;         // consecutive failed reads before we stop pretending the feed is live.
const RECONNECT_MS = 8000;     // spacing for the reconnect after a stall, so a class does not stampede.

export const GET: APIRoute = async ({ request, url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return new Response('sign in required', { status: 401 });
  const gate = await can(user, 'read', { type: 'AnimationObject' });
  if (!gate.allow) return new Response('forbidden', { status: 403 });
  const sessionId = (url.searchParams.get('session') || '').trim();
  if (!sessionId) return new Response('missing session', { status: 400 });

  // signals: request headers (client hints) refined by explicit query params the page can measure
  const q = url.searchParams;
  const sig: DeviceSignals = { ...signalsFromHeaders(request.headers) };
  if (q.get('dm')) sig.deviceMemory = parseFloat(q.get('dm')!);
  if (q.get('ect')) sig.effectiveType = q.get('ect')!;
  if (q.get('sd')) sig.saveData = q.get('sd') === '1';
  if (q.get('vw')) sig.viewportWidth = parseFloat(q.get('vw')!);
  const { tier, animate, directive } = resolveBroadcastTier(sig, q.get('prm') === '1');

  // Bounded, and the outcome is carried into the ready payload rather than swallowed: when this
  // write does not land, the teacher's roster shows somebody sitting in the class as absent.
  let roster: 'joined' | 'unconfirmed' = 'joined';
  try {
    await withDbTimeout(joinSession(sessionId, String(user.id), tier), 'board.stream.join', READ_MS);
  } catch (e: any) {
    roster = 'unconfirmed';
    console.error('[board/stream] join not recorded -', e?.cause?.message || e?.message);
  }

  const enc = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* client gone */ } };

      // A read that did not answer is NOT "no new animations", so say so on the wire — and say which
      // of the two it was, because "the database did not answer" and "that query failed" are for
      // different people. `retry` sets the browser's reconnect delay so thirty students in one class
      // do not reconnect in lockstep into a database that is already struggling.
      const sendStalled = (e: any, ending: boolean) => {
        send(`retry: ${RECONNECT_MS}\nevent: stalled\ndata: ${JSON.stringify({
          reason: isDbUnavailable(e) ? 'no-answer' : 'read-failed',
          ending,
          message: 'The live board feed could not be read just now, so this screen has stopped being current. '
            + 'Nothing has been cancelled and the class is still running'
            + (ending ? ' — this connection is closing and your browser will try again in a few seconds.' : '.'),
        })}\n\n`);
      };

      send(`event: ready\ndata: ${JSON.stringify({ tier, animate, physics: directive.physics, roster })}\n\n`);

      // resume from Last-Event-ID (auto reconnect) or show the current board to a fresh joiner.
      // A non-numeric Last-Event-ID used to become NaN and go straight into `seq > $3`, which throws
      // on every tick — and the old `.catch(() => [])` turned that into a board frozen for the whole
      // lesson while the heartbeat said it was live. Anything unparseable now means "from the start".
      const resumeFrom = Number(request.headers.get('last-event-id') || q.get('since') || 0);
      let lastSeq = Number.isFinite(resumeFrom) && resumeFrom > 0 ? resumeFrom : 0;
      if (!lastSeq) {
        try {
          const cur = await withDbTimeout(currentEvent(sessionId), 'board.stream.current', READ_MS);
          if (cur) { send(`id: ${cur.seq}\nevent: fire\ndata: ${JSON.stringify(cur)}\n\n`); lastSeq = cur.seq; }
        } catch (e: any) {
          // An empty board here is not "the teacher has not fired anything yet" — it is a board we
          // could not read, and a student left to guess assumes the lesson has not started.
          console.error('[board/stream] current board read failed -', e?.cause?.message || e?.message);
          sendStalled(e, false);
        }
      }

      const started = Date.now();
      // joinSession has just written last_seen — unless it told us it did not, in which case the
      // first tick touches immediately rather than leaving the student off the roster for 15s.
      let lastTouch = roster === 'joined' ? Date.now() : 0;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted && Date.now() - started < STREAM_MS) {
          let evs: BoardEvent[] | null = null;
          try {
            evs = await withDbTimeout(eventsSince(sessionId, lastSeq), 'board.stream.events', READ_MS);
          } catch (e: any) {
            consecutiveFailures += 1;
            console.error('[board/stream] feed read failed -', e?.cause?.message || e?.message);
            if (consecutiveFailures === 1) sendStalled(e, false);
            if (consecutiveFailures >= STALL_LIMIT) { sendStalled(e, true); break; }
          }
          if (evs) {
            if (consecutiveFailures > 0) {
              consecutiveFailures = 0;
              send(`event: live\ndata: ${JSON.stringify({ message: 'The board feed is being read again. This screen is current.' })}\n\n`);
            }
            for (const ev of evs) { send(`id: ${ev.seq}\nevent: fire\ndata: ${JSON.stringify(ev)}\n\n`); lastSeq = ev.seq; }
            // The heartbeat is the client's only evidence that this screen is still current, so it
            // is sent ONLY after a read that answered. Sending it on a tick whose read failed is
            // what made a frozen board look live.
            send(`: hb\n\n`);
          }
          if (Date.now() - lastTouch > TOUCH_EVERY_MS) {
            lastTouch = Date.now();
            try {
              await withDbTimeout(touchParticipant(sessionId, String(user.id)), 'board.stream.touch', READ_MS);
            } catch (e: any) {
              // Not fatal to the lesson, but it is why a student who is present goes grey on the
              // teacher's roster — so it is logged instead of vanishing into .catch(() => {}).
              console.error('[board/stream] participant heartbeat not written -', e?.cause?.message || e?.message);
            }
          }
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      } catch { /* stream ends */ }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { /* client disconnected */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
