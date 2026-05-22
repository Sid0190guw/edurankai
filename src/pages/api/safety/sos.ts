import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    const body = await request.json();
    const { lat, lon, accuracy, message, radiusM = 100 } = body;
    if (!lat || !lon) return new Response(JSON.stringify({ ok: false, error: 'No location' }), { headers: { 'Content-Type': 'application/json' } });

    // Find users who were within radiusM in last 10 minutes
    const nearbyResult = await db.execute(sql`
      SELECT ul.user_id, u.name, u.email, u.role,
        (6371000 * acos(
          cos(radians(${lat})) * cos(radians(ul.lat)) *
          cos(radians(ul.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(ul.lat))
        )) AS distance_m
      FROM user_locations ul
      JOIN users u ON ul.user_id = u.id
      WHERE ul.user_id != ${user.id}
        AND ul.updated_at >= NOW() - INTERVAL '10 minutes'
        AND (6371000 * acos(
          cos(radians(${lat})) * cos(radians(ul.lat)) *
          cos(radians(ul.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(ul.lat))
        )) <= ${radiusM}
      ORDER BY distance_m ASC LIMIT 20
    `);
    const nearby = Array.isArray(nearbyResult) ? nearbyResult : (nearbyResult?.rows || []);

    // Create SOS event
    const sosResult = await db.execute(sql`
      INSERT INTO sos_events (user_id, lat, lon, accuracy, message, nearby_users, status)
      VALUES (${user.id}, ${lat}, ${lon}, ${accuracy||null}, ${message||null}, ${JSON.stringify(nearby)}, 'active')
      RETURNING id
    `);
    const sosRows = Array.isArray(sosResult) ? sosResult : (sosResult?.rows || []);
    const sosId = (sosRows[0] as any)?.id;

    // Notify all admins
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type)
      SELECT id, 'SOS Alert - ' || ${user.name}, 'User triggered SOS at ' || ${new Date().toLocaleTimeString('en-IN')} || '. ' || ${nearby.length} || ' nearby users identified.', 'system'
      FROM users WHERE role IN ('super_admin','admin') AND is_active = true
    `);

    return new Response(JSON.stringify({ ok: true, sosId, nearbyCount: nearby.length, nearby }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
