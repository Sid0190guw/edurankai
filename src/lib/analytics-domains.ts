// src/lib/analytics-domains.ts — ONE DASHBOARD PER DOMAIN. AGGREGATE ONLY, SUPPRESSED, AND SCOPED
// THROUGH THE ORGANIZATION GRAPH.
//
// =================================================================================================
// THIS EXTENDS src/lib/analytics-workforce.ts. IT DOES NOT REPLACE IT AND DOES NOT COPY IT.
// =================================================================================================
//
// suppressBands(), MIN_GROUP and TOO_FEW_LABEL are IMPORTED from that module, which imports MIN_GROUP
// in turn from src/lib/wellness.ts. Three files, one definition of "the smallest group we will
// describe" — because two constants meaning that is how one of them ends up at 3, and a second copy
// of the suppression rule is how one of them forgets to withhold the total.
//
// What is new here is BREADTH (nine domains rather than six panels), TRACEABILITY (every figure
// states what it counts and over what period, on the screen) and SCOPE (a department head sees their
// department, resolved from the graph, and never the company).
//
// =================================================================================================
// THE SCREEN THAT MUST NOT EXIST
// =================================================================================================
//
// If any query in this file returned ONE ROW PER PERSON to an oversight surface, that would be the
// screen this module exists to prevent. Every SELECT below is a COUNT, a SUM, an AVG or a GROUP BY.
// None of them selects a name, an id, an email, a salary or a rating belonging to an individual.
// There is no drill-down and no per-person export, and there is nowhere on any dashboard to reach
// one.
//
// A manager who needs one person's attendance reads it on that person's own record, through a
// relationship the Organization Graph records — not by filtering a company-wide table down to one row
// and calling it a report.
//
// =================================================================================================
// SUPPRESSION, AND WHY THE TOTAL GOES WITH IT
// =================================================================================================
//
// Below MIN_GROUP a count stops being a statistic and becomes a description of somebody: in a small
// organization "2 people were absent last Tuesday" plus ordinary office knowledge names them. So a
// band under the floor is withheld — AND SO IS THE BREAKDOWN TOTAL, because 34 next to two visible
// bands adding to 31 discloses the third exactly. That rule lives in suppressBands() and is applied
// here, never re-implemented.
//
// The same floor is applied to CHART POINTS (a month with three rows is three rows about few people)
// and to any metric describing a group smaller than the floor. In a small company that leaves a lot
// of dashboards mostly withheld. That is the correct outcome, and every screen says so out loud
// rather than printing a zero that looks like a data problem.
//
// =================================================================================================
// WHAT IS NEVER READ HERE, AT ALL
// =================================================================================================
//
// NO wellness_* TABLE IS QUERIED IN THIS FILE. Not aggregated, not counted, not joined. The wellness
// system is women-only and gated server-side; no admin, and not the founder, may see one person's
// cycle, symptoms or consult messages. There is deliberately no capability that unlocks it here,
// because the protection is THE ABSENCE OF THE QUERY, not a permission a future edit could widen.
//
// Neither is base_salary, gender, date_of_birth, pan_number, aadhaar_number nor any bank column. The
// payroll dashboard reads hr_payroll_runs — a RUN's totals, which are a fact about a payroll cycle —
// and never a payslip row belonging to a person.
//
// =================================================================================================
// HOUSE RULES OBSERVED THROUGHOUT
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS; `r.rows[0]` is a bug.
//   - The real Postgres reason is on e.cause.
//   - departments.id is a varchar(50) slug in schema.ts and a UUID in db/hr-schema.sql, so every
//     department comparison is ::text and never ::uuid.
//   - Every panel is wrapped independently: a table that does not exist on this database degrades
//     THAT panel to "could not be read" with a sentence, rather than blanking the dashboard.
//   - No DDL. This module only reads.
import { db } from './db';
import { sql, type SQL } from 'drizzle-orm';
import {
  suppressBands,
  MIN_GROUP,
  TOO_FEW_LABEL,
  type Band,
  type Metric,
} from './analytics-workforce';
import { resolveOrgViewerScope } from './org-chart';
import { policyCoverage } from './knowledge-base';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above every function that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[analytics-domains] ' + tag, e?.cause?.message || e?.message);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateIso = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

/** How many months a trend chart shows. Twelve columns fit a 360px screen at 20px each. */
const TREND_MONTHS = 12;

export { MIN_GROUP, TOO_FEW_LABEL };

// -------------------------------------------------------------------------------------------------
// THE DOMAINS
// -------------------------------------------------------------------------------------------------

/**
 * Nine dashboards. `periodMatters` says whether the date range changes anything — stated per domain
 * rather than assumed, because headcount and skills are STATES OF NOW and printing a date range over
 * them would be decoration over a number that ignored it. hr_employees is mutated in place, so this
 * data model genuinely cannot answer "what was the headcount in March".
 */
export const DOMAIN_DASHBOARDS = [
  {
    key: 'executive',
    label: 'Executive roll-up',
    blurb: 'One headline figure from each domain, with what it counts written beside it.',
    periodMatters: true,
  },
  {
    key: 'hr',
    label: 'People',
    blurb: 'Headcount, joiners, lifecycle movements and policy acknowledgement.',
    periodMatters: true,
  },
  {
    key: 'recruitment',
    label: 'Recruitment',
    blurb: 'Applications, referrals and open requisitions.',
    periodMatters: true,
  },
  {
    key: 'attendance',
    label: 'Attendance and leave',
    blurb: 'Recorded days and hours, corrections, and leave taken. Never per person.',
    periodMatters: true,
  },
  {
    key: 'payroll',
    label: 'Payroll and claims',
    blurb: 'Payroll runs and their totals, and the reimbursement queue. No payslip is read.',
    periodMatters: true,
  },
  {
    key: 'performance',
    label: 'Performance',
    blurb: 'Review completion, rating bands and goal outcomes. No individual rating is shown.',
    periodMatters: false,
  },
  {
    key: 'learning',
    label: 'Learning',
    blurb: 'Assigned learning, training events and recorded skills.',
    periodMatters: true,
  },
  {
    key: 'finance',
    label: 'Finance',
    blurb: 'Purchase requests, orders and claim value, by status and by month.',
    periodMatters: true,
  },
  {
    key: 'projects',
    label: 'Work delivery',
    blurb: 'What this database can actually say about delivery — which is tasks, not projects.',
    periodMatters: true,
  },
] as const;

export type DomainKey = (typeof DOMAIN_DASHBOARDS)[number]['key'];

const DOMAIN_KEY_SET = new Set<string>(DOMAIN_DASHBOARDS.map((d) => d.key));

export function parseDomainKey(raw: unknown): DomainKey {
  const v = String(raw || '').trim();
  return (DOMAIN_KEY_SET.has(v) ? v : 'executive') as DomainKey;
}

export function domainDef(key: DomainKey) {
  return DOMAIN_DASHBOARDS.find((d) => d.key === key) || DOMAIN_DASHBOARDS[0];
}

// -------------------------------------------------------------------------------------------------
// SCOPE — LAYER 1's ANSWER, asked before any number is computed.
// -------------------------------------------------------------------------------------------------

export interface DashboardScope {
  /** 'organization' sees everything; 'departments' sees only the departments they head. */
  kind: 'organization' | 'departments' | 'none';
  departmentIds: string[];
  departmentNames: string[];
  /** Short words for a header chip. */
  label: string;
  /** One sentence saying what this person is seeing and why. Rendered verbatim. */
  note: string;
  initialized: boolean;
  degraded: boolean;
}

/**
 * WHOSE NUMBERS ARE THESE?
 *
 * resolveOrgViewerScope() — src/lib/org-chart.ts, the SAME function /portal/organization and global
 * search use — answers from the ORGANIZATION GRAPH: `employee.manage` for the whole organization, a
 * department_head EDGE for a department subtree, otherwise your own line. Never a role name, and
 * never `users.role === 'department_head'`, which is a per-user label that would make every head a
 * head of everything.
 *
 * A viewer whose only scope is 'self' gets 'none' HERE. A dashboard of one person's own numbers is
 * not a dashboard, it is a record — and it already exists, on their own portal pages. Widening it to
 * the company because there was nothing else to show is the failure this function prevents.
 *
 * THE GRAPH IS EMPTY UNTIL THE FOUNDER RUNS THE BACKFILL. Until then nobody resolves as a department
 * head, so a person who is one sees the honest refusal rather than a silent company-wide view.
 */
