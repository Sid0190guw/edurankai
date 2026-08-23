// src/lib/mail-contacts.ts — THE CONTACT BOOK: people, lists, tags, consent, suppression.
//
// IT DOES NOT OWN ITS TABLES, AND THAT IS THE POINT.
//
// `mail_contacts`, `mail_lists`, `mail_list_members` and `mail_segments` are created by the core
// mail schema, src/lib/mail-product/schema.ts. This module calls ensureMailProductSchema() and then
// ADDS the columns the contact/segmentation/campaign work needs on top — organisation, phone, role,
// consent metadata, an unsubscribe token, and a segment tree in its own column beside the core
// `rules`. Every statement below is `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` or
// `CREATE TABLE IF NOT EXISTS` for a table nobody else owns.
//
// WHY IT MATTERS RATHER THAN BEING A STYLE NOTE: `CREATE TABLE IF NOT EXISTS` is silent when the
// table already exists WITH A DIFFERENT SHAPE. A second definition of mail_contacts here would not
// error — it would no-op, and then every query in one of the two modules would fail on a column
// that was never created, at runtime, in production. So there is exactly one definition of each
// shared table, it lives in the core schema, and this file extends it.
//
// TWO RULES THIS MODULE ENFORCES ON EVERYONE ELSE:
//
//   1. AN ADDRESS IS STORED ONCE. The core schema's unique index on lower(email) means "duplicate
//      contacts" cannot exist for the same address — which is why the merge path below is about
//      people, not addresses.
//   2. SUPPRESSION IS SEPARATE FROM SUBSCRIPTION, AND IT OUTLIVES THE CONTACT. Deleting a contact
//      who unsubscribed must NOT make them mailable again; the suppression row is keyed by address
//      and survives the delete. This is the single most common way a mail system re-mails somebody
//      who asked it to stop.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { textIn, uuidIn, textArray } from '@/lib/pg-array';
import { ensureMailProductSchema } from '@/lib/mail-product/schema';
import { isValidEmail, normalizeEmailValue, type ImportContact, type SubscriptionStatus } from '@/lib/mail-csv';
import { segmentSql, type SegmentNode, segmentErrors } from '@/lib/mail-segments';

function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) ? r : (r?.rows || [])) as T[];
}
/** The real Postgres reason is on e.cause; e.message is only the failed SQL. */
export const dbReason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): boolean { return UUID_RE.test(String(v || '')); }

// ── schema (additive only) ─────────────────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;

/**
 * Bootstrap. Re-throws so a failure is not cached — a transient hiccup must not poison the process
 * for its lifetime, which is the fault ensureOnce() and application-stages.ts were both repaired for.
 */
export function ensureContactSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      // The shared tables come from here. Never redefined below.
      await ensureMailProductSchema();

      // ---- columns Patch 5 adds to the core contact row ----
      const contactCols = [
        'organization text', 'phone text', 'role_title text', 'notes text',
        'consent_source text', 'consent_at timestamptz', 'consent_ip text', 'consent_note text',
        'unsub_token uuid NOT NULL DEFAULT gen_random_uuid()',
        'merged_into uuid', 'created_by uuid',
      ];
      for (const col of contactCols) {
        await db.execute(sql.raw('ALTER TABLE mail_contacts ADD COLUMN IF NOT EXISTS ' + col));
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contacts_org_idx ON mail_contacts(lower(organization))`);
      // The segment compiler reaches custom values with `fields ->> 'key'`; GIN keeps that usable.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contacts_fields_idx ON mail_contacts USING GIN (fields)`);

      // ---- lists: static vs dynamic, and archiving ----
      for (const col of ['kind text NOT NULL DEFAULT \'static\'', 'segment_id uuid', 'is_archived boolean NOT NULL DEFAULT false']) {
        await db.execute(sql.raw('ALTER TABLE mail_lists ADD COLUMN IF NOT EXISTS ' + col));
      }
      await db.execute(sql`ALTER TABLE mail_list_members ADD COLUMN IF NOT EXISTS source text`);
      await db.execute(sql`ALTER TABLE mail_list_members ADD COLUMN IF NOT EXISTS added_by uuid`);

      /**
       * THE SEGMENT TREE GETS ITS OWN COLUMN RATHER THAN OVERWRITING `rules`.
       *
       * The core schema stores `{"match":"all","conditions":[]}`; this engine stores a nested
       * AND/OR/NOT tree (src/lib/mail-segments.ts). They are different languages for the same idea,
       * and writing one into the other's column would silently break whichever reader got there
       * second. `definition` is read and written only here; `rules` is left exactly as it is.
       */
      await db.execute(sql`ALTER TABLE mail_segments ADD COLUMN IF NOT EXISTS definition jsonb`);
      await db.execute(sql`ALTER TABLE mail_segments ADD COLUMN IF NOT EXISTS slug text`);
      await db.execute(sql`ALTER TABLE mail_segments ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_segments_slug_uq ON mail_segments(lower(slug)) WHERE slug IS NOT NULL`);

      // ---- tables nobody else owns ----
      // Keyed by ADDRESS, not by contact id, and with no foreign key — see the note at the top of
      // this file. A suppression must survive the deletion of the contact it came from.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_suppression (
        email text PRIMARY KEY,
        reason text NOT NULL DEFAULT 'unsubscribed',
        detail text,
        campaign_id uuid,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_contact_events (
        id bigserial PRIMARY KEY,
        contact_id uuid REFERENCES mail_contacts(id) ON DELETE CASCADE,
        email text,
        kind text NOT NULL,
        campaign_id uuid,
        actor_user_id uuid,
        actor_name text,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_contact_events_contact_idx ON mail_contact_events(contact_id, created_at DESC)`);
    } catch (e: any) {
      ready = null;
      console.error('[mail-contacts] schema bootstrap failed:', dbReason(e));
      throw e;
    }
  })();
  return ready;
}

// ── types ──────────────────────────────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  phone: string | null;
  role_title: string | null;
  status: SubscriptionStatus;
  /** The core schema's `fields` column, exposed under the name the rest of Patch 5 uses. */
  custom: Record<string, unknown>;
  notes: string | null;
  consent_source: string | null;
  consent_at: string | null;
  consent_ip: string | null;
  consent_note: string | null;
  user_id: string | null;
  unsub_token: string;
  last_activity_at: string | null;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
}

function toContact(r: any): Contact {
  return {
    ...(r as any),
    custom: r.fields || {},
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
  } as Contact;
}

export interface Actor { userId: string | null; name: string }

export type ContactEventKind =
  | 'created' | 'updated' | 'deleted' | 'imported' | 'merged' | 'merged_away'
  | 'subscribed' | 'unsubscribed' | 'resubscribed' | 'suppressed' | 'unsuppressed'
  | 'tagged' | 'untagged' | 'listed' | 'unlisted'
  | 'sent' | 'delivered' | 'deferred' | 'bounced' | 'opened' | 'clicked' | 'complained';

export async function logContactEvent(p: {
  contactId?: string | null;
  email?: string | null;
  kind: ContactEventKind;
  campaignId?: string | null;
  actor?: Actor | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mail_contact_events (contact_id, email, kind, campaign_id, actor_user_id, actor_name, detail)
      VALUES (${p.contactId || null}, ${p.email ? normalizeEmailValue(p.email) : null}, ${p.kind},
              ${p.campaignId || null}, ${p.actor?.userId || null}, ${p.actor?.name || null},
              ${JSON.stringify(p.detail || {})}::jsonb)
    `);
  } catch (e: any) {
    // The event log must never take a write down with it, but silence here is how history quietly
    // stops being written; say so.
    console.error('[mail-contacts] event log failed (' + p.kind + '):', dbReason(e));
  }
}

