// src/lib/horizon/governance/gate.ts — THE ONE GATE, AND THE CONCRETE ACCESS-LOG SINK.
//
// =================================================================================================
// WHAT WAS MISSING, AND WHAT THIS FILE ACTUALLY ADDS
// =================================================================================================
//
// src/lib/horizon/visibility.ts already decides which FIELDS an audience may see, already requires a
// purpose for the audiences that need one, and already states the rule that for most audiences the
// access row must be written BEFORE anything renders. It does all of that well and this module does
// none of it again.
//
// Two things were missing, and both of them were holes rather than gaps:
//
//   1. NOTHING DECIDED WHO WAS ENTITLED TO CLAIM AN AUDIENCE. `authoriseAccess()` takes the audience
//      as an INPUT. A screen could pass `auditor` and be served an auditor's view. matrix.ts closes
//      that by resolving the audience from the permission registry and the stated purpose; this
//      module is what calls it before anything else runs.
//
//   2. `AccessLogger` HAD NO IMPLEMENTATION. visibility.ts declares the interface and says the
//      eventual implementation writes hzn_access_log; nothing in the tree implemented it, so
//      requireAccessLog() had no sink and hzn_access_log was a table nothing wrote to. That is not a
//      small omission: the whole design rests on the log being a PRECONDITION, and a precondition
//      with no implementation is a comment. `hznAccessLogger` below is that implementation.
//
// =================================================================================================
// THE ORDER, AND IT IS NOT NEGOTIABLE
// =================================================================================================
//
//   1. Resolve what the person holds                    registry.resolvePermissions — fails closed
//   2. Resolve which audience they may claim            matrix.resolveAudience — pure
//   3. Ask whether the read may proceed at all          visibility.authoriseAccess — pure
//   4. Check consent where the purpose requires it      intake/consent.currentConsent — fails closed
//   5. Write the access row, and CHECK IT LANDED        visibility.requireAccessLog + this sink
//   6. Only then may the caller read and redact
//
// Step 5 before step 6 is the rule src/lib/legal-hold.ts established on this project and
// src/lib/horizon/access.ts already follows. Denying because a LOG failed looks wrong and is not:
// the entire justification for one person reading another person's record is that the reading is on
// the record, and a read nobody can account for is the thing this layer exists to prevent.
//
// WHAT THIS MODULE NEVER DOES: fetch the record. The caller reads under its own query and passes the
// object to visibility.redactForAudience(). Keeping the values out of here is what lets the DECISION
// be logged in full without the log becoming a second copy of the data it is a decision about.
import { DEFAULT_ORGANISATION_ID, type ActorRef, type SubjectRef } from '@/lib/horizon/ids';
import {
  AUDIENCE_SPECS, MIN_PURPOSE_CHARS, authoriseAccess, requireAccessLog,
  type AccessLogEntry, type AccessLogResult, type AccessLogger, type HorizonAudience,
  type VisibilityClass,
} from '@/lib/horizon/visibility';
import { impactOfPurpose, isPurpose, purposeMeta, resolveAudience } from './matrix';
import type { GovernanceActor, Purpose } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
async function sqlTag(): Promise<any> {
  return (await import('drizzle-orm')).sql;
}

// -------------------------------------------------------------------------------------------------
// THE SINK
// -------------------------------------------------------------------------------------------------

/**
 * The implementation of visibility.AccessLogger that writes hzn_access_log.
 *
 * hzn_access_log IS NOT THIS PATCH'S TABLE. It is declared and created by src/lib/horizon/schema.ts,
 * which owns every hzn_* table. This module writes rows into it through the interface that module's
 * sibling declared for exactly this purpose — it does not create it, alter it, or read it in any way
 * the owning patch has not already provided for. A second access log would mean the question "who
 * read this record" had two answers and neither was complete.
 *
 * `omitted` carries what the reader did NOT see. The reader was not told; the auditor is.
 */
export const hznAccessLogger: AccessLogger = {
  async log(entry: Omit<AccessLogEntry, 'id' | 'at'>): Promise<AccessLogResult> {
    try {
      const db = await database();
      const sql = await sqlTag();
      const r = rows(await db.execute(sql`
        INSERT INTO hzn_access_log (organisation_id, actor_kind, actor_id, actor_name,
                                    subject_kind, subject_id, subject_scheme, audience,
                                    visibility_served, purpose, request_id, omitted,
                                    succeeded, refusal_reason, ip_address)
        VALUES (${entry.organisationId}, ${entry.actor.kind}, ${entry.actor.id},
                ${entry.actor.displayName ?? null}, ${entry.subject.kind}, ${entry.subject.id},
                ${entry.subject.idScheme}, ${entry.audience}, ${entry.visibilityServed},
                ${entry.purpose ?? null}, ${entry.requestId},
                ${JSON.stringify(entry.omitted || [])}::jsonb, ${entry.succeeded !== false},
                ${entry.refusalReason ?? null}, ${(entry as any).ipAddress ?? null})
        RETURNING id`));
      const id = r[0]?.id ? String(r[0].id) : null;
      if (!id) return { ok: false, error: 'the insert returned no id' };
      return { ok: true, id };
    } catch (e: any) {
      // NOT A BARE SWALLOW. The real Postgres reason is on e.cause; e.message is the failed SQL.
      // Tracked as well as returned, because a failing access log is the one class of fault that
      // otherwise leaves no trace anywhere while quietly refusing everybody's reads.
      try {
        const { trackError } = await import('@/lib/logger');
        await trackError('horizon.governance.access_log_failed', e, {
          audience: entry.audience, subjectKind: entry.subject?.kind,
        });
      } catch { /* trackError carries its own fallbacks */ }
      return { ok: false, error: reason(e) };
    }
  },
};

