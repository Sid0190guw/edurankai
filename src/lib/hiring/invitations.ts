// src/lib/hiring/invitations.ts — "an administrator asked this person to apply."
//
// WHAT THIS IS, IN ONE SENTENCE
//
// An invitation shortens the walk to an application: it carries the role, the person's name, a line
// from whoever invited them, and optionally a fee waiver decided for that one person. The invited
// person still fills in the application and it still goes to a human reviewer.
//
// WHAT IT IS NOT
//
// Not tal_onboarding_code (ERA-SEL). That code means somebody was already SELECTED, skips the
// application entirely, and is a typed secret — which is why it has a uniform rejection sentence and
// a rate limiter reading a table. This is a URL token that shortens the walk to a form anyone can
// already reach from /careers, so it does not carry that blast radius and does not pretend to.
//
// THREE RULES THIS MODULE KEEPS
//
// 1. THE TOKEN IS NEVER STORED. token_hash is sha256(token); the plaintext is returned once, to the
//    administrator who created it. A dump of this table opens nothing.
//
// 2. ONE LIVE INVITATION PER PERSON PER ROLE, enforced by the partial unique index
//    app_inv_active_uq, not by convention. Re-inviting revokes the previous one first.
//
// 3. A FAILED SEND IS RECORDED AS A FAILED SEND. email_sent/email_error hold what actually happened,
//    because an administrator who believes an invitation was delivered will not follow it up.
//
// PRODUCTION NOTE: the table is created by db/application-invitations-schema.sql, run by hand, and
// registered in BOOTSTRAP_MODULES. ensureInvitationSchema() below is the local-development path only
// — bootstrap DDL is suppressed in production by design, so nothing here may assume it ran.
import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const fail = (where: string, e: any) => console.error('[invitations] ' + where + ':', e?.cause?.message || e?.message);

/** How long an invitation link stays usable, unless an administrator picks something shorter. */
export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 180;

export type InvitationStatus = 'pending' | 'opened' | 'applied' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  email: string;
  fullName: string;
  roleId: string | null;
  roleSlug: string;
  roleTitle: string;
  tokenPrefix: string;
  note: string;
  waiveFee: boolean;
  invitedBy: string | null;
  invitedByName: string;
  status: InvitationStatus;
  emailSent: boolean;
  emailError: string;
  applicationId: string | null;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  openedAt: string | null;
  appliedAt: string | null;
  revokedAt: string | null;
}

// =================================================================================================
// PURE — no database, no network, unit-tested
// =================================================================================================

/** 32 bytes of randomness, url-safe. Not a typed secret, so it is long rather than memorable. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** The first characters of a token, for the admin list. Never enough to reconstruct one. */
export function tokenPrefixOf(token: string): string {
  return String(token || '').slice(0, 8);
}

export function normaliseEmail(input: unknown): string {
  return String(input ?? '').trim().toLowerCase().slice(0, 160);
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

export function isEmail(input: unknown): boolean {
  return EMAIL_RE.test(normaliseEmail(input));
}

/**
 * The status an invitation actually has right now.
 *
 * Expiry is DERIVED rather than stored, so no scheduled job has to run for this column to stay
 * honest. A revoked invitation stays revoked even after its expiry date, because "the administrator
 * took this back" and "nobody used it in time" are different things to whoever reads the list.
 */
export function statusOf(
  row: { status: string; expiresAt: string | Date; appliedAt?: string | Date | null },
  now: Date = new Date(),
): InvitationStatus {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'applied' || row.appliedAt) return 'applied';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return row.status === 'opened' ? 'opened' : 'pending';
}

/** Only these two can still be walked through. Everything else is history. */
export function isLive(status: InvitationStatus): boolean {
  return status === 'pending' || status === 'opened';
}

export function inviteUrl(origin: string, token: string): string {
  return String(origin || '').replace(/\/+$/, '') + '/apply/invite/' + encodeURIComponent(token);
}

export function ttlDays(input: unknown): number {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
}

export interface InviteInput {
  email: unknown;
  fullName?: unknown;
  roleSlug?: unknown;
  note?: unknown;
  waiveFee?: unknown;
  days?: unknown;
}

export interface CleanInvite {
  email: string;
  fullName: string;
  roleSlug: string;
  note: string;
  waiveFee: boolean;
  days: number;
}

/**
 * Validate and clean one invitation. Returns the problem as a sentence a person can act on, or the
 * cleaned record — never both, and never a half-cleaned one.
 */
