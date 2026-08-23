// src/lib/hiring-decision.ts — PATCH 10: HUMAN HIRING DECISION SUPPORT.
//
// =================================================================================================
// WHAT THIS FILE IS, IN ONE SENTENCE
// =================================================================================================
//
// It assembles everything already recorded about one candidate for one role into a report a human
// reads before deciding, and it records the decision that human then makes, with their name on it.
//
// IT DECIDES NOTHING. There is no code path in this file where a computed value causes a hiring,
// rejection, hold or advance. recordFinalDecision() takes a decision as an ARGUMENT, refuses to run
// without a real actor id, and refuses to run without a written reason. The support state the report
// carries is a reading of the record; it is stored beside the decision so later readers can see what
// the deciding person was looking at, and it is never stored as the decision.
//
// =================================================================================================
// WHAT IT REBUILDS: NOTHING
// =================================================================================================
//
// Every input is read through the module that owns it. This file owns exactly one table.
//
//   ROLE REQUIREMENTS + EVIDENCE   src/lib/capability-coverage.ts — requirementsFor(), subjectFor(),
//                                  coverageFor(). Per requirement: evidenced / stated / related /
//                                  nothing / unreadable, each carrying its own evidence chain. That
//                                  module REFUSES to total those states and this one does not total
//                                  them either.
//   INTERVIEWER FEEDBACK           src/lib/interview-feedback.ts — its SCORECARD_DIMENSIONS and
//                                  RECOMMENDATION_LABELS are imported, never restated. The scorecard
//                                  rows are read here with a per-application scope that module does
//                                  not export; see the comment on readInterviewEvidence().
//   FUNNEL POSITION AND MOVEMENT   src/lib/application-stages.ts — getStageEvents() to read,
//                                  advanceStage() to move. THIS FILE NEVER WRITES applications.stage
//                                  OR applications.status. It asks that module, which owns the
//                                  column, the history table, the candidate notification and the
//                                  event emission.
//   PLATFORM ASSESSMENTS           src/lib/learning-doors.ts — passedAssessmentsFor(). Plus one
//                                  narrow count of attempts that did NOT pass, because a passed-only
//                                  view of assessment performance on a hiring screen is a biased
//                                  input. See readAssessmentEvidence().
//   ASSIGNMENTS AND WORK SAMPLES   src/lib/submissions.ts owns portal_submissions; the rows are read
//                                  here scoped to this candidate's account, with the reviewer's own
//                                  verdict carried through rather than re-derived.
//   PRIOR ADVISORY READINGS        src/lib/capability-coverage.ts — decisionsFor(), and the newest
//                                  stored match_evaluations row READ AS STORED, never recomputed.
//   WHAT MAY BE SAID ABOUT A PERSON src/lib/person-assertions.ts — protectedAttributeConcern() and
//                                  assertAllowedAboutPerson() screen every sentence that could reach
//                                  a candidate.
//
// =================================================================================================
// THE COLUMNS THIS FILE WILL NOT READ, AND WHY THE LIST IS CODE RATHER THAN A COMMENT
// =================================================================================================
//
// `applications` carries dob, birth_time and birth_place. Whatever else those fields are for, they
// are date of birth and place of birth: an age proxy and a national-origin proxy sitting on the same
// row as the hiring evidence. A decision-support report is read while a decision is being made, so a
// field that appears on it becomes a decision variable whether or not anybody intended it to.
//
// APPLICATION_FIELDS below is an ALLOWLIST — the SELECT names its columns one at a time and there is
// no SELECT * anywhere in this file. FOUNDATIONAL_FIELDS is the denylist, and assertNoFoundational()
// runs at module load: if the two lists ever intersect, importing this module throws rather than
// quietly shipping a report with a birth date on it. A comment saying "do not add dob here" is
// advice; a load-time throw is a rule.
//
// The same screen applies to the sentence a candidate is shown. screenCandidateFeedback() refuses
// text naming a protected attribute, one of the subjects person-assertions.ts refuses outright, or a
// birth-derived term. Rejection feedback rests on demonstrated, role-relevant criteria or it is not
// sent.
//
// =================================================================================================
// AGREEMENT, CONTRADICTION, AND WHY ONE PERSON'S VIEW IS NOT THE ORGANISATION'S
// =================================================================================================
//
// Interviewer feedback is aggregated, never averaged into a verdict. agreementAnalysis() reports:
//
//   - per dimension, the spread between the interviewers who scored it, and the outlier when one
//     interviewer sits two or more points away from the others;
//   - contradictions BETWEEN KINDS of evidence — a hire recommendation over an essential requirement
//     with nothing on record, a no-hire recommendation over requirements that are all evidenced, a
//     passed assessment beside a low technical score;
//   - the single-observer case, stated in words: one scorecard is one person's view, and it is
//     labelled `single_observer` so nothing downstream can read it as consensus.
//
// A contradiction is never resolved here. It is surfaced, because the point of surfacing it is that
// a human resolves it.
//
// =================================================================================================
// SOURCE WEIGHTING IS A LABEL, NOT A MULTIPLIER
// =================================================================================================
//
// Every contributing signal carries `weight`: 'demonstrated' | 'stated' | 'single_observer' |
// 'inferred'. Those words appear on the screen next to the signal. Nothing multiplies by them
// silently — supportStateFor() reads them as words, in conditions a person can check by reading, and
// the rule's own text is exported (SUPPORT_RULE_TEXT) so the screen prints the rule it was applied
// under rather than asking anybody to trust it.
//
// DEMONSTRATED EVIDENCE OUTRANKS EVERYTHING. strong_hire_consideration is unreachable unless every
// essential requirement is `evidenced` — a checked platform record — and no volume of enthusiastic
// interviewer opinion can substitute for one. That is the whole ordering, and it is enforced in one
// place: supportStateFor().
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { rowsOf, logFail, isUuid, clean } from '@/lib/performance-scope';
import {
  subjectFor,
  coverageFor,
  requirementsFor,
  decisionsFor,
  NECESSITY_LABELS,
  type Coverage,
  type CoverageSubject,
  type CoverageRow,
  type CoverageStatus,
  type MatchDecisionRow,
} from '@/lib/capability-coverage';
import { SCORECARD_DIMENSIONS, recommendationLabel } from '@/lib/interview-feedback';
import { protectedAttributeConcern, assertAllowedAboutPerson } from '@/lib/person-assertions';
// THE VOCABULARY FIREWALL, from the HORIZON interpretation layer.
//
// src/lib/horizon/interpretation/language-guard.ts has NO imports of its own — it is a pure
// pattern scanner — so importing it here couples this module to that patch's VOCABULARY and to
// nothing else. It is imported by exact path rather than through '@/lib/horizon' deliberately: the
// barrel re-exports that patch's schema and engine, and a hiring decision surface must not go down
// because an unrelated file in another patch is mid-edit.
//
// It scans for four things this report must never say: the underlying methodology named in
// standard UI language, a deterministic prediction, a health or clinical statement, and a sentence
// that reads as the employment decision itself. Here a hit REFUSES rather than substitutes,
// because the person writing candidate feedback is present and can fix the sentence — substituting
// silently would send them a fallback they never wrote.
import { scanText } from '@/lib/horizon/interpretation/language-guard';
import { advanceStage, stageDescriptor, getStageEvents } from '@/lib/application-stages';
import { passedAssessmentsFor } from '@/lib/learning-doors';

const MOD = 'hiring-decision';

// postgres-js resolves to a plain array, never { rows }. Declared at the very top: `const` is not
// hoisted and a handler reaching a later declaration has taken pages down on this project.
const rows = rowsOf;
const why = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// THE COLUMN ALLOWLIST, AND THE LOAD-TIME RULE THAT KEEPS IT ONE
// -------------------------------------------------------------------------------------------------

/**
 * The only `applications` columns this module reads. Named one at a time in the SELECT below, so a
 * column added to the table tomorrow does not arrive on a hiring screen by accident.
 *
 * Every one of them describes the application or the work: who applied, for what, what they said
 * about the role, what they submitted. None of them describes the person's body, origin or age.
 */
export const APPLICATION_FIELDS: readonly string[] = Object.freeze([
  'id', 'application_number', 'role_id', 'applicant_user_id',
  'first_name', 'last_name', 'email',
  'department_snapshot', 'role_title_snapshot', 'level',
  'education', 'field_of_study', 'institution', 'experience_band', 'experience_description',
  'ps_selected', 'ps_solution_link', 'ps_notes',
  'why_role', 'portfolio_url', 'linkedin',
  'status', 'stage', 'score', 'scoring_feedback', 'reviewer_notes',
  'created_at', 'updated_at',
]);

/**
 * Columns that exist on the same row and must never reach a decision surface.
 *
 * These are not "sensitive but useful". On a hiring report a date of birth is an age and a place of
 * birth is a national-origin proxy; nothing this file produces is improved by either, and any
 * traditional or birth-derived computation built on them belongs to a separate layer that this
 * module neither reads nor exposes. There is no flag, no capability and no viewer that turns this
 * off.
 */
export const FOUNDATIONAL_FIELDS: readonly string[] = Object.freeze([
  'dob', 'birth_time', 'birth_place',
]);

/**
 * A comment cannot stop somebody pasting `dob` into the allowlist during a merge. This can.
 *
 * Runs at module load, so importing this file with an intersecting allowlist throws — failing the
 * build and every page that imports it, loudly, before a single report is rendered.
 */
function assertNoFoundational(): void {
  const clash = APPLICATION_FIELDS.filter((f) => FOUNDATIONAL_FIELDS.indexOf(f) >= 0);
  if (clash.length) {
    throw new Error(
      '[hiring-decision] APPLICATION_FIELDS names a foundational column (' + clash.join(', ') + '). '
      + 'A birth-derived field may not reach a hiring decision surface. Remove it from the allowlist.',
    );
  }
}
assertNoFoundational();

/**
 * Words that mean a birth-derived computation, whatever it is dressed as. Used to screen the
 * sentence a candidate is shown, so a rejection reason can never be one of these however phrased.
 */
