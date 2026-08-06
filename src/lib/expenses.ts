// src/lib/expenses.ts — REIMBURSEMENTS, TRAVEL CLAIMS AND ADVANCE REQUESTS.
//
// =================================================================================================
// THERE IS NO APPROVAL LOGIC IN THIS FILE, AND THERE MUST NEVER BE ANY
// =================================================================================================
//
// Every claim in here is approved by src/lib/workflow.ts and by nothing else. This module CREATES a
// claim, hands it to startWorkflow(), and afterwards READS BACK what the workflow decided. It does
// not resolve an approver, does not test a capability against a claim, does not compare a role name,
// and has no "if nobody is available, approve it" branch anywhere.
//
// That matters more here than almost anywhere else in the product, because an expense claim is money
// leaving the company. The failure mode a second approval path produces is not a confusing screen; it
// is a payment nobody signed off, that looks in the record exactly like a payment somebody did.
//
// SO WHEN ROUTING FAILS, THE CLAIM HALTS. workflow.ts writes the instance in state 'halted' with a
// sentence naming the missing relationship, and this module mirrors that onto the claim as status
// 'halted' plus that same sentence. The employee is shown it verbatim. Nothing is approved, nothing
// is paid, and no role name is consulted as a fallback — which is the whole point: until the founder
// runs db/org-graph-backfill.sql the organization graph is empty, so EVERY claim will halt with
// "no approver could be resolved: organization graph not yet initialized". That is the correct and
// visible behaviour, not a bug to work around.
//
// =================================================================================================
// WHAT IS REUSED RATHER THAN REBUILT
// =================================================================================================
//
//   src/lib/workflow.ts     the ONLY approval engine. Domains 'expenses' and 'travel' already exist
//                           in WORKFLOW_DOMAINS with their own chains and thresholds; none is added.
//   src/lib/org-graph.ts    reached only THROUGH workflow.ts. This file never queries
//                           org_relationships — two modules resolving one relationship is how the two
//                           start disagreeing about who somebody's manager is.
//   src/lib/hr-wallet.ts    THE wallet. An approved claim is credited with credit(), the existing
//                           export, idempotent on ref 'claim:<id>'. No second ledger, and hr-wallet.ts
//                           is not modified.
//   src/lib/audit.ts        logAudit(). No second audit log.
//   src/lib/push.ts         sendPushToUser() via workflow.ts's own notifier for approvals; this file
//                           notifies only the CLAIMANT when their own claim settles.
//
// =================================================================================================
// RECEIPTS ARE LINKS. THIS PLATFORM STORES NO DOCUMENT UPLOADS.
// =================================================================================================
//
// A receipt is a Google Drive link with "Anyone with the link" access, exactly as joining documents
// already work (src/pages/api/portal/onboarding/documents.ts and the standing rule behind it). The
// only file this product ever stores is a small profile photo. There is no upload field on the
// expenses form, there is no blob write in this module, and `receipt_url` holds a URL and nothing
// else.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. Never `r.rows[0]`.
//   - the real Postgres reason is on `e.cause`.
//   - every `const` above the function that reads it.
//   - self-bootstrapping DDL in an ensureOnce guard that RESETS on failure.
//   - no exception swallowed in a write path.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import {
  startWorkflow,
  cancelWorkflow,
  decideInstance,
  instanceForRecord,
  getInstance,
  pendingForApprover,
  domainLabel,
  type WorkflowDomain,
} from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one above the functions that read them.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[expenses] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const NOT_AVAILABLE = 'That claim is not available.';

/** The three shapes of money-back request, and the workflow domain each is routed through. */
export const CLAIM_KINDS = ['reimbursement', 'travel', 'advance'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  reimbursement: 'Expense claim',
  travel: 'Travel claim',
  advance: 'Advance request',
};

export const CLAIM_KIND_HINTS: Record<ClaimKind, string> = {
  reimbursement: 'Money you have already spent on the company\'s behalf and want back.',
  travel: 'Travel you have already taken — fares, stay, local transport.',
  advance: 'Money you need BEFORE you spend it. You will still submit a claim afterwards for what you actually spent.',
};

/**
 * WHICH APPROVAL CHAIN EACH KIND WALKS.
 *
 * Both keys are existing members of WORKFLOW_DOMAINS — no domain is added, and the chains are the
 * ones already declared in workflow.ts:
 *   expenses  manager -> approval owner (optional) -> executive sponsor above 100000
 *   travel    manager -> approval owner (optional) -> executive sponsor above 200000
 *
 * An ADVANCE goes down the `expenses` chain rather than `travel`, even for a trip: an advance is cash
 * out of the company before anything has been spent, and it is not travel-specific — a relocation
 * advance and a conference advance are the same act. Routing it as travel would apply the travel
 * threshold to money that has nothing to do with a journey.
 */
const DOMAIN_FOR_KIND: Record<ClaimKind, WorkflowDomain> = {
  reimbursement: 'expenses',
  travel: 'travel',
  advance: 'expenses',
};