export async function resolveDashboardScope(
  userId: string,
  holds: (key: string) => boolean,
): Promise<DashboardScope> {
  try {
    const scope = await resolveOrgViewerScope(String(userId || ''), holds);
    if (scope.kind === 'full') {
      return {
        kind: 'organization',
        departmentIds: [],
        departmentNames: [],
        label: 'The whole organization',
        note: 'These figures cover everybody on record. Anything describing fewer than ' + MIN_GROUP
          + ' people is withheld.',
        initialized: scope.initialized,
        degraded: scope.degraded,
      };
    }
    if (scope.kind === 'departments' && scope.departmentIds.length > 0) {
      const names = scope.departmentNames.length ? [...scope.departmentNames] : [...scope.departmentIds];
      return {
        kind: 'departments',
        departmentIds: [...scope.departmentIds],
        departmentNames: names,
        label: names.join(', '),
        note: 'These figures cover ' + names.join(', ')
          + ' only, because the organization graph records you as head of '
          + (names.length === 1 ? 'that department' : 'those departments')
          + '. Company-wide numbers are not shown to you, and a domain that is not recorded per '
          + 'department is refused rather than widened.',
        initialized: scope.initialized,
        degraded: scope.degraded,
      };
    }
    return {
      kind: 'none',
      departmentIds: [],
      departmentNames: [],
      label: 'Nothing in scope',
      note: scope.initialized
        ? 'The organization graph does not record you as head of any department, and you do not hold '
          + 'the organization-wide people capability, so there is no group here for you to look at. '
          + 'Your own record is on your portal pages.'
        : 'The organization graph has no relationships recorded yet, so a department scope cannot be '
          + 'resolved for anybody. Nothing is being hidden from you: there is nothing to resolve '
          + 'against until the backfill has run.',
      initialized: scope.initialized,
      degraded: scope.degraded,
    };
  } catch (e: any) {
    // A scope that throws is the narrowest scope, never the widest.
    logFail('resolveDashboardScope', e);
    return {
      kind: 'none',
      departmentIds: [],
      departmentNames: [],
      label: 'Nothing in scope',
      note: 'Your scope could not be resolved just now, so nothing is shown. That is the safe '
        + 'direction: a scope that cannot be read is never widened to the whole company.',
      initialized: false,
      degraded: true,
    };
  }
}

/**
 * The department filter, as SQL, for a query that has an `hr_employees` alias in it.
 *
 * ::text ON BOTH SIDES, ALWAYS. departments.id is a varchar(50) slug in src/lib/db/schema.ts and a
 * UUID in db/hr-schema.sql; a ::uuid cast throws on half the values in this product.
 *
 * Parameters are BOUND (sql.join over one fragment per id), never pasted, so a department id is data
 * and can never be syntax.
 */
function departmentFilter(scope: DashboardScope, alias = 'e'): SQL {
  if (scope.kind !== 'departments' || scope.departmentIds.length === 0) return sql``;
  const list = sql.join(scope.departmentIds.map((id) => sql`${String(id)}`), sql`, `);
  const col = sql.raw(alias + '.department_id');
  return sql`AND ${col}::text IN (${list})`;
}

// -------------------------------------------------------------------------------------------------
// THE SHAPES A DASHBOARD RENDERS
// -------------------------------------------------------------------------------------------------

export interface ChartPoint {
  label: string;
  /** Null when suppressed. A renderer must draw a gap, never a zero-height bar. */
  value: number | null;
  suppressed: boolean;
}

export interface DomainChart {
  title: string;
  /** What it counts and over what period. Printed under the chart, verbatim. */
  basis: string;
  unit: string;
  points: ChartPoint[];
  /** The tallest visible point, so a renderer has a scale without recomputing it. */
  max: number;
  suppressedPoints: number;
}

export interface DomainPanel {
  key: string;
  label: string;
  /** What this panel is about. */
  blurb: string;
  /** THE TRACEABILITY LINE: which tables, counted how, over what period. Rendered on the screen. */
  basis: string;
  metrics: Metric[];
  bandsTitle: string;
  bands: Band[];
  suppressedBands: number;
  chart: DomainChart | null;
  available: boolean;
  note: string | null;
}

export interface DomainDashboard {
  key: DomainKey;
  label: string;
  blurb: string;
  from: string;
  to: string;
  periodMatters: boolean;
  scope: DashboardScope;
  panels: DomainPanel[];
  minGroup: number;
  degraded: boolean;
  /** One sentence about the whole dashboard. Rendered verbatim. */
  explanation: string;
}

// -------------------------------------------------------------------------------------------------
// SMALL BUILDERS. The only place a number is turned into something a screen prints.
// -------------------------------------------------------------------------------------------------

const plain = (n: number) => Math.round(n).toLocaleString('en-IN');
const oneDp = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-IN');
const pct = (n: number) => String(Math.round(n)) + '%';

/**
 * A single number, withheld when the group it describes is too small to describe.
 *
 * `people` is the size of the group the number is ABOUT — not the number itself. "14 leave requests"
 * from 2 people is a statement about 2 people, and it is the 2 that decides.
 */
function metric(
  label: string,
  value: number | null,
  people: number | null,
  format: (n: number) => string,
  hint: string,
): Metric {
  if (value === null || people === null) {
    return { label, value: null, suppressed: false, hint: 'Not available. ' + hint };
  }
  if (people < MIN_GROUP) {
    return {
      label,
      value: null,
      suppressed: true,
      hint: 'Covers fewer than ' + MIN_GROUP + ' people, so nothing is reported. ' + hint,
    };
  }
  return { label, value: format(value), suppressed: false, hint };
}

/** A count that describes no group of people at all — vendors, policies, purchase orders, runs. */
function thingMetric(label: string, value: number | null, format: (n: number) => string, hint: string): Metric {
  if (value === null) return { label, value: null, suppressed: false, hint: 'Not available. ' + hint };
  return { label, value: format(value), suppressed: false, hint };
}

function unreadable(key: string, label: string, blurb: string, basis: string, note: string): DomainPanel {
  return {
    key, label, blurb, basis,
    metrics: [], bandsTitle: '', bands: [], suppressedBands: 0, chart: null,
    available: false, note,
  };
}

function outOfScope(key: string, label: string, blurb: string, basis: string, scope: DashboardScope): DomainPanel {
  return unreadable(
    key, label, blurb, basis,
    'This is not recorded per department anywhere in this database, so it cannot be narrowed to '
      + scope.label + '. It is refused rather than widened to the whole organization — showing you '
      + 'company figures because the data could not be scoped would be the leak, not the fix.',
  );
}

/** Turn a GROUP BY result into bands, treating NULL as a named band rather than dropping the row. */
function toBands(list: any[], labelKey: string, countKey: string, nullLabel: string) {
  return list.map((row: any) => ({
    label: row?.[labelKey] ? String(row[labelKey]) : nullLabel,
    count: Number(row?.[countKey]) || 0,
  }));
}

