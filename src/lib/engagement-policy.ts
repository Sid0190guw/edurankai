// src/lib/engagement-policy.ts
//
// THE ONE PLACE WORKING-TIME NUMBERS LIVE.
//
// Why this file exists
// -------------------
// A bare "40 hours" was being shown to candidates with nothing around it. 40 is the TOTAL
// ENGAGEMENT for an internship — of which only 5 hours a day is project work and 1 hour 40
// minutes a day is holistic well-being and personal development. Someone reading "40 hours"
// reasonably concludes they owe 40 hours of task output. They do not. Never show the total
// without the split: that is what `describeCommitment()` exists to enforce.
//
// The same number was also written into at least six places — the intern catalog, the careers
// job-posting JSON-LD, the careers terms panel, two admin offer forms, the recruitment policy
// and the work-culture policy — and they had already drifted apart. The catalog said 6 days /
// 40 hours; the policy pages said 2.5 hours a day over 5 days; the offer forms defaulted to
// "2.5 hrs/day, 5 days/week" for every intern; the founder's remark asked for a further 2.5
// hours a day of well-being while the policy said 1.67. A number that appears in six files
// disagrees in six ways. It now appears once, here.
//
// ONE NUMBER DOES NOT COVER EVERY LEVEL, and pretending it does is the vagueness being
// complained about. An intern, a mid-level engineer and a Chief Officer do not work the same
// way and must not be described the same way. See TIME MODELS below.
//
// MINUTES ARE THE BASE UNIT. "1.67 hours" is a rounding artefact that will not add up: six days
// of 1.67 is 10.02, and twelve weeks of that is 120.24. The real figure is 1 hour 40 minutes —
// 100 minutes — and in minutes every derived total is exact: 300 + 100 = 400 a day, 2400 a
// week (40 h), 28,800 over twelve weeks (480 h), split exactly 360 h project / 120 h well-being.
// Hours are derived for display; they are never the stored value.
//
// No database, no I/O. Pure data and pure functions, safe to import from .astro frontmatter,
// from API routes and from tests.

/* -------------------------------------------------------------------------- levels and models */

export type EngagementLevel =
  | 'Intern' | 'Apprentice' | 'Junior' | 'Mid' | 'Senior' | 'Lead' | 'Director' | 'C-Level';

export type EngagementTypeName =
  | 'Internship' | 'Apprenticeship' | 'Full-Time' | 'Part-Time' | 'Contract';

/**
 * HOW WORKING TIME IS EXPRESSED, which is a different question at each level.
 *
 * 'counted'      Hours ARE the deliverable. Interns and apprentices are on a credit-bearing
 *                programme: under the AICTE internship framework one academic credit corresponds
 *                to a minimum of 45 hours of work, so the hours are the thing being certified.
 *                Counting them is correct here and only here. The split must always be shown.
 *
 * 'scheduled'    A defined working week. The person is a worker in the statutory sense, the
 *                state Shops and Establishments Act ceiling applies to them (9 hours a day, 48
 *                a week, at least 24 consecutive hours of weekly rest, a break after five hours
 *                of continuous work), and work beyond the schedule is compensated, not assumed.
 *                Hours are recorded for statutory compliance — never as a performance score.
 *
 * 'core-hours'   No hour count. A stated overlap window so colleagues can reach you, and
 *                objectives agreed for the cycle. Senior individual contributors and leads:
 *                the working week is a norm the role is designed around, not a quota they clock.
 *
 * 'accountable'  No working hours are stated at all. Directors and C-level officers occupy
 *                positions of management; the working-hours provisions of the state Shops and
 *                Establishments Acts expressly do not apply to persons in positions of
 *                management or in a confidential capacity, and under the labour codes such
 *                roles sit outside the definition of a "worker". Telling a Chief Officer they
 *                owe five hours a day is as wrong as telling an intern nothing at all: it is
 *                inaccurate, unenforceable, and it misdescribes the job. What is owed is the
 *                outcome, the judgement and the availability the office requires.
 */
export type TimeModel = 'counted' | 'scheduled' | 'core-hours' | 'accountable';

export type CompensationBasis = 'unpaid-unless-stipend' | 'salaried';

/* ------------------------------------------------------------------- statutory reference data */

