// src/lib/horizon/evidence.ts — THE RECORDS THIS ENGINE IS ALLOWED TO READ, AND WHAT THEY SAY.
//
// =================================================================================================
// WHAT THIS FILE DOES
// =================================================================================================
//
// It turns six existing HR tables into one typed bundle with a date on every number. Nothing here
// interprets anything: no opportunity, no challenge, no trajectory. Those are engine.ts's job, and
// keeping the read separate from the interpretation is what makes it possible to show a person the
// exact rows behind a sentence about them.
//
// =================================================================================================
// EVERY SOURCE IS NAMED, AND AN UNREADABLE SOURCE IS NOT AN EMPTY ONE
// =================================================================================================
//
// This is the precedent src/lib/evidence-graph.ts sets and it is the single most important property
// of this file. A table that could not be read comes back as `unreadable`, not as zero rows. The
// difference matters because the two produce opposite sentences about a person: "no delivery record
// in this period" is a finding, and "we could not reach the delivery table" is an outage. A system
// that prints the first when the second is true is lying about somebody's work.
//
// =================================================================================================
// TWO ROUND TRIPS, NOT FOURTEEN
// =================================================================================================
//
// Vercel runs these functions in one region and Supabase answers from another; a warm round trip is
// about 177ms. A page that asked each table its own question would spend two and a half seconds in
// flight before it computed anything. So:
//
//   1. one catalogue query establishes which of the six tables actually exist;
//   2. one UNION ALL over exactly those tables returns both the per-source aggregates and the
//      monthly series, discriminated by a `kind` column.
//
// The catalogue query is not optional. hr_employee_goals, the capability graph and the review tables
// are all created lazily by their owning modules, so on a database where nobody has opened those
// screens yet the table is genuinely absent — and a UNION naming a missing table fails as a whole,
// taking the readable sources down with it.
//
// =================================================================================================
// WHAT THIS FILE WILL NOT READ
// =================================================================================================
//
// No date of birth, no age, no gender, no health record, no salary, no location trace, no clock
// coordinates, no device fingerprint. hr_clock_events holds lat/lon/ip/device_info and this module
// does not select them: rule 26 forbids surveillance-derived inference, and the way to keep that
// rule is to never put the column in the query. hr_attendance answers the same rhythm question from
// records the person can see on their own screen.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rowsOf, logFail, isUuid } from '@/lib/performance-scope';
import { toDay, daysBetween, type EvidenceShape } from './time';

const MOD = 'horizon/evidence';

// =================================================================================================
// THE SOURCE REGISTRY
// =================================================================================================

export interface SourceSpec {
  /** The table, exactly as it is in the database. */
  table: string;
  /** The module that OWNS the table. Patch 07 reads these; it does not own any of them. */
  owner: string;
  label: string;
  /** What this source is evidence OF. Printed beside the count. */
  evidences: string;
}

export const SOURCES: readonly SourceSpec[] = Object.freeze([
  {
    table: 'hr_attendance',
    owner: 'src/lib/attendance.ts',
    label: 'Attendance',
    evidences: 'Days present, hours recorded, and the rhythm of them.',
  },
  {
    table: 'hr_task_log',
    owner: 'portal/employee (end-of-day log)',
    label: 'Task log',
    evidences: 'Work the person recorded finishing, day by day.',
  },
  {
    table: 'hr_daily_reports',
    owner: 'src/lib/hr-reports',
    label: 'Daily reports',
    evidences: 'What was worked on, what progressed, what was blocked.',
  },
  {
    table: 'hr_performance_reviews',
    owner: 'src/lib/performance-schema.ts',
    label: 'Performance reviews',
    evidences: 'Ratings a named reviewer submitted, per cycle.',
  },
  {
    table: 'hr_employee_goals',
    owner: 'src/lib/hr-lifecycle.ts',
    label: 'Goals',
    evidences: 'Objectives set, and whether they were met.',
  },
  {
    table: 'capability_claims',
    owner: 'src/lib/evidence-graph.ts',
    label: 'Capability evidence',
    evidences: 'Evidenced skill claims and the verdicts on them.',
  },
]);

export function sourceSpec(table: string): SourceSpec | null {
  return SOURCES.find((s) => s.table === table) || null;
}

// =================================================================================================
// THE BUNDLE
// =================================================================================================

