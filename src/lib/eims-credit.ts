// src/lib/eims-credit.ts — THE CREDIT ENGINE, THE GRADING RUBRIC, AND THE FINAL INTERNSHIP RECORD.
//
// =================================================================================================
// THE THREE SENTENCES THIS FILE IS BUILT AROUND
// =================================================================================================
//
// 1. CREDIT IS NEVER EARNED BY LOGIN TIME OR BY ATTENDANCE. Not partly, not as a tie-breaker. There
//    is no query in this file against hr_attendance, hr_clock_events or any other record of when
//    somebody was present, and `validateCreditConfig()` REFUSES a configuration whose components
//    name attendance, presence, login, clock time or punctuality. That refusal is the enforcement:
//    a comment can be ignored, a validator that rejects the save cannot.
//
// 2. HOLISTIC DEVELOPMENT IS EMBEDDED IN THE CREDITS, NEVER AN EXTRA COURSE BESIDE THEM. A twelve
//    credit internship is twelve credits INCLUDING holistic development, exactly as the weekly
//    commitment is forty hours INCLUDING well-being and never forty plus two. A configuration that
//    says otherwise is not representable: `holisticEmbedded` is checked on every save.
//
// 3. EDURANKAI DOES NOT AWARD THE CREDENTIAL. This platform COMPUTES a recommendation and holds the
//    evidence behind it; an accredited partner institution awards. `CreditDecision.awarded` is typed
//    `false` — the literal type, not the boolean — so no code path anywhere can set it true, and the
//    copy printed beside every figure says the same thing in words.
//
// =================================================================================================
// WHY THE CONVERSION IS A RECORD AND NOT A CONSTANT
// =================================================================================================
//
// Institutional regulations differ. One partner counts a minimum number of hours per credit, another
// counts weeks, another requires a rubric result above a threshold before any credit is recommended
// at all. A number in a file cannot express that and, worse, it cannot say WHO DECIDED IT.
//
// So the conversion lives in `eims_credit_configs`: per programme, versioned, and carrying an OWNER
// — a named person accountable for it. There is no fallback constant. Where no configuration has
// been saved, this module computes NO CREDIT FIGURE and says why. That is deliberate: a default of
// twelve credits appearing on a document because nobody configured anything is precisely the class
// of error this record exists to prevent.
//
// The defaults below (`defaultCreditComponents`, `DEFAULT_GRADE_BANDS`, `DEFAULT_RUBRIC_CRITERIA`)
// are SEEDS a human saves and then owns. They are starting points for a form, never an operative
// rule, and nothing computes against them until they have been written down with a name against them.
//
// =================================================================================================
// WHAT THE FINAL RECORD IS
// =================================================================================================
//
// One frozen document per person: identity, title, department, role, duration, required / allocated
// / completed / verified hours, outcomes with their evidence, projects, assignments, training,
// assessments, holistic participation, mentor evaluation, grade, credits where applicable, and the
// certificate and verification id. It is assembled from live records, then FROZEN into JSONB when it
// is issued — a document a university reads six months from now must be able to say what it rested
// on, and one that recomputes itself every time somebody opens a page cannot.
//
// THE CERTIFICATE REUSES THE EXISTING LEDGER: `universal_certificates` (src/lib/universal-
// certificates.ts), kind 'internship', already publicly verifiable at /credentials/<serial> and
// already revocable with an honest answer. No second certificate table is created here, and the
// serial IS the verification id — two ids for one certificate is how a verification page starts
// disagreeing with the certificate it verifies.
//
// THE PUBLIC PAGE SHOWS ENOUGH TO VERIFY AND NO MORE. `publicVerification()` returns the holder's
// name, the programme, the partner who awards, the dates, the headline figures and the serial. No
// email address, no employee id, no department, no mentor comments, no per-outcome detail. Those
// live on the internal record, which is read behind a gate.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Never r.rows[0]; every read goes through rows().
//   - The real Postgres reason is on e.cause. Logged as e?.cause?.message || e?.message, every time.
//   - NO EXCEPTION IS SWALLOWED IN A WRITE PATH. Issuing a credential is the last place on earth for
//     a bare catch: every writer returns whether it wrote, and why not when it did not.
//   - Self-bootstrapping DDL only, inside an ensureOnce guard, additive, CREATE TABLE IF NOT EXISTS
//     and ADD COLUMN IF NOT EXISTS, never a DROP. New columns need a NEW ensureOnce key.
//   - departments.id is varchar(50) in schema.ts and UUID in hr-schema.sql: compared ::text.
//   - hr_employees uses full_name.
//   - Relationships come from src/lib/org-graph.ts (through mayAssessOutcome), never users.role.
//   - Every const is declared before the function that reads it. const is not hoisted.

// The db handle is resolved LAZILY. Importing it at module scope makes src/lib/db throw
// DATABASE_URL is not set the moment ANY importer loads, which put the credit arithmetic — pure
// functions with no database in them — permanently out of reach of a test. A calculation that
// decides somebody academic credit should be provable without a production connection.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { can } from '@/lib/auth/permissions';
import { logAudit } from '@/lib/audit';
import { issueUniversalCertificate, revokeUniversal } from '@/lib/universal-certificates';
import { requiredWeeklyHours } from '@/lib/credit-week';
import { resolveWeeklyCeiling } from '@/lib/eims-workload';
import { WELLBEING_DOMAINS } from '@/lib/engagement-policy';
import {
  outcomeCoverageFor, mayAssessOutcome, programmeKeyOf, DEFAULT_PROGRAMME_KEY,
  type Actor, type CoverageReport, type SourceNote,
} from '@/lib/eims-outcomes';

// -------------------------------------------------------------------------------------------------
// HELPERS AND CONSTANTS — all declared above every function that reads them.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a plain array, never a { rows } object. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-credit] ' + tag, e?.cause?.message || e?.message);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const iso = (d: any): string => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
};

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const MAX_ROWS = 200;

/** Verification lives at this path. One url shape, so the record and the certificate agree. */
export const VERIFY_PATH = '/credentials/';

/* -------------------------------------------------------------------------------------- the copy */

export const PLATFORM_ROLE_SENTENCE =
  'EduRankAI is the technology platform. It computes this record and holds the evidence behind it. '
  + 'An accredited partner institution awards the credential; this platform does not award it and '
  + 'does not confer a degree or any other qualification.';

export const NOT_ATTENDANCE_SENTENCE =
  'Nothing in this record is earned by login time or by attendance. It is earned by verified work, '
  + 'the outcomes that work evidenced, and a mentor evaluation recorded by a named person.';

export const HOLISTIC_EMBEDDED_SENTENCE =
  'Holistic well-being and personal development are INSIDE this programme and inside its credits. '
  + 'They are never counted as an additional course or as hours added on top of the weekly ceiling.';

export const CEILING_SENTENCE =
  'The weekly ceiling is a limit on what may be RECOGNISED, not a target. Effort reported above it '
  + 'is recorded in full and recognised up to the ceiling.';

export const NO_CONFIG_SENTENCE =
  'No credit configuration has been recorded for this programme, so no credit figure is computed. '
  + 'A credit conversion is a record with a named owner, never a default.';

export const ADVISORY_SENTENCE =
  'Advisory only. Anything flagged here is a finding for a person to look at, never a conclusion '
  + 'about anybody and never an automatic penalty.';

// -------------------------------------------------------------------------------------------------
// THE CREDIT COMPONENTS
// -------------------------------------------------------------------------------------------------

/**
 * WHAT CREDIT MAY BE CONSIDERED AGAINST. The eight the founder specification names, and the keys are
 * fixed here so a configuration cannot quietly introduce a ninth that nothing measures.
 */
export const CREDIT_COMPONENT_KEYS = [
  'verified-workload',
  'learning-outcomes',
  'project-completion',
  'assessments',
  'mentor-evaluation',
  'professional-holistic',
  'documentation',
  'final-evaluation',
] as const;
export type CreditComponentKey = (typeof CREDIT_COMPONENT_KEYS)[number];

const COMPONENT_SET = new Set<string>(CREDIT_COMPONENT_KEYS);
export const isCreditComponentKey = (v: unknown): v is CreditComponentKey =>
  typeof v === 'string' && COMPONENT_SET.has(v);

/**
 * THE WORDS THAT MAY NOT APPEAR IN A CREDIT COMPONENT.
 *
 * This is the enforcement of "never login time, never attendance". A configuration whose component
 * key, label or note names any of these is REFUSED at the save. It is deliberately a little blunt —
 * a component honestly called "punctuality of submissions" is caught too, and the person configuring
 * it can word it as the deadline adherence it actually is.
 */
const FORBIDDEN_COMPONENT_WORDS =
  /(attendance|attend\b|presence|present\b|log[\s-]?in|login|logged[\s-]?in|clock|punctual|check[\s-]?in|hours logged|time logged|sign[\s-]?in)/i;

export interface CreditComponentConfig {
  key: CreditComponentKey;
  label: string;
  /** Share of the whole. The set must sum to 100. */
  weightPct: number;
  /** Optional floor: below this the component is flagged, and the decision says which. */
  minPct?: number | null;
  note?: string;
}

/**
 * THE SEED, not the rule. Weights sum to 100 and are meant to be argued with by whoever owns the
 * programme; they govern nothing until they have been saved as a configuration with an owner.
 */
export function defaultCreditComponents(): CreditComponentConfig[] {
  return [
    {
      key: 'verified-workload', label: 'Verified workload', weightPct: 25, minPct: 60,
      // WORDED CAREFULLY ON PURPOSE. validateCreditConfig() refuses a component whose text names
      // attendance or clock time, and it is applied to these seeds like any other configuration — so
      // the note says what verification IS rather than contrasting it with the thing that is banned.
      // A seed the validator would reject is a seed nobody can save.
      note: 'Verified activity hours against the programme requirement, capped at the weekly ceiling. '
        + 'Verified means a named person checked the evidence behind the work.',
    },
    {
      key: 'learning-outcomes', label: 'Learning outcomes', weightPct: 15, minPct: 50,
      note: 'The share of the programme outcomes with evidence behind them. An outcome with no '
        + 'evidence is uncovered, and is named rather than scored zero.',
    },
    {
      key: 'project-completion', label: 'Project completion', weightPct: 15, minPct: null,
      note: 'Deliverables accepted by the people who own the project.',
    },
    {
      key: 'assessments', label: 'Assessments', weightPct: 10, minPct: null,
      note: 'Recorded assessment performance, where the programme sets assessments.',
    },
    {
      key: 'mentor-evaluation', label: 'Mentor evaluation', weightPct: 15, minPct: 50,
      note: 'The weighted rubric result recorded by a named mentor.',
    },
    {
      key: 'professional-holistic', label: 'Professional and holistic development', weightPct: 10, minPct: null,
      note: 'Holistic well-being and personal development, INSIDE the programme and inside its credits.',
    },
    {
      key: 'documentation', label: 'Documentation', weightPct: 5, minPct: null,
      note: 'The written record of the work: records filed, evidence references recorded and readable.',
    },
    {
      key: 'final-evaluation', label: 'Final evaluation', weightPct: 5, minPct: null,
      note: 'The closing evaluation recorded at the end of the engagement.',
    },
  ];
}

