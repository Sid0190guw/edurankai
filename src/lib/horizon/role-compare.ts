// src/lib/horizon/role-compare.ts — PATCH 16. ONE PERSON, SEVERAL ROLES, SIDE BY SIDE, NOTHING RANKED.
//
// =================================================================================================
// WHAT THIS IS, AND THE ONE THING IT DOES THAT NOTHING ELSE DOES
// =================================================================================================
//
// src/lib/match.ts already compares ONE person to ONE job and returns a MatchExplanation carrying
// the whole chain behind it. This module does not reimplement one line of that and could not if it
// wanted to: MatchExplanation is branded with a Symbol that match.ts does not export, so no other
// module in this repository can construct an unexplained reading. Every fit figure that appears here
// came out of evaluate() in that file.
//
// WHAT IS NEW HERE IS THE SECOND AXIS. A person against four roles is not four readings printed near
// each other. It is a comparison, and a comparison invites the two things a single reading cannot do
// wrong:
//
//   RANKING          four figures in a column is a leaderboard of somebody's future, and the reader
//                    will take the top row as the answer. compareRoles() returns `refusesRanking`,
//                    and there is no function in this file that orders roles by fit, sums across
//                    them, or names a best one.
//
//   FORECASTING      "which role will they grow into" is a prediction about a person.
//                    src/lib/digital-twin.ts already refuses to hold one — its trajectory carries
//                    `prediction: null` with the note that the field is not created to hold one.
//                    Nothing here creates it either. A future leadership role in this comparison is
//                    A ROLE THAT EXISTS, WITH REQUIREMENTS SOMEBODY WROTE DOWN, read against what
//                    this person has evidenced TODAY. That is a distance, not a destiny.
//
// =================================================================================================
// PATCH 06 IS CONSUMED, NOT REBUILT
// =================================================================================================
//
// src/lib/horizon/contract.ts records flow 5, "multiple sources to fusion", as producer
// src/lib/person-spine.ts and consumer src/lib/digital-twin.ts, and flow 6, "fusion to profile
// update", as `by_design_absent`: composition is a READ and writes nothing back.
//
// Both of those are honoured literally here. The composed person arrives through the FusionSource
// interface below and this module writes nothing about anybody — no profile row, no evidence row, no
// skill level. Swapping the fusion implementation is a one-line change at the call site and touches
// nothing else in this file.
//
// =================================================================================================
// TWO WORDS THE BRIEF ASKED FOR THAT THIS SYSTEM ALREADY REFUSES, AND WHAT IS RETURNED INSTEAD
// =================================================================================================
//
// src/lib/person-assertions.ts holds REFUSED_SUBJECTS, and `potential` is on it, with the reason:
// "Potential has no definition here that is not a proxy for who somebody reminds a manager of."
// assertAllowedAboutPerson('growth potential') and ('leadership potential') both come back refused,
// and that refusal is not routed around here — it is CALLED, and its sentence is carried onto the
// output so the screen prints why the column somebody might have expected is not there.
//
// What is returned instead is the honest half of each, and the difference is WHO THE STATEMENT IS
// ABOUT:
//
//   growth potential        a trait of a person.        REFUSED.
//   growth headroom         a distance between what THIS ROLE asks for and what is on record today,
//                           counted in named requirements. A statement about the gap.
//
//   leadership potential    a trait of a person.        REFUSED.
//   leadership requirement  which of THIS ROLE'S OWN requirements name a leadership capability, and
//   coverage                what is evidenced against those. A statement about the role.
//
// Neither is a score about a human. If somebody later wants the refused version, they will have to
// delete a named call to a named refusal rather than simply not notice a rule.
//
// =================================================================================================
// WHAT "SUSTAINABILITY" MEANS HERE, BECAUSE IT COULD MEAN SOMETHING MUCH WORSE
// =================================================================================================
//
// It does not mean "will this person last in this role". That is a prediction about a human and it
// could only be built out of attendance and activity, which is the surveillance inference rule 26
// and this codebase both refuse.
//
// It means: HOW DURABLE IS THIS READING. How much of it rests on records this platform checked
// rather than words somebody typed; how old the evidence is; and what the ROLE itself records about
// its own terms — a fixed-term engagement is a different long-term proposition from an ongoing one,
// and that is a fact about the role's own row.
//
// =================================================================================================
// TWO PATCH NUMBERINGS EXIST IN THIS TREE, AND THIS FILE REPORTS THAT RATHER THAN PICKING ONE
// =================================================================================================
//
// src/lib/fusion/horizon-bridge.ts already records the disagreement: src/lib/horizon/sections.ts
// numbers PATCH-06 as Work Sustainability, while the brief src/lib/fusion was built to numbers 06 as
// the fusion engine. This patch was briefed to "consume PATCH 06 fusion through interfaces", and it
// does so under EITHER reading, which is why nothing here has to guess:
//
//   - If 06 is the FUSION ENGINE, it is consumed through FusionSource below and none of it is
//     reimplemented. `src/lib/fusion` exposes buildProfile() and its own public surface in
//     src/lib/fusion/index.ts; the seam here takes whatever composes the person, and swapping the
//     implementation is a one-line change at the call site.
//   - If 06 is WORK SUSTAINABILITY, nothing here duplicates that either. See the warning below.
//
// THE ONE REAL COLLISION HAZARD IS A WORD, AND IT IS NOT A COLLISION.
//
// `sustainability` on a RoleReading is NOT the `work_sustainability` section that sections.ts owes to
// another patch. They are different subjects that share an adjective:
//
//   work_sustainability (theirs)  a reading of a PERSON'S WORKING PATTERN from organisational
//                                 records, offered as a prompt to talk to them.
//   sustainability (here)         how durable THIS READING IS — how much of it rests on checked
//                                 records rather than typed words, how old the evidence is, and what
//                                 the ROLE records about its own terms.
//
// Nothing in this module reads attendance, leave, hours or any working-pattern signal, and
// `isNotAForecast` says so on every instance. Do not merge the two, and do not let this field be
// wired into that section: it would answer a question about a role with a sentence about a person.
//
// This module claims NO section key in the horizon registry. There is no role-comparison section in
// sections.ts today, and claiming one that another patch is owed is how one agent's work silently
// displaces another's.
//
// =================================================================================================
// WHAT THIS MODULE DOES NOT OWN
// =================================================================================================
//
//   THE CONTRACT.     src/lib/horizon/types.ts and ids.ts. Every shape below that crosses a patch
//                     boundary is imported from there. Nothing here defines a second Confidence, a
//                     second EvidenceClass or a second SubjectRef.
//   THE FUSION.       src/lib/digital-twin.ts, through FusionSource. Never rebuilt, never widened.
//   THE RATING.       src/lib/match.ts. evaluate() rates every requirement and owns the weighting.
//   THE REQUIREMENTS. src/lib/job-twin.ts owns job_requirements and its write path.
//   THE EVIDENCE ROWS. hzn_evidence belongs to HORIZON's evidence patch. This engine writes none and
//                     cites underlying records by source type rather than minting ids for rows it
//                     did not create.
//   THE TRAINING.     src/lib/performance-learning.ts owns assignment. This module SUGGESTS and
//                     links; it has no write path and assigns nothing.
//   THE DECISION.     src/lib/application-stages.ts and src/lib/workflow.ts. Nothing here moves
//                     anybody anywhere.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isUuid, logFail, rowsOf, type PerfViewer } from '@/lib/performance-scope';
import { buildDigitalTwin, type DigitalTwin } from '@/lib/digital-twin';
import { buildJobTwin, ensureJobTwinSchema, type JobKind, type JobTwin } from '@/lib/job-twin';
import {
  evaluate,
  getWeightProfile,
  relationsIntoRead,
  subjectFromTwin,
  MATCH_RUN,
  MATCH_OVERRIDE,
  type MatchExplanation,
  type MatchSubject,
  type RequirementResult,
  type EvidenceRef,
} from '@/lib/match';
import { courseOptions, type CourseOption } from '@/lib/performance-learning';
import {
  assertAllowedAboutPerson,
  chainAssertion,
  toAssertionType,
  type AssertionType,
  type EvidenceChain,
  type EvidenceCitation,
} from '@/lib/person-assertions';
// ---- THE OWNED CONTRACT. Imported, never re-declared. -------------------------------------------
import {
  ENGINE_CLASS_SPECS,
  EVIDENCE_CLASS_WEIGHT,
  checkPublicCopy,
  freezeDeep,
  maxConfidenceFor,
  strongestEvidenceClass,
  validateIntelligenceResult,
  type Confidence,
  type ConfidenceBand,
  type DimensionRef,
  type DecisionUse,
  type EngineVersion,
  type EvidenceClass,
  type EvidenceSourceType,
  type IntelligenceResult,
  type ScoreOrLevel,
  type SourceContribution,
  type ValidationResult,
} from './types';
import {
  DEFAULT_ORGANISATION_ID,
  applicantSubject,
  employeeSubject,
  newHorizonId,
  type ComputationId,
  type OrganisationId,
  type SubjectRef,
} from './ids';

const MOD = 'horizon/role-compare';

/**
 * The engine identity. `version` MUST change when the grouping rules below change, or a result
 * stored today becomes unreconstructable against the code that produced it.
 */
export const ENGINE_ID = 'horizon-role-compare';
export const ENGINE_SEMVER = '1.0.0';