export interface SourceFacts {
  table: string;
  owner: string;
  label: string;
  evidences: string;
  rowCount: number;
  earliestDay: string | null;
  latestDay: string | null;
  /** Rows carrying a named human's verdict. See the per-source note for what that means there. */
  verifiedRowCount: number;
  /** The average of whatever number this source carries, when it carries one. */
  metricAvg: number | null;
  /** Set when the source could not be read. rowCount is then meaningless and screens must say so. */
  unreadable: boolean;
  because: string;
}

export interface SeriesPoint {
  /** First day of the month bucket. */
  bucket: string;
  rowCount: number;
  metricAvg: number | null;
}

export interface EmployeeAnchors {
  employeeId: string;
  joiningDay: string | null;
  probationEndDay: string | null;
  confirmationDay: string | null;
  designation: string | null;
  departmentId: string | null;
  /** Present only where the row itself was readable. */
  readable: boolean;
}

export interface TemporalEvidence {
  employeeId: string;
  /** The single instant the whole reading is anchored on. */
  today: string;
  anchors: EmployeeAnchors;
  /** The earliest day any source has a row for, bounded by the joining date where one exists. */
  recordStartDay: string | null;
  sources: SourceFacts[];
  series: Record<string, SeriesPoint[]>;
  /** Sources that exist in the registry but not in this database. Absent is not the same as empty. */
  absentTables: string[];
  /** Sources that exist and could not be read. */
  unreadable: { table: string; because: string }[];
  /** True when NOTHING could be read. A reading built on this must refuse rather than describe. */
  blind: boolean;
}

const NUM = (v: any): number => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

const NUM_OR_NULL = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * Which of the registry tables are actually in this database.
 *
 * Not cached. A per-process cache would be wrong for exactly one case and it is the case that
 * matters: a table created by another module's lazy bootstrap DURING the life of this instance would
 * stay invisible until the instance recycled, and the symptom is a source that silently reads as
 * absent for hours.
 */
