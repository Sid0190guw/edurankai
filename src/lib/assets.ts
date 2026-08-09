// src/lib/assets.ts — THE ASSET REGISTER. What the company owns, who is holding it, and everything
// that has happened to it.
//
// =================================================================================================
// WHY THIS EXISTS AT ALL, AND WHAT IT REPLACES
// =================================================================================================
//
// Before this module the entire record of company equipment was ONE BOOLEAN: hr_separation
// .assets_returned, ticked by hand on the day somebody leaves. Nothing behind it said what they had,
// when they got it, or whether it came back — so "assets returned: yes" was an assertion nobody
// could check. This module is what that checkbox should have been able to point at.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   AUTHORIZATION  src/lib/auth/permissions.ts through holdsCapability(). One capability,
//                  `assets.manage`, asked for and never derived. An EMPLOYEE needs no capability to
//                  see what they are holding or to report it damaged — that is a fact about their
//                  own row, narrowed in the WHERE clause, and gating it would lock out the people it
//                  is for (an employee's account often carries the `applicant` role, which holds
//                  nothing).
//   APPROVAL       src/lib/workflow.ts, via src/lib/helpdesk.ts. ASKING for an asset is a helpdesk
//                  ticket in the `asset_request` category and is approved by the requester's own
//                  reporting line through the workflow engine. This module ISSUES what was approved;
//                  it decides nothing.
//   AUDIT          logAudit() (src/lib/audit.ts). NOTIFICATION: sendPushToUser() (src/lib/push.ts).
//
// =================================================================================================
// THREE TABLES, BECAUSE THREE DIFFERENT QUESTIONS GET ASKED
// =================================================================================================
//
//   assets              WHAT EXISTS. One row per thing, whatever state it is in.
//   asset_assignments   WHO HAS IT, AND WHO HAD IT. One row per issue, closed by a return. This is
//                       the table that answers "everything Priya has ever been given" long after she
//                       has given it all back — which a mutable `current_holder` column on `assets`
//                       could not, and which is exactly what a separation checklist needs.
//   asset_events        WHAT HAPPENED. Append-only. Registered, issued, returned, damage reported,
//                       sent for repair, retired, lost. The history is not derived from the other
//                       two tables because a derived history quietly loses everything that did not
//                       change a column - a damage report on an asset that stayed with its holder
//                       being the obvious one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import { holdsCapability } from '@/lib/auth/capability';
import { employeeIdForUser } from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — declared ABOVE everything that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[assets] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const NOT_AVAILABLE = 'That asset is not available.';
const NEEDS_CAPABILITY = 'Keeping the asset register is a separate authority. Ask whoever holds it.';

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

export const ASSET_KINDS = ['laptop', 'desktop', 'mobile', 'monitor', 'accessory', 'software_licence'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
const KIND_SET = new Set<string>(ASSET_KINDS);
export function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && KIND_SET.has(v);
}

/** Plain words from a FUNCTION — a `Record<string,string>` read inside .astro JSX is a known parse
 *  hazard on this project, and every consumer of these labels is an .astro file. */
export function kindLabel(kind: string): string {
  const k = String(kind || '');
  if (k === 'laptop') return 'Laptop';
  if (k === 'desktop') return 'Desktop';
  if (k === 'mobile') return 'Mobile';
  if (k === 'monitor') return 'Monitor';
  if (k === 'accessory') return 'Accessory';
  if (k === 'software_licence') return 'Software licence';
  return 'Asset';
}

/**
 * THE STATES OF A THING.
 *
 *   in_stock  the company has it and nobody is holding it.
 *   assigned  somebody is holding it. There is an OPEN row in asset_assignments saying who.
 *   repair    away being fixed. Nobody is holding it, and it is not available to issue.
 *   retired   end of life. Terminal.
 *   lost      not recovered. Terminal, and deliberately NOT the same as retired: one is a decision
 *             and the other is a loss, and a register that spelled them the same way would make
 *             "how much have we lost" unanswerable.
 */
export const ASSET_STATUSES = ['in_stock', 'assigned', 'repair', 'retired', 'lost'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export function assetStatusLabel(s: string): string {
  const k = String(s || '');
  if (k === 'in_stock') return 'In stock';
  if (k === 'assigned') return 'Issued';
  if (k === 'repair') return 'In repair';
  if (k === 'retired') return 'Retired';
  if (k === 'lost') return 'Lost';
  return 'Unknown';
}

export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'damaged'] as const;
const CONDITION_SET = new Set<string>(ASSET_CONDITIONS);
export function conditionLabel(c: string): string {
  const k = String(c || '');
  if (k === 'new') return 'New';
  if (k === 'good') return 'Good';
  if (k === 'fair') return 'Fair';
  if (k === 'damaged') return 'Damaged';
  return 'Unrecorded';
}