// ── suppression ────────────────────────────────────────────────────────────────────────────────

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual' | 'invalid';

export async function suppress(email: string, reason: SuppressionReason, detail?: string, campaignId?: string | null, actor?: Actor): Promise<void> {
  await ensureContactSchema();
  const e = normalizeEmailValue(email);
  if (!e) return;
  await db.execute(sql`
    INSERT INTO mail_suppression (email, reason, detail, campaign_id, created_by)
    VALUES (${e}, ${reason}, ${detail || null}, ${campaignId || null}, ${actor?.userId || null})
    ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
  `);
  const status: SubscriptionStatus = reason === 'bounced' ? 'bounced' : reason === 'complained' ? 'complained' : 'unsubscribed';
  const hit = rows(await db.execute(sql`
    UPDATE mail_contacts SET status = ${status}, unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
    WHERE lower(email) = ${e} RETURNING id
  `));

  /**
   * STOP EVERYTHING ALREADY QUEUED TO THIS ADDRESS, NOW.
   *
   * It lives here rather than in the unsubscribe handler because suppression has four causes and all
   * four mean the same thing about mail that is already sitting in a queue: an unsubscribe, a hard
   * bounce, a spam complaint and an admin adding an address by hand. Putting it only on the
   * unsubscribe path left the other three — an address that hard-bounced mid-campaign would keep
   * being handed to the sender for every remaining batch, and an admin marking somebody unsubscribed
   * on the contact screen still had them go out that evening.
   *
   * Keyed by ADDRESS, matching the suppression row itself, so it works for an address with no
   * contact record. Both engines' pending states: 'pending' is this one's, 'queued' is the core
   * dispatcher's.
   */
  try {
    await db.execute(sql`
      UPDATE mail_campaign_recipients SET status = 'skipped', skip_reason = ${reason}, updated_at = now()
      WHERE lower(email) = ${e} AND status IN ('pending', 'queued')
    `);
  } catch (err: any) {
    // Never take the suppression write down with it — the refusal to mail is recorded either way,
    // and the resolver re-checks suppression on every send. But say so: a queue that silently keeps
    // a suppressed address is exactly what this statement exists to prevent.
    console.error('[mail-contacts] could not clear queued sends for a suppressed address:', dbReason(err));
  }

  await logContactEvent({ contactId: hit[0]?.id || null, email: e, kind: 'suppressed', campaignId, actor, detail: { reason, detail } });
}

/**
 * Take an address off the suppression list.
 *
 * DELIBERATELY REFUSES A COMPLAINT. Somebody who marked mail as spam did not merely unsubscribe;
 * re-mailing them is how a sending domain gets blocklisted, and no admin convenience is worth that.
 * A bounce or an unsubscribe can be reversed by a human who has a reason.
 */
export async function unsuppress(email: string, actor?: Actor): Promise<{ ok: boolean; error?: string }> {
  await ensureContactSchema();
  const e = normalizeEmailValue(email);
  const existing = rows(await db.execute(sql`SELECT reason FROM mail_suppression WHERE email = ${e} LIMIT 1`))[0];
  if (!existing) return { ok: false, error: 'That address is not suppressed.' };
  if (existing.reason === 'complained') {
    return { ok: false, error: 'This address reported a message as spam. It stays suppressed — re-mailing a complainant damages delivery for everyone else.' };
  }
  await db.execute(sql`DELETE FROM mail_suppression WHERE email = ${e}`);
  await db.execute(sql`UPDATE mail_contacts SET status = 'subscribed', unsubscribed_at = NULL, updated_at = now() WHERE lower(email) = ${e}`);
  await logContactEvent({ email: e, kind: 'unsuppressed', actor });
  return { ok: true };
}

export async function isSuppressed(email: string): Promise<boolean> {
  await ensureContactSchema();
  const r = rows(await db.execute(sql`SELECT 1 FROM mail_suppression WHERE email = ${normalizeEmailValue(email)} LIMIT 1`));
  return r.length > 0;
}

/** The suppressed subset of a list of addresses. One query per chunk, never one per address. */
export async function suppressedAmong(emails: string[]): Promise<Set<string>> {
  await ensureContactSchema();
  const list = [...new Set(emails.map(normalizeEmailValue).filter(Boolean))];
  if (!list.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < list.length; i += 2000) {
    const chunk = list.slice(i, i + 2000);
    const r = rows(await db.execute(sql`SELECT email FROM mail_suppression WHERE email IN ${textIn(chunk)}`));
    for (const row of r) out.add(String(row.email));
  }
  return out;
}

