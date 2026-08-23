// src/lib/horizon/feedback/capture.ts — THE WRITE PATH. Everything that turns a form into a row.
//
// =================================================================================================
// EVIDENCE IS A REQUIREMENT, NOT A FIELD
// =================================================================================================
//
// A structured item cannot be SUBMITTED with ratings and nothing written. It can be saved as a
// draft, and the author is told what their evidence will count as before they send it — but a bare
// number about a named person, sitting on their record where their manager will read it, is not
// something this module will accept.
//
// The check is on the SUBMIT path only. Draft is deliberately free: forcing prose before somebody
// has finished thinking is how you get prose written to satisfy a validator.
//
// =================================================================================================
// A CLAIMED SOURCE TYPE IS CHECKED, RECORDED EITHER WAY, AND NEVER SILENTLY UPGRADED
// =================================================================================================
//
// The form says "I am their reporting manager". The Organization Graph is asked whether that is
// true today. Three outcomes and all three are recorded:
//
//   confirmed        source_verified = true, with the edge that confirmed it named in the note.
//   not in the graph source_verified = false, note says so. THE ITEM IS STILL ACCEPTED. On a
//                    database where nobody has run the org-graph backfill, every edge is missing;
//                    refusing feedback until an admin does data entry would mean the graph being
//                    empty silently switches the feedback system off.
//   contradicted     the graph names somebody else as the reporting manager. Recorded as
//                    unverified, with the contradiction in the note, and the item is still accepted.
//                    A person who has just changed teams is the ordinary case here, not a liar.
//
// WHAT VERIFICATION CHANGES: nothing about acceptance, and nothing about weight in version 1.0.0 —
// weight is a function of source KIND, evidence and recency. It changes what the screen says, and it
// is the field the people desk filters on when a source list looks wrong. Making it a weight
// multiplier is a policy change, not a mechanism change, and needs somebody to decide it.
//
// =================================================================================================
// EVERY WRITE IS AUDITED. NOTHING IS EVER DELETED.
// =================================================================================================
//
// Withdrawal is a status and a reason. There is no delete function in this module and adding one
// would take an item's own audit trail with it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { notifyUser } from '@/lib/notify';
import { clean, isUuid, logFail, rowsOf } from '@/lib/performance-scope';
import { getManager, isReportingManager, isDepartmentHead } from '@/lib/org-graph';
import { ensureHorizonFeedbackSchema } from './schema';
import { classifyEvidence } from './aggregate';
import {
  FEEDBACK_CONTEXTS,
  FEEDBACK_SOURCE_LABELS,
  isFeedbackDimension,
  isFeedbackSourceType,
  type EvidenceQuality,
  type FeedbackConfidentiality,
  type FeedbackContext,
  type FeedbackDimension,
  type FeedbackSourceType,
} from './types';

const MOD = 'horizon-feedback-capture';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** Ratings live on 1..5, the same scale the appraisal console already uses. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

export interface CaptureResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Present on success: what the stored item will count as, so the screen can say it back. */
  evidenceQuality?: EvidenceQuality;
  sourceVerified?: boolean;
  sourceVerifiedNote?: string;
}

export interface SubmitFeedbackInput {
  subjectEmployeeId: string;
  authorUserId: string;
  authorEmployeeId?: string | null;
  authorName?: string | null;
  /** What the author says they are. Checked against the graph; see the header. */
  sourceType: FeedbackSourceType;
  context: FeedbackContext;
  contextNote?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** The written evidence. Required to submit, optional to draft. */
  evidence: string;
  /** The free note. Optional — `evidence` is the field that carries the weight. */
  body?: string | null;
  confidentiality?: FeedbackConfidentiality;
  overallRating?: number | null;
  ratings: { dimension: string; rating: number; comment?: string | null }[];
  examples?: { dimension?: string | null; occurredOn?: string | null; description: string; referenceUrl?: string | null }[];
  /** 'draft' saves without validation of evidence. 'submitted' is the real thing. */
  status?: 'draft' | 'submitted';
  /** Set when the item belongs to an appraisal cycle. Owned by performance.ts. */
  cycleId?: string | null;
}

// =================================================================================================
// SOURCE VERIFICATION
// =================================================================================================

export interface SourceCheck {
  verified: boolean;
  note: string;
}

/**
 * Ask the Organization Graph whether the claimed relationship holds RIGHT NOW, and write down the
 * answer in a sentence a human can read six months later.
 *
 * NO ROLE NAMES. `hr` is the one source type the graph cannot express — the people desk is a
 * capability, not an edge — so it is verified by the CAPABILITY the caller already resolved and
 * passes in. That is the correct layer for it: "is this person on the people desk" is a per-user
 * question and the graph answers per-row questions.
 *
 * Never throws. A graph that is unreachable returns unverified with the reason, which is the
 * fail-closed direction for a claim.
 */
