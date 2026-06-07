// "Six steps. No surprises." — the policy commitment from /policy/recruitment.
// This is the canonical 6-step recruitment funnel surfaced to candidates in
// their portal and managed by admins on the application detail page.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;
export function ensureStageSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // Stage as a separate column on applications. Idempotent ALTER.
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage VARCHAR(40) NOT NULL DEFAULT 'submitted'`);
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ DEFAULT NOW()`);
      // Per-stage history (who advanced it, when, with what note)
      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_stage_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL,
        from_stage VARCHAR(40),
        to_stage VARCHAR(40) NOT NULL,
        actor_user_id UUID,
        actor_name VARCHAR(200),
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ase_app_idx ON application_stage_events(application_id, created_at ASC)`);
    } catch (_) {}
  })();
  return ready;
}

export const STAGES = [
  { key: 'submitted',   label: 'Submitted',          short: '01 · Submitted',     blurb: 'Your application is in our queue. We acknowledge every applicant individually.' },
  { key: 'review',      label: 'Under review',       short: '02 · Review',        blurb: 'A human reviewer is reading your profile + portfolio + waiver if any.' },
  { key: 'assessment',  label: 'Assessment',         short: '03 · Assessment',    blurb: 'You have been invited to a structured task assessed across 5 scoring dimensions.' },
  { key: 'interview',   label: 'Interview round',    short: '04 · Interview',     blurb: 'One-on-one with the hiring manager + at least one team member. We talk about work, not credentials.' },
  { key: 'decision',    label: 'Decision',           short: '05 · Decision',      blurb: 'Final yes or no, with a written explanation either way. Decisions are appealable.' },
  { key: 'onboarded',   label: 'Offer + onboarded',  short: '06 · Onboarded',     blurb: 'Offer signed, statutory enrolment complete, KRAs set, day one scheduled.' },
] as const;

export const TERMINAL_STAGES = ['decision_no', 'withdrawn'];

export type StageKey = typeof STAGES[number]['key'];

export function stageIndex(key: string): number {
  const i = STAGES.findIndex(s => s.key === key);
  return i >= 0 ? i : 0;
}

export async function advanceStage(opts: { applicationId: string; toStage: string; actorUserId: string; actorName: string; note?: string }) {
  await ensureStageSchema();
  const cur = await db.execute(sql`SELECT stage FROM applications WHERE id = ${opts.applicationId} LIMIT 1`);
  const r = Array.isArray(cur) ? cur : ((cur as any)?.rows || []);
  const fromStage = r[0]?.stage || 'submitted';
  await db.execute(sql`UPDATE applications SET stage = ${opts.toStage}, stage_updated_at = NOW(), updated_at = NOW() WHERE id = ${opts.applicationId}`);
  await db.execute(sql`
    INSERT INTO application_stage_events (application_id, from_stage, to_stage, actor_user_id, actor_name, note)
    VALUES (${opts.applicationId}, ${fromStage}, ${opts.toStage}, ${opts.actorUserId}, ${opts.actorName}, ${opts.note || null})
  `);
}

export async function getStageEvents(applicationId: string) {
  await ensureStageSchema();
  const r = await db.execute(sql`
    SELECT from_stage, to_stage, actor_name, note, created_at
    FROM application_stage_events WHERE application_id = ${applicationId}
    ORDER BY created_at ASC LIMIT 50
  `);
  return Array.isArray(r) ? r : ((r as any)?.rows || []);
}
