// src/lib/talent/evaluations.ts — SCORED EVIDENCE, ONE SHAPE. Persists to tal_evaluation.
//
// WHY FOUR EVALUATION TYPES SHARE ONE TABLE
// ---------------------------------------------------------------------------------------------
// An assessment, an assignment, a functional evaluation and a portfolio review differ in WHO
// performs them and WHAT rubric they are scored against. They do not differ in structure: every one
// of them is "a named person looked at this candidate at this stage, gave a mark out of a maximum,
// and said advance / hold / decline, with comments." Four tables would have meant four readers,
// four admin screens and four slightly different answers to "what did the panel actually think" —
// which is precisely the fragmentation the talent platform exists to end. So: one row shape,
// differing by `evaluation_type`.
//
// AN INTERVIEW IS NOT ONE OF THEM. It has its own table, tal_interview, because it carries things
// no scored evaluation has — a schedule, a duration, a mode and a panel — and it is not written
// from this module. types.ts STAGE_EXPECTS_EVALUATION says so out loud: an `interview` or `panel`
// stage expects 'interview', which is deliberately NOT one of the four EvaluationType values, and
// that is the contract telling a reader to look in tal_interview instead of here.
//
// WHY THIS FILE IS THE ONE THAT GUARDS THE SCORE
// ---------------------------------------------------------------------------------------------
// src/lib/talent/stages.ts clears a stage by comparing its pass mark against the BEST percentage
// recorded here (bestScoreFor -> scorePercent). That comparison is only as trustworthy as what got
// stored. A mark of 130 out of 100 clears every pass threshold in the pipeline, silently and
// permanently, and no screen downstream has any way of knowing it was never a real score. So the
// ceiling is enforced at the moment of writing, in a sentence the evaluator can act on, rather than
// left to a reader that will never look.
//
// NOTHING HERE PENALISES ANYBODY AUTOMATICALLY. A recommendation is an opinion recorded against a
// candidate; panelVerdict() below reduces several opinions to one WORD, not to an outcome.
// Advancing, holding and declining are acts a human performs, through stages.ts and the selection
// decision — spec F12. `is_automated` marks a machine-produced evaluation as exactly that, and
// changes nothing about who decides.
//
// ---------------------------------------------------------------------------------------------
// THIS FILE WAS RECONCILED, AND IT MATTERS WHY
// ---------------------------------------------------------------------------------------------
// An earlier pass wrote every statement in here against a `tos_evaluations` table with columns
// (kind, title, evaluator_name, score, max_score, notes) — a table src/lib/talent/schema.ts does
// not create, alongside a vocabulary src/lib/talent/types.ts already owned. Nothing imported this
// module, so nothing had broken yet; the first screen to record an evaluation would have taken a
// "relation does not exist" straight to the evaluator. src/lib/talent/codes.ts carried the
// identical defect and was reconciled the same way.
//
// The vocabulary is now IMPORTED, never restated: EVALUATION_TYPES, EvaluationType,
// EvaluationRecommendation, EvaluationStatus and the Evaluation row shape all come from types.ts.
// The four kinds are therefore assessment / assignment / functional / portfolio (not the old
// assignment / assessment / interview / review), and the three recommendations are advance / hold /
// DECLINE (not 'reject'). One spelling of each, in one file, so two screens cannot disagree about
// what an evaluator said.
//
// WHERE THE DENOMINATOR LIVES
// ---------------------------------------------------------------------------------------------
// tal_evaluation has total_score and NO max_score column, and schema.ts is an OWNED CONTRACT
// extended additively by its owner — not by a consumer that wants one more column. The maximum
// therefore lives in the rubric, which is where a maximum belongs anyway: `rubric.maxScore`.
// maxScoreOf() below is the only reader of that key and recordEvaluation() is the only writer, so
// the number a mark is out of cannot drift from the number it was validated against.
import { uuidish } from '@/lib/page-safety';
import { logAudit } from '@/lib/audit';
import {
  rowsOf, reasonOf, okResult, failResult,
  EVALUATION_TYPES,
  type EvaluationType, type EvaluationRecommendation, type EvaluationStatus,
  type Evaluation, type TalentResult,
} from '@/lib/talent/types';

