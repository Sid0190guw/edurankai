// src/lib/eims-outcomes.ts — LEARNING OUTCOMES for the internship: what an intern was meant to be
// able to do, what they actually did against it, and the evidence that says so.
//
// =================================================================================================
// WHY THIS FILE EXISTS
// =================================================================================================
//
// Nothing in this codebase could say what an internship was FOR. hr_learning_assignments records
// that a course was assigned; employee_tasks records that a piece of work was asked for and marked
// done; hr_reviews records a rating out of five with a free-text note. None of them answers the only
// question an accredited partner actually asks: WHICH CAPABILITIES DID THIS PERSON DEMONSTRATE, AND
// WHAT IS THE EVIDENCE?
//
// So: an OUTCOME is a statement of capability. ANY ACTIVITY MAY MAP TO ONE OR MORE OUTCOMES, and one
// outcome is normally reached through several activities. The mapping is a table, not a column,
// because a column would make it one-to-one and the truth is many-to-many.
//
// =================================================================================================
// THE ONE RULE THAT DECIDES THE SHAPE OF EVERY TYPE BELOW
// =================================================================================================
//
// AN OUTCOME WITH NO EVIDENCE READS AS UNCOVERED. NOT AS ZERO.
//
// Those are different facts and a screen that renders them the same way is lying to whoever reads
// it. "Zero" says we measured and found nothing. "Uncovered" says we did not measure, and it is
// usually OUR gap rather than the intern's — nobody mapped an activity, or the evidence was never
// recorded. So:
//
//   - `verifiedHours` is `number | null`, and it is NULL when nothing was verified. It is never 0.
//   - `state` carries 'uncovered' as its own value, and `covered` is false there.
//   - Every coverage row carries a `statement` — the sentence a screen prints — and the uncovered
//     sentence says out loud that this is an absence of evidence rather than a score.
//
// A summariser that reduced an uncovered outcome to 0 would flow straight into the credit engine and
// out onto a document somebody hands to a university. That is why the null is structural.
//
// =================================================================================================
// WHAT THIS FILE DOES NOT DO
// =================================================================================================
//
//   - IT NEVER READS hr_attendance. Not once. Coverage is what the person DID, and being logged in
//     is not doing. There is no query here that could be pointed at a clock without rewriting the
//     module.
//   - IT NEVER INVENTS AN HOUR, AND IT HAS EXACTLY ONE SOURCE FOR ONE. Hours come from the activity
//     ledger — the allocated_hours / reported_hours / verified_hours columns on employee_tasks that
//     src/lib/eims-activity.ts owns — and from nowhere else. hr_learning_assignments,
//     hr_daily_reports and project_deliverables carry no hours at all, so an activity from one of
//     them contributes EVIDENCE and never a number. eims_evidence_links carries hours_verified of
//     its own and IT IS DELIBERATELY NOT SUMMED HERE: an evidence item and the activity it supports
//     would otherwise both report the same hour, which is the two-numbers defect this whole phase
//     exists to remove. Evidence proves; the activity ledger counts.
//   - WHERE A COLUMN IS NOT THERE YET, THE FIGURE IS NULL AND THE REPORT SAYS SO. The activity
//     columns are added at runtime by another module's ensure, so every read of them falls back to a
//     read without them rather than throwing — and the fallback is NAMED in the source notes.
//   - IT NEVER DECIDES. A mentor assessment is a person's judgement, recorded with their name
//     against it. Where the machine notices something — a mentor assessment against an outcome with
//     no evidence behind it, for instance — it is emitted as an ADVISORY worded as a finding for a
//     human, never as a verdict about a person.
//
// EduRankAI is the technology platform. This module computes coverage and holds the evidence behind
// it; an accredited partner awards the credential. Nothing here confers a qualification.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Never r.rows[0]; every read goes through rows().
//   - The real Postgres reason is on e.cause. Logged as e?.cause?.message || e?.message, every time.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. Every writer returns whether it wrote, and why not.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard, additive, CREATE TABLE IF NOT EXISTS
//     and ADD COLUMN IF NOT EXISTS, never a DROP. New columns need a NEW ensureOnce key: a spent key
//     never re-runs, so a column added under the old one would never appear on a booted environment.
//   - Relationships come from src/lib/org-graph.ts, never from users.role.
//   - Every const is declared before the function that reads it. const is not hoisted.

// Resolved LAZILY. A top-level db import makes src/lib/db throw DATABASE_URL is not set the moment
// any importer loads, which puts every pure function in this module — and in anything that imports
// it — out of reach of a test that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { can } from '@/lib/auth/permissions';
import { logAudit } from '@/lib/audit';
import { getMentor, isReportingManager, isResponsibleFor, employeeIdForUser } from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// HELPERS AND CONSTANTS — all declared above every function that reads them.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a plain array, never a { rows } object. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-outcomes] ' + tag, e?.cause?.message || e?.message);

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

/** Bounds on every read in this file. A cohort screen pages; it does not widen these. */
const MAX_OUTCOMES = 200;
const MAX_LINKS = 2000;
const MAX_ROWS_PER_SOURCE = 500;

/**
 * THE PROGRAMME KEY. Outcomes belong to a programme, because an outcome set is exactly the thing
 * that differs between one partner institution's internship and another's. A single shared
 * catalogue would force every programme to be measured against one institution's expectations.
 *
 * '' is not allowed; the fallback key is used where no programme has been named yet, so that early
 * rows are still findable rather than scattered across empty strings.
 */
export const DEFAULT_PROGRAMME_KEY = 'default';

export const programmeKeyOf = (v: unknown): string => {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
  return s || DEFAULT_PROGRAMME_KEY;
};

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY. Declared once, so nobody invents a second spelling of the same idea.
// -------------------------------------------------------------------------------------------------

export const OUTCOME_CATEGORIES = [
  'technical', 'professional', 'communication', 'research', 'ethics', 'holistic',
] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(OUTCOME_CATEGORIES);
export const isOutcomeCategory = (v: unknown): v is OutcomeCategory =>
  typeof v === 'string' && CATEGORY_SET.has(v);

export const OUTCOME_CATEGORY_LABELS: Record<OutcomeCategory, string> = {
  technical: 'Technical practice',
  professional: 'Professional conduct',
  communication: 'Communication',
  research: 'Research and independent learning',
  ethics: 'Ethics and responsible practice',
  holistic: 'Holistic development',
};

/**
 * WHERE AN ACTIVITY LIVES. An activity is not one table in this product and pretending otherwise
 * would mean building a second task list, a second learning assignment and a second project record —
 * the exact duplication src/lib/employee-tasks.ts argues against at length in its own header.
 *
 *   task        employee_tasks — THE ACTIVITY LEDGER. src/lib/eims-activity.ts added
 *               activity_type, allocated_hours, reported_hours, verified_hours and uplift_hours to
 *               it rather than creating a second task table, so this is the one source of an hour.
 *               A holistic activity is a task whose activity type is a well-being type; it is not a
 *               separate kind of thing and its hours sit INSIDE the weekly ceiling with the rest.
 *   learning    hr_learning_assignments. Progress is defined in src/lib/learning-progress.ts and
 *               nowhere else. No hours.
 *   project     project_deliverables — link_url is evidence and accepted_on is somebody accepting
 *               it. No hours.
 *   assessment  a graded attempt, matched by test id. Performance, reported beside coverage.
 *   report      hr_daily_reports — the Drive link and its review trail. No hours.
 *   evidence    an eims_evidence item mapped straight to an outcome, with no activity between them.
 *               Evidence, never an hour.
 *   other       anything recorded through the evidence graph under a kind this vocabulary does not
 *               name — a mentor session, for instance. Evidence, never an hour.
 *
 * THERE IS DELIBERATELY NO SEPARATE 'activity' MEMBER. The activity ledger IS employee_tasks, and a
 * second key pointing at one table is how two screens start disagreeing about the same row.
 */
export const ACTIVITY_SOURCES = [
  'task', 'learning', 'project', 'assessment', 'report', 'evidence', 'other',
] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

const SOURCE_SET = new Set<string>(ACTIVITY_SOURCES);
export const isActivitySource = (v: unknown): v is ActivitySource =>
  typeof v === 'string' && SOURCE_SET.has(v);

export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  task: 'Activity',
  learning: 'Learning assignment',
  project: 'Project deliverable',
  assessment: 'Assessment',
  report: 'Daily record',
  evidence: 'Evidence item',
  other: 'Other recorded activity',
};

