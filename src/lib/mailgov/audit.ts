// src/lib/mailgov/audit.ts — WRITING AND READING THE RECORD OF WHAT ADMINISTRATORS DID.
//
// The chain arithmetic is in ./audit-chain.ts (pure, tested). This file is the database half: one
// append, several reads, and a verifier that walks what it read.
//
// AN AUDIT WRITE THAT FAILS SILENTLY IS WORSE THAN NO AUDIT AT ALL, because the screen still says
// the action succeeded and the log still looks complete. So recordAudit() returns a RESULT rather
// than swallowing, and the guard treats a failed audit on a WRITE as a refusal — the action does not
// happen. src/lib/legal-hold.ts made the same choice for the same reason and states it in the same
// words: an unlogged access is precisely what the module exists to prevent.
//
// TWO WRITE PATHS, AND THE SECOND IS NOT A NICETY. The fast path computes the chain hash inside the
// INSERT with Postgres's built-in sha256(), so the tail read and the append are one statement. If
// that expression fails for any reason — an older server without the built-in, a permissions oddity,
// a driver quirk — the fallback reads the tail, computes the same hash in TypeScript, and inserts.
// Both paths rely on the UNIQUE index on prev_hash to make a concurrent append fail loudly rather
// than fork the chain, and both retry on exactly that violation. Without the fallback, one missing
// built-in would stop every governance action on the platform, because every one of them is audited.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import {
  GENESIS_HASH, chainHash, contentHash, contentMatches, verifyChain,
  type AuditEventInput, type AuditEventRow, type ChainVerdict,
} from './audit-chain';
import type { GovActor } from './policy';

const MAX_APPEND_ATTEMPTS = 5;

export interface AuditWriteResult {
  ok: boolean;
  id?: string;
  seq?: number;
  hash?: string;
  error?: string;
  /** True when the write failed because the chain was contended and every retry lost. */
  contended?: boolean;
}

/** Everything a call site has to supply. The actor's identity is lifted off the GovActor. */
export interface AuditCall {
  actor: GovActor | null;
  action: string;
  orgId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result?: 'ok' | 'denied' | 'failed';
  reason?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Overridable only so a test can pin it. Production always uses now(). */
  occurredAt?: string;
}

function toInput(call: AuditCall): AuditEventInput {
  return {
    orgId: call.orgId ?? null,
    actorUserId: call.actor?.userId ?? null,
    actorEmail: call.actor?.email ?? null,
    actorRole: call.actor?.role ?? null,
    actorApiKeyId: null,
    action: call.action,
    targetType: call.targetType ?? null,
    targetId: call.targetId ?? null,
    result: call.result || 'ok',
    reason: call.reason ?? null,
    ip: call.ip ?? null,
    userAgent: call.userAgent ?? null,
    requestId: call.requestId ?? null,
    meta: call.meta || {},
    occurredAt: call.occurredAt || new Date().toISOString(),
  };
}

/**
 * Append one event.
 *
 * The statement reads the current tail and inserts in one go. Under READ COMMITTED two callers can
 * still read the same tail; the UNIQUE index on prev_hash then refuses the second, and the loop
 * retries against the new tail. That is the entire concurrency design, and it is deliberately in the
 * database rather than in a mutex that only works inside one process — this deploys to serverless
 * functions, where there is no shared process to hold a lock in.
 */
