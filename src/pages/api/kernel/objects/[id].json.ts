// GET /api/kernel/objects/[id].json?view=envelope|graph|rendered — Block 12: VSM-cached,
// conditional-GET object read. Emits ETag + the correct Cache-Control per security label;
// 304 on matching If-None-Match; 403 on a denied read (Zero-Trust); 404 if missing.
import type { APIRoute } from 'astro';
import { createPgKernel } from '@/lib/kernel';
import { VirtualStorageManager, VsmForbiddenError, getKv, getRequestMemo, type Principal, type CacheView } from '@/lib/vsm';

function j(d: any, s = 200, headers: Record<string, string> = {}) {
  return new Response(d == null ? '' : JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...headers } });
}
const VIEWS = new Set<CacheView>(['envelope', 'graph', 'rendered']);

export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = String(params.id || '');
  if (!id) return j({ ok: false, error: 'id required' }, 400);
  const url = new URL(request.url);
  const view = (VIEWS.has(url.searchParams.get('view') as CacheView) ? url.searchParams.get('view') : 'envelope') as CacheView;

  const user = (locals as any)?.user ?? null;
  let principal: Principal = { userId: user?.id ?? null, roles: [], isAdmin: false };
  try {
    const { resolvePrincipal } = await import('@/lib/rbac');
    const rp = await resolvePrincipal(user);
    principal = { userId: rp.userId, roles: rp.roles, isAdmin: rp.capabilities.has('administer'), enrolledCourseIds: [] };
  } catch { /* fall back to the minimal anonymous principal */ }

  const vsm = new VirtualStorageManager(createPgKernel(), getKv(), getRequestMemo(locals));
  let read;
  try { read = await vsm.readObject(id, view, principal); }
  catch (e) { if (e instanceof VsmForbiddenError) return j({ ok: false, error: 'forbidden' }, 403); throw e; }

  if (!read.object) return j({ ok: false, error: 'not found' }, 404);
  const headers = { ETag: read.etag, 'Cache-Control': read.cacheControl, 'X-VSM-Hit': read.hit };
  if (request.headers.get('if-none-match') === read.etag) return new Response(null, { status: 304, headers });
  return j(read.object, 200, headers);
};
