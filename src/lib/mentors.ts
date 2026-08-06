// src/lib/mentors.ts — the mentor marketplace: profiles, and booking requests against them.
//
// WHAT WAS WRONG. This module had three writers — createMentor(), bookSession() and nothing else —
// and NOT ONE of them was called by any page in the repository. The only surface,
// /portal/mentors/index.astro, called listMentors() and rendered a grid. So:
//
//   * `mentors` had no INSERT anywhere, therefore the grid was structurally empty forever, and its
//     empty state said "no verified mentors match your filter" — which reads as "try a broader
//     filter", not "this feature has no way to add a mentor".
//   * every card linked to /portal/mentors/<slug>, a route that DID NOT EXIST. Had a mentor row ever
//     appeared, every click would have 404'd. That is the same defect as the reviewer surface a
//     notification pushed people to.
//   * `mentor_sessions` had no INSERT either, so nothing could be booked.
//   * rating_avg, rating_count and sessions_completed were sorted on and displayed, and no statement
//     anywhere in the repository ever wrote them.
//
// ensureMentorSchema() also ended in `catch (_) {}` INSIDE a hand-rolled `let ready` memo, which is
// the worst pairing: the DDL failure was swallowed unlogged, and the failed run was cached for the
// life of the process, so every later call got a silent success and every query then failed on a
// missing table with nobody able to say why.
//
// WHAT IT IS NOW. One writer per fact, each reachable from a surface a person can open:
//   createMentor()      <- /admin/mentors (admin creates and verifies a mentor)
//   setMentorVerified() <- /admin/mentors
//   setMentorActive()   <- /admin/mentors
//   bookSession()       <- /portal/mentors/[slug] (the learner's booking request)
//   setSessionStatus()  <- /admin/mentors (confirm / complete / cancel), and completing a session is
//                          the ONLY thing that increments sessions_completed
//   rateSession()       <- /portal/mentors/[slug] (the learner rates a completed session), and it
//                          recomputes rating_avg/rating_count from the ratings actually given
//
// PAYMENT IS NOT TAKEN HERE, and the booking screen says so in words. A booking is a REQUEST: it is
// recorded with payment_status 'pending' and status 'pending' until a human confirms it. The
// razorpay_* columns exist for when that flow is attached; writing a row that claims to be paid
// because a form was submitted would be exactly the kind of lie this file is being rewritten to
// remove.
//
// EVERY READ RETURNS A DISCRIMINATED RESULT. An empty mentor list that means "the query failed" is
// indistinguishable on screen from one that means "no mentors yet", and the two want completely
// different words on the page. Callers render { ok:false, reason } as "the marketplace could not be
// loaded", never as an empty grid.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real Postgres reason is on e.cause; e.message is only the statement that failed. */
function reasonOf(e: any): string { return String(e?.cause?.message || e?.message || 'unknown error'); }
function logFail(tag: string, e: any): string {
  const reason = reasonOf(e);
  console.error('[mentors] ' + tag, reason);
  return reason;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
export type WriteResult = { ok: true; id: string } | { ok: false; error: string };

export function ensureMentorSchema(): Promise<void> {
  return ensureOnce('mentors_v1', async () => {
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
        learner_rating INT,
        learner_review TEXT,
        rated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ms_learner_idx ON mentor_sessions(learner_user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ms_mentor_idx ON mentor_sessions(mentor_id, scheduled_at)`);
    } catch (e: any) {
      logFail('ensureMentorSchema', e);
      throw e; // ensureOnce drops the failed run so the next request retries
    }
  });
}

export interface Mentor {
  id: string;
  slug: string;
  userId: string | null;
  fullName: string;
  title: string | null;
  bio: string | null;
  subjects: string[];
  languages: string[];
  yearsExperience: number | null;
  rate: number;
  availability: string | null;
  verified: boolean;
  verificationNotes: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  sessionsCompleted: number;
  isActive: boolean;
}

function toMentor(r: any): Mentor {
  const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    id: String(r.id),
    slug: String(r.slug),
    userId: r.user_id ? String(r.user_id) : null,
    fullName: String(r.full_name || ''),
    title: r.title || null,
    bio: r.bio || null,
    subjects: arr(r.subjects),
    languages: arr(r.languages),
    yearsExperience: r.years_experience == null ? null : Number(r.years_experience),
    rate: Number(r.rate_chf_per_hour || 0),
    availability: r.availability_summary || null,
    verified: !!r.verified,
    verificationNotes: r.verification_notes || null,
    // Null until somebody has actually rated a session. Never coerced to 0, because "0.0 stars" and
    // "nobody has rated this mentor" are different claims and only one of them is true.
    ratingAvg: r.rating_avg == null ? null : Number(r.rating_avg),
    ratingCount: Number(r.rating_count || 0),
    sessionsCompleted: Number(r.sessions_completed || 0),
    isActive: !!r.is_active,
  };
}

export const SUBJECTS = [
  'mathematics', 'physics', 'chemistry', 'biology', 'computer-science', 'engineering',
  'medicine', 'law', 'management', 'liberal-arts', 'languages',
  'engineering-entrance', 'medical-entrance', 'civil-services',
];
export const LANGUAGES = ['en', 'hi', 'ta', 'te', 'bn', 'mr', 'kn', 'ml', 'gu', 'pa', 'or', 'sa'];

export function slugifyName(s: string): string {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110);
}

/**
 * Mentors a learner may book: active AND verified. `includeUnlisted` is for the admin console, which
 * must be able to see the ones it has just created but not yet verified — otherwise an admin creates
 * a mentor, it correctly does not appear on the public grid, and there is no screen anywhere that
 * shows it exists.
 */
export async function listMentors(
  opts: { subject?: string; language?: string; includeUnlisted?: boolean } = {},
): Promise<Result<Mentor[]>> {
  try {
    await ensureMentorSchema();
    const r = await db.execute(sql`
      SELECT * FROM mentors
      WHERE ${opts.includeUnlisted ? sql`TRUE` : sql`is_active = true AND verified = true`}
        ${opts.subject ? sql`AND subjects::jsonb ? ${opts.subject}` : sql``}
        ${opts.language ? sql`AND languages::jsonb ? ${opts.language}` : sql``}
      ORDER BY verified DESC, rating_avg DESC NULLS LAST, sessions_completed DESC, created_at DESC
      LIMIT 200
    `);
    return { ok: true, value: rows(r).map(toMentor) };
  } catch (e: any) {
    return { ok: false, reason: logFail('listMentors', e) };
  }
}

/** value is null when no such mentor exists — distinct from { ok:false }, which means the read failed. */
export async function getMentor(slug: string): Promise<Result<Mentor | null>> {
  if (!slug) return { ok: true, value: null };
  try {
    await ensureMentorSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mentors WHERE slug = ${slug} LIMIT 1`))[0];
    return { ok: true, value: r ? toMentor(r) : null };
  } catch (e: any) {
    return { ok: false, reason: logFail('getMentor', e) };
  }
}

export async function getMentorById(id: string): Promise<Result<Mentor | null>> {
  if (!id) return { ok: true, value: null };
  try {
    await ensureMentorSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mentors WHERE id = ${id}::uuid LIMIT 1`))[0];
    return { ok: true, value: r ? toMentor(r) : null };
  } catch (e: any) {
    return { ok: false, reason: logFail('getMentorById', e) };
  }
}

export interface CreateMentorInput {
  fullName: string;
  title?: string;
  bio?: string;
  subjects?: string[];
  languages?: string[];
  yearsExperience?: number | null;
  rate?: number;
  availability?: string;
  userId?: string | null;
  verified?: boolean;
  verificationNotes?: string;
}

/**
 * Create a mentor. Validation is here rather than in the page so a second surface cannot skip it.
 *
 * The slug is derived from the name and made unique by suffixing — a UNIQUE violation used to escape
 * as a raw Postgres string, which told the admin nothing and lost the form.
 */
export async function createMentor(input: CreateMentorInput): Promise<WriteResult & { slug?: string }> {
  const fullName = String(input.fullName || '').trim();
  if (fullName.length < 2) return { ok: false, error: 'Enter the mentor’s full name.' };
  if (fullName.length > 200) return { ok: false, error: 'That name is too long.' };
  const rate = Number(input.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100000) {
    return { ok: false, error: 'Enter an hourly rate between 0 and 100000.' };
  }
  const subjects = (input.subjects || []).filter((s) => SUBJECTS.includes(s));
  if (subjects.length === 0) {
    return { ok: false, error: 'Choose at least one subject. A mentor with no subject cannot be found by any filter on the marketplace.' };
  }
  const languages = (input.languages || []).filter((l) => LANGUAGES.includes(l));
  if (languages.length === 0) {
    return { ok: false, error: 'Choose at least one language.' };
  }
  const years = input.yearsExperience == null || input.yearsExperience === ('' as any)
    ? null : Math.max(0, Math.min(80, Math.floor(Number(input.yearsExperience) || 0)));

  try {
    await ensureMentorSchema();
    const base = slugifyName(fullName) || 'mentor';
    let slug = base;
    for (let attempt = 0; attempt < 20; attempt++) {
      const taken = rows(await db.execute(sql`SELECT 1 FROM mentors WHERE slug = ${slug} LIMIT 1`)).length > 0;
      if (!taken) break;
      slug = base.slice(0, 104) + '-' + (attempt + 2);
      if (attempt === 19) return { ok: false, error: 'Could not derive a free web address for that name. Try a slightly different spelling.' };
    }

    const r = rows(await db.execute(sql`
      INSERT INTO mentors (slug, user_id, full_name, title, bio, subjects, languages,
        years_experience, rate_chf_per_hour, availability_summary, verified, verification_notes)
      VALUES (${slug}, ${input.userId || null}, ${fullName.slice(0, 200)},
        ${(input.title || '').trim().slice(0, 300) || null},
        ${(input.bio || '').trim().slice(0, 4000) || null},
        ${JSON.stringify(subjects)}::jsonb, ${JSON.stringify(languages)}::jsonb,
        ${years}, ${rate}, ${(input.availability || '').trim().slice(0, 2000) || null},
        ${!!input.verified}, ${(input.verificationNotes || '').trim().slice(0, 2000) || null})
      RETURNING id, slug
    `));
    if (!r[0]?.id) return { ok: false, error: 'The mentor was not saved. Nothing has been created.' };
    return { ok: true, id: String(r[0].id), slug: String(r[0].slug) };
  } catch (e: any) {
    return { ok: false, error: logFail('createMentor', e) };
  }
}

/**
 * Verification is the gate that puts a mentor in front of learners, so it records WHY in writing.
 * A verified mentor with no note is a claim nobody can audit later.
 */
export async function setMentorVerified(id: string, verified: boolean, notes: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = String(notes || '').trim();
  if (verified && note.length < 10) {
    return { ok: false, error: 'Say how this mentor was verified, in at least 10 characters. "Verified" with no record of what was checked is not a verification.' };
  }
  try {
    await ensureMentorSchema();
    await db.execute(sql`
      UPDATE mentors SET verified = ${verified}, verification_notes = ${note.slice(0, 2000) || null}, updated_at = NOW()
      WHERE id = ${id}::uuid`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: logFail('setMentorVerified', e) };
  }
}

export async function setMentorActive(id: string, active: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensureMentorSchema();
    await db.execute(sql`UPDATE mentors SET is_active = ${active}, updated_at = NOW() WHERE id = ${id}::uuid`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: logFail('setMentorActive', e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------------------------

export type SessionStatus = 'pending' | 'scheduled' | 'completed' | 'cancelled' | 'refunded';

export interface MentorSession {
  id: string;
  mentorId: string;
  mentorName: string | null;
  mentorSlug: string | null;
  learnerUserId: string;
  learnerName: string | null;
  learnerEmail: string | null;
  scheduledAt: string | null;
  durationMinutes: number;
  topic: string | null;
  meetLink: string | null;
  status: SessionStatus;
  paymentStatus: string;
  amountMinor: number;
  currency: string;
  learnerRating: number | null;
  learnerReview: string | null;
  createdAt: string;
}

function toSession(r: any): MentorSession {
  return {
    id: String(r.id),
    mentorId: String(r.mentor_id),
    mentorName: r.mentor_name || null,
    mentorSlug: r.mentor_slug || null,
    learnerUserId: String(r.learner_user_id),
    learnerName: r.learner_name || null,
    learnerEmail: r.learner_email || null,
    scheduledAt: r.scheduled_at ? String(r.scheduled_at) : null,
    durationMinutes: Number(r.duration_minutes || 60),
    topic: r.topic || null,
    meetLink: r.meet_link || null,
    status: String(r.status || 'pending') as SessionStatus,
    paymentStatus: String(r.payment_status || 'pending'),
    amountMinor: Number(r.amount_paise || 0),
    currency: String(r.currency || 'CHF'),
    learnerRating: r.learner_rating == null ? null : Number(r.learner_rating),
    learnerReview: r.learner_review || null,
    createdAt: String(r.created_at),
  };
}

export const DURATIONS = [30, 45, 60, 90];

/**
 * Record a booking REQUEST. Nothing is charged: payment_status stays 'pending' and status stays
 * 'pending' until a human confirms. The amount is stored in MINOR UNITS of the mentor's own rate
 * currency (the column is historically named amount_paise; `currency` says what it actually is) so
 * that the sum on the record matches the rate the learner was shown, rather than being converted
 * behind their back.
 */
export async function bookSession(opts: {
  mentorId: string;
  learnerUserId: string;
  learnerName: string;
  learnerEmail?: string | null;
  scheduledAt: string;
  durationMinutes: number;
  topic: string;
}): Promise<WriteResult> {
  const topic = String(opts.topic || '').trim();
  if (topic.length < 10) {
    return { ok: false, error: 'Say what you want to work on, in at least 10 characters. The mentor decides whether to accept from this.' };
  }
  const duration = Number(opts.durationMinutes);
  if (!DURATIONS.includes(duration)) return { ok: false, error: 'Choose one of the offered session lengths.' };

  const when = new Date(String(opts.scheduledAt || ''));
  if (!opts.scheduledAt || Number.isNaN(when.getTime())) {
    return { ok: false, error: 'Choose a date and time for the session.' };
  }
  if (when.getTime() < Date.now() + 60 * 60 * 1000) {
    return { ok: false, error: 'Choose a time at least an hour from now, so the mentor has a chance to respond.' };
  }

  try {
    await ensureMentorSchema();
    const mentor = rows(await db.execute(sql`
      SELECT id, rate_chf_per_hour, is_active, verified FROM mentors WHERE id = ${opts.mentorId}::uuid LIMIT 1`))[0];
    if (!mentor) return { ok: false, error: 'That mentor no longer exists.' };
    if (!mentor.is_active || !mentor.verified) {
      return { ok: false, error: 'That mentor is not currently taking bookings.' };
    }

    // Guard against a double-submit creating two identical requests (the Release-paid-twice defect).
    const dupe = rows(await db.execute(sql`
      SELECT id FROM mentor_sessions
      WHERE mentor_id = ${opts.mentorId}::uuid AND learner_user_id = ${opts.learnerUserId}
        AND scheduled_at = ${when.toISOString()} AND status IN ('pending', 'scheduled')
      LIMIT 1`));
    if (dupe[0]) return { ok: false, error: 'You have already requested that slot with this mentor. It is waiting for their reply.' };

    const rate = Number(mentor.rate_chf_per_hour || 0);
    const amountMinor = Math.round(rate * (duration / 60) * 100);

    const r = rows(await db.execute(sql`
      INSERT INTO mentor_sessions (mentor_id, learner_user_id, learner_name, learner_email,
        scheduled_at, duration_minutes, topic, amount_paise, currency, status, payment_status)
      VALUES (${opts.mentorId}::uuid, ${opts.learnerUserId},
        ${String(opts.learnerName || '').slice(0, 200) || null}, ${opts.learnerEmail || null},
        ${when.toISOString()}, ${duration}, ${topic.slice(0, 2000)}, ${amountMinor}, 'CHF',
        'pending', 'pending')
      RETURNING id`));
    if (!r[0]?.id) return { ok: false, error: 'The booking request was not saved. Nothing has been recorded.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('bookSession', e) };
  }
}

export async function sessionsForLearner(learnerUserId: string): Promise<Result<MentorSession[]>> {
  if (!learnerUserId) return { ok: true, value: [] };
  try {
    await ensureMentorSchema();
    const r = await db.execute(sql`
      SELECT s.*, m.full_name AS mentor_name, m.slug AS mentor_slug
      FROM mentor_sessions s LEFT JOIN mentors m ON m.id = s.mentor_id
      WHERE s.learner_user_id = ${learnerUserId}
      ORDER BY s.scheduled_at DESC NULLS LAST LIMIT 100`);
    return { ok: true, value: rows(r).map(toSession) };
  } catch (e: any) {
    return { ok: false, reason: logFail('sessionsForLearner', e) };
  }
}

export async function sessionsForMentor(mentorId: string): Promise<Result<MentorSession[]>> {
  if (!mentorId) return { ok: true, value: [] };
  try {
    await ensureMentorSchema();
    const r = await db.execute(sql`
      SELECT s.*, m.full_name AS mentor_name, m.slug AS mentor_slug
      FROM mentor_sessions s LEFT JOIN mentors m ON m.id = s.mentor_id
      WHERE s.mentor_id = ${mentorId}::uuid
      ORDER BY s.scheduled_at DESC NULLS LAST LIMIT 200`);
    return { ok: true, value: rows(r).map(toSession) };
  } catch (e: any) {
    return { ok: false, reason: logFail('sessionsForMentor', e) };
  }
}

/** Every booking request awaiting a human decision, for the admin console. */
export async function pendingSessions(limit = 100): Promise<Result<MentorSession[]>> {
  try {
    await ensureMentorSchema();
    const r = await db.execute(sql`
      SELECT s.*, m.full_name AS mentor_name, m.slug AS mentor_slug
      FROM mentor_sessions s LEFT JOIN mentors m ON m.id = s.mentor_id
      ORDER BY (s.status = 'pending') DESC, s.scheduled_at DESC NULLS LAST
      LIMIT ${Math.min(500, Math.max(1, limit))}`);
    return { ok: true, value: rows(r).map(toSession) };
  } catch (e: any) {
    return { ok: false, reason: logFail('pendingSessions', e) };
  }
}

/**
 * Move a session through its lifecycle.
 *
 * Completing is the ONLY thing that increments mentors.sessions_completed — the counter shown on
 * every mentor card. It is incremented exactly once per session by guarding the UPDATE on the row
 * not already being 'completed', so a double-click on Complete cannot inflate it (this project has
 * already paid a withdrawal twice from exactly that shape).
 */
export async function setSessionStatus(
  sessionId: string,
  status: SessionStatus,
  opts: { meetLink?: string } = {},
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const allowed: SessionStatus[] = ['pending', 'scheduled', 'completed', 'cancelled', 'refunded'];
  if (!allowed.includes(status)) return { ok: false, error: 'Unknown session status.' };
  const link = String(opts.meetLink || '').trim();
  if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: 'A meeting link must start with http:// or https://.' };
  if (status === 'scheduled' && !link) {
    return { ok: false, error: 'Add the meeting link before confirming, so the learner is not told a session is confirmed with no way to join it.' };
  }
  try {
    await ensureMentorSchema();
    const changed = rows(await db.execute(sql`
      UPDATE mentor_sessions
      SET status = ${status},
          meet_link = COALESCE(${link || null}, meet_link),
          updated_at = NOW()
      WHERE id = ${sessionId}::uuid AND status <> ${status}
      RETURNING id, mentor_id`));
    if (changed.length === 0) return { ok: true, changed: false };
    if (status === 'completed') {
      await db.execute(sql`
        UPDATE mentors SET sessions_completed = sessions_completed + 1, updated_at = NOW()
        WHERE id = ${changed[0].mentor_id}`);
    }
    return { ok: true, changed: true };
  } catch (e: any) {
    return { ok: false, error: logFail('setSessionStatus', e) };
  }
}

/**
 * The learner rates a session they actually had. rating_avg / rating_count on the mentor are then
 * RECOMPUTED from the ratings on record rather than incremented, so they can never drift away from
 * the rows that justify them.
 */
export async function rateSession(
  sessionId: string,
  learnerUserId: string,
  rating: number,
  review: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stars = Math.floor(Number(rating));
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) return { ok: false, error: 'Give a rating between 1 and 5.' };
  try {
    await ensureMentorSchema();
    const updated = rows(await db.execute(sql`
      UPDATE mentor_sessions
      SET learner_rating = ${stars}, learner_review = ${String(review || '').trim().slice(0, 2000) || null},
          rated_at = NOW(), updated_at = NOW()
      WHERE id = ${sessionId}::uuid AND learner_user_id = ${learnerUserId} AND status = 'completed'
      RETURNING mentor_id`));
    if (updated.length === 0) {
      return { ok: false, error: 'Only a session of yours that has been marked completed can be rated.' };
    }
    const mentorId = updated[0].mentor_id;
    await db.execute(sql`
      UPDATE mentors m SET
        rating_avg = agg.avg_rating,
        rating_count = agg.n,
        updated_at = NOW()
      FROM (
        SELECT AVG(learner_rating)::numeric(3,2) AS avg_rating, COUNT(*)::int AS n
        FROM mentor_sessions WHERE mentor_id = ${mentorId} AND learner_rating IS NOT NULL
      ) agg
      WHERE m.id = ${mentorId}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: logFail('rateSession', e) };
  }
}
