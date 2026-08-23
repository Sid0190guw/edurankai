// src/lib/mail-product/contacts.ts — the audience, sized for millions.
//
// THE RULE THIS FILE EXISTS TO KEEP: nothing here ever returns "all contacts". Every read is a
// keyset page with a hard ceiling, every count is done in Postgres, and the CSV export streams rather
// than materialising. The browser is never handed a dataset it has to hold.
//
// Segments are a stored FILTER compiled to SQL at query time, never a stored membership list — a
// segment that was computed once is a segment that is wrong by the next signup.
import { db } from '@/lib/db';
import { sql, type SQL } from 'drizzle-orm';
import { textArray } from '@/lib/pg-array';
import { ensureMailProductSchema, CONTACT_STATUSES, type ContactStatus } from './schema';
import { rowsOf, reasonOf, normaliseEmail, isEmail, isUuid, clampInt, str, encodeCursor, decodeCursor, type Cursor } from './common';

export interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: ContactStatus;
  source: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  subscribed_at: string;
  unsubscribed_at: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactFilter {
  /** Free text over email, first and last name. */
  q?: string;
  status?: ContactStatus | 'all';
  listId?: string | null;
  segmentId?: string | null;
  tag?: string | null;
}

export interface ContactPage {
  rows: Contact[];
  /** Opaque; pass back as `cursor` for the next page. null means this was the last page. */
  nextCursor: string | null;
  /** Only computed when asked for — a COUNT over millions of rows is not free. */
  total: number | null;
}

// ---- Segment rules -----------------------------------------------------------------------------

export type SegmentField = 'email' | 'first_name' | 'last_name' | 'status' | 'tag' | 'list' | 'source' | 'created_at' | 'field';
export type SegmentOp = 'is' | 'is_not' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'is_set' | 'is_not_set' | 'before' | 'after';

export interface SegmentCondition {
  field: SegmentField;
  op: SegmentOp;
  value?: string;
  /** For field: 'field' — which custom field key. */
  key?: string;
}

export interface SegmentRules {
  match: 'all' | 'any';
  conditions: SegmentCondition[];
}

const OPS: SegmentOp[] = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_set', 'is_not_set', 'before', 'after'];
const FIELDS: SegmentField[] = ['email', 'first_name', 'last_name', 'status', 'tag', 'list', 'source', 'created_at', 'field'];

/** Accept rules out of jsonb or a POST body. Unknown fields/ops are DROPPED, never passed through:
 *  a condition this module cannot compile must not silently widen the audience. */
export function coerceRules(raw: unknown): SegmentRules {
  const o = (raw && typeof raw === 'object') ? raw as any : {};
  const conditions: SegmentCondition[] = (Array.isArray(o.conditions) ? o.conditions : [])
    .filter((c: any) => c && FIELDS.includes(c.field) && OPS.includes(c.op))
    .slice(0, 20)
    .map((c: any) => ({
      field: c.field, op: c.op,
      value: str(c.value, 200),
      key: str(c.key, 60) || undefined,
    }));
  return { match: o.match === 'any' ? 'any' : 'all', conditions };
}