/* --------------------------------------------------------------------------------- grade bands */

export interface GradeBand {
  code: string;
  label: string;
  /** Inclusive floor, as a percentage of the weighted rubric result. */
  minPercent: number;
}

export const DEFAULT_GRADE_BANDS: GradeBand[] = [
  { code: 'A+', label: 'Outstanding', minPercent: 90 },
  { code: 'A', label: 'Excellent', minPercent: 80 },
  { code: 'B', label: 'Very good', minPercent: 70 },
  { code: 'C', label: 'Good', minPercent: 60 },
  { code: 'D', label: 'Satisfactory', minPercent: 50 },
  { code: 'E', label: 'Not yet at the required standard', minPercent: 0 },
];

/**
 * The band a percentage falls in. NULL when there is no percentage — an unassessed rubric has no
 * grade, and printing the bottom band for it would turn a missing evaluation into a bad one.
 */
export function gradeFor(percent: number | null, bands: GradeBand[] = DEFAULT_GRADE_BANDS): GradeBand | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  for (const b of sorted) if (percent >= b.minPercent) return b;
  return null;
}

// -------------------------------------------------------------------------------------------------
// THE CONFIGURATION, AS CALLERS SEE IT
// -------------------------------------------------------------------------------------------------

export const CREDIT_CONFIG_STATES = ['draft', 'active', 'retired'] as const;
export type CreditConfigState = (typeof CREDIT_CONFIG_STATES)[number];

export interface CreditConfig {
  id: string;
  programmeKey: string;
  programmeName: string;
  /** The accredited partner who AWARDS. Null where none has been named yet, and it is said so. */
  partnerInstitution: string | null;
  /** Credits the whole programme is represented as. Twelve, where a partner recognises twelve. */
  totalCredits: number;
  /** Rounding step for the recommended figure. 0.5 means half credits are representable. */
  creditStep: number;
  /**
   * The weekly ceiling on RECOGNISED hours, recorded here so a frozen record can say what it was
   * computed against. Holistic development sits INSIDE it.
   *
   * IT IS NOT THE AUTHORITY AND IS NOT ENFORCED FROM HERE. src/lib/eims-workload.ts owns the ceiling
   * and applies the tighter of the recorded contract and the programme policy; buildFinalRecord asks
   * it, and falls back to this figure only when that module cannot answer. Enforcing a second copy
   * here is how one screen comes to recognise forty-four hours while another allows forty.
   */
  weeklyCeilingHours: number;
  programmeWeeks: number | null;
  /**
   * The partner institution's own stated hours per credit, RECORDED FOR THEIR REFERENCE. This
   * module does not convert hours into credits with it — that would be a second credit engine
   * beside the components below, and two engines disagree within a month.
   */
  partnerHoursPerCredit: number | null;
  /** Always true. A configuration that made holistic an extra course is not representable. */
  holisticEmbedded: true;
  components: CreditComponentConfig[];
  gradeBands: GradeBand[];
  ownerUserId: string | null;
  ownerName: string;
  state: CreditConfigState;
  version: number;
  effectiveFrom: string | null;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreditComponentResult {
  key: CreditComponentKey;
  label: string;
  weightPct: number;
  /** 0..1, or NULL where nothing measured it. Null is never treated as zero. */
  attainment: number | null;
  /** Weighted contribution in percentage points, or null when unmeasured. */
  contributionPct: number | null;
  meetsMinimum: boolean | null;
  basis: string;
}

export interface CreditDecision {
  /**
   *   computed     every weighted component had a measurement.
   *   incomplete   at least one did not. A figure is still shown for what WAS measured, and the
   *                unmeasured components are named — never silently averaged away.
   *   unconfigured no configuration exists for this programme, so no figure is computed at all.
   */
  state: 'computed' | 'incomplete' | 'unconfigured';
  totalCredits: number | null;
  /** Weighted attainment across measured components, 0..100. Null when nothing was measured. */
  attainmentPct: number | null;
  /** The RECOMMENDED figure. Never an award. Null when no configuration or nothing measured. */
  creditsRecommended: number | null;
  components: CreditComponentResult[];
  /** Components with weight and no measurement, by label. */
  unmeasured: string[];
  /** Components that fell below their configured floor, by label. */
  belowMinimum: string[];
  /** Typed `false`, not `boolean`. Nothing in this codebase can set it true. */
  awarded: false;
  awardedBy: null;
  partnerInstitution: string | null;
  statements: string[];
}

// -------------------------------------------------------------------------------------------------
// VALIDATION AND THE PURE DECISION. No database, so both can be read and tested without one.
// -------------------------------------------------------------------------------------------------

/**
 * Everything wrong with a proposed configuration, in sentences a person can act on. Empty means it
 * is saveable.
 *
 * THE ATTENDANCE CHECK IS THE IMPORTANT ONE. It is what makes "credits are never awarded for login
 * time or attendance" a property of the system rather than a promise in a comment.
 */
export function validateCreditConfig(input: {
  programmeName?: string;
  totalCredits?: number | null;
  creditStep?: number | null;
  weeklyCeilingHours?: number | null;
  programmeWeeks?: number | null;
  holisticEmbedded?: boolean;
  components?: CreditComponentConfig[];
  gradeBands?: GradeBand[];
  ownerUserId?: string | null;
  ownerName?: string | null;
}): string[] {
  const errs: string[] = [];

  if (!String(input.programmeName || '').trim()) {
    errs.push('The programme needs a name.');
  }
  if (!String(input.ownerName || '').trim() || !isUuid(input.ownerUserId)) {
    errs.push('A credit configuration needs a named owner. It is a record somebody is accountable '
      + 'for, not a setting.');
  }

  const total = num(input.totalCredits);
  if (total == null || total <= 0) errs.push('Total credits must be a number above zero.');
  if (total != null && total > 60) errs.push('Total credits above 60 for one internship is almost '
    + 'certainly a typing error. Nothing was saved.');

  const step = num(input.creditStep);
  if (step == null || step <= 0) errs.push('The credit step must be a number above zero.');

  const ceiling = num(input.weeklyCeilingHours);
  if (ceiling == null || ceiling <= 0) errs.push('The weekly ceiling must be a number above zero.');
  // 48 is the statutory weekly ceiling this product is built inside (engagement-policy.ts STATUTORY).
  if (ceiling != null && ceiling > 48) {
    errs.push('The weekly ceiling may not exceed 48 hours, which is the statutory limit this '
      + 'platform is built inside.');
  }

  const weeks = num(input.programmeWeeks);
  if (weeks != null && (weeks <= 0 || weeks > 104)) {
    errs.push('The programme length in weeks must be between 1 and 104, or left blank.');
  }

  if (input.holisticEmbedded === false) {
    errs.push('Holistic development is embedded in the credits of this programme and cannot be '
      + 'configured as a separate course beside them.');
  }

  const comps = input.components || [];
  if (!comps.length) errs.push('A credit configuration needs at least one component.');

  let weightSum = 0;
  const seen = new Set<string>();
  for (const c of comps) {
    const key = String(c?.key || '');
    if (!isCreditComponentKey(key)) {
      errs.push('"' + key + '" is not a credit component this platform measures.');
      continue;
    }
    if (seen.has(key)) errs.push('The component "' + key + '" appears twice.');
    seen.add(key);

    const w = num(c?.weightPct);
    if (w == null || w < 0) errs.push('The weight for "' + key + '" must be zero or more.');
    else weightSum += w;

    const text = key + ' ' + String(c?.label || '') + ' ' + String(c?.note || '');
    if (FORBIDDEN_COMPONENT_WORDS.test(text)) {
      errs.push('A credit component may not be conditioned on attendance, presence, login time or '
        + 'clock time. Rewrite "' + (c?.label || key) + '" in terms of the work that was done.');
    }

    const min = num(c?.minPct);
    if (min != null && (min < 0 || min > 100)) {
      errs.push('The minimum for "' + key + '" must be between 0 and 100.');
    }
  }
  if (comps.length && Math.abs(weightSum - 100) > 0.01) {
    errs.push('Component weights must add up to 100. They currently add up to ' + round2(weightSum) + '.');
  }

  const bands = input.gradeBands || [];
  for (const b of bands) {
    const m = num(b?.minPercent);
    if (!String(b?.code || '').trim()) errs.push('Every grade band needs a code.');
    if (m == null || m < 0 || m > 100) errs.push('Grade band floors must be between 0 and 100.');
  }

  return errs;
}

/** Round a credit figure to the configured step, which is what makes half credits representable. */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return round2(value);
  return round2(Math.round(value / step) * step);
}

/**
 * THE DECISION. Pure: it takes measurements and a configuration and returns a recommendation.
 *
 * A NULL MEASUREMENT IS NOT A ZERO. A component nothing measured is EXCLUDED from the weighted
 * average and NAMED in `unmeasured`, and the decision comes out 'incomplete'. Averaging it in as a
 * zero would quietly reduce somebody's credit because of a gap in OUR records; dropping it silently
 * would overstate a figure printed for a university. Naming it is the only honest option.
 */
