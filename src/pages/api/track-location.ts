// POST /api/track-location — attach a coordinate to the caller's OWN analytics session.
//
// =================================================================================================
// THIS ROUTE USED TO LET ANYONE WRITE A LOCATION ONTO ANYBODY ELSE'S SESSION
// =================================================================================================
//
// `locals` was destructured and never read, and /api/ is exempt from the middleware gate
// (src/middleware.ts), so there was no authentication and no authorization on the whole file. The
// statement matched on `session_id` alone — a value the browser generates and keeps in
// sessionStorage, so it is guessable, sharable, and never proved to belong to whoever sent it.
//
// The consequence was not a leak but a FORGERY: post somebody else's session id with any latitude
// and longitude, and the admin location trail then shows that person where you said they were. A
// map read as a record of where staff have been is worth nothing if any caller can write to it, and
// worse than nothing if somebody believes it.
//
// A capability cannot express "this caller owns this row" — that is a per-row fact, which is why the
// mechanism-only pass that converted the rest of /api/ left this one alone and reported it instead.
//
// THE TEST IS OWNERSHIP, AND analytics_sessions ALREADY RECORDS IT. /api/track.ts writes `user_id`
// from the signed-in user when it opens the row, so the honest match is session AND owner. The only
// caller in the product is the GPS block on /admin/analytics, which is behind a login — so nothing
// that legitimately used this route loses anything.
//
// A session whose owner is NULL is an anonymous visitor. Those are not writable here at all: there
// is no principal to compare against, and "no owner" must never read as "anyone".
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

/** Reject a coordinate that is not one, rather than storing it and drawing it later. */
function coord(v: unknown, limit: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const sessionId = String(body?.sessionId || '').trim().slice(0, 128);
  const lat = coord(body?.lat, 90);
  const lon = coord(body?.lon, 180);
  if (!sessionId || lat === null || lon === null) return json({ ok: false, error: 'sessionId, lat and lon required' }, 400);

  const accuracy = Number.isFinite(Number(body?.accuracy)) ? Number(body.accuracy) : null;
  const text = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

  try {
    const r = await db.execute(sql`
      UPDATE analytics_sessions SET
        lat = ${lat}, lon = ${lon}, accuracy = ${accuracy},
        address = ${text(body?.address, 300)}, suburb = ${text(body?.suburb, 120)},
        district = ${text(body?.district, 120)}, location_updated_at = NOW()
      WHERE session_id = ${sessionId} AND user_id = ${String(user.id)}
      RETURNING session_id`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    // Nothing matched: the session is somebody else's, anonymous, or gone. Say so plainly rather
    // than answering ok — a silent no-op here is what let the forgery go unnoticed.
    if (!rows.length) return json({ ok: false, error: 'that session is not yours' }, 403);
    return json({ ok: true });
  } catch (e: any) {
    // The real Postgres reason lives on e.cause; e.message is only the failed SQL.
    console.error('[track-location] update failed:', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'could not record location' }, 500);
  }
};
