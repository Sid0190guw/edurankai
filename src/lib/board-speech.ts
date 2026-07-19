// src/lib/board-speech.ts — speech -> board trigger (Prompt A2a), PURE extraction. Turns a spoken
// phrase into a constrained suggestion { templateId, params, confidence }. Two paths, both pure so
// they're fully testable without a network: (1) validateLlmSuggestion() sanitises the JSON the
// Prompt-9 LLM gateway returns; (2) buildSuggestion() is a deterministic keyword+number fallback so
// the feature still works with NO AI key configured. Everything clamps to the SAME schema as the
// browser engine (public/aquin-anim-templates.js) — the model can never push an out-of-range param.
import { TEMPLATES, isTemplate } from '@/lib/animation';

export interface ParamSpec { key: string; min?: number; max?: number; def: number | number[]; list?: boolean; synonyms: string[] }
export interface Suggestion { templateId: string; params: Record<string, any>; confidence: number; source: 'llm' | 'rule'; transcript: string }

// mirror of the browser engine's schema + spoken synonyms for each param
export const PARAM_SPEC: Record<string, ParamSpec[]> = {
  projectile: [
    { key: 'angle', min: 0, max: 90, def: 45, synonyms: ['angle', 'degree', 'degrees', 'elevation'] },
    { key: 'v0', min: 1, max: 100, def: 30, synonyms: ['velocity', 'speed', 'v0', 'launch speed', 'metres per second', 'meters per second'] },
    { key: 'gravity', min: 1, max: 30, def: 9.8, synonyms: ['gravity', 'g'] },
  ],
  sine: [
    { key: 'amplitude', min: 0.1, max: 10, def: 3, synonyms: ['amplitude', 'height', 'peak'] },
    { key: 'frequency', min: 0.1, max: 10, def: 1, synonyms: ['frequency', 'cycles', 'hertz', 'hz'] },
    { key: 'phase', min: 0, max: 6.28, def: 0, synonyms: ['phase', 'shift', 'offset'] },
  ],
  sortbars: [
    { key: 'values', def: [5, 2, 8, 1, 9, 3], list: true, synonyms: ['values', 'numbers', 'array', 'list'] },
  ],
};

// concept keywords that name a template (weighted: a strong term counts more)
const CONCEPTS: Record<string, { term: string; w: number }[]> = {
  projectile: [{ term: 'projectile', w: 3 }, { term: 'trajectory', w: 3 }, { term: 'cannon', w: 2 }, { term: 'launch', w: 2 }, { term: 'throw', w: 2 }, { term: 'parabola', w: 2 }, { term: 'motion', w: 1 }],
  sine: [{ term: 'sine', w: 3 }, { term: 'sinusoid', w: 3 }, { term: 'wave', w: 2 }, { term: 'oscillation', w: 2 }, { term: 'amplitude', w: 1 }, { term: 'frequency', w: 1 }],
  sortbars: [{ term: 'sort', w: 3 }, { term: 'sorting', w: 3 }, { term: 'bubble sort', w: 3 }, { term: 'order', w: 1 }, { term: 'ascending', w: 2 }, { term: 'array', w: 1 }],
};

function clampNum(v: number, s: ParamSpec): number {
  if (typeof s.min === 'number' && v < s.min) v = s.min;
  if (typeof s.max === 'number' && v > s.max) v = s.max;
  return v;
}

/** Clamp arbitrary params to a template's schema. Unknown keys dropped; missing keys defaulted. */
export function clampToSpec(templateId: string, params: any): Record<string, any> {
  const spec = PARAM_SPEC[templateId]; if (!spec) return {};
  const out: Record<string, any> = {}; const p = params && typeof params === 'object' ? params : {};
  for (const s of spec) {
    if (s.list) {
      const arr = Array.isArray(p[s.key]) ? p[s.key].map(Number).filter((n: number) => Number.isFinite(n)) : (s.def as number[]);
      out[s.key] = arr.length ? arr.slice(0, 24) : (s.def as number[]);
    } else {
      const n = Number(p[s.key]);
      out[s.key] = Number.isFinite(n) ? clampNum(n, s) : (s.def as number);
    }
  }
  return out;
}