/** One academic credit under the AICTE internship framework = a minimum of 45 hours of work. */
export const AICTE_HOURS_PER_CREDIT = 45;

/**
 * The ceiling set by the state Shops and Establishments Acts, which is the statute that governs a
 * commercial establishment like this one. The figures are the same across the major states
 * (Karnataka, Maharashtra, Delhi, Tamil Nadu): 9 a day, 48 a week. They are a CEILING, not a
 * target, and nothing in this file is allowed to exceed them.
 */
export const STATUTORY = {
  maxHoursPerDay: 9,
  maxHoursPerWeek: 48,
  weeklyRestHours: 24,
  breakAfterMinutes: 5 * 60,
  breakMinutes: 30,
} as const;

/**
 * The six well-being domains, in the exact wording of the published internship policy. These are
 * faith-neutral by construction and that is deliberate — see the note on the founder's remark in
 * src/pages/portal/offer/[token].astro. Anything ASSESSED must be describable without reference
 * to anyone's religion, and these are.
 */
export const WELLBEING_DOMAINS = [
  'physical fitness',
  'mindfulness',
  'reading',
  'reflective learning',
  'leadership development',
  'community engagement',
] as const;

/* --------------------------------------------------------------------------- the policy shape */

export interface EngagementPolicy {
  /** Stable key. Also the level name. */
  readonly level: EngagementLevel;
  /** What to call this band in copy. */
  readonly label: string;
  readonly timeModel: TimeModel;
  readonly compensation: CompensationBasis;

  /** Scheduled working days per week. `null` where the level does not have a fixed week. */
  readonly daysPerWeek: number | null;
  /** Guaranteed non-working days per week. Never 0 — the weekly rest day is statutory. */
  readonly restDaysPerWeek: number;

  /** Minutes of project work and departmental responsibility per working day. */
  readonly projectMinutesPerDay: number | null;
  /** Minutes of holistic well-being and personal development per working day. */
  readonly wellbeingMinutesPerDay: number | null;
  /** Total engagement minutes per week. `null` where hours are not counted. */
  readonly totalMinutesPerWeek: number | null;

  /**
   * A notional full week used ONLY as a denominator — leave accrual, pro-rata pay, part-time
   * conversion. It is not an expectation, is never shown as "your hours", and exists so that
   * levels with no counted hours can still have leave calculated for them.
   */
  readonly notionalWeekMinutes: number;

  /** Programme length in weeks, where the engagement is fixed-term. `null` for permanent roles. */
  readonly durationWeeks: number | null;

  /** Minutes of guaranteed daily overlap with the rest of the team, for the 'core-hours' model. */
  readonly coreOverlapMinutes: number | null;

  /** True only where the hours themselves are the certified deliverable. */
  readonly hoursAreDeliverable: boolean;

  /** One line, plain, honest, never a bare total. */
  readonly headline: string;
  /** What the statute actually says about a person at this level. */
  readonly statutoryNote: string;
  /** How performance is judged, which is the real answer to "how many hours do I owe?". */
  readonly measuredBy: string;
}

/* -------------------------------------------------------------------------------- the policies */

const H = 60;

/**
 * THE PUBLISHED INTERNSHIP POLICY, verbatim in structure:
 *   6 working days a week. Approximately 40 hours per week of total engagement — about 480 hours
 *   over 12 weeks. Of each day, approximately 5 hours of project work and departmental
 *   responsibilities, plus approximately 1 hour 40 minutes of holistic well-being and personal
 *   development. Offered under the applicable AICTE internship framework, and unpaid unless a
 *   stipend is explicitly recorded. Completion does not constitute or guarantee employment.
 */
const INTERN: EngagementPolicy = {
  level: 'Intern',
  label: 'Internship',
  timeModel: 'counted',
  compensation: 'unpaid-unless-stipend',
  daysPerWeek: 6,
  restDaysPerWeek: 1,
  projectMinutesPerDay: 5 * H,
  wellbeingMinutesPerDay: H + 40,
  totalMinutesPerWeek: 6 * (5 * H + H + 40),   // 2400 = 40 h exactly
  notionalWeekMinutes: 6 * (5 * H + H + 40),
  durationWeeks: 12,
  coreOverlapMinutes: null,
  hoursAreDeliverable: true,
  headline: 'Six days a week. About 40 hours of total engagement — 5 hours a day of project work, plus 1 hour 40 minutes a day of well-being and personal development.',
  statutoryNote: 'Offered under the applicable AICTE internship framework, where one academic credit corresponds to a minimum of 45 hours of work — which is why these hours are counted and certified. The engagement sits well inside the 9-hour day and 48-hour week ceiling of the applicable state Shops and Establishments Act, and the seventh day is a full rest day.',
  measuredBy: 'Weekly mentor review against a published rubric, plus the completion of the recorded hours. Working materially over the commitment is treated the same as working under it.',
};

