// src/lib/mailapi/suppression.ts — addresses we have been told to stop mailing.
//
// SUPPRESSION IS A PROMISE, NOT A PREFERENCE. A hard bounce means the mailbox does not exist and
// continuing to send at it damages the sending domain for every other product on it. A complaint or
// an unsubscribe means a person asked us to stop, and the only acceptable number of further messages
// is zero. Both are enforced at send time, before anything reaches the transport, so no code path
// can route around them by calling a lower-level function.
//
// IT IS SCOPED PER ORGANIZATION AND PER ENVIRONMENT. A candidate who unsubscribes from careers
// updates has not unsubscribed from their own password reset, and a staging test that bounces a
// hundred fake addresses must not be able to mute a real recipient in production.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  source: string | null;
  detail: string | null;
  createdAt: string;
}

export function normalizeAddress(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export async function suppress(p: {
  orgId: string; environment: string; email: string; reason: SuppressionReason; source?: string | null; detail?: string | null;
}): Promise<boolean> {
  await ensureMailApiSchema();
  const email = normalizeAddress(p.email);
  if (!email) return false;
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_suppressions (org_id, environment, email, reason, source, detail)
    VALUES (${p.orgId}, ${p.environment}, ${email}, ${p.reason}, ${p.source || null}, ${(p.detail || '').slice(0, 500) || null})
    ON CONFLICT (org_id, environment, email) DO UPDATE
      SET reason = EXCLUDED.reason, source = EXCLUDED.source, detail = EXCLUDED.detail
    RETURNING id`));
  return r.length > 0;
}

/** Remove an address from the list. Deliberately explicit: nothing un-suppresses automatically. */
export async function unsuppress(orgId: string, environment: string, email: string): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    DELETE FROM mailapi_suppressions
    WHERE org_id = ${orgId} AND environment = ${environment} AND email = ${normalizeAddress(email)} RETURNING id`));
  return r.length > 0;
}

/**
 * Which of these addresses are suppressed.
 *
 * One statement for the whole recipient list. The list is passed as jsonb and unnested rather than
 * bound as a JS array — postgres-js serialises a JS array as a record literal in an `= ANY(...)`
 * position, which is the fault documented at the top of src/lib/mail.ts that stopped every mail
 * thread from opening.
 */
export async function findSuppressed(orgId: string, environment: string, emails: string[]): Promise<Map<string, Suppression>> {
  await ensureMailApiSchema();
  const list = Array.from(new Set(emails.map(normalizeAddress).filter(Boolean)));
  const out = new Map<string, Suppression>();
  if (list.length === 0) return out;
  const r = rows(await db.execute(sql`
    SELECT email, reason, source, detail, created_at FROM mailapi_suppressions
    WHERE org_id = ${orgId} AND environment = ${environment}
      AND email IN (SELECT jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`));
  for (const row of r) {
    out.set(row.email, { email: row.email, reason: row.reason, source: row.source || null, detail: row.detail || null, createdAt: row.created_at });
  }
  return out;
}

export async function listSuppressions(orgId: string, environment: string, limit = 200): Promise<Suppression[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT email, reason, source, detail, created_at FROM mailapi_suppressions
    WHERE org_id = ${orgId} AND environment = ${environment}
    ORDER BY created_at DESC LIMIT ${Math.min(1000, limit)}`)).map((r: any) => ({
      email: r.email, reason: r.reason, source: r.source || null, detail: r.detail || null, createdAt: r.created_at,
    }));
}
