// src/lib/hire-transfer.ts — the FALLBACK employee-creation path for a signed offer.
//
// READ THIS BEFORE CALLING IT DIRECTLY. It is no longer the front door.
//
// There were two engines that turned a hire into an hr_employees row and they did different work:
//   - src/lib/hr/sync.ts   (admin flips the status to Hired) set department_id from the role and
//                          minted the code through withEmployeeCode() with a collision retry.
//   - this file            (candidate signs their own offer) set neither, and generated a code from
//                          Math.random() with no uniqueness retry.
// So whether a new joiner got a department and a safely minted code depended on which of two doors
// the word "hired" came through — and the door people actually use was the poorer one.
//
// src/lib/hire-completion.ts is now the single front door. It routes an application-backed hire
// through hr/sync.ts, and falls back to THIS function only for an offer with no application row
// (a direct offer, where hr/sync has nothing to read). To stop that fallback being second-class, the
// two faults above are fixed here as well: the department is resolved from the same role join
// hr/sync uses, and the code comes from the same minting function.
//
// HOUSE RULES OBSERVED: postgres-js returns PLAIN ARRAYS; the real Postgres reason is on e.cause;
// hr_employees uses full_name; departments.id is compared ::text; no exception is swallowed.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { withEmployeeCode } from '@/lib/hr/employee-code';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export async function transferApplicantToEmployee(offer: any): Promise<{ created: boolean; employeeId?: string; error?: string }> {
  const appId = offer?.applicationId || offer?.application_id || null;
  const userId = offer?.createdUserId || offer?.created_user_id || null;
  const c = offer?.content || {};
  const name = c.candidateName || offer?.candidateName || offer?.candidate_name || 'New Employee';
  const email = c.candidateEmail || offer?.candidateEmail || offer?.candidate_email || '';

  // THIS BRANCH USED TO RETURN SILENTLY. `return { created: false }` with no error and no log is
  // indistinguishable, to every caller and every screen, from "already on the register" — so an offer
  // whose content carried no email produced a signed hire, no employee row, and not one line anywhere
  // saying why. It now names itself, and hire-completion.ts records the sentence against the offer.
  if (!email) {
    const why = 'The offer carries no candidate email address, so no employee record could be created from it.';
    console.error('[hire-transfer] refused:', why, { applicationId: appId, userId });
    return { created: false, error: why };
  }

  // Skip if an employee already exists for this application, user, or email.
  const existing = rows(await db.execute(sql`
    SELECT id FROM hr_employees
    WHERE (${appId}::uuid IS NOT NULL AND application_id = ${appId})
       OR (${userId}::uuid IS NOT NULL AND user_id = ${userId})
       OR lower(personal_email) = ${String(email).toLowerCase()}
       OR lower(email) = ${String(email).toLowerCase()}
    LIMIT 1`));
  if (existing.length) return { created: false, employeeId: (existing[0] as any).id };

  const designation = c.roleTitle || offer?.roleTitle || offer?.role_title || '';
  const empType = c.employmentType || '';
  const joining = (c.joiningDate && String(c.joiningDate).trim()) ? String(c.joiningDate).trim() : null;

  // THE DEPARTMENT, FROM THE ROLE THEY WERE HIRED INTO — the same join src/lib/hr/sync.ts uses.
  //
  // Leaving this NULL is not a cosmetic gap. src/lib/employee-tasks.ts admits an assigner only when
  // they are the person themselves, their recorded reporting manager, or a head of their department;
  // with no department and no manager, NOBODY can give a new joiner their first task. Onboarding
  // steps owned via department_head resolve unowned forever, and no department attendance or
  // headcount widget can see them. It is read here rather than left for a human to type later.
  //
  // Read separately and never allowed to fail the hire: a missing department is a gap the
  // reconciliation screen reports, not a reason a signed hire has no record at all.
  let departmentId: string | null = (c as any)?.departmentId || null;
  if (!departmentId && appId) {
    try {
      const dept = rows(await db.execute(sql`
        SELECT r.department_id AS department_id
          FROM applications a
          LEFT JOIN roles r ON a.role_id = r.id
         WHERE a.id = ${appId}
         LIMIT 1`));
      const d = dept[0]?.department_id;
      if (d) departmentId = String(d);
    } catch (e: any) {
      console.error('[hire-transfer] department lookup failed:', e?.cause?.message || e?.message);
    }
  }

  try {
    // The code is minted by src/lib/hr/employee-code.ts, which derives it from MAX (immune to
    // deletions) and retries the INSERT on a unique violation. It replaces
    // 'EMP-' + year + Math.random().toString(36).slice(2,7), which had no retry: two hires landing on
    // the same five characters lost one of them outright, and the codes did not match the ERA-EMP-
    // series every other employee carries.
    const employeeId = await withEmployeeCode(async (code) => {
      const ins = rows(await db.execute(sql`
        INSERT INTO hr_employees (user_id, employee_code, full_name, email, personal_email, phone, designation, employment_type, department_id, joining_date, employment_status, application_id, is_active, onboarding_status)
        VALUES (${userId}, ${code}, ${name}, ${email}, ${email}, ${c.candidatePhone || null}, ${designation}, ${empType}, ${departmentId}::uuid, ${joining}::date, 'active', ${appId}, true, 'pending')
        RETURNING id`));
      return String((ins[0] as any)?.id || '');
    });

    // Put them in their groups the moment they become an employee — the common group and their
    // department's, which is created on first use. Guarded and awaited: a group failure must never
    // undo a hire, but it must also not be fired and forgotten, because on a serverless platform
    // that work is killed when the response is sent.
    try {
      const { autoJoinOnOnboard } = await import('@/lib/work-groups');
      await autoJoinOnOnboard(userId, (c as any).departmentId || departmentId || null, (c as any).departmentName || designation || null);
    } catch (e: any) {
      console.error('[hire-transfer] group auto-join failed:', e?.cause?.message || e?.message);
    }

    return { created: true, employeeId };
  } catch (e: any) {
    // THE REAL REASON, AND SOMEWHERE A HUMAN WILL SEE IT.
    //
    // This logged `e?.message` only, which for a drizzle/postgres-js failure is just the SQL that
    // was attempted — the actual Postgres reason ("null value in column X violates not-null
    // constraint", "duplicate key") lives on e.cause and was being thrown away. The caller in
    // portal/offer/[token].astro then wrapped the whole call in `catch (_) {}`, so a failure here
    // produced NO error row, NO admin signal, and a cheerful "You are officially part of EduRankAI"
    // on screen. Someone signed their offer on 23 July and simply never became an employee; nobody
    // could find out why, because both layers had discarded the reason.
    //
    // Signing must still succeed if this fails — a person who has accepted a job must not be shown
    // a red error because their employee row could not be written. So this stays non-fatal, but it
    // is no longer silent: the reason is returned to the caller, written to edu_error_log (which
    // /admin/hardening reads) AND recorded against the offer by hire-completion.ts, which is what
    // /admin/hr/reconciliation lists. A failure nobody can see is the same as no failure until payroll.
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[hire-transfer] failed:', why);
    try {
      const { trackError } = await import('@/lib/logger');
      await trackError('hire.transfer_failed', e, {
        applicationId: appId, userId, email, designation, employmentType: empType, reason: why,
      });
    } catch (_) { /* the log must never be the reason a hire fails */ }
    return { created: false, error: why };
  }
}
