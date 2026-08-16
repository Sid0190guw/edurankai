// /api/mail/product/contacts — the audience API.
//
//   GET  ?q=&status=&listId=&segmentId=&tag=&cursor=&limit=   one keyset page (never "all")
//   POST { action: 'create' | 'update' | 'status' | 'delete' | 'bulk-status' | 'bulk-list' | 'bulk-tag' }
//
// EVERY READ IS BOUNDED. There is no parameter on this endpoint that returns the whole table, and
// the CSV export is a separate route that streams. That is the difference between "prepare for
// millions of contacts" and a sentence in a brief.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyMailApi } from '@/lib/auth/mail-access';
import { textArray } from '@/lib/pg-array';
import {
  listContacts, upsertContact, setContactStatus, deleteContact, getContact,
  contactLists, contactActivity, addToList, removeFromList, countContacts,
} from '@/lib/mail-product/contacts';
import { CONTACT_STATUSES, type ContactStatus, ensureMailProductSchema } from '@/lib/mail-product/schema';
import { json, fail, reasonOf, isUuid, str, clampInt } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.contacts.read' });
  if (denied) return denied;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    // One contact, with the two things its profile screen needs. Three bounded reads, not an N+1.
    if (id) {
      const contact = await getContact(id);
      if (!contact) return fail('No contact with that id.', 404);
      const [lists, activity] = await Promise.all([contactLists(id), contactActivity(id, 40)]);
      return json({ ok: true, contact, lists, activity });
    }

    const page = await listContacts({
      q: str(url.searchParams.get('q'), 120) || undefined,
      status: (url.searchParams.get('status') || 'all') as ContactStatus | 'all',
      listId: url.searchParams.get('listId'),
      segmentId: url.searchParams.get('segmentId'),
      tag: str(url.searchParams.get('tag'), 60) || undefined,
      cursor: url.searchParams.get('cursor'),
      limit: clampInt(url.searchParams.get('limit'), 10, 200, 50),
      // The total is a COUNT over the filter; asked for only on the first page, never per scroll.
      withTotal: !url.searchParams.get('cursor'),
    });
    return json({ ok: true, ...page });
  } catch (e: any) {
    console.error('[api/mail/product/contacts] read failed:', reasonOf(e));
    return fail('Contacts could not be read just now. Nothing has been changed.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.contacts.write' });
  if (denied) return denied;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);

  try {
    await ensureMailProductSchema();

    switch (action) {
      case 'create':
      case 'update': {
        const res = await upsertContact({
          email: body.email,
          firstName: body.firstName, lastName: body.lastName,
          source: body.source || 'manual',
          fields: body.fields,
          tags: Array.isArray(body.tags) ? body.tags : undefined,
        });
        if (!res.id) return fail(res.error || 'The contact was not saved.');
        // Status is deliberately NOT settable through upsert — see the note in contacts.ts about
        // an import silently resubscribing somebody who opted out.
        if (body.status && CONTACT_STATUSES.includes(body.status)) await setContactStatus(res.id, body.status);
        if (Array.isArray(body.listIds)) {
          for (const lid of body.listIds.filter(isUuid).slice(0, 50)) await addToList(lid, [res.id]);
        }
        return json({ ok: true, id: res.id, created: res.created });
      }

      case 'status': {
        if (!CONTACT_STATUSES.includes(body.status)) return fail('That is not a subscription status.');
        const done = await setContactStatus(str(body.id, 40), body.status);
        return done ? json({ ok: true }) : fail('No contact with that id — nothing was changed.', 404);
      }

      case 'delete': {
        const done = await deleteContact(str(body.id, 40));
        return done ? json({ ok: true }) : fail('No contact with that id — nothing was deleted.', 404);
      }

      // ---- Bulk ---------------------------------------------------------------------------------
      // Bulk operations take EXPLICIT IDS, never a filter. "Apply to everything matching this search"
      // is one mis-click away from unsubscribing an entire database, and the confirmation dialog for
      // it would be describing a set nobody can see.
      case 'bulk-status': {
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isUuid).slice(0, 1000);
        if (!ids.length) return fail('Select some contacts first.');
        if (!CONTACT_STATUSES.includes(body.status)) return fail('That is not a subscription status.');
        let n = 0;
        for (const id of ids) if (await setContactStatus(id, body.status)) n++;
        return json({ ok: true, changed: n, asked: ids.length });
      }

      case 'bulk-list': {
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isUuid).slice(0, 5000);
        if (!ids.length) return fail('Select some contacts first.');
        if (!isUuid(body.listId)) return fail('Choose a list.');
        const n = body.remove ? await removeFromList(body.listId, ids) : await addToList(body.listId, ids);
        return json({ ok: true, changed: n, asked: ids.length });
      }

      case 'bulk-tag': {
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isUuid).slice(0, 5000);
        const tag = str(body.tag, 60);
        if (!ids.length) return fail('Select some contacts first.');
        if (!tag) return fail('Name the tag.');
        // One statement for the whole selection. array_remove / DISTINCT unnest keeps tags a set.
        const idSql = sql`(SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x))`;
        const r = await db.execute(body.remove
          ? sql`UPDATE mail_contacts SET tags = array_remove(tags, ${tag}), updated_at = now() WHERE id IN ${idSql} RETURNING id`
          : sql`UPDATE mail_contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(tags || ${textArray([tag])}))), updated_at = now() WHERE id IN ${idSql} RETURNING id`);
        const changed = (Array.isArray(r) ? r : (r as any)?.rows || []).length;
        return json({ ok: true, changed, asked: ids.length });
      }

      case 'count': {
        const n = await countContacts({
          q: str(body.q, 120) || undefined,
          status: body.status, listId: body.listId, segmentId: body.segmentId, tag: body.tag,
        });
        return json({ ok: true, count: n });
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/contacts] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and your contacts are unchanged.', 500);
  }
};
