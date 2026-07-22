// GET/POST /api/admin/security/keys — Block 11: key metadata (never material) + rotation.
import type { APIRoute } from 'astro';
import { authorizeRequest } from '@/lib/security';
import { listKeyMetadata, markRotating } from '@/lib/crypto';
import { ForbiddenError } from '@/lib/rbac';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ locals }) => {
  try { await authorizeRequest(locals as any, 'audit', { type: 'security' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }
  return j({ ok: true, keys: await listKeyMetadata() });   // metadata only — material stays in env
};

export const POST: APIRoute = async ({ request, locals }) => {
  try { await authorizeRequest(locals as any, 'configure', { type: 'security' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  if (b.op === 'rotate' && b.oldKeyId && b.newKeyId) {
    await markRotating(String(b.oldKeyId), String(b.newKeyId));
    return j({ ok: true });
  }
  return j({ ok: false, error: 'unknown op' }, 400);
};
