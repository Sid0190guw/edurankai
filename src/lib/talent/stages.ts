// src/lib/talent/stages.ts — THE CONFIGURABLE EVALUATION PIPELINE.
// Persists to tal_pipeline, tal_pipeline_stage and tal_application_stage; reads tal_evaluation.
//
// WHY A SECOND STAGE MODEL EXISTS AT ALL, AND HOW IT AVOIDS BEING A SECOND TRUTH
// ---------------------------------------------------------------------------------------------
// src/lib/application-stages.ts already defines a SIX-step funnel, hard-coded, and it is what the
// candidate is shown at /portal/applications/[id]. It is also a published promise: /policy/recruitment
// says "Six steps. No surprises." That file is not being replaced and its six steps are not being
// renamed.
//
// What it cannot do is be CONFIGURED. Its stages are a `const` array, so an opportunity cannot have
// a different assessment, a stage cannot carry a pass mark, and nothing can be made optional. The
// specification requires exactly those things. So this module holds the INTERNAL, per-opportunity
// pipeline — seven stages by default — and every write projects back onto the six public steps
// through PUBLIC_STAGE_PAIRS below.
//
// The rule that keeps them honest: THE CANDIDATE IS NEVER SHOWN A STAGE NAME FROM THIS FILE. They
// see the six published steps. This file decides internal progression; application-stages.ts
// decides what that progression is called in public. One direction, no round trip.
//
// The seven default stages are also mapped onto `applications.status`, the enum the whole existing
// admin console filters on, so advancing someone here does not leave /admin/applications showing a
// state the pipeline has moved past.
//
// ---------------------------------------------------------------------------------------------
// THIS FILE WAS RECONCILED, AND IT MATTERS WHY
// ---------------------------------------------------------------------------------------------
// An earlier pass wrote every statement in here against tos_pipelines, tos_pipeline_stages,
// tos_candidate_stages and tos_evaluations. src/lib/talent/schema.ts creates NONE of those tables —
// it creates tal_pipeline, tal_pipeline_stage, tal_application_stage and tal_evaluation. Nothing
// imported this module, so nothing had broken yet; the first screen to call any exported function
// would have taken a "relation does not exist" straight to the user. src/lib/talent/codes.ts
// carried the identical defect and was reconciled the same way.
//
// The more dangerous half of the defect was the VOCABULARY. This file defined its own StageKind,
// its own StageDef and its own Pipeline beside the ones src/lib/talent/types.ts already owns —
// two definitions of "what a stage is", where whichever one a caller happened to import decided
// whether a candidate advanced. So the shapes are now IMPORTED and nothing here shadows them:
// PipelineStage, Pipeline, StageType, StageOutcome and ApplicationStage all come from types.ts.
//
// THE PURE RULES ARE UNCHANGED. decideAdvance, decidePass, bestScoreFor, scorePercent, completion
// and the projection onto the six published steps behave exactly as they did. Only the vocabulary
// they read (`ordinal` for `seq`, config for the pass mark and optionality) and the tables
// underneath them have moved.
//
// ---------------------------------------------------------------------------------------------
// WHERE A PASS MARK LIVES, AND WHY IT IS NOT A COLUMN
// ---------------------------------------------------------------------------------------------
// tal_pipeline_stage has no pass_score column and no is_required column, and schema.ts is an OWNED
// CONTRACT that other work already depends on — it is extended additively by its owner, never by a
// consumer that wants two more columns. It carries `config JSONB` precisely as that extension
// point, so a stage's two configurable rules live there:
//
//     config.passScore   number, or null/absent for a stage with no pass mark
//     config.isRequired  boolean, TRUE when absent — whether the stage may be passed over
//
// passScoreOf() and isRequiredOf() below are the ONLY readers of those two keys. A screen that
// wants either value asks them; it does not reach into `config` itself, which is how a second
// spelling of `passScore` would come to exist.
//
// ---------------------------------------------------------------------------------------------
// PROGRESS IS (outcome, completed_at) — THERE IS NO STATUS COLUMN
// ---------------------------------------------------------------------------------------------
// tal_application_stage records outcome (the StageOutcome union) and completed_at. A row with both
// NULL is IN PROGRESS. StageStatus below is the DERIVED reading of that pair — the vocabulary the
// pure rules and the admin screens speak — and statusForRow() is the only correct way to compute
// it. It is never stored, for the same reason types.ts refuses to store CandidateStatus: a status
// column that can disagree with the history is two sources of truth.
//
// The table keeps a ROW PER ENTRY rather than a row per stage, so a stage that is entered, cleared,
// reverted and worked again reads as four facts instead of one overwritten one. latestPerStage()
// reduces that history to where the application stands now.
import { uuidish } from '@/lib/page-safety';
import { maxScoreOf, isRecommendation } from '@/lib/talent/evaluations';
import {
  rowsOf, reasonOf, okResult, failResult,
  CANDIDATE_TERMINAL,
  STAGE_TYPES, STAGE_TYPE_LABELS, STAGE_EXPECTS_EVALUATION,
  type StageType, type StageOutcome, type PipelineStage, type Pipeline,
  type ApplicationStage, type LegacyStageKey, type CandidateStatus,
  type EvaluationRecommendation, type TalentResult,
} from '@/lib/talent/types';

// The vocabulary is re-exported so a consumer has one import for the whole stage story, but it is
// DEFINED in types.ts. Nothing in this file may shadow it.
export { STAGE_TYPES, STAGE_TYPE_LABELS, STAGE_EXPECTS_EVALUATION };
export type { PipelineStage, Pipeline, StageType, StageOutcome, ApplicationStage };

