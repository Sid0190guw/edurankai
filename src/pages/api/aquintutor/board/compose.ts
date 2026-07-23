// POST /api/aquintutor/board/compose — describe a scene -> LLM composes a SCENE SPEC (Prompt A3b).
// Faculty-only, rate-limited. Reuses the Prompt-9 LLM gateway (keys env/DB, never hardcoded); the
// composed JSON is validated + repaired by normalizeScene() (a hallucinated spec can't crash a
// render); with no AI key a keyword fallback returns the closest authored example. Optionally fires
// the result over the SAME A1b channel (spec in params.scene, not pixels). Every compose is logged.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { getConfig, isReady, chat, logUsage, underRateLimit } from '@/lib/llm/gateway';
import { composeSystemPrompt, composeFrom, enrichPrompt, sceneQuality, parseSceneJson } from '@/lib/scene-compose';
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

  let llmText: string | null = null, usedLlm = false, enriched = false, quality: any = null;
  try {
    const cfg = await getConfig();
    if (isReady(cfg)) {
      const t0 = Date.now();
      const res = await chat(composeSystemPrompt(), [{ role: 'user', content: text }], cfg);
      if (res.ok) { llmText = res.text; usedLlm = true; await logUsage(String(user.id), 'scene-compose', cfg, text.length, res.text.length, Date.now() - t0, 'ok', res.promptTokens, res.completionTokens).catch(() => {}); }

      // SECOND PASS: if the generated scene is sparse or flawed, send it back to be enriched.
      // This is what turns "a few spheres" into an actual teaching visual.
      const first = parseSceneJson(llmText || '');
      quality = sceneQuality(first?.spec || null);
      if (first && !quality.ok) {
        const t1 = Date.now();
        const res2 = await chat(composeSystemPrompt(), [{ role: 'user', content: enrichPrompt(first.spec, quality.issues) }], cfg);
        if (res2.ok) {
          const second = parseSceneJson(res2.text);
          const q2 = sceneQuality(second?.spec || null);
          // keep whichever pass produced the richer scene
          if (second && q2.objects > quality.objects) { llmText = res2.text; enriched = true; quality = q2; }
          await logUsage(String(user.id), 'scene-compose-enrich', cfg, 0, res2.text.length, Date.now() - t1, 'ok', res2.promptTokens, res2.completionTokens).catch(() => {});
        }
      }
    }
  } catch { /* fall back */ }

  const comp = composeFrom(llmText, text);
  if (!comp) return j({ ok: true, spec: null, source: usedLlm ? 'llm' : 'none', aiEnabled: usedLlm, error: usedLlm ? 'The generator could not build a scene from that description. Try naming the subject and what should move.' : 'AI scene generation is not configured on this server (no model key), and no prepared scene matches that description.' });

  let sceneId: string | undefined, seq = 0;
  if (b.save || b.autoFire) sceneId = await sceneService().saveScene(comp.spec, b.koId ? String(b.koId) : null, String(user.id)).catch(() => undefined);
  if (b.autoFire && session) seq = await fireBoardEvent(session, { templateId: 'scene', params: { scene: comp.spec }, playState: 'playing', timelinePos: 0 }, String(user.id)).catch(() => 0);
  if (session) await logDetection(session, String(user.id), { transcript: text, templateId: 'scene:' + (comp.matched || comp.source), params: { objects: comp.spec.objects.length }, confidence: comp.source === 'llm' ? 0.85 : 0.5, source: 'compose', fired: !!seq }).catch(() => {});

  // Be explicit about WHAT produced this: a live generation, or a prepared scene shown because
  // AI generation is unavailable. Never let a keyword lookup look like generation.
  const generated = comp.source === 'llm';
  return j({
    ok: true, spec: comp.spec, issues: comp.issues, source: comp.source, matched: comp.matched, sceneId, seq,
    aiEnabled: usedLlm, generated, enriched,
    objects: comp.spec.objects.length,
    labels: comp.spec.objects.filter((o) => o.type === 'label').length,
    note: generated
      ? ('Generated live' + (enriched ? ' (refined on a second pass)' : '') + ' - ' + comp.spec.objects.length + ' objects.')
      : (usedLlm
        ? 'The generator did not return a usable scene, so the closest prepared scene is shown.'
        : 'AI generation is off on this server - showing the closest prepared scene, not a generated one.'),
  });
};
