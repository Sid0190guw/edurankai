// src/lib/horizon/report/providers/org.ts — ORGANISATION SHAPE: POSITION, INTERNAL MOVEMENT, TOTALS.
//
// Three capabilities that share one provider because they share one join. The bridge from an
// employment record to a hiring record is `tal_identity`, which carries both hr_employee_id and
// person_id; without it the role-mobility report cannot tell that the person in front of it has
// already applied for two internal roles, and would recommend a move they were turned down for last
// quarter.
//
// SMALL GROUPS ARE SUPPRESSED, INCLUDING FOR THE FOUNDER. See MIN_GROUP below. The organisation-wide
// report is aggregate by definition, and an aggregate over three people is not an aggregate — it is
// three people with the names taken off, readable by anybody who knows who works in that department.
// The suppression is applied in SQL rather than in the renderer, so the row never reaches a document
// that could be exported.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { toRows } from '@/lib/page-safety';
import { CAPABILITIES } from '../registry';
import { derivedClaim, evidenceRef, factClaim, sourceRef } from '../provenance';
import { textIn } from '@/lib/pg-array';
import type {
  DerivedClaim, FactClaim, HumanFeedbackClaim, SourceLoad, SourceLoadContext, SourceProvider,
} from '../types';

const PROVIDER_ID = 'org.shape';
const SYSTEM = 'organisation';
const OWNER = 'Talent and org-graph patches (src/lib/talent/schema.ts, src/lib/org-graph.ts)';

/**
 * The smallest group this provider will report a number about.
 *
 * Five, matching the suppression floor the wellness oversight screens already use in this codebase.
 * The constant is redeclared here rather than imported from that module on purpose: it is a
 * women-only health system whose own header says no other surface should be reaching into it, and
 * borrowing a number is not worth the import edge.
 */
const MIN_GROUP = 5;