/**
 * DETERMINISTIC, and that word is load-bearing.
 *
 * Nothing in this module infers, models or predicts. It reads recorded requirements, recorded
 * capability levels with their recorded provenance, and a curated skill graph, then groups the
 * result of a named rule. ENGINE_CLASS_SPECS caps a deterministic engine at scientificStatus
 * `platform_record` and decisionUse `supporting_only`, and this module claims LESS than it is
 * entitled to on the second one — see DECISION_USE below.
 */
export const ENGINE_CLASS = 'deterministic' as const;

/**
 * `advisory_only`, though a deterministic engine may claim `supporting_only`.
 *
 * The under-claim is deliberate and it is about what this particular output is FOR. A role
 * comparison is read while somebody is deciding whether to move a named person, and rule 14 is
 * clearest exactly there. `supporting_only` invites a screen to treat the reading as part of the
 * basis for the decision; `advisory_only` says it is something a human considers. Both are legal
 * here. This is the one that describes what the reading actually is.
 */
export const DECISION_USE = 'advisory_only' as const;

/** How long a reading may be shown before a screen must call it stale. Rule 28: profiles are dynamic. */
export const RECOMPUTE_AFTER_DAYS = 90;

export const DIMENSION: DimensionRef = Object.freeze({
  family: 'capability',
  key: 'role_requirement_coverage',
  label: 'Role requirement coverage',
});

// -------------------------------------------------------------------------------------------------
// CAPABILITIES — REUSED, NOT INVENTED
//
// A new permission key answers false for EVERY role including super_admin until somebody adds it to
// PERMS_BY_ROLE and BUILTIN_PERMISSIONS. That failure is invisible: the feature never runs for
// anyone and the screen reports a refusal that reads like policy. It has already happened on this
// codebase — src/lib/auth/permissions.ts records offers.view being referenced by a page before it
// existed, and firms were charged for verifications no human could then open.
//
// Reading a person against a job's recorded requirements is EXACTLY what match.run already means,
// and comparing them to four jobs is still that. Recording what a human concluded from a reading is
// exactly what match.override already means. So this patch adds no key to the matrix.
// -------------------------------------------------------------------------------------------------
/** Read a role comparison. Same authority as reading one match, because that is what this is. */
export const ROLE_COMPARE_READ = MATCH_RUN;
/** Record what a human concluded from one. Sensitive: it is kept beside a named person. */
export const ROLE_COMPARE_DECIDE = MATCH_OVERRIDE;

// -------------------------------------------------------------------------------------------------
// THE SLOTS
// -------------------------------------------------------------------------------------------------

export const ROLE_SLOTS = ['current', 'alternative_a', 'alternative_b', 'future_leadership'] as const;
export type RoleSlot = (typeof ROLE_SLOTS)[number];

export function isRoleSlot(v: unknown): v is RoleSlot {
  return typeof v === 'string' && (ROLE_SLOTS as readonly string[]).indexOf(v) >= 0;
}

export const SLOT_LABELS: Readonly<Record<RoleSlot, string>> = Object.freeze({
  current: 'Current role',
  alternative_a: 'Alternative role A',
  alternative_b: 'Alternative role B',
  future_leadership: 'Future leadership role',
});

/**
 * What each column IS, printed above it.
 *
 * The future leadership column carries the longest sentence on purpose: it is the one a reader is
 * most likely to misread as a forecast, and the correction has to arrive before the figures do.
 */
export const SLOT_INTROS: Readonly<Record<RoleSlot, string>> = Object.freeze({
  current: 'The role this comparison treats as the one held today. Whoever opened this screen named it: '
    + 'hr_employees records a designation as free text and no column links an employee to a row in the role '
    + 'catalogue, so nothing here worked it out.',
  alternative_a: 'A role being considered alongside the current one. It is in this comparison because a human put '
    + 'it here, and for no other reason.',
  alternative_b: 'A second role being considered. Same as A: somebody chose it.',
  future_leadership: 'A role with leadership responsibility, read against what this person has evidenced TODAY. '
    + 'This is a distance, not a forecast. Nothing here predicts whether this person will hold this role, whether '
    + 'they should, or when. This platform holds no prediction about any person and does not create the field to '
    + 'store one. What it can say is which of this role’s recorded requirements have something behind them now.',
});

// -------------------------------------------------------------------------------------------------
// THE FUSION BOUNDARY (PATCH 06)
//
// The employee intelligence profile is composed elsewhere. This interface is the whole of what this
// module needs from it, so the composing module can be replaced without touching a line here, and so
// it is visible in one place exactly how much of a person this comparison reads.
// -------------------------------------------------------------------------------------------------

export interface FusionSource {
  /**
   * Compose the person for THIS VIEWER. The comparison can never see more of somebody than the
   * viewer running it can, and the aspects a viewer may not see come back named, as uncertainty,
   * never as an absence.
   */
  buildTwin(
    person: { userId?: string | null; employeeId?: string | null; applicationId?: string | null },
    viewer: PerfViewer,
    holds: (key: string) => boolean,
  ): Promise<DigitalTwin>;
  /** How a screen names where the profile came from. */
  label: string;
}

/** The fusion source in this worktree today. Used by default; overridable by the caller. */
export const DIGITAL_TWIN_FUSION: FusionSource = Object.freeze({
  buildTwin: buildDigitalTwin,
  label: 'the composed person record (src/lib/digital-twin.ts)',
});

// -------------------------------------------------------------------------------------------------
// LEADERSHIP: A NAME MATCH ON THE ROLE'S REQUIREMENTS, SAID IN THOSE WORDS
//
// There is no leadership taxonomy in hr_skills. `category` is free text with a default of 'general',
// so anything claiming to know which skills are leadership skills is reading a word somebody typed.
//
// That is acceptable for what this is used for, PROVIDED the output says so. This list matches
// against the REQUIREMENT — the skill a role asks for — and the finding is "this role asks for
// something whose name reads as leadership". It is never a finding about a person, and coverage
// against those rows is the same evidenced/partial/gap reading as every other row rather than a
// separate judgement.
// -------------------------------------------------------------------------------------------------

export const LEADERSHIP_TERMS: readonly string[] = Object.freeze([
  'leadership', 'leading', 'management', 'managing', 'people management', 'line management',
  'supervision', 'supervisory', 'mentoring', 'mentorship', 'coaching', 'delegation',
  'stakeholder management', 'strategy', 'strategic planning', 'governance', 'budget ownership',
  'hiring', 'performance review', 'conflict resolution', 'team building', 'programme management',
  'program management', 'portfolio management', 'organisational design', 'organizational design',
]);

export interface LeadershipTermMatch {
  yes: boolean;
  term: string | null;
  /** Printed beside the grouping, every time it is used. */
  sentence: string;
}

/**
 * Does this REQUIREMENT name a leadership capability?
 *
 * Matched on whole words, so "team building" matches and "steam" does not, and so a category of
 * 'general' never drags a whole catalogue into the leadership column.
 */
export function namesLeadershipRequirement(skillName: string, category?: string | null): LeadershipTermMatch {
  const hay = (String(skillName || '') + ' ' + String(category || ''))
    .toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!hay) return { yes: false, term: null, sentence: '' };
  for (const term of LEADERSHIP_TERMS) {
    const re = new RegExp('(^| )' + term + '( |$)');
    if (re.test(hay)) {
      return {
        yes: true,
        term,
        sentence: 'This requirement is grouped as leadership because its name contains "' + term + '". That is a '
          + 'match on the words of the requirement, not a judgement about anybody, and the skill catalogue holds no '
          + 'leadership classification behind it.',
      };
    }
  }
  return { yes: false, term: null, sentence: '' };
}

// -------------------------------------------------------------------------------------------------
// THE DEVELOPMENT GAP
// -------------------------------------------------------------------------------------------------

