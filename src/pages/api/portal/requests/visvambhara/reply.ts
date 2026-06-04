// POST /api/portal/requests/visvambhara/reply
// Body: { requestId, body, attachmentUrl? }
// Applicant-side reply on a Vis-vambhara access request thread.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { postMessage } from '@/lib/request-threads';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const requestId = (body.requestId || '').toString();
  const text = (body.body || '').toString();
  if (!requestId) return json({ ok: false, error: 'requestId required' }, 400);

  // Verify the request belongs to this user
  const req = rows(await db.execute(sql`SELECT id, user_id FROM visvambhara_access_requests WHERE id = ${requestId} LIMIT 1`))[0] as any;
  if (!req || req.user_id !== user.id) return json({ ok: false, error: 'request not found' }, 404);

  const r = await postMessage({
    requestType: 'visvambhara_access',
    requestId,
    applicantUserId: user.id,
    senderRole: 'applicant',
    senderUserId: user.id,
    senderName: user.name || user.email || 'Applicant',
    body: text,
    attachmentUrl: body.attachmentUrl || null,
  });
  return json(r, r.ok ? 200 : 400);
};
