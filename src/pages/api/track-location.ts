import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// EXAMINED AND NOT CONVERTED — NO CAPABILITY APPLIES; THE MISSING TEST IS ROW OWNERSHIP.
//
// `locals` is destructured and never read, so there is no authentication and no authorization, and
// /api/ has no structural gate. Anyone who supplies a session_id can overwrite the recorded latitude,
// longitude and street address on that analytics_sessions row — i.e. write a location onto somebody
// else's session, which is then read as if it were theirs.
//
// A capability cannot express "this caller owns this session"; that is a per-row fact. The fix is
// binding the write to the caller's own analytics session (or signing the session id), and it
// changes who may call the route, so it is reported for a human rather than shipped in a
// mechanism-only pass.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { sessionId, lat, lon, accuracy, address, suburb, district } = body;
    if (!sessionId || !lat || !lon) {
      return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } });
    }
    await db.execute(sql`
      UPDATE analytics_sessions SET
        lat = ${lat}, lon = ${lon}, accuracy = ${accuracy || null},
        address = ${address || null}, suburb = ${suburb || null},
        district = ${district || null}, location_updated_at = NOW()
      WHERE session_id = ${sessionId}
    `);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
