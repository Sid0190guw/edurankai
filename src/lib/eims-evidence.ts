// src/lib/eims-evidence.ts — THE EVIDENCE GRAPH, AND THE ONLY PLACE A VERIFIED HOUR IS WRITTEN.
//
// =================================================================================================
// WHAT THIS FILE IS FOR, AND WHAT IT REPLACES
// =================================================================================================
//
// This is what stands in place of surveillance. There is no webcam here, no screenshot, no keystroke
// log, and deliberately no seam where one could be switched on later: nothing in this module stores
// an image, a sample of a screen, or a signal collected from a person's machine. It stores LINKS TO
// WORK, and a named human's verdict on them.
//
// The chain the founder's spec draws is a chain of ROWS, in this order:
//
//     intern  ->  activity  ->  work  ->  evidence  ->  mentor review  ->  outcome
//     ------      --------      ----      --------      -------------      -------
//     employee_id  activity_kind + activity_id, on eims_evidence_links
//                                eims_evidence (a link or an external reference)
//                                              eims_evidence_reviews (append-only)
//                                                                 the verified hours + the outcome
//                                                                 sentence recorded WITH the verdict
//
// THE QUESTION THIS EXISTS TO ANSWER IS "WHY WERE THESE HOURS RECOGNISED", AND THE ANSWER IS A ROW.
// evidenceChain() walks that path and returns it. An hour nobody can trace back to a link somebody
// named, reviewed and signed is an opinion, and an opinion must never print on a record a student
// shows a university.
//
// =================================================================================================
// THE ONE RULE THAT MAKES THE WHOLE THING HOLD: ONE HOUR OF RECORD, ONE WRITER
// =================================================================================================
//
// THE HOUR OF RECORD FOR AN ACTIVITY IS `employee_tasks.verified_hours`, AND ONLY verifyActivity()
// IN src/lib/eims-activity.ts WRITES IT. This module does not write that column and must never
// learn how.
//
// `eims_evidence_links.hours_verified` is the per-evidence SHARE of that figure: how much of an
// activity's verified total this particular link accounted for. It exists because "why were these
// hours recognised" has to be able to name the evidence, and an activity-level total cannot. It is
// written by exactly one function, recordVerdict(), and by nothing else — not a page, not an
// importer, not the intern.
//
// THE TWO ARE HELD IN AGREEMENT IN ONE DIRECTION ONLY, AND THAT DIRECTION IS ENFORCED HERE. When a
// mentor accepts evidence, recordVerdict() writes the evidence side and then calls verifyActivity()
// with the activity's new verified total, so the verdict LANDS ON THE ACTIVITY LEDGER. Where the
// activity ledger refuses that write — no allocation recorded, nothing reported against it yet,
// already verified — its refusal comes back to the mentor verbatim as an advisory on their own
// screen. It is never swallowed and never retried behind their back, because the failure this is
// guarding against is precisely a mentor believing they verified hours that no ledger took.
//
// WHERE A LINK NAMES NO ACTIVITY ROW, the evidence side is the only record there is, and
// verifiedHoursForWeek() says so in its own words rather than presenting it as recognised. An
// unattached hour is a real hour that no ledger has taken, and saying that plainly is the point.
//
// THREE STATES, KEPT APART ON PURPOSE, and only the third is authoritative:
//   ALLOCATED  the plan. Owned by the activity, not by evidence. Read here, never written here.
//   CLAIMED    what the intern reports they did — `hours_claimed` on the link. RECORDED HONESTLY,
//              including when it exceeds the allocation and including when it takes the week above
//              the ceiling. Recording an over-run is how the over-run stays visible; recognising it
//              is what "no hour inflation" forbids.
//   VERIFIED   what a named mentor accepted against named evidence. `hours_verified`. Never greater
//              than what was claimed on that link, and only ever written by an accept.
//
// AND THE CEILING IS A CEILING. verifiedHoursForWeek() returns the verified sum AND the RECOGNISED
// figure, which is the verified sum capped at the weekly ceiling. 40 hours a week is the most that
// can be recognised, holistic fitness included, never 40 plus something. The excess is returned as
// its own number so a screen can say "recorded, not recognised" rather than silently losing it.
//
// =================================================================================================
// EVIDENCE IS A LINK. IT IS NEVER AN UPLOAD.
// =================================================================================================
//
// A Drive link, a git commit or pull request, an LMS record, a notebook, a design file, a published
// output. The file stays in the intern's own account and is shared by link. This module stores a URL
// and nothing else, and there is no upload path to add to.
//
// checkEvidenceLink() DELEGATES the Drive case to checkDriveLink() in src/lib/daily-report.ts rather
// than restating it. That function already refuses every host but drive.google.com and
// docs.google.com, repairs a missing scheme, refuses http://, and warns about /u/0/ links. A second
// copy of that rule is how a form starts accepting what the write path then refuses, so there is
// only one copy and this file calls it.
//
// WHERE A DRIVE LINK IS ASKED FOR, THE FIELD MUST SAY IT HAS TO BE SHARED AS "ANYONE WITH THE LINK".
// The person pasting it is signed in to their own account, so the link always opens for THEM. They
// cannot detect the failure themselves; only being told can prevent it. SHARING_REQUIREMENT is that
// sentence, and every surface in this phase prints it beside the field.
//
// =================================================================================================
// WHO MAY VERIFY: THE ORGANIZATION GRAPH, PER ROW, NEVER users.role
// =================================================================================================
//
// mayVerify() resolves the question one intern at a time, from src/lib/org-graph.ts: the recorded
// mentor edge first, then the reporting manager, then a recorded reviewer edge. A job title admits
// nobody. There is no capability that overrides this and there is deliberately no HR override on the
// WRITE — HR runs the desk, but "I verify that these four hours happened" is a statement only
// somebody who watched the work can truthfully make. Nobody verifies their own evidence, ever.
//
// =================================================================================================
// AI IS ADVISORY. IT NEVER DECIDES AND IT NEVER ACCUSES.
// =================================================================================================
//
// advisoryNotes() is PURE, returns sentences, and is wired to nothing that writes. Every sentence it
// can produce is of the form "potential discrepancy, mentor review required". It cannot mark a
// person, cannot reduce an hour, cannot set a status, and there is no vocabulary in it for calling
// somebody dishonest. A human reads it and a human decides.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rows(). Never r.rows[0].
//   - The real Postgres reason is on e.cause. logFail() prints e?.cause?.message || e?.message.
//   - NO WRITE PATH SWALLOWS AN EXCEPTION. Every one logs the real reason and returns a sentence a
//     person can read. A verdict that silently did nothing is worse than one that failed loudly.
//   - Every const is declared ABOVE the function that reads it. const is not hoisted.
//   - Self-bootstrapping DDL, additive only, inside ONE ensureOnce guard on a NEW key.
//   - hr_employees.full_name. Employee ids compared as ::text, never cast blindly to uuid.
//
// EduRankAI is the technology platform. A verified hour recorded here is a record of work done on
// this platform; accredited partners award credentials. Nothing in this file confers a qualification.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { checkDriveLink, SHARING_WARNING, type DriveLinkCheck } from '@/lib/daily-report';
import { CLOSED_STATUSES, canonicalStatus } from '@/lib/employee-tasks';
// The activity ledger owns the hour of record. This module calls INTO it and never around it.
// src/lib/eims-activity.ts does not import this file, so the dependency runs one way only.
import { verifyActivity, getActivity } from '@/lib/eims-activity';
import { requiredWeeklyHours, weekStartOf, weekEndOf, isoDate, type RequiredHours } from '@/lib/credit-week';
import {
  getManager, getMentor, getMentees, getDirectReports, getReviewSubjects,
  employeeIdForUser, isInitialized as orgIsInitialized,
  type OrgPerson,
} from '@/lib/org-graph';

// =================================================================================================
// CONSTANTS AND HELPERS — all declared before every function that reads them.
// =================================================================================================

/** postgres-js resolves to a plain array, never a { rows } object. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-evidence] ' + tag, e?.cause?.message || e?.message);

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED = 'Something went wrong recording that. Nothing was changed. Try again in a moment.';

const isUuid = (v: unknown): boolean =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

const stamp = (d: any): string | null => {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
};

const text = (v: unknown, max: number): string => String(v == null ? '' : v).trim().slice(0, max);

/**
 * THE SENTENCE EVERY DRIVE FIELD MUST CARRY. Exported so no screen writes its own version, and
 * phrased as an instruction rather than a warning because the submitter cannot see the failure:
 * their own link always opens for them.
 */
export const SHARING_REQUIREMENT =
  'Share it as "Anyone with the link" before you paste it. A link that is not shared that way opens '
  + 'for you and for nobody else, and your mentor will see a permission screen instead of your work.';

/** The Drive sharing warning as daily-report words it, re-exported so there is one copy of it. */
export const DRIVE_SHARING_WARNING = SHARING_WARNING;

/** Reason length below which a rejection is not a reason. The intern has to be able to act on it. */
export const MIN_REASON = 12;

/** Hours a single evidence link may claim. A day is 24; anything near it is a typing mistake. */
const MAX_HOURS_PER_LINK = 24;

/** Rows returned by one list call. A cohort console pages rather than widening this. */
const MAX_ROWS = 400;

// -------------------------------------------------------------------------------------------------
// THE ACTIVITY VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * WHAT AN EVIDENCE ITEM CAN BE ABOUT.
 *
 * `activity_id` is TEXT and there is NO foreign key, deliberately. Evidence must outlive the row it
 * pointed at — an internship record that empties itself because somebody archived a task is not a
 * record. Where the id names a live row (a task, a learning assignment) the label is refreshed from
 * it on read; where it does not, the label stored at submission still reads correctly.
 *
 * `holistic` IS AN ACTIVITY LIKE ANY OTHER, and its hours sit INSIDE the weekly ceiling with
 * everything else. It is never 40 plus fitness.
 */
export const ACTIVITY_KINDS = [
  'task',
  'learning',
  'holistic',
  'mentor_session',
  'deliverable',
  'report',
  'other',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  task: 'Project work',
  learning: 'Learning',
  holistic: 'Holistic fitness',
  mentor_session: 'Mentor session',
  deliverable: 'Deliverable',
  report: 'Daily report',
  other: 'Other recorded activity',
};

const ACTIVITY_KIND_SET = new Set<string>(ACTIVITY_KINDS);

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === 'string' && ACTIVITY_KIND_SET.has(v);
}

// -------------------------------------------------------------------------------------------------
// EVIDENCE TYPES, CONFIGURABLE PER INTERNSHIP ROLE
// -------------------------------------------------------------------------------------------------

/**
 * THE ROLE FAMILIES THE SPEC NAMES. A research intern's evidence is a notebook and a dataset; an
 * engineering intern's is a pull request; a content intern's is a published piece. Asking all three
 * for "a document link" is what makes evidence a formality.
 *
 * `general` exists so an internship in a family nobody has configured yet still has somewhere honest
 * to put a link, rather than being forced into a type that misdescribes the work.
 */
export const ROLE_KEYS = [
  'engineering', 'research', 'design', 'hr', 'business', 'content', 'general',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  engineering: 'Engineering',
  research: 'Research',
  design: 'Design',
  hr: 'People and HR',
  business: 'Business',
  content: 'Content',
  general: 'General',
};

const ROLE_KEY_SET = new Set<string>(ROLE_KEYS);

export function isRoleKey(v: unknown): v is RoleKey {
  return typeof v === 'string' && ROLE_KEY_SET.has(v);
}

/**
 * A type is either a DRIVE reference, checked by the Drive rule and carrying the sharing sentence,
 * or an EXTERNAL reference — a git host, an LMS, a notebook service, a design tool, a published
 * page — checked by the general link rule.
 */
export type ReferenceKind = 'drive' | 'external';

export interface EvidenceType {
  roleKey: string;
  typeKey: string;
  label: string;
  description: string;
  referenceKind: ReferenceKind;
  sortOrder: number;
  active: boolean;
}

interface SeedType {
  role_key: RoleKey;
  type_key: string;
  label: string;
  description: string;
  reference_kind: ReferenceKind;
  sort_order: number;
}

/**
 * THE SEED, FROM THE SPEC. Inserted only where the (role, type) pair is ABSENT, so an evidence type
 * an administrator has edited or deactivated is never quietly restored to the seeded wording. That
 * is why deactivating is a flag and not a delete: a deleted row would come back on the next boot.
 */
