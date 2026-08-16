// src/lib/mailgov/orgs.ts — ORGANIZATION ADMINISTRATION.
//
// Suspend, restore, and the three finer stops the brief asks for: sending, receiving, campaigns. Plus
// credential rotation and the usage figures an administrator needs before deciding any of it.
//
// THE STOPS ARE SEPARATE ON PURPOSE. "Suspend the organization" is the blunt instrument, and it is
// almost never what an incident actually calls for. A tenant whose campaign is generating complaints
// needs campaigns stopped while their transactional mail keeps flowing — receipts and password
// resets are not the problem, and cutting them off turns a deliverability incident into a support
// incident for people who did nothing. A tenant with a compromised key needs the key rotated, not
// their mail stopped. Four switches, four different mistakes not made.
//
// EVERY WRITE HERE IS PERFORMED THROUGH auditedWrite() BY ITS CALLER, not audited inside. The
// functions do the work and return a result; the route records the intent first and refuses to call
// them if the record cannot be written. Keeping the audit at the boundary means there is one place
// to read to know whether an action is audited, rather than one per function and a hope.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { ensureGovernanceSchema, rows, dbReason, tableExists } from './schema';

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  isActive: boolean;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  campaignsEnabled: boolean;
  dailySendCap: number | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): OrgRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    status: String(r.status || 'active'),
    isActive: r.is_active !== false,
    sendingEnabled: r.sending_enabled !== false,
    receivingEnabled: r.receiving_enabled !== false,
    campaignsEnabled: r.campaigns_enabled !== false,
    dailySendCap: r.daily_send_cap === null || r.daily_send_cap === undefined ? null : Number(r.daily_send_cap),
    suspendedAt: r.suspended_at ? new Date(r.suspended_at).toISOString() : null,
    suspensionReason: r.suspension_reason ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