const APPRENTICE: EngagementPolicy = {
  ...INTERN,
  level: 'Apprentice',
  label: 'Apprenticeship',
  durationWeeks: 26,
  headline: 'Six days a week over six months. About 40 hours of total engagement a week — 5 hours a day of structured practice, plus 1 hour 40 minutes a day of well-being and personal development.',
  measuredBy: 'A structured competency pathway with periodic rubric evaluations, plus the completion of the recorded hours.',
};

/** A standard working week: five days, eight hours. 40 of the statutory 48. */
const SCHEDULED_WEEK = 5 * 8 * H;

const JUNIOR: EngagementPolicy = {
  level: 'Junior',
  label: 'Junior',
  timeModel: 'scheduled',
  compensation: 'salaried',
  daysPerWeek: 5,
  restDaysPerWeek: 2,
  projectMinutesPerDay: 8 * H,
  wellbeingMinutesPerDay: null,
  totalMinutesPerWeek: SCHEDULED_WEEK,
  notionalWeekMinutes: SCHEDULED_WEEK,
  durationWeeks: null,
  coreOverlapMinutes: null,
  hoursAreDeliverable: false,
  headline: 'A scheduled week: five days, eight hours a day, with two full rest days.',
  statutoryNote: 'Within the 9-hour day and 48-hour week ceiling of the applicable state Shops and Establishments Act, with at least 24 consecutive hours of weekly rest and a break of at least 30 minutes after five hours of continuous work. Hours are recorded for statutory compliance only. Work beyond the scheduled week is agreed in advance and compensated with time off in lieu.',
  measuredBy: 'Objectives agreed at the start of each cycle. Hours recorded for compliance are never used as a performance score.',
};

const MID: EngagementPolicy = {
  ...JUNIOR,
  level: 'Mid',
  label: 'Mid-level',
  headline: 'A scheduled week: five days, eight hours a day, with two full rest days and latitude over when within the day you work.',
};

/**
 * SENIOR AND LEAD: the working week is the shape the ROLE is designed around, not a quota the
 * person clocks. Stating a daily hour figure here would invite exactly the wrong behaviour, so we
 * state the overlap they owe their colleagues and the objectives they own, and nothing else.
 */
const SENIOR: EngagementPolicy = {
  level: 'Senior',
  label: 'Senior',
  timeModel: 'core-hours',
  compensation: 'salaried',
  daysPerWeek: 5,
  restDaysPerWeek: 2,
  projectMinutesPerDay: null,
  wellbeingMinutesPerDay: null,
  totalMinutesPerWeek: null,
  notionalWeekMinutes: SCHEDULED_WEEK,
  durationWeeks: null,
  coreOverlapMinutes: 4 * H,
  hoursAreDeliverable: false,
  headline: 'No counted hours. A five-day week with a four-hour overlap window so colleagues can reach you, and objectives agreed for the cycle.',
  statutoryNote: 'Hours are not counted at this level. The statutory ceiling of 9 hours a day and 48 a week remains the limit the role is designed to fit inside: if the work cannot be done within a normal week, the scope is wrong, not the person.',
  measuredBy: 'Objectives agreed for the cycle, the quality of the judgement calls, and the people the work makes better. Not attendance.',
};

const LEAD: EngagementPolicy = {
  ...SENIOR,
  level: 'Lead',
  label: 'Lead',
  headline: 'No counted hours. A five-day week with a four-hour overlap window, plus responsibility for the coverage of your area — including who is on call and when.',
  measuredBy: 'The outcomes of the area you lead, the reliability of its coverage, and the growth of the people in it.',
};