// Re-exported so a consumer has one import for the whole evaluation story, but DEFINED in types.ts.
// Nothing in this file may shadow it.
export { EVALUATION_TYPES };
export type { Evaluation, EvaluationType, EvaluationRecommendation, EvaluationStatus };

// ---------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/**
 * tal_evaluation.total_score is NUMERIC(6,2). A value at or above 10000 does not round — it raises
 * "numeric field overflow", which reaches the evaluator as a 500 rather than as a message. The
 * ceiling is therefore checked here, where it can be explained, not at the driver where it cannot.
 */
export const NUMERIC_CEILING = 9999.99;

/** The maximum a mark is out of when the rubric does not say. 100 makes a raw mark a percentage. */
export const DEFAULT_MAX_SCORE = 100;

/** How much comment text one evaluation may carry. Long enough for reasoning, not for a transcript. */
export const MAX_COMMENT_CHARS = 8000;

/**
 * The four types, each with the sentence an admin screen describes it by.
 *
 * A readonly array of objects rather than a keyed map, on purpose: this list is read in .astro
 * frontmatter, and a `Record<string, string>`-typed map reaching JSX breaks the Astro compiler on
 * this project. Arrays of objects render through .map() and never have.
 */
export const EVALUATION_TYPE_OPTIONS: readonly { key: EvaluationType; label: string; blurb: string }[] = [
  { key: 'assessment', label: 'Assessment', blurb: 'A timed or supervised test. Any automated flag it raises is advisory only; a human reads it and decides.' },
  { key: 'assignment', label: 'Assignment', blurb: 'A structured piece of real work, marked against a rubric the candidate was shown in advance.' },
  { key: 'functional', label: 'Functional evaluation', blurb: 'The people who would work with this person judging the work itself, against the rubric for the role.' },
  { key: 'portfolio',  label: 'Portfolio review', blurb: 'A reviewer reading published work, a portfolio and earlier evaluations together.' },
];

export const RECOMMENDATIONS: readonly { key: EvaluationRecommendation; label: string }[] = [
  { key: 'advance', label: 'Advance' },
  { key: 'hold',    label: 'Hold for another look' },
  { key: 'decline', label: 'Do not proceed' },
];

/**
 * Keyed on the union from types.ts rather than listed as strings, so ADDING a recommendation there
 * fails to compile here instead of silently arriving as an unrecognised value.
 */
const RECOMMENDATION_SET: Record<EvaluationRecommendation, true> = { advance: true, hold: true, decline: true };
const EVALUATION_STATUS_SET: Record<EvaluationStatus, true> = { pending: true, submitted: true, waived: true };

export function isEvaluationType(k: unknown): k is EvaluationType {
  return typeof k === 'string' && (EVALUATION_TYPES as readonly string[]).includes(k);
}

export function isRecommendation(k: unknown): k is EvaluationRecommendation {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(RECOMMENDATION_SET, k);
}

export function isEvaluationStatus(k: unknown): k is EvaluationStatus {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(EVALUATION_STATUS_SET, k);
}

/**
 * The maximum a mark is out of, read from the rubric. THE ONLY READER OF `rubric.maxScore`.
 *
 * ABSENT MEANS 100 — a rubric that does not state a maximum is marked out of a hundred, so a raw
 * mark is already a percentage. PRESENT BUT UNUSABLE MEANS ZERO, which is not a denominator at all:
 * normalisedScore() and stages.ts scorePercent() both report a non-positive maximum as "no
 * percentage", so a corrupt rubric makes its evaluation invisible to a pass check rather than
 * inventing a denominator nobody agreed to and clearing a threshold with it.
 */