const FOUNDATIONAL_TERMS: readonly string[] = Object.freeze([
  'birth chart', 'birth time', 'birth place', 'date of birth', 'birth date', 'born under',
  'horoscope', 'zodiac', 'star sign', 'sun sign', 'moon sign', 'nakshatra', 'rashi', 'kundli',
  'natal chart', 'planetary position',
]);

// -------------------------------------------------------------------------------------------------
// VOCABULARY — THE FOUR SUPPORT STATES AND THE FOUR HUMAN DECISIONS, KEPT APART
// -------------------------------------------------------------------------------------------------

/**
 * What the RECORD supports. Not what anybody decided, and deliberately worded so it cannot be read
 * as a verdict: each is a consideration or a request, and the negative one is bounded to the current
 * stage rather than to the person.
 */
export const SUPPORT_STATES = [
  'strong_hire_consideration',
  'hire_consideration',
  'further_review_required',
  'do_not_recommend_at_current_stage',
] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

export const SUPPORT_STATE_LABELS: Record<SupportState, string> = {
  strong_hire_consideration: 'Strong Hire Consideration',
  hire_consideration: 'Hire Consideration',
  further_review_required: 'Further Review Required',
  do_not_recommend_at_current_stage: 'Do Not Recommend at Current Stage',
};

export const SUPPORT_STATE_MEANING: Record<SupportState, string> = {
  strong_hire_consideration:
    'Every essential requirement is evidenced by a record this platform holds, more than one '
    + 'interviewer has submitted feedback, and none of them recommended against. This describes the '
    + 'record. A person still decides.',
  hire_consideration:
    'No essential requirement is missing, at least one is evidenced rather than stated, and the '
    + 'interview feedback on file leans positive. This describes the record. A person still decides.',
  further_review_required:
    'The record cannot support a conclusion either way yet — something is missing, unread, or the '
    + 'sources on file disagree. This is the honest state, not a hedge, and it is where an unreadable '
    + 'input lands so that an outage never reads as a bad candidate.',
  do_not_recommend_at_current_stage:
    'The interview feedback on file recommends against, or an essential requirement has nothing on '
    + 'record and nothing else on file offsets it. It is bounded to THIS stage and THIS role: it is '
    + 'not a statement about the person, and it does not close the application. A person decides that.',
};

export function isSupportState(v: unknown): v is SupportState {
  return typeof v === 'string' && (SUPPORT_STATES as readonly string[]).indexOf(v) >= 0;
}

/**
 * THE HUMAN DECISION. A separate union from the states above, on purpose: no function in this file
 * maps one onto the other, so there is no path by which a computed state becomes a decision.
 */
export const FINAL_DECISIONS = ['hire', 'reject', 'hold', 'next_stage'] as const;
export type FinalDecision = (typeof FINAL_DECISIONS)[number];

export const FINAL_DECISION_LABELS: Record<FinalDecision, string> = {
  hire: 'Hire',
  reject: 'Reject',
  hold: 'Hold',
  next_stage: 'Move to Next Stage',
};

export function isFinalDecision(v: unknown): v is FinalDecision {
  return typeof v === 'string' && (FINAL_DECISIONS as readonly string[]).indexOf(v) >= 0;
}

/**
 * Which funnel stage each decision implies, IF the deciding person asks for the funnel to move.
 *
 * `null` means this module proposes no movement and will not invent one: a hold is a decision to
 * wait, and moving a candidate's public tracker because somebody paused would tell them something
 * that did not happen. `next_stage` is null for a different reason — only the hiring desk knows
 * which stage is next for this candidate, so the stage is chosen on the form and validated by
 * application-stages.ts rather than guessed here.
 *
 * `hire` maps to 'decision', NOT 'onboarded': an offer being made is not an offer being signed.
 * src/lib/hire-completion.ts owns that transition and this file does not reach into it.
 *
 * Pairs rather than a Record because this constant is read from .astro frontmatter, where a typed
 * Record<string,string> in JSX breaks the compiler.
 */
export const DECISION_STAGE_PAIRS: ReadonlyArray<readonly [FinalDecision, string | null]> = Object.freeze([
  ['hire', 'decision'],
  ['reject', 'decision_no'],
  ['hold', null],
  ['next_stage', null],
]);

export function stageForDecision(decision: FinalDecision): string | null {
  const hit = DECISION_STAGE_PAIRS.find((p) => p[0] === decision);
  return hit ? hit[1] : null;
}

/** How much a signal is worth SAYING. Never a number anything multiplies by. */
export type SignalWeight = 'demonstrated' | 'stated' | 'single_observer' | 'inferred';

export const SIGNAL_WEIGHT_LABELS: Record<SignalWeight, string> = {
  demonstrated: 'Demonstrated — this platform holds the record',
  stated: 'Stated — somebody said so, and nobody checked it',
  single_observer: 'One observer — one person\'s view, not a consensus',
  inferred: 'Inferred — worked out from a curated relationship, not measured',
};

// -------------------------------------------------------------------------------------------------
// SCHEMA — ONE TABLE, AND IT IS THE ONE NOTHING ELSE OWNS
// -------------------------------------------------------------------------------------------------

/**
 * `hiring_decisions` records the FINAL HUMAN DECISION on an application.
 *
 * GREPPED BEFORE WRITING. There is no table of this name and no equivalent anywhere in src/ or db/.
 * The near neighbours were all checked and none of them is this:
 *
 *   hr_match_decisions       (src/lib/capability-coverage.ts) — a judgement about an ADVISORY VIEW.
 *                            Its own header says it moves no stage and decides nothing.
 *   match_evaluations        (src/lib/match.ts) — a stored reading, plus agreed/disagreed/set_aside
 *                            about that reading. Also explicitly not a hiring decision.
 *   application_stage_events (src/lib/application-stages.ts) — the funnel's own actor history. It
 *                            records that a stage moved, not why anybody concluded it should.
 *   manual_interviews.final_decision — one interview's outcome, per interview, not per application.
 *   tal_* / tos_*            two parallel recruitment stacks whose fork is unresolved. This module
 *                            builds on NEITHER and reads from NEITHER, so whichever one wins, this
 *                            table is still correct and still keyed on `applications.id`.
 *
 * APPEND-ONLY BY CONVENTION AND BY THE ONLY WRITER: recordFinalDecision() INSERTs, and superseding a
 * decision stamps the previous row's superseded_at and writes a new one. No function in this file
 * UPDATEs decision, reasoning, decided_by_user_id or decided_at, and none DELETEs. A decision that
 * can be edited is not a record of what somebody decided.
 *
 * decided_by_user_id IS NOT NULL, and that is the structural half of "no automated intelligence
 * score may independently make a hiring decision": there is no way to express a decision in this
 * table without an account attached to it.
 */
export const HIRING_DECISION_TABLES = ['hiring_decisions'] as const;

export function ensureHiringDecisionSchema(): Promise<void> {
  return ensureOnce('hiring_decisions_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS hiring_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID NOT NULL,
      role_id UUID,
      support_state VARCHAR(40),
      support_because JSONB NOT NULL DEFAULT '[]'::jsonb,
      decision VARCHAR(20) NOT NULL,
      decided_by_user_id UUID NOT NULL,
      decided_by_name VARCHAR(200),
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reasoning TEXT NOT NULL,
      evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      report_snapshot JSONB,
      candidate_feedback TEXT,
      stage_moved_to VARCHAR(40),
      stage_note TEXT,
      superseded_at TIMESTAMPTZ,
      superseded_by_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS hiring_decisions_app_idx
      ON hiring_decisions (application_id, decided_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS hiring_decisions_current_idx
      ON hiring_decisions (application_id) WHERE superseded_at IS NULL`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS hiring_decisions_actor_idx
      ON hiring_decisions (decided_by_user_id, decided_at DESC)`);
  });
}

export interface SchemaReport {
  present: string[];
  missing: string[];
  ok: boolean;
  sentence: string;
}

