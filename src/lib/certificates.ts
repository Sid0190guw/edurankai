// Course completion certificate issuance + verification.
// Auto-issued when an enrollment hits 100% progress; can also be issued
// manually from admin. Unique per (user, course).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS course_certificates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id UUID NOT NULL, course_title TEXT NOT NULL,
      cert_number VARCHAR(40) UNIQUE NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      grade VARCHAR(8), verification_url TEXT,
      UNIQUE(user_id, course_id))`);
  } catch (_) {}
}

function makeCertNumber(): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rnd = randomBytes(3).toString('hex').toUpperCase();
  return `ERA-CERT-${ts}-${rnd}`;
}

export async function issueCertificate(opts: { userId: string; courseId: string; courseTitle: string; grade?: string }): Promise<{ id: string; certNumber: string; alreadyIssued: boolean } | null> {
  if (!opts.userId || !opts.courseId) return null;
  await ensureSchema();
  const existing = rows(await db.execute(sql`SELECT id, cert_number FROM course_certificates WHERE user_id = ${opts.userId} AND course_id = ${opts.courseId} LIMIT 1`))[0] as any;
  if (existing) return { id: existing.id, certNumber: existing.cert_number, alreadyIssued: true };

  let certNumber = makeCertNumber();
  for (let i = 0; i < 5; i++) {
    const clash = rows(await db.execute(sql`SELECT 1 FROM course_certificates WHERE cert_number = ${certNumber} LIMIT 1`));
    if (!clash[0]) break;
    certNumber = makeCertNumber();
  }

  const ins = rows(await db.execute(sql`
    INSERT INTO course_certificates (user_id, course_id, course_title, cert_number, grade, verification_url)
    VALUES (${opts.userId}, ${opts.courseId}, ${opts.courseTitle}, ${certNumber}, ${opts.grade || null},
      ${'https://www.edurankai.in/verify/' + certNumber})
    RETURNING id, cert_number
  `));
  return { id: ins[0].id, certNumber: ins[0].cert_number, alreadyIssued: false };
}

export async function getCertificatesForUser(userId: string) {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT id, course_id, course_title, cert_number, issued_at, grade, verification_url
    FROM course_certificates WHERE user_id = ${userId} ORDER BY issued_at DESC
  `));
}

export async function verifyCertificate(certNumber: string) {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT c.cert_number, c.course_title, c.issued_at, c.grade, u.name AS user_name
    FROM course_certificates c LEFT JOIN users u ON c.user_id = u.id
    WHERE c.cert_number = ${certNumber} LIMIT 1
  `))[0] || null;
}
