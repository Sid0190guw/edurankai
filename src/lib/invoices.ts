// src/lib/invoices.ts — INVOICES, IN BOTH DIRECTIONS.
//
// =================================================================================================
// TWO DIRECTIONS, AND THEY ARE NOT THE SAME THING
// =================================================================================================
//
//   RECEIVABLE   WE BILL SOMEBODY. A client or a partner, priced line by line, with tax lines built
//                from CONFIGURED components, sent on a date, due on a date, and paid — possibly in
//                instalments. We issue the document, so we own its number and we print it.
//
//   PAYABLE      SOMEBODY BILLS US. A vendor sends their own document with their own number; ours is
//                only an internal reference. It LINKS to the procurement purchase request and vendor
//                that caused it, so an approved purchase becomes a payable rather than a second
//                unrelated record — and PAYING IT IS AN APPROVAL, routed through src/lib/workflow.ts
//                from the Organization Graph, never decided here.
//
// They share storage — one numbering mechanism, one line table, one payment table, one ledger — and
// they DO NOT share behaviour. Two state vocabularies, two transition maps, two creation functions,
// two consoles. A single generic "invoice" would have had to pretend that "send it to the client" and
// "get permission to pay it" are the same act, and the code that pretends that is the code that lets
// somebody pay a bill nobody approved.
//
// =================================================================================================
// WHAT THIS FILE IS NOT
// =================================================================================================
//
// IT IS NOT AN APPROVAL ENGINE. There is no approve() here, no approver column, no threshold and no
// comparison against a role name. Paying a payable requires an APPROVED workflow instance, read from
// src/lib/workflow.ts at the moment of the write. When the graph cannot name an approver the engine
// HALTS the request and nothing is paid — this file never falls back to anything.
//
// IT IS NOT A SECOND LEDGER. src/lib/hr-wallet.ts is the employee ledger and hr_wallet_txn is its
// only table. When a payable is settled INTO AN EMPLOYEE'S WALLET, this module calls that module's
// credit() with an idempotent ref and writes nothing of its own. Money paid to a client or a vendor
// bank account is not an employee's money and is not written into an employee ledger at all — the
// payment row is the record of it.
//
// IT MAKES NO COMPLIANCE CLAIM. Tax lines are components an administrator CONFIGURES — a code, a
// label, and either a percentage of the subtotal or a fixed amount — exactly as src/lib/payroll.ts
// models salary components, and for the same reason: rates are jurisdiction-specific, they change,
// and a rate typed into this file would be a legal assertion the product cannot stand behind. Nothing
// is seeded with a rate, and no label here names a statute.
//
// =================================================================================================
// VOID, NEVER DELETE
// =================================================================================================
//
// There is no delete in this file for an invoice. An invoice that was issued is a record of something
// that was said to somebody: voiding states WHY, keeps the row, keeps its number, and keeps its lines.
// A draft that was never issued is voided the same way, because "it was created and then it wasn't"
// is itself worth reading six months later.
//
// =================================================================================================
// NUMBERING — DERIVED IN THE SAME STATEMENT THAT INSERTS
// =================================================================================================
//
// createInvoice() bumps the series counter and inserts the invoice in ONE statement: the UPDATE ...
// RETURNING sits in a CTE the INSERT selects from, so the series row is locked for the duration and
// two people pressing the button in the same second get consecutive numbers rather than the same one.
// SELECT max() THEN INSERT is the shape that duplicates under concurrency and it does not appear
// here. A unique index on invoice_number is the backstop, not the mechanism.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. rows() normalises; `r.rows[0]` is always a bug.
//   - The real Postgres reason is on `e.cause`; `e.message` is only the failed SQL.
//   - Every `const` is declared ABOVE its first reader. `const` is not hoisted.
//   - NO WRITE PATH SWALLOWS AN EXCEPTION. Every catch logs the real cause and returns
//     { ok: false, error }. The one deliberate exception is the notifier, which says so where it is.
//   - Self-bootstrapping DDL lives inside an ensureOnce guard that logs and re-throws.
//   - DOCUMENTS ARE LINKS, NEVER UPLOADS — a vendor's own bill is a shared link.
//   - No seeded party, vendor or example names a real company.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
// The civil date in the company's zone. An invoice due date is a CALENDAR day, and comparing it to
// the server's UTC day gets the answer wrong for the first five and a half hours of every IST day.
import { civilDate } from '@/lib/page-safety';
// Money arithmetic. round2() rounds the DECIMAL value rather than the binary double; numeric() reads
// the NUMERIC postgres-js hands back as a string without the precision a ::float cast destroys;
// sumMoney() adds in integer paise so a total equals the lines printed beside it.
import { round2, numeric, sumMoney, toMinor, fromMinor } from '@/lib/money';
import {
  startWorkflow,
  instanceForRecord,
  getInstance,
  domainDefinition,
  type WorkflowInstanceRow,
} from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one above its first use.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the failed SQL. */
const logFail = (tag: string, e: any) =>
  console.error('[invoices] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Shown to a person when a write fails. The real cause goes to the log, never to the screen. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found refusal, so probing ids cannot tell absent from forbidden. */
const NOT_AVAILABLE = 'That invoice is not available.';

const SCHEMA_FAILED =
  'The invoice tables are not ready yet, so nothing was saved. Try again in a moment.';

export const DEFAULT_CURRENCY = 'INR';

const MAX_LINE = 300;
const MAX_TEXT = 2000;

/**
 * THE APPROVAL DOMAIN A PAYABLE IS ROUTED THROUGH, and the prefix that keeps it apart from the
 * purchase request it came from.
 *
 * READ THIS BEFORE CHANGING EITHER CONSTANT. src/lib/workflow.ts is the only approval engine and its
 * `procurement` chain already answers the exact question a payable asks — "may this money leave the
 * company for this purchase": the requester's reporting manager, their department head, the
 * procurement approval owner if the organisation has named one, and an executive sponsor at or above
 * the amount declared ON THAT CHAIN. Routing a payable through it means the bill is approved by the
 * same people who approved the spend, per row, from the Organization Graph.
 *
 * The record id is NAMESPACED — 'invoice-payable:<uuid>' — which is the precedent workflow.ts already
 * documents for the appraisal module reusing the `promotion` chain: one chain, distinct record ids,
 * no collision on (domain, record_id) and no second chain to disagree with the first.
 *
 * HONEST LIMIT, STATED RATHER THAN HIDDEN: an approver's queue labels this instance "Procurement
 * request", because that is the domain's label. The summary written by submitPayableForPayment()
 * therefore begins with the words "Invoice payment" and names the invoice number and the vendor, so
 * what somebody is being asked to approve is readable without opening anything. If a dedicated
 * `invoice_payment` domain is added to workflow.ts later, moving to it is a two-line change here and
 * a data migration of record_id — not a redesign.
 */
const PAYABLE_APPROVAL_DOMAIN = 'procurement' as const;
const PAYABLE_RECORD_PREFIX = 'invoice-payable:';

/** The workflow record id for a payable, or null when the id is not one. */
export function payableRecordId(invoiceId: string): string | null {
  return isUuid(invoiceId) ? PAYABLE_RECORD_PREFIX + invoiceId : null;
}

export type InvoiceDirection = 'receivable' | 'payable';

export const DIRECTIONS: readonly InvoiceDirection[] = ['receivable', 'payable'] as const;
export function isDirection(v: unknown): v is InvoiceDirection {
  return v === 'receivable' || v === 'payable';
}

export function directionLabel(v: string): string {
  if (v === 'receivable') return 'We bill them';
  if (v === 'payable') return 'They bill us';
  return String(v || '');
}

/**
 * WHO A RECEIVABLE IS ADDRESSED TO. Two kinds, because they are commercially different relationships
 * and a screen that cannot tell them apart cannot report on either.
 */
export const PARTY_KINDS = ['client', 'partner'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];
export function partyKindLabel(v: string): string {
  if (v === 'client') return 'Client';
  if (v === 'partner') return 'Partner institution';
  return String(v || 'Client');
}

/**
 * THE STORED LIFECYCLE, AND DELIBERATELY NOT THE WHOLE STORY.
 *
 * `part_paid`, `paid` and `overdue` ARE NOT STORED. They are FACTS ABOUT PAYMENTS AND THE CLOCK —
 * derived, every read, from the payment rows and the due date by displayStatus(). Storing them would
 * create a second place for the same fact to live and a guaranteed disagreement the first time a
 * payment landed and the status update did not, which on an invoice means telling somebody they still
 * owe money they have paid.
 *
 * The APPROVAL of a payable is not stored here either, for the same reason procurement does not store
 * one: it is the workflow engine's answer, read from the instance.
 */
export const RECEIVABLE_STATES = ['draft', 'sent', 'void'] as const;
export const PAYABLE_STATES = ['draft', 'submitted', 'void'] as const;
export type InvoiceStatus = 'draft' | 'sent' | 'submitted' | 'void';

const RECEIVABLE_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent', 'void'],
  sent: ['void'],
  void: [],
};

const PAYABLE_TRANSITIONS: Record<string, string[]> = {
  draft: ['submitted', 'void'],
  submitted: ['void'],
  void: [],
};

export interface TransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
}

export function statusLabel(direction: string, status: string): string {
  const key = String(status || '');
  if (key === 'draft') return 'Draft';
  if (key === 'sent') return 'Sent';
  if (key === 'submitted') return 'Sent for payment approval';
  if (key === 'part_paid') return 'Part paid';
  if (key === 'paid') return 'Paid';
  if (key === 'overdue') return 'Overdue';
  if (key === 'void') return 'Void';
  return key;
}

/**
 * May this invoice move from one stored state to the other?
 *
 * IT RETURNS AN OBJECT, NOT A BOOLEAN — `if (canTransition(a, b))` is always true and would wave
 * every move through. src/lib/employee-tasks.ts, src/lib/workflow.ts and src/lib/procurement.ts all
 * document the same trap on their own canTransition; it is spelled the same way here on purpose.
 */
export function canTransition(direction: InvoiceDirection, from: string, to: string): TransitionCheck {
  const map = direction === 'payable' ? PAYABLE_TRANSITIONS : RECEIVABLE_TRANSITIONS;
  const a = String(from || '');
  const b = String(to || '');
  if (!map[a]) return { ok: false, reason: 'That invoice is in a state we do not recognise.' };
  if (!map[b] && b !== 'void') return { ok: false, reason: 'That is not a state we track.' };
  if (a === b) return { ok: false, reason: 'It is already ' + statusLabel(direction, b).toLowerCase() + '.' };
  if ((map[a] || []).indexOf(b) < 0) {
    return {
      ok: false,
      reason: statusLabel(direction, a) + ' does not move to ' + statusLabel(direction, b) + '.',
    };
  }
  return { ok: true, reason: null };
}

/**
 * HOW ONE TAX COMPONENT IS CALCULATED.
 *
 *   percent_of_subtotal   `value` percent of the sum of the line items.
 *   fixed                 `value` as an amount, in the invoice's own currency.
 *
 * There is no percent_of_total, because a tax computed on a total it is itself part of has no fixed
 * point — the same refusal src/lib/payroll.ts writes out for percent_of_gross earnings.
 */
export const TAX_BASES = ['percent_of_subtotal', 'fixed'] as const;
export type TaxBasis = (typeof TAX_BASES)[number];
export function taxBasisLabel(v: string): string {
  if (v === 'percent_of_subtotal') return 'Percentage of subtotal';
  if (v === 'fixed') return 'Fixed amount';
  return String(v || '');
}