/** Human words for the machine vocabularies these tables store. */
function prettyStatus(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return 'Not recorded';
  const words = s.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function prettyBands(raw: { label: string; count: number }[]) {
  return raw.map((b) => ({ label: prettyStatus(b.label), count: b.count }));
}

/**
 * Build a monthly trend from rows of { bucket, n }.
 *
 * EVERY POINT IS SUBJECT TO THE FLOOR. A month holding three rows is three rows about few people, and
 * a chart is exactly the shape that makes a small number legible at a glance. Suppressed points are
 * returned as nulls with `suppressed` set, so the renderer draws a gap and the caption can say how
 * many were withheld — never a zero, which would read as "nothing happened".
 */
function monthlyChart(
  title: string,
  basis: string,
  unit: string,
  list: any[],
  opts: { suppress?: boolean } = {},
): DomainChart {
  const suppress = opts.suppress !== false;
  const points: ChartPoint[] = [];
  let max = 0;
  let suppressedPoints = 0;
  for (const row of list) {
    const raw = Number(row?.n) || 0;
    const bucket = row?.bucket ? new Date(row.bucket) : null;
    const label = bucket && !isNaN(bucket.getTime())
      ? bucket.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      : String(row?.bucket || '');
    if (suppress && raw > 0 && raw < MIN_GROUP) {
      suppressedPoints++;
      points.push({ label, value: null, suppressed: true });
      continue;
    }
    if (raw > max) max = raw;
    points.push({ label, value: raw, suppressed: false });
  }
  return { title, basis, unit, points, max, suppressedPoints };
}

// -------------------------------------------------------------------------------------------------
// THE PANELS. One read each, always aggregate, each independently wrapped.
// -------------------------------------------------------------------------------------------------

async function peoplePanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS active,
             COUNT(*) FILTER (WHERE e.joining_date >= ${from}::date AND e.joining_date <= ${to}::date)::int AS joined,
             COUNT(*) FILTER (WHERE e.onboarding_status <> 'complete')::int AS onboarding
        FROM hr_employees e
       WHERE e.is_active = TRUE ${dept}`));
    const active = head.length ? Number(head[0].active) || 0 : 0;

    const typeRows = rows(await db.execute(sql`
      SELECT e.employment_type AS band, COUNT(*)::int AS n
        FROM hr_employees e
       WHERE e.is_active = TRUE ${dept}
       GROUP BY e.employment_type`));
    const types = suppressBands(prettyBands(toBands(typeRows, 'band', 'n', 'Not recorded')));

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', e.joining_date) AS bucket, COUNT(*)::int AS n
        FROM hr_employees e
       WHERE e.joining_date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
         ${dept}
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'headcount',
      label: 'Headcount',
      blurb: 'How many people are on record, and how they are engaged.',
      basis: 'Counts rows in hr_employees where is_active is true, as they stand right now. Joiners '
        + 'count joining_date between ' + from + ' and ' + to + '. Employee records are updated in '
        + 'place, so there is no way to ask what the headcount was on a past date and this panel does '
        + 'not pretend otherwise.',
      metrics: [
        metric('Active employees', active, active, plain, 'Counted now, not over the period.'),
        metric('Joined in this period', head.length ? Number(head[0].joined) || 0 : null, active, plain,
          'joining_date between ' + from + ' and ' + to + '.'),
        metric('Onboarding not complete', head.length ? Number(head[0].onboarding) || 0 : null, active, plain,
          'onboarding_status is anything other than complete, counted now.'),
      ],
      bandsTitle: 'Engagement type',
      bands: types.bands,
      suppressedBands: types.suppressedBands,
      chart: monthlyChart('Joiners by month', 'Counts hr_employees.joining_date by calendar month over the last '
        + TREND_MONTHS + ' months, ignoring the date filter above so the shape of hiring is readable.',
        'people', trend),
      available: true,
      note: types.totalSuppressed
        ? 'Some engagement types hold fewer than ' + MIN_GROUP + ' people and are withheld, and the '
          + 'breakdown total is withheld with them so it cannot be subtracted back out.'
        : null,
    });
  } catch (e: any) {
    logFail('peoplePanels.headcount', e);
    out.push(unreadable('headcount', 'Headcount', 'How many people are on record.',
      'hr_employees', 'Employee records could not be read just now.'));
  }

  try {
    const move = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM hr_transfers t JOIN hr_employees e ON e.id = t.employee_id
          WHERE t.created_at >= ${from}::date AND t.created_at < (${to}::date + INTERVAL '1 day') ${dept}) AS transfers,
        (SELECT COUNT(*)::int FROM hr_promotions p JOIN hr_employees e ON e.id = p.employee_id
          WHERE p.created_at >= ${from}::date AND p.created_at < (${to}::date + INTERVAL '1 day') ${dept}) AS promotions,
        (SELECT COUNT(*)::int FROM hr_separations s JOIN hr_employees e ON e.id = s.employee_id
          WHERE s.initiated_at >= ${from}::date AND s.initiated_at <= ${to}::date ${dept}) AS separations,
        (SELECT COUNT(*)::int FROM hr_employment_contracts c JOIN hr_employees e ON e.id = c.employee_id
          WHERE c.status = 'active' AND c.end_date IS NOT NULL
            AND c.end_date <= CURRENT_DATE + INTERVAL '60 days' ${dept}) AS expiring`));
    const m = move.length ? move[0] : null;

    const kindRows = rows(await db.execute(sql`
      SELECT s.kind AS band, COUNT(*)::int AS n
        FROM hr_separations s JOIN hr_employees e ON e.id = s.employee_id
       WHERE s.initiated_at >= ${from}::date AND s.initiated_at <= ${to}::date ${dept}
       GROUP BY s.kind`));
    const kinds = suppressBands(prettyBands(toBands(kindRows, 'band', 'n', 'Not recorded')));
    const separations = m ? Number(m.separations) || 0 : 0;

    out.push({
      key: 'lifecycle',
      label: 'Lifecycle movements',
      blurb: 'Transfers, promotions, separations and contracts about to end.',
      basis: 'Counts rows created in hr_transfers, hr_promotions and hr_separations between ' + from
        + ' and ' + to + ', and active hr_employment_contracts whose end_date falls in the next 60 '
        + 'days counted from today. A movement is counted when it was RAISED, not when it took effect.',
      metrics: [
        metric('Transfers raised', m ? Number(m.transfers) || 0 : null, m ? Number(m.transfers) || 0 : null, plain,
          'hr_transfers rows created in the period.'),
        metric('Promotions raised', m ? Number(m.promotions) || 0 : null, m ? Number(m.promotions) || 0 : null, plain,
          'hr_promotions rows created in the period.'),
        metric('Separations initiated', separations, separations, plain,
          'hr_separations rows with initiated_at in the period.'),
        thingMetric('Contracts ending within 60 days', m ? Number(m.expiring) || 0 : null, plain,
          'Active contracts with an end_date inside the next 60 days. A count of documents, not of people.'),
      ],
      bandsTitle: 'Separations by reason',
      bands: separations >= MIN_GROUP ? kinds.bands : [],
      suppressedBands: separations >= MIN_GROUP ? kinds.suppressedBands : kinds.bands.length,
      chart: null,
      available: true,
      note: separations > 0 && separations < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' separations in this period, so no reasons are broken down. A '
          + 'reason for leaving over two people is those two people\'s reasons.'
        : kinds.totalSuppressed
          ? 'Some reasons cover fewer than ' + MIN_GROUP + ' separations and are withheld.'
          : null,
    });
  } catch (e: any) {
    logFail('peoplePanels.lifecycle', e);
    out.push(unreadable('lifecycle', 'Lifecycle movements', 'Transfers, promotions and separations.',
      'hr_transfers, hr_promotions, hr_separations, hr_employment_contracts',
      'Lifecycle records could not be read. These tables only exist on a database where the lifecycle '
        + 'module has been used.'));
  }

  // POLICY ACKNOWLEDGEMENT — the knowledge base's own aggregate, read through its function rather
  // than by a second query against kb_article_acks. One reader, one definition.
  try {
    const coverage = await policyCoverage();
    const bandsRaw = coverage.map((p) => ({ label: p.title + ' (v' + p.version + ')', count: p.acknowledged }));
    const banded = suppressBands(bandsRaw);
    out.push({
      key: 'policies',
      label: 'Policy acknowledgement',
      blurb: 'How many people have acknowledged each live policy, at its current version.',
      basis: 'Counts rows in kb_article_acks for the CURRENT version of each published policy that '
        + 'requires acknowledgement. An acknowledgement of an older version is not counted here, '
        + 'because a policy that was rewritten after somebody read it has not been acknowledged. '
        + 'Counted now, not over the period.',
      metrics: [
        thingMetric('Live policies requiring acknowledgement', coverage.length, plain,
          'Published policies with ack_required set. A count of documents.'),
      ],
      bandsTitle: 'Acknowledgements at the current version',
      bands: banded.bands,
      suppressedBands: banded.suppressedBands,
      chart: null,
      available: true,
      note: coverage.length === 0
        ? 'No policy has been published with acknowledgement tracking turned on yet. Nothing is being '
          + 'withheld here — there is nothing recorded.'
        : banded.suppressedBands
          ? 'A policy acknowledged by fewer than ' + MIN_GROUP + ' people is withheld: at that size '
            + 'the number describes who has read it.'
          : null,
    });
  } catch (e: any) {
    logFail('peoplePanels.policies', e);
    out.push(unreadable('policies', 'Policy acknowledgement', 'Who has acknowledged each live policy.',
      'kb_articles, kb_article_acks', 'The knowledge base could not be read just now.'));
  }

  return out;
}

