// AI Conversation tutor — chat with an AI in your target language. Uses
// Anthropic Claude. Awards XP per turn. Falls back to a stub message if
// ANTHROPIC_API_KEY is missing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
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

  let reply: string;
  if (!apiKey) {
    reply = `(AI tutor is not configured. Set ANTHROPIC_API_KEY in env to enable conversational practice in ${LANGS[language] || language}.)`;
  } else {
    try {
      const resp = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          system: systemPrompt(language, topic, level),
          messages: messages.slice(-12).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return { ok: false, error: 'AI temporarily unavailable: ' + err.slice(0, 200), conversationId: conv.id, xpDelta: 0, turnCount: conv.turn_count };
      }
      const data = await resp.json() as any;
      reply = (data?.content?.[0]?.text || '').trim() || '(no reply)';
    } catch (e: any) {
      return { ok: false, error: e?.message || 'network error', conversationId: conv.id, xpDelta: 0, turnCount: conv.turn_count };
    }
  }

  messages.push({ role: 'assistant', content: reply });
  const xpDelta = 4; // 4 XP per learner turn
  await db.execute(sql`
    UPDATE ai_conversations SET
      messages = ${sql.json(messages)},
      turn_count = turn_count + 1,
      xp_awarded = xp_awarded + ${xpDelta}
    WHERE id = ${conv.id}
  `);
  try {
    const { awardXp } = await import('@/lib/xp');
    await awardXp({ userId: opts.userId, source: 'ai_conversation', refId: conv.id, delta: xpDelta, reason: 'AI conversation turn (' + (LANGS[language] || language) + ')' });
  } catch (_) {}

  return { ok: true, reply, conversationId: conv.id, xpDelta, turnCount: conv.turn_count + 1 };
}
