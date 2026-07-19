// src/lib/board-assess.ts — Block 07: generate a live quiz from a session's fired concepts +
// transcript. Pure windowConcepts/validateDrafts + a DB/LLM generateLiveAssessment. Degrades to a
// deterministic template when no LLM is configured (hard invariant across the board features).
export interface LiveItemDraft { type: 'mcq' | 'numeric' | 'true_false'; prompt: string; options?: string[]; answer: any; points: number }
export interface DetectionLike { transcript?: string | null; templateId?: string | null; params?: any }

/** Collect distinct concepts (params.concept, else templateId) + the transcript window (pure). */
export function windowConcepts(dets: DetectionLike[]): { concepts: string[]; transcript: string } {
  const concepts: string[] = [];
  const seen = new Set<string>();
  for (const d of dets) {
    const c = (d.params && typeof d.params.concept === 'string' && d.params.concept) || d.templateId || '';
    if (c && !seen.has(c)) { seen.add(c); concepts.push(c); }
  }
  const transcript = dets.map((d) => (d.transcript || '').trim()).filter(Boolean).join(' ');
  return { concepts, transcript };
}

/** Clamp arbitrary LLM output to valid item drafts; drop anything malformed (pure). */
export function validateDrafts(raw: unknown): LiveItemDraft[] {
  const arr: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.items) ? (raw as any).items : [];
  const out: LiveItemDraft[] = [];
  for (const d of arr) {
    if (!d || typeof d.prompt !== 'string' || !d.prompt.trim()) continue;
    const type: LiveItemDraft['type'] = ['mcq', 'numeric', 'true_false'].includes(d.type) ? d.type : 'mcq';
    const points = Number.isFinite(d.points) ? Math.max(1, Math.min(10, Math.round(d.points))) : 1;
    const options = type === 'mcq' && Array.isArray(d.options) ? d.options.slice(0, 6).map((o: any) => String(o)) : undefined;
    if (type === 'mcq' && (!options || options.length < 2)) continue;   // an mcq needs >= 2 options
    out.push({ type, prompt: d.prompt.slice(0, 600), options, answer: d.answer ?? {}, points });
    if (out.length >= 20) break;
  }
  return out;
}

/** Deterministic fallback when no LLM is configured: one true/false per concept. */
export function templateItemsFor(concepts: string[]): LiveItemDraft[] {
  return concepts.slice(0, 10).map((c) => ({
    type: 'true_false' as const,
    prompt: `The concept "${c}" was covered in this session.`,
    answer: { value: true }, points: 1,
  }));
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

const ASSESS_SYSTEM = `You write short quiz items STRICTLY about the concepts and transcript from a live lecture.
Return ONLY a JSON array. Each item: { "type": "mcq"|"numeric"|"true_false", "prompt": string, "options"?: string[], "answer": object, "points": number }.
For mcq include >=2 "options" and an answer {"correctIndex": n}. No prose outside JSON.`;

/** Generate + persist a live AssessmentObject for a session. Returns the assessment id + item count. */
export async function generateLiveAssessment(sessionId: string, koId: string | null, owner: string, window = 40): Promise<{ assessmentId: string; items: number; source: 'llm' | 'template' }> {
  await ctx();
  const { db, sql } = await ctx();
  // ensure the link table exists
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_board_assessments (
     session_id TEXT NOT NULL, assessment_id UUID NOT NULL, generated_from BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (session_id, assessment_id))`));

  let dets: DetectionLike[] = [];
  try {
    dets = rows(await db.execute(sql`SELECT transcript, template_id AS "templateId", params FROM edu_board_detections WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${window}`));
  } catch { dets = []; }
  const { concepts, transcript } = windowConcepts(dets);

  let drafts: LiveItemDraft[] = [];
  let source: 'llm' | 'template' = 'template';
  try {
    const { getConfig, isReady, chat, logUsage } = await import('@/lib/llm/gateway');
    const cfg = await getConfig();
    if (isReady(cfg) && concepts.length) {
      const user = `Concepts: ${concepts.join(', ')}\n\nTranscript:\n${transcript.slice(0, 4000)}\n\nWrite up to 6 items.`;
      const res = await chat(ASSESS_SYSTEM, [{ role: 'user', content: user }], cfg);
      await logUsage(owner, 'board-assess', cfg, user.length, res.text.length, 0, res.ok ? 'ok' : 'error');
      if (res.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, '').trim()); } catch { parsed = null; }
        drafts = validateDrafts(parsed);
        if (drafts.length) source = 'llm';
      }
    }
  } catch { /* fall through to template */ }
  if (!drafts.length) drafts = templateItemsFor(concepts);
  if (!drafts.length) throw new Error('no concepts to assess yet');

  const { createAssessment, addItem } = await import('@/lib/assessment');
  const assessedId = koId || dets.find((d) => d.params?.conceptId)?.params?.conceptId || sessionId;
  const assessmentId = await createAssessment(`Live quiz: ${concepts.slice(0, 3).join(', ') || sessionId}`, 'quiz', String(assessedId), owner);
  let i = 0;
  for (const d of drafts) { await addItem(assessmentId, { type: d.type, prompt: d.prompt, options: d.options, answer: d.answer, points: d.points, sort: i++ }); }

  const lastId = rows(await db.execute(sql`SELECT COALESCE(MAX(id),0) AS m FROM edu_board_detections WHERE session_id = ${sessionId}`))[0]?.m ?? 0;
  await db.execute(sql`INSERT INTO edu_board_assessments (session_id, assessment_id, generated_from) VALUES (${sessionId}, ${assessmentId}, ${lastId}) ON CONFLICT (session_id, assessment_id) DO NOTHING`);
  return { assessmentId, items: drafts.length, source };
}
