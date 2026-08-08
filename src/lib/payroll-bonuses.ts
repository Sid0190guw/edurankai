// src/lib/payroll-bonuses.ts — BONUSES AND INCENTIVES, as approved awards that become payslip lines.
//
// =================================================================================================
// THE ONE RULE
// =================================================================================================
//
// A BONUS IS NEVER A DIRECT WRITE. Every award is routed through src/lib/workflow.ts, domain
// 'bonus', and appears on nobody's pay until that engine says 'approved'. When routing cannot name
// an approver the award HALTS carrying the engine's sentence — it is not approved, it is not paid,
// and it is not silently dropped either. There is no arm in this file that writes 'approved', no
// fallback to a role name, and no threshold below which a bonus pays itself.
//
// =================================================================================================
// WHY A GROUP BONUS IS N AWARDS AND NOT ONE
// =================================================================================================
//
// Approval routing is resolved PER ROW from the Organization Graph. Twelve people across three
// departments genuinely have three different department heads, so a single instance covering all
// twelve would have to pick one of them and call it the answer for everybody — which is a per-USER
// grant impersonating a per-ROW relationship, the precise defect the three-layer split exists to
// remove.
//
// So a group award writes ONE ROW PER PERSON, each with its own workflow instance, sharing a
// `batch_id` so the console can still show them as the one decision they came from. Eleven can be
// approved and one halted, and the screen says exactly that instead of averaging it into a colour.
//
// =================================================================================================
// ONE-OFF AND RECURRING
// =================================================================================================
//
//   one_off     paid on the first run at or after its effective month, once, and then it is spent.
//   recurring   paid on every run from its effective month until `occurrences` payouts exist. A
//               recurring award with 3 occurrences pays three times and then stops BY ITSELF.
//
// The stop is derived from hr_bonus_payouts — a COUNT of what was actually paid — not from a
// counter column that a failed run could leave out of step with the payslips that are the evidence.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. rows() below; never r.rows[0].
//   - the real Postgres reason is on e.cause. logFail() logs e.cause.message first.
//   - every const is declared ABOVE the function that reads it.
//   - DDL in ONE ensureOnce guard that logs the cause and re-throws so a failed run retries.
//   - no exception swallowed in a write path.
//   - NO BACKTICK inside a sql template literal, not even in a comment.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { startWorkflow, getInstance } from '@/lib/workflow';
import { round2 } from '@/lib/money';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[payroll-bonuses] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ROUNDING IS SHARED — round2 is imported above. What stood here was a local copy of
// Math.round((Number(n) || 0) * 100) / 100, which rounds a half paisa the wrong way: 1.005 * 100 is
// 100.49999999999999 in IEEE754, so it answered 1.00 where the decimal says 1.01. Five other modules
// carried the identical copy; src/lib/money.ts is now the only implementation of it.

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

export const BONUS_KINDS = [
  { key: 'one_off', label: 'One-off', note: 'Paid once, on the first run at or after the month you choose.' },
  { key: 'recurring', label: 'Recurring', note: 'Paid on each run from that month until the number of payouts you set is reached.' },
] as const;

export type BonusKind = (typeof BONUS_KINDS)[number]['key'];

const BONUS_KIND_KEYS = new Set<string>(BONUS_KINDS.map((k) => k.key));

export function bonusKindLabel(key: string): string {
  for (const k of BONUS_KINDS) if (k.key === key) return k.label;
  return 'Bonus';
}

export type BonusState = 'pending' | 'halted' | 'rejected' | 'cancelled' | 'approved' | 'spent';

export const BONUS_STATE_LABELS: Record<BonusState, string> = {
  pending: 'Waiting for approval',
  halted: 'Halted',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
  approved: 'Approved',
  spent: 'Paid in full',
};

export function bonusStateLabel(s: string): string {
  const k = String(s || '') as BonusState;
  return BONUS_STATE_LABELS[k] || k;
}

