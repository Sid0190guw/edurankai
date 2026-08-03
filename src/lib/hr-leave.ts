// HRMS leave management. Employees apply for leave against an annual allowance
// per type; requests are approved or rejected by whoever holds `leave.approve`, or by that
// employee's own reporting manager (same permission chain as payouts). Self-bootstrapping.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { approverRole, holdsHrCapability } from '@/lib/hr-wallet';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function safe(q: any): Promise<any[]> { try { return rows(await db.execute(q)); } catch { return []; } }

export const LEAVE_TYPES = [
  { id: 'casual', name: 'Casual', allowance: 12 },
  { id: 'sick', name: 'Sick', allowance: 12 },
  { id: 'earned', name: 'Earned / privilege', allowance: 15 },
  { id: 'unpaid', name: 'Unpaid', allowance: 0 },
];
const TYPE_IDS = new Set(LEAVE_TYPES.map((t) => t.id));

let ready: Promise<void> | null = null;
export function ensureLeaveSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_leave_request (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        leave_type TEXT NOT NULL,
        start_date DATE NOT NULL, end_date DATE NOT NULL, days INT NOT NULL,
        reason TEXT, status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|cancelled
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_by UUID, decided_by_role TEXT, decided_at TIMESTAMPTZ, decision_note TEXT)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_leave_status ON hr_leave_request (status, requested_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_leave_emp ON hr_leave_request (employee_id, start_date DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

function daysBetween(a: string, b: string): number {
  const d1 = new Date(a + 'T00:00:00'), d2 = new Date(b + 'T00:00:00');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime()) || d2 < d1) return 0;
  return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
}

export interface LeaveBalance { id: string; name: string; allowance: number; used: number; pending: number; remaining: number; }
export async function getBalances(employeeId: string, year?: number): Promise<LeaveBalance[]> {
  await ensureLeaveSchema();
  const y = year || new Date().getFullYear();
  const agg = await safe(sql`SELECT leave_type,
      COALESCE(SUM(CASE WHEN status='approved' THEN days ELSE 0 END),0)::int AS used,
      COALESCE(SUM(CASE WHEN status='pending' THEN days ELSE 0 END),0)::int AS pending
    FROM hr_leave_request WHERE employee_id = ${employeeId} AND EXTRACT(YEAR FROM start_date) = ${y} GROUP BY leave_type`);
  const map: Record<string, any> = {}; agg.forEach((r) => { map[r.leave_type] = r; });
  return LEAVE_TYPES.map((t) => {
    const used = Number(map[t.id]?.used || 0), pending = Number(map[t.id]?.pending || 0);
    return { id: t.id, name: t.name, allowance: t.allowance, used, pending, remaining: t.allowance ? Math.max(0, t.allowance - used - pending) : Infinity as any };
  });
}

export async function applyLeave(employeeId: string, type: string, start: string, end: string, reason: string): Promise<{ ok: boolean; error?: string; days?: number }> {
  await ensureLeaveSchema();
  if (!TYPE_IDS.has(type)) return { ok: false, error: 'Pick a leave type.' };
  const days = daysBetween(start, end);
  if (days <= 0) return { ok: false, error: 'Enter a valid date range (end on or after start).' };
  const meta = LEAVE_TYPES.find((t) => t.id === type)!;
  if (meta.allowance > 0) {
    const bal = (await getBalances(employeeId, new Date(start + 'T00:00:00').getFullYear())).find((b) => b.id === type)!;
    if (days > bal.remaining) return { ok: false, error: `Only ${bal.remaining} ${meta.name.toLowerCase()} day(s) remaining this year.` };
  }
  await db.execute(sql`INSERT INTO hr_leave_request (employee_id, leave_type, start_date, end_date, days, reason) VALUES (${employeeId}, ${type}, ${start}, ${end}, ${days}, ${reason || null})`);
  return { ok: true, days };
}

export async function listLeave(opts: { employeeId?: string; status?: string } = {}): Promise<any[]> {
  await ensureLeaveSchema();
  if (opts.employeeId) return safe(sql`SELECT * FROM hr_leave_request WHERE employee_id = ${opts.employeeId} ORDER BY start_date DESC LIMIT 60`);
  return safe(sql`SELECT l.*, e.full_name, e.employee_code, e.designation
    FROM hr_leave_request l LEFT JOIN hr_employees e ON l.employee_id = e.id
    ${opts.status ? sql`WHERE l.status = ${opts.status}` : sql``}
    ORDER BY (l.status='pending') DESC, l.start_date DESC LIMIT 120`);
}

/**
 * Leave requests THIS person can actually decide.
 *
 * listLeave() answers "one employee's requests" or "every request with this status" — neither of
 * which tells an approver what is waiting on THEM. Without this, a reporting manager has to read a
 * list of everyone's pending leave and work out by hand which rows they are allowed to act on, so
 * cover never gets arranged because nobody knows they are the blocker.
 *
 * The authority test is the same one decideLeave() enforces, expressed in SQL rather than repeated
 * in prose: whoever holds `leave.approve` sees every pending request; everyone else sees only the
 * requests of employees whose reporting_manager_id is their own USERS id. Anyone else sees nothing.
 *
 * Deciding is still re-checked by decideLeave() through approverRole(). This function decides what
 * to SHOW; it is never the permission itself. A list is not an authorisation.
 */