export async function recordAudit(call: AuditCall): Promise<AuditWriteResult> {
  const input = toInput(call);
  const ch = contentHash(input);

  try {
    await ensureGovernanceSchema();
  } catch (e: any) {
    return { ok: false, error: 'Audit schema unavailable: ' + dbReason(e) };
  }

  let lastError = '';
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      const r = rows(await db.execute(sql`
        WITH tail AS (
          SELECT COALESCE((SELECT hash FROM mailapi_audit_events ORDER BY seq DESC LIMIT 1), ${GENESIS_HASH}) AS prev
        )
        INSERT INTO mailapi_audit_events (
          org_id, actor_user_id, actor_email, actor_role, actor_api_key_id,
          action, target_type, target_id, result, reason, ip, user_agent, request_id, meta,
          content_hash, prev_hash, hash, occurred_at)
        SELECT
          ${input.orgId}::uuid, ${input.actorUserId}::uuid, ${input.actorEmail}, ${input.actorRole},
          ${input.actorApiKeyId}::uuid, ${input.action}, ${input.targetType}, ${input.targetId},
          ${input.result}, ${input.reason}, ${input.ip}, ${input.userAgent}, ${input.requestId},
          ${JSON.stringify(input.meta)}::jsonb,
          ${ch}, tail.prev,
          encode(sha256(convert_to(tail.prev || ${ch}, 'UTF8')), 'hex'),
          ${input.occurredAt}::timestamptz
        FROM tail
        RETURNING id, seq, hash`))[0];

      if (r?.id) return { ok: true, id: String(r.id), seq: Number(r.seq), hash: String(r.hash) };
      lastError = 'The insert returned no row.';
    } catch (e: any) {
      const reason = dbReason(e);
      lastError = reason;
      // A prev_hash collision means somebody else appended between our read and our write. That is
      // the mechanism working, not a fault: retry against the new tail.
      if (/mailapi_audit_prev_idx|duplicate key/i.test(reason)) continue;
      // Anything else: try the fallback path once, then give up with the real reason.
      const fb = await appendWithComputedHash(input, ch);
      if (fb.ok) return fb;
      return { ok: false, error: reason };
    }
  }
  return { ok: false, error: lastError, contended: true };
}

/**
 * The fallback: read the tail, compute the chain hash here, insert.
 *
 * Two round trips and a wider race window than the single-statement path — which the unique index
 * closes just the same. It exists so that a server without the sha256() built-in degrades to slower
 * rather than to an unrecordable audit, and therefore to a platform where no governance action can
 * be performed at all.
 */
