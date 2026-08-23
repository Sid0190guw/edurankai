// src/lib/interview-intelligence.ts — WHAT AN INTERVIEWER IS TOLD BEFORE, RECORDS DURING, AND
// SIGNS AT THE END. PATCH 09.
//
// =================================================================================================
// WHAT THIS FILE IS, AND THE FOUR THINGS IT DELIBERATELY DOES NOT DO
// =================================================================================================
//
// An interview is the one moment in a hiring process where a human observes another human directly.
// Everything this module produces exists to make that hour better informed and better recorded. It
// produces no verdict of its own.
//
//   1. IT NEVER PRINTS "HIRE" OR "REJECT". The brief has no suggested outcome, no ranking, no score
//      and no percentage anywhere in it. `BRIEF_REFUSES_A_VERDICT` is the sentence the screen prints
//      where a reader expects to find one, and it is printed every time, not only when the record is
//      thin. A brief that recommended an outcome would be answering the question the interviewer was
//      convened to answer.
//   2. IT NEVER WRITES A DECISION. recordAssessment() writes ONE row into ONE table this module
//      owns. It does not touch `applications.status`, it does not touch `interview_rounds.status`,
//      and it does not touch `interview_rounds.final_recommendation` — that column is derived from
//      the panel's scorecards by /admin/interviews/[id]/scorecard.astro and a second writer against
//      it is exactly how two surfaces start disagreeing about what a panel said.
//   3. IT NEVER READS A BIRTH FIELD. `applications` carries dob, birth_time and birth_place. No
//      query in this file selects any of the three, no type here has a place to put them, and the
//      brief cannot render them. What a candidate demonstrates outranks what anything infers about
//      them, so the inferring layer is not on this screen at all.
//   4. IT NEVER RATES ANYBODY. There is no 1-5 anything here. `interview_scorecards` already holds
//      the panel's ratings and is written by its own page; this module records OBSERVATIONS AGAINST
//      REQUIREMENTS, which is a different instrument answering a different question, and it links to
//      the scorecard rather than reimplementing it.
//
// =================================================================================================
// THE THREE MOMENTS, AND THE ONE ROW EACH LEAVES BEHIND
// =================================================================================================
//
//   BEFORE      buildInterviewBrief()      reads. Writes nothing.
//   BEFORE      lockInitialProfile()       writes ONE snapshot row: the picture as it stood before
//                                          anybody was interviewed. Frozen on purpose — see below.
//   DURING      recordObservation()        writes one observation row per thing observed.
//   AT THE END  recordAssessment()         writes one assessment row per interviewer.
//
// =================================================================================================
// WHY THE INITIAL PROFILE IS FROZEN, AND WHY THAT IS THE WHOLE POINT
// =================================================================================================
//
// An employee or candidate profile in this system is DYNAMIC: evidence is added, verified and
// superseded continuously, so the same call made twice a week apart honestly returns two different
// pictures. That is correct behaviour, and it makes "did what I observed match the system's picture"
// unanswerable unless the picture is pinned at a moment.
//
// lockInitialProfile() pins it. `interview_intel_snapshots` stores the coverage view AS IT READ at
// the moment a named human locked it, with that human's id and the timestamp. Afterwards the live
// profile may move as much as it likes; the comparison the interviewer signs is against what they
// were actually shown.
//
// AN UNLOCKED INTERVIEW IS NOT BLOCKED. Observations and an assessment can still be recorded — a
// screen that refuses to let somebody write down what they saw because a button was not pressed
// first would lose the observation, which is the only irreplaceable thing here. What it cannot do is
// claim alignment: with no snapshot the only alignment value recordAssessment() will store is
// `no_prior_intelligence`, because there was no prior intelligence to be aligned with.
//
// =================================================================================================
// PREDICTED VERSUS ACTUAL, AND WHAT "OVERRIDE" MEANS HERE EXACTLY
// =================================================================================================
//
// reconcileRequirement() is pure and is the heart of this file. Per requirement it holds two things
// apart and then says which one governs:
//
//   PREDICTED   the coverage state at lock time. Built from records: an application form, a
//               certificate, a passed assessment, a manager's statement. NONE of it is an
//               observation of this person answering a question.
//   ACTUAL      what a named interviewer wrote down in the room, against that requirement.
//
// WHERE THE TWO DISAGREE, THE OBSERVATION GOVERNS. A requirement predicted as "nothing on record"
// against which an interviewer recorded supporting technical evidence comes out as DEMONSTRATED IN
// INTERVIEW, and the prediction is marked superseded. A requirement predicted as "evidenced"
// against which an interviewer recorded contradicting evidence comes out as CONTRADICTED IN
// INTERVIEW. That is what "actual demonstrated evidence must be able to override initial
// assumptions" means as code: the record does not win an argument with the room.
//
// AN OVERRIDE IS ALWAYS ATTRIBUTABLE. Every superseding outcome carries the observation id, the
// interviewer who wrote it and when. There is no path in this file that overrides a prediction
// without a named human's sentence behind it, and no path that overrides one automatically.
//
// AN OVERRIDE CHANGES THIS SCREEN AND NOTHING ELSE. It does not write `capability_claims`, does not
// attach evidence to the capability graph, and does not alter the coverage view any other page
// renders. That would be a write into another module's tables from outside it. What this module
// offers instead is exportableEvidence(), a typed, ready-shaped list the capability-graph owner can
// consume once an interview-shaped evidence kind exists there. See THE HANDOFF at the foot of this
// file.
//
// =================================================================================================
// WHAT COUNTS AS A CONTRADICTION, AND WHY THE LIST IS SHORT
// =================================================================================================
//
// findContradictions() is pure, and every one of the four things it can report is a COMPARISON OF
// TWO STORED ROWS. There is no keyword overlap in it, no similarity, no model and no inference:
//
//   recorded_level_below_requirement   a recorded level and a required minimum, both numbers a human
//                                      entered, and the first is smaller than the second.
//   earlier_round_recommended_against  an earlier round of THIS application holds a scorecard whose
//                                      recommendation was against proceeding, and here we are.
//   panel_split_on_an_earlier_round    two scorecards on one earlier round point opposite ways.
//   earlier_observation_contradicts    an interviewer already recorded a contradicting observation
//                                      against a requirement the record still presents as held.
//
// THE OBVIOUS FIFTH ONE IS ABSENT ON PURPOSE. "The candidate claims one framework and failed an
// assessment in the language underneath it" requires deciding that two free-text titles typed on two
// different forms name the same subject. That is keyword matching wearing the word "contradiction",
// and a contradiction printed beside somebody's name before an interview is about as load-bearing as
// text on a screen gets. Platform assessment records are shown to the interviewer verbatim instead,
// attached to nothing, for a human to read.
//
// "Nothing on record" is NOT a contradiction and never appears as one. It is a gap in our records,
// it is listed under areas requiring validation, and every place it renders says which of the two it
// is.
//
// =================================================================================================
// WHO MAY SEE THIS
// =================================================================================================
//
// Everything here is HIRING TEAM ONLY, gated by the `interviews` section that already governs
// /admin/interviews and everything beneath it in src/middleware.ts. No new capability is invented,
// so nobody gains or loses sight of anything by this patch existing.
//
// A CANDIDATE NEVER SEES ANY OF IT. No function in this file is called from an applicant-facing
// surface, and none returns an internal note, a concern, a contradiction or a recommendation to one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import {
  requirementsFor,
  subjectFor,
  coverageFor,
  NECESSITY_LABELS,
  STATUS_LABELS,
  type Requirement,
  type Coverage,
  type CoverageRow,
  type CoverageSubject,
  type CoverageStatus,
  type Necessity,
} from '@/lib/capability-coverage';

const MOD = 'interview-intelligence';

// =================================================================================================
// HELPERS — every const declared ABOVE its first use. `const` is not hoisted, and a helper sitting
// under its caller has taken pages down on this project.
// =================================================================================================

