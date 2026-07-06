// Own-LLM inference gateway — dual backend.
//   provider = 'own'    -> your self-hosted model over the standard
//                          chat-completions HTTP protocol (vLLM / TGI /
//                          llama.cpp server / Ollama / text-generation-webui).
//   provider = 'claude' -> Anthropic Messages API (default claude-opus-4-8).
// Switchable from the super-admin panel with zero code change. Everything a
// learner and Aquin exchange is ALSO captured as a training example
// (ai_training_example) so the data trains AquinTutor's own model over time.
// Disabled by default: nothing in the core learning loops depends on this (P9).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type Provider = 'own' | 'claude';
export interface LlmConfig {
  enabled: boolean;
  provider: Provider;
  // own (chat-completions compatible)
  baseUrl: string;
  model: string;
  apiKey: string;
  // claude
  claudeApiKey: string;
  claudeModel: string;
  // shared
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  systemPreamble: string;
  captureTraining: boolean;
}
export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
export interface ChatResult { ok: boolean; text: string; promptTokens?: number; completionTokens?: number; error?: string; }

const DEFAULTS: LlmConfig = {
  enabled: false, provider: 'own', baseUrl: '', model: '', apiKey: '',
  claudeApiKey: '', claudeModel: 'claude-opus-4-8',
  maxTokens: 512, temperature: 0.4, timeoutMs: 30000, systemPreamble: '', captureTraining: true,
};