export function maxScoreOf(rubric: unknown): number {
  const raw = (rubric && typeof rubric === 'object')
    ? (rubric as Record<string, any>).maxScore
    : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_SCORE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A mark as a percentage of its own maximum. PURE.
 *
 * Returns null — never Infinity, never NaN — when the denominator is zero, absent or unreadable.
 * That matters because the result is compared against a pass mark with a less-than, and both
 * Infinity and NaN answer that comparison confidently and wrongly: Infinity clears every threshold
 * there is, and NaN fails every one of them including a threshold of zero. A null says "there is no
 * percentage here", which is the only true answer, and every caller in stages.ts already handles it.
 */
export function normalisedScore(score: number | null, maxScore: number): number | null {
  if (score === null || score === undefined) return null;
  const s = Number(score);
  const max = Number(maxScore);
  if (!Number.isFinite(s)) return null;
  if (!Number.isFinite(max) || max <= 0) return null;
  return (s / max) * 100;
}

/**
 * Reduce a panel's recommendations to one. PURE.
 *
 * THE RULE, AND WHY IT IS THIS RULE.
 *
 * A single 'decline' does NOT veto. It is one person's opinion, and giving it a veto would make the
 * most sceptical member of every panel BE the panel — which is not what a panel is for, and which
 * quietly concentrates a hiring decision in whoever happens to be hardest to convince. Three
 * advances and one decline is a panel that wants to proceed, and it should read that way.
 *
 * A MAJORITY does decide. More than half the recorded opinions saying decline is the panel saying
 * decline, and the same for advance. (A lone decline on a panel of one is therefore a decline: it
 * is not a veto over anybody else, it is the entire panel.)
 *
 * TIES FALL TO 'hold'. Never to 'advance'. Two advances against two declines is a split panel, and
 * the safe default for a split panel is another look — another interview, another reference,
 * another pair of eyes — not a hire. An empty panel resolves the same way: nothing recorded is not
 * consent, and a verdict of 'advance' from zero opinions would be this module inventing agreement.
 *
 * Absent and unreadable recommendations are IGNORED rather than counted as anything. Treating a
 * blank as a hold would let an evaluator who simply did not fill the field in silently dilute a
 * real majority.
 *
 * THE VERDICT IS STILL ADVISORY. It is a word for a screen to show a human, never an input to a
 * write — spec F12.
 */
export function panelVerdict(recs: (string | null)[]): {
  verdict: EvaluationRecommendation;
  counts: { advance: number; hold: number; decline: number };
} {
  const counts = { advance: 0, hold: 0, decline: 0 };
  for (const raw of recs || []) {
    const r = String(raw || '').trim().toLowerCase();
    if (isRecommendation(r)) counts[r] += 1;
  }
  const total = counts.advance + counts.hold + counts.decline;
  if (total === 0) return { verdict: 'hold', counts };
  // Strictly more than half. `x * 2 > total` is exact at every panel size and avoids the floating
  // point division `x / total > 0.5` would introduce for no benefit whatsoever.
  if (counts.decline * 2 > total) return { verdict: 'decline', counts };
  if (counts.advance * 2 > total) return { verdict: 'advance', counts };
  return { verdict: 'hold', counts };
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_evaluation.
// ---------------------------------------------------------------------------------------------

/** A drizzle handle. Both it and drizzle's `sql` are resolved LAZILY — see ctx(). */
type SqlRunner = { execute: (query: any) => Promise<any> };

let _db: any = null;

/**
 * Schema first, then the connection.
 *
 * NOTHING ABOVE THIS LINE IMPORTS THE DATABASE, and that is deliberate rather than tidy: a
 * module-scope `import { ensureTalentSchema } from './schema'` pulls src/lib/db in with it, so
 * merely importing normalisedScore() or panelVerdict() — both pure, and both the parts most worth
 * testing — into a test would throw "DATABASE_URL is not set" before a single assertion ran.
 * types.ts carries the same note for the same reason, and src/lib/talent/events.ts resolves both
 * the same way. ensureTalentSchema() is memoised in schema.ts, so calling it at the top of every
 * entry point is free.
 */
async function ctx(): Promise<{ db: SqlRunner; sql: any }> {
  const { ensureTalentSchema } = await import('@/lib/talent/schema');
  await ensureTalentSchema();
  if (!_db) _db = (await import('@/lib/db')).db;
  const { sql } = await import('drizzle-orm');
  return { db: _db as SqlRunner, sql };
}

const EVALUATION_COLUMNS = `id, application_id, stage_key, evaluation_type, evaluator_user_id,
  rubric, scores, total_score, recommendation, comments, is_automated, status, submitted_at`;

/** A jsonb column reads back as an object; anything else is treated as an empty one. */
function objectOf(v: unknown): Record<string, any> {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, any>) : {};
}

/**
 * The per-criterion breakdown, as the contract types it: criterion -> number.
 *
 * A value that is not a finite number is DROPPED rather than coerced. It arrived from a jsonb
 * column that this module refuses to write anything else into, so its presence means a foreign
 * writer, and "criterion 'clarity' scored the string good" is not a number any reader can add up.
 */
function scoresOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const raw = objectOf(v);
  for (const key of Object.keys(raw)) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function toEvaluation(r: any): Evaluation {
  const type = String(r.evaluation_type || '');
  const rec = String(r.recommendation || '');
  const status = String(r.status || '');
  return {
    id: String(r.id),
    applicationId: String(r.application_id),
    stageKey: String(r.stage_key || ''),
    // evaluation_type is TEXT, so a value this module does not know about can exist. It reads as
    // 'assessment' rather than as itself: a type the UI has no label for renders as a blank chip.
    evaluationType: isEvaluationType(type) ? type : 'assessment',
    evaluatorUserId: r.evaluator_user_id ? String(r.evaluator_user_id) : null,
    rubric: objectOf(r.rubric),
    scores: scoresOf(r.scores),
    totalScore: r.total_score === null || r.total_score === undefined ? null : Number(r.total_score),
    recommendation: isRecommendation(rec) ? rec : null,
    comments: r.comments ? String(r.comments) : null,
    isAutomated: r.is_automated === true,
    // An unrecognised status reads as 'pending' — NOT as submitted. stages.ts counts only submitted
    // rows towards a pass mark, so the unreadable direction has to be the one that counts for
    // nothing rather than the one that clears a gate.
    status: isEvaluationStatus(status) ? status : 'pending',
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
  };
}

/** The per-criterion breakdown on the way IN, refused rather than silently mangled. */
function validateScores(input: unknown): { ok: true; scores: Record<string, number> } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, scores: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'The per-criterion scores have to be an object of criterion to number. Nothing was recorded.' };
  }
  const raw = input as Record<string, any>;
  const out: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `The score for "${key}" has to be a number. Nothing was recorded.` };
    }
    out[key] = n;
  }
  return { ok: true, scores: out };
}

