// src/lib/ai-boundary.ts — WHERE A MACHINE STOPS AND A PERSON DECIDES.
//
// =================================================================================================
// THE LINE
// =================================================================================================
//
// A machine in this system may RECOMMEND, SUMMARISE, CLASSIFY, RETRIEVE, DRAFT, IDENTIFY PATTERNS
// and SUGGEST. It may not decide. Six decisions belong to a named human being and to nobody else:
//
//     hiring · rejection · termination · promotion · compensation · discipline
//
// This module is the guard those six must pass through, and it is deliberately small enough to read
// in one sitting, because a boundary nobody can read is a boundary nobody can trust.
//
// TWO TABLES, AND THE GAP BETWEEN THEM IS THE WHOLE POINT:
//
//   ai_recommendations   what a machine concluded. It is STORED, it is EXPLAINED, and it is INERT.
//                        There is no status column on it, no applied_at, no acted_on, no acted_by.
//                        Nothing in this module accepts a recommendation id and performs anything
//                        with it. A recommendation is a sentence somebody may read.
//
//   ai_human_decisions   what a person decided, who they are, what they were shown, whether they
//                        followed it, and — when they did not — why. THE OVERRIDE IS FIRST-CLASS
//                        DATA. It is not an exception, not an escape hatch and not a footnote: it is
//                        a row with a reason in it, and the reason is required by a CHECK constraint
//                        as well as by this code, because a rule enforced in one place is a rule
//                        that survives exactly one refactor.
//
// =================================================================================================
// NO OPAQUE SCORE ON A HIGH-IMPACT DECISION
// =================================================================================================
//
// ai_recommendations HAS NO SCORE COLUMN AND WILL NOT BE GIVEN ONE. A number is the most persuasive
// thing you can put on a screen and the least answerable. In its place the table carries the seven
// questions that must be answerable before a recommendation may be shown to anybody:
//
//   1. what was concluded          conclusion
//   2. why                         reasoning
//   3. on what evidence            evidence     (at least one item, each pointing at a real row)
//   4. under what assumptions      assumptions
//   5. what is uncertain           uncertainty
//   6. what data influenced it     inputs
//   7. can a human override it     always yes — a column that may only ever be true
//
// EVERY ONE IS REQUIRED. storeRecommendation() refuses a recommendation that cannot answer all
// seven, and it refuses rather than storing a partial one, because a half-explained recommendation
// on a screen reads exactly like a fully-explained one.
//
// =================================================================================================
// WHAT MAY NEVER BE A VARIABLE
// =================================================================================================
//
// Protected and sensitive attributes are not decision variables here, they are not inferred here,
// and no seam is left where one could become either. PROTECTED_ATTRIBUTE_SEGMENTS below is checked
// against the KEYS of every recommendation input and every evidence reference, and a match refuses
// the write outright.
//
// KEYS, NOT VALUES, AND THAT IS DELIBERATE. A key is a variable — somebody chose to feed it in. A
// free-text sentence that happens to contain the word "health" is a person describing their week.
// Scanning values would refuse honest prose and teach callers to launder it, which is worse than not
// scanning at all.
//
// =================================================================================================
// NEVER SWALLOWED
// =================================================================================================
//
// Every write path here reports the real Postgres reason (e.cause.message — the one that says what
// actually went wrong; e.message is only the failed SQL). Nothing in this file ends in an empty
// catch. A boundary that fails quietly is not a boundary.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

const MOD = 'ai-boundary';

// -------------------------------------------------------------------------------------------------
// SMALL LOCAL HELPERS — deliberately local. This module is the spine's boundary and must not gain a
// dependency on a domain module (performance-scope, org-graph) that could one day want to depend
// back on it.
// -------------------------------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** postgres-js hands back a PLAIN ARRAY. `r.rows[0]` has broken this project before. */
function rowsOf(r: any): any[] {
  return Array.isArray(r) ? r : (r?.rows || []);
}

function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || 'unknown reason');
}