async function presentTables(): Promise<{ present: Set<string>; readable: boolean }> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (${sql.join(SOURCES.map((s) => sql`${s.table}`), sql`, `)})`));
    return { present: new Set(rows.map((r: any) => String(r.table_name))), readable: true };
  } catch (e: any) {
    logFail(MOD, 'presentTables', e);
    return { present: new Set<string>(), readable: false };
  }
}

/**
 * ONE QUERY, BOTH SHAPES.
 *
 * Each branch returns the same seven columns so they can be unioned: a discriminator, the source,
 * a bucket (null on aggregate rows), a count, a verified count, the date bounds, and one metric.
 * The alternative — six queries plus six more for the series — is twelve round trips across a
 * region boundary for a single panel.
 */
function branchFor(table: string, employeeId: string, fromDay: string): any | null {
  switch (table) {
    case 'hr_attendance':
      return sql`
        SELECT 'agg' AS kind, 'hr_attendance' AS source, NULL::date AS bucket,
               COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE status IN ('present','wfh'))::int AS verified,
               MIN(date)::date AS earliest, MAX(date)::date AS latest,
               AVG(NULLIF(work_hours, 0))::numeric AS metric
          FROM hr_attendance
         WHERE employee_id = ${employeeId}::uuid AND date >= ${fromDay}::date
        UNION ALL
        SELECT 'series', 'hr_attendance', date_trunc('month', date)::date,
               COUNT(*)::int, 0, NULL::date, NULL::date, AVG(NULLIF(work_hours, 0))::numeric
          FROM hr_attendance
         WHERE employee_id = ${employeeId}::uuid AND date >= ${fromDay}::date
         GROUP BY 1, 2, 3`;
    case 'hr_task_log':
      return sql`
        SELECT 'agg', 'hr_task_log', NULL::date,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE status = 'done')::int,
               MIN(log_date)::date, MAX(log_date)::date,
               AVG(percent)::numeric
          FROM hr_task_log
         WHERE employee_id = ${employeeId}::uuid AND log_date >= ${fromDay}::date
        UNION ALL
        SELECT 'series', 'hr_task_log', date_trunc('month', log_date)::date,
               COUNT(*)::int, 0, NULL::date, NULL::date, AVG(percent)::numeric
          FROM hr_task_log
         WHERE employee_id = ${employeeId}::uuid AND log_date >= ${fromDay}::date
         GROUP BY 1, 2, 3`;
    case 'hr_daily_reports':
      return sql`
        SELECT 'agg', 'hr_daily_reports', NULL::date,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE blockers IS NOT NULL AND length(trim(blockers)) > 0)::int,
               MIN(report_date)::date, MAX(report_date)::date,
               NULL::numeric
          FROM hr_daily_reports
         WHERE employee_id = ${employeeId}::uuid AND report_date >= ${fromDay}::date
        UNION ALL
        SELECT 'series', 'hr_daily_reports', date_trunc('month', report_date)::date,
               COUNT(*)::int, 0, NULL::date, NULL::date, NULL::numeric
          FROM hr_daily_reports
         WHERE employee_id = ${employeeId}::uuid AND report_date >= ${fromDay}::date
         GROUP BY 1, 2, 3`;
    case 'hr_performance_reviews':
      // The date that matters is the period the review covered, not when somebody typed it in.
      // COALESCE keeps a review attached to a cycle with no dates from vanishing out of the window.
      return sql`
        SELECT 'agg', 'hr_performance_reviews', NULL::date,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE r.submitted_at IS NOT NULL)::int,
               MIN(COALESCE(c.period_end, r.created_at::date))::date,
               MAX(COALESCE(c.period_end, r.created_at::date))::date,
               AVG(r.overall_rating)::numeric
          FROM hr_performance_reviews r
          LEFT JOIN hr_review_cycles c ON c.id = r.cycle_id
         WHERE r.employee_id = ${employeeId}::uuid
           AND COALESCE(c.period_end, r.created_at::date) >= ${fromDay}::date
        UNION ALL
        SELECT 'series', 'hr_performance_reviews',
               date_trunc('month', COALESCE(c.period_end, r.created_at::date))::date,
               COUNT(*)::int, 0, NULL::date, NULL::date, AVG(r.overall_rating)::numeric
          FROM hr_performance_reviews r
          LEFT JOIN hr_review_cycles c ON c.id = r.cycle_id
         WHERE r.employee_id = ${employeeId}::uuid
           AND COALESCE(c.period_end, r.created_at::date) >= ${fromDay}::date
         GROUP BY 1, 2, 3`;
    case 'hr_employee_goals':
      return sql`
        SELECT 'agg', 'hr_employee_goals', NULL::date,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE employee_acknowledged = true)::int,
               MIN(COALESCE(target_date, created_at::date))::date,
               MAX(COALESCE(target_date, created_at::date))::date,
               (COUNT(*) FILTER (WHERE status = 'met'))::numeric
          FROM hr_employee_goals
         WHERE employee_id = ${employeeId}::uuid
           AND COALESCE(target_date, created_at::date) >= ${fromDay}::date
        UNION ALL
        SELECT 'series', 'hr_employee_goals',
               date_trunc('month', COALESCE(target_date, created_at::date))::date,
               COUNT(*)::int, 0, NULL::date, NULL::date,
               (COUNT(*) FILTER (WHERE status = 'met'))::numeric
          FROM hr_employee_goals
         WHERE employee_id = ${employeeId}::uuid
           AND COALESCE(target_date, created_at::date) >= ${fromDay}::date
         GROUP BY 1, 2, 3`;
    case 'capability_claims':
      // subject_id is TEXT in capability_claims, so the PARAMETER is the text here and the column is
      // left alone. Casting the column instead (subject_id::text = $1) is the pattern that defeats
      // the index on (subject_kind, subject_id) and it is already a known cost in this repository.
      return sql`
        SELECT 'agg', 'capability_claims', NULL::date,
               COUNT(e.id)::int,
               COUNT(e.id) FILTER (WHERE e.verification_status = 'human_verified')::int,
               MIN(COALESCE(e.occurred_at, e.created_at))::date,
               MAX(COALESCE(e.occurred_at, e.created_at))::date,
               NULL::numeric
          FROM capability_claims c
          JOIN capability_evidence e ON e.claim_id = c.id
         WHERE c.subject_kind = 'employee' AND c.subject_id = ${employeeId}
           AND COALESCE(e.occurred_at, e.created_at) >= ${fromDay}::timestamptz
        UNION ALL
        SELECT 'series', 'capability_claims',
               date_trunc('month', COALESCE(e.occurred_at, e.created_at))::date,
               COUNT(e.id)::int, 0, NULL::date, NULL::date, NULL::numeric
          FROM capability_claims c
          JOIN capability_evidence e ON e.claim_id = c.id
         WHERE c.subject_kind = 'employee' AND c.subject_id = ${employeeId}
           AND COALESCE(e.occurred_at, e.created_at) >= ${fromDay}::timestamptz
         GROUP BY 1, 2, 3`;
    default:
      return null;
  }
}

/** Per-source explanation of what its `verified` column counted. Shown, never guessed at. */
const VERIFIED_MEANS: Record<string, string> = {
  hr_attendance: 'days marked present or working from home',
  hr_task_log: 'entries marked done',
  hr_daily_reports: 'reports that named a blocker',
  hr_performance_reviews: 'reviews a named reviewer submitted',
  hr_employee_goals: 'goals the person acknowledged',
  capability_claims: 'evidence rows carrying a named human verdict',
};

/**
 * Read the employee anchors.
 *
 * The column list is fixed and short, and it does NOT include date_of_birth, gender, salary or
 * address. src/lib/digital-twin.ts screens those out structurally for the master record; this module
 * reaches the same place by never naming them.
 */
async function readAnchors(employeeId: string): Promise<EmployeeAnchors> {
  const empty: EmployeeAnchors = {
    employeeId,
    joiningDay: null,
    probationEndDay: null,
    confirmationDay: null,
    designation: null,
    departmentId: null,
    readable: false,
  };
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT joining_date, probation_end_date, confirmation_date, designation,
             department_id::text AS department_id
        FROM hr_employees
       WHERE id = ${employeeId}::uuid
       LIMIT 1`));
    if (!rows.length) return { ...empty, readable: true };
    const r = rows[0];
    return {
      employeeId,
      joiningDay: toDay(r.joining_date),
      probationEndDay: toDay(r.probation_end_date),
      confirmationDay: toDay(r.confirmation_date),
      designation: r.designation ? String(r.designation) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      readable: true,
    };
  } catch (e: any) {
    logFail(MOD, 'readAnchors', e);
    return empty;
  }
}

