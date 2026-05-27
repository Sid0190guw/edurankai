// src/pages/admin/api/push/preferences.ts
// GET:  fetch current user's notification opt-out map { [type]: boolean }
// POST: merge a single toggle { type, enabled } into that map

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { notificationPreferences } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
  }
  try {
    const rows = await db.select().from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id)).limit(1);
    const map = (rows.length > 0 && rows[0].prefs && typeof rows[0].prefs === 'object') ? rows[0].prefs : {};
    return new Response(JSON.stringify({ ok: true, prefs: map }));
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
  }
  try {
    const body = await request.json();
    const type = String(body?.type || '').trim();
    if (!type) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing type' }), { status: 400 });
    }
    const enabled = body?.enabled !== false;

    const existing = await db.select().from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id)).limit(1);

    if (existing.length > 0) {
      const map: any = (existing[0].prefs && typeof existing[0].prefs === 'object') ? { ...existing[0].prefs } : {};
      map[type] = enabled;
      await db.update(notificationPreferences)
        .set({ prefs: map, updatedAt: new Date() })
        .where(eq(notificationPreferences.userId, user.id));
    } else {
      await db.insert(notificationPreferences).values({ userId: user.id, prefs: { [type]: enabled } as any });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};
