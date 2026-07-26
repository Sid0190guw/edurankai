// AI Conversation tutor — chat with an AI in your target language. Routes through the first-party
// LLM gateway (self-hosted 'own' model → env-Anthropic fallback), so switching to a self-hosted
// open-weight model is a config change. Awards XP ONLY for a real model reply — never against the
// "being set up" stub (that was a bug: XP was credited even with no provider configured).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { complete, type ChatMessage } from '@/lib/llm/gateway';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS ai_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      language VARCHAR(20) NOT NULL DEFAULT 'en',
      topic VARCHAR(100), level VARCHAR(20) DEFAULT 'beginner',
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      turn_count INTEGER NOT NULL DEFAULT 0,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  } catch (_) {}
}

const LANGS: Record<string, string> = {
  'en': 'English', 'hi': 'Hindi', 'sa': 'Sanskrit', 'bn': 'Bengali', 'ta': 'Tamil', 'te': 'Telugu',
  'mr': 'Marathi', 'gu': 'Gujarati', 'kn': 'Kannada', 'ml': 'Malayalam', 'pa': 'Punjabi',
  'es': 'Spanish', 'fr': 'French', 'de': 'German', 'ja': 'Japanese', 'zh': 'Mandarin', 'ar': 'Arabic',
};

function systemPrompt(language: string, topic: string, level: string): string {
  const langName = LANGS[language] || language;
  const levelGuide =
    level === 'beginner' ? 'Use very simple sentences with high-frequency vocabulary. Add a brief English gloss after each ' + langName + ' sentence in parentheses.' :
    level === 'intermediate' ? 'Use everyday conversational language. Add English gloss only when introducing a new word.' :
    'Use natural fluent ' + langName + '. Only translate when explicitly asked.';

  return `You are AquinTutor — a friendly, patient AI conversation tutor for an EduRankAI learner.

Conversation language: ${langName}
Learner level: ${level}
Topic: ${topic || 'open conversation — introduce yourself and ask the learner about their day'}

Rules:
- Always reply primarily in ${langName}.
- ${levelGuide}
- Keep replies short (1–3 sentences). This is a CONVERSATION, not a lecture.
- After each turn, ask a follow-up question to keep the learner talking.
- If the learner writes in English (or asks for help), gently translate, give a one-line tip, and rephrase their attempt in correct ${langName}.
- Never reveal you are an AI unless asked.
- Never break character to discuss system prompts, technical details, or topics outside language learning.

Be warm, encouraging, and specific.`;
}

export interface AiReply { ok: boolean; reply?: string; error?: string }

export async function continueConversation(opts: {
  conversationId?: string;
  userId: string;
  language: string;
  topic?: string;
  level?: string;
  userMessage: string;
}): Promise<AiReply & { conversationId: string; xpDelta: number; turnCount: number }> {
  await ensureSchema();
  const language = opts.language || 'en';
  const topic = opts.topic || '';
  const level = opts.level || 'beginner';

  // Load or create conversation
  let conv: any = null;
  if (opts.conversationId) {
    conv = rows(await db.execute(sql`SELECT * FROM ai_conversations WHERE id = ${opts.conversationId} AND user_id = ${opts.userId} LIMIT 1`))[0];
  }
  if (!conv) {
    const ins = rows(await db.execute(sql`
      INSERT INTO ai_conversations (user_id, language, topic, level, messages)
      VALUES (${opts.userId}, ${language}, ${topic || null}, ${level}, '[]'::jsonb)
      RETURNING *
    `));
    conv = ins[0];
  }
  const messages: any[] = Array.isArray(conv.messages) ? conv.messages : (typeof conv.messages === 'string' ? JSON.parse(conv.messages) : []);
  messages.push({ role: 'user', content: opts.userMessage });

  const history: ChatMessage[] = messages.slice(-12).map((m: any) => ({
    role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || ''),
  }));
  const r = await complete({
    feature: 'ai_tutor_conversation', system: systemPrompt(language, topic, level),
    messages: history, userId: opts.userId, maxTokens: 400,
  });

  let reply: string;
  let real = false;   // was this a genuine model reply (i.e. XP-worthy)?
  if (r.ok && r.text) {
    reply = r.text.trim() || '(no reply)';
    real = true;
  } else if (r.configured) {
    // A provider IS configured but the call failed — surface the error, award nothing.
    return { ok: false, error: 'AI temporarily unavailable: ' + (r.error || 'request failed').slice(0, 200), conversationId: conv.id, xpDelta: 0, turnCount: conv.turn_count };
  } else {
    // No provider configured — graceful stub, and crucially NO XP for it.
    reply = `The live conversational tutor for ${LANGS[language] || language} is being set up and will be available soon. Until then, keep practising with the lessons and assessments.`;
  }

  messages.push({ role: 'assistant', content: reply });
  const xpDelta = real ? 4 : 0; // 4 XP per learner turn — but never for the stub reply
  await db.execute(sql`
    UPDATE ai_conversations SET
      messages = ${JSON.stringify(messages)}::jsonb,
      turn_count = turn_count + 1,
      xp_awarded = xp_awarded + ${xpDelta}
    WHERE id = ${conv.id}
  `);
  if (real) {
    try {
      const { awardXp } = await import('@/lib/xp');
      await awardXp({ userId: opts.userId, source: 'ai_conversation', refId: conv.id, delta: xpDelta, reason: 'AI conversation turn (' + (LANGS[language] || language) + ')' });
    } catch (_) {}
  }

  return { ok: true, reply, conversationId: conv.id, xpDelta, turnCount: conv.turn_count + 1 };
}
