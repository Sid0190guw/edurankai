// GET  /api/v1/platform/mailboxes — mailboxes the caller can open, with folder counts.
// POST /api/v1/platform/mailboxes — create a mailbox (user, shared, group or system).
//
// A mailbox is reached by OWNERSHIP (a user mailbox) or by MEMBERSHIP (a shared one). There is no
// third way, and an admin listing does not silently include everyone's personal mailbox — reading
// another person's mail is an act that needs its own grant, not a side effect of a role.

import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { audit, error, ok, preflight, readJson, requirePrincipal, validate } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';
import { isValidEmail, normalizeEmail } from '@/lib/mailplatform/rfc';
import { can } from '@/lib/mailplatform/permissions';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const CREATE_SPEC = {
  name: { required: true, type: 'string', maxLength: 200 },
  primaryAddress: { required: true, type: 'string', maxLength: 320 },
  kind: { type: 'string', oneOf: ['user', 'shared', 'group', 'system'] },
} as const;

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  try {
    const list = rows(await db.execute(
      principal.kind === 'user'
        ? sql`SELECT m.* FROM mp_mailboxes m
              WHERE m.org_id = ${principal.orgId} AND m.deleted_at IS NULL AND m.is_active
                AND (m.owner_user_id = ${principal.id}
                     OR EXISTS (SELECT 1 FROM mp_mailbox_members mm
                                WHERE mm.mailbox_id = m.id AND mm.user_id = ${principal.id} AND mm.deleted_at IS NULL))
              ORDER BY (m.owner_user_id = ${principal.id}) DESC, m.name ASC LIMIT 200`
        : sql`SELECT m.* FROM mp_mailboxes m
              WHERE m.org_id = ${principal.orgId} AND m.deleted_at IS NULL AND m.is_active
                AND m.kind IN ('shared','group','system')
              ORDER BY m.name ASC LIMIT 200`,
    ));

    const counts = principal.kind === 'user' ? await providers().messages.counts({ userId: principal.id }) : {};

    return ok({
      mailboxes: list.map((m) => ({
        id: m.id,
        kind: m.kind,
        name: m.name,
        primaryAddress: m.primary_address,
        isOwner: m.owner_user_id === principal.id,
        quotaBytes: m.quota_bytes == null ? null : Number(m.quota_bytes),
        usedBytes: Number(m.used_bytes) || 0,
      })),
      counts,
    });
  } catch (e: any) {
    console.error('[api/v1/platform/mailboxes] list failed -', causeOf(e));
    return error('Could not read mailboxes.', 500, 'read_failed');
  }
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mailbox.manage');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  const check = validate(body, CREATE_SPEC as any);
  if (!check.ok) return check.response;

  const address = normalizeEmail(body.primaryAddress);
  if (!isValidEmail(address)) return error(`"${body.primaryAddress}" is not a valid email address.`, 422, 'invalid_address');

  const kind = String(body.kind || 'user');
  const ownerUserId = typeof body.ownerUserId === 'string' ? body.ownerUserId : kind === 'user' ? principal.id : null;

  // A user mailbox for SOMEONE ELSE is a separate act from making your own, so it needs org.manage
  // on top of mailbox.manage. Otherwise anyone who may create mailboxes may create one owned by a
  // colleague and read what arrives in it.
  if (kind === 'user' && ownerUserId && ownerUserId !== principal.id && !can(principal, 'org.manage')) {
    return error('forbidden', 403, 'insufficient_permission');
  }

  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_mailboxes (org_id, kind, owner_user_id, name, primary_address, quota_bytes)
      VALUES (${principal.orgId}, ${kind}, ${ownerUserId}, ${String(body.name).slice(0, 200)}, ${address},
              ${body.quotaBytes ? Number(body.quotaBytes) : null})
      RETURNING *`));

    const mailbox = r[0];

    await db.execute(sql`
      INSERT INTO mp_email_addresses (org_id, mailbox_id, address, is_primary, purpose, verified_at)
      VALUES (${principal.orgId}, ${mailbox.id}, ${address}, true, 'mailbox', NOW())
      ON CONFLICT DO NOTHING`);

    await audit({
      principal,
      request: ctx.request,
      action: 'mailbox.create',
      targetType: 'mailbox',
      targetId: mailbox.id,
      meta: { address, kind },
    });

    return ok({ mailbox: { id: mailbox.id, kind: mailbox.kind, name: mailbox.name, primaryAddress: mailbox.primary_address } }, 201);
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key|unique/i.test(reason)) return error(`${address} is already in use by another mailbox.`, 409, 'address_taken');
    return error(reason, 500, 'create_failed');
  }
};