/** Which template does this phrase name? Pure keyword scoring; null if nothing matches. */
export function detectTemplate(text: string): { templateId: string; score: number } | null {
  const t = ' ' + text.toLowerCase() + ' ';
  let best: { templateId: string; score: number } | null = null;
  for (const id of Object.keys(CONCEPTS)) {
    let score = 0;
    for (const c of CONCEPTS[id]) if (t.includes(' ' + c.term) || t.includes(c.term + ' ')) score += c.w;
    if (score > 0 && (!best || score > best.score)) best = { templateId: id, score };
  }
  return best;
}

/** Pull numbers next to a param's synonyms out of the phrase. Pure. */
export function extractParams(templateId: string, text: string): Record<string, any> {
  const spec = PARAM_SPEC[templateId]; if (!spec) return {};
  const t = text.toLowerCase(); const out: Record<string, any> = {};
  for (const s of spec) {
    if (s.list) {
      const nums = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n));
      if (nums.length >= 2) out[s.key] = nums.slice(0, 24);
      continue;
    }
    for (const syn of s.synonyms) {
      const esc = syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // prefer "<number> <synonym>" (e.g. "30 degrees", "2 hertz"); then "<synonym> ... <number>"
      const before = new RegExp('(-?\\d+(?:\\.\\d+)?)\\s+' + esc);
      const after = new RegExp(esc + '\\D{0,12}(-?\\d+(?:\\.\\d+)?)');
      const m = t.match(before) || t.match(after);
      if (m) { out[s.key] = Number(m[1]); break; }
    }
  }
  return out;
}

/** Deterministic fallback: phrase -> constrained suggestion (no AI needed). null if no template. */
export function buildSuggestion(transcript: string): Suggestion | null {
  const det = detectTemplate(transcript); if (!det) return null;
  const params = clampToSpec(det.templateId, extractParams(det.templateId, transcript));
  const paramHits = Object.keys(extractParams(det.templateId, transcript)).length;
  const confidence = Math.max(0.3, Math.min(0.9, 0.35 + det.score * 0.12 + paramHits * 0.1));
  return { templateId: det.templateId, params, confidence, source: 'rule', transcript };
}

/** Extract the first JSON object from an LLM completion (models often wrap it in prose/fences). */
export function parseLlmJson(text: string): any {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Sanitise an LLM suggestion against the registry + schema. null if it doesn't name a real template. */
export function validateLlmSuggestion(raw: any, transcript: string): Suggestion | null {
  if (!raw || !isTemplate(String(raw.templateId))) return null;
  const templateId = String(raw.templateId);
  const conf = Number(raw.confidence);
  return {
    templateId,
    params: clampToSpec(templateId, raw.params),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.8,
    source: 'llm',
    transcript,
  };
}

/** The strict-JSON system prompt for the LLM path (lists the real registry + schemas). Pure. */
export function llmSystemPrompt(): string {
  const lines = TEMPLATES.map((t) => {
    const spec = PARAM_SPEC[t.id] || [];
    const ps = spec.map((s) => s.list ? `${s.key} (list of numbers)` : `${s.key} (${s.min}..${s.max})`).join(', ');
    return `- ${t.id} (${t.kind}): ${t.name}. params: ${ps || 'none'}`;
  }).join('\n');
  return [
    'You map a physics/math/CS teacher\'s spoken sentence to ONE animation template and its parameters.',
    'Only choose from these templates; never invent one:',
    lines,
    'Reply with STRICT JSON only, no prose: {"templateId": "<id or empty>", "params": { ... }, "confidence": 0..1}.',
    'Use the parameter keys exactly as given; omit params you are unsure of; leave templateId empty if none fits.',
  ].join('\n');
}
