// src/lib/fusion/providers.ts — THE FIRST-PARTY PROVIDERS. WHAT PATCH 06 READS ITSELF.
//
// =================================================================================================
// WHAT IS MINE TO READ, AND WHAT IS NOT
// =================================================================================================
//
// The patch brief names four inputs that belong to nobody else: skills and performance data, role
// requirements, assessments, and employment history. Those are read here, through the modules that
// OWN them — never by querying their tables directly, because a second reader of somebody else's
// table is a second interpretation of it that drifts the first time they change a column.
//
//   src/lib/skills.ts                 the skill matrix. Levels 1-5 and how each was recorded.
//   src/lib/performance.ts            appraisal history. A named manager's written judgement.
//   src/lib/performance-learning.ts   assigned learning and what was finished.
//   src/lib/capability-coverage.ts    a role's recorded requirements, and this person against them.
//   src/lib/org-graph.ts              who this person is responsible for. A RELATIONSHIP, per row.
//   src/lib/db (hr_employees)         employment history: joined, confirmed, still here.
//
// The inferred foundation, behavioural evidence and feedback intelligence are NOT here. They belong
// to patches 03, 04 and 05, they register through src/lib/fusion/signals.ts, and until they do the
// profile says they are missing. There is no stub standing in for them: a stub that returned
// plausible signals would put invented evidence into a record about a real person.
//
// =================================================================================================
// A SELF-RECORDED SKILL CONTRIBUTES NOTHING, AND IS SHOWN CONTRIBUTING NOTHING
// =================================================================================================
//
// src/lib/evidence-graph.ts settled this for the whole product: a keyword is never proof of
// competence. So `source = 'self'` rows are counted, reported in the INPUTS section, and turned into
// no signal at all. They are a person's word about themselves, which is a real thing worth showing
// and not a demonstration of anything.
//
// =================================================================================================
// ONE READ PER GATHER, NOT ONE PER PROVIDER
// =================================================================================================
//
// Three providers read the skill matrix (manager-assessed, course-earned, assessment-earned), and
// three separate calls would be three round trips. Measured from the deployed function a round trip
// costs about 177ms, and this project has already learned that ROUND-TRIP COUNT is the lever rather
// than query cleverness. The loaders below memoise on the GatherContext object — one per gather,
// collected with it, never shared between people.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { skillsForEmployee, SKILL_LEVEL_LABELS, type EmployeeSkill } from '@/lib/skills';
import { reviewHistory, RATING_MAX, type PerformanceReview } from '@/lib/performance';
import { learningPathFor, type LearningItem } from '@/lib/performance-learning';
import { getDirectReports, getMentees } from '@/lib/org-graph';
import {
  registerSignalProvider,
  type GatherContext,
  type ProviderResult,
  type SignalProvider,
} from './signals';
import type { FusionDimension, Signal, SourceClass, AssertionType } from './types';

const MOD = 'fusion/providers';

export const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Levels run 1-5 and 3 is "works independently". -1..+1 with the midpoint where the matrix puts it. */
const levelToPosition = (level: number): number => Math.max(-1, Math.min(1, (level - 3) / 2));

/** Appraisal ratings run 1-5 on the same shape. */
const ratingToPosition = (rating: number): number =>
  Math.max(-1, Math.min(1, (rating - (RATING_MAX + 1) / 2) / ((RATING_MAX - 1) / 2)));

const iso = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// -------------------------------------------------------------------------------------------------
// PER-GATHER MEMOS
// -------------------------------------------------------------------------------------------------

const skillMemo = new WeakMap<GatherContext, Promise<EmployeeSkill[]>>();
const reviewMemo = new WeakMap<GatherContext, Promise<PerformanceReview[]>>();
const learningMemo = new WeakMap<GatherContext, Promise<LearningItem[]>>();

function loadSkills(ctx: GatherContext): Promise<EmployeeSkill[]> {
  let p = skillMemo.get(ctx);
  if (!p) {
    p = skillsForEmployee(ctx.employeeId).catch((e) => { logFail('loadSkills', e); throw e; });
    skillMemo.set(ctx, p);
  }
  return p;
}

