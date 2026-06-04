// GET /api/admin/visvambhara-access/thread?id=<requestId>
// Returns the full message thread for a single Vis-vambhara access request.
import type { APIRoute } from 'astro';
import { getThread } from '@/lib/request-threads';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  const messages = await getThread('visvambhara_access', id);
  return json({ ok: true, messages });
};
