// src/lib/credit-hours.ts — how engagement turns into credit, and what the completion letter says.
//
// THE UNIT. One credit-hour is one hour of verified engagement. A full-time intern is expected to
// put in 40 hours a week, so a full-time week is worth 40 credit-hours. Part-time is pro-rata
// against the same 40: someone at 20 hours a week accrues at half the rate and must run
// proportionally longer to reach the same total. Nobody is credited for hours they did not do, and
// nobody is penalised for an arrangement that was agreed.
//
// WHY THIS IS PURE. These numbers end up on a completion letter and an offboarding report, which
// people show to universities and employers. Getting them wrong is not a UI bug — it is a
// misstatement about someone's work. So the arithmetic lives here, with tests, separate from any
// page or query.
//
// LEAVE. Prior notice is mandatory. Leave taken WITH notice is authorised: the day is excused, no
// credit accrues for it, and the expected total drops accordingly, so it does not damage the
// attendance figure. Leave taken WITHOUT notice is unauthorised: no credit, and the expectation
// stands, so it shows up honestly. That distinction is the whole point of requiring notice, and it
// is deliberately visible rather than folded into one number.

export type EngagementKind = 'full-time' | 'part-time';
export type DayStatus = 'present' | 'half-day' | 'authorised-leave' | 'unauthorised-leave' | 'holiday' | 'not-started';

/** A full-time week, and the basis every part-time arrangement is measured against. */
export const FULL_TIME_WEEKLY_HOURS = 40;

export interface AttendanceDay {
  date: string;              // ISO yyyy-mm-dd
  status: DayStatus;
  hours?: number;            // actual verified hours; falls back to the expected daily figure
  noticeGivenAt?: string | null;  // when leave was notified — absent means no notice
}

export interface EngagementTerms {
  kind: EngagementKind;
  /** Contracted hours per week. Full-time defaults to 40; part-time must state its own. */
  weeklyHours?: number;
  workingDaysPerWeek?: number;   // 5 unless agreed otherwise
  /** Total credit-hours the programme requires, e.g. 480 for a 12-week full-time internship. */
  requiredCreditHours?: number;
}

export function weeklyHoursFor(t: EngagementTerms): number {
  if (t.kind === 'full-time') return t.weeklyHours || FULL_TIME_WEEKLY_HOURS;
  // Part-time must be explicit. Guessing here would silently invent someone's contract.
  const h = Number(t.weeklyHours);
  return Number.isFinite(h) && h > 0 ? Math.min(h, FULL_TIME_WEEKLY_HOURS) : 0;
}

/** The fraction of a full-time load. 0.5 for a 20-hour week. Used for pro-rata expectations. */
export function loadFraction(t: EngagementTerms): number {
  const w = weeklyHoursFor(t);
  return w > 0 ? w / FULL_TIME_WEEKLY_HOURS : 0;
}

export function expectedDailyHours(t: EngagementTerms): number {
  const days = t.workingDaysPerWeek && t.workingDaysPerWeek > 0 ? t.workingDaysPerWeek : 5;
  const w = weeklyHoursFor(t);
  return w > 0 ? w / days : 0;
}

export interface CreditSummary {
  creditHours: number;          // earned
  expectedHours: number;        // what was expected across the days counted
  attendancePct: number;        // earned / expected, 0 when nothing was expected
  daysPresent: number;
  daysHalf: number;
  authorisedLeaveDays: number;
  unauthorisedLeaveDays: number;
  holidays: number;
  /** Days of leave taken without the required prior notice — surfaced, never silently absorbed. */
  noticeBreaches: number;
  requiredCreditHours: number | null;
  completionPct: number | null; // against the requirement, when one is set
  shortfallHours: number | null;
}

/**
 * Turn a set of attendance days into credit.
 *
 * Rules, each deliberate:
 *  - present      credits the verified hours, or the expected daily figure when none were recorded
 *  - half-day     credits half, and expects half
 *  - authorised   no credit AND no expectation — agreed leave must not dent the attendance figure
 *  - unauthorised no credit, expectation stands — this is what makes the notice rule mean something
 *  - holiday      neither credited nor expected
 *  - not-started  ignored entirely, so a future-dated engagement does not read as 0%
 */
