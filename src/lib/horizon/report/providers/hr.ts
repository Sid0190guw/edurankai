// src/lib/horizon/report/providers/hr.ts — EMPLOYMENT-SIDE SOURCE PROVIDER.
//
// Reads the HR patch's tables and returns sections 1-3 only. It owns none of these relations and
// writes to none of them; it is an adapter, and when a column moves this file is what changes rather
// than the engine.
//
// WHAT IT DELIBERATELY DOES NOT READ, though the rows are right there in hr_employees:
//
//   date_of_birth, gender, blood_group, nationality, marital status, address, emergency contacts,
//   pan_number, aadhaar_number, uan_number, esic_number, pf_number, every bank_* column, and
//   base_salary.
//
// Two different reasons, both worth stating. The identity and banking columns are not job-related
// evidence and a report is a document that gets forwarded — a payroll identifier in a development
// report is a data breach waiting for somebody to hit reply-all. The birth, gender and health-
// adjacent columns are protected attributes: recording one for a lawful statutory purpose and
// letting it reach a screen where somebody is forming a judgement are different acts, and this
// engine performs only the second kind. provenance.ts refuses them again at claim level, so a future
// edit to this SELECT does not quietly get them printed.
//
// base_salary is the interesting omission, because it is job-related and it is not protected. It is
// left out because compensation is one of the six consequential decisions and none of the nine
// reports informs it. A number nobody needs is a number that should not be in the document.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { toRows } from '@/lib/page-safety';
import { CAPABILITIES } from '../registry';
import { derivedClaim, evidenceRef, factClaim, feedbackClaim, sourceRef } from '../provenance';
import type {
  DerivedClaim, FactClaim, HumanFeedbackClaim, SourceLoad, SourceLoadContext, SourceProvider,
} from '../types';

const PROVIDER_ID = 'hrms.employment';
const SYSTEM = 'hrms';
const OWNER = 'HR patch (db/hr-schema.sql, src/lib/performance-schema.ts)';

function src(table: string, recordId?: string | null, capturedAt?: string | null) {
  return sourceRef({ provider: PROVIDER_ID, system: SYSTEM, table, ownedBy: OWNER, recordId, capturedAt });
}

