// POST /api/portal/requests/fee-waiver/reply
// Applicant-side reply on a fee waiver thread.
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
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role !== 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const id = (body.requestId || '').toString();
  const text = (body.body || '').toString().trim();
  if (!id || !text) return json({ ok: false, error: 'missing fields' }, 400);
  if (text.length > 5000) return json({ ok: false, error: 'message too long' }, 400);

  const r = rows(await db.execute(sql`SELECT id FROM application_fee_waivers WHERE id = ${id} AND user_id = ${user.id} LIMIT 1`));
  if (!r[0]) return json({ ok: false, error: 'not found' }, 404);

  await postMessage({
    requestType: 'fee_waiver',
    requestId: id,
    applicantUserId: user.id,
    senderRole: 'applicant',
    senderUserId: user.id,
    senderName: user.name || user.email,
    body: text,
  });
  return json({ ok: true });
};