/**
 * DIRECTOR AND C-LEVEL: no hours are stated, and this is a legal position as much as a cultural
 * one. Persons occupying a position of management or employed in a confidential capacity are
 * expressly outside the working-hours provisions of the state Shops and Establishments Acts, and
 * under the labour codes a person employed in a managerial or administrative capacity falls
 * outside the definition of a "worker" altogether. A fixed daily hour count in an offer to a
 * Chief Officer is not a stricter standard — it is an inaccurate one.
 */
const DIRECTOR: EngagementPolicy = {
  level: 'Director',
  label: 'Director',
  timeModel: 'accountable',
  compensation: 'salaried',
  daysPerWeek: null,
  restDaysPerWeek: 1,
  projectMinutesPerDay: null,
  wellbeingMinutesPerDay: null,
  totalMinutesPerWeek: null,
  notionalWeekMinutes: SCHEDULED_WEEK,
  durationWeeks: null,
  coreOverlapMinutes: null,
  hoursAreDeliverable: false,
  headline: 'No fixed daily or weekly hours. The role carries accountability for outcomes, the availability those outcomes require, and at least one full day of rest each week that you are expected to actually take.',
  statutoryNote: 'A role of this kind occupies a position of management. The working-hours provisions of the state Shops and Establishments Acts do not apply to persons in positions of management or in a confidential capacity, and under the labour codes such a role sits outside the definition of a worker. Stating a fixed hour count here would be neither accurate nor enforceable.',
  measuredBy: 'The outcomes owned by the function, agreed with the founder each cycle. There is no attendance component and no hour count.',
};

const C_LEVEL: EngagementPolicy = {
  ...DIRECTOR,
  level: 'C-Level',
  label: 'C-Level',
  headline: 'No fixed daily or weekly hours. The office carries accountability for its remit, the availability that remit requires, and at least one full day of rest each week that you are expected to actually take.',
  measuredBy: 'The remit of the office, reviewed on the cycle agreed with the founder and the board. There is no attendance component and no hour count.',
};

export const ENGAGEMENT_POLICIES: Readonly<Record<EngagementLevel, EngagementPolicy>> = {
  'Intern': INTERN,
  'Apprentice': APPRENTICE,
  'Junior': JUNIOR,
  'Mid': MID,
  'Senior': SENIOR,
  'Lead': LEAD,
  'Director': DIRECTOR,
  'C-Level': C_LEVEL,
};

/** Ladder order, for tables that show the whole model at once. */
export const ENGAGEMENT_LEVEL_ORDER: readonly EngagementLevel[] = [
  'Intern', 'Apprentice', 'Junior', 'Mid', 'Senior', 'Lead', 'Director', 'C-Level',
];

/* ------------------------------------------------------------------------------- the resolver */

/**
 * Word-boundary intern test. `\bintern(?!al)` is the same pattern src/lib/auth/admin-access.ts and
 * the offer letter use, so "Internal Auditor" and "International" are never read as intern.
 */
export const INTERN_WORD = /\bintern(?!a)/i;

/**
 * Titles that are senior no matter what template somebody opened first. This is the guard that
 * stops a Chief AI Officer being handed internship numbers, and it deliberately runs BEFORE any
 * intern test — see the resolver.
 */
export const SENIOR_TITLE = /\b(c-level|chief|cxo|ceo|cto|coo|cfo|cio|cmo|executive|director|vp|vice[- ]president|head|lead|principal|senior|manager|partner|founder)\b/i;

const DIRECTOR_TITLE = /\b(c-level|chief|cxo|ceo|cto|coo|cfo|cio|cmo|president|director|vp|vice[- ]president|founder)\b/i;
const LEAD_TITLE = /\b(lead|head|manager|principal)\b/i;

export interface ResolveInput {
  level?: string | null;
  engagementType?: string | null;
  employmentType?: string | null;
  roleTitle?: string | null;
}

/**
 * Work out which policy applies. The rule that matters:
 *
 *   SENIORITY WINS OVER ENGAGEMENT TYPE, AND THE FALLBACK IS NEVER INTERN.
 *
 * The failure this module exists to prevent went the other way — intern was the fallback, so an
 * engagement that said nothing got the most junior possible reading, which is the one that
 * insults the person receiving it. Here an engagement is an internship only when something
 * POSITIVELY says so and nothing senior contradicts it; everything unrecognised lands on 'Mid',
 * a scheduled salaried week, which is wrong in a survivable direction.
 */
