// Downstream effects of a captured payment, applied idempotently. Called from
// BOTH the browser-side verify (/api/payments/verify) and the Razorpay webhook
// (/api/payments/webhook) so a payment completes even if the browser never
// returns (tab closed, network drop). Safe to run more than once per order.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { fetchOrderPayments } from '@/lib/razorpay';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

// Defensive coercion — a single malformed field (an over-long string, a
// non-numeric score, a level outside the enum) must never sink a PAID
// application's insert and push it into the stuck-recovery path.
const APP_LEVELS = ['C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice'];
function cut(v: any, n: number): string | null { return v == null || v === '' ? null : String(v).slice(0, n); }
function intOrNull(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; }
function levelOrNull(v: any): string | null { return APP_LEVELS.includes(v) ? v : null; }

// Reconcile ONE order against Razorpay. The webhook + browser /verify are the
// fast paths; this is the backstop for when BOTH miss (tab closed before
// /verify AND no webhook configured/fired). If Razorpay shows a captured (or
// authorized) payment for this order but our row isn't 'paid', mark it paid and
// apply the downstream effects. This is what stops a "paid but lost" application
// and the retry double-charge (the next order-start call settles the old one
// instead of charging again). Idempotent.
export async function reconcileOrder(orderId: string): Promise<{ reconciled: boolean; applicationId?: string }> {
  if (!orderId) return { reconciled: false };
  const pays = await fetchOrderPayments(orderId);
  const cap = pays.find((p: any) => p.status === 'captured' || p.status === 'authorized');
  if (!cap) return { reconciled: false };
  await db.execute(sql`
    UPDATE payments SET status = 'paid', razorpay_payment_id = COALESCE(${cap.id || null}, razorpay_payment_id), updated_at = NOW()
    WHERE order_id = ${orderId} AND status NOT IN ('paid', 'refunded')
  `).catch(() => {});
  const r = await applyPaidEffects(orderId, cap.id || null);
  return { reconciled: true, applicationId: (r && (r as any).applicationId) || undefined };
}

// Reconcile just ONE user's recent unsettled orders. Cheap to call on page
// load (the portal / confirmation): the SELECT is trivial when nothing is
// pending, and only hits Razorpay when the user actually has an open order.
// This is what flips a "paid but still pending" application to submitted the
// moment the applicant returns, without waiting for the daily cron.
export async function reconcileUserPending(userId: string): Promise<number> {
  if (!userId) return 0;
  const pend = rows(await db.execute(sql`
    SELECT order_id FROM payments
    WHERE user_id = ${userId} AND status IN ('created', 'attempted', 'authorized') AND order_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 8
  `).catch(() => []));
  let n = 0;
  for (const p of pend) {
    try { const r = await reconcileOrder((p as any).order_id); if (r.reconciled) n++; } catch (_) {}
  }
  // PAID-but-stuck: payment captured but the application never materialised
  // (reference still points at the intent). Re-run the effects (now with the
  // type-safe fallback insert) so it lands.
  try {
    const stuck = rows(await db.execute(sql`
      SELECT order_id FROM payments
      WHERE user_id = ${userId} AND status = 'paid' AND reference_type = 'application_intent' AND order_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 8
    `).catch(() => []));
    for (const s of stuck) {
      try { const r = await applyPaidEffects((s as any).order_id, null); if (r && (r as any).applicationId) n++; } catch (_) {}
    }
  } catch (_) {}
  return n;
}