/** Categories offered per kind. Free text is refused: a claims list nobody can group is a list. */
export const CLAIM_CATEGORIES: Record<ClaimKind, readonly { value: string; label: string }[]> = {
  reimbursement: [
    { value: 'equipment', label: 'Equipment and hardware' },
    { value: 'software', label: 'Software and subscriptions' },
    { value: 'internet', label: 'Internet and phone' },
    { value: 'training', label: 'Training and books' },
    { value: 'client', label: 'Client meeting and hospitality' },
    { value: 'office', label: 'Office supplies' },
    { value: 'medical', label: 'Medical' },
    { value: 'other', label: 'Something else' },
  ],
  travel: [
    { value: 'airfare', label: 'Air fare' },
    { value: 'rail', label: 'Rail or bus' },
    { value: 'local_transport', label: 'Local transport and cabs' },
    { value: 'accommodation', label: 'Accommodation' },
    { value: 'meals', label: 'Meals while travelling' },
    { value: 'visa', label: 'Visa and travel documents' },
    { value: 'other', label: 'Something else' },
  ],
  advance: [
    { value: 'travel_advance', label: 'Travel advance' },
    { value: 'project_advance', label: 'Project or purchase advance' },
    { value: 'relocation', label: 'Relocation' },
    { value: 'other', label: 'Something else' },
  ],
};

/**
 * THE CLAIM STATES, and each is a different sentence to the person who raised it.
 *
 *   draft       saved and not sent. Nobody has been asked for anything.
 *   submitted   live in the approval chain. Someone owes a decision.
 *   halted      ROUTING COULD NOT NAME AN APPROVER. Carries the workflow's own sentence.
 *   approved    every rung approved. The company owes the money.
 *   reimbursed  approved AND credited to the employee wallet.
 *   rejected    somebody refused it.
 *   cancelled   withdrawn by the claimant before it settled.
 */
export const CLAIM_STATES = [
  'draft', 'submitted', 'halted', 'approved', 'reimbursed', 'rejected', 'cancelled',
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CLAIM_STATE_LABELS: Record<ClaimState, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  halted: 'Cannot be routed yet',
  approved: 'Approved',
  reimbursed: 'Paid into your wallet',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};

/** States that are still moving. Only these are re-read from the workflow. */
const LIVE_STATES: readonly ClaimState[] = ['submitted', 'halted', 'approved'];

const MAX_AMOUNT = 100000000; // one hundred million, in whatever currency. A typo guard, not a policy.

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

let ready: Promise<void> | null = null;