function logFail(where: string, e: any): void {
  console.error('[' + MOD + '] ' + where + ': ' + reasonOf(e));
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// =================================================================================================
// THE VOCABULARY
// =================================================================================================

/** The six decisions a human must make. Section 67 names them; this is that list and no other. */
export const CONSEQUENTIAL_DECISIONS = [
  'hiring',
  'rejection',
  'termination',
  'promotion',
  'compensation',
  'discipline',
] as const;
export type ConsequentialDecision = (typeof CONSEQUENTIAL_DECISIONS)[number];

export const CONSEQUENTIAL_DECISION_LABELS: Record<string, string> = {
  hiring: 'Hiring somebody',
  rejection: 'Rejecting a candidate',
  termination: 'Ending somebody\'s employment',
  promotion: 'Promoting somebody',
  compensation: 'Changing what somebody is paid',
  discipline: 'Disciplinary action',
};

export function isConsequentialDecision(v: unknown): v is ConsequentialDecision {
  return typeof v === 'string' && (CONSEQUENTIAL_DECISIONS as readonly string[]).indexOf(v) >= 0;
}

/**
 * What a machine is permitted to do. This list is documentation with a purpose: a new AI feature
 * that cannot describe itself with one of these words is a feature that is deciding something.
 */
export const AI_PERMITTED_ACTS = [
  'recommend',
  'summarise',
  'classify',
  'retrieve',
  'draft',
  'identify_patterns',
  'suggest',
] as const;
export type AiPermittedAct = (typeof AI_PERMITTED_ACTS)[number];

/**
 * Attribute names that may never be a variable in anything this module stores.
 *
 * Matched against KEY SEGMENTS after splitting on non-alphanumeric characters, so "average" does not
 * trip "age" and "healthcare_provider_id" does trip "health".
 *
 * WHY GENDER IS ON THIS LIST even though hr_employees records it: recording an attribute for a
 * lawful statutory purpose and letting it influence a decision are different acts, and this table is
 * the second one. WHY AGE AND NATIONALITY ARE NOT: both are lawful eligibility facts elsewhere in
 * this codebase (a minimum age on a programme, right to work), and a list that refuses them here
 * would be routed around rather than obeyed. If either ever appears as an input to one of the six
 * decisions, that is a review, not a regex.
 */
export const PROTECTED_ATTRIBUTE_SEGMENTS: readonly string[] = [
  'race', 'racial', 'ethnicity', 'ethnic', 'caste', 'colour',
  'religion', 'religious', 'faith',
  'politics', 'political', 'union',
  'sexuality', 'sexual', 'orientation',
  'disability', 'disabled', 'impairment',
  'health', 'medical', 'diagnosis', 'illness', 'symptom', 'cycle', 'wellness',
  'pregnancy', 'pregnant', 'maternity',
  'gender', 'sex',
  'marital', 'divorce',
];

function keySegments(key: string): string[] {
  return String(key).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Every protected attribute named by a key anywhere in `value`, de-duplicated.
 *
 * Depth-limited: a payload nested more than six deep is a payload nobody reads, and an unbounded
 * walk over a caller-supplied object is a denial of service with extra steps.
 */
export function protectedAttributesIn(value: unknown, depth = 0): string[] {
  const found: string[] = [];
  if (depth > 6 || value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) for (const f of protectedAttributesIn(item, depth + 1)) found.push(f);
    return Array.from(new Set(found));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    for (const seg of keySegments(key)) {
      if (PROTECTED_ATTRIBUTE_SEGMENTS.indexOf(seg) >= 0) found.push(seg);
    }
    for (const f of protectedAttributesIn(child, depth + 1)) found.push(f);
  }
  return Array.from(new Set(found));
}

/**
 * The sentence a caller gets back when they tried to feed a protected attribute into a decision.
 * Returns null when the object is clean, so the call site reads as a guard rather than a boolean.
 */
export function refuseProtectedAttributes(value: unknown, what: string): string | null {
  const found = protectedAttributesIn(value);
  if (!found.length) return null;
  return (
    'Nothing was recorded. ' + what + ' names ' + found.join(', ')
    + ', and a protected or sensitive attribute is never a decision variable in this system. '
    + 'Remove it — there is no setting that permits it.'
  );
}

/** The seven questions, in the order a human reads them. */
export const EXPLANATION_QUESTIONS: readonly { key: string; question: string }[] = [
  { key: 'conclusion', question: 'What was concluded?' },
  { key: 'reasoning', question: 'Why was that concluded?' },
  { key: 'evidence', question: 'On what evidence?' },
  { key: 'assumptions', question: 'Under what assumptions?' },
  { key: 'uncertainty', question: 'What is uncertain about it?' },
  { key: 'inputs', question: 'What data influenced it?' },
  { key: 'override', question: 'Can a human override it?' },
];

// =================================================================================================
// SHAPES
// =================================================================================================

/**
 * WHO a decision or a recommendation is about.
 *
 * There is no person table in this codebase yet, so a human is still reachable only through the id
 * space they happen to occupy. At least one must be present, and every one that IS known should be
 * given: the day a person root exists, these rows are what stitches the four surfaces together.
 */
export interface SubjectRef {
  employeeId?: string | null;
  applicationId?: string | null;
  userId?: string | null;
}

function normaliseSubject(s: SubjectRef | null | undefined): SubjectRef {
  return {
    employeeId: isUuid(s?.employeeId) ? String(s?.employeeId) : null,
    applicationId: isUuid(s?.applicationId) ? String(s?.applicationId) : null,
    userId: isUuid(s?.userId) ? String(s?.userId) : null,
  };
}

function subjectIsEmpty(s: SubjectRef): boolean {
  return !s.employeeId && !s.applicationId && !s.userId;
}

function subjectsOverlap(a: SubjectRef, b: SubjectRef): boolean {
  if (a.employeeId && b.employeeId) return a.employeeId === b.employeeId;
  if (a.applicationId && b.applicationId) return a.applicationId === b.applicationId;
  if (a.userId && b.userId) return a.userId === b.userId;
  return false;
}

/**
 * One thing a recommendation rests on. It POINTS AT A ROW — a completion, a passed attempt, a signed
 * certificate, a submitted scorecard, a work sample. A keyword is not evidence and a skill on a CV
 * is a claim, so `kind` names what sort of record this is and `ref` is the record.
 */
export interface EvidenceRef {
  kind: string;
  ref: string;
  label: string;
  url?: string | null;
}

export interface InputRef {
  /** Which table, module or document the machine actually read. */
  source: string;
  /** What it took from there, in a sentence a person can check. */
  description: string;
}

export interface RecommendationInput {
  decisionKind: ConsequentialDecision;
  subject: SubjectRef;
  /** Which engine, prompt or module produced this. Not "AI". */
  producedBy: string;
  conclusion: string;
  reasoning: string;
  evidence: EvidenceRef[];
  assumptions: string;
  uncertainty: string;
  inputs: InputRef[];
  createdByUserId?: string | null;
}

export interface StoredRecommendation {
  id: string;
  decisionKind: string;
  subject: SubjectRef;
  producedBy: string;
  conclusion: string;
  reasoning: string;
  evidence: EvidenceRef[];
  assumptions: string;
  uncertainty: string;
  inputs: InputRef[];
  overridable: true;
  assertion: 'recommended';
  createdAt: string | null;
  createdByUserId: string | null;
}

export interface WriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface HumanDecisionInput {
  decisionKind: ConsequentialDecision;
  subject: SubjectRef;
  /** users.id of the person deciding. There is no system value for this field. */
  decidedByUserId: string;
  /** What they decided, in their words. */
  decision: string;
  /** The recommendation they were shown, when they were shown one. */
  recommendationId?: string | null;
  /** Whether they went with it. Null only when there was no recommendation. */
  followedRecommendation?: boolean | null;
  /** Required when followedRecommendation is false. */
  overrideReason?: string | null;
  /** The row this decision is about — an application id, a separation id, an offer id. */
  recordRef?: string | null;
  sourceModule: string;
  note?: string | null;
}

export interface RecordedDecision {
  id: string;
  decisionKind: string;
  subject: SubjectRef;
  decidedByUserId: string;
  decision: string;
  recommendationId: string | null;
  recommendationSeen: boolean;
  followedRecommendation: boolean | null;
  overrideReason: string | null;
  recordRef: string | null;
  sourceModule: string;
  note: string | null;
  decidedAt: string | null;
}

// =================================================================================================
// SCHEMA — CREATED, THEN VERIFIED, BECAUSE ensureOnce() CANNOT BE TRUSTED TO SAY SO
// =================================================================================================
//
// src/lib/ensure-once.ts ends in p.catch(() => {}). A DDL failure inside it RESOLVES, and the caller
// reports success. Ten module tables were reported created on this project and none of them existed.
//
// So this module does not use it. It memoises only a VERIFIED state, and verification is a read of
// information_schema — the database saying what is there, not this file saying what it asked for. A
// state that is not ok is never cached, so the next call tries again.

const REQUIRED_TABLES: Record<string, string[]> = {
  ai_recommendations: [
    'id', 'decision_kind', 'subject_employee_id', 'subject_application_id', 'subject_user_id',
    'produced_by', 'conclusion', 'reasoning', 'evidence', 'assumptions', 'uncertainty', 'inputs',
    'overridable', 'assertion', 'created_at', 'created_by_user_id',
  ],
  ai_human_decisions: [
    'id', 'decision_kind', 'subject_employee_id', 'subject_application_id', 'subject_user_id',
    'recommendation_id', 'recommendation_seen', 'decision', 'followed_recommendation',
    'override_reason', 'decided_by_user_id', 'decided_at', 'record_ref', 'source_module', 'note',
  ],
};

export interface BoundarySchemaState {
  ok: boolean;
  tables: { name: string; present: boolean; missingColumns: string[] }[];
  error: string | null;
  checkedAt: string;
}

let verifiedState: BoundarySchemaState | null = null;
let inflight: Promise<BoundarySchemaState> | null = null;

async function createBoundaryTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_recommendations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      decision_kind VARCHAR(30) NOT NULL,
      subject_employee_id UUID,
      subject_application_id UUID,
      subject_user_id UUID,
      produced_by VARCHAR(160) NOT NULL,
      conclusion TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      assumptions TEXT NOT NULL,
      uncertainty TEXT NOT NULL,
      inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
      overridable BOOLEAN NOT NULL DEFAULT TRUE,
      assertion VARCHAR(20) NOT NULL DEFAULT 'recommended',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_user_id UUID,
      CONSTRAINT ai_recommendations_always_overridable CHECK (overridable = TRUE)
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_reco_subject_emp_idx ON ai_recommendations (subject_employee_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_reco_subject_app_idx ON ai_recommendations (subject_application_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_reco_kind_idx ON ai_recommendations (decision_kind, created_at)`);

  // THE OVERRIDE CONSTRAINT. A decision that departed from what the machine said cannot be stored
  // without the reason it departed. Enforced here as well as in code, because the two get refactored
  // by different people on different days.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_human_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      decision_kind VARCHAR(30) NOT NULL,
      subject_employee_id UUID,
      subject_application_id UUID,
      subject_user_id UUID,
      recommendation_id UUID,
      recommendation_seen BOOLEAN NOT NULL DEFAULT FALSE,
      decision TEXT NOT NULL,
      followed_recommendation BOOLEAN,
      override_reason TEXT,
      decided_by_user_id UUID NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      record_ref VARCHAR(160),
      source_module VARCHAR(120) NOT NULL,
      note TEXT,
      CONSTRAINT ai_human_decisions_override_needs_reason
        CHECK (followed_recommendation IS DISTINCT FROM FALSE
               OR (override_reason IS NOT NULL AND length(btrim(override_reason)) >= 10))
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_decision_subject_emp_idx ON ai_human_decisions (subject_employee_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_decision_subject_app_idx ON ai_human_decisions (subject_application_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_decision_kind_idx ON ai_human_decisions (decision_kind, decided_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_decision_reco_idx ON ai_human_decisions (recommendation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ai_decision_record_idx ON ai_human_decisions (record_ref)`);
}

async function readBoundarySchemaState(): Promise<BoundarySchemaState> {
  const names = Object.keys(REQUIRED_TABLES);
  const state: BoundarySchemaState = { ok: false, tables: [], error: null, checkedAt: new Date().toISOString() };
  try {
    const present = rowsOf(await db.execute(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('ai_recommendations', 'ai_human_decisions')`));
    const byTable = new Map<string, Set<string>>();
    for (const r of present) {
      const t = String((r as any).table_name);
      if (!byTable.has(t)) byTable.set(t, new Set<string>());
      byTable.get(t)?.add(String((r as any).column_name));
    }
    for (const name of names) {
      const cols = byTable.get(name);
      const missing = cols ? REQUIRED_TABLES[name].filter((c) => !cols.has(c)) : REQUIRED_TABLES[name].slice();
      state.tables.push({ name, present: !!cols, missingColumns: missing });
    }
    state.ok = state.tables.every((t) => t.present && t.missingColumns.length === 0);
    if (!state.ok) {
      state.error = state.tables
        .filter((t) => !t.present || t.missingColumns.length)
        .map((t) => (t.present ? t.name + ' is missing ' + t.missingColumns.join(', ') : t.name + ' does not exist'))
        .join('; ');
    }
    return state;
  } catch (e: any) {
    logFail('readBoundarySchemaState', e);
    state.error = 'The database could not be asked what exists: ' + reasonOf(e);
    state.tables = names.map((name) => ({ name, present: false, missingColumns: REQUIRED_TABLES[name].slice() }));
    return state;
  }
}

/**
 * Create the boundary tables, then ASK THE DATABASE WHAT IS ACTUALLY THERE and return that.
 *
 * The return value is the report, not a promise that the work was done. Callers that need the tables
 * check `.ok`; a surface that wants to show an operator the truth prints `.tables`.
 */
export async function ensureBoundarySchema(): Promise<BoundarySchemaState> {
  if (verifiedState && verifiedState.ok) return verifiedState;
  if (inflight) return inflight;
  inflight = (async () => {
    let ddlError: string | null = null;
    try {
      await createBoundaryTables();
    } catch (e: any) {
      // NOT SWALLOWED. The verification below will say what is missing; this keeps the REASON, which
      // information_schema cannot tell us.
      logFail('ensureBoundarySchema:ddl', e);
      ddlError = reasonOf(e);
    }
    const state = await readBoundarySchemaState();
    if (ddlError && !state.ok) state.error = (state.error ? state.error + ' — ' : '') + 'DDL failed: ' + ddlError;
    if (state.ok) verifiedState = state;
    return state;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** The state, re-checked from scratch. For an ops surface that wants the truth on demand. */
export async function boundarySchemaState(): Promise<BoundarySchemaState> {
  verifiedState = null;
  return ensureBoundarySchema();
}

// =================================================================================================
// A RECOMMENDATION IS STORED, NOT PERFORMED
// =================================================================================================

function validEvidence(list: unknown): EvidenceRef[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: EvidenceRef[] = [];
  for (const raw of list.slice(0, 50)) {
    const kind = clean((raw as any)?.kind, 60);
    const ref = clean((raw as any)?.ref, 160);
    const label = clean((raw as any)?.label, 500);
    if (!kind || !ref || !label) return null;
    const url = clean((raw as any)?.url, 500);
    out.push({ kind, ref, label, url: url && /^(https?:\/\/|\/)/i.test(url) ? url : null });
  }
  return out;
}

function validInputs(list: unknown): InputRef[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: InputRef[] = [];
  for (const raw of list.slice(0, 50)) {
    const source = clean((raw as any)?.source, 160);
    const description = clean((raw as any)?.description, 500);
    if (!source || !description) return null;
    out.push({ source, description });
  }
  return out;
}

/**
 * Store what a machine concluded. THIS PERFORMS NOTHING.
 *
 * It writes one row to ai_recommendations and returns its id. It does not change an application
 * stage, an employee record, a salary, a workflow instance or anything else, and no other function
 * in this module will act on the id it returns. If a caller wants something to happen, a human has
 * to decide it — recordHumanDecision() below.
 *
 * REFUSES, RATHER THAN STORING SOMETHING WEAKER, when:
 *   - the decision is not one of the six (a recommendation about something else does not belong on
 *     this table and does not need this ceremony);
 *   - any of the seven questions is unanswered;
 *   - the evidence list is empty, or an item does not point at a record;
 *   - a protected or sensitive attribute is named anywhere in the inputs or the evidence.
 */
export async function storeRecommendation(input: RecommendationInput): Promise<WriteResult> {
  const kind = String(input?.decisionKind || '');
  if (!isConsequentialDecision(kind)) {
    return {
      ok: false,
      error: 'That is not one of the six decisions this boundary governs, so nothing was stored. '
        + 'The six are: ' + CONSEQUENTIAL_DECISIONS.join(', ') + '.',
    };
  }

  const subject = normaliseSubject(input?.subject);
  if (subjectIsEmpty(subject)) {
    return { ok: false, error: 'A recommendation has to be about somebody. Nothing was stored.' };
  }

  const producedBy = clean(input?.producedBy, 160);
  const conclusion = clean(input?.conclusion, 4000);
  const reasoning = clean(input?.reasoning, 8000);
  const assumptions = clean(input?.assumptions, 4000);
  const uncertainty = clean(input?.uncertainty, 4000);
  const evidence = validEvidence(input?.evidence);
  const inputs = validInputs(input?.inputs);

  const unanswered: string[] = [];
  if (!conclusion) unanswered.push('what was concluded');
  if (!reasoning) unanswered.push('why');
  if (!evidence) unanswered.push('on what evidence (at least one record it points at)');
  if (!assumptions) unanswered.push('under what assumptions');
  if (!uncertainty) unanswered.push('what is uncertain');
  if (!inputs) unanswered.push('what data influenced it');
  if (!producedBy) unanswered.push('which engine produced it');
  if (unanswered.length) {
    return {
      ok: false,
      error: 'Nothing was stored. A recommendation on a decision this consequential has to answer '
        + 'every question a person may ask of it, and these are unanswered: ' + unanswered.join('; ') + '.',
    };
  }

  const refused = refuseProtectedAttributes({ evidence, inputs }, 'This recommendation');
  if (refused) return { ok: false, error: refused };

  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) {
      return {
        ok: false,
        error: 'The recommendation was not stored: ' + (schema.error || 'the boundary tables are not present.'),
      };
    }
    const createdBy = isUuid(input?.createdByUserId) ? String(input.createdByUserId) : null;
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO ai_recommendations
        (decision_kind, subject_employee_id, subject_application_id, subject_user_id,
         produced_by, conclusion, reasoning, evidence, assumptions, uncertainty, inputs,
         overridable, assertion, created_by_user_id)
      VALUES
        (${kind}, ${subject.employeeId}::uuid, ${subject.applicationId}::uuid, ${subject.userId}::uuid,
         ${producedBy}, ${conclusion}, ${reasoning}, ${JSON.stringify(evidence)}::jsonb,
         ${assumptions}, ${uncertainty}, ${JSON.stringify(inputs)}::jsonb,
         TRUE, 'recommended', ${createdBy}::uuid)
      RETURNING id`));
    if (!rows.length) {
      return { ok: false, error: 'The recommendation was not stored and no reason was returned. Nothing was changed.' };
    }
    const id = String(rows[0].id);
    await logAudit({
      userId: createdBy,
      action: 'ai.recommendation.stored',
      entity: 'ai_recommendations',
      entityId: id,
      diff: { decisionKind: kind, producedBy, evidenceItems: evidence ? evidence.length : 0 },
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail('storeRecommendation', e);
    return { ok: false, error: 'The recommendation was not stored: ' + reasonOf(e) };
  }
}

function parseJsonArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function mapRecommendation(r: any): StoredRecommendation {
  return {
    id: String(r?.id ?? ''),
    decisionKind: String(r?.decision_kind ?? ''),
    subject: {
      employeeId: r?.subject_employee_id ? String(r.subject_employee_id) : null,
      applicationId: r?.subject_application_id ? String(r.subject_application_id) : null,
      userId: r?.subject_user_id ? String(r.subject_user_id) : null,
    },
    producedBy: String(r?.produced_by ?? ''),
    conclusion: String(r?.conclusion ?? ''),
    reasoning: String(r?.reasoning ?? ''),
    evidence: parseJsonArray(r?.evidence) as EvidenceRef[],
    assumptions: String(r?.assumptions ?? ''),
    uncertainty: String(r?.uncertainty ?? ''),
    inputs: parseJsonArray(r?.inputs) as InputRef[],
    overridable: true,
    assertion: 'recommended',
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    createdByUserId: r?.created_by_user_id ? String(r.created_by_user_id) : null,
  };
}

export async function getRecommendation(id: string): Promise<StoredRecommendation | null> {
  if (!isUuid(id)) return null;
  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) return null;
    const rows = rowsOf(await db.execute(sql`SELECT * FROM ai_recommendations WHERE id = ${id}::uuid LIMIT 1`));
    return rows.length ? mapRecommendation(rows[0]) : null;
  } catch (e: any) {
    logFail('getRecommendation', e);
    return null;
  }
}

export interface Explanation {
  recommendationId: string;
  answers: { key: string; question: string; answer: string }[];
  complete: boolean;
}

/**
 * The seven answers, in the words a person asked the questions.
 *
 * A recommendation that cannot answer all seven should not be on a screen. storeRecommendation()
 * makes that impossible for anything written through this module, and `complete` says so for
 * anything that arrived some other way.
 */
export async function explainRecommendation(id: string): Promise<Explanation | null> {
  const rec = await getRecommendation(id);
  if (!rec) return null;
  const evidenceText = rec.evidence.length
    ? rec.evidence.map((e) => e.label + ' (' + e.kind + ' ' + e.ref + ')').join('\n')
    : '';
  const inputsText = rec.inputs.length
    ? rec.inputs.map((i) => i.source + ': ' + i.description).join('\n')
    : '';
  const answers = [
    { key: 'conclusion', question: EXPLANATION_QUESTIONS[0].question, answer: rec.conclusion },
    { key: 'reasoning', question: EXPLANATION_QUESTIONS[1].question, answer: rec.reasoning },
    { key: 'evidence', question: EXPLANATION_QUESTIONS[2].question, answer: evidenceText },
    { key: 'assumptions', question: EXPLANATION_QUESTIONS[3].question, answer: rec.assumptions },
    { key: 'uncertainty', question: EXPLANATION_QUESTIONS[4].question, answer: rec.uncertainty },
    { key: 'inputs', question: EXPLANATION_QUESTIONS[5].question, answer: inputsText },
    {
      key: 'override',
      question: EXPLANATION_QUESTIONS[6].question,
      answer: 'Yes. This is a recommendation and nothing acts on it. A named person decides, and if '
        + 'they decide otherwise their reason is recorded beside this.',
    },
  ];
  return { recommendationId: rec.id, answers, complete: answers.every((a) => a.answer.trim().length > 0) };
}

export async function recommendationsFor(
  subject: SubjectRef,
  decisionKind?: ConsequentialDecision | null,
  limit = 20,
): Promise<StoredRecommendation[]> {
  const s = normaliseSubject(subject);
  if (subjectIsEmpty(s)) return [];
  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) return [];
    const kind = isConsequentialDecision(decisionKind) ? String(decisionKind) : null;
    const cap = Math.max(1, Math.min(200, Math.round(limit)));
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM ai_recommendations
       WHERE ((${s.employeeId}::uuid IS NOT NULL AND subject_employee_id = ${s.employeeId}::uuid)
           OR (${s.applicationId}::uuid IS NOT NULL AND subject_application_id = ${s.applicationId}::uuid)
           OR (${s.userId}::uuid IS NOT NULL AND subject_user_id = ${s.userId}::uuid))
         AND (${kind}::text IS NULL OR decision_kind = ${kind})
       ORDER BY created_at DESC
       LIMIT ${cap}`));
    return rows.map(mapRecommendation);
  } catch (e: any) {
    logFail('recommendationsFor', e);
    return [];
  }
}

// =================================================================================================
// THE GUARD — A CONSEQUENTIAL ACTION PASSES THROUGH HERE OR IT DOES NOT HAPPEN
// =================================================================================================

function mapDecision(r: any): RecordedDecision {
  const followed = r?.followed_recommendation;
  return {
    id: String(r?.id ?? ''),
    decisionKind: String(r?.decision_kind ?? ''),
    subject: {
      employeeId: r?.subject_employee_id ? String(r.subject_employee_id) : null,
      applicationId: r?.subject_application_id ? String(r.subject_application_id) : null,
      userId: r?.subject_user_id ? String(r.subject_user_id) : null,
    },
    decidedByUserId: String(r?.decided_by_user_id ?? ''),
    decision: String(r?.decision ?? ''),
    recommendationId: r?.recommendation_id ? String(r.recommendation_id) : null,
    recommendationSeen: r?.recommendation_seen === true,
    followedRecommendation: followed === null || followed === undefined ? null : followed === true,
    overrideReason: r?.override_reason ? String(r.override_reason) : null,
    recordRef: r?.record_ref ? String(r.record_ref) : null,
    sourceModule: String(r?.source_module ?? ''),
    note: r?.note ? String(r.note) : null,
    decidedAt: r?.decided_at ? new Date(r.decided_at).toISOString() : null,
  };
}

/**
 * Is this actor a human being with an account that is still live?
 *
 * A cron, a webhook and a queue worker all arrive with no user id, and one of them arriving with a
 * service account's id is exactly the failure this check exists to catch. There is no allowlist and
 * no bypass flag: an inactive account cannot decide either, because an account that has been closed
 * is somebody who has left.
 *
 * FAILS CLOSED. If we cannot confirm a human, we do not assume one.
 */
async function humanActor(userId: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(userId)) {
    return {
      ok: false,
      error: 'This decision needs a person. No human actor was given, so nothing was decided and '
        + 'nothing was changed. A scheduled job, a webhook and a model are none of them a decision-maker.',
    };
  }
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, is_active FROM users WHERE id = ${String(userId)}::uuid LIMIT 1`));
    if (!rows.length) {
      return { ok: false, error: 'That actor has no account on this system, so the decision was not recorded.' };
    }
    if (rows[0].is_active === false) {
      return { ok: false, error: 'That account is closed, so it cannot decide anything. Nothing was recorded.' };
    }
    return { ok: true };
  } catch (e: any) {
    logFail('humanActor', e);
    return { ok: false, error: 'We could not confirm who is deciding, so nothing was recorded: ' + reasonOf(e) };
  }
}

