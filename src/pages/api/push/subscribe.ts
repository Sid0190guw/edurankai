// POST /api/push/subscribe - save a push subscription for the current user
// (applicant OR admin). Mirrors /admin/api/push/subscribe but un-gates role.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const { endpoint, keys } = body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return json({ ok: false, error: 'Invalid subscription data' }, 400);
    }
    const ua = (request.headers.get('user-agent') || '').slice(0, 300);

    const existing = await db.select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)))
      .limit(1);

    if (existing.length > 0) {
      await db.update(pushSubscriptions)
        .set({ p256dh: keys.p256dh, auth: keys.auth, lastUsedAt: new Date() })
        .where(eq(pushSubscriptions.id, existing[0].id));
    } else {
      await db.insert(pushSubscriptions).values({
        userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: ua,
      });
    }
    return json({ ok: true });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, 500);
  }
};
