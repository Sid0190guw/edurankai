// Universal certificate issuer — covers test pass, event participation, internship,
// employment, LOR, and admin-issued custom credentials. Coexists with the older
// course-only system in src/lib/certificates.ts (course_certificates table) so
// the existing AquinTutor course flow keeps working.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureUniversalCertSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS universal_certificates (
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
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ucert_serial_idx ON universal_certificates(serial)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ucert_recipient_idx ON universal_certificates(recipient_email, kind)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ucert_kind_idx ON universal_certificates(kind, signed_at DESC)`);
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
    const existing = rows(await db.execute(sql`
      SELECT * FROM universal_certificates WHERE kind = 'test' AND ref_attempt_id = ${opts.refAttemptId} AND revoked = false LIMIT 1
    `));
    if (existing[0]) return { ok: true, existing: true, id: existing[0].id, serial: existing[0].serial };
  }

  let serial = generateSerial(opts.kind);
  for (let i = 0; i < 5; i++) {
    const dup = rows(await db.execute(sql`SELECT 1 FROM universal_certificates WHERE serial = ${serial} LIMIT 1`));
    if (dup.length === 0) break;
    serial = generateSerial(opts.kind);
  }

  const metaJson = JSON.stringify(opts.metadata || {});

  const r = rows(await db.execute(sql`
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
  const r = rows(await db.execute(sql`SELECT * FROM universal_certificates WHERE serial = ${serial} LIMIT 1`));
  if (r[0]) {
    try {
      await db.execute(sql`UPDATE universal_certificates SET verify_count = verify_count + 1, last_verified_at = NOW() WHERE id = ${r[0].id}`);
    } catch (_) {}
  }
  return r[0] || null;
}

export async function listUniversal(opts: { kind?: string; limit?: number; q?: string } = {}) {
  await ensureUniversalCertSchema();
  const limit = Math.min(500, Math.max(10, opts.limit || 100));
  const q = (opts.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    return rows(await db.execute(sql`
      SELECT * FROM universal_certificates
      WHERE (recipient_name ILIKE ${like} OR recipient_email ILIKE ${like} OR serial ILIKE ${like} OR title ILIKE ${like})
        ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
      ORDER BY signed_at DESC, created_at DESC LIMIT ${limit}
    `));
  }
  return rows(await db.execute(sql`
    SELECT * FROM universal_certificates
    ${opts.kind ? sql`WHERE kind = ${opts.kind}` : sql``}
    ORDER BY signed_at DESC, created_at DESC LIMIT ${limit}
  `));
}

export async function revokeUniversal(serial: string, byUserId: string, reason: string) {
  await ensureUniversalCertSchema();
  await db.execute(sql`
    UPDATE universal_certificates SET revoked = true, revoked_at = NOW(), revoked_by_user_id = ${byUserId},
      revocation_reason = ${reason.slice(0, 1000)}, updated_at = NOW()
    WHERE serial = ${serial}
  `);
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
