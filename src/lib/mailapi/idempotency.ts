// src/lib/mailapi/idempotency.ts — "send this once, however many times you ask".
//
// THE FAILURE THIS PREVENTS IS NOT HYPOTHETICAL IN THIS CODEBASE. src/lib/mail-advanced.ts carries a
// long note about scheduled sends being read by two overlapping runs and delivered twice, because
// nothing claimed a row before the send. A retrying HTTP client is the same shape from the other
// side: a timeout at the caller does not mean the mail was not sent, so the honest client retries,
// and without a key the candidate gets the rejection letter twice.
//
// FOUR OUTCOMES, NOT TWO. A key that has never been seen proceeds. A key seen with the SAME request
// replays the original response — the same message id, not a new one, because the client is trying
// to learn what happened the first time. A key seen with a DIFFERENT request is a bug in the caller
// (a key reused across two different mails) and is refused loudly rather than guessed at. A key
// whose first call is still in flight gets 409 and is told to retry, because answering "sent" for a
// send still being attempted would be a claim we cannot support.
//
// THE HASH IS OVER THE MEANING, NOT THE BYTES. Keys are sorted before hashing, so a client whose
// JSON serialiser reorders fields between attempts is not accused of changing the request.
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import { ApiError } from './errors';

/** Stable stringify: object keys sorted at every depth, arrays left in order (order is meaning). */
export function stableStringify(value: any): string {
  const seen = new WeakSet();
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v === undefined ? null : v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function requestHash(payload: any): string {
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

/** Keys are supplied by the caller, so their shape is checked before it reaches a unique index. */
export function assertIdempotencyKey(key: string): string {
  const k = String(key || '').trim();
  if (k.length < 8 || k.length > 255) {
    throw new ApiError('invalid_request', 'Idempotency-Key must be between 8 and 255 characters. A UUID per logical send is ideal.', { param: 'idempotency_key' });
  }
  if (!/^[\x20-\x7e]+$/.test(k)) {
    throw new ApiError('invalid_request', 'Idempotency-Key must be printable ASCII.', { param: 'idempotency_key' });
  }
  return k;
}

export type IdempotencyOutcome = 'proceed' | 'replay' | 'conflict' | 'in_progress';

export interface StoredIdempotency {
  id: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  messageId: string | null;
  responseStatus: number | null;
  responseJson: any;
  createdAt: string;
}

/** Pure decision, so the four-way table is a test rather than a reading of the SQL. */
export function decideIdempotency(existing: StoredIdempotency | null, hash: string, opts: { staleAfterMs?: number; nowMs?: number } = {}): IdempotencyOutcome {
  if (!existing) return 'proceed';
  if (existing.requestHash !== hash) return 'conflict';
  if (existing.status === 'completed') return 'replay';
  // An in-progress row whose request died mid-flight would block that key for ever. After the stale
  // window the key is taken over rather than left poisoned — the window is long enough (2 minutes)
  // that a genuinely slow SMTP handshake is never mistaken for a dead one.
  const stale = opts.staleAfterMs ?? 120_000;
  const age = (opts.nowMs ?? Date.now()) - new Date(existing.createdAt).getTime();
  return age > stale ? 'proceed' : 'in_progress';
}

function mapRow(r: any): StoredIdempotency {
  return {
    id: r.id,
    requestHash: r.request_hash,
    status: r.status === 'completed' ? 'completed' : 'in_progress',
    messageId: r.message_id || null,
    responseStatus: r.response_status == null ? null : Number(r.response_status),
    responseJson: r.response_json ?? null,
    createdAt: r.created_at,
  };
}

export interface ClaimResult {
  outcome: IdempotencyOutcome;
  /** The row id to complete against, present when the outcome is 'proceed'. */
  recordId?: string;
  existing?: StoredIdempotency;
}

/**
 * Try to claim a key.
 *
 * The claim is the INSERT itself. Two concurrent requests with the same key race on the unique
 * index; exactly one wins and proceeds, and the loser reads the winner's row — which is the whole
 * point, and is why this is not a SELECT followed by an INSERT.
 */
export async function claim(p: { orgId: string; environment: string; key: string; hash: string; ttlHours?: number }): Promise<ClaimResult> {
  await ensureMailApiSchema();
  const ttl = Math.max(1, Math.min(168, p.ttlHours ?? 24));
  const inserted = rows(await db.execute(sql`
    INSERT INTO mailapi_idempotency (org_id, environment, idempotency_key, request_hash, status, expires_at)
    VALUES (${p.orgId}, ${p.environment}, ${p.key}, ${p.hash}, 'in_progress', now() + (${String(ttl)} || ' hours')::interval)
    ON CONFLICT (org_id, environment, idempotency_key) DO NOTHING
    RETURNING id`));
  if (inserted[0]) return { outcome: 'proceed', recordId: inserted[0].id };

  const existing = rows(await db.execute(sql`
    SELECT id, request_hash, status, message_id, response_status, response_json, created_at
    FROM mailapi_idempotency
    WHERE org_id = ${p.orgId} AND environment = ${p.environment} AND idempotency_key = ${p.key} LIMIT 1`))[0];
  if (!existing) {
    // The row was deleted (expiry sweep) between the INSERT and this SELECT. Retry the claim once.
    const retry = rows(await db.execute(sql`
      INSERT INTO mailapi_idempotency (org_id, environment, idempotency_key, request_hash, status, expires_at)
      VALUES (${p.orgId}, ${p.environment}, ${p.key}, ${p.hash}, 'in_progress', now() + (${String(ttl)} || ' hours')::interval)
      ON CONFLICT (org_id, environment, idempotency_key) DO NOTHING
      RETURNING id`));
    return retry[0] ? { outcome: 'proceed', recordId: retry[0].id } : { outcome: 'in_progress' };
  }

  const stored = mapRow(existing);
  const outcome = decideIdempotency(stored, p.hash);
  if (outcome === 'proceed') {
    // Taking over a stale claim: reset it to this request so the replay that follows is ours.
    const taken = rows(await db.execute(sql`
      UPDATE mailapi_idempotency
      SET request_hash = ${p.hash}, status = 'in_progress', message_id = NULL, response_status = NULL,
          response_json = NULL, created_at = now(), expires_at = now() + (${String(ttl)} || ' hours')::interval
      WHERE id = ${stored.id} AND status = 'in_progress' RETURNING id`));
    return taken[0] ? { outcome: 'proceed', recordId: taken[0].id } : { outcome: 'in_progress', existing: stored };
  }
  return { outcome, existing: stored };
}

/** Store the response the first call produced, so a replay can return exactly it. */
export async function complete(recordId: string, p: { messageId: string | null; status: number; body: any }): Promise<void> {
  await ensureMailApiSchema();
  await db.execute(sql`
    UPDATE mailapi_idempotency
    SET status = 'completed', message_id = ${p.messageId}, response_status = ${p.status}, response_json = ${JSON.stringify(p.body)}::jsonb
    WHERE id = ${recordId}`);
}

/**
 * Release a claim that failed before producing a response.
 *
 * Without this, a send that fails validation halfway through would hold its key for twenty-four
 * hours and the caller's corrected retry would be refused as a conflict.
 */
export async function release(recordId: string): Promise<void> {
  await ensureMailApiSchema();
  await db.execute(sql`DELETE FROM mailapi_idempotency WHERE id = ${recordId} AND status = 'in_progress'`);
}

export async function pruneIdempotency(): Promise<number> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`DELETE FROM mailapi_idempotency WHERE expires_at < now() RETURNING id`));
  return r.length;
}