export async function verifySource(args: {
  claimed: FeedbackSourceType;
  authorEmployeeId: string | null;
  subjectEmployeeId: string;
  /** The composed context's answer for `performance.manage`. Used only for the `hr` claim. */
  authorHoldsPeopleDesk: boolean;
}): Promise<SourceCheck> {
  const { claimed, authorEmployeeId, subjectEmployeeId } = args;

  if (claimed === 'self') {
    const same = !!authorEmployeeId && authorEmployeeId === subjectEmployeeId;
    return same
      ? { verified: true, note: 'Self-reflection: the author and the subject are the same employee record.' }
      : { verified: false, note: 'Marked as self-reflection but written about a different employee record.' };
  }

  if (claimed === 'hr') {
    return args.authorHoldsPeopleDesk
      ? { verified: true, note: 'The author holds the organisation-wide people-desk capability.' }
      : { verified: false, note: 'Recorded as a people-desk item, but the author does not hold the '
          + 'organisation-wide people-desk capability.' };
  }

  if (!isUuid(authorEmployeeId) || !isUuid(subjectEmployeeId)) {
    return { verified: false, note: 'The author or the subject has no employee record, so the '
      + 'Organization Graph could not be asked.' };
  }

  try {
    if (claimed === 'reporting_manager') {
      const direct = await isReportingManager(String(authorEmployeeId), subjectEmployeeId);
      if (direct) {
        return { verified: true, note: 'The Organization Graph records a reporting_manager edge from '
          + 'the author to this person, in force today.' };
      }
      const actual = await getManager(subjectEmployeeId);
      if (actual?.employeeId) {
        return { verified: false, note: 'The Organization Graph records ' + (actual.fullName || 'somebody else')
          + ' as this person\'s reporting manager today, not the author. The item is kept — a recent '
          + 'team change looks exactly like this.' };
      }
      return { verified: false, note: 'The Organization Graph records no reporting manager for this '
        + 'person, so the claim could not be confirmed either way.' };
    }

    if (claimed === 'team_lead') {
      // A team_lead edge has scope but no object: somebody leads a TEAM, not a named person. The
      // graph exposes no "is X the lead of Y's team" helper and this module must not write its own
      // query against org_relationships — that is the drift org-graph.ts's header forbids, and the
      // way two modules start disagreeing about who leads what. So the honest answer is the
      // department-head edge where it exists, and unverified otherwise.
      const rows = rowsOf(await db.execute(sql`
        SELECT department_id::text AS department_id FROM hr_employees
         WHERE id = ${subjectEmployeeId}::uuid LIMIT 1`));
      const dept = rows.length && rows[0]?.department_id ? String(rows[0].department_id) : '';
      if (dept && await isDepartmentHead(String(authorEmployeeId), dept)) {
        return { verified: true, note: 'The Organization Graph records the author as head of this '
          + 'person\'s department.' };
      }
      return { verified: false, note: 'Team lead is a team-scoped edge in the Organization Graph and '
        + 'is not asserted against a named person, so this claim is recorded as stated rather than '
        + 'confirmed. See the handoff note on getTeamLeadFor().' };
    }

    // peer: there is no "is a colleague" edge and there should not be one. Both being active
    // employees is the whole of the claim, and it is checked by the caller resolving the recipient
    // list from the graph in the first place.
    return { verified: true, note: 'Recorded as a colleague. Colleague is not a relationship the '
      + 'Organization Graph asserts, so this means both people are employees, and no more than that.' };
  } catch (e: any) {
    logFail(MOD, 'verifySource', e);
    return { verified: false, note: 'The Organization Graph could not be read when this was written, '
      + 'so the claimed relationship is recorded as unconfirmed.' };
  }
}

// =================================================================================================
// VALIDATION — pure, exported, and used by the form BEFORE the submit as well as by the write.
// =================================================================================================

export interface ValidationProblem {
  field: string;
  message: string;
}

/**
 * Everything wrong with an item, all at once.
 *
 * RETURNS EVERY PROBLEM rather than the first. A form that reveals one error per round trip is how
 * somebody abandons a feedback item halfway through, and an abandoned item is a source that does not
 * appear in the aggregate — which is the failure mode this whole patch is built to avoid.
 */