export function parseInvite(input: InviteInput): { error: string } | { value: CleanInvite } {
  const email = normaliseEmail(input.email);
  if (!email) return { error: 'Enter the email address to invite.' };
  if (!isEmail(email)) return { error: 'That email address does not look right.' };
  return {
    value: {
      email,
      fullName: String(input.fullName ?? '').trim().slice(0, 120),
      roleSlug: String(input.roleSlug ?? '').trim().slice(0, 200),
      note: String(input.note ?? '').trim().slice(0, 1000),
      waiveFee: input.waiveFee === true || input.waiveFee === 'true' || input.waiveFee === 'on',
      days: ttlDays(input.days),
    },
  };
}

/** The one sentence every failed invitation link gets. Distinguishing them helps nobody outside. */
export const INVALID_LINK =
  'This invitation link is not valid any more. It may have been used, withdrawn, or expired.';

// =================================================================================================
// PERSISTENCE
// =================================================================================================

/** Local development only. Production gets this table from db/application-invitations-schema.sql. */
export function ensureInvitationSchema(): Promise<void> {
  return ensureOnce('application_invitations_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      full_name TEXT NOT NULL DEFAULT '',
      role_id UUID,
      role_slug TEXT NOT NULL DEFAULT '',
      role_title TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      waive_fee BOOLEAN NOT NULL DEFAULT FALSE,
      invited_by UUID,
      invited_by_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      email_error TEXT NOT NULL DEFAULT '',
      application_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID
    )`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS app_inv_token_uq ON application_invitations (token_hash)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS app_inv_email_idx ON application_invitations (email, role_slug)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS app_inv_created_idx ON application_invitations (created_at DESC)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS app_inv_active_uq ON application_invitations (email, role_slug) WHERE status IN ('pending', 'opened')`);
  });
}

const COLS = `id, email, full_name, role_id, role_slug, role_title, token_prefix, note, waive_fee,
              invited_by, invited_by_name, status, email_sent, email_error, application_id,
              created_at, expires_at, sent_at, opened_at, applied_at, revoked_at`;

function toInvitation(r: any): Invitation {
  const base = {
    id: String(r.id),
    email: String(r.email || ''),
    fullName: String(r.full_name || ''),
    roleId: r.role_id ? String(r.role_id) : null,
    roleSlug: String(r.role_slug || ''),
    roleTitle: String(r.role_title || ''),
    tokenPrefix: String(r.token_prefix || ''),
    note: String(r.note || ''),
    waiveFee: r.waive_fee === true,
    invitedBy: r.invited_by ? String(r.invited_by) : null,
    invitedByName: String(r.invited_by_name || ''),
    emailSent: r.email_sent === true,
    emailError: String(r.email_error || ''),
    applicationId: r.application_id ? String(r.application_id) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : '',
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  };
  return {
    ...base,
    status: statusOf({ status: String(r.status || ''), expiresAt: base.expiresAt, appliedAt: base.appliedAt }),
  };
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  invitation?: Invitation;
  /** Returned exactly once. Not recoverable afterwards. */
  token?: string;
}

/**
 * Create one invitation, revoking any live one this person already holds for the same role.
 *
 * The revoke-then-insert pair runs inside a transaction: the partial unique index would otherwise
 * reject the insert on a re-invite, and a half-applied re-invite would leave the person holding a
 * revoked link and no new one.
 */
export async function createInvitation(args: {
  clean: CleanInvite;
  roleId: string | null;
  roleTitle: string;
  invitedBy: string | null;
  invitedByName: string;
}): Promise<CreateResult> {
  const token = generateToken();
  const expires = new Date(Date.now() + args.clean.days * 86400000).toISOString();
  try {
    const inserted = await db.transaction(async (tx: any) => {
      await tx.execute(sql`
        UPDATE application_invitations
           SET status = 'revoked', revoked_at = NOW()
         WHERE email = ${args.clean.email}
           AND role_slug = ${args.clean.roleSlug}
           AND status IN ('pending', 'opened')`);
      const r = await tx.execute(sql`
        INSERT INTO application_invitations
          (email, full_name, role_id, role_slug, role_title, token_hash, token_prefix, note,
           waive_fee, invited_by, invited_by_name, expires_at)
        VALUES
          (${args.clean.email}, ${args.clean.fullName},
           ${args.roleId}::uuid,
           ${args.clean.roleSlug}, ${args.roleTitle},
           ${hashToken(token)}, ${tokenPrefixOf(token)}, ${args.clean.note},
           ${args.clean.waiveFee},
           ${args.invitedBy}::uuid,
           ${args.invitedByName}, ${expires}::timestamptz)
        RETURNING ${sql.raw(COLS)}`);
      return rows(r)[0];
    });
    if (!inserted) return { ok: false, error: 'The invitation could not be saved.' };
    return { ok: true, invitation: toInvitation(inserted), token };
  } catch (e: any) {
    fail('createInvitation', e);
    return { ok: false, error: e?.cause?.message || 'The invitation could not be saved.' };
  }
}

