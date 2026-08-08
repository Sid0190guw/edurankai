// Employee flagging system per Recruitment & Work Policy v2.0.
// Three severity levels. Three-strike rule on Level 1 auto-escalates to L2.
// All flags written are immutable (no edits, no deletes) — only superseded.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[hr-flags] ' + tag, e?.cause?.message || e?.message);

/**
 * Create the flag table if it is absent. Idempotent, safe on every call.
 *
 * WAS a hand-rolled `let ready` memo with `catch (_) {}` inside it. That combination is worse than
 * either half: the failure was never logged, AND the resolved promise was cached for the lifetime of
 * the process, so one transient DDL error meant every flag screen showed an empty list and every
 * raiseFlag() failed for as long as the server ran, with nothing anywhere saying why. ensureOnce()
 * drops a failed run from its cache so the next request retries; the catch below names the reason
 * and re-throws so that drop actually happens.
 */
export function ensureFlagsSchema(): Promise<void> {
  return ensureOnce('hr_flags_v1', async () => {
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
    } catch (e: any) {
      logFail('ensureFlagsSchema', e);
      throw e;
    }
  });
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
    // e.message for a drizzle/postgres-js failure is only the SQL that was attempted; the actual
    // reason ("null value in column ... violates not-null constraint") lives on e.cause. Returning
    // the SQL told whoever raised the flag nothing at all about why it did not save.
    logFail('raiseFlag', e);
    return { ok: false, error: String(e?.cause?.message || e?.message || 'db error').slice(0, 400) };
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

export const APPEAL_STATUSES = ['pending', 'upheld', 'modified', 'overturned'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const APPEAL_LABELS: Record<AppealStatus, string> = {
  pending: 'Appeal lodged, awaiting decision',
  upheld: 'Appeal rejected — the flag stands',
  modified: 'Appeal partly accepted — the flag was modified',
  overturned: 'Appeal accepted — the flag is overturned',
};

/**
 * Decide an appeal against a flag.
 *
 * THIS WAS THE ONLY WRITER OF AN APPEAL OUTCOME AND NOTHING CALLED IT. The module's single consumer
 * was /admin/hr/employees/[id].astro, which imports raiseFlag and listFlags and neither of the two
 * functions below. So a Level 3 breach flag — the kind whose recorded action is "immediate
 * termination, no certificate, legal action possible" — could be raised against a named employee and
 * its appeal could never be decided by any screen in the product. appeal_status and appeal_notes
 * were columns that could only ever hold NULL.
 *
 * /admin/hr/flags now calls this. A decision needs a written reason: an appeal outcome recorded with
 * no rationale is exactly the record that cannot be defended to the person it is about.
 */
export async function setAppealStatus(
  flagId: string,
  status: AppealStatus,
  notes: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!flagId) return { ok: false, error: 'No flag was identified.' };
  if (!(APPEAL_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'Unknown appeal outcome.' };
  }
  const note = String(notes || '').trim();
  if (status !== 'pending' && note.length < 15) {
    return { ok: false, error: 'Give the reason for this decision, in at least 15 characters. An appeal outcome with no rationale on the record cannot be defended to the person it is about.' };
  }
  try {
    await ensureFlagsSchema();
    const r = rows(await db.execute(sql`
      UPDATE hr_employee_flags SET appeal_status = ${status}, appeal_notes = ${note.slice(0, 4000) || null}
      WHERE id = ${flagId}::uuid
      RETURNING id`));
    if (r.length === 0) return { ok: false, error: 'That flag no longer exists, so nothing was decided.' };
    return { ok: true };
  } catch (e: any) {
    logFail('setAppealStatus', e);
    return { ok: false, error: String(e?.cause?.message || e?.message || 'The decision was not recorded.') };
  }
}

export interface FlagRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeEmail: string | null;
  level: number;
  breachType: string;
  breachLabel: string;
  description: string;
  actionTaken: string | null;
  flaggedByName: string | null;
  isEscalation: boolean;
  appealStatus: AppealStatus | null;
  appealNotes: string | null;
  createdAt: string;
}

export type FlagsResult = { ok: true; rows: FlagRow[] } | { ok: false; reason: string };

/**
 * Every flag across the organisation, newest first — the appeals desk's read.
 *
 * Discriminated: an empty disciplinary register that actually means "the query failed" is a
 * particularly bad lie, because the screen reading it is the one deciding whether anybody has an
 * appeal outstanding.
 */
export async function recentFlags(limit = 100): Promise<FlagsResult> {
  try {
    await ensureFlagsSchema();
    const r = rows(await db.execute(sql`
      SELECT f.id, f.employee_id, f.level, f.breach_type, f.description, f.action_taken,
        f.flagged_by_name, f.is_escalation, f.appeal_status, f.appeal_notes, f.created_at,
        e.full_name AS employee_name, e.email AS employee_email
      FROM hr_employee_flags f
      LEFT JOIN hr_employees e ON e.id = f.employee_id
      ORDER BY f.created_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}
    `));
    return {
      ok: true,
      rows: r.map((x: any) => {
        const bt = String(x.breach_type || '');
        const spec = (BREACH_TYPES as Record<string, { label: string }>)[bt];
        const appeal = String(x.appeal_status || '');
        return {
          id: String(x.id),
          employeeId: String(x.employee_id),
          employeeName: x.employee_name || null,
          employeeEmail: x.employee_email || null,
          level: Number(x.level || 1),
          breachType: bt,
          // An auto-escalation row carries a breach_type that is not in the catalogue; show it
          // readably rather than blank.
          breachLabel: spec ? spec.label : bt.replace(/_/g, ' '),
          description: String(x.description || ''),
          actionTaken: x.action_taken || null,
          flaggedByName: x.flagged_by_name || null,
          isEscalation: !!x.is_escalation,
          appealStatus: (APPEAL_STATUSES as readonly string[]).includes(appeal) ? (appeal as AppealStatus) : null,
          appealNotes: x.appeal_notes || null,
          createdAt: String(x.created_at),
        };
      }),
    };
  } catch (e: any) {
    const reason = String(e?.cause?.message || e?.message || 'unknown error');
    logFail('recentFlags', e);
    return { ok: false, reason };
  }
}
