// POST /api/aquintutor/board/interpret — speech -> board suggestion (Prompt A2a). Faculty-only
// (the driver). Reuses the Prompt-9 LLM gateway (keys from env/DB, NEVER hardcoded); if the model
// isn't configured or returns junk, a deterministic keyword extractor still works. Every detection
// is logged (fired=false). This route DECIDES nothing — it returns a suggestion; the board (A2b)
// confirms or auto-fires. body: { text, session }.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { getConfig, isReady, chat, logUsage, underRateLimit } from '@/lib/llm/gateway';
import { buildSuggestion, validateLlmSuggestion, parseLlmJson, llmSystemPrompt, type Suggestion } from '@/lib/board-speech';
import { logDetection } from '@/lib/board-session';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'write', { type: 'AnimationObject' });
  if (!gate.allow) return j({ ok: false, error: 'faculty only' }, 403);
  if (!(await underRateLimit(String(user.id), 40, 60).catch(() => true))) return j({ ok: false, error: 'slow down' }, 429);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const text = String(b.text || '').slice(0, 500).trim();
  const session = String(b.session || '').trim();
  if (!text) return j({ ok: false, error: 'no speech' }, 400);

  let suggestion: Suggestion | null = null;
  let usedLlm = false;
  try {
    const cfg = await getConfig();
    if (isReady(cfg)) {
      const t0 = Date.now();
      const res = await chat(llmSystemPrompt(), [{ role: 'user', content: text }], cfg);
      if (res.ok) {
        usedLlm = true;
        suggestion = validateLlmSuggestion(parseLlmJson(res.text), text);
        await logUsage(String(user.id), 'board-speech', cfg, text.length, res.text.length, Date.now() - t0, 'ok', res.promptTokens, res.completionTokens).catch(() => {});
      }
    }
  } catch { /* fall through to rule-based */ }
  if (!suggestion) suggestion = buildSuggestion(text);   // deterministic fallback (no AI needed)

  let detectionId = 0;
  if (session) detectionId = await logDetection(session, String(user.id), {
    transcript: text,
    templateId: suggestion ? suggestion.templateId : null,
    params: suggestion ? suggestion.params : {},
    confidence: suggestion ? suggestion.confidence : 0,
    source: suggestion ? suggestion.source : (usedLlm ? 'llm' : 'rule'),
    fired: false,
  }).catch(() => 0);

  return j({ ok: true, suggestion, detectionId, llm: usedLlm });
};
