// src/lib/referrals.ts — THE EMPLOYEE REFERRAL PROGRAMME.
//
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
//
// The applicant tracking system already exists: `applications`, its six-step funnel
// (src/lib/application-stages.ts), interview rounds, offers, and the applicant-to-employee path in
// src/lib/hire-transfer.ts. NONE of it is rebuilt here. This module adds the one thing that was
// absent — an employee saying "I know somebody who should apply" — and then TRACKS that referral
// against the application the candidate files, rather than keeping a second copy of the pipeline.
//
// THE ONE RULE THAT DECIDES THE SHAPE OF THIS FILE: A REWARD IS NEVER PAID FROM HERE.
//
// Recording that a referral is reward-eligible is a NOTE. Money moving is an APPROVAL, and this
// codebase has exactly one approval engine — src/lib/workflow.ts. So `sendRewardForApproval()` opens
// a workflow instance in the `recruitment` domain and stops. There is no branch anywhere in this
// file that marks a reward approved, and there is no fallback that approves it when routing fails:
// when the Organization Graph cannot name an approver, startWorkflow() returns a HALTED instance
// carrying the reason, and this module stores that reason and shows it. A referral bonus that pays
// itself because nobody could be found to sign it off is the exact failure the workflow engine was
// built to make impossible.
//
// WHY THE `recruitment` DOMAIN, AND WHY THE RECORD ID IS NAMESPACED. `recruitment` is already a
// declared domain with a real chain (department head, then the approval owner if the organisation
// has named one). Adding a `referral` domain would be a policy invention inside a module that has no
// business making one. The record id is written as `referral-reward:<uuid>` so it cannot collide with
// any other recruitment-domain record on the (domain, record_id) unique index — the same namespacing
// precedent workflow.ts states for appraisal-driven promotions.
//
// DOCUMENTS ARE DRIVE LINKS. `cv_drive_url` is a URL and nothing is ever uploaded, by standing rule.
// The referrer is told to share it so anyone with the link can open it, because a link nobody can
// open is worse than no link.
//
// NO COUNTRY OR NATIONALITY IS READ, STORED OR FILTERED ON ANYWHERE IN THIS FILE.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { startWorkflow, getInstance } from '@/lib/workflow';

// Declared BEFORE anything that uses them. `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** The real Postgres reason lives on e.cause; e.message is only the SQL that failed. */
function why(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** The workflow domain and the record-id prefix a referral reward is routed under. */
export const REWARD_DOMAIN = 'recruitment' as const;
export const REWARD_RECORD_PREFIX = 'referral-reward:';

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * How the referrer knows the candidate. A closed list, because free text here becomes unsearchable
 * within a month and because "how do you know them" is the one answer that makes a referral worth
 * more than a cold application.
 */
export const REFERRAL_RELATIONSHIPS = [
  { key: 'worked_together', label: 'Worked together' },
  { key: 'studied_together', label: 'Studied together' },
  { key: 'taught_or_mentored', label: 'I taught or mentored them' },
  { key: 'community', label: 'Know them from a community or group' },
  { key: 'family_or_friend', label: 'Family member or personal friend' },
  { key: 'other', label: 'Other' },
] as const;

// Typed as Set<string>, deliberately: the members are a literal union, and a Set of that union
// refuses `.has(someString)` at compile time — which would push every caller into a cast and turn a
// validation helper into a type-assertion helper. Widening it HERE keeps the one place that decides
// whether an arbitrary string is a known relationship honest.
const RELATIONSHIP_KEYS: Set<string> = new Set(REFERRAL_RELATIONSHIPS.map((r) => String(r.key)));

export function relationshipLabel(key: string): string {
  const hit = REFERRAL_RELATIONSHIPS.find((r) => r.key === key);
  return hit ? hit.label : 'Not recorded';
}

/**
 * The referral's OWN state. Distinct from the candidate's application status, which is read from
 * `applications` and never copied here — two copies of one fact disagree, and the one nobody is
 * looking at is always the stale one.
 */
export const REFERRAL_STATES = ['submitted', 'linked', 'not_applied', 'withdrawn'] as const;
export type ReferralState = (typeof REFERRAL_STATES)[number];

export const REFERRAL_STATE_LABELS = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'linked', label: 'Application received' },
  { key: 'not_applied', label: 'Closed without an application' },
  { key: 'withdrawn', label: 'Withdrawn by the referrer' },
] as const;

