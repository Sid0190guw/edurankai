// Universal certificate issuer — covers test pass, event participation, internship,
// employment, LOR, and admin-issued custom credentials. Coexists with the older
// course-only system in src/lib/certificates.ts (course_certificates table) so
// the existing AquinTutor course flow keeps working.
// Resolved LAZILY. A top-level db import makes src/lib/db throw DATABASE_URL is not set the moment
// any importer loads, which puts every pure function in this module — and in anything that imports
// it — out of reach of a test that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureUniversalCertSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS universal_certificates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        serial VARCHAR(40) NOT NULL UNIQUE,
        kind VARCHAR(40) NOT NULL,
        recipient_name VARCHAR(200) NOT NULL,
        recipient_email VARCHAR(200),
        recipient_user_id UUID,
        recipient_employee_id UUID,
        title VARCHAR(300) NOT NULL,
        body TEXT,
        achievement TEXT,
        ref_course_id UUID,
        ref_test_id UUID,
        ref_attempt_id UUID,
        ref_event_id UUID,
        issued_by_user_id UUID,
        issued_by_name VARCHAR(200),
        issued_by_designation VARCHAR(200),
        issuer_org VARCHAR(200) DEFAULT 'EduRankAI',
        signature_url TEXT,
        signed_at DATE NOT NULL DEFAULT CURRENT_DATE,
        valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
        valid_until DATE,
        score_pct DECIMAL(5,2),
        metadata JSONB,
        revoked BOOLEAN NOT NULL DEFAULT false,
        revoked_at TIMESTAMPTZ,
        revoked_by_user_id UUID,
        revocation_reason TEXT,
        verify_count INT NOT NULL DEFAULT 0,
        last_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS ucert_serial_idx ON universal_certificates(serial)`);
      await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS ucert_recipient_idx ON universal_certificates(recipient_email, kind)`);
      await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS ucert_kind_idx ON universal_certificates(kind, signed_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

function generateSerial(kind: string): string {
  const k = kind.slice(0, 2).toUpperCase();
  const y = new Date().getFullYear();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `ERA-${k}-${y}-${s}`;
}

export interface IssueUniversalOpts {
  kind: 'test' | 'event' | 'internship' | 'employment' | 'lor' | 'custom' | 'course';
  recipientName: string;
  recipientEmail?: string;
  recipientUserId?: string;
  recipientEmployeeId?: string;
  title: string;
  body?: string;
  achievement?: string;
  refCourseId?: string;
  refTestId?: string;
  refAttemptId?: string;
  refEventId?: string;
  issuedByUserId?: string;
  issuedByName?: string;
  issuedByDesignation?: string;
  issuerOrg?: string;
  signatureUrl?: string;
  validFrom?: string;
  validUntil?: string;
  scorePct?: number;
  metadata?: Record<string, any>;
}

export async function issueUniversalCertificate(opts: IssueUniversalOpts) {
  await ensureUniversalCertSchema();
  if (opts.kind === 'test' && opts.refAttemptId) {
    const existing = rows(await (await database()).execute(sql`
      SELECT * FROM universal_certificates WHERE kind = 'test' AND ref_attempt_id = ${opts.refAttemptId} AND revoked = false LIMIT 1
    `));
    if (existing[0]) return { ok: true, existing: true, id: existing[0].id, serial: existing[0].serial };
  }

  let serial = generateSerial(opts.kind);
  for (let i = 0; i < 5; i++) {
    const dup = rows(await (await database()).execute(sql`SELECT 1 FROM universal_certificates WHERE serial = ${serial} LIMIT 1`));
    if (dup.length === 0) break;
    serial = generateSerial(opts.kind);
  }

  const metaJson = JSON.stringify(opts.metadata || {});

  const r = rows(await (await database()).execute(sql`
    INSERT INTO universal_certificates (serial, kind, recipient_name, recipient_email, recipient_user_id, recipient_employee_id,
      title, body, achievement,
      ref_course_id, ref_test_id, ref_attempt_id, ref_event_id,
      issued_by_user_id, issued_by_name, issued_by_designation, issuer_org, signature_url,
      valid_from, valid_until, score_pct, metadata)
    VALUES (${serial}, ${opts.kind}, ${opts.recipientName.slice(0, 200)}, ${opts.recipientEmail || null},
      ${opts.recipientUserId || null}, ${opts.recipientEmployeeId || null},
      ${opts.title.slice(0, 300)}, ${opts.body || null}, ${opts.achievement || null},
      ${opts.refCourseId || null}, ${opts.refTestId || null}, ${opts.refAttemptId || null}, ${opts.refEventId || null},
      ${opts.issuedByUserId || null}, ${opts.issuedByName || null}, ${opts.issuedByDesignation || null},
      ${opts.issuerOrg || 'EduRankAI'}, ${opts.signatureUrl || null},
      ${opts.validFrom || sql`CURRENT_DATE`}, ${opts.validUntil || null},
      ${opts.scorePct ?? null}, ${metaJson}::jsonb)
    RETURNING id, serial
  `));
  return { ok: true, id: r[0]?.id, serial: r[0]?.serial };
}

export async function getUniversalBySerial(serial: string) {
  await ensureUniversalCertSchema();
  const r = rows(await (await database()).execute(sql`SELECT * FROM universal_certificates WHERE serial = ${serial} LIMIT 1`));
  if (r[0]) {
    try {
      await (await database()).execute(sql`UPDATE universal_certificates SET verify_count = verify_count + 1, last_verified_at = NOW() WHERE id = ${r[0].id}`);
    } catch (_) {}
  }
  return r[0] || null;
}

/**
 * One certificate, for the issuing desk. NOT getUniversalBySerial(): that one counts a public
 * verification, and an admin previewing or emailing a certificate is not somebody checking it.
 */
export async function getUniversalForAdmin(serial: string) {
  await ensureUniversalCertSchema();
  const r = rows(await (await database()).execute(sql`SELECT * FROM universal_certificates WHERE serial = ${String(serial || '').trim()} LIMIT 1`));
  return r[0] || null;
}

/** The fields an issued certificate may be corrected in. The serial, kind and issue date never change. */
export interface CertificateEdit {
  recipientName?: string;
  recipientEmail?: string | null;
  title?: string;
  body?: string | null;
  achievement?: string | null;
  issuedByName?: string | null;
  issuedByDesignation?: string | null;
  validUntil?: string | null;
  metadata?: {
    heading?: string; department?: string; fromDate?: string; toDate?: string;
    achievements?: string[]; skills?: string[]; measureLine?: string;
  };
}

export interface CertificateRevision {
  at: string;
  byUserId: string | null;
  byName: string;
  note: string;
  /** field -> [before, after], as text, for the fields that actually changed. */
  changed: Record<string, [string, string]>;
}

const asText = (v: unknown) => (Array.isArray(v) ? v.join(' | ') : String(v ?? ''));

/**
 * CORRECT A CERTIFICATE THAT HAS ALREADY BEEN ISSUED, AND SAY SO.
 *
 * A certificate is a record somebody relies on, so it is corrected rather than reissued: the serial,
 * the verification link and the issue date stay the same, every field that changes is written into
 * metadata.revisions with who changed it, when, what it said before and the reason they gave. The
 * public verification page reads that list and states the certificate was amended and when. Nothing
 * is overwritten silently, and a correction with no reason is refused.
 */
export async function amendUniversalCertificate(
  serial: string, edit: CertificateEdit, note: string, by: { userId: string | null; name: string },
): Promise<{ ok: boolean; changed?: string[]; error?: string }> {
  const reason = String(note || '').trim();
  if (reason.length < 5) return { ok: false, error: 'Write what you changed and why. It is kept with the certificate.' };
  const row = await getUniversalForAdmin(serial);
  if (!row) return { ok: false, error: 'No certificate has that serial.' };
  if (row.revoked) return { ok: false, error: 'That certificate is revoked. Issue a new one instead of correcting a withdrawn one.' };

  let meta: any = row.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  if (!meta || typeof meta !== 'object') meta = {};

  const changed: Record<string, [string, string]> = {};
  const next: any = {
    recipient_name: row.recipient_name, recipient_email: row.recipient_email, title: row.title, body: row.body,
    achievement: row.achievement, issued_by_name: row.issued_by_name, issued_by_designation: row.issued_by_designation,
    valid_until: row.valid_until ? String(row.valid_until instanceof Date ? row.valid_until.toISOString() : row.valid_until).slice(0, 10) : null,
  };
  const set = (col: string, label: string, v: unknown, max = 5000) => {
    if (v === undefined) return;
    const val = v === null ? null : String(v).trim().slice(0, max) || null;
    if (asText(next[col]) !== asText(val)) { changed[label] = [asText(next[col]), asText(val)]; next[col] = val; }
  };
  set('recipient_name', 'Name', edit.recipientName, 200);
  set('recipient_email', 'Email', edit.recipientEmail, 200);
  set('title', 'Programme', edit.title, 300);
  set('body', 'Citation', edit.body);
  set('achievement', 'Distinction', edit.achievement, 1000);
  set('issued_by_name', 'Signed by', edit.issuedByName, 200);
  set('issued_by_designation', 'Signatory title', edit.issuedByDesignation, 200);
  set('valid_until', 'Valid until', edit.validUntil, 10);
  if (!next.recipient_name || !next.title) return { ok: false, error: 'A certificate needs a name and a programme.' };

  const m = edit.metadata || {};
  const metaKeys: Array<[keyof NonNullable<CertificateEdit['metadata']>, string]> = [
    ['heading', 'Heading'], ['department', 'Team'], ['fromDate', 'From'], ['toDate', 'To'],
    ['achievements', 'Key contributions'], ['skills', 'Skills'], ['measureLine', 'Measured line'],
  ];
  for (const [k, label] of metaKeys) {
    if (m[k] === undefined) continue;
    const v = Array.isArray(m[k]) ? (m[k] as string[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : String(m[k] ?? '').trim();
    if (asText(meta[k]) !== asText(v)) { changed[label] = [asText(meta[k]), asText(v)]; meta[k] = v; }
  }

  const labels = Object.keys(changed);
  if (!labels.length) return { ok: false, error: 'Nothing was different from what the certificate already says, so nothing was changed.' };

  const revision: CertificateRevision = {
    at: new Date().toISOString(), byUserId: by.userId, byName: by.name || 'People desk', note: reason.slice(0, 1000), changed,
  };
  meta.revisions = (Array.isArray(meta.revisions) ? meta.revisions : []).concat([revision]).slice(-50);

  await (await database()).execute(sql`
    UPDATE universal_certificates SET
      recipient_name = ${next.recipient_name}, recipient_email = ${next.recipient_email}, title = ${next.title},
      body = ${next.body}, achievement = ${next.achievement}, issued_by_name = ${next.issued_by_name},
      issued_by_designation = ${next.issued_by_designation}, valid_until = ${next.valid_until}::date,
      metadata = ${JSON.stringify(meta)}::jsonb, updated_at = NOW()
    WHERE serial = ${serial}`);
  return { ok: true, changed: labels };
}

/** The most recent live certificate of a kind for one employee, if any. */
export async function universalForEmployee(employeeId: string, kind: string) {
  await ensureUniversalCertSchema();
  const r = rows(await (await database()).execute(sql`
    SELECT * FROM universal_certificates
     WHERE recipient_employee_id = ${employeeId}::uuid AND kind = ${kind} AND revoked = false
     ORDER BY created_at DESC LIMIT 1`));
  return r[0] || null;
}

export async function listUniversal(opts: { kind?: string; limit?: number; q?: string } = {}) {
  await ensureUniversalCertSchema();
  const limit = Math.min(500, Math.max(10, opts.limit || 100));
  const q = (opts.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    return rows(await (await database()).execute(sql`
      SELECT * FROM universal_certificates
      WHERE (recipient_name ILIKE ${like} OR recipient_email ILIKE ${like} OR serial ILIKE ${like} OR title ILIKE ${like})
        ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
      ORDER BY signed_at DESC, created_at DESC LIMIT ${limit}
    `));
  }
  return rows(await (await database()).execute(sql`
    SELECT * FROM universal_certificates
    ${opts.kind ? sql`WHERE kind = ${opts.kind}` : sql``}
    ORDER BY signed_at DESC, created_at DESC LIMIT ${limit}
  `));
}

/**
 * Revoke a certificate by serial. Answers whether a certificate was actually revoked.
 *
 * WAS a bare UPDATE returning nothing, and /admin/certificates printed
 * 'Certificate <serial> revoked.' on the strength of the call not throwing. A serial typed one
 * character wrong — these are hand-copied off a printed certificate — matched no row, the console
 * said the credential was revoked, and the public verification page went on verifying it as valid.
 * A withdrawn credential that still verifies is the one failure this whole module exists to prevent.
 *
 * `revoked = false` is in the WHERE as well, so a true answer means THIS call revoked it rather than
 * a previous one, and the reason and the revoking user cannot be quietly overwritten on a
 * certificate somebody else already withdrew.
 */
export async function revokeUniversal(serial: string, byUserId: string, reason: string): Promise<{ revoked: boolean; alreadyRevoked: boolean }> {
  await ensureUniversalCertSchema();
  const done = rows(await (await database()).execute(sql`
    UPDATE universal_certificates SET revoked = true, revoked_at = NOW(), revoked_by_user_id = ${byUserId},
      revocation_reason = ${reason.slice(0, 1000)}, updated_at = NOW()
    WHERE serial = ${serial} AND revoked = false
    RETURNING serial
  `));
  if (done.length > 0) return { revoked: true, alreadyRevoked: false };
  const existing = rows(await (await database()).execute(sql`SELECT revoked FROM universal_certificates WHERE serial = ${serial} LIMIT 1`));
  return { revoked: false, alreadyRevoked: existing.length > 0 && !!existing[0].revoked };
}

export const UCERT_KIND_LABELS: Record<string, { label: string; accent: string; description: string }> = {
  course:     { label: 'Course completion',         accent: '#86efac', description: 'Issued on completion of an AquinTutor course' },
  test:       { label: 'Test pass',                 accent: '#67e8f9', description: 'Issued on passing a graded test or assessment' },
  event:      { label: 'Event participation',       accent: '#fbbf24', description: 'Issued on participating in an event' },
  internship: { label: 'Internship',                accent: '#c4b5fd', description: 'Issued on completion of an internship engagement' },
  employment: { label: 'Employment',                accent: '#fca5a5', description: 'Issued at conclusion of employment with HR sign-off' },
  lor:        { label: 'Letter of recommendation',  accent: '#FF7040', description: 'Personalised letter from a manager or director' },
  custom:     { label: 'Custom',                    accent: '#a0a0ab', description: 'Free-form admin-issued credential' },
};