export function resolveEngagementPolicy(input: ResolveInput): EngagementPolicy {
  const title = String(input.roleTitle || '');
  const levelRaw = String(input.level || '').trim();
  const type = String(input.engagementType || input.employmentType || '');

  // An explicit, recognised level is the most reliable signal available.
  const exact = (Object.keys(ENGAGEMENT_POLICIES) as EngagementLevel[])
    .find((k) => k.toLowerCase() === levelRaw.toLowerCase());
  if (exact) {
    // ...unless the level says Intern while the title says Chief. That combination is exactly the
    // offer that went out wrong, and the title is the field a human actually filled in on purpose.
    if ((exact === 'Intern' || exact === 'Apprentice') && SENIOR_TITLE.test(title)) {
      return DIRECTOR_TITLE.test(title) ? C_LEVEL : ENGAGEMENT_POLICIES[LEAD_TITLE.test(title) ? 'Lead' : 'Senior'];
    }
    return ENGAGEMENT_POLICIES[exact];
  }

  if (DIRECTOR_TITLE.test(title) || DIRECTOR_TITLE.test(levelRaw)) {
    return /\b(chief|cxo|ceo|cto|coo|cfo|cio|cmo|c-level|president|founder)\b/i.test(title + ' ' + levelRaw)
      ? C_LEVEL : DIRECTOR;
  }
  if (LEAD_TITLE.test(title) || LEAD_TITLE.test(levelRaw)) return LEAD;
  if (/\bsenior|sr\.?\b/i.test(title) || /\bsenior\b/i.test(levelRaw)) return SENIOR;

  const declaredIntern = INTERN_WORD.test(type) || INTERN_WORD.test(title) || INTERN_WORD.test(levelRaw);
  if (declaredIntern && !SENIOR_TITLE.test(title)) return INTERN;
  if (/\bapprentice/i.test(type + ' ' + title + ' ' + levelRaw) && !SENIOR_TITLE.test(title)) return APPRENTICE;
  if (/\bjunior|\bjr\.?\b|\bassociate\b|\btrainee\b/i.test(title + ' ' + levelRaw)) return JUNIOR;

  return MID;
}

/** True when this engagement is genuinely on the internship policy and may be shown its numbers. */
export function isInternshipPolicy(p: EngagementPolicy): boolean {
  return p.timeModel === 'counted';
}

/**
 * Let a single role vary the counted numbers without letting it invent a different SHAPE.
 *
 * Roles carry editable AICTE fields in the admin, stored in hours, and a specific programme may
 * genuinely run 4 days or 8 weeks. Those variations belong to the role. What must NOT happen is a
 * Director's role picking up a stray `hoursPerWeek` value left in a form and being described as
 * though somebody counts their day — so overrides are accepted only where hours are the
 * deliverable, and are ignored everywhere else.
 *
 * Any override that would breach the statutory ceiling is dropped, not clamped: a role wrongly
 * configured at 60 hours falls back to the published policy rather than publishing an illegal week.
 */
export function applyRoleOverrides(
  p: EngagementPolicy,
  o: {
    daysPerWeek?: number | null;
    hoursPerWeek?: number | null;
    projectHoursPerDay?: number | null;
    wellbeingHoursPerDay?: number | null;
    durationWeeks?: number | null;
  } | null | undefined,
): EngagementPolicy {
  if (!o || p.timeModel !== 'counted') return p;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

  const days = num(o.daysPerWeek) ?? p.daysPerWeek;
  const project = num(o.projectHoursPerDay) != null
    ? Math.round((o.projectHoursPerDay as number) * 60) : p.projectMinutesPerDay;
  const wellbeing = num(o.wellbeingHoursPerDay) != null
    ? Math.round((o.wellbeingHoursPerDay as number) * 60) : p.wellbeingMinutesPerDay;

  // Prefer the parts over the stated total: the parts are what the person actually does, and where
  // the two disagree the stated total is the number that has been drifting.
  const derived = (project != null && wellbeing != null && days != null) ? (project + wellbeing) * days : null;
  const stated = num(o.hoursPerWeek) != null ? Math.round((o.hoursPerWeek as number) * 60) : null;
  const total = derived ?? stated ?? p.totalMinutesPerWeek;

  const next: EngagementPolicy = {
    ...p,
    daysPerWeek: days,
    restDaysPerWeek: days != null ? Math.max(1, 7 - days) : p.restDaysPerWeek,
    projectMinutesPerDay: project,
    wellbeingMinutesPerDay: wellbeing,
    totalMinutesPerWeek: total,
    durationWeeks: num(o.durationWeeks) ?? p.durationWeeks,
    headline: '',
  };
  const resolved: EngagementPolicy = { ...next, headline: describeCommitment(next) };
  return withinStatutoryCeiling(resolved) ? resolved : p;
}

