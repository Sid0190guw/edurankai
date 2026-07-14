// POST /api/aquintutor/generate-animation — the REAL animation generator. You give a
// prompt; the model WRITES a 2D canvas animation for it (the body of a frame(ctx,t,w,h)
// function), which the client runs in a sandbox on the board. This is prompt -> generated
// animation, not a fixed scene library. If no model is switched on, it returns fallback:true
// and the client uses the built-in parametric scenes instead (honest, never a dead end).
import type { APIRoute } from 'astro';
import { getConfig, isReady, chat } from '@/lib/llm/gateway';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const SYSTEM = `You generate teaching animations. Given a concept, output the BODY of a JavaScript function frame(ctx, t, w, h) that draws ONE frame of a clear, beautiful 2D animation illustrating that concept at time t (seconds) on a canvas 2D context.
HARD RULES — follow exactly:
- Output ONLY JavaScript statements (the function body). No markdown, no backticks, no "function frame", no explanation. Just the code that goes inside the function.
- Use ONLY: the ctx canvas-2D API, the numbers t, w, h, Math, and local variables you declare. The canvas is already cleared before each call.
- FORBIDDEN (never write these): window, document, fetch, XMLHttpRequest, WebSocket, import, importScripts, eval, Function, localStorage, indexedDB, requestAnimationFrame, setTimeout, cookie, or any URL/network/DOM access. Pure math + ctx drawing only.
- Animate smoothly using t (e.g. Math.sin(t*2), (t*0.3)%1). Loop cleanly. Keep it light — at most a few hundred draw ops per frame.
- Dark background theme: use light/bright strokes and fills on the dark canvas. Label the key parts with ctx.fillText so it teaches, not just decorates.
- Scale everything to w and h so it fits any size.`;

function clean(code: string): string {
  let c = code.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
  // if the model wrapped it in a function despite instructions, unwrap the body
  const m = c.match(/function\s+\w*\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
  if (m) c = m[1];
  return c.trim();
}
// defence-in-depth (the client also runs it in a sandboxed, network-less iframe)
const BANNED = /\b(fetch|XMLHttpRequest|importScripts|eval|Function|WebSocket|localStorage|indexedDB|document|window|globalThis|require|process|cookie)\b|import\s|<\/script/i;

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const prompt = String(b.prompt || '').slice(0, 300).trim();
  if (!prompt) return json({ ok: false, error: 'prompt required' }, 400);

  let cfg = await getConfig();
  if (!isReady(cfg)) {
    // mirror the assistant: use the key if one is present even when not "enabled" in the DB
    if (cfg.claudeApiKey) cfg = { ...cfg, enabled: true, provider: 'claude' };
    else return json({ ok: false, fallback: true, reason: 'The AI model is not switched on yet — using the built-in scene library. Turn it on in Admin -> AI settings for prompt-to-animation on any topic.' });
  }
  cfg = { ...cfg, maxTokens: Math.max(cfg.maxTokens || 512, 1600), temperature: 0.55 };

  const res = await chat(SYSTEM, [{ role: 'user', content: 'Generate the animation for this concept: ' + prompt }], cfg);
  if (!res.ok) return json({ ok: false, fallback: true, reason: res.error || 'the model could not generate this — using the built-in library.' });

  const code = clean(res.text);
  if (!code || code.length < 20) return json({ ok: false, fallback: true, reason: 'the model returned nothing usable — using the built-in library.' });
  if (BANNED.test(code)) return json({ ok: false, fallback: true, reason: 'the generated code did not pass the safety check — using the built-in library.' });

  return json({ ok: true, code, title: prompt });
};
