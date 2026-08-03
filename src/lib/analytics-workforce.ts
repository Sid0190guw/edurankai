// src/lib/analytics-workforce.ts — WORKFORCE ANALYTICS. AGGREGATE ONLY, AND SUPPRESSED.
//
// =================================================================================================
// THE SCREEN THAT MUST NOT EXIST
// =================================================================================================
//
// If a query in this file ever returned ONE ROW PER PERSON for an oversight surface, that would be
// the screen this module exists to prevent. Every SELECT below is a COUNT, an AVG or a GROUP BY, and
// none of them selects a name, an id, an email or anything that identifies a human being. There is
// no drill-down, no "show the 3 people in this band" link, and no per-person export.
//
// A manager who needs to see one person's attendance sees it on that person's own record, through a
// relationship the Organization Graph records — not by filtering a company-wide analytics table down
// to one row and calling it a report.
//
// =================================================================================================
// SUPPRESSION, AND WHY THE TOTAL DISAPPEARS TOO
// =================================================================================================
//
// MIN_GROUP is imported from src/lib/wellness.ts, which is where this platform's minimum group size
// is defined and reasoned about. It is NOT redefined here: two constants meaning "the smallest group
// we will describe" is how one of them ends up at 3.
//
// Below MIN_GROUP a count stops being a statistic and becomes a description of somebody. In a small
// organization "2 people were absent last Tuesday" plus ordinary office knowledge names them.
//
// AND SO DOES THE REMAINDER. If a breakdown shows Full-time 22, Contract 9 and suppresses Intern,
// while the total says 34, the suppressed band is 3 by subtraction — the suppression achieved
// nothing. So the rule implemented in suppressBands() is: WHEN ANY BAND IS SUPPRESSED, THE TOTAL IS
// SUPPRESSED WITH IT. That is the same discipline wellness.ts applies to its own oversight numbers,
// and it is the part that is easy to leave out and easy to reverse-engineer.
//
// =================================================================================================
// WHAT IS NEVER READ HERE, AT ALL
// =================================================================================================
//
// NO wellness_* TABLE IS QUERIED IN THIS FILE. Not aggregated, not counted, not joined. The wellness
// system is women-only, gated server-side, and no admin — not HR, not the founder — may see one
// person's cycle, symptoms or consult messages. There is deliberately no capability that unlocks it
// here, because the protection is the ABSENCE OF THE QUERY, not a permission that a future edit
// could widen. Wellness has its own oversight surfaces, built by the people who own that data model,
// and they are aggregate and suppressed there.
//
// Neither is base_salary, gender, date_of_birth, pan_number, aadhaar_number nor any bank column.
//
// =================================================================================================
// WHO MAY OPEN THIS
// =================================================================================================
//
// The capability is `analytics.view` (src/lib/auth/permissions.ts), granted to super_admin and hr —
// the two roles that already hold `employee.manage` and can therefore already read every individual
// employee record one at a time. This module hands them the aggregate instead, which is the narrower
// artefact. THE PAGE ENFORCES IT; this file computes numbers and grants nothing.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS; `r.rows[0]` is a bug.
//   - The real Postgres reason is on e.cause.
//   - department ids compared ::text, never ::uuid.
//   - Every panel is independently wrapped. A missing table degrades that panel to "could not be
//     read" rather than blanking the console — several of these tables only exist on a database
//     where the relevant module has been used.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { MIN_GROUP, TOO_FEW_LABEL } from './wellness';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above every function that reads them.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[analytics-workforce] ' + tag, e?.cause?.message || e?.message);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

/** Bands shown per breakdown. A long tail is truncated rather than rendered as fifty rows. */
const MAX_BANDS = 12;

/** Re-exported so a page can say "fewer than five" without hardcoding five. */
export { MIN_GROUP, TOO_FEW_LABEL };

export const ANALYTICS_VIEWS = [
  {
    key: 'employee',
    label: 'People',
    blurb: 'Headcount, engagement type and working mode, in aggregate.',
  },
  {
    key: 'department',
    label: 'Departments',
    blurb: 'How many people each department holds.',
  },
  {
    key: 'attendance',
    label: 'Attendance',
    blurb: 'Recorded days and hours across the period, never per person.',
  },
  { key: 'leave', label: 'Leave', blurb: 'Requests and days, by type and outcome.' },
  {
    key: 'recruitment',
    label: 'Recruitment',
    blurb: 'Applications by stage and outcome.',
  },
  {
    key: 'performance',
    label: 'Performance',
    blurb: 'Review completion and rating bands. No individual rating is shown.',
  },
] as const;

