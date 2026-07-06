// Super-admin control plane for the own-LLM gateway.
//   GET  /api/admin/llm                 -> config (keys masked) + usage + training stats
//   GET  /api/admin/llm?export=jsonl    -> download training corpus as JSONL
//   POST /api/admin/llm {action:'save'} -> save config
//   POST /api/admin/llm {action:'test'} -> non-streaming health check
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { getConfig, saveConfig, chat, activeModel, ensureLlmSchema } from '@/lib/llm/gateway';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function mask(k: string): string { return k ? (k.slice(0, 4) + '••••' + k.slice(-4)) : ''; }
function isSuper(u: any): boolean { return !!u && u.role === 'super_admin'; }

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!isSuper(user)) return j({ error: 'forbidden' }, 403);
  await ensureLlmSchema();

  if (url.searchParams.get('export') === 'jsonl') {
    const ex = rows(await db.execute(sql`SELECT system, messages, completion FROM ai_training_example WHERE completion <> '' ORDER BY created_at DESC LIMIT 5000`));
    const lines = ex.map((r: any) => {
      let msgs: any[] = [];
      try { msgs = typeof r.messages === 'string' ? JSON.parse(r.messages) : (r.messages || []); } catch { msgs = []; }
      const example = { messages: [...(r.system ? [{ role: 'system', content: r.system }] : []), ...msgs, { role: 'assistant', content: r.completion }] };
      return JSON.stringify(example);
    }).join('\n');
    return new Response(lines, { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="aquin-training.jsonl"' } });
  }

  const cfg = await getConfig();
  const usage = rows(await db.execute(sql`SELECT provider, status, COUNT(*)::int AS n, COALESCE(SUM(completion_tokens),0)::int AS out_tokens FROM ai_usage_log WHERE created_at > NOW() - interval '7 days' GROUP BY provider, status`));
  const training = rows(await db.execute(sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > NOW() - interval '1 day')::int AS today FROM ai_training_example`))[0] || {};
  return j({
    ok: true,
    config: { ...cfg, apiKey: mask(cfg.apiKey), claudeApiKey: mask(cfg.claudeApiKey), apiKeySet: !!cfg.apiKey, claudeApiKeySet: !!cfg.claudeApiKey },
    usage, training: { total: Number(training.total || 0), today: Number(training.today || 0) },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!isSuper(user)) return j({ error: 'forbidden' }, 403);
  let b: any = {};
  try { b = await request.json(); } catch { return j({ error: 'bad json' }, 400); }

  if (b.action === 'save') {
    const c = b.config || {};
    const patch: any = {
      enabled: !!c.enabled, provider: c.provider === 'claude' ? 'claude' : 'own',
      baseUrl: (c.baseUrl || '').toString().slice(0, 500), model: (c.model || '').toString().slice(0, 120),
      claudeModel: (c.claudeModel || 'claude-opus-4-8').toString().slice(0, 120),
      maxTokens: Math.max(16, Math.min(8192, Number(c.maxTokens) || 512)),
      temperature: Math.max(0, Math.min(2, Number(c.temperature) || 0.4)),
      timeoutMs: Math.max(3000, Math.min(120000, Number(c.timeoutMs) || 30000)),
      systemPreamble: (c.systemPreamble || '').toString().slice(0, 4000),
      captureTraining: c.captureTraining !== false,
    };
    // Only overwrite secrets when a new value is explicitly provided (not the mask).
    if (typeof c.apiKey === 'string' && c.apiKey && !c.apiKey.includes('••')) patch.apiKey = c.apiKey.slice(0, 300);
    if (typeof c.claudeApiKey === 'string' && c.claudeApiKey && !c.claudeApiKey.includes('••')) patch.claudeApiKey = c.claudeApiKey.slice(0, 300);
    try { await saveConfig(patch); return j({ ok: true }); }
    catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'save failed' }, 500); }
  }

  if (b.action === 'test') {
    const cfg = await getConfig();
    const t0 = Date.now();
    const res = await chat('You are a connectivity probe.', [{ role: 'user', content: 'Reply with the single word: ready' }], { ...cfg, enabled: true, maxTokens: 16 });
    return j({ ok: res.ok, provider: cfg.provider, model: activeModel(cfg), latencyMs: Date.now() - t0, sample: (res.text || '').slice(0, 120), error: res.error });
  }

  return j({ error: 'unknown action' }, 400);
};
