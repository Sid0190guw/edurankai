// Campus Ambassador programme. CA applies via /careers/campus-ambassador,
// admin reviews + approves at /admin/campus-ambassadors, approved CAs get
// user.role = 'campus_ambassador' which unlocks the CA-specific submission
// flow in /portal/submissions.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureCaSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS campus_ambassadors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        applicant_name VARCHAR(200) NOT NULL,
        applicant_email VARCHAR(200) NOT NULL,
        applicant_phone VARCHAR(40),
        institution VARCHAR(200) NOT NULL,
        course_year VARCHAR(80),
        country VARCHAR(80) DEFAULT 'IN',
        why_join TEXT NOT NULL,
        outreach_plan TEXT,
        social_handles JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | approved | rejected | active | inactive | revoked
        approved_at TIMESTAMPTZ,
        approved_by UUID,
        revoked_at TIMESTAMPTZ,
        revoked_by UUID,
        revocation_reason TEXT,
        stipend_amount DECIMAL(10,2),
        stipend_currency VARCHAR(8) DEFAULT 'INR',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ca_status_idx ON campus_ambassadors(status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ca_email_idx ON campus_ambassadors(applicant_email)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ca_inst_idx ON campus_ambassadors(institution)`);
    } catch (_) {}
  })();
  return ready;
}

export async function applyAsAmbassador(opts: any) {
  await ensureCaSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO campus_ambassadors (user_id, applicant_name, applicant_email, applicant_phone, institution, course_year, country, why_join, outreach_plan, social_handles)
    VALUES (${opts.userId || null}, ${opts.name}, ${opts.email}, ${opts.phone || null}, ${opts.institution}, ${opts.courseYear || null}, ${opts.country || 'IN'},
      ${opts.whyJoin}, ${opts.outreachPlan || null}, ${JSON.stringify(opts.socialHandles || {})}::jsonb)
    RETURNING id
  `));
  return { ok: true, id: r[0]?.id };
}

/**
 * DECIDE ON A CAMPUS AMBASSADOR APPLICATION — AND TELL THE PERSON WHO APPLIED.
 *
 * THREE THINGS WERE WRONG HERE, and all three were invisible from every screen:
 *
 *  1. NOBODY WAS EVER TOLD. Somebody fills in the form on /careers/campus-ambassador and then
 *     nothing reaches them, ever — not on approval, not on rejection, not when their ambassadorship
 *     is revoked. From their side an approved application and an ignored one look identical, so they
 *     go on waiting. This module had no notifier at all.
 *  2. THE REJECTION REASON WAS DISCARDED. 'rejected' fell into the final `else`, which writes the
 *     status and nothing else — the admin types why, presses Reject, and the sentence goes nowhere.
 *     revocation_reason is the column that already exists for exactly this, so a refusal now records
 *     its reason there and repeats it to the applicant.
 *  3. IT ANSWERED `{ ok: true }` WHATEVER HAPPENED. No UPDATE read its own result, so a stale list,
 *     a second click or a deleted row printed "Ambassador approved." over a statement that matched
 *     nothing. RETURNING makes the difference visible.
 *
 * The role promotion keeps its own try/catch because it is a separate write with a separate failure
 * — but it is no longer a bare `catch (_) {}`: an ambassador who was approved without their account
 * being promoted cannot use the ambassador form, and that has to be sayable on screen.
 */
