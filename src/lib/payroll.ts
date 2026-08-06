// src/lib/payroll.ts — SALARY STRUCTURE AS CONFIGURED COMPONENTS, and the payroll run that uses them.
//
// =================================================================================================
// WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY REFUSES TO DO
// =================================================================================================
//
// /admin/hr/payroll/index.astro computed every payslip from statutory rates WRITTEN INTO THE CODE:
//
//     const pfEmployee = Math.min(basic * 0.12, 1800);            // "PF: 12% ... capped at 1800"
//     const esicEmployee = gross < 21000 ? gross * 0.0075 : 0;    // "ESIC: 0.75% if gross < 21000"
//     let professionalTax = 0;                                     // "(Karnataka/Maharashtra standard)"
//     if (gross > 15000) professionalTax = 200;
//
// and src/lib/hr-payslip.ts then PRINTED those numbers under the labels "PF (Employee 12%)" and
// "ESIC (0.75%)" on a document handed to an employee.
//
// THAT IS A COMPLIANCE CLAIM THIS PRODUCT IS NOT ENTITLED TO MAKE. Provident fund, employees' state
// insurance, professional tax and withholding are jurisdiction-specific, they change, they differ by
// state and by wage band, and this platform operates for people in more than one country. A rate
// frozen in a TypeScript file in 2026 is not the law; it is a guess that looks like the law, printed
// on a payslip, with a percentage next to it.
//
// So this module models them as WHAT THEY ACTUALLY ARE HERE: configurable components whose rates an
// administrator sets, whose labels the administrator writes, and which do not exist at all until
// somebody records them. The catalogue ships EMPTY. There is no seed, no "sensible default", and no
// helper that offers to fill in the four Indian rates — a one-click button that writes 12% / 0.75% /
// Rs 200 would be the same hardcoding with an extra step.
//
// NOTHING IN THIS FILE, AND NOTHING ON ANY SCREEN THAT READS IT, CLAIMS COMPLIANCE. `statutory` on a
// component is a LABELLING flag — it means "the administrator marked this as a statutory line so it
// groups with the others on the payslip" — and it confers no calculation and no correctness.
//
// =================================================================================================
// WHAT IT DOES NOT DUPLICATE
// =================================================================================================
//
//   hr_salary_structures    ALREADY EXISTS (db/hr-schema.sql:186) and is still the source of `basic`,
//                           the currency, and the legacy fixed allowance/deduction columns. No second
//                           salary table is created. Components are ADDITIVE to it.
//   hr_payroll_runs         ALREADY EXISTS. generateRun() writes to it; no second run table.
//   hr_payslips             ALREADY EXISTS, with fixed columns. Still written, so every existing
//                           reader (/portal/payslip/[id], /admin/hr/payslip/[id],
//                           src/lib/hr-wallet.ts creditPayrollRun) keeps working unchanged.
//   src/lib/hr-wallet.ts    IS THE WALLET. Payroll never writes hr_wallet_txn itself; the admin page
//                           calls creditPayrollRun() exactly as it does today.
//   src/lib/audit.ts        IS THE AUDIT LOG. logAudit(), no second one.
//
// TWO NEW TABLES, and each answers a question no existing table can:
//   payroll_components          the component catalogue: code, label, earning or deduction, how it is
//                               calculated, the rate an ADMIN set, the employer share, the gross band
//                               it applies in. There is nowhere in this schema to record "this is how
//                               PF is calculated for us" — hr_salary_structures has a `pf_employee`
//                               NUMBER, which is the computed answer, not the rule.
//   hr_payslip_lines            one row per component on one payslip, so the printed document shows
//                               each component with its own label and rate instead of six hardcoded
//                               column names. hr_payslips cannot grow a column per component.
//
// Per-employee variation lives in payroll_employee_component (an override of value/enabled for one
// person), because TDS is genuinely per-person and a component catalogue with one global TDS number
// would be wrong for everybody.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. rows() below; never `r.rows[0]`.
//   - the real Postgres reason is on e.cause; logFail() logs `e?.cause?.message || e?.message`.
//   - every `const` is declared ABOVE the function that reads it. `const` is not hoisted, and a
//     later declaration has taken pages down on this project.
//   - self-bootstrapping DDL only: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS inside an
//     ensureOnce guard that RESETS on failure, so a transient error does not permanently mark the
//     schema as provisioned.
//   - no exception is swallowed in a write path: every writer returns { ok, error } and logs the
//     cause.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
// LOANS AND BONUSES ARE READ FROM THEIR OWN MODULES, NEVER RECOMPUTED HERE.
//
// src/lib/loans.ts owns the loan agreement and the recovery ledger; src/lib/payroll-bonuses.ts owns
// the award and the payout ledger. This file asks each of them what a person's pay should gain or
// lose this month and records the answer against the payslip it just wrote. It does not query
// hr_salary_loans or hr_bonus_awards directly and it must not start to: a second arithmetic over one
// ledger is how an employee's loan screen and their payslip end up disagreeing by a few hundred
// rupees with no way to say which is wrong.
//
// The dependency runs ONE WAY — payroll imports loans, loans never imports payroll.
import { plannedRecoveries, recordRecovery, type LoanCharge } from '@/lib/loans';
import { plannedBonuses, recordBonusPayout, type BonusCharge } from '@/lib/payroll-bonuses';
import { round2, sumMoney } from '@/lib/money';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — all above the functions that use them.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[payroll] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** What a person is shown when a write fails. The database's own words go to the log, not to them. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Is this component money coming to the employee, or money withheld from them? */
export const COMPONENT_KINDS = ['earning', 'deduction'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const KIND_LABELS: Record<ComponentKind, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
};

/**
 * HOW ONE COMPONENT IS CALCULATED.
 *
 *   fixed              a flat amount for the month. `value` is that amount.
 *   percent_of_basic   `value` percent of the basic salary.
 *   percent_of_gross   `value` percent of GROSS EARNINGS (basic + every earning component).
 *
 * percent_of_gross IS REFUSED FOR EARNINGS, and saveComponent() says so rather than silently
 * accepting it: an earning that is a percentage of the gross it is itself part of has no fixed point,
 * and the "obvious" reading (percent of the gross so far) makes the answer depend on the order rows
 * happen to come back in. Deductions are computed after gross is final, so there is no such problem.
 */
export const COMPONENT_BASES = ['fixed', 'percent_of_basic', 'percent_of_gross'] as const;
export type ComponentBasis = (typeof COMPONENT_BASES)[number];

export const BASIS_LABELS: Record<ComponentBasis, string> = {
  fixed: 'Fixed amount each month',
  percent_of_basic: 'Percentage of basic',
  percent_of_gross: 'Percentage of gross earnings',
};

/**
 * The legacy columns on hr_salary_structures, carried onto every payslip as components so that an
 * employee whose structure predates this module does not silently lose their allowances.
 *
 * A component in the catalogue with the SAME CODE takes precedence and the legacy column is dropped —
 * that is the migration path: record `hra` as a component, and the column stops being read for
 * everybody.
 *
 * `pf_employee`, `esic_employee` and `professional_tax` are NOT in this list, deliberately and at the
 * cost of changing what a new run computes. Those three columns hold numbers the hardcoded statutory
 * formulas produced; carrying them forward would be carrying the hardcoded rates forward under a new
 * name. `tds` and `other_deductions` ARE carried, because those two were typed in by a human on the
 * salary form rather than computed from a rate.
 */
const LEGACY_EARNINGS: readonly { code: string; column: string; label: string }[] = [
  { code: 'hra', column: 'hra', label: 'House rent allowance' },
  { code: 'da', column: 'da', label: 'Dearness allowance' },
  { code: 'special_allowance', column: 'special_allowance', label: 'Special allowance' },
  { code: 'transport_allowance', column: 'transport_allowance', label: 'Transport allowance' },
  { code: 'medical_allowance', column: 'medical_allowance', label: 'Medical allowance' },
  { code: 'other_allowances', column: 'other_allowances', label: 'Other allowances' },
];

const LEGACY_DEDUCTIONS: readonly { code: string; column: string; label: string }[] = [
  { code: 'tds', column: 'tds', label: 'Tax deducted at source' },
  { code: 'other_deductions', column: 'other_deductions', label: 'Other deductions' },
];