let ready: Promise<void> | null = null;
export function ensureLlmSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS ai_llm_config (
        id TEXT PRIMARY KEY DEFAULT 'default',
        enabled BOOLEAN NOT NULL DEFAULT false,
        provider TEXT NOT NULL DEFAULT 'own',
        base_url TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        claude_api_key TEXT NOT NULL DEFAULT '',
        claude_model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
        max_tokens INT NOT NULL DEFAULT 512,
        temperature REAL NOT NULL DEFAULT 0.4,
        timeout_ms INT NOT NULL DEFAULT 30000,
        system_preamble TEXT NOT NULL DEFAULT '',
        capture_training BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      // additive columns for pre-existing installs
      for (const col of [
        `provider TEXT NOT NULL DEFAULT 'own'`, `claude_api_key TEXT NOT NULL DEFAULT ''`,
        `claude_model TEXT NOT NULL DEFAULT 'claude-opus-4-8'`, `capture_training BOOLEAN NOT NULL DEFAULT true`,
      ]) { try { await db.execute(sql.raw(`ALTER TABLE ai_llm_config ADD COLUMN IF NOT EXISTS ${col}`)); } catch (_) {} }

      await db.execute(sql`CREATE TABLE IF NOT EXISTS ai_usage_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID, feature TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        prompt_chars INT NOT NULL DEFAULT 0, completion_chars INT NOT NULL DEFAULT 0,
        prompt_tokens INT, completion_tokens INT, latency_ms INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      try { await db.execute(sql.raw(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT ''`)); } catch (_) {}
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage_log (user_id, created_at DESC)`);

      // Training corpus — one row per assistant completion, the fine-tuning source.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS ai_training_example (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID, feature TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        system TEXT NOT NULL DEFAULT '', messages JSONB NOT NULL DEFAULT '[]', completion TEXT NOT NULL DEFAULT '',
        rating INT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_training_created_idx ON ai_training_example (created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export async function getConfig(): Promise<LlmConfig> {
  try {
    await ensureLlmSchema();
    const r = rows(await db.execute(sql`SELECT * FROM ai_llm_config WHERE id = 'default' LIMIT 1`))[0];
    if (!r) return { ...DEFAULTS };
    return {
      enabled: !!r.enabled, provider: (r.provider === 'claude' ? 'claude' : 'own'),
      baseUrl: r.base_url || '', model: r.model || '', apiKey: r.api_key || '',
      claudeApiKey: r.claude_api_key || process.env.ANTHROPIC_API_KEY || '', claudeModel: r.claude_model || 'claude-opus-4-8',
      maxTokens: Number(r.max_tokens) || 512, temperature: r.temperature != null ? Number(r.temperature) : 0.4,
      timeoutMs: Number(r.timeout_ms) || 30000, systemPreamble: r.system_preamble || '',
      captureTraining: r.capture_training !== false,
    };
  } catch { return { ...DEFAULTS }; }
}

export async function saveConfig(c: Partial<LlmConfig>): Promise<void> {
  await ensureLlmSchema();
  const n = { ...(await getConfig()), ...c };
  await db.execute(sql`INSERT INTO ai_llm_config
    (id, enabled, provider, base_url, model, api_key, claude_api_key, claude_model, max_tokens, temperature, timeout_ms, system_preamble, capture_training, updated_at)
    VALUES ('default', ${n.enabled}, ${n.provider}, ${n.baseUrl}, ${n.model}, ${n.apiKey}, ${n.claudeApiKey}, ${n.claudeModel}, ${n.maxTokens}, ${n.temperature}, ${n.timeoutMs}, ${n.systemPreamble}, ${n.captureTraining}, NOW())
    ON CONFLICT (id) DO UPDATE SET enabled=${n.enabled}, provider=${n.provider}, base_url=${n.baseUrl}, model=${n.model},
      api_key=${n.apiKey}, claude_api_key=${n.claudeApiKey}, claude_model=${n.claudeModel}, max_tokens=${n.maxTokens},
      temperature=${n.temperature}, timeout_ms=${n.timeoutMs}, system_preamble=${n.systemPreamble}, capture_training=${n.captureTraining}, updated_at=NOW()`);
}

export function isReady(c: LlmConfig): boolean {
  if (!c.enabled) return false;
  return c.provider === 'claude' ? !!(c.claudeApiKey && c.claudeModel) : !!(c.baseUrl && c.model);
}
export function activeModel(c: LlmConfig): string { return c.provider === 'claude' ? c.claudeModel : c.model; }

export async function logUsage(userId: string | null, feature: string, c: LlmConfig, promptChars: number, completionChars: number, latencyMs: number, status: string, pt?: number, ct?: number): Promise<void> {
  try {
    await ensureLlmSchema();
    await db.execute(sql`INSERT INTO ai_usage_log (user_id, feature, provider, model, prompt_chars, completion_chars, prompt_tokens, completion_tokens, latency_ms, status)
      VALUES (${userId}, ${feature}, ${c.provider}, ${activeModel(c)}, ${promptChars}, ${completionChars}, ${pt ?? null}, ${ct ?? null}, ${latencyMs}, ${status})`);
  } catch (_) {}
}

export async function logTrainingExample(userId: string | null, feature: string, c: LlmConfig, system: string, messages: ChatMessage[], completion: string): Promise<void> {
  if (!c.captureTraining || !completion) return;
  try {
    await ensureLlmSchema();
    await db.execute(sql`INSERT INTO ai_training_example (user_id, feature, provider, model, system, messages, completion)
      VALUES (${userId}, ${feature}, ${c.provider}, ${activeModel(c)}, ${system.slice(0, 8000)}, ${JSON.stringify(messages).slice(0, 60000)}::jsonb, ${completion.slice(0, 20000)})`);
  } catch (_) {}
}

export async function underRateLimit(userId: string, max = 20, windowSec = 60): Promise<boolean> {
  try {
    await ensureLlmSchema();
    const r = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM ai_usage_log WHERE user_id = ${userId} AND created_at > NOW() - (${windowSec} || ' seconds')::interval`))[0];
    return Number(r?.n || 0) < max;
  } catch { return true; }
}