export function ensureExpenseSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS expense_claims (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL,
        submitted_by_user_id UUID,
        kind TEXT NOT NULL DEFAULT 'reimbursement',
        category TEXT NOT NULL DEFAULT 'other',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        incurred_on DATE,
        travel_from TEXT NOT NULL DEFAULT '',
        travel_to TEXT NOT NULL DEFAULT '',
        travel_start DATE,
        travel_end DATE,
        needed_by DATE,
        receipt_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        workflow_instance_id UUID,
        halt_reason TEXT,
        decision_note TEXT,
        settled_at TIMESTAMPTZ,
        reimbursed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS expense_claims_emp
        ON expense_claims (employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS expense_claims_status
        ON expense_claims (status, created_at DESC)`);
    } catch (e: any) {
      logFail('ensureExpenseSchema', e);
      ready = null; // RESET — a transient failure must not mark the schema provisioned forever.
      throw e;
    }
  })();
  return ready;
}

async function safeEnsure(): Promise<boolean> {
  try {
    await ensureExpenseSchema();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface Claim {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  kind: ClaimKind;
  kindLabel: string;
  category: string;
  categoryLabel: string;
  title: string;
  description: string;
  amount: number;
  currency: string;
  incurredOn: string | null;
  travelFrom: string;
  travelTo: string;
  travelStart: string | null;
  travelEnd: string | null;
  neededBy: string | null;
  receiptUrl: string;
  status: ClaimState;
  statusLabel: string;
  workflowInstanceId: string | null;
  haltReason: string | null;
  decisionNote: string | null;
  createdAt: string | null;
  settledAt: string | null;
  reimbursedAt: string | null;
}

function categoryLabelFor(kind: ClaimKind, value: string): string {
  const found = (CLAIM_CATEGORIES[kind] || []).find((c) => c.value === value);
  return found ? found.label : 'Something else';
}

function mapClaim(r: any): Claim {
  const kind: ClaimKind = (CLAIM_KINDS as readonly string[]).indexOf(String(r?.kind)) >= 0
    ? (String(r.kind) as ClaimKind)
    : 'reimbursement';
  const status: ClaimState = (CLAIM_STATES as readonly string[]).indexOf(String(r?.status)) >= 0
    ? (String(r.status) as ClaimState)
    : 'draft';
  const day = (v: any): string | null => (v ? String(new Date(v).toISOString().slice(0, 10)) : null);
  return {
    id: String(r?.id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.full_name ? String(r.full_name) : null,
    employeeCode: r?.employee_code ? String(r.employee_code) : null,
    kind,
    kindLabel: CLAIM_KIND_LABELS[kind],
    category: String(r?.category ?? 'other'),
    categoryLabel: categoryLabelFor(kind, String(r?.category ?? 'other')),
    title: String(r?.title ?? ''),
    description: String(r?.description ?? ''),
    amount: Number(r?.amount) || 0,
    currency: String(r?.currency || 'INR'),
    incurredOn: day(r?.incurred_on),
    travelFrom: String(r?.travel_from ?? ''),
    travelTo: String(r?.travel_to ?? ''),
    travelStart: day(r?.travel_start),
    travelEnd: day(r?.travel_end),
    neededBy: day(r?.needed_by),
    receiptUrl: String(r?.receipt_url ?? ''),
    status,
    statusLabel: CLAIM_STATE_LABELS[status],
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    haltReason: r?.halt_reason ? String(r.halt_reason) : null,
    decisionNote: r?.decision_note ? String(r.decision_note) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    settledAt: r?.settled_at ? new Date(r.settled_at).toISOString() : null,
    reimbursedAt: r?.reimbursed_at ? new Date(r.reimbursed_at).toISOString() : null,
  };
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  claimId?: string;
  status?: ClaimState;
  /** Present exactly when the claim halted. Rendered verbatim — it names the missing relationship. */
  haltReason?: string | null;
}

// -------------------------------------------------------------------------------------------------
// VALIDATION — refusals are sentences a person can act on.
// -------------------------------------------------------------------------------------------------

/**
 * A receipt link, or a refusal explaining why the field is a link and not an upload.
 *
 * https only. A http:// link to a document store is a link that can be intercepted, and every
 * document surface in this product already requires https.
 */
function validateReceipt(raw: string, required: boolean): { ok: boolean; url: string; error?: string } {
  const url = String(raw || '').trim();
  if (!url) {
    if (!required) return { ok: true, url: '' };
    return {
      ok: false,
      url: '',
      error: 'Add a link to the receipt. This platform stores no document uploads — put the receipt in '
        + 'Google Drive, set it to "Anyone with the link", and paste the link here.',
    };
  }
  if (!/^https:\/\/\S+$/i.test(url) || url.length > 1000) {
    return { ok: false, url: '', error: 'That does not look like a link. Paste the full https:// address of the shared file.' };
  }
  return { ok: true, url };
}

function validAmount(raw: any): { ok: boolean; amount: number; error?: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, amount: 0, error: 'Enter the amount.' };
  if (n > MAX_AMOUNT) return { ok: false, amount: 0, error: 'That amount looks like a typo. Check it and try again.' };
  return { ok: true, amount: Math.round(n * 100) / 100 };
}

function validDate(raw: any): string | null {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : s;
}

// -------------------------------------------------------------------------------------------------
// SUBMIT — create the claim, then hand it to the workflow engine.
// -------------------------------------------------------------------------------------------------

export interface SubmitClaimInput {
  employeeId: string;
  userId: string;
  kind: string;
  category: string;
  title: string;
  description: string;
  amount: any;
  currency?: string;
  incurredOn?: string;
  travelFrom?: string;
  travelTo?: string;
  travelStart?: string;
  travelEnd?: string;
  neededBy?: string;
  receiptUrl?: string;
}

/**
 * Raise a claim and send it for approval, in one act.
 *
 * THERE IS NO SEPARATE "SUBMIT" BUTTON, and that is deliberate rather than a shortcut: a draft that a
 * person believes they filed is the failure this whole module is meant to avoid. The claim is created
 * and routed in the same request, so its state after this call is always one a person can read —
 * 'submitted' or 'halted' — and never 'saved somewhere, waiting for you to do a second thing'.
 *
 * THE WORKFLOW DECIDES THE STATE. If startWorkflow halts, the claim is halted with the workflow's own
 * sentence. This function contains no branch that approves anything.
 */
export async function submitClaim(input: SubmitClaimInput): Promise<ClaimResult> {
  const employeeId = String(input?.employeeId || '').trim();
  const userId = String(input?.userId || '').trim();
  if (!isUuid(employeeId)) {
    return { ok: false, error: 'Your account is not linked to an employee record, so there is nobody to route a claim from. Ask HR to link it.' };
  }
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to raise a claim.' };

  const kind: ClaimKind = (CLAIM_KINDS as readonly string[]).indexOf(String(input?.kind)) >= 0
    ? (String(input.kind) as ClaimKind)
    : 'reimbursement';

  const allowedCategories = (CLAIM_CATEGORIES[kind] || []).map((c) => c.value);
  const category = allowedCategories.indexOf(String(input?.category)) >= 0 ? String(input.category) : 'other';

  const title = String(input?.title || '').trim().slice(0, 160);
  if (!title) return { ok: false, error: 'Give the claim a short title, so an approver can see what it is without opening it.' };

  const description = String(input?.description || '').trim().slice(0, 4000);
  if (!description) return { ok: false, error: 'Describe what this is for. An approver deciding on a title alone is an approver guessing.' };

  const amt = validAmount(input?.amount);
  if (!amt.ok) return { ok: false, error: amt.error };

  const currency = String(input?.currency || 'INR').trim().toUpperCase().slice(0, 8) || 'INR';

  // A receipt is REQUIRED for money already spent and impossible for money not yet spent.
  const receipt = validateReceipt(String(input?.receiptUrl || ''), kind !== 'advance');
  if (!receipt.ok) return { ok: false, error: receipt.error };

  const incurredOn = validDate(input?.incurredOn);
  if (kind !== 'advance' && !incurredOn) {
    return { ok: false, error: 'Enter the date you spent the money.' };
  }
  const neededBy = validDate(input?.neededBy);
  if (kind === 'advance' && !neededBy) {
    return { ok: false, error: 'Enter the date you need the advance by.' };
  }

  const travelFrom = String(input?.travelFrom || '').trim().slice(0, 120);
  const travelTo = String(input?.travelTo || '').trim().slice(0, 120);
  const travelStart = validDate(input?.travelStart);
  const travelEnd = validDate(input?.travelEnd);
  if (kind === 'travel' && (!travelFrom || !travelTo)) {
    return { ok: false, error: 'Enter where the journey started and where it went.' };
  }
  if (kind === 'travel' && travelStart && travelEnd && travelEnd < travelStart) {
    return { ok: false, error: 'The return date is before the departure date.' };
  }

  let claimId = '';
  try {
    await ensureExpenseSchema();
    const ins = rows(await db.execute(sql`
      INSERT INTO expense_claims
        (employee_id, submitted_by_user_id, kind, category, title, description, amount, currency,
         incurred_on, travel_from, travel_to, travel_start, travel_end, needed_by, receipt_url, status)
      VALUES
        (${employeeId}::uuid, ${userId}::uuid, ${kind}, ${category}, ${title}, ${description},
         ${amt.amount}, ${currency}, ${incurredOn}::date, ${travelFrom}, ${travelTo},
         ${travelStart}::date, ${travelEnd}::date, ${neededBy}::date, ${receipt.url}, 'draft')
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    claimId = String(ins[0].id);
  } catch (e: any) {
    // NOT SWALLOWED. Cause to the log, sentence to the person, ok:false to the caller.
    logFail('submitClaim.insert', e);
    return { ok: false, error: WRITE_FAILED };
  }

  // ---- THE ONLY APPROVAL PATH ---------------------------------------------------------------------
  const domain = DOMAIN_FOR_KIND[kind];
  const summary = CLAIM_KIND_LABELS[kind] + ': ' + title;
  const wf = await startWorkflow({
    domain,
    recordId: claimId,
    subjectEmployeeId: employeeId,
    requestedByUserId: userId,
    createdByUserId: userId,
    summary,
    amount: amt.amount,
    currency,
  });

  if (!wf.ok) {
    // The claim exists but could not be routed at all. Leave it visible and honest rather than
    // deleting it — a claim that vanished is a claim the person raises again tomorrow.
    try {
      await db.execute(sql`
        UPDATE expense_claims
           SET status = 'halted', halt_reason = ${wf.error || 'This claim could not be sent for approval.'},
               updated_at = NOW()
         WHERE id = ${claimId}::uuid`);
    } catch (e: any) {
      logFail('submitClaim.haltWrite', e);
    }
    return { ok: true, claimId, status: 'halted', haltReason: wf.error || null };
  }

  const status: ClaimState = wf.state === 'halted' ? 'halted' : 'submitted';
  try {
    await db.execute(sql`
      UPDATE expense_claims
         SET status = ${status}, workflow_instance_id = ${wf.instanceId || null}::uuid,
             halt_reason = ${wf.haltReason || null}, updated_at = NOW()
       WHERE id = ${claimId}::uuid`);
  } catch (e: any) {
    logFail('submitClaim.linkWorkflow', e);
    return { ok: false, error: 'The claim was raised but we could not link it to its approval. Open your claims list and check before raising it again.' };
  }

  await logAudit({
    userId,
    action: 'expenses.claim.submitted',
    entity: 'expense_claim',
    entityId: claimId,
    diff: {
      kind, category, amount: amt.amount, currency, domain,
      workflowInstanceId: wf.instanceId || null, state: status, haltReason: wf.haltReason || null,
    },
  });

  return { ok: true, claimId, status, haltReason: wf.haltReason || null };
}

