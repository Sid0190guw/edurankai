// POST /api/aquintutor/ask-aquin — streaming grounded tutor (Prompt 9). Access-scoped: the student
// must be able to read the current KO (can(read) + securityLabels); grounding is the KO + its
// PERMITTED, non-exam-secure prerequisites, in the student's language. Runs through the shared LLM
// gateway (admin-configured model/key — never hardcoded). Streams plain text; logs each turn.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { contentService } from '@/lib/kernel-content';
import { getSettings } from '@/lib/edu-runtime';
import { buildSystemPrompt, filterGrounding, logTutorTurn, type GroundingUnit } from '@/lib/ask-aquin';
import { getConfig, isReady, chatStream, logUsage, logTrainingExample, underRateLimit, type ChatMessage } from '@/lib/llm/gateway';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  if (!(await underRateLimit(user.id, 20, 60))) return j({ ok: false, error: 'Please slow down a moment and try again.' }, 429);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const koId = String(b.koId || '');
  const sessionId = String(b.sessionId || '') || (koId + ':' + user.id);
  const incoming: ChatMessage[] = Array.isArray(b.messages) ? b.messages.filter((m: any) => m && m.content).slice(-12).map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 6000) })) : [];
  if (!koId || !incoming.length) return j({ ok: false, error: 'koId + messages required' }, 400);

  const svc = contentService();
  const view = await svc.getUnitView(koId).catch(() => null);
  if (!view) return j({ ok: false, error: 'lesson not found' }, 404);
  const labels = (view.unit as any).securityLabels || ['public'];
  const gate = await can(user, 'read', { type: 'KnowledgeObject', securityLabels: labels });   // access-scoped + audited
  if (!gate.allow) return j({ ok: false, error: 'not permitted for this lesson' }, 403);
  const isStaff = (await can(user, 'write', { type: 'KnowledgeObject' })).allow;
  if (view.unit.lifecycleState !== 'published' && !isStaff) return j({ ok: false, error: 'lesson not available' }, 403);

  // grounding: current KO + permitted, non-exam-secure prerequisites (titles)
  const data: any = view.unit.data;
  const current: GroundingUnit = { id: view.unit.id, title: data.title, body: data.body, equations: data.equations, examples: data.examples, securityLabels: labels };
  const prereqUnits: GroundingUnit[] = [];
  for (const p of view.prerequisites) {
    const pv = await svc.getUnitView(p.id).catch(() => null);
    if (!pv) continue;
    const pl = (pv.unit as any).securityLabels || ['public'];
    if (!(await can(user, 'read', { type: 'KnowledgeObject', securityLabels: pl })).allow) continue;
    prereqUnits.push({ id: pv.unit.id, title: (pv.unit.data as any).title, securityLabels: pl });
  }
  const settings = await getSettings(user.id).catch(() => ({ language: 'en' } as any));
  const system = buildSystemPrompt({
    current: filterGrounding([current])[0] || current,
    courseTitle: view.courses[0]?.title || null,
    prereqTitles: filterGrounding(prereqUnits).map((u) => u.title),
    language: settings.language || 'en',
    studentName: user.name || 'the student',
  });

  const cfg = await getConfig();
  if (!isReady(cfg)) return j({ ok: false, error: 'The AI tutor is not switched on yet. Your coordinator can enable it in the admin panel.' }, 200);

  const lastUser = [...incoming].reverse().find((m) => m.role === 'user')?.content || '';
  const t0 = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let full = '';
      const onToken = (tok: string) => { full += tok; try { controller.enqueue(enc.encode(tok)); } catch { /* client gone */ } };
      let res;
      try { res = await chatStream(system, incoming, cfg, onToken, request.signal); }
      catch (e: any) { res = { ok: false, text: '', error: e?.message || 'error' }; }
      if (!res.ok && !full) controller.enqueue(enc.encode(res.error || 'The tutor is unavailable right now.'));
      try {
        await logTutorTurn(sessionId, user.id, koId, 'user', lastUser);
        await logTutorTurn(sessionId, user.id, koId, 'assistant', full || (res.error || ''));
        await logUsage(user.id, 'ask-aquin', cfg, system.length + lastUser.length, full.length, Date.now() - t0, res.ok ? 'ok' : 'error');
        await logTrainingExample(user.id, 'ask-aquin', cfg, system, incoming, full);
      } catch { /* best-effort */ }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } });
};