export function validateSubmission(input: SubmitFeedbackInput): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const submitting = (input.status || 'submitted') === 'submitted';

  if (!isUuid(input.subjectEmployeeId)) {
    problems.push({ field: 'subject', message: 'Choose who this feedback is about.' });
  }
  if (!isUuid(input.authorUserId)) {
    problems.push({ field: 'author', message: 'Sign in before writing feedback.' });
  }
  if (!isFeedbackSourceType(input.sourceType)) {
    problems.push({ field: 'source_type', message: 'Say what your relationship to this person is.' });
  }
  if ((FEEDBACK_CONTEXTS as readonly string[]).indexOf(String(input.context)) < 0) {
    problems.push({ field: 'context', message: 'Say what circumstance this feedback is about.' });
  }

  if (input.sourceType === 'self') {
    if (input.authorEmployeeId && String(input.authorEmployeeId) !== String(input.subjectEmployeeId)) {
      problems.push({ field: 'source_type', message: 'A self-reflection has to be about your own record.' });
    }
  } else if (input.authorEmployeeId && String(input.authorEmployeeId) === String(input.subjectEmployeeId)) {
    problems.push({
      field: 'subject',
      message: 'This is about you. Write it as a self-reflection so it is not averaged in as if '
        + 'somebody else had said it.',
    });
  }

  const ratings = Array.isArray(input.ratings) ? input.ratings : [];
  const seen = new Set<string>();
  for (const r of ratings) {
    if (!isFeedbackDimension(r.dimension)) {
      problems.push({ field: 'ratings', message: 'Unknown dimension: ' + String(r.dimension).slice(0, 40) });
      continue;
    }
    if (seen.has(r.dimension)) {
      problems.push({ field: 'ratings', message: 'Two ratings given for ' + r.dimension + '.' });
    }
    seen.add(r.dimension);
    const n = Number(r.rating);
    if (!Number.isFinite(n) || n < RATING_MIN || n > RATING_MAX) {
      problems.push({
        field: 'ratings',
        message: 'Ratings run from ' + RATING_MIN + ' to ' + RATING_MAX + '. Leave a dimension blank '
          + 'if you did not see it — a blank is honest and a guess is not.',
      });
    }
  }

  if (submitting && ratings.length === 0 && !clean(input.evidence, 10)) {
    problems.push({ field: 'ratings', message: 'Rate at least one dimension, or write something.' });
  }

  // THE EVIDENCE REQUIREMENT. Submit only.
  if (submitting && ratings.length > 0) {
    const evidence = clean(input.evidence, 8000);
    const examples = Array.isArray(input.examples) ? input.examples.filter((e) => clean(e.description, 10)) : [];
    if (!evidence && examples.length === 0) {
      problems.push({
        field: 'evidence',
        message: 'Write what you saw that makes you say this, or add an example. A rating with '
          + 'nothing behind it goes on somebody\'s record and cannot be discussed.',
      });
    } else if (evidence.length > 0 && evidence.length < 25 && examples.length === 0) {
      problems.push({
        field: 'evidence',
        message: 'That is too short to be evidence. Name what happened, or add an example with a date.',
      });
    }
  }

  if (input.overallRating !== null && input.overallRating !== undefined) {
    const n = Number(input.overallRating);
    if (!Number.isFinite(n) || n < RATING_MIN || n > RATING_MAX) {
      problems.push({ field: 'overall_rating', message: 'An overall rating runs from 1 to 5.' });
    }
  }

  const ps = clean(input.periodStart, 20);
  const pe = clean(input.periodEnd, 20);
  if (ps && pe && ps > pe) {
    problems.push({ field: 'period', message: 'The period ends before it starts.' });
  }

  return problems;
}

/**
 * What this item WILL count as, computed before it is saved so the form can say it out loud.
 *
 * Telling somebody "as written, this will count for a third of what it could" while they can still
 * do something about it is worth more than every downstream correction put together.
 */
export function previewEvidenceQuality(input: {
  evidence: string;
  examples?: { description: string }[];
}): { quality: EvidenceQuality; advice: string } {
  const examples = (input.examples || []).filter((e) => clean(e.description, 10)).length;
  const quality = classifyEvidence(String(input.evidence || ''), examples);
  const advice = quality === 'specific'
    ? 'This names something that happened, so it carries full weight.'
    : quality === 'general'
      ? 'This is written but nothing anybody could check. Adding one dated example would roughly '
        + 'half again what it counts for.'
      : 'With nothing written behind it, this counts for the least the system gives anything. '
        + 'A sentence naming what you saw changes that.';
  return { quality, advice };
}

// =================================================================================================
// THE WRITE
// =================================================================================================