/**
 * Invariant check over the whole table. Returns the list of violations, empty when the model is
 * sound. Exported so it can be asserted from a test runner or an ops screen without this file
 * having to import one.
 */
export function auditEngagementPolicies(): string[] {
  const errs: string[] = [];
  for (const level of ENGAGEMENT_LEVEL_ORDER) {
    const p = ENGAGEMENT_POLICIES[level];
    if (!withinStatutoryCeiling(p)) errs.push(level + ': exceeds the statutory working-time ceiling');
    if (p.restDaysPerWeek < 1) errs.push(level + ': no weekly rest day');
    if (p.timeModel === 'counted') {
      if (p.projectMinutesPerDay == null || p.wellbeingMinutesPerDay == null) {
        errs.push(level + ': counted hours with no project/well-being split');
      } else if (p.daysPerWeek != null && p.totalMinutesPerWeek != null
        && (p.projectMinutesPerDay + p.wellbeingMinutesPerDay) * p.daysPerWeek !== p.totalMinutesPerWeek) {
        errs.push(level + ': the daily split does not add up to the stated weekly total');
      }
      if (!/project work/i.test(describeCommitment(p))) errs.push(level + ': total shown without its split');
    }
    if (p.timeModel === 'accountable' && p.totalMinutesPerWeek != null) {
      errs.push(level + ': an accountability-based role must not state counted hours');
    }
  }
  return errs;
}

/* -------------------------------------------------------------------------------- derivations */

const round1 = (n: number) => Math.round(n * 10) / 10;

export function hoursPerWeek(p: EngagementPolicy): number | null {
  return p.totalMinutesPerWeek == null ? null : round1(p.totalMinutesPerWeek / 60);
}
export function projectHoursPerDay(p: EngagementPolicy): number | null {
  return p.projectMinutesPerDay == null ? null : round1(p.projectMinutesPerDay / 60);
}
export function wellbeingHoursPerDay(p: EngagementPolicy): number | null {
  return p.wellbeingMinutesPerDay == null ? null : round1(p.wellbeingMinutesPerDay / 60);
}
export function projectMinutesPerWeek(p: EngagementPolicy): number | null {
  return p.projectMinutesPerDay == null || p.daysPerWeek == null ? null : p.projectMinutesPerDay * p.daysPerWeek;
}
export function wellbeingMinutesPerWeek(p: EngagementPolicy): number | null {
  return p.wellbeingMinutesPerDay == null || p.daysPerWeek == null ? null : p.wellbeingMinutesPerDay * p.daysPerWeek;
}

/** Total engagement hours across the whole programme. Only meaningful for fixed-term levels. */
export function totalEngagementHours(p: EngagementPolicy): number | null {
  if (p.totalMinutesPerWeek == null || p.durationWeeks == null) return null;
  return round1((p.totalMinutesPerWeek * p.durationWeeks) / 60);
}
export function totalProjectHours(p: EngagementPolicy): number | null {
  const w = projectMinutesPerWeek(p);
  return w == null || p.durationWeeks == null ? null : round1((w * p.durationWeeks) / 60);
}
export function totalWellbeingHours(p: EngagementPolicy): number | null {
  const w = wellbeingMinutesPerWeek(p);
  return w == null || p.durationWeeks == null ? null : round1((w * p.durationWeeks) / 60);
}

/** Approximate AICTE credit equivalent, at a minimum of 45 hours of work per credit. */
export function aicteCreditEquivalent(p: EngagementPolicy): number | null {
  const total = totalEngagementHours(p);
  return total == null ? null : round1(total / AICTE_HOURS_PER_CREDIT);
}