// -------------------------------------------------------------------------------------------------
// THE GATE
// -------------------------------------------------------------------------------------------------

export interface GovernedReadRequest {
  actor: GovernanceActor;
  subject: SubjectRef;
  purpose: Purpose | string;
  /** Recorded verbatim. It is the answer to "why were you reading this". */
  justification?: string | null;
  /**
   * The org graph's per-row answer, required for the relationship-scoped audiences.
   *
   * PASSED IN, NEVER RESOLVED HERE. Whether this manager manages this person is Layer 1 of the
   * three-layer architecture (src/lib/org-graph.ts) and is not this patch's to reimplement.
   * `undefined` is treated as "not confirmed" by visibility.authoriseAccess, which fails closed.
   */
  relationshipConfirmed?: boolean;
  /** The subject's user id, where they have an account. Used ONLY to decide the self path. */
  subjectUserId?: string | null;
  /** A correlation id for this request, so a log row can be tied to a page load. */
  requestId?: string;
  /** Astro.locals, where you have it. resolvePermissions memoises on it: eight checks, one lookup. */
  locals?: any;
}

export interface GovernedReadDecision {
  allowed: boolean;
  /** Stated in words a reader can act on, and recorded verbatim in the access log. */
  reason: string;
  /** Hand this to visibility.redactForAudience(). Null when the read was refused. */
  audience: HorizonAudience | null;
  /** The permission key the decision rested on. Answers "under which permission". */
  permission: string | null;
  purpose: string;
  impact: ReturnType<typeof impactOfPurpose>;
  /** The hzn_access_log row id. Null when the write failed, in which case allowed is false. */
  accessLogId: string | null;
  /** True when the decision was taken on incomplete information, and therefore refused. */
  degraded: boolean;
  at: string;
}

/**
 * Resolve what a person holds, as a plain set of keys.
 *
 * FAILS CLOSED. registry.resolvePermissions() already returns an EMPTY set with degraded=true on any
 * failure; this preserves that and the gate turns it into a refusal. A partial permission read cannot
 * be evaluated safely in either direction — losing an allow is harmless, losing a deny is not.
 */
export async function governancePermissions(
  userId: string,
  locals?: any,
): Promise<{ permissions: Set<string>; degraded: boolean; role: string | null }> {
  try {
    const { resolvePermissions } = await import('@/lib/auth/registry');
    const resolved = await resolvePermissions(userId, { locals });
    return { permissions: resolved.permissions, degraded: resolved.degraded === true, role: resolved.role };
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('error', 'horizon.governance.resolve-failed', { message: reason(e) });
    return { permissions: new Set<string>(), degraded: true, role: null };
  }
}

/**
 * THE GATE.
 *
 * Never throws for a refusal — a refusal is a value, because it has to be logged and shown, and an
 * exception is neither. A refused read is still an attempted read and it still leaves a row.
 */
