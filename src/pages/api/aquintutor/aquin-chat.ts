// POST /api/aquintutor/aquin-chat — streaming Socratic tutor for AquinTutor,
// backed by the unified own-LLM gateway (own self-hosted model OR Claude,
// switchable by the super-admin). Gated: signed-in + LLM enabled + per-user rate
// limit. Streams tokens as SSE; logs usage and a training example so every
// exchange feeds AquinTutor's own model.
import type { APIRoute } from 'astro';
import { getConfig, isReady, chatStream, logUsage, logTrainingExample, underRateLimit } from '@/lib/llm/gateway';
import { systemPrompt, sanitizeMessages, type TutorMode } from '@/lib/llm/guardrails';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function sse(o: any): string { return 'data: ' + JSON.stringify(o) + '\n\n'; }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ error: 'Sign in first' }, 401);

  const cfg = await getConfig();
  if (!isReady(cfg)) return j({ error: 'The tutor is not switched on yet.' }, 503);
  if (!(await underRateLimit(user.id, 30, 60))) return j({ error: 'Slow down a moment and try again.' }, 429);

  let b: any = {};
  try { b = await request.json(); } catch { return j({ error: 'bad json' }, 400); }
  const mode: TutorMode = b.mode === 'explainer' ? 'explainer' : 'socratic-tutor';
  const messages = sanitizeMessages(b.messages);
  if (!messages.length) return j({ error: 'Say something to start.' }, 400);

  const sys = systemPrompt(mode, cfg);
  const promptChars = sys.length + messages.reduce((n, m) => n + m.content.length, 0);
  const t0 = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: any) => { try { controller.enqueue(enc.encode(sse(o))); } catch (_) {} };
      const res = await chatStream(sys, messages, cfg, (tok) => send({ t: tok }), request.signal);
      if (!res.ok) {
        send({ error: res.error || 'The tutor could not respond.' });
        await logUsage(user.id, 'tutor-' + mode, cfg, promptChars, 0, Date.now() - t0, 'error');
      } else {
        send({ done: true });
        await logUsage(user.id, 'tutor-' + mode, cfg, promptChars, res.text.length, Date.now() - t0, 'ok', res.promptTokens, res.completionTokens);
        await logTrainingExample(user.id, 'tutor-' + mode, cfg, sys, messages, res.text);
      }
      try { controller.close(); } catch (_) {}
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
};