/** Guard: nothing in this file may exceed the statutory ceiling. Used by the tests. */
export function withinStatutoryCeiling(p: EngagementPolicy): boolean {
  if (p.totalMinutesPerWeek == null) return true;
  if (p.totalMinutesPerWeek / 60 > STATUTORY.maxHoursPerWeek) return false;
  if (p.daysPerWeek == null) return true;
  if (p.restDaysPerWeek < 1) return false;
  return (p.totalMinutesPerWeek / p.daysPerWeek) / 60 <= STATUTORY.maxHoursPerDay;
}

/* --------------------------------------------------------------------------------- formatting */

/** 100 -> "1 hour 40 minutes". 300 -> "5 hours". 30 -> "30 minutes". */
export function formatMinutes(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  const hPart = h ? h + (h === 1 ? ' hour' : ' hours') : '';
  const mPart = m ? m + (m === 1 ? ' minute' : ' minutes') : '';
  return hPart && mPart ? hPart + ' ' + mPart : (hPart || mPart);
}

/** 100 -> "1h 40m". For dense tiles and tables. */
export function formatMinutesShort(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h && m ? h + 'h ' + m + 'm' : (h ? h + 'h' : m + 'm');
}

/**
 * THE ONE LINE ANYWHERE HOURS ARE SHOWN.
 *
 * For a counted engagement it is physically incapable of returning the total on its own: the
 * split is concatenated in the same expression. That is the whole point. Everywhere else it
 * returns the honest description of how that level's time actually works, which for a Chief
 * Officer is "no fixed daily or weekly hours" and not a number.
 */
export function describeCommitment(p: EngagementPolicy): string {
  if (p.timeModel === 'counted') {
    const total = hoursPerWeek(p);
    return p.daysPerWeek + ' days a week, about ' + total + ' hours of total engagement — '
      + formatMinutes(p.projectMinutesPerDay) + ' a day of project work and departmental responsibilities, plus '
      + formatMinutes(p.wellbeingMinutesPerDay) + ' a day of holistic well-being and personal development.';
  }
  if (p.timeModel === 'scheduled') {
    const perDay = p.projectMinutesPerDay;
    return p.daysPerWeek + ' days a week, ' + formatMinutes(perDay) + ' a day ('
      + hoursPerWeek(p) + ' hours a week), with ' + p.restDaysPerWeek + ' full rest days.';
  }
  if (p.timeModel === 'core-hours') {
    return 'No counted hours. ' + p.daysPerWeek + ' days a week with a '
      + formatMinutes(p.coreOverlapMinutes) + ' overlap window, measured on agreed objectives.';
  }
  return 'No fixed daily or weekly hours. Accountability for outcomes, with a weekly rest day.';
}

/** Compact form for a "Working Hours" field in a summary table or an offer letter. */
export function shortCommitment(p: EngagementPolicy): string {
  if (p.timeModel === 'counted') {
    return p.daysPerWeek + ' days/week, ~' + hoursPerWeek(p) + ' h total engagement ('
      + formatMinutesShort(p.projectMinutesPerDay) + ' project + '
      + formatMinutesShort(p.wellbeingMinutesPerDay) + ' well-being per day)';
  }
  if (p.timeModel === 'scheduled') {
    return p.daysPerWeek + ' days/week, ' + formatMinutesShort(p.projectMinutesPerDay) + '/day';
  }
  if (p.timeModel === 'core-hours') {
    return 'Not hour-counted; ' + formatMinutesShort(p.coreOverlapMinutes) + ' daily overlap';
  }
  return 'Not hour-counted; outcome and accountability based';
}

/** The programme total, spelled out with its split. Empty string for permanent roles. */
export function describeProgrammeTotal(p: EngagementPolicy): string {
  const total = totalEngagementHours(p);
  if (total == null || p.durationWeeks == null) return '';
  const proj = totalProjectHours(p);
  const well = totalWellbeingHours(p);
  const base = 'About ' + total + ' hours of total engagement over ' + p.durationWeeks + ' weeks';
  if (proj == null || well == null) return base + '.';
  return base + ' — ' + proj + ' hours of project work and ' + well + ' hours of well-being and personal development.';
}

/**
 * The engagement-terms sentence for an offer letter. Deliberately takes the agreed fields, because
 * the fields are what was actually negotiated; the policy supplies the working-time language only
 * where the letter has none of its own.
 */