export interface RecordEvaluationArgs {
  applicationId: string;
  stageKey: string;
  evaluationType: string;
  evaluatorUserId?: string | null;
  /** The raw mark. Null is legitimate: a qualitative evaluation carries a recommendation, not a number. */
  totalScore?: number | null;
  /** What the mark is out of. Stored in the rubric as `maxScore`; defaults to 100. */
  maxScore?: number | null;
  recommendation?: string | null;
  /** The rubric this was marked against. `maxScore` is written from the validated argument. */
  rubric?: Record<string, any> | null;
  /** Criterion -> number. The breakdown behind the total. */
  scores?: Record<string, any> | null;
  comments?: string | null;
  /** Machine-produced. Still ADVISORY — it changes who wrote the row, not who decides. Spec F12. */
  isAutomated?: boolean;
}

/**
 * Record one evaluation.
 *
 * VALIDATION IS THE POINT OF THIS FUNCTION, not the INSERT. Everything it refuses, it refuses with a
 * sentence the evaluator can act on, because the alternative to a readable refusal is not a clean
 * database — it is a stored number that quietly decides a pass-mark comparison months later:
 *
 *   * a mark ABOVE its maximum clears every threshold in the pipeline, forever, invisibly;
 *   * a NEGATIVE mark fails every threshold including one of zero, so a stray minus sign silently
 *     ends a candidacy;
 *   * a maximum of ZERO makes the percentage undefined, which normalisedScore() correctly reports as
 *     "no score" — meaning an evaluation that looks marked reads as unmarked to every pass check.
 *
 * The row is written SUBMITTED, with submitted_at NOW(): this module records COMPLETED evaluations.
 * There is no draft state to distinguish, and inventing one here would leave half-written marks
 * sitting on a decision screen looking like evidence. stages.ts counts only submitted rows, so a
 * pending invitation written by some other surface cannot clear a pass mark on its own.
 */