async function recruitmentPanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  // An application belongs to a CANDIDATE, who has no department here: applications has no
  // department column and hiring_requisitions stores a free-text department NAME rather than an id,
  // so there is nothing a department head's scope could be matched against without guessing.
  if (scope.kind === 'departments') {
    return [outOfScope('recruitment', 'Recruitment', 'Applications, referrals and requisitions.',
      'applications, recruitment_referrals, hiring_requisitions', scope)];
  }

  const out: DomainPanel[] = [];
  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS applications, COUNT(DISTINCT email)::int AS people
        FROM applications
       WHERE created_at >= ${from}::date AND created_at < (${to}::date + INTERVAL '1 day')`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT status::text AS band, COUNT(*)::int AS n
        FROM applications
       WHERE created_at >= ${from}::date AND created_at < (${to}::date + INTERVAL '1 day')
       GROUP BY status::text`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', created_at) AS bucket, COUNT(*)::int AS n
        FROM applications
       WHERE created_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'applications',
      label: 'Applications',
      blurb: 'What came in, and where it got to.',
      basis: 'Counts rows in applications with created_at between ' + from + ' and ' + to
        + ' inclusive. Distinct applicants counts distinct email addresses over the same window; one '
        + 'person applying to three roles is one applicant and three applications.',
      metrics: [
        metric('Applications received', head.length ? Number(head[0].applications) || 0 : null, people, plain,
          'Rows in applications, created in the period.'),
        metric('Distinct applicants', people, people, plain,
          'Distinct email addresses over the same window.'),
      ],
      bandsTitle: 'Applications by status',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: monthlyChart('Applications by month',
        'Counts applications.created_at by calendar month over the last ' + TREND_MONTHS
          + ' months, ignoring the date filter above.', 'applications', trend),
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people applied in this period, so nothing is broken down. '
          + 'Candidates are people too and the same floor applies to them.'
        : banded.totalSuppressed
          ? 'Some statuses hold fewer than ' + MIN_GROUP + ' applications and are withheld.'
          : null,
    });
  } catch (e: any) {
    logFail('recruitmentPanels.applications', e);
    out.push(unreadable('applications', 'Applications', 'What came in.',
      'applications', 'Applications could not be read just now.'));
  }

  try {
    const head = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM recruitment_referrals
          WHERE created_at >= ${from}::date AND created_at < (${to}::date + INTERVAL '1 day')) AS referrals,
        (SELECT COUNT(DISTINCT referrer_user_id)::int FROM recruitment_referrals
          WHERE created_at >= ${from}::date AND created_at < (${to}::date + INTERVAL '1 day')) AS referrers,
        (SELECT COUNT(*)::int FROM hiring_requisitions
          WHERE status IN ('pending_finance', 'pending_leadership')) AS open_reqs,
        (SELECT COUNT(*)::int FROM talent_pool_entries) AS pool`));
    const h = head.length ? head[0] : null;
    const referrers = h ? Number(h.referrers) || 0 : 0;

    const stateRows = rows(await db.execute(sql`
      SELECT state AS band, COUNT(*)::int AS n FROM recruitment_referrals
       WHERE created_at >= ${from}::date AND created_at < (${to}::date + INTERVAL '1 day')
       GROUP BY state`));
    const banded = suppressBands(prettyBands(toBands(stateRows, 'band', 'n', 'Not recorded')));

    out.push({
      key: 'pipeline',
      label: 'Referrals and requisitions',
      blurb: 'What the team brought in, and what is still waiting to be approved.',
      basis: 'Referrals count rows in recruitment_referrals created between ' + from + ' and ' + to
        + '. Open requisitions count hiring_requisitions still at pending_finance or '
        + 'pending_leadership, right now. Talent pool counts every talent_pool_entries row ever added.',
      metrics: [
        metric('Referrals submitted', h ? Number(h.referrals) || 0 : null, referrers, plain,
          'Rows in recruitment_referrals created in the period.'),
        metric('People who referred somebody', referrers, referrers, plain,
          'Distinct referrer accounts over the same window.'),
        thingMetric('Requisitions awaiting a decision', h ? Number(h.open_reqs) || 0 : null, plain,
          'Requisitions at pending_finance or pending_leadership, counted now. A count of requests.'),
        thingMetric('Candidates in the talent pool', h ? Number(h.pool) || 0 : null, plain,
          'Every talent_pool_entries row, all time.'),
      ],
      bandsTitle: 'Referrals by state',
      bands: referrers >= MIN_GROUP ? banded.bands : [],
      suppressedBands: referrers >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: referrers > 0 && referrers < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people referred anybody in this period, so the breakdown is '
          + 'withheld — it would describe them.'
        : null,
    });
  } catch (e: any) {
    logFail('recruitmentPanels.pipeline', e);
    out.push(unreadable('pipeline', 'Referrals and requisitions', 'Referrals and open roles.',
      'recruitment_referrals, hiring_requisitions, talent_pool_entries',
      'Referrals and requisitions could not be read. These tables only exist on a database where '
        + 'those modules have been used.'));
  }

  return out;
}

async function attendancePanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS days,
             COUNT(DISTINCT a.employee_id)::int AS people,
             COALESCE(AVG(NULLIF(a.work_hours, 0)), 0)::float8 AS avg_hours,
             COALESCE(SUM(a.work_hours), 0)::float8 AS total_hours
        FROM hr_attendance a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.date >= ${from}::date AND a.date <= ${to}::date ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const days = head.length ? Number(head[0].days) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT a.status AS band, COUNT(*)::int AS n
        FROM hr_attendance a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.date >= ${from}::date AND a.date <= ${to}::date ${dept}
       GROUP BY a.status`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', a.date) AS bucket, COUNT(*)::int AS n
        FROM hr_attendance a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
         ${dept}
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'attendance',
      label: 'Attendance',
      blurb: 'Recorded days and hours across everybody in scope.',
      basis: 'Counts rows in hr_attendance with date between ' + from + ' and ' + to
        + ' inclusive. The average excludes days with no hours recorded, so an unfilled day does not '
        + 'drag it down. No day here belongs to a name.',
      metrics: [
        metric('Days recorded', days, people, plain, 'Attendance rows in the period, across everyone.'),
        metric('Average hours on a day with hours',
          head.length ? Number(head[0].avg_hours) || 0 : null, people, oneDp,
          'AVG of work_hours over rows where work_hours is not zero.'),
        metric('Total hours recorded', head.length ? Number(head[0].total_hours) || 0 : null, people, plain,
          'SUM of work_hours over the period.'),
      ],
      bandsTitle: 'Days by status',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: monthlyChart('Days recorded by month',
        'Counts hr_attendance rows by calendar month over the last ' + TREND_MONTHS
          + ' months, ignoring the date filter above.', 'days', trend),
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have attendance recorded in this period, so nothing is '
          + 'broken down. That is the design, not a gap in the data.'
        : banded.totalSuppressed
          ? 'Some statuses cover fewer than ' + MIN_GROUP + ' days and are withheld.'
          : null,
    });
  } catch (e: any) {
    logFail('attendancePanels.attendance', e);
    out.push(unreadable('attendance', 'Attendance', 'Recorded days and hours.',
      'hr_attendance', 'Attendance could not be read just now.'));
  }

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS requests,
             COUNT(DISTINCT l.employee_id)::int AS people,
             COALESCE(SUM(l.days) FILTER (WHERE l.status = 'approved'), 0)::int AS approved_days,
             COUNT(*) FILTER (WHERE l.status = 'pending')::int AS pending
        FROM hr_leave_request l
        LEFT JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.start_date <= ${to}::date AND l.end_date >= ${from}::date ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const typeRows = rows(await db.execute(sql`
      SELECT l.leave_type AS band, COUNT(*)::int AS n
        FROM hr_leave_request l
        LEFT JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.start_date <= ${to}::date AND l.end_date >= ${from}::date ${dept}
       GROUP BY l.leave_type`));
    const banded = suppressBands(prettyBands(toBands(typeRows, 'band', 'n', 'Not recorded')));

    let corrections: number | null = null;
    try {
      const c = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM hr_attendance_corrections c
         LEFT JOIN hr_employees e ON e.id = c.employee_id
         WHERE c.status = 'pending' ${dept}`));
      corrections = c.length ? Number(c[0].n) || 0 : 0;
    } catch (e: any) {
      // The corrections table only exists where the module has been used. A missing count is stated
      // as "not available", never as a zero — a zero here would read as "nothing is waiting".
      logFail('attendancePanels.corrections', e);
      corrections = null;
    }

    out.push({
      key: 'leave',
      label: 'Leave and corrections',
      blurb: 'Leave overlapping the period, and the correction queue.',
      basis: 'Counts rows in hr_leave_request whose start_date and end_date OVERLAP ' + from + ' to '
        + to + ' — a request spanning the boundary is counted once, in full. Days approved sums the '
        + 'days column over approved requests only. Reasons for leave are never read, aggregated or '
        + 'shown anywhere in this product.',
      metrics: [
        metric('Requests overlapping the period', head.length ? Number(head[0].requests) || 0 : null, people, plain,
          'hr_leave_request rows overlapping the window.'),
        metric('Days approved', head.length ? Number(head[0].approved_days) || 0 : null, people, plain,
          'SUM of days over requests with status approved.'),
        metric('Still waiting for a decision', head.length ? Number(head[0].pending) || 0 : null, people, plain,
          'Requests at status pending. A number that stays high here is a queue, not a statistic.'),
        thingMetric('Attendance corrections waiting', corrections, plain,
          'hr_attendance_corrections at status pending, counted now. Each is routed to a named '
            + 'approver by the workflow engine; this is the size of that queue, not a judgement of it.'),
      ],
      bandsTitle: 'Requests by type',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have leave in this period. A leave type is close to a '
          + 'reason for it, so nothing is broken down.'
        : banded.totalSuppressed
          ? 'Some leave types cover fewer than ' + MIN_GROUP + ' requests and are withheld.'
          : null,
    });
  } catch (e: any) {
    logFail('attendancePanels.leave', e);
    out.push(unreadable('leave', 'Leave and corrections', 'Leave overlapping the period.',
      'hr_leave_request, hr_attendance_corrections', 'Leave could not be read just now.'));
  }

  return out;
}

async function payrollPanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];

  // A payroll RUN is a company-wide cycle. It has no department, and hr_payslips is the per-person
  // table this module will not read — so there is nothing to narrow for a department head.
  if (scope.kind === 'departments') {
    out.push(outOfScope('payroll', 'Payroll runs', 'Payroll cycles and their totals.',
      'hr_payroll_runs', scope));
  } else {
    try {
      const head = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS runs,
               COALESCE(MAX(total_employees), 0)::int AS largest_run,
               COALESCE(SUM(total_gross), 0)::float8 AS gross,
               COALESCE(SUM(total_net), 0)::float8 AS net,
               COALESCE(SUM(total_deductions), 0)::float8 AS deductions
          FROM hr_payroll_runs
         WHERE make_date(year, month, 1) >= date_trunc('month', ${from}::date)
           AND make_date(year, month, 1) <= ${to}::date`));
      const h = head.length ? head[0] : null;
      const covered = h ? Number(h.largest_run) || 0 : 0;

      const statusRows = rows(await db.execute(sql`
        SELECT status AS band, COUNT(*)::int AS n FROM hr_payroll_runs
         WHERE make_date(year, month, 1) >= date_trunc('month', ${from}::date)
           AND make_date(year, month, 1) <= ${to}::date
         GROUP BY status`));
      // Runs are DOCUMENTS, not people, so the band floor would be wrong here: three draft runs is
      // three cycles, not three colleagues. The floor is applied to the MONEY instead, through the
      // employee count of the largest run in the window.
      const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')), 1);

      const trend = rows(await db.execute(sql`
        SELECT make_date(year, month, 1) AS bucket,
               CASE WHEN MAX(total_employees) >= ${MIN_GROUP}
                    THEN COALESCE(SUM(total_net), 0)::float8 ELSE 0 END AS n
          FROM hr_payroll_runs
         WHERE make_date(year, month, 1) >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
         GROUP BY 1 ORDER BY 1`));

      out.push({
        key: 'payroll',
        label: 'Payroll runs',
        blurb: 'What was run, for how many people, and what it totalled.',
        basis: 'Reads hr_payroll_runs — the TOTALS a run recorded for itself — for runs whose month '
          + 'falls between ' + from + ' and ' + to + '. It does NOT read hr_payslips: a payslip is one '
          + 'person\'s pay, and no query behind any dashboard in this product touches it. Amounts are '
          + 'in the currency payroll was run in; this table records no currency code of its own.',
        metrics: [
          thingMetric('Payroll runs in the period', h ? Number(h.runs) || 0 : null, plain,
            'Rows in hr_payroll_runs for months inside the window. A count of cycles.'),
          metric('People in the largest run', covered, covered, plain,
            'MAX of total_employees across those runs.'),
          metric('Total gross', h ? Number(h.gross) || 0 : null, covered, plain,
            'SUM of total_gross across the runs in the window.'),
          metric('Total net paid', h ? Number(h.net) || 0 : null, covered, plain,
            'SUM of total_net across the runs in the window.'),
          metric('Total deductions', h ? Number(h.deductions) || 0 : null, covered, plain,
            'SUM of total_deductions across the runs in the window.'),
        ],
        bandsTitle: 'Runs by status',
        bands: banded.bands,
        suppressedBands: banded.suppressedBands,
        chart: monthlyChart('Net paid by month',
          'SUM of hr_payroll_runs.total_net by payroll month over the last ' + TREND_MONTHS
            + ' months. A month whose run covered fewer than ' + MIN_GROUP
            + ' people contributes nothing, so a small run cannot be read as one person\'s salary.',
          'net paid', trend, { suppress: false }),
        available: true,
        note: covered > 0 && covered < MIN_GROUP
          ? 'The largest run in this window covered fewer than ' + MIN_GROUP + ' people, so every '
            + 'money figure is withheld: a total over three people is close enough to three salaries.'
          : null,
      });
    } catch (e: any) {
      logFail('payrollPanels.runs', e);
      out.push(unreadable('payroll', 'Payroll runs', 'Payroll cycles and their totals.',
        'hr_payroll_runs', 'Payroll runs could not be read. This table only exists on a database '
          + 'where payroll has been run.'));
    }
  }

  try {
    const dept = departmentFilter(scope, 'e');
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS claims,
             COUNT(DISTINCT c.employee_id)::int AS people,
             COALESCE(SUM(c.amount), 0)::float8 AS amount,
             COUNT(*) FILTER (WHERE c.status IN ('submitted', 'pending'))::int AS waiting
        FROM expense_claims c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.created_at >= ${from}::date
         AND c.created_at < (${to}::date + INTERVAL '1 day') ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT c.status AS band, COUNT(*)::int AS n
        FROM expense_claims c
        LEFT JOIN hr_employees e ON e.id = c.employee_id
       WHERE c.created_at >= ${from}::date
         AND c.created_at < (${to}::date + INTERVAL '1 day') ${dept}
       GROUP BY c.status`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    out.push({
      key: 'claims',
      label: 'Expense and travel claims',
      blurb: 'What was claimed, and how much of it is still waiting.',
      basis: 'Counts rows in expense_claims created between ' + from + ' and ' + to
        + '. The value is the SUM of the amount column across every currency stored, because the '
        + 'table records a currency per claim and mixing them into one total would be wrong to '
        + 'present as money — read it as scale, not as a figure to reconcile against a ledger.',
      metrics: [
        metric('Claims raised', head.length ? Number(head[0].claims) || 0 : null, people, plain,
          'expense_claims rows created in the period.'),
        metric('Claimed value', head.length ? Number(head[0].amount) || 0 : null, people, plain,
          'SUM of amount across those rows, currencies not converted.'),
        metric('Waiting for a decision', head.length ? Number(head[0].waiting) || 0 : null, people, plain,
          'Claims at submitted or pending. Each is routed to a named approver by the workflow engine.'),
      ],
      bandsTitle: 'Claims by status',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people claimed anything in this period, so the figures are '
          + 'withheld — they would describe those people\'s spending.'
        : null,
    });
  } catch (e: any) {
    logFail('payrollPanels.claims', e);
    out.push(unreadable('claims', 'Expense and travel claims', 'What was claimed.',
      'expense_claims', 'Claims could not be read. This table only exists on a database where the '
        + 'expenses module has been used.'));
  }

  return out;
}

async function performancePanels(scope: DashboardScope): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS reviews,
             COUNT(DISTINCT r.employee_id)::int AS people,
             COUNT(*) FILTER (WHERE r.status = 'submitted')::int AS submitted
        FROM hr_performance_reviews r
        LEFT JOIN hr_employees e ON e.id = r.employee_id
       WHERE TRUE ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const reviews = head.length ? Number(head[0].reviews) || 0 : 0;
    const submitted = head.length ? Number(head[0].submitted) || 0 : 0;

    // RATING BANDS, NEVER RATINGS. The boundaries are written out as a CASE rather than computed by
    // width_bucket, because a boundary nobody can see is a boundary nobody checks.
    const bandRows = rows(await db.execute(sql`
      SELECT CASE
               WHEN r.overall_rating IS NULL THEN 'Not rated'
               WHEN r.overall_rating < 2 THEN 'Below 2'
               WHEN r.overall_rating < 3 THEN '2 to 3'
               WHEN r.overall_rating < 4 THEN '3 to 4'
               ELSE '4 and above'
             END AS band,
             COUNT(*)::int AS n
        FROM hr_performance_reviews r
        LEFT JOIN hr_employees e ON e.id = r.employee_id
       WHERE r.status = 'submitted' ${dept}
       GROUP BY 1`));
    const banded = suppressBands(toBands(bandRows, 'band', 'n', 'Not rated'));

    out.push({
      key: 'reviews',
      label: 'Reviews',
      blurb: 'Whether reviews were finished, and the shape of the ratings.',
      basis: 'Counts every row in hr_performance_reviews as it stands now, across all cycles — a '
        + 'review belongs to a cycle rather than to a date range, so the period filter does not apply '
        + 'to this panel and is not pretended to. Completion is a process fact; no individual rating '
        + 'is shown and there is nowhere on this screen to reach one.',
      metrics: [
        metric('Reviews on record', reviews, people, plain, 'All hr_performance_reviews rows in scope.'),
        metric('Submitted', submitted, people, plain, 'Rows at status submitted.'),
        metric('Completion rate', reviews > 0 ? (submitted / reviews) * 100 : null, people, pct,
          'Submitted divided by all reviews on record, as a percentage.'),
      ],
      bandsTitle: 'Submitted reviews by rating band',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have a review on record, so no rating bands are shown. '
          + 'A rating band over three people is three people\'s ratings.'
        : banded.totalSuppressed
          ? 'Some rating bands hold fewer than ' + MIN_GROUP + ' reviews and are withheld, and the '
            + 'total is withheld with them.'
          : null,
    });
  } catch (e: any) {
    logFail('performancePanels.reviews', e);
    out.push(unreadable('reviews', 'Reviews', 'Review completion and rating bands.',
      'hr_performance_reviews', 'Performance reviews could not be read. This table only exists on a '
        + 'database where a review cycle has been run.'));
  }

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS goals,
             COUNT(DISTINCT g.employee_id)::int AS people,
             COUNT(*) FILTER (WHERE g.status = 'met')::int AS met,
             COUNT(*) FILTER (WHERE g.status = 'open')::int AS open
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE TRUE ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const goals = head.length ? Number(head[0].goals) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT g.status AS band, COUNT(*)::int AS n
        FROM hr_employee_goals g
        LEFT JOIN hr_employees e ON e.id = g.employee_id
       WHERE TRUE ${dept}
       GROUP BY g.status`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    out.push({
      key: 'goals',
      label: 'Goals',
      blurb: 'How many goals are on record and what became of them.',
      basis: 'Counts every row in hr_employee_goals in scope, as it stands now. A goal has a target '
        + 'date rather than a creation window that matches this filter, so the period is not applied '
        + 'here and is not implied.',
      metrics: [
        metric('Goals on record', goals, people, plain, 'All hr_employee_goals rows in scope.'),
        metric('Still open', head.length ? Number(head[0].open) || 0 : null, people, plain,
          'Rows at status open.'),
        metric('Met', head.length ? Number(head[0].met) || 0 : null, people, plain, 'Rows at status met.'),
      ],
      bandsTitle: 'Goals by outcome',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have goals on record in scope, so outcomes are withheld: '
          + 'a missed goal over two people names them.'
        : null,
    });
  } catch (e: any) {
    logFail('performancePanels.goals', e);
    out.push(unreadable('goals', 'Goals', 'Goals and their outcomes.',
      'hr_employee_goals', 'Goals could not be read. This table only exists on a database where the '
        + 'goals module has been used.'));
  }

  return out;
}