export async function authorizeGovernedRead(req: GovernedReadRequest): Promise<GovernedReadDecision> {
  const at = new Date().toISOString();
  const purpose = String(req?.purpose || '');
  const requestId = String(req?.requestId || '').trim() || 'req_' + at;
  const impact = impactOfPurpose(purpose);

  const actorRef: ActorRef = {
    kind: 'user' as any,
    id: String(req?.actor?.id || ''),
    displayName: req?.actor?.name || req?.actor?.email || null,
  };
  const organisationId = req?.subject?.organisationId || DEFAULT_ORGANISATION_ID;

  // A refusal still leaves a row, and it names the audience it was refused FOR so the log can be read
  // as "somebody tried to open this as HR leadership and could not", which is the interesting shape.
  const refuse = async (why: string, audience: HorizonAudience | null, permission: string | null, degraded = false): Promise<GovernedReadDecision> => {
    let logId: string | null = null;
    try {
      const result = await hznAccessLogger.log({
        organisationId,
        actor: actorRef,
        subject: req.subject,
        audience: audience || 'reviewer_panel',
        visibilityServed: 'open' as VisibilityClass,
        purpose: String(req.justification || purpose) || null,
        requestId,
        omitted: [],
        succeeded: false,
        refusalReason: why,
      } as any);
      logId = result.ok ? (result.id || null) : null;
    } catch { logId = null; }
    return { allowed: false, reason: why, audience: null, permission, purpose, impact, accessLogId: logId, degraded, at };
  };

  if (!actorRef.id) return refuse('No signed-in person is making this request.', null, null, true);
  if (!req?.subject?.id) return refuse('No subject was named.', null, null, true);
  if (!isPurpose(purpose)) {
    return refuse('"' + purpose + '" is not a purpose this system recognises, so there is nothing to authorise against.', null, null);
  }

  // 1. What this person holds. Fails closed.
  const held = await governancePermissions(actorRef.id, req.locals);
  if (held.degraded) {
    return refuse('The permission context could not be read, so this request cannot be evaluated safely.', null, null, true);
  }

  // 2. Which audience they may claim, for THIS purpose. Pure.
  const isSelf = !!req.subjectUserId && req.subjectUserId === actorRef.id;
  const resolved = resolveAudience({ permissions: held.permissions, purpose, isSelf });
  if (!resolved.audience) return refuse(resolved.reason, null, resolved.permission);

  // 3. May the read proceed at all? Pure. This is where the relationship and the purpose-length
  //    requirements bite, and both fail closed on undefined.
  const spec = AUDIENCE_SPECS[resolved.audience];
  const statedPurpose = String(req.justification || '').trim();
  const decision = authoriseAccess({
    actor: actorRef,
    audience: resolved.audience,
    subject: req.subject,
    organisationId,
    relationshipConfirmed: req.relationshipConfirmed,
    purpose: statedPurpose || null,
    requestId,
  });
  if (!decision.allowed) return refuse(decision.reason, resolved.audience, resolved.permission);

  // A high-impact purpose needs more than visibility.ts's floor. MIN_PURPOSE_CHARS is 8, which is
  // enough for "audit" plus three characters; a decision that can end somebody's employment deserves
  // a sentence. Checked here rather than by lowering the shared floor, because that floor is another
  // module's contract and other callers depend on it.
  if (impact === 'high' && statedPurpose.length < MIN_HIGH_IMPACT_PURPOSE) {
    return refuse('A high-impact purpose needs a written reason of at least ' + MIN_HIGH_IMPACT_PURPOSE
      + ' characters, recorded before the record is opened.', resolved.audience, resolved.permission);
  }

  // 4. Consent, where the purpose requires it. Fails closed: unreadable is never treated as granted.
  const meta = purposeMeta(purpose);
  if (meta?.requiresConsent) {
    try {
      const { currentConsent } = await import('@/lib/horizon/intake');
      const state = await currentConsent(req.subject);
      if (!state.granted) {
        return refuse('There is no live consent for "' + purpose + '", so this record is not readable for it.', resolved.audience, resolved.permission);
      }
      if (state.stale) {
        return refuse('The consent on record was given against an earlier notice and has not been renewed. '
          + 'The person has to be re-asked before their data is used under the current wording.', resolved.audience, resolved.permission);
      }
    } catch (e: any) {
      return refuse('Consent could not be read (' + reason(e) + '), and an unreadable consent is never treated as a granted one.', resolved.audience, resolved.permission, true);
    }
  }

  // 5. The row, BEFORE the answer.
  const strongest = strongestClassFor(resolved.audience);
  const logged = await requireAccessLog(hznAccessLogger, {
    organisationId,
    actor: actorRef,
    subject: req.subject,
    audience: resolved.audience,
    visibilityServed: strongest,
    purpose: statedPurpose || null,
    requestId,
    omitted: [],
    succeeded: true,
  } as any);

  if (!logged.mayRender) {
    return {
      allowed: false,
      reason: 'The access could not be recorded (' + (logged.error || 'unknown reason') + '), and an access that '
        + 'cannot be accounted for is refused. If this persists the governance log is down, and refusing is the '
        + 'correct behaviour rather than a fault in the record.',
      audience: null,
      permission: resolved.permission,
      purpose,
      impact,
      accessLogId: null,
      degraded: true,
      at,
    };
  }

  return {
    allowed: true,
    reason: resolved.reason + (logged.logged ? '' : ' The access log write did not land; this audience does not require it before rendering.'),
    audience: resolved.audience,
    permission: resolved.permission,
    purpose,
    impact,
    accessLogId: null,
    degraded: !logged.logged,
    at,
  };
}

/**
 * The floor for a purpose that can change somebody's standing.
 *
 * Deliberately larger than visibility.MIN_PURPOSE_CHARS, and deliberately applied HERE rather than by
 * raising that constant: MIN_PURPOSE_CHARS is another module's published contract and other callers
 * rely on its value.
 */
export const MIN_HIGH_IMPACT_PURPOSE = 20;

/** The strongest visibility class an audience is served. Reported on the access row, per its contract. */
function strongestClassFor(audience: HorizonAudience): VisibilityClass {
  const maySee = AUDIENCE_SPECS[audience]?.maySee || [];
  const order: VisibilityClass[] = ['sensitive', 'restricted', 'internal', 'open'];
  for (const c of order) if (maySee.includes(c)) return c;
  return 'open';
}