/** Guards against a typo becoming a lifetime payment, not policy. */
const MAX_OCCURRENCES = 60;
const MAX_AMOUNT = 100000000;
/** How many people one group award may cover in a single press. */
const MAX_GROUP = 200;

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------
//
// TWO TABLES. Grep before adding a third: two CREATE TABLE statements for one table with different
// shapes silently breaks every write for whichever module lost the race.
//
//   hr_bonus_awards    the award: who, what, how much, one-off or recurring, which workflow instance
//                      approved it. A group award is several of these sharing a batch_id.
//   hr_bonus_payouts   THE LEDGER — one row per award per payroll run, UNIQUE on
//                      (bonus_id, payroll_run_id), so a re-run of a month cannot pay the same bonus
//                      twice. "How many times has this been paid" is a COUNT over this table and
//                      never a column that could disagree with the payslips.

export function ensureBonusSchema(): Promise<void> {
  return ensureOnce('hr_bonus_awards_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_bonus_awards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        batch_id UUID,
        title VARCHAR(200) NOT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'one_off',
        amount NUMERIC(14,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        occurrences INT NOT NULL DEFAULT 1,
        effective_month INT NOT NULL,
        effective_year INT NOT NULL,
        reason TEXT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_bonus_awards_emp_idx
        ON hr_bonus_awards(employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_bonus_awards_state_idx
        ON hr_bonus_awards(state, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_bonus_awards_batch_idx
        ON hr_bonus_awards(batch_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_bonus_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bonus_id UUID NOT NULL REFERENCES hr_bonus_awards(id) ON DELETE CASCADE,
        payroll_run_id UUID,
        payslip_id UUID,
        month INT NOT NULL,
        year INT NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_bonus_payouts_run_uniq
        ON hr_bonus_payouts(bonus_id, payroll_run_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_bonus_payouts_bonus_idx
        ON hr_bonus_payouts(bonus_id, year DESC, month DESC)`);
    } catch (e: any) {
      logFail('ensureBonusSchema', e);
      throw e; // ensureOnce drops the failed run so the next call retries.
    }
  });
}

async function safeEnsure(): Promise<boolean> {
  try {
    await ensureBonusSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface BonusRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  batchId: string | null;
  title: string;
  kind: string;
  amount: number;
  currency: string;
  occurrences: number;
  effectiveMonth: number;
  effectiveYear: number;
  reason: string;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  createdAt: string | null;
  /** Derived from the ledger. Never a stored counter. */
  timesPaid: number;
  totalPaid: number;
  /** Payouts still to come, given the state and what has already been paid. */
  remainingOccurrences: number;
}

function mapBonus(r: any): BonusRow {
  const occurrences = Math.max(1, Number(r?.occurrences) || 1);
  const timesPaid = Number(r?.times_paid) || 0;
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    batchId: r?.batch_id ? String(r.batch_id) : null,
    title: String(r?.title ?? ''),
    kind: String(r?.kind ?? 'one_off'),
    amount: Number(r?.amount) || 0,
    currency: String(r?.currency || 'INR'),
    occurrences,
    effectiveMonth: Number(r?.effective_month) || 1,
    effectiveYear: Number(r?.effective_year) || 0,
    reason: String(r?.reason ?? ''),
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    timesPaid,
    totalPaid: round2(Number(r?.total_paid) || 0),
    remainingOccurrences: Math.max(0, occurrences - timesPaid),
  };
}

const BONUS_SELECT = sql`
  SELECT b.*,
         e.full_name AS employee_name,
         COALESCE(p.times_paid, 0) AS times_paid,
         COALESCE(p.total_paid, 0) AS total_paid
    FROM hr_bonus_awards b
    LEFT JOIN hr_employees e ON e.id = b.employee_id
    LEFT JOIN (
      SELECT bonus_id, COUNT(*) AS times_paid, SUM(amount) AS total_paid
        FROM hr_bonus_payouts GROUP BY bonus_id
    ) p ON p.bonus_id = b.id`;

export async function listBonuses(
  opts: { state?: string; employeeId?: string; batchId?: string; limit?: number } = {},
): Promise<BonusRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 500);
  if (!(await safeEnsure())) return [];
  try {
    const stateFilter = opts.state ? sql`AND b.state = ${String(opts.state)}` : sql``;
    const empFilter = isUuid(opts.employeeId)
      ? sql`AND b.employee_id = ${String(opts.employeeId)}::uuid`
      : sql``;
    const batchFilter = isUuid(opts.batchId)
      ? sql`AND b.batch_id = ${String(opts.batchId)}::uuid`
      : sql``;
    const r = await db.execute(sql`
      ${BONUS_SELECT}
       WHERE TRUE ${stateFilter} ${empFilter} ${batchFilter}
       ORDER BY (b.state IN ('pending', 'halted')) DESC, b.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapBonus);
  } catch (e: any) {
    logFail('listBonuses', e);
    return [];
  }
}

export type OwnBonusesResult =
  | { ok: true; rows: BonusRow[] }
  | { ok: false; reason: string };

/**
 * One person's own awards. Narrowed by employee_id in the WHERE clause — this is the employee-facing
 * read, so ownership IS the authorization and no id is taken from a URL.
 *
 * WHY THIS ONE IS DISCRIMINATED WHILE listBonuses() STILL RETURNS A BARE ARRAY. This function had NO
 * CALLERS AT ALL. The admin side (/admin/hr/payroll/bonuses and src/lib/payroll.ts) used the module;
 * the employee-facing read was dead, so an employee could not see a bonus that had been planned or
 * paid to them anywhere in the product. That is the same class of defect as payroll mark-paid
 * selecting a column that never existed, where no employee was ever notified they had been paid.
 *
 * Being wired for the first time, it gets the honest contract instead of inheriting the old one: an
 * employee asking "was my bonus paid?" must never be answered "you have no bonuses" by a failed
 * query. listBonuses() returns [] both for a real absence AND when safeEnsure() fails before any
 * query runs, so this does its own ensure and says which happened.
 */
export async function bonusesForEmployee(employeeId: string): Promise<OwnBonusesResult> {
  if (!isUuid(employeeId)) return { ok: false, reason: 'no employee record is linked to this account' };
  try {
    await ensureBonusSchema();
  } catch (e: any) {
    logFail('bonusesForEmployee.ensure', e);
    return { ok: false, reason: String(e?.cause?.message || e?.message || 'unknown error') };
  }
  try {
    const r = await db.execute(sql`
      ${BONUS_SELECT}
       WHERE b.employee_id = ${String(employeeId)}::uuid
       ORDER BY b.effective_year DESC, b.effective_month DESC, b.created_at DESC
       LIMIT 100`);
    return { ok: true, rows: rows(r).map(mapBonus) };
  } catch (e: any) {
    logFail('bonusesForEmployee', e);
    return { ok: false, reason: String(e?.cause?.message || e?.message || 'unknown error') };
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface BonusResult {
  ok: boolean;
  error?: string;
  /** Award ids created. A group award creates several. */
  ids?: string[];
  batchId?: string | null;
  /** Awards that were recorded but could not be routed, by employee name and reason. */
  halted?: { employee: string; reason: string }[];
  /** People the award could not be recorded for at all, by name. Never silently dropped. */
  failed?: string[];
  changed?: boolean;
}

export interface BonusInput {
  /** One or many. A single-element array is an individual award; there is no separate code path. */
  employeeIds: string[];
  title: string;
  kind: string;
  amount: number;
  occurrences?: number | null;
  effectiveMonth: number;
  effectiveYear: number;
  reason: string;
  currency?: string | null;
  requestedByUserId?: string | null;
}

/**
 * Award a bonus or incentive to one person or to a group. WRITES REQUESTS. PAYS NOBODY.
 *
 * ONE CODE PATH FOR ONE PERSON AND FOR TWELVE, deliberately: a separate "award to an individual"
 * function would be a second place the routing could be got wrong, and the individual case is the
 * one that gets tested.
 *
 * A PER-PERSON FAILURE DOES NOT ABORT THE GROUP, and it is not silent either — the name goes into
 * `failed`, the cause into the log, and the caller shows the list. Aborting on one bad row means
 * nobody gets their bonus; hiding it means one person does not and nobody knows which.
 */
export async function requestBonus(input: BonusInput): Promise<BonusResult> {
  const ids = Array.isArray(input?.employeeIds)
    ? Array.from(new Set(input.employeeIds.map((x) => String(x || '').trim()).filter(isUuid)))
    : [];
  if (!ids.length) return { ok: false, error: 'Choose at least one person to award this to.' };
  if (ids.length > MAX_GROUP) {
    return { ok: false, error: 'That is more than ' + MAX_GROUP + ' people in one award. Split it up.' };
  }

  const title = String(input?.title || '').trim().slice(0, 200);
  if (!title) {
    return { ok: false, error: 'Give the award a name. It is printed on the payslip exactly as you write it.' };
  }

  const kind = BONUS_KIND_KEYS.has(String(input?.kind)) ? String(input.kind) : '';
  if (!kind) return { ok: false, error: 'Say whether this is paid once or on every run for a while.' };

  const amount = round2(Number(input?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter the amount. It has to be more than zero.' };
  }
  if (amount > MAX_AMOUNT) {
    return { ok: false, error: 'That amount is beyond what this register handles. Check the figure.' };
  }

  const occurrences = kind === 'one_off'
    ? 1
    : Math.round(Number(input?.occurrences) || 0);
  if (kind === 'recurring' && (occurrences < 2 || occurrences > MAX_OCCURRENCES)) {
    return {
      ok: false,
      error: 'A recurring award needs how many runs it is paid on, between 2 and ' + MAX_OCCURRENCES
        + '. For a single payment choose one-off instead.',
    };
  }

  const month = Math.round(Number(input?.effectiveMonth) || 0);
  const year = Math.round(Number(input?.effectiveYear) || 0);
  if (month < 1 || month > 12) return { ok: false, error: 'Pick the month this starts being paid in.' };
  if (year < 2000 || year > 2100) return { ok: false, error: 'That is not a year this payroll covers.' };

  const reason = String(input?.reason || '').trim();
  if (reason.length < 5) {
    return { ok: false, error: 'Write why this is being awarded — an approver reads it before deciding.' };
  }

  const currency = String(input?.currency || 'INR').slice(0, 8) || 'INR';
  const requestedBy = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureBonusSchema();

    // A group award shares one batch id so the console can show the decision it came from. Generated
    // by the database rather than in JavaScript so there is one source of uuid values here.
    const batchRow = rows(await db.execute(sql`SELECT gen_random_uuid() AS id`));
    const batchId = batchRow.length ? String(batchRow[0].id) : null;

    const created: string[] = [];
    const halted: { employee: string; reason: string }[] = [];
    const failed: string[] = [];

    for (const employeeId of ids) {
      let name = employeeId;
      try {
        const empRows = rows(await db.execute(sql`
          SELECT id, full_name, is_active FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
        if (!empRows.length) { failed.push('an employee record that no longer exists'); continue; }
        const emp = empRows[0] as any;
        name = String(emp.full_name || employeeId);
        if (emp.is_active === false) { failed.push(name + ' (record closed)'); continue; }

        const ins = rows(await db.execute(sql`
          INSERT INTO hr_bonus_awards
            (employee_id, batch_id, title, kind, amount, currency, occurrences,
             effective_month, effective_year, reason, state, requested_by_user_id)
          VALUES
            (${employeeId}::uuid, ${batchId}::uuid, ${title}, ${kind}, ${amount}, ${currency},
             ${occurrences}, ${month}, ${year}, ${reason}, 'pending', ${requestedBy}::uuid)
          RETURNING id`));
        if (!ins.length) { failed.push(name); continue; }
        const bonusId = String(ins[0].id);

        const wf = await startWorkflow({
          domain: 'bonus',
          recordId: bonusId,
          subjectEmployeeId: employeeId,
          requestedByUserId: requestedBy,
          createdByUserId: requestedBy,
          amount: round2(amount * occurrences),
          currency,
          summary: title + ' for ' + name + ' — ' + currency + ' '
            + amount.toLocaleString('en-IN')
            + (occurrences > 1 ? ' on each of ' + occurrences + ' runs' : ''),
        });

        if (!wf.ok) {
          await db.execute(sql`
            UPDATE hr_bonus_awards SET state = 'halted',
                   halt_reason = ${String(wf.error || 'The approval could not be started.')}, updated_at = NOW()
             WHERE id = ${bonusId}::uuid`);
          halted.push({ employee: name, reason: String(wf.error || 'The approval could not be started.') });
          created.push(bonusId);
          continue;
        }

        const isHalted = wf.state === 'halted';
        await db.execute(sql`
          UPDATE hr_bonus_awards
             SET workflow_instance_id = ${wf.instanceId}::uuid,
                 state = ${isHalted ? 'halted' : 'pending'},
                 halt_reason = ${wf.haltReason || null}::text,
                 updated_at = NOW()
           WHERE id = ${bonusId}::uuid`);
        if (isHalted) {
          halted.push({ employee: name, reason: String(wf.haltReason || 'No approver could be resolved.') });
        }
        created.push(bonusId);
      } catch (e: any) {
        // NOT SWALLOWED. The cause goes to the log and the NAME goes back to the caller, so a person
        // left out of a group award is visible on the screen that awarded it.
        logFail('requestBonus employee ' + employeeId, e);
        failed.push(name);
      }
    }

    if (!created.length) {
      return { ok: false, error: 'No award was recorded. Nothing was changed.', failed };
    }

    await logAudit({
      userId: requestedBy,
      action: 'bonus.requested',
      entity: 'hr_bonus_batch',
      entityId: batchId || created[0],
      diff: {
        title, kind, amount, currency, occurrences, effectiveMonth: month, effectiveYear: year,
        people: created.length, halted: halted.length, failed,
      },
    });

    return { ok: true, ids: created, batchId, halted, failed, changed: true };
  } catch (e: any) {
    logFail('requestBonus', e);
    return { ok: false, error: 'The award was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw an award that has not been decided. An approved award that has paid out cannot be undone. */
export async function cancelBonus(id: string, actorUserId: string | null): Promise<BonusResult> {
  if (!isUuid(id)) return { ok: false, error: 'That award could not be identified.' };
  try {
    await ensureBonusSchema();
    // An APPROVED award may still be withdrawn while nothing has been paid against it — stopping a
    // recurring award is a real need and the alternative is paying it forever. Once a payout exists
    // the row is evidence of money that moved and it is not rewritten.
    const wrote = rows(await db.execute(sql`
      UPDATE hr_bonus_awards b SET state = 'cancelled', updated_at = NOW()
       WHERE b.id = ${id}::uuid
         AND b.state IN ('pending', 'halted', 'approved')
         AND NOT EXISTS (SELECT 1 FROM hr_bonus_payouts p WHERE p.bonus_id = b.id)
      RETURNING b.id`));
    if (!wrote.length) {
      return {
        ok: false,
        error: 'That award cannot be withdrawn — it has either already been settled or already been paid at least once.',
      };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'bonus.cancelled', entity: 'hr_bonus_award', entityId: id, diff: {},
    });
    return { ok: true, ids: [id], changed: true };
  } catch (e: any) {
    logFail('cancelBonus', e);
    return { ok: false, error: 'The award was not withdrawn: ' + reasonOf(e) };
  }
}

/** Read the engine's decisions back onto open awards. Decides nothing. */
export async function syncBonusApprovals(actorUserId?: string | null): Promise<{
  settled: number;
  errors: string[];
}> {
  const out = { settled: 0, errors: [] as string[] };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  try {
    await ensureBonusSchema();
    const open = rows(await db.execute(sql`
      SELECT id, workflow_instance_id, state FROM hr_bonus_awards
       WHERE state IN ('pending', 'halted') AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 200`));

    for (const raw of open) {
      const id = String((raw as any).id);
      const instanceId = String((raw as any).workflow_instance_id || '');
      if (!instanceId) continue;

      let instance = null as Awaited<ReturnType<typeof getInstance>>;
      try {
        instance = await getInstance(instanceId);
      } catch (e: any) {
        logFail('syncBonusApprovals.getInstance', e);
        out.errors.push('An approval could not be read: ' + reasonOf(e));
        continue;
      }
      if (!instance) continue;

      let next: BonusState | null = null;
      if (instance.state === 'approved') next = 'approved';
      else if (instance.state === 'rejected') next = 'rejected';
      else if (instance.state === 'cancelled') next = 'cancelled';
      else if (instance.state === 'halted') next = 'halted';
      else if (instance.state === 'pending') next = 'pending';
      if (!next || next === String((raw as any).state)) continue;

      try {
        await db.execute(sql`
          UPDATE hr_bonus_awards
             SET state = ${next}, halt_reason = ${instance.haltReason}::text, updated_at = NOW()
           WHERE id = ${id}::uuid`);
        out.settled += 1;
        if (next === 'approved') {
          await logAudit({
            userId: actor, action: 'bonus.approved', entity: 'hr_bonus_award', entityId: id,
            diff: { workflowInstanceId: instanceId },
          });
        }
      } catch (e: any) {
        logFail('syncBonusApprovals.write', e);
        out.errors.push('A decision could not be written down: ' + reasonOf(e));
      }
    }
  } catch (e: any) {
    logFail('syncBonusApprovals', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// WHAT PAYROLL PAYS, AND THE LEDGER ROW THAT RECORDS IT
// -------------------------------------------------------------------------------------------------

/** One planned bonus line for one award in one period. Computed, never written, by plannedBonuses. */
export interface BonusCharge {
  bonusId: string;
  label: string;
  amount: number;
  /**
   * THE CURRENCY THE AWARD WAS MADE IN, and the reason this field exists at all.
   *
   * hr_bonus_awards carries a currency column and every screen that creates an award records one —
   * and then this interface dropped it, so the number crossed into src/lib/payroll.ts as a bare
   * `amount`. computePay() pushed it straight onto the payslip's earnings, where the payslip currency
   * came from the salary structure. An award of USD 2,000 was therefore paid as 2,000 rupees: the
   * currency did not convert, it stopped existing at the module boundary.
   *
   * Carrying it does not make this module a converter — there is no exchange rate anywhere in this
   * codebase and inventing one would be worse than the bug. It makes the MISMATCH VISIBLE, so
   * computePay() can refuse to fold a foreign-currency award into a payslip silently and say so
   * instead.
   */
  currency: string;
  /** Which payout of how many this is, for a recurring award. Both 1 for a one-off. */
  occurrence: number;
  occurrences: number;
  /** True when this payout is the last one and the award is spent afterwards. */
  finalPayout: boolean;
}

/**
 * WHAT THIS PERSON'S PAY SHOULD GAIN FROM BONUSES THIS MONTH. READ-ONLY.
 *
 * Called by src/lib/payroll.ts computePay(), which is itself read-only so a run can be PREVIEWED.
 * Nothing is written until recordBonusPayout() runs against a real payslip.
 *
 * IT STOPS BY ITSELF, in three ways:
 *   1. only awards in state 'approved' are considered — pending, halted, rejected, withdrawn and
 *      already-spent ones are not;
 *   2. an award before its effective month produces nothing;
 *   3. the count of existing payouts is compared against `occurrences`, so a one-off pays once and a
 *      recurring award of three pays three times, no matter how many runs are generated afterwards.
 */
export async function plannedBonuses(
  employeeId: string,
  opts: { month: number; year: number },
): Promise<BonusCharge[]> {
  if (!isUuid(employeeId)) return [];
  if (!(await safeEnsure())) return [];
  const month = Math.max(1, Math.min(12, Math.round(Number(opts?.month) || 0)));
  const year = Math.max(1970, Math.min(9999, Math.round(Number(opts?.year) || 0)));
  const period = year * 12 + month;

  try {
    const live = await listBonuses({ employeeId, state: 'approved', limit: 100 });
    const out: BonusCharge[] = [];
    for (const b of live) {
      if (b.effectiveYear * 12 + b.effectiveMonth > period) continue;  // not started yet
      if (b.timesPaid >= b.occurrences) continue;                      // already fully paid
      const occurrence = b.timesPaid + 1;
      out.push({
        bonusId: b.id,
        label: b.title + (b.occurrences > 1 ? ' (' + occurrence + ' of ' + b.occurrences + ')' : ''),
        amount: round2(b.amount),
        currency: String(b.currency || 'INR'),
        occurrence,
        occurrences: b.occurrences,
        finalPayout: occurrence >= b.occurrences,
      });
    }
    return out;
  } catch (e: any) {
    logFail('plannedBonuses', e);
    return [];
  }
}

/**
 * WRITE ONE PAYOUT INTO THE LEDGER, against a payslip that exists.
 *
 * Called by generateRun() AFTER the payslip row is written. ON CONFLICT DO NOTHING against the
 * (bonus_id, payroll_run_id) unique index, so a re-run of a month pays nothing extra.
 *
 * THE FAILURE IS RETURNED, NEVER SWALLOWED: a payslip that paid a bonus which never reached the
 * ledger means a one-off bonus gets paid again next month.
 */
export async function recordBonusPayout(opts: {
  charge: BonusCharge;
  payrollRunId: string;
  payslipId: string;
  month: number;
  year: number;
}): Promise<{ ok: boolean; error?: string }> {
  const c = opts?.charge;
  if (!c || !isUuid(c.bonusId)) return { ok: false, error: 'That award could not be identified.' };
  if (!isUuid(opts?.payrollRunId) || !isUuid(opts?.payslipId)) {
    return { ok: false, error: 'A bonus can only be recorded against a payslip that exists.' };
  }
  const month = Math.max(1, Math.min(12, Math.round(Number(opts?.month) || 0)));
  const year = Math.max(1970, Math.min(9999, Math.round(Number(opts?.year) || 0)));
  try {
    await ensureBonusSchema();
    await db.execute(sql`
      INSERT INTO hr_bonus_payouts (bonus_id, payroll_run_id, payslip_id, month, year, amount)
      VALUES (${c.bonusId}::uuid, ${opts.payrollRunId}::uuid, ${opts.payslipId}::uuid,
              ${month}, ${year}, ${round2(c.amount)})
      ON CONFLICT (bonus_id, payroll_run_id) DO NOTHING`);

    // MARK IT SPENT FROM THE LEDGER, not from the caller's flag: the count in the database is the
    // evidence, and an award closes on that rather than on an assumption made a line earlier.
    await db.execute(sql`
      UPDATE hr_bonus_awards b
         SET state = 'spent', updated_at = NOW()
       WHERE b.id = ${c.bonusId}::uuid
         AND b.state = 'approved'
         AND b.occurrences <= (SELECT COUNT(*) FROM hr_bonus_payouts p WHERE p.bonus_id = b.id)`);
    return { ok: true };
  } catch (e: any) {
    logFail('recordBonusPayout', e);
    return { ok: false, error: 'The bonus was not written to the award ledger: ' + reasonOf(e) };
  }
}
