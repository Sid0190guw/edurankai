// src/lib/hr/sync.ts
// Automatically syncs application status changes to HR employees

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export async function onApplicationStatusChange(
  applicationId: string,
  newStatus: string,
  oldStatus: string,
  actorUserId: string
) {
  // HIRED → Create employee record if not exists
  if (newStatus === 'hired' && oldStatus !== 'hired') {
    await syncHiredToEmployee(applicationId, actorUserId);
  }

  // WITHDRAWN or REJECTED → If employee exists, mark as offboarded
  if ((newStatus === 'withdrawn' || newStatus === 'rejected') && oldStatus === 'hired') {
    await syncOffboardEmployee(applicationId, newStatus, actorUserId);
  }
}

async function syncHiredToEmployee(applicationId: string, actorUserId: string) {
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

    if (app.rows.length === 0) return;
    const a = app.rows[0] as any;

    // Check if employee already exists for this application
    const existing = await db.execute(sql`
      SELECT id FROM hr_employees WHERE application_id = ${applicationId} LIMIT 1
    `);
    if (existing.rows.length > 0) return; // Already synced

    // Generate employee code
    const countResult = await db.execute(sql`SELECT COUNT(*)::int as n FROM hr_employees`);
    const count = (countResult.rows[0] as any).n || 0;
    const empCode = 'ERA-EMP-' + String(count + 1).padStart(4, '0');

    const fullName = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
    const joinDate = new Date().toISOString().split('T')[0];

    // Create employee record
    await db.execute(sql`
      INSERT INTO hr_employees (
        employee_code, full_name, personal_email, work_email,
        phone, designation, department_id, join_date,
        employment_type, application_id, is_active,
        created_at, updated_at
      ) VALUES (
        ${empCode}, ${fullName},
        ${a.email}, ${a.email},
        ${a.phone || null},
        ${a.role_title_snapshot || 'Employee'},
        ${a.department_id || null},
        ${joinDate},
        'full_time',
        ${applicationId},
        true,
        NOW(), NOW()
      )
      ON CONFLICT (application_id) DO NOTHING
    `);

    // Allocate default leave balances for current year
    const year = new Date().getFullYear();
    const empResult = await db.execute(sql`SELECT id FROM hr_employees WHERE application_id = ${applicationId} LIMIT 1`);
    if (empResult.rows.length > 0) {
      const empId = (empResult.rows[0] as any).id;
      const leaveTypes = await db.execute(sql`SELECT id, days_per_year FROM hr_leave_types WHERE is_active = true`);
      for (const lt of leaveTypes.rows as any[]) {
        await db.execute(sql`
          INSERT INTO hr_leave_balances (employee_id, leave_type_id, year, allocated, used)
          VALUES (${empId}, ${lt.id}, ${year}, ${lt.days_per_year || 0}, 0)
          ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
        `);
      }
    }

    console.log(`[HR Sync] Created employee ${empCode} from application ${applicationId}`);
  } catch (err: any) {
    console.error('[HR Sync] Failed to create employee:', err.message);
  }
}

async function syncOffboardEmployee(applicationId: string, reason: string, actorUserId: string) {
  try {
    const offboardDate = new Date().toISOString().split('T')[0];
    await db.execute(sql`
      UPDATE hr_employees SET
        is_active = false,
        exit_date = ${offboardDate},
        exit_reason = ${reason === 'withdrawn' ? 'resignation' : 'termination'},
        updated_at = NOW()
      WHERE application_id = ${applicationId}
        AND is_active = true
    `);
    console.log(`[HR Sync] Offboarded employee from application ${applicationId}`);
  } catch (err: any) {
    console.error('[HR Sync] Failed to offboard employee:', err.message);
  }
}
