import type { APIRoute } from 'astro';
import { logBatch, logActivity } from '@/lib/activity-log';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// Accepts a single event or a batch. Auth-optional: anonymous applicants log too,
// but we stamp the signed-in user id when present.
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const stamp = (e: any) => ({
    userId: user?.id || e.userId || null,
    sessionId: String(e.sessionId || body.sessionId || 'anon'),
    stage: e.stage || body.stage,
    refId: e.refId || body.refId,
    type: String(e.type || 'event').slice(0, 40),
    severity: e.severity,
    minuteBucket: e.minuteBucket,
    detail: String(e.detail || '').slice(0, 4000),
    clientTs: e.clientTs,
  });

  try {
    if (Array.isArray(body.events)) {
      const n = await logBatch(body.events.map(stamp));
      return json({ ok: true, logged: n });
    }
    await logActivity(stamp(body));
    return json({ ok: true, logged: 1 });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 160) }, 500);
  }
};
