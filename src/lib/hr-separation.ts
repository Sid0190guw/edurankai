// Separation flow — per HR Lifecycle Manual Part G.
// Chains the existing flag system + PIP + exit interview + F&F + asset return
// + alumni invitation into one structured separation record.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  getDirectReports,
  getManager,
  getRelationshipHistory,
  closeRelationship,
  supersedeReportingManager,
  isInitialized as orgGraphInitialized,
} from '@/lib/org-graph';
import { startWorkflow, getInstance } from '@/lib/workflow';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/**
 * hr_separations AND hr_exit_interview_responses. Inside an ensureOnce guard rather than a
 * hand-rolled module-level promise, for the two reasons ensureExitSchema() below already documents
 * and this function used to be the counter-example to:
 *
 *   1. `let ready` was assigned once and never cleared, so ONE transient DDL failure at cold start
 *      resolved anyway and was cached for the life of the process. Every later call returned the
 *      poisoned promise without retrying — the separations console stayed broken until a redeploy.
 *   2. `catch (_) {}` logged nothing, so the screens that then found no table showed an empty list
 *      and nobody could tell "nobody has left" from "the table was never created".
 *
 * ensureOnce() drops the cache entry when the callback rejects, which is why the catch RE-THROWS
 * after logging, and then swallows the rejection for the CALLER — so the signature stays
 * Promise<void> and every existing caller behaves exactly as before.
 *
 * ensureExitSchema() awaits this before ALTERing hr_separations, and reports its own failure with a
 * sentence, so a genuinely absent table is now visible rather than silent at both levels.
 */
export function ensureSeparationSchema(): Promise<void> {
  return ensureOnce('hr_separation_core_v1', async () => {
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
    } catch (e: any) {
      // NAMED, NEVER SILENT. The real Postgres reason is on e.cause; e.message is only the failed
      // SQL. console.error rather than logSepFail() because that helper is a `const` declared
      // further down this file and `const` is not hoisted.
      console.error('[hr-separation] ensureSeparationSchema:', String(e?.cause?.message || e?.message || 'unknown error'));
      throw e; // ensureOnce drops the failed run, so the next call retries instead of staying broken.
    }
  });
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

  // Someone is leaving. This one interrupts rather than waiting for the digest: a separation
  // starts clocks that other people have to act on inside a fixed window — final attendance and
  // credit, access revocation, the completion letter — and finding out the next morning has
  // already cost a day of that window.
  try {
    const { record } = await import('@/lib/activity-feed');
    await record('hr.separation_started', {
      id: r[0]?.id, employeeId: opts.employeeId, kind: opts.kind,
      initiatedBy: opts.initiatedBy || 'employee', lastWorkingDay: opts.lastWorkingDay || null,
    }, { actorId: opts.actorId || null });
  } catch (_) { /* the separation is committed; the notification is secondary */ }

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

// =================================================================================================
// EXIT: APPROVAL, CLEARANCE, AND THE CLOSING OF THE ORGANIZATION GRAPH
// =================================================================================================
//
// Everything above this line records that somebody is leaving. Everything below decides whether the
// exit may proceed, checks that each function has released them, and then CLOSES their place in the
// organization — which is the part that must not be a DELETE.
//
// WHY EDGES ARE CLOSED AND NEVER DELETED. "Who approved this last March" is answered by reading the
// graph AS OF that date. Deleting a leaver's edges erases them from every past date at once, so
// every approval they ever made becomes an approval by nobody. Closing an edge sets effective_to and
// leaves status 'active' — the row keeps answering for every date inside its range and stops
// answering after it. That is the whole reason the graph is a table of rows.
//
// AND WHY THEIR REPORTS ARE REASSIGNED FIRST. A leaver with direct reports whose edges are simply
// closed leaves those people reporting to nobody: their leave routes to nobody, their approvals halt,
// and the first anyone hears of it is a request that never moved. So reassignment is a PRECONDITION
// of completing an exit, not a follow-up task, and completeSeparation() refuses rather than guessing
// who should pick them up.

