import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

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
