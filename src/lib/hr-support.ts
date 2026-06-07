// HR Application Support — paid 25 CHF service where an HR rep schedules a
// virtual meet with the candidate and guides them through their application.
// Self-bootstrapping schema; paid via Razorpay (same gateway as test fees).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureHrSupportSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_application_support (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        candidate_name VARCHAR(200) NOT NULL,
        candidate_email VARCHAR(200) NOT NULL,
        candidate_phone VARCHAR(40),
        support_kind VARCHAR(40) NOT NULL,
          -- application_strategy | role_selection | interview_prep |
          -- profile_review | cv_review | portfolio_review | general
        situation TEXT NOT NULL,
        target_role_slug VARCHAR(120),
        preferred_window VARCHAR(80),
          -- e.g. 'weekday_morning_ist', 'weekday_evening_ist', 'weekend'
        timezone VARCHAR(60),
        fee_currency VARCHAR(8) NOT NULL DEFAULT 'CHF',
        fee_amount DECIMAL(8,2) NOT NULL DEFAULT 25.00,
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | paid | refunded | cancelled
        razorpay_order_id VARCHAR(80),
        razorpay_payment_id VARCHAR(80),
        paid_at TIMESTAMPTZ,
        meet_link TEXT,
        meet_scheduled_at TIMESTAMPTZ,
        hr_rep_user_id UUID,
        completed_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hras_status_idx ON hr_application_support(payment_status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hras_email_idx ON hr_application_support(candidate_email)`);
    } catch (_) {}
  })();
  return ready;
}

export interface CreateHrSupportOpts {
  userId?: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone?: string;
  supportKind: string;
  situation: string;
  targetRoleSlug?: string;
  preferredWindow?: string;
  timezone?: string;
}

export async function createHrSupportRequest(opts: CreateHrSupportOpts) {
  await ensureHrSupportSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO hr_application_support (
      user_id, candidate_name, candidate_email, candidate_phone,
      support_kind, situation, target_role_slug, preferred_window, timezone
    ) VALUES (
      ${opts.userId || null}, ${opts.candidateName.slice(0, 200)},
      ${opts.candidateEmail.slice(0, 200)}, ${opts.candidatePhone?.slice(0, 40) || null},
      ${opts.supportKind}, ${opts.situation.slice(0, 5000)},
      ${opts.targetRoleSlug || null}, ${opts.preferredWindow || null}, ${opts.timezone || null}
    ) RETURNING id, created_at
  `));
  return { ok: true, id: r[0]?.id };
}

export const SUPPORT_KINDS: Record<string, { label: string; description: string }> = {
  application_strategy: { label: 'Application strategy',  description: 'I do not know how to position myself for this kind of role.' },
  role_selection:       { label: 'Role selection',        description: 'I am unsure which role(s) here actually fit me.' },
  interview_prep:       { label: 'Interview preparation', description: 'I have an interview lined up and need targeted prep.' },
  profile_review:       { label: 'Profile review',        description: 'Walk through my profile + portfolio and tell me what to improve.' },
  cv_review:            { label: 'CV review',             description: 'Review my CV and suggest specific changes for this application.' },
  portfolio_review:     { label: 'Portfolio review',      description: 'Review my work samples / portfolio for the application.' },
  general:              { label: 'General guidance',      description: 'Something else — I will explain in the situation field.' },
};