const SEP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSepUuid = (v: unknown): v is string => typeof v === 'string' && SEP_UUID_RE.test(v);

const sepReasonOf = (e: any): string =>
  String(e?.cause?.message || e?.message || 'unknown database error');

const logSepFail = (tag: string, e: any) => console.error('[hr-separation] ' + tag, sepReasonOf(e));

/**
 * THE CLEARANCE CHECKLIST. Four functions, each of which has to say the person is released before
 * the exit can complete.
 *
 * These are AREAS OF RESPONSIBILITY, not role names and not capabilities. Who signs off IT clearance
 * is decided by whoever holds the console, exactly as it is today for every other HR action; this
 * list only records that the question was asked and answered, and by whom.
 */
export const CLEARANCE_AREAS = [
  { key: 'it', label: 'IT', note: 'Accounts disabled, devices wiped, access revoked.' },
  { key: 'finance', label: 'Finance', note: 'Advances, reimbursements and dues settled.' },
  { key: 'hr', label: 'HR', note: 'Records, letters and leave balance closed off.' },
  { key: 'assets', label: 'Assets', note: 'Every issued item returned or written off.' },
] as const;

export type ClearanceAreaKey = (typeof CLEARANCE_AREAS)[number]['key'];

const CLEARANCE_KEYS = new Set<string>(CLEARANCE_AREAS.map((a) => a.key));

export type ClearanceStatus = 'pending' | 'cleared' | 'blocked';

export interface SeparationResult {
  ok: boolean;
  id?: string;
  error?: string;
  haltReason?: string | null;
  changed?: boolean;
  /** Every unmet condition, so a screen can list them all rather than revealing one per attempt. */
  blockers?: string[];
}

/**
 * The columns and the table this phase adds. Separate ensureOnce guard from ensureSeparationSchema()
 * above, which predates this work and swallows its own failures — hanging new DDL off it would let a
 * failure here silently disable the existing separations console too.
 */
export function ensureExitSchema(): Promise<void> {
  return ensureOnce('hr_separation_exit_v1', async () => {
    try {
      await ensureSeparationSchema(); // hr_separations must exist before it can be altered.

      // One statement per column: a multi-clause ALTER rolls the whole statement back if any single
      // clause fails, and these are the columns the exit gate reads.
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS workflow_instance_id UUID`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS approval_state VARCHAR(20) NOT NULL DEFAULT 'not_requested'`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS halt_reason TEXT`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS settlement_reference TEXT`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS settlement_handoff_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS reports_reassigned_to UUID`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS reports_reassigned_count INT`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS graph_closed_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS graph_edges_closed INT`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS closed_by_user_id UUID`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_separations ADD COLUMN IF NOT EXISTS requested_by_user_id UUID`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_separation_clearance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        separation_id UUID NOT NULL REFERENCES hr_separations(id) ON DELETE CASCADE,
        area VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        note TEXT,
        decided_by_user_id UUID,
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // ONE ROW PER AREA PER SEPARATION, enforced by the database rather than only by this file. A
      // second code path cannot then produce two conflicting IT sign-offs on one exit.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_sep_clearance_uniq
        ON hr_separation_clearance(separation_id, area)`);
    } catch (e: any) {
      logSepFail('ensureExitSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries.
    }
  });
}

// ------------------------------------------------------------------------------------------------
// APPROVAL — routed through the one engine, never decided here
// ------------------------------------------------------------------------------------------------

/**
 * Send a separation for approval. Records nothing about the outcome; the engine owns that.
 *
 * A separation that is APPROVED is authorised to proceed. It is not finished — completeSeparation()
 * is a separate, explicit act, because clearance and the closing of the graph happen after somebody
 * has agreed the person is leaving, not instead of it.
 */
