// One canonical, memoised schema-ensure for the notifications feed. The table
// pre-existed with a few columns; the Notification Center adds category /
// priority (classification), is_archived (archive instead of delete), and
// seen_at / clicked_at (delivery analytics). All additive + idempotent so it is
// safe to run on a live DB, and memoised so it costs one round-trip per process.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;

export function ensureNotificationsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, body TEXT,
        type TEXT NOT NULL DEFAULT 'info', action_url TEXT,
        entity_type TEXT, entity_id TEXT,
        is_read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
      await db.execute(sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category TEXT`);
      await db.execute(sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority TEXT`);
      await db.execute(sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false`);
      await db.execute(sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, is_read) WHERE is_read = false`);
    } catch (e: any) {
      // Dropped from the cache so the next call retries — and LOGGED with the real Postgres reason
      // (e.message is only the failed SQL). This is now the ONE CREATE of `notifications` in the
      // repository: four narrower copies used to sit in push.ts, both notifications-recent endpoints
      // and /aquintutor/notifications, and any of them could win the race on a fresh database and
      // leave the table without category/priority. If this ensure fails, the bell, the portal poll
      // and every reader go quiet together, so it may not fail silently.
      ready = null;
      console.error('[notifications-schema] ensure failed', e?.cause?.message || e?.message);
    }
  })();
  return ready;
}
