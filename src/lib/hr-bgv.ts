// Background Verification (BGV) — per HR Lifecycle Manual §B.10.
// Tracks identity / address / education / employment / criminal record /
// professional licences for every candidate at offer stage. Must clear before
// joining date. Written consent recorded.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/**
 * The evidence column for each check, declared HERE — above ensureBgvSchema, which reads it — because
 * `const` is not hoisted and a declaration below its first use has taken pages down on this project.
 *
 * The names are derived from BGV_CHECKS by the same rule updateBgvCheck already uses for the notes
 * columns (`check_identity` -> `identity_notes`), written out literally so the DDL loop cannot be
 * fed a column name that came from anywhere but this file.
 */
const BGV_EVIDENCE_COLUMNS = [
  'identity_evidence_url',
  'address_evidence_url',
  'education_evidence_url',
  'employment_evidence_url',
  'criminal_evidence_url',
  'professional_evidence_url',
  'credit_evidence_url',
  'sanctions_evidence_url',
] as const;

/** `check_education` -> `education_evidence_url`. Null for any key that is not a known check. */
export function evidenceColumnFor(checkKey: string): string | null {
  const stem = String(checkKey || '').replace('check_', '');
  const col = stem + '_evidence_url';
  return (BGV_EVIDENCE_COLUMNS as readonly string[]).includes(col) ? col : null;
}

/**
 * Inside an ensureOnce guard, not a hand-rolled `let ready`. The catch already said the real reason
 * out loud; what it could not do was retry. `ready` was assigned once and never cleared, so a single
 * transient DDL failure — including one that dropped the new evidence columns — resolved anyway and
 * was cached for the life of the process, and every BGV screen after it silently discarded evidence
 * links until a redeploy. ensureOnce() drops a failed run so the next call retries, which is why the
 * catch now re-throws after logging; it then swallows the rejection for the caller, so the signature
 * and every caller's behaviour are unchanged.
 */
export function ensureBgvSchema(): Promise<void> {
  return ensureOnce('hr_bgv_v2_evidence', async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_bgv_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        candidate_email VARCHAR(200) NOT NULL,
        candidate_name VARCHAR(200) NOT NULL,
        application_id UUID,
        offer_id UUID,
        consent_given BOOLEAN NOT NULL DEFAULT false,
        consent_at TIMESTAMPTZ,
        consent_ip VARCHAR(64),
        check_identity VARCHAR(20) DEFAULT 'pending',
          -- pending | in_progress | clear | flagged | n/a
        check_address VARCHAR(20) DEFAULT 'pending',
        check_education VARCHAR(20) DEFAULT 'pending',
        check_employment VARCHAR(20) DEFAULT 'pending',
        check_criminal VARCHAR(20) DEFAULT 'pending',
        check_professional VARCHAR(20) DEFAULT 'n/a',
          -- only relevant for some roles
        check_credit VARCHAR(20) DEFAULT 'n/a',
          -- only for finance roles
        check_sanctions VARCHAR(20) DEFAULT 'pending',
        identity_notes TEXT,
        address_notes TEXT,
        education_notes TEXT,
        employment_notes TEXT,
        criminal_notes TEXT,
        professional_notes TEXT,
        credit_notes TEXT,
        sanctions_notes TEXT,
        overall_status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | in_progress | clear | flagged | failed
        vendor VARCHAR(80),
          -- e.g. "AuthBridge", "First Advantage", "Internal"
        vendor_ref VARCHAR(120),
        cleared_at TIMESTAMPTZ,
        cleared_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS bgv_email_idx ON hr_bgv_records(candidate_email)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS bgv_overall_idx ON hr_bgv_records(overall_status, created_at DESC)`);

      // EVIDENCE, ADDED IN PLACE — no second table, no second BGV module.
      //
      // A checklist with a status and a note was never enough to settle a check: "employment: clear"
      // is somebody's word for it unless the relieving letter can be opened. So each check gains ONE
      // column holding a LINK to its evidence.
      //
      // A LINK, NEVER AN UPLOAD. Documents of any kind are Google Drive links on this project, shared
      // so that anyone with the link can open them; nothing is stored here but the URL. That is a
      // standing rule and it is also the only thing that makes the evidence readable by the next
      // person to pick up the file.
      //
      // ADD COLUMN IF NOT EXISTS on the EXISTING table rather than a new one, because a second BGV
      // shape is exactly the duplicate-table fault this codebase is repairing elsewhere.
      for (const col of BGV_EVIDENCE_COLUMNS) {
        await db.execute(sql`ALTER TABLE hr_bgv_records ADD COLUMN IF NOT EXISTS ${sql.raw(col)} TEXT`);
      }
    } catch (e: any) {
      // NOT SILENT. This used to be a bare `catch (_) {}`, which meant a database that rejected the
      // evidence columns produced a BGV screen that looked complete and quietly dropped every link.
      // The real Postgres reason lives on e.cause; e.message is only the SQL that failed.
      console.error('[hr-bgv] schema ensure failed:', String(e?.cause?.message || e?.message || 'unknown error'));
      throw e; // ensureOnce drops the failed run, so the next call retries instead of staying broken.
    }
  });
}

export const BGV_CHECKS = [
  { key: 'check_identity',     label: 'Identity',                description: 'PAN / Aadhaar / passport' },
  { key: 'check_address',      label: 'Address',                 description: 'Current + permanent address proof' },
  { key: 'check_education',    label: 'Education',               description: 'Degree certificates + mark sheets' },
  { key: 'check_employment',   label: 'Previous employment',     description: 'Relieving letters / payslips / Form 16' },
  { key: 'check_criminal',     label: 'Criminal record',         description: 'Court records / police verification' },
  { key: 'check_professional', label: 'Professional licences',   description: 'Where relevant (e.g. CA, lawyer)' },
  { key: 'check_credit',       label: 'Credit history',          description: 'For finance roles only' },
  { key: 'check_sanctions',    label: 'Sanctions screening',     description: 'Global database / OFAC / EU' },
];

export const BGV_STATUS_TONES: Record<string, string> = {
  pending:    '#9aa6b6',
  in_progress:'#67e8f9',
  clear:      '#86efac',
  flagged:    '#fbbf24',
  failed:     '#fca5a5',
  'n/a':      '#6e6e78',
};

export async function createBgvRecord(opts: any) {
  await ensureBgvSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hr_bgv_records (candidate_email, candidate_name, application_id, offer_id, consent_given, consent_at, consent_ip, vendor)
    VALUES (${opts.email}, ${opts.name}, ${opts.applicationId || null}, ${opts.offerId || null},
      ${!!opts.consent}, ${opts.consent ? sql`NOW()` : sql`NULL`}, ${opts.ip || null}, ${opts.vendor || null})
    RETURNING id
  `));
  return { ok: true, id: r[0]?.id };
}

