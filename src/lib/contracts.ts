// src/lib/contracts.ts — EMPLOYMENT CONTRACTS, and the approvals that change them.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT REFUSES TO BE
// =================================================================================================
//
// A contract record says what somebody was engaged AS, from when, until when, and where the signed
// terms live. Renewing or amending one is a CHANGE TO WHAT SOMEONE IS, so it is not a bare UPDATE
// on a row: it is a request, routed through src/lib/workflow.ts, decided by whoever the organization
// graph names, and only then applied.
//
// APPEND-ONLY, FOR THE SAME REASON THE ORG GRAPH IS. Applying an approved change does not overwrite
// the contract. It marks the existing row `superseded` and writes a NEW row carrying
// `supersedes_contract_id`. So "what were this person's terms last March" stays answerable after
// four renewals, which is the entire reason this is a table of rows rather than a set of columns on
// hr_employees.
//
// THERE IS NO SECOND APPROVAL ENGINE HERE. This module never decides an approval, never resolves a
// manager, and never writes a workflow_steps row. It calls startWorkflow() and then READS the
// instance state back. If routing cannot name an approver the change is recorded as halted with the
// engine's own sentence and NOTHING IS APPLIED — a contract renewal that nobody approved must never
// look like one that somebody did.
//
// DOCUMENTS ARE LINKS, NEVER UPLOADS. `terms_url` holds a link to a shared document. This codebase
// stores no files except a small profile photo, by standing rule, and a contract PDF sitting in blob
// storage is both a cost and a copy of a legal document that nobody is tracking.
//
// INTERNSHIPS ARE UNPAID UNLESS A STIPEND IS EXPLICITLY RECORDED. `stipend_amount` is nullable and
// NULL means unpaid — it is never rendered as a blank or a zero that could be read as "not filled in
// yet". contractPayLabel() below is the one place that sentence is written.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  startWorkflow,
  getInstance,
  type WorkflowInstanceView,
} from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted, and a const declared under the handler that reads it
// throws on that handler's first line — the failure that took down apply step 5 on this project.
// -------------------------------------------------------------------------------------------------

/**
 * THE ZONE A CONTRACT DAY IS CUT ON. Declared at the top of the module, above every reader — `const`
 * is not hoisted.
 *
 * An amendment that does not renew a fixed term starts "today", and that start date is written into
 * hr_employment_contracts.start_date, which is the date the terms someone works under begin. It was
 * CURRENT_DATE: the database SESSION's zone, which nothing in this codebase sets — db/index.ts opens
 * postgres() with no timezone option and no SET TIME ZONE — so it resolves to UTC. IST is UTC+05:30,
 * so an amendment applied between 00:00 and 05:29 IST was dated the PREVIOUS day, and the superseded
 * contract's own end date then sat inside the new contract's term. src/lib/hr-lifecycle.ts and
 * src/lib/attendance.ts name the same zone for the same reason.
 */
const CONTRACT_TIME_ZONE = 'Asia/Kolkata';

/** postgres-js resolves to a PLAIN ARRAY. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const reasonOf = (e: any): string =>
  String(e?.cause?.message || e?.message || 'unknown database error');

const logFail = (tag: string, e: any) => console.error('[contracts] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Reject anything that is not an https link. No vendor domain is hardcoded — the rule is that a
 *  document is a LINK, not which service hosts it. */
const isHttpsLink = (v: unknown): boolean =>
  typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v.trim()) && v.trim().length <= 1000;

/**
 * The kinds of engagement this product actually issues. `internship` is here because internships are
 * a real engagement with real terms, and recording one as `fixed_term` is how an unpaid internship
 * quietly acquires the appearance of a salaried post.
 */
export const CONTRACT_TYPES = [
  { key: 'permanent', label: 'Permanent', note: 'Open-ended. No end date.' },
  { key: 'fixed_term', label: 'Fixed term', note: 'Ends on a stated date unless renewed.' },
  { key: 'probationary', label: 'Probationary', note: 'Runs until confirmation.' },
  { key: 'internship', label: 'Internship', note: 'Unpaid unless a stipend is recorded below.' },
  { key: 'apprenticeship', label: 'Apprenticeship', note: 'Structured training engagement.' },
  { key: 'consultant', label: 'Consultant', note: 'Engaged for a scope, not a post.' },
] as const;

