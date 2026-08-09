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

/**
 * WHERE A DAY'S HOURS CAME FROM. Added so a number can say what KIND of number it is.
 *
 *   'clock'      measured from a real clock-in and clock-out, net of recorded breaks. The only
 *                source automatic credit accepts without a human being involved.
 *   'recorded'   an hours figure entered against the day (the HR grid, an approved correction).
 *                Real, but asserted by a person rather than measured by a clock.
 *   'incomplete' clocked in, never clocked out. THE HOURS ARE UNKNOWN — not zero, not a full day.
 *   'none'       nothing was measured and nothing was entered.
 */
export type HoursSource = 'clock' | 'recorded' | 'incomplete' | 'none';

export interface AttendanceDay {
  date: string;              // ISO yyyy-mm-dd
  status: DayStatus;
  /**
   * The hours actually recorded for this day. ABSENT MEANS UNMEASURED, and it is credited as
   * NOTHING — see the note on summarise(). It used to fall back to the expected daily figure, which
   * is how a day somebody ticked in a grid became eight hours on a completion letter.
   */
  hours?: number;
  noticeGivenAt?: string | null;  // when leave was notified — absent means no notice
  /**
   * WHAT KIND OF NUMBER `hours` IS. Optional, so every existing caller keeps compiling: absent
   * reads as 'recorded' when hours are present and 'none' when they are not, which is exactly what
   * those callers already meant.
   *
   * 'incomplete' is the one that changes an outcome. A day clocked in and never clocked out has
   * UNKNOWN hours — not zero, and certainly not a full day — and it blocks automatic credit in
   * src/lib/credit-week.ts, which is what the human override there exists for.
   */
  hoursSource?: HoursSource;
}

export interface EngagementTerms {
  kind: EngagementKind;
  /** Contracted hours per week. Full-time defaults to 40; part-time must state its own. */
  weeklyHours?: number;
  /**
   * Whether `weeklyHours` was READ OFF A RECORD or filled in by the full-time default.
   *
   * The default is a fair basis for an EXPECTATION and it is a fiction as a statement of contract.
   * Nothing in this file behaves differently on it — it exists so a screen can say "40 assumed,
   * not recorded" instead of printing 40 as though somebody agreed to it.
   */
  weeklyHoursRecorded?: boolean;
  workingDaysPerWeek?: number;   // 5 unless agreed otherwise
  /** Total credit-hours the programme requires, e.g. 480 for a 12-week full-time internship. */
  requiredCreditHours?: number;
}

/**
 * The contracted week, or 0 when nobody recorded one.
 *
 * FULL-TIME NO LONGER MEANS 40 BY DEFAULT, and removing that is the second half of this correction.
 * The line was `t.weeklyHours || FULL_TIME_WEEKLY_HOURS`, so an engagement whose weekly hours had
 * never been recorded was measured against a full-time week nobody had agreed to — and because
 * hr_employees.engagement_kind itself defaults to 'full-time', that reached EVERY employee with an
 * unset row. Part-time was already required to be explicit for exactly this reason; the asymmetry
 * was the defect, not the rule. Flagging the assumption is not enough: a flag no screen reads is
 * still a 40 on a completion letter.
 *
 * 0 MEANS UNKNOWN, NOT ZERO HOURS. Ask weeklyHoursKnown() rather than rendering the 0. Where the
 * figure properly comes from a published policy rather than a per-person contract — an internship
 * is 40 hours because the internship policy says so — resolve it in src/lib/engagement-policy.ts
 * and pass it in as weeklyHours. This function reports what was agreed; it does not invent it.
 */
export function weeklyHoursFor(t: EngagementTerms): number {
  const h = Number(t.weeklyHours);
  if (!Number.isFinite(h) || h <= 0) return 0;
  // Neither kind may exceed a full-time week: a stored 60 is a data-entry error, not a contract.
  return Math.min(h, FULL_TIME_WEEKLY_HOURS);
}

/** True when a weekly load was actually recorded. False means "we do not know", never "zero". */
export function weeklyHoursKnown(t: EngagementTerms): boolean {
  return weeklyHoursFor(t) > 0;
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
  /**
   * DAYS MARKED PRESENT (or half) WITH NO HOURS RECORDED AGAINST THEM.
   *
   * These credit NOTHING and still count toward the expectation, so the attendance figure shows the
   * gap rather than hiding it. THIS IS THE DEFECT THIS FIELD EXISTS TO MAKE VISIBLE: a day with no
   * recorded hours used to be credited the expected daily figure — eight hours for a full-time
   * intern — so ticking a box in the HR grid produced credit-hours nobody worked, on the document
   * a person shows a university. They are counted and named here instead.
   */
  unmeasuredDays: number;
  /** The dates of those days, so a screen can name them rather than only count them. */
  unmeasuredDates: string[];
  /** Days that carried a real recorded figure. The only days that contributed credit. */
  measuredDays: number;
  /**
   * DAYS CLOCKED IN AND NEVER CLOCKED OUT. A subset of unmeasuredDays, separated because it is a
   * DIFFERENT FACT: nobody forgot to record this day, somebody started it and the clock never
   * stopped. It credits nothing, and downstream it is the single most common reason a week cannot
   * be credited automatically.
   */
  incompleteDays: number;
  /**
   * FALSE means no weekly load was recorded, so `expectedHours` and `attendancePct` are 0 for want
   * of a denominator rather than because nothing was expected. A screen must say "not recorded"
   * here; printing "0%" against somebody whose contract was never entered is a statement about
   * them that the data does not support.
   */
  expectationKnown: boolean;
  /** Credit that came off a real clock rather than an entered figure. Never more than creditHours. */
  clockMeasuredHours: number;
  requiredCreditHours: number | null;
  completionPct: number | null; // against the requirement, when one is set
  shortfallHours: number | null;
}