// ---------------------------------------------------------------------------------------------
// MODULE CONSTANTS. Declared before anything that reads them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/** The slug and version the seeded default pipeline is created under. (slug, version) is UNIQUE. */
export const DEFAULT_PIPELINE_SLUG = 'standard-evaluation';
export const DEFAULT_PIPELINE_NAME = 'Standard seven-stage evaluation';
export const DEFAULT_PIPELINE_VERSION = 1;

const PIPELINE_COLUMNS = 'id, slug, name, version, is_default, is_active';
const STAGE_COLUMNS = `id, pipeline_id, ordinal, key, label, candidate_blurb, stage_type,
  owner_role, sla_hours, is_terminal, config`;
const APP_STAGE_COLUMNS = `id, application_id, stage_key, ordinal, entered_at, due_at,
  completed_at, outcome, owner_user_id, note, actor_user_id`;

/**
 * The DERIVED reading of (outcome, completed_at). Never written to a column.
 *
 *   in_progress  entered, nothing recorded against it yet
 *   passed       outcome 'pass'
 *   failed       outcome 'fail'
 *   skipped      outcome 'waived' — an optional stage the pipeline was allowed to pass over
 *   pending      never entered, or entered and rolled back (outcome 'reverted')
 */
export const STAGE_STATUSES = ['pending', 'in_progress', 'passed', 'failed', 'skipped'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * Keyed on the StageOutcome union rather than listed as strings, so ADDING an outcome to types.ts
 * fails to compile here instead of silently arriving as an unrecognised value.
 */
const STAGE_OUTCOME_SET: Record<StageOutcome, true> = { pass: true, fail: true, waived: true, reverted: true };

export function isStageOutcome(v: unknown): v is StageOutcome {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STAGE_OUTCOME_SET, v);
}

/** What gets WRITTEN for a requested status. 'pending' is a rollback, and the row says so. */
export function outcomeForStatus(status: StageStatus): StageOutcome | null {
  switch (status) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'skipped': return 'waived';
    case 'pending': return 'reverted';
    case 'in_progress': return null;
  }
}

/**
 * What a stored row READS as. The inverse of outcomeForStatus, plus the two degenerate rows a
 * foreign writer could leave behind.
 *
 * An outcome this module does not recognise, and a row closed with no outcome at all, both read as
 * 'pending' — NOT CLEARED. That direction is deliberate: an unreadable row must never be the thing
 * that lets somebody past a required stage.
 */
export function statusForRow(row: { outcome: string | null; completedAt: string | null }): StageStatus {
  const outcome = String(row.outcome || '');
  if (!outcome) return row.completedAt ? 'pending' : 'in_progress';
  switch (outcome) {
    case 'pass': return 'passed';
    case 'fail': return 'failed';
    case 'waived': return 'skipped';
    default: return 'pending';
  }
}

// ---------------------------------------------------------------------------------------------
// THE SEVEN DEFAULT STAGES
// ---------------------------------------------------------------------------------------------

/** A stage before it has been written: a PipelineStage minus the two ids the database assigns. */
export type StageSeed = Omit<PipelineStage, 'id' | 'pipelineId'>;

/**
 * THE SEVEN. Seeded into tal_pipeline_stage as the global default pipeline the first time this
 * module is asked for one, and freely editable per opportunity afterwards.
 *
 * They are deliberately the seven the specification describes rather than seven invented ones:
 * application, screening, assignment, assessment, interview, evaluation, decision.
 *
 * TWO AXES, NOT ONE. `key` is the stage's name in this pipeline; `stageType` is the contract's
 * CLASSIFICATION of it (types.ts STAGE_TYPES), which is what STAGE_EXPECTS_EVALUATION reads to say
 * which evidence a stage expects. They are not the same axis and do not have to share a spelling —
 * the stage keyed 'application' is an eligibility SCREENING, and the stage keyed 'screening' is the
 * first human REVIEW.
 *
 * The consolidated evaluation carries a pass mark of 60 and is classified 'final_review', which
 * STAGE_EXPECTS_EVALUATION says expects no evidence of its own. That is not a contradiction: the
 * panel records its consolidated mark as a `functional` evaluation against stage_key 'evaluation',
 * and decidePass() reads it from there. Nothing clears a stage carrying a pass mark until a score
 * for that stage key exists.
 */
export const DEFAULT_STAGES: StageSeed[] = [
  { ordinal: 1, key: 'application', label: 'Application received', candidateBlurb: 'The application is complete and in the queue.', stageType: 'screening', ownerRole: null, slaHours: 48, isTerminal: false, config: { passScore: null, isRequired: true } },
  { ordinal: 2, key: 'screening', label: 'Screening', candidateBlurb: 'A human reviewer reads the profile, portfolio and eligibility.', stageType: 'review', ownerRole: null, slaHours: 120, isTerminal: false, config: { passScore: null, isRequired: true } },
  { ordinal: 3, key: 'assignment', label: 'Assignment', candidateBlurb: 'A structured piece of real work, scored against a published rubric.', stageType: 'assignment', ownerRole: null, slaHours: 168, isTerminal: false, config: { passScore: 60, isRequired: false } },
  { ordinal: 4, key: 'assessment', label: 'Assessment', candidateBlurb: 'A timed or proctored assessment. Any automated flag is advisory; a human decides.', stageType: 'assessment', ownerRole: null, slaHours: 168, isTerminal: false, config: { passScore: 60, isRequired: false } },
  { ordinal: 5, key: 'interview', label: 'Interview', candidateBlurb: 'One-on-one with the hiring manager and at least one team member.', stageType: 'interview', ownerRole: null, slaHours: 240, isTerminal: false, config: { passScore: null, isRequired: true } },
  { ordinal: 6, key: 'evaluation', label: 'Consolidated evaluation', candidateBlurb: 'Every score and recommendation read together by the panel.', stageType: 'final_review', ownerRole: null, slaHours: 120, isTerminal: false, config: { passScore: 60, isRequired: true } },
  { ordinal: 7, key: 'decision', label: 'Final decision', candidateBlurb: 'Yes or no, in writing, with a reason either way. Decisions are appealable.', stageType: 'decision', ownerRole: null, slaHours: 72, isTerminal: true, config: { passScore: null, isRequired: true } },
];