/**
 * from -> the states it may move to. `assigned` is NOT reachable from this map: an asset becomes
 * issued by assignAsset() writing an assignment row, and comes back by returnAsset() closing it. A
 * status button that could set `assigned` without an assignment row would produce an asset that is
 * out with nobody, which is precisely the fiction this register exists to end.
 */
const STATUS_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  in_stock: ['repair', 'retired', 'lost'],
  assigned: ['lost'],
  repair: ['in_stock', 'retired', 'lost'],
  retired: [],
  lost: ['in_stock'],
};

export interface AssetTransitionCheck {
  ok: boolean;
  reason: string | null;
  allowed: AssetStatus[];
}

/** Returns an OBJECT, not a boolean — `if (canChangeStatus(a, b))` is always true. Same shape as
 *  helpdesk.ts and workflow.ts canTransition, on purpose. */
export function canChangeStatus(from: string, to: string): AssetTransitionCheck {
  const a = (ASSET_STATUSES as readonly string[]).indexOf(String(from)) >= 0 ? (from as AssetStatus) : null;
  const b = (ASSET_STATUSES as readonly string[]).indexOf(String(to)) >= 0 ? (to as AssetStatus) : null;
  if (!a) return { ok: false, reason: 'That asset is in a state the register does not recognise.', allowed: [] };
  if (!b) return { ok: false, reason: 'That is not a state we track.', allowed: [] };
  if (a === b) return { ok: false, reason: 'It is already ' + assetStatusLabel(b).toLowerCase() + '.', allowed: [] };
  const allowed = STATUS_TRANSITIONS[a] || [];
  if (allowed.indexOf(b) < 0) {
    return {
      ok: false,
      allowed,
      reason: a === 'assigned' && b === 'in_stock'
        ? 'Record the return instead — that is what puts it back in stock and closes the assignment.'
        : (allowed.length
          ? assetStatusLabel(a) + ' does not move to ' + assetStatusLabel(b) + '. From here it can go to: '
            + allowed.map((s) => assetStatusLabel(s).toLowerCase()).join(', ') + '.'
          : assetStatusLabel(a) + ' is final; it does not move to ' + assetStatusLabel(b) + '.'),
    };
  }
  return { ok: true, reason: null, allowed };
}

export const ASSET_EVENTS = ['registered', 'issued', 'returned', 'damage_reported', 'repair', 'retired', 'lost', 'note'] as const;
export type AssetEventKind = (typeof ASSET_EVENTS)[number];

