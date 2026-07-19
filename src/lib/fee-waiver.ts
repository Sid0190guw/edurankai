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
      // Aid extent + voucher columns — populated when admin approves with a
      // specific grant amount and auto-generates a fee_waiver_coupon code.
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS grant_amount DECIMAL(8,2)`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS grant_currency VARCHAR(8) DEFAULT 'CHF'`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS grant_pct INT`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(64)`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS coupon_id UUID`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS coupon_expires_at TIMESTAMPTZ`);
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

  // Idempotency / duplicate guard — mirrors payment-effects: NEVER create a
  // second application for the same role + applicant. If one already exists
  // (e.g. created by a payment, or a double-click / re-approval), attach the
  // waiver to it, drop the intent, and return the existing id. This is what
  // stops the "one submitted + one reviewing" duplicate rows.
  // Validate FK targets BEFORE inserting (mirrors payment-effects.ts). A stale
  // role_id or a missing user is the usual reason the insert blew up — and because
  // the failure was swallowed below, the applicant silently stayed "awaiting fee"
  // forever. Sanitize so the application lands on the FIRST try.
  let roleIdSafe: any = d.roleId || null;
  try { if (roleIdSafe) { const rr = rows(await db.execute(sql`SELECT 1 FROM roles WHERE id = ${roleIdSafe} LIMIT 1`)); if (!rr.length) roleIdSafe = null; } } catch (_) { roleIdSafe = null; }
  let userIdSafe: any = intent.user_id || null;
  try { if (userIdSafe) { const uu = rows(await db.execute(sql`SELECT 1 FROM users WHERE id = ${userIdSafe} LIMIT 1`)); if (!uu.length) userIdSafe = null; } } catch (_) { userIdSafe = null; }
  const dupeEmail = String(d.email || intent.email || '').trim().toLowerCase();
  if (roleIdSafe && (userIdSafe || dupeEmail)) {
    const dupe = rows(await db.execute(sql`
      SELECT id FROM applications
      WHERE role_id = ${roleIdSafe}
        AND (
          (${userIdSafe}::uuid IS NOT NULL AND applicant_user_id = ${userIdSafe})
          OR (${dupeEmail} <> '' AND LOWER(email) = ${dupeEmail})
        )
      ORDER BY created_at ASC LIMIT 1
    `).catch(() => []))[0] as any;
    if (dupe?.id) {
      if (opts.waiverGranted) {
        await db.execute(sql`
          UPDATE applications
          SET fee_waiver_granted = true,
              fee_waiver_reason = COALESCE(${opts.waiverReason || null}, fee_waiver_reason),
              fee_paid_at = COALESCE(fee_paid_at, NOW())
          WHERE id = ${dupe.id}
        `).catch(() => {});
      }
      await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
      return dupe.id as string;
    }
  }

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
        ${d.applicationNumber || null}, ${roleIdSafe}, ${userIdSafe},
        ${d.firstName || ''}, ${d.lastName || ''}, ${d.email || (intent.email || '')}, ${d.phone || ''},
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
      // A waived application still gets a receipt: record a 0-value "paid" row
      // flagged as a waiver so /receipt/[order] can render it and say so.
      if (opts.waiverGranted) {
        const orderId = 'WAIVER-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const notes = JSON.stringify({ waiver: true, waiverReason: opts.waiverReason || 'Application fee waived', breakdown: { baseInrPaise: 0, offerDiscountPaise: 0, netInrPaise: 0 } }).replace(/'/g, "''");
        await db.execute(sql`
          INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
          VALUES (${orderId}, 0, 'INR', 'paid', 'application_fee_waived', 'application', ${newId}, ${intent.user_id}, ${d.email || intent.email || ''}, ${sql.raw("'" + notes + "'::jsonb")})
        `).catch(() => {});
      }
    }
    return newId || null;
  } catch (e) {
    // NEVER fail silently: a swallowed error here left applicants stuck at
    // "awaiting fee" with no trace. Record it so it shows in /admin/hardening.
    try { const { trackError } = await import('@/lib/logger'); await trackError('application.materialise_failed', e, { intentId, roleIdSafe, userIdSafe, email: dupeEmail }); } catch (_) {}
    return null;
  }
}
