// src/lib/mailplatform/domains/store.ts — THE DATA LAYER FOR DOMAINS, KEYS, IDENTITIES, MAILBOXES
// AND ALIASES.
//
// Two rules govern every function in this file.
//
// ORG ISOLATION IS A WHERE CLAUSE, NOT A CHECK BEFORE THE QUERY. Every read and every write carries
// `org_id = ${principal.orgId}` in its predicate. A pattern of "fetch by id, then compare orgId in
// TypeScript" fails open the first time somebody forgets the second half, and the failure is a
// tenant reading another tenant's domain configuration. Here a wrong-tenant id simply matches no
// row, which is the same answer as a nonexistent one — deliberately, because "not found" and
// "belongs to someone else" must be indistinguishable to a caller who should not know it exists.
//
// THE SCHEMA IS NOT MINE TO EDIT. src/lib/mailplatform/schema.ts is owned by the platform migration
// and already defines mp_domains, mp_dkim_keys, mp_mailboxes, mp_aliases and the rest. Everything
// this patch needs beyond that is ADDITIVE and lives in DOMAIN_DDL below: new tables, and
// ADD COLUMN IF NOT EXISTS on existing ones. Nothing here drops, renames or retypes a column, and
// nothing here changes a CHECK constraint — so this file applies cleanly to a database another
// agent's migration has already touched, in either order.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { ensureMailPlatformSchema } from '../schema';
import { can } from '../permissions';
import type { MailPermission, Principal, UUID } from '../types';
import { generateDkimKeyPair, isValidSelector, nextSelector, type DkimAlgorithm } from './dkim';
import { normalizeDomain, isValidDomain } from './dns';
import { validateAlias, type AliasEdge, type DeliveryGraph, type MailboxDeliveryStatus, normalizeAddress } from './aliases';
import { canTransition, validateMailboxAddress, type MailboxStatus } from './mailbox-rules';
import type { DomainHealth } from './verify';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
/** The real Postgres reason lives on `cause`; `message` is only the SQL that failed. */
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export interface Ctx {
  principal: Principal;
  ip?: string | null;
  userAgent?: string | null;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
const fail = (error: string, code?: string): { ok: false; error: string; code?: string } => ({ ok: false, error, code });
const done = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

function requires(ctx: Ctx, permission: MailPermission): { ok: false; error: string; code?: string } | null {
  if (!can(ctx.principal, permission)) return fail('You do not have permission to do this.', 'insufficient_permission');
  return null;
}

// ---------------------------------------------------------------------------
// Additive schema
// ---------------------------------------------------------------------------

export const DOMAIN_DDL: string[] = [
  // A mailbox has FOUR states in the brief and the platform table has a boolean plus deleted_at.
  // The column is added rather than the boolean reinterpreted, and both are kept in step by every
  // writer below, so code elsewhere that reads is_active keeps working unchanged.
  `ALTER TABLE mp_mailboxes ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'active'`,
  `CREATE INDEX IF NOT EXISTS mp_mailbox_status_idx ON mp_mailboxes(org_id, status) WHERE deleted_at IS NULL`,
  // What an identity is FOR. The brief lists purpose as part of a sending identity; the platform
  // table predates that.
  `ALTER TABLE mp_sending_identities ADD COLUMN IF NOT EXISTS purpose VARCHAR(32)`,

  // Ciphertext at rest for anything the MTA needs and nobody may read. The envelope format,
  // key registry and rotation come from src/lib/crypto — a second encryption scheme in the same
  // codebase is a second thing to get wrong.
  `CREATE TABLE IF NOT EXISTS mp_secrets (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     purpose VARCHAR(40) NOT NULL,
     envelope JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     destroyed_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS mp_secrets_org_idx ON mp_secrets(org_id, purpose) WHERE destroyed_at IS NULL`,

  // Multiple destinations per alias. mp_aliases carries ONE destination and a unique index on the
  // source, so fan-out cannot be expressed as extra rows there without fighting that index. The
  // parent row keeps its primary destination for any code that reads it directly; this table holds
  // the full set, and expandAlias() reads the union.
  `CREATE TABLE IF NOT EXISTS mp_alias_targets (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     alias_id UUID NOT NULL REFERENCES mp_aliases(id) ON DELETE CASCADE,
     destination_address VARCHAR(320) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(alias_id, destination_address)
   )`,
  `CREATE INDEX IF NOT EXISTS mp_alias_targets_org_idx ON mp_alias_targets(org_id)`,

  `CREATE TABLE IF NOT EXISTS mp_mailbox_settings (
     mailbox_id UUID PRIMARY KEY REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     forward_to TEXT[] NOT NULL DEFAULT '{}',
     forward_keep_copy BOOLEAN NOT NULL DEFAULT true,
     auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
     auto_reply_subject VARCHAR(200),
     auto_reply_body TEXT,
     auto_reply_starts_at TIMESTAMPTZ,
     auto_reply_ends_at TIMESTAMPTZ,
     auto_reply_interval_days INT NOT NULL DEFAULT 7,
     auto_reply_external BOOLEAN NOT NULL DEFAULT true,
     auto_reply_internal BOOLEAN NOT NULL DEFAULT true,
     signature_text TEXT,
     signature_html TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // One row per sender per mailbox: what makes "one auto-reply per sender per interval" true rather
  // than aspirational. Without it a mailing list gets one reply per message.
  `CREATE TABLE IF NOT EXISTS mp_auto_reply_log (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     mailbox_id UUID NOT NULL REFERENCES mp_mailboxes(id) ON DELETE CASCADE,
     sender_address VARCHAR(320) NOT NULL,
     replied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(mailbox_id, sender_address)
   )`,

  // The last health run, whole. mp_domain_verifications keeps the five persisted check types the
  // platform schema constrains it to; PTR and TLS are not among them, and the roll-up (is sending
  // ready, is receiving ready) is not a per-check row at all.
  `CREATE TABLE IF NOT EXISTS mp_domain_health (
     domain_id UUID PRIMARY KEY REFERENCES mp_domains(id) ON DELETE CASCADE,
     org_id UUID NOT NULL REFERENCES mp_organizations(id) ON DELETE CASCADE,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     ownership_verified BOOLEAN NOT NULL DEFAULT false,
     sending_ready BOOLEAN NOT NULL DEFAULT false,
     receiving_ready BOOLEAN NOT NULL DEFAULT false,
     payload JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
];

let domainSchemaReady: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Apply the platform schema, then this patch's additions.
 *
 * A FAILURE IS NOT MEMOISED AS A SUCCESS — the same trap ../schema.ts documents. On failure the
 * cached promise is cleared so the next request retries, and the reason is returned rather than
 * logged and swallowed.
 */
export function ensureDomainSchema(): Promise<{ ok: boolean; error?: string }> {
  if (!domainSchemaReady) domainSchemaReady = applyDomainSchema();
  return domainSchemaReady;
}

async function applyDomainSchema(): Promise<{ ok: boolean; error?: string }> {
  const base = await ensureMailPlatformSchema();
  if (!base.ok) {
    domainSchemaReady = null;
    return base;
  }
  try {
    for (const stmt of DOMAIN_DDL) await db.execute(sql.raw(stmt));
    return { ok: true };
  } catch (e: any) {
    const error = causeOf(e);
    console.error('[mailplatform/domains] schema extension failed -', error);
    domainSchemaReady = null;
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Record an administrative act.
 *
 * Never throws and never blocks the operation it describes: an audit write that fails must be
 * loud in the log, but a domain change that succeeded and then failed to be recorded is still a
 * domain change, and rolling it back would leave the DNS the customer just published pointing at
 * a configuration that no longer exists.
 */
export async function audit(
  ctx: Ctx,
  action: string,
  target: { type: string; id: string | null },
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mp_audit_logs (org_id, actor_user_id, actor_api_key_id, action, target_type, target_id, meta, ip_address, user_agent)
      VALUES (
        ${ctx.principal.orgId},
        ${ctx.principal.kind === 'user' ? ctx.principal.id : null},
        ${ctx.principal.kind === 'api_key' ? ctx.principal.id : null},
        ${action}, ${target.type}, ${target.id},
        ${JSON.stringify(meta)}::jsonb, ${ctx.ip || null}, ${ctx.userAgent || null})`);
  } catch (e: any) {
    console.error('[mailplatform/domains] audit write failed for', action, '-', causeOf(e));
  }
}

export async function listAudit(orgId: UUID, targetId: string | null, limit = 50): Promise<any[]> {
  try {
    const r = targetId
      ? await db.execute(sql`
          SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM mp_audit_logs a
          LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.org_id = ${orgId} AND a.target_id = ${targetId}
          ORDER BY a.created_at DESC LIMIT ${limit}`)
      : await db.execute(sql`
          SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM mp_audit_logs a
          LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.org_id = ${orgId} AND a.target_type IN ('domain','dkim_key','mailbox','alias','identity')
          ORDER BY a.created_at DESC LIMIT ${limit}`);
    return rows(r);
  } catch (e: any) {
    console.error('[mailplatform/domains] audit read failed -', causeOf(e));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type StoredDomainStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'disabled';
/** The six states the brief names. Derived — see lifecycleState(). */
export type LifecycleState = 'PENDING' | 'VERIFYING' | 'VERIFIED' | 'ACTIVE' | 'SUSPENDED' | 'FAILED';

export interface DomainRow {
  id: UUID;
  orgId: UUID;
  domain: string;
  status: StoredDomainStatus;
  purpose: 'sending' | 'receiving' | 'both';
  verificationToken: string;
  verifiedAt: string | null;
  dkimSelector: string | null;
  createdAt: string;
  updatedAt: string;
  /** From mp_sending_domains: is this domain permitted to send right now? */
  sendingEnabled: boolean;
  /** From mp_domain_health, when a run has been recorded. */
  lastCheckedAt: string | null;
  ownershipVerified: boolean;
  sendingReady: boolean;
  receivingReady: boolean;
  lifecycle: LifecycleState;
}

/**
 * The six-state lifecycle, derived rather than stored.
 *
 * mp_domains.status has a CHECK constraint accepting five values and it is not this patch's to
 * widen. ACTIVE is not a sixth status — it is "verified AND permitted to send", which is exactly
 * what mp_sending_domains.is_enabled already records, and the platform schema's own comment says so:
 * a domain can be verified for receiving and still barred from sending, which is the correct state
 * for one that has not been warmed up.
 */
export function lifecycleState(status: StoredDomainStatus, sendingEnabled: boolean): LifecycleState {
  if (status === 'disabled') return 'SUSPENDED';
  if (status === 'failed') return 'FAILED';
  if (status === 'pending') return 'PENDING';
  if (status === 'verifying') return 'VERIFYING';
  return sendingEnabled ? 'ACTIVE' : 'VERIFIED';
}

function toDomainRow(r: any): DomainRow {
  const status = String(r.status) as StoredDomainStatus;
  const sendingEnabled = r.sending_enabled === true;
  return {
    id: r.id,
    orgId: r.org_id,
    domain: r.domain,
    status,
    purpose: r.purpose,
    verificationToken: r.verification_token,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    dkimSelector: r.dkim_selector || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    sendingEnabled,
    lastCheckedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
    ownershipVerified: r.ownership_verified === true,
    sendingReady: r.sending_ready === true,
    receivingReady: r.receiving_ready === true,
    lifecycle: lifecycleState(status, sendingEnabled),
  };
}

/**
 * The domain SELECT, with the tenant predicate BUILT IN rather than appended by the caller.
 *
 * It was a bare fragment that each caller finished with its own WHERE. That is one forgotten clause
 * away from a cross-tenant read, and the forgetting would not fail any test — it would just return
 * more rows. Taking orgId as an argument makes the predicate structurally impossible to omit.
 */
const domainSelect = (orgId: UUID) => sql`
  SELECT d.*, sd.is_enabled AS sending_enabled,
         h.checked_at, h.ownership_verified, h.sending_ready, h.receiving_ready
  FROM mp_domains d
  LEFT JOIN mp_sending_domains sd ON sd.domain_id = d.id AND sd.pool = 'default' AND sd.deleted_at IS NULL
  LEFT JOIN mp_domain_health h ON h.domain_id = d.id
  WHERE d.org_id = ${orgId} AND d.deleted_at IS NULL`;

export async function listDomains(orgId: UUID): Promise<DomainRow[]> {
  await ensureDomainSchema();
  try {
    const r = await db.execute(sql`${domainSelect(orgId)} ORDER BY d.created_at ASC`);
    return rows(r).map(toDomainRow);
  } catch (e: any) {
    console.error('[mailplatform/domains] listDomains failed -', causeOf(e));
    throw new Error(causeOf(e));
  }
}

export async function getDomain(orgId: UUID, id: string): Promise<DomainRow | null> {
  await ensureDomainSchema();
  if (!id) return null;
  try {
    const r = await db.execute(sql`${domainSelect(orgId)} AND d.id = ${id} LIMIT 1`);
    const row = rows(r)[0];
    return row ? toDomainRow(row) : null;
  } catch (e: any) {
    console.error('[mailplatform/domains] getDomain failed -', causeOf(e));
    return null;
  }
}

/** Verified domains an address may legitimately be created on. */
export async function verifiedDomainNames(orgId: UUID): Promise<string[]> {
  const all = await listDomains(orgId);
  return all.filter((d) => d.status === 'verified').map((d) => d.domain);
}

export async function addDomain(
  ctx: Ctx,
  input: { domain: string; purpose?: 'sending' | 'receiving' | 'both' },
): Promise<Result<DomainRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();

  const domain = normalizeDomain(input.domain);
  if (!isValidDomain(domain)) {
    return fail('"' + input.domain + '" is not a valid domain name. Enter it without http:// and without a trailing slash, for example mail.example.com.', 'invalid_domain');
  }
  const purpose = input.purpose || 'both';

  try {
    // The unique index is on (org_id, lower(domain)) WHERE deleted_at IS NULL, so a duplicate is
    // caught by the database rather than by a read-then-write race between two admins.
    const existing = rows(await db.execute(sql`
      SELECT id, status FROM mp_domains WHERE org_id = ${ctx.principal.orgId} AND lower(domain) = ${domain} AND deleted_at IS NULL LIMIT 1`));
    if (existing.length > 0) {
      return fail('This organization has already added ' + domain + '. Open it to continue setting it up.', 'duplicate_domain');
    }
    // The same domain in ANOTHER organization is not this caller's business, but it is a genuine
    // conflict for receiving: two tenants cannot both have mail for one domain delivered to them.
    // Reported without naming the other tenant.
    const elsewhere = rows(await db.execute(sql`
      SELECT id FROM mp_domains WHERE lower(domain) = ${domain} AND org_id <> ${ctx.principal.orgId} AND deleted_at IS NULL AND status = 'verified' LIMIT 1`));
    if (elsewhere.length > 0) {
      return fail('This domain is already verified on another account. If it belongs to you, remove it there first, or contact support.', 'claimed_elsewhere');
    }

    const token = randomBytes(16).toString('hex');
    const inserted = rows(await db.execute(sql`
      INSERT INTO mp_domains (org_id, domain, status, purpose, verification_token)
      VALUES (${ctx.principal.orgId}, ${domain}, 'pending', ${purpose}, ${token})
      RETURNING *`));
    if (inserted.length === 0) return fail('The domain could not be created.', 'insert_failed');

    // The sending authorisation row is created DISABLED. Adding a domain must never, by itself,
    // permit mail to leave as that domain.
    await db.execute(sql`
      INSERT INTO mp_sending_domains (org_id, domain_id, pool, is_enabled)
      VALUES (${ctx.principal.orgId}, ${inserted[0].id}, 'default', false)
      ON CONFLICT (domain_id, pool) DO NOTHING`);

    await audit(ctx, 'domain.add', { type: 'domain', id: inserted[0].id }, { domain, purpose });
    const created = await getDomain(ctx.principal.orgId, inserted[0].id);
    return created ? done(created) : fail('The domain was created but could not be read back.', 'read_back_failed');
  } catch (e: any) {
    const reason = causeOf(e);
    console.error('[mailplatform/domains] addDomain failed -', reason);
    if (/duplicate key/i.test(reason)) return fail('This domain has already been added.', 'duplicate_domain');
    return fail(reason, 'db_error');
  }
}

export async function updateDomainPurpose(ctx: Ctx, id: string, purpose: 'sending' | 'receiving' | 'both'): Promise<Result<DomainRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_domains SET purpose = ${purpose}, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING id`));
    if (r.length === 0) return fail('Domain not found.', 'not_found');
    await audit(ctx, 'domain.purpose', { type: 'domain', id }, { purpose });
    const updated = await getDomain(ctx.principal.orgId, id);
    return updated ? done(updated) : fail('Domain not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/**
 * Suspend or resume a domain.
 *
 * Suspension sets the stored status to `disabled` AND disables sending in the same act. Leaving the
 * sending flag on while the domain reads SUSPENDED on screen is exactly the sort of split state
 * that produces "we suspended it and it kept sending".
 */
export async function setDomainSuspended(ctx: Ctx, id: string, suspended: boolean): Promise<Result<DomainRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const current = await getDomain(ctx.principal.orgId, id);
  if (!current) return fail('Domain not found.', 'not_found');
  try {
    if (suspended) {
      await db.execute(sql`UPDATE mp_domains SET status = 'disabled', updated_at = NOW() WHERE id = ${id} AND org_id = ${ctx.principal.orgId}`);
      await db.execute(sql`UPDATE mp_sending_domains SET is_enabled = false, updated_at = NOW() WHERE domain_id = ${id} AND org_id = ${ctx.principal.orgId}`);
    } else {
      // Resuming returns it to whatever the last verification said, not to `verified` on faith.
      const next: StoredDomainStatus = current.ownershipVerified ? 'verified' : 'pending';
      await db.execute(sql`UPDATE mp_domains SET status = ${next}, updated_at = NOW() WHERE id = ${id} AND org_id = ${ctx.principal.orgId}`);
    }
    await audit(ctx, suspended ? 'domain.suspend' : 'domain.resume', { type: 'domain', id }, { domain: current.domain });
    const updated = await getDomain(ctx.principal.orgId, id);
    return updated ? done(updated) : fail('Domain not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/** Turn sending on or off. Refused unless the domain is verified and actually ready to send. */
export async function setSendingEnabled(ctx: Ctx, id: string, enabled: boolean): Promise<Result<DomainRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const current = await getDomain(ctx.principal.orgId, id);
  if (!current) return fail('Domain not found.', 'not_found');
  if (enabled) {
    if (current.status !== 'verified') return fail('This domain is not verified yet, so it cannot be activated for sending.', 'not_verified');
    if (!current.sendingReady) {
      return fail('The last DNS check did not confirm that this domain can send: SPF must authorise this platform and a DKIM key must be published. Run the checks again once your DNS has updated.', 'not_sending_ready');
    }
  }
  try {
    await db.execute(sql`
      INSERT INTO mp_sending_domains (org_id, domain_id, pool, is_enabled)
      VALUES (${ctx.principal.orgId}, ${id}, 'default', ${enabled})
      ON CONFLICT (domain_id, pool) DO UPDATE SET is_enabled = ${enabled}, updated_at = NOW()`);
    await audit(ctx, enabled ? 'domain.activate' : 'domain.deactivate', { type: 'domain', id }, { domain: current.domain });
    const updated = await getDomain(ctx.principal.orgId, id);
    return updated ? done(updated) : fail('Domain not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/**
 * Remove a domain.
 *
 * Soft delete, and refused while anything still depends on it. A hard delete would cascade to the
 * DKIM keys and sending identities, and the first symptom would be outbound mail failing to sign
 * with no record of what the selector used to be.
 */
export async function removeDomain(ctx: Ctx, id: string): Promise<Result<{ removed: true }>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const current = await getDomain(ctx.principal.orgId, id);
  if (!current) return fail('Domain not found.', 'not_found');
  try {
    const deps = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM mp_sending_identities WHERE domain_id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL) AS identities,
        (SELECT COUNT(*)::int FROM mp_mailboxes WHERE org_id = ${ctx.principal.orgId} AND deleted_at IS NULL
           AND lower(primary_address) LIKE ${'%@' + current.domain}) AS mailboxes`))[0] || {};
    if (Number(deps.identities) > 0 || Number(deps.mailboxes) > 0) {
      return fail(
        'This domain still has ' + Number(deps.mailboxes || 0) + ' mailbox(es) and ' + Number(deps.identities || 0) + ' sending identity(ies) on it. Remove those first — deleting the domain underneath them would leave mail that cannot be delivered or signed.',
        'has_dependents',
      );
    }
    await db.execute(sql`UPDATE mp_domains SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${id} AND org_id = ${ctx.principal.orgId}`);
    await db.execute(sql`UPDATE mp_sending_domains SET is_enabled = false, deleted_at = NOW() WHERE domain_id = ${id} AND org_id = ${ctx.principal.orgId}`);
    await audit(ctx, 'domain.remove', { type: 'domain', id }, { domain: current.domain });
    return done({ removed: true });
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

// ---------------------------------------------------------------------------
// Domain settings
// ---------------------------------------------------------------------------

export interface DomainSettingsRow {
  domainId: UUID;
  trackingDomain: string | null;
  openTracking: boolean;
  clickTracking: boolean;
  dmarcPolicy: 'none' | 'quarantine' | 'reject' | null;
  customReturnPath: string | null;
  bounceAddress: string | null;
  maxSendRatePerHour: number | null;
}

export async function getDomainSettings(orgId: UUID, domainId: string): Promise<DomainSettingsRow | null> {
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`SELECT * FROM mp_domain_settings WHERE domain_id = ${domainId} AND org_id = ${orgId} LIMIT 1`));
    if (r.length === 0) return null;
    const s = r[0];
    return {
      domainId: s.domain_id,
      trackingDomain: s.tracking_domain,
      openTracking: s.open_tracking === true,
      clickTracking: s.click_tracking === true,
      dmarcPolicy: s.dmarc_policy || null,
      customReturnPath: s.custom_return_path,
      bounceAddress: s.bounce_address,
      maxSendRatePerHour: s.max_send_rate_per_hour,
    };
  } catch (e: any) {
    console.error('[mailplatform/domains] getDomainSettings failed -', causeOf(e));
    return null;
  }
}

export async function saveDomainSettings(
  ctx: Ctx,
  domainId: string,
  patch: Partial<Omit<DomainSettingsRow, 'domainId'>>,
): Promise<Result<DomainSettingsRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const domain = await getDomain(ctx.principal.orgId, domainId);
  if (!domain) return fail('Domain not found.', 'not_found');
  const before = await getDomainSettings(ctx.principal.orgId, domainId);
  try {
    await db.execute(sql`
      INSERT INTO mp_domain_settings (domain_id, org_id, tracking_domain, open_tracking, click_tracking, dmarc_policy, custom_return_path, bounce_address, max_send_rate_per_hour)
      VALUES (${domainId}, ${ctx.principal.orgId}, ${patch.trackingDomain ?? before?.trackingDomain ?? null},
              ${patch.openTracking ?? before?.openTracking ?? false}, ${patch.clickTracking ?? before?.clickTracking ?? false},
              ${patch.dmarcPolicy ?? before?.dmarcPolicy ?? null}, ${patch.customReturnPath ?? before?.customReturnPath ?? null},
              ${patch.bounceAddress ?? before?.bounceAddress ?? null}, ${patch.maxSendRatePerHour ?? before?.maxSendRatePerHour ?? null})
      ON CONFLICT (domain_id) DO UPDATE SET
        tracking_domain = EXCLUDED.tracking_domain, open_tracking = EXCLUDED.open_tracking,
        click_tracking = EXCLUDED.click_tracking, dmarc_policy = EXCLUDED.dmarc_policy,
        custom_return_path = EXCLUDED.custom_return_path, bounce_address = EXCLUDED.bounce_address,
        max_send_rate_per_hour = EXCLUDED.max_send_rate_per_hour, updated_at = NOW()`);
    // The DMARC policy recorded here is an INTENTION, not an effect: publishing it is the
    // customer's act at their DNS host. The audit entry says which it was.
    await audit(ctx, 'domain.settings', { type: 'domain', id: domainId }, {
      domain: domain.domain,
      before: before ? { dmarcPolicy: before.dmarcPolicy, trackingDomain: before.trackingDomain } : null,
      after: { dmarcPolicy: patch.dmarcPolicy ?? before?.dmarcPolicy ?? null, trackingDomain: patch.trackingDomain ?? before?.trackingDomain ?? null },
      note: 'intended configuration; DNS is published by the domain owner',
    });
    const saved = await getDomainSettings(ctx.principal.orgId, domainId);
    return saved ? done(saved) : fail('Settings saved but could not be read back.', 'read_back_failed');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

// ---------------------------------------------------------------------------
// Health snapshots
// ---------------------------------------------------------------------------

/** Persist a health run: the five constrained check types as rows, the whole run as a snapshot. */
export async function recordHealth(ctx: Ctx, domainId: string, health: DomainHealth): Promise<void> {
  await ensureDomainSchema();
  try {
    await db.execute(sql`
      INSERT INTO mp_domain_health (domain_id, org_id, checked_at, ownership_verified, sending_ready, receiving_ready, payload)
      VALUES (${domainId}, ${ctx.principal.orgId}, ${health.checkedAt}, ${health.ownershipVerified}, ${health.sendingReady}, ${health.receivingReady}, ${JSON.stringify(health)}::jsonb)
      ON CONFLICT (domain_id) DO UPDATE SET
        checked_at = EXCLUDED.checked_at, ownership_verified = EXCLUDED.ownership_verified,
        sending_ready = EXCLUDED.sending_ready, receiving_ready = EXCLUDED.receiving_ready,
        payload = EXCLUDED.payload`);

    // mp_domain_verifications accepts exactly five check types and two outcomes. `warn` is stored
    // as `pass` (the record IS published) and `unknown` is stored as `pending` (we did not find
    // out), which is what those two values mean there. Nothing is invented to fit the constraint.
    for (const c of health.checks) {
      if (!['ownership', 'spf', 'dkim', 'dmarc', 'mx'].includes(c.type)) continue;
      const status = c.status === 'pass' || c.status === 'warn' ? 'pass' : c.status === 'unknown' ? 'pending' : 'fail';
      await db.execute(sql`
        INSERT INTO mp_domain_verifications (org_id, domain_id, check_type, status, expected, observed, detail, checked_at)
        VALUES (${ctx.principal.orgId}, ${domainId}, ${c.type}, ${status}, ${c.expected}, ${c.observed}, ${c.detail}, ${health.checkedAt})`);
    }
  } catch (e: any) {
    console.error('[mailplatform/domains] recordHealth failed -', causeOf(e));
  }
}

export async function latestHealth(orgId: UUID, domainId: string): Promise<DomainHealth | null> {
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`SELECT payload FROM mp_domain_health WHERE domain_id = ${domainId} AND org_id = ${orgId} LIMIT 1`));
    const p = r[0]?.payload;
    if (!p) return null;
    return typeof p === 'string' ? JSON.parse(p) : p;
  } catch (e: any) {
    console.error('[mailplatform/domains] latestHealth failed -', causeOf(e));
    return null;
  }
}

/** Apply the verification outcome to the stored status. Never promotes on an unchecked run. */
export async function applyHealthToStatus(ctx: Ctx, domainId: string, health: DomainHealth): Promise<void> {
  await ensureDomainSchema();
  const next = health.suggestedStatus;
  try {
    const current = rows(await db.execute(sql`SELECT status FROM mp_domains WHERE id = ${domainId} AND org_id = ${ctx.principal.orgId} LIMIT 1`))[0];
    if (!current) return;
    // A suspended domain stays suspended: a background check must never un-suspend something an
    // administrator switched off.
    if (current.status === 'disabled') return;
    // `verifying` is never written over a domain that is already verified. A single failed lookup
    // during an outage would otherwise walk a working domain backwards.
    if (next === 'verifying' && current.status === 'verified') return;
    await db.execute(sql`
      UPDATE mp_domains SET status = ${next}, verified_at = ${health.ownershipVerified ? health.checkedAt : null}, updated_at = NOW()
      WHERE id = ${domainId} AND org_id = ${ctx.principal.orgId}`);
    // Losing verification withdraws permission to send in the same act.
    if (!health.ownershipVerified) {
      await db.execute(sql`UPDATE mp_sending_domains SET is_enabled = false, updated_at = NOW() WHERE domain_id = ${domainId} AND org_id = ${ctx.principal.orgId} AND is_enabled = true`);
    }
  } catch (e: any) {
    console.error('[mailplatform/domains] applyHealthToStatus failed -', causeOf(e));
  }
}

// ---------------------------------------------------------------------------
// DKIM keys
// ---------------------------------------------------------------------------

export interface DkimKeyRow {
  id: UUID;
  domainId: UUID;
  selector: string;
  algorithm: DkimAlgorithm;
  keySize: number | null;
  /** The PUBLIC key. There is no field on this type the private key could travel in. */
  publicKey: string;
  privateKeyRef: string | null;
  status: 'pending' | 'active' | 'rotating' | 'retired';
  activatedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

function toDkimRow(r: any): DkimKeyRow {
  return {
    id: r.id,
    domainId: r.domain_id,
    selector: r.selector,
    algorithm: r.algorithm,
    keySize: r.key_size,
    publicKey: r.public_key,
    privateKeyRef: r.private_key_ref,
    status: r.status,
    activatedAt: r.activated_at ? new Date(r.activated_at).toISOString() : null,
    retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export async function listDkimKeys(orgId: UUID, domainId: string): Promise<DkimKeyRow[]> {
  await ensureDomainSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mp_dkim_keys WHERE domain_id = ${domainId} AND org_id = ${orgId}
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'rotating' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, created_at DESC`);
    return rows(r).map(toDkimRow);
  } catch (e: any) {
    console.error('[mailplatform/domains] listDkimKeys failed -', causeOf(e));
    return [];
  }
}

/**
 * Generate a key pair and store the private half encrypted.
 *
 * The encryption is the repository's existing envelope scheme: key material comes from an
 * environment variable and only the ciphertext is in Postgres, so a database dump does not contain
 * a signing key. If that key material is not configured the generation is REFUSED rather than
 * falling back to plaintext — a DKIM private key sitting readable in a column is a forged-mail
 * capability for anyone who can run one SELECT.
 */
export async function generateDkimKey(
  ctx: Ctx,
  domainId: string,
  opts: { algorithm?: DkimAlgorithm; keySize?: number; selector?: string } = {},
): Promise<Result<DkimKeyRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const domain = await getDomain(ctx.principal.orgId, domainId);
  if (!domain) return fail('Domain not found.', 'not_found');

  const existing = await listDkimKeys(ctx.principal.orgId, domainId);
  const selector = opts.selector || nextSelector(existing.map((k) => k.selector));
  if (!isValidSelector(selector)) return fail('"' + selector + '" is not a valid DKIM selector. Use letters, digits and hyphens.', 'invalid_selector');
  if (existing.some((k) => k.selector === selector)) {
    return fail('Selector "' + selector + '" already exists on this domain. Generating a new key at an existing selector would invalidate mail already signed with it.', 'selector_taken');
  }

  let material;
  try {
    material = generateDkimKeyPair({ selector, domain: domain.domain, algorithm: opts.algorithm, keySize: opts.keySize });
  } catch (e: any) {
    return fail(String(e?.message || 'key generation failed'), 'keygen_failed');
  }

  // Encrypt BEFORE the insert, so a missing encryption key cannot leave a half-created key row.
  let envelope: unknown;
  try {
    const { encryptField } = await import('@/lib/crypto');
    envelope = encryptField(material.privateKeyPem, 'mp_dkim:' + domainId + ':' + selector);
  } catch (e: any) {
    console.error('[mailplatform/domains] DKIM private key could not be encrypted -', causeOf(e));
    return fail(
      'The DKIM private key cannot be stored because encryption at rest is not configured on this deployment. Set DATA_ENCRYPTION_KEY_k1 to a 32-byte base64 value (and ACTIVE_DATA_KEY_ID if you use a different key id), then try again. The key was NOT saved in plaintext.',
      'encryption_unavailable',
    );
  }

  try {
    const secret = rows(await db.execute(sql`
      INSERT INTO mp_secrets (org_id, purpose, envelope)
      VALUES (${ctx.principal.orgId}, 'dkim-private-key', ${JSON.stringify(envelope)}::jsonb) RETURNING id`))[0];
    const ref = 'mp_secret:' + secret.id;

    const inserted = rows(await db.execute(sql`
      INSERT INTO mp_dkim_keys (org_id, domain_id, selector, algorithm, key_size, public_key, private_key_ref, status)
      VALUES (${ctx.principal.orgId}, ${domainId}, ${selector}, ${material.algorithm}, ${material.keySize}, ${material.publicKey}, ${ref}, 'pending')
      RETURNING *`));
    if (inserted.length === 0) return fail('The key could not be saved.', 'insert_failed');

    if (!domain.dkimSelector) {
      await db.execute(sql`UPDATE mp_domains SET dkim_selector = ${selector}, updated_at = NOW() WHERE id = ${domainId} AND org_id = ${ctx.principal.orgId}`);
    }
    // The audit entry records the PUBLIC key and the selector. Never the private half, and never
    // the secret's plaintext — an audit log is one of the places people export freely.
    await audit(ctx, 'dkim.generate', { type: 'dkim_key', id: inserted[0].id }, {
      domain: domain.domain, selector, algorithm: material.algorithm, keySize: material.keySize,
    });
    return done(toDkimRow(inserted[0]));
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/**
 * Make a key the signing key.
 *
 * The previous active key becomes `rotating`, not `retired`: mail signed with it is still in flight
 * and its DNS record must stay published until that mail has been delivered and verified.
 */
export async function activateDkimKey(ctx: Ctx, domainId: string, keyId: string): Promise<Result<DkimKeyRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const keys = await listDkimKeys(ctx.principal.orgId, domainId);
  const target = keys.find((k) => k.id === keyId);
  if (!target) return fail('Key not found.', 'not_found');
  if (target.status === 'retired') return fail('A retired key cannot be reactivated. Generate a new one.', 'retired');
  try {
    await db.execute(sql`
      UPDATE mp_dkim_keys SET status = 'rotating', updated_at = NOW()
      WHERE domain_id = ${domainId} AND org_id = ${ctx.principal.orgId} AND status = 'active' AND id <> ${keyId}`);
    await db.execute(sql`
      UPDATE mp_dkim_keys SET status = 'active', activated_at = COALESCE(activated_at, NOW()), updated_at = NOW()
      WHERE id = ${keyId} AND org_id = ${ctx.principal.orgId}`);
    await db.execute(sql`UPDATE mp_domains SET dkim_selector = ${target.selector}, updated_at = NOW() WHERE id = ${domainId} AND org_id = ${ctx.principal.orgId}`);
    await audit(ctx, 'dkim.activate', { type: 'dkim_key', id: keyId }, { selector: target.selector });
    const after = (await listDkimKeys(ctx.principal.orgId, domainId)).find((k) => k.id === keyId);
    return after ? done(after) : fail('Key not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/** Retire a key and destroy its stored private half. The DNS record may then be removed. */
export async function retireDkimKey(ctx: Ctx, domainId: string, keyId: string): Promise<Result<{ retired: true }>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const keys = await listDkimKeys(ctx.principal.orgId, domainId);
  const target = keys.find((k) => k.id === keyId);
  if (!target) return fail('Key not found.', 'not_found');
  if (target.status === 'active' && keys.filter((k) => k.status === 'active').length <= 1) {
    return fail('This is the only active signing key for the domain. Generate and activate a replacement first, or outbound mail will be sent unsigned.', 'last_active_key');
  }
  try {
    await db.execute(sql`UPDATE mp_dkim_keys SET status = 'retired', retired_at = NOW(), updated_at = NOW() WHERE id = ${keyId} AND org_id = ${ctx.principal.orgId}`);
    if (target.privateKeyRef?.startsWith('mp_secret:')) {
      const secretId = target.privateKeyRef.slice('mp_secret:'.length);
      // The ciphertext is destroyed, not merely unreferenced. A retired signing key that still
      // exists is a signing key.
      await db.execute(sql`
        UPDATE mp_secrets SET envelope = '{}'::jsonb, destroyed_at = NOW()
        WHERE id = ${secretId} AND org_id = ${ctx.principal.orgId}`);
    }
    await audit(ctx, 'dkim.retire', { type: 'dkim_key', id: keyId }, { selector: target.selector });
    return done({ retired: true });
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

/**
 * Resolve a private key for SIGNING. Server-side callers only.
 *
 * There is no API route that calls this and there must never be one. It exists for the MTA signing
 * path, which runs in the same process; the value it returns is a capability to send mail as the
 * customer's domain. Note the org predicate: even here, a key is fetched within a tenant.
 */
export async function resolveDkimPrivateKey(orgId: UUID, keyId: string): Promise<string | null> {
  await ensureDomainSchema();
  try {
    const key = rows(await db.execute(sql`
      SELECT k.private_key_ref, k.selector, k.domain_id FROM mp_dkim_keys k
      WHERE k.id = ${keyId} AND k.org_id = ${orgId} AND k.status IN ('active','rotating','pending') LIMIT 1`))[0];
    if (!key?.private_key_ref?.startsWith('mp_secret:')) return null;
    const secretId = String(key.private_key_ref).slice('mp_secret:'.length);
    const secret = rows(await db.execute(sql`
      SELECT envelope FROM mp_secrets WHERE id = ${secretId} AND org_id = ${orgId} AND destroyed_at IS NULL LIMIT 1`))[0];
    if (!secret?.envelope) return null;
    const { decryptField } = await import('@/lib/crypto');
    const env = typeof secret.envelope === 'string' ? JSON.parse(secret.envelope) : secret.envelope;
    return decryptField(env);
  } catch (e: any) {
    console.error('[mailplatform/domains] resolveDkimPrivateKey failed -', causeOf(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sending identities
// ---------------------------------------------------------------------------

export interface IdentityRow {
  id: UUID;
  domainId: UUID | null;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  purpose: string | null;
  isDefault: boolean;
  isVerified: boolean;
  domain: string | null;
  /** The domain's lifecycle, so a screen can say why an identity cannot send. */
  domainLifecycle: LifecycleState | null;
}

function toIdentityRow(r: any): IdentityRow {
  return {
    id: r.id,
    domainId: r.domain_id,
    fromAddress: r.from_address,
    fromName: r.from_name,
    replyTo: r.reply_to,
    purpose: r.purpose || null,
    isDefault: r.is_default === true,
    isVerified: r.is_verified === true,
    domain: r.domain || null,
    domainLifecycle: r.status ? lifecycleState(r.status, r.sending_enabled === true) : null,
  };
}

export async function listIdentities(orgId: UUID): Promise<IdentityRow[]> {
  await ensureDomainSchema();
  try {
    const r = await db.execute(sql`
      SELECT i.*, d.domain, d.status, sd.is_enabled AS sending_enabled
      FROM mp_sending_identities i
      LEFT JOIN mp_domains d ON d.id = i.domain_id AND d.deleted_at IS NULL
      LEFT JOIN mp_sending_domains sd ON sd.domain_id = d.id AND sd.pool = 'default' AND sd.deleted_at IS NULL
      WHERE i.org_id = ${orgId} AND i.deleted_at IS NULL
      ORDER BY i.is_default DESC, lower(i.from_address) ASC`);
    return rows(r).map(toIdentityRow);
  } catch (e: any) {
    console.error('[mailplatform/domains] listIdentities failed -', causeOf(e));
    return [];
  }
}

export async function createIdentity(
  ctx: Ctx,
  input: { fromAddress: string; fromName?: string | null; replyTo?: string | null; purpose?: string | null; isDefault?: boolean },
): Promise<Result<IdentityRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();

  const address = normalizeAddress(input.fromAddress);
  const domains = await listDomains(ctx.principal.orgId);
  const check = validateMailboxAddress(address, { allowedDomains: domains.map((d) => d.domain) });
  if (!check.ok) return fail(check.errors.join(' '), 'invalid_address');

  const domainName = address.slice(address.lastIndexOf('@') + 1);
  const domain = domains.find((d) => d.domain === domainName);
  if (!domain) return fail('Add and verify ' + domainName + ' before creating a sending identity on it.', 'domain_missing');
  // An identity on an unverified domain is allowed to EXIST — it is part of setting the domain up —
  // but it is not marked verified, and the send path refuses an unverified identity.
  const isVerified = domain.status === 'verified' && domain.sendingReady;

  if (input.replyTo) {
    const replyCheck = validateMailboxAddress(String(input.replyTo));
    if (!replyCheck.ok) return fail('Reply-To: ' + replyCheck.errors.join(' '), 'invalid_reply_to');
  }

  try {
    if (input.isDefault) {
      // The partial unique index permits exactly one default per org, so the old one is cleared
      // first or the insert fails on a constraint the user cannot see.
      await db.execute(sql`UPDATE mp_sending_identities SET is_default = false, updated_at = NOW() WHERE org_id = ${ctx.principal.orgId} AND is_default = true AND deleted_at IS NULL`);
    }
    const inserted = rows(await db.execute(sql`
      INSERT INTO mp_sending_identities (org_id, domain_id, from_address, from_name, reply_to, purpose, is_default, is_verified, verified_at)
      VALUES (${ctx.principal.orgId}, ${domain.id}, ${address}, ${input.fromName || null}, ${input.replyTo ? normalizeAddress(input.replyTo) : null},
              ${input.purpose || null}, ${input.isDefault === true}, ${isVerified}, ${isVerified ? new Date().toISOString() : null})
      RETURNING *`));
    if (inserted.length === 0) return fail('The identity could not be created.', 'insert_failed');
    await audit(ctx, 'identity.create', { type: 'identity', id: inserted[0].id }, { fromAddress: address, purpose: input.purpose || null });
    const all = await listIdentities(ctx.principal.orgId);
    const created = all.find((i) => i.id === inserted[0].id);
    return created ? done(created) : fail('Created but could not be read back.', 'read_back_failed');
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key/i.test(reason)) return fail('An identity for ' + address + ' already exists.', 'duplicate');
    return fail(reason, 'db_error');
  }
}

export async function updateIdentity(
  ctx: Ctx,
  id: string,
  patch: { fromName?: string | null; replyTo?: string | null; purpose?: string | null; isDefault?: boolean },
): Promise<Result<IdentityRow>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  // Read first, then write plain values. The alternative — conditional SQL fragments interpolated
  // into the UPDATE — reads badly and, more to the point, hides the tenant predicate from anything
  // that scans this file for one.
  const current = (await listIdentities(ctx.principal.orgId)).find((i) => i.id === id);
  if (!current) return fail('Identity not found.', 'not_found');
  const fromName = patch.fromName === undefined ? current.fromName : patch.fromName;
  const replyTo = patch.replyTo === undefined ? current.replyTo : patch.replyTo ? normalizeAddress(patch.replyTo) : null;
  const purpose = patch.purpose === undefined ? current.purpose : patch.purpose;
  const isDefault = patch.isDefault === undefined ? current.isDefault : patch.isDefault;
  try {
    if (isDefault === true) {
      await db.execute(sql`UPDATE mp_sending_identities SET is_default = false, updated_at = NOW() WHERE org_id = ${ctx.principal.orgId} AND is_default = true AND deleted_at IS NULL AND id <> ${id}`);
    }
    const r = rows(await db.execute(sql`
      UPDATE mp_sending_identities
      SET from_name = ${fromName}, reply_to = ${replyTo}, purpose = ${purpose}, is_default = ${isDefault}, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING id`));
    if (r.length === 0) return fail('Identity not found.', 'not_found');
    await audit(ctx, 'identity.update', { type: 'identity', id }, patch as Record<string, unknown>);
    const found = (await listIdentities(ctx.principal.orgId)).find((i) => i.id === id);
    return found ? done(found) : fail('Identity not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

export async function deleteIdentity(ctx: Ctx, id: string): Promise<Result<{ removed: true }>> {
  const denied = requires(ctx, 'domains.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_sending_identities SET deleted_at = NOW(), is_default = false, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING from_address`));
    if (r.length === 0) return fail('Identity not found.', 'not_found');
    await audit(ctx, 'identity.delete', { type: 'identity', id }, { fromAddress: r[0].from_address });
    return done({ removed: true });
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export interface MailboxRow {
  id: UUID;
  name: string;
  primaryAddress: string;
  kind: 'user' | 'shared' | 'group' | 'system';
  ownerUserId: string | null;
  ownerName: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  status: MailboxStatus;
  createdAt: string;
}

function toMailboxRow(r: any): MailboxRow {
  return {
    id: r.id,
    name: r.name,
    primaryAddress: r.primary_address,
    kind: r.kind,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name || null,
    quotaBytes: r.quota_bytes === null || r.quota_bytes === undefined ? null : Number(r.quota_bytes),
    usedBytes: Number(r.used_bytes || 0),
    status: (r.deleted_at ? 'deleted' : (r.status || (r.is_active ? 'active' : 'disabled'))) as MailboxStatus,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export async function listMailboxes(orgId: UUID, opts: { includeDeleted?: boolean } = {}): Promise<MailboxRow[]> {
  await ensureDomainSchema();
  try {
    const r = opts.includeDeleted
      ? await db.execute(sql`
          SELECT m.*, u.name AS owner_name FROM mp_mailboxes m LEFT JOIN users u ON u.id = m.owner_user_id
          WHERE m.org_id = ${orgId} ORDER BY lower(m.primary_address) ASC`)
      : await db.execute(sql`
          SELECT m.*, u.name AS owner_name FROM mp_mailboxes m LEFT JOIN users u ON u.id = m.owner_user_id
          WHERE m.org_id = ${orgId} AND m.deleted_at IS NULL ORDER BY lower(m.primary_address) ASC`);
    return rows(r).map(toMailboxRow);
  } catch (e: any) {
    console.error('[mailplatform/domains] listMailboxes failed -', causeOf(e));
    throw new Error(causeOf(e));
  }
}

export async function createMailbox(
  ctx: Ctx,
  input: { address: string; name: string; kind?: 'user' | 'shared' | 'group' | 'system'; ownerUserId?: string | null; quotaBytes?: number | null },
): Promise<Result<MailboxRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();

  const allowed = await verifiedDomainNames(ctx.principal.orgId);
  const check = validateMailboxAddress(input.address, { allowedDomains: allowed });
  if (!check.ok) return fail(check.errors.join(' '), 'invalid_address');
  const address = check.normalized;

  try {
    const clash = rows(await db.execute(sql`
      SELECT 1 FROM mp_mailboxes WHERE lower(primary_address) = ${address} AND deleted_at IS NULL LIMIT 1`));
    if (clash.length > 0) return fail('A mailbox already exists at ' + address + '.', 'duplicate');
    const aliasClash = rows(await db.execute(sql`
      SELECT 1 FROM mp_aliases WHERE lower(source_address) = ${address} AND deleted_at IS NULL AND org_id = ${ctx.principal.orgId} LIMIT 1`));
    if (aliasClash.length > 0) return fail('An alias already routes ' + address + '. Remove the alias first, or the mailbox would never receive the mail sent to it.', 'alias_conflict');

    const inserted = rows(await db.execute(sql`
      INSERT INTO mp_mailboxes (org_id, kind, owner_user_id, name, primary_address, quota_bytes, is_active, status)
      VALUES (${ctx.principal.orgId}, ${input.kind || 'user'}, ${input.ownerUserId || null}, ${input.name || address},
              ${address}, ${input.quotaBytes ?? null}, true, 'active')
      RETURNING *`));
    if (inserted.length === 0) return fail('The mailbox could not be created.', 'insert_failed');

    // The address row is what links a mailbox to a domain for the rest of the platform.
    const domainRow = rows(await db.execute(sql`
      SELECT id FROM mp_domains WHERE org_id = ${ctx.principal.orgId} AND lower(domain) = ${address.slice(address.lastIndexOf('@') + 1)} AND deleted_at IS NULL LIMIT 1`))[0];
    await db.execute(sql`
      INSERT INTO mp_email_addresses (org_id, mailbox_id, domain_id, address, is_primary, purpose)
      VALUES (${ctx.principal.orgId}, ${inserted[0].id}, ${domainRow?.id || null}, ${address}, true, 'mailbox')
      ON CONFLICT DO NOTHING`);

    await audit(ctx, 'mailbox.create', { type: 'mailbox', id: inserted[0].id }, { address, kind: input.kind || 'user' });
    return done(toMailboxRow(inserted[0]));
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key/i.test(reason)) return fail('A mailbox already exists at that address.', 'duplicate');
    return fail(reason, 'db_error');
  }
}

export async function setMailboxStatus(ctx: Ctx, id: string, status: MailboxStatus): Promise<Result<MailboxRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const all = await listMailboxes(ctx.principal.orgId, { includeDeleted: true });
  const current = all.find((m) => m.id === id);
  if (!current) return fail('Mailbox not found.', 'not_found');

  const verdict = canTransition(current.status, status);
  if (!verdict.ok) return fail(verdict.reason || 'That change is not allowed.', 'invalid_transition');

  try {
    // is_active is kept in step with status so code elsewhere that reads the boolean is not left
    // with a stale answer. `deleted` is a soft delete: the address stays reserved.
    const deletedAt = status === 'deleted' ? new Date().toISOString() : null;
    await db.execute(sql`
      UPDATE mp_mailboxes
      SET status = ${status}, is_active = ${status === 'active'}, deleted_at = ${deletedAt}, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId}`);
    await audit(ctx, 'mailbox.status', { type: 'mailbox', id }, { address: current.primaryAddress, from: current.status, to: status });
    const after = (await listMailboxes(ctx.principal.orgId, { includeDeleted: true })).find((m) => m.id === id);
    return after ? done(after) : fail('Mailbox not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

export async function setMailboxQuota(ctx: Ctx, id: string, quotaBytes: number | null): Promise<Result<MailboxRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_mailboxes SET quota_bytes = ${quotaBytes}, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING primary_address`));
    if (r.length === 0) return fail('Mailbox not found.', 'not_found');
    await audit(ctx, 'mailbox.quota', { type: 'mailbox', id }, { address: r[0].primary_address, quotaBytes });
    const after = (await listMailboxes(ctx.principal.orgId)).find((m) => m.id === id);
    return after ? done(after) : fail('Mailbox not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

export interface MailboxSettingsRow {
  mailboxId: UUID;
  forwardTo: string[];
  forwardKeepCopy: boolean;
  autoReplyEnabled: boolean;
  autoReplySubject: string | null;
  autoReplyBody: string | null;
  autoReplyStartsAt: string | null;
  autoReplyEndsAt: string | null;
  autoReplyIntervalDays: number;
  autoReplyExternal: boolean;
  autoReplyInternal: boolean;
  signatureText: string | null;
  signatureHtml: string | null;
}

export const EMPTY_MAILBOX_SETTINGS = (mailboxId: string): MailboxSettingsRow => ({
  mailboxId, forwardTo: [], forwardKeepCopy: true, autoReplyEnabled: false, autoReplySubject: null,
  autoReplyBody: null, autoReplyStartsAt: null, autoReplyEndsAt: null, autoReplyIntervalDays: 7,
  autoReplyExternal: true, autoReplyInternal: true, signatureText: null, signatureHtml: null,
});

export async function getMailboxSettings(orgId: UUID, mailboxId: string): Promise<MailboxSettingsRow> {
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`SELECT * FROM mp_mailbox_settings WHERE mailbox_id = ${mailboxId} AND org_id = ${orgId} LIMIT 1`))[0];
    if (!r) return EMPTY_MAILBOX_SETTINGS(mailboxId);
    return {
      mailboxId: r.mailbox_id,
      forwardTo: Array.isArray(r.forward_to) ? r.forward_to : [],
      forwardKeepCopy: r.forward_keep_copy !== false,
      autoReplyEnabled: r.auto_reply_enabled === true,
      autoReplySubject: r.auto_reply_subject,
      autoReplyBody: r.auto_reply_body,
      autoReplyStartsAt: r.auto_reply_starts_at ? new Date(r.auto_reply_starts_at).toISOString() : null,
      autoReplyEndsAt: r.auto_reply_ends_at ? new Date(r.auto_reply_ends_at).toISOString() : null,
      autoReplyIntervalDays: Number(r.auto_reply_interval_days ?? 7),
      autoReplyExternal: r.auto_reply_external !== false,
      autoReplyInternal: r.auto_reply_internal !== false,
      signatureText: r.signature_text,
      signatureHtml: r.signature_html,
    };
  } catch (e: any) {
    console.error('[mailplatform/domains] getMailboxSettings failed -', causeOf(e));
    return EMPTY_MAILBOX_SETTINGS(mailboxId);
  }
}

export async function saveMailboxSettings(
  ctx: Ctx,
  mailboxId: string,
  patch: Partial<Omit<MailboxSettingsRow, 'mailboxId'>>,
): Promise<Result<MailboxSettingsRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const boxes = await listMailboxes(ctx.principal.orgId);
  const box = boxes.find((m) => m.id === mailboxId);
  if (!box) return fail('Mailbox not found.', 'not_found');
  const before = await getMailboxSettings(ctx.principal.orgId, mailboxId);
  const next = { ...before, ...patch };

  // Forwarding is part of the same graph as aliases, so the same loop check applies. A mailbox
  // forwarding to an address that aliases back to it is the identical cycle with a different table
  // name, and checking only the alias form would miss half of them.
  if (patch.forwardTo) {
    const graph = await deliveryGraph(ctx.principal.orgId);
    const withForward = {
      ...graph,
      mailboxes: graph.mailboxes.map((m) =>
        normalizeAddress(m.address) === normalizeAddress(box.primaryAddress)
          ? { ...m, forwardTo: next.forwardTo.map(normalizeAddress), keepCopy: next.forwardKeepCopy }
          : m),
    };
    const { expand } = await import('./aliases');
    const result = expand(box.primaryAddress, withForward);
    if (result.loops.length > 0) {
      return fail('This forwarding rule would create a delivery loop: ' + result.loops[0].join(' -> ') + '.', 'loop');
    }
    for (const t of next.forwardTo) {
      const v = validateMailboxAddress(t);
      if (!v.ok) return fail('Forwarding address: ' + v.errors.join(' '), 'invalid_address');
    }
  }

  try {
    await db.execute(sql`
      INSERT INTO mp_mailbox_settings (mailbox_id, org_id, forward_to, forward_keep_copy, auto_reply_enabled, auto_reply_subject,
        auto_reply_body, auto_reply_starts_at, auto_reply_ends_at, auto_reply_interval_days, auto_reply_external,
        auto_reply_internal, signature_text, signature_html)
      VALUES (${mailboxId}, ${ctx.principal.orgId}, ${next.forwardTo}, ${next.forwardKeepCopy}, ${next.autoReplyEnabled},
        ${next.autoReplySubject}, ${next.autoReplyBody}, ${next.autoReplyStartsAt}, ${next.autoReplyEndsAt},
        ${next.autoReplyIntervalDays}, ${next.autoReplyExternal}, ${next.autoReplyInternal},
        ${next.signatureText}, ${next.signatureHtml})
      ON CONFLICT (mailbox_id) DO UPDATE SET
        forward_to = EXCLUDED.forward_to, forward_keep_copy = EXCLUDED.forward_keep_copy,
        auto_reply_enabled = EXCLUDED.auto_reply_enabled, auto_reply_subject = EXCLUDED.auto_reply_subject,
        auto_reply_body = EXCLUDED.auto_reply_body, auto_reply_starts_at = EXCLUDED.auto_reply_starts_at,
        auto_reply_ends_at = EXCLUDED.auto_reply_ends_at, auto_reply_interval_days = EXCLUDED.auto_reply_interval_days,
        auto_reply_external = EXCLUDED.auto_reply_external, auto_reply_internal = EXCLUDED.auto_reply_internal,
        signature_text = EXCLUDED.signature_text, signature_html = EXCLUDED.signature_html, updated_at = NOW()`);
    await audit(ctx, 'mailbox.settings', { type: 'mailbox', id: mailboxId }, {
      address: box.primaryAddress,
      forwarding: next.forwardTo.length > 0,
      autoReply: next.autoReplyEnabled,
    });
    return done(await getMailboxSettings(ctx.principal.orgId, mailboxId));
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export interface AliasRow {
  id: UUID;
  sourceAddress: string;
  targets: string[];
  isActive: boolean;
  createdAt: string;
}

export async function listAliases(orgId: UUID): Promise<AliasRow[]> {
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      SELECT a.id, a.source_address, a.destination_address, a.is_active, a.created_at,
             COALESCE(array_agg(t.destination_address) FILTER (WHERE t.destination_address IS NOT NULL), '{}') AS extra
      FROM mp_aliases a
      LEFT JOIN mp_alias_targets t ON t.alias_id = a.id
      WHERE a.org_id = ${orgId} AND a.deleted_at IS NULL
      GROUP BY a.id ORDER BY lower(a.source_address) ASC`));
    return r.map((row) => {
      const extra: string[] = Array.isArray(row.extra) ? row.extra : [];
      const targets = Array.from(new Set([row.destination_address, ...extra].map(normalizeAddress).filter(Boolean)));
      return {
        id: row.id,
        sourceAddress: row.source_address,
        targets,
        isActive: row.is_active === true,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
      };
    });
  } catch (e: any) {
    console.error('[mailplatform/domains] listAliases failed -', causeOf(e));
    throw new Error(causeOf(e));
  }
}

/** The whole routing graph for one organization: what expand() and the loop check need. */
export async function deliveryGraph(orgId: UUID): Promise<DeliveryGraph> {
  const [aliases, mailboxes] = await Promise.all([listAliases(orgId), listMailboxes(orgId)]);
  let settings: any[] = [];
  try {
    settings = rows(await db.execute(sql`SELECT mailbox_id, forward_to, forward_keep_copy FROM mp_mailbox_settings WHERE org_id = ${orgId}`));
  } catch (e: any) {
    // Forwarding that cannot be read must not be treated as absent: the loop check would then pass
    // a rule that closes a cycle through a forward we could not see. Say so and refuse upstream.
    console.error('[mailplatform/domains] forwarding read failed -', causeOf(e));
    throw new Error('Forwarding rules could not be read, so a delivery loop could not be ruled out: ' + causeOf(e));
  }
  const byId = new Map(settings.map((s) => [s.mailbox_id, s]));
  return {
    aliases: aliases.map((a): AliasEdge => ({ source: a.sourceAddress, targets: a.targets, isActive: a.isActive })),
    mailboxes: mailboxes.map((m) => {
      const s = byId.get(m.id);
      return {
        address: m.primaryAddress,
        status: m.status as MailboxDeliveryStatus,
        forwardTo: Array.isArray(s?.forward_to) ? s.forward_to : [],
        keepCopy: s ? s.forward_keep_copy !== false : true,
      };
    }),
  };
}

export async function createAlias(
  ctx: Ctx,
  input: { source: string; targets: string[]; allowExternal?: boolean },
): Promise<Result<AliasRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();

  const source = normalizeAddress(input.source);
  const targets = Array.from(new Set((input.targets || []).map(normalizeAddress).filter(Boolean)));
  const orgDomains = await verifiedDomainNames(ctx.principal.orgId);

  let graph: DeliveryGraph;
  try {
    graph = await deliveryGraph(ctx.principal.orgId);
  } catch (e: any) {
    return fail(String(e?.message || e), 'graph_unreadable');
  }

  const validation = validateAlias({ source, targets, isActive: true }, graph, {
    orgDomains,
    allowExternal: input.allowExternal === true,
  });
  if (!validation.ok) return fail(validation.errors.join(' '), 'invalid_alias');

  try {
    const clash = rows(await db.execute(sql`
      SELECT 1 FROM mp_mailboxes WHERE lower(primary_address) = ${source} AND deleted_at IS NULL LIMIT 1`));
    if (clash.length > 0) return fail(source + ' is already a mailbox. An alias with the same address would never be reached.', 'mailbox_conflict');

    const inserted = rows(await db.execute(sql`
      INSERT INTO mp_aliases (org_id, source_address, destination_address, is_active)
      VALUES (${ctx.principal.orgId}, ${source}, ${targets[0]}, true) RETURNING *`));
    if (inserted.length === 0) return fail('The alias could not be created.', 'insert_failed');
    for (const t of targets) {
      await db.execute(sql`
        INSERT INTO mp_alias_targets (org_id, alias_id, destination_address)
        VALUES (${ctx.principal.orgId}, ${inserted[0].id}, ${t}) ON CONFLICT DO NOTHING`);
    }
    await audit(ctx, 'alias.create', { type: 'alias', id: inserted[0].id }, { source, targets, external: validation.externalTargets });
    const all = await listAliases(ctx.principal.orgId);
    const created = all.find((a) => a.id === inserted[0].id);
    return created ? done(created) : fail('Created but could not be read back.', 'read_back_failed');
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key/i.test(reason)) return fail('An alias for ' + source + ' already exists.', 'duplicate');
    if (/mp_alias_not_self_chk/i.test(reason)) return fail('An alias cannot point at itself.', 'self_alias');
    return fail(reason, 'db_error');
  }
}

export async function updateAliasTargets(ctx: Ctx, id: string, targets: string[], allowExternal = false): Promise<Result<AliasRow>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  const all = await listAliases(ctx.principal.orgId);
  const current = all.find((a) => a.id === id);
  if (!current) return fail('Alias not found.', 'not_found');

  const next = Array.from(new Set((targets || []).map(normalizeAddress).filter(Boolean)));
  let graph: DeliveryGraph;
  try {
    graph = await deliveryGraph(ctx.principal.orgId);
  } catch (e: any) {
    return fail(String(e?.message || e), 'graph_unreadable');
  }
  const validation = validateAlias({ source: current.sourceAddress, targets: next, isActive: true }, graph, {
    orgDomains: await verifiedDomainNames(ctx.principal.orgId),
    allowExternal,
  });
  if (!validation.ok) return fail(validation.errors.join(' '), 'invalid_alias');

  try {
    await db.execute(sql`UPDATE mp_aliases SET destination_address = ${next[0]}, updated_at = NOW() WHERE id = ${id} AND org_id = ${ctx.principal.orgId}`);
    await db.execute(sql`DELETE FROM mp_alias_targets WHERE alias_id = ${id} AND org_id = ${ctx.principal.orgId}`);
    for (const t of next) {
      await db.execute(sql`INSERT INTO mp_alias_targets (org_id, alias_id, destination_address) VALUES (${ctx.principal.orgId}, ${id}, ${t}) ON CONFLICT DO NOTHING`);
    }
    await audit(ctx, 'alias.update', { type: 'alias', id }, { source: current.sourceAddress, from: current.targets, to: next });
    const after = (await listAliases(ctx.principal.orgId)).find((a) => a.id === id);
    return after ? done(after) : fail('Alias not found.', 'not_found');
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

export async function setAliasActive(ctx: Ctx, id: string, isActive: boolean): Promise<Result<{ ok: true }>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_aliases SET is_active = ${isActive}, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING source_address`));
    if (r.length === 0) return fail('Alias not found.', 'not_found');
    await audit(ctx, isActive ? 'alias.enable' : 'alias.disable', { type: 'alias', id }, { source: r[0].source_address });
    return done({ ok: true });
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}

export async function deleteAlias(ctx: Ctx, id: string): Promise<Result<{ removed: true }>> {
  const denied = requires(ctx, 'mailbox.manage');
  if (denied) return denied;
  await ensureDomainSchema();
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_aliases SET deleted_at = NOW(), is_active = false, updated_at = NOW()
      WHERE id = ${id} AND org_id = ${ctx.principal.orgId} AND deleted_at IS NULL RETURNING source_address`));
    if (r.length === 0) return fail('Alias not found.', 'not_found');
    await db.execute(sql`DELETE FROM mp_alias_targets WHERE alias_id = ${id} AND org_id = ${ctx.principal.orgId}`);
    await audit(ctx, 'alias.delete', { type: 'alias', id }, { source: r[0].source_address });
    return done({ removed: true });
  } catch (e: any) {
    return fail(causeOf(e), 'db_error');
  }
}