/**
 * Save one structured feedback item, with its dimension ratings and its examples.
 *
 * THREE STATEMENTS, ONE TRANSACTION. The parent, the ratings and the examples go together or not at
 * all: a parent row with no dimension rows is an item that silently contributes nothing to any
 * aggregate while appearing on every list, which is worse than a failed save.
 */
export async function submitStructuredFeedback(
  input: SubmitFeedbackInput,
  ctx: { authorHoldsPeopleDesk: boolean },
): Promise<CaptureResult> {
  const problems = validateSubmission(input);
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(' ') };

  const subject = String(input.subjectEmployeeId);
  const author = String(input.authorUserId);
  const authorEmployeeId = isUuid(input.authorEmployeeId) ? String(input.authorEmployeeId) : null;
  const authorName = clean(input.authorName, 200) || null;
  const status = input.status === 'draft' ? 'draft' : 'submitted';
  const sourceType = input.sourceType;
  const context = String(input.context);
  const contextNote = clean(input.contextNote, 1000) || null;
  const evidence = clean(input.evidence, 8000);
  // `body` keeps its existing meaning for the older feedback surface, which renders it. When the
  // author wrote only evidence, the evidence is what that surface should show.
  const body = clean(input.body, 4000) || evidence || '(rating only)';
  const confidentiality: FeedbackConfidentiality =
    input.confidentiality === 'hr_channel' ? 'hr_channel' : 'standard';
  // THE BRIDGE TO THE EXISTING READER. performance.ts feedbackFor({asManager:true}) filters on
  // visible_to_manager and knows nothing about `confidentiality`. Writing both keeps that reader
  // correct without it having to change.
  const visibleToManager = confidentiality === 'standard';
  const cycleId = isUuid(input.cycleId) ? String(input.cycleId) : null;
  const periodStart = clean(input.periodStart, 20) || null;
  const periodEnd = clean(input.periodEnd, 20) || null;
  const overall = input.overallRating === null || input.overallRating === undefined
    ? null
    : Number(input.overallRating);

  const ratings = (input.ratings || [])
    .filter((r) => isFeedbackDimension(r.dimension))
    .map((r) => ({
      dimension: r.dimension as FeedbackDimension,
      rating: Number(r.rating),
      comment: clean(r.comment, 1000) || null,
    }));
  const examples = (input.examples || [])
    .map((e) => ({
      dimension: isFeedbackDimension(e.dimension) ? String(e.dimension) : null,
      occurredOn: clean(e.occurredOn, 20) || null,
      description: clean(e.description, 2000),
      referenceUrl: clean(e.referenceUrl, 1000) || null,
    }))
    .filter((e) => e.description.length > 0)
    .slice(0, 10);

  const evidenceQuality = classifyEvidence(evidence, examples.length);

  const check = await verifySource({
    claimed: sourceType,
    authorEmployeeId,
    subjectEmployeeId: subject,
    authorHoldsPeopleDesk: ctx.authorHoldsPeopleDesk === true,
  });

  try {
    await ensureHorizonFeedbackSchema();

    // ONE TRANSACTION. db.transaction is the drizzle wrapper over the same postgres-js client every
    // other write in this module family uses, so the rows and the connection behaviour are the same.
    let newId = '';
    await db.transaction(async (tx: any) => {
      const parent = rowsOf(await tx.execute(sql`
        INSERT INTO hr_feedback
          (kind, subject_employee_id, author_user_id, author_employee_id, author_name, cycle_id,
           theme, body, visible_to_manager,
           source_type, source_verified, source_verified_note,
           context, context_note, period_start, period_end,
           evidence, evidence_quality, confidentiality, status, overall_rating)
        VALUES
          (${cycleId ? '360' : 'structured'}, ${subject}::uuid, ${author}::uuid,
           ${authorEmployeeId}::uuid, ${authorName}::text, ${cycleId}::uuid,
           'general', ${body}, ${visibleToManager},
           ${sourceType}, ${check.verified}, ${check.note},
           ${context}, ${contextNote}, ${periodStart}::date, ${periodEnd}::date,
           ${evidence || null}, ${evidenceQuality}, ${confidentiality}, ${status}, ${overall})
        RETURNING id`));
      if (!parent.length) throw new Error('insert returned no row');
      newId = String(parent[0].id);

      for (const r of ratings) {
        await tx.execute(sql`
          INSERT INTO hr_feedback_dimensions (feedback_id, dimension, rating, comment)
          VALUES (${newId}::uuid, ${r.dimension}, ${r.rating}, ${r.comment})
          ON CONFLICT (feedback_id, dimension) DO UPDATE
            SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`);
      }
      for (const e of examples) {
        await tx.execute(sql`
          INSERT INTO hr_feedback_examples (feedback_id, dimension, occurred_on, description, reference_url)
          VALUES (${newId}::uuid, ${e.dimension}, ${e.occurredOn}::date, ${e.description}, ${e.referenceUrl})`);
      }
    });

    if (!newId) return { ok: false, error: WRITE_FAILED };

    // THE SUBJECT IS TOLD. Feedback that lands on somebody's record without their knowing is a file
    // kept on them. The notification names the author, because the item does.
    if (status === 'submitted' && sourceType !== 'self') {
      await notifySubject(subject, {
        title: 'New feedback on your record',
        body: (authorName || 'A colleague') + ' recorded structured feedback about your work.',
        entityId: newId,
      });
    }

    await logAudit({
      userId: author,
      action: status === 'draft' ? 'feedback.structured.draft' : 'feedback.structured.submit',
      entity: 'hr_feedback',
      entityId: newId,
      diff: {
        subjectEmployeeId: subject,
        sourceType,
        sourceVerified: check.verified,
        context,
        confidentiality,
        evidenceQuality,
        dimensionCount: ratings.length,
        exampleCount: examples.length,
      },
    });

    return {
      ok: true,
      id: newId,
      evidenceQuality,
      sourceVerified: check.verified,
      sourceVerifiedNote: check.note,
    };
  } catch (e: any) {
    logFail(MOD, 'submitStructuredFeedback', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Withdraw an item. The AUTHOR may withdraw their own; the people desk may withdraw any.
 *
 * NOT A DELETE, AND THERE IS NO DELETE. The row keeps its content, its author and its date, drops
 * out of every aggregate, and gains a reason. An item that could be erased could be erased by
 * whoever it embarrassed.
 */
export async function withdrawFeedback(args: {
  feedbackId: string;
  actorUserId: string;
  actorHoldsPeopleDesk: boolean;
  reason: string;
}): Promise<CaptureResult> {
  if (!isUuid(args.feedbackId)) return { ok: false, error: 'Unknown item.' };
  if (!isUuid(args.actorUserId)) return { ok: false, error: 'Sign in first.' };
  const reason = clean(args.reason, 1000);
  if (!reason) return { ok: false, error: 'Say why it is being withdrawn. The reason stays on the record.' };

  try {
    await ensureHorizonFeedbackSchema();
    // The authorisation is IN THE WHERE CLAUSE, not in an if() above it. A check that happens in
    // application code and a write that happens in SQL are two moments, and the row can change
    // between them.
    const guard = args.actorHoldsPeopleDesk
      ? sql``
      : sql`AND author_user_id = ${String(args.actorUserId)}::uuid`;
    const rows = rowsOf(await db.execute(sql`
      UPDATE hr_feedback
         SET status = 'withdrawn',
             withdrawn_at = NOW(),
             withdrawn_reason = ${reason},
             withdrawn_by_user_id = ${String(args.actorUserId)}::uuid
       WHERE id = ${String(args.feedbackId)}::uuid
         AND status <> 'withdrawn'
         ${guard}
      RETURNING id, subject_employee_id`));
    if (!rows.length) {
      return { ok: false, error: 'That item is not yours to withdraw, or it was already withdrawn.' };
    }
    await logAudit({
      userId: String(args.actorUserId),
      action: 'feedback.structured.withdraw',
      entity: 'hr_feedback',
      entityId: String(rows[0].id),
      diff: { reason, byPeopleDesk: args.actorHoldsPeopleDesk === true },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'withdrawFeedback', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Notify the person the feedback is about. Never throws; a failed notification is not a failed save. */
async function notifySubject(
  employeeId: string,
  opts: { title: string; body: string; entityId: string },
): Promise<void> {
  if (!isUuid(employeeId)) return;
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
    const userId = rows.length && rows[0]?.user_id ? String(rows[0].user_id) : '';
    if (!isUuid(userId)) return;
    await notifyUser(userId, {
      title: opts.title,
      body: opts.body,
      type: 'info',
      actionUrl: '/portal/employee/feedback?view=about-me',
      entityType: 'performance',
      entityId: opts.entityId,
    });
  } catch (e: any) {
    logFail(MOD, 'notifySubject', e);
  }
}

/** The label set a form needs, so a screen never hard-codes a source name. */
export const SOURCE_OPTIONS = (Object.keys(FEEDBACK_SOURCE_LABELS) as FeedbackSourceType[])
  .filter((k) => k !== 'self')
  .map((k) => ({ value: k, label: FEEDBACK_SOURCE_LABELS[k] }));