function src(table: string, recordId?: string | null, capturedAt?: string | null) {
  return sourceRef({ provider: PROVIDER_ID, system: SYSTEM, table, ownedBy: OWNER, recordId, capturedAt });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  try {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

export const orgShapeProvider: SourceProvider = {
  descriptor: {
    id: PROVIDER_ID,
    label: 'Organisation shape',
    system: SYSTEM,
    tables: [
      'tal_identity', 'org_positions', 'tal_application', 'tal_opportunity',
      'hr_employees', 'hr_employee_skills', 'hr_skills', 'hr_performance_reviews', 'hr_feedback',
    ],
    ownedBy: OWNER,
    capabilities: [CAPABILITIES.ORG_POSITION, CAPABILITIES.ORG_MOBILITY, CAPABILITIES.ORG_AGGREGATE],
    sensitivity: 'elevated',
  },

  async load(ctx: SourceLoadContext): Promise<SourceLoad> {
    const facts: FactClaim[] = [];
    const derived: DerivedClaim[] = [];
    const humanFeedback: HumanFeedbackClaim[] = [];
    const notes: string[] = [];

    const now = ctx.now;
    const stamp = ctx.stamp;
    const want = new Set(ctx.capabilities);
    const from = ctx.window ? ctx.window.from : null;

    // ---------------------------------------------------------------------------------------
    // ORGANISATION TOTALS — THE FOUNDER REPORT, AND NOTHING ELSE
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.ORG_AGGREGATE) && ctx.subject.kind === 'organisation') {
      // ONE ROUND TRIP. Seven separate COUNT queries against a database in another region is most of
      // a second of somebody waiting for a dashboard, and the same seven numbers cost one statement.
      const rows = toRows(await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM hr_employees WHERE is_active = TRUE)::int                       AS active_people,
          (SELECT COUNT(*) FROM hr_employees WHERE employment_status = 'active'
              AND joining_date >= (CURRENT_DATE - INTERVAL '365 days'))::int                    AS joined_last_year,
          (SELECT COUNT(*) FROM hr_employees WHERE exit_date IS NOT NULL
              AND exit_date >= (CURRENT_DATE - INTERVAL '365 days'))::int                       AS left_last_year,
          (SELECT COUNT(DISTINCT employee_id) FROM hr_performance_reviews
             WHERE status = 'submitted')::int                                                   AS people_reviewed,
          (SELECT COUNT(*) FROM hr_feedback
             WHERE created_at >= (CURRENT_DATE - INTERVAL '365 days'))::int                     AS feedback_last_year,
          (SELECT COUNT(*) FROM hr_employee_skills WHERE source <> 'self')::int                 AS assessed_skills,
          (SELECT COUNT(*) FROM hr_employee_skills)::int                                        AS all_skills`));
      const r: any = rows[0] || {};
      const active = num(r.active_people);
      const ev = [evidenceRef('organisation_snapshot', 'organisation:' + now.slice(0, 10), 'Organisation-wide counts on the day of generation')];

      if (active < MIN_GROUP) {
        notes.push('Fewer than ' + MIN_GROUP + ' active people are on record, so organisation-wide numbers are suppressed: an aggregate that small identifies individuals.');
      } else {
        derived.push(derivedClaim({
          label: 'Active people on record', value: active, basisCount: active, major: true,
          method: 'Count of hr_employees rows with is_active true. Headcount as the HR record holds it, not as payroll holds it.',
          now, stamp, sources: [src('hr_employees')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Joined in the last year', value: num(r.joined_last_year), unit: 'people',
          basisCount: active,
          method: 'Count of active hr_employees with a joining_date inside 365 days.',
          now, stamp, sources: [src('hr_employees')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Left in the last year', value: num(r.left_last_year), unit: 'people',
          basisCount: active,
          method: 'Count of hr_employees with an exit_date inside 365 days. A count, not a turnover rate: the denominator a rate needs is average headcount over the period, and that is not recorded.',
          now, stamp, sources: [src('hr_employees')], evidence: ev,
        }));
        // REVIEW COVERAGE IS THE NUMBER THAT TELLS A FOUNDER WHETHER THE REST OF THIS PLATFORM MEANS
        // ANYTHING. Every per-person report in this engine rests on submitted reviews and recorded
        // feedback; if two-thirds of the organisation has neither, the engine is confidently
        // summarising a third of the company and silently guessing about the rest.
        derived.push(derivedClaim({
          label: 'People with at least one submitted review', value: num(r.people_reviewed),
          unit: 'of ' + active, basisCount: active, major: true,
          method: 'Distinct employee_id in hr_performance_reviews with status submitted, over active headcount. This is the coverage every other report in this engine depends on.',
          now, stamp, sources: [src('hr_performance_reviews')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Feedback notes recorded in the last year', value: num(r.feedback_last_year),
          basisCount: active,
          method: 'Count of hr_feedback rows inside 365 days, organisation-wide.',
          now, stamp, sources: [src('hr_feedback')], evidence: ev,
        }));
        derived.push(derivedClaim({
          label: 'Skills assessed by somebody other than the holder',
          value: num(r.assessed_skills), unit: 'of ' + num(r.all_skills) + ' recorded skills',
          basisCount: num(r.all_skills),
          method: 'Count of hr_employee_skills rows whose source is not self. Self-reported skills are claims; the ratio says how much of the skills record is evidence.',
          now, stamp, sources: [src('hr_employee_skills')], evidence: ev,
        }));
      }
    }

    if (ctx.subject.kind !== 'employee' && ctx.subject.kind !== 'manager') {
      return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes, error: null };
    }

    const employeeId = ctx.subject.id;

    // ---------------------------------------------------------------------------------------
    // POSITION AND THE COMPETENCIES IT DECLARES
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.ORG_POSITION)) {
      const rows = toRows(await db.execute(sql`
        SELECT p.id::text AS id, p.title, p.grade, p.department_id, p.competencies, p.is_active,
               i.identity_code, i.start_date, i.status
          FROM tal_identity i
          JOIN org_positions p ON p.id = i.position_id
         WHERE i.hr_employee_id = ${employeeId}::uuid
         ORDER BY i.start_date DESC NULLS LAST
         LIMIT 1`));
      const r: any = rows[0];
      if (!r) {
        notes.push('This person is not linked to a position in the organisation structure, so role fit cannot be assessed against a declared role.');
      } else {
        const ev = [evidenceRef('position', String(r.id), 'Position ' + String(r.title))];
        facts.push(factClaim({
          label: 'Position held', value: String(r.title) + (r.grade ? ', grade ' + String(r.grade) : ''),
          occurredAt: iso(r.start_date), major: true, now, stamp,
          sources: [src('org_positions', String(r.id))], evidence: ev,
        }));

        let competencies: string[] = [];
        try {
          const parsed = typeof r.competencies === 'string' ? JSON.parse(r.competencies) : r.competencies;
          if (Array.isArray(parsed)) {
            competencies = parsed
              .map((c: any) => (typeof c === 'string' ? c : (c && c.name ? String(c.name) : '')))
              .filter(Boolean);
          }
        } catch { competencies = []; }

        if (!competencies.length) {
          notes.push('The position declares no competencies, so there is nothing to measure demonstrated skills against. A mobility reading without that list is a guess.');
        } else {
          facts.push(factClaim({
            label: 'Competencies this position declares', value: competencies.join(', '),
            now, stamp, sources: [src('org_positions', String(r.id))], evidence: ev,
          }));
          // THE GAP, MEASURED RATHER THAN INFERRED. This is the one cross-domain query in the file:
          // the position list belongs to the org graph and the assessed skills belong to HR, and the
          // question "how many of the declared competencies has this person had assessed" cannot be
          // answered inside either one. It is a single statement, matched on skill name, and the
          // matching rule is stated in the method so nobody reads more precision into it than the
          // string comparison actually has.
          const covered = toRows(await db.execute(sql`
            SELECT COUNT(DISTINCT lower(s.name))::int AS matched
              FROM hr_employee_skills es
              JOIN hr_skills s ON s.id = es.skill_id
             WHERE es.employee_id = ${employeeId}::uuid
               AND es.source <> 'self'
               AND lower(s.name) IN ${textIn(competencies.map((c) => c.toLowerCase()))}`));
          const matched = num((covered[0] as any)?.matched);
          derived.push(derivedClaim({
            label: 'Declared competencies with an assessed skill behind them',
            value: matched, unit: 'of ' + competencies.length, basisCount: competencies.length, major: true,
            method: 'Case-insensitive exact match between org_positions.competencies and the names of hr_employee_skills rows not self-reported. An exact-name match: a competency worded differently from the skill will read as a gap when it is not.',
            now, stamp, sources: [src('org_positions', String(r.id)), src('hr_employee_skills')],
            evidence: ev,
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // INTERNAL MOVEMENT ALREADY ATTEMPTED
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.ORG_MOBILITY)) {
      const rows = toRows(await db.execute(sql`
        SELECT a.id::text AS id, a.application_code, a.status, a.submitted_at, a.closed_at,
               o.title AS opportunity_title
          FROM tal_application a
          JOIN tal_opportunity o ON o.id = a.opportunity_id
         WHERE a.is_internal = TRUE
           AND a.person_id = (SELECT i.person_id FROM tal_identity i
                               WHERE i.hr_employee_id = ${employeeId}::uuid
                               ORDER BY i.created_at DESC LIMIT 1)
           AND (${from}::date IS NULL OR a.submitted_at >= ${from}::date)
         ORDER BY a.submitted_at DESC
         LIMIT 20`));
      if (!rows.length) {
        notes.push('No internal application by this person is on record in the window.');
      }
      for (const raw of rows) {
        const r: any = raw;
        facts.push(factClaim({
          label: 'Applied internally for ' + String(r.opportunity_title),
          value: String(r.status), occurredAt: iso(r.submitted_at), major: true, now, stamp,
          sources: [src('tal_application', String(r.id), iso(r.submitted_at))],
          evidence: [evidenceRef('internal_application', String(r.id), 'Application ' + String(r.application_code || ''))],
        }));
      }
      if (rows.length) {
        derived.push(derivedClaim({
          label: 'Internal applications made', value: rows.length, basisCount: rows.length,
          window: ctx.window,
          method: 'Count of tal_application rows flagged internal for the person linked to this employment record through tal_identity.',
          now, stamp, sources: [src('tal_application')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('internal_application', String(raw.id), String(raw.opportunity_title))),
        }));
      }
    }

    return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes, error: null };
  },
};
