// src/lib/horizon/report/runs.ts — THE ONE TABLE THIS PATCH OWNS, AND WHY IT IS ONLY ONE.
//
// =================================================================================================
// WHAT hzn_report_run IS
// =================================================================================================
//
// A record that a particular document was produced, for a particular person, at a particular moment,
// by a particular version of this engine — with the document itself stored as served.
//
// That is not caching. It is the auditable artefact the brief asks for. "A recommendation was made
// about me and somebody acted on it" is only answerable if the thing they read still exists in the
// form they read it; regenerating the report next week runs newer rules over changed data and
// produces a different document, which is exactly the wrong evidence in a dispute.
//
// =================================================================================================
// WHAT IT IS NOT, AND THIS IS THE PART THAT MATTERS
// =================================================================================================
//
// THERE IS NO DECISION COLUMN ON THIS TABLE AND THERE WILL NOT BE ONE.
//
// Human decisions live in `ai_human_decisions`, owned by src/lib/ai-boundary.ts, which enforces —
// in a CHECK constraint as well as in code — that a decision departing from a recommendation records
// why. Adding `decision` and `decided_by` here would create a second place a decision can be stored,
// with none of that enforcement, and within a release the two would disagree about what somebody
// decided. Section 6 of every document in this engine is READ from ai_human_decisions and from the
// owning patches' own decision tables. Nothing here writes one.
//
// Nor does this table hold employee data of its own. Every fact inside `document` was read from
// another patch's relation through a provider, and the document is a snapshot of what was shown —
// which is why purgeRunsOlderThan() exists below and why the operations patch should be calling it.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { dbReason, toRows } from '@/lib/page-safety';
import { ENGINE_ID } from './version';
import type { AccessDecision } from './access';
import type { ReportDocument } from './types';

const REQUIRED_COLUMNS = [
  'id', 'report_id', 'engine_id', 'engine_version', 'interpreter_id', 'interpreter_version',
  'model_provider', 'subject_kind', 'subject_id', 'subject_employee_id', 'subject_application_id',
  'subject_user_id', 'audience', 'access_basis', 'generated_by_user_id', 'generated_at',
  'document', 'coverage', 'claim_counts', 'redacted',
];

export interface RunSchemaState {
  ok: boolean;
  present: boolean;
  missingColumns: string[];
  error: string | null;
  checkedAt: string;
}

// A VERIFIED STATE, NOT AN "I ASKED" STATE.
//
// ensureOnce() in this codebase ends in a catch that logs and resolves. A DDL failure inside it
// therefore RESOLVES and the caller reports success — ten module tables were once reported created
// on this project and none of them existed. ai-boundary.ts solved this by memoising only a state it
// had VERIFIED against information_schema, and this follows it: the database says what is there, not
// this file saying what it asked for. A state that is not ok is never cached, so the next call
// retries.
let verified: RunSchemaState | null = null;
let inflight: Promise<RunSchemaState> | null = null;

async function createRunTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hzn_report_run (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id VARCHAR(64) NOT NULL,
      engine_id VARCHAR(64) NOT NULL,
      engine_version VARCHAR(24) NOT NULL,
      interpreter_id VARCHAR(64),
      interpreter_version VARCHAR(24),
      model_provider VARCHAR(24),
      subject_kind VARCHAR(24) NOT NULL,
      subject_id VARCHAR(64) NOT NULL,
      subject_employee_id UUID,
      subject_application_id UUID,
      subject_user_id UUID,
      audience VARCHAR(32) NOT NULL,
      access_basis VARCHAR(24) NOT NULL,
      generated_by_user_id UUID,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      document JSONB NOT NULL,
      coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
      claim_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      redacted BOOLEAN NOT NULL DEFAULT FALSE
    )`);
  // Separate statements, not one batched transaction. An ALTER takes its ACCESS EXCLUSIVE lock
  // before it evaluates IF NOT EXISTS and holds every lock it takes until the transaction commits,
  // so a batch on a busy table queues every reader behind it. That took this site down once.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hzn_run_report_idx ON hzn_report_run (report_id, generated_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hzn_run_subject_emp_idx ON hzn_report_run (subject_employee_id, generated_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hzn_run_subject_app_idx ON hzn_report_run (subject_application_id, generated_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hzn_run_generated_by_idx ON hzn_report_run (generated_by_user_id, generated_at DESC)`);
}

