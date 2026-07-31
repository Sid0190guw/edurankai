// When an offer is accepted (signed), transfer the applicant's details into an
// hr_employees record so they become an employee pending onboarding. Idempotent.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export async function transferApplicantToEmployee(offer: any): Promise<{ created: boolean; employeeId?: string }> {
  const appId = offer?.applicationId || offer?.application_id || null;
  const userId = offer?.createdUserId || offer?.created_user_id || null;
  const c = offer?.content || {};
  const name = c.candidateName || offer?.candidateName || offer?.candidate_name || 'New Employee';
  const email = c.candidateEmail || offer?.candidateEmail || offer?.candidate_email || '';
  if (!email) return { created: false };

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
  const empCode = 'EMP-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO hr_employees (user_id, employee_code, full_name, email, personal_email, phone, designation, employment_type, joining_date, employment_status, application_id, is_active, onboarding_status)
      VALUES (${userId}, ${empCode}, ${name}, ${email}, ${email}, ${c.candidatePhone || null}, ${designation}, ${empType}, ${joining}::date, 'active', ${appId}, true, 'pending')
      RETURNING id`));

    // Put them in their groups the moment they become an employee — the common group and their
    // department's, which is created on first use. Guarded and awaited: a group failure must never
    // undo a hire, but it must also not be fired and forgotten, because on a serverless platform
    // that work is killed when the response is sent.
    try {
      const { autoJoinOnOnboard } = await import('@/lib/work-groups');
      await autoJoinOnOnboard(userId, (c as any).departmentId || null, (c as any).departmentName || designation || null);
    } catch (e: any) {
      console.error('[hire-transfer] group auto-join failed:', e?.cause?.message || e?.message);
    }

    return { created: true, employeeId: (ins[0] as any)?.id };
  } catch (e: any) {
    console.error('[hire-transfer] failed:', e?.message);
    return { created: false };
  }
}
