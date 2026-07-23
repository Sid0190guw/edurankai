// src/lib/scene-compose.ts — LLM scene composition (Prompt A3b), PURE parts. A teacher describes a
// visual in words (typed, or from A2 speech); the Prompt-9 LLM gateway composes a SCENE SPEC, which
// is then validated + REPAIRED by scene-spec.normalizeScene() (a hallucinated/oversized spec can
// never crash a render). With NO AI key configured, a deterministic keyword fallback picks the
// closest authored example — so the feature still does something honest. The composed spec fires
// through the SAME trigger seam as A1/A2/A3a (fire-scene broadcast); no new render path.
import { OBJECT_TYPES, MOTION_TYPES, MAX_OBJECTS, normalizeScene, type SceneSpec } from '@/lib/scene-spec';
import { SCENE_EXAMPLE_IDS, exampleScene } from '@/lib/scene-examples';

export interface Composition { spec: SceneSpec; issues: string[]; source: 'llm' | 'example'; matched?: string }

/** The strict-JSON system prompt. This is the QUALITY BAR for generated scenes: the model must
 *  produce a real teaching visual (25-60 objects, labelled, physically correct), not a few spheres.
 *  The rules encode defects a reviewer actually caught in hand-authored scenes. */
export function composeSystemPrompt(): string {
  return [
    'You are a 3D data-visualisation engineer. You GENERATE a teaching scene as STRICT JSON for a WebGL engine used in university classes. No prose, JSON only.',
    '',
    'SCHEMA',
    '{"title":str,"subtitle":str,"palette":"studio"|"space","objects":[Object],"camera":{"autoRotate":bool,"distance":num,"target":[x,y,z]}}',
    'Object: {"id":str,"type":TYPE,"position":[x,y,z],"rotation":[x,y,z],"size":num|[x,y,z],"color":"#rrggbb","material":{"metalness":0..1,"roughness":0..1,"emissive":0..5,"opacity":0..1},"motion":{"type":MOTION,"speed":num,"axis":[x,y,z],"params":{}},"orbitCenter":[x,y,z],"points":[[x,y,z]],"text":str,"parent":str,"count":int}',
    'TYPE: ' + OBJECT_TYPES.join(', ') + '.',
    'MOTION: ' + MOTION_TYPES.join(', ') + '.',
    '',
    'QUALITY BAR (a sparse scene is a FAILURE)',
    '- Use 25-60 objects. A handful of plain spheres is not acceptable.',
    '- LABEL the key parts with type "label" + text. It must teach, not just look pretty.',
    '- Use materials meaningfully: emissive 1-3 GLOWS (stars, nuclei, energy); metal = metalness 0.8/roughness 0.2; rock/matte = metalness <=0.1/roughness 0.9.',
    '- Draw curves by COMPUTING the points mathematically and writing them out: "line" with a dense points array (helices, sine curves, field lines, trajectories).',
    '- "torus" rotated [1.5708,0,0] lies flat in the XZ plane - use it for orbit rings and discs.',
    '- "particles" with count scatters points (star fields, gas, electron clouds).',
    '',
    'CORRECTNESS RULES (these are real mistakes to avoid)',
    '- Every motion.type "orbit" MUST include orbitCenter, and the body position must actually sit at that orbital radius.',
    '- Inner orbits must be FASTER than outer ones (Kepler III: speed proportional to r^-1.5).',
    '- Nothing may intersect: a glow/corona radius must be smaller than the nearest orbit radius.',
    '- Labels are NAMES, not sentences (<= ~4 words). Put explanation in "subtitle". Long labels render as banners wider than the scene.',
    '- Do not give an object BOTH a parent and a world-space orbitCenter; pick one.',
    '- Particle spread must sit OUTSIDE the main geometry, or it renders as fog over the subject.',
    '- Set camera.distance so the outermost object fits (roughly 1.6x the largest coordinate).',
    '',
    'Physics types projectile|pendulum|spring auto-compute their own path: give motion.type "flow" and motion.params',
    '(projectile {angle,v0,gravity}; pendulum {length,gravity,amplitude}; spring {k,mass,amplitude}).',
    'Keep coordinates within -20..20 and at most ' + MAX_OBJECTS + ' objects. y is UP.',
    'Return ONLY the JSON object.',
  ].join('\n');
}

/** A follow-up instruction used when the first generation comes back sparse or flawed. */
export function enrichPrompt(spec: SceneSpec, issues: string[]): string {
  return [
    'Your scene is below. It is NOT good enough to put in front of a class.',
    issues.length ? 'Known problems: ' + issues.join('; ') : '',
    'Rewrite it: add the missing detail so it has 25-60 objects, label every key part, fix any',
    'intersecting geometry, make inner orbits faster than outer, and keep labels to a few words.',
    'Return ONLY the corrected full JSON object.',
    '',
    JSON.stringify(spec).slice(0, 12000),
  ].filter(Boolean).join('\n');
}

/** Is a generated scene rich enough to show? Used to trigger the enrich pass. */
export function sceneQuality(spec: SceneSpec | null): { ok: boolean; issues: string[]; objects: number; labels: number } {
  const issues: string[] = [];
  const objs = spec?.objects || [];
  const labels = objs.filter((o) => o.type === 'label').length;
  if (objs.length < 18) issues.push('only ' + objs.length + ' objects - far too sparse for a teaching visual');
  if (labels < 3) issues.push('only ' + labels + ' labels - the parts are not named');
  for (const o of objs) {
    if (o.motion?.type === 'orbit' && !Array.isArray(o.orbitCenter)) { issues.push('object "' + o.id + '" orbits with no orbitCenter'); break; }
  }
  const longLabel = objs.find((o) => o.type === 'label' && (o.text || '').length > 34);
  if (longLabel) issues.push('label "' + String(longLabel.text).slice(0, 40) + '..." is a sentence, not a name');
  return { ok: issues.length === 0, issues, objects: objs.length, labels };
}

/** Extract the first JSON object from an LLM completion and validate+repair it into a SceneSpec. */
export function parseSceneJson(text: string): { spec: SceneSpec; issues: string[] } | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
  let raw: any; try { raw = JSON.parse(m[0]); } catch { return null; }
  return normalizeScene(raw);
}

// keyword -> nearest prepared scene. This is ONLY a fallback for when AI generation is unavailable;
// it is never presented as if the system generated something. Ids must match scene-examples.
const EXAMPLE_KEYWORDS: Record<string, string[]> = {
  'solar-system': ['solar', 'planet', 'orbit', 'sun', 'planetary', 'kepler'],
  'atom': ['atom', 'electron', 'nucleus', 'shell', 'bohr', 'isotope'],
  'water-molecule': ['molecule', 'water', 'h2o', 'bond', 'covalent', 'compound'],
  'dna': ['dna', 'helix', 'gene', 'genetic', 'nucleotide', 'chromosome'],
  'projectile': ['projectile', 'throw', 'launch', 'cannon', 'trajectory', 'parabola'],
  'pendulum': ['pendulum', 'swing', 'bob', 'oscillator'],
  'wave': ['sine', 'wave', 'sinusoid', 'oscillation', 'cosine', 'frequency', 'amplitude'],
  'magnetic-field': ['magnet', 'magnetic', 'field line', 'dipole', 'north pole', 'flux'],
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
