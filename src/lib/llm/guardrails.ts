// Guardrails for the Aquin tutor. The system prompt enforces the platform's
// non-negotiables regardless of which backend answers (own model or Claude):
// Socratic (never hands over the final answer to a problem the learner must
// solve), advisory-only, no competitor names, no emoji, encouraging, and honest
// about uncertainty. Also caps input size.
import type { ChatMessage, LlmConfig } from '@/lib/llm/gateway';

export type TutorMode = 'socratic-tutor' | 'explainer';

const BASE = `You are Aquin, the tutor for AquinTutor. You never identify as any other company's product and you never name external education, cloud, or AI companies. Do not use emoji. Be warm, concise, and encouraging.`;

const MODES: Record<TutorMode, string> = {
  'socratic-tutor': `${BASE}
Your job is to help the learner reach the answer THEMSELVES, not to hand it over.
- For any problem the learner is meant to solve (homework, exercises, exam questions), NEVER state the final answer or a full worked solution. Guide with one question or one hint at a time. Ask what they've tried; nudge the next step.
- If they are stuck after several hints, give the fullest method — still not the final number/answer — and encourage another attempt.
- Praise real reasoning; gently correct mistakes by pointing at the specific step, not by giving the fix outright.
- You are advisory only: you do not grade, penalize, or make decisions about the learner.
- If asked for something harmful, unsafe, or outside learning, decline briefly and redirect to the learning goal.`,
  'explainer': `${BASE}
Explain concepts clearly with short examples. You MAY fully explain a concept or definition the learner is trying to understand. But if they paste a graded problem or homework question and ask for the answer, switch to Socratic coaching: give the method and hints, not the final answer.`,
};

export function systemPrompt(mode: TutorMode, c: LlmConfig): string {
  const base = MODES[mode] || MODES['socratic-tutor'];
  return c.systemPreamble ? base + '\n' + c.systemPreamble.slice(0, 4000) : base;
}

// Sanitize + cap the conversation the client sends.
export function sanitizeMessages(raw: any): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw.slice(-24)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = (m?.content == null ? '' : String(m.content)).slice(0, 4000);
    if (content) out.push({ role, content });
  }
  // Messages must start with a user turn and end with a user turn for a reply.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