async function learningPanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS assignments,
             COUNT(DISTINCT a.employee_id)::int AS people,
             COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
             COUNT(*) FILTER (WHERE a.status <> 'completed' AND a.due_on IS NOT NULL
                                AND a.due_on < CURRENT_DATE)::int AS overdue,
             COUNT(*) FILTER (WHERE a.required = true)::int AS required
        FROM hr_learning_assignments a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE TRUE ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const assignments = head.length ? Number(head[0].assignments) || 0 : 0;
    const completed = head.length ? Number(head[0].completed) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT a.status AS band, COUNT(*)::int AS n
        FROM hr_learning_assignments a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE TRUE ${dept}
       GROUP BY a.status`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    out.push({
      key: 'assigned',
      label: 'Assigned learning',
      blurb: 'What was assigned, what is finished, and what is late.',
      basis: 'Counts every row in hr_learning_assignments in scope, as it stands now. Overdue means '
        + 'a due_on date in the past and a status other than completed, evaluated today. An '
        + 'assignment has no created-in-window semantics here, so the period filter is not applied.',
      metrics: [
        metric('Assignments on record', assignments, people, plain, 'All hr_learning_assignments rows in scope.'),
        metric('Completed', completed, people, plain, 'Rows at status completed.'),
        metric('Completion rate', assignments > 0 ? (completed / assignments) * 100 : null, people, pct,
          'Completed divided by all assignments in scope.'),
        metric('Overdue', head.length ? Number(head[0].overdue) || 0 : null, people, plain,
          'Not completed, with a due_on before today. A number to act on, not a judgement of anybody.'),
        metric('Marked required', head.length ? Number(head[0].required) || 0 : null, people, plain,
          'Rows with required set.'),
      ],
      bandsTitle: 'Assignments by status',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have assigned learning in scope, so the breakdown is '
          + 'withheld — "one person is overdue" is a sentence about that person.'
        : null,
    });
  } catch (e: any) {
    logFail('learningPanels.assigned', e);
    out.push(unreadable('assigned', 'Assigned learning', 'What was assigned and finished.',
      'hr_learning_assignments', 'Assigned learning could not be read. This table only exists on a '
        + 'database where learning has been assigned.'));
  }

  try {
    const dep = departmentFilter(scope, 'ev');
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS events,
             COUNT(*) FILTER (WHERE ev.starts_at >= ${from}::date
                                AND ev.starts_at < (${to}::date + INTERVAL '1 day'))::int AS in_period
        FROM hr_training_events ev
       WHERE TRUE ${dep}`));
    const h = head.length ? head[0] : null;

    const signups = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS signups, COUNT(DISTINCT s.employee_id)::int AS people
        FROM hr_training_signups s
        JOIN hr_training_events ev ON ev.id = s.event_id
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE ev.starts_at >= ${from}::date
         AND ev.starts_at < (${to}::date + INTERVAL '1 day') ${dept}`));
    const people = signups.length ? Number(signups[0].people) || 0 : 0;

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', ev.starts_at) AS bucket, COUNT(*)::int AS n
        FROM hr_training_events ev
       WHERE ev.starts_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
         ${dep}
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'training',
      label: 'Training events',
      blurb: 'What is on the training calendar, and how many places were taken.',
      basis: 'Counts rows in hr_training_events, and hr_training_signups against the events that '
        + 'start between ' + from + ' and ' + to + '. An event is a thing on a calendar rather than a '
        + 'fact about a person, so event counts are not subject to the group floor; the sign-up '
        + 'figures are.',
      metrics: [
        thingMetric('Events on the calendar', h ? Number(h.events) || 0 : null, plain,
          'All hr_training_events rows in scope, all time.'),
        thingMetric('Events starting in this period', h ? Number(h.in_period) || 0 : null, plain,
          'Events whose starts_at falls inside the window.'),
        metric('Sign-ups for those events', signups.length ? Number(signups[0].signups) || 0 : null, people, plain,
          'hr_training_signups rows against events starting inside the window.'),
        metric('People who signed up', people, people, plain, 'Distinct employees over the same set.'),
      ],
      bandsTitle: '',
      bands: [],
      suppressedBands: 0,
      chart: monthlyChart('Training events by month',
        'Counts hr_training_events by the calendar month they start in, over the last ' + TREND_MONTHS
          + ' months. Events are not people, so no point here is suppressed.',
        'events', trend, { suppress: false }),
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people signed up in this period, so the sign-up figures are '
          + 'withheld even though the event counts are not.'
        : null,
    });
  } catch (e: any) {
    logFail('learningPanels.training', e);
    out.push(unreadable('training', 'Training events', 'The training calendar.',
      'hr_training_events, hr_training_signups', 'Training could not be read. These tables only exist '
        + 'on a database where training has been scheduled.'));
  }

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS records,
             COUNT(DISTINCT s.employee_id)::int AS people,
             COUNT(DISTINCT s.skill_id)::int AS skills,
             COALESCE(AVG(s.level), 0)::float8 AS avg_level
        FROM hr_employee_skills s
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE TRUE ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const skillRows = rows(await db.execute(sql`
      SELECT sk.name AS band, COUNT(*)::int AS n
        FROM hr_employee_skills s
        JOIN hr_skills sk ON sk.id = s.skill_id
        LEFT JOIN hr_employees e ON e.id = s.employee_id
       WHERE TRUE ${dept}
       GROUP BY sk.name`));
    const banded = suppressBands(toBands(skillRows, 'band', 'n', 'Not recorded'));

    out.push({
      key: 'skills',
      label: 'Skills on record',
      blurb: 'How widely each skill is recorded. Never who holds it.',
      basis: 'Counts rows in hr_employee_skills in scope, as they stand now. The breakdown counts HOW '
        + 'MANY PEOPLE have each skill recorded, never which people — a skill held by four people is '
        + 'withheld, because in a company this size naming the skill names them.',
      metrics: [
        metric('Skill records', head.length ? Number(head[0].records) || 0 : null, people, plain,
          'All hr_employee_skills rows in scope.'),
        metric('People with a skill recorded', people, people, plain, 'Distinct employees in that set.'),
        metric('Average recorded level', head.length ? Number(head[0].avg_level) || 0 : null, people, oneDp,
          'AVG of the level column, 1 to 5 as the skills module defines it.'),
      ],
      bandsTitle: 'People per skill',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: null,
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have skills recorded in scope, so nothing is broken down.'
        : banded.suppressedBands
          ? banded.suppressedBands + ' skill' + (banded.suppressedBands === 1 ? ' is' : 's are')
            + ' held by fewer than ' + MIN_GROUP + ' people and withheld.'
          : null,
    });
  } catch (e: any) {
    logFail('learningPanels.skills', e);
    out.push(unreadable('skills', 'Skills on record', 'How widely each skill is recorded.',
      'hr_employee_skills, hr_skills', 'Skills could not be read. These tables only exist on a '
        + 'database where the skills module has been used.'));
  }

  return out;
}

async function financePanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS requests,
             COUNT(DISTINCT r.requester_employee_id)::int AS people,
             COALESCE(SUM(r.estimated_cost), 0)::float8 AS estimated,
             COUNT(*) FILTER (WHERE r.status IN ('submitted', 'pending'))::int AS waiting
        FROM procurement_requests r
        LEFT JOIN hr_employees e ON e.id = r.requester_employee_id
       WHERE r.created_at >= ${from}::date
         AND r.created_at < (${to}::date + INTERVAL '1 day') ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT r.status AS band, COUNT(*)::int AS n
        FROM procurement_requests r
        LEFT JOIN hr_employees e ON e.id = r.requester_employee_id
       WHERE r.created_at >= ${from}::date
         AND r.created_at < (${to}::date + INTERVAL '1 day') ${dept}
       GROUP BY r.status`));
    // A purchase request is a DOCUMENT about a thing to buy, and the breakdown counts documents. The
    // person-shaped part of it — who asked — is what the metric floor above protects.
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')), 1);

    out.push({
      key: 'requests',
      label: 'Purchase requests',
      blurb: 'What was asked for, and what is still waiting for a decision.',
      basis: 'Counts rows in procurement_requests created between ' + from + ' and ' + to
        + '. Estimated value sums estimated_cost across every currency stored, unconverted — read it '
        + 'as scale rather than as a figure to reconcile.',
      metrics: [
        thingMetric('Requests raised', head.length ? Number(head[0].requests) || 0 : null, plain,
          'procurement_requests rows created in the period. A count of requests.'),
        metric('People who raised one', people, people, plain,
          'Distinct requester employee records over the same window.'),
        thingMetric('Estimated value', head.length ? Number(head[0].estimated) || 0 : null, plain,
          'SUM of estimated_cost, currencies not converted.'),
        thingMetric('Waiting for a decision', head.length ? Number(head[0].waiting) || 0 : null, plain,
          'Requests at submitted or pending. Each is routed to a named approver by the workflow engine.'),
      ],
      bandsTitle: 'Requests by status',
      bands: banded.bands,
      suppressedBands: banded.suppressedBands,
      chart: null,
      available: true,
      note: null,
    });
  } catch (e: any) {
    logFail('financePanels.requests', e);
    out.push(unreadable('requests', 'Purchase requests', 'What was asked for.',
      'procurement_requests', 'Purchase requests could not be read. This table only exists on a '
        + 'database where the procurement module has been used.'));
  }

  if (scope.kind === 'departments') {
    out.push(outOfScope('orders', 'Orders and vendors', 'Committed spend and the supplier list.',
      'procurement_orders, procurement_vendors', scope));
    return out;
  }

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS orders,
             COALESCE(SUM(amount), 0)::float8 AS amount,
             COUNT(*) FILTER (WHERE status = 'open')::int AS open,
             COUNT(*) FILTER (WHERE received_at IS NOT NULL)::int AS received
        FROM procurement_orders
       WHERE order_date >= ${from}::date AND order_date <= ${to}::date`));
    const h = head.length ? head[0] : null;

    const vendors = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM procurement_vendors`));

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', order_date) AS bucket, COALESCE(SUM(amount), 0)::float8 AS n
        FROM procurement_orders
       WHERE order_date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'orders',
      label: 'Orders and vendors',
      blurb: 'What was committed to a supplier, and how much of it has arrived.',
      basis: 'Counts rows in procurement_orders with order_date between ' + from + ' and ' + to
        + '. Value sums the amount column, currencies unconverted. Vendors counts every row in '
        + 'procurement_vendors, all time. None of these figures describes a person, so none of them '
        + 'is subject to the group floor.',
      metrics: [
        thingMetric('Orders placed', h ? Number(h.orders) || 0 : null, plain,
          'procurement_orders rows with order_date inside the window.'),
        thingMetric('Committed value', h ? Number(h.amount) || 0 : null, plain,
          'SUM of amount over those orders, currencies not converted.'),
        thingMetric('Still open', h ? Number(h.open) || 0 : null, plain, 'Orders at status open.'),
        thingMetric('Received', h ? Number(h.received) || 0 : null, plain, 'Orders with a received_at stamp.'),
        thingMetric('Vendors on record', vendors.length ? Number(vendors[0].n) || 0 : null, plain,
          'Every procurement_vendors row, all time.'),
      ],
      bandsTitle: '',
      bands: [],
      suppressedBands: 0,
      chart: monthlyChart('Committed value by month',
        'SUM of procurement_orders.amount by order month over the last ' + TREND_MONTHS
          + ' months, currencies unconverted. Orders are not people, so no point is suppressed.',
        'value', trend, { suppress: false }),
      available: true,
      note: null,
    });
  } catch (e: any) {
    logFail('financePanels.orders', e);
    out.push(unreadable('orders', 'Orders and vendors', 'Committed spend and the supplier list.',
      'procurement_orders, procurement_vendors', 'Orders could not be read. These tables only exist '
        + 'on a database where the procurement module has been used.'));
  }

  return out;
}