/** How money is recorded as having moved. `wallet` is the employee ledger and nothing else. */
export const PAYMENT_METHODS = ['bank', 'gateway', 'cash', 'cheque', 'wallet', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export function paymentMethodLabel(v: string): string {
  if (v === 'bank') return 'Bank transfer';
  if (v === 'gateway') return 'Payment gateway';
  if (v === 'cash') return 'Cash';
  if (v === 'cheque') return 'Cheque';
  if (v === 'wallet') return 'Employee wallet';
  if (v === 'other') return 'Other';
  return String(v || '');
}

// -------------------------------------------------------------------------------------------------
// STORAGE. Self-bootstrapping DDL, INSIDE an ensureOnce guard, exactly once per process.
//
// GREPPED BEFORE WRITING: no invoice_*, no billing_* and no ap/ar table exists anywhere in this
// codebase — src/lib/procurement.ts stores a receipt LINK on an order and never an invoice, and
// `payments` is the Razorpay record of a learner paying a fee, which is a different object with a
// different shape. Nothing here re-declares a table another module owns. Two CREATE TABLE IF NOT
// EXISTS statements for one table, with different shapes, silently break every write for whichever
// module lost the race, and that fault has already cost this project four months of unsent messages.
// -------------------------------------------------------------------------------------------------

export function ensureInvoiceSchema(): Promise<void> {
  return ensureOnce('invoices_v1', async () => {
    try {
      await createInvoiceTables();
    } catch (e: any) {
      logFail('ensureInvoiceSchema', e);
      throw e;
    }
  });
}

/**
 * Did the schema actually land? ensureOnce() hides the rejection from callers on purpose, so a write
 * asks the database rather than trusting that the ensure returned. `to_regclass` answers NULL for an
 * absent table instead of throwing.
 */
async function schemaReady(): Promise<boolean> {
  try {
    await ensureInvoiceSchema();
    const r = rows(await db.execute(sql`
      SELECT to_regclass('public.invoices') IS NOT NULL AS ok`));
    return r.length > 0 && r[0]?.ok === true;
  } catch (e: any) {
    logFail('schemaReady', e);
    return false;
  }
}

async function createInvoiceTables(): Promise<void> {
  // -----------------------------------------------------------------------------------------
  // invoice_series — THE NUMBER SEQUENCES. One row per series, and the counter lives HERE and
  // nowhere else. next_number is the number the NEXT invoice will take; createInvoice() bumps it
  // and reads it back inside the same statement that inserts the invoice.
  //
  // The prefix is plain configurable text rather than a template with a year in it, because a
  // counter that resets on a date is a counter with two owners. A new year is a new series, which
  // an administrator creates on the numbering screen in ten seconds and can read afterwards.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoice_series (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code         TEXT NOT NULL,
    label        TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT 'receivable',
    prefix       TEXT NOT NULL DEFAULT 'INV-',
    next_number  BIGINT NOT NULL DEFAULT 1,
    pad          INT NOT NULL DEFAULT 4,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS —
  // which is how hr_employees.work_email came to be declared and absent at the same time and locked
  // every administrator out of /admin for a day. So every column past the primary key is asserted
  // again. No-ops on a fresh database; the difference between working and a 500 on an older one.
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT ''`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'receivable'`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT 'INV-'`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS next_number BIGINT NOT NULL DEFAULT 1`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS pad INT NOT NULL DEFAULT 4`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS created_by UUID`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE invoice_series ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoice_series_code_uq ON invoice_series (code)`);
  } catch (e: any) {
    logFail('invoice_series_code_uq', e);
  }

  // -----------------------------------------------------------------------------------------
  // invoices — ONE ROW PER DOCUMENT, IN EITHER DIRECTION.
  //
  //   direction        receivable | payable. Every read narrows on it; the two consoles never see
  //                    each other's rows.
  //   invoice_number   OURS, from the series. On a payable this is an internal reference and the
  //                    vendor's own number is vendor_invoice_ref — printing theirs as ours would
  //                    make two documents claim one identity.
  //   status           draft | sent (receivable) | submitted (payable) | void. NOT part_paid, paid
  //                    or overdue — those are derived; see the note on RECEIVABLE_STATES.
  //   subtotal/tax_total/total  written ONLY by recalcTotals(), from the line and tax rows.
  //   attachment_url   A LINK. Documents are never uploaded on this platform.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction            TEXT NOT NULL,
    series_id            UUID,
    invoice_number       TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'draft',
    currency             TEXT NOT NULL DEFAULT 'INR',
    issue_date           DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date             DATE,
    subtotal             NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total            NUMERIC(14,2) NOT NULL DEFAULT 0,
    total                NUMERIC(14,2) NOT NULL DEFAULT 0,
    party_kind           TEXT,
    party_name           TEXT,
    party_email          TEXT,
    party_address        TEXT,
    party_tax_reference  TEXT,
    party_reference      TEXT,
    vendor_id            UUID,
    purchase_request_id  UUID,
    purchase_order_id    UUID,
    vendor_invoice_ref   TEXT,
    payee_employee_id    UUID,
    attachment_url       TEXT,
    notes                TEXT,
    terms                TEXT,
    sent_at              TIMESTAMPTZ,
    submitted_at         TIMESTAMPTZ,
    void_reason          TEXT,
    voided_at            TIMESTAMPTZ,
    voided_by            UUID,
    created_by           UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS series_id UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_total NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_kind TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_name TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_email TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_address TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_tax_reference TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS party_reference TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vendor_id UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS purchase_request_id UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS purchase_order_id UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vendor_invoice_ref TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payee_employee_id UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS void_reason TEXT`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_by UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by UUID`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // NO CHECK CONSTRAINT on status or direction, and no foreign key to procurement or hr_employees.
  // Same reasons workflow-schema.ts and procurement.ts give for their own tables: this project has
  // no migration runner, so every DDL change is CREATE/ADD IF NOT EXISTS and a CHECK could never be
  // widened; and a foreign key to a vendor or an employee would take an invoice with it when either
  // is removed, when that invoice is the evidence behind money that moved.

  // TWO INVOICES MUST NEVER SHARE A NUMBER. The single-statement counter bump makes a collision
  // almost impossible; this index makes it impossible. Its own try/catch, because an index that
  // cannot be created on existing data must not abort the bootstrap and leave half a schema.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_uq ON invoices (invoice_number)`);
  } catch (e: any) {
    logFail('invoices_number_uq', e);
  }
  // ONE PAYABLE PER PURCHASE REQUEST that is not void: an approved purchase becomes A payable, not a
  // second unrelated record and not two.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoices_payable_request_uq
      ON invoices (purchase_request_id)
      WHERE purchase_request_id IS NOT NULL AND direction = 'payable' AND status <> 'void'`);
  } catch (e: any) {
    logFail('invoices_payable_request_uq', e);
  }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS invoices_dir_status_idx
    ON invoices (direction, status, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS invoices_due_idx ON invoices (due_date)`);

  // -----------------------------------------------------------------------------------------
  // invoice_lines — WHAT IS BEING CHARGED FOR. Quantity and rate are kept as well as the computed
  // amount, because "12 hours at 2,500" is the thing somebody agreed to and a single total is not.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoice_lines (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id   UUID NOT NULL,
    position     INT NOT NULL DEFAULT 0,
    description  TEXT NOT NULL,
    quantity     NUMERIC(14,3) NOT NULL DEFAULT 1,
    unit         TEXT,
    rate         NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS quantity NUMERIC(14,3) NOT NULL DEFAULT 1`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS unit TEXT`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS rate NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx
    ON invoice_lines (invoice_id, position, created_at)`);

  // -----------------------------------------------------------------------------------------
  // invoice_tax_components — THE CONFIGURABLE CATALOGUE. Empty on a fresh database, and it STAYS
  // empty until an administrator adds something: this product ships no rate, because a rate shipped
  // in code is a compliance claim in code. Modelled on payroll_components for exactly that reason.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoice_tax_components (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL,
    label       TEXT NOT NULL,
    basis       TEXT NOT NULL DEFAULT 'percent_of_subtotal',
    value       NUMERIC(14,4) NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    note        TEXT,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT ''`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'percent_of_subtotal'`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS value NUMERIC(14,4) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS note TEXT`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS created_by UUID`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE invoice_tax_components ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoice_tax_components_code_uq
      ON invoice_tax_components (code)`);
  } catch (e: any) {
    logFail('invoice_tax_components_code_uq', e);
  }

  // -----------------------------------------------------------------------------------------
  // invoice_tax_lines — THE COMPONENT AS IT WAS AT THE MOMENT IT WAS APPLIED. Label, basis and
  // value are COPIED onto the invoice rather than joined from the catalogue, so editing a component
  // next year does not silently restate what an issued document said this year.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoice_tax_lines (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id    UUID NOT NULL,
    component_id  UUID,
    code          TEXT NOT NULL,
    label         TEXT NOT NULL,
    basis         TEXT NOT NULL,
    value         NUMERIC(14,4) NOT NULL DEFAULT 0,
    amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    position      INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS component_id UUID`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'percent_of_subtotal'`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS value NUMERIC(14,4) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE invoice_tax_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS invoice_tax_lines_invoice_idx
    ON invoice_tax_lines (invoice_id, position)`);
  // ONE LINE PER COMPONENT PER INVOICE, said by the database rather than only by applyTaxComponents.
  //
  // The only index on this table was the non-unique one above, so nothing prevented an invoice from
  // carrying the same tax component twice — and recalcTotals() sums every row it finds, which is how a
  // client invoice comes to charge 36% GST where the components say 18%. applyTaxComponents now does
  // its DELETE and its INSERTs in one transaction, which is the real fix; this is the constraint that
  // makes the invariant true regardless of who else ever writes this table.
  //
  // ADDITIVE AND NON-FATAL. An invoice that ALREADY carries a duplicated component would reject the
  // index, and a finance module that refuses to load is worse than one running with the transaction
  // guard alone. It is logged, because a duplicate here means a document overstated its own tax.
  // TO FIND ANY BEFORE THIS CAN SUCCEED (run it yourself — this process never connects):
  //   SELECT invoice_id, code, COUNT(*) FROM invoice_tax_lines GROUP BY 1,2 HAVING COUNT(*) > 1;
  // Nothing here deletes a row; a duplicate has to be removed by a human who can see which invoice it
  // is on and whether that invoice has already been issued.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoice_tax_lines_code_uq
      ON invoice_tax_lines (invoice_id, code)`);
  } catch (e: any) {
    logFail('invoice_tax_lines_code_uq', e);
  }

  // -----------------------------------------------------------------------------------------
  // invoice_payments — MONEY THAT ACTUALLY MOVED, one row per movement, so a part payment is a
  // first-class fact rather than a number somebody overwrote.
  //
  //   wallet_credited / wallet_ref  ONLY for a payable settled into an employee wallet, and the ref
  //                                 is what makes that credit idempotent in hr_wallet_txn. There is
  //                                 no ledger in this file; hr-wallet.ts holds the only one.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS invoice_payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id       UUID NOT NULL,
    amount           NUMERIC(14,2) NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'INR',
    paid_on          DATE NOT NULL DEFAULT CURRENT_DATE,
    method           TEXT NOT NULL DEFAULT 'bank',
    reference        TEXT,
    note             TEXT,
    wallet_credited  BOOLEAN NOT NULL DEFAULT FALSE,
    wallet_ref       TEXT,
    recorded_by      UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS paid_on DATE NOT NULL DEFAULT CURRENT_DATE`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'bank'`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS reference TEXT`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS note TEXT`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS wallet_credited BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS wallet_ref TEXT`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS recorded_by UUID`);
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx
    ON invoice_payments (invoice_id, paid_on DESC)`);

  // ---- THE IDEMPOTENCY KEY -----------------------------------------------------------------------
  //
  // recordPayment() computes the outstanding balance inside the INSERT, so an OVERPAYMENT cannot be
  // written. That closes one failure and leaves the other one wide open: a PART payment repeated.
  //
  // On a payable of 400,000 with 400,000 outstanding, two submissions of "100,000 by bank transfer,
  // reference NEFT-88213" both pass the balance test, because 100,000 twice is still inside 400,000.
  // Two rows land, the bill reads 200,000 paid, and nothing distinguishes the pair from two genuine
  // part payments that happen to share a reference — which is precisely what a vendor's remittance
  // advice looks like. When the payable is settled `method = 'wallet'`, each row credits the employee
  // wallet under its OWN payment id, so the second one pays somebody a second time.
  //
  // The key is what the person recording the payment already knows: the invoice, the day the money
  // moved, the method, the amount and the reference they typed. Two submissions of one form produce
  // the same key; two genuinely different payments (a different day, a different amount, a different
  // reference) do not. It is derived rather than supplied so no caller can forget to bring one.
  //
  // ADDITIVE, AND THE INDEX IS PARTIAL so rows written before this column existed — which all carry
  // NULL — cannot collide with each other or with anything new.
  await db.execute(sql`ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_idem_uniq
      ON invoice_payments (idempotency_key) WHERE idempotency_key IS NOT NULL`);
  } catch (e: any) {
    // NON-FATAL AND LOUD. If the index cannot be built there is already a duplicated key in the
    // table, which means a payment has been recorded twice and a human has to net it off. A finance
    // module that refuses to load is worse than one that runs with the balance guard alone.
    logFail('createInvoiceTables.idempotency', e);
  }

  // TWO SERIES SO THE MODULE WORKS THE MOMENT IT IS OPENED, and neither carries a rate, a tax or a
  // claim — a prefix and a counter are the whole of it. An administrator who renames, re-prefixes or
  // retires either one keeps that edit across every later boot, because the guard is "is there a row
  // with this code", not "does it still look like the one we wrote".
  //
  // WHERE NOT EXISTS RATHER THAN ON CONFLICT DO NOTHING, deliberately: the unique index above has its
  // own try/catch and is ALLOWED to fail without taking the tables with it, and ON CONFLICT with no
  // index to conflict against inserts a duplicate series on every cold start — which would hand two
  // series the same code and the numbering screen two rows nobody can tell apart.
  await db.execute(sql`
    INSERT INTO invoice_series (code, label, direction, prefix, next_number, pad)
    SELECT 'INV', 'Sales invoices', 'receivable', 'INV-', 1, 4
     WHERE NOT EXISTS (SELECT 1 FROM invoice_series WHERE code = 'INV')`);
  await db.execute(sql`
    INSERT INTO invoice_series (code, label, direction, prefix, next_number, pad)
    SELECT 'BILL', 'Supplier bills', 'payable', 'BILL-', 1, 4
     WHERE NOT EXISTS (SELECT 1 FROM invoice_series WHERE code = 'BILL')`);
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface InvoiceSeries {
  id: string;
  code: string;
  label: string;
  direction: InvoiceDirection;
  prefix: string;
  nextNumber: number;
  pad: number;
  isActive: boolean;
}

export interface TaxComponent {
  id: string;
  code: string;
  label: string;
  basis: TaxBasis;
  value: number;
  isActive: boolean;
  note: string | null;
}

export interface Invoice {
  id: string;
  direction: InvoiceDirection;
  seriesId: string | null;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  subtotal: number;
  taxTotal: number;
  total: number;
  partyKind: string | null;
  partyName: string | null;
  partyEmail: string | null;
  partyAddress: string | null;
  partyTaxReference: string | null;
  partyReference: string | null;
  vendorId: string | null;
  vendorName: string | null;
  purchaseRequestId: string | null;
  purchaseOrderId: string | null;
  vendorInvoiceRef: string | null;
  payeeEmployeeId: string | null;
  payeeName: string | null;
  attachmentUrl: string | null;
  notes: string | null;
  terms: string | null;
  sentAt: string | null;
  submittedAt: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  rate: number;
  amount: number;
}

export interface InvoiceTaxLine {
  id: string;
  invoiceId: string;
  code: string;
  label: string;
  basis: TaxBasis;
  value: number;
  amount: number;
  position: number;
}

export interface InvoicePayment {
  id: string;
  invoiceId: string;
  amount: number;
  currency: string;
  paidOn: string | null;
  method: string;
  reference: string | null;
  note: string | null;
  walletCredited: boolean;
  walletRef: string | null;
  createdAt: string | null;
}

/** Everything a screen needs to render one invoice honestly, in one object. */
export interface InvoiceView {
  invoice: Invoice;
  lines: InvoiceLine[];
  taxLines: InvoiceTaxLine[];
  payments: InvoicePayment[];
  /** Sum of the payment rows. Derived, never stored. */
  paidTotal: number;
  /** total - paidTotal, floored at zero for display. */
  balance: number;
  /** draft | sent | submitted | part_paid | paid | overdue | void. Derived every read. */
  display: string;
  /** The PAY APPROVAL, from the workflow engine. Always null for a receivable. */
  instance: WorkflowInstanceRow | null;
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
  error?: string;
  /** Set when the pay approval halted for want of an approver. The engine's sentence, verbatim. */
  haltReason?: string | null;
  /** Set when the write succeeded and something ALONGSIDE it did not. Never used to hide a failure. */
  warning?: string;
}

// -------------------------------------------------------------------------------------------------
// SMALL HELPERS AND MAPPERS
// -------------------------------------------------------------------------------------------------

function text(v: unknown, max = MAX_LINE): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ONE ROUNDING RULE, SHARED WITH THE REST OF THE MONEY MODULES.
 *
 * This was `Math.round((Number(n) || 0) * 100) / 100`, the same copy five other modules carried. It
 * rounds a half paisa DOWN whenever the product lands just under .5 in IEEE754 — 1.005 * 100 is
 * 100.49999999999999 — so a tax line, a quantity times a rate, or a percentage of a subtotal could
 * each be a paisa short of what the document's own figures say. round2() in src/lib/money.ts takes
 * the decimal value back before rounding. Kept under the name `money` because it is used ~40 times
 * in this file and the name reads correctly at each of them.
 */
const money = round2;

/** A shared document link, or null. http(s) only, and nothing is ever uploaded on this platform. */
export function normaliseLink(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  return s.slice(0, 1000);
}

/** An ISO date (yyyy-mm-dd), or null. Anything else is refused rather than coerced to today. */
function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

export function formatAmount(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const cur = String(currency || DEFAULT_CURRENCY);
  const n = Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'INR' ? '₹' + n : cur + ' ' + n;
}

function mapSeries(r: any): InvoiceSeries {
  return {
    id: String(r?.id ?? ''),
    code: String(r?.code ?? ''),
    label: String(r?.label ?? ''),
    direction: (r?.direction === 'payable' ? 'payable' : 'receivable') as InvoiceDirection,
    prefix: String(r?.prefix ?? ''),
    nextNumber: Number(r?.next_number) || 1,
    pad: Number(r?.pad) || 4,
    isActive: r?.is_active !== false,
  };
}

function mapComponent(r: any): TaxComponent {
  return {
    id: String(r?.id ?? ''),
    code: String(r?.code ?? ''),
    label: String(r?.label ?? ''),
    basis: ((TAX_BASES as readonly string[]).indexOf(String(r?.basis)) >= 0 ? r.basis : 'percent_of_subtotal') as TaxBasis,
    value: Number(r?.value) || 0,
    isActive: r?.is_active !== false,
    note: r?.note ? String(r.note) : null,
  };
}

function mapInvoice(r: any): Invoice {
  return {
    id: String(r?.id ?? ''),
    direction: (r?.direction === 'payable' ? 'payable' : 'receivable') as InvoiceDirection,
    seriesId: r?.series_id ? String(r.series_id) : null,
    invoiceNumber: String(r?.invoice_number ?? ''),
    status: String(r?.status || 'draft') as InvoiceStatus,
    currency: String(r?.currency || DEFAULT_CURRENCY),
    issueDate: r?.issue_date ? String(r.issue_date).slice(0, 10) : null,
    dueDate: r?.due_date ? String(r.due_date).slice(0, 10) : null,
    subtotal: Number(r?.subtotal) || 0,
    taxTotal: Number(r?.tax_total) || 0,
    total: Number(r?.total) || 0,
    partyKind: r?.party_kind ? String(r.party_kind) : null,
    partyName: r?.party_name ? String(r.party_name) : null,
    partyEmail: r?.party_email ? String(r.party_email) : null,
    partyAddress: r?.party_address ? String(r.party_address) : null,
    partyTaxReference: r?.party_tax_reference ? String(r.party_tax_reference) : null,
    partyReference: r?.party_reference ? String(r.party_reference) : null,
    vendorId: r?.vendor_id ? String(r.vendor_id) : null,
    vendorName: r?.vendor_name ? String(r.vendor_name) : null,
    purchaseRequestId: r?.purchase_request_id ? String(r.purchase_request_id) : null,
    purchaseOrderId: r?.purchase_order_id ? String(r.purchase_order_id) : null,
    vendorInvoiceRef: r?.vendor_invoice_ref ? String(r.vendor_invoice_ref) : null,
    payeeEmployeeId: r?.payee_employee_id ? String(r.payee_employee_id) : null,
    payeeName: r?.payee_name ? String(r.payee_name) : null,
    attachmentUrl: r?.attachment_url ? String(r.attachment_url) : null,
    notes: r?.notes ? String(r.notes) : null,
    terms: r?.terms ? String(r.terms) : null,
    sentAt: r?.sent_at ? new Date(r.sent_at).toISOString() : null,
    submittedAt: r?.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    voidReason: r?.void_reason ? String(r.void_reason) : null,
    voidedAt: r?.voided_at ? new Date(r.voided_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function mapLine(r: any): InvoiceLine {
  return {
    id: String(r?.id ?? ''),
    invoiceId: String(r?.invoice_id ?? ''),
    position: Number(r?.position) || 0,
    description: String(r?.description ?? ''),
    quantity: Number(r?.quantity) || 0,
    unit: r?.unit ? String(r.unit) : null,
    rate: Number(r?.rate) || 0,
    amount: Number(r?.amount) || 0,
  };
}

function mapTaxLine(r: any): InvoiceTaxLine {
  return {
    id: String(r?.id ?? ''),
    invoiceId: String(r?.invoice_id ?? ''),
    code: String(r?.code ?? ''),
    label: String(r?.label ?? ''),
    basis: ((TAX_BASES as readonly string[]).indexOf(String(r?.basis)) >= 0 ? r.basis : 'percent_of_subtotal') as TaxBasis,
    value: Number(r?.value) || 0,
    amount: Number(r?.amount) || 0,
    position: Number(r?.position) || 0,
  };
}

function mapPayment(r: any): InvoicePayment {
  return {
    id: String(r?.id ?? ''),
    invoiceId: String(r?.invoice_id ?? ''),
    amount: Number(r?.amount) || 0,
    currency: String(r?.currency || DEFAULT_CURRENCY),
    paidOn: r?.paid_on ? String(r.paid_on).slice(0, 10) : null,
    method: String(r?.method || 'bank'),
    reference: r?.reference ? String(r.reference) : null,
    note: r?.note ? String(r.note) : null,
    walletCredited: r?.wallet_credited === true,
    walletRef: r?.wallet_ref ? String(r.wallet_ref) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/**
 * THE STATUS A PERSON READS, derived from the stored state, the payments and the clock.
 *
 * Order matters and is deliberate: void beats everything (a voided invoice is not overdue, it is
 * void), then fully paid, then part paid, then overdue, then the stored state. A draft is never
 * overdue — nobody has been asked for anything.
 */
export function displayStatus(invoice: Invoice, paidTotal: number, today?: Date): string {
  if (invoice.status === 'void') return 'void';
  const total = money(invoice.total);
  const paid = money(paidTotal);
  if (invoice.status === 'draft') return 'draft';
  if (total > 0 && paid >= total) return 'paid';
  if (paid > 0) return 'part_paid';
  if (invoice.dueDate) {
    // THE DUE DATE IS A CIVIL DATE AND MUST BE COMPARED AGAINST ONE.
    //
    // This was `new Date().toISOString().slice(0,10)`, which is the UTC day. The server runs in UTC
    // and the people reading this are in IST, five and a half hours ahead — so for the first five and
    // a half hours of every IST day the comparison used YESTERDAY, and an invoice that fell due did
    // not read as overdue on the morning it fell due. civilDate() asks Intl for the day in the zone.
    const iso = civilDate(today || new Date());
    if (iso && invoice.dueDate < iso) return 'overdue';
  }
  return invoice.status;
}

// -------------------------------------------------------------------------------------------------
// SERIES AND TAX COMPONENTS — CONFIGURATION, not policy written into code.
// -------------------------------------------------------------------------------------------------

export async function listSeries(direction?: InvoiceDirection): Promise<InvoiceSeries[]> {
  try {
    await ensureInvoiceSchema();
    const dirFilter = direction ? sql`AND direction = ${direction}` : sql``;
    const r = await db.execute(sql`
      SELECT * FROM invoice_series
       WHERE TRUE ${dirFilter}
       ORDER BY is_active DESC, direction, code`);
    return rows(r).map(mapSeries);
  } catch (e: any) {
    logFail('listSeries', e);
    return [];
  }
}

export interface SeriesInput {
  id?: string | null;
  code?: string | null;
  label?: string | null;
  direction?: string | null;
  prefix?: string | null;
  pad?: number | string | null;
  nextNumber?: number | string | null;
  isActive?: boolean;
}

/**
 * Create or update one numbering series.
 *
 * next_number MOVES FORWARD ONLY. Setting it backwards would hand the next invoice a number an
 * earlier one already carries, and the unique index would then refuse an insert that looked correct
 * on screen. This refuses in words instead.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST BRING ONE — the same contract procurement.ts states
 * on raiseOrder(). `actorUserId` is for the audit trail, not a gate.
 */
export async function saveSeries(input: SeriesInput, actorUserId: string | null): Promise<WriteResult> {
  const code = (text(input?.code, 20) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const label = text(input?.label, 120);
  const direction = isDirection(input?.direction) ? input.direction : 'receivable';
  const prefix = text(input?.prefix, 20);
  const pad = Math.min(Math.max(Number(input?.pad) || 4, 1), 10);
  const nextNumber = Math.max(Number(input?.nextNumber) || 1, 1);
  const id = isUuid(input?.id) ? String(input?.id) : null;

  if (!code) return { ok: false, error: 'Give the series a short code, in letters and numbers.' };
  if (!label) return { ok: false, error: 'Give the series a name. It is what the numbering screen lists.' };
  if (!prefix) return { ok: false, error: 'Give the series a prefix. It is the readable part of every number it issues.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    if (id) {
      const existing = rows(await db.execute(sql`
        SELECT next_number FROM invoice_series WHERE id = ${id}::uuid LIMIT 1`));
      if (!existing.length) return { ok: false, error: 'That series is not available.' };
      const current = Number(existing[0].next_number) || 1;
      if (nextNumber < current) {
        return {
          ok: false,
          error: 'The next number cannot move backwards. It is at ' + current + ', and setting it lower '
            + 'would issue a number an invoice already carries.',
        };
      }
      const wrote = rows(await db.execute(sql`
        UPDATE invoice_series
           SET label = ${label}, prefix = ${prefix}, pad = ${pad}, next_number = ${nextNumber},
               direction = ${direction}, is_active = ${input?.isActive !== false}, updated_at = NOW()
         WHERE id = ${id}::uuid
        RETURNING id`));
      if (!wrote.length) return { ok: false, error: 'That series is not available.' };
      await logAudit({
        userId: isUuid(actorUserId) ? actorUserId : null,
        action: 'invoice.series.update', entity: 'invoice_series', entityId: id,
        diff: { code, label, direction, prefix, pad, nextNumber, isActive: input?.isActive !== false },
      });
      return { ok: true, id, changed: true };
    }

    const dupe = rows(await db.execute(sql`SELECT id FROM invoice_series WHERE code = ${code} LIMIT 1`));
    if (dupe.length) {
      return { ok: false, error: 'A series with the code "' + code + '" already exists. Edit that one, or choose another code.' };
    }
    const ins = rows(await db.execute(sql`
      INSERT INTO invoice_series (code, label, direction, prefix, pad, next_number, created_by)
      VALUES (${code}, ${label}, ${direction}, ${prefix}, ${pad}, ${nextNumber}, ${isUuid(actorUserId) ? actorUserId : null}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.series.create', entity: 'invoice_series', entityId: String(ins[0].id),
      diff: { code, label, direction, prefix, pad, nextNumber },
    });
    return { ok: true, id: String(ins[0].id), changed: true };
  } catch (e: any) {
    logFail('saveSeries', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function listTaxComponents(includeInactive = false): Promise<TaxComponent[]> {
  try {
    await ensureInvoiceSchema();
    const activeFilter = includeInactive ? sql`` : sql`AND is_active = true`;
    const r = await db.execute(sql`
      SELECT * FROM invoice_tax_components
       WHERE TRUE ${activeFilter}
       ORDER BY is_active DESC, code`);
    return rows(r).map(mapComponent);
  } catch (e: any) {
    logFail('listTaxComponents', e);
    return [];
  }
}

export interface TaxComponentInput {
  id?: string | null;
  code?: string | null;
  label?: string | null;
  basis?: string | null;
  value?: number | string | null;
  note?: string | null;
  isActive?: boolean;
}

/**
 * Create or update one tax component.
 *
 * THE RATE IS THE ADMINISTRATOR'S, NOT THE PRODUCT'S. Nothing in this file knows what any tax is
 * called or what it should be, and the label is printed on the document exactly as it was typed. That
 * is the same decision src/lib/payroll.ts made after statutory rates hardcoded in a payroll run put
 * percentages on payslips that the product could not stand behind.
 */
export async function saveTaxComponent(input: TaxComponentInput, actorUserId: string | null): Promise<WriteResult> {
  const code = (text(input?.code, 30) || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = text(input?.label, 120);
  const basis = ((TAX_BASES as readonly string[]).indexOf(String(input?.basis)) >= 0
    ? String(input?.basis) : 'percent_of_subtotal') as TaxBasis;
  const value = num(input?.value);
  const id = isUuid(input?.id) ? String(input?.id) : null;

  if (!code) return { ok: false, error: 'Give the component a short code.' };
  if (!label) return { ok: false, error: 'Give the component a label. It is printed on the invoice exactly as you write it.' };
  if (value === null || value < 0) return { ok: false, error: 'Give the component a value of zero or more.' };
  if (basis === 'percent_of_subtotal' && value > 100) {
    return { ok: false, error: 'A percentage cannot be above 100.' };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    if (id) {
      const wrote = rows(await db.execute(sql`
        UPDATE invoice_tax_components
           SET label = ${label}, basis = ${basis}, value = ${value}, note = ${text(input?.note, MAX_TEXT)},
               is_active = ${input?.isActive !== false}, updated_at = NOW()
         WHERE id = ${id}::uuid
        RETURNING id`));
      if (!wrote.length) return { ok: false, error: 'That component is not available.' };
      await logAudit({
        userId: isUuid(actorUserId) ? actorUserId : null,
        action: 'invoice.tax_component.update', entity: 'invoice_tax_component', entityId: id,
        diff: { code, label, basis, value, isActive: input?.isActive !== false },
      });
      return { ok: true, id, changed: true };
    }
    const dupe = rows(await db.execute(sql`SELECT id FROM invoice_tax_components WHERE code = ${code} LIMIT 1`));
    if (dupe.length) {
      return { ok: false, error: 'A component with the code "' + code + '" already exists. Edit that one, or choose another code.' };
    }
    const ins = rows(await db.execute(sql`
      INSERT INTO invoice_tax_components (code, label, basis, value, note, created_by)
      VALUES (${code}, ${label}, ${basis}, ${value}, ${text(input?.note, MAX_TEXT)},
              ${isUuid(actorUserId) ? actorUserId : null}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.tax_component.create', entity: 'invoice_tax_component', entityId: String(ins[0].id),
      diff: { code, label, basis, value },
    });
    return { ok: true, id: String(ins[0].id), changed: true };
  } catch (e: any) {
    logFail('saveTaxComponent', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface ListInvoiceOptions {
  direction?: InvoiceDirection;
  /** A STORED status only. Ask for 'overdue' or 'paid' by filtering the views — they are derived. */
  status?: string;
  limit?: number;
}

export async function listInvoices(opts: ListInvoiceOptions = {}): Promise<Invoice[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  try {
    await ensureInvoiceSchema();
    const dirFilter = opts.direction ? sql`AND i.direction = ${opts.direction}` : sql``;
    const statusFilter = opts.status ? sql`AND i.status = ${String(opts.status)}` : sql``;
    const r = await db.execute(sql`
      SELECT i.*, v.name AS vendor_name, e.full_name AS payee_name
        FROM invoices i
        LEFT JOIN procurement_vendors v ON v.id = i.vendor_id
        LEFT JOIN hr_employees e ON e.id = i.payee_employee_id
       WHERE TRUE ${dirFilter} ${statusFilter}
       ORDER BY (i.status = 'void') ASC, i.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapInvoice);
  } catch (e: any) {
    // procurement_vendors may not exist on a database where no purchasing page has ever been opened.
    // Fall back to the invoice table alone rather than showing nothing: a vendor name is a nicety,
    // an invoice list is the screen.
    logFail('listInvoices.join', e);
    try {
      const dirFilter = opts.direction ? sql`AND direction = ${opts.direction}` : sql``;
      const statusFilter = opts.status ? sql`AND status = ${String(opts.status)}` : sql``;
      const r = await db.execute(sql`
        SELECT * FROM invoices
         WHERE TRUE ${dirFilter} ${statusFilter}
         ORDER BY (status = 'void') ASC, created_at DESC
         LIMIT ${limit}`);
      return rows(r).map(mapInvoice);
    } catch (e2: any) {
      logFail('listInvoices', e2);
      return [];
    }
  }
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureInvoiceSchema();
    const r = rows(await db.execute(sql`
      SELECT i.*, v.name AS vendor_name, e.full_name AS payee_name
        FROM invoices i
        LEFT JOIN procurement_vendors v ON v.id = i.vendor_id
        LEFT JOIN hr_employees e ON e.id = i.payee_employee_id
       WHERE i.id = ${id}::uuid
       LIMIT 1`));
    return r.length ? mapInvoice(r[0]) : null;
  } catch (e: any) {
    logFail('getInvoice.join', e);
    try {
      const r = rows(await db.execute(sql`SELECT * FROM invoices WHERE id = ${id}::uuid LIMIT 1`));
      return r.length ? mapInvoice(r[0]) : null;
    } catch (e2: any) {
      logFail('getInvoice', e2);
      return null;
    }
  }
}

export async function invoiceLines(invoiceId: string): Promise<InvoiceLine[]> {
  if (!isUuid(invoiceId)) return [];
  try {
    await ensureInvoiceSchema();
    const r = await db.execute(sql`
      SELECT * FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid
       ORDER BY position ASC, created_at ASC`);
    return rows(r).map(mapLine);
  } catch (e: any) {
    logFail('invoiceLines', e);
    return [];
  }
}

export async function invoiceTaxLines(invoiceId: string): Promise<InvoiceTaxLine[]> {
  if (!isUuid(invoiceId)) return [];
  try {
    await ensureInvoiceSchema();
    const r = await db.execute(sql`
      SELECT * FROM invoice_tax_lines WHERE invoice_id = ${invoiceId}::uuid
       ORDER BY position ASC, created_at ASC`);
    return rows(r).map(mapTaxLine);
  } catch (e: any) {
    logFail('invoiceTaxLines', e);
    return [];
  }
}

export async function invoicePayments(invoiceId: string): Promise<InvoicePayment[]> {
  if (!isUuid(invoiceId)) return [];
  try {
    await ensureInvoiceSchema();
    const r = await db.execute(sql`
      SELECT * FROM invoice_payments WHERE invoice_id = ${invoiceId}::uuid
       ORDER BY paid_on DESC, created_at DESC`);
    return rows(r).map(mapPayment);
  } catch (e: any) {
    logFail('invoicePayments', e);
    return [];
  }
}

/** The pay-approval instance for a payable, or null. Always null for a receivable — see the note on
 *  PAYABLE_APPROVAL_DOMAIN for why the record id is namespaced. */
export async function payApprovalFor(invoice: Invoice): Promise<WorkflowInstanceRow | null> {
  if (invoice.direction !== 'payable') return null;
  const rec = payableRecordId(invoice.id);
  if (!rec) return null;
  return instanceForRecord(PAYABLE_APPROVAL_DOMAIN, rec);
}

/** One invoice with its lines, taxes, payments, derived status and pay approval. */
export async function viewInvoice(id: string): Promise<InvoiceView | null> {
  const invoice = await getInvoice(id);
  if (!invoice) return null;
  const [lines, taxLines, payments] = await Promise.all([
    invoiceLines(invoice.id),
    invoiceTaxLines(invoice.id),
    invoicePayments(invoice.id),
  ]);
  // THE AMOUNT PAID EQUALS THE PAYMENT ROWS PRINTED BENEATH IT.
  //
  // This was `money(payments.reduce((s, p) => s + amount, 0))` — doubles added left to right and
  // rounded once at the end. Every consumer of this figure is a comparison, not a display: `balance`
  // below is derived from it, recordPayment() refuses an amount above that balance, and
  // displayStatus() decides whether a bill reads as PAID from it. A total that is a paisa away from
  // the sum of its own rows leaves an invoice whose payments visibly cover it still showing a
  // balance nobody can clear, or the reverse. sumMoney() adds integer paise, where that cannot
  // happen. See src/lib/money.ts.
  const paidTotal = sumMoney(payments.map((p) => p.amount));
  const instance = await payApprovalFor(invoice);
  return {
    invoice,
    lines,
    taxLines,
    payments,
    paidTotal,
    balance: money(Math.max(0, invoice.total - paidTotal)),
    display: displayStatus(invoice, paidTotal),
    instance,
  };
}

/**
 * A list with the derived facts attached, in a BOUNDED number of queries.
 *
 * The payment totals for every invoice on the page come back in ONE grouped query rather than one per
 * row — a list of eighty invoices must not be eighty round trips. The pay approval is NOT loaded here
 * for the same reason; the detail screen loads it for the one invoice being looked at.
 */
export interface InvoiceListRow {
  invoice: Invoice;
  paidTotal: number;
  balance: number;
  display: string;
}

export async function withTotals(list: Invoice[]): Promise<InvoiceListRow[]> {
  if (!list.length) return [];
  const paidById = new Map<string, number>();
  try {
    await ensureInvoiceSchema();
    const ids = list.map((i) => i.id).filter(isUuid);
    if (ids.length) {
      // BOUND, one fragment per id, never pasted — the same shape src/lib/calendar-hub.ts uses. An
      // id is data even when it came from a row this process just read.
      const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
      // NO ::float. invoice_payments.amount is NUMERIC(14,2); the cast converted an exact decimal to
      // a double before this process saw it, and the result is subtracted from the invoice total to
      // produce the balance every list screen prints.
      const r = await db.execute(sql`
        SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid
          FROM invoice_payments
         WHERE invoice_id IN (${idList})
         GROUP BY invoice_id`);
      for (const row of rows(r)) paidById.set(String(row.invoice_id), numeric(row.paid));
    }
  } catch (e: any) {
    // The totals could not be read. Every invoice is reported with zero paid AND the caller sees the
    // stored status rather than a derived "paid" it cannot prove — never the other way round.
    logFail('withTotals', e);
  }
  return list.map((invoice) => {
    const paidTotal = money(paidById.get(invoice.id) || 0);
    return {
      invoice,
      paidTotal,
      balance: money(Math.max(0, invoice.total - paidTotal)),
      display: displayStatus(invoice, paidTotal),
    };
  });
}

/**
 * The purchase requests that ALREADY have a live payable against them.
 *
 * The "record a bill" form asks this so it does not offer a purchase somebody has already billed —
 * the unique index refuses the second one anyway, but a form that offers a choice the database will
 * refuse is a form that teaches people to distrust it. Void payables are excluded, because voiding is
 * exactly how a mis-recorded bill is withdrawn and the purchase becomes billable again.
 */
export async function billedPurchaseRequestIds(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    await ensureInvoiceSchema();
    const r = await db.execute(sql`
      SELECT purchase_request_id FROM invoices
       WHERE direction = 'payable' AND status <> 'void' AND purchase_request_id IS NOT NULL
       LIMIT 500`);
    for (const row of rows(r)) if (row?.purchase_request_id) out.add(String(row.purchase_request_id));
  } catch (e: any) {
    logFail('billedPurchaseRequestIds', e);
  }
  return out;
}

export interface InvoiceSummary {
  receivableOpen: number;
  /** Outstanding in DEFAULT_CURRENCY only. See `outstandingOtherCurrencies`. */
  receivableOutstanding: number;
  receivableOverdue: number;
  payableOpen: number;
  /** Outstanding in DEFAULT_CURRENCY only. See `outstandingOtherCurrencies`. */
  payableOutstanding: number;
  awaitingPayApproval: number;
  /**
   * Outstanding money held in any OTHER currency, one entry per currency and never added in.
   *
   * A screen showing the two scalars above MUST show this too when it is non-empty, or the number it
   * prints is smaller than what is actually owed and nothing says so.
   */
  outstandingOtherCurrencies: Array<{ currency: string; receivable: number; payable: number }>;
  /** True when a count could not be read. A screen must say so rather than render a confident 0. */
  degraded: boolean;
}

/**
 * THE FINANCE CONSOLE'S HEADLINE FIGURES — one currency at a time.
 *
 * WHAT THIS USED TO DO. `SUM(total - paid)` ran across EVERY live invoice regardless of
 * invoices.currency, and the console printed the result with formatAmount(..., DEFAULT_CURRENCY). So
 * a receivable of USD 40,000 and one of INR 40,000 were reported as "₹80,000 outstanding" — a sum of
 * dollars and rupees, labelled rupees, on the screen a founder reads to decide whether the company
 * can make payroll. There is no exchange rate anywhere in this codebase, so there was no arithmetic
 * that could have made that number mean anything.
 *
 * The scalars are now DEFAULT_CURRENCY only, and anything else is returned beside them rather than
 * folded in or dropped.
 */
export async function invoiceSummary(): Promise<InvoiceSummary> {
  const empty: InvoiceSummary = {
    receivableOpen: 0, receivableOutstanding: 0, receivableOverdue: 0,
    payableOpen: 0, payableOutstanding: 0, awaitingPayApproval: 0,
    outstandingOtherCurrencies: [], degraded: true,
  };
  try {
    await ensureInvoiceSchema();
    // OVERDUE IS DECIDED IN THE SAME ZONE ON THIS TILE AS IT IS ON THE INVOICE ITSELF.
    //
    // This filter was `due_date < CURRENT_DATE`, which is the DATABASE session's date — UTC. Every
    // other overdue judgement in this module goes through displayStatus(), which compares against
    // civilDate() in Asia/Kolkata precisely because the server is UTC and the readers are IST. For
    // the first five and a half hours of every IST day the two disagreed: the list showed an invoice
    // badged "overdue" that the summary tile above it did not count, and the count on the dashboard
    // was one or more short of the rows a reader could see for themselves. A number that contradicts
    // the list beside it is worse than no number, because it is the one somebody quotes.
    const todayCivil = civilDate(new Date());
    // Counts stay across all currencies — "how many bills are open" is a count of documents and does
    // not depend on what they are denominated in. Only the MONEY is separated.
    const byCurrency = rows(await db.execute(sql`
      WITH paid AS (
        SELECT invoice_id, COALESCE(SUM(amount), 0) AS p
          FROM invoice_payments GROUP BY invoice_id
      ), live AS (
        SELECT i.id, i.direction, i.total, i.due_date,
               COALESCE(NULLIF(UPPER(i.currency), ''), ${DEFAULT_CURRENCY}) AS cur,
               COALESCE(paid.p, 0) AS paid
          FROM invoices i
          LEFT JOIN paid ON paid.invoice_id = i.id
         WHERE i.status <> 'void' AND i.status <> 'draft'
      )
      SELECT
        cur,
        COUNT(*) FILTER (WHERE direction = 'receivable' AND paid < total)::int AS r_open,
        COALESCE(SUM(total - paid) FILTER (WHERE direction = 'receivable' AND paid < total), 0) AS r_out,
        COUNT(*) FILTER (WHERE direction = 'receivable' AND paid < total AND due_date IS NOT NULL AND due_date < ${todayCivil}::date)::int AS r_over,
        COUNT(*) FILTER (WHERE direction = 'payable' AND paid < total)::int AS p_open,
        COALESCE(SUM(total - paid) FILTER (WHERE direction = 'payable' AND paid < total), 0) AS p_out
      FROM live
      GROUP BY cur`));

    const r: Record<string, number> = {
      r_open: 0, r_out: 0, r_over: 0, p_open: 0, p_out: 0,
    };
    const outstandingOtherCurrencies: Array<{ currency: string; receivable: number; payable: number }> = [];
    for (const row of byCurrency) {
      const cur = String(row.cur || DEFAULT_CURRENCY).toUpperCase();
      // Counts are currency-independent and are added up across all of them.
      r.r_open += Number(row.r_open) || 0;
      r.r_over += Number(row.r_over) || 0;
      r.p_open += Number(row.p_open) || 0;
      const receivable = numeric(row.r_out);
      const payable = numeric(row.p_out);
      if (cur === DEFAULT_CURRENCY) {
        r.r_out = receivable;
        r.p_out = payable;
      } else if (receivable !== 0 || payable !== 0) {
        outstandingOtherCurrencies.push({ currency: cur, receivable, payable });
      }
    }

    let awaiting = 0;
    try {
      const a = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n
          FROM workflow_instances
         WHERE domain = ${PAYABLE_APPROVAL_DOMAIN}
           AND record_id LIKE ${PAYABLE_RECORD_PREFIX + '%'}
           AND state = 'pending'`))[0];
      awaiting = Number(a?.n || 0);
    } catch (e: any) {
      // The workflow tables may not exist on a database nobody has routed anything through yet.
      logFail('invoiceSummary.awaiting', e);
    }

    return {
      receivableOpen: Number(r.r_open || 0),
      receivableOutstanding: Number(r.r_out || 0),
      receivableOverdue: Number(r.r_over || 0),
      payableOpen: Number(r.p_open || 0),
      payableOutstanding: Number(r.p_out || 0),
      awaitingPayApproval: awaiting,
      outstandingOtherCurrencies,
      degraded: false,
    };
  } catch (e: any) {
    logFail('invoiceSummary', e);
    return empty;
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES — CREATION
// -------------------------------------------------------------------------------------------------

export interface ReceivableInput {
  seriesId?: string | null;
  partyKind?: string | null;
  partyName?: string | null;
  partyEmail?: string | null;
  partyAddress?: string | null;
  partyTaxReference?: string | null;
  partyReference?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  terms?: string | null;
}

export interface PayableInput {
  seriesId?: string | null;
  vendorId?: string | null;
  /** Free text when the supplier is not in the vendor list yet. */
  vendorName?: string | null;
  purchaseRequestId?: string | null;
  purchaseOrderId?: string | null;
  vendorInvoiceRef?: string | null;
  /** When the money is being paid to somebody on the payroll, their hr_employees.id. */
  payeeEmployeeId?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  attachmentUrl?: string | null;
  notes?: string | null;
}

/**
 * THE ONE PLACE AN INVOICE NUMBER IS ISSUED.
 *
 * The counter bump and the insert are a SINGLE STATEMENT: the UPDATE ... RETURNING is a CTE the
 * INSERT selects from, which holds a row lock on the series for the length of the statement. Two
 * simultaneous creates therefore serialise on that row and take consecutive numbers. There is no
 * SELECT max() anywhere in this file, because that shape hands two people the same number and the
 * loser discovers it as a constraint violation on a screen that said the invoice was created.
 *
 * A series that does not exist, or is inactive, produces ZERO rows from the CTE and therefore zero
 * inserted rows — reported as a refusal, never as a silent success.
 */
async function createInvoice(
  direction: InvoiceDirection,
  seriesId: string | null,
  columns: Record<string, unknown>,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  let series = seriesId;
  if (!isUuid(series)) {
    const list = (await listSeries(direction)).filter((s) => s.isActive);
    if (!list.length) {
      return {
        ok: false,
        error: 'There is no active numbering series for this kind of invoice, so no number can be '
          + 'issued. Add one on the numbering screen first.',
      };
    }
    series = list[0].id;
  }

  const currency = String(columns.currency || DEFAULT_CURRENCY).slice(0, 8);
  // THE ISSUE DATE IS A CIVIL DATE, in the same zone displayStatus() compares the due date against.
  // This was `new Date().toISOString().slice(0,10)` — the UTC day — so an invoice raised between 00:00
  // and 05:29 IST was dated YESTERDAY: on the wrong side of a month end for the first five and a half
  // hours of the 1st, and one day out of step with the overdue derivation for the rest of the year.
  const issueDate = isoDate(columns.issueDate) || civilDate(new Date());
  const dueDate = isoDate(columns.dueDate);

  try {
    const ins = rows(await db.execute(sql`
      WITH s AS (
        UPDATE invoice_series
           SET next_number = next_number + 1, updated_at = NOW()
         WHERE id = ${series}::uuid AND is_active = true
        RETURNING id, prefix, pad, next_number - 1 AS issued
      )
      INSERT INTO invoices (
        direction, series_id, invoice_number, status, currency, issue_date, due_date,
        party_kind, party_name, party_email, party_address, party_tax_reference, party_reference,
        vendor_id, purchase_request_id, purchase_order_id, vendor_invoice_ref, payee_employee_id,
        attachment_url, notes, terms, created_by)
      SELECT ${direction}::text, s.id, s.prefix || lpad(s.issued::text, s.pad, '0'), 'draft'::text,
             ${currency}::text, ${issueDate}::date, ${dueDate}::date,
             ${(columns.partyKind as string) || null}::text, ${(columns.partyName as string) || null}::text,
             ${(columns.partyEmail as string) || null}::text, ${(columns.partyAddress as string) || null}::text,
             ${(columns.partyTaxReference as string) || null}::text, ${(columns.partyReference as string) || null}::text,
             ${(columns.vendorId as string) || null}::uuid, ${(columns.purchaseRequestId as string) || null}::uuid,
             ${(columns.purchaseOrderId as string) || null}::uuid, ${(columns.vendorInvoiceRef as string) || null}::text,
             ${(columns.payeeEmployeeId as string) || null}::uuid, ${(columns.attachmentUrl as string) || null}::text,
             ${(columns.notes as string) || null}::text, ${(columns.terms as string) || null}::text,
             ${isUuid(actorUserId) ? actorUserId : null}::uuid
        FROM s
      RETURNING id, invoice_number`));

    if (!ins.length) {
      return {
        ok: false,
        error: 'That numbering series is not available or has been retired, so no number could be '
          + 'issued and nothing was created. Pick an active series.',
      };
    }
    const id = String(ins[0].id);
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.create', entity: 'invoice', entityId: id,
      diff: {
        direction,
        invoiceNumber: String(ins[0].invoice_number),
        seriesId: series,
        currency,
        issueDate,
        dueDate,
        vendorId: columns.vendorId || null,
        purchaseRequestId: columns.purchaseRequestId || null,
        partyName: columns.partyName || null,
      },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('createInvoice', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** WE BILL SOMEBODY. Lines are added afterwards; a receivable is created empty and priced on its own
 *  screen, because pricing is where the care goes and a one-shot form invites a wrong total. */
export async function createReceivable(input: ReceivableInput, actorUserId: string | null): Promise<WriteResult> {
  const partyName = text(input?.partyName, 200);
  if (!partyName) return { ok: false, error: 'Say who is being billed. An invoice with no addressee cannot be sent.' };
  const partyKind = (PARTY_KINDS as readonly string[]).indexOf(String(input?.partyKind)) >= 0
    ? String(input?.partyKind) : 'client';
  return createInvoice('receivable', isUuid(input?.seriesId) ? String(input?.seriesId) : null, {
    partyKind,
    partyName,
    partyEmail: text(input?.partyEmail, 200),
    partyAddress: text(input?.partyAddress, MAX_TEXT),
    partyTaxReference: text(input?.partyTaxReference, 60),
    partyReference: text(input?.partyReference, 120),
    currency: text(input?.currency, 8) || DEFAULT_CURRENCY,
    issueDate: input?.issueDate,
    dueDate: input?.dueDate,
    notes: text(input?.notes, MAX_TEXT),
    terms: text(input?.terms, MAX_TEXT),
  }, actorUserId);
}

/**
 * SOMEBODY BILLS US.
 *
 * THE LINK TO PROCUREMENT IS THE POINT. When a purchase request id is given, this reads that request
 * from src/lib/procurement.ts, checks with the WORKFLOW ENGINE that it was actually approved, and
 * carries its vendor and amount across — so an approved purchase becomes the payable rather than an
 * unrelated second record somebody has to reconcile by hand. A payable against a request that is not
 * approved is refused: paying for something nobody approved is the whole failure this links prevent.
 *
 * A payable WITHOUT a purchase request is still allowed, because bills arrive that nobody raised a
 * request for. It gets no free pass at payment time — it still has to clear the pay approval.
 */
export async function createPayable(input: PayableInput, actorUserId: string | null): Promise<WriteResult> {
  const requestId = isUuid(input?.purchaseRequestId) ? String(input?.purchaseRequestId) : null;
  let vendorId = isUuid(input?.vendorId) ? String(input?.vendorId) : null;
  let seedLine: { description: string; quantity: number; rate: number; currency: string } | null = null;

  if (requestId) {
    try {
      const { getRequest, getOrderForRequest } = await import('@/lib/procurement');
      const request = await getRequest(requestId);
      if (!request) return { ok: false, error: 'That purchase request is not available.' };
      const instance = await instanceForRecord('procurement', requestId);
      const live = instance ? await getInstance(instance.id) : null;
      if (!live || live.state !== 'approved') {
        return {
          ok: false,
          error: 'That purchase request is not approved. It is currently "'
            + (live?.state || instance?.state || 'not sent for approval')
            + '", and a bill cannot be recorded against a purchase nobody approved.',
        };
      }
      if (!vendorId) vendorId = request.vendorId;
      const order = await getOrderForRequest(requestId);
      const amount = order?.amount ?? request.estimatedCost;
      if (amount !== null && amount !== undefined) {
        seedLine = {
          description: request.item + (request.quantity > 1 ? ' (x' + request.quantity + ')' : ''),
          quantity: 1,
          rate: Number(amount),
          currency: order?.currency || request.currency,
        };
      }
    } catch (e: any) {
      logFail('createPayable.procurement', e);
      return { ok: false, error: 'The purchasing record could not be read just now, so nothing was created. Try again in a moment.' };
    }
  }

  const vendorName = text(input?.vendorName, 200);
  if (!requestId && !vendorId && !vendorName) {
    return { ok: false, error: 'Say who is billing us — pick a vendor, or type the supplier name.' };
  }

  const created = await createInvoice('payable', isUuid(input?.seriesId) ? String(input?.seriesId) : null, {
    vendorId,
    purchaseRequestId: requestId,
    purchaseOrderId: isUuid(input?.purchaseOrderId) ? String(input?.purchaseOrderId) : null,
    vendorInvoiceRef: text(input?.vendorInvoiceRef, 120),
    payeeEmployeeId: isUuid(input?.payeeEmployeeId) ? String(input?.payeeEmployeeId) : null,
    partyName: vendorName,
    currency: text(input?.currency, 8) || seedLine?.currency || DEFAULT_CURRENCY,
    issueDate: input?.issueDate,
    dueDate: input?.dueDate,
    attachmentUrl: normaliseLink(input?.attachmentUrl),
    notes: text(input?.notes, MAX_TEXT),
  }, actorUserId);

  if (created.ok && created.id && seedLine) {
    // The approved amount, carried across as the first line so the payable starts from what was
    // approved rather than from an empty document somebody retypes. It is an ORDINARY line: editable,
    // removable, and recomputed like any other.
    const line = await addLine(created.id, {
      description: seedLine.description,
      quantity: seedLine.quantity,
      rate: seedLine.rate,
    }, actorUserId);
    if (!line.ok) {
      // The invoice exists and its first line does not. Say so — a total of zero on a bill somebody
      // then submits for approval is exactly the silent wrong number this module must not produce.
      return {
        ok: true,
        id: created.id,
        changed: true,
        warning: 'The invoice was created, but the approved amount could not be added as a line. Add it before sending it for approval.',
      };
    }
  }
  return created;
}

// -------------------------------------------------------------------------------------------------
// WRITES — LINES, TAX, TOTALS
// -------------------------------------------------------------------------------------------------

/**
 * THE ONLY WRITER OF subtotal, tax_total AND total.
 *
 * Every path that changes a line or a tax line calls this, and nothing else ever sets those columns.
 * One writer per fact is why the printed document and the list can never disagree about what an
 * invoice is worth.
 *
 * Tax is computed on the SUBTOTAL, from the values stored on the invoice's own tax lines — the
 * snapshot taken when they were applied, not today's catalogue.
 */
async function recalcTotals(invoiceId: string): Promise<{ subtotal: number; taxTotal: number; total: number } | null> {
  try {
    // THE ::float CAST IS GONE. invoice_lines.amount is NUMERIC(14,2) and postgres-js hands NUMERIC
    // back as a STRING precisely so no precision is lost; casting to float in SQL threw that away
    // before JavaScript saw it, and this figure is then WRITTEN BACK to invoices.subtotal.
    const sub = rows(await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid`))[0];
    const subtotal = numeric(sub?.s);

    // ---- THE TAX TOTAL EQUALS THE TAX LINES THE DOCUMENT PRINTS -----------------------------------
    //
    // Each component's amount is still rounded — it has to be, because it is PRINTED as its own line
    // on the invoice and stored in a NUMERIC(14,2) column. What changed is the summing: it was
    // `taxTotal = money(taxTotal + amount)` folded through a rounding step on every iteration, and
    // the total is now added in integer paise from the rounded line amounts.
    //
    // The identity that must hold on an issued document is TAX TOTAL == SUM OF THE PRINTED TAX LINES,
    // and it now does by construction. Note what this deliberately does NOT do: on a subtotal of
    // 1,000.05 with CGST 9% and SGST 9%, each line rounds to 90.00 and the total is 180.00, where
    // 18% of 1,000.05 is 180.009. The document is internally consistent — 90.00 + 90.00 = 180.00 —
    // which is the property a counterparty can actually check, and it is the same answer any invoice
    // that prints its components separately has to give. Making the total 180.01 instead would leave
    // a document whose own two lines do not add up to it.
    const taxes = rows(await db.execute(sql`
      SELECT id, basis, value FROM invoice_tax_lines WHERE invoice_id = ${invoiceId}::uuid`));
    const taxAmounts: number[] = [];
    for (const t of taxes) {
      const value = Number(t.value) || 0;
      const amount = String(t.basis) === 'fixed' ? money(value) : money((subtotal * value) / 100);
      taxAmounts.push(amount);
      await db.execute(sql`UPDATE invoice_tax_lines SET amount = ${amount} WHERE id = ${String(t.id)}::uuid`);
    }
    const taxTotal = sumMoney(taxAmounts);

    const total = sumMoney([subtotal, taxTotal]);
    await db.execute(sql`
      UPDATE invoices SET subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${total}, updated_at = NOW()
       WHERE id = ${invoiceId}::uuid`);
    return { subtotal, taxTotal, total };
  } catch (e: any) {
    logFail('recalcTotals', e);
    return null;
  }
}

export interface LineInput {
  description?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  rate?: number | string | null;
}

/** Lines may only be changed while the invoice is a DRAFT. Once it has been sent to a client or put
 *  into pay approval, editing what it says behind their backs is not an edit, it is a different
 *  document — the same rule procurement.ts states for a submitted request. */
async function requireDraft(invoiceId: string): Promise<{ invoice: Invoice | null; error: string | null }> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { invoice: null, error: NOT_AVAILABLE };
  if (invoice.status === 'void') return { invoice, error: 'That invoice is void. A void record is not edited.' };
  if (invoice.status !== 'draft') {
    return {
      invoice,
      error: 'This invoice has already been ' + statusLabel(invoice.direction, invoice.status).toLowerCase()
        + ', so its lines cannot be changed. Void it and raise a corrected one.',
    };
  }
  return { invoice, error: null };
}

