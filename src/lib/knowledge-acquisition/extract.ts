// src/lib/knowledge-acquisition/extract.ts — Block 08: the "Extract Concepts" stage.
// Strict zod schema for the LLM's JSON output + the extractor call. The gateway is imported
// lazily so this module (and its schema) load without pulling the LLM/db chain.
import { z } from 'zod';
import type { ScoredSource } from './types';

export const ExtractionSchema = z.object({
  subject: z.string().min(1).max(80),
  domain: z.string().min(1).max(80),
  concept: z.object({ name: z.string().min(1).max(120), description: z.string().max(1000) }),
  explanation: z.object({
    body: z.string().min(1).max(8000),
    equations: z.array(z.object({ latex: z.string().min(1).max(400), caption: z.string().max(200).optional() })).max(20).optional(),
    examples: z.array(z.object({ prompt: z.string().min(1).max(800), solution: z.string().min(1).max(2000) })).max(10).optional(),
  }),
  prerequisites: z.array(z.string().min(1).max(120)).max(12).optional(),
  claims: z.array(z.object({
    text: z.string().min(1).max(600),
    supportIdx: z.array(z.number().int().nonnegative()).min(1).max(12),
  })).min(1).max(30),
  animationPrompt: z.string().max(300).optional(),
  simulationSpec: z.object({ title: z.string().max(120), engine: z.string().max(40).optional(), summary: z.string().max(600).optional() }).optional(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Strip ```json fences the model may wrap around the object. */
export function stripFences(text: string): string {
  const t = (text || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

export const EXTRACT_SYSTEM = `You extract a single teaching concept STRICTLY from the numbered sources provided.
HARD RULES:
- Use ONLY facts present in the sources. Never add outside knowledge. If the sources are insufficient, say so with fewer/empty claims.
- Every claim MUST cite the source numbers it came from via "supportIdx" (0-based indexes into the sources list). Never invent a citation.
- Output ONE JSON object matching the schema. No markdown, no prose outside JSON.`;

/** Call the LLM to extract a concept from the filtered sources; validate its JSON with zod. */
export async function extractConcept(query: string, sources: ScoredSource[]): Promise<Extraction> {
  const { getConfig, isReady, chat, logUsage } = await import('@/lib/llm/gateway');
  const cfg = await getConfig();
  if (!isReady(cfg)) throw new Error('LLM not configured');
  const numbered = sources.map((s, i) => `[${i}] (${s.domain}, reliability ${s.reliability.toFixed(2)}) ${s.title ?? ''}\n${s.excerpt}`).join('\n\n');
  const user = `Concept requested: ${query}\n\nSOURCES:\n${numbered}\n\nReturn the JSON now.`;
  const res = await chat(EXTRACT_SYSTEM, [{ role: 'user', content: user }], { ...cfg, maxTokens: Math.max(cfg.maxTokens, 2000) });
  await logUsage(null, 'knowledge-acquisition', cfg, user.length, res.text.length, 0, res.ok ? 'ok' : 'error');
  if (!res.ok) throw new Error(res.error || 'extraction failed');
  let json: unknown;
  try { json = JSON.parse(stripFences(res.text)); } catch { throw new Error('extraction returned non-JSON'); }
  const parsed = ExtractionSchema.safeParse(json);
  if (!parsed.success) throw new Error('extraction JSON invalid: ' + parsed.error.issues.map((i) => i.path.join('.')).join(','));
  return parsed.data;
}