const EVIDENCE_TYPE_SEED: SeedType[] = [
  // Engineering
  { role_key: 'engineering', type_key: 'commit', label: 'Commit', description: 'A link to the commit in the repository the work lives in.', reference_kind: 'external', sort_order: 10 },
  { role_key: 'engineering', type_key: 'pull_request', label: 'Pull request or merge request', description: 'The review thread, which shows the work and the discussion about it.', reference_kind: 'external', sort_order: 20 },
  { role_key: 'engineering', type_key: 'code_review', label: 'Review you gave someone else', description: 'Reviewing the work of another person is work. Link the review.', reference_kind: 'external', sort_order: 30 },
  { role_key: 'engineering', type_key: 'running_build', label: 'Running build or deployment', description: 'A URL where the thing you built can be seen running.', reference_kind: 'external', sort_order: 40 },
  { role_key: 'engineering', type_key: 'test_run', label: 'Test run or pipeline result', description: 'A link to the run, not a screenshot of it.', reference_kind: 'external', sort_order: 50 },
  { role_key: 'engineering', type_key: 'tech_note', label: 'Technical note or design doc', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 60 },

  // Research
  { role_key: 'research', type_key: 'notebook', label: 'Notebook', description: 'A shared notebook showing the analysis and its output.', reference_kind: 'external', sort_order: 10 },
  { role_key: 'research', type_key: 'dataset', label: 'Dataset or data record', description: 'Where the data you worked on can be reached.', reference_kind: 'external', sort_order: 20 },
  { role_key: 'research', type_key: 'literature_review', label: 'Literature review', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 30 },
  { role_key: 'research', type_key: 'experiment_log', label: 'Experiment log', description: 'The running record of what you ran and what it produced.', reference_kind: 'drive', sort_order: 40 },
  { role_key: 'research', type_key: 'preprint', label: 'Preprint, paper or poster', description: 'The published or shared version.', reference_kind: 'external', sort_order: 50 },

  // Design
  { role_key: 'design', type_key: 'design_file', label: 'Design file', description: 'A shared link to the file, with view access for anyone holding the link.', reference_kind: 'external', sort_order: 10 },
  { role_key: 'design', type_key: 'prototype', label: 'Prototype', description: 'A link somebody can click through.', reference_kind: 'external', sort_order: 20 },
  { role_key: 'design', type_key: 'case_study', label: 'Case study or rationale', description: 'A Drive document explaining the decisions. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 30 },
  { role_key: 'design', type_key: 'user_test', label: 'User test notes', description: 'What you tested, with whom, and what changed because of it.', reference_kind: 'drive', sort_order: 40 },

  // People and HR
  { role_key: 'hr', type_key: 'process_doc', label: 'Process or policy draft', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 10 },
  { role_key: 'hr', type_key: 'session_record', label: 'Session or workshop record', description: 'The agenda and notes for a session you ran or supported.', reference_kind: 'drive', sort_order: 20 },
  { role_key: 'hr', type_key: 'tracker', label: 'Tracker or dashboard', description: 'The sheet or board you maintained, shared by link.', reference_kind: 'drive', sort_order: 30 },
  { role_key: 'hr', type_key: 'published_listing', label: 'Published listing or page', description: 'Something you wrote that is now live and can be opened.', reference_kind: 'external', sort_order: 40 },

  // Business
  { role_key: 'business', type_key: 'model', label: 'Model or costing', description: 'The sheet, shared by link.', reference_kind: 'drive', sort_order: 10 },
  { role_key: 'business', type_key: 'market_study', label: 'Market or sector study', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 20 },
  { role_key: 'business', type_key: 'proposal', label: 'Proposal or deck', description: 'The version that was actually sent or presented.', reference_kind: 'drive', sort_order: 30 },
  { role_key: 'business', type_key: 'outreach_log', label: 'Outreach or pipeline record', description: 'The record of who was contacted and what came back.', reference_kind: 'drive', sort_order: 40 },

  // Content
  { role_key: 'content', type_key: 'published', label: 'Published piece', description: 'The live URL of the published work.', reference_kind: 'external', sort_order: 10 },
  { role_key: 'content', type_key: 'draft', label: 'Draft or script', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 20 },
  { role_key: 'content', type_key: 'video', label: 'Video or audio', description: 'A link to the published or shared recording.', reference_kind: 'external', sort_order: 30 },
  { role_key: 'content', type_key: 'calendar', label: 'Editorial calendar', description: 'The sheet you kept, shared by link.', reference_kind: 'drive', sort_order: 40 },

  // General
  { role_key: 'general', type_key: 'document', label: 'Document', description: 'A Drive document. Share it as Anyone with the link.', reference_kind: 'drive', sort_order: 10 },
  { role_key: 'general', type_key: 'lms_record', label: 'Course or LMS record', description: 'The page showing what you completed.', reference_kind: 'external', sort_order: 20 },
  { role_key: 'general', type_key: 'session_note', label: 'Session or meeting note', description: 'What was discussed and what you took away from it.', reference_kind: 'drive', sort_order: 30 },
  { role_key: 'general', type_key: 'external_reference', label: 'Other external reference', description: 'Anything else that can be opened by link and shows the work.', reference_kind: 'external', sort_order: 90 },
];

// -------------------------------------------------------------------------------------------------
// THE VERDICT VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * FOUR ANSWERS, AND ONLY ONE OF THEM WRITES AN HOUR.
 *
 *   accepted           the mentor states these hours happened, against this evidence. The ONLY
 *                      verdict that writes hours_verified above zero.
 *   revision_required  the work is not disputed; the evidence does not yet show it. Reason required,
 *                      and the intern reads it. Nothing is penalised — this is an invitation.
 *   rejected           this evidence does not support these hours. Reason required, and the intern
 *                      reads it. It does not accuse anybody of anything and it does not remove the
 *                      claim: the claim stays recorded, unrecognised.
 *   flagged            the mentor wants a second pair of eyes before deciding. NOT a finding against
 *                      the intern, and it must never be shown as one. Reason required so the person
 *                      it goes to knows what to look at.
 *
 * NOTHING HERE IS AUTOMATIC AND NOTHING HERE IS A PENALTY. There is no verdict that reduces somebody
 * else's number, closes their account, or marks them.
 */
export const VERDICTS = ['accepted', 'rejected', 'revision_required', 'flagged'] as const;
export type Verdict = (typeof VERDICTS)[number];

const VERDICT_SET = new Set<string>(VERDICTS);
export function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && VERDICT_SET.has(v);
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  accepted: 'Verified',
  rejected: 'Not accepted',
  revision_required: 'Revision requested',
  flagged: 'Flagged for a second look',
};

/** Plain sentences a screen shows instead of inventing its own. */
export const VERDICT_SENTENCES: Record<Verdict, string> = {
  accepted: 'A mentor verified these hours against this evidence.',
  rejected: 'A mentor did not accept this evidence for these hours, and wrote why. The reported hours stay on the record, unrecognised.',
  revision_required: 'A mentor asked for the evidence to be revised, and wrote what is missing. Nothing has been decided against you.',
  flagged: 'A mentor asked for a second look before deciding. This is not a finding about you.',
};

/** The status carried on the evidence row itself. 'submitted' is the state before any verdict. */
export type EvidenceStatus = 'submitted' | Verdict;

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  submitted: 'Waiting for your mentor',
  accepted: 'Verified',
  rejected: 'Not accepted',
  revision_required: 'Revision requested',
  flagged: 'Flagged for a second look',
};

/** Verdicts that require a written reason the intern can read. Accepting does not; refusing does. */
const REASON_REQUIRED: Verdict[] = ['rejected', 'revision_required', 'flagged'];

// =================================================================================================
// SCHEMA — additive, self-bootstrapping, one guard, a NEW key.
// =================================================================================================

/**
 * FOUR TABLES, AND EACH ONE IS A DIFFERENT NOUN IN THE CHAIN.
 *
 *   eims_evidence_types    what counts as evidence for this kind of internship. Configurable.
 *   eims_evidence          the evidence item: one link, submitted once, by one person.
 *   eims_evidence_links    which activities that item supports. MANY-TO-MANY on purpose: one pull
 *                          request can be the evidence for the task AND for the learning assignment
 *                          it taught, and forcing a copy per activity would put the same link in the
 *                          record twice with two different fates. hours_claimed and hours_verified
 *                          live HERE, because an hour belongs to an activity, not to a URL.
 *   eims_evidence_reviews  every verdict ever given, append-only. Never updated, never deleted. The
 *                          current status on eims_evidence is a projection of the latest row here;
 *                          the history is what lets somebody ask six months later what was decided,
 *                          by whom, and against which version of the link.
 */
export function ensureEvidenceSchema(): Promise<void> {
  return ensureOnce('eims_evidence_v1', async () => {
    try {
      await createEvidenceTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run from its cache so the next call
      // retries, and swallows the rejection for callers, which keeps the tolerate-missing-schema
      // behaviour every reader below is built on.
      logFail('ensureEvidenceSchema', e);
      throw e;
    }
  });
}