/**
 * The two rules a stage carries in `config`. Read through these and nowhere else.
 *
 * passScoreOf returns null — no pass mark — for absent, null, empty and unreadable values. A stage
 * whose pass mark cannot be read is a stage with no pass mark, not a stage nobody can ever clear.
 */
export function passScoreOf(stage: Pick<PipelineStage, 'config'>): number | null {
  const raw = (stage && stage.config ? stage.config : {}).passScore;
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** TRUE when absent. A stage that does not say it is optional is required — spec 6A. */
export function isRequiredOf(stage: Pick<PipelineStage, 'config'>): boolean {
  const raw = (stage && stage.config ? stage.config : {}).isRequired;
  if (raw === null || raw === undefined) return true;
  return raw !== false;
}

/**
 * The subset of a stage the pure rules need. Both a stored PipelineStage and an unsaved StageSeed
 * satisfy it, so the whole ladder can be exercised against DEFAULT_STAGES with no database at all.
 */
export type StageRules = Pick<PipelineStage, 'ordinal' | 'key' | 'label' | 'config'>;

// ---------------------------------------------------------------------------------------------
// THE PROJECTION ONTO THE SIX PUBLISHED STEPS
// ---------------------------------------------------------------------------------------------

/**
 * Internal stage -> the PUBLISHED six-step key from src/lib/application-stages.ts.
 *
 * Pairs, not a Record, because this module is imported into .astro frontmatter and a typed
 * `Record<string,string>` reaching JSX breaks the Astro compiler on this project.
 */
const PUBLIC_STAGE_PAIRS: ReadonlyArray<readonly [string, LegacyStageKey]> = [
  ['application', 'submitted'],
  ['screening',   'review'],
  ['assignment',  'assessment'],
  ['assessment',  'assessment'],
  ['interview',   'interview'],
  ['evaluation',  'decision'],
  ['decision',    'decision'],
];

/** The six-step key a candidate should see while sitting on this internal stage. */
export function publicStageFor(stageKey: string): LegacyStageKey {
  const hit = PUBLIC_STAGE_PAIRS.find((p) => p[0] === String(stageKey || ''));
  return hit ? hit[1] : 'submitted';
}

/** The `applications.status` enum value that matches an internal stage. */
const STATUS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['application', 'submitted'],
  ['screening',   'reviewing'],
  ['assignment',  'task_sent'],
  ['assessment',  'task_sent'],
  ['interview',   'interview'],
  ['evaluation',  'interview'],
  ['decision',    'interview'],
];
export function applicationStatusFor(stageKey: string): string {
  const hit = STATUS_PAIRS.find((p) => p[0] === String(stageKey || ''));
  return hit ? hit[1] : 'submitted';
}

// ---------------------------------------------------------------------------------------------
// PROGRESSION RULES — pure, so the whole ladder is testable with no database at all.
// ---------------------------------------------------------------------------------------------

export interface StageProgress {
  stageKey: string;
  ordinal: number;
  status: StageStatus;
}

export interface EvaluationSummary {
  stageKey: string;
  score: number | null;
  maxScore: number;
  /** ADVISORY ONLY — spec F12. Nothing in this module reads it to decide anything. */
  recommendation: EvaluationRecommendation | null;
}

export type AdvanceOutcome =
  | 'ok'
  | 'unknown_stage'
  | 'application_closed'
  | 'out_of_order'
  | 'prior_stage_incomplete'
  | 'score_below_threshold'
  | 'already_final';

export interface AdvanceDecision {
  ok: boolean;
  outcome: AdvanceOutcome;
  message: string;
}

/** A percentage, guarding against a zero or absent denominator rather than producing Infinity/NaN. */
export function scorePercent(e: EvaluationSummary): number | null {
  if (e.score === null || e.score === undefined) return null;
  const max = Number(e.maxScore);
  if (!Number.isFinite(max) || max <= 0) return null;
  const s = Number(e.score);
  if (!Number.isFinite(s)) return null;
  return (s / max) * 100;
}

/**
 * The BEST percentage recorded for a stage, or null when nothing is scored yet.
 *
 * Best, not average, on purpose: a candidate who is given a second attempt at an assignment is
 * being given a second attempt, and averaging it with the first silently makes the retake
 * worthless. Averaging would also mean an unscored qualitative note (score null) drags a stage
 * down, which it must not.
 */
export function bestScoreFor(stageKey: string, evaluations: EvaluationSummary[]): number | null {
  const pcts = (evaluations || [])
    .filter((e) => e.stageKey === stageKey)
    .map(scorePercent)
    .filter((p): p is number => p !== null);
  if (!pcts.length) return null;
  return pcts.reduce((a, b) => (b > a ? b : a), pcts[0]);
}

/**
 * May this application move from where it is to `targetKey`?
 *
 * `applicationClosed` covers rejected / withdrawn — a closed application does not quietly resume
 * because somebody clicked Advance on a stale page.
 */
