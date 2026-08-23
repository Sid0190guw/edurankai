// src/lib/horizon/governance/ledger.ts — THE HUMAN DECISION LOG, THE VERSION REGISTRY, AND THE
// AUDIT ANSWER.
//
// =================================================================================================
// WHAT THIS FILE OWNS, AND WHAT IT ONLY READS
// =================================================================================================
//
// OWNS (writes):  hgov_decision_log, hgov_engine_version.
// READS ONLY:     hzn_access_log, hzn_computation, hzn_intelligence_result,
//                 hzn_feedback_contribution, hzn_recompute_request.
//
// The hzn_* tables belong to src/lib/horizon/schema.ts and the patches that write them. This module
// SELECTs from them to assemble the audit answer and writes to none of them. That distinction is the
// whole reason this layer can exist alongside the rest of HORIZON rather than on top of it.
//
// An earlier draft of this file declared its own generation log, recommendation log, feedback
// revision history and recompute log. All four already existed under other names. They were removed:
// a second generation log means "what produced this output" has two answers, and the screen that
// reads the wrong one is honestly reporting nothing.
//
// =================================================================================================
// THE TWO REFUSALS IN THIS FILE
// =================================================================================================
//
//  1. recordHumanDecision() REFUSES anything but a real, active, named user (brief rule 14). There is
//     no service account, no scheduled writer and no system actor. An automated decision is not
//     forbidden by policy here — it is unreachable, because no code path exists that would write the
//     row without a person.
//
//  2. registerEngineVersion() REFUSES to redefine a version that already exists with different
//     parameters. Two runs claiming one version and producing different answers is exactly what a
//     version registry exists to make impossible; ship a new version instead.
import { ensureGovernanceSchema } from './schema';
import { impactOfPurpose } from './matrix';
import type { SubjectRef } from '@/lib/horizon/ids';
import type {
  AuditAnswer, AuditAnswerEntry, DecisionKind, EngineVersion, GovernanceActor, GovernanceResult,
  HumanDecisionRecord, ImpactLevel,
} from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const fail = (message: string): GovernanceResult<never> => ({ ok: false, error: message });

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
async function sqlTag(): Promise<any> {
  return (await import('drizzle-orm')).sql;
}

// ---------------------------------------------------------------------------------------------
// 1. THE VERSION REGISTRY  --  what a version string resolves against
// ---------------------------------------------------------------------------------------------

const mapVersion = (r: any): EngineVersion => ({
  version: String(r.version), engineId: String(r.engine_id), engineClass: String(r.engine_class),
  method: String(r.method), paramsDigest: r.params_digest ? String(r.params_digest) : null,
  notes: r.notes ? String(r.notes) : null,
  activatedAt: String(r.activated_at), retiredAt: r.retired_at ? String(r.retired_at) : null,
});

export async function registerEngineVersion(input: {
  version: string;
  engineId: string;
  engineClass: string;
  method: string;
  paramsDigest?: string | null;
  notes?: string | null;
  actor: GovernanceActor;
}): Promise<GovernanceResult<EngineVersion>> {
  const version = String(input?.version || '').trim();
  const engineId = String(input?.engineId || '').trim();
  const engineClass = String(input?.engineClass || '').trim();
  const method = String(input?.method || '').trim();
  if (!version || !engineId || !engineClass || !method) {
    return fail('A version needs a version string, an engine id, an engine class and a method.');
  }
  if (!input?.actor?.id) return fail('A signed-in person must be recorded as registering the version.');

  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const existing = rows(await db.execute(sql`SELECT * FROM hgov_engine_version WHERE version = ${version} LIMIT 1`));
    if (existing.length > 0) {
      const e = existing[0];
      const same = String(e.engine_id) === engineId && String(e.method) === method
        && String(e.params_digest || '') === String(input.paramsDigest || '');
      if (!same) {
        return fail('Version "' + version + '" is already registered for ' + e.engine_id
          + ' with different parameters. Register a new version rather than redefining this one.');
      }
      return { ok: true, data: mapVersion(e) };
    }
    const r = rows(await db.execute(sql`
      INSERT INTO hgov_engine_version (version, engine_id, engine_class, method, params_digest, notes, registered_by)
      VALUES (${version}, ${engineId}, ${engineClass}, ${method}, ${input.paramsDigest || null},
              ${input.notes || null}, ${input.actor.id}::uuid)
      RETURNING *`));
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: input.actor.id, action: 'horizon.version.registered',
      entity: 'hgov_engine_version', entityId: version,
      diff: { engineId, engineClass, method }, ipAddress: input.actor.ip || undefined,
    });
    return { ok: true, data: mapVersion(r[0]) };
  } catch (e: any) { return fail(reason(e)); }
}