/** The only statuses a check may hold. The screen's picker is built from this same list. */
export const BGV_STATUSES = ['pending', 'in_progress', 'clear', 'flagged', 'failed', 'n/a'] as const;

export async function updateBgvCheck(id: string, checkKey: string, status: string, notes?: string, evidenceUrl?: string) {
  await ensureBgvSchema();
  // Only allow known check keys.
  if (!BGV_CHECKS.find(c => c.key === checkKey)) return { ok: false, error: 'bad check key' };
  // AND ONLY A KNOWN STATUS. The posted value went straight into the column unchecked, so a
  // hand-made POST could store any string at all as the outcome of somebody's criminal-record
  // check — and the roll-up below reads that column back to decide whether the candidate is
  // cleared. A rendered <select> is not a validation.
  if (!(BGV_STATUSES as readonly string[]).includes(String(status))) {
    return { ok: false, error: 'That is not a verification outcome this register recognises, so nothing was changed.' };
  }
  const notesCol = checkKey.replace('check_', '') + '_notes';
  const evidenceCol = evidenceColumnFor(checkKey);

  // A LINK, NEVER A FILE. Refused with a sentence rather than stored as junk, so a check is never
  // marked clear against evidence nobody can open.
  const rawEvidence = typeof evidenceUrl === 'string' ? evidenceUrl.trim().slice(0, 1000) : '';
  if (rawEvidence && !/^https?:\/\//i.test(rawEvidence)) {
    return { ok: false, error: 'Evidence must be a link (starting http:// or https://) that anyone with the link can open. Files are never uploaded here.' };
  }

  // Build query manually since column name varies — sql.raw to inject column. Both column names are
  // derived from the closed BGV_CHECKS list and never from caller input, which is the only reason
  // sql.raw is acceptable here; the values themselves are bound parameters.
  // RETURNING, so "Check updated." is a report of a row that changed rather than of a statement that
  // ran. Without it an id that matches nothing — a record deleted in another tab, a stale page — was
  // answered { ok: true } and the reviewer believed a background check had been recorded.
  const wrote = rows(await db.execute(
    sql`UPDATE hr_bgv_records SET ${sql.raw(checkKey)} = ${status}, ${sql.raw(notesCol)} = ${notes || null}, updated_at = NOW() WHERE id = ${id} RETURNING id`,
  ));
  if (!wrote.length) {
    return { ok: false, error: 'That verification record is no longer on the register, so nothing was changed.' };
  }
  if (evidenceCol && evidenceUrl !== undefined) {
    await db.execute(sql`UPDATE hr_bgv_records SET ${sql.raw(evidenceCol)} = ${rawEvidence || null}, updated_at = NOW() WHERE id = ${id}`);
  }
  // Recompute overall status.
  const r = rows(await db.execute(sql`SELECT check_identity, check_address, check_education, check_employment, check_criminal, check_professional, check_credit, check_sanctions FROM hr_bgv_records WHERE id = ${id}`));
  if (r[0]) {
    const checks = Object.values(r[0]).filter(v => v && v !== 'n/a');
    let overall: string = 'pending';
    // `[].every(...)` IS TRUE, AND THAT ANSWER WAS "CLEARED". With every check marked not-applicable
    // — or on any row whose check columns are NULL — the filtered list is empty, every() passed, and
    // the record was stamped overall_status 'clear' with cleared_at = NOW() having verified nothing.
    // BGV clearance is a written condition of the offer here. A verdict is never reached from an
    // empty set of evidence: with nothing to judge, the record stays 'pending'.
    if (checks.includes('failed') || checks.includes('flagged')) overall = (checks.includes('failed') ? 'failed' : 'flagged');
    else if (checks.length > 0 && checks.every(v => v === 'clear')) overall = 'clear';
    else if (checks.includes('in_progress') || checks.includes('clear')) overall = 'in_progress';
    await db.execute(sql`UPDATE hr_bgv_records SET overall_status = ${overall}, ${sql.raw("cleared_at = " + (overall === 'clear' ? 'NOW()' : 'NULL'))}, updated_at = NOW() WHERE id = ${id}`);
  }
  return { ok: true };
}

export async function listBgvRecords(filterStatus?: string) {
  await ensureBgvSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_bgv_records ${filterStatus ? sql`WHERE overall_status = ${filterStatus}` : sql``} ORDER BY created_at DESC LIMIT 300`));
}

export async function getBgvRecord(id: string) {
  await ensureBgvSchema();
  return rows(await db.execute(sql`SELECT * FROM hr_bgv_records WHERE id = ${id} LIMIT 1`))[0] || null;
}
