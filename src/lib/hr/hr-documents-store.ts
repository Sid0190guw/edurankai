// The register of issued HR documents: experience letters, no-objection certificates and relieving
// letters (src/lib/hr/hr-documents.ts renders them). One row per document, holding the exact HTML
// that was issued, so the printed copy, the emailed copy and the public verification page are the
// same document and a later change to a template never rewrites a letter already in someone's hands.
//
// NOT CREATED ON A REQUEST IN PRODUCTION (ensureOnce is a no-op there). The table is created by
// "Create module tables" on /admin/setup (BOOTSTRAP_MODULE_LIST) or by hand:
//   psql -v ON_ERROR_STOP=1 -f db/hr-documents-schema.sql
// Every reader reports `missing: true` instead of an empty list when the table is absent.
//
// Payslips are NOT stored here. A payslip is produced by a payroll run (src/lib/payroll.ts) and
// rendered by src/lib/hr-payslip.ts from the run's own numbers; a pay document typed in by hand
// would be a figure nobody paid.

import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import { documentSerial, type HrDocType, hrDocType } from '@/lib/hr/hr-documents';

export const HR_DOCUMENTS_DDL = `
CREATE TABLE IF NOT EXISTS hr_issued_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial          TEXT NOT NULL UNIQUE,
  doc_type        TEXT NOT NULL,
  employee_id     UUID,
  employee_name   TEXT NOT NULL,
  employee_code   TEXT,
  recipient_email TEXT,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  html            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'issued',
  issued_by       UUID,
  issued_by_name  TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_by_name TEXT,
  revoked_reason  TEXT,
  emailed_to      TEXT,
  emailed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hr_issued_documents_issued_idx ON hr_issued_documents (issued_at DESC);
CREATE INDEX IF NOT EXISTS hr_issued_documents_employee_idx ON hr_issued_documents (employee_id);
`;

export function ensureHrDocumentsSchema(): Promise<void> {
  return ensureBatch('hr_issued_documents_v1', HR_DOCUMENTS_DDL);
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const why = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const isMissing = (e: any): boolean => /hr_issued_documents" does not exist|relation .*hr_issued_documents/i.test(why(e)) || String(e?.cause?.code || e?.code) === '42P01';

export const NOT_SET_UP = 'The HR documents register has not been created yet. Open /admin/setup and press "Create module tables", then come back.';

export type Read<T> = { ok: true; value: T } | { ok: false; missing: boolean; error: string };

export interface IssuedDocument {
  id: string; serial: string; docType: HrDocType; employeeId: string | null; employeeName: string; employeeCode: string;
  recipientEmail: string; fields: Record<string, any>; html: string; status: 'issued' | 'revoked';
  issuedByName: string; issuedAt: string; revokedAt: string | null; revokedByName: string; revokedReason: string;
  emailedTo: string; emailedAt: string | null;
}

const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

function toDoc(r: any): IssuedDocument {
  let fields = r.fields;
  if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { fields = {}; } }
  return {
    id: String(r.id), serial: String(r.serial), docType: (hrDocType(r.doc_type)?.value || 'experience') as HrDocType,
    employeeId: r.employee_id ? String(r.employee_id) : null, employeeName: String(r.employee_name || ''), employeeCode: String(r.employee_code || ''),
    recipientEmail: String(r.recipient_email || ''), fields: fields && typeof fields === 'object' ? fields : {}, html: String(r.html || ''),
    status: r.status === 'revoked' ? 'revoked' : 'issued', issuedByName: String(r.issued_by_name || ''), issuedAt: iso(r.issued_at) || '',
    revokedAt: iso(r.revoked_at), revokedByName: String(r.revoked_by_name || ''), revokedReason: String(r.revoked_reason || ''),
    emailedTo: String(r.emailed_to || ''), emailedAt: iso(r.emailed_at),
  };
}

async function read<T>(what: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    await ensureHrDocumentsSchema();
    return { ok: true, value: await fn() };
  } catch (e: any) {
    if (isMissing(e)) return { ok: false, missing: true, error: NOT_SET_UP };
    console.error('[hr-documents] ' + what + ' failed:', why(e));
    return { ok: false, missing: false, error: 'The HR documents register could not be read just now (' + what + '). Nothing was changed. Try again in a minute.' };
  }
}