async function createEvidenceTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_evidence_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_key TEXT NOT NULL,
    type_key TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    reference_kind TEXT NOT NULL DEFAULT 'external',
    sort_order INT NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    role_key TEXT NOT NULL DEFAULT 'general',
    type_key TEXT NOT NULL DEFAULT 'external_reference',
    reference_kind TEXT NOT NULL DEFAULT 'external',
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    host TEXT,
    note TEXT,
    occurred_on DATE NOT NULL,
    week_start DATE NOT NULL,
    sharing_ack BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_by_user_id UUID,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'submitted',
    current_review_id UUID,
    reviewed_at TIMESTAMPTZ,
    reviewed_by_user_id UUID,
    reviewed_by_name TEXT,
    review_reason TEXT,
    outcome TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_evidence_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES eims_evidence(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL,
    activity_kind TEXT NOT NULL,
    activity_id TEXT,
    activity_label TEXT,
    hours_claimed NUMERIC(6,2) NOT NULL DEFAULT 0,
    hours_verified NUMERIC(6,2) NOT NULL DEFAULT 0,
    week_start DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_evidence_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES eims_evidence(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL,
    reviewer_user_id UUID,
    reviewer_employee_id UUID,
    reviewer_name TEXT,
    reviewer_via TEXT,
    verdict TEXT NOT NULL,
    reason TEXT,
    outcome TEXT,
    hours_verified NUMERIC(6,2) NOT NULL DEFAULT 0,
    hours_detail JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Additive assertions, so a table created by an earlier version of this file completes rather than
  // being dropped and rebuilt. ADD COLUMN IF NOT EXISTS is a no-op where the column is there.
  for (const stmt of [
    'ALTER TABLE eims_evidence ADD COLUMN IF NOT EXISTS outcome TEXT',
    'ALTER TABLE eims_evidence ADD COLUMN IF NOT EXISTS review_reason TEXT',
    'ALTER TABLE eims_evidence ADD COLUMN IF NOT EXISTS current_review_id UUID',
    'ALTER TABLE eims_evidence ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT',
    'ALTER TABLE eims_evidence ADD COLUMN IF NOT EXISTS host TEXT',
    'ALTER TABLE eims_evidence_links ADD COLUMN IF NOT EXISTS activity_label TEXT',
    'ALTER TABLE eims_evidence_links ADD COLUMN IF NOT EXISTS hours_verified NUMERIC(6,2) NOT NULL DEFAULT 0',
    'ALTER TABLE eims_evidence_reviews ADD COLUMN IF NOT EXISTS outcome TEXT',
    "ALTER TABLE eims_evidence_reviews ADD COLUMN IF NOT EXISTS hours_detail JSONB NOT NULL DEFAULT '[]'::jsonb",
  ]) {
    await db.execute(sql.raw(stmt));
  }

  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_emp_idx
    ON eims_evidence (employee_id, week_start DESC, occurred_on DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_status_idx
    ON eims_evidence (status, submitted_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_links_evidence_idx
    ON eims_evidence_links (evidence_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_links_emp_idx
    ON eims_evidence_links (employee_id, week_start)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_links_activity_idx
    ON eims_evidence_links (activity_kind, activity_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_reviews_evidence_idx
    ON eims_evidence_reviews (evidence_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_evidence_reviews_reviewer_idx
    ON eims_evidence_reviews (reviewer_user_id, created_at DESC)`);

  // Own try/catch: a unique index is the one piece of DDL here that can fail on DATA rather than on
  // syntax. Losing it must not take the tables with it. attachActivity() is an INSERT ... WHERE NOT
  // EXISTS, which is correct with or without the constraint; this is insurance against a concurrent
  // double submit, not the mechanism.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_evidence_types_key_uidx
      ON eims_evidence_types (role_key, type_key)`);
  } catch (e: any) {
    logFail('eims_evidence_types_key_uidx', e);
  }
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_evidence_links_uidx
      ON eims_evidence_links (evidence_id, activity_kind, COALESCE(activity_id, ''))`);
  } catch (e: any) {
    logFail('eims_evidence_links_uidx', e);
  }

  await seedEvidenceTypes();
}

/**
 * SEEDED, NOT OVERWRITTEN. One statement, one round trip, and it inserts only the (role, type) pairs
 * that are absent. An administrator who reworded a type or switched one off keeps their change: this
 * never updates and never re-activates.
 */
async function seedEvidenceTypes(): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO eims_evidence_types (role_key, type_key, label, description, reference_kind, sort_order)
      SELECT s.role_key, s.type_key, s.label, s.description, s.reference_kind, s.sort_order
        FROM jsonb_to_recordset(${JSON.stringify(EVIDENCE_TYPE_SEED)}::jsonb)
          AS s(role_key TEXT, type_key TEXT, label TEXT, description TEXT, reference_kind TEXT, sort_order INT)
       WHERE NOT EXISTS (
         SELECT 1 FROM eims_evidence_types t
          WHERE t.role_key = s.role_key AND t.type_key = s.type_key
       )`);
  } catch (e: any) {
    // Non-fatal by design: the tables above are what the whole module needs. A missing seed means a
    // shorter type list on one form, not a surface that cannot store evidence.
    logFail('seedEvidenceTypes', e);
  }
}

// =================================================================================================
// THE LINK RULE
// =================================================================================================

export interface EvidenceLinkCheck {
  ok: boolean;
  /** The URL as it will be stored — scheme repaired where it was missing. */
  url: string;
  host: string | null;
  referenceKind: ReferenceKind;
  /** Why it was refused. Empty when ok. */
  problem: string;
  /** Present whenever ok on a Drive link: the sharing sentence, never suppressed. */
  warning: string;
  /** Things worth saying that are not refusals. */
  notes: string[];
}

/** Hosts a link can never be evidence from, because nobody else can open them. */
const UNREACHABLE_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

/**
 * IS THIS A LINK WE CAN STORE AS EVIDENCE, AND WHAT MUST THE SUBMITTER BE TOLD?
 *
 * PURE, so the check as somebody types and the check the write path runs are THE SAME RULE.
 *
 * THE DRIVE CASE IS NOT REIMPLEMENTED HERE. It is handed to checkDriveLink() in daily-report.ts,
 * which already owns it: the two-host rule, the repaired scheme, the refusal of http://, the /u/0/
 * note, and the sharing warning. A second copy would drift, and the first symptom of that drift is a
 * form that accepts what the server refuses.
 *
 * THE EXTERNAL CASE IS NOT AN ALLOWLIST, and that is a deliberate decision rather than an omission.
 * A partner university's LMS, a lab's own git server and a student's own site are all legitimate
 * evidence, and an allowlist would refuse exactly the honest cases it had not heard of yet. So the
 * rule tests what actually matters: can another person open this, and is it a real address.
 */
export function checkEvidenceLink(raw: unknown, referenceKind: ReferenceKind = 'external'): EvidenceLinkCheck {
  if (referenceKind === 'drive') {
    const drive: DriveLinkCheck = checkDriveLink(raw);
    return {
      ok: drive.ok,
      url: drive.url,
      host: drive.host,
      referenceKind: 'drive',
      problem: drive.problem,
      warning: drive.ok ? (drive.warning || SHARING_REQUIREMENT) : '',
      notes: drive.notes || [],
    };
  }

  const empty: EvidenceLinkCheck = {
    ok: false, url: '', host: null, referenceKind: 'external', problem: '', warning: '', notes: [],
  };
  const raw_text = typeof raw === 'string' ? raw.trim() : '';
  if (!raw_text) {
    return { ...empty, problem: 'Paste the link to the work.' };
  }
  if (/\s/.test(raw_text)) {
    return { ...empty, url: raw_text, problem: 'That has a space in it, so it is not a single link. Copy it again from the address bar.' };
  }
  if (raw_text.length > 2000) {
    return { ...empty, problem: 'That link is too long to store. Link the page rather than a search result.' };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw_text) ? raw_text : 'https://' + raw_text;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ...empty, url: raw_text, problem: 'That is not a web address. Open the page and copy the link from the address bar.' };
  }

  if (parsed.protocol === 'http:') {
    return {
      ...empty, url: raw_text, host: parsed.hostname,
      problem: 'Use the https:// address. An http:// link is not the address the site actually publishes.',
    };
  }
  if (parsed.protocol !== 'https:') {
    // This is also what refuses data: and javascript: and file: — none of which is a link somebody
    // else can open, and one of which is not a link at all.
    return {
      ...empty, url: raw_text, host: parsed.hostname,
      problem: 'Only an https:// link can be stored as evidence. Evidence is always a link to work '
        + 'that stays where it lives; nothing is ever uploaded here.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ...empty, url: raw_text, host: parsed.hostname,
      problem: 'That link has a username or password in it. Copy the plain address instead — a link '
        + 'carrying a credential must never be stored.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (UNREACHABLE_HOSTS.indexOf(host) >= 0 || /^10\./.test(host) || /^192\.168\./.test(host) || /\.local$/.test(host)) {
    return {
      ...empty, url: withScheme, host,
      problem: 'That address only works on your own machine or network, so your mentor cannot open it. '
        + 'Link the published or shared version.',
    };
  }
  if (host.indexOf('.') < 0) {
    return { ...empty, url: withScheme, host, problem: 'That does not look like a full web address.' };
  }

  const notes: string[] = [];
  if (/^https:\/\/[^/]+\/?$/.test(withScheme)) {
    notes.push('This links to the front page of a site rather than to the work itself. Link the exact '
      + 'page, file or change, so your mentor is not left hunting for it.');
  }

  return { ok: true, url: withScheme, host, referenceKind: 'external', problem: '', warning: '', notes };
}

// =================================================================================================
// WHO MAY VERIFY — RESOLVED PER ROW FROM THE ORGANIZATION GRAPH
// =================================================================================================

export interface VerifierResolution {
  graphReady: boolean;
  /** Which recorded edge named them. Never a job title. */
  via: 'mentor' | 'reporting_manager' | 'reviewer' | null;
  person: OrgPerson | null;
  sentence: string;
}

/**
 * WHO VERIFIES THIS INTERN'S EVIDENCE?
 *
 * The MENTOR edge first, because this is mentor verification and the spec names the mentor. The
 * reporting manager second, because on most engagements that is who the mentor edge would have named
 * anyway. A recorded reviewer edge third.
 *
 * WHERE THE GRAPH NAMES NOBODY, NOBODY IS NAMED. It does not fall back to a role, a department, or
 * anybody's job title, and it says so in a sentence somebody can act on ("ask HR to record the
 * relationship") rather than failing silently. An intern with no recorded mentor is an HR problem to
 * fix, not a person for the system to guess an approver for.
 */
export async function verifierFor(employeeId: string): Promise<VerifierResolution> {
  const notReady: VerifierResolution = {
    graphReady: false, via: null, person: null,
    sentence: 'The Organization Graph has not been initialized yet, so who may verify this work is not '
      + 'recorded anywhere we are willing to read. Nothing is guessed from a job title.',
  };
  if (!isUuid(employeeId)) return notReady;

  try {
    const ready = await orgIsInitialized();
    if (!ready) return notReady;

    const mentor = await getMentor(employeeId);
    if (mentor) {
      return {
        graphReady: true, via: 'mentor', person: mentor,
        sentence: 'Verified by ' + (mentor.fullName || 'the recorded mentor') + ', mentor.',
      };
    }
    const manager = await getManager(employeeId);
    if (manager) {
      return {
        graphReady: true, via: 'reporting_manager', person: manager,
        sentence: 'Verified by ' + (manager.fullName || 'the recorded reporting manager') + ', reporting manager.',
      };
    }
    return {
      graphReady: true, via: null, person: null,
      sentence: 'No mentor and no reporting manager is recorded for this person, so nobody can verify '
        + 'their hours yet. The evidence is still filed and nothing is lost; ask HR to record the '
        + 'relationship.',
    };
  } catch (e: any) {
    logFail('verifierFor', e);
    return notReady;
  }
}

/**
 * MAY THIS SIGNED-IN USER VERIFY THIS INTERN'S EVIDENCE?
 *
 * Asked again at the moment of every write, never inferred from the fact that a list rendered. A
 * posted evidence id from somebody else's queue is refused here, not by the absence of a button.
 *
 * NOBODY VERIFIES THEMSELVES, under any edge. Self-verification would make the whole record worth
 * nothing, and it is the first thing anybody would try.
 */
export async function mayVerify(userId: string, employeeId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(employeeId)) return false;
  try {
    const actor = await employeeIdForUser(userId);
    if (!actor || actor === employeeId) return false;

    const resolved = await verifierFor(employeeId);
    if (!resolved.graphReady) return false;
    if (resolved.person?.employeeId === actor) return true;

    // A recorded reviewer edge counts too, even where the mentor edge named somebody else: a second
    // person recorded as reviewing this person's work is exactly what that edge means.
    const subjects = await getReviewSubjects(actor);
    return subjects.some((p) => p.employeeId === employeeId);
  } catch (e: any) {
    logFail('mayVerify', e);
    return false;   // a failure to establish authority is not authority
  }
}

/**
 * EVERY INTERN THIS PERSON IS RESPONSIBLE FOR, from the graph and from nowhere else.
 *
 * Mentees, direct reports and review subjects, de-duplicated, each carrying the edge that named
 * them so the dashboard can say why somebody is on the list.
 */
export interface RosterEntry extends OrgPerson {
  via: 'mentor' | 'reporting_manager' | 'reviewer';
}

export async function mentorRoster(userId: string): Promise<{ graphReady: boolean; employeeId: string | null; people: RosterEntry[]; sentence: string }> {
  const notReady = {
    graphReady: false, employeeId: null, people: [] as RosterEntry[],
    sentence: 'The Organization Graph has not been initialized yet. Until it is, nobody has a recorded '
      + 'mentee here — and a list guessed from job titles would be the wrong list.',
  };
  if (!isUuid(userId)) return notReady;

  try {
    const ready = await orgIsInitialized();
    if (!ready) return notReady;

    const me = await employeeIdForUser(userId);
    if (!me) {
      return {
        graphReady: true, employeeId: null, people: [],
        sentence: 'This sign-in has no employee record linked to it, so the graph has no edges to read '
          + 'from it. Ask HR to link your employee record.',
      };
    }

    const [mentees, reports, subjects] = await Promise.all([
      getMentees(me), getDirectReports(me), getReviewSubjects(me),
    ]);

    const seen = new Set<string>();
    const people: RosterEntry[] = [];
    const push = (list: OrgPerson[], via: RosterEntry['via']) => {
      for (const p of list) {
        if (!p.employeeId || seen.has(p.employeeId) || p.employeeId === me) continue;
        seen.add(p.employeeId);
        people.push({ ...p, via });
      }
    };
    push(mentees, 'mentor');
    push(reports, 'reporting_manager');
    push(subjects, 'reviewer');

    return {
      graphReady: true, employeeId: me, people,
      sentence: people.length
        ? 'Resolved from the Organization Graph, per person, from the recorded mentor, reporting and '
          + 'reviewer edges.'
        : 'The graph records nobody as mentored by, reporting to, or reviewed by you. Nothing is '
          + 'inferred from a job title, so this list is empty rather than wrong.',
    };
  } catch (e: any) {
    logFail('mentorRoster', e);
    return notReady;
  }
}

// =================================================================================================
// READ TYPES
// =================================================================================================

export interface EvidenceLinkRow {
  id: string;
  evidenceId: string;
  activityKind: ActivityKind | string;
  activityId: string | null;
  activityLabel: string;
  hoursClaimed: number;
  hoursVerified: number;
  weekStart: string;
}

export interface EvidenceRow {
  id: string;
  employeeId: string;
  roleKey: string;
  typeKey: string;
  typeLabel: string;
  referenceKind: ReferenceKind;
  title: string;
  url: string;
  host: string | null;
  note: string | null;
  occurredOn: string;
  weekStart: string;
  sharingAck: boolean;
  submittedByUserId: string | null;
  submittedAt: string | null;
  status: EvidenceStatus;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewReason: string | null;
  outcome: string | null;
  links: EvidenceLinkRow[];
  hoursClaimed: number;
  hoursVerified: number;
}

