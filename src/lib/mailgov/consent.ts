// src/lib/mailgov/consent.ts — STORING WHAT PEOPLE AGREED TO, PER CATEGORY.
//
// The decision logic is in ./consent-policy.ts (pure, tested against every combination). This is the
// storage and the lookups.
//
// ONE ROW PER (ORGANIZATION, ENVIRONMENT, ADDRESS, CATEGORY). The category is IN THE KEY, which is
// the whole design: a marketing unsubscribe and a transactional record are different rows, so there
// is no update path — none, anywhere — by which withdrawing from one can touch the other. A single
// `is_subscribed` column would have made that mistake possible with one careless UPDATE, and the
// mistake is invisible until somebody's password reset stops arriving.
//
// THE EVIDENCE COLUMN IS NOT DECORATION. "Prove they agreed" is asked months later, usually by
// somebody who is not a customer of ours. `source`, `purpose`, `ip` and `evidence` are what an
// answer is made of; a boolean is not an answer.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason } from './schema';
import {
  CONSENT_CATEGORIES, CATEGORY_SPECS, emptyConsent, maySend, normalizeEmail,
  type ConsentCategory, type ConsentRecord, type SendDecision,
} from './consent-policy';

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): ConsentRecord {
  return {
    orgId: String(r.org_id),
    environment: String(r.environment),
    email: String(r.email),
    category: String(r.category) as ConsentCategory,
    status: String(r.status) as ConsentRecord['status'],
    consentAt: r.consent_at ? new Date(r.consent_at).toISOString() : null,
    source: r.source ?? null,
    purpose: r.purpose ?? null,
    unsubscribedAt: r.unsubscribed_at ? new Date(r.unsubscribed_at).toISOString() : null,
    unsubscribeSource: r.unsubscribe_source ?? null,
    ip: r.ip ?? null,
    evidence: (r.evidence && typeof r.evidence === 'object') ? r.evidence : {},
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** Every category's record for one address. Missing rows come back as `never`, not as absent. */
export async function consentFor(
  orgId: string,
  environment: string,
  email: string,
): Promise<{ ok: boolean; reason?: string; records: Record<ConsentCategory, ConsentRecord> }> {
  const addr = normalizeEmail(email);
  const base = Object.fromEntries(
    CONSENT_CATEGORIES.map((c) => [c, emptyConsent(orgId, environment, addr, c)]),
  ) as Record<ConsentCategory, ConsentRecord>;

  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM mailapi_consent
       WHERE org_id = ${orgId}::uuid AND environment = ${environment} AND email = ${addr}`));
    for (const row of r) {
      const rec = map(row);
      if (CATEGORY_SPECS[rec.category]) base[rec.category] = rec;
    }
    return { ok: true, records: base };
  } catch (e: any) {
    // Fails CLOSED for the caller that matters: mayPlatformSend() below turns a failed read into a
    // refusal to send rather than into a send with no consent check.
    return { ok: false, reason: dbReason(e), records: base };
  }
}

/**
 * THE QUESTION THE SEND PATH ASKS.
 *
 * Combines the consent record and the suppression list, and refuses on a failed read. A consent
 * lookup that did not run must never resolve to "go ahead" — that is the one failure mode where the
 * damage is already in somebody's inbox by the time anybody notices.
 */
export async function mayPlatformSend(input: {
  orgId: string;
  environment: string;
  email: string;
  category: string;
}): Promise<SendDecision> {
  const addr = normalizeEmail(input.email);
  try {
    await ensureGovernanceSchema();
    const consentRow = rows(await db.execute(sql`
      SELECT * FROM mailapi_consent
       WHERE org_id = ${input.orgId}::uuid AND environment = ${input.environment}
         AND email = ${addr} AND category = ${input.category}
       LIMIT 1`))[0];
    const suppRow = rows(await db.execute(sql`
      SELECT reason, created_at, detail FROM mailapi_suppressions
       WHERE org_id = ${input.orgId}::uuid AND environment = ${input.environment} AND email = ${addr}
       LIMIT 1`))[0];

    return maySend({
      category: input.category,
      consent: consentRow ? map(consentRow) : null,
      suppression: suppRow ? { reason: String(suppRow.reason), createdAt: suppRow.created_at ? String(suppRow.created_at) : null, detail: suppRow.detail ?? null } : null,
    });
  } catch (e: any) {
    return {
      allowed: false,
      code: 'no-consent-recorded',
      reason: 'The consent record could not be read, so the send was refused rather than guessed at: ' + dbReason(e),
      fromSuppression: false,
    };
  }
}

export interface ConsentWrite {
  orgId: string;
  environment: string;
  email: string;
  category: ConsentCategory;
  source: string;
  purpose?: string | null;
  ip?: string | null;
  evidence?: Record<string, unknown>;
  at?: string;
}

/** Record a consent. Upserts on the four-part key, so re-consenting updates rather than duplicating. */
export async function recordConsent(input: ConsentWrite): Promise<{ ok: boolean; error?: string }> {
  if (!CATEGORY_SPECS[input.category]) return { ok: false, error: 'Unknown category: ' + input.category + '.' };
  const source = String(input.source || '').trim();
  if (!source) {
    return { ok: false, error: 'Record where the consent came from. A consent with no source cannot be produced as evidence of anything.' };
  }
  const addr = normalizeEmail(input.email);
  const at = input.at || new Date().toISOString();
  try {
    await ensureGovernanceSchema();
    await db.execute(sql`
      INSERT INTO mailapi_consent (org_id, environment, email, category, status, consent_at, source, purpose, ip, evidence, updated_at)
      VALUES (${input.orgId}::uuid, ${input.environment}, ${addr}, ${input.category}, 'subscribed',
              ${at}::timestamptz, ${source}, ${input.purpose || null}, ${input.ip || null},
              ${JSON.stringify(input.evidence || {})}::jsonb, ${at}::timestamptz)
      ON CONFLICT (org_id, environment, email, category) DO UPDATE
        SET status = 'subscribed',
            consent_at = EXCLUDED.consent_at,
            source = EXCLUDED.source,
            purpose = COALESCE(EXCLUDED.purpose, mailapi_consent.purpose),
            ip = COALESCE(EXCLUDED.ip, mailapi_consent.ip),
            evidence = mailapi_consent.evidence || EXCLUDED.evidence,
            updated_at = EXCLUDED.updated_at`);
    // unsubscribed_at is deliberately NOT cleared. "Subscribed, previously unsubscribed on the 3rd"
    // is a materially different record from "subscribed, never unsubscribed", and it is the more
    // interesting of the two.
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Withdraw consent.
 *
 * Refuses on a category that cannot be switched off, rather than accepting the click and ignoring it.
 * A preference screen that takes a choice it will not honour is worse than one that explains why.
 */
export async function withdrawConsent(input: {
  orgId: string;
  environment: string;
  email: string;
  category: ConsentCategory;
  source: string;
  at?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const spec = CATEGORY_SPECS[input.category];
  if (!spec) return { ok: false, error: 'Unknown category: ' + input.category + '.' };
  if (!spec.unsubscribable) {
    return { ok: false, error: spec.label + ' cannot be switched off while the account exists. ' + spec.describes };
  }
  const addr = normalizeEmail(input.email);
  const at = input.at || new Date().toISOString();
  try {
    await ensureGovernanceSchema();
    await db.execute(sql`
      INSERT INTO mailapi_consent (org_id, environment, email, category, status, unsubscribed_at, unsubscribe_source, updated_at)
      VALUES (${input.orgId}::uuid, ${input.environment}, ${addr}, ${input.category}, 'unsubscribed',
              ${at}::timestamptz, ${input.source}, ${at}::timestamptz)
      ON CONFLICT (org_id, environment, email, category) DO UPDATE
        SET status = 'unsubscribed',
            unsubscribed_at = EXCLUDED.unsubscribed_at,
            unsubscribe_source = EXCLUDED.unsubscribe_source,
            updated_at = EXCLUDED.updated_at`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export interface ConsentQuery {
  orgId: string;
  environment?: string | null;
  category?: ConsentCategory | null;
  status?: string | null;
  email?: string | null;
  limit?: number;
}

export async function listConsent(q: ConsentQuery): Promise<ReadResult<ConsentRecord>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const r = await db.execute(sql`
      SELECT * FROM mailapi_consent
       WHERE org_id = ${q.orgId}::uuid
         AND ${q.environment ? sql`environment = ${q.environment}` : sql`TRUE`}
         AND ${q.category ? sql`category = ${q.category}` : sql`TRUE`}
         AND ${q.status ? sql`status = ${q.status}` : sql`TRUE`}
         AND ${q.email ? sql`email = ${normalizeEmail(q.email)}` : sql`TRUE`}
       ORDER BY updated_at DESC
       LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface ConsentSummary {
  ok: boolean;
  reason?: string;
  /** category -> status -> count */
  counts: Record<string, Record<string, number>>;
  addresses: number;
}

export async function consentSummary(orgId: string, environment?: string | null): Promise<ConsentSummary> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT category, status, COUNT(*)::int AS n
        FROM mailapi_consent
       WHERE org_id = ${orgId}::uuid
         AND ${environment ? sql`environment = ${environment}` : sql`TRUE`}
       GROUP BY category, status`));
    const counts: Record<string, Record<string, number>> = {};
    for (const row of r) {
      const c = String(row.category);
      counts[c] = counts[c] || {};
      counts[c][String(row.status)] = Number(row.n) || 0;
    }
    const a = rows(await db.execute(sql`
      SELECT COUNT(DISTINCT email)::int AS n FROM mailapi_consent
       WHERE org_id = ${orgId}::uuid
         AND ${environment ? sql`environment = ${environment}` : sql`TRUE`}`))[0];
    return { ok: true, counts, addresses: Number(a?.n) || 0 };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e), counts: {}, addresses: 0 };
  }
}