// Scan recent unsettled payments and reconcile each (cron backstop).
export async function reconcilePending(limit = 150): Promise<{ scanned: number; reconciled: number }> {
  const pend = rows(await db.execute(sql`
    SELECT order_id FROM payments
    WHERE status IN ('created', 'attempted', 'authorized') AND order_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '14 days'
      AND created_at < NOW() - INTERVAL '3 minutes'
    ORDER BY created_at DESC LIMIT ${limit}
  `).catch(() => []));
  let reconciled = 0;
  for (const p of pend) {
    try { const r = await reconcileOrder((p as any).order_id); if (r.reconciled) reconciled++; } catch (_) {}
  }
  // Also re-materialise any PAID-but-stuck applications across all users.
  try {
    const stuck = rows(await db.execute(sql`
      SELECT order_id FROM payments
      WHERE status = 'paid' AND reference_type = 'application_intent' AND order_id IS NOT NULL
      ORDER BY created_at DESC LIMIT ${limit}
    `).catch(() => []));
    for (const s of stuck) {
      try { const r = await applyPaidEffects((s as any).order_id, null); if (r && (r as any).applicationId) reconciled++; } catch (_) {}
    }
  } catch (_) {}
  return { scanned: pend.length, reconciled };
}

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

    // Validate FK targets and the level enum BEFORE inserting. A stale role_id, a
    // missing user, or a level outside role_level are the usual reasons the insert
    // blew up — sanitize them so the application lands cleanly on the FIRST try
    // (these are also reused by the fallbacks below).
    let roleIdSafe: any = null;
    try { if (d.roleId) { const rr = rows(await db.execute(sql`SELECT 1 FROM roles WHERE id = ${d.roleId} LIMIT 1`)); roleIdSafe = rr.length ? d.roleId : null; } } catch (_) {}
    let userIdSafe: any = intent.user_id || null;
    try { if (userIdSafe) { const uu = rows(await db.execute(sql`SELECT 1 FROM users WHERE id = ${userIdSafe} LIMIT 1`)); if (!uu.length) userIdSafe = null; } } catch (_) {}

    // Duplicate guard: if this applicant already has an application for this exact
    // role, a second paid intent is a duplicate retry — do NOT create another row
    // (that is the pile-up admins saw). Attach the payment to the existing app,
    // drop the intent, flag the extra charge, and let an admin decide refund/credit
    // — never auto-touch money.
    const dupeEmail = String(d.email || intent.email || '').trim().toLowerCase();
    if (roleIdSafe && (userIdSafe || dupeEmail)) {
      // Match by user id OR email: guest applicants have no user id, and the
      // user-id-only guard let their duplicate rows through.
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
        await db.execute(sql`UPDATE payments SET reference_id = ${dupe.id}, reference_type = 'application' WHERE order_id = ${orderId}`).catch(() => {});
        await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
        try {
          await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS duplicate_of_application UUID`);
          await db.execute(sql`UPDATE payments SET duplicate_of_application = ${dupe.id} WHERE order_id = ${orderId}`);
        } catch (_) {}
        try {
          const { sendPushToAdmins } = await import('@/lib/push');
          const nm = ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.email || 'Applicant';
          await sendPushToAdmins({ type: 'duplicate_application_fee', title: 'Duplicate application fee', body: nm + ' paid again for a role they already applied to — review for refund/credit.', url: '/admin/applications/' + dupe.id, tag: 'dup-fee-' + orderId });
        } catch (_) {}
        return { applicationId: dupe.id, duplicate: true } as any;
      }
    }

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
          ${cut(d.applicationNumber, 20)}, ${roleIdSafe}, ${userIdSafe},
          ${cut(d.firstName, 100) || ''}, ${cut(d.lastName, 100) || ''}, ${cut(d.email || intent.email, 255) || ''}, ${cut(d.phone, 50) || ''},
          ${cut(d.city, 200) || ''}, ${d.linkedin || null},
          ${d.portfolioUrl || ''}, ${d.photoUrl || null}, ${cut(d.dob, 20)}, ${cut(d.birthTime, 20)}, ${cut(d.birthPlace, 200)},
          ${cut(d.departmentSnapshot, 200)}, ${cut(d.roleTitleSnapshot, 200) || ''}, ${levelOrNull(d.level)}, ${d.openToOther ?? false},
          ${cut(d.education, 100)}, ${cut(d.fieldOfStudy, 200)}, ${cut(d.institution, 300)}, ${cut(d.experienceBand, 50)}, ${d.experienceDescription || null},
          ${intOrNull(d.duolingoScore)}, ${d.duolingoScreenshotUrl || null}, ${JSON.stringify(d.techSkills || {})}::jsonb,
          ${d.whyERA || null}, ${d.whyRole || null}, ${d.whyAIEdu || null}, ${d.intersection || null}, ${d.ambitious || null},
          ${d.ethicsExperience || null}, ${d.ethicsIdeal || null}, ${cut(d.availability, 100)}, ${cut(d.engagementType, 100)}, ${cut(d.remoteComfort, 100)},
          ${cut(d.compensation, 200)}, ${cut(d.source, 100)}, 'submitted', ${JSON.stringify(d.rawSubmission || {})}::jsonb,
          ${d.ipAddress || null}, ${d.userAgent || null},
          true, ${paymentId}, NOW(),
          ${cut(d.programmeChoice, 80)}, ${d.programmeEngagementNote || null}, ${d.programmeEngagementUrl || null}
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
      // Email the payment receipt (view/print at /receipt/<order>). Best-effort:
      // a mail failure must never affect the payment flow.
      try {
        const rcptEmail = String(d.email || intent.email || '').trim();
        if (newAppId && rcptEmail) {
          const { sendExternal } = await import('@/lib/mail-transport');
          const link = 'https://edurankai.in/receipt/' + encodeURIComponent(orderId) + '?e=' + encodeURIComponent(rcptEmail.toLowerCase());
          const nm = ((d.firstName || '') + ' ' + (d.lastName || '')).trim();
          await sendExternal({
            from: 'EduRankAI <connect@edurankai.in>',
            to: rcptEmail,
            subject: 'Payment received — your EduRankAI receipt',
            html: '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">'
              + '<p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#FF4F00;margin:0 0 18px;">EduRankAI</p>'
              + '<h1 style="font-size:21px;font-weight:600;margin:0 0 14px;">Payment received' + (nm ? ', ' + nm : '') + '.</h1>'
              + '<p style="font-size:15px;line-height:1.7;margin:0 0 10px;">Your application fee has been received and your application is confirmed. Your receipt is ready — you can view, download, or print it any time:</p>'
              + '<a href="' + link + '" style="display:inline-block;background:#FF4F00;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;margin:8px 0 18px;">View my receipt</a>'
              + '<p style="font-size:12.5px;color:#8a8a8a;line-height:1.6;margin:0;">Questions about this payment? Reply to this email quoting your receipt link.</p>'
              + '</div>',
            text: 'Payment received. View your receipt: ' + link,
          });
        }
      } catch (_) {}
    } catch (e: any) {
      // The full insert failed (usually a bad date or an over-long field in the
      // applicant's data). RETRY with a minimal, type-safe insert so a PAID
      // application is never lost — risky typed columns are nulled and the full
      // submission is preserved in raw_submission for later backfill.
      try {
        // ALWAYS a fresh unique number (a reused one collides on a reattempt).
        // roleIdSafe / userIdSafe / cut() are validated once above and reused here.
        const appNum = 'ERA-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
        // NOTE: every NOT-NULL column (first_name, last_name, email, phone, city,
        // portfolio_url) MUST be supplied here or the insert fails outright. `level`
        // is dropped on purpose — it is an enum, and a value outside role_level is
        // the most common reason the full insert above failed; nulling it lets the
        // application land while raw_submission keeps the original value.
        const insMin = rows(await db.execute(sql`
          INSERT INTO applications (
            application_number, role_id, applicant_user_id,
            first_name, last_name, email, phone, city, portfolio_url,
            department_snapshot, role_title_snapshot,
            tech_skills, why_era, why_role, why_ai_edu, source, status, raw_submission,
            fee_paid, fee_payment_id, fee_paid_at
          ) VALUES (
            ${appNum}, ${roleIdSafe}, ${userIdSafe},
            ${cut(d.firstName, 100) || ''}, ${cut(d.lastName, 100) || ''}, ${cut(d.email || intent.email, 255) || ''}, ${cut(d.phone, 50) || ''}, ${cut(d.city, 200) || ''}, ${d.portfolioUrl || ''},
            ${cut(d.departmentSnapshot, 120)}, ${cut(d.roleTitleSnapshot, 200) || ''},
            ${JSON.stringify(d.techSkills || {})}::jsonb, ${d.whyERA || null}, ${d.whyRole || null}, ${d.whyAIEdu || null}, ${cut(d.source, 60)}, 'submitted', ${JSON.stringify(d.rawSubmission || d)}::jsonb,
            true, ${paymentId}, NOW()
          ) RETURNING id
        `));
        const minId = insMin[0]?.id as string | undefined;
        if (minId) {
          await db.execute(sql`UPDATE payments SET reference_id = ${minId}, reference_type = 'application' WHERE order_id = ${orderId}`).catch(() => {});
          await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
          try {
            const { sendPushToAdmins } = await import('@/lib/push');
            const nm = ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.email || 'Applicant';
            await sendPushToAdmins({ type: 'application_recovered', title: 'Paid application saved (recovered)', body: nm + ' is now in review. A couple of fields may need backfill.', url: '/admin/applications/' + minId, tag: 'recovered-' + minId });
          } catch (_) {}
          return { applicationId: minId };
        }
      } catch (e2: any) {
        // Last resort: a BARE insert with only the columns that cannot be null,
        // role_id omitted, every detail kept in raw_submission. Practically cannot
        // fail unless the schema itself is broken.
        try {
          const bareNum = 'ERA-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
          // Includes EVERY NOT-NULL column with a safe '' default and touches no
          // enum / FK / date-typed column — so it cannot fail on bad applicant data.
          const insBare = rows(await db.execute(sql`
            INSERT INTO applications (
              application_number, applicant_user_id,
              first_name, last_name, email, phone, city, portfolio_url,
              role_title_snapshot, status, raw_submission, fee_paid, fee_payment_id, fee_paid_at
            ) VALUES (
              ${bareNum}, ${userIdSafe},
              ${(d.firstName || '').toString().slice(0, 100)}, ${(d.lastName || '').toString().slice(0, 100)}, ${(d.email || intent.email || 'unknown@edurankai.in').toString().slice(0, 200)}, ${(d.phone || '').toString().slice(0, 50)}, ${(d.city || '').toString().slice(0, 200)}, ${(d.portfolioUrl || '').toString()},
              ${(d.roleTitleSnapshot || 'Application').toString().slice(0, 200)}, 'submitted', ${JSON.stringify(d.rawSubmission || d)}::jsonb, true, ${paymentId}, NOW()
            ) RETURNING id`));
          const bareId = insBare[0]?.id as string | undefined;
          if (bareId) {
            await db.execute(sql`UPDATE payments SET reference_id = ${bareId}, reference_type = 'application' WHERE order_id = ${orderId}`).catch(() => {});
            await db.execute(sql`DELETE FROM application_intents WHERE id = ${intent.id}`).catch(() => {});
            try { const { sendPushToAdmins } = await import('@/lib/push'); await sendPushToAdmins({ type: 'application_recovered', title: 'Paid application saved (recovered)', body: (((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.email || 'Applicant') + ' is now in review (recovered - a few fields need backfill).', url: '/admin/applications/' + bareId, tag: 'recovered-' + bareId }); } catch (_) {}
            return { applicationId: bareId };
          }
        } catch (e3: any) {
          console.error('[payments] BARE materialise also failed for intent', intent.id, '-', (e3 as any)?.cause?.message || e3?.message || e3);
        }
      }
      // All inserts failed — keep the intent + alert so the paid applicant is never
      // lost. drizzle wraps the underlying Postgres error in `.cause`; the bare
      // `.message` is only the failed SQL text, so surface `.cause` for diagnosis.
      const realErr = String((e as any)?.cause?.message || e?.message || e);
      console.error('[payments] application materialise FAILED for intent', intent.id, 'order', orderId, '-', realErr);
      let alreadyFlagged = false;
      try {
        await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS materialise_error TEXT`);
        await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS paid_order_id TEXT`);
        const prev = rows(await db.execute(sql`SELECT materialise_error FROM application_intents WHERE id = ${intent.id} LIMIT 1`))[0] as any;
        alreadyFlagged = !!(prev && prev.materialise_error);
        await db.execute(sql`UPDATE application_intents SET materialise_error = ${realErr.slice(0, 500)}, paid_order_id = ${orderId} WHERE id = ${intent.id}`);
      } catch (_) {}
      // Alert admins only on the FIRST failure for this intent. reconcileUserPending
      // (every portal page load) and reconcilePending (cron) both re-run this path,
      // so without the guard each pass re-sends and buries admins under duplicate
      // "needs recovery" notifications — exactly the pile-up that was happening.
      if (!alreadyFlagged) {
        try {
          const { sendPushToAdmins } = await import('@/lib/push');
          await sendPushToAdmins({
            type: 'paid_application_stuck',
            title: 'Paid application needs recovery',
            body: (((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.email || 'Applicant') + ' paid but the application did not save. Error: ' + realErr.slice(0, 110),
            url: '/admin/paid-stuck',
            tag: 'paid-stuck-' + intent.id,
          });
        } catch (_) {}
      }
      return { applicationId: undefined, failed: true } as any;
    }
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

  // AquinTutor partnership Starter fee (one-time CHF 100) -> mark the partnership
  // application's starter fee paid so the team can onboard. Self-bootstrapping cols.
  if (pay.purpose === 'partnership_starter' || pay.reference_type === 'partnership_application') {
    try {
      await db.execute(sql`ALTER TABLE partnership_applications ADD COLUMN IF NOT EXISTS starter_fee_paid BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE partnership_applications ADD COLUMN IF NOT EXISTS fee_payment_id TEXT`);
      await db.execute(sql`ALTER TABLE partnership_applications ADD COLUMN IF NOT EXISTS fee_paid_at TIMESTAMPTZ`);
      await db.execute(sql`UPDATE partnership_applications SET starter_fee_paid = true, fee_payment_id = ${paymentId}, fee_paid_at = NOW(), updated_at = NOW() WHERE id = ${pay.reference_id}`);
    } catch (_) {}
    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({ type: 'partnership_starter_paid', title: 'Partnership Starter fee paid', body: 'A partner paid the one-time CHF 100 Starter fee — ready to verify and onboard.', url: '/admin/finance', tag: 'pship-' + pay.reference_id });
    } catch (_) {}
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

  // Wallet recharge -> add the paid amount to the user's account credit.
  // Idempotent on the order id so webhook + verify + reconcile never double-credit.
  if (pay.purpose === 'wallet_recharge' || pay.reference_type === 'wallet') {
    try {
      const dup = rows(await db.execute(sql`SELECT 1 FROM account_credit_ledger WHERE ref_id = ${orderId} LIMIT 1`).catch(() => []));
      if (!dup.length) {
        const amt = Number(rows(await db.execute(sql`SELECT amount_paise FROM payments WHERE order_id = ${orderId} LIMIT 1`))[0]?.amount_paise) || 0;
        if (amt > 0) {
          const { ensureCreditSchema } = await import('@/lib/account-credit');
          await ensureCreditSchema();
          await db.execute(sql`INSERT INTO account_credit_ledger (user_id, delta_paise, reason, ref_type, ref_id) VALUES (${pay.user_id || pay.reference_id}, ${amt}, 'Wallet top-up', 'recharge', ${orderId})`).catch(() => {});
        }
      }
    } catch (_) {}
    return;
  }
}
