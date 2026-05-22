import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ nearby: [] }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get('lat') || '0');
    const lon = parseFloat(url.searchParams.get('lon') || '0');
    const radiusM = parseFloat(url.searchParams.get('radius') || '100');
    if (!lat || !lon) return new Response(JSON.stringify({ nearby: [] }), { headers: { 'Content-Type': 'application/json' } });

    // Haversine distance using postgres
    const r = await db.execute(sql`
      SELECT ul.user_id, u.name, u.role,
        (6371000 * acos(
          cos(radians(${lat})) * cos(radians(ul.lat)) *
          cos(radians(ul.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(ul.lat))
        )) AS distance_m,
        ul.updated_at
      FROM user_locations ul
      JOIN users u ON ul.user_id = u.id
      WHERE ul.user_id != ${user.id}
        AND ul.updated_at >= NOW() - INTERVAL '10 minutes'
        AND (6371000 * acos(
          cos(radians(${lat})) * cos(radians(ul.lat)) *
          cos(radians(ul.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(ul.lat))
        )) <= ${radiusM}
      ORDER BY distance_m ASC
      LIMIT 20
    `);
    const nearby = Array.isArray(r) ? r : (r?.rows || []);
    return new Response(JSON.stringify({ nearby }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ nearby: [], error: e.message }), { headers: { 'Content-Type': 'application/json' } });
  }
};
