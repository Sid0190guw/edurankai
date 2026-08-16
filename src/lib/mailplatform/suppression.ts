// src/lib/mailplatform/suppression.ts — the list that stops us mailing someone who said stop.
//
// Checked on EVERY send, transactional and campaign alike, before a transport is contacted. This is
// not a marketing feature: mailing an address after a hard bounce damages sender reputation for
// every other message the platform sends, and mailing after an unsubscribe is the thing regulators
// and providers actually act on.
//
// The one exception is deliberate and narrow — see `ignoreSuppression` in ../types.ts. It requires
// `mail.manage`, it is refused for campaign sends unconditionally, and every use writes an audit
// row naming who did it.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { addressKey } from './rfc';
import { TemporaryFailure } from './errors';
import type { SuppressionEntry, SuppressionReason, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export interface SuppressionCheck {
  address: string;
  suppressed: boolean;
  reason: SuppressionReason | null;
  /** A sentence for an operator looking at why a message did not go out. */
  detail: string;
}

/**
 * "WE COULD NOT FIND OUT" — thrown when the suppression list could not be READ.
 *
 * This is a different answer from "nobody on this list is suppressed", and the whole point of the
 * type is that a caller cannot confuse the two. It extends TemporaryFailure so classifyError() in
 * ./errors.ts already classes it as retryable: a pooler blip should delay a campaign step and let
 * it run again in a minute, never dead-letter it and above all never turn into a send.
 */
export class SuppressionUnavailableError extends TemporaryFailure {
  /** The real Postgres reason, taken from e.cause, so a caller can log or surface it verbatim. */
  readonly reason: string;
  /** How many distinct addresses went unchecked — the size of what was refused. */
  readonly addressCount: number;
  constructor(reason: string, addressCount: number) {
    super(
      `The suppression list could not be read, so nothing was sent to the ${addressCount} ` +
        `address${addressCount === 1 ? '' : 'es'} in this batch. This is not a statement that anyone ` +
        `is or is not suppressed — the check did not run. Reason: ${reason}`,
    );
    this.name = 'SuppressionUnavailableError';
    this.reason = reason;
    this.addressCount = addressCount;
  }
}

/**
 * The three outcomes of a lookup, kept apart on purpose:
 *   ok: true  + a check marked suppressed   the list said no to that address
 *   ok: true  + every check clear           the list was read and nobody here is on it
 *   ok: false + error                       we could not find out, so nobody here may be mailed
 */
export type SuppressionLookup =
  | { ok: true; checks: Map<string, SuppressionCheck>; error: null }
  | { ok: false; checks: null; error: string };

/**
 * Check many addresses in ONE query, answering with a RESULT rather than an exception.
 *
 * Prefer this in any caller that can render a refusal to a human; use checkSuppressed() below when
 * an exception is the natural way to abort (a workflow step, a job the engine will retry).
 *
 * A per-address round trip inside a campaign loop is the difference between a send that takes a
 * minute and one that takes an hour. `lower(address)` matches the expression index on the table.
 */
export async function checkSuppressedResult(
  orgId: UUID,
  addresses: string[],
  opts: { campaignId?: UUID | null } = {},
): Promise<SuppressionLookup> {
  const out = new Map<string, SuppressionCheck>();
  const keys = [...new Set(addresses.map(addressKey).filter(Boolean))];
  for (const k of keys) out.set(k, { address: k, suppressed: false, reason: null, detail: '' });

  // No organization means the lookup cannot even be scoped, which is another form of "we could not
  // find out" — it must not read as a clean list. Every caller resolves an org before sending, so
  // this only fires when something upstream is already broken.
  if (!orgId) {
    return { ok: false, checks: null, error: 'No organization was given, so the suppression list could not be scoped or read.' };
  }
  // Nothing to look up is genuinely nothing to look up: there is no address here to mail, so an
  // empty answer cannot let a suppressed message out.
  if (keys.length === 0) return { ok: true, checks: out, error: null };

  try {
    const r = rows(await db.execute(sql`
      SELECT lower(address) AS addr, reason, scope, scope_ref, created_at, expires_at
      FROM mp_suppression_entries
      WHERE org_id = ${orgId}
        AND lower(address) = ANY(${keys})
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (scope = 'org'
             OR (scope = 'domain' AND scope_ref = split_part(lower(address), '@', 2))
             OR (scope = 'campaign' AND scope_ref = ${opts.campaignId || null}))`));

    for (const row of r) {
      const addr = row.addr;
      // The most recent entry wins when an address is on the list more than once — a manual
      // re-subscribe followed by a new bounce should read as the bounce.
      const existing = out.get(addr);
      if (existing?.suppressed) continue;
      out.set(addr, {
        address: addr,
        suppressed: true,
        reason: row.reason,
        detail: explainSuppression(row.reason, row.created_at),
      });
    }
    return { ok: true, checks: out, error: null };
  } catch (e: any) {
    // FAILS CLOSED, AND THE DIRECTION WAS REVERSED DELIBERATELY.
    //
    // What the old code did: it caught this exact error, logged one line, and returned a map in
    // which every address was `suppressed: false` — a value indistinguishable from a clean read of
    // an empty list. Callers then sent. So one unreadable table meant every hard bounce, every
    // unsubscribe and every spam complainant on the list got mailed, with no counter, no alarm and
    // no durable record that the filter had been skipped. The sends looked completely normal.
    //
    // Why this is not the call src/lib/mailapi/ratelimit.ts makes — it logs "rate limiter
    // unavailable, allowing request" and lets the request through, and that is right there: a rate
    // limiter bounds AVAILABILITY, and one extra request costs a little capacity that the next
    // second gives back. This bounds an IRREVERSIBLE ACT. A message that has left the building
    // cannot be recalled, and re-mailing someone who reported us for spam is the fastest route onto
    // a blocklist — which then degrades delivery for every other message the platform sends,
    // including the password resets. When the two directions disagree, the one that can be undone
    // wins, and here that is refusing to send.
    //
    // The cost of this direction, stated plainly: while the table is unreadable, outbound mail
    // stops. That is a loud, visible outage that heals the moment the database does. The old
    // direction was a silent one whose damage did not heal at all.
    const reason = causeOf(e);
    console.error('[mailplatform/suppression] check failed, REFUSING to send to', keys.length, 'address(es) -', reason);
    return { ok: false, checks: null, error: reason };
  }
}

/**
 * Check many addresses in ONE query, THROWING when the list could not be read.
 *
 * The map it returns now only ever describes a lookup that actually happened. There is no longer a
 * return value meaning "the check did not run" — that case is the SuppressionUnavailableError, and
 * a caller that does not handle it aborts the send, which is the intended outcome.
 */
export async function checkSuppressed(
  orgId: UUID,
  addresses: string[],
  opts: { campaignId?: UUID | null } = {},
): Promise<Map<string, SuppressionCheck>> {
  const result = await checkSuppressedResult(orgId, addresses, opts);
  if (!result.ok) {
    throw new SuppressionUnavailableError(result.error, new Set(addresses.map(addressKey).filter(Boolean)).size);
  }
  return result.checks;
}

/**
 * Single-address convenience. Prefer checkSuppressed() in any loop.
 *
 * THROWS SuppressionUnavailableError if the list could not be read. It deliberately does not answer
 * `suppressed: false` in that case: this answer is used as a gate, and a gate that opens when it
 * cannot see is not a gate.
 */
export async function isSuppressed(orgId: UUID, address: string, campaignId?: UUID | null): Promise<SuppressionCheck> {
  const map = await checkSuppressed(orgId, [address], { campaignId });
  return map.get(addressKey(address)) || { address: addressKey(address), suppressed: false, reason: null, detail: '' };
}

function explainSuppression(reason: SuppressionReason, since: any): string {
  const when = since instanceof Date ? since.toISOString().slice(0, 10) : '';
  const tail = when ? ` (since ${when})` : '';
  switch (reason) {
    case 'hard_bounce':
      return `The address rejected mail permanently${tail}. Sending again damages delivery for every other message.`;
    case 'repeated_soft_bounce':
      return `The address has been unreachable repeatedly${tail} — usually a full or disabled mailbox.`;
    case 'complaint':
      return `The recipient marked mail from us as spam${tail}.`;
    case 'unsubscribe':
      return `The recipient unsubscribed${tail}.`;
    case 'manual':
      return `Added to the suppression list by hand${tail}.`;
    case 'invalid_address':
      return `The address is not deliverable${tail}.`;
    default:
      return `On the suppression list${tail}.`;
  }
}

export async function suppress(input: {
  orgId: UUID;
  address: string;
  reason: SuppressionReason;
  scope?: 'org' | 'domain' | 'campaign';
  scopeRef?: string | null;
  source?: string | null;
  expiresAt?: string | null;
}): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const address = addressKey(input.address);
  if (!address) return { ok: false, created: false, error: 'An address is required.' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_suppression_entries (org_id, address, scope, scope_ref, reason, source, expires_at)
      VALUES (${input.orgId}, ${address}, ${input.scope || 'org'}, ${input.scopeRef || null},
              ${input.reason}, ${input.source || null}, ${input.expiresAt ? new Date(input.expiresAt) : null})
      ON CONFLICT (org_id, lower(address), scope, coalesce(scope_ref,''))
      DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, expires_at = EXCLUDED.expires_at, updated_at = NOW()
      RETURNING (xmax = 0) AS inserted`));
    // xmax = 0 distinguishes an INSERT from an UPDATE in an upsert. "Added" and "already there,
    // refreshed" are different answers and an admin screen should show which one happened.
    return { ok: true, created: !!r[0]?.inserted };
  } catch (e: any) {
    return { ok: false, created: false, error: causeOf(e) };
  }
}

/**
 * Take an address OFF the list.
 *
 * Answers whether this call removed anything, so a screen cannot report success for a no-op. A
 * hard-bounce entry can be removed — people do fix their mailboxes — but the caller is expected to
 * audit it, because it re-enables mail to an address that previously rejected it.
 */
export async function unsuppress(
  orgId: UUID,
  address: string,
  scope: 'org' | 'domain' | 'campaign' = 'org',
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const addr = addressKey(address);
  if (!addr) return { ok: false, removed: false, error: 'An address is required.' };
  try {
    const r = rows(await db.execute(sql`
      DELETE FROM mp_suppression_entries
      WHERE org_id = ${orgId} AND lower(address) = ${addr} AND scope = ${scope}
      RETURNING id`));
    return { ok: true, removed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, removed: false, error: causeOf(e) };
  }
}

export async function listSuppressions(
  orgId: UUID,
  opts: { limit?: number; reason?: SuppressionReason; search?: string } = {},
): Promise<SuppressionEntry[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  try {
    const conditions = [sql`org_id = ${orgId}`];
    if (opts.reason) conditions.push(sql`reason = ${opts.reason}`);
    if (opts.search) conditions.push(sql`address ILIKE ${'%' + String(opts.search).replace(/[%_\\]/g, (c) => '\\' + c) + '%'}`);
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_suppression_entries
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC LIMIT ${limit}`));
    return r.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      address: row.address,
      scope: row.scope,
      scopeRef: row.scope_ref ?? null,
      reason: row.reason,
      source: row.source ?? null,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  } catch (e: any) {
    console.error('[mailplatform/suppression] list failed -', causeOf(e));
    return [];
  }
}