export function decideAdvance(
  stages: StageRules[],
  progress: StageProgress[],
  evaluations: EvaluationSummary[],
  targetKey: string,
  applicationClosed: boolean,
): AdvanceDecision {
  if (applicationClosed) {
    return { ok: false, outcome: 'application_closed', message: 'This application is closed. Reopen it before moving it through the pipeline.' };
  }
  const target = stages.find((s) => s.key === targetKey);
  if (!target) {
    return { ok: false, outcome: 'unknown_stage', message: `"${targetKey}" is not a stage on this opportunity's pipeline.` };
  }

  const statusOf = (key: string): StageStatus => {
    const p = (progress || []).find((x) => x.stageKey === key);
    return p ? p.status : 'pending';
  };

  if (statusOf(target.key) === 'passed') {
    return { ok: false, outcome: 'already_final', message: `${target.label} has already been cleared.` };
  }

  // Every REQUIRED stage before the target must be passed or explicitly skipped. An optional stage
  // that was never started is not an obstacle — that is what optional means.
  const priors = stages.filter((s) => s.ordinal < target.ordinal).sort((a, b) => a.ordinal - b.ordinal);
  for (const prior of priors) {
    const st = statusOf(prior.key);
    if (st === 'passed' || st === 'skipped') continue;
    if (!isRequiredOf(prior) && st === 'pending') continue;
    if (st === 'failed') {
      return { ok: false, outcome: 'prior_stage_incomplete', message: `${prior.label} was not cleared. Record a fresh outcome there before advancing.` };
    }
    return { ok: false, outcome: 'prior_stage_incomplete', message: `${prior.label} is still open. Complete it before moving to ${target.label}.` };
  }

  // A stage may not be entered more than one required step ahead of the furthest cleared stage.
  // Without this, "advance to decision" from a fresh application is a single click that skips every
  // check the pipeline exists to impose.
  const cleared = stages
    .filter((s) => statusOf(s.key) === 'passed' || statusOf(s.key) === 'skipped')
    .reduce((max, s) => (s.ordinal > max ? s.ordinal : max), 0);
  const nextRequired = stages.filter((s) => s.ordinal > cleared).sort((a, b) => a.ordinal - b.ordinal)[0];
  if (nextRequired && target.ordinal > nextRequired.ordinal) {
    const skippable = stages.filter((s) => s.ordinal > cleared && s.ordinal < target.ordinal).every((s) => !isRequiredOf(s));
    if (!skippable) {
      return { ok: false, outcome: 'out_of_order', message: `${nextRequired.label} comes first. Stages are worked in order, and only optional ones may be passed over.` };
    }
  }

  return { ok: true, outcome: 'ok', message: `Ready to enter ${target.label}.` };
}

/**
 * May this stage be marked PASSED? Separate from decideAdvance because entering a stage and
 * clearing it are different acts with different evidence, and only the second one is gated on score.
 */
export function decidePass(
  stages: StageRules[],
  evaluations: EvaluationSummary[],
  stageKey: string,
): AdvanceDecision {
  const stage = stages.find((s) => s.key === stageKey);
  if (!stage) return { ok: false, outcome: 'unknown_stage', message: `"${stageKey}" is not a stage on this pipeline.` };
  const passScore = passScoreOf(stage);
  if (passScore === null) {
    return { ok: true, outcome: 'ok', message: `${stage.label} cleared.` };
  }
  const best = bestScoreFor(stageKey, evaluations);
  // A stage with a pass mark and nothing scored yet does NOT pass. Silence is not evidence.
  if (best === null) {
    return { ok: false, outcome: 'score_below_threshold', message: `${stage.label} carries a pass mark of ${passScore}%, and nothing has been scored yet.` };
  }
  if (best < passScore) {
    return { ok: false, outcome: 'score_below_threshold', message: `${stage.label} needs ${passScore}%. The best recorded score is ${best.toFixed(1)}%.` };
  }
  return { ok: true, outcome: 'ok', message: `${stage.label} cleared at ${best.toFixed(1)}%.` };
}

