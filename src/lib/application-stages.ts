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

/**
 * WHERE A FUNNEL ACTUALLY ENDS — AND WHY THESE ARE NOW REAL STAGES RATHER THAN TWO BARE STRINGS.
 *
 * `TERMINAL_STAGES` was `['decision_no', 'withdrawn']` and NOTHING in src/ read it and NOTHING wrote
 * either value. So the six-step tracker a candidate is shown had no way to say "this is over": a
 * closed application kept rendering whichever open step it had last reached, with that step's
 * present-tense blurb. Worse, because stageIndex() falls back to 0 for a key it does not recognise,
 * the first person whose stage WAS set to a terminal key would have been shown "01 · Submitted —
 * your application is in our queue" about an application that had been closed.
 *
 * Both endings therefore carry a label and a sentence of their own, and everything that renders or
 * notifies looks a key up through stageDescriptor() rather than through STAGES alone.
 */
export const CLOSED_STAGES = [
  { key: 'decision_no', label: 'Closed',    short: 'Closed',    blurb: 'This application is closed. The written reason is in your application thread, and the decision is appealable.' },
  { key: 'withdrawn',   label: 'Withdrawn', short: 'Withdrawn', blurb: 'This application is no longer being taken forward at your request. Every other open role remains available to you.' },
] as const;

/** The key list this module has always exported, unchanged in shape for existing readers. */
export const TERMINAL_STAGES: string[] = CLOSED_STAGES.map((s) => s.key);

export type StageKey = typeof STAGES[number]['key'];
export type ClosedStageKey = typeof CLOSED_STAGES[number]['key'];

export function stageIndex(key: string): number {
  const i = STAGES.findIndex(s => s.key === key);
  return i >= 0 ? i : 0;
}

export function isTerminalStage(key: string): boolean {
  return TERMINAL_STAGES.indexOf(String(key || '')) >= 0;
}

/** The label + sentence for ANY stage key, open or closed. Null when the key is not one of ours. */
export function stageDescriptor(key: string): { key: string; label: string; short: string; blurb: string } | null {
  const k = String(key || '');
  const open = STAGES.find(s => s.key === k);
  if (open) return open;
  const closed = CLOSED_STAGES.find(s => s.key === k);
  return closed || null;
}

export function isKnownStage(key: string): boolean {
  return stageDescriptor(key) !== null;
}

/**
 * ONE MAP BETWEEN THE TWO COLUMNS THAT DESCRIBE THE SAME FUNNEL.
 *
 * `applications.status` is what the people desk sets on /admin/applications/[id]; `applications.stage`
 * is what the candidate is shown on /portal/applications/[id]. They were entirely independent: the
 * ONLY writers of `stage` in the whole repo were completeHire() (which writes 'onboarded') and the
 * talent-pool reopen. /api/admin/applications/advance-stage exists but has no caller on any page, so
 * in practice a candidate moved through review, assessment, interview and a rejection while their
 * tracker sat on "01 · Submitted — your application is in our queue".
 *
 * Pairs rather than a Record because this is imported into .astro files, where a typed
 * Record<string,string> in JSX breaks the compiler.
 */
const STATUS_STAGE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['submitted', 'submitted'],
  ['reviewing', 'review'],
  ['task_sent', 'assessment'],
  ['interview', 'interview'],
  ['offer', 'decision'],
  ['hired', 'onboarded'],
  ['rejected', 'decision_no'],
  ['withdrawn', 'withdrawn'],
];

/** The funnel stage an application status implies, or null for a status with no funnel meaning. */
export function stageForStatus(status: string): string | null {
  const hit = STATUS_STAGE_PAIRS.find(p => p[0] === String(status || ''));
  return hit ? hit[1] : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What advanceStage() answers. `changed` is false when the stage was already what was asked for. */
export type StageAdvanceResult = { ok: boolean; changed: boolean; error?: string };

export async function advanceStage(opts: { applicationId: string; toStage: string; actorUserId: string | null; actorName: string; note?: string }): Promise<StageAdvanceResult> {
  // IT REFUSES A STAGE IT DOES NOT KNOW, AND IT SAYS SO.
  //
  // This wrote whatever key it was handed straight into applications.stage. A typo, or a status this
  // module has never heard of, therefore landed a value that stageIndex() resolves to 0 — so the
  // candidate's tracker silently reset to "01 · Submitted" on an application that had moved on. The
  // caller is told rather than the column being corrupted, and the result is returned rather than
  // thrown so that a stage failure never rolls back the status change that prompted it.
  const target = stageDescriptor(opts.toStage);
  if (!target) {
    console.error('[application-stages] refused an unknown stage:', String(opts.toStage));
    return { ok: false, changed: false, error: '"' + String(opts.toStage) + '" is not a stage of the recruitment funnel, so nothing was changed.' };
  }
  await ensureStageSchema();
  // actor_user_id is a UUID column. It used to take whatever the caller passed, and an empty string
  // (which is what a system-driven advance has for an actor) fails the cast and takes the whole
  // stage advance down with it.
  const actor = UUID_RE.test(String(opts.actorUserId || '')) ? String(opts.actorUserId) : null;
  const cur = await db.execute(sql`SELECT stage FROM applications WHERE id = ${opts.applicationId} LIMIT 1`);
  const r = Array.isArray(cur) ? cur : ((cur as any)?.rows || []);
  const fromStage = r[0]?.stage || 'submitted';
  if (fromStage === opts.toStage) return { ok: true, changed: false };
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
    // stageDescriptor(), not STAGES.find(). An ENDING is the change a candidate most needs to hear
    // about, and the old lookup covered only the six open steps — so a closed or withdrawn
    // application would have moved with no notification at all.
    const stage = target;
    const who = await db.execute(sql`SELECT applicant_user_id FROM applications WHERE id = ${opts.applicationId} LIMIT 1`);
    const wRows = Array.isArray(who) ? who : ((who as any)?.rows || []);
    const applicantUserId = wRows[0]?.applicant_user_id;
    if (applicantUserId) {
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
  return { ok: true, changed: true };
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
