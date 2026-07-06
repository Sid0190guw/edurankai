// HRMS leave management. Employees apply for leave against an annual allowance
// per type; requests are approved or rejected by the reporting manager, HR head,
// admin or super-admin (same permission chain as payouts). Self-bootstrapping.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { approverRole } from '@/lib/hr-wallet';

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

export async function cancelLeave(id: string, employeeId: string): Promise<void> {
  await ensureLeaveSchema();
  await db.execute(sql`UPDATE hr_leave_request SET status='cancelled' WHERE id = ${id} AND employee_id = ${employeeId} AND status='pending'`).catch(() => {});
}

export async function decideLeave(id: string, user: any, decision: 'approved' | 'rejected', note: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLeaveSchema();
  const l = (await safe(sql`SELECT * FROM hr_leave_request WHERE id = ${id} LIMIT 1`))[0];
  if (!l) return { ok: false, error: 'Request not found.' };
  if (l.status !== 'pending') return { ok: false, error: 'Already ' + l.status + '.' };
  const role = await approverRole(user, l.employee_id);
  if (!role) return { ok: false, error: 'You are not permitted to decide this request.' };
  await db.execute(sql`UPDATE hr_leave_request SET status = ${decision}, decided_by = ${user.id}, decided_by_role = ${role}, decided_at = NOW(), decision_note = ${note || null} WHERE id = ${id}`);
  return { ok: true };
}
