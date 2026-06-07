// "How to Submit an Appeal" — backed product from /policy/recruitment.
// Appeals are NOT for fee waivers (no-appeal policy stands). They are for
// role-application decisions: rejection, scoring disputes, withdrawn offers.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;
export function ensureAppealsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_appeals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL,
        user_id UUID NOT NULL,
        appeal_kind VARCHAR(40) NOT NULL,
          -- decision | scoring | offer_withdrawn | other
        grounds TEXT NOT NULL,
        new_evidence TEXT,
        drive_url TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
          -- open | reviewing | upheld | denied | withdrawn
        decision_note TEXT,
        decided_by_user_id UUID,
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aa_user_idx ON application_appeals(user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aa_status_idx ON application_appeals(status, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_appeal_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appeal_id UUID NOT NULL REFERENCES application_appeals(id) ON DELETE CASCADE,
        sender_role VARCHAR(16) NOT NULL,
        sender_user_id UUID,
        sender_name VARCHAR(200),
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aam_app_idx ON application_appeal_messages(appeal_id, created_at ASC)`);
    } catch (_) {}
  })();
  return ready;
}

export const APPEAL_KINDS = {
  decision:         { label: 'Final decision (rejection)', description: 'The role decision was rejection and you believe the assessment was incomplete or biased.' },
  scoring:          { label: 'Scoring dispute',            description: 'You contest the per-dimension scoring on your assessment task.' },
  offer_withdrawn:  { label: 'Withdrawn offer',            description: 'An offer was withdrawn without due cause.' },
  other:            { label: 'Other',                      description: 'Anything else procedural or process-based.' },
};