/** Does this database actually carry the table? Read by the surface before it offers the form. */
export async function verifyHiringDecisionSchema(): Promise<SchemaReport> {
  try {
    const r = rows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'hiring_decisions'`));
    const present = r.map((x: any) => String(x.table_name));
    const missing = HIRING_DECISION_TABLES.filter((t) => present.indexOf(t) < 0);
    return {
      present,
      missing,
      ok: missing.length === 0,
      sentence: missing.length === 0
        ? 'The hiring decision record exists on this database.'
        : 'The hiring decision record is not present on this database, so no decision can be recorded '
          + 'and this report is read-only. Run db/hiring-decision-schema.sql.',
    };
  } catch (e: any) {
    logFail(MOD, 'verifyHiringDecisionSchema', e);
    return {
      present: [], missing: [...HIRING_DECISION_TABLES], ok: false,
      sentence: 'We could not read the database catalogue, so whether the decision record exists is unknown.',
    };
  }
}

// -------------------------------------------------------------------------------------------------
// THE SHAPES THE REPORT IS MADE OF
// -------------------------------------------------------------------------------------------------

/** Where a fact came from. Every panel of the report carries these, and a screen prints them. */
export interface EvidenceReference {
  /** What is being pointed at, in words a person reads. */
  what: string;
  /** The module and table it came from. Named so a later reader can go and look. */
  source: string;
  /** demonstrated | stated | single_observer | inferred. A label, never a multiplier. */
  weight: SignalWeight;
  /** When the underlying record was made, when the record says. */
  recordedAt: string | null;
  /** A link a human can open, when there is one. This project stores links, not uploads. */
  url: string | null;
}

/** Read state for one panel. `unreadable` is never rendered as an empty panel. */
export type PanelRead = 'ok' | 'empty' | 'absent' | 'unreadable';

export interface Panel<T> {
  read: PanelRead;
  /** Printed verbatim. It never guesses and never apologises for an empty record. */
  sentence: string;
  data: T;
  evidence: EvidenceReference[];
}

export interface ScorecardEvidence {
  interviewId: string;
  interviewerUserId: string;
  interviewerName: string;
  roundNumber: number | null;
  roundType: string | null;
  /** Keyed by the dimension keys interview-feedback.ts owns. Null where nobody scored it. */
  scores: { key: string; label: string; value: number | null }[];
  recommendation: string | null;
  recommendationLabel: string;
  strengths: string | null;
  concerns: string | null;
  submittedAt: string | null;
}

export interface AssessmentEvidence {
  title: string;
  percentage: number | null;
  passed: boolean;
  at: string | null;
}

export interface AssignmentEvidence {
  id: string;
  title: string;
  kind: string;
  url: string | null;
  status: string;
  reviewerVerdict: string | null;
  scorePct: number | null;
  submittedAt: string | null;
}

export interface DimensionSpread {
  key: string;
  label: string;
  scores: { interviewerName: string; value: number }[];
  low: number;
  high: number;
  spread: number;
  /** An interviewer two or more points from every other scorer on this dimension. */
  outlier: { interviewerName: string; value: number } | null;
}

export interface AgreementAnalysis {
  /** Statements every source on file supports. */
  agreements: string[];
  /** Statements the sources on file do NOT jointly support. Never resolved here. */
  contradictions: string[];
  dimensionSpreads: DimensionSpread[];
  /** True when exactly one interviewer has submitted. Said in words wherever it is true. */
  singleObserver: boolean;
  sentence: string;
}

export interface SupportReading {
  state: SupportState;
  label: string;
  meaning: string;
  /** The conditions that actually fired, in the order the rule reads them. */
  because: string[];
  /** What is missing from the record, and would change this reading if it arrived. */
  whatWouldChangeIt: string[];
  /** Essential requirements with nothing on record. Stated in words, never folded into anything. */
  blockers: string[];
}

/**
 * INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP, as a value rather than as
 * a paragraph somebody has to trust.
 */
export interface Derivation {
  inputs: { name: string; read: PanelRead; sentence: string }[];
  processing: string[];
  output: string;
  evidence: EvidenceReference[];
  /**
   * CONFIDENCE IS ABOUT OUR RECORDS, NOT ABOUT THE PERSON. It counts how many of the report's
   * inputs could be read at all. There is no number on this report that rates a human.
   */
  confidence: {
    level: 'low' | 'moderate' | 'high';
    inputsRead: number;
    inputsTotal: number;
    sentence: string;
  };
  computedAt: string;
}

export interface HiringDecisionReport {
  application: {
    id: string;
    applicationNumber: string | null;
    candidateName: string;
    roleId: string | null;
    roleTitle: string | null;
    department: string | null;
    status: string | null;
    stage: string | null;
    stageLabel: string | null;
    appliedAt: string | null;
  };
  subject: CoverageSubject | null;

  /** THE EIGHT SECTIONS THE PATCH ASKS FOR, each a panel that can say it could not be read. */
  roleFit: Panel<Coverage | null>;
  technicalEvidence: Panel<CoverageRow[]>;
  behaviouralEvidence: Panel<ScorecardEvidence[]>;
  assessmentPerformance: Panel<AssessmentEvidence[]>;
  assignments: Panel<AssignmentEvidence[]>;
  interviewRecommendation: Panel<{ counts: { key: string; label: string; count: number }[]; leaning: string }>;
  agreement: AgreementAnalysis;
  priorReadings: Panel<{ decisions: MatchDecisionRow[]; matchConclusion: string | null; matchComputedAt: string | null }>;
  stageHistory: Panel<{ from: string | null; to: string; actor: string | null; note: string | null; at: string | null }[]>;

  support: SupportReading;
  derivation: Derivation;

  /** Decisions already recorded on this application, newest first. */
  decisions: RecordedDecision[];
  /** Whether a decision can be recorded at all on this database. */
  schema: SchemaReport;
  /** Anything that could not be read, collected so a screen can say so once at the top. */
  unreadable: string[];
}

export interface RecordedDecision {
  id: string;
  applicationId: string;
  decision: FinalDecision;
  decisionLabel: string;
  supportState: SupportState | null;
  supportStateLabel: string | null;
  decidedByUserId: string;
  decidedByName: string | null;
  decidedAt: string | null;
  reasoning: string;
  evidenceRefs: EvidenceReference[];
  candidateFeedback: string | null;
  stageMovedTo: string | null;
  stageNote: string | null;
  supersededAt: string | null;
  isCurrent: boolean;
}

// -------------------------------------------------------------------------------------------------
// PURE RULES. No database, no viewer, no side effects — so they can be exercised in a test suite
// and read by a person who wants to know what the screen will say before it says it.
// -------------------------------------------------------------------------------------------------

/**
 * The rule, in the words it is applied in. Exported so the screen can PRINT it beside the state
 * rather than asking anybody to take the state on trust.
 */
export const SUPPORT_RULE_TEXT: readonly string[] = Object.freeze([
  'If any input could not be read, the state is Further Review Required. An outage is not evidence '
    + 'about a candidate.',
  'If no role requirements have been recorded and no interviewer has submitted feedback, the state is '
    + 'Further Review Required, because there is nothing on file to conclude from.',
  'If any interviewer recommended against, or an essential requirement has nothing on record and no '
    + 'demonstrated evidence offsets it, the state is Do Not Recommend at Current Stage.',
  'Strong Hire Consideration requires ALL of: every essential requirement evidenced by a platform '
    + 'record, at least two interviewers submitted, and none of them recommending against.',
  'Hire Consideration requires: no essential requirement missing, at least one essential requirement '
    + 'evidenced rather than stated, and at least one interviewer submitted with the feedback leaning '
    + 'positive.',
  'Everything else is Further Review Required.',
]);

export interface SupportInputs {
  /** Essential requirements, by the coverage state each one resolved to. */
  essential: { skillName: string; status: CoverageStatus }[];
  /** Non-essential requirements, same shape. Read for context, never a blocker. */
  desirable: { skillName: string; status: CoverageStatus }[];
  /** One entry per submitted scorecard. */
  recommendations: string[];
  /** How many panel members were assigned but have not submitted. */
  awaitingScorecards: number;
  /** True when any input panel came back unreadable. */
  anyUnreadable: boolean;
  /** Assessment attempts recorded on this platform for this person. */
  assessments: { passed: number; total: number };
}

/**
 * Read the record and say what it supports.
 *
 * THE ORDERING IS THE POINT. Unreadable beats everything, because a failed read must never be
 * rendered as a finding about a person. Then "nothing on file", because an empty record supports
 * nothing in either direction. Only after both of those does the rule look at what anybody said.
 *
 * It returns the conditions that fired, not just the answer, and it returns what would change the
 * answer — because the useful thing to tell a hiring desk looking at Further Review Required is
 * which document is missing.
 */
export function supportStateFor(input: SupportInputs): SupportReading {
  const because: string[] = [];
  const whatWouldChangeIt: string[] = [];
  const blockers: string[] = [];

  const essential = Array.isArray(input?.essential) ? input.essential : [];
  const desirable = Array.isArray(input?.desirable) ? input.desirable : [];
  const recs = Array.isArray(input?.recommendations) ? input.recommendations.filter(Boolean) : [];
  const assessments = input?.assessments || { passed: 0, total: 0 };
  const awaitingScorecards = Number(input?.awaitingScorecards || 0);

  const essentialEvidenced = essential.filter((r) => r.status === 'evidenced');
  const essentialMissing = essential.filter((r) => r.status === 'nothing');
  const essentialUnreadable = essential.filter((r) => r.status === 'unreadable');
  const essentialStated = essential.filter((r) => r.status === 'stated' || r.status === 'related');

  for (const r of essentialMissing) {
    blockers.push('"' + r.skillName + '" is an essential requirement for this role and there is nothing '
      + 'on record for it. That is a statement about our records, not about this person.');
  }

  const against = recs.filter((r) => r === 'no_hire' || r === 'strong_no_hire');
  const strongFor = recs.filter((r) => r === 'strong_hire');
  const forHire = recs.filter((r) => r === 'hire' || r === 'strong_hire');

  const mk = (state: SupportState): SupportReading => ({
    state,
    label: SUPPORT_STATE_LABELS[state],
    meaning: SUPPORT_STATE_MEANING[state],
    because,
    whatWouldChangeIt,
    blockers,
  });

  // 1. AN OUTAGE IS NOT EVIDENCE.
  if (input?.anyUnreadable === true || essentialUnreadable.length > 0) {
    because.push('At least one input could not be read, so nothing here is a complete picture.');
    whatWouldChangeIt.push('Re-open this report once the unreadable panels come back.');
    return mk('further_review_required');
  }

  // 2. AN EMPTY RECORD SUPPORTS NOTHING IN EITHER DIRECTION.
  if (essential.length === 0 && desirable.length === 0 && recs.length === 0) {
    because.push('No role requirements have been recorded for this role and no interviewer has '
      + 'submitted feedback, so there is nothing on file to conclude from.');
    whatWouldChangeIt.push('Record the role\'s requirements against the skill catalogue.');
    whatWouldChangeIt.push('Ask the panel to submit their scorecards.');
    return mk('further_review_required');
  }

  // 3. WHAT SOMEBODY SAID AGAINST, OR AN ESSENTIAL GAP NOTHING OFFSETS.
  if (against.length > 0) {
    because.push(against.length === 1
      ? 'One interviewer recommended against at this stage.'
      : String(against.length) + ' interviewers recommended against at this stage.');
    if (forHire.length > 0) {
      because.push('Others recommended in favour, so this reading rests on a disagreement the panel '
        + 'has not resolved. Read the contradictions below before acting on it.');
      whatWouldChangeIt.push('Resolve the disagreement between the interviewers on file.');
    }
    return mk('do_not_recommend_at_current_stage');
  }

  if (essentialMissing.length > 0 && essentialEvidenced.length === 0) {
    because.push(String(essentialMissing.length) + ' essential requirement'
      + (essentialMissing.length === 1 ? ' has' : 's have') + ' nothing on record, and nothing this '
      + 'platform holds evidences any of the others.');
    whatWouldChangeIt.push('Attach evidence for the essential requirements listed as blockers, or '
      + 'record why this role does not need them.');
    return mk('do_not_recommend_at_current_stage');
  }

  // 4. STRONG HIRE CONSIDERATION. DEMONSTRATED EVIDENCE ONLY, AND MORE THAN ONE OBSERVER.
  const allEssentialEvidenced = essential.length > 0 && essentialEvidenced.length === essential.length;
  if (allEssentialEvidenced && recs.length >= 2 && against.length === 0) {
    because.push('Every essential requirement is evidenced by a record this platform holds — not '
      + 'stated, not inferred.');
    because.push(String(recs.length) + ' interviewers submitted feedback and none recommended against'
      + (strongFor.length ? '; ' + String(strongFor.length) + ' recommended strongly in favour.' : '.'));
    if (assessments.total > 0) {
      because.push(String(assessments.passed) + ' of ' + String(assessments.total)
        + ' recorded assessment attempts passed.');
    }
    if (awaitingScorecards > 0) {
      whatWouldChangeIt.push(String(awaitingScorecards) + ' assigned panel member'
        + (awaitingScorecards === 1 ? ' has' : 's have') + ' not submitted yet.');
    }
    return mk('strong_hire_consideration');
  }

  // 5. HIRE CONSIDERATION.
  if (essentialMissing.length === 0 && essentialEvidenced.length > 0 && recs.length >= 1 && forHire.length > recs.length - forHire.length) {
    because.push('No essential requirement is missing, and ' + String(essentialEvidenced.length)
      + ' of ' + String(essential.length) + ' are evidenced rather than stated.');
    because.push(recs.length === 1
      ? 'One interviewer submitted feedback and it leans in favour. One scorecard is one person\'s view.'
      : String(forHire.length) + ' of ' + String(recs.length) + ' interviewers recommended in favour.');
    if (essentialStated.length > 0) {
      whatWouldChangeIt.push(String(essentialStated.length) + ' essential requirement'
        + (essentialStated.length === 1 ? ' is' : 's are') + ' stated but not demonstrated. Evidence '
        + 'for them would move this reading.');
    }
    if (recs.length === 1) {
      whatWouldChangeIt.push('A second interviewer\'s scorecard would make this more than one view.');
    }
    return mk('hire_consideration');
  }

  // 6. EVERYTHING ELSE.
  if (essential.length === 0 && desirable.length > 0) {
    because.push('No requirement for this role is marked essential, so there is no requirement this '
      + 'reading can hold anybody to.');
    whatWouldChangeIt.push('Mark the requirements this role genuinely cannot do without.');
  }
  if (recs.length === 0) {
    because.push('No interviewer has submitted feedback yet.');
    whatWouldChangeIt.push('Ask the panel to submit their scorecards.');
  }
  if (essentialStated.length > 0 && essentialEvidenced.length === 0) {
    because.push('Every essential requirement on file is stated rather than demonstrated. A skill on '
      + 'a form is a claim, and this reading does not treat a claim as a check.');
    whatWouldChangeIt.push('Attach a platform record — a passed assessment, a completed course, a '
      + 'reviewed submission — to the essential requirements.');
  }
  if (essentialMissing.length > 0) {
    because.push(String(essentialMissing.length) + ' essential requirement'
      + (essentialMissing.length === 1 ? ' has' : 's have') + ' nothing on record, though other '
      + 'essential requirements are evidenced.');
  }
  if (because.length === 0) {
    because.push('The record on file does not meet the conditions for either hire reading, and does '
      + 'not meet the conditions for recommending against either.');
  }
  return mk('further_review_required');
}

/**
 * What the sources on file agree about, and what they do not.
 *
 * NOTHING IS RESOLVED HERE. A contradiction is a fact about the record, and the reason to surface it
 * is that a human resolves it. Averaging two disagreeing interviewers into one number is the exact
 * act this function exists to prevent.
 */
export function agreementAnalysis(input: {
  scorecards: ScorecardEvidence[];
  essential: { skillName: string; status: CoverageStatus }[];
  assessments: { passed: number; total: number };
}): AgreementAnalysis {
  const agreements: string[] = [];
  const contradictions: string[] = [];
  const dimensionSpreads: DimensionSpread[] = [];

  const cards = Array.isArray(input?.scorecards) ? input.scorecards : [];
  const essential = Array.isArray(input?.essential) ? input.essential : [];
  const assessments = input?.assessments || { passed: 0, total: 0 };
  const singleObserver = cards.length === 1;

  // Per dimension: who scored it, the spread, and the outlier.
  for (const dim of SCORECARD_DIMENSIONS) {
    const scored = cards
      .map((c) => {
        const hit = c.scores.find((s) => s.key === dim.key);
        return hit && typeof hit.value === 'number' ? { interviewerName: c.interviewerName, value: hit.value } : null;
      })
      .filter((x): x is { interviewerName: string; value: number } => x !== null);
    if (scored.length < 1) continue;
    const values = scored.map((s) => s.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const spread = high - low;

    // An outlier is one scorer two or more points from EVERY other scorer, which is a different
    // thing from being the highest or the lowest.
    let outlier: { interviewerName: string; value: number } | null = null;
    if (scored.length >= 3) {
      for (const s of scored) {
        const others = scored.filter((o) => o !== s);
        if (others.every((o) => Math.abs(o.value - s.value) >= 2)) { outlier = s; break; }
      }
    }
    dimensionSpreads.push({ key: dim.key, label: dim.label, scores: scored, low, high, spread, outlier });

    if (scored.length >= 2 && spread <= 1) {
      agreements.push('The interviewers who scored ' + dim.label.toLowerCase() + ' are within one point of each other.');
    }
    if (scored.length >= 2 && spread >= 2) {
      contradictions.push('On ' + dim.label.toLowerCase() + ' the panel ranges from ' + String(low) + ' to '
        + String(high) + '. That is a disagreement about what was observed, not a number to average.');
    }
    if (outlier) {
      contradictions.push(outlier.interviewerName + ' scored ' + dim.label.toLowerCase() + ' at '
        + String(outlier.value) + ', two or more points from every other scorer. Read their notes '
        + 'before treating either side as the panel\'s view.');
    }
  }

  const recs = cards.map((c) => c.recommendation).filter((r): r is string => !!r);
  const against = recs.filter((r) => r === 'no_hire' || r === 'strong_no_hire');
  const forHire = recs.filter((r) => r === 'hire' || r === 'strong_hire');

  if (recs.length >= 2 && against.length === 0) {
    agreements.push('Every interviewer who submitted recommended in favour at this stage.');
  }
  if (recs.length >= 2 && forHire.length === 0) {
    agreements.push('Every interviewer who submitted recommended against at this stage.');
  }
  if (against.length > 0 && forHire.length > 0) {
    contradictions.push('The panel is split: ' + String(forHire.length) + ' recommended in favour and '
      + String(against.length) + ' recommended against. Neither is the organisation\'s view until '
      + 'somebody decides it is.');
  }

  // Contradictions BETWEEN KINDS of evidence. These are the ones a single-source screen hides.
  const essentialMissing = essential.filter((r) => r.status === 'nothing');
  const essentialEvidenced = essential.filter((r) => r.status === 'evidenced');
  if (forHire.length > 0 && essentialMissing.length > 0) {
    contradictions.push('Interviewers recommended in favour while ' + String(essentialMissing.length)
      + ' essential requirement' + (essentialMissing.length === 1 ? ' has' : 's have')
      + ' nothing on record. Either the evidence exists and is not attached, or the requirement is '
      + 'not really essential. Both are worth fixing before deciding.');
  }
  if (against.length > 0 && essential.length > 0 && essentialEvidenced.length === essential.length) {
    contradictions.push('Interviewers recommended against while every essential requirement is '
      + 'evidenced by a platform record. The interview saw something the record does not hold, or the '
      + 'requirements do not describe the job.');
  }
  const technical = dimensionSpreads.find((d) => d.key === 'technical_score');
  if (technical && assessments.total > 0) {
    if (assessments.passed === assessments.total && technical.high <= 2) {
      contradictions.push('Every recorded assessment attempt passed, but no interviewer scored '
        + 'technical skill above ' + String(technical.high) + '. A passed assessment and a low '
        + 'interview score are two different observations of the same thing.');
    }
    if (assessments.passed === 0 && technical.low >= 4) {
      contradictions.push('No recorded assessment attempt passed, but the panel scored technical skill '
        + 'at ' + String(technical.low) + ' or above. Check which assessment was taken and whether it '
        + 'measures this role.');
    }
  }

  const sentence = singleObserver
    ? 'One interviewer has submitted. Everything below is one person\'s view of one conversation, and '
      + 'it is not a consensus however confident it reads.'
    : cards.length === 0
      ? 'No interviewer has submitted feedback, so there is nothing here to agree or disagree about yet.'
      : contradictions.length === 0
        ? 'The sources on file do not contradict each other. That is not the same as their being right.'
        : String(contradictions.length) + ' contradiction'
          + (contradictions.length === 1 ? ' is' : 's are') + ' listed below. None of them is resolved '
          + 'here; resolving them is the decision.';

  return { agreements, contradictions, dimensionSpreads, singleObserver, sentence };
}

/**
 * Why each guard group refuses a sentence, said to the person writing it. The group ids are the
 * HORIZON interpretation layer's; the sentences are this module's, because the audience here is a
 * recruiter mid-form rather than a report reader.
 */
const GUARD_GROUP_REASONS: Record<string, string> = {
  methodology: 'it names the underlying methodology, which never appears in candidate-facing language',
  prediction: 'it states a deterministic prediction about a person',
  health: 'it reads as a health or clinical statement, which this system does not make',
  decision: 'it reads as the employment decision itself rather than as the reason for one',
};

export interface FeedbackScreen {
  allowed: boolean;
  /** The refusal, in words the screen shows the person who wrote it. */
  why: string;
  /** A term worth a second look that was NOT refused. */
  caution: string | null;
}

/**
 * May this sentence be sent to the candidate?
 *
 * REJECTION FEEDBACK IS THE MOST CONSEQUENTIAL SENTENCE THIS SYSTEM PRODUCES about somebody who does
 * not work here and cannot argue with it. So it is screened three ways:
 *
 *   1. against the subjects person-assertions.ts refuses outright — culture fit, potential,
 *      personality and the rest — because those are protected-attribute proxy generators;
 *   2. against protected attributes named on their own;
 *   3. against birth-derived terms, so no traditional computation can be restated as a reason
 *      however it is worded.
 *
 * A `review`-level protected concern is NOT refused. "Accessibility engineering" and "occupational
 * health and safety" are real role-relevant criteria, and a filter that silently refuses them only
 * teaches people to word around it. The concern is returned so the writer sees it and decides.
 */
export function screenCandidateFeedback(text: string): FeedbackScreen {
  const raw = String(text || '').trim();
  if (!raw) return { allowed: true, why: '', caution: null };

  const norm = raw.toLowerCase();
  for (const term of FOUNDATIONAL_TERMS) {
    if (norm.indexOf(term) >= 0) {
      return {
        allowed: false,
        why: 'This mentions "' + term + '". Feedback to a candidate must rest on demonstrated, '
          + 'role-relevant criteria — what they did and what the role asks for. A birth-derived term '
          + 'is not one, and cannot be sent whatever else the sentence says.',
        caution: null,
      };
    }
  }

  const subject = assertAllowedAboutPerson(raw);
  if (!subject.allowed) {
    return { allowed: false, why: subject.why, caution: null };
  }

  const concern = protectedAttributeConcern(raw);
  if (concern.level === 'refuse') {
    return { allowed: false, why: concern.sentence, caution: null };
  }

  // The HORIZON vocabulary firewall, last, so its more specific message is the one shown when it is
  // the only thing that fired.
  const hits = scanText(raw);
  if (hits.length) {
    const groups = [...new Set(hits.map((h) => h.group))];
    return {
      allowed: false,
      why: 'This wording did not pass the language rules ('
        + groups.map((g) => GUARD_GROUP_REASONS[g] || g).join('; ')
        + '). The matched wording was: "' + hits[0].term + '". Rewrite it as what the role asked for '
        + 'and what this candidate demonstrated.',
      caution: null,
    };
  }

  return { allowed: true, why: '', caution: concern.level === 'review' ? concern.sentence : null };
}

/** The confidence in OUR RECORDS. Never a rating of the person. */
export function confidenceFrom(inputs: { name: string; read: PanelRead }[]): Derivation['confidence'] {
  const list = Array.isArray(inputs) ? inputs : [];
  const total = list.length;
  const readOk = list.filter((i) => i.read === 'ok').length;
  const level: 'low' | 'moderate' | 'high' =
    total === 0 ? 'low'
    : readOk / total >= 0.75 ? 'high'
    : readOk / total >= 0.4 ? 'moderate'
    : 'low';
  return {
    level,
    inputsRead: readOk,
    inputsTotal: total,
    sentence: String(readOk) + ' of ' + String(total) + ' inputs held something to read. This measures '
      + 'how complete OUR RECORD is, and it is not a rating of this person — an unrecorded fact looks '
      + 'exactly like an absent one.',
  };
}

// -------------------------------------------------------------------------------------------------
// READS. Each returns a panel that can say it could not be read, because an empty panel rendered
// from a failed query is a lie about a person.
// -------------------------------------------------------------------------------------------------

const emptyPanel = <T,>(data: T, read: PanelRead, sentence: string): Panel<T> =>
  ({ read, sentence, data, evidence: [] });

/**
 * The application row, through the allowlist.
 *
 * NO `SELECT *`. Every column is named, and assertNoFoundational() has already refused to let a
 * birth-derived column into that list.
 */
async function readApplication(applicationId: string): Promise<{ row: any | null; unreadable: string | null }> {
  try {
    const r = rows(await db.execute(sql`
      SELECT id::text AS id, application_number, role_id::text AS role_id,
             applicant_user_id::text AS applicant_user_id,
             first_name, last_name, email,
             department_snapshot, role_title_snapshot, level,
             education, field_of_study, institution, experience_band, experience_description,
             ps_selected, ps_solution_link, ps_notes,
             why_role, portfolio_url, linkedin,
             status, stage, score, scoring_feedback, reviewer_notes,
             created_at, updated_at
        FROM applications
       WHERE id = ${applicationId}::uuid
       LIMIT 1`));
    return { row: r.length ? r[0] : null, unreadable: null };
  } catch (e: any) {
    logFail(MOD, 'readApplication', e);
    return { row: null, unreadable: 'The application record could not be read (' + why(e) + ').' };
  }
}

/**
 * Interview rounds and scorecards for one application.
 *
 * WHY THE QUERY IS HERE RATHER THAN IN interview-feedback.ts. That module owns these tables and its
 * exported reads are per-INTERVIEW (getFeedbackBundle) or unscoped-then-filtered-in-TypeScript
 * (listInterviewsForFeedback, capped at 300 rows across the whole system). Neither answers "every
 * scorecard for this application", and adding a function to that module would be editing another
 * patch's file. So this is a READ-ONLY query using that module's own column names, with its own
 * documented behaviour on a database where the interview tables were never created: `absent`, said
 * in words, NOT an empty list dressed up as "no interviews yet".
 *
 * `private notes` are deliberately NOT selected. The scorecard form records them for the interviewer
 * who wrote them; a decision report is read by a wider room than that.
 */
async function readInterviewEvidence(applicationId: string): Promise<{
  panel: Panel<ScorecardEvidence[]>;
  awaiting: number;
}> {
  try {
    const r = rows(await db.execute(sql`
      SELECT ir.id::text AS interview_id, ir.round_number, ir.round_type,
             sc.interviewer_id::text AS interviewer_id,
             sc.technical_score, sc.communication_score, sc.problem_solving_score, sc.culture_score,
             sc.recommendation, sc.strengths, sc.weaknesses, sc.submitted_at,
             u.name AS interviewer_name
        FROM interview_rounds ir
        JOIN interview_scorecards sc ON sc.interview_id = ir.id
        LEFT JOIN users u ON u.id = sc.interviewer_id
       WHERE ir.application_id = ${applicationId}::uuid
       ORDER BY ir.round_number ASC NULLS LAST, sc.submitted_at ASC NULLS LAST
       LIMIT 100`));

    const data: ScorecardEvidence[] = r.map((x: any) => ({
      interviewId: String(x.interview_id),
      interviewerUserId: x.interviewer_id ? String(x.interviewer_id) : '',
      interviewerName: x.interviewer_name ? String(x.interviewer_name) : 'An interviewer',
      roundNumber: x.round_number === null || x.round_number === undefined ? null : Number(x.round_number),
      roundType: x.round_type ? String(x.round_type) : null,
      scores: SCORECARD_DIMENSIONS.map((d) => {
        const v = (x as any)[d.key];
        return { key: d.key, label: d.label, value: v === null || v === undefined ? null : Number(v) };
      }),
      recommendation: x.recommendation ? String(x.recommendation) : null,
      recommendationLabel: recommendationLabel(x.recommendation ? String(x.recommendation) : null),
      strengths: x.strengths ? String(x.strengths) : null,
      concerns: x.weaknesses ? String(x.weaknesses) : null,
      submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
    }));

    // How many assigned panel members have not submitted. Read separately and tolerantly: the
    // provenance table is interview-feedback.ts's and may not exist on an older database.
    let awaiting = 0;
    try {
      const a = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n
          FROM interview_panel_assignments pa
          JOIN interview_rounds ir ON ir.id = pa.interview_id
         WHERE ir.application_id = ${applicationId}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM interview_scorecards sc
              WHERE sc.interview_id = pa.interview_id
                AND sc.interviewer_id = pa.interviewer_user_id)`));
      awaiting = a.length ? Number(a[0].n || 0) : 0;
    } catch (e: any) {
      logFail(MOD, 'readInterviewEvidence:awaiting', e);
    }

    const evidence: EvidenceReference[] = data.map((d) => ({
      what: d.interviewerName + ' — ' + d.recommendationLabel
        + (d.roundNumber ? ' (round ' + String(d.roundNumber) + ')' : ''),
      source: 'interview_scorecards (src/lib/interview-feedback.ts)',
      weight: data.length === 1 ? 'single_observer' : 'stated',
      recordedAt: d.submittedAt,
      url: '/admin/interviews/' + d.interviewId + '/scorecard',
    }));

    const panel: Panel<ScorecardEvidence[]> = {
      read: data.length ? 'ok' : 'empty',
      sentence: data.length
        ? (data.length === 1
          ? 'One scorecard is on file. It is one person\'s account of one conversation, and it is '
            + 'recorded as such throughout this report.'
          : String(data.length) + ' scorecards are on file. They are shown side by side and are '
            + 'nowhere averaged into a verdict.')
        : 'No interviewer has submitted a scorecard for this application yet.',
      data,
      evidence,
    };
    return { panel, awaiting };
  } catch (e: any) {
    logFail(MOD, 'readInterviewEvidence', e);
    const missing = /relation .* does not exist/i.test(why(e));
    return {
      panel: emptyPanel<ScorecardEvidence[]>([], missing ? 'absent' : 'unreadable',
        missing
          ? 'The interview tables are not present on this database, so no interview evidence can be '
            + 'read. That is a missing system, not an absence of feedback.'
          : 'Interview evidence could not be read just now (' + why(e) + '). Do not read this as a '
            + 'candidate with no feedback.'),
      awaiting: 0,
    };
  }
}

