// Mentor marketplace — one-to-one paid sessions with verified subject experts.
// Schema is self-bootstrapping. Bookings go through existing Razorpay flow.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
let ready: Promise<void> | null = null;

export function ensureMentorSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS mentors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(120) NOT NULL UNIQUE,
        user_id UUID,
        full_name VARCHAR(200) NOT NULL,
        title VARCHAR(300),
        bio TEXT,
        avatar_url TEXT,
        subjects JSONB DEFAULT '[]'::jsonb,
          -- array of subject slugs / labels
        languages JSONB DEFAULT '[]'::jsonb,
        years_experience INT,
        rate_chf_per_hour DECIMAL(10,2) NOT NULL DEFAULT 50.00,
        availability_summary TEXT,
        verified BOOLEAN NOT NULL DEFAULT false,
        verification_notes TEXT,
        rating_avg DECIMAL(3,2),
        rating_count INT NOT NULL DEFAULT 0,
        sessions_completed INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS m_active_idx ON mentors(is_active, verified)`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS mentor_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mentor_id UUID NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
        learner_user_id UUID NOT NULL,
        learner_name VARCHAR(200),
        learner_email VARCHAR(200),
        scheduled_at TIMESTAMPTZ,
        duration_minutes INT NOT NULL DEFAULT 60,
        topic TEXT,
        meet_link TEXT,
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        razorpay_order_id VARCHAR(120),
        razorpay_payment_id VARCHAR(120),
        amount_paise INT NOT NULL,
        currency VARCHAR(8) DEFAULT 'INR',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
          -- pending | scheduled | completed | cancelled | refunded
        learner_rating INT,
        learner_review TEXT,
        rated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ms_learner_idx ON mentor_sessions(learner_user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ms_mentor_idx ON mentor_sessions(mentor_id, scheduled_at)`);
    } catch (_) {}
  })();
  return ready;
}

export async function listMentors(opts: { subject?: string; language?: string } = {}) {
  await ensureMentorSchema();
  return rows(await db.execute(sql`
    SELECT * FROM mentors
    WHERE is_active = true AND verified = true
      ${opts.subject ? sql`AND subjects::jsonb ? ${opts.subject}` : sql``}
      ${opts.language ? sql`AND languages::jsonb ? ${opts.language}` : sql``}
    ORDER BY rating_avg DESC NULLS LAST, sessions_completed DESC LIMIT 100
  `));
}

export async function getMentor(slug: string) {
  await ensureMentorSchema();
  return rows(await db.execute(sql`SELECT * FROM mentors WHERE slug = ${slug} LIMIT 1`))[0] || null;
}

export async function createMentor(opts: any) {
  await ensureMentorSchema();
  const subjectsJson = JSON.stringify(opts.subjects || []);
  const languagesJson = JSON.stringify(opts.languages || []);
  const r = rows(await db.execute(sql`
    INSERT INTO mentors (slug, user_id, full_name, title, bio, avatar_url, subjects, languages,
      years_experience, rate_chf_per_hour, availability_summary, verified)
    VALUES (${opts.slug}, ${opts.userId || null}, ${opts.fullName}, ${opts.title || null}, ${opts.bio || null},
      ${opts.avatarUrl || null}, ${subjectsJson}::jsonb, ${languagesJson}::jsonb,
      ${opts.yearsExperience || null}, ${opts.rateChfPerHour || 50}, ${opts.availability || null}, ${!!opts.verified})
    RETURNING id, slug
  `));
  return { ok: true, id: r[0]?.id, slug: r[0]?.slug };
}

export async function bookSession(opts: { mentorId: string; learnerUserId: string; learnerName: string; learnerEmail: string; scheduledAt: string; duration: number; topic: string; amountPaise: number }) {
  await ensureMentorSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO mentor_sessions (mentor_id, learner_user_id, learner_name, learner_email, scheduled_at,
      duration_minutes, topic, amount_paise)
    VALUES (${opts.mentorId}, ${opts.learnerUserId}, ${opts.learnerName}, ${opts.learnerEmail},
      ${opts.scheduledAt}, ${opts.duration}, ${opts.topic}, ${opts.amountPaise})
    RETURNING id
  `));
  return { ok: true, id: r[0]?.id };
}