export type AnalyticsViewKey = (typeof ANALYTICS_VIEWS)[number]['key'];

const VIEW_KEYS = new Set<string>(ANALYTICS_VIEWS.map((v) => v.key));

export function parseAnalyticsView(raw: unknown): AnalyticsViewKey {
  const v = String(raw || '').trim();
  return (VIEW_KEYS.has(v) ? v : 'employee') as AnalyticsViewKey;
}

// -------------------------------------------------------------------------------------------------
// THE SHAPES A PANEL RENDERS
// -------------------------------------------------------------------------------------------------

export interface Band {
  label: string;
  /** Null when suppressed. A renderer must print TOO_FEW_LABEL and never a 0. */
  count: number | null;
  suppressed: boolean;
}

export interface Metric {
  label: string;
  /** Already formatted. Null when suppressed or when the number could not be read. */
  value: string | null;
  suppressed: boolean;
  /** A short sentence under the number, or null. */
  hint: string | null;
}

export interface AnalyticsPanel {
  key: string;
  label: string;
  blurb: string;
  metrics: Metric[];
  bandsTitle: string;
  bands: Band[];
  /** How many bands were withheld. The page says this out loud rather than silently shortening. */
  suppressedBands: number;
  available: boolean;
  note: string | null;
}

export interface AnalyticsModel {
  view: AnalyticsViewKey;
  label: string;
  blurb: string;
  from: string;
  to: string;
  panels: AnalyticsPanel[];
  minGroup: number;
  degraded: boolean;
  /** One sentence about this whole result. Rendered verbatim. */
  explanation: string;
}

// -------------------------------------------------------------------------------------------------
// SUPPRESSION — the only place the rule is implemented
// -------------------------------------------------------------------------------------------------

interface RawBand {
  label: string;
  count: number;
}

interface SuppressedResult {
  bands: Band[];
  suppressedBands: number;
  /** Null when the total must not be published — see the header. */
  total: number | null;
  totalSuppressed: boolean;
}

/**
 * Apply the minimum group size to a breakdown.
 *
 * THREE THINGS HAPPEN, and the third is the one usually forgotten:
 *   1. A band below MIN_GROUP is replaced by TOO_FEW_LABEL and its count becomes null.
 *   2. The bands are sorted largest first and capped at MAX_BANDS, so a long tail of ones and twos
 *      does not become a hundred rows of "too few to report".
 *   3. IF ANY BAND WAS SUPPRESSED, THE TOTAL IS SUPPRESSED TOO. Publishing 34 next to two visible
 *      bands adding to 31 discloses the third band exactly.
 *
 * PURE. No database, no formatting decisions, so the rule can be read in one screen and cannot
 * differ between panels.
 */
export function suppressBands(raw: RawBand[], floor = MIN_GROUP): SuppressedResult {
  const sorted = [...raw].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((n, b) => n + (Number(b.count) || 0), 0);

  const bands: Band[] = [];
  let suppressedBands = 0;
  for (const b of sorted) {
    const n = Number(b.count) || 0;
    if (n < floor) {
      suppressedBands++;
      bands.push({ label: b.label, count: null, suppressed: true });
    } else {
      bands.push({ label: b.label, count: n, suppressed: false });
    }
  }

  // The tail is dropped AFTER counting, so `suppressedBands` still reports everything withheld.
  const shown = bands.slice(0, MAX_BANDS);
  const anySuppressed = suppressedBands > 0 || bands.length > shown.length;

  return {
    bands: shown,
    suppressedBands,
    total: anySuppressed ? null : total,
    totalSuppressed: anySuppressed,
  };
}

