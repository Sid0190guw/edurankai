// src/lib/mind/dataset.ts — the corpus a LoRA fine-tune is actually trained on.
//
// WHY THIS FILE EXISTS. Fine-tuning a language model cannot happen inside this deployment: there is
// no GPU behind a serverless function, and there never will be. What CAN happen here — and what
// nothing else in the codebase does yet — is turning what the platform has recorded into a clean,
// auditable, portable dataset, and then judging the resulting model when it comes back. Those are
// the two ends of the loop that must live with the data. The middle, the gradient descent over
// billions of parameters, belongs on a machine with a graphics card and is documented in
// training/lora/.
//
// So: export here, train there, serve through the gateway's own-model endpoint, and evaluate here
// against the model already answering. Same discipline as the small network — a fine-tune does not
// get to serve learners because it is new; it gets to serve because it measured better.
//
// WHAT MAY BE EXPORTED, AND WHAT MAY NOT.
//   * Whitelist, not blacklist. Only the features named in TUTOR_FEATURES are eligible. Anything
//     else this platform stores — wellness, consults, HR, the founder line — is excluded by not
//     being on the list, so a new capture site cannot leak into a training corpus by default.
//   * Personal detail is scrubbed before a row leaves the database: emails, phone numbers, long
//     digit runs, credential-looking strings.
//   * Turns where the assistant gave away an answer it was supposed to coach are DROPPED, using the
//     platform's own leak detector. Training on those would teach a model to do the one thing this
//     product exists not to do.
//   * A human's own words are still in here. That is why the export is an explicit, audited action
//     by an administrator and not a background job, and why the manifest records exactly what went
//     in.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { hash32 } from './features';
import { isHoldout } from './evaluate';
import { INTENT_CLASSES, ruleIntent } from './distill';
import { loadEvents } from './store';
import { textIn } from '@/lib/pg-array';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The only capture sites whose text may be exported. Add to this deliberately, never by accident. */
export const TUTOR_FEATURES = ['tutor-socratic-tutor', 'tutor-explainer', 'ask-aquin', 'aquin-chat', 'homework-helper'];

export interface ChatExample {
  id: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  source: string;
  createdAt: string;
}

export interface DatasetManifest {
  builtAt: string;
  train: number;
  validation: number;
  rejected: { tooShort: number; answerLeak: number; duplicate: number; notWhitelisted: number; empty: number };
  sources: { source: string; n: number }[];
  earliest: string | null;
  latest: string | null;
  checksum: string;
  notes: string[];
}

export interface BuiltDataset { train: ChatExample[]; validation: ChatExample[]; manifest: DatasetManifest }

// ---- pure helpers (unit-tested; no database) ----------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d[\d\s-]{8,}\d)/g;
const LONGNUM = /\b\d{9,}\b/g;
const TOKEN = /\b(?:sk|pk|rzp|key|secret|token|bearer)[-_A-Za-z0-9]{8,}\b/gi;
const URLTOK = /(https?:\/\/[^\s]*?)(?:[?&](?:token|key|auth|session)=[^\s&]+)/gi;

/**
 * Remove the personal detail a tutoring exchange picks up incidentally.
 *
 * Deliberately blunt. A scrubber that tries to be clever about which numbers matter is a scrubber
 * that eventually lets a phone number through, and a fine-tuned model can memorise and repeat what
 * it was trained on — a leak here is permanent in a way a leak in a log is not.
 */
export function scrubPii(text: string): string {
  return String(text || '')
    .replace(EMAIL, '[email]')
    .replace(URLTOK, '$1?[redacted]')
    .replace(TOKEN, '[key]')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m))
    .replace(LONGNUM, '[number]');
}

/** Stable identity for a training row, so the same exchange is never exported twice. */
export function dedupeKey(lastUser: string, completion: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
  return (hash32(norm(lastUser)) >>> 0).toString(16) + '-' + (hash32(norm(completion)) >>> 0).toString(16);
}