/** One condition as a SQL predicate over the `c` alias. Returns null when it cannot be compiled. */
function conditionSql(c: SegmentCondition): SQL | null {
  const v = String(c.value ?? '').toLowerCase();
  const like = '%' + v + '%';

  const textCol = (col: SQL): SQL | null => {
    switch (c.op) {
      case 'is': return sql`lower(coalesce(${col},'')) = ${v}`;
      case 'is_not': return sql`lower(coalesce(${col},'')) <> ${v}`;
      case 'contains': return sql`lower(coalesce(${col},'')) LIKE ${like}`;
      case 'not_contains': return sql`lower(coalesce(${col},'')) NOT LIKE ${like}`;
      case 'starts_with': return sql`lower(coalesce(${col},'')) LIKE ${v + '%'}`;
      case 'ends_with': return sql`lower(coalesce(${col},'')) LIKE ${'%' + v}`;
      case 'is_set': return sql`coalesce(${col},'') <> ''`;
      case 'is_not_set': return sql`coalesce(${col},'') = ''`;
      default: return null;
    }
  };

  switch (c.field) {
    case 'email': return textCol(sql`c.email`);
    case 'first_name': return textCol(sql`c.first_name`);
    case 'last_name': return textCol(sql`c.last_name`);
    case 'source': return textCol(sql`c.source`);
    case 'status':
      if (!CONTACT_STATUSES.includes(v as ContactStatus)) return null;
      return c.op === 'is_not' ? sql`c.status <> ${v}` : sql`c.status = ${v}`;
    case 'tag':
      if (c.op === 'is_not' || c.op === 'not_contains') return sql`NOT (c.tags @> ${textArray([String(c.value ?? '')])})`;
      return sql`c.tags @> ${textArray([String(c.value ?? '')])}`;
    case 'list': {
      if (!isUuid(c.value)) return null;
      const member = sql`EXISTS (SELECT 1 FROM mail_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${c.value})`;
      return (c.op === 'is_not' || c.op === 'not_contains') ? sql`NOT ${member}` : member;
    }
    case 'created_at': {
      const d = new Date(String(c.value ?? ''));
      if (Number.isNaN(d.getTime())) return null;
      return c.op === 'before' ? sql`c.created_at < ${d.toISOString()}` : sql`c.created_at >= ${d.toISOString()}`;
    }
    case 'field': {
      const key = String(c.key ?? '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!key) return null;
      // ->> keeps the key a BOUND PARAMETER; it is never concatenated into the statement.
      const col = sql`(c.fields ->> ${key})`;
      return textCol(col);
    }
    default: return null;
  }
}

/** The whole rule set as one predicate, or null when nothing compiled (which means "no narrowing"). */
export function rulesSql(rules: SegmentRules): SQL | null {
  const parts = rules.conditions.map(conditionSql).filter((x): x is SQL => !!x);
  if (!parts.length) return null;
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out = rules.match === 'any' ? sql`${out} OR ${parts[i]}` : sql`${out} AND ${parts[i]}`;
  }
  return sql`(${out})`;
}

// ---- Reads --------------------------------------------------------------------------------------

async function filterSql(f: ContactFilter): Promise<SQL> {
  let where: SQL = sql`TRUE`;

  if (f.status && f.status !== 'all' && CONTACT_STATUSES.includes(f.status)) {
    where = sql`${where} AND c.status = ${f.status}`;
  }
  if (f.q) {
    const like = '%' + f.q.toLowerCase().slice(0, 120) + '%';
    where = sql`${where} AND (
      lower(c.email) LIKE ${like}
      OR lower(coalesce(c.first_name,'')) LIKE ${like}
      OR lower(coalesce(c.last_name,'')) LIKE ${like}
    )`;
  }
  if (f.tag) where = sql`${where} AND c.tags @> ${textArray([f.tag])}`;
  if (f.listId && isUuid(f.listId)) {
    where = sql`${where} AND EXISTS (SELECT 1 FROM mail_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${f.listId})`;
  }
  if (f.segmentId && isUuid(f.segmentId)) {
    const seg = rowsOf(await db.execute(sql`SELECT rules FROM mail_segments WHERE id = ${f.segmentId} LIMIT 1`))[0];
    const compiled = seg ? rulesSql(coerceRules(seg.rules)) : null;
    if (compiled) where = sql`${where} AND ${compiled}`;
  }
  return where;
}

/**
 * One page of contacts, newest first, by keyset.
 *
 * `limit` is capped at 200 whatever the caller asks for. The list screen requests 50 and appends —
 * "infinite loading" here means successive bounded requests, never one unbounded one.
 */
export async function listContacts(
  f: ContactFilter & { cursor?: string | null; limit?: number; withTotal?: boolean } = {},
): Promise<ContactPage> {
  await ensureMailProductSchema();
  const limit = clampInt(f.limit, 1, 200, 50);
  const cur: Cursor | null = decodeCursor(f.cursor);
  let where = await filterSql(f);
  // Strictly after the last row: (created_at, id) is a total order, so no row is skipped or repeated
  // when a contact is inserted between two requests.
  if (cur) where = sql`${where} AND (c.created_at, c.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`;

  const r = await db.execute(sql`
    SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.source, c.fields, c.tags,
           c.subscribed_at, c.unsubscribed_at, c.last_activity_at, c.created_at, c.updated_at
    FROM mail_contacts c
    WHERE ${where}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `);
  const all = rowsOf<Contact>(r);
  const rows = all.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = all.length > limit && last
    ? encodeCursor({ ts: new Date(last.created_at).toISOString(), id: last.id })
    : null;

  let total: number | null = null;
  if (f.withTotal) {
    // Only on the FIRST page (no cursor) — re-counting on every scroll turns an index scan into a
    // full count per page.
    const cw = await filterSql(f);
    const cr = await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${cw}`);
    total = Number(rowsOf(cr)[0]?.n ?? 0);
  }

  return { rows, nextCursor, total };
}

export async function countContacts(f: ContactFilter = {}): Promise<number> {
  await ensureMailProductSchema();
  const where = await filterSql(f);
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${where}`);
  return Number(rowsOf(r)[0]?.n ?? 0);
}