export interface ReviewRow {
  id: string;
  evidenceId: string;
  reviewerName: string | null;
  reviewerVia: string | null;
  verdict: Verdict | string;
  reason: string | null;
  outcome: string | null;
  hoursVerified: number;
  evidenceUrl: string | null;
  createdAt: string | null;
}

// =================================================================================================
// SUBMITTING EVIDENCE
// =================================================================================================

export interface ActivityRef {
  kind: ActivityKind;
  /** The activity's own id where it has one (a task id, a learning assignment id). May be null. */
  id?: string | null;
  /** What to call it if the id names nothing readable. */
  label?: string | null;
  /** What the intern reports they spent on this activity, evidenced by this item. */
  hoursClaimed: number;
}

export interface SubmitEvidenceInput {
  employeeId: string;
  /** The signed-in user filing it. Recorded on the row and on the audit line. */
  userId: string | null;
  roleKey?: string | null;
  typeKey: string;
  title: string;
  url: string;
  note?: string | null;
  /** The day the work happened. The week is derived from it, never from the day it was pasted. */
  occurredOn: string;
  /** The submitter's own statement that a Drive file is shared as "anyone with the link". */
  sharingAck?: boolean;
  activities: ActivityRef[];
}

export interface SubmitEvidenceResult {
  ok: boolean;
  id: string;
  error: string;
  /** The sharing sentence and any non-refusing notes, to show back after a successful save. */
  warning: string;
  notes: string[];
}

/**
 * FILE ONE PIECE OF EVIDENCE AND SAY WHAT IT IS EVIDENCE OF.
 *
 * THE ACTIVITY LIST IS NOT OPTIONAL. Evidence attached to nothing is a bookmark: it cannot support
 * an hour, cannot be rolled up into a week, and cannot answer "why were these hours recognised".
 * Refusing here is what keeps the graph a graph.
 *
 * HOURS ARE RECORDED AS CLAIMED, WHATEVER THEY ARE. An intern who reports six hours on a four-hour
 * allocation gets six recorded. Nothing is trimmed, nothing is capped, and nothing is questioned at
 * this step. The over-run becomes a sentence on the mentor's screen (advisoryNotes) and the mentor
 * decides. Silently reducing somebody's reported effort is the one thing that would teach them to
 * stop reporting honestly.
 */
export async function submitEvidence(input: SubmitEvidenceInput): Promise<SubmitEvidenceResult> {
  const fail = (error: string): SubmitEvidenceResult => ({ ok: false, id: '', error, warning: '', notes: [] });

  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return fail('That employee record could not be read, so nothing was filed.');

  const title = text(input?.title, 200);
  if (title.length < 3) return fail('Give this evidence a name, so your mentor knows what they are opening.');

  const occurredOn = iso(input?.occurredOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return fail('Say which day this work happened on.');
  }
  const weekStart = weekStartOf(occurredOn);
  if (!weekStart) return fail('That date could not be read as a calendar day.');

  const typeKey = text(input?.typeKey, 60) || 'external_reference';
  const roleKey = isRoleKey(input?.roleKey) ? String(input?.roleKey) : 'general';

  const activities = Array.isArray(input?.activities) ? input.activities : [];
  if (!activities.length) {
    return fail('Say what this is evidence of. Evidence attached to no activity cannot support any '
      + 'hours, so nothing was filed.');
  }

  // Resolve the type BEFORE the link is checked: the type is what decides whether the Drive rule or
  // the external rule applies, and applying the wrong one would refuse a good link.
  let referenceKind: ReferenceKind = 'external';
  try {
    await ensureEvidenceSchema();
    const found = rows(await db.execute(sql`
      SELECT reference_kind FROM eims_evidence_types
       WHERE role_key = ${roleKey} AND type_key = ${typeKey} AND active = TRUE
       LIMIT 1`))[0];
    if (found?.reference_kind === 'drive') referenceKind = 'drive';
  } catch (e: any) {
    // Not fatal. An unreadable type list means the external rule applies, which refuses less; the
    // Drive rule is then applied anyway below if the host says Drive.
    logFail('submitEvidence type lookup', e);
  }

  let check = checkEvidenceLink(input?.url, referenceKind);
  if (referenceKind === 'external' && /(^|\.)(drive|docs)\.google\.com$/i.test(String(check.host || ''))) {
    // A Drive link pasted into an external field is still a Drive link, and it still needs the
    // sharing sentence. Re-check it under the rule that owns it rather than storing it unwarned.
    check = checkEvidenceLink(input?.url, 'drive');
    referenceKind = 'drive';
  }
  if (!check.ok) return fail(check.problem || 'That link could not be stored.');

  const cleaned: { kind: ActivityKind; id: string | null; label: string; hours: number }[] = [];
  for (const a of activities) {
    if (!isActivityKind(a?.kind)) {
      return fail('One of those activities is not a kind of activity this system records.');
    }
    const hours = round2(num(a?.hoursClaimed));
    if (hours < 0) return fail('Hours cannot be negative.');
    if (hours > MAX_HOURS_PER_LINK) {
      return fail('That is more than ' + MAX_HOURS_PER_LINK + ' hours against one activity on one '
        + 'piece of evidence. Check the figure — nothing was filed.');
    }
    const id = a?.id ? text(a.id, 100) : '';
    cleaned.push({
      kind: a.kind,
      id: id || null,
      label: text(a?.label, 200) || ACTIVITY_KIND_LABELS[a.kind],
      hours,
    });
  }
  if (cleaned.every((c) => c.hours <= 0)) {
    return fail('Say how many hours this evidence covers. Zero hours against every activity records '
      + 'nothing that can be verified.');
  }

  const userId = isUuid(input?.userId) ? String(input?.userId) : null;
  const note = text(input?.note, 2000) || null;
  const sharingAck = !!input?.sharingAck;

  // A Drive link filed without the sharing statement is the single most common way evidence arrives
  // unopenable. It is not refused — refusing would lose the work — but it is recorded as unconfirmed
  // and the mentor's screen says so.
  try {
    const inserted = rows(await db.execute(sql`
      INSERT INTO eims_evidence (
        employee_id, role_key, type_key, reference_kind, title, url, host, note,
        occurred_on, week_start, sharing_ack, submitted_by_user_id, status
      ) VALUES (
        ${employeeId}::uuid, ${roleKey}, ${typeKey}, ${referenceKind}, ${title}, ${check.url},
        ${check.host}, ${note}, ${occurredOn}::date, ${weekStart}::date, ${sharingAck},
        ${userId}::uuid, 'submitted'
      )
      RETURNING id::text AS id`))[0];

    const evidenceId = String(inserted?.id || '');
    if (!evidenceId) {
      console.error('[eims-evidence] submitEvidence returned no id');
      return fail(WRITE_FAILED);
    }

    for (const c of cleaned) {
      await db.execute(sql`
        INSERT INTO eims_evidence_links (
          evidence_id, employee_id, activity_kind, activity_id, activity_label, hours_claimed,
          hours_verified, week_start
        )
        SELECT ${evidenceId}::uuid, ${employeeId}::uuid, ${c.kind}, ${c.id}, ${c.label},
               ${c.hours}, 0, ${weekStart}::date
         WHERE NOT EXISTS (
           SELECT 1 FROM eims_evidence_links l
            WHERE l.evidence_id = ${evidenceId}::uuid
              AND l.activity_kind = ${c.kind}
              AND COALESCE(l.activity_id, '') = COALESCE(${c.id}, '')
         )`);
    }

    await logAudit({
      userId,
      action: 'evidence.submit',
      entity: 'eims_evidence',
      entityId: evidenceId,
      diff: {
        employeeId, typeKey, roleKey, occurredOn,
        hoursClaimed: round2(cleaned.reduce((s, c) => s + c.hours, 0)),
        activities: cleaned.map((c) => c.kind + (c.id ? ':' + c.id : '')),
      },
    });

    // Tell the person who has to look at it. A queue nobody knows has grown is a queue nobody clears.
    await notifyVerifier(employeeId, title);

    return {
      ok: true,
      id: evidenceId,
      error: '',
      warning: check.warning || (referenceKind === 'drive' ? SHARING_REQUIREMENT : ''),
      notes: check.notes,
    };
  } catch (e: any) {
    // NEVER SWALLOWED. The real Postgres reason goes to the log; the person gets a sentence.
    logFail('submitEvidence', e);
    return fail(WRITE_FAILED);
  }
}

/** Best-effort notification to whoever the graph says verifies this person. Never blocks the write. */
async function notifyVerifier(employeeId: string, title: string): Promise<void> {
  try {
    const resolved = await verifierFor(employeeId);
    const userId = resolved.person?.userId;
    if (!userId) return;
    await notifyUser(String(userId), {
      title: 'Evidence to verify',
      body: title,
      type: 'info',
      actionUrl: '/portal/mentor',
      entityType: 'eims_evidence',
      entityId: employeeId,
    });
  } catch (e: any) {
    logFail('notifyVerifier', e);
  }
}

// =================================================================================================
// THE VERDICT — THE ONLY WRITER OF VERIFIED HOURS IN THIS CODEBASE
// =================================================================================================

export interface VerdictHoursInput {
  /** eims_evidence_links.id */
  linkId: string;
  hours: number;
}

export interface RecordVerdictInput {
  evidenceId: string;
  /** The signed-in mentor. Authority is re-derived from this at the write, never trusted from a form. */
  userId: string;
  verdict: Verdict;
  /** Required on rejected / revision_required / flagged. The intern reads it. */
  reason?: string | null;
  /** What this verification establishes — the outcome end of the chain. Optional, kept with the verdict. */
  outcome?: string | null;
  /**
   * Per-link verified hours. OMIT on an accept to verify exactly what was claimed; give it to verify
   * fewer. Never more than was claimed on that link — that refusal is the "no hour inflation" rule
   * enforced at the only place hours can enter the record.
   */
  hours?: VerdictHoursInput[];
}

export interface RecordVerdictResult {
  ok: boolean;
  error: string;
  /** The verified total now standing on this evidence. */
  hoursVerified: number;
  /** Non-blocking sentences: over the weekly ceiling, unconfirmed sharing, and the like. */
  advisories: string[];
}

/**
 * ACCEPT, REJECT, REQUEST A REVISION, OR FLAG.
 *
 * WHAT MAKES THIS SAFE, in order:
 *
 *   1. AUTHORITY IS RE-DERIVED HERE. mayVerify() is asked again at the write, against the employee
 *      on the evidence row as it stands in the database — not the employee id on the form. A posted
 *      id from another mentor's queue fails here.
 *   2. A REASON IS REQUIRED ON EVERY VERDICT THAT IS NOT AN ACCEPT, and it is stored where the
 *      intern can read it. "Rejected" with no sentence is the thing this system exists to prevent.
 *   3. VERIFIED NEVER EXCEEDS CLAIMED. Per link, checked before anything is written.
 *   4. EVERY VERDICT IS APPENDED, NEVER OVERWRITTEN. The review row records who, when, which verdict,
 *      which reason, which hours, and the URL as it stood. A later verdict adds a row; it does not
 *      erase the earlier one.
 *   5. ONLY AN ACCEPT WRITES HOURS. Every other verdict sets the verified hours on those links back
 *      to zero, in the same write, so a re-review cannot leave hours standing on evidence that has
 *      since been rejected.
 *   6. NOTHING IS AUTOMATIC. There is no path into this function that is not a person pressing a
 *      button, and no scheduled job calls it.
 */