// ---- HTTP plumbing ----
function ownEndpoint(baseUrl: string): string { const b = baseUrl.replace(/\/+$/, ''); return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions'; }

async function ownStream(system: string, messages: ChatMessage[], c: LlmConfig, onToken: (t: string) => void, ctrl: AbortController): Promise<ChatResult> {
  const body = { model: c.model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], temperature: c.temperature, max_tokens: c.maxTokens, stream: true };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
  const res = await fetch(ownEndpoint(c.baseUrl), { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  if (!res.ok || !res.body) { const t = res.body ? await res.text().catch(() => '') : ''; return { ok: false, text: '', error: 'Model endpoint ' + res.status + ': ' + t.slice(0, 200) }; }
  return await pumpSSE(res.body, (j) => j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.text ?? '', onToken);
}

async function claudeStream(system: string, messages: ChatMessage[], c: LlmConfig, onToken: (t: string) => void, ctrl: AbortController): Promise<ChatResult> {
  // Anthropic Messages API. Opus 4.8/4.7 reject temperature — do not send it.
  const body: any = { model: c.claudeModel, max_tokens: c.maxTokens, messages, stream: true };
  if (system) body.system = system;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.claudeApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: ctrl.signal,
  });
  if (!res.ok || !res.body) { const t = res.body ? await res.text().catch(() => '') : ''; return { ok: false, text: '', error: 'Claude API ' + res.status + ': ' + t.slice(0, 200) }; }
  return await pumpSSE(res.body, (j) => (j?.type === 'content_block_delta' && j?.delta?.type === 'text_delta') ? (j.delta.text || '') : '', onToken);
}

async function pumpSSE(bodyStream: ReadableStream<Uint8Array>, extract: (j: any) => string, onToken: (t: string) => void): Promise<ChatResult> {
  const reader = bodyStream.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      try { const j = JSON.parse(data); const delta = extract(j); if (delta) { full += delta; onToken(delta); } } catch (_) {}
    }
  }
  return { ok: true, text: full };
}

export async function chatStream(system: string, messages: ChatMessage[], c: LlmConfig, onToken: (t: string) => void, signal?: AbortSignal): Promise<ChatResult> {
  if (!isReady(c)) return { ok: false, text: '', error: 'LLM not configured' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), c.timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());
  try {
    return c.provider === 'claude' ? await claudeStream(system, messages, c, onToken, ctrl) : await ownStream(system, messages, c, onToken, ctrl);
  } catch (e: any) {
    return { ok: false, text: '', error: e?.name === 'AbortError' ? 'Model timed out' : (e?.message || 'request failed') };
  } finally { clearTimeout(to); }
}

// Non-streaming (health check / test connection).
export async function chat(system: string, messages: ChatMessage[], c: LlmConfig): Promise<ChatResult> {
  if (!isReady(c)) return { ok: false, text: '', error: 'LLM not configured' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    if (c.provider === 'claude') {
      const body: any = { model: c.claudeModel, max_tokens: c.maxTokens, messages };
      if (system) body.system = system;
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': c.claudeApiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) return { ok: false, text: '', error: 'Claude API ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 200) };
      const j: any = await res.json();
      const text = (j?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { ok: true, text, promptTokens: j?.usage?.input_tokens, completionTokens: j?.usage?.output_tokens };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
    const res = await fetch(ownEndpoint(c.baseUrl), { method: 'POST', headers, body: JSON.stringify({ model: c.model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], temperature: c.temperature, max_tokens: c.maxTokens, stream: false }), signal: ctrl.signal });
    if (!res.ok) return { ok: false, text: '', error: 'Model endpoint ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 200) };
    const j: any = await res.json();
    return { ok: true, text: j?.choices?.[0]?.message?.content || '', promptTokens: j?.usage?.prompt_tokens, completionTokens: j?.usage?.completion_tokens };
  } catch (e: any) {
    return { ok: false, text: '', error: e?.name === 'AbortError' ? 'Model timed out' : (e?.message || 'request failed') };
  } finally { clearTimeout(to); }
}