export function eventLabel(e: string): string {
  const k = String(e || '');
  if (k === 'registered') return 'Registered';
  if (k === 'issued') return 'Issued';
  if (k === 'returned') return 'Returned';
  if (k === 'damage_reported') return 'Damage reported';
  if (k === 'repair') return 'Sent for repair';
  if (k === 'retired') return 'Retired';
  if (k === 'lost') return 'Marked lost';
  return 'Note';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

export function ensureAssetSchema(): Promise<void> {
  return ensureOnce('assets_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS assets (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tag            TEXT NOT NULL,
        kind           TEXT NOT NULL,
        name           TEXT NOT NULL,
        make           TEXT,
        model          TEXT,
        serial_no      TEXT,
        status         TEXT NOT NULL DEFAULT 'in_stock',
        condition      TEXT NOT NULL DEFAULT 'good',
        purchase_date  DATE,
        warranty_until DATE,
        cost           NUMERIC(14,2),
        currency       TEXT,
        licence_seats  INT,
        licence_expires_on DATE,
        notes          TEXT,
        created_by     UUID,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, INCLUDING one missing columns —
      // the hr_employees.work_email failure. Every column is asserted again.
      for (const q of [
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS make TEXT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS model TEXT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS serial_no TEXT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_stock'`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'good'`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS purchase_date DATE`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS warranty_until DATE`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS cost NUMERIC(14,2)`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS currency TEXT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS licence_seats INT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS licence_expires_on DATE`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS notes TEXT`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS created_by UUID`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      // ONE ASSET PER TAG, ENFORCED BY THE DATABASE. The tag is what is physically stuck on the
      // laptop, so two rows sharing one means two histories for one object and no way to tell which
      // is the real one. Its own try/catch: if existing data violates it the index fails to create
      // and the log names the real reason, but the table is already built and the register works.
      try {
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS assets_tag_uq ON assets (lower(tag))`);
      } catch (e: any) {
        logFail('assets_tag_uq', e);
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS assets_status_idx ON assets (status, kind, created_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS asset_assignments (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id         UUID NOT NULL,
        employee_id      UUID NOT NULL,
        assigned_by      UUID,
        assigned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expected_return_on DATE,
        issued_condition TEXT,
        returned_at      TIMESTAMPTZ,
        returned_by      UUID,
        returned_condition TEXT,
        return_note      TEXT,
        damage_reported_at TIMESTAMPTZ,
        note             TEXT,
        status           TEXT NOT NULL DEFAULT 'active'
      )`);
      for (const q of [
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS assigned_by UUID`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS expected_return_on DATE`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS issued_condition TEXT`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS returned_by UUID`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS returned_condition TEXT`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS return_note TEXT`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS damage_reported_at TIMESTAMPTZ`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS note TEXT`,
        sql`ALTER TABLE asset_assignments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
      ]) {
        await db.execute(q);
      }
      // ONE OPEN ASSIGNMENT PER ASSET, ENFORCED BY THE DATABASE. A partial unique index, because a
      // closed assignment is history and there may be many. Without this, a double-submitted issue
      // form puts one laptop in two people's hands on the register.
      try {
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_open_uq
          ON asset_assignments (asset_id) WHERE status = 'active'`);
      } catch (e: any) {
        logFail('asset_assignments_open_uq', e);
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS asset_assignments_employee_idx
        ON asset_assignments (employee_id, status, assigned_at DESC)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS asset_events (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id      UUID NOT NULL,
        assignment_id UUID,
        employee_id   UUID,
        event         TEXT NOT NULL,
        note          TEXT,
        actor_user_id UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS assignment_id UUID`,
        sql`ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS employee_id UUID`,
        sql`ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS note TEXT`,
        sql`ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS actor_user_id UUID`,
        sql`ALTER TABLE asset_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS asset_events_asset_idx ON asset_events (asset_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS asset_events_employee_idx ON asset_events (employee_id, created_at DESC)`);
    } catch (e: any) {
      logFail('ensureAssetSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface Asset {
  id: string;
  tag: string;
  kind: string;
  name: string;
  make: string | null;
  model: string | null;
  serialNo: string | null;
  status: string;
  condition: string;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  cost: number | null;
  currency: string | null;
  licenceSeats: number | null;
  licenceExpiresOn: string | null;
  notes: string | null;
  createdAt: string | null;
  /** Present on list/detail reads that join the open assignment. */
  holderEmployeeId?: string | null;
  holderName?: string | null;
  assignedAt?: string | null;
  expectedReturnOn?: string | null;
  assignmentId?: string | null;
}

export interface AssetAssignment {
  id: string;
  assetId: string;
  employeeId: string;
  employeeName: string | null;
  assetTag: string | null;
  assetName: string | null;
  assetKind: string | null;
  assignedAt: string | null;
  expectedReturnOn: string | null;
  issuedCondition: string | null;
  returnedAt: string | null;
  returnedCondition: string | null;
  returnNote: string | null;
  damageReportedAt: string | null;
  note: string | null;
  status: string;
}

export interface AssetEvent {
  id: string;
  assetId: string;
  assetTag: string | null;
  assetName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  event: string;
  note: string | null;
  createdAt: string | null;
}

export interface AssetResult {
  ok: boolean;
  id?: string;
  changed?: boolean;
  error?: string;
}

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function day(v: any): string | null {
  if (!v) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function mapAsset(r: any): Asset {
  return {
    id: String(r?.id ?? ''),
    tag: String(r?.tag ?? ''),
    kind: String(r?.kind ?? ''),
    name: String(r?.name ?? ''),
    make: r?.make ? String(r.make) : null,
    model: r?.model ? String(r.model) : null,
    serialNo: r?.serial_no ? String(r.serial_no) : null,
    status: String(r?.status ?? 'in_stock'),
    condition: String(r?.condition ?? 'good'),
    purchaseDate: day(r?.purchase_date),
    warrantyUntil: day(r?.warranty_until),
    cost: r?.cost === null || r?.cost === undefined ? null : Number(r.cost),
    currency: r?.currency ? String(r.currency) : null,
    licenceSeats: r?.licence_seats === null || r?.licence_seats === undefined ? null : Number(r.licence_seats),
    licenceExpiresOn: day(r?.licence_expires_on),
    notes: r?.notes ? String(r.notes) : null,
    createdAt: iso(r?.created_at),
    holderEmployeeId: r?.holder_employee_id ? String(r.holder_employee_id) : null,
    holderName: r?.holder_name ? String(r.holder_name) : null,
    assignedAt: iso(r?.assigned_at),
    expectedReturnOn: day(r?.expected_return_on),
    assignmentId: r?.assignment_id ? String(r.assignment_id) : null,
  };
}

function mapAssignment(r: any): AssetAssignment {
  return {
    id: String(r?.id ?? ''),
    assetId: String(r?.asset_id ?? ''),
    employeeId: String(r?.employee_id ?? ''),
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    assetTag: r?.asset_tag ? String(r.asset_tag) : null,
    assetName: r?.asset_name ? String(r.asset_name) : null,
    assetKind: r?.asset_kind ? String(r.asset_kind) : null,
    assignedAt: iso(r?.assigned_at),
    expectedReturnOn: day(r?.expected_return_on),
    issuedCondition: r?.issued_condition ? String(r.issued_condition) : null,
    returnedAt: iso(r?.returned_at),
    returnedCondition: r?.returned_condition ? String(r.returned_condition) : null,
    returnNote: r?.return_note ? String(r.return_note) : null,
    damageReportedAt: iso(r?.damage_reported_at),
    note: r?.note ? String(r.note) : null,
    status: String(r?.status ?? 'active'),
  };
}

function mapEvent(r: any): AssetEvent {
  return {
    id: String(r?.id ?? ''),
    assetId: String(r?.asset_id ?? ''),
    assetTag: r?.asset_tag ? String(r.asset_tag) : null,
    assetName: r?.asset_name ? String(r.asset_name) : null,
    employeeId: r?.employee_id ? String(r.employee_id) : null,
    employeeName: r?.employee_name ? String(r.employee_name) : null,
    event: String(r?.event ?? 'note'),
    note: r?.note ? String(r.note) : null,
    createdAt: iso(r?.created_at),
  };
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

/** The register, with whoever is currently holding each thing joined on. */
export async function listAssets(opts: { kind?: string | null; status?: string | null; q?: string | null; limit?: number } = {}): Promise<Asset[]> {
  return (await readAssets(opts)).rows;
}

/**
 * THE SAME READ, SAYING WHETHER IT WORKED.
 *
 * listAssets() catches its own error and returns [], so a failed read rendered as "Nothing on the
 * register yet. Add the first thing below" — an instruction to REGISTER something that may already
 * be registered, on the screen whose whole job is to be the single record of what the company owns
 * and who is holding it. Duplicating a laptop's tag is not a cosmetic error.
 *
 * `ok:false` means UNKNOWN, never "none".
 */
export async function readAssets(
  opts: { kind?: string | null; status?: string | null; q?: string | null; limit?: number } = {},
): Promise<{ ok: boolean; rows: Asset[]; error: string | null }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  try {
    await ensureAssetSchema();
    const byKind = isAssetKind(opts.kind) ? sql`AND a.kind = ${String(opts.kind)}` : sql``;
    const byStatus = opts.status && (ASSET_STATUSES as readonly string[]).indexOf(String(opts.status)) >= 0
      ? sql`AND a.status = ${String(opts.status)}` : sql``;
    const term = String(opts.q || '').trim();
    // ILIKE with the term BOUND as a parameter, never concatenated into the SQL text.
    const byQ = term
      ? sql`AND (a.tag ILIKE ${'%' + term + '%'} OR a.name ILIKE ${'%' + term + '%'}
                 OR COALESCE(a.serial_no,'') ILIKE ${'%' + term + '%'}
                 OR COALESCE(a.model,'') ILIKE ${'%' + term + '%'})`
      : sql``;

    const r = await db.execute(sql`
      SELECT a.*, asg.id AS assignment_id, asg.employee_id AS holder_employee_id,
             asg.assigned_at, asg.expected_return_on, e.full_name AS holder_name
        FROM assets a
        LEFT JOIN asset_assignments asg ON asg.asset_id = a.id AND asg.status = 'active'
        LEFT JOIN hr_employees e ON e.id = asg.employee_id
       WHERE TRUE ${byKind} ${byStatus} ${byQ}
       ORDER BY (a.status IN ('retired','lost')) ASC, a.created_at DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(mapAsset), error: null };
  } catch (e: any) {
    logFail('readAssets', e);
    // The real Postgres reason is on e.cause; e.message is only the SQL that failed.
    return { ok: false, rows: [], error: String(e?.cause?.message || e?.message || 'unknown database error') };
  }
}

export async function getAsset(assetId: string): Promise<Asset | null> {
  if (!isUuid(assetId)) return null;
  try {
    await ensureAssetSchema();
    const r = rows(await db.execute(sql`
      SELECT a.*, asg.id AS assignment_id, asg.employee_id AS holder_employee_id,
             asg.assigned_at, asg.expected_return_on, e.full_name AS holder_name
        FROM assets a
        LEFT JOIN asset_assignments asg ON asg.asset_id = a.id AND asg.status = 'active'
        LEFT JOIN hr_employees e ON e.id = asg.employee_id
       WHERE a.id = ${assetId}::uuid
       LIMIT 1`));
    return r.length ? mapAsset(r[0]) : null;
  } catch (e: any) {
    logFail('getAsset', e);
    return null;
  }
}

/** EVERYTHING that has happened to one asset, newest first. Append-only, so this is the whole story. */
export async function assetHistory(assetId: string, limit = 100): Promise<AssetEvent[]> {
  if (!isUuid(assetId)) return [];
  try {
    await ensureAssetSchema();
    const r = await db.execute(sql`
      SELECT ev.*, a.tag AS asset_tag, a.name AS asset_name, e.full_name AS employee_name
        FROM asset_events ev
        LEFT JOIN assets a ON a.id = ev.asset_id
        LEFT JOIN hr_employees e ON e.id = ev.employee_id
       WHERE ev.asset_id = ${assetId}::uuid
       ORDER BY ev.created_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 300)}`);
    return rows(r).map(mapEvent);
  } catch (e: any) {
    logFail('assetHistory', e);
    return [];
  }
}

/** EVERYTHING one person has ever been issued, newest first. Open rows and closed ones. */
export async function employeeAssetHistory(employeeId: string, limit = 100): Promise<AssetAssignment[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureAssetSchema();
    const r = await db.execute(sql`
      SELECT asg.*, a.tag AS asset_tag, a.name AS asset_name, a.kind AS asset_kind, e.full_name AS employee_name
        FROM asset_assignments asg
        LEFT JOIN assets a ON a.id = asg.asset_id
        LEFT JOIN hr_employees e ON e.id = asg.employee_id
       WHERE asg.employee_id = ${employeeId}::uuid
       ORDER BY (asg.status = 'active') DESC, asg.assigned_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 300)}`);
    return rows(r).map(mapAssignment);
  } catch (e: any) {
    logFail('employeeAssetHistory', e);
    return [];
  }
}

/**
 * WHAT THIS PERSON IS HOLDING RIGHT NOW.
 *
 * This is the employee-facing read and it is narrowed IN THE WHERE CLAUSE by their own employee id —
 * there is no "all assets" query anywhere behind the employee surface that a filter could be dropped
 * from. Fails closed to an empty list.
 */
export async function employeeAssets(employeeId: string): Promise<AssetAssignment[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureAssetSchema();
    const r = await db.execute(sql`
      SELECT asg.*, a.tag AS asset_tag, a.name AS asset_name, a.kind AS asset_kind, e.full_name AS employee_name
        FROM asset_assignments asg
        JOIN assets a ON a.id = asg.asset_id
        LEFT JOIN hr_employees e ON e.id = asg.employee_id
       WHERE asg.employee_id = ${employeeId}::uuid
         AND asg.status = 'active'
       ORDER BY asg.assigned_at DESC`);
    return rows(r).map(mapAssignment);
  } catch (e: any) {
    logFail('employeeAssets', e);
    return [];
  }
}

export async function assetCounts(): Promise<{ total: number; issued: number; inStock: number; repair: number; retired: number }> {
  const zero = { total: 0, issued: 0, inStock: 0, repair: 0, retired: 0 };
  try {
    await ensureAssetSchema();
    const r = rows(await db.execute(sql`SELECT status, COUNT(*)::int AS n FROM assets GROUP BY status`));
    const out = { ...zero };
    for (const row of r) {
      const n = Number(row?.n) || 0;
      const s = String(row?.status || '');
      out.total += n;
      if (s === 'assigned') out.issued = n;
      else if (s === 'in_stock') out.inStock = n;
      else if (s === 'repair') out.repair = n;
      else if (s === 'retired') out.retired = n;
    }
    return out;
  } catch (e: any) {
    logFail('assetCounts', e);
    return zero;
  }
}

// -------------------------------------------------------------------------------------------------
// INTERNAL
// -------------------------------------------------------------------------------------------------

/** Append to the history. NEVER blocks the write it describes — but its failure IS logged, because a
 *  silently missing event is a hole in the only record of what happened. */
async function recordEvent(
  assetId: string,
  event: AssetEventKind,
  opts: { assignmentId?: string | null; employeeId?: string | null; note?: string | null; actorUserId?: string | null },
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO asset_events (asset_id, assignment_id, employee_id, event, note, actor_user_id)
      VALUES (${assetId}::uuid, ${opts.assignmentId || null}::uuid, ${opts.employeeId || null}::uuid,
              ${event}, ${opts.note ? String(opts.note).slice(0, 2000) : null}::text,
              ${opts.actorUserId || null}::uuid)`);
  } catch (e: any) {
    logFail('recordEvent', e);
  }
}

async function auditAsset(userId: string | null, action: string, assetId: string, diff: Record<string, unknown>): Promise<void> {
  await logAudit({ userId: userId || null, action: 'assets.' + action, entity: 'asset', entityId: assetId, diff });
}

// -------------------------------------------------------------------------------------------------
// WRITES. Every one checks `assets.manage` except reportDamage, which the holder may do.
// -------------------------------------------------------------------------------------------------

export interface RegisterAssetInput {
  tag: string;
  kind: string;
  name: string;
  make?: string | null;
  model?: string | null;
  serialNo?: string | null;
  condition?: string | null;
  purchaseDate?: string | null;
  warrantyUntil?: string | null;
  cost?: number | null;
  currency?: string | null;
  licenceSeats?: number | null;
  licenceExpiresOn?: string | null;
  notes?: string | null;
}

/** Put a thing on the register. */
export async function registerAsset(
  input: RegisterAssetInput,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
): Promise<AssetResult> {
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'assets.manage')) return { ok: false, error: NEEDS_CAPABILITY };

  const tag = String(input?.tag || '').trim().slice(0, 60);
  if (!tag) return { ok: false, error: 'Give it an asset tag — the label that is physically on it.' };
  const kind = String(input?.kind || '').trim();
  if (!isAssetKind(kind)) return { ok: false, error: 'Choose what kind of asset this is.' };
  const name = String(input?.name || '').trim().slice(0, 200);
  if (!name) return { ok: false, error: 'Give it a name somebody would recognise on a list.' };

  const condition = CONDITION_SET.has(String(input?.condition || '')) ? String(input.condition) : 'good';
  const cost = typeof input?.cost === 'number' && isFinite(input.cost) ? input.cost : null;
  const seats = typeof input?.licenceSeats === 'number' && isFinite(input.licenceSeats) ? Math.max(0, Math.floor(input.licenceSeats)) : null;

  try {
    await ensureAssetSchema();
    const ins = rows(await db.execute(sql`
      INSERT INTO assets (tag, kind, name, make, model, serial_no, status, condition,
                          purchase_date, warranty_until, cost, currency, licence_seats,
                          licence_expires_on, notes, created_by)
      VALUES (${tag}, ${kind}, ${name},
              ${input?.make ? String(input.make).slice(0, 120) : null}::text,
              ${input?.model ? String(input.model).slice(0, 120) : null}::text,
              ${input?.serialNo ? String(input.serialNo).slice(0, 120) : null}::text,
              'in_stock', ${condition},
              ${input?.purchaseDate || null}::date, ${input?.warrantyUntil || null}::date,
              ${cost}::numeric, ${input?.currency ? String(input.currency).slice(0, 8) : null}::text,
              ${seats}::int, ${input?.licenceExpiresOn || null}::date,
              ${input?.notes ? String(input.notes).slice(0, 2000) : null}::text,
              ${actorId}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!ins.length) {
      // The unique index on lower(tag) rejected it, which means that tag is already on the register.
      return { ok: false, error: 'An asset with that tag is already on the register. Tags identify one physical object.' };
    }
    const id = String(ins[0].id);
    await recordEvent(id, 'registered', { actorUserId: actorId, note: kindLabel(kind) + ' ' + tag });
    await auditAsset(actorId, 'register', id, { tag, kind, name });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('registerAsset', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Issue an asset to an employee.
 *
 * TWO GUARDS AGAINST ISSUING THE SAME THING TWICE: this reads the asset's state first, and the
 * partial unique index on (asset_id) WHERE status = 'active' rejects a concurrent second insert the
 * read could not have seen. The index is the guarantee; the pre-check is the readable message.
 */
export async function assignAsset(
  assetId: string,
  employeeId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: { expectedReturnOn?: string | null; note?: string | null } = {},
): Promise<AssetResult> {
  if (!isUuid(assetId)) return { ok: false, error: NOT_AVAILABLE };
  if (!isUuid(employeeId)) return { ok: false, error: 'Choose who it is being issued to.' };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'assets.manage')) return { ok: false, error: NEEDS_CAPABILITY };

  try {
    await ensureAssetSchema();
    const asset = await getAsset(assetId);
    if (!asset) return { ok: false, error: NOT_AVAILABLE };
    if (asset.status === 'assigned') {
      return { ok: false, error: 'That is already issued to ' + (asset.holderName || 'somebody') + '. Record the return first.' };
    }
    if (asset.status !== 'in_stock') {
      return { ok: false, error: 'Only something in stock can be issued. That one is ' + assetStatusLabel(asset.status).toLowerCase() + '.' };
    }

    const emp = rows(await db.execute(sql`
      SELECT id, user_id, full_name FROM hr_employees WHERE id = ${employeeId}::uuid AND is_active = true LIMIT 1`));
    if (!emp.length) return { ok: false, error: 'That is not an active employee record.' };

    const ins = rows(await db.execute(sql`
      INSERT INTO asset_assignments (asset_id, employee_id, assigned_by, expected_return_on, issued_condition, note, status)
      VALUES (${assetId}::uuid, ${employeeId}::uuid, ${actorId}::uuid,
              ${opts.expectedReturnOn || null}::date, ${asset.condition}::text,
              ${opts.note ? String(opts.note).slice(0, 2000) : null}::text, 'active')
      ON CONFLICT DO NOTHING
      RETURNING id`));
    if (!ins.length) {
      return { ok: false, error: 'That asset was issued to somebody else a moment ago. Reload the page.' };
    }
    const assignmentId = String(ins[0].id);

    const wrote = rows(await db.execute(sql`
      UPDATE assets SET status = 'assigned', updated_at = NOW()
       WHERE id = ${assetId}::uuid AND status = 'in_stock'
      RETURNING id`));
    if (!wrote.length) {
      // The asset moved underneath us after the assignment row was written. Undo it rather than
      // leave an open assignment against something that is no longer issuable — a write path that
      // half-succeeds is worse than one that refuses.
      await db.execute(sql`DELETE FROM asset_assignments WHERE id = ${assignmentId}::uuid AND status = 'active'`);
      return { ok: false, error: 'That asset changed while this page was open. Reload it and try again.' };
    }

    await recordEvent(assetId, 'issued', {
      assignmentId, employeeId, actorUserId: actorId,
      note: opts.note ? String(opts.note) : null,
    });
    try {
      if (emp[0].user_id) {
        await sendPushToUser(String(emp[0].user_id), {
          type: 'asset_issued',
          title: 'An asset was issued to you',
          body: asset.name + ' (' + asset.tag + ')',
          url: '/portal/employee/assets',
          tag: 'asset-' + assetId,
        });
      }
    } catch (e: any) {
      logFail('assignAsset.notify', e);
    }
    await auditAsset(actorId, 'assign', assetId, { employeeId, assignmentId });
    return { ok: true, id: assignmentId, changed: true };
  } catch (e: any) {
    logFail('assignAsset', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Take it back. Closes the open assignment and puts the asset where its returned condition says. */
export async function returnAsset(
  assignmentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: { condition?: string | null; note?: string | null } = {},
): Promise<AssetResult> {
  if (!isUuid(assignmentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'assets.manage')) return { ok: false, error: NEEDS_CAPABILITY };

  const condition = CONDITION_SET.has(String(opts?.condition || '')) ? String(opts.condition) : 'good';

  try {
    await ensureAssetSchema();
    const found = rows(await db.execute(sql`
      SELECT * FROM asset_assignments WHERE id = ${assignmentId}::uuid LIMIT 1`));
    if (!found.length) return { ok: false, error: NOT_AVAILABLE };
    const asg = mapAssignment(found[0]);
    if (asg.status !== 'active') return { ok: false, error: 'That was already returned.' };

    const wrote = rows(await db.execute(sql`
      UPDATE asset_assignments
         SET status = 'returned', returned_at = NOW(), returned_by = ${actorId}::uuid,
             returned_condition = ${condition},
             return_note = ${opts.note ? String(opts.note).slice(0, 2000) : null}::text
       WHERE id = ${assignmentId}::uuid AND status = 'active'
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That return was already recorded while this page was open.' };
    }

    // A thing that came back broken does not go back into stock as if it were fine.
    const nextStatus = condition === 'damaged' ? 'repair' : 'in_stock';
    await db.execute(sql`
      UPDATE assets SET status = ${nextStatus}, condition = ${condition}, updated_at = NOW()
       WHERE id = ${asg.assetId}::uuid`);

    await recordEvent(asg.assetId, 'returned', {
      assignmentId, employeeId: asg.employeeId, actorUserId: actorId,
      note: 'Returned ' + conditionLabel(condition).toLowerCase() + (opts.note ? ' — ' + String(opts.note) : ''),
    });
    await auditAsset(actorId, 'return', asg.assetId, { assignmentId, condition, nextStatus });
    return { ok: true, id: assignmentId, changed: true };
  } catch (e: any) {
    logFail('returnAsset', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * REPORT DAMAGE. The one write on this module an ordinary employee may make, and only about
 * something they are actually holding.
 *
 * IT IS A REPORT, NOT A VERDICT. It records what the person says, marks the condition damaged so
 * nobody issues it onward believing it is fine, and tells the desk — it does NOT retire the asset,
 * charge anybody, or close the assignment. What happens next is a human decision made on the admin
 * register, which is the same rule this codebase applies to every automated signal: advisory only, a
 * person decides.
 */
export async function reportDamage(
  assetId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  note: string,
): Promise<AssetResult> {
  if (!isUuid(assetId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  const text = String(note || '').trim().slice(0, 2000);
  if (!text) return { ok: false, error: 'Say what happened — the desk cannot act on a blank report.' };

  try {
    await ensureAssetSchema();

    let actorEmployeeId: string | null = null;
    try {
      actorEmployeeId = await employeeIdForUser(actorId);
    } catch (e: any) {
      logFail('reportDamage.employeeIdForUser', e);
      actorEmployeeId = null;
    }

    const open = rows(await db.execute(sql`
      SELECT * FROM asset_assignments WHERE asset_id = ${assetId}::uuid AND status = 'active' LIMIT 1`));
    const assignment = open.length ? mapAssignment(open[0]) : null;

    const isHolder = !!assignment && !!actorEmployeeId && assignment.employeeId === actorEmployeeId;
    if (!isHolder && !holdsCapability(user, 'assets.manage')) {
      return { ok: false, error: 'You can report damage on something issued to you. This one is not.' };
    }

    if (assignment) {
      await db.execute(sql`
        UPDATE asset_assignments SET damage_reported_at = NOW()
         WHERE id = ${assignment.id}::uuid AND status = 'active'`);
    }
    await db.execute(sql`
      UPDATE assets SET condition = 'damaged', updated_at = NOW() WHERE id = ${assetId}::uuid`);

    await recordEvent(assetId, 'damage_reported', {
      assignmentId: assignment?.id || null,
      employeeId: assignment?.employeeId || actorEmployeeId,
      actorUserId: actorId,
      note: text,
    });
    await auditAsset(actorId, 'damage', assetId, { assignmentId: assignment?.id || null, byHolder: isHolder });
    return { ok: true, id: assetId, changed: true };
  } catch (e: any) {
    logFail('reportDamage', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Move an asset between register states — repair, retired, lost, back in stock. */
export async function setAssetStatus(
  assetId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  to: string,
  note: string = '',
): Promise<AssetResult> {
  if (!isUuid(assetId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'assets.manage')) return { ok: false, error: NEEDS_CAPABILITY };

  try {
    await ensureAssetSchema();
    const asset = await getAsset(assetId);
    if (!asset) return { ok: false, error: NOT_AVAILABLE };

    const gate = canChangeStatus(asset.status, to);
    if (!gate.ok) return { ok: false, error: gate.reason || NOT_AVAILABLE };
    const next = to as AssetStatus;

    const wrote = rows(await db.execute(sql`
      UPDATE assets SET status = ${next}, updated_at = NOW()
       WHERE id = ${assetId}::uuid AND status = ${asset.status}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That asset changed while this page was open. Reload it and try again.' };
    }

    // A thing that was lost while somebody was holding it: the assignment is closed, because it is
    // not with them any more and leaving it open would keep it on their profile for ever.
    if (next === 'lost') {
      await db.execute(sql`
        UPDATE asset_assignments
           SET status = 'returned', returned_at = NOW(), returned_by = ${actorId}::uuid,
               returned_condition = 'damaged', return_note = 'Marked lost on the register'
         WHERE asset_id = ${assetId}::uuid AND status = 'active'`);
    }

    const kind: AssetEventKind = next === 'repair' ? 'repair' : next === 'retired' ? 'retired' : next === 'lost' ? 'lost' : 'note';
    await recordEvent(assetId, kind, { actorUserId: actorId, note: String(note || '').slice(0, 2000) || null });
    await auditAsset(actorId, 'status.' + next, assetId, { from: asset.status, to: next });
    return { ok: true, id: assetId, changed: true };
  } catch (e: any) {
    logFail('setAssetStatus', e);
    return { ok: false, error: WRITE_FAILED };
  }
}