export async function recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult> {
  const fail = (error: string): RecordVerdictResult => ({ ok: false, error, hoursVerified: 0, advisories: [] });

  const evidenceId = String(input?.evidenceId || '');
  const userId = String(input?.userId || '');
  if (!isUuid(evidenceId)) return fail('That evidence could not be read, so nothing was recorded.');
  if (!isUuid(userId)) return fail('Your sign-in could not be read, so nothing was recorded.');
  if (!isVerdict(input?.verdict)) return fail('That is not a verdict this system records.');

  const verdict = input.verdict;
  const reason = text(input?.reason, 1000);
  if (REASON_REQUIRED.indexOf(verdict) >= 0 && reason.length < MIN_REASON) {
    return fail('Write a reason. The intern reads this, and it is the only thing that tells them what '
      + 'to do next. Nothing was recorded.');
  }
  const outcome = text(input?.outcome, 500) || null;

  try {
    await ensureEvidenceSchema();

    const ev = rows(await db.execute(sql`
      SELECT id::text AS id, employee_id::text AS employee_id, title, url, status, week_start,
             sharing_ack, reference_kind
        FROM eims_evidence WHERE id = ${evidenceId}::uuid LIMIT 1`))[0];
    if (!ev) return fail('That evidence is not on the record. Nothing was changed.');

    const employeeId = String(ev.employee_id || '');
    const allowed = await mayVerify(userId, employeeId);
    if (!allowed) {
      return fail('The Organization Graph does not record you as the mentor, reporting '
        + 'manager or reviewer, so you cannot verify their hours. Nothing was changed.');
    }

    const linkRows = rows(await db.execute(sql`
      SELECT id::text AS id, activity_kind, activity_id, activity_label,
             hours_claimed, hours_verified, week_start
        FROM eims_evidence_links WHERE evidence_id = ${evidenceId}::uuid
        ORDER BY created_at ASC`));
    if (!linkRows.length) {
      return fail('This evidence is not attached to any activity, so there is nothing to verify '
        + 'against. Nothing was changed.');
    }

    // WHAT EACH LINK ENDS UP VERIFIED AT. Only an accept can be above zero.
    const requested = new Map<string, number>();
    for (const h of (Array.isArray(input?.hours) ? input.hours : [])) {
      const id = String(h?.linkId || '');
      if (id) requested.set(id, round2(num(h?.hours)));
    }

    const decided: {
      id: string; kind: string; activityId: string | null; label: string;
      claimed: number; verified: number;
    }[] = [];
    for (const l of linkRows) {
      const id = String(l.id);
      const claimed = round2(num(l.hours_claimed));
      let verified = 0;
      if (verdict === 'accepted') {
        verified = requested.has(id) ? round2(requested.get(id) as number) : claimed;
        if (verified < 0) return fail('Verified hours cannot be negative. Nothing was changed.');
        if (verified > claimed) {
          return fail('You cannot verify more hours than were reported on "'
            + String(l.activity_label || 'that activity')
            + '". Reported ' + claimed + ', asked to verify ' + verified + '. Nothing was changed.');
        }
      }
      decided.push({
        id,
        kind: String(l.activity_kind || ''),
        activityId: l.activity_id ? String(l.activity_id) : null,
        label: String(l.activity_label || ''),
        claimed,
        verified,
      });
    }

    const totalVerified = round2(decided.reduce((s, d) => s + d.verified, 0));

    const me = await employeeIdForUser(userId);
    const resolved = await verifierFor(employeeId);
    const via = resolved.person?.employeeId === me ? String(resolved.via || 'reviewer') : 'reviewer';
    const reviewerName = await employeeName(me);

    const review = rows(await db.execute(sql`
      INSERT INTO eims_evidence_reviews (
        evidence_id, employee_id, reviewer_user_id, reviewer_employee_id, reviewer_name,
        reviewer_via, verdict, reason, outcome, hours_verified, hours_detail, evidence_url
      ) VALUES (
        ${evidenceId}::uuid, ${employeeId}::uuid, ${userId}::uuid, ${me}::uuid, ${reviewerName}::text,
        ${via}, ${verdict}, ${reason || null}, ${outcome}, ${totalVerified},
        ${JSON.stringify(decided)}::jsonb, ${String(ev.url || '')}
      )
      RETURNING id::text AS id`))[0];
    const reviewId = String(review?.id || '');

    // THE HOURS. One statement per link, each carrying its own id, so a link added between the read
    // and the write is simply not touched rather than silently taking somebody else's figure.
    for (const d of decided) {
      await db.execute(sql`
        UPDATE eims_evidence_links
           SET hours_verified = ${d.verified}, updated_at = NOW()
         WHERE id = ${d.id}::uuid AND evidence_id = ${evidenceId}::uuid`);
    }

    await db.execute(sql`
      UPDATE eims_evidence
         SET status = ${verdict},
             current_review_id = ${reviewId || null},
             reviewed_at = NOW(),
             reviewed_by_user_id = ${userId}::uuid,
             reviewed_by_name = ${reviewerName},
             review_reason = ${reason || null},
             outcome = ${outcome},
             updated_at = NOW()
       WHERE id = ${evidenceId}::uuid`);

    await logAudit({
      userId,
      action: 'evidence.' + verdict,
      entity: 'eims_evidence',
      entityId: evidenceId,
      diff: { employeeId, verdict, hoursVerified: totalVerified, via, reasonGiven: !!reason },
    });

    await notifyIntern(employeeId, verdict, String(ev.title || ''), totalVerified);

    const advisories: string[] = [];
    if (verdict === 'accepted') {
      // EVERYTHING FROM HERE ON HAPPENS AFTER THE VERDICT IS DURABLE, AND MUST NEVER BE ABLE TO
      // REPORT FAILURE. The review row is written, the hours are written, the status is written. If
      // a follow-up read then throws, the honest sentence is "your verdict is recorded, this one
      // check could not be run" — telling a mentor "nothing was changed" when everything was changed
      // is the precise failure this phase exists to remove, and it would send them back to press the
      // button again on a record that has already taken it.
      try {
        // THE VERDICT HAS TO LAND ON THE ACTIVITY LEDGER, OR IT IS NOT A VERIFIED HOUR.
        // Done AFTER the evidence side is durable, so a refusal from the ledger cannot lose the
        // mentor's verdict, and reported back in the ledger's own words rather than summarised.
        for (const note of await bridgeToActivityLedger(employeeId, decided, userId, String(ev.title || ''), String(ev.url || ''))) {
          advisories.push(note);
        }

        if (!ev.sharing_ack && String(ev.reference_kind) === 'drive') {
          advisories.push('The submitter did not confirm this Drive file is shared as "Anyone with the '
            + 'link". If you could open it, it is shared; this is recorded so the record can say so.');
        }
        const week = await verifiedHoursForWeek(employeeId, iso(ev.week_start));
        if (week.ceiling != null && week.verified > week.ceiling) {
          advisories.push('Verified hours for the week are now ' + week.verified
            + ', above the ' + week.ceiling + '-hour ceiling. Everything above the ceiling stays '
            + 'RECORDED and is NOT recognised: the recognised figure for the week is ' + week.recognised
            + '. Nothing has been deleted and nobody is at fault.');
        }
      } catch (e: any) {
        // NOT SWALLOWED — logged with the real Postgres reason and said out loud on the mentor's own
        // screen, as an advisory rather than as a failure, because the verdict itself stands.
        logFail('recordVerdict follow-up', e);
        advisories.push('Your verdict is recorded and the hours are on the evidence. The follow-up '
          + 'checks — landing the hours on the activity ledger, and the weekly ceiling — could not be '
          + 'run just now. Open this intern on your dashboard to see where the hours stand.');
      }
    }

    return { ok: true, error: '', hoursVerified: totalVerified, advisories };
  } catch (e: any) {
    // NEVER SWALLOWED. A verdict that silently did nothing would leave a mentor believing they had
    // verified somebody's week.
    logFail('recordVerdict', e);
    return fail(WRITE_FAILED);
  }
}


// -------------------------------------------------------------------------------------------------
// WHERE THE VERDICT LANDS ON THE ACTIVITY LEDGER
// -------------------------------------------------------------------------------------------------

/** One decided link, as recordVerdict() settled it. Structural, so nothing else can be passed here. */
interface DecidedLink {
  id: string;
  kind: string;
  activityId: string | null;
  label: string;
  claimed: number;
  verified: number;
}

/**
 * THE ONE PLACE THE EVIDENCE SIDE AND THE ACTIVITY LEDGER ARE HELD IN AGREEMENT.
 *
 * A mentor's accept is not finished when the evidence row says "accepted". The hour of record for an
 * activity is `employee_tasks.verified_hours`, and until the verdict reaches it the intern's week
 * still reads as unverified on every screen that asks the ledger. So this walks the links the verdict
 * just settled and puts the figure where the record keeps it.
 *
 * FIVE PROPERTIES, EACH DELIBERATE:
 *
 *   1. IT SENDS THE ACTIVITY'S NEW TOTAL, NOT THIS EVIDENCE'S SHARE. verifyActivity() SETS
 *      verified_hours; it does not add to it. An activity can be supported by several evidence items,
 *      so the figure that belongs on it is the sum of the verified hours across ALL of them, read
 *      back from eims_evidence_links AFTER this verdict's writes landed. Sending the share would
 *      overwrite every earlier item's contribution with the latest one.
 *   2. IT ASKS THE LEDGER WHETHER IT KNOWS THE ROW, INSTEAD OF GUESSING FROM THE KIND. A link may
 *      name a learning assignment, a project deliverable or nothing at all; only some ids are
 *      activities. getActivity() answers that in one read, and anything it does not recognise is
 *      reported as standing on the evidence record alone rather than quietly dropped.
 *   3. IT NEVER WRITES A ZERO. verifyActivity() stamps verified_at, and a verified activity refuses
 *      further verification until somebody reopens it. Landing a zero would freeze an activity at
 *      nothing because the first evidence item that reached it happened to support no hours on it.
 *   4. IT DOES NOT DECIDE. Every refusal from the ledger — nothing reported yet, no allocation
 *      recorded, already verified, closed — comes back in the LEDGER'S OWN WORDS, on the mentor's
 *      screen, for them to act on. It is never retried, never worked around, and never summarised
 *      into "something went wrong".
 *   5. IT CANNOT THROW. It is called after the verdict is durable. Every branch is caught and turned
 *      into a sentence, because an exception here would otherwise become "nothing was changed" on a
 *      screen where a great deal was changed.
 *
 * It writes nothing itself. verifyActivity() is the only writer of the hour of record, and this
 * function's whole job is to call it correctly and repeat what it says.
 */
async function bridgeToActivityLedger(
  employeeId: string,
  decided: DecidedLink[],
  verifierUserId: string,
  evidenceTitle: string,
  evidenceUrl: string,
): Promise<string[]> {
  const notes: string[] = [];
  const unattached: string[] = [];

  // What the mentor looked at, in the words the ledger will keep on the activity. An activity type
  // that requires evidence is satisfied by this and by nothing weaker.
  const evidenceSeen = (evidenceTitle || 'Evidence') + (evidenceUrl ? ' — ' + evidenceUrl : '');

  // De-duplicated by activity: one evidence item cannot name the same activity twice (the unique
  // index refuses it), but this keeps the loop honest if that index is ever lost.
  const seen = new Set<string>();

  for (const d of decided) {
    const activityId = d.activityId ? String(d.activityId) : '';
    const label = d.label || ACTIVITY_KIND_LABELS[(d.kind as ActivityKind)] || 'that activity';

    if (!isUuid(activityId)) {
      if (d.verified > 0) unattached.push(label + ' (' + d.verified + 'h)');
      continue;
    }
    if (seen.has(activityId)) continue;
    seen.add(activityId);

    try {
      const activity = await getActivity(activityId);
      // Not an activity the ledger keeps — a learning assignment id, a deliverable id, or a row that
      // has since gone. The evidence record still holds these hours and says so.
      if (!activity || activity.employeeId !== employeeId) {
        if (d.verified > 0) unattached.push(label + ' (' + d.verified + 'h)');
        continue;
      }

      // THE ACTIVITY'S NEW TOTAL, read back from the evidence side after this verdict's writes.
      const total = (await verifiedHoursForActivity(employeeId, (d.kind as ActivityKind), activityId)).verified;
      if (!(total > 0)) continue;   // never freeze an activity at zero

      const res = await verifyActivity({
        activityId,
        verifierUserId,
        hours: total,
        evidenceSeen,
        note: 'Verified from evidence: ' + (evidenceTitle || 'an evidence item') + '.',
      });

      if (res.ok) {
        for (const n of res.notes) notes.push(label + ': ' + n);
      } else {
        // VERBATIM. The ledger's sentence already says what to do next; rewording it here would put
        // a second, vaguer explanation in front of the only person who can act on the first.
        notes.push('These hours are recorded on the evidence, and the activity ledger did not take '
          + 'them for "' + label + '": ' + res.error);
      }
    } catch (e: any) {
      logFail('bridgeToActivityLedger', e);
      notes.push('These hours are recorded on the evidence. Landing them on the activity "' + label
        + '" could not be completed just now, so that activity may still read as unverified. Nothing '
        + 'was lost and nothing needs re-entering.');
    }
  }

  if (unattached.length) {
    notes.push('Verified against work with no activity row to land on: ' + unattached.join(', ')
      + '. These hours are real and they are on the evidence record with your name on them, but no '
      + 'activity ledger has taken them, so they will not appear as verified activity hours. Record '
      + 'the allocation for that work if it should count towards the week.');
  }

  return notes;
}

