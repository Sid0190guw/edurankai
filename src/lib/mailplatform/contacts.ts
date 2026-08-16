// src/lib/mailplatform/contacts.ts — contacts, lists, tags, custom fields and contact events.
//
// A contact is a PERSON THE ORGANIZATION MAY MAIL, which is a different thing from a `users` row
// (someone with a login) and from an `hr_employees` row (someone who works here). Keeping them
// separate is what lets a candidate be a contact without an account, and what stops a marketing
// list from accidentally becoming a list of staff.
//
// Every read and write is org-scoped. There is no function in this file that can be called without
// an orgId, which is the mechanical reason a tenant cannot read another tenant's contacts.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { addressKey, isValidEmail } from './rfc';
import { providers } from './providers';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import type { Contact, ContactList, ContactStatus, CustomField, Page, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function toContact(row: any): Contact {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    fullName: row.full_name ?? null,
    phone: row.phone ?? null,
    company: row.company ?? null,
    locale: row.locale ?? null,
    timezone: row.timezone ?? null,
    status: row.status,
    source: row.source ?? null,
    attributes: row.attributes || {},
    lastEngagedAt: iso(row.last_engaged_at),
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

/** Derive a display name without inventing one. Returns null when there is nothing to derive from. */
export function deriveFullName(first?: string | null, last?: string | null, existing?: string | null): string | null {
  if (existing && existing.trim()) return existing.trim().slice(0, 240);
  const joined = [first, last].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  return joined ? joined.slice(0, 240) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ContactQuery {
  orgId: UUID;
  search?: string;
  status?: ContactStatus;
  listId?: UUID;
  tag?: string;
  limit?: number;
  cursor?: string | null;
}

export async function listContacts(query: ContactQuery): Promise<Page<Contact>> {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  try {
    const conditions = [sql`c.org_id = ${query.orgId}`, sql`c.deleted_at IS NULL`];
    if (query.status) conditions.push(sql`c.status = ${query.status}`);
    if (query.search) {
      const term = `%${String(query.search).replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
      conditions.push(sql`(c.email ILIKE ${term} OR c.full_name ILIKE ${term} OR c.company ILIKE ${term})`);
    }
    if (query.listId) {
      conditions.push(sql`EXISTS (SELECT 1 FROM mp_contact_list_members m
        WHERE m.contact_id = c.id AND m.list_id = ${query.listId} AND m.status = 'subscribed')`);
    }
    if (query.tag) {
      conditions.push(sql`EXISTS (SELECT 1 FROM mp_contact_tag_members tm
        JOIN mp_contact_tags t ON t.id = tm.tag_id
        WHERE tm.contact_id = c.id AND lower(t.name) = ${String(query.tag).toLowerCase()})`);
    }
    // Keyset pagination on created_at. OFFSET over a million contacts reads and throws away every
    // row before the page.
    if (query.cursor) conditions.push(sql`c.created_at < ${new Date(query.cursor)}`);

    const r = rows(await db.execute(sql`
      SELECT c.* FROM mp_contacts c
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY c.created_at DESC
      LIMIT ${limit + 1}`));

    const hasMore = r.length > limit;
    const page = r.slice(0, limit);
    return {
      items: page.map(toContact),
      hasMore,
      nextCursor: hasMore ? iso(page[page.length - 1].created_at) : null,
    };
  } catch (e: any) {
    console.error('[mailplatform/contacts] list failed -', causeOf(e));
    return { items: [], hasMore: false, nextCursor: null };
  }
}

export async function getContact(orgId: UUID, idOrEmail: string): Promise<Contact | null> {
  if (!idOrEmail) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrEmail.trim());
    const r = rows(await db.execute(
      isUuid
        ? sql`SELECT * FROM mp_contacts WHERE org_id = ${orgId} AND id = ${idOrEmail.trim()} AND deleted_at IS NULL LIMIT 1`
        : sql`SELECT * FROM mp_contacts WHERE org_id = ${orgId} AND lower(email) = ${addressKey(idOrEmail)} AND deleted_at IS NULL LIMIT 1`,
    ));
    return r.length ? toContact(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/contacts] get failed -', causeOf(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  phone?: string | null;
  company?: string | null;
  locale?: string | null;
  timezone?: string | null;
  status?: ContactStatus;
  source?: string | null;
  attributes?: Record<string, unknown>;
}

/**
 * Create or update by email.
 *
 * Upsert rather than create-or-fail, because the realistic caller is an import or a signup form
 * that has no idea whether the address is already known. `attributes` MERGE rather than replace —
 * a form that collects one field must not erase everything else recorded about the person.
 *
 * `status` is deliberately NOT overwritten on update unless explicitly given: re-importing a
 * spreadsheet must never resubscribe someone who unsubscribed.
 */
export async function upsertContact(
  orgId: UUID,
  input: ContactInput,
  opts: { actorId?: string | null; actorType?: 'user' | 'api_key' | 'system' } = {},
): Promise<{ ok: boolean; contact?: Contact; created?: boolean; error?: string }> {
  const email = addressKey(input.email);
  if (!isValidEmail(email)) return { ok: false, error: `"${input.email}" is not a valid email address.` };

  const fullName = deriveFullName(input.firstName, input.lastName, input.fullName);
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_contacts (org_id, email, first_name, last_name, full_name, phone, company, locale, timezone, status, source, attributes)
      VALUES (${orgId}, ${email}, ${input.firstName || null}, ${input.lastName || null}, ${fullName},
              ${input.phone || null}, ${input.company || null}, ${input.locale || null}, ${input.timezone || null},
              ${input.status || 'subscribed'}, ${input.source || null}, ${JSON.stringify(input.attributes || {})}::jsonb)
      ON CONFLICT (org_id, lower(email)) WHERE deleted_at IS NULL
      DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, mp_contacts.first_name),
        last_name  = COALESCE(EXCLUDED.last_name,  mp_contacts.last_name),
        full_name  = COALESCE(EXCLUDED.full_name,  mp_contacts.full_name),
        phone      = COALESCE(EXCLUDED.phone,      mp_contacts.phone),
        company    = COALESCE(EXCLUDED.company,    mp_contacts.company),
        locale     = COALESCE(EXCLUDED.locale,     mp_contacts.locale),
        timezone   = COALESCE(EXCLUDED.timezone,   mp_contacts.timezone),
        status     = ${input.status ? sql`EXCLUDED.status` : sql`mp_contacts.status`},
        attributes = mp_contacts.attributes || EXCLUDED.attributes,
        updated_at = NOW()
      RETURNING *, (xmax = 0) AS inserted`));

    if (!r.length) return { ok: false, error: 'The contact was not written.' };
    const contact = toContact(r[0]);
    const created = !!r[0].inserted;

    await providers().events.publish({
      orgId,
      eventType: created ? EVENT_TYPES.contactCreated : EVENT_TYPES.contactUpdated,
      entityType: 'contact',
      entityId: contact.id,
      actorType: opts.actorType || 'system',
      actorId: opts.actorId || null,
      payload: { email: contact.email, source: contact.source },
      occurredAt: new Date().toISOString(),
    });

    return { ok: true, contact, created };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Bulk import. Reports per-row failures rather than aborting the whole file on one bad address. */
export async function importContacts(
  orgId: UUID,
  input: ContactInput[],
  opts: { source?: string; actorId?: string | null } = {},
): Promise<{ ok: boolean; created: number; updated: number; failed: { email: string; error: string }[] }> {
  let created = 0;
  let updated = 0;
  const failed: { email: string; error: string }[] = [];

  for (const row of input) {
    const result = await upsertContact(orgId, { ...row, source: row.source || opts.source }, { actorId: opts.actorId });
    if (!result.ok) failed.push({ email: String(row.email || ''), error: result.error || 'unknown' });
    else if (result.created) created++;
    else updated++;
  }
  return { ok: failed.length === 0, created, updated, failed };
}

/**
 * Unsubscribe. Sets the contact's status AND writes a suppression entry.
 *
 * Both, not either. The contact status is what a marketing screen reads; the suppression entry is
 * what ../send.ts checks on every single send, including transactional mail from another product
 * that never looked at the contact record. Updating only one of them is how someone unsubscribes
 * and keeps receiving mail.
 */
export async function unsubscribeContact(
  orgId: UUID,
  email: string,
  opts: { source?: string; listId?: UUID | null; campaignId?: UUID | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const addr = addressKey(email);
  if (!addr) return { ok: false, error: 'An address is required.' };
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_contacts SET status = 'unsubscribed', updated_at = NOW()
      WHERE org_id = ${orgId} AND lower(email) = ${addr} AND deleted_at IS NULL
      RETURNING id`));
    const contactId = r[0]?.id ?? null;

    if (opts.listId && contactId) {
      await db.execute(sql`
        UPDATE mp_contact_list_members SET status = 'unsubscribed', unsubscribed_at = NOW()
        WHERE list_id = ${opts.listId} AND contact_id = ${contactId}`);
    }

    const { suppress } = await import('./suppression');
    await suppress({ orgId, address: addr, reason: 'unsubscribe', source: opts.source || 'unsubscribe-link' });

    if (contactId) {
      await db.execute(sql`
        INSERT INTO mp_contact_events (org_id, contact_id, event_type, source, campaign_id)
        VALUES (${orgId}, ${contactId}, 'unsubscribed', ${opts.source || null}, ${opts.campaignId || null})`);
    }

    await providers().events.publish({
      orgId,
      eventType: EVENT_TYPES.contactUnsubscribed,
      entityType: 'contact',
      entityId: contactId,
      actorType: 'system',
      actorId: null,
      payload: { email: addr, listId: opts.listId || null, campaignId: opts.campaignId || null },
      occurredAt: new Date().toISOString(),
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Soft delete. History (events, campaign membership) survives so past sends stay explainable. */
export async function deleteContact(orgId: UUID, contactId: UUID): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_contacts SET deleted_at = NOW() WHERE org_id = ${orgId} AND id = ${contactId} AND deleted_at IS NULL RETURNING id`));
    return { ok: true, removed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, removed: false, error: causeOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export async function listContactLists(orgId: UUID): Promise<ContactList[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT l.*, (SELECT COUNT(*)::int FROM mp_contact_list_members m
                   WHERE m.list_id = l.id AND m.status = 'subscribed') AS member_count
      FROM mp_contact_lists l
      WHERE l.org_id = ${orgId} AND l.deleted_at IS NULL
      ORDER BY l.name ASC LIMIT 500`));
    return r.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      memberCount: Number(row.member_count) || 0,
      createdAt: iso(row.created_at) || '',
      updatedAt: iso(row.updated_at) || '',
      deletedAt: null,
    }));
  } catch (e: any) {
    console.error('[mailplatform/contacts] listContactLists failed -', causeOf(e));
    return [];
  }
}

export async function createList(input: {
  orgId: UUID;
  name: string;
  slug?: string;
  description?: string;
}): Promise<{ ok: boolean; list?: ContactList; error?: string }> {
  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: 'A name is required.' };
  const slug = String(input.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!slug) return { ok: false, error: 'That name does not produce a usable slug. Add some letters or digits.' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_contact_lists (org_id, name, slug, description)
      VALUES (${input.orgId}, ${name.slice(0, 200)}, ${slug}, ${input.description || null})
      RETURNING *`));
    return {
      ok: true,
      list: {
        id: r[0].id,
        orgId: r[0].org_id,
        name: r[0].name,
        slug: r[0].slug,
        description: r[0].description ?? null,
        memberCount: 0,
        createdAt: iso(r[0].created_at) || '',
        updatedAt: iso(r[0].updated_at) || '',
        deletedAt: null,
      },
    };
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: `A list with the slug "${slug}" already exists.` };
    return { ok: false, error: reason };
  }
}

export async function addToList(
  orgId: UUID,
  listId: UUID,
  contactIds: UUID[],
): Promise<{ ok: boolean; added: number; error?: string }> {
  if (!contactIds.length) return { ok: true, added: 0 };
  try {
    const values = contactIds.map((id) => sql`(${orgId}, ${listId}, ${id}, 'subscribed', NOW())`);
    const r = rows(await db.execute(sql`
      INSERT INTO mp_contact_list_members (org_id, list_id, contact_id, status, subscribed_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (list_id, contact_id) DO UPDATE SET status = 'subscribed', subscribed_at = NOW(), unsubscribed_at = NULL
      RETURNING id`));
    return { ok: true, added: r.length };
  } catch (e: any) {
    return { ok: false, added: 0, error: causeOf(e) };
  }
}

/**
 * The mailable membership of a list.
 *
 * `status = 'subscribed'` on BOTH the membership and the contact. A contact who unsubscribed
 * globally must not be reachable through an old list membership that nobody updated — checking one
 * of the two is exactly the bug that mails someone who opted out.
 */
export async function listMembers(orgId: UUID, listId: UUID, limit = 1000, cursor?: string | null): Promise<Page<Contact>> {
  const take = Math.min(Math.max(limit, 1), 5000);
  try {
    const conditions = [
      sql`m.org_id = ${orgId}`,
      sql`m.list_id = ${listId}`,
      sql`m.status = 'subscribed'`,
      sql`c.status = 'subscribed'`,
      sql`c.deleted_at IS NULL`,
    ];
    if (cursor) conditions.push(sql`c.created_at < ${new Date(cursor)}`);
    const r = rows(await db.execute(sql`
      SELECT c.* FROM mp_contact_list_members m
      JOIN mp_contacts c ON c.id = m.contact_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY c.created_at DESC LIMIT ${take + 1}`));
    const hasMore = r.length > take;
    const page = r.slice(0, take);
    return { items: page.map(toContact), hasMore, nextCursor: hasMore ? iso(page[page.length - 1].created_at) : null };
  } catch (e: any) {
    console.error('[mailplatform/contacts] listMembers failed -', causeOf(e));
    return { items: [], hasMore: false, nextCursor: null };
  }
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export async function listCustomFields(orgId: UUID): Promise<CustomField[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_custom_fields WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY key ASC LIMIT 200`));
    return r.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      entity: row.entity,
      key: row.key,
      label: row.label,
      dataType: row.data_type,
      options: Array.isArray(row.options) ? row.options : null,
      isRequired: !!row.is_required,
    }));
  } catch (e: any) {
    console.error('[mailplatform/contacts] listCustomFields failed -', causeOf(e));
    return [];
  }
}

/**
 * Coerce and validate attributes against the org's custom-field definitions.
 *
 * Pure, so it is tested without a database. An attribute the org has not defined is REJECTED rather
 * than stored: a typo'd key that silently persists produces a segment that matches nobody and a
 * personalization variable that renders blank, and neither failure points at its cause.
 */
export function validateAttributes(
  fields: CustomField[],
  attributes: Record<string, unknown>,
): { ok: boolean; values: Record<string, unknown>; errors: string[] } {
  const byKey = new Map(fields.map((f) => [f.key.toLowerCase(), f]));
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, raw] of Object.entries(attributes || {})) {
    const field = byKey.get(key.toLowerCase());
    if (!field) {
      errors.push(`There is no custom field called "${key}".`);
      continue;
    }
    if (raw === null || raw === undefined || raw === '') {
      if (field.isRequired) errors.push(`"${field.label}" is required.`);
      else values[field.key] = null;
      continue;
    }
    switch (field.dataType) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors.push(`"${field.label}" must be a number, not "${raw}".`);
        else values[field.key] = n;
        break;
      }
      case 'boolean':
        values[field.key] = raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes';
        break;
      case 'date': {
        const d = new Date(String(raw));
        if (isNaN(d.getTime())) errors.push(`"${field.label}" must be a date, not "${raw}".`);
        else values[field.key] = d.toISOString().slice(0, 10);
        break;
      }
      case 'url': {
        const s = String(raw);
        if (!/^https?:\/\/\S+$/i.test(s)) errors.push(`"${field.label}" must be an http or https URL.`);
        else values[field.key] = s;
        break;
      }
      case 'select': {
        const s = String(raw);
        if (field.options && !field.options.includes(s)) {
          errors.push(`"${field.label}" must be one of: ${field.options.join(', ')}.`);
        } else values[field.key] = s;
        break;
      }
      case 'multiselect': {
        const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        const bad = field.options ? list.filter((v) => !field.options!.includes(v)) : [];
        if (bad.length) errors.push(`"${field.label}" does not allow: ${bad.join(', ')}.`);
        else values[field.key] = list;
        break;
      }
      default:
        values[field.key] = String(raw).slice(0, 2000);
    }
  }

  for (const field of fields) {
    if (field.isRequired && !(field.key in values)) errors.push(`"${field.label}" is required.`);
  }
  return { ok: errors.length === 0, values, errors };
}
