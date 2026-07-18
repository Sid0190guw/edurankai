// POST /api/aquintutor/assistant — the in-house AquinTutor assistant. Streams
// from the own-LLM gateway (own self-hosted model OR Claude, per super-admin);
// if the gateway isn't switched on yet it falls back to the configured/ën-v
// Claude key so the widget works today. Knows the AquinTutor platform, coaches
// Socratically (never hands over graded answers), and every exchange is captured
// as training data for AquinTutor's own model. Public (no sign-in required).
import type { APIRoute } from 'astro';
import { getConfig, isReady, chatStream, logUsage, logTrainingExample } from '@/lib/llm/gateway';
import { sanitizeMessages } from '@/lib/llm/guardrails';
import { aquinReply } from '@/lib/aquin-brain';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function sse(o: any): string { return 'data: ' + JSON.stringify(o) + '\n\n'; }

const SYSTEM = `You are Aquin, the in-house assistant for AquinTutor — the technology platform behind partner universities. The partner university awards any qualification; AquinTutor provides the learning platform and does not award anything itself. Never describe AquinTutor as a university, an institution, or a degree-awarding body. It supports one learner across their whole education, from the earliest years through advanced research and into working life. There are eight learner stages: Tots, Primary, Sub-Juniors, Juniors, Scholars, Tutor, Research and Atelier.
Signature tools you can point people to: the Homework Helper (coaches without ever revealing the final answer), the Knowledge Map, Backlog Recovery, Recall (spaced repetition), the Research desk, the Credential path, and the Virtual Labs — including postgraduate flagships such as transformer self-attention, RSA and secp256k1 cryptanalysis, a pipelined RISC CPU, a variational quantum eigensolver, a z-plane filter designer and a PID control lab.
Your job: help visitors understand how AquinTutor works and find the right tool, and coach learners who are stuck. When someone asks for help on a problem they are meant to solve, guide Socratically — give the method and one hint at a time, never the final answer to graded work. That is the whole point of verified learning: a skill is proven, not merely watched.
Rules: never name any external education, cloud or AI company. Do not use emoji. Be warm and concise — two to four sentences unless asked for depth. If a question needs account details you cannot see, say so and point to the relevant page (for example /aquintutor/mastery for progress, or /aquintutor/onboarding to set up a path).`;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user || null;
  const cfg = await getConfig();
  let use = cfg;
  let deterministic = false;
  if (!isReady(cfg)) {
    if (cfg.claudeApiKey) use = { ...cfg, enabled: true, provider: 'claude', maxTokens: Math.max(cfg.maxTokens, 700) };
    // No LLM configured: instead of "coming online", answer with the deterministic
    // engine brain (real platform Q&A + Socratic coaching). The assistant WORKS today.
    else deterministic = true;
  }

  let b: any = {};
  try { b = await request.json(); } catch { return j({ error: 'bad json' }, 400); }
  const messages = sanitizeMessages(b.messages);
  if (!messages.length) return j({ error: 'Say something to start.' }, 400);
  const sys = SYSTEM + (cfg.systemPreamble ? '\n' + cfg.systemPreamble.slice(0, 2000) : '');
  const promptChars = sys.length + messages.reduce((n, m) => n + m.content.length, 0);
  const t0 = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: any) => { try { controller.enqueue(enc.encode(sse(o))); } catch (_) {} };

      // Deterministic engine brain (no LLM): stream a real answer word by word.
      if (deterministic) {
        const reply = aquinReply(messages);
        const words = reply.text.split(' ');
        for (let i = 0; i < words.length; i++) { send({ t: (i ? ' ' : '') + words[i] }); await new Promise((r) => setTimeout(r, 12)); }
        send({ done: true });
        await logUsage(user?.id || null, 'assistant-brain', cfg, promptChars, reply.text.length, Date.now() - t0, 'ok-deterministic');
        try { controller.close(); } catch (_) {}
        return;
      }

      const res = await chatStream(sys, messages, use, (tok) => send({ t: tok }), request.signal);
      if (!res.ok) {
        send({ error: res.error || "Aquin couldn't respond just now." });
        await logUsage(user?.id || null, 'assistant', use, promptChars, 0, Date.now() - t0, 'error');
      } else {
        send({ done: true });
        await logUsage(user?.id || null, 'assistant', use, promptChars, res.text.length, Date.now() - t0, 'ok', res.promptTokens, res.completionTokens);
        await logTrainingExample(user?.id || null, 'assistant', cfg, sys, messages, res.text);
      }
      try { controller.close(); } catch (_) {}
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
};
