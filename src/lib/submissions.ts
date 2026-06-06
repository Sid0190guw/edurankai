// Universal applicant + CA submission system.
// Applicants submit full-fledged original work (work samples, assignment
// responses, portfolio pieces) and Campus Ambassadors submit their period
// reports. All through one schema. Self-bootstrapping.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureSubmissionsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS portal_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submitter_user_id UUID,
        submitter_name VARCHAR(200) NOT NULL,
        submitter_email VARCHAR(200),
        submitter_role VARCHAR(40) NOT NULL DEFAULT 'applicant',
          -- applicant | campus_ambassador | intern | employee
        kind VARCHAR(40) NOT NULL,
          -- work_sample | assignment | portfolio | ca_report | research_paper | project_doc | video_demo | other
        target_role_id UUID,
        target_role_slug VARCHAR(120),
        target_assignment_id UUID,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        drive_url TEXT,
        external_url TEXT,
          -- e.g. Unstop submission url, Github repo, Figma, Behance
        attachment_urls JSONB DEFAULT '[]'::jsonb,
          -- Array of {name, url, size_bytes, mime} from Vercel Blob
        platform VARCHAR(40) DEFAULT 'direct',
          -- direct | drive | unstop | github | other
        word_count INT,
        page_count INT,
        reviewer_user_id UUID,
        status VARCHAR(20) NOT NULL DEFAULT 'submitted',
          -- draft | submitted | under_review | approved | revisions_requested | rejected
        score_pct DECIMAL(5,2),
        review_notes TEXT,
        reviewed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS psub_submitter_idx ON portal_submissions(submitter_user_id, kind, submitted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS psub_status_idx ON portal_submissions(status, submitted_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS psub_kind_idx ON portal_submissions(kind, status)`);

      // Per-submission review history (multiple reviewers can leave notes)
      await db.execute(sql`CREATE TABLE IF NOT EXISTS portal_submission_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id UUID NOT NULL REFERENCES portal_submissions(id) ON DELETE CASCADE,
        reviewer_user_id UUID,
        reviewer_name VARCHAR(200),
        verdict VARCHAR(20) NOT NULL,
          -- approve | request_revisions | reject | comment
        score_pct DECIMAL(5,2),
        notes TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS psr_sub_idx ON portal_submission_reviews(submission_id, created_at DESC)`);
    } catch (_) {}
  })();
  return ready;
}

export interface CreateSubmissionOpts {
  submitterUserId?: string;
  submitterName: string;
  submitterEmail?: string;
  submitterRole?: 'applicant' | 'campus_ambassador' | 'intern' | 'employee';
  kind: string;
  targetRoleSlug?: string;
  targetAssignmentId?: string;
  title: string;
  description?: string;
  driveUrl?: string;
  externalUrl?: string;
  attachmentUrls?: { name: string; url: string; size_bytes?: number; mime?: string }[];
  platform?: 'direct' | 'drive' | 'unstop' | 'github' | 'other';
  wordCount?: number;
  pageCount?: number;
  metadata?: Record<string, any>;
}

export async function createSubmission(opts: CreateSubmissionOpts) {
  await ensureSubmissionsSchema();
  const attachJson = JSON.stringify(opts.attachmentUrls || []);
  const metaJson = JSON.stringify(opts.metadata || {});
  const r = rows(await db.execute(sql`
    INSERT INTO portal_submissions (
      submitter_user_id, submitter_name, submitter_email, submitter_role,
      kind, target_role_slug, target_assignment_id,
      title, description, drive_url, external_url, attachment_urls,
      platform, word_count, page_count, metadata
    ) VALUES (
      ${opts.submitterUserId || null}, ${opts.submitterName.slice(0, 200)},
      ${opts.submitterEmail || null}, ${opts.submitterRole || 'applicant'},
      ${opts.kind}, ${opts.targetRoleSlug || null}, ${opts.targetAssignmentId || null},
      ${opts.title.slice(0, 300)}, ${opts.description || null},
      ${opts.driveUrl || null}, ${opts.externalUrl || null}, ${attachJson}::jsonb,
      ${opts.platform || 'direct'}, ${opts.wordCount || null}, ${opts.pageCount || null}, ${metaJson}::jsonb
    ) RETURNING id, submitted_at
  `));
  return { ok: true, id: r[0]?.id, submittedAt: r[0]?.submitted_at };
}

export async function listSubmissions(opts: { submitterUserId?: string; kind?: string; status?: string; limit?: number; q?: string } = {}) {
  await ensureSubmissionsSchema();
  const limit = Math.min(500, Math.max(10, opts.limit || 100));
  const q = (opts.q || '').trim();
  const like = '%' + q + '%';
  return rows(await db.execute(sql`
    SELECT * FROM portal_submissions
    WHERE 1=1
      ${opts.submitterUserId ? sql`AND submitter_user_id = ${opts.submitterUserId}` : sql``}
      ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
      ${opts.status ? sql`AND status = ${opts.status}` : sql``}
      ${q ? sql`AND (title ILIKE ${like} OR submitter_name ILIKE ${like} OR submitter_email ILIKE ${like})` : sql``}
    ORDER BY submitted_at DESC LIMIT ${limit}
  `));
}

export async function getSubmission(id: string) {
  await ensureSubmissionsSchema();
  return rows(await db.execute(sql`SELECT * FROM portal_submissions WHERE id = ${id} LIMIT 1`))[0] || null;
}

export async function listSubmissionReviews(submissionId: string) {
  await ensureSubmissionsSchema();
  return rows(await db.execute(sql`
    SELECT * FROM portal_submission_reviews WHERE submission_id = ${submissionId} ORDER BY created_at DESC
  `));
}

export async function reviewSubmission(opts: {
  submissionId: string;
  reviewerUserId: string;
  reviewerName: string;
  verdict: 'approve' | 'request_revisions' | 'reject' | 'comment';
  scorePct?: number;
  notes: string;
}) {
  await ensureSubmissionsSchema();
  await db.execute(sql`
    INSERT INTO portal_submission_reviews (submission_id, reviewer_user_id, reviewer_name, verdict, score_pct, notes)
    VALUES (${opts.submissionId}, ${opts.reviewerUserId}, ${opts.reviewerName}, ${opts.verdict},
      ${opts.scorePct ?? null}, ${opts.notes.slice(0, 5000)})
  `);
  const newStatus = opts.verdict === 'approve' ? 'approved'
    : opts.verdict === 'reject' ? 'rejected'
    : opts.verdict === 'request_revisions' ? 'revisions_requested'
    : 'under_review';
  await db.execute(sql`
    UPDATE portal_submissions SET status = ${newStatus},
      reviewer_user_id = ${opts.reviewerUserId}, reviewed_at = NOW(),
      ${opts.scorePct != null ? sql`score_pct = ${opts.scorePct},` : sql``}
      review_notes = ${opts.notes.slice(0, 5000)},
      updated_at = NOW()
    WHERE id = ${opts.submissionId}
  `);
}

export const SUBMISSION_KIND_LABELS: Record<string, { label: string; description: string; accent: string }> = {
  work_sample:    { label: 'Work sample',          description: 'Original work demonstrating your skill', accent: '#86efac' },
  assignment:     { label: 'Assignment response',  description: 'Response to a specific posted assignment', accent: '#67e8f9' },
  portfolio:      { label: 'Portfolio piece',      description: 'A standout project from your portfolio', accent: '#c4b5fd' },
  ca_report:      { label: 'CA report',            description: 'Campus Ambassador periodic report', accent: '#FF7040' },
  research_paper: { label: 'Research paper',       description: 'White paper, research write-up, or academic submission', accent: '#fbbf24' },
  project_doc:    { label: 'Project document',     description: 'Project pitch deck, PRD, or technical doc', accent: '#a0a0ab' },
  video_demo:     { label: 'Video / demo',         description: 'Recorded walkthrough or screencast (drive/YT link)', accent: '#fca5a5' },
  other:          { label: 'Other',                description: 'Anything else worth our review', accent: '#9aa6b6' },
};
