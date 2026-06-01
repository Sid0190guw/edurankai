// Fee-waiver: applicants with a financial hardship can request a waiver in
// place of paying. They write a situation + expertise note and link a CV /
// portfolio / supporting docs from Drive. Admin reviews; on approval the
// application is materialised from the intent the same way Razorpay capture
// would, but with fee_paid=true + fee_waiver_granted=true. On rejection the
// intent stays so the user can either resubmit the waiver or pay normally.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;
export function ensureFeeWaiverSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS application_fee_waivers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        intent_id UUID REFERENCES application_intents(id) ON DELETE SET NULL,
        application_id UUID,
        situation_note TEXT NOT NULL,
        expertise_note TEXT NOT NULL,
        drive_url TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        reject_reason TEXT,
        reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS afw_status_idx ON application_fee_waivers(status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS afw_user_idx ON application_fee_waivers(user_id, created_at DESC)`);
      // The applications table doesn't have a fee-waiver column yet; add idempotently.
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS fee_waiver_granted BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS fee_waiver_reason TEXT`);
    } catch (_) {}
  })();
  return ready;
}

function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export async function getWaiverForIntent(intentId: string, userId: string) {
  await ensureFeeWaiverSchema();
  try {
    return rows(await db.execute(sql`
      SELECT * FROM application_fee_waivers
      WHERE intent_id = ${intentId} AND user_id = ${userId}
      ORDER BY created_at DESC LIMIT 1
    `))[0] || null;
  } catch (_) { return null; }
}

// Materialise an application row from an intent — same shape used by
// payment-effects on Razorpay capture. Returns the new application id.
export async function materialiseFromIntent(intentId: string, opts: { paid: boolean; waiverGranted: boolean; waiverReason?: string }): Promise<string | null> {
  const intent = rows(await db.execute(sql`SELECT * FROM application_intents WHERE id = ${intentId} LIMIT 1`))[0] as any;
  if (!intent) return null;
  const d = (intent.data || {}) as any;
  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO applications (
        application_number, role_id, applicant_user_id,
        first_name, last_name, email, phone, city, linkedin,
        portfolio_url, photo_url, dob, birth_time, birth_place,
        department_snapshot, role_title_snapshot, level, open_to_other,
        education, field_of_study, institution, experience_band, experience_description,
        duolingo_score, duolingo_screenshot_url, tech_skills,
        why_era, why_role, why_ai_edu, intersection, ambitious,
        ethics_experience, ethics_ideal, availability, engagement_type, remote_comfort,
        compensation, source, status, raw_submission, ip_address, user_agent,
        fee_paid, fee_paid_at, fee_waiver_granted, fee_waiver_reason
      ) VALUES (
        ${d.applicationNumber || null}, ${d.roleId || null}, ${intent.user_id},
        ${d.firstName || ''}, ${d.lastName || ''}, ${d.email || ''}, ${d.phone || null},
        ${d.city || ''}, ${d.linkedin || null},
        ${d.portfolioUrl || ''}, ${d.photoUrl || null}, ${d.dob || null}, ${d.birthTime || null}, ${d.birthPlace || null},
        ${d.departmentSnapshot || null}, ${d.roleTitleSnapshot || ''}, ${d.level || null}, ${d.openToOther ?? false},
        ${d.education || null}, ${d.fieldOfStudy || null}, ${d.institution || null}, ${d.experienceBand || null}, ${d.experienceDescription || null},
        ${d.duolingoScore || null}, ${d.duolingoScreenshotUrl || null}, ${JSON.stringify(d.techSkills || {})}::jsonb,
        ${d.whyERA || null}, ${d.whyRole || null}, ${d.whyAIEdu || null}, ${d.intersection || null}, ${d.ambitious || null},
        ${d.ethicsExperience || null}, ${d.ethicsIdeal || null}, ${d.availability || null}, ${d.engagementType || null}, ${d.remoteComfort || null},
        ${d.compensation || null}, ${d.source || null}, 'submitted', ${JSON.stringify(d.rawSubmission || {})}::jsonb,
        ${d.ipAddress || null}, ${d.userAgent || null},
        ${opts.paid}, ${opts.paid || opts.waiverGranted ? sql`NOW()` : sql`NULL`},
        ${opts.waiverGranted}, ${opts.waiverReason || null}
      ) RETURNING id
    `));
    const newId = ins[0]?.id as string | undefined;
    if (newId) {
      await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
    }
    return newId || null;
  } catch (e) { return null; }
}
