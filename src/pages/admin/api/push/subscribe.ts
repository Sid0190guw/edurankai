// src/pages/admin/api/push/subscribe.ts
// POST: saves a push subscription for the current user
// DELETE: removes a push subscription

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const body = await request.json();
    const { endpoint, keys } = body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid subscription data' }), { status: 400 });
    }

    const ua = request.headers.get('user-agent') || '';

    // Upsert: if same user + endpoint exists, update; otherwise insert
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
        userId: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: ua.substring(0, 300),
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 401 });

  try {
    const body = await request.json();
    if (body.endpoint) {
      await db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, body.endpoint)));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};
