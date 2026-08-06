// src/lib/hr/sync.ts
// Automatically syncs application status changes to HR employees
//
// IT RETURNS ITS FAILURE. This module used to catch every exception, write it to console with
// `err.message` — which for a Postgres error is only the failed SQL, never the reason — and return
// as if it had worked. Its one caller (/admin/applications/[id]) then wrapped the call in its own
// empty catch and told the reviewer "Status updated". So an applicant could read Hired while no
// employee row existed and nothing anywhere said so: the eleven-day silent hire.
//
// The contract now: this never throws (a failed HR sync must not roll back a status change the
// reviewer already made and can see), but it always REPORTS, and the caller is expected to put that
// report in front of the human who pressed the button.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { withEmployeeCode } from '@/lib/hr/employee-code';
// A JOINING DATE AND AN EXIT DATE ARE CIVIL DATES, NOT UTC INSTANTS.
// Both were `new Date().toISOString().split('T')[0]`, which is the date in UTC. This process runs
// in UTC and the people it records live in IST (UTC+05:30), so every hire confirmed between
// 00:00 and 05:29 IST was written onto the register as having joined YESTERDAY — and every
// offboarding in that window as having left yesterday. Those two columns are read by probation
// end, notice period, leave accrual and the full-and-final settlement, so a day out is not
// cosmetic. civilToday() asks Intl for the date in the zone the company works in.
import { civilToday } from '@/lib/page-safety';

export type HrSyncResult = {
  ok: boolean;
  /** What actually happened, so a caller can say "already on the register" rather than "created". */
  action: 'none' | 'created' | 'already_exists' | 'offboarded' | 'no_application';
  employeeCode?: string;
  /** Present only when ok is false. The Postgres reason, not the failed statement. */
  error?: string;
};

export async function onApplicationStatusChange(
  applicationId: string,
  newStatus: string,
  oldStatus: string,
  actorUserId: string
): Promise<HrSyncResult> {
  // HIRED → Create employee record if not exists
  if (newStatus === 'hired' && oldStatus !== 'hired') {
    return await syncHiredToEmployee(applicationId, actorUserId);
  }

  // WITHDRAWN or REJECTED → If employee exists, mark as offboarded
  if ((newStatus === 'withdrawn' || newStatus === 'rejected') && oldStatus === 'hired') {
    return await syncOffboardEmployee(applicationId, newStatus, actorUserId);
  }

  return { ok: true, action: 'none' };
}

async function syncHiredToEmployee(applicationId: string, actorUserId: string): Promise<HrSyncResult> {
  try {
    // Get application details
    const app = await db.execute(sql`
      SELECT a.*, r.department_id, d.name as dept_name
      FROM applications a
      LEFT JOIN roles r ON a.role_id = r.id
      LEFT JOIN departments d ON r.department_id = d.id
      WHERE a.id = ${applicationId}
      LIMIT 1
    `);

    const _appRows = Array.isArray(app) ? app : (app?.rows || []);
    // NOT ok. The status was set on an application this query cannot find, which means the two
    // reads disagree about what exists — silence here is how a hire disappears.
    if (_appRows.length === 0) {
      logEvent('error', 'hr.sync.application_missing', { applicationId });
      return { ok: false, action: 'no_application', error: 'The application row could not be read back, so no employee record was created.' };
    }
    const a = _appRows[0] as any;

    // Check if employee already exists for this application
    const existing = await db.execute(sql`
      SELECT id, employee_code FROM hr_employees WHERE application_id = ${applicationId} LIMIT 1
    `);
    const _existingRows = Array.isArray(existing) ? existing : (existing?.rows || []);
    if (_existingRows.length > 0) {
      return { ok: true, action: 'already_exists', employeeCode: String((_existingRows[0] as any)?.employee_code || '') };
    }

    const fullName = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
    const joinDate = civilToday();

    // Create employee record. Column names must match the real hr_employees
    // schema: email (NOT NULL) + personal_email + joining_date (not work_email
    // / join_date, which do not exist). Existence already checked above.
    //
    // The code is minted by src/lib/hr/employee-code.ts and the INSERT is retried if a concurrent
    // hire took that number first. The old COUNT(*)+1 reused a code after any deletion and handed
    // the same code to two simultaneous hires — a UNIQUE violation on employee_code that was then
    // swallowed, losing the hire outright.
    const empCode = await withEmployeeCode(async (code) => {
      await db.execute(sql`
        INSERT INTO hr_employees (
          employee_code, full_name, email, personal_email,
          phone, designation, department_id, joining_date,
          employment_type, application_id, is_active, onboarding_status,
          created_at, updated_at
        ) VALUES (
          ${code}, ${fullName},
          ${a.email}, ${a.email},
          ${a.phone || null},
          ${a.role_title_snapshot || 'Employee'},
          ${a.department_id || null},
          ${joinDate}::date,
          'full_time',
          ${applicationId},
          true, 'pending',
          NOW(), NOW()
        )
      `);
      return code;
    });

    // Leave allocation used to be seeded into hr_leave_types / hr_leave_balances here. Those
    // tables have no writer in the live leave workflow and no reader any more: entitlement comes
    // from LEAVE_TYPES in src/lib/hr-leave.ts and consumption is derived from hr_leave_request,
    // so every new employee starts with the correct allowance without a per-employee seed row.
    // Seeding them again would only recreate the split that left the Leave tab blank.

    logEvent('info', 'hr.sync.employee_created', { applicationId, employeeCode: empCode });
    return { ok: true, action: 'created', employeeCode: empCode };
  } catch (err: any) {
    // e.cause carries the real Postgres reason; err.message is only the failed statement.
    const reason = err?.cause?.message || err?.message || 'unknown';
    logEvent('error', 'hr.sync.employee_create_failed', { applicationId, reason });
    return { ok: false, action: 'none', error: reason };
  }
}

async function syncOffboardEmployee(applicationId: string, reason: string, actorUserId: string): Promise<HrSyncResult> {
  try {
    // The header of this file says BOTH of these dates are civil dates in the company's zone. The
    // joining date was moved to civilToday(); this one was left on `new Date().toISOString()`, the
    // date in UTC, so every offboarding confirmed between 00:00 and 05:29 IST was written onto the
    // register as having happened YESTERDAY. exit_date drives notice period and the full-and-final
    // settlement, so a day out here is money, not formatting.
    const offboardDate = civilToday();
    await db.execute(sql`
      UPDATE hr_employees SET
        is_active = false,
        exit_date = ${offboardDate},
        exit_reason = ${reason === 'withdrawn' ? 'resignation' : 'termination'},
        updated_at = NOW()
      WHERE application_id = ${applicationId}
        AND is_active = true
    `);
    logEvent('info', 'hr.sync.employee_offboarded', { applicationId, reason });
    return { ok: true, action: 'offboarded' };
  } catch (err: any) {
    // A person who still has an active employee record — and therefore still holds whatever that
    // record grants — after being marked withdrawn is an access fact, not a bookkeeping one.
    const detail = err?.cause?.message || err?.message || 'unknown';
    logEvent('error', 'hr.sync.employee_offboard_failed', { applicationId, reason, detail });
    return { ok: false, action: 'none', error: detail };
  }
}