export type ContractTypeKey = (typeof CONTRACT_TYPES)[number]['key'];

const CONTRACT_TYPE_KEYS = new Set<string>(CONTRACT_TYPES.map((t) => t.key));

export function contractTypeLabel(key: string): string {
  for (const t of CONTRACT_TYPES) if (t.key === key) return t.label;
  return String(key || 'Contract');
}

/** renewal extends the same engagement; amendment changes its terms. Two words, two audit trails. */
export const CHANGE_KINDS = [
  { key: 'renewal', label: 'Renewal', note: 'Extend the engagement to a new end date.' },
  { key: 'amendment', label: 'Amendment', note: 'Change the terms of the engagement in force.' },
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number]['key'];

/** What a change request can be. `halted` mirrors the workflow engine's own state, never hides it. */
export type ChangeState = 'pending' | 'approved' | 'rejected' | 'applied' | 'halted' | 'cancelled';

export interface ContractResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** The engine's sentence when routing could not name anybody. Rendered verbatim. */
  haltReason?: string | null;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. Self-bootstrapping, inside an ensureOnce guard, and NOWHERE ELSE.
//
// One CREATE TABLE statement per table, in this file only. Two modules creating one table with
// different shapes silently breaks every write for whichever lost the race — a fault class already
// being repaired elsewhere in this repo. Before adding anything here, grep for the table name.
// -------------------------------------------------------------------------------------------------

