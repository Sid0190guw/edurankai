// src/lib/interview-feedback.ts — STRUCTURED INTERVIEW FEEDBACK, AND WHO IS ON THE PANEL.
//
// =================================================================================================
// WHAT ALREADY EXISTED, AND IS THEREFORE NOT REBUILT HERE
// =================================================================================================
//
//   `interview_rounds`      created by a hand-run migration; read and written by
//                           src/pages/api/interviews/schedule.ts and /admin/interviews.
//   `interview_scorecards`  one row per (interview, interviewer): four 1-5 scores, a recommendation,
//                           strengths, concerns and private notes, with a UNIQUE(interview_id,
//                           interviewer_id). Written by /admin/interviews/[id]/scorecard.astro.
//
// NEITHER IS RE-DECLARED IN THIS FILE, AND THAT IS A DELIBERATE REFUSAL. Their DDL lives in a
// gitignored migration this repository does not carry, so a `CREATE TABLE IF NOT EXISTS` written from
// memory would be a SECOND SHAPE for an existing table — the exact fault class that silently breaks
// every write for whichever module loses the race. On a database where those tables are absent, the
// readers below return empty and the console says the interview tables are not present. An honest
// empty state beats a table nobody agreed the shape of.
//
// THE SUBMIT FORM IS NOT DUPLICATED EITHER. /admin/interviews/[id]/scorecard.astro already writes a
// scorecard correctly, one per interviewer, upserting on the unique index. A second writer against
// one table is how two surfaces start disagreeing, so the feedback console LINKS to that page rather
// than reimplementing it.
//
// =================================================================================================
// WHAT WAS MISSING, AND IS WHAT THIS FILE ADDS
// =================================================================================================
//
//   1. A HIRING-TEAM VIEW. Scorecards existed but there was no screen that put every interviewer's
//      card for a candidate side by side, so a hiring decision was made by opening one page per
//      interviewer or by not reading them at all.
//   2. WHO SHOULD BE ON THE PANEL, RESOLVED FROM THE ORGANIZATION GRAPH. Interviewer ids were a JSONB
//      array somebody typed. This module resolves a suggested panel from the graph's `reviewer`
//      relationship and records HOW each member got there.
//
// =================================================================================================
// THE RULE THIS FILE EXISTS TO HOLD: A REVIEWER IS A RELATIONSHIP, NEVER A ROLE NAME
// =================================================================================================
//
// resolvePanelFromOrgGraph() reads org edges through src/lib/org-graph.ts's own exported API and
// nothing else. It does not look at users.role, it does not treat `reviewer` the ROLE as `reviewer`
// the RELATIONSHIP, and it has no fallback that guesses a panel from job titles. Where the graph
// cannot answer, it says so:
//
//     isInitialized() === false                  -> "the graph has no data yet" (the ORDINARY first
//                                                   state, until the founder runs the backfill)
//     initialized, no department head recorded   -> "no head recorded for this department"
//     initialized, head but no reviewer edges    -> "no reviewer relationship recorded"
//
// Three different sentences, because they are three different facts and a screen that collapses them
// tells somebody their organisation is empty when it is merely unfinished.
//
// A GUESSED PANEL WOULD LOOK EXACTLY LIKE A RESOLVED ONE, which is precisely why guessing is refused.
//
// =================================================================================================
// VISIBILITY
// =================================================================================================
//
// Feedback is HIRING TEAM ONLY. The surfaces that read this module gate on `applications.score` —
// the capability that already means "record evaluations and scores against an application", held by
// super_admin, hr, recruiter, reviewer and department_head. That is the same population that can
// reach /admin/interviews today (middleware's `interviews` section plus the page's own gate), so no
// new capability is invented and nobody gains or loses sight of a scorecard.
//
// A CANDIDATE NEVER SEES ANY OF IT. No function here is called from any applicant-facing surface,
// and none of them returns a rejection reason, an internal note or a reviewer comment to one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
// `WHERE id::text = ANY(${jsArray}::text[])` IS THE BUG src/lib/pg-array.ts WAS WRITTEN ABOUT.
// postgres-js serialises a JS array as a RECORD literal, so Postgres answers "cannot cast type
// record to text[]" and the statement never runs. Here it sat inside the catch below, so the ONE
// path that resolves an interview panel from the Organization Graph threw the moment it found a
// reviewer relationship, and the screen was told "The Organization Graph could not be read just
// now" — an accusation against the graph for a fault in this line. The suggestion has therefore
// never worked on any database that has reviewer edges recorded.
import { uuidIn } from '@/lib/pg-array';
import { logAudit } from '@/lib/audit';
import {
  isInitialized,
  getDepartmentHead,
  getRelationshipHistory,
  employeeIdForUser,
  type OrgPerson,
} from '@/lib/org-graph';