export async function listSuppressions(limit = 500): Promise<any[]> {
  await ensureContactSchema();
  return rows(await db.execute(sql`SELECT email, reason, detail, campaign_id, created_at FROM mail_suppression ORDER BY created_at DESC LIMIT ${limit}`));
}

// ── contact CRUD ───────────────────────────────────────────────────────────────────────────────

export interface ContactInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string | null;
  phone?: string | null;
  role_title?: string | null;
  status?: SubscriptionStatus;
  custom?: Record<string, unknown>;
  notes?: string | null;
  consent_source?: string | null;
  consent_at?: string | null;
  consent_ip?: string | null;
  consent_note?: string | null;
  tags?: string[];
}

export interface WriteResult { ok: boolean; id?: string; error?: string }

export function cleanTag(t: string): string {
  return String(t || '').trim().toLowerCase().slice(0, 80);
}
function cleanTags(xs: string[] | undefined): string[] {
  return [...new Set((xs || []).map(cleanTag).filter(Boolean))].slice(0, 40);
}

export async function createContact(input: ContactInput, actor?: Actor): Promise<WriteResult> {
  await ensureContactSchema();
  const email = normalizeEmailValue(input.email);
  if (!email) return { ok: false, error: 'An email address is required.' };
  if (!isValidEmail(email)) return { ok: false, error: '"' + email + '" is not a usable email address.' };

  const exists = rows(await db.execute(sql`SELECT id FROM mail_contacts WHERE lower(email) = ${email} LIMIT 1`))[0];
  if (exists) return { ok: false, id: exists.id, error: 'A contact with that address already exists.' };

  // A suppressed address may be stored, but never as `subscribed` — otherwise the contact book and
  // the suppression list disagree and one of them will be believed by a send path.
  const supp = rows(await db.execute(sql`SELECT reason FROM mail_suppression WHERE email = ${email} LIMIT 1`))[0];
  const status: SubscriptionStatus = supp
    ? (supp.reason === 'complained' ? 'complained' : supp.reason === 'bounced' ? 'bounced' : 'unsubscribed')
    : (input.status || 'subscribed');

  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mail_contacts (email, first_name, last_name, organization, phone, role_title, status, fields, tags, notes,
                                 consent_source, consent_at, consent_ip, consent_note, created_by)
      VALUES (${email}, ${input.first_name || null}, ${input.last_name || null}, ${input.organization || null},
              ${input.phone || null}, ${input.role_title || null}, ${status},
              ${JSON.stringify(input.custom || {})}::jsonb, ${textArray(cleanTags(input.tags))}, ${input.notes || null},
              ${input.consent_source || null}, ${input.consent_at || null}, ${input.consent_ip || null},
              ${input.consent_note || null}, ${actor?.userId || null})
      RETURNING id
    `));
    const id = r[0]?.id as string;
    if (!id) return { ok: false, error: 'The contact was not created. Nothing has been saved.' };
    await logContactEvent({ contactId: id, email, kind: 'created', actor, detail: { status } });
    return { ok: true, id };
  } catch (e: any) {
    console.error('[mail-contacts] createContact:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function updateContact(id: string, input: Partial<ContactInput>, actor?: Actor): Promise<WriteResult> {
  await ensureContactSchema();
  if (!isUuid(id)) return { ok: false, error: 'That contact id is not valid, so nothing was saved.' };
  const before = await getContact(id);
  if (!before) return { ok: false, error: 'That contact no longer exists. Reload the list before editing again.' };

  const email = input.email !== undefined ? normalizeEmailValue(input.email) : before.email;
  if (!isValidEmail(email)) return { ok: false, error: '"' + email + '" is not a usable email address.' };
  if (email !== before.email) {
    const clash = rows(await db.execute(sql`SELECT id FROM mail_contacts WHERE lower(email) = ${email} AND id <> ${id} LIMIT 1`))[0];
    if (clash) return { ok: false, error: 'Another contact already uses ' + email + '. Merge them instead.' };
  }

  try {
    const wrote = rows(await db.execute(sql`
      UPDATE mail_contacts SET
        email = ${email},
        first_name = ${input.first_name !== undefined ? input.first_name : before.first_name},
        last_name = ${input.last_name !== undefined ? input.last_name : before.last_name},
        organization = ${input.organization !== undefined ? input.organization : before.organization},
        phone = ${input.phone !== undefined ? input.phone : before.phone},
        role_title = ${input.role_title !== undefined ? input.role_title : before.role_title},
        status = ${input.status !== undefined ? input.status : before.status},
        fields = ${JSON.stringify(input.custom !== undefined ? input.custom : before.custom)}::jsonb,
        tags = ${textArray(input.tags !== undefined ? cleanTags(input.tags) : before.tags)},
        notes = ${input.notes !== undefined ? input.notes : before.notes},
        consent_source = ${input.consent_source !== undefined ? input.consent_source : before.consent_source},
        consent_at = ${input.consent_at !== undefined ? input.consent_at : before.consent_at},
        consent_note = ${input.consent_note !== undefined ? input.consent_note : before.consent_note},
        updated_at = now()
      WHERE id = ${id}
      RETURNING id
    `));
    if (!wrote.length) return { ok: false, error: 'Nothing was updated: that contact no longer exists.' };

    if (input.tags !== undefined) {
      const added = cleanTags(input.tags).filter((t) => !before.tags.includes(t));
      const removed = before.tags.filter((t) => !cleanTags(input.tags).includes(t));
      if (added.length) await logContactEvent({ contactId: id, kind: 'tagged', actor, detail: { tags: added } });
      if (removed.length) await logContactEvent({ contactId: id, kind: 'untagged', actor, detail: { tags: removed } });
    }

    // A status change to unsubscribed must reach the suppression list, or the next campaign will
    // resolve them straight back in.
    if (input.status && input.status !== before.status) {
      if (input.status === 'unsubscribed') await suppress(email, 'unsubscribed', 'Set by hand on the contact record', null, actor);
      if (input.status === 'subscribed') {
        const res = await unsuppress(email, actor);
        if (!res.ok && res.error && res.error.includes('spam')) {
          await db.execute(sql`UPDATE mail_contacts SET status = 'complained' WHERE id = ${id}`);
          return { ok: false, error: res.error };
        }
      }
      await logContactEvent({ contactId: id, email, kind: input.status === 'unsubscribed' ? 'unsubscribed' : 'resubscribed', actor });
    }
    await logContactEvent({ contactId: id, email, kind: 'updated', actor });
    return { ok: true, id };
  } catch (e: any) {
    console.error('[mail-contacts] updateContact:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Delete contacts.
 *
 * The suppression rows are left standing on purpose — see the header. Delete-then-reimport is the
 * usual way an unsubscribed person gets mailed again, and this is where that is stopped.
 */
export async function deleteContacts(ids: string[], actor?: Actor): Promise<{ deleted: number; error?: string }> {
  await ensureContactSchema();
  const valid = ids.filter(isUuid);
  if (!valid.length) return { deleted: 0, error: 'No valid contact was selected.' };
  try {
    const gone = rows(await db.execute(sql`DELETE FROM mail_contacts WHERE id IN ${uuidIn(valid)} RETURNING id, email`));
    for (const g of gone) await logContactEvent({ email: g.email, kind: 'deleted', actor });
    return { deleted: gone.length };
  } catch (e: any) {
    console.error('[mail-contacts] deleteContacts:', dbReason(e));
    return { deleted: 0, error: dbReason(e) };
  }
}

export async function getContact(id: string): Promise<Contact | null> {
  await ensureContactSchema();
  if (!isUuid(id)) return null;
  const c = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE id = ${id} LIMIT 1`))[0];
  return c ? toContact(c) : null;
}