export function decideCredit(
  measurements: Partial<Record<CreditComponentKey, { attainment: number | null; basis: string }>>,
  config: CreditConfig | null,
): CreditDecision {
  const base: CreditDecision = {
    state: 'unconfigured',
    totalCredits: null,
    attainmentPct: null,
    creditsRecommended: null,
    components: [],
    unmeasured: [],
    belowMinimum: [],
    awarded: false,
    awardedBy: null,
    partnerInstitution: null,
    statements: [NO_CONFIG_SENTENCE, PLATFORM_ROLE_SENTENCE],
  };
  if (!config) return base;

  const components: CreditComponentResult[] = [];
  const unmeasured: string[] = [];
  const belowMinimum: string[] = [];
  let weightedSum = 0;
  let measuredWeight = 0;

  for (const c of config.components) {
    const m = measurements[c.key];
    const attainment = m && m.attainment != null && Number.isFinite(m.attainment)
      ? clamp01(m.attainment) : null;
    const contribution = attainment == null ? null : round2(attainment * c.weightPct);
    if (attainment == null) {
      if (c.weightPct > 0) unmeasured.push(c.label);
    } else {
      weightedSum += attainment * c.weightPct;
      measuredWeight += c.weightPct;
    }
    const meets = attainment == null || c.minPct == null
      ? null
      : attainment * 100 >= (c.minPct as number);
    if (meets === false) belowMinimum.push(c.label);
    components.push({
      key: c.key,
      label: c.label,
      weightPct: c.weightPct,
      attainment,
      contributionPct: contribution,
      meetsMinimum: meets,
      basis: m?.basis || (attainment == null ? 'Not measured.' : ''),
    });
  }

  const attainmentPct = measuredWeight > 0 ? round2((weightedSum / measuredWeight) * 100) : null;
  const credits = attainmentPct == null
    ? null
    : roundToStep((attainmentPct / 100) * config.totalCredits, config.creditStep);

  const statements: string[] = [
    PLATFORM_ROLE_SENTENCE,
    NOT_ATTENDANCE_SENTENCE,
    HOLISTIC_EMBEDDED_SENTENCE,
  ];
  if (unmeasured.length) {
    statements.push(
      'This figure rests on the components that were measured. Not measured: ' + unmeasured.join(', ')
      + '. It is a partial computation and must be read as one.',
    );
  }
  if (belowMinimum.length) {
    statements.push(
      'Below the configured minimum: ' + belowMinimum.join(', ')
      + '. Advisory: a person decides what follows from that, not this platform.',
    );
  }

  return {
    state: unmeasured.length ? 'incomplete' : 'computed',
    totalCredits: config.totalCredits,
    attainmentPct,
    creditsRecommended: credits,
    components,
    unmeasured,
    belowMinimum,
    awarded: false,
    awardedBy: null,
    partnerInstitution: config.partnerInstitution,
    statements,
  };
}

// -------------------------------------------------------------------------------------------------
// THE RUBRIC
// -------------------------------------------------------------------------------------------------

export interface RubricCriterion {
  id: string;
  programmeKey: string;
  code: string;
  label: string;
  descriptor: string;
  weightPct: number;
  maxScore: number;
  sortOrder: number;
  active: boolean;
}

export interface RubricScoreRow {
  id: string;
  employeeId: string;
  criterionId: string;
  score: number;
  comment: string;
  assessedByUserId: string | null;
  assessedByName: string;
  assessedAt: string | null;
}

export interface RubricLine {
  criterion: RubricCriterion;
  score: RubricScoreRow | null;
  /** 0..1 of this criterion, or null where it has not been scored. Never 0 for "not scored". */
  fraction: number | null;
}

export interface RubricResult {
  lines: RubricLine[];
  scoredCount: number;
  total: number;
  /** Weighted result over SCORED criteria only, 0..100. Null when nothing was scored. */
  percent: number | null;
  grade: GradeBand | null;
  /** Labels of criteria nobody has scored. */
  missing: string[];
  complete: boolean;
  assessors: string[];
}

/**
 * THE SEEDED RUBRIC, taken from the credit components so the two describe the same internship. A
 * seed, like everything else here: it governs nothing until somebody saves it.
 */
export const DEFAULT_RUBRIC_CRITERIA: {
  code: string; label: string; descriptor: string; weightPct: number; sortOrder: number;
}[] = [
  {
    code: 'R1', label: 'Quality of work', weightPct: 25, sortOrder: 10,
    descriptor: 'The work is correct, fit for the purpose it was asked for, and holds up when somebody else uses it.',
  },
  {
    code: 'R2', label: 'Independence and problem solving', weightPct: 15, sortOrder: 20,
    descriptor: 'Unfamiliar problems are broken down and carried through, with help asked for early rather than late.',
  },
  {
    code: 'R3', label: 'Learning outcomes demonstrated', weightPct: 15, sortOrder: 30,
    descriptor: 'The programme outcomes are visibly demonstrated in the work and its evidence.',
  },
  {
    code: 'R4', label: 'Communication and documentation', weightPct: 15, sortOrder: 40,
    descriptor: 'Work is recorded and explained so that somebody who was not there can follow it.',
  },
  {
    code: 'R5', label: 'Professional conduct and collaboration', weightPct: 15, sortOrder: 50,
    descriptor: 'Commitments are kept or renegotiated honestly; colleagues are left better informed.',
  },
  {
    code: 'R6', label: 'Holistic and personal development', weightPct: 15, sortOrder: 60,
    descriptor: 'Sustained well-being and personal development across the engagement, INSIDE the weekly commitment.',
  },
];

/**
 * The rubric result. Pure.
 *
 * WEIGHTED OVER SCORED CRITERIA ONLY. An unscored criterion is named in `missing` and the result is
 * marked incomplete; it is not counted as zero. A grade is a thing a person is shown next to their
 * name, and half a rubric scored as a whole one is the way to make it wrong.
 */
export function summariseRubric(
  criteria: RubricCriterion[],
  scores: RubricScoreRow[],
  bands: GradeBand[] = DEFAULT_GRADE_BANDS,
): RubricResult {
  const byCriterion = new Map<string, RubricScoreRow>();
  for (const s of scores) byCriterion.set(s.criterionId, s);

  const lines: RubricLine[] = [];
  const missing: string[] = [];
  const assessors = new Set<string>();
  let weighted = 0;
  let scoredWeight = 0;

  for (const c of criteria) {
    const s = byCriterion.get(c.id) || null;
    let fraction: number | null = null;
    if (s && c.maxScore > 0) {
      fraction = clamp01(s.score / c.maxScore);
      weighted += fraction * c.weightPct;
      scoredWeight += c.weightPct;
      if (s.assessedByName) assessors.add(s.assessedByName);
    } else {
      missing.push(c.label);
    }
    lines.push({ criterion: c, score: s, fraction });
  }

  const percent = scoredWeight > 0 ? round2((weighted / scoredWeight) * 100) : null;
  return {
    lines,
    scoredCount: criteria.length - missing.length,
    total: criteria.length,
    percent,
    grade: gradeFor(percent, bands),
    missing,
    complete: criteria.length > 0 && missing.length === 0,
    assessors: Array.from(assessors),
  };
}

// -------------------------------------------------------------------------------------------------
// SCHEMA
// -------------------------------------------------------------------------------------------------

export function ensureCreditSchema(): Promise<void> {
  return ensureOnce('eims_credit_v1', async () => {
    try {
      await createCreditTables();
    } catch (e: any) {
      logFail('ensureCreditSchema', e);
      throw e;
    }
  });
}