export async function listEngineVersions(engineId?: string): Promise<EngineVersion[]> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const r = engineId
      ? rows(await db.execute(sql`SELECT * FROM hgov_engine_version WHERE engine_id = ${engineId} ORDER BY activated_at DESC`))
      : rows(await db.execute(sql`SELECT * FROM hgov_engine_version ORDER BY engine_id ASC, activated_at DESC`));
    return r.map(mapVersion);
  } catch { return []; }
}

/** Retire a version. Retired versions stay readable — computation rows written under them name them. */
export async function retireEngineVersion(version: string, actor: GovernanceActor): Promise<GovernanceResult> {
  if (!version || !actor?.id) return fail('A version and a signed-in person are required.');
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    await db.execute(sql`UPDATE hgov_engine_version SET retired_at = NOW() WHERE version = ${version} AND retired_at IS NULL`);
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: actor.id, action: 'horizon.version.retired', entity: 'hgov_engine_version', entityId: version, ipAddress: actor.ip || undefined });
    return { ok: true };
  } catch (e: any) { return fail(reason(e)); }
}

/**
 * Which engine versions have produced computations but were never registered.
 *
 * THE HONEST VERSION OF "IS VERSIONING WORKING". hzn_computation stores engine_version as free text,
 * so a producing patch can write anything there. This is the list of strings that resolve to nothing
 * — the answer to "which version was used" that a reader cannot look up. An empty list is the goal;
 * a non-empty one is a list of engines whose output cannot be fully explained.
 */
export async function unregisteredVersions(): Promise<{ version: string; engineId: string; runs: number }[]> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const r = rows(await db.execute(sql`
      SELECT c.engine_version AS version, c.engine_id, COUNT(*)::int AS runs
        FROM hzn_computation c
        LEFT JOIN hgov_engine_version v ON v.version = c.engine_version
       WHERE v.version IS NULL AND c.engine_version IS NOT NULL AND c.engine_version <> ''
       GROUP BY c.engine_version, c.engine_id
       ORDER BY runs DESC LIMIT 100`));
    return r.map((x: any) => ({ version: String(x.version), engineId: String(x.engine_id), runs: Number(x.runs || 0) }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------------------------
// 2. THE HUMAN DECISION LOG  --  "what human action followed"
// ---------------------------------------------------------------------------------------------

/** The shortest rationale that counts as one. "ok", "yes" and "agreed" are not reasons. */
export const MIN_RATIONALE = 15;

const DECISIONS: DecisionKind[] = ['accepted', 'rejected', 'modified', 'deferred'];

const mapDecision = (r: any): HumanDecisionRecord => ({
  id: String(r.id),
  subject: {
    kind: r.subject_kind, id: String(r.subject_id),
    idScheme: r.subject_scheme, organisationId: r.organisation_id,
  } as SubjectRef,
  recommendationRef: r.recommendation_ref ? String(r.recommendation_ref) : null,
  resultId: r.result_id ? String(r.result_id) : null,
  decidedBy: String(r.decided_by),
  decidedByName: r.decided_by_name ? String(r.decided_by_name) : null,
  decision: r.decision,
  rationale: String(r.rationale),
  agreedWithSystem: r.agreed_with_system === true,
  impact: r.impact,
  actionTaken: r.action_taken ? String(r.action_taken) : null,
  engineVersion: r.engine_version ? String(r.engine_version) : null,
  decidedAt: String(r.decided_at),
});

/**
 * Record what a named human decided.
 *
 * THE PERSON IS CHECKED AGAINST `users`, not merely shape-checked as a uuid. That is the difference
 * between a rule and a comment: a uuid-shaped string can be typed by anybody, and the whole point of
 * brief rule 14 is that a real, active person put their name to this.
 */
export async function recordHumanDecision(input: {
  subject: SubjectRef;
  recommendationRef?: string | null;
  resultId?: string | null;
  decidedBy: string;
  decision: DecisionKind;
  rationale: string;
  agreedWithSystem: boolean;
  /** Where the decision follows a purpose-bound read, pass the purpose and the impact is derived. */
  purpose?: string | null;
  impact?: ImpactLevel;
  actionTaken?: string | null;
  engineVersion?: string | null;
  actor: GovernanceActor;
}): Promise<GovernanceResult<{ id: string }>> {
  if (!input?.subject?.id) return fail('A decision needs a subject.');
  if (!input.decidedBy) return fail('A decision must name the person who made it.');
  const rationale = String(input.rationale || '').trim();
  if (rationale.length < MIN_RATIONALE) {
    return fail('Record why. A decision about somebody\'s standing needs a reason of at least '
      + MIN_RATIONALE + ' characters, written at the time rather than reconstructed afterwards.');
  }
  if (!DECISIONS.includes(input.decision)) {
    return fail('"' + String(input.decision) + '" is not a decision this system records.');
  }

  const impact: ImpactLevel = input.impact
    || (input.purpose ? impactOfPurpose(String(input.purpose)) : 'advisory');

  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();

    const who = rows(await db.execute(sql`SELECT id, name, is_active FROM users WHERE id = ${input.decidedBy}::uuid LIMIT 1`));
    if (who.length === 0) return fail('The decision-maker is not a person on this system.');
    if (who[0].is_active === false) return fail('The decision-maker\'s account is deactivated.');

    const r = rows(await db.execute(sql`
      INSERT INTO hgov_decision_log (organisation_id, subject_kind, subject_id, subject_scheme,
                                     recommendation_ref, result_id, decided_by, decided_by_name,
                                     decision, rationale, agreed_with_system, impact, action_taken,
                                     engine_version, ip_address)
      VALUES (${input.subject.organisationId}, ${input.subject.kind}, ${input.subject.id},
              ${input.subject.idScheme}, ${input.recommendationRef || null},
              ${input.resultId ? sql`${input.resultId}::uuid` : sql`NULL`},
              ${input.decidedBy}::uuid, ${who[0].name ? String(who[0].name) : null},
              ${input.decision}, ${rationale}, ${input.agreedWithSystem === true}, ${impact},
              ${input.actionTaken || null}, ${input.engineVersion || null}, ${input.actor?.ip || null})
      RETURNING id`));
    const id = String(r[0].id);

    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: input.actor?.id || input.decidedBy,
      action: 'horizon.decision.' + input.decision,
      entity: 'hgov_decision_log', entityId: id,
      diff: {
        subject: input.subject.kind + ':' + input.subject.id,
        recommendationRef: input.recommendationRef || null,
        impact, agreed: input.agreedWithSystem === true,
      },
      ipAddress: input.actor?.ip || undefined,
    });

    return { ok: true, data: { id } };
  } catch (e: any) { return fail(reason(e)); }
}