/** A cheap content checksum over the exported rows, so a dataset can be identified after the fact. */
export function checksumOf(examples: ChatExample[]): string {
  let a = 0x811c9dc5;
  for (const e of examples) {
    const s = e.id + '|' + e.messages.map((m) => m.role + ':' + m.content).join('|');
    a = (hash32(s) ^ Math.imul(a, 16777619)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + '-' + examples.length;
}

/** JSONL in the shape every mainstream fine-tuning harness reads (axolotl, trl, llama-factory). */
export function toJsonl(examples: ChatExample[]): string {
  return examples.map((e) => JSON.stringify({ messages: e.messages })).join('\n') + (examples.length ? '\n' : '');
}

// ---- the build ----------------------------------------------------------------------------------

export interface BuildOptions {
  limit?: number;
  minCompletionChars?: number;
  validationFraction?: number;
  /** Include the intent-labelled tutor turns as short classification examples. */
  includeIntent?: boolean;
}

export async function buildDataset(opts: BuildOptions = {}): Promise<BuiltDataset> {
  const limit = Math.max(1, Math.min(20000, opts.limit ?? 5000));
  const minChars = Math.max(1, opts.minCompletionChars ?? 40);
  const valFrac = Math.min(0.4, Math.max(0.05, opts.validationFraction ?? 0.15));
  const rejected = { tooShort: 0, answerLeak: 0, duplicate: 0, notWhitelisted: 0, empty: 0 };
  const notes: string[] = [];
  const seen = new Set<string>();
  const all: ChatExample[] = [];

  let leakDetector: ((s: string) => boolean) | null = null;
  try {
    const g = await import('@/lib/llm/guardrails');
    const fn = (g as any).detectAnswerLeak;
    if (typeof fn === 'function') leakDetector = (s: string) => !!fn(s);
  } catch { /* the filter below simply does not run, and the manifest says so */ }
  if (!leakDetector) notes.push('The answer-leak filter was unavailable, so no exchange was dropped on that ground. Review before training a coaching model on this.');

  // 1. the gateway's own capture: real tutor exchanges
  let raw: any[] = [];
  try {
    raw = rows(await db.execute(sql`
      SELECT id, feature, system, messages, completion, rating, created_at
      FROM ai_training_example
      ORDER BY created_at DESC
      LIMIT ${limit}`));
  } catch (e: any) {
    console.error('[mind/dataset] corpus read failed:', e?.cause?.message || e?.message);
    notes.push('The captured-exchange table could not be read; only intent turns are in this export.');
  }

  for (const r of raw) {
    const feature = String(r.feature || '');
    if (!TUTOR_FEATURES.includes(feature)) { rejected.notWhitelisted++; continue; }
    const completion = String(r.completion || '').trim();
    if (!completion) { rejected.empty++; continue; }
    if (completion.length < minChars) { rejected.tooShort++; continue; }
    if (leakDetector && leakDetector(completion)) { rejected.answerLeak++; continue; }

    let msgs: any = r.messages;
    if (typeof msgs === 'string') { try { msgs = JSON.parse(msgs); } catch { msgs = []; } }
    if (!Array.isArray(msgs) || !msgs.length) { rejected.empty++; continue; }

    const lastUser = [...msgs].reverse().find((m: any) => m?.role === 'user')?.content || '';
    const key = dedupeKey(String(lastUser), completion);
    if (seen.has(key)) { rejected.duplicate++; continue; }
    seen.add(key);

    const system = scrubPii(String(r.system || '')).slice(0, 4000);
    const messages: ChatExample['messages'] = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of msgs.slice(-8)) {
      const role = m?.role === 'assistant' ? 'assistant' : 'user';
      const content = scrubPii(String(m?.content || '')).slice(0, 4000);
      if (content) messages.push({ role, content });
    }
    messages.push({ role: 'assistant', content: scrubPii(completion).slice(0, 6000) });
    all.push({ id: String(r.id), messages, source: feature, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) });
  }

  // 2. intent turns as short classification examples — the cheapest way to teach a fine-tune the
  //    platform's own taxonomy, and the only part of the corpus that exists before the gateway is on.
  if (opts.includeIntent !== false) {
    try {
      const events = await loadEvents({ task: 'intent', limit: Math.min(4000, limit), labelled: true });
      for (const e of events) {
        const text = scrubPii(String(e.signals?.text || '')).trim();
        if (text.length < 4) { rejected.empty++; continue; }
        const idx = Math.round(e.label ?? -1);
        const klass = INTENT_CLASSES[idx] || ruleIntent(text).klass;
        const key = dedupeKey(text, 'intent:' + klass);
        if (seen.has(key)) { rejected.duplicate++; continue; }
        seen.add(key);
        all.push({
          id: e.id,
          messages: [
            { role: 'system', content: 'Classify what a learner needs. Answer with one of: ' + INTENT_CLASSES.join(', ') + '.' },
            { role: 'user', content: text.slice(0, 1000) },
            { role: 'assistant', content: klass },
          ],
          source: 'intent:' + (e.labelSource || 'rules'),
          createdAt: e.occurredAt,
        });
      }
    } catch (e: any) {
      console.error('[mind/dataset] intent corpus read failed:', e?.cause?.message || e?.message);
    }
  }

  // 3. split — deterministic by id, so a re-export puts the same rows on the same side and a
  //    validation score stays comparable between runs.
  const train = all.filter((e) => !isHoldout('ds-' + e.id, valFrac));
  const validation = all.filter((e) => isHoldout('ds-' + e.id, valFrac));

  const bySource = new Map<string, number>();
  for (const e of all) bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
  const dates = all.map((e) => e.createdAt).filter(Boolean).sort();

  if (all.length < 200) notes.push('Under 200 usable examples. A LoRA fine-tune on this little will imitate its quirks rather than learn its style; the small network in src/lib/mind is the better use of a corpus this size until it grows.');
  if (rejected.answerLeak) notes.push(rejected.answerLeak + ' exchanges were dropped for handing over an answer the learner was meant to work out.');

  return {
    train,
    validation,
    manifest: {
      builtAt: new Date().toISOString(),
      train: train.length,
      validation: validation.length,
      rejected,
      sources: [...bySource.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n),
      earliest: dates[0] || null,
      latest: dates[dates.length - 1] || null,
      checksum: checksumOf(all),
      notes,
    },
  };
}