async function appendWithComputedHash(input: AuditEventInput, ch: string): Promise<AuditWriteResult> {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      const tail = rows(await db.execute(sql`
        SELECT hash FROM mailapi_audit_events ORDER BY seq DESC LIMIT 1`))[0];
      const prev = tail?.hash ? String(tail.hash) : GENESIS_HASH;
      const hash = chainHash(prev, ch);
      const r = rows(await db.execute(sql`
        INSERT INTO mailapi_audit_events (
          org_id, actor_user_id, actor_email, actor_role, actor_api_key_id,
          action, target_type, target_id, result, reason, ip, user_agent, request_id, meta,
          content_hash, prev_hash, hash, occurred_at)
        VALUES (
          ${input.orgId}::uuid, ${input.actorUserId}::uuid, ${input.actorEmail}, ${input.actorRole},
          ${input.actorApiKeyId}::uuid, ${input.action}, ${input.targetType}, ${input.targetId},
          ${input.result}, ${input.reason}, ${input.ip}, ${input.userAgent}, ${input.requestId},
          ${JSON.stringify(input.meta)}::jsonb, ${ch}, ${prev}, ${hash}, ${input.occurredAt}::timestamptz)
        RETURNING id, seq, hash`))[0];
      if (r?.id) return { ok: true, id: String(r.id), seq: Number(r.seq), hash: String(r.hash) };
    } catch (e: any) {
      const reason = dbReason(e);
      if (/mailapi_audit_prev_idx|duplicate key/i.test(reason)) continue;
      return { ok: false, error: reason };
    }
  }
  return { ok: false, error: 'The audit chain was contended and the append could not be placed.', contended: true };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface AuditQuery {
  /** Null means every organization. The CALLER must have established that is permitted. */
  orgId?: string | null;
  action?: string | null;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
  beforeSeq?: number | null;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function mapRow(r: any): AuditEventRow {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    orgId: r.org_id ? String(r.org_id) : null,
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
    actorEmail: r.actor_email ?? null,
    actorRole: r.actor_role ?? null,
    actorApiKeyId: r.actor_api_key_id ? String(r.actor_api_key_id) : null,
    action: String(r.action),
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    result: (r.result || 'ok') as AuditEventRow['result'],
    reason: r.reason ?? null,
    ip: r.ip ?? null,
    userAgent: r.user_agent ?? null,
    requestId: r.request_id ?? null,
    meta: (r.meta && typeof r.meta === 'object') ? r.meta : {},
    occurredAt: new Date(r.occurred_at).toISOString(),
    contentHash: String(r.content_hash),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

/**
 * List events.
 *
 * AN EMPTY LIST IS A STATEMENT, NOT A UI STATE. `[]` on a failed query and `[]` because nobody has
 * done anything are the same picture on screen and opposite facts — this repository has already
 * shipped that bug in src/lib/legal-hold.ts and written it up there. Every read here returns
 * { ok, rows } or { ok: false, reason }, and the screens render "the log could not be read".
 */
export async function listAudit(q: AuditQuery): Promise<ReadResult<AuditEventRow>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const r = await db.execute(sql`
      SELECT * FROM mailapi_audit_events
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.action ? sql`action = ${q.action}` : sql`TRUE`}
         AND ${q.actorUserId ? sql`actor_user_id = ${q.actorUserId}::uuid` : sql`TRUE`}
         AND ${q.targetType ? sql`target_type = ${q.targetType}` : sql`TRUE`}
         AND ${q.targetId ? sql`target_id = ${q.targetId}` : sql`TRUE`}
         AND ${q.result ? sql`result = ${q.result}` : sql`TRUE`}
         AND ${q.since ? sql`occurred_at >= ${q.since}::timestamptz` : sql`TRUE`}
         AND ${q.until ? sql`occurred_at <= ${q.until}::timestamptz` : sql`TRUE`}
         AND ${q.beforeSeq ? sql`seq < ${q.beforeSeq}` : sql`TRUE`}
       ORDER BY seq DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(mapRow) };
  } catch (e: any) {
    console.error('[mailgov/audit] listAudit', dbReason(e));
    return { ok: false, reason: dbReason(e) };
  }
}

/** The distinct actions present, for the filter list. Built from data so it cannot go stale. */
export async function auditActions(orgId: string | null): Promise<ReadResult<{ action: string; count: number }>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT action, COUNT(*)::int AS count
        FROM mailapi_audit_events
       WHERE ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       GROUP BY action ORDER BY count DESC LIMIT 100`);
    return { ok: true, rows: rows(r).map((x: any) => ({ action: String(x.action), count: Number(x.count) })) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface ChainStatus {
  ok: boolean;
  /** Null when the read itself failed, which is a different thing from a broken chain. */
  verdict: ChainVerdict | null;
  /** Rows whose stored fields no longer hash to their stored content_hash. */
  contentMismatches: number[];
  head: { seq: number; hash: string } | null;
  total: number;
  checkpoints: { fromSeq: number; toSeq: number; removed: number; cutoff: string }[];
  readError: string | null;
}

/**
 * Verify a window of the chain, and say honestly which window.
 *
 * VERIFYING THE WHOLE TABLE IS NOT OFFERED AS A DEFAULT. On a platform with millions of events that
 * is a full scan on a screen somebody clicked out of curiosity. The default window is the most recent
 * `limit` events, anchored to the row before them — which is a real proof about a real range, stated
 * as such, rather than a green tick that quietly means "the last twenty".
 */
export async function verifyAuditChain(opts: { limit?: number; fromSeq?: number | null } = {}): Promise<ChainStatus> {
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 10), 5000);
  try {
    await ensureGovernanceSchema();

    const totalRow = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM mailapi_audit_events`))[0];
    const total = Number(totalRow?.n) || 0;

    const window = rows(await db.execute(sql`
      SELECT * FROM (
        SELECT * FROM mailapi_audit_events
         WHERE ${opts.fromSeq ? sql`seq >= ${opts.fromSeq}` : sql`TRUE`}
         ORDER BY seq DESC LIMIT ${limit}
      ) w ORDER BY seq ASC`)).map(mapRow);

    // What should the first row in the window link back to? The row immediately before it, if there
    // is one; the genesis hash if the window starts at the beginning; a checkpoint if a prune removed
    // what came before.
    let anchor: string | null = null;
    if (window.length) {
      const before = rows(await db.execute(sql`
        SELECT hash FROM mailapi_audit_events WHERE seq < ${window[0].seq} ORDER BY seq DESC LIMIT 1`))[0];
      if (before?.hash) anchor = String(before.hash);
      else {
        const cp = rows(await db.execute(sql`
          SELECT last_removed_hash FROM mailapi_audit_checkpoints ORDER BY to_seq DESC LIMIT 1`))[0];
        anchor = cp?.last_removed_hash ? String(cp.last_removed_hash) : GENESIS_HASH;
      }
    }

    const verdict = verifyChain(window, anchor);
    const contentMismatches = window.filter((w) => !contentMatches(w)).map((w) => w.seq);

    const cps = rows(await db.execute(sql`
      SELECT from_seq, to_seq, removed, cutoff FROM mailapi_audit_checkpoints ORDER BY to_seq DESC LIMIT 20`))
      .map((c: any) => ({
        fromSeq: Number(c.from_seq), toSeq: Number(c.to_seq),
        removed: Number(c.removed), cutoff: new Date(c.cutoff).toISOString(),
      }));

    const head = window.length ? { seq: window[window.length - 1].seq, hash: window[window.length - 1].hash } : null;

    return {
      ok: verdict.ok && contentMismatches.length === 0,
      verdict, contentMismatches, head, total, checkpoints: cps, readError: null,
    };
  } catch (e: any) {
    // A chain that could not be READ is not a chain that is broken, and the screen must not say it is.
    return {
      ok: false, verdict: null, contentMismatches: [], head: null, total: 0, checkpoints: [],
      readError: dbReason(e),
    };
  }
}

/** The current head, for recording an external anchor. */
export async function auditHead(): Promise<{ seq: number; hash: string } | null> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT seq, hash FROM mailapi_audit_events ORDER BY seq DESC LIMIT 1`))[0];
    return r ? { seq: Number(r.seq), hash: String(r.hash) } : null;
  } catch {
    return null;
  }
}