/** Why a requirement is not met. Four situations, kept apart, never collapsed into one word. */
export const GAP_KINDS = ['nothing_recorded', 'claimed_only', 'related_only', 'below_asked'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export const GAP_KIND_LABELS: Readonly<Record<GapKind, string>> = Object.freeze({
  nothing_recorded: 'Nothing on record',
  claimed_only: 'Claimed in words, nothing behind it',
  related_only: 'A related capability only',
  below_asked: 'Evidenced, below the level asked for',
});

export interface TrainingSuggestion {
  courseId: string;
  title: string;
  category: string | null;
  durationHours: number | null;
  isPaid: boolean;
  /** Why this course is beside this gap, in words. Always a name match, and it always says so. */
  basis: string;
  /** Always 'recommended'. Nothing here is a finding, and nothing here assigns anything. */
  assertion: AssertionType;
  /** Where a human goes to actually assign it. This module has no write path. */
  assignRoute: string;
}

export interface GapLine {
  skillId: string;
  skillName: string;
  /** 'required' | 'preferred', as the role recorded it. */
  necessity: string;
  minLevel: number;
  minLevelLabel: string;
  kind: GapKind;
  kindLabel: string;
  /** The one sentence match.ts wrote for this row. Never re-worded here. */
  why: string;
  evidence: EvidenceRef[];
  isLeadership: boolean;
  leadershipNote: string;
  training: TrainingSuggestion[];
}

export interface DevelopmentGap {
  lines: GapLine[];
  /** Counted per kind. Never totalled, because the four are not the same thing. */
  counts: Record<GapKind, number>;
  /** A REQUIRED capability with nothing on record, restated in words by match.ts. */
  blockers: string[];
  sentence: string;
}

const emptyGapCounts = (): Record<GapKind, number> => ({
  nothing_recorded: 0, claimed_only: 0, related_only: 0, below_asked: 0,
});

/**
 * Suggest training for one gap.
 *
 * A NAME MATCH AND NOTHING MORE. training_courses has no column naming the skill a course teaches,
 * so there is no join to make. Matching a course title against a skill name is the only available
 * route and it is weak, so every suggestion carries the word "recommended", says out loud that it is
 * a name match, and links to the module that actually assigns rather than assigning anything.
 *
 * Returns at most three, because a list of twenty maybes is a list nobody reads.
 */
export function suggestTraining(skillName: string, courses: readonly CourseOption[]): TrainingSuggestion[] {
  const needle = String(skillName || '').toLowerCase().trim();
  if (!needle || !courses.length) return [];
  const words = needle.split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 3);
  if (!words.length) return [];

  const scored: { c: CourseOption; hits: number }[] = [];
  for (const c of courses) {
    const hay = (String(c.title || '') + ' ' + String(c.category || '')).toLowerCase();
    let hits = 0;
    for (const w of words) if (hay.indexOf(w) >= 0) hits++;
    if (hits > 0) scored.push({ c, hits });
  }
  scored.sort((a, b) => (b.hits - a.hits) || a.c.title.localeCompare(b.c.title));

  return scored.slice(0, 3).map(({ c, hits }) => ({
    courseId: c.id,
    title: c.title,
    category: c.category,
    durationHours: c.durationHours,
    isPaid: c.isPaid,
    basis: 'Suggested because ' + (hits === 1 ? 'a word' : hits + ' words') + ' of "' + skillName + '" appear in this '
      + 'course’s title or category. No record links this course to that capability, because the catalogue holds no '
      + 'such link, so this is a name match for a human to judge and not a course this platform knows would close '
      + 'the gap.',
    assertion: 'recommended' as AssertionType,
    assignRoute: '/admin/learning/assign',
  }));
}

/**
 * Build the development gap from a reading.
 *
 * PURE. Every input is already on the explanation and nothing is read here. That is what makes it
 * testable without a database, and the four lists arrive already separated by match.ts.
 */
export function developmentGapFrom(
  explanation: MatchExplanation,
  courses: readonly CourseOption[],
): DevelopmentGap {
  const counts = emptyGapCounts();
  const lines: GapLine[] = [];

  const push = (r: RequirementResult, kind: GapKind): void => {
    counts[kind]++;
    const lead = namesLeadershipRequirement(r.skillName);
    lines.push({
      skillId: r.skillId,
      skillName: r.skillName,
      necessity: r.necessity,
      minLevel: r.minLevel,
      minLevelLabel: r.minLevelLabel,
      kind,
      kindLabel: GAP_KIND_LABELS[kind],
      why: r.why,
      evidence: r.evidence || [],
      isLeadership: lead.yes,
      leadershipNote: lead.sentence,
      training: suggestTraining(r.skillName, courses),
    });
  };

  for (const r of explanation.gaps || []) push(r, 'nothing_recorded');
  for (const r of explanation.claimedOnly || []) push(r, 'claimed_only');
  for (const r of explanation.partial || []) {
    // A partial reached through the ontology is a RELATED capability, not a shortfall in the
    // capability itself. Two different conversations with the person, so two different rows.
    push(r, r.via ? 'related_only' : 'below_asked');
  }

  // Required before preferred, then by name, so the same comparison always reads in the same order.
  lines.sort((a, b) => {
    const an = a.necessity === 'required' ? 0 : 1;
    const bn = b.necessity === 'required' ? 0 : 1;
    return (an - bn) || a.skillName.localeCompare(b.skillName);
  });

  const total = lines.length;
  return {
    lines,
    counts,
    blockers: explanation.decisionBlockers || [],
    sentence: total === 0
      ? 'Every requirement this role records has something behind it. That is a statement about the requirements '
        + 'somebody wrote down, and not a statement that this person can do the job.'
      : total + ' of this role’s recorded requirements are not met from what is on file, in four different ways '
        + 'that are kept apart above. An unrecorded capability looks exactly like an absent one, and nothing here '
        + 'can tell them apart.',
  };
}

// -------------------------------------------------------------------------------------------------
// GROWTH HEADROOM — THE DISTANCE, NOT THE PERSON
// -------------------------------------------------------------------------------------------------

export interface GrowthHeadroom {
  /** Requirements not met today, counted. A property of the gap, not of a human. */
  unmetRequired: number;
  unmetPreferred: number;
  /** Of the unmet ones, how many have at least one course a human could consider. */
  withSuggestedRoute: number;
  /** Of the unmet ones, how many have nothing in the catalogue that even name-matches. */
  withNoRouteFound: number;
  /** The refusal this replaces, carried verbatim so the screen can print why. */
  refusedInstead: { subject: string; why: string };
  sentence: string;
}

export function growthHeadroomFrom(gap: DevelopmentGap): GrowthHeadroom {
  let unmetRequired = 0;
  let unmetPreferred = 0;
  let withSuggestedRoute = 0;
  let withNoRouteFound = 0;

  for (const l of gap.lines) {
    if (l.necessity === 'required') unmetRequired++; else unmetPreferred++;
    if (l.training.length) withSuggestedRoute++; else withNoRouteFound++;
  }

  const refusal = assertAllowedAboutPerson('growth potential');

  return {
    unmetRequired,
    unmetPreferred,
    withSuggestedRoute,
    withNoRouteFound,
    refusedInstead: { subject: 'growth potential', why: refusal.why },
    sentence: (unmetRequired + unmetPreferred) === 0
      ? 'There is no recorded distance between this person’s file and this role’s recorded requirements. That is a '
        + 'statement about a short list of requirements, and it is not a statement that they are ready.'
      : 'This is the distance between what this role records and what is on file today: ' + unmetRequired
        + ' required and ' + unmetPreferred + ' preferred requirements unmet, ' + withSuggestedRoute
        + ' of which have a course in the catalogue whose name relates. It is a measurement of a gap. It is not a '
        + 'statement about how far this person can go, and this platform does not hold one.',
  };
}

// -------------------------------------------------------------------------------------------------
// LEADERSHIP REQUIREMENT COVERAGE — A STATEMENT ABOUT THE ROLE
// -------------------------------------------------------------------------------------------------

export interface LeadershipRequirementCoverage {
  /** How many of this role's requirements name a leadership capability. Zero is a real answer. */
  requirementCount: number;
  evidenced: RequirementResult[];
  partial: RequirementResult[];
  gap: RequirementResult[];
  matchedTerms: string[];
  refusedInstead: { subject: string; why: string };
  sentence: string;
}

export function leadershipCoverageFrom(explanation: MatchExplanation): LeadershipRequirementCoverage {
  const terms = new Set<string>();
  const pick = (rows: readonly RequirementResult[] | undefined): RequirementResult[] => {
    const out: RequirementResult[] = [];
    for (const r of rows || []) {
      const m = namesLeadershipRequirement(r.skillName);
      if (m.yes) {
        if (m.term) terms.add(m.term);
        out.push(r);
      }
    }
    return out;
  };

  const evidenced = pick(explanation.strong);
  const partial = pick(explanation.partial).concat(pick(explanation.substitute));
  const gap = pick(explanation.gaps).concat(pick(explanation.claimedOnly));
  const requirementCount = evidenced.length + partial.length + gap.length;
  const refusal = assertAllowedAboutPerson('leadership potential');

  return {
    requirementCount,
    evidenced,
    partial,
    gap,
    matchedTerms: Array.from(terms).sort(),
    refusedInstead: { subject: 'leadership potential', why: refusal.why },
    sentence: requirementCount === 0
      ? 'None of this role’s recorded requirements has a name that reads as a leadership capability. That may be '
        + 'because the role genuinely asks for none, or because whoever mapped its requirements onto the skill '
        + 'catalogue did not express them. Those are different, and this cannot tell them apart.'
      : requirementCount + ' of this role’s requirements have names that read as leadership capabilities, and the '
        + 'reading above is what is on file against those specific rows. It is a statement about which requirements '
        + 'this role records and what is evidenced against them. It is not a rating of anybody as a leader, and this '
        + 'platform holds no such rating.',
  };
}

// -------------------------------------------------------------------------------------------------
// SUSTAINABILITY — HOW DURABLE THIS READING IS, AND WHAT THE ROLE ITSELF RECORDS
// -------------------------------------------------------------------------------------------------

/** Evidence older than this is called out. Not a cliff — a prompt to look at the date. */
export const STALE_AFTER_DAYS = 730;

export interface Sustainability {
  /** How much of the role's weighting could be looked at at all. From match.ts, not recomputed. */
  completenessPct: number;
  /** Requirements resting on words somebody typed rather than a record. */
  claimedOnlyCount: number;
  /** Requirements nothing could be read for. Distinct from a gap. */
  unknownCount: number;
  /** The oldest and newest dated evidence behind this reading. Null when nothing carried a date. */
  oldestEvidenceAt: string | null;
  newestEvidenceAt: string | null;
  /** Dated evidence older than STALE_AFTER_DAYS. */
  staleEvidenceCount: number;
  /** What the ROLE records about its own terms. A fact about the role's row. */
  roleTerms: { engagementType: string | null; workMode: string | null; seniority: string | null };
  sentence: string;
  /** Said every time, because the word invites the other reading. */
  isNotAForecast: string;
}

