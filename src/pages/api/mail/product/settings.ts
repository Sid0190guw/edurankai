// /api/mail/product/settings — domains, API keys and webhooks.
//
// Three resources, one endpoint, because they are one screen group and they share a gate. Split by
// `action`, which is the idiom /api/mail/action.ts already uses in this codebase.
//
//   GET                                        domains + keys + webhooks
//   POST { action: 'domain-add' | 'domain-remove' | 'domain-record'
//                | 'key-create' | 'key-revoke'
//                | 'hook-create' | 'hook-active' | 'hook-delete' | 'hook-test' | 'hook-deliveries' }
//
// THE DNS CHECK IS NOT PERFORMED HERE. /api/mail/dns-check.ts already does it, carefully — it is the
// route that distinguishes "no such record" from "the lookup did not run", which is the distinction
// that stops this screen from talking somebody into breaking their own SPF. The browser calls that
// route and posts the verdict here as 'domain-record'. Two calls instead of one, and no second copy
// of a resolver.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { listDomains, addDomain, removeDomain, recordCheck, setupRecords } from '@/lib/mail-product/domains';
import {
  listApiKeys, createApiKey, revokeApiKey, API_SCOPES,
  listWebhooks, createWebhook, setWebhookActive, deleteWebhook, listDeliveries, deliverWebhook, WEBHOOK_EVENTS,
} from '@/lib/mail-product/keys';
import { json, fail, reasonOf, str } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.settings.read' });
  if (denied) return denied;
  try {
    const [domains, keys, webhooks] = await Promise.all([listDomains(), listApiKeys(), listWebhooks()]);
    return json({ ok: true, domains, keys, webhooks, scopes: API_SCOPES, events: WEBHOOK_EVENTS });
  } catch (e: any) {
    console.error('[api/mail/product/settings] read failed:', reasonOf(e));
    return fail('These settings could not be read just now.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.settings.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);
  const id = str(body.id, 40);

  try {
    switch (action) {
      // ---- Domains ------------------------------------------------------------------------------
      case 'domain-add': {
        const res = await addDomain(str(body.domain, 253), user?.id ?? null);
        return res.id
          ? json({ ok: true, id: res.id, records: setupRecords(str(body.domain, 253)) })
          : fail(res.error || 'That domain was not added.');
      }

      case 'domain-remove': {
        const done = await removeDomain(id);
        return done ? json({ ok: true }) : fail('No domain with that id.', 404);
      }

      case 'domain-record': {
        // The payload came from /api/mail/dns-check via the browser. recordCheck() is what refuses to
        // downgrade a verified record on the strength of a lookup that did not complete.
        const res = await recordCheck(id, body.result || {});
        return res.ok ? json({ ok: true }) : fail(res.error || 'The check result was not stored.');
      }

      // ---- API keys ------------------------------------------------------------------------------
      case 'key-create': {
        const res = await createApiKey({ name: str(body.name, 120), scopes: Array.isArray(body.scopes) ? body.scopes : [], by: user?.id });
        if (!res.id) return fail(res.error || 'The key was not created.');
        // The ONLY time the plaintext exists outside the caller's memory. Said plainly to the UI so
        // it can say it to the person: there is no path that shows this again.
        return json({
          ok: true, id: res.id, key: res.key,
          note: 'Copy this key now. It is stored only as a hash — there is no screen, and no support request, that can show it again.',
        });
      }

      case 'key-revoke': {
        const done = await revokeApiKey(id);
        return done
          ? json({ ok: true, note: 'The key stops working immediately. The row is kept so past calls can still be attributed to it.' })
          : fail('No active key with that id.', 404);
      }

      // ---- Webhooks -------------------------------------------------------------------------------
      case 'hook-create': {
        const res = await createWebhook({ url: str(body.url, 500), events: Array.isArray(body.events) ? body.events : [], by: user?.id });
        if (!res.id) return fail(res.error || 'The webhook was not created.');
        return json({
          ok: true, id: res.id, secret: res.secret,
          note: 'Store this signing secret. Each delivery carries X-EduRankAI-Signature = sha256(secret + "." + timestamp + "." + body) — recompute it to verify the request really came from here.',
        });
      }

      case 'hook-active': {
        const done = await setWebhookActive(id, !!body.active);
        return done ? json({ ok: true }) : fail('No webhook with that id.', 404);
      }

      case 'hook-delete': {
        const done = await deleteWebhook(id);
        return done ? json({ ok: true }) : fail('No webhook with that id.', 404);
      }

      case 'hook-deliveries':
        return json({ ok: true, deliveries: await listDeliveries(id, 25) });

      case 'hook-test': {
        // A REAL request to the real endpoint, recorded like any other delivery. A "test" that only
        // pretended to POST would be testing nothing that matters.
        const res = await deliverWebhook(id, 'sent', {
          test: true,
          message: 'This is a test delivery from EduRankAI Mail.',
          campaign_id: null, email: 'test@example.com',
        });
        return res.ok
          ? json({ ok: true, status: res.status, note: `Your endpoint answered ${res.status}.` })
          : fail(res.error || 'The endpoint did not accept the delivery.', 200);
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/settings] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and nothing has been changed.', 500);
  }
};