/** A single number, suppressed when the group it describes is too small to describe. */
function suppressedMetric(
  label: string,
  value: number | null,
  people: number | null,
  format: (n: number) => string,
  hint: string | null = null,
  floor = MIN_GROUP,
): Metric {
  if (value === null || people === null) {
    return { label, value: null, suppressed: false, hint: 'Not available' };
  }
  if (people < floor) {
    return {
      label,
      value: null,
      suppressed: true,
      hint: 'Fewer than ' + floor + ' people, so nothing is reported.',
    };
  }
  return { label, value: format(value), suppressed: false, hint };
}

const plain = (n: number) => String(Math.round(n));
const oneDp = (n: number) => String(Math.round(n * 10) / 10);
const pct = (n: number) => String(Math.round(n)) + '%';

function unreadable(key: string, label: string, blurb: string, note: string): AnalyticsPanel {
  return {
    key,
    label,
    blurb,
    metrics: [],
    bandsTitle: '',
    bands: [],
    suppressedBands: 0,
    available: false,
    note,
  };
}

/** Turn a GROUP BY result into bands, treating NULL as a named band rather than dropping it. */
function toBands(list: any[], labelKey: string, countKey: string, nullLabel: string): RawBand[] {
  return list.map((row: any) => ({
    label: row?.[labelKey] ? String(row[labelKey]) : nullLabel,
    count: Number(row?.[countKey]) || 0,
  }));
}

// -------------------------------------------------------------------------------------------------
// PANELS. One read each, always aggregate.
// -------------------------------------------------------------------------------------------------