// -------------------------------------------------------------------------------------------------
// SYNC — read back what the workflow decided. THE DECISION IS NEVER MADE HERE.
// -------------------------------------------------------------------------------------------------

/**
 * Mirror one claim's workflow state onto the claim row.
 *
 * WHY MIRRORING RATHER THAN A SETTLEMENT HOOK INSIDE workflow.ts: settleDomainRecord() there handles
 * `leave` and only leave, and it is not this module's file to extend. Mirroring keeps the direction of
 * dependency correct — expenses reads workflow, workflow knows nothing about expenses — and it keeps
 * the workflow instance as the single source of truth for the DECISION. The claim row holds the
 * post-decision lifecycle (approved -> reimbursed) and nothing else.
 *
 * IT CANNOT INVENT AN APPROVAL. The only states written here are the ones read off the instance. A
 * claim whose instance is missing is left exactly as it is; a claim whose instance is still pending is
 * left exactly as it is.
 *
 * CREDITING IS IDEMPOTENT AND IS NOT A SECOND DECISION. Once the workflow says approved, the company
 * owes the money, and it is credited to the employee's wallet with ref 'claim:<id>' — the same
 * mechanism creditPayrollRun() uses for salary, so re-running this cannot pay anybody twice. Releasing
 * that balance to a bank still requires `payouts.pay` through the existing withdrawal path; crediting
 * a wallet is not paying anybody.
 */
export async function syncClaim(claimId: string): Promise<Claim | null> {
  if (!isUuid(claimId)) return null;
  if (!(await safeEnsure())) return null;

  let claim: Claim | null = null;
  try {
    const r = rows(await db.execute(sql`
      SELECT c.*, e.full_name, e.employee_code
        FROM expense_claims c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.id = ${claimId}::uuid LIMIT 1`));
    if (!r.length) return null;
    claim = mapClaim(r[0]);
  } catch (e: any) {
    logFail('syncClaim.read', e);
    return null;
  }

  if (LIVE_STATES.indexOf(claim.status) < 0) return claim;

  const domain = DOMAIN_FOR_KIND[claim.kind];
  let instance = null as Awaited<ReturnType<typeof getInstance>>;
  try {
    instance = claim.workflowInstanceId
      ? await getInstance(claim.workflowInstanceId)
      : null;
    if (!instance) {
      const byRecord = await instanceForRecord(domain, claimId);
      instance = byRecord ? await getInstance(byRecord.id) : null;
    }
  } catch (e: any) {
    logFail('syncClaim.instance', e);
    return claim;
  }
  if (!instance) return claim;

  const state = String(instance.state);

  // approved -> credit -> reimbursed. Done first because a claim already marked 'approved' by an
  // earlier sync still owes its credit.
  if (state === 'approved') {
    if (claim.status !== 'reimbursed') {
      const credited = await creditApprovedClaim(claim);
      const next: ClaimState = credited ? 'reimbursed' : 'approved';
      const changed = await writeClaimState(claim, next, {
        haltReason: null,
        settled: true,
        reimbursed: credited,
        instanceId: instance.id,
      });
      if (changed) claim = changed;
    }
    return claim;
  }

  if (state === 'rejected' || state === 'cancelled') {
    const next: ClaimState = state === 'rejected' ? 'rejected' : 'cancelled';
    const changed = await writeClaimState(claim, next, {
      haltReason: null, settled: true, reimbursed: false, instanceId: instance.id,
    });
    return changed || claim;
  }

  if (state === 'halted' && claim.status !== 'halted') {
    const changed = await writeClaimState(claim, 'halted', {
      haltReason: instance.haltReason, settled: false, reimbursed: false, instanceId: instance.id,
    });
    return changed || claim;
  }

  if (state === 'pending' && claim.status !== 'submitted') {
    const changed = await writeClaimState(claim, 'submitted', {
      haltReason: null, settled: false, reimbursed: false, instanceId: instance.id,
    });
    return changed || claim;
  }

  return claim;
}

