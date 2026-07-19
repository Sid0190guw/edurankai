// POST /api/aquintutor/board/compose — describe a scene -> LLM composes a SCENE SPEC (Prompt A3b).
// Faculty-only, rate-limited. Reuses the Prompt-9 LLM gateway (keys env/DB, never hardcoded); the
// composed JSON is validated + repaired by normalizeScene() (a hallucinated spec can't crash a
// render); with no AI key a keyword fallback returns the closest authored example. Optionally fires
// the result over the SAME A1b channel (spec in params.scene, not pixels). Every compose is logged.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { getConfig, isReady, chat, logUsage, underRateLimit } from '@/lib/llm/gateway';
import { composeSystemPrompt, composeFrom } from '@/lib/scene-compose';
import { sceneService } from '@/lib/scene-spec';
import { fireBoardEvent, logDetection } from '@/lib/board-session';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'write', { type: 'AnimationObject' });
  if (!gate.allow) return j({ ok: false, error: 'faculty only' }, 403);
  if (!(await underRateLimit(String(user.id), 20, 60).catch(() => true))) return j({ ok: false, error: 'slow down' }, 429);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const text = String(b.text || '').slice(0, 600).trim();
  const session = String(b.session || '').trim();
  if (!text) return j({ ok: false, error: 'describe the scene' }, 400);

  let llmText: string | null = null, usedLlm = false;
  try {
    const cfg = await getConfig();
    if (isReady(cfg)) {
      const t0 = Date.now();
      const res = await chat(composeSystemPrompt(), [{ role: 'user', content: text }], cfg);
      if (res.ok) { llmText = res.text; usedLlm = true; await logUsage(String(user.id), 'scene-compose', cfg, text.length, res.text.length, Date.now() - t0, 'ok', res.promptTokens, res.completionTokens).catch(() => {}); }
    }
  } catch { /* fall back */ }

  const comp = composeFrom(llmText, text);
  if (!comp) return j({ ok: true, spec: null, source: usedLlm ? 'llm' : 'none', error: 'could not compose a scene from that description' });

  let sceneId: string | undefined, seq = 0;
  if (b.save || b.autoFire) sceneId = await sceneService().saveScene(comp.spec, b.koId ? String(b.koId) : null, String(user.id)).catch(() => undefined);
  if (b.autoFire && session) seq = await fireBoardEvent(session, { templateId: 'scene', params: { scene: comp.spec }, playState: 'playing', timelinePos: 0 }, String(user.id)).catch(() => 0);
  if (session) await logDetection(session, String(user.id), { transcript: text, templateId: 'scene:' + (comp.matched || comp.source), params: { objects: comp.spec.objects.length }, confidence: comp.source === 'llm' ? 0.85 : 0.5, source: 'compose', fired: !!seq }).catch(() => {});

  return j({ ok: true, spec: comp.spec, issues: comp.issues, source: comp.source, matched: comp.matched, sceneId, seq });
};
