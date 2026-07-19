// POST /api/aquintutor/vod — Recording & VOD (Prompt AP1a). Faculty snapshot a live session's SPEC
// timeline into a VOD asset (kernel AnimationObject, securityLabels-gated, linked to a course/KO);
// list/publish are role-gated. Replay re-renders the timeline at the viewer's tier (AP1b) — the
// recording is specs, not baked pixels. Media (audio/video) rides the storage interface when present.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { vodService, broadcastSession } from '@/lib/vod';
import { storageProvisioned } from '@/lib/storage';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }

  try {
    if (b.action === 'record') {
      const gate = await can(user, 'write', { type: 'AnimationObject' });   // faculty record
      if (!gate.allow) return j({ ok: false, error: 'only faculty can record' }, 403);
      const session = b.broadcastId ? broadcastSession(String(b.broadcastId)) : String(b.sessionId || '');
      if (!session) return j({ ok: false, error: 'no session to record' }, 400);
      const labels = Array.isArray(b.labels) && b.labels.length ? b.labels : ['enrolled-only'];
      const id = await vodService().record(session, { title: String(b.title || 'Recording'), linkId: b.linkId ? String(b.linkId) : null, owner: String(user.id), labels, mediaUrl: b.mediaUrl || null });
      return j({ ok: true, id, storageProvisioned: storageProvisioned() });
    }
    if (b.action === 'publish') {
      const gate = await can(user, 'write', { type: 'AnimationObject' });
      if (!gate.allow) return j({ ok: false, error: 'faculty only' }, 403);
      await vodService().setPublished(String(b.id), !!b.on);
      return j({ ok: true });
    }
    if (b.action === 'list') {
      const faculty = (await can(user, 'write', { type: 'AnimationObject' })).allow;
      const list = await vodService().list(!faculty);   // students see only published
      return j({ ok: true, list, storageProvisioned: storageProvisioned() });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