/** The state write. Re-states the precondition it was validated against, so a concurrent change loses. */
async function writeClaimState(
  claim: Claim,
  next: ClaimState,
  opts: { haltReason: string | null; settled: boolean; reimbursed: boolean; instanceId: string | null },
): Promise<Claim | null> {
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE expense_claims
         SET status = ${next},
             halt_reason = ${opts.haltReason},
             workflow_instance_id = COALESCE(${opts.instanceId}::uuid, workflow_instance_id),
             settled_at = ${opts.settled ? sql`COALESCE(settled_at, NOW())` : sql`settled_at`},
             reimbursed_at = ${opts.reimbursed ? sql`COALESCE(reimbursed_at, NOW())` : sql`reimbursed_at`},
             updated_at = NOW()
       WHERE id = ${claim.id}::uuid
         AND status = ${claim.status}
      RETURNING *`));
    if (!wrote.length) return null;

    if (next !== claim.status) {
      await logAudit({
        userId: null,
        action: 'expenses.claim.' + next,
        entity: 'expense_claim',
        entityId: claim.id,
        diff: { from: claim.status, to: next, amount: claim.amount, currency: claim.currency },
      });
      await notifyClaimant(claim, next);
    }
    return mapClaim({ ...wrote[0], full_name: claim.employeeName, employee_code: claim.employeeCode });
  } catch (e: any) {
    logFail('writeClaimState', e);
    return null;
  }
}

/**
 * Credit an approved claim to the employee wallet. Returns whether the money is now in the ledger.
 *
 * hr-wallet.ts credit() is used unchanged and is not modified — it is the wallet, and this is what
 * `kind = 'reimbursement'` in its own comment has always meant. The ref makes it idempotent: a second
 * call for the same claim writes a second row only if the first never landed, which is checked here
 * before writing rather than left to a unique index that does not exist on that table.
 */
async function creditApprovedClaim(claim: Claim): Promise<boolean> {
  const ref = 'claim:' + claim.id;
  try {
    const dupe = rows(await db.execute(sql`
      SELECT id FROM hr_wallet_txn WHERE ref = ${ref} LIMIT 1`));
    if (dupe.length) return true;
  } catch (e: any) {
    // The wallet schema may not be provisioned on this database yet. credit() provisions it, so this
    // is not fatal — but it must not be read as "already credited".
    logFail('creditApprovedClaim.check', e);
  }

  try {
    const { credit } = await import('@/lib/hr-wallet');
    await credit(
      claim.employeeId,
      claim.amount,
      'reimbursement',
      CLAIM_KIND_LABELS[claim.kind] + ': ' + claim.title,
      // created_by is a USERS id. No human causes this write — an approved chain does — so it is
      // null rather than the workflow instance id, which would put a workflow uuid in a users column
      // and read as a person who does not exist.
      null,
      ref,
    );
    await logAudit({
      userId: null, action: 'expenses.claim.credited', entity: 'expense_claim', entityId: claim.id,
      diff: { employeeId: claim.employeeId, amount: claim.amount, currency: claim.currency, ref },
    });
    return true;
  } catch (e: any) {
    // NOT SWALLOWED — the claim stays 'approved' rather than being marked paid, and the cause is
    // logged. Marking it reimbursed when the ledger write failed would tell somebody they have been
    // paid money they cannot see.
    logFail('creditApprovedClaim.credit', e);
    return false;
  }
}

/** Tell the claimant their own claim settled. The existing notifier; never blocks the state change. */
async function notifyClaimant(claim: Claim, next: ClaimState): Promise<void> {
  try {
    const who = rows(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${claim.employeeId}::uuid LIMIT 1`))[0];
    const userId = who?.user_id ? String(who.user_id) : '';
    if (!userId) return;
    const { sendPushToUser } = await import('@/lib/push');
    await sendPushToUser(userId, {
      type: 'expense_claim',
      title: CLAIM_KIND_LABELS[claim.kind] + ' ' + CLAIM_STATE_LABELS[next].toLowerCase(),
      body: claim.title,
      url: '/portal/employee/expenses',
      tag: 'claim-' + claim.id,
    });
  } catch (e: any) {
    logFail('notifyClaimant', e);
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

/**
 * One person's claims, newest first, each re-read from its workflow first.
 *
 * SYNCING ON READ IS THE ONLY WAY THIS STAYS TRUE. There is no cron on this project and no settlement
 * hook for expenses inside workflow.ts, so a claim approved on the approvals queue would otherwise
 * read 'waiting for approval' on the claimant's own screen until somebody happened to touch it. The
 * cost is bounded: only claims in a LIVE state are re-read, and only this employee's.
 */
export async function claimsForEmployee(employeeId: string, limit = 50): Promise<Claim[]> {
  if (!isUuid(employeeId)) return [];
  if (!(await safeEnsure())) return [];
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const r = await db.execute(sql`
      SELECT c.*, e.full_name, e.employee_code
        FROM expense_claims c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.employee_id = ${employeeId}::uuid
       ORDER BY c.created_at DESC
       LIMIT ${lim}`);
    const list = rows(r).map(mapClaim);
    const out: Claim[] = [];
    for (const c of list) {
      out.push(LIVE_STATES.indexOf(c.status) >= 0 ? ((await syncClaim(c.id)) || c) : c);
    }
    return out;
  } catch (e: any) {
    logFail('claimsForEmployee', e);
    return [];
  }
}

