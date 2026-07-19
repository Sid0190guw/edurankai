// POST /api/aquintutor/board — teacher-board actions (Prompt A1). Faculty-gated (can write an
// AnimationObject — students, who only read/execute, cannot). 'ensure' seeds the template objects;
// 'fire' persists a fired instance linked to a KnowledgeObject. Every fire is audited. A2's speech
// trigger and A1b's broadcast call the SAME entry points.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { animationService, isTemplate } from '@/lib/animation';
import { fireBoardEvent, markDetectionFired } from '@/lib/board-session';
import { sceneService, normalizeScene } from '@/lib/scene-spec';

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
      if (b.detectionId) await markDetectionFired(Number(b.detectionId)).catch(() => {});   // speech-fired (A2)
      return j({ ok: true, instanceId: id, seq });   // seq>0 => broadcast to the live session
    }
    if (b.action === 'save-scene') {
      const { spec, issues } = normalizeScene(b.spec);   // validate + repair before persisting
      const sceneId = await sceneService().saveScene(spec, b.koId ? String(b.koId) : null, String(user.id));
      return j({ ok: true, sceneId, issues });
    }
    if (b.action === 'fire-ink') {
      // physical-board (A4) or pen ink: broadcast VECTOR strokes only. Reject anything image-like.
      const strokes = Array.isArray(b.strokes) ? b.strokes.slice(0, 400).map((s: any) => Array.isArray(s) ? s.slice(0, 400).map((p: any) => [Number(p[0]) || 0, Number(p[1]) || 0]) : []).filter((s: any) => s.length) : [];
      let seq = 0;
      if (b.session) seq = await fireBoardEvent(String(b.session), { templateId: 'ink', params: { strokes, source: b.source === 'physical' ? 'physical' : 'pen' }, playState: 'static', timelinePos: 0 }, String(user.id)).catch(() => 0);
      return j({ ok: true, seq, strokes: strokes.length });   // structured vectors, never pixels/video
    }
    if (b.action === 'fire-scene') {
      const { spec } = normalizeScene(b.spec);            // validate + repair before broadcast
      let sceneId: string | undefined;
      if (b.save) sceneId = await sceneService().saveScene(spec, b.koId ? String(b.koId) : null, String(user.id)).catch(() => undefined);
      let seq = 0;
      // broadcast over the A1b channel: the SPEC rides in params.scene (structured JSON, NOT pixels)
      if (b.session) seq = await fireBoardEvent(String(b.session), { templateId: 'scene', params: { scene: spec }, playState: 'playing', timelinePos: 0 }, String(user.id)).catch(() => 0);
      return j({ ok: true, seq, sceneId, objects: spec.objects.length });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