function loadReviews(ctx: GatherContext): Promise<PerformanceReview[]> {
  let p = reviewMemo.get(ctx);
  if (!p) {
    p = reviewHistory(ctx.employeeId, 12).catch((e) => { logFail('loadReviews', e); throw e; });
    reviewMemo.set(ctx, p);
  }
  return p;
}

function loadLearning(ctx: GatherContext): Promise<LearningItem[]> {
  let p = learningMemo.get(ctx);
  if (!p) {
    p = learningPathFor(ctx.employeeId).catch((e) => { logFail('loadLearning', e); throw e; });
    learningMemo.set(ctx, p);
  }
  return p;
}

// -------------------------------------------------------------------------------------------------
// SIGNAL CONSTRUCTION
// -------------------------------------------------------------------------------------------------

let seq = 0;

function makeSignal(input: {
  dimension: FusionDimension;
  sourceClass: SourceClass;
  ownerModule: string;
  sourceTable: string | null;
  sourceId: string | null;
  position: number;
  strength: number;
  observedAt: string | null;
  statement: string;
  basis: string;
  assertion: AssertionType;
  evidenceUrl?: string | null;
  locator?: string | null;
  attributedToUserId?: string | null;
  attributedToRelationship?: string | null;
}): Signal {
  seq += 1;
  return {
    signalId: 'p6-' + seq,
    providerKey: '',
    ownerModule: input.ownerModule,
    sourceTable: input.sourceTable,
    sourceId: input.sourceId,
    dimension: input.dimension,
    sourceClass: input.sourceClass,
    position: Math.max(-1, Math.min(1, input.position)),
    strength: Math.max(0, Math.min(1, input.strength)),
    observedAt: input.observedAt,
    statement: input.statement,
    basis: input.basis,
    assertion: input.assertion,
    evidenceUrl: input.evidenceUrl ?? null,
    locator: input.locator ?? null,
    attributedToUserId: input.attributedToUserId ?? null,
    attributedToRelationship: input.attributedToRelationship ?? null,
    // Not an inferred provider anywhere in this file, so no advisory notice is required on any of
    // them. The one place the notice matters is PATCH 03's provider, and screenSignal() refuses that
    // one if it arrives without it.
    advisoryNotice: null,
  };
}

// =================================================================================================
// THE SKILL MATRIX — SPLIT BY HOW EACH LEVEL WAS RECORDED
// =================================================================================================
//
// One matrix, three providers, because a provider declares ONE source class and that declaration is
// what the whole weighting rule rests on. A level a manager assessed and a level a graded assessment
// produced are different kinds of evidence about the same person, and pooling them would hide the
// difference exactly where it matters most.

const SKILL_DIMENSIONS: readonly FusionDimension[] = ['current_capability', 'development_requirements'];

function skillSignals(
  skills: readonly EmployeeSkill[],
  wantSource: string,
  sourceClass: SourceClass,
): Signal[] {
  const out: Signal[] = [];
  for (const s of skills) {
    if (String(s.source || '').toLowerCase() !== wantSource) continue;
    const level = Number(s.level) || 0;
    if (level < 1) continue;

    // Evidence attached lifts how much this counts, not what it says. A level with a link behind it
    // is the same claim, better supported.
    const strength = Math.min(1, 0.5 + (s.evidenceUrl ? 0.3 : 0) + (s.evidence ? 0.1 : 0));
    const levelLabel = SKILL_LEVEL_LABELS[level] || String(level);

    out.push(makeSignal({
      dimension: 'current_capability',
      sourceClass,
      ownerModule: 'src/lib/skills.ts',
      sourceTable: 'hr_employee_skills',
      sourceId: s.id,
      position: levelToPosition(level),
      strength,
      observedAt: iso(s.assessedAt),
      statement: s.skillName + ' recorded at level ' + level + ' (' + levelLabel + ').',
      basis: 'The skill matrix, recorded from ' + wantSource + '.',
      assertion: sourceClass === 'assessment_evidence' ? 'factual' : 'verified',
      evidenceUrl: s.evidenceUrl,
      locator: s.evidence,
    }));

    // A skill below working level is something to develop. Stated as a development need rather than
    // folded into the capability number twice.
    if (level < 3) {
      out.push(makeSignal({
        dimension: 'development_requirements',
        sourceClass,
        ownerModule: 'src/lib/skills.ts',
        sourceTable: 'hr_employee_skills',
        sourceId: s.id,
        position: (3 - level) / 2,
        strength: strength * 0.8,
        observedAt: iso(s.assessedAt),
        statement: s.skillName + ' is recorded below working level (' + levelLabel + ').',
        basis: 'The skill matrix, recorded from ' + wantSource + '.',
        assertion: 'calculated',
        evidenceUrl: s.evidenceUrl,
      }));
    }
  }
  return out;
}

