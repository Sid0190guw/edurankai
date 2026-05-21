import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ count: 0 }), { headers: { 'Content-Type': 'application/json' } });
  try {
    const r = await db.execute(sql`SELECT COUNT(*)::int as n FROM notifications WHERE user_id = ${user.id} AND is_read = false`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    const count = Number((rows[0] as any)?.n) || 0;
    return new Response(JSON.stringify({ count }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e) {
    return new Response(JSON.stringify({ count: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }
};
