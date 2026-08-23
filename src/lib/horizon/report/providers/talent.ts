// src/lib/horizon/report/providers/talent.ts — HIRING-SIDE SOURCE PROVIDER.
//
// Reads the talent patch's `tal_*` relations for the two applicant-subject reports.
//
// =================================================================================================
// THE THREE DISTINCTIONS THIS FILE EXISTS TO KEEP
// =================================================================================================
//
// 1. A SCORED EVALUATION IS TWO DIFFERENT THINGS IN ONE ROW. That a panel member submitted a mark of
//    72 out of 100 at the technical stage is a RECORD — the row exists and says so, and it goes in
//    section 1. What they wrote in `comments`, and whether they said advance or decline, is their
//    OPINION, and it goes in section 3 attributed to them. Splitting the row is the whole discipline
//    of this engine applied to the smallest case: the number is checkable, the view is arguable, and
//    a screen that renders them as one block invites a reader to treat the second as the first.
//
// 2. AN AUTOMATED EVALUATION IS NOT FEEDBACK. tal_evaluation.is_automated marks a mark no person
//    formed. It is emitted as a FACT — "a machine evaluation exists and recorded this score" — and
//    never as human feedback, because a machine in the peer-opinion section would silently add a
//    voice to a panel that never had one. What that score MEANS is section 4, and only the
//    interpreter writes section 4.
//
// 3. AN EVALUATOR SAYING "DECLINE" IS NOT A REJECTION. tal_evaluation.recommendation is one person
//    advising; tal_selection_decision is the organisation deciding, and its decided_by_user_id is
//    NOT NULL precisely so there is no automated path to it. The first lands in section 3 as an
//    opinion with a name on it. The second lands in section 6 as the decision. Nothing in this file
//    can turn the first into the second.
//
// =================================================================================================
// A KNOWN FORK, STATED RATHER THAN PAPERED OVER
// =================================================================================================
//
// This repository contains two parallel recruitment stacks: the `tal_*` relations read here, and a
// `tos_*` set. Which one is canonical is not this patch's decision and has not been made. This
// provider is registered against the `tal_*` set because that is the one with a live schema module
// and a wired console — but it reaches the engine through capability keys, so settling the fork
// later means registering a second provider for the same keys and deleting this one. No report
// definition, and no line of engine.ts, refers to a `tal_` table.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { toRows } from '@/lib/page-safety';
import { CAPABILITIES } from '../registry';
import {
  derivedClaim, evidenceRef, factClaim, feedbackClaim, humanDecisionClaim, sourceRef,
} from '../provenance';
import type {
  DerivedClaim, FactClaim, HumanDecisionClaim, HumanFeedbackClaim,
  SourceLoad, SourceLoadContext, SourceProvider,
} from '../types';

const PROVIDER_ID = 'talent.hiring';
const SYSTEM = 'talent';
const OWNER = 'Talent patch (src/lib/talent/schema.ts)';

function src(table: string, recordId?: string | null, capturedAt?: string | null) {
  return sourceRef({ provider: PROVIDER_ID, system: SYSTEM, table, ownedBy: OWNER, recordId, capturedAt });
}

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

