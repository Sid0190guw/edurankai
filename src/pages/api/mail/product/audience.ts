// /api/mail/product/audience — lists, segments and custom fields.
//
//   GET                              everything the pickers need, in one round trip
//   POST { action: 'list-create' | 'list-update' | 'list-delete'
//                | 'segment-create' | 'segment-update' | 'segment-delete' | 'segment-count'
//                | 'field-create' | 'field-delete' }
//
// segment-count is the one that matters: a segment builder that cannot tell you how many people a
// rule matches, before you attach it to a campaign, is a rule editor rather than a segment builder.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyMailApi } from '@/lib/auth/mail-access';
import { listLists, listSegments, listCustomFields, coerceRules, countContacts, rulesSql } from '@/lib/mail-product/contacts';
import { ensureMailProductSchema } from '@/lib/mail-product/schema';
import { json, fail, reasonOf, rowsOf, isUuid, str, slugify } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.audience.read' });
  if (denied) return denied;
  try {
    const [lists, segments, fields] = await Promise.all([listLists(), listSegments(), listCustomFields()]);
    return json({ ok: true, lists, segments, fields });
  } catch (e: any) {
    console.error('[api/mail/product/audience] read failed:', reasonOf(e));
    return fail('Lists and segments could not be read just now.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.audience.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);

  try {
    await ensureMailProductSchema();

    switch (action) {
      case 'list-create': {
        const name = str(body.name, 160);
        if (!name) return fail('Give the list a name.');
        const slug = slugify(body.slug || name) || 'list';
        const r = await db.execute(sql`
          INSERT INTO mail_lists (name, slug, description, created_by)
          VALUES (${name}, ${slug}, ${str(body.description, 500) || null}, ${isUuid(user?.id) ? user.id : null})
          ON CONFLICT (lower(slug)) DO NOTHING RETURNING id`);
        const id = rowsOf(r)[0]?.id;
        return id ? json({ ok: true, id }) : fail(`A list with the address "${slug}" already exists. Pick a different name.`);
      }

      case 'list-update': {
        if (!isUuid(body.id)) return fail('Unknown list.');
        await db.execute(sql`
          UPDATE mail_lists SET
            name = COALESCE(${body.name !== undefined ? str(body.name, 160) : null}, name),
            description = ${body.description !== undefined ? str(body.description, 500) : sql`description`},
            updated_at = now()
          WHERE id = ${body.id}`);
        return json({ ok: true });
      }

      case 'list-delete': {
        if (!isUuid(body.id)) return fail('Unknown list.');
        // A list a campaign is addressed to is not deletable while that campaign can still send.
        // Deleting it would leave a queued campaign with an audience nobody can reconstruct.
        const inUse = rowsOf(await db.execute(sql`
          SELECT count(*)::int AS n FROM mail_campaigns
          WHERE ${body.id}::uuid = ANY(list_ids) AND status IN ('draft','scheduled','queued','sending','paused')`))[0];
        if (Number(inUse?.n) > 0) {
          return fail(`${inUse.n} campaign(s) are still addressed to this list. Remove it from them first — deleting it now would leave those campaigns pointing at an audience that no longer exists.`);
        }
        const r = await db.execute(sql`DELETE FROM mail_lists WHERE id = ${body.id} RETURNING id`);
        return rowsOf(r).length ? json({ ok: true }) : fail('No list with that id.', 404);
      }

      case 'segment-create': {
        const name = str(body.name, 160);
        if (!name) return fail('Give the segment a name.');
        const rules = coerceRules(body.rules);
        const r = await db.execute(sql`
          INSERT INTO mail_segments (name, description, rules, created_by)
          VALUES (${name}, ${str(body.description, 500) || null}, ${JSON.stringify(rules)}::jsonb, ${isUuid(user?.id) ? user.id : null})
          RETURNING id`);
        return json({ ok: true, id: rowsOf(r)[0]?.id ?? null });
      }

      case 'segment-update': {
        if (!isUuid(body.id)) return fail('Unknown segment.');
        const rules = body.rules !== undefined ? coerceRules(body.rules) : null;
        await db.execute(sql`
          UPDATE mail_segments SET
            name = COALESCE(${body.name !== undefined ? str(body.name, 160) : null}, name),
            description = ${body.description !== undefined ? str(body.description, 500) : sql`description`},
            rules = ${rules ? sql`${JSON.stringify(rules)}::jsonb` : sql`rules`},
            updated_at = now()
          WHERE id = ${body.id}`);
        return json({ ok: true, rules });
      }

      case 'segment-delete': {
        if (!isUuid(body.id)) return fail('Unknown segment.');
        const r = await db.execute(sql`DELETE FROM mail_segments WHERE id = ${body.id} RETURNING id`);
        return rowsOf(r).length ? json({ ok: true }) : fail('No segment with that id.', 404);
      }

      case 'segment-count': {
        // Counts an UNSAVED rule set, so the builder can show the number as the rules are edited.
        const rules = coerceRules(body.rules);
        const compiled = rulesSql(rules);
        // A rule set that compiled to nothing matches EVERYBODY, and saying so is the whole point:
        // an empty segment attached to a campaign is the campaign that goes to the entire database.
        if (!compiled) {
          const all = await countContacts({});
          return json({ ok: true, count: all, unrestricted: true, note: 'No conditions are set, so this segment matches every contact.' });
        }
        const r = await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${compiled}`);
        return json({ ok: true, count: Number(rowsOf(r)[0]?.n ?? 0), unrestricted: false });
      }

      case 'field-create': {
        const label = str(body.label, 80);
        const key = (str(body.key, 60) || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!label || !key) return fail('Give the field a name.');
        const r = await db.execute(sql`
          INSERT INTO mail_contact_fields (key, label, kind)
          VALUES (${key}, ${label}, ${['text', 'number', 'date', 'boolean'].includes(body.kind) ? body.kind : 'text'})
          ON CONFLICT (lower(key)) DO NOTHING RETURNING id`);
        const id = rowsOf(r)[0]?.id;
        return id ? json({ ok: true, id, key }) : fail(`A field called "${key}" already exists.`);
      }

      case 'field-delete': {
        if (!isUuid(body.id)) return fail('Unknown field.');
        // The DECLARATION is removed; the stored values on each contact are left alone. Rewriting
        // every contact's jsonb to drop a key is a destructive migration disguised as a delete.
        const r = await db.execute(sql`DELETE FROM mail_contact_fields WHERE id = ${body.id} RETURNING id`);
        return rowsOf(r).length
          ? json({ ok: true, note: 'The field is no longer offered in forms and the variable picker. Values already stored on contacts are untouched.' })
          : fail('No field with that id.', 404);
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/audience] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and nothing has been changed.', 500);
  }
};