/**
 * Gather everything, once, for one person.
 *
 * `fromDay` is the earliest day any horizon in the reading needs. Gathering once for the widest
 * window and slicing per horizon in the engine is deliberate: the alternative is one query per
 * horizon, which is seven times the round trips for data that overlaps almost entirely.
 */
export async function gatherEvidence(input: {
  employeeId: string;
  today: string;
  fromDay: string;
}): Promise<TemporalEvidence> {
  const { employeeId, today, fromDay } = input;

  const blank: TemporalEvidence = {
    employeeId,
    today,
    anchors: {
      employeeId, joiningDay: null, probationEndDay: null, confirmationDay: null,
      designation: null, departmentId: null, readable: false,
    },
    recordStartDay: null,
    sources: [],
    series: {},
    absentTables: [],
    unreadable: [],
    blind: true,
  };

  if (!isUuid(employeeId)) return blank;

  const [anchors, cat] = await Promise.all([readAnchors(employeeId), presentTables()]);

  if (!cat.readable) {
    return {
      ...blank,
      anchors,
      unreadable: SOURCES.map((s) => ({
        table: s.table,
        because: 'The database catalogue could not be read, so we cannot say whether this source exists.',
      })),
    };
  }

  const absentTables = SOURCES.filter((s) => !cat.present.has(s.table)).map((s) => s.table);
  const live = SOURCES.filter((s) => cat.present.has(s.table));

  // hr_performance_reviews joins hr_review_cycles, and hr_employee_goals joins nothing but is created
  // by the same lazy bootstrap as its sibling. A branch whose JOIN target is missing would fail the
  // whole union, so the review branch is dropped when the cycles table is not there.
  const usable = live.filter((s) => (s.table === 'hr_performance_reviews' ? cat.present.has('hr_review_cycles') : true));
  const droppedForJoin = live.filter((s) => usable.indexOf(s) < 0);

  const unreadable: { table: string; because: string }[] = droppedForJoin.map((s) => ({
    table: s.table,
    because: 'hr_review_cycles is not in this database, and a review has no period without it.',
  }));

  let rows: any[] = [];
  if (usable.length) {
    const branches = usable.map((s) => branchFor(s.table, employeeId, fromDay)).filter(Boolean);
    try {
      rows = rowsOf(await db.execute(sql.join(branches as any[], sql` UNION ALL `)));
    } catch (e: any) {
      // ONE FAILED UNION MUST NOT BECOME SIX EMPTY SOURCES. Every table in the batch is reported
      // unreadable with the real Postgres reason, which lives on e.cause and not on e.message.
      const reason = e?.cause?.message || e?.message || 'unknown';
      logFail(MOD, 'gatherEvidence', e);
      for (const s of usable) {
        unreadable.push({ table: s.table, because: 'The query over this source failed. (' + reason + ')' });
      }
    }
  }

  const aggByTable = new Map<string, any>();
  const series: Record<string, SeriesPoint[]> = {};
  for (const r of rows) {
    const src = String(r.source || '');
    if (String(r.kind) === 'agg') {
      aggByTable.set(src, r);
    } else {
      const b = toDay(r.bucket);
      if (!b) continue;
      (series[src] ||= []).push({ bucket: b, rowCount: NUM(r.n), metricAvg: NUM_OR_NULL(r.metric) });
    }
  }
  for (const k of Object.keys(series)) series[k].sort((a, b) => a.bucket.localeCompare(b.bucket));

  const unreadableSet = new Set(unreadable.map((u) => u.table));

  const sources: SourceFacts[] = SOURCES.map((s) => {
    const base = {
      table: s.table,
      owner: s.owner,
      label: s.label,
      evidences: s.evidences,
    };
    if (absentTables.indexOf(s.table) >= 0) {
      return {
        ...base,
        rowCount: 0, earliestDay: null, latestDay: null, verifiedRowCount: 0, metricAvg: null,
        unreadable: true,
        because:
          'This table is not in the database. The module that owns it creates it on first use, so '
          + 'absent here means nobody has used that part of the system yet, not that this person has no record.',
      };
    }
    if (unreadableSet.has(s.table)) {
      return {
        ...base,
        rowCount: 0, earliestDay: null, latestDay: null, verifiedRowCount: 0, metricAvg: null,
        unreadable: true,
        because: unreadable.find((u) => u.table === s.table)!.because,
      };
    }
    const a = aggByTable.get(s.table);
    return {
      ...base,
      rowCount: a ? NUM(a.n) : 0,
      earliestDay: a ? toDay(a.earliest) : null,
      latestDay: a ? toDay(a.latest) : null,
      verifiedRowCount: a ? NUM(a.verified) : 0,
      metricAvg: a ? NUM_OR_NULL(a.metric) : null,
      unreadable: false,
      because:
        (a && NUM(a.n) > 0)
          ? NUM(a.n) + ' rows since ' + fromDay + '; verified count is ' + (VERIFIED_MEANS[s.table] || 'as recorded') + '.'
          : 'Readable, and there are no rows in this window. That is a finding, not a failure.',
    };
  });

  const readableDays = sources
    .filter((s) => !s.unreadable && s.earliestDay)
    .map((s) => s.earliestDay as string);
  let recordStartDay = readableDays.length ? readableDays.sort()[0] : null;
  if (anchors.joiningDay && (!recordStartDay || anchors.joiningDay < recordStartDay)) {
    recordStartDay = anchors.joiningDay;
  }

  const blind = sources.every((s) => s.unreadable);

  return {
    employeeId,
    today,
    anchors,
    recordStartDay,
    sources,
    series,
    absentTables,
    unreadable,
    blind,
  };
}