// -------------------------------------------------------------------------------------------------
// EMPLOYEES, for the picker. Named columns only, all of them in db/hr-schema.sql's first version of
// hr_employees, so this never asks production for a column a hand-run migration may not have added.
// -------------------------------------------------------------------------------------------------

export interface EmployeeForDoc {
  id: string; name: string; code: string; designation: string; department: string; employmentType: string;
  joiningDate: string; lastWorkingDay: string; email: string; active: boolean;
}

const day = (v: any): string => {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

export async function employeesForDocuments(): Promise<Read<EmployeeForDoc[]>> {
  try {
    const r = rows(await db.execute(sql`
      SELECT e.id, e.full_name, e.employee_code, e.designation, e.employment_type, e.joining_date,
             e.last_working_day, e.exit_date, e.work_email, e.personal_email, e.email, e.is_active, d.name AS dept_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id = e.department_id
       ORDER BY e.is_active DESC, e.full_name ASC
       LIMIT 800`));
    return {
      ok: true, value: r.map((x) => ({
        id: String(x.id), name: String(x.full_name || ''), code: String(x.employee_code || ''), designation: String(x.designation || ''),
        department: String(x.dept_name || ''), employmentType: String(x.employment_type || ''), joiningDate: day(x.joining_date),
        lastWorkingDay: day(x.last_working_day || x.exit_date), email: String(x.personal_email || x.email || x.work_email || ''), active: !!x.is_active,
      })),
    };
  } catch (e: any) {
    console.error('[hr-documents] employee list failed:', why(e));
    return { ok: false, missing: false, error: 'The employee list could not be read, so nothing is pre-filled. You can still type the details in.' };
  }
}

// -------------------------------------------------------------------------------------------------
// THE REGISTER
// -------------------------------------------------------------------------------------------------

export async function listDocuments(f: { q?: string; type?: string; limit?: number } = {}): Promise<Read<IssuedDocument[]>> {
  const q = String(f.q || '').trim().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const type = hrDocType(f.type)?.value || null;
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 300);
  return read('listing documents', async () => rows(await db.execute(sql`
    SELECT * FROM hr_issued_documents
     WHERE (${type}::text IS NULL OR doc_type = ${type})
       AND (${q} = '' OR employee_name ILIKE ${like} OR serial ILIKE ${like} OR coalesce(employee_code, '') ILIKE ${like})
     ORDER BY issued_at DESC
     LIMIT ${limit}`)).map(toDoc));
}

export async function getDocument(id: string): Promise<Read<IssuedDocument | null>> {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { ok: true, value: null };
  return read('reading a document', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM hr_issued_documents WHERE id = ${id}::uuid LIMIT 1`))[0];
    return r ? toDoc(r) : null;
  });
}

export async function getDocumentBySerial(serial: string): Promise<Read<IssuedDocument | null>> {
  const s = String(serial || '').trim().toUpperCase();
  return read('verifying a document', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM hr_issued_documents WHERE serial = ${s} LIMIT 1`))[0];
    return r ? toDoc(r) : null;
  });
}

export interface IssueInput {
  type: HrDocType;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string;
  recipientEmail: string;
  fields: Record<string, unknown>;
  /** Renders the document once the serial is known; the serial is printed inside it. */
  render: (serial: string) => string;
  issuedBy: { id: string | null; name: string };
}