export function offerEngagementSentence(
  p: EngagementPolicy,
  agreed: { workMode?: string | null; duration?: string | null; hoursCommitment?: string | null } = {},
): string {
  // Defaults to on site, never remote. An offer letter saved before the work-mode policy existed
  // has no agreed mode at all, and this line used to fill that gap with "Remote" -- putting a
  // promise of remote work into a letter nobody had agreed to. See src/lib/work-mode.ts.
  const mode = (agreed.workMode || '').trim() || 'On-Site';
  const term = (agreed.duration || '').trim()
    || (p.durationWeeks ? p.durationWeeks + ' weeks' : 'the agreed term');
  const hours = (agreed.hoursCommitment || '').trim() || describeCommitment(p);
  if (p.timeModel === 'accountable') {
    return 'You will work ' + mode + ', for ' + term + '. ' + p.headline;
  }
  if (p.timeModel === 'core-hours') {
    return 'You will work ' + mode + ', for ' + term + '. ' + p.headline;
  }
  return 'You will work ' + mode + ', for ' + term + '. Working time: ' + hours;
}

/** schema.org JobPosting `workHours`. Never emits a bare total for a counted engagement. */
export function jobPostingWorkHours(p: EngagementPolicy): string {
  if (p.timeModel === 'counted') {
    return p.daysPerWeek + ' days per week; approximately ' + hoursPerWeek(p)
      + ' hours per week of total engagement, comprising ' + formatMinutes(p.projectMinutesPerDay)
      + ' per day of project work and ' + formatMinutes(p.wellbeingMinutesPerDay)
      + ' per day of well-being and personal development';
  }
  if (p.timeModel === 'scheduled') {
    return p.daysPerWeek + ' days per week, ' + formatMinutes(p.projectMinutesPerDay) + ' per day';
  }
  if (p.timeModel === 'core-hours') {
    return 'No fixed daily hours; ' + formatMinutes(p.coreOverlapMinutes)
      + ' of daily overlap with the team, measured on agreed objectives';
  }
  return 'No fixed hours; the role is accountability and outcome based';
}

/**
 * Tiles for a terms panel. Returns only what the level actually has, so a Director's page shows
 * three honest rows instead of four rows of "N/A".
 */
export function commitmentFacts(p: EngagementPolicy): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  if (p.daysPerWeek != null) out.push({ k: 'Working days', v: p.daysPerWeek + ' per week' });
  out.push({ k: 'Rest days', v: p.restDaysPerWeek + ' per week' });
  if (p.timeModel === 'counted') {
    out.push({ k: 'Total engagement', v: '~' + hoursPerWeek(p) + ' hrs/week' });
    out.push({ k: 'Project work', v: formatMinutesShort(p.projectMinutesPerDay) + ' per day' });
    out.push({ k: 'Well-being', v: formatMinutesShort(p.wellbeingMinutesPerDay) + ' per day' });
    if (p.durationWeeks) out.push({ k: 'Duration', v: p.durationWeeks + ' weeks' });
  } else if (p.timeModel === 'scheduled') {
    out.push({ k: 'Scheduled week', v: hoursPerWeek(p) + ' hrs' });
    out.push({ k: 'Per day', v: formatMinutesShort(p.projectMinutesPerDay) });
  } else if (p.timeModel === 'core-hours') {
    out.push({ k: 'Hours counted', v: 'No' });
    out.push({ k: 'Daily overlap', v: formatMinutesShort(p.coreOverlapMinutes) });
  } else {
    out.push({ k: 'Hours counted', v: 'No' });
    out.push({ k: 'Basis', v: 'Outcome and accountability' });
  }
  return out;
}

/**
 * WHAT THE WELL-BEING TIME IS, said once, without reference to anyone's faith.
 *
 * The founder's invitation to a personal practice is warm and it is his to make. What is ASSESSED
 * has to be describable in these terms and no others, because an eligibility criterion that names
 * a specific religious observance is a hiring condition on religion. India's private sector has no
 * statutory bar on that, but EduRankAI hires internationally and those jurisdictions do — and
 * quite apart from statute, a candidate of another faith reading a named devotional text in the
 * assessed section of their offer learns something untrue about whether the role is open to them.
 */
export const WELLBEING_ASSESSED_AS =
  'What is looked at is that the time is genuinely taken and that you can speak to what it did for your work — movement, stillness, rest and reading. The form it takes is yours, and no particular practice, tradition or belief is required, recorded or assessed.';