async function projectPanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const out: DomainPanel[] = [];
  const dept = departmentFilter(scope, 'e');

  // THE HONEST STATE, AND IT IS THE FIRST THING ON THE SCREEN. There is no projects table in this
  // database — no projects, no project_id, no projectId anywhere in src/ or db/, and employee_tasks
  // carries no project relation. src/lib/search-global.ts and workforce/navigation.ts NAV_BACKLOG both
  // record the same finding. So this dashboard cannot be a project dashboard, and inventing one out of
  // task titles would be a chart of a guess. What IS recorded is task-level work, and that is what is
  // shown, labelled as what it is.
  out.push({
    key: 'no-projects',
    label: 'There is no project system here yet',
    blurb: 'What this dashboard can and cannot answer.',
    basis: 'A statement about the schema, not a number: there is no projects table, no project_id '
      + 'column, and employee_tasks has no project relation.',
    metrics: [],
    bandsTitle: '',
    bands: [],
    suppressedBands: 0,
    chart: null,
    available: true,
    note: 'Work is not grouped by project anywhere in this database, so "delivery by project" cannot '
      + 'be answered and is not faked. The panel below reports what IS recorded — individual tasks, '
      + 'in aggregate. When a project module exists this dashboard gains a panel; until then the gap '
      + 'is stated rather than filled with something that looks like an answer.',
  });

  try {
    const head = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS tasks,
             COUNT(DISTINCT t.employee_id)::int AS people,
             COUNT(*) FILTER (WHERE t.status = 'done' OR t.completed_at IS NOT NULL)::int AS done,
             COUNT(*) FILTER (WHERE t.status <> 'done' AND t.completed_at IS NULL
                                AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE)::int AS overdue
        FROM employee_tasks t
        LEFT JOIN hr_employees e ON e.id = t.employee_id
       WHERE t.created_at >= ${from}::date
         AND t.created_at < (${to}::date + INTERVAL '1 day') ${dept}`));
    const people = head.length ? Number(head[0].people) || 0 : 0;
    const tasks = head.length ? Number(head[0].tasks) || 0 : 0;
    const done = head.length ? Number(head[0].done) || 0 : 0;

    const statusRows = rows(await db.execute(sql`
      SELECT t.status AS band, COUNT(*)::int AS n
        FROM employee_tasks t
        LEFT JOIN hr_employees e ON e.id = t.employee_id
       WHERE t.created_at >= ${from}::date
         AND t.created_at < (${to}::date + INTERVAL '1 day') ${dept}
       GROUP BY t.status`));
    const banded = suppressBands(prettyBands(toBands(statusRows, 'band', 'n', 'Not recorded')));

    const trend = rows(await db.execute(sql`
      SELECT date_trunc('month', t.completed_at) AS bucket, COUNT(*)::int AS n
        FROM employee_tasks t
        LEFT JOIN hr_employees e ON e.id = t.employee_id
       WHERE t.completed_at IS NOT NULL
         AND t.completed_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '${sql.raw(String(TREND_MONTHS - 1))} months')
         ${dept}
       GROUP BY 1 ORDER BY 1`));

    out.push({
      key: 'tasks',
      label: 'Tasks',
      blurb: 'Work items raised and finished, across everybody in scope.',
      basis: 'Counts rows in employee_tasks created between ' + from + ' and ' + to
        + '. Overdue means a due_on in the past with no completion, evaluated today. This is a count '
        + 'of work items and never a comparison between people: there is no per-person breakdown '
        + 'behind this panel and no way to reach one from this screen.',
      metrics: [
        metric('Tasks raised', tasks, people, plain, 'employee_tasks rows created in the period.'),
        metric('Completed', done, people, plain, 'Rows at status done, or with a completed_at stamp.'),
        metric('Completion rate', tasks > 0 ? (done / tasks) * 100 : null, people, pct,
          'Completed divided by tasks raised in the same window.'),
        metric('Overdue and open', head.length ? Number(head[0].overdue) || 0 : null, people, plain,
          'Past due_on, not completed. A queue to act on, never a score for anybody.'),
      ],
      bandsTitle: 'Tasks by status',
      bands: people >= MIN_GROUP ? banded.bands : [],
      suppressedBands: people >= MIN_GROUP ? banded.suppressedBands : banded.bands.length,
      chart: monthlyChart('Tasks completed by month',
        'Counts employee_tasks by the calendar month of completed_at over the last ' + TREND_MONTHS
          + ' months, ignoring the date filter above.', 'tasks', trend),
      available: true,
      note: people > 0 && people < MIN_GROUP
        ? 'Fewer than ' + MIN_GROUP + ' people have tasks in scope, so nothing is broken down. At that '
          + 'size a task count is one person\'s workload, and this is not a productivity screen.'
        : null,
    });
  } catch (e: any) {
    logFail('projectPanels.tasks', e);
    out.push(unreadable('tasks', 'Tasks', 'Work items raised and finished.',
      'employee_tasks', 'Tasks could not be read. This table only exists on a database where tasks '
        + 'have been assigned.'));
  }

  return out;
}

/**
 * THE EXECUTIVE ROLL-UP.
 *
 * ONE HEADLINE PER DOMAIN, each carrying the sentence that says what it counts — and each computed by
 * the SAME panel builders the domain dashboards use, not by a second set of queries. A roll-up whose
 * numbers are computed separately is a roll-up that disagrees with the pages it summarises, and the
 * disagreement is always discovered in a meeting.
 *
 * The cost of that decision is honest: this page runs every domain's queries. It is one page, opened
 * by two accounts, and correctness is worth more than the round trips.
 */
async function executivePanels(scope: DashboardScope, from: string, to: string): Promise<DomainPanel[]> {
  const [people, recruitment, attendance, payroll, performance, learning, finance, projects] =
    await Promise.all([
      peoplePanels(scope, from, to),
      recruitmentPanels(scope, from, to),
      attendancePanels(scope, from, to),
      payrollPanels(scope, from, to),
      performancePanels(scope),
      learningPanels(scope, from, to),
      financePanels(scope, from, to),
      projectPanels(scope, from, to),
    ]);

  /** Lift one named metric out of a domain's panels, keeping its own hint verbatim. */
  const pick = (panels: DomainPanel[], panelKey: string, metricLabel: string, rename: string): Metric | null => {
    const panel = panels.find((p) => p.key === panelKey);
    if (!panel || !panel.available) return null;
    const m = panel.metrics.find((x) => x.label === metricLabel);
    if (!m) return null;
    return { ...m, label: rename };
  };

  const headline: (Metric | null)[] = [
    pick(people, 'headcount', 'Active employees', 'People on record'),
    pick(recruitment, 'applications', 'Applications received', 'Applications this period'),
    pick(attendance, 'attendance', 'Days recorded', 'Attendance days recorded'),
    pick(attendance, 'leave', 'Still waiting for a decision', 'Leave awaiting a decision'),
    pick(payroll, 'payroll', 'Total net paid', 'Net payroll in the period'),
    pick(payroll, 'claims', 'Waiting for a decision', 'Claims awaiting a decision'),
    pick(performance, 'reviews', 'Completion rate', 'Review completion'),
    pick(learning, 'assigned', 'Overdue', 'Learning overdue'),
    pick(finance, 'requests', 'Waiting for a decision', 'Purchases awaiting a decision'),
    pick(projects, 'tasks', 'Overdue and open', 'Tasks overdue'),
  ];

  const metrics = headline.filter((m): m is Metric => m !== null);
  const missing = headline.length - metrics.length;

  const domains: DomainPanel[][] = [people, recruitment, attendance, payroll, performance, learning, finance, projects];
  const unavailable = domains.reduce((n, list) => n + list.filter((p) => !p.available).length, 0);

  return [
    {
      key: 'rollup',
      label: 'Across every domain',
      blurb: 'One figure from each dashboard, lifted from the same query that draws it there.',
      basis: 'Every number on this panel is computed by the domain dashboard it came from, not by a '
        + 'second query — so a figure here and the same figure there cannot disagree. Each carries its '
        + 'own basis line underneath it. Period figures cover ' + from + ' to ' + to
        + '; the rest describe the organization as it stands now.',
      metrics,
      bandsTitle: '',
      bands: [],
      suppressedBands: 0,
      chart: null,
      available: true,
      note: missing > 0 || unavailable > 0
        ? missing + ' headline figure' + (missing === 1 ? '' : 's') + ' could not be lifted and '
          + unavailable + ' panel' + (unavailable === 1 ? '' : 's') + ' across the domains could not '
          + 'be read. Open the domain dashboard to see which, and why. Nothing here is estimated to '
          + 'fill a gap.'
        : null,
    },
  ];
}

// -------------------------------------------------------------------------------------------------
// THE BUILD
// -------------------------------------------------------------------------------------------------

/**
 * Build one domain dashboard, over one period, for one scope.
 *
 * A SCOPE OF 'none' RETURNS NO PANELS AT ALL, with the scope's own sentence explaining why. It does
 * not fall back to company-wide figures, and there is no branch in this function that could: the
 * refusal is above the panel builders, not inside them.
 */
export async function buildDomainDashboard(
  key: DomainKey,
  window: { from: string; to: string },
  scope: DashboardScope,
): Promise<DomainDashboard> {
  const def = domainDef(key);
  const to = isDateIso(window?.to) ? window.to : new Date().toISOString().slice(0, 10);
  let from = isDateIso(window?.from) ? window.from : to;
  if (from > to) from = to;

  const base = {
    key: def.key as DomainKey,
    label: def.label,
    blurb: def.blurb,
    from,
    to,
    periodMatters: def.periodMatters,
    scope,
    minGroup: MIN_GROUP,
  };

  if (scope.kind === 'none') {
    return {
      ...base,
      panels: [],
      degraded: scope.degraded,
      explanation: scope.note,
    };
  }

  let panels: DomainPanel[] = [];
  try {
    if (def.key === 'hr') panels = await peoplePanels(scope, from, to);
    else if (def.key === 'recruitment') panels = await recruitmentPanels(scope, from, to);
    else if (def.key === 'attendance') panels = await attendancePanels(scope, from, to);
    else if (def.key === 'payroll') panels = await payrollPanels(scope, from, to);
    else if (def.key === 'performance') panels = await performancePanels(scope);
    else if (def.key === 'learning') panels = await learningPanels(scope, from, to);
    else if (def.key === 'finance') panels = await financePanels(scope, from, to);
    else if (def.key === 'projects') panels = await projectPanels(scope, from, to);
    else panels = await executivePanels(scope, from, to);
  } catch (e: any) {
    // A builder that throws past its own per-panel guards leaves an EMPTY dashboard with a sentence,
    // never a half-drawn one that looks complete.
    logFail('buildDomainDashboard.' + def.key, e);
    panels = [];
  }

  const explanation = def.periodMatters
    ? def.label + ' between ' + from + ' and ' + to + ', counted across the group in scope. '
      + scope.note + ' Each panel states what it counts underneath it.'
    : def.label + ' as it stands now — this data is updated in place, so there is no way to ask what '
      + 'it was on a past date and no date filter is offered. ' + scope.note;

  return {
    ...base,
    panels,
    degraded: scope.degraded || panels.some((p) => !p.available),
    explanation,
  };
}