export function ensureContractSchema(): Promise<void> {
  return ensureOnce('hr_contracts_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_employment_contracts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
        contract_type VARCHAR(40) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE,
        renewal_due_date DATE,
        notice_days INT,
        terms_url TEXT,
        stipend_amount NUMERIC(14,2),
        stipend_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        supersedes_contract_id UUID,
        note TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_contracts_emp_idx
        ON hr_employment_contracts(employee_id, start_date DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_contracts_status_idx
        ON hr_employment_contracts(status, end_date)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_contract_changes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contract_id UUID NOT NULL REFERENCES hr_employment_contracts(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL,
        change_kind VARCHAR(20) NOT NULL,
        proposed_contract_type VARCHAR(40),
        proposed_end_date DATE,
        proposed_renewal_due_date DATE,
        proposed_notice_days INT,
        proposed_terms_url TEXT,
        proposed_stipend_amount NUMERIC(14,2),
        reason TEXT NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'pending',
        halt_reason TEXT,
        workflow_instance_id UUID,
        requested_by_user_id UUID,
        applied_contract_id UUID,
        applied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_contract_changes_state_idx
        ON hr_contract_changes(state, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hr_contract_changes_emp_idx
        ON hr_contract_changes(employee_id, created_at DESC)`);
    } catch (e: any) {
      // RE-THROWN after logging, exactly as workflow-schema.ts does: ensureOnce drops a failed run
      // from its cache so the next call retries, and a swallowed failure here would leave a
      // permanently, silently empty console with no trace of why.
      logFail('ensureContractSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// READS. Every one fails closed to an empty list or null.
// -------------------------------------------------------------------------------------------------

export interface ContractRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  contractType: string;
  startDate: string | null;
  endDate: string | null;
  renewalDueDate: string | null;
  noticeDays: number | null;
  termsUrl: string | null;
  stipendAmount: number | null;
  stipendCurrency: string;
  status: string;
  supersedesContractId: string | null;
  note: string | null;
  createdAt: string | null;
}

function mapContract(r: any): ContractRow {
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    employeeCode: r?.employee_code ? String(r.employee_code) : null,
    contractType: String(r?.contract_type ?? ''),
    startDate: r?.start_date ? String(r.start_date).slice(0, 10) : null,
    endDate: r?.end_date ? String(r.end_date).slice(0, 10) : null,
    renewalDueDate: r?.renewal_due_date ? String(r.renewal_due_date).slice(0, 10) : null,
    noticeDays: r?.notice_days === null || r?.notice_days === undefined ? null : Number(r.notice_days),
    termsUrl: r?.terms_url ? String(r.terms_url) : null,
    stipendAmount:
      r?.stipend_amount === null || r?.stipend_amount === undefined ? null : Number(r.stipend_amount),
    stipendCurrency: r?.stipend_currency ? String(r.stipend_currency) : 'INR',
    status: String(r?.status ?? 'active'),
    supersedesContractId: r?.supersedes_contract_id ? String(r.supersedes_contract_id) : null,
    note: r?.note ? String(r.note) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/**
 * The one sentence that says what somebody is paid under a contract.
 *
 * NULL stipend on an internship reads "Unpaid", never blank and never zero. A blank invites the
 * reader to assume the field was simply not filled in, and an unpaid internship recorded as an
 * unknown is how a stipend gets promised and never paid.
 */
export function contractPayLabel(c: {
  contractType: string;
  stipendAmount: number | null;
  stipendCurrency: string;
}): string {
  if (c.stipendAmount !== null && isFinite(c.stipendAmount)) {
    return (c.stipendCurrency || 'INR') + ' ' + c.stipendAmount.toLocaleString('en-IN') + ' per month';
  }
  if (c.contractType === 'internship') return 'Unpaid — no stipend recorded';
  return 'No remuneration recorded on this contract';
}

/** Every contract for one person, newest engagement first. History included, by design. */
export async function contractsForEmployee(employeeId: string): Promise<ContractRow[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureContractSchema();
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name, e.employee_code AS employee_code
        FROM hr_employment_contracts c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.employee_id = ${employeeId}::uuid
       ORDER BY c.start_date DESC, c.created_at DESC
       LIMIT 200`);
    return rows(r).map(mapContract);
  } catch (e: any) {
    logFail('contractsForEmployee', e);
    return [];
  }
}

/** The contract in force for this person, or null. */
export async function activeContractFor(employeeId: string): Promise<ContractRow | null> {
  if (!isUuid(employeeId)) return null;
  try {
    await ensureContractSchema();
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name, e.employee_code AS employee_code
        FROM hr_employment_contracts c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.employee_id = ${employeeId}::uuid
         AND c.status = 'active'
       ORDER BY c.start_date DESC, c.created_at DESC
       LIMIT 1`);
    const list = rows(r);
    return list.length ? mapContract(list[0]) : null;
  } catch (e: any) {
    logFail('activeContractFor', e);
    return null;
  }
}

/** The register. `status` narrows it; omit for everything. */
export async function listContracts(
  opts: { status?: string; limit?: number } = {},
): Promise<ContractRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureContractSchema();
    const statusFilter = opts.status ? sql`AND c.status = ${String(opts.status)}` : sql``;
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name, e.employee_code AS employee_code
        FROM hr_employment_contracts c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE TRUE ${statusFilter}
       ORDER BY (c.status = 'active') DESC, c.end_date ASC NULLS LAST, c.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapContract);
  } catch (e: any) {
    logFail('listContracts', e);
    return [];
  }
}

/**
 * Active contracts whose end date or renewal date falls inside the next `days` days.
 *
 * A read, and only a read. Nothing here renews anything automatically: a contract that lapsed
 * because a job silently extended it is worse than one that lapsed visibly.
 */
export async function contractsDueForRenewal(days = 60): Promise<ContractRow[]> {
  const window = Math.min(Math.max(Number(days) || 60, 1), 365);
  try {
    await ensureContractSchema();
    const r = await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name, e.employee_code AS employee_code
        FROM hr_employment_contracts c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.status = 'active'
         AND COALESCE(c.renewal_due_date, c.end_date) IS NOT NULL
         -- THE WINDOW OPENS ON THE COMPANY'S DAY. CURRENT_DATE is the database SESSION's date and
         -- nothing in this codebase sets that session's zone, so it resolves to UTC while every
         -- contract on this list is worked in IST. Between 00:00 and 05:29 IST the whole window was
         -- a day short, and a contract falling due on the far edge of it dropped off the renewal
         -- list on the very morning somebody would have acted on it. applyContractChange() in this
         -- same file was moved onto Asia/Kolkata for the same reason.
         AND COALESCE(c.renewal_due_date, c.end_date) <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date + (${window} * INTERVAL '1 day')
       ORDER BY COALESCE(c.renewal_due_date, c.end_date) ASC
       LIMIT 100`);
    return rows(r).map(mapContract);
  } catch (e: any) {
    logFail('contractsDueForRenewal', e);
    return [];
  }
}

export interface ChangeRow {
  id: string;
  contractId: string;
  employeeId: string;
  employeeName: string | null;
  changeKind: string;
  proposedContractType: string | null;
  proposedEndDate: string | null;
  proposedRenewalDueDate: string | null;
  proposedNoticeDays: number | null;
  proposedTermsUrl: string | null;
  proposedStipendAmount: number | null;
  reason: string;
  state: string;
  haltReason: string | null;
  workflowInstanceId: string | null;
  appliedContractId: string | null;
  appliedAt: string | null;
  createdAt: string | null;
}

function mapChange(r: any): ChangeRow {
  return {
    id: String(r?.id ?? ''),
    contractId: String(r?.contract_id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    changeKind: String(r?.change_kind ?? ''),
    proposedContractType: r?.proposed_contract_type ? String(r.proposed_contract_type) : null,
    proposedEndDate: r?.proposed_end_date ? String(r.proposed_end_date).slice(0, 10) : null,
    proposedRenewalDueDate: r?.proposed_renewal_due_date
      ? String(r.proposed_renewal_due_date).slice(0, 10)
      : null,
    proposedNoticeDays:
      r?.proposed_notice_days === null || r?.proposed_notice_days === undefined
        ? null
        : Number(r.proposed_notice_days),
    proposedTermsUrl: r?.proposed_terms_url ? String(r.proposed_terms_url) : null,
    proposedStipendAmount:
      r?.proposed_stipend_amount === null || r?.proposed_stipend_amount === undefined
        ? null
        : Number(r.proposed_stipend_amount),
    reason: String(r?.reason ?? ''),
    state: String(r?.state ?? 'pending'),
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    appliedContractId: r?.applied_contract_id ? String(r.applied_contract_id) : null,
    appliedAt: r?.applied_at ? new Date(r.applied_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Change requests, newest first. `employeeId` narrows to one person's own. */
export async function listContractChanges(
  opts: { employeeId?: string | null; state?: string; limit?: number } = {},
): Promise<ChangeRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    await ensureContractSchema();
    const empFilter = isUuid(opts.employeeId)
      ? sql`AND ch.employee_id = ${String(opts.employeeId)}::uuid`
      : sql``;
    const stateFilter = opts.state ? sql`AND ch.state = ${String(opts.state)}` : sql``;
    const r = await db.execute(sql`
      SELECT ch.*, e.full_name AS employee_name
        FROM hr_contract_changes ch
        LEFT JOIN hr_employees e ON e.id = ch.employee_id
       WHERE TRUE ${empFilter} ${stateFilter}
       ORDER BY (ch.state = 'pending') DESC, ch.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapChange);
  } catch (e: any) {
    logFail('listContractChanges', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES. NO BARE catch ANYWHERE BELOW.
//
// Every failure path returns the reason to the caller AND logs it. A swallowed exception in a write
// path is what let a hire report success for eleven days without an employee record existing.
// -------------------------------------------------------------------------------------------------

export interface CreateContractInput {
  employeeId: string;
  contractType: string;
  startDate: string;
  endDate?: string | null;
  renewalDueDate?: string | null;
  noticeDays?: number | null;
  termsUrl?: string | null;
  stipendAmount?: number | null;
  stipendCurrency?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
}

/**
 * Record the contract a person is engaged under.
 *
 * The FIRST contract for a person is written directly — there is nothing to approve, because the
 * engagement itself was approved when they were hired. CHANGES to it go through
 * requestContractChange() and the approval chain; this function refuses to be used as a way round
 * that, by marking any existing active contract superseded ONLY through applyApprovedChange().
 */
export async function createContract(input: CreateContractInput): Promise<ContractResult> {
  const employeeId = String(input?.employeeId || '').trim();
  if (!isUuid(employeeId)) return { ok: false, error: 'Choose the employee this contract belongs to.' };

  const type = String(input?.contractType || '').trim();
  if (!CONTRACT_TYPE_KEYS.has(type)) return { ok: false, error: 'Choose a contract type.' };

  const start = String(input?.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: false, error: 'A contract needs a start date.' };

  const end = input?.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate).trim())
    ? String(input.endDate).trim() : null;
  if (end && end < start) return { ok: false, error: 'The end date is before the start date.' };

  const renewalDue = input?.renewalDueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.renewalDueDate).trim())
    ? String(input.renewalDueDate).trim() : null;

  const noticeDays =
    typeof input?.noticeDays === 'number' && isFinite(input.noticeDays) && input.noticeDays >= 0
      ? Math.min(Math.floor(input.noticeDays), 365)
      : null;

  const termsUrl = input?.termsUrl && String(input.termsUrl).trim() ? String(input.termsUrl).trim() : null;
  if (termsUrl && !isHttpsLink(termsUrl)) {
    return { ok: false, error: 'The terms must be an https link to a shared document, not an uploaded file.' };
  }

  const stipend =
    typeof input?.stipendAmount === 'number' && isFinite(input.stipendAmount) && input.stipendAmount > 0
      ? input.stipendAmount
      : null;
  const currency = input?.stipendCurrency ? String(input.stipendCurrency).slice(0, 8) : 'INR';
  const note = input?.note ? String(input.note).slice(0, 2000) : null;
  const createdBy = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;

  try {
    await ensureContractSchema();

    // An employee may not hold two active contracts at once: which one is in force would then be a
    // guess, and every downstream question ("what is their notice period") would have two answers.
    const open = rows(await db.execute(sql`
      SELECT id FROM hr_employment_contracts
       WHERE employee_id = ${employeeId}::uuid AND status = 'active' LIMIT 1`));
    if (open.length) {
      return {
        ok: false,
        error:
          'This person already has a contract in force. Renew or amend that one instead — that is what keeps the history intact.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_employment_contracts
        (employee_id, contract_type, start_date, end_date, renewal_due_date, notice_days,
         terms_url, stipend_amount, stipend_currency, status, note, created_by_user_id)
      VALUES
        (${employeeId}::uuid, ${type}, ${start}::date, ${end}::date, ${renewalDue}::date,
         ${noticeDays}::int, ${termsUrl}::text, ${stipend}::numeric, ${currency}, 'active',
         ${note}::text, ${createdBy}::uuid)
      RETURNING id`));

    if (!ins.length) return { ok: false, error: 'The contract was not saved. Nothing was changed.' };
    const id = String(ins[0].id);

    await logAudit({
      userId: createdBy,
      action: 'contract.create',
      entity: 'hr_employment_contract',
      entityId: id,
      diff: { employeeId, contractType: type, startDate: start, endDate: end, stipendRecorded: stipend !== null },
    });

    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('createContract', e);
    return { ok: false, error: 'The contract was not saved: ' + reasonOf(e) };
  }
}

export interface ContractChangeInput {
  contractId: string;
  changeKind: ChangeKind;
  reason: string;
  proposedContractType?: string | null;
  proposedEndDate?: string | null;
  proposedRenewalDueDate?: string | null;
  proposedNoticeDays?: number | null;
  proposedTermsUrl?: string | null;
  proposedStipendAmount?: number | null;
  requestedByUserId?: string | null;
}

/**
 * Ask for a contract to be renewed or amended. WRITES A REQUEST, CHANGES NOTHING ELSE.
 *
 * The request row is created FIRST and the workflow second, so that a routing failure leaves a
 * visible request carrying the engine's halt sentence rather than nothing at all. That ordering is
 * the same reasoning startWorkflow() itself uses when it creates a halted instance: a request nobody
 * can see is a request that gets lost for a fortnight.
 */
export async function requestContractChange(input: ContractChangeInput): Promise<ContractResult> {
  const contractId = String(input?.contractId || '').trim();
  if (!isUuid(contractId)) return { ok: false, error: 'That contract could not be identified.' };

  const kind = String(input?.changeKind || '') as ChangeKind;
  if (kind !== 'renewal' && kind !== 'amendment') {
    return { ok: false, error: 'Choose whether this is a renewal or an amendment.' };
  }

  const reason = String(input?.reason || '').trim();
  if (reason.length < 5) {
    return { ok: false, error: 'Write the reason for this change — it goes on the record an approver reads.' };
  }

  const propType = input?.proposedContractType && String(input.proposedContractType).trim()
    ? String(input.proposedContractType).trim() : null;
  if (propType && !CONTRACT_TYPE_KEYS.has(propType)) {
    return { ok: false, error: 'That is not a contract type we record.' };
  }

  const propEnd = input?.proposedEndDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.proposedEndDate).trim())
    ? String(input.proposedEndDate).trim() : null;
  const propRenewal =
    input?.proposedRenewalDueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.proposedRenewalDueDate).trim())
      ? String(input.proposedRenewalDueDate).trim() : null;
  const propNotice =
    typeof input?.proposedNoticeDays === 'number' && isFinite(input.proposedNoticeDays) && input.proposedNoticeDays >= 0
      ? Math.min(Math.floor(input.proposedNoticeDays), 365) : null;
  const propTerms = input?.proposedTermsUrl && String(input.proposedTermsUrl).trim()
    ? String(input.proposedTermsUrl).trim() : null;
  if (propTerms && !isHttpsLink(propTerms)) {
    return { ok: false, error: 'The terms must be an https link to a shared document, not an uploaded file.' };
  }
  const propStipend =
    typeof input?.proposedStipendAmount === 'number' && isFinite(input.proposedStipendAmount) && input.proposedStipendAmount > 0
      ? input.proposedStipendAmount : null;

  if (kind === 'renewal' && !propEnd) {
    return { ok: false, error: 'A renewal needs the new end date it renews to.' };
  }
  if (kind === 'amendment' && !propType && !propEnd && !propRenewal && propNotice === null && !propTerms && propStipend === null) {
    return { ok: false, error: 'An amendment has to change something. Fill in at least one proposed term.' };
  }

  const requestedBy = isUuid(input?.requestedByUserId) ? String(input.requestedByUserId) : null;

  try {
    await ensureContractSchema();

    const cur = rows(await db.execute(sql`
      SELECT c.*, e.full_name AS employee_name
        FROM hr_employment_contracts c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.id = ${contractId}::uuid LIMIT 1`));
    if (!cur.length) return { ok: false, error: 'That contract could not be found.' };
    const contract = mapContract(cur[0]);
    if (contract.status !== 'active') {
      return { ok: false, error: 'That contract is no longer in force, so it cannot be changed. Record a new one instead.' };
    }

    const pendingAlready = rows(await db.execute(sql`
      SELECT id FROM hr_contract_changes
       WHERE contract_id = ${contractId}::uuid AND state IN ('pending', 'halted', 'approved')
       LIMIT 1`));
    if (pendingAlready.length) {
      return {
        ok: false,
        error: 'A change to this contract is already in progress. Settle that one before raising another.',
      };
    }

    const ins = rows(await db.execute(sql`
      INSERT INTO hr_contract_changes
        (contract_id, employee_id, change_kind, proposed_contract_type, proposed_end_date,
         proposed_renewal_due_date, proposed_notice_days, proposed_terms_url,
         proposed_stipend_amount, reason, state, requested_by_user_id)
      VALUES
        (${contractId}::uuid, ${contract.employeeId}::uuid, ${kind}, ${propType}::text,
         ${propEnd}::date, ${propRenewal}::date, ${propNotice}::int, ${propTerms}::text,
         ${propStipend}::numeric, ${reason}, 'pending', ${requestedBy}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: 'The request was not saved. Nothing was changed.' };
    const changeId = String(ins[0].id);

    // THE ONLY APPROVAL ENGINE. Routed from the organization graph, per row, per person.
    const wf = await startWorkflow({
      domain: 'contract',
      recordId: changeId,
      subjectEmployeeId: contract.employeeId,
      requestedByUserId: requestedBy,
      createdByUserId: requestedBy,
      summary:
        (kind === 'renewal' ? 'Contract renewal for ' : 'Contract amendment for ')
        + (contract.employeeName || 'an employee'),
    });

    if (!wf.ok) {
      // The engine refused outright. The request row stays, carrying the reason, so it is visible
      // and fixable rather than invisible and lost.
      await db.execute(sql`
        UPDATE hr_contract_changes
           SET state = 'halted', halt_reason = ${String(wf.error || 'The approval could not be started.')},
               updated_at = NOW()
         WHERE id = ${changeId}::uuid`);
      return { ok: false, id: changeId, error: wf.error || 'The approval could not be started.' };
    }

    const halted = wf.state === 'halted';
    await db.execute(sql`
      UPDATE hr_contract_changes
         SET workflow_instance_id = ${wf.instanceId}::uuid,
             state = ${halted ? 'halted' : 'pending'},
             halt_reason = ${wf.haltReason || null}::text,
             updated_at = NOW()
       WHERE id = ${changeId}::uuid`);

    await logAudit({
      userId: requestedBy,
      action: 'contract.change_requested',
      entity: 'hr_contract_change',
      entityId: changeId,
      diff: {
        contractId, employeeId: contract.employeeId, changeKind: kind,
        workflowInstanceId: wf.instanceId || null, state: halted ? 'halted' : 'pending',
        haltReason: wf.haltReason || null,
      },
    });

    return { ok: true, id: changeId, changed: true, haltReason: wf.haltReason || null };
  } catch (e: any) {
    logFail('requestContractChange', e);
    return { ok: false, error: 'The request was not saved: ' + reasonOf(e) };
  }
}

/** Withdraw a change request that has not been decided. The workflow instance is left to be
 *  cancelled by the workflow surface — this module never writes workflow tables. */
export async function cancelContractChange(
  changeId: string,
  actorUserId: string | null,
): Promise<ContractResult> {
  if (!isUuid(changeId)) return { ok: false, error: 'That request could not be identified.' };
  try {
    await ensureContractSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE hr_contract_changes
         SET state = 'cancelled', updated_at = NOW()
       WHERE id = ${changeId}::uuid AND state IN ('pending', 'halted')
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request has already been settled, so it cannot be withdrawn.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'contract.change_cancelled',
      entity: 'hr_contract_change',
      entityId: changeId,
      diff: {},
    });
    return { ok: true, id: changeId, changed: true };
  } catch (e: any) {
    logFail('cancelContractChange', e);
    return { ok: false, error: 'The request was not withdrawn: ' + reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// APPLYING AN APPROVED CHANGE — the reconcile, and the ONLY path that writes a new contract row.
// -------------------------------------------------------------------------------------------------

/**
 * Read every open change request's workflow state back and settle the ones the engine has decided.
 *
 * WHY A RECONCILE RATHER THAN A CALLBACK. The approval is decided on a workflow surface that knows
 * nothing about contracts, and wiring a completion callback into the engine would make the engine
 * import this module — a dependency in exactly the wrong direction, and a second place where a
 * contract can be written. Reading the state back is idempotent, has no ordering requirement, and
 * cannot lose a decision made while nobody was looking at this page.
 *
 * IT NEVER APPROVES ANYTHING. It only mirrors a decision the engine already made. A change whose
 * instance is still pending or halted is left exactly as it is.
 */
export async function syncContractChanges(actorUserId?: string | null): Promise<{
  applied: number;
  rejected: number;
  errors: string[];
}> {
  const out = { applied: 0, rejected: 0, errors: [] as string[] };
  try {
    await ensureContractSchema();
    const open = rows(await db.execute(sql`
      SELECT * FROM hr_contract_changes
       WHERE state IN ('pending', 'halted', 'approved')
         AND workflow_instance_id IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 100`));

    for (const raw of open) {
      const change = mapChange(raw);
      let instance: WorkflowInstanceView | null = null;
      try {
        instance = await getInstance(String(change.workflowInstanceId));
      } catch (e: any) {
        logFail('syncContractChanges.getInstance', e);
        out.errors.push('Could not read the approval for ' + (change.employeeName || 'an employee') + '.');
        continue;
      }
      if (!instance) continue;

      if (instance.state === 'approved' && change.state !== 'applied') {
        const r = await applyApprovedChange(change, actorUserId || null);
        if (r.ok) out.applied += 1;
        else out.errors.push(r.error || 'A change could not be applied.');
        continue;
      }

      if (instance.state === 'rejected' || instance.state === 'cancelled') {
        try {
          await db.execute(sql`
            UPDATE hr_contract_changes
               SET state = ${instance.state === 'rejected' ? 'rejected' : 'cancelled'}, updated_at = NOW()
             WHERE id = ${change.id}::uuid AND state IN ('pending', 'halted', 'approved')`);
          out.rejected += 1;
        } catch (e: any) {
          logFail('syncContractChanges.reject', e);
          out.errors.push('A decision could not be written down: ' + reasonOf(e));
        }
        continue;
      }

      // Still moving, or halted. Keep the halt sentence visible and current.
      if (instance.state === 'halted' && change.state !== 'halted') {
        try {
          await db.execute(sql`
            UPDATE hr_contract_changes
               SET state = 'halted', halt_reason = ${instance.haltReason}::text, updated_at = NOW()
             WHERE id = ${change.id}::uuid`);
        } catch (e: any) {
          logFail('syncContractChanges.halt', e);
        }
      }
    }
  } catch (e: any) {
    logFail('syncContractChanges', e);
    out.errors.push('The approvals could not be read: ' + reasonOf(e));
  }
  return out;
}

/**
 * Write the approved change as a NEW contract, superseding the old one. Append-only.
 *
 * ONE STATEMENT FOR THE PAIR, via a data-modifying CTE, for the same reason
 * supersedeReportingManager() uses one: two statements can half-succeed, and a superseded old
 * contract with no new one would leave a working person with no terms on record at all.
 */
async function applyApprovedChange(change: ChangeRow, actorUserId: string | null): Promise<ContractResult> {
  try {
    const cur = rows(await db.execute(sql`
      SELECT * FROM hr_employment_contracts WHERE id = ${change.contractId}::uuid LIMIT 1`));
    if (!cur.length) return { ok: false, error: 'The contract this change belongs to no longer exists.' };
    const old = mapContract(cur[0]);

    // The new terms: the proposal where one was made, the existing value where it was not. An
    // amendment that leaves a field blank means "unchanged", never "cleared".
    const newType = change.proposedContractType || old.contractType;
    const newEnd = change.proposedEndDate || old.endDate;
    const newRenewal = change.proposedRenewalDueDate || old.renewalDueDate;
    const newNotice = change.proposedNoticeDays !== null ? change.proposedNoticeDays : old.noticeDays;
    const newTerms = change.proposedTermsUrl || old.termsUrl;
    const newStipend = change.proposedStipendAmount !== null ? change.proposedStipendAmount : old.stipendAmount;

    // The new contract starts the day after the old one ended where that is known, and today
    // otherwise. Stated rather than guessed silently: an amendment mid-term starts today, a renewal
    // starts when the term it renews ran out.
    const startFrom = change.changeKind === 'renewal' && old.endDate ? old.endDate : null;

    const ins = rows(await db.execute(sql`
      WITH superseded AS (
        UPDATE hr_employment_contracts
           SET status = 'superseded', updated_at = NOW()
         WHERE id = ${change.contractId}::uuid
           AND status = 'active'
        RETURNING id
      )
      INSERT INTO hr_employment_contracts
        (employee_id, contract_type, start_date, end_date, renewal_due_date, notice_days,
         terms_url, stipend_amount, stipend_currency, status, supersedes_contract_id, note,
         created_by_user_id)
      SELECT ${change.employeeId}::uuid, ${newType},
             COALESCE(${startFrom}::date + 1, (NOW() AT TIME ZONE ${CONTRACT_TIME_ZONE})::date),
             ${newEnd}::date, ${newRenewal}::date, ${newNotice}::int, ${newTerms}::text,
             ${newStipend}::numeric, ${old.stipendCurrency}, 'active',
             ${change.contractId}::uuid,
             ${(change.changeKind === 'renewal' ? 'Renewal: ' : 'Amendment: ') + change.reason}::text,
             ${isUuid(actorUserId) ? String(actorUserId) : null}::uuid
        FROM superseded
      RETURNING id`));

    if (!ins.length) {
      // Zero rows means the old contract was no longer active when we got here — somebody settled it
      // in another tab. Say so rather than writing a second active contract.
      return {
        ok: false,
        error: 'That contract changed while this page was open, so nothing was applied. Reload and try again.',
      };
    }
    const newId = String(ins[0].id);

    await db.execute(sql`
      UPDATE hr_contract_changes
         SET state = 'applied', applied_contract_id = ${newId}::uuid, applied_at = NOW(), updated_at = NOW()
       WHERE id = ${change.id}::uuid`);

    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'contract.change_applied',
      entity: 'hr_employment_contract',
      entityId: newId,
      diff: {
        changeId: change.id, supersedesContractId: change.contractId, employeeId: change.employeeId,
        changeKind: change.changeKind, workflowInstanceId: change.workflowInstanceId,
        from: { contractType: old.contractType, endDate: old.endDate, noticeDays: old.noticeDays, stipendAmount: old.stipendAmount },
        to: { contractType: newType, endDate: newEnd, noticeDays: newNotice, stipendAmount: newStipend },
      },
    });

    return { ok: true, id: newId, changed: true };
  } catch (e: any) {
    logFail('applyApprovedChange', e);
    return { ok: false, error: 'The approved change could not be applied: ' + reasonOf(e) };
  }
}
