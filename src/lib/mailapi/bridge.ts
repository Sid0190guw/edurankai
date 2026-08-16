// src/lib/mailapi/bridge.ts — where this layer consumes the campaign platform instead of forking it.
//
// WHY THIS FILE EXISTS AT ALL. src/lib/mailplatform is an existing, mature multi-tenant mail platform
// with its own organizations (`mp_organizations`), suppression list (`mp_suppression_entries`),
// templates, webhooks and campaign machinery. The transactional developer API is a DIFFERENT product
// with contracts this patch fixes — environment-separated keys, idempotency, versioned webhook
// payloads, `RateLimit-*` headers, the exact endpoint shapes an SDK is generated from — so it has its
// own tables. But two of those things must not be forked, because forking them is not untidiness, it
// is a defect:
//
//   ORGANIZATIONS. If "AquinTutor" is one row here and a different row there, an operator reading the
//   campaign console and an operator reading the developer console are looking at two things with the
//   same name, and no report can ever join them. Every mailapi organization therefore carries the id
//   of its mailplatform counterpart, created or matched by slug on first use.
//
//   SUPPRESSION. This is the one that would actually hurt somebody. A candidate who unsubscribes from
//   a campaign is recorded in `mp_suppression_entries`. If the transactional API kept only its own
//   list, that unsubscribe would be invisible to it and the next stage-update mail would go out
//   anyway — a person who asked us to stop, being mailed by a system that had the answer and did not
//   look. So a send checks BOTH lists.
//
// THE READ IS ONE-WAY AND IT FAILS OPEN, DELIBERATELY. If the mailplatform tables are missing (an
// un-migrated deployment) or unreadable, a transactional send does not stop — it proceeds on its own
// suppression list and the failure is logged. The alternative is that a schema problem in the
// campaign workstream silently blocks password resets.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows } from './schema';

/** Reasons in `mp_suppression_entries.reason` that mean "stop sending", mapped to our vocabulary. */
const MP_REASON_MAP: Record<string, 'bounce' | 'complaint' | 'unsubscribe' | 'manual'> = {
  hard_bounce: 'bounce',
  repeated_soft_bounce: 'bounce',
  invalid_address: 'bounce',
  complaint: 'complaint',
  unsubscribe: 'unsubscribe',
  manual: 'manual',
};

/**
 * Find (or create) the mailplatform organization matching a slug, and return its id.
 *
 * Matching is by slug because that is the identifier a human types in both consoles. A failure here
 * is logged and returns null: an organization that cannot be linked still works in the transactional
 * API, it simply is not joined to the campaign side yet, and the link is retried on the next call.
 */
export async function linkMailplatformOrg(slug: string, name: string): Promise<string | null> {
  try {
    const existing = rows(await db.execute(sql`
      SELECT id FROM mp_organizations WHERE lower(slug) = ${slug.toLowerCase()} AND deleted_at IS NULL LIMIT 1`));
    if (existing[0]) return existing[0].id;
    const created = rows(await db.execute(sql`
      INSERT INTO mp_organizations (slug, name) VALUES (${slug}, ${name})
      ON CONFLICT DO NOTHING RETURNING id`));
    if (created[0]) return created[0].id;
    const again = rows(await db.execute(sql`
      SELECT id FROM mp_organizations WHERE lower(slug) = ${slug.toLowerCase()} AND deleted_at IS NULL LIMIT 1`));
    return again[0]?.id || null;
  } catch (e: any) {
    // Not fatal, and not silent. mp_organizations may simply not exist on this deployment.
    console.error('[mailapi/bridge] could not link mailplatform organization "' + slug + '":', e?.cause?.message || e?.message);
    return null;
  }
}

export interface SharedSuppression { email: string; reason: 'bounce' | 'complaint' | 'unsubscribe' | 'manual'; source: string }

/**
 * Suppressions recorded by the campaign platform for the linked organization.
 *
 * Only org-wide entries are honoured (`scope = 'org'`): a campaign-scoped opt-out means "not this
 * campaign", and treating it as "no transactional mail either" would block the password reset of
 * somebody who merely left a mailing list. Expired entries are excluded, because mailplatform gives
 * them an expiry for a reason.
 */
export async function mailplatformSuppressions(mpOrgId: string | null, emails: string[]): Promise<Map<string, SharedSuppression>> {
  const out = new Map<string, SharedSuppression>();
  if (!mpOrgId || emails.length === 0) return out;
  try {
    const list = Array.from(new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)));
    const r = rows(await db.execute(sql`
      SELECT lower(address) AS address, reason FROM mp_suppression_entries
      WHERE org_id = ${mpOrgId}::uuid AND scope = 'org'
        AND (expires_at IS NULL OR expires_at > now())
        AND lower(address) IN (SELECT jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`));
    for (const row of r) {
      const reason = MP_REASON_MAP[String(row.reason)] || 'manual';
      out.set(row.address, { email: row.address, reason, source: 'campaign platform' });
    }
  } catch (e: any) {
    // FAILS OPEN, AND SAYS SO. A schema fault in the campaign workstream must not stop a password
    // reset; it must also never pass unnoticed, because for as long as it lasts an unsubscribe
    // recorded over there is not being honoured here.
    console.error('[mailapi/bridge] could not read mp_suppression_entries; transactional sends are using the local list only:', e?.cause?.message || e?.message);
  }
  return out;
}

/**
 * Mirror a suppression into the campaign platform, so an unsubscribe collected by a transactional
 * message also stops campaign mail. Best effort in the same one-way spirit as the read.
 */
export async function mirrorSuppression(mpOrgId: string | null, email: string, reason: 'bounce' | 'complaint' | 'unsubscribe' | 'manual', source: string): Promise<void> {
  if (!mpOrgId) return;
  const mapped = reason === 'bounce' ? 'hard_bounce' : reason;
  try {
    await db.execute(sql`
      INSERT INTO mp_suppression_entries (org_id, address, scope, reason, source)
      VALUES (${mpOrgId}::uuid, ${email.toLowerCase()}, 'org', ${mapped}, ${source.slice(0, 120)})
      ON CONFLICT DO NOTHING`);
  } catch (e: any) {
    console.error('[mailapi/bridge] could not mirror suppression to the campaign platform:', e?.cause?.message || e?.message);
  }
}