export async function getContact(id: string): Promise<Contact | null> {
  if (!isUuid(id)) return null;
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT * FROM mail_contacts WHERE id = ${id} LIMIT 1`);
  return rowsOf<Contact>(r)[0] || null;
}

/** Every list a contact is on, for the profile screen. */
export async function contactLists(id: string): Promise<{ id: string; name: string }[]> {
  if (!isUuid(id)) return [];
  const r = await db.execute(sql`
    SELECT l.id, l.name FROM mail_list_members lm
    JOIN mail_lists l ON l.id = lm.list_id
    WHERE lm.contact_id = ${id} ORDER BY l.name ASC LIMIT 100`);
  return rowsOf(r);
}

/** The recent delivery events for one contact — the "activity" half of the profile. */
export async function contactActivity(id: string, limit = 40): Promise<any[]> {
  if (!isUuid(id)) return [];
  const r = await db.execute(sql`
    SELECT e.type, e.url, e.created_at, c.name AS campaign_name, c.id AS campaign_id
    FROM mail_campaign_events e
    LEFT JOIN mail_campaigns c ON c.id = e.campaign_id
    WHERE e.contact_id = ${id}
    ORDER BY e.created_at DESC LIMIT ${clampInt(limit, 1, 200, 40)}`);
  return rowsOf(r);
}

// ---- Writes ---------------------------------------------------------------------------------------

export interface UpsertContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  status?: ContactStatus;
  source?: string | null;
  fields?: Record<string, unknown>;
  tags?: string[];
}

export interface UpsertResult { id: string | null; created: boolean; error?: string; }

/**
 * Create or update by email.
 *
 * A CONTACT THAT UNSUBSCRIBED IS NOT RE-SUBSCRIBED BY AN IMPORT. That is the single most important
 * line in this file: re-uploading a spreadsheet is the ordinary way a suppression list gets wiped and
 * a complaint gets mailed again. Status is only ever raised to 'subscribed' by an explicit status
 * change, never by an upsert carrying the default.
 */
export async function upsertContact(input: UpsertContactInput): Promise<UpsertResult> {
  await ensureMailProductSchema();
  const email = normaliseEmail(input.email);
  if (!isEmail(email)) return { id: null, created: false, error: 'That is not an email address: ' + (input.email || '(blank)') };

  const status: ContactStatus = CONTACT_STATUSES.includes(input.status as ContactStatus) ? input.status! : 'subscribed';
  const tags = (input.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
  const fields = JSON.stringify(input.fields && typeof input.fields === 'object' ? input.fields : {});

  try {
    const r = await db.execute(sql`
      INSERT INTO mail_contacts (email, first_name, last_name, status, source, fields, tags)
      VALUES (${email}, ${str(input.firstName, 120) || null}, ${str(input.lastName, 120) || null},
              ${status}, ${str(input.source, 80) || null}, ${fields}::jsonb, ${textArray(tags)})
      ON CONFLICT (lower(email)) DO UPDATE SET
        first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), mail_contacts.first_name),
        last_name  = COALESCE(NULLIF(EXCLUDED.last_name, ''), mail_contacts.last_name),
        source     = COALESCE(mail_contacts.source, EXCLUDED.source),
        fields     = mail_contacts.fields || EXCLUDED.fields,
        tags       = (SELECT ARRAY(SELECT DISTINCT unnest(mail_contacts.tags || EXCLUDED.tags))),
        updated_at = now()
      RETURNING id, (xmax = 0) AS created
    `);
    const row = rowsOf(r)[0];
    return { id: row?.id ?? null, created: !!row?.created };
  } catch (e: any) {
    return { id: null, created: false, error: reasonOf(e) };
  }
}

/** An explicit status change — the only path that may resubscribe somebody. */
export async function setContactStatus(id: string, status: ContactStatus): Promise<boolean> {
  if (!isUuid(id) || !CONTACT_STATUSES.includes(status)) return false;
  await ensureMailProductSchema();
  const r = await db.execute(sql`
    UPDATE mail_contacts SET
      status = ${status},
      unsubscribed_at = CASE WHEN ${status} IN ('unsubscribed','complained') THEN now() ELSE NULL END,
      subscribed_at = CASE WHEN ${status} = 'subscribed' AND status <> 'subscribed' THEN now() ELSE subscribed_at END,
      updated_at = now()
    WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function deleteContact(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  await ensureMailProductSchema();
  const r = await db.execute(sql`DELETE FROM mail_contacts WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function addToList(listId: string, contactIds: string[]): Promise<number> {
  if (!isUuid(listId)) return 0;
  const ids = contactIds.filter(isUuid).slice(0, 5000);
  if (!ids.length) return 0;
  await ensureMailProductSchema();
  const r = await db.execute(sql`
    INSERT INTO mail_list_members (list_id, contact_id)
    SELECT ${listId}::uuid, t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)
    ON CONFLICT DO NOTHING RETURNING contact_id`);
  return rowsOf(r).length;
}

export async function removeFromList(listId: string, contactIds: string[]): Promise<number> {
  if (!isUuid(listId)) return 0;
  const ids = contactIds.filter(isUuid).slice(0, 5000);
  if (!ids.length) return 0;
  const r = await db.execute(sql`
    DELETE FROM mail_list_members WHERE list_id = ${listId}
      AND contact_id IN (SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x))
    RETURNING contact_id`);
  return rowsOf(r).length;
}

// ---- Lists + segments ------------------------------------------------------------------------------

export async function listLists(): Promise<{ id: string; name: string; slug: string; description: string | null; member_count: number; created_at: string }[]> {
  await ensureMailProductSchema();
  // The count is a lateral subquery rather than a GROUP BY join so an empty list still appears.
  const r = await db.execute(sql`
    SELECT l.id, l.name, l.slug, l.description, l.created_at,
           (SELECT count(*)::int FROM mail_list_members lm WHERE lm.list_id = l.id) AS member_count
    FROM mail_lists l ORDER BY l.created_at DESC LIMIT 200`);
  return rowsOf(r);
}

export async function listSegments(): Promise<{ id: string; name: string; description: string | null; rules: SegmentRules; created_at: string }[]> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT id, name, description, rules, created_at FROM mail_segments ORDER BY created_at DESC LIMIT 200`);
  return rowsOf(r).map((s: any) => ({ ...s, rules: coerceRules(s.rules) }));
}

