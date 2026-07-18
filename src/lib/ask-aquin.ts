// src/lib/ask-aquin.ts — "Ask Aquin" AI tutor (Prompt 9). Builds a GROUNDED, access-scoped system
// prompt from the student's CURRENT KnowledgeObject (retrieval over kernel content: the KO body +
// its permitted prerequisites + course), in the student's language, and never leaks exam-secure
// material or assessment answer keys. Runs through the existing LLM gateway (src/lib/llm/gateway),
// so the model/key/config are the admin's — never hardcoded here. Conversations are logged per
// session for the admin inspector. The prompt builder is pure and unit-tested.

export interface GroundingUnit {
  id: string;
  title: string;
  body?: string;
  equations?: { latex: string; caption?: string }[];
  examples?: { prompt: string; solution: string }[];
  securityLabels?: string[];
}

/** Drop any unit the student may not use as grounding (exam-secure is never exposed to the tutor). */
export function filterGrounding(units: GroundingUnit[]): GroundingUnit[] {
  return units.filter((u) => !(u.securityLabels || []).includes('exam-secure'));
}

function renderUnit(u: GroundingUnit): string {
  const parts = [`# ${u.title}`];
  if (u.body) parts.push(u.body.slice(0, 4000));
  if (u.equations?.length) parts.push('Equations:\n' + u.equations.slice(0, 12).map((e) => '  ' + e.latex).join('\n'));
  if (u.examples?.length) parts.push('Worked examples:\n' + u.examples.slice(0, 6).map((e, i) => `  ${i + 1}. ${e.prompt} => ${e.solution}`).join('\n'));
  return parts.join('\n');
}

export interface PromptInput {
  current: GroundingUnit;
  courseTitle?: string | null;
  prereqTitles?: string[];
  language?: string;
  studentName?: string;
}

/** Build the grounded, access-scoped system prompt. Pure. */
export function buildSystemPrompt(input: PromptInput): string {
  const lang = (input.language || 'en').trim() || 'en';
  const prereqs = (input.prereqTitles || []).filter(Boolean);
  return [
    `You are Aquin, a patient Socratic tutor on the AquinTutor learning platform. You help ${input.studentName || 'the student'} understand the lesson they are currently studying.`,
    input.courseTitle ? `Course: ${input.courseTitle}.` : '',
    prereqs.length ? `This lesson builds on: ${prereqs.join(', ')}.` : '',
    '',
    'GROUNDING — this is the exact lesson content the student is looking at. Base your explanations on it; do not contradict it:',
    '"""',
    renderUnit(input.current),
    '"""',
    '',
    'Rules:',
    `- Answer in the student's language: ${lang}. If they write in another language, follow their lead.`,
    '- Ground your explanations in the lesson content above and sound general knowledge; if the lesson does not cover something, say so plainly rather than inventing facts or citations.',
    '- Be Socratic: when the student is stuck, ask a guiding question or give a hint before the full answer.',
    '- NEVER reveal, guess, or help cheat on graded or exam-secure material, answer keys, or assessment solutions. If asked for exam answers or hidden/secure content, decline and coach the underlying concept instead.',
    '- Only discuss material the student is permitted to see; do not speculate about locked or exam-secure lessons.',
    '- Keep replies focused (2-5 short paragraphs; bullets for lists). Warm, precise, never condescending.',
  ].filter((l) => l !== '').join('\n');
}

// ---- conversation log (per session), for the admin inspector (self-bootstrapping, additive) ----
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureTutorSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_tutor_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id TEXT NOT NULL, user_id UUID, ko_id UUID, role TEXT NOT NULL, content TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_tutor_log_session_idx ON edu_tutor_log (session_id, at)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_tutor_log_at_idx ON edu_tutor_log (at DESC)`));
  booted = true;
}
export async function logTutorTurn(sessionId: string, userId: string | null, koId: string | null, role: 'user' | 'assistant', content: string): Promise<void> {
  try { await ensureTutorSchema(); const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_tutor_log (session_id, user_id, ko_id, role, content) VALUES (${sessionId}, ${userId}, ${koId}, ${role}, ${content.slice(0, 20000)})`);
  } catch { /* logging is best-effort */ }
}
export async function listTutorSessions(limit = 50): Promise<any[]> {
  await ensureTutorSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT l.session_id, MAX(l.at) AS last_at, COUNT(*)::int AS turns, MAX(u.name) AS user_name, MIN(l.ko_id::text) AS ko_id
    FROM edu_tutor_log l LEFT JOIN users u ON u.id = l.user_id GROUP BY l.session_id ORDER BY MAX(l.at) DESC LIMIT ${limit}`));
}
export async function getTutorConversation(sessionId: string): Promise<any[]> {
  await ensureTutorSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT role, content, at FROM edu_tutor_log WHERE session_id = ${sessionId} ORDER BY at`));
}
