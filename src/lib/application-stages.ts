// "Six steps. No surprises." — the policy commitment from /policy/recruitment.
// This is the canonical 6-step recruitment funnel surfaced to candidates in
// their portal and managed by admins on the application detail page.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;

/**
 * THE GUARD NO LONGER SWALLOWS ITS OWN FAILURE.
 *
 * This was `try { ...DDL... } catch (_) {}` inside a memoised promise. If the ALTER for `stage` or the
 * CREATE for application_stage_events failed once — a permissions blip, a lock timeout — the promise
 * still resolved, was cached for the life of the process, and was never retried. Every stage read and
 * write afterwards then failed against a column that did not exist, with nothing recorded anywhere
 * saying why. That is precisely the shape the house rules forbid in a write path.
 *
 * Now: the real Postgres reason is logged, the memo is CLEARED so the next call tries again, and the
 * error is re-thrown for the caller to decide about.
 */
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
    } catch (e: any) {
      ready = null;
      console.error('[application-stages] schema:', e?.cause?.message || e?.message);
      throw e;
    }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function advanceStage(opts: { applicationId: string; toStage: string; actorUserId: string | null; actorName: string; note?: string }) {
  await ensureStageSchema();
  // actor_user_id is a UUID column. It used to take whatever the caller passed, and an empty string
  // (which is what a system-driven advance has for an actor) fails the cast and takes the whole
  // stage advance down with it.
  const actor = UUID_RE.test(String(opts.actorUserId || '')) ? String(opts.actorUserId) : null;
  const cur = await db.execute(sql`SELECT stage FROM applications WHERE id = ${opts.applicationId} LIMIT 1`);
  const r = Array.isArray(cur) ? cur : ((cur as any)?.rows || []);
  const fromStage = r[0]?.stage || 'submitted';
  if (fromStage === opts.toStage) return;
  await db.execute(sql`UPDATE applications SET stage = ${opts.toStage}, stage_updated_at = NOW(), updated_at = NOW() WHERE id = ${opts.applicationId}`);
  await db.execute(sql`
    INSERT INTO application_stage_events (application_id, from_stage, to_stage, actor_user_id, actor_name, note)
    VALUES (${opts.applicationId}, ${fromStage}, ${opts.toStage}, ${actor}, ${opts.actorName}, ${opts.note || null})
  `);

  // THE CANDIDATE IS TOLD. Their tracker page states "every status change appears in this thread",
  // and a stage advance used to put nothing in the thread and send no notification — so the six-step
  // tracker moved silently and only somebody who happened to re-open the page ever saw it. The stage
  // is already committed above; a notification failure must not report the advance as having failed,
  // but it is logged with the real Postgres reason rather than dropped.
  try {
    const stage = STAGES.find((s) => s.key === opts.toStage);
    const who = await db.execute(sql`SELECT applicant_user_id FROM applications WHERE id = ${opts.applicationId} LIMIT 1`);
    const wRows = Array.isArray(who) ? who : ((who as any)?.rows || []);
    const applicantUserId = wRows[0]?.applicant_user_id;
    if (applicantUserId && stage) {
      const { notifyUser } = await import('@/lib/notify');
      await notifyUser(String(applicantUserId), {
        title: 'Your application: ' + stage.label,
        body: stage.blurb,
        type: 'application',
        actionUrl: '/portal/applications/' + opts.applicationId,
        entityType: 'application',
        entityId: opts.applicationId,
      });
    }
  } catch (e: any) {
    console.error('[application-stages] the candidate was NOT told about stage', opts.toStage, '-', e?.cause?.message || e?.message);
  }
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