/**
 * HOW THE EVIDENCE GRAPH NAMES AN ACTIVITY, MAPPED ONTO HOW THIS FILE DOES.
 *
 * src/lib/eims-evidence.ts records eims_evidence_links.activity_kind from its own vocabulary. The
 * translation lives HERE, once, so neither module has to know the other's spelling in more than one
 * place — and `holistic` maps to `task` because a holistic activity IS a task with a well-being
 * activity type, not a seventh kind of row.
 */
const EVIDENCE_KIND_TO_SOURCE: Record<string, ActivitySource> = {
  task: 'task',
  holistic: 'task',
  learning: 'learning',
  deliverable: 'project',
  report: 'report',
  mentor_session: 'other',
  other: 'other',
};

/**
 * HOW FAR AN OUTCOME HAS GOT. The ladder, and the first rung is the one that matters:
 *
 *   uncovered  nothing is mapped to it and nothing is recorded against it. AN ABSENCE OF EVIDENCE,
 *              which is not the same fact as a measurement of zero and must never render as one.
 *   planned    activities are mapped to it and none of them has been completed yet.
 *   reported   an activity was completed, and nobody has produced evidence for it yet.
 *   evidenced  there is an evidence reference — a Drive document, a repository link, a notebook.
 *   verified   a person checked that evidence and said it stands.
 */
export const OUTCOME_COVERAGE_STATES = [
  'uncovered', 'planned', 'reported', 'evidenced', 'verified',
] as const;
export type OutcomeCoverageState = (typeof OUTCOME_COVERAGE_STATES)[number];

export const OUTCOME_COVERAGE_LABELS: Record<OutcomeCoverageState, string> = {
  uncovered: 'Not covered',
  planned: 'Planned',
  reported: 'Reported, not yet evidenced',
  evidenced: 'Evidenced',
  verified: 'Verified',
};

/**
 * WHAT A MENTOR SAYS ABOUT AN OUTCOME. A JUDGEMENT, with a person's name against it — which is a
 * different thing from coverage, and the two are reported side by side rather than merged.
 *
 * 'not-demonstrated' IS NOT 'uncovered'. It means a person looked and formed a view. Collapsing the
 * two would turn a gap in our records into a finding against the intern.
 */
export const ATTAINMENT_LEVELS = [
  'not-demonstrated', 'developing', 'demonstrated', 'exceeded',
] as const;
export type AttainmentLevel = (typeof ATTAINMENT_LEVELS)[number];

const ATTAINMENT_SET = new Set<string>(ATTAINMENT_LEVELS);
export const isAttainmentLevel = (v: unknown): v is AttainmentLevel =>
  typeof v === 'string' && ATTAINMENT_SET.has(v);

export const ATTAINMENT_LABELS: Record<AttainmentLevel, string> = {
  'not-demonstrated': 'Not demonstrated',
  developing: 'Developing',
  demonstrated: 'Demonstrated',
  exceeded: 'Exceeded expectations',
};

/** A number for the credit engine to weigh. Deliberately NOT a mark out of anything. */
export const ATTAINMENT_FRACTION: Record<AttainmentLevel, number> = {
  'not-demonstrated': 0,
  developing: 0.5,
  demonstrated: 0.85,
  exceeded: 1,
};

/* ------------------------------------------------------------------------------------- the copy */

/** Printed wherever an uncovered outcome appears. The whole point of the module, in one sentence. */
export const UNCOVERED_SENTENCE =
  'Not covered. No activity has been mapped to this outcome and no evidence has been recorded '
  + 'against it. That is an absence of evidence, not a score of zero.';

export const NO_HOURS_SENTENCE =
  'Hours are shown only where an activity ledger recorded them as verified. A completed task is '
  + 'evidence that an outcome was worked on; it is never converted into an hour figure here.';

export const PLATFORM_ROLE_SENTENCE =
  'EduRankAI is the technology platform. It computes this coverage and holds the evidence behind '
  + 'it. An accredited partner institution awards the credential.';

export const ADVISORY_SENTENCE =
  'Advisory only. These are findings for a person to look at, never a conclusion about anybody.';

// -------------------------------------------------------------------------------------------------
// TYPES THE CONSUMERS SEE
// -------------------------------------------------------------------------------------------------

export interface Actor {
  id?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  name?: string | null;
  email?: string | null;
}

export interface OutcomeRow {
  id: string;
  programmeKey: string;
  code: string;
  statement: string;
  detail: string;
  category: OutcomeCategory;
  sortOrder: number;
  active: boolean;
  createdByUserId: string | null;
  createdAt: string | null;
}

export interface OutcomeLinkRow {
  id: string;
  outcomeId: string;
  source: ActivitySource;
  activityId: string;
  activityLabel: string;
  employeeId: string | null;
  createdByUserId: string | null;
  createdAt: string | null;
  /**
   * True where this link was DERIVED from the outcome lines recorded on the activity itself rather
   * than mapped by a person. A derived link is used exactly like a recorded one and is labelled
   * differently everywhere it is shown: "somebody decided this activity serves this outcome" and
   * "the activity's own notes name this outcome" are different claims, and a report that presents
   * the second as the first is overstating its own evidence.
   */
  derived: boolean;
}

export interface OutcomeAssessmentRow {
  id: string;
  employeeId: string;
  outcomeId: string;
  attainment: AttainmentLevel;
  comment: string;
  assessedByUserId: string | null;
  assessedByName: string;
  assessedAt: string | null;
}

/** One evidence reference. A Drive link or an external reference. NEVER an upload. */
export interface EvidenceFact {
  kind: string;
  reference: string;
  label: string;
  verified: boolean;
  verifiedOn: string | null;
}

/**
 * ONE ACTIVITY, AS COVERAGE SEES IT. Three hour figures, and each may be null on its own:
 * allocated is the plan, completed is what the intern reported, verified is what a person checked.
 * They are never merged, and `verifiedHours` is null rather than 0 where nothing was verified.
 */
export interface ActivityFact {
  source: ActivitySource;
  id: string;
  label: string;
  employeeId: string | null;
  occurredOn: string | null;
  completed: boolean;
  allocatedHours: number | null;
  completedHours: number | null;
  verifiedHours: number | null;
  /**
   * True where this activity's type is a well-being type. It changes NOTHING about how the hours are
   * treated, and that is exactly the point: holistic hours sit inside the same weekly ceiling as
   * every other hour, never beside it. The flag exists so a screen can SHOW that holistic
   * development happened, not so an engine can treat it differently.
   */
  wellbeing: boolean;
  /**
   * The free-text outcome lines recorded ON THE ACTIVITY by whoever allocated it
   * (employee_tasks.learning_outcomes, written by src/lib/eims-activity.ts).
   *
   * They exist because an allocator writes what an activity is FOR at the moment they allocate it,
   * in their own words. Left alone they would be a second, disconnected outcome system beside this
   * module's catalogue — so a line that NAMES an outcome code is turned into a derived link and the
   * two become one report. A line naming nothing is kept and shown as what it is: a note.
   */
  outcomeHints: string[];
  evidence: EvidenceFact[];
}

/** A graded attempt, kept separate from activities because performance is not coverage. */
export interface AssessmentFact {
  id: string;
  label: string;
  attempts: number;
  bestPercent: number | null;
  takenOn: string | null;
}

/** What answered, and what did not. A report never renders a silent gap as a measurement. */
export interface SourceNote {
  source: string;
  present: boolean;
  note: string;
}

export interface ActivityFactSet {
  activities: ActivityFact[];
  assessments: AssessmentFact[];
  /** Named reads that did NOT happen. Anything here means the report is incomplete, and says so. */
  unread: string[];
  sources: SourceNote[];
}

export interface OutcomeCoverage {
  outcome: OutcomeRow;
  state: OutcomeCoverageState;
  covered: boolean;
  activities: ActivityFact[];
  evidence: EvidenceFact[];
  /** null, never 0, where nothing carried an allocation. */
  allocatedHours: number | null;
  completedHours: number | null;
  verifiedHours: number | null;
  assessment: { attempts: number; bestPercent: number | null } | null;
  mentor: OutcomeAssessmentRow | null;
  /** The sentence a screen prints for this row. */
  statement: string;
  /** Findings for a human. Never a verdict. */
  advisories: string[];
}