export function summarise(days: AttendanceDay[], terms: EngagementTerms): CreditSummary {
  const perDay = expectedDailyHours(terms);
  const s: CreditSummary = {
    creditHours: 0, expectedHours: 0, attendancePct: 0,
    daysPresent: 0, daysHalf: 0, authorisedLeaveDays: 0, unauthorisedLeaveDays: 0,
    holidays: 0, noticeBreaches: 0,
    requiredCreditHours: terms.requiredCreditHours ?? null,
    completionPct: null, shortfallHours: null,
  };

  for (const d of days) {
    switch (d.status) {
      case 'present': {
        // Cap at the expected day so an over-long day cannot inflate credit; the letter should
        // reflect the agreed engagement, not heroics.
        const h = typeof d.hours === 'number' && d.hours >= 0 ? Math.min(d.hours, perDay) : perDay;
        s.creditHours += h;
        s.expectedHours += perDay;
        s.daysPresent++;
        break;
      }
      case 'half-day': {
        const h = typeof d.hours === 'number' && d.hours >= 0 ? Math.min(d.hours, perDay / 2) : perDay / 2;
        s.creditHours += h;
        s.expectedHours += perDay / 2;
        s.daysHalf++;
        break;
      }
      case 'authorised-leave':
        s.authorisedLeaveDays++;
        if (!d.noticeGivenAt) s.noticeBreaches++;   // marked authorised but no notice recorded
        break;
      case 'unauthorised-leave':
        s.expectedHours += perDay;
        s.unauthorisedLeaveDays++;
        s.noticeBreaches++;
        break;
      case 'holiday':
        s.holidays++;
        break;
      case 'not-started':
      default:
        break;
    }
  }

  s.creditHours = round2(s.creditHours);
  s.expectedHours = round2(s.expectedHours);
  s.attendancePct = s.expectedHours > 0 ? round2((s.creditHours / s.expectedHours) * 100) : 0;

  if (terms.requiredCreditHours && terms.requiredCreditHours > 0) {
    s.completionPct = round2((s.creditHours / terms.requiredCreditHours) * 100);
    s.shortfallHours = round2(Math.max(0, terms.requiredCreditHours - s.creditHours));
  }
  return s;
}

/**
 * Weeks still needed to reach the requirement at the current load.
 *
 * This is why part-time must "complete accordingly": the requirement is a number of credit-hours,
 * not a duration, so a half-load simply takes twice as long rather than earning half a certificate.
 */
export function remainingWeeks(s: CreditSummary, terms: EngagementTerms): number | null {
  if (!s.shortfallHours || s.shortfallHours <= 0) return s.shortfallHours === 0 ? 0 : null;
  const w = weeklyHoursFor(terms);
  return w > 0 ? Math.ceil(s.shortfallHours / w) : null;
}

export interface ReviewEntry {
  date: string;
  reviewer: string;
  rating?: number | null;      // 1-5 where used
  note: string;
}

export interface CompletionRecord {
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  terms: EngagementTerms;
  summary: CreditSummary;
  reviews: ReviewEntry[];
  achievements: string[];
}

/**
 * The figures a completion letter and offboarding report state.
 *
 * `eligible` is a factual check against the requirement, not a judgement — it says whether the
 * hours were completed. Whether to issue anyway is a human decision, so the reason is spelled out
 * rather than the caller being handed a bare boolean.
 */
export function completionFigures(rec: CompletionRecord): {
  creditHours: number;
  attendancePct: number;
  averageRating: number | null;
  reviewCount: number;
  achievements: string[];
  eligible: boolean;
  reason: string;
} {
  const rated = rec.reviews.filter((r) => typeof r.rating === 'number' && r.rating! > 0);
  const averageRating = rated.length
    ? round2(rated.reduce((a, r) => a + (r.rating || 0), 0) / rated.length)
    : null;

  const req = rec.summary.requiredCreditHours;
  const met = !req || rec.summary.creditHours >= req;
  const reason = !req
    ? 'No credit-hour requirement was set for this engagement.'
    : met
      ? `Completed ${rec.summary.creditHours} of ${req} required credit-hours.`
      : `${rec.summary.shortfallHours} credit-hour(s) short of the ${req} required.`;

  return {
    creditHours: rec.summary.creditHours,
    attendancePct: rec.summary.attendancePct,
    averageRating,
    reviewCount: rec.reviews.length,
    achievements: rec.achievements.filter((a) => a && a.trim()),
    eligible: met,
    reason,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