/**
 * Read one invitation by its token.
 *
 * Returns null for every failure — missing, revoked, expired, already used. The caller shows
 * INVALID_LINK, one sentence for all of them.
 */
export async function findByToken(token: string): Promise<Invitation | null> {
  const t = String(token || '').trim();
  if (!t) return null;
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       WHERE token_hash = ${hashToken(t)} LIMIT 1`);
    const row = rows(r)[0];
    return row ? toInvitation(row) : null;
  } catch (e: any) {
    fail('findByToken', e);
    return null;
  }
}

export async function markOpened(id: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'opened', opened_at = COALESCE(opened_at, NOW())
       WHERE id = ${id}::uuid AND status = 'pending'`);
  } catch (e: any) {
    // An invitation that opened but could not record it is still a usable invitation. Never block
    // the person on our own bookkeeping.
    fail('markOpened', e);
  }
}

export async function recordSend(id: string, sent: boolean, error: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET email_sent = ${sent}, email_error = ${String(error || '').slice(0, 400)},
             sent_at = CASE WHEN ${sent} THEN NOW() ELSE sent_at END
       WHERE id = ${id}::uuid`);
  } catch (e: any) {
    fail('recordSend', e);
  }
}

export async function revokeInvitation(id: string, byUserId: string | null): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      UPDATE application_invitations
         SET status = 'revoked', revoked_at = NOW(), revoked_by = ${byUserId}::uuid
       WHERE id = ${id}::uuid AND status IN ('pending', 'opened')
      RETURNING id`);
    return rows(r).length > 0;
  } catch (e: any) {
    fail('revokeInvitation', e);
    return false;
  }
}

export async function listInvitations(limit = 200): Promise<Invitation[]> {
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       ORDER BY created_at DESC LIMIT ${limit}`);
    return rows(r).map(toInvitation);
  } catch (e: any) {
    // A read that failed is NOT "there are none". The caller is handed the failure so the screen can
    // say so, rather than rendering an empty list that reads as a confident nobody-was-invited.
    fail('listInvitations', e);
    throw e;
  }
}

/**
 * The live invitation this person holds for this role, if any — the fee-waiver lookup.
 *
 * A role-less ("open") invitation counts for any role: an administrator who invited somebody without
 * naming a posting meant the person, not the posting. A role-specific one wins when both exist.
 */
export async function liveInvitationFor(email: string, roleSlug: string): Promise<Invitation | null> {
  const e = normaliseEmail(email);
  if (!e) return null;
  try {
    const r = await db.execute(sql`
      SELECT ${sql.raw(COLS)} FROM application_invitations
       WHERE email = ${e}
         AND status IN ('pending', 'opened')
         AND expires_at > NOW()
         AND (role_slug = ${String(roleSlug || '')} OR role_slug = '')
       ORDER BY (role_slug <> '') DESC, created_at DESC
       LIMIT 1`);
    const row = rows(r)[0];
    return row ? toInvitation(row) : null;
  } catch (e2: any) {
    fail('liveInvitationFor', e2);
    return null;
  }
}

/**
 * Close the loop from the application side: this email now has an application, so whatever live
 * invitation they were holding is spent.
 *
 * Deliberately NOT matched on role. By the time an application exists the person may have applied
 * to a different posting than the one they were invited to, and an invitation left sitting at
 * "pending" would tell the administrator to chase somebody who already applied. Marking the most
 * recent live one is the answer that makes the admin list mean what it says.
 *
 * Swallows its own failures on purpose: this is bookkeeping that runs after an application has
 * already been created, and nothing here may put that application at risk.
 */
export async function markAppliedForEmail(email: string, applicationId: string | null): Promise<void> {
  const e = normaliseEmail(email);
  if (!e) return;
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'applied', applied_at = NOW(), application_id = ${applicationId}::uuid
       WHERE id = (
         SELECT id FROM application_invitations
          WHERE email = ${e} AND status IN ('pending', 'opened')
          ORDER BY created_at DESC LIMIT 1
       )`);
  } catch (e2: any) {
    fail('markAppliedForEmail', e2);
  }
}

/** Close the loop for one known invitation. */
export async function markApplied(id: string, applicationId: string | null): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE application_invitations
         SET status = 'applied', applied_at = NOW(), application_id = ${applicationId}::uuid
       WHERE id = ${id}::uuid AND status IN ('pending', 'opened')`);
  } catch (e: any) {
    fail('markApplied', e);
  }
}
