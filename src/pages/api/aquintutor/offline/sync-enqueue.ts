// POST /api/aquintutor/offline/sync-enqueue — on reconnect, the client posts the objects it
// changed offline; the server marks them synchronizationState=dirty and ENQUEUES them for the
// Prompt-7 sync engine. No merge/conflict resolution here (that is Prompt 7).
import type { APIRoute } from 'astro';
import { dirtyOnReconnect, enqueueDirty, type LocalChange } from '@/lib/offline-package';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const changes: LocalChange[] = Array.isArray(b.changes) ? b.changes.filter((c: any) => c && c.objectId).map((c: any) => ({ objectId: String(c.objectId), kind: c.kind === 'content' ? 'content' : 'progress', at: String(c.at || '') })) : [];
  if (!changes.length) return j({ ok: true, enqueued: 0 });
  try {
    const dirty = dirtyOnReconnect(changes);
    const n = await enqueueDirty(dirty.map((d) => d.objectId), user.id, 'offline');
    return j({ ok: true, enqueued: n });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
