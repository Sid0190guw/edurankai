// GET /api/admin/fee-waivers/thread?id=<requestId>
import type { APIRoute } from 'astro';
import { getThread } from '@/lib/request-threads';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Reads an applicant's hardship statement. No fee-waiver section key exists; see
  // generate-coupon.ts. The gate runs before getThread(), never after it.
  const denied = await denyAdminApi(locals, { label: 'fee-waivers.thread' });
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  const messages = await getThread('fee_waiver', id);
  return json({ ok: true, messages });
};