/** hr_employees.full_name for an employee id. An identity lookup, not a relationship. */
async function employeeName(employeeId: string | null): Promise<string | null> {
  if (!isUuid(employeeId || '')) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT full_name FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    return r?.full_name ? String(r.full_name) : null;
  } catch (e: any) {
    logFail('employeeName', e);
    return null;
  }
}

/** Tell the intern what happened, in the words of the verdict rather than a status code. */
async function notifyIntern(employeeId: string, verdict: Verdict, title: string, hours: number): Promise<void> {
  try {
    const r = rows(await db.execute(sql`
      SELECT user_id::text AS user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    const userId = r?.user_id ? String(r.user_id) : '';
    if (!isUuid(userId)) return;
    const body = verdict === 'accepted'
      ? hours + ' hours verified against "' + title + '".'
      : VERDICT_SENTENCES[verdict];
    await notifyUser(userId, {
      title: VERDICT_LABELS[verdict] + ': ' + title,
      body,
      type: 'info',
      actionUrl: '/portal/employee/credits',
      entityType: 'eims_evidence',
      entityId: employeeId,
    });
  } catch (e: any) {
    logFail('notifyIntern', e);
  }
}

// =================================================================================================
// READING THE GRAPH
// =================================================================================================

function mapLink(r: any): EvidenceLinkRow {
  return {
    id: String(r.id),
    evidenceId: String(r.evidence_id),
    activityKind: String(r.activity_kind || 'other'),
    activityId: r.activity_id ? String(r.activity_id) : null,
    activityLabel: String(r.activity_label || ''),
    hoursClaimed: round2(num(r.hours_claimed)),
    hoursVerified: round2(num(r.hours_verified)),
    weekStart: iso(r.week_start),
  };
}

function mapEvidence(r: any, links: EvidenceLinkRow[]): EvidenceRow {
  const mine = links.filter((l) => l.evidenceId === String(r.id));
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    roleKey: String(r.role_key || 'general'),
    typeKey: String(r.type_key || ''),
    typeLabel: String(r.type_label || r.type_key || ''),
    referenceKind: String(r.reference_kind) === 'drive' ? 'drive' : 'external',
    title: String(r.title || ''),
    url: String(r.url || ''),
    host: r.host ? String(r.host) : null,
    note: r.note ? String(r.note) : null,
    occurredOn: iso(r.occurred_on),
    weekStart: iso(r.week_start),
    sharingAck: !!r.sharing_ack,
    submittedByUserId: r.submitted_by_user_id ? String(r.submitted_by_user_id) : null,
    submittedAt: stamp(r.submitted_at),
    status: (String(r.status || 'submitted') as EvidenceStatus),
    reviewedAt: stamp(r.reviewed_at),
    reviewedByName: r.reviewed_by_name ? String(r.reviewed_by_name) : null,
    reviewReason: r.review_reason ? String(r.review_reason) : null,
    outcome: r.outcome ? String(r.outcome) : null,
    links: mine,
    hoursClaimed: round2(mine.reduce((s, l) => s + l.hoursClaimed, 0)),
    hoursVerified: round2(mine.reduce((s, l) => s + l.hoursVerified, 0)),
  };
}

/** The evidence types offered for a role, in order. Falls back to the general list. */
export async function evidenceTypesForRole(roleKey: string): Promise<EvidenceType[]> {
  const key = isRoleKey(roleKey) ? roleKey : 'general';
  try {
    await ensureEvidenceSchema();
    const r = rows(await db.execute(sql`
      SELECT role_key, type_key, label, description, reference_kind, sort_order, active
        FROM eims_evidence_types
       WHERE active = TRUE AND role_key IN (${key}, 'general')
       ORDER BY (role_key = 'general') ASC, sort_order ASC, label ASC`));
    return r.map((x) => ({
      roleKey: String(x.role_key),
      typeKey: String(x.type_key),
      label: String(x.label || x.type_key),
      description: String(x.description || ''),
      referenceKind: String(x.reference_kind) === 'drive' ? 'drive' : 'external',
      sortOrder: Number(x.sort_order || 100),
      active: !!x.active,
    }));
  } catch (e: any) {
    logFail('evidenceTypesForRole', e);
    return [];
  }
}

export interface ListEvidenceOptions {
  fromIso?: string | null;
  toIso?: string | null;
  status?: EvidenceStatus | null;
  limit?: number;
}

/** One person's evidence, newest work first, with every activity it supports. */
export async function listEvidenceForEmployee(
  employeeId: string,
  opts?: ListEvidenceOptions,
): Promise<EvidenceRow[]> {
  if (!isUuid(employeeId)) return [];
  const from = opts?.fromIso && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.fromIso)) ? String(opts.fromIso) : null;
  const to = opts?.toIso && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.toIso)) ? String(opts.toIso) : null;
  const status = opts?.status ? String(opts.status) : null;
  const limit = Math.max(1, Math.min(MAX_ROWS, Number(opts?.limit) || 200));

  try {
    await ensureEvidenceSchema();
    const evRows = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.employee_id::text AS employee_id, e.role_key, e.type_key,
             t.label AS type_label, e.reference_kind, e.title, e.url, e.host, e.note,
             e.occurred_on, e.week_start, e.sharing_ack, e.submitted_by_user_id::text AS submitted_by_user_id,
             e.submitted_at, e.status, e.reviewed_at, e.reviewed_by_name, e.review_reason, e.outcome
        FROM eims_evidence e
        LEFT JOIN eims_evidence_types t
               ON t.role_key = e.role_key AND t.type_key = e.type_key
       WHERE e.employee_id = ${employeeId}::uuid
         AND (${from}::date IS NULL OR e.occurred_on >= ${from}::date)
         AND (${to}::date IS NULL OR e.occurred_on <= ${to}::date)
         AND (${status}::text IS NULL OR e.status = ${status}::text)
       ORDER BY e.occurred_on DESC, e.submitted_at DESC
       LIMIT ${limit}`));
    if (!evRows.length) return [];

    const ids = evRows.map((r: any) => String(r.id));
    const linkRows = rows(await db.execute(sql`
      SELECT id::text AS id, evidence_id::text AS evidence_id, activity_kind, activity_id,
             activity_label, hours_claimed, hours_verified, week_start
        FROM eims_evidence_links
       WHERE evidence_id::text IN (SELECT x FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x))
       ORDER BY created_at ASC`)).map(mapLink);

    return evRows.map((r: any) => mapEvidence(r, linkRows));
  } catch (e: any) {
    logFail('listEvidenceForEmployee', e);
    return [];
  }
}

export interface EvidenceRead {
  /** False ONLY when the read failed. An empty list with ok:true means nothing has been filed. */
  ok: boolean;
  evidence: EvidenceRow[];
}

/**
 * THE SAME READ, SAYING WHETHER IT WORKED.
 *
 * listEvidenceForEmployee() above answers [] for BOTH "nothing has been filed" and "the table could
 * not be read", and those are the two cases a surface must never confuse. On an intern's own record
 * the difference is the difference between "you have filed no evidence for this" and "we could not
 * load your evidence": the first is a fact about them, the second is a fact about us, and printing
 * the second as the first is the defect this phase exists to remove. On the advisory layer it is
 * worse still - a signal that fires on "no evidence" computed from a failed read is an accusation
 * manufactured out of an outage.
 *
 * src/lib/eims-anomaly.ts had to work around the ambiguity locally, re-running a confirmation query
 * after every empty result. That is the kind of workaround which exists once per caller until one
 * caller forgets, so the distinction is answered HERE, by the module that owns the table.
 */
export async function readEvidenceForEmployee(
  employeeId: string,
  opts?: ListEvidenceOptions,
): Promise<EvidenceRead> {
  if (!isUuid(employeeId)) return { ok: false, evidence: [] };
  const evidence = await listEvidenceForEmployee(employeeId, opts);
  if (evidence.length) return { ok: true, evidence };
  // Empty. Confirm the table is readable, so emptiness is a finding rather than a guess.
  try {
    await db.execute(sql`SELECT 1 FROM eims_evidence WHERE employee_id = ${employeeId}::uuid LIMIT 1`);
    return { ok: true, evidence: [] };
  } catch (e: any) {
    logFail('readEvidenceForEmployee confirm', e);
    return { ok: false, evidence: [] };
  }
}

export interface EvidenceChain {
  evidence: EvidenceRow | null;
  reviews: ReviewRow[];
  /** The sentence that answers "why were these hours recognised", built from rows only. */
  sentence: string;
}

/**
 * THE WHOLE CHAIN FOR ONE PIECE OF EVIDENCE: the intern, the activities, the link, every verdict ever
 * given on it, and the outcome recorded with the last one.
 *
 * This is the function a completion record, an audit, or a student querying their own hours reads.
 * Every sentence it returns is assembled from stored rows; none of it is recomputed and none of it is
 * inferred.
 */
