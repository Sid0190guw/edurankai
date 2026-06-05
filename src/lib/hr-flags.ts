// Employee flagging system per Recruitment & Work Policy v2.0.
// Three severity levels. Three-strike rule on Level 1 auto-escalates to L2.
// All flags written are immutable (no edits, no deletes) — only superseded.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureFlagsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_employee_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 3),
        breach_type VARCHAR(80) NOT NULL,
        description TEXT NOT NULL,
        action_taken TEXT,
        flagged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        flagged_by_name VARCHAR(200),
        is_escalation BOOLEAN NOT NULL DEFAULT false,
        escalated_from_count INT,
        appeal_status VARCHAR(20),
        appeal_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_flags_emp_idx ON hr_employee_flags(employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_flags_level_idx ON hr_employee_flags(level, created_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

// Breach catalogue — exact strings from policy v2.0.
export const BREACH_TYPES = {
  // Level 1
  late_deliverable: { level: 1, label: 'Late deliverable (unreported)', action: 'Written warning · Noted in record' },
  hours_breach: { level: 1, label: 'Hours breach (over or under)', action: 'Counselling session · Written warning' },
  communication_failure: { level: 1, label: 'Communication failure', action: 'Warning · Performance review triggered' },
  // Level 2
  misrepresentation: { level: 2, label: 'Misrepresentation', action: 'Immediate review · Likely termination · No certificate' },
  plagiarism_ai_abuse: { level: 2, label: 'Plagiarism / AI abuse', action: 'Immediate review · Score voided · Possible termination' },
  unprofessional_conduct: { level: 2, label: 'Unprofessional conduct', action: 'Formal investigation · Suspension pending review' },
  // Level 3
  confidentiality_breach: { level: 3, label: 'Confidentiality breach', action: 'Immediate termination · No certificate · Legal action possible' },
  ip_theft: { level: 3, label: 'IP theft', action: 'Immediate termination · Legal proceedings' },
  undisclosed_coi: { level: 3, label: 'Conflict of interest (undisclosed)', action: 'Immediate termination · No reference provided' },
  harassment: { level: 3, label: 'Harassment or abuse', action: 'Immediate termination · Formal report · Possible legal referral' },
} as const;
export type BreachType = keyof typeof BREACH_TYPES;

export async function raiseFlag(opts: {
  employeeId: string;
  breachType: BreachType;
  description: string;
  actionTaken?: string;
  flaggedByUserId?: string;
  flaggedByName?: string;
}): Promise<{ ok: boolean; flagId?: string; autoEscalated?: boolean; error?: string }> {
  await ensureFlagsSchema();
  const spec = BREACH_TYPES[opts.breachType];
  if (!spec) return { ok: false, error: 'unknown breach type' };

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO hr_employee_flags (employee_id, level, breach_type, description, action_taken, flagged_by_user_id, flagged_by_name)
      VALUES (${opts.employeeId}, ${spec.level}, ${opts.breachType}, ${opts.description}, ${opts.actionTaken || spec.action}, ${opts.flaggedByUserId || null}, ${opts.flaggedByName || null})
      RETURNING id
    `));
    const flagId = ins[0]?.id;

    // Three-strike rule — three Level 1 breaches within the engagement
    // auto-escalate to a Level 2 review (a separate flag row marking it).
    let autoEscalated = false;
    if (spec.level === 1) {
      const l1count = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_employee_flags
        WHERE employee_id = ${opts.employeeId} AND level = 1
      `))[0]?.n || 0;
      if (l1count >= 3 && l1count % 3 === 0) {
        await db.execute(sql`
          INSERT INTO hr_employee_flags (employee_id, level, breach_type, description, action_taken, flagged_by_name, is_escalation, escalated_from_count)
          VALUES (${opts.employeeId}, 2, 'three_strike_escalation', 'Automatic escalation — 3 Level 1 breaches accumulated within engagement period (Recruitment & Work Policy §05 three-strike rule).', 'Formal Level 2 review triggered. HR + line manager to convene.', 'System (auto-escalation)', true, ${l1count})
        `);
        autoEscalated = true;
      }
    }

    return { ok: true, flagId, autoEscalated };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'db error' };
  }
}

export async function listFlags(employeeId: string) {
  await ensureFlagsSchema();
  return rows(await db.execute(sql`
    SELECT id, level, breach_type, description, action_taken, flagged_by_name,
      is_escalation, escalated_from_count, appeal_status, appeal_notes, created_at
    FROM hr_employee_flags WHERE employee_id = ${employeeId}
    ORDER BY created_at DESC
  `));
}

export async function setAppealStatus(flagId: string, status: 'pending' | 'upheld' | 'modified' | 'overturned', notes: string) {
  await ensureFlagsSchema();
  await db.execute(sql`UPDATE hr_employee_flags SET appeal_status = ${status}, appeal_notes = ${notes} WHERE id = ${flagId}`);
}

export async function recentFlags(limit = 50) {
  await ensureFlagsSchema();
  return rows(await db.execute(sql`
    SELECT f.id, f.employee_id, f.level, f.breach_type, f.description, f.action_taken,
      f.flagged_by_name, f.is_escalation, f.appeal_status, f.created_at,
      e.full_name AS employee_name, e.email AS employee_email
    FROM hr_employee_flags f
    LEFT JOIN hr_employees e ON e.id = f.employee_id
    ORDER BY f.created_at DESC LIMIT ${limit}
  `));
}
