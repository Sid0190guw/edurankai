// src/lib/mailgov/holds.ts — RECORDS THAT MUST SURVIVE THE RETENTION POLICY.
//
// A legal hold is the answer to a situation every retention policy eventually meets: the policy says
// delete after 180 days, and there is a dispute, an investigation or a regulatory enquiry for which
// those particular records must still exist next year. A retention engine with no hold mechanism
// forces an organization to choose between suspending retention entirely and destroying evidence.
//
// HOW THIS RELATES TO src/lib/legal-hold.ts. That module holds EduRankAI's OWN business
// communications — groups, direct messages, application threads — and is founder-only, because it is
// about our staff. This one holds a CUSTOMER's mail platform records under the CUSTOMER's matter,
// which will usually not exist in our matters table at all. So `matter_ref` is free text and
// mandatory, and `matter_id` optionally links a row in legal_matters when the matter is ours. Same
// discipline, different subject: a numbered matter, a written reason, an audited placement, and no
// browse-everything mode.
//
// A HOLD DOES NOT GRANT ACCESS. This is the distinction that gets collapsed everywhere and must not
// be. Placing a hold stops records being DELETED. It does not let anyone READ them — that is a
// support content grant (./support-policy.ts), approved by a different person, time-limited and
// audited on every use. Somebody who could place a hold and thereby read a mailbox would have found
// a way around every control in this patch by typing a reason into a box.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason } from './schema';

export const HOLD_SCOPES = ['organization', 'address', 'mailbox', 'message', 'campaign', 'domain'] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];

export interface LegalHold {
  id: string;
  orgId: string;
  matterRef: string;
  matterId: string | null;
  scope: HoldScope;
  scopeRef: string | null;
  reason: string;
  status: 'active' | 'released';
  placedBy: string;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): LegalHold {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    matterRef: String(r.matter_ref),
    matterId: r.matter_id ? String(r.matter_id) : null,
    scope: String(r.scope) as HoldScope,
    scopeRef: r.scope_ref ?? null,
    reason: String(r.reason),
    status: (r.status === 'released' ? 'released' : 'active'),
    placedBy: String(r.placed_by),
    placedAt: new Date(r.placed_at).toISOString(),
    releasedBy: r.released_by ? String(r.released_by) : null,
    releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
    releaseReason: r.release_reason ?? null,
  };
}

export interface PlaceHoldInput {
  orgId: string;
  matterRef: string;
  matterId?: string | null;
  scope: HoldScope;
  scopeRef?: string | null;
  reason: string;
  placedBy: string;
}

/**
 * Place a hold.
 *
 * The reason floor is 20 characters, the same as openMatter() in src/lib/legal-hold.ts and for the
 * same stated reason: the answer to "why is this being kept past its retention" has to exist in
 * writing and has to have been written first. A hold is also the one control here that a tenant
 * cannot lift themselves, so the reason is what a customer is shown when they ask why their deletion
 * request is refused.
 *
 * A scope other than `organization` REQUIRES a reference. "Hold a message" with no message id is an
 * organization-wide hold wearing a narrower label, and it would silently pin everything.
 */
export async function placeHold(input: PlaceHoldInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!(HOLD_SCOPES as readonly string[]).includes(input.scope)) {
    return { ok: false, error: 'Unknown hold scope: ' + input.scope + '.' };
  }
  const matterRef = String(input.matterRef || '').trim();
  if (matterRef.length < 3) {
    return { ok: false, error: 'Give the matter reference this hold is placed under.' };
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 20) {
    return {
      ok: false,
      error: 'Give a specific reason of at least 20 characters. This is what the organization is shown when their own deletion request is refused, and it is written before anything is held.',
    };
  }
  if (input.scope !== 'organization' && !String(input.scopeRef || '').trim()) {
    return { ok: false, error: 'A ' + input.scope + ' hold needs the exact ' + input.scope + ' it covers.' };
  }

  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO mailapi_legal_holds (org_id, matter_ref, matter_id, scope, scope_ref, reason, placed_by)
      VALUES (${input.orgId}::uuid, ${matterRef}, ${input.matterId || null}::uuid, ${input.scope},
              ${input.scopeRef || null}, ${reason.slice(0, 4000)}, ${input.placedBy}::uuid)
      RETURNING id`))[0];
    return { ok: true, id: String(r?.id) };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Release a hold. Requires its own written reason, because releasing one is the act that lets
 * records be destroyed — the direction in which a mistake cannot be undone.
 */
export async function releaseHold(input: {
  id: string;
  byUserId: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const reason = String(input.reason || '').trim();
  if (reason.length < 20) {
    return { ok: false, error: 'Give a reason of at least 20 characters for releasing the hold. Records become deletable the moment it is lifted.' };
  }
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_legal_holds
         SET status = 'released', released_by = ${input.byUserId}::uuid, released_at = now(), release_reason = ${reason.slice(0, 4000)}
       WHERE id = ${input.id}::uuid AND status = 'active'
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'That hold does not exist, or it has already been released.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function listHolds(q: { orgId?: string | null; status?: 'active' | 'released' | null; limit?: number }): Promise<ReadResult<LegalHold>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const r = await db.execute(sql`
      SELECT * FROM mailapi_legal_holds
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
       ORDER BY placed_at DESC LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface HoldCoverage {
  /** Null when the lookup FAILED. Callers treat null as "held" — see the note below. */
  count: number | null;
  holds: LegalHold[];
  error?: string;
}

