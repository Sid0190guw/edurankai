// Separation flow — per HR Lifecycle Manual Part G.
// Chains the existing flag system + PIP + exit interview + F&F + asset return
// + alumni invitation into one structured separation record.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureSeparationSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_separations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        kind VARCHAR(40) NOT NULL,
          -- resignation | performance | misconduct | retrenchment | end_of_contract | medical | death | other
        initiated_by VARCHAR(20) NOT NULL,
          -- employee | employer
        initiated_at DATE NOT NULL DEFAULT CURRENT_DATE,
        notice_days INT,
        last_working_day DATE,
        reason TEXT,
        pip_id UUID,
          -- references hr_pips when separation is performance-driven
        related_flag_id UUID,
          -- references hr_employee_flags when misconduct-driven
        status VARCHAR(20) NOT NULL DEFAULT 'notice',
          -- notice | knowledge_transfer | exit_interview | settlement | closed
        kt_complete BOOLEAN NOT NULL DEFAULT false,
        assets_returned BOOLEAN NOT NULL DEFAULT false,
        access_revoked BOOLEAN NOT NULL DEFAULT false,
        exit_interview_at TIMESTAMPTZ,
        exit_interview_notes TEXT,
        ff_amount DECIMAL(14,2),
        ff_currency VARCHAR(8) DEFAULT 'INR',
        ff_paid_at TIMESTAMPTZ,
        relieving_letter_url TEXT,
        experience_letter_url TEXT,
        alumni_invited BOOLEAN NOT NULL DEFAULT false,
        alumni_accepted BOOLEAN NOT NULL DEFAULT false,
        eligibility_for_rehire VARCHAR(20),
          -- yes | no | with_caveats
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sep_emp_idx ON hr_separations(employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sep_status_idx ON hr_separations(status, created_at DESC)`);

      // Exit interview structured responses
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_exit_interview_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        separation_id UUID NOT NULL REFERENCES hr_separations(id) ON DELETE CASCADE,
        question_key VARCHAR(80) NOT NULL,
        response TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    } catch (_) {}
  })();
  return ready;
}

export const SEP_KINDS = {
  resignation:    { label: 'Resignation',     description: 'Employee-initiated' },
  performance:    { label: 'Performance termination', description: 'After documented PIP failure' },
  misconduct:     { label: 'Misconduct termination',  description: 'After domestic inquiry' },
  retrenchment:   { label: 'Retrenchment',    description: 'Role redundancy, not the person' },
  end_of_contract:{ label: 'End of contract', description: 'Fixed-term ended' },
  medical:        { label: 'Medical separation', description: 'Long-term illness / incapacity' },
  death:          { label: 'Death in service',   description: 'Survivor benefits triggered' },
  other:          { label: 'Other',           description: '' },
};

export const EXIT_INTERVIEW_QUESTIONS = [
  { key: 'why_leaving',         label: 'Why are you leaving?' },
  { key: 'what_worked',         label: 'What worked well during your time here?' },
  { key: 'what_didnt',          label: 'What did not work? What would you change first?' },
  { key: 'manager_feedback',    label: 'Feedback for your direct manager' },
  { key: 'team_feedback',       label: 'Feedback for the team' },
  { key: 'policy_feedback',     label: 'Feedback on our policies (hiring / PIP / leave / compensation / culture)' },
  { key: 'recommend',           label: 'Would you recommend EduRankAI to a peer? Why?' },
  { key: 'alumni_engagement',   label: 'Would you stay connected via the alumni programme?' },
  { key: 'rehire_interest',     label: 'Would you consider rejoining in the future?' },
];

export async function openSeparation(opts: any) {
  await ensureSeparationSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hr_separations (employee_id, kind, initiated_by, initiated_at, notice_days, last_working_day, reason, pip_id, related_flag_id)
    VALUES (${opts.employeeId}, ${opts.kind}, ${opts.initiatedBy || 'employee'},
      ${opts.initiatedAt || sql`CURRENT_DATE`}, ${opts.noticeDays || 30}, ${opts.lastWorkingDay || null}, ${opts.reason || null},
      ${opts.pipId || null}, ${opts.relatedFlagId || null})
    RETURNING id
  `));
  return { ok: true, id: r[0]?.id };
}

export async function updateSeparation(id: string, patch: Record<string, any>) {
  await ensureSeparationSchema();
  const allowed = ['status','kt_complete','assets_returned','access_revoked','exit_interview_notes','ff_amount','ff_currency','ff_paid_at','relieving_letter_url','experience_letter_url','alumni_invited','alumni_accepted','eligibility_for_rehire','last_working_day'];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    await db.execute(sql`UPDATE hr_separations SET ${sql.raw(k)} = ${v}, updated_at = NOW() WHERE id = ${id}`);
  }
}

export async function recordExitInterview(separationId: string, responses: Record<string, string>) {
  await ensureSeparationSchema();
  for (const [k, v] of Object.entries(responses)) {
    if (!v || !v.trim()) continue;
    await db.execute(sql`INSERT INTO hr_exit_interview_responses (separation_id, question_key, response) VALUES (${separationId}, ${k}, ${v.trim().slice(0, 5000)})`);
  }
  await db.execute(sql`UPDATE hr_separations SET exit_interview_at = NOW(), status = CASE WHEN status = 'notice' OR status = 'knowledge_transfer' THEN 'settlement' ELSE status END, updated_at = NOW() WHERE id = ${separationId}`);
}

export async function listSeparations(filterStatus?: string) {
  await ensureSeparationSchema();
  return rows(await db.execute(sql`
    SELECT s.*, e.full_name AS employee_name, e.email AS employee_email
    FROM hr_separations s LEFT JOIN hr_employees e ON s.employee_id = e.id
    ${filterStatus ? sql`WHERE s.status = ${filterStatus}` : sql``}
    ORDER BY s.created_at DESC LIMIT 200
  `));
}