export function sustainabilityFrom(
  explanation: MatchExplanation,
  job: JobTwin | null,
  nowIso: string,
): Sustainability {
  const now = Date.parse(nowIso);
  let oldest: number | null = null;
  let newest: number | null = null;
  let stale = 0;

  const seen: EvidenceRef[] = [];
  for (const d of explanation.dimensions || []) {
    for (const e of d.evidence || []) seen.push(e);
  }
  for (const e of seen) {
    if (!e || !e.recordedAt) continue;
    const t = Date.parse(e.recordedAt);
    if (isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
    if (!isNaN(now) && (now - t) / 86400000 > STALE_AFTER_DAYS) stale++;
  }

  const completenessPct = explanation.overall ? explanation.overall.completenessPct : 0;
  const claimedOnlyCount = (explanation.claimedOnly || []).length;
  const unknownCount = (explanation.unknown || []).length;

  const parts: string[] = [];
  parts.push(completenessPct >= 100
    ? 'Every part of this role’s weighting could be looked at.'
    : completenessPct + '% of this role’s weighting could be looked at at all. The rest could not be assessed, and '
      + 'that is not a zero.');
  if (claimedOnlyCount) {
    parts.push(claimedOnlyCount + ' requirement' + (claimedOnlyCount === 1 ? ' rests' : 's rest')
      + ' on words somebody typed rather than a record this platform checked, so that part of the reading would '
      + 'change the moment anybody looked into it.');
  }
  if (unknownCount) {
    parts.push(unknownCount + ' could not be read at all, which is a gap in our records and not a finding about the '
      + 'person.');
  }
  if (stale) {
    parts.push(stale + ' piece' + (stale === 1 ? '' : 's') + ' of dated evidence behind this is more than two years '
      + 'old. Old evidence is still evidence; it is flagged so somebody looks at the date rather than at the figure.');
  }
  if (!seen.length || (oldest === null && newest === null)) {
    parts.push('None of the evidence behind this reading carries a date, so nothing here can say how current it is.');
  }

  return {
    completenessPct,
    claimedOnlyCount,
    unknownCount,
    oldestEvidenceAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestEvidenceAt: newest === null ? null : new Date(newest).toISOString(),
    staleEvidenceCount: stale,
    roleTerms: {
      engagementType: job && job.engagementType ? job.engagementType.value : null,
      workMode: job && job.workMode ? job.workMode.value : null,
      seniority: job && job.seniority ? job.seniority.value : null,
    },
    sentence: parts.join(' '),
    isNotAForecast: 'This describes how durable THIS READING is and what the role records about its own terms. It '
      + 'says nothing about how long this person would stay in the role or whether they would sustain it. That '
      + 'would be a prediction about a human, it could only be built from attendance and activity, and this '
      + 'platform does not infer from those.',
  };
}

// -------------------------------------------------------------------------------------------------
// CURRENT CAPABILITY, AND THE FIT — BOTH READ OFF match.ts, NEITHER RECOMPUTED
// -------------------------------------------------------------------------------------------------

export interface CurrentCapability {
  /** Evidenced at or above the level the role asks for. */
  evidenced: RequirementResult[];
  /** Covered through a recorded substitution rather than the capability itself. Kept apart. */
  substituted: RequirementResult[];
  sentence: string;
}

export function currentCapabilityFrom(explanation: MatchExplanation): CurrentCapability {
  const evidenced = explanation.strong || [];
  const substituted = explanation.substitute || [];
  return {
    evidenced,
    substituted,
    sentence: evidenced.length === 0 && substituted.length === 0
      ? 'Nothing on file meets a requirement this role records at the level it asks for. That is a statement about '
        + 'our records, not about this person: an unrecorded capability looks exactly like an absent one.'
      : evidenced.length + ' of this role’s requirements are evidenced at or above the level asked for'
        + (substituted.length
          ? ', and ' + substituted.length + ' more are covered by a recorded substitution, which is a weaker thing '
            + 'and is listed separately for that reason.'
          : '.'),
  };
}

export interface EvidenceBasedFit {
  /** Over the dimensions that could be assessed. Null when none could. NEVER shown alone. */
  coveragePct: number | null;
  /** How much of the job's weighting could be looked at at all. Shown beside the figure, always. */
  completenessPct: number;
  band: string;
  assessable: boolean;
  conclusion: string;
  sentence: string;
  /** Printed with the figure wherever the figure appears. */
  mustAccompany: string;
}

export function evidenceBasedFitFrom(explanation: MatchExplanation): EvidenceBasedFit {
  const o = explanation.overall;
  return {
    coveragePct: o ? o.coveragePct : null,
    completenessPct: o ? o.completenessPct : 0,
    band: o ? o.band : 'not-assessable',
    assessable: explanation.assessable === true,
    conclusion: explanation.conclusion,
    sentence: o ? o.sentence : 'There is no reading here.',
    mustAccompany: 'This figure is coverage of recorded requirements by recorded evidence. It is not a probability '
      + 'of success, not a rating of the person, and not comparable to the same figure on another role: two roles '
      + 'record different requirements, mapped by different people, to different depths. Read the completeness '
      + 'figure beside it, which says how much of the role could be looked at at all.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE THREE FACTORS
// -------------------------------------------------------------------------------------------------

export interface ThreeFactorExplanation {
  personEvidence: {
    /** Skill holdings the viewer was allowed to see and that were readable. */
    skillsRead: number;
    /** Words on forms. Carried, never counted as capability. */
    claimedRead: number;
    /** Aspects of the person this viewer may not see. Named uncertainty, never a silent zero. */
    withheld: string[];
    /** Aspects granted but unreadable. Also named. */
    unreadable: string[];
    sentence: string;
  };
  roleRequirements: {
    required: number;
    preferred: number;
    /** Words on the job with no requirement behind them. The honest number. */
    unmappedKeywords: number;
    matchable: boolean;
    sentence: string;
  };
  timeContext: {
    /** Days since this person joined, when the viewer may see employment and it is recorded. */
    tenureDays: number | null;
    /** Steps the person record holds. Never a predicted next step: there is no such field. */
    trajectorySteps: number;
    newestEvidenceAt: string | null;
    oldestEvidenceAt: string | null;
    staleEvidenceCount: number;
    /** Total hours of the suggested courses, where the catalogue records a duration. */
    suggestedTrainingHours: number | null;
    sentence: string;
  };
  /** The one sentence tying the three together, for the top of a column. */
  sentence: string;
}

export function threeFactorFrom(input: {
  subject: MatchSubject;
  twin: DigitalTwin;
  job: JobTwin | null;
  explanation: MatchExplanation;
  gap: DevelopmentGap;
  sustainability: Sustainability;
}): ThreeFactorExplanation {
  const { subject, twin, job, gap, sustainability } = input;

  const withheld = (twin.withheld || []).map((w) => String(w.aspect));
  const unreadable = (twin.unreadable || []).map((u) => String(u.aspect));
  const skillsRead = (subject.skills || []).length;
  const claimedRead = (subject.claimed || []).length;

  const required = (job ? job.requiredSkills : []).length;
  const preferred = (job ? job.preferredSkills : []).length;
  const unmappedKeywords = job && job.keywords ? (job.keywords.unmapped || []).length : 0;

  const tenureDays = twin.employment && twin.employment.tenureDays
    ? Number(twin.employment.tenureDays.value)
    : null;
  const trajectorySteps = twin.trajectory ? (twin.trajectory.steps || []).length : 0;

  let hours = 0;
  let anyHours = false;
  for (const l of gap.lines) {
    for (const t of l.training) {
      if (t.durationHours !== null && t.durationHours !== undefined && !isNaN(Number(t.durationHours))) {
        hours += Number(t.durationHours);
        anyHours = true;
      }
    }
  }

  const personSentence = 'Read from ' + skillsRead + ' recorded capability level'
    + (skillsRead === 1 ? '' : 's') + ' and ' + claimedRead + ' word'
    + (claimedRead === 1 ? '' : 's') + ' claimed on a form, which are not the same thing and are never counted '
    + 'together.'
    + (withheld.length
      ? ' ' + withheld.length + ' aspect' + (withheld.length === 1 ? ' of this person is' : 's of this person are')
        + ' withheld from this viewer (' + withheld.join(', ') + '), and every requirement resting on '
        + (withheld.length === 1 ? 'it reads' : 'them reads') + ' as unknown rather than as a gap.'
      : '')
    + (unreadable.length
      ? ' ' + unreadable.length + ' aspect' + (unreadable.length === 1 ? '' : 's')
        + ' could not be read (' + unreadable.join(', ') + '). A failed read is not a finding.'
      : '');

  const roleSentence = job && job.matchable
    ? 'Held against ' + required + ' required and ' + preferred + ' preferred requirements a human recorded in the '
      + 'skill catalogue'
      + (unmappedKeywords
        ? ', plus ' + unmappedKeywords + ' word' + (unmappedKeywords === 1 ? '' : 's') + ' on the job description '
          + 'that nobody has mapped to a requirement. Those words were not compared, because comparing a person to '
          + 'text is a guess wearing a percentage.'
        : '. Every word on the job description has a requirement behind it.')
    : 'This role has no requirements recorded in the skill catalogue, so there was nothing to hold anybody against '
      + 'and nothing was compared.';

  const timeParts: string[] = [];
  timeParts.push(tenureDays === null
    ? 'No tenure is readable for this person here, so nothing below is set against how long they have been in post.'
    : 'This person has ' + tenureDays + ' day' + (tenureDays === 1 ? '' : 's') + ' of recorded tenure.');
  if (trajectorySteps) {
    timeParts.push('Their record holds ' + trajectorySteps + ' dated step'
      + (trajectorySteps === 1 ? '' : 's') + '. There is no predicted next step: this platform does not hold one.');
  }
  timeParts.push(sustainability.newestEvidenceAt
    ? 'The most recent dated evidence behind this reading is from ' + sustainability.newestEvidenceAt.slice(0, 10)
      + (sustainability.staleEvidenceCount
        ? ', and ' + sustainability.staleEvidenceCount + ' piece' + (sustainability.staleEvidenceCount === 1 ? '' : 's')
          + ' of it is more than two years old.'
        : '.')
    : 'None of the evidence behind this reading carries a date.');
  timeParts.push(anyHours
    ? 'The courses suggested against the gaps total ' + hours + ' recorded hours. That is the catalogue’s figure for '
      + 'those courses, not an estimate of how long this person would need, which nothing here can know.'
    : 'No suggested course records a duration, so there is no hours figure to give and none is invented.');

  return {
    personEvidence: { skillsRead, claimedRead, withheld, unreadable, sentence: personSentence },
    roleRequirements: {
      required, preferred, unmappedKeywords, matchable: !!(job && job.matchable), sentence: roleSentence,
    },
    timeContext: {
      tenureDays,
      trajectorySteps,
      newestEvidenceAt: sustainability.newestEvidenceAt,
      oldestEvidenceAt: sustainability.oldestEvidenceAt,
      staleEvidenceCount: sustainability.staleEvidenceCount,
      suggestedTrainingHours: anyHours ? hours : null,
      sentence: timeParts.join(' '),
    },
    sentence: 'PERSON EVIDENCE x ROLE REQUIREMENTS x TIME AND DEVELOPMENT CONTEXT. ' + personSentence + ' '
      + roleSentence + ' ' + timeParts.join(' '),
  };
}

// =================================================================================================
// THE CONTRACT LAYER — MAPPING THIS READING ONTO THE STANDARD INTELLIGENCE OUTPUT
// =================================================================================================

/**
 * match.ts's provenance word -> the HORIZON evidence class.
 *
 * CONSERVATIVE IN ONE DIRECTION ON PURPOSE. Where two classes could be argued, the WEAKER is
 * chosen, because the confidence ceiling in types.ts is computed from this and over-claiming here
 * silently raises the confidence a screen is allowed to print about a named person. Under-claiming
 * costs a band; over-claiming costs somebody an unearned "high confidence" beside their name.
 */
export const EVIDENCE_CLASS_FROM_ASSERTION: Readonly<Record<string, EvidenceClass>> = Object.freeze({
  // A platform record of the platform's own act, made at the time it happened.
  factual: 'observed',
  // A named human checked it against a named record. Attested, not demonstrated: the demonstration
  // is the underlying work, and this row is the check.
  verified: 'attested',
  provided: 'stated',
  explicitly_provided: 'stated',
  // Worked out by a rule from records already held. It is our arithmetic, not the person's evidence.
  calculated: 'inferred',
  inferred: 'inferred',
  predicted: 'non_evidential',
  recommended: 'non_evidential',
});

export function evidenceClassOf(assertion: string | null | undefined): EvidenceClass {
  const key = String(assertion || '').toLowerCase();
  return EVIDENCE_CLASS_FROM_ASSERTION[key] || 'stated';
}

/**
 * match.ts's source string -> the HORIZON source type.
 *
 * Matched on substrings because the producing module writes its own words there and this module may
 * not make it write different ones. An unrecognised source becomes `system_computation`, which is
 * the honest reading of "our own code said so and we cannot name a record behind it".
 */
export function sourceTypeOf(source: string | null | undefined): EvidenceSourceType {
  const s = String(source || '').toLowerCase();
  if (s.indexOf('assessment') >= 0 || s.indexOf('attempt') >= 0) return 'assessment';
  if (s.indexOf('certificate') >= 0 || s.indexOf('credential') >= 0) return 'credential';
  if (s.indexOf('course') >= 0 || s.indexOf('training') >= 0 || s.indexOf('enrol') >= 0) return 'training_record';
  if (s.indexOf('application') >= 0) return 'application';
  if (s.indexOf('review') >= 0) return 'performance_review';
  if (s.indexOf('task') >= 0) return 'task';
  if (s.indexOf('skill') >= 0 || s.indexOf('capability') >= 0) return 'capability_evidence';
  return 'system_computation';
}

/**
 * Group the evidence behind one reading into source contributions whose weights sum to 1.
 *
 * WHY EVIDENCE IDS ARE EMPTY HERE, STATED RATHER THAN LEFT TO BE NOTICED. hzn_evidence is owned by
 * HORIZON's evidence patch, and this engine writes no row to it. Minting an EvidenceId for a record
 * this module did not create would produce an identifier that resolves to nothing — worse than an
 * empty list, because a reader would try to follow it. The underlying records ARE named: every one
 * of them is cited in full, with its own sentence and link, on the chain that travels beside this
 * result.
 *
 * The weights are a SHARE OF CITED EVIDENCE BY COUNT and nothing more. They are not an importance
 * ranking, and `note` says so on every row.
 */
export function sourceBreakdownFrom(explanation: MatchExplanation): SourceContribution[] {
  const buckets = new Map<EvidenceSourceType, { count: number; strongest: EvidenceClass }>();
  let total = 0;

  for (const d of explanation.dimensions || []) {
    for (const e of d.evidence || []) {
      if (!e) continue;
      const t = sourceTypeOf(e.source);
      const c = evidenceClassOf(e.assertion);
      const cur = buckets.get(t);
      if (!cur) {
        buckets.set(t, { count: 1, strongest: c });
      } else {
        cur.count++;
        if (EVIDENCE_CLASS_WEIGHT[c] > EVIDENCE_CLASS_WEIGHT[cur.strongest]) cur.strongest = c;
      }
      total++;
    }
  }

  if (!total) return [];

  const rows = Array.from(buckets.entries()).map(([sourceType, v]) => ({
    sourceType,
    weight: v.count / total,
    evidenceIds: [] as const,
    strongestClass: v.strongest,
    note: v.count + ' cited record' + (v.count === 1 ? '' : 's') + ' of this type, which is '
      + Math.round((v.count / total) * 100) + '% of what this reading cites by count. A share of the count is not a '
      + 'share of the importance, and this engine does not rank its sources. No hzn_evidence id is given because '
      + 'this engine writes no evidence row: the underlying records are named individually on the evidence chain '
      + 'beside this result.',
  })) as SourceContribution[];

  // Largest share first, then a stable name order, so two runs over the same data read identically.
  rows.sort((a, b) => (b.weight - a.weight) || a.sourceType.localeCompare(b.sourceType));

  // FLOATING POINT: validation requires the weights to sum to 1 within 0.01, and n/total summed back
  // can land a hair off. The last row absorbs the difference rather than every row being nudged,
  // because one visibly adjusted row is easier to reason about than four invisibly adjusted ones.
  const sum = rows.reduce((a, r) => a + r.weight, 0);
  if (rows.length && Math.abs(sum - 1) > 1e-9) {
    rows[rows.length - 1] = { ...rows[rows.length - 1], weight: rows[rows.length - 1].weight + (1 - sum) };
  }
  return rows;
}

/**
 * The confidence band, and the two things that may only ever lower it.
 *
 * CEILING FIRST (rule 22, made arithmetic in types.ts): a reading whose strongest evidence is
 * inferred may not announce itself as high, and one resting on nothing evidential may not exceed
 * low. Then COMPLETENESS: a reading that could only look at a third of a role is not a confident
 * reading of that role however good the third was. The lower of the two wins, always.
 */
export function confidenceFrom(
  explanation: MatchExplanation,
  breakdown: readonly SourceContribution[],
): Confidence {
  const completenessPct = explanation.overall ? explanation.overall.completenessPct : 0;
  const assessable = explanation.assessable === true;

  if (!assessable || !breakdown.length) {
    return {
      band: 'low',
      value: null,
      basis: 'Nothing could be compared, so there is no confidence in a reading — there is no reading. This is a '
        + 'statement about what our records could answer, not about the person.',
    };
  }

  const strongest = strongestEvidenceClass(breakdown);
  const ceiling = maxConfidenceFor(strongest);
  const rank: Record<ConfidenceBand, number> = { low: 0, moderate: 1, high: 2 };

  const fromCompleteness: ConfidenceBand = completenessPct >= 80
    ? 'high'
    : completenessPct >= 40 ? 'moderate' : 'low';

  const band: ConfidenceBand = rank[fromCompleteness] <= rank[ceiling] ? fromCompleteness : ceiling;

  return {
    band,
    value: null,
    basis: 'The strongest evidence behind this reading is "' + strongest + '", which caps confidence at ' + ceiling
      + '. ' + completenessPct + '% of the role’s weighting could be assessed, which on its own would read as '
      + fromCompleteness + '. The lower of the two is what is reported, and it is never raised by either. No numeric '
      + 'confidence is given because this engine has no calibrated one, and a fabricated number would be worse than '
      + 'a band.',
  };
}

/** The four bands match.ts produces, as the option list for a categorical result. */
export const FIT_BANDS: readonly string[] = Object.freeze([
  'not-assessable', 'evidence-thin', 'partial-evidence', 'well-evidenced',
]);

/**
 * The value this result carries.
 *
 * CATEGORICAL, NOT NUMERIC, AND THAT IS THE DECISION THIS FUNCTION EXISTS TO MAKE. match.ts does
 * produce a coverage percentage, and it is carried on `evidenceBasedFit` where a screen can print it
 * beside the completeness figure that qualifies it. What it must not become is THE VALUE OF THE
 * RESULT — a bare number about a named person, stored, sorted, and compared against three other
 * numbers on the same screen. The band is what survives being read out of context.
 */
export function scoreOrLevelFrom(explanation: MatchExplanation): ScoreOrLevel {
  if (explanation.assessable !== true || !explanation.overall) {
    return {
      kind: 'not_computed',
      reason: explanation.conclusion || 'This role records no requirements in the skill catalogue, so there was '
        + 'nothing to hold anybody against and nothing was compared.',
    };
  }
  return {
    kind: 'categorical',
    category: explanation.overall.band,
    options: FIT_BANDS,
  };
}

// -------------------------------------------------------------------------------------------------
// ONE ROLE, READ
// -------------------------------------------------------------------------------------------------

export interface RoleSlotInput {
  slot: RoleSlot;
  jobKind: JobKind;
  jobId: string;
  /** Why this role is in this comparison. A human's words, stored verbatim, printed. */
  chosenBecause?: string | null;
}

export interface RoleReading {
  slot: RoleSlot;
  slotLabel: string;
  slotIntro: string;
  jobKind: JobKind;
  jobId: string;
  title: string | null;
  chosenBecause: string | null;

  /** The whole reading from match.ts, carried unmodified so a screen can render any part of it. */
  explanation: MatchExplanation;

  currentCapability: CurrentCapability;
  evidenceBasedFit: EvidenceBasedFit;
  developmentGap: DevelopmentGap;
  growthHeadroom: GrowthHeadroom;
  sustainability: Sustainability;
  leadership: LeadershipRequirementCoverage;
  requiredTraining: {
    suggestions: TrainingSuggestion[];
    /** Nothing here makes training required. Said in words, on the field named `requiredTraining`. */
    sentence: string;
    assignRoute: string;
  };

  threeFactor: ThreeFactorExplanation;
  /** The seven questions, for this role. A page that cannot render this does not render the column. */
  chain: EvidenceChain;

  /** The contract shape other HORIZON patches consume. Frozen; superseded, never edited. */
  result: IntelligenceResult;
  /** The contract's own verdict on that object. Carried so a caller never has to trust this module. */
  resultValidation: ValidationResult;
}

/** The evidence citations behind one role's reading, for the chain. */
function citationsFor(explanation: MatchExplanation): EvidenceCitation[] {
  const out: EvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const d of explanation.dimensions || []) {
    for (const e of d.evidence || []) {
      if (!e) continue;
      const key = String(e.what) + '|' + String(e.source) + '|' + String(e.recordedAt || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: String(e.source || 'Unnamed source'),
        label: String(e.what || ''),
        url: e.url || null,
        assertion: toAssertionType(e.assertion),
        at: e.recordedAt || null,
      });
      if (out.length >= 60) return out;
    }
  }
  return out;
}

function chainFor(reading: {
  explanation: MatchExplanation;
  gap: DevelopmentGap;
  sustainability: Sustainability;
  threeFactor: ThreeFactorExplanation;
  slot: RoleSlot;
  title: string | null;
}): EvidenceChain {
  const { explanation, gap, sustainability, threeFactor, slot, title } = reading;
  const citations = citationsFor(explanation);

  return {
    concluded: SLOT_LABELS[slot] + (title ? ' (' + title + ')' : '') + ': ' + explanation.conclusion,
    why: 'Every requirement this role records in the skill catalogue was rated by evaluate() in src/lib/match.ts '
      + 'against the capability levels and claimed words on this person’s composed record, under the weight profile '
      + 'named "' + explanation.weightProfile.label + '". This module added no rating of its own: it grouped that '
      + 'reading into current capability, gap, headroom, leadership requirement coverage and durability, and held it '
      + 'beside the other roles in this comparison without ranking them.',
    evidence: citations,
    assumptions: (explanation.assumptions || []).concat([
      'The requirements this role records are assumed to be what the role actually needs. They are what somebody '
        + 'wrote down, which is not the same thing.',
      'Courses are suggested by matching words in a skill name against words in a course title. No record links a '
        + 'course to a capability, so every suggestion is a name match for a human to judge.',
      slot === 'future_leadership'
        ? 'This role is in the comparison because a human chose it. Nothing here concluded that this person is '
          + 'heading towards it.'
        : 'This role is in the comparison because a human chose it.',
    ]),
    uncertain: (explanation.uncertainty || []).concat([
      'An unrecorded capability is indistinguishable from an absent one, on every row.',
      sustainability.isNotAForecast,
      gap.counts.claimed_only
        ? gap.counts.claimed_only + ' requirement(s) rest on words typed on a form and would change the moment '
          + 'anybody checked them.'
        : 'No requirement in this reading rests on words alone.',
      threeFactor.personEvidence.withheld.length
        ? 'This viewer may not see: ' + threeFactor.personEvidence.withheld.join(', ')
          + '. Those requirements read as unknown, never as gaps.'
        : 'No aspect of this person was withheld from this viewer.',
    ]),
    dataRead: (explanation.dataUsed || []).map((d) => d.source + ' (' + d.rows + ' rows): ' + d.sentence).concat([
      'training_courses, read through courseOptions() in src/lib/performance-learning.ts, for course names only.',
    ]),
    overridable: {
      yes: true,
      how: 'This is advisory and decides nothing. A human disagrees with a reading through recordHumanDecision() in '
        + 'src/lib/match.ts, which stores the disagreement beside it. A promotion or any consequential sign-off goes '
        + 'through src/lib/workflow.ts; moving an application goes through src/lib/application-stages.ts. Nothing in '
        + 'this comparison writes to either.',
    },
    // A conclusion ASSEMBLED by a rule is at best `calculated`, even when every input was checked,
    // because the assembly is ours and nobody checked that either.
    assertion: chainAssertion(citations, 'calculated'),
  };
}

/** The one or two sentences a human reads. Checked against rule 19's word list before it is returned. */
export function summaryFor(reading: {
  slot: RoleSlot;
  title: string | null;
  explanation: MatchExplanation;
  gap: DevelopmentGap;
}): string {
  const { slot, title, explanation, gap } = reading;
  const name = title || 'this role';
  const head = SLOT_LABELS[slot] + ': ' + name + '. ';

  if (explanation.assessable !== true) {
    return head + 'Nothing was compared, because this role records no requirements in the skill catalogue. That is '
      + 'a gap in what has been written down about the role, and it is not a finding about this person.';
  }

  const strong = (explanation.strong || []).length;
  const unmet = gap.lines.length;
  return head + strong + ' recorded requirement' + (strong === 1 ? ' is' : 's are')
    + ' evidenced at or above the level asked for and ' + unmet + (unmet === 1 ? ' is' : ' are') + ' not, out of what '
    + 'this role has written down. An unrecorded capability looks exactly like an absent one, so this describes our '
    + 'records rather than this person. It is advisory, it is not a ranking against any other role on this screen, '
    + 'and it decides nothing.';
}

function resultFor(input: {
  slot: RoleSlot;
  title: string | null;
  explanation: MatchExplanation;
  gap: DevelopmentGap;
  subject: SubjectRef;
  computationId: ComputationId;
  organisationId: OrganisationId;
  nowIso: string;
}): { result: IntelligenceResult; validation: ValidationResult } {
  const { slot, title, explanation, gap, subject, computationId, organisationId, nowIso } = input;

  const breakdown = sourceBreakdownFrom(explanation);
  const scoreOrLevel = scoreOrLevelFrom(explanation);
  const confidence = confidenceFrom(explanation, breakdown);

  const staleAt = new Date(Date.parse(nowIso) + RECOMPUTE_AFTER_DAYS * 86400000).toISOString();

  const engine: EngineVersion = {
    engineId: ENGINE_ID,
    engineClass: ENGINE_CLASS,
    version: ENGINE_SEMVER,
    computationId,
  };

  // A summary is printed to a human, so it goes through rule 19's check before it can be returned.
  // A failure here is a bug in this module's own copy, not in the data, so it is replaced with a
  // sentence that is safe rather than being allowed through or thrown at a reader.
  const drafted = summaryFor({ slot, title, explanation, gap });
  const copy = checkPublicCopy(drafted);
  const summary = copy.ok
    ? drafted
    : 'This reading could not be summarised in language this system permits, so the summary is withheld. The full '
      + 'reading beside it is unaffected.';

  const result: IntelligenceResult = {
    id: newHorizonId('result'),
    subject,
    dimension: DIMENSION,
    scoreOrLevel,
    confidence,
    status: 'active',
    summary,
    // hzn_evidence rows are another patch's to write. See sourceBreakdownFrom().
    evidence: [],
    sourceBreakdown: breakdown,
    computedAt: nowIso,
    validFor: { staleAt, recomputeAfterDays: RECOMPUTE_AFTER_DAYS },
    modelOrEngineVersion: engine,
    // RULE 15. Nothing here is shown as settled: a role comparison is read while somebody is
    // deciding about a named person, so every result asks for a human before it is acted on. The
    // engine class does not force this — this module chooses it.
    humanReviewStatus: 'pending',
    layer: 'computed',
    decisionUse: DECISION_USE,
    scientificStatus: 'platform_record',
    organisationId,
    profileId: null,
    supersedes: null,
  };

  return { result: freezeDeep(result), validation: validateIntelligenceResult(result) };
}

// -------------------------------------------------------------------------------------------------
// THE COMPARISON
// -------------------------------------------------------------------------------------------------

export interface RoleComparison {
  subject: {
    ref: SubjectRef | null;
    personKey: string;
    displayName: string | null;
    employeeId: string | null;
    userId: string | null;
    /** How much of this person the viewer running this was allowed to see. */
    accessSentence: string;
  };
  readings: RoleReading[];
  /** Roles that were asked for and could not be read. Named, never silently dropped. */
  notRead: { slot: RoleSlot; jobKind: JobKind; jobId: string; because: string }[];
  /** Named so nobody wonders whether the ranking was an oversight. */
  refusesRanking: string;
  /** What was asked for, refused, and why — carried from person-assertions.ts verbatim. */
  refused: { subject: string; why: string }[];
  fusion: { label: string; sentence: string };
  humanAuthority: { decidesNothing: string; routes: string[] };
  /** The weight profile every reading in this comparison was produced under. One, for all of them. */
  weightProfile: { key: string; label: string; sentence: string };
  /** The run. Every result in `readings` cites this one, which is what makes the set reconstructable. */
  computationId: ComputationId;
  engine: { id: string; version: string; engineClass: string; decisionUse: string };
  computedAt: string;
  state: 'ok' | 'refused' | 'unreadable';
  sentence: string;
}

const REFUSES_RANKING =
  'These roles are not ranked and this comparison will not rank them. The coverage figures are not comparable across '
  + 'columns: two roles record different requirements, mapped onto the skill catalogue by different people to '
  + 'different depths, so a higher figure on one column can mean a shallower map rather than a better fit. There is '
  + 'no best role on this screen, no total across it, and no ordering by fit anywhere in the module behind it. What '
  + 'is comparable is what each column states in words: what is evidenced, what is missing, and what is unknown.';

const DECIDES_NOTHING =
  'This is an advisory reading of what is on record and it decides nothing. No promotion, no move, no rejection and '
  + 'no development plan follows from it automatically. A human reads it, may disagree with every line without '
  + 'giving this system a reason, and makes the decision elsewhere.';

/**
 * Compare one person against several roles, for one viewer.
 *
 * WHY THIS IS NOT A LOOP OVER runMatch(). runMatch() builds the person's twin, reads the weight
 * profile and opens the skill graph once per call. Four roles through it is four twins, four profile
 * reads and four graph reads OF THE SAME PERSON — and this application's functions sit a round trip
 * away from its database, which is the standing cost behind every slow page here. The person is
 * composed ONCE, the profile is read ONCE, the graph is read ONCE for the union of every role's
 * requirements, and evaluate() — which is pure — runs per role over that shared material.
 *
 * The reading each role gets is therefore identical to the one runMatch() would have produced, which
 * is the point: this module adds a second axis, not a second opinion.
 *
 * IT RECORDS NOTHING. runMatch() writes a match_evaluations row; this does not, because a comparison
 * is not four evaluations and storing it as four would put a row on a person's record for a role
 * somebody added to a screen for thirty seconds. Persisting a comparison is a decision with an owner
 * and a table, and it is named as a follow-up rather than guessed at here.
 */
export async function compareRoles(input: {
  person: { userId?: string | null; employeeId?: string | null; applicationId?: string | null };
  roles: readonly RoleSlotInput[];
  viewer: PerfViewer;
  holds: (key: string) => boolean;
  /** True when the caller holds `match.run`. Checked on the page, asked for here. */
  mayRun: boolean;
  weightProfileKey?: string | null;
  /** Swappable, so the fusion layer can be replaced without touching this module. */
  fusion?: FusionSource;
  organisationId?: OrganisationId;
  /** Injectable for tests. Defaults to now. */
  nowIso?: string;
}): Promise<RoleComparison> {
  const nowIso = input && input.nowIso ? input.nowIso : new Date().toISOString();
  const fusion = (input && input.fusion) || DIGITAL_TWIN_FUSION;
  const organisationId = (input && input.organisationId) || DEFAULT_ORGANISATION_ID;
  const computationId = newHorizonId('computation');
  const engineBlock = {
    id: ENGINE_ID, version: ENGINE_SEMVER, engineClass: ENGINE_CLASS, decisionUse: DECISION_USE,
  };
  const refused = [
    { subject: 'growth potential', why: assertAllowedAboutPerson('growth potential').why },
    { subject: 'leadership potential', why: assertAllowedAboutPerson('leadership potential').why },
  ];

  const empty = (state: 'refused' | 'unreadable', sentence: string): RoleComparison => ({
    subject: { ref: null, personKey: '', displayName: null, employeeId: null, userId: null, accessSentence: '' },
    readings: [],
    notRead: [],
    refusesRanking: REFUSES_RANKING,
    refused,
    fusion: { label: fusion.label, sentence: 'Nothing was composed.' },
    humanAuthority: { decidesNothing: DECIDES_NOTHING, routes: [] },
    weightProfile: { key: '', label: '', sentence: '' },
    computationId,
    engine: engineBlock,
    computedAt: nowIso,
    state,
    sentence,
  });

  if (input?.mayRun !== true) {
    return empty('refused', 'Comparing a person to roles needs ' + ROLE_COMPARE_READ + '. Nothing was read.');
  }

  const asked = (input.roles || []).filter((r) => r && isRoleSlot(r.slot) && isUuid(String(r.jobId || '')));
  if (!asked.length) {
    return empty('refused', 'No role was named properly, so nothing was compared.');
  }

  // ---- THE PERSON, COMPOSED ONCE, FOR THIS VIEWER ------------------------------------------------
  let twin: DigitalTwin;
  try {
    twin = await fusion.buildTwin(input.person, input.viewer, input.holds);
  } catch (e: any) {
    logFail(MOD, 'compareRoles:twin', e);
    return empty('unreadable', 'We could not compose this person’s record just now, so nothing was compared. This is '
      + 'a failure to read and not a finding about them.');
  }

  const subject = subjectFromTwin(twin);
  const employeeId = twin.person ? twin.person.employeeId : null;
  const userId = twin.person ? twin.person.userId : null;
  // WHICH SCHEME A SUBJECT IS ANCHORED ON IS RECORDED, NEVER GUESSED — ids.ts says a reader that
  // guesses joins the wrong table and gets an empty result that looks like a person with no history.
  const subjectRef: SubjectRef | null = employeeId
    ? employeeSubject(employeeId, organisationId)
    : (userId ? applicantSubject(userId, 'user', organisationId) : null);

  // ---- THE ROLES ---------------------------------------------------------------------------------
  const notRead: { slot: RoleSlot; jobKind: JobKind; jobId: string; because: string }[] = [];
  const jobs: { input: RoleSlotInput; job: JobTwin }[] = [];
  for (const r of asked) {
    try {
      const job = await buildJobTwin({ jobKind: r.jobKind, jobId: r.jobId });
      if (job.readFailed) {
        notRead.push({ slot: r.slot, jobKind: r.jobKind, jobId: r.jobId, because: job.sentence });
        continue;
      }
      jobs.push({ input: r, job });
    } catch (e: any) {
      logFail(MOD, 'compareRoles:job', e);
      notRead.push({
        slot: r.slot, jobKind: r.jobKind, jobId: r.jobId,
        because: 'This role could not be read just now, so it was left out rather than shown as empty.',
      });
    }
  }

  // ---- THE SHARED MATERIAL: ONE PROFILE READ, ONE GRAPH READ, ONE COURSE LIST ---------------------
  const profile = await getWeightProfile(input?.weightProfileKey || 'default');

  const reqIds: string[] = [];
  for (const j of jobs) {
    for (const s of j.job.requiredSkills) reqIds.push(s.skillId);
    for (const s of j.job.preferredSkills) reqIds.push(s.skillId);
  }
  const heldIds = (subject.skills || []).map((s) => s.skillId);
  const edgeRead = reqIds.length && heldIds.length
    ? await relationsIntoRead(reqIds, heldIds)
    : { edges: [], unreadable: null };

  // The catalogue, for training suggestions. courseOptions() already logs and returns [] on failure,
  // so a failed read gives an empty suggestion list and an honest sentence rather than a 500.
  const courses = await courseOptions(300);

  // ---- EACH ROLE, RATED BY match.ts, GROUPED HERE ------------------------------------------------
  const readings: RoleReading[] = [];
  for (const { input: slotInput, job } of jobs) {
    let explanation: MatchExplanation;
    try {
      explanation = evaluate(subject, job, profile, edgeRead.edges);
    } catch (e: any) {
      logFail(MOD, 'compareRoles:evaluate', e);
      notRead.push({
        slot: slotInput.slot, jobKind: slotInput.jobKind, jobId: slotInput.jobId,
        because: 'This role could not be rated just now, so it was left out rather than shown as a gap.',
      });
      continue;
    }

    const gap = developmentGapFrom(explanation, courses);
    const sustainability = sustainabilityFrom(explanation, job, nowIso);
    const threeFactor = threeFactorFrom({ subject, twin, job, explanation, gap, sustainability });
    const title = job.title ? job.title.value : null;

    const suggestions: TrainingSuggestion[] = [];
    const seenCourse = new Set<string>();
    for (const l of gap.lines) {
      for (const t of l.training) {
        if (seenCourse.has(t.courseId)) continue;
        seenCourse.add(t.courseId);
        suggestions.push(t);
      }
    }

    const emitted = subjectRef
      ? resultFor({
        slot: slotInput.slot, title, explanation, gap,
        subject: subjectRef, computationId, organisationId, nowIso,
      })
      : null;

    readings.push({
      slot: slotInput.slot,
      slotLabel: SLOT_LABELS[slotInput.slot],
      slotIntro: SLOT_INTROS[slotInput.slot],
      jobKind: slotInput.jobKind,
      jobId: slotInput.jobId,
      title,
      chosenBecause: slotInput.chosenBecause ? String(slotInput.chosenBecause).slice(0, 600) : null,
      explanation,
      currentCapability: currentCapabilityFrom(explanation),
      evidenceBasedFit: evidenceBasedFitFrom(explanation),
      developmentGap: gap,
      growthHeadroom: growthHeadroomFrom(gap),
      sustainability,
      leadership: leadershipCoverageFrom(explanation),
      requiredTraining: {
        suggestions,
        sentence: suggestions.length === 0
          ? 'No course in the catalogue has a name relating to any unmet requirement on this role. That means the '
            + 'catalogue has no obvious route, not that no route exists.'
          : suggestions.length + ' course' + (suggestions.length === 1 ? '' : 's')
            + ' in the catalogue have names relating to the unmet requirements above. NOTHING HERE MAKES TRAINING '
            + 'REQUIRED: no course is assigned by this screen, and this platform cannot know whether any of them '
            + 'would close the gap. A human assigns training, with a due date and a reason, on the learning desk.',
        assignRoute: '/admin/learning/assign',
      },
      threeFactor,
      chain: chainFor({ explanation, gap, sustainability, threeFactor, slot: slotInput.slot, title }),
      result: emitted
        ? emitted.result
        // A person the spine could anchor on NEITHER an employee record NOR a login cannot be named
        // as a subject, and a SubjectRef invented for them would point at nothing. The reading is
        // still returned in full — it is correct — and only the shareable contract object is absent,
        // with the reason on the validation beside it.
        : (null as unknown as IntelligenceResult),
      resultValidation: emitted
        ? emitted.validation
        : {
          ok: false,
          errors: ['No subject reference could be built: this person is anchored on neither an employee record nor '
            + 'a login, so there is no id another patch could resolve. The reading beside this is unaffected.'],
        },
    });
  }

  // Slot order, always, so the columns never reshuffle between two loads of the same comparison.
  readings.sort((a, b) => ROLE_SLOTS.indexOf(a.slot) - ROLE_SLOTS.indexOf(b.slot));

  if (edgeRead.unreadable) {
    for (const r of readings) {
      r.chain.uncertain.push('The skill graph could not be read: ' + edgeRead.unreadable
        + ' Any requirement that a related capability might have supported reads here as unsupported, which is a '
        + 'failure to read rather than a finding.');
    }
  }

  return {
    subject: {
      ref: subjectRef,
      personKey: subject.personKey,
      displayName: subject.displayName,
      employeeId,
      userId,
      accessSentence: twin.access ? twin.access.sentence : '',
    },
    readings,
    notRead,
    refusesRanking: REFUSES_RANKING,
    refused,
    fusion: {
      label: fusion.label,
      sentence: 'The person in this comparison was composed once, by ' + fusion.label + ', for the account running '
        + 'it. This module reads no column of its own about anybody: what it could not see, it could not use, and it '
        + 'writes nothing back.',
    },
    humanAuthority: {
      decidesNothing: DECIDES_NOTHING,
      routes: [
        'Disagreeing with a reading: recordHumanDecision() in src/lib/match.ts, which stores it beside the reading.',
        'A promotion or any consequential sign-off: src/lib/workflow.ts, routed from the Organization Graph.',
        'Moving an application forward or closing it: src/lib/application-stages.ts, with an actor and a note.',
        'Assigning training: /admin/learning/assign, owned by src/lib/performance-learning.ts.',
      ],
    },
    weightProfile: { key: profile.key, label: profile.label, sentence: profile.sentence },
    computationId,
    engine: engineBlock,
    computedAt: nowIso,
    state: readings.length ? 'ok' : 'unreadable',
    sentence: readings.length
      ? readings.length + ' role' + (readings.length === 1 ? '' : 's') + ' read against one person’s record, side by '
        + 'side and in no order of preference.'
      : 'None of the roles asked for could be read, so there is nothing to compare. That is a failure to read and '
        + 'not a finding about this person.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE PICKER
// -------------------------------------------------------------------------------------------------

export interface ComparableRole {
  jobId: string;
  title: string;
  level: string | null;
  departmentId: string | null;
  isOpen: boolean;
  /** How many requirements are mapped onto the skill catalogue. Zero means nothing to compare. */
  requirementCount: number;
  /** Whether picking this role would produce a reading at all, said before it is picked. */
  comparable: boolean;
}

/**
 * The roles a comparison can be built from, WITH the number of mapped requirements on each.
 *
 * THE COUNT IS THE WHOLE POINT OF THIS FUNCTION. A role with no rows in job_requirements produces a
 * column that says "nothing was compared", which is correct and useless, and a picker that hides
 * that until after the choice sends somebody to write a job description's worth of skills onto the
 * wrong screen. src/lib/job-twin.ts already records that TWO requirement tables exist in this
 * worktree and that a recruiter cannot be expected to know which one their afternoon went into; the
 * least this picker can do is say which roles have anything in the one this comparison reads.
 *
 * `roles` is the catalogue table. `requisition` jobs are comparable too and are not listed here —
 * they are internal requests, they belong to the recruitment desk's own pickers, and a caller may
 * still pass one to compareRoles() by id.
 */
export async function comparableRoles(limit = 300): Promise<ComparableRole[]> {
  const lim = Math.min(Math.max(Number(limit) || 300, 1), 500);
  try {
    await ensureJobTwinSchema();
    // ONE QUERY, NOT ONE PER ROLE. A LATERAL count per row over a 300-row picker is 300 round trips
    // to a database a round trip away, which is the standing cost behind every slow page here.
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id::text AS id, r.title, r.level::text AS level, r.department_id::text AS department_id,
             r.is_open, COUNT(jr.id) AS requirement_count
        FROM roles r
        LEFT JOIN job_requirements jr
               ON jr.job_id = r.id AND jr.job_kind = 'role' AND jr.is_active = true
       GROUP BY r.id, r.title, r.level, r.department_id, r.is_open, r.sort_order
       ORDER BY r.sort_order ASC, r.title ASC
       LIMIT ${lim}`));
    return rows.map((r: any) => {
      const requirementCount = Number(r.requirement_count) || 0;
      return {
        jobId: String(r.id),
        title: r.title ? String(r.title) : 'Untitled role',
        level: r.level ? String(r.level) : null,
        departmentId: r.department_id ? String(r.department_id) : null,
        isOpen: r.is_open !== false,
        requirementCount,
        comparable: requirementCount > 0,
      };
    });
  } catch (e: any) {
    logFail(MOD, 'comparableRoles', e);
    return [];
  }
}

/**
 * A self-check a test or an ops page can run without a database.
 *
 * Returns the problems, empty when there are none. It exists because three of this module's
 * guarantees are the kind that a later edit breaks silently: the engine class capping what the
 * output may claim, the refusals still being refused upstream, and rule 19's word list passing over
 * every label this module prints.
 */
export function selfCheck(): string[] {
  const problems: string[] = [];
  const spec = ENGINE_CLASS_SPECS[ENGINE_CLASS];

  // Compared through the WIDE type on purpose. DECISION_USE is a const whose inferred type is the
  // single literal it currently holds, so `=== 'may_decide'` is a type error rather than a check —
  // and deleting the check to satisfy the compiler would remove the guard exactly when somebody
  // widens the constant, which is the only moment it was ever going to fire.
  if ((DECISION_USE as DecisionUse) === 'may_decide') {
    problems.push('DECISION_USE may never be may_decide (rule 14).');
  }
  if (spec.maxDecisionUse === 'advisory_only' && DECISION_USE !== 'advisory_only') {
    problems.push('engine class ' + ENGINE_CLASS + ' is advisory_only and this module claims more.');
  }
  if (spec.alwaysHumanReview === false && DECISION_USE !== 'advisory_only' && DECISION_USE !== 'supporting_only') {
    problems.push('DECISION_USE is not a recognised value.');
  }

  // The two refusals this module is built around. If either stops being refused upstream, the
  // honest replacements below become a euphemism for something the system now permits, and whoever
  // changed it should hear about it from a failing check rather than from a screen.
  for (const subject of ['growth potential', 'leadership potential']) {
    if (assertAllowedAboutPerson(subject).allowed) {
      problems.push('"' + subject + '" is no longer refused by src/lib/person-assertions.ts. This module’s '
        + 'replacements were written on the assumption that it is.');
    }
  }

  const labels = ([] as string[])
    .concat(Object.values(SLOT_LABELS), Object.values(SLOT_INTROS), Object.values(GAP_KIND_LABELS), [DIMENSION.label]);
  for (const l of labels) {
    const c = checkPublicCopy(l);
    if (!c.ok) problems.push('label uses forbidden terminology (' + c.found.join(', ') + '): ' + l.slice(0, 60));
  }

  return problems;
}
