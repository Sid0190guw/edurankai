// src/lib/procurement.ts — PURCHASE REQUESTS, PURCHASE ORDERS, RECEIPTS AND VENDORS.
//
// =================================================================================================
// WHAT THIS FILE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
// =================================================================================================
//
// It is the DOMAIN. It stores what somebody wants to buy, what it costs, who suggested a vendor and
// where the quote is; and, once a request is approved, the purchase order raised against it and the
// confirmation that the thing arrived.
//
// IT IS NOT AN APPROVAL ENGINE. There is no approve() in this file, no approver column on any table
// here, no threshold constant and no comparison against a role name. Approval belongs to
// src/lib/workflow.ts, which is the ONLY approval engine in this codebase:
//
//   Layer 1  ORGANIZATION   who approves for this person   -> src/lib/org-graph.ts, per ROW
//   Layer 2  AUTHORIZATION  may this user act at all       -> src/lib/auth/permissions.ts, per USER
//   Layer 3  WORKFLOW       how the request moves          -> src/lib/workflow.ts
//   ---------------------------------------------------------------------------------------------
//   THIS FILE                what is being bought          -> a record, and nothing else
//
// submitRequest() calls startWorkflow({ domain: 'procurement', ... }) and then asks the engine what
// state the request is in. It never writes an approval state of its own, so there is no second
// opinion for the two to disagree about.
//
// =================================================================================================
// THE CHAIN, AND WHY NO THRESHOLD NUMBER APPEARS ANYWHERE IN THIS FILE
// =================================================================================================
//
// The procurement chain already exists, declared as DATA, in src/lib/workflow.ts DOMAINS:
//
//   step 1  reporting_manager                       required
//   step 2  department_head                         required   ) PARALLEL — both must approve
//   step 2  approval_owner ('procurement')          optional   )
//   step 3  executive_sponsor                       only at or above the configured amount
//
// The amount at which the finance/executive rung appears is `minAmount` on that rule. It is
// CONFIGURATION — a field on a declared route, changed in one place — and procurementChain() below
// READS it rather than restating it. No handler and no page in this module contains a currency
// figure, which is the whole point: a threshold typed into a POST handler is a threshold that
// disagrees with the engine the first time either is edited, and the version that decides is not the
// version anybody can see.
//
// Every approver is resolved PER REQUEST from the organization graph. Not one of them comes from a
// role name, and when the graph cannot name somebody the engine HALTS the request with a readable
// sentence. It never auto-approves. That behaviour is the engine's; this file only makes sure the
// amount and the subject employee reach it correctly, because an amount that does not reach the
// engine is a finance approval that silently never happens.
//
// =================================================================================================
// THE ASSET REGISTER IS SOMEBODY ELSE'S TABLE, AND THIS FILE DOES NOT CREATE IT
// =================================================================================================
//
// When a purchased item becomes company property it belongs in the asset register, which is a
// separate module with its own storage. This file records the ASSET TAG on the receipt and links to
// the register — and assetRegisterStatus() asks the database whether that register actually exists
// before any surface offers a link to it. A link to a page that is not there is a worse answer than
// an honest sentence saying the register is not available yet.
//
// Under no circumstances does this module CREATE an assets table. Two CREATE TABLE IF NOT EXISTS
// statements for one table, with different shapes, silently breaks every write for whichever module
// lost the race — the second statement is a no-op and its columns never appear. That fault class is
// being repaired elsewhere in this repository and must not be reintroduced here.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE, EACH ONE PAID FOR ALREADY
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is always a bug; rows() normalises.
//   - The real Postgres reason is on `e.cause`. `e.message` is only the SQL that failed.
//   - Every `const` is declared ABOVE the functions that read it. `const` is not hoisted.
//   - NO WRITE PATH SWALLOWS AN EXCEPTION. Every catch here LOGS the real cause and returns
//     { ok: false, error }. A bare catch made a failed post report success on this project, and a
//     swallowed error hid a hire that never happened for eleven days.
//   - `departments.id` is varchar(50) in src/lib/db/schema.ts and UUID in db/hr-schema.sql, so it is
//     compared as ::text and never cast ::uuid. It appears here only through hr_employees.
//   - DOCUMENTS ARE LINKS, NEVER UPLOADS. A quote and a receipt are a shared link with view access;
//     nothing is stored in this product but the reference.
//   - No vendor in any seeded or example data names a real company.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
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
  console.error('[procurement] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * What a person is shown when a write fails. Deliberately NOT the database's own words: the real
 * cause goes to the log every time, and a column name on somebody's screen tells them nothing they
 * can act on while telling anybody who asks what the schema looks like.
 */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

/** One sentence for every not-found / not-yours refusal, so probing ids cannot tell the two apart. */
const NOT_AVAILABLE = 'That request is not available.';

const SCHEMA_FAILED =
  'The procurement tables are not ready yet, so nothing was saved. Try again in a moment.';

/** Defaults, kept here rather than typed into a form so one edit moves every surface. */
export const DEFAULT_CURRENCY = 'INR';

/** Longest a free-text field is stored at. Trimming at the write keeps the render honest. */
const MAX_TEXT = 2000;
const MAX_LINE = 300;

/**
 * The categories a request can be filed under. Plain nouns; nothing here names a company, and the
 * list is deliberately short — a category nobody can pick is a field everybody types 'other' into.
 */
export const PROCUREMENT_CATEGORIES = [
  'hardware',
  'software',
  'furniture',
  'stationery',
  'travel',
  'services',
  'training',
  'facilities',
  'other',
] as const;

export type ProcurementCategory = (typeof PROCUREMENT_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(PROCUREMENT_CATEGORIES);
export function isProcurementCategory(v: unknown): v is ProcurementCategory {
  return typeof v === 'string' && CATEGORY_SET.has(v);
}

export function categoryLabel(v: string): string {
  const key = String(v || '');
  if (key === 'hardware') return 'Hardware';
  if (key === 'software') return 'Software and licences';
  if (key === 'furniture') return 'Furniture';
  if (key === 'stationery') return 'Stationery and supplies';
  if (key === 'travel') return 'Travel and accommodation';
  if (key === 'services') return 'Services';
  if (key === 'training') return 'Training and learning';
  if (key === 'facilities') return 'Facilities and maintenance';
  if (key === 'other') return 'Other';
  return key || 'Uncategorised';
}

/**
 * THE REQUEST'S OWN LIFECYCLE — three states, and deliberately not five.
 *
 * `approved` and `rejected` ARE NOT HERE. Approval is the workflow engine's answer and reading it
 * from the instance is the only way it is ever read; copying it onto this row would create a second
 * place for the same fact to live and a guaranteed disagreement the first time one write succeeded
 * and the other did not.
 *
 * "Ordered" and "received" are not here either, for the same reason in the other direction: they are
 * facts about a PURCHASE ORDER row, derived from whether one exists and whether it has been
 * confirmed received. One writer per fact.
 */
export const REQUEST_STATES = ['draft', 'submitted', 'cancelled'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  draft: 'Draft',
  submitted: 'Sent for approval',
  cancelled: 'Withdrawn',
};

/**
 * from -> the states it may move to. Read the absences:
 *   - nothing leaves `cancelled`; a changed mind is a new request, exactly as hr_leave_request
 *     already behaves;
 *   - there is no edge back from `submitted` to `draft`. Once approvers have been asked, editing the
 *     thing they were asked about behind their backs is not an edit, it is a different request.
 */
const REQUEST_TRANSITIONS: Record<RequestState, RequestState[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['cancelled'],
  cancelled: [],
};

export interface TransitionCheck {
  ok: boolean;
  /** Null when ok. A sentence for a person, never a database message. */
  reason: string | null;
}

/**
 * May this request move from one state to the other?
 *
 * IT RETURNS AN OBJECT, NOT A BOOLEAN. `if (canTransition(a, b))` is always true and would wave
 * every move through — the same trap src/lib/employee-tasks.ts and src/lib/workflow.ts both document
 * on their own canTransition, spelled the same way here so reading one teaches the others.
 */
export function canTransition(from: string, to: string): TransitionCheck {
  const a = REQUEST_STATES.indexOf(from as RequestState) >= 0 ? (from as RequestState) : null;
  const b = REQUEST_STATES.indexOf(to as RequestState) >= 0 ? (to as RequestState) : null;
  if (!a) return { ok: false, reason: 'That request is in a state we do not recognise.' };
  if (!b) return { ok: false, reason: 'That is not a state we track.' };
  if (a === b) return { ok: false, reason: 'It is already ' + REQUEST_STATE_LABELS[b].toLowerCase() + '.' };
  if ((REQUEST_TRANSITIONS[a] || []).indexOf(b) < 0) {
    return {
      ok: false,
      reason: REQUEST_STATE_LABELS[a] + ' does not move to ' + REQUEST_STATE_LABELS[b] + '.',
    };
  }
  return { ok: true, reason: null };
}

/** A purchase order's own lifecycle. Receipt is a confirmation, not a new row. */
export const ORDER_STATES = ['open', 'received', 'cancelled'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_STATE_LABELS: Record<OrderState, string> = {
  open: 'Ordered',
  received: 'Received',
  cancelled: 'Cancelled',
};

// -------------------------------------------------------------------------------------------------
// STORAGE. Self-bootstrapping DDL, INSIDE an ensureOnce guard, exactly once per process.
// -------------------------------------------------------------------------------------------------

/**
 * Create the procurement tables if they are absent. Idempotent, safe on every request.
 *
 * ensureOnce() memoises the in-flight promise per process and DROPS the cache entry if the callback
 * rejects (src/lib/ensure-once.ts), so a transient failure retries on the next call rather than
 * poisoning the process for its lifetime. That reset is why the catch below RE-THROWS after logging.
 *
 * ensureOnce() then swallows the rejection for the CALLER — so every READ here degrades to an empty
 * list, and every WRITE refuses with a sentence. `schemaReady()` is what the writes ask, and a write
 * that cannot confirm its own table does not proceed and does not report success.
 */
export function ensureProcurementSchema(): Promise<void> {
  return ensureOnce('procurement_v1', async () => {
    try {
      await createProcurementTables();
    } catch (e: any) {
      logFail('ensureProcurementSchema', e);
      throw e;
    }
  });
}

/**
 * Did the schema actually land? ensureOnce() hides the rejection from callers on purpose, so a write
 * must ask the database rather than trusting that the ensure "returned". `to_regclass` answers NULL
 * for a table that does not exist instead of throwing, which is why it is used rather than a SELECT.
 */
async function schemaReady(): Promise<boolean> {
  try {
    await ensureProcurementSchema();
    const r = rows(await db.execute(sql`
      SELECT to_regclass('public.procurement_requests') IS NOT NULL AS ok`));
    return r.length > 0 && r[0]?.ok === true;
  } catch (e: any) {
    logFail('schemaReady', e);
    return false;
  }
}

async function createProcurementTables(): Promise<void> {
  // -----------------------------------------------------------------------------------------
  // procurement_vendors — WHO WE BUY FROM. Contact and category, nothing else.
  //
  // No payment details, no bank account, no credit terms. A vendor row here is an address book
  // entry that a request can point at so two people asking for the same thing name the same
  // supplier; anything that moves money lives in the finance module and is not duplicated here.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS procurement_vendors (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    category      TEXT,
    contact_name  TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    website       TEXT,
    notes         TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // CREATE TABLE IF NOT EXISTS IS A NO-OP ON AN EXISTING TABLE, INCLUDING ONE MISSING COLUMNS. That
  // is how hr_employees.work_email came to be declared in db/hr-schema.sql and absent from the live
  // table, which locked every administrator out of /admin for a day. So every column past the
  // primary key is asserted again. No-ops on a fresh database; the difference between working and a
  // 500 on a database carrying an earlier revision of this file.
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS category TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS contact_name TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS contact_email TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS contact_phone TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS website TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS notes TEXT`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS created_by UUID`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE procurement_vendors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS procurement_vendors_active_idx
    ON procurement_vendors (is_active, name)`);

  // -----------------------------------------------------------------------------------------
  // procurement_requests — ONE ROW PER THING SOMEBODY WANTS TO BUY.
  //
  //   requester_employee_id  hr_employees.id. THE ORG GRAPH IS KEYED ON THIS, never on users.id,
  //                          and it is what the approval chain is routed from. A request with no
  //                          employee id cannot be routed at all, and the engine says so rather
  //                          than approving it.
  //   requester_user_id      users.id, for notifications and for "is this mine".
  //   status                 draft | submitted | cancelled. NOT approved/rejected — see the note on
  //                          REQUEST_STATES. The approval lives on the workflow instance.
  //   quote_url              A LINK. Documents are never uploaded on this platform.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS procurement_requests (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id     UUID,
    requester_employee_id UUID,
    item                  TEXT NOT NULL,
    category              TEXT,
    quantity              INT NOT NULL DEFAULT 1,
    unit                  TEXT,
    estimated_cost        NUMERIC(14,2),
    currency              TEXT NOT NULL DEFAULT 'INR',
    justification         TEXT,
    needed_by             DATE,
    vendor_id             UUID,
    vendor_suggestion     TEXT,
    quote_url             TEXT,
    status                TEXT NOT NULL DEFAULT 'draft',
    submitted_at          TIMESTAMPTZ,
    cancelled_at          TIMESTAMPTZ,
    cancel_reason         TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS requester_user_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS requester_employee_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS category TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS unit TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(14,2)`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS justification TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS needed_by DATE`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS vendor_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS vendor_suggestion TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS quote_url TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE procurement_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // NO CHECK CONSTRAINT on `status` or `category`, and no foreign key to hr_employees. Same reasons
  // workflow-schema.ts gives for its own tables: this project has no migration runner, so every DDL
  // change is CREATE/ADD IF NOT EXISTS and a CHECK could never be widened; and a foreign key to an
  // employee row would take a purchase record with it when somebody leaves, when that record is the
  // evidence behind money the company spent.

  await db.execute(sql`CREATE INDEX IF NOT EXISTS procurement_requests_mine_idx
    ON procurement_requests (requester_user_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS procurement_requests_status_idx
    ON procurement_requests (status, created_at DESC)`);

  // -----------------------------------------------------------------------------------------
  // procurement_orders — THE PURCHASE ORDER, AND THE RECEIPT ON THE SAME ROW.
  //
  //   po_number     human-readable, unique, generated from the year and a counter. People read it
  //                 out over the phone; a uuid is not that.
  //   asset_tag     THE LINK TO THE ASSET REGISTER, which is a different module with its own table.
  //                 A tag, not a foreign key: this file must not assume the shape of somebody
  //                 else's storage, and it must never create it. assetRegisterStatus() checks
  //                 whether the register exists before any surface offers a link.
  //   receipt_url   A LINK. Never an upload.
  // -----------------------------------------------------------------------------------------
  await db.execute(sql`CREATE TABLE IF NOT EXISTS procurement_orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number           TEXT NOT NULL,
    request_id          UUID,
    vendor_id           UUID,
    vendor_name         TEXT,
    ordered_by_user_id  UUID,
    order_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_date       DATE,
    amount              NUMERIC(14,2),
    currency            TEXT NOT NULL DEFAULT 'INR',
    notes               TEXT,
    status              TEXT NOT NULL DEFAULT 'open',
    received_at         TIMESTAMPTZ,
    received_by_user_id UUID,
    receipt_note        TEXT,
    receipt_url         TEXT,
    asset_tag           TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS request_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS vendor_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS vendor_name TEXT`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS ordered_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS order_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS expected_date DATE`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2)`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS notes TEXT`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS received_by_user_id UUID`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS receipt_note TEXT`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS receipt_url TEXT`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS asset_tag TEXT`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`ALTER TABLE procurement_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // ONE PURCHASE ORDER PER REQUEST, ENFORCED BY THE DATABASE.
  //
  // The idempotency backstop for raiseOrder(): two clicks on "Raise purchase order", or a retried
  // POST on a phone with one bar of signal, cannot produce two orders against one approved request
  // and therefore cannot order the same thing twice. The pre-check in raiseOrder() is a convenience;
  // this index is the guarantee. Its own try/catch, because an index that fails to create on
  // existing data must not abort a bootstrap halfway and leave a half-made schema behind.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS procurement_orders_request_uq
      ON procurement_orders (request_id) WHERE request_id IS NOT NULL AND status <> 'cancelled'`);
  } catch (e: any) {
    logFail('procurement_orders_request_uq', e);
  }
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS procurement_orders_number_uq
      ON procurement_orders (po_number)`);
  } catch (e: any) {
    logFail('procurement_orders_number_uq', e);
  }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS procurement_orders_status_idx
    ON procurement_orders (status, order_date DESC)`);
}

