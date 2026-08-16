// POST /api/v1/billing/webhook?provider=<kind>  — a payment provider tells us something happened.
//
// THE ONLY UNAUTHENTICATED ROUTE IN THIS LAYER, AND THE RULES THAT MAKE THAT SAFE
//
// 1. NOTHING IS TRUSTED UNTIL THE PROVIDER'S ADAPTER HAS VERIFIED THE SIGNATURE. The raw body is
//    read as text and handed to `verifyWebhook()` unparsed — a parsed body cannot be verified,
//    because the signature covers the exact bytes that were sent. An unverified webhook endpoint is
//    an unauthenticated write to the subscription table, which is the most valuable table here.
//
// 2. AN UNKNOWN PROVIDER IS REFUSED, NOT GUESSED. There is no default. Falling back to the manual
//    provider would mean an unsigned request reached a code path that changes plans.
//
// 3. A DUPLICATE IS A 200. Providers retry until they get one, and answering an error to a
//    correctly-delivered repeat causes an escalating retry storm over an event we already applied.
//    `ingestBillingEvent()` decides the duplicate at a unique index, not by reading first.
//
// 4. AN EVENT WE CANNOT APPLY IS STILL STORED, and answered with a 202 rather than a 500: we have
//    the fact, a person needs to look at it, and there is nothing the provider can usefully do by
//    sending it again.
//
// Today no provider adapter is registered (see src/lib/mailplatform/saas/billing.ts), so this route
// answers 501 with the reason. That is the honest state of it — the seam is finished, the vendor
// decision is not, and a route that pretended otherwise would accept unsigned events.
import type { APIRoute } from 'astro';
import { error, ok, preflight } from '@/lib/mailplatform/api';
import { PLANNED_PROVIDERS, resolveBillingProvider } from '@/lib/mailplatform/saas/billing';
import { ingestBillingEvent } from '@/lib/mailplatform/saas/service';

export const prerender = false;
export const OPTIONS: APIRoute = () => preflight();

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const kind = (url.searchParams.get('provider') || '').trim().toLowerCase();
  if (!kind) return error('Name the provider: /api/v1/billing/webhook?provider=<kind>.', 400, 'missing_provider');

  const provider = resolveBillingProvider(kind);
  // `resolveBillingProvider` falls back to manual so a billing PAGE never breaks on an unknown
  // name. Here that fallback would be a security hole, so the fallback is detected and refused.
  if (provider.info().kind !== kind) {
    const planned = PLANNED_PROVIDERS.find((p) => p.kind === kind);
    return error(
      planned
        ? 'The ' + kind + ' billing adapter is not implemented yet, so its webhooks cannot be verified and are not accepted. ' + planned.detail
        : 'No billing provider called "' + kind + '" is registered.',
      501,
      'provider_not_registered',
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return error('The request body could not be read.', 400, 'unreadable_body');
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });

  const verified = await provider.verifyWebhook({ rawBody, headers });
  if (!verified.ok || !verified.data) {
    // 401, not 400: this is a failure of authenticity, and a provider retrying an unsigned request
    // should be told that rather than being told its JSON was malformed.
    console.error('[api/v1/billing/webhook] rejected a ' + kind + ' webhook -', verified.error || verified.code);
    return error(verified.error || 'The webhook signature could not be verified.', 401, verified.code || 'unverified');
  }

  const outcome = await ingestBillingEvent(verified.data);
  if (outcome.duplicate) return ok({ duplicate: true, message: outcome.message });
  if (!outcome.ok) {
    // Stored, not applied. 202: received and recorded, and no amount of retrying will change it.
    return ok({ stored: true, applied: false, message: outcome.message }, 202);
  }
  return ok({ applied: outcome.applied, message: outcome.message });
};
