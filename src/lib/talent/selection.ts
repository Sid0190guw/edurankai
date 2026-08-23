// src/lib/talent/selection.ts — THE DECISION RECORD, and the two acts that follow it.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 6B and 26.4.
//
// WHY THIS MODULE IS THE SPINE. Everything downstream descends from one row here:
// src/lib/talent/codes.ts refuses to mint a code unless `approved_for_onboarding_at` is set on a
// decision of 'selected', and no identity exists that did not come from an onboarding that came from
// a code that came from this row. Until this file existed, issueCode() could never succeed against
// anything, because there was nothing to approve.
//
// THE TWO ACTS ARE DELIBERATELY SEPARATE, AND THEY ARE THE POINT OF THE MODULE.
//
//   recordDecision()        the hiring desk says yes           needs selection.decide
//   approveForOnboarding()  People Operations admits them      needs selection.approve_onboarding
//
// One person doing both takes somebody from applicant to employee alone. For an ordinary position
// that is merely undesirable; for a position flagged `is_sensitive` in org_positions it is refused
// outright, below, by comparing the two actor ids. That is the separation of duties in spec 35, and
// it is enforced here rather than in a page because a second page would forget.
//
// NOTHING AUTOMATED WRITES A DECISION. `decided_by_user_id` is NOT NULL in the schema and every
// entry point to this module demands a real user id, because assessment scores, proctoring flags and
// model output on this platform are ADVISORY and a human decides (spec F12). There is no code path
// here that a scheduler could call.
import { ensureTalentSchema } from './schema';
import { allocateCode } from './ids';
import { logAudit, logAuditOrThrow } from '@/lib/audit';
import { emitTalentEvent, TALENT_EVENTS, TALENT_SUBJECT_KINDS } from './events';
import {
  rowsOf, reasonOf, okResult, failResult,
  type TalentResult, type SelectionDecision, type SelectionDecisionValue,
} from './types';

// ---------------------------------------------------------------------------------------------
// Declared before anything that uses them. `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/** The three values the column accepts. A fourth would need a decision, not an edit. */
const DECISIONS: readonly SelectionDecisionValue[] = ['selected', 'waitlisted', 'rejected'];

/**
 * A reason is not optional and not a formality: it is what the candidate is shown and what an appeal
 * is heard against (/policy/candidate-transparency, and /portal/appeals which already exists). Ten
 * characters is not a quality bar — it is a floor that rejects "no", "n/a" and an accidental space.
 */
const MIN_REASON_CHARS = 10;

/** Lazy, exactly as codes.ts does it: the pure helpers above stay testable without a connection. */
async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const trimmed = (v: unknown): string => String(v ?? '').trim();

/** Rows come back with snake_case columns; one mapper so no caller invents its own. */
function toDecision(x: any): SelectionDecision {
  return {
    id: String(x.id),
    selectionCode: String(x.selection_code || ''),
    applicationId: String(x.application_id || ''),
    personId: String(x.person_id || ''),
    opportunityId: String(x.opportunity_id || ''),
    decision: String(x.decision || 'rejected') as SelectionDecisionValue,
    reason: String(x.reason || ''),
    decidedByUserId: String(x.decided_by_user_id || ''),
    decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : '',
    positionId: x.position_id ? String(x.position_id) : null,
    departmentId: x.department_id ? String(x.department_id) : null,
    employmentType: x.employment_type ? String(x.employment_type) : null,
    level: x.level ? String(x.level) : null,
    reportingManagerUserId: x.reporting_manager_user_id ? String(x.reporting_manager_user_id) : null,
    proposedJoiningDate: x.proposed_joining_date ? String(x.proposed_joining_date).slice(0, 10) : null,
    compensationNote: x.compensation_note ? String(x.compensation_note) : null,
    approvedForOnboardingAt: x.approved_for_onboarding_at ? new Date(x.approved_for_onboarding_at).toISOString() : null,
    approvedForOnboardingBy: x.approved_for_onboarding_by ? String(x.approved_for_onboarding_by) : null,
    withdrawnAt: x.withdrawn_at ? new Date(x.withdrawn_at).toISOString() : null,
    withdrawnReason: x.withdrawn_reason ? String(x.withdrawn_reason) : null,
  };
}