export async function getContactByEmail(email: string): Promise<Contact | null> {
  await ensureContactSchema();
  const c = rows(await db.execute(sql`SELECT * FROM mail_contacts WHERE lower(email) = ${normalizeEmailValue(email)} LIMIT 1`))[0];
  return c ? toContact(c) : null;
}

// ── tags (a text[] column on the contact row, per the core schema) ──────────────────────────────

export async function setTags(contactId: string, tags: string[], actor?: Actor): Promise<void> {
  await ensureContactSchema();
  if (!isUuid(contactId)) return;
  const before = await getContact(contactId);
  if (!before) return;
  const wanted = cleanTags(tags);
  await db.execute(sql`UPDATE mail_contacts SET tags = ${textArray(wanted)}, updated_at = now() WHERE id = ${contactId}`);
  const added = wanted.filter((t) => !before.tags.includes(t));
  const removed = before.tags.filter((t) => !wanted.includes(t));
  if (added.length) await logContactEvent({ contactId, kind: 'tagged', actor, detail: { tags: added } });
  if (removed.length) await logContactEvent({ contactId, kind: 'untagged', actor, detail: { tags: removed } });
}

export async function addTagToMany(contactIds: string[], tag: string, actor?: Actor): Promise<number> {
  await ensureContactSchema();
  const t = cleanTag(tag);
  const valid = contactIds.filter(isUuid);
  if (!t || !valid.length) return 0;
  // Only rows that do NOT already carry the tag, so the count means "changed" rather than "matched".
  const r = rows(await db.execute(sql`
    UPDATE mail_contacts SET tags = array_append(tags, ${t}), updated_at = now()
    WHERE id IN ${uuidIn(valid)}
      AND NOT EXISTS (SELECT 1 FROM unnest(tags) AS x(tag) WHERE lower(x.tag) = ${t})
    RETURNING id
  `));
  if (r.length) await logContactEvent({ kind: 'tagged', actor, detail: { tag: t, count: r.length } });
  return r.length;
}

export async function removeTagFromMany(contactIds: string[], tag: string, actor?: Actor): Promise<number> {
  await ensureContactSchema();
  const t = cleanTag(tag);
  const valid = contactIds.filter(isUuid);
  if (!t || !valid.length) return 0;
  const r = rows(await db.execute(sql`
    UPDATE mail_contacts SET
      tags = coalesce((SELECT array_agg(x.tag) FROM unnest(tags) AS x(tag) WHERE lower(x.tag) <> ${t}), '{}'::text[]),
      updated_at = now()
    WHERE id IN ${uuidIn(valid)}
      AND EXISTS (SELECT 1 FROM unnest(tags) AS x(tag) WHERE lower(x.tag) = ${t})
    RETURNING id
  `));
  if (r.length) await logContactEvent({ kind: 'untagged', actor, detail: { tag: t, count: r.length } });
  return r.length;
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  await ensureContactSchema();
  return rows(await db.execute(sql`
    SELECT lower(x.tag) AS tag, count(*)::int AS count
    FROM mail_contacts c, unnest(c.tags) AS x(tag)
    GROUP BY lower(x.tag) ORDER BY count DESC, tag ASC LIMIT 200
  `));
}

// ── lists ──────────────────────────────────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'list';
}

export interface MailList {
  id: string; name: string; slug: string; description: string | null;
  kind: 'static' | 'dynamic'; segment_id: string | null; is_archived: boolean;
  created_at: string; updated_at: string;
}