export async function decisionsFor(subject: SubjectRef, limit = 100): Promise<HumanDecisionRecord[]> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const r = rows(await db.execute(sql`
      SELECT * FROM hgov_decision_log
       WHERE organisation_id = ${subject.organisationId} AND subject_kind = ${subject.kind}
         AND subject_id = ${subject.id}
       ORDER BY decided_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`));
    return r.map(mapDecision);
  } catch { return []; }
}

/**
 * Is the human-in-the-loop requirement actually being met?
 *
 * hzn_intelligence_result carries `human_review_status`, and rows sitting in `pending` past a
 * deadline are the measure of whether the guarantee is real. A system where results wait months for
 * a review that never comes is one where the machine's output IS the decision in practice, whatever
 * the policy says. The governance console shows this number on its front page for that reason.
 *
 * READS hzn_intelligence_result and writes nothing. The status column belongs to the patch that owns
 * that table; this only counts.
 */
export async function awaitingHumanReview(days = 14): Promise<{ count: number; oldest: string | null; readable: boolean }> {
  try {
    const db = await database();
    const sql = await sqlTag();
    const cutoff = new Date(Date.now() - Math.max(0, days) * 86400000).toISOString();
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n, MIN(computed_at) AS oldest
        FROM hzn_intelligence_result
       WHERE human_review_status IN ('pending', 'in_review') AND computed_at < ${cutoff}::timestamptz`));
    return {
      count: Number(r[0]?.n || 0),
      oldest: r[0]?.oldest ? String(r[0].oldest) : null,
      readable: true,
    };
  } catch {
    // Reported as unknown rather than as zero. "Nothing is waiting" and "I could not check" are
    // different answers and only one of them is reassuring.
    return { count: 0, oldest: null, readable: false };
  }
}

/**
 * How often the humans depart from the machine.
 *
 * The only honest measure of whether the intelligence layer is worth anything, and the number that
 * makes brief rule 25 visible: if nobody ever disagrees, either the machine is perfect or nobody is
 * really reviewing, and the second is far more likely.
 */
export async function agreementRate(days = 90): Promise<{ decisions: number; departed: number; readable: boolean }> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS decisions,
             COUNT(*) FILTER (WHERE agreed_with_system = FALSE)::int AS departed
        FROM hgov_decision_log WHERE decided_at >= ${cutoff}::timestamptz`));
    return { decisions: Number(r[0]?.decisions || 0), departed: Number(r[0]?.departed || 0), readable: true };
  } catch { return { decisions: 0, departed: 0, readable: false }; }
}