async function createCreditTables(): Promise<void> {
  // THE CONVERSION, AS A RECORD WITH AN OWNER. owner_user_id and owner_name are NOT NULL because a
  // conversion nobody is accountable for is the thing this table exists to abolish.
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_credit_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_key TEXT NOT NULL DEFAULT 'default',
    programme_name TEXT NOT NULL,
    partner_institution TEXT,
    total_credits NUMERIC(6,2) NOT NULL DEFAULT 12,
    credit_step NUMERIC(4,2) NOT NULL DEFAULT 0.5,
    weekly_ceiling_hours NUMERIC(5,2) NOT NULL DEFAULT 40,
    programme_weeks INT,
    partner_hours_per_credit NUMERIC(6,2),
    holistic_embedded BOOLEAN NOT NULL DEFAULT true,
    components JSONB NOT NULL DEFAULT '[]'::jsonb,
    grade_bands JSONB NOT NULL DEFAULT '[]'::jsonb,
    owner_user_id UUID,
    owner_name TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'draft',
    version INT NOT NULL DEFAULT 1,
    supersedes_id UUID,
    effective_from DATE,
    notes TEXT NOT NULL DEFAULT '',
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_credit_configs_version
    ON eims_credit_configs (programme_key, version)`);
  // ONE ACTIVE CONFIGURATION PER PROGRAMME, enforced rather than assumed. Its own try/catch: a
  // partial unique index is the one piece of DDL here that can fail on DATA rather than on syntax,
  // and losing it must not take the table with it.
  try {
    await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_credit_configs_one_active
      ON eims_credit_configs (programme_key) WHERE state = 'active'`);
  } catch (e: any) {
    logFail('eims_credit_configs_one_active', e);
  }

  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_rubric_criteria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_key TEXT NOT NULL DEFAULT 'default',
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    descriptor TEXT NOT NULL DEFAULT '',
    weight_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    max_score NUMERIC(5,2) NOT NULL DEFAULT 5,
    sort_order INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_rubric_criteria_key
    ON eims_rubric_criteria (programme_key, code)`);

  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_rubric_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    criterion_id UUID NOT NULL,
    score NUMERIC(5,2) NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    assessed_by_user_id UUID,
    assessed_by_name TEXT NOT NULL DEFAULT '',
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_rubric_scores_key
    ON eims_rubric_scores (employee_id, criterion_id)`);

  // THE FINAL RECORD. One row per person, frozen when issued, carrying the whole document as JSONB
  // WITH the decision — the same discipline hr_credit_weeks uses for its evidence.
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_final_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    programme_key TEXT NOT NULL DEFAULT 'default',
    config_id UUID,
    state TEXT NOT NULL DEFAULT 'draft',
    document JSONB NOT NULL DEFAULT '{}'::jsonb,
    grade_code TEXT,
    grade_percent NUMERIC(5,2),
    credits_recommended NUMERIC(6,2),
    hours_required NUMERIC(8,2),
    hours_allocated NUMERIC(8,2),
    hours_completed NUMERIC(8,2),
    hours_verified NUMERIC(8,2),
    certificate_serial TEXT,
    verification_id TEXT,
    issued_by_user_id UUID,
    issued_by_name TEXT,
    issued_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    withdrawn_by_user_id UUID,
    withdrawal_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await (await database()).execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_final_records_emp
    ON eims_final_records (employee_id)`);
  await (await database()).execute(sql`CREATE INDEX IF NOT EXISTS eims_final_records_serial
    ON eims_final_records (certificate_serial)`);
}

// -------------------------------------------------------------------------------------------------
// CONFIGURATION READ AND WRITE
// -------------------------------------------------------------------------------------------------

const parseJson = <T,>(raw: any, fallback: T): T => {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string' && raw.trim()) {
    // Some drivers hand JSONB back as text. A configuration that cannot be parsed must not silently
    // become the default one; it becomes empty, which fails validation loudly.
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return fallback;
};

function mapConfig(r: any): CreditConfig {
  const state = String(r.state || 'draft');
  return {
    id: String(r.id),
    programmeKey: String(r.programme_key || DEFAULT_PROGRAMME_KEY),
    programmeName: String(r.programme_name || ''),
    partnerInstitution: r.partner_institution ? String(r.partner_institution) : null,
    totalCredits: Number(r.total_credits ?? 0),
    creditStep: Number(r.credit_step ?? 0.5),
    weeklyCeilingHours: Number(r.weekly_ceiling_hours ?? 40),
    programmeWeeks: r.programme_weeks == null ? null : Number(r.programme_weeks),
    partnerHoursPerCredit: r.partner_hours_per_credit == null ? null : Number(r.partner_hours_per_credit),
    holisticEmbedded: true,
    components: parseJson<CreditComponentConfig[]>(r.components, []),
    gradeBands: parseJson<GradeBand[]>(r.grade_bands, DEFAULT_GRADE_BANDS),
    ownerUserId: r.owner_user_id ? String(r.owner_user_id) : null,
    ownerName: String(r.owner_name || ''),
    state: (CREDIT_CONFIG_STATES as readonly string[]).includes(state)
      ? (state as CreditConfigState) : 'draft',
    version: Number(r.version ?? 1),
    effectiveFrom: iso(r.effective_from) || null,
    notes: String(r.notes || ''),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** The configuration in force for a programme, or null. NULL IS AN ANSWER, never a reason to default. */
export async function activeCreditConfig(programmeKey: string = DEFAULT_PROGRAMME_KEY): Promise<CreditConfig | null> {
  const key = programmeKeyOf(programmeKey);
  try {
    await ensureCreditSchema();
    const r = rows(await (await database()).execute(sql`
      SELECT * FROM eims_credit_configs WHERE programme_key = ${key} AND state = 'active'
       ORDER BY version DESC LIMIT 1`));
    return r.length ? mapConfig(r[0]) : null;
  } catch (e: any) {
    logFail('activeCreditConfig', e);
    return null;
  }
}

export async function listCreditConfigs(programmeKey?: string): Promise<CreditConfig[]> {
  try {
    await ensureCreditSchema();
    const r = programmeKey
      ? await (await database()).execute(sql`
          SELECT * FROM eims_credit_configs WHERE programme_key = ${programmeKeyOf(programmeKey)}
           ORDER BY version DESC LIMIT ${MAX_ROWS}`)
      : await (await database()).execute(sql`
          SELECT * FROM eims_credit_configs
           ORDER BY programme_key ASC, version DESC LIMIT ${MAX_ROWS}`);
    return rows(r).map(mapConfig);
  } catch (e: any) {
    logFail('listCreditConfigs', e);
    return [];
  }
}

export interface CreditConfigInput {
  programmeKey?: string;
  programmeName: string;
  partnerInstitution?: string | null;
  totalCredits?: number;
  creditStep?: number;
  weeklyCeilingHours?: number;
  programmeWeeks?: number | null;
  partnerHoursPerCredit?: number | null;
  components?: CreditComponentConfig[];
  gradeBands?: GradeBand[];
  ownerUserId: string;
  ownerName: string;
  effectiveFrom?: string | null;
  notes?: string;
  /** Save it as the configuration in force straight away. */
  activate?: boolean;
}

/**
 * Save a NEW VERSION of a programme's credit configuration.
 *
 * A CONFIGURATION IS NEVER EDITED IN PLACE. Every save writes a new version, because a final record
 * issued last month must still be able to say what rule it was computed under. Mutating the row a
 * frozen document points at is how a certificate stops matching its own arithmetic.
 *
 * Activating a version RETIRES the one it replaces, in the same statement order, so the partial
 * unique index on (programme_key) WHERE state = 'active' cannot be violated by a double activation.
 */
export async function saveCreditConfig(
  actor: Actor | null,
  input: CreditConfigInput,
): Promise<{ ok: boolean; id?: string; version?: number; errors?: string[] }> {
  if (!can(actor as any, 'eims.credit.configure')) {
    return { ok: false, errors: ['You do not hold the desk that owns credit configuration.'] };
  }

  const key = programmeKeyOf(input?.programmeKey);
  const components = input?.components?.length ? input.components : defaultCreditComponents();
  const bands = input?.gradeBands?.length ? input.gradeBands : DEFAULT_GRADE_BANDS;
  const totalCredits = num(input?.totalCredits) ?? 12;
  const creditStep = num(input?.creditStep) ?? 0.5;
  const ceiling = num(input?.weeklyCeilingHours) ?? 40;
  const weeks = num(input?.programmeWeeks);
  const hoursPerCredit = num(input?.partnerHoursPerCredit);

  const errs = validateCreditConfig({
    programmeName: input?.programmeName,
    totalCredits,
    creditStep,
    weeklyCeilingHours: ceiling,
    programmeWeeks: weeks,
    holisticEmbedded: true,
    components,
    gradeBands: bands,
    ownerUserId: input?.ownerUserId,
    ownerName: input?.ownerName,
  });
  if (errs.length) return { ok: false, errors: errs };

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;

  try {
    await ensureCreditSchema();
    const prev = rows(await (await database()).execute(sql`
      SELECT id, version FROM eims_credit_configs WHERE programme_key = ${key}
       ORDER BY version DESC LIMIT 1`))[0];
    const version = prev ? Number(prev.version ?? 0) + 1 : 1;
    const state = input?.activate ? 'active' : 'draft';

    if (input?.activate) {
      // Retire whatever is in force FIRST: the partial unique index would otherwise refuse the
      // insert, and a refused insert here reads to the caller as "nothing saved" while the old rule
      // silently stays in force.
      await (await database()).execute(sql`
        UPDATE eims_credit_configs SET state = 'retired', updated_at = NOW()
         WHERE programme_key = ${key} AND state = 'active'`);
    }

    const w = rows(await (await database()).execute(sql`
      INSERT INTO eims_credit_configs
        (programme_key, programme_name, partner_institution, total_credits, credit_step,
         weekly_ceiling_hours, programme_weeks, partner_hours_per_credit, holistic_embedded,
         components, grade_bands, owner_user_id, owner_name, state, version, supersedes_id,
         effective_from, notes, created_by_user_id)
      VALUES (${key}, ${String(input.programmeName).slice(0, 200)},
              ${input?.partnerInstitution ? String(input.partnerInstitution).slice(0, 200) : null},
              ${totalCredits}, ${creditStep}, ${ceiling}, ${weeks}, ${hoursPerCredit}, true,
              ${JSON.stringify(components)}::jsonb, ${JSON.stringify(bands)}::jsonb,
              ${String(input.ownerUserId)}::uuid, ${String(input.ownerName).slice(0, 200)},
              ${state}, ${version}, ${prev ? String(prev.id) : null},
              ${input?.effectiveFrom || null}, ${String(input?.notes || '').slice(0, 2000)},
              ${actorId})
      RETURNING id, version`));
    if (!w.length) return { ok: false, errors: [WRITE_FAILED] };

    await logAudit({
      userId: actorId,
      action: input?.activate ? 'eims.credit.config.activate' : 'eims.credit.config.save',
      entity: 'eims_credit_configs',
      entityId: String(w[0].id),
      diff: { programmeKey: key, version, totalCredits, ownerName: input.ownerName },
    });
    return { ok: true, id: String(w[0].id), version: Number(w[0].version) };
  } catch (e: any) {
    logFail('saveCreditConfig', e);
    return { ok: false, errors: [WRITE_FAILED] };
  }
}

/** Put an existing draft version in force, retiring the one it replaces. */
export async function activateCreditConfig(
  actor: Actor | null,
  configId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!can(actor as any, 'eims.credit.configure')) {
    return { ok: false, error: 'You do not hold the desk that owns credit configuration.' };
  }
  if (!isUuid(configId)) return { ok: false, error: 'That configuration does not exist.' };
  try {
    await ensureCreditSchema();
    const target = rows(await (await database()).execute(sql`
      SELECT id, programme_key, state FROM eims_credit_configs WHERE id = ${configId}::uuid LIMIT 1`))[0];
    if (!target) return { ok: false, error: 'That configuration does not exist.' };
    if (String(target.state) === 'active') return { ok: true };

    await (await database()).execute(sql`
      UPDATE eims_credit_configs SET state = 'retired', updated_at = NOW()
       WHERE programme_key = ${String(target.programme_key)} AND state = 'active'`);
    const w = rows(await (await database()).execute(sql`
      UPDATE eims_credit_configs SET state = 'active', updated_at = NOW()
       WHERE id = ${configId}::uuid AND state <> 'active'
      RETURNING id`));
    if (!w.length) return { ok: false, error: 'That configuration was not activated. Nothing changed.' };

    await logAudit({
      userId: isUuid(actor?.id) ? String(actor!.id) : null,
      action: 'eims.credit.config.activate',
      entity: 'eims_credit_configs',
      entityId: configId,
      diff: { programmeKey: String(target.programme_key) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('activateCreditConfig', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// RUBRIC READ AND WRITE
// -------------------------------------------------------------------------------------------------

function mapCriterion(r: any): RubricCriterion {
  return {
    id: String(r.id),
    programmeKey: String(r.programme_key || DEFAULT_PROGRAMME_KEY),
    code: String(r.code || ''),
    label: String(r.label || ''),
    descriptor: String(r.descriptor || ''),
    weightPct: Number(r.weight_pct ?? 0),
    maxScore: Number(r.max_score ?? 5),
    sortOrder: Number(r.sort_order ?? 0),
    active: r.active !== false,
  };
}

function mapScore(r: any): RubricScoreRow {
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    criterionId: String(r.criterion_id),
    score: Number(r.score ?? 0),
    comment: String(r.comment || ''),
    assessedByUserId: r.assessed_by_user_id ? String(r.assessed_by_user_id) : null,
    assessedByName: String(r.assessed_by_name || ''),
    assessedAt: r.assessed_at ? new Date(r.assessed_at).toISOString() : null,
  };
}

export async function listRubricCriteria(programmeKey: string = DEFAULT_PROGRAMME_KEY): Promise<RubricCriterion[]> {
  const key = programmeKeyOf(programmeKey);
  try {
    await ensureCreditSchema();
    return rows(await (await database()).execute(sql`
      SELECT * FROM eims_rubric_criteria WHERE programme_key = ${key} AND active = true
       ORDER BY sort_order ASC, code ASC LIMIT ${MAX_ROWS}`)).map(mapCriterion);
  } catch (e: any) {
    logFail('listRubricCriteria', e);
    return [];
  }
}

export async function saveRubricCriterion(
  actor: Actor | null,
  input: {
    id?: string | null; programmeKey?: string; code: string; label: string;
    descriptor?: string; weightPct: number; maxScore?: number; sortOrder?: number; active?: boolean;
  },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!can(actor as any, 'eims.credit.configure')) {
    return { ok: false, error: 'You do not hold the desk that owns the grading rubric.' };
  }
  const code = String(input?.code || '').trim().toUpperCase().slice(0, 20);
  const label = String(input?.label || '').trim().slice(0, 200);
  if (!code || !label) return { ok: false, error: 'A criterion needs a code and a label.' };

  const weight = num(input?.weightPct);
  if (weight == null || weight < 0) return { ok: false, error: 'A criterion weight must be zero or more.' };
  const maxScore = num(input?.maxScore) ?? 5;
  if (maxScore <= 0) return { ok: false, error: 'The maximum score must be above zero.' };
  if (FORBIDDEN_COMPONENT_WORDS.test(code + ' ' + label + ' ' + String(input?.descriptor || ''))) {
    return {
      ok: false,
      error: 'A rubric criterion may not be conditioned on attendance, presence, login time or clock '
        + 'time. Word it in terms of the work that was done.',
    };
  }

  const key = programmeKeyOf(input?.programmeKey);
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;

  try {
    await ensureCreditSchema();
    const w = rows(await (await database()).execute(sql`
      INSERT INTO eims_rubric_criteria
        (programme_key, code, label, descriptor, weight_pct, max_score, sort_order, active,
         created_by_user_id)
      VALUES (${key}, ${code}, ${label}, ${String(input?.descriptor || '').slice(0, 1000)},
              ${weight}, ${maxScore}, ${num(input?.sortOrder) ?? 0}, ${input?.active !== false},
              ${actorId})
      ON CONFLICT (programme_key, code) DO UPDATE
        SET label = EXCLUDED.label, descriptor = EXCLUDED.descriptor,
            weight_pct = EXCLUDED.weight_pct, max_score = EXCLUDED.max_score,
            sort_order = EXCLUDED.sort_order, active = EXCLUDED.active, updated_at = NOW()
      RETURNING id`));
    if (!w.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actorId,
      action: 'eims.rubric.save',
      entity: 'eims_rubric_criteria',
      entityId: String(w[0].id),
      diff: { programmeKey: key, code, weightPct: weight },
    });
    return { ok: true, id: String(w[0].id) };
  } catch (e: any) {
    logFail('saveRubricCriterion', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function seedRubric(
  actor: Actor | null,
  programmeKey: string = DEFAULT_PROGRAMME_KEY,
): Promise<{ ok: boolean; created: number; error?: string }> {
  if (!can(actor as any, 'eims.credit.configure')) {
    return { ok: false, created: 0, error: 'You do not hold the desk that owns the grading rubric.' };
  }
  const key = programmeKeyOf(programmeKey);
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  let created = 0;
  try {
    await ensureCreditSchema();
    for (const c of DEFAULT_RUBRIC_CRITERIA) {
      const w = rows(await (await database()).execute(sql`
        INSERT INTO eims_rubric_criteria
          (programme_key, code, label, descriptor, weight_pct, max_score, sort_order, created_by_user_id)
        VALUES (${key}, ${c.code}, ${c.label}, ${c.descriptor}, ${c.weightPct}, 5, ${c.sortOrder}, ${actorId})
        ON CONFLICT (programme_key, code) DO NOTHING
        RETURNING id`));
      if (w.length) created += 1;
    }
    await logAudit({
      userId: actorId, action: 'eims.rubric.seed', entity: 'eims_rubric_criteria',
      entityId: key, diff: { created },
    });
    return { ok: true, created };
  } catch (e: any) {
    logFail('seedRubric', e);
    return { ok: false, created, error: WRITE_FAILED };
  }
}

/**
 * Record one mentor score against one criterion.
 *
 * WHO MAY IS RESOLVED PER ROW FROM THE ORGANIZATION GRAPH, through mayAssessOutcome() in
 * src/lib/eims-outcomes.ts — the mentor edge, the reporting-manager edge, the chain above them, or
 * the HR desk's standing authority. There is deliberately no second answer to that question in this
 * file: two modules resolving one relationship is how they start disagreeing about it.
 *
 * A COMMENT IS REQUIRED. A number with nothing behind it is what hr_reviews already offers.
 */
export async function recordRubricScore(
  actor: Actor | null,
  input: { employeeId: string; criterionId: string; score: number; comment: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const employeeId = String(input?.employeeId || '');
  const criterionId = String(input?.criterionId || '');
  if (!isUuid(employeeId) || !isUuid(criterionId)) {
    return { ok: false, error: 'That score does not name a person and a criterion.' };
  }
  const comment = String(input?.comment || '').trim().slice(0, 2000);
  if (!comment) return { ok: false, error: 'A score needs a written comment. Nothing was saved.' };

  const allowed = await mayAssessOutcome(actor, employeeId);
  if (!allowed.may) return { ok: false, error: allowed.reason };

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  const actorName = String(actor?.name || actor?.email || '').slice(0, 200);

  try {
    await ensureCreditSchema();
    const crit = rows(await (await database()).execute(sql`
      SELECT max_score FROM eims_rubric_criteria WHERE id = ${criterionId}::uuid LIMIT 1`))[0];
    if (!crit) return { ok: false, error: 'That criterion no longer exists. Nothing was saved.' };

    const maxScore = Number(crit.max_score ?? 5);
    const score = num(input?.score);
    if (score == null || score < 0 || score > maxScore) {
      return { ok: false, error: 'The score must be between 0 and ' + maxScore + '. Nothing was saved.' };
    }

    const w = rows(await (await database()).execute(sql`
      INSERT INTO eims_rubric_scores
        (employee_id, criterion_id, score, comment, assessed_by_user_id, assessed_by_name)
      VALUES (${employeeId}::uuid, ${criterionId}::uuid, ${score}, ${comment}, ${actorId}, ${actorName})
      ON CONFLICT (employee_id, criterion_id) DO UPDATE
        SET score = EXCLUDED.score, comment = EXCLUDED.comment,
            assessed_by_user_id = EXCLUDED.assessed_by_user_id,
            assessed_by_name = EXCLUDED.assessed_by_name,
            assessed_at = NOW(), updated_at = NOW()
      RETURNING id`));
    if (!w.length) return { ok: false, error: WRITE_FAILED };

    await logAudit({
      userId: actorId, action: 'eims.rubric.score', entity: 'eims_rubric_scores',
      entityId: String(w[0].id), diff: { employeeId, criterionId, score, via: allowed.via },
    });
    return { ok: true, id: String(w[0].id) };
  } catch (e: any) {
    logFail('recordRubricScore', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function rubricResultFor(
  employeeId: string,
  programmeKey: string = DEFAULT_PROGRAMME_KEY,
  bands: GradeBand[] = DEFAULT_GRADE_BANDS,
): Promise<RubricResult> {
  const criteria = await listRubricCriteria(programmeKey);
  if (!isUuid(employeeId) || !criteria.length) {
    return summariseRubric(criteria, [], bands);
  }
  let scores: RubricScoreRow[] = [];
  try {
    await ensureCreditSchema();
    scores = rows(await (await database()).execute(sql`
      SELECT * FROM eims_rubric_scores WHERE employee_id = ${employeeId}::uuid
       LIMIT ${MAX_ROWS}`)).map(mapScore);
  } catch (e: any) {
    logFail('rubricResultFor', e);
  }
  return summariseRubric(criteria, scores, bands);
}

// -------------------------------------------------------------------------------------------------
// THE FINAL INTERNSHIP RECORD
// -------------------------------------------------------------------------------------------------

export const FINAL_RECORD_STATES = ['draft', 'issuing', 'issued', 'withdrawn'] as const;
export type FinalRecordState = (typeof FINAL_RECORD_STATES)[number];

export interface FinalRecordHours {
  requiredHours: number | null;
  allocatedHours: number | null;
  completedHours: number | null;
  verifiedHours: number | null;
  weeklyCeilingHours: number | null;
  /** True where reported effort exceeded what may be recognised. RECORDED, never penalised. */
  reportedAboveCeiling: boolean;
  note: string;
}

export interface FinalRecordDocument {
  version: 1;
  generatedAt: string;
  platformStatement: string;
  statements: string[];
  identity: {
    employeeId: string;
    name: string;
    designation: string;
    department: string;
    employmentType: string;
    programmeKey: string;
    programmeName: string;
    partnerInstitution: string | null;
  };
  duration: { start: string; end: string; weeks: number | null };
  hours: FinalRecordHours;
  outcomes: {
    total: number; covered: number; uncovered: number; verified: number;
    coverageFraction: number | null;
    rows: {
      code: string; statement: string; state: string; covered: boolean;
      verifiedHours: number | null; evidenceCount: number;
      mentorAttainment: string | null;
    }[];
  };
  projects: { name: string; role: string; status: string }[];
  assignments: { total: number; completed: number };
  training: { title: string; status: string }[];
  assessments: { label: string; attempts: number; bestPercent: number | null }[];
  holistic: {
    embedded: true; domains: string[]; activityCount: number; recorded: boolean; note: string;
  };
  mentorEvaluation: {
    percent: number | null; complete: boolean; missing: string[]; assessors: string[];
    lines: { code: string; label: string; weightPct: number; score: number | null; maxScore: number }[];
  };
  grade: { code: string; label: string; percent: number | null } | null;
  credit: CreditDecision;
  configSnapshot: CreditConfig | null;
  certificate: { serial: string; verificationId: string; verificationUrl: string } | null;
  gaps: string[];
  advisories: string[];
  sources: SourceNote[];
}

export interface FinalRecordRow {
  id: string;
  employeeId: string;
  programmeKey: string;
  state: FinalRecordState;
  document: FinalRecordDocument | null;
  gradeCode: string | null;
  gradePercent: number | null;
  creditsRecommended: number | null;
  certificateSerial: string | null;
  verificationId: string | null;
  issuedByName: string | null;
  issuedAt: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

function mapFinalRecord(r: any): FinalRecordRow {
  const state = String(r.state || 'draft');
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    programmeKey: String(r.programme_key || DEFAULT_PROGRAMME_KEY),
    state: (FINAL_RECORD_STATES as readonly string[]).includes(state)
      ? (state as FinalRecordState) : 'draft',
    document: parseJson<FinalRecordDocument | null>(r.document, null),
    gradeCode: r.grade_code ? String(r.grade_code) : null,
    gradePercent: r.grade_percent == null ? null : Number(r.grade_percent),
    creditsRecommended: r.credits_recommended == null ? null : Number(r.credits_recommended),
    certificateSerial: r.certificate_serial ? String(r.certificate_serial) : null,
    verificationId: r.verification_id ? String(r.verification_id) : null,
    issuedByName: r.issued_by_name ? String(r.issued_by_name) : null,
    issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
    withdrawnAt: r.withdrawn_at ? new Date(r.withdrawn_at).toISOString() : null,
    withdrawalReason: r.withdrawal_reason ? String(r.withdrawal_reason) : null,
  };
}

const WEEK_MS = 7 * 86400000;

function weeksBetween(startIso: string, endIso: string): number | null {
  if (!startIso || !endIso) return null;
  const a = new Date(startIso + 'T00:00:00.000Z').getTime();
  const b = new Date(endIso + 'T00:00:00.000Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.max(1, Math.round((b - a) / WEEK_MS));
}

/**
 * ASSEMBLE THE RECORD FROM LIVE DATA. Nothing is written here — this is what a screen shows before
 * anybody issues anything, and what `issueFinalRecord()` freezes when they do.
 *
 * EVERY SOURCE HAS ITS OWN try/catch AND ITS OWN ENTRY IN `gaps`. A single failed read must never
 * render as "this person did no projects"; it renders as a named gap, and a gap is a reason not to
 * issue until somebody has looked.
 *
 * NOT ONE QUERY IN HERE TOUCHES hr_attendance. The record answers what the intern DID.
 */
export async function buildFinalRecord(
  employeeId: string,
  opts: { programmeKey?: string } = {},
): Promise<{ ok: boolean; document?: FinalRecordDocument; error?: string }> {
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };

  const gaps: string[] = [];
  const advisories: string[] = [];
  const sources: SourceNote[] = [];

  let emp: any = null;
  try {
    await ensureCreditSchema();
    emp = rows(await (await database()).execute(sql`
      SELECT e.id::text AS id, e.full_name, e.designation, e.employment_type, e.weekly_hours,
             e.joining_date, e.exit_date, e.last_working_day, d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
  } catch (e: any) {
    // weekly_hours is added at runtime by credit-ledger and may be absent on a database where no
    // engagement terms were ever saved. An unrecorded contract must degrade to "unknown", never to
    // a failed read.
    logFail('buildFinalRecord employee', e);
    try {
      emp = rows(await (await database()).execute(sql`
        SELECT e.id::text AS id, e.full_name, e.designation, e.employment_type,
               NULL AS weekly_hours, e.joining_date, e.exit_date, e.last_working_day,
               d.name AS department_name
          FROM hr_employees e
          LEFT JOIN departments d ON d.id::text = e.department_id::text
         WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
    } catch (e2: any) {
      logFail('buildFinalRecord employee retry', e2);
      return { ok: false, error: 'That employee record could not be read. Nothing was assembled.' };
    }
  }
  if (!emp) return { ok: false, error: 'That employee record does not exist.' };

  const key = programmeKeyOf(opts.programmeKey);
  const config = await activeCreditConfig(key);
  if (!config) gaps.push('No credit configuration is in force for this programme.');

  // ---- coverage, evidence and the verified hours behind them ------------------------------------
  const coverage: CoverageReport = await outcomeCoverageFor(employeeId, { programmeKey: key });
  for (const u of coverage.unread) gaps.push('Could not read: ' + u + '.');
  for (const a of coverage.advisories) advisories.push(a);
  for (const s of coverage.sources) sources.push(s);

  // THE HOURS COVER THE WHOLE ENGAGEMENT, NOT ONLY THE MAPPED PART. Summing the per-outcome rows
  // would drop every hour of work nobody got round to mapping to an outcome, and an intern would
  // lose hours on a completion document because of an administrative gap at our end. It would also
  // double-count: one activity mapped to three outcomes appears in three rows.
  //
  // ONE ACTIVITY, ONE CONTRIBUTION, and the only source of an hour is the activity ledger — see the
  // note on eims_evidence_links.hours_verified in src/lib/eims-outcomes.ts.
  let allocated: number | null = null;
  let completed: number | null = null;
  let verified: number | null = null;
  const countedActivity = new Set<string>();
  for (const a of coverage.activities) {
    const key2 = a.source + ':' + a.id;
    if (countedActivity.has(key2)) continue;
    countedActivity.add(key2);
    if (a.allocatedHours != null) allocated = round2((allocated ?? 0) + a.allocatedHours);
    if (a.completedHours != null) completed = round2((completed ?? 0) + a.completedHours);
    if (a.verifiedHours != null) verified = round2((verified ?? 0) + a.verifiedHours);
  }

  // ---- duration and the requirement --------------------------------------------------------------
  const start = iso(emp.joining_date);
  const end = iso(emp.last_working_day) || iso(emp.exit_date) || new Date().toISOString().slice(0, 10);
  const weeks = config?.programmeWeeks ?? weeksBetween(start, end);

  const req = requiredWeeklyHours({
    employmentType: emp.employment_type,
    designation: emp.designation,
    recordedWeeklyHours: num(emp.weekly_hours),
  });

  // THE CEILING IS ASKED FOR, NOT RE-DERIVED. src/lib/eims-workload.ts owns it: it already takes the
  // tighter of the recorded contract and the programme policy, refuses to let a keying error on one
  // employee record raise the limit, and returns the sentence saying which bound applied. Computing
  // a second ceiling here from the credit configuration would be the two-numbers defect again, one
  // screen enforcing forty while another recognised forty-four.
  //
  // The configuration'''s own figure is the FALLBACK, used only where the workload module cannot
  // answer, and the record says which of the two it used.
  let ceiling: number | null = null;
  let ceilingBasis = '';
  try {
    const resolved = await resolveWeeklyCeiling(employeeId, { programmeKey: key });
    if (resolved) {
      ceiling = resolved.hours;
      ceilingBasis = resolved.basis;
      sources.push({ source: 'weekly ceiling', present: true, note: resolved.basis });
    }
  } catch (e: any) {
    logFail('buildFinalRecord ceiling', e);
  }
  if (ceiling == null) {
    ceiling = config?.weeklyCeilingHours ?? null;
    ceilingBasis = ceiling == null
      ? 'No weekly ceiling could be resolved and none is recorded on the credit configuration.'
      : 'Taken from the credit configuration for this programme, because the workload policy could '
        + 'not be read.';
    sources.push({ source: 'weekly ceiling', present: ceiling != null, note: ceilingBasis });
    if (ceiling == null) gaps.push('No weekly ceiling could be resolved for this engagement.');
  }

  // The weekly figure recognised is the CONTRACT capped by the CEILING - never the larger of the two.
  const weeklyRecognised = req.hours == null
    ? ceiling
    : (ceiling == null ? req.hours : Math.min(req.hours, ceiling));
  const requiredHours = weeklyRecognised != null && weeks != null
    ? round2(weeklyRecognised * weeks) : null;
  if (requiredHours == null) {
    gaps.push('The programme requirement in hours is unknown: ' + req.basis);
  }

  const hours: FinalRecordHours = {
    requiredHours,
    allocatedHours: allocated,
    completedHours: completed,
    verifiedHours: verified,
    weeklyCeilingHours: ceiling,
    reportedAboveCeiling: completed != null && requiredHours != null && completed > requiredHours,
    note: (verified == null
      ? 'No verified hour figure is recorded. That is an absent measurement, not zero hours: hours '
        + 'are recognised only where an activity ledger recorded them as verified by a person. '
      : CEILING_SENTENCE + ' ') + ceilingBasis,
  };
  if (hours.reportedAboveCeiling) {
    advisories.push(
      'Reported effort is above what the programme recognises. It is recorded in full and recognised '
      + 'up to the ceiling. Advisory: a mentor may wish to look at the workload, not at the person.',
    );
  }

  // ---- projects -----------------------------------------------------------------------------------
  const projects: { name: string; role: string; status: string }[] = [];
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT p.name, p.status, m.role
        FROM project_members m
        JOIN projects p ON p.id = m.project_id
       WHERE m.employee_id = ${employeeId}::uuid
       LIMIT 50`));
    for (const p of r) {
      projects.push({
        name: String(p.name || ''),
        role: String(p.role || ''),
        status: String(p.status || ''),
      });
    }
    sources.push({ source: 'projects', present: true, note: 'Project membership and status.' });
  } catch (e: any) {
    logFail('buildFinalRecord projects', e);
    gaps.push('Could not read: project membership.');
  }

  // ---- assignments ---------------------------------------------------------------------------------
  let assignments = { total: 0, completed: 0 };
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done
        FROM employee_tasks WHERE employee_id = ${employeeId}::uuid`))[0];
    assignments = { total: Number(r?.total ?? 0), completed: Number(r?.done ?? 0) };
    sources.push({
      source: 'assignments', present: true,
      note: 'employee_tasks carries no hours column; these are counts of work asked for and done.',
    });
  } catch (e: any) {
    logFail('buildFinalRecord assignments', e);
    gaps.push('Could not read: assigned tasks.');
  }

  // ---- training -------------------------------------------------------------------------------------
  const training: { title: string; status: string }[] = [];
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT la.status, c.title
        FROM hr_learning_assignments la
        LEFT JOIN training_courses c ON c.id = la.course_id
       WHERE la.employee_id = ${employeeId}::uuid
       LIMIT 50`));
    for (const t of r) {
      training.push({ title: String(t.title || 'Course'), status: String(t.status || 'assigned') });
    }
    sources.push({
      source: 'training', present: true,
      note: 'Assignments and their recorded status. Progress is defined in learning-progress.ts.',
    });
  } catch (e: any) {
    logFail('buildFinalRecord training', e);
    gaps.push('Could not read: learning assignments.');
  }

  // ---- assessments -----------------------------------------------------------------------------------
  const assessments = coverage.outcomes
    .filter((o) => o.assessment)
    .map((o) => ({
      label: o.outcome.code,
      attempts: o.assessment!.attempts,
      bestPercent: o.assessment!.bestPercent,
    }));

  // ---- holistic participation --------------------------------------------------------------------------
  // TWO INDEPENDENT SIGNS OF THE SAME THING, and either one counts: a holistic OUTCOME that has
  // evidence behind it, or an ACTIVITY whose type is a well-being type. An intern who did the work
  // but whose programme never defined a holistic outcome is not thereby recorded as having done
  // nothing.
  //
  // NEITHER PATH TOUCHES THE HOURS. Holistic hours were already counted with every other hour, once,
  // inside the same ceiling — which is what "embedded, never 40 plus 2" means in code.
  const holisticRows = coverage.outcomes.filter((o) => o.outcome.category === 'holistic');
  const holisticActivities = coverage.activities.filter((a) => a.wellbeing).length;
  const holisticRecorded = holisticRows.some((o) => o.covered) || holisticActivities > 0;
  const holistic = {
    embedded: true as const,
    domains: Array.from(WELLBEING_DOMAINS),
    activityCount: holisticActivities,
    recorded: holisticRecorded,
    note: holisticRecorded
      ? HOLISTIC_EMBEDDED_SENTENCE
      : 'No holistic development activity is recorded against this engagement. '
        + HOLISTIC_EMBEDDED_SENTENCE,
  };

  // ---- mentor evaluation and grade ------------------------------------------------------------------------
  const rubric = await rubricResultFor(employeeId, key, config?.gradeBands || DEFAULT_GRADE_BANDS);
  if (!rubric.total) gaps.push('No grading rubric is configured for this programme.');
  else if (rubric.missing.length) {
    gaps.push('The rubric is not fully scored. Missing: ' + rubric.missing.join(', ') + '.');
  }

  // ---- the credit decision ---------------------------------------------------------------------------------
  const projectsCompleted = projects.filter((p) => /complete|closed|delivered/i.test(p.status)).length;
  const trainingCompleted = training.filter((t) => /complete|done|passed/i.test(t.status)).length;
  const bestScores = assessments.map((a) => a.bestPercent).filter((n): n is number => n != null);
  const documentedOutcomes = coverage.outcomes.filter((o) => o.evidence.length > 0).length;

  const measurements: Partial<Record<CreditComponentKey, { attainment: number | null; basis: string }>> = {
    'verified-workload': {
      attainment: verified != null && requiredHours ? clamp01(verified / requiredHours) : null,
      basis: verified == null
        ? 'No verified hour figure is recorded.'
        : 'Verified activity hours ' + verified + ' against a requirement of ' + requiredHours + '.',
    },
    'learning-outcomes': {
      attainment: coverage.coverageFraction,
      basis: coverage.total
        ? coverage.covered + ' of ' + coverage.total + ' outcomes covered, ' + coverage.uncovered
          + ' uncovered.'
        : 'No outcomes are defined for this programme.',
    },
    'project-completion': {
      attainment: projects.length ? clamp01(projectsCompleted / projects.length) : null,
      basis: projects.length
        ? projectsCompleted + ' of ' + projects.length + ' projects recorded as complete.'
        : 'No project membership recorded.',
    },
    assessments: {
      attainment: bestScores.length
        ? clamp01(bestScores.reduce((a, b) => a + b, 0) / bestScores.length / 100) : null,
      basis: bestScores.length
        ? 'Mean best result across ' + bestScores.length + ' assessment(s).'
        : 'No assessment results recorded.',
    },
    'mentor-evaluation': {
      attainment: rubric.percent == null ? null : clamp01(rubric.percent / 100),
      basis: rubric.percent == null
        ? 'The rubric has not been scored.'
        : 'Weighted rubric result over ' + rubric.scoredCount + ' of ' + rubric.total + ' criteria.',
    },
    'professional-holistic': {
      attainment: holisticRows.length
        ? clamp01(holisticRows.filter((o) => o.covered).length / holisticRows.length)
        : (holisticActivities > 0 ? 1 : null),
      basis: holisticRows.length
        ? 'Holistic outcomes covered, inside the programme and inside its credits.'
        : (holisticActivities > 0
          ? holisticActivities + ' holistic activity(ies) recorded, inside the weekly ceiling. No '
            + 'holistic outcome is defined for this programme to measure them against.'
          : 'No holistic outcome is defined for this programme and no holistic activity is recorded.'),
    },
    documentation: {
      attainment: coverage.total ? clamp01(documentedOutcomes / coverage.total) : null,
      basis: coverage.total
        ? documentedOutcomes + ' of ' + coverage.total + ' outcomes carry an evidence reference.'
        : 'No outcomes are defined for this programme.',
    },
    'final-evaluation': {
      attainment: rubric.complete && rubric.percent != null ? clamp01(rubric.percent / 100) : null,
      basis: rubric.complete
        ? 'The closing evaluation is complete.'
        : 'The closing evaluation is not complete.',
    },
  };

  const credit = decideCredit(measurements, config);
  const grade = rubric.grade;

  if (trainingCompleted < training.length && training.length) {
    advisories.push(
      'Training assignments are recorded as incomplete: ' + (training.length - trainingCompleted)
      + ' of ' + training.length + '. Advisory for a mentor, not a penalty.',
    );
  }

  const document: FinalRecordDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    platformStatement: PLATFORM_ROLE_SENTENCE,
    statements: [
      PLATFORM_ROLE_SENTENCE,
      NOT_ATTENDANCE_SENTENCE,
      HOLISTIC_EMBEDDED_SENTENCE,
      CEILING_SENTENCE,
      ADVISORY_SENTENCE,
    ],
    identity: {
      employeeId,
      name: String(emp.full_name || ''),
      designation: String(emp.designation || ''),
      department: String(emp.department_name || ''),
      employmentType: String(emp.employment_type || ''),
      programmeKey: key,
      programmeName: config?.programmeName || '',
      partnerInstitution: config?.partnerInstitution ?? null,
    },
    duration: { start, end, weeks },
    hours,
    outcomes: {
      total: coverage.total,
      covered: coverage.covered,
      uncovered: coverage.uncovered,
      verified: coverage.verified,
      coverageFraction: coverage.coverageFraction,
      rows: coverage.outcomes.map((o) => ({
        code: o.outcome.code,
        statement: o.outcome.statement,
        state: o.state,
        covered: o.covered,
        verifiedHours: o.verifiedHours,
        evidenceCount: o.evidence.length,
        mentorAttainment: o.mentor ? o.mentor.attainment : null,
      })),
    },
    projects,
    assignments,
    training,
    assessments,
    holistic,
    mentorEvaluation: {
      percent: rubric.percent,
      complete: rubric.complete,
      missing: rubric.missing,
      assessors: rubric.assessors,
      lines: rubric.lines.map((l) => ({
        code: l.criterion.code,
        label: l.criterion.label,
        weightPct: l.criterion.weightPct,
        score: l.score ? l.score.score : null,
        maxScore: l.criterion.maxScore,
      })),
    },
    grade: grade ? { code: grade.code, label: grade.label, percent: rubric.percent } : null,
    credit,
    configSnapshot: config,
    certificate: null,
    gaps,
    advisories,
    sources,
  };

  return { ok: true, document };
}