async function readRunSchemaState(): Promise<RunSchemaState> {
  const state: RunSchemaState = {
    ok: false, present: false, missingColumns: [], error: null, checkedAt: new Date().toISOString(),
  };
  try {
    const rows = toRows(await db.execute(sql`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'hzn_report_run'`));
    const have = new Set(rows.map((r: any) => String(r.column_name)));
    state.present = have.size > 0;
    state.missingColumns = REQUIRED_COLUMNS.filter((c) => !have.has(c));
    state.ok = state.present && state.missingColumns.length === 0;
    if (!state.ok) {
      state.error = state.present
        ? 'hzn_report_run is missing ' + state.missingColumns.join(', ')
        : 'hzn_report_run does not exist';
    }
    return state;
  } catch (e: any) {
    state.error = 'The database could not be asked what exists: ' + dbReason(e);
    return state;
  }
}

export function ensureRunSchema(): Promise<RunSchemaState> {
  if (verified && verified.ok) return Promise.resolve(verified);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let state = await readRunSchemaState();
      if (!state.ok) {
        try { await createRunTable(); } catch (e: any) {
          // Logged with e.cause, where postgres-js puts the reason. e.message is the failed SQL.
          console.error('[horizon.report] hzn_report_run create failed: ' + dbReason(e));
        }
        state = await readRunSchemaState();
      }
      if (state.ok) verified = state;
      return state;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface StoredRun {
  id: string;
  reportId: string;
  engineVersion: string;
  interpreterId: string | null;
  subjectKind: string;
  subjectId: string;
  audience: string;
  accessBasis: string;
  generatedByUserId: string | null;
  generatedAt: string | null;
  redacted: boolean;
  document: ReportDocument;
}

/**
 * Persist a generated document.
 *
 * Returns the run id, or null with the reason logged. A failure to persist NEVER fails the
 * generation: the reader has a correct document in front of them and refusing to show it because an
 * audit row did not write would be trading the useful thing for the record of it. The failure is
 * loud in the logs and visible on the console, which is where an operator would look.
 */
export async function recordRun(input: {
  document: ReportDocument;
  access: AccessDecision;
}): Promise<{ id: string | null; error: string | null }> {
  const doc = input.document;
  try {
    const schema = await ensureRunSchema();
    if (!schema.ok) return { id: null, error: schema.error };

    const counts = {
      facts: doc.sections.facts.claims.length,
      derived: doc.sections.derived.claims.length,
      human_feedback: doc.sections.human_feedback.claims.length,
      ai_interpretation: doc.sections.ai_interpretation.claims.length,
      recommendation: doc.sections.recommendation.claims.length,
      human_decision: doc.sections.human_decision.claims.length,
    };

    const rows = toRows(await db.execute(sql`
      INSERT INTO hzn_report_run (
        report_id, engine_id, engine_version, interpreter_id, interpreter_version, model_provider,
        subject_kind, subject_id, subject_employee_id, subject_application_id, subject_user_id,
        audience, access_basis, generated_by_user_id, document, coverage, claim_counts, redacted
      ) VALUES (
        ${doc.reportId}, ${ENGINE_ID}, ${doc.stamp.engineVersion},
        ${doc.stamp.interpreterId}, ${doc.stamp.interpreterVersion},
        ${doc.stamp.model ? doc.stamp.model.provider : null},
        ${doc.subject.kind}, ${doc.subject.id},
        ${doc.subject.ref.employeeId ?? null}::uuid,
        ${doc.subject.ref.applicationId ?? null}::uuid,
        ${doc.subject.ref.userId ?? null}::uuid,
        ${doc.audience}, ${input.access.basis}, ${doc.generatedForUserId}::uuid,
        ${JSON.stringify(doc)}::jsonb,
        ${JSON.stringify(doc.coverage)}::jsonb,
        ${JSON.stringify(counts)}::jsonb,
        ${doc.redactions.length > 0}
      )
      RETURNING id::text AS id`));
    const r: any = rows[0];
    return { id: r ? String(r.id) : null, error: null };
  } catch (e: any) {
    const reason = dbReason(e);
    console.error('[horizon.report] recordRun failed: ' + reason);
    return { id: null, error: reason };
  }
}

function toStoredRun(r: any): StoredRun {
  return {
    id: String(r.id),
    reportId: String(r.report_id),
    engineVersion: String(r.engine_version),
    interpreterId: r.interpreter_id ? String(r.interpreter_id) : null,
    subjectKind: String(r.subject_kind),
    subjectId: String(r.subject_id),
    audience: String(r.audience),
    accessBasis: String(r.access_basis),
    generatedByUserId: r.generated_by_user_id ? String(r.generated_by_user_id) : null,
    generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : null,
    redacted: r.redacted === true,
    document: (typeof r.document === 'string' ? JSON.parse(r.document) : r.document) as ReportDocument,
  };
}

export async function getRun(id: string): Promise<StoredRun | null> {
  if (!id) return null;
  try {
    const schema = await ensureRunSchema();
    if (!schema.ok) return null;
    const rows = toRows(await db.execute(sql`
      SELECT * FROM hzn_report_run WHERE id = ${id}::uuid LIMIT 1`));
    const r: any = rows[0];
    return r ? toStoredRun(r) : null;
  } catch (e: any) {
    console.error('[horizon.report] getRun failed: ' + dbReason(e));
    return null;
  }
}

/**
 * Recent runs, for the console.
 *
 * `document` is a whole report and several of them in one list is a lot of JSON to ship to render a
 * table of dates. The columns are selected explicitly and the document is left behind.
 */
export async function recentRuns(limit = 25): Promise<Omit<StoredRun, 'document'>[]> {
  try {
    const schema = await ensureRunSchema();
    if (!schema.ok) return [];
    const cap = Math.max(1, Math.min(100, Math.round(limit)));
    const rows = toRows(await db.execute(sql`
      SELECT id::text AS id, report_id, engine_version, interpreter_id, subject_kind, subject_id,
             audience, access_basis, generated_by_user_id::text AS generated_by_user_id,
             generated_at, redacted
        FROM hzn_report_run
       ORDER BY generated_at DESC
       LIMIT ${cap}`));
    return rows.map((r: any) => {
      const run = toStoredRun({ ...r, document: '{}' });
      const { document, ...rest } = run;
      return rest;
    });
  } catch (e: any) {
    console.error('[horizon.report] recentRuns failed: ' + dbReason(e));
    return [];
  }
}

/**
 * RETENTION, AS A FUNCTION SOMETHING ELSE CAN CALL.
 *
 * Each row holds a snapshot of somebody's professional record. Keeping those forever is a growing
 * disclosure with no expiry, and the right retention period is a policy question this patch does not
 * get to answer. So the mechanism exists and the schedule does not: the operations patch owns the
 * cron, calls this with the number the organisation decides on, and the deletion is auditable
 * because it returns what it removed.
 *
 * Nothing in this patch calls it. That is stated in the handoff rather than hidden behind a default.
 */
export async function purgeRunsOlderThan(days: number): Promise<{ deleted: number; error: string | null }> {
  const d = Math.max(1, Math.round(days));
  try {
    const schema = await ensureRunSchema();
    if (!schema.ok) return { deleted: 0, error: schema.error };
    const rows = toRows(await db.execute(sql`
      DELETE FROM hzn_report_run
       WHERE generated_at < (NOW() - (${d} || ' days')::interval)
       RETURNING id`));
    return { deleted: rows.length, error: null };
  } catch (e: any) {
    return { deleted: 0, error: dbReason(e) };
  }
}
