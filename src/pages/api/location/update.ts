import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    const body = await request.json();
    const { lat, lon, accuracy } = body;
    if (!lat || !lon) return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } });

    await db.execute(sql`
      INSERT INTO user_locations (user_id, lat, lon, accuracy, updated_at)
      VALUES (${user.id}, ${lat}, ${lon}, ${accuracy||null}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET lat=${lat}, lon=${lon}, accuracy=${accuracy||null}, updated_at=NOW()
    `);

    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } });
  }
};
