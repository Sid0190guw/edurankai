// Thin wrapper around the Anthropic API for short, one-shot LLM calls.
// Returns an empty string if ANTHROPIC_API_KEY is missing so callers can
// silently fall back to deterministic behaviour.

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5'; // current best general-purpose Sonnet

const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English', 'en-IN': 'English (India)', 'en-US': 'English (US)', 'en-GB': 'English (UK)',
  'hi-IN': 'Hindi', 'bn-IN': 'Bengali', 'ta-IN': 'Tamil', 'te-IN': 'Telugu',
  'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi', 'ur-IN': 'Urdu',
  'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German', 'it-IT': 'Italian',
  'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
  'ru-RU': 'Russian', 'ja-JP': 'Japanese', 'ko-KR': 'Korean',
  'zh-CN': 'Mandarin (Simplified)', 'zh-TW': 'Mandarin (Traditional)',
  'ar-SA': 'Arabic', 'tr-TR': 'Turkish', 'nl-NL': 'Dutch', 'sv-SE': 'Swedish',
  'pl-PL': 'Polish', 'th-TH': 'Thai', 'id-ID': 'Indonesian', 'vi-VN': 'Vietnamese',
};

function languageName(bcp47: string): string {
  return LANGUAGE_NAMES[bcp47] || bcp47;
}

export function isLlmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

interface FollowUpInput {
  seed: string;
  candidateAnswer: string;
  lang: string;
  contextTurns?: { role: 'ai' | 'candidate'; text: string }[];
}

/** Ask one short follow-up question in the candidate's language. */
export async function askFollowUp(input: FollowUpInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '';

  const lang = languageName(input.lang || 'en-IN');
  const ctx = (input.contextTurns || []).slice(-6)
    .map(t => `${t.role === 'ai' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
    .join('\n');

  const system = `You are a calm, encouraging job interviewer. Your job is to ask ONE clarifying follow-up question in ${lang} based on the candidate's vague or short answer. The follow-up must:
- be a single sentence ending with a question mark
- be specific to what the candidate just said
- stay relevant to the original seed question
- be written entirely in ${lang}
- never invent facts about the candidate
- never be aggressive or rude

Return ONLY the follow-up question text. No greeting, no commentary, no quotation marks.`;

  const userMsg = `Seed question that was asked:
"${input.seed}"

Candidate's answer (which was vague or short):
"${input.candidateAnswer}"

${ctx ? `Conversation so far:\n${ctx}\n` : ''}

Write ONE follow-up question in ${lang}.`;

  try {
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!resp.ok) {
      console.error('askFollowUp: claude api error', resp.status, await resp.text().catch(() => ''));
      return '';
    }
    const data = await resp.json() as any;
    const text = (data.content?.[0]?.text || '').trim().replace(/^["“'']+|["”'']+$/g, '');
    return text;
  } catch (e: any) {
    console.error('askFollowUp:', e?.message || e);
    return '';
  }
}