export async function pendingLeaveForApprover(user: any): Promise<any[]> {
  if (!user?.id) return [];
  await ensureLeaveSchema();

  // WAS `role === 'super_admin' || role === 'admin' || role === 'hr'`, and before that the substring
  // test `role.indexOf('hr') >= 0` that handed leave approval to any role merely spelled with those
  // two letters. Same people as the exact-match version, asked as a capability: PERMS_BY_ROLE grants
  // leave.approve to exactly super_admin and hr, and 'admin' is not a value of userRoleEnum
  // (src/lib/db/schema.ts:10-16) so that arm could never match an account. can() needs no database,
  // so this list still answers correctly during an outage — and it fails closed, not open.
  const seesAll = holdsHrCapability(user, 'leave.approve');

  try {
    if (seesAll) {
      return rows(await db.execute(sql`
        SELECT l.*, e.full_name, e.employee_code, e.designation
          FROM hr_leave_request l
          LEFT JOIN hr_employees e ON e.id = l.employee_id
         WHERE l.status = 'pending'
         ORDER BY l.start_date ASC
         LIMIT 120`));
    }
    // reporting_manager_id holds a USERS id, not an hr_employees id — the same column and the same
    // comparison approverRole() makes. Compared as text because the column is UUID here and a slug
    // elsewhere in this schema; ::uuid would throw on the latter.
    return rows(await db.execute(sql`
      SELECT l.*, e.full_name, e.employee_code, e.designation
        FROM hr_leave_request l
        JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.status = 'pending'
         AND e.reporting_manager_id::text = ${String(user.id)}
       ORDER BY l.start_date ASC
       LIMIT 120`));
  } catch (e: any) {
    // Fail closed: an approver seeing nothing is a missed notification; an approver seeing everyone
    // else's leave is a data leak.
    console.error('[hr-leave] pendingLeaveForApprover', e?.cause?.message || e?.message);
    return [];
  }
}

export async function cancelLeave(id: string, employeeId: string): Promise<void> {
  await ensureLeaveSchema();
  await db.execute(sql`UPDATE hr_leave_request SET status='cancelled' WHERE id = ${id} AND employee_id = ${employeeId} AND status='pending'`).catch(() => {});
}

export async function decideLeave(id: string, user: any, decision: 'approved' | 'rejected', note: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLeaveSchema();
  const l = (await safe(sql`SELECT * FROM hr_leave_request WHERE id = ${id} LIMIT 1`))[0];
  if (!l) return { ok: false, error: 'Request not found.' };
  if (l.status !== 'pending') return { ok: false, error: 'Already ' + l.status + '.' };
  // THE ENFORCEMENT. pendingLeaveForApprover() decides what to SHOW; this decides what may be DONE.
  // Two checks on one rule are only a problem when they can diverge — this is the one that binds.
  const role = await approverRole(user, l.employee_id, 'leave.approve');
  if (!role) return { ok: false, error: 'You are not permitted to decide this request.' };
  await db.execute(sql`UPDATE hr_leave_request SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id}`);

  // Approving leave has to reach attendance, or the two modules disagree about the same day:
  // payroll counts attendance, so an approved leave day with no attendance row was counted as
  // nothing at all, and a day the employee had been told to take off could be read as absence.
  if (decision === 'approved') await markLeaveAttendance(l);

  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: String(user.id), action: 'hr.leave.' + decision, entity: 'hr_leave_request', entityId: String(id),
      diff: { employeeId: l.employee_id, leaveType: l.leave_type, days: l.days, from: l.start_date, to: l.end_date, byRole: role, note: note || null },
    });
  } catch (_) {}

  return { ok: true };
}

/**
 * Write one attendance row per day of an approved leave, status 'on_leave'.
 *
 * Marks every calendar day in the range, which is deliberately consistent with how `days` is
 * counted when the leave is applied for (daysBetween is calendar days, not working days).
 * A day the employee actually worked is left alone — present/wfh wins over on_leave, so a
 * back-dated approval can never erase real attendance.
 */
export async function markLeaveAttendance(l: any): Promise<number> {
  const start = new Date(String(l.start_date).slice(0, 10) + 'T00:00:00');
  const end = new Date(String(l.end_date).slice(0, 10) + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;
  // Guard against an absurd range creating thousands of rows.
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (span > 400) return 0;

  const note = 'Approved ' + String(l.leave_type || 'leave') + ' leave';
  let written = 0;
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    try {
      await db.execute(sql`
        INSERT INTO hr_attendance (employee_id, date, status, work_mode, notes)
        VALUES (${l.employee_id}, ${iso}, 'on_leave', 'leave', ${note})
        ON CONFLICT (employee_id, date) DO UPDATE
          SET status = 'on_leave', notes = ${note}
          WHERE hr_attendance.status NOT IN ('present', 'wfh')`);
      written++;
    } catch (_) { /* one bad day must not abort the approval */ }
  }
  return written;
}