export async function decideAmbassador(opts: {
  id: string;
  status: 'approved' | 'rejected' | 'revoked' | 'inactive' | 'active';
  byUserId: string; reason?: string; stipend?: number; stipendCurrency?: string;
}): Promise<{ ok: boolean; error?: string; warning?: string }> {
  await ensureCaSchema();
  const why = (e: any) => String(e?.cause?.message || e?.message || 'unknown reason');
  let changed: any[] = [];
  // Declared before the branches that fill it. `const` is not hoisted.
  let warning = '';

  try {
    if (opts.status === 'approved') {
      changed = rows(await db.execute(sql`
        UPDATE campus_ambassadors
        SET status = 'approved', approved_at = NOW(), approved_by = ${opts.byUserId},
          stipend_amount = ${opts.stipend ?? null}, stipend_currency = ${opts.stipendCurrency || 'INR'},
          updated_at = NOW()
        WHERE id = ${opts.id}
        RETURNING id, user_id, applicant_name`));
      if (changed.length) {
        try {
          await db.execute(sql`
            UPDATE users SET role = 'campus_ambassador', updated_at = NOW()
             WHERE id IN (SELECT user_id FROM campus_ambassadors WHERE id = ${opts.id})
               AND role = 'applicant'`);
        } catch (e: any) {
          console.error('[campus-ambassadors] role promotion FAILED for', opts.id, '-', why(e));
          warning = 'they are approved, but their portal account was not promoted, so the ambassador '
            + 'form will still be closed to them (' + why(e) + ')';
        }
      }
    } else if (opts.status === 'revoked' || opts.status === 'inactive' || opts.status === 'rejected') {
      // 'rejected' joins this branch precisely so the reason is STORED. revoked_at/revoked_by read
      // as "when and by whom this was closed", which is true of a refusal as much as of a
      // withdrawal, and revocation_reason is the only column on this table that can hold the words.
      changed = rows(await db.execute(sql`
        UPDATE campus_ambassadors
        SET status = ${opts.status}, revoked_at = NOW(), revoked_by = ${opts.byUserId},
          revocation_reason = ${opts.reason || null}, updated_at = NOW()
        WHERE id = ${opts.id}
        RETURNING id, user_id, applicant_name`));
    } else {
      changed = rows(await db.execute(sql`
        UPDATE campus_ambassadors SET status = ${opts.status}, updated_at = NOW()
         WHERE id = ${opts.id}
        RETURNING id, user_id, applicant_name`));
    }
  } catch (e: any) {
    console.error('[campus-ambassadors] decision', opts.status, 'failed for', opts.id, '-', why(e));
    return { ok: false, error: 'The decision was not recorded: ' + why(e) };
  }

  if (!changed.length) {
    return {
      ok: false,
      error: 'Nothing was changed — that application is no longer on the list, or somebody else has '
        + 'already actioned it. Reload before deciding again.',
    };
  }

  // ---- THE APPLICANT HEARS THE DECISION ---------------------------------------------------------
  //
  // Best effort, and never swallowed: the decision is already committed and must not be reported as
  // failed, but "they were not told" is the fact this whole change is about, so it comes back as a
  // warning the screen shows rather than a line in a log nobody reads.
  const uid = changed[0]?.user_id;
  const reasonText = String(opts.reason || '').trim();
  const SAY: Record<string, { title: string; body: string; url: string }> = {
    approved: {
      title: 'You are a campus ambassador',
      body: 'Your application has been approved. The ambassador submission form is now open to you.',
      url: '/portal/submissions/new',
    },
    rejected: {
      title: 'Your campus ambassador application',
      body: 'It was not taken forward this time'
        + (reasonText ? ': ' + reasonText : '.') + ' Nothing is waiting on you.',
      url: '/portal',
    },
    revoked: {
      title: 'Your campus ambassadorship has ended',
      body: 'It has been withdrawn' + (reasonText ? ': ' + reasonText : '.')
        + ' The ambassador form is no longer open to you.',
      url: '/portal',
    },
    inactive: {
      title: 'Your campus ambassadorship is paused',
      body: 'It has been set to inactive' + (reasonText ? ': ' + reasonText : '.')
        + ' Nothing is waiting on you.',
      url: '/portal',
    },
    active: {
      title: 'Your campus ambassadorship is active again',
      body: 'The ambassador submission form is open to you once more.',
      url: '/portal/submissions/new',
    },
  };
  const say = SAY[opts.status];
  if (!uid) {
    warning = (warning ? warning + '; ' : '')
      + 'this application has no portal account attached, so the applicant could not be told';
  } else if (say) {
    try {
      const { notifyUser } = await import('@/lib/notify');
      await notifyUser(String(uid), {
        title: say.title, body: say.body, type: 'info',
        actionUrl: say.url, entityType: 'campus_ambassador', entityId: String(opts.id),
      });
    } catch (e: any) {
      console.error('[campus-ambassadors] the applicant was NOT told about', opts.id, '-', why(e));
      warning = (warning ? warning + '; ' : '') + 'the applicant was NOT notified (' + why(e) + ')';
    }
  }

  return warning ? { ok: true, warning } : { ok: true };
}

/**
 * IS THIS ACCOUNT A LIVE CAMPUS AMBASSADOR? Answered from the campus_ambassadors table.
 *
 * /portal/submissions/new decided this with `user.role === 'campus_ambassador'`, a comparison
 * against a union that has no such member — TypeScript reported it as "no overlap" and it was
 * permanently false, so no approved ambassador ever saw the CA form and EVERY submission in the
 * product was filed as 'applicant'.
 *
 * Matched on user_id first (written when the application was made from a signed-in session) and
 * then on the application email, because decideAmbassador() only promotes the role `WHERE role =
 * 'applicant'` — an ambassador who is also an intern keeps their other role and would otherwise be
 * invisible here.
 *
 * Returns null when there is no record. THROWS if the query fails: the caller must be able to tell
 * "not an ambassador" from "we could not find out", and a swallowed error here silently downgrades
 * a real ambassador's report to an applicant submission.
 */
export async function activeAmbassadorFor(opts: { userId?: string | null; email?: string | null }) {
  await ensureCaSchema();
  const userId = (opts.userId || '').trim();
  const email = (opts.email || '').trim().toLowerCase();
  if (!userId && !email) return null;
  const r = rows(await db.execute(sql`
    SELECT id, applicant_name, institution, status, approved_at
      FROM campus_ambassadors
     WHERE status IN ('approved', 'active')
       AND (
         ${userId ? sql`user_id = ${userId}` : sql`FALSE`}
         OR ${email ? sql`lower(applicant_email) = ${email}` : sql`FALSE`}
       )
     ORDER BY approved_at DESC NULLS LAST
     LIMIT 1
  `));
  return r[0] || null;
}

export async function listAmbassadors(filterStatus?: string) {
  await ensureCaSchema();
  return rows(await db.execute(sql`
    SELECT * FROM campus_ambassadors
    ${filterStatus ? sql`WHERE status = ${filterStatus}` : sql``}
    ORDER BY created_at DESC LIMIT 300
  `));
}