/** postgres-js hands NUMERIC back as a string. A silent NaN in a report is worse than a blank. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  try {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  let total = 0;
  for (const v of values) total += v;
  return Number((total / values.length).toFixed(2));
}

export const hrEmploymentProvider: SourceProvider = {
  descriptor: {
    id: PROVIDER_ID,
    label: 'Employment records',
    system: SYSTEM,
    tables: [
      'hr_employees', 'departments',
      'hr_performance_reviews', 'hr_review_cycles',
      'hr_employee_skills', 'hr_skills',
      'hr_learning_assignments',
      'hr_feedback',
    ],
    ownedBy: OWNER,
    capabilities: [
      CAPABILITIES.EMPLOYEE_PROFILE,
      CAPABILITIES.EMPLOYEE_PERFORMANCE,
      CAPABILITIES.EMPLOYEE_SKILLS,
      CAPABILITIES.EMPLOYEE_LEARNING,
      CAPABILITIES.EMPLOYEE_FEEDBACK,
      CAPABILITIES.EMPLOYEE_REPORTS,
    ],
    sensitivity: 'standard',
  },

  async load(ctx: SourceLoadContext): Promise<SourceLoad> {
    const facts: FactClaim[] = [];
    const derived: DerivedClaim[] = [];
    const humanFeedback: HumanFeedbackClaim[] = [];
    const notes: string[] = [];

    // Applicant-subject reports never reach this provider with a usable id, and asking hr_employees
    // for a tal_application id would be a wasted round trip on every hiring report.
    if (ctx.subject.kind !== 'employee' && ctx.subject.kind !== 'manager') {
      return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes: ['Not an employment subject.'], error: null };
    }

    const employeeId = ctx.subject.id;
    const now = ctx.now;
    const stamp = ctx.stamp;
    const want = new Set(ctx.capabilities);
    const from = ctx.window ? ctx.window.from : null;
    const to = ctx.window ? ctx.window.to : null;

    // ---------------------------------------------------------------------------------------
    // PROFILE
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.EMPLOYEE_PROFILE)) {
      const rows = toRows(await db.execute(sql`
        SELECT e.id::text AS id, e.employee_code, e.full_name, e.designation,
               e.employment_type, e.work_mode, e.employment_status, e.onboarding_status,
               e.joining_date, e.confirmation_date, e.is_active, e.updated_at,
               d.name AS department_name
          FROM hr_employees e
          LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.id = ${employeeId}::uuid
         LIMIT 1`));
      const r: any = rows[0];
      if (!r) {
        notes.push('No employment record exists for this subject.');
      } else {
        const captured = iso(r.updated_at);
        const ev = [evidenceRef('employment_record', String(r.id), 'Employment record ' + String(r.employee_code || ''))];
        const add = (label: string, value: unknown, major = false) => {
          if (value === null || value === undefined || value === '') return;
          facts.push(factClaim({
            label, value: String(value), major, now, stamp,
            sources: [src('hr_employees', String(r.id), captured)],
            evidence: ev,
          }));
        };
        add('Employee code', r.employee_code, true);
        add('Designation', r.designation, true);
        add('Department', r.department_name);
        add('Employment type', r.employment_type);
        add('Work mode', r.work_mode);
        add('Employment status', r.employment_status, true);
        add('Onboarding status', r.onboarding_status);
        if (r.joining_date) {
          facts.push(factClaim({
            label: 'Joined', value: String(r.joining_date), occurredAt: iso(r.joining_date), major: true, now, stamp,
            sources: [src('hr_employees', String(r.id), captured)], evidence: ev,
          }));
        }
        if (r.confirmation_date) {
          facts.push(factClaim({
            label: 'Confirmed', value: String(r.confirmation_date), occurredAt: iso(r.confirmation_date), now, stamp,
            sources: [src('hr_employees', String(r.id), captured)], evidence: ev,
          }));
        }
        // TENURE IS DERIVED, NOT A FACT, even though it feels like one. The joining date is the
        // record; the number of months since is arithmetic this engine performed today, and it will
        // be a different number tomorrow. Putting it in section 1 would be the first small blur.
        const joined = iso(r.joining_date);
        if (joined) {
          const months = Math.max(0, Math.round((Date.parse(now) - Date.parse(joined)) / (1000 * 60 * 60 * 24 * 30.44)));
          derived.push(derivedClaim({
            label: 'Tenure', value: months, unit: 'months', basisCount: 1,
            method: 'Whole months between hr_employees.joining_date and the moment this report was generated.',
            now, stamp,
            sources: [src('hr_employees', String(r.id), captured)], evidence: ev,
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // PERFORMANCE — SUBMITTED REVIEWS ONLY
    // ---------------------------------------------------------------------------------------
    //
    // status <> 'submitted' rows are drafts. A draft rating is a reviewer thinking out loud, and it
    // has already changed by the time anybody reads it. Counting them would make the mean move
    // whenever somebody opened a form, which is not a property a report about a person should have.
    if (want.has(CAPABILITIES.EMPLOYEE_PERFORMANCE)) {
      const rows = toRows(await db.execute(sql`
        SELECT r.id::text AS id, r.overall_rating, r.goals_score, r.skills_score, r.attitude_score,
               r.strengths, r.improvements, r.submitted_at, r.updated_at,
               c.title AS cycle_title, c.period_start, c.period_end
          FROM hr_performance_reviews r
          JOIN hr_review_cycles c ON c.id = r.cycle_id
         WHERE r.employee_id = ${employeeId}::uuid
           AND r.status = 'submitted'
           AND (${from}::date IS NULL OR r.submitted_at >= ${from}::date)
           AND (${to}::date IS NULL OR r.submitted_at <= (${to}::date + 1))
         ORDER BY c.period_end DESC NULLS LAST, r.submitted_at DESC
         LIMIT 24`));

      if (!rows.length) {
        notes.push('No submitted performance review falls inside the window.');
      }
      const ratings: number[] = [];
      for (const raw of rows) {
        const r: any = raw;
        const rating = num(r.overall_rating);
        if (rating !== null) ratings.push(rating);
        const ev = [evidenceRef('performance_review', String(r.id), 'Review for ' + String(r.cycle_title || 'a cycle'))];
        facts.push(factClaim({
          label: 'Review submitted: ' + String(r.cycle_title || 'cycle'),
          value: rating === null ? 'submitted, no overall rating recorded' : 'overall rating ' + rating,
          occurredAt: iso(r.submitted_at),
          major: true, now, stamp,
          sources: [src('hr_performance_reviews', String(r.id), iso(r.updated_at))],
          evidence: ev,
        }));
        // Strengths and improvements are somebody's written opinion, so they belong in section 3
        // rather than section 1 — the row is a fact, the sentence inside it is a view.
        const written: { theme: string; body: unknown }[] = [
          { theme: 'strengths', body: r.strengths },
          { theme: 'improvements', body: r.improvements },
        ];
        for (const w of written) {
          if (!w.body || !String(w.body).trim()) continue;
          humanFeedback.push(feedbackClaim({
            author: { id: null, name: 'Review panel', relation: 'reviewer' },
            theme: w.theme,
            body: String(w.body).trim(),
            recordedAt: iso(r.submitted_at),
            // A formal review carries more weight than a passing comment, and less than 1.0 because
            // it is still one panel in one cycle.
            weight: 0.8,
            now, stamp,
            sources: [src('hr_performance_reviews', String(r.id), iso(r.updated_at))],
            evidence: ev,
          }));
        }
      }

      if (ratings.length) {
        const avg = mean(ratings);
        derived.push(derivedClaim({
          label: 'Mean overall rating', value: avg === null ? 0 : avg, basisCount: ratings.length,
          method: 'Arithmetic mean of hr_performance_reviews.overall_rating across submitted reviews in the window. Drafts excluded.',
          window: ctx.window, major: ratings.length >= 2, now, stamp,
          sources: [src('hr_performance_reviews')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('performance_review', String(raw.id), 'Review for ' + String(raw.cycle_title || 'a cycle'))),
        }));
        // DIRECTION, NOT TREND. Two points is a difference; calling it a trend is the interpreter's
        // job and it has to say what it is unsure about when it does.
        if (ratings.length >= 2) {
          const newest = ratings[0];
          const oldest = ratings[ratings.length - 1];
          derived.push(derivedClaim({
            label: 'Change in overall rating across the window',
            value: Number((newest - oldest).toFixed(2)),
            basisCount: ratings.length,
            method: 'Most recent submitted overall rating minus the earliest one in the window. Not a regression line.',
            window: ctx.window, now, stamp,
            sources: [src('hr_performance_reviews')],
            evidence: rows.slice(0, 2).map((raw: any) => evidenceRef('performance_review', String(raw.id), 'Review for ' + String(raw.cycle_title || 'a cycle'))),
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // SKILLS
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.EMPLOYEE_SKILLS)) {
      const rows = toRows(await db.execute(sql`
        SELECT es.id::text AS id, es.level, es.source, es.evidence, es.evidence_url, es.assessed_at,
               s.name AS skill_name, s.category
          FROM hr_employee_skills es
          JOIN hr_skills s ON s.id = es.skill_id
         WHERE es.employee_id = ${employeeId}::uuid
         ORDER BY es.level DESC, s.name ASC
         LIMIT 60`));

      let assessed = 0;
      for (const raw of rows) {
        const r: any = raw;
        // `source` distinguishes a skill somebody claimed from one somebody verified, and the two
        // must not read the same on a page where a decision is being formed. It is in the value.
        const verified = String(r.source || 'self') !== 'self';
        if (verified) assessed++;
        facts.push(factClaim({
          label: 'Skill: ' + String(r.skill_name),
          value: 'level ' + String(r.level) + (verified ? ', assessed by another person' : ', self-reported'),
          occurredAt: iso(r.assessed_at), now, stamp,
          sources: [src('hr_employee_skills', String(r.id), iso(r.assessed_at))],
          evidence: [evidenceRef(
            verified ? 'assessed_skill' : 'claimed_skill',
            String(r.id),
            String(r.skill_name) + ' at level ' + String(r.level),
            r.evidence_url ? String(r.evidence_url) : null,
          )],
        }));
      }
      if (rows.length) {
        derived.push(derivedClaim({
          label: 'Skills assessed by somebody other than the employee',
          value: assessed, unit: 'of ' + rows.length, basisCount: rows.length,
          method: 'Count of hr_employee_skills rows whose source is not "self". Self-reported skills are a claim, not evidence.',
          now, stamp,
          sources: [src('hr_employee_skills')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('skill_record', String(raw.id), String(raw.skill_name))),
        }));
      } else {
        notes.push('No skills are recorded against this person.');
      }
    }

    // ---------------------------------------------------------------------------------------
    // LEARNING
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.EMPLOYEE_LEARNING)) {
      const rows = toRows(await db.execute(sql`
        SELECT id::text AS id, course_id::text AS course_id, status, required, due_on, reason, created_at
          FROM hr_learning_assignments
         WHERE employee_id = ${employeeId}::uuid
         ORDER BY created_at DESC
         LIMIT 40`));
      let done = 0;
      for (const raw of rows) {
        const r: any = raw;
        if (String(r.status) === 'completed') done++;
        facts.push(factClaim({
          label: 'Learning assigned', value: String(r.status) + (r.required ? ', required' : ', optional')
            + (r.due_on ? ', due ' + String(r.due_on) : ''),
          occurredAt: iso(r.created_at), now, stamp,
          sources: [src('hr_learning_assignments', String(r.id), iso(r.created_at))],
          evidence: [evidenceRef('learning_assignment', String(r.id), 'Assignment ' + String(r.id).slice(0, 8))],
        }));
      }
      if (rows.length) {
        derived.push(derivedClaim({
          label: 'Assigned learning completed', value: done, unit: 'of ' + rows.length, basisCount: rows.length,
          method: 'Count of hr_learning_assignments rows with status "completed", over all assignments on record.',
          now, stamp,
          sources: [src('hr_learning_assignments')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('learning_assignment', String(raw.id), 'Assignment ' + String(raw.id).slice(0, 8))),
        }));
      } else {
        notes.push('No learning has been assigned to this person.');
      }
    }

    // ---------------------------------------------------------------------------------------
    // FEEDBACK — KEPT AS OPINIONS, WITH DISAGREEMENT PRESERVED
    // ---------------------------------------------------------------------------------------
    //
    // visible_to_manager = false is feedback the author asked to keep off a manager's screen. It is
    // filtered here for every audience rather than redacted later, because a report is forwardable
    // and "only the HR view shows it" survives exactly as long as nobody exports the HR view.
    if (want.has(CAPABILITIES.EMPLOYEE_FEEDBACK)) {
      const rows = toRows(await db.execute(sql`
        SELECT id::text AS id, kind, author_name, author_user_id::text AS author_user_id,
               theme, body, created_at
          FROM hr_feedback
         WHERE subject_employee_id = ${employeeId}::uuid
           AND visible_to_manager = TRUE
           AND (${from}::date IS NULL OR created_at >= ${from}::date)
           AND (${to}::date IS NULL OR created_at <= (${to}::date + 1))
         ORDER BY created_at DESC
         LIMIT 60`));

      const byTheme = new Map<string, number>();
      for (const raw of rows) {
        const r: any = raw;
        const theme = String(r.theme || 'general');
        byTheme.set(theme, (byTheme.get(theme) || 0) + 1);
      }
      for (const raw of rows) {
        const r: any = raw;
        const theme = String(r.theme || 'general');
        humanFeedback.push(feedbackClaim({
          author: {
            id: r.author_user_id ? String(r.author_user_id) : null,
            name: String(r.author_name || 'Unattributed'),
            relation: String(r.kind || 'continuous') === 'upward' ? 'report' : 'peer',
          },
          theme,
          body: String(r.body || '').trim(),
          recordedAt: iso(r.created_at),
          // AN UNATTRIBUTED VIEW WEIGHS LESS THAN A SIGNED ONE, and a theme only one person has
          // raised weighs less than one several have. Neither is averaged into a score anywhere —
          // the weight travels with the individual claim so a reader can see the reasoning.
          weight: (r.author_user_id ? 0.6 : 0.35) + ((byTheme.get(theme) || 1) > 1 ? 0.1 : 0),
          // ONE VOICE ON A THEME IS FLAGGED, NOT DISCARDED. A lone observation is often the true
          // one; it is marked so nobody reads it as a settled organisational view.
          outlier: (byTheme.get(theme) || 1) === 1 && rows.length > 3,
          now, stamp,
          sources: [src('hr_feedback', String(r.id), iso(r.created_at))],
          evidence: [evidenceRef('feedback_note', String(r.id), 'Feedback on ' + theme)],
        }));
      }
      if (!rows.length) notes.push('No shareable feedback has been recorded in the window.');
      else {
        derived.push(derivedClaim({
          label: 'Distinct themes raised in feedback', value: byTheme.size, basisCount: rows.length,
          method: 'Count of distinct hr_feedback.theme values across shareable feedback in the window.',
          window: ctx.window, now, stamp,
          sources: [src('hr_feedback')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('feedback_note', String(raw.id), 'Feedback on ' + String(raw.theme || 'general'))),
        }));
      }
    }

    // ---------------------------------------------------------------------------------------
    // DIRECT REPORTS — FOR THE MANAGER REPORT ONLY
    // ---------------------------------------------------------------------------------------
    //
    // hr_employees.reporting_manager_id HOLDS A users.id, NOT AN hr_employees.id. The column sits on
    // the employee table beside a dozen employee ids and reads exactly like another one; approverRole()
    // in hr-wallet.ts compares it to the signed-in user's id, which is the fact that settles it.
    // Joining it to hr_employees.id would return nobody, silently, and a manager report that says
    // "no direct reports" for every manager is a report nobody trusts twice.
    //
    // AGGREGATE ONLY. This returns counts, never a row per person: a development report for a manager
    // is not the place to publish a named list of how each of their people is rated.
    if (want.has(CAPABILITIES.EMPLOYEE_REPORTS)) {
      const rows = toRows(await db.execute(sql`
        SELECT COUNT(*)::int                                            AS team_size,
               COUNT(*) FILTER (WHERE e.employment_status = 'active')::int AS active_count,
               COUNT(*) FILTER (WHERE e.exit_date IS NOT NULL)::int         AS departed_count
          FROM hr_employees e
         WHERE e.reporting_manager_id = (SELECT m.user_id FROM hr_employees m WHERE m.id = ${employeeId}::uuid)
           AND e.reporting_manager_id IS NOT NULL`));
      const r: any = rows[0] || {};
      const teamSize = Number(r.team_size || 0);
      if (teamSize === 0) {
        notes.push('Nobody currently reports to this person, so the team measures are empty rather than zero.');
      } else {
        derived.push(derivedClaim({
          label: 'People reporting to this manager', value: teamSize, basisCount: teamSize,
          method: 'Count of hr_employees whose reporting_manager_id matches this employee user_id. Aggregate only; no row per person is read.',
          major: true, now, stamp,
          sources: [src('hr_employees')],
          evidence: [evidenceRef('team_roster', String(employeeId), 'Reporting line for this manager')],
        }));
        derived.push(derivedClaim({
          label: 'Departures from this team on record', value: Number(r.departed_count || 0), basisCount: teamSize,
          method: 'Count of that same set with a non-null exit_date. A count, not a rate: no leaver-per-year denominator is recorded here.',
          now, stamp,
          sources: [src('hr_employees')],
          evidence: [evidenceRef('team_roster', String(employeeId), 'Reporting line for this manager')],
        }));
      }
    }

    return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes, error: null };
  },
};