/**
 * Record that a named person decided one of the six.
 *
 * WHAT IT REFUSES, AND EVERY REFUSAL CHANGES NOTHING:
 *   - a decision that is not one of the six;
 *   - no human actor, or an actor with no live account (see humanActor above);
 *   - a decision with nobody it is about;
 *   - an empty decision — "approved" with no words is not a record of anything;
 *   - a cited recommendation that does not exist, is about a different decision, or is about a
 *     DIFFERENT PERSON. Citing somebody else's recommendation is the quiet way a decision about one
 *     person ends up justified by another person's evidence;
 *   - an override with no reason, or a reason too short to be a reason.
 *
 * THE OVERRIDE IS THE POINT. followedRecommendation === false with a written reason is a first-class
 * row, indexed and readable, not an exception path. Departing from the machine is ordinary and the
 * record should make it look ordinary.
 */
export async function recordHumanDecision(input: HumanDecisionInput): Promise<WriteResult> {
  const kind = String(input?.decisionKind || '');
  if (!isConsequentialDecision(kind)) {
    return {
      ok: false,
      error: 'That is not one of the six decisions this boundary governs, so nothing was recorded. '
        + 'The six are: ' + CONSEQUENTIAL_DECISIONS.join(', ') + '.',
    };
  }

  const subject = normaliseSubject(input?.subject);
  if (subjectIsEmpty(subject)) {
    return { ok: false, error: 'A decision has to be about somebody. Nothing was recorded.' };
  }

  const decision = clean(input?.decision, 4000);
  if (!decision) {
    return {
      ok: false,
      error: 'Write down what was decided. A decision with no words is not a record. Nothing was recorded.',
    };
  }

  const sourceModule = clean(input?.sourceModule, 120);
  if (!sourceModule) {
    return { ok: false, error: 'Nothing was recorded: the screen or module making this decision has to name itself.' };
  }

  const actor = await humanActor(input?.decidedByUserId);
  if (!actor.ok) return { ok: false, error: actor.error };

  const recommendationId = isUuid(input?.recommendationId) ? String(input.recommendationId) : null;
  let followed: boolean | null = null;
  let overrideReason: string | null = null;

  if (recommendationId) {
    const rec = await getRecommendation(recommendationId);
    if (!rec) {
      return { ok: false, error: 'The recommendation this decision cites could not be read, so nothing was recorded.' };
    }
    if (rec.decisionKind !== kind) {
      return {
        ok: false,
        error: 'That recommendation is about ' + (CONSEQUENTIAL_DECISION_LABELS[rec.decisionKind] || rec.decisionKind)
          + ', not ' + (CONSEQUENTIAL_DECISION_LABELS[kind] || kind) + '. Nothing was recorded.',
      };
    }
    if (!subjectsOverlap(rec.subject, subject)) {
      return {
        ok: false,
        error: 'That recommendation is about a different person, so it cannot be what this decision '
          + 'rests on. Nothing was recorded.',
      };
    }
    if (input?.followedRecommendation !== true && input?.followedRecommendation !== false) {
      return { ok: false, error: 'Say whether you went with the recommendation you were shown. Nothing was recorded.' };
    }
    followed = input.followedRecommendation === true;
    if (!followed) {
      overrideReason = clean(input?.overrideReason, 4000);
      if (overrideReason.length < 10) {
        return {
          ok: false,
          error: 'Deciding differently from the recommendation is entirely allowed, and the reason is '
            + 'recorded with it. Write down why, in a sentence. Nothing was recorded.',
        };
      }
    }
  }

  const note = clean(input?.note, 4000) || null;
  const recordRef = clean(input?.recordRef, 160) || null;

  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) {
      return {
        ok: false,
        error: 'The decision was not recorded: ' + (schema.error || 'the boundary tables are not present.'),
      };
    }
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO ai_human_decisions
        (decision_kind, subject_employee_id, subject_application_id, subject_user_id,
         recommendation_id, recommendation_seen, decision, followed_recommendation, override_reason,
         decided_by_user_id, record_ref, source_module, note)
      VALUES
        (${kind}, ${subject.employeeId}::uuid, ${subject.applicationId}::uuid, ${subject.userId}::uuid,
         ${recommendationId}::uuid, ${recommendationId !== null}, ${decision},
         ${followed}::boolean, ${overrideReason}::text,
         ${String(input.decidedByUserId)}::uuid, ${recordRef}::text, ${sourceModule}, ${note}::text)
      RETURNING id`));
    if (!rows.length) {
      return { ok: false, error: 'The decision was not recorded and no reason was returned. Nothing was changed.' };
    }
    const id = String(rows[0].id);
    await logAudit({
      userId: String(input.decidedByUserId),
      action: followed === false ? 'ai.recommendation.overridden' : 'ai.human_decision',
      entity: 'ai_human_decisions',
      entityId: id,
      diff: { decisionKind: kind, recommendationId, followed, recordRef, sourceModule },
    });
    return { ok: true, id };
  } catch (e: any) {
    logFail('recordHumanDecision', e);
    return { ok: false, error: 'The decision was not recorded: ' + reasonOf(e) };
  }
}

export interface GuardResult<T> {
  ok: boolean;
  decisionId: string | null;
  result?: T;
  error?: string;
}

/**
 * THE GUARD ITSELF. Run a consequential action only after a human decision has been recorded for it.
 *
 *     const g = await withHumanAuthority(
 *       {
 *         decisionKind: 'rejection',
 *         subject: { applicationId },
 *         decidedByUserId: user.id,
 *         decision: 'Not proceeding after the panel round.',
 *         sourceModule: 'admin/applications/[id]',
 *         recommendationId,
 *         followedRecommendation: false,
 *         overrideReason: 'The panel saw work the summary did not read.',
 *       },
 *       async () => setStage(applicationId, 'rejected', user.id),
 *     );
 *
 * ORDER MATTERS. The decision is written FIRST. If the action then fails, a recorded decision with no
 * effect is left behind — which is the honest residue, and it is findable: the reason is returned and
 * an audit row says the action failed. The reverse order would leave an effect with no decision
 * behind it, and that is the state this whole module exists to prevent.
 *
 * THE ACTION FAILURE IS NEVER SWALLOWED. The real Postgres reason is returned to the caller and
 * logged; the caller must show it rather than reporting success.
 */
export async function withHumanAuthority<T>(
  input: HumanDecisionInput,
  action: (decisionId: string) => Promise<T>,
): Promise<GuardResult<T>> {
  const recorded = await recordHumanDecision(input);
  if (!recorded.ok || !recorded.id) {
    return {
      ok: false,
      decisionId: null,
      error: recorded.error || 'The decision was not recorded, so nothing was done.',
    };
  }
  const decisionId = recorded.id;
  try {
    const result = await action(decisionId);
    return { ok: true, decisionId, result };
  } catch (e: any) {
    logFail('withHumanAuthority:action', e);
    await logAudit({
      userId: String(input.decidedByUserId),
      action: 'ai.human_decision.action_failed',
      entity: 'ai_human_decisions',
      entityId: decisionId,
      diff: { decisionKind: input.decisionKind, sourceModule: input.sourceModule, reason: reasonOf(e) },
    });
    return {
      ok: false,
      decisionId,
      error: 'The decision is on record, but the change it was meant to make did not happen: ' + reasonOf(e),
    };
  }
}

/**
 * For a module that records the decision on one screen and performs it on another: confirm the
 * decision exists, is the right kind, and is about the right person, before writing anything.
 */
export async function requireHumanDecision(
  decisionId: string,
  expect: { decisionKind: ConsequentialDecision; subject: SubjectRef },
): Promise<{ ok: boolean; decision?: RecordedDecision; error?: string }> {
  if (!isUuid(decisionId)) {
    return { ok: false, error: 'No human decision was cited, so nothing was changed.' };
  }
  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) {
      return {
        ok: false,
        error: 'The human-decision record could not be read: ' + (schema.error || 'the boundary tables are not present.'),
      };
    }
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM ai_human_decisions WHERE id = ${decisionId}::uuid LIMIT 1`));
    if (!rows.length) return { ok: false, error: 'That decision is not on record, so nothing was changed.' };
    const decision = mapDecision(rows[0]);
    if (decision.decisionKind !== expect.decisionKind) {
      return {
        ok: false,
        error: 'That decision was about ' + (CONSEQUENTIAL_DECISION_LABELS[decision.decisionKind] || decision.decisionKind)
          + ', not this. Nothing was changed.',
      };
    }
    if (!subjectsOverlap(decision.subject, normaliseSubject(expect.subject))) {
      return { ok: false, error: 'That decision was about a different person. Nothing was changed.' };
    }
    return { ok: true, decision };
  } catch (e: any) {
    logFail('requireHumanDecision', e);
    return { ok: false, error: 'The human-decision record could not be read, so nothing was changed: ' + reasonOf(e) };
  }
}

