// GET /api/admin/notifications-recent
// Returns the current user's latest notifications for the bell dropdown.
// POST same path with { action: 'mark_read', id } marks one read.
// POST { action: 'mark_all_read' } clears the unread badge.
// POST { action: 'test' } inserts a test notification (proves the pipeline).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

// Memoise the DDL so we don't fire CREATE TABLE IF NOT EXISTS on every poll
// (every admin hits this endpoint every 15s — that DDL chatter keeps Neon awake
// and burns compute for nothing). One ensure per server process is enough.
let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, body TEXT,
        type TEXT NOT NULL DEFAULT 'info', action_url TEXT,
        entity_type TEXT, entity_id TEXT,
        is_read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
    } catch (_) { tableReady = null; }
  })();
  return tableReady;
}

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);
  await ensureTable();
  const list = rows(await db.execute(sql`
    SELECT id, title, body, type, action_url, is_read, created_at
    FROM notifications WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 10
  `));
  const unread = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${user.id} AND is_read = false`))[0]?.n || 0;
  return json({ ok: true, items: list, unread });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);
  let body: any = {}; try { body = await request.json(); } catch {}
  await ensureTable();
  if (body.action === 'mark_read' && body.id) {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ${body.id} AND user_id = ${user.id}`);
    return json({ ok: true });
  }
  if (body.action === 'mark_all_read') {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = ${user.id} AND is_read = false`);
    return json({ ok: true });
  }
  if (body.action === 'test') {
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url)
      VALUES (${user.id}, ${'Test notification'}, ${'If you can see this in the bell dropdown, the in-app feed is wired correctly. ' + new Date().toLocaleTimeString()}, ${'test'}, ${'/admin/notifications'})
    `);
    // Also try a push to confirm the browser channel
    try {
      const { sendPushToUser } = await import('@/lib/push');
      await sendPushToUser(user.id, {
        type: 'test',
        title: 'EduRankAI test notification',
        body: 'In-app + push delivery test.',
        url: '/admin/notifications',
        tag: 'admin-test',
      });
    } catch (_) {}
    return json({ ok: true });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
};