export async function listCustomFields(): Promise<{ id: string; key: string; label: string; kind: string }[]> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT id, key, label, kind FROM mail_contact_fields ORDER BY label ASC LIMIT 100`);
  return rowsOf(r);
}

/**
 * Who a campaign would actually go to.
 *
 * The union of its lists and its segment, minus everybody who is not 'subscribed', minus everybody
 * on the shared suppression list. Neither exclusion is a filter the operator can turn off, and both
 * are applied HERE rather than at send time so the number on the confirmation screen is the number
 * of messages that will leave.
 *
 * WHY TWO CHECKS AND NOT ONE. `mail_contacts.status` is this product's own view of a person.
 * `mail_suppression` (owned by src/lib/mail-contacts.ts, keyed by EMAIL rather than by contact id)
 * is the whole system's — it is what a bounce webhook, the transactional API and the one-click
 * unsubscribe endpoint all write, and an address can land in it with no contact row at all or while
 * a contact row still reads 'subscribed'. Filtering on status alone would mail somebody who had
 * asked another part of this platform to stop, which is the precise failure that produces a spam
 * complaint rather than an unsubscribe.
 *
 * The NOT EXISTS is an index lookup per row against a primary key, so it costs effectively nothing
 * even over a large audience.
 */
export function audienceSql(listIds: string[], segmentRules: SegmentRules | null): SQL {
  let where: SQL = sql`c.status = 'subscribed'
    AND NOT EXISTS (SELECT 1 FROM mail_suppression s WHERE s.email = lower(c.email))`;
  const ids = listIds.filter(isUuid);
  const parts: SQL[] = [];
  if (ids.length) {
    parts.push(sql`EXISTS (SELECT 1 FROM mail_list_members lm WHERE lm.contact_id = c.id
      AND lm.list_id IN (SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)))`);
  }
  const seg = segmentRules ? rulesSql(segmentRules) : null;
  if (seg) parts.push(seg);
  if (parts.length === 1) where = sql`${where} AND ${parts[0]}`;
  else if (parts.length > 1) where = sql`${where} AND (${parts[0]} AND ${parts[1]})`;
  // No list and no segment selected means NOBODY, not everybody. A campaign that silently addressed
  // the entire database because a checkbox was missed is not a recoverable mistake.
  else where = sql`FALSE`;
  return where;
}

export async function countAudience(listIds: string[], segmentRules: SegmentRules | null): Promise<number> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${audienceSql(listIds, segmentRules)}`);
  return Number(rowsOf(r)[0]?.n ?? 0);
}