// ---------------------------------------------------------------------------------------------
// 3. THE AUDIT ANSWER
// ---------------------------------------------------------------------------------------------

/** How many rows each log contributes before the answer says it has stopped short. */
const PER_LOG_CEILING = 500;

/**
 * Assemble the required answer for one subject over one window, by reading every log that records
 * something about them.
 *
 * SIX QUERIES RATHER THAN ONE UNION, because the six logs have genuinely different shapes and a
 * union that flattened them would need every column nullable — at which point a missing link looks
 * identical to an empty string. They are merged in code, where "no human action has followed" can be
 * stated in words instead of rendered as a blank cell.
 *
 * EVERY QUERY IS TOLERANT OF ITS TABLE BEING ABSENT. Five of the six tables belong to other patches
 * and may not have been created on this database; a missing one is reported in `omitted` rather than
 * taking the whole answer down. A partial answer that says which part is missing is useful. A 500 is
 * not.
 *
 * IT DOES NOT CHECK A PERMISSION. This is the reporting engine; its callers gate on
 * horizon.audit.view and log their own access through authorizeGovernedRead() first. A reporting
 * function that also enforced would be one a future caller could bypass by calling the inner query.
 */
export async function auditAnswer(
  subject: SubjectRef,
  from: Date,
  to: Date = new Date(),
): Promise<AuditAnswer> {
  const answer: AuditAnswer = {
    subject,
    window: { from: from.toISOString(), to: to.toISOString() },
    entries: [],
    omitted: [],
  };
  if (!subject?.id) {
    answer.omitted.push({ what: 'everything', why: 'no subject was named' });
    return answer;
  }

  const f = from.toISOString();
  const t = to.toISOString();
  const org = subject.organisationId;
  const k = subject.kind;
  const i = subject.id;

  let db: any;
  let sql: any;
  try {
    await ensureGovernanceSchema();
    db = await database();
    sql = await sqlTag();
  } catch (e: any) {
    answer.omitted.push({ what: 'the whole trail', why: 'the database could not be reached: ' + reason(e) });
    return answer;
  }

  // One helper so a missing table becomes a line in `omitted` rather than an exception that loses
  // the five logs that WERE readable.
  const read = async (what: string, run: () => Promise<any>): Promise<any[]> => {
    try {
      const r = rows(await run());
      if (r.length >= PER_LOG_CEILING) {
        answer.omitted.push({ what: 'older ' + what + ' entries', why: 'the window returned the ' + PER_LOG_CEILING + '-row ceiling; narrow the dates to see the rest' });
      }
      return r;
    } catch (e: any) {
      answer.omitted.push({ what, why: 'could not be read: ' + reason(e) });
      return [];
    }
  };

  const [access, computations, results, decisions, feedback, recomputes] = await Promise.all([
    read('access', () => db.execute(sql`
      SELECT id, actor_kind, actor_id, actor_name, audience, visibility_served, purpose,
             succeeded, refusal_reason, created_at
        FROM hzn_access_log
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND created_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY created_at DESC LIMIT ${PER_LOG_CEILING}`)),
    read('computation', () => db.execute(sql`
      SELECT id, engine_id, engine_class, engine_version, status, outcome, trigger_reason,
             inputs_digest, started_at
        FROM hzn_computation
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND started_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY started_at DESC LIMIT ${PER_LOG_CEILING}`)),
    read('intelligence result', () => db.execute(sql`
      SELECT id, dimension_family, dimension_key, dimension_label, confidence_band, status,
             summary, engine_id, computed_at, human_review_status
        FROM hzn_intelligence_result
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND computed_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY computed_at DESC LIMIT ${PER_LOG_CEILING}`)),
    read('human decision', () => db.execute(sql`
      SELECT * FROM hgov_decision_log
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND decided_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY decided_at DESC LIMIT ${PER_LOG_CEILING}`)),
    read('feedback', () => db.execute(sql`
      SELECT id, created_at FROM hzn_feedback_contribution
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND created_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY created_at DESC LIMIT ${PER_LOG_CEILING}`)),
    read('recomputation', () => db.execute(sql`
      SELECT id, reason, requested_at FROM hzn_recompute_request
       WHERE organisation_id = ${org} AND subject_kind = ${k} AND subject_id = ${i}
         AND requested_at BETWEEN ${f}::timestamptz AND ${t}::timestamptz
       ORDER BY requested_at DESC LIMIT ${PER_LOG_CEILING}`)),
  ]);

  // WHAT HUMAN ACTION FOLLOWED, per result. One pass over the decisions already read rather than a
  // correlated subquery per row. It is what turns "a result exists" into "and here is what somebody
  // did about it" — or, just as importantly, "and nobody has".
  const byResult = new Map<string, any>();
  const byRef = new Map<string, any>();
  for (const d of decisions) {
    if (d.result_id) byResult.set(String(d.result_id), d);
    if (d.recommendation_ref) byRef.set(String(d.recommendation_ref), d);
  }
  const decidedLabel = (d: any): string =>
    String(d.decided_by_name || 'a named person') + ' ' + String(d.decision) + ' it on '
    + String(d.decided_at) + ' — ' + String(d.rationale);

  for (const r of access) {
    const refused = r.succeeded === false;
    answer.entries.push({
      at: String(r.created_at),
      actorId: r.actor_id ? String(r.actor_id) : null,
      actorLabel: String(r.actor_name || r.actor_id || 'unknown'),
      what: 'read the record as ' + String(r.audience) + ' (' + String(r.visibility_served) + ')',
      why: String(r.purpose || 'no purpose recorded'),
      permission: String(r.audience),
      changed: '',
      engineVersion: null,
      humanAction: refused ? 'Refused: ' + String(r.refusal_reason || 'no reason recorded') : null,
      source: 'access',
      sourceId: String(r.id),
    });
  }

  for (const r of computations) {
    answer.entries.push({
      at: String(r.started_at),
      actorId: null,
      actorLabel: String(r.engine_id) + ' (system)',
      what: 'ran ' + String(r.engine_class) + ' engine ' + String(r.engine_id),
      why: String(r.trigger_reason || 'no trigger recorded'),
      permission: null,
      changed: String(r.status) + (r.outcome ? ' — ' + String(r.outcome) : '')
        + (r.inputs_digest ? ' (inputs digest ' + String(r.inputs_digest).slice(0, 12) + ')' : ''),
      engineVersion: String(r.engine_version),
      humanAction: null,
      source: 'computation',
      sourceId: String(r.id),
    });
  }

  for (const r of results) {
    const d = byResult.get(String(r.id));
    const review = String(r.human_review_status || '');
    answer.entries.push({
      at: String(r.computed_at),
      actorId: null,
      actorLabel: String(r.engine_id) + ' (system)',
      what: 'result: ' + String(r.dimension_label || r.dimension_key),
      why: String(r.dimension_family) + ', confidence ' + String(r.confidence_band),
      permission: null,
      changed: String(r.summary || ''),
      engineVersion: null,
      humanAction: d
        ? decidedLabel(d)
        : (review === 'pending' || review === 'in_review'
          ? 'No human action has followed. This is still awaiting review and has not been acted on.'
          : (review ? 'Marked ' + review + ', with no decision recorded against it.' : null)),
      source: 'result',
      sourceId: String(r.id),
    });
  }

  for (const r of decisions) {
    answer.entries.push({
      at: String(r.decided_at),
      actorId: String(r.decided_by),
      actorLabel: String(r.decided_by_name || 'a named person'),
      what: 'human decision' + (r.recommendation_ref ? ' on ' + String(r.recommendation_ref) : ''),
      why: String(r.rationale),
      permission: 'horizon.recommendation.decide',
      changed: String(r.decision) + (r.action_taken ? ' — ' + String(r.action_taken) : ''),
      engineVersion: r.engine_version ? String(r.engine_version) : null,
      humanAction: r.agreed_with_system === true
        ? 'Agreed with the system.'
        : 'Departed from the system.',
      source: 'decision',
      sourceId: String(r.id),
    });
  }

  for (const r of feedback) {
    answer.entries.push({
      at: String(r.created_at),
      actorId: null,
      actorLabel: 'a contributor',
      what: 'feedback contribution recorded',
      why: 'the attribution is held by the feedback patch and is not shown here',
      permission: 'horizon.feedback.view.attributed',
      changed: 'recorded',
      engineVersion: null,
      humanAction: null,
      source: 'feedback',
      sourceId: String(r.id),
    });
  }

  for (const r of recomputes) {
    answer.entries.push({
      at: String(r.requested_at),
      actorId: null,
      actorLabel: 'system',
      what: 'profile recomputation requested',
      why: String(r.reason || 'no reason recorded'),
      permission: null,
      changed: '',
      engineVersion: null,
      humanAction: null,
      source: 'recompute',
      sourceId: String(r.id),
    });
  }

  answer.entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return answer;
}

/** Re-exported so a consuming patch classifies impact the same way the gate does. */
export { impactOfPurpose };
export type { AuditAnswerEntry };
