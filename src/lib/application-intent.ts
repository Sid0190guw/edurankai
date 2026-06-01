// Pre-payment staging for applications.
// Step-6 writes the candidate's complete submission into application_intents
// (NOT applications) so the real `applications` table never carries an unpaid
// row. After Razorpay captures, payment-effects materialises the intent into
// a real applications row + deletes the intent.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let schemaReady: Promise<void> | null = null;
export function ensureApplicationIntentsSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_intents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id UUID REFERENCES roles(id) ON DELETE SET NULL,
        role_title_snapshot TEXT,
        department_snapshot TEXT,
        level TEXT,
        email VARCHAR(255),
        first_name VARCHAR(120),
        last_name VARCHAR(120),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS application_intents_user_idx ON application_intents(user_id, created_at DESC)`);
    } catch (_) {}
  })();
  return schemaReady;
}

function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export async function getIntent(intentId: string, userId: string): Promise<any | null> {
  await ensureApplicationIntentsSchema();
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM application_intents
      WHERE id = ${intentId} AND user_id = ${userId} LIMIT 1
    `));
    return r[0] || null;
  } catch (_) { return null; }
}