/** postgres-js returns PLAIN ARRAYS. Never r.rows[0]. */
function rows(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

/** The real Postgres reason lives on e.cause. e.message is only the statement that failed. */
function why(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown error');
}

function logFail(tag: string, e: any): void {
  console.error('[' + MOD + '] ' + tag + ' failed:', why(e));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

/**
 * A written verdict needs enough words to be read back in six months. The same floor the capability
 * graph and the intern evidence chain use, restated rather than imported so that rendering an
 * interview brief does not pull either of those modules into the page.
 */
export const MIN_WRITTEN_CHARS = 12;

// =================================================================================================
// THE SENTENCES THIS MODULE REFUSES TO REPLACE WITH A VERDICT
// =================================================================================================

export const BRIEF_REFUSES_A_VERDICT =
  'There is no suggested outcome on this brief, and there will not be one. Everything above is a '
  + 'record of what has and has not been evidenced so far, assembled so the interview can be spent '
  + 'on what is unresolved. Whether this person is right for this role is the question you are here '
  + 'to answer, and nothing on this page has answered it.';

export const RECORDS_NOT_PEOPLE =
  'This describes our records. An unrecorded capability looks exactly like an absent one, and the '
  + 'difference is invisible from here.';

export const OBSERVATION_GOVERNS =
  'Where what you observed disagrees with what the record predicted, what you observed governs. The '
  + 'prediction is kept beside it so the disagreement stays visible rather than being tidied away.';

export const NO_AUTOMATIC_DECISION =
  'Recording this ends your part of the interview and nothing else. It does not move the '
  + 'application, does not notify the candidate, and does not decide anything. A named human makes '
  + 'the employment decision on the hiring screens, having read this.';

// =================================================================================================
// VOCABULARY — CAPTURE
// =================================================================================================

/**
 * The eight things an interviewer records. Named once here; the form renders these, the handler
 * validates against these, and the reconciliation reads these.
 *
 * `evidential` marks the two dimensions that can SUPERSEDE a prediction about a requirement. A warm
 * impression of somebody's communication is worth recording and is not evidence that they hold a
 * required capability; competency and technical observations are, because they are observations of
 * the person doing the thing the requirement names.
 */
export const INTEL_DIMENSIONS = [
  {
    key: 'competency',
    label: 'Competency evidence',
    evidential: true,
    hint: 'Something the role requires, shown in work they described doing. Name the requirement.',
  },
  {
    key: 'technical',
    label: 'Technical evidence',
    evidential: true,
    hint: 'A technical answer, a worked problem, a design they defended. What they actually said.',
  },
  {
    key: 'behavioural',
    label: 'Behavioural evidence',
    evidential: false,
    hint: 'A situation they described and what they did in it. Their account, recorded as theirs.',
  },
  {
    key: 'communication',
    label: 'Communication',
    evidential: false,
    hint: 'How clearly the answer arrived. Not whether you enjoyed the conversation.',
  },
  {
    key: 'role_understanding',
    label: 'Role understanding',
    evidential: false,
    hint: 'What they think this job is, in their words, against what it is.',
  },
  {
    key: 'observation',
    label: 'Interviewer observation',
    evidential: false,
    hint: 'Anything else you want on the record. Written down is better than remembered.',
  },
  { key: 'strength', label: 'Strength', evidential: false, hint: 'What stood out, and what showed it.' },
  { key: 'concern', label: 'Concern', evidential: false, hint: 'What worried you, and what showed it.' },
] as const;

export type IntelDimension = (typeof INTEL_DIMENSIONS)[number]['key'];

export function isIntelDimension(v: unknown): v is IntelDimension {
  return typeof v === 'string' && INTEL_DIMENSIONS.some((d) => d.key === v);
}

export function dimensionLabel(key: string): string {
  const hit = INTEL_DIMENSIONS.find((d) => d.key === key);
  return hit ? hit.label : 'Observation';
}

export function isEvidentialDimension(key: string): boolean {
  const hit = INTEL_DIMENSIONS.find((d) => d.key === key);
  return !!hit && hit.evidential;
}

/**
 * What one observation does to the requirement it names.
 *
 * THE INTEROP SEAM. src/lib/evidence-graph.ts owns the system's verdict vocabulary and spells it
 * `supports | does_not_support | insufficient`. These three are its interview-room wording, and
 * toGraphVerdict() below is the single declared mapping between them — restated rather than
 * imported, on the same reasoning that module gives for restating the provenance words: one
 * declaration to retype when the graph exports a shared type, instead of a page-weight import in
 * every screen that renders an observation.
 */
export const OBSERVATION_OUTCOMES = ['supports', 'contradicts', 'inconclusive'] as const;
export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number];

export function isObservationOutcome(v: unknown): v is ObservationOutcome {
  return typeof v === 'string' && (OBSERVATION_OUTCOMES as readonly string[]).indexOf(v) >= 0;
}

export const OUTCOME_LABELS: Record<ObservationOutcome, string> = {
  supports: 'They showed this',
  contradicts: 'What they showed contradicts this',
  inconclusive: 'Not enough to say either way',
};

/** Pure. This module's wording, in the capability graph's vocabulary. */
export function toGraphVerdict(outcome: ObservationOutcome): 'supports' | 'does_not_support' | 'insufficient' {
  if (outcome === 'supports') return 'supports';
  if (outcome === 'contradicts') return 'does_not_support';
  return 'insufficient';
}

// =================================================================================================
// VOCABULARY — COMPLETION
// =================================================================================================

/**
 * THE FIVE. Deliberately NOT the four in `interview_scorecards.recommendation`
 * (strong_hire / hire / no_hire / strong_no_hire), which the scorecard page writes and the panel
 * majority is derived from.
 *
 * The two scales answer different questions and neither is computed from the other. A scorecard says
 * how the panel rated somebody; this says what one interviewer, having compared what they saw
 * against what the record predicted, recommends should happen next — and two of these five ("with
 * conditions", "further assessment") have no expressible equivalent on the four-value scale, which
 * is how a hiring process ends up with a binary nobody chose.
 *
 * NONE OF THE FIVE IS A DECISION. `do_not_recommend` does not reject anybody and
 * `strongly_recommend` does not hire anybody. See NO_AUTOMATIC_DECISION.
 */
export const INTEL_RECOMMENDATIONS = [
  {
    key: 'strongly_recommend',
    label: 'Strongly Recommend',
    meaning: 'What I saw exceeded what this role asks for, and I can point at what showed it.',
  },
  {
    key: 'recommend',
    label: 'Recommend',
    meaning: 'What this role asks for was evidenced in the room.',
  },
  {
    key: 'recommend_with_conditions',
    label: 'Recommend with Conditions',
    meaning: 'Yes, provided something named happens first. Name it in the conditions field.',
  },
  {
    key: 'further_assessment_required',
    label: 'Further Assessment Required',
    meaning: 'Something material is still unresolved and this interview could not resolve it.',
  },
  {
    key: 'do_not_recommend',
    label: 'Do Not Recommend',
    meaning: 'What this role asks for was not evidenced, and I can point at what was missing.',
  },
] as const;

export type IntelRecommendation = (typeof INTEL_RECOMMENDATIONS)[number]['key'];

export function isIntelRecommendation(v: unknown): v is IntelRecommendation {
  return typeof v === 'string' && INTEL_RECOMMENDATIONS.some((r) => r.key === v);
}

export function recommendationLabel(key: string | null): string {
  if (!key) return 'Not recorded';
  const hit = INTEL_RECOMMENDATIONS.find((r) => r.key === key);
  return hit ? hit.label : 'Not recorded';
}

/** Recommendations that oblige the interviewer to write down what, specifically, is outstanding. */
export function requiresConditions(key: string): boolean {
  return key === 'recommend_with_conditions' || key === 'further_assessment_required';
}

/**
 * Did the room match the record? Recorded as its own field rather than inferred from the two, because
 * an interviewer noticing that the record was wrong about somebody is one of the most useful things
 * this system can learn, and it is invisible unless somebody is asked.
 */
export const ALIGNMENTS = [
  { key: 'aligned', label: 'Matched the pre-interview picture' },
  { key: 'partly_aligned', label: 'Partly matched it' },
  { key: 'contradicted', label: 'Contradicted the pre-interview picture' },
  { key: 'no_prior_intelligence', label: 'There was no pre-interview picture to compare against' },
] as const;

export type Alignment = (typeof ALIGNMENTS)[number]['key'];

export function isAlignment(v: unknown): v is Alignment {
  return typeof v === 'string' && ALIGNMENTS.some((a) => a.key === v);
}

export function alignmentLabel(key: string | null): string {
  if (!key) return 'Not recorded';
  const hit = ALIGNMENTS.find((a) => a.key === key);
  return hit ? hit.label : 'Not recorded';
}

// =================================================================================================
// SCHEMA — THREE NEW TABLES, NONE OF WHICH RESTATES ONE THAT EXISTS
// =================================================================================================
//
// Grepped before writing. `interview_rounds`, `interview_scorecards` and `interview_panel_scores`
// are not declared here and never will be: their DDL lives in hand-run migrations this repository
// does not carry, and a CREATE TABLE IF NOT EXISTS written from memory is a SECOND SHAPE for an
// existing table — the fault class that silently breaks every write for whichever module loses the
// race. `interview_panel_assignments` belongs to src/lib/interview-feedback.ts and is read through
// that module, never re-declared.
//
// All three names below are prefixed `interview_intel_` so that ownership is legible from the table
// name alone in a database several agents write to.
//
// interview_id IS NOT DECLARED AS A FOREIGN KEY to interview_rounds, deliberately: that table may be
// absent on a given database (see above), and a REFERENCES clause against a missing table fails the
// whole bootstrap and takes every function in this file down with it. The relationship is enforced
// by the readers, which resolve the round before anything is written.

export function ensureInterviewIntelSchema(): Promise<void> {
  return ensureOnce('interview_intelligence_v1', async () => {
    // THE FROZEN PRE-INTERVIEW PICTURE. One row per lock; history kept rather than overwritten, so
    // a second lock before a later round does not erase what the first interviewer was shown.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS interview_intel_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id UUID NOT NULL,
      application_id UUID,
      role_id UUID,
      subject_resolution TEXT,
      requirement_count INTEGER NOT NULL DEFAULT 0,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      locked_by_user_id UUID,
      locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS iis_interview_idx
      ON interview_intel_snapshots(interview_id, locked_at DESC)`);

    // WHAT WAS OBSERVED IN THE ROOM. Many rows per interviewer: an interview produces more than one
    // observation and collapsing them into one textarea per dimension loses which requirement each
    // one was about.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS interview_intel_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id UUID NOT NULL,
      interviewer_user_id UUID NOT NULL,
      dimension VARCHAR(40) NOT NULL,
      requirement_skill_id UUID,
      requirement_skill_name VARCHAR(200),
      outcome VARCHAR(20) NOT NULL DEFAULT 'inconclusive',
      observation TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS iio_interview_idx
      ON interview_intel_observations(interview_id, recorded_at ASC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS iio_skill_idx
      ON interview_intel_observations(interview_id, requirement_skill_id)`);

    // THE COMPLETION RECORD. One per interviewer per interview, upserted on the unique index, on the
    // same convention interview_scorecards already uses.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS interview_intel_assessments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id UUID NOT NULL,
      interviewer_user_id UUID NOT NULL,
      recommendation VARCHAR(40) NOT NULL,
      supporting_evidence TEXT NOT NULL,
      written_feedback TEXT NOT NULL,
      conditions TEXT,
      alignment VARCHAR(30) NOT NULL,
      alignment_note TEXT,
      snapshot_id UUID,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS iia_member_uq
      ON interview_intel_assessments(interview_id, interviewer_user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS iia_interview_idx
      ON interview_intel_assessments(interview_id)`);
  });
}

// =================================================================================================
// EXPLAINABILITY — THE SIX FIELDS, ATTACHED TO EVERYTHING DERIVED
// =================================================================================================

/**
 * INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP.
 *
 * Carried by every derived structure in this file, so that "where did this come from" is answerable
 * from the object itself rather than from whoever remembers writing it.
 *
 * `confidence` IS A SENTENCE AND NOT A NUMBER, everywhere, and that is not an omission. A number
 * beside a statement about a person is read as a measurement; nothing here is measured. Every
 * derived line in this module is a comparison of stored rows, and the honest confidence statement is
 * to say exactly that.
 */
export interface Provenance {
  inputs: string[];
  processing: string;
  output: string;
  evidence: string[];
  confidence: string;
  timestamp: string;
}

const DETERMINISTIC_CONFIDENCE =
  'Every line here is a comparison of rows already stored in this system. There is no model, no '
  + 'estimate and no prediction in it. Where a row could not be read, the line says so rather than '
  + 'reading as an absence.';

// =================================================================================================
// SUGGESTED PROBES — PURE, DETERMINISTIC, AND EXPLAINED BY THE GAP THAT PRODUCED THEM
// =================================================================================================
//
// A probe is not a question generated about a person. It is a sentence derived from ONE fact: this
// requirement is at this coverage state, and here is what an interview can settle that a record
// cannot. The same requirement in the same state always produces the same probe, which is what makes
// it auditable — and is why no language model is involved in producing it.

export type ProbePriority = 'must_validate' | 'worth_probing' | 'confirm_briefly';

export const PROBE_PRIORITY_LABELS: Record<ProbePriority, string> = {
  must_validate: 'Must be validated in this interview',
  worth_probing: 'Worth probing if there is time',
  confirm_briefly: 'Confirm briefly and move on',
};

export interface Probe {
  skillId: string;
  skillName: string;
  necessity: Necessity;
  necessityLabel: string;
  status: CoverageStatus;
  statusLabel: string;
  priority: ProbePriority;
  /** The gap this probe exists to close, in one sentence. */
  why: string;
  /** What to actually ask. Phrased for the interviewer, never read out to the candidate verbatim. */
  prompt: string;
}

/**
 * Pure. One requirement plus its coverage state in, one probe out.
 *
 * Exported so the test suite can pin every branch without a database.
 */
export function probeFor(
  req: { skillId: string; skillName: string; necessity: Necessity; minLevel: number | null },
  cov: { status: CoverageStatus; level: number | null } | null,
): Probe {
  const status: CoverageStatus = cov ? cov.status : 'nothing';
  const level = cov ? cov.level : null;
  const name = req.skillName || 'this requirement';
  const essential = req.necessity === 'essential';
  const helpful = req.necessity === 'helpful';

  let priority: ProbePriority;
  let why: string;
  let prompt: string;

  if (status === 'unreadable') {
    // A read that failed must never present as a gap in the person.
    priority = essential ? 'must_validate' : 'worth_probing';
    why = 'The record for ' + name + ' could not be read, so nothing is known here either way. This '
      + 'is an outage in our records, not a gap in this person.';
    prompt = 'Ask about ' + name + ' from scratch, as though nothing had been submitted. Do not treat '
      + 'the unreadable record as an absence.';
  } else if (status === 'evidenced' && req.minLevel !== null && level !== null && level < req.minLevel) {
    priority = essential ? 'must_validate' : 'worth_probing';
    why = name + ' is evidenced, but at level ' + level + ' where this role asks for ' + req.minLevel + '.';
    prompt = 'Ask what they have done at the level above the one on record: what changed in the work, '
      + 'and what they had to decide that they did not have to decide before.';
  } else if (status === 'evidenced') {
    priority = 'confirm_briefly';
    why = name + ' is already evidenced by a checked record. The interview does not need to establish it.';
    prompt = 'One question to confirm the record is about the work you think it is, then spend the time '
      + 'on the requirements below that nothing supports.';
  } else if (status === 'stated') {
    priority = essential ? 'must_validate' : (helpful ? 'confirm_briefly' : 'worth_probing');
    why = name + ' is stated on a form and nothing demonstrates it. A statement is a record of what '
      + 'somebody said, not evidence that it happened.';
    prompt = 'Ask them to walk through the most recent time they used ' + name + ' end to end — what they '
      + 'built, what they decided, and what went wrong. A worked account is evidence; a definition is not.';
  } else if (status === 'related') {
    priority = essential ? 'must_validate' : (helpful ? 'confirm_briefly' : 'worth_probing');
    why = 'Nothing covers ' + name + ' directly. A related capability is on record, and a human curated '
      + 'that relation — nobody measured that it transfers.';
    prompt = 'Ask what differs in practice between the related work on record and ' + name + '. Somebody '
      + 'who has actually crossed that gap can describe it; somebody who has not will describe the two '
      + 'as the same thing.';
  } else {
    priority = essential ? 'must_validate' : (helpful ? 'confirm_briefly' : 'worth_probing');
    why = 'Nothing on record covers ' + name + ' at all. That is a gap in our records and may be a gap in '
      + 'their experience; this interview is the only thing that can tell the two apart.';
    prompt = 'Ask directly whether they have worked with ' + name + ', and if so for a concrete example '
      + 'with a decision in it. If they have not, that is a clean answer worth recording as one.';
  }

  return {
    skillId: req.skillId,
    skillName: name,
    necessity: req.necessity,
    necessityLabel: NECESSITY_LABELS[req.necessity] || 'Important',
    status,
    statusLabel: STATUS_LABELS[status] || 'Nothing on record',
    priority,
    why,
    prompt,
  };
}

/** Must-validate first, then by necessity, then alphabetically. Stable for the same input. */
const PROBE_ORDER: Record<ProbePriority, number> = { must_validate: 0, worth_probing: 1, confirm_briefly: 2 };
const NECESSITY_ORDER: Record<string, number> = { essential: 0, important: 1, helpful: 2 };

export function sortProbes(probes: Probe[]): Probe[] {
  return probes.slice().sort((a, b) =>
    PROBE_ORDER[a.priority] - PROBE_ORDER[b.priority]
    || (NECESSITY_ORDER[a.necessity] ?? 3) - (NECESSITY_ORDER[b.necessity] ?? 3)
    || a.skillName.localeCompare(b.skillName));
}

// =================================================================================================
// CONTRADICTIONS — PURE, AND EVERY ONE OF THEM IS TWO ROWS THAT DISAGREE
// =================================================================================================

export const CONTRADICTION_KINDS = [
  'recorded_level_below_requirement',
  'earlier_round_recommended_against',
  'panel_split_on_an_earlier_round',
  'earlier_observation_contradicts',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export interface Contradiction {
  kind: ContradictionKind;
  /** One line, safe to render in a list. Never accusatory, never about the person's character. */
  headline: string;
  /** What the interviewer should do about it, since a contradiction with no next step is just noise. */
  whatToDo: string;
  /** The rows this was read from, named. A contradiction with no evidence line is not shown. */
  evidence: string[];
}

/** What findContradictions() needs. Deliberately plain data so the function stays pure and testable. */
export interface ContradictionInput {
  requirements: { skillId: string; skillName: string; necessity: Necessity; minLevel: number | null }[];
  coverage: { skillId: string; status: CoverageStatus; level: number | null }[];
  /** Scorecards on OTHER rounds of the same application. Never this round's. */
  priorScorecards: {
    roundNumber: number;
    interviewerName: string;
    recommendation: string | null;
  }[];
  /** Observations recorded on OTHER rounds of the same application. */
  priorObservations: {
    roundNumber: number;
    interviewerName: string;
    skillId: string | null;
    skillName: string | null;
    outcome: ObservationOutcome;
    observation: string;
  }[];
}

const AGAINST_PROCEEDING = ['no_hire', 'strong_no_hire'];
const FOR_PROCEEDING = ['hire', 'strong_hire'];

/**
 * Pure. Everything two stored rows disagree about, and nothing else.
 *
 * ORDER IS DETERMINISTIC: the kinds are emitted in the order declared above, and within a kind by
 * the requirement or round that produced them. A list that reshuffles between two loads of the same
 * page reads as new information when nothing has changed.
 */
export function findContradictions(input: ContradictionInput): Contradiction[] {
  const out: Contradiction[] = [];
  const covBySkill = new Map<string, { status: CoverageStatus; level: number | null }>();
  for (const c of input.coverage || []) covBySkill.set(c.skillId, { status: c.status, level: c.level });

  // 1. A recorded level below the minimum a human set for this job. Two numbers, one comparison.
  for (const r of input.requirements || []) {
    const cov = covBySkill.get(r.skillId);
    if (!cov || cov.status !== 'evidenced') continue;
    if (r.minLevel === null || cov.level === null) continue;
    if (cov.level >= r.minLevel) continue;
    out.push({
      kind: 'recorded_level_below_requirement',
      headline: r.skillName + ' is evidenced at level ' + cov.level + ', and this role records a minimum of '
        + r.minLevel + '.',
      whatToDo: 'Ask what they have done above the level on record. The recorded level may simply be stale — '
        + 'it is a figure somebody entered at a point in time, not a live measurement.',
      evidence: [
        'The requirement row for this job records a minimum level of ' + r.minLevel + '.',
        'The capability record for ' + r.skillName + ' stands at level ' + cov.level + '.',
      ],
    });
  }

  // 2. An earlier round recommended against proceeding, and the process proceeded.
  for (const sc of input.priorScorecards || []) {
    if (!sc.recommendation || AGAINST_PROCEEDING.indexOf(sc.recommendation) < 0) continue;
    out.push({
      kind: 'earlier_round_recommended_against',
      headline: 'Round ' + sc.roundNumber + ' recorded a recommendation against proceeding, from '
        + sc.interviewerName + '.',
      whatToDo: 'Read that scorecard before this interview. Either it raised something this round should '
        + 'settle, or somebody decided to proceed anyway for a reason worth knowing.',
      evidence: ['A scorecard on round ' + sc.roundNumber + ' by ' + sc.interviewerName + ' recorded "'
        + sc.recommendation.replace(/_/g, ' ') + '".'],
    });
  }

  // 3. One earlier round, two scorecards pointing opposite ways.
  const byRound = new Map<number, { for: string[]; against: string[] }>();
  for (const sc of input.priorScorecards || []) {
    if (!sc.recommendation) continue;
    const entry = byRound.get(sc.roundNumber) || { for: [], against: [] };
    if (FOR_PROCEEDING.indexOf(sc.recommendation) >= 0) entry.for.push(sc.interviewerName);
    else if (AGAINST_PROCEEDING.indexOf(sc.recommendation) >= 0) entry.against.push(sc.interviewerName);
    byRound.set(sc.roundNumber, entry);
  }
  const splitRounds = Array.from(byRound.entries())
    .filter(([, v]) => v.for.length > 0 && v.against.length > 0)
    .sort((a, b) => a[0] - b[0]);
  for (const [roundNumber, v] of splitRounds) {
    out.push({
      kind: 'panel_split_on_an_earlier_round',
      headline: 'The panel on round ' + roundNumber + ' did not agree.',
      whatToDo: 'A split panel usually means two people saw different things, not that one of them was '
        + 'careless. Find out which of the two this interview is placed to settle.',
      evidence: [
        'For proceeding on round ' + roundNumber + ': ' + v.for.join(', ') + '.',
        'Against proceeding on round ' + roundNumber + ': ' + v.against.join(', ') + '.',
      ],
    });
  }

  // 4. An interviewer already contradicted a requirement the record still presents as held.
  for (const ob of input.priorObservations || []) {
    if (ob.outcome !== 'contradicts' || !ob.skillId) continue;
    const cov = covBySkill.get(ob.skillId);
    if (!cov || (cov.status !== 'evidenced' && cov.status !== 'stated')) continue;
    const name = ob.skillName || 'a requirement';
    out.push({
      kind: 'earlier_observation_contradicts',
      headline: name + ' is ' + (cov.status === 'evidenced' ? 'evidenced in the record' : 'stated on the application')
        + ', and ' + ob.interviewerName + ' recorded the opposite in round ' + ob.roundNumber + '.',
      whatToDo: 'The record and the room have already disagreed about this once. It is the strongest '
        + 'candidate for what this interview should spend its time on.',
      evidence: [
        'Round ' + ob.roundNumber + ', ' + ob.interviewerName + ': "' + clean(ob.observation, 240) + '"',
        'The capability record still shows ' + name + ' as ' + (STATUS_LABELS[cov.status] || cov.status).toLowerCase() + '.',
      ],
    });
  }

  return out;
}

// =================================================================================================
// PREDICTED VERSUS ACTUAL — WHERE THE OBSERVATION OVERRIDES THE RECORD
// =================================================================================================

export const RECONCILED_STATES = [
  'demonstrated_in_interview',
  'contradicted_in_interview',
  'interviewers_disagree',
  'not_examined',
] as const;
export type ReconciledState = (typeof RECONCILED_STATES)[number];

export const RECONCILED_LABELS: Record<ReconciledState, string> = {
  demonstrated_in_interview: 'Demonstrated in the interview',
  contradicted_in_interview: 'Contradicted in the interview',
  interviewers_disagree: 'Interviewers disagree',
  not_examined: 'Not examined in this interview',
};

export interface ObservationRef {
  id: string;
  interviewerName: string;
  outcome: ObservationOutcome;
  dimension: string;
  observation: string;
  recordedAt: string | null;
}

export interface Reconciled {
  skillId: string;
  skillName: string;
  necessity: Necessity;
  necessityLabel: string;
  /** What the record predicted, frozen at lock time. Never recomputed at read time. */
  predictedStatus: CoverageStatus;
  predictedLabel: string;
  /** What the room produced. */
  state: ReconciledState;
  stateLabel: string;
  /** True when the room disagreed with the record and the room governs. */
  overrides: boolean;
  /** The observations this rests on, named. Empty exactly when state is not_examined. */
  observations: ObservationRef[];
  /** The sentence a screen prints. Attributed, and never a bare status word. */
  sentence: string;
}

/**
 * Pure. One requirement's prediction, plus every observation recorded against it, in. The position
 * after the interview out.
 *
 * ONLY AN EVIDENTIAL DIMENSION CAN SUPERSEDE A PREDICTION. A `communication` observation naming a
 * requirement is kept and shown, and it does not turn "nothing on record" into "demonstrated" —
 * observing that somebody explains themselves well is not observing that they hold the capability.
 * Non-evidential observations still appear in `observations` so nothing an interviewer wrote is
 * hidden from the reconciliation; they simply do not move the state.
 *
 * WHERE TWO INTERVIEWERS DISAGREE, NEITHER WINS. `interviewers_disagree` is a real outcome and is
 * printed as one. Silently preferring the later row, or the more senior interviewer, would be this
 * system deciding a disagreement between two humans by itself.
 */
export function reconcileRequirement(
  requirement: { skillId: string; skillName: string; necessity: Necessity },
  predictedStatus: CoverageStatus,
  observations: (ObservationRef & { dimension: string })[],
): Reconciled {
  const evidential = observations.filter((o) => isEvidentialDimension(o.dimension));
  const supporting = evidential.filter((o) => o.outcome === 'supports');
  const contradicting = evidential.filter((o) => o.outcome === 'contradicts');

  let state: ReconciledState;
  if (supporting.length && contradicting.length) state = 'interviewers_disagree';
  else if (supporting.length) state = 'demonstrated_in_interview';
  else if (contradicting.length) state = 'contradicted_in_interview';
  else state = 'not_examined';

  const predictedLabel = STATUS_LABELS[predictedStatus] || 'Nothing on record';
  const predictedHeld = predictedStatus === 'evidenced';

  // `unreadable` IS NOT A PREDICTION. A record that could not be read cannot be disagreed with, so
  // nothing supersedes it — the interview fills a hole an outage left rather than overturning a
  // finding. Treating an outage as a prediction the room defeated would credit this system with a
  // wrong answer it never actually gave.
  const predictedReadable = predictedStatus !== 'unreadable';
  const predictedLeanedPositive =
    predictedStatus === 'evidenced' || predictedStatus === 'stated' || predictedStatus === 'related';

  // AN OVERRIDE IS AN UNAMBIGUOUS ROOM FINDING THAT SUPERSEDES A PREDICTION.
  //
  // A DISAGREEMENT BETWEEN TWO INTERVIEWERS IS DELIBERATELY NOT ONE. It supersedes nothing — it is
  // unresolved — and counting it as an override would let a screen report that the interview settled
  // something it did not. It is counted separately, and the screen says which of the two it is.
  const overrides =
    (state === 'demonstrated_in_interview' && predictedReadable && !predictedHeld)
    || (state === 'contradicted_in_interview' && predictedLeanedPositive);

  const names = (list: ObservationRef[]) =>
    Array.from(new Set(list.map((o) => o.interviewerName))).join(', ');

  let sentence: string;
  if (state === 'not_examined') {
    sentence = 'Nothing was recorded against ' + requirement.skillName + ' in this interview, so the '
      + 'position is unchanged: ' + predictedLabel.toLowerCase() + '. It was not examined, which is not '
      + 'the same as being found absent.';
  } else if (state === 'interviewers_disagree') {
    sentence = names(supporting) + ' recorded that ' + requirement.skillName + ' was shown; '
      + names(contradicting) + ' recorded the opposite. Both stand. This is a disagreement between two '
      + 'people who were in the room, and it is not resolved here.';
  } else if (state === 'demonstrated_in_interview') {
    sentence = requirement.skillName + ' was demonstrated in the interview, recorded by ' + names(supporting)
      + '. The record predicted ' + predictedLabel.toLowerCase() + (overrides
        ? '; what was observed supersedes that prediction.'
        : (predictedHeld
          ? ', and the interview agrees with it.'
          : ', which could not be read, so the interview stands on its own here.'));
  } else {
    sentence = 'What was observed contradicts ' + requirement.skillName + ', recorded by ' + names(contradicting)
      + '. The record predicted ' + predictedLabel.toLowerCase() + (overrides
        ? '; what was observed supersedes that prediction.'
        : '.');
  }

  return {
    skillId: requirement.skillId,
    skillName: requirement.skillName,
    necessity: requirement.necessity,
    necessityLabel: NECESSITY_LABELS[requirement.necessity] || 'Important',
    predictedStatus,
    predictedLabel,
    state,
    stateLabel: RECONCILED_LABELS[state],
    overrides,
    observations,
    sentence,
  };
}

// =================================================================================================
// THE ROUND, AND WHO IT IS ABOUT
// =================================================================================================

export interface InterviewRef {
  id: string;
  applicationId: string | null;
  applicationNumber: string | null;
  candidateName: string;
  roleId: string | null;
  roleTitle: string | null;
  departmentName: string | null;
  roundNumber: number;
  roundType: string | null;
  title: string | null;
  scheduledAt: string | null;
  status: string | null;
}

/**
 * Load one round.
 *
 * THREE OUTCOMES, KEPT APART, because collapsing them tells somebody the wrong thing:
 *   tablesPresent false  the interview tables were never created on this database
 *   ref null             the tables exist and this round does not
 *   error non-null       the query did not answer, which is not a statement about the round
 *
 * `role_id` is selected from `applications`, not from the round: requirements hang off the job, and
 * the round has no job of its own.
 */
async function loadInterview(interviewId: string): Promise<{
  tablesPresent: boolean;
  ref: InterviewRef | null;
  error: string | null;
}> {
  if (!isUuid(interviewId)) return { tablesPresent: true, ref: null, error: null };
  try {
    const r = rows(await db.execute(sql`
      SELECT ir.id, ir.application_id, ir.round_number, ir.round_type, ir.title,
             ir.scheduled_at, ir.status,
             a.application_number, a.first_name, a.last_name,
             a.role_id, a.role_title_snapshot, a.department_snapshot
        FROM interview_rounds ir
        LEFT JOIN applications a ON a.id = ir.application_id
       WHERE ir.id = ${interviewId}::uuid
       LIMIT 1`));
    if (!r.length) return { tablesPresent: true, ref: null, error: null };
    const x = r[0] as any;
    return {
      tablesPresent: true,
      error: null,
      ref: {
        id: String(x.id),
        applicationId: x.application_id ? String(x.application_id) : null,
        applicationNumber: x.application_number ? String(x.application_number) : null,
        candidateName: (String(x.first_name || '') + ' ' + String(x.last_name || '')).trim() || 'Candidate',
        roleId: x.role_id ? String(x.role_id) : null,
        roleTitle: x.role_title_snapshot ? String(x.role_title_snapshot) : null,
        departmentName: x.department_snapshot ? String(x.department_snapshot) : null,
        roundNumber: Number(x.round_number || 1),
        roundType: x.round_type ? String(x.round_type) : null,
        title: x.title ? String(x.title) : null,
        scheduledAt: x.scheduled_at ? new Date(x.scheduled_at).toISOString() : null,
        status: x.status ? String(x.status) : null,
      },
    };
  } catch (e: any) {
    logFail('loadInterview', e);
    return { tablesPresent: false, ref: null, error: why(e) };
  }
}

export interface PriorRound {
  interviewId: string;
  roundNumber: number;
  roundType: string | null;
  interviewerName: string;
  recommendation: string | null;
  submittedAt: string | null;
}

/**
 * Scorecards recorded on the OTHER rounds of this application.
 *
 * READ ONLY, and read straight rather than through interview-feedback.ts because that module's
 * bundle is keyed on one interview and this question is keyed on the application. Nothing here
 * writes to either table.
 *
 * A missing table is an empty list plus `present: false`, never an empty list that reads as "no
 * earlier rounds".
 */
async function priorScorecardsFor(applicationId: string, excludeInterviewId: string): Promise<{
  present: boolean;
  rounds: PriorRound[];
}> {
  if (!isUuid(applicationId)) return { present: true, rounds: [] };
  try {
    const r = rows(await db.execute(sql`
      SELECT ir.id AS interview_id, ir.round_number, ir.round_type,
             sc.recommendation, sc.submitted_at,
             COALESCE(u.name, u.email, 'An interviewer') AS interviewer_name
        FROM interview_scorecards sc
        JOIN interview_rounds ir ON ir.id = sc.interview_id
        LEFT JOIN users u ON u.id = sc.interviewer_id
       WHERE ir.application_id = ${applicationId}::uuid
         AND (${isUuid(excludeInterviewId) ? excludeInterviewId : null}::uuid IS NULL
              OR ir.id <> ${isUuid(excludeInterviewId) ? excludeInterviewId : null}::uuid)
       ORDER BY ir.round_number ASC, sc.submitted_at ASC
       LIMIT 100`));
    return {
      present: true,
      rounds: r.map((x: any) => ({
        interviewId: String(x.interview_id),
        roundNumber: Number(x.round_number || 1),
        roundType: x.round_type ? String(x.round_type) : null,
        interviewerName: String(x.interviewer_name || 'An interviewer'),
        recommendation: x.recommendation ? String(x.recommendation) : null,
        submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
      })),
    };
  } catch (e: any) {
    logFail('priorScorecardsFor', e);
    return { present: false, rounds: [] };
  }
}

// =================================================================================================
// OBSERVATIONS
// =================================================================================================

export interface ObservationRow {
  id: string;
  interviewId: string;
  interviewerUserId: string;
  interviewerName: string;
  dimension: string;
  dimensionLabel: string;
  skillId: string | null;
  skillName: string | null;
  outcome: ObservationOutcome;
  outcomeLabel: string;
  observation: string;
  recordedAt: string | null;
}

function mapObservation(x: any): ObservationRow {
  const dimension = String(x.dimension || 'observation');
  const outcome: ObservationOutcome = isObservationOutcome(x.outcome) ? x.outcome : 'inconclusive';
  return {
    id: String(x.id),
    interviewId: String(x.interview_id),
    interviewerUserId: String(x.interviewer_user_id || ''),
    interviewerName: String(x.interviewer_name || 'An interviewer'),
    dimension,
    dimensionLabel: dimensionLabel(dimension),
    skillId: x.requirement_skill_id ? String(x.requirement_skill_id) : null,
    skillName: x.requirement_skill_name ? String(x.requirement_skill_name) : null,
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    observation: String(x.observation || ''),
    recordedAt: x.recorded_at ? new Date(x.recorded_at).toISOString() : null,
  };
}

export type WriteResult = { ok: true; id?: string; message?: string } | { ok: false; error: string };

export interface RecordObservationInput {
  interviewId: string;
  interviewerUserId: string;
  dimension: string;
  observation: string;
  /** Optional. An observation not tied to a requirement is still worth having. */
  skillId?: string | null;
  skillName?: string | null;
  outcome?: string | null;
}

/**
 * Write down one thing that happened in the room.
 *
 * AN OBSERVATION IS NEVER SILENTLY DROPPED. Every refusal below says what was wrong and states that
 * nothing was saved, because the failure mode that matters here is an interviewer who believes their
 * note is on the record when it is not.
 *
 * `outcome` is forced to `inconclusive` when no requirement is named. A verdict of "they showed this"
 * against nothing in particular is not a verdict, and storing one would let a reconciliation later
 * count it.
 */
export async function recordObservation(input: RecordObservationInput): Promise<WriteResult> {
  const interviewId = clean(input?.interviewId, 60);
  const interviewerUserId = clean(input?.interviewerUserId, 60);
  const observation = clean(input?.observation, 4000);
  const dimension = clean(input?.dimension, 40);

  if (!isUuid(interviewId)) return { ok: false, error: 'That interview could not be found. Nothing was saved.' };
  if (!isUuid(interviewerUserId)) return { ok: false, error: 'Sign in to record an observation. Nothing was saved.' };
  if (!isIntelDimension(dimension)) {
    return { ok: false, error: 'Pick what kind of observation this is. Nothing was saved.' };
  }
  if (observation.length < MIN_WRITTEN_CHARS) {
    return {
      ok: false,
      error: 'Write at least a sentence. A note too short to be read back in six months is not a record. '
        + 'Nothing was saved.',
    };
  }

  const skillId = isUuid(input?.skillId || '') ? String(input.skillId) : null;
  const skillName = skillId ? clean(input?.skillName, 200) || null : null;
  const outcome: ObservationOutcome = skillId && isObservationOutcome(input?.outcome)
    ? (input.outcome as ObservationOutcome)
    : 'inconclusive';

  try {
    await ensureInterviewIntelSchema();
    const saved = rows(await db.execute(sql`
      INSERT INTO interview_intel_observations
        (interview_id, interviewer_user_id, dimension, requirement_skill_id, requirement_skill_name, outcome, observation)
      VALUES
        (${interviewId}::uuid, ${interviewerUserId}::uuid, ${dimension}, ${skillId}::uuid, ${skillName}, ${outcome}, ${observation})
      RETURNING id`));
    if (!saved.length) {
      return { ok: false, error: 'The observation did not write, and nothing on this interview has changed.' };
    }
    const id = String((saved[0] as any).id);

    await logAudit({
      userId: interviewerUserId,
      action: 'interview.intel.observation.record',
      entity: 'interview_round',
      entityId: interviewId,
      diff: { observationId: id, dimension, skillId, outcome },
    });

    return { ok: true, id, message: 'Recorded.' };
  } catch (e: any) {
    logFail('recordObservation', e);
    return { ok: false, error: 'The observation was not saved: ' + why(e) + '. Nothing has changed.' };
  }
}

/**
 * Remove an observation.
 *
 * ONLY ITS AUTHOR MAY. An interviewer's account of what they saw is theirs, and a hiring team that
 * can delete each other's observations does not have a record of an interview, it has a draft. The
 * ownership test is in the WHERE clause rather than in a branch above it, so a race cannot pass it.
 */
export async function removeObservation(observationId: string, actorUserId: string): Promise<WriteResult> {
  if (!isUuid(observationId)) return { ok: false, error: 'That observation could not be found.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to change an observation.' };
  try {
    await ensureInterviewIntelSchema();
    const gone = rows(await db.execute(sql`
      DELETE FROM interview_intel_observations
       WHERE id = ${observationId}::uuid AND interviewer_user_id = ${actorUserId}::uuid
       RETURNING id, interview_id`));
    if (!gone.length) {
      return {
        ok: false,
        error: 'Nothing was removed. An observation can only be removed by the interviewer who wrote it.',
      };
    }
    await logAudit({
      userId: actorUserId,
      action: 'interview.intel.observation.remove',
      entity: 'interview_round',
      entityId: String((gone[0] as any).interview_id),
      diff: { observationId },
    });
    return { ok: true, message: 'Removed.' };
  } catch (e: any) {
    logFail('removeObservation', e);
    return { ok: false, error: 'The observation was not removed: ' + why(e) };
  }
}

/** Every observation on one round, oldest first, with the interviewer named. */
export async function observationsFor(interviewId: string): Promise<{ present: boolean; items: ObservationRow[] }> {
  if (!isUuid(interviewId)) return { present: true, items: [] };
  try {
    await ensureInterviewIntelSchema();
    const r = rows(await db.execute(sql`
      SELECT o.*, COALESCE(u.name, u.email, 'An interviewer') AS interviewer_name
        FROM interview_intel_observations o
        LEFT JOIN users u ON u.id = o.interviewer_user_id
       WHERE o.interview_id = ${interviewId}::uuid
       ORDER BY o.recorded_at ASC
       LIMIT 500`));
    return { present: true, items: r.map(mapObservation) };
  } catch (e: any) {
    logFail('observationsFor', e);
    return { present: false, items: [] };
  }
}

/** Observations recorded on the OTHER rounds of the same application. Feeds contradiction 4. */
async function priorObservationsFor(applicationId: string, excludeInterviewId: string): Promise<{
  present: boolean;
  items: (ObservationRow & { roundNumber: number })[];
}> {
  if (!isUuid(applicationId)) return { present: true, items: [] };
  try {
    await ensureInterviewIntelSchema();
    const r = rows(await db.execute(sql`
      SELECT o.*, ir.round_number,
             COALESCE(u.name, u.email, 'An interviewer') AS interviewer_name
        FROM interview_intel_observations o
        JOIN interview_rounds ir ON ir.id = o.interview_id
        LEFT JOIN users u ON u.id = o.interviewer_user_id
       WHERE ir.application_id = ${applicationId}::uuid
         AND (${isUuid(excludeInterviewId) ? excludeInterviewId : null}::uuid IS NULL
              OR o.interview_id <> ${isUuid(excludeInterviewId) ? excludeInterviewId : null}::uuid)
       ORDER BY ir.round_number ASC, o.recorded_at ASC
       LIMIT 300`));
    return {
      present: true,
      items: r.map((x: any) => ({ ...mapObservation(x), roundNumber: Number(x.round_number || 1) })),
    };
  } catch (e: any) {
    logFail('priorObservationsFor', e);
    return { present: false, items: [] };
  }
}

// =================================================================================================
// THE FROZEN PROFILE
// =================================================================================================

export interface SnapshotProfile {
  requirements: { skillId: string; skillName: string; necessity: Necessity; minLevel: number | null }[];
  coverage: { skillId: string; status: CoverageStatus; level: number | null }[];
  countsByStatus: Record<string, number>;
  subjectResolution: string;
  refusesTotal: string;
}

export interface SnapshotRow {
  id: string;
  interviewId: string;
  applicationId: string | null;
  roleId: string | null;
  requirementCount: number;
  profile: SnapshotProfile;
  lockedByUserId: string | null;
  lockedByName: string | null;
  lockedAt: string | null;
}

const EMPTY_PROFILE: SnapshotProfile = {
  requirements: [],
  coverage: [],
  countsByStatus: {},
  subjectResolution: '',
  refusesTotal: '',
};

function mapSnapshot(x: any): SnapshotRow {
  let profile: SnapshotProfile = EMPTY_PROFILE;
  try {
    const raw = typeof x.profile === 'string' ? JSON.parse(x.profile) : x.profile;
    if (raw && typeof raw === 'object') profile = { ...EMPTY_PROFILE, ...(raw as SnapshotProfile) };
  } catch {
    // A snapshot whose JSON will not parse is a snapshot we cannot compare against. It comes back
    // empty rather than half-read, and predictedVsActual() then says there is nothing to compare.
    profile = EMPTY_PROFILE;
  }
  return {
    id: String(x.id),
    interviewId: String(x.interview_id),
    applicationId: x.application_id ? String(x.application_id) : null,
    roleId: x.role_id ? String(x.role_id) : null,
    requirementCount: Number(x.requirement_count || 0),
    profile,
    lockedByUserId: x.locked_by_user_id ? String(x.locked_by_user_id) : null,
    lockedByName: x.locked_by_name ? String(x.locked_by_name) : null,
    lockedAt: x.locked_at ? new Date(x.locked_at).toISOString() : null,
  };
}

/** The most recent lock on this round, or null when nobody has locked one. */
export async function latestSnapshot(interviewId: string): Promise<{ present: boolean; snapshot: SnapshotRow | null }> {
  if (!isUuid(interviewId)) return { present: true, snapshot: null };
  try {
    await ensureInterviewIntelSchema();
    const r = rows(await db.execute(sql`
      SELECT s.*, COALESCE(u.name, u.email) AS locked_by_name
        FROM interview_intel_snapshots s
        LEFT JOIN users u ON u.id = s.locked_by_user_id
       WHERE s.interview_id = ${interviewId}::uuid
       ORDER BY s.locked_at DESC
       LIMIT 1`));
    return { present: true, snapshot: r.length ? mapSnapshot(r[0]) : null };
  } catch (e: any) {
    logFail('latestSnapshot', e);
    return { present: false, snapshot: null };
  }
}

/**
 * Freeze the pre-interview picture.
 *
 * WHAT IS STORED IS WHAT WAS ON THE SCREEN, not a pointer to something that will be recomputed. The
 * requirement list, each requirement's coverage state and recorded level, and the sentence explaining
 * how this person's records were reached. Nothing else — no name, no contact detail, no free text
 * from the application, and none of the three birth columns.
 *
 * A SECOND LOCK DOES NOT OVERWRITE THE FIRST. Rows accumulate and the latest is used, so an
 * interviewer briefed last week can still be shown what they were shown.
 */
export async function lockInitialProfile(interviewId: string, actorUserId: string): Promise<WriteResult> {
  if (!isUuid(interviewId)) return { ok: false, error: 'That interview could not be found.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'Sign in to lock a profile.' };

  const brief = await buildInterviewBrief(interviewId);
  if (!brief.interview) {
    return {
      ok: false,
      error: brief.error
        ? 'The interview could not be read, so nothing was locked: ' + brief.error
        : 'That interview could not be found, so nothing was locked.',
    };
  }
  if (!brief.coverage || brief.requirementsState !== 'ok') {
    return {
      ok: false,
      error: 'There is nothing to freeze yet. ' + (brief.requirementsNote
        || 'This job has no requirements expressed in the skill catalogue, so there is no prediction to '
        + 'compare an interview against.'),
    };
  }

  const profile: SnapshotProfile = {
    requirements: brief.requirements.map((r) => ({
      skillId: r.skillId,
      skillName: r.skillName,
      necessity: r.necessity,
      minLevel: r.minLevel,
    })),
    coverage: brief.coverage.rows.map((c) => ({ skillId: c.skillId, status: c.status, level: c.level })),
    countsByStatus: brief.coverage.counts as unknown as Record<string, number>,
    subjectResolution: brief.subject ? brief.subject.resolution : brief.subjectNote,
    refusesTotal: brief.coverage.refusesTotal,
  };

  try {
    await ensureInterviewIntelSchema();
    const saved = rows(await db.execute(sql`
      INSERT INTO interview_intel_snapshots
        (interview_id, application_id, role_id, subject_resolution, requirement_count, profile, locked_by_user_id)
      VALUES
        (${interviewId}::uuid,
         ${brief.interview.applicationId}::uuid,
         ${brief.interview.roleId}::uuid,
         ${profile.subjectResolution},
         ${profile.requirements.length},
         ${JSON.stringify(profile)}::jsonb,
         ${actorUserId}::uuid)
      RETURNING id`));
    if (!saved.length) return { ok: false, error: 'The profile did not write. Nothing has been frozen.' };
    const id = String((saved[0] as any).id);

    await logAudit({
      userId: actorUserId,
      action: 'interview.intel.profile.lock',
      entity: 'interview_round',
      entityId: interviewId,
      diff: { snapshotId: id, requirementCount: profile.requirements.length },
    });

    return {
      ok: true,
      id,
      message: 'The pre-interview picture is frozen. What you record from here can be compared against it.',
    };
  } catch (e: any) {
    logFail('lockInitialProfile', e);
    return { ok: false, error: 'The profile was not frozen: ' + why(e) };
  }
}

// =================================================================================================
// THE BRIEF
// =================================================================================================

export interface InterviewBrief {
  /** False when the interview tables were never created on this database. Not "no interviews". */
  tablesPresent: boolean;
  interview: InterviewRef | null;
  subject: CoverageSubject | null;
  /** How this person's records were reached, or why they could not be. Always printed. */
  subjectNote: string;
  requirementsState: 'ok' | 'not_configured' | 'unreadable' | 'no_role';
  requirementsNote: string;
  requirements: Requirement[];
  coverage: Coverage | null;
  /** Requirements a checked record already covers. The interview does not need to establish these. */
  strengths: CoverageRow[];
  /** Requirements nothing demonstrates. This is what the hour is for. */
  requiresValidation: CoverageRow[];
  probes: Probe[];
  contradictions: Contradiction[];
  priorRounds: PriorRound[];
  priorRoundsPresent: boolean;
  snapshot: SnapshotRow | null;
  /**
   * False when the snapshot table could not be read. Distinct from `snapshot === null`, which means
   * nobody has frozen one — an outage and an unfrozen round are opposite facts.
   */
  snapshotPresent: boolean;
  /** Printed where a reader expects a verdict. Always. */
  refusesVerdict: string;
  recordsNotPeople: string;
  provenance: Provenance;
  error: string | null;
}

function emptyBrief(): InterviewBrief {
  return {
    tablesPresent: true,
    interview: null,
    subject: null,
    subjectNote: '',
    requirementsState: 'no_role',
    requirementsNote: '',
    requirements: [],
    coverage: null,
    strengths: [],
    requiresValidation: [],
    probes: [],
    contradictions: [],
    priorRounds: [],
    priorRoundsPresent: true,
    snapshot: null,
    snapshotPresent: true,
    refusesVerdict: BRIEF_REFUSES_A_VERDICT,
    recordsNotPeople: RECORDS_NOT_PEOPLE,
    provenance: {
      inputs: [],
      processing: 'Nothing was assembled.',
      output: 'Nothing.',
      evidence: [],
      confidence: DETERMINISTIC_CONFIDENCE,
      timestamp: new Date().toISOString(),
    },
    error: null,
  };
}

/**
 * EVERYTHING AN INTERVIEWER IS SHOWN BEFORE THE INTERVIEW, IN ONE CALL. Reads only.
 *
 * The chain of facts, every link refusable and every refusal a different sentence:
 *
 *   round -> application -> job -> the job's requirements in the skill catalogue
 *                        -> the person record -> what those requirements are covered by
 *                        -> the earlier rounds of this same application
 *
 * WHERE A LINK IS MISSING THE BRIEF SAYS WHICH ONE. "This job has no requirements mapped yet" and
 * "this candidate has nothing on record" are opposite facts with the same empty screen, and an
 * interviewer who cannot tell them apart will read the second one into the first.
 */
export async function buildInterviewBrief(interviewId: string): Promise<InterviewBrief> {
  const out = emptyBrief();
  const inputs: string[] = [];
  const evidence: string[] = [];

  const loaded = await loadInterview(interviewId);
  out.tablesPresent = loaded.tablesPresent;
  out.interview = loaded.ref;
  out.error = loaded.error;
  if (!loaded.tablesPresent) {
    out.requirementsNote = 'The interview tables are not present on this database, so nothing could be read.';
    return out;
  }
  if (!loaded.ref) return out;
  inputs.push('interview_rounds (round ' + loaded.ref.roundNumber + ')');

  const snap = await latestSnapshot(interviewId);
  out.snapshot = snap.snapshot;
  out.snapshotPresent = snap.present;

  if (!loaded.ref.applicationId) {
    out.requirementsState = 'no_role';
    out.requirementsNote = 'This round is not attached to an application, so there is no job to read '
      + 'requirements from and no candidate record to compare against.';
    out.provenance = {
      inputs,
      processing: 'The round was read and no application was attached to it, so nothing further could be assembled.',
      output: 'An empty brief, and the reason it is empty.',
      evidence,
      confidence: DETERMINISTIC_CONFIDENCE,
      timestamp: new Date().toISOString(),
    };
    return out;
  }
  inputs.push('applications');

  // The person, resolved through the module that owns identity resolution. Never by matching email.
  const subjectRead = await subjectFor('application', loaded.ref.applicationId);
  out.subject = subjectRead.data;
  out.subjectNote = subjectRead.data ? subjectRead.data.resolution : subjectRead.sentence;
  if (subjectRead.data) inputs.push('the person record for this application');

  // Earlier rounds. Read regardless of whether requirements are mapped — a previous panel's verdict
  // matters to this interviewer even on a job nobody has mapped to the catalogue yet.
  const prior = await priorScorecardsFor(loaded.ref.applicationId, interviewId);
  out.priorRounds = prior.rounds;
  out.priorRoundsPresent = prior.present;
  if (prior.rounds.length) {
    inputs.push('interview_scorecards on earlier rounds');
    evidence.push(prior.rounds.length + ' scorecard(s) recorded on earlier rounds of this application.');
  }
  const priorObs = await priorObservationsFor(loaded.ref.applicationId, interviewId);
  if (priorObs.items.length) {
    inputs.push('interview observations from earlier rounds');
    evidence.push(priorObs.items.length + ' observation(s) recorded by interviewers on earlier rounds.');
  }

  if (!loaded.ref.roleId) {
    out.requirementsState = 'no_role';
    out.requirementsNote = 'This application does not point at a job record, so this role has no '
      + 'requirements to read. The role title on the application is a snapshot of text, and text on a '
      + 'form cannot be compared against a capability record.';
  } else {
    const reqRead = await requirementsFor(loaded.ref.roleId);
    out.requirements = reqRead.data;
    out.requirementsNote = reqRead.sentence;
    out.requirementsState =
      reqRead.state === 'ok' ? 'ok'
      : reqRead.state === 'unreadable' ? 'unreadable'
      : 'not_configured';
    if (reqRead.state === 'ok') {
      inputs.push('hr_role_requirements for this job');
      evidence.push(reqRead.data.length + ' requirement(s) authored for this job in the skill catalogue.');
    }
  }

  if (out.requirementsState === 'ok' && out.subject) {
    const coverage = await coverageFor(loaded.ref.roleId as string, out.subject);
    out.coverage = coverage;
    inputs.push('the capability records behind each requirement');

    out.strengths = coverage.rows.filter((r) => r.status === 'evidenced');
    out.requiresValidation = coverage.rows.filter(
      (r) => r.status !== 'evidenced' && (r.necessity === 'essential' || r.necessity === 'important'),
    );
    evidence.push(
      coverage.counts.evidenced + ' requirement(s) carry a checked record; '
      + coverage.counts.stated + ' are stated only; '
      + coverage.counts.nothing + ' have nothing on record.',
    );

    const covLite = coverage.rows.map((r) => ({ skillId: r.skillId, status: r.status, level: r.level }));
    const byId = new Map(covLite.map((c) => [c.skillId, c]));
    out.probes = sortProbes(out.requirements.map((r) => probeFor(
      { skillId: r.skillId, skillName: r.skillName, necessity: r.necessity, minLevel: r.minLevel },
      byId.get(r.skillId) || null,
    )));

    out.contradictions = findContradictions({
      requirements: out.requirements.map((r) => ({
        skillId: r.skillId, skillName: r.skillName, necessity: r.necessity, minLevel: r.minLevel,
      })),
      coverage: covLite,
      priorScorecards: prior.rounds.map((p) => ({
        roundNumber: p.roundNumber, interviewerName: p.interviewerName, recommendation: p.recommendation,
      })),
      priorObservations: priorObs.items.map((o) => ({
        roundNumber: o.roundNumber,
        interviewerName: o.interviewerName,
        skillId: o.skillId,
        skillName: o.skillName,
        outcome: o.outcome,
        observation: o.observation,
      })),
    });
  } else {
    // No requirement list means no coverage view and no probes derived from one. The earlier-round
    // contradictions do not depend on requirements, so they are still assembled.
    out.contradictions = findContradictions({
      requirements: [],
      coverage: [],
      priorScorecards: prior.rounds.map((p) => ({
        roundNumber: p.roundNumber, interviewerName: p.interviewerName, recommendation: p.recommendation,
      })),
      priorObservations: [],
    });
  }

  out.provenance = {
    inputs,
    processing: 'Each requirement authored for this job was matched to the capability records held for this '
      + 'person, and each pairing produced one named coverage state. Probes were derived from that state by a '
      + 'fixed rule per state, and contradictions by comparing pairs of stored rows. Nothing was scored, '
      + 'ranked, weighted or totalled, and no language model was involved.',
    output: 'A requirement list, what evidences each one, what does not, a suggested probe per requirement, '
      + 'and every place two stored records disagree.',
    evidence,
    confidence: DETERMINISTIC_CONFIDENCE,
    timestamp: new Date().toISOString(),
  };
  return out;
}

// =================================================================================================
// PREDICTED VERSUS ACTUAL
// =================================================================================================

export interface PredictedVsActual {
  /** Null when nobody locked a profile. The comparison then cannot be made, and says so. */
  snapshot: SnapshotRow | null;
  items: Reconciled[];
  /** Observations that named no requirement. Shown, never counted against a requirement. */
  unattached: ObservationRow[];
  /** How many requirements the room superseded the record on. A count of rows, not a score. */
  overrideCount: number;
  /** How many requirements two interviewers recorded opposite findings on. Never folded into the above. */
  disagreementCount: number;
  note: string;
  observationGoverns: string;
  provenance: Provenance;
}

/**
 * THE COMPARISON THE INTERVIEWER SIGNS.
 *
 * Predicted comes from the frozen snapshot and is never recomputed here — recomputing it would
 * compare the room against a record that has moved since, which is the one thing the freeze exists
 * to prevent.
 *
 * `preloaded` EXISTS FOR ROUND-TRIP COUNT, WHICH IS THE LEVER ON THIS DATABASE. The console needs
 * the snapshot and the observations for its other panels anyway; without this parameter rendering one
 * page read both twice, and at max:1 pooling two extra sequential round trips are two extra round
 * trips of latency, not two extra queries in parallel. Callers that have the rows pass them; callers
 * that do not get the same answer, one call later.
 */
export async function predictedVsActual(
  interviewId: string,
  preloaded?: {
    snapshot?: { present: boolean; snapshot: SnapshotRow | null };
    observations?: { present: boolean; items: ObservationRow[] };
  },
): Promise<PredictedVsActual> {
  const base: PredictedVsActual = {
    snapshot: null,
    items: [],
    unattached: [],
    overrideCount: 0,
    disagreementCount: 0,
    note: '',
    observationGoverns: OBSERVATION_GOVERNS,
    provenance: {
      inputs: [],
      processing: 'Nothing was compared.',
      output: 'Nothing.',
      evidence: [],
      confidence: DETERMINISTIC_CONFIDENCE,
      timestamp: new Date().toISOString(),
    },
  };
  if (!isUuid(interviewId)) return base;

  const snap = preloaded?.snapshot || await latestSnapshot(interviewId);
  const obs = preloaded?.observations || await observationsFor(interviewId);
  base.snapshot = snap.snapshot;

  if (!snap.present || !obs.present) {
    base.note = 'The interview intelligence records could not be read just now, so no comparison is shown. '
      + 'This is an outage, and nothing about this candidate should be read into it.';
    return base;
  }

  base.unattached = obs.items.filter((o) => !o.skillId);

  if (!snap.snapshot || !snap.snapshot.profile.requirements.length) {
    base.note = snap.snapshot
      ? 'A profile was frozen for this round but it held no requirements, so there is nothing to compare '
        + 'the interview against. Everything recorded in the room is listed under "Recorded so far".'
      : 'No pre-interview profile was frozen for this round, so there is nothing to compare against. '
        + 'Everything recorded in the room is listed under "Recorded so far". An assessment can still be '
        + 'completed; its alignment will be recorded as having had no prior picture, because there was none.';
    // `unattached` stays what it says it is — observations that named no requirement — in EVERY
    // branch. Widening it to "all of them" here duplicated the whole observation list on the console
    // under a heading that was then untrue of most of the rows in it.
    base.provenance = {
      inputs: ['interview_intel_observations'],
      processing: 'There was no frozen profile, so no requirement could be compared. Observations are listed as '
        + 'recorded.',
      output: obs.items.length + ' observation(s), unattached to any prediction.',
      evidence: [],
      confidence: DETERMINISTIC_CONFIDENCE,
      timestamp: new Date().toISOString(),
    };
    return base;
  }

  const predictedBySkill = new Map<string, CoverageStatus>();
  for (const c of snap.snapshot.profile.coverage) predictedBySkill.set(c.skillId, c.status);

  const bySkill = new Map<string, (ObservationRef & { dimension: string })[]>();
  for (const o of obs.items) {
    if (!o.skillId) continue;
    const list = bySkill.get(o.skillId) || [];
    list.push({
      id: o.id,
      interviewerName: o.interviewerName,
      outcome: o.outcome,
      dimension: o.dimension,
      observation: o.observation,
      recordedAt: o.recordedAt,
    });
    bySkill.set(o.skillId, list);
  }

  base.items = snap.snapshot.profile.requirements.map((r) => reconcileRequirement(
    { skillId: r.skillId, skillName: r.skillName, necessity: r.necessity },
    predictedBySkill.get(r.skillId) || 'nothing',
    bySkill.get(r.skillId) || [],
  ));
  base.overrideCount = base.items.filter((i) => i.overrides).length;
  base.disagreementCount = base.items.filter((i) => i.state === 'interviewers_disagree').length;

  const examined = base.items.filter((i) => i.state !== 'not_examined').length;
  base.note = examined + ' of ' + base.items.length + ' requirement(s) had something recorded against them in '
    + 'this interview. ' + (base.overrideCount
      ? base.overrideCount + ' of those disagreed with what the record predicted, and on those the interview '
        + 'governs.'
      : 'None of them disagreed with what the record predicted.')
    + (base.disagreementCount
      ? ' On ' + base.disagreementCount + ' of them two interviewers recorded opposite findings; those are '
        + 'unresolved and are not counted as the interview having settled anything.'
      : '')
    + ' There is no total here: a requirement is a separate question and a count of answers is not a verdict.';

  base.provenance = {
    inputs: [
      'interview_intel_snapshots (the profile frozen ' + (snap.snapshot.lockedAt || 'at lock time') + ')',
      'interview_intel_observations (this round)',
    ],
    processing: 'For each frozen requirement, the observations naming it were read. Competency and technical '
      + 'observations can supersede the prediction; the other six dimensions are shown beside it and do not '
      + 'move it. Where two interviewers disagreed, neither was preferred.',
    output: 'One reconciled position per requirement, each naming the interviewer whose observation produced it.',
    evidence: base.items
      .filter((i) => i.overrides)
      .map((i) => i.skillName + ': ' + i.sentence),
    confidence: DETERMINISTIC_CONFIDENCE,
    timestamp: new Date().toISOString(),
  };
  return base;
}

// =================================================================================================
// COMPLETION
// =================================================================================================

export interface AssessmentRow {
  id: string;
  interviewId: string;
  interviewerUserId: string;
  interviewerName: string;
  recommendation: IntelRecommendation;
  recommendationLabel: string;
  supportingEvidence: string;
  writtenFeedback: string;
  conditions: string | null;
  alignment: Alignment;
  alignmentLabel: string;
  alignmentNote: string | null;
  snapshotId: string | null;
  submittedAt: string | null;
}

function mapAssessment(x: any): AssessmentRow {
  const recommendation = (isIntelRecommendation(x.recommendation) ? x.recommendation : 'further_assessment_required') as IntelRecommendation;
  const alignment = (isAlignment(x.alignment) ? x.alignment : 'no_prior_intelligence') as Alignment;
  return {
    id: String(x.id),
    interviewId: String(x.interview_id),
    interviewerUserId: String(x.interviewer_user_id || ''),
    interviewerName: String(x.interviewer_name || 'An interviewer'),
    recommendation,
    recommendationLabel: recommendationLabel(recommendation),
    supportingEvidence: String(x.supporting_evidence || ''),
    writtenFeedback: String(x.written_feedback || ''),
    conditions: x.conditions ? String(x.conditions) : null,
    alignment,
    alignmentLabel: alignmentLabel(alignment),
    alignmentNote: x.alignment_note ? String(x.alignment_note) : null,
    snapshotId: x.snapshot_id ? String(x.snapshot_id) : null,
    submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null,
  };
}

export interface RecordAssessmentInput {
  interviewId: string;
  interviewerUserId: string;
  recommendation: string;
  supportingEvidence: string;
  writtenFeedback: string;
  conditions?: string | null;
  alignment: string;
  alignmentNote?: string | null;
}

/**
 * The interviewer's completion record. ONE ROW. It decides nothing.
 *
 * WHAT IS REFUSED, AND WHY EACH REFUSAL IS WORTH THE FRICTION:
 *
 *   a recommendation off the five        stored, unfilterable, describable by no screen
 *   evidence shorter than a sentence     a recommendation whose basis nobody can read later is an
 *                                        opinion with a label on it, and this is the field that
 *                                        makes it not one
 *   feedback shorter than a sentence     this is what a person is eventually told
 *   conditions missing on the two        "recommend with conditions" and "further assessment
 *   recommendations that name one        required" both name something outstanding; not saying what
 *                                        it is turns both into a soft no that nobody can act on
 *   alignment off the four               the field exists to catch the record being wrong about
 *                                        somebody, and an unparseable value catches nothing
 *
 * ALIGNMENT IS FORCED TO `no_prior_intelligence` WHEN NO PROFILE WAS FROZEN. Not refused — recorded
 * truthfully. An interviewer cannot have agreed or disagreed with a picture that was never pinned,
 * and letting the form claim otherwise would put an unearned corroboration on the record.
 */
export async function recordAssessment(input: RecordAssessmentInput): Promise<WriteResult> {
  const interviewId = clean(input?.interviewId, 60);
  const interviewerUserId = clean(input?.interviewerUserId, 60);
  if (!isUuid(interviewId)) return { ok: false, error: 'That interview could not be found. Nothing was saved.' };
  if (!isUuid(interviewerUserId)) return { ok: false, error: 'Sign in to complete an interview. Nothing was saved.' };

  const recommendation = clean(input?.recommendation, 40);
  if (!isIntelRecommendation(recommendation)) {
    return { ok: false, error: 'Pick one of the five recommendations. Nothing was saved.' };
  }

  const supportingEvidence = clean(input?.supportingEvidence, 4000);
  if (supportingEvidence.length < MIN_WRITTEN_CHARS) {
    return {
      ok: false,
      error: 'Write down what supports this recommendation. A recommendation whose basis nobody can read '
        + 'back later is an opinion with a label on it. Nothing was saved.',
    };
  }

  const writtenFeedback = clean(input?.writtenFeedback, 6000);
  if (writtenFeedback.length < MIN_WRITTEN_CHARS) {
    return { ok: false, error: 'Write the final feedback. Nothing was saved.' };
  }

  const conditions = clean(input?.conditions, 2000);
  if (requiresConditions(recommendation) && conditions.length < MIN_WRITTEN_CHARS) {
    return {
      ok: false,
      error: 'You picked a recommendation that names something outstanding, so say what it is. Without it '
        + 'this reads as a soft no that nobody can act on. Nothing was saved.',
    };
  }

  const requestedAlignment = clean(input?.alignment, 30);
  if (!isAlignment(requestedAlignment)) {
    return { ok: false, error: 'Say whether what you saw matched the pre-interview picture. Nothing was saved.' };
  }

  try {
    await ensureInterviewIntelSchema();

    const snap = await latestSnapshot(interviewId);
    const alignment: Alignment = snap.snapshot ? (requestedAlignment as Alignment) : 'no_prior_intelligence';
    const forced = alignment !== requestedAlignment;

    const obs = await observationsFor(interviewId);
    const mine = obs.items.filter((o) => o.interviewerUserId === interviewerUserId).length;

    const saved = rows(await db.execute(sql`
      INSERT INTO interview_intel_assessments
        (interview_id, interviewer_user_id, recommendation, supporting_evidence, written_feedback,
         conditions, alignment, alignment_note, snapshot_id)
      VALUES
        (${interviewId}::uuid, ${interviewerUserId}::uuid, ${recommendation}, ${supportingEvidence},
         ${writtenFeedback}, ${conditions || null}, ${alignment}, ${clean(input?.alignmentNote, 2000) || null},
         ${snap.snapshot ? snap.snapshot.id : null}::uuid)
      ON CONFLICT (interview_id, interviewer_user_id) DO UPDATE SET
        recommendation = EXCLUDED.recommendation,
        supporting_evidence = EXCLUDED.supporting_evidence,
        written_feedback = EXCLUDED.written_feedback,
        conditions = EXCLUDED.conditions,
        alignment = EXCLUDED.alignment,
        alignment_note = EXCLUDED.alignment_note,
        snapshot_id = COALESCE(EXCLUDED.snapshot_id, interview_intel_assessments.snapshot_id),
        updated_at = NOW()
      RETURNING id`));

    if (!saved.length) {
      return { ok: false, error: 'The assessment did not write, and nothing on this interview has changed.' };
    }
    const id = String((saved[0] as any).id);

    await logAudit({
      userId: interviewerUserId,
      action: 'interview.intel.assessment.record',
      entity: 'interview_round',
      entityId: interviewId,
      diff: {
        assessmentId: id,
        recommendation,
        alignment,
        alignmentForced: forced,
        snapshotId: snap.snapshot ? snap.snapshot.id : null,
        observationsByThisInterviewer: mine,
      },
    });

    // The message says what did NOT happen, because that is the part somebody will otherwise assume.
    let message = 'Recorded. ' + NO_AUTOMATIC_DECISION;
    if (forced) {
      message += ' No pre-interview profile was frozen for this round, so alignment was recorded as '
        + 'having had no prior picture to compare against.';
    }
    if (!mine) {
      message += ' You recorded no observations against individual requirements during this interview, so '
        + 'the predicted-versus-actual comparison has nothing of yours in it.';
    }
    return { ok: true, id, message };
  } catch (e: any) {
    logFail('recordAssessment', e);
    return { ok: false, error: 'The assessment was not saved: ' + why(e) + '. Nothing has changed.' };
  }
}

/** Every completion record on one round. The hiring team reads all of them side by side. */
export async function assessmentsFor(interviewId: string): Promise<{ present: boolean; items: AssessmentRow[] }> {
  if (!isUuid(interviewId)) return { present: true, items: [] };
  try {
    await ensureInterviewIntelSchema();
    const r = rows(await db.execute(sql`
      SELECT a.*, COALESCE(u.name, u.email, 'An interviewer') AS interviewer_name
        FROM interview_intel_assessments a
        LEFT JOIN users u ON u.id = a.interviewer_user_id
       WHERE a.interview_id = ${interviewId}::uuid
       ORDER BY a.submitted_at ASC
       LIMIT 100`));
    return { present: true, items: r.map(mapAssessment) };
  } catch (e: any) {
    logFail('assessmentsFor', e);
    return { present: false, items: [] };
  }
}

// =================================================================================================
// ONE CALL FOR THE CONSOLE
// =================================================================================================

export interface IntelBundle {
  brief: InterviewBrief;
  observations: ObservationRow[];
  observationsPresent: boolean;
  /** This viewer's own completion record, when they have written one. */
  myAssessment: AssessmentRow | null;
  assessments: AssessmentRow[];
  assessmentsPresent: boolean;
  comparison: PredictedVsActual;
}

/**
 * Everything the interviewer console renders, in one call.
 *
 * `viewerUserId` picks out this viewer's own assessment for the form to pre-fill. It is NOT an
 * authorisation test and must never be read as one: whether somebody may open this console is
 * decided by the section gate on the page.
 */
export async function intelBundle(interviewId: string, viewerUserId: string | null): Promise<IntelBundle> {
  const brief = await buildInterviewBrief(interviewId);
  const obs = await observationsFor(interviewId);
  const assess = await assessmentsFor(interviewId);
  // The snapshot and the observations are already in hand. Handing them over saves two sequential
  // round trips on a page that is opened during a live interview.
  const comparison = await predictedVsActual(interviewId, {
    snapshot: { present: brief.snapshotPresent, snapshot: brief.snapshot },
    observations: obs,
  });
  const mine = isUuid(viewerUserId || '')
    ? assess.items.find((a) => a.interviewerUserId === viewerUserId) || null
    : null;
  return {
    brief,
    observations: obs.items,
    observationsPresent: obs.present,
    myAssessment: mine,
    assessments: assess.items,
    assessmentsPresent: assess.present,
    comparison,
  };
}

// =================================================================================================
// THE HANDOFF — WHAT THIS PATCH OFFERS THE CAPABILITY GRAPH, AND WHY IT DOES NOT WRITE IT ITSELF
// =================================================================================================
//
// An interview produces the strongest evidence this system ever collects: a named human watching
// another human do the thing, and writing down what they saw. It belongs in the capability graph.
//
// IT IS NOT WRITTEN THERE BY THIS FILE, for one concrete reason. src/lib/evidence-graph.ts declares
// EVIDENCE_KINDS, and every kind carries the ceiling of what it may support and what has to happen
// before it supports it. There is no interview-shaped kind in that list today. Adding one from here
// would be editing another module's owned vocabulary from outside it, and inventing a kind string
// that module does not know would attach evidence it cannot classify, cannot cap and cannot explain.
//
// So this module exposes the rows, shaped and ready, and the graph's owner decides.
//
// TO CONSUME THIS, the capability-graph owner needs to add one kind — suggested shape:
//
//     { kind: 'interview_observation',
//       label: 'Observed in an interview',
//       supports: 'demonstrated',        // NOT professionally_demonstrated: an interview is an
//                                        // account of work, not the work, and the named human is
//                                        // vouching for what they heard rather than for the work
//                                        // itself
//       needs: 'human_verdict' }         // which the observation already is: attributed, written,
//                                        // and dated
//
// and then, per row returned here, call attachEvidence() with kind `interview_observation`,
// ownerModule `interview-intelligence`, sourceTable `interview_intel_observations`, sourceId the
// observation id, locator the round, and recordVerification() with `verdict` and `reason` as given.
//
// NOTHING IS EXPORTED FOR AN OUTCOME OF `inconclusive`, and nothing is exported for a non-evidential
// dimension. An impression of somebody's communication is a real record and it is not evidence that
// they hold a capability; sending it as evidence would put it on a ladder it does not belong on.

export interface ExportableEvidence {
  observationId: string;
  /** The subject as the graph names one. `candidate` while this is an application. */
  subjectKind: 'candidate';
  subjectId: string;
  skillId: string;
  skillName: string;
  /** The graph's vocabulary, via toGraphVerdict(). */
  verdict: 'supports' | 'does_not_support';
  reason: string;
  ownerModule: string;
  sourceTable: string;
  sourceId: string;
  locator: string;
  occurredAt: string | null;
  verifierUserId: string;
  verifierName: string;
}

/**
 * Interview observations shaped for the capability graph, for whenever it is ready to take them.
 *
 * READS ONLY. It writes nothing anywhere, and calling it has no side effect on this module's tables
 * or on anybody else's.
 */
export async function exportableEvidence(interviewId: string): Promise<{
  present: boolean;
  items: ExportableEvidence[];
  note: string;
}> {
  const loaded = await loadInterview(interviewId);
  if (!loaded.ref || !loaded.ref.applicationId) {
    return {
      present: loaded.tablesPresent,
      items: [],
      note: 'This round is not attached to an application, so there is no subject to attach evidence to.',
    };
  }
  const obs = await observationsFor(interviewId);
  if (!obs.present) {
    return { present: false, items: [], note: 'The observations could not be read, so nothing is offered.' };
  }
  const items: ExportableEvidence[] = obs.items
    .filter((o) => o.skillId && o.outcome !== 'inconclusive' && isEvidentialDimension(o.dimension))
    .map((o) => ({
      observationId: o.id,
      subjectKind: 'candidate' as const,
      subjectId: String(loaded.ref!.applicationId),
      skillId: String(o.skillId),
      skillName: o.skillName || 'A requirement',
      verdict: toGraphVerdict(o.outcome) as 'supports' | 'does_not_support',
      reason: o.observation,
      ownerModule: MOD,
      sourceTable: 'interview_intel_observations',
      sourceId: o.id,
      locator: 'Round ' + loaded.ref!.roundNumber + (loaded.ref!.roundType ? ' (' + loaded.ref!.roundType + ')' : ''),
      occurredAt: o.recordedAt,
      verifierUserId: o.interviewerUserId,
      verifierName: o.interviewerName,
    }));
  return {
    present: true,
    items,
    note: items.length
      ? items.length + ' observation(s) are shaped for the capability graph. Nothing has been written to it: '
        + 'no interview-shaped evidence kind exists there yet. See THE HANDOFF in src/lib/interview-intelligence.ts.'
      : 'No observation on this round is exportable. Only competency and technical observations that named a '
        + 'requirement and reached a verdict are offered.',
  };
}
