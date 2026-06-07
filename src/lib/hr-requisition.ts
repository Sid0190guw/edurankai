// Hiring Requisition workflow — per /policy/recruitment + the HR Lifecycle
// Manual §B.3. A manager raises a request to open a role; the requisition is
// approved (or rejected) by Finance + Leadership + (CPO once we have one).
// Only after final approval can the role be marked is_open=true on roles.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureRequisitionSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hiring_requisitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_user_id UUID,
        requester_name VARCHAR(200) NOT NULL,
        role_title VARCHAR(200) NOT NULL,
        department VARCHAR(120),
        level VARCHAR(40),
        engagement_type VARCHAR(40),
          -- permanent | fixed_term | intern | contractor | eor | consultant
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
    } catch (_) {}
  })();
  return ready;
}

export const ENGAGEMENT_TYPES = {
  permanent:  { label: 'Permanent employee', description: 'Direct full-time hire on our payroll' },
  fixed_term: { label: 'Fixed-term contract', description: 'Defined-end employment (e.g. 6/12 months)' },
  intern:     { label: 'Paid intern',         description: 'Stipend-paid intern; paid-intern-to-FT pipeline' },
  contractor: { label: 'Independent contractor', description: 'Genuine contractor — pay on invoice, NO control over hours/tools' },
  eor:        { label: 'EOR-employed (foreign)', description: 'Senior specialist abroad via Employer-of-Record partner' },
  consultant: { label: 'Consultant / advisor', description: 'Short engagement, advisory work' },
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

export async function decideRequisition(opts: { id: string; level: 'finance' | 'leadership'; userId: string; approve: boolean; notes?: string; rejectReason?: string }) {
  await ensureRequisitionSchema();
  if (!opts.approve) {
    await db.execute(sql`UPDATE hiring_requisitions SET status='rejected', rejection_reason=${opts.rejectReason || opts.notes || 'No reason given'}, rejected_at=NOW(), updated_at=NOW() WHERE id=${opts.id}`);
    return { ok: true };
  }
  if (opts.level === 'finance') {
    await db.execute(sql`UPDATE hiring_requisitions SET status='pending_leadership', finance_approved_by=${opts.userId}, finance_approved_at=NOW(), finance_notes=${opts.notes || null}, updated_at=NOW() WHERE id=${opts.id}`);
  } else {
    await db.execute(sql`UPDATE hiring_requisitions SET status='approved', leadership_approved_by=${opts.userId}, leadership_approved_at=NOW(), leadership_notes=${opts.notes || null}, updated_at=NOW() WHERE id=${opts.id}`);
  }
  return { ok: true };
}

export async function listRequisitions(filterStatus?: string) {
  await ensureRequisitionSchema();
  return rows(await db.execute(sql`SELECT * FROM hiring_requisitions ${filterStatus ? sql`WHERE status=${filterStatus}` : sql``} ORDER BY created_at DESC LIMIT 200`));
}
