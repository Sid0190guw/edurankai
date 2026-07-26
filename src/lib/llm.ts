// Short, one-shot LLM calls for the interview/test tooling. Text goes through the first-party
// gateway (self-hosted 'own' model → env-Anthropic fallback), so it runs against a self-hosted
// open-weight model with zero code change. The document/image (multimodal) path still uses the
// vision-capable claude provider — but with creds+model resolved from the gateway CONFIG, not a
// raw env key — because a self-hosted vision model would need the OpenAI multimodal content
// format (a follow-up). Returns [] / '' when nothing is configured so callers degrade silently.
import { complete, effectiveConfig } from '@/lib/llm/gateway';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';   // multimodal-only path

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
  // Heuristic used to gate UI: an env Anthropic key means the fallback connector is available.
  // (A DB-configured self-hosted 'own' provider also works at call time even when this is false.)
  return !!process.env.ANTHROPIC_API_KEY;
}

function parseQuestions(text: string): GeneratedQuestion[] {
  try {
    const t = (text || '').trim();
    const m = t.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : t);
    if (!Array.isArray(arr)) return [];
    return arr.map((q: any) => ({
      prompt: String(q?.prompt || q?.question || '').trim().slice(0, 1000),
      topics: Array.isArray(q?.topics) ? q.topics.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    })).filter((q: GeneratedQuestion) => q.prompt);
  } catch { return []; }
}

export interface GeneratedQuestion { prompt: string; topics: string[]; }

// Generate interview / test questions from uploaded source material. Accepts raw
// text, a base64 PDF, or a base64 image (Claude reads PDFs and images natively),
// so an admin can upload a document in almost any format. Returns [] if no key.
export async function generateInterviewQuestions(opts: {
  sourceText?: string; pdfBase64?: string; imageBase64?: string; imageMime?: string;
  count?: number; lang?: string; role?: string;
}): Promise<GeneratedQuestion[]> {
  const lang = languageName(opts.lang || 'en-IN');
  const n = Math.max(1, Math.min(30, opts.count || 8));
  const roleLine = opts.role ? ` The interview is for the role: ${opts.role}.` : '';
  const system = `You are an expert interviewer and examiner.${roleLine} From the provided source material, write ${n} clear, standalone interview/test questions in ${lang}. Mix recall, conceptual-understanding and applied/scenario questions appropriate to the material's level. Each question must be answerable from the material or reasonable domain knowledge. Return ONLY a JSON array; each element is an object {"prompt": "<the question>", "topics": ["topic1","topic2"]}. No prose, no markdown fences.`;

  // TEXT path → first-party gateway (portable to a self-hosted open-weight model).
  if (!opts.pdfBase64 && !opts.imageBase64) {
    const userContent = `Source material:\n\n${(opts.sourceText || '').slice(0, 80000)}\n\nGenerate ${n} interview/test questions in ${lang}. Return ONLY the JSON array.`;
    const r = await complete({ feature: 'interview_qgen', system, messages: [{ role: 'user', content: userContent }], maxTokens: 3000 });
    return r.ok ? parseQuestions(r.text) : [];
  }

  // MULTIMODAL path (PDF/image) — needs a vision model. Creds+model come from the gateway config
  // (DB claude creds → env), so this stays config-driven, not a raw hard-wired key.
  const cfg = await effectiveConfig();
  const apiKey = cfg.claudeApiKey;
  if (!apiKey) return [];
  const content = opts.pdfBase64
    ? [ { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opts.pdfBase64 } },
        { type: 'text', text: `Generate ${n} interview/test questions in ${lang} from this document. Return ONLY the JSON array.` } ]
    : [ { type: 'image', source: { type: 'base64', media_type: opts.imageMime || 'image/png', data: opts.imageBase64 } },
        { type: 'text', text: `Generate ${n} interview/test questions in ${lang} from this image. Return ONLY the JSON array.` } ];
  try {
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.claudeModel, max_tokens: 3000, system, messages: [{ role: 'user', content }] }),
    });
    if (!resp.ok) { console.error('generateInterviewQuestions: api error', resp.status, await resp.text().catch(() => '')); return []; }
    const data = await resp.json() as any;
    return parseQuestions(data.content?.[0]?.text || '');
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

  const r = await complete({ feature: 'interview_followup', system, messages: [{ role: 'user', content: userMsg }], maxTokens: 120 });
  if (!r.ok || !r.text) return '';
  return r.text.trim().replace(/^["“'']+|["”'']+$/g, '');
}