export async function listOrgs(opts: { orgId?: string | null; q?: string | null; limit?: number } = {}): Promise<ReadResult<OrgRow>> {
  try {
    await ensureGovernanceSchema();
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
    const like = opts.q ? '%' + String(opts.q).toLowerCase().split('%').join('\\%') + '%' : null;
    const r = await db.execute(sql`
      SELECT * FROM mailapi_orgs
       WHERE ${opts.orgId ? sql`id = ${opts.orgId}::uuid` : sql`TRUE`}
         AND ${like ? sql`(LOWER(name) LIKE ${like} OR LOWER(slug) LIKE ${like})` : sql`TRUE`}
       ORDER BY name ASC LIMIT ${limit}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export async function getOrg(orgId: string): Promise<{ ok: boolean; org?: OrgRow; reason?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mailapi_orgs WHERE id = ${orgId}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, reason: 'No such organization.' };
    return { ok: true, org: map(r) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export interface OrgUsage {
  ok: boolean;
  reason?: string;
  members: number;
  domains: number;
  activeKeys: number;
  messages24h: number;
  messages30d: number;
  failed24h: number;
  suppressions: number;
  apiRequests: number;
  campaigns: number | null;
  openSecurityEvents: number;
  lastSendAt: string | null;
}

/**
 * The figures an administrator looks at before suspending anybody.
 *
 * `campaigns: null` means the campaigns table does not exist on this deployment — a state that must
 * not be rendered as zero. Zero campaigns and no campaigns feature are different facts and an
 * administrator making a suspension decision is entitled to know which one they are looking at.
 */
export async function orgUsage(orgId: string): Promise<OrgUsage> {
  const empty: OrgUsage = {
    ok: true, members: 0, domains: 0, activeKeys: 0, messages24h: 0, messages30d: 0, failed24h: 0,
    suppressions: 0, apiRequests: 0, campaigns: null, openSecurityEvents: 0, lastSendAt: null,
  };
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM mailapi_org_members WHERE org_id = ${orgId}::uuid AND removed_at IS NULL) AS members,
        (SELECT COUNT(*)::int FROM mailapi_domains WHERE org_id = ${orgId}::uuid) AS domains,
        (SELECT COUNT(*)::int FROM mailapi_keys WHERE org_id = ${orgId}::uuid AND revoked_at IS NULL) AS active_keys,
        (SELECT COALESCE(SUM(request_count), 0)::bigint FROM mailapi_keys WHERE org_id = ${orgId}::uuid) AS api_requests,
        (SELECT COUNT(*)::int FROM mailapi_messages WHERE org_id = ${orgId}::uuid AND created_at >= now() - interval '24 hours') AS messages_24h,
        (SELECT COUNT(*)::int FROM mailapi_messages WHERE org_id = ${orgId}::uuid AND created_at >= now() - interval '30 days') AS messages_30d,
        (SELECT COUNT(*)::int FROM mailapi_messages WHERE org_id = ${orgId}::uuid AND status = 'failed' AND created_at >= now() - interval '24 hours') AS failed_24h,
        (SELECT COUNT(*)::int FROM mailapi_suppressions WHERE org_id = ${orgId}::uuid) AS suppressions,
        (SELECT COUNT(*)::int FROM mailapi_security_events WHERE org_id = ${orgId}::uuid AND status IN ('new','acknowledged')) AS open_security,
        (SELECT MAX(sent_at) FROM mailapi_messages WHERE org_id = ${orgId}::uuid) AS last_send_at`))[0];

    const out: OrgUsage = {
      ...empty,
      members: Number(r?.members) || 0,
      domains: Number(r?.domains) || 0,
      activeKeys: Number(r?.active_keys) || 0,
      apiRequests: Number(r?.api_requests) || 0,
      messages24h: Number(r?.messages_24h) || 0,
      messages30d: Number(r?.messages_30d) || 0,
      failed24h: Number(r?.failed_24h) || 0,
      suppressions: Number(r?.suppressions) || 0,
      openSecurityEvents: Number(r?.open_security) || 0,
      lastSendAt: r?.last_send_at ? new Date(r.last_send_at).toISOString() : null,
    };

    if (await tableExists('mailapi_campaigns')) {
      try {
        const c = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM mailapi_campaigns WHERE org_id = ${orgId}::uuid`))[0];
        out.campaigns = Number(c?.n) || 0;
      } catch { out.campaigns = null; }
    }
    return out;
  } catch (e: any) {
    return { ...empty, ok: false, reason: dbReason(e) };
  }
}

export type OrgControl = 'sending' | 'receiving' | 'campaigns';

/**
 * Suspend a tenant.
 *
 * Suspension sets `status`, clears `is_active` (the switch the API key check already reads today, so
 * suspension takes effect on the next request rather than on the next deploy) and stops all three
 * finer controls. A reason is required: a suspended tenant will ask, and "an administrator suspended
 * it on the 14th" is not an answer anybody can act on.
 */
export async function suspendOrg(input: { orgId: string; reason: string; byUserId: string }): Promise<{ ok: boolean; error?: string }> {
  const reason = String(input.reason || '').trim();
  if (reason.length < 10) {
    return { ok: false, error: 'Give a reason of at least ten characters. It is what the organization is told when they ask why their mail stopped.' };
  }
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_orgs
         SET status = 'suspended', is_active = false,
             sending_enabled = false, receiving_enabled = false, campaigns_enabled = false,
             suspended_at = now(), suspended_by = ${input.byUserId}::uuid,
             suspension_reason = ${reason.slice(0, 2000)}, updated_at = now()
       WHERE id = ${input.orgId}::uuid
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'No such organization.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Restore a tenant.
 *
 * Restores the master switch and all three controls. It does NOT clear the suspension reason — the
 * record of why they were suspended is part of the history, and a restore that erases it leaves the
 * next administrator with no idea this has happened before.
 */
export async function restoreOrg(input: { orgId: string; byUserId: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_orgs
         SET status = 'active', is_active = true,
             sending_enabled = true, receiving_enabled = true, campaigns_enabled = true,
             suspended_at = NULL, suspended_by = NULL, updated_at = now()
       WHERE id = ${input.orgId}::uuid
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'No such organization.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/** One of the three finer stops. `enabled: false` is the disable; `true` re-enables just that one. */
export async function setOrgControl(input: {
  orgId: string;
  control: OrgControl;
  enabled: boolean;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const column = input.control === 'sending' ? 'sending_enabled'
    : input.control === 'receiving' ? 'receiving_enabled'
    : 'campaigns_enabled';
  try {
    await ensureGovernanceSchema();
    // sql.raw for the column name only — it is chosen from the three literals above and never from
    // caller input. The value is parameterised like everything else.
    const r = rows(await db.execute(sql`
      UPDATE mailapi_orgs SET ${sql.raw(column)} = ${input.enabled}, updated_at = now()
       WHERE id = ${input.orgId}::uuid RETURNING id`));
    if (!r.length) return { ok: false, error: 'No such organization.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export interface RotationResult {
  ok: boolean;
  error?: string;
  revoked: number;
  /** The new key, returned EXACTLY ONCE. It is never stored in a readable form and cannot be re-shown. */
  newKey?: string;
  newKeyId?: string;
  newKeyPrefix?: string;
}

/**
 * Rotate an organization's API credentials.
 *
 * Revokes every active key and issues one replacement. The plaintext is returned once and never
 * again: `key_hash` is a SHA-256 of the whole key and is the only copy kept, which is the contract
 * src/lib/mailapi/schema.ts already states for this table.
 *
 * ROTATION IS AN OUTAGE, and the caller is expected to say so on screen. Every integration using an
 * old key starts failing the moment this returns — that is what rotation MEANS when a key may have
 * leaked, and a "rotate but leave the old one working for a while" option would make the control
 * useless in the case it exists for. Where a gentle rotation is wanted, issue a second key first and
 * revoke the first one afterwards; that is two ordinary operations, not a mode of this one.
 */
export async function rotateOrgCredentials(input: {
  orgId: string;
  environment?: string;
  byUserId: string;
  reason: string;
}): Promise<RotationResult> {
  const reason = String(input.reason || '').trim();
  if (reason.length < 10) {
    return { ok: false, revoked: 0, error: 'Give a reason of at least ten characters. Rotation breaks every live integration and the record needs to say why.' };
  }
  const environment = input.environment || 'production';
  try {
    await ensureGovernanceSchema();

    const revokedRows = rows(await db.execute(sql`
      UPDATE mailapi_keys
         SET revoked_at = now(), revoked_reason = ${'rotated: ' + reason.slice(0, 500)}
       WHERE org_id = ${input.orgId}::uuid AND environment = ${environment} AND revoked_at IS NULL
      RETURNING id`));

    // Format follows the contract in src/lib/mailapi/schema.ts: the first 16 characters are the
    // quotable prefix, the whole string is hashed. `live`/`test` is in the prefix so a key pasted
    // into a support conversation identifies its environment without revealing anything else.
    const label = environment === 'production' ? 'live' : 'test';
    const key = 'erm_' + label + '_' + randomBytes(24).toString('base64url');
    const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
    const keyPrefix = key.slice(0, 16);

    const created = rows(await db.execute(sql`
      INSERT INTO mailapi_keys (org_id, environment, name, key_hash, key_prefix, scopes, created_by, rotated_from)
      VALUES (${input.orgId}::uuid, ${environment}, ${'Rotated ' + new Date().toISOString().slice(0, 10)},
              ${keyHash}, ${keyPrefix}, ${JSON.stringify(['mail.send', 'mail.read'])}::jsonb,
              ${input.byUserId}::uuid, ${revokedRows[0]?.id || null}::uuid)
      RETURNING id`))[0];

    return {
      ok: true,
      revoked: revokedRows.length,
      newKey: key,
      newKeyId: created?.id ? String(created.id) : undefined,
      newKeyPrefix: keyPrefix,
    };
  } catch (e: any) {
    return { ok: false, revoked: 0, error: dbReason(e) };
  }
}

export interface PlatformOverview {
  ok: boolean;
  reason?: string;
  organizations: number;
  suspended: number;
  members: number;
  domains: number;
  activeKeys: number;
  messages24h: number;
  failed24h: number;
  mailboxes: number | null;
  inbound24h: number | null;
}

/**
 * The numbers on the console's front page.
 *
 * `mailboxes` and `inbound24h` come from the INTERNAL mail store (mail_box, mail_messages), which is
 * a different system from the tenant API — they are null when those tables are absent rather than
 * zero, for the same reason campaigns is.
 */
export async function platformOverview(): Promise<PlatformOverview> {
  const empty: PlatformOverview = {
    ok: true, organizations: 0, suspended: 0, members: 0, domains: 0, activeKeys: 0,
    messages24h: 0, failed24h: 0, mailboxes: null, inbound24h: null,
  };
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM mailapi_orgs) AS organizations,
        (SELECT COUNT(*)::int FROM mailapi_orgs WHERE status = 'suspended' OR is_active = false) AS suspended,
        (SELECT COUNT(*)::int FROM mailapi_org_members WHERE removed_at IS NULL) AS members,
        (SELECT COUNT(*)::int FROM mailapi_domains) AS domains,
        (SELECT COUNT(*)::int FROM mailapi_keys WHERE revoked_at IS NULL) AS active_keys,
        (SELECT COUNT(*)::int FROM mailapi_messages WHERE created_at >= now() - interval '24 hours') AS messages_24h,
        (SELECT COUNT(*)::int FROM mailapi_messages WHERE status = 'failed' AND created_at >= now() - interval '24 hours') AS failed_24h`))[0];

    const out: PlatformOverview = {
      ...empty,
      organizations: Number(r?.organizations) || 0,
      suspended: Number(r?.suspended) || 0,
      members: Number(r?.members) || 0,
      domains: Number(r?.domains) || 0,
      activeKeys: Number(r?.active_keys) || 0,
      messages24h: Number(r?.messages_24h) || 0,
      failed24h: Number(r?.failed_24h) || 0,
    };

    if (await tableExists('mail_box')) {
      try {
        const m = rows(await db.execute(sql`SELECT COUNT(DISTINCT user_id)::int AS n FROM mail_box`))[0];
        out.mailboxes = Number(m?.n) || 0;
      } catch { out.mailboxes = null; }
    }
    if (await tableExists('mail_messages')) {
      try {
        const i = rows(await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM mail_messages
           WHERE direction = 'inbound' AND created_at >= now() - interval '24 hours'`))[0];
        out.inbound24h = Number(i?.n) || 0;
      } catch { out.inbound24h = null; }
    }
    return out;
  } catch (e: any) {
    return { ...empty, ok: false, reason: dbReason(e) };
  }
}
