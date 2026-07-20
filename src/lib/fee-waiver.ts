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
// The reason the last materialisation failed, so an admin surface can show WHY
// instead of a generic "could not create" (this class of failure was invisible before).
let _lastError: string | null = null;
export function lastMaterialiseError(): string | null { return _lastError; }

export async function materialiseFromIntent(intentId: string, opts: { paid: boolean; waiverGranted: boolean; waiverReason?: string }): Promise<string | null> {
  _lastError = null;
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

  // application_number is varchar(20) UNIQUE. A re-submitted applicant can carry a
  // number another application already took (they re-walk the form and the number is
  // regenerated from the same max), which made the INSERT blow up on the unique index.
  // Truncate to 20 and mint a fresh unique one whenever it is missing or taken.
  let appNumSafe: string | null = (d.applicationNumber ? String(d.applicationNumber).slice(0, 20) : null);
  try {
    let taken = false;
    if (appNumSafe) taken = rows(await db.execute(sql`SELECT 1 FROM applications WHERE application_number = ${appNumSafe} LIMIT 1`)).length > 0;
    if (!appNumSafe || taken) {
      const yearPrefix = 'ERA' + new Date().getFullYear();
      const maxRow = rows(await db.execute(sql`SELECT application_number AS n FROM applications WHERE application_number LIKE ${yearPrefix + '%'} ORDER BY application_number DESC LIMIT 1`))[0] as any;
      let next = 1;
      if (maxRow?.n) { const parsed = parseInt(String(maxRow.n).substring(yearPrefix.length), 10); if (Number.isFinite(parsed)) next = parsed + 1; }
      let candidate = (yearPrefix + String(next).padStart(5, '0')).slice(0, 20);
      // guarantee uniqueness even under a race / odd historical formats
      for (let i = 0; i < 5; i++) {
        const clash = rows(await db.execute(sql`SELECT 1 FROM applications WHERE application_number = ${candidate} LIMIT 1`)).length > 0;
        if (!clash) break;
        next += 1; candidate = (yearPrefix + String(next).padStart(5, '0')).slice(0, 20);
      }
      appNumSafe = candidate;
    }
  } catch (_) { appNumSafe = null; }   // nullable column — better null than a blown insert
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

  const cut = (v: any, n: number) => (v == null ? null : String(v).slice(0, n));
  // Shared post-insert work: drop the intent + write the 0-value waiver receipt.
  const finalise = async (newId: string): Promise<string> => {
    await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
    if (opts.waiverGranted) {
      const orderId = 'WAIVER-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const notes = JSON.stringify({ waiver: true, waiverReason: opts.waiverReason || 'Application fee waived' });
      await db.execute(sql`
        INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
        VALUES (${orderId}, 0, 'INR', 'paid', 'application_fee_waived', 'application', ${newId}, ${userIdSafe}, ${d.email || intent.email || null}, ${notes}::jsonb)
      `).catch(() => {});
    }
    return newId;
  };

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
        ${appNumSafe}, ${roleIdSafe}, ${userIdSafe},
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
  } catch (e: any) {
    _lastError = String(e?.cause?.message || e?.message || e || 'unknown error').slice(0, 300);
    // FALLBACK 1 (minimal): mirrors payment-effects. `level` is dropped on purpose —
    // it is an enum, and a value outside role_level is the most common reason the rich
    // insert fails. Every NOT-NULL column is supplied; raw_submission keeps everything.
    try {
      const insMin = rows(await db.execute(sql`
        INSERT INTO applications (
          application_number, role_id, applicant_user_id,
          first_name, last_name, email, phone, city, portfolio_url,
          department_snapshot, role_title_snapshot,
          tech_skills, why_era, why_role, why_ai_edu, source, status, raw_submission,
          fee_paid, fee_paid_at, fee_waiver_granted, fee_waiver_reason
        ) VALUES (
          ${appNumSafe}, ${roleIdSafe}, ${userIdSafe},
          ${cut(d.firstName, 100) || ''}, ${cut(d.lastName, 100) || ''}, ${cut(d.email || intent.email, 255) || ''}, ${cut(d.phone, 50) || ''}, ${cut(d.city, 120) || ''}, ${cut(d.portfolioUrl, 500) || ''},
          ${cut(d.departmentSnapshot, 120)}, ${cut(d.roleTitleSnapshot, 200) || ''},
          ${JSON.stringify(d.techSkills || {})}::jsonb, ${d.whyERA || null}, ${d.whyRole || null}, ${d.whyAIEdu || null}, ${cut(d.source, 120)}, 'submitted', ${JSON.stringify(d.rawSubmission || d)}::jsonb,
          false, NOW(), ${opts.waiverGranted}, ${opts.waiverReason || null}
        ) RETURNING id`));
      const minId = insMin[0]?.id as string | undefined;
      if (minId) { try { const { trackError } = await import('@/lib/logger'); await trackError('application.materialise_recovered_minimal', e, { intentId, appId: minId }); } catch (_) {} return await finalise(minId); }
    } catch (e2: any) {
      // FALLBACK 2 (bare): only columns that cannot be null; no enum, no FK, no dates.
      // Practically cannot fail unless the schema itself is broken.
      try {
        const bareNum = 'ERA-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
        const insBare = rows(await db.execute(sql`
          INSERT INTO applications (
            application_number, applicant_user_id,
            first_name, last_name, email, phone, city, portfolio_url,
            role_title_snapshot, status, raw_submission, fee_paid, fee_waiver_granted, fee_waiver_reason
          ) VALUES (
            ${bareNum}, ${userIdSafe},
            ${(d.firstName || '').toString().slice(0, 100)}, ${(d.lastName || '').toString().slice(0, 100)}, ${(d.email || intent.email || '').toString().slice(0, 255)}, ${(d.phone || '').toString().slice(0, 50)}, ${(d.city || '').toString().slice(0, 120)}, ${(d.portfolioUrl || '').toString().slice(0, 500)},
            ${(d.roleTitleSnapshot || 'Application').toString().slice(0, 200)}, 'submitted', ${JSON.stringify(d.rawSubmission || d)}::jsonb, false, ${opts.waiverGranted}, ${opts.waiverReason || null}
          ) RETURNING id`));
        const bareId = insBare[0]?.id as string | undefined;
        if (bareId) { try { const { trackError } = await import('@/lib/logger'); await trackError('application.materialise_recovered_bare', e2, { intentId, appId: bareId }); } catch (_) {} return await finalise(bareId); }
      } catch (e3: any) {
        _lastError = String(e3?.cause?.message || e3?.message || e3 || 'unknown error').slice(0, 300);
      }
    }
    // Every insert failed — keep the intent (never lose the applicant) + record why.
    try { const { trackError } = await import('@/lib/logger'); await trackError('application.materialise_failed', e, { intentId, roleIdSafe, userIdSafe, appNumSafe, email: dupeEmail, reason: _lastError }); } catch (_) {}
    return null;
  }
}
