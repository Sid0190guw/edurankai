// GET /api/aquintutor/board/stream?session=SID — live student feed (Prompt A1b). Any signed-in
// learner (read AnimationObject) may join. On connect we resolve the learner's render tier with the
// REAL Prompt-5 engine (device + network + reduce-motion) and record them as a participant, then
// stream fired specs (never frames). Short-lived by design: the loop closes at ~45s and the browser's
// EventSource reconnects automatically, resuming from Last-Event-ID (serverless-correct, no infinite fn).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { signalsFromHeaders, type DeviceSignals } from '@/lib/edu-runtime';
import { resolveBroadcastTier, joinSession, touchParticipant, eventsSince, currentEvent } from '@/lib/board-session';

export const prerender = false;

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
  await joinSession(sessionId, String(user.id), tier).catch(() => {});

  const enc = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* client gone */ } };
      send(`event: ready\ndata: ${JSON.stringify({ tier, animate, physics: directive.physics })}\n\n`);

      // resume from Last-Event-ID (auto reconnect) or show the current board to a fresh joiner
      let lastSeq = Number(request.headers.get('last-event-id') || q.get('since') || 0);
      if (!lastSeq) { const cur = await currentEvent(sessionId).catch(() => null); if (cur) { send(`id: ${cur.seq}\nevent: fire\ndata: ${JSON.stringify(cur)}\n\n`); lastSeq = cur.seq; } }

      const started = Date.now();
      try {
        while (!signal.aborted && Date.now() - started < 45000) {
          const evs = await eventsSince(sessionId, lastSeq).catch(() => []);
          for (const ev of evs) { send(`id: ${ev.seq}\nevent: fire\ndata: ${JSON.stringify(ev)}\n\n`); lastSeq = ev.seq; }
          send(`: hb\n\n`);                                   // heartbeat keeps the pipe warm
          await touchParticipant(sessionId, String(user.id)).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
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