export function referralStateLabel(key: string): string {
  const hit = REFERRAL_STATE_LABELS.find((s) => s.key === key);
  return hit ? hit.label : 'Submitted';
}

/**
 * WHERE THE REWARD HAS GOT TO. Read the values as a sentence and note what is missing:
 *
 *   none        nobody has said this referral earns anything.
 *   eligible    recorded as eligible, with an amount. NOT approved and NOT payable.
 *   in_approval a workflow instance is live and somebody owes a decision.
 *   halted      the workflow could not name an approver. Carries the reason. NOT approved.
 *   approved    the workflow approved it. STILL NOT PAID — payment is a separate act in the payouts
 *               console, by whoever holds payouts.pay, against a person the finance team can name.
 *   rejected    the workflow refused it.
 *
 * There is deliberately NO `paid` value. This module does not move money and must not appear to.
 */
export const REWARD_STATES = ['none', 'eligible', 'in_approval', 'halted', 'approved', 'rejected'] as const;
export type RewardState = (typeof REWARD_STATES)[number];

export const REWARD_STATE_LABELS = [
  { key: 'none', label: 'No reward recorded' },
  { key: 'eligible', label: 'Eligible, not yet sent for approval' },
  { key: 'in_approval', label: 'Waiting for approval' },
  { key: 'halted', label: 'Halted: no approver could be resolved' },
  { key: 'approved', label: 'Approved for payout' },
  { key: 'rejected', label: 'Rejected' },
] as const;

export function rewardStateLabel(key: string): string {
  const hit = REWARD_STATE_LABELS.find((s) => s.key === key);
  return hit ? hit.label : 'No reward recorded';
}

/**
 * The coarse sentence a REFERRER is allowed to read about their candidate.
 *
 * APPLICANT-FACING HONESTY, APPLIED TO THE REFERRER TOO. A referrer is not the hiring team. They see
 * where the application has got to and nothing else: no reviewer comments, no internal notes, no
 * scores, no rejection reason, no approval history. This function is the ONLY translation from an
 * application status to something a referrer sees, so there is one place to check that rule.
 */