function skillProvider(key: string, label: string, wantSource: string, sourceClass: SourceClass): SignalProvider {
  return {
    key,
    label,
    sourceClass,
    ownerPatch: 'PATCH 06',
    ownerModule: 'src/lib/skills.ts',
    supplies: label + ' from the skill matrix.',
    dimensions: SKILL_DIMENSIONS,
    async gather(ctx: GatherContext): Promise<ProviderResult> {
      const skills = await loadSkills(ctx);
      const mine = skills.filter((s) => String(s.source || '').toLowerCase() === wantSource);
      const selfCount = skills.filter((s) => String(s.source || '').toLowerCase() === 'self').length;

      const inputs = [{
        source: label,
        ownerModule: 'src/lib/skills.ts',
        rows: mine.length,
        sentence: mine.length
          ? mine.length + ' skill level' + (mine.length === 1 ? '' : 's') + ' recorded from ' + wantSource + '.'
          : 'No skill levels recorded from ' + wantSource + '.',
      }];

      // Reported ONCE, by the manager-assessed provider, so the count is not printed three times.
      if (wantSource === 'manager' && selfCount) {
        inputs.push({
          source: 'Self-recorded skills',
          ownerModule: 'src/lib/skills.ts',
          rows: selfCount,
          sentence: selfCount + ' skill' + (selfCount === 1 ? '' : 's') + ' this person recorded about '
            + 'themselves were read and contributed NOTHING to any reading. A keyword is not proof of '
            + 'competence, so a self-recorded level is shown as their word and counted as nothing.',
        });
      }

      return { signals: skillSignals(skills, wantSource, sourceClass), inputs, unreadable: [] };
    },
  };
}

// =================================================================================================
// APPRAISAL HISTORY — A NAMED MANAGER'S WRITTEN JUDGEMENT
// =================================================================================================

const REVIEW_DIMENSIONS: readonly FusionDimension[] = [
  'current_capability',
  'growth_potential',
  'leadership_readiness',
  'collaboration',
  'development_requirements',
  'professional_trajectory',
];

/**
 * A review contributes several signals because it says several things, and separating them is what
 * lets a screen show "strong on delivery, thin on leadership" rather than one number.
 *
 * A REVIEW THE MANAGER HAS NOT SUBMITTED IS NOT EVIDENCE. Drafts are skipped: an unfinished thought
 * is not a judgement anybody has put their name to, and reading one would be reading somebody's
 * notes.
 *
 * NOTHING HERE READS `outcome` AS A DECISION. `promotion_recommended` is a manager's RECOMMENDATION
 * and it is treated as one signal about leadership readiness, not as a promotion. The decision lives
 * in src/lib/workflow.ts and does not enter this engine at all.
 */