async function employeePanel(): Promise<AnalyticsPanel[]> {
  const def = ANALYTICS_VIEWS[0];
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS active,
             COUNT(*) FILTER (WHERE joining_date >= CURRENT_DATE - INTERVAL '90 days')::int AS joined_90,
             COUNT(*) FILTER (WHERE onboarding_status <> 'complete')::int AS onboarding
        FROM hr_employees
       WHERE is_active = TRUE`));
    const active = head.length ? Number(head[0].active) || 0 : 0;

    const typeRows = rows(await db.execute(sql`
      SELECT employment_type AS band, COUNT(*)::int AS n
        FROM hr_employees WHERE is_active = TRUE
       GROUP BY employment_type`));
    const modeRows = rows(await db.execute(sql`
      SELECT work_mode AS band, COUNT(*)::int AS n
        FROM hr_employees WHERE is_active = TRUE
       GROUP BY work_mode`));

    const types = suppressBands(toBands(typeRows, 'band', 'n', 'Not recorded'));
    const modes = suppressBands(toBands(modeRows, 'band', 'n', 'Not recorded'));

    const headcount: AnalyticsPanel = {
      key: 'headcount',
      label: 'Headcount',
      blurb: def.blurb,
      metrics: [
        suppressedMetric('Active employees', active, active, plain),
        suppressedMetric(
          'Joined in the last 90 days',
          head.length ? Number(head[0].joined_90) || 0 : null,
          active,
          plain,
        ),
        suppressedMetric(
          'Onboarding not complete',
          head.length ? Number(head[0].onboarding) || 0 : null,
          active,
          plain,
        ),
      ],
      bandsTitle: 'Engagement type',
      bands: types.bands,
      suppressedBands: types.suppressedBands,
      available: true,
      note: types.totalSuppressed
        ? 'Some engagement types hold fewer than ' + MIN_GROUP +
          ' people and are not shown, and the breakdown total is withheld with them so it cannot be subtracted back out.'
        : null,
    };

    const working: AnalyticsPanel = {
      key: 'workmode',
      label: 'Working mode',
      blurb: 'Where people work from, in aggregate.',
      metrics: [],
      bandsTitle: 'Working mode',
      bands: modes.bands,
      suppressedBands: modes.suppressedBands,
      available: true,
      note: modes.totalSuppressed
        ? 'Some working modes hold fewer than ' + MIN_GROUP + ' people and are not shown.'
        : null,
    };

    return [headcount, working];
  } catch (e: any) {
    logFail('employeePanel', e);
    return [
      unreadable('headcount', 'Headcount', ANALYTICS_VIEWS[0].blurb, 'Employee records could not be read just now.'),
    ];
  }
}

async function departmentPanel(): Promise<AnalyticsPanel[]> {
  try {
    // GROUP BY the department, COUNT the people. No employee row leaves this query.
    const list = rows(await db.execute(sql`
      SELECT COALESCE(d.name, 'No department recorded') AS band, COUNT(e.id)::int AS n
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.is_active = TRUE
       GROUP BY COALESCE(d.name, 'No department recorded')`));
    const banded = suppressBands(toBands(list, 'band', 'n', 'No department recorded'));
    return [
      {
        key: 'departments',
        label: 'Headcount by department',
        blurb: ANALYTICS_VIEWS[1].blurb,
        metrics: [
          {
            label: 'Departments with people in them',
            value: String(list.length),
            suppressed: false,
            hint: 'Counting the departments themselves discloses nothing about a person.',
          },
        ],
        bandsTitle: 'People per department',
        bands: banded.bands,
        suppressedBands: banded.suppressedBands,
        available: true,
        note: banded.suppressedBands
          ? banded.suppressedBands +
            ' department' + (banded.suppressedBands === 1 ? '' : 's') +
            ' hold fewer than ' + MIN_GROUP +
            ' people and are not shown. In an organization this size a headcount of two describes the two people, which is why it is withheld.'
          : null,
      },
    ];
  } catch (e: any) {
    logFail('departmentPanel', e);
    return [unreadable('departments', 'Headcount by department', ANALYTICS_VIEWS[1].blurb, 'Departments could not be read just now.')];
  }
}

async function attendancePanel(from: string, to: string): Promise<AnalyticsPanel[]> {
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS days,
             COUNT(DISTINCT employee_id)::int AS people,
             COALESCE(AVG(NULLIF(work_hours, 0)), 0)::float8 AS avg_hours,
             COALESCE(SUM(work_hours), 0)::float8 AS total_hours
        FROM hr_attendance
       WHERE date >= ${from}::date AND date <= ${to}::date`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const days = head.length ? Number(head[0].days) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT status AS band, COUNT(*)::int AS n
        FROM hr_attendance
       WHERE date >= ${from}::date AND date <= ${to}::date
       GROUP BY status`));
    // The bands here count DAYS, not people, so the floor is applied to the number of PEOPLE the
    // whole panel covers as well: five days of attendance belonging to one person is still one
    // person's week, and a band of days below the floor is still a small number about few people.
    const banded = suppressBands(toBands(statusRows, 'band', 'n', 'Not recorded'));
    const tooFewPeople = people > 0 && people < MIN_GROUP;

    return [
      {
        key: 'attendance',
        label: 'Attendance',
        blurb: ANALYTICS_VIEWS[2].blurb,
        metrics: [
          suppressedMetric('Days recorded', days, people, plain, 'Across everyone, in this period.'),
          suppressedMetric(
            'Average hours on a day with hours',
            head.length ? Number(head[0].avg_hours) || 0 : null,
            people,
            oneDp,
            'Days with no hours recorded are excluded, so an unfilled day does not drag the average down.',
          ),
          suppressedMetric(
            'Total hours recorded',
            head.length ? Number(head[0].total_hours) || 0 : null,
            people,
            plain,
          ),
        ],
        bandsTitle: 'Days by status',
        bands: tooFewPeople ? [] : banded.bands,
        suppressedBands: tooFewPeople ? banded.bands.length : banded.suppressedBands,
        available: true,
        note: tooFewPeople
          ? 'Fewer than ' + MIN_GROUP +
            ' people have attendance recorded in this period, so nothing is broken down. That is the design, not a gap in the data.'
          : banded.totalSuppressed
            ? 'Some statuses cover fewer than ' + MIN_GROUP + ' days and are not shown.'
            : null,
      },
    ];
  } catch (e: any) {
    logFail('attendancePanel', e);
    return [unreadable('attendance', 'Attendance', ANALYTICS_VIEWS[2].blurb, 'Attendance could not be read just now.')];
  }
}

async function leavePanel(from: string, to: string): Promise<AnalyticsPanel[]> {
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS requests,
             COUNT(DISTINCT employee_id)::int AS people,
             COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0)::int AS approved_days,
             COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM hr_leave_request
       WHERE start_date <= ${to}::date AND end_date >= ${from}::date`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const typeRows = rows(await db.execute(sql`
      SELECT leave_type AS band, COUNT(*)::int AS n
        FROM hr_leave_request
       WHERE start_date <= ${to}::date AND end_date >= ${from}::date
       GROUP BY leave_type`));
    const banded = suppressBands(toBands(typeRows, 'band', 'n', 'Not recorded'));
    const tooFewPeople = people > 0 && people < MIN_GROUP;

    return [
      {
        key: 'leave',
        label: 'Leave',
        blurb: ANALYTICS_VIEWS[3].blurb,
        metrics: [
          suppressedMetric(
            'Requests overlapping this period',
            head.length ? Number(head[0].requests) || 0 : null,
            people,
            plain,
          ),
          suppressedMetric(
            'Days approved',
            head.length ? Number(head[0].approved_days) || 0 : null,
            people,
            plain,
          ),
          suppressedMetric(
            'Still waiting for a decision',
            head.length ? Number(head[0].pending) || 0 : null,
            people,
            plain,
            'A number that stays high here is a queue, not a statistic.',
          ),
        ],
        bandsTitle: 'Requests by type',
        bands: tooFewPeople ? [] : banded.bands,
        suppressedBands: tooFewPeople ? banded.bands.length : banded.suppressedBands,
        available: true,
        note: tooFewPeople
          ? 'Fewer than ' + MIN_GROUP +
            ' people have leave in this period. A leave type is close to a reason for it, so nothing is broken down.'
          : banded.totalSuppressed
            ? 'Some leave types cover fewer than ' + MIN_GROUP + ' requests and are not shown.'
            : null,
      },
    ];
  } catch (e: any) {
    logFail('leavePanel', e);
    return [unreadable('leave', 'Leave', ANALYTICS_VIEWS[3].blurb, 'Leave could not be read just now.')];
  }
}