export interface CoverageReport {
  employeeId: string;
  programmeKey: string;
  outcomes: OutcomeCoverage[];
  total: number;
  covered: number;
  uncovered: number;
  verified: number;
  /** Fraction of outcomes with at least evidence behind them. null when there are no outcomes. */
  coverageFraction: number | null;
  /** Mentor attainment averaged across ASSESSED outcomes only. null when none were assessed. */
  attainmentFraction: number | null;
  assessedCount: number;
  /**
   * EVERY activity read for this person, not only the ones mapped to an outcome.
   *
   * It is here because the hour totals on a completion record have to cover the WHOLE engagement.
   * Summing the per-outcome rows instead would silently drop every hour of work nobody got round to
   * mapping, and a total that quietly excludes unmapped work is worse than no total at all.
   */
  activities: ActivityFact[];
  unread: string[];
  sources: SourceNote[];
  advisories: string[];
  complete: boolean;
}

export interface OutcomeWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// -------------------------------------------------------------------------------------------------
// THE PURE PART. No database, so it can be read and tested without a connection — the same reason
// src/lib/credit-week.ts holds its rule apart from its ledger.
// -------------------------------------------------------------------------------------------------

const sumOrNull = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!present.length) return null;
  return round2(present.reduce((a, b) => a + b, 0));
};

/**
 * ONE OUTCOME, SUMMARISED. Pure, and the ladder it walks is the one declared above.
 *
 * A MENTOR ASSESSMENT DOES NOT MAKE AN OUTCOME COVERED. Coverage is about evidence; an assessment is
 * about judgement. Where a mentor has assessed an outcome that carries no evidence at all, the row
 * stays 'uncovered' and an ADVISORY says so — that is a gap in the record worth a person's
 * attention, and quietly promoting it to 'covered' would hide exactly the thing worth looking at.
 */
export function summariseOutcome(
  outcome: OutcomeRow,
  activities: ActivityFact[],
  mentor: OutcomeAssessmentRow | null,
  assessments: AssessmentFact[] = [],
): OutcomeCoverage {
  const evidence: EvidenceFact[] = [];
  for (const a of activities) for (const e of a.evidence) evidence.push(e);

  const anyVerified = activities.some((a) => (a.verifiedHours ?? 0) > 0)
    || evidence.some((e) => e.verified);
  const anyEvidence = evidence.length > 0;
  const anyCompleted = activities.some((a) => a.completed || (a.completedHours ?? 0) > 0);

  let state: OutcomeCoverageState;
  if (!activities.length && !anyEvidence) state = 'uncovered';
  else if (anyVerified) state = 'verified';
  else if (anyEvidence) state = 'evidenced';
  else if (anyCompleted) state = 'reported';
  else state = 'planned';

  const covered = state !== 'uncovered';

  const attempts = assessments.reduce((n, a) => n + a.attempts, 0);
  const best = assessments.reduce<number | null>((acc, a) => {
    if (a.bestPercent == null) return acc;
    return acc == null ? a.bestPercent : Math.max(acc, a.bestPercent);
  }, null);

  const advisories: string[] = [];
  if (!covered && mentor) {
    advisories.push(
      'A mentor assessment is recorded against an outcome that carries no evidence. '
      + 'Potential discrepancy: mentor review required. A person decides.',
    );
  }
  if (covered && !mentor) {
    advisories.push('Evidence exists for this outcome and no mentor has assessed it yet.');
  }

  let statement: string;
  if (state === 'uncovered') statement = UNCOVERED_SENTENCE;
  else if (state === 'planned') {
    statement = 'Planned. ' + activities.length + ' activity(ies) are mapped to this outcome and '
      + 'none has been completed yet.';
  } else if (state === 'reported') {
    statement = 'Reported. Work was completed against this outcome and no evidence reference has '
      + 'been recorded for it yet.';
  } else if (state === 'evidenced') {
    statement = 'Evidenced. ' + evidence.length + ' evidence reference(s) recorded, none of them '
      + 'verified by a person yet.';
  } else {
    statement = 'Verified. A person checked the evidence behind this outcome and recorded that it '
      + 'stands.';
  }

  return {
    outcome,
    state,
    covered,
    activities,
    evidence,
    allocatedHours: sumOrNull(activities.map((a) => a.allocatedHours)),
    completedHours: sumOrNull(activities.map((a) => a.completedHours)),
    verifiedHours: sumOrNull(activities.map((a) => a.verifiedHours)),
    assessment: assessments.length ? { attempts, bestPercent: best } : null,
    mentor,
    statement,
    advisories,
  };
}

/**
 * THE WHOLE SET, SUMMARISED. Pure.
 *
 * `coverageFraction` counts outcomes with EVIDENCE behind them ('evidenced' or 'verified'), not
 * outcomes somebody planned an activity against. A plan is not a demonstration.
 *
 * `attainmentFraction` is averaged over ASSESSED outcomes only, and is null when none were assessed.
 * Averaging an unassessed outcome in as a zero would be the same lie in a different column.
 */