export async function getFinalRecord(employeeId: string): Promise<FinalRecordRow | null> {
  if (!isUuid(employeeId)) return null;
  try {
    await ensureCreditSchema();
    const r = rows(await (await database()).execute(sql`
      SELECT * FROM eims_final_records WHERE employee_id = ${employeeId}::uuid LIMIT 1`));
    return r.length ? mapFinalRecord(r[0]) : null;
  } catch (e: any) {
    logFail('getFinalRecord', e);
    return null;
  }
}

/**
 * ISSUE THE FINAL RECORD, AND WITH IT ONE CERTIFICATE IN THE EXISTING LEDGER.
 *
 * THE ORDER IS THE SAFETY PROPERTY, and each step exists because of the failure it prevents:
 *
 *   1. UPSERT the row and CLAIM it with a guarded UPDATE to 'issuing' WHERE state IN
 *      ('draft','withdrawn'). Two requests racing on one person make exactly one of them touch a
 *      row; the other is told the record is already being issued rather than minting a second
 *      certificate for the same internship.
 *   2. ISSUE the certificate through src/lib/universal-certificates.ts — kind 'internship', the
 *      ledger this product already verifies at /credentials/<serial>. No second certificate table.
 *   3. WRITE the serial, the frozen document and 'issued'.
 *   4. IF THE CERTIFICATE STEP FAILS, put the row back to 'draft' and say so. An 'issuing' row that
 *      nobody can move is a record stuck forever, and a record stuck forever is a person who cannot
 *      be given the document they earned.
 *
 * GAPS ARE NOT SILENTLY OVERRIDDEN. A document with gaps refuses to issue unless the caller passes
 * `acknowledgeGaps` AND a written reason, and BOTH are frozen into the document so whoever reads it
 * later sees exactly what was known to be missing at the time.
 */