export async function requestSeparationApproval(
  separationId: string,
  requestedByUserId: string | null,
): Promise<SeparationResult> {
  if (!isSepUuid(separationId)) return { ok: false, error: 'That separation could not be identified.' };
  const requestedBy = isSepUuid(requestedByUserId) ? String(requestedByUserId) : null;

  try {
    await ensureExitSchema();

    const cur = rows(await db.execute(sql`
      SELECT s.*, e.full_name AS employee_name
        FROM hr_separations s LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.id = ${separationId}::uuid LIMIT 1`));
    if (!cur.length) return { ok: false, error: 'That separation could not be found.' };
    const sep = cur[0] as any;

    if (sep.workflow_instance_id) {
      return { ok: true, id: separationId, changed: false };
    }

    const wf = await startWorkflow({
      domain: 'separation',
      recordId: separationId,
      subjectEmployeeId: String(sep.employee_id),
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary:
        'Separation for ' + (sep.employee_name || 'an employee')
        + (sep.last_working_day ? ', last working day ' + String(sep.last_working_day).slice(0, 10) : ''),
    });

    if (!wf.ok) {
      await db.execute(sql`
        UPDATE hr_separations
           SET approval_state = 'halted',
               halt_reason = ${String(wf.error || 'The approval could not be started.')},
               requested_by_user_id = COALESCE(requested_by_user_id, ${requestedBy}::uuid),
               updated_at = NOW()
         WHERE id = ${separationId}::uuid`);
      return { ok: false, id: separationId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_separations
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             approval_state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             requested_by_user_id = COALESCE(requested_by_user_id, ${requestedBy}::uuid),
             updated_at = NOW()
       WHERE id = ${separationId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'separation.approval_requested',
      entity: 'hr_separation',
      entityId: separationId,
      diff: {
        employeeId: String(sep.employee_id), workflowInstanceId: wf.instanceId || null,
        state: halted ? 'halted' : 'pending', haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: separationId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logSepFail('requestSeparationApproval', e);
    return { ok: false, error: 'The approval was not started: ' + sepReasonOf(e) };
  }
}

/** Mirror the engine's decisions onto separations. Decides nothing; reads decisions back. */
export async function syncSeparationApprovals(): Promise<{ settled: number; errors: string[] }> {
  const out = { settled: 0, errors: [] as string[] };
  try {
    await ensureExitSchema();
    const open = rows(await db.execute(sql`
      SELECT id, workflow_instance_id, approval_state FROM hr_separations
       WHERE workflow_instance_id IS NOT NULL
         AND approval_state IN ('pending', 'halted')
       ORDER BY created_at ASC LIMIT 100`));

    for (const raw of open) {
      const id = String((raw as any).id);
      const instanceId = String((raw as any).workflow_instance_id || '');
      if (!instanceId) continue;
      let instance = null as Awaited<ReturnType<typeof getInstance>>;
      try {
        instance = await getInstance(instanceId);
      } catch (e: any) {
        logSepFail('syncSeparationApprovals.getInstance', e);
        out.errors.push('An approval could not be read: ' + sepReasonOf(e));
        continue;
      }
      if (!instance) continue;

      let next: string | null = null;
      if (instance.state === 'approved') next = 'approved';
      else if (instance.state === 'rejected') next = 'rejected';
      else if (instance.state === 'cancelled') next = 'cancelled';
      else if (instance.state === 'halted') next = 'halted';
      else if (instance.state === 'pending') next = 'pending';
      if (!next || next === String((raw as any).approval_state)) continue;

      try {
        await db.execute(sql`
          UPDATE hr_separations
             SET approval_state = ${next}, halt_reason = ${instance.haltReason}::text, updated_at = NOW()
           WHERE id = ${id}::uuid`);
        out.settled += 1;
      } catch (e: any) {
        logSepFail('syncSeparationApprovals.write', e);
        out.errors.push('A decision could not be written down: ' + sepReasonOf(e));
      }
    }
  } catch (e: any) {
    logSepFail('syncSeparationApprovals', e);
    out.errors.push('The approvals could not be read: ' + sepReasonOf(e));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// CLEARANCE
// ------------------------------------------------------------------------------------------------

export interface ClearanceRow {
  area: string;
  status: string;
  note: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

/** The four areas for one separation, always all four — a missing row reads as 'pending'. */
export async function clearanceFor(separationId: string): Promise<ClearanceRow[]> {
  const base: ClearanceRow[] = CLEARANCE_AREAS.map((a) => ({
    area: a.key, status: 'pending', note: null, decidedByUserId: null, decidedAt: null,
  }));
  if (!isSepUuid(separationId)) return base;
  try {
    await ensureExitSchema();
    const r = rows(await db.execute(sql`
      SELECT area, status, note, decided_by_user_id, decided_at
        FROM hr_separation_clearance WHERE separation_id = ${separationId}::uuid`));
    for (const row of r) {
      const found = base.find((b) => b.area === String((row as any).area));
      if (!found) continue;
      found.status = String((row as any).status || 'pending');
      found.note = (row as any).note ? String((row as any).note) : null;
      found.decidedByUserId = (row as any).decided_by_user_id ? String((row as any).decided_by_user_id) : null;
      found.decidedAt = (row as any).decided_at ? new Date((row as any).decided_at).toISOString() : null;
    }
    return base;
  } catch (e: any) {
    logSepFail('clearanceFor', e);
    return base; // fail closed: everything unpending means nothing is cleared, so nothing completes.
  }
}

/** Record one function's sign-off. Upsert on (separation_id, area) — one answer per area. */
export async function setClearance(opts: {
  separationId: string;
  area: string;
  status: ClearanceStatus;
  note?: string | null;
  decidedByUserId?: string | null;
}): Promise<SeparationResult> {
  if (!isSepUuid(opts?.separationId)) return { ok: false, error: 'That separation could not be identified.' };
  const area = String(opts?.area || '').trim();
  if (!CLEARANCE_KEYS.has(area)) return { ok: false, error: 'That is not a clearance area we track.' };
  const status = String(opts?.status || '');
  if (status !== 'pending' && status !== 'cleared' && status !== 'blocked') {
    return { ok: false, error: 'That is not a clearance outcome we record.' };
  }
  if (status === 'blocked' && !String(opts?.note || '').trim()) {
    return { ok: false, error: 'Say what is blocking this clearance — the person leaving has to be told something.' };
  }
  const note = opts?.note ? String(opts.note).slice(0, 2000) : null;
  const by = isSepUuid(opts?.decidedByUserId) ? String(opts.decidedByUserId) : null;

  try {
    await ensureExitSchema();
    await db.execute(sql`
      INSERT INTO hr_separation_clearance (separation_id, area, status, note, decided_by_user_id, decided_at)
      VALUES (${opts.separationId}::uuid, ${area}, ${status}, ${note}::text, ${by}::uuid, NOW())
      ON CONFLICT (separation_id, area) DO UPDATE
        SET status = EXCLUDED.status, note = EXCLUDED.note,
            decided_by_user_id = EXCLUDED.decided_by_user_id,
            decided_at = NOW(), updated_at = NOW()`);

    await logAudit({
      userId: by,
      action: 'separation.clearance',
      entity: 'hr_separation',
      entityId: opts.separationId,
      diff: { area, status, note },
    });
    return { ok: true, id: opts.separationId, changed: true };
  } catch (e: any) {
    logSepFail('setClearance', e);
    return { ok: false, error: 'The clearance was not recorded: ' + sepReasonOf(e) };
  }
}

/** Record that final settlement has been handed to whoever pays it. A handoff, not a payment. */
export async function recordSettlementHandoff(opts: {
  separationId: string;
  amount?: number | null;
  reference: string;
  actorUserId?: string | null;
}): Promise<SeparationResult> {
  if (!isSepUuid(opts?.separationId)) return { ok: false, error: 'That separation could not be identified.' };
  const reference = String(opts?.reference || '').trim().slice(0, 300);
  if (!reference) {
    return { ok: false, error: 'Record where the settlement was handed off — a reference somebody can follow.' };
  }
  const amount = typeof opts?.amount === 'number' && isFinite(opts.amount) && opts.amount >= 0 ? opts.amount : null;
  const by = isSepUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;
  try {
    await ensureExitSchema();
    await db.execute(sql`
      UPDATE hr_separations
         SET settlement_reference = ${reference},
             ff_amount = COALESCE(${amount}::numeric, ff_amount),
             settlement_handoff_at = NOW(), updated_at = NOW()
       WHERE id = ${opts.separationId}::uuid`);
    await logAudit({
      userId: by,
      action: 'separation.settlement_handoff',
      entity: 'hr_separation',
      entityId: opts.separationId,
      diff: { reference, amount },
    });
    return { ok: true, id: opts.separationId, changed: true };
  } catch (e: any) {
    logSepFail('recordSettlementHandoff', e);
    return { ok: false, error: 'The handoff was not recorded: ' + sepReasonOf(e) };
  }
}

// ------------------------------------------------------------------------------------------------
// COMPLETION — the org-graph closing act
// ------------------------------------------------------------------------------------------------

/**
 * WHY THERE ARE CODES AS WELL AS SENTENCES.
 *
 * completeSeparation() has to treat two of these differently from the rest — the direct-reports one
 * is answerable in the same request by naming a new manager, and the empty-graph one does not block
 * closing an employee record at all. Deciding that by pattern-matching the ENGLISH ("does this
 * sentence contain the word report") works until somebody rewords a message, at which point a
 * blocker silently stops blocking and an exit closes with people still pointing at a ghost. The code
 * is what the logic reads; the sentence is only ever shown to a person.
 */
export type ExitBlockerCode =
  | 'not-found'
  | 'already-closed'
  | 'not-approved'
  | 'no-last-working-day'
  | 'clearance'
  | 'no-exit-interview'
  | 'no-settlement'
  | 'graph-not-initialized'
  | 'direct-reports'
  | 'read-failed';

export interface ExitBlocker {
  code: ExitBlockerCode;
  message: string;
}

export interface ExitReadiness {
  ready: boolean;
  /** Sentences, in the order a person should read them. */
  blockers: string[];
  /** The same list, machine-readable. See ExitBlockerCode. */
  blockerDetail: ExitBlocker[];
  /** People currently reporting to the leaver, from the graph. Must be reassigned before closing. */
  directReports: { employeeId: string | null; fullName: string | null }[];
  /** The leaver's own manager, offered as the default place their reports land. Never applied
   *  silently — the operator has to choose it. */
  suggestedNewManager: { employeeId: string | null; fullName: string | null } | null;
  graphInitialized: boolean;
}

/**
 * Everything standing between this separation and being closed, listed at once.
 *
 * ALL of them, not the first one. Revealing blockers one attempt at a time turns a five-minute task
 * into five round trips through HR, and the person leaving is waiting on every one of them.
 */
export async function exitReadiness(separationId: string): Promise<ExitReadiness> {
  const out: ExitReadiness = {
    ready: false, blockers: [], blockerDetail: [], directReports: [],
    suggestedNewManager: null, graphInitialized: false,
  };
  const block = (code: ExitBlockerCode, message: string) => {
    out.blockerDetail.push({ code, message });
    out.blockers.push(message);
  };

  if (!isSepUuid(separationId)) {
    block('not-found', 'That separation could not be identified.');
    return out;
  }
  try {
    await ensureExitSchema();

    const cur = rows(await db.execute(sql`
      SELECT s.*, e.full_name AS employee_name
        FROM hr_separations s LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.id = ${separationId}::uuid LIMIT 1`));
    if (!cur.length) {
      block('not-found', 'That separation could not be found.');
      return out;
    }
    const sep = cur[0] as any;

    if (sep.closed_at) {
      block('already-closed', 'This separation is already closed.');
      return out;
    }

    if (String(sep.approval_state || 'not_requested') !== 'approved') {
      block('not-approved',
        sep.halt_reason
          ? 'The approval is halted — ' + String(sep.halt_reason)
          : 'The separation has not been approved yet. Send it for approval and wait for a decision.',
      );
    }

    if (!sep.last_working_day) {
      block('no-last-working-day',
        'No last working day is recorded. The graph is closed as of that date, so it has to be set.');
    }

    const clearance = await clearanceFor(separationId);
    for (const area of CLEARANCE_AREAS) {
      const row = clearance.find((c) => c.area === area.key);
      if (!row || row.status !== 'cleared') {
        block('clearance',
          area.label + ' clearance is ' + (row?.status === 'blocked' ? 'blocked' : 'still pending') + '.');
      }
    }

    // A death in service cannot have an exit interview, and demanding one would block the only exit
    // where the delay costs a family money. Every other kind needs one on the record.
    if (!sep.exit_interview_at && String(sep.kind) !== 'death') {
      block('no-exit-interview', 'The exit interview has not been recorded.');
    }

    if (!sep.settlement_handoff_at) {
      block('no-settlement', 'Final settlement has not been handed off.');
    }

    out.graphInitialized = await orgGraphReady();

    if (out.graphInitialized) {
      const reports = await getDirectReports(String(sep.employee_id));
      out.directReports = reports.map((p) => ({ employeeId: p.employeeId, fullName: p.fullName }));
      if (out.directReports.length) {
        const mgr = await getManager(String(sep.employee_id));
        out.suggestedNewManager = mgr ? { employeeId: mgr.employeeId, fullName: mgr.fullName } : null;
        block('direct-reports',
          out.directReports.length === 1
            ? 'One person reports to them. Choose who picks that report up before closing.'
            : out.directReports.length + ' people report to them. Choose who picks those reports up before closing.',
        );
      }
    } else {
      // Honest, and NOT a blocker on the exit itself: an employee record can be closed on a database
      // where the graph has never been backfilled. It IS a blocker on CLAIMING the graph was tidied,
      // which is why it is said out loud rather than assumed either way.
      block('graph-not-initialized',
        'The Organization Graph is not yet initialized, so there are no edges to close. '
        + 'The employee record can still be closed; the graph cannot be tidied until the backfill has run.',
      );
    }

    out.ready = out.blockerDetail.length === 0;
    return out;
  } catch (e: any) {
    logSepFail('exitReadiness', e);
    block('read-failed', 'The exit checks could not be read: ' + sepReasonOf(e));
    return out;
  }
}

/**
 * CLOSE THE EXIT. Reassign the reports, close the edges, close the record.
 *
 * REFUSES RATHER THAN GUESSES. If anything on exitReadiness() is unmet, nothing is written and every
 * unmet condition comes back in `blockers`. In particular: a leaver with direct reports and no
 * chosen replacement manager is REFUSED, because the alternative is a set of people reporting to
 * somebody who has gone, whose leave then routes to nobody and whose approvals halt with no
 * explanation anyone can trace back to this exit.
 *
 * WHAT IT WRITES, IN ORDER, AND WHY:
 *   1. Each direct report is moved onto the new manager with supersedeReportingManager() — one
 *      statement per person that closes the old edge and opens the new at the SAME instant. Their
 *      legacy reporting_manager_id (a USERS id) is brought into step behind it.
 *   2. The leaver's own remaining open edges are CLOSED with effective_to — never deleted, never
 *      revoked. revokeRelationship() means "this row should never have existed"; a person who worked
 *      here and left is the opposite of that, and revoking would erase their approvals from history.
 *   3. The employee record is closed last. If step 1 or 2 fails, the person is still on the graph
 *      and still active, which is a state somebody can see and finish — unlike a closed record whose
 *      reports point at a ghost.
 */
export async function completeSeparation(opts: {
  separationId: string;
  actorUserId: string | null;
  reassignReportsToEmployeeId?: string | null;
}): Promise<SeparationResult> {
  const separationId = String(opts?.separationId || '').trim();
  if (!isSepUuid(separationId)) return { ok: false, error: 'That separation could not be identified.' };
  const actor = isSepUuid(opts?.actorUserId) ? String(opts.actorUserId) : null;
  const reassignTo = isSepUuid(opts?.reassignReportsToEmployeeId)
    ? String(opts.reassignReportsToEmployeeId) : null;

  try {
    await ensureExitSchema();

    const readiness = await exitReadiness(separationId);

    // READ THE CODES, NEVER THE SENTENCES. Two blockers are special:
    //   direct-reports         — answerable in THIS request by naming a new manager, so it is
    //                            handled separately below rather than refusing outright.
    //   graph-not-initialized  — does not block closing an employee record. There is simply nothing
    //                            to close on the graph, and the audit row records that it was empty.
    const graphMissing = readiness.blockerDetail.some((b) => b.code === 'graph-not-initialized');
    const realBlockers = readiness.blockerDetail
      .filter((b) => b.code !== 'direct-reports' && b.code !== 'graph-not-initialized')
      .map((b) => b.message);

    if (readiness.directReports.length && !reassignTo) {
      return {
        ok: false,
        error: 'Choose who picks up their direct reports. Nothing was changed.',
        blockers: readiness.blockers,
      };
    }
    if (realBlockers.length) {
      return { ok: false, error: 'This exit is not ready to close.', blockers: realBlockers };
    }

    const cur = rows(await db.execute(sql`
      SELECT s.*, e.full_name AS employee_name FROM hr_separations s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.id = ${separationId}::uuid LIMIT 1`));
    if (!cur.length) return { ok: false, error: 'That separation could not be found.' };
    const sep = cur[0] as any;
    const employeeId = String(sep.employee_id);
    const lastDay = sep.last_working_day ? String(sep.last_working_day).slice(0, 10) : null;
    if (!lastDay) return { ok: false, error: 'No last working day is recorded. Nothing was changed.' };

    if (reassignTo && reassignTo === employeeId) {
      return { ok: false, error: 'Their reports cannot be moved onto the person who is leaving.' };
    }

    // The closing instant. Edges close at the END of the last working day, not at its start — a
    // person who worked that day was still the manager that day, and closing at midnight would make
    // every approval they made on their final day read as an approval by nobody.
    const closeAt = new Date(lastDay + 'T23:59:59Z');

    let reassigned = 0;
    if (reassignTo && readiness.directReports.length) {
      const mgrRows = rows(await db.execute(sql`
        SELECT is_active FROM hr_employees WHERE id = ${reassignTo}::uuid LIMIT 1`));
      if (!mgrRows.length) return { ok: false, error: 'The manager you chose has no employee record.' };
      if ((mgrRows[0] as any).is_active === false) {
        return { ok: false, error: 'The manager you chose has themselves left. Pick somebody who is still here.' };
      }

      for (const report of readiness.directReports) {
        if (!report.employeeId) continue;
        if (report.employeeId === reassignTo) continue; // nobody manages themselves
        const moved = await supersedeReportingManager(report.employeeId, reassignTo, {
          asOf: closeAt,
          createdByUserId: actor,
          note: 'Reassigned on the exit of ' + (sep.employee_name || 'their manager') + ' (separation ' + separationId + ')',
        });
        if (!moved.ok) {
          // STOP. Half a team moved and half still pointing at somebody who has gone is worse than
          // none moved, because nobody can tell which is which without reading the graph by hand.
          return {
            ok: false,
            error:
              'Their reports were not fully reassigned, so nothing further was changed: '
              + (moved.error || 'unknown reason')
              + ' (' + reassigned + ' of ' + readiness.directReports.length + ' moved before this failed).',
          };
        }
        reassigned += 1;

        // The compatibility column, in step. It holds a USERS id.
        await db.execute(sql`
          UPDATE hr_employees
             SET reporting_manager_id = (SELECT m.user_id FROM hr_employees m WHERE m.id = ${reassignTo}::uuid),
                 updated_at = NOW()
           WHERE id = ${report.employeeId}::uuid`);
      }
    }

    // CLOSE, NEVER DELETE. Every edge of theirs still open on the last working day gets an
    // effective_to. Reads as of any earlier date keep answering exactly as they did.
    let closedEdges = 0;
    if (!graphMissing) {
      const history = await getRelationshipHistory(employeeId);
      for (const edge of history) {
        if (edge.status !== 'active' || edge.effectiveTo) continue;
        const done = await closeRelationship(edge.id, { asOf: closeAt });
        if (done.ok) closedEdges += 1;
        else {
          return {
            ok: false,
            error:
              'Their place in the organization graph was not fully closed, so the employee record was left open: '
              + (done.error || 'unknown reason') + '. ' + closedEdges + ' edge(s) were closed before this failed.',
          };
        }
      }

      // VERIFY, DO NOT TRUST THE COUNT. closeRelationship() only closes a row whose effective_from is
      // BEFORE the closing instant, and it reports success either way — closing an already-closed
      // edge is deliberately a no-op rather than an error. So an edge opened AFTER the last working
      // day (a backdated exit, which is ordinary) survives the loop while the counter still went up.
      //
      // Reading it back is the difference between "we ran the close" and "they are actually closed",
      // and those two have diverged on this project often enough to be worth one more query.
      const after = await getRelationshipHistory(employeeId);
      const stillOpen = after.filter((e) => e.status === 'active' && !e.effectiveTo);
      if (stillOpen.length) {
        return {
          ok: false,
          error:
            'The employee record was left open because ' + stillOpen.length
            + ' organization-graph relationship(s) could not be closed as of ' + lastDay
            + ' — a relationship that begins after that date cannot end on it. '
            + 'Correct the last working day, or revoke the later relationship, then close this exit again.',
        };
      }
    }

    // The employee record, last.
    await db.execute(sql`
      UPDATE hr_employees
         SET is_active = false,
             employment_status = 'exited',
             exit_date = ${lastDay}::date,
             last_working_day = ${lastDay}::date,
             updated_at = NOW()
       WHERE id = ${employeeId}::uuid`);

    await db.execute(sql`
      UPDATE hr_separations
         SET status = 'closed',
             reports_reassigned_to = ${reassignTo}::uuid,
             reports_reassigned_count = ${reassigned},
             graph_closed_at = ${graphMissing ? null : new Date().toISOString()}::timestamptz,
             graph_edges_closed = ${graphMissing ? null : closedEdges}::int,
             closed_by_user_id = ${actor}::uuid,
             closed_at = NOW(),
             access_revoked = true,
             updated_at = NOW()
       WHERE id = ${separationId}::uuid`);

    await logAudit({
      userId: actor,
      action: 'separation.completed',
      entity: 'hr_separation',
      entityId: separationId,
      diff: {
        employeeId, lastWorkingDay: lastDay,
        directReportsReassigned: reassigned, reassignedToEmployeeId: reassignTo,
        orgEdgesClosed: graphMissing ? null : closedEdges,
        orgGraphInitialized: !graphMissing,
        workflowInstanceId: sep.workflow_instance_id ? String(sep.workflow_instance_id) : null,
      },
    });

    return { ok: true, id: separationId, changed: true };
  } catch (e: any) {
    logSepFail('completeSeparation', e);
    return { ok: false, error: 'The exit was not completed: ' + sepReasonOf(e) };
  }
}

/** isInitialized() under a local name — this file already has a `ready` binding of its own. */
async function orgGraphReady(): Promise<boolean> {
  try {
    return await orgGraphInitialized();
  } catch (e: any) {
    logSepFail('orgGraphReady', e);
    return false;
  }
}
