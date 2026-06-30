// GET /api/offline/mine — the signed-in user's synced work (to confirm what
// reached the server). Local IndexedDB still holds anything not yet synced.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOfflineSchema } from './sync';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try {
    await ensureOfflineSchema();
    const rows = rowsOf(await db.execute(sql`SELECT client_id, kind, payload, created_at, synced_at FROM offline_work WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 100`));
    return json({ ok: true, records: rows });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Failed' }, 500);
  }
};