/**
 * Actions worth naming as constants, because they are written from more than one place and a typo
 * makes an event unfindable rather than wrong-looking.
 *
 * Not an exhaustive list and not enforced — an action is a string, and a new surface should be able
 * to record one without editing this file. These are the ones the brief names.
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: 'user.created',
  USER_SUSPENDED: 'user.suspended',
  USER_RESTORED: 'user.restored',
  USER_DISABLED: 'user.disabled',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  MEMBERSHIP_REMOVED: 'user.membership_removed',
  ORG_SUSPENDED: 'org.suspended',
  ORG_RESTORED: 'org.restored',
  ORG_SENDING_DISABLED: 'org.sending_disabled',
  ORG_RECEIVING_DISABLED: 'org.receiving_disabled',
  ORG_CAMPAIGNS_DISABLED: 'org.campaigns_disabled',
  ORG_CREDENTIALS_ROTATED: 'org.credentials_rotated',
  ORG_DELETED: 'org.deleted',
  DOMAIN_ADDED: 'domain.added',
  MAILBOX_CREATED: 'mailbox.created',
  CAMPAIGN_SENT: 'campaign.sent',
  CAMPAIGN_CANCELLED: 'campaign.cancelled',
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  SECURITY_POLICY_CHANGED: 'security.policy.changed',
  RETENTION_CHANGED: 'retention.policy_changed',
  RETENTION_SWEPT: 'retention.swept',
  AUDIT_PRUNED: 'audit.pruned',
  EXPORT_REQUESTED: 'export.requested',
  EXPORT_COMPLETED: 'export.completed',
  EXPORT_DOWNLOADED: 'export.downloaded',
  DELETION_REQUESTED: 'deletion.requested',
  DELETION_APPROVED: 'deletion.approved',
  DELETION_CANCELLED: 'deletion.cancelled',
  DELETION_EXECUTED: 'deletion.executed',
  CONSENT_RECORDED: 'consent.recorded',
  CONSENT_WITHDRAWN: 'consent.withdrawn',
  HOLD_PLACED: 'legal_hold.placed',
  HOLD_RELEASED: 'legal_hold.released',
  SUPPORT_CONTENT_REQUESTED: 'support.content_requested',
  SUPPORT_CONTENT_APPROVED: 'support.content_approved',
  SUPPORT_CONTENT_ACCESSED: 'support.content_accessed',
  SUPPORT_MESSAGE_RETRIED: 'support.message_retried',
  PLATFORM_GRANT_CHANGED: 'platform.grant_changed',
  ACCESS_DENIED: 'access.denied',
} as const;
