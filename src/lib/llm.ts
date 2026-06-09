// Thin wrapper around the Anthropic API for short, one-shot LLM calls.
// Returns an empty string if ANTHROPIC_API_KEY is missing so callers can
// silently fall back to deterministic behaviour.

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6'; // current best general-purpose Sonnet

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

export interface GeneratedQuestion { prompt: string; topics: string[]; }

// Generate interview / test questions from uploaded source material. Accepts raw
// text, a base64 PDF, or a base64 image (Claude reads PDFs and images natively),
// so an admin can upload a document in almost any format. Returns [] if no key.
export async function generateInterviewQuestions(opts: {
  sourceText?: string; pdfBase64?: string; imageBase64?: string; imageMime?: string;
  count?: number; lang?: string; role?: string;
}): Promise<GeneratedQuestion[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const lang = languageName(opts.lang || 'en-IN');
  const n = Math.max(1, Math.min(30, opts.count || 8));
  const roleLine = opts.role ? ` The interview is for the role: ${opts.role}.` : '';
  const system = `You are an expert interviewer and examiner.${roleLine} From the provided source material, write ${n} clear, standalone interview/test questions in ${lang}. Mix recall, conceptual-understanding and applied/scenario questions appropriate to the material's level. Each question must be answerable from the material or reasonable domain knowledge. Return ONLY a JSON array; each element is an object {"prompt": "<the question>", "topics": ["topic1","topic2"]}. No prose, no markdown fences.`;

  let content: any;
  if (opts.pdfBase64) {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opts.pdfBase64 } },
      { type: 'text', text: `Generate ${n} interview/test questions in ${lang} from this document. Return ONLY the JSON array.` },
    ];
  } else if (opts.imageBase64) {
    content = [
      { type: 'image', source: { type: 'base64', media_type: opts.imageMime || 'image/png', data: opts.imageBase64 } },
      { type: 'text', text: `Generate ${n} interview/test questions in ${lang} from this image. Return ONLY the JSON array.` },
    ];
  } else {
    content = `Source material:\n\n${(opts.sourceText || '').slice(0, 80000)}\n\nGenerate ${n} interview/test questions in ${lang}. Return ONLY the JSON array.`;
  }

  try {
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content }] }),
    });
    if (!resp.ok) { console.error('generateInterviewQuestions: api error', resp.status, await resp.text().catch(() => '')); return []; }
    const data = await resp.json() as any;
    let text = (data.content?.[0]?.text || '').trim();
    const m = text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    if (!Array.isArray(arr)) return [];
    return arr.map((q: any) => ({
      prompt: String(q?.prompt || q?.question || '').trim().slice(0, 1000),
      topics: Array.isArray(q?.topics) ? q.topics.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    })).filter((q: GeneratedQuestion) => q.prompt);
  } catch (e: any) { console.error('generateInterviewQuestions:', e?.message || e); return []; }
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