export async function recordEvaluation(args: RecordEvaluationArgs): Promise<TalentResult<{ id: string; audited: boolean }>> {
  try {
    const applicationId = uuidish(args.applicationId);
    if (!applicationId) {
      return failResult('That application reference is not a valid id, so no evaluation was recorded.');
    }

    const stageKey = String(args.stageKey || '').trim();
    if (!stageKey) {
      return failResult('An evaluation has to say which stage it belongs to. Nothing was recorded.');
    }

    const evaluationType = String(args.evaluationType || '').trim().toLowerCase();
    if (!isEvaluationType(evaluationType)) {
      return failResult(`"${args.evaluationType}" is not an evaluation type. Use one of: ${EVALUATION_TYPES.join(', ')}. An interview is recorded against tal_interview, not here.`);
    }

    // A maximum is what makes a mark a percentage. 100 is the default, so an evaluator who does not
    // think in maxima gets a percentage equal to the number they typed.
    const maxScore = args.maxScore === null || args.maxScore === undefined || String(args.maxScore).trim() === ''
      ? DEFAULT_MAX_SCORE
      : Number(args.maxScore);
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      return failResult('The maximum score has to be a number above zero. A maximum of zero leaves every percentage undefined, so nothing was recorded.');
    }
    if (maxScore > NUMERIC_CEILING) {
      return failResult(`The maximum score cannot be above ${NUMERIC_CEILING}. Nothing was recorded.`);
    }

    // A null score is legitimate and common: a qualitative evaluation carrying a recommendation and
    // no number is a real evaluation. It is only an actual NUMBER that has to obey the bounds.
    let totalScore: number | null = null;
    if (args.totalScore !== null && args.totalScore !== undefined && String(args.totalScore).trim() !== '') {
      const s = Number(args.totalScore);
      if (!Number.isFinite(s)) {
        return failResult('The score has to be a number, or left empty for a qualitative evaluation. Nothing was recorded.');
      }
      if (s < 0) {
        return failResult('A score cannot be negative. A negative mark fails every pass threshold in the pipeline, including a threshold of zero, so it is refused rather than stored.');
      }
      if (s > maxScore) {
        return failResult(`A score of ${s} is above the maximum of ${maxScore}. A mark above its own maximum clears every pass threshold downstream, so it is refused rather than stored. Correct the score, or raise the maximum if the rubric really does go that high.`);
      }
      totalScore = s;
    }

    let recommendation: EvaluationRecommendation | null = null;
    if (args.recommendation !== null && args.recommendation !== undefined && String(args.recommendation).trim() !== '') {
      const r = String(args.recommendation).trim().toLowerCase();
      if (!isRecommendation(r)) {
        return failResult(`"${args.recommendation}" is not a recommendation. Use one of: ${RECOMMENDATIONS.map((x) => x.key).join(', ')}.`);
      }
      recommendation = r;
    }

    const breakdown = validateScores(args.scores);
    if (!breakdown.ok) return failResult(breakdown.error);

    const evaluatorUserId = args.evaluatorUserId ? uuidish(args.evaluatorUserId) : null;
    const comments = String(args.comments || '').trim().slice(0, MAX_COMMENT_CHARS);
    const isAutomated = args.isAutomated === true;

    // maxScore is written from the VALIDATED value, last, so a caller cannot pass a rubric whose
    // own maxScore disagrees with the maximum their score was just checked against.
    const rubric: Record<string, any> = { ...objectOf(args.rubric), maxScore };
    // Serialised HERE rather than handed to the driver as an object, so a rubric carrying something
    // unserialisable fails on this line with a JS error naming the value, instead of arriving at
    // Postgres as the string "[object Object]" and being stored as a jsonb string forever.
    const rubricJson = JSON.stringify(rubric);
    const scoresJson = JSON.stringify(breakdown.scores);

    const { db, sql } = await ctx();
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO tal_evaluation (
        application_id, stage_key, evaluation_type, evaluator_user_id,
        rubric, scores, total_score, recommendation, comments, is_automated, status, submitted_at
      ) VALUES (
        ${applicationId}::uuid, ${stageKey}, ${evaluationType},
        ${evaluatorUserId ? sql`${evaluatorUserId}::uuid` : sql`NULL`},
        ${rubricJson}::jsonb, ${scoresJson}::jsonb,
        ${totalScore}::numeric, ${recommendation}, ${comments || null}, ${isAutomated},
        'submitted', NOW()
      ) RETURNING id
    `));
    if (!ins.length) {
      return failResult('The evaluation could not be read back after it was written, so it is not being reported as recorded.');
    }
    const id = String((ins[0] as any).id);

    // Audited WITH the mark. An evaluation is evidence in a hiring decision, and "who scored this
    // candidate what, and when" is the first question an appeal asks. The percentage is stored
    // alongside the raw pair so the audit row stays readable even if the rubric is edited later.
    //
    // A FAILED AUDIT DOES NOT UNWRITE THE EVALUATION — the row is committed and pretending otherwise
    // would be a second lie — so it is reported instead: `audited` says whether the trail exists.
    const audit = await logAudit({
      userId: evaluatorUserId,
      action: 'talent.evaluation.recorded',
      entity: 'talent_evaluation',
      entityId: id,
      diff: {
        applicationId,
        stageKey,
        evaluationType,
        totalScore,
        maxScore,
        percent: normalisedScore(totalScore, maxScore),
        recommendation,
        isAutomated,
      },
    });
    if (!audit.ok) {
      console.error('[talent-evaluations] audit write failed for ' + id + ': ' + (audit.error || 'unknown reason'));
    }

    return okResult({ id, audited: audit.ok === true });
  } catch (e: any) {
    // reasonOf(), not e.message: on a drizzle/postgres-js failure e.message is the SQL that failed
    // and the actual cause is on e.cause. Returning the statement instead of the reason is how a
    // failed write here would look like a mystery.
    return failResult(reasonOf(e));
  }
}

/**
 * Every evaluation on an application, newest first.
 *
 * The result carries `ok` as well as the rows, so a screen can tell "none recorded" from "could not
 * be read" without wrapping the call in anything. A supporting panel that would rather show an
 * empty section than a failure can still read `.data || []` and ignore the flag — but it has to
 * choose that, rather than have the choice made for it by a catch block returning [].
 *
 * Ordering is newest-first for the human reading it. The pass-mark rules in stages.ts take the best
 * percentage rather than the latest, so nothing downstream depends on this order.
 */
export async function listEvaluations(applicationId: string): Promise<TalentResult<Evaluation[]>> {
  try {
    const id = uuidish(applicationId);
    if (!id) return failResult('That application reference is not a valid id, so no evaluations were read.');
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(EVALUATION_COLUMNS)} FROM tal_evaluation
      WHERE application_id = ${id}::uuid
      ORDER BY created_at DESC
    `));
    return okResult(r.map(toEvaluation));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/**
 * The same list narrowed to one stage.
 *
 * A separate indexed query rather than a filter over the whole set: tal_evaluation carries
 * (application_id, evaluation_type) as an index and the per-stage panel does not have to read and
 * discard every other stage's marks.
 */
