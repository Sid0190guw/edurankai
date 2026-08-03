// src/lib/documents.ts — THE COMPANY DOCUMENT LIBRARY. Folders, categories, versions, sharing,
// retention and search.
//
// =================================================================================================
// DOCUMENTS ARE LINKS. THERE IS NO UPLOAD, AND THERE MUST NEVER BE ONE.
// =================================================================================================
//
// Every document in this library is a GOOGLE DRIVE LINK shared with "anyone with the link". Nothing
// is stored on this platform: no file input exists on any surface built on this module, no blob is
// written, and `drive_url` is the only place a document's content is addressed from. The reason is
// storage cost, it is a standing rule on this project, and it is absolute — the ONE stored upload
// anywhere in the product is a small resized profile photo.
//
// isDriveLink() below enforces it at the WRITE, not merely in the form: a URL that is not on
// drive.google.com or docs.google.com is refused with a sentence saying why. A validator that lived
// only in the browser would be one fetch away from a file store nobody decided to build.
//
// SHARING IS THE AUTHOR'S JOB AND WE SAY SO. This module cannot verify that a link is actually set
// to "anyone with the link" — checking would mean calling Google as an authenticated client, which
// this platform deliberately does not do. So every surface states the requirement, and a document
// whose link nobody can open is a broken document, not a silent one.
//
// =================================================================================================
// WHAT THIS IS NOT A SECOND COPY OF
// =================================================================================================
//
//   APPROVAL       src/lib/workflow.ts, domain 'documents'. A document is signed off by the person
//                  the ORGANIZATION GRAPH routes it to - the owner's reporting line - and by nobody
//                  else. THE APPROVAL STATE IS NOT MIRRORED INTO A COLUMN HERE: it is read back from
//                  the engine with instanceForRecord() every time it is needed, because two copies
//                  of one state is how the two start disagreeing about whether a policy was signed.
//   AUTHORIZATION  src/lib/auth/permissions.ts through holdsCapability(). One capability,
//                  `documents.manage`, and it is CURATION - folders, categories, retention, sharing
//                  wider. It confers NO approval over anybody: a curator with no relationship to the
//                  owner approves nothing, which is the whole point of routing per row.
//   JOINING PAPERS hr_onboarding_documents (db/hr-schema.sql:417) is a DIFFERENT thing and is left
//                  alone: those are one person's own joining papers, keyed by users.id, reviewed by
//                  HR. This is the company library. They are not merged, because "my PAN card" and
//                  "the travel policy" have nothing in common but the word document.
//   AUDIT          logAudit(). NOTIFICATION: sendPushToUser(). The existing ones, and no others.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { sendPushToUser } from '@/lib/push';
import { holdsCapability } from '@/lib/auth/capability';
import { startWorkflow, resumeWorkflow, instanceForRecord, type WorkflowInstanceRow } from '@/lib/workflow';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — declared ABOVE everything that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[documents] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const NOT_AVAILABLE = 'That document is not available.';
const NEEDS_CAPABILITY = 'Curating the library is a separate authority. Ask whoever holds it.';

/** The only two hosts a document may live on. Enforced at the write. */
const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];

/** Said in full wherever a link is refused, because "invalid URL" teaches nobody the rule. */
export const DRIVE_RULE =
  'Documents here are links, never uploads. Put the file in Google Drive, set it to "Anyone with the link", '
  + 'and paste that link. Nothing is stored on this platform.';

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

