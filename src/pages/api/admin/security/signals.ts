// GET/POST /api/admin/security/signals — Block 11: read + triage derived threat signals.
// Superadmin-gated (audit capability on the security surface); every call is audited by the guard.
import type { APIRoute } from 'astro';
import { authorizeRequest } from '@/lib/security';
import { listSignals, setSignalStatus } from '@/lib/security';
import { ForbiddenError } from '@/lib/rbac';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ request, locals }) => {
  try { await authorizeRequest(locals as any, 'audit', { type: 'security' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  const limit = Number(url.searchParams.get('limit')) || 100;
  return j({ ok: true, signals: await listSignals({ status, limit }) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try { await authorizeRequest(locals as any, 'audit', { type: 'security' }); }
  catch (e) { if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted', reason: e.decision.reason }, 403); throw e; }
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  if (!b.id || !['ack', 'dismissed'].includes(b.status)) return j({ ok: false, error: 'id + status(ack|dismissed) required' }, 400);
  await setSignalStatus(String(b.id), b.status);
  return j({ ok: true });
};