export async function decisionsFor(subject: SubjectRef, limit = 50): Promise<RecordedDecision[]> {
  const s = normaliseSubject(subject);
  if (subjectIsEmpty(s)) return [];
  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) return [];
    const cap = Math.max(1, Math.min(200, Math.round(limit)));
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM ai_human_decisions
       WHERE (${s.employeeId}::uuid IS NOT NULL AND subject_employee_id = ${s.employeeId}::uuid)
          OR (${s.applicationId}::uuid IS NOT NULL AND subject_application_id = ${s.applicationId}::uuid)
          OR (${s.userId}::uuid IS NOT NULL AND subject_user_id = ${s.userId}::uuid)
       ORDER BY decided_at DESC
       LIMIT ${cap}`));
    return rows.map(mapDecision);
  } catch (e: any) {
    logFail('decisionsFor', e);
    return [];
  }
}

/**
 * Every decision where the person went a different way from the machine, newest first.
 *
 * This is the number that tells you whether the boundary is real. A system where nobody ever
 * overrides is a system where the recommendation is the decision, whatever the schema says.
 */
export async function overrides(limit = 100): Promise<RecordedDecision[]> {
  try {
    const schema = await ensureBoundarySchema();
    if (!schema.ok) return [];
    const cap = Math.max(1, Math.min(500, Math.round(limit)));
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM ai_human_decisions
       WHERE followed_recommendation = FALSE
       ORDER BY decided_at DESC
       LIMIT ${cap}`));
    return rows.map(mapDecision);
  } catch (e: any) {
    logFail('overrides', e);
    return [];
  }
}