export type Write<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export async function issueDocument(input: IssueInput): Promise<Write<{ id: string; serial: string }>> {
  try {
    await ensureHrDocumentsSchema();
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 4; attempt++) {
      const serial = documentSerial(input.type, year, randomBytes(6));
      try {
        const html = input.render(serial);
        const r = rows(await db.execute(sql`
          INSERT INTO hr_issued_documents (serial, doc_type, employee_id, employee_name, employee_code, recipient_email, fields, html, issued_by, issued_by_name)
          VALUES (${serial}, ${input.type}, ${input.employeeId}, ${input.employeeName.slice(0, 200)}, ${input.employeeCode.slice(0, 60) || null},
                  ${input.recipientEmail.slice(0, 200) || null}, ${JSON.stringify(input.fields)}::jsonb, ${html}, ${input.issuedBy.id}, ${input.issuedBy.name.slice(0, 200)})
          RETURNING id`))[0];
        return { ok: true, id: String(r?.id), serial };
      } catch (e: any) {
        if (/duplicate key|unique/i.test(why(e)) && attempt < 3) continue;
        throw e;
      }
    }
    return { ok: false, error: 'Could not allocate a document number. Nothing was issued. Try again.' };
  } catch (e: any) {
    if (isMissing(e)) return { ok: false, error: NOT_SET_UP };
    console.error('[hr-documents] issue failed:', why(e));
    return { ok: false, error: 'The document could not be saved, so it was NOT issued. Nothing was sent. Try again in a minute.' };
  }
}

export async function revokeDocument(id: string, reason: string, by: string): Promise<Write> {
  const r = String(reason || '').trim();
  if (r.length < 5) return { ok: false, error: 'Give the reason for revoking it. The verification page shows that the document was revoked.' };
  try {
    const done = rows(await db.execute(sql`
      UPDATE hr_issued_documents SET status = 'revoked', revoked_at = NOW(), revoked_by_name = ${by.slice(0, 200)}, revoked_reason = ${r.slice(0, 500)}
       WHERE id = ${id}::uuid AND status = 'issued' RETURNING id`));
    return done.length ? { ok: true } : { ok: false, error: 'It was already revoked, or it no longer exists.' };
  } catch (e: any) {
    console.error('[hr-documents] revoke failed:', why(e));
    return { ok: false, error: 'The document could not be revoked just now. It is still shown as valid. Try again.' };
  }
}

export async function markEmailed(id: string, to: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE hr_issued_documents SET emailed_to = ${to.slice(0, 200)}, emailed_at = NOW() WHERE id = ${id}::uuid`);
  } catch (e: any) {
    // The mail went out; only the "sent" stamp failed. The caller says so.
    console.error('[hr-documents] could not record the email:', why(e));
    throw e;
  }
}

// -------------------------------------------------------------------------------------------------
// PAYSLIPS ALREADY PRODUCED BY PAYROLL, listed beside the letters so HR finds every document in one
// place. Read-only: generating a payslip is the payroll run's job.
// -------------------------------------------------------------------------------------------------

export interface PayslipRow { id: string; name: string; code: string; month: number; year: number; net: number; currency: string; status: string }

export async function recentPayslips(q = '', limit = 60): Promise<Read<PayslipRow[]>> {
  const term = String(q || '').trim().slice(0, 100);
  const like = '%' + term.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  try {
    const r = rows(await db.execute(sql`
      SELECT ps.id, ps.net_salary, ps.status, ps.currency, e.full_name, e.employee_code, pr.month, pr.year
        FROM hr_payslips ps
        JOIN hr_employees e ON e.id = ps.employee_id
        JOIN hr_payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE (${term} = '' OR e.full_name ILIKE ${like} OR e.employee_code ILIKE ${like})
       ORDER BY pr.year DESC, pr.month DESC, e.full_name ASC
       LIMIT ${Math.min(Math.max(limit, 1), 200)}`));
    return { ok: true, value: r.map((x) => ({ id: String(x.id), name: String(x.full_name || ''), code: String(x.employee_code || ''), month: Number(x.month) || 0, year: Number(x.year) || 0, net: Number(x.net_salary) || 0, currency: String(x.currency || 'INR'), status: String(x.status || '') })) };
  } catch (e: any) {
    const missing = /hr_payslips|hr_payroll_runs/.test(why(e)) && /does not exist/.test(why(e));
    if (!missing) console.error('[hr-documents] payslip list failed:', why(e));
    return { ok: false, missing, error: missing ? 'No payroll has been run yet, so there are no payslips. Payslips come from a payroll run.' : 'Payslips could not be listed just now.' };
  }
}