export function summariseCoverage(
  employeeId: string,
  programmeKey: string,
  outcomes: OutcomeRow[],
  linksByOutcome: Map<string, OutcomeLinkRow[]>,
  facts: ActivityFactSet,
  mentorByOutcome: Map<string, OutcomeAssessmentRow>,
): CoverageReport {
  const byKey = new Map<string, ActivityFact>();
  for (const a of facts.activities) byKey.set(a.source + ':' + a.id, a);
  const assessmentById = new Map<string, AssessmentFact>();
  for (const a of facts.assessments) assessmentById.set(a.id, a);

  const list: OutcomeCoverage[] = [];
  for (const o of outcomes) {
    const links = linksByOutcome.get(o.id) || [];
    const acts: ActivityFact[] = [];
    const assess: AssessmentFact[] = [];
    for (const l of links) {
      if (l.source === 'assessment') {
        const a = assessmentById.get(l.activityId);
        if (a) assess.push(a);
        continue;
      }
      const f = byKey.get(l.source + ':' + l.activityId);
      if (f) acts.push(f);
    }
    list.push(summariseOutcome(o, acts, mentorByOutcome.get(o.id) || null, assess));
  }

  const covered = list.filter((c) => c.covered).length;
  const evidenced = list.filter((c) => c.state === 'evidenced' || c.state === 'verified').length;
  const verified = list.filter((c) => c.state === 'verified').length;
  const assessed = list.filter((c) => c.mentor);

  const attainment = assessed.length
    ? round2(assessed.reduce((n, c) => n + ATTAINMENT_FRACTION[c.mentor!.attainment], 0) / assessed.length)
    : null;

  const advisories: string[] = [];
  for (const c of list) for (const a of c.advisories) advisories.push(c.outcome.code + ': ' + a);
  if (facts.unread.length) {
    advisories.push(
      'This report is incomplete: ' + facts.unread.join(', ') + ' could not be read. '
      + 'Nothing below should be treated as a full account until that is resolved.',
    );
  }

  return {
    employeeId,
    programmeKey,
    outcomes: list,
    total: list.length,
    covered,
    uncovered: list.length - covered,
    verified,
    // NOT rounded. This fraction is multiplied by hours on the way to academic credit, so two
    // decimals is a real loss: one outcome of three stored as 0.33 instead of 0.3333... understates
    // the credit by a third of a percent, and the error compounds over a programme. Round for
    // DISPLAY at the point of display; never in the value a calculation reads.
    coverageFraction: list.length ? evidenced / list.length : null,
    attainmentFraction: attainment,
    assessedCount: assessed.length,
    activities: facts.activities,
    unread: facts.unread,
    sources: facts.sources,
    advisories,
    complete: facts.unread.length === 0,
  };
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
//
// THREE TABLES AND NOT ONE MORE. The outcome, the mapping from an activity to it, and a mentor's
// assessment of it for one person. No second task table, no second evidence table, no second report
// table: activities and their evidence stay where they already live and are REFERENCED from here.
// -------------------------------------------------------------------------------------------------

export function ensureOutcomeSchema(): Promise<void> {
  return ensureOnce('eims_outcomes_v1', async () => {
    try {
      await createOutcomeTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run from its cache so the next call
      // retries, and swallows the rejection for callers, which keeps the tolerate-missing-schema
      // behaviour every reader here is built on.
      logFail('ensureOutcomeSchema', e);
      throw e;
    }
  });
}

async function createOutcomeTables(): Promise<void> {
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_key TEXT NOT NULL DEFAULT 'default',
    code TEXT NOT NULL,
    statement TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'professional',
    sort_order INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_outcomes_prog_code
    ON eims_outcomes (programme_key, code)`);

  // THE MANY-TO-MANY. An activity may serve several outcomes and an outcome is normally reached
  // through several activities; a column on either side would force one of those to be false.
  //
  // activity_id is TEXT, not UUID, deliberately: the things it points at are a UUID today
  // (employee_tasks, project_deliverables), and a composite key tomorrow (a daily report is
  // employee + date). Storing it as text keeps this table honest about being a REFERENCE rather
  // than a foreign key into six tables at once.
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_outcome_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outcome_id UUID NOT NULL,
    source TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    activity_label TEXT NOT NULL DEFAULT '',
    employee_id UUID,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_outcome_links_key
    ON eims_outcome_links (outcome_id, source, activity_id)`);
  await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS eims_outcome_links_emp
    ON eims_outcome_links (employee_id)`);
  await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS eims_outcome_links_activity
    ON eims_outcome_links (source, activity_id)`);

  // ONE ROW PER PERSON PER OUTCOME, and it carries the assessor's name — not their role. Who may
  // write it is resolved per row from the Organization Graph at the write, never from users.role.
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_outcome_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    outcome_id UUID NOT NULL,
    attainment TEXT NOT NULL,
    comment TEXT NOT NULL,
    assessed_by_user_id UUID,
    assessed_by_name TEXT NOT NULL DEFAULT '',
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_outcome_assessments_key
    ON eims_outcome_assessments (employee_id, outcome_id)`);
}

// -------------------------------------------------------------------------------------------------
// THE CATALOGUE
// -------------------------------------------------------------------------------------------------

function mapOutcome(r: any): OutcomeRow {
  const cat = String(r.category || 'professional');
  return {
    id: String(r.id),
    programmeKey: String(r.programme_key || DEFAULT_PROGRAMME_KEY),
    code: String(r.code || ''),
    statement: String(r.statement || ''),
    detail: String(r.detail || ''),
    category: (isOutcomeCategory(cat) ? cat : 'professional'),
    sortOrder: Number(r.sort_order ?? 0),
    active: r.active !== false,
    createdByUserId: r.created_by_user_id ? String(r.created_by_user_id) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

export async function listOutcomes(
  programmeKey: string = DEFAULT_PROGRAMME_KEY,
  opts: { includeInactive?: boolean } = {},
): Promise<OutcomeRow[]> {
  const key = programmeKeyOf(programmeKey);
  try {
    await ensureOutcomeSchema();
    const r = opts.includeInactive
      ? await (await database()).execute(sql`
          SELECT * FROM eims_outcomes WHERE programme_key = ${key}
           ORDER BY sort_order ASC, code ASC LIMIT ${MAX_OUTCOMES}`)
      : await (await database()).execute(sql`
          SELECT * FROM eims_outcomes WHERE programme_key = ${key} AND active = true
           ORDER BY sort_order ASC, code ASC LIMIT ${MAX_OUTCOMES}`);
    return rows(r).map(mapOutcome);
  } catch (e: any) {
    logFail('listOutcomes', e);
    return [];
  }
}

export async function getOutcome(id: string): Promise<OutcomeRow | null> {
  if (!isUuid(id)) return null;
  try {
    await ensureOutcomeSchema();
    const r = rows(await (await database()).execute(sql`SELECT * FROM eims_outcomes WHERE id = ${id}::uuid LIMIT 1`));
    return r.length ? mapOutcome(r[0]) : null;
  } catch (e: any) {
    logFail('getOutcome', e);
    return null;
  }
}

/**
 * Create or amend an outcome.
 *
 * GATED ON `eims.outcomes.manage`, asked for with can() rather than hasPermission(): can() reads
 * PERMS_BY_ROLE alone, so it admits exactly the roles named there and never a custom role that
 * happens to hold a section checkbox of a similar name.
 *
 * NOT SWALLOWED. A failure returns ok:false with a sentence, because "Outcome saved." printed over a
 * rejected write is how a completion report ends up missing the outcome it was built around.
 */
export async function upsertOutcome(
  actor: Actor | null,
  input: {
    id?: string | null;
    programmeKey?: string;
    code: string;
    statement: string;
    detail?: string;
    category?: string;
    sortOrder?: number;
    active?: boolean;
  },
): Promise<OutcomeWriteResult> {
  if (!can(actor as any, 'eims.outcomes.manage')) {
    return { ok: false, error: 'You do not hold the desk that defines learning outcomes.' };
  }
  const code = String(input?.code || '').trim().toUpperCase().slice(0, 20);
  const statement = String(input?.statement || '').trim().slice(0, 600);
  if (!code) return { ok: false, error: 'An outcome needs a short code. Nothing was saved.' };
  if (!statement) return { ok: false, error: 'An outcome needs a statement. Nothing was saved.' };

  const key = programmeKeyOf(input?.programmeKey);
  const detail = String(input?.detail || '').trim().slice(0, 2000);
  const rawCat = String(input?.category || 'professional');
  const category: OutcomeCategory = isOutcomeCategory(rawCat) ? rawCat : 'professional';
  const sortOrder = Number.isFinite(input?.sortOrder as number) ? Number(input!.sortOrder) : 0;
  const active = input?.active !== false;
  const id = isUuid(input?.id) ? String(input!.id) : null;

  try {
    await ensureOutcomeSchema();
    let written: any[];
    if (id) {
      written = rows(await (await database()).execute(sql`
        UPDATE eims_outcomes
           SET code = ${code}, statement = ${statement}, detail = ${detail},
               category = ${category}, sort_order = ${sortOrder}, active = ${active},
               updated_at = NOW()
         WHERE id = ${id}::uuid
        RETURNING id`));
      if (!written.length) return { ok: false, error: 'That outcome no longer exists. Nothing was changed.' };
    } else {
      written = rows(await (await database()).execute(sql`
        INSERT INTO eims_outcomes
          (programme_key, code, statement, detail, category, sort_order, active, created_by_user_id)
        VALUES (${key}, ${code}, ${statement}, ${detail}, ${category}, ${sortOrder}, ${active},
                ${isUuid(actor?.id) ? String(actor!.id) : null})
        ON CONFLICT (programme_key, code) DO UPDATE
          SET statement = EXCLUDED.statement, detail = EXCLUDED.detail,
              category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
              active = EXCLUDED.active, updated_at = NOW()
        RETURNING id`));
    }
    const outId = written.length ? String(written[0].id) : undefined;
    await logAudit({
      userId: isUuid(actor?.id) ? String(actor!.id) : null,
      action: id ? 'eims.outcome.update' : 'eims.outcome.upsert',
      entity: 'eims_outcomes',
      entityId: outId,
      diff: { programmeKey: key, code, category, active },
    });
    return { ok: true, id: outId };
  } catch (e: any) {
    logFail('upsertOutcome', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * THE SEED. Eight outcomes an internship on this platform is actually run against, so a programme
 * that has never been configured still reports against something real rather than an empty list.
 *
 * HOLISTIC DEVELOPMENT IS ONE OF THEM, and that is the point: holistic well-being is INSIDE the
 * engagement, measured like everything else, never a separate course bolted on beside it.
 */
export const DEFAULT_OUTCOMES: {
  code: string; statement: string; detail: string; category: OutcomeCategory; sortOrder: number;
}[] = [
  {
    code: 'LO1', category: 'technical', sortOrder: 10,
    statement: 'Apply the technical practices of the discipline to real work in a live environment.',
    detail: 'Demonstrated through project work, deliverables accepted by the team, and the record of what was built.',
  },
  {
    code: 'LO2', category: 'technical', sortOrder: 20,
    statement: 'Break an unfamiliar problem down and carry a solution through to something that works.',
    detail: 'Demonstrated through the trail of an activity from allocation to a verified result, including what was abandoned and why.',
  },
  {
    code: 'LO3', category: 'communication', sortOrder: 30,
    statement: 'Record and explain work so that somebody who was not there can follow it.',
    detail: 'Demonstrated through daily records, written documents and the readability of the evidence references themselves.',
  },
  {
    code: 'LO4', category: 'professional', sortOrder: 40,
    statement: 'Work to a plan agreed with a mentor, and renegotiate it honestly when it stops fitting.',
    detail: 'Demonstrated through the proposed schedule, the reported effort against it, and how variance was raised.',
  },
  {
    code: 'LO5', category: 'research', sortOrder: 50,
    statement: 'Learn something new independently and put it to use in the work.',
    detail: 'Demonstrated through learning assignments, assessments, and the application of what was learned in a deliverable.',
  },
  {
    code: 'LO6', category: 'professional', sortOrder: 60,
    statement: 'Collaborate: ask for help early, give it when asked, and leave the team better informed.',
    detail: 'Demonstrated through mentor assessment, collaborator records and review comments.',
  },
  {
    code: 'LO7', category: 'ethics', sortOrder: 70,
    statement: 'Practise responsibly: handle data, credentials and other people information with care, and say when something is wrong.',
    detail: 'Demonstrated through mentor assessment and the record of how sensitive material was handled.',
  },
  {
    code: 'LO8', category: 'holistic', sortOrder: 80,
    statement: 'Sustain holistic well-being and personal development across the engagement.',
    detail: 'Physical fitness, mindfulness, reading, reflective learning, leadership development and community engagement, recorded INSIDE the weekly commitment and never as hours added on top of it.',
  },
];

export async function seedDefaultOutcomes(
  actor: Actor | null,
  programmeKey: string = DEFAULT_PROGRAMME_KEY,
): Promise<{ ok: boolean; created: number; error?: string }> {
  if (!can(actor as any, 'eims.outcomes.manage')) {
    return { ok: false, created: 0, error: 'You do not hold the desk that defines learning outcomes.' };
  }
  const key = programmeKeyOf(programmeKey);
  let created = 0;
  try {
    await ensureOutcomeSchema();
    for (const o of DEFAULT_OUTCOMES) {
      const w = rows(await (await database()).execute(sql`
        INSERT INTO eims_outcomes
          (programme_key, code, statement, detail, category, sort_order, created_by_user_id)
        VALUES (${key}, ${o.code}, ${o.statement}, ${o.detail}, ${o.category}, ${o.sortOrder},
                ${isUuid(actor?.id) ? String(actor!.id) : null})
        ON CONFLICT (programme_key, code) DO NOTHING
        RETURNING id`));
      if (w.length) created += 1;
    }
    await logAudit({
      userId: isUuid(actor?.id) ? String(actor!.id) : null,
      action: 'eims.outcome.seed',
      entity: 'eims_outcomes',
      entityId: key,
      diff: { created },
    });
    return { ok: true, created };
  } catch (e: any) {
    logFail('seedDefaultOutcomes', e);
    return { ok: false, created, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE MAPPING — any activity to one or more outcomes
// -------------------------------------------------------------------------------------------------

function mapLink(r: any): OutcomeLinkRow {
  const src = String(r.source || 'task');
  return {
    id: String(r.id),
    outcomeId: String(r.outcome_id),
    source: (isActivitySource(src) ? src : 'task'),
    activityId: String(r.activity_id || ''),
    activityLabel: String(r.activity_label || ''),
    employeeId: r.employee_id ? String(r.employee_id) : null,
    createdByUserId: r.created_by_user_id ? String(r.created_by_user_id) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    derived: false,
  };
}

/**
 * SET the outcomes an activity serves. Set semantics, not append: the caller hands the complete
 * list and the stored mapping ends up matching it, so unticking a box in a form actually removes the
 * mapping instead of leaving a stale one behind that nobody can see.
 *
 * The delete and the inserts are separate statements. If the delete succeeds and an insert fails the
 * caller is TOLD, with the count that did land, rather than being shown a success message over a
 * half-written mapping.
 */
export async function setActivityOutcomes(
  actor: Actor | null,
  activity: { source: string; id: string; label?: string; employeeId?: string | null },
  outcomeIds: string[],
): Promise<{ ok: boolean; linked: number; error?: string }> {
  if (!can(actor as any, 'eims.outcomes.manage')) {
    return { ok: false, linked: 0, error: 'You do not hold the desk that maps work to outcomes.' };
  }
  const src = String(activity?.source || '');
  if (!isActivitySource(src)) {
    return { ok: false, linked: 0, error: 'That is not an activity type this platform records.' };
  }
  const activityId = String(activity?.id || '').trim().slice(0, 120);
  if (!activityId) return { ok: false, linked: 0, error: 'That activity has no id to map.' };

  const label = String(activity?.label || '').trim().slice(0, 300);
  const employeeId = isUuid(activity?.employeeId) ? String(activity!.employeeId) : null;
  const wanted = Array.from(new Set((outcomeIds || []).filter(isUuid)));
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;

  try {
    await ensureOutcomeSchema();
    await (await database()).execute(sql`
      DELETE FROM eims_outcome_links WHERE source = ${src} AND activity_id = ${activityId}`);
    let linked = 0;
    for (const outcomeId of wanted) {
      const w = rows(await (await database()).execute(sql`
        INSERT INTO eims_outcome_links
          (outcome_id, source, activity_id, activity_label, employee_id, created_by_user_id)
        VALUES (${outcomeId}::uuid, ${src}, ${activityId}, ${label}, ${employeeId}, ${actorId})
        ON CONFLICT (outcome_id, source, activity_id) DO UPDATE
          SET activity_label = EXCLUDED.activity_label, employee_id = EXCLUDED.employee_id
        RETURNING id`));
      if (w.length) linked += 1;
    }
    await logAudit({
      userId: actorId,
      action: 'eims.outcome.map',
      entity: 'eims_outcome_links',
      entityId: src + ':' + activityId,
      diff: { outcomes: wanted.length, linked },
    });
    return { ok: true, linked };
  } catch (e: any) {
    logFail('setActivityOutcomes', e);
    return { ok: false, linked: 0, error: WRITE_FAILED };
  }
}

export async function outcomesForActivity(source: string, activityId: string): Promise<OutcomeLinkRow[]> {
  const src = String(source || '');
  const id = String(activityId || '').trim();
  if (!isActivitySource(src) || !id) return [];
  try {
    await ensureOutcomeSchema();
    return rows(await (await database()).execute(sql`
      SELECT * FROM eims_outcome_links WHERE source = ${src} AND activity_id = ${id}
       LIMIT ${MAX_LINKS}`)).map(mapLink);
  } catch (e: any) {
    logFail('outcomesForActivity', e);
    return [];
  }
}

/**
 * Every mapping that could bear on one person: the ones recorded against them by name, plus the
 * programme-wide ones recorded with no employee (a learning assignment mapped once for everybody).
 */
export async function linksForEmployee(employeeId: string, programmeKey: string): Promise<OutcomeLinkRow[]> {
  if (!isUuid(employeeId)) return [];
  const key = programmeKeyOf(programmeKey);
  try {
    await ensureOutcomeSchema();
    return rows(await (await database()).execute(sql`
      SELECT l.* FROM eims_outcome_links l
        JOIN eims_outcomes o ON o.id = l.outcome_id
       WHERE o.programme_key = ${key}
         AND (l.employee_id IS NULL OR l.employee_id = ${employeeId}::uuid)
       LIMIT ${MAX_LINKS}`)).map(mapLink);
  } catch (e: any) {
    logFail('linksForEmployee', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// MENTOR ASSESSMENT OF AN OUTCOME
// -------------------------------------------------------------------------------------------------

function mapAssessment(r: any): OutcomeAssessmentRow {
  const level = String(r.attainment || 'developing');
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    outcomeId: String(r.outcome_id),
    attainment: (isAttainmentLevel(level) ? level : 'developing'),
    comment: String(r.comment || ''),
    assessedByUserId: r.assessed_by_user_id ? String(r.assessed_by_user_id) : null,
    assessedByName: String(r.assessed_by_name || ''),
    assessedAt: r.assessed_at ? new Date(r.assessed_at).toISOString() : null,
  };
}

/**
 * WHO MAY ASSESS THIS PERSON'S OUTCOME.
 *
 * RESOLVED PER ROW FROM THE ORGANIZATION GRAPH, never from users.role: the mentor edge, the
 * reporting-manager edge, or somebody above them in the reporting chain. `employee.manage` is the
 * standing authority of the HR desk and is accepted as well, because that desk already owns the
 * completion record this assessment prints on.
 *
 * Returns a SENTENCE when the answer is no, so the surface can say which relationship is missing
 * instead of showing a blank screen — the same discipline the workflow engine uses for a halt.
 */
export async function mayAssessOutcome(
  actor: Actor | null,
  employeeId: string,
): Promise<{ may: boolean; via: string; reason: string }> {
  if (!actor?.id || actor.isActive === false) {
    return { may: false, via: 'none', reason: 'Sign in to record an assessment.' };
  }
  if (!isUuid(employeeId)) {
    return { may: false, via: 'none', reason: 'That assessment is not linked to an employee record.' };
  }
  if (can(actor as any, 'employee.manage')) {
    return { may: true, via: 'standing-authority', reason: 'HR desk standing authority.' };
  }
  try {
    const actorEmployeeId = await employeeIdForUser(String(actor.id));
    if (!actorEmployeeId) {
      return {
        may: false, via: 'none',
        reason: 'Your account is not linked to an employee record, so the organization graph cannot '
          + 'name your relationship to this person.',
      };
    }
    const mentor = await getMentor(employeeId);
    if (mentor && mentor.employeeId === actorEmployeeId) {
      return { may: true, via: 'mentor', reason: 'Recorded mentor for this person.' };
    }
    if (await isReportingManager(actorEmployeeId, employeeId)) {
      return { may: true, via: 'reporting_manager', reason: 'Reporting manager for this person.' };
    }
    if (await isResponsibleFor(actorEmployeeId, employeeId)) {
      return { may: true, via: 'reporting_chain', reason: 'Above this person in the reporting chain.' };
    }
    return {
      may: false, via: 'none',
      reason: 'The organization graph does not name you as this person mentor, reporting manager or '
        + 'senior in their reporting chain.',
    };
  } catch (e: any) {
    logFail('mayAssessOutcome', e);
    return { may: false, via: 'none', reason: 'The organization graph could not be read just now.' };
  }
}

/**
 * Record a mentor's assessment of one outcome for one person.
 *
 * A COMMENT IS REQUIRED. An attainment level on its own is a grade with nothing behind it, and this
 * record is read by an accredited partner. The write is refused without one rather than saved empty.
 */
export async function assessOutcome(
  actor: Actor | null,
  input: { employeeId: string; outcomeId: string; attainment: string; comment: string },
): Promise<OutcomeWriteResult> {
  const employeeId = String(input?.employeeId || '');
  const outcomeId = String(input?.outcomeId || '');
  if (!isUuid(employeeId) || !isUuid(outcomeId)) {
    return { ok: false, error: 'That assessment does not name a person and an outcome.' };
  }
  const level = String(input?.attainment || '');
  if (!isAttainmentLevel(level)) {
    return { ok: false, error: 'That is not an attainment level this platform records.' };
  }
  const comment = String(input?.comment || '').trim().slice(0, 2000);
  if (!comment) {
    return { ok: false, error: 'An assessment needs a written comment. Nothing was saved.' };
  }

  const allowed = await mayAssessOutcome(actor, employeeId);
  if (!allowed.may) return { ok: false, error: allowed.reason };

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  const actorName = String(actor?.name || actor?.email || '').slice(0, 200);

  try {
    await ensureOutcomeSchema();
    const w = rows(await (await database()).execute(sql`
      INSERT INTO eims_outcome_assessments
        (employee_id, outcome_id, attainment, comment, assessed_by_user_id, assessed_by_name)
      VALUES (${employeeId}::uuid, ${outcomeId}::uuid, ${level}, ${comment}, ${actorId}, ${actorName})
      ON CONFLICT (employee_id, outcome_id) DO UPDATE
        SET attainment = EXCLUDED.attainment, comment = EXCLUDED.comment,
            assessed_by_user_id = EXCLUDED.assessed_by_user_id,
            assessed_by_name = EXCLUDED.assessed_by_name,
            assessed_at = NOW(), updated_at = NOW()
      RETURNING id`));
    if (!w.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actorId,
      action: 'eims.outcome.assess',
      entity: 'eims_outcome_assessments',
      entityId: String(w[0].id),
      diff: { employeeId, outcomeId, attainment: level, via: allowed.via },
    });
    return { ok: true, id: String(w[0].id) };
  } catch (e: any) {
    logFail('assessOutcome', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function assessmentsFor(employeeId: string): Promise<OutcomeAssessmentRow[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureOutcomeSchema();
    return rows(await (await database()).execute(sql`
      SELECT * FROM eims_outcome_assessments WHERE employee_id = ${employeeId}::uuid
       LIMIT ${MAX_OUTCOMES}`)).map(mapAssessment);
  } catch (e: any) {
    logFail('assessmentsFor', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// READING WHAT ACTUALLY HAPPENED
//
// ONE SOURCE FOR AN HOUR, AND SEVERAL FOR EVIDENCE. That asymmetry is the whole design:
//
//   HOURS come from the activity ledger, which is employee_tasks carrying the allocated_hours /
//   reported_hours / verified_hours columns src/lib/eims-activity.ts owns. Nothing else in this file
//   produces a number, so there is no second figure for a screen to disagree with.
//
//   EVIDENCE comes from the evidence graph (eims_evidence + eims_evidence_links) and from the
//   reference columns that already existed before it — project_deliverables.link_url with its
//   accepted_on, and hr_daily_reports.report_url with its review trail. Those are REFERENCED, never
//   copied into a second store.
//
// eims_evidence_links CARRIES hours_verified OF ITS OWN AND IT IS NOT SUMMED HERE. An evidence item
// and the activity it supports would otherwise each report the same hour, and a completion document
// would carry two totals for one week. Evidence proves; the ledger counts.
//
// THE ACTIVITY COLUMNS ARE ADDED AT RUNTIME BY ANOTHER MODULE, so every read of them is wrapped: a
// database where that ensure has not run yet falls back to a read without them and NAMES the
// fallback in the source notes. It never throws, and it never renders "the column is not there" as
// "the intern did nothing".
//
// EACH SOURCE HAS ITS OWN try/catch AND ITS OWN ENTRY IN `unread`. One Promise.all here would mean a
// single failed read produced an empty list, which renders as "no work" against somebody's name.
// -------------------------------------------------------------------------------------------------

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : null;
};

/**
 * The outcome lines an allocator wrote on the activity itself, one per line, bounded.
 * Stored as free text by src/lib/eims-activity.ts; parsed here and nowhere else.
 */
function hintLines(raw: any): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * DERIVED LINKS: an activity's own outcome lines, matched to the catalogue by CODE.
 *
 * WHY THIS EXISTS. An allocator writes what an activity is for, in their own words, at the moment
 * they allocate it. That text and this module's catalogue are two ways of saying the same thing, and
 * two disconnected outcome systems is precisely the defect this phase is here to remove. A line
 * beginning with a code the catalogue knows ("LO3 - documented the migration") therefore counts as a
 * mapping.
 *
 * PURE, AND CONSERVATIVE. Only a leading code token matches — never a fuzzy match on the sentence,
 * which would attach work to outcomes nobody claimed. A recorded mapping always wins, so a person's
 * decision is never overwritten by a text match. Every link produced here carries `derived: true` so
 * that a screen can say which kind of claim it is.
 */
export function deriveLinksFromHints(
  outcomes: OutcomeRow[],
  activities: ActivityFact[],
  existing: OutcomeLinkRow[],
): OutcomeLinkRow[] {
  const byCode = new Map<string, OutcomeRow>();
  for (const o of outcomes) byCode.set(o.code.trim().toUpperCase(), o);

  const already = new Set<string>();
  for (const l of existing) already.add(l.outcomeId + '|' + l.source + '|' + l.activityId);

  const out: OutcomeLinkRow[] = [];
  for (const a of activities) {
    for (const line of a.outcomeHints) {
      const token = (line.match(/^[A-Za-z]{1,4}[\s-]?\d{1,3}/) || [''])[0]
        .replace(/[\s-]/g, '').toUpperCase();
      if (!token) continue;
      const o = byCode.get(token);
      if (!o) continue;
      const key = o.id + '|' + a.source + '|' + a.id;
      if (already.has(key)) continue;
      already.add(key);
      out.push({
        id: 'derived:' + key,
        outcomeId: o.id,
        source: a.source,
        activityId: a.id,
        activityLabel: a.label,
        employeeId: a.employeeId,
        createdByUserId: null,
        createdAt: null,
        derived: true,
      });
    }
  }
  return out;
}

/** Activity types marked as well-being, so a holistic activity can be recognised as one. */
async function wellbeingTypeKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT key FROM eims_activity_types WHERE wellbeing = true LIMIT 100`));
    for (const t of r) out.add(String(t.key || '').toLowerCase());
  } catch (e: any) {
    // The activity-type catalogue belongs to another module and may not exist yet. Holistic
    // activities then read as ordinary activities, which understates nothing and invents nothing.
    logFail('wellbeingTypeKeys', e);
  }
  return out;
}