/**
 * Turn a set of attendance days into credit.
 *
 * Rules, each deliberate:
 *  - present      credits the RECORDED hours and nothing else. A day with no recorded hours credits
 *                 ZERO, is counted in `unmeasuredDays` and is still expected — because "somebody
 *                 ticked this day" is not a measurement of anything. This used to credit the
 *                 expected daily figure, which invented eight hours per ticked box.
 *  - half-day     credits the recorded hours capped at half a day, and expects half. An unrecorded
 *                 half-day credits zero, for the same reason.
 *  - authorised   no credit AND no expectation — agreed leave must not dent the attendance figure
 *  - unauthorised no credit, expectation stands — this is what makes the notice rule mean something
 *  - holiday      neither credited nor expected
 *  - not-started  ignored entirely, so a future-dated engagement does not read as 0%
 */
export function summarise(days: AttendanceDay[], terms: EngagementTerms): CreditSummary {
  const perDay = expectedDailyHours(terms);
  // An expectation exists only where a weekly load was recorded. With none, perDay is 0 and the cap
  // below must NOT be applied — capping real measured hours at zero would turn a missing contract
  // into a missing day's work, which is the same class of error in the opposite direction.
  const known = perDay > 0;
  const s: CreditSummary = {
    creditHours: 0, expectedHours: 0, attendancePct: 0,
    daysPresent: 0, daysHalf: 0, authorisedLeaveDays: 0, unauthorisedLeaveDays: 0,
    holidays: 0, noticeBreaches: 0,
    unmeasuredDays: 0, unmeasuredDates: [], measuredDays: 0,
    incompleteDays: 0, expectationKnown: known, clockMeasuredHours: 0,
    requiredCreditHours: terms.requiredCreditHours ?? null,
    completionPct: null, shortfallHours: null,
  };

  for (const d of days) {
    // An incomplete day is UNKNOWN, so whatever partial figure is attached to it is not a
    // measurement and must not be credited. 'none' is the same answer for a different reason.
    const src: HoursSource = d.hoursSource || (typeof d.hours === 'number' && d.hours > 0 ? 'recorded' : 'none');
    const usable = src !== 'incomplete' && src !== 'none' && typeof d.hours === 'number' && d.hours > 0;

    switch (d.status) {
      case 'present': {
        // Cap at the expected day so an over-long day cannot inflate credit; the letter should
        // reflect the agreed engagement, not heroics. NO MEASURED FIGURE CREDITS NOTHING.
        const h = usable ? (known ? Math.min(d.hours as number, perDay) : (d.hours as number)) : 0;
        s.creditHours += h;
        if (src === 'clock') s.clockMeasuredHours += h;
        s.expectedHours += perDay;
        s.daysPresent++;
        if (usable) s.measuredDays++;
        else {
          s.unmeasuredDays++;
          s.unmeasuredDates.push(d.date);
          if (src === 'incomplete') s.incompleteDays++;
        }
        break;
      }
      case 'half-day': {
        const cap = perDay / 2;
        const h = usable ? (known ? Math.min(d.hours as number, cap) : (d.hours as number)) : 0;
        s.creditHours += h;
        if (src === 'clock') s.clockMeasuredHours += h;
        s.expectedHours += cap;
        s.daysHalf++;
        if (usable) s.measuredDays++;
        else {
          s.unmeasuredDays++;
          s.unmeasuredDates.push(d.date);
          if (src === 'incomplete') s.incompleteDays++;
        }
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
  s.clockMeasuredHours = round2(s.clockMeasuredHours);
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
 * ONE SENTENCE NAMING EVERYTHING THE FIGURES COULD NOT ESTABLISH, or null when nothing is missing.
 *
 * Exported because a completion letter must be able to print it. A document that states hours and
 * says nothing about the days those hours could not be measured on is precisely the document this
 * change exists to stop producing — and /admin/hr/completion/[id] is where it goes to an accredited
 * partner.
 */
export function measurementCaveat(s: CreditSummary): string | null {
  const parts: string[] = [];
  if (!s.expectationKnown) {
    parts.push('no weekly hours are recorded for this engagement, so there is nothing to measure the total against');
  }
  if (s.incompleteDays > 0) {
    parts.push(s.incompleteDays + ' day(s) were clocked in and never clocked out, so those hours are unknown');
  }
  const plainlyUnrecorded = s.unmeasuredDays - s.incompleteDays;
  if (plainlyUnrecorded > 0) {
    parts.push(plainlyUnrecorded + ' day(s) marked worked carry no recorded hours and earned none');
  }
  if (!parts.length) return null;
  return 'Measurement gaps: ' + parts.join('; ') + '.';
}

/**
 * The figures a completion letter and offboarding report state.
 *
 * `eligible` is a factual check against the requirement, not a judgement — it says whether the
 * hours were completed. Whether to issue anyway is a human decision, so the reason is spelled out
 * rather than the caller being handed a bare boolean.
 *
 * `caveat` IS NOT OPTIONAL TO RENDER. It is additive to the return type so nothing breaks, but a
 * letter that prints creditHours and drops the caveat is back where this started. See
 * measurementCaveat().
 */
export function completionFigures(rec: CompletionRecord): {
  creditHours: number;
  attendancePct: number;
  averageRating: number | null;
  reviewCount: number;
  achievements: string[];
  eligible: boolean;
  reason: string;
  caveat: string | null;
  expectationKnown: boolean;
  unmeasuredDays: number;
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
    caveat: measurementCaveat(rec.summary),
    expectationKnown: rec.summary.expectationKnown,
    unmeasuredDays: rec.summary.unmeasuredDays,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