const COLS = `id, selection_code, application_id, person_id, opportunity_id, decision, reason,
  decided_by_user_id, decided_at, position_id, department_id, employment_type, level,
  reporting_manager_user_id, proposed_joining_date, compensation_note,
  approved_for_onboarding_at, approved_for_onboarding_by, withdrawn_at, withdrawn_reason`;

// ---------------------------------------------------------------------------------------------
// PURE VALIDATION. Exported so the console can show every problem at once, and so the rules have a
// test that opens no connection.
// ---------------------------------------------------------------------------------------------

export interface DecisionInput {
  applicationId: string;
  decision: SelectionDecisionValue;
  reason: string;
  positionId?: string | null;
  departmentId?: string | null;
  employmentType?: string | null;
  level?: string | null;
  reportingManagerUserId?: string | null;
  proposedJoiningDate?: string | null;
  compensationNote?: string | null;
}

/**
 * PURE. EVERY problem, not the first.
 *
 * Returning one problem at a time makes an operator submit the form five times to discover five
 * things, and this form is submitted about a person who is waiting for an answer.
 */
export function decisionProblems(input: Partial<DecisionInput>): string[] {
  const problems: string[] = [];
  if (!trimmed(input.applicationId)) problems.push('No application was named.');
  if (!DECISIONS.includes(input.decision as SelectionDecisionValue)) {
    problems.push('The decision must be selected, waitlisted or rejected.');
  }
  const reason = trimmed(input.reason);
  if (!reason) {
    problems.push('A written reason is required. It is what the candidate is shown and what an appeal is heard against.');
  } else if (reason.length < MIN_REASON_CHARS) {
    problems.push(`The reason is too short to tell the candidate anything — write at least ${MIN_REASON_CHARS} characters.`);
  }
  // A selection has to say what the person was selected FOR. Without a department and an employment
  // type the onboarding form has no organisation-controlled fields to render read-only, and the
  // joiner is asked to type their own department — which is exactly the thing spec 11 forbids.
  if (input.decision === 'selected') {
    if (!trimmed(input.departmentId)) problems.push('A selected candidate needs a department: it is what their onboarding and access are derived from.');
    if (!trimmed(input.employmentType)) problems.push('A selected candidate needs an employment type: it decides which onboarding pack and which identity series apply.');
  }
  const joining = trimmed(input.proposedJoiningDate);
  if (joining && !/^\d{4}-\d{2}-\d{2}$/.test(joining)) {
    problems.push('The joining date must be written as YYYY-MM-DD.');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------------------------

export async function getSelection(id: string): Promise<SelectionDecision | null> {
  if (!trimmed(id)) return null;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM tal_selection_decision WHERE id = ${id}::uuid LIMIT 1`));
    return rows.length ? toDecision(rows[0]) : null;
  } catch (e: any) {
    console.error('[talent-selection] getSelection: ' + reasonOf(e));
    return null;
  }
}

export async function getSelectionByCode(code: string): Promise<SelectionDecision | null> {
  const c = trimmed(code).toUpperCase();
  if (!c) return null;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM tal_selection_decision WHERE selection_code = ${c} LIMIT 1`));
    return rows.length ? toDecision(rows[0]) : null;
  } catch (e: any) {
    console.error('[talent-selection] getSelectionByCode: ' + reasonOf(e));
    return null;
  }
}