// Declared before every use — `const` is not hoisted.
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function why(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// -------------------------------------------------------------------------------------------------
// VOCABULARY
// -------------------------------------------------------------------------------------------------

/** The five dimensions a scorecard records, matching the columns the existing form writes. */
export const SCORECARD_DIMENSIONS = [
  { key: 'technical_score', label: 'Technical skill' },
  { key: 'communication_score', label: 'Communication' },
  { key: 'problem_solving_score', label: 'Problem solving' },
  { key: 'culture_score', label: 'Ways of working' },
] as const;

export const RECOMMENDATION_LABELS = [
  { key: 'strong_hire', label: 'Strong hire' },
  { key: 'hire', label: 'Hire' },
  { key: 'no_hire', label: 'No hire' },
  { key: 'strong_no_hire', label: 'Strong no hire' },
] as const;

export function recommendationLabel(key: string | null): string {
  if (!key) return 'Not recorded';
  const hit = RECOMMENDATION_LABELS.find((r) => r.key === key);
  return hit ? hit.label : 'Not recorded';
}

/** How a panel member came to be on the panel. Recorded, never inferred at read time. */
export const PANEL_SOURCES = ['org_graph_reviewer', 'named'] as const;
export type PanelSource = (typeof PANEL_SOURCES)[number];

export function panelSourceLabel(key: string): string {
  return key === 'org_graph_reviewer' ? 'Organization Graph reviewer' : 'Named by the hiring team';
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — ONE new table, and only because nothing records panel PROVENANCE today
// -------------------------------------------------------------------------------------------------

/**
 * `interview_panel_assignments` complements `interview_rounds.interviewer_ids` rather than replacing
 * it: the JSONB array says WHO, and this table says HOW THEY GOT THERE and WHO PUT THEM THERE.
 * assignPanelMember() writes both, so the existing scheduling and scorecard pages keep working
 * unchanged off the array they already read.
 *
 * Grepped before writing: no table of this name exists anywhere in src/, db/ or the hand-run
 * migrations. It is NOT `interview_panel_scores`, which belongs to the separate manual-interview
 * module and is keyed on manual_interviews.id.
 */
export function ensurePanelSchema(): Promise<void> {
  return ensureOnce('interview_panel_assignments_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS interview_panel_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id UUID NOT NULL,
      interviewer_user_id UUID NOT NULL,
      interviewer_employee_id UUID,
      interviewer_name VARCHAR(200),
      resolved_via VARCHAR(30) NOT NULL DEFAULT 'named',
      assigned_by_user_id UUID,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ipa_member_uq ON interview_panel_assignments(interview_id, interviewer_user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS ipa_interview_idx ON interview_panel_assignments(interview_id)`);
  });
}

// -------------------------------------------------------------------------------------------------
// PANEL RESOLUTION — FROM THE GRAPH, OR AN HONEST SENTENCE
// -------------------------------------------------------------------------------------------------

export interface PanelSuggestion {
  /** Does the Organization Graph contain anything at all? False is the ordinary pre-backfill state. */
  graphInitialized: boolean;
  /** The department the application named, resolved to a departments.id. Null when unmatched. */
  departmentId: string | null;
  departmentName: string | null;
  /** The recorded head of that department, from a department_head EDGE — never from a role name. */
  head: OrgPerson | null;
  /** Employees holding an in-force `reviewer` edge over the head. May be empty; that is an answer. */
  reviewers: { employeeId: string; userId: string | null; fullName: string; designation: string | null }[];
  /** The sentence a screen shows when `reviewers` is empty. Never a guess, always a reason. */
  note: string;
}

/** Is this edge in force right now? The graph's own half-open convention: from <= now < to. */
function edgeInForce(edge: { status: string; effectiveFrom: string | null; effectiveTo: string | null }): boolean {
  if (edge.status !== 'active') return false;
  const now = Date.now();
  const from = edge.effectiveFrom ? Date.parse(edge.effectiveFrom) : NaN;
  const to = edge.effectiveTo ? Date.parse(edge.effectiveTo) : NaN;
  if (!isNaN(from) && from > now) return false;
  if (!isNaN(to) && to <= now) return false;
  return true;
}

/**
 * Suggest an interview panel for an application, from the Organization Graph.
 *
 * THE CHAIN OF FACTS, each one refusable:
 *   application -> department name -> departments.id -> department_head EDGE -> the head's
 *   in-force `reviewer` edges -> those people.
 *
 * Reading the reviewers through getRelationshipHistory() rather than by writing a fresh query
 * against org_relationships is deliberate: the graph module owns that table, and a second query
 * written from outside it is the drift the graph exists to prevent. The in-force filter below is
 * applied in TypeScript to the edges that module returns, using its own documented half-open
 * boundary.
 *
 * A CANDIDATE IS NOT AN EMPLOYEE, so there is no `reviewer` edge pointing at them and none is
 * invented. The panel is resolved around the DEPARTMENT DOING THE HIRING, which is the only thing
 * the graph can honestly answer about a person who does not work here yet.
 */
export async function resolvePanelFromOrgGraph(applicationId: string): Promise<PanelSuggestion> {
  const base: PanelSuggestion = {
    graphInitialized: false,
    departmentId: null,
    departmentName: null,
    head: null,
    reviewers: [],
    note: 'The Organization Graph has not been initialized yet, so no reviewer relationship can be read. Name the panel explicitly until the graph is backfilled.',
  };
  if (!isUuid(applicationId)) return base;

  try {
    const initialized = await isInitialized();
    base.graphInitialized = initialized;
    if (!initialized) return base;

    const app = rows(await db.execute(sql`
      SELECT department_snapshot FROM applications WHERE id = ${applicationId}::uuid LIMIT 1`));
    const deptName = app.length ? String((app[0] as any).department_snapshot || '').trim() : '';
    base.departmentName = deptName || null;
    if (!deptName) {
      base.note = 'This application does not name a department, so no department head can be resolved. Name the panel explicitly.';
      return base;
    }

    // departments.id is a varchar(50) SLUG in schema.ts and a UUID in db/hr-schema.sql, so it is
    // matched and carried as TEXT throughout and never cast ::uuid.
    const dept = rows(await db.execute(sql`
      SELECT id::text AS id, name FROM departments WHERE lower(name) = ${deptName.toLowerCase()} LIMIT 1`));
    if (!dept.length) {
      base.note = 'The department named on this application ("' + deptName + '") does not match a department record, so no head can be resolved. Name the panel explicitly.';
      return base;
    }
    const departmentId = String((dept[0] as any).id);
    base.departmentId = departmentId;

    const head = await getDepartmentHead(departmentId);
    base.head = head;
    if (!head || !head.employeeId) {
      base.note = 'No department head is recorded in the Organization Graph for this department, so no reviewer relationship can be followed. Record the head, or name the panel explicitly.';
      return base;
    }

    const edges = await getRelationshipHistory(head.employeeId);
    const reviewerIds = edges
      .filter((e) => e.type === 'reviewer' && e.objectEmployeeId === head.employeeId && edgeInForce(e))
      .map((e) => e.subjectEmployeeId)
      .filter((id): id is string => !!id && isUuid(id));

    if (!reviewerIds.length) {
      base.note = 'No in-force reviewer relationship is recorded for the head of this department. Name the panel explicitly; nobody has been guessed from a job title.';
      return base;
    }

    const people = rows(await db.execute(sql`
      SELECT id::text AS employee_id, user_id::text AS user_id, full_name, designation
        FROM hr_employees
       WHERE id IN ${uuidIn(reviewerIds)}
       ORDER BY full_name ASC`));
    base.reviewers = people.map((p: any) => ({
      employeeId: String(p.employee_id),
      userId: p.user_id ? String(p.user_id) : null,
      fullName: String(p.full_name || 'Unnamed record'),
      designation: p.designation ? String(p.designation) : null,
    }));
    base.note = base.reviewers.length
      ? 'Resolved from the Organization Graph: people holding an in-force reviewer relationship over the head of this department.'
      : 'A reviewer relationship exists but the matching employee records could not be read. Name the panel explicitly.';
    return base;
  } catch (e: any) {
    console.error('[interview-feedback] resolvePanelFromOrgGraph failed:', why(e));
    base.note = 'The Organization Graph could not be read just now, so no panel has been suggested. Name the panel explicitly.';
    return base;
  }
}

// -------------------------------------------------------------------------------------------------
// PANEL WRITES
// -------------------------------------------------------------------------------------------------

export type WriteResult = { ok: true; message?: string } | { ok: false; error: string };

export interface AssignPanelInput {
  interviewId: string;
  interviewerUserId: string;
  interviewerName?: string | null;
  resolvedVia: PanelSource;
  actorUserId: string;
}

/**
 * Put somebody on an interview panel.
 *
 * TWO WRITES, AND THE SECOND ONE IS WHY THE EXISTING PAGES KEEP WORKING: the provenance row, and
 * then `interview_rounds.interviewer_ids`, which /admin/interviews and the scorecard page already
 * read. Keeping the array in step is what stops this module from becoming a parallel truth.
 *
 * The array update is guarded separately: on a database with no `interview_rounds` table the
 * provenance row is still worth having, and the caller is told which half landed.
 */
export async function assignPanelMember(input: AssignPanelInput): Promise<WriteResult> {
  const interviewId = String(input?.interviewId || '').trim();
  const interviewerUserId = String(input?.interviewerUserId || '').trim();
  const actorUserId = String(input?.actorUserId || '').trim();
  if (!isUuid(interviewId)) return { ok: false, error: 'That interview could not be found.' };
  if (!isUuid(interviewerUserId)) return { ok: false, error: 'Pick an interviewer with a real account.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to change a panel.' };
  const resolvedVia: PanelSource = input?.resolvedVia === 'org_graph_reviewer' ? 'org_graph_reviewer' : 'named';
  const name = input?.interviewerName ? String(input.interviewerName).slice(0, 200) : null;

  try {
    await ensurePanelSchema();

    const employeeId = await employeeIdForUser(interviewerUserId);

    await db.execute(sql`
      INSERT INTO interview_panel_assignments
        (interview_id, interviewer_user_id, interviewer_employee_id, interviewer_name, resolved_via, assigned_by_user_id)
      VALUES
        (${interviewId}::uuid, ${interviewerUserId}::uuid, ${employeeId}::uuid, ${name}, ${resolvedVia}, ${actorUserId}::uuid)
      ON CONFLICT (interview_id, interviewer_user_id) DO UPDATE
        SET interviewer_employee_id = EXCLUDED.interviewer_employee_id,
            interviewer_name = COALESCE(EXCLUDED.interviewer_name, interview_panel_assignments.interviewer_name),
            resolved_via = EXCLUDED.resolved_via`);

    let arraySynced = true;
    try {
      // Idempotent: only appends when the id is not already in the array.
      await db.execute(sql`
        UPDATE interview_rounds
           SET interviewer_ids = COALESCE(interviewer_ids, '[]'::jsonb) || ${JSON.stringify([interviewerUserId])}::jsonb,
               updated_at = NOW()
         WHERE id = ${interviewId}::uuid
           AND NOT (COALESCE(interviewer_ids, '[]'::jsonb) @> ${JSON.stringify([interviewerUserId])}::jsonb)`);
    } catch (e: any) {
      arraySynced = false;
      console.error('[interview-feedback] interviewer_ids sync failed:', why(e));
    }

    await logAudit({
      userId: actorUserId,
      action: 'interview.panel.assign',
      entity: 'interview_round',
      entityId: interviewId,
      diff: { interviewerUserId, resolvedVia, arraySynced },
    });

    return {
      ok: true,
      message: arraySynced
        ? 'Added to the panel.'
        : 'Added to the panel, but the interview record could not be updated. The scheduling screen may not show them yet.',
    };
  } catch (e: any) {
    const reason = why(e);
    console.error('[interview-feedback] assignPanelMember failed:', reason);
    return { ok: false, error: 'The panel was not changed: ' + reason };
  }
}

/** Take somebody off a panel. The provenance row goes; their submitted scorecard does NOT. */
export async function removePanelMember(interviewId: string, interviewerUserId: string, actorUserId: string): Promise<WriteResult> {
  if (!isUuid(interviewId) || !isUuid(interviewerUserId)) return { ok: false, error: 'That panel member could not be found.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to change a panel.' };
  try {
    await ensurePanelSchema();
    await db.execute(sql`
      DELETE FROM interview_panel_assignments
       WHERE interview_id = ${interviewId}::uuid AND interviewer_user_id = ${interviewerUserId}::uuid`);
    await logAudit({
      userId: actorUserId,
      action: 'interview.panel.remove',
      entity: 'interview_round',
      entityId: interviewId,
      diff: { interviewerUserId },
    });
    // The scorecard they already submitted stays. Feedback that was given is evidence, and removing
    // somebody from a panel does not un-say what they observed.
    return { ok: true, message: 'Removed from the panel. Any feedback they already submitted is kept.' };
  } catch (e: any) {
    const reason = why(e);
    console.error('[interview-feedback] removePanelMember failed:', reason);
    return { ok: false, error: 'The panel was not changed: ' + reason };
  }
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

export interface InterviewSummary {
  id: string;
  applicationId: string | null;
  applicationNumber: string | null;
  candidateName: string;
  roleTitle: string | null;
  roundNumber: number;
  roundType: string | null;
  title: string | null;
  scheduledAt: string | null;
  status: string | null;
  scorecardCount: number;
  panelCount: number;
  finalRecommendation: string | null;
}

/**
 * Interviews that have, or are waiting on, feedback.
 *
 * `tablesPresent: false` is the honest answer on a database where the interview tables were never
 * created — it is NOT an empty list dressed up as "no interviews yet".
 */
export async function listInterviewsForFeedback(
  filter: 'awaiting' | 'submitted' | 'all' = 'awaiting',
  limit = 100,
): Promise<{ tablesPresent: boolean; interviews: InterviewSummary[]; error: string | null }> {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 300);
  try {
    await ensurePanelSchema();
    const r = await db.execute(sql`
      SELECT ir.id, ir.application_id, ir.round_number, ir.round_type, ir.title,
             ir.scheduled_at, ir.status, ir.final_recommendation,
             a.application_number, a.first_name, a.last_name, a.role_title_snapshot,
             (SELECT COUNT(*)::int FROM interview_scorecards sc WHERE sc.interview_id = ir.id) AS scorecard_count,
             (SELECT COUNT(*)::int FROM interview_panel_assignments pa WHERE pa.interview_id = ir.id) AS panel_count
        FROM interview_rounds ir
        LEFT JOIN applications a ON a.id = ir.application_id
       ORDER BY ir.scheduled_at DESC NULLS LAST
       LIMIT ${capped}`);
    const all = rows(r).map((x: any): InterviewSummary => ({
      id: String(x.id),
      applicationId: x.application_id ? String(x.application_id) : null,
      applicationNumber: x.application_number ? String(x.application_number) : null,
      candidateName: ((String(x.first_name || '') + ' ' + String(x.last_name || '')).trim()) || 'Candidate',
      roleTitle: x.role_title_snapshot ? String(x.role_title_snapshot) : null,
      roundNumber: Number(x.round_number || 1),
      roundType: x.round_type ? String(x.round_type) : null,
      title: x.title ? String(x.title) : null,
      scheduledAt: x.scheduled_at ? new Date(x.scheduled_at).toISOString() : null,
      status: x.status ? String(x.status) : null,
      scorecardCount: Number(x.scorecard_count || 0),
      panelCount: Number(x.panel_count || 0),
      finalRecommendation: x.final_recommendation ? String(x.final_recommendation) : null,
    }));
    const interviews =
      filter === 'awaiting' ? all.filter((i) => i.scorecardCount === 0)
      : filter === 'submitted' ? all.filter((i) => i.scorecardCount > 0)
      : all;
    return { tablesPresent: true, interviews, error: null };
  } catch (e: any) {
    const reason = why(e);
    console.error('[interview-feedback] listInterviewsForFeedback failed:', reason);
    return { tablesPresent: false, interviews: [], error: reason };
  }
}

export interface ScorecardRow {
  interviewerId: string;
  interviewerName: string;
  technical: number | null;
  communication: number | null;
  problemSolving: number | null;
  culture: number | null;
  overall: number | null;
  recommendation: string | null;
  strengths: string | null;
  weaknesses: string | null;
  notes: string | null;
  submittedAt: string | null;
}

export interface PanelMemberRow {
  interviewerUserId: string;
  interviewerName: string;
  resolvedVia: string;
  hasSubmitted: boolean;
}

export interface FeedbackBundle {
  tablesPresent: boolean;
  interview: any | null;
  panel: PanelMemberRow[];
  scorecards: ScorecardRow[];
  suggestion: PanelSuggestion | null;
  error: string | null;
}

/**
 * Everything the hiring team needs for one interview, in one call.
 *
 * The panel list is the union of the provenance rows and anybody who has actually submitted a
 * scorecard — somebody who gave feedback is on the panel whether or not a row says so, and hiding
 * their card because of a missing assignment would lose the one thing this screen exists to show.
 */
export async function getFeedbackBundle(interviewId: string): Promise<FeedbackBundle> {
  const empty: FeedbackBundle = { tablesPresent: false, interview: null, panel: [], scorecards: [], suggestion: null, error: null };
  if (!isUuid(interviewId)) return empty;
  try {
    await ensurePanelSchema();

    const ir = rows(await db.execute(sql`
      SELECT ir.*, a.first_name, a.last_name, a.email AS candidate_email,
             a.application_number, a.role_title_snapshot, a.department_snapshot, a.status AS application_status
        FROM interview_rounds ir
        LEFT JOIN applications a ON a.id = ir.application_id
       WHERE ir.id = ${interviewId}::uuid
       LIMIT 1`));
    if (!ir.length) return { ...empty, tablesPresent: true, error: null };
    const interview = ir[0] as any;

    const cards = rows(await db.execute(sql`
      SELECT sc.*, u.name AS interviewer_name
        FROM interview_scorecards sc
        LEFT JOIN users u ON u.id = sc.interviewer_id
       WHERE sc.interview_id = ${interviewId}::uuid
       ORDER BY sc.submitted_at ASC NULLS LAST`));

    const scorecards: ScorecardRow[] = cards.map((c: any) => ({
      interviewerId: String(c.interviewer_id || ''),
      interviewerName: c.interviewer_name ? String(c.interviewer_name) : 'Interviewer',
      technical: c.technical_score === null || c.technical_score === undefined ? null : Number(c.technical_score),
      communication: c.communication_score === null || c.communication_score === undefined ? null : Number(c.communication_score),
      problemSolving: c.problem_solving_score === null || c.problem_solving_score === undefined ? null : Number(c.problem_solving_score),
      culture: c.culture_score === null || c.culture_score === undefined ? null : Number(c.culture_score),
      overall: c.overall_score === null || c.overall_score === undefined ? null : Number(c.overall_score),
      recommendation: c.recommendation ? String(c.recommendation) : null,
      strengths: c.strengths ? String(c.strengths) : null,
      weaknesses: c.weaknesses ? String(c.weaknesses) : null,
      notes: c.notes ? String(c.notes) : null,
      submittedAt: c.submitted_at ? new Date(c.submitted_at).toISOString() : null,
    }));

    const assigned = rows(await db.execute(sql`
      SELECT pa.interviewer_user_id, pa.resolved_via,
             COALESCE(pa.interviewer_name, u.name) AS interviewer_name
        FROM interview_panel_assignments pa
        LEFT JOIN users u ON u.id = pa.interviewer_user_id
       WHERE pa.interview_id = ${interviewId}::uuid
       ORDER BY pa.assigned_at ASC`));

    const submitted = new Set(scorecards.map((s) => s.interviewerId));
    const panel: PanelMemberRow[] = assigned.map((p: any) => ({
      interviewerUserId: String(p.interviewer_user_id),
      interviewerName: p.interviewer_name ? String(p.interviewer_name) : 'Interviewer',
      resolvedVia: String(p.resolved_via || 'named'),
      hasSubmitted: submitted.has(String(p.interviewer_user_id)),
    }));
    const known = new Set(panel.map((p) => p.interviewerUserId));
    for (const s of scorecards) {
      if (s.interviewerId && !known.has(s.interviewerId)) {
        panel.push({
          interviewerUserId: s.interviewerId,
          interviewerName: s.interviewerName,
          resolvedVia: 'named',
          hasSubmitted: true,
        });
      }
    }

    const suggestion = interview.application_id ? await resolvePanelFromOrgGraph(String(interview.application_id)) : null;

    return { tablesPresent: true, interview, panel, scorecards, suggestion, error: null };
  } catch (e: any) {
    const reason = why(e);
    console.error('[interview-feedback] getFeedbackBundle failed:', reason);
    return { ...empty, error: reason };
  }
}

/**
 * People who can be named to a panel: active internal accounts.
 *
 * The list is NOT a permission check and must never be read as one — whether somebody may open a
 * scorecard is decided by the gate on the page, not by appearing here. Applicants are excluded
 * because a candidate cannot interview anybody.
 */
export async function assignableInterviewers(q?: string | null): Promise<{ id: string; name: string; email: string }[]> {
  const term = q ? String(q).trim().toLowerCase().slice(0, 60) : '';
  const like = term ? '%' + term + '%' : null;
  try {
    const r = await db.execute(sql`
      SELECT id, name, email FROM users
       WHERE is_active = true
         AND role <> 'applicant'
         AND (${like}::text IS NULL OR lower(name) LIKE ${like}::text OR lower(email) LIKE ${like}::text)
       ORDER BY name ASC
       LIMIT 100`);
    return rows(r).map((u: any) => ({ id: String(u.id), name: String(u.name || u.email || 'Account'), email: String(u.email || '') }));
  } catch (e: any) {
    console.error('[interview-feedback] assignableInterviewers failed:', why(e));
    return [];
  }
}