/** Every claim in the company, for the review console. Read-only: it decides nothing. */
export async function allClaims(
  opts: { status?: string; kind?: string; limit?: number } = {},
): Promise<Claim[]> {
  if (!(await safeEnsure())) return [];
  const lim = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  try {
    const statusFilter = opts.status && (CLAIM_STATES as readonly string[]).indexOf(opts.status) >= 0
      ? sql`AND c.status = ${opts.status}` : sql``;
    const kindFilter = opts.kind && (CLAIM_KINDS as readonly string[]).indexOf(opts.kind) >= 0
      ? sql`AND c.kind = ${opts.kind}` : sql``;
    const r = await db.execute(sql`
      SELECT c.*, e.full_name, e.employee_code
        FROM expense_claims c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE TRUE ${statusFilter} ${kindFilter}
       ORDER BY (c.status IN ('submitted','halted')) DESC, c.created_at DESC
       LIMIT ${lim}`);
    const list = rows(r).map(mapClaim);
    const out: Claim[] = [];
    for (const c of list) {
      out.push(LIVE_STATES.indexOf(c.status) >= 0 ? ((await syncClaim(c.id)) || c) : c);
    }
    return out;
  } catch (e: any) {
    logFail('allClaims', e);
    return [];
  }
}

/** Counts by state, for a console header that must not lie about an empty queue. */
export async function claimCounts(): Promise<Record<string, number>> {
  if (!(await safeEnsure())) return {};
  try {
    const r = await db.execute(sql`SELECT status, COUNT(*)::int AS n FROM expense_claims GROUP BY status`);
    const out: Record<string, number> = {};
    for (const x of rows(r)) out[String(x.status)] = Number(x.n) || 0;
    return out;
  } catch (e: any) {
    logFail('claimCounts', e);
    return {};
  }
}

/** The approval chain of one claim, in words, for a screen that shows who it is waiting on. */
export interface ClaimApprovalStep {
  stepNo: number;
  via: string | null;
  approverName: string | null;
  decision: string;
  decidedAt: string | null;
  note: string | null;
}

export async function claimApprovalTrail(claim: Claim): Promise<{
  domainLabel: string;
  state: string;
  haltReason: string | null;
  steps: ClaimApprovalStep[];
}> {
  const domain = DOMAIN_FOR_KIND[claim.kind];
  const label = domainLabel(domain);
  try {
    const instance = claim.workflowInstanceId
      ? await getInstance(claim.workflowInstanceId)
      : null;
    if (!instance) return { domainLabel: label, state: claim.status, haltReason: claim.haltReason, steps: [] };
    return {
      domainLabel: label,
      state: instance.state,
      haltReason: instance.haltReason,
      steps: instance.steps.map((s) => ({
        stepNo: s.stepNo,
        via: s.via,
        approverName: s.approverName,
        decision: s.decision,
        decidedAt: s.decidedAt,
        note: s.note,
      })),
    };
  } catch (e: any) {
    logFail('claimApprovalTrail', e);
    return { domainLabel: label, state: claim.status, haltReason: claim.haltReason, steps: [] };
  }
}

// -------------------------------------------------------------------------------------------------
// THE APPROVER'S SIDE — what is waiting on ONE person, and recording their decision.
// -------------------------------------------------------------------------------------------------
//
// WHY THIS IS HERE AND NOT ON AN ADMIN CONSOLE. The approver of a claim is whoever the Organization
// Graph routes it to — most often an ordinary employee who is somebody's reporting manager and who
// holds no admin capability at all and cannot open /admin. Putting the decision behind an admin gate
// would mean the person the request was routed TO could not act on it, and somebody who was never
// routed anything could. That is the exact inversion per-row routing exists to prevent.

export interface PendingDecision {
  instanceId: string;
  stepId: string;
  stepNo: number;
  via: string | null;
  domain: string;
  domainLabel: string;
  summary: string | null;
  amount: number | null;
  currency: string | null;
  subjectName: string | null;
  createdAt: string | null;
  /** The claim, when this instance is a claim. Null when it is a wallet withdrawal. */
  claim: Claim | null;
  /** The hr_withdrawal id, when this instance is a withdrawal. Null when it is a claim. */
  withdrawalId: string | null;
}

/**
 * EXPENSE, TRAVEL AND ADVANCE APPROVALS WAITING ON THIS PERSON.
 *
 * pendingForApprover() is the authority and this only narrows it: it returns rows ROUTED to this
 * user or DELEGATED to them, at the instance's current step, and deliberately does NOT return every
 * pending instance to a capability holder. A standing capability means you MAY act on something that
 * reaches you, not that every request in the company is on your list.
 *
 * Fails closed to an empty list — an approver seeing nothing is a missed notification, an approver
 * seeing everyone's claims is a leak.
 */
