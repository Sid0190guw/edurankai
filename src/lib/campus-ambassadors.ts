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

export async function decideAmbassador(opts: { id: string; status: 'approved' | 'rejected' | 'revoked' | 'inactive' | 'active'; byUserId: string; reason?: string; stipend?: number; stipendCurrency?: string }) {
  await ensureCaSchema();
  if (opts.status === 'approved') {
    await db.execute(sql`
      UPDATE campus_ambassadors
      SET status = 'approved', approved_at = NOW(), approved_by = ${opts.byUserId},
        stipend_amount = ${opts.stipend ?? null}, stipend_currency = ${opts.stipendCurrency || 'INR'},
        updated_at = NOW()
      WHERE id = ${opts.id}
    `);
    // Promote the user account role if linked
    try { await db.execute(sql`UPDATE users SET role = 'campus_ambassador', updated_at = NOW() WHERE id IN (SELECT user_id FROM campus_ambassadors WHERE id = ${opts.id}) AND role = 'applicant'`); } catch (_) {}
  } else if (opts.status === 'revoked' || opts.status === 'inactive') {
    await db.execute(sql`
      UPDATE campus_ambassadors
      SET status = ${opts.status}, revoked_at = NOW(), revoked_by = ${opts.byUserId},
        revocation_reason = ${opts.reason || null}, updated_at = NOW()
      WHERE id = ${opts.id}
    `);
  } else {
    await db.execute(sql`UPDATE campus_ambassadors SET status = ${opts.status}, updated_at = NOW() WHERE id = ${opts.id}`);
  }
  return { ok: true };
}

export async function listAmbassadors(filterStatus?: string) {
  await ensureCaSchema();
  return rows(await db.execute(sql`
    SELECT * FROM campus_ambassadors
    ${filterStatus ? sql`WHERE status = ${filterStatus}` : sql``}
    ORDER BY created_at DESC LIMIT 300
  `));
}