/** Counts only — for the console, without building the whole export. */
export async function datasetSize(): Promise<{ captured: number; whitelisted: number; intent: number }> {
  let captured = 0, whitelisted = 0, intent = 0;
  try {
    // Membership through the repo's helper, never `= ANY(${jsArray})` — that pattern is the bug
    // src/lib/pg-array.ts was written about, and it fails silently.
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE feature IN ${textIn(TUTOR_FEATURES)})::int AS w
      FROM ai_training_example`))[0];
    captured = Number(r?.n || 0); whitelisted = Number(r?.w || 0);
  } catch (e: any) { console.error('[mind/dataset] size read failed:', e?.cause?.message || e?.message); }
  try {
    const r = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM aq_mind_event WHERE task = 'intent' AND label IS NOT NULL`))[0];
    intent = Number(r?.n || 0);
  } catch { /* the table may not exist before the first cycle */ }
  return { captured, whitelisted, intent };
}

// ---- judging what comes back --------------------------------------------------------------------

export interface EndpointEval {
  ok: boolean;
  n: number;
  modelAccuracy: number;
  rulesAccuracy: number;
  provider: string;
  verdict: string;
  error?: string;
}

/**
 * Score whatever model is configured RIGHT NOW against the platform's own rules, on tutor turns a
 * teacher model or a person labelled independently.
 *
 * This is how a returning fine-tune earns its place: point the gateway at the adapted model, run
 * this, and read whether it actually beats what was already answering. A fine-tune that cannot beat
 * a regular expression on the platform's own taxonomy has not learned this platform.
 */
export async function evaluateConfiguredModel(limit = 60): Promise<EndpointEval> {
  const { effectiveConfig, isReady, chatStream, activeModel } = await import('@/lib/llm/gateway');
  const cfg = await effectiveConfig();
  if (!isReady(cfg)) return { ok: false, n: 0, modelAccuracy: 0, rulesAccuracy: 0, provider: 'none', verdict: '', error: 'No model is configured to evaluate.' };

  const events = (await loadEvents({ task: 'intent', limit: 2000, labelled: true }))
    .filter((e) => e.labelSource === 'human' || e.labelSource === 'teacher')
    .slice(-Math.max(10, Math.min(200, limit)));
  if (events.length < 10) {
    return { ok: false, n: events.length, modelAccuracy: 0, rulesAccuracy: 0, provider: cfg.provider, verdict: '', error: 'Only ' + events.length + ' independently labelled turns exist. There is nothing solid to judge a model against yet — run a teacher labelling pass, or correct some turns by hand.' };
  }

  const system = 'Reply with exactly one word from this list and nothing else: ' + INTENT_CLASSES.join(', ') + '.';
  let modelRight = 0, rulesRight = 0, asked = 0;
  for (const e of events) {
    const text = String(e.signals?.text || '');
    if (!text) continue;
    let out = '';
    const r = await chatStream(system, [{ role: 'user', content: text.slice(0, 1000) }], { ...cfg, maxTokens: 8 }, (t) => { out += t; }).catch(() => null);
    if (!r || !r.ok) continue;
    asked++;
    const word = (out || r.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const gold = Math.round(e.label as number);
    if ((INTENT_CLASSES as readonly string[]).indexOf(word) === gold) modelRight++;
    if (ruleIntent(text).index === gold) rulesRight++;
  }
  if (!asked) return { ok: false, n: 0, modelAccuracy: 0, rulesAccuracy: 0, provider: cfg.provider, verdict: '', error: 'The configured model answered nothing. Check the endpoint.' };

  const modelAccuracy = +(modelRight / asked).toFixed(4);
  const rulesAccuracy = +(rulesRight / asked).toFixed(4);
  return {
    ok: true, n: asked, modelAccuracy, rulesAccuracy, provider: cfg.provider + ':' + activeModel(cfg),
    verdict: modelAccuracy > rulesAccuracy
      ? 'The configured model reads the platform taxonomy better than the rules do (' + (modelAccuracy * 100).toFixed(1) + '% against ' + (rulesAccuracy * 100).toFixed(1) + '%) on ' + asked + ' independently labelled turns.'
      : 'The configured model does NOT beat the platform rules (' + (modelAccuracy * 100).toFixed(1) + '% against ' + (rulesAccuracy * 100).toFixed(1) + '%) on ' + asked + ' independently labelled turns. Fine-tuning it on the exported corpus is exactly the gap this measures.',
  };
}