/** How far along, as a fraction, for a progress bar that does not lie about optional stages. */
export function completion(stages: StageRules[], progress: StageProgress[]): { done: number; total: number; percent: number } {
  const total = stages.length;
  const done = stages.filter((s) => {
    const p = (progress || []).find((x) => x.stageKey === s.key);
    return p && (p.status === 'passed' || p.status === 'skipped');
  }).length;
  return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** An unreadable entered_at sorts oldest rather than throwing a reduction off with NaN. */
function enteredMs(row: ApplicationStage): number {
  const t = Date.parse(String(row.enteredAt || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * The CURRENT row for each stage, newest entry winning. PURE.
 *
 * tal_application_stage keeps a row per ENTRY, so a stage worked twice has two rows and only the
 * later one describes where the application stands now.
 */
export function latestPerStage(history: ApplicationStage[]): ApplicationStage[] {
  const byKey = new Map<string, ApplicationStage>();
  for (const row of history || []) {
    const prev = byKey.get(row.stageKey);
    if (!prev || enteredMs(row) >= enteredMs(prev)) byKey.set(row.stageKey, row);
  }
  return Array.from(byKey.values()).sort((a, b) => a.ordinal - b.ordinal);
}

/** The derived progress view the pure rules consume. */
export function progressFromHistory(history: ApplicationStage[]): StageProgress[] {
  return latestPerStage(history).map((r) => ({
    stageKey: r.stageKey,
    ordinal: r.ordinal,
    status: statusForRow(r),
  }));
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE — tal_pipeline, tal_pipeline_stage, tal_application_stage.
// ---------------------------------------------------------------------------------------------

/** A drizzle handle. Both it and drizzle's `sql` are resolved LAZILY — see ctx(). */
type SqlRunner = { execute: (query: any) => Promise<any> };

let _db: any = null;

/**
 * Schema first, then the connection.
 *
 * NOTHING ABOVE THIS LINE IMPORTS THE DATABASE, and that is deliberate rather than tidy: a
 * module-scope `import { ensureTalentSchema } from './schema'` pulls src/lib/db in with it, so
 * merely importing decideAdvance() into a test would throw "DATABASE_URL is not set" before a
 * single assertion ran. types.ts carries the same note for the same reason, and
 * src/lib/talent/events.ts resolves both the same way. ensureTalentSchema() is memoised in
 * schema.ts, so calling it at the top of every entry point is free.
 */
async function ctx(): Promise<{ db: SqlRunner; sql: any }> {
  const { ensureTalentSchema } = await import('@/lib/talent/schema');
  await ensureTalentSchema();
  if (!_db) _db = (await import('@/lib/db')).db;
  const { sql } = await import('drizzle-orm');
  return { db: _db as SqlRunner, sql };
}

function toPipelineStage(r: any): PipelineStage {
  const st = String(r.stage_type || '');
  return {
    id: String(r.id),
    pipelineId: String(r.pipeline_id),
    ordinal: Number(r.ordinal),
    key: String(r.key),
    label: String(r.label),
    candidateBlurb: String(r.candidate_blurb || ''),
    // stage_type is TEXT, so a value this module does not know about can exist. It reads as
    // 'review' — the honest generic — rather than as itself, because a stage type no screen has a
    // label for renders as a blank chip.
    stageType: (STAGE_TYPES as readonly string[]).includes(st) ? (st as StageType) : 'review',
    ownerRole: r.owner_role ? String(r.owner_role) : null,
    slaHours: r.sla_hours === null || r.sla_hours === undefined ? null : Number(r.sla_hours),
    isTerminal: r.is_terminal === true,
    config: (r.config && typeof r.config === 'object') ? (r.config as Record<string, any>) : {},
  };
}

function toPipeline(r: any, stages: PipelineStage[]): Pipeline {
  return {
    id: String(r.id),
    slug: String(r.slug || ''),
    name: String(r.name || ''),
    version: Number(r.version) || 1,
    isDefault: r.is_default === true,
    isActive: r.is_active !== false,
    stages,
  };
}

function toApplicationStage(r: any): ApplicationStage {
  const outcome = String(r.outcome || '');
  return {
    id: String(r.id),
    applicationId: String(r.application_id),
    stageKey: String(r.stage_key || ''),
    ordinal: Number(r.ordinal),
    enteredAt: r.entered_at ? new Date(r.entered_at).toISOString() : new Date(0).toISOString(),
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    outcome: isStageOutcome(outcome) ? outcome : null,
    ownerUserId: r.owner_user_id ? String(r.owner_user_id) : null,
    note: r.note ? String(r.note) : null,
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
  };
}

async function readStages(db: SqlRunner, sql: any, pipelineId: string): Promise<PipelineStage[]> {
  const r = rowsOf(await db.execute(sql`
    SELECT ${sql.raw(STAGE_COLUMNS)} FROM tal_pipeline_stage
    WHERE pipeline_id = ${pipelineId}::uuid ORDER BY ordinal ASC
  `));
  return r.map(toPipelineStage);
}

async function seedDefaultStages(db: SqlRunner, sql: any, pipelineId: string): Promise<void> {
  for (const s of DEFAULT_STAGES) {
    await db.execute(sql`
      INSERT INTO tal_pipeline_stage (
        pipeline_id, ordinal, key, label, candidate_blurb, stage_type, owner_role, sla_hours,
        is_terminal, config
      ) VALUES (
        ${pipelineId}::uuid, ${s.ordinal}, ${s.key}, ${s.label}, ${s.candidateBlurb}, ${s.stageType},
        ${s.ownerRole}, ${s.slaHours}, ${s.isTerminal}, ${JSON.stringify(s.config)}::jsonb
      ) ON CONFLICT DO NOTHING
    `);
  }
}

/**
 * The global default pipeline, created with the seven stages on first use.
 *
 * The insert races: two cold requests can both find nothing and both try to create it. The UNIQUE
 * index on (slug, version) makes the loser's insert fail with 23505, which is caught and re-read
 * rather than surfaced — an ordinary race is not an error worth showing anybody. The stage seeding
 * is ON CONFLICT DO NOTHING for the same reason.
 *
 * A default pipeline that exists with NO stages is re-seeded rather than returned. A pipeline with
 * no stages advances nobody, so a half-finished first run must not become a permanent one.
 */
export async function ensureDefaultPipeline(createdBy: string | null = null): Promise<TalentResult<Pipeline>> {
  try {
    const { db, sql } = await ctx();
    const read = async () => rowsOf(await db.execute(sql`
      SELECT ${sql.raw(PIPELINE_COLUMNS)} FROM tal_pipeline
      WHERE is_default AND is_active ORDER BY version DESC LIMIT 1
    `));

    let found = await read();
    if (!found.length) {
      const owner = uuidish(createdBy);
      try {
        await db.execute(sql`
          INSERT INTO tal_pipeline (slug, name, version, is_default, is_active, created_by)
          VALUES (${DEFAULT_PIPELINE_SLUG}, ${DEFAULT_PIPELINE_NAME}, ${DEFAULT_PIPELINE_VERSION},
                  TRUE, TRUE, ${owner ? sql`${owner}::uuid` : sql`NULL`})
        `);
      } catch (e: any) {
        if (String(e?.cause?.code || e?.code) !== '23505') throw e;
      }
      found = await read();
      if (!found.length) {
        return failResult('The default pipeline could not be read back after it was created, so it is not being reported as ready.');
      }
    }

    const row = found[0] as any;
    let stages = await readStages(db, sql, String(row.id));
    if (!stages.length && String(row.slug) === DEFAULT_PIPELINE_SLUG) {
      await seedDefaultStages(db, sql, String(row.id));
      stages = await readStages(db, sql, String(row.id));
    }
    return okResult(toPipeline(row, stages));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/** The stages of one pipeline, in order. */
export async function stagesFor(pipelineId: string): Promise<TalentResult<PipelineStage[]>> {
  try {
    const id = uuidish(pipelineId);
    if (!id) return failResult('That pipeline reference is not a valid id, so no stages were read.');
    const { db, sql } = await ctx();
    return okResult(await readStages(db, sql, id));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/**
 * Resolve the pipeline a row is PINNED to.
 *
 * An opportunity and an application both carry pipeline_id AND pipeline_version, and the version is
 * the load-bearing half: editing a pipeline must not change the rules under an application already
 * halfway through it. So the pinned version wins, and the row's own pipeline_id is the way to find
 * WHICH pipeline (which slug) was meant.
 *
 * If the pinned version no longer exists, the pipeline the id names is used instead and the
 * substitution is logged. Refusing outright would strand every application whose old version was
 * tidied away, and quietly resolving to a different pipeline would be worse than either.
 */
async function resolvePinned(
  db: SqlRunner, sql: any, pipelineId: any, pinnedVersion: any, subject: string,
): Promise<TalentResult<Pipeline>> {
  const pid = uuidish(String(pipelineId || ''));
  if (!pid) return await ensureDefaultPipeline();

  const byId = rowsOf(await db.execute(sql`
    SELECT ${sql.raw(PIPELINE_COLUMNS)} FROM tal_pipeline WHERE id = ${pid}::uuid LIMIT 1
  `));
  if (!byId.length) {
    console.error(`[talent-stages] ${subject} names pipeline ${pid}, which does not exist; falling back to the default pipeline.`);
    return await ensureDefaultPipeline();
  }

  const row = byId[0] as any;
  const pinned = Number(pinnedVersion);
  if (Number.isFinite(pinned) && Number(row.version) !== pinned) {
    const atVersion = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(PIPELINE_COLUMNS)} FROM tal_pipeline
      WHERE slug = ${String(row.slug)} AND version = ${pinned} LIMIT 1
    `));
    if (atVersion.length) {
      const pinnedRow = atVersion[0] as any;
      return okResult(toPipeline(pinnedRow, await readStages(db, sql, String(pinnedRow.id))));
    }
    console.error(`[talent-stages] ${subject} is pinned to ${String(row.slug)} v${pinned}, which no longer exists; using v${String(row.version)}.`);
  }
  return okResult(toPipeline(row, await readStages(db, sql, String(row.id))));
}

/**
 * The pipeline governing an opportunity.
 *
 * tal_pipeline has NO role_id. A pipeline reaches a role only through tal_opportunity.pipeline_id,
 * which is NOT NULL, so "the pipeline for this opportunity" is a resolution THROUGH that row and
 * never a lookup by role.
 */
export async function pipelineForOpportunity(opportunityId: string): Promise<TalentResult<Pipeline>> {
  try {
    const oid = uuidish(opportunityId);
    if (!oid) return failResult('That opportunity reference is not a valid id, so no pipeline was resolved.');
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT pipeline_id, pipeline_version FROM tal_opportunity WHERE id = ${oid}::uuid LIMIT 1
    `));
    if (!r.length) return failResult('That opportunity could not be read, so no pipeline was resolved.');
    const row = r[0] as any;
    return await resolvePinned(db, sql, row.pipeline_id, row.pipeline_version, `opportunity ${oid}`);
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/**
 * The pipeline governing one application — its OWN pin, not its opportunity's current one.
 *
 * tal_application carries pipeline_id and pipeline_version of its own precisely so that moving an
 * opportunity onto a new pipeline does not move the goalposts for people already in flight.
 */
export async function pipelineForApplication(applicationId: string): Promise<TalentResult<Pipeline>> {
  try {
    const aid = uuidish(applicationId);
    if (!aid) return failResult('That application reference is not a valid id, so no pipeline was resolved.');
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT pipeline_id, pipeline_version FROM tal_application WHERE id = ${aid}::uuid LIMIT 1
    `));
    if (!r.length) return failResult('That application could not be read, so no pipeline was resolved.');
    const row = r[0] as any;
    return await resolvePinned(db, sql, row.pipeline_id, row.pipeline_version, `application ${aid}`);
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

async function readHistory(db: SqlRunner, sql: any, applicationId: string): Promise<ApplicationStage[]> {
  const r = rowsOf(await db.execute(sql`
    SELECT ${sql.raw(APP_STAGE_COLUMNS)} FROM tal_application_stage
    WHERE application_id = ${applicationId}::uuid
    ORDER BY ordinal ASC, entered_at ASC
  `));
  return r.map(toApplicationStage);
}

/** Every stage entry recorded against an application, oldest first. The audit view. */
export async function stageHistory(applicationId: string): Promise<TalentResult<ApplicationStage[]>> {
  try {
    const id = uuidish(applicationId);
    if (!id) return failResult('That application reference is not a valid id, so no stage history was read.');
    const { db, sql } = await ctx();
    return okResult(await readHistory(db, sql, id));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

/** Where the application stands now: the latest entry per stage, read as a StageStatus. */
export async function progressFor(applicationId: string): Promise<TalentResult<StageProgress[]>> {
  const history = await stageHistory(applicationId);
  if (!history.ok) return failResult(history.error || 'The stage history could not be read.');
  return okResult(progressFromHistory(history.data || []));
}

/**
 * Score summaries for the pass-mark rules. Kept here so decidePass() has one shape to consume.
 *
 * ONLY SUBMITTED EVALUATIONS COUNT. tal_evaluation.status defaults to 'pending', and a pending row
 * is an evaluation somebody has been ASKED for, not one they have given; a waived one is evidence
 * nobody ever produced. Counting either would let an empty invitation clear a pass mark.
 *
 * The denominator comes from rubric.maxScore through maxScoreOf() — the one reader of that key.
 */
export async function evaluationSummaries(applicationId: string): Promise<TalentResult<EvaluationSummary[]>> {
  try {
    const id = uuidish(applicationId);
    if (!id) return failResult('That application reference is not a valid id, so no scores were read.');
    const { db, sql } = await ctx();
    const r = rowsOf(await db.execute(sql`
      SELECT stage_key, total_score, rubric, recommendation FROM tal_evaluation
      WHERE application_id = ${id}::uuid AND status = 'submitted'
    `));
    return okResult(r.map((x: any): EvaluationSummary => {
      const rec = String(x.recommendation || '');
      return {
        stageKey: String(x.stage_key || ''),
        score: x.total_score === null || x.total_score === undefined ? null : Number(x.total_score),
        maxScore: maxScoreOf(x.rubric),
        recommendation: isRecommendation(rec) ? rec : null,
      };
    }));
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}

export interface StageWrite {
  stageKey: string;
  status: StageStatus;
  /** The outcome actually written: null when the stage was left open, and null when nothing changed. */
  outcome: StageOutcome | null;
  /** True when the row already said this and nothing needed writing. */
  unchanged: boolean;
  message: string;
}

/**
 * Move an application into a stage, or record its outcome.
 *
 * BOTH the pure decision AND the write happen here, in that order, and the caller never gets to
 * write without the decision — which is the whole point of putting the rules in a pure function
 * rather than in an .astro page where the next page would reimplement two thirds of them.
 *
 * THE APPLICATION IS RE-READ RATHER THAN TRUSTED. Its pipeline pin, and whether it is closed, come
 * from tal_application on every call, for the reason codes.ts re-reads a selection: the button that
 * triggers this sits on an admin page whose data may be a minute old, and "advance somebody who was
 * withdrawn while the page was open" is an ordinary sequence, not a hypothetical. A caller may
 * still assert `applicationClosed: true` — a closure the database has not caught up with — but a
 * caller's `false` never overrides one the database can see.
 *
 * NOTHING HERE WRITES A SELECTION DECISION. Clearing the final stage records that the stage was
 * cleared; who was selected is a separate, human act with a written reason — spec F12.
 */
export async function setStage(args: {
  applicationId: string;
  stageKey: string;
  status: StageStatus;
  actorUserId: string;
  ownerUserId?: string | null;
  note?: string | null;
  applicationClosed?: boolean;
  /** Skip the ordering rules. Only ever set by an explicit admin override, and always audited. */
  force?: boolean;
}): Promise<TalentResult<StageWrite>> {
  try {
    const applicationId = uuidish(args.applicationId);
    if (!applicationId) {
      return failResult('That application reference is not a valid id, so nothing was changed.');
    }
    // An actor is not optional. The column is nullable, but a stage outcome with nobody's name on
    // it is a decision an appeal cannot trace — and an unparseable id would otherwise reach
    // Postgres as a 22P02 that an operator reads as a mystery.
    const actorUserId = uuidish(args.actorUserId);
    if (!actorUserId) {
      return failResult('A stage change has to record who made it. Nothing was changed.');
    }
    const ownerUserId = args.ownerUserId ? uuidish(args.ownerUserId) : null;

    const status = args.status;
    if (!(STAGE_STATUSES as readonly string[]).includes(status)) {
      return failResult(`"${String(args.status)}" is not a stage status. Use one of: ${STAGE_STATUSES.join(', ')}.`);
    }

    const { db, sql } = await ctx();

    const appRows = rowsOf(await db.execute(sql`
      SELECT id, status, closed_at, pipeline_id, pipeline_version
      FROM tal_application WHERE id = ${applicationId}::uuid LIMIT 1
    `));
    if (!appRows.length) {
      return failResult('That application could not be read back, so nothing was changed.');
    }
    const app = appRows[0] as any;
    const appStatus = String(app.status || '') as CandidateStatus;
    const closed = !!app.closed_at
      || (CANDIDATE_TERMINAL as readonly string[]).includes(appStatus)
      || args.applicationClosed === true;

    const resolved = await resolvePinned(db, sql, app.pipeline_id, app.pipeline_version, `application ${applicationId}`);
    if (!resolved.ok || !resolved.data) {
      return failResult(resolved.error || 'No evaluation pipeline could be read, so nothing was changed.');
    }
    const pipeline = resolved.data;

    const stage = pipeline.stages.find((s) => s.key === args.stageKey);
    if (!stage) return failResult(`"${args.stageKey}" is not a stage on this pipeline.`);

    const history = await readHistory(db, sql, applicationId);
    const progress = progressFromHistory(history);
    const current = latestPerStage(history).find((r) => r.stageKey === stage.key) || null;
    const currentIsOpen = !!current && !current.completedAt && !current.outcome;

    if (!args.force) {
      const evaluations = await evaluationSummaries(applicationId);
      if (!evaluations.ok) {
        // Refused rather than assumed empty. An unreadable score table would otherwise read as
        // "nothing scored yet" on every stage, and the caller is entitled to know the difference.
        return failResult(evaluations.error || 'The recorded scores could not be read, so nothing was changed.');
      }
      const scores = evaluations.data || [];

      if (status === 'in_progress' || status === 'pending') {
        const d = decideAdvance(pipeline.stages, progress, scores, stage.key, closed);
        if (!d.ok) return failResult(d.message);
      }
      if (status === 'passed') {
        const enter = decideAdvance(pipeline.stages, progress, scores, stage.key, closed);
        // Entering is allowed to be a no-op when the stage is already in progress; only a genuine
        // ordering failure blocks a pass.
        if (!enter.ok && enter.outcome !== 'already_final' && enter.outcome !== 'unknown_stage') {
          const already = progress.find((p) => p.stageKey === stage.key);
          if (!already || already.status === 'pending') return failResult(enter.message);
        }
        const d = decidePass(pipeline.stages, scores, stage.key);
        if (!d.ok) return failResult(d.message);
      }
      if (status === 'failed' || status === 'skipped') {
        // The ordering rules do not apply to recording a failure or a waiver, but the closure does:
        // a closed application does not acquire fresh outcomes from a stale page.
        if (closed) {
          return failResult('This application is closed. Reopen it before recording a stage outcome.');
        }
      }
    }

    const outcome = outcomeForStatus(status);
    const note = args.note === null || args.note === undefined || String(args.note).trim() === ''
      ? null
      : String(args.note).trim();

    // due_at is derived from the stage's own SLA. tal_app_stage_sla_idx indexes exactly this column
    // for rows that are still open, so an SLA report is an index read rather than a scan.
    const dueAt = stage.slaHours !== null && Number.isFinite(Number(stage.slaHours)) && Number(stage.slaHours) > 0
      ? sql`NOW() + make_interval(hours => ${Number(stage.slaHours)})`
      : sql`NULL::timestamptz`;
    const owner = ownerUserId ? sql`${ownerUserId}::uuid` : sql`NULL::uuid`;

    const openRow = async () => rowsOf(await db.execute(sql`
      INSERT INTO tal_application_stage (
        application_id, stage_key, ordinal, entered_at, due_at, owner_user_id, note, actor_user_id
      )
      SELECT ${applicationId}::uuid, ${stage.key}::text, ${stage.ordinal}::int, NOW(), ${dueAt},
             ${owner}, ${note}::text, ${actorUserId}::uuid
      WHERE NOT EXISTS (
        SELECT 1 FROM tal_application_stage
        WHERE application_id = ${applicationId}::uuid AND stage_key = ${stage.key}::text
          AND completed_at IS NULL AND outcome IS NULL
      )
      RETURNING id
    `));

    // actor_user_id holds the actor of the LATEST act on the row. There is one such column, so
    // closing a stage records who decided it rather than who opened it — which is the name an
    // appeal asks for. Who entered the stage remains readable in the row it superseded.
    const closeOpenRow = async () => rowsOf(await db.execute(sql`
      UPDATE tal_application_stage
      SET completed_at = NOW(),
          outcome = ${outcome}::text,
          note = COALESCE(${note}::text, note),
          owner_user_id = COALESCE(${owner}, owner_user_id),
          actor_user_id = ${actorUserId}::uuid
      WHERE id = (
        SELECT id FROM tal_application_stage
        WHERE application_id = ${applicationId}::uuid AND stage_key = ${stage.key}::text
          AND completed_at IS NULL AND outcome IS NULL
        ORDER BY entered_at DESC, id DESC LIMIT 1
      )
      RETURNING id
    `));

    // due_at is NULL here on purpose: this row is complete the moment it is written, so it never
    // had a deadline anybody could have missed. Inventing one would put a phantom breach on an SLA
    // report the day somebody records an outcome for a stage that was never formally entered.
    const insertClosedRow = async () => rowsOf(await db.execute(sql`
      INSERT INTO tal_application_stage (
        application_id, stage_key, ordinal, entered_at, due_at, completed_at, outcome,
        owner_user_id, note, actor_user_id
      ) VALUES (
        ${applicationId}::uuid, ${stage.key}, ${stage.ordinal}, NOW(), NULL::timestamptz, NOW(),
        ${outcome}, ${owner}, ${note}, ${actorUserId}::uuid
      ) RETURNING id
    `));

    const done = (unchanged: boolean, message: string, written: StageOutcome | null = outcome) =>
      okResult<StageWrite>({ stageKey: stage.key, status, outcome: written, unchanged, message });

    if (status === 'in_progress') {
      // The NOT EXISTS guard lives INSIDE the statement, so an ordinary double-submit cannot open
      // the same stage twice. It is not a unique index — tal_application_stage deliberately allows
      // a stage to be entered more than once — so two genuinely simultaneous writers can still
      // interleave. That residual race leaves a duplicate open row, which latestPerStage() resolves
      // to one; it does not let anybody past a gate.
      const opened = await openRow();
      if (!opened.length) return done(true, `${stage.label} is already open.`, null);
      return done(false, `${stage.label}: in progress.`);
    }

    if (status === 'pending') {
      // A ROLLBACK, recorded as one. The completed row that said 'pass' is left exactly as it was —
      // it is what happened — and the reversal is a new fact written on top of it, so an appeal can
      // read both. Overwriting the earlier row would erase the very thing being questioned.
      if (currentIsOpen) {
        const closedRows = await closeOpenRow();
        if (!closedRows.length) return failResult('That stage was completed by someone else a moment ago. Nothing was changed twice.');
        return done(false, `${stage.label}: reverted.`);
      }
      if (!current) return done(true, `${stage.label} has not been started, so there was nothing to revert.`, null);
      await insertClosedRow();
      return done(false, `${stage.label}: reverted.`);
    }

    // passed / failed / skipped — close the open entry, or record a completed one for a stage that
    // was decided without ever formally being entered.
    if (currentIsOpen) {
      const closedRows = await closeOpenRow();
      if (!closedRows.length) return failResult('That stage was completed by someone else a moment ago. Nothing was changed twice.');
    } else {
      await insertClosedRow();
    }
    return done(false, `${stage.label}: ${status.replace('_', ' ')}.`);
  } catch (e: any) {
    return failResult(reasonOf(e));
  }
}