export async function evidenceChain(evidenceId: string): Promise<EvidenceChain> {
  const empty: EvidenceChain = { evidence: null, reviews: [], sentence: '' };
  if (!isUuid(evidenceId)) return empty;
  try {
    await ensureEvidenceSchema();
    const r = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.employee_id::text AS employee_id, e.role_key, e.type_key,
             t.label AS type_label, e.reference_kind, e.title, e.url, e.host, e.note,
             e.occurred_on, e.week_start, e.sharing_ack, e.submitted_by_user_id::text AS submitted_by_user_id,
             e.submitted_at, e.status, e.reviewed_at, e.reviewed_by_name, e.review_reason, e.outcome
        FROM eims_evidence e
        LEFT JOIN eims_evidence_types t
               ON t.role_key = e.role_key AND t.type_key = e.type_key
       WHERE e.id = ${evidenceId}::uuid LIMIT 1`))[0];
    if (!r) return empty;

    const links = rows(await db.execute(sql`
      SELECT id::text AS id, evidence_id::text AS evidence_id, activity_kind, activity_id,
             activity_label, hours_claimed, hours_verified, week_start
        FROM eims_evidence_links WHERE evidence_id = ${evidenceId}::uuid
       ORDER BY created_at ASC`)).map(mapLink);

    const reviews: ReviewRow[] = rows(await db.execute(sql`
      SELECT id::text AS id, evidence_id::text AS evidence_id, reviewer_name, reviewer_via, verdict,
             reason, outcome, hours_verified, evidence_url, created_at
        FROM eims_evidence_reviews WHERE evidence_id = ${evidenceId}::uuid
       ORDER BY created_at DESC`)).map((x: any) => ({
      id: String(x.id),
      evidenceId: String(x.evidence_id),
      reviewerName: x.reviewer_name ? String(x.reviewer_name) : null,
      reviewerVia: x.reviewer_via ? String(x.reviewer_via) : null,
      verdict: String(x.verdict),
      reason: x.reason ? String(x.reason) : null,
      outcome: x.outcome ? String(x.outcome) : null,
      hoursVerified: round2(num(x.hours_verified)),
      evidenceUrl: x.evidence_url ? String(x.evidence_url) : null,
      createdAt: stamp(x.created_at),
    }));

    const evidence = mapEvidence(r, links);
    const latest = reviews[0] || null;
    const activityWords = links.map((l) => l.activityLabel || ACTIVITY_KIND_LABELS[l.activityKind as ActivityKind] || 'an activity');

    let sentence: string;
    if (!latest) {
      sentence = evidence.hoursClaimed + ' hours are reported against ' + activityWords.join(', ')
        + ', evidenced by "' + evidence.title + '", and nobody has reviewed it yet. No hours are '
        + 'recognised until a mentor verifies them.';
    } else if (latest.verdict === 'accepted') {
      sentence = evidence.hoursVerified + ' of the ' + evidence.hoursClaimed + ' hours reported against '
        + activityWords.join(', ') + ' were verified by ' + (latest.reviewerName || 'the recorded mentor')
        + ' on ' + iso(latest.createdAt) + ', against "' + evidence.title + '" at ' + evidence.url + '.'
        + (latest.outcome ? ' Outcome recorded: ' + latest.outcome : '');
    } else {
      sentence = 'No hours are recognised from this evidence. '
        + (latest.reviewerName || 'The reviewer') + ' recorded "' + VERDICT_LABELS[latest.verdict as Verdict]
        + '" on ' + iso(latest.createdAt) + ' with this reason: ' + (latest.reason || 'none recorded')
        + '. The ' + evidence.hoursClaimed + ' hours reported stay on the record, unrecognised.';
    }

    return { evidence, reviews, sentence };
  } catch (e: any) {
    logFail('evidenceChain', e);
    return empty;
  }
}

// =================================================================================================
// THE ROLLUP — VERIFIED HOURS, AND THE CEILING
// =================================================================================================

export interface WeekHours {
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  /** What the intern reported, whatever it came to. Recorded, always. */
  claimed: number;
  /** What a mentor accepted against evidence. The only authoritative figure. */
  verified: number;
  /** The ceiling in force for this week, or null when the engagement records none. */
  ceiling: number | null;
  /** verified, capped at the ceiling. This is what may be recognised. */
  recognised: number;
  /** verified minus recognised: real, recorded, and not recognised. Never silently dropped. */
  aboveCeiling: number;
  /** Still waiting on a mentor. Not verified and not refused. */
  awaiting: number;
  /** How many evidence items sit behind each figure. */
  itemsTotal: number;
  itemsAwaiting: number;
  /** A sentence that says which number is which, so no screen has to invent one. */
  sentence: string;
}

/**
 * VERIFIED HOURS FOR ONE WEEK, AND WHAT MAY BE RECOGNISED FROM THEM.
 *
 * THE CEILING IS A CEILING, NOT A TARGET. 40 hours a week is the most that may be recognised, and
 * holistic fitness is inside it, never added on top. Where verified hours exceed it, the excess is
 * returned as `aboveCeiling` rather than dropped: the person did the work and the record says so; it
 * simply is not recognised. That is the difference between capping recognition and rewriting
 * somebody's history.
 *
 * The ceiling comes from the engagement, through requiredWeeklyHours() in credit-week.ts, which reads
 * hr_employees.weekly_hours first and the published policy second. A part-time intern recorded at 20
 * hours is capped at 20, not at 40.
 */
export async function verifiedHoursForWeek(
  employeeId: string,
  weekStartIso: string,
  opts?: { ceiling?: number | null },
): Promise<WeekHours> {
  const weekStart = weekStartOf(iso(weekStartIso)) || iso(weekStartIso);
  const blank: WeekHours = {
    employeeId, weekStart, weekEnd: weekEndOf(weekStart),
    claimed: 0, verified: 0, ceiling: null, recognised: 0, aboveCeiling: 0, awaiting: 0,
    itemsTotal: 0, itemsAwaiting: 0,
    sentence: 'No evidence has been filed for this week, so no hours are recognised for it.',
  };
  if (!isUuid(employeeId) || !weekStart) return blank;

  try {
    await ensureEvidenceSchema();
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(l.hours_claimed), 0) AS claimed,
             COALESCE(SUM(l.hours_verified), 0) AS verified,
             COALESCE(SUM(CASE WHEN e.status = 'submitted' THEN l.hours_claimed ELSE 0 END), 0) AS awaiting,
             COUNT(DISTINCT e.id) AS items,
             COUNT(DISTINCT CASE WHEN e.status = 'submitted' THEN e.id END) AS items_awaiting
        FROM eims_evidence_links l
        JOIN eims_evidence e ON e.id = l.evidence_id
       WHERE l.employee_id = ${employeeId}::uuid
         AND l.week_start = ${weekStart}::date`))[0];

    const claimed = round2(num(r?.claimed));
    const verified = round2(num(r?.verified));
    const awaiting = round2(num(r?.awaiting));

    let ceiling: number | null = null;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'ceiling')) {
      const c = Number(opts.ceiling);
      ceiling = Number.isFinite(c) && c > 0 ? c : null;
    } else {
      const required = await requiredHoursFor(employeeId);
      ceiling = required.applicable ? required.hours : null;
    }

    const recognised = ceiling == null ? verified : round2(Math.min(verified, ceiling));
    const aboveCeiling = round2(Math.max(0, verified - recognised));

    const parts = [
      'Reported ' + claimed + ' hours.',
      'Verified ' + verified + '.',
      ceiling == null
        ? 'No weekly ceiling is recorded for this engagement, so no cap has been applied and the '
          + 'verified figure stands as it is.'
        : 'Recognised ' + recognised + ' against a ' + ceiling + '-hour ceiling'
          + (aboveCeiling > 0
            ? ', with ' + aboveCeiling + ' hours recorded above it and not recognised.'
            : '.'),
    ];
    if (awaiting > 0) parts.push(awaiting + ' hours are still waiting on a mentor and are not counted anywhere yet.');

    return {
      employeeId, weekStart, weekEnd: weekEndOf(weekStart),
      claimed, verified, ceiling, recognised, aboveCeiling, awaiting,
      itemsTotal: Number(r?.items || 0),
      itemsAwaiting: Number(r?.items_awaiting || 0),
      sentence: parts.join(' '),
    };
  } catch (e: any) {
    logFail('verifiedHoursForWeek', e);
    return blank;
  }
}

/**
 * VERIFIED HOURS FOR ONE ACTIVITY. The sum of what mentors accepted on the evidence attached to it.
 *
 * THIS IS THE EVIDENCE SIDE OF THE FIGURE, and it is what bridgeToActivityLedger() sends to the
 * activity ledger after an accept. The hour of record itself is employee_tasks.verified_hours, and
 * it is written by verifyActivity() and by nothing else. The two are not a second number: this is
 * the sum of the per-evidence shares that JUSTIFY the figure on the activity, which is exactly what
 * "why were these hours recognised" has to be able to name.
 */