export async function issueFinalRecord(
  actor: Actor | null,
  employeeId: string,
  opts: { programmeKey?: string; acknowledgeGaps?: boolean; reason?: string } = {},
): Promise<{ ok: boolean; serial?: string; verificationUrl?: string; error?: string; gaps?: string[] }> {
  if (!can(actor as any, 'eims.record.issue')) {
    return { ok: false, error: 'You do not hold the desk that issues an internship record.' };
  }
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };

  const built = await buildFinalRecord(employeeId, { programmeKey: opts.programmeKey });
  if (!built.ok || !built.document) {
    return { ok: false, error: built.error || 'The record could not be assembled. Nothing was issued.' };
  }
  const doc = built.document;
  const reason = String(opts.reason || '').trim().slice(0, 1000);

  if (doc.gaps.length && !(opts.acknowledgeGaps && reason)) {
    return {
      ok: false,
      gaps: doc.gaps,
      error: 'This record has gaps. Issue it only with an explicit acknowledgement and a written '
        + 'reason, which are both printed on the record.',
    };
  }
  if (doc.gaps.length) {
    doc.gaps = doc.gaps.slice();
    doc.gaps.push('Issued with these gaps acknowledged by ' + String(actor?.name || actor?.email || 'an administrator')
      + ': ' + reason);
  }

  const key = programmeKeyOf(opts.programmeKey);
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  const actorName = String(actor?.name || actor?.email || '').slice(0, 200);

  try {
    await ensureCreditSchema();
    await (await database()).execute(sql`
      INSERT INTO eims_final_records (employee_id, programme_key, state)
      VALUES (${employeeId}::uuid, ${key}, 'draft')
      ON CONFLICT (employee_id) DO NOTHING`);

    const claimed = rows(await (await database()).execute(sql`
      UPDATE eims_final_records SET state = 'issuing', updated_at = NOW()
       WHERE employee_id = ${employeeId}::uuid AND state IN ('draft', 'withdrawn')
      RETURNING id`));
    if (!claimed.length) {
      const current = await getFinalRecord(employeeId);
      if (current?.state === 'issued') {
        return {
          ok: false,
          serial: current.certificateSerial || undefined,
          error: 'An internship record has already been issued for this person. Withdraw it before '
            + 'issuing another.',
        };
      }
      return { ok: false, error: 'This record is already being issued. Nothing was changed.' };
    }

    // WHAT GOES ON THE PUBLIC CERTIFICATE, AND WHAT DOES NOT. Enough to verify: who, what programme,
    // how long, the headline figures, and who awards. No email address, no employee id, no
    // department, no mentor comment. The internal record holds the rest, behind a gate.
    const creditLine = doc.credit.creditsRecommended == null
      ? 'Credits are computed by the awarding institution.'
      : doc.credit.creditsRecommended + ' of ' + doc.credit.totalCredits
        + ' credits recommended for recognition by the awarding institution.';
    const hoursLine = doc.hours.verifiedHours == null
      ? 'Verified hours are recorded on the internship record held by the platform.'
      : doc.hours.verifiedHours + ' verified activity hours.';
    const title = 'Internship: ' + (doc.identity.programmeName || doc.identity.designation || 'Programme');
    const body = [
      'Completed ' + doc.duration.start + ' to ' + doc.duration.end
        + (doc.duration.weeks ? ' (' + doc.duration.weeks + ' weeks).' : '.'),
      hoursLine,
      doc.outcomes.total
        ? doc.outcomes.covered + ' of ' + doc.outcomes.total + ' learning outcomes evidenced.'
        : 'Learning outcomes are recorded on the internship record.',
      creditLine,
      doc.grade ? 'Grade: ' + doc.grade.code + ' (' + doc.grade.label + ').' : '',
      HOLISTIC_EMBEDDED_SENTENCE,
      NOT_ATTENDANCE_SENTENCE,
      PLATFORM_ROLE_SENTENCE,
      doc.identity.partnerInstitution
        ? 'Awarding institution: ' + doc.identity.partnerInstitution + '.'
        : 'No awarding institution is recorded against this programme. This record evidences the '
          + 'work; it is not itself an award.',
    ].filter(Boolean).join('\n\n');

    let issued: any = null;
    try {
      issued = await issueUniversalCertificate({
        kind: 'internship',
        recipientName: doc.identity.name || 'Intern',
        recipientEmployeeId: employeeId,
        title,
        body,
        achievement: doc.identity.designation || '',
        issuedByUserId: actorId || undefined,
        issuedByName: actorName || undefined,
        metadata: {
          programmeKey: key,
          creditsRecommended: doc.credit.creditsRecommended,
          totalCredits: doc.credit.totalCredits,
          grade: doc.grade?.code ?? null,
          verifiedHours: doc.hours.verifiedHours,
          awardedByPlatform: false,
        },
      });
    } catch (e: any) {
      logFail('issueFinalRecord certificate', e);
      issued = null;
    }

    const serial = issued?.serial ? String(issued.serial) : '';
    if (!serial) {
      // PUT IT BACK. A claimed row with no certificate behind it must not stay claimed.
      await (await database()).execute(sql`
        UPDATE eims_final_records SET state = 'draft', updated_at = NOW()
         WHERE employee_id = ${employeeId}::uuid AND state = 'issuing'`);
      return {
        ok: false,
        error: 'The certificate could not be issued, so nothing was recorded. The record is still a '
          + 'draft and can be issued again.',
      };
    }

    doc.certificate = {
      serial,
      verificationId: serial,
      verificationUrl: VERIFY_PATH + serial,
    };

    const saved = rows(await (await database()).execute(sql`
      UPDATE eims_final_records
         SET state = 'issued',
             programme_key = ${key},
             config_id = ${doc.configSnapshot ? doc.configSnapshot.id : null},
             document = ${JSON.stringify(doc)}::jsonb,
             grade_code = ${doc.grade ? doc.grade.code : null},
             grade_percent = ${doc.grade ? doc.grade.percent : null},
             credits_recommended = ${doc.credit.creditsRecommended},
             hours_required = ${doc.hours.requiredHours},
             hours_allocated = ${doc.hours.allocatedHours},
             hours_completed = ${doc.hours.completedHours},
             hours_verified = ${doc.hours.verifiedHours},
             certificate_serial = ${serial},
             verification_id = ${serial},
             issued_by_user_id = ${actorId},
             issued_by_name = ${actorName},
             issued_at = NOW(),
             withdrawn_at = NULL,
             withdrawn_by_user_id = NULL,
             withdrawal_reason = NULL,
             updated_at = NOW()
       WHERE employee_id = ${employeeId}::uuid AND state = 'issuing'
      RETURNING id`));
    if (!saved.length) {
      return {
        ok: false,
        serial,
        error: 'The certificate ' + serial + ' was created but the record could not be updated. '
          + 'Do not issue another one: hand this serial to whoever maintains the record.',
      };
    }

    await logAudit({
      userId: actorId,
      action: 'eims.record.issue',
      entity: 'eims_final_records',
      entityId: String(saved[0].id),
      diff: {
        employeeId, serial, programmeKey: key,
        credits: doc.credit.creditsRecommended, grade: doc.grade?.code ?? null,
        gaps: doc.gaps.length,
      },
    });

    return { ok: true, serial, verificationUrl: VERIFY_PATH + serial };
  } catch (e: any) {
    logFail('issueFinalRecord', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * Withdraw an issued record, and REVOKE THE CERTIFICATE WITH IT.
 *
 * revokeUniversal() answers whether it actually revoked something, which is why it is used rather
 * than a bare UPDATE: a withdrawn record whose certificate still verifies as valid is the single
 * worst outcome available here, and a serial typed one character wrong used to produce exactly that.
 */
export async function withdrawFinalRecord(
  actor: Actor | null,
  employeeId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!can(actor as any, 'eims.record.issue')) {
    return { ok: false, error: 'You do not hold the desk that issues an internship record.' };
  }
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.' };
  const text = String(reason || '').trim().slice(0, 1000);
  if (!text) return { ok: false, error: 'Withdrawing a record needs a written reason. Nothing was changed.' };

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  // The revocation row NAMES who withdrew the credential, and revokeUniversal writes that id into a
  // uuid column. Refusing here rather than passing an empty string keeps the failure a sentence
  // somebody can act on instead of a driver error at the point the certificate is being revoked.
  if (!actorId) {
    return { ok: false, error: 'A withdrawal has to be attributable to a signed-in account. Nothing was changed.' };
  }

  try {
    await ensureCreditSchema();
    const rec = await getFinalRecord(employeeId);
    if (!rec) return { ok: false, error: 'There is no internship record for this person.' };
    if (rec.state !== 'issued') {
      return { ok: false, error: 'That record is not issued, so there is nothing to withdraw.' };
    }

    if (rec.certificateSerial) {
      const revoked = await revokeUniversal(rec.certificateSerial, actorId, text);
      if (!revoked.revoked && !revoked.alreadyRevoked) {
        return {
          ok: false,
          error: 'The certificate ' + rec.certificateSerial + ' could not be revoked, so the record '
            + 'was left as issued. A withdrawn record whose certificate still verifies would be '
            + 'worse than either state on its own.',
        };
      }
    }

    const w = rows(await (await database()).execute(sql`
      UPDATE eims_final_records
         SET state = 'withdrawn', withdrawn_at = NOW(), withdrawn_by_user_id = ${actorId},
             withdrawal_reason = ${text}, updated_at = NOW()
       WHERE employee_id = ${employeeId}::uuid AND state = 'issued'
      RETURNING id`));
    if (!w.length) return { ok: false, error: 'That record was not withdrawn. Nothing was changed.' };

    await logAudit({
      userId: actorId, action: 'eims.record.withdraw', entity: 'eims_final_records',
      entityId: String(w[0].id), diff: { employeeId, serial: rec.certificateSerial, reason: text },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('withdrawFinalRecord', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * WHAT A PUBLIC VERIFICATION PAGE MAY SHOW. Enough to verify the claim in front of the reader, and
 * no more personal data than that requires.
 *
 * DELIBERATELY ABSENT: email address, employee id, department, mentor names, mentor comments,
 * per-outcome detail, rubric scores, gaps and advisories. A verifier needs to know that this person
 * completed this programme, over these dates, with these headline figures, and who awards. They do
 * not need the internal record, and this function is the boundary that says so.
 */
export interface PublicVerification {
  serial: string;
  holderName: string;
  programme: string;
  partnerInstitution: string | null;
  start: string;
  end: string;
  weeks: number | null;
  verifiedHours: number | null;
  outcomesCovered: number | null;
  outcomesTotal: number | null;
  creditsRecommended: number | null;
  totalCredits: number | null;
  grade: string | null;
  issuedAt: string | null;
  withdrawn: boolean;
  statements: string[];
}

export async function publicVerification(serial: string): Promise<PublicVerification | null> {
  const s = String(serial || '').trim().slice(0, 60);
  if (!s) return null;
  try {
    await ensureCreditSchema();
    const r = rows(await (await database()).execute(sql`
      SELECT * FROM eims_final_records WHERE certificate_serial = ${s} LIMIT 1`))[0];
    if (!r) return null;
    const rec = mapFinalRecord(r);
    const doc = rec.document;
    return {
      serial: s,
      holderName: doc?.identity.name || '',
      programme: doc?.identity.programmeName || doc?.identity.designation || '',
      partnerInstitution: doc?.identity.partnerInstitution ?? null,
      start: doc?.duration.start || '',
      end: doc?.duration.end || '',
      weeks: doc?.duration.weeks ?? null,
      verifiedHours: rec.document?.hours.verifiedHours ?? null,
      outcomesCovered: doc?.outcomes.covered ?? null,
      outcomesTotal: doc?.outcomes.total ?? null,
      creditsRecommended: rec.creditsRecommended,
      totalCredits: doc?.credit.totalCredits ?? null,
      grade: rec.gradeCode,
      issuedAt: rec.issuedAt,
      withdrawn: rec.state === 'withdrawn',
      statements: [PLATFORM_ROLE_SENTENCE, NOT_ATTENDANCE_SENTENCE, HOLISTIC_EMBEDDED_SENTENCE],
    };
  } catch (e: any) {
    logFail('publicVerification', e);
    return null;
  }
}