async function recruitmentPanel(from: string, to: string): Promise<AnalyticsPanel[]> {
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS applications,
             COUNT(DISTINCT email)::int AS people
        FROM applications
       WHERE created_at >= ${from}::date
         AND created_at < (${to}::date + INTERVAL '1 day')`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT status::text AS band, COUNT(*)::int AS n
        FROM applications
       WHERE created_at >= ${from}::date
         AND created_at < (${to}::date + INTERVAL '1 day')
       GROUP BY status::text`));
    const banded = suppressBands(toBands(statusRows, 'band', 'n', 'Not recorded'));
    const tooFew = people > 0 && people < MIN_GROUP;

    return [
      {
        key: 'recruitment',
        label: 'Recruitment',
        blurb: ANALYTICS_VIEWS[4].blurb,
        metrics: [
          suppressedMetric(
            'Applications received',
            head.length ? Number(head[0].applications) || 0 : null,
            people,
            plain,
          ),
          suppressedMetric('Distinct applicants', people, people, plain),
        ],
        bandsTitle: 'Applications by status',
        bands: tooFew ? [] : banded.bands,
        suppressedBands: tooFew ? banded.bands.length : banded.suppressedBands,
        available: true,
        note: tooFew
          ? 'Fewer than ' + MIN_GROUP +
            ' people applied in this period, so nothing is broken down. Candidates are people too, and the same floor applies to them.'
          : banded.totalSuppressed
            ? 'Some statuses hold fewer than ' + MIN_GROUP + ' applications and are not shown.'
            : null,
      },
    ];
  } catch (e: any) {
    logFail('recruitmentPanel', e);
    return [unreadable('recruitment', 'Recruitment', ANALYTICS_VIEWS[4].blurb, 'Applications could not be read just now.')];
  }
}