/** Which hr_payslips column, if any, a component code writes to as well as its own line row. */
const LEGACY_PAYSLIP_COLUMN: Record<string, string> = {
  hra: 'hra',
  da: 'da',
  special_allowance: 'special_allowance',
  transport_allowance: 'transport_allowance',
  medical_allowance: 'medical_allowance',
  other_allowances: 'other_allowances',
  pf_employee: 'pf_employee',
  pf: 'pf_employee',
  esic_employee: 'esic_employee',
  esi: 'esic_employee',
  professional_tax: 'professional_tax',
  pt: 'professional_tax',
  tds: 'tds',
  other_deductions: 'other_deductions',
};

const CODE_RE = /^[a-z][a-z0-9_]{1,38}$/;

// ROUNDING IS SHARED, NOT RE-DECLARED — see the import of round2/sumMoney at the top of this file.
//
// What stood here was a local copy of
//   Math.round((Number(n) || 0) * 100) / 100
// which rounds a half paisa the wrong way: 1.005 * 100 is 100.49999999999999 in IEEE754, so it
// answered 1.00 where the decimal value says 1.01, and it did so consistently AGAINST the employee.
// Five other modules carried the identical copy. src/lib/money.ts explains the arithmetic and is now
// the only implementation of it.

// -------------------------------------------------------------------------------------------------
// SCHEMA — self-bootstrapping, and the guard resets on failure.
// -------------------------------------------------------------------------------------------------

let ready: Promise<void> | null = null;

export function ensurePayrollSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS payroll_components (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'earning',
        basis TEXT NOT NULL DEFAULT 'fixed',
        employee_value NUMERIC(14,4) NOT NULL DEFAULT 0,
        employer_value NUMERIC(14,4) NOT NULL DEFAULT 0,
        cap_amount NUMERIC(14,2),
        employer_cap_amount NUMERIC(14,2),
        min_gross NUMERIC(14,2),
        max_gross NUMERIC(14,2),
        statutory BOOLEAN NOT NULL DEFAULT false,
        jurisdiction_note TEXT NOT NULL DEFAULT '',
        sort_order INT NOT NULL DEFAULT 100,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS payroll_components_code
        ON payroll_components (code)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS payroll_employee_component (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        component_id UUID NOT NULL,
        employee_value NUMERIC(14,4),
        enabled BOOLEAN NOT NULL DEFAULT true,
        note TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS payroll_employee_component_pair
        ON payroll_employee_component (employee_id, component_id)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_payslip_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payslip_id UUID NOT NULL,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'earning',
        basis TEXT NOT NULL DEFAULT 'fixed',
        rate NUMERIC(14,4) NOT NULL DEFAULT 0,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        employer_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        statutory BOOLEAN NOT NULL DEFAULT false,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_payslip_lines_slip
        ON hr_payslip_lines (payslip_id, sort_order)`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_payslip_lines_slip_code
        ON hr_payslip_lines (payslip_id, code)`);

      // Employer cost is the number a payslip cannot show without it: gross plus every employer
      // share. Additive to the existing table so nothing that reads hr_payslips today changes.
      await db.execute(sql`ALTER TABLE hr_payslips
        ADD COLUMN IF NOT EXISTS employer_cost NUMERIC(14,2) NOT NULL DEFAULT 0`);
    } catch (e: any) {
      logFail('ensurePayrollSchema', e);
      // RESET, so the next call retries. A guard that stays set after a failure means every later
      // read runs against tables that were never created.
      ready = null;
      throw e;
    }
  })();
  return ready;
}

