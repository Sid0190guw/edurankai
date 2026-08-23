// One canonical, memoised schema-ensure for the notifications feed. The table
// pre-existed with a few columns; the Notification Center adds category /
// priority (classification), is_archived (archive instead of delete), and
// seen_at / clicked_at (delivery analytics). All additive + idempotent so it is
// safe to run on a live DB, and memoised so it costs one round-trip per process.
import { ensureBatch } from '@/lib/ensure-once';

// ONE round trip for all eight statements, not eight. "One round-trip per process" above was only
// ever true of the memo, not of the wire: the eight statements went out one at a time, and at ~139ms
// each that is ~1.1s of pure latency on every cold instance before the bell can read a row.
//
// Nothing is held out of the batch, and nothing had to be. Every statement is idempotent
// (CREATE TABLE / ADD COLUMN / CREATE INDEX ... IF NOT EXISTS); none was individually tolerated —
// the original had a single try/catch around the whole run, so a failure part-way already skipped
// everything after it; and no statement carries an interpolated value. Order is unchanged: the
// ALTERs and both indexes still follow the CREATE TABLE they depend on.
//
// A batch is one implicit transaction, so a failure now rolls the whole block back instead of
// leaving the earlier statements committed. That is harmless here because all eight are IF NOT
// EXISTS and the next call retries the lot.
const NOTIFICATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, body TEXT,
    type TEXT NOT NULL DEFAULT 'info', action_url TEXT,
    entity_type TEXT, entity_id TEXT,
    is_read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW());
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category TEXT;
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority TEXT;
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, is_read) WHERE is_read = false;
`;

// The memo moved from a module-local `ready` promise to ensureOnce (which ensureBatch runs on top
// of): same shape — the in-flight promise is shared, a failure is dropped from the cache so the next
// call retries, and the failure is LOGGED with the real Postgres reason (e.message is only the
// failed SQL). The logging is not a nicety. This is the ONE CREATE of `notifications` in the
// repository: four narrower copies used to sit in push.ts, both notifications-recent endpoints
// and /aquintutor/notifications, and any of them could win the race on a fresh database and
// leave the table without category/priority. If this ensure fails, the bell, the portal poll
// and every reader go quiet together, so it may not fail silently.
export function ensureNotificationsSchema(): Promise<void> {
  return ensureBatch('notifications_schema_v1', NOTIFICATIONS_DDL);
}