// =================================================================================================
// SHAPE — THE INPUT TO THE CONFIDENCE ARITHMETIC
// =================================================================================================

/**
 * Reduce the readable sources inside one window to the five numbers confidenceFor() needs.
 *
 * UNREADABLE SOURCES ARE EXCLUDED FROM EVERY TERM, including sourceCount. Counting a source we could
 * not read as a source would raise diversity on the strength of evidence nobody has seen.
 */
export function shapeWithin(ev: TemporalEvidence, fromDay: string, toDayStr: string): EvidenceShape {
  let rowCount = 0;
  let sourceCount = 0;
  let verifiedRowCount = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const s of ev.sources) {
    if (s.unreadable) continue;
    // A source contributes only when its recorded range overlaps the window at all.
    if (!s.earliestDay || !s.latestDay) continue;
    if (s.latestDay < fromDay || s.earliestDay > toDayStr) continue;
    sourceCount += 1;
    rowCount += s.rowCount;
    verifiedRowCount += s.verifiedRowCount;
    const e = s.earliestDay < fromDay ? fromDay : s.earliestDay;
    const l = s.latestDay > toDayStr ? toDayStr : s.latestDay;
    if (!earliest || e < earliest) earliest = e;
    if (!latest || l > latest) latest = l;
  }

  const spanDays = earliest && latest ? Math.max(0, daysBetween(earliest, latest)) : 0;
  const staleDays = latest ? Math.max(0, daysBetween(latest, ev.today)) : 0;

  return { rowCount, sourceCount, spanDays, staleDays, verifiedRowCount };
}

/** Series points inside a window, for the trend arithmetic in engine.ts. */
export function seriesWithin(ev: TemporalEvidence, table: string, fromDay: string, toDayStr: string): SeriesPoint[] {
  const all = ev.series[table] || [];
  return all.filter((p) => p.bucket >= fromDay.slice(0, 8) + '01' && p.bucket <= toDayStr);
}