// -------------------------------------------------------------------------------------------------
// THE CHAIN, READ FROM THE ENGINE
// -------------------------------------------------------------------------------------------------

export interface ChainRung {
  step: number;
  /** The org-graph relationship this rung walks. NOT a role name and not a capability. */
  via: string;
  optional: boolean;
  /** The amount at or above which this rung exists at all. Null when it always does. */
  minAmount: number | null;
  /** Do several rungs share this step number? Then they are parallel and all of them must approve. */
  parallel: boolean;
}

/**
 * THE PROCUREMENT APPROVAL CHAIN, as the engine has it declared.
 *
 * Derived, never restated. If src/lib/workflow.ts changes the chain — a rung added, a threshold
 * moved — every screen in this module follows on the next request with no edit here, because the
 * number a person reads on the page is the number the engine will use.
 */
export function procurementChain(): ChainRung[] {
  const def = domainDefinition('procurement');
  const perStep = new Map<number, number>();
  for (const r of def.route) perStep.set(r.step, (perStep.get(r.step) || 0) + 1);
  return def.route.map((r) => ({
    step: r.step,
    via: String(r.via),
    optional: r.optional === true,
    minAmount: typeof r.minAmount === 'number' ? r.minAmount : null,
    parallel: (perStep.get(r.step) || 1) > 1,
  }));
}

