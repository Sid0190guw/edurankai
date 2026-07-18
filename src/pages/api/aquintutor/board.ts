// POST /api/aquintutor/board — teacher-board actions (Prompt A1). Faculty-gated (can write an
// AnimationObject — students, who only read/execute, cannot). 'ensure' seeds the template objects;
// 'fire' persists a fired instance linked to a KnowledgeObject. Every fire is audited. A2's speech
// trigger and A1b's broadcast call the SAME entry points.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { animationService, isTemplate } from '@/lib/animation';
import { fireBoardEvent } from '@/lib/board-session';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'write', { type: 'AnimationObject' });   // faculty+ only; audited
  if (!gate.allow) return j({ ok: false, error: 'only faculty can drive a board', reason: gate.reason }, 403);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'ensure') { const map = await animationService().ensureTemplates(); return j({ ok: true, templates: map }); }
    if (b.action === 'fire') {
      if (!isTemplate(String(b.templateId))) return j({ ok: false, error: 'unknown template' }, 400);
      const id = await animationService().createInstance(String(b.templateId), b.params || {}, b.koId ? String(b.koId) : null, user.id);
      let seq = 0;
      if (b.session) seq = await fireBoardEvent(String(b.session), { templateId: String(b.templateId), params: b.params || {}, playState: b.playState || 'playing', timelinePos: Number(b.timelinePos) || 0 }, String(user.id)).catch(() => 0);
      return j({ ok: true, instanceId: id, seq });   // seq>0 => broadcast to the live session
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