/**
 * Which active holds cover this target?
 *
 * A `organization` hold covers everything in the tenant; a narrower hold covers only its own
 * reference. Both are returned so a screen can say which one is stopping a deletion.
 *
 * A FAILED LOOKUP RETURNS count: null, AND EVERY CALLER MUST TREAT THAT AS HELD. This is the one
 * place in this module where the safe direction is to over-preserve: deleting records because the
 * hold table could not be read is unrecoverable, while refusing a deletion for an hour is an
 * inconvenience. holdBlocks() below encodes that so no caller has to remember it.
 */
export async function holdsCovering(input: {
  orgId: string;
  scope?: HoldScope | null;
  scopeRef?: string | null;
}): Promise<HoldCoverage> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM mailapi_legal_holds
       WHERE org_id = ${input.orgId}::uuid AND status = 'active'
         AND (
           scope = 'organization'
           ${input.scope && input.scopeRef
             ? sql`OR (scope = ${input.scope} AND scope_ref = ${input.scopeRef})`
             : sql``}
         )
       ORDER BY placed_at DESC LIMIT 100`));
    const holds = r.map(map);
    return { count: holds.length, holds };
  } catch (e: any) {
    return { count: null, holds: [], error: dbReason(e) };
  }
}

/**
 * The question every deletion and every retention sweep asks. Fail-closed by construction: an
 * unreadable hold table blocks, and says so.
 */
export async function holdBlocks(input: {
  orgId: string;
  scope?: HoldScope | null;
  scopeRef?: string | null;
}): Promise<{ blocked: boolean; count: number; reason: string | null; holds: LegalHold[] }> {
  const cov = await holdsCovering(input);
  if (cov.count === null) {
    return {
      blocked: true, count: 0, holds: [],
      reason: 'The legal hold table could not be read (' + (cov.error || 'unknown reason')
        + '), so nothing was deleted. This fails towards keeping data, deliberately.',
    };
  }
  if (cov.count > 0) {
    const first = cov.holds[0];
    return {
      blocked: true, count: cov.count, holds: cov.holds,
      reason: cov.count + ' active hold' + (cov.count === 1 ? '' : 's') + '. '
        + (first ? 'Matter ' + first.matterRef + ': ' + first.reason : ''),
    };
  }
  return { blocked: false, count: 0, reason: null, holds: [] };
}

/**
 * The scope references held for a whole class, so a retention sweep can exclude them in ONE query
 * rather than asking per row.
 *
 * Returns null when the read failed, and the sweep then does nothing for that class — the same
 * fail-towards-keeping rule as holdBlocks(), applied where a per-row check would be too slow to run.
 */
export async function heldReferences(orgId: string, scope: HoldScope): Promise<{ orgWide: boolean; refs: string[] } | null> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT scope, scope_ref FROM mailapi_legal_holds
       WHERE org_id = ${orgId}::uuid AND status = 'active'
         AND (scope = 'organization' OR scope = ${scope})
       LIMIT 5000`));
    const orgWide = r.some((x: any) => String(x.scope) === 'organization');
    const refs = r.filter((x: any) => String(x.scope) === scope && x.scope_ref).map((x: any) => String(x.scope_ref));
    return { orgWide, refs };
  } catch {
    return null;
  }
}
