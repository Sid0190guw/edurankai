// src/lib/scene-compose.ts — LLM scene composition (Prompt A3b), PURE parts. A teacher describes a
// visual in words (typed, or from A2 speech); the Prompt-9 LLM gateway composes a SCENE SPEC, which
// is then validated + REPAIRED by scene-spec.normalizeScene() (a hallucinated/oversized spec can
// never crash a render). With NO AI key configured, a deterministic keyword fallback picks the
// closest authored example — so the feature still does something honest. The composed spec fires
// through the SAME trigger seam as A1/A2/A3a (fire-scene broadcast); no new render path.
import { OBJECT_TYPES, MOTION_TYPES, MAX_OBJECTS, normalizeScene, type SceneSpec } from '@/lib/scene-spec';
import { SCENE_EXAMPLE_IDS, exampleScene } from '@/lib/scene-examples';

export interface Composition { spec: SceneSpec; issues: string[]; source: 'llm' | 'example'; matched?: string }

/** The strict-JSON system prompt: the real schema + registries the model must compose within. */
export function composeSystemPrompt(): string {
  return [
    'You compose a 3D teaching scene as STRICT JSON for a WebGL engine. No prose, JSON only.',
    'Schema: {"title":str,"subtitle":str,"palette":"studio|space","objects":[Object],"camera":{"autoRotate":bool,"distance":num,"target":[x,y,z]}}',
    'Object: {"id":str,"type":TYPE,"position":[x,y,z],"size":num,"color":"#rrggbb","material":{"metalness":0..1,"roughness":0..1,"emissive":0..5,"opacity":0..1},"motion":{"type":MOTION,"speed":num,"axis":[x,y,z],"params":{}},"orbitCenter":[x,y,z],"points":[[x,y,z]],"text":str,"parent":str,"count":int}',
    'TYPE is one of: ' + OBJECT_TYPES.join(', ') + '.',
    'MOTION is one of: ' + MOTION_TYPES.join(', ') + '.',
    'Physics types (projectile/pendulum/spring) read motion.params (e.g. projectile: angle,v0,gravity) and auto-compute their path — use motion.type "flow".',
    'Keep it to at most ' + Math.min(40, MAX_OBJECTS) + ' objects. Use y-up. Prefer a clear, labelled, physically-plausible layout.',
    'Return ONLY the JSON object.',
  ].join('\n');
}

/** Extract the first JSON object from an LLM completion and validate+repair it into a SceneSpec. */
export function parseSceneJson(text: string): { spec: SceneSpec; issues: string[] } | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
  let raw: any; try { raw = JSON.parse(m[0]); } catch { return null; }
  return normalizeScene(raw);
}

// keyword -> nearest authored example (deterministic fallback when no LLM is configured)
const EXAMPLE_KEYWORDS: Record<string, string[]> = {
  'solar-system': ['solar', 'planet', 'orbit', 'sun', 'planetary'],
  'atom': ['atom', 'electron', 'nucleus', 'molecule', 'shell'],
  'projectile': ['projectile', 'throw', 'launch', 'cannon', 'trajectory', 'parabola'],
  'sine-wave': ['sine', 'wave', 'sinusoid', 'oscillation', 'cosine'],
  'pendulum': ['pendulum', 'swing', 'bob'],
};

/** Deterministic composition: match the description to the closest authored example. null if none. */
export function fallbackCompose(text: string): Composition | null {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  let best: { id: string; score: number } | null = null;
  for (const id of SCENE_EXAMPLE_IDS) {
    const kws = EXAMPLE_KEYWORDS[id] || [];
    let score = 0; for (const k of kws) if (t.includes(k)) score++;
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }
  if (!best) return null;
  const spec = exampleScene(best.id); if (!spec) return null;
  return { spec, issues: [], source: 'example', matched: best.id };
}

/** Compose from an LLM completion if usable, else fall back to an example. null if neither works. */
export function composeFrom(llmText: string | null, description: string): Composition | null {
  if (llmText) { const parsed = parseSceneJson(llmText); if (parsed && parsed.spec.objects.length > 0) return { spec: parsed.spec, issues: parsed.issues, source: 'llm' }; }
  return fallbackCompose(description);
}
