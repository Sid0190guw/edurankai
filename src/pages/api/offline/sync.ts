// POST /api/offline/sync  { records: [{ clientId, kind, data, createdAt }, ...] }
// Receives work captured offline and stores it so it appears in the admin panel.
// Idempotent on client_id so replays (flaky networks) never duplicate.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

let ensured = false;
export async function ensureOfflineSchema() {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS offline_work (
    client_id text PRIMARY KEY,
    user_id uuid,
    kind text,
    payload jsonb,
    created_at timestamptz,
    synced_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS offline_work_user_idx ON offline_work(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS offline_work_kind_idx ON offline_work(kind)`);
  ensured = true;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let records: any[] = [];
  try { records = (await request.json())?.records || []; } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  if (!Array.isArray(records)) return json({ ok: false, error: 'Bad request' }, 400);
  try {
    await ensureOfflineSchema();
    let n = 0;
    for (const r of records.slice(0, 200)) {
      if (!r || !r.clientId) continue;
      try {
        await db.execute(sql`INSERT INTO offline_work (client_id, user_id, kind, payload, created_at)
          VALUES (${String(r.clientId)}, ${user.id}, ${String(r.kind || 'work').slice(0, 80)}, ${JSON.stringify(r.data || {})}::jsonb, ${r.createdAt ? new Date(r.createdAt) : new Date()})
          ON CONFLICT (client_id) DO NOTHING`);
        n++;
      } catch (_) {}
    }
    return json({ ok: true, synced: n });
  } catch (e: any) {
    return json({ ok: false, error: e?.cause?.message || e?.message || 'Sync failed' }, 500);
  }
};
