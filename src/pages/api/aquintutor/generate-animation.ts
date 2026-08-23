// POST /api/aquintutor/generate-animation — the REAL animation generator. You give a
// prompt; the model WRITES a 2D canvas animation for it (the body of a frame(ctx,t,w,h)
// function), which the client runs in a sandbox on the board. This is prompt -> generated
// animation, not a fixed scene library. If no model is switched on, it returns fallback:true
// and the client uses the built-in parametric scenes instead (honest, never a dead end).
import type { APIRoute } from 'astro';
import { getConfig, isReady, chat, underRateLimit } from '@/lib/llm/gateway';
import { can } from '@/lib/rbac';

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

// EXAMINED AND NOT CONVERTED — BUT THIS ROUTE HAS NO AUTHORIZATION AT ALL, AND THAT IS A FINDING,
// NOT A DESIGN. `locals` is never destructured here, so anyone who knows the path can spend the
// platform's metered LLM budget with a prompt of their choosing. src/middleware.ts isExempt()
// returns true for everything under /api/, so nothing else stands in front of this URL.
//
// It is the odd one out in its own feature: every sibling board endpoint —
// aquintutor/board.ts:16, board/compose.ts:18, board/interpret.ts:17, board/assess.ts:12 — requires
// can(user, 'write', { type: 'AnimationObject' }) through the kernel RBAC layer.
//
// NOT FIXED HERE because adding any gate changes who may call it, from "anyone" to "a signed-in
// account holding a capability", and this sprint changes HOW authorization is asked and never WHO
// may do what. It is the sharpest item in the accompanying report: matching the four siblings is a
// one-line change, and it needs a human to accept that anonymous callers lose access.
export const POST: APIRoute = async ({ request, locals }) => {
  // The header above records that this route had NO authorization at all and calls that a finding
  // rather than a design. This is that finding closed, with the same gate board/compose.ts:17 uses
  // for the same capability — composing an AnimationObject is a faculty action, and an anonymous
  // caller could otherwise spend the platform's metered budget on a prompt of their choosing.
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'write', { type: 'AnimationObject' });
  if (!gate.allow) return json({ ok: false, error: 'faculty only' }, 403);
  if (!(await underRateLimit(String(user.id), 20, 60))) return json({ ok: false, error: 'slow down' }, 429);

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