export async function createList(p: { name: string; description?: string; kind?: 'static' | 'dynamic'; segmentId?: string | null }, actor?: Actor): Promise<WriteResult> {
  await ensureContactSchema();
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'A list needs a name.' };
  const kind = p.kind === 'dynamic' ? 'dynamic' : 'static';
  if (kind === 'dynamic' && !isUuid(p.segmentId || '')) return { ok: false, error: 'A dynamic list must point at a saved segment.' };
  let slug = slugify(name);
  for (let n = 2; n < 60; n++) {
    const clash = rows(await db.execute(sql`SELECT 1 FROM mail_lists WHERE lower(slug) = ${slug} LIMIT 1`));
    if (!clash.length) break;
    slug = slugify(name) + '-' + n;
  }
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mail_lists (name, slug, description, kind, segment_id, created_by)
      VALUES (${name}, ${slug}, ${p.description || null}, ${kind}, ${kind === 'dynamic' ? p.segmentId : null}, ${actor?.userId || null})
      RETURNING id
    `));
    return r[0]?.id ? { ok: true, id: r[0].id } : { ok: false, error: 'The list was not created.' };
  } catch (e: any) {
    console.error('[mail-contacts] createList:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function updateList(id: string, p: { name?: string; description?: string | null; segmentId?: string | null; isArchived?: boolean }): Promise<WriteResult> {
  await ensureContactSchema();
  if (!isUuid(id)) return { ok: false, error: 'That list id is not valid.' };
  const before = rows(await db.execute(sql`SELECT * FROM mail_lists WHERE id = ${id} LIMIT 1`))[0];
  if (!before) return { ok: false, error: 'That list no longer exists.' };
  const wrote = rows(await db.execute(sql`
    UPDATE mail_lists SET
      name = ${p.name !== undefined ? String(p.name).trim() : before.name},
      description = ${p.description !== undefined ? p.description : before.description},
      segment_id = ${p.segmentId !== undefined ? (isUuid(p.segmentId || '') ? p.segmentId : null) : before.segment_id},
      kind = ${p.segmentId !== undefined ? (isUuid(p.segmentId || '') ? 'dynamic' : 'static') : (before.kind || 'static')},
      is_archived = ${p.isArchived !== undefined ? !!p.isArchived : before.is_archived},
      updated_at = now()
    WHERE id = ${id} RETURNING id
  `));
  return wrote.length ? { ok: true, id } : { ok: false, error: 'Nothing was updated.' };
}

export async function deleteList(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureContactSchema();
  if (!isUuid(id)) return { ok: false, error: 'That list id is not valid.' };
  const gone = rows(await db.execute(sql`DELETE FROM mail_lists WHERE id = ${id} RETURNING id`));
  return gone.length ? { ok: true } : { ok: false, error: 'That list is already gone.' };
}

export async function listsWithCounts(): Promise<(MailList & { member_count: number })[]> {
  await ensureContactSchema();
  return rows(await db.execute(sql`
    SELECT l.*, coalesce(m.n, 0)::int AS member_count
    FROM mail_lists l
    LEFT JOIN (SELECT list_id, count(*)::int AS n FROM mail_list_members GROUP BY list_id) m ON m.list_id = l.id
    ORDER BY l.is_archived ASC, l.name ASC
  `));
}

export async function getList(id: string): Promise<MailList | null> {
  await ensureContactSchema();
  if (!isUuid(id)) return null;
  return (rows(await db.execute(sql`SELECT * FROM mail_lists WHERE id = ${id} LIMIT 1`))[0] as MailList) || null;
}

export async function addToList(listId: string, contactIds: string[], source = 'manual', actor?: Actor): Promise<number> {
  await ensureContactSchema();
  const valid = contactIds.filter(isUuid);
  if (!isUuid(listId) || !valid.length) return 0;
  const r = rows(await db.execute(sql`
    INSERT INTO mail_list_members (list_id, contact_id, source, added_by)
    SELECT ${listId}, id, ${source}, ${actor?.userId || null} FROM mail_contacts WHERE id IN ${uuidIn(valid)}
    ON CONFLICT DO NOTHING RETURNING contact_id
  `));
  if (r.length) await logContactEvent({ kind: 'listed', actor, detail: { listId, count: r.length } });
  return r.length;
}

export async function removeFromList(listId: string, contactIds: string[], actor?: Actor): Promise<number> {
  await ensureContactSchema();
  const valid = contactIds.filter(isUuid);
  if (!isUuid(listId) || !valid.length) return 0;
  const r = rows(await db.execute(sql`DELETE FROM mail_list_members WHERE list_id = ${listId} AND contact_id IN ${uuidIn(valid)} RETURNING contact_id`));
  if (r.length) await logContactEvent({ kind: 'unlisted', actor, detail: { listId, count: r.length } });
  return r.length;
}

export async function listStats(listId: string): Promise<{ total: number; subscribed: number; unsubscribed: number; bounced: number; complained: number; pending: number }> {
  await ensureContactSchema();
  const r = rows(await db.execute(sql`
    SELECT c.status, count(*)::int AS n
    FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
    WHERE m.list_id = ${listId} GROUP BY c.status
  `));
  const out = { total: 0, subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0, pending: 0 } as any;
  for (const row of r) {
    const n = Number(row.n) || 0;
    out.total += n;
    if (row.status in out) out[row.status] += n;
  }
  return out;
}

// ── segments (stored in `definition`, beside the core schema's `rules`) ────────────────────────

export interface StoredSegment {
  id: string; name: string; slug: string | null; description: string | null;
  definition: SegmentNode; is_archived: boolean; created_at: string; updated_at: string;
}

export async function saveSegment(p: { id?: string | null; name: string; description?: string; definition: SegmentNode }, actor?: Actor): Promise<WriteResult> {
  await ensureContactSchema();
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'A segment needs a name.' };
  const errs = segmentErrors(p.definition);
  if (errs.length) return { ok: false, error: errs.join(' ') };
  const json = JSON.stringify(p.definition);

  if (p.id && isUuid(p.id)) {
    const wrote = rows(await db.execute(sql`
      UPDATE mail_segments SET name = ${name}, description = ${p.description || null}, definition = ${json}::jsonb, updated_at = now()
      WHERE id = ${p.id} RETURNING id
    `));
    return wrote.length ? { ok: true, id: p.id } : { ok: false, error: 'Nothing was updated: that segment no longer exists.' };
  }
  let slug = slugify(name);
  for (let n = 2; n < 60; n++) {
    const clash = rows(await db.execute(sql`SELECT 1 FROM mail_segments WHERE lower(slug) = ${slug} LIMIT 1`));
    if (!clash.length) break;
    slug = slugify(name) + '-' + n;
  }
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mail_segments (name, slug, description, definition, created_by)
      VALUES (${name}, ${slug}, ${p.description || null}, ${json}::jsonb, ${actor?.userId || null}) RETURNING id
    `));
    return r[0]?.id ? { ok: true, id: r[0].id } : { ok: false, error: 'The segment was not created.' };
  } catch (e: any) {
    console.error('[mail-contacts] saveSegment:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function getSegment(id: string): Promise<StoredSegment | null> {
  await ensureContactSchema();
  if (!isUuid(id)) return null;
  const r = rows(await db.execute(sql`SELECT * FROM mail_segments WHERE id = ${id} AND definition IS NOT NULL LIMIT 1`))[0];
  return r ? ({ ...r, definition: r.definition } as StoredSegment) : null;
}

/**
 * Segments this engine can evaluate.
 *
 * `definition IS NOT NULL` is the filter that keeps the two segment languages apart: a segment
 * written through the core screens has `rules` and no `definition`, and offering it here as though
 * this engine understood it would produce an audience nobody asked for.
 */
export async function listSegments(): Promise<StoredSegment[]> {
  await ensureContactSchema();
  return rows(await db.execute(sql`
    SELECT * FROM mail_segments WHERE definition IS NOT NULL ORDER BY is_archived ASC, name ASC
  `)) as StoredSegment[];
}

export async function deleteSegment(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureContactSchema();
  if (!isUuid(id)) return { ok: false, error: 'That segment id is not valid.' };
  const used = rows(await db.execute(sql`SELECT name FROM mail_lists WHERE segment_id = ${id} LIMIT 3`));
  if (used.length) return { ok: false, error: 'This segment powers the dynamic list "' + used[0].name + '". Point that list elsewhere first.' };
  const gone = rows(await db.execute(sql`DELETE FROM mail_segments WHERE id = ${id} RETURNING id`));
  return gone.length ? { ok: true } : { ok: false, error: 'That segment is already gone.' };
}

// ── search, filter and segment evaluation ──────────────────────────────────────────────────────

export interface ContactQuery {
  /** Free text across email, names and organisation. */
  q?: string;
  status?: SubscriptionStatus | 'any';
  tag?: string;
  listId?: string;
  segment?: SegmentNode | null;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'email' | 'last_activity_at';
  direction?: 'asc' | 'desc';
}

function contactFilters(q: ContactQuery) {
  const parts: any[] = [sql`TRUE`];
  const text = String(q.q || '').trim();
  if (text) {
    const like = '%' + text.replace(/([\\%_])/g, '\\$1') + '%';
    parts.push(sql`(c.email ILIKE ${like} ESCAPE '\\'
      OR coalesce(c.first_name,'') ILIKE ${like} ESCAPE '\\'
      OR coalesce(c.last_name,'') ILIKE ${like} ESCAPE '\\'
      OR coalesce(c.organization,'') ILIKE ${like} ESCAPE '\\'
      OR coalesce(c.phone,'') ILIKE ${like} ESCAPE '\\')`);
  }
  if (q.status && q.status !== 'any') parts.push(sql`c.status = ${q.status}`);
  if (q.tag) parts.push(sql`EXISTS (SELECT 1 FROM unnest(c.tags) AS x(tag) WHERE lower(x.tag) = lower(${q.tag}))`);
  if (q.listId && isUuid(q.listId)) parts.push(sql`EXISTS (SELECT 1 FROM mail_list_members m WHERE m.contact_id = c.id AND m.list_id = ${q.listId}::uuid)`);
  if (q.segment) parts.push(segmentSql(q.segment));
  return sql.join(parts, sql` AND `);
}

export interface ContactPage { contacts: Contact[]; total: number }

export async function searchContacts(q: ContactQuery): Promise<ContactPage> {
  await ensureContactSchema();
  const where = contactFilters(q);
  const limit = Math.min(500, Math.max(1, q.limit || 50));
  const offset = Math.max(0, q.offset || 0);
  const orderCol = q.orderBy === 'email' ? sql`c.email` : q.orderBy === 'last_activity_at' ? sql`c.last_activity_at` : sql`c.created_at`;
  const dir = q.direction === 'asc' ? sql`ASC` : sql`DESC`;

  const total = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${where}`))[0]?.n || 0);
  const list = rows(await db.execute(sql`
    SELECT c.* FROM mail_contacts c WHERE ${where}
    ORDER BY ${orderCol} ${dir} NULLS LAST, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `));
  return { total, contacts: list.map(toContact) };
}

/** How many contacts a segment matches, evaluated server-side. */
export async function countSegment(node: SegmentNode): Promise<number> {
  await ensureContactSchema();
  const r = rows(await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${segmentSql(node)}`));
  return Number(r[0]?.n || 0);
}

