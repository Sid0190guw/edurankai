// Downstream effects of a captured payment, applied idempotently. Called from
// BOTH the browser-side verify (/api/payments/verify) and the Razorpay webhook
// (/api/payments/webhook) so a payment completes even if the browser never
// returns (tab closed, network drop). Safe to run more than once per order.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export async function applyPaidEffects(orderId: string, paymentId: string | null): Promise<{ applicationId?: string } | void> {
  if (!orderId) return;
  const pay = rows(await db.execute(sql`SELECT purpose, reference_type, reference_id, user_id FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0] as any;
  if (!pay || !pay.reference_id) return;

  // INTENT -> APPLICATION materialisation. This is the only path that creates
  // a real applications row, so the `applications` table NEVER carries unpaid
  // rows. The intent row is deleted once the application is created.
  if (pay.purpose === 'application_fee_intent' || pay.reference_type === 'application_intent') {
    const intent = rows(await db.execute(sql`SELECT * FROM application_intents WHERE id = ${pay.reference_id} LIMIT 1`))[0] as any;
    if (!intent) return; // intent already materialised by a prior call; idempotent.
    const d = (intent.data || {}) as any;
    let newAppId: string | undefined;
    // Make sure programme columns exist (best effort) so PD applications can land them.
    try {
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS programme_choice VARCHAR(80)`);
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS programme_engagement_note TEXT`);
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS programme_engagement_url TEXT`);
    } catch (_) {}
    try {
      const inserted = rows(await db.execute(sql`
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
          fee_paid, fee_payment_id, fee_paid_at,
          programme_choice, programme_engagement_note, programme_engagement_url
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
          true, ${paymentId}, NOW(),
          ${d.programmeChoice || null}, ${d.programmeEngagementNote || null}, ${d.programmeEngagementUrl || null}
        )
        RETURNING id
      `));
      newAppId = inserted[0]?.id as string | undefined;
      // Re-point the payments row at the new application + delete the intent.
      if (newAppId) {
        await db.execute(sql`UPDATE payments SET reference_id = ${newAppId}, reference_type = 'application' WHERE order_id = ${orderId}`).catch(() => {});
        await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
      }
      // Notify admins now that the application is real.
      try {
        const { pushNotify } = await import('@/lib/push');
        const name = ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.email || 'Applicant';
        if (newAppId) await pushNotify.newApplication(name, d.roleTitleSnapshot || 'a role', newAppId);
      } catch (_) {}
    } catch (e) { /* leave intent in place — admin or user can retry */ }
    return { applicationId: newAppId };
  }

  // Application processing/verification fee -> mark application paid AND flip
  // pending_payment -> submitted so it joins the live queue. Without this flip
  // the candidate row stays hidden under the pending tab and admins never see it.
  if (pay.purpose === 'application_fee' || pay.reference_type === 'application') {
    try { await db.execute(sql`ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'pending_payment'`); } catch (_) {}
    await db.execute(sql`
      UPDATE applications SET
        fee_paid = true,
        fee_payment_id = ${paymentId},
        fee_paid_at = NOW(),
        status = CASE WHEN status = 'pending_payment' THEN 'submitted' ELSE status END,
        updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    return { applicationId: pay.reference_id };
  }

  // 1 CHF registration/activation fee -> approve the user's account.
  if (pay.purpose === 'registration_fee' || pay.reference_type === 'user') {
    await db.execute(sql`
      UPDATE users SET reg_fee_paid = true, reg_fee_payment_id = ${paymentId}, access_status = 'approved', updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    return;
  }

  // Event level fee -> mark the progress paid + auto-issue (no-test levels).
  if (pay.purpose === 'event_level' || pay.reference_type === 'event_level') {
    await db.execute(sql`
      UPDATE event_level_progress SET fee_paid = true, fee_payment_id = ${paymentId}, fee_paid_at = NOW(), status = 'paid', updated_at = NOW()
      WHERE id = ${pay.reference_id}
    `).catch(() => {});
    try {
      const prog = rows(await db.execute(sql`
        SELECT elp.registration_id, elp.level_id, elp.event_id, el.auto_issue_artifact, el.test_id
        FROM event_level_progress elp JOIN event_levels el ON el.id = elp.level_id
        WHERE elp.id = ${pay.reference_id} LIMIT 1
      `))[0] as any;
      if (prog && prog.auto_issue_artifact && !prog.test_id) {
        const { issueArtifact } = await import('@/lib/issue-artifact');
        await issueArtifact({ registrationId: prog.registration_id, eventId: prog.event_id, levelId: prog.level_id, artifactType: prog.auto_issue_artifact, autoIssued: true });
      }
    } catch (_) {}
    return;
  }
}