export async function decisionsAwaiting(userId: string): Promise<PendingDecision[]> {
  const uid = String(userId || '').trim();
  if (!isUuid(uid)) return [];
  let queue: Awaited<ReturnType<typeof pendingForApprover>> = [];
  try {
    queue = await pendingForApprover(uid);
  } catch (e: any) {
    logFail('decisionsAwaiting', e);
    return [];
  }

  const out: PendingDecision[] = [];
  for (const row of queue) {
    const domain = String(row.instance.domain);
    if (domain !== 'expenses' && domain !== 'travel') continue;

    const recordId = String(row.instance.recordId || '');
    let claim: Claim | null = null;
    let withdrawalId: string | null = null;

    if (recordId.startsWith('withdrawal:')) {
      withdrawalId = recordId.slice('withdrawal:'.length) || null;
    } else if (isUuid(recordId)) {
      try {
        const r = rows(await db.execute(sql`
          SELECT c.*, e.full_name, e.employee_code
            FROM expense_claims c
            LEFT JOIN hr_employees e ON e.id = c.employee_id
           WHERE c.id = ${recordId}::uuid LIMIT 1`));
        claim = r.length ? mapClaim(r[0]) : null;
      } catch (e: any) {
        logFail('decisionsAwaiting.claim', e);
      }
    }

    // An instance whose record cannot be read is NOT offered for decision. Approving something the
    // screen cannot describe is approving a number.
    if (!claim && !withdrawalId) continue;

    out.push({
      instanceId: row.instance.id,
      stepId: row.step.id,
      stepNo: row.step.stepNo,
      via: row.step.via,
      domain,
      domainLabel: domainLabel(domain),
      summary: row.instance.summary,
      amount: row.instance.amount,
      currency: row.instance.currency,
      subjectName: row.instance.subjectName,
      createdAt: row.instance.createdAt,
      claim,
      withdrawalId,
    });
  }
  return out;
}

/**
 * Record one decision.
 *
 * THE DECISION IS MADE BY decideInstance(), which re-checks mayAct() against the POSTED instance id —
 * so an id typed in by hand is refused by the engine, not by the absence of a button on a page. This
 * function adds nothing to that check and subtracts nothing from it; it only mirrors the result back
 * onto the claim afterwards so the claimant's own screen agrees with the queue.
 */
export async function decideClaim(
  instanceId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  decision: 'approved' | 'rejected',
  note: string = '',
): Promise<{ ok: boolean; error?: string }> {
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: 'That is not a decision we record.' };
  }
  const res = await decideInstance(instanceId, user, decision, note);
  if (!res.ok) return { ok: false, error: res.error || NOT_AVAILABLE };

  // Mirror onto whichever record this instance belongs to. Failure here does NOT undo the decision —
  // the workflow instance is the source of truth and the next read reconciles — but it is logged.
  try {
    const instance = await getInstance(instanceId);
    const recordId = String(instance?.recordId || '');
    if (recordId.startsWith('withdrawal:')) {
      await routeWithdrawals(instance?.subjectEmployeeId || null);
    } else if (isUuid(recordId)) {
      await syncClaim(recordId);
    }
  } catch (e: any) {
    logFail('decideClaim.mirror', e);
  }
  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// WITHDRAW A CLAIM — the claimant's own, and only before it settles.
// -------------------------------------------------------------------------------------------------

/**
 * Withdraw a claim. Routed through workflow.cancelWorkflow(), which enforces that only the person who
 * RAISED it (or a holder of the domain's standing capability, of which the expense and travel domains
 * deliberately have none) may cancel — so this function adds an ownership check of its own and then
 * lets the engine make the decision.
 */
