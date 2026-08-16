// POST /api/mail/contacts — contact writes: create, update, delete, tag, list, merge, suppress.
//
// One endpoint with a named action, matching /api/mail/action.ts next door. Authorisation runs on
// the FIRST line, before the body is read and before any schema bootstrap — a query that ran for an
// unauthorised principal has already happened whatever the response says.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import {
  createContact, updateContact, deleteContacts, getContact, mergeContacts,
  addTagToMany, removeTagFromMany, addToList, removeFromList,
  suppress, unsuppress, isUuid, dbReason, type Actor,
} from '@/lib/mail-contacts';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

const STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'pending'];

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.contacts' });
  if (denied) return denied;
  const user = (locals as any).user;
  const actor: Actor = { userId: user?.id || null, name: user?.name || user?.email || 'admin' };

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action || '');
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter(isUuid) : (isUuid(body.id) ? [body.id] : []);

  try {
    switch (action) {
      case 'create': {
        const r = await createContact({
          email: String(body.email || ''),
          first_name: body.first_name ?? null,
          last_name: body.last_name ?? null,
          organization: body.organization ?? null,
          phone: body.phone ?? null,
          role_title: body.role_title ?? null,
          status: STATUSES.includes(body.status) ? body.status : 'subscribed',
          custom: typeof body.custom === 'object' && body.custom ? body.custom : {},
          notes: body.notes ?? null,
          consent_source: body.consent_source ?? null,
          consent_at: body.consent_at ?? null,
          consent_note: body.consent_note ?? null,
          tags: Array.isArray(body.tags) ? body.tags : [],
        }, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'update': {
        if (!ids.length) return json({ ok: false, error: 'A contact id is required.' }, 400);
        const patch: any = {};
        for (const k of ['email', 'first_name', 'last_name', 'organization', 'phone', 'role_title', 'notes', 'consent_source', 'consent_at', 'consent_note']) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        if (body.status !== undefined) {
          if (!STATUSES.includes(body.status)) return json({ ok: false, error: 'That subscription status is not one of ours.' }, 400);
          patch.status = body.status;
        }
        if (body.custom !== undefined) patch.custom = typeof body.custom === 'object' && body.custom ? body.custom : {};
        if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags : [];
        const r = await updateContact(ids[0], patch, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'delete': {
        if (!ids.length) return json({ ok: false, error: 'No contact was selected.' }, 400);
        const r = await deleteContacts(ids, actor);
        // Said out loud because it is the surprising half of a delete here, and the half that
        // protects somebody who asked us to stop: the record goes, the refusal to mail does not.
        return json({ ...r, ok: !r.error, note: 'Anyone who had unsubscribed stays on the suppression list, so a re-import cannot mail them again.' }, r.error ? 400 : 200);
      }

      case 'get': {
        if (!ids.length) return json({ ok: false, error: 'A contact id is required.' }, 400);
        const c = await getContact(ids[0]);
        return c ? json({ ok: true, contact: c }) : json({ ok: false, error: 'That contact no longer exists.' }, 404);
      }

      case 'tag':
      case 'untag': {
        if (!ids.length) return json({ ok: false, error: 'No contact was selected.' }, 400);
        const tag = String(body.tag || '').trim();
        if (!tag) return json({ ok: false, error: 'A tag is required.' }, 400);
        const n = action === 'tag' ? await addTagToMany(ids, tag, actor) : await removeTagFromMany(ids, tag, actor);
        return json({ ok: true, changed: n });
      }

      case 'add-to-list':
      case 'remove-from-list': {
        if (!ids.length) return json({ ok: false, error: 'No contact was selected.' }, 400);
        if (!isUuid(body.listId)) return json({ ok: false, error: 'Choose a list.' }, 400);
        const n = action === 'add-to-list'
          ? await addToList(body.listId, ids, 'bulk', actor)
          : await removeFromList(body.listId, ids, actor);
        return json({ ok: true, changed: n });
      }

      case 'merge': {
        if (!isUuid(body.targetId) || !isUuid(body.sourceId)) return json({ ok: false, error: 'Choose which contact to keep and which to fold into it.' }, 400);
        const r = await mergeContacts(body.targetId, body.sourceId, actor);
        return json(r, r.ok ? 200 : 400);
      }

      case 'suppress': {
        const email = String(body.email || '');
        if (!email) return json({ ok: false, error: 'An email address is required.' }, 400);
        await suppress(email, 'manual', String(body.detail || 'Added by hand'), null, actor);
        return json({ ok: true });
      }

      case 'unsuppress': {
        const r = await unsuppress(String(body.email || ''), actor);
        return json(r, r.ok ? 200 : 400);
      }

      default:
        return json({ ok: false, error: 'Unknown action "' + action + '".' }, 400);
    }
  } catch (e: any) {
    console.error('[api/mail/contacts] ' + action + ':', dbReason(e));
    return json({ ok: false, error: 'Nothing was saved: ' + dbReason(e) }, 500);
  }
};
