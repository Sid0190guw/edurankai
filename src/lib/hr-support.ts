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
      // Candidate-picked slot — locked into the row at submission time, then
      // committed to the calendar once payment lands.
      await db.execute(sql`ALTER TABLE hr_application_support ADD COLUMN IF NOT EXISTS requested_slot_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE hr_application_support ADD COLUMN IF NOT EXISTS requested_slot_label VARCHAR(60)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hras_status_idx ON hr_application_support(payment_status, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hras_email_idx ON hr_application_support(candidate_email)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hras_slot_idx ON hr_application_support(requested_slot_at) WHERE requested_slot_at IS NOT NULL`);

      // Threaded messages — admin replies + candidate responses, all in one
      // stream visible to both sides.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS hr_support_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL REFERENCES hr_application_support(id) ON DELETE CASCADE,
        sender_role VARCHAR(16) NOT NULL,
          -- admin | candidate | system
        sender_user_id UUID,
        sender_name VARCHAR(200),
        body TEXT NOT NULL,
        meta JSONB,
          -- e.g. { template: 'confirm_meet', meet_link: 'https://...' }
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS hrsm_req_idx ON hr_support_messages(request_id, created_at ASC)`);
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

// Auto-response templates. Admin clicks one in the dashboard and the
// {{placeholders}} get filled with the request row before sending. The
// rendered text lands in hr_support_messages and is visible to the candidate
// in their portal thread.
export const REPLY_TEMPLATES: Record<string, { label: string; tone: string; body: string; statusUpdate?: string }> = {
  confirm_meet: {
    label: 'Confirm meeting',
    tone: 'leaf',
    body: 'Hi {{name}}, your slot of {{slot}} is confirmed. Please join the Google Meet here: {{meet_link}}\n\nPlease have your CV / portfolio open during the call. The call is 30–45 minutes — we will use the first 5 to align on what to cover.',
    statusUpdate: 'scheduled',
  },
  reschedule_request: {
    label: 'Reschedule request',
    tone: 'gold',
    body: 'Hi {{name}}, the slot of {{slot}} is no longer available on our side. Please pick a new slot from this link and we will confirm: https://edurankai.in/careers/hr-support?req={{id}}',
    statusUpdate: 'reschedule_pending',
  },
  cancelled_refund: {
    label: 'Cancelled + refunded',
    tone: 'burn',
    body: 'Hi {{name}}, this session has been cancelled and a full refund of 25 CHF has been initiated. The refund typically reflects in 5–7 business days. We are sorry we could not make this work.',
    statusUpdate: 'cancelled',
  },
  no_show: {
    label: 'No-show recorded',
    tone: 'plum',
    body: 'Hi {{name}}, we waited at the scheduled slot but the call did not connect. As per policy, no-shows are not refunded but you may re-book at any time at the standard 25 CHF fee.',
    statusUpdate: 'no_show',
  },
  completed: {
    label: 'Mark completed',
    tone: 'leaf',
    body: 'Hi {{name}}, thanks for the call. A summary of what we covered and the next steps are attached. If you have follow-up questions, reply to this thread within 7 days at no extra cost.',
    statusUpdate: 'completed',
  },
  general_reply: {
    label: 'General reply (blank)',
    tone: 'sky',
    body: '',
  },
};

export function renderTemplate(body: string, vars: { name?: string; slot?: string; meet_link?: string; id?: string }): string {
  return body
    .replace(/{{name}}/g, vars.name || 'there')
    .replace(/{{slot}}/g, vars.slot || 'your scheduled time')
    .replace(/{{meet_link}}/g, vars.meet_link || '[meet link]')
    .replace(/{{id}}/g, vars.id || '');
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