/**
 * Every evidence item for one person, indexed by the activity it supports.
 *
 * VERIFIED MEANS A MENTOR ACCEPTED IT. eims_evidence.status carries the verdict vocabulary of
 * src/lib/eims-evidence.ts, in which 'accepted' is the only verdict that verifies anything —
 * 'revision_required' and 'flagged' are invitations and second looks, not findings, and neither
 * verifies nor counts against anybody.
 */
async function readEvidence(employeeId: string): Promise<{
  byActivity: Map<string, EvidenceFact[]>;
  byEvidenceId: Map<string, EvidenceFact>;
  ok: boolean;
}> {
  const byActivity = new Map<string, EvidenceFact[]>();
  const byEvidenceId = new Map<string, EvidenceFact>();
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT e.id::text AS id, e.title, e.url, e.type_key, e.status, e.reviewed_at,
             l.activity_kind, l.activity_id
        FROM eims_evidence e
        LEFT JOIN eims_evidence_links l ON l.evidence_id = e.id
       WHERE e.employee_id = ${employeeId}::uuid
       LIMIT ${MAX_ROWS_PER_SOURCE}`));
    for (const row of r) {
      const accepted = String(row.status || '') === 'accepted';
      const fact: EvidenceFact = {
        kind: String(row.type_key || 'external_reference'),
        reference: String(row.url || ''),
        label: String(row.title || 'Evidence'),
        verified: accepted,
        verifiedOn: row.reviewed_at ? new Date(row.reviewed_at).toISOString().slice(0, 10) : null,
      };
      byEvidenceId.set(String(row.id), fact);
      const kind = String(row.activity_kind || '');
      const activityId = row.activity_id ? String(row.activity_id) : '';
      if (!kind || !activityId) continue;
      const source = EVIDENCE_KIND_TO_SOURCE[kind] || 'other';
      const key = source + ':' + activityId;
      const list = byActivity.get(key) || [];
      list.push(fact);
      byActivity.set(key, list);
    }
    return { byActivity, byEvidenceId, ok: true };
  } catch (e: any) {
    // The evidence graph belongs to another module and may not exist on this environment yet.
    logFail('readEvidence', e);
    return { byActivity, byEvidenceId, ok: false };
  }
}

/**
 * THE DEFAULT READER. One person's activities, evidence and assessments, gathered from whatever this
 * environment actually has, with every source named.
 *
 * A caller with its own store can pass its own reader instead: coverage takes the FACTS, not the
 * queries, which is why the pure summariser above has no database in it.
 */
export async function readActivityFacts(
  employeeId: string,
  links: OutcomeLinkRow[],
): Promise<ActivityFactSet> {
  const out: ActivityFactSet = { activities: [], assessments: [], unread: [], sources: [] };
  if (!isUuid(employeeId)) {
    out.unread.push('the employee record');
    return out;
  }

  const idsBySource = new Map<ActivitySource, string[]>();
  for (const l of links) {
    const list = idsBySource.get(l.source) || [];
    if (list.length < MAX_ROWS_PER_SOURCE) list.push(l.activityId);
    idsBySource.set(l.source, list);
  }
  const labelByKey = new Map<string, string>();
  for (const l of links) labelByKey.set(l.source + ':' + l.activityId, l.activityLabel);

  const evidence = await readEvidence(employeeId);
  out.sources.push({
    source: 'evidence graph',
    present: evidence.ok,
    note: evidence.ok
      ? 'Evidence items and the activities they support. Their hours_verified is deliberately NOT '
        + 'summed here: the activity ledger is the only place an hour is counted.'
      : 'The evidence graph could not be read on this environment. Evidence below comes only from '
        + 'deliverable links and daily records.',
  });
  if (!evidence.ok) out.unread.push('the evidence graph');
  const evidenceFor = (key: string): EvidenceFact[] => evidence.byActivity.get(key) || [];

  // ---- the activity ledger: employee_tasks with its hour columns --------------------------------
  const wellbeingKeys = await wellbeingTypeKeys();
  let ledgerRows: any[] = [];
  let ledgerHasHours = true;
  try {
    ledgerRows = rows(await (await database()).execute(sql`
      SELECT id::text AS id, title, status, due_on, completed_at, activity_type,
             allocated_hours, reported_hours, verified_hours, verified_at, learning_outcomes
        FROM employee_tasks
       WHERE employee_id = ${employeeId}::uuid
       LIMIT ${MAX_ROWS_PER_SOURCE}`));
  } catch (e: any) {
    // The activity columns are added at runtime by src/lib/eims-activity.ts and may not be there.
    // Naming a missing column throws, so the fallback reads the task without them — and says so.
    logFail('readActivityFacts ledger columns', e);
    ledgerHasHours = false;
    try {
      ledgerRows = rows(await (await database()).execute(sql`
        SELECT id::text AS id, title, status, due_on, completed_at,
               NULL AS activity_type, NULL AS allocated_hours, NULL AS reported_hours,
               NULL AS verified_hours, NULL AS verified_at, NULL AS learning_outcomes
          FROM employee_tasks
         WHERE employee_id = ${employeeId}::uuid
         LIMIT ${MAX_ROWS_PER_SOURCE}`));
    } catch (e2: any) {
      logFail('readActivityFacts tasks', e2);
      out.unread.push('the activity ledger');
    }
  }
  for (const t of ledgerRows) {
    const id = String(t.id);
    const status = String(t.status || '').toLowerCase();
    const type = String(t.activity_type || '').toLowerCase();
    const reported = num(t.reported_hours);
    const verifiedHours = num(t.verified_hours);
    out.activities.push({
      source: 'task',
      id,
      label: String(t.title || labelByKey.get('task:' + id) || 'Activity'),
      employeeId,
      occurredOn: iso(t.completed_at || t.due_on) || null,
      completed: !!t.completed_at || (reported ?? 0) > 0 || /done|complete|verified/.test(status),
      allocatedHours: num(t.allocated_hours),
      completedHours: reported,
      verifiedHours,
      wellbeing: type ? wellbeingKeys.has(type) : false,
      outcomeHints: hintLines(t.learning_outcomes),
      evidence: evidenceFor('task:' + id),
    });
  }
  if (ledgerRows.length || ledgerHasHours) {
    out.sources.push({
      source: 'activity ledger',
      present: true,
      note: ledgerHasHours
        ? 'employee_tasks with its allocated, reported and verified hour columns. This is the only '
          + 'source of an hour figure in this report.'
        : 'employee_tasks WITHOUT its hour columns, which have not been created on this environment '
          + 'yet. Every hour figure below is therefore unknown rather than zero.',
    });
  }
  if (!ledgerHasHours) out.unread.push('the activity hour columns');

  // ---- learning assignments ---------------------------------------------------------------------
  const learningIds = (idsBySource.get('learning') || []).filter(isUuid);
  if (learningIds.length) {
    try {
      const r = rows(await (await database()).execute(sql`
        SELECT la.id::text AS id, la.status, la.due_on, c.title AS course_title
          FROM hr_learning_assignments la
          LEFT JOIN training_courses c ON c.id = la.course_id
         WHERE la.employee_id = ${employeeId}::uuid AND la.id::text = ANY(${learningIds})
         LIMIT ${MAX_ROWS_PER_SOURCE}`));
      for (const l of r) {
        const id = String(l.id);
        const status = String(l.status || '').toLowerCase();
        out.activities.push({
          source: 'learning',
          id,
          label: String(l.course_title || labelByKey.get('learning:' + id) || 'Learning assignment'),
          employeeId,
          occurredOn: iso(l.due_on) || null,
          completed: /complete|done|passed/.test(status),
          allocatedHours: null,
          completedHours: null,
          verifiedHours: null,
          wellbeing: false,
          outcomeHints: [],
          evidence: evidenceFor('learning:' + id),
        });
      }
      out.sources.push({
        source: 'learning assignments',
        present: true,
        note: 'No hours: this table has none. Progress is defined in src/lib/learning-progress.ts '
          + 'and is not recomputed here.',
      });
    } catch (e: any) {
      logFail('readActivityFacts learning', e);
      out.unread.push('learning assignments');
    }
  }

  // ---- project deliverables ----------------------------------------------------------------------
  // link_url is a reference somebody can open and accepted_on is a person accepting it, which is the
  // closest thing to evidence-and-verification that existed here before the evidence graph. It is
  // REFERENCED, not copied.
  const deliverableIds = (idsBySource.get('project') || []).filter(isUuid);
  if (deliverableIds.length) {
    try {
      const r = rows(await (await database()).execute(sql`
        SELECT id::text AS id, name, link_url, status, due_on, accepted_on
          FROM project_deliverables
         WHERE id::text = ANY(${deliverableIds})
         LIMIT ${MAX_ROWS_PER_SOURCE}`));
      for (const d of r) {
        const id = String(d.id);
        const accepted = iso(d.accepted_on);
        const ev = evidenceFor('project:' + id).slice();
        if (d.link_url) {
          ev.push({
            kind: 'deliverable-link',
            reference: String(d.link_url),
            label: String(d.name || 'Deliverable'),
            verified: !!accepted,
            verifiedOn: accepted || null,
          });
        }
        out.activities.push({
          source: 'project',
          id,
          label: String(d.name || labelByKey.get('project:' + id) || 'Deliverable'),
          employeeId,
          occurredOn: accepted || iso(d.due_on) || null,
          completed: !!accepted || /done|complete|accepted/.test(String(d.status || '').toLowerCase()),
          allocatedHours: null,
          completedHours: null,
          verifiedHours: null,
          wellbeing: false,
          outcomeHints: [],
          evidence: ev,
        });
      }
      out.sources.push({
        source: 'project deliverables',
        present: true,
        note: 'The deliverable link is the evidence and accepted_on is a person accepting it. '
          + 'No hours: this table has none.',
      });
    } catch (e: any) {
      logFail('readActivityFacts deliverables', e);
      out.unread.push('project deliverables');
    }
  }

  // ---- daily records -----------------------------------------------------------------------------
  const reportIds = (idsBySource.get('report') || []).filter(isUuid);
  if (reportIds.length) {
    try {
      const r = rows(await (await database()).execute(sql`
        SELECT id::text AS id, report_date, report_url, reviewed_at
          FROM hr_daily_reports
         WHERE employee_id = ${employeeId}::uuid AND id::text = ANY(${reportIds})
         LIMIT ${MAX_ROWS_PER_SOURCE}`));
      for (const d of r) {
        const id = String(d.id);
        const reviewed = d.reviewed_at ? new Date(d.reviewed_at).toISOString().slice(0, 10) : null;
        const ev = evidenceFor('report:' + id).slice();
        if (d.report_url) {
          ev.push({
            kind: 'daily-record',
            reference: String(d.report_url),
            label: 'Daily record ' + iso(d.report_date),
            verified: !!reviewed,
            verifiedOn: reviewed,
          });
        }
        out.activities.push({
          source: 'report',
          id,
          label: 'Daily record ' + iso(d.report_date),
          employeeId,
          occurredOn: iso(d.report_date) || null,
          completed: true,
          allocatedHours: null,
          completedHours: null,
          verifiedHours: null,
          wellbeing: false,
          outcomeHints: [],
          evidence: ev,
        });
      }
      out.sources.push({
        source: 'daily records',
        present: true,
        note: 'A filed record is evidence; a reviewed record is verified evidence. No hours.',
      });
    } catch (e: any) {
      logFail('readActivityFacts reports', e);
      out.unread.push('daily records');
    }
  }

  // ---- evidence mapped straight to an outcome, and anything under another kind ---------------------
  for (const source of ['evidence', 'other'] as ActivitySource[]) {
    for (const id of idsBySource.get(source) || []) {
      const direct = evidence.byEvidenceId.get(id);
      const linked = evidenceFor(source + ':' + id);
      const ev = direct ? [direct, ...linked] : linked;
      out.activities.push({
        source,
        id,
        label: labelByKey.get(source + ':' + id) || (direct ? direct.label : ACTIVITY_SOURCE_LABELS[source]),
        employeeId,
        occurredOn: null,
        completed: ev.length > 0,
        allocatedHours: null,
        completedHours: null,
        verifiedHours: null,
        wellbeing: false,
        outcomeHints: [],
        evidence: ev,
      });
    }
  }

  // ---- assessments ---------------------------------------------------------------------------------
  // Performance, not coverage: reported beside an outcome and never merged into it. Read against the
  // learner account behind this employee, because that is where an attempt is recorded.
  const assessmentIds = (idsBySource.get('assessment') || []).filter(isUuid);
  if (assessmentIds.length) {
    try {
      const ur = rows(await (await database()).execute(sql`
        SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
      const userId = ur?.user_id ? String(ur.user_id) : '';
      if (!userId) {
        out.sources.push({
          source: 'assessments',
          present: false,
          note: 'This employee record is not linked to a learner account, so assessment attempts '
            + 'cannot be read. That is a missing link, not a missing attempt.',
        });
      } else {
        const r = rows(await (await database()).execute(sql`
          SELECT a.test_id::text AS test_id, COUNT(*)::int AS attempts,
                 MAX(a.percentage) AS best, MAX(a.created_at) AS latest
            FROM test_attempts a
           WHERE a.candidate_id = ${userId}::uuid AND a.test_id::text = ANY(${assessmentIds})
           GROUP BY a.test_id
           LIMIT ${MAX_ROWS_PER_SOURCE}`));
        for (const a of r) {
          out.assessments.push({
            id: String(a.test_id),
            label: labelByKey.get('assessment:' + String(a.test_id)) || 'Assessment',
            attempts: Number(a.attempts ?? 0),
            bestPercent: num(a.best),
            takenOn: a.latest ? new Date(a.latest).toISOString().slice(0, 10) : null,
          });
        }
        out.sources.push({
          source: 'assessments',
          present: true,
          note: 'Best recorded percentage per assessment. Reported beside an outcome, never summed '
            + 'into its coverage.',
        });
      }
    } catch (e: any) {
      logFail('readActivityFacts assessments', e);
      out.unread.push('assessment attempts');
    }
  }

  return out;
}