/** Provision, but never throw into a reader — a read that cannot run returns an empty list. */
async function safeEnsure(): Promise<boolean> {
  try {
    await ensurePayrollSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// THE COMPONENT CATALOGUE
// -------------------------------------------------------------------------------------------------

export interface PayrollComponent {
  id: string;
  code: string;
  label: string;
  kind: ComponentKind;
  basis: ComponentBasis;
  employeeValue: number;
  employerValue: number;
  capAmount: number | null;
  employerCapAmount: number | null;
  minGross: number | null;
  maxGross: number | null;
  statutory: boolean;
  jurisdictionNote: string;
  sortOrder: number;
  isActive: boolean;
}

function mapComponent(r: any): PayrollComponent {
  const num = (v: any): number | null =>
    v === null || v === undefined || v === '' ? null : Number(v);
  return {
    id: String(r?.id ?? ''),
    code: String(r?.code ?? ''),
    label: String(r?.label ?? ''),
    kind: (String(r?.kind) === 'deduction' ? 'deduction' : 'earning'),
    basis: (COMPONENT_BASES.indexOf(r?.basis) >= 0 ? r.basis : 'fixed') as ComponentBasis,
    employeeValue: Number(r?.employee_value) || 0,
    employerValue: Number(r?.employer_value) || 0,
    capAmount: num(r?.cap_amount),
    employerCapAmount: num(r?.employer_cap_amount),
    minGross: num(r?.min_gross),
    maxGross: num(r?.max_gross),
    statutory: r?.statutory === true,
    jurisdictionNote: String(r?.jurisdiction_note ?? ''),
    sortOrder: Number(r?.sort_order) || 100,
    isActive: r?.is_active !== false,
  };
}

/** Every configured component. `includeInactive` for the admin screen; readers want the default. */
export async function listComponents(
  opts: { includeInactive?: boolean } = {},
): Promise<PayrollComponent[]> {
  if (!(await safeEnsure())) return [];
  try {
    const activeFilter = opts.includeInactive ? sql`` : sql`WHERE is_active = true`;
    const r = await db.execute(sql`
      SELECT * FROM payroll_components ${activeFilter}
       ORDER BY (kind = 'deduction'), sort_order ASC, label ASC`);
    return rows(r).map(mapComponent);
  } catch (e: any) {
    logFail('listComponents', e);
    return [];
  }
}

export interface SaveComponentInput {
  id?: string | null;
  code: string;
  label: string;
  kind: string;
  basis: string;
  employeeValue: number;
  employerValue: number;
  capAmount: number | null;
  employerCapAmount: number | null;
  minGross: number | null;
  maxGross: number | null;
  statutory: boolean;
  jurisdictionNote: string;
  sortOrder: number;
  isActive: boolean;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Create or update one component.
 *
 * VALIDATION IS A SENTENCE, NOT A THROW. Every refusal below names what to change; a payroll screen
 * that answers "invalid input" makes somebody guess which of eleven fields it meant.
 */
export async function saveComponent(
  input: SaveComponentInput,
  actorUserId: string | null,
): Promise<WriteResult> {
  const code = String(input?.code || '').trim().toLowerCase();
  const label = String(input?.label || '').trim();
  const kind: ComponentKind = input?.kind === 'deduction' ? 'deduction' : 'earning';
  const basis = (COMPONENT_BASES as readonly string[]).indexOf(String(input?.basis)) >= 0
    ? (String(input.basis) as ComponentBasis)
    : 'fixed';

  if (!CODE_RE.test(code)) {
    return {
      ok: false,
      error: 'The code must be lowercase letters, digits and underscores, start with a letter and be '
        + 'between 2 and 39 characters — for example provident_fund.',
    };
  }
  if (!label) return { ok: false, error: 'Give the component a label. It is printed on the payslip exactly as you write it.' };
  if (kind === 'earning' && basis === 'percent_of_gross') {
    return {
      ok: false,
      error: 'An earning cannot be a percentage of gross, because it would be a percentage of a total '
        + 'it is itself part of. Use a percentage of basic, or a fixed amount.',
    };
  }

  const num = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const optNum = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const employeeValue = num(input?.employeeValue);
  const employerValue = num(input?.employerValue);
  if (employeeValue < 0 || employerValue < 0) {
    return { ok: false, error: 'Rates and amounts cannot be negative. A deduction is entered as a positive number.' };
  }
  if (basis !== 'fixed' && (employeeValue > 100 || employerValue > 100)) {
    return { ok: false, error: 'A percentage cannot be above 100.' };
  }

  const minGross = optNum(input?.minGross);
  const maxGross = optNum(input?.maxGross);
  if (minGross !== null && maxGross !== null && maxGross < minGross) {
    return { ok: false, error: 'The upper gross limit must be at or above the lower one.' };
  }

  const capAmount = optNum(input?.capAmount);
  const employerCapAmount = optNum(input?.employerCapAmount);
  const jurisdictionNote = String(input?.jurisdictionNote || '').trim().slice(0, 500);
  const sortOrder = Math.max(0, Math.min(9999, Math.round(num(input?.sortOrder)) || 100));
  const statutory = input?.statutory === true;
  const isActive = input?.isActive !== false;
  const id = isUuid(input?.id) ? String(input.id) : null;

  try {
    await ensurePayrollSchema();

    // Codes are unique because a payslip line is keyed on the code; two components sharing one code
    // would collide on hr_payslip_lines_slip_code and the second would silently not be written.
    const clash = rows(await db.execute(sql`
      SELECT id FROM payroll_components WHERE code = ${code} LIMIT 1`));
    if (clash.length && String(clash[0].id) !== id) {
      return { ok: false, error: 'A component with the code "' + code + '" already exists. Edit that one, or choose another code.' };
    }

    if (id) {
      const wrote = rows(await db.execute(sql`
        UPDATE payroll_components
           SET code = ${code}, label = ${label}, kind = ${kind}, basis = ${basis},
               employee_value = ${employeeValue}, employer_value = ${employerValue},
               cap_amount = ${capAmount}, employer_cap_amount = ${employerCapAmount},
               min_gross = ${minGross}, max_gross = ${maxGross},
               statutory = ${statutory}, jurisdiction_note = ${jurisdictionNote},
               sort_order = ${sortOrder}, is_active = ${isActive},
               updated_at = NOW(), updated_by = ${actorUserId}::uuid
         WHERE id = ${id}::uuid
        RETURNING id`));
      if (!wrote.length) return { ok: false, error: 'That component no longer exists. Reload the page.' };
      await logAudit({
        userId: actorUserId, action: 'payroll.component.updated', entity: 'payroll_component',
        entityId: id,
        diff: { code, label, kind, basis, employeeValue, employerValue, capAmount, minGross, maxGross, statutory, isActive },
      });
      return { ok: true, id };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO payroll_components
        (code, label, kind, basis, employee_value, employer_value, cap_amount, employer_cap_amount,
         min_gross, max_gross, statutory, jurisdiction_note, sort_order, is_active, updated_by)
      VALUES
        (${code}, ${label}, ${kind}, ${basis}, ${employeeValue}, ${employerValue}, ${capAmount},
         ${employerCapAmount}, ${minGross}, ${maxGross}, ${statutory}, ${jurisdictionNote},
         ${sortOrder}, ${isActive}, ${actorUserId}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const newId = String(ins[0].id);
    await logAudit({
      userId: actorUserId, action: 'payroll.component.created', entity: 'payroll_component',
      entityId: newId,
      diff: { code, label, kind, basis, employeeValue, employerValue, capAmount, minGross, maxGross, statutory },
    });
    return { ok: true, id: newId };
  } catch (e: any) {
    // NOT SWALLOWED. The cause goes to the log; the caller gets a sentence and an ok:false it must
    // handle. A payroll write that fails silently is a month of wrong pay.
    logFail('saveComponent', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Retire a component without deleting the payslip history that references its code. */
export async function setComponentActive(
  id: string,
  active: boolean,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(id)) return { ok: false, error: 'That component no longer exists. Reload the page.' };
  try {
    await ensurePayrollSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE payroll_components SET is_active = ${active === true}, updated_at = NOW(),
             updated_by = ${actorUserId}::uuid
       WHERE id = ${id}::uuid RETURNING id, code`));
    if (!wrote.length) return { ok: false, error: 'That component no longer exists. Reload the page.' };
    await logAudit({
      userId: actorUserId,
      action: active ? 'payroll.component.reactivated' : 'payroll.component.retired',
      entity: 'payroll_component', entityId: id, diff: { code: String(wrote[0].code) },
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail('setComponentActive', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// PER-EMPLOYEE OVERRIDES
// -------------------------------------------------------------------------------------------------

export interface EmployeeOverride {
  componentId: string;
  code: string;
  label: string;
  kind: ComponentKind;
  /** null means "use the catalogue value". */
  employeeValue: number | null;
  enabled: boolean;
  note: string;
}

export async function employeeOverrides(employeeId: string): Promise<EmployeeOverride[]> {
  if (!isUuid(employeeId)) return [];
  if (!(await safeEnsure())) return [];
  try {
    const r = await db.execute(sql`
      SELECT o.component_id, o.employee_value, o.enabled, o.note,
             c.code, c.label, c.kind
        FROM payroll_employee_component o
        JOIN payroll_components c ON c.id = o.component_id
       WHERE o.employee_id = ${employeeId}::uuid
       ORDER BY c.sort_order ASC`);
    return rows(r).map((x) => ({
      componentId: String(x.component_id),
      code: String(x.code),
      label: String(x.label),
      kind: (String(x.kind) === 'deduction' ? 'deduction' : 'earning') as ComponentKind,
      employeeValue: x.employee_value === null || x.employee_value === undefined ? null : Number(x.employee_value),
      enabled: x.enabled !== false,
      note: String(x.note || ''),
    }));
  } catch (e: any) {
    logFail('employeeOverrides', e);
    return [];
  }
}

/** Set — or clear — one person's override of one component. */
export async function saveEmployeeOverride(
  employeeId: string,
  componentId: string,
  value: number | null,
  enabled: boolean,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(employeeId) || !isUuid(componentId)) {
    return { ok: false, error: 'That employee or component no longer exists. Reload the page.' };
  }
  const v = value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  if (v !== null && v < 0) return { ok: false, error: 'An override cannot be negative.' };
  try {
    await ensurePayrollSchema();
    await db.execute(sql`
      INSERT INTO payroll_employee_component (employee_id, component_id, employee_value, enabled, updated_by)
      VALUES (${employeeId}::uuid, ${componentId}::uuid, ${v}, ${enabled === true}, ${actorUserId}::uuid)
      ON CONFLICT (employee_id, component_id) DO UPDATE
        SET employee_value = EXCLUDED.employee_value,
            enabled = EXCLUDED.enabled,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by`);
    await logAudit({
      userId: actorUserId, action: 'payroll.override.saved', entity: 'hr_employee',
      entityId: employeeId, diff: { componentId, value: v, enabled: enabled === true },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('saveEmployeeOverride', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// COMPUTATION
// -------------------------------------------------------------------------------------------------

export interface PayLine {
  code: string;
  label: string;
  kind: ComponentKind;
  basis: ComponentBasis;
  /** The rate or fixed amount actually applied, so the payslip can show WHY the number is what it is. */
  rate: number;
  amount: number;
  employerAmount: number;
  statutory: boolean;
  sortOrder: number;
}

export interface PayComputation {
  employeeId: string;
  currency: string;
  basic: number;
  earnings: PayLine[];
  deductions: PayLine[];
  grossEarnings: number;
  totalDeductions: number;
  net: number;
  /** Gross plus every employer share — what the employee costs the company for the month. */
  employerCost: number;
  /**
   * GROSS BEFORE ANY BONUS — basic plus the recurring earning components, and nothing else.
   *
   * This is the figure loss of pay and every percentage-of-gross deduction are computed against, and
   * the separation is deliberate. A person who was absent two days has not forfeited two days of a
   * one-off award they were given for something entirely different, and an administrator who set a
   * percentage against a monthly salary did not set it against an award that happens once. Folding a
   * bonus into that base would quietly change both numbers in the month somebody was rewarded, which
   * is the month they are most likely to check.
   */
  regularGross: number;
  /** Every approved bonus and incentive falling in this month. Part of gross, outside the base above. */
  bonusTotal: number;
  /** Loan and salary-advance recovery deducted this month. */
  loanRecovery: number;
  /**
   * True when a loan repayment had to be REDUCED because the month's pay could not carry it.
   *
   * A deduction is never allowed to push net pay below zero, and the ledger records what was actually
   * taken rather than what was planned — otherwise a loan would show as repaid by money the person
   * never had, and the shortfall would vanish. The screen must say this out loud when it happens.
   */
  loanRecoveryReduced: boolean;
  /**
   * True when ANY deduction had to be reduced because the month's pay could not carry it.
   *
   * The counterpart to loanRecoveryReduced for everything that is not a loan. A screen that shows a
   * payslip must be able to say "tax was reduced from 5,000 to 0 because there was no pay to withhold
   * it from" rather than printing a figure that silently disagrees with the salary structure behind
   * it. See the deduction-order table above fitDeductionsToGross().
   */
  deductionsReduced: boolean;
  /** Every line that was reduced, with what was planned and what the month could carry. */
  deductionReductions: DeductionReduction[];
  /** The awards that produced the bonus lines, for the caller to write into the payout ledger. */
  bonusCharges: BonusCharge[];
  /** The loans that produced the recovery lines, at the amounts ACTUALLY applied. */
  loanCharges: LoanCharge[];
  lopDays: number;
  lopDeduction: number;
  daysWorked: number;
  daysLeave: number;
  daysAbsent: number;
  /** True when the component catalogue has no active statutory component at all. Not an error — an
   *  honest fact a screen must be able to state rather than imply a deduction was calculated. */
  noStatutoryComponents: boolean;
  /** Named things that could not be read, in words. Never an empty list dressed up as a zero. */
  gaps: string[];
}

/** Whether a deduction applies at this gross. Both bounds are inclusive; either may be absent. */
function withinBand(c: PayrollComponent, gross: number): boolean {
  if (c.minGross !== null && gross < c.minGross) return false;
  if (c.maxGross !== null && gross > c.maxGross) return false;
  return true;
}

function applyCap(amount: number, cap: number | null): number {
  if (cap === null) return round2(amount);
  return round2(Math.min(amount, cap));
}

// -------------------------------------------------------------------------------------------------
// THE ORDER DEDUCTIONS COME OFF PAY — written down here because a payslip has to be reconstructable.
// -------------------------------------------------------------------------------------------------
//
// A month's pay can be smaller than the sum of everything somebody wants to take out of it. Full loss
// of pay leaves nothing to withhold tax from; a big typed-in "other deduction" plus a loan instalment
// can exceed what is left. SOMETHING has to give, and which thing gives is a policy decision, not an
// accident of the order two `for` loops happen to run in.
//
// WHAT WENT WRONG BEFORE. Only loan recovery was fitted to the money available. Everything else was
// summed unconditionally, and `net` was then clamped with Math.max(0, ...). So a payslip could be
// written — and PRINTED by src/lib/hr-payslip.ts, which shows all three figures — reading:
//
//     gross 40,000    total deductions 45,000    net 0
//
// Three numbers on one document that do not make an equation. An employee cannot check it, an
// accountant cannot reconcile it, and nothing in the product said the 5,000 had gone anywhere.
//
// THE ORDER, LEAST PROTECTED FIRST. Anything that must be reduced is reduced from the top of this
// list downwards, and a line reduced to nothing is dropped rather than printed as a zero:
//
//   4  LOAN AND ADVANCE RECOVERY   — money owed to the employer. The employer can wait a month; the
//                                    balance stays on the loan ledger and is recovered next run.
//   3  VOLUNTARY DEDUCTIONS        — anything an administrator configured that is not marked
//                                    statutory. Elective, so it yields before anything compulsory.
//   2  TYPED-IN TAX AND OTHER      — the legacy hr_salary_structures.tds / other_deductions columns.
//                                    A withholding figure typed against a full month's salary is not
//                                    owed on a month that was not paid.
//   1  STATUTORY COMPONENTS        — provident fund and the like, computed from the catalogue. Almost
//                                    never reduced, and only when there is genuinely no pay left.
//   0  LOSS OF PAY                 — NEVER reduced. It is not a deduction taken out of earnings; it is
//                                    the absence of earnings, and it can never exceed regular gross by
//                                    construction (lopDays is capped at the days in the month).
//
// AFTER THIS PASS, total deductions cannot exceed gross, so net is a subtraction rather than a clamp
// and gross - deductions = net holds on the row, on the payslip and on every screen that adds them up.
//
// WHAT THE EMPLOYEE IS TOLD. Every reduction is returned in `deductionReductions` with the planned
// and applied figures, so the screen can name the line that was cut and by how much instead of
// showing a number that quietly disagrees with the instruction behind it.

/** Lower is more protected. See the table above; this is the only place the ranking is expressed. */
function deductionRank(line: PayLine): number {
  if (line.code === 'loss_of_pay') return 0;
  if (line.statutory) return 1;
  if (line.code === 'tds' || line.code === 'other_deductions') return 2;
  if (line.code.startsWith('loan:')) return 4;
  return 3;
}

export interface DeductionReduction {
  code: string;
  label: string;
  /** What the configuration or the typed column asked for. */
  planned: number;
  /** What the month could actually carry. Zero means the line was dropped entirely. */
  applied: number;
}

/**
 * Reduce deductions, least protected first, until they fit inside `gross`.
 *
 * MUTATES the lines it is given and returns what it changed. Called with the deductions assembled so
 * far and the gross they are being taken from; loan recovery is fitted separately and afterwards,
 * into the room this pass leaves behind, so the two mechanisms cannot disagree.
 */
function fitDeductionsToGross(lines: PayLine[], gross: number): DeductionReduction[] {
  const reductions: DeductionReduction[] = [];
  let over = round2(sumMoney(lines.map((l) => l.amount)) - gross);
  if (over <= 0) return reductions;

  // Highest rank first, and within a rank the largest line first — so one big elective deduction
  // absorbs the shortfall before several small ones are each disturbed.
  const order = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => deductionRank(b.l) - deductionRank(a.l) || b.l.amount - a.l.amount);

  for (const { l } of order) {
    if (over <= 0) break;
    if (deductionRank(l) === 0) continue; // loss of pay is never reduced
    if (l.amount <= 0) continue;
    const cut = round2(Math.min(l.amount, over));
    const applied = round2(l.amount - cut);
    reductions.push({ code: l.code, label: l.label, planned: l.amount, applied });
    l.amount = applied;
    l.rate = l.basis === 'fixed' ? applied : l.rate;
    over = round2(over - cut);
  }

  return reductions;
}

/**
 * WHAT THIS PERSON IS PAID FOR THIS MONTH, and every component that made it up.
 *
 * READ-ONLY. It writes nothing, so a screen can show a preview of a run before anybody commits to
 * one — which is the difference between "generate payroll and see what happened" and "look at what
 * payroll would do".
 */
export async function computePay(
  employeeId: string,
  opts: { month: number; year: number },
): Promise<PayComputation> {
  const month = Math.max(1, Math.min(12, Math.round(Number(opts?.month) || 0)));
  const year = Math.max(1970, Math.min(9999, Math.round(Number(opts?.year) || 0)));
  const gaps: string[] = [];

  const empty: PayComputation = {
    employeeId, currency: 'INR', basic: 0, earnings: [], deductions: [],
    grossEarnings: 0, totalDeductions: 0, net: 0, employerCost: 0,
    regularGross: 0, bonusTotal: 0, loanRecovery: 0, loanRecoveryReduced: false,
    deductionsReduced: false, deductionReductions: [],
    bonusCharges: [], loanCharges: [],
    lopDays: 0, lopDeduction: 0, daysWorked: 0, daysLeave: 0, daysAbsent: 0,
    noStatutoryComponents: true, gaps,
  };
  if (!isUuid(employeeId)) {
    gaps.push('this account is not linked to an employee record');
    return empty;
  }

  // ---- the structure: basic, currency, and the legacy fixed columns --------------------------------
  let structure: any = null;
  let baseSalary = 0;
  let currency = 'INR';
  try {
    const r = await db.execute(sql`
      SELECT ss.*, e.base_salary, e.currency AS emp_currency
        FROM hr_employees e
        LEFT JOIN hr_salary_structures ss ON ss.employee_id = e.id
             AND ss.effective_from <= CURRENT_DATE
             AND (ss.effective_to IS NULL OR ss.effective_to >= CURRENT_DATE)
       WHERE e.id = ${employeeId}::uuid
       ORDER BY ss.effective_from DESC NULLS LAST
       LIMIT 1`);
    structure = rows(r)[0] || null;
    baseSalary = Number(structure?.base_salary) || 0;
    currency = String(structure?.currency || structure?.emp_currency || 'INR');
  } catch (e: any) {
    logFail('computePay.structure', e);
    gaps.push('the salary structure on file');
  }

  const basic = round2(Number(structure?.basic) || baseSalary || 0);

  // ---- the catalogue and this person's overrides ---------------------------------------------------
  const catalogue = await listComponents();
  const overrides = await employeeOverrides(employeeId);
  const overrideBy = new Map<string, EmployeeOverride>();
  for (const o of overrides) overrideBy.set(o.componentId, o);

  const configuredCodes = new Set<string>(catalogue.map((c) => c.code));

  const earnings: PayLine[] = [];
  const deductions: PayLine[] = [];

  // Legacy allowance columns first, and only where no component has claimed the code.
  for (const l of LEGACY_EARNINGS) {
    if (configuredCodes.has(l.code)) continue;
    const amount = round2(Number(structure?.[l.column]) || 0);
    if (amount <= 0) continue;
    earnings.push({
      code: l.code, label: l.label, kind: 'earning', basis: 'fixed',
      rate: amount, amount, employerAmount: 0, statutory: false, sortOrder: 20,
    });
  }

  // Configured EARNINGS. percent_of_gross is refused at save time, so only two bases arrive here.
  for (const c of catalogue) {
    if (c.kind !== 'earning') continue;
    const o = overrideBy.get(c.id);
    if (o && !o.enabled) continue;
    const value = o && o.employeeValue !== null ? o.employeeValue : c.employeeValue;
    const amount = c.basis === 'percent_of_basic'
      ? applyCap(basic * (value / 100), c.capAmount)
      : applyCap(value, c.capAmount);
    if (amount <= 0) continue;
    const employerAmount = c.basis === 'percent_of_basic'
      ? applyCap(basic * (c.employerValue / 100), c.employerCapAmount)
      : applyCap(c.employerValue, c.employerCapAmount);
    earnings.push({
      code: c.code, label: c.label, kind: 'earning', basis: c.basis,
      rate: value, amount, employerAmount, statutory: c.statutory, sortOrder: c.sortOrder,
    });
  }

  // REGULAR GROSS — basic plus the recurring earnings, and no bonus. See PayComputation.regularGross
  // for why the two are kept apart; every band test, every percentage and the loss-of-pay day rate
  // below are computed against THIS number, not against a month that happened to carry an award.
  const regularGross = sumMoney([basic, ...earnings.map((l) => l.amount)]);

  // ---- attendance and loss of pay ------------------------------------------------------------------
  //
  // Unchanged in substance from what /admin/hr/payroll already did, and moved here so the run and any
  // preview compute it the same way. LOP is not statutory: it is a day not worked, priced at the
  // month's own per-day gross.
  let daysWorked = 0, daysLeave = 0, daysAbsent = 0;
  try {
    const att = rows(await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE status = 'present' OR status = 'wfh') AS days_worked,
             COUNT(*) FILTER (WHERE status = 'on_leave') AS days_leave,
             COUNT(*) FILTER (WHERE status = 'absent') AS days_absent
        FROM hr_attendance
       WHERE employee_id = ${employeeId}::uuid
         AND EXTRACT(MONTH FROM date) = ${month}
         AND EXTRACT(YEAR FROM date) = ${year}`))[0] || {};
    daysWorked = Number(att.days_worked) || 0;
    daysLeave = Number(att.days_leave) || 0;
    daysAbsent = Number(att.days_absent) || 0;
  } catch (e: any) {
    logFail('computePay.attendance', e);
    gaps.push('attendance for this month');
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  let unpaidDays = 0;
  try {
    const up = rows(await db.execute(sql`
      SELECT COALESCE(SUM(
        (LEAST(end_date, make_date(${year}, ${month}, ${daysInMonth}))
         - GREATEST(start_date, make_date(${year}, ${month}, 1))) + 1
      ), 0)::int AS d
      FROM hr_leave_request
      WHERE employee_id = ${employeeId}::uuid AND status = 'approved' AND leave_type = 'unpaid'
        AND start_date <= make_date(${year}, ${month}, ${daysInMonth})
        AND end_date   >= make_date(${year}, ${month}, 1)`))[0] || {};
    unpaidDays = Number(up.d) || 0;
  } catch (e: any) {
    logFail('computePay.unpaidLeave', e);
    gaps.push('approved unpaid leave for this month');
  }

  // ---- ONE DAY IS ONE DEDUCTION -------------------------------------------------------------------
  //
  // THIS WAS `unpaidDays + daysAbsent`, AND IT CHARGED THE SAME DAY TWICE.
  //
  // The two figures are read from two different tables that describe the SAME calendar days from two
  // directions: hr_leave_request says "this person had approved unpaid leave from the 3rd to the 7th",
  // and hr_attendance says "this person did not clock in on the 3rd to the 7th". Marking an attendance
  // row 'absent' for a day with no clock-in is exactly what an operator does — it is what the bulk-mark
  // button on /admin/hr/attendance is for — so for approved unpaid leave BOTH rows normally exist.
  // Adding them made five days of approved leave cost ten days of pay: on a gross of 62,000 in a
  // 31-day month, 20,000 deducted where 10,000 was owed.
  //
  // The overlap has to be resolved on DATES, which means asking the database rather than adding two
  // scalars. absentDaysNotOnUnpaidLeave counts attendance rows marked absent EXCEPT those falling
  // inside an approved unpaid-leave range, so each calendar day contributes exactly one day of loss of
  // pay however many tables record it.
  //
  // daysAbsent itself is NOT changed: it is the attendance fact and the attendance screens print it.
  // Only the money is corrected.
  let absentDaysNotOnUnpaidLeave = daysAbsent;
  try {
    const ab = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS d
        FROM hr_attendance a
       WHERE a.employee_id = ${employeeId}::uuid
         AND a.date >= make_date(${year}, ${month}, 1)
         AND a.date <= make_date(${year}, ${month}, ${daysInMonth})
         AND a.status = 'absent'
         AND NOT EXISTS (
           SELECT 1 FROM hr_leave_request lr
            WHERE lr.employee_id = a.employee_id
              AND lr.status = 'approved'
              AND lr.leave_type = 'unpaid'
              AND a.date BETWEEN lr.start_date AND lr.end_date
         )`))[0] || {};
    absentDaysNotOnUnpaidLeave = Number(ab.d) || 0;
  } catch (e: any) {
    // A FAILED READ MUST NOT SILENTLY RESTORE THE DOUBLE CHARGE. Falling back to the raw daysAbsent
    // is the old, wrong arithmetic, so it is said out loud on the payslip's gap list rather than
    // applied quietly.
    logFail('computePay.absentNotOnLeave', e);
    gaps.push('which absences were already covered by approved unpaid leave, so a day may be counted twice in loss of pay');
  }

  const lopDays = Math.min(daysInMonth, Math.max(0, unpaidDays) + Math.max(0, absentDaysNotOnUnpaidLeave));
  // MULTIPLY FIRST, ROUND ONCE. Rounding the per-day rate and then multiplying it by the day count
  // multiplies the rounding error by that count as well: 62,000 over 31 days is 2000.00 exactly, but
  // 75,000 over 31 days is 2419.354838..., and a rounded 2419.35 times 31 is 74,999.85 — a month of
  // absence that does not cost a month of pay. The division stays inside the single round2.
  const lopDeduction = daysInMonth > 0 ? round2((regularGross * lopDays) / daysInMonth) : 0;

  if (lopDeduction > 0) {
    deductions.push({
      code: 'loss_of_pay',
      label: 'Loss of pay (' + lopDays + ' day' + (lopDays === 1 ? '' : 's') + ')',
      kind: 'deduction', basis: 'fixed', rate: lopDeduction, amount: lopDeduction,
      employerAmount: 0, statutory: false, sortOrder: 10,
    });
  }

  // Legacy deduction columns a human typed in, where no component claims the code.
  for (const l of LEGACY_DEDUCTIONS) {
    if (configuredCodes.has(l.code)) continue;
    const amount = round2(Number(structure?.[l.column]) || 0);
    if (amount <= 0) continue;
    deductions.push({
      code: l.code, label: l.label, kind: 'deduction', basis: 'fixed',
      rate: amount, amount, employerAmount: 0, statutory: false, sortOrder: 60,
    });
  }

  // Configured DEDUCTIONS — computed against the final gross, so the band test is meaningful.
  let statutoryConfigured = false;
  for (const c of catalogue) {
    if (c.kind !== 'deduction') continue;
    if (c.statutory) statutoryConfigured = true;
    const o = overrideBy.get(c.id);
    if (o && !o.enabled) continue;
    if (!withinBand(c, regularGross)) continue;
    const value = o && o.employeeValue !== null ? o.employeeValue : c.employeeValue;
    const raw = c.basis === 'percent_of_basic' ? basic * (value / 100)
      : c.basis === 'percent_of_gross' ? regularGross * (value / 100)
        : value;
    const amount = applyCap(raw, c.capAmount);
    const employerRaw = c.basis === 'percent_of_basic' ? basic * (c.employerValue / 100)
      : c.basis === 'percent_of_gross' ? regularGross * (c.employerValue / 100)
        : c.employerValue;
    const employerAmount = applyCap(employerRaw, c.employerCapAmount);
    if (amount <= 0 && employerAmount <= 0) continue;
    deductions.push({
      code: c.code, label: c.label, kind: 'deduction', basis: c.basis,
      rate: value, amount, employerAmount, statutory: c.statutory, sortOrder: c.sortOrder,
    });
  }

  // ---- BONUSES AND INCENTIVES ----------------------------------------------------------------------
  //
  // Approved awards only, and each of them counted once. src/lib/payroll-bonuses.ts decides which
  // awards fall in this month and stops a one-off from ever paying twice; this file only prints what
  // it is told and, later, records that the payout happened. A bonus is an EARNING, so it is part of
  // gross and part of net — it simply is not part of the base the deductions above were priced from.
  let bonusCharges: BonusCharge[] = [];
  try {
    bonusCharges = await plannedBonuses(employeeId, { month, year });
  } catch (e: any) {
    logFail('computePay.bonuses', e);
    gaps.push('approved bonuses for this month');
  }
  // AN AWARD IN ANOTHER CURRENCY IS NOT ADDED TO THIS PAYSLIP.
  //
  // hr_bonus_awards records a currency and so does the salary structure, and until now neither was
  // compared: BonusCharge dropped the field entirely, so an award of USD 2,000 arrived here as the
  // number 2000 and was pushed onto a rupee payslip as a 2,000 rupee earning. The currency did not
  // convert — it stopped existing.
  //
  // THIS MODULE IS NOT A CONVERTER, AND MUST NOT BECOME ONE. There is no exchange rate anywhere in
  // this codebase, and a rate invented in a payroll file, applied to somebody's pay, on a date nobody
  // recorded, is worse than the bug it would be fixing. So the mismatch is REFUSED and NAMED: the
  // award is left unpaid and out of gross, and the reason goes on the gap list, which every payroll
  // screen already prints. Somebody then either re-records the award in the payslip currency or pays
  // it outside payroll — both of which are decisions a person makes, with a rate they can defend.
  const payableBonuses: BonusCharge[] = [];
  for (const b of bonusCharges) {
    const awardCurrency = String(b.currency || currency);
    if (awardCurrency !== currency) {
      gaps.push(
        'the award "' + b.label + '" is recorded in ' + awardCurrency + ' and this payslip is in '
        + currency + ', so it has NOT been added to this month. There is no exchange rate in this '
        + 'system to convert it with — re-record it in ' + currency + ' or pay it outside payroll.',
      );
      continue;
    }
    payableBonuses.push(b);
    earnings.push({
      code: 'bonus:' + b.bonusId,
      label: b.label,
      kind: 'earning', basis: 'fixed', rate: b.amount, amount: b.amount,
      employerAmount: 0, statutory: false, sortOrder: 30,
    });
  }
  // A REFUSED AWARD IS ALSO NOT RECORDED AS PAID. bonusCharges is what generateRun() writes into the
  // bonus ledger through recordBonusPayout(), so it has to be the awards that actually reached the
  // payslip — otherwise a one-off nobody was paid would be marked spent and never pay at all.
  bonusCharges = payableBonuses;
  const bonusTotal = sumMoney(bonusCharges.map((b) => b.amount));
  const grossEarnings = round2(regularGross + bonusTotal);

  // ---- LOAN AND SALARY-ADVANCE RECOVERY -------------------------------------------------------------
  //
  // LAST, AND CAPPED AT WHAT THE MONTH CAN CARRY. Everything else has already been deducted, so the
  // room left is exactly gross minus those deductions. A repayment is reduced to fit that room and
  // the REDUCED figure is what goes on the payslip AND into the loan ledger — because recording the
  // full instalment while deducting less would show a loan as repaid with money the person never
  // had, and the shortfall would disappear from every screen at once.
  //
  // A recovery reduced to zero produces no line at all rather than a zero line, and the caller is
  // told through loanRecoveryReduced so it can say so instead of showing a repayment that silently
  // did not happen.
  // EVERYTHING EXCEPT LOAN RECOVERY IS FITTED TO THE MONTH FIRST, in the documented order above.
  // Without this, `room` below was computed from a deduction total that could already exceed gross,
  // so it clamped to zero, no loan was recovered — and the excess simply stayed in totalDeductions
  // where the net clamp hid it.
  const deductionReductions = fitDeductionsToGross(deductions, grossEarnings);
  const deductionsReduced = deductionReductions.length > 0;
  // A line reduced all the way to nothing is dropped, not printed as a zero: "Tax deducted at source
  // 0.00" reads as a calculated figure rather than as a deduction that could not be taken.
  for (let i = deductions.length - 1; i >= 0; i--) {
    if (deductions[i].amount <= 0 && deductions[i].employerAmount <= 0) deductions.splice(i, 1);
  }

  const deductionsBeforeLoans = sumMoney(deductions.map((l) => l.amount));
  let room = round2(Math.max(0, grossEarnings - deductionsBeforeLoans));

  let plannedLoans: LoanCharge[] = [];
  try {
    plannedLoans = await plannedRecoveries(employeeId, { month, year });
  } catch (e: any) {
    logFail('computePay.loans', e);
    gaps.push('loan and advance balances');
  }

  const loanCharges: LoanCharge[] = [];
  let loanRecoveryReduced = false;
  for (const c of plannedLoans) {
    const applied = round2(Math.min(c.amount, room));
    if (applied < c.amount) loanRecoveryReduced = true;
    if (applied <= 0) continue;
    room = round2(room - applied);
    // Carry the shortfall into what is still owed AFTER this month, so the caller and the payslip
    // both describe the balance the ledger will actually hold.
    const remainingAfter = round2(c.remainingAfter + (c.amount - applied));
    const adjusted: LoanCharge = {
      ...c,
      amount: applied,
      interestPart: round2(Math.min(c.interestPart, applied)),
      principalPart: round2(applied - Math.min(c.interestPart, applied)),
      remainingAfter,
      finalInstalment: remainingAfter <= 0,
    };
    loanCharges.push(adjusted);
    deductions.push({
      code: 'loan:' + c.loanId,
      label: c.label,
      kind: 'deduction', basis: 'fixed', rate: applied, amount: applied,
      employerAmount: 0, statutory: false, sortOrder: 70,
    });
  }
  const loanRecovery = sumMoney(loanCharges.map((c) => c.amount));

  earnings.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  deductions.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));

  // TOTALS ARE SUMMED IN PAISE so the printed total equals the printed lines exactly. Adding doubles
  // left to right accumulates error that a long payslip can carry into the second decimal; adding
  // integers cannot. See sumMoney() in src/lib/money.ts.
  const totalDeductions = sumMoney(deductions.map((l) => l.amount));
  const employerShare = sumMoney([
    ...earnings.map((l) => l.employerAmount),
    ...deductions.map((l) => l.employerAmount),
  ]);

  return {
    employeeId,
    currency,
    basic,
    earnings,
    deductions,
    grossEarnings,
    totalDeductions,
    // A SUBTRACTION, NOT A CLAMP. This was Math.max(0, gross - deductions), which produced a net of
    // zero on a payslip whose own two other figures said otherwise and printed all three. After
    // fitDeductionsToGross() above, totalDeductions cannot exceed grossEarnings, so this subtraction
    // is non-negative by construction — and if that invariant is ever broken by a future change, the
    // number goes negative and is VISIBLE instead of being quietly floored.
    net: round2(grossEarnings - totalDeductions),
    employerCost: round2(grossEarnings + employerShare),
    regularGross,
    bonusTotal,
    loanRecovery,
    loanRecoveryReduced,
    deductionsReduced,
    deductionReductions,
    bonusCharges,
    loanCharges,
    lopDays,
    lopDeduction,
    daysWorked,
    daysLeave,
    daysAbsent,
    noStatutoryComponents: !statutoryConfigured,
    gaps,
  };
}

// -------------------------------------------------------------------------------------------------
// THE RUN
// -------------------------------------------------------------------------------------------------

export interface RunSummary {
  ok: boolean;
  error?: string;
  runId?: string;
  employees: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  totalEmployerCost: number;
  /** Employees whose payslip could not be written, by name, so nobody is quietly left out of payroll. */
  failed: string[];
  /** True when no statutory component is configured. The caller MUST say so on screen. */
  noStatutoryComponents: boolean;
  /**
   * PAYSLIPS THAT WERE WRITTEN, BUT WHOSE LOAN OR BONUS LEDGER ROW WAS NOT.
   *
   * A different and worse failure from a payslip that could not be written at all, which is why it
   * has its own list and its own words. The pay document already says a repayment was deducted, or a
   * bonus paid; if the ledger did not record it, the loan balance stays high and the person is
   * charged again next month, or the one-off bonus pays a second time. The caller MUST show these —
   * they are the one thing on this summary that somebody has to go and fix by hand.
   */
  ledgerWarnings: string[];
}

/**
 * Generate a payroll run for one month.
 *
 * IDEMPOTENT ON (month, year): hr_payroll_runs carries a unique constraint on the period, and this
 * refuses rather than creating a second run. Payslips are inserted ON CONFLICT DO NOTHING against
 * hr_payslips_run_emp_key, so a retried submit cannot double-pay anybody.
 *
 * A PER-EMPLOYEE FAILURE DOES NOT ABORT THE RUN, and it is not silent either: the name goes into
 * `failed`, the cause goes into the log, and the caller shows the list. Aborting on one bad row
 * leaves half a company unpaid; hiding it leaves one person unpaid and nobody knowing.
 */
export async function generateRun(
  month: number,
  year: number,
  actorUserId: string | null,
  notes: string = '',
): Promise<RunSummary> {
  const m = Math.round(Number(month) || 0);
  const y = Math.round(Number(year) || 0);
  const blank: RunSummary = {
    ok: false, employees: 0, totalGross: 0, totalDeductions: 0, totalNet: 0,
    totalEmployerCost: 0, failed: [], noStatutoryComponents: true, ledgerWarnings: [],
  };
  if (m < 1 || m > 12) return { ...blank, error: 'Pick a month between January and December.' };
  if (y < 2000 || y > 2100) return { ...blank, error: 'That is not a year this payroll covers.' };

  try {
    await ensurePayrollSchema();

    const existing = rows(await db.execute(sql`
      SELECT id, status FROM hr_payroll_runs WHERE month = ${m} AND year = ${y} LIMIT 1`));
    if (existing.length) {
      return {
        ...blank,
        error: 'A payroll run for ' + MONTH_NAMES[m - 1] + ' ' + y + ' already exists ('
          + String(existing[0].status) + '). Open it rather than creating a second one.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_payroll_runs (month, year, status, notes, processed_by)
      VALUES (${m}, ${y}, 'draft', ${String(notes || '').trim().slice(0, 500) || null}, ${actorUserId}::uuid)
      RETURNING id`));
    if (!ins.length) return { ...blank, error: WRITE_FAILED };
    const runId = String(ins[0].id);

    const employees = rows(await db.execute(sql`
      SELECT id, full_name FROM hr_employees WHERE is_active = true ORDER BY full_name`));

    let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerCost = 0, count = 0;
    const failed: string[] = [];
    const ledgerWarnings: string[] = [];
    let noStatutory = true;

    for (const emp of employees) {
      const empId = String(emp.id);
      try {
        const pay = await computePay(empId, { month: m, year: y });
        if (!pay.noStatutoryComponents) noStatutory = false;

        // The legacy fixed columns, filled from whichever lines map onto them, so every existing
        // reader of hr_payslips keeps rendering exactly what it rendered before.
        const legacy: Record<string, number> = {};
        for (const line of [...pay.earnings, ...pay.deductions]) {
          const col = LEGACY_PAYSLIP_COLUMN[line.code];
          if (col) legacy[col] = round2((legacy[col] || 0) + line.amount);
        }
        const otherAllowances = sumMoney([
          ...pay.earnings.filter((l) => !LEGACY_PAYSLIP_COLUMN[l.code]).map((l) => l.amount),
          legacy.other_allowances || 0,
        ]);
        const otherDeductions = sumMoney([
          ...pay.deductions
            .filter((l) => !LEGACY_PAYSLIP_COLUMN[l.code] && l.code !== 'loss_of_pay')
            .map((l) => l.amount),
          legacy.other_deductions || 0,
        ]);

        // ---- THE PAYSLIP MUST ADD UP, AND SOMEBODY MUST BE TOLD WHEN IT DOES NOT -----------------
        //
        // hr_payslips stores gross_salary, total_deductions and net_salary as three independent
        // numbers, AND a lossy legacy projection of the component lines into fixed columns (hra, da,
        // tds ...). Nothing anywhere asserted that either set reconciles, so a payslip whose columns
        // did not sum back to its own totals printed exactly like one that did.
        //
        // Two identities are checked against the very figures being written on this row:
        //
        //   basic + every allowance column                 == gross_salary
        //   pf + esic + pt + tds + other_deductions + lop  == total_deductions
        //
        // lop_deduction belongs in the second sum precisely because otherDeductions EXCLUDES
        // loss_of_pay (it has its own column) — so the projection only balances when that column is
        // added back, which is the kind of fact that stops being true the moment somebody edits one
        // of the two places and not the other.
        //
        // NOT FATAL. The row is still the best record of the run, and refusing to write it would
        // leave the employee with no payslip at all. But it is a number a human will query one day,
        // so it is named now rather than discovered then.
        const legacyGross = sumMoney([
          pay.basic, legacy.hra || 0, legacy.da || 0, legacy.special_allowance || 0,
          legacy.transport_allowance || 0, legacy.medical_allowance || 0, otherAllowances,
        ]);
        const legacyDeductions = sumMoney([
          legacy.pf_employee || 0, legacy.esic_employee || 0, legacy.professional_tax || 0,
          legacy.tds || 0, otherDeductions, pay.lopDeduction,
        ]);
        if (legacyGross !== pay.grossEarnings) {
          const msg = 'The payslip for employee ' + empId + ' stores allowance columns adding to '
            + legacyGross.toFixed(2) + ' against a gross of ' + pay.grossEarnings.toFixed(2)
            + '. The component lines are the true detail; the fixed columns are a projection of them, '
            + 'and this one does not reconcile.';
          console.error('[payroll] payslip gross does not reconcile -', msg);
          ledgerWarnings.push(msg);
        }
        if (legacyDeductions !== pay.totalDeductions) {
          const msg = 'The payslip for employee ' + empId + ' stores deduction columns adding to '
            + legacyDeductions.toFixed(2) + ' against total deductions of '
            + pay.totalDeductions.toFixed(2) + '. The component lines are the true detail.';
          console.error('[payroll] payslip deductions do not reconcile -', msg);
          ledgerWarnings.push(msg);
        }

        const slip = rows(await db.execute(sql`
          INSERT INTO hr_payslips (
            payroll_run_id, employee_id, month, year,
            days_worked, days_leave, days_absent, lop_days, lop_deduction,
            basic, hra, da, special_allowance, transport_allowance, medical_allowance,
            other_allowances, gross_salary,
            pf_employee, esic_employee, professional_tax, tds, other_deductions,
            total_deductions, net_salary, employer_cost, currency, status
          ) VALUES (
            ${runId}::uuid, ${empId}::uuid, ${m}, ${y},
            ${pay.daysWorked}, ${pay.daysLeave}, ${pay.daysAbsent}, ${pay.lopDays}, ${pay.lopDeduction},
            ${pay.basic}, ${legacy.hra || 0}, ${legacy.da || 0}, ${legacy.special_allowance || 0},
            ${legacy.transport_allowance || 0}, ${legacy.medical_allowance || 0},
            ${otherAllowances}, ${pay.grossEarnings},
            ${legacy.pf_employee || 0}, ${legacy.esic_employee || 0}, ${legacy.professional_tax || 0},
            ${legacy.tds || 0}, ${otherDeductions},
            ${pay.totalDeductions}, ${pay.net}, ${pay.employerCost}, ${pay.currency}, 'pending'
          )
          ON CONFLICT (payroll_run_id, employee_id) DO NOTHING
          RETURNING id`));

        if (!slip.length) continue; // already generated for this employee — not a failure.
        const slipId = String(slip[0].id);

        for (const line of [...pay.earnings, ...pay.deductions]) {
          await db.execute(sql`
            INSERT INTO hr_payslip_lines
              (payslip_id, code, label, kind, basis, rate, amount, employer_amount, statutory, sort_order)
            VALUES
              (${slipId}::uuid, ${line.code}, ${line.label}, ${line.kind}, ${line.basis},
               ${line.rate}, ${line.amount}, ${line.employerAmount}, ${line.statutory}, ${line.sortOrder})
            ON CONFLICT (payslip_id, code) DO NOTHING`);
        }

        // ---- THE TWO LEDGERS, WRITTEN AFTER THE PAYSLIP EXISTS AND NEVER BEFORE ------------------
        //
        // Order matters. A ledger row pointing at a payslip that was never written would show a loan
        // repaid out of pay that does not exist. Both writes are idempotent on (record, run), so a
        // month generated twice recovers nothing extra and pays no bonus twice.
        //
        // A FAILURE HERE DOES NOT ABORT THE RUN AND IS NOT SWALLOWED. The payslip is already written
        // and correct; what is missing is the record that the money moved. The employee's name and
        // the reason go into ledgerWarnings, which the caller shows, because this is the one class of
        // failure somebody has to go and repair by hand.
        for (const charge of pay.loanCharges) {
          const w = await recordRecovery({
            charge, payrollRunId: runId, payslipId: slipId, month: m, year: y,
          });
          if (!w.ok) {
            ledgerWarnings.push(
              String(emp.full_name || empId) + ': a loan repayment of ' + charge.amount
              + ' was deducted on the payslip but was NOT written to the loan ledger. '
              + 'The balance will still show as owed. ' + (w.error || ''),
            );
          }
        }
        for (const charge of pay.bonusCharges) {
          const w = await recordBonusPayout({
            charge, payrollRunId: runId, payslipId: slipId, month: m, year: y,
          });
          if (!w.ok) {
            ledgerWarnings.push(
              String(emp.full_name || empId) + ': the bonus "' + charge.label
              + '" was paid on the payslip but was NOT written to the award ledger. '
              + 'It may be paid again next month. ' + (w.error || ''),
            );
          }
        }
        if (pay.loanRecoveryReduced) {
          ledgerWarnings.push(
            String(emp.full_name || empId)
            + ': a loan repayment was reduced because this month\'s pay could not carry the full '
            + 'instalment. Only what was actually deducted has been recovered; the rest is still owed.',
          );
        }

        totalGross += pay.grossEarnings;
        totalDeductions += pay.totalDeductions;
        totalNet += pay.net;
        totalEmployerCost += pay.employerCost;
        count++;
      } catch (e: any) {
        logFail('generateRun employee ' + empId, e);
        failed.push(String(emp.full_name || empId));
      }
    }

    await db.execute(sql`
      UPDATE hr_payroll_runs
         SET total_employees = ${count}, total_gross = ${round2(totalGross)},
             total_deductions = ${round2(totalDeductions)}, total_net = ${round2(totalNet)}
       WHERE id = ${runId}::uuid`);

    await logAudit({
      userId: actorUserId, action: 'payroll.run.generated', entity: 'hr_payroll_run', entityId: runId,
      diff: {
        month: m, year: y, employees: count, totalGross: round2(totalGross),
        totalNet: round2(totalNet), failed, noStatutoryComponents: noStatutory,
        ledgerWarnings: ledgerWarnings.length,
      },
    });

    return {
      ok: true, runId, employees: count,
      totalGross: round2(totalGross), totalDeductions: round2(totalDeductions),
      totalNet: round2(totalNet), totalEmployerCost: round2(totalEmployerCost),
      failed, noStatutoryComponents: noStatutory, ledgerWarnings,
    };
  } catch (e: any) {
    logFail('generateRun', e);
    return { ...blank, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// READS FOR THE SURFACES
// -------------------------------------------------------------------------------------------------

export interface PayslipSummary {
  id: string;
  month: number;
  year: number;
  periodLabel: string;
  gross: number;
  totalDeductions: number;
  net: number;
  currency: string;
  status: string;
  paidAt: string | null;
  runStatus: string;
}

/** One employee's own payslips, newest first. Scoped by employee_id in the WHERE clause. */
export async function payslipsForEmployee(employeeId: string, limit = 24): Promise<PayslipSummary[]> {
  if (!isUuid(employeeId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 24, 1), 120);
  try {
    const r = await db.execute(sql`
      SELECT ps.id, ps.month, ps.year, ps.gross_salary, ps.total_deductions, ps.net_salary,
             ps.currency, ps.status, ps.paid_at, pr.status AS run_status
        FROM hr_payslips ps
        LEFT JOIN hr_payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE ps.employee_id = ${employeeId}::uuid
       ORDER BY ps.year DESC, ps.month DESC
       LIMIT ${lim}`);
    return rows(r).map((x) => ({
      id: String(x.id),
      month: Number(x.month) || 1,
      year: Number(x.year) || 0,
      periodLabel: (MONTH_NAMES[(Number(x.month) || 1) - 1] || '') + ' ' + (x.year ?? ''),
      gross: Number(x.gross_salary) || 0,
      totalDeductions: Number(x.total_deductions) || 0,
      net: Number(x.net_salary) || 0,
      currency: String(x.currency || 'INR'),
      status: String(x.status || 'pending'),
      paidAt: x.paid_at ? new Date(x.paid_at).toISOString() : null,
      runStatus: String(x.run_status || ''),
    }));
  } catch (e: any) {
    logFail('payslipsForEmployee', e);
    return [];
  }
}

/** The component lines of one payslip, in print order. Empty for payslips generated before this. */
export async function payslipLines(payslipId: string): Promise<PayLine[]> {
  if (!isUuid(payslipId)) return [];
  if (!(await safeEnsure())) return [];
  try {
    const r = await db.execute(sql`
      SELECT code, label, kind, basis, rate, amount, employer_amount, statutory, sort_order
        FROM hr_payslip_lines
       WHERE payslip_id = ${payslipId}::uuid
       ORDER BY (kind = 'deduction'), sort_order ASC, label ASC`);
    return rows(r).map((x) => ({
      code: String(x.code),
      label: String(x.label),
      kind: (String(x.kind) === 'deduction' ? 'deduction' : 'earning') as ComponentKind,
      basis: (COMPONENT_BASES.indexOf(x.basis) >= 0 ? x.basis : 'fixed') as ComponentBasis,
      rate: Number(x.rate) || 0,
      amount: Number(x.amount) || 0,
      employerAmount: Number(x.employer_amount) || 0,
      statutory: x.statutory === true,
      sortOrder: Number(x.sort_order) || 100,
    }));
  } catch (e: any) {
    logFail('payslipLines', e);
    return [];
  }
}

/**
 * How a basis reads on screen next to a number. Plain words — the payslip must never print a bare
 * percentage that looks like a statutory citation.
 */
export function describeLine(line: PayLine): string {
  if (line.basis === 'percent_of_basic') return line.rate + '% of basic';
  if (line.basis === 'percent_of_gross') return line.rate + '% of gross';
  return '';
}
