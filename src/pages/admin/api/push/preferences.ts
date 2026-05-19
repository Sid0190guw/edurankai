// src/pages/admin/api/push/preferences.ts
// GET: fetch current user's notification preferences
// POST: update preferences

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
    const prefs = await db.select().from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id)).limit(1);
    if (prefs.length === 0) {
      // Return defaults
      return new Response(JSON.stringify({
        ok: true, prefs: {
          notifyChat: true, notifyNewApplication: true,
          notifyApplicationStatus: true, notifyNewHeiSubmission: true,
          notifyNewUser: true, notifyOfferSigned: true
        }
      }));
    }
    return new Response(JSON.stringify({ ok: true, prefs: prefs[0] }));
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
    const update = {
      notifyChat: body.notifyChat !== false,
      notifyNewApplication: body.notifyNewApplication !== false,
      notifyApplicationStatus: body.notifyApplicationStatus !== false,
      notifyNewHeiSubmission: body.notifyNewHeiSubmission !== false,
      notifyNewUser: body.notifyNewUser !== false,
      notifyOfferSigned: body.notifyOfferSigned !== false,
      updatedAt: new Date()
    };
    const existing = await db.select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id)).limit(1);
    if (existing.length > 0) {
      await db.update(notificationPreferences).set(update)
        .where(eq(notificationPreferences.userId, user.id));
    } else {
      await db.insert(notificationPreferences).values({ userId: user.id, ...update });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};
