import type { APIRoute } from 'astro';
import { listVersions, saveVersion, restoreVersion } from '@/lib/aquintutor-authoring';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// GET  -> list versions for a lesson
export const GET: APIRoute = async ({ locals, params }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  try { return json({ ok: true, versions: await listVersions(id) }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};

// POST { action: 'save' }                  -> snapshot current blocks as a new version
// POST { action: 'restore', versionId }    -> restore a version (auto-snapshots current first)
export const POST: APIRoute = async ({ locals, params, request }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  let body: any = {};
  try { body = await request.json(); } catch { /* allow empty */ }
  const byName = user.name || user.email;
  try {
    if (body.action === 'restore') {
      if (!body.versionId) return json({ ok: false, error: 'versionId required' }, 400);
      const blocks = await restoreVersion({ lessonId: id, versionId: body.versionId, byUserId: user.id, byName });
      return json({ ok: true, blocks });
    }
    const saved = await saveVersion({ lessonId: id, byUserId: user.id, byName, notes: body.notes || 'Manual save' });
    return json({ ok: true, saved });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
