// GET /api/admin/visvambhara-access/thread?id=<requestId>
// Returns the full message thread for a single Vis-vambhara access request.
import type { APIRoute } from 'astro';
import { getThread } from '@/lib/request-threads';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // /admin/visvambhara-access is now mapped to the 'settings' section in middleware.ts PATH_SECTION,
  // matching what src/lib/admin-nav.ts has always declared for it. Passing the key here keeps the API
  // and the page on the same gate; canOpenAdmin still runs underneath.
  const denied = await denyAdminApi(locals, { section: 'settings', label: 'visvambhara-access.thread' });
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  // An empty thread and an unreadable one must not both render as "no messages".
  let messages;
  try {
    messages = await getThread('visvambhara_access', id);
  } catch (e: any) {
    console.error('[admin/visvambhara-access/thread] read failed:', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'temporarily unavailable' }, 503);
  }
  return json({ ok: true, messages });
};