export function referrerVisibleStatus(applicationStatus: string | null, referralState: string): string {
  if (!applicationStatus) {
    if (referralState === 'withdrawn') return 'Withdrawn';
    if (referralState === 'not_applied') return 'Closed without an application';
    return 'Waiting for them to apply';
  }
  switch (applicationStatus) {
    case 'submitted':
      return 'Application received';
    case 'reviewing':
      return 'Under review';
    case 'task_sent':
      return 'In assessment';
    case 'interview':
      return 'In interviews';
    case 'offer':
      return 'At offer stage';
    case 'hired':
      return 'Joined';
    case 'rejected':
      return 'Closed';
    case 'withdrawn':
      return 'Withdrawn by the candidate';
    default:
      return 'In progress';
  }
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

/**
 * ONE table, created ONCE per process, and grepped for before it was written: nothing anywhere in
 * src/ or db/ declares a referral table, so this is not a second shape for an existing one.
 *
 * No foreign keys are declared against `applications`, `users` or `hr_employees`. That is not
 * laziness: this DDL is self-bootstrapping and runs against a live database whose tables were
 * created by hand-run scripts in an order this file cannot know. A referral that fails to insert
 * because a constraint could not be validated is a referral nobody ever hears about again. The ids
 * are validated in code instead, which is where a readable refusal can be produced.
 */
export function ensureReferralSchema(): Promise<void> {
  return ensureOnce('recruitment_referrals_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS recruitment_referrals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_user_id UUID NOT NULL,
      referrer_employee_id UUID,
      referrer_name VARCHAR(200),
      candidate_name VARCHAR(200) NOT NULL,
      candidate_email VARCHAR(255) NOT NULL,
      candidate_phone VARCHAR(50),
      role_id UUID,
      role_title VARCHAR(200),
      relationship VARCHAR(40) NOT NULL DEFAULT 'other',
      note TEXT,
      cv_drive_url TEXT,
      application_id UUID,
      linked_at TIMESTAMPTZ,
      state VARCHAR(20) NOT NULL DEFAULT 'submitted',
      reward_amount NUMERIC(12,2),
      reward_currency VARCHAR(8),
      reward_note TEXT,
      reward_state VARCHAR(20) NOT NULL DEFAULT 'none',
      reward_recorded_by UUID,
      reward_recorded_at TIMESTAMPTZ,
      reward_halt_reason TEXT,
      workflow_instance_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rr_referrer_idx ON recruitment_referrals(referrer_user_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rr_email_idx ON recruitment_referrals(lower(candidate_email))`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rr_app_idx ON recruitment_referrals(application_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rr_reward_idx ON recruitment_referrals(reward_state, created_at DESC)`);
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES THE PAGES SEE
// -------------------------------------------------------------------------------------------------

export interface ReferralRow {
  id: string;
  referrerUserId: string;
  referrerEmployeeId: string | null;
  referrerName: string | null;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string | null;
  roleId: string | null;
  roleTitle: string | null;
  relationship: string;
  note: string | null;
  cvDriveUrl: string | null;
  applicationId: string | null;
  state: string;
  rewardAmount: number | null;
  rewardCurrency: string | null;
  rewardNote: string | null;
  rewardState: string;
  rewardHaltReason: string | null;
  workflowInstanceId: string | null;
  createdAt: string | null;
  /** Joined from `applications`, never stored here. Null when no application is linked yet. */
  applicationStatus: string | null;
  applicationStage: string | null;
  applicationNumber: string | null;
}

export type WriteResult = { ok: true; id?: string; message?: string } | { ok: false; error: string };

function mapRow(r: any): ReferralRow {
  return {
    id: String(r?.id ?? ''),
    referrerUserId: String(r?.referrer_user_id ?? ''),
    referrerEmployeeId: r?.referrer_employee_id ? String(r.referrer_employee_id) : null,
    referrerName: r?.referrer_name ? String(r.referrer_name) : null,
    candidateName: String(r?.candidate_name ?? ''),
    candidateEmail: String(r?.candidate_email ?? ''),
    candidatePhone: r?.candidate_phone ? String(r.candidate_phone) : null,
    roleId: r?.role_id ? String(r.role_id) : null,
    roleTitle: r?.role_title ? String(r.role_title) : null,
    relationship: String(r?.relationship ?? 'other'),
    note: r?.note ? String(r.note) : null,
    cvDriveUrl: r?.cv_drive_url ? String(r.cv_drive_url) : null,
    applicationId: r?.application_id ? String(r.application_id) : null,
    state: String(r?.state ?? 'submitted'),
    rewardAmount: r?.reward_amount === null || r?.reward_amount === undefined ? null : Number(r.reward_amount),
    rewardCurrency: r?.reward_currency ? String(r.reward_currency) : null,
    rewardNote: r?.reward_note ? String(r.reward_note) : null,
    rewardState: String(r?.reward_state ?? 'none'),
    rewardHaltReason: r?.reward_halt_reason ? String(r.reward_halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    applicationStatus: r?.application_status ? String(r.application_status) : null,
    applicationStage: r?.application_stage ? String(r.application_stage) : null,
    applicationNumber: r?.application_number ? String(r.application_number) : null,
  };
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface SubmitReferralInput {
  referrerUserId: string;
  referrerName?: string | null;
  candidateName: string;
  candidateEmail: string;
  candidatePhone?: string | null;
  roleId?: string | null;
  roleTitle?: string | null;
  relationship: string;
  note?: string | null;
  cvDriveUrl?: string | null;
}

/**
 * Record a referral.
 *
 * NOTHING IS SWALLOWED. A failure returns the real Postgres reason to the caller, which puts it on
 * the referrer's screen. A bare catch here would let an employee believe they had referred somebody
 * when no row was ever written — which is precisely how a hire went missing on this project for
 * eleven days.
 */
export async function submitReferral(input: SubmitReferralInput): Promise<WriteResult> {
  const referrerUserId = String(input?.referrerUserId || '').trim();
  if (!isUuid(referrerUserId)) return { ok: false, error: 'Sign in before submitting a referral.' };

  const candidateName = String(input?.candidateName || '').trim().slice(0, 200);
  if (!candidateName) return { ok: false, error: 'Give the candidate\'s name.' };

  const candidateEmail = String(input?.candidateEmail || '').trim().toLowerCase().slice(0, 255);
  if (!candidateEmail || candidateEmail.indexOf('@') < 1) {
    return { ok: false, error: 'Give a working email address for the candidate.' };
  }

  const relationship = RELATIONSHIP_KEYS.has(String(input?.relationship || '')) ? String(input.relationship) : 'other';
  const roleId = isUuid(input?.roleId) ? String(input.roleId) : null;
  const roleTitle = input?.roleTitle ? String(input.roleTitle).trim().slice(0, 200) : null;
  const phone = input?.candidatePhone ? String(input.candidatePhone).trim().slice(0, 50) : null;
  const note = input?.note ? String(input.note).trim().slice(0, 2000) : null;
  const referrerName = input?.referrerName ? String(input.referrerName).trim().slice(0, 200) : null;

  // A Drive LINK, never a file. An http(s) URL is the only thing accepted, and the form says why.
  const rawCv = input?.cvDriveUrl ? String(input.cvDriveUrl).trim().slice(0, 1000) : '';
  if (rawCv && !/^https?:\/\//i.test(rawCv)) {
    return { ok: false, error: 'The CV must be a link (starting http:// or https://) that anyone with the link can open. Files are never uploaded here.' };
  }
  const cvDriveUrl = rawCv || null;

  try {
    await ensureReferralSchema();

    // The same person referring the same candidate twice is almost always a double submit, and a
    // duplicate would double a reward later. Refused with a sentence rather than silently ignored.
    const dupe = rows(await db.execute(sql`
      SELECT id FROM recruitment_referrals
       WHERE referrer_user_id = ${referrerUserId}::uuid
         AND lower(candidate_email) = ${candidateEmail}
         AND state <> 'withdrawn'
       LIMIT 1`));
    if (dupe.length) {
      return { ok: false, error: 'You have already referred this person. Their status is on this page.' };
    }

    // The referrer's employee record, if they have one. Resolved HERE and stored, because the reward
    // approval is raised on behalf of an employee and the graph is keyed on hr_employees.id.
    let referrerEmployeeId: string | null = null;
    try {
      const emp = rows(await db.execute(sql`
        SELECT id FROM hr_employees
         WHERE user_id = ${referrerUserId}::uuid
         ORDER BY is_active DESC, created_at ASC
         LIMIT 1`));
      referrerEmployeeId = emp.length && emp[0]?.id ? String(emp[0].id) : null;
    } catch (e: any) {
      // Not fatal — a referral from someone with no employee record is still a referral. It is the
      // REWARD that needs the employee record, and sendRewardForApproval() refuses clearly there.
      console.error('[referrals] referrer employee lookup failed:', why(e));
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO recruitment_referrals
        (referrer_user_id, referrer_employee_id, referrer_name, candidate_name, candidate_email,
         candidate_phone, role_id, role_title, relationship, note, cv_drive_url, state)
      VALUES
        (${referrerUserId}::uuid, ${referrerEmployeeId}::uuid, ${referrerName}, ${candidateName}, ${candidateEmail},
         ${phone}, ${roleId}::uuid, ${roleTitle}, ${relationship}, ${note}, ${cvDriveUrl}, 'submitted')
      RETURNING id`));

    const id = ins.length && ins[0]?.id ? String(ins[0].id) : '';
    if (!id) return { ok: false, error: 'The referral could not be saved. Nothing was recorded — please try again.' };

    await logAudit({
      userId: referrerUserId,
      action: 'referral.submit',
      entity: 'recruitment_referral',
      entityId: id,
      diff: { candidateEmail, roleId, roleTitle, relationship, hasCvLink: !!cvDriveUrl },
    });

    // If they have already applied, link it now so the referrer sees a real status immediately.
    await linkReferralsToApplications();

    return { ok: true, id, message: 'Referral recorded. You will see their progress here.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[referrals] submitReferral failed:', reason);
    return { ok: false, error: 'The referral was not saved: ' + reason };
  }
}

/** The referrer changing their mind. A withdrawal, never a delete — the record of the act stays. */
export async function withdrawReferral(referralId: string, referrerUserId: string): Promise<WriteResult> {
  if (!isUuid(referralId) || !isUuid(referrerUserId)) return { ok: false, error: 'That referral could not be found.' };
  try {
    await ensureReferralSchema();
    const upd = rows(await db.execute(sql`
      UPDATE recruitment_referrals
         SET state = 'withdrawn', updated_at = NOW()
       WHERE id = ${referralId}::uuid
         AND referrer_user_id = ${referrerUserId}::uuid
         AND state IN ('submitted', 'linked')
       RETURNING id`));
    if (!upd.length) return { ok: false, error: 'That referral is not yours to withdraw, or it has already closed.' };
    await logAudit({
      userId: referrerUserId,
      action: 'referral.withdraw',
      entity: 'recruitment_referral',
      entityId: referralId,
      diff: {},
    });
    return { ok: true, message: 'Referral withdrawn.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[referrals] withdrawReferral failed:', reason);
    return { ok: false, error: 'The withdrawal was not saved: ' + reason };
  }
}

/**
 * Attach referrals to the applications their candidates actually filed.
 *
 * ONE STATEMENT, IDEMPOTENT, AND ONLY EVER FORWARD: it fills `application_id` where it is NULL and
 * an application exists with the same email address, taking the most recent one. It never re-points
 * a referral that is already linked, so a second application by the same person does not silently
 * move a reward from one hire to another.
 *
 * Called on read from the referral surfaces. Returns the number of rows linked so a page can say so
 * instead of quietly changing under the reader.
 */
export async function linkReferralsToApplications(): Promise<number> {
  try {
    await ensureReferralSchema();
    const upd = rows(await db.execute(sql`
      UPDATE recruitment_referrals r
         SET application_id = a.id,
             linked_at = NOW(),
             state = CASE WHEN r.state = 'submitted' THEN 'linked' ELSE r.state END,
             updated_at = NOW()
        FROM (
          SELECT DISTINCT ON (lower(email)) id, lower(email) AS email_key
            FROM applications
           WHERE deleted_at IS NULL
           ORDER BY lower(email), created_at DESC
        ) a
       WHERE r.application_id IS NULL
         AND r.state <> 'withdrawn'
         AND lower(r.candidate_email) = a.email_key
       RETURNING r.id`));
    return upd.length;
  } catch (e: any) {
    // `applications.deleted_at` is added by an ALTER inside /admin/applications rather than by any
    // migration in this repository, so on a database where that page has never been opened the
    // statement above refers to a column that does not exist. Retry without it rather than leaving
    // every referrer looking at "waiting for them to apply" forever, and say in the log which pass ran.
    console.error('[referrals] link pass failed, retrying without deleted_at:', why(e));
    try {
      const upd2 = rows(await db.execute(sql`
        UPDATE recruitment_referrals r
           SET application_id = a.id,
               linked_at = NOW(),
               state = CASE WHEN r.state = 'submitted' THEN 'linked' ELSE r.state END,
               updated_at = NOW()
          FROM (
            SELECT DISTINCT ON (lower(email)) id, lower(email) AS email_key
              FROM applications
             ORDER BY lower(email), created_at DESC
          ) a
         WHERE r.application_id IS NULL
           AND r.state <> 'withdrawn'
           AND lower(r.candidate_email) = a.email_key
         RETURNING r.id`));
      return upd2.length;
    } catch (e2: any) {
      console.error('[referrals] linkReferralsToApplications failed:', why(e2));
      return 0;
    }
  }
}

export interface RecordRewardInput {
  referralId: string;
  actorUserId: string;
  amount: number;
  currency?: string | null;
  note?: string | null;
}

/**
 * Record that a referral EARNS something. This is a note on a record and nothing else.
 *
 * It cannot be called on a referral that is already in approval or already decided — changing the
 * amount under a live approval would mean somebody approved a number that is no longer there.
 */
export async function recordRewardEligibility(input: RecordRewardInput): Promise<WriteResult> {
  const referralId = String(input?.referralId || '').trim();
  const actorUserId = String(input?.actorUserId || '').trim();
  if (!isUuid(referralId)) return { ok: false, error: 'That referral could not be found.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to record a reward.' };

  const amount = Number(input?.amount);
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Give the reward amount as a number greater than zero.' };

  const currency = (input?.currency ? String(input.currency) : 'INR').trim().slice(0, 8).toUpperCase() || 'INR';
  const note = input?.note ? String(input.note).trim().slice(0, 1000) : null;

  try {
    await ensureReferralSchema();
    const upd = rows(await db.execute(sql`
      UPDATE recruitment_referrals
         SET reward_amount = ${amount}::numeric,
             reward_currency = ${currency},
             reward_note = ${note},
             reward_state = 'eligible',
             reward_recorded_by = ${actorUserId}::uuid,
             reward_recorded_at = NOW(),
             reward_halt_reason = NULL,
             updated_at = NOW()
       WHERE id = ${referralId}::uuid
         AND reward_state IN ('none', 'eligible', 'halted', 'rejected')
       RETURNING id`));
    if (!upd.length) {
      return { ok: false, error: 'This reward is already in approval or already decided. Amounts cannot be changed underneath an approver.' };
    }
    await logAudit({
      userId: actorUserId,
      action: 'referral.reward.record',
      entity: 'recruitment_referral',
      entityId: referralId,
      diff: { amount, currency, note },
    });
    return { ok: true, message: 'Recorded as eligible. It is NOT approved and NOT payable until the approval settles.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[referrals] recordRewardEligibility failed:', reason);
    return { ok: false, error: 'The reward was not recorded: ' + reason };
  }
}

/**
 * Send a recorded reward into the approval engine.
 *
 * FIVE REFUSALS, EACH A SENTENCE, AND NOT ONE OF THEM APPROVES ANYTHING:
 *   1. no referral;
 *   2. no amount recorded;
 *   3. already in approval or decided;
 *   4. the referrer has no employee record, so there is nobody the request can be raised for;
 *   5. the workflow could not name an approver — which comes back as a HALTED instance, is stored
 *      with its reason, and is shown on the console as halted. It is never treated as approved.
 */
export async function sendRewardForApproval(referralId: string, actorUserId: string): Promise<WriteResult> {
  if (!isUuid(referralId)) return { ok: false, error: 'That referral could not be found.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to send a reward for approval.' };

  try {
    await ensureReferralSchema();
    const found = rows(await db.execute(sql`
      SELECT id, referrer_employee_id, referrer_user_id, referrer_name, candidate_name,
             reward_amount, reward_currency, reward_state
        FROM recruitment_referrals
       WHERE id = ${referralId}::uuid
       LIMIT 1`));
    if (!found.length) return { ok: false, error: 'That referral could not be found.' };
    const r = found[0] as any;

    const amount = r.reward_amount === null || r.reward_amount === undefined ? 0 : Number(r.reward_amount);
    if (!isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'Record the reward amount before sending it for approval.' };
    }
    if (r.reward_state === 'in_approval' || r.reward_state === 'approved') {
      return { ok: false, error: 'This reward has already been sent for approval.' };
    }

    const subjectEmployeeId = r.referrer_employee_id ? String(r.referrer_employee_id) : null;
    if (!isUuid(subjectEmployeeId)) {
      // HALT, LOUDLY. There is no employee record to raise the approval on behalf of, so the request
      // cannot be routed at all. It is emphatically NOT approved, and the sentence says what to do.
      await db.execute(sql`
        UPDATE recruitment_referrals
           SET reward_state = 'halted',
               reward_halt_reason = ${'The referrer has no employee record, so this reward cannot be raised on anybody\'s behalf. Link their account to an employee record in the people console first.'},
               updated_at = NOW()
         WHERE id = ${referralId}::uuid`);
      return {
        ok: false,
        error: 'The referrer has no employee record, so this reward cannot be raised on anybody\'s behalf. Nothing has been approved. Link their account to an employee record first.',
      };
    }

    const started = await startWorkflow({
      domain: REWARD_DOMAIN,
      recordId: REWARD_RECORD_PREFIX + referralId,
      subjectEmployeeId,
      requestedByUserId: String(r.referrer_user_id || '') || null,
      createdByUserId: actorUserId,
      summary: 'Referral reward for ' + String(r.candidate_name || 'a referred candidate'),
      amount,
      currency: r.reward_currency ? String(r.reward_currency) : 'INR',
    });

    if (!started.ok) {
      return { ok: false, error: started.error || 'The approval could not be started. Nothing has been approved.' };
    }

    const halted = started.state === 'halted';
    await db.execute(sql`
      UPDATE recruitment_referrals
         SET workflow_instance_id = ${started.instanceId}::uuid,
             reward_state = ${halted ? 'halted' : 'in_approval'},
             reward_halt_reason = ${started.haltReason || null},
             updated_at = NOW()
       WHERE id = ${referralId}::uuid`);

    await logAudit({
      userId: actorUserId,
      action: 'referral.reward.send_for_approval',
      entity: 'recruitment_referral',
      entityId: referralId,
      diff: { instanceId: started.instanceId, state: started.state, amount, haltReason: started.haltReason || null },
    });

    if (halted) {
      return {
        ok: false,
        error: 'Approval HALTED: ' + (started.haltReason || 'no approver could be resolved from the Organization Graph.')
          + ' Nothing has been approved. Record the missing relationship and resume it from the approvals console.',
      };
    }
    return { ok: true, message: 'Sent for approval. It is not payable until an approver decides.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[referrals] sendRewardForApproval failed:', reason);
    return { ok: false, error: 'The approval was not started: ' + reason };
  }
}

/**
 * Bring a referral's reward state into line with its workflow instance.
 *
 * The workflow engine is the AUTHORITY; this column is a cache so the console can sort and filter
 * without joining. It is only ever written FROM the instance, never the other way round, and there
 * is no branch that writes 'approved' without the instance saying so.
 */
export async function refreshRewardState(referralId: string): Promise<string | null> {
  if (!isUuid(referralId)) return null;
  try {
    await ensureReferralSchema();
    const found = rows(await db.execute(sql`
      SELECT workflow_instance_id, reward_state FROM recruitment_referrals WHERE id = ${referralId}::uuid LIMIT 1`));
    if (!found.length) return null;
    const instanceId = found[0]?.workflow_instance_id ? String(found[0].workflow_instance_id) : null;
    if (!instanceId) return String(found[0]?.reward_state || 'none');

    const instance = await getInstance(instanceId);
    if (!instance) return String(found[0]?.reward_state || 'none');

    let next: RewardState;
    if (instance.state === 'approved') next = 'approved';
    else if (instance.state === 'rejected') next = 'rejected';
    else if (instance.state === 'halted') next = 'halted';
    else if (instance.state === 'cancelled') next = 'eligible';
    else next = 'in_approval';

    await db.execute(sql`
      UPDATE recruitment_referrals
         SET reward_state = ${next},
             reward_halt_reason = ${instance.haltReason || null},
             updated_at = NOW()
       WHERE id = ${referralId}::uuid`);
    return next;
  } catch (e: any) {
    console.error('[referrals] refreshRewardState failed:', why(e));
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface ListReferralOptions {
  /** Only this person's referrals. The employee-facing surface always passes it. */
  referrerUserId?: string | null;
  /** Referral state filter. */
  state?: string | null;
  /** Reward state filter. */
  rewardState?: string | null;
  /** Name or email search, case-insensitive. */
  q?: string | null;
  limit?: number;
}

/**
 * List referrals with the candidate's CURRENT application status joined live.
 *
 * The join is a LEFT JOIN and every application column may be null: a referral for somebody who has
 * not applied is the ordinary first state, not an error.
 */
export async function listReferrals(opts: ListReferralOptions = {}): Promise<ReferralRow[]> {
  const referrer = isUuid(opts?.referrerUserId) ? String(opts.referrerUserId) : null;
  const state = opts?.state && (REFERRAL_STATES as readonly string[]).includes(String(opts.state)) ? String(opts.state) : null;
  const rewardState = opts?.rewardState && (REWARD_STATES as readonly string[]).includes(String(opts.rewardState)) ? String(opts.rewardState) : null;
  const q = opts?.q ? String(opts.q).trim().slice(0, 80) : '';
  const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
  const like = q ? '%' + q.toLowerCase() + '%' : null;

  try {
    await ensureReferralSchema();
    const r = await db.execute(sql`
      SELECT rr.*,
             a.status  AS application_status,
             a.stage   AS application_stage,
             a.application_number AS application_number
        FROM recruitment_referrals rr
        LEFT JOIN applications a ON a.id = rr.application_id
       WHERE (${referrer}::uuid IS NULL OR rr.referrer_user_id = ${referrer}::uuid)
         AND (${state}::text IS NULL OR rr.state = ${state}::text)
         AND (${rewardState}::text IS NULL OR rr.reward_state = ${rewardState}::text)
         AND (${like}::text IS NULL
              OR lower(rr.candidate_name) LIKE ${like}::text
              OR lower(rr.candidate_email) LIKE ${like}::text
              OR lower(COALESCE(rr.referrer_name, '')) LIKE ${like}::text)
       ORDER BY rr.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapRow);
  } catch (e: any) {
    // `applications.stage` is added by src/lib/application-stages.ts at page load, so on a database
    // where no stage-aware page has run yet this join can fail. Retry WITHOUT the stage column
    // rather than showing an empty programme, and say so in the log.
    console.error('[referrals] listReferrals failed, retrying without stage:', why(e));
    try {
      const r2 = await db.execute(sql`
        SELECT rr.*,
               a.status AS application_status,
               NULL::text AS application_stage,
               a.application_number AS application_number
          FROM recruitment_referrals rr
          LEFT JOIN applications a ON a.id = rr.application_id
         WHERE (${referrer}::uuid IS NULL OR rr.referrer_user_id = ${referrer}::uuid)
         ORDER BY rr.created_at DESC
         LIMIT ${limit}`);
      return rows(r2).map(mapRow);
    } catch (e2: any) {
      console.error('[referrals] listReferrals fallback failed:', why(e2));
      return [];
    }
  }
}

/** One referral, with the same live application join. Null when it does not exist. */
export async function getReferral(referralId: string): Promise<ReferralRow | null> {
  if (!isUuid(referralId)) return null;
  try {
    await ensureReferralSchema();
    const r = await db.execute(sql`
      SELECT rr.*,
             a.status AS application_status,
             a.application_number AS application_number,
             NULL::text AS application_stage
        FROM recruitment_referrals rr
        LEFT JOIN applications a ON a.id = rr.application_id
       WHERE rr.id = ${referralId}::uuid
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapRow(list[0]) : null;
  } catch (e: any) {
    console.error('[referrals] getReferral failed:', why(e));
    return null;
  }
}

export interface ReferralCounts {
  total: number;
  waiting: number;
  linked: number;
  hired: number;
  rewardsWaiting: number;
  rewardsHalted: number;
}

/** Headline counts for the console. Zeroes on failure, which reads as an empty programme. */
export async function referralCounts(referrerUserId?: string | null): Promise<ReferralCounts> {
  const referrer = isUuid(referrerUserId) ? String(referrerUserId) : null;
  const empty: ReferralCounts = { total: 0, waiting: 0, linked: 0, hired: 0, rewardsWaiting: 0, rewardsHalted: 0 };
  try {
    await ensureReferralSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE rr.application_id IS NULL AND rr.state = 'submitted')::int AS waiting,
        COUNT(*) FILTER (WHERE rr.application_id IS NOT NULL)::int AS linked,
        COUNT(*) FILTER (WHERE a.status = 'hired')::int AS hired,
        COUNT(*) FILTER (WHERE rr.reward_state = 'in_approval')::int AS rewards_waiting,
        COUNT(*) FILTER (WHERE rr.reward_state = 'halted')::int AS rewards_halted
       FROM recruitment_referrals rr
       LEFT JOIN applications a ON a.id = rr.application_id
      WHERE (${referrer}::uuid IS NULL OR rr.referrer_user_id = ${referrer}::uuid)`));
    if (!r.length) return empty;
    const c = r[0] as any;
    return {
      total: Number(c.total || 0),
      waiting: Number(c.waiting || 0),
      linked: Number(c.linked || 0),
      hired: Number(c.hired || 0),
      rewardsWaiting: Number(c.rewards_waiting || 0),
      rewardsHalted: Number(c.rewards_halted || 0),
    };
  } catch (e: any) {
    console.error('[referrals] referralCounts failed:', why(e));
    return empty;
  }
}

/** Open roles a referrer can point at. Empty on failure — the role becomes free text instead. */
export async function openRolesForReferral(): Promise<{ id: string; title: string }[]> {
  try {
    const r = await db.execute(sql`
      SELECT id, title FROM roles WHERE is_open = true ORDER BY sort_order ASC, title ASC LIMIT 200`);
    return rows(r).map((x: any) => ({ id: String(x.id), title: String(x.title || '') }));
  } catch (e: any) {
    console.error('[referrals] openRolesForReferral failed:', why(e));
    return [];
  }
}