/**
 * The amount at or above which the request needs the executive/finance rung, or null when the chain
 * has no threshold rung at all. Read from the chain above, so no page has to know a number.
 */
export function financeThreshold(): number | null {
  const withMin = procurementChain().filter((r) => r.minAmount !== null);
  if (withMin.length === 0) return null;
  return Math.min(...withMin.map((r) => r.minAmount as number));
}

/** How many hours a pending rung sits before it becomes escalatable. The engine's own figure. */
export function escalateAfterHours(): number {
  return domainDefinition('procurement').escalateAfterHours;
}

// -------------------------------------------------------------------------------------------------
// TYPES THE SURFACES SEE
// -------------------------------------------------------------------------------------------------

export interface Vendor {
  id: string;
  name: string;
  category: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string | null;
}

export interface PurchaseRequest {
  id: string;
  requesterUserId: string | null;
  requesterEmployeeId: string | null;
  /** Joined from hr_employees for display. Never used to decide anything. */
  requesterName: string | null;
  item: string;
  category: string | null;
  quantity: number;
  unit: string | null;
  estimatedCost: number | null;
  currency: string;
  justification: string | null;
  neededBy: string | null;
  vendorId: string | null;
  vendorName: string | null;
  vendorSuggestion: string | null;
  quoteUrl: string | null;
  status: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  requestId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  orderedByUserId: string | null;
  orderDate: string | null;
  expectedDate: string | null;
  amount: number | null;
  currency: string;
  notes: string | null;
  status: string;
  receivedAt: string | null;
  receivedByUserId: string | null;
  receiptNote: string | null;
  receiptUrl: string | null;
  assetTag: string | null;
  createdAt: string | null;
}

/** A request with everything a screen needs to render it honestly, in one object. */
export interface RequestView {
  request: PurchaseRequest;
  /** The APPROVAL, from the workflow engine. Null when the request was never submitted. */
  instance: WorkflowInstanceRow | null;
  order: PurchaseOrder | null;
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  /** False when the call was a no-op because the thing was already true. NOT an error. */
  changed?: boolean;
  error?: string;
  /** Set when the approval halted for want of an approver. The engine's sentence, verbatim. */
  haltReason?: string | null;
}

// -------------------------------------------------------------------------------------------------
// MAPPERS AND SMALL HELPERS
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
 * A shared document link, or null.
 *
 * ONLY http(s), and nothing is ever uploaded: on this platform a quote, a receipt and every other
 * document of any kind is a LINK with view access for anybody holding it. Storing files would mean
 * storage cost, a retention question and a second place for a company's paperwork to live.
 *
 * Deliberately NOT restricted to one provider's hostname. A link that works is the requirement; the
 * product does not name or require anybody's product to satisfy it.
 */
export function normaliseLink(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  return s.slice(0, 1000);
}

