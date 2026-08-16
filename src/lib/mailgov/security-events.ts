// src/lib/mailgov/security-events.ts — ONE PLACE EVERY SECURITY SIGNAL LANDS.
//
// The classification is in ./security-policy.ts (pure). This is the recorder and the reader.
//
// WHY CENTRALISE. Before this, a failed API key lookup logged a line, a refused relay logged a
// different line, and a refused admin action logged nothing at all — three formats in three files
// and no screen that could answer "is anything unusual happening on this platform right now". A
// signal that only exists in a log file is a signal nobody is watching, because nobody watches log
// files on a normal Tuesday.
//
// RECORDING NEVER THROWS AND NEVER BLOCKS. recordSecurityEvent() is called from authentication
// paths, from the API guard, and from the middle of a send. If it fails it says so in the process
// log and returns false — a security recorder that can take down a sign-in has become the
// vulnerability. This is the OPPOSITE choice from the audit log, deliberately: an audit event is
// part of the action and must be able to refuse it; a security event is an observation about an
// action that has already been decided.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import { classify, SEVERITY_RANK, type SecuritySeverity, type SecurityEventStatus } from './security-policy';

export interface SecurityEventInput {
  type: string;
  orgId?: string | null;
  environment?: string | null;
  /** The thing the event is ABOUT: an address, a domain, a key prefix, an account. */
  subject?: string | null;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
  /** Overrides the catalogue severity. Used when a caller has counted something the catalogue cannot. */
  severity?: SecuritySeverity;
  occurredAt?: string;
}

export interface SecurityEventRow {
  id: string;
  orgId: string | null;
  environment: string | null;
  type: string;
  family: string;
  severity: SecuritySeverity;
  label: string;
  recommendation: string;
  subject: string | null;
  actorUserId: string | null;
  ip: string | null;
  requestId: string | null;
  detail: Record<string, unknown>;
  status: SecurityEventStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  occurredAt: string;
}