export const talentHiringProvider: SourceProvider = {
  descriptor: {
    id: PROVIDER_ID,
    label: 'Hiring records',
    system: SYSTEM,
    tables: [
      'tal_application', 'tal_person', 'tal_opportunity',
      'tal_application_stage', 'tal_evaluation', 'tal_interview', 'tal_selection_decision',
    ],
    ownedBy: OWNER,
    capabilities: [
      CAPABILITIES.APPLICANT_PROFILE,
      CAPABILITIES.APPLICANT_PIPELINE,
      CAPABILITIES.APPLICANT_EVALUATIONS,
      CAPABILITIES.APPLICANT_INTERVIEWS,
      CAPABILITIES.APPLICANT_SELECTION,
    ],
    sensitivity: 'elevated',
  },

  async load(ctx: SourceLoadContext): Promise<SourceLoad> {
    const facts: FactClaim[] = [];
    const derived: DerivedClaim[] = [];
    const humanFeedback: HumanFeedbackClaim[] = [];
    const humanDecisions: HumanDecisionClaim[] = [];
    const notes: string[] = [];

    if (ctx.subject.kind !== 'applicant') {
      return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, notes: ['Not a hiring subject.'], error: null };
    }

    const applicationId = ctx.subject.id;
    const now = ctx.now;
    const stamp = ctx.stamp;
    const want = new Set(ctx.capabilities);

    // ---------------------------------------------------------------------------------------
    // PROFILE — THE APPLICATION, NOT THE PERSON
    // ---------------------------------------------------------------------------------------
    //
    // tal_person carries primary_email, primary_phone and country. None is read. A hiring report is
    // circulated to a panel and none of those three helps anybody assess anybody; the panel already
    // has the contact route through the console that owns it.
    if (want.has(CAPABILITIES.APPLICANT_PROFILE)) {
      const rows = toRows(await db.execute(sql`
        SELECT a.id::text AS id, a.application_code, a.status, a.current_stage_key,
               a.is_internal, a.submitted_at, a.closed_at, a.updated_at,
               p.display_name, p.person_code,
               o.title AS opportunity_title, o.employment_type, o.level, o.department_id
          FROM tal_application a
          JOIN tal_person p      ON p.id = a.person_id
          JOIN tal_opportunity o ON o.id = a.opportunity_id
         WHERE a.id = ${applicationId}::uuid
         LIMIT 1`));
      const r: any = rows[0];
      if (!r) {
        notes.push('No application exists with that identifier.');
      } else {
        const captured = iso(r.updated_at);
        const ev = [evidenceRef('application', String(r.id), 'Application ' + String(r.application_code || ''))];
        const add = (label: string, value: unknown, major = false) => {
          if (value === null || value === undefined || value === '') return;
          facts.push(factClaim({
            label, value: String(value), major, now, stamp,
            sources: [src('tal_application', String(r.id), captured)], evidence: ev,
          }));
        };
        add('Application code', r.application_code, true);
        add('Applied for', r.opportunity_title, true);
        add('Employment type', r.employment_type);
        add('Level', r.level);
        add('Current status', r.status, true);
        add('Current stage', r.current_stage_key);
        add('Internal applicant', r.is_internal ? 'yes' : 'no');
        if (r.submitted_at) {
          facts.push(factClaim({
            label: 'Applied on', value: String(iso(r.submitted_at) || r.submitted_at).slice(0, 10),
            occurredAt: iso(r.submitted_at), now, stamp,
            sources: [src('tal_application', String(r.id), captured)], evidence: ev,
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // PIPELINE
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.APPLICANT_PIPELINE)) {
      const rows = toRows(await db.execute(sql`
        SELECT id::text AS id, stage_key, ordinal, entered_at, due_at, completed_at, outcome
          FROM tal_application_stage
         WHERE application_id = ${applicationId}::uuid
         ORDER BY ordinal ASC
         LIMIT 40`));
      if (!rows.length) {
        notes.push('No pipeline stages are recorded for this application.');
      }
      let completed = 0;
      let overdue = 0;
      for (const raw of rows) {
        const r: any = raw;
        if (r.completed_at) completed++;
        const isOverdue = !r.completed_at && r.due_at && Date.parse(String(r.due_at)) < Date.parse(now);
        if (isOverdue) overdue++;
        facts.push(factClaim({
          label: 'Stage: ' + String(r.stage_key),
          value: r.completed_at
            ? 'completed' + (r.outcome ? ' with outcome ' + String(r.outcome) : '')
            : (isOverdue ? 'open, past its due date' : 'open'),
          occurredAt: iso(r.entered_at), now, stamp,
          sources: [src('tal_application_stage', String(r.id), iso(r.entered_at))],
          evidence: [evidenceRef('pipeline_stage', String(r.id), 'Stage ' + String(r.stage_key))],
        }));
      }
      if (rows.length) {
        derived.push(derivedClaim({
          label: 'Stages completed', value: completed, unit: 'of ' + rows.length, basisCount: rows.length,
          method: 'Count of tal_application_stage rows with a completed_at, over all stages on this application.',
          now, stamp, sources: [src('tal_application_stage')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('pipeline_stage', String(raw.id), 'Stage ' + String(raw.stage_key))),
        }));
        if (overdue > 0) {
          // A PROCESS FACT, NOT A CANDIDATE FACT. An application sitting past its due date says
          // something about the organisation, and the metric is worded so nobody reads it as a mark
          // against the person waiting.
          derived.push(derivedClaim({
            label: 'Stages the organisation has left open past their due date', value: overdue,
            unit: 'of ' + rows.length, basisCount: rows.length,
            method: 'Count of open tal_application_stage rows whose due_at has passed. This measures the process, not the applicant.',
            now, stamp, sources: [src('tal_application_stage')],
            evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('pipeline_stage', String(raw.id), 'Stage ' + String(raw.stage_key))),
          }));
        }
      }
    }

    // ---------------------------------------------------------------------------------------
    // EVALUATIONS — SPLIT INTO RECORD AND OPINION. See the header, distinctions 1-3.
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.APPLICANT_EVALUATIONS)) {
      const rows = toRows(await db.execute(sql`
        SELECT e.id::text AS id, e.stage_key, e.evaluation_type, e.total_score, e.rubric,
               e.recommendation, e.comments, e.is_automated, e.submitted_at,
               e.evaluator_user_id::text AS evaluator_user_id,
               u.name AS evaluator_name
          FROM tal_evaluation e
          LEFT JOIN users u ON u.id = e.evaluator_user_id
         WHERE e.application_id = ${applicationId}::uuid
           AND e.status = 'submitted'
         ORDER BY e.submitted_at DESC NULLS LAST
         LIMIT 40`));

      if (!rows.length) {
        notes.push('No submitted evaluation exists for this application.');
      }

      // Percentages, so a 40/50 and a 72/100 can be compared. maxScore lives in the rubric, which is
      // where src/lib/talent/evaluations.ts puts it and validates against it; tal_evaluation has no
      // max_score column and this provider must not invent one.
      const percents: number[] = [];
      const recommendations = new Map<string, number>();
      let automated = 0;

      for (const raw of rows) {
        const r: any = raw;
        const score = num(r.total_score);
        let maxScore: number | null = null;
        try {
          const rubric = typeof r.rubric === 'string' ? JSON.parse(r.rubric) : r.rubric;
          maxScore = num(rubric && rubric.maxScore);
        } catch { maxScore = null; }
        const pct = score !== null && maxScore !== null && maxScore > 0
          ? Number(((score / maxScore) * 100).toFixed(1))
          : null;
        if (pct !== null) percents.push(pct);

        const isAuto = r.is_automated === true;
        if (isAuto) automated++;

        const ev = [evidenceRef('evaluation', String(r.id), String(r.evaluation_type) + ' at ' + String(r.stage_key))];

        // (1) THE RECORD.
        facts.push(factClaim({
          label: (isAuto ? 'Automated evaluation: ' : 'Evaluation: ') + String(r.evaluation_type) + ' at ' + String(r.stage_key),
          value: score === null
            ? 'submitted, no score recorded'
            : String(score) + (maxScore !== null ? ' out of ' + maxScore : ' (the rubric records no maximum)')
              + (isAuto ? ', produced by a system rather than a person' : ''),
          occurredAt: iso(r.submitted_at), major: true, now, stamp,
          sources: [src('tal_evaluation', String(r.id), iso(r.submitted_at))], evidence: ev,
        }));

        // (2) THE OPINION — only when a person formed it.
        if (isAuto) continue;
        const rec = r.recommendation ? String(r.recommendation) : null;
        if (rec) recommendations.set(rec, (recommendations.get(rec) || 0) + 1);
        const body = [
          rec ? 'Recommends: ' + rec + '.' : '',
          r.comments ? String(r.comments).trim() : '',
        ].filter(Boolean).join(' ');
        if (body) {
          humanFeedback.push(feedbackClaim({
            author: {
              id: r.evaluator_user_id ? String(r.evaluator_user_id) : null,
              name: String(r.evaluator_name || 'An evaluator'),
              relation: 'reviewer',
            },
            theme: String(r.evaluation_type),
            body,
            recordedAt: iso(r.submitted_at),
            // A named evaluator on a rubric weighs more than an unattributed note, and still not 1.0:
            // it is one panel member at one stage.
            weight: r.evaluator_user_id ? 0.75 : 0.4,
            now, stamp,
            sources: [src('tal_evaluation', String(r.id), iso(r.submitted_at))], evidence: ev,
          }));
        }
      }

      if (percents.length) {
        const total = percents.reduce((a, b) => a + b, 0);
        derived.push(derivedClaim({
          label: 'Mean evaluation score', value: Number((total / percents.length).toFixed(1)), unit: 'percent',
          basisCount: percents.length, major: percents.length >= 2,
          method: 'Mean of total_score divided by the rubric maxScore, across submitted evaluations that record both. Evaluations with no maximum are excluded rather than assumed to be out of 100.',
          now, stamp, sources: [src('tal_evaluation')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('evaluation', String(raw.id), String(raw.evaluation_type))),
        }));
        if (percents.length !== rows.length) {
          notes.push('Of ' + rows.length + ' submitted evaluations, ' + percents.length + ' record a maximum score and could be compared.');
        }
      }
      if (automated > 0) {
        notes.push(automated + ' of the evaluations on this application were produced by a system, not by a person, and are shown as records rather than as views.');
      }
      // DISAGREEMENT IS A FINDING. A panel split three ways is the single most useful thing a
      // decision-support report can tell somebody, and averaging it away is how it gets lost.
      if (recommendations.size > 1) {
        const parts: string[] = [];
        for (const [k, v] of recommendations) parts.push(v + ' ' + k);
        derived.push(derivedClaim({
          label: 'The panel does not agree', value: parts.join(', '), basisCount: rows.length,
          method: 'Distinct values of tal_evaluation.recommendation across submitted human evaluations, counted. Reported as a split rather than reduced to a verdict.',
          major: true, now, stamp, sources: [src('tal_evaluation')],
          evidence: rows.slice(0, 8).map((raw: any) => evidenceRef('evaluation', String(raw.id), String(raw.evaluation_type))),
        }));
      }
    }

    // ---------------------------------------------------------------------------------------
    // INTERVIEWS
    // ---------------------------------------------------------------------------------------
    //
    // tal_interview.notes is deliberately NOT read. It is the panel's private write-up, it is not
    // structured, and it is the field most likely to contain an impression of somebody that nobody
    // intended to circulate. The scheduling record and the outcome are read; the prose is not.
    if (want.has(CAPABILITIES.APPLICANT_INTERVIEWS)) {
      const rows = toRows(await db.execute(sql`
        SELECT id::text AS id, stage_key, scheduled_at, duration_minutes, mode, outcome,
               jsonb_array_length(COALESCE(panel, '[]'::jsonb)) AS panel_size, created_at
          FROM tal_interview
         WHERE application_id = ${applicationId}::uuid
         ORDER BY scheduled_at DESC NULLS LAST
         LIMIT 20`));
      if (!rows.length) {
        notes.push('No interview is scheduled or recorded for this application.');
      }
      for (const raw of rows) {
        const r: any = raw;
        facts.push(factClaim({
          label: 'Interview at ' + String(r.stage_key),
          value: (r.outcome ? 'outcome ' + String(r.outcome) : 'no outcome recorded')
            + (r.mode ? ', ' + String(r.mode) : '')
            + (r.panel_size ? ', panel of ' + String(r.panel_size) : ''),
          occurredAt: iso(r.scheduled_at), major: true, now, stamp,
          sources: [src('tal_interview', String(r.id), iso(r.created_at))],
          evidence: [evidenceRef('interview', String(r.id), 'Interview at ' + String(r.stage_key))],
        }));
      }
    }

    // ---------------------------------------------------------------------------------------
    // SELECTION — SECTION 6, READ BACK UNCHANGED
    // ---------------------------------------------------------------------------------------
    if (want.has(CAPABILITIES.APPLICANT_SELECTION)) {
      const rows = toRows(await db.execute(sql`
        SELECT s.id::text AS id, s.selection_code, s.decision, s.reason, s.decided_at,
               s.decided_by_user_id::text AS decided_by_user_id, s.withdrawn_at, s.withdrawn_reason,
               u.name AS decided_by_name
          FROM tal_selection_decision s
          LEFT JOIN users u ON u.id = s.decided_by_user_id
         WHERE s.application_id = ${applicationId}::uuid
         LIMIT 1`));
      const r: any = rows[0];
      if (!r) {
        notes.push('No selection decision has been recorded on this application yet.');
      } else {
        humanDecisions.push(humanDecisionClaim({
          decidedByUserId: String(r.decided_by_user_id),
          decidedByName: String(r.decided_by_name || 'A named decision-maker'),
          decidedAt: iso(r.decided_at),
          decision: String(r.decision) + '. Reason given: ' + String(r.reason),
          decisionKind: 'hiring',
          // tal_selection_decision has no column recording whether a recommendation was in front of
          // the decider, so this is null rather than false. Claiming they departed from advice they
          // may never have seen would be a fabrication in the one section that must not contain one.
          followedRecommendation: null,
          overrideReason: null,
          recommendationId: null,
          now, stamp,
          sources: [src('tal_selection_decision', String(r.id), iso(r.decided_at))],
          evidence: [evidenceRef('selection_decision', String(r.id), 'Selection ' + String(r.selection_code || ''))],
        }));
        if (r.withdrawn_at) {
          facts.push(factClaim({
            label: 'Selection withdrawn', value: String(r.withdrawn_reason || 'no reason recorded'),
            occurredAt: iso(r.withdrawn_at), major: true, now, stamp,
            sources: [src('tal_selection_decision', String(r.id), iso(r.withdrawn_at))],
            evidence: [evidenceRef('selection_decision', String(r.id), 'Selection ' + String(r.selection_code || ''))],
          }));
        }
      }
    }

    return { ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback, humanDecisions, notes, error: null };
  },
};