export const DOCUMENT_CATEGORIES = ['policy', 'handbook', 'contract', 'sop', 'template', 'report', 'other'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
const CATEGORY_SET = new Set<string>(DOCUMENT_CATEGORIES);
export function isDocumentCategory(v: unknown): v is DocumentCategory {
  return typeof v === 'string' && CATEGORY_SET.has(v);
}

/** Plain words from a FUNCTION — a `Record<string,string>` read inside .astro JSX is a known parse
 *  hazard on this project. */
export function categoryLabel(c: string): string {
  const k = String(c || '');
  if (k === 'policy') return 'Policy';
  if (k === 'handbook') return 'Handbook';
  if (k === 'contract') return 'Contract';
  if (k === 'sop') return 'Process / SOP';
  if (k === 'template') return 'Template';
  if (k === 'report') return 'Report';
  return 'Other';
}

/**
 *   private     the owner, plus whoever it has been shared with by name.
 *   department  everyone in the owner's department, once it is published.
 *   company     everyone with an employee record, once it is published.
 *
 * PUBLISHED IS PART OF EVERY WIDE ANSWER. A draft is never company-visible however its visibility is
 * set, because "I have not finished writing the redundancy policy" and "the redundancy policy" must
 * not be the same row on somebody's screen.
 */
export const DOCUMENT_VISIBILITIES = ['private', 'department', 'company'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];
const VISIBILITY_SET = new Set<string>(DOCUMENT_VISIBILITIES);

export function visibilityLabel(v: string): string {
  const k = String(v || '');
  if (k === 'department') return 'My department';
  if (k === 'company') return 'Everyone at the company';
  return 'Only me and people I share it with';
}

/**
 *   draft      being written. Only the owner and named shares can see it.
 *   in_review  an approval is LIVE on it. Not a claim that anybody has agreed to anything.
 *   published  approved and released to its audience.
 *   retired    superseded or withdrawn. Kept, never deleted — a retired policy is the evidence of
 *              what the rule used to be, and that question gets asked in exactly the arguments where
 *              deleting it would be worst.
 */
export const DOCUMENT_STATUSES = ['draft', 'in_review', 'published', 'retired'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function statusLabel(s: string): string {
  const k = String(s || '');
  if (k === 'draft') return 'Draft';
  if (k === 'in_review') return 'In review';
  if (k === 'published') return 'Published';
  if (k === 'retired') return 'Retired';
  return 'Unknown';
}

/**
 * IS THIS A DRIVE LINK?
 *
 * Host is compared against a fixed list after parsing, never by substring: 'drive.google.com.evil.tld'
 * contains 'drive.google.com' and is not Google. Sub-domains are accepted only as an exact suffix
 * preceded by a dot, which 'x.drive.google.com' satisfies and 'notdrive.google.com' does not.
 */
export function isDriveLink(url: string): boolean {
  const raw = String(url || '').trim();
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return DRIVE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

export function ensureDocumentSchema(): Promise<void> {
  return ensureOnce('documents_v1', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS document_folders (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        description TEXT,
        parent_id   UUID,
        created_by  UUID,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS description TEXT`,
        sql`ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS parent_id UUID`,
        sql`ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS created_by UUID`,
        sql`ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }

      await db.execute(sql`CREATE TABLE IF NOT EXISTS documents (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        folder_id         UUID,
        title             TEXT NOT NULL,
        description       TEXT,
        category          TEXT NOT NULL DEFAULT 'other',
        drive_url         TEXT NOT NULL,
        owner_employee_id UUID,
        owner_user_id     UUID,
        visibility        TEXT NOT NULL DEFAULT 'private',
        department_id     TEXT,
        status            TEXT NOT NULL DEFAULT 'draft',
        current_version   INT NOT NULL DEFAULT 1,
        retention_until   DATE,
        retention_note    TEXT,
        published_at      TIMESTAMPTZ,
        retired_at        TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, INCLUDING one missing columns.
      for (const q of [
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id UUID`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS description TEXT`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_employee_id UUID`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_user_id UUID`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'`,
        // TEXT, NOT UUID, AND NEVER CAST TO ONE. departments.id is varchar(50) - a slug - in
        // src/lib/db/schema.ts and UUID in db/hr-schema.sql. A ::uuid cast throws
        // `invalid input syntax for type uuid` the first time a slug arrives, and half this
        // product's department ids are slugs. Every comparison against it below is ::text.
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS department_id TEXT`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_version INT NOT NULL DEFAULT 1`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_until DATE`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_note TEXT`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (folder_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents (owner_employee_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_visibility_idx ON documents (status, visibility, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_retention_idx ON documents (retention_until) WHERE retention_until IS NOT NULL`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS document_versions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL,
        version     INT NOT NULL,
        drive_url   TEXT NOT NULL,
        change_note TEXT,
        created_by  UUID,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS change_note TEXT`,
        sql`ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS created_by UUID`,
        sql`ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      // ONE ROW PER VERSION NUMBER PER DOCUMENT, ENFORCED BY THE DATABASE — a retried "save new
      // version" POST on a phone with one bar cannot produce two version 3s.
      try {
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS document_versions_uq
          ON document_versions (document_id, version)`);
      } catch (e: any) {
        logFail('document_versions_uq', e);
      }

      await db.execute(sql`CREATE TABLE IF NOT EXISTS document_shares (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id   UUID NOT NULL,
        employee_id   UUID,
        department_id TEXT,
        shared_by     UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      for (const q of [
        sql`ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS employee_id UUID`,
        sql`ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS department_id TEXT`,
        sql`ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS shared_by UUID`,
        sql`ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      ]) {
        await db.execute(q);
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS document_shares_doc_idx ON document_shares (document_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS document_shares_emp_idx ON document_shares (employee_id)`);
    } catch (e: any) {
      logFail('ensureDocumentSchema', e);
      throw e;
    }
  });
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface DocumentFolder {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  documentCount: number;
}

export interface LibraryDocument {
  id: string;
  folderId: string | null;
  folderName: string | null;
  title: string;
  description: string | null;
  category: string;
  driveUrl: string;
  ownerEmployeeId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  visibility: string;
  departmentId: string | null;
  status: string;
  currentVersion: number;
  retentionUntil: string | null;
  retentionNote: string | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  driveUrl: string;
  changeNote: string | null;
  createdAt: string | null;
}

export interface DocumentShare {
  id: string;
  documentId: string;
  employeeId: string | null;
  employeeName: string | null;
  departmentId: string | null;
  createdAt: string | null;
}

export interface DocumentResult {
  ok: boolean;
  id?: string;
  changed?: boolean;
  error?: string;
  /** Set when an approval could not be routed. The engine's sentence, verbatim. */
  haltReason?: string | null;
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

function mapDocument(r: any): LibraryDocument {
  return {
    id: String(r?.id ?? ''),
    folderId: r?.folder_id ? String(r.folder_id) : null,
    folderName: r?.folder_name ? String(r.folder_name) : null,
    title: String(r?.title ?? ''),
    description: r?.description ? String(r.description) : null,
    category: String(r?.category ?? 'other'),
    driveUrl: String(r?.drive_url ?? ''),
    ownerEmployeeId: r?.owner_employee_id ? String(r.owner_employee_id) : null,
    ownerUserId: r?.owner_user_id ? String(r.owner_user_id) : null,
    ownerName: r?.owner_name ? String(r.owner_name) : null,
    visibility: String(r?.visibility ?? 'private'),
    departmentId: r?.department_id ? String(r.department_id) : null,
    status: String(r?.status ?? 'draft'),
    currentVersion: Number(r?.current_version) || 1,
    retentionUntil: day(r?.retention_until),
    retentionNote: r?.retention_note ? String(r.retention_note) : null,
    publishedAt: iso(r?.published_at),
    createdAt: iso(r?.created_at),
    updatedAt: iso(r?.updated_at),
  };
}

/** Past its retention date. A FLAG FOR A HUMAN, never an instruction to delete anything: nothing in
 *  this module removes a row, and a retention sweep that did would destroy the evidence somebody set
 *  the date to be able to find. */
export function retentionDue(doc: LibraryDocument, today?: string): boolean {
  if (!doc.retentionUntil) return false;
  const now = String(today || new Date().toISOString().slice(0, 10));
  return doc.retentionUntil <= now;
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export async function listFolders(): Promise<DocumentFolder[]> {
  try {
    await ensureDocumentSchema();
    const r = await db.execute(sql`
      SELECT f.id, f.name, f.description, f.parent_id,
             (SELECT COUNT(*)::int FROM documents d WHERE d.folder_id = f.id) AS doc_count
        FROM document_folders f
       ORDER BY f.name ASC`);
    return rows(r).map((x: any) => ({
      id: String(x?.id ?? ''),
      name: String(x?.name ?? ''),
      description: x?.description ? String(x.description) : null,
      parentId: x?.parent_id ? String(x.parent_id) : null,
      documentCount: Number(x?.doc_count) || 0,
    }));
  } catch (e: any) {
    logFail('listFolders', e);
    return [];
  }
}

export interface LibraryQuery {
  /** hr_employees.id of the reader. Null means "no employee record" — see the note in the body. */
  employeeId: string | null;
  /** The reader's own department, for the `department` visibility arm. Compared ::text, never ::uuid. */
  departmentId?: string | null;
  /** TRUE only when the caller has verified `documents.manage`. Widens the read to everything. */
  curator?: boolean;
  folderId?: string | null;
  category?: string | null;
  q?: string | null;
  /** Include retired documents. Off by default; a retired policy is history, not the library. */
  includeRetired?: boolean;
  limit?: number;
}

/**
 * THE LIBRARY, AS ONE PERSON MAY SEE IT.
 *
 * THE NARROWING IS IN THE WHERE CLAUSE, not in a filter applied afterwards, so there is no code path
 * on which a document the reader is not entitled to leaves the database. Four ways in:
 *
 *   1. they own it — at any status, including draft;
 *   2. it is PUBLISHED and company-visible;
 *   3. it is PUBLISHED, department-visible, and it is their department (::text on both sides);
 *   4. it is shared with them by name, or with their department by name.
 *
 * `curator` is the fifth, and it is a PARAMETER RATHER THAN A LOOKUP on purpose: this module never
 * decides who is a curator, it is told. The caller asks holdsCapability(user, 'documents.manage') and
 * passes the answer, which keeps one authorization system rather than two.
 *
 * NO EMPLOYEE RECORD IS NOT AN ERROR AND IS NOT A KEY. With employeeId null, arms 1, 3 and 4 cannot
 * match anything, so the reader sees published company documents and nothing else. That is the
 * honest answer for an account with no place in the organisation yet.
 */
export async function listDocuments(query: LibraryQuery): Promise<LibraryDocument[]> {
  const limit = Math.min(Math.max(Number(query?.limit) || 100, 1), 300);
  try {
    await ensureDocumentSchema();

    const me = isUuid(query?.employeeId) ? String(query.employeeId) : null;
    const dept = query?.departmentId ? String(query.departmentId) : null;

    const visible = query?.curator === true
      ? sql`TRUE`
      : sql`(
          (${me}::text IS NOT NULL AND d.owner_employee_id::text = ${me}::text)
          OR (d.status = 'published' AND d.visibility = 'company')
          OR (d.status = 'published' AND d.visibility = 'department'
              AND ${dept}::text IS NOT NULL AND d.department_id::text = ${dept}::text)
          OR EXISTS (
            SELECT 1 FROM document_shares s
             WHERE s.document_id = d.id
               AND (
                 (${me}::text IS NOT NULL AND s.employee_id::text = ${me}::text)
                 OR (${dept}::text IS NOT NULL AND s.department_id::text = ${dept}::text)
               )
          )
        )`;

    const byFolder = isUuid(query?.folderId) ? sql`AND d.folder_id = ${String(query.folderId)}::uuid` : sql``;
    const byCategory = isDocumentCategory(query?.category) ? sql`AND d.category = ${String(query.category)}` : sql``;
    const term = String(query?.q || '').trim();
    const byQ = term
      ? sql`AND (d.title ILIKE ${'%' + term + '%'} OR COALESCE(d.description,'') ILIKE ${'%' + term + '%'})`
      : sql``;
    const retired = query?.includeRetired ? sql`` : sql`AND d.status <> 'retired'`;

    const r = await db.execute(sql`
      SELECT d.*, f.name AS folder_name, e.full_name AS owner_name
        FROM documents d
        LEFT JOIN document_folders f ON f.id = d.folder_id
        LEFT JOIN hr_employees e ON e.id = d.owner_employee_id
       WHERE ${visible} ${byFolder} ${byCategory} ${byQ} ${retired}
       ORDER BY d.updated_at DESC
       LIMIT ${limit}`);
    return rows(r).map(mapDocument);
  } catch (e: any) {
    logFail('listDocuments', e);
    return [];
  }
}

/** One document, WITHOUT an entitlement check — every caller must have obtained it through
 *  listDocuments() or must call canRead() itself. Kept separate so the check is never accidental. */
export async function getDocument(documentId: string): Promise<LibraryDocument | null> {
  if (!isUuid(documentId)) return null;
  try {
    await ensureDocumentSchema();
    const r = rows(await db.execute(sql`
      SELECT d.*, f.name AS folder_name, e.full_name AS owner_name
        FROM documents d
        LEFT JOIN document_folders f ON f.id = d.folder_id
        LEFT JOIN hr_employees e ON e.id = d.owner_employee_id
       WHERE d.id = ${documentId}::uuid
       LIMIT 1`));
    return r.length ? mapDocument(r[0]) : null;
  } catch (e: any) {
    logFail('getDocument', e);
    return null;
  }
}

/** May this reader open this document? The same four arms as the list query, asked for one row. */
export async function canRead(
  doc: LibraryDocument,
  reader: { employeeId: string | null; departmentId?: string | null; curator?: boolean },
): Promise<boolean> {
  if (reader?.curator === true) return true;
  const me = isUuid(reader?.employeeId) ? String(reader.employeeId) : null;
  const dept = reader?.departmentId ? String(reader.departmentId) : null;
  if (me && doc.ownerEmployeeId === me) return true;
  if (doc.status === 'published' && doc.visibility === 'company') return true;
  if (doc.status === 'published' && doc.visibility === 'department' && dept && doc.departmentId === dept) return true;
  if (!me && !dept) return false;
  try {
    await ensureDocumentSchema();
    const r = rows(await db.execute(sql`
      SELECT 1 AS ok FROM document_shares
       WHERE document_id = ${doc.id}::uuid
         AND ((${me}::text IS NOT NULL AND employee_id::text = ${me}::text)
           OR (${dept}::text IS NOT NULL AND department_id::text = ${dept}::text))
       LIMIT 1`));
    return r.length > 0;
  } catch (e: any) {
    logFail('canRead', e);
    return false;
  }
}

export async function documentVersions(documentId: string): Promise<DocumentVersion[]> {
  if (!isUuid(documentId)) return [];
  try {
    await ensureDocumentSchema();
    const r = await db.execute(sql`
      SELECT * FROM document_versions WHERE document_id = ${documentId}::uuid ORDER BY version DESC LIMIT 100`);
    return rows(r).map((x: any) => ({
      id: String(x?.id ?? ''),
      documentId: String(x?.document_id ?? ''),
      version: Number(x?.version) || 1,
      driveUrl: String(x?.drive_url ?? ''),
      changeNote: x?.change_note ? String(x.change_note) : null,
      createdAt: iso(x?.created_at),
    }));
  } catch (e: any) {
    logFail('documentVersions', e);
    return [];
  }
}

export async function documentShares(documentId: string): Promise<DocumentShare[]> {
  if (!isUuid(documentId)) return [];
  try {
    await ensureDocumentSchema();
    const r = await db.execute(sql`
      SELECT s.*, e.full_name AS employee_name
        FROM document_shares s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.document_id = ${documentId}::uuid
       ORDER BY s.created_at DESC LIMIT 200`);
    return rows(r).map((x: any) => ({
      id: String(x?.id ?? ''),
      documentId: String(x?.document_id ?? ''),
      employeeId: x?.employee_id ? String(x.employee_id) : null,
      employeeName: x?.employee_name ? String(x.employee_name) : null,
      departmentId: x?.department_id ? String(x.department_id) : null,
      createdAt: iso(x?.created_at),
    }));
  } catch (e: any) {
    logFail('documentShares', e);
    return [];
  }
}

/** The live approval on a document, read back from the workflow engine. Never mirrored here. */
export async function documentApproval(documentId: string): Promise<WorkflowInstanceRow | null> {
  if (!isUuid(documentId)) return null;
  try {
    return await instanceForRecord('documents', documentId);
  } catch (e: any) {
    logFail('documentApproval', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// INTERNAL
// -------------------------------------------------------------------------------------------------

async function auditDoc(userId: string | null, action: string, documentId: string, diff: Record<string, unknown>): Promise<void> {
  await logAudit({ userId: userId || null, action: 'documents.' + action, entity: 'document', entityId: documentId, diff });
}

/** May this person change this document? The owner, or a curator. Not "anybody it was shared with" —
 *  sharing is a read grant and nothing more. */
function mayEdit(
  doc: LibraryDocument,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
): boolean {
  const uid = String(user?.id || '').trim();
  if (uid && doc.ownerUserId === uid) return true;
  if (employeeId && doc.ownerEmployeeId === employeeId) return true;
  return holdsCapability(user, 'documents.manage');
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

/** Create a folder. Curation, so it needs the capability. */
export async function createFolder(
  name: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  opts: { description?: string | null; parentId?: string | null } = {},
): Promise<DocumentResult> {
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'documents.manage')) return { ok: false, error: NEEDS_CAPABILITY };
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) return { ok: false, error: 'Give the folder a name.' };

  try {
    await ensureDocumentSchema();
    const ins = rows(await db.execute(sql`
      INSERT INTO document_folders (name, description, parent_id, created_by)
      VALUES (${clean}, ${opts.description ? String(opts.description).slice(0, 500) : null}::text,
              ${isUuid(opts.parentId) ? String(opts.parentId) : null}::uuid, ${actorId}::uuid)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);
    await auditDoc(actorId, 'folder.create', id, { name: clean });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('createFolder', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface AddDocumentInput {
  title: string;
  driveUrl: string;
  category?: string | null;
  description?: string | null;
  folderId?: string | null;
  visibility?: string | null;
  ownerUserId: string;
  ownerEmployeeId?: string | null;
  /** The owner's department, carried onto the row so the department arm of the read is answerable
   *  without a join to a table whose id type differs between two schema files. */
  departmentId?: string | null;
  retentionUntil?: string | null;
  retentionNote?: string | null;
}

/**
 * Put a document in the library. IT IS A LINK. See the header — this refuses anything that is not on
 * Drive, and the refusal states the rule rather than saying "invalid".
 *
 * IT STARTS AS A DRAFT, WHATEVER VISIBILITY WAS ASKED FOR. Publishing is a separate act that
 * requires a settled approval; a create call that could produce a company-visible policy in one step
 * would make the approval optional in practice.
 */
export async function addDocument(input: AddDocumentInput): Promise<DocumentResult> {
  const title = String(input?.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Give the document a title people will recognise.' };

  const driveUrl = String(input?.driveUrl || '').trim();
  if (!isDriveLink(driveUrl)) return { ok: false, error: DRIVE_RULE };

  const ownerUserId = String(input?.ownerUserId || '').trim();
  if (!isUuid(ownerUserId)) return { ok: false, error: 'Sign in to add a document.' };

  const category = isDocumentCategory(input?.category) ? String(input.category) : 'other';
  const visibility = VISIBILITY_SET.has(String(input?.visibility || '')) ? String(input.visibility) : 'private';
  const ownerEmployeeId = isUuid(input?.ownerEmployeeId) ? String(input.ownerEmployeeId) : null;
  const departmentId = input?.departmentId ? String(input.departmentId).slice(0, 80) : null;

  try {
    await ensureDocumentSchema();
    const ins = rows(await db.execute(sql`
      INSERT INTO documents (folder_id, title, description, category, drive_url,
                             owner_employee_id, owner_user_id, visibility, department_id,
                             status, current_version, retention_until, retention_note)
      VALUES (${isUuid(input?.folderId) ? String(input.folderId) : null}::uuid,
              ${title}, ${input?.description ? String(input.description).slice(0, 2000) : null}::text,
              ${category}, ${driveUrl},
              ${ownerEmployeeId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${departmentId}::text,
              'draft', 1, ${input?.retentionUntil || null}::date,
              ${input?.retentionNote ? String(input.retentionNote).slice(0, 500) : null}::text)
      RETURNING id`));
    if (!ins.length) return { ok: false, error: WRITE_FAILED };
    const id = String(ins[0].id);

    // Version 1 is a row, not an implication. Every later version has one, so the first must too or
    // the history starts at 2 and nobody can see what the original link was.
    try {
      await db.execute(sql`
        INSERT INTO document_versions (document_id, version, drive_url, change_note, created_by)
        VALUES (${id}::uuid, 1, ${driveUrl}, 'First version', ${ownerUserId}::uuid)
        ON CONFLICT DO NOTHING`);
    } catch (e: any) {
      logFail('addDocument.version1', e);
    }

    await auditDoc(ownerUserId, 'create', id, { title, category, visibility });
    return { ok: true, id, changed: true };
  } catch (e: any) {
    logFail('addDocument', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Save a NEW VERSION — a new Drive link, with a note saying what changed.
 *
 * THE OLD LINK IS KEPT. document_versions is append-only, so "what did the policy say in March" has
 * an answer. The version number is derived from MAX(version) + 1 inside the insert, and the unique
 * index on (document_id, version) rejects a retried POST rather than producing two version 3s.
 *
 * A PUBLISHED DOCUMENT DROPS BACK TO DRAFT. A new version of an approved policy has not itself been
 * approved, and leaving it published would let the approval be attached to text nobody signed off.
 */
export async function addVersion(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
  driveUrl: string,
  changeNote: string,
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  const url = String(driveUrl || '').trim();
  if (!isDriveLink(url)) return { ok: false, error: DRIVE_RULE };
  const note = String(changeNote || '').trim().slice(0, 500);
  if (!note) return { ok: false, error: 'Say what changed. A version with no note is a version nobody can choose between.' };

  try {
    await ensureDocumentSchema();
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document can change it.' };
    if (doc.status === 'retired') return { ok: false, error: 'That document is retired. Add a new one rather than reviving it.' };

    const ins = rows(await db.execute(sql`
      INSERT INTO document_versions (document_id, version, drive_url, change_note, created_by)
      SELECT ${documentId}::uuid, COALESCE(MAX(version), 0) + 1, ${url}, ${note}, ${actorId}::uuid
        FROM document_versions WHERE document_id = ${documentId}::uuid
      ON CONFLICT DO NOTHING
      RETURNING version`));
    if (!ins.length) {
      return { ok: false, error: 'That version was already saved while this page was open. Reload it.' };
    }
    const version = Number(ins[0].version) || doc.currentVersion + 1;

    await db.execute(sql`
      UPDATE documents
         SET drive_url = ${url}, current_version = ${version},
             status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
             published_at = CASE WHEN status = 'published' THEN NULL ELSE published_at END,
             updated_at = NOW()
       WHERE id = ${documentId}::uuid`);

    await auditDoc(actorId, 'version', documentId, { version, wasPublished: doc.status === 'published' });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('addVersion', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * SEND A DOCUMENT FOR APPROVAL — through src/lib/workflow.ts, and through nothing else.
 *
 * THE ROUTING IS THE ORG GRAPH'S ANSWER, per row: the owner's reporting manager, then the documents
 * approval owner if the organisation has named one. When the graph cannot name anybody the engine
 * writes the instance HALTED with a readable sentence and this function reports it — the document
 * stays a draft. It is never auto-approved and never routed to "whoever holds documents.manage",
 * because routing deciding authorization is the thing the whole three-layer design refuses.
 *
 * THE GATE IS HERE, NOT IN THE ENGINE. resumeWorkflow() carries no entitlement check of its own (its
 * docblock says so and requires every caller to bring one); the check is the mayEdit() below, so
 * only the document's owner or a curator can put it into review or re-route a halted one.
 */
export async function submitForApproval(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  try {
    await ensureDocumentSchema();
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document can send it for approval.' };
    if (doc.status === 'published') return { ok: false, error: 'That document is already published.' };
    if (doc.status === 'retired') return { ok: false, error: 'That document is retired.' };

    const subject = doc.ownerEmployeeId;
    if (!subject) {
      return { ok: false, error: 'This document is not linked to an employee record, so there is no reporting line to route the approval along.' };
    }

    const existing = await documentApproval(documentId);
    if (existing && existing.state === 'halted') {
      const resumed = await resumeWorkflow(existing.id, user);
      if (!resumed.ok) {
        return { ok: false, error: resumed.error || 'The approval could not be routed.', haltReason: resumed.haltReason || existing.haltReason };
      }
      await db.execute(sql`
        UPDATE documents SET status = 'in_review', updated_at = NOW()
         WHERE id = ${documentId}::uuid AND status = 'draft'`);
      await auditDoc(actorId, 'approval.resume', documentId, { instanceId: existing.id });
      return { ok: true, id: documentId, changed: true };
    }
    if (existing && existing.state === 'pending') {
      return { ok: false, error: 'That is already waiting for approval.' };
    }

    const wf = await startWorkflow({
      domain: 'documents',
      recordId: documentId,
      subjectEmployeeId: subject,
      requestedByUserId: actorId,
      summary: doc.title,
      createdByUserId: actorId,
    });
    if (!wf.ok) return { ok: false, error: wf.error || WRITE_FAILED };

    if (wf.state === 'halted') {
      await auditDoc(actorId, 'approval.halted', documentId, { instanceId: wf.instanceId, haltReason: wf.haltReason });
      return { ok: false, error: wf.haltReason || 'No approver could be resolved.', haltReason: wf.haltReason || null };
    }

    await db.execute(sql`
      UPDATE documents SET status = 'in_review', updated_at = NOW()
       WHERE id = ${documentId}::uuid AND status = 'draft'`);
    await auditDoc(actorId, 'approval.start', documentId, { instanceId: wf.instanceId });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('submitForApproval', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * PUBLISH — release an approved document to its audience.
 *
 * THE APPROVAL IS RE-READ FROM THE ENGINE AT THIS WRITE, not trusted from the page that rendered the
 * button and not read from a mirrored column. A document whose instance is anything other than
 * `approved` is refused, and the refusal says which state it is actually in.
 */
export async function publishDocument(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  try {
    await ensureDocumentSchema();
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document, or a library curator, can publish it.' };
    if (doc.status === 'published') return { ok: true, id: documentId, changed: false };
    if (doc.status === 'retired') return { ok: false, error: 'That document is retired.' };

    const instance = await documentApproval(documentId);
    if (!instance) {
      return { ok: false, error: 'This has not been through an approval. Send it for approval first — nothing is published on this platform without one.' };
    }
    if (instance.state === 'halted') {
      return { ok: false, error: 'The approval is halted: ' + (instance.haltReason || 'no approver could be resolved') + '.' };
    }
    if (instance.state !== 'approved') {
      return { ok: false, error: 'The approval for this document is ' + String(instance.state) + '. It cannot be published until it is approved.' };
    }

    const wrote = rows(await db.execute(sql`
      UPDATE documents SET status = 'published', published_at = NOW(), updated_at = NOW()
       WHERE id = ${documentId}::uuid AND status IN ('draft', 'in_review')
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That document changed while this page was open. Reload it and try again.' };
    }

    // Tell the people it was shared with by name. A company-wide document is NOT fanned out to every
    // employee from here: a notification per person per policy is how a notification bell becomes
    // something everybody switches off, and the library is where they will look.
    try {
      const targets = rows(await db.execute(sql`
        SELECT e.user_id FROM document_shares s
          JOIN hr_employees e ON e.id = s.employee_id
         WHERE s.document_id = ${documentId}::uuid AND e.user_id IS NOT NULL
         LIMIT 200`));
      for (const t of targets) {
        await sendPushToUser(String(t.user_id), {
          type: 'document_published',
          title: 'A document you were given was published',
          body: doc.title,
          url: '/portal/employee/documents?d=' + documentId,
          tag: 'document-' + documentId,
        });
      }
    } catch (e: any) {
      logFail('publishDocument.notify', e);
    }

    await auditDoc(actorId, 'publish', documentId, { instanceId: instance.id, visibility: doc.visibility });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('publishDocument', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Retire a document. It is KEPT — a retired policy is the evidence of what the rule used to be. */
export async function retireDocument(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
  reason: string = '',
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  try {
    await ensureDocumentSchema();
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document, or a library curator, can retire it.' };
    if (doc.status === 'retired') return { ok: true, id: documentId, changed: false };

    const wrote = rows(await db.execute(sql`
      UPDATE documents
         SET status = 'retired', retired_at = NOW(), updated_at = NOW(),
             retention_note = COALESCE(${String(reason || '').trim().slice(0, 500) || null}::text, retention_note)
       WHERE id = ${documentId}::uuid AND status <> 'retired'
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: 'That document changed while this page was open. Reload it.' };

    await auditDoc(actorId, 'retire', documentId, { from: doc.status, reason: String(reason || '').slice(0, 500) || null });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('retireDocument', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Share a document with one named employee, or with a whole department. A READ grant, nothing more. */
export async function shareDocument(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
  target: { employeeId?: string | null; departmentId?: string | null },
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  const withEmployee = isUuid(target?.employeeId) ? String(target.employeeId) : null;
  const withDepartment = target?.departmentId ? String(target.departmentId).slice(0, 80) : null;
  if (!withEmployee && !withDepartment) return { ok: false, error: 'Choose a person or a department to share it with.' };

  try {
    await ensureDocumentSchema();
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document, or a library curator, can share it.' };

    if (withEmployee) {
      const emp = rows(await db.execute(sql`
        SELECT id, user_id FROM hr_employees WHERE id = ${withEmployee}::uuid AND is_active = true LIMIT 1`));
      if (!emp.length) return { ok: false, error: 'That is not an active employee record.' };
    }

    // Sharing the same thing with the same person twice is a no-op, not an error — the person
    // pressing it twice wanted them to have it, and they do.
    const already = rows(await db.execute(sql`
      SELECT id FROM document_shares
       WHERE document_id = ${documentId}::uuid
         AND COALESCE(employee_id::text,'') = COALESCE(${withEmployee}::text,'')
         AND COALESCE(department_id::text,'') = COALESCE(${withDepartment}::text,'')
       LIMIT 1`));
    if (already.length) return { ok: true, id: documentId, changed: false };

    await db.execute(sql`
      INSERT INTO document_shares (document_id, employee_id, department_id, shared_by)
      VALUES (${documentId}::uuid, ${withEmployee}::uuid, ${withDepartment}::text, ${actorId}::uuid)`);

    if (withEmployee) {
      try {
        const t = rows(await db.execute(sql`SELECT user_id FROM hr_employees WHERE id = ${withEmployee}::uuid LIMIT 1`));
        if (t.length && t[0].user_id) {
          await sendPushToUser(String(t[0].user_id), {
            type: 'document_shared',
            title: 'A document was shared with you',
            body: doc.title,
            url: '/portal/employee/documents?d=' + documentId,
            tag: 'document-' + documentId,
          });
        }
      } catch (e: any) {
        logFail('shareDocument.notify', e);
      }
    }

    await auditDoc(actorId, 'share', documentId, { withEmployee, withDepartment });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('shareDocument', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Stop sharing. */
export async function unshareDocument(
  shareId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  employeeId: string | null,
): Promise<DocumentResult> {
  if (!isUuid(shareId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };

  try {
    await ensureDocumentSchema();
    const found = rows(await db.execute(sql`SELECT * FROM document_shares WHERE id = ${shareId}::uuid LIMIT 1`));
    if (!found.length) return { ok: true, changed: false };
    const documentId = String(found[0].document_id);
    const doc = await getDocument(documentId);
    if (!doc) return { ok: false, error: NOT_AVAILABLE };
    if (!mayEdit(doc, user, employeeId)) return { ok: false, error: 'Only the owner of a document, or a library curator, can change who it is shared with.' };

    await db.execute(sql`DELETE FROM document_shares WHERE id = ${shareId}::uuid`);
    await auditDoc(actorId, 'unshare', documentId, { shareId });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('unshareDocument', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** Set or clear the retention date. Curation, and a flag for a human — nothing deletes anything. */
export async function setRetention(
  documentId: string,
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined,
  until: string | null,
  note: string = '',
): Promise<DocumentResult> {
  if (!isUuid(documentId)) return { ok: false, error: NOT_AVAILABLE };
  const actorId = String(user?.id || '').trim();
  if (!actorId) return { ok: false, error: 'Sign in to do that.' };
  if (!holdsCapability(user, 'documents.manage')) return { ok: false, error: NEEDS_CAPABILITY };

  try {
    await ensureDocumentSchema();
    const wrote = rows(await db.execute(sql`
      UPDATE documents
         SET retention_until = ${until || null}::date,
             retention_note = ${String(note || '').trim().slice(0, 500) || null}::text,
             updated_at = NOW()
       WHERE id = ${documentId}::uuid
      RETURNING id`));
    if (!wrote.length) return { ok: false, error: NOT_AVAILABLE };
    await auditDoc(actorId, 'retention', documentId, { until: until || null });
    return { ok: true, id: documentId, changed: true };
  } catch (e: any) {
    logFail('setRetention', e);
    return { ok: false, error: WRITE_FAILED };
  }
}