function reviewSignals(reviews: readonly PerformanceReview[]): Signal[] {
  const out: Signal[] = [];

  for (const r of reviews) {
    if (!r.managerSubmittedAt) continue;
    const at = iso(r.managerSubmittedAt);
    const cycle = r.cycleTitle || 'an appraisal cycle';

    // The calibrated rating wins where there is one: calibration is the organisation correcting for
    // one manager's scale, which is exactly the "one person's view is not organisational truth" rule
    // applied by the module that owns it.
    const headline = r.calibratedRating ?? r.overallRating;
    const calibrated = r.calibratedRating !== null && r.calibratedRating !== undefined;

    if (headline) {
      out.push(makeSignal({
        dimension: 'current_capability',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: ratingToPosition(Number(headline)),
        strength: calibrated ? 1 : 0.85,
        observedAt: at,
        statement: 'Rated ' + headline + ' of ' + RATING_MAX + ' overall in ' + cycle
          + (calibrated ? ', after calibration.' : '.'),
        basis: calibrated
          ? 'An appraisal a named manager submitted, then calibrated across the cycle.'
          : 'An appraisal a named manager submitted.',
        assertion: 'verified',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    }

    if (r.goalsScore) {
      out.push(makeSignal({
        dimension: 'professional_trajectory',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: ratingToPosition(Number(r.goalsScore)),
        strength: 0.7,
        observedAt: at,
        statement: 'Scored ' + r.goalsScore + ' of ' + RATING_MAX + ' against agreed goals in ' + cycle + '.',
        basis: 'The goals half of a submitted appraisal.',
        assertion: 'verified',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    }

    if (r.attitudeScore) {
      out.push(makeSignal({
        dimension: 'collaboration',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: ratingToPosition(Number(r.attitudeScore)),
        strength: 0.7,
        observedAt: at,
        statement: 'Scored ' + r.attitudeScore + ' of ' + RATING_MAX + ' on working with others in ' + cycle + '.',
        basis: 'The working-with-others half of a submitted appraisal.',
        assertion: 'verified',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    }

    if (r.improvements && r.improvements.trim()) {
      out.push(makeSignal({
        dimension: 'development_requirements',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: 0.6,
        strength: 0.8,
        observedAt: at,
        statement: r.improvements.trim().slice(0, 240),
        basis: 'What the manager wrote under what to work on, in ' + cycle + '.',
        assertion: 'verified',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    }

    if (r.outcome === 'promotion_recommended') {
      out.push(makeSignal({
        dimension: 'leadership_readiness',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: 0.7,
        strength: 0.8,
        observedAt: at,
        statement: 'A manager recommended this person for a step up, in ' + cycle + '.',
        basis: 'The recorded outcome of a submitted appraisal. It is a recommendation, and the '
          + 'decision on it is made elsewhere by a named human.',
        assertion: 'recommended',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    } else if (r.outcome === 'needs_support') {
      out.push(makeSignal({
        dimension: 'development_requirements',
        sourceClass: 'manager_evidence',
        ownerModule: 'src/lib/performance.ts',
        sourceTable: 'hr_performance_reviews',
        sourceId: r.id,
        position: 0.7,
        strength: 0.8,
        observedAt: at,
        statement: 'A manager recorded that support is needed, in ' + cycle + '.',
        basis: 'The recorded outcome of a submitted appraisal.',
        assertion: 'verified',
        locator: cycle,
        attributedToRelationship: 'reporting manager',
      }));
    }
  }

  // GROWTH IS A DIFFERENCE, NOT A LEVEL. Two submitted appraisals with ratings are the minimum that
  // can say anything at all about growth, and with fewer this says nothing rather than guessing from
  // one point.
  const rated = reviews
    .filter((r) => r.managerSubmittedAt && (r.calibratedRating ?? r.overallRating))
    .map((r) => ({ at: iso(r.managerSubmittedAt), v: Number(r.calibratedRating ?? r.overallRating) }))
    .filter((r) => r.at)
    .sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string));

  if (rated.length >= 2) {
    const first = rated[0];
    const last = rated[rated.length - 1];
    const move = last.v - first.v;
    out.push(makeSignal({
      dimension: 'growth_potential',
      sourceClass: 'manager_evidence',
      ownerModule: 'src/lib/performance.ts',
      sourceTable: 'hr_performance_reviews',
      sourceId: null,
      position: Math.max(-1, Math.min(1, move / 2)),
      strength: Math.min(1, 0.4 + rated.length * 0.15),
      observedAt: last.at,
      statement: move === 0
        ? 'The appraisal rating has held at ' + last.v + ' across ' + rated.length + ' cycles.'
        : 'The appraisal rating has moved from ' + first.v + ' to ' + last.v + ' across ' + rated.length + ' cycles.',
      basis: 'The difference between the earliest and latest submitted appraisal ratings on record.',
      assertion: 'calculated',
    }));
  }

  return out;
}

const performanceProvider: SignalProvider = {
  key: 'patch06.performance',
  label: 'Appraisal history',
  sourceClass: 'manager_evidence',
  ownerPatch: 'PATCH 06',
  ownerModule: 'src/lib/performance.ts',
  supplies: 'What a named manager wrote and submitted in an appraisal.',
  dimensions: REVIEW_DIMENSIONS,
  async gather(ctx: GatherContext): Promise<ProviderResult> {
    const reviews = await loadReviews(ctx);
    const submitted = reviews.filter((r) => r.managerSubmittedAt);
    const drafts = reviews.length - submitted.length;
    const inputs = [{
      source: 'Appraisal history',
      ownerModule: 'src/lib/performance.ts',
      rows: submitted.length,
      sentence: submitted.length
        ? submitted.length + ' submitted appraisal' + (submitted.length === 1 ? '' : 's') + ' read'
          + (drafts ? '. ' + drafts + ' unsubmitted draft' + (drafts === 1 ? ' was' : 's were') + ' skipped: an unfinished appraisal is not a judgement anybody has put their name to.' : '.')
        : 'No submitted appraisal is on record'
          + (drafts ? ', though ' + drafts + ' draft' + (drafts === 1 ? ' exists' : 's exist') + '.' : '.'),
    }];
    return { signals: reviewSignals(submitted), inputs, unreadable: [] };
  },
};

// =================================================================================================
// LEARNING — WHAT WAS ASSIGNED AND WHAT WAS FINISHED
// =================================================================================================

const learningProvider: SignalProvider = {
  key: 'patch06.learning',
  label: 'Assigned learning',
  sourceClass: 'observed_evidence',
  ownerPatch: 'PATCH 06',
  ownerModule: 'src/lib/performance-learning.ts',
  supplies: 'Learning that was assigned, and what was actually completed.',
  dimensions: ['learning_capacity', 'development_requirements'],
  async gather(ctx: GatherContext): Promise<ProviderResult> {
    const items = await loadLearning(ctx);
    const done = items.filter((i) => i.completedAt);
    const outstanding = items.filter((i) => !i.completedAt && i.status === 'assigned');
    const nowMs = ctx.now.getTime();
    const signals: Signal[] = [];

    for (const i of done) {
      signals.push(makeSignal({
        dimension: 'learning_capacity',
        sourceClass: 'observed_evidence',
        ownerModule: 'src/lib/performance-learning.ts',
        sourceTable: 'hr_learning_assignments',
        sourceId: i.assignmentId,
        position: 0.6,
        strength: i.required ? 0.7 : 0.5,
        observedAt: iso(i.completedAt),
        statement: 'Completed ' + i.courseTitle + '.',
        basis: 'A completion counted from the completion tables, not from a stored progress figure.',
        assertion: 'factual',
        locator: i.category,
      }));
    }

    // AN OVERDUE ASSIGNMENT IS A DEVELOPMENT ITEM, NOT A CHARACTER FINDING. It says something is
    // outstanding. It says nothing about why, and there is nowhere here for a reason to be inferred.
    for (const i of outstanding) {
      const dueMs = i.dueOn ? Date.parse(i.dueOn) : NaN;
      const overdue = isFinite(dueMs) && dueMs < nowMs;
      signals.push(makeSignal({
        dimension: 'development_requirements',
        sourceClass: 'observed_evidence',
        ownerModule: 'src/lib/performance-learning.ts',
        sourceTable: 'hr_learning_assignments',
        sourceId: i.assignmentId,
        position: overdue ? 0.6 : 0.35,
        strength: i.required ? 0.6 : 0.4,
        observedAt: null,
        statement: i.courseTitle + ' is assigned and not yet finished'
          + (overdue ? ', and its date has passed.' : '.'),
        basis: 'An open learning assignment. It records what is outstanding, and nothing about why.',
        assertion: 'factual',
        locator: i.category,
      }));
    }

    return {
      signals,
      inputs: [{
        source: 'Assigned learning',
        ownerModule: 'src/lib/performance-learning.ts',
        rows: items.length,
        sentence: items.length
          ? items.length + ' assignment' + (items.length === 1 ? '' : 's') + ' read — ' + done.length
            + ' completed, ' + outstanding.length + ' still open.'
          : 'No learning has been assigned to this person, so nothing here could be read either way.',
      }],
      unreadable: [],
    };
  },
};

// =================================================================================================
// ASSESSMENTS — A GRADED ATTEMPT ON A RUBRIC THAT EXISTED FIRST
// =================================================================================================
//
// This reads edu_attempts through the learner account, which is `hr_employees.user_id`. THAT COLUMN
// IS NULLABLE and frequently null, so the honest answer when it is missing is "no learner account is
// linked to this employee record" rather than "no assessments". The two look identical on a screen
// unless one of them is said out loud.

const assessmentProvider: SignalProvider = {
  key: 'patch06.assessments',
  label: 'Assessment attempts',
  sourceClass: 'assessment_evidence',
  ownerPatch: 'PATCH 06',
  ownerModule: 'src/lib/assessment.ts',
  supplies: 'Graded assessment attempts, scored against a rubric that existed before they were sat.',
  dimensions: ['current_capability', 'learning_capacity'],
  async gather(ctx: GatherContext): Promise<ProviderResult> {
    if (!isUuid(ctx.userId)) {
      return {
        signals: [],
        inputs: [{
          source: 'Assessment attempts',
          ownerModule: 'src/lib/assessment.ts',
          rows: 0,
          sentence: 'No learner account is linked to this employee record, so assessments could not '
            + 'be looked up at all. That is a missing link, not an absence of assessments.',
        }],
        unreadable: [{
          what: 'Assessment attempts',
          because: 'This employee record carries no user_id, and assessments are keyed by the learner '
            + 'account. Link the records to read them.',
        }],
      };
    }

    let rows: any[] = [];
    try {
      rows = rowsOf(await db.execute(sql`
        SELECT a.id, a.assessment_id, a.mode, a.state, a.percentage, a.passed, a.submitted_at,
               s.title AS assessment_title
          FROM edu_attempts a
          LEFT JOIN edu_assessments s ON s.id = a.assessment_id
         WHERE a.user_id = ${ctx.userId}
           AND a.mode = 'official'
           AND a.state = 'graded'
         ORDER BY a.submitted_at DESC NULLS LAST
         LIMIT 40`));
    } catch (e: any) {
      logFail('assessments', e);
      return {
        signals: [],
        inputs: [],
        unreadable: [{
          what: 'Assessment attempts',
          because: 'The assessment records could not be read just now: '
            + (e?.cause?.message || e?.message || 'no reason was given')
            + '. This is a failure to look, not a finding that there are none.',
        }],
      };
    }

    const signals: Signal[] = [];
    for (const r of rows) {
      const pct = r.percentage === null || r.percentage === undefined ? null : Number(r.percentage);
      if (pct === null || !isFinite(pct)) continue;
      const title = String(r.assessment_title || 'an assessment');
      // 0-100 onto -1..+1 with 50 at the midpoint. A pass mark is a policy of the assessment, not of
      // this engine, so the score is read as a score and `passed` is stated separately in the words.
      signals.push(makeSignal({
        dimension: 'current_capability',
        sourceClass: 'assessment_evidence',
        ownerModule: 'src/lib/assessment.ts',
        sourceTable: 'edu_attempts',
        sourceId: String(r.id),
        position: (pct - 50) / 50,
        strength: 0.8,
        observedAt: iso(r.submitted_at),
        statement: 'Scored ' + Math.round(pct) + '% on ' + title + (r.passed ? ' (passed).' : '.'),
        basis: 'A graded official attempt, scored against the assessment’s own rubric.',
        assertion: 'factual',
        locator: title,
      }));
    }

    return {
      signals,
      inputs: [{
        source: 'Assessment attempts',
        ownerModule: 'src/lib/assessment.ts',
        rows: rows.length,
        sentence: rows.length
          ? rows.length + ' graded official attempt' + (rows.length === 1 ? '' : 's') + ' read. '
            + 'Practice attempts were not read: practice is for practising.'
          : 'No graded official attempt is on record for this learner account.',
      }],
      unreadable: [],
    };
  },
};

// =================================================================================================
// EMPLOYMENT HISTORY AND RESPONSIBILITY
// =================================================================================================
//
// TENURE IS NOT MERIT, and this provider is careful about the difference. Time served says something
// about how much RECORD there is, which is why it feeds work sustainability and trajectory weakly
// and feeds capability not at all. A long-serving person is not thereby a capable one.
//
// RESPONSIBILITY IS A RELATIONSHIP, resolved per row from src/lib/org-graph.ts. It is not a title,
// it is not `users.role`, and it is not a column somebody typed. Where the graph is empty this
// provider says so instead of reporting that a person leads nobody — which would be true of everyone
// in the company and would send a manager hunting for a data problem that does not exist.

const employmentProvider: SignalProvider = {
  key: 'patch06.employment',
  label: 'Employment record and responsibility',
  sourceClass: 'observed_evidence',
  ownerPatch: 'PATCH 06',
  ownerModule: 'src/lib/org-graph.ts, hr_employees',
  supplies: 'Employment history, confirmation, and who this person is recorded as responsible for.',
  dimensions: ['leadership_readiness', 'work_sustainability', 'professional_trajectory'],
  async gather(ctx: GatherContext): Promise<ProviderResult> {
    const signals: Signal[] = [];
    const inputs: ProviderResult['inputs'] = [];
    const unreadable: ProviderResult['unreadable'] = [];

    let emp: any = null;
    try {
      emp = rowsOf(await db.execute(sql`
        SELECT id, joining_date, confirmation_date, probation_end_date, employment_status,
               designation, employment_type, is_active
          FROM hr_employees
         WHERE id = ${ctx.employeeId}::uuid
         LIMIT 1`))[0] || null;
    } catch (e: any) {
      logFail('employment', e);
      unreadable.push({
        what: 'Employment record',
        because: 'It could not be read just now: ' + (e?.cause?.message || e?.message || 'no reason given') + '.',
      });
    }

    if (emp) {
      const joined = emp.joining_date ? Date.parse(String(emp.joining_date)) : NaN;
      const months = isFinite(joined) ? Math.max(0, Math.round((ctx.now.getTime() - joined) / DAY_MS / 30.44)) : null;

      inputs.push({
        source: 'Employment record',
        ownerModule: 'hr_employees',
        rows: 1,
        sentence: months === null
          ? 'The employment record has no joining date, so tenure could not be read.'
          : months + ' months on record since joining'
            + (emp.confirmation_date ? ', confirmed after probation.' : ', not yet confirmed after probation.'),
      });

      if (emp.confirmation_date) {
        signals.push(makeSignal({
          dimension: 'professional_trajectory',
          sourceClass: 'observed_evidence',
          ownerModule: 'hr_employees',
          sourceTable: 'hr_employees',
          sourceId: String(emp.id),
          position: 0.4,
          strength: 0.5,
          observedAt: iso(emp.confirmation_date),
          statement: 'Confirmed in post after probation.',
          basis: 'The confirmation date on the employment record.',
          assertion: 'factual',
        }));
      }

      // A long, unbroken record is evidence that the current pattern HAS been sustained. It is not
      // evidence that it is comfortable, and the sentence says exactly that much and no more.
      if (months !== null && months >= 12 && emp.is_active) {
        signals.push(makeSignal({
          dimension: 'work_sustainability',
          sourceClass: 'observed_evidence',
          ownerModule: 'hr_employees',
          sourceTable: 'hr_employees',
          sourceId: String(emp.id),
          position: 0.3,
          strength: 0.4,
          observedAt: null,
          statement: months + ' months of continuous service on record.',
          basis: 'The employment record. It shows the pattern has continued; it does not show how it feels.',
          assertion: 'factual',
        }));
      }
    }

    try {
      const reports = await getDirectReports(ctx.employeeId);
      const mentees = await getMentees(ctx.employeeId);
      const carrying = reports.length + mentees.length;

      inputs.push({
        source: 'Organisation graph',
        ownerModule: 'src/lib/org-graph.ts',
        rows: carrying,
        sentence: carrying
          ? 'Recorded as responsible for ' + reports.length + ' direct report'
            + (reports.length === 1 ? '' : 's') + ' and ' + mentees.length + ' mentee'
            + (mentees.length === 1 ? '' : 's') + ', resolved per relationship from the graph.'
          : 'The organisation graph records no reporting or mentoring relationship for this person. '
            + 'If the graph has not been set up, that is what this line means — not that nobody reports to them.',
      });

      if (carrying > 0) {
        signals.push(makeSignal({
          dimension: 'leadership_readiness',
          sourceClass: 'observed_evidence',
          ownerModule: 'src/lib/org-graph.ts',
          sourceTable: 'org_relationships',
          sourceId: null,
          position: Math.min(0.7, 0.3 + carrying * 0.1),
          strength: 0.6,
          observedAt: null,
          statement: 'Carries recorded responsibility for ' + carrying + ' '
            + (carrying === 1 ? 'person' : 'people') + '.',
          basis: 'Live relationships in the organisation graph, resolved per row rather than from a title.',
          assertion: 'factual',
        }));
      }
    } catch (e: any) {
      logFail('org-graph', e);
      unreadable.push({
        what: 'Organisation graph',
        because: 'Responsibility relationships could not be read just now: '
          + (e?.cause?.message || e?.message || 'no reason given')
          + '. Leadership readiness below is missing whatever they would have contributed.',
      });
    }

    return { signals, inputs, unreadable };
  },
};

// =================================================================================================
// REGISTRATION
// =================================================================================================
//
// Called once, at module load, by anything that imports this file. registerSignalProvider() REFUSES
// a duplicate key rather than replacing it, so a second import is a no-op rather than a silent
// re-registration — and a genuine key collision with another patch is reported instead of one
// module quietly displacing the other.

export const FIRST_PARTY_PROVIDERS: readonly SignalProvider[] = Object.freeze([
  skillProvider('patch06.skills.manager', 'Manager-assessed skill levels', 'manager', 'manager_evidence'),
  skillProvider('patch06.skills.assessment', 'Assessment-earned skill levels', 'assessment', 'assessment_evidence'),
  skillProvider('patch06.skills.course', 'Course-earned skill levels', 'course', 'observed_evidence'),
  performanceProvider,
  learningProvider,
  assessmentProvider,
  employmentProvider,
]);

let registered = false;

export function registerFirstPartyProviders(): { registered: number; refused: string[] } {
  if (registered) return { registered: FIRST_PARTY_PROVIDERS.length, refused: [] };
  const refused: string[] = [];
  let count = 0;
  for (const p of FIRST_PARTY_PROVIDERS) {
    const r = registerSignalProvider(p);
    if (r.ok) count += 1;
    else refused.push(p.key + ': ' + (r.error || 'refused'));
  }
  registered = true;
  return { registered: count, refused };
}