export async function listEvaluationsForStage(applicationId: string, stageKey: string): Promise<TalentResult<Evaluation[]>> {
  try {
    const id = uuidish(applicationId);
    const key = String(stageKey || '').trim();
    if (!id) return failResult('That application reference is not a valid id, so no evaluations were read.');
    if (!key) return failResult('A stage key is needed to read the evaluations for a stage.');
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(EVALUATION_COLUMNS)} FROM tal_evaluation
      WHERE application_id = ${id}::uuid AND stage_key = ${key}
      ORDER BY created_at DESC
    `));
    return okResult(r.map(toEvaluation));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/**
 * Remove an evaluation.
 *
 * THE ROW IS READ BEFORE IT IS DELETED, and its contents go into the audit diff. After the DELETE
 * there is nothing left to describe, so an audit entry written from the id alone would record that
 * something was removed without recording WHAT — which for this table is close to not auditing it.
 *
 * DELETING AN EVALUATION CHANGES A STAGE'S OUTCOME RETROACTIVELY. stages.ts clears a stage against
 * the best percentage recorded for it, so removing the highest-scoring evaluation can leave a stage
 * standing as passed on evidence that no longer exists anywhere. That is a genuine consequence of a
 * legitimate act — a mark entered against the wrong candidate has to be removable — so it is
 * audited loudly rather than prevented, and the stage should be decided again afterwards.
 */
export async function deleteEvaluation(id: string, actorUserId: string): Promise<TalentResult<{ audited: boolean }>> {
  try {
    const evaluationId = uuidish(id);
    if (!evaluationId) return failResult('That evaluation reference is not a valid id, so nothing was deleted.');
    const actor = uuidish(actorUserId);

    const { db, sql } = await ctx();
    const existing = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(EVALUATION_COLUMNS)} FROM tal_evaluation WHERE id = ${evaluationId}::uuid LIMIT 1
    `));
    if (!existing.length) {
      return failResult('That evaluation no longer exists. Nothing was deleted — it may already have been removed on another screen.');
    }
    const before = toEvaluation(existing[0]);

    const gone = rowsOf(await db.execute(sql`
      DELETE FROM tal_evaluation WHERE id = ${evaluationId}::uuid RETURNING id
    `));
    if (!gone.length) {
      // Somebody else deleted it between the read and the write. Reported honestly rather than as a
      // success, because a caller told "deleted" will go on to re-decide a stage on the assumption
      // that this evaluation is the one that just went away.
      return failResult('That evaluation was removed by someone else a moment ago. Nothing was deleted twice.');
    }

    const maxScore = maxScoreOf(before.rubric);
    const audit = await logAudit({
      userId: actor,
      action: 'talent.evaluation.deleted',
      entity: 'talent_evaluation',
      entityId: before.id,
      diff: {
        applicationId: before.applicationId,
        stageKey: before.stageKey,
        evaluationType: before.evaluationType,
        totalScore: before.totalScore,
        maxScore,
        percent: normalisedScore(before.totalScore, maxScore),
        recommendation: before.recommendation,
        evaluatorUserId: before.evaluatorUserId,
        isAutomated: before.isAutomated,
        status: before.status,
        comments: before.comments,
        scores: before.scores,
      },
    });
    if (!audit.ok) {
      console.error('[talent-evaluations] audit write failed for deleted ' + before.id + ': ' + (audit.error || 'unknown reason'));
    }

    return okResult({ audited: audit.ok === true });
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}