export async function verifiedHoursForActivity(
  employeeId: string,
  activityKind: ActivityKind,
  activityId: string | null,
): Promise<{ claimed: number; verified: number; items: number }> {
  const none = { claimed: 0, verified: 0, items: 0 };
  if (!isUuid(employeeId) || !isActivityKind(activityKind)) return none;
  const id = activityId ? String(activityId) : '';
  try {
    await ensureEvidenceSchema();
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(hours_claimed), 0) AS claimed,
             COALESCE(SUM(hours_verified), 0) AS verified,
             COUNT(*) AS items
        FROM eims_evidence_links
       WHERE employee_id = ${employeeId}::uuid
         AND activity_kind = ${activityKind}
         AND COALESCE(activity_id, '') = ${id}`))[0];
    return {
      claimed: round2(num(r?.claimed)),
      verified: round2(num(r?.verified)),
      items: Number(r?.items || 0),
    };
  } catch (e: any) {
    logFail('verifiedHoursForActivity', e);
    return none;
  }
}

/** The engagement's required/ceiling hours, read tolerantly. weekly_hours may not exist yet. */
async function requiredHoursFor(employeeId: string): Promise<RequiredHours> {
  const unknown: RequiredHours = {
    applicable: false, hours: null, daysPerWeek: null,
    basis: 'The employee record could not be read, so no weekly figure is known.',
    policy: null as any,
  };
  if (!isUuid(employeeId)) return unknown;
  let r: any = null;
  try {
    r = rows(await db.execute(sql`
      SELECT full_name, designation, employment_type, weekly_hours
        FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
  } catch (e: any) {
    // weekly_hours may not exist on a database where no engagement terms have ever been saved.
    // Degrade to "unknown contract", never to a failed read — an unrecorded contract is exactly the
    // case this phase exists to make visible.
    logFail('requiredHoursFor weekly_hours', e);
    try {
      r = rows(await db.execute(sql`
        SELECT full_name, designation, employment_type, NULL AS weekly_hours
          FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    } catch (e2: any) {
      logFail('requiredHoursFor', e2);
      return unknown;
    }
  }
  if (!r) return unknown;
  const weekly = r.weekly_hours == null ? null : Number(r.weekly_hours);
  return requiredWeeklyHours({
    employmentType: r.employment_type,
    designation: r.designation,
    recordedWeeklyHours: Number.isFinite(weekly as number) ? weekly : null,
  });
}

// =================================================================================================
// ADVISORY ONLY — SENTENCES FOR A HUMAN, NEVER A VERDICT
// =================================================================================================

export interface AdvisoryInput {
  hoursClaimed: number;
  hoursAllocated?: number | null;
  weekVerified?: number | null;
  weekCeiling?: number | null;
  sharingAck?: boolean;
  referenceKind?: ReferenceKind;
  /** Days between the work happening and the evidence being filed. */
  filedAfterDays?: number | null;
  activityCount?: number;
}

/**
 * WHAT A MENTOR MIGHT WANT TO LOOK AT. PURE, AND WIRED TO NOTHING THAT WRITES.
 *
 * Every sentence here is an observation with a request attached, and the request is always the same
 * one: a mentor should look. There is no vocabulary in this function for dishonesty, no score, no
 * flag that persists, and no path from any of it to an hour being reduced. Nothing calls this before
 * a write and nothing stores its output as a finding.
 *
 * This is the whole of what "AI advisory" is allowed to mean here: pointing, never deciding.
 */
export function advisoryNotes(input: AdvisoryInput): string[] {
  const out: string[] = [];
  const claimed = num(input?.hoursClaimed);
  const allocated = input?.hoursAllocated == null ? null : num(input.hoursAllocated);

  if (allocated != null && allocated > 0 && claimed > allocated) {
    out.push('Reported ' + round2(claimed) + ' hours against an allocation of ' + round2(allocated)
      + '. Potential discrepancy — mentor review required. An over-run is often the honest answer; '
      + 'it is recorded either way and recognised only if you verify it.');
  }
  if (input?.weekVerified != null && input?.weekCeiling != null
      && num(input.weekVerified) + claimed > num(input.weekCeiling)) {
    out.push('Verifying this in full would take the week past its ' + round2(num(input.weekCeiling))
      + '-hour ceiling. Hours above the ceiling stay recorded and are not recognised. Mentor review '
      + 'required before verifying.');
  }
  if (input?.referenceKind === 'drive' && !input?.sharingAck) {
    out.push('The submitter did not confirm this Drive file is shared as "Anyone with the link". If it '
      + 'does not open for you, ask them to reshare it rather than rejecting the work.');
  }
  if (input?.filedAfterDays != null && num(input.filedAfterDays) > 14) {
    out.push('This was filed ' + Math.round(num(input.filedAfterDays)) + ' days after the day it says '
      + 'the work happened. Potential discrepancy — mentor review required.');
  }
  if (num(input?.activityCount) === 0) {
    out.push('This evidence is not attached to any activity, so it cannot support any hours.');
  }
  return out;
}

// =================================================================================================
// THE MENTOR'S QUEUE AND DASHBOARD
// =================================================================================================

export interface QueueItem {
  evidence: EvidenceRow;
  internName: string;
  /** Days it has been waiting. The queue is ordered by this, oldest first. */
  waitingDays: number;
  advisories: string[];
}

export interface InternHours {
  required: number | null;
  requiredBasis: string;
  allocated: number | null;
  allocatedNote: string;
  claimed: number;
  verified: number;
  recognised: number;
  aboveCeiling: number;
  awaiting: number;
  outstanding: number | null;
}

export interface InternWork {
  assigned: number;
  completed: number;
  inProgress: number;
  overdue: number;
}

export interface InternEvidence {
  submitted: number;
  pending: number;
  accepted: number;
  revisionRequired: number;
  rejected: number;
  flagged: number;
  /** Days in the week with no evidence at all. Not an accusation: a gap somebody should look at. */
  daysWithout: number;
}

export interface InternCard {
  person: RosterEntry;
  hours: InternHours;
  work: InternWork;
  evidence: InternEvidence;
  learningHours: number;
  holisticHours: number;
  /** Higher is more at risk. Ordering only — never shown as a score about a person. */
  riskScore: number;
  /** Plain sentences naming what is actually wrong. This is what a mentor acts on. */
  risks: string[];
}

export interface MentorDashboard {
  ok: boolean;
  graphReady: boolean;
  weekStart: string;
  weekEnd: string;
  sentence: string;
  interns: InternCard[];
  queue: QueueItem[];
  error: string;
}

/**
 * EVERYTHING ONE MENTOR NEEDS, FOR THE WEEK, WITH THE QUEUE FIRST IN IMPORTANCE.
 *
 * THE QUEUE IS THE PRODUCT. A dashboard nobody can act from is a report, and a report about people's
 * hours that nobody acts on is worse than nothing, because it looks like oversight. So every number
 * on this screen has something to press beside it, and the list of interns is ordered by who needs
 * attention rather than alphabetically.
 *
 * WHAT IS HONESTLY UNKNOWN SAYS SO. Allocated hours belong to the activity ledger; where the
 * allocation column does not exist yet, `allocated` is null and `allocatedNote` says why, rather than
 * a zero that reads as "nothing was planned".
 */
export async function mentorDashboard(userId: string, weekStartIso?: string | null): Promise<MentorDashboard> {
  const today = isoDate(new Date());
  const weekStart = weekStartOf(iso(weekStartIso) || today) || weekStartOf(today);
  const weekEnd = weekEndOf(weekStart);

  const empty: MentorDashboard = {
    ok: false, graphReady: false, weekStart, weekEnd, sentence: '', interns: [], queue: [], error: '',
  };

  const roster = await mentorRoster(userId);
  if (!roster.graphReady || !roster.people.length) {
    return { ...empty, ok: true, graphReady: roster.graphReady, sentence: roster.sentence };
  }

  const ids = roster.people.map((p) => String(p.employeeId)).filter((x) => isUuid(x));
  const idsJson = JSON.stringify(ids);

  try {
    await ensureEvidenceSchema();

    // ------------------------------------------------------------------------------------------
    // EVIDENCE AND HOURS FOR THE WEEK, PER PERSON. One grouped read rather than one per intern.
    // ------------------------------------------------------------------------------------------
    const hoursRows = rows(await db.execute(sql`
      SELECT l.employee_id::text AS employee_id,
             COALESCE(SUM(l.hours_claimed), 0) AS claimed,
             COALESCE(SUM(l.hours_verified), 0) AS verified,
             COALESCE(SUM(CASE WHEN e.status = 'submitted' THEN l.hours_claimed ELSE 0 END), 0) AS awaiting,
             COALESCE(SUM(CASE WHEN l.activity_kind = 'learning' THEN l.hours_verified ELSE 0 END), 0) AS learning,
             COALESCE(SUM(CASE WHEN l.activity_kind = 'holistic' THEN l.hours_verified ELSE 0 END), 0) AS holistic
        FROM eims_evidence_links l
        JOIN eims_evidence e ON e.id = l.evidence_id
       WHERE l.week_start = ${weekStart}::date
         AND l.employee_id::text IN (SELECT x FROM jsonb_array_elements_text(${idsJson}::jsonb) AS t(x))
       GROUP BY l.employee_id`));

    const statusRows = rows(await db.execute(sql`
      SELECT employee_id::text AS employee_id, status,
             COUNT(*) AS n, COUNT(DISTINCT occurred_on) AS days
        FROM eims_evidence
       WHERE week_start = ${weekStart}::date
         AND employee_id::text IN (SELECT x FROM jsonb_array_elements_text(${idsJson}::jsonb) AS t(x))
       GROUP BY employee_id, status`));

    // ------------------------------------------------------------------------------------------
    // THE WORK. employee_tasks is the one task table in this codebase and it stays that way; this
    // reads it, it does not extend it. Its own try/catch: an intern whose evidence loads but whose
    // task counts do not is a degraded card, not a blank screen.
    // ------------------------------------------------------------------------------------------
    let taskRows: any[] = [];
    try {
      taskRows = rows(await db.execute(sql`
        SELECT employee_id::text AS employee_id, status, due_on
          FROM employee_tasks
         WHERE employee_id::text IN (SELECT x FROM jsonb_array_elements_text(${idsJson}::jsonb) AS t(x))
         LIMIT ${MAX_ROWS * 4}`));
    } catch (e: any) {
      logFail('mentorDashboard tasks', e);
    }

    // Allocated hours belong to the activity ledger. Asked for tolerantly, because the column exists
    // only where that pass has run; a missing column must read as "not recorded", never as zero.
    const allocatedBy = new Map<string, number>();
    let allocationKnown = false;
    try {
      const alloc = rows(await db.execute(sql`
        SELECT employee_id::text AS employee_id, COALESCE(SUM(allocated_hours), 0) AS allocated
          FROM employee_tasks
         WHERE employee_id::text IN (SELECT x FROM jsonb_array_elements_text(${idsJson}::jsonb) AS t(x))
           AND due_on >= ${weekStart}::date AND due_on <= ${weekEnd}::date
         GROUP BY employee_id`));
      allocationKnown = true;
      for (const a of alloc) allocatedBy.set(String(a.employee_id), round2(num(a.allocated)));
    } catch (e: any) {
      logFail('mentorDashboard allocated_hours (not recorded yet)', e);
    }

    const byId = <T,>(list: any[], key: string): Map<string, T[]> => {
      const m = new Map<string, T[]>();
      for (const row of list) {
        const k = String(row[key] || '');
        if (!m.has(k)) m.set(k, []);
        (m.get(k) as T[]).push(row);
      }
      return m;
    };

    const hoursById = new Map<string, any>();
    for (const h of hoursRows) hoursById.set(String(h.employee_id), h);
    const statusById = byId<any>(statusRows, 'employee_id');
    const tasksById = byId<any>(taskRows, 'employee_id');

    const cards: InternCard[] = [];
    for (const person of roster.people) {
      const id = String(person.employeeId);
      const h = hoursById.get(id);
      const claimed = round2(num(h?.claimed));
      const verified = round2(num(h?.verified));
      const awaiting = round2(num(h?.awaiting));

      const required = await requiredHoursFor(id);
      const ceiling = required.applicable ? required.hours : null;
      const recognised = ceiling == null ? verified : round2(Math.min(verified, ceiling));
      const aboveCeiling = round2(Math.max(0, verified - recognised));
      const outstanding = ceiling == null ? null : round2(Math.max(0, ceiling - recognised));

      const st = statusById.get(id) || [];
      const countOf = (s: string) => st.filter((x: any) => String(x.status) === s)
        .reduce((n: number, x: any) => n + Number(x.n || 0), 0);
      const daysCovered = st.reduce((n: number, x: any) => Math.max(n, Number(x.days || 0)), 0);

      const ev: InternEvidence = {
        submitted: st.reduce((n: number, x: any) => n + Number(x.n || 0), 0),
        pending: countOf('submitted'),
        accepted: countOf('accepted'),
        revisionRequired: countOf('revision_required'),
        rejected: countOf('rejected'),
        flagged: countOf('flagged'),
        daysWithout: Math.max(0, 7 - daysCovered),
      };

      const tasks = tasksById.get(id) || [];
      const work: InternWork = { assigned: 0, completed: 0, inProgress: 0, overdue: 0 };
      for (const t of tasks) {
        const status = canonicalStatus(t.status) || 'assigned';
        const closed = CLOSED_STATUSES.indexOf(status as any) >= 0;
        if (status === 'completed') work.completed += 1;
        if (!closed) {
          work.assigned += 1;
          if (status === 'in_progress' || status === 'under_review') work.inProgress += 1;
          const due = iso(t.due_on);
          if (due && due < today) work.overdue += 1;
        }
      }

      const risks: string[] = [];
      let riskScore = 0;
      if (ev.pending > 0) {
        risks.push(ev.pending + (ev.pending === 1 ? ' piece' : ' pieces') + ' of evidence waiting on you.');
        riskScore += ev.pending * 3;
      }
      if (outstanding != null && outstanding > 0) {
        risks.push(outstanding + ' hours of the ' + ceiling + ' this week are not yet verified.');
        riskScore += Math.min(20, outstanding);
      }
      if (work.overdue > 0) {
        risks.push(work.overdue + ' piece' + (work.overdue === 1 ? '' : 's') + ' of work past its date.');
        riskScore += work.overdue * 4;
      }
      if (ev.revisionRequired > 0) {
        risks.push(ev.revisionRequired + ' waiting on a revision you asked for.');
        riskScore += ev.revisionRequired * 2;
      }
      if (ev.submitted === 0) {
        risks.push('No evidence filed for this week at all.');
        riskScore += 25;
      }
      if (aboveCeiling > 0) {
        risks.push(aboveCeiling + ' verified hours are above the weekly ceiling: recorded, not recognised.');
        riskScore += 2;
      }
      if (!required.applicable) {
        risks.push(required.basis);
      }

      cards.push({
        person,
        hours: {
          required: ceiling,
          requiredBasis: required.basis,
          allocated: allocationKnown ? round2(allocatedBy.get(id) || 0) : null,
          allocatedNote: allocationKnown
            ? 'Allocated hours on work due this week.'
            : 'Allocation is not recorded on this database yet, so there is nothing to compare against. '
              + 'This is shown as unknown rather than as zero.',
          claimed, verified, recognised, aboveCeiling, awaiting, outstanding,
        },
        work,
        evidence: ev,
        learningHours: round2(num(h?.learning)),
        holisticHours: round2(num(h?.holistic)),
        riskScore,
        risks,
      });
    }

    // AT RISK FIRST. Ordering only, and every card carries the sentences that produced its position,
    // so nobody is ever shown a rank without its reasons.
    cards.sort((a, b) => (b.riskScore - a.riskScore)
      || String(a.person.fullName || '').localeCompare(String(b.person.fullName || '')));

    const queue = await pendingVerificationQueue(userId, roster.people);

    return {
      ok: true,
      graphReady: true,
      weekStart,
      weekEnd,
      sentence: roster.sentence,
      interns: cards,
      queue,
      error: '',
    };
  } catch (e: any) {
    logFail('mentorDashboard', e);
    return { ...empty, graphReady: true, error: 'Some of this could not be read just now. Nothing was changed.' };
  }
}

/**
 * WHAT IS WAITING ON THIS MENTOR, OLDEST FIRST.
 *
 * THE LIST IS NOT THE PERMISSION. recordVerdict() re-asks mayVerify() at the write, so an id posted
 * from somebody else's queue is refused by the engine rather than by this list not containing it.
 */
export async function pendingVerificationQueue(userId: string, known?: RosterEntry[]): Promise<QueueItem[]> {
  const people = known && known.length ? known : (await mentorRoster(userId)).people;
  const ids = people.map((p) => String(p.employeeId)).filter((x) => isUuid(x));
  if (!ids.length) return [];

  const nameById = new Map<string, string>();
  for (const p of people) nameById.set(String(p.employeeId), String(p.fullName || 'This intern'));

  try {
    await ensureEvidenceSchema();
    const evRows = rows(await db.execute(sql`
      SELECT e.id::text AS id, e.employee_id::text AS employee_id, e.role_key, e.type_key,
             t.label AS type_label, e.reference_kind, e.title, e.url, e.host, e.note,
             e.occurred_on, e.week_start, e.sharing_ack, e.submitted_by_user_id::text AS submitted_by_user_id,
             e.submitted_at, e.status, e.reviewed_at, e.reviewed_by_name, e.review_reason, e.outcome
        FROM eims_evidence e
        LEFT JOIN eims_evidence_types t
               ON t.role_key = e.role_key AND t.type_key = e.type_key
       WHERE e.status = 'submitted'
         AND e.employee_id::text IN (SELECT x FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS q(x))
       ORDER BY e.submitted_at ASC
       LIMIT ${MAX_ROWS}`));
    if (!evRows.length) return [];

    const evIds = evRows.map((r: any) => String(r.id));
    const linkRows = rows(await db.execute(sql`
      SELECT id::text AS id, evidence_id::text AS evidence_id, activity_kind, activity_id,
             activity_label, hours_claimed, hours_verified, week_start
        FROM eims_evidence_links
       WHERE evidence_id::text IN (SELECT x FROM jsonb_array_elements_text(${JSON.stringify(evIds)}::jsonb) AS q(x))
       ORDER BY created_at ASC`)).map(mapLink);

    const now = Date.now();
    const out: QueueItem[] = [];
    for (const r of evRows) {
      const evidence = mapEvidence(r, linkRows);
      const submitted = evidence.submittedAt ? Date.parse(evidence.submittedAt) : now;
      const waitingDays = Math.max(0, Math.floor((now - submitted) / 86400000));
      const occurred = Date.parse(evidence.occurredOn + 'T00:00:00.000Z');
      out.push({
        evidence,
        internName: nameById.get(evidence.employeeId) || 'This intern',
        waitingDays,
        advisories: advisoryNotes({
          hoursClaimed: evidence.hoursClaimed,
          hoursAllocated: null,
          sharingAck: evidence.sharingAck,
          referenceKind: evidence.referenceKind,
          filedAfterDays: Number.isFinite(occurred) ? Math.floor((submitted - occurred) / 86400000) : null,
          activityCount: evidence.links.length,
        }),
      });
    }
    return out;
  } catch (e: any) {
    logFail('pendingVerificationQueue', e);
    return [];
  }
}