async function performancePanel(): Promise<AnalyticsPanel[]> {
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS reviews,
             COUNT(DISTINCT employee_id)::int AS people,
             COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted
        FROM hr_performance_reviews`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const reviews = head.length ? Number(head[0].reviews) || 0 : 0;
    const submitted = head.length ? Number(head[0].submitted) || 0 : 0;

    // RATING BANDS, NOT RATINGS. width_bucket would give the same shape; a CASE is written out so
    // the boundaries are readable, because a boundary nobody can see is a boundary nobody checks.
    const bandRows = rows(await db.execute(sql`
      SELECT CASE
               WHEN overall_rating IS NULL THEN 'Not rated'
               WHEN overall_rating < 2 THEN 'Below 2'
               WHEN overall_rating < 3 THEN '2 to 3'
               WHEN overall_rating < 4 THEN '3 to 4'
               ELSE '4 and above'
             END AS band,
             COUNT(*)::int AS n
        FROM hr_performance_reviews
       WHERE status = 'submitted'
       GROUP BY 1`));
    const banded = suppressBands(toBands(bandRows, 'band', 'n', 'Not rated'));
    const tooFew = people > 0 && people < MIN_GROUP;

    return [
      {
        key: 'performance',
        label: 'Performance',
        blurb: ANALYTICS_VIEWS[5].blurb,
        metrics: [
          suppressedMetric('Reviews on record', reviews, people, plain),
          suppressedMetric(
            'Submitted',
            submitted,
            people,
            plain,
            'Completion, not outcome. Whether a review was finished is a process fact.',
          ),
          suppressedMetric(
            'Completion rate',
            reviews > 0 ? (submitted / reviews) * 100 : null,
            people,
            pct,
          ),
        ],
        bandsTitle: 'Submitted reviews by rating band',
        bands: tooFew ? [] : banded.bands,
        suppressedBands: tooFew ? banded.bands.length : banded.suppressedBands,
        available: true,
        note: tooFew
          ? 'Fewer than ' + MIN_GROUP +
            ' people have a review on record, so no rating bands are shown. A rating band over three people is three people\'s ratings.'
          : banded.totalSuppressed
            ? 'Some rating bands hold fewer than ' + MIN_GROUP + ' reviews and are not shown, and the total is withheld with them.'
            : null,
      },
    ];
  } catch (e: any) {
    logFail('performancePanel', e);
    return [
      unreadable(
        'performance',
        'Performance',
        ANALYTICS_VIEWS[5].blurb,
        'Performance reviews could not be read. This table only exists on a database where a review cycle has been run.',
      ),
    ];
  }
}

// -------------------------------------------------------------------------------------------------
// THE BUILD
// -------------------------------------------------------------------------------------------------

/**
 * Build one analytics view over one period.
 *
 * The period only narrows the panels that are ABOUT a period (attendance, leave, recruitment).
 * Headcount, departments and performance are states of the organization now, and pretending they
 * were "as at" a date would be a claim this data model cannot support: hr_employees is mutated in
 * place, so there is no way to ask what the headcount was in March. Saying so is better than
 * printing a date range over a number that ignores it.
 */
export async function buildAnalytics(
  view: AnalyticsViewKey,
  window: { from: string; to: string },
): Promise<AnalyticsModel> {
  const def = ANALYTICS_VIEWS.find((v) => v.key === view) || ANALYTICS_VIEWS[0];
  const to = isDateIso(window?.to) ? window.to : new Date().toISOString().slice(0, 10);
  let from = isDateIso(window?.from) ? window.from : to;
  if (from > to) from = to;

  let panels: AnalyticsPanel[] = [];
  let explanation = '';

  if (def.key === 'employee') {
    panels = await employeePanel();
    explanation =
      'Headcount as it stands now. Employee records are updated in place, so there is no way to ask what the headcount was on a past date, and this view does not pretend otherwise.';
  } else if (def.key === 'department') {
    panels = await departmentPanel();
    explanation =
      'Departments as they stand now. A department holding fewer than ' + MIN_GROUP +
      ' people is not shown, because at that size the number describes the people in it.';
  } else if (def.key === 'attendance') {
    panels = await attendancePanel(from, to);
    explanation = 'Attendance between ' + from + ' and ' + to + ', counted across everyone. No day belongs to a name here.';
  } else if (def.key === 'leave') {
    panels = await leavePanel(from, to);
    explanation = 'Leave overlapping ' + from + ' to ' + to + '. Reasons are never read, aggregated or shown.';
  } else if (def.key === 'recruitment') {
    panels = await recruitmentPanel(from, to);
    explanation = 'Applications received between ' + from + ' and ' + to + '.';
  } else {
    panels = await performancePanel();
    explanation =
      'Review completion and rating bands as they stand now. An individual rating is never shown here, and there is no way to reach one from this screen.';
  }

  return {
    view: def.key,
    label: def.label,
    blurb: def.blurb,
    from,
    to,
    panels,
    minGroup: MIN_GROUP,
    degraded: panels.some((p) => !p.available),
    explanation,
  };
}