/**
 * Assessment performance on this platform.
 *
 * PASSED ATTEMPTS COME THROUGH THE MODULE THAT OWNS THEM — passedAssessmentsFor() in
 * src/lib/learning-doors.ts. But that function returns ONLY passed attempts, and a passed-only view
 * of assessment performance on a hiring screen is a biased input: a candidate who attempted four
 * assessments and passed one would read identically to a candidate who attempted one and passed it.
 * So a second, narrow read counts the attempts that did not pass, and the panel states both numbers.
 * No module owns "every attempt for a person"; this reads test_attempts directly, defensively, using
 * only the columns learning-doors.ts already reads from it.
 */
async function readAssessmentEvidence(userId: string | null): Promise<{
  panel: Panel<AssessmentEvidence[]>;
  counts: { passed: number; total: number };
}> {
  if (!isUuid(userId || '')) {
    return {
      panel: emptyPanel<AssessmentEvidence[]>([], 'absent',
        'No login account is linked to this candidate, so nothing they may have done on the '
        + 'assessment platform can be read. That is a missing link in our records.'),
      counts: { passed: 0, total: 0 },
    };
  }
  const uid = String(userId);
  const passed = await passedAssessmentsFor(uid);

  let total = passed.items.length;
  let totalRead = true;
  try {
    const t = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM test_attempts
       WHERE candidate_id = ${uid}::uuid
         AND status IN ('submitted', 'auto_submitted')`));
    total = t.length ? Number(t[0].n || 0) : passed.items.length;
  } catch (e: any) {
    logFail(MOD, 'readAssessmentEvidence:total', e);
    totalRead = false;
  }

  const data: AssessmentEvidence[] = passed.items.map((a) => ({
    title: a.testTitle,
    percentage: a.percentage,
    passed: true,
    at: a.submittedAt,
  }));

  const evidence: EvidenceReference[] = data.map((a) => ({
    what: a.title + (a.percentage === null ? '' : ' — ' + String(a.percentage) + '%'),
    source: 'test_attempts (src/lib/learning-doors.ts)',
    weight: 'demonstrated',
    recordedAt: a.at,
    url: null,
  }));

  if (passed.read === 'unreadable') {
    return {
      panel: emptyPanel<AssessmentEvidence[]>([], 'unreadable',
        'Assessment records could not be read just now. Do not read a short list as a short record.'),
      counts: { passed: 0, total: 0 },
    };
  }
  if (passed.read === 'absent') {
    return {
      panel: emptyPanel<AssessmentEvidence[]>([], 'absent',
        'The assessment tables are not present on this database, so no assessment performance can be read.'),
      counts: { passed: 0, total: 0 },
    };
  }

  const notPassed = Math.max(0, total - data.length);
  const sentence = total === 0
    ? 'This candidate has no recorded assessment attempts on this platform.'
    : String(data.length) + ' of ' + String(total) + ' recorded attempt'
      + (total === 1 ? '' : 's') + ' passed'
      + (notPassed > 0
        ? '. The ' + String(notPassed) + ' that did not are counted here deliberately — a passed-only '
          + 'view of assessment performance is a biased input to a hiring decision.'
        : '.')
      + (totalRead ? '' : ' The attempt total could not be read, so only passed attempts are counted.');

  return {
    panel: { read: data.length || total ? 'ok' : 'empty', sentence, data, evidence },
    counts: { passed: data.length, total },
  };
}

/**
 * Assignments and work samples.
 *
 * TWO SOURCES, KEPT APART. `portal_submissions` (owned by src/lib/submissions.ts) holds reviewed
 * work with a reviewer's own verdict on it, which is the stronger record. The application's own
 * problem-statement fields are the candidate's link and their own description of it — carried
 * because it is often the only work sample on file, and labelled `stated` because nobody has
 * reviewed it just by its being there.
 */
async function readAssignmentEvidence(
  userId: string | null,
  app: any,
): Promise<Panel<AssignmentEvidence[]>> {
  const data: AssignmentEvidence[] = [];
  const evidence: EvidenceReference[] = [];
  let unreadable = '';

  if (isUuid(userId || '')) {
    try {
      const r = rows(await db.execute(sql`
        SELECT id::text AS id, title, kind, drive_url, external_url, status, score_pct,
               submitted_at, review_notes
          FROM portal_submissions
         WHERE submitter_user_id = ${String(userId)}::uuid
         ORDER BY submitted_at DESC
         LIMIT 25`));
      for (const x of r) {
        const url = x.external_url ? String(x.external_url) : (x.drive_url ? String(x.drive_url) : null);
        data.push({
          id: String(x.id),
          title: String(x.title || 'A submission'),
          kind: String(x.kind || 'other'),
          url,
          status: String(x.status || 'submitted'),
          reviewerVerdict: x.review_notes ? String(x.review_notes) : null,
          scorePct: x.score_pct === null || x.score_pct === undefined ? null : Number(x.score_pct),
          submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
        });
        evidence.push({
          what: String(x.title || 'A submission') + ' — ' + String(x.status || 'submitted'),
          source: 'portal_submissions (src/lib/submissions.ts)',
          // A reviewed submission is a record of somebody having checked the work. An unreviewed one
          // is a link the candidate sent, and the two must not read the same.
          weight: String(x.status || '') === 'approved' ? 'demonstrated' : 'stated',
          recordedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
          url,
        });
      }
    } catch (e: any) {
      logFail(MOD, 'readAssignmentEvidence:submissions', e);
      unreadable = 'Submitted work could not be read just now (' + why(e) + ').';
    }
  }

  // The problem statement on the application itself.
  if (app && (app.ps_solution_link || app.ps_selected)) {
    data.push({
      id: 'application-ps',
      title: app.ps_selected ? 'Problem statement: ' + String(app.ps_selected) : 'Problem statement response',
      kind: 'assignment',
      url: app.ps_solution_link ? String(app.ps_solution_link) : null,
      status: 'submitted_with_application',
      reviewerVerdict: null,
      scorePct: null,
      submittedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
    });
    evidence.push({
      what: 'The problem-statement response submitted with the application',
      source: 'applications.ps_selected / ps_solution_link (this module, allowlisted)',
      weight: 'stated',
      recordedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
      url: app.ps_solution_link ? String(app.ps_solution_link) : null,
    });
  }

  if (unreadable) {
    return { read: 'unreadable', sentence: unreadable + ' Anything shown below is incomplete.', data, evidence };
  }
  return {
    read: data.length ? 'ok' : 'empty',
    sentence: data.length
      ? 'Work submitted by this candidate. A submission a reviewer has approved is marked demonstrated; '
        + 'one nobody has reviewed is a link they sent, and is marked stated.'
      : 'No assignment or work sample is on file for this candidate.',
    data,
    evidence,
  };
}

/**
 * Advisory readings somebody already ran. READ AS STORED, NEVER RECOMPUTED.
 *
 * Re-running src/lib/match.ts here would produce a fresh weighted figure on a hiring screen under
 * whatever weight profile happens to be current, which is a different number from the one anybody
 * actually looked at. So this reads the newest stored reading and prints ITS conclusion sentence and
 * ITS timestamp, plus every decision a human has already recorded against the coverage view.
 */
async function readPriorReadings(
  roleId: string | null,
  subject: CoverageSubject | null,
): Promise<Panel<{ decisions: MatchDecisionRow[]; matchConclusion: string | null; matchComputedAt: string | null }>> {
  const empty = { decisions: [] as MatchDecisionRow[], matchConclusion: null, matchComputedAt: null };
  if (!roleId || !isUuid(roleId) || !subject) {
    return emptyPanel(empty, 'absent',
      'No role is linked to this application, so no prior reading against a role can be looked up.');
  }

  let decisionsData: MatchDecisionRow[] = [];
  let decisionsUnreadable = false;
  try {
    const d = await decisionsFor(roleId, subject.kind, subject.id);
    decisionsData = d.data || [];
    decisionsUnreadable = d.state === 'unreadable';
  } catch (e: any) {
    logFail(MOD, 'readPriorReadings:decisions', e);
    decisionsUnreadable = true;
  }

  let matchConclusion: string | null = null;
  let matchComputedAt: string | null = null;
  try {
    const m = rows(await db.execute(sql`
      SELECT explanation, created_at
        FROM match_evaluations
       WHERE subject_application_id = ${subject.id}::uuid
         AND job_id = ${roleId}::uuid
       ORDER BY created_at DESC
       LIMIT 1`));
    if (m.length) {
      const exp = m[0].explanation;
      const parsed = typeof exp === 'string' ? JSON.parse(exp) : exp;
      matchConclusion = parsed && parsed.conclusion ? String(parsed.conclusion) : null;
      matchComputedAt = m[0].created_at ? new Date(m[0].created_at).toISOString() : null;
    }
  } catch (e: any) {
    // A missing match_evaluations table is the ordinary state — that module bootstraps on first use.
    logFail(MOD, 'readPriorReadings:match', e);
  }

  const evidence: EvidenceReference[] = decisionsData.map((d) => ({
    what: (d.decidedByName || 'Somebody') + ' recorded: ' + d.decisionLabel,
    source: 'hr_match_decisions (src/lib/capability-coverage.ts)',
    weight: 'stated',
    recordedAt: d.decidedAt,
    url: null,
  }));
  if (matchConclusion) {
    evidence.push({
      what: 'A stored capability reading: ' + matchConclusion,
      source: 'match_evaluations (src/lib/match.ts)',
      weight: 'inferred',
      recordedAt: matchComputedAt,
      url: null,
    });
  }

  const data = { decisions: decisionsData, matchConclusion, matchComputedAt };
  if (decisionsUnreadable) {
    return { read: 'unreadable', sentence: 'Prior recorded decisions could not be read just now.', data, evidence };
  }
  return {
    read: decisionsData.length || matchConclusion ? 'ok' : 'empty',
    sentence: decisionsData.length || matchConclusion
      ? 'Readings and decisions somebody already recorded. The stored reading is shown as it was '
        + 'computed and is not re-run here, so what you see is what they saw.'
      : 'Nobody has recorded a reading or a decision against this candidate for this role yet.',
    data,
    evidence,
  };
}

// -------------------------------------------------------------------------------------------------
// THE REPORT
// -------------------------------------------------------------------------------------------------

/**
 * Build the Hiring Decision Support Report for one application.
 *
 * IT NEVER THROWS AT THE CALLER. Every panel degrades on its own, `unreadable` collects what failed,
 * and the support reading refuses to conclude anything when something could not be read.
 *
 * IT WRITES NOTHING. No stage moves, no status changes, no row is inserted. A report that had a side
 * effect would be a decision, and reading a candidate's file is not deciding about them.
 */
export async function buildDecisionReport(applicationId: string): Promise<HiringDecisionReport | null> {
  if (!isUuid(applicationId)) return null;

  const unreadable: string[] = [];
  const { row: app, unreadable: appErr } = await readApplication(applicationId);
  if (appErr) unreadable.push(appErr);
  if (!app) return null;

  const roleId = app.role_id ? String(app.role_id) : null;
  const userId = app.applicant_user_id ? String(app.applicant_user_id) : null;

  // The person, resolved through the spine so evidence recorded on any linked surface is reachable.
  let subject: CoverageSubject | null = null;
  try {
    const s = await subjectFor('application', applicationId);
    subject = s.data;
    if (s.state === 'unreadable') unreadable.push('The person record could not be resolved: ' + s.sentence);
  } catch (e: any) {
    logFail(MOD, 'buildDecisionReport:subject', e);
    unreadable.push('The person record could not be resolved (' + why(e) + ').');
  }

  // Role fit and technical evidence — one read, two panels, because they are the same rows read for
  // two questions and reading them twice would be two chances to disagree.
  let coverage: Coverage | null = null;
  let roleFit: Panel<Coverage | null>;
  let technicalEvidence: Panel<CoverageRow[]>;
  if (!roleId) {
    roleFit = emptyPanel<Coverage | null>(null, 'absent',
      'This application names no role record, so there are no recorded requirements to compare against.');
    technicalEvidence = emptyPanel<CoverageRow[]>([], 'absent', roleFit.sentence);
  } else if (!subject) {
    roleFit = emptyPanel<Coverage | null>(null, 'unreadable',
      'The person behind this application could not be resolved, so no evidence can be read for them.');
    technicalEvidence = emptyPanel<CoverageRow[]>([], 'unreadable', roleFit.sentence);
  } else {
    try {
      coverage = await coverageFor(roleId, subject);
      const state: PanelRead =
        coverage.state === 'unreadable' ? 'unreadable'
        : coverage.state === 'not_configured' ? 'absent'
        : coverage.rows.length ? 'ok' : 'empty';
      if (state === 'unreadable') unreadable.push('The coverage view could not be read: ' + coverage.sentence);

      const evidence: EvidenceReference[] = coverage.rows.slice(0, 60).map((r) => ({
        what: r.skillName + ' — ' + r.statusLabel + ' (' + (NECESSITY_LABELS[r.necessity] || r.necessity) + ')',
        source: 'hr_role_requirements + hr_employee_skills (src/lib/capability-coverage.ts)',
        weight: r.status === 'evidenced' ? 'demonstrated' : r.status === 'related' ? 'inferred' : 'stated',
        recordedAt: null,
        url: null,
      }));

      roleFit = {
        read: state,
        sentence: coverage.sentence || coverage.refusesTotal,
        data: coverage,
        evidence,
      };
      technicalEvidence = {
        read: state,
        sentence: state === 'ok'
          ? 'Every requirement below carries its own evidence chain. There is no total, and there will '
            + 'not be one: a single number would have to average a checked record against a keyword.'
          : coverage.sentence,
        data: coverage.rows,
        evidence,
      };
    } catch (e: any) {
      logFail(MOD, 'buildDecisionReport:coverage', e);
      unreadable.push('The coverage view could not be read (' + why(e) + ').');
      roleFit = emptyPanel<Coverage | null>(null, 'unreadable',
        'Role fit could not be read just now. This is an outage, not a finding about this candidate.');
      technicalEvidence = emptyPanel<CoverageRow[]>([], 'unreadable', roleFit.sentence);
    }
  }

  // Requirements are also read on their own, so a role whose requirements exist but whose coverage
  // failed is distinguishable from a role with no requirements at all.
  let essential: { skillName: string; status: CoverageStatus }[] = [];
  let desirable: { skillName: string; status: CoverageStatus }[] = [];
  if (coverage && coverage.rows.length) {
    for (const r of coverage.rows) {
      const entry = { skillName: r.skillName, status: r.status };
      if (r.necessity === 'essential') essential.push(entry);
      else desirable.push(entry);
    }
  } else if (roleId) {
    try {
      const req = await requirementsFor(roleId);
      if (req.state === 'unreadable') unreadable.push('The role requirements could not be read: ' + req.sentence);
      for (const r of req.data || []) {
        const entry = { skillName: r.skillName, status: 'nothing' as CoverageStatus };
        if (r.necessity === 'essential') essential.push(entry);
        else desirable.push(entry);
      }
    } catch (e: any) {
      logFail(MOD, 'buildDecisionReport:requirements', e);
      unreadable.push('The role requirements could not be read (' + why(e) + ').');
    }
  }

  const { panel: behaviouralEvidence, awaiting } = await readInterviewEvidence(applicationId);
  if (behaviouralEvidence.read === 'unreadable') unreadable.push(behaviouralEvidence.sentence);

  const { panel: assessmentPerformance, counts: assessmentCounts } = await readAssessmentEvidence(userId);
  if (assessmentPerformance.read === 'unreadable') unreadable.push(assessmentPerformance.sentence);

  const assignments = await readAssignmentEvidence(userId, app);
  if (assignments.read === 'unreadable') unreadable.push(assignments.sentence);

  const priorReadings = await readPriorReadings(roleId, subject);
  if (priorReadings.read === 'unreadable') unreadable.push(priorReadings.sentence);

  // Stage history, through the module that owns the funnel.
  let stageHistory: Panel<{ from: string | null; to: string; actor: string | null; note: string | null; at: string | null }[]>;
  try {
    const ev = await getStageEvents(applicationId);
    const data = (Array.isArray(ev) ? ev : []).map((x: any) => ({
      from: x.from_stage ? String(x.from_stage) : null,
      to: String(x.to_stage || ''),
      actor: x.actor_name ? String(x.actor_name) : null,
      note: x.note ? String(x.note) : null,
      at: x.created_at ? new Date(x.created_at).toISOString() : null,
    }));
    stageHistory = {
      read: data.length ? 'ok' : 'empty',
      sentence: data.length
        ? 'Every funnel move on this application, with the person who made it.'
        : 'No funnel movement has been recorded for this application.',
      data,
      evidence: [],
    };
  } catch (e: any) {
    logFail(MOD, 'buildDecisionReport:stages', e);
    unreadable.push('The funnel history could not be read (' + why(e) + ').');
    stageHistory = emptyPanel<any[]>([], 'unreadable', 'The funnel history could not be read just now.');
  }

  // The interview recommendation panel: counts, and the direction they lean. Not a verdict.
  const recs = behaviouralEvidence.data.map((c) => c.recommendation).filter((r): r is string => !!r);
  const counts = [
    { key: 'strong_hire', label: 'Strong hire', count: recs.filter((r) => r === 'strong_hire').length },
    { key: 'hire', label: 'Hire', count: recs.filter((r) => r === 'hire').length },
    { key: 'no_hire', label: 'No hire', count: recs.filter((r) => r === 'no_hire').length },
    { key: 'strong_no_hire', label: 'Strong no hire', count: recs.filter((r) => r === 'strong_no_hire').length },
  ];
  const positive = counts[0].count + counts[1].count;
  const negative = counts[2].count + counts[3].count;
  const leaning = recs.length === 0
    ? 'No interviewer has submitted a recommendation.'
    : positive > 0 && negative > 0
      ? 'The panel is split. Neither side is the organisation\'s view until somebody decides it is.'
      : positive > 0
        ? (recs.length === 1
          ? 'The one interviewer who submitted recommends taking this further. One scorecard is one view.'
          : 'Every interviewer who submitted recommends taking this further.')
        : (recs.length === 1
          ? 'The one interviewer who submitted recommends against at this stage. One scorecard is one view.'
          : 'Every interviewer who submitted recommends against at this stage.');

  const interviewRecommendation: Panel<{ counts: { key: string; label: string; count: number }[]; leaning: string }> = {
    read: behaviouralEvidence.read,
    sentence: leaning,
    data: { counts, leaning },
    evidence: behaviouralEvidence.evidence,
  };

  const agreement = agreementAnalysis({
    scorecards: behaviouralEvidence.data,
    essential,
    assessments: assessmentCounts,
  });

  const anyUnreadable = unreadable.length > 0;
  const support = supportStateFor({
    essential,
    desirable,
    recommendations: recs,
    awaitingScorecards: awaiting,
    anyUnreadable,
    assessments: assessmentCounts,
  });

  const inputs: { name: string; read: PanelRead; sentence: string }[] = [
    { name: 'Role requirements and evidence', read: roleFit.read, sentence: roleFit.sentence },
    { name: 'Interviewer feedback', read: behaviouralEvidence.read, sentence: behaviouralEvidence.sentence },
    { name: 'Assessment performance', read: assessmentPerformance.read, sentence: assessmentPerformance.sentence },
    { name: 'Assignments and work samples', read: assignments.read, sentence: assignments.sentence },
    { name: 'Prior recorded readings', read: priorReadings.read, sentence: priorReadings.sentence },
    { name: 'Funnel history', read: stageHistory.read, sentence: stageHistory.sentence },
  ];

  const allEvidence: EvidenceReference[] = [
    ...roleFit.evidence,
    ...behaviouralEvidence.evidence,
    ...assessmentPerformance.evidence,
    ...assignments.evidence,
    ...priorReadings.evidence,
  ];

  const derivation: Derivation = {
    inputs,
    processing: [...SUPPORT_RULE_TEXT],
    output: SUPPORT_STATE_LABELS[support.state] + ' — ' + SUPPORT_STATE_MEANING[support.state],
    evidence: allEvidence,
    confidence: confidenceFrom(inputs),
    computedAt: new Date().toISOString(),
  };

  const schema = await verifyHiringDecisionSchema();
  const decisions = schema.ok ? await decisionHistory(applicationId) : [];

  const stage = app.stage ? String(app.stage) : null;
  const descriptor = stage ? stageDescriptor(stage) : null;

  return {
    application: {
      id: String(app.id),
      applicationNumber: app.application_number ? String(app.application_number) : null,
      candidateName: (String(app.first_name || '') + ' ' + String(app.last_name || '')).trim() || 'Candidate',
      roleId,
      roleTitle: app.role_title_snapshot ? String(app.role_title_snapshot) : null,
      department: app.department_snapshot ? String(app.department_snapshot) : null,
      status: app.status ? String(app.status) : null,
      stage,
      stageLabel: descriptor ? descriptor.label : null,
      appliedAt: app.created_at ? new Date(app.created_at).toISOString() : null,
    },
    subject,
    roleFit,
    technicalEvidence,
    behaviouralEvidence,
    assessmentPerformance,
    assignments,
    interviewRecommendation,
    agreement,
    priorReadings,
    stageHistory,
    support,
    derivation,
    decisions,
    schema,
    unreadable,
  };
}

// -------------------------------------------------------------------------------------------------
// THE DECISION. THE ONLY WRITE IN THIS FILE.
// -------------------------------------------------------------------------------------------------

export type DecisionWriteResult =
  | { ok: true; id: string; message: string; stageWarning?: string }
  | { ok: false; error: string };

export interface RecordDecisionInput {
  applicationId: string;
  decision: FinalDecision;
  /** Required, non-blank. A recorded decision with no reason is an opaque decision with a timestamp. */
  reasoning: string;
  /** The account deciding. NOT NULL in the table; there is no way to express an automated decision. */
  actorUserId: string;
  actorName?: string | null;
  /** What the report said when they decided. Stored so the record stays legible when data moves. */
  report?: HiringDecisionReport | null;
  /**
   * What the candidate is told. Screened before it is stored — see screenCandidateFeedback(). Blank
   * is allowed; a wrong sentence is worse than a later one.
   */
  candidateFeedback?: string | null;
  /**
   * Move the funnel too. The stage is passed to src/lib/application-stages.ts, which owns the column,
   * the history, the notification and the event. This module never writes applications.stage itself.
   */
  moveStageTo?: string | null;
}

/**
 * Record the FINAL HUMAN DECISION.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS STRUCTURAL RATHER THAN ADVISORY:
 *
 *   no actor            -> refused. The column is NOT NULL, so an automated decision cannot be
 *                          expressed in this table even by a caller that wants to.
 *   no reasoning        -> refused. Same rule capability-coverage.ts already applies to an override.
 *   unknown decision    -> refused BY NAME rather than ignored, so a typo cannot become a fifth state.
 *   unscreened feedback -> refused with the sentence explaining which term did it.
 *
 * THE ORDER OF WRITES MATTERS. The decision row lands FIRST, then the stage move is attempted. If
 * the stage move fails the decision still stands and the caller is told in words — a decision that
 * was made and not recorded is worse than a funnel that lags behind one.
 *
 * SUPERSEDING RATHER THAN EDITING. A later decision stamps the previous one's superseded_at and
 * inserts a new row. Nothing in this file updates a decision's reasoning, actor or timestamp.
 */
export async function recordFinalDecision(input: RecordDecisionInput): Promise<DecisionWriteResult> {
  const applicationId = String(input?.applicationId || '').trim();
  const decision = input?.decision;
  const reasoning = clean(input?.reasoning, 8000);
  const actorUserId = String(input?.actorUserId || '').trim();
  const actorName = input?.actorName ? clean(input.actorName, 200) : null;
  const candidateFeedback = input?.candidateFeedback ? clean(input.candidateFeedback, 4000) : '';

  if (!isUuid(applicationId)) return { ok: false, error: 'That application could not be found.' };
  if (!isFinalDecision(decision)) {
    return { ok: false, error: 'Choose one of: ' + FINAL_DECISIONS.map((d) => FINAL_DECISION_LABELS[d]).join(', ') + '.' };
  }
  if (!reasoning) {
    return {
      ok: false,
      error: 'Write down why. A recorded decision with no reason is an opaque decision with a timestamp '
        + 'on it, and this is the record somebody will be asked to explain in six months.',
    };
  }
  if (!isUuid(actorUserId)) {
    return {
      ok: false,
      error: 'We could not tell who is making this decision, so nothing was written. A hiring decision '
        + 'is recorded against a named person or it is not recorded.',
    };
  }

  const screen = screenCandidateFeedback(candidateFeedback);
  if (!screen.allowed) {
    return { ok: false, error: 'The candidate feedback was not saved. ' + screen.why };
  }

  const report = input?.report || null;
  const supportState = report && isSupportState(report.support?.state) ? report.support.state : null;
  const supportBecause = report && Array.isArray(report.support?.because) ? report.support.because : [];
  const evidenceRefs = report && Array.isArray(report.derivation?.evidence) ? report.derivation.evidence : [];

  // The snapshot is the report MINUS the panels that would balloon it. What is kept is what makes
  // the decision legible later: what state was shown, why, what agreed, what contradicted.
  const snapshot = report
    ? {
        support: report.support,
        derivation: {
          inputs: report.derivation.inputs,
          processing: report.derivation.processing,
          output: report.derivation.output,
          confidence: report.derivation.confidence,
          computedAt: report.derivation.computedAt,
        },
        agreement: report.agreement,
        interviewRecommendation: report.interviewRecommendation.data,
        assessmentPerformance: report.assessmentPerformance.data,
        application: report.application,
        unreadable: report.unreadable,
      }
    : null;

  try {
    await ensureHiringDecisionSchema();

    const inserted = rows(await db.execute(sql`
      INSERT INTO hiring_decisions
        (application_id, role_id, support_state, support_because, decision,
         decided_by_user_id, decided_by_name, reasoning, evidence_refs, report_snapshot,
         candidate_feedback)
      VALUES
        (${applicationId}::uuid,
         ${report?.application?.roleId || null}::uuid,
         ${supportState},
         ${JSON.stringify(supportBecause)}::jsonb,
         ${String(decision)},
         ${actorUserId}::uuid,
         ${actorName},
         ${reasoning},
         ${JSON.stringify(evidenceRefs)}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb,
         ${candidateFeedback || null})
      RETURNING id::text AS id`));

    if (!inserted.length) return { ok: false, error: WRITE_FAILED };
    const id = String(inserted[0].id);

    // Supersede every earlier open decision on this application. Done AFTER the insert so a failure
    // here leaves two live decisions (visible, fixable) rather than none (invisible, not).
    try {
      await db.execute(sql`
        UPDATE hiring_decisions
           SET superseded_at = NOW(), superseded_by_id = ${id}::uuid
         WHERE application_id = ${applicationId}::uuid
           AND id <> ${id}::uuid
           AND superseded_at IS NULL`);
    } catch (e: any) {
      logFail(MOD, 'recordFinalDecision:supersede', e);
    }

    await logAudit({
      userId: actorUserId,
      action: 'hiring.decision.record',
      entity: 'hiring_decisions',
      entityId: id,
      diff: {
        applicationId,
        decision: String(decision),
        supportStateShown: supportState,
        candidateFeedbackGiven: candidateFeedback ? true : false,
        moveStageTo: input?.moveStageTo || null,
      },
    });

    // THE FUNNEL, THROUGH THE MODULE THAT OWNS IT.
    let stageWarning: string | undefined;
    const requested = input?.moveStageTo ? String(input.moveStageTo) : null;
    const target = requested || stageForDecision(decision);
    if (target) {
      const moved = await advanceStage({
        applicationId,
        toStage: target,
        actorUserId,
        actorName: actorName || 'The hiring desk',
        note: 'Hiring decision recorded: ' + FINAL_DECISION_LABELS[decision],
      });
      if (!moved.ok) {
        stageWarning = 'The decision is recorded, but the candidate\'s tracker was not moved: '
          + (moved.error || 'unknown reason');
      } else {
        try {
          await db.execute(sql`
            UPDATE hiring_decisions
               SET stage_moved_to = ${target},
                   stage_note = ${moved.changed ? 'Moved by this decision.' : 'Already at this stage.'}
             WHERE id = ${id}::uuid`);
        } catch (e: any) {
          logFail(MOD, 'recordFinalDecision:stageNote', e);
        }
      }
    }

    return {
      ok: true,
      id,
      message: 'Recorded: ' + FINAL_DECISION_LABELS[decision] + '.'
        + (screen.caution ? ' ' + screen.caution : ''),
      stageWarning,
    };
  } catch (e: any) {
    // NEVER SWALLOWED, and the real Postgres reason is on e.cause.
    logFail(MOD, 'recordFinalDecision', e);
    return { ok: false, error: 'The decision was NOT recorded: ' + why(e) };
  }
}

/** Every decision recorded on this application, newest first. Append-only, so this is the history. */
export async function decisionHistory(applicationId: string): Promise<RecordedDecision[]> {
  if (!isUuid(applicationId)) return [];
  try {
    await ensureHiringDecisionSchema();
    const r = rows(await db.execute(sql`
      SELECT d.id::text AS id, d.application_id::text AS application_id, d.decision,
             d.support_state, d.decided_by_user_id::text AS decided_by_user_id,
             COALESCE(d.decided_by_name, u.name) AS decided_by_name,
             d.decided_at, d.reasoning, d.evidence_refs, d.candidate_feedback,
             d.stage_moved_to, d.stage_note, d.superseded_at
        FROM hiring_decisions d
        LEFT JOIN users u ON u.id = d.decided_by_user_id
       WHERE d.application_id = ${applicationId}::uuid
       ORDER BY d.decided_at DESC
       LIMIT 50`));
    return r.map((x: any): RecordedDecision => {
      const dec = isFinalDecision(x.decision) ? (x.decision as FinalDecision) : 'hold';
      const st = isSupportState(x.support_state) ? (x.support_state as SupportState) : null;
      let refs: EvidenceReference[] = [];
      try {
        const raw = typeof x.evidence_refs === 'string' ? JSON.parse(x.evidence_refs) : x.evidence_refs;
        refs = Array.isArray(raw) ? raw : [];
      } catch { refs = []; }
      return {
        id: String(x.id),
        applicationId: String(x.application_id),
        decision: dec,
        decisionLabel: FINAL_DECISION_LABELS[dec],
        supportState: st,
        supportStateLabel: st ? SUPPORT_STATE_LABELS[st] : null,
        decidedByUserId: String(x.decided_by_user_id || ''),
        decidedByName: x.decided_by_name ? String(x.decided_by_name) : null,
        decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : null,
        reasoning: String(x.reasoning || ''),
        evidenceRefs: refs,
        candidateFeedback: x.candidate_feedback ? String(x.candidate_feedback) : null,
        stageMovedTo: x.stage_moved_to ? String(x.stage_moved_to) : null,
        stageNote: x.stage_note ? String(x.stage_note) : null,
        supersededAt: x.superseded_at ? new Date(x.superseded_at).toISOString() : null,
        isCurrent: !x.superseded_at,
      };
    });
  } catch (e: any) {
    logFail(MOD, 'decisionHistory', e);
    return [];
  }
}

/** The decision that currently stands on this application, or null. */
export async function currentDecision(applicationId: string): Promise<RecordedDecision | null> {
  const all = await decisionHistory(applicationId);
  return all.find((d) => d.isCurrent) || null;
}