/** A handful of matching contacts — the "who is in this?" preview beside the count. */
export async function sampleSegment(node: SegmentNode, limit = 10): Promise<Contact[]> {
  await ensureContactSchema();
  const r = rows(await db.execute(sql`
    SELECT c.* FROM mail_contacts c WHERE ${segmentSql(node)} ORDER BY c.created_at DESC LIMIT ${Math.min(50, Math.max(1, limit))}
  `));
  return r.map(toContact);
}

// ── contact history ────────────────────────────────────────────────────────────────────────────

export async function contactHistory(contactId: string, limit = 100): Promise<any[]> {
  await ensureContactSchema();
  if (!isUuid(contactId)) return [];
  return rows(await db.execute(sql`
    SELECT e.*, cp.name AS campaign_name
    FROM mail_contact_events e
    LEFT JOIN mail_campaigns cp ON cp.id = e.campaign_id
    WHERE e.contact_id = ${contactId}
    ORDER BY e.created_at DESC LIMIT ${limit}
  `).catch(async () => db.execute(sql`
    SELECT * FROM mail_contact_events WHERE contact_id = ${contactId} ORDER BY created_at DESC LIMIT ${limit}
  `)));
}

/** Campaigns this contact was a recipient of, with what happened to each. */
export async function contactCampaignHistory(contactId: string, limit = 50): Promise<any[]> {
  await ensureContactSchema();
  if (!isUuid(contactId)) return [];
  try {
    return rows(await db.execute(sql`
      SELECT r.campaign_id, r.status, r.variant, r.sent_at, r.skip_reason, r.error, c.name, c.subject
      FROM mail_campaign_recipients r
      LEFT JOIN mail_campaigns c ON c.id = r.campaign_id
      WHERE r.contact_id = ${contactId}
      ORDER BY r.created_at DESC LIMIT ${limit}
    `));
  } catch (e: any) {
    // The campaign columns Patch 5 adds bootstrap in a different module; a contact page must still
    // render before the first campaign has ever been created here.
    console.error('[mail-contacts] contactCampaignHistory:', dbReason(e));
    return [];
  }
}

