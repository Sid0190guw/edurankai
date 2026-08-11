// Hiring Requisition workflow — per /policy/recruitment + the HR Lifecycle
// Manual §B.3. A manager raises a request to open a role; the requisition is
// approved (or rejected) by Finance + Leadership + (CPO once we have one).
// Only after final approval can the role be marked is_open=true on roles.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[hr-requisition] ' + tag, e?.cause?.message || e?.message);

/**
 * Create the requisition table if it is absent. Idempotent.
 *
 * WAS a hand-rolled `let ready` memo with `catch (_) {}` inside it: nothing logged, and the resolved
 * promise cached for the lifetime of the process, so a single transient DDL failure meant the
 * requisitions console showed an empty list and every raise died against a missing table for as long
 * as the server ran. ensureOnce() drops a failed run from its cache so the next request retries; the
 * catch names the reason and re-throws so that drop actually happens.
 */
export function ensureRequisitionSchema(): Promise<void> {
  return ensureOnce('hr_requisition_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hiring_requisitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_user_id UUID,
        requester_name VARCHAR(200) NOT NULL,
        role_title VARCHAR(200) NOT NULL,
        department VARCHAR(120),
        level VARCHAR(40),
        engagement_type VARCHAR(40),
          -- A key of ENGAGEMENT_TYPES below, which is a subset of CLASSIFICATIONS (the spine):
          -- permanent | part_time | fixed_term | intern | intern_unpaid | apprentice | contractor | eor | consultant
        country VARCHAR(80),
        work_mode VARCHAR(40),
          -- remote | hybrid | office
        headcount INT NOT NULL DEFAULT 1,
        justification TEXT NOT NULL,
          -- one-line business reason for the role
        budget_band_min DECIMAL(12,2),
        budget_band_max DECIMAL(12,2),
        budget_currency VARCHAR(8) DEFAULT 'CHF',
        target_join_by DATE,
        kras TEXT,
          -- written KRAs / KPIs at requisition time
        skills_required TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending_finance',
          -- pending_finance | pending_leadership | approved | rejected | withdrawn
        finance_approved_by UUID,
        finance_approved_at TIMESTAMPTZ,
        finance_notes TEXT,
        leadership_approved_by UUID,
        leadership_approved_at TIMESTAMPTZ,
        leadership_notes TEXT,
        opened_role_id UUID,
          -- references roles(id) once role is created from this req
        rejection_reason TEXT,
        rejected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_req_status_idx ON hiring_requisitions(status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_req_dept_idx ON hiring_requisitions(department, status)`);
    } catch (e: any) {
      logFail('ensureRequisitionSchema', e);
      throw e;
    }
  });
}

/**
 * WHAT A REQUISITION IS ASKING FOR — and it is the SAME vocabulary the person will later be
 * classified and onboarded under. Every key here is a key of CLASSIFICATIONS in
 * src/lib/hr-classification.ts, which is the spine; src/lib/onboarding-packs.ts keys the joining
 * checklist off those same keys. So a requisition raised for an unpaid intern produces a person
 * classified as an unpaid intern who gets the unpaid-intern joining pack, rather than three screens
 * each guessing.
 *
 * The three added keys (part_time, intern_unpaid, apprentice) were missing from the spine and are
 * described there. `volunteer` is a spine key that is deliberately NOT offered here: a volunteer is
 * somebody who offers, not a headcount a manager requisitions, and putting one on this form would
 * turn "use sparingly, check local labour law" into a hiring channel.
 *
 * Descriptions kept short — this is a picker on a form, and the legal detail lives on the spine.
 */
export const ENGAGEMENT_TYPES = {
  permanent:     { label: 'Permanent employee', description: 'Direct full-time hire on our payroll' },
  part_time:     { label: 'Part-time employee', description: 'Employee on agreed reduced days or hours; leave and contributions pro-rata' },
  fixed_term:    { label: 'Fixed-term contract', description: 'Defined-end employment (e.g. 6/12 months)' },
  intern:        { label: 'Paid intern (stipend recorded)', description: 'Intern with a stipend recorded; intern-to-permanent pipeline' },
  intern_unpaid: { label: 'Unpaid intern',      description: 'Intern with no stipend — the default here. Learning agreement, mentor and end date required' },
  apprentice:    { label: 'Apprentice',         description: 'Registered contract of apprenticeship on a structured training programme' },
  contractor:    { label: 'Independent contractor', description: 'Genuine contractor — pay on invoice, NO control over hours/tools' },
  eor:           { label: 'EOR-employed (foreign)', description: 'Senior specialist abroad via Employer-of-Record partner' },
  consultant:    { label: 'Consultant / advisor', description: 'Short engagement, advisory work' },
};

export async function createRequisition(opts: any) {
  await ensureRequisitionSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hiring_requisitions (
      requester_user_id, requester_name, role_title, department, level, engagement_type,
      country, work_mode, headcount, justification, budget_band_min, budget_band_max,
      budget_currency, target_join_by, kras, skills_required
    ) VALUES (
      ${opts.requesterUserId || null}, ${opts.requesterName}, ${opts.roleTitle}, ${opts.department || null},
      ${opts.level || null}, ${opts.engagementType || 'permanent'}, ${opts.country || null}, ${opts.workMode || 'remote'},
      ${opts.headcount || 1}, ${opts.justification},
      ${opts.budgetMin ?? null}, ${opts.budgetMax ?? null}, ${opts.budgetCurrency || 'CHF'},
      ${opts.targetJoinBy || null}, ${opts.kras || null}, ${opts.skillsRequired || null}
    ) RETURNING id
  `));
  return { ok: true, id: r[0]?.id };
}

