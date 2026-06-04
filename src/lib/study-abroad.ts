// Study Abroad support — admin + applicant + consultant.
//
// Domain model:
//   - An applicant submits a Study Abroad Request describing what they want
//     help with (country, programme, intake, budget, current stage, notes).
//   - An admin assigns the request to a Consultant from the consultant pool.
//   - The Consultant + applicant communicate inside a thread (reuses the
//     request_messages thread system, request_type='study_abroad').
//   - The request moves through statuses: pending → assigned → in_progress →
//     completed | cancelled.
//
// All schema is self-bootstrapping — no separate migration file required.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureStudyAbroadSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // Consultants — staff members the admin can assign requests to.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS study_abroad_consultants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name VARCHAR(200) NOT NULL,
        bio TEXT,
        countries TEXT[] NOT NULL DEFAULT '{}',
        specialisations TEXT[] NOT NULL DEFAULT '{}',
        languages TEXT[] NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT true,
        active_case_cap INT NOT NULL DEFAULT 25,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id)
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sa_consultants_active_idx ON study_abroad_consultants(is_active)`);

      // Requests — what an applicant wants help with.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS study_abroad_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        applicant_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        consultant_id UUID REFERENCES study_abroad_consultants(id) ON DELETE SET NULL,
        countries TEXT[] NOT NULL DEFAULT '{}',
        programme_level VARCHAR(40),
        intake_term VARCHAR(40),
        intake_year INT,
        budget_band VARCHAR(40),
        current_stage VARCHAR(60),
        notes TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        last_message_at TIMESTAMPTZ,
        last_message_by VARCHAR(12),
        unread_applicant INT NOT NULL DEFAULT 0,
        unread_consultant INT NOT NULL DEFAULT 0,
        unread_admin INT NOT NULL DEFAULT 0,
        assigned_at TIMESTAMPTZ,
        assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sa_req_applicant_idx ON study_abroad_requests(applicant_user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sa_req_consultant_idx ON study_abroad_requests(consultant_id, status)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS sa_req_status_idx ON study_abroad_requests(status, created_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

export const PROGRAMME_LEVELS = [
  'Undergraduate (Bachelor)',
  'Postgraduate (Masters)',
  'PhD / Doctoral',
  'Diploma / Certificate',
  'Pathway / Foundation',
  'Exchange / Semester',
  'MBA',
] as const;

export const INTAKE_TERMS = ['Spring', 'Summer', 'Autumn / Fall', 'Winter', 'Rolling'] as const;

export const BUDGET_BANDS = [
  'Below USD 10k / year',
  'USD 10–20k / year',
  'USD 20–35k / year',
  'USD 35–55k / year',
  'USD 55k+ / year',
  'Fully-funded / scholarship-only',
] as const;

export const CURRENT_STAGES = [
  'Just exploring',
  'Researching programmes',
  'Have a shortlist',
  'Preparing applications',
  'Applications submitted',
  'Have offer(s)',
  'Need visa / departure support',
] as const;

export const STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'] as const;
export type StudyAbroadStatus = typeof STATUSES[number];

export async function listConsultants(opts: { activeOnly?: boolean } = {}) {
  await ensureStudyAbroadSchema();
  if (opts.activeOnly) {
    return rows(await db.execute(sql`
      SELECT c.id, c.user_id, c.display_name, c.bio, c.countries, c.specialisations, c.languages, c.is_active, c.active_case_cap,
        (SELECT COUNT(*)::int FROM study_abroad_requests r WHERE r.consultant_id = c.id AND r.status IN ('assigned','in_progress')) AS active_cases
      FROM study_abroad_consultants c WHERE c.is_active = true ORDER BY c.display_name
    `));
  }
  return rows(await db.execute(sql`
    SELECT c.id, c.user_id, c.display_name, c.bio, c.countries, c.specialisations, c.languages, c.is_active, c.active_case_cap,
      (SELECT COUNT(*)::int FROM study_abroad_requests r WHERE r.consultant_id = c.id AND r.status IN ('assigned','in_progress')) AS active_cases
    FROM study_abroad_consultants c ORDER BY c.is_active DESC, c.display_name
  `));
}

export async function getRequestById(id: string) {
  await ensureStudyAbroadSchema();
  return rows(await db.execute(sql`
    SELECT r.*, u.email AS applicant_email, u.name AS applicant_name,
      c.display_name AS consultant_name, c.user_id AS consultant_user_id
    FROM study_abroad_requests r
    JOIN users u ON u.id = r.applicant_user_id
    LEFT JOIN study_abroad_consultants c ON c.id = r.consultant_id
    WHERE r.id = ${id} LIMIT 1
  `))[0] || null;
}

export async function listApplicantRequests(userId: string) {
  await ensureStudyAbroadSchema();
  return rows(await db.execute(sql`
    SELECT r.id, r.status, r.countries, r.programme_level, r.created_at,
      COALESCE(r.last_message_at, r.created_at) AS last_message_at,
      COALESCE(r.unread_applicant, 0) AS unread,
      c.display_name AS consultant_name
    FROM study_abroad_requests r
    LEFT JOIN study_abroad_consultants c ON c.id = r.consultant_id
    WHERE r.applicant_user_id = ${userId}
    ORDER BY COALESCE(r.last_message_at, r.created_at) DESC
  `));
}
