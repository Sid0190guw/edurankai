// Background Verification (BGV) — per HR Lifecycle Manual §B.10.
// Tracks identity / address / education / employment / criminal record /
// professional licences for every candidate at offer stage. Must clear before
// joining date. Written consent recorded.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureBgvSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
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
    } catch (_) {}
  })();
  return ready;
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

export async function updateBgvCheck(id: string, checkKey: string, status: string, notes?: string) {
  await ensureBgvSchema();
  // Only allow known check keys.
  if (!BGV_CHECKS.find(c => c.key === checkKey)) return { ok: false, error: 'bad check key' };
  const notesCol = checkKey.replace('check_', '') + '_notes';
  // Build query manually since column name varies — sql.raw to inject column.
  await db.execute(sql`UPDATE hr_bgv_records SET ${sql.raw(checkKey)} = ${status}, ${sql.raw(notesCol)} = ${notes || null}, updated_at = NOW() WHERE id = ${id}`);
  // Recompute overall status.
  const r = rows(await db.execute(sql`SELECT check_identity, check_address, check_education, check_employment, check_criminal, check_professional, check_credit, check_sanctions FROM hr_bgv_records WHERE id = ${id}`));
  if (r[0]) {
    const checks = Object.values(r[0]).filter(v => v && v !== 'n/a');
    let overall: string = 'pending';
    if (checks.includes('failed') || checks.includes('flagged')) overall = (checks.includes('failed') ? 'failed' : 'flagged');
    else if (checks.every(v => v === 'clear')) overall = 'clear';
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
