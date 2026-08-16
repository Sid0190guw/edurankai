// GET /api/v1/platform/status — what the mail platform is actually wired to.
//
// Reports every provider slot's own `info()` verbatim, including the ones that are NOT configured
// and the sentence explaining what is missing. An ops page that only ever shows green because it
// reports "the code is deployed" is worse than no ops page; this one is built so the honest answer
// is the easy one.
//
// Requires authentication: the detail strings name hostnames, bucket endpoints and which secrets
// are unset, which is reconnaissance for anyone who has not signed in.

import type { APIRoute } from 'astro';
import { ok, preflight, requirePrincipal } from '@/lib/mailplatform/api';
import { PROVIDER_SETTINGS, providerStatus } from '@/lib/mailplatform/providers';
import { SCHEMA_VERSION } from '@/lib/mailplatform/schema';

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;

  const slots = providerStatus();
  const queue = await (async () => {
    try {
      const { providers } = await import('@/lib/mailplatform/providers');
      return await providers().queue.health();
    } catch {
      return null;
    }
  })();

  return ok({
    schemaVersion: SCHEMA_VERSION,
    orgId: auth.principal.orgId,
    role: auth.principal.role,
    providers: slots,
    // The env var that swaps each slot, so an operator reading this page knows what to change.
    swapPoints: PROVIDER_SETTINGS,
    queue,
    // Named plainly rather than implied by a green tick.
    unconfigured: slots.filter((s) => !s.enabled).map((s) => ({ slot: s.slot, detail: s.detail })),
  });
};