/**
 * Record one signal. Returns whether it landed; never throws.
 *
 * The catalogue supplies family and severity so two call sites recording the same type cannot
 * disagree about how serious it is — which is how a console ends up with `auth.login_failed` sorted
 * as critical in one view and info in another.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<boolean> {
  const spec = classify(input.type);
  try {
    await ensureGovernanceSchema();
    await db.execute(sql`
      INSERT INTO mailapi_security_events (
        org_id, environment, type, family, severity, subject,
        actor_user_id, actor_api_key_id, ip, user_agent, request_id, detail, occurred_at)
      VALUES (
        ${input.orgId || null}::uuid, ${input.environment || null}, ${spec.type}, ${spec.family},
        ${input.severity || spec.severity}, ${input.subject || null},
        ${input.actorUserId || null}::uuid, ${input.actorApiKeyId || null}::uuid,
        ${input.ip || null}, ${input.userAgent || null}, ${input.requestId || null},
        ${JSON.stringify(input.detail || {})}::jsonb,
        ${input.occurredAt || new Date().toISOString()}::timestamptz)`);
    return true;
  } catch (e: any) {
    // Loud in the process log, invisible to the caller's control flow. See the note at the top.
    logEvent('error', 'mailgov.security.record-failed', { type: input.type, message: dbReason(e) });
    return false;
  }
}

export interface SecurityQuery {
  orgId?: string | null;
  family?: string | null;
  type?: string | null;
  severity?: SecuritySeverity | null;
  status?: SecurityEventStatus | null;
  subject?: string | null;
  since?: string | null;
  limit?: number;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): SecurityEventRow {
  const spec = classify(String(r.type));
  return {
    id: String(r.id),
    orgId: r.org_id ? String(r.org_id) : null,
    environment: r.environment ?? null,
    type: String(r.type),
    family: String(r.family || spec.family),
    severity: (r.severity || spec.severity) as SecuritySeverity,
    label: spec.label,
    recommendation: spec.recommendation,
    subject: r.subject ?? null,
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
    ip: r.ip ?? null,
    requestId: r.request_id ?? null,
    detail: (r.detail && typeof r.detail === 'object') ? r.detail : {},
    status: (r.status || 'new') as SecurityEventStatus,
    resolvedBy: r.resolved_by ? String(r.resolved_by) : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolutionNote: r.resolution_note ?? null,
    occurredAt: new Date(r.occurred_at).toISOString(),
  };
}

/** An empty list and a failed read are different facts, and the screens say which one happened. */
export async function listSecurityEvents(q: SecurityQuery): Promise<ReadResult<SecurityEventRow>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const r = await db.execute(sql`
      SELECT * FROM mailapi_security_events
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.family ? sql`family = ${q.family}` : sql`TRUE`}
         AND ${q.type ? sql`type = ${q.type}` : sql`TRUE`}
         AND ${q.severity ? sql`severity = ${q.severity}` : sql`TRUE`}
         AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
         AND ${q.subject ? sql`subject = ${q.subject}` : sql`TRUE`}
         AND ${q.since ? sql`occurred_at >= ${q.since}::timestamptz` : sql`TRUE`}
       ORDER BY occurred_at DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface SecuritySummary {
  ok: boolean;
  reason?: string;
  total: number;
  open: number;
  bySeverity: Record<string, number>;
  byFamily: Record<string, number>;
  /** The most severe unresolved event, for the overview banner. */
  worstOpen: SecurityEventRow | null;
  since: string;
}

/** The counts the console overview shows. One query, so the banner is cheap enough to always render. */
export async function securitySummary(orgId: string | null, sinceHours = 168): Promise<SecuritySummary> {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const empty: SecuritySummary = { ok: true, total: 0, open: 0, bySeverity: {}, byFamily: {}, worstOpen: null, since };
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT severity, family, status, COUNT(*)::int AS n
        FROM mailapi_security_events
       WHERE occurred_at >= ${since}::timestamptz
         AND ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       GROUP BY severity, family, status`));

    const out: SecuritySummary = { ...empty, bySeverity: {}, byFamily: {} };
    for (const row of r) {
      const n = Number(row.n) || 0;
      out.total += n;
      out.bySeverity[String(row.severity)] = (out.bySeverity[String(row.severity)] || 0) + n;
      out.byFamily[String(row.family)] = (out.byFamily[String(row.family)] || 0) + n;
      if (String(row.status) === 'new' || String(row.status) === 'acknowledged') out.open += n;
    }

    const worst = rows(await db.execute(sql`
      SELECT * FROM mailapi_security_events
       WHERE status IN ('new', 'acknowledged')
         AND occurred_at >= ${since}::timestamptz
         AND ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       ORDER BY CASE severity
                  WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2
                  WHEN 'low' THEN 1 ELSE 0 END DESC,
                occurred_at DESC
       LIMIT 1`))[0];
    out.worstOpen = worst ? map(worst) : null;
    return out;
  } catch (e: any) {
    return { ...empty, ok: false, reason: dbReason(e) };
  }
}

/**
 * Triage. A resolution NOTE is required for 'resolved' and 'false_positive'.
 *
 * "Resolved" with no note is a row that has been made to stop blinking. Six weeks later nobody can
 * say whether it was investigated or dismissed, and the two are the whole difference between a
 * security process and a habit of clearing badges.
 */
export async function resolveSecurityEvent(input: {
  id: string;
  status: SecurityEventStatus;
  note?: string | null;
  byUserId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const needsNote = input.status === 'resolved' || input.status === 'false_positive';
  const note = String(input.note || '').trim();
  if (needsNote && note.length < 10) {
    return { ok: false, error: 'Say what was found, in at least ten characters. A cleared event with no note cannot be told apart from an ignored one.' };
  }
  try {
    await ensureGovernanceSchema();
    await db.execute(sql`
      UPDATE mailapi_security_events
         SET status = ${input.status},
             resolved_by = ${input.byUserId}::uuid,
             resolved_at = now(),
             resolution_note = ${note || null}
       WHERE id = ${input.id}::uuid`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/** Distinct source addresses a key or account has been seen from, for the anomaly assessment. */
export async function knownAddressesFor(subject: string, days = 90): Promise<string[]> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT DISTINCT ip FROM mailapi_security_events
       WHERE subject = ${subject} AND ip IS NOT NULL
         AND occurred_at >= now() - (${days} || ' days')::interval
       LIMIT 200`));
    return r.map((x: any) => String(x.ip)).filter(Boolean);
  } catch {
    return [];
  }
}

export { SEVERITY_RANK };