export async function withdrawClaim(
  claimId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string,
  reason: string = '',
): Promise<ClaimResult> {
  if (!isUuid(claimId)) return { ok: false, error: NOT_AVAILABLE };
  const userId = String(user?.id || '').trim();
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to withdraw a claim.' };

  try {
    await ensureExpenseSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM expense_claims WHERE id = ${claimId}::uuid LIMIT 1`));
    if (!r.length) return { ok: false, error: NOT_AVAILABLE };
    const claim = mapClaim(r[0]);

    // OWNERSHIP FIRST, and the same refusal for "not yours" as for "does not exist", so a claim id
    // cannot be probed to discover whether it exists.
    if (!isUuid(employeeId) || claim.employeeId !== employeeId) {
      return { ok: false, error: NOT_AVAILABLE };
    }
    if (claim.status !== 'submitted' && claim.status !== 'halted') {
      return { ok: false, error: 'This claim is already ' + CLAIM_STATE_LABELS[claim.status].toLowerCase() + '.' };
    }

    if (claim.workflowInstanceId) {
      const res = await cancelWorkflow(claim.workflowInstanceId, user, reason);
      if (!res.ok) return { ok: false, error: res.error || NOT_AVAILABLE };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE expense_claims
         SET status = 'cancelled', settled_at = NOW(), updated_at = NOW(),
             decision_note = ${String(reason || '').trim().slice(0, 500) || null}
       WHERE id = ${claimId}::uuid AND status = ${claim.status}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That claim changed while this page was open. Reload it and try again.' };
    }

    await logAudit({
      userId, action: 'expenses.claim.cancelled', entity: 'expense_claim', entityId: claimId,
      diff: { from: claim.status, amount: claim.amount, currency: claim.currency, reason: reason || null },
    });
    return { ok: true, claimId, status: 'cancelled' };
  } catch (e: any) {
    logFail('withdrawClaim', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// WITHDRAWALS — routing the EXISTING wallet withdrawal request through the SAME engine.
// -------------------------------------------------------------------------------------------------
//
// hr_withdrawal predates the workflow engine. src/lib/hr-wallet.ts requestWithdrawal() writes a row
// with status 'pending', and /admin/hr/wallet decides it directly through approverRole(). That path
// still exists and is NOT modified here — hr-wallet.ts is not this module's file to change, and
// silently disabling a live money path would be worse than the duplication.
//
// WHAT THIS ADDS is the routed path the phase asks for: every pending withdrawal is given a workflow
// instance (domain 'expenses', record id 'withdrawal:<id>'), so it walks the same org-graph chain a
// claim does, and when that chain settles the answer is mirrored back onto hr_withdrawal.
//
// THE TWO PATHS CANNOT CLOBBER EACH OTHER. The mirror writes `WHERE status = 'pending'` only, so a
// withdrawal already decided on /admin/hr/wallet is left exactly as the person who decided it left it,
// and a withdrawal decided through the workflow is already out of 'pending' when the other page loads.
// `decided_by_role` is written as 'workflow' — no role decided it, a chain did, and the chain is on the
// step rows. This overlap is reported as an honest follow-up rather than hidden.

/** The workflow record id for a withdrawal. Prefixed so it can never collide with a claim's uuid. */
const withdrawalRecordId = (id: string): string => 'withdrawal:' + id;

export interface RoutedWithdrawal {
  id: string;
  amount: number;
  currency: string;
  status: string;
  note: string | null;
  requestedAt: string | null;
  employeeName: string | null;
  /** The workflow's own state, or null when the request has no instance (schema not provisioned). */
  workflowState: string | null;
  haltReason: string | null;
}

/**
 * Give every still-pending withdrawal an approval chain, and mirror any that have settled.
 *
 * IDEMPOTENT: startWorkflow() is unique on (domain, record_id), so calling this on every page load
 * creates one instance per withdrawal however many times it runs.
 *
 * `employeeId` narrows it to one person's own withdrawals — that is what the portal passes. The
 * review console passes nothing and gets every pending one.
 */
export async function routeWithdrawals(employeeId?: string | null): Promise<RoutedWithdrawal[]> {
  const scoped = isUuid(employeeId) ? String(employeeId) : null;
  let list: any[] = [];
  try {
    const scopeFilter = scoped ? sql`AND w.employee_id = ${scoped}::uuid` : sql``;
    list = rows(await db.execute(sql`
      SELECT w.id, w.employee_id, w.amount, w.currency, w.status, w.note, w.requested_at,
             e.full_name
        FROM hr_withdrawal w
        LEFT JOIN hr_employees e ON e.id = w.employee_id
       WHERE w.status IN ('pending','approved','paying','rejected','paid','failed') ${scopeFilter}
       ORDER BY (w.status = 'pending') DESC, w.requested_at DESC
       LIMIT 100`));
  } catch (e: any) {
    // The wallet schema is provisioned by hr-wallet.ensureWalletSchema(); on a database where no
    // wallet page has been opened the table does not exist yet. An empty list is the honest answer.
    logFail('routeWithdrawals.read', e);
    return [];
  }

  const out: RoutedWithdrawal[] = [];
  for (const w of list) {
    const id = String(w.id);
    const recordId = withdrawalRecordId(id);
    let workflowState: string | null = null;
    let haltReason: string | null = null;
    let status = String(w.status || 'pending');

    try {
      let instance = await instanceForRecord('expenses', recordId);

      if (!instance && status === 'pending' && isUuid(String(w.employee_id))) {
        const started = await startWorkflow({
          domain: 'expenses',
          recordId,
          subjectEmployeeId: String(w.employee_id),
          summary: 'Wallet withdrawal of ' + String(w.currency || 'INR') + ' ' + Number(w.amount || 0).toFixed(2),
          amount: Number(w.amount) || 0,
          currency: String(w.currency || 'INR'),
        });
        if (started.ok && started.instanceId) instance = await instanceForRecord('expenses', recordId);
      }

      if (instance) {
        workflowState = instance.state;
        haltReason = instance.haltReason;

        if (status === 'pending' && (instance.state === 'approved' || instance.state === 'rejected')) {
          const decision = instance.state === 'approved' ? 'approved' : 'rejected';
          const wrote = rows(await db.execute(sql`
            UPDATE hr_withdrawal
               SET status = ${decision}, decided_by_role = 'workflow', decided_at = NOW(),
                   decision_note = ${'Decided through the approval workflow (' + instance.id + ')'}
             WHERE id = ${id}::uuid AND status = 'pending'
            RETURNING id`));
          if (wrote.length) {
            status = decision;
            await logAudit({
              userId: null, action: 'expenses.withdrawal.' + decision, entity: 'hr_withdrawal',
              entityId: id,
              diff: { amount: Number(w.amount) || 0, currency: String(w.currency || 'INR'), workflowInstanceId: instance.id },
            });
          }
        }
      }
    } catch (e: any) {
      logFail('routeWithdrawals ' + id, e);
    }

    out.push({
      id,
      amount: Number(w.amount) || 0,
      currency: String(w.currency || 'INR'),
      status,
      note: w.note ? String(w.note) : null,
      requestedAt: w.requested_at ? new Date(w.requested_at).toISOString() : null,
      employeeName: w.full_name ? String(w.full_name) : null,
      workflowState,
      haltReason,
    });
  }
  return out;
}