export type ActivityFactReader = (
  employeeId: string,
  links: OutcomeLinkRow[],
) => Promise<ActivityFactSet>;

/**
 * THE COMPLETION REPORT FOR ONE PERSON: coverage per outcome, the evidence behind each, assessment
 * performance and the mentor's assessment.
 *
 * `reader` exists so the module that owns the activity ledger can supply its own facts without this
 * file importing it — a compile-time dependency on a table that may not exist on an environment is
 * exactly how a report starts throwing instead of reporting a gap.
 */
export async function outcomeCoverageFor(
  employeeId: string,
  opts: { programmeKey?: string; reader?: ActivityFactReader } = {},
): Promise<CoverageReport> {
  const key = programmeKeyOf(opts.programmeKey);
  const empty: CoverageReport = {
    employeeId,
    programmeKey: key,
    outcomes: [],
    total: 0,
    covered: 0,
    uncovered: 0,
    verified: 0,
    coverageFraction: null,
    attainmentFraction: null,
    assessedCount: 0,
    activities: [],
    unread: ['the outcome catalogue'],
    sources: [],
    advisories: [],
    complete: false,
  };
  if (!isUuid(employeeId)) return empty;

  let outcomes: OutcomeRow[] = [];
  try {
    outcomes = await listOutcomes(key);
  } catch (e: any) {
    logFail('outcomeCoverageFor outcomes', e);
    return empty;
  }

  const links = await linksForEmployee(employeeId, key);
  const linksByOutcome = new Map<string, OutcomeLinkRow[]>();
  for (const l of links) {
    const list = linksByOutcome.get(l.outcomeId) || [];
    list.push(l);
    linksByOutcome.set(l.outcomeId, list);
  }

  const read = opts.reader || readActivityFacts;
  let facts: ActivityFactSet;
  try {
    facts = await read(employeeId, links);
  } catch (e: any) {
    logFail('outcomeCoverageFor facts', e);
    facts = {
      activities: [], assessments: [],
      unread: ['the record of activities'],
      sources: [{ source: 'activities', present: false, note: 'Could not be read.' }],
    };
  }

  // The activity's own outcome lines, matched to the catalogue by code. Added AFTER the recorded
  // mappings so a person's decision always wins, and reported as its own source so nobody mistakes a
  // text match for somebody's judgement.
  const derived = deriveLinksFromHints(outcomes, facts.activities, links);
  for (const l of derived) {
    const list = linksByOutcome.get(l.outcomeId) || [];
    list.push(l);
    linksByOutcome.set(l.outcomeId, list);
  }
  if (derived.length) {
    facts.sources.push({
      source: 'outcome lines on activities',
      present: true,
      note: derived.length + ' activity-to-outcome link(s) were derived from the outcome lines '
        + 'recorded on the activities themselves. A derived link is shown as derived, never as a '
        + 'mapping somebody made.',
    });
  }

  const mentorByOutcome = new Map<string, OutcomeAssessmentRow>();
  for (const a of await assessmentsFor(employeeId)) mentorByOutcome.set(a.outcomeId, a);

  return summariseCoverage(employeeId, key, outcomes, linksByOutcome, facts, mentorByOutcome);
}