function mapVendor(r: any): Vendor {
  return {
    id: String(r?.id ?? ''),
    name: String(r?.name ?? ''),
    category: r?.category ? String(r.category) : null,
    contactName: r?.contact_name ? String(r.contact_name) : null,
    contactEmail: r?.contact_email ? String(r.contact_email) : null,
    contactPhone: r?.contact_phone ? String(r.contact_phone) : null,
    website: r?.website ? String(r.website) : null,
    notes: r?.notes ? String(r.notes) : null,
    isActive: r?.is_active !== false,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function mapRequest(r: any): PurchaseRequest {
  return {
    id: String(r?.id ?? ''),
    requesterUserId: r?.requester_user_id ? String(r.requester_user_id) : null,
    requesterEmployeeId: r?.requester_employee_id ? String(r.requester_employee_id) : null,
    requesterName: r?.requester_name ? String(r.requester_name) : null,
    item: String(r?.item ?? ''),
    category: r?.category ? String(r.category) : null,
    quantity: Number(r?.quantity) || 1,
    unit: r?.unit ? String(r.unit) : null,
    estimatedCost: r?.estimated_cost === null || r?.estimated_cost === undefined ? null : Number(r.estimated_cost),
    currency: String(r?.currency || DEFAULT_CURRENCY),
    justification: r?.justification ? String(r.justification) : null,
    neededBy: r?.needed_by ? String(r.needed_by).slice(0, 10) : null,
    vendorId: r?.vendor_id ? String(r.vendor_id) : null,
    vendorName: r?.vendor_name ? String(r.vendor_name) : null,
    vendorSuggestion: r?.vendor_suggestion ? String(r.vendor_suggestion) : null,
    quoteUrl: r?.quote_url ? String(r.quote_url) : null,
    status: String(r?.status || 'draft'),
    submittedAt: r?.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    cancelledAt: r?.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    cancelReason: r?.cancel_reason ? String(r.cancel_reason) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function mapOrder(r: any): PurchaseOrder {
  return {
    id: String(r?.id ?? ''),
    poNumber: String(r?.po_number ?? ''),
    requestId: r?.request_id ? String(r.request_id) : null,
    vendorId: r?.vendor_id ? String(r.vendor_id) : null,
    vendorName: r?.vendor_name ? String(r.vendor_name) : null,
    orderedByUserId: r?.ordered_by_user_id ? String(r.ordered_by_user_id) : null,
    orderDate: r?.order_date ? String(r.order_date).slice(0, 10) : null,
    expectedDate: r?.expected_date ? String(r.expected_date).slice(0, 10) : null,
    amount: r?.amount === null || r?.amount === undefined ? null : Number(r.amount),
    currency: String(r?.currency || DEFAULT_CURRENCY),
    notes: r?.notes ? String(r.notes) : null,
    status: String(r?.status || 'open'),
    receivedAt: r?.received_at ? new Date(r.received_at).toISOString() : null,
    receivedByUserId: r?.received_by_user_id ? String(r.received_by_user_id) : null,
    receiptNote: r?.receipt_note ? String(r.receipt_note) : null,
    receiptUrl: r?.receipt_url ? String(r.receipt_url) : null,
    assetTag: r?.asset_tag ? String(r.asset_tag) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/** Money, for a screen. Kept in one place so twelve renders cannot format it twelve ways. */
export function formatAmount(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const cur = String(currency || DEFAULT_CURRENCY);
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 })
      .format(Number(amount));
  } catch {
    // An unknown currency code must not take a page down over a number.
    return cur + ' ' + Number(amount).toLocaleString('en-IN');
  }
}

// -------------------------------------------------------------------------------------------------
// THE ASSET REGISTER — A DIFFERENT MODULE'S TABLE. Asked about, never created.
// -------------------------------------------------------------------------------------------------

export interface AssetRegisterStatus {
  /** Does an asset register exist in this database at all? */
  available: boolean;
  /** Where to send somebody when it does. Null when it does not, so nothing links into a 404. */
  href: string | null;
}

/**
 * IS THERE AN ASSET REGISTER TO LINK TO?
 *
 * The asset register belongs to the assets module and has its own storage. This function ASKS the
 * database whether that storage exists; it does not create it, does not assume its columns, and does
 * not fail if it is absent. `to_regclass` returns NULL for a missing table rather than throwing,
 * which is exactly the question being asked.
 *
 * WHY THIS IS A RUNTIME CHECK RATHER THAN A CONSTANT: the two modules ship independently. Rendering a
 * link to a console that is not there is a broken promise on a screen; saying "the asset register is
 * not available in this environment yet" is the honest empty state, and it changes to a working link
 * the moment the register exists, with no edit here.
 */
export async function assetRegisterStatus(): Promise<AssetRegisterStatus> {
  try {
    // Asked by PATTERN rather than by one guessed table name, because the register's own module owns
    // that name and this file must not depend on a spelling it did not choose. Any public table
    // called `assets`, `asset_*` or `*_assets` is the register; there is nothing else in this schema
    // that word could mean.
    const r = rows(await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND (table_name = 'assets' OR table_name LIKE 'asset\\_%' OR table_name LIKE '%\\_assets')
      ) AS ok`));
    const available = r.length > 0 && r[0]?.ok === true;
    return { available, href: available ? '/admin/assets' : null };
  } catch (e: any) {
    logFail('assetRegisterStatus', e);
    // Fails closed to "not available": an unlinked tag is a small inconvenience, a link into
    // nothing is a screen that lies.
    return { available: false, href: null };
  }
}

// -------------------------------------------------------------------------------------------------
// READS. Every one fails closed to empty, and says nothing it cannot prove.
// -------------------------------------------------------------------------------------------------

export async function listVendors(opts: { includeInactive?: boolean; category?: string } = {}): Promise<Vendor[]> {
  try {
    await ensureProcurementSchema();
    const activeFilter = opts.includeInactive ? sql`` : sql`AND is_active = true`;
    const catFilter = opts.category ? sql`AND category = ${String(opts.category)}` : sql``;
    const r = await db.execute(sql`
      SELECT * FROM procurement_vendors
       WHERE TRUE ${activeFilter} ${catFilter}
       ORDER BY is_active DESC, name ASC
       LIMIT 300`);
    return rows(r).map(mapVendor);
  } catch (e: any) {
    logFail('listVendors', e);
    return [];
  }
}

export async function getVendor(id: string): Promise<Vendor | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureProcurementSchema();
    const r = rows(await db.execute(sql`SELECT * FROM procurement_vendors WHERE id = ${id}::uuid LIMIT 1`));
    return r.length ? mapVendor(r[0]) : null;
  } catch (e: any) {
    logFail('getVendor', e);
    return null;
  }
}

export interface ListRequestOptions {
  /** Only this person's own requests. The self-scope for the employee surface. */
  requesterUserId?: string;
  status?: string;
  limit?: number;
}

/**
 * Purchase requests, newest first.
 *
 * SCOPING IS THE CALLER'S TO STATE AND THIS FUNCTION'S TO ENFORCE. Passing requesterUserId narrows
 * the WHERE clause, so an employee surface fetches only its own rows rather than filtering a wider
 * result in JavaScript — a row that must not be seen is never read.
 */
export async function listRequests(opts: ListRequestOptions = {}): Promise<PurchaseRequest[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  try {
    await ensureProcurementSchema();
    const mineFilter = opts.requesterUserId && isUuid(opts.requesterUserId)
      ? sql`AND r.requester_user_id = ${opts.requesterUserId}::uuid`
      : sql``;
    // A caller that ASKED to be scoped to one person and handed a value we cannot use must get
    // NOTHING, never everybody. Failing open here would be one typo away from showing the whole
    // company's purchasing to one employee.
    if (opts.requesterUserId && !isUuid(opts.requesterUserId)) return [];
    const statusFilter = opts.status ? sql`AND r.status = ${String(opts.status)}` : sql``;
    const r = await db.execute(sql`
      SELECT r.*, v.name AS vendor_name, e.full_name AS requester_name
        FROM procurement_requests r
        LEFT JOIN procurement_vendors v ON v.id = r.vendor_id
        LEFT JOIN hr_employees e ON e.id = r.requester_employee_id
       WHERE TRUE ${mineFilter} ${statusFilter}
       ORDER BY (r.status = 'submitted') DESC, r.created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapRequest);
  } catch (e: any) {
    logFail('listRequests', e);
    return [];
  }
}

export async function getRequest(id: string): Promise<PurchaseRequest | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureProcurementSchema();
    const r = rows(await db.execute(sql`
      SELECT r.*, v.name AS vendor_name, e.full_name AS requester_name
        FROM procurement_requests r
        LEFT JOIN procurement_vendors v ON v.id = r.vendor_id
        LEFT JOIN hr_employees e ON e.id = r.requester_employee_id
       WHERE r.id = ${id}::uuid
       LIMIT 1`));
    return r.length ? mapRequest(r[0]) : null;
  } catch (e: any) {
    logFail('getRequest', e);
    return null;
  }
}