export async function addLine(invoiceId: string, input: LineInput, actorUserId: string | null): Promise<WriteResult> {
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };
  const description = text(input?.description, MAX_LINE);
  const quantity = num(input?.quantity);
  const rate = num(input?.rate);
  if (!description) return { ok: false, error: 'Describe what is being charged for.' };
  if (quantity === null || quantity <= 0) return { ok: false, error: 'Give the line a quantity above zero.' };
  if (rate === null) return { ok: false, error: 'Give the line a rate.' };
  if (rate < 0) return { ok: false, error: 'A rate cannot be negative. Record a credit as its own invoice.' };

  const gate = await requireDraft(invoiceId);
  if (gate.error) return { ok: false, error: gate.error };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  const amount = money(quantity * rate);
  try {
    const pos = rows(await db.execute(sql`
      SELECT COALESCE(MAX(position), 0) + 1 AS n FROM invoice_lines WHERE invoice_id = ${invoiceId}::uuid`))[0];
    const ins = rows(await db.execute(sql`
      INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit, rate, amount)
      VALUES (${invoiceId}::uuid, ${Number(pos?.n) || 1}, ${description}, ${quantity},
              ${text(input?.unit, 40)}, ${rate}, ${amount})
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const totals = await recalcTotals(invoiceId);
    if (!totals) {
      return { ok: true, id: String(ins[0].id), changed: true,
        warning: 'The line was added but the invoice total could not be recalculated. Reload before sending it.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.line.add', entity: 'invoice', entityId: invoiceId,
      diff: { lineId: String(ins[0].id), description, quantity, rate, amount, total: totals.total },
    });
    return { ok: true, id: String(ins[0].id), changed: true };
  } catch (e: any) {
    logFail('addLine', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Remove a line from a DRAFT. A line on a draft is a working note, not a record — the invoice itself
 *  is the record, and that is what is voided rather than deleted. */
export async function removeLine(invoiceId: string, lineId: string, actorUserId: string | null): Promise<WriteResult> {
  if (!isUuid(invoiceId) || !isUuid(lineId)) return { ok: false, error: NOT_AVAILABLE };
  const gate = await requireDraft(invoiceId);
  if (gate.error) return { ok: false, error: gate.error };
  try {
    const gone = rows(await db.execute(sql`
      DELETE FROM invoice_lines WHERE id = ${lineId}::uuid AND invoice_id = ${invoiceId}::uuid
      RETURNING id, description, amount`));
    if (!gone.length) return { ok: true, changed: false };
    const totals = await recalcTotals(invoiceId);
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.line.remove', entity: 'invoice', entityId: invoiceId,
      diff: { lineId, description: String(gone[0].description), amount: Number(gone[0].amount), total: totals?.total ?? null },
    });
    return { ok: true, changed: true };
  } catch (e: any) {
    logFail('removeLine', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Apply a set of tax components to a DRAFT, replacing whatever was applied before.
 *
 * The label, basis and value are COPIED onto the invoice. An administrator who changes a rate next
 * quarter changes what NEW invoices carry and nothing about what this one said.
 */
export async function applyTaxComponents(
  invoiceId: string,
  codes: string[],
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };
  const gate = await requireDraft(invoiceId);
  if (gate.error) return { ok: false, error: gate.error };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  const wanted = Array.from(new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))).slice(0, 20);
  try {
    const catalogue = await listTaxComponents(false);
    const chosen = catalogue.filter((c) => wanted.indexOf(c.code) >= 0);
    if (wanted.length && !chosen.length) {
      return { ok: false, error: 'None of those tax components exist or are active any more.' };
    }
    // THE OLD LINES AND THE NEW ONES ARE ONE TRANSACTION. Replacing a set with DELETE followed by a
    // loop of INSERTs is only safe if the two cannot be separated, and they were separated by nothing
    // at all: a connection drop or a function timeout between them left the invoice with ZERO or with
    // PARTIAL tax lines while invoices.tax_total and invoices.total still carried the tax the deleted
    // lines had produced. The error returned was the generic WRITE_FAILED, which does not mention that
    // the previous tax lines no longer exist — so finance reopened the draft, saw an empty tax section
    // beside a total that still included GST, and had nothing telling them which was right.
    //
    // Two people applying components at once had the matching problem: both deleted, both inserted,
    // recalcTotals summed every row it found, and the client invoice charged 36% where the components
    // said 18%. Inside one transaction the second writer waits for the first to commit and then
    // replaces its rows wholesale, so the last edit wins entirely and never merges with the other.
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`DELETE FROM invoice_tax_lines WHERE invoice_id = ${invoiceId}::uuid`);
      let position = 1;
      for (const c of chosen) {
        await tx.execute(sql`
          INSERT INTO invoice_tax_lines (invoice_id, component_id, code, label, basis, value, amount, position)
          VALUES (${invoiceId}::uuid, ${c.id}::uuid, ${c.code}, ${c.label}, ${c.basis}, ${c.value}, 0, ${position})`);
        position += 1;
      }
    });

    // recalcTotals() runs after the commit and owns its own error handling — it returns null rather
    // than throwing. That null was previously folded into the audit diff and reported as a plain
    // success, so an invoice whose tax lines were replaced but whose stored total was NOT recomputed
    // read exactly like one that was. The lines are right and the total is stale; the draft is
    // recoverable by pressing Apply again, and the person is told that rather than left to find it
    // when the invoice is issued.
    const totals = await recalcTotals(invoiceId);
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.tax.apply', entity: 'invoice', entityId: invoiceId,
      diff: { codes: chosen.map((c) => c.code), taxTotal: totals?.taxTotal ?? null, total: totals?.total ?? null },
    });
    if (!totals) {
      return {
        ok: true, id: invoiceId, changed: true,
        warning: 'The tax components were applied, but the invoice total could not be recalculated, so '
          + 'the total shown is the one from before this change. Apply them again before issuing this '
          + 'invoice.',
      };
    }
    return { ok: true, id: invoiceId, changed: true };
  } catch (e: any) {
    logFail('applyTaxComponents', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// WRITES — ISSUING, APPROVING, PAYING, VOIDING
// -------------------------------------------------------------------------------------------------

/**
 * ISSUE A RECEIVABLE. The moment it stops being ours to edit.
 *
 * NOT A CLAIM THAT AN EMAIL WAS SENT. This module does not send anything: it records that the invoice
 * was issued on a date, and the printable document is what somebody sends. Saying "sent" while
 * nothing left the building is exactly the kind of reported-success this project has been bitten by.
 */
export async function sendReceivable(invoiceId: string, actorUserId: string | null): Promise<WriteResult> {
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { ok: false, error: NOT_AVAILABLE };
  if (invoice.direction !== 'receivable') {
    return { ok: false, error: 'That is a bill somebody sent us. It is not ours to issue.' };
  }
  const gate = canTransition('receivable', invoice.status, 'sent');
  if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

  const lines = await invoiceLines(invoiceId);
  if (!lines.length) return { ok: false, error: 'Add at least one line before issuing this invoice.' };
  if (!(invoice.total > 0)) return { ok: false, error: 'This invoice totals nothing. Check the lines before issuing it.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE invoices SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
       WHERE id = ${invoiceId}::uuid AND status = 'draft'
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That invoice changed while this page was open. Reload it and try again.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.send', entity: 'invoice', entityId: invoiceId,
      diff: { invoiceNumber: invoice.invoiceNumber, total: invoice.total, currency: invoice.currency, party: invoice.partyName },
    });
    return { ok: true, id: invoiceId, changed: true };
  } catch (e: any) {
    logFail('sendReceivable', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * SEND A PAYABLE INTO PAY APPROVAL.
 *
 * THE ROUTING IS THE ENGINE'S AND THE AUTHORIZATION IS THE REGISTRY'S. Every rung is resolved per row
 * from the Organization Graph for the SUBJECT EMPLOYEE, and when a required rung names nobody the
 * engine halts the request with a readable sentence. This function never approves anything, never
 * falls back to a role, and never resolves an approver itself.
 *
 * THE SUBJECT, AND WHY IT MATTERS. The graph is keyed on hr_employees.id, so a payable must name an
 * employee to be routed FROM:
 *   1. the employee who raised the linked purchase request — the right answer whenever there is one,
 *      because the bill is that person's purchase and it climbs their chain;
 *   2. otherwise the employee record of whoever is submitting it.
 * When neither exists this REFUSES with a sentence rather than routing from nobody. A bill with no
 * subject cannot be routed, and approving it by default is the failure this whole layer prevents.
 *
 * THE AMOUNT IS PASSED THROUGH, and that matters more than it looks: the engine decides whether the
 * executive rung applies by comparing the amount against the chain's own threshold. An amount that
 * never reaches the engine is a finance approval that silently never happens.
 */
export async function submitPayableForPayment(invoiceId: string, actorUserId: string): Promise<WriteResult> {
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to send this for approval.' };

  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { ok: false, error: NOT_AVAILABLE };
  if (invoice.direction !== 'payable') {
    return { ok: false, error: 'Only a bill somebody sent us goes into payment approval.' };
  }
  const gate = canTransition('payable', invoice.status, 'submitted');
  if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };
  if (!(invoice.total > 0)) {
    return { ok: false, error: 'This bill totals nothing. Add what is being charged before asking anybody to approve paying it.' };
  }

  // WHO THE CHAIN IS ROUTED FROM. Read the docblock above before changing the order of these two.
  let subjectEmployeeId: string | null = null;
  try {
    if (invoice.purchaseRequestId) {
      const { getRequest } = await import('@/lib/procurement');
      const request = await getRequest(invoice.purchaseRequestId);
      subjectEmployeeId = request?.requesterEmployeeId || null;
    }
    if (!subjectEmployeeId) {
      const { employeeIdForUser } = await import('@/lib/org-graph');
      subjectEmployeeId = await employeeIdForUser(actorUserId);
    }
  } catch (e: any) {
    logFail('submitPayableForPayment.subject', e);
    return { ok: false, error: 'The organization record could not be read just now, so nothing was sent. Try again in a moment.' };
  }

  if (!subjectEmployeeId) {
    return {
      ok: false,
      error: 'This bill is not linked to an employee record — neither through a purchase request nor '
        + 'through your own sign-in — so there is nobody in the organization graph to route it from. '
        + 'Link it to the purchase request it came from, or ask HR to link your employee record to '
        + 'this sign-in. Nothing is approved by default.',
    };
  }

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  const recordId = payableRecordId(invoiceId);
  if (!recordId) return { ok: false, error: NOT_AVAILABLE };

  try {
    const who = invoice.vendorName || invoice.partyName || invoice.payeeName || 'supplier';
    const summary = 'Invoice payment ' + invoice.invoiceNumber + ' - ' + who + ' - '
      + formatAmount(invoice.total, invoice.currency);

    const started = await startWorkflow({
      domain: PAYABLE_APPROVAL_DOMAIN,
      recordId,
      subjectEmployeeId,
      requestedByUserId: actorUserId,
      summary,
      amount: invoice.total,
      currency: invoice.currency,
      createdByUserId: actorUserId,
    });

    if (!started.ok) {
      // The engine refused outright. The bill stays a draft — reporting success on a payment nobody
      // was asked about is exactly the silent failure this module exists to avoid.
      return { ok: false, error: started.error || 'Could not send that for approval.' };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE invoices SET status = 'submitted', submitted_at = COALESCE(submitted_at, NOW()), updated_at = NOW()
       WHERE id = ${invoiceId}::uuid AND status = 'draft'
      RETURNING id`));

    await logAudit({
      userId: actorUserId,
      action: 'invoice.payable.submit', entity: 'invoice', entityId: invoiceId,
      diff: {
        invoiceNumber: invoice.invoiceNumber,
        instanceId: started.instanceId || null,
        state: started.state || null,
        haltReason: started.haltReason || null,
        amount: invoice.total,
        subjectEmployeeId,
      },
    });

    return {
      ok: true,
      id: invoiceId,
      changed: wrote.length > 0 && started.changed !== false,
      haltReason: started.haltReason ?? null,
    };
  } catch (e: any) {
    logFail('submitPayableForPayment', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface PaymentInput {
  invoiceId: string;
  amount?: number | string | null;
  paidOn?: string | null;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
}

/**
 * RECORD MONEY THAT MOVED. One row per movement, so a part payment is representable and nothing is
 * overwritten.
 *
 * FOR A PAYABLE THE APPROVAL IS READ FROM THE ENGINE, AT THE MOMENT OF THE WRITE — not from a column
 * here and not from what the screen showed when the button was rendered. Anything other than state
 * 'approved' refuses with the state's own name. A payment recorded against a bill that was rejected
 * while the tab was open is real money spent on something nobody approved, and asking at the write
 * rather than at the render is the only defence against it.
 *
 * FOR A RECEIVABLE there is no approval: the client paying us is a fact somebody records, not a
 * decision anybody makes.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST BRING ONE. /admin/finance/invoices gates this on
 * `invoices.pay`; a new caller gets no gate from this function.
 */
export async function recordPayment(input: PaymentInput, actorUserId: string | null): Promise<WriteResult> {
  const invoiceId = String(input?.invoiceId || '').trim();
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };

  const amount = num(input?.amount);
  if (amount === null || !(amount > 0)) return { ok: false, error: 'Enter the amount that moved.' };

  const view = await viewInvoice(invoiceId);
  if (!view) return { ok: false, error: NOT_AVAILABLE };
  const invoice = view.invoice;

  if (invoice.status === 'void') return { ok: false, error: 'That invoice is void. Nothing is paid against it.' };
  if (invoice.status === 'draft') {
    return {
      ok: false,
      error: invoice.direction === 'receivable'
        ? 'This invoice has not been issued yet, so there is nothing for anybody to have paid.'
        : 'This bill has not been sent for payment approval yet.',
    };
  }
  if (money(amount) > view.balance) {
    return {
      ok: false,
      error: 'That is more than the ' + formatAmount(view.balance, invoice.currency) + ' still outstanding. '
        + 'Record what actually moved; an overpayment is its own record, not a bigger number on this one.',
    };
  }

  if (invoice.direction === 'payable') {
    const instance = view.instance;
    if (!instance) {
      return { ok: false, error: 'This bill has not been sent for payment approval, so there is no approval to pay against.' };
    }
    const live = await getInstance(instance.id);
    if (!live || live.state !== 'approved') {
      return {
        ok: false,
        error: 'The payment approval for this bill is "' + (live?.state || instance.state) + '", not approved. '
          + (live?.haltReason ? live.haltReason + ' ' : '')
          + 'Nothing may be paid against it until it is approved by the people it was routed to.',
      };
    }
  }

  const method = (PAYMENT_METHODS as readonly string[]).indexOf(String(input?.method)) >= 0
    ? String(input?.method) as PaymentMethod : 'bank';

  // THE WALLET IS THE EMPLOYEE LEDGER AND NOTHING ELSE. Settling a bill into a wallet is only
  // meaningful when the payee IS an employee, so this refuses rather than inventing a destination.
  if (method === 'wallet') {
    if (invoice.direction !== 'payable') {
      return { ok: false, error: 'A client paying us does not move money through an employee wallet.' };
    }
    if (!invoice.payeeEmployeeId) {
      return {
        ok: false,
        error: 'This bill does not name an employee to pay, so there is no wallet to credit. Record the '
          + 'employee on the bill, or record the payment as a bank transfer.',
      };
    }
  }

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    // THE OUTSTANDING TEST IS REPEATED INSIDE THE INSERT.
    //
    // The check against view.balance a few lines up is a READ, and two payments recorded together —
    // two people on the same bill, one person double-submitting on a slow connection — both passed
    // it and both were written, so an invoice could carry more paid against it than it is worth. For
    // a payable settled into an employee wallet that is not just a wrong total: each row credits the
    // wallet under its own ref, so the second one pays somebody a second time.
    //
    // The sum below is computed in the same statement that writes the row, so the second attempt
    // sees the first payment already counted and inserts nothing.
    // THE SAME PAYMENT, RECORDED TWICE, IS RECORDED ONCE.
    //
    // The balance test below stops an OVERpayment. It does not stop a part payment being written
    // twice: 100,000 against a 400,000 balance passes on both submissions. The key is derived from
    // what the person entered — invoice, day, method, amount, reference — so a double-submitted form,
    // a retried POST and a browser refresh all produce the same key and the second write is refused
    // by the unique index rather than becoming a second payment. Two genuinely separate part payments
    // differ in at least one of those fields and are unaffected.
    // The civil day in the company's zone, not the server's UTC day — a payment entered at 00:30 IST
    // on the 1st was being dated the last day of the previous month, landing in the wrong month's
    // receipts and, for a receivable, on the wrong side of a period close.
    const paidOn = isoDate(input?.paidOn) || civilDate(new Date());
    const reference = text(input?.reference, 120);
    const idempotencyKey = [
      invoiceId, paidOn, method, money(amount).toFixed(2), reference || '',
    ].join('|').slice(0, 400);

    let ins: any[];
    try {
      ins = rows(await db.execute(sql`
        INSERT INTO invoice_payments (invoice_id, amount, currency, paid_on, method, reference, note, recorded_by, idempotency_key)
        SELECT ${invoiceId}::uuid, ${money(amount)}, ${invoice.currency},
               ${paidOn}::date,
               ${method}, ${reference}, ${text(input?.note, MAX_TEXT)},
               ${isUuid(actorUserId) ? actorUserId : null}::uuid, ${idempotencyKey}
          FROM invoices i
         WHERE i.id = ${invoiceId}::uuid
           AND i.status <> 'void'
           AND ${money(amount)} <= i.total - COALESCE(
                 (SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0)
        RETURNING id`));
    } catch (e: any) {
      const real = String(e?.cause?.message || e?.message || '');
      if (/duplicate key|unique constraint/i.test(real)) {
        // A RETRY IS A NO-OP, AND IT IS REPORTED AS ONE. The first submission landed; this one did
        // not write a second payment. Saying "already recorded" rather than "failed" is the whole
        // point — a user told the write failed records it again by hand.
        return {
          ok: false,
          error: 'That payment is already recorded — ' + formatAmount(money(amount), invoice.currency)
            + ' on ' + paidOn + (reference ? ' (' + reference + ')' : '')
            + '. Nothing was recorded a second time. Reload the invoice to see it. If this really is a '
            + 'separate payment of the same amount on the same day, give it its own reference.',
        };
      }
      throw e;
    }
    if (!ins.length) {
      // NOT a database failure. Somebody recorded a payment against this invoice between the read
      // above and this write, and what is left no longer covers this amount.
      const fresh = await viewInvoice(invoiceId);
      return {
        ok: false,
        error: 'Nothing was recorded. Another payment was entered against this invoice a moment ago, '
          + 'and only ' + formatAmount(fresh?.balance ?? 0, invoice.currency) + ' is still outstanding. '
          + 'Reload the invoice and record what is actually left.',
      };
    }
    const paymentId = String(ins[0].id);

    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.payment.record', entity: 'invoice', entityId: invoiceId,
      diff: {
        paymentId, amount: money(amount), currency: invoice.currency, method,
        invoiceNumber: invoice.invoiceNumber, direction: invoice.direction,
        balanceBefore: view.balance, instanceId: view.instance?.id || null,
      },
    });

    let warning: string | undefined;
    if (method === 'wallet' && invoice.payeeEmployeeId) {
      const credited = await creditEmployeeWallet(paymentId, invoice, money(amount));
      if (!credited) {
        warning = 'The payment was recorded, but the employee wallet could not be credited. The ledger '
          + 'has NOT been credited — use "Retry wallet credit" on the invoice once the cause is cleared.';
      }
    }

    await notifyPurchaseRequester(invoice, money(amount));
    return { ok: true, id: paymentId, changed: true, warning };
  } catch (e: any) {
    logFail('recordPayment', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Credit a payable settled into an employee wallet, through hr-wallet.ts credit().
 *
 * THE ONLY LEDGER IS hr_wallet_txn, and this module writes none of its own. The ref makes the credit
 * idempotent — a retry after a failure that actually landed does not pay anybody twice — and it is
 * checked before writing, exactly as src/lib/expenses.ts does for a reimbursed claim.
 *
 * RETURNS FALSE RATHER THAN THROWING, and the caller reports that in words. Marking a bill paid into
 * a wallet that was never credited would tell somebody they have money they cannot see.
 */
async function creditEmployeeWallet(paymentId: string, invoice: Invoice, amount: number): Promise<boolean> {
  const ref = 'invoice-payment:' + paymentId;
  const employeeId = invoice.payeeEmployeeId;
  if (!employeeId) return false;
  try {
    const dupe = rows(await db.execute(sql`SELECT id FROM hr_wallet_txn WHERE ref = ${ref} LIMIT 1`));
    if (dupe.length) {
      await db.execute(sql`
        UPDATE invoice_payments SET wallet_credited = TRUE, wallet_ref = ${ref} WHERE id = ${paymentId}::uuid`);
      return true;
    }
  } catch (e: any) {
    // The wallet schema may not be provisioned yet; credit() provisions it. Not fatal, and NOT to be
    // read as "already credited".
    logFail('creditEmployeeWallet.check', e);
  }
  try {
    const { credit } = await import('@/lib/hr-wallet');
    const res = await credit(
      employeeId,
      amount,
      'reimbursement',
      'Invoice ' + invoice.invoiceNumber + (invoice.vendorInvoiceRef ? ' (' + invoice.vendorInvoiceRef + ')' : ''),
      null,
      ref,
      // THE INVOICE'S OWN CURRENCY. It was not passed before, so the wallet row defaulted to INR and
      // a bill of USD 1,200 credited the employee 1,200 rupees.
      invoice.currency,
    );
    // credit() REFUSES WITHOUT THROWING, and this line ignored it. It answers `{ ok: false }` — not an
    // exception — for an amount that is not positive, so a payment row whose amount had come through
    // as zero or NaN was marked wallet_credited = TRUE with nothing in the ledger behind it. The
    // invoice then reads as settled into a wallet that was never credited, and "Retry wallet credit"
    // is switched off by the same flag, so there is no path back. A refusal is a failure here.
    if (!res?.ok) {
      console.error('[invoices] the wallet was NOT credited for payment', paymentId,
        '- employee', employeeId, '-', res?.error || 'the credit was refused');
      return false;
    }
    await db.execute(sql`
      UPDATE invoice_payments SET wallet_credited = TRUE, wallet_ref = ${ref} WHERE id = ${paymentId}::uuid`);
    await logAudit({
      userId: null, action: 'invoice.payment.wallet_credit', entity: 'invoice', entityId: invoice.id,
      diff: { paymentId, employeeId, amount, ref },
    });
    return true;
  } catch (e: any) {
    logFail('creditEmployeeWallet.credit', e);
    return false;
  }
}

/** Retry a wallet credit that failed. Idempotent through the same ref, so a retry after a credit that
 *  actually landed changes nothing rather than paying twice. */
export async function retryWalletCredit(paymentId: string, actorUserId: string | null): Promise<WriteResult> {
  if (!isUuid(paymentId)) return { ok: false, error: 'That payment is not available.' };
  try {
    const p = rows(await db.execute(sql`
      SELECT * FROM invoice_payments WHERE id = ${paymentId}::uuid LIMIT 1`))[0];
    if (!p) return { ok: false, error: 'That payment is not available.' };
    if (p.wallet_credited === true) return { ok: true, id: paymentId, changed: false };
    const invoice = await getInvoice(String(p.invoice_id));
    if (!invoice) return { ok: false, error: NOT_AVAILABLE };
    const ok = await creditEmployeeWallet(paymentId, invoice, Number(p.amount) || 0);
    if (!ok) {
      return { ok: false, error: 'The wallet still could not be credited. The cause is in the server log; nothing was changed.' };
    }
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.payment.wallet_retry', entity: 'invoice', entityId: invoice.id,
      diff: { paymentId, amount: Number(p.amount) || 0 },
    });
    return { ok: true, id: paymentId, changed: true };
  } catch (e: any) {
    logFail('retryWalletCredit', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * VOID AN INVOICE. There is no delete.
 *
 * A REASON IS REQUIRED, because "void" without one is indistinguishable from a mistake six months
 * later and the row exists precisely so somebody can read what happened. The number stays issued and
 * is never reused: a gap in a numbering series is a fact, and closing it by reissuing the number would
 * mean two different documents carried one identity.
 *
 * REFUSED ONCE MONEY HAS MOVED. An invoice with a payment recorded against it is the context for that
 * payment. Voiding it would leave a real movement of money pointing at a document that says it never
 * counted, so this refuses and says what to do instead.
 */
export async function voidInvoice(invoiceId: string, actorUserId: string | null, reason: string): Promise<WriteResult> {
  if (!isUuid(invoiceId)) return { ok: false, error: NOT_AVAILABLE };
  const why = text(reason, MAX_TEXT);
  if (!why || why.length < 4) {
    return { ok: false, error: 'Say why this invoice is being voided. The reason is the record.' };
  }
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { ok: false, error: NOT_AVAILABLE };

  const gate = canTransition(invoice.direction, invoice.status, 'void');
  if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

  const payments = await invoicePayments(invoiceId);
  if (payments.length) {
    return {
      ok: false,
      error: 'Money has already been recorded against this invoice, so it cannot be voided — the '
        + 'payment would be left pointing at a document that says it never counted. Raise a credit '
        + 'note as its own invoice instead.',
    };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    // "NO MONEY AGAINST IT" IS TESTED IN THE WRITE, NOT ONLY IN FRONT OF IT.
    //
    // The payments read above and this UPDATE are two separate statements, and recordPayment() tests
    // `status === 'void'` from ITS OWN read. Interleave the two and each guard checked the other's
    // precondition before the other's write landed: void reads zero payments, recordPayment reads
    // status 'sent' and inserts a payment, and this UPDATE still succeeds because the status has not
    // changed. What is left is exactly the state the refusal above exists to prevent — a void invoice
    // with money recorded against it — and where that payment was a payable settled with method
    // 'wallet', an employee has been credited against a bill the organisation now says never counted.
    // Nothing reconciles that afterwards: the invoice is excluded from every receivable and payable
    // figure, and the wallet credit is real.
    //
    // NOT EXISTS in the same statement closes it. The status guard stays — the two refuse different
    // things, and the caller is told which one happened.
    const wrote = rows(await db.execute(sql`
      UPDATE invoices
         SET status = 'void', void_reason = ${why}, voided_at = NOW(),
             voided_by = ${isUuid(actorUserId) ? actorUserId : null}::uuid, updated_at = NOW()
       WHERE id = ${invoiceId}::uuid AND status = ${invoice.status}
         AND NOT EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = invoices.id)
      RETURNING id`));
    if (!wrote.length) {
      // Two different refusals share this branch, so the reason is re-read rather than assumed.
      const since = await invoicePayments(invoiceId);
      if (since.length) {
        return {
          ok: false,
          error: 'A payment was recorded against this invoice while this page was open, so it was NOT '
            + 'voided. Voiding it now would leave that payment pointing at a document saying it never '
            + 'counted. Raise a credit note as its own invoice instead.',
        };
      }
      return { ok: false, error: 'That invoice changed while this page was open. Reload it and try again.' };
    }

    // WITHDRAW THE PAY APPROVAL TOO, through the engine's own cancelWorkflow — which checks who
    // raised it. Never blocking: the invoice IS void, and an approval left pending on a void bill is
    // visible and fixable, whereas refusing here would leave somebody unable to void at all.
    if (invoice.direction === 'payable' && invoice.status === 'submitted') {
      try {
        const { cancelWorkflow } = await import('@/lib/workflow');
        const instance = await payApprovalFor(invoice);
        if (instance && isUuid(actorUserId)) {
          await cancelWorkflow(instance.id, { id: actorUserId }, 'Invoice voided: ' + why.slice(0, MAX_LINE));
        }
      } catch (e: any) {
        logFail('voidInvoice.cancelWorkflow', e);
      }
    }

    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'invoice.void', entity: 'invoice', entityId: invoiceId,
      diff: {
        invoiceNumber: invoice.invoiceNumber, direction: invoice.direction,
        previousStatus: invoice.status, total: invoice.total, reason: why,
      },
    });
    return { ok: true, id: invoiceId, changed: true };
  } catch (e: any) {
    logFail('voidInvoice', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Tell the person who raised the purchase that their bill has been paid.
 *
 * THE EXISTING NOTIFIER, src/lib/push.ts sendPushToUser — it writes the in-app row AND sends the
 * browser push and de-duplicates identical messages inside two minutes. Nothing here writes to
 * `notifications` directly and there is no second notifier.
 *
 * NEVER BLOCKS THE WRITE IT ANNOUNCES. This is the one place in this file a caught error does not
 * fail the operation, and the reason is written here rather than assumed: a payment that happened and
 * was not announced is somebody refreshing a page; a payment refused because a push endpoint was
 * stale is money that did not move.
 */
async function notifyPurchaseRequester(invoice: Invoice, amount: number): Promise<void> {
  if (invoice.direction !== 'payable' || !invoice.purchaseRequestId) return;
  try {
    const { getRequest } = await import('@/lib/procurement');
    const request = await getRequest(invoice.purchaseRequestId);
    if (!request?.requesterUserId) return;
    const { sendPushToUser } = await import('@/lib/push');
    await sendPushToUser(request.requesterUserId, {
      type: 'invoice_paid',
      title: 'Payment recorded for ' + request.item,
      body: formatAmount(amount, invoice.currency) + ' recorded against invoice ' + invoice.invoiceNumber + '.',
      url: '/portal/employee/procurement',
      tag: 'invoice-' + invoice.id,
    });
  } catch (e: any) {
    logFail('notifyPurchaseRequester', e);
  }
}

// -------------------------------------------------------------------------------------------------
// THE PAY-APPROVAL CHAIN, READ FROM THE ENGINE
// -------------------------------------------------------------------------------------------------

export interface ChainRung {
  step: number;
  via: string;
  optional: boolean;
  minAmount: number | null;
  parallel: boolean;
}

/**
 * The chain a payable's payment approval walks, as the engine has it DECLARED.
 *
 * Derived, never restated. If workflow.ts changes the chain — a rung added, a threshold moved — every
 * screen here follows on the next submission with no edit, because the shape a person reads is the
 * shape the engine will use.
 */
export function payApprovalChain(): ChainRung[] {
  const def = domainDefinition(PAYABLE_APPROVAL_DOMAIN);
  const perStep = new Map<number, number>();
  for (const r of def.route) perStep.set(r.step, (perStep.get(r.step) || 0) + 1);
  return def.route.map((r) => ({
    step: r.step,
    via: String(r.via),
    // READ STRUCTURALLY, ON PURPOSE. Every route literal in src/lib/workflow.ts carries `optional`
    // and resolveRoute() reads it, but the RouteRule interface there does not yet declare it. This
    // module does not own that file, so the property is read through a structural type rather than by
    // editing a declaration another change is in the middle of. It compiles the same either way once
    // RouteRule declares it.
    optional: (r as { optional?: boolean }).optional === true,
    minAmount: typeof r.minAmount === 'number' ? r.minAmount : null,
    parallel: (perStep.get(r.step) || 1) > 1,
  }));
}

/** The amount at or above which a payment needs the executive rung, or null when there is none. */
export function payApprovalThreshold(): number | null {
  const withMin = payApprovalChain().filter((r) => r.minAmount !== null);
  if (withMin.length === 0) return null;
  return Math.min(...withMin.map((r) => r.minAmount as number));
}

// -------------------------------------------------------------------------------------------------
// THE PRINTABLE DOCUMENT — SERVER RENDERED, exactly as src/lib/hr-payslip.ts renders a payslip.
//
// No client PDF library, no fetch, no script beyond the print call: the document is HTML the server
// produced from the stored rows, so what is printed is what the database says and a browser with
// JavaScript disabled prints the same thing.
// -------------------------------------------------------------------------------------------------

/** Escape everything that reaches the document. Every field on it is free text somebody typed. */
function esc(v: any): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDateLong(d: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function qty(n: number): string {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * The invoice as a document.
 *
 * WHAT IT DOES NOT SAY: it makes no compliance claim, cites no statute, and prints a tax line with
 * the label an administrator typed and the rate they configured — nothing more. A VOID invoice prints
 * marked VOID with its reason, because the document exists to be read afterwards.
 */
export function renderInvoiceHtml(view: InvoiceView, opts: { autoPrint?: boolean; orgName?: string } = {}): string {
  const inv = view.invoice;
  const autoPrint = opts.autoPrint === true;
  const org = esc(opts.orgName || 'EduRankAI');
  const isReceivable = inv.direction === 'receivable';
  const cur = inv.currency;

  const counterparty = isReceivable
    ? (inv.partyName || 'Client')
    : (inv.vendorName || inv.partyName || inv.payeeName || 'Supplier');

  const lineRows = view.lines.map((l) => `
      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${esc(qty(l.quantity))}${l.unit ? ' ' + esc(l.unit) : ''}</td>
        <td class="num">${esc(formatAmount(l.rate, cur))}</td>
        <td class="num">${esc(formatAmount(l.amount, cur))}</td>
      </tr>`).join('');

  const taxRows = view.taxLines.map((t) => `
      <tr>
        <td colspan="3">${esc(t.label)}${t.basis === 'percent_of_subtotal' ? ' (' + esc(String(t.value)) + '%)' : ''}</td>
        <td class="num">${esc(formatAmount(t.amount, cur))}</td>
      </tr>`).join('');

  const paymentRows = view.payments.map((p) => `
      <tr>
        <td>${esc(fmtDateLong(p.paidOn))}</td>
        <td>${esc(paymentMethodLabel(p.method))}${p.reference ? ' &middot; ' + esc(p.reference) : ''}</td>
        <td class="num">${esc(formatAmount(p.amount, cur))}</td>
      </tr>`).join('');

  const voidBanner = inv.status === 'void'
    ? `<div class="void">VOID &middot; ${esc(inv.voidReason || 'No reason recorded')}</div>`
    : '';

  const partyBlock = isReceivable
    ? `
      <div class="who">
        <p class="who-l">Billed to</p>
        <p class="who-n">${esc(counterparty)}</p>
        ${inv.partyKind ? `<p class="who-s">${esc(partyKindLabel(inv.partyKind))}</p>` : ''}
        ${inv.partyEmail ? `<p class="who-s">${esc(inv.partyEmail)}</p>` : ''}
        ${inv.partyAddress ? `<p class="who-s">${esc(inv.partyAddress)}</p>` : ''}
        ${inv.partyTaxReference ? `<p class="who-s">Tax reference: ${esc(inv.partyTaxReference)}</p>` : ''}
        ${inv.partyReference ? `<p class="who-s">Your reference: ${esc(inv.partyReference)}</p>` : ''}
      </div>`
    : `
      <div class="who">
        <p class="who-l">Billed by</p>
        <p class="who-n">${esc(counterparty)}</p>
        ${inv.vendorInvoiceRef ? `<p class="who-s">Their invoice number: ${esc(inv.vendorInvoiceRef)}</p>` : ''}
        ${inv.payeeName ? `<p class="who-s">Paid to: ${esc(inv.payeeName)}</p>` : ''}
        <p class="who-s">Our reference: ${esc(inv.invoiceNumber)}</p>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(inv.invoiceNumber)} - ${esc(counterparty)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size:12px; color:#1a1a1a; background:#fff; padding:16px; }
  .sheet { max-width:760px; margin:0 auto; }
  .header { background:#FF4F00; color:#fff; padding:18px; border-radius:8px 8px 0 0; }
  .header h1 { font-size:19px; font-weight:700; }
  .header p { font-size:12px; opacity:0.9; margin-top:4px; }
  .badge { background:rgba(255,255,255,0.2); padding:3px 10px; border-radius:100px; font-size:11px;
    display:inline-block; margin-top:8px; }
  .body { border:1px solid #e5e7eb; border-top:none; border-radius:0 0 8px 8px; padding:18px; }
  .void { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; font-weight:700; letter-spacing:0.08em;
    padding:8px 12px; border-radius:6px; margin-bottom:14px; font-size:12px; }
  .meta { display:grid; grid-template-columns:1fr; gap:14px; margin-bottom:16px; padding-bottom:14px;
    border-bottom:1px solid #e5e7eb; }
  .who-l { font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#6b7280; }
  .who-n { font-size:14px; font-weight:700; margin-top:3px; }
  .who-s { font-size:11.5px; color:#4b5563; margin-top:2px; line-height:1.5; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280;
    border-bottom:1px solid #e5e7eb; padding:7px 6px; }
  td { padding:7px 6px; border-bottom:1px solid #f3f4f6; font-size:12px; vertical-align:top; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  .totals { margin-left:auto; width:100%; max-width:320px; }
  .totals td { border:none; padding:4px 6px; }
  .grand td { border-top:2px solid #1a1a1a; font-weight:700; font-size:14px; padding-top:8px; }
  .sec { font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#6b7280; margin:16px 0 6px; }
  .note { font-size:11.5px; color:#4b5563; line-height:1.6; white-space:pre-wrap; }
  .foot { margin-top:18px; padding-top:12px; border-top:1px solid #e5e7eb; font-size:10.5px; color:#6b7280;
    line-height:1.6; }
  @media (min-width:640px) { .meta { grid-template-columns:1fr 1fr; } }
  @media print { body { padding:0; } .header { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="header">
    <h1>${isReceivable ? 'Invoice' : 'Supplier bill'} ${esc(inv.invoiceNumber)}</h1>
    <p>${org} &middot; ${esc(fmtDateLong(inv.issueDate))}${inv.dueDate ? ' &middot; due ' + esc(fmtDateLong(inv.dueDate)) : ''}</p>
    <span class="badge">${esc(statusLabel(inv.direction, view.display))}</span>
  </div>
  <div class="body">
    ${voidBanner}
    <div class="meta">
      ${partyBlock}
      <div class="who">
        <p class="who-l">${isReceivable ? 'From' : 'Recorded by'}</p>
        <p class="who-n">${org}</p>
        <p class="who-s">Invoice number: ${esc(inv.invoiceNumber)}</p>
        <p class="who-s">Issued: ${esc(fmtDateLong(inv.issueDate))}</p>
        ${inv.dueDate ? `<p class="who-s">Due: ${esc(fmtDateLong(inv.dueDate))}</p>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        ${lineRows || '<tr><td colspan="4">No lines have been added to this invoice.</td></tr>'}
        ${taxRows}
      </tbody>
    </table>

    <table class="totals">
      <tr><td>Subtotal</td><td class="num">${esc(formatAmount(inv.subtotal, cur))}</td></tr>
      <tr><td>Tax</td><td class="num">${esc(formatAmount(inv.taxTotal, cur))}</td></tr>
      <tr class="grand"><td>Total</td><td class="num">${esc(formatAmount(inv.total, cur))}</td></tr>
      ${view.paidTotal > 0 ? `<tr><td>Paid</td><td class="num">${esc(formatAmount(view.paidTotal, cur))}</td></tr>` : ''}
      ${view.paidTotal > 0 ? `<tr class="grand"><td>Balance</td><td class="num">${esc(formatAmount(view.balance, cur))}</td></tr>` : ''}
    </table>

    ${view.payments.length ? `<p class="sec">Payments</p>
    <table>
      <thead><tr><th>Date</th><th>Method</th><th class="num">Amount</th></tr></thead>
      <tbody>${paymentRows}</tbody>
    </table>` : ''}

    ${inv.notes ? `<p class="sec">Notes</p><p class="note">${esc(inv.notes)}</p>` : ''}
    ${inv.terms ? `<p class="sec">Terms</p><p class="note">${esc(inv.terms)}</p>` : ''}

    <p class="foot">
      Amounts are in ${esc(cur)}. Tax lines are the components configured for this organisation, printed
      with the label and rate that were in force when this invoice was raised. This document states what
      was charged; it makes no statement about any tax authority's requirements.
    </p>
  </div>
</div>
${autoPrint ? '<script>window.onload = function () { window.print(); };</' + 'script>' : ''}
</body>
</html>`;
}