/** Internal mail this address has exchanged with the platform (the existing mail engine's tables). */
export async function contactMailHistory(email: string, limit = 20): Promise<any[]> {
  try {
    return rows(await db.execute(sql`
      SELECT m.id, m.subject, m.snippet, m.created_at, m.direction
      FROM mail_messages m
      WHERE lower(m.from_email) = ${normalizeEmailValue(email)}
         OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND lower(r.email) = ${normalizeEmailValue(email)})
      ORDER BY m.created_at DESC LIMIT ${limit}
    `));
  } catch (e: any) {
    console.error('[mail-contacts] contactMailHistory:', dbReason(e));
    return [];
  }
}

// ── merge ──────────────────────────────────────────────────────────────────────────────────────

export interface MergeResult { ok: boolean; error?: string; movedTags?: number; movedLists?: number }

/**
 * Fold `sourceId` into `targetId`.
 *
 * WHAT SURVIVES: the target's own values win; every blank on the target is filled from the source;
 * tags and list memberships are unioned; campaign history and events are re-pointed at the target;
 * the most restrictive subscription status of the two wins. The source row is deleted and its
 * address is recorded in the target's custom fields as `merged_from_email`, so the trail is not
 * lost — and its suppression row, if any, is left alone.
 *
 * The status rule is the one that matters. Merging an unsubscribed record into a subscribed one
 * must not resurrect consent; the refusal to mail travels with the person, not with the row.
 */