/**
 * Record one stage of a requisition decision.
 *
 * =================================================================================================
 * THE STAGE IS NOT WHATEVER THE FORM SAID — IT IS WHATEVER THE ROW IS WAITING FOR
 * =================================================================================================
 *
 * `level` arrives from a hidden field on the console, and neither UPDATE used to constrain the row's
 * CURRENT status. So one POST carrying level='leadership' took a requisition straight from
 * pending_finance to 'approved' and the finance stage this module exists to enforce never happened —
 * a budget and a headcount signed off by half the people the file's own header names. Each UPDATE
 * now states the status it is allowed to advance FROM, so a stage can only be recorded when it is
 * the stage the row is actually at, and a skipped or repeated one matches no row and is reported.
 *
 * =================================================================================================
 * THIS STILL CHECKS NOBODY, AND THAT IS A DECISION SOMEBODY HAS TO MAKE, NOT ONE TO MAKE HERE
 * =================================================================================================
 *
 * There is no capability test in this function. `requisitions.approve` exists in
 * src/lib/auth/registry.ts and is deliberately unenforced: which holder signs the FINANCE stage and
 * which signs the LEADERSHIP stage is a policy question nobody has answered, and inventing an answer
 * inside a bug fix would quietly change who can authorise a hire. Until it is answered, any account
 * that can open the console can record either stage. That is a reported hole, not an accepted one —
 * see src/lib/workforce/widgets.ts 'requisitions.mine'.
 *
 * Returns { ok: false } with a reason when nothing was written, rather than a bare ok the console
 * printed as "Decision recorded." over an UPDATE that matched no row at all.
 */
export async function decideRequisition(
  opts: { id: string; level: 'finance' | 'leadership'; userId: string; approve: boolean; notes?: string; rejectReason?: string },
): Promise<{ ok: boolean; error?: string }> {
  await ensureRequisitionSchema();
  const id = String(opts?.id || '').trim();
  if (!id) return { ok: false, error: 'No requisition was named, so nothing was decided.' };

  // OPEN STAGES ONLY. A requisition that is already approved, rejected or withdrawn is settled;
  // re-deciding it from a stale tab must not reopen it.
  const OPEN = sql`status IN ('pending_finance', 'pending_leadership')`;

  try {
    if (!opts.approve) {
      const wrote = rows(await db.execute(sql`
        UPDATE hiring_requisitions
           SET status='rejected', rejection_reason=${opts.rejectReason || opts.notes || 'No reason given'},
               rejected_at=NOW(), updated_at=NOW()
         WHERE id=${id} AND ${OPEN}
        RETURNING id`));
      return wrote.length
        ? { ok: true }
        : { ok: false, error: 'That requisition is no longer open, so nothing was rejected. Reload the list.' };
    }

    if (opts.level === 'finance') {
      const wrote = rows(await db.execute(sql`
        UPDATE hiring_requisitions
           SET status='pending_leadership', finance_approved_by=${opts.userId}, finance_approved_at=NOW(),
               finance_notes=${opts.notes || null}, updated_at=NOW()
         WHERE id=${id} AND status='pending_finance'
        RETURNING id`));
      return wrote.length
        ? { ok: true }
        : { ok: false, error: 'That requisition is not waiting on finance, so nothing was recorded. Reload the list.' };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE hiring_requisitions
         SET status='approved', leadership_approved_by=${opts.userId}, leadership_approved_at=NOW(),
             leadership_notes=${opts.notes || null}, updated_at=NOW()
       WHERE id=${id} AND status='pending_leadership'
      RETURNING id`));
    return wrote.length
      ? { ok: true }
      : { ok: false, error: 'That requisition has not cleared finance yet, so leadership sign-off was not recorded.' };
  } catch (e: any) {
    logFail('decideRequisition', e);
    return { ok: false, error: String(e?.cause?.message || e?.message || 'The decision could not be saved.').slice(0, 300) };
  }
}

export async function listRequisitions(filterStatus?: string) {
  await ensureRequisitionSchema();
  return rows(await db.execute(sql`SELECT * FROM hiring_requisitions ${filterStatus ? sql`WHERE status=${filterStatus}` : sql``} ORDER BY created_at DESC LIMIT 200`));
}
