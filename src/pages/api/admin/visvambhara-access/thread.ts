// GET /api/admin/visvambhara-access/thread?id=<requestId>
// Returns the full message thread for a single Vis-vambhara access request.
import type { APIRoute } from 'astro';
import { getThread } from '@/lib/request-threads';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // /admin/visvambhara-access is absent from PATH_SECTION, so no section key exists to convert to.
  // canOpenAdmin is the gate the page already has and the one /api/* was missing.
  const denied = await denyAdminApi(locals, { label: 'visvambhara-access.thread' });
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  const messages = await getThread('visvambhara_access', id);
  return json({ ok: true, messages });
};