export async function mergeContacts(targetId: string, sourceId: string, actor?: Actor): Promise<MergeResult> {
  await ensureContactSchema();
  if (!isUuid(targetId) || !isUuid(sourceId)) return { ok: false, error: 'Those contact ids are not valid.' };
  if (targetId === sourceId) return { ok: false, error: 'A contact cannot be merged into itself.' };
  const target = await getContact(targetId);
  const source = await getContact(sourceId);
  if (!target) return { ok: false, error: 'The contact you are merging into no longer exists.' };
  if (!source) return { ok: false, error: 'The contact you are merging from no longer exists.' };

  const rank: Record<string, number> = { complained: 4, unsubscribed: 3, bounced: 2, pending: 1, subscribed: 0 };
  const status = (rank[source.status] || 0) > (rank[target.status] || 0) ? source.status : target.status;

  const custom = { ...(source.custom || {}), ...(target.custom || {}) };
  custom['merged_from_email'] = source.email;
  const mergedTags = [...new Set([...target.tags, ...source.tags])].slice(0, 40);

  try {
    await db.execute(sql`
      UPDATE mail_contacts SET
        first_name = coalesce(nullif(btrim(coalesce(first_name,'')), ''), ${source.first_name}),
        last_name = coalesce(nullif(btrim(coalesce(last_name,'')), ''), ${source.last_name}),
        organization = coalesce(nullif(btrim(coalesce(organization,'')), ''), ${source.organization}),
        phone = coalesce(nullif(btrim(coalesce(phone,'')), ''), ${source.phone}),
        role_title = coalesce(nullif(btrim(coalesce(role_title,'')), ''), ${source.role_title}),
        consent_source = coalesce(consent_source, ${source.consent_source}),
        consent_at = coalesce(consent_at, ${source.consent_at}),
        notes = coalesce(nullif(btrim(coalesce(notes,'')), ''), ${source.notes}),
        fields = ${JSON.stringify(custom)}::jsonb,
        tags = ${textArray(mergedTags)},
        status = ${status},
        last_activity_at = GREATEST(coalesce(last_activity_at, 'epoch'::timestamptz), coalesce(${source.last_activity_at}::timestamptz, 'epoch'::timestamptz)),
        updated_at = now()
      WHERE id = ${targetId}
    `);
    const movedLists = rows(await db.execute(sql`
      INSERT INTO mail_list_members (list_id, contact_id, source)
      SELECT list_id, ${targetId}, 'merge' FROM mail_list_members WHERE contact_id = ${sourceId}
      ON CONFLICT DO NOTHING RETURNING list_id
    `)).length;
    await db.execute(sql`UPDATE mail_contact_events SET contact_id = ${targetId} WHERE contact_id = ${sourceId}`);
    try {
      await db.execute(sql`UPDATE mail_campaign_recipients SET contact_id = ${targetId} WHERE contact_id = ${sourceId}`);
      await db.execute(sql`UPDATE mail_campaign_events SET contact_id = ${targetId} WHERE contact_id = ${sourceId}`);
    } catch (e: any) {
      console.error('[mail-contacts] merge could not re-point campaign history:', dbReason(e));
    }
    await db.execute(sql`DELETE FROM mail_contacts WHERE id = ${sourceId}`);
    await logContactEvent({ contactId: targetId, email: target.email, kind: 'merged', actor, detail: { from: source.email, status } });
    return { ok: true, movedTags: mergedTags.length - target.tags.length, movedLists };
  } catch (e: any) {
    console.error('[mail-contacts] mergeContacts:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

// ── bulk import ────────────────────────────────────────────────────────────────────────────────

export interface ImportOutcome {
  created: number;
  updated: number;
  skippedSuppressed: number;
  failed: { email: string; reason: string }[];
  listId?: string | null;
}

/**
 * Commit a validated import (the plan comes from mail-csv.planImport, which is pure and has already
 * been shown to the operator).
 *
 * UPDATE, NOT REPLACE. An existing contact keeps every value it has; the import only fills blanks
 * and unions tags. An import file is rarely more current than the record it lands on, and letting a
 * stale export blank out a phone number nobody re-typed is a silent data loss.
 *
 * A SUPPRESSED ADDRESS IS IMPORTED BUT NEVER RE-SUBSCRIBED. It is counted separately so the
 * operator sees exactly how many of their rows will not be mailed and why.
 */
export async function commitImport(
  contacts: ImportContact[],
  opts: { listId?: string | null; consentSource?: string; actor?: Actor } = {},
): Promise<ImportOutcome> {
  await ensureContactSchema();
  const out: ImportOutcome = { created: 0, updated: 0, skippedSuppressed: 0, failed: [], listId: opts.listId || null };
  const actor = opts.actor;
  const suppressedSet = await suppressedAmong(contacts.map((c) => c.email));
  const touchedIds: string[] = [];
  const rank: Record<string, number> = { complained: 4, unsubscribed: 3, bounced: 2, pending: 1, subscribed: 0 };

  for (const c of contacts) {
    try {
      const isSupp = suppressedSet.has(c.email);
      if (isSupp) out.skippedSuppressed++;
      const status: SubscriptionStatus = isSupp ? 'unsubscribed' : c.status;
      const existing = rows(await db.execute(sql`SELECT id, status FROM mail_contacts WHERE lower(email) = ${c.email} LIMIT 1`))[0];

      if (existing) {
        await db.execute(sql`
          UPDATE mail_contacts SET
            first_name = coalesce(nullif(btrim(coalesce(first_name,'')), ''), ${c.first_name || null}),
            last_name = coalesce(nullif(btrim(coalesce(last_name,'')), ''), ${c.last_name || null}),
            organization = coalesce(nullif(btrim(coalesce(organization,'')), ''), ${c.organization || null}),
            phone = coalesce(nullif(btrim(coalesce(phone,'')), ''), ${c.phone || null}),
            role_title = coalesce(nullif(btrim(coalesce(role_title,'')), ''), ${c.role_title || null}),
            consent_source = coalesce(consent_source, ${c.consent_source || opts.consentSource || null}),
            consent_at = coalesce(consent_at, ${c.consent_at}),
            notes = coalesce(nullif(btrim(coalesce(notes,'')), ''), ${c.notes || null}),
            fields = ${JSON.stringify(c.custom)}::jsonb || fields,
            tags = (
              SELECT coalesce(array_agg(DISTINCT t), '{}'::text[])
              FROM unnest(tags || ${textArray(c.tags)}) AS t
            ),
            updated_at = now()
          WHERE id = ${existing.id}
        `);
        // Never upgrade a status on import: unsubscribed stays unsubscribed.
        if ((rank[status] || 0) > (rank[existing.status] || 0)) {
          await db.execute(sql`UPDATE mail_contacts SET status = ${status} WHERE id = ${existing.id}`);
        }
        out.updated++;
        touchedIds.push(existing.id);
      } else {
        const r = rows(await db.execute(sql`
          INSERT INTO mail_contacts (email, first_name, last_name, organization, phone, role_title, status, fields, tags, notes,
                                     consent_source, consent_at, created_by, source)
          VALUES (${c.email}, ${c.first_name || null}, ${c.last_name || null}, ${c.organization || null}, ${c.phone || null},
                  ${c.role_title || null}, ${status}, ${JSON.stringify(c.custom)}::jsonb, ${textArray(c.tags)}, ${c.notes || null},
                  ${c.consent_source || opts.consentSource || null}, ${c.consent_at}, ${actor?.userId || null}, 'csv-import')
          ON CONFLICT DO NOTHING RETURNING id
        `));
        const id = r[0]?.id;
        if (!id) { out.failed.push({ email: c.email, reason: 'Another import wrote this address at the same moment.' }); continue; }
        out.created++;
        touchedIds.push(id);
      }
    } catch (e: any) {
      out.failed.push({ email: c.email, reason: dbReason(e) });
    }
  }

  if (opts.listId && isUuid(opts.listId) && touchedIds.length) {
    for (let i = 0; i < touchedIds.length; i += 500) {
      await addToList(opts.listId, touchedIds.slice(i, i + 500), 'import', actor);
    }
  }
  await logContactEvent({
    kind: 'imported', actor,
    detail: { created: out.created, updated: out.updated, suppressed: out.skippedSuppressed, failed: out.failed.length, listId: opts.listId || null },
  });
  return out;
}

// ── export ─────────────────────────────────────────────────────────────────────────────────────

export const EXPORT_COLUMNS = [
  'email', 'first_name', 'last_name', 'organization', 'phone', 'role_title',
  'status', 'tags', 'consent_source', 'consent_at', 'last_activity_at', 'created_at',
];

/** Rows for a CSV export. `q` is the same filter the screen was showing — export what you can see. */
export async function exportRows(q: ContactQuery, cap = 50000): Promise<Record<string, unknown>[]> {
  await ensureContactSchema();
  const where = contactFilters(q);
  const list = rows(await db.execute(sql`
    SELECT c.*, array_to_string(c.tags, ';') AS tag_text
    FROM mail_contacts c WHERE ${where} ORDER BY c.created_at DESC LIMIT ${cap}
  `));
  return list.map((c: any) => {
    const row: Record<string, unknown> = {};
    for (const col of EXPORT_COLUMNS) row[col] = col === 'tags' ? (c.tag_text || '') : (c[col] ?? '');
    for (const [k, v] of Object.entries(c.fields || {})) row['custom_' + k] = typeof v === 'object' ? JSON.stringify(v) : v;
    return row;
  });
}

/** Every column present across the exported rows, standard ones first. */
export function exportColumns(rowsOut: Record<string, unknown>[]): string[] {
  const extra = new Set<string>();
  for (const r of rowsOut) for (const k of Object.keys(r)) if (!EXPORT_COLUMNS.includes(k)) extra.add(k);
  return [...EXPORT_COLUMNS, ...[...extra].sort()];
}

// ── activity stamp ─────────────────────────────────────────────────────────────────────────────

/** Touch last_activity_at for a set of addresses. Used by the send/open/click paths. */
export async function touchActivity(emails: string[]): Promise<void> {
  const list = [...new Set(emails.map(normalizeEmailValue).filter(Boolean))];
  if (!list.length) return;
  try {
    for (let i = 0; i < list.length; i += 2000) {
      await db.execute(sql`UPDATE mail_contacts SET last_activity_at = now() WHERE lower(email) IN ${textIn(list.slice(i, i + 2000))}`);
    }
  } catch (e: any) {
    console.error('[mail-contacts] touchActivity:', dbReason(e));
  }
}