export async function getOrderForRequest(requestId: string): Promise<PurchaseOrder | null> {
  if (!isUuid(requestId)) return null;
  try {
    await ensureProcurementSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM procurement_orders
       WHERE request_id = ${requestId}::uuid AND status <> 'cancelled'
       ORDER BY created_at DESC LIMIT 1`));
    return r.length ? mapOrder(r[0]) : null;
  } catch (e: any) {
    logFail('getOrderForRequest', e);
    return null;
  }
}

export async function listOrders(opts: { status?: string; limit?: number } = {}): Promise<PurchaseOrder[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  try {
    await ensureProcurementSchema();
    const statusFilter = opts.status ? sql`AND status = ${String(opts.status)}` : sql``;
    const r = await db.execute(sql`
      SELECT * FROM procurement_orders
       WHERE TRUE ${statusFilter}
       ORDER BY (status = 'open') DESC, order_date DESC, created_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapOrder);
  } catch (e: any) {
    logFail('listOrders', e);
    return [];
  }
}

/**
 * A request, its approval and its order together — the shape every screen actually renders.
 *
 * THE APPROVAL IS READ FROM THE ENGINE, not from a column here. instanceForRecord() is the workflow
 * module's own lookup, so what a person sees on this page is the same row the approve button acts on.
 */
export async function viewRequest(id: string): Promise<RequestView | null> {
  const request = await getRequest(id);
  if (!request) return null;
  const instance = await instanceForRecord('procurement', request.id);
  const order = await getOrderForRequest(request.id);
  return { request, instance, order };
}

/**
 * The same join for a LIST, without one round trip per row for a thing that cannot exist.
 *
 * A DRAFT has never been near the approval engine and can never have an order — nothing may order
 * against an unapproved request — so neither lookup runs for one. That is not a micro-optimisation
 * on a page where somebody's twenty drafts would otherwise cost forty pointless queries on a phone.
 */