export async function getSelectionByApplication(applicationId: string): Promise<SelectionDecision | null> {
  if (!trimmed(applicationId)) return null;
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM tal_selection_decision
      WHERE application_id = ${applicationId}::uuid LIMIT 1`));
    return rows.length ? toDecision(rows[0]) : null;
  } catch (e: any) {
    console.error('[talent-selection] getSelectionByApplication: ' + reasonOf(e));
    return null;
  }
}

export async function listSelections(
  filter: { decision?: SelectionDecisionValue; approved?: boolean; limit?: number } = {},
): Promise<SelectionDecision[]> {
  try {
    const { db, sql } = await ctx();
    const limit = Math.min(Math.max(1, Number(filter.limit) || 100), 500);
    // Conditions are composed as SQL fragments, never string-concatenated, so a filter value can
    // never become part of the statement.
    const conds: any[] = [sql`withdrawn_at IS NULL`];
    if (filter.decision) conds.push(sql`decision = ${filter.decision}`);
    if (filter.approved === true) conds.push(sql`approved_for_onboarding_at IS NOT NULL`);
    if (filter.approved === false) conds.push(sql`approved_for_onboarding_at IS NULL`);
    let where = conds[0];
    for (let i = 1; i < conds.length; i++) where = sql`${where} AND ${conds[i]}`;
    const rows = rowsOf(await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM tal_selection_decision
      WHERE ${where} ORDER BY decided_at DESC LIMIT ${limit}`));
    return rows.map(toDecision);
  } catch (e: any) {
    console.error('[talent-selection] listSelections: ' + reasonOf(e));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// ACT ONE — THE DECISION
// ---------------------------------------------------------------------------------------------

/**
 * Record that a candidate is selected, waitlisted or not selected.
 *
 * ONE DECISION PER APPLICATION, enforced by a UNIQUE index on application_id. A second attempt is
 * refused by NAME — the existing selection code is handed back — rather than by a constraint error,
 * because "23505" tells an operator nothing about what already happened.
 */
export async function recordDecision(
  input: DecisionInput,
  actorUserId: string,
): Promise<TalentResult<SelectionDecision>> {
  if (!trimmed(actorUserId)) {
    return failResult('A selection decision must name the person making it. There is no automated selection path.');
  }
  const problems = decisionProblems(input);
  if (problems.length) return failResult(problems.join(' '));

  try {
    const { db, sql } = await ctx();

    // The application is re-read rather than trusted from the form: the console's data may be a
    // minute old, and "decide on an application that was withdrawn while the page was open" is an
    // ordinary sequence rather than a hypothetical.
    const apps = rowsOf(await db.execute(sql`
      SELECT id, person_id, opportunity_id, status
      FROM tal_application WHERE id = ${input.applicationId}::uuid LIMIT 1`));
    if (!apps.length) return failResult('That application could not be read back, so no decision was recorded.');
    const app = apps[0] as any;
    if (String(app.status) === 'withdrawn') {
      return failResult('That application was withdrawn by the candidate. A decision cannot be recorded against it.');
    }

    const existing = rowsOf(await db.execute(sql`
      SELECT selection_code, decision FROM tal_selection_decision
      WHERE application_id = ${input.applicationId}::uuid LIMIT 1`));
    if (existing.length) {
      return failResult(
        `A decision already exists for this application (${existing[0].selection_code}, "${existing[0].decision}"). `
        + 'A decision is recorded once; correct it by withdrawing this selection with a reason.',
      );
    }

    const selectionCode = await allocateCode('selection');
    const reason = trimmed(input.reason);

    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO tal_selection_decision (
        selection_code, application_id, person_id, opportunity_id, decision, reason,
        decided_by_user_id, position_id, department_id, employment_type, level,
        reporting_manager_user_id, proposed_joining_date, compensation_note
      ) VALUES (
        ${selectionCode}, ${input.applicationId}::uuid, ${String(app.person_id)}::uuid,
        ${String(app.opportunity_id)}::uuid, ${input.decision}, ${reason},
        ${actorUserId}::uuid,
        ${input.positionId ? String(input.positionId) : null}::uuid,
        ${input.departmentId ? trimmed(input.departmentId) : null},
        ${input.employmentType ? trimmed(input.employmentType) : null},
        ${input.level ? trimmed(input.level) : null},
        ${input.reportingManagerUserId ? String(input.reportingManagerUserId) : null}::uuid,
        ${input.proposedJoiningDate ? trimmed(input.proposedJoiningDate) : null}::date,
        ${input.compensationNote ? trimmed(input.compensationNote) : null}
      )
      RETURNING ${sql.raw(COLS)}`));

    if (!inserted.length) return failResult('The decision was not written. Nothing has been recorded.');
    const decision = toDecision(inserted[0]);

    // The candidate-visible status follows the decision rather than being typed beside it.
    const nextStatus =
      input.decision === 'selected' ? 'selected'
      : input.decision === 'waitlisted' ? 'waitlisted'
      : 'rejected';
    await db.execute(sql`
      UPDATE tal_application
         SET status = ${nextStatus}, closed_at = NOW(), updated_at = NOW()
       WHERE id = ${input.applicationId}::uuid`);

    // STRICT. This row is the control: everything downstream — the code, the identity, the access —
    // cites it as its authority, so a decision that could not be written to the audit log must not
    // stand as if it had been.
    await logAuditOrThrow({
      userId: actorUserId,
      action: 'selection.decided',
      entity: 'tal_selection_decision',
      entityId: decision.id,
      diff: { selectionCode, decision: input.decision, applicationId: input.applicationId },
    });

    const eventName =
      input.decision === 'selected' ? TALENT_EVENTS.CANDIDATE_SELECTED
      : input.decision === 'waitlisted' ? TALENT_EVENTS.CANDIDATE_WAITLISTED
      : TALENT_EVENTS.CANDIDATE_REJECTED;
    await emitTalentEvent(
      eventName, TALENT_SUBJECT_KINDS.SELECTION, decision.id,
      { selectionCode, applicationId: input.applicationId, decision: input.decision },
      actorUserId,
    );

    return okResult(decision);
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-selection] recordDecision: ' + reason);
    return failResult('The decision could not be recorded: ' + reason);
  }
}

// ---------------------------------------------------------------------------------------------
// ACT TWO — ADMISSION
// ---------------------------------------------------------------------------------------------

/**
 * Approve a selected candidate for onboarding. This is what unlocks issueCode().
 *
 * SEPARATION OF DUTIES. For a position flagged `is_sensitive`, the approver may not be the account
 * that recorded the decision. The rule lives here and not on the page because a second page would
 * forget it, and because the two acts are the only thing standing between one administrator and a
 * complete applicant-to-employee pipeline run by one person with nobody else in it.
 */
export async function approveForOnboarding(
  selectionId: string,
  actorUserId: string,
): Promise<TalentResult> {
  if (!trimmed(actorUserId)) return failResult('Approval must name the person granting it.');
  try {
    const { db, sql } = await ctx();

    const rows = rowsOf(await db.execute(sql`
      SELECT s.id, s.selection_code, s.decision, s.decided_by_user_id, s.withdrawn_at,
             s.approved_for_onboarding_at, s.position_id, s.person_id,
             COALESCE(p.is_sensitive, FALSE) AS is_sensitive
        FROM tal_selection_decision s
        LEFT JOIN org_positions p ON p.id = s.position_id
       WHERE s.id = ${selectionId}::uuid LIMIT 1`));
    if (!rows.length) return failResult('That selection could not be read back, so nothing was approved.');
    const s = rows[0] as any;

    if (s.withdrawn_at) return failResult('That selection has been withdrawn. Reinstate it before approving.');
    if (String(s.decision) !== 'selected') {
      return failResult(`Only a decision of "selected" can be approved for onboarding. This one is "${s.decision}".`);
    }
    if (s.approved_for_onboarding_at) {
      return failResult('That selection is already approved for onboarding. Issue a code from the same row.');
    }
    if (s.is_sensitive === true && String(s.decided_by_user_id) === trimmed(actorUserId)) {
      return failResult(
        'This position is marked sensitive, so the person who recorded the selection cannot also approve it '
        + 'for onboarding. Ask a second authorised approver.',
      );
    }

    const updated = rowsOf(await db.execute(sql`
      UPDATE tal_selection_decision
         SET approved_for_onboarding_at = NOW(), approved_for_onboarding_by = ${actorUserId}::uuid
       WHERE id = ${selectionId}::uuid AND approved_for_onboarding_at IS NULL
       RETURNING id`));
    if (!updated.length) {
      // Lost a race with another approver. Not an error worth alarming anybody about, but it must
      // not report success either: somebody else's name is on the approval, not this caller's.
      return failResult('Somebody else approved this selection a moment ago. Reload to see who.');
    }

    await logAuditOrThrow({
      userId: actorUserId,
      action: 'selection.approved_for_onboarding',
      entity: 'tal_selection_decision',
      entityId: selectionId,
      diff: { selectionCode: String(s.selection_code || '') },
    });

    await emitTalentEvent(
      TALENT_EVENTS.SELECTION_APPROVED_FOR_ONBOARDING, TALENT_SUBJECT_KINDS.SELECTION, selectionId,
      { selectionCode: String(s.selection_code || '') }, actorUserId,
    );

    return okResult(undefined);
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[talent-selection] approveForOnboarding: ' + reason);
    return failResult('The approval could not be recorded: ' + reason);
  }
}

/**
 * Withdraw a selection.
 *
 * It does NOT delete anything: the decision stays on the record with the reason it was withdrawn,
 * because a person was told they had been selected and that fact does not stop being true.
 *
 * Any live code for the selection is revoked in the same breath — leaving one active would let
 * somebody onboard against a selection that no longer stands. The in-progress onboarding is left to
 * the reviewer rather than force-closed here; the console shows it as suspended.
 */
export async function withdrawSelection(
  selectionId: string,
  actorUserId: string,
  reason: string,
): Promise<TalentResult> {
  const why = trimmed(reason);
  if (!trimmed(actorUserId)) return failResult('A withdrawal must name the person making it.');
  if (why.length < MIN_REASON_CHARS) {
    return failResult(`A withdrawal needs a written reason of at least ${MIN_REASON_CHARS} characters.`);
  }
  try {
    const { db, sql } = await ctx();
    const updated = rowsOf(await db.execute(sql`
      UPDATE tal_selection_decision
         SET withdrawn_at = NOW(), withdrawn_reason = ${why}
       WHERE id = ${selectionId}::uuid AND withdrawn_at IS NULL
       RETURNING id, selection_code`));
    if (!updated.length) return failResult('That selection was already withdrawn, or could not be read back.');

    // Revoke any live code. Done directly rather than through codes.ts to avoid a circular import;
    // the revocation reason names this withdrawal so the code console explains itself.
    const codes = rowsOf(await db.execute(sql`
      UPDATE tal_onboarding_code
         SET status = 'revoked', revoked_at = NOW(), revoked_by = ${actorUserId}::uuid,
             revoked_reason = ${'Selection withdrawn: ' + why}
       WHERE selection_id = ${selectionId}::uuid AND status = 'active'
       RETURNING id, code_id`));

    await logAuditOrThrow({
      userId: actorUserId,
      action: 'selection.withdrawn',
      entity: 'tal_selection_decision',
      entityId: selectionId,
      diff: { reason: why, codesRevoked: codes.length },
    });

    for (const c of codes) {
      await emitTalentEvent(
        TALENT_EVENTS.ONBOARDING_CODE_REVOKED, TALENT_SUBJECT_KINDS.ONBOARDING_CODE, String(c.id),
        { codeId: String(c.code_id || ''), because: 'selection_withdrawn' }, actorUserId,
      );
    }

    return okResult(undefined);
  } catch (e: any) {
    const reason2 = reasonOf(e);
    console.error('[talent-selection] withdrawSelection: ' + reason2);
    return failResult('The withdrawal could not be recorded: ' + reason2);
  }
}

// ---------------------------------------------------------------------------------------------
// THE CONSOLE QUERY
// ---------------------------------------------------------------------------------------------

export interface SelectedRow {
  selectionId: string;
  selectionCode: string;
  personName: string;
  personCode: string;
  opportunityTitle: string;
  departmentId: string | null;
  employmentType: string | null;
  proposedJoiningDate: string | null;
  decidedAt: string;
  approvedForOnboardingAt: string | null;
  codeStatus: string | null;
  codeId: string | null;
  codeValidUntil: string | null;
  onboardingStatus: string | null;
  onboardingId: string | null;
  documentCount: number;
  identityCode: string | null;
  identityStatus: string | null;
}

/**
 * Every selected candidate and exactly how far they have got — spec 6B.
 *
 * LEFT JOINS THROUGHOUT, DELIBERATELY. A candidate with no code yet, no onboarding and no identity is
 * precisely the person this console exists to surface: they are the queue. An inner join would hide
 * everybody who is waiting, which is the one thing the screen must never do.
 */
export async function selectedCandidatesBoard(limit = 200): Promise<SelectedRow[]> {
  try {
    const { db, sql } = await ctx();
    const lim = Math.min(Math.max(1, Number(limit) || 200), 500);
    const rows = rowsOf(await db.execute(sql`
      SELECT s.id                AS selection_id,
             s.selection_code,
             s.department_id,
             s.employment_type,
             s.proposed_joining_date,
             s.decided_at,
             s.approved_for_onboarding_at,
             COALESCE(p.display_name, '')  AS person_name,
             COALESCE(p.person_code, '')   AS person_code,
             COALESCE(o.title, '')         AS opportunity_title,
             c.status                      AS code_status,
             c.code_id                     AS code_id,
             c.valid_until                 AS code_valid_until,
             ob.id                         AS onboarding_id,
             ob.status                     AS onboarding_status,
             i.identity_code               AS identity_code,
             i.status                      AS identity_status,
             (SELECT COUNT(*) FROM tal_document_ref d
               WHERE d.subject_kind = 'onboarding' AND d.subject_id = ob.id) AS document_count
        FROM tal_selection_decision s
        LEFT JOIN tal_person p        ON p.id = s.person_id
        LEFT JOIN tal_opportunity o   ON o.id = s.opportunity_id
        LEFT JOIN tal_onboarding_code c
               ON c.selection_id = s.id AND c.status = 'active'
        LEFT JOIN tal_onboarding_application ob ON ob.selection_id = s.id
        LEFT JOIN tal_identity i      ON i.selection_id = s.id
       WHERE s.decision = 'selected' AND s.withdrawn_at IS NULL
       ORDER BY s.approved_for_onboarding_at IS NULL DESC, s.decided_at DESC
       LIMIT ${lim}`));

    return rows.map((x: any) => ({
      selectionId: String(x.selection_id),
      selectionCode: String(x.selection_code || ''),
      personName: String(x.person_name || ''),
      personCode: String(x.person_code || ''),
      opportunityTitle: String(x.opportunity_title || ''),
      departmentId: x.department_id ? String(x.department_id) : null,
      employmentType: x.employment_type ? String(x.employment_type) : null,
      proposedJoiningDate: x.proposed_joining_date ? String(x.proposed_joining_date).slice(0, 10) : null,
      decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : '',
      approvedForOnboardingAt: x.approved_for_onboarding_at ? new Date(x.approved_for_onboarding_at).toISOString() : null,
      codeStatus: x.code_status ? String(x.code_status) : null,
      codeId: x.code_id ? String(x.code_id) : null,
      codeValidUntil: x.code_valid_until ? new Date(x.code_valid_until).toISOString() : null,
      onboardingStatus: x.onboarding_status ? String(x.onboarding_status) : null,
      onboardingId: x.onboarding_id ? String(x.onboarding_id) : null,
      documentCount: Number(x.document_count || 0),
      identityCode: x.identity_code ? String(x.identity_code) : null,
      identityStatus: x.identity_status ? String(x.identity_status) : null,
    }));
  } catch (e: any) {
    console.error('[talent-selection] selectedCandidatesBoard: ' + reasonOf(e));
    // An empty array here would read on screen as "nobody is waiting", which is the most dangerous
    // wrong answer this console can give. The caller distinguishes the two by catching the throw.
    throw e;
  }
}

/** Counts for the dashboard. Cheap, and separate from the board so a tile never loads 200 rows. */
export async function selectionCounts(): Promise<{ selected: number; awaitingApproval: number; awaitingCode: number }> {
  try {
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE s.decision = 'selected' AND s.withdrawn_at IS NULL) AS selected,
        COUNT(*) FILTER (WHERE s.decision = 'selected' AND s.withdrawn_at IS NULL
                           AND s.approved_for_onboarding_at IS NULL) AS awaiting_approval,
        COUNT(*) FILTER (WHERE s.decision = 'selected' AND s.withdrawn_at IS NULL
                           AND s.approved_for_onboarding_at IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM tal_onboarding_code c
                                            WHERE c.selection_id = s.id AND c.status IN ('active','consumed')))
          AS awaiting_code
      FROM tal_selection_decision s`));
    const r = rows[0] || {};
    return {
      selected: Number(r.selected || 0),
      awaitingApproval: Number(r.awaiting_approval || 0),
      awaitingCode: Number(r.awaiting_code || 0),
    };
  } catch (e: any) {
    console.error('[talent-selection] selectionCounts: ' + reasonOf(e));
    throw e;
  }
}
