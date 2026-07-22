// POST /api/kernel/cache/purge — Block 12: admin-only explicit cache purge (by object id).
// Audited via auditLog (action='cache.purge'). Content keys are version-addressed, so purging
// the head pointer is sufficient — the next reader re-derives from the system of record.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireCapability, ForbiddenError } from '@/lib/rbac';
import { createPgKernel } from '@/lib/kernel';
import { VirtualStorageManager, getKv } from '@/lib/vsm';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const purgeRequestSchema = z.object({
  objectId: z.string().uuid().optional(),
  all: z.boolean().optional(),
}).refine((v) => v.objectId || v.all, { message: 'objectId or all required' });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  try { await requireCapability(user, 'manage', { type: 'cache' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }

  let body: unknown; try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = purgeRequestSchema.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: parsed.error.issues[0]?.message || 'invalid body' }, 400);

  const vsm = new VirtualStorageManager(createPgKernel(), getKv());
  let purged = 0;
  if (parsed.data.objectId) { await vsm.invalidate(parsed.data.objectId); purged = 1; }
  // 'all' would require a namespace (keySchema) bump — deferred (see spec §7). objectId is the supported path.

  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: user.id, action: 'cache.purge', entity: 'kernel_objects', entityId: parsed.data.objectId, diff: { all: !!parsed.data.all } });
  } catch { /* audit best-effort */ }

  return j({ ok: true, purged });
};