export async function viewRequests(list: PurchaseRequest[]): Promise<RequestView[]> {
  const out: RequestView[] = [];
  for (const request of list) {
    if (request.status === 'draft') {
      out.push({ request, instance: null, order: null });
      continue;
    }
    const instance = await instanceForRecord('procurement', request.id);
    const order = await getOrderForRequest(request.id);
    out.push({ request, instance, order });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// WRITES. Nothing here swallows an exception, and nothing reports success it cannot prove.
// -------------------------------------------------------------------------------------------------

export interface VendorInput {
  name: string;
  category?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  notes?: string | null;
}

/**
 * Record a vendor.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST BRING ONE. `actorUserId` is taken for the audit
 * trail. /admin/procurement/vendors gates it; a new caller gets no gate from this function.
 */
export async function createVendor(input: VendorInput, actorUserId: string | null): Promise<WriteResult> {
  const name = text(input?.name);
  if (!name) return { ok: false, error: 'A vendor needs a name.' };
  const website = input?.website ? normaliseLink(input.website) : null;
  if (input?.website && !website) {
    return { ok: false, error: 'That website address does not look like a link. It should start with https://' };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO procurement_vendors
        (name, category, contact_name, contact_email, contact_phone, website, notes, created_by)
      VALUES
        (${name}, ${text(input?.category)}::text, ${text(input?.contactName)}::text,
         ${text(input?.contactEmail)}::text, ${text(input?.contactPhone)}::text,
         ${website}::text, ${text(input?.notes, MAX_TEXT)}::text,
         ${isUuid(actorUserId) ? actorUserId : null}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'procurement.vendor.create',
      entity: 'procurement_vendor',
      entityId: id,
      diff: { name, category: text(input?.category) },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('createVendor', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Retire or restore a vendor. Never deleted: requests point at it and that history is evidence. */
export async function setVendorActive(
  vendorId: string,
  active: boolean,
  actorUserId: string | null,
): Promise<WriteResult> {
  if (!isUuid(vendorId)) return { ok: false, error: 'That vendor is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_vendors
         SET is_active = ${active}, updated_at = NOW()
       WHERE id = ${vendorId}::uuid AND is_active <> ${active}
      RETURNING id`));
    if (!wrote.length) return { ok: true, id: vendorId, changed: false };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: active ? 'procurement.vendor.restore' : 'procurement.vendor.retire',
      entity: 'procurement_vendor',
      entityId: vendorId,
      diff: { isActive: active },
    });
    return { ok: true, id: vendorId, changed: true };
  } catch (e: any) {
    logFail('setVendorActive', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface RequestInput {
  requesterUserId: string;
  /** hr_employees.id. THE APPROVAL IS ROUTED FROM THIS and cannot be routed without it. */
  requesterEmployeeId: string | null;
  item: string;
  category?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  estimatedCost?: number | string | null;
  currency?: string | null;
  justification?: string | null;
  neededBy?: string | null;
  vendorId?: string | null;
  vendorSuggestion?: string | null;
  quoteUrl?: string | null;
}

/**
 * Raise a purchase request. It starts as a DRAFT — nobody has been asked for anything yet.
 *
 * Creating and submitting are two acts on purpose: a person can write down what they need, find the
 * quote, and only then send it into an approval chain that will notify their manager. A form that
 * notified somebody the moment a field was typed would train every manager to ignore the alert.
 */
export async function createRequest(input: RequestInput): Promise<WriteResult> {
  const userId = String(input?.requesterUserId || '').trim();
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to raise a request.' };

  const item = text(input?.item);
  if (!item) return { ok: false, error: 'Say what you need. One line is enough.' };

  const quantity = Math.max(1, Math.min(Number(num(input?.quantity) ?? 1) || 1, 100000));
  const cost = num(input?.estimatedCost);
  if (cost !== null && cost < 0) return { ok: false, error: 'An estimated cost cannot be negative.' };

  const quote = input?.quoteUrl ? normaliseLink(input.quoteUrl) : null;
  if (input?.quoteUrl && !quote) {
    return {
      ok: false,
      error: 'That quote link does not look like a link. Paste a shared document link that starts with https:// '
        + 'and make sure anybody with the link can view it. Files are never uploaded here.',
    };
  }

  const category = isProcurementCategory(input?.category) ? String(input?.category) : null;
  const neededBy = text(input?.neededBy, 10);
  const vendorId = isUuid(input?.vendorId) ? String(input?.vendorId) : null;

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO procurement_requests
        (requester_user_id, requester_employee_id, item, category, quantity, unit, estimated_cost,
         currency, justification, needed_by, vendor_id, vendor_suggestion, quote_url, status)
      VALUES
        (${userId}::uuid, ${isUuid(input?.requesterEmployeeId) ? input?.requesterEmployeeId : null}::uuid,
         ${item}, ${category}::text, ${quantity}, ${text(input?.unit, 40)}::text, ${cost}::numeric,
         ${text(input?.currency, 8) || DEFAULT_CURRENCY}, ${text(input?.justification, MAX_TEXT)}::text,
         ${neededBy}::date, ${vendorId}::uuid, ${text(input?.vendorSuggestion)}::text,
         ${quote}::text, 'draft')
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);
    await logAudit({
      userId,
      action: 'procurement.request.create',
      entity: 'procurement_request',
      entityId: id,
      diff: { item, category, quantity, estimatedCost: cost, currency: text(input?.currency, 8) || DEFAULT_CURRENCY },
    });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('createRequest', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Edit a DRAFT request. Only the person who raised it, and only before anybody was asked.
 *
 * The UPDATE repeats both preconditions it was validated against — owner and status — so a request
 * submitted in another tab a second ago makes this write touch zero rows and be reported as a
 * concurrent change, rather than silently rewriting what an approver is already looking at.
 */
export async function updateDraft(
  requestId: string,
  userId: string,
  input: Partial<RequestInput>,
): Promise<WriteResult> {
  if (!isUuid(requestId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to change this.' };

  const item = text(input?.item);
  if (!item) return { ok: false, error: 'Say what you need. One line is enough.' };
  const quote = input?.quoteUrl ? normaliseLink(input.quoteUrl) : null;
  if (input?.quoteUrl && !quote) {
    return { ok: false, error: 'That quote link does not look like a link. It should start with https://' };
  }
  const cost = num(input?.estimatedCost);
  if (cost !== null && cost < 0) return { ok: false, error: 'An estimated cost cannot be negative.' };

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_requests
         SET item = ${item},
             category = ${isProcurementCategory(input?.category) ? String(input?.category) : null}::text,
             quantity = ${Math.max(1, Math.min(Number(num(input?.quantity) ?? 1) || 1, 100000))},
             unit = ${text(input?.unit, 40)}::text,
             estimated_cost = ${cost}::numeric,
             justification = ${text(input?.justification, MAX_TEXT)}::text,
             needed_by = ${text(input?.neededBy, 10)}::date,
             vendor_id = ${isUuid(input?.vendorId) ? String(input?.vendorId) : null}::uuid,
             vendor_suggestion = ${text(input?.vendorSuggestion)}::text,
             quote_url = ${quote}::text,
             updated_at = NOW()
       WHERE id = ${requestId}::uuid
         AND requester_user_id = ${userId}::uuid
         AND status = 'draft'
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request is no longer a draft you can edit. Reload the page to see where it is.' };
    }
    await logAudit({
      userId,
      action: 'procurement.request.update',
      entity: 'procurement_request',
      entityId: requestId,
      diff: { item, estimatedCost: cost },
    });
    return { ok: true, id: requestId, changed: true };
  } catch (e: any) {
    logFail('updateDraft', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * SEND A REQUEST FOR APPROVAL — the one place this module touches the workflow engine.
 *
 * WHAT THIS FUNCTION DOES NOT DO, and must never start doing:
 *   - it does not decide who approves. resolveRoute() inside the engine asks the ORG GRAPH, per row.
 *   - it does not read a role name anywhere.
 *   - IT DOES NOT APPROVE ANYTHING WHEN NOBODY CAN BE RESOLVED. The engine writes the instance in
 *     state 'halted' with a readable sentence, this function returns that sentence, and the surface
 *     renders it. A request that auto-approved because routing failed is the worst outcome available
 *     to a purchasing system: it would look exactly like the system working.
 *
 * THE AMOUNT IS PASSED THROUGH, and that matters more than it looks. The engine decides whether the
 * executive/finance rung applies by comparing the instance amount against the rule's minAmount. An
 * amount that never reaches the engine is a finance approval that silently never happens, so a
 * request with no estimated cost is refused here rather than routed as if it were free.
 *
 * IDEMPOTENT. startWorkflow() is unique on (domain, record_id) in the database, so two taps on
 * "Send for approval" produce ONE approval routed to one set of people. A second call reports
 * changed: false, which is a no-op and not an error.
 */
export async function submitRequest(requestId: string, userId: string): Promise<WriteResult> {
  if (!isUuid(requestId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to send this for approval.' };

  const request = await getRequest(requestId);
  if (!request) return { ok: false, error: NOT_AVAILABLE };
  if (request.requesterUserId !== userId) {
    // The same sentence a missing row gets, so probing ids cannot tell "not yours" from "not there".
    return { ok: false, error: NOT_AVAILABLE };
  }

  const gate = canTransition(request.status, 'submitted');
  if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

  if (!request.requesterEmployeeId) {
    return {
      ok: false,
      error: 'This request is not linked to an employee record, so there is nobody in the organization '
        + 'graph to route it from. Ask HR to link your employee record to this sign-in.',
    };
  }
  if (request.estimatedCost === null) {
    return {
      ok: false,
      error: 'Add an estimated cost first. The approval chain uses the amount to decide whether it '
        + 'needs a finance approval, so a request without one cannot be routed honestly.',
    };
  }

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const summary = request.item
      + (request.quantity > 1 ? ' x' + request.quantity : '')
      + (request.estimatedCost !== null ? ' - ' + formatAmount(request.estimatedCost, request.currency) : '');

    const started = await startWorkflow({
      domain: 'procurement',
      recordId: request.id,
      subjectEmployeeId: request.requesterEmployeeId,
      requestedByUserId: userId,
      summary,
      amount: request.estimatedCost,
      currency: request.currency,
      createdByUserId: userId,
    });

    if (!started.ok) {
      // The engine refused outright. The request stays a draft — reporting success on a request
      // nobody was asked about is exactly the silent failure this module exists to avoid.
      return { ok: false, error: started.error || 'Could not send that for approval.' };
    }

    // The chain exists (or halted, visibly). Move the request's own lifecycle to match, repeating
    // the precondition so a concurrent submit loses the race instead of clobbering.
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_requests
         SET status = 'submitted', submitted_at = COALESCE(submitted_at, NOW()), updated_at = NOW()
       WHERE id = ${requestId}::uuid AND status = 'draft'
      RETURNING id`));

    await logAudit({
      userId,
      action: 'procurement.request.submit',
      entity: 'procurement_request',
      entityId: requestId,
      diff: {
        instanceId: started.instanceId || null,
        state: started.state || null,
        haltReason: started.haltReason || null,
        amount: request.estimatedCost,
      },
    });

    return {
      ok: true,
      id: requestId,
      changed: wrote.length > 0 && started.changed !== false,
      haltReason: started.haltReason ?? null,
    };
  } catch (e: any) {
    logFail('submitRequest', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Withdraw your own request. Only the person who raised it, and only before it is ordered. */
export async function cancelRequest(
  requestId: string,
  userId: string,
  reason: string = '',
): Promise<WriteResult> {
  if (!isUuid(requestId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to withdraw this.' };

  const request = await getRequest(requestId);
  if (!request) return { ok: false, error: NOT_AVAILABLE };
  if (request.requesterUserId !== userId) return { ok: false, error: NOT_AVAILABLE };

  const gate = canTransition(request.status, 'cancelled');
  if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };

  const order = await getOrderForRequest(requestId);
  if (order) {
    return {
      ok: false,
      error: 'A purchase order has already been raised against this, so it cannot be withdrawn here. '
        + 'Ask the procurement desk to cancel order ' + order.poNumber + '.',
    };
  }

  // A SETTLED APPROVAL IS EVIDENCE, and withdrawing on top of one would rewrite the record of a
  // decision somebody actually made — the same rule src/lib/workflow.ts enforces with its own
  // terminal states. Withdrawing is for a request nobody has finished deciding.
  const settled = await instanceForRecord('procurement', requestId);
  if (settled && (settled.state === 'approved' || settled.state === 'rejected')) {
    return {
      ok: false,
      error: 'This request has already been ' + settled.state + ', so it cannot be withdrawn. '
        + 'If you no longer need it, say so on the request rather than removing the decision.',
    };
  }

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_requests
         SET status = 'cancelled', cancelled_at = NOW(),
             cancel_reason = ${text(reason, MAX_TEXT)}::text, updated_at = NOW()
       WHERE id = ${requestId}::uuid AND requester_user_id = ${userId}::uuid AND status = ${request.status}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That request changed while this page was open. Reload it and try again.' };
    }

    // WITHDRAW THE APPROVAL TOO, through the engine's own cancelWorkflow — which checks that this
    // person raised it. Imported dynamically so this module takes no load-time dependency on the
    // engine's write path, and never blocking: the request IS withdrawn, and an approval left
    // pending on a withdrawn request is visible and fixable, whereas a refusal here would leave the
    // person unable to withdraw at all.
    try {
      const { cancelWorkflow } = await import('@/lib/workflow');
      const instance = await instanceForRecord('procurement', requestId);
      if (instance) await cancelWorkflow(instance.id, { id: userId }, text(reason, MAX_LINE) || 'Withdrawn by the requester');
    } catch (e: any) {
      logFail('cancelRequest.cancelWorkflow', e);
    }

    await logAudit({
      userId,
      action: 'procurement.request.cancel',
      entity: 'procurement_request',
      entityId: requestId,
      diff: { reason: text(reason, MAX_TEXT) },
    });
    return { ok: true, id: requestId, changed: true };
  } catch (e: any) {
    logFail('cancelRequest', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface OrderInput {
  requestId: string;
  vendorId?: string | null;
  vendorName?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  expectedDate?: string | null;
  notes?: string | null;
}

/**
 * Generate the next purchase-order number: PO-<year>-<sequence>, zero padded.
 *
 * Derived from the highest number already issued THIS YEAR rather than from a counter table, so
 * there is no second place for the sequence to live and get out of step with the rows. The unique
 * index on po_number is what makes a collision impossible if two people press the button at once —
 * the loser retries once with the next number.
 */
async function nextOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = 'PO-' + year + '-';
  const r = rows(await db.execute(sql`
    SELECT po_number FROM procurement_orders
     WHERE po_number LIKE ${prefix + '%'}
     ORDER BY po_number DESC LIMIT 1`));
  let n = 1;
  if (r.length && r[0]?.po_number) {
    const tail = String(r[0].po_number).slice(prefix.length);
    const parsed = parseInt(tail, 10);
    if (Number.isFinite(parsed)) n = parsed + 1;
  }
  return prefix + String(n).padStart(4, '0');
}

/**
 * RAISE A PURCHASE ORDER against an APPROVED request.
 *
 * THE APPROVAL IS READ FROM THE ENGINE, EVERY TIME. Not from a column here, not from what the screen
 * was showing when the button was rendered: getInstance() is asked at the moment of the write, and
 * anything other than state 'approved' refuses with the state's own name. A purchase order raised
 * against a request that was rejected while the tab was open is real money spent on an unapproved
 * thing, and the only defence against it is asking at the write rather than at the render.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST BRING ONE. `actorUserId` is for the audit trail.
 * /admin/procurement gates this; a new caller gets no gate from this function.
 */
export async function raiseOrder(input: OrderInput, actorUserId: string | null): Promise<WriteResult> {
  const requestId = String(input?.requestId || '').trim();
  if (!isUuid(requestId)) return { ok: false, error: NOT_AVAILABLE };

  const request = await getRequest(requestId);
  if (!request) return { ok: false, error: NOT_AVAILABLE };

  const instance = await instanceForRecord('procurement', requestId);
  if (!instance) {
    return { ok: false, error: 'This request has not been sent for approval yet, so there is nothing to order against.' };
  }
  const live = await getInstance(instance.id);
  if (!live || live.state !== 'approved') {
    return {
      ok: false,
      error: 'That request is not approved. It is currently "' + (live?.state || instance.state) + '". '
        + 'A purchase order can only be raised against an approved request.',
    };
  }

  const existing = await getOrderForRequest(requestId);
  if (existing) {
    return { ok: true, id: existing.id, changed: false, error: undefined };
  }

  const amount = num(input?.amount) ?? request.estimatedCost;
  if (amount !== null && amount < 0) return { ok: false, error: 'An order amount cannot be negative.' };

  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  const vendorId = isUuid(input?.vendorId) ? String(input?.vendorId) : request.vendorId;
  let vendorName = text(input?.vendorName);
  if (!vendorName && vendorId) {
    const v = await getVendor(vendorId);
    vendorName = v?.name || null;
  }
  if (!vendorName) vendorName = request.vendorSuggestion;

  try {
    // TWO ATTEMPTS, AND NO MORE. The one failure worth retrying is two people pressing the button in
    // the same second, where the loser hits the unique index on po_number and the next number is
    // free. A retry LOOP would hide a real, repeatable fault behind three seconds of trying.
    //
    // The OTHER unique index — one live order per request — must NOT be retried at all: it means an
    // order already exists, so the caller's intent is satisfied and the answer is that order, read
    // back and reported as a no-op rather than as an error.
    let lastError: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const poNumber = await nextOrderNumber();
      try {
        const ins = rows(await db.execute(sql`
          INSERT INTO procurement_orders
            (po_number, request_id, vendor_id, vendor_name, ordered_by_user_id, expected_date,
             amount, currency, notes, status)
          VALUES
            (${poNumber}, ${requestId}::uuid, ${vendorId}::uuid, ${vendorName}::text,
             ${isUuid(actorUserId) ? actorUserId : null}::uuid, ${text(input?.expectedDate, 10)}::date,
             ${amount}::numeric, ${text(input?.currency, 8) || request.currency}, ${text(input?.notes, MAX_TEXT)}::text,
             'open')
          RETURNING id, po_number`));
        if (!ins.length) {
          logFail('raiseOrder', new Error('insert returned no row for request ' + requestId));
          return { ok: false, error: WRITE_FAILED };
        }
        const id = String(ins[0].id);
        await logAudit({
          userId: isUuid(actorUserId) ? actorUserId : null,
          action: 'procurement.order.raise',
          entity: 'procurement_order',
          entityId: id,
          diff: { poNumber: String(ins[0].po_number), requestId, amount, vendorId, instanceId: instance.id },
        });
        await notifyRequester(request, 'Purchase order ' + String(ins[0].po_number) + ' raised',
          request.item + ' has been ordered.');
        return { ok: true, id, changed: true };
      } catch (e: any) {
        lastError = e;
        logFail('raiseOrder.insert(attempt ' + (attempt + 1) + ')', e);
        // Did we lose the ONE-ORDER-PER-REQUEST race rather than the po_number one? Then there is a
        // real order and retrying would only lose again. Report the winner.
        const raced = await getOrderForRequest(requestId);
        if (raced) return { ok: true, id: raced.id, changed: false };
      }
    }
    // Both attempts failed and no order exists. The real Postgres cause is already in the log, and
    // this is reported as a FAILURE — never as a quiet success, because a purchase order that does
    // not exist and says it does is a thing nobody orders and everybody waits for.
    logFail('raiseOrder', lastError);
    return { ok: false, error: WRITE_FAILED };
  } catch (e: any) {
    logFail('raiseOrder', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface ReceiptInput {
  orderId: string;
  note?: string | null;
  /** A shared link to the receipt or invoice. Never an upload. */
  receiptUrl?: string | null;
  /** The tag this item carries in the asset register, when it became an asset. */
  assetTag?: string | null;
}

/**
 * CONFIRM THAT THE THING ARRIVED, and record the asset tag if it became company property.
 *
 * The UPDATE repeats `status = 'open'`, so a second confirmation touches zero rows and is reported
 * as a no-op rather than overwriting the first person's receipt with a later timestamp.
 *
 * THE ASSET TAG IS A REFERENCE, NOT A FOREIGN KEY. The asset register is another module's table and
 * this one neither creates nor assumes it — see assetRegisterStatus(). Recording the tag is what
 * lets the two be matched; inventing a row in somebody else's table is what breaks both.
 *
 * NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST BRING ONE.
 */
export async function confirmReceipt(input: ReceiptInput, actorUserId: string | null): Promise<WriteResult> {
  const orderId = String(input?.orderId || '').trim();
  if (!isUuid(orderId)) return { ok: false, error: 'That order is not available.' };

  const receipt = input?.receiptUrl ? normaliseLink(input.receiptUrl) : null;
  if (input?.receiptUrl && !receipt) {
    return { ok: false, error: 'That receipt link does not look like a link. It should start with https://' };
  }
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_orders
         SET status = 'received',
             received_at = NOW(),
             received_by_user_id = ${isUuid(actorUserId) ? actorUserId : null}::uuid,
             receipt_note = ${text(input?.note, MAX_TEXT)}::text,
             receipt_url = ${receipt}::text,
             asset_tag = ${text(input?.assetTag, 80)}::text,
             updated_at = NOW()
       WHERE id = ${orderId}::uuid AND status = 'open'
      RETURNING id, po_number, request_id`));

    if (!wrote.length) {
      return { ok: false, error: 'That order is not open for a receipt. Reload the page to see where it is.' };
    }

    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'procurement.order.receive',
      entity: 'procurement_order',
      entityId: orderId,
      diff: { assetTag: text(input?.assetTag, 80), hasReceiptLink: !!receipt },
    });

    const reqId = wrote[0]?.request_id ? String(wrote[0].request_id) : '';
    if (isUuid(reqId)) {
      const request = await getRequest(reqId);
      if (request) {
        await notifyRequester(request, 'Received: ' + request.item,
          'Order ' + String(wrote[0].po_number) + ' has been marked received.');
      }
    }
    return { ok: true, id: orderId, changed: true };
  } catch (e: any) {
    logFail('confirmReceipt', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Cancel an order that will not arrive. The request keeps its history; nothing is deleted. */
export async function cancelOrder(
  orderId: string,
  actorUserId: string | null,
  reason: string = '',
): Promise<WriteResult> {
  if (!isUuid(orderId)) return { ok: false, error: 'That order is not available.' };
  if (!(await schemaReady())) return { ok: false, error: SCHEMA_FAILED };
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE procurement_orders
         SET status = 'cancelled',
             notes = COALESCE(notes || ' | ', '') || ${'Cancelled: ' + (text(reason, MAX_LINE) || 'no reason given')},
             updated_at = NOW()
       WHERE id = ${orderId}::uuid AND status = 'open'
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'Only an open order can be cancelled.' };
    await logAudit({
      userId: isUuid(actorUserId) ? actorUserId : null,
      action: 'procurement.order.cancel',
      entity: 'procurement_order',
      entityId: orderId,
      diff: { reason: text(reason, MAX_TEXT) },
    });
    return { ok: true, id: orderId, changed: true };
  } catch (e: any) {
    logFail('cancelOrder', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Tell the person who raised a request that something happened to it.
 *
 * sendPushToUser() (src/lib/push.ts) is THE existing notifier — it writes the in-app row AND sends
 * the browser push, and it de-duplicates identical messages inside two minutes, which is exactly the
 * retried-POST case. Nothing here writes to `notifications` directly and there is no second notifier.
 *
 * NEVER BLOCKS THE WRITE IT ANNOUNCES. A failed notification is logged and swallowed: an order that
 * was raised and not announced is a person who has to look at the page, and an order refused because
 * a push endpoint was stale is a person who cannot work. This is the ONE place in this file a caught
 * error does not fail the operation, and the reason is written here rather than assumed.
 */
async function notifyRequester(request: PurchaseRequest, title: string, body: string): Promise<void> {
  if (!request.requesterUserId) return;
  try {
    await sendPushToUser(request.requesterUserId, {
      type: 'procurement_update',
      title,
      body,
      url: '/portal/employee/procurement',
      tag: 'procurement-' + request.id,
    });
  } catch (e: any) {
    logFail('notifyRequester', e);
  }
}

// -------------------------------------------------------------------------------------------------
// SUMMARY READS, for a console header that must not lie about what it counted.
// -------------------------------------------------------------------------------------------------

export interface ProcurementSummary {
  drafts: number;
  submitted: number;
  openOrders: number;
  receivedOrders: number;
  vendors: number;
  /** True when a count could not be read. A screen must say so rather than render a confident 0. */
  degraded: boolean;
}

export async function procurementSummary(): Promise<ProcurementSummary> {
  const empty: ProcurementSummary = {
    drafts: 0, submitted: 0, openOrders: 0, receivedOrders: 0, vendors: 0, degraded: true,
  };
  try {
    await ensureProcurementSchema();
    const r = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM procurement_requests WHERE status = 'draft')      AS drafts,
        (SELECT COUNT(*)::int FROM procurement_requests WHERE status = 'submitted')  AS submitted,
        (SELECT COUNT(*)::int FROM procurement_orders   WHERE status = 'open')       AS open_orders,
        (SELECT COUNT(*)::int FROM procurement_orders   WHERE status = 'received')   AS received_orders,
        (SELECT COUNT(*)::int FROM procurement_vendors  WHERE is_active = true)      AS vendors`));
    if (!r.length) return empty;
    return {
      drafts: Number(r[0].drafts) || 0,
      submitted: Number(r[0].submitted) || 0,
      openOrders: Number(r[0].open_orders) || 0,
      receivedOrders: Number(r[0].received_orders) || 0,
      vendors: Number(r[0].vendors) || 0,
      degraded: false,
    };
  } catch (e: any) {
    logFail('procurementSummary', e);
    return empty;
  }
}
